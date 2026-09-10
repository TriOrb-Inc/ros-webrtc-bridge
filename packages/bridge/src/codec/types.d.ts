/** ROSの型情報を呼び出し側が明示する。自動推論や型ロードは行わない。 */
export type Field =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'string'; readonly maxLength?: number }
  | { readonly kind: 'integer'; readonly bits: 8 | 16 | 32 | 64; readonly signed: boolean }
  | { readonly kind: 'float'; readonly bits: 32 | 64 }
  | ({ readonly kind: 'bytes' } & LengthBounds)
  | ({ readonly kind: 'array'; readonly element: Field } & LengthBounds)
  | { readonly kind: 'object'; readonly fields: Readonly<Record<string, Field>> };

/** 固定長とbounded sequenceの長さ。両方指定したときも両方を満たす。 */
export interface LengthBounds {
  readonly length?: number;
  readonly maxLength?: number;
}

/** JSONへ損失なく出力できるcodecのwire値。 */
export type JsonValue = boolean | string | number | JsonValue[] | { [key: string]: JsonValue };

/** 呼び出し側の設定から上書きする資源上限。rootのdepthは0とする。 */
export interface CodecOptions {
  readonly maxDepth: number;
  readonly maxArrayLength: number;
  readonly maxStringBytes: number;
  readonly maxByteLength: number;
  readonly maxNodes: number;
  readonly allowNonFinite: boolean;
}

/** transportやROS adapterからの入力は型付けを信用せずunknownで受け取る。 */
export interface Codec {
  encode(native: unknown): JsonValue;
  decode(wire: unknown): unknown;
}
