import type { CommandAuditEvent } from '../router/types.js';

export const COMMAND_AUDIT_SCHEMA = 'ros-webrtc-bridge.command-audit.v1';

interface CommandLogOptions {
  readonly enabled: boolean;
  readonly windowMs: number;
  readonly clock: () => number;
  readonly write: (line: string) => void;
}

interface WindowState { startedAt: number; suppressed: number }

interface AsyncLineWriterOptions {
  readonly capacity: number;
  readonly schedule: (task: () => void) => void;
  readonly write: (line: string) => void;
}

/** Move output I/O off the command path while retaining a finite amount of diagnostic work. */
export function createAsyncLineWriter(options: AsyncLineWriterOptions): (line: string) => void {
  if (!Number.isSafeInteger(options.capacity) || options.capacity <= 0) throw new Error('invalid_command_log_capacity');
  const pending: string[] = [];
  let scheduled = false;
  const drain = (): void => {
    const line = pending.shift();
    if (line === undefined) { scheduled = false; return; }
    try { options.write(line); } catch { /* best-effort diagnostics */ }
    try { options.schedule(drain); } catch { pending.length = 0; scheduled = false; }
  };
  return line => {
    if (pending.length >= options.capacity) return;
    pending.push(line);
    if (scheduled) return;
    scheduled = true;
    try { options.schedule(drain); } catch { pending.length = 0; scheduled = false; }
  };
}

/** Build a bounded structured audit sink. Correlation values never participate in limiter keys. */
export function createCommandLogger(options: CommandLogOptions): (event: CommandAuditEvent) => void {
  if (!Number.isSafeInteger(options.windowMs) || options.windowMs <= 0) throw new Error('invalid_command_log_window');
  const windows = new Map<string, WindowState>();
  return (event): void => {
    if (!options.enabled) return;
    try {
      const now = options.clock();
      if (!Number.isFinite(now)) return;
      const common = { schema: COMMAND_AUDIT_SCHEMA, operation: event.operation, outcome: event.outcome,
        peer: event.peer, monotonic_ms: Math.floor(now) };
      if (event.operation === 'peer') { options.write(JSON.stringify(common)); return; }
      const reason = event.outcome === 'rejected' ? event.reason : '';
      const key = `${event.operation}:${event.outcome}:${reason}`;
      const prior = windows.get(key);
      if (prior !== undefined && now - prior.startedAt < options.windowMs) { prior.suppressed++; return; }
      const suppressed = prior?.suppressed ?? 0;
      windows.set(key, { startedAt: now, suppressed: 0 });
      const record = { ...common, publisher: event.publisher, attempt: event.attempt,
        ...(event.outcome === 'rejected' ? { reason: event.reason } : {}), ...(suppressed === 0 ? {} : { suppressed }) };
      options.write(JSON.stringify(record));
    } catch {
      // Diagnostics are best-effort and must never affect command authorization or publication.
    }
  };
}
