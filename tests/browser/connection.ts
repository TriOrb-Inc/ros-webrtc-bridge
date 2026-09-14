import { chromium, type BrowserServer } from 'playwright-core';
import { browserScenario } from './scenario.js';
import type { BrowserConnectionOptions, BrowserConnectionPhase, BrowserConnectionReport, BrowserHealthFailure, BrowserHealthOptions,
  BrowserHealthPage, BrowserHealthReport } from './types.js';
export type { BrowserConnectionOptions, BrowserConnectionReport } from './types.js';

/** Bound an asynchronous operation. Inputs: action and timeoutMs, e.g. (promise,3000); returns its result. */
async function bounded<T>(action: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('browser_stage_timeout')), Math.max(1, timeoutMs)); });
  try { return await Promise.race([action, timeout]); }
  finally { clearTimeout(timer!); }
}

/** Keep only fixed browser-failure classifications and anonymized diagnostics, never original exceptions or URLs. */
export class BrowserConnectionError extends Error {
  /** Inputs: fixed phase/reason and anonymized diagnostics; returns an exception safe to store. */
  constructor(readonly phase: BrowserConnectionPhase, readonly reason: string,
    readonly health: BrowserHealthReport | undefined, readonly cleanupFailed = false) {
    const healthText = health === undefined ? ''
      : `:attempts=${health.attempts}:first=${health.firstFailure}:elapsed_ms=${health.elapsedMs}:timeout_ms=${health.timeoutMs}`;
    super(`browser_e2e_failed:${phase}:${reason}${healthText}:cleanup_failed=${cleanupFailed}`);
  }
}

/** Typed fixed classifications specific to health checks. */
export class BrowserHealthError extends BrowserConnectionError {
  constructor(reason: BrowserHealthFailure | 'deadline', health: BrowserHealthReport, cleanupFailed = false) {
    super('health', reason, health, cleanupFailed);
  }
}

/** Preserve the primary failure alongside cleanup results. Inputs: fixed phase/health; returns an anonymized Error. */
export function captureBrowserFailure(error: unknown, phase: string, health: BrowserHealthReport | undefined,
  cleanupFailed: boolean): BrowserConnectionError {
  if (error instanceof BrowserConnectionError) {
    if (error instanceof BrowserHealthError) return new BrowserHealthError(error.reason as BrowserHealthFailure | 'deadline', error.health!, error.cleanupFailed || cleanupFailed);
    return new BrowserConnectionError(error.phase, error.reason, error.health, error.cleanupFailed || cleanupFailed);
  }
  const match = /^(launch|health|connections|cleanup)(?::([a-z0-9_]+))?$/.exec(phase);
  const fixedPhase = (match?.[1] ?? 'connections') as BrowserConnectionPhase;
  return new BrowserConnectionError(fixedPhase, match?.[2] ?? 'unknown', health, cleanupFailed);
}

/** Convert navigation exceptions to fixed classifications. Input: raw exception; returns e.g. connection_refused. */
function healthFailure(error: unknown): BrowserHealthFailure {
  if (!(error instanceof Error)) return 'unknown_error';
  // Inspect only Chromium's leading error code; never use URLs or call-log strings for allowlist matching.
  const code = /^page\.goto: net::([A-Z_]+)(?: at |$)/.exec(error.message)?.[1];
  if (code === 'ERR_CONNECTION_REFUSED') return 'connection_refused';
  if (code === 'ERR_CONNECTION_RESET') return 'connection_reset';
  if (code === 'ERR_ADDRESS_UNREACHABLE') return 'address_unreachable';
  // Do not hide timeouts, TLS failures, or browser termination through retries.
  return error.name === 'TimeoutError' || error.message === 'browser_stage_timeout' ? 'navigation_timeout' : 'unknown_error';
}

/** Poll only health with a finite limit. Inputs: fake page/URL/clock; returns attempts, first failure, elapsed ms. Excludes the scenario. */
export async function waitBrowserHealth(page: BrowserHealthPage, url: string, options: BrowserHealthOptions): Promise<BrowserHealthReport> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 600000) throw new Error('invalid_health_timeout');
  const clock = options.clock ?? (() => performance.now());
  const delay = options.delay ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  // Keep the deadline anchored to the initial start time; do not extend it on retries.
  const started = clock(), expires = started + options.timeoutMs;
  let attempts = 0, firstFailure: BrowserHealthReport['firstFailure'] = 'none';
  /** Capture elapsed clock time in an anonymized report. No input; returns e.g. attempts=2, elapsedMs=250. */
  const report = (): BrowserHealthReport => Object.freeze({ attempts, firstFailure,
    elapsedMs: Math.max(0, Math.round(clock() - started)), timeoutMs: Math.ceil(options.timeoutMs) });
  for (;;) {
    const remaining = expires - clock();
    if (remaining <= 0) throw new BrowserHealthError('deadline', report());
    // Limit both goto itself and the outer timer to the remaining time.
    attempts++;
    let response: Awaited<ReturnType<BrowserHealthPage['goto']>>;
    try { response = await bounded(page.goto(url, { timeout: remaining }), remaining); }
    catch (error) {
      const reason = healthFailure(error);
      if (firstFailure === 'none') firstFailure = reason;
      // Fail immediately on anything except permitted transient network errors, regardless of remaining time.
      if (!['connection_refused', 'connection_reset', 'address_unreachable'].includes(reason)) throw new BrowserHealthError(reason, report());
      const waitMs = Math.min(250, expires - clock());
      if (waitMs <= 0) throw new BrowserHealthError('deadline', report());
      // Shorten only the final wait; never begin another navigation after the deadline.
      await delay(waitMs);
      continue;
    }
    if (response?.status() !== 200) {
      if (firstFailure === 'none') firstFailure = 'http_status';
      throw new BrowserHealthError('http_status', report());
    }
    // A 200 response arriving after the deadline is not success.
    if (clock() >= expires) throw new BrowserHealthError('deadline', report());
    return report();
  }
}

