import assert from 'node:assert/strict';
import test from 'node:test';
import { startApp } from '../../../packages/bridge/src/app/runtime.js';
import { canonical, createRegistry, inspectConfig } from '../../../packages/bridge/src/app/registry.js';
import { WebRtcEndpoint } from '../../../packages/bridge/src/transport/endpoint.js';
import { definition, fixture, settings, source } from './fixtures.js';

test('CFG-01 native init前に設定を検証し、canonical schema hashを固定する', () => {
  const config = inspectConfig(source, 1048576);
  assert.equal(config.topics.length, 2);
  assert.deepEqual(canonical({ z: [null, { b: 2, a: 1 }], a: true }), { a: true, z: [null, { a: 1, b: 2 }] });
  const first = createRegistry(config, () => definition);
  const reordered = { fields: definition.fields.map(field => ({ type: field.type, name: field.name })) };
  assert.equal(first[0].schemaId, createRegistry(config, () => reordered)[0].schemaId);
  // YAML特殊構文、候補型、全体schemaの異常をロード前に拒否する。
  for (const invalid of ['{', '!!custom a', 'null', 'topics: []', 'topics: {x: 1}', source.replace('std_msgs/msg/String', 'invalid')]) {
    assert.throws(() => inspectConfig(invalid, 1048576));
  }
  assert.throws(() => inspectConfig(source, 1), /config_too_large/);
  assert.throws(() => createRegistry(config, () => { throw new Error('unavailable_type'); }), /unavailable_type/);
});

test('ACK-01 shared ROSと認証済み3DCを接続し、lease後の同期publishを確認する', async () => {
  const f = fixture();
  const app = await startApp(settings, f.factories);
  assert.equal(app.config.topics[0].rosTopic, '/resolved/out');
  assert.equal(await f.offer(), 200);
  assert.equal(app.peerCount(), 1);
  assert.equal(await f.offer(), 400);
  const peer = f.peers[0]; peer.open();
  const control = peer.channels[0];
  /** control操作を送る。入力op/id/追加値、出力最後の応答。 */
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
  // shutdownはpeerとROS、HTTPを解放し、同じappへの新offerを拒否する。
  const closing = app.close(); assert.equal(app.close(), closing); await closing;
  assert.equal(app.peerCount(), 0); assert.equal(await f.offer(), 400);
  assert.deepEqual(f.events, ['spin', 'ros_close', 'http_close']);
});

test('AUTH-01 allowlist未指定はcatalogとpublishをdefault denyにする', async () => {
  const f = fixture();
  const app = await startApp({ ...settings, subscribeTopics: [], publishScopes: [] }, f.factories);
  await f.offer(); f.peers[0].open();
  const control = f.peers[0].channels[0];
  control.onMessage.emit('{"v":1,"op":"hello"}');
  assert.deepEqual(control.sent.at(-1)!.catalog, []);
  control.onMessage.emit('{"v":1,"op":"advertise","id":"x","topic":"/in"}');
  assert.equal(control.sent.at(-1)!.op, 'error');
  await app.close();
  // accessそのものが無い出力は、文字列scopeの有無に関係なく拒否する。
  const unguarded = source.replace(/    access:.*\n    command_guard:.*\n/, '');
  const g = fixture(); const denied = await startApp({ ...settings, configSource: unguarded }, g.factories);
  await g.offer(); g.peers[0].open(); g.peers[0].channels[0].onMessage.emit('{"v":1,"op":"hello"}');
  assert.equal((g.peers[0].channels[0].sent.at(-1)!.catalog as unknown[]).length, 1);
  await denied.close();
});

test('LIFE-01 ROS callback起点のrouter致命終了でもpeer枠を解放する', async () => {
  const f = fixture();
  const app = await startApp(settings, f.factories);
  await f.offer(); f.peers[0].open();
  const control = f.peers[0].channels[0];
  control.onMessage.emit('{"v":1,"op":"hello"}');
  control.onMessage.emit('{"v":1,"op":"subscribe","id":"s","topic":"/out"}');
  const subscription = control.sent.at(-1)!;
  control.onMessage.emit(JSON.stringify({ v: 1, op: 'ready', stream_id: subscription.stream_id }));
  // data送信とerror通知の両方が不能になった場合、routerはsession全体を撤回する。
  for (const channel of f.peers[0].channels) channel.send = () => { throw new Error('transport_failed'); };
  f.sample({ data: 'new sample' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.peerCount(), 0);
  assert.equal(await f.offer(), 200);
  await app.close();
});

test('LIFE-01 初期化途中の異常でもcontext・serverのcleanupを継続する', async () => {
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

test('LIFE-01 server・peer cleanupの失敗を通知し残りのROS資源を解放する', async context => {
  const f = fixture();
  const original = f.factories.listen;
  Object.assign(f.factories, { listen: async (handler: Parameters<typeof original>[0]) => { await original(handler); return { async close() { throw new Error('http'); } }; } });
  const app = await startApp(settings, f.factories); await f.offer();
  const originalClose = WebRtcEndpoint.prototype.close;
  let closeCalls = 0;
  context.mock.method(WebRtcEndpoint.prototype, 'close', async function (this: WebRtcEndpoint) {
    // 実資源は解放してから異常結果を返し、app側の継続cleanupを検証する。
    await originalClose.call(this);
    if (++closeCalls === 1) throw new Error('peer_cleanup');
  });
  await app.close();
  assert.ok(f.events.includes('ros_close')); assert.equal(f.events.filter(value => value === 'error').length, 2);
  context.mock.restoreAll();
  // mockで閉じなかったendpointの交渉timerはfake peer失敗通知で解放する。
  f.peers[0].connectionStateChange.emit('failed');
});
