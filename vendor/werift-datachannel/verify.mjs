/** Shared utilities for verifying local Werift core inputs and the dependency closure. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

/**
 * Return the SHA-256 digest of the supplied bytes.
 * @param {Uint8Array|string} bytes Input to verify, for example a Buffer containing a JS file.
 * @returns {string} Lowercase hexadecimal digest, for example `abc123...`.
 */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Read a JSON file.
 * @param {string} filename Absolute path, for example `/repo/prepared-manifest.json`.
 * @returns {Promise<object>} Parsed object.
 */
export async function readJson(filename) {
  return JSON.parse(await readFile(filename, 'utf8'));
}

/**
 * Recursively list regular files under a directory.
 * @param {string} root Starting directory, for example `/repo/prepared-core`.
 * @param {string} relative Path relative to root; defaults to an empty string for recursion.
 * @returns {Promise<string[]>} Relative POSIX paths, for example [`lib/webrtc/src/index.js`].
 */
async function listFiles(root, relative = '') {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const name = path.posix.join(relative, entry.name);
    // Allow only regular files and directories; links or devices could escape the verified root.
    if (entry.isDirectory()) files.push(...await listFiles(root, name));
    else {
      assert(entry.isFile(), `Unsupported prepared-core entry: ${name}`);
      files.push(name);
    }
  }
  return files;
}

/**
 * Read manifest files and verify paths, the exact file set, and hashes.
 * @param {string} root Prepared core directory, for example `/repo/prepared-core`.
 * @param {Record<string,string>} expected Map from relative paths to SHA-256 digests.
 * @returns {Promise<Map<string,Buffer>>} Verified file map.
 */
export async function loadVerifiedTree(root, expected) {
  const names = Object.keys(expected).sort();
  assert(names.length > 0, 'Prepared core manifest must contain files');
  for (const name of names) {
    // Allow only compiler outputs needed for execution and type resolution in the runtime core.
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
 * Extract static module references from JS and type declarations.
 * @param {string} filename Diagnostic path, for example `lib/webrtc/src/index.js`.
 * @param {string} source JavaScript or type declaration text.
 * @returns {string[]} Module specifiers, for example [`./peerConnection`, `debug`].
 */
function imports(filename, source) {
  const names = [];
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);

  /** Walk the AST and reject nonliteral dynamic module specifiers. */
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
 * Verify the selected core's dependency closure from its entries and its external dependencies.
 * @param {Map<string,Buffer>} files Verified core file map.
 * @param {string[]} entries Closure entry points, for example [`lib/webrtc/src/index.js`].
 * @param {string[]} expectedExternal Sorted array of allowed external module names.
 * @returns {void} Throw an assertion error for missing, extra, or unexpected external modules.
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

    // Resolve relative references within selected files and bare specifiers against pinned external dependencies.
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
 * Verify the hashes of bundled notices.
 * @param {string} directory Vendor package root, for example `/repo/vendor/werift-datachannel`.
 * @param {Record<string,string>} notices Map from relative notice paths to SHA-256 digests.
 * @returns {Promise<void>} Resolve when all notices match.
 */
export async function verifyNotices(directory, notices) {
  for (const [name, expected] of Object.entries(notices)) {
    assert(!name.includes('..') && !path.isAbsolute(name), `Invalid notice path: ${name}`);
    assert.equal(sha256(await readFile(path.join(directory, name))), expected, `Changed notice: ${name}`);
  }
}

/**
 * Complete the verified file map in a staging directory before publishing it to the destination.
 * @param {Map<string,Buffer>} files Map from relative paths to bytes.
 * @param {string} destination Output directory, for example `/repo/vendor/.../.runtime/lib`.
 * @returns {Promise<void>} Resolve once the new tree is published.
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
    // Switch directories only after all writes complete; never expose partial output at the public path.
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
    // Restore the previous complete tree if switching fails, leaving a state that can be retried.
    await rm(stage, { recursive: true, force: true });
    try { await rename(backup, destination); } catch (restoreError) {
      if (restoreError.code !== 'ENOENT') throw restoreError;
    }
    throw error;
  }
}
