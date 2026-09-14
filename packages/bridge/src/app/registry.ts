import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { parseBridgeConfig, type BridgeConfig } from '../config/index.js';
import { record, string } from '../config/validation.js';
import { createCodec } from '../codec/index.js';
import { descriptorFromRos } from '../ros/descriptor.js';
import type { RosDefinition } from '../ros/types.js';
import type { RouterBinding } from '../router/types.js';

/** Extract candidate types from YAML and validate all configuration. Inputs: YAML, byte limit. Returns validated config. */
export function inspectConfig(source: string, maxBytes: number): BridgeConfig {
  if (Buffer.byteLength(source) > maxBytes) throw new Error('config_too_large');
  const document = parseDocument(source, { uniqueKeys: true, version: '1.2', schema: 'core' });
  if (document.errors.length || document.warnings.length) throw new Error('invalid_config');
  // Candidate type names do not prove availability; they only provide syntax-validated input to the native type loader.
  const root = record(document.toJS({ maxAliasCount: 0 }), ['version', 'robot_id', 'limits', 'topics'], '$');
  const topics = record(root.topics, Object.keys(Object(root.topics)), 'topics');
  const availableTypes = Object.values(topics).map((value) => {
    const entry = record(value, Object.keys(Object(value)), 'topic');
    return string(entry.ros_type, /^[A-Za-z][A-Za-z0-9_]*\/msg\/[A-Za-z][A-Za-z0-9_]*$/, 'ros_type');
  });
  return parseBridgeConfig(source, { availableTypes, maxConfigBytes: maxBytes });
}

/** Recursively sort JSON object keys. Example: {b:1,a:[2]} becomes {a:[2],b:1}. */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      .map(name => [name, canonical((value as Record<string, unknown>)[name])]));
  }
  return value;
}

/** Resolve every native type and create codecs and hashes. Inputs: config, type lookup. Returns a registry; unsupported types fail startup. */
export function createRegistry(config: BridgeConfig, describe: (type: string) => RosDefinition): RouterBinding[] {
  return config.topics.map((binding) => {
    const descriptor = descriptorFromRos(binding.rosType, describe);
    const allowNonFinite = binding.commandGuard === undefined;
    const schema = JSON.stringify(canonical({ codec: 'ros-json-v1', descriptor, allowNonFinite }));
    // Do not infer command usage from type names. Reject nonfinite values only for bindings with an explicit guard.
    return { binding, codec: createCodec(descriptor, { allowNonFinite }),
      schemaId: `sha256:${createHash('sha256').update(schema).digest('hex')}` };
  });
}
