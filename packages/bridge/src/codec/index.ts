import { checkLength, requireValue, scalar } from './scalars.js';
import { codecOptions, record, snapshotSchema } from './schema.js';
import type { Codec, CodecOptions, Field, JsonValue } from './types.js';
export type { Codec, CodecOptions, Field, JsonValue } from './types.js';

/** 検証済みschemaに基づくcodecを作る。入力: {kind:'integer',bits:64,signed:true}。
 * 出力例: codec.encode(42n)==='42', codec.decode('42')===42n。
 * optionsは設定由来の資源上限。違反時はpayloadを含まないTypeErrorを送出する。
 */
export function createCodec(descriptor: Field, overrides: Partial<CodecOptions> = {}): Codec {
  const options = codecOptions(overrides);
  const schema = snapshotSchema(descriptor, options);
  /** 一回の変換に独立したnode budgetを割り当てる。入力: native, true。出力: wire tree。 */
  function convert(input: unknown, encode: boolean): unknown {
    let nodes = 0;
    /** 部分木を再帰変換する。入力: bool,true,0。出力: true。不正時はTypeError。 */
    function visit(field: Field, value: unknown, depth: number): unknown {
      // schemaとpayloadの深さを別々に制限し、循環した入力も有限時間で拒否する。
      requireValue(depth <= options.maxDepth && ++nodes <= options.maxNodes, 'payload complexity');
      if (field.kind === 'array') {
        requireValue(Array.isArray(value), 'array type');
        checkLength(value.length, field, options.maxArrayLength);
        // hole、追加propertyを暗黙に捨てない。各indexの検査でaccessorも拒否する。
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
        // own-propertyを要求し、prototype上のfieldや未知keyへのすり替えを認めない。
        return Object.fromEntries(names.map((name) => {
          requireValue(Object.hasOwn(object, name), 'missing field');
          return [name, visit(field.fields[name]!, object[name], depth + 1)];
        }));
      }
      return scalar(field, value, encode, options);
    }
    return visit(schema, input, 0);
  }
  // JSON型へのcastは全leafとcontainerを検証したencode境界に限定する。
  return {
    /** nativeをwireへ変換する。入力: 42n。出力: '42'（int64 schema）。 */
    encode(native: unknown): JsonValue { return convert(native, true) as JsonValue; },
    /** wireをnativeへ変換する。入力: '42'。出力: 42n（int64 schema）。 */
    decode(wire: unknown): unknown { return convert(wire, false); },
  };
}
