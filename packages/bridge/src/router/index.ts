import { DeliveryQueue } from '../session/delivery-queue.js';
import { identifier, positiveLimit, sequence } from '../session/validation.js';
import { CONTROL, dataChannel, encodeWire, fields, isChannel, parseWire, textField } from './protocol.js';
import { RequestCache } from './request-cache.js';
import { VideoRouter } from './video.js';
import type { Channel, Publisher, RouterBinding, RouterOptions, Subscription, Wire } from './types.js';
export type { Channel, RouterBinding, RouterOptions } from './types.js';
export { VideoRouter } from './video.js';
export type { VideoAccess } from './video.js';

/** Connect wire operations of one authenticated peer to configuration, codecs, and ROS. */
export class SessionRouter {
  readonly sessionId: string;
  private readonly options: RouterOptions;
  private readonly entries = new Map<string, RouterBinding>();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly publishers = new Map<string, Publisher>();
  // Control and data share a byte budget; the cache has a separate finite budget.
  private readonly queue: DeliveryQueue;
  private readonly cache: RequestCache;
  private readonly video?: VideoRouter;
  private readonly maxBytes: number;
  private nextId = 0n;
  private lastTime = 0;
  private controlWindow = 0;
  private controlCount = 0;
  private welcomed = false;
  private closed = false;

  /** Report closure to the transport. No input; returns true once router resource cleanup has started. */
  get isClosed(): boolean { return this.closed; }

  /** Connect the running adapter and shared guard. Input: RouterOptions with validated config and I/O; returns a router. */
  constructor(options: RouterOptions) {
    for (const value of [options.limits.maxHandles, options.limits.maxRequests, options.limits.requestTtlMs, options.limits.maxControlRateHz]) positiveLimit(value);
    identifier(options.epoch);
    if (typeof options.clock !== 'function' || typeof options.send !== 'function') throw new Error('invalid_callback');
    this.options = { ...options, limits: { ...options.limits } };
    // Copy validated entries so external mutation cannot replace the topic table.
    for (const entry of options.bindings) {
      if (!options.config.topics.includes(entry.binding) || this.entries.has(entry.binding.publicName)) throw new Error('invalid_binding');
      identifier(entry.schemaId);
      this.entries.set(entry.binding.publicName, { ...entry });
    }
    this.maxBytes = Math.min(16384, options.config.limits.maxMessageBytes);
    this.queue = new DeliveryQueue({ maxStreams: options.limits.maxHandles + 1, maxBytes: options.config.limits.maxPeerQueueBytes, maxMessageBytes: this.maxBytes });
    this.queue.register('control', 'reliable', options.limits.maxRequests);
    this.cache = new RequestCache(options.limits.maxRequests, options.limits.requestTtlMs, options.config.limits.maxPeerQueueBytes);
    // Video is opt-in: without a media plane every `video.*` operation stays unknown, exactly as
    // before the feature existed.
    if (options.video !== undefined) this.video = new VideoRouter(options.video.access, options.video.slots, wire => this.event(wire));
    this.now();
    this.sessionId = options.guard.openSession(options.epoch);
  }

  /** Validate input and execute an operation. Inputs: channel label and raw bytes, such as control and hello; sends welcome and returns void. */
  receive(channel: string, raw: Uint8Array): void {
    if (this.closed) return;
    let requestId: string | undefined;
    try {
      if (!isChannel(channel)) throw new Error('invalid_channel');
      if (channel === CONTROL) this.controlRate();
      const wire = parseWire(raw, this.maxBytes);
      // Do not copy invalid IDs into error responses. Control rate limits also apply to retransmissions.
      if (wire.id !== undefined) requestId = textField(wire, 'id');
      if (channel !== CONTROL) {
        this.publish(channel, wire);
      } else {
        this.control(wire, requestId);
      }
      this.flush();
    } catch {
      // Report only request rejection; never leak codec or native exception text onto the wire.
      this.error(requestId);
    }
  }

