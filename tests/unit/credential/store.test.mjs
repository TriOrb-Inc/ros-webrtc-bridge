import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { ensureCredential, readCredential, credentialStoreCli } from '../../../scripts/credential-store.mjs';

/** Create isolated private test storage. Return its path and register unconditional cleanup. */
async function fixture(t) {
  await fs.mkdir('.runtime', { recursive: true });
  const directory = await fs.mkdtemp(path.resolve('.runtime/credential-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

/** Check only equality as a boolean: assertion failures must never render either secret string. */
function sameSecret(actual, expected) { assert.ok(actual === expected, 'credential identity was not preserved'); }

// Every concurrent caller must observe the complete winning inode, without rotation or leftover candidates.
test('credential store initializes once and preserves concurrent and existing values', async t => {
  const directory = await fixture(t);
  const filename = path.join(directory, 'new', 'credential');
  const values = await Promise.all(Array.from({ length: 16 }, () => ensureCredential(filename)));
  assert.ok(values.every(value => value === values[0] && /^[0-9a-f]{64}$/.test(value)));
  // Permission checks use actual filesystem metadata rather than implementation mocks.
  assert.equal((await fs.stat(path.dirname(filename))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  sameSecret(await readCredential(filename), values[0]);
  sameSecret(await ensureCredential(filename), values[0]);
  // Existing private files under ordinary owner-controlled directories remain compatible.
  await fs.chmod(path.dirname(filename), 0o755);
  sameSecret(await ensureCredential(filename), values[0]);
  assert.deepEqual(await fs.readdir(path.dirname(filename)), ['credential']);
});

// Rejections must never repair invalid data or disclose the input path/content in errors.
test('credential store rejects unsafe paths, permissions, files and malformed values', async t => {
  const directory = await fixture(t);
  const filename = path.join(directory, 'credential');
  const valid = randomBytes(32).toString('hex');
  // Invalid API inputs fail with a stable classification and no incidental diagnostics.
  for (const value of [undefined, null, 1, '', '\0']) {
    await assert.rejects(ensureCredential(value), /^Error: credential_store_unavailable$/);
    await assert.rejects(readCredential(value), /^Error: credential_store_unavailable$/);
  }
  await assert.rejects(readCredential(filename), /credential_store_unavailable/);
  // Existing short, oversized, whitespace and multiline tokens are never rotated.
  for (const content of ['', 'short', 'x'.repeat(4097), valid + '\n\n', valid + ' ', ' '.repeat(32), valid + '\r']) {
    await fs.writeFile(filename, content, { mode: 0o600 });
    await assert.rejects(ensureCredential(filename), /credential_store_unavailable/);
    await assert.rejects(readCredential(filename), /credential_store_unavailable/);
  }
  // One CRLF or LF terminator is accepted; no terminator also remains valid.
  for (const content of [valid, valid + '\n', valid + '\r\n']) {
    await fs.writeFile(filename, content);
    sameSecret(await readCredential(filename), valid);
  }
  // Unsafe file permissions and writable containing directories are rejected without chmod.
  for (const mode of [0o644, 0o4600]) {
    await fs.chmod(filename, mode);
    await assert.rejects(ensureCredential(filename), /credential_store_unavailable/);
  }
  await fs.chmod(filename, 0o600);
  await fs.chmod(directory, 0o777);
  await assert.rejects(ensureCredential(filename), /credential_store_unavailable/);
  await assert.rejects(readCredential(filename), /credential_store_unavailable/);
  await fs.chmod(directory, 0o700);
  // Neither a file symlink nor a directory symlink is a supported store path.
  await fs.symlink(filename, path.join(directory, 'linked'));
  await assert.rejects(ensureCredential(path.join(directory, 'linked')), /credential_store_unavailable/);
  await fs.symlink(directory, path.join(directory, 'linked-directory'));
  await assert.rejects(ensureCredential(path.join(directory, 'linked-directory', 'other')), /credential_store_unavailable/);
  // Nonregular destinations and non-directory ancestors fail without blocking.
  await assert.rejects(ensureCredential(directory), /credential_store_unavailable/);
  await assert.rejects(ensureCredential(path.join(filename, 'other')), /credential_store_unavailable/);
});

// Inject rare storage failures without changing production logic or relying on filesystem exhaustion.
test('credential store rejects wrong ownership and cleans staging after publication failure', async t => {
  const directory = await fixture(t);
  const filename = path.join(directory, 'credential');
  const originalLstat = fs.lstat;
  // A private directory owned by another account is not an authorized store.
  const owner = t.mock.method(fs, 'lstat', async value => {
    const entry = await originalLstat(value);
    if (value === directory) entry.uid = process.getuid() + 1;
    return entry;
  });
  await assert.rejects(ensureCredential(filename), /credential_store_unavailable/);
  owner.mock.restore();
  // A rejected hardlink must leave neither a target nor an abandoned staging directory.
  const publication = t.mock.method(fs, 'link', async () => { throw new Error('storage failure'); });
  await assert.rejects(ensureCredential(filename), /credential_store_unavailable/);
  publication.mock.restore();
  assert.deepEqual(await fs.readdir(directory), []);
  await ensureCredential(filename);
  // File ownership is checked on the opened inode, independent of path metadata.
  const originalOpen = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    const file = await originalOpen(...args);
    const originalStat = file.stat.bind(file);
    file.stat = async () => { const entry = await originalStat(); entry.uid = process.getuid() + 1; return entry; };
    return file;
  });
  await assert.rejects(readCredential(filename), /credential_store_unavailable/);
});

// Both importable CLI and subprocess invocation expose status text only, including failures.
test('credential store CLI never prints credentials or paths', async t => {
  const filename = path.join(await fixture(t), 'credential');
  const output = []; const errors = [];
  const streams = [{ write: value => output.push(value) }, { write: value => errors.push(value) }];
  assert.equal(await credentialStoreCli(['ensure', filename], ...streams), 0);
  assert.equal(await credentialStoreCli(['read', filename], ...streams), 0);
  // Usage and missing-store failures share the same public diagnostic.
  assert.equal(await credentialStoreCli([], ...streams), 1);
  assert.equal(await credentialStoreCli(['invalid', filename], ...streams), 1);
  assert.equal(await credentialStoreCli(['read', filename + '.missing'], ...streams), 1);
  assert.deepEqual(output, ['Credential store ready.\n', 'Credential store ready.\n']);
  assert.ok(errors.every(value => value === 'Credential store unavailable.\n'));
  // A real Node process covers the installed-script entrypoint contract without printing its captured output.
  const executed = await promisify(execFile)(process.execPath, ['scripts/credential-store.mjs', 'read', filename]);
  assert.equal(executed.stdout, 'Credential store ready.\n');
  assert.equal(executed.stderr, '');
});

// A symlinked install entrypoint must execute, while imports with absent/unrelated argv remain inert.
test('credential store CLI recognizes symlink installations without import side effects', async t => {
  const directory = await fixture(t);
  const installed = path.join(directory, 'credential-store.mjs');
  await fs.symlink(path.resolve('scripts/credential-store.mjs'), installed);
  const execute = promisify(execFile);
  // Test Node's normal canonicalization and its optional preservation of the main-module symlink.
  for (const flags of [[], ['--preserve-symlinks-main']]) {
    const filename = path.join(directory, flags.length ? 'preserved-token' : 'token');
    const result = await execute(process.execPath, [...flags, installed, 'ensure', filename]);
    assert.equal(result.stdout, 'Credential store ready.\n');
    assert.equal(result.stderr, '');
    // Validate that the CLI actually initialized a file, rather than returning a silent success.
    assert.ok(/^[0-9a-f]{64}$/.test(await readCredential(filename)));
  }
  // node -e has no entrypoint path; arbitrary trailing arguments need not reference an existing file.
  for (const args of [[], ['unrelated-nonexistent-entry']]) {
    const result = await execute(process.execPath, ['--input-type=module', '-e',
      'await import("./scripts/credential-store.mjs")', ...args]);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});
