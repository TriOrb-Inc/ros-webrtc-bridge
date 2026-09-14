/** maintainerが固定済みupstream artifactからprepared coreを明示更新する。通常buildからは呼ばない。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { readJson, replaceTree, sha256, verifyGraph, verifyNotices } from './verify.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const upstream = await readJson(path.join(directory, 'upstream-manifest.json'));
const timeout = Number(process.env.TRANSPORT_REFRESH_TIMEOUT_MS ?? 30000);
assert(Number.isSafeInteger(timeout) && timeout > 0, 'Invalid TRANSPORT_REFRESH_TIMEOUT_MS');
const heartbeat = setInterval(() => console.log('Refreshing integrity-pinned Werift core...'), 5000);

/**
 * npm tarの通常fileをメモリへ展開する。
 * @param {Buffer} bytes gunzip済みtar bytes。
 * @returns {Map<string,Buffer>} tar pathから内容へのmap。例: `package/lib/a.js`。
 */
function unpack(bytes) {
  const files = new Map();
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString().split('\0')[0];
    const prefix = header.subarray(345, 500).toString().split('\0')[0];
    const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0/g, '').trim(), 8);
    assert(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= bytes.length, 'Invalid tar size');
    // linkは保存せず、重複pathも拒否して抽出先の曖昧性をなくす。
    if (header[156] === 0 || header[156] === 48) {
      const key = prefix ? `${prefix}/${name}` : name;
      assert(!files.has(key), `Duplicate tar path: ${key}`);
      files.set(key, bytes.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

try {
  // network利用はこのmaintainer専用commandへ隔離し、通常prepareから到達させない。
  console.log('Downloading pinned Werift artifact for explicit maintainer refresh');
  const response = await fetch(upstream.tarball, { signal: AbortSignal.timeout(timeout) });
  assert(response.ok, `Download failed: HTTP ${response.status}`);
  const compressed = Buffer.from(await response.arrayBuffer());
  assert.equal(`sha512-${createHash('sha512').update(compressed).digest('base64')}`, upstream.integrity);
  const archive = unpack(gunzipSync(compressed));

  const selected = new Map();
  for (const [name, hash] of Object.entries(upstream.files)) {
    assert(name.startsWith('lib/') && !name.includes('..') && !/nonstandard|\/extra\//.test(name));
    const bytes = archive.get(`package/${name}`);
    assert(bytes, `Missing archive member: ${name}`);
    assert.equal(sha256(bytes), hash, `Changed upstream file: ${name}`);
    // source mapはruntimeに不要で元TypeScriptも含むため、local inputへ再配布しない。
    if (!name.endsWith('.map')) selected.set(name, bytes);
  }
  await verifyNotices(directory, upstream.notices);

  // DCEP修正はbefore/after hashと一意置換を固定し、黙ったpatchずれを許可しない。
  const patches = await readJson(path.join(directory, 'patches.json'));
  for (const patch of patches) {
    let source = selected.get(patch.file).toString();
    assert.equal(sha256(source), patch.beforeSha256);
    for (const { before, after } of patch.replacements) {
      assert.equal(source.split(before).length, 2, 'Patch must match exactly once');
      source = source.replace(before, after);
    }
    assert.equal(sha256(source), patch.afterSha256);
    selected.set(patch.file, Buffer.from(source));
  }
  verifyGraph(selected, upstream.entries, upstream.external);

  // manifestはpatch後bytesを記録し、次の通常buildがupstream接続なしで全fileを再検証できるようにする。
  const files = Object.fromEntries([...selected].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, bytes]) => [name, sha256(bytes)]));
  const prepared = {
    format: 1,
    upstream: upstream.upstream,
    commit: upstream.commit,
    package: upstream.package,
    version: upstream.version,
    entries: upstream.entries,
    external: upstream.external,
    notices: upstream.notices,
    patches: patches.map(({ file, afterSha256 }) => ({ file, afterSha256 })),
    files
  };
  await replaceTree(selected, path.join(directory, 'prepared-core'));
  await writeFile(path.join(directory, 'prepared-manifest.json'), `${JSON.stringify(prepared, null, 2)}\n`);
  console.log(`Refreshed ${selected.size} selected files; review and commit prepared-core plus prepared-manifest.json`);
} finally {
  clearInterval(heartbeat);
}
