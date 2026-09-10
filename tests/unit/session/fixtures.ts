import { CommandGuard } from '../../../packages/bridge/src/session/command-guard.js';
import type { CommandRequest, GuardOptions } from '../../../packages/bridge/src/session/types.js';

/** fake clockと許可policyを用意する。入力例: ()、出力例: fixture。@param overrides 設定差分 @returns 制御可能なguard */
export function fixture(overrides: Partial<GuardOptions> = {}) {
  const state = { now: 0, allowed: true, publishes: 0 };
  // ROS副作用はspy回数として観測し、不許可時に0のままであることを確認する。
  const guard = new CommandGuard({ clock: () => state.now, authorize: () => state.allowed,
    maxSessions: 4, maxHandles: 8, leaseMs: 250, ...overrides });
  const sessionId = guard.openSession('epoch-1');
  const handle = guard.openHandle(sessionId, '/cmd_vel');
  const lease = guard.arm(sessionId, handle);
  // 各試験は独立したIDを使い、seqのみ必要に応じて上書きする。
  const request: CommandRequest = { sessionId, handle, epoch: 'epoch-1', leaseId: lease.id, seq: '0' };
  const publish = (): void => { state.publishes += 1; };
  return { state, guard, sessionId, handle, lease, request, publish };
}
