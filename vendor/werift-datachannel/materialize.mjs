/** Verify the bundled, selected and patched Werift core and materialize .runtime/lib without network access. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVerifiedTree, readJson, replaceTree, verifyGraph, verifyNotices } from './verify.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const manifest = await readJson(path.join(directory, 'prepared-manifest.json'));
const heartbeat = setInterval(() => console.log('Verifying bundled Werift core...'), 5000);

try {
  // Normal builds use only Git-tracked local inputs, with no URL or cache fallback.
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
  // Require a one-to-one match with upstream files excluding source maps, preventing
  // undeclared code even if both the manifest and file bytes are modified.
  const upstreamNames = Object.keys(upstream.files).filter(name => !name.endsWith('.map')).sort();
  assert.deepEqual(Object.keys(manifest.files).sort(), upstreamNames, 'Prepared file set differs from upstream selection');
  for (const name of upstreamNames) {
    if (!patchedNames.has(name)) assert.equal(manifest.files[name], upstream.files[name], `Prepared file differs from upstream: ${name}`);
  }
  const files = await loadVerifiedTree(path.join(directory, 'prepared-core'), manifest.files);
  verifyGraph(files, manifest.entries, manifest.external);
  await verifyNotices(directory, manifest.notices);
  // Keep `lib/` in the manifest for upstream checks; strip it from the package's runtime root.
  const runtimeFiles = new Map([...files].map(([name, bytes]) => [name.slice('lib/'.length), bytes]));
  await replaceTree(runtimeFiles, path.join(directory, '.runtime', 'lib'));
  console.log(`Prepared ${files.size} bundled files without network access; hashes, dependency graph, and notices verified`);
} finally {
  clearInterval(heartbeat);
}
