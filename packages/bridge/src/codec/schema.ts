import { requireValue } from './scalars.js';
import type { CodecOptions, Field, LengthBounds } from './types.js';

/** plain objectを検証して返す。入力: {x:1}。出力: 同じobject。不正時はTypeError。 */
export function record(value: unknown): Record<string, unknown> {
  requireValue(typeof value === 'object' && value !== null && !Array.isArray(value), 'object type');
  // ROS adapterはclass instanceをplain objectへ正規化する責務を持つ。
  const prototype: unknown = Object.getPrototypeOf(value);
  requireValue(prototype === Object.prototype || prototype === null, 'object prototype');
  for (const key of Reflect.ownKeys(value)) {
    // JSONに現れないsymbol、非列挙値、getter/setterを暗黙に捨てない。
    requireValue(typeof key === 'string', 'symbol key');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    requireValue(descriptor.enumerable === true && Object.hasOwn(descriptor, 'value'), 'object data property');
  }
  return value as Record<string, unknown>;
}

/** optionalな配列長制約を検証してコピーする。入力: {length:2}。出力: {length:2}。 */
function lengths(field: LengthBounds): LengthBounds {
  const result: { length?: number; maxLength?: number } = {};
  for (const key of ['length', 'maxLength'] as const) {
    // 0長は空固定配列として有効。巨大整数・小数・負値はschemaの不備とする。
    const value = field[key];
    if (value === undefined) continue;
    requireValue(Number.isSafeInteger(value) && value >= 0, 'schema length');
    result[key] = value;
  }
  // 矛盾したschemaを、個々のpayloadを受け取る前に拒否する。
  requireValue(result.length === undefined || result.maxLength === undefined || result.length <= result.maxLength, 'schema length conflict');
  return result;
}

/** 設定を検証しdefaultと合成する。入力: {maxDepth:8}。出力: maxDepth=8の全設定。 */
export function codecOptions(overrides: Partial<CodecOptions>): CodecOptions {
  const defaults: CodecOptions = {
    // envelope byte上限はtransport責務。この上限はdecoded treeの局所資源を制限する。
    maxDepth: 32, maxArrayLength: 4096, maxStringBytes: 16384,
    maxByteLength: 16384, maxNodes: 32768, allowNonFinite: true,
  };
  const options = { ...defaults, ...record(overrides) };
  for (const key of Object.keys(options)) {
    // typoで調整値が黙って無効にならないよう未知設定も拒否する。
    requireValue(Object.hasOwn(defaults, key), 'unknown codec option');
    const value = options[key as keyof CodecOptions];
    if (key === 'allowNonFinite') requireValue(typeof value === 'boolean', 'non-finite option');
    else requireValue(typeof value === 'number' && Number.isSafeInteger(value) && value > 0, 'positive codec limit');
  }
  return options as CodecOptions;
}

/** descriptorを起動時検証して独立snapshotにする。入力: {kind:'boolean'}。出力: コピー。 */
export function snapshotSchema(input: Field, options: CodecOptions): Field {
  let nodes = 0;
  /** subtreeを有限深さで複製する。入力: bool,0。出力: bool descriptor。 */
  function visit(field: Field, depth: number): Field {
    requireValue(depth <= options.maxDepth && ++nodes <= options.maxNodes, 'schema complexity');
    record(field);
    switch (field.kind) {
      case 'boolean': return { kind: 'boolean' };
      case 'string':
        // 文字列にも同じ非負整数boundを使い、単位はUTF-8 bytesに統一する。
        return { kind: 'string', ...lengths(field) };
      case 'integer':
        requireValue([8, 16, 32, 64].includes(field.bits) && typeof field.signed === 'boolean', 'integer schema');
        return { kind: 'integer', bits: field.bits, signed: field.signed };
      case 'float':
        // floatのwidthが曖昧なschemaは公開しない。
        requireValue(field.bits === 32 || field.bits === 64, 'float schema');
        return { kind: 'float', bits: field.bits };
      case 'bytes': return { kind: 'bytes', ...lengths(field) };
      case 'array':
        return { kind: 'array', ...lengths(field), element: visit(field.element, depth + 1) };
      case 'object': {
        // Object.fromEntriesで__proto__も通常のown propertyとして保持する。
        const fields = record(field.fields);
        return { kind: 'object', fields: Object.fromEntries(Object.entries(fields).map(([key, child]) => [key, visit(child as Field, depth + 1)])) };
      }
      default: throw new TypeError('Invalid codec value: unknown schema kind');
    }
  }
  return visit(input, 0);
}
