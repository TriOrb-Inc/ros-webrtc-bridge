import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createCodec, type Field } from '../../packages/bridge/src/codec/index.js';
import { parseBridgeConfig } from '../../packages/bridge/src/config/index.js';
import { CommandGuard } from '../../packages/bridge/src/session/command-guard.js';
import { DeliveryQueue } from '../../packages/bridge/src/session/delivery-queue.js';

// geometry_msgs/Twistの完全なfield構造を明示する。型自動ロードの代用ではない。
const vector: Field = { kind: 'object', fields: {
  x: { kind: 'float', bits: 64 }, y: { kind: 'float', bits: 64 }, z: { kind: 'float', bits: 64 },
} };
const twist: Field = { kind: 'object', fields: { linear: vector, angular: vector } };
const wire = { linear: { x: 0.25, y: 0, z: 0 }, angular: { x: 0, y: 0, z: -0.5 } };

/** 設定、codec、guard、spyを接続する。入力なし、出力fixture。例: send(wire) → publishを1回だけ呼べるticket。 */
function fixture() {
  const source = readFileSync('examples/bridge.yaml', 'utf8');
  const config = parseBridgeConfig(source, { availableTypes: ['nav_msgs/msg/Odometry', 'geometry_msgs/msg/Twist'],
    resolveTopic: topic => `/test${topic}` });
  const binding = config.topics[1];
  // ネットワークやROSの動作とは独立した、module間の呼出契約を確認する。
  let time = 0;
  let allowed = true;
  const published: { topic: string; data: unknown }[] = [];
  const codec = createCodec(twist, { allowNonFinite: false });
  const guard = new CommandGuard({ clock: () => time, maxSessions: config.limits.maxPeers, maxHandles: 4,
    leaseMs: binding.commandGuard!.leaseMs, authorize: identity => allowed && identity.topic === binding.rosTopic });
  // 起動設定のROS名を渡す。wireの任意Topic名をそのまま登録しない。
  const sessionId = guard.openSession('epoch-1');
  const handle = guard.openHandle(sessionId, binding.rosTopic);
  const lease = guard.arm(sessionId, handle);
  let sequence = 0;
  /** 入力をsnapshotし予約する。例: Twist wire → ticket callback。戻り値を呼ぶまでspyの副作用はない。 */
  function send(input: unknown) {
    const snapshot = codec.encode(codec.decode(input));
    const ticket = guard.prepare({ sessionId, epoch: 'epoch-1', handle, leaseId: lease.id, seq: String(++sequence) });
    return () => ticket.publish(() => {
      // publish側でも型値を確認する。sync callback内にawaitを挟まない。
      const data = codec.decode(snapshot);
      published.push({ topic: binding.rosTopic, data });
    });
  }
  return { send, published, guard, lease, codec,
    /** 時刻を進める。入力millisecond、出力なし。例: 250 → 次のpublishは期限一致で拒否。 */
    setTime(value: number) { time = value; },
    /** ACLを撤回する。入力なし、出力なし。例: 待機ticket → unauthorized。 */
    revoke() { allowed = false; } };
}

test('CFG-02/TYPE-01/ACK-01 設定済みROS出力へnative値を一度だけ渡す', () => {
  const f = fixture();
  const input = structuredClone(wire);
  const publish = f.send(input);
  assert.equal(f.published.length, 0);
  // 呼出元の入力変更がqueue待機中のcommandへ混入しない。
  input.linear.x = 100;
  publish();
  assert.deepEqual(f.published, [{ topic: '/test/cmd_vel', data: wire }]);
  assert.throws(publish, /ticket_consumed/);
  f.guard.close();
});

test('AUTH-02/CMD-01 queue待機中のACL撤回と期限一致では副作用0', () => {
  const expired = fixture();
  const late = expired.send(wire);
  expired.setTime(expired.lease.expiresAt);
  assert.throws(late, /lease_expired/);
  // 同じmodule結合経路で、期限と認可撤回をそれぞれ独立に確認する。
  const revoked = fixture();
  const pending = revoked.send(wire);
  revoked.revoke();
  assert.throws(pending, /unauthorized/);
  assert.equal(expired.published.length + revoked.published.length, 0);
  expired.guard.close();
  revoked.guard.close();
});

test('TYPE-01 command非有限値・未知fieldを予約前に拒否する', () => {
  const f = fixture();
  assert.throws(() => f.send({ ...wire, extra: true }), TypeError);
  assert.throws(() => f.send({ ...wire, linear: { x: 'NaN', y: 0, z: 0 } }), TypeError);
  assert.equal(f.published.length, 0);
  f.guard.close();
});

test('FLOW-01/SIZE-01 codec出力をbyte queueへ渡しlatestだけを保持する', () => {
  const f = fixture();
  const queue = new DeliveryQueue({ maxStreams: 1, maxBytes: 256, maxMessageBytes: 128 });
  queue.register('stream-1', 'latest', 1);
  const first = Buffer.from(JSON.stringify({ data: f.codec.encode(wire) }), 'utf8');
  // 最小envelopeのbytesを計上する。最終wire protocol互換性は別途検証が必要。
  const next = { linear: { x: 0.5, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0 } };
  const second = Buffer.from(JSON.stringify({ data: f.codec.encode(next) }), 'utf8');
  queue.enqueue('stream-1', first);
  queue.enqueue('stream-1', second);
  assert.equal(queue.stats().bytes, second.byteLength);
  // 次のconsumerが受け取る値と、破棄数・解放後の容量を観測する。
  const delivered = JSON.parse(Buffer.from(queue.dequeue('stream-1')!).toString('utf8'));
  assert.deepEqual(delivered, { data: next });
  assert.deepEqual(queue.stats(), { streams: 1, bytes: 0, dropped: 1n });
  queue.clear();
  f.guard.close();
});
