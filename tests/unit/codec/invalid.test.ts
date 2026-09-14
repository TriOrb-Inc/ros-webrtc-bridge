import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodec, type CodecOptions, type Field } from '../../../packages/bridge/src/codec/index.js';

/** Verify rejection by both encode and decode. Input: bool,[1]; output: passing or failing assertion. */
function rejectsBoth(field: Field, values: unknown[], options: Partial<CodecOptions> = {}): void {
  const codec = createCodec(field, options);
  // Pass independent boundary inputs directly to each entry point instead of relying on round trips.
  for (const value of values) {
    assert.throws(() => codec.encode(value), TypeError);
    assert.throws(() => codec.decode(value), TypeError);
  }
}

test('TYPE-01 scalar: reject type inference, invalid decimals, and string bound violations', () => {
  rejectsBoth({ kind: 'boolean' }, [0, 1, 'true', null, undefined]);
  rejectsBoth({ kind: 'string', maxLength: 2 }, [1, null, '\u65e5', '\ud800', '\udc00']);
  rejectsBoth({ kind: 'string' }, ['ab'], { maxStringBytes: 1 });
  rejectsBoth({ kind: 'integer', bits: 32, signed: true }, ['1', null, 1.1, NaN, Infinity]);
  // Require canonical decimals: no -0, leading zeros, plus signs, whitespace, or exponents.
  const wide = createCodec({ kind: 'integer', bits: 64, signed: true });
  for (const value of ['', '-0', '00', '+1', ' 1', '1.0', '1e2', 'x', '1'.repeat(21), 1]) {
    assert.throws(() => wide.decode(value), TypeError);
  }
  assert.throws(() => wide.encode(1), /64-bit integer type/);
});

test('TYPE-01 canonical wire: do not absorb trailing newlines or separators into numbers or base64', () => {
  const integer = createCodec({ kind: 'integer', bits: 64, signed: true });
  const bytes = createCodec({ kind: 'bytes' });
  // Require the end anchor to match only the input end without multiline mode; do not defer to permissive BigInt/Buffer conversion.
  for (const ending of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    assert.throws(() => integer.decode(`1${ending}`), /canonical decimal/);
    assert.throws(() => bytes.decode(`AA==${ending}`), /base64 syntax/);
  }
});

test('TYPE-01 float: validate non-finite tag boundaries and command rejection', () => {
  rejectsBoth({ kind: 'float', bits: 64 }, [true, null, {}]);
  rejectsBoth({ kind: 'float', bits: 32 }, [3.5e38, -3.5e38]);
  const telemetry = createCodec({ kind: 'float', bits: 64 });
  assert.equal(telemetry.encode(1.25), 1.25);
  assert.equal(telemetry.decode(-1.25), -1.25);
  // Decode must not treat numbers that overflow during JSON parsing as non-finite tags.
  for (const value of [NaN, Infinity, -Infinity, 'nan', '1']) assert.throws(() => telemetry.decode(value), TypeError);
  const command = createCodec({ kind: 'float', bits: 64 }, { allowNonFinite: false });
  for (const value of [NaN, Infinity, -Infinity]) assert.throws(() => command.encode(value), /non-finite/);
  for (const value of ['NaN', 'Infinity', '-Infinity']) assert.throws(() => command.decode(value), /float tag/);
  assert.equal(command.encode(0), 0);
});

test('TYPE-01 bytes: reject invalid base64, padding bits, and pre/post-decoding limit violations', () => {
  const codec = createCodec({ kind: 'bytes' }, { maxByteLength: 2 });
  assert.throws(() => codec.encode([0, 1]), /byte array type/);
  assert.throws(() => codec.encode(new Uint8Array(3)), /resource length/);
  assert.throws(() => codec.decode(1), /base64 type/);
  // Reject whitespace, URL-safe alphabets, missing/excess padding, and noncanonical padding bits.
  for (const wire of [' a==', '_w==', '/w', '/w===', 'Zh==', 'Zm9=']) assert.throws(() => codec.decode(wire), TypeError);
  assert.throws(() => codec.decode('AAAAAA=='), /encoded byte limit/);
  assert.throws(() => codec.decode('AAAA'), /resource length/);
  assert.throws(() => createCodec({ kind: 'bytes', length: 1 }).decode('AAA='), /fixed length/);
  assert.throws(() => createCodec({ kind: 'bytes', maxLength: 1 }).decode('AAA='), /bounded length/);
  assert.deepEqual(codec.decode('AAA='), new Uint8Array(2));
});

test('TYPE-01 array: reject fixed/bounded length violations, holes, and non-data indexes', () => {
  const array: Field = { kind: 'array', element: { kind: 'boolean' } };
  rejectsBoth(array, [null, {}, 'a', [undefined], new Array(1)]);
  rejectsBoth({ ...array, length: 1 }, [[], [true, false]]);
  rejectsBoth({ ...array, maxLength: 1 }, [[true, false]]);
  rejectsBoth(array, [[true, false]], { maxArrayLength: 1 });
  // Do not silently discard extra properties, symbols, or getters during JSON conversion.
  rejectsBoth(array, [Object.assign([true], { extra: true }), Object.assign([true], { [Symbol()]: true })]);
  const getter = [true];
  Object.defineProperty(getter, '0', { get: () => true });
  rejectsBoth(array, [getter]);
  const replacedHole = new Array(1) as boolean[];
  Object.assign(replacedHole, { extra: true });
  rejectsBoth(array, [replacedHole]);
});

test('TYPE-01 object: reject missing, unknown, prototype, and hidden properties', () => {
  const object: Field = { kind: 'object', fields: { valid: { kind: 'boolean' } } };
  rejectsBoth(object, [null, [], true, {}, { valid: true, extra: 1 }, { extra: true }, new Date()]);
  rejectsBoth(object, [Object.assign(Object.create({ valid: true }) as object, {})]);
  // Do not execute getters or discard symbols even in JavaScript values not obtained from JSON.
  rejectsBoth(object, [Object.assign({ valid: true }, { [Symbol()]: 1 })]);
  rejectsBoth(object, [Object.defineProperty({}, 'valid', { value: true })]);
  rejectsBoth(object, [{ get valid() { throw new Error('must not execute'); } }]);
});

test('SEC-01 payload: reject flat trees exceeding the node budget in both directions', () => {
  const field: Field = { kind: 'array', element: { kind: 'boolean' } };
  const codec = createCodec(field, { maxNodes: 3, maxDepth: 1 });
  assert.deepEqual(codec.decode([true, false]), [true, false]);
  assert.deepEqual(codec.encode([false, true]), [false, true]);
  // The root consumes one node, so three elements of the same schema exceed the budget.
  assert.throws(() => codec.decode([true, true, true]), /payload complexity/);
  assert.throws(() => codec.encode([true, true, true]), /payload complexity/);
});