  /** Retry sending when backpressure clears, prioritizing control. No input; sends what can be sent and returns void. */
  flush(): void {
    if (this.closed) return;
    // Apply revocation to watched video before anything else is handed to the transport.
    this.video?.revalidate();
    if (!this.drain('control', CONTROL)) return;
    for (const [id, subscription] of this.subscriptions) {
      // Apply ACL revocation immediately before sending buffered data, without waiting for another sample.
      try { this.entry(subscription.entry.binding.publicName, 'subscribe'); }
      catch {
        if (this.subscriptions.has(id)) this.removeSubscription(id);
        this.error(undefined);
        return;
      }
      if (!this.drain(id, dataChannel(subscription.entry.binding.delivery))) return;
    }
  }

  /** Release all peer listeners, handles, and queues. No input; returns void. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.video?.close();
    this.options.guard.revokeSession(this.sessionId);
    const failures: unknown[] = [];
    // Continue releasing remaining resources even if one listener fails to clean up.
    for (const subscription of this.subscriptions.values()) {
      try { subscription.unsubscribe(); } catch (error) { failures.push(error); }
    }
    this.subscriptions.clear(); this.publishers.clear();
    this.queue.clear(); this.cache.clear();
    // Notify the transport of closure initiated by a ROS callback. Notification callbacks must not throw.
    this.options.onClosed?.();
    if (failures.length > 0) throw new AggregateError(failures, 'cleanup_failed');
  }

  /** Execute a control operation. Inputs: wire envelope and request ID; for example subscribe sends subscribed. Returns void. */
  private control(wire: Wire, id: string | undefined): void {
    if (wire.op === 'hello') {
      fields(wire, []);
      if (this.welcomed) throw new Error('already_welcomed');
      const catalog = [...this.entries.values()].filter((entry) => this.allowed(entry, entry.binding.direction === 'ros_to_web' ? 'subscribe' : 'publish'))
        .map(({ binding, schemaId }) => ({ topic: binding.publicName, ros_type: binding.rosType, direction: binding.direction, delivery: binding.delivery, schema_id: schemaId }));
      // Allow subsequent operations only after welcome has been queued. The video key is present
      // only when this peer may watch something, so a DataChannel-only welcome is unchanged.
      const video = this.video?.catalog();
      this.respond({ v: 1, op: 'welcome', epoch: this.options.epoch, catalog, ...(video === undefined ? {} : { video }) });
      this.welcomed = true;
      return;
    }
    if (!this.welcomed) throw new Error('hello_required');
    if (wire.op === 'ready') {
      fields(wire, ['stream_id']);
      this.subscription(textField(wire, 'stream_id')).ready = true;
      return;
    }
    if (id === undefined) throw new Error('request_id_required');
    const input = JSON.stringify(wire);
    const now = this.now();
    const cached = this.cache.lookup(id, input, now);
    if (cached !== undefined) { this.queue.enqueue('control', cached); return; }
    this.cache.reserve(this.maxBytes + input.length * 2);
    const response = this.operation(wire, id);
    // Cache responses before sending so delayed delivery cannot cause re-execution.
    const bytes = encodeWire(response, this.maxBytes);
    this.cache.store(id, input, bytes, now);
    this.queue.enqueue('control', bytes);
  }

  /** Process an operation with a request ID. Inputs: wire envelope and request ID; for example advertise returns advertised. */
  private operation(wire: Wire, id: string): Wire {
    if (wire.op === 'subscribe' || wire.op === 'advertise') {
      fields(wire, ['id', 'topic']);
      const entry = this.entry(textField(wire, 'topic'), wire.op === 'subscribe' ? 'subscribe' : 'publish');
      if (this.subscriptions.size + this.publishers.size >= this.options.limits.maxHandles) throw new Error('handle_limit');
      if (wire.op === 'subscribe') return this.subscribe(entry, id);
      const guarded = entry.binding.commandGuard !== undefined;
      const handle = guarded ? this.options.guard.openHandle(this.sessionId, entry.binding.rosTopic, entry.binding.commandGuard!.leaseMs) : this.id();
      this.publishers.set(handle, { entry, guarded, seq: -1n, nextAt: 0 });
      return { v: 1, op: 'advertised', id, handle, epoch: this.options.epoch, schema_id: entry.schemaId };
    }
    if (wire.op === 'unsubscribe') {
      fields(wire, ['id', 'stream_id']);
      this.removeSubscription(textField(wire, 'stream_id'));
      return { v: 1, op: 'unsubscribed', id };
    }
    if (this.video !== undefined && typeof wire.op === 'string' && wire.op.startsWith('video.')) return this.video.operation(wire, id);
    if (wire.op === 'arm' || wire.op === 'unadvertise') {
      fields(wire, ['id', 'handle']);
      const handle = textField(wire, 'handle');
      const publisher = this.publisher(handle);
      this.entry(publisher.entry.binding.publicName, 'publish');
      if (wire.op === 'arm') {
        if (!publisher.guarded) throw new Error('lease_not_required');
        const lease = this.options.guard.arm(this.sessionId, handle);
        return { v: 1, op: 'lease', id, handle, epoch: this.options.epoch, lease_id: lease.id, expires_at: lease.expiresAt };
      }
      if (publisher.guarded) this.options.guard.closeHandle(this.sessionId, handle);
      this.publishers.delete(handle);
      return { v: 1, op: 'unadvertised', id };
    }
    throw new Error('unknown_operation');
  }

