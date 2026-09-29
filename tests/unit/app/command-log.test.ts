import assert from 'node:assert/strict';
import test from 'node:test';
import { COMMAND_AUDIT_SCHEMA, createAsyncLineWriter, createCommandLogger } from '../../../packages/bridge/src/app/command-log.js';
import type { CommandAuditEvent } from '../../../packages/bridge/src/router/types.js';

test('SEC-01: emit schema-v1 JSON, suppress finite keys, and exclude correlation from limiter keys', () => {
  let now = 0;
  const lines: string[] = [];
  const log = createCommandLogger({ enabled: true, windowMs: 100, clock: () => now, write: line => { lines.push(line); } });
  const first: CommandAuditEvent = { operation: 'publish', outcome: 'rejected', reason: 'invalid_lease', peer: 1, publisher: 2, attempt: 3 };
  log(first);
  for (let index = 0; index < 10_000; index++) log({ ...first, peer: index, publisher: index, attempt: index });
  assert.equal(lines.length, 1);
  now = 100;
  log({ ...first, peer: 4, publisher: 5, attempt: 6 });
  assert.deepEqual(JSON.parse(lines[1]!), { schema: COMMAND_AUDIT_SCHEMA, ...first, peer: 4, publisher: 5, attempt: 6,
    monotonic_ms: 100, suppressed: 10_000 });
  // A different finite classification has its own window and appears immediately.
  log({ operation: 'arm', outcome: 'accepted', peer: 4, publisher: 5, attempt: 7 });
  assert.equal(lines.length, 3);
  // Lifecycle records are not coalesced across peers, and unexpected runtime properties are dropped.
  log({ operation: 'peer', outcome: 'opened', peer: 8, secret: 'credential-canary' } as CommandAuditEvent);
  log({ operation: 'peer', outcome: 'opened', peer: 9 } as CommandAuditEvent);
  assert.equal(lines.length, 5);
  assert.deepEqual(JSON.parse(lines[3]!), { schema: COMMAND_AUDIT_SCHEMA, operation: 'peer', outcome: 'opened', peer: 8, monotonic_ms: 100 });
  assert.equal(lines[3]!.includes('canary'), false);
});

test('SEC-01: disabled and failing diagnostics never affect commands', () => {
  const event: CommandAuditEvent = { operation: 'peer', outcome: 'opened', peer: 1 };
  let calls = 0;
  createCommandLogger({ enabled: false, windowMs: 1, clock: () => { calls++; return 0; }, write: () => { calls++; } })(event);
  assert.equal(calls, 0);
  const badClock = createCommandLogger({ enabled: true, windowMs: 1, clock: () => NaN, write: () => { calls++; } });
  badClock(event); assert.equal(calls, 0);
  const badWrite = createCommandLogger({ enabled: true, windowMs: 1, clock: () => 0, write: () => { throw new Error('private'); } });
  assert.doesNotThrow(() => badWrite(event));
  assert.throws(() => createCommandLogger({ enabled: true, windowMs: 0, clock: () => 0, write: () => {} }), /window/);
  assert.throws(() => createCommandLogger({ enabled: true, windowMs: 1.5, clock: () => 0, write: () => {} }), /window/);
});

test('SEC-01: bound and defer output I/O away from the command path', () => {
  const tasks: (() => void)[] = [];
  const lines: string[] = [];
  const write = createAsyncLineWriter({ capacity: 2, schedule: task => { tasks.push(task); },
    write: line => { lines.push(line); } });
  write('one'); write('two'); write('dropped');
  assert.deepEqual(lines, []);
  tasks.shift()!(); tasks.shift()!(); tasks.shift()!();
  assert.deepEqual(lines, ['one', 'two']);
  assert.throws(() => createAsyncLineWriter({ capacity: 0, schedule: () => {}, write: () => {} }), /capacity/);

  const failedSchedule = createAsyncLineWriter({ capacity: 1, schedule: () => { throw new Error('schedule'); }, write: () => {} });
  assert.doesNotThrow(() => failedSchedule('safe'));
  const failedWriteTasks: (() => void)[] = [];
  const failedWrite = createAsyncLineWriter({ capacity: 1, schedule: task => { failedWriteTasks.push(task); },
    write: () => { throw new Error('write'); } });
  failedWrite('safe');
  assert.doesNotThrow(() => { failedWriteTasks.shift()!(); });
  let schedules = 0;
  const failedRescheduleTasks: (() => void)[] = [];
  const failedReschedule = createAsyncLineWriter({ capacity: 1, schedule: task => {
    if (++schedules > 1) throw new Error('reschedule');
    failedRescheduleTasks.push(task);
  }, write: () => {} });
  failedReschedule('safe');
  assert.doesNotThrow(() => { failedRescheduleTasks.shift()!(); });
});
