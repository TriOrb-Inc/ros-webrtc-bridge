import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { iceOptions, launch, listenHttps, loadModule, main, numberOption } from '../../../packages/bridge/src/app/cli.js';
import { definition, fakePeer, settings, source } from './fixtures.js';

/** Generate TLS for local validation. No arguments; returns environment and key/certificate. Store private keys only in Git-ignored scratch space. */
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

/** Make an HTTPS request. Inputs: port/path/body; output: status/body. Allow self-signed certificates only in this test. */
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

test('CFG-01 validate numeric environment values and fail before loading native bindings', async () => {
  assert.equal(numberOption(undefined, 3), 3); assert.equal(numberOption('4', 3), 4);
  for (const value of ['0', '-1', 'NaN', '1.5']) assert.throws(() => numberOption(value, 1), /numeric/);
  assert.ok(await loadModule('node:path'));
  await assert.rejects(launch({}), /missing_environment/);
  await assert.rejects(launch({ BRIDGE_CREDENTIAL: 'x' }), /invalid_credential/);
  const f = await credentials();
  for (const overrides of [{ BRIDGE_PORT: '65536' }, { BRIDGE_HOST: '' }, { BRIDGE_ROS_ARGS: '{}' }, { BRIDGE_ROS_ARGS: '[1]' },
    { BRIDGE_ICE_STUN_URL: 'stuns:stun.example.test' }, { BRIDGE_TLS_KEY: '/file-that-does-not-exist' }]) {
    await assert.rejects(launch({ ...f.env, ...overrides }, async () => assert.fail('native must not load')));
  }
});

test('CFG-01 validate optional STUN and fixed UDP range settings', () => {
  assert.deepEqual(iceOptions({}), { iceServers: [] });
  for (const url of [
    'stun:stun.example.test',
    'stun:stun.example.test:3478',
    'stun:stun.example.test.',
    'stun:stun.example.test:01',
    'stun:localhost:1',
    'stun:xn--bcher-kva.example:65535',
    'stun:192.0.2.1',
    'stun:192.0.2.1:3478',
    'stun:[2001:db8::1]',
    'stun:[2001:db8::1]:3478',
  ]) assert.deepEqual(iceOptions({ BRIDGE_ICE_STUN_URL: url }), { iceServers: [{ urls: url }] });
  assert.deepEqual(iceOptions({ BRIDGE_ICE_STUN_URL: 'stun:stun.example.test:5349',
    BRIDGE_ICE_PORT_MIN: '50000', BRIDGE_ICE_PORT_MAX: '50019' }), {
    iceServers: [{ urls: 'stun:stun.example.test:5349' }], icePortRange: [50000, 50019],
  });
  assert.deepEqual(iceOptions({ BRIDGE_ICE_PORT_MIN: '50000', BRIDGE_ICE_PORT_MAX: '50019' }), {
    iceServers: [], icePortRange: [50000, 50019],
  });

  // Reject ambiguous or unsafe settings before native modules and sockets are initialized.
  for (const url of [
    '', 'stun:', 'STUN:example.test', 'stuns:example.test', 'https://example.test',
    'stun://example.test', 'stun:user@example.test', 'stun:example.test/path',
    'stun:example.test?transport=udp', 'stun:example.test#fragment', 'stun:example test',
    'stun:.', 'stun:.example.test', 'stun:example..test', 'stun:example.test..', 'stun:-example.test',
    'stun:example-.test', 'stun:example_test', `stun:${'x'.repeat(64)}.test`,
    `stun:${'a'.repeat(250)}.test`, 'stun:999.0.0.1', 'stun:192.0.2',
    'stun:192.0.2.1.5', 'stun:2001:db8::1', 'stun:[2001:db8::zz]',
    'stun:[2001:db8::1', 'stun:2001:db8::1]', 'stun:[2001:db8::1]extra',
    'stun:[2001:db8::1%25eth0]', 'stun:example.test:', 'stun:example.test:0',
    'stun:example.test:+1', 'stun:example.test:0x50',
    'stun:example.test:65536', 'stun:example.test:999999',
    `stun:${'x'.repeat(2044)}`,
  ]) assert.throws(() => iceOptions({ BRIDGE_ICE_STUN_URL: url }), /invalid_ice_stun_url/);
  for (const env of [
    { BRIDGE_ICE_PORT_MIN: '50000' },
    { BRIDGE_ICE_PORT_MAX: '50019' },
    { BRIDGE_ICE_PORT_MIN: '50000', BRIDGE_ICE_PORT_MAX: '50000' },
    { BRIDGE_ICE_PORT_MIN: '50001', BRIDGE_ICE_PORT_MAX: '50000' },
    { BRIDGE_ICE_PORT_MIN: '50000', BRIDGE_ICE_PORT_MAX: '65536' },
  ]) assert.throws(() => iceOptions(env), /invalid_ice/);
});

