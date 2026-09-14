import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createCodec, type Field } from '../../packages/bridge/src/codec/index.js';
import { parseBridgeConfig } from '../../packages/bridge/src/config/index.js';
import { CommandGuard } from '../../packages/bridge/src/session/command-guard.js';
import { DeliveryQueue } from '../../packages/bridge/src/session/delivery-queue.js';

// Declare the complete geometry_msgs/Twist field structure explicitly; this is not a substitute for automatic type loading.
const vector: Field = { kind: 'object', fields: {
  x: { kind: 'float', bits: 64 }, y: { kind: 'float', bits: 64 }, z: { kind: 'float', bits: 64 },
} };
const twist: Field = { kind: 'object', fields: { linear: vector, angular: vector } };
const wire = { linear: { x: 0.25, y: 0, z: 0 }, angular: { x: 0, y: 0, z: -0.5 } };

/** Connect configuration, codec, guard, and spy. No input; returns a fixture. send(wire) produces a ticket that can publish only once. */
function fixture() {
  const source = readFileSync('examples/bridge.yaml', 'utf8');
  const config = parseBridgeConfig(source, { availableTypes: ['nav_msgs/msg/Odometry', 'geometry_msgs/msg/Twist'],
    resolveTopic: topic => `/test${topic}` });
  const binding = config.topics[1];
  // Check inter-module call contracts independently of network or ROS behavior.
  let time = 0;
  let allowed = true;
  const published: { topic: string; data: unknown }[] = [];
  const codec = createCodec(twist, { allowNonFinite: false });
  const guard = new CommandGuard({ clock: () => time, maxSessions: config.limits.maxPeers, maxHandles: 4,
    leaseMs: binding.commandGuard!.leaseMs, authorize: identity => allowed && identity.topic === binding.rosTopic });
  // Pass the ROS name from startup configuration; never register arbitrary topic names directly from the wire.
  const sessionId = guard.openSession('epoch-1');
  const handle = guard.openHandle(sessionId, binding.rosTopic);
  const lease = guard.arm(sessionId, handle);
  let sequence = 0;
  /** Snapshot input and reserve execution. Twist wire returns a ticket callback; the spy has no side effects until it is called. */
  function send(input: unknown) {
    const snapshot = codec.encode(codec.decode(input));
    const ticket = guard.prepare({ sessionId, epoch: 'epoch-1', handle, leaseId: lease.id, seq: String(++sequence) });
    return () => ticket.publish(() => {
      // Validate field values at the publish boundary too. Do not insert await inside the synchronous callback.
      const data = codec.decode(snapshot);
      published.push({ topic: binding.rosTopic, data });
    });
  }
  return { send, published, guard, lease, codec,
    /** Advance time. Input: milliseconds; no return value. At 250, the next publish is rejected exactly at expiry. */
    setTime(value: number) { time = value; },
    /** Revoke the ACL. No input or return value. A pending ticket then fails as unauthorized. */
    revoke() { allowed = false; } };
}

test('CFG-02/TYPE-01/ACK-01 passes native values once to the configured ROS output', () => {
  const f = fixture();
  const input = structuredClone(wire);
  const publish = f.send(input);
  assert.equal(f.published.length, 0);
  // Caller mutation must not alter a command waiting in the queue.
  input.linear.x = 100;
  publish();
  assert.deepEqual(f.published, [{ topic: '/test/cmd_vel', data: wire }]);
  assert.throws(publish, /ticket_consumed/);
  f.guard.close();
});

test('AUTH-02/CMD-01 queued commands have no side effects after ACL revocation or exactly at expiry', () => {
  const expired = fixture();
  const late = expired.send(wire);
  expired.setTime(expired.lease.expiresAt);
  assert.throws(late, /lease_expired/);
  // Check expiry and authorization revocation independently through the same module integration path.
  const revoked = fixture();
  const pending = revoked.send(wire);
  revoked.revoke();
  assert.throws(pending, /unauthorized/);
  assert.equal(expired.published.length + revoked.published.length, 0);
  expired.guard.close();
  revoked.guard.close();
});

test('TYPE-01 rejects nonfinite command values and unknown fields before reservation', () => {
  const f = fixture();
  assert.throws(() => f.send({ ...wire, extra: true }), TypeError);
  assert.throws(() => f.send({ ...wire, linear: { x: 'NaN', y: 0, z: 0 } }), TypeError);
  assert.equal(f.published.length, 0);
  f.guard.close();
});

test('FLOW-01/SIZE-01 sends codec output to the byte queue and retains only the latest value', () => {
  const f = fixture();
  const queue = new DeliveryQueue({ maxStreams: 1, maxBytes: 256, maxMessageBytes: 128 });
  queue.register('stream-1', 'latest', 1);
  const first = Buffer.from(JSON.stringify({ data: f.codec.encode(wire) }), 'utf8');
  // Account for bytes in a minimal envelope. Final wire-protocol compatibility requires separate validation.
  const next = { linear: { x: 0.5, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0 } };
  const second = Buffer.from(JSON.stringify({ data: f.codec.encode(next) }), 'utf8');
  queue.enqueue('stream-1', first);
  queue.enqueue('stream-1', second);
  assert.equal(queue.stats().bytes, second.byteLength);
  // Observe the next consumer's value, drop count, and capacity after release.
  const delivered = JSON.parse(Buffer.from(queue.dequeue('stream-1')!).toString('utf8'));
  assert.deepEqual(delivered, { data: next });
  assert.deepEqual(queue.stats(), { streams: 1, bytes: 0, dropped: 1n });
  queue.clear();
  f.guard.close();
});
