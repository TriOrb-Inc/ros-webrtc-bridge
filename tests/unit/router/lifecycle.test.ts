import assert from 'node:assert/strict';
import test from 'node:test';
import { bytes, fixture } from './fixtures.js';

test('FLOW-01/LIFE-01: reliable saturation stops the stream and releases listeners', () => {
  const f = fixture();
  f.control({ op: 'hello' });
  f.control({ op: 'subscribe', id: 's1', topic: '/out' });
  f.control({ op: 'ready', stream_id: f.last().stream_id });
  f.state.blocked = true;
  for (const time of [0, 10, 20]) { f.state.now = time; f.emit('/out', { data: 'sample' }); }
  assert.equal(f.listeners.get('/out')!.size, 0);
  f.state.blocked = false;
  f.router.flush();
  assert.equal(f.last().op, 'error');
  assert.equal(f.output.filter(output => output.wire.op === 'message').length, 0);
  f.router.close();
});

test('SIZE-01/TYPE-01: invalid or oversized ROS samples stop the affected stream', () => {
  for (const data of [{ data: 42 }, { data: 'x'.repeat(2000) }]) {
    const f = fixture();
    f.control({ op: 'hello' });
    f.control({ op: 'subscribe', id: 's1', topic: '/out' });
    f.control({ op: 'ready', stream_id: f.last().stream_id });
    f.emit('/out', data);
    assert.equal(f.last().op, 'error');
    assert.equal(f.listeners.get('/out')!.size, 0);
    f.router.close();
  }
});

test('AUTH-02: do not send ROS samples after delivery policy revocation or close', () => {
  for (const close of [false, true]) {
    const f = fixture();
    f.control({ op: 'hello' });
    f.control({ op: 'subscribe', id: 's1', topic: '/out' });
    f.control({ op: 'ready', stream_id: f.last().stream_id });
    if (close) f.state.authorizeHook = () => f.router.close();
    else f.state.allowed = false;
    f.emit('/out', { data: 'denied' });
    assert.equal(f.output.filter(output => output.wire.op === 'message').length, 0);
    assert.equal(f.listeners.get('/out')!.size, 0);
    f.router.close();
  }
});

test('LIFE-01: distinguish subscription retry after failure from cleanup failure of all listeners', () => {
  const f = fixture();
  f.control({ op: 'hello' });
  f.state.subscribeThrows = true;
  f.control({ op: 'subscribe', id: 's1', topic: '/out' });
  assert.equal(f.last().op, 'error');
  f.state.subscribeThrows = false;
  f.control({ op: 'subscribe', id: 's1', topic: '/out' });
  f.control({ op: 'subscribe', id: 's2', topic: '/latest' });
  assert.equal(f.last().op, 'subscribed');
  f.state.cleanupThrows = true;
  assert.throws(() => f.router.close(), AggregateError);
  assert.equal(f.listeners.get('/out')!.size, 0);
  assert.equal(f.listeners.get('/latest')!.size, 0);
  assert.deepEqual(f.guard.stats(), { sessions: 0, handles: 0 });
  const responses = f.output.length;
  f.router.close(); f.router.flush();
  f.router.receive('ros.control.v1', bytes({ op: 'hello' }));
  assert.equal(f.output.length, responses);
});

test('FLOW-02: close the peer on control overflow and send exceptions', () => {
  for (const throws of [false, true]) {
    const f = fixture(options => ({ ...options, limits: { ...options.limits, maxRequests: 1 } }));
    assert.equal(f.router.isClosed, false);
    f.state.blocked = !throws;
    f.state.sendThrows = throws;
    f.control({ op: 'hello' });
    f.control({ op: 'invalid', id: 's1' });
    assert.deepEqual(f.guard.stats(), { sessions: 0, handles: 0 });
    assert.equal(f.router.isClosed, true);
    f.router.close();
  }
});

test('AUTH-02: do not send a response when closed during welcome generation', () => {
  const f = fixture();
  f.state.authorizeHook = () => f.router.close();
  f.control({ op: 'hello' });
  assert.equal(f.output.length, 0);
  assert.equal(f.guard.stats().sessions, 0);
});

test('AUTH-02: discard backpressured telemetry when the ACL is revoked before flush', () => {
  for (const close of [false, true]) {
    const f = fixture();
    f.control({ op: 'hello' });
    f.control({ op: 'subscribe', id: 's1', topic: '/out' });
    f.control({ op: 'ready', stream_id: f.last().stream_id });
    f.state.blocked = true;
    f.emit('/out', { data: 'waiting' });
    if (close) f.state.authorizeHook = () => f.router.close();
    else f.state.allowed = false;
    f.state.blocked = false;
    f.router.flush();
    assert.equal(f.output.filter(output => output.wire.op === 'message').length, 0);
    assert.equal(f.listeners.get('/out')!.size, 0);
    f.router.close();
  }
});

test('LIFE-01: notify onClosed exactly once after cleanup even when release fails', () => {
  for (const cleanupThrows of [false, true]) {
    let notifications = 0;
    const f = fixture(options => ({ ...options, onClosed: () => {
      notifications++;
      assert.equal(f.router.isClosed, true);
      assert.equal(f.guard.stats().sessions, 0);
      assert.equal(f.listeners.get('/out')!.size, 0);
    } }));
    f.control({ op: 'hello' });
    f.control({ op: 'subscribe', id: 's1', topic: '/out' });
    f.state.cleanupThrows = cleanupThrows;
    if (cleanupThrows) assert.throws(() => f.router.close(), AggregateError);
    else f.router.close();
    f.router.close();
    assert.equal(notifications, 1);
  }
});
