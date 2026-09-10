import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 認証済みoffer交換。credentialは実行時注入し、保存・応答・logへ含めない。 */
export interface SignalingOptions {
  readonly credential: string;
  readonly maxBodyBytes: number;
  readonly requestTimeoutMs: number;
  readonly maxPending: number;
  readonly accept: (offer: { type: 'offer'; sdp: string }) => Promise<unknown>;
}

/** Bearer credentialを一定長digestで比較する。入力例: 発行値/提示値、出力trueまたはfalse。 */
export function authenticate(expected: string, supplied: string | undefined): boolean {
  if (supplied === undefined) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(`Bearer ${expected}`), digest(supplied));
}

/** JSONを有限容量で読み取る。入力request/byte上限/期限、出力parsed値。例: '{}' → object。 */
async function readBody(request: IncomingMessage, maxBytes: number, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    // socket無通信だけでなく、低速送信を続けるclientにも全体期限を適用する。
    const timer = setTimeout(() => finish(new Error('request_timeout')), timeoutMs);
    /** body listenerを解除する。入力errorまたは結果、出力なし。例: end → promiseを完了。 */
    function finish(error?: Error, value?: unknown): void {
      clearTimeout(timer);
      request.off('data', data).off('end', end).off('aborted', aborted);
      if (error) reject(error); else resolve(value);
    }
    /** chunkを計上する。入力bytes、出力なし。例: 上限超過 → body_too_large。 */
    function data(chunk: Buffer): void {
      size += chunk.length;
      if (size > maxBytes) finish(new Error('body_too_large'));
      else chunks.push(chunk);
    }
    /** JSON文書として完了する。入力なし、出力なし。不正JSONはbad_request。 */
    function end(): void {
      try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(new Error('bad_request')); }
    }
    /** socket例外を匿名化する。入力errorは使用せず、出力なし。例: ECONNRESET → bad_request。 */
    function failed(): void { finish(new Error('bad_request')); }
    /** 中断を拒否する。入力なし、出力なし。例: client切断 → bad_request。 */
    function aborted(): void { finish(new Error('bad_request')); }
    // aborted後のsocket errorも処理し、closeで最後のerror listenerを解放する。
    request.once('close', () => request.off('error', failed));
    request.on('data', data).on('end', end).on('error', failed).on('aborted', aborted);
  });
}

/** HTTPS serverへ渡すhandlerを作る。入力options、出力handler。例: POST /offer + Bearer → answer。 */
export function createSignalingHandler(options: SignalingOptions) {
  if (typeof options.credential !== 'string' || options.credential.length < 32) throw new Error('invalid_credential');
  for (const value of [options.maxBodyBytes, options.requestTimeoutMs, options.maxPending]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('invalid_limit');
  }
  let pending = 0;
  // optionsの書換えで認可や容量が変わらないよう、起動時snapshotを使う。
  const settings = { ...options };
  /** HTTP要求を処理する。入力request/response、出力Promise<void>。例: 不正Bearer → 401。 */
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    /** statusとJSON応答を返す。入力例: (401,'unauthorized')、出力HTTP応答。 */
    function reply(status: number, body: unknown): void {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Connection': 'close' });
      response.end(JSON.stringify(body));
    }
    if (request.method === 'GET' && request.url === '/health') { reply(200, { status: 'ready' }); return; }
    if (request.method !== 'POST' || request.url !== '/offer') { reply(404, { error: 'not_found' }); return; }
    // 認証前にSDPをbufferへ蓄積したりPeerConnectionを生成したりしない。
    if (!authenticate(settings.credential, request.headers.authorization)) { reply(401, { error: 'unauthorized' }); return; }
    if (request.headers['content-type'] !== 'application/json') { reply(415, { error: 'content_type' }); return; }
    if (pending >= settings.maxPending) { reply(503, { error: 'busy' }); return; }
    pending++;
    try {
      const offer = await readBody(request, settings.maxBodyBytes, settings.requestTimeoutMs);
      if (offer === null || typeof offer !== 'object' || Array.isArray(offer)) throw new Error('bad_request');
      const value = offer as Record<string, unknown>;
      // SDP内容の検証とpeer生成期限はtransportへ委譲する。未知のsignaling値を取り込まない。
      if (Object.keys(value).some(key => key !== 'type' && key !== 'sdp') || value.type !== 'offer' || typeof value.sdp !== 'string') throw new Error('bad_request');
      reply(200, await settings.accept({ type: 'offer', sdp: value.sdp }));
    } catch (error) {
      const reason = error instanceof Error ? error.message : '';
      // 例外本文にはSDP等が入りうるため、公開応答には固定の分類だけを使う。
      if (reason === 'body_too_large') reply(413, { error: reason });
      else if (reason === 'request_timeout') reply(408, { error: reason });
      else reply(400, { error: 'offer_rejected' });
    } finally {
      pending--;
    }
  };
}
