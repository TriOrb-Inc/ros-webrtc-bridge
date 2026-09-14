import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserConnectionError, BrowserHealthError, captureBrowserFailure, waitBrowserHealth } from '../../browser/connection.js';
import type { BrowserHealthPage, BrowserHealthReport } from '../../browser/types.js';

/** Fake sequential health responses. Example input: refused,200; output: clock, waits, and call records. */
function fixture(outcomes: unknown[], timeoutMs = 1000) {
  let now = 0;
  const calls: number[] = [], delays: number[] = [];
  const page: BrowserHealthPage = {
    /** Return a response without storing the URL. Inputs: URL/timeout; output: HTTP status or exception. */
    async goto(_url, options) {
      calls.push(options.timeout);
      const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
      if (outcome === null) return null;
      if (typeof outcome === 'number') return { status: () => outcome };
      throw outcome;
    },
  };
  // Advance the monotonic clock by the requested finite delay without waiting in real time.
  const options = { timeoutMs, clock: () => now, delay: async (milliseconds: number) => { delays.push(milliseconds); now += milliseconds; } };
  return { page, options, calls, delays, advance: (milliseconds: number) => { now += milliseconds; } };
}

/** Reproduce Chromium's fixed leading error code. Example input: ERR_CONNECTION_REFUSED; output: raw exception containing a URL. */
function network(code: string): Error { return new Error(`page.goto: net::${code} at https://private.invalid/health`); }

/** Verify that only fixed classifications and numbers are public. Inputs: error/reason/report; output: true. */
function failure(error: unknown, reason: BrowserHealthError['reason'], health: BrowserHealthReport): boolean {
  assert.ok(error instanceof BrowserHealthError);
  assert.equal(error.reason, reason);
  assert.deepEqual(error.health, health);
  assert.equal(error.message, `browser_e2e_failed:health:${reason}:attempts=${health.attempts}:first=${health.firstFailure}:elapsed_ms=${health.elapsedMs}:timeout_ms=${health.timeoutMs}:cleanup_failed=false`);
  // Do not copy original exceptions, URLs, or causes into diagnostics.
  assert.equal('cause' in error, false);
  assert.equal(JSON.stringify(error).includes('private.invalid'), false);
  return true;
}

test('NET-01 succeed without retries when the first health response is 200', async () => {
  const f = fixture([200]);
  assert.deepEqual(await waitBrowserHealth(f.page, 'https://private.invalid/health', f.options),
    { attempts: 1, firstFailure: 'none', elapsedMs: 0, timeoutMs: 1000 });
  assert.deepEqual(f.calls, [1000]); assert.deepEqual(f.delays, []);
});

test('NET-01 retain attempt counts and elapsed time when transitioning from refused to ready', async () => {
  const f = fixture([network('ERR_CONNECTION_REFUSED'), 200]);
  assert.deepEqual(await waitBrowserHealth(f.page, 'https://private.invalid/health', f.options),
    { attempts: 2, firstFailure: 'connection_refused', elapsedMs: 250, timeoutMs: 1000 });
  assert.deepEqual(f.calls, [1000, 750]); assert.deepEqual(f.delays, [250]);
});

test('NET-01 retain the first classification across retries of different allowlisted transient errors', async () => {
  const f = fixture([network('ERR_CONNECTION_RESET'), network('ERR_ADDRESS_UNREACHABLE'), network('ERR_CONNECTION_REFUSED'), 200]);
  assert.deepEqual(await waitBrowserHealth(f.page, 'https://private.invalid/health', f.options),
    { attempts: 4, firstFailure: 'connection_reset', elapsedMs: 750, timeoutMs: 1000 });
  assert.deepEqual(f.calls, [1000, 750, 500, 250]);
});

test('NET-01 fail persistent refusals after finite attempts within the shared deadline', async () => {
  const f = fixture([network('ERR_CONNECTION_REFUSED')], 600);
  await assert.rejects(waitBrowserHealth(f.page, 'https://private.invalid/health', f.options), error => failure(error, 'deadline',
    { attempts: 3, firstFailure: 'connection_refused', elapsedMs: 600, timeoutMs: 600 }));
  assert.deepEqual(f.calls, [600, 350, 100]); assert.deepEqual(f.delays, [250, 250, 100]);
});

test('NET-01 allow neither another attempt nor late success when navigation reaches the deadline', async () => {
  for (const outcome of [200, network('ERR_CONNECTION_REFUSED')]) {
    const f = fixture([outcome], 100);
    const goto = f.page.goto;
    f.page.goto = async (url, options) => { f.advance(100); return goto(url, options); };
    // Even a 200 response fails unless readiness was confirmed within the deadline.
    await assert.rejects(waitBrowserHealth(f.page, 'https://private.invalid/health', f.options), error => failure(error, 'deadline',
      { attempts: 1, firstFailure: typeof outcome === 'number' ? 'none' : 'connection_refused', elapsedMs: 100, timeoutMs: 100 }));
    assert.deepEqual(f.delays, []);
  }
});

