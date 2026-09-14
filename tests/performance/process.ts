import { execFile } from 'node:child_process';
import { request } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import type { ContainerState } from './types.js';

/** 外部commandを有限時間で実行し、引数や出力をlogしない。入力: executable/args/timeout、出力: stdout。 */
export async function command(executable: string, args: readonly string[], timeoutMs = 30000,
  env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(executable, [...args], { env, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error('external_command_failed'));
      else resolve(stdout.trim());
    });
  });
}

/** HTTPS healthを単調deadlineまでpollする。入力: URL/timeout、出力: 成功時void。 */
export async function healthy(url: string, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const ready = await new Promise<boolean>(resolve => {
      const remaining = Math.max(1, Math.min(1000, deadline - performance.now()));
      const outgoing = request(`${url}/health`, { rejectUnauthorized: false, timeout: remaining }, response => {
        response.resume();
        resolve(response.statusCode === 200);
      });
      outgoing.on('error', () => resolve(false));
      outgoing.on('timeout', () => { outgoing.destroy(); resolve(false); });
      outgoing.end();
    });
    if (ready) return;
    await delay(Math.max(1, Math.min(100, deadline - performance.now())));
  }
  throw new Error('gateway_readiness_timeout');
}

/** docker inspectの限定状態を解析する。入力例: "true 0 false"、出力: 状態。 */
export function parseContainerState(value: string): ContainerState {
  const match = /^(true|false)\s+(\d+)\s+(true|false)$/.exec(value.trim());
  if (!match) return Object.freeze({ available: false });
  const exitCode = Number(match[2]);
  if (!Number.isSafeInteger(exitCode)) return Object.freeze({ available: false });
  return Object.freeze({ available: true, running: match[1] === 'true', exitCode, oomKilled: match[3] === 'true' });
}

/** containerの限定状態だけを取得する。入力: 所有container名、出力: running/exit/OOM。 */
export async function containerState(name: string): Promise<ContainerState> {
  try {
    const value = await command('docker', ['inspect', '--format', '{{.State.Running}} {{.State.ExitCode}} {{.State.OOMKilled}}', name], 5000);
    return parseContainerState(value);
  } catch {
    return Object.freeze({ available: false });
  }
}

/** 所有Docker objectが残っていないことを確認する。入力: name/type、出力: trueなら解放済み。 */
export async function absent(name: string, type: 'container' | 'network'): Promise<boolean> {
  try {
    const args = type === 'container' ? ['container', 'inspect', name] : ['network', 'inspect', name];
    await command('docker', args, 5000);
    return false;
  } catch {
    return true;
  }
}