  /** Register a logical ROS listener. Inputs: binding entry and request ID, e.g. (entry,'r1'); returns a subscribed response. */
  private subscribe(entry: RouterBinding, requestId: string): Wire {
    const id = this.id();
    this.queue.register(id, entry.binding.queue.policy === 'latest' ? 'latest' : 'reliable', entry.binding.queue.maxMessages);
    try {
      const unsubscribe = this.options.ros.subscribe(entry.binding.publicName, (native) => { this.sample(id, native); });
      this.subscriptions.set(id, { entry, unsubscribe, ready: false, seq: 0n, nextAt: 0 });
    } catch (error) { this.queue.closeStream(id); throw error; }
    return { v: 1, op: 'subscribed', id: requestId, stream_id: id, epoch: this.options.epoch, schema_id: entry.schemaId };
  }

  /** Deliver only new ROS samples after ready. Inputs: stream ID and native ROS value; sends a message and returns void. */
  private sample(id: string, native: unknown): void {
    const subscription = this.subscriptions.get(id);
    if (subscription === undefined || !subscription.ready) return;
    try {
      const entry = this.entry(subscription.entry.binding.publicName, 'subscribe');
      const now = this.now();
      if (now < subscription.nextAt) return;
      subscription.nextAt = now + 1000 / entry.binding.maxRateHz;
      // Stop streams that exhaust uint64 sequence numbers instead of wrapping.
      sequence(String(subscription.seq));
      const data = entry.codec.encode(native);
      const bytes = encodeWire({ v: 1, op: 'message', stream_id: id, epoch: this.options.epoch, seq: String(subscription.seq++), data }, this.maxBytes);
      this.queue.enqueue(id, bytes);
      this.flush();
    } catch {
      if (this.subscriptions.has(id)) this.removeSubscription(id);
      this.error(undefined);
    }
  }

  /** Validate Web publishing through the synchronous ROS boundary. Inputs: channel label and wire envelope; sends ack and returns void. */
  private publish(channel: Channel, wire: Wire): void {
    fields(wire, ['id', 'handle', 'epoch', 'seq', 'lease_id', 'data']);
    if (!this.welcomed || wire.op !== 'publish' || wire.epoch !== this.options.epoch) throw new Error('invalid_publish');
    const handle = textField(wire, 'handle');
    const publisher = this.publisher(handle);
    const entry = this.entry(publisher.entry.binding.publicName, 'publish');
    if (channel !== dataChannel(entry.binding.delivery)) throw new Error('invalid_channel');
    const seq = sequence(textField(wire, 'seq'));
    const now = this.now();
    if (seq <= publisher.seq || now < publisher.nextAt) throw new Error('publish_rate_or_sequence');
    const native = entry.codec.decode(wire.data);
    const ticket = publisher.guarded ? this.options.guard.prepare({ sessionId: this.sessionId, epoch: this.options.epoch, handle, leaseId: textField(wire, 'lease_id'), seq: String(seq) }) : undefined;
    if (!publisher.guarded && wire.lease_id !== undefined) throw new Error('unexpected_lease');
    // Do not roll back received sequence or rate state after ROS failure. Introduce no asynchronous waits.
    publisher.seq = seq; publisher.nextAt = now + 1000 / entry.binding.maxRateHz;
    const send = (): void => {
      this.entry(entry.binding.publicName, 'publish');
      entry.codec.encode(native);
      this.options.ros.publish(entry.binding.publicName, native);
    };
    if (ticket === undefined) send(); else ticket.publish(send);
    this.respond({ v: 1, op: 'published_to_ros', handle, seq: String(seq) });
  }

