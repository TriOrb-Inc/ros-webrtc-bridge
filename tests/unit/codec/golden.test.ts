import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodec, type Field } from '../../../packages/bridge/src/codec/index.js';

// TYPE-01: derive fixture expectations directly from the wire specification, not codec results.
const schema: Field = { kind: 'object', fields: {
  enabled: { kind: 'boolean' }, text: { kind: 'string', maxLength: 12 },
  signed: { kind: 'integer', bits: 64, signed: true }, unsigned: { kind: 'integer', bits: 64, signed: false },
  // Specify ROS Time/Duration structures and uint8 arrays explicitly without inference.
  stamp: { kind: 'object', fields: { sec: { kind: 'integer', bits: 32, signed: true }, nanosec: { kind: 'integer', bits: 32, signed: false } } },
  data: { kind: 'bytes', maxLength: 4 }, samples: { kind: 'array', length: 3, element: { kind: 'float', bits: 64 } },
  nested: { kind: 'array', maxLength: 2, element: { kind: 'array', element: { kind: 'float', bits: 32 } } },
} };

test('TYPE-01 encode: convert ROS native golden values into fixed wire expectations', () => {
  const result = createCodec(schema).encode({
    enabled: true, text: '00123\u65e5\u672c', signed: -9223372036854775808n, unsigned: 18446744073709551615n,
    stamp: { sec: -1, nanosec: 999999999 }, data: new Uint8Array([0, 127, 128, 255]),
    samples: [NaN, Infinity, -Infinity], nested: [[0.1], []],
  });
  // Specify float32 expectations as constants rounded according to IEEE 754.
  assert.deepEqual(result, {
    enabled: true, text: '00123\u65e5\u672c', signed: '-9223372036854775808', unsigned: '18446744073709551615',
    stamp: { sec: -1, nanosec: 999999999 }, data: 'AH+A/w==',
    samples: ['NaN', 'Infinity', '-Infinity'], nested: [[0.10000000149011612], []],
  });
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('TYPE-01 decode: obtain fixed native values from wire golden data without using encode', () => {
  const result = createCodec(schema).decode({
    enabled: false, text: '00123\u65e5\u672c', signed: '9223372036854775807', unsigned: '0',
    stamp: { sec: -2147483648, nanosec: 4294967295 }, data: 'AAECAw==',
    samples: ['NaN', 'Infinity', '-Infinity'], nested: [[0.1], []],
  });
  // Compare ordinary strings, 64-bit values, Time, and bytes against independent expectations.
  assert.deepEqual(result, {
    enabled: false, text: '00123\u65e5\u672c', signed: 9223372036854775807n, unsigned: 0n,
    stamp: { sec: -2147483648, nanosec: 4294967295 }, data: new Uint8Array([0, 1, 2, 3]),
    samples: [NaN, Infinity, -Infinity], nested: [[0.10000000149011612], []],
  });
});

test('TYPE-01 integer: validate minima and maxima for all widths and signs in both directions', () => {
  for (const bits of [8, 16, 32, 64] as const) {
    for (const signed of [true, false]) {
      const codec = createCodec({ kind: 'integer', bits, signed });
      // Derive test ranges using exponentiation rather than sharing the implementation's bit shifts.
      const minimum = signed ? -(2n ** BigInt(bits - 1)) : 0n;
      const maximum = 2n ** BigInt(signed ? bits - 1 : bits) - 1n;
      for (const value of [minimum, maximum]) {
        const native = bits === 64 ? value : Number(value);
        const wire = bits === 64 ? String(value) : Number(value);
        assert.equal(codec.encode(native), wire);
        assert.equal(codec.decode(wire), native);
      }
      // Test just-outside values with the same type to avoid accidental success from type errors.
      for (const value of [minimum - 1n, maximum + 1n]) {
        assert.throws(() => codec.encode(bits === 64 ? value : Number(value)), /integer range/);
        assert.throws(() => codec.decode(bits === 64 ? String(value) : Number(value)), /integer range/);
      }
    }
  }
});

test('TYPE-01 preserve empty values, UTF-8, buffer copies, and special field names', () => {
  const empty = createCodec({ kind: 'bytes', length: 0 });
  assert.equal(empty.encode(new Uint8Array()), '');
  assert.deepEqual(empty.decode(''), new Uint8Array());
  // Accept three-byte and four-byte UTF-8 characters within their bounds.
  assert.equal(createCodec({ kind: 'string', maxLength: 3 }).decode('\u65e5'), '\u65e5');
  assert.equal(createCodec({ kind: 'string', maxLength: 4 }).encode('😀'), '😀');
  const data = new Uint8Array([255]);
  const wire = createCodec({ kind: 'bytes', length: 1 }).encode(data);
  data[0] = 0;
  assert.equal(wire, '/w==');
  // Treat __proto__ as an ordinary own key without prototype pollution.
  const unusual = createCodec({ kind: 'object', fields: JSON.parse('{"__proto__":{"kind":"boolean"}}') as Record<string, Field> });
  assert.deepEqual(unusual.decode(JSON.parse('{"__proto__":true}')), JSON.parse('{"__proto__":true}'));
  assert.deepEqual(createCodec({ kind: 'object', fields: {} }).decode(Object.create(null)), {});
});
