/** Pass E2E connection details only at runtime; never store them in reports or logs. */
export interface BrowserConnectionOptions {
  readonly url: string;
  readonly credential: string;
  readonly iceServers?: RTCIceServer[];
  readonly relayOnly?: boolean;
  readonly timeoutMs?: number;
}

/** E2E results without connection information or payloads. */
export interface BrowserConnectionReport {
  readonly browserVersion: string;
  readonly health: BrowserHealthReport;
  readonly connectionMs: number[];
  readonly localCandidateTypes: string[];
  readonly reconnections: number;
  readonly assertions: {
    readonly stringEcho: 'PASS'; readonly twistEcho: 'PASS'; readonly customInterfaceEcho: 'PASS'; readonly expiredLeaseRejected: 'PASS';
    readonly expiredCommandNotObserved: 'PASS'; readonly oldEpochRejected: 'PASS';
    readonly oldEpochCommandNotObserved: 'PASS'; readonly distinctEpochs: 'PASS'; readonly selectedCandidate: 'PASS';
  };
}

/** Anonymized health-wait diagnostics. Example: success after a transient refusal gives attempts=2. */
export interface BrowserHealthReport {
  readonly attempts: number;
  readonly firstFailure: BrowserHealthFailure | 'none';
  readonly elapsedMs: number;
  readonly timeoutMs: number;
}

export type BrowserHealthFailure = 'connection_refused' | 'connection_reset' | 'address_unreachable'
  | 'http_status' | 'navigation_timeout' | 'unknown_error';

export type BrowserConnectionPhase = 'launch' | 'health' | 'connections' | 'cleanup';

/** Inject only Playwright health operations. Inputs: URL/timeout; returns an HTTP response. */
export interface BrowserHealthPage {
  goto(url: string, options: { timeout: number }): Promise<{ status(): number } | null>;
}

/** Clock and wait injection for helper tests. The production connection API derives timeouts from a shared deadline. */
export interface BrowserHealthOptions {
  readonly timeoutMs: number;
  readonly clock?: () => number;
  readonly delay?: (milliseconds: number) => Promise<void>;
}

export interface ScenarioInput extends BrowserConnectionOptions { readonly timeoutMs: number }
export type ScenarioReport = Omit<BrowserConnectionReport, 'browserVersion' | 'health'>;
export type ScenarioResult = ScenarioReport | { readonly failure: string };
