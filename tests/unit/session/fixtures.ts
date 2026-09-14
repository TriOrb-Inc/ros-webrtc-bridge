import { CommandGuard } from '../../../packages/bridge/src/session/command-guard.js';
import type { CommandRequest, GuardOptions } from '../../../packages/bridge/src/session/types.js';

/** Provide a fake clock and allowing policy. Example: () returns a fixture. @param overrides Configuration differences @returns Controllable guard */
export function fixture(overrides: Partial<GuardOptions> = {}) {
  const state = { now: 0, allowed: true, publishes: 0 };
  // Observe ROS side effects as spy counts and verify they remain zero when denied.
  const guard = new CommandGuard({ clock: () => state.now, authorize: () => state.allowed,
    maxSessions: 4, maxHandles: 8, leaseMs: 250, ...overrides });
  const sessionId = guard.openSession('epoch-1');
  const handle = guard.openHandle(sessionId, '/cmd_vel');
  const lease = guard.arm(sessionId, handle);
  // Each test uses independent IDs and overrides only the sequence as needed.
  const request: CommandRequest = { sessionId, handle, epoch: 'epoch-1', leaseId: lease.id, seq: '0' };
  const publish = (): void => { state.publishes += 1; };
  return { state, guard, sessionId, handle, lease, request, publish };
}
