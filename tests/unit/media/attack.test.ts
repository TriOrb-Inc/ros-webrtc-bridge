import assert from 'node:assert/strict';
import test from 'node:test';
import { MediaService } from '../../../packages/bridge/src/media/index.js';
import type { MediaSourceFactory } from '../../../packages/bridge/src/media/types.js';
import { binding, clockwork, videoConfig, viewer } from './fixtures.js';

const settle = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });

test('throttles retries so a broken backend cannot be turned into process creation', async () => {
  // The camera is unplugged, so every start fails. A peer that keeps subscribing keeps spawning
  // worker processes; each one loads GStreamer and a ROS node before it discovers it cannot encode.
  const state = { started: 0 };
  const broken: MediaSourceFactory = () => ({
    async probe() {},
    async start() { state.started++; throw new Error('no such device'); },
    requestKeyframe() {}, async stop() {},
  });
  const time = clockwork();
  const service = new MediaService({ config: videoConfig(), backends: { fixture: broken },
    clock: time.clock, schedule: time.schedule, onError: () => {} });
  const refused = viewer();

  service.attach('front', refused.sink);
  await settle();
  service.detach('front', refused.sink);
  // Every later attempt inside the window is refused outright, so the peer holds no state for a
  // track it never got and its next request is a fresh one.
  for (let attempt = 0; attempt < 19; attempt++) {
    assert.throws(() => { service.attach('front', refused.sink); }, new Error('video_retry_too_soon'));
  }
  assert.equal(state.started, 1, 'twenty subscriptions inside the retry window spawn one worker');

  // Once the window passes, a subscription may try again: retrying stays the peer's decision.
  time.advance(1000);
  const later = viewer();
  service.attach('front', later.sink);
  await settle();
  assert.equal(state.started, 2);
  assert.deepEqual(later.states, ['starting', 'failed']);
});
