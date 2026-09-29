import assert from 'node:assert/strict';
import test from 'node:test';
import { advertise, bytes, fixture } from './fixtures.js';
import { commandAuditReason } from '../../../packages/bridge/src/router/index.js';

test('PRO-02: deliver only new samples after hello/catalog, subscribe, and ready', () => {
  const f = fixture();
  f.control({ op: 'hello' });
  assert.equal(f.last().op, 'welcome');
  assert.equal(f.last().catalog.length, 4);
  f.control({ op: 'subscribe', id: 's1', topic: '/out' });
  const id = f.last().stream_id;
  assert.equal(f.last().op, 'subscribed');
  f.emit('/out', { data: 'before' });
  assert.equal(f.output.length, 2);
  f.control({ op: 'ready', stream_id: id });
  f.emit('/out', { data: 'fresh' });
  assert.deepEqual(f.last(), { v: 1, op: 'message', stream_id: id, epoch: 'epoch-1', seq: '0', data: { data: 'fresh' } });
  assert.equal(f.output.at(-1)!.channel, 'ros.reliable.v1');
  // Skip high-rate samples at the same time and send the next interval's sample.
  f.emit('/out', { data: 'rate limited' });
  assert.equal(f.last().seq, '0');
  f.state.now = 10;
  f.emit('/out', { data: 'next' });
  assert.equal(f.last().seq, '1');
  f.control({ op: 'unsubscribe', id: 'u1', stream_id: id });
  f.emit('/out', { data: 'late' });
  assert.equal(f.last().op, 'unsubscribed');
  assert.equal(f.listeners.get('/out')!.size, 0);
  f.router.close();
});

test('ACK-01: validate unguarded publication type/sequence/rate and acknowledge only ROS API success', () => {
  const f = fixture();
  const handle = advertise(f);
  const request = { op: 'publish', handle, epoch: 'epoch-1', seq: '0', data: { data: 'first' } };
  f.router.receive('ros.reliable.v1', bytes(request));
  assert.deepEqual(f.published, [{ topic: '/in', native: { data: 'first' } }]);
  assert.equal(f.last().op, 'published_to_ros');
  f.router.receive('ros.reliable.v1', bytes(request));
  assert.equal(f.last().op, 'error');
  f.router.receive('ros.reliable.v1', bytes({ ...request, seq: '1' }));
  assert.equal(f.published.length, 1);
  f.state.now = 10;
  f.state.publishThrows = true;
  f.router.receive('ros.reliable.v1', bytes({ ...request, seq: '1' }));
  assert.equal(f.last().op, 'error');
  f.state.publishThrows = false;
  f.state.now = 20;
  f.router.receive('ros.reliable.v1', bytes({ ...request, seq: '2' }));
  assert.equal(f.published.length, 2);
  f.control({ op: 'unadvertise', id: 'u1', handle });
  assert.equal(f.last().op, 'unadvertised');
  f.router.receive('ros.reliable.v1', bytes({ ...request, seq: '3' }));
  assert.equal(f.published.length, 2);
  f.router.close();
});

test('CMD-01/CMD-03: validate command arm/lease and exact expiry over the wire', () => {
  const f = fixture();
  const handle = advertise(f, '/cmd');
  f.control({ op: 'arm', id: 'a1', handle });
  const lease = f.last();
  assert.equal(lease.op, 'lease');
  const request = { op: 'publish', handle, epoch: 'epoch-1', seq: '0', lease_id: lease.lease_id, data: { data: 'move' } };
  f.router.receive('ros.realtime.v1', bytes(request));
  assert.equal(f.published.length, 1);
  f.state.now = 250;
  f.router.receive('ros.realtime.v1', bytes({ ...request, seq: '1' }));
  assert.equal(f.last().op, 'error');
  assert.equal(f.published.length, 1);
  f.control({ op: 'unadvertise', id: 'u1', handle });
  assert.equal(f.last().op, 'unadvertised');
  assert.equal(f.guard.stats().handles, 0);
  f.router.close();
});

test('FLOW-01: retain the head under backpressure, prioritize control, and keep only the latest sample', () => {
  const f = fixture();
  f.control({ op: 'hello' });
  f.control({ op: 'subscribe', id: 's1', topic: '/latest' });
  const id = f.last().stream_id;
  f.control({ op: 'ready', stream_id: id });
  f.state.blocked = true;
  f.emit('/latest', { data: 'old' });
  f.state.now = 10;
  f.emit('/latest', { data: 'new' });
  f.control({ op: 'advertise', id: 'a1', topic: '/in' });
  assert.equal(f.output.length, 2);
  f.state.blocked = false;
  f.router.flush();
  assert.equal(f.output[2]!.wire.op, 'advertised');
  assert.equal(f.output[3]!.wire.data.data, 'new');
  assert.equal(f.output[3]!.channel, 'ros.realtime.v1');
  f.router.close();
});

