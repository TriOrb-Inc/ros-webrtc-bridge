import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTimeoutMs } from '../../connection/process.js';

test('parseTimeoutMs uses its default and accepts bounded integer overrides', () => {
  assert.equal(parseTimeoutMs(undefined, 1200000, 60000, 1800000), 1200000);
  assert.equal(parseTimeoutMs('60000', 1200000, 60000, 1800000), 60000);
  assert.equal(parseTimeoutMs('1800000', 1200000, 60000, 1800000), 1800000);
});

test('parseTimeoutMs rejects malformed and out-of-range overrides', () => {
  for (const raw of ['0', '-1', '1.5', '60000ms', '59999', '1800001', '9007199254740993']) {
    assert.throws(() => parseTimeoutMs(raw, 1200000, 60000, 1800000), /timeout must/);
  }
});
