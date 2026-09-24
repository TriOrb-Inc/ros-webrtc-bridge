import assert from 'node:assert/strict';
import test from 'node:test';
import { MediaService } from '../../../packages/bridge/src/media/index.js';
import type { MediaSourceFactory } from '../../../packages/bridge/src/media/types.js';
import { binding, clockwork, rtpPacket, videoConfig, viewer } from './fixtures.js';

const settle = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });

/** Build a service whose encoders expose their own callbacks, so a superseded one can still fire. */
function harness() {
  const sinks: { packet: (p: Buffer) => void; failed: () => void }[] = [];
  const state = { started: 0, stopped: 0 };
  const factory: MediaSourceFactory = () => ({
    async probe() {},
    async start(onPacket, onFailed) { state.started++; sinks.push({ packet: onPacket, failed: onFailed }); },
    requestKeyframe() {},
    async stop() { state.stopped++; },
  });
  const time = clockwork();
  const service = new MediaService({ config: videoConfig([binding()]), backends: { fixture: factory },
    clock: time.clock, schedule: time.schedule, onError: () => {} });
  return { service, time, sinks, state };
}

test('REPRO: a superseded encoder still drives the source that replaced it', async () => {
  const h = harness();
  const first = viewer();
  h.service.attach('front', first.sink);
  await settle();
  h.sinks[0].packet(rtpPacket(1));
  h.service.detach('front', first.sink);
  h.time.advance(5000);
  await settle();

  const second = viewer();
  h.service.attach('front', second.sink);
  await settle();
  assert.equal(h.state.started, 2, 'a replacement is running');

  // The old worker's stream had a packet in flight when it was stopped.
  h.sinks[0].packet(rtpPacket(9));
  assert.deepEqual(second.packets, [], 'a stale packet must not reach the new stream');

  // And its failure callback must not take down the encoder that replaced it.
  h.sinks[0].failed();
  await settle();
  assert.equal(h.service.diagnostics[0].state, 'starting', 'the replacement survives the old failure');
});

test('numbers the track continuously across an encoder restart', async () => {
  // The sender adds a constant offset rather than renumbering, so a restarted encoder's fresh random
  // bases would reach the decoder as a discontinuity on an unchanged SSRC - which a browser drops
  // without ever recovering. Continuity is the bridge's job because the track is the bridge's.
  const h = harness();
  const watcher = viewer();
  h.service.attach('front', watcher.sink);
  await settle();
  h.sinks[0].packet(rtpPacket(1, 40000, 1_000_000));
  h.sinks[0].packet(rtpPacket(2, 40001, 1_000_000));
  h.sinks[0].packet(rtpPacket(3, 40002, 1_003_000));

  h.service.detach('front', watcher.sink);
  h.time.advance(5000);
  await settle();
  h.service.attach('front', watcher.sink);
  await settle();
  // A second encoder, with bases nowhere near the first.
  h.sinks[1].packet(rtpPacket(4, 7, 25));
  h.sinks[1].packet(rtpPacket(5, 8, 3025));

  const seq = watcher.packets.map(p => p.readUInt16BE(2));
  const ts = watcher.packets.map(p => p.readUInt32BE(4));
  assert.deepEqual(seq, [0, 1, 2, 3, 4], 'sequence numbers continue through the restart');
  assert.ok(ts.every((value, index) => index === 0 || value >= ts[index - 1]),
    `timestamps must not go backwards: ${ts.join(', ')}`);
  assert.equal(ts[0], ts[1], 'packets of one frame keep a shared timestamp');
  assert.ok(ts[3] > ts[2], 'the restarted stream resumes after the one it replaced');
});
