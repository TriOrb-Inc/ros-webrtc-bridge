import { rosQos } from './binding.js';
import { ConfigError, choice, positive, readDocument, record, string, topicName } from './validation.js';
import type { BridgeConfig, VideoBinding, VideoConfig, VideoLimits, VideoSettings } from './types.js';

/**
 * ROS image encodings this bridge accepts, mapped to the GStreamer raw format a backend must request.
 * Deliberately small: every entry here needs a verified conversion path, so the set grows with evidence.
 */
const VIDEO_ENCODINGS = Object.freeze({ rgb8: 'RGB', bgr8: 'BGR', mono8: 'GRAY8' } as const);

/**
 * H.264 `profile_idc` for each configured profile name.
 *
 * The first byte of an SDP `profile-level-id` carries this, which is how a negotiated section and a
 * configured track are compared.
 */
export const PROFILE_IDC: Readonly<Record<string, number>> = Object.freeze({ constrained_baseline: 66, main: 77, high: 100 });

/**
 * Encoder backends selectable per track, with the profiles and bitrate range each one supports.
 * Selection is always explicit in configuration: this table validates a choice, it never makes one.
 */
const VIDEO_BACKENDS = Object.freeze({
  fixture: { profiles: ['constrained_baseline'], bitrate: [1, 100_000_000] },
  l4t_v4l2: { profiles: ['constrained_baseline', 'main', 'high'], bitrate: [64_000, 100_000_000] },
  openh264: { profiles: ['constrained_baseline'], bitrate: [64_000, 40_000_000] },
} as const);

/**
 * Validate the shared `video` section.
 * @param value Raw map, e.g. `{start_timeout_ms: 5000, stop_grace_ms: 5000, retry_min_interval_ms: 5000, pli_min_interval_ms: 200}`.
 * @returns Frozen settings, e.g. `{startTimeoutMs: 5000, ...}`. Missing or non-positive values throw.
 */
function videoSettings(value: unknown): VideoSettings {
  const map = record(value, ['start_timeout_ms', 'stop_grace_ms', 'retry_min_interval_ms', 'pli_min_interval_ms'], 'video');
  return Object.freeze({
    startTimeoutMs: positive(map.start_timeout_ms, 'video.start_timeout_ms', true),
    // A short grace window absorbs reconnects without restarting the encoder for every page reload.
    stopGraceMs: positive(map.stop_grace_ms, 'video.stop_grace_ms', true),
    // Retrying is a peer's decision, so the peer decides how often an encoder is spawned. This is
    // what keeps a broken backend from turning subscriptions into unbounded process creation.
    retryMinIntervalMs: positive(map.retry_min_interval_ms, 'video.retry_min_interval_ms', true),
    pliMinIntervalMs: positive(map.pli_min_interval_ms, 'video.pli_min_interval_ms', true),
  });
}

/**
 * Validate one `video_tracks` entry.
 * @param name Public track name used on the wire, e.g. `front`.
 * @param value Raw map holding ros_topic/ros_type/ros_qos/input/encoder/access.
 * @param limits Validated capacity limits, used to bound resolution and frame rate.
 * @returns Frozen binding, e.g. `{name:'front', input:{encoding:'rgb8',width:1280,...}}`.
 */
function videoBinding(name: string, value: unknown, limits: VideoLimits): VideoBinding {
  const path = `video_tracks.${name}`;
  // The worker names its ROS node after the track, and ROS rejects anything but letters, digits and
  // underscores. Allowing a hyphen here would pass the startup probe, which creates no node, and
  // fail only once the first viewer subscribed.
  string(name, /^[A-Za-z][A-Za-z0-9_]*$/, path);
  const map = record(value, ['ros_topic', 'ros_type', 'ros_qos', 'input', 'output', 'encoder', 'access'], path);
  // A video source is one ROS subscription; unlike `topics` the key is a short public label, so the
  // ROS name is always explicit.
  const rosTopic = topicName(map.ros_topic, `${path}.ros_topic`);
  const rosType = string(map.ros_type, /^sensor_msgs\/msg\/Image$/, `${path}.ros_type`);
  const qos = rosQos(map.ros_qos, path);
  // Latched history would replay a stale frame into a live stream; require volatile delivery.
  if (qos.durability !== 'volatile') throw new ConfigError(path, 'video requires volatile durability');
  const access = record(map.access, ['subscribe_scope'], `${path}.access`);
  return Object.freeze({
    name, rosTopic, rosType, rosQos: qos,
    input: videoInput(map.input, limits, path),
    ...(map.output === undefined ? {} : { output: videoOutput(map.output, limits, path) }),
    encoder: videoEncoder(map.encoder, path),
    // Omitting the scope is not "public": the caller denies every scope it was not granted.
    access: Object.freeze({ subscribeScope: string(access.subscribe_scope, /^[A-Za-z0-9_.:-]+$/, `${path}.access.subscribe_scope`) }),
  });
}

