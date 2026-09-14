/** E2E接続情報は実行時だけ渡し、reportやlogに保存しない。 */
export interface BrowserConnectionOptions {
  readonly url: string;
  readonly credential: string;
  readonly iceServers?: RTCIceServer[];
  readonly relayOnly?: boolean;
  readonly timeoutMs?: number;
}

/** 接続情報やpayloadを含まないE2E結果。 */
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

/** health到達待ちの匿名診断。例: 一時refused後の成功 → attempts=2。 */
export interface BrowserHealthReport {
  readonly attempts: number;
  readonly firstFailure: BrowserHealthFailure | 'none';
  readonly elapsedMs: number;
  readonly timeoutMs: number;
}

export type BrowserHealthFailure = 'connection_refused' | 'connection_reset' | 'address_unreachable'
  | 'http_status' | 'navigation_timeout' | 'unknown_error';

export type BrowserConnectionPhase = 'launch' | 'health' | 'connections' | 'cleanup';

/** Playwrightのhealth操作だけを注入する。入力URL/timeout、出力HTTP response。 */
export interface BrowserHealthPage {
  goto(url: string, options: { timeout: number }): Promise<{ status(): number } | null>;
}

/** helper検証用の時計・待機注入。製品接続APIでは共通deadlineからtimeoutを算出する。 */
export interface BrowserHealthOptions {
  readonly timeoutMs: number;
  readonly clock?: () => number;
  readonly delay?: (milliseconds: number) => Promise<void>;
}

export interface ScenarioInput extends BrowserConnectionOptions { readonly timeoutMs: number }
export type ScenarioReport = Omit<BrowserConnectionReport, 'browserVersion' | 'health'>;
export type ScenarioResult = ScenarioReport | { readonly failure: string };
