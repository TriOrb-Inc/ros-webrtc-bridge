import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RosBackend, RosDefinition } from '../ros/types.js';
import type { MediaSourceFactory, Schedule } from '../media/types.js';
import type { Peer, VideoSlot } from '../transport/types.js';
import type { RouterOptions } from '../router/types.js';

/** Explicit process startup configuration. The caller injects credentials and TLS settings from the environment. */
export interface AppSettings {
  readonly credential: string;
  readonly configSource: string;
  readonly maxConfigBytes: number;
  readonly subscribeTopics: readonly string[];
  readonly publishScopes: readonly string[];
  readonly timeoutMs: number;
  readonly maxSdpBytes: number;
  readonly requestTimeoutMs: number;
  readonly routerLimits: RouterOptions['limits'];
  /** Video scopes granted to the single credential. Absent or empty denies every track. */
  readonly videoScopes?: readonly string[];
}
export interface AppBackend extends RosBackend {
  resolveTopic(name: string): string;
  describe(type: string): RosDefinition;
}
export interface AppFactories {
  readonly initialize: () => Promise<AppBackend>;
  readonly makePeer: () => Peer;
  /** Encoder implementations this build provides, keyed by backend id. Missing ones fail the probe. */
  readonly videoBackends?: Readonly<Record<string, MediaSourceFactory>>;
  /** Add a send-only H.264 transceiver to one peer. Required when any track is configured. */
  readonly makeVideoSlot?: (peer: Peer, offered: { readonly payloadType: number; readonly profileLevelId: string }) => VideoSlot;
  /** Cancellable delay used by media lifecycle timers. */
  readonly schedule?: Schedule;
  readonly listen: (handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>) => Promise<{ close(): Promise<void> }>;
  readonly onError: () => void;
  readonly clock: () => number;
}
