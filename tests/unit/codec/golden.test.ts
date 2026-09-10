import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodec, type Field } from '../../../packages/bridge/src/codec/index.js';

// TYPE-01: fixtureの期待値はcodec呼出し結果を流用せず、wire仕様から直接記載する。
const schema: Field = { kind: 'object', fields: {
  enabled: { kind: 'boolean' }, text: { kind: 'string', maxLength: 12 },
  signed: { kind: 'integer', bits: 64, signed: true }, unsigned: { kind: 'integer', bits: 64, signed: false },
  // ROS Time/Durationの構造とuint8配列を、推論なしで明示する。
  stamp: { kind: 'object', fields: { sec: { kind: 'integer', bits: 32, signed: true }, nanosec: { kind: 'integer', bits: 32, signed: false } } },
  data: { kind: 'bytes', maxLength: 4 }, samples: { kind: 'array', length: 3, element: { kind: 'float', bits: 64 } },
  nested: { kind: 'array', maxLength: 2, element: { kind: 'array', element: { kind: 'float', bits: 32 } } },
} };

test('TYPE-01 encode: ROS native goldenをwire仕様の固定値へ変換する', () => {
  const result = createCodec(schema).encode({
    enabled: true, text: '00123日本', signed: -9223372036854775808n, unsigned: 18446744073709551615n,
    stamp: { sec: -1, nanosec: 999999999 }, data: new Uint8Array([0, 127, 128, 255]),
    samples: [NaN, Infinity, -Infinity], nested: [[0.1], []],
  });
  // float32の期待値はIEEE 754の丸め結果を定数で明示する。
  assert.deepEqual(result, {
    enabled: true, text: '00123日本', signed: '-9223372036854775808', unsigned: '18446744073709551615',
    stamp: { sec: -1, nanosec: 999999999 }, data: 'AH+A/w==',
    samples: ['NaN', 'Infinity', '-Infinity'], nested: [[0.10000000149011612], []],
  });
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('TYPE-01 decode: encodeを使わずwire goldenからnativeの固定値を得る', () => {
  const result = createCodec(schema).decode({
    enabled: false, text: '00123日本', signed: '9223372036854775807', unsigned: '0',
    stamp: { sec: -2147483648, nanosec: 4294967295 }, data: 'AAECAw==',
    samples: ['NaN', 'Infinity', '-Infinity'], nested: [[0.1], []],
  });
  // 通常のstring、64bit、Time、byte列の期待値をそれぞれ独立に比較する。
  assert.deepEqual(result, {
    enabled: false, text: '00123日本', signed: 9223372036854775807n, unsigned: 0n,
    stamp: { sec: -2147483648, nanosec: 4294967295 }, data: new Uint8Array([0, 1, 2, 3]),
    samples: [NaN, Infinity, -Infinity], nested: [[0.10000000149011612], []],
  });
});

test('TYPE-01 integer: 全width/signedの最小最大を両方向で検証する', () => {
  for (const bits of [8, 16, 32, 64] as const) {
    for (const signed of [true, false]) {
      const codec = createCodec({ kind: 'integer', bits, signed });
      // テスト側は指数計算で範囲を定め、実装のbit shiftを共有しない。
      const minimum = signed ? -(2n ** BigInt(bits - 1)) : 0n;
      const maximum = 2n ** BigInt(signed ? bits - 1 : bits) - 1n;
      for (const value of [minimum, maximum]) {
        const native = bits === 64 ? value : Number(value);
        const wire = bits === 64 ? String(value) : Number(value);
        assert.equal(codec.encode(native), wire);
        assert.equal(codec.decode(wire), native);
      }
      // 範囲直外も同じ型で与え、type errorによる偶然の成功を避ける。
      for (const value of [minimum - 1n, maximum + 1n]) {
        assert.throws(() => codec.encode(bits === 64 ? value : Number(value)), /integer range/);
        assert.throws(() => codec.decode(bits === 64 ? String(value) : Number(value)), /integer range/);
      }
    }
  }
});

test('TYPE-01 empty/UTF-8/bufferコピー/特殊field名を保持する', () => {
  const empty = createCodec({ kind: 'bytes', length: 0 });
  assert.equal(empty.encode(new Uint8Array()), '');
  assert.deepEqual(empty.decode(''), new Uint8Array());
  // UTF-8の3byte文字と4byte文字をbound内で受理する。
  assert.equal(createCodec({ kind: 'string', maxLength: 3 }).decode('日'), '日');
  assert.equal(createCodec({ kind: 'string', maxLength: 4 }).encode('😀'), '😀');
  const data = new Uint8Array([255]);
  const wire = createCodec({ kind: 'bytes', length: 1 }).encode(data);
  data[0] = 0;
  assert.equal(wire, '/w==');
  // __proto__も普通のown keyとし、prototype汚染を起こさない。
  const unusual = createCodec({ kind: 'object', fields: JSON.parse('{"__proto__":{"kind":"boolean"}}') as Record<string, Field> });
  assert.deepEqual(unusual.decode(JSON.parse('{"__proto__":true}')), JSON.parse('{"__proto__":true}'));
  assert.deepEqual(createCodec({ kind: 'object', fields: {} }).decode(Object.create(null)), {});
});
