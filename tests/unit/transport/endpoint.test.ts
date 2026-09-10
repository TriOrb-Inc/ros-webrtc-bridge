import assert from 'node:assert/strict';
import test from 'node:test';
import { WebRtcEndpoint } from '../../../packages/bridge/src/transport/endpoint.js';
import type { DataChannel, EndpointOptions, Peer, Signal } from '../../../packages/bridge/src/transport/types.js';
import type { Channel } from '../../../packages/bridge/src/router/types.js';

/** event境界をfake化する。入力型T、出力subscribe/emit。例: emit('open') → 登録callback実行。 */
function signal<T extends unknown[]>(): Signal<T> & { emit(...args: T): void } {
  const callbacks = new Set<(...args: T) => void>();
  return { subscribe(callback) { callbacks.add(callback); return { unSubscribe() { callbacks.delete(callback); } }; },
    emit(...args: T) { for (const callback of callbacks) callback(...args); } };
}

/** channelを構築する。入力labelと上書き、出力fake。例: realtime → unordered/maxRetransmits0。 */
function channel(label: string, override: Partial<Omit<DataChannel, 'onMessage' | 'stateChanged' | 'bufferedAmountLow'>> = {}) {
  const sent: Buffer[] = [];
  const real = label === 'ros.realtime.v1';
  return { label, ordered: !real, negotiated: false, maxRetransmits: real ? 0 : null, maxPacketLifeTime: null,
    readyState: 'open', bufferedAmount: 0, bufferedAmountLowThreshold: 0,
    onMessage: signal<[string | Buffer]>(), stateChanged: signal<[string]>(), bufferedAmountLow: signal<unknown[]>(),
    send(value: Buffer) { sent.push(value); }, sent, ...override };
}

