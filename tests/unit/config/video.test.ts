import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBridgeConfig, parseVideoConfig } from '../../../packages/bridge/src/config/index.js';
import type { BridgeConfig } from '../../../packages/bridge/src/config/types.js';

const LIMITS = { max_tracks: 4, max_pipelines: 2, max_slots_per_peer: 2, max_width: 1920, max_height: 1080, max_framerate: 60 };
const SETTINGS = { start_timeout_ms: 5000, stop_grace_ms: 5000, retry_min_interval_ms: 1000, pli_min_interval_ms: 200 };
const TRACK = {
  ros_topic: '/camera/front/image_raw',
  ros_type: 'sensor_msgs/msg/Image',
  ros_qos: { reliability: 'best_effort', durability: 'volatile', history: 'keep_last', depth: 1 },
  input: { encoding: 'rgb8', width: 1280, height: 720, framerate: 30 },
  encoder: { codec: 'h264', backend: 'l4t_v4l2', bitrate: 4000000, keyframe_interval: 30, profile: 'constrained_baseline' },
  access: { subscribe_scope: 'video.front' },
};

/** Build a raw configuration document. @param change Mutation applied to the root @returns Root map */
function root(change: (value: Record<string, any>) => void = () => {}): Record<string, any> {
  const value = {
    version: 1, robot_id: 'robot-01',
    limits: { max_peers: 4, max_message_bytes: 16384, max_peer_queue_bytes: 262144, max_channel_buffered_bytes: 65536, video: { ...LIMITS } },
    topics: {
      '/odom': {
        ros_type: 'std_msgs/msg/String', direction: 'ros_to_web',
        ros_qos: { reliability: 'best_effort', durability: 'volatile', history: 'keep_last', depth: 5 },
        delivery: 'realtime', max_rate_hz: 20, queue: { policy: 'latest', max_messages: 1 },
      },
    },
    video: { ...SETTINGS },
    video_tracks: { front: structuredClone(TRACK) },
  };
  change(value);
  return value;
}

/** Parse topics for collision checks. @param value Root map @returns Validated topic bindings */
function topicsOf(value: Record<string, any>): BridgeConfig['topics'] {
  return parseBridgeConfig(JSON.stringify(value), { availableTypes: ['std_msgs/msg/String'] }).topics;
}

