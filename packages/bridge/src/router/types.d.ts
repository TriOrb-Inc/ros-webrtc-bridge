import type { BridgeConfig, TopicBinding } from '../config/types.js';
import type { Codec } from '../codec/types.js';
import type { CommandGuard } from '../session/command-guard.js';
import type { VideoSlot } from '../transport/types.js';
import type { VideoAccess } from './video.js';

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
  /** False means unsent. Remove the queue head only when true is returned. */
  readonly send: (channel: Channel, bytes: Uint8Array) => boolean;
  readonly authorize?: (binding: TopicBinding, operation: 'subscribe' | 'publish') => boolean;
  /** Notify once after cleanup. Do not throw; schedule transport close in a microtask. */
  readonly onClosed?: () => void;
  readonly limits: { readonly maxHandles: number; readonly maxRequests: number; readonly requestTtlMs: number; readonly maxControlRateHz: number };
  /**
   * Media plane for this peer: its authorization view plus the slots the transport negotiated, in
   * m-line order. Absent for DataChannel-only deployments.
   */
  readonly video?: { readonly access: VideoAccess; readonly slots: readonly VideoSlot[] };
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
