import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionRouter } from '../../../packages/bridge/src/router/index.js';
import type { RouterOptions } from '../../../packages/bridge/src/router/types.js';
import { advertise, bytes, fixture } from './fixtures.js';

test('SEC-01/PRO-01: reject invalid raw UTF-8, JSON, version, channel, and field boundaries', () => {
  const f = fixture();
  for (const raw of [new Uint8Array(), new Uint8Array(1025), Uint8Array.of(255), Buffer.from('{'), Buffer.from('null'), Buffer.from('[]'), Buffer.from('1'), bytes({ v: 2, op: 'hello' }), bytes({ op: 1 }), bytes({ op: 'hello', extra: 1 }), bytes({ op: 'hello', id: 1 })]) {
    f.router.receive('ros.control.v1', raw);
    assert.equal(f.last().op, 'error');
  }
  f.router.receive('extra', bytes({ op: 'hello' }));
  assert.equal(f.last().op, 'error');
  assert.equal(f.published.length, 0);
  f.router.close();
});

test('AUTH-01/PRO-01: enforce default deny, direction, configured Topics, and hello-before-operation', () => {
  const denied = fixture(options => ({ ...options, authorize: undefined }));
  denied.control({ op: 'hello' });
  assert.deepEqual(denied.last().catalog, []);
  denied.control({ op: 'subscribe', id: 's', topic: '/out' });
  assert.equal(denied.last().op, 'error');
  denied.router.close();
  const f = fixture();
  f.control({ op: 'subscribe', id: 's', topic: '/out' });
  assert.equal(f.last().op, 'error');
  f.router.receive('ros.reliable.v1', bytes({ op: 'publish' }));
  assert.equal(f.last().op, 'error');
  f.control({ op: 'hello' });
  for (const wire of [{ op: 'hello' }, { op: 'subscribe', topic: '/out' }, { op: 'subscribe', id: 's', topic: '/in' }, { op: 'subscribe', id: 's', topic: '/unknown' }, { op: 'invalid', id: 's' }, { op: 'ready', stream_id: 'missing' }]) {
    f.control(wire);
    assert.equal(f.last().op, 'error');
  }
  assert.equal(f.published.length, 0);
  assert.equal(f.listeners.size, 0);
  f.router.close();
});

test('TYPE-01/PRO-01/CMD-02: reject publication with invalid channel, epoch, operation, type, or lease', () => {
  const f = fixture();
  const handle = advertise(f);
  const request = { op: 'publish', handle, epoch: 'epoch-1', seq: '0', data: { data: 'ok' } };
  for (const change of [{ epoch: 'old' }, { op: 'message' }, { handle: 'unknown' }, { data: { data: 42 } }, { lease_id: 'unexpected' }, { seq: '00' }]) {
    f.router.receive('ros.reliable.v1', bytes({ ...request, ...change }));
    assert.equal(f.last().op, 'error');
  }
  f.router.receive('ros.realtime.v1', bytes(request));
  assert.equal(f.last().op, 'error');
  f.control({ op: 'arm', id: 'a1', handle });
  assert.equal(f.last().op, 'error');
  assert.equal(f.published.length, 0);
  f.router.close();
});

test('AUTH-02: apply ACL changes and closure inside policy callbacks immediately before publication', () => {
  const f = fixture();
  const handle = advertise(f);
  let calls = 0;
  f.state.authorizeHook = () => { if (++calls === 2) f.state.allowed = false; };
  f.router.receive('ros.reliable.v1', bytes({ op: 'publish', handle, epoch: 'epoch-1', seq: '0', data: { data: 'ok' } }));
  assert.equal(f.last().op, 'error');
  assert.equal(f.published.length, 0);
  f.router.close();
  // Do not reuse old publisher state when reauthorization closes the router.
  const closed = fixture();
  const secondHandle = advertise(closed);
  closed.state.authorizeHook = () => closed.router.close();
  closed.router.receive('ros.reliable.v1', bytes({ op: 'publish', handle: secondHandle, epoch: 'epoch-1', seq: '0', data: { data: 'ok' } }));
  assert.equal(closed.published.length, 0);
  assert.equal(closed.guard.stats().sessions, 0);
});

test('CFG-01/SEC-01: validate router limits, clocks, and bindings at initialization', () => {
  const base = fixture();
  const options = base.options;
  for (const limits of [{ ...options.limits, maxHandles: 0 }, { ...options.limits, maxRequests: NaN }]) {
    assert.throws(() => new SessionRouter({ ...options, limits }), /invalid_limit/);
  }
  for (const clock of [() => NaN, () => -1, () => Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => new SessionRouter({ ...options, clock }), /invalid_clock/);
  }
  assert.throws(() => new SessionRouter({ ...options, clock: null } as unknown as RouterOptions), /invalid_callback/);
  assert.throws(() => new SessionRouter({ ...options, send: null } as unknown as RouterOptions), /invalid_callback/);
  assert.throws(() => new SessionRouter({ ...options, limits: { ...options.limits, requestTtlMs: undefined } } as unknown as RouterOptions), /invalid_limit/);
  assert.throws(() => new SessionRouter({ ...options, bindings: [options.bindings[0]!, options.bindings[0]!] }), /invalid_binding/);
  const foreign = { ...options.bindings[0]!, binding: { ...options.bindings[0]!.binding } };
  assert.throws(() => new SessionRouter({ ...options, bindings: [foreign] }), /invalid_binding/);
  assert.equal(base.guard.stats().sessions, 1);
  base.router.close();
});

test('FLOW-02: enforce control rate and registry/cache limits before side effects', () => {
  for (const limit of ['maxHandles', 'maxRequests', 'maxControlRateHz'] as const) {
    const f = fixture(options => ({ ...options, limits: { ...options.limits, [limit]: 1 } }));
    f.control({ op: 'hello' });
    f.control({ op: 'subscribe', id: 's1', topic: '/out' });
    f.control({ op: 'subscribe', id: 's2', topic: '/out' });
    assert.equal(f.last().op, 'error');
    assert.ok((f.listeners.get('/out')?.size ?? 0) <= 1);
    f.router.close();
  }
  // Do not begin new side effects without cache space for the request and maximum response.
  const small = fixture(options => ({ ...options, config: { ...options.config, limits: { ...options.config.limits, maxPeerQueueBytes: 1024 } } }));
  small.control({ op: 'hello' });
  small.control({ op: 'subscribe', id: 's1', topic: '/out' });
  assert.equal(small.last().op, 'error');
  assert.equal(small.listeners.size, 0);
  small.router.close();
});
