import assert from 'node:assert/strict';
import test from 'node:test';
import { VideoRouter, type VideoAccess } from '../../../packages/bridge/src/router/video.js';
import type { VideoSlot } from '../../../packages/bridge/src/transport/types.js';
import type { Viewer } from '../../../packages/bridge/src/media/types.js';
import type { Wire } from '../../../packages/bridge/src/router/types.js';
import { fixture as sessionFixture } from './fixtures.js';

/** Build a negotiated slot. @param mid SDP media identifier @param profileLevelId Negotiated profile @returns Slot plus what it observed */
function slot(mid: string, profileLevelId = '42e01f') {
  const written: Buffer[] = [];
  let keyframe: (() => void) | undefined;
  const value: VideoSlot = {
    mid,
    profileLevelId,
    write(packet) { written.push(packet); },
    onKeyframeRequest(callback) { keyframe = callback; },
    stop() {},
  };
  return { value, written, pli: () => keyframe?.() };
}

/** Assemble a router over two slots. @param allowed Tracks this peer may watch @returns Harness */
function fixture(allowed: readonly string[] = ['front', 'rear']) {
  const attached: string[] = [];
  const detached: string[] = [];
  const keyframes: string[] = [];
  const sent: Wire[] = [];
  const viewers = new Map<string, Viewer>();
  let permitted = new Set(allowed);
  const access: VideoAccess = {
    maxSlots: 2,
    catalog: () => [...permitted].map(track => ({ track, codec: 'h264' })),
    authorize: track => permitted.has(track),
    profileIdc: () => 66,
    attach(track, viewer) { attached.push(track); viewers.set(track, viewer); },
    detach(track) { detached.push(track); },
    requestKeyframe(track) { keyframes.push(track); },
  };
  const slots = [slot('0'), slot('1')];
  const router = new VideoRouter(access, slots.map(entry => entry.value), wire => { sent.push(wire); });
  return { router, slots, attached, detached, keyframes, sent, viewers,
    /** Revoke every scope. @returns void */
    revoke: () => { permitted = new Set(); } };
}

/** Send one control operation. @param f Harness @param op Operation @param extra Fields @returns Response */
function call(f: ReturnType<typeof fixture>, op: string, extra: Wire): Wire {
  return f.router.operation({ v: 1, op, id: 'r1', ...extra }, 'r1');
}

test('lists only tracks this peer may watch, or nothing at all', () => {
  assert.deepEqual(fixture().router.catalog(), [{ track: 'front', codec: 'h264' }, { track: 'rear', codec: 'h264' }]);
  // An empty list is reported as absent so a DataChannel-only welcome stays byte-identical.
  assert.equal(fixture([]).router.catalog(), undefined);
});

test('binds a slot on subscribe and reports its mid', () => {
  const f = fixture();
  assert.deepEqual(call(f, 'video.subscribe', { track: 'front' }), { v: 1, op: 'video.subscribed', id: 'r1', track: 'front', mid: '0' });
  assert.deepEqual(f.attached, ['front']);
  // A second track takes the next slot in m-line order.
  assert.equal(call(f, 'video.subscribe', { track: 'rear' }).mid, '1');
  assert.deepEqual(f.attached, ['front', 'rear']);
});

test('treats a repeated subscribe as the same viewer', () => {
  const f = fixture();
  call(f, 'video.subscribe', { track: 'front' });
  assert.equal(call(f, 'video.subscribe', { track: 'front' }).mid, '0');
  assert.deepEqual(f.attached, ['front'], 'the peer is not counted twice');
});

test('keeps a slot bound so resubscribing reuses it', () => {
  const f = fixture();
  call(f, 'video.subscribe', { track: 'front' });
  assert.deepEqual(call(f, 'video.unsubscribe', { mid: '0' }), { v: 1, op: 'video.unsubscribed', id: 'r1' });
  assert.deepEqual(f.detached, ['front']);
  // Resuming reuses the same mid: a decoder is never handed a different source on one section.
  assert.equal(call(f, 'video.subscribe', { track: 'front' }).mid, '0');
  assert.deepEqual(f.attached, ['front', 'front']);
});

