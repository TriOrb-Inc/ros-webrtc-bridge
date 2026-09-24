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

/** Runtime settings for the video scenario. Credentials never leave the page. */
export interface VideoScenarioInput {
  readonly url: string;
  readonly credential: string;
  readonly slots: number;
  readonly timeoutMs: number;
}

/** Video E2E measurements, or a fixed failure classification. Never carries connection details. */
export type VideoScenarioResult = { readonly failure: string; readonly diagnostics?: Record<string, number | string> } | {
  readonly framesDecoded: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly keyFramesDecoded: number;
  readonly mid: string;
  readonly track: string;
  readonly slots: number;
  readonly assertions: {
    readonly silentBeforeSubscribe: 'PASS';
    readonly decodedAfterSubscribe: 'PASS';
    readonly stoppedAfterUnsubscribe: 'PASS';
    readonly resumedOnSameSection: 'PASS';
  };
};

/**
 * Runtime settings for one load phase. Credentials never leave the page.
 *
 * The phases run separately so resident memory can be sampled between them: an encoder's libraries
 * are loaded once, and counting that one-time cost as growth would report every hardware run as a
 * leak.
 */
export interface VideoLoadInput {
  readonly url: string;
  readonly credential: string;
  readonly phase: 'viewers' | 'cycles';
  readonly viewers: number;
  readonly cycles: number;
  readonly holdMs: number;
  readonly timeoutMs: number;
}

/** Measurements for one load phase, or a fixed failure classification. */
export type VideoLoadResult = { readonly failure: string; readonly diagnostics?: Record<string, number | string> }
  | {
    readonly phase: 'viewers';
    readonly viewers: { readonly count: number; readonly framesDecoded: number[]; readonly survivorsAdvanced: number };
    readonly assertions: { readonly everyViewerDecoded: 'PASS'; readonly departureDidNotDisturbOthers: 'PASS' };
  }
  | {
    readonly phase: 'cycles';
    readonly cycles: { readonly count: number; readonly framesDecoded: number[] };
    readonly assertions: { readonly everyCycleDecoded: 'PASS'; readonly lastCycleMatchedFirst: 'PASS' };
  };
