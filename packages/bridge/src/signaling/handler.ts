import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { serveSignalingDocs } from './docs.js';

/** Authenticated offer exchange. Credentials are injected at runtime and never stored, returned, or logged. */
export interface SignalingOptions {
  readonly credential: string;
  readonly maxBodyBytes: number;
  readonly requestTimeoutMs: number;
  readonly maxPending: number;
  readonly accept: (offer: { type: 'offer'; sdp: string }) => Promise<unknown>;
}

/** Compare Bearer credentials using fixed-length digests. Inputs: issued and presented values; returns true or false. */
export function authenticate(expected: string, supplied: string | undefined): boolean {
  if (supplied === undefined) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(`Bearer ${expected}`), digest(supplied));
}

/** Read JSON with finite capacity. Inputs: request, byte limit, deadline; returns a parsed value. Example: '{}' returns an object. */
async function readBody(request: IncomingMessage, maxBytes: number, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    // Apply an overall deadline to slow clients continuously sending data, not just idle sockets.
    const timer = setTimeout(() => finish(new Error('request_timeout')), timeoutMs);
    /** Remove body listeners. Input: error or result; no return value. Example: end settles the Promise. */
    function finish(error?: Error, value?: unknown): void {
      clearTimeout(timer);
      request.off('data', data).off('end', end).off('aborted', aborted);
      if (error) reject(error); else resolve(value);
    }
    /** Account for a chunk. Input: bytes; no return value. Exceeding the limit produces body_too_large. */
    function data(chunk: Buffer): void {
      size += chunk.length;
      if (size > maxBytes) finish(new Error('body_too_large'));
      else chunks.push(chunk);
    }
    /** Complete a JSON document. No input or return value. Invalid JSON produces bad_request. */
    function end(): void {
      try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(new Error('bad_request')); }
    }
    /** Anonymize socket errors. Ignore the input error; no return value. Example: ECONNRESET becomes bad_request. */
    function failed(): void { finish(new Error('bad_request')); }
    /** Reject aborted requests. No input or return value. Client disconnection produces bad_request. */
    function aborted(): void { finish(new Error('bad_request')); }
    // Handle socket errors after aborted; remove the final error listener on close.
    request.once('close', () => request.off('error', failed));
    request.on('data', data).on('end', end).on('error', failed).on('aborted', aborted);
  });
}

/** Create a handler for an HTTPS server. Input: options; returns a handler. Example: POST /offer with Bearer returns an answer. */
export function createSignalingHandler(options: SignalingOptions) {
  if (typeof options.credential !== 'string' || options.credential.length < 32) throw new Error('invalid_credential');
  for (const value of [options.maxBodyBytes, options.requestTimeoutMs, options.maxPending]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('invalid_limit');
  }
  let pending = 0;
  // Use a startup snapshot so option mutation cannot change authorization or capacity.
  const settings = { ...options };
  /** Handle an HTTP request. Inputs: request/response; returns Promise<void>. An invalid Bearer returns 401. */
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    /** Return status and a JSON response. Example input: (401,'unauthorized'); output: HTTP response. */
    function reply(status: number, body: unknown): void {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Connection': 'close' });
      response.end(JSON.stringify(body));
    }
    if (serveSignalingDocs(request, response)) return;
    if (request.method === 'GET' && request.url === '/health') { reply(200, { status: 'ready' }); return; }
    if (request.method !== 'POST' || request.url !== '/offer') { reply(404, { error: 'not_found' }); return; }
    // Do not accumulate SDP buffers or create PeerConnections before authentication.
    if (!authenticate(settings.credential, request.headers.authorization)) { reply(401, { error: 'unauthorized' }); return; }
    if (request.headers['content-type'] !== 'application/json') { reply(415, { error: 'content_type' }); return; }
    if (pending >= settings.maxPending) { reply(503, { error: 'busy' }); return; }
    pending++;
    try {
      const offer = await readBody(request, settings.maxBodyBytes, settings.requestTimeoutMs);
      if (offer === null || typeof offer !== 'object' || Array.isArray(offer)) throw new Error('bad_request');
      const value = offer as Record<string, unknown>;
      // Delegate SDP validation and peer-creation deadlines to the transport. Reject unknown signaling fields.
      if (Object.keys(value).some(key => key !== 'type' && key !== 'sdp') || value.type !== 'offer' || typeof value.sdp !== 'string') throw new Error('bad_request');
      reply(200, await settings.accept({ type: 'offer', sdp: value.sdp }));
    } catch (error) {
      const reason = error instanceof Error ? error.message : '';
      // Exception text may contain SDP; expose only fixed error classifications in public responses.
      if (reason === 'body_too_large') reply(413, { error: reason });
      else if (reason === 'request_timeout') reply(408, { error: reason });
      else reply(400, { error: 'offer_rejected' });
    } finally {
      pending--;
    }
  };
}
