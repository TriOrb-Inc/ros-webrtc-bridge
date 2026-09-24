import assert from 'node:assert/strict';
import test from 'node:test';
import { MediaService } from '../../../packages/bridge/src/media/index.js';
import type { MediaSourceFactory } from '../../../packages/bridge/src/media/types.js';
import { binding, clockwork, rtpPacket, videoConfig, viewer } from './fixtures.js';

const settle = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });

test('a start that nobody is waiting for any more must not create an encoder', async () => {
  // A restart suspended on the previous worker's release outlives the viewer that asked for it: the
  // grace window fires while it waits, and its finish finds no source to stop because this one has
  // not been created yet. Resuming and starting anyway leaves a worker with no viewer, no grace
  // timer and no start deadline - nothing in the state machine can reach it.
  let release: (() => void) | undefined;
  const state = { started: 0, stopped: 0 };
  let packet: ((value: Buffer) => void) | undefined;
  const blocking: MediaSourceFactory = () => ({
    async probe() {}, async start(onPacket) { state.started++; packet = onPacket; }, requestKeyframe() {},
    async stop() { state.stopped++; await new Promise<void>(resolve => { release = () => resolve(); }); },
  });
  const time = clockwork();
  const service = new MediaService({ config: videoConfig(), backends: { fixture: blocking },
    clock: time.clock, schedule: time.schedule, onError: () => {} });

  const first = viewer(), second = viewer();
  service.attach('front', first.sink);
  await settle();
  packet!(rtpPacket());
  service.detach('front', first.sink);
  time.advance(5000);                    // grace fires, the release begins and blocks
  await settle();
  service.attach('front', second.sink);  // a restart suspends on that release
  await settle();
  service.detach('front', second.sink);  // and the viewer leaves again
  time.advance(5000);                    // its grace fires while the restart is still suspended
  await settle();
  release!();
  await settle();
  assert.equal(state.started, 1, 'the suspended start must not create an encoder nobody wants');
});

test('AUDIT E: a failed source must not keep viewers that a restart would stream to', async () => {
  // Failure ends the attachment. Leaving the viewer in the source means a restart triggered by
  // somebody else sends RTP to a peer that is not watching, and the stale entry keeps the viewer
  // count above zero so the replacement encoder never stops.
  const sinks: { packet: (p: Buffer) => void; failed: () => void }[] = [];
  const state = { started: 0, stopped: 0 };
  const factory: MediaSourceFactory = () => ({
    async probe() {},
    async start(onPacket, onFailed) { state.started++; sinks.push({ packet: onPacket, failed: onFailed }); },
    requestKeyframe() {}, async stop() { state.stopped++; },
  });
  const time = clockwork();
  const service = new MediaService({ config: videoConfig(), backends: { fixture: factory },
    clock: time.clock, schedule: time.schedule, onError: () => {} });

  const abandoned = viewer();
  service.attach('front', abandoned.sink);
  await settle();
  sinks[0].failed();
  await settle();
  assert.deepEqual(abandoned.states, ['starting', 'failed']);

  time.advance(5000);                       // past the retry window
  const watching = viewer();
  service.attach('front', watching.sink);
  await settle();
  sinks[1].packet(rtpPacket(7));
  assert.deepEqual(abandoned.packets, [], 'the failed peer is not sent the restarted stream');

  service.detach('front', watching.sink);
  time.advance(5000);
  await settle();
  assert.equal(state.stopped, 2, 'and the restart stops when its only real viewer leaves');
});

test('AUDIT G: a start deadline that expires during a release must abandon the start', async () => {
  // A deadline firing while the restart waits sets a terminal phase and cancels itself. Creating the
  // encoder afterwards leaves it running under a phase that says it failed, with nothing left to
  // bound or stop it.
  let release: (() => void) | undefined;
  const state = { started: 0 };
  let packet: ((value: Buffer) => void) | undefined;
  const blocking: MediaSourceFactory = () => ({
    async probe() {}, async start(onPacket) { state.started++; packet = onPacket; }, requestKeyframe() {},
    async stop() { await new Promise<void>(resolve => { release = () => resolve(); }); },
  });
  const time = clockwork();
  const service = new MediaService({ config: videoConfig(), backends: { fixture: blocking },
    clock: time.clock, schedule: time.schedule, onError: () => {} });

  const first = viewer();
  service.attach('front', first.sink);
  await settle();
  packet!(rtpPacket());
  service.detach('front', first.sink);
  time.advance(5000);                       // grace fires; the release blocks
  await settle();
  const second = viewer();
  service.attach('front', second.sink);     // the restart suspends on it
  await settle();
  time.advance(5000);                       // its start deadline expires while it waits
  await settle();
  release!();
  await settle();
  assert.equal(state.started, 1, 'the abandoned start creates nothing');
  assert.deepEqual(second.states.at(-1), 'failed');
});

test('AUDIT F: a backend that never answers the probe must not wedge startup', async () => {
  // The probe runs before the listener opens, so a worker that is spawned and then hangs would
  // leave the bridge with no HTTPS listener, no error and no exit.
  const state = { stopped: 0 };
  const wedged: MediaSourceFactory = () => ({
    async probe() { await new Promise<never>(() => {}); },
    async start() {}, requestKeyframe() {}, async stop() { state.stopped++; },
  });
  const time = clockwork();
  const service = new MediaService({ config: videoConfig(), backends: { fixture: wedged },
    clock: time.clock, schedule: time.schedule, onError: () => {} });
  const probing = service.probe();
  time.advance(5000);
  await assert.rejects(probing, /did not answer the probe/);
  assert.equal(state.stopped, 1, 'and the worker it left behind is ended');
});
