import { DeliveryQueue } from '../session/delivery-queue.js';
import { identifier, positiveLimit, sequence } from '../session/validation.js';
import { CONTROL, dataChannel, encodeWire, fields, isChannel, parseWire, textField } from './protocol.js';
import { RequestCache } from './request-cache.js';
import type { Channel, Publisher, RouterBinding, RouterOptions, Subscription, Wire } from './types.js';
export type { Channel, RouterBinding, RouterOptions } from './types.js';

/** 認証済み1 peerのwire操作を設定・codec・ROSへ接続する。 */
export class SessionRouter {
  readonly sessionId: string;
  private readonly options: RouterOptions;
  private readonly entries = new Map<string, RouterBinding>();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly publishers = new Map<string, Publisher>();
  // controlとdataを同じbyte budgetで保持し、cacheは別の有限budgetを持つ。
  private readonly queue: DeliveryQueue;
  private readonly cache: RequestCache;
  private readonly maxBytes: number;
  private nextId = 0n;
  private lastTime = 0;
  private controlWindow = 0;
  private controlCount = 0;
  private welcomed = false;
  private closed = false;

  /** transportに閉鎖状態を知らせる。入力なし、出力例: true。@returns router資源解放を開始済みならtrue */
  get isClosed(): boolean { return this.closed; }

  /** 起動済みadapterと共有guardを結ぶ。入力例: RouterOptions、出力例: router。@param options 検証済み設定とI/O @returns router */
  constructor(options: RouterOptions) {
    for (const value of [options.limits.maxHandles, options.limits.maxRequests, options.limits.requestTtlMs, options.limits.maxControlRateHz]) positiveLimit(value);
    identifier(options.epoch);
    if (typeof options.clock !== 'function' || typeof options.send !== 'function') throw new Error('invalid_callback');
    this.options = { ...options, limits: { ...options.limits } };
    // 外部mutationでTopic表が入れ替わらないよう、検証済みentryをコピーする。
    for (const entry of options.bindings) {
      if (!options.config.topics.includes(entry.binding) || this.entries.has(entry.binding.publicName)) throw new Error('invalid_binding');
      identifier(entry.schemaId);
      this.entries.set(entry.binding.publicName, { ...entry });
    }
    this.maxBytes = Math.min(16384, options.config.limits.maxMessageBytes);
    this.queue = new DeliveryQueue({ maxStreams: options.limits.maxHandles + 1, maxBytes: options.config.limits.maxPeerQueueBytes, maxMessageBytes: this.maxBytes });
    this.queue.register('control', 'reliable', options.limits.maxRequests);
    this.cache = new RequestCache(options.limits.maxRequests, options.limits.requestTtlMs, options.config.limits.maxPeerQueueBytes);
    this.now();
    this.sessionId = options.guard.openSession(options.epoch);
  }

  /** 入力を検証して操作を実行する。入力例: (control,hello bytes)、出力例: welcome送信。@param channel label @param raw bytes @returns なし */
  receive(channel: string, raw: Uint8Array): void {
    if (this.closed) return;
    let requestId: string | undefined;
    try {
      if (!isChannel(channel)) throw new Error('invalid_channel');
      if (channel === CONTROL) this.controlRate();
      const wire = parseWire(raw, this.maxBytes);
      // 不正idをエラー応答へコピーしない。control rateは再送にも適用する。
      if (wire.id !== undefined) requestId = textField(wire, 'id');
      if (channel !== CONTROL) {
        this.publish(channel, wire);
      } else {
        this.control(wire, requestId);
      }
      this.flush();
    } catch {
      // codec/nativeの例外本文をwireへ漏らさず、当該requestの拒否だけを通知する。
      this.error(requestId);
    }
  }

  /** backpressure解除時にcontrol優先で再送を試みる。入力例: ()、出力例: 送信可能分だけ送信。@returns なし */
  flush(): void {
    if (this.closed) return;
    if (!this.drain('control', CONTROL)) return;
    for (const [id, subscription] of this.subscriptions) {
      // buffer待機中のACL撤回を、次のsampleを待たず送信直前に反映する。
      try { this.entry(subscription.entry.binding.publicName, 'subscribe'); }
      catch {
        if (this.subscriptions.has(id)) this.removeSubscription(id);
        this.error(undefined);
        return;
      }
      if (!this.drain(id, dataChannel(subscription.entry.binding.delivery))) return;
    }
  }