test('PRO-03: perform request effects once within cache TTL and reject conflicting contents', () => {
  const f = fixture();
  f.control({ op: 'hello' });
  const request = { op: 'subscribe', id: 'same', topic: '/out' };
  f.control(request);
  const first = f.last();
  f.control(request);
  assert.deepEqual(f.last(), first);
  assert.equal(f.listeners.get('/out')!.size, 1);
  f.control({ ...request, topic: '/latest' });
  assert.equal(f.last().op, 'error');
  // Release the cache at exact TTL expiry; newly issued IDs differ from old streams.
  f.state.now = 1000;
  f.control(request);
  assert.equal(f.last().op, 'subscribed');
  assert.notEqual(f.last().stream_id, first.stream_id);
  f.router.close();
});

test('CMD-03/LIFE-01: validate shared-guard writer exclusivity across peers and handoff on disconnect', () => {
  const first = fixture();
  const second = fixture(options => ({ ...options, guard: first.guard, epoch: 'epoch-2' }));
  const firstHandle = advertise(first, '/cmd');
  const secondHandle = advertise(second, '/cmd');
  first.control({ op: 'arm', id: 'arm1', handle: firstHandle });
  second.control({ op: 'arm', id: 'arm1', handle: secondHandle });
  assert.equal(first.last().op, 'lease');
  assert.equal(second.last().op, 'error');
  first.router.close();
  second.control({ op: 'arm', id: 'arm2', handle: secondHandle });
  assert.equal(second.last().op, 'lease');
  second.router.receive('ros.realtime.v1', bytes({ op: 'publish', handle: secondHandle, epoch: 'epoch-2', seq: '0', lease_id: second.last().lease_id, data: { data: 'fresh input' } }));
  assert.equal(second.published.length, 1);
  second.router.close();
  assert.deepEqual(first.guard.stats(), { sessions: 0, handles: 0 });
});

test('SEC-01/CMD-01: audit arm and publish with only fixed classifications and local integers', () => {
  const f = fixture();
  const handle = advertise(f, '/cmd');
  f.control({ op: 'arm', id: 'secret-request', handle });
  const lease = f.last();
  f.router.receive('ros.realtime.v1', bytes({ op: 'publish', id: 'secret-request', handle,
    epoch: 'epoch-1', seq: '0', lease_id: lease.lease_id, data: { data: 'payload-canary' } }));
  assert.deepEqual(f.audits.slice(0, 3), [
    { operation: 'peer', outcome: 'opened', peer: 7 },
    { operation: 'arm', outcome: 'accepted', peer: 7, publisher: 1, attempt: 1 },
    { operation: 'publish', outcome: 'accepted', peer: 7, publisher: 1, attempt: 2 },
  ]);
  const serialized = JSON.stringify(f.audits);
  for (const canary of ['secret-request', 'payload-canary', handle, lease.lease_id, 'epoch-1', '/cmd']) assert.equal(serialized.includes(canary), false);
  f.state.now = 250;
  f.router.receive('ros.realtime.v1', bytes({ op: 'publish', handle, epoch: 'epoch-1', seq: '1', lease_id: lease.lease_id, data: { data: 'x' } }));
  assert.equal(f.audits.at(-1)!.outcome, 'rejected');
  assert.equal((f.audits.at(-1) as { reason: string }).reason, 'lease_expired');
  f.router.close();
  assert.deepEqual(f.audits.at(-1), { operation: 'peer', outcome: 'closed', peer: 7 });
});

test('SEC-01: classify command failures without returning arbitrary exception text', () => {
  const expected = new Map<string, string>([
    ['unauthorized', 'unauthorized'], ['unknown_handle', 'unknown_publisher'], ['writer_busy', 'writer_busy'],
    ['epoch_mismatch', 'epoch_mismatch'], ['wrong_channel', 'wrong_channel'],
    ['invalid_owner', 'invalid_lease'], ['invalid_epoch', 'invalid_lease'], ['invalid_lease', 'invalid_lease'],
    ['lease_expired', 'lease_expired'], ['stale_sequence', 'stale_sequence'], ['rate_limited', 'rate_limited'],
  ]);
  for (const [input, output] of expected) assert.equal(commandAuditReason(new Error(input)), output);
  assert.equal(commandAuditReason(new Error('payload-canary'), 'invalid_payload'), 'invalid_payload');
  assert.equal(commandAuditReason(new Error('unauthorized'), 'invalid_payload'), 'invalid_payload');
  assert.equal(commandAuditReason(new Error('lease_expired'), 'ros_publish_failed'), 'ros_publish_failed');
  assert.equal(commandAuditReason('payload-canary'), 'invalid_request');
  assert.equal(commandAuditReason('payload-canary', 'internal'), 'internal');
});

