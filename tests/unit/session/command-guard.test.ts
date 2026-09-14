import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommandGuard } from '../../../packages/bridge/src/session/command-guard.js';
import type { GuardOptions } from '../../../packages/bridge/src/session/types.js';
import { fixture } from './fixtures.js';

test('CMD-01: allow immediately before expiry and reject at/after expiry on receive and before publish', () => {
  for (const now of [249.5, 250, 251]) {
    const f = fixture();
    const ticket = f.guard.prepare(f.request);
    f.state.now = now;
    // Advance fake time after the wait barrier and directly observe ROS side effects.
    if (now < 250) {
      ticket.publish(f.publish);
      assert.equal(f.state.publishes, 1);
    } else {
      assert.throws(() => ticket.publish(f.publish), /lease_expired/);
      assert.throws(() => f.guard.prepare({ ...f.request, seq: '1' }), /lease_expired/);
      assert.equal(f.state.publishes, 0);
    }
  }
});

test('AUTH-02/CMD-02: reject pending commands after ACL revocation, disconnect, close, or rearming', async () => {
  for (const action of ['acl', 'session', 'handle', 'close', 'arm'] as const) {
    const f = fixture();
    const ticket = f.guard.prepare(f.request);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const pending = barrier.then(() => ticket.publish(f.publish));
    // Use an explicit barrier to place permission changes between receipt and synchronous publication.
    if (action === 'acl') f.state.allowed = false;
    if (action === 'session') f.guard.revokeSession(f.sessionId);
    if (action === 'handle') f.guard.closeHandle(f.sessionId, f.handle);
    if (action === 'close') f.guard.close();
    if (action === 'arm') f.guard.arm(f.sessionId, f.handle);
    release();
    await assert.rejects(pending, /unauthorized|invalid_owner|guard_closed|invalid_lease/);
    assert.equal(f.state.publishes, 0);
  }
});

test('CMD-02/PRO-03: enforce canonical uint64 and reject duplicates, reverse order, and ticket reuse', () => {
  const f = fixture();
  for (const seq of ['', '00', '01', '+1', '-1', '1.0', '1e2', ' 1', '18446744073709551616', '100000000000000000000', 1]) {
    assert.throws(() => f.guard.prepare({ ...f.request, seq: seq as string }), /invalid_sequence/);
  }
  // Accept initial zero and the uint64 maximum separately; reject reversed send order.
  const first = f.guard.prepare(f.request);
  assert.throws(() => f.guard.prepare(f.request), /stale_sequence/);
  const later = f.guard.prepare({ ...f.request, seq: '18446744073709551615' });
  later.publish(f.publish);
  assert.throws(() => first.publish(f.publish), /stale_sequence/);
  assert.throws(() => later.publish(f.publish), /ticket_consumed/);
  assert.equal(f.state.publishes, 1);
});

test('AUTH-01/CMD-03: reject lease reuse across sessions/handles and old epochs', () => {
  const f = fixture();
  const otherSession = f.guard.openSession('epoch-2');
  const otherHandle = f.guard.openHandle(otherSession, '/cmd_vel');
  const alias = f.guard.openHandle(f.sessionId, '/cmd_vel');
  // Invalidate identity, epoch, and lease independently.
  for (const change of [{ sessionId: otherSession }, { handle: 'unknown' }, { epoch: 'old' }, { leaseId: 'old' }, { handle: alias }]) {
    assert.throws(() => f.guard.prepare({ ...f.request, ...change }), /invalid_owner|invalid_epoch|invalid_lease/);
  }
  assert.throws(() => f.guard.arm(otherSession, otherHandle), /writer_busy/);
  const aliasLease = f.guard.arm(f.sessionId, alias);
  assert.throws(() => f.guard.prepare(f.request), /invalid_lease/);
  assert.notEqual(aliasLease.id, f.lease.id);
  // Transfer exclusivity to another session at exact expiry; the old owner cannot reuse it.
  f.state.now = 250;
  const next = f.guard.arm(otherSession, otherHandle);
  f.guard.prepare({ sessionId: otherSession, handle: otherHandle, epoch: 'epoch-2', leaseId: next.id, seq: '0' }).publish(f.publish);
  assert.equal(f.state.publishes, 1);
});

