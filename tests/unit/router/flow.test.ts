import assert from 'node:assert/strict';
import test from 'node:test';
import { advertise, bytes, fixture } from './fixtures.js';

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