test('CMD-02: distinguish stale, rate, payload, ROS, lease, and writer audit failures', () => {
  const f = fixture();
  const handle = advertise(f);
  const request = { op: 'publish', handle, epoch: 'epoch-1', seq: '0', data: { data: 'ok' } };
  f.router.receive('ros.reliable.v1', bytes({ ...request, epoch: 'old' }));
  f.router.receive('ros.realtime.v1', bytes(request));
  f.router.receive('ros.reliable.v1', bytes(request));
  f.router.receive('ros.reliable.v1', bytes(request));
  f.router.receive('ros.reliable.v1', bytes({ ...request, seq: '1' }));
  f.state.now = 10;
  f.router.receive('ros.reliable.v1', bytes({ ...request, seq: '1', data: { data: 1 } }));
  f.state.publishThrows = true;
  f.router.receive('ros.reliable.v1', bytes({ ...request, seq: '1' }));
  const reasons = f.audits.filter(event => event.operation === 'publish' && event.outcome === 'rejected')
    .map(event => (event as { reason: string }).reason);
  assert.deepEqual(reasons, ['epoch_mismatch', 'wrong_channel', 'stale_sequence', 'rate_limited', 'invalid_payload', 'ros_publish_failed']);
  f.router.close();

  const guarded = fixture();
  const guardedHandle = advertise(guarded, '/cmd');
  guarded.control({ op: 'arm', id: 'a', handle: guardedHandle });
  guarded.router.receive('ros.realtime.v1', bytes({ op: 'publish', handle: guardedHandle, epoch: 'epoch-1', seq: '0',
    lease_id: 'not-the-lease', data: { data: 'x' } }));
  assert.equal((guarded.audits.at(-1) as { reason: string }).reason, 'invalid_lease');
  guarded.router.close();

  const first = fixture();
  const second = fixture(options => ({ ...options, guard: first.guard, epoch: 'epoch-2' }));
  first.control({ op: 'hello' }); second.control({ op: 'hello' });
  first.control({ op: 'advertise', id: 'p', topic: '/cmd' }); const firstHandle = first.last().handle;
  second.control({ op: 'advertise', id: 'p', topic: '/cmd' }); const secondHandle = second.last().handle;
  first.control({ op: 'arm', id: 'a', handle: firstHandle });
  second.control({ op: 'arm', id: 'a', handle: secondHandle });
  assert.equal((second.audits.at(-1) as { reason: string }).reason, 'writer_busy');
  first.router.close(); second.router.close();
});

test('SEC-01: audit observer failure cannot reject a command', () => {
  const f = fixture(options => ({ ...options, audit: { peer: 9, write: () => { throw new Error('diagnostic'); } } }));
  const handle = advertise(f);
  f.router.receive('ros.reliable.v1', bytes({ op: 'publish', handle, epoch: 'epoch-1', seq: '0', data: { data: 'ok' } }));
  assert.equal(f.last().op, 'published_to_ros');
  assert.equal(f.published.length, 1);
  assert.doesNotThrow(() => f.router.close());
});

test('SEC-01: audit unknown publisher attempts without copying the supplied handle', () => {
  const f = fixture();
  f.control({ op: 'hello' });
  f.control({ op: 'arm', id: 'private-id', handle: 'private-handle' });
  assert.deepEqual(f.audits.at(-1), { operation: 'arm', outcome: 'rejected', reason: 'unknown_publisher',
    peer: 7, publisher: 0, attempt: 1 });
  f.router.receive('ros.reliable.v1', bytes({ op: 'publish', handle: 'private-handle', epoch: 'epoch-1', seq: '0', data: { data: 'private' } }));
  assert.deepEqual(f.audits.at(-1), { operation: 'publish', outcome: 'rejected', reason: 'unknown_publisher',
    peer: 7, publisher: 0, attempt: 2 });
  assert.equal(JSON.stringify(f.audits).includes('private'), false);
  f.router.close();
});
