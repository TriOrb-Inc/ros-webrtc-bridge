import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import { authenticate, createSignalingHandler, type SignalingOptions } from '../../../packages/bridge/src/signaling/handler.js';

const credential = randomBytes(32).toString('hex');
/** I/O境界を作る。入力options、出力request/response/実行promise。例: end('{}') → status400。 */
function exchange(overrides: Partial<SignalingOptions> = {}, requestOverride: object = {}) {
  const handler = createSignalingHandler({ credential, maxBodyBytes: 256, requestTimeoutMs: 20, maxPending: 1,
    accept: async () => ({ type: 'answer', sdp: 'fixture' }), ...overrides });
  const request = Object.assign(new EventEmitter(), { method: 'POST', url: '/offer',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' } }, requestOverride);
  // status・応答body・headersを観測し、秘密値が戻らないことをassertする。
  let status = 0;
  let body = '';
  let headers: unknown;
  const response = { writeHead(code: number, value: unknown) { status = code; headers = value; }, end(value: string) { body = value; } };
  const pending = handler(request as IncomingMessage, response as ServerResponse);
  return { request, response, pending, handler, result: () => ({ status, body: JSON.parse(body), headers }) };
}

test('AUTH-01 signalingは認証前にofferを処理せず、認証値を返さない', async () => {
  assert.equal(authenticate(credential, undefined), false);
  assert.equal(authenticate(credential, 'Bearer invalid'), false);
  assert.equal(authenticate(credential, `Bearer ${credential}`), true);
  // 認証不足・path・method・media typeを独立に拒否する。
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

test('PRO-01 signaling正常offerだけをtransportへ渡しno-storeでanswerを返す', async () => {
  let calls = 0;
  const value = exchange({ accept: async offer => { calls++; assert.deepEqual(offer, { type: 'offer', sdp: 'v=0' }); return { type: 'answer' }; } });
  value.request.emit('data', Buffer.from('{"type":"offer",'));
  value.request.emit('data', Buffer.from('"sdp":"v=0"}'));
  value.request.emit('end');
  // HTTP完了とerror listener解放の両方を確認する。
  await value.pending;
  value.request.emit('close');
  assert.equal(calls, 1);
  assert.equal(value.result().status, 200);
  assert.equal(value.request.listenerCount('error'), 0);
  assert.deepEqual(value.result().headers, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Connection': 'close' });
});

test('SEC-01 不正JSON・offer型・未知field・transport例外を匿名化する', async () => {
  for (const data of ['{', 'null', '3', '[]', '{}', '{"type":"answer","sdp":"x"}',
    '{"type":"offer","sdp":3}', '{"type":"offer","sdp":"x","extra":1}']) {
    const value = exchange();
    value.request.emit('data', Buffer.from(data));
    value.request.emit('end');
    await value.pending;
    assert.deepEqual(value.result().body, { error: 'offer_rejected' });
  }
  // 外部例外のmessageや非Error値をHTTPへ反映しない。
  for (const error of [new Error(credential), credential]) {
    const value = exchange({ accept: async () => { throw error; } });
    value.request.emit('data', Buffer.from('{"type":"offer","sdp":"x"}'));
    value.request.emit('end');
    await value.pending;
    assert.equal(value.result().status, 400);
    assert.deepEqual(value.result().body, { error: 'offer_rejected' });
  }
});

test('SEC-01 body上限・期限・中断・errorを区別してlistenerを解放する', async () => {
  const large = exchange({ maxBodyBytes: 1 });
  large.request.emit('data', Buffer.from('{}'));
  await large.pending;
  assert.equal(large.result().status, 413);
  // データが少しずつ届いても全体timeoutを延長しない。
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

test('FLOW-02 同時pendingを制限し、終了後に枠を返す', async () => {
  const first = exchange();
  const secondRequest = Object.assign(new EventEmitter(), { method: 'POST', url: '/offer', headers: {
    authorization: `Bearer ${credential}`, 'content-type': 'application/json' } });
  await first.handler(secondRequest as IncomingMessage, first.response as ServerResponse);
  assert.equal(first.result().status, 503);
  // 最初の失敗もpending件数を戻す。
  first.request.emit('end');
  await first.pending;
  const next = first.handler(secondRequest as IncomingMessage, first.response as ServerResponse);
  secondRequest.emit('data', Buffer.from('{"type":"offer","sdp":"x"}'));
  secondRequest.emit('end');
  await next;
  assert.equal(first.result().status, 200);
});

test('CFG-01 credential・容量の不正設定を起動時に拒否する', () => {
  for (const value of ['', 3]) assert.throws(() => exchange({ credential: value as string }), /credential/);
  for (const value of [0, -1, 0.5, NaN, Infinity]) assert.throws(() => exchange({ maxPending: value }), /limit/);
});
