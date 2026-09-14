import assert from 'node:assert/strict';
import test from 'node:test';
import { startApp } from '../../../packages/bridge/src/app/runtime.js';
import { canonical, createRegistry, inspectConfig } from '../../../packages/bridge/src/app/registry.js';
import { WebRtcEndpoint } from '../../../packages/bridge/src/transport/endpoint.js';
import { definition, fixture, settings, source } from './fixtures.js';

test('CFG-01 validate configuration before native initialization and pin the canonical schema hash', () => {
  const config = inspectConfig(source, 1048576);
  assert.equal(config.topics.length, 2);
  assert.deepEqual(canonical({ z: [null, { b: 2, a: 1 }], a: true }), { a: true, z: [null, { a: 1, b: 2 }] });
  const first = createRegistry(config, () => definition);
  const reordered = { fields: definition.fields.map(field => ({ type: field.type, name: field.name })) };
  assert.equal(first[0].schemaId, createRegistry(config, () => reordered)[0].schemaId);
  // Reject special YAML syntax, candidate types, and invalid overall schemas before loading.
  for (const invalid of ['{', '!!custom a', 'null', 'topics: []', 'topics: {x: 1}', source.replace('std_msgs/msg/String', 'invalid')]) {
    assert.throws(() => inspectConfig(invalid, 1048576));
  }
  assert.throws(() => inspectConfig(source, 1), /config_too_large/);
  assert.throws(() => createRegistry(config, () => { throw new Error('unavailable_type'); }), /unavailable_type/);
});

test('ACK-01 connect shared ROS and authenticated three-channel peers and verify synchronous publication after leasing', async () => {
  const f = fixture();
  const app = await startApp(settings, f.factories);
  assert.equal(app.config.topics[0].rosTopic, '/resolved/out');
  assert.equal(await f.offer(), 200);
  assert.equal(app.peerCount(), 1);
  assert.equal(await f.offer(), 400);
  const peer = f.peers[0]; peer.open();
  const control = peer.channels[0];
  /** Send a control operation. Inputs: op/id/extra fields; output: last response. */
  const send = (op: string, extra: object = {}) => { control.onMessage.emit(JSON.stringify({ v: 1, op, ...extra })); return control.sent.at(-1)!; };
  const welcome = send('hello');
  assert.equal((welcome.catalog as unknown[]).length, 2);
  const subscription = send('subscribe', { id: 's', topic: '/out' });
  send('ready', { stream_id: subscription.stream_id });
  f.sample({ data: 'ROS sample' });
  assert.equal(peer.channels[1].sent.at(-1)!.op, 'message');
  const advertised = send('advertise', { id: 'p', topic: '/in' });
  const lease = send('arm', { id: 'a', handle: advertised.handle });
  peer.channels[1].onMessage.emit(JSON.stringify({ v: 1, op: 'publish', handle: advertised.handle,
    epoch: advertised.epoch, seq: '0', lease_id: lease.lease_id, data: { data: 'command' } }));
  assert.deepEqual(f.published, [{ data: 'command' }]);
  // Shutdown releases peers, ROS, and HTTP and rejects new offers to the same app.
  const closing = app.close(); assert.equal(app.close(), closing); await closing;
  assert.equal(app.peerCount(), 0); assert.equal(await f.offer(), 400);
  assert.deepEqual(f.events, ['spin', 'ros_close', 'http_close']);
});

test('AUTH-01 default-deny catalog and publication without an allowlist', async () => {
  const f = fixture();
  const app = await startApp({ ...settings, subscribeTopics: [], publishScopes: [] }, f.factories);
  await f.offer(); f.peers[0].open();
  const control = f.peers[0].channels[0];
  control.onMessage.emit('{"v":1,"op":"hello"}');
  assert.deepEqual(control.sent.at(-1)!.catalog, []);
  control.onMessage.emit('{"v":1,"op":"advertise","id":"x","topic":"/in"}');
  assert.equal(control.sent.at(-1)!.op, 'error');
  await app.close();
  // Deny outputs without access configuration regardless of the presence of a string scope.
  const unguarded = source.replace(/    access:.*\n    command_guard:.*\n/, '');
  const g = fixture(); const denied = await startApp({ ...settings, configSource: unguarded }, g.factories);
  await g.offer(); g.peers[0].open(); g.peers[0].channels[0].onMessage.emit('{"v":1,"op":"hello"}');
  assert.equal((g.peers[0].channels[0].sent.at(-1)!.catalog as unknown[]).length, 1);
  await denied.close();
});

test('LIFE-01 release peer slots after fatal router closure initiated by a ROS callback', async () => {
  const f = fixture();
  const app = await startApp(settings, f.factories);
  await f.offer(); f.peers[0].open();
  const control = f.peers[0].channels[0];
  control.onMessage.emit('{"v":1,"op":"hello"}');
  control.onMessage.emit('{"v":1,"op":"subscribe","id":"s","topic":"/out"}');
  const subscription = control.sent.at(-1)!;
  control.onMessage.emit(JSON.stringify({ v: 1, op: 'ready', stream_id: subscription.stream_id }));
  // The router revokes the entire session when neither data nor error notifications can be sent.
  for (const channel of f.peers[0].channels) channel.send = () => { throw new Error('transport_failed'); };
  f.sample({ data: 'new sample' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.peerCount(), 0);
  assert.equal(await f.offer(), 200);
  await app.close();
});

test('LIFE-01 continue context and server cleanup after partial initialization failures', async () => {
  const invalid = fixture();
  await assert.rejects(startApp({ ...settings, credential: '' }, invalid.factories), /credential/);
  await assert.rejects(startApp({ ...settings, credential: 1 as unknown as string }, invalid.factories), /credential/);
  assert.deepEqual(invalid.events, []);
  for (const mode of ['describe', 'spin', 'listen', 'backend_close'] as const) {
    const f = fixture();
    if (mode === 'describe' || mode === 'backend_close') f.backend.describe = () => { throw new Error('describe'); };
    if (mode === 'spin') f.backend.spin = () => { throw new Error('spin'); };
    if (mode === 'listen') Object.assign(f.factories, { listen: async () => { throw new Error('listen'); } });
    if (mode === 'backend_close') f.backend.close = () => { throw new Error('close'); };
    await assert.rejects(startApp(settings, f.factories));
    assert.ok(f.events.includes(mode === 'backend_close' ? 'error' : 'ros_close'));
  }
});

test('LIFE-01 report server/peer cleanup failures and release remaining ROS resources', async context => {
  const f = fixture();
  const original = f.factories.listen;
  Object.assign(f.factories, { listen: async (handler: Parameters<typeof original>[0]) => { await original(handler); return { async close() { throw new Error('http'); } }; } });
  const app = await startApp(settings, f.factories); await f.offer();
  const originalClose = WebRtcEndpoint.prototype.close;
  let closeCalls = 0;
  context.mock.method(WebRtcEndpoint.prototype, 'close', async function (this: WebRtcEndpoint) {
    // Release real resources before returning a failure to verify continued app cleanup.
    await originalClose.call(this);
    if (++closeCalls === 1) throw new Error('peer_cleanup');
  });
  await app.close();
  assert.ok(f.events.includes('ros_close')); assert.equal(f.events.filter(value => value === 'error').length, 2);
  context.mock.restoreAll();
  // Release negotiation timers for endpoints left open by the mock using a fake peer failure notification.
  f.peers[0].connectionStateChange.emit('failed');
});
