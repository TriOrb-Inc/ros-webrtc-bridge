import assert from 'node:assert/strict';
import test from 'node:test';
import { MediaService } from '../../../packages/bridge/src/media/index.js';
import type { MediaSource, MediaSourceFactory } from '../../../packages/bridge/src/media/types.js';
import { binding, clockwork, videoConfig, viewer } from './fixtures.js';

/** Let rejected encoder promises settle. No input; returns a Promise resolved after the microtask queue. */
const settle = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });

/** Controls a fake encoder so start, failure and keyframe requests can be driven from a test. */
function encoder(behaviour: { startThrows?: boolean; stopThrows?: boolean; keyframeThrows?: boolean } = {}) {
  const state = { started: 0, stopped: 0, keyframes: 0 };
  let emit: ((packet: Buffer) => void) | undefined;
  let fail: (() => void) | undefined;
  const factory: MediaSourceFactory = () => {
    const source: MediaSource = {
      /** Accept the backend. No input; returns a resolved Promise. */
      async probe() {},
      /** Record the sinks. Inputs: packet and failure callbacks; returns a completion Promise. */
      async start(onPacket, onFailed) {
        state.started++;
        if (behaviour.startThrows) throw new Error('encoder refused to start');
        emit = onPacket; fail = onFailed;
      },
      /** Count keyframe requests. No input; returns void. */
      requestKeyframe() { state.keyframes++; if (behaviour.keyframeThrows) throw new Error('keyframe failed'); },
      /** Count stops. No input; returns a completion Promise. */
      async stop() { state.stopped++; if (behaviour.stopThrows) throw new Error('stop failed'); },
    };
    return source;
  };
  return { factory, state,
    /** Emit one packet from the fake encoder. @param value Payload marker @returns void */
    emit: (value = 1) => emit?.(Buffer.from([value])),
    /** Report an encoder failure. @returns void */
    fail: () => fail?.() };
}

/** Build a service over one fixture-backed track. @param e Fake encoder @param tracks Bindings @param limits Bound overrides @returns Harness */
function harness(e = encoder(), tracks = [binding()], limits = {}) {
  const time = clockwork();
  let errors = 0;
  const service = new MediaService({ config: videoConfig(tracks, limits), backends: { fixture: e.factory },
    clock: time.clock, schedule: time.schedule, onError: () => { errors++; } });
  return { service, time, encoder: e, errors: () => errors };
}

test('runs no encoder until somebody watches', () => {
  const h = harness();
  assert.equal(h.encoder.state.started, 0);
  assert.deepEqual(h.service.diagnostics, [{ track: 'front', backend: 'fixture', state: 'idle', viewers: 0, packets: 0, keyframeRequests: 0 }]);
});

test('starts on the first viewer and shares one encoder with the rest', () => {
  const h = harness();
  const first = viewer(), second = viewer();
  h.service.attach('front', first.sink);
  assert.equal(h.encoder.state.started, 1);
  assert.deepEqual(first.states, ['starting']);
  h.encoder.emit();
  assert.deepEqual(first.states, ['starting', 'active']);

  h.service.attach('front', second.sink);
  // A second viewer must not create a second pipeline, and joins with a fresh keyframe.
  assert.equal(h.encoder.state.started, 1);
  assert.equal(h.encoder.state.keyframes, 1);
  assert.deepEqual(second.states, ['active']);

  h.encoder.emit(2);
  assert.deepEqual(first.packets.map(p => p[0]), [1, 2]);
  assert.deepEqual(second.packets.map(p => p[0]), [2]);
  assert.equal(h.service.diagnostics[0].viewers, 2);
});

test('stops only after the last viewer leaves and the grace window expires', () => {
  const h = harness();
  const first = viewer(), second = viewer();
  h.service.attach('front', first.sink);
  h.service.attach('front', second.sink);
  h.encoder.emit();

  h.service.detach('front', first.sink);
  h.time.advance(10_000);
  assert.equal(h.encoder.state.stopped, 0, 'other viewers keep the encoder running');

  h.service.detach('front', second.sink);
  h.time.advance(4_999);
  assert.equal(h.encoder.state.stopped, 0, 'the grace window has not elapsed');
  h.time.advance(1);
  assert.equal(h.encoder.state.stopped, 1);
  assert.equal(h.service.diagnostics[0].state, 'idle');
});

