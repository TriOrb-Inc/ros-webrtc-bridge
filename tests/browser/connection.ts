import { chromium, type BrowserServer } from 'playwright-core';
import { browserScenario } from './scenario.js';
import type { BrowserConnectionOptions, BrowserConnectionPhase, BrowserConnectionReport, BrowserHealthFailure, BrowserHealthOptions,
  BrowserHealthPage, BrowserHealthReport } from './types.js';
export type { BrowserConnectionOptions, BrowserConnectionReport } from './types.js';

/** 非同期工程を有限時間に制限する。入力例: (promise,3000)、出力例: promise結果。@param action 工程 @param timeoutMs 上限 @returns 結果 */
async function bounded<T>(action: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('browser_stage_timeout')), Math.max(1, timeoutMs)); });
  try { return await Promise.race([action, timeout]); }
  finally { clearTimeout(timer!); }
}

/** browser失敗の固定分類と匿名診断だけを保持する。元例外やURLは保持しない。 */
export class BrowserConnectionError extends Error {
  /** 入力は固定phase/reasonと匿名診断、出力は安全に保存できる例外。 */
  constructor(readonly phase: BrowserConnectionPhase, readonly reason: string,
    readonly health: BrowserHealthReport | undefined, readonly cleanupFailed = false) {
    const healthText = health === undefined ? ''
      : `:attempts=${health.attempts}:first=${health.firstFailure}:elapsed_ms=${health.elapsedMs}:timeout_ms=${health.timeoutMs}`;
    super(`browser_e2e_failed:${phase}:${reason}${healthText}:cleanup_failed=${cleanupFailed}`);
  }
}

/** health固有の固定分類を型で扱う。 */
export class BrowserHealthError extends BrowserConnectionError {
  constructor(reason: BrowserHealthFailure | 'deadline', health: BrowserHealthReport, cleanupFailed = false) {
    super('health', reason, health, cleanupFailed);
  }
}

/** primary failureを保持しcleanup結果を併記する。入力: 固定phase/health、出力: 匿名Error。 */
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

/** navigation例外を固定分類へ変換する。入力は未加工例外、出力例: connection_refused。 */
function healthFailure(error: unknown): BrowserHealthFailure {
  if (!(error instanceof Error)) return 'unknown_error';
  // URLやcall log内の文字列をallowlist判定へ流用せず、Chromiumの先頭error codeだけを見る。
  const code = /^page\.goto: net::([A-Z_]+)(?: at |$)/.exec(error.message)?.[1];
  if (code === 'ERR_CONNECTION_REFUSED') return 'connection_refused';
  if (code === 'ERR_CONNECTION_RESET') return 'connection_reset';
  if (code === 'ERR_ADDRESS_UNREACHABLE') return 'address_unreachable';
  // timeout・TLS・browser終了等は再試行で隠さない。
  return error.name === 'TimeoutError' || error.message === 'browser_stage_timeout' ? 'navigation_timeout' : 'unknown_error';
}

/** healthだけを有限pollする。入力例: fake page/URL/時計、出力: 回数・最初の失敗・経過ms。scenarioは含まない。 */
export async function waitBrowserHealth(page: BrowserHealthPage, url: string, options: BrowserHealthOptions): Promise<BrowserHealthReport> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 600000) throw new Error('invalid_health_timeout');
  const clock = options.clock ?? (() => performance.now());
  const delay = options.delay ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  // 再試行ごとに期限を延ばさず、最初の開始時刻へ固定する。
  const started = clock(), expires = started + options.timeoutMs;
  let attempts = 0, firstFailure: BrowserHealthReport['firstFailure'] = 'none';
  /** clockの経過を匿名reportへ固定する。引数なし、出力例: attempts=2, elapsedMs=250。 */
  const report = (): BrowserHealthReport => Object.freeze({ attempts, firstFailure,
    elapsedMs: Math.max(0, Math.round(clock() - started)), timeoutMs: Math.ceil(options.timeoutMs) });
  for (;;) {
    const remaining = expires - clock();
    if (remaining <= 0) throw new BrowserHealthError('deadline', report());
    // goto自身と外側timerの両方を残り時間へ制限する。
    attempts++;
    let response: Awaited<ReturnType<BrowserHealthPage['goto']>>;
    try { response = await bounded(page.goto(url, { timeout: remaining }), remaining); }
    catch (error) {
      const reason = healthFailure(error);
      if (firstFailure === 'none') firstFailure = reason;
      // 許容する一時network error以外は、残り時間にかかわらず即失敗する。
      if (!['connection_refused', 'connection_reset', 'address_unreachable'].includes(reason)) throw new BrowserHealthError(reason, report());
      const waitMs = Math.min(250, expires - clock());
      if (waitMs <= 0) throw new BrowserHealthError('deadline', report());
      // 最後の待機だけ短縮し、期限後には次のnavigationを開始しない。
      await delay(waitMs);
      continue;
    }
    if (response?.status() !== 200) {
      if (firstFailure === 'none') firstFailure = 'http_status';
      throw new BrowserHealthError('http_status', report());
    }
    // deadlineを過ぎて到着した200も成功にしない。
    if (clock() >= expires) throw new BrowserHealthError('deadline', report());
    return report();
  }
}

