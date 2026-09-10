import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodec, type CodecOptions, type Field } from '../../../packages/bridge/src/codec/index.js';

test('CFG-01 codec: 不正descriptorは起動時に拒否する', () => {
  const invalid: unknown[] = [null, {}, { kind: 'unknown' }, { kind: 'integer', bits: 7, signed: true },
    { kind: 'integer', bits: 8, signed: 'true' }, { kind: 'float', bits: 16 },
    { kind: 'array', element: null }, { kind: 'object', fields: [] },
  ];
  // trusted schemaにも、type assertionや外部生成器の誤りを発見する最低限の検証を置く。
  for (const value of invalid) assert.throws(() => createCodec(value as Field), TypeError);
  for (const length of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createCodec({ kind: 'bytes', length }), /schema length/);
  }
  assert.throws(() => createCodec({ kind: 'bytes', length: 2, maxLength: 1 }), /schema length conflict/);
  assert.equal(createCodec({ kind: 'bytes', length: 1, maxLength: 1 }).encode(new Uint8Array([0])), 'AA==');
});

test('CFG-01 codec: 未知設定・非正整数上限を拒否する', () => {
  for (const value of [-1, 0, 1.1, NaN, Infinity, '1', undefined]) {
    const options = { maxDepth: value } as Partial<CodecOptions>;
    assert.throws(() => createCodec({ kind: 'boolean' }, options), /positive codec limit/);
  }
  // typoとboolean以外のpolicyを黙って既定値へfallbackしない。
  assert.throws(() => createCodec({ kind: 'boolean' }, { typo: 1 } as Partial<CodecOptions>), /unknown codec option/);
  assert.throws(() => createCodec({ kind: 'boolean' }, { allowNonFinite: 1 } as unknown as Partial<CodecOptions>), /non-finite option/);
});

test('SEC-01 codec: schema深さ・総node数・循環を起動時に拒否する', () => {
  const nested: Field = { kind: 'array', element: { kind: 'array', element: { kind: 'boolean' } } };
  assert.throws(() => createCodec(nested, { maxDepth: 1 }), /schema complexity/);
  assert.throws(() => createCodec(nested, { maxNodes: 2 }), /schema complexity/);
  assert.deepEqual(createCodec(nested, { maxDepth: 2, maxNodes: 3 }).decode([[true]]), [[true]]);
  // 循環descriptorはstack overflowまで辿らず設定した深さで拒否する。
  const cyclic = { kind: 'array', element: undefined } as unknown as { kind: 'array'; element: Field };
  cyclic.element = cyclic;
  assert.throws(() => createCodec(cyclic, { maxDepth: 4 }), /schema complexity/);
});

test('TYPE-01 codec: factory後のdescriptor変更から契約を隔離する', () => {
  const descriptor: { kind: 'object'; fields: Record<string, Field> } = { kind: 'object', fields: { value: { kind: 'boolean' } } };
  const codec = createCodec(descriptor);
  descriptor.fields.value = { kind: 'string' };
  assert.deepEqual(codec.decode({ value: true }), { value: true });
  assert.throws(() => codec.decode({ value: 'true' }), /boolean type/);
});
