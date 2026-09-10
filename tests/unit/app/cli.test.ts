import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { launch, listenHttps, loadModule, main, numberOption } from '../../../packages/bridge/src/app/cli.js';
import { definition, fakePeer, settings, source } from './fixtures.js';

/** ローカル検証用TLSを生成する。引数なし、出力envとkey/cert。秘密鍵はGit除外scratchだけに置く。 */
async function credentials() {
  await mkdir('.runtime', { recursive: true });
  const directory = await mkdtemp(path.resolve('.runtime/app-tls-'));
  const keyPath = path.join(directory, 'key.pem'), certPath = path.join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
    '-subj', '/CN=localhost', '-days', '1'], { stdio: 'ignore', timeout: 5000 });
  const configPath = path.join(directory, 'bridge.yaml');
  await writeFile(configPath, source);
  return { env: { BRIDGE_CREDENTIAL: settings.credential, BRIDGE_CONFIG: configPath, BRIDGE_TLS_KEY: keyPath,
    BRIDGE_TLS_CERT: certPath }, key: await readFile(keyPath), cert: await readFile(certPath) };
}

/** HTTPS要求を行う。入力port/path/body、出力status/body。自己署名証明書はこのtestだけで許可する。 */
async function http(port: number, endpoint: string, body?: object) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const client = request({ hostname: '127.0.0.1', port, path: endpoint, rejectUnauthorized: false,
      method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${settings.credential}`, 'content-type': 'application/json' } }, response => {
      let text = ''; response.on('data', data => { text += data; });
      response.on('end', () => resolve({ status: response.statusCode!, body: text }));
    });
    client.on('error', reject); client.end(body && JSON.stringify(body));
  });
}

test('CFG-01 numeric環境値とnativeロード前のfailfastを検証する', async () => {
  assert.equal(numberOption(undefined, 3), 3); assert.equal(numberOption('4', 3), 4);
  for (const value of ['0', '-1', 'NaN', '1.5']) assert.throws(() => numberOption(value, 1), /numeric/);
  assert.ok(await loadModule('node:path'));
  await assert.rejects(launch({}), /missing_environment/);
  await assert.rejects(launch({ BRIDGE_CREDENTIAL: 'x' }), /invalid_credential/);
  const f = await credentials();
  for (const overrides of [{ BRIDGE_PORT: '65536' }, { BRIDGE_HOST: '' }, { BRIDGE_ROS_ARGS: '{}' }, { BRIDGE_ROS_ARGS: '[1]' },
    { BRIDGE_TLS_KEY: '/file-that-does-not-exist' }]) {
    await assert.rejects(launch({ ...f.env, ...overrides }, async () => assert.fail('native must not load')));
  }
});

test('LIFE-01 HTTPSのlisten・handler・close・bind失敗を実socketで検証する', async () => {
  const f = await credentials();
  const server = await listenHttps(f.key, f.cert, '127.0.0.1', 0, async (_request, response) => { response.end('ok'); });
  const port = (server.address as AddressInfo).port;
  assert.equal((await http(port, '/')).body, 'ok');
  await assert.rejects(listenHttps(f.key, f.cert, '127.0.0.1', port, async () => {}), /EADDRINUSE/);
  await server.close(); await assert.rejects(server.close(), /not running/);
});

test('CFG-01 CLI envからnative facadeと実HTTPSを組み立てる', async () => {
  const f = await credentials();
  const probe = await listenHttps(f.key, f.cert, '127.0.0.1', 0, async () => {});
  const port = (probe.address as AddressInfo).port; await probe.close();
  const events: string[] = [];
  let peer: ReturnType<typeof fakePeer>;
  class Context { shutdown() { events.push('shutdown'); } }
  class Node {
    createPublisher(_type: string, topic: string) { return { topic, publish() {} }; }
    createSubscription(_type: string, _topic: string, _options: object, callback: (value: unknown) => void) {
      // callback不正値を流して匿名error hookも検証する。
      callback({ data: 1 });
      return { topic: _topic };
    }
    resolveTopicName(name: string) { return name; }
    spin() { events.push('spin'); }
  }
  const rcl = { Context, Node, QoS: class {}, MessageIntrospector: class { schema = definition; }, async init() {} };
  const loader = async (name: string) => name === 'rclnodejs' ? { default: rcl }
    : { RTCPeerConnection: class { constructor() { peer = fakePeer(); return peer; } } };
  const env = { ...f.env, BRIDGE_PORT: String(port), BRIDGE_SUBSCRIBE_TOPICS: '/out', BRIDGE_PUBLISH_SCOPES: 'command' };
  const app = await launch(env, loader);
  assert.equal((await http(port, '/health')).status, 200);
  assert.equal((await http(port, '/offer', { type: 'offer', sdp: 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' })).status, 200);
  peer!.open(); peer!.channels[0].onMessage.emit('{"v":1,"op":"hello"}');
  assert.equal((peer!.channels[0].sent.at(-1)!.catalog as unknown[]).length, 2);
  await app.close(); assert.deepEqual(events, ['spin', 'shutdown']);
  // 明示node名/host/ROS argsと空の権限リストも起動契約に含める。
  const other = await launch({ ...f.env, BRIDGE_PORT: String(port), BRIDGE_NODE_NAME: 'other', BRIDGE_HOST: '127.0.0.1', BRIDGE_ROS_ARGS: '["--ros-args"]' }, loader);
  await other.close();
});

test('LIFE-01 常駐heartbeatとsignal監視は正常停止・起動失敗の両方で解除する', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  let closed = 0;
  const baseline = process.listenerCount('SIGTERM');
  const stop = await main({}, async () => ({ close: async () => { closed++; } }) as Awaited<ReturnType<typeof launch>>);
  context.mock.timers.tick(5000);
  assert.equal(process.listenerCount('SIGTERM'), baseline + 1);
  await stop(); assert.equal(closed, 1); assert.equal(process.listenerCount('SIGTERM'), baseline);
  await assert.rejects(main({}, async () => { throw new Error('startup'); }), /startup/);
  // default env/launcherの分岐も、nativeへ到達しない必須値欠落で検証する。
  const prior = process.env.BRIDGE_CREDENTIAL; delete process.env.BRIDGE_CREDENTIAL;
  try { await assert.rejects(main(), /missing_environment/); }
  finally { if (prior !== undefined) process.env.BRIDGE_CREDENTIAL = prior; }
});
