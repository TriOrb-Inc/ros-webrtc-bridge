import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserConnectionError, BrowserHealthError, captureBrowserFailure, waitBrowserHealth } from '../../browser/connection.js';
import type { BrowserHealthPage, BrowserHealthReport } from '../../browser/types.js';

/** health応答を順番に返すfake。入力例: refused,200、出力: 時計・待機・呼出記録。 */
function fixture(outcomes: unknown[], timeoutMs = 1000) {
  let now = 0;
  const calls: number[] = [], delays: number[] = [];
  const page: BrowserHealthPage = {
    /** URLを保存せず応答を返す。入力URL/timeout、出力HTTP statusまたは例外。 */
    async goto(_url, options) {
      calls.push(options.timeout);
      const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
      if (outcome === null) return null;
      if (typeof outcome === 'number') return { status: () => outcome };
      throw outcome;
    },
  };
  // 実時間を待たず、要求された有限delayだけ単調時計を進める。
  const options = { timeoutMs, clock: () => now, delay: async (milliseconds: number) => { delays.push(milliseconds); now += milliseconds; } };
  return { page, options, calls, delays, advance: (milliseconds: number) => { now += milliseconds; } };
}

/** Chromiumの固定先頭codeを再現する。入力例: ERR_CONNECTION_REFUSED、出力: URL付きの未加工例外。 */
function network(code: string): Error { return new Error(`page.goto: net::${code} at https://private.invalid/health`); }

/** 固定分類・数値だけが公開されることを検証する。入力error/reason/report、出力true。 */
function failure(error: unknown, reason: BrowserHealthError['reason'], health: BrowserHealthReport): boolean {
  assert.ok(error instanceof BrowserHealthError);
  assert.equal(error.reason, reason);
  assert.deepEqual(error.health, health);
  assert.equal(error.message, `browser_e2e_failed:health:${reason}:attempts=${health.attempts}:first=${health.firstFailure}:elapsed_ms=${health.elapsedMs}:timeout_ms=${health.timeoutMs}:cleanup_failed=false`);
  // 元例外、URL、causeをdiagnosticsへ複製しない。
  assert.equal('cause' in error, false);
  assert.equal(JSON.stringify(error).includes('private.invalid'), false);
  return true;
}

test('NET-01 healthが初回200なら再試行せず成功する', async () => {
  const f = fixture([200]);
  assert.deepEqual(await waitBrowserHealth(f.page, 'https://private.invalid/health', f.options),
    { attempts: 1, firstFailure: 'none', elapsedMs: 0, timeoutMs: 1000 });
  assert.deepEqual(f.calls, [1000]); assert.deepEqual(f.delays, []);
});

test('NET-01 refusedからreadyへ遷移した回数と経過時間を残す', async () => {
  const f = fixture([network('ERR_CONNECTION_REFUSED'), 200]);
  assert.deepEqual(await waitBrowserHealth(f.page, 'https://private.invalid/health', f.options),
    { attempts: 2, firstFailure: 'connection_refused', elapsedMs: 250, timeoutMs: 1000 });
  assert.deepEqual(f.calls, [1000, 750]); assert.deepEqual(f.delays, [250]);
});

test('NET-01 allowlist内の異なる一時errorを再試行しても最初の分類を維持する', async () => {
  const f = fixture([network('ERR_CONNECTION_RESET'), network('ERR_ADDRESS_UNREACHABLE'), network('ERR_CONNECTION_REFUSED'), 200]);
  assert.deepEqual(await waitBrowserHealth(f.page, 'https://private.invalid/health', f.options),
    { attempts: 4, firstFailure: 'connection_reset', elapsedMs: 750, timeoutMs: 1000 });
  assert.deepEqual(f.calls, [1000, 750, 500, 250]);
});

test('NET-01 永続refusedは共通deadlineを超えず有限回で失敗する', async () => {
  const f = fixture([network('ERR_CONNECTION_REFUSED')], 600);
  await assert.rejects(waitBrowserHealth(f.page, 'https://private.invalid/health', f.options), error => failure(error, 'deadline',
    { attempts: 3, firstFailure: 'connection_refused', elapsedMs: 600, timeoutMs: 600 }));
  assert.deepEqual(f.calls, [600, 350, 100]); assert.deepEqual(f.delays, [250, 250, 100]);
});

test('NET-01 navigation中に期限へ達した場合は追加試行も遅延成功も許可しない', async () => {
  for (const outcome of [200, network('ERR_CONNECTION_REFUSED')]) {
    const f = fixture([outcome], 100);
    const goto = f.page.goto;
    f.page.goto = async (url, options) => { f.advance(100); return goto(url, options); };
    // 200を受けてもdeadline内の到達確認でなければ失敗する。
    await assert.rejects(waitBrowserHealth(f.page, 'https://private.invalid/health', f.options), error => failure(error, 'deadline',
      { attempts: 1, firstFailure: typeof outcome === 'number' ? 'none' : 'connection_refused', elapsedMs: 100, timeoutMs: 100 }));
    assert.deepEqual(f.delays, []);
  }
});