test('NET-01 fail immediately on non-200 HTTP or missing responses and retain the first failure classification', async () => {
  for (const status of [503, 401, 204, null]) {
    const f = fixture([status, 200]);
    await assert.rejects(waitBrowserHealth(f.page, 'https://private.invalid/health', f.options), error => failure(error, 'http_status',
      { attempts: 1, firstFailure: 'http_status', elapsedMs: 0, timeoutMs: 1000 }));
    assert.equal(f.calls.length, 1); assert.deepEqual(f.delays, []);
  }
  // Do not hide HTTP failures with retries even after a transient error.
  const f = fixture([network('ERR_CONNECTION_REFUSED'), 503, 200]);
  await assert.rejects(waitBrowserHealth(f.page, 'https://private.invalid/health', f.options), error => failure(error, 'http_status',
    { attempts: 2, firstFailure: 'connection_refused', elapsedMs: 250, timeoutMs: 1000 }));
  assert.equal(f.calls.length, 2);
});

test('NET-01 anonymize unknown, TLS, browser-closure, and timeout failures without retrying', async () => {
  const timeout = new Error('page.goto: Timeout exceeded at https://private.invalid/health'); timeout.name = 'TimeoutError';
  for (const outcome of [network('ERR_CERT_AUTHORITY_INVALID'), network('ERR_SSL_PROTOCOL_ERROR'), network('ERR_NAME_NOT_RESOLVED'),
    new Error('page.goto: Target page, context or browser has been closed'),
    new Error('page.goto: unrelated at https://private.invalid/ERR_CONNECTION_REFUSED'), 'unknown rejection', timeout]) {
    const f = fixture([outcome, 200]);
    const reason = outcome === timeout ? 'navigation_timeout' : 'unknown_error';
    // Allowlisted text inside a URL or body does not make it a network error.
    await assert.rejects(waitBrowserHealth(f.page, 'https://private.invalid/health', f.options), error => failure(error, reason,
      { attempts: 1, firstFailure: reason, elapsedMs: 0, timeoutMs: 1000 }));
    assert.equal(f.calls.length, 1); assert.deepEqual(f.delays, []);
  }
});

test('NET-01 terminate unresponsive navigation at the real timer limit', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture([], 100);
  f.page.goto = () => new Promise(() => {});
  const pending = waitBrowserHealth(f.page, 'https://private.invalid/health', f.options);
  f.advance(100); context.mock.timers.tick(100);
  await assert.rejects(pending, error => failure(error, 'navigation_timeout',
    { attempts: 1, firstFailure: 'navigation_timeout', elapsedMs: 100, timeoutMs: 100 }));
});

test('NET-01 reject invalid timeouts before operating on the page', async () => {
  for (const timeoutMs of [0, -1, NaN, Infinity, 600001]) {
    const f = fixture([200], timeoutMs);
    await assert.rejects(waitBrowserHealth(f.page, 'https://private.invalid/health', f.options), /invalid_health_timeout/);
    assert.deepEqual(f.calls, []);
  }
});

test('NET-01 prioritize the primary health failure over cleanup failure while retaining both', () => {
  const health: BrowserHealthReport = { attempts: 2, firstFailure: 'connection_refused', elapsedMs: 250, timeoutMs: 1000 };
  const captured = captureBrowserFailure(new BrowserHealthError('deadline', health), 'cleanup', undefined, true);
  assert.ok(captured instanceof BrowserHealthError);
  assert.equal(captured.reason, 'deadline'); assert.deepEqual(captured.health, health); assert.equal(captured.cleanupFailed, true);
  assert.match(captured.message, /^browser_e2e_failed:health:deadline:.*:cleanup_failed=true$/);
});

test('NET-01 retain health diagnostics for scenario failures after health recovery', () => {
  const health: BrowserHealthReport = { attempts: 2, firstFailure: 'connection_reset', elapsedMs: 250, timeoutMs: 1000 };
  const captured = captureBrowserFailure(new Error('raw URL must not survive'), 'connections:string_echo_timeout', health, false);
  assert.ok(captured instanceof BrowserConnectionError);
  assert.equal(captured.phase, 'connections'); assert.equal(captured.reason, 'string_echo_timeout');
  assert.deepEqual(captured.health, health); assert.equal(captured.cleanupFailed, false);
  assert.equal(captured.message.includes('raw URL'), false);
});
