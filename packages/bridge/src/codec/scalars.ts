import { Buffer } from 'node:buffer';
import type { CodecOptions, Field, LengthBounds } from './types.js';

/** Turn validation failures into exceptions without payloads. Example: false, 'type' throws TypeError. */
export function requireValue(condition: boolean, reason: string): asserts condition {
  // Avoid disclosing types or values and let callers handle failures uniformly.
  if (!condition) throw new TypeError(`Invalid codec value: ${reason}`);
}

/** Validate schema and resource limits together. Example input: 2,{length:2},4; returns void. */
export function checkLength(size: number, field: LengthBounds, limit: number): void {
  // Check actual length against independent fixed-length, bounded-length, and overall limits.
  requireValue(size <= limit, 'resource length limit');
  requireValue(field.length === undefined || size === field.length, 'fixed length');
  requireValue(field.maxLength === undefined || size <= field.maxLength, 'bounded length');
}

/** Convert integers according to the schema. Example: int64, '42', decode returns 42n. */
function integer(field: Extract<Field, { kind: 'integer' }>, value: unknown, encode: boolean): number | string | bigint {
  // Reject number inputs for 64-bit integers before precision can be lost.
  let parsed: bigint;
  if (field.bits === 64) {
    if (encode) {
      requireValue(typeof value === 'bigint', '64-bit integer type');
      parsed = value;
    } else {
      // Limit input to at most 20 digits before creating BigInt, preventing oversized decimal inputs.
      requireValue(typeof value === 'string' && value.length <= 20, '64-bit decimal length');
      requireValue(/^(0|-?[1-9][0-9]*)$/.test(value), 'canonical decimal');
      parsed = BigInt(value);
    }
  } else {
    // For integers of 32 bits or less, accept only integral JSON numbers; do not infer numeric strings.
    requireValue(typeof value === 'number' && Number.isInteger(value), 'integer type');
    parsed = BigInt(value);
  }
  // Use BigInt for exact comparisons against signed and unsigned ROS integer ranges.
  const width = BigInt(field.bits);
  const minimum = field.signed ? -(1n << (width - 1n)) : 0n;
  const maximum = field.signed ? (1n << (width - 1n)) - 1n : (1n << width) - 1n;
  requireValue(parsed >= minimum && parsed <= maximum, 'integer range');
  // Stringify only encoded 64-bit integers so bigint never reaches JSON.stringify.
  if (field.bits !== 64) return Number(parsed);
  return encode ? parsed.toString() : parsed;
}

/** Handle nonfinite values only within float fields. Example: float32, 'NaN', decode returns NaN. */
function floating(field: Extract<Field, { kind: 'float' }>, value: unknown, encode: boolean, allow: boolean): number | string {
  // Nonfinite numbers are not JSON values; accept only tagged strings on the wire.
  if (!encode && typeof value === 'string') {
    requireValue(allow && ['NaN', 'Infinity', '-Infinity'].includes(value), 'float tag');
    return Number(value);
  }
  requireValue(typeof value === 'number', 'float type');
  if (!Number.isFinite(value)) {
    // With command policy allowNonFinite=false, reject nonfinite values during both encoding and decoding.
    requireValue(encode && allow, 'non-finite float');
    return String(value);
  }
  // Return rounded float32 values. Do not replace overflow from a finite input with a tag.
  const result = field.bits === 32 ? Math.fround(value) : value;
  requireValue(Number.isFinite(result), 'float32 overflow');
  return result;
}

/** Convert uint8 sequences to canonical base64. Example: bytes, Uint8Array([255]), encode returns '/w=='. */
function bytes(field: Extract<Field, { kind: 'bytes' }>, value: unknown, encode: boolean, limit: number): string | Uint8Array {
  if (encode) {
    // Copy the result so it survives reuse of the input buffer by the ROS adapter.
    requireValue(value instanceof Uint8Array, 'byte array type');
    checkLength(value.byteLength, field, limit);
    return Buffer.from(value).toString('base64');
  }
  // Check length before decoding to prevent oversized allocations. Empty sequences are valid base64.
  requireValue(typeof value === 'string', 'base64 type');
  requireValue(value.length <= 4 * Math.ceil(limit / 3), 'encoded byte limit');
  requireValue(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), 'base64 syntax');
  const decoded = Buffer.from(value, 'base64');
  // Require a unique representation, including unused padding bits; do not rely on permissive Node decoding.
  requireValue(decoded.toString('base64') === value, 'canonical base64');
  checkLength(decoded.length, field, limit);
  return new Uint8Array(decoded);
}

/** Validate and convert scalar fields in both directions. Example: string,'00123',decode returns '00123'. */
export function scalar(field: Exclude<Field, { kind: 'object' | 'array' }>, value: unknown, encode: boolean, options: CodecOptions): unknown {
  switch (field.kind) {
    case 'boolean':
      // Do not infer booleans from JSON truthiness or numbers.
      requireValue(typeof value === 'boolean', 'boolean type');
      return value;
    case 'string':
      // ROS string bounds count UTF-8 bytes, not JavaScript UTF-16 code units.
      requireValue(typeof value === 'string', 'string type');
      requireValue(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value), 'unpaired surrogate');
      checkLength(Buffer.byteLength(value, 'utf8'), field, options.maxStringBytes);
      return value;
    case 'integer': return integer(field, value, encode);
    // Float and byte fields have special wire representations and use dedicated handlers.
    case 'float': return floating(field, value, encode, options.allowNonFinite);
    case 'bytes': return bytes(field, value, encode, options.maxByteLength);
  }
}
