/** Persistent local Bearer credentials. No operation logs credentials or filesystem paths. */
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Reject unsupported paths before I/O. Example: a nonempty local filename resolves to an absolute path. */
function credentialPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw new Error();
  return path.resolve(value);
}

/** Reject symlink ancestors without following them. Missing directories may be created by ensure only. */
async function checkAncestors(directory) {
  const parent = path.dirname(directory);
  if (parent !== directory) await checkAncestors(parent);
  // Every existing path component must be a directory, even when a later component does not exist yet.
  try {
    const entry = await fs.lstat(directory);
    if (!entry.isDirectory()) throw new Error();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

/** Check the containing directory's ownership and write permissions. Existing 0755 directories remain usable. */
async function checkDirectory(directory) {
  const entry = await fs.lstat(directory);
  if (!entry.isDirectory() || entry.uid !== process.getuid() || (entry.mode & 0o022) !== 0) throw new Error();
}

/** Read a bounded regular file through O_NOFOLLOW. The return value is secret and must not be logged. */
async function readStored(filename) {
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const entry = await file.stat();
    // Size and permissions are checked before reading; no FIFO/device can block waiting for data.
    if (!entry.isFile() || entry.uid !== process.getuid() || (entry.mode & 0o7777) !== 0o600
      || entry.size < 32 || entry.size > 4096) throw new Error();
    const content = await file.readFile('utf8');
    const value = content.replace(/\r?\n$/, '');
    // Keep existing interoperable single-line Bearer values, without silently trimming arbitrary whitespace.
    if (value.length < 32 || value.length > 4096 || !/^[A-Za-z0-9._~+/-]+=*(?![\s\S])/.test(value)) throw new Error();
    return value;
  } finally {
    await file.close();
  }
}

/** Persist the credential entry and every ancestor entry, including directories created by concurrent callers. */
async function syncDirectoryTree(directory) {
  let current = directory;
  while (true) {
    const handle = await fs.open(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    // Closing must happen even when fsync fails; callers may only report success after the whole chain is durable.
    try { await handle.sync(); } finally { await handle.close(); }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** Read and persist a completed store. Input: target path; output: secret, only after directory metadata is synced. */
async function readDurable(filename) {
  const credential = await readStored(filename);
  // Existing files can belong to a concurrent initializer whose directory sync has not finished yet.
  await syncDirectoryTree(path.dirname(filename));
  return credential;
}

/** Read an existing private credential. Input: local path; output: token string, or a fixed safe error. */
export async function readCredential(value) {
  try {
    const filename = credentialPath(value);
    await checkAncestors(path.dirname(filename));
    // The same boundary applies to existing data and newly initialized stores.
    await checkDirectory(path.dirname(filename));
    return await readStored(filename);
  } catch {
    throw new Error('credential_store_unavailable');
  }
}

/** Create once or return the winner of concurrent creation. Input: local path; output: secret string. */
export async function ensureCredential(value) {
  try {
    const filename = credentialPath(value);
    const directory = path.dirname(filename);
    await checkAncestors(directory);
    // Newly created directories are private; existing non-writable-by-others directories are not chmodded.
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await checkDirectory(directory);
    try { return await readDurable(filename); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    // Publish a fully written inode with link's atomic no-replace semantics, never a partially written destination.
    const staging = await fs.mkdtemp(path.join(directory, '.credential-'));
    try {
      const candidate = path.join(staging, 'value');
      const file = await fs.open(candidate, 'wx', 0o600);
      try {
        await file.writeFile(randomBytes(32).toString('hex') + '\n');
        await file.sync();
      } finally { await file.close(); }
      // Another caller may have installed a credential first. Its validated value always wins.
      try { await fs.link(candidate, filename); } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      return await readDurable(filename);
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  } catch {
    throw new Error('credential_store_unavailable');
  }
}

/** Validate or initialize a store without printing secrets. CLI: ensure|read PATH; returns an exit code. */
export async function credentialStoreCli(args, output, errors) {
  try {
    if (args.length !== 2 || !['ensure', 'read'].includes(args[0])) throw new Error();
    const operation = args[0] === 'ensure' ? ensureCredential : readCredential;
    await operation(args[1]);
    // Callers read the protected file themselves; stdout is never a credential transport.
    output.write('Credential store ready.\n');
    return 0;
  } catch {
    errors.write('Credential store unavailable.\n');
    return 1;
  }
}

// Compare canonical paths so colcon --symlink-install also runs the CLI. Importing from node -e stays inert.
const entryPath = process.argv[1] ? await fs.realpath(process.argv[1]).catch(() => undefined) : undefined;
if (entryPath !== undefined && entryPath === await fs.realpath(fileURLToPath(import.meta.url))) {
  process.exitCode = await credentialStoreCli(process.argv.slice(2), process.stdout, process.stderr);
}
