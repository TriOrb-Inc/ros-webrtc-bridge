import { BrowserConnectionError } from '../browser/connection.js';

export interface ContainerState {
  readonly available: boolean;
  readonly running?: boolean;
  readonly exitCode?: number;
  readonly oomKilled?: boolean;
}

export interface ConnectionFailure {
  readonly stage: 'browser_health' | 'browser_connection' | 'connection';
  readonly reason: string;
  readonly attempts?: number;
  readonly firstFailure?: string;
  readonly elapsedMs?: number;
  readonly timeoutMs?: number;
  readonly cleanupFailed?: boolean;
}

/** Convert restricted docker inspect output to anonymized state. Example: true 0 false returns running/exit/OOM. */
export function parseContainerState(value: string): ContainerState {
  const match = /^(true|false)\s+(\d+)\s+(true|false)$/.exec(value.trim());
  if (!match) return Object.freeze({ available: false });
  const exitCode = Number(match[2]);
  if (!Number.isSafeInteger(exitCode)) return Object.freeze({ available: false });
  return Object.freeze({ available: true, running: match[1] === 'true', exitCode, oomKilled: match[3] === 'true' });
}

/** Convert raw exceptions to fixed diagnostics without URLs or payloads. Input: browser/connection exception; returns anonymized classification. */
export function connectionFailure(error: unknown): ConnectionFailure {
  if (error instanceof BrowserConnectionError) {
    const stage = error.phase === 'health' ? 'browser_health' : error.phase === 'connections' ? 'browser_connection' : 'connection';
    return Object.freeze({ stage, reason: error.reason,
      ...(error.health === undefined ? {} : { attempts: error.health.attempts, firstFailure: error.health.firstFailure,
        elapsedMs: error.health.elapsedMs, timeoutMs: error.health.timeoutMs }), cleanupFailed: error.cleanupFailed });
  }
  return Object.freeze({ stage: 'connection', reason: 'unknown' });
}
