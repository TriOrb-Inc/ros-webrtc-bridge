interface Cached { readonly input: string; readonly output: Uint8Array; readonly expires: number; readonly bytes: number }

/** Finite cache preventing duplicate side effects for a request ID within its lifetime. */
export class RequestCache {
  private readonly entries = new Map<string, Cached>();
  private bytes = 0;
  /** Limits have already been validated by the router. Inputs: entry limit, TTL in ms, byte limit, e.g. (4,1000,16384); returns a cache. */
  constructor(private readonly maxEntries: number, private readonly ttlMs: number, private readonly maxBytes: number) {}

  /** Reclaim expired entries and look up retransmissions. Inputs: request ID, raw envelope, monotonic time; returns cached bytes or undefined. */
  lookup(id: string, input: string, now: number): Uint8Array | undefined {
    for (const [key, cached] of this.entries) {
      if (now >= cached.expires) { this.bytes -= cached.bytes; this.entries.delete(key); }
    }
    const existing = this.entries.get(id);
    if (existing !== undefined) {
      if (existing.input !== input) throw new Error('request_conflict');
      return existing.output;
    }
    // Check capacity to reserve one maximum-sized response before creating new side effects.
    if (this.entries.size >= this.maxEntries) throw new Error('request_limit');
    return undefined;
  }

  /** Check free bytes for a maximum-sized response. Input: reserved byte count, e.g. 512; returns void. */
  reserve(maxResponseBytes: number): void {
    if (maxResponseBytes > this.maxBytes - this.bytes) throw new Error('cache_limit');
  }

  /** Store a successful response. Inputs: request ID, request body, response bytes, time; returns void. */
  store(id: string, input: string, output: Uint8Array, now: number): void {
    const bytes = input.length * 2 + output.byteLength;
    this.entries.set(id, { input, output, expires: now + this.ttlMs, bytes });
    this.bytes += bytes;
  }

  /** Release the cache when the session ends. No input; returns void. */
  clear(): void { this.entries.clear(); this.bytes = 0; }
}
