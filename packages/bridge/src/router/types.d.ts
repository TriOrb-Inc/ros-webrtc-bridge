import type { BridgeConfig, TopicBinding } from '../config/types.js';
import type { Codec } from '../codec/types.js';
import type { CommandGuard } from '../session/command-guard.js';

export type Channel = 'ros.control.v1' | 'ros.reliable.v1' | 'ros.realtime.v1';
export interface RouterBinding { readonly binding: TopicBinding; readonly codec: Codec; readonly schemaId: string }
export interface RouterOptions {
  readonly config: BridgeConfig;
  readonly guard: CommandGuard;
  readonly bindings: readonly RouterBinding[];
  readonly epoch: string;
  readonly clock: () => number;
  readonly ros: {
    subscribe(publicName: string, callback: (native: unknown) => void): () => void;
    publish(publicName: string, native: unknown): void;
  };
  /** falseは未送信。trueを返した場合だけqueue先頭を除去する。 */
  readonly send: (channel: Channel, bytes: Uint8Array) => boolean;
  readonly authorize?: (binding: TopicBinding, operation: 'subscribe' | 'publish') => boolean;
  /** cleanup後に1回通知する。例外を投げず、transport closeはmicrotaskで予約する。 */
  readonly onClosed?: () => void;
  readonly limits: { readonly maxHandles: number; readonly maxRequests: number; readonly requestTtlMs: number; readonly maxControlRateHz: number };
}
export interface Subscription {
  readonly entry: RouterBinding;
  readonly unsubscribe: () => void;
  ready: boolean;
  seq: bigint;
  nextAt: number;
}
export interface Publisher {
  readonly entry: RouterBinding;
  readonly guarded: boolean;
  seq: bigint;
  nextAt: number;
}
export type Wire = Record<string, unknown>;
