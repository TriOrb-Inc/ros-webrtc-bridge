import assert from 'node:assert/strict';
import test from 'node:test';
import { descriptorFromRos } from '../../../packages/bridge/src/ros/descriptor.js';
import { rosRepresentation } from '../../../packages/bridge/src/ros/representation.js';
import { field } from './fixtures.js';

test('TYPE-01 ROS descriptor: 明示metadataからprimitive/nested/arrayを生成する', () => {
  const descriptor = descriptorFromRos('test/msg/All', (name) => ({ fields: name === 'test/msg/Child' ? [field('flag', 'bool')] : [
    field('text', 'string'), field('bounded', 'string', { stringUpperBound: 3 }), field('f32', 'float32'), field('f64', 'float64'),
    field('i8', 'int8'), field('u16', 'uint16'), field('raw', 'uint8', { isArray: true, isFixedSizeArray: true, arraySize: 2 }),
    field('values', 'int32', { isArray: true, isUpperBound: true, arraySize: 3 }), field('unbounded', 'uint32', { isArray: true }),
    field('child', 'Child', { isPrimitiveType: false, pkgName: 'test' }),
  ] }));
  // primitive値は独立した固定descriptorで照合する。
  assert.deepEqual(descriptor, { kind: 'object', fields: {
    text: { kind: 'string' }, bounded: { kind: 'string', maxLength: 3 }, f32: { kind: 'float', bits: 32 }, f64: { kind: 'float', bits: 64 },
    i8: { kind: 'integer', bits: 8, signed: true }, u16: { kind: 'integer', bits: 16, signed: false }, raw: { kind: 'bytes', length: 2 },
    values: { kind: 'array', element: { kind: 'integer', bits: 32, signed: true }, maxLength: 3 },
    unbounded: { kind: 'array', element: { kind: 'integer', bits: 32, signed: false } }, child: { kind: 'object', fields: { flag: { kind: 'boolean' } } },
  } });
});

test('CFG-01 ROS descriptor: 未対応型・循環・深さ・不正metadataを拒否する', () => {
  assert.throws(() => descriptorFromRos('x', () => ({ fields: [] }), 0), /invalid_schema_depth/);
  assert.throws(() => descriptorFromRos('x', () => ({ fields: [field('x', 'wstring')] })), /unsupported/);
  assert.throws(() => descriptorFromRos('x', () => ({ fields: [field('x', 'bool'), field('x', 'bool')] })), /duplicate/);
  // nested再帰の循環と単純なdepth超過を別々に再現する。
  assert.throws(() => descriptorFromRos('a/msg/T', () => ({ fields: [field('x', 'T', { isPrimitiveType: false, pkgName: 'a' })] })), /recursive/);
  let count = 0;
  assert.throws(() => descriptorFromRos('x', () => ({ fields: [field('x', String(++count), { isPrimitiveType: false, pkgName: 'a' })] }), 1), /recursive/);
});

test('TYPE-01 ROS representation: ref-napi整数/bytesとbridge nativeの値を独立検証する', () => {
  const descriptor = descriptorFromRos('test/msg/T', () => ({ fields: [field('i', 'int64'), field('u', 'uint64'),
    field('data', 'uint8', { isArray: true }), field('values', 'int64', { isArray: true }), field('label', 'string')] }));
  const codec = rosRepresentation(descriptor);
  assert.deepEqual(codec.from({ i: -1, u: 18446744073709551615n, data: [0, 255], values: [0, '9223372036854775807'], label: '00123' }),
    { i: -1n, u: 18446744073709551615n, data: new Uint8Array([0, 255]), values: [0n, 9223372036854775807n], label: '00123' });
  // publish先はbigint、uint8は通常array。通常stringはそのまま保持する。
  assert.deepEqual(codec.to({ i: -2n, u: 3n, data: new Uint8Array([1, 2]), values: [4n], label: '00123' }),
    { i: -2n, u: 3n, data: [1, 2], values: [4n], label: '00123' });
  assert.throws(() => rosRepresentation({ kind: 'integer', bits: 64, signed: true }).from(Number.MAX_SAFE_INTEGER + 1), /unsafe/);
  assert.throws(() => rosRepresentation({ kind: 'bytes' }).from([256]), /range/);
  assert.throws(() => codec.from({ extra: true }), /field count/);
});

test('SEC-01 ROS representation: treeの不正形状とallocation上限を拒否する', () => {
  const descriptor = { kind: 'array', element: { kind: 'boolean' } } as const;
  const codec = rosRepresentation(descriptor, { maxArrayLength: 2, maxNodes: 2 });
  assert.throws(() => codec.from({}), /invalid_native_array/);
  assert.throws(() => codec.from([true, false, true]), /invalid_native_array/);
  assert.throws(() => codec.from([true, false]), /native_node_limit/);
  // getter・hole・余分なpropertyを捨てずに拒否する。
  assert.throws(() => codec.from(Object.assign([true], { extra: 1 })), /array_keys/);
  const getter = Object.defineProperty([true], '0', { get() { throw new Error('must not run'); } });
  assert.throws(() => codec.from(getter), /array_property/);
  assert.throws(() => codec.from(Object.assign(new Array(1), { extra: 1 })), /array_property/);
});
