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
  readonly connectionMs: number[];
  readonly localCandidateTypes: string[];
  readonly reconnections: number;
  readonly assertions: {
    readonly stringEcho: 'PASS'; readonly twistEcho: 'PASS'; readonly expiredLeaseRejected: 'PASS';
    readonly expiredCommandNotObserved: 'PASS'; readonly oldEpochRejected: 'PASS';
    readonly oldEpochCommandNotObserved: 'PASS'; readonly distinctEpochs: 'PASS'; readonly selectedCandidate: 'PASS';
  };
}

export interface ScenarioInput extends BrowserConnectionOptions { readonly timeoutMs: number }
export type ScenarioReport = Omit<BrowserConnectionReport, 'browserVersion'>;
export type ScenarioResult = ScenarioReport | { readonly failure: string };