test('resumes inside the grace window without restarting the encoder', () => {
  const h = harness();
  const first = viewer();
  h.service.attach('front', first.sink);
  h.encoder.emit();
  h.service.detach('front', first.sink);
  h.time.advance(1000);

  const second = viewer();
  h.service.attach('front', second.sink);
  h.time.advance(10_000);
  assert.equal(h.encoder.state.started, 1);
  assert.equal(h.encoder.state.stopped, 0);
  assert.deepEqual(second.states, ['active']);
  h.encoder.emit(7);
  assert.deepEqual(second.packets.map(p => p[0]), [7]);
});

test('ignores a detach for a viewer that is not watching', () => {
  const h = harness();
  const watcher = viewer(), stranger = viewer();
  h.service.attach('front', watcher.sink);
  h.encoder.emit();
  h.service.detach('front', stranger.sink);
  h.time.advance(10_000);
  assert.equal(h.encoder.state.stopped, 0);
});

test('rate limits keyframe requests and survives a failing one', () => {
  const h = harness(encoder({ keyframeThrows: true }));
  h.service.attach('front', viewer().sink);
  h.encoder.emit();
  h.service.requestKeyframe('front');
  h.service.requestKeyframe('front');
  assert.equal(h.encoder.state.keyframes, 1, 'a burst collapses into one request');
  assert.equal(h.errors(), 1, 'the failure is reported anonymously');
  h.time.advance(200);
  h.service.requestKeyframe('front');
  assert.equal(h.encoder.state.keyframes, 2);
});

test('fails the source when the encoder never produces output', () => {
  const h = harness();
  const watcher = viewer();
  h.service.attach('front', watcher.sink);
  h.time.advance(5000);
  assert.deepEqual(watcher.states, ['starting', 'failed']);
  assert.equal(h.encoder.state.stopped, 1);
  // A packet arriving after the deadline must not resurrect a source declared failed.
  h.encoder.emit();
  assert.deepEqual(watcher.packets, []);
});

test('fails the source when the encoder reports a failure or refuses to start', async () => {
  const running = harness();
  const watcher = viewer();
  running.service.attach('front', watcher.sink);
  running.encoder.emit();
  running.encoder.fail();
  assert.deepEqual(watcher.states, ['starting', 'active', 'failed']);

  const refused = harness(encoder({ startThrows: true }));
  const rejected = viewer();
  refused.service.attach('front', rejected.sink);
  await settle();
  assert.deepEqual(rejected.states, ['starting', 'failed']);
  assert.equal(refused.errors(), 1);
});

test('retries only when somebody asks again', () => {
  const h = harness();
  const watcher = viewer();
  h.service.attach('front', watcher.sink);
  h.time.advance(5000);
  assert.equal(h.encoder.state.started, 1);
  // Failure is terminal until a new subscription asks for the source again: no hidden retry loop.
  h.time.advance(60_000);
  assert.equal(h.encoder.state.started, 1);
  h.service.attach('front', viewer().sink);
  assert.equal(h.encoder.state.started, 2);
});

test('isolates one failing viewer from the others', () => {
  const h = harness();
  const broken = viewer(() => { throw new Error('peer gone'); });
  const healthy = viewer();
  h.service.attach('front', broken.sink);
  h.service.attach('front', healthy.sink);
  h.encoder.emit();
  assert.equal(healthy.packets.length, 1);
  assert.equal(h.errors(), 1);
});

test('releases a source still inside its grace window', async () => {
  const h = harness();
  const watcher = viewer();
  h.service.attach('front', watcher.sink);
  h.encoder.emit();
  h.service.detach('front', watcher.sink);
  // Shutting down mid-grace must cancel the pending stop rather than leave a timer behind.
  await h.service.close();
  assert.equal(h.encoder.state.stopped, 1);
  assert.equal(h.time.armed(), 0);
});

test('reports a failing stop without leaving the source running', async () => {
  const h = harness(encoder({ stopThrows: true }));
  h.service.attach('front', viewer().sink);
  h.encoder.emit();
  await h.service.close();
  assert.equal(h.encoder.state.stopped, 1);
  assert.equal(h.errors(), 1);
});

test('refuses to serve unknown or closed tracks', async () => {
  const h = harness();
  assert.throws(() => h.service.attach('rear', viewer().sink), new Error('unknown_video_track'));
  await h.service.close();
  assert.throws(() => h.service.attach('front', viewer().sink), new Error('unknown_video_track'));
  // Closing twice is safe and keeps the source released.
  await h.service.close();
});

