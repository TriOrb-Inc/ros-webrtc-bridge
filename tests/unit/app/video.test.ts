import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import { startApp } from '../../../packages/bridge/src/app/runtime.js';
import type { AppFactories } from '../../../packages/bridge/src/app/types.js';
import type { MediaSource } from '../../../packages/bridge/src/media/types.js';
import type { Peer, VideoSlot } from '../../../packages/bridge/src/transport/types.js';
import { fixture, settings } from './fixtures.js';
import { rtpPacket } from '../media/fixtures.js';

const VIDEO_CONFIG = `version: 1
robot_id: fixture
limits:
  max_peers: 1
  max_message_bytes: 4096
  max_peer_queue_bytes: 65536
  max_channel_buffered_bytes: 8192
  video: {max_tracks: 2, max_pipelines: 1, max_slots_per_peer: 1, max_width: 1920, max_height: 1080, max_framerate: 60}
topics:
  /out:
    ros_type: std_msgs/msg/String
    direction: ros_to_web
    ros_qos: {reliability: reliable, durability: volatile, history: keep_last, depth: 1}
    delivery: reliable
    max_rate_hz: 10
    queue: {policy: fifo, max_messages: 4}
video: {start_timeout_ms: 5000, stop_grace_ms: 5000, retry_min_interval_ms: 1000, pli_min_interval_ms: 200}
video_tracks:
  front:
    ros_topic: /camera/front/image_raw
    ros_type: sensor_msgs/msg/Image
    ros_qos: {reliability: best_effort, durability: volatile, history: keep_last, depth: 1}
    input: {encoding: rgb8, width: 1280, height: 720, framerate: 30}
    encoder: {codec: h264, backend: fixture, bitrate: 4000000, keyframe_interval: 30, profile: constrained_baseline}
    access: {subscribe_scope: video.front}
`;

const OFFER = ['m=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=recvonly',
  'a=rtpmap:96 H264/90000', 'a=fmtp:96 packetization-mode=1;profile-level-id=42e01f'].join('\r\n');

/** Build a fake encoder that emits on demand. No input; returns the factory plus its controls. */
function encoder() {
  const state = { started: 0, stopped: 0, probed: 0 };
  let emit: ((packet: Buffer) => void) | undefined;
  return {
    state,
    /** Emit one packet from the fake encoder. @param value Payload marker @returns void */
    emit: (value = 1) => emit?.(rtpPacket(value, value, value * 3000)),
    /** Build the source. No input; returns a MediaSource recording its calls. */
    factory: (): MediaSource => ({
      async probe() { state.probed++; },
      async start(onPacket) { state.started++; emit = onPacket; },
      requestKeyframe() {},
      async stop() { state.stopped++; },
    }),
  };
}

/** Start an app serving one fixture-backed video track. @param change Factory overrides @returns Harness */
async function harness(change: Partial<AppFactories> = {}) {
  const base = fixture();
  const delays: { at: number; callback: () => void }[] = [];
  const e = encoder();
  const slots: { mid: string; written: Buffer[]; stopped: number; pli?: () => void }[] = [];
  let handle!: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  const factories: AppFactories = {
    ...base.factories,
    videoBackends: { fixture: e.factory },
    /** Create a fake transceiver slot. Inputs: peer and offered codec; returns a recorded slot. */
    makeVideoSlot(_peer: Peer, offered) {
      const entry = { mid: String(slots.length), written: [] as Buffer[], stopped: 0, pli: undefined as (() => void) | undefined };
      slots.push(entry);
      return { get mid() { return entry.mid; }, profileLevelId: offered.profileLevelId,
        write(packet: Buffer) { entry.written.push(packet); },
        onKeyframeRequest(callback: () => void) { entry.pli = callback; }, stop() { entry.stopped++; } } satisfies VideoSlot;
    },
    /** Capture the signaling handler. Input: handler; returns a closable server. */
    async listen(handler) { handle = handler; return { async close() {} }; },
    /** Record lifecycle delays instead of sleeping. Inputs: callback and delay; returns a canceller. */
    schedule(callback, delayMs) {
      const entry = { at: delayMs, callback };
      delays.push(entry);
      return () => { const index = delays.indexOf(entry); if (index >= 0) delays.splice(index, 1); };
    },
    ...change,
  };
  const app = await startApp({ ...settings, configSource: VIDEO_CONFIG, videoScopes: ['video.front'] }, factories);
  return { ...base, app, encoder: e, slots, delays,
    /** Submit an offer. @param sdp Offer text @returns HTTP status */
    async offer(sdp = OFFER) {
      const request = Object.assign(new EventEmitter(), { method: 'POST', url: '/offer', headers: {
        authorization: `Bearer ${settings.credential}`, 'content-type': 'application/json' } });
      let status = 0;
      const response = { writeHead(value: number) { status = value; }, end() {} };
      const pending = handle(request as IncomingMessage, response as unknown as ServerResponse);
      request.emit('data', Buffer.from(JSON.stringify({ type: 'offer', sdp })));
      request.emit('end');
      await pending;
      request.emit('close');
      return status;
    } };
}

