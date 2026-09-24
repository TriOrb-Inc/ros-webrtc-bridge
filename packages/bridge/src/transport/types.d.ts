import type { Channel } from '../router/types.js';

/** Minimal werift surface. Tests inject fakes at the same boundary. */
export interface Signal<T extends unknown[]> {
  subscribe(callback: (...args: T) => void): { unSubscribe(): void };
}
export interface DataChannel {
  readonly label: string;
  readonly ordered: boolean;
  readonly negotiated: boolean;
  readonly maxRetransmits: number | null;
  readonly maxPacketLifeTime: number | null;
  readonly readyState: string;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  readonly onMessage: Signal<[string | Buffer]>;
  readonly stateChanged: Signal<[string]>;
  readonly bufferedAmountLow: Signal<unknown[]>;
  send(value: Buffer): void;
}
/** Werift media track. Only complete RTP packets are written; the sender rewrites the header. */
export interface MediaTrack {
  writeRtp(packet: Buffer): void;
  stop(): void;
}

/** Werift transceiver. `mid` is null until negotiation assigns one. */
export interface RtpTransceiver {
  readonly mid: string | null;
  codecs: unknown[];
  readonly sender: { readonly onPictureLossIndication: Signal<[]> };
}

export interface Peer {
  readonly onDataChannel: Signal<[DataChannel]>;
  /** Present only on builds that negotiate media; DataChannel-only deployments never call it. */
  addTransceiver?(track: MediaTrack, options: { direction: 'sendonly' }): RtpTransceiver;
  readonly connectionStateChange: Signal<[string]>;
  readonly localDescription: { type: string; sdp: string } | null;
  setRemoteDescription(offer: { type: 'offer'; sdp: string }): Promise<void>;
  createAnswer(): Promise<{ type: string; sdp: string }>;
  setLocalDescription(answer: { type: string; sdp: string }): Promise<unknown>;
  close(): Promise<void>;
}
export interface RouterPort {
  readonly isClosed: boolean;
  receive(channel: string, bytes: Uint8Array): void;
  flush(): void;
  close(): void;
}
/**
 * One negotiated `m=video` section. The media plane writes complete RTP packets into it and never
 * learns which PeerConnection it belongs to.
 */
export interface VideoSlot {
  /** SDP media identifier of the answered section, e.g. "1". Sent to the client so it can match receivers. */
  readonly mid: string;
  /** Hand a complete RTP packet to the peer. Always a Buffer: the sender rewrites the header in place. */
  write(packet: Buffer): void;
  /** Request an IDR from whatever produces this stream, e.g. after RTCP PLI. */
  onKeyframeRequest(callback: () => void): void;
  stop(): void;
}

/** Media-plane hook. Absent for deployments without `video_tracks`, which then behave as before. */
export interface VideoPort {
  /** Video sections this deployment accepts in one offer. */
  readonly maxSlots: number;
  /** Create a send-only H.264 transceiver for one offered slot, before the offer is applied. */
  addSlot(offered: { readonly payloadType: number; readonly profileLevelId: string }): VideoSlot;
}

export interface EndpointOptions {
  readonly peer: Peer;
  readonly video?: VideoPort;
  readonly maxMessageBytes: number;
  readonly maxBufferedBytes: number;
  readonly maxSdpBytes: number;
  readonly timeoutMs: number;
  readonly makeRouter: (send: (channel: Channel, bytes: Uint8Array) => boolean, maxMessageBytes: number, onClosed: () => void, videoSlots: readonly VideoSlot[]) => RouterPort;
  readonly onClosed: () => void;
  readonly onError: () => void;
}
