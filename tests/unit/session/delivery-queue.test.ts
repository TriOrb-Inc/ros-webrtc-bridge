import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeliveryQueue } from '../../../packages/bridge/src/session/delivery-queue.js';

/** 小さいqueueを生成する。入力例: ()、出力例: 4byte上限queue。@returns queue */
function queue(): DeliveryQueue {
  return new DeliveryQueue({ maxStreams: 3, maxBytes: 4, maxMessageBytes: 4 });
}

test('FLOW-01/SIZE-01: latest置換、byte上限一致、copy所有権とdrop計測', () => {
  const q = queue();
  q.register('odom', 'latest', 1);
  const input = Uint8Array.of(1, 2, 3);
  assert.equal(q.enqueue('odom', input), true);
  input[0] = 99;
  assert.deepEqual(q.dequeue('odom'), Uint8Array.of(1, 2, 3));
  // 3→4byteの更新でもpeer上限に一致するため受理する。
  q.enqueue('odom', Uint8Array.of(1, 2, 3));
  assert.equal(q.enqueue('odom', Uint8Array.of(4, 5, 6, 7)), true);
  assert.deepEqual(q.stats(), { bytes: 4, streams: 1, dropped: 1n });
  assert.deepEqual(q.dequeue('odom'), Uint8Array.of(4, 5, 6, 7));
  assert.equal(q.dequeue('odom'), undefined);
  assert.equal(q.stats().bytes, 0);
});

test('FLOW-01: reliable FIFOの件数超過は停止しpending byteを解放', () => {
  const q = queue();
  q.register('events', 'reliable', 2);
  q.enqueue('events', Uint8Array.of(1));
  q.enqueue('events', Uint8Array.of(2));
  assert.deepEqual(q.dequeue('events'), Uint8Array.of(1));
  assert.deepEqual(q.dequeue('events'), Uint8Array.of(2));
  // 順序確認後に別のbatchを飽和させ、副作用としてbyte解放を確認する。
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

test('FLOW-01/FLOW-02: peer byte上限と別peer分離、latestの旧/新値破棄', () => {
  const slow = queue();
  const healthy = queue();
  slow.register('reliable', 'reliable', 10);
  slow.register('latest', 'latest', 1);
  healthy.register('latest', 'latest', 1);
  slow.enqueue('reliable', Uint8Array.of(1, 2, 3));
  // 自streamの旧値を捨てても足りなければ新値も捨て、他streamは維持する。
  slow.enqueue('latest', Uint8Array.of(1));
  assert.equal(slow.enqueue('latest', Uint8Array.of(8, 9)), false);
  assert.deepEqual(slow.stats(), { bytes: 3, streams: 2, dropped: 2n });
  assert.equal(slow.dequeue('latest'), undefined);
  assert.equal(healthy.enqueue('latest', Uint8Array.of(9, 8, 7, 6)), true);
  assert.deepEqual(healthy.dequeue('latest'), Uint8Array.of(9, 8, 7, 6));
  // 件数内でもbyte上限を超えたreliableは同じ停止契約を適用する。
  assert.throws(() => slow.enqueue('reliable', Uint8Array.of(4, 5)), /slow_consumer/);
  assert.equal(slow.stats().bytes, 0);
});

test('SEC-01/SIZE-01: invalid payloadは状態を変えず境界で拒否', () => {
  const q = queue();
  q.register('s', 'latest', 1);
  q.enqueue('s', Uint8Array.of(42));
  for (const value of [new Uint8Array(0), new Uint8Array(5), 'abc', null]) {
    assert.throws(() => q.enqueue('s', value as Uint8Array), /message_size/);
    assert.deepEqual(q.stats(), { bytes: 1, streams: 1, dropped: 0n });
  }
  assert.deepEqual(q.dequeue('s'), Uint8Array.of(42));
});

test('LIFE-01: 登録上限、重複、解放、clearで全占有量を回収', () => {
  const q = queue();
  for (const id of ['a', 'b', 'c']) q.register(id, 'reliable', 1);
  assert.throws(() => q.register('d', 'latest', 1), /stream_limit/);
  assert.throws(() => q.register('a', 'latest', 1), /duplicate_stream/);
  q.enqueue('a', Uint8Array.of(1));
  q.enqueue('b', Uint8Array.of(2));
  // closeは指定streamだけを解放し、残るstreamのpayloadを維持する。
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

test('CFG-01: queue設定とpolicyを拒否しpartial streamを残さない', () => {
  const options = { maxStreams: 3, maxBytes: 4, maxMessageBytes: 4 };
  for (const key of ['maxStreams', 'maxBytes', 'maxMessageBytes']) {
    assert.throws(() => new DeliveryQueue({ ...options, [key]: 0 }), /invalid_limit/);
  }
  assert.throws(() => new DeliveryQueue({ ...options, maxMessageBytes: 5 }), /invalid_limit/);
  const q = queue();
  // 不正設定による登録失敗は有限registryを消費しない。
  assert.throws(() => q.register('', 'latest', 1), /invalid_identifier/);
  assert.throws(() => q.register('s', 'bad' as 'latest', 1), /invalid_policy/);
  assert.throws(() => q.register('s', 'latest', 2), /invalid_limit/);
  assert.throws(() => q.register('s', 'reliable', 0), /invalid_limit/);
  assert.deepEqual(q.stats(), { bytes: 0, streams: 0, dropped: 0n });
});

test('SEC-01: stream識別子の末尾改行を拒否し登録を残さない', () => {
  const q = queue();
  for (const ending of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    assert.throws(() => q.register(`stream${ending}`, 'latest', 1), /invalid_identifier/);
  }
  assert.deepEqual(q.stats(), { bytes: 0, streams: 0, dropped: 0n });
});
