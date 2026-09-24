import { binding, checkOutputs } from './binding.js';
import { ConfigError, positive, readDocument, record, string } from './validation.js';
import type { BridgeConfig, ConfigOptions } from './types.js';
export { ConfigError, readDocument } from './validation.js';
export { parseVideoConfig, VIDEO_BACKENDS, VIDEO_ENCODINGS } from './video.js';
export type { BridgeConfig, ConfigOptions, TopicBinding, VideoBinding, VideoConfig } from './types.js';

/** Parse startup configuration from YAML and the installed type registry. Example: bridge.yaml returns a frozen BridgeConfig. */
export function parseBridgeConfig(source: string, options: ConfigOptions): BridgeConfig {
  const maxBytes = positive(options.maxConfigBytes ?? 1048576, 'maxConfigBytes', true);
  const maxTopics = positive(options.maxTopics ?? 256, 'maxTopics', true);
  // Validate everything before returning so callers cannot publish a partial catalog.
  const map = record(readDocument(source, maxBytes), ['version', 'robot_id', 'limits', 'topics', 'video', 'video_tracks'], '$');
  if (map.version !== 1) throw new ConfigError('version', 'unsupported version');
  const robotId = string(map.robot_id, /^[A-Za-z0-9_-]+$/, 'robot_id');
  const limits = parseLimits(map.limits);
  // Treat topic names as keys and check every binding against type, direction, and capacity constraints.
  const entries = record(map.topics, Object.keys(Object(map.topics)), 'topics');
  const names = Object.keys(entries);
  if (names.length === 0 || names.length > maxTopics) throw new ConfigError('topics', 'invalid topic count');
  const topics = names.map(name => binding(name, entries[name], options));
  checkOutputs(topics);
  return Object.freeze({ version: 1, robotId, limits, topics: Object.freeze(topics) });
}

/** Validate required capacities. Input: limits map; output: frozen camelCase values. Example: max_message_bytes:16384 becomes maxMessageBytes:16384. */
function parseLimits(value: unknown): BridgeConfig['limits'] {
  const map = record(value, ['max_peers', 'max_message_bytes', 'max_peer_queue_bytes', 'max_channel_buffered_bytes', 'video'], 'limits');
  const maxPeers = positive(map.max_peers, 'limits.max_peers', true);
  const maxMessageBytes = positive(map.max_message_bytes, 'limits.max_message_bytes', true);
  const maxPeerQueueBytes = positive(map.max_peer_queue_bytes, 'limits.max_peer_queue_bytes', true);
  // Reject configurations that cannot hold even one message at startup. The transport applies the negotiated minimum.
  const maxChannelBufferedBytes = positive(map.max_channel_buffered_bytes, 'limits.max_channel_buffered_bytes', true);
  if (maxMessageBytes > 16384 || maxMessageBytes > maxPeerQueueBytes || maxMessageBytes > maxChannelBufferedBytes) {
    throw new ConfigError('limits', 'inconsistent message or buffer limits');
  }
  return Object.freeze({ maxPeers, maxMessageBytes, maxPeerQueueBytes, maxChannelBufferedBytes });
}
