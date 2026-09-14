import { execFile } from 'node:child_process';
import { request } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import type { ContainerState } from './types.js';

/** Run an external command with a deadline, without logging arguments or output. Inputs: executable/args/timeout; returns stdout. */
export async function command(executable: string, args: readonly string[], timeoutMs = 30000,
  env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(executable, [...args], { env, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error('external_command_failed'));
      else resolve(stdout.trim());
    });
  });
}

/** Poll HTTPS health until a monotonic deadline. Inputs: URL/timeout; returns void on success. */
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

/** Parse restricted docker inspect state. Example: "true 0 false" returns state. */
export function parseContainerState(value: string): ContainerState {
  const match = /^(true|false)\s+(\d+)\s+(true|false)$/.exec(value.trim());
  if (!match) return Object.freeze({ available: false });
  const exitCode = Number(match[2]);
  if (!Number.isSafeInteger(exitCode)) return Object.freeze({ available: false });
  return Object.freeze({ available: true, running: match[1] === 'true', exitCode, oomKilled: match[3] === 'true' });
}

/** Fetch only restricted container state. Input: owned container name; returns running/exit/OOM. */
export async function containerState(name: string): Promise<ContainerState> {
  try {
    const value = await command('docker', ['inspect', '--format', '{{.State.Running}} {{.State.ExitCode}} {{.State.OOMKilled}}', name], 5000);
    return parseContainerState(value);
  } catch {
    return Object.freeze({ available: false });
  }
}

/** Verify no owned Docker object remains. Inputs: name/type; true means released. */
export async function absent(name: string, type: 'container' | 'network'): Promise<boolean> {
  try {
    const args = type === 'container' ? ['container', 'inspect', name] : ['network', 'inspect', name];
    await command('docker', args, 5000);
    return false;
  } catch {
    return true;
  }
}