test('ACK-01: do not reuse sequences or tickets after synchronous ROS failure', () => {
  const f = fixture();
  const ticket = f.guard.prepare(f.request);
  assert.throws(() => ticket.publish(() => { f.publish(); throw new Error('ros_failed'); }), /ros_failed/);
  assert.throws(() => ticket.publish(f.publish), /ticket_consumed/);
  assert.throws(() => f.guard.prepare(f.request), /stale_sequence/);
  assert.equal(f.state.publishes, 1);
});

test('LIFE-01: finite registries, release, non-reused IDs, and writers on different Topics', () => {
  const f = fixture({ maxSessions: 2, maxHandles: 2 });
  const other = f.guard.openSession('epoch-1');
  assert.throws(() => f.guard.openSession('epoch-1'), /session_limit/);
  const h = f.guard.openHandle(other, '/other');
  f.guard.arm(other, h);
  assert.throws(() => f.guard.openHandle(other, '/third'), /handle_limit/);
  // Revocation preserves other sessions; repeated revocation never produces negative counts.
  f.guard.revokeSession(f.sessionId);
  f.guard.revokeSession(f.sessionId);
  assert.deepEqual(f.guard.stats(), { sessions: 1, handles: 1 });
  const replacement = f.guard.openSession('epoch-1');
  assert.notEqual(replacement, f.sessionId);
  const next = f.guard.openHandle(replacement, '/cmd_vel');
  assert.notEqual(next, f.handle);
  f.guard.closeHandle(replacement, next);
  f.guard.close();
  assert.deepEqual(f.guard.stats(), { sessions: 0, handles: 0 });
  assert.throws(() => f.guard.openSession('epoch'), /guard_closed/);
});

test('SEC-01: validate constructor limits, clocks, identifiers, and Topic boundaries', () => {
  const options: GuardOptions = { clock: () => 0, authorize: () => true, maxSessions: 2, maxHandles: 2, leaseMs: 250 };
  for (const value of [0, -1, NaN, Infinity, 0.1, Number.MAX_SAFE_INTEGER + 1]) {
    for (const key of ['maxSessions', 'maxHandles', 'leaseMs']) {
      assert.throws(() => new CommandGuard({ ...options, [key]: value }), /invalid_limit/);
    }
  }
  // Do not fall back to implicit permission when a callback is missing.
  assert.throws(() => new CommandGuard({ ...options, clock: null } as unknown as GuardOptions), /invalid_callback/);
  assert.throws(() => new CommandGuard({ ...options, authorize: null } as unknown as GuardOptions), /invalid_callback/);
  for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new CommandGuard({ ...options, clock: () => value }), /invalid_clock/);
  }
  const f = fixture();
  for (const epoch of ['', 'x'.repeat(257), 'bad epoch', 1]) {
    assert.throws(() => f.guard.openSession(epoch as string), /invalid_identifier/);
  }
  for (const topic of ['', '/', '/0bad', '/bad/', '/bad//name', '/x'.repeat(130), 1]) {
    assert.throws(() => f.guard.openHandle(f.sessionId, topic as string), /invalid_topic/);
  }
  assert.throws(() => f.guard.openHandle('missing', '/valid'), /unknown_session/);
  f.state.now = Number.MAX_SAFE_INTEGER;
  assert.throws(() => f.guard.arm(f.sessionId, f.handle), /invalid_clock/);
  f.state.now = 1;
  assert.throws(() => f.guard.prepare(f.request), /invalid_clock/);
  assert.equal(f.state.publishes, 0);
});

test('AUTH-02: revalidate revocation inside authorization hooks without leaving registrations', () => {
  let phaseToRevoke: string = '';
  let guard: CommandGuard;
  guard = new CommandGuard({ clock: () => 0, maxSessions: 2, maxHandles: 2, leaseMs: 250,
    authorize: (identity, phase) => { if (phase === phaseToRevoke) guard.revokeSession(identity.sessionId); return true; } });
  for (const phase of ['open', 'arm', 'receive', 'publish']) {
    phaseToRevoke = '';
    const sessionId = guard.openSession('epoch');
    if (phase === 'open') {
      phaseToRevoke = phase;
      assert.throws(() => guard.openHandle(sessionId, '/cmd'), /unknown_session/);
      continue;
    }
    // Reach the target hook phase before triggering revocation.
    const handle = guard.openHandle(sessionId, '/cmd');
    if (phase === 'arm') {
      phaseToRevoke = phase;
      assert.throws(() => guard.arm(sessionId, handle), /invalid_owner/);
      continue;
    }
    const lease = guard.arm(sessionId, handle);
    const request = { sessionId, handle, epoch: 'epoch', leaseId: lease.id, seq: '0' };
    if (phase === 'receive') {
      phaseToRevoke = phase;
      assert.throws(() => guard.prepare(request), /invalid_owner/);
      continue;
    }
    const ticket = guard.prepare(request);
    phaseToRevoke = phase;
    let publishes = 0;
    assert.throws(() => ticket.publish(() => { publishes += 1; }), /invalid_owner/);
    assert.equal(publishes, 0);
  }
  assert.deepEqual(guard.stats(), { sessions: 0, handles: 0 });
});

