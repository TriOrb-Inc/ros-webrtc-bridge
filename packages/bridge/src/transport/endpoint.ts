import { positiveLimit } from '../session/validation.js';
import { parseOffer } from './sdp.js';
import type { Channel } from '../router/types.js';
import type { DataChannel, EndpointOptions, RouterPort, VideoSlot } from './types.js';
export type { Peer, EndpointOptions, VideoPort, VideoSlot } from './types.js';

const labels = ['ros.control.v1', 'ros.reliable.v1', 'ros.realtime.v1'];

/** Connect three DataChannels to an authenticated router. Create a new instance for each offer. */
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
  private readonly slots: VideoSlot[] = [];

  /** Fix finite limits and the peer. Input: options; returns an endpoint. Example: maxMessageBytes=16384. */
  constructor(options: EndpointOptions) {
    for (const value of [options.maxMessageBytes, options.maxBufferedBytes, options.maxSdpBytes, options.timeoutMs]) positiveLimit(value);
    this.options = { ...options };
    this.maxMessageBytes = Math.min(16384, options.maxMessageBytes);
    if (options.maxBufferedBytes < this.maxMessageBytes) throw new Error('invalid_limit');
    // SDP alone cannot establish channel delivery attributes; inspect them again after receiving DCEP.
    this.subscriptions.push(options.peer.onDataChannel.subscribe(channel => this.channel(channel)));
    this.subscriptions.push(options.peer.connectionStateChange.subscribe(state => {
      if (['failed', 'closed', 'disconnected'].includes(state)) void this.close();
    }));
  }

  /** Expose negotiated video slots to the router. No input; returns one entry per accepted m=video section. */
  get videoSlots(): readonly VideoSlot[] { return this.slots; }

  /** Return an answer after ICE gathering completes. Input: offer; returns an answer. Example: application SDP to application SDP. */
  async answer(offer: { type: 'offer'; sdp: string }): Promise<{ type: string; sdp: string }> {
    if (this.used || this.closed) throw new Error('endpoint_unavailable');
    this.used = true;
    try {
      if (offer.type !== 'offer' || typeof offer.sdp !== 'string' || Buffer.byteLength(offer.sdp) > this.options.maxSdpBytes) throw new Error('invalid_offer');
      const video = this.options.video;
      const shape = parseOffer(offer.sdp, video?.maxSlots ?? 0);
      // Respect the peer's advertised receive maximum. SDP omission means 65536; zero means unlimited.
      const advertised = shape.maxMessageBytes ?? 65536;
      if (advertised !== 0) this.maxMessageBytes = Math.min(this.maxMessageBytes, advertised);
      // Create send-only transceivers before applying the offer so each maps to its m-line in order.
      // Without a media plane the parser already refused every video section, so nothing runs here.
      if (video !== undefined) for (const offered of shape.video) this.slots.push(video.addSlot(offered));
      this.router = this.options.makeRouter((channel, bytes) => this.send(channel, bytes), this.maxMessageBytes,
        () => queueMicrotask(() => { void this.close(); }), this.slots);
      // Bound gathering and DTLS/DataChannel establishment by the same overall deadline.
      const timeout = new Promise<never>((_, reject) => {
        this.cancel = () => reject(new Error('endpoint_closed'));
        this.timer = setTimeout(() => { void this.close(); reject(new Error('negotiation_timeout')); }, this.options.timeoutMs);
      });
      const negotiate = async () => {
        await this.options.peer.setRemoteDescription(offer);
        const answer = await this.options.peer.createAnswer();
        await this.options.peer.setLocalDescription(answer);
        if (this.closed) throw new Error('endpoint_closed');
        // localDescription includes candidates collected during gathering.
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

  /** Release the router, listeners, and PeerConnection. No input; returns a completion Promise. Report failures through anonymized onError. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    clearTimeout(this.timer);
    this.cancel?.();
    for (const subscription of this.subscriptions) subscription.unSubscribe();
    // Close remaining peers despite cleanup failures, revoking sessions first.
    try { this.router?.close(); } catch { this.options.onError(); }
    // Release media before the PeerConnection: a track still writing RTP into a closing transport
    // would surface as an anonymous transport error rather than an ordinary shutdown.
    for (const slot of this.slots.splice(0)) { try { slot.stop(); } catch { this.options.onError(); } }
    this.channels.clear();
    let deadline: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('close_timeout')), this.options.timeoutMs); });
    this.closing = Promise.race([Promise.resolve().then(() => this.options.peer.close()), timeout])
      .catch(() => this.options.onError()).finally(() => { clearTimeout(deadline); this.options.onClosed(); });
    return this.closing;
  }

  /** Validate the received channel label and delivery properties. Input: channel; no return value. Invalid channels close the entire peer. */
  private channel(channel: DataChannel): void {
    const realtime = channel.label === 'ros.realtime.v1';
    if (this.closed || !labels.includes(channel.label) || this.channels.has(channel.label) || channel.negotiated ||
      channel.ordered === realtime || channel.maxPacketLifeTime !== null || channel.maxRetransmits !== (realtime ? 0 : null)) {
      void this.close(); return;
    }
    this.channels.set(channel.label, channel);
    channel.bufferedAmountLowThreshold = Math.floor(this.options.maxBufferedBytes / 2);
    // Resume queued sends when the transport reaches its low-water mark.
    this.subscriptions.push(channel.bufferedAmountLow.subscribe(() => this.flush()));
    this.subscriptions.push(channel.stateChanged.subscribe(state => {
      if (state === 'closed') void this.close();
      else this.opened();
    }));
    this.subscriptions.push(channel.onMessage.subscribe(value => {
      if (this.channels.size !== 3 || !this.router) { void this.close(); return; }
      const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
      // Enforce the stricter application message limit on reception as well as the library limit.
      if (bytes.byteLength > this.maxMessageBytes) { void this.close(); return; }
      this.router.receive(channel.label, bytes);
      if (this.router.isClosed) void this.close();
    }));
    this.opened();
  }

  /** Check that all channels are established. No input or return value. Three open channels clear the timeout and flush queues. */
  private opened(): void {
    if (this.channels.size !== 3 || [...this.channels.values()].some(channel => channel.readyState !== 'open')) return;
    clearTimeout(this.timer);
    this.flush();
  }

  /** Resume queues and propagate fatal router closure to the peer. No input or return value. Control saturation releases the peer. */
  private flush(): void {
    this.router?.flush();
    if (this.router?.isClosed) void this.close();
  }

  /** Check buffer capacity and send bytes. Inputs: label/bytes; false means unsent. */
  private send(label: Channel, bytes: Uint8Array): boolean {
    if (this.closed) return false;
    const channel = this.channels.get(label);
    if (!channel || channel.readyState !== 'open') return false;
    if (bytes.byteLength > this.maxMessageBytes) throw new Error('message_size');
    // Account for transport buffers separately from queues; send only if one additional message fits.
    if (bytes.byteLength > this.options.maxBufferedBytes - channel.bufferedAmount) return false;
    channel.send(Buffer.from(bytes));
    return true;
  }
}
