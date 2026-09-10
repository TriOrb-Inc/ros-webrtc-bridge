/** 正の安全整数上限を検証する。入力例: (4)、出力例: 正常終了。@param value 上限 @returns なし */
export function positiveLimit(value: number): void {
  // byte数と件数を誤差なく加減算できる範囲だけを設定として許可する。
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('invalid_limit');
}

/** 識別子を検証する。入力例: ('session-1')、出力例: 正常終了。@param value 識別子 @returns なし */
export function identifier(value: string): void {
  // 空白や制御文字を含む識別子を境界で拒否する。
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(value)) throw new Error('invalid_identifier');
}

/** canonical uint64を得る。入力例: ('42')、出力例: 42n。@param value decimal文字列 @returns uint64 */
export function sequence(value: string): bigint {
  // 桁数を先に制限し、大きすぎる文字列をBigIntへ渡さない。
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)) throw new Error('invalid_sequence');
  const result = BigInt(value);
  if (result > 18446744073709551615n) throw new Error('invalid_sequence');
  return result;
}