/** peerとrouterの副作用を観測する。入力option上書き、出力fixture。例: answer → remote設定1回。 */
function fixture(override: Partial<EndpointOptions> = {}) {
  const onDataChannel = signal<[DataChannel]>();
  const connectionStateChange = signal<[string]>();
  const received: [string, Uint8Array][] = [];
  let flushed = 0, closed = 0, errors = 0, maximum = 0;
  const peer: Peer = { onDataChannel, connectionStateChange, localDescription: { type: 'answer', sdp: 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' },
    async setRemoteDescription() {}, async createAnswer() { return this.localDescription!; }, async setLocalDescription() {}, async close() {} };
  let send!: (channel: Channel, bytes: Uint8Array) => boolean;
  let onClosed!: () => void;
  const router = { isClosed: false, receive(label: string, bytes: Uint8Array) { received.push([label, bytes]); }, flush() { flushed++; }, close() { closed++; } };
  // factoryから渡される合意上限とsend callbackも観測対象にする。
  const options: EndpointOptions = { peer, maxMessageBytes: 128, maxBufferedBytes: 256, maxSdpBytes: 512, timeoutMs: 1000,
    makeRouter(callback, limit, notify) { send = callback; maximum = limit; onClosed = notify; return router; }, onClosed() {}, onError() { errors++; }, ...override };
  const endpoint = new WebRtcEndpoint(options);
  return { endpoint, peer, router, onDataChannel, connectionStateChange, received, send: (label: Channel, bytes: Uint8Array) => send(label, bytes),
    state: () => ({ flushed, closed, errors, maximum }), notify: () => onClosed() };
}

const sdp = 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';
const offer = { type: 'offer' as const, sdp };

test('PRO-01/SIZE-01 3channelと合意上限を検証し双方向にbytesを渡す', async () => {
  const f = fixture();
  assert.deepEqual(await f.endpoint.answer({ ...offer, sdp: `${sdp}a=max-message-size:64\r\n` }), f.peer.localDescription);
  assert.equal(f.state().maximum, 64);
  assert.equal(f.send('ros.control.v1', Buffer.from('x')), false);
  // 3channel openを待ち、それぞれの低水位/受信通知をrouterへ渡す。
  const control = channel('ros.control.v1', { readyState: 'connecting' });
  const reliable = channel('ros.reliable.v1');
  const realtime = channel('ros.realtime.v1');
  for (const dc of [control, reliable, realtime]) f.onDataChannel.emit(dc);
  assert.equal(f.send('ros.control.v1', Buffer.from('x')), false);
  control.readyState = 'open';
  control.stateChanged.emit('open');
  assert.equal(f.state().flushed, 1);
  assert.equal(control.bufferedAmountLowThreshold, 128);
  control.bufferedAmountLow.emit();
  control.onMessage.emit('{}');
  reliable.onMessage.emit(Buffer.from('{}'));
  assert.equal(f.received.length, 2);
  // buffer上限一致を許可し、1byte超過とmessage上限超過を別々に扱う。
  control.bufferedAmount = 255;
  assert.equal(f.send('ros.control.v1', Buffer.from('x')), true);
  assert.equal(f.send('ros.control.v1', Buffer.from('xx')), false);
  assert.throws(() => f.send('ros.control.v1', Buffer.alloc(65)), /message_size/);
  assert.equal(control.sent.length, 1);
  await f.endpoint.close();
  assert.equal(f.send('ros.control.v1', Buffer.from('x')), false);
  assert.equal(f.state().closed, 1);
  await f.endpoint.close();
});

test('PRO-01 不正channel設定、重複、早着、過大messageでpeerを閉じる', async () => {
  for (const dc of [channel('extra'), channel('ros.control.v1', { negotiated: true }), channel('ros.control.v1', { ordered: false }),
    channel('ros.control.v1', { maxPacketLifeTime: 1 }), channel('ros.realtime.v1', { maxRetransmits: 1 })]) {
    const f = fixture();
    await f.endpoint.answer(offer);
    f.onDataChannel.emit(dc);
    await f.endpoint.close();
    assert.equal(f.state().closed, 1);
  }
  // 重複labelと全channel到着前messageをそれぞれ拒否する。
  for (const mode of ['duplicate', 'early', 'large']) {
    const f = fixture();
    await f.endpoint.answer(offer);
    const dc = channel('ros.control.v1');
    f.onDataChannel.emit(dc);
    if (mode === 'duplicate') f.onDataChannel.emit(channel(dc.label));
    else if (mode === 'early') dc.onMessage.emit('{}');
    else {
      f.onDataChannel.emit(channel('ros.reliable.v1'));
      f.onDataChannel.emit(channel('ros.realtime.v1'));
      dc.onMessage.emit(Buffer.alloc(129));
    }
    await f.endpoint.close();
    assert.equal(f.received.length, 0);
  }
});

test('PRO-01 SDPの型、容量、media、合意上限、answerを検証する', async () => {
  for (const value of [{ type: 'answer', sdp }, { type: 'offer', sdp: 5 }, { type: 'offer', sdp: 'x'.repeat(513) },
    { type: 'offer', sdp: '' }, { type: 'offer', sdp: `${sdp}m=audio 9` }, { type: 'offer', sdp: 'm=video 9' },
    { type: 'offer', sdp: `${sdp}a=max-message-size:1\r\na=max-message-size:2\r\n` },
    { type: 'offer', sdp: `${sdp}a=max-message-size:999999999999999999999999\r\n` }]) {
    const f = fixture();
    await assert.rejects(f.endpoint.answer(value as typeof offer));
  }
  for (const local of [null, { type: 'answer', sdp: 'x'.repeat(513) }]) {
    const f = fixture();
    Object.assign(f.peer, { localDescription: local });
    await assert.rejects(f.endpoint.answer(offer), /invalid_answer/);
  }
  // 0は無制限の広告でもアプリ上限128は保つ。
  const f = fixture();
  await f.endpoint.answer({ ...offer, sdp: `${sdp}a=max-message-size:0\r\n` });
  assert.equal(f.state().maximum, 128);
  await assert.rejects(f.endpoint.answer(offer), /unavailable/);
  await f.endpoint.close();
});

test('LIFE-01 接続失敗、channel閉鎖、期限でrouterを撤回する', async () => {
  const f = fixture();
  await f.endpoint.answer(offer);
  f.connectionStateChange.emit('connected');
  f.connectionStateChange.emit('disconnected');
  await f.endpoint.close();
  assert.equal(f.state().closed, 1);
  // channel closeもICE状態通知を待たずにsessionを撤回する。
  const g = fixture();
  await g.endpoint.answer(offer);
  const dc = channel('ros.control.v1');
  g.onDataChannel.emit(dc);
  dc.stateChanged.emit('closed');
  await g.endpoint.close();
  assert.equal(g.state().closed, 1);
  const timeout = fixture({ timeoutMs: 1 });
  timeout.peer.setRemoteDescription = async () => new Promise(() => {});
  await assert.rejects(timeout.endpoint.answer(offer), /closed|timeout/);
  // negotiation待機の途中で外部closeされた場合もanswerを有限時間で拒否する。
  const cancelled = fixture();
  cancelled.peer.setRemoteDescription = async () => new Promise(() => {});
  const pending = assert.rejects(cancelled.endpoint.answer(offer), /closed/);
  await cancelled.endpoint.close();
  await pending;
  // libraryのcloseが完了しない場合にも上位cleanupを止めない。
  const stuck = fixture({ timeoutMs: 1 });
  stuck.peer.close = async () => new Promise(() => {});
  await stuck.endpoint.close();
  assert.equal(stuck.state().errors, 1);
});

test('LIFE-01 cleanup例外でもpeerを解放し、未初期化/途中閉鎖を扱う', async () => {
  const empty = fixture();
  await empty.endpoint.close();
  await assert.rejects(empty.endpoint.answer(offer), /unavailable/);
  const f = fixture();
  await f.endpoint.answer(offer);
  f.router.close = () => { throw new Error('cleanup'); };
  f.peer.close = async () => { throw new Error('peer cleanup'); };
  await f.endpoint.close();
  assert.equal(f.state().errors, 2);
  // setLocalDescription中に閉鎖されたendpointからanswerを返さない。
  const g = fixture();
  g.peer.setLocalDescription = async () => { await g.endpoint.close(); };
  await assert.rejects(g.endpoint.answer(offer), /closed/);
});

test('CFG-01 transportの不正容量を拒否する', () => {
  assert.throws(() => fixture({ maxMessageBytes: 0 }), /invalid_limit/);
  assert.throws(() => fixture({ maxBufferedBytes: 1 }), /invalid_limit/);
});

test('LIFE-01 routerの致命的終了をreceive/flush後にpeerへ反映する', async () => {
  for (const trigger of ['receive', 'flush']) {
    const f = fixture();
    await f.endpoint.answer(offer);
    const control = channel('ros.control.v1');
    for (const dc of [control, channel('ros.reliable.v1'), channel('ros.realtime.v1')]) f.onDataChannel.emit(dc);
    // routerのcontrol飽和等で閉鎖済みなら、ICE資源とpeer枠も残さない。
    f.router.isClosed = true;
    if (trigger === 'receive') control.onMessage.emit('{}'); else control.bufferedAmountLow.emit();
    await f.endpoint.close();
    assert.equal(f.state().closed, 1);
  }
  // ROS callback内の閉鎖通知もEndpoint起点のreceiveを待たずに回収する。
  const f = fixture();
  await f.endpoint.answer(offer);
  f.notify();
  await new Promise<void>(resolve => queueMicrotask(resolve));
  await f.endpoint.close();
  assert.equal(f.state().closed, 1);
});
