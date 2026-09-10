import { chromium, type BrowserServer } from 'playwright-core';
import { browserScenario } from './scenario.js';
import type { BrowserConnectionOptions, BrowserConnectionReport } from './types.js';
export type { BrowserConnectionOptions, BrowserConnectionReport } from './types.js';

/** 非同期工程を有限時間に制限する。入力例: (promise,3000)、出力例: promise結果。@param action 工程 @param timeoutMs 上限 @returns 結果 */
async function bounded<T>(action: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('browser_stage_timeout')), Math.max(1, timeoutMs)); });
  try { return await Promise.race([action, timeout]); }
  finally { clearTimeout(timer!); }
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
  try {
    // launchServer自身のtimeoutで起動失敗時のprocess cleanupを維持する。
    server = await chromium.launchServer({ headless: true, timeout: Math.min(remaining(), 20000) });
    browser = await bounded(chromium.connect(server.wsEndpoint(), { timeout: remaining() }), remaining());
    const browserVersion = browser.version();
    const context = await bounded(browser.newContext({ ignoreHTTPSErrors: true }), remaining());
    const page = await bounded(context.newPage(), remaining());
    // 同じoriginからofferを送り、localhost HTTPSの証明書だけを試験環境で許容する。
    phase = 'health';
    const response = await page.goto(`${options.url.replace(/\/$/, '')}/health`, { timeout: Math.min(remaining(), 15000) });
    if (response?.status() !== 200) throw new Error('health_failed');
    phase = 'connections';
    const report = await bounded(page.evaluate(browserScenario, { ...options, timeoutMs: remaining() }), remaining());
    if ('failure' in report) { phase = `connections:${report.failure}`; throw new Error('scenario_failed'); }
    console.log('browser E2E assertions passed');
    return { browserVersion, ...report };
  } catch {
    throw new Error(`browser_e2e_failed:${phase}`);
  } finally {
    phase = 'cleanup';
    // BrowserServerのcloseは接続client/page/contextとChromium processも終了する。
    try { if (server !== undefined) await closeOwnedBrowser(server); }
    finally { clearInterval(progress); }
  }
}
