import { chromium, type BrowserServer } from 'playwright-core';
import { performanceScenario } from './scenario.js';
import type { BrowserRunReport, ScenarioInput } from './types.js';

/** promiseを有限時間に制限する。入力: action/timeout、出力: action結果。 */
async function bounded<T>(action: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('browser_stage_timeout')), Math.max(1, timeoutMs));
  });
  try {
    return await Promise.race([action, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** 所有Chromium processをclose/kill/終了確認する。入力: server、出力なし。 */
async function closeBrowser(server: BrowserServer): Promise<void> {
  const child = server.process();
  try {
    await bounded(server.close(), 3000);
  } catch {
    try { await bounded(server.kill(), 3000); } catch { /* 下の所有PID確認へ進む。 */ }
  }
  if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('browser_cleanup_failed'); }
  }
  if (child.exitCode === null && child.signalCode === null) {
    let listener: () => void;
    const exited = new Promise<void>(resolve => { listener = resolve; child.once('exit', listener); });
    try { await bounded(exited, 3000); }
    finally { child.off('exit', listener!); }
  }
}

/** 実Chromiumで性能scenarioを1回実行する。入力: URL/credential/workload、出力: 匿名report。 */
export async function runBrowserPerformance(input: ScenarioInput): Promise<BrowserRunReport> {
  const expires = performance.now() + input.timeoutMs;
  const remaining = (): number => {
    const value = expires - performance.now();
    if (value <= 0) throw new Error('browser_deadline');
    return value;
  };
  let server: BrowserServer | undefined;
  let result: BrowserRunReport | undefined;
  let failed = false;
  try {
    server = await chromium.launchServer({ headless: true, timeout: Math.min(20000, remaining()) });
    const browser = await bounded(chromium.connect(server.wsEndpoint(), { timeout: remaining() }), remaining());
    const context = await bounded(browser.newContext({ ignoreHTTPSErrors: true }), remaining());
    const page = await bounded(context.newPage(), remaining());
    // navigationで自己署名TLS originを確立し、接続情報は戻り値やlogへ含めない。
    const response = await bounded(page.goto(`${input.url.replace(/\/$/, '')}/health`,
      { waitUntil: 'domcontentloaded', timeout: Math.min(15000, remaining()) }), remaining());
    if (response?.status() !== 200) throw new Error('browser_health_failed');
    const scenario = await bounded(page.evaluate(performanceScenario, input), remaining());
    if ('failure' in scenario) throw new Error(`scenario_${scenario.failure}`);
    result = Object.freeze({ browserVersion: browser.version(), scenario });
  } catch {
    failed = true;
  }
  let cleanupFailed = false;
  try { if (server !== undefined) await closeBrowser(server); }
  catch { cleanupFailed = true; }
  if (cleanupFailed) throw new Error('browser_cleanup_failed');
  if (failed || result === undefined) throw new Error('browser_performance_failed');
  return result;
}