/**
 * Validate the raw-image contract the source must deliver.
 * @param value Raw map, e.g. `{encoding:'rgb8', width:1280, height:720, framerate:30}`.
 * @param limits Capacity limits bounding width/height/framerate.
 * @param path Owning configuration path, e.g. `video_tracks.front`.
 * @returns Frozen input description. Out-of-range or unsupported encodings throw.
 */
function videoInput(value: unknown, limits: VideoLimits, path: string): VideoBinding['input'] {
  const map = record(value, ['encoding', 'width', 'height', 'framerate'], `${path}.input`);
  const encoding = choice(map.encoding, Object.keys(VIDEO_ENCODINGS) as (keyof typeof VIDEO_ENCODINGS)[], `${path}.input.encoding`);
  const width = positive(map.width, `${path}.input.width`, true);
  const height = positive(map.height, `${path}.input.height`, true);
  const framerate = positive(map.framerate, `${path}.input.framerate`, true);
  // Bound the pixel rate rather than each axis alone: 8K at 1 fps and 240p at 600 fps both matter.
  if (width > limits.maxWidth || height > limits.maxHeight || framerate > limits.maxFramerate) {
    throw new ConfigError(`${path}.input`, 'exceeds configured video limits');
  }
  // H.264 codes a chroma-subsampled picture, so an odd axis has no representation - the same reason
  // `output` is checked. Rejecting here is what keeps a probe from passing on a geometry that then
  // encodes to something with no picture in it.
  if (width % 2 !== 0 || height % 2 !== 0) throw new ConfigError(`${path}.input`, 'width and height must be even');
  return Object.freeze({ encoding, width, height, framerate });
}

/**
 * Validate the encoded geometry a track scales its frames to.
 *
 * Scaling is the media plane's job because nothing else can do it: the ROS source publishes what the
 * camera produces, and an H.264 level is a property of the encoded size. A 1600x1300 source encodes
 * at level 4.2, which a browser offering level 3.1 is not required to decode; scaling to 1280x720
 * brings it to 3.1.
 *
 * @param value Raw map, e.g. `{width:1280, height:720}`.
 * @param limits Validated capacity limits, which bound the output as well as the input.
 * @param path Owning configuration path, e.g. `video_tracks.front`.
 * @returns Frozen output geometry.
 */
function videoOutput(value: unknown, limits: VideoLimits, path: string): NonNullable<VideoBinding['output']> {
  const map = record(value, ['width', 'height'], `${path}.output`);
  const width = positive(map.width, `${path}.output.width`, true);
  const height = positive(map.height, `${path}.output.height`, true);
  if (width > limits.maxWidth || height > limits.maxHeight) throw new ConfigError(`${path}.output`, 'exceeds configured video limits');
  // H.264 codes in 16x16 macroblocks over a chroma-subsampled picture, so an odd axis has no
  // representation. Rejecting is better than silently rounding a size the operator chose.
  if (width % 2 !== 0 || height % 2 !== 0) throw new ConfigError(`${path}.output`, 'width and height must be even');
  return Object.freeze({ width, height });
}

/**
 * Validate encoder selection and parameters.
 * @param value Raw map, e.g. `{codec:'h264', backend:'l4t_v4l2', bitrate:4000000, keyframe_interval:30, profile:'constrained_baseline'}`.
 * @param path Owning configuration path, e.g. `video_tracks.front`.
 * @returns Frozen encoder description. There is no `auto` backend and no fallback.
 */
function videoEncoder(value: unknown, path: string): VideoBinding['encoder'] {
  const map = record(value, ['codec', 'backend', 'bitrate', 'keyframe_interval', 'profile'], `${path}.encoder`);
  choice(map.codec, ['h264'], `${path}.encoder.codec`);
  const backend = choice(map.backend, Object.keys(VIDEO_BACKENDS) as (keyof typeof VIDEO_BACKENDS)[], `${path}.encoder.backend`);
  const descriptor = VIDEO_BACKENDS[backend];
  // Bitrate is always bits per second here; converting to each element's unit belongs to the backend.
  const bitrate = positive(map.bitrate, `${path}.encoder.bitrate`, true);
  if (bitrate < descriptor.bitrate[0] || bitrate > descriptor.bitrate[1]) {
    throw new ConfigError(`${path}.encoder.bitrate`, 'outside the range supported by the selected backend');
  }
  const profile = choice(map.profile, ['constrained_baseline', 'main', 'high'], `${path}.encoder.profile`);
  if (!(descriptor.profiles as readonly string[]).includes(profile)) {
    throw new ConfigError(`${path}.encoder.profile`, 'unsupported by the selected backend');
  }
  return Object.freeze({ codec: 'h264', backend, bitrate, keyframeInterval: positive(map.keyframe_interval, `${path}.encoder.keyframe_interval`, true), profile });
}

