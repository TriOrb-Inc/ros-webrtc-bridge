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

/** Bounded send queue for one peer. Higher layers own network scheduling and process-wide budgets. */
export class DeliveryQueue {
  private readonly options: QueueOptions;
  private readonly streams = new Map<string, Stream>();
  private bytes = 0;
  private dropped = 0n;

  /** Fix limits. Input: options, e.g. {maxStreams:4,maxBytes:32,maxMessageBytes:8}; returns a queue. */
  constructor(options: QueueOptions) {
    positiveLimit(options.maxStreams);
    positiveLimit(options.maxBytes);
    positiveLimit(options.maxMessageBytes);
    // Reject a single-message limit larger than the peer-wide budget at startup.
    if (options.maxMessageBytes > options.maxBytes) throw new Error('invalid_limit');
    this.options = { ...options };
  }

  /** Register a stream. Inputs: stream ID, delivery policy, message count limit, e.g. ('odom','latest',1); returns void. */
  register(id: string, policy: 'latest' | 'reliable', maxMessages: number): void {
    identifier(id);
    positiveLimit(maxMessages);
    if (policy !== 'latest' && policy !== 'reliable') throw new Error('invalid_policy');
    if (policy === 'latest' && maxMessages !== 1) throw new Error('invalid_limit');
    // Stopped streams still count as registered until closed.
    if (this.streams.has(id)) throw new Error('duplicate_stream');
    if (this.streams.size >= this.options.maxStreams) throw new Error('stream_limit');
    this.streams.set(id, { policy, maxMessages, messages: [], stopped: false });
  }

  /** Store wire bytes as a queue-owned copy. Inputs: stream ID and envelope bytes; returns true if stored, false for realtime drops. */
  enqueue(id: string, message: Uint8Array): boolean {
    const stream = this.stream(id);
    if (stream.stopped) throw new Error('slow_consumer');
    if (!(message instanceof Uint8Array) || message.byteLength === 0 || message.byteLength > this.options.maxMessageBytes) throw new Error('message_size');
    // The latest policy discards its existing sample first. Never discard other streams' stale state implicitly.
    if (stream.policy === 'latest' && stream.messages.length > 0) {
      this.dropped += BigInt(stream.messages.length);
      this.release(stream);
    }
    if (stream.messages.length >= stream.maxMessages || message.byteLength > this.options.maxBytes - this.bytes) {
      // Stop reliable streams and release occupied bytes instead of presenting lost data as complete delivery.
      if (stream.policy === 'reliable') {
        stream.stopped = true;
        this.release(stream);
        throw new Error('slow_consumer');
      }
      this.dropped += 1n;
      return false;
    }
    // Pending payloads remain unchanged even if the caller reuses the buffer.
    const copy = new Uint8Array(message);
    stream.messages.push(copy);
    this.bytes += copy.byteLength;
    return true;
  }

  /** Remove the FIFO head and transfer ownership to the caller. Input: stream ID; returns a payload Uint8Array or undefined. */
  dequeue(id: string): Uint8Array | undefined {
    const stream = this.stream(id);
    if (stream.stopped) throw new Error('slow_consumer');
    const message = stream.messages.shift();
    // Remove dequeued bytes from queue accounting immediately. Transport buffers are counted separately.
    if (message !== undefined) this.bytes -= message.byteLength;
    return message;
  }

  /** Inspect a copy of the unsent head. Input: stream ID; returns a Uint8Array copy or undefined. */
  peek(id: string): Uint8Array | undefined {
    const stream = this.stream(id);
    if (stream.stopped) throw new Error('slow_consumer');
    const message = stream.messages[0];
    // Separate ownership so transport-side mutation cannot change queued payloads.
    return message === undefined ? undefined : new Uint8Array(message);
  }

  /** Release a stream and pending payloads. Input: stream ID; returns void. */
  closeStream(id: string): void {
    this.release(this.stream(id));
    this.streams.delete(id);
  }

  /** Release all registrations and payloads. No input; returns void. */
  clear(): void {
    this.streams.clear();
    this.bytes = 0;
  }

  /** Observe queue usage. No input; returns current usage and cumulative drops, e.g. {bytes:0,streams:0,dropped:0n}. */
  stats(): { bytes: number; streams: number; dropped: bigint } {
    return { bytes: this.bytes, streams: this.streams.size, dropped: this.dropped };
  }

  /** Look up a registration. Input: stream ID; returns internal stream state. */
  private stream(id: string): Stream {
    const stream = this.streams.get(id);
    if (stream === undefined) throw new Error('unknown_stream');
    return stream;
  }

  /** Release bytes occupied by the specified stream. Input: internal stream state; returns void. */
  private release(stream: Stream): void {
    for (const message of stream.messages) this.bytes -= message.byteLength;
    stream.messages.length = 0;
  }
}