test('AUTH-01: verify default deny, callback failures, and request copying', () => {
  const f = fixture();
  f.state.allowed = false;
  assert.throws(() => f.guard.openHandle(f.sessionId, '/denied'), /unauthorized/);
  assert.throws(() => f.guard.arm(f.sessionId, f.handle), /unauthorized/);
  assert.throws(() => f.guard.prepare(f.request), /unauthorized/);
  assert.equal(f.state.publishes, 0);
  // Mutating the original request does not change the reserved sequence or epoch.
  f.state.allowed = true;
  const original = { ...f.request };
  const ticket = f.guard.prepare(original);
  original.epoch = 'mutated';
  ticket.publish(f.publish);
  const invalid = f.guard.prepare({ ...f.request, seq: '1' });
  assert.throws(() => invalid.publish(null as unknown as () => void), /invalid_callback/);
  assert.equal(f.state.publishes, 1);
});

test('SEC-01: reject trailing newlines in identifiers, sequences, and ROS Topics', () => {
  const f = fixture();
  for (const ending of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    // Prevent regressions that accept trailing newlines after multiline flag or similar changes.
    assert.throws(() => f.guard.openSession(`epoch${ending}`), /invalid_identifier/);
    assert.throws(() => f.guard.openHandle(f.sessionId, `/cmd_vel${ending}`), /invalid_topic/);
    assert.throws(() => f.guard.prepare({ ...f.request, seq: `42${ending}` }), /invalid_sequence/);
  }
  assert.deepEqual(f.guard.stats(), { sessions: 1, handles: 1 });
  assert.equal(f.state.publishes, 0);
});

test('CFG-01/CMD-01/CMD-03: share output Topic writer exclusivity across per-Topic lease settings', () => {
  const f = fixture();
  const otherSession = f.guard.openSession('epoch-2');
  const slowHandle = f.guard.openHandle(otherSession, '/slow', 500);
  const aliasHandle = f.guard.openHandle(otherSession, '/cmd_vel', 250);
  const slowLease = f.guard.arm(otherSession, slowHandle);
  assert.equal(slowLease.expiresAt, 500);
  assert.equal(f.lease.expiresAt, 250);
  // Handles with different settings in one guard still share exclusivity for the same output Topic.
  assert.throws(() => f.guard.arm(otherSession, aliasHandle), /writer_busy/);
  const oldCommand = f.guard.prepare(f.request);
  const slowCommand = f.guard.prepare({ sessionId: otherSession, epoch: 'epoch-2', handle: slowHandle, leaseId: slowLease.id, seq: '0' });
  f.state.now = 250;
  assert.throws(() => oldCommand.publish(f.publish), /lease_expired/);
  slowCommand.publish(f.publish);
  const replacement = f.guard.arm(otherSession, aliasHandle);
  assert.equal(replacement.expiresAt, 500);
  assert.equal(f.state.publishes, 1);
});

test('CFG-01: reject invalid per-Topic lease overrides before registering handles', () => {
  const f = fixture();
  for (const leaseMs of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => f.guard.openHandle(f.sessionId, '/invalid', leaseMs), /invalid_limit/);
  }
  assert.deepEqual(f.guard.stats(), { sessions: 1, handles: 1 });
});

test('CFG-01: accept 247-character fully qualified ROS Topic names and reject 248 characters', () => {
  const f = fixture();
  const topic = `/${'a'.repeat(246)}`;
  const handle = f.guard.openHandle(f.sessionId, topic);
  const lease = f.guard.arm(f.sessionId, handle);
  assert.throws(() => f.guard.openHandle(f.sessionId, `${topic}a`), /invalid_topic/);
  // A Topic at the boundary can publish; invalid registrations leave no state behind.
  f.guard.prepare({ ...f.request, handle, leaseId: lease.id }).publish(f.publish);
  assert.equal(f.state.publishes, 1);
  assert.deepEqual(f.guard.stats(), { sessions: 1, handles: 2 });
});