/**
 * Validate every configured track together with the limits that bound them.
 * @param value Raw `video_tracks` map.
 * @param limits Validated capacity limits.
 * @returns Frozen bindings, e.g. `[{name:'front',...}]`.
 */
function videoBindings(value: unknown, limits: VideoLimits): readonly VideoBinding[] {
  const entries = record(value, Object.keys(Object(value)), 'video_tracks');
  const names = Object.keys(entries);
  if (names.length === 0 || names.length > limits.maxTracks) throw new ConfigError('video_tracks', 'invalid video track count');
  const tracks = names.map(name => videoBinding(name, entries[name], limits));
  // One ROS topic feeds at most one source: two encoders on the same images would double the cost
  // and make diagnostics ambiguous about which pipeline a measurement came from.
  const sources = new Set<string>();
  for (const track of tracks) {
    if (sources.has(track.rosTopic)) throw new ConfigError(`video_tracks.${track.name}`, 'duplicate video source topic');
    sources.add(track.rosTopic);
  }
  return Object.freeze(tracks);
}

/**
 * Validate media-plane capacities.
 * @param value Raw `limits.video` map, e.g. `{max_tracks:4, max_pipelines:2, ...}`.
 * @returns Frozen bounds. Fewer tracks than pipelines is contradictory and throws.
 */
function videoLimits(value: unknown): VideoLimits {
  const map = record(value, ['max_tracks', 'max_pipelines', 'max_slots_per_peer', 'max_width', 'max_height', 'max_framerate'], 'limits.video');
  const limits = Object.freeze({
    maxTracks: positive(map.max_tracks, 'limits.video.max_tracks', true),
    maxPipelines: positive(map.max_pipelines, 'limits.video.max_pipelines', true),
    maxSlotsPerPeer: positive(map.max_slots_per_peer, 'limits.video.max_slots_per_peer', true),
    maxWidth: positive(map.max_width, 'limits.video.max_width', true),
    maxHeight: positive(map.max_height, 'limits.video.max_height', true),
    maxFramerate: positive(map.max_framerate, 'limits.video.max_framerate', true),
  });
  // Running more encoders than configured sources cannot happen; the contradiction hides a mistake.
  if (limits.maxPipelines > limits.maxTracks) throw new ConfigError('limits.video', 'more pipelines than tracks');
  return limits;
}

/**
 * Validate the media plane, kept separate from BridgeConfig so raw video never enters the JSON path.
 * @param source The same YAML document BridgeConfig was built from.
 * @param topics Validated topic bindings, checked for ROS name collisions with video sources.
 * @param maxBytes Document limit in UTF-8 bytes.
 * @returns Frozen media plane, or undefined when the deployment serves no video.
 */
export function parseVideoConfig(source: string, topics: BridgeConfig['topics'], maxBytes = 1048576): VideoConfig | undefined {
  const document = readDocument(source, maxBytes);
  const map = record(document, Object.keys(Object(document)), '$');
  // Video is opt-in and all-or-nothing: settings without tracks (or the reverse) is a mistake, not a
  // half-configured deployment we should silently accept. `limits.video` counts as one of the three,
  // so a document carrying only that fails rather than starting with no media plane at all.
  const bounds = record(map.limits, Object.keys(Object(map.limits)), 'limits').video;
  if (map.video === undefined && map.video_tracks === undefined && bounds === undefined) return undefined;
  if (map.video === undefined || map.video_tracks === undefined || bounds === undefined) {
    throw new ConfigError('video', 'video, video_tracks and limits.video must be configured together');
  }
  const limits = videoLimits(bounds);
  const tracks = videoBindings(map.video_tracks, limits);
  // The two planes have different size limits, authorization and queue behaviour. Serving one ROS
  // topic through both would make the effective contract depend on which path a client used.
  const exposed = new Set(topics.map(topic => topic.rosTopic));
  for (const track of tracks) {
    if (exposed.has(track.rosTopic)) throw new ConfigError(`video_tracks.${track.name}`, 'topic is already exposed through topics');
  }
  return Object.freeze({ settings: videoSettings(map.video), limits, tracks });
}
