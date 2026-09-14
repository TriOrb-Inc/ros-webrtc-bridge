import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';

const PACKAGE_NAME = 'ros_webrtc_bridge';
const root = resolve(process.argv[2] ?? '.');

/**
 * UTF-8 text fileを読みます。
 * @param {string} relative リポジトリrootからの相対pathです。例: package.xml。
 * @returns {Promise<string>} file内容です。例: XML文字列。
 */
async function text(relative) {
  return readFile(resolve(root, relative), 'utf8');
}

/**
 * XMLの単純な依存tagを抽出します。
 * @param {string} xml package.xml全体です。例: `<exec_depend>nodejs</exec_depend>`。
 * @param {string} tag 抽出対象tagです。例: exec_depend。
 * @returns {string[]} trim済みの依存名です。例: [`nodejs`]。
 */
function tags(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}>([^<]+)</${tag}>`, 'g'))].map(match => match[1].trim());
}

/**
 * 同梱設定が参照するROS interface package名を列挙します。
 * @param {string[]} sources bridge YAMLの配列です。
 * @returns {string[]} 重複を除いたpackage名です。例: [`std_msgs`]。
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
 * packageへ秘密鍵やcredential値を同梱していないことを確認します。
 * @param {Array<[string, string]>} files pathと内容の組です。
 * @returns {void} 違反時はassertion errorを投げます。
 */
function assertNoSecrets(files) {
  for (const [path, source] of files) {
    assert.doesNotMatch(source, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, `${path} contains a private key`);
    assert.doesNotMatch(source,
      /(?:^\s*BRIDGE_CREDENTIAL\s*=|["']BRIDGE_CREDENTIAL["']\s*:)[ \t]*["']?[A-Za-z0-9+/=_-]{32,}["']?\s*$/m,
      `${path} contains a credential value`);
  }
}

// package metadataはcolcon discoveryとament index登録に必要な最小契約を固定します。
const packageXml = await text('package.xml');
assert.match(packageXml, new RegExp(`<name>${PACKAGE_NAME}</name>`));
assert.match(packageXml, /<buildtool_depend>ament_cmake<\/buildtool_depend>/);
assert.match(packageXml, /<build_type>ament_cmake<\/build_type>/);
assert.ok(tags(packageXml, 'build_depend').includes('nodejs'), 'missing build_depend: nodejs');
for (const dependency of ['nodejs', 'launch', 'launch_ros']) {
  assert.ok(tags(packageXml, 'exec_depend').includes(dependency), `missing exec_depend: ${dependency}`);
}

// 設定で初めて決まるinterfaceはruntime exec依存にしません。smokeで実際に使うfixtureの
// interface packageだけをtest_dependへ閉じ、配布例の全型を本体依存へ固定しないようにします。
const yamlFiles = ['examples/bridge.yaml', 'examples/connection.yaml'];
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

// ros2 run/launchと配布設定のsource側entrypointを確認し、実install結果はsmoke.shで別途確認します。
const executable = resolve(root, 'scripts/ros_webrtc_bridge');
const launch = resolve(root, 'launch/bridge.launch.py');
await access(executable, constants.R_OK | constants.X_OK);
await access(launch, constants.R_OK);
assert.equal((await stat(executable)).isFile(), true);
assert.equal((await stat(launch)).isFile(), true);

const inspected = [
  ['package.xml', packageXml],
  ['CMakeLists.txt', await text('CMakeLists.txt')],
  ['scripts/ros_webrtc_bridge', await text('scripts/ros_webrtc_bridge')],
  ['launch/bridge.launch.py', await text('launch/bridge.launch.py')],
  ...yamlFiles.map((path, index) => [path, yamlSources[index]])
];
assertNoSecrets(inspected);

console.log(`packaging contract: ${PACKAGE_NAME} PASS`);
