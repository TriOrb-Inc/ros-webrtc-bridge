/** 同梱済みの選択・patch済みWerift coreを検証し、networkを使わず.runtime/libへ生成する。 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVerifiedTree, readJson, replaceTree, verifyGraph, verifyNotices } from './verify.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const manifest = await readJson(path.join(directory, 'prepared-manifest.json'));
const heartbeat = setInterval(() => console.log('Verifying bundled Werift core...'), 5000);

try {
  // 通常buildはURLやcacheへfallbackせず、Git追跡されたlocal inputだけから生成する。
  assert.equal(manifest.format, 1, 'Unsupported prepared core manifest format');
  const upstream = await readJson(path.join(directory, 'upstream-manifest.json'));
  const provenance = ['upstream', 'commit', 'package', 'version', 'entries', 'external', 'notices'];
  for (const key of provenance) assert.deepEqual(manifest[key], upstream[key], `Prepared provenance differs: ${key}`);
  const patches = await readJson(path.join(directory, 'patches.json'));
  const patchOutputs = patches.map(({ file, afterSha256 }) => ({ file, afterSha256 }));
  assert.deepEqual(manifest.patches, patchOutputs, 'Prepared patch metadata differs');
  const patchedNames = new Set();
  for (const { file, beforeSha256, afterSha256 } of patches) {
    assert(!patchedNames.has(file), `Duplicate prepared patch: ${file}`);
    patchedNames.add(file);
    assert.equal(upstream.files[file], beforeSha256, `Prepared patch input differs: ${file}`);
    assert.equal(manifest.files[file], afterSha256, `Prepared patch output differs: ${file}`);
  }
  // source mapを除く上流file集合と1対1に対応させ、manifestとbytesの同時改変でも
  // 未宣言codeを通常buildへ混入できないようにする。
  const upstreamNames = Object.keys(upstream.files).filter(name => !name.endsWith('.map')).sort();
  assert.deepEqual(Object.keys(manifest.files).sort(), upstreamNames, 'Prepared file set differs from upstream selection');
  for (const name of upstreamNames) {
    if (!patchedNames.has(name)) assert.equal(manifest.files[name], upstream.files[name], `Prepared file differs from upstream: ${name}`);
  }
  const files = await loadVerifiedTree(path.join(directory, 'prepared-core'), manifest.files);
  verifyGraph(files, manifest.entries, manifest.external);
  await verifyNotices(directory, manifest.notices);
  // manifestの`lib/`はupstreamとの照合に残し、package mainが期待する出力rootでは除く。
  const runtimeFiles = new Map([...files].map(([name, bytes]) => [name.slice('lib/'.length), bytes]));
  await replaceTree(runtimeFiles, path.join(directory, '.runtime', 'lib'));
  console.log(`Prepared ${files.size} bundled files without network access; hashes, dependency graph, and notices verified`);
} finally {
  clearInterval(heartbeat);
}