test('LIFE-01 validate HTTPS listen, handler, close, and bind failures with real sockets', async () => {
  const f = await credentials();
  const server = await listenHttps(f.key, f.cert, '127.0.0.1', 0, async (_request, response) => { response.end('ok'); });
  const port = (server.address as AddressInfo).port;
  assert.equal((await http(port, '/')).body, 'ok');
  await assert.rejects(listenHttps(f.key, f.cert, '127.0.0.1', port, async () => {}), /EADDRINUSE/);
  await server.close(); await assert.rejects(server.close(), /not running/);
});

test('CFG-01 assemble the native facade and real HTTPS from CLI environment variables', async () => {
  const f = await credentials();
  const probe = await listenHttps(f.key, f.cert, '127.0.0.1', 0, async () => {});
  const port = (probe.address as AddressInfo).port; await probe.close();
  const events: string[] = [];
  let peerOptions: object | undefined;
  let peer: ReturnType<typeof fakePeer>;
  class Context { shutdown() { events.push('shutdown'); } }
  class Node {
    createPublisher(_type: string, topic: string) { return { topic, publish() {} }; }
    createSubscription(_type: string, _topic: string, _options: object, callback: (value: unknown) => void) {
      // Pass invalid callback values to exercise the anonymized error hook too.
      callback({ data: 1 });
      return { topic: _topic };
    }
    resolveTopicName(name: string) { return name; }
    spin() { events.push('spin'); }
  }
  const rcl = { Context, Node, QoS: class {}, MessageIntrospector: class { schema = definition; }, async init() {} };
  const loader = async (name: string) => name === 'rclnodejs' ? { default: rcl }
    : { RTCPeerConnection: class { constructor(options: object) { peerOptions = options; peer = fakePeer(); return peer; } } };
  const env = { ...f.env, BRIDGE_PORT: String(port), BRIDGE_SUBSCRIBE_TOPICS: '/out', BRIDGE_PUBLISH_SCOPES: 'command',
    BRIDGE_ICE_STUN_URL: 'stun:stun.example.test:3478', BRIDGE_ICE_PORT_MIN: '50000', BRIDGE_ICE_PORT_MAX: '50019' };
  const app = await launch(env, loader);
  assert.equal((await http(port, '/health')).status, 200);
  assert.equal((await http(port, '/offer', { type: 'offer', sdp: 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' })).status, 200);
  assert.deepEqual(peerOptions, { iceServers: [{ urls: 'stun:stun.example.test:3478' }], icePortRange: [50000, 50019] });
  peer!.open(); peer!.channels[0].onMessage.emit('{"v":1,"op":"hello"}');
  assert.equal((peer!.channels[0].sent.at(-1)!.catalog as unknown[]).length, 2);
  await app.close(); assert.deepEqual(events, ['spin', 'shutdown']);
  // Explicit node names, hosts, ROS arguments, and empty permission lists are part of the startup contract.
  const other = await launch({ ...f.env, BRIDGE_PORT: String(port), BRIDGE_NODE_NAME: 'other', BRIDGE_HOST: '127.0.0.1', BRIDGE_ROS_ARGS: '["--ros-args"]' }, loader);
  await other.close();
});

test('LIFE-01 remove heartbeat and signal monitoring on normal shutdown and startup failure', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  let closed = 0;
  const baseline = process.listenerCount('SIGTERM');
  const stop = await main({}, async () => ({ close: async () => { closed++; } }) as Awaited<ReturnType<typeof launch>>);
  context.mock.timers.tick(5000);
  assert.equal(process.listenerCount('SIGTERM'), baseline + 1);
  await stop(); assert.equal(closed, 1); assert.equal(process.listenerCount('SIGTERM'), baseline);
  await assert.rejects(main({}, async () => { throw new Error('startup'); }), /startup/);
  // Exercise default environment/launcher branches with missing required values before reaching native code.
  const prior = process.env.BRIDGE_CREDENTIAL; delete process.env.BRIDGE_CREDENTIAL;
  try { await assert.rejects(main(), /missing_environment/); }
  finally { if (prior !== undefined) process.env.BRIDGE_CREDENTIAL = prior; }
});