test('refuses more tracks than the offer negotiated slots for', () => {
  const f = fixture(['front', 'rear', 'extra']);
  call(f, 'video.subscribe', { track: 'front' });
  call(f, 'video.subscribe', { track: 'rear' });
  assert.throws(() => call(f, 'video.subscribe', { track: 'extra' }), new Error('video_slot_limit'));
});

test('denies tracks whose scope was not granted', () => {
  const f = fixture(['front']);
  assert.throws(() => call(f, 'video.subscribe', { track: 'rear' }), new Error('unauthorized'));
  assert.deepEqual(f.attached, [], 'no viewer is attached for a denied request');
});

test('rejects unknown slots, unknown operations and unexpected fields', () => {
  const f = fixture();
  assert.throws(() => call(f, 'video.unsubscribe', { mid: '7' }), new Error('unknown_video_slot'));
  assert.throws(() => call(f, 'video.pause', { track: 'front' }), new Error('unknown_operation'));
  assert.throws(() => call(f, 'video.subscribe', { track: 'front', extra: 1 }), new Error('unknown_field'));
  assert.throws(() => call(f, 'video.unsubscribe', { mid: '0', extra: 1 }), new Error('unknown_field'));
});

test('forwards a decoder keyframe request only while watching', () => {
  const f = fixture();
  call(f, 'video.subscribe', { track: 'front' });
  f.slots[0].pli();
  assert.deepEqual(f.keyframes, ['front']);
  call(f, 'video.unsubscribe', { mid: '0' });
  f.slots[0].pli();
  assert.deepEqual(f.keyframes, ['front'], 'a stale request after unsubscribe is ignored');
});

test('delivers RTP to the bound slot and reports lifecycle without a cause', () => {
  const f = fixture();
  call(f, 'video.subscribe', { track: 'front' });
  const viewer = f.viewers.get('front')!;
  viewer.write(Buffer.from([1, 2, 3]));
  assert.deepEqual(f.slots[0].written, [Buffer.from([1, 2, 3])]);
  viewer.state('active');
  assert.deepEqual(f.sent, [{ v: 1, op: 'video.state', track: 'front', mid: '0', state: 'active' }]);
});

test('detaches every viewer when the session ends', () => {
  const f = fixture();
  call(f, 'video.subscribe', { track: 'front' });
  call(f, 'video.subscribe', { track: 'rear' });
  f.router.close();
  assert.deepEqual(f.detached, ['front', 'rear']);
  // Closing twice must not detach an already released viewer again.
  f.router.close();
  assert.deepEqual(f.detached, ['front', 'rear']);
});

test('stops delivering as soon as the scope is revoked', () => {
  const f = fixture();
  call(f, 'video.subscribe', { track: 'front' });
  f.router.revalidate();
  assert.deepEqual(f.detached, []);
  f.revoke();
  f.router.revalidate();
  assert.deepEqual(f.detached, ['front']);
  assert.deepEqual(f.sent.at(-1), { v: 1, op: 'video.state', track: 'front', mid: '0', state: 'failed' });
  // A revoked binding stays released on the next pass.
  f.router.revalidate();
  assert.deepEqual(f.detached, ['front']);
});

/**
 * Build a full session router with a media plane attached.
 *
 * The VideoRouter tests above drive the video operations directly; these drive them through the
 * session router, because the question here is when an event reaches the transport, which only the
 * session router decides.
 * @returns The fixture plus the viewer the media plane was handed.
 */
function session() {
  const viewers = new Map<string, Viewer>();
  const access: VideoAccess = {
    maxSlots: 1,
    catalog: () => [{ track: 'front', codec: 'h264' }],
    authorize: () => true,
    profileIdc: () => 66,
    attach(track, viewer) { viewers.set(track, viewer); },
    detach() {},
    requestKeyframe() {},
  };
  const f = sessionFixture(options => ({ ...options, video: { access, slots: [slot('0').value] } }));
  f.control({ op: 'hello' });
  f.control({ op: 'video.subscribe', id: 'r1', track: 'front' });
  return { f, viewer: () => viewers.get('front')! };
}