test('NET-01 HTTP非200とresponse欠落は即失敗し、最初の失敗分類を保持する', async () => {
  for (const status of [503, 401, 204, null]) {
    const f = fixture([status, 200]);
    await assert.rejects(waitBrowserHealth(f.page, 'https://private.invalid/health', f.options), error => failure(error, 'http_status',
      { attempts: 1, firstFailure: 'http_status', elapsedMs: 0, timeoutMs: 1000 }));
    assert.equal(f.calls.length, 1); assert.deepEqual(f.delays, []);
  }
  // 一時error後でもHTTP異常を再試行で隠さない。
  const f = fixture([network('ERR_CONNECTION_REFUSED'), 503, 200]);
  await assert.rejects(waitBrowserHealth(f.page, 'https://private.invalid/health', f.options), error => failure(error, 'http_status',
    { attempts: 2, firstFailure: 'connection_refused', elapsedMs: 250, timeoutMs: 1000 }));
  assert.equal(f.calls.length, 2);
});

test('NET-01 未知・TLS・browser終了・timeoutは再試行せず匿名化する', async () => {
  const timeout = new Error('page.goto: Timeout exceeded at https://private.invalid/health'); timeout.name = 'TimeoutError';
  for (const outcome of [network('ERR_CERT_AUTHORITY_INVALID'), network('ERR_SSL_PROTOCOL_ERROR'), network('ERR_NAME_NOT_RESOLVED'),
    new Error('page.goto: Target page, context or browser has been closed'),
    new Error('page.goto: unrelated at https://private.invalid/ERR_CONNECTION_REFUSED'), 'unknown rejection', timeout]) {
    const f = fixture([outcome, 200]);
    const reason = outcome === timeout ? 'navigation_timeout' : 'unknown_error';
    // allowlist文字列がURLや本文に混入してもnetwork error扱いにしない。
    await assert.rejects(waitBrowserHealth(f.page, 'https://private.invalid/health', f.options), error => failure(error, reason,
      { attempts: 1, firstFailure: reason, elapsedMs: 0, timeoutMs: 1000 }));
    assert.equal(f.calls.length, 1); assert.deepEqual(f.delays, []);
  }
});

test('NET-01 応答しないnavigationも実timerの上限で打ち切る', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture([], 100);
  f.page.goto = () => new Promise(() => {});
  const pending = waitBrowserHealth(f.page, 'https://private.invalid/health', f.options);
  f.advance(100); context.mock.timers.tick(100);
  await assert.rejects(pending, error => failure(error, 'navigation_timeout',
    { attempts: 1, firstFailure: 'navigation_timeout', elapsedMs: 100, timeoutMs: 100 }));
});

test('NET-01 不正timeoutはpage操作前に拒否する', async () => {
  for (const timeoutMs of [0, -1, NaN, Infinity, 600001]) {
    const f = fixture([200], timeoutMs);
    await assert.rejects(waitBrowserHealth(f.page, 'https://private.invalid/health', f.options), /invalid_health_timeout/);
    assert.deepEqual(f.calls, []);
  }
});

test('NET-01 primary health失敗をcleanup失敗より優先して両方を保持する', () => {
  const health: BrowserHealthReport = { attempts: 2, firstFailure: 'connection_refused', elapsedMs: 250, timeoutMs: 1000 };
  const captured = captureBrowserFailure(new BrowserHealthError('deadline', health), 'cleanup', undefined, true);
  assert.ok(captured instanceof BrowserHealthError);
  assert.equal(captured.reason, 'deadline'); assert.deepEqual(captured.health, health); assert.equal(captured.cleanupFailed, true);
  assert.match(captured.message, /^browser_e2e_failed:health:deadline:.*:cleanup_failed=true$/);
});

test('NET-01 health回復後のscenario失敗にもhealth診断を保持する', () => {
  const health: BrowserHealthReport = { attempts: 2, firstFailure: 'connection_reset', elapsedMs: 250, timeoutMs: 1000 };
  const captured = captureBrowserFailure(new Error('raw URL must not survive'), 'connections:string_echo_timeout', health, false);
  assert.ok(captured instanceof BrowserConnectionError);
  assert.equal(captured.phase, 'connections'); assert.equal(captured.reason, 'string_echo_timeout');
  assert.deepEqual(captured.health, health); assert.equal(captured.cleanupFailed, false);
  assert.equal(captured.message.includes('raw URL'), false);
});
