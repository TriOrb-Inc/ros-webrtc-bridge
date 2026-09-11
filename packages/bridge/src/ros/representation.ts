import { createCodec, type CodecOptions, type Field } from '../codec/index.js';
import { record } from '../codec/schema.js';

/** native addon特有の整数/byte表現をcodec契約へ揃える。入力: descriptor。出力: from/to変換器。 */
export function rosRepresentation(descriptor: Field, options: Partial<CodecOptions> = {}): {
  from(native: unknown): unknown;
  to(native: unknown): unknown;
} {
  const codec = createCodec(descriptor, options);
  const maxArray = options.maxArrayLength ?? 4096;
  const maxBytes = options.maxByteLength ?? 16384;
  const maxNodes = options.maxNodes ?? 32768;
  let visited = 0;
  /** 有界のtreeで表現だけ変更する。入力: int64,1,true。出力: 1n。 */
  function convert(field: Field, value: unknown, from: boolean): unknown {
    if (++visited > maxNodes) throw new TypeError('native_node_limit');
    if (field.kind === 'integer' && field.bits === 64) {
      // rclnodejs 2.2.0の生成message setterはpublish時にbigintを要求する。
      if (!from) return value as bigint;
      // ref-napiが返すnumberはsafe integerだけを受理し、精度損失を隠さない。
      if (typeof value === 'number') {
        if (!Number.isSafeInteger(value)) throw new TypeError('unsafe_native_int64');
        return BigInt(value);
      }
      // distro/生成方式によってsubscription値はbigintまたはdecimal stringになる。
      if (typeof value === 'bigint') {
        const scalar = createCodec(field);
        return scalar.decode(scalar.encode(value));
      }
      return createCodec(field).decode(value);
    }
    if (field.kind === 'bytes') {
      if (!from) return Array.from(value as Uint8Array);
      // enableTypedArray=falseのuint8配列を切り詰めず、全要素と復号後長を検証する。
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
      // 未知fieldを残して最終codecに拒否させ、暗黙のfield落ちを防止する。
      return Object.fromEntries(Object.entries(record(value)).map(([key, item]) => [key, Object.hasOwn(field.fields, key) ? convert(field.fields[key]!, item, from) : item]));
    }
    return value;
  }
  return {
    /** ROS入力をbridge nativeへ検証変換。入力: int64=1。出力: 1n。 */
    from(native) { visited = 0; const value = convert(descriptor, native, true); return codec.decode(codec.encode(value)); },
    /** bridge nativeをROS addonへ検証変換。入力: int64=1n。出力: 1n。 */
    to(native) { visited = 0; return convert(descriptor, codec.decode(codec.encode(native)), false); },
  };
}
