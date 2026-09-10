import { identifier, positiveLimit } from './validation.js';

interface Stream {
  readonly policy: 'latest' | 'reliable';
  readonly maxMessages: number;
  readonly messages: Uint8Array[];
  stopped: boolean;
}

export interface QueueOptions {
  readonly maxStreams: number;
  readonly maxBytes: number;
  readonly maxMessageBytes: number;
}

/** 1 peer分の有限送信待ちqueue。ネットワークschedulerやprocess全体budgetは上位層が担当する。 */
export class DeliveryQueue {
  private readonly options: QueueOptions;
  private readonly streams = new Map<string, Stream>();
  private bytes = 0;
  private dropped = 0n;

  /** 上限を固定する。入力例: {maxStreams:4,maxBytes:32,maxMessageBytes:8}、出力例: queue。@param options 上限 @returns queue */
  constructor(options: QueueOptions) {
    positiveLimit(options.maxStreams);
    positiveLimit(options.maxBytes);
    positiveLimit(options.maxMessageBytes);
    // peer全体より大きな単一message設定は起動時に拒否する。
    if (options.maxMessageBytes > options.maxBytes) throw new Error('invalid_limit');
    this.options = { ...options };
  }

  /** streamを登録する。入力例: ('odom','latest',1)、出力例: void。@param id stream @param policy 配送方針 @param maxMessages 件数上限 @returns なし */
  register(id: string, policy: 'latest' | 'reliable', maxMessages: number): void {
    identifier(id);
    positiveLimit(maxMessages);
    if (policy !== 'latest' && policy !== 'reliable') throw new Error('invalid_policy');
    if (policy === 'latest' && maxMessages !== 1) throw new Error('invalid_limit');
    // 停止済みstreamもcloseするまでは登録件数に含める。
    if (this.streams.has(id)) throw new Error('duplicate_stream');
    if (this.streams.size >= this.options.maxStreams) throw new Error('stream_limit');
    this.streams.set(id, { policy, maxMessages, messages: [], stopped: false });
  }

  /** wire bytesをqueue所有のcopyとして格納する。入力例: ('s',Uint8Array.of(1))、出力例: true。@param id stream @param message envelope込みbytes @returns 格納できればtrue、realtime破棄ならfalse */
  enqueue(id: string, message: Uint8Array): boolean {
    const stream = this.stream(id);
    if (stream.stopped) throw new Error('slow_consumer');
    if (!(message instanceof Uint8Array) || message.byteLength === 0 || message.byteLength > this.options.maxMessageBytes) throw new Error('message_size');
    // latestは既存sampleを先に破棄する。他streamの古い状態を勝手に捨てない。
    if (stream.policy === 'latest' && stream.messages.length > 0) {
      this.dropped += BigInt(stream.messages.length);
      this.release(stream);
    }
    if (stream.messages.length >= stream.maxMessages || message.byteLength > this.options.maxBytes - this.bytes) {
      // reliableの欠落を完全配送と装わずstreamを停止し、占有byteを解放する。
      if (stream.policy === 'reliable') {
        stream.stopped = true;
        this.release(stream);
        throw new Error('slow_consumer');
      }
      this.dropped += 1n;
      return false;
    }
    // 呼出元がbufferを再利用しても待機中のpayloadは変化しない。
    const copy = new Uint8Array(message);
    stream.messages.push(copy);
    this.bytes += copy.byteLength;
    return true;
  }

  /** FIFO先頭を取り出し所有権を呼出元へ渡す。入力例: ('s')、出力例: Uint8Array。@param id stream @returns payloadまたはundefined */
  dequeue(id: string): Uint8Array | undefined {
    const stream = this.stream(id);
    if (stream.stopped) throw new Error('slow_consumer');
    const message = stream.messages.shift();
    // 取り出した時点でqueue計上から除く。transport bufferは別途計上する。
    if (message !== undefined) this.bytes -= message.byteLength;
    return message;
  }

  /** 未送信先頭をcopyして確認する。入力例: ('s')、出力例: Uint8Array。@param id stream @returns 先頭copyまたはundefined */
  peek(id: string): Uint8Array | undefined {
    const stream = this.stream(id);
    if (stream.stopped) throw new Error('slow_consumer');
    const message = stream.messages[0];
    // transport側の書換えでqueue内部のpayloadが変化しないよう所有権を分離する。
    return message === undefined ? undefined : new Uint8Array(message);
  }

  /** streamと待機payloadを解放する。入力例: ('s')、出力例: void。@param id stream @returns なし */
  closeStream(id: string): void {
    this.release(this.stream(id));
    this.streams.delete(id);
  }

  /** 全登録とpayloadを解放する。入力例: ()、出力例: void。@returns なし */
  clear(): void {
    this.streams.clear();
    this.bytes = 0;
  }

  /** queue占有量を観測する。入力例: ()、出力例: {bytes:0,streams:0,dropped:0n}。@returns 現在占有量と累積drop */
  stats(): { bytes: number; streams: number; dropped: bigint } {
    return { bytes: this.bytes, streams: this.streams.size, dropped: this.dropped };
  }

  /** 登録を参照する。入力例: ('s')、出力例: stream。@param id stream @returns 内部状態 */
  private stream(id: string): Stream {
    const stream = this.streams.get(id);
    if (stream === undefined) throw new Error('unknown_stream');
    return stream;
  }

  /** 指定streamの占有byteを返却する。入力例: stream、出力例: void。@param stream 内部状態 @returns なし */
  private release(stream: Stream): void {
    for (const message of stream.messages) this.bytes -= message.byteLength;
    stream.messages.length = 0;
  }
}
