import assert from 'node:assert/strict';
import { get } from 'node:https';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Poll a self-signed TLS health endpoint with a finite deadline.
 * @param {string} url Health endpoint URL, e.g. https://127.0.0.1:17443/health.
 * @param {number} timeoutMs Overall deadline, e.g. 20000.
 * @returns {Promise<void>} Resolves on HTTP 200 and fails on timeout.
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
 * Generate a fail-fast fixture referencing an uninstalled interface from valid public configuration.
 * @param {string} sourcePath Original connection YAML path.
 * @param {string} destinationPath Temporary fixture output path.
 * @returns {Promise<void>} Replaces only the first std_msgs type with a nonexistent type.
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