  /** peerの全listener/handle/queueを解放する。入力例: ()、出力例: void。@returns なし */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.options.guard.revokeSession(this.sessionId);
    const failures: unknown[] = [];
    // 1 listenerの解放失敗でも残る資源の解放を継続する。
    for (const subscription of this.subscriptions.values()) {
      try { subscription.unsubscribe(); } catch (error) { failures.push(error); }
    }
    this.subscriptions.clear(); this.publishers.clear();
    this.queue.clear(); this.cache.clear();
    // ROS callback起点の閉鎖もtransportへ知らせる。通知先は非throw契約とする。
    this.options.onClosed?.();
    if (failures.length > 0) throw new AggregateError(failures, 'cleanup_failed');
  }

  /** control operationを実行する。入力例: subscribe、出力例: subscribed。@param wire envelope @param id request識別子 @returns なし */
  private control(wire: Wire, id: string | undefined): void {
    if (wire.op === 'hello') {
      fields(wire, []);
      if (this.welcomed) throw new Error('already_welcomed');
      const catalog = [...this.entries.values()].filter((entry) => this.allowed(entry, entry.binding.direction === 'ros_to_web' ? 'subscribe' : 'publish'))
        .map(({ binding, schemaId }) => ({ topic: binding.publicName, ros_type: binding.rosType, direction: binding.direction, delivery: binding.delivery, schema_id: schemaId }));
      // welcomeをqueueへ入れられた後だけ以降の操作を解禁する。
      this.respond({ v: 1, op: 'welcome', epoch: this.options.epoch, catalog });
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
    // 応答をcacheへ入れてから送信し、送信が遅れても再実行しない。
    const bytes = encodeWire(response, this.maxBytes);
    this.cache.store(id, input, bytes, now);
    this.queue.enqueue('control', bytes);
  }

  /** request IDを伴う操作を処理する。入力例: advertise、出力例: advertised。@param wire envelope @param id request @returns 応答 */
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

  /** ROSの論理listenerを登録する。入力例: (entry,'r1')、出力例: subscribed。@param entry binding @param requestId request @returns 応答 */
  private subscribe(entry: RouterBinding, requestId: string): Wire {
    const id = this.id();
    this.queue.register(id, entry.binding.queue.policy === 'latest' ? 'latest' : 'reliable', entry.binding.queue.maxMessages);
    try {
      const unsubscribe = this.options.ros.subscribe(entry.binding.publicName, (native) => { this.sample(id, native); });
      this.subscriptions.set(id, { entry, unsubscribe, ready: false, seq: 0n, nextAt: 0 });
    } catch (error) { this.queue.closeStream(id); throw error; }
    return { v: 1, op: 'subscribed', id: requestId, stream_id: id, epoch: this.options.epoch, schema_id: entry.schemaId };
  }

  /** ready後の新規ROS sampleだけを配信する。入力例: (stream,native)、出力例: message送信。@param id stream @param native ROS値 @returns なし */
  private sample(id: string, native: unknown): void {
    const subscription = this.subscriptions.get(id);
    if (subscription === undefined || !subscription.ready) return;
    try {
      const entry = this.entry(subscription.entry.binding.publicName, 'subscribe');
      const now = this.now();
      if (now < subscription.nextAt) return;
      subscription.nextAt = now + 1000 / entry.binding.maxRateHz;
      // uint64を使い切ったstreamはwrapせず停止する。
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

  /** Web publishを同期ROS境界まで検証する。入力例: (realtime,publish)、出力例: ack。@param channel label @param wire envelope @returns なし */
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
    // 受信sequence/rateはROS失敗でも巻き戻さない。非同期待機は作らない。
    publisher.seq = seq; publisher.nextAt = now + 1000 / entry.binding.maxRateHz;
    const send = (): void => {
      this.entry(entry.binding.publicName, 'publish');
      entry.codec.encode(native);
      this.options.ros.publish(entry.binding.publicName, native);
    };
    if (ticket === undefined) send(); else ticket.publish(send);
    this.respond({ v: 1, op: 'published_to_ros', handle, seq: String(seq) });
  }

  /** Topicと方向と権限を照合する。入力例: ('/odom','subscribe')、出力例: entry。@param name 公開名 @param operation 操作 @returns binding */
  private entry(name: string, operation: 'subscribe' | 'publish'): RouterBinding {
    const entry = this.entries.get(name);
    if (entry === undefined || !this.allowed(entry, operation)) throw new Error('unauthorized');
    if (this.closed) throw new Error('router_closed');
    return entry;
  }

  /** default denyを適用する。入力例: (entry,'publish')、出力例: true/false。@param entry binding @param operation 操作 @returns 許可 */
  private allowed(entry: RouterBinding, operation: 'subscribe' | 'publish'): boolean {
    const direction = operation === 'subscribe' ? 'ros_to_web' : 'web_to_ros';
    return entry.binding.direction === direction && this.options.authorize?.(entry.binding, operation) === true;
  }

  /** peer所有publisherを取得する。入力例: handle、出力例: publisher。@param handle ID @returns 状態 */
  private publisher(handle: string): Publisher {
    const publisher = this.publishers.get(handle);
    if (publisher === undefined) throw new Error('unknown_handle');
    return publisher;
  }

  /** peer所有streamを取得する。入力例: stream ID、出力例: subscription。@param id ID @returns 状態 */
  private subscription(id: string): Subscription {
    const subscription = this.subscriptions.get(id);
    if (subscription === undefined) throw new Error('unknown_stream');
    return subscription;
  }

  /** listenerと送信待ちを破棄する。入力例: stream ID、出力例: void。@param id ID @returns なし */
  private removeSubscription(id: string): void {
    const subscription = this.subscription(id);
    this.subscriptions.delete(id);
    this.queue.closeStream(id);
    subscription.unsubscribe();
  }

  /** 成功送信した先頭だけを取り除く。入力例: (control,label)、出力例: true。@param id queue @param channel label @returns 空ならtrue */
  private drain(id: string, channel: Channel): boolean {
    for (;;) {
      const next = this.queue.peek(id);
      if (next === undefined) return true;
      if (!this.options.send(channel, next)) return false;
      this.queue.dequeue(id);
    }
  }

  /** control応答を有界queueへ格納する。入力例: wire、出力例: void。@param wire 応答 @returns なし */
  private respond(wire: Wire): void {
    if (this.closed) throw new Error('router_closed');
    this.queue.enqueue('control', encodeWire(wire, this.maxBytes));
  }

  /** 拒否を通知し、control溢れではpeer資源を解放する。入力例: r1、出力例: error。@param id request ID @returns なし */
  private error(id: string | undefined): void {
    if (this.closed) return;
    try { this.respond({ v: 1, op: 'error', id, code: 'request_rejected' }); this.flush(); }
    catch { this.close(); }
  }

  /** control floodを1秒windowで制限する。入力例: ()、出力例: void。@returns なし */
  private controlRate(): void {
    const window = Math.floor(this.now() / 1000);
    if (window !== this.controlWindow) { this.controlWindow = window; this.controlCount = 0; }
    if (++this.controlCount > this.options.limits.maxControlRateHz) throw new Error('control_rate');
  }

  /** 副作用のない単調clockを検証する。入力例: ()、出力例: ms。@returns 時刻 */
  private now(): number {
    const value = this.options.clock();
    if (!Number.isFinite(value) || value < this.lastTime || value > Number.MAX_SAFE_INTEGER - this.options.limits.requestTtlMs) throw new Error('invalid_clock');
    this.lastTime = value;
    return value;
  }

  /** peer内で再利用しない識別子を生成する。入力例: ()、出力例: uuid:1。@returns ID */
  private id(): string { this.nextId += 1n; return `${this.sessionId}:${this.nextId}`; }
}
