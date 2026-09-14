/** The caller supplies explicit ROS type information. No type inference or loading is performed. */
export type Field =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'string'; readonly maxLength?: number }
  | { readonly kind: 'integer'; readonly bits: 8 | 16 | 32 | 64; readonly signed: boolean }
  | { readonly kind: 'float'; readonly bits: 32 | 64 }
  | ({ readonly kind: 'bytes' } & LengthBounds)
  | ({ readonly kind: 'array'; readonly element: Field } & LengthBounds)
  | { readonly kind: 'object'; readonly fields: Readonly<Record<string, Field>> };

/** Fixed and bounded sequence lengths. When both are specified, both must hold. */
export interface LengthBounds {
  readonly length?: number;
  readonly maxLength?: number;
}

/** Codec wire values that can be represented losslessly in JSON. */
export type JsonValue = boolean | string | number | JsonValue[] | { [key: string]: JsonValue };

/** Resource limits overridden by caller configuration. The root has depth zero. */
export interface CodecOptions {
  readonly maxDepth: number;
  readonly maxArrayLength: number;
  readonly maxStringBytes: number;
  readonly maxByteLength: number;
  readonly maxNodes: number;
  readonly allowNonFinite: boolean;
}

/** Accept transport and ROS adapter inputs as unknown; do not trust static input types. */
export interface Codec {
  encode(native: unknown): JsonValue;
  decode(wire: unknown): unknown;
}