/** Open the three channels and complete the handshake. @param h Harness @returns Control channel */
function connect(h: Awaited<ReturnType<typeof harness>>) {
  const control = h.peers[0].channels[0];
  h.peers[0].open();
  control.onMessage.emit(Buffer.from(JSON.stringify({ v: 1, op: 'hello' })));
  return control;
}

test('probes every backend before the listener opens', async () => {
  const h = await harness();
  assert.equal(h.encoder.state.probed, 1);
  assert.equal(h.encoder.state.started, 0, 'probing leaves no encoder running');
  assert.deepEqual(h.app.videoDiagnostics(), [{ track: 'front', backend: 'fixture', state: 'idle', viewers: 0, packets: 0, keyframeRequests: 0 }]);
  await h.app.close();
});

test('fails startup when a configured backend is unavailable', async () => {
  // A build shipping no encoder at all must fail as loudly as one missing a GStreamer element.
  await assert.rejects(harness({ videoBackends: undefined }),
    new Error('video_tracks.front.encoder.backend: fixture unavailable: backend is not available in this build'));
});

test('negotiates a slot, serves it on request and releases it on shutdown', async () => {
  const h = await harness();
  assert.equal(await h.offer(), 200);
  assert.equal(h.slots.length, 1, 'one transceiver per offered section');
  const control = connect(h);

  const welcome = control.sent.find(wire => wire.op === 'welcome')!;
  assert.deepEqual(welcome.video, [{ track: 'front', codec: 'h264' }]);
  assert.equal(h.encoder.state.started, 0, 'a negotiated section alone does not start the encoder');

  control.onMessage.emit(Buffer.from(JSON.stringify({ v: 1, op: 'video.subscribe', id: 'r1', track: 'front' })));
  assert.deepEqual(control.sent.find(wire => wire.op === 'video.subscribed'),
    { v: 1, op: 'video.subscribed', id: 'r1', track: 'front', mid: '0' });
  assert.equal(h.encoder.state.started, 1);

  h.encoder.emit(9);
  // The track renumbers, so compare the payload the encoder produced rather than the header.
  assert.deepEqual(h.slots[0].written.map(packet => packet[12]), [9]);
  assert.equal(h.app.videoDiagnostics()[0].viewers, 1);

  // A decoder asking for a keyframe reaches the encoder through the negotiated sender.
  h.slots[0].pli!();
  assert.equal(h.app.videoDiagnostics()[0].keyframeRequests, 1);

  control.onMessage.emit(Buffer.from(JSON.stringify({ v: 1, op: 'video.unsubscribe', id: 'r2', mid: '0' })));
  assert.ok(control.sent.some(wire => wire.op === 'video.unsubscribed'));

  await h.app.close();
  assert.equal(h.encoder.state.stopped, 1);
  assert.equal(h.slots[0].stopped, 1);
});

