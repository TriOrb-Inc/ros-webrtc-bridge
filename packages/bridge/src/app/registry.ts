import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { parseBridgeConfig, type BridgeConfig } from '../config/index.js';
import { record, string } from '../config/validation.js';
import { createCodec } from '../codec/index.js';
import { descriptorFromRos } from '../ros/descriptor.js';
import type { RosDefinition } from '../ros/types.js';
import type { RouterBinding } from '../router/types.js';

/** YAMLの候補型を抽出して全設定を検証する。入力: YAML、上限bytes。出力: 検証済みconfig。 */
export function inspectConfig(source: string, maxBytes: number): BridgeConfig {
  if (Buffer.byteLength(source) > maxBytes) throw new Error('config_too_large');
  const document = parseDocument(source, { uniqueKeys: true, version: '1.2', schema: 'core' });
  if (document.errors.length || document.warnings.length) throw new Error('invalid_config');
  // 候補型一覧は利用可能性を証明しない。native型loaderへの入力を構文検証するためだけに使う。
  const root = record(document.toJS({ maxAliasCount: 0 }), ['version', 'robot_id', 'limits', 'topics'], '$');
  const topics = record(root.topics, Object.keys(Object(root.topics)), 'topics');
  const availableTypes = Object.values(topics).map((value) => {
    const entry = record(value, Object.keys(Object(value)), 'topic');
    return string(entry.ros_type, /^[A-Za-z][A-Za-z0-9_]*\/msg\/[A-Za-z][A-Za-z0-9_]*$/, 'ros_type');
  });
  return parseBridgeConfig(source, { availableTypes, maxConfigBytes: maxBytes });
}

/** JSON object keyを再帰昇順へ正規化する。入力例: {b:1,a:[2]}。出力: {a:[2],b:1}。 */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      .map(name => [name, canonical((value as Record<string, unknown>)[name])]));
  }
  return value;
}

/** native型を全件解決してcodecとhashを作る。入力: config,型lookup。出力: registry。未対応型は起動失敗。 */
export function createRegistry(config: BridgeConfig, describe: (type: string) => RosDefinition): RouterBinding[] {
  return config.topics.map((binding) => {
    const descriptor = descriptorFromRos(binding.rosType, describe);
    const allowNonFinite = binding.commandGuard === undefined;
    const schema = JSON.stringify(canonical({ codec: 'ros-json-v1', descriptor, allowNonFinite }));
    // command用途は型名から推測せず、明示guardがあるbindingだけで非有限値を禁止する。
    return { binding, codec: createCodec(descriptor, { allowNonFinite }),
      schemaId: `sha256:${createHash('sha256').update(schema).digest('hex')}` };
  });
}
