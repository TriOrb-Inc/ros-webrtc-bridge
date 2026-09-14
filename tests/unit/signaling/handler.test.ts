import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import { authenticate, createSignalingHandler, type SignalingOptions } from '../../../packages/bridge/src/signaling/handler.js';

const credential = randomBytes(32).toString('hex');
/** Create an I/O boundary. Input: options; output: request/response/execution promise. Example: end('{}') produces status 400. */
function exchange(overrides: Partial<SignalingOptions> = {}, requestOverride: object = {}) {
  const handler = createSignalingHandler({ credential, maxBodyBytes: 256, requestTimeoutMs: 20, maxPending: 1,
    accept: async () => ({ type: 'answer', sdp: 'fixture' }), ...overrides });
  const request = Object.assign(new EventEmitter(), { method: 'POST', url: '/offer',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' } }, requestOverride);
  // Observe status, response body, and headers and assert that secrets are not returned.
  let status = 0;
  let body = '';
  let headers: unknown;
  const response = { writeHead(code: number, value: unknown) { status = code; headers = value; }, end(value: string) { body = value; } };
  const pending = handler(request as IncomingMessage, response as ServerResponse);
  return { request, response, pending, handler, result: () => ({ status, body: JSON.parse(body), headers }) };
}

test('AUTH-01 signaling neither processes offers before authentication nor returns credentials', async () => {
  assert.equal(authenticate(credential, undefined), false);
  assert.equal(authenticate(credential, 'Bearer invalid'), false);
  assert.equal(authenticate(credential, `Bearer ${credential}`), true);
  // Reject missing authentication, wrong paths, methods, and media types independently.
  for (const [override, status] of [[{ headers: {} }, 401], [{ url: '/other' }, 404], [{ method: 'PUT' }, 404],
    [{ headers: { authorization: `Bearer ${credential}` } }, 415]] as const) {
    const value = exchange({ accept: async () => assert.fail('must not accept') }, override);
    await value.pending;
    assert.equal(value.result().status, status);
  }
  const health = exchange({}, { method: 'GET', url: '/health' });
  await health.pending;
  assert.deepEqual(health.result().body, { status: 'ready' });
});

test('PRO-01 signaling forwards only valid offers and returns answers with no-store', async () => {
  let calls = 0;
  const value = exchange({ accept: async offer => { calls++; assert.deepEqual(offer, { type: 'offer', sdp: 'v=0' }); return { type: 'answer' }; } });
  value.request.emit('data', Buffer.from('{"type":"offer",'));
  value.request.emit('data', Buffer.from('"sdp":"v=0"}'));
  value.request.emit('end');
  // Verify both HTTP completion and error-listener release.
  await value.pending;
  value.request.emit('close');
  assert.equal(calls, 1);
  assert.equal(value.result().status, 200);
  assert.equal(value.request.listenerCount('error'), 0);
  assert.deepEqual(value.result().headers, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Connection': 'close' });
});

test('SEC-01 anonymize invalid JSON, offer types, unknown fields, and transport exceptions', async () => {
  for (const data of ['{', 'null', '3', '[]', '{}', '{"type":"answer","sdp":"x"}',
    '{"type":"offer","sdp":3}', '{"type":"offer","sdp":"x","extra":1}']) {
    const value = exchange();
    value.request.emit('data', Buffer.from(data));
    value.request.emit('end');
    await value.pending;
    assert.deepEqual(value.result().body, { error: 'offer_rejected' });
  }
  // Do not expose external exception messages or non-Error values over HTTP.
  for (const error of [new Error(credential), credential]) {
    const value = exchange({ accept: async () => { throw error; } });
    value.request.emit('data', Buffer.from('{"type":"offer","sdp":"x"}'));
    value.request.emit('end');
    await value.pending;
    assert.equal(value.result().status, 400);
    assert.deepEqual(value.result().body, { error: 'offer_rejected' });
  }
});

test('SEC-01 distinguish body limits, deadlines, aborts, and errors while releasing listeners', async () => {
  const large = exchange({ maxBodyBytes: 1 });
  large.request.emit('data', Buffer.from('{}'));
  await large.pending;
  assert.equal(large.result().status, 413);
  // Incremental data arrival must not extend the overall timeout.
  const slow = exchange({ requestTimeoutMs: 1 });
  await slow.pending;
  assert.equal(slow.result().status, 408);
  for (const event of ['error', 'aborted']) {
    const value = exchange();
    value.request.emit(event, new Error('socket failure'));
    await value.pending;
    value.request.emit('error', new Error('late error'));
    assert.equal(value.result().status, 400);
    value.request.emit('close');
    assert.equal(value.request.listenerCount('data'), 0);
  }
});

test('FLOW-02 bound concurrent pending requests and return slots on completion', async () => {
  const first = exchange();
  const secondRequest = Object.assign(new EventEmitter(), { method: 'POST', url: '/offer', headers: {
    authorization: `Bearer ${credential}`, 'content-type': 'application/json' } });
  await first.handler(secondRequest as IncomingMessage, first.response as ServerResponse);
  assert.equal(first.result().status, 503);
  // The first failure must restore the pending count too.
  first.request.emit('end');
  await first.pending;
  const next = first.handler(secondRequest as IncomingMessage, first.response as ServerResponse);
  secondRequest.emit('data', Buffer.from('{"type":"offer","sdp":"x"}'));
  secondRequest.emit('end');
  await next;
  assert.equal(first.result().status, 200);
});

test('CFG-01 reject invalid credential and capacity settings at startup', () => {
  for (const value of ['', 3]) assert.throws(() => exchange({ credential: value as string }), /credential/);
  for (const value of [0, -1, 0.5, NaN, Infinity]) assert.throws(() => exchange({ maxPending: value }), /limit/);
});
