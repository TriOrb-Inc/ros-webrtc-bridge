import assert from 'node:assert/strict';
import test from 'node:test';
import { WebRtcEndpoint } from '../../../packages/bridge/src/transport/endpoint.js';
import type { EndpointOptions, Peer, Signal, VideoSlot } from '../../../packages/bridge/src/transport/types.js';

/** Fake the event boundary. Input: type T; output: subscribe only. Example: no event is ever emitted here. */
function signal<T extends unknown[]>(): Signal<T> {
  return { subscribe() { return { unSubscribe() {} }; } };
}

const APPLICATION = 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel';
const VIDEO = ['m=video 9 UDP/TLS/RTP/SAVPF 96', 'a=recvonly', 'a=rtpmap:96 H264/90000', 'a=fmtp:96 packetization-mode=1;profile-level-id=42e01f'];

/** Observe media-plane interaction. Input: whether stopping a slot fails; output: fixture. */
function fixture(stopThrows = false) {
  const added: { payloadType: number; profileLevelId: string }[] = [];
  const stopped: string[] = [];
  let errors = 0;
  const peer: Peer = {
    onDataChannel: signal(), connectionStateChange: signal(),
    localDescription: { type: 'answer', sdp: `${APPLICATION}\r\n` },
    async setRemoteDescription() {}, async createAnswer() { return this.localDescription!; },
    async setLocalDescription() {}, async close() {},
  };
  const video: EndpointOptions['video'] = {
    maxSlots: 2,
    /** Create a slot for one offered section. Input: offered codec; output: recorded fake slot. */
    addSlot(offered) {
      added.push({ ...offered });
      const mid = String(added.length);
      const slot: VideoSlot = { mid, profileLevelId: offered.profileLevelId, write() {}, onKeyframeRequest() {}, stop() { stopped.push(mid); if (stopThrows) throw new Error('stop failed'); } };
      return slot;
    },
  };
  const router = { isClosed: false, receive() {}, flush() {}, close() {} };
  const endpoint = new WebRtcEndpoint({ peer, video, maxMessageBytes: 128, maxBufferedBytes: 256, maxSdpBytes: 4096, timeoutMs: 1000,
    makeRouter: () => router, onClosed() {}, onError() { errors++; } });
  return { endpoint, added, stopped, errors: () => errors };
}

/** Build an offer with the given number of video sections. @param count Sections @returns SDP text */
function offer(count: number): { type: 'offer'; sdp: string } {
  return { type: 'offer', sdp: [APPLICATION, ...Array.from({ length: count }, () => VIDEO).flat()].join('\r\n') };
}

test('creates one send-only slot per offered video section, in m-line order', async () => {
  const f = fixture();
  await f.endpoint.answer(offer(2));
  assert.deepEqual(f.added, [{ payloadType: 96, profileLevelId: '42e01f' }, { payloadType: 96, profileLevelId: '42e01f' }]);
  assert.deepEqual(f.endpoint.videoSlots.map(slot => slot.mid), ['1', '2']);
});

test('creates no slots for a DataChannel-only offer', async () => {
  const f = fixture();
  await f.endpoint.answer({ type: 'offer', sdp: APPLICATION });
  assert.deepEqual(f.added, []);
  assert.deepEqual(f.endpoint.videoSlots, []);
});

test('releases every slot on close and reports a failing stop anonymously', async () => {
  const f = fixture();
  await f.endpoint.answer(offer(2));
  await f.endpoint.close();
  assert.deepEqual(f.stopped, ['1', '2']);
  assert.equal(f.errors(), 0);
  // Closing twice must not stop a slot again; the list is drained as it is released.
  await f.endpoint.close();
  assert.deepEqual(f.stopped, ['1', '2']);
});

test('continues releasing after a slot fails to stop', async () => {
  const f = fixture(true);
  await f.endpoint.answer(offer(2));
  await f.endpoint.close();
  assert.deepEqual(f.stopped, ['1', '2']);
  assert.equal(f.errors(), 2);
});