  /** Check topic, direction, and permissions. Inputs: public name and operation, e.g. ('/odom','subscribe'); returns a binding. */
  private entry(name: string, operation: 'subscribe' | 'publish'): RouterBinding {
    const entry = this.entries.get(name);
    if (entry === undefined || !this.allowed(entry, operation)) throw new Error('unauthorized');
    if (this.closed) throw new Error('router_closed');
    return entry;
  }

  /** Apply default-deny authorization. Inputs: binding and operation, e.g. (entry,'publish'); returns a permission boolean. */
  private allowed(entry: RouterBinding, operation: 'subscribe' | 'publish'): boolean {
    const direction = operation === 'subscribe' ? 'ros_to_web' : 'web_to_ros';
    return entry.binding.direction === direction && this.options.authorize?.(entry.binding, operation) === true;
  }

  /** Get a peer-owned publisher. Input: handle ID; returns publisher state. */
  private publisher(handle: string): Publisher {
    const publisher = this.publishers.get(handle);
    if (publisher === undefined) throw new Error('unknown_handle');
    return publisher;
  }

  /** Get a peer-owned stream. Input: stream ID; returns subscription state. */
  private subscription(id: string): Subscription {
    const subscription = this.subscriptions.get(id);
    if (subscription === undefined) throw new Error('unknown_stream');
    return subscription;
  }

  /** Discard a listener and pending sends. Input: stream ID; returns void. */
  private removeSubscription(id: string): void {
    const subscription = this.subscription(id);
    this.subscriptions.delete(id);
    this.queue.closeStream(id);
    subscription.unsubscribe();
  }

  /** Remove only successfully sent queue heads. Inputs: queue ID and channel label; returns true when empty. */
  private drain(id: string, channel: Channel): boolean {
    for (;;) {
      const next = this.queue.peek(id);
      if (next === undefined) return true;
      if (!this.options.send(channel, next)) return false;
      this.queue.dequeue(id);
    }
  }

  /**
   * Deliver an event the peer did not ask for. Input: control envelope; returns void.
   *
   * A media-plane event happens between requests, so no inbound message is coming to flush the
   * queue for it: a track going active or failing has to reach the peer when it happens.
   */
  private event(wire: Wire): void {
    try { this.respond(wire); this.flush(); }
    catch { this.error(undefined); }
  }

  /** Store a control response in a bounded queue. Input: wire response; returns void. */
  private respond(wire: Wire): void {
    if (this.closed) throw new Error('router_closed');
    this.queue.enqueue('control', encodeWire(wire, this.maxBytes));
  }

  /** Report rejection and release peer resources on control overflow. Input: request ID; sends an error and returns void. */
  private error(id: string | undefined): void {
    if (this.closed) return;
    try { this.respond({ v: 1, op: 'error', id, code: 'request_rejected' }); this.flush(); }
    catch { this.close(); }
  }

  /** Limit control floods in a one-second window. No input; returns void. */
  private controlRate(): void {
    const window = Math.floor(this.now() / 1000);
    if (window !== this.controlWindow) { this.controlWindow = window; this.controlCount = 0; }
    if (++this.controlCount > this.options.limits.maxControlRateHz) throw new Error('control_rate');
  }

  /** Validate a side-effect-free monotonic clock. No input; returns time in milliseconds. */
  private now(): number {
    const value = this.options.clock();
    if (!Number.isFinite(value) || value < this.lastTime || value > Number.MAX_SAFE_INTEGER - this.options.limits.requestTtlMs) throw new Error('invalid_clock');
    this.lastTime = value;
    return value;
  }

  /** Generate an identifier never reused within the peer. No input; returns an ID such as uuid:1. */
  private id(): string { this.nextId += 1n; return `${this.sessionId}:${this.nextId}`; }
}
