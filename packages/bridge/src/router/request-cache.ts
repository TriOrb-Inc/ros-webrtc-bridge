interface Cached { readonly input: string; readonly output: Uint8Array; readonly expires: number; readonly bytes: number }

/** 同一request IDの副作用を期限内で重複させない有限cache。 */
export class RequestCache {
  private readonly entries = new Map<string, Cached>();
  private bytes = 0;
  /** 上限はrouterで検証済み。入力例: (4,1000,16384)、出力例: cache。@param maxEntries 件数 @param ttlMs 寿命 @param maxBytes bytes @returns cache */
  constructor(private readonly maxEntries: number, private readonly ttlMs: number, private readonly maxBytes: number) {}

  /** 期限切れを回収して再送を検索する。入力例: ('r1','json',0)、出力例: bytes/undefined。@param id request @param input 生envelope @param now 単調時刻 @returns 既存応答 */
  lookup(id: string, input: string, now: number): Uint8Array | undefined {
    for (const [key, cached] of this.entries) {
      if (now >= cached.expires) { this.bytes -= cached.bytes; this.entries.delete(key); }
    }
    const existing = this.entries.get(id);
    if (existing !== undefined) {
      if (existing.input !== input) throw new Error('request_conflict');
      return existing.output;
    }
    // 新しい副作用を起こす前に最大応答1件分の余白を予約できるか判定する。
    if (this.entries.size >= this.maxEntries) throw new Error('request_limit');
    return undefined;
  }

  /** 最大応答分の空きbyteを確認する。入力例: 512、出力例: void。@param maxResponseBytes 予約量 @returns なし */
  reserve(maxResponseBytes: number): void {
    if (maxResponseBytes > this.maxBytes - this.bytes) throw new Error('cache_limit');
  }

  /** 成功応答を保存する。入力例: ('r1','json',bytes,0)、出力例: void。@param id request @param input request本文 @param output 応答 @param now 時刻 @returns なし */
  store(id: string, input: string, output: Uint8Array, now: number): void {
    const bytes = input.length * 2 + output.byteLength;
    this.entries.set(id, { input, output, expires: now + this.ttlMs, bytes });
    this.bytes += bytes;
  }

  /** session終了時にcacheを解放する。入力例: ()、出力例: void。@returns なし */
  clear(): void { this.entries.clear(); this.bytes = 0; }
}
