import { checkLength, requireValue, scalar } from './scalars.js';
import { codecOptions, record, snapshotSchema } from './schema.js';
import type { Codec, CodecOptions, Field, JsonValue } from './types.js';
export type { Codec, CodecOptions, Field, JsonValue } from './types.js';

/** Create a codec from a validated schema. Example input: {kind:'integer',bits:64,signed:true}.
 * Example output: codec.encode(42n)==='42', codec.decode('42')===42n.
 * Options are configured resource limits. Violations throw TypeError without including the payload.
 */
export function createCodec(descriptor: Field, overrides: Partial<CodecOptions> = {}): Codec {
  const options = codecOptions(overrides);
  const schema = snapshotSchema(descriptor, options);
  /** Allocate an independent node budget for each conversion. Example input: native, true; output: wire tree. */
  function convert(input: unknown, encode: boolean): unknown {
    let nodes = 0;
    /** Recursively convert a subtree. Example input: bool,true,0; output: true. Invalid values throw TypeError. */
    function visit(field: Field, value: unknown, depth: number): unknown {
      // Limit schema and payload depth separately so cyclic inputs also fail in bounded time.
      requireValue(depth <= options.maxDepth && ++nodes <= options.maxNodes, 'payload complexity');
      if (field.kind === 'array') {
        requireValue(Array.isArray(value), 'array type');
        checkLength(value.length, field, options.maxArrayLength);
        // Do not silently discard holes or extra properties. Per-index validation also rejects accessors.
        requireValue(Reflect.ownKeys(value).length === value.length + 1, 'array keys');
        const result: unknown[] = [];
        for (let index = 0; index < value.length; index++) {
          const property = Object.getOwnPropertyDescriptor(value, String(index));
          requireValue(property !== undefined && Object.hasOwn(property, 'value'), 'array data property');
          result.push(visit(field.element, property.value, depth + 1));
        }
        return result;
      }
      if (field.kind === 'object') {
        const object = record(value);
        const names = Object.keys(field.fields);
        requireValue(Object.keys(object).length === names.length, 'object field count');
        // Require own properties; reject substitutions using prototype fields or unknown keys.
        return Object.fromEntries(names.map((name) => {
          requireValue(Object.hasOwn(object, name), 'missing field');
          return [name, visit(field.fields[name]!, object[name], depth + 1)];
        }));
      }
      return scalar(field, value, encode, options);
    }
    return visit(schema, input, 0);
  }
  // Restrict the JSON cast to the encode boundary, after every leaf and container has been validated.
  return {
    /** Convert native values to wire values. Example: 42n becomes '42' for an int64 schema. */
    encode(native: unknown): JsonValue { return convert(native, true) as JsonValue; },
    /** Convert wire values to native values. Example: '42' becomes 42n for an int64 schema. */
    decode(wire: unknown): unknown { return convert(wire, false); },
  };
}
