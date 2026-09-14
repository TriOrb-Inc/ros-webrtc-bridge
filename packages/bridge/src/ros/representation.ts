import { createCodec, type CodecOptions, type Field } from '../codec/index.js';
import { record } from '../codec/schema.js';

/** Normalize native-addon integer and byte representations to the codec contract. Input: descriptor; returns from/to converters. */
export function rosRepresentation(descriptor: Field, options: Partial<CodecOptions> = {}): {
  from(native: unknown): unknown;
  to(native: unknown): unknown;
} {
  const codec = createCodec(descriptor, options);
  const maxArray = options.maxArrayLength ?? 4096;
  const maxBytes = options.maxByteLength ?? 16384;
  const maxNodes = options.maxNodes ?? 32768;
  let visited = 0;
  /** Change representations in a bounded tree. Inputs: int64,1,true; returns 1n. */
  function convert(field: Field, value: unknown, from: boolean): unknown {
    if (++visited > maxNodes) throw new TypeError('native_node_limit');
    if (field.kind === 'integer' && field.bits === 64) {
      // Generated message setters in rclnodejs 2.2.0 require bigint for publishing.
      if (!from) return value as bigint;
      // Accept only safe integers from ref-napi number values; do not hide precision loss.
      if (typeof value === 'number') {
        if (!Number.isSafeInteger(value)) throw new TypeError('unsafe_native_int64');
        return BigInt(value);
      }
      // Subscription values may be bigint or decimal strings depending on the distro and generation method.
      if (typeof value === 'bigint') {
        const scalar = createCodec(field);
        return scalar.decode(scalar.encode(value));
      }
      return createCodec(field).decode(value);
    }
    if (field.kind === 'bytes') {
      if (!from) return Array.from(value as Uint8Array);
      // Validate every uint8 element and decoded length when enableTypedArray=false; do not truncate arrays.
      const bytes = createCodec({ kind: 'array', element: { kind: 'integer', bits: 8, signed: false }, length: field.length, maxLength: field.maxLength }, { maxArrayLength: maxBytes }).encode(value);
      return Uint8Array.from(bytes as number[]);
    }
    if (field.kind === 'array') {
      if (!Array.isArray(value) || value.length > maxArray) throw new TypeError('invalid_native_array');
      if (Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError('invalid_native_array_keys');
      return Array.from({ length: value.length }, (_, index) => {
        const property = Object.getOwnPropertyDescriptor(value, String(index));
        if (!property || !Object.hasOwn(property, 'value')) throw new TypeError('invalid_native_array_property');
        return convert(field.element, property.value, from);
      });
    }
    if (field.kind === 'object') {
      // Retain unknown fields for rejection by the final codec, preventing silent field loss.
      return Object.fromEntries(Object.entries(record(value)).map(([key, item]) => [key, Object.hasOwn(field.fields, key) ? convert(field.fields[key]!, item, from) : item]));
    }
    return value;
  }
  return {
    /** Validate and convert ROS input to bridge-native values. Example: int64=1 returns 1n. */
    from(native) { visited = 0; const value = convert(descriptor, native, true); return codec.decode(codec.encode(value)); },
    /** Validate and convert bridge-native values for the ROS addon. Example: int64=1n returns 1n. */
    to(native) { visited = 0; return convert(descriptor, codec.decode(codec.encode(native)), false); },
  };
}