test('hands a media-plane event to the transport when it happens', () => {
  // Nothing more is coming from a peer that is only watching video, so an event that waits for the
  // next inbound message to flush the queue never arrives at all.
  const s = session();
  const before = s.f.output.length;
  s.viewer().state('active');
  assert.equal(s.f.output.length, before + 1, 'the event is sent without further peer traffic');
  assert.deepEqual(s.f.last(), { v: 1, op: 'video.state', track: 'front', mid: '0', state: 'active' });
});

test('contains a media-plane event that arrives after the session ended', () => {
  // An encoder stopping is exactly what a closing session causes, so its event races the close.
  const s = session();
  s.f.router.close();
  const after = s.f.output.length;
  s.viewer().state('failed');
  assert.equal(s.f.output.length, after, 'a closed session sends nothing, and does not throw');
});

test('leaves a refused subscription retryable', () => {
  // The media plane refuses an attachment when the encoder concurrency bound is reached. The peer
  // must not be left looking subscribed to a track it is not receiving.
  let refuse = true;
  const attached: string[] = [];
  const access: VideoAccess = {
    maxSlots: 1,
    catalog: () => [{ track: 'front', codec: 'h264' }],
    authorize: () => true,
    profileIdc: () => 66,
    attach(track) { if (refuse) throw new Error('video_pipeline_limit'); attached.push(track); },
    detach() {},
    requestKeyframe() {},
  };
  const router = new VideoRouter(access, [slot('0').value], () => {});
  const subscribe = { v: 1, op: 'video.subscribe', id: 'r1', track: 'front' };
  assert.throws(() => router.operation(subscribe, 'r1'), new Error('video_pipeline_limit'));
  assert.deepEqual(attached, []);

  refuse = false;
  const response = router.operation({ ...subscribe, id: 'r2' }, 'r2');
  assert.deepEqual(attached, ['front'], 'the retry attached for real');
  assert.equal(response.mid, '0', 'and reused the slot already bound to the track');
});

test('binds a track only to a section negotiated for its profile', () => {
  // The offer may carry sections with different profiles. Handing a high-profile stream to a section
  // the decoder negotiated as baseline is exactly the mismatch a browser cannot recover from.
  const attached: string[] = [];
  const idc: Record<string, number> = { front: 100, rear: 66, mast: 77 };
  const access: VideoAccess = {
    maxSlots: 2,
    catalog: () => Object.keys(idc).map(track => ({ track, codec: 'h264' })),
    authorize: () => true,
    profileIdc: track => idc[track],
    attach(track) { attached.push(track); },
    detach() {},
    requestKeyframe() {},
  };
  // Baseline first, high second: a track must reach past the first free section to the right one.
  const slots = [slot('0', '42e01f'), slot('1', '640028')];
  const router = new VideoRouter(access, slots.map(entry => entry.value), () => {});

  assert.equal(router.operation({ v: 1, op: 'video.subscribe', id: 'r1', track: 'front' }, 'r1').mid, '1');
  assert.equal(router.operation({ v: 1, op: 'video.subscribe', id: 'r2', track: 'rear' }, 'r2').mid, '0');
  assert.deepEqual(attached, ['front', 'rear']);

  // No section left that a main-profile track could fill, which is a mismatch rather than a shortage.
  assert.throws(() => router.operation({ v: 1, op: 'video.subscribe', id: 'r3', track: 'mast' }, 'r3'),
    new Error('video_slot_limit'));

  const single = new VideoRouter(access, [slot('0', '42e01f').value], () => {});
  assert.throws(() => single.operation({ v: 1, op: 'video.subscribe', id: 'r4', track: 'mast' }, 'r4'),
    new Error('video_profile_mismatch'));
});
