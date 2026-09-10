import { parseDocument } from 'yaml';
import { binding, checkOutputs } from './binding.js';
import { ConfigError, positive, record, string } from './validation.js';
import type { BridgeConfig, ConfigOptions } from './types.js';
export { ConfigError } from './validation.js';
export type { BridgeConfig, ConfigOptions, TopicBinding } from './types.js';

/** YAMLを起動用設定にする。入力は文書と導入済み型registry。例: bridge.yaml → 凍結したBridgeConfig。 */
export function parseBridgeConfig(source: string, options: ConfigOptions): BridgeConfig {
  const maxBytes = positive(options.maxConfigBytes ?? 1048576, 'maxConfigBytes', true);
  const maxTopics = positive(options.maxTopics ?? 256, 'maxTopics', true);
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > maxBytes) throw new ConfigError('$', 'invalid document size');
  // alias展開や独自tagにより、検証前に不意の型・容量が生じることを防ぐ。
  let value: unknown;
  try {
    const doc = parseDocument(source, { uniqueKeys: true, version: '1.2', schema: 'core' });
    if (doc.errors.length || doc.warnings.length) throw new Error('invalid YAML');
    value = doc.toJS({ maxAliasCount: 0 });
  } catch {
    throw new ConfigError('$', 'invalid YAML; aliases and custom tags are unsupported');
  }
  // すべて検証してから返すため、呼出側は途中のcatalogを公開しない。
  const map = record(value, ['version', 'robot_id', 'limits', 'topics'], '$');
  if (map.version !== 1) throw new ConfigError('version', 'unsupported version');
  const robotId = string(map.robot_id, /^[A-Za-z0-9_-]+$/, 'robot_id');
  const limits = parseLimits(map.limits);
  // topicsの名前そのものをkeyとして扱い、全bindingを型・方向・容量と照合する。
  const entries = record(map.topics, Object.keys(Object(map.topics)), 'topics');
  const names = Object.keys(entries);
  if (names.length === 0 || names.length > maxTopics) throw new ConfigError('topics', 'invalid topic count');
  const topics = names.map(name => binding(name, entries[name], options));
  checkOutputs(topics);
  return Object.freeze({ version: 1, robotId, limits, topics: Object.freeze(topics) });
}

/** 必須容量を検証する。入力limits map、出力camelCaseの凍結値。例: max_message_bytes:16384 → maxMessageBytes:16384。 */
function parseLimits(value: unknown): BridgeConfig['limits'] {
  const map = record(value, ['max_peers', 'max_message_bytes', 'max_peer_queue_bytes', 'max_channel_buffered_bytes'], 'limits');
  const maxPeers = positive(map.max_peers, 'limits.max_peers', true);
  const maxMessageBytes = positive(map.max_message_bytes, 'limits.max_message_bytes', true);
  const maxPeerQueueBytes = positive(map.max_peer_queue_bytes, 'limits.max_peer_queue_bytes', true);
  // 単一messageさえ収容できない設定は起動時に拒否する。合意上限とのminはtransport側。
  const maxChannelBufferedBytes = positive(map.max_channel_buffered_bytes, 'limits.max_channel_buffered_bytes', true);
  if (maxMessageBytes > 16384 || maxMessageBytes > maxPeerQueueBytes || maxMessageBytes > maxChannelBufferedBytes) {
    throw new ConfigError('limits', 'inconsistent message or buffer limits');
  }
  return Object.freeze({ maxPeers, maxMessageBytes, maxPeerQueueBytes, maxChannelBufferedBytes });
}