test('exposes only tracks the caller is allowed to see', () => {
  const h = harness(encoder(), [binding(), binding({ name: 'rear', rosTopic: '/camera/rear/image_raw', access: { subscribeScope: 'video.rear' } })]);
  assert.deepEqual(h.service.catalog(track => track.access.subscribeScope === 'video.rear'), [{ track: 'rear', codec: 'h264' }]);
  assert.deepEqual(h.service.catalog(() => false), []);
  assert.equal(h.service.maxSlots, 2);
});

test('probes every configured backend before peers are accepted', async () => {
  const h = harness();
  await h.service.probe();
  // A backend this build does not provide fails with the configuration path, track and backend named.
  const missing = new MediaService({ config: videoConfig([binding({ encoder: { ...binding().encoder, backend: 'l4t_v4l2' } })]),
    backends: {}, clock: clockwork().clock, schedule: clockwork().schedule, onError: () => {} });
  await assert.rejects(missing.probe(),
    new Error('video_tracks.front.encoder.backend: l4t_v4l2 unavailable: backend is not available in this build'));
  // An unavailable backend also refuses to start, rather than quietly serving nothing.
  const watcher = viewer();
  missing.attach('front', watcher.sink);
  // Requesting while the encoder is still starting reaches the source; afterwards there is none.
  missing.requestKeyframe('front');
  await settle();
  assert.deepEqual(watcher.states, ['starting', 'failed']);
  await missing.close();
});

test('reports a probe failure that carries no message', async () => {
  const service = new MediaService({ config: videoConfig(), clock: clockwork().clock, schedule: clockwork().schedule, onError: () => {},
    backends: { fixture: () => ({ async probe() { throw 'no reason'; }, async start() {}, requestKeyframe() {}, async stop() {} }) } });
  await assert.rejects(service.probe(), /fixture unavailable: probe failed$/);
});

test('counts delivered packets and keyframe requests for diagnostics', () => {
  const h = harness();
  h.service.attach('front', viewer().sink);
  h.encoder.emit();
  h.encoder.emit();
  h.service.requestKeyframe('front');
  assert.deepEqual(h.service.diagnostics, [{ track: 'front', backend: 'fixture', state: 'active', viewers: 1, packets: 2, keyframeRequests: 1 }]);
});

test('runs no more encoders at once than the configuration allows', () => {
  // `max_pipelines` is what protects the GPU and the host, and subscriptions to different tracks
  // arrive independently, so nothing else can apply the bound.
  const tracks = ['front', 'rear', 'mast'].map(name => binding({ name, rosTopic: `/camera/${name}/image_raw` }));
  const h = harness(encoder(), tracks, { maxPipelines: 2 });
  const watchers = [viewer(), viewer(), viewer()];
  h.service.attach('front', watchers[0].sink);
  h.service.attach('rear', watchers[1].sink);
  assert.equal(h.encoder.state.started, 2);
  assert.throws(() => { h.service.attach('mast', watchers[2].sink); }, new Error('video_pipeline_limit'));
  assert.equal(h.encoder.state.started, 2, 'the refused attachment started no encoder');

  // An unwatched source inside its grace window still holds an encoder, so it still counts.
  h.service.detach('front', watchers[0].sink);
  assert.throws(() => { h.service.attach('mast', watchers[2].sink); }, new Error('video_pipeline_limit'));

  // Once it really stops, the slot is free again.
  h.time.advance(5000);
  h.service.attach('mast', watchers[2].sink);
  assert.equal(h.encoder.state.started, 3);
});

test('lets a peer retry a track the media plane refused', () => {
  // A refused attachment must not leave the source counting a viewer it never accepted.
  const tracks = [binding(), binding({ name: 'rear', rosTopic: '/camera/rear/image_raw' })];
  const h = harness(encoder(), tracks, { maxPipelines: 1 });
  const first = viewer(), second = viewer();
  h.service.attach('front', first.sink);
  assert.throws(() => { h.service.attach('rear', second.sink); }, new Error('video_pipeline_limit'));
  h.service.detach('front', first.sink);
  h.time.advance(5000);
  h.service.attach('rear', second.sink);
  assert.equal(h.encoder.state.started, 2);
});