/** Assert that a document is rejected. @param change Mutation @param path Expected configuration path @returns void */
function rejects(change: (value: Record<string, any>) => void, path: string): void {
  const value = root(change);
  assert.throws(() => parseVideoConfig(JSON.stringify(value), topicsOf(value)), error => {
    assert.match((error as Error).message, new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `));
    return true;
  }, `expected ${path} to be rejected`);
}

test('accepts a complete media plane and freezes it', () => {
  const value = root();
  const video = parseVideoConfig(JSON.stringify(value), topicsOf(value));
  assert.ok(video);
  assert.equal(video.tracks.length, 1);
  assert.deepEqual(video.settings, { startTimeoutMs: 5000, stopGraceMs: 5000, retryMinIntervalMs: 1000, pliMinIntervalMs: 200 });
  assert.deepEqual(video.limits, { maxTracks: 4, maxPipelines: 2, maxSlotsPerPeer: 2, maxWidth: 1920, maxHeight: 1080, maxFramerate: 60 });
  const track = video.tracks[0];
  assert.equal(track.name, 'front');
  assert.equal(track.rosTopic, '/camera/front/image_raw');
  assert.deepEqual(track.input, { encoding: 'rgb8', width: 1280, height: 720, framerate: 30 });
  assert.deepEqual(track.encoder, { codec: 'h264', backend: 'l4t_v4l2', bitrate: 4000000, keyframeInterval: 30, profile: 'constrained_baseline' });
  assert.deepEqual(track.access, { subscribeScope: 'video.front' });
  assert.ok(Object.isFrozen(video) && Object.isFrozen(video.tracks) && Object.isFrozen(track.input));
});

test('treats an absent media plane as no video at all', () => {
  const value = root(value => { delete value.video; delete value.video_tracks; delete value.limits.video; });
  assert.equal(parseVideoConfig(JSON.stringify(value), topicsOf(value)), undefined);
});

test('rejects settings, tracks and limits configured apart', () => {
  rejects(value => { delete value.video; }, 'video');
  rejects(value => { delete value.video_tracks; }, 'video');
  // Limits alone used to disable the plane silently, which hides a mistyped or partially applied
  // deployment behind a bridge that simply serves no video.
  rejects(value => { delete value.video; delete value.video_tracks; }, 'video');
  rejects(value => { delete value.limits.video; }, 'video');
});

test('allows separate tracks to select different backends', () => {
  const value = root(value => {
    value.video_tracks.rear = structuredClone(TRACK);
    value.video_tracks.rear.ros_topic = '/camera/rear/image_raw';
    value.video_tracks.rear.encoder.backend = 'openh264';
    value.video_tracks.rear.access.subscribe_scope = 'video.rear';
  });
  const video = parseVideoConfig(JSON.stringify(value), topicsOf(value));
  assert.deepEqual(video?.tracks.map(track => track.encoder.backend), ['l4t_v4l2', 'openh264']);
});

test('rejects unknown fields, track names and ROS contracts', () => {
  rejects(value => { value.video.unexpected = 1; }, 'video.unexpected');
  rejects(value => { value.video_tracks.front.unexpected = 1; }, 'video_tracks.front.unexpected');
  rejects(value => { value.video_tracks['9bad'] = value.video_tracks.front; delete value.video_tracks.front; }, 'video_tracks.9bad');
  // The worker names its ROS node after the track, and ROS rejects a hyphen. Accepting one here
  // would pass the startup probe and fail only when the first viewer subscribed.
  rejects(value => { value.video_tracks['front-camera'] = value.video_tracks.front; delete value.video_tracks.front; }, 'video_tracks.front-camera');
  rejects(value => { value.video_tracks.front.ros_topic = 'relative'; }, 'video_tracks.front.ros_topic');
  rejects(value => { value.video_tracks.front.ros_type = 'sensor_msgs/msg/CompressedImage'; }, 'video_tracks.front.ros_type');
  rejects(value => { value.video_tracks.front.access.subscribe_scope = 'bad scope'; }, 'video_tracks.front.access.subscribe_scope');
  rejects(value => { delete value.video_tracks.front.access; }, 'video_tracks.front.access');
});

test('requires volatile durability so history cannot replay a stale frame', () => {
  rejects(value => { value.video_tracks.front.ros_qos.durability = 'transient_local'; }, 'video_tracks.front');
  rejects(value => { value.video_tracks.front.ros_qos.history = 'keep_all'; }, 'video_tracks.front.ros_qos.history');
});

test('bounds the raw image contract', () => {
  rejects(value => { value.video_tracks.front.input.encoding = 'rgba8'; }, 'video_tracks.front.input.encoding');
  rejects(value => { value.video_tracks.front.input.width = 0; }, 'video_tracks.front.input.width');
  rejects(value => { value.video_tracks.front.input.width = 3840; }, 'video_tracks.front.input');
  rejects(value => { value.video_tracks.front.input.height = 2160; }, 'video_tracks.front.input');
  rejects(value => { value.video_tracks.front.input.framerate = 120; }, 'video_tracks.front.input');
  for (const encoding of ['rgb8', 'bgr8', 'mono8']) {
    const value = root(value => { value.video_tracks.front.input.encoding = encoding; });
    assert.equal(parseVideoConfig(JSON.stringify(value), topicsOf(value))?.tracks[0].input.encoding, encoding);
  }
});

test('requires an explicit supported encoder and rejects an unsupported one', () => {
  rejects(value => { value.video_tracks.front.encoder.codec = 'vp8'; }, 'video_tracks.front.encoder.codec');
  rejects(value => { value.video_tracks.front.encoder.backend = 'auto'; }, 'video_tracks.front.encoder.backend');
  rejects(value => { value.video_tracks.front.encoder.backend = 'x264'; }, 'video_tracks.front.encoder.backend');
  rejects(value => { value.video_tracks.front.encoder.keyframe_interval = 0; }, 'video_tracks.front.encoder.keyframe_interval');
  rejects(value => { value.video_tracks.front.encoder.profile = 'extended'; }, 'video_tracks.front.encoder.profile');
});

test('checks bitrate and profile against the selected backend', () => {
  rejects(value => { value.video_tracks.front.encoder.bitrate = 1000; }, 'video_tracks.front.encoder.bitrate');
  rejects(value => { value.video_tracks.front.encoder.bitrate = 200_000_000; }, 'video_tracks.front.encoder.bitrate');
  // openh264 has a lower ceiling and only offers constrained baseline.
  rejects(value => {
    value.video_tracks.front.encoder.backend = 'openh264';
    value.video_tracks.front.encoder.bitrate = 50_000_000;
  }, 'video_tracks.front.encoder.bitrate');
  rejects(value => {
    value.video_tracks.front.encoder.backend = 'openh264';
    value.video_tracks.front.encoder.profile = 'high';
  }, 'video_tracks.front.encoder.profile');
  const value = root(value => { value.video_tracks.front.encoder.profile = 'high'; });
  assert.equal(parseVideoConfig(JSON.stringify(value), topicsOf(value))?.tracks[0].encoder.profile, 'high');
});

test('bounds capacity and rejects contradictory limits', () => {
  rejects(value => { value.limits.video.max_tracks = 0; }, 'limits.video.max_tracks');
  rejects(value => { value.limits.video.unexpected = 1; }, 'limits.video.unexpected');
  rejects(value => { value.limits.video.max_pipelines = 8; }, 'limits.video');
  rejects(value => { value.video_tracks = {}; }, 'video_tracks');
  rejects(value => {
    value.limits.video.max_tracks = 1;
    value.limits.video.max_pipelines = 1;
    value.video_tracks.rear = structuredClone(TRACK);
    value.video_tracks.rear.ros_topic = '/camera/rear/image_raw';
  }, 'video_tracks');
});

test('rejects one ROS topic served by two sources or by both planes', () => {
  rejects(value => { value.video_tracks.rear = structuredClone(TRACK); }, 'video_tracks.rear');
  rejects(value => { value.video_tracks.front.ros_topic = '/odom'; }, 'video_tracks.front');
});

test('validates every shared timing', () => {
  for (const key of ['start_timeout_ms', 'stop_grace_ms', 'retry_min_interval_ms', 'pli_min_interval_ms']) {
    rejects(value => { value.video[key] = 0; }, `video.${key}`);
  }
});

test('scales to an explicit output geometry when one is configured', () => {
  // Encoding at the input size is the default; an explicit output is how a deployment keeps the
  // encoded H.264 level within what browsers offer.
  const value = root(value => { value.video_tracks.front.output = { width: 1280, height: 720 }; });
  const video = parseVideoConfig(JSON.stringify(value), topicsOf(value));
  assert.deepEqual(video?.tracks[0].output, { width: 1280, height: 720 });
  const plain = root();
  assert.equal(parseVideoConfig(JSON.stringify(plain), topicsOf(plain))?.tracks[0].output, undefined);
});

test('refuses an input geometry H.264 cannot encode', () => {
  // The same rule as `output`: an odd axis has no representation in a chroma-subsampled picture, and
  // accepting one lets the probe pass on a geometry that then encodes to nothing watchable.
  rejects(value => { value.video_tracks.front.input.width = 641; }, 'video_tracks.front.input');
  rejects(value => { value.video_tracks.front.input.height = 721; }, 'video_tracks.front.input');
});

test('bounds the output geometry', () => {
  rejects(value => { value.video_tracks.front.output = { width: 4096, height: 720 }; }, 'video_tracks.front.output');
  rejects(value => { value.video_tracks.front.output = { width: 1280, height: 4096 }; }, 'video_tracks.front.output');
  // H.264 has no representation for an odd axis, so a size that cannot be encoded is refused rather
  // than silently rounded to something the operator did not choose.
  rejects(value => { value.video_tracks.front.output = { width: 1281, height: 720 }; }, 'video_tracks.front.output');
  rejects(value => { value.video_tracks.front.output = { width: 1280, height: 721 }; }, 'video_tracks.front.output');
  rejects(value => { value.video_tracks.front.output = { width: 1280 }; }, 'video_tracks.front.output.height');
  rejects(value => { value.video_tracks.front.output = { width: 1280, height: 720, fit: 'contain' }; }, 'video_tracks.front.output.fit');
});