/** Terminate only the Chromium instance we started, with a deadline. Input: owned BrowserServer; returns void. */
async function closeOwnedBrowser(server: BrowserServer): Promise<void> {
  const child = server.process();
  try { await bounded(server.close(), 3000); }
  catch {
    // Playwright kill terminates the owned process group. Use it only when normal close stalls.
    try { await bounded(server.kill(), 3000); }
    catch { /* If the API does not terminate it, check the owned child immediately below and force termination. */ }
  }
  if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
    // On Linux, Playwright starts a detached, independent process group.
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('browser_cleanup_failed'); }
  }
  if (child.exitCode === null && child.signalCode === null) {
    // Wait for termination notification; a kill request alone does not complete cleanup.
    let onExit: () => void;
    const exited = new Promise<void>(resolve => { onExit = resolve; child.once('exit', onExit); });
    try { await bounded(exited, 3000); }
    catch { throw new Error('browser_cleanup_failed'); }
    finally { child.off('exit', onExit!); }
  }
}

/** Validate an isolated Gateway/ROS system from real Chromium. Inputs: runtime URL and credential; returns an anonymized PASS report. */
export async function verifyBrowserConnection(options: BrowserConnectionOptions): Promise<BrowserConnectionReport> {
  const timeoutMs = options.timeoutMs ?? 120000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error('invalid_browser_timeout');
  const target = new URL(options.url);
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash) throw new Error('invalid_browser_url');
  if (typeof options.credential !== 'string' || options.credential.length < 32) throw new Error('invalid_browser_credential');
  // Playwright exceptions may contain destination details; expose only fixed phases outside this boundary.
  let phase = 'launch';
  const expires = performance.now() + timeoutMs;
  /** Return remaining time from the shared setup/scenario deadline. No input; returns milliseconds. */
  const remaining = (): number => {
    const milliseconds = expires - performance.now();
    if (milliseconds <= 0) throw new Error('browser_setup_deadline');
    return milliseconds;
  };
  console.log('browser E2E starting');
  const progress = setInterval(() => console.log(`browser E2E active: ${phase}`), 4000);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let server: BrowserServer | undefined;
  let health: BrowserHealthReport | undefined;
  let completed: BrowserConnectionReport | undefined;
  let failure: BrowserConnectionError | undefined;
  try {
    // Use launchServer's own timeout to preserve process cleanup after startup failures.
    server = await chromium.launchServer({ headless: true, timeout: Math.min(remaining(), 20000) });
    browser = await bounded(chromium.connect(server.wsEndpoint(), { timeout: remaining() }), remaining());
    const browserVersion = browser.version();
    const context = await bounded(browser.newContext({ ignoreHTTPSErrors: true }), remaining());
    const page = await bounded(context.newPage(), remaining());
    // Send offers from the same origin; permit localhost HTTPS certificates only in the test environment.
    phase = 'health';
    health = await waitBrowserHealth(page, `${options.url.replace(/\/$/, '')}/health`, { timeoutMs: Math.min(remaining(), 15000) });
    phase = 'connections';
    const report = await bounded(page.evaluate(browserScenario, { ...options, timeoutMs: remaining() }), remaining());
    if ('failure' in report) { phase = `connections:${report.failure}`; throw new Error('scenario_failed'); }
    console.log('browser E2E assertions passed');
    completed = { browserVersion, health, ...report };
  } catch (error) {
    failure = captureBrowserFailure(error, phase, health, false);
  }
  let cleanupFailed = false;
  phase = 'cleanup';
  // BrowserServer.close also closes clients, pages, contexts, and Chromium. Preserve cleanup results separately from the primary failure.
  try { if (server !== undefined) await closeOwnedBrowser(server); }
  catch { cleanupFailed = true; }
  finally { clearInterval(progress); }
  if (failure !== undefined) throw captureBrowserFailure(failure, failure.phase, health, cleanupFailed);
  if (cleanupFailed) throw new BrowserConnectionError('cleanup', 'cleanup_failed', health, true);
  if (completed === undefined) throw new BrowserConnectionError('connections', 'missing_result', health);
  return completed;
}