/** 自分が起動したChromiumだけを期限付きで終了する。入力: BrowserServer、出力なし。@param server 所有server @returns なし */
async function closeOwnedBrowser(server: BrowserServer): Promise<void> {
  const child = server.process();
  try { await bounded(server.close(), 3000); }
  catch {
    // Playwrightのkillは所有process groupを終了する。正常closeが停止した場合だけ使う。
    try { await bounded(server.kill(), 3000); }
    catch { /* APIで終了しない場合は、直後に所有childの生存を確認して強制終了する。 */ }
  }
  if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
    // Linux上のPlaywrightはdetachedで独立process groupを起動する。
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('browser_cleanup_failed'); }
  }
  if (child.exitCode === null && child.signalCode === null) {
    // 終了通知を待ち、kill要求だけをcleanup完了として扱わない。
    let onExit: () => void;
    const exited = new Promise<void>(resolve => { onExit = resolve; child.once('exit', onExit); });
    try { await bounded(exited, 3000); }
    catch { throw new Error('browser_cleanup_failed'); }
    finally { child.off('exit', onExit!); }
  }
}

/** 実Chromiumから隔離Gateway/ROSを検証する。入力例: 実行時URLとcredential、出力例: 匿名PASS report。@param options 接続設定 @returns 検証結果 */
export async function verifyBrowserConnection(options: BrowserConnectionOptions): Promise<BrowserConnectionReport> {
  const timeoutMs = options.timeoutMs ?? 120000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error('invalid_browser_timeout');
  const target = new URL(options.url);
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash) throw new Error('invalid_browser_url');
  if (typeof options.credential !== 'string' || options.credential.length < 32) throw new Error('invalid_browser_credential');
  // Playwrightの例外には接続先等が入りうるため、外側では固定phaseだけを公開する。
  let phase = 'launch';
  const expires = performance.now() + timeoutMs;
  /** setupとscenarioで共通deadlineの残りを返す。入力なし、出力ms。 */
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
    // launchServer自身のtimeoutで起動失敗時のprocess cleanupを維持する。
    server = await chromium.launchServer({ headless: true, timeout: Math.min(remaining(), 20000) });
    browser = await bounded(chromium.connect(server.wsEndpoint(), { timeout: remaining() }), remaining());
    const browserVersion = browser.version();
    const context = await bounded(browser.newContext({ ignoreHTTPSErrors: true }), remaining());
    const page = await bounded(context.newPage(), remaining());
    // 同じoriginからofferを送り、localhost HTTPSの証明書だけを試験環境で許容する。
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
  // BrowserServerのcloseは接続client/page/contextとChromium processも終了する。primary failureとは別に保持する。
  try { if (server !== undefined) await closeOwnedBrowser(server); }
  catch { cleanupFailed = true; }
  finally { clearInterval(progress); }
  if (failure !== undefined) throw captureBrowserFailure(failure, failure.phase, health, cleanupFailed);
  if (cleanupFailed) throw new BrowserConnectionError('cleanup', 'cleanup_failed', health, true);
  if (completed === undefined) throw new BrowserConnectionError('connections', 'missing_result', health);
  return completed;
}
