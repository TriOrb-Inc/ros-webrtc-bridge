import type { Channel } from '../router/types.js';

/** weriftの必要部分だけを表す。テストでは同じ境界をfakeで注入する。 */
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
export interface Peer {
  readonly onDataChannel: Signal<[DataChannel]>;
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
export interface EndpointOptions {
  readonly peer: Peer;
  readonly maxMessageBytes: number;
  readonly maxBufferedBytes: number;
  readonly maxSdpBytes: number;
  readonly timeoutMs: number;
  readonly makeRouter: (send: (channel: Channel, bytes: Uint8Array) => boolean, maxMessageBytes: number, onClosed: () => void) => RouterPort;
  readonly onClosed: () => void;
  readonly onError: () => void;
}
