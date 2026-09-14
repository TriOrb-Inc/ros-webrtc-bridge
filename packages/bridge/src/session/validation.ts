/** Validate a positive safe-integer limit. Input: limit, e.g. 4; returns void on success. */
export function positiveLimit(value: number): void {
  // Allow only ranges supporting exact addition and subtraction of byte and item counts.
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('invalid_limit');
}

/** Validate an identifier. Input: identifier, e.g. 'session-1'; returns void on success. */
export function identifier(value: string): void {
  // Reject identifiers containing whitespace or control characters at the boundary.
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(value)) throw new Error('invalid_identifier');
}

/** Parse canonical uint64. Input: decimal string, e.g. '42'; returns 42n. */
export function sequence(value: string): bigint {
  // Limit digit count before passing oversized strings to BigInt.
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)) throw new Error('invalid_sequence');
  const result = BigInt(value);
  if (result > 18446744073709551615n) throw new Error('invalid_sequence');
  return result;
}
