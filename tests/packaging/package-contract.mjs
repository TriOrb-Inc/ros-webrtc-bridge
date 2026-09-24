import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';

const PACKAGE_NAME = 'ros_webrtc_bridge';
const root = resolve(process.argv[2] ?? '.');

/**
 * Read a UTF-8 text file.
 * @param {string} relative Path relative to the repository root, e.g. package.xml.
 * @returns {Promise<string>} File contents, e.g. an XML string.
 */
async function text(relative) {
  return readFile(resolve(root, relative), 'utf8');
}

/**
 * Extract simple XML dependency tags.
 * @param {string} xml Complete package.xml contents, e.g. `<exec_depend>nodejs</exec_depend>`.
 * @param {string} tag Tag to extract, e.g. exec_depend.
 * @returns {string[]} Trimmed dependency names, e.g. [`nodejs`].
 */
function tags(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}>([^<]+)</${tag}>`, 'g'))].map(match => match[1].trim());
}

/**
 * List ROS interface package names referenced by bundled configuration.
 * @param {string[]} sources Array of bridge YAML documents.
 * @returns {string[]} Deduplicated package names, e.g. [`std_msgs`].
 */
function interfacePackages(sources) {
  const names = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/^\s*ros_type:\s*([A-Za-z][A-Za-z0-9_]*)\/(?:msg|srv|action)\/[A-Za-z][A-Za-z0-9_]*\s*$/gm)) {
      names.add(match[1]);
    }
  }
  return [...names].sort();
}

/**
 * Check that packages contain no private keys or credential values.
 * @param {Array<[string, string]>} files Pairs of paths and contents.
 * @returns {void} Throws an assertion error on violations.
 */
function assertNoSecrets(files) {
  for (const [path, source] of files) {
    assert.doesNotMatch(source, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, `${path} contains a private key`);
    assert.doesNotMatch(source,
      /(?:^\s*BRIDGE_CREDENTIAL\s*=|["']BRIDGE_CREDENTIAL["']\s*:)[ \t]*["']?[A-Za-z0-9+/=_-]{32,}["']?\s*$/m,
      `${path} contains a credential value`);
  }
}

// Fix the minimal package metadata contract needed for colcon discovery and ament index registration.
const packageXml = await text('package.xml');
assert.match(packageXml, new RegExp(`<name>${PACKAGE_NAME}</name>`));
assert.match(packageXml, /<buildtool_depend>ament_cmake<\/buildtool_depend>/);
assert.match(packageXml, /<build_type>ament_cmake<\/build_type>/);
assert.ok(tags(packageXml, 'build_depend').includes('nodejs'), 'missing build_depend: nodejs');
for (const dependency of ['nodejs', 'launch', 'launch_ros']) {
  assert.ok(tags(packageXml, 'exec_depend').includes(dependency), `missing exec_depend: ${dependency}`);
}

// Do not add runtime exec dependencies for interfaces determined only by configuration. Restrict
// test_depend to interface packages actually used by smoke tests, rather than making every example type a core dependency.
const yamlFiles = ['examples/bridge.yaml', 'examples/bridge-video.yaml', 'examples/connection.yaml'];
const yamlSources = await Promise.all(yamlFiles.map(path => text(path)));
const smokeInterfacePackages = interfacePackages([yamlSources[yamlFiles.indexOf('examples/connection.yaml')]]);
const runtimeDependencies = new Set(tags(packageXml, 'exec_depend'));
const testDependencies = new Set(tags(packageXml, 'test_depend'));
for (const dependency of interfacePackages(yamlSources)) {
  assert.equal(runtimeDependencies.has(dependency), false,
    `${dependency} is config-dependent and must not be a gateway exec_depend`);
}
for (const dependency of smokeInterfacePackages) {
  assert.equal(testDependencies.has(dependency), true,
    `${dependency} is used by packaged smoke fixtures and must be a test_depend`);
}

// Check source entrypoints for ros2 run/launch and distributed configuration; smoke.sh separately checks actual installed artifacts.
const executable = resolve(root, 'scripts/ros_webrtc_bridge');
const launch = resolve(root, 'launch/bridge.launch.py');
await access(executable, constants.R_OK | constants.X_OK);
await access(launch, constants.R_OK);
assert.equal((await stat(executable)).isFile(), true);
assert.equal((await stat(launch)).isFile(), true);

// The reusable store must be shipped at a stable package-share path, independent of a source workspace.
await access(resolve(root, 'scripts/credential-store.mjs'), constants.R_OK);
assert.equal((await stat(resolve(root, 'scripts/credential-store.mjs'))).isFile(), true);
assert.match(await text('CMakeLists.txt'), /install\(FILES scripts\/credential-store\.mjs\s+DESTINATION "share\/\$\{PROJECT_NAME\}\/scripts"/);

// A GStreamer backend is unusable from an installed deployment unless its worker ships with the
// bundle and the launcher names it: registering the backends depends on BRIDGE_VIDEO_WORKER.
await access(resolve(root, 'worker/media_worker.py'), constants.R_OK);
assert.match(await text('CMakeLists.txt'), /install\(FILES worker\/media_worker\.py\s+DESTINATION "\$\{ROS_WEBRTC_BRIDGE_LIB_DIR\}\/worker"/);
assert.match(await text('scripts/ros_webrtc_bridge'), /BRIDGE_VIDEO_WORKER:-\$\{script_dir\}\/worker\/media_worker\.py/);

// Credential fixtures must remain in the trap-cleaned secret tree even when the smoke test fails.
const smoke = await text('tests/packaging/smoke.sh');
assert.match(smoke, /\$\{secret_dir\}\/credential-store\/token/);
assert.doesNotMatch(smoke, /\$\{result_dir\}\/credential-store/);

const inspected = [
  ['package.xml', packageXml],
  ['CMakeLists.txt', await text('CMakeLists.txt')],
  ['scripts/credential-store.mjs', await text('scripts/credential-store.mjs')],
  ['scripts/ros_webrtc_bridge', await text('scripts/ros_webrtc_bridge')],
  ['launch/bridge.launch.py', await text('launch/bridge.launch.py')],
  ...yamlFiles.map((path, index) => [path, yamlSources[index]])
];
assertNoSecrets(inspected);

console.log(`packaging contract: ${PACKAGE_NAME} PASS`);
