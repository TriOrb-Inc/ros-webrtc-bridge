import { positiveLimit } from '../session/validation.js';
import type { Channel } from '../router/types.js';
import type { DataChannel, EndpointOptions, RouterPort } from './types.js';
export type { Peer, EndpointOptions } from './types.js';

const labels = ['ros.control.v1', 'ros.reliable.v1', 'ros.realtime.v1'];

/** 3本のDataChannelを認証済みrouterへ結ぶ。offerごとに新しいinstanceを作る。 */
export class WebRtcEndpoint {
  private readonly options: EndpointOptions;
  private readonly channels = new Map<string, DataChannel>();
  private readonly subscriptions: { unSubscribe(): void }[] = [];
  private router?: RouterPort;
  private closed = false;
  private used = false;
  private closing?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private cancel?: () => void;
  private maxMessageBytes: number;

  /** 有限容量とpeerを固定する。入力options、出力endpoint。例: maxMessageBytes=16384。 */
  constructor(options: EndpointOptions) {
    for (const value of [options.maxMessageBytes, options.maxBufferedBytes, options.maxSdpBytes, options.timeoutMs]) positiveLimit(value);
    this.options = { ...options };
    this.maxMessageBytes = Math.min(16384, options.maxMessageBytes);
    if (options.maxBufferedBytes < this.maxMessageBytes) throw new Error('invalid_limit');
    // channel配送属性はSDPだけで判定できないためDCEP受信後にも検査する。
    this.subscriptions.push(options.peer.onDataChannel.subscribe(channel => this.channel(channel)));
    this.subscriptions.push(options.peer.connectionStateChange.subscribe(state => {
      if (['failed', 'closed', 'disconnected'].includes(state)) void this.close();
    }));
  }

  /** ICE gathering完了後のanswerを返す。入力offer、出力answer。例: application SDP → application SDP。 */
  async answer(offer: { type: 'offer'; sdp: string }): Promise<{ type: string; sdp: string }> {
    if (this.used || this.closed) throw new Error('endpoint_unavailable');
    this.used = true;
    try {
      if (offer.type !== 'offer' || typeof offer.sdp !== 'string' || Buffer.byteLength(offer.sdp) > this.options.maxSdpBytes) throw new Error('invalid_offer');
      const media = offer.sdp.match(/^m=\S+/gm);
      if (media?.length !== 1 || media[0] !== 'm=application') throw new Error('datachannel_only');
      // peerが宣言する最大受信値を尊重する。省略時65536、0は制限なしというSDPの意味。
      const limits = [...offer.sdp.matchAll(/^a=max-message-size:(\d+)\r?$/gm)];
      const advertised = limits.length ? Number(limits[0][1]) : 65536;
      if (limits.length > 1 || !Number.isSafeInteger(advertised)) throw new Error('invalid_message_limit');
      if (advertised !== 0) this.maxMessageBytes = Math.min(this.maxMessageBytes, advertised);
      this.router = this.options.makeRouter((channel, bytes) => this.send(channel, bytes), this.maxMessageBytes,
        () => queueMicrotask(() => { void this.close(); }));
      // gatheringとDTLS/DataChannel確立を同じ全体期限で制限する。
      const timeout = new Promise<never>((_, reject) => {
        this.cancel = () => reject(new Error('endpoint_closed'));
        this.timer = setTimeout(() => { void this.close(); reject(new Error('negotiation_timeout')); }, this.options.timeoutMs);
      });
      const negotiate = async () => {
        await this.options.peer.setRemoteDescription(offer);
        const answer = await this.options.peer.createAnswer();
        await this.options.peer.setLocalDescription(answer);
        if (this.closed) throw new Error('endpoint_closed');
        // localDescriptionにはgathering後のcandidateが含まれる。
        const local = this.options.peer.localDescription;
        if (!local || Buffer.byteLength(local.sdp) > this.options.maxSdpBytes) throw new Error('invalid_answer');
        return { type: local.type, sdp: local.sdp };
      };
      return await Promise.race([negotiate(), timeout]);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /** router・listener・PeerConnectionを解放する。入力なし、出力完了Promise。失敗は匿名onErrorへ通知する。 */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    clearTimeout(this.timer);
    this.cancel?.();
    for (const subscription of this.subscriptions) subscription.unSubscribe();
    // cleanup失敗時も残るpeerを閉じ、sessionの撤回を先に実行する。
    try { this.router?.close(); } catch { this.options.onError(); }
    this.channels.clear();
    let deadline: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('close_timeout')), this.options.timeoutMs); });
    this.closing = Promise.race([Promise.resolve().then(() => this.options.peer.close()), timeout])
      .catch(() => this.options.onError()).finally(() => { clearTimeout(deadline); this.options.onClosed(); });
    return this.closing;
  }

  /** 受信したchannelのlabelと配送特性を検証する。入力channel、出力なし。不正時はpeer全体を閉じる。 */
  private channel(channel: DataChannel): void {
    const realtime = channel.label === 'ros.realtime.v1';
    if (this.closed || !labels.includes(channel.label) || this.channels.has(channel.label) || channel.negotiated ||
      channel.ordered === realtime || channel.maxPacketLifeTime !== null || channel.maxRetransmits !== (realtime ? 0 : null)) {
      void this.close(); return;
    }
    this.channels.set(channel.label, channel);
    channel.bufferedAmountLowThreshold = Math.floor(this.options.maxBufferedBytes / 2);
    // transportが低水位になれば、送れず保持していたqueueを再開する。
    this.subscriptions.push(channel.bufferedAmountLow.subscribe(() => this.flush()));
    this.subscriptions.push(channel.stateChanged.subscribe(state => {
      if (state === 'closed') void this.close();
      else this.opened();
    }));
    this.subscriptions.push(channel.onMessage.subscribe(value => {
      if (this.channels.size !== 3 || !this.router) { void this.close(); return; }
      const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
      // libraryの最大messageより厳しいアプリ上限を受信側でも強制する。
      if (bytes.byteLength > this.maxMessageBytes) { void this.close(); return; }
      this.router.receive(channel.label, bytes);
      if (this.router.isClosed) void this.close();
    }));
    this.opened();
  }

  /** 全channel確立を確認する。入力なし、出力なし。例: 3本open → timeout解除とflush。 */
  private opened(): void {
    if (this.channels.size !== 3 || [...this.channels.values()].some(channel => channel.readyState !== 'open')) return;
    clearTimeout(this.timer);
    this.flush();
  }

  /** queueを再開しrouterの致命的終了をpeerへ反映する。入力なし、出力なし。例: control飽和 → peer解放。 */
  private flush(): void {
    this.router?.flush();
    if (this.router?.isClosed) void this.close();
  }

  /** buffer容量を確認してbytesを送る。入力label/bytes、出力falseなら未送信。 */
  private send(label: Channel, bytes: Uint8Array): boolean {
    if (this.closed) return false;
    const channel = this.channels.get(label);
    if (!channel || channel.readyState !== 'open') return false;
    if (bytes.byteLength > this.maxMessageBytes) throw new Error('message_size');
    // transport bufferはqueueとは別計上し、1messageを追加しても超過しない場合だけ送る。
    if (bytes.byteLength > this.options.maxBufferedBytes - channel.bufferedAmount) return false;
    channel.send(Buffer.from(bytes));
    return true;
  }
}
