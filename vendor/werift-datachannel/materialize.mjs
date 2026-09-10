/** 固定済み npm artifact から MIT core だけを生成する。引数なし、成功時は .runtime/lib を生成する。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import ts from 'typescript';

// package の相対 main を維持するため生成先だけは vendor 配下とする。
const directory = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(path.join(directory, 'upstream-manifest.json'), 'utf8'));
const heartbeat = setInterval(() => console.log('Preparing integrity-pinned Werift core...'), 5000);
const timeout = Number(process.env.TRANSPORT_PREPARE_TIMEOUT_MS ?? 30000);
assert(Number.isSafeInteger(timeout) && timeout > 0, 'Invalid TRANSPORT_PREPARE_TIMEOUT_MS');

/** tar の通常ファイルをメモリで読む。Buffer を受け、例 package/lib/a.js → bytes の Map を返す。 */
function unpack(bytes) {
  const files = new Map();
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    // npm tar の ustar path と通常ファイルだけを扱い、リンクは生成しない。
    const name = header.subarray(0, 100).toString().split('\0')[0];
    const prefix = header.subarray(345, 500).toString().split('\0')[0];
    const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0/g, '').trim(), 8);
    assert(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= bytes.length, 'Invalid tar size');
    // 固定 tar 全体の integrity 検証後でも重複 path は不正として止める。
    if (header[156] === 0 || header[156] === 48) {
      const key = prefix ? `${prefix}/${name}` : name;
      assert(!files.has(key), `Duplicate tar path: ${key}`);
      files.set(key, bytes.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** AST の import/require を検査する。例 require('debug') → ['debug']、動的指定は拒否する。 */
function imports(filename, source) {
  const names = [];
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  /** 各 AST node の module 指定を集める。引数 node、戻り値なし、例 require(x) は例外。 */
  function visit(node) {
    let argument;
    // module 宣言と呼び出しの両方を扱い、非 literal の依存隠蔽を許可しない。
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) argument = node.moduleSpecifier;
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      assert.equal(node.arguments.length, 1, `Unsupported import: ${filename}`);
      argument = node.arguments[0];
    }
    // 型位置の import('...') も closure の一部として検査する。
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

/** 選択された core の依存閉包を検証する。Map を受け、欠落・余分・外部差分で例外を返す。 */
function verifyGraph(files) {
  const visited = new Set();
  const external = new Set();
  const pending = [...manifest.entries];
  while (pending.length) {
    const name = pending.pop();
    if (visited.has(name)) continue;
    visited.add(name);
    // 各 import を実在する選択ファイルまたは固定された外部依存へ解決する。
    for (const specifier of imports(name, files.get(name).toString())) {
      if (!specifier.startsWith('.')) {
        if (!builtinModules.includes(specifier) && !specifier.startsWith('node:')) external.add(specifier);
        continue;
      }
      // JS と型宣言それぞれで Node の相対解決に対応する。
      const base = path.posix.join(path.posix.dirname(name), specifier);
      const extension = name.endsWith('.d.ts') ? '.d.ts' : '.js';
      const resolved = [base + extension, `${base}/index${extension}`, base].find((candidate) => files.has(candidate));
      assert(resolved, `Missing import: ${name} → ${specifier}`);
      pending.push(resolved);
    }
  }
  // 閉包外のコードを紛れ込ませず、sourcemap だけは従属 artifact として許可する。
  assert.deepEqual([...external].sort(), manifest.external);
  assert.deepEqual([...visited].sort(), [...files.keys()].filter((name) => !name.endsWith('.map')).sort());
}

try {
  console.log('Downloading Werift 0.24.4; verifying SHA-512 before extraction');
  const response = await fetch(manifest.tarball, { signal: AbortSignal.timeout(timeout) });
  assert(response.ok, `Download failed: HTTP ${response.status}`);
  const compressed = Buffer.from(await response.arrayBuffer());
  // 再配布しない media 領域はメモリに留め、選択した MIT ファイルだけを保存する。
  assert.equal(`sha512-${createHash('sha512').update(compressed).digest('base64')}`, manifest.integrity);
  const archive = unpack(gunzipSync(compressed));
  const selected = new Map();
  for (const [name, hash] of Object.entries(manifest.files)) {
    // manifest の path traversal と copyleft media 領域を独立に拒否する。
    assert(name.startsWith('lib/') && !name.includes('..') && !/nonstandard|\/extra\//.test(name));
    const data = archive.get(`package/${name}`);
    assert(data, `Missing archive member: ${name}`);
    assert.equal(createHash('sha256').update(data).digest('hex'), hash, `Changed upstream file: ${name}`);
    selected.set(name, data);
  }
  verifyGraph(selected);
  // 上流の通知が変更・欠落した配布物を生成しない。
  for (const [name, hash] of Object.entries(manifest.notices)) {
    const notice = await readFile(path.join(directory, name));
    assert.equal(createHash('sha256').update(notice).digest('hex'), hash, `Changed notice: ${name}`);
  }
  // DCEP の unordered bit を壊す上流バグだけを、入出力 hash 固定で修正する。
  const patches = JSON.parse(await readFile(path.join(directory, 'patches.json'), 'utf8'));
  for (const patch of patches) {
    let source = selected.get(patch.file).toString();
    assert.equal(createHash('sha256').update(source).digest('hex'), patch.beforeSha256);
    for (const { before, after } of patch.replacements) {
      assert.equal(source.split(before).length, 2, 'Patch must match exactly once');
      source = source.replace(before, after);
    }
    // 修正後も graph が同じであることを下で再検証する。
    assert.equal(createHash('sha256').update(source).digest('hex'), patch.afterSha256);
    selected.set(patch.file, Buffer.from(source));
  }
  verifyGraph(selected);
  // 検証に成功するまでは既存生成物へ触れない。途中失敗は次回再生成で回復できる。
  const stage = path.join(directory, '.runtime', `staging-${process.pid}`);
  await rm(stage, { recursive: true, force: true });
  for (const [name, data] of selected) {
    const target = path.join(stage, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }
  // npm install hook を使わず、明示コマンドでのみ materialize する。
  await rm(path.join(directory, '.runtime/lib'), { recursive: true, force: true });
  await rename(path.join(stage, 'lib'), path.join(directory, '.runtime/lib'));
  await rm(stage, { recursive: true, force: true });
  console.log(`Prepared ${selected.size} files; dependency graph verified`);
} finally {
  clearInterval(heartbeat);
}
