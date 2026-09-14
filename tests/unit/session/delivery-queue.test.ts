import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeliveryQueue } from '../../../packages/bridge/src/session/delivery-queue.js';

/** Create a small queue. Example: () returns a queue with a four-byte limit. @returns Queue */
function queue(): DeliveryQueue {
  return new DeliveryQueue({ maxStreams: 3, maxBytes: 4, maxMessageBytes: 4 });
}

test('FLOW-01/SIZE-01: latest replacement, exact byte limits, copy ownership, and drop measurements', () => {
  const q = queue();
  q.register('odom', 'latest', 1);
  const input = Uint8Array.of(1, 2, 3);
  assert.equal(q.enqueue('odom', input), true);
  input[0] = 99;
  assert.deepEqual(q.dequeue('odom'), Uint8Array.of(1, 2, 3));
  // Accept an update from three to four bytes because it exactly matches the peer limit.
  q.enqueue('odom', Uint8Array.of(1, 2, 3));
  assert.equal(q.enqueue('odom', Uint8Array.of(4, 5, 6, 7)), true);
  assert.deepEqual(q.stats(), { bytes: 4, streams: 1, dropped: 1n });
  assert.deepEqual(q.dequeue('odom'), Uint8Array.of(4, 5, 6, 7));
  assert.equal(q.dequeue('odom'), undefined);
  assert.equal(q.stats().bytes, 0);
});

test('FLOW-01: reliable FIFO count overflow stops the stream and releases pending bytes', () => {
  const q = queue();
  q.register('events', 'reliable', 2);
  q.enqueue('events', Uint8Array.of(1));
  q.enqueue('events', Uint8Array.of(2));
  assert.deepEqual(q.dequeue('events'), Uint8Array.of(1));
  assert.deepEqual(q.dequeue('events'), Uint8Array.of(2));
  // After checking order, saturate another batch and verify byte release as a side effect.
  q.enqueue('events', Uint8Array.of(3));
  q.enqueue('events', Uint8Array.of(4));
  assert.throws(() => q.enqueue('events', Uint8Array.of(5)), /slow_consumer/);
  assert.equal(q.stats().bytes, 0);
  assert.throws(() => q.enqueue('events', Uint8Array.of(6)), /slow_consumer/);
  assert.throws(() => q.dequeue('events'), /slow_consumer/);
  q.closeStream('events');
  q.register('events', 'reliable', 1);
  assert.equal(q.enqueue('events', Uint8Array.of(7)), true);
});

test('FLOW-01/FLOW-02: peer byte limits, peer isolation, and old/new latest-value drops', () => {
  const slow = queue();
  const healthy = queue();
  slow.register('reliable', 'reliable', 10);
  slow.register('latest', 'latest', 1);
  healthy.register('latest', 'latest', 1);
  slow.enqueue('reliable', Uint8Array.of(1, 2, 3));
  // If discarding the stream's old value is insufficient, discard the new value too and preserve other streams.
  slow.enqueue('latest', Uint8Array.of(1));
  assert.equal(slow.enqueue('latest', Uint8Array.of(8, 9)), false);
  assert.deepEqual(slow.stats(), { bytes: 3, streams: 2, dropped: 2n });
  assert.equal(slow.dequeue('latest'), undefined);
  assert.equal(healthy.enqueue('latest', Uint8Array.of(9, 8, 7, 6)), true);
  assert.deepEqual(healthy.dequeue('latest'), Uint8Array.of(9, 8, 7, 6));
  // Apply the same stop contract when reliable data exceeds bytes but not item count.
  assert.throws(() => slow.enqueue('reliable', Uint8Array.of(4, 5)), /slow_consumer/);
  assert.equal(slow.stats().bytes, 0);
});

test('SEC-01/SIZE-01: reject invalid payloads at the boundary without changing state', () => {
  const q = queue();
  q.register('s', 'latest', 1);
  q.enqueue('s', Uint8Array.of(42));
  for (const value of [new Uint8Array(0), new Uint8Array(5), 'abc', null]) {
    assert.throws(() => q.enqueue('s', value as Uint8Array), /message_size/);
    assert.deepEqual(q.stats(), { bytes: 1, streams: 1, dropped: 0n });
  }
  assert.deepEqual(q.dequeue('s'), Uint8Array.of(42));
});

test('LIFE-01: registration limits, duplicates, release, and clear reclaim all occupancy', () => {
  const q = queue();
  for (const id of ['a', 'b', 'c']) q.register(id, 'reliable', 1);
  assert.throws(() => q.register('d', 'latest', 1), /stream_limit/);
  assert.throws(() => q.register('a', 'latest', 1), /duplicate_stream/);
  q.enqueue('a', Uint8Array.of(1));
  q.enqueue('b', Uint8Array.of(2));
  // Close releases only the selected stream and preserves remaining stream payloads.
  q.closeStream('a');
  assert.deepEqual(q.stats(), { bytes: 1, streams: 2, dropped: 0n });
  assert.deepEqual(q.dequeue('b'), Uint8Array.of(2));
  q.register('d', 'latest', 1);
  q.enqueue('d', Uint8Array.of(3));
  q.clear();
  assert.deepEqual(q.stats(), { bytes: 0, streams: 0, dropped: 0n });
  assert.throws(() => q.dequeue('d'), /unknown_stream/);
  assert.throws(() => q.closeStream('a'), /unknown_stream/);
  q.clear();
});

test('CFG-01: reject invalid queue configuration and policies without partial streams', () => {
  const options = { maxStreams: 3, maxBytes: 4, maxMessageBytes: 4 };
  for (const key of ['maxStreams', 'maxBytes', 'maxMessageBytes']) {
    assert.throws(() => new DeliveryQueue({ ...options, [key]: 0 }), /invalid_limit/);
  }
  assert.throws(() => new DeliveryQueue({ ...options, maxMessageBytes: 5 }), /invalid_limit/);
  const q = queue();
  // Registration failure from invalid settings must not consume finite registry slots.
  assert.throws(() => q.register('', 'latest', 1), /invalid_identifier/);
  assert.throws(() => q.register('s', 'bad' as 'latest', 1), /invalid_policy/);
  assert.throws(() => q.register('s', 'latest', 2), /invalid_limit/);
  assert.throws(() => q.register('s', 'reliable', 0), /invalid_limit/);
  assert.deepEqual(q.stats(), { bytes: 0, streams: 0, dropped: 0n });
});

test('SEC-01: reject trailing newlines in stream identifiers without leaving registrations', () => {
  const q = queue();
  for (const ending of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    assert.throws(() => q.register(`stream${ending}`, 'latest', 1), /invalid_identifier/);
  }
  assert.deepEqual(q.stats(), { bytes: 0, streams: 0, dropped: 0n });
});

test('FLOW-01: peek returns a copy and preserves byte occupancy and payload until dequeue', () => {
  const q = queue();
  q.register('s', 'reliable', 1);
  assert.equal(q.peek('s'), undefined);
  q.enqueue('s', Uint8Array.of(42));
  q.peek('s')![0] = 0;
  assert.equal(q.stats().bytes, 1);
  assert.deepEqual(q.dequeue('s'), Uint8Array.of(42));
  q.enqueue('s', Uint8Array.of(42));
  assert.throws(() => q.enqueue('s', Uint8Array.of(43)), /slow_consumer/);
  assert.throws(() => q.peek('s'), /slow_consumer/);
});
