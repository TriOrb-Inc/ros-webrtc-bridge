/** Werift core のローカル入力と依存閉包を検証する共通 utility。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

/**
 * bytes の SHA-256 を返す。
 * @param {Uint8Array|string} bytes 検証対象。例: JS file の Buffer。
 * @returns {string} lower-case hexadecimal hash。例: `abc123...`。
 */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * JSON file を読み込む。
 * @param {string} filename 絶対path。例: `/repo/prepared-manifest.json`。
 * @returns {Promise<object>} parse済みobject。
 */
export async function readJson(filename) {
  return JSON.parse(await readFile(filename, 'utf8'));
}

/**
 * directory配下の通常fileを再帰列挙する。
 * @param {string} root 起点directory。例: `/repo/prepared-core`。
 * @param {string} relative rootからの相対path。再帰用で既定は空文字。
 * @returns {Promise<string[]>} POSIX相対path。例: [`lib/webrtc/src/index.js`]。
 */
async function listFiles(root, relative = '') {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const name = path.posix.join(relative, entry.name);
    // symlinkやdeviceを許すと検証済みrootの外へ出られるため、通常fileとdirectoryだけを扱う。
    if (entry.isDirectory()) files.push(...await listFiles(root, name));
    else {
      assert(entry.isFile(), `Unsupported prepared-core entry: ${name}`);
      files.push(name);
    }
  }
  return files;
}

/**
 * manifest記載fileを読み、path・完全一致・hashを検証する。
 * @param {string} root prepared core directory。例: `/repo/prepared-core`。
 * @param {Record<string,string>} expected 相対pathからSHA-256へのmap。
 * @returns {Promise<Map<string,Buffer>>} 検証済みfile map。
 */
export async function loadVerifiedTree(root, expected) {
  const names = Object.keys(expected).sort();
  assert(names.length > 0, 'Prepared core manifest must contain files');
  for (const name of names) {
    // runtime coreには実行・型解決に必要なcompiler出力だけを許す。
    assert(name.startsWith('lib/') && !name.includes('..') && !path.posix.isAbsolute(name), `Invalid core path: ${name}`);
    assert(name.endsWith('.js') || name.endsWith('.d.ts'), `Unsupported core artifact: ${name}`);
    assert(!/nonstandard|\/extra\//.test(name), `Excluded media artifact: ${name}`);
  }
  assert.deepEqual((await listFiles(root)).sort(), names, 'Prepared core files differ from manifest');

  const files = new Map();
  for (const name of names) {
    const bytes = await readFile(path.join(root, name));
    assert.equal(sha256(bytes), expected[name], `Changed prepared file: ${name}`);
    files.set(name, bytes);
  }
  return files;
}

/**
 * JS/型宣言の静的module参照を抽出する。
 * @param {string} filename 診断用path。例: `lib/webrtc/src/index.js`。
 * @param {string} source JavaScriptまたは型宣言text。
 * @returns {string[]} module specifier。例: [`./peerConnection`, `debug`]。
 */
function imports(filename, source) {
  const names = [];
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);

  /** ASTを巡回し、literalでない動的module指定を拒否する。 */
  function visit(node) {
    let argument;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) argument = node.moduleSpecifier;
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      assert.equal(node.arguments.length, 1, `Unsupported import: ${filename}`);
      argument = node.arguments[0];
    }
    if (ts.isImportTypeNode(node)) argument = node.argument.literal;
    if (argument) {
      assert(ts.isStringLiteral(argument), `Dynamic import: ${filename}`);
      names.push(argument.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(tree);
  return names;
}

/**
 * entryから選択core全体への依存閉包と外部依存を検証する。
 * @param {Map<string,Buffer>} files 検証済みcore file map。
 * @param {string[]} entries closureの入口。例: [`lib/webrtc/src/index.js`]。
 * @param {string[]} expectedExternal 許可する外部module名のsort済み配列。
 * @returns {void} 欠落・余分・外部差分ではassertion errorを投げる。
 */
export function verifyGraph(files, entries, expectedExternal) {
  const visited = new Set();
  const external = new Set();
  const pending = [...entries];
  while (pending.length) {
    const name = pending.pop();
    assert(files.has(name), `Missing entry: ${name}`);
    if (visited.has(name)) continue;
    visited.add(name);

    // 相対参照は選択file内へ、bare specifierは固定した外部依存へ分類する。
    for (const specifier of imports(name, files.get(name).toString())) {
      if (!specifier.startsWith('.')) {
        if (!builtinModules.includes(specifier) && !specifier.startsWith('node:')) external.add(specifier);
        continue;
      }
      const base = path.posix.join(path.posix.dirname(name), specifier);
      const extension = name.endsWith('.d.ts') ? '.d.ts' : '.js';
      const resolved = [base + extension, `${base}/index${extension}`, base].find(candidate => files.has(candidate));
      assert(resolved, `Missing import: ${name} → ${specifier}`);
      pending.push(resolved);
    }
  }
  assert.deepEqual([...external].sort(), expectedExternal);
  assert.deepEqual([...visited].sort(), [...files.keys()].sort(), 'Prepared core contains files outside the entry closure');
}

/**
 * 同梱noticeのhashを検証する。
 * @param {string} directory vendor package root。例: `/repo/vendor/werift-datachannel`。
 * @param {Record<string,string>} notices notice相対pathからSHA-256へのmap。
 * @returns {Promise<void>} 全notice一致時にresolveする。
 */
export async function verifyNotices(directory, notices) {
  for (const [name, expected] of Object.entries(notices)) {
    assert(!name.includes('..') && !path.isAbsolute(name), `Invalid notice path: ${name}`);
    assert.equal(sha256(await readFile(path.join(directory, name))), expected, `Changed notice: ${name}`);
  }
}

/**
 * 検証済みfile mapをstageで完成させてからdestinationへ公開する。
 * @param {Map<string,Buffer>} files 相対pathからbytesへのmap。
 * @param {string} destination 出力directory。例: `/repo/vendor/.../.runtime/lib`。
 * @returns {Promise<void>} 新treeが公開された時点でresolveする。
 */
export async function replaceTree(files, destination) {
  const parent = path.dirname(destination);
  const token = `${process.pid}-${Date.now()}`;
  const stage = path.join(parent, `staging-${token}`);
  const backup = path.join(parent, `previous-${token}`);
  await mkdir(parent, { recursive: true });
  await rm(stage, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });

  try {
    // 部分生成物を公開pathへ置かず、全fileのwrite完了後にdirectoryを切り替える。
    for (const [name, bytes] of files) {
      const target = path.join(stage, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    try { await rename(destination, backup); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await rename(stage, destination);
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    // 切替途中の失敗では直前の完全treeを戻し、次回再実行可能な状態を保つ。
    await rm(stage, { recursive: true, force: true });
    try { await rename(backup, destination); } catch (restoreError) {
      if (restoreError.code !== 'ENOENT') throw restoreError;
    }
    throw error;
  }
}
