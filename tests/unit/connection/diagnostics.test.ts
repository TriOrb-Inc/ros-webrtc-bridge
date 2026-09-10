import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserConnectionError, BrowserHealthError } from '../../browser/connection.js';
import { connectionFailure, parseContainerState } from '../../connection/diagnostics.js';

test('NET-01 container状態はrunning/exit/OOMだけを保存する', () => {
  assert.deepEqual(parseContainerState('true 0 false\n'), { available: true, running: true, exitCode: 0, oomKilled: false });
  assert.deepEqual(parseContainerState('false 137 true'), { available: true, running: false, exitCode: 137, oomKilled: true });
  for (const value of ['', 'true -1 false', 'true 0 false extra', 'secret']) {
    assert.deepEqual(parseContainerState(value), { available: false });
  }
});

test('NET-01 browser失敗を固定分類し未加工例外を保存しない', () => {
  const health = new BrowserHealthError('deadline', { attempts: 3, firstFailure: 'connection_refused', elapsedMs: 600, timeoutMs: 600 });
  assert.deepEqual(connectionFailure(health), { stage: 'browser_health', reason: 'deadline', attempts: 3,
    firstFailure: 'connection_refused', elapsedMs: 600, timeoutMs: 600, cleanupFailed: false });
  assert.deepEqual(connectionFailure(new BrowserConnectionError('connections', 'string_echo_timeout', undefined, true)),
    { stage: 'browser_connection', reason: 'string_echo_timeout', cleanupFailed: true });
  const raw = connectionFailure(new Error('https://private.invalid credential=secret'));
  assert.deepEqual(raw, { stage: 'connection', reason: 'unknown' });
  assert.equal(JSON.stringify(raw).includes('private.invalid'), false);
  assert.equal(JSON.stringify(raw).includes('secret'), false);
});
