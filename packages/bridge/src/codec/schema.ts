import { requireValue } from './scalars.js';
import type { CodecOptions, Field, LengthBounds } from './types.js';

/** Validate and return a plain object. Example: {x:1} returns the same object; invalid inputs throw TypeError. */
export function record(value: unknown): Record<string, unknown> {
  requireValue(typeof value === 'object' && value !== null && !Array.isArray(value), 'object type');
  // The ROS adapter is responsible for normalizing class instances to plain objects.
  const prototype: unknown = Object.getPrototypeOf(value);
  requireValue(prototype === Object.prototype || prototype === null, 'object prototype');
  for (const key of Reflect.ownKeys(value)) {
    // Do not silently discard symbols, nonenumerable values, or getters/setters absent from JSON.
    requireValue(typeof key === 'string', 'symbol key');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    requireValue(descriptor.enumerable === true && Object.hasOwn(descriptor, 'value'), 'object data property');
  }
  return value as Record<string, unknown>;
}

/** Validate and copy optional array length constraints. Example: {length:2} returns {length:2}. */
function lengths(field: LengthBounds): LengthBounds {
  const result: { length?: number; maxLength?: number } = {};
  for (const key of ['length', 'maxLength'] as const) {
    // Zero is a valid fixed-array length. Huge integers, fractions, and negative values are invalid schemas.
    const value = field[key];
    if (value === undefined) continue;
    requireValue(Number.isSafeInteger(value) && value >= 0, 'schema length');
    result[key] = value;
  }
  // Reject contradictory schemas before receiving individual payloads.
  requireValue(result.length === undefined || result.maxLength === undefined || result.length <= result.maxLength, 'schema length conflict');
  return result;
}

/** Validate options and merge defaults. Example: {maxDepth:8} returns all options with maxDepth=8. */
export function codecOptions(overrides: Partial<CodecOptions>): CodecOptions {
  const defaults: CodecOptions = {
    // Envelope byte limits belong to the transport. This limit bounds local resources in the decoded tree.
    maxDepth: 32, maxArrayLength: 4096, maxStringBytes: 16384,
    maxByteLength: 16384, maxNodes: 32768, allowNonFinite: true,
  };
  const options = { ...defaults, ...record(overrides) };
  for (const key of Object.keys(options)) {
    // Reject unknown options so typos cannot silently disable tuning values.
    requireValue(Object.hasOwn(defaults, key), 'unknown codec option');
    const value = options[key as keyof CodecOptions];
    if (key === 'allowNonFinite') requireValue(typeof value === 'boolean', 'non-finite option');
    else requireValue(typeof value === 'number' && Number.isSafeInteger(value) && value > 0, 'positive codec limit');
  }
  return options as CodecOptions;
}

/** Validate a descriptor at startup and create an independent snapshot. Example: {kind:'boolean'} returns a copy. */
export function snapshotSchema(input: Field, options: CodecOptions): Field {
  let nodes = 0;
  /** Clone a subtree with bounded depth. Example input: bool,0; output: bool descriptor. */
  function visit(field: Field, depth: number): Field {
    requireValue(depth <= options.maxDepth && ++nodes <= options.maxNodes, 'schema complexity');
    record(field);
    switch (field.kind) {
      case 'boolean': return { kind: 'boolean' };
      case 'string':
        // Use the same nonnegative integer bounds for strings, consistently measured in UTF-8 bytes.
        return { kind: 'string', ...lengths(field) };
      case 'integer':
        requireValue([8, 16, 32, 64].includes(field.bits) && typeof field.signed === 'boolean', 'integer schema');
        return { kind: 'integer', bits: field.bits, signed: field.signed };
      case 'float':
        // Do not expose schemas with ambiguous float widths.
        requireValue(field.bits === 32 || field.bits === 64, 'float schema');
        return { kind: 'float', bits: field.bits };
      case 'bytes': return { kind: 'bytes', ...lengths(field) };
      case 'array':
        return { kind: 'array', ...lengths(field), element: visit(field.element, depth + 1) };
      case 'object': {
        // Object.fromEntries preserves __proto__ as an ordinary own property.
        const fields = record(field.fields);
        return { kind: 'object', fields: Object.fromEntries(Object.entries(fields).map(([key, child]) => [key, visit(child as Field, depth + 1)])) };
      }
      default: throw new TypeError('Invalid codec value: unknown schema kind');
    }
  }
  return visit(input, 0);
}
