import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodec, type CodecOptions, type Field } from '../../../packages/bridge/src/codec/index.js';

test('CFG-01 codec: reject invalid descriptors at startup', () => {
  const invalid: unknown[] = [null, {}, { kind: 'unknown' }, { kind: 'integer', bits: 7, signed: true },
    { kind: 'integer', bits: 8, signed: 'true' }, { kind: 'float', bits: 16 },
    { kind: 'array', element: null }, { kind: 'object', fields: [] },
  ];
  // Even trusted schemas need minimal checks to catch type assertions or external generator errors.
  for (const value of invalid) assert.throws(() => createCodec(value as Field), TypeError);
  for (const length of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createCodec({ kind: 'bytes', length }), /schema length/);
  }
  assert.throws(() => createCodec({ kind: 'bytes', length: 2, maxLength: 1 }), /schema length conflict/);
  assert.equal(createCodec({ kind: 'bytes', length: 1, maxLength: 1 }).encode(new Uint8Array([0])), 'AA==');
});

test('CFG-01 codec: reject unknown settings and limits that are not positive integers', () => {
  for (const value of [-1, 0, 1.1, NaN, Infinity, '1', undefined]) {
    const options = { maxDepth: value } as Partial<CodecOptions>;
    assert.throws(() => createCodec({ kind: 'boolean' }, options), /positive codec limit/);
  }
  // Do not silently fall back to defaults for typos or non-boolean policies.
  assert.throws(() => createCodec({ kind: 'boolean' }, { typo: 1 } as Partial<CodecOptions>), /unknown codec option/);
  assert.throws(() => createCodec({ kind: 'boolean' }, { allowNonFinite: 1 } as unknown as Partial<CodecOptions>), /non-finite option/);
});

test('SEC-01 codec: reject excessive schema depth, node count, and cycles at startup', () => {
  const nested: Field = { kind: 'array', element: { kind: 'array', element: { kind: 'boolean' } } };
  assert.throws(() => createCodec(nested, { maxDepth: 1 }), /schema complexity/);
  assert.throws(() => createCodec(nested, { maxNodes: 2 }), /schema complexity/);
  assert.deepEqual(createCodec(nested, { maxDepth: 2, maxNodes: 3 }).decode([[true]]), [[true]]);
  // Reject cyclic descriptors at the configured depth before reaching stack overflow.
  const cyclic = { kind: 'array', element: undefined } as unknown as { kind: 'array'; element: Field };
  cyclic.element = cyclic;
  assert.throws(() => createCodec(cyclic, { maxDepth: 4 }), /schema complexity/);
});

test('TYPE-01 codec: isolate the contract from descriptor mutations after factory creation', () => {
  const descriptor: { kind: 'object'; fields: Record<string, Field> } = { kind: 'object', fields: { value: { kind: 'boolean' } } };
  const codec = createCodec(descriptor);
  descriptor.fields.value = { kind: 'string' };
  assert.deepEqual(codec.decode({ value: true }), { value: true });
  assert.throws(() => codec.decode({ value: 'true' }), /boolean type/);
});
