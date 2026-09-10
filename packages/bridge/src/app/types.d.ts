import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RosBackend, RosDefinition } from '../ros/types.js';
import type { Peer } from '../transport/types.js';
import type { RouterOptions } from '../router/types.js';

/** process起動の明示設定。credential/TLSは呼出側が環境から注入する。 */
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
}
export interface AppBackend extends RosBackend {
  resolveTopic(name: string): string;
  describe(type: string): RosDefinition;
}
export interface AppFactories {
  readonly initialize: () => Promise<AppBackend>;
  readonly makePeer: () => Peer;
  readonly listen: (handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>) => Promise<{ close(): Promise<void> }>;
  readonly onError: () => void;
  readonly clock: () => number;
}
