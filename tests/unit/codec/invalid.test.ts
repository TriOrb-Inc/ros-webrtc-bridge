import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodec, type CodecOptions, type Field } from '../../../packages/bridge/src/codec/index.js';

/** encode/decode両方の拒否を検証する。入力: bool,[1]。出力: assertion成功または失敗。 */
function rejectsBoth(field: Field, values: unknown[], options: Partial<CodecOptions> = {}): void {
  const codec = createCodec(field, options);
  // 往復試験ではなく、独立した境界入力を各入口へ直接与える。
  for (const value of values) {
    assert.throws(() => codec.encode(value), TypeError);
    assert.throws(() => codec.decode(value), TypeError);
  }
}

test('TYPE-01 scalar: 型推論・不正decimal・文字列boundを拒否する', () => {
  rejectsBoth({ kind: 'boolean' }, [0, 1, 'true', null, undefined]);
  rejectsBoth({ kind: 'string', maxLength: 2 }, [1, null, '日', '\ud800', '\udc00']);
  rejectsBoth({ kind: 'string' }, ['ab'], { maxStringBytes: 1 });
  rejectsBoth({ kind: 'integer', bits: 32, signed: true }, ['1', null, 1.1, NaN, Infinity]);
  // decimalはcanonical表現に限る。-0、leading zero、+記号、空白、指数を禁止する。
  const wide = createCodec({ kind: 'integer', bits: 64, signed: true });
  for (const value of ['', '-0', '00', '+1', ' 1', '1.0', '1e2', 'x', '1'.repeat(21), 1]) {
    assert.throws(() => wide.decode(value), TypeError);
  }
  assert.throws(() => wide.encode(1), /64-bit integer type/);
});

test('TYPE-01 canonical wire: 末尾の改行・区切り文字を数値やbase64へ取り込まない', () => {
  const integer = createCodec({ kind: 'integer', bits: 64, signed: true });
  const bytes = createCodec({ kind: 'bytes' });
  // multilineなしの末尾anchorは入力末尾のみ。JSのBigInt/Bufferの寛容な変換へ渡さない。
  for (const ending of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    assert.throws(() => integer.decode(`1${ending}`), /canonical decimal/);
    assert.throws(() => bytes.decode(`AA==${ending}`), /base64 syntax/);
  }
});

test('TYPE-01 float: 非有限tagの境界とcommand拒否を検証する', () => {
  rejectsBoth({ kind: 'float', bits: 64 }, [true, null, {}]);
  rejectsBoth({ kind: 'float', bits: 32 }, [3.5e38, -3.5e38]);
  const telemetry = createCodec({ kind: 'float', bits: 64 });
  assert.equal(telemetry.encode(1.25), 1.25);
  assert.equal(telemetry.decode(-1.25), -1.25);
  // JSON parseでoverflowしたnumberもdecodeでは非有限tagとして扱わない。
  for (const value of [NaN, Infinity, -Infinity, 'nan', '1']) assert.throws(() => telemetry.decode(value), TypeError);
  const command = createCodec({ kind: 'float', bits: 64 }, { allowNonFinite: false });
  for (const value of [NaN, Infinity, -Infinity]) assert.throws(() => command.encode(value), /non-finite/);
  for (const value of ['NaN', 'Infinity', '-Infinity']) assert.throws(() => command.decode(value), /float tag/);
  assert.equal(command.encode(0), 0);
});

test('TYPE-01 bytes: 不正base64、padding bits、復号前後の上限を拒否する', () => {
  const codec = createCodec({ kind: 'bytes' }, { maxByteLength: 2 });
  assert.throws(() => codec.encode([0, 1]), /byte array type/);
  assert.throws(() => codec.encode(new Uint8Array(3)), /resource length/);
  assert.throws(() => codec.decode(1), /base64 type/);
  // 空白、URL-safe alphabet、padding省略、過剰padding、非canonical pad bitsを拒否する。
  for (const wire of [' a==', '_w==', '/w', '/w===', 'Zh==', 'Zm9=']) assert.throws(() => codec.decode(wire), TypeError);
  assert.throws(() => codec.decode('AAAAAA=='), /encoded byte limit/);
  assert.throws(() => codec.decode('AAAA'), /resource length/);
  assert.throws(() => createCodec({ kind: 'bytes', length: 1 }).decode('AAA='), /fixed length/);
  assert.throws(() => createCodec({ kind: 'bytes', maxLength: 1 }).decode('AAA='), /bounded length/);
  assert.deepEqual(codec.decode('AAA='), new Uint8Array(2));
});

test('TYPE-01 array: 固定長・bounded・hole・非data indexを拒否する', () => {
  const array: Field = { kind: 'array', element: { kind: 'boolean' } };
  rejectsBoth(array, [null, {}, 'a', [undefined], new Array(1)]);
  rejectsBoth({ ...array, length: 1 }, [[], [true, false]]);
  rejectsBoth({ ...array, maxLength: 1 }, [[true, false]]);
  rejectsBoth(array, [[true, false]], { maxArrayLength: 1 });
  // 追加property・symbol・getterを無視してJSON化することを禁止する。
  rejectsBoth(array, [Object.assign([true], { extra: true }), Object.assign([true], { [Symbol()]: true })]);
  const getter = [true];
  Object.defineProperty(getter, '0', { get: () => true });
  rejectsBoth(array, [getter]);
  const replacedHole = new Array(1) as boolean[];
  Object.assign(replacedHole, { extra: true });
  rejectsBoth(array, [replacedHole]);
});

test('TYPE-01 object: 欠落・未知・prototype・隠れたpropertyを拒否する', () => {
  const object: Field = { kind: 'object', fields: { valid: { kind: 'boolean' } } };
  rejectsBoth(object, [null, [], true, {}, { valid: true, extra: 1 }, { extra: true }, new Date()]);
  rejectsBoth(object, [Object.assign(Object.create({ valid: true }) as object, {})]);
  // JSONから来ないJS値でもgetter実行やsymbol破棄を許さない。
  rejectsBoth(object, [Object.assign({ valid: true }, { [Symbol()]: 1 })]);
  rejectsBoth(object, [Object.defineProperty({}, 'valid', { value: true })]);
  rejectsBoth(object, [{ get valid() { throw new Error('must not execute'); } }]);
});

test('SEC-01 payload: node budgetを超えるflat treeを両方向で拒否する', () => {
  const field: Field = { kind: 'array', element: { kind: 'boolean' } };
  const codec = createCodec(field, { maxNodes: 3, maxDepth: 1 });
  assert.deepEqual(codec.decode([true, false]), [true, false]);
  assert.deepEqual(codec.encode([false, true]), [false, true]);
  // rootが1nodeを消費するため、同じschemaの3要素はbudget外となる。
  assert.throws(() => codec.decode([true, true, true]), /payload complexity/);
  assert.throws(() => codec.encode([true, true, true]), /payload complexity/);
});
