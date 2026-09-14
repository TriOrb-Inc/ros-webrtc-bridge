export interface WorkloadConfig {
  readonly peers: number;
  readonly rateHz: number;
  readonly payloadBytes: number;
  readonly warmupSeconds: number;
  readonly durationSeconds: number;
  readonly drainTimeoutSeconds: number;
}

export interface TimingConfig {
  readonly overallTimeoutSeconds: number;
  readonly resourceSampleSeconds: number;
  readonly heartbeatSeconds: number;
}

export interface InvariantBudget {
  readonly maxLoss: number;
  readonly maxRejects: number;
  readonly maxUnexpected: number;
  readonly maxRssMiB: number;
  readonly requireNoCrash: boolean;
  readonly requireNoOom: boolean;
  readonly requireCleanup: boolean;
}

export interface ProvisionalBudget {
  readonly maxRttP99Ms: number;
  readonly maxConnectionP99Ms: number;
  readonly minThroughputRatio: number;
  readonly maxRssGrowthMiBPerHour: number;
}

export interface PerformanceConfig {
  readonly version: 1;
  readonly mode: string;
  readonly workload: WorkloadConfig;
  readonly timing: TimingConfig;
  readonly budgets: {
    readonly invariants: InvariantBudget;
    readonly provisional: ProvisionalBudget;
  };
}

export interface ScenarioInput extends WorkloadConfig {
  readonly url: string;
  readonly credential: string;
  readonly timeoutMs: number;
}

export interface Distribution {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

export interface ScenarioReport {
  readonly connectionMs: Distribution;
  readonly rttMs: Distribution;
  readonly sent: number;
  readonly echoed: number;
  readonly lost: number;
  readonly rejected: number;
  readonly unexpected: number;
  readonly failures: number;
  readonly throughputMessagesPerSecond: number;
  readonly targetMessagesPerSecond: number;
}

export type ScenarioResult = ScenarioReport | { readonly failure: string };

export interface BrowserRunReport {
  readonly browserVersion: string;
  readonly scenario: ScenarioReport;
}

export interface ResourceReport {
  readonly samples: number;
  readonly observationSeconds: number;
  readonly cpuPercent: { readonly average: number; readonly max: number };
  readonly rssMiB: { readonly initial: number; readonly final: number; readonly max: number; readonly growthPerHour: number | null };
}

export interface ContainerState {
  readonly available: boolean;
  readonly running?: boolean;
  readonly exitCode?: number;
  readonly oomKilled?: boolean;
}
