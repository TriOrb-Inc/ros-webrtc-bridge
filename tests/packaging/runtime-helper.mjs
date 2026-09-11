import assert from 'node:assert/strict';
import { get } from 'node:https';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * 自己署名TLSのhealth endpointを有限時間pollします。
 * @param {string} url health endpoint URLです。例: https://127.0.0.1:17443/health。
 * @param {number} timeoutMs 全体期限です。例: 20000。
 * @returns {Promise<void>} HTTP 200で完了し、期限超過時は失敗します。
 */
async function waitForHealth(url, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const healthy = await new Promise(resolve => {
      const request = get(url, { rejectUnauthorized: false, timeout: 1000 }, response => {
        response.resume();
        resolve(response.statusCode === 200);
      });
      request.on('error', () => resolve(false));
      request.on('timeout', () => { request.destroy(); resolve(false); });
    });
    if (healthy) return;
    await delay(100);
  }
  throw new Error('packaged gateway health timeout');
}

/**
 * 正常な公開設定から、未導入interfaceを参照するfail-fast fixtureを生成します。
 * @param {string} sourcePath 元のconnection YAMLです。
 * @param {string} destinationPath 一時fixtureの出力pathです。
 * @returns {Promise<void>} 最初のstd_msgs型だけを存在しない型へ置換して完了します。
 */
async function writeMissingInterfaceConfig(sourcePath, destinationPath) {
  const source = await readFile(sourcePath, 'utf8');
  const changed = source.replace('std_msgs/msg/String', 'qa_missing_interfaces/msg/NeverInstalled');
  assert.notEqual(changed, source, 'source config did not contain the expected ROS interface');
  await writeFile(destinationPath, changed, { encoding: 'utf8', mode: 0o600 });
}

const [operation, ...args] = process.argv.slice(2);
if (operation === 'health') {
  const [url, rawTimeout] = args;
  const timeout = Number(rawTimeout);
  assert.ok(url && Number.isSafeInteger(timeout) && timeout > 0, 'health requires URL and positive timeout');
  await waitForHealth(url, timeout);
} else if (operation === 'missing-interface-config') {
  const [source, destination] = args;
  assert.ok(source && destination, 'missing-interface-config requires source and destination');
  await writeMissingInterfaceConfig(source, destination);
} else {
  throw new Error('unknown packaging helper operation');
}
