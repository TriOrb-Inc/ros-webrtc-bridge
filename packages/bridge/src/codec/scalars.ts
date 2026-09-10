import { Buffer } from 'node:buffer';
import type { CodecOptions, Field, LengthBounds } from './types.js';

/** 検証不一致をpayloadを含まない例外にする。入力: false, 'type'。出力: TypeError。 */
export function requireValue(condition: boolean, reason: string): asserts condition {
  // 型・値の流出を防ぎ、呼び出し側が失敗を一律に扱えるようにする。
  if (!condition) throw new TypeError(`Invalid codec value: ${reason}`);
}

/** schemaと資源上限を同時に検証する。入力: 2,{length:2},4。出力: void。 */
export function checkLength(size: number, field: LengthBounds, limit: number): void {
  // 実際の長さを、固定長・bounded・全体上限の独立した条件で判定する。
  requireValue(size <= limit, 'resource length limit');
  requireValue(field.length === undefined || size === field.length, 'fixed length');
  requireValue(field.maxLength === undefined || size <= field.maxLength, 'bounded length');
}

/** 整数をschemaどおり変換する。入力: int64, '42', decode。出力: 42n。 */
function integer(field: Extract<Field, { kind: 'integer' }>, value: unknown, encode: boolean): number | string | bigint {
  // 64bitはnumberを受け付けず、精度を失う前に境界で拒否する。
  let parsed: bigint;
  if (field.bits === 64) {
    if (encode) {
      requireValue(typeof value === 'bigint', '64-bit integer type');
      parsed = value;
    } else {
      // 最大20桁の範囲に絞ってからBigIntを生成し、巨大decimal入力を抑える。
      requireValue(typeof value === 'string' && value.length <= 20, '64-bit decimal length');
      requireValue(/^(0|-?[1-9][0-9]*)$/.test(value), 'canonical decimal');
      parsed = BigInt(value);
    }
  } else {
    // 32bit以下はJSON numberの整数だけを許容し、数値文字列を推論しない。
    requireValue(typeof value === 'number' && Number.isInteger(value), 'integer type');
    parsed = BigInt(value);
  }
  // signed/unsignedそれぞれのROS整数範囲をBigIntで厳密に比較する。
  const width = BigInt(field.bits);
  const minimum = field.signed ? -(1n << (width - 1n)) : 0n;
  const maximum = field.signed ? (1n << (width - 1n)) - 1n : (1n << width) - 1n;
  requireValue(parsed >= minimum && parsed <= maximum, 'integer range');
  // bigintをJSON.stringifyへ渡さないためencodeの64bitだけ文字列化する。
  if (field.bits !== 64) return Number(parsed);
  return encode ? parsed.toString() : parsed;
}

/** 非有限値はfloat field内だけで扱う。入力: float32, 'NaN', decode。出力: NaN。 */
function floating(field: Extract<Field, { kind: 'float' }>, value: unknown, encode: boolean, allow: boolean): number | string {
  // wire上で非有限numberはJSONではないためタグ文字列だけを許容する。
  if (!encode && typeof value === 'string') {
    requireValue(allow && ['NaN', 'Infinity', '-Infinity'].includes(value), 'float tag');
    return Number(value);
  }
  requireValue(typeof value === 'number', 'float type');
  if (!Number.isFinite(value)) {
    // command向けallowNonFinite=falseではencode/decode両方で拒否する。
    requireValue(encode && allow, 'non-finite float');
    return String(value);
  }
  // float32は丸めた値を返す。有限入力がoverflowする場合はタグに置き換えない。
  const result = field.bits === 32 ? Math.fround(value) : value;
  requireValue(Number.isFinite(result), 'float32 overflow');
  return result;
}

/** uint8列を正規base64に変換する。入力: bytes, Uint8Array([255]), encode。出力: '/w=='。 */
function bytes(field: Extract<Field, { kind: 'bytes' }>, value: unknown, encode: boolean, limit: number): string | Uint8Array {
  if (encode) {
    // 変換結果はコピーし、ROS adapterが入力bufferを再利用しても値を保持する。
    requireValue(value instanceof Uint8Array, 'byte array type');
    checkLength(value.byteLength, field, limit);
    return Buffer.from(value).toString('base64');
  }
  // 復号前の長さ検査で過大なallocationを防ぐ。空列は正当なbase64とする。
  requireValue(typeof value === 'string', 'base64 type');
  requireValue(value.length <= 4 * Math.ceil(limit / 3), 'encoded byte limit');
  requireValue(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), 'base64 syntax');
  const decoded = Buffer.from(value, 'base64');
  // paddingの未使用bitも含め一意表現を要求し、Nodeの寛容な復号に依存しない。
  requireValue(decoded.toString('base64') === value, 'canonical base64');
  checkLength(decoded.length, field, limit);
  return new Uint8Array(decoded);
}

/** scalar fieldを双方向に検証・変換する。入力: string,'00123',decode。出力: '00123'。 */
export function scalar(field: Exclude<Field, { kind: 'object' | 'array' }>, value: unknown, encode: boolean, options: CodecOptions): unknown {
  switch (field.kind) {
    case 'boolean':
      // JSONのtruthy/falsyや数値をboolとして推論しない。
      requireValue(typeof value === 'boolean', 'boolean type');
      return value;
    case 'string':
      // ROS stringのboundはUTF-8 byte数。JS UTF-16 code unit数では数えない。
      requireValue(typeof value === 'string', 'string type');
      requireValue(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value), 'unpaired surrogate');
      checkLength(Buffer.byteLength(value, 'utf8'), field, options.maxStringBytes);
      return value;
    case 'integer': return integer(field, value, encode);
    // floatとbytesはwireに特別な表現を持つため専用処理へ分離する。
    case 'float': return floating(field, value, encode, options.allowNonFinite);
    case 'bytes': return bytes(field, value, encode, options.maxByteLength);
  }
}