test('denies a track whose scope was not granted', async () => {
  const base = fixture();
  const e = encoder();
  let handle!: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  const app = await startApp({ ...settings, configSource: VIDEO_CONFIG, videoScopes: [] }, {
    ...base.factories, videoBackends: { fixture: e.factory },
    makeVideoSlot: () => ({ mid: '0', profileLevelId: '42e01f', write() {}, onKeyframeRequest() {}, stop() {} }),
    async listen(handler) { handle = handler; return { async close() {} }; },
  });
  const request = Object.assign(new EventEmitter(), { method: 'POST', url: '/offer', headers: {
    authorization: `Bearer ${settings.credential}`, 'content-type': 'application/json' } });
  const pending = handle(request as IncomingMessage, { writeHead() {}, end() {} } as unknown as ServerResponse);
  request.emit('data', Buffer.from(JSON.stringify({ type: 'offer', sdp: OFFER })));
  request.emit('end');
  await pending;
  const control = base.peers[0].channels[0];
  base.peers[0].open();
  control.onMessage.emit(Buffer.from(JSON.stringify({ v: 1, op: 'hello' })));
  // An unauthorized peer sees no catalog entry and cannot subscribe.
  assert.ok(!('video' in control.sent.find(wire => wire.op === 'welcome')!));
  control.onMessage.emit(Buffer.from(JSON.stringify({ v: 1, op: 'video.subscribe', id: 'r1', track: 'front' })));
  assert.deepEqual(control.sent.at(-1), { v: 1, op: 'error', id: 'r1', code: 'request_rejected' });
  assert.equal(e.state.started, 0, 'no encoder runs for a denied request');
  await app.close();
});

test('rejects an offer carrying more video sections than configured', async () => {
  const h = await harness();
  assert.equal(await h.offer(`${OFFER}\r\n${OFFER.split('\r\n').slice(1).join('\r\n')}`), 400);
  await h.app.close();
});

test('falls back to real timers when no scheduler is injected', async () => {
  const base = fixture();
  const e = encoder();
  let handle!: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  const app = await startApp({ ...settings, configSource: VIDEO_CONFIG.replace('stop_grace_ms: 5000', 'stop_grace_ms: 1'), videoScopes: ['video.front'] }, {
    ...base.factories, videoBackends: { fixture: e.factory },
    makeVideoSlot: () => ({ mid: '0', profileLevelId: '42e01f', write() {}, onKeyframeRequest() {}, stop() {} }),
    async listen(handler) { handle = handler; return { async close() {} }; },
  });
  const request = Object.assign(new EventEmitter(), { method: 'POST', url: '/offer', headers: {
    authorization: `Bearer ${settings.credential}`, 'content-type': 'application/json' } });
  const pending = handle(request as IncomingMessage, { writeHead() {}, end() {} } as unknown as ServerResponse);
  request.emit('data', Buffer.from(JSON.stringify({ type: 'offer', sdp: OFFER })));
  request.emit('end');
  await pending;
  const control = base.peers[0].channels[0];
  base.peers[0].open();
  control.onMessage.emit(Buffer.from(JSON.stringify({ v: 1, op: 'hello' })));
  control.onMessage.emit(Buffer.from(JSON.stringify({ v: 1, op: 'video.subscribe', id: 'r1', track: 'front' })));
  e.emit();
  control.onMessage.emit(Buffer.from(JSON.stringify({ v: 1, op: 'video.unsubscribe', id: 'r2', mid: '0' })));
  // The real grace timer must elapse on its own rather than needing an injected clock.
  await new Promise(resolve => { setTimeout(resolve, 20); });
  assert.equal(e.state.stopped, 1);
  await app.close();
});

test('leaves a DataChannel-only deployment untouched', async () => {
  const base = fixture();
  const app = await startApp(settings, base.factories);
  assert.deepEqual(app.videoDiagnostics(), []);
  assert.equal(await base.offer(), 200);
  const control = base.peers[0].channels[0];
  base.peers[0].open();
  control.onMessage.emit(Buffer.from(JSON.stringify({ v: 1, op: 'hello' })));
  assert.ok(!('video' in control.sent.find(wire => wire.op === 'welcome')!), 'the welcome envelope gains no video key');
  // Video operations stay unknown without a media plane.
  control.onMessage.emit(Buffer.from(JSON.stringify({ v: 1, op: 'video.subscribe', id: 'r1', track: 'front' })));
  assert.deepEqual(control.sent.at(-1), { v: 1, op: 'error', id: 'r1', code: 'request_rejected' });
  await app.close();
});
