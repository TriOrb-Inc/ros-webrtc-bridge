import type { BrowserRunReport, ContainerState, PerformanceConfig, ResourceReport } from './types.js';

export interface Gate {
  readonly class: 'invariant' | 'provisional';
  readonly measured: number | boolean | null;
  readonly budget: number | boolean;
  readonly pass: boolean;
}

/** 実測値と安全/provisional budgetを比較する。入力: config/reports/state/cleanup、出力: 分類付きgate。 */
export function evaluateGates(config: PerformanceConfig, browser: BrowserRunReport | undefined,
  resources: ResourceReport | undefined, gateway: ContainerState, peer: ContainerState,
  cleanup: boolean): Readonly<Record<string, Gate>> {
  const scenario = browser?.scenario;
  const invariant = config.budgets.invariants, provisional = config.budgets.provisional;
  const ratio = scenario === undefined || scenario.targetMessagesPerSecond === 0 ? 0
    : scenario.throughputMessagesPerSecond / scenario.targetMessagesPerSecond;
  const noCrash = gateway.available && gateway.running === true && peer.available && peer.running === true;
  const noOom = gateway.available && gateway.oomKilled === false && peer.available && peer.oomKilled === false;
  const enoughSamples = resources !== undefined && resources.samples >= 2;
  const enoughObservation = resources !== undefined && resources.observationSeconds >= 1;
  /** 同じ形のgateを作り、report側でclassを失わない。入力: class/値/budget/pass、出力: Gate。 */
  const gate = (kind: Gate['class'], measured: Gate['measured'], budget: Gate['budget'], pass: boolean): Gate =>
    Object.freeze({ class: kind, measured, budget, pass });
  return Object.freeze({
    loss: gate('invariant', scenario?.lost ?? -1, invariant.maxLoss, scenario !== undefined && scenario.lost <= invariant.maxLoss),
    rejects: gate('invariant', scenario?.rejected ?? -1, invariant.maxRejects, scenario !== undefined && scenario.rejected <= invariant.maxRejects),
    unexpected: gate('invariant', scenario?.unexpected ?? -1, invariant.maxUnexpected,
      scenario !== undefined && scenario.unexpected <= invariant.maxUnexpected),
    rss: gate('invariant', resources?.rssMiB.max ?? -1, invariant.maxRssMiB,
      resources !== undefined && resources.rssMiB.max <= invariant.maxRssMiB),
    resourceSamples: gate('invariant', resources?.samples ?? -1, 2, enoughSamples),
    resourceObservationSeconds: gate('invariant', resources?.observationSeconds ?? -1, 1, enoughObservation),
    noCrash: gate('invariant', noCrash, invariant.requireNoCrash, !invariant.requireNoCrash || noCrash),
    noOom: gate('invariant', noOom, invariant.requireNoOom, !invariant.requireNoOom || noOom),
    cleanup: gate('invariant', cleanup, invariant.requireCleanup, !invariant.requireCleanup || cleanup),
    rttP99: gate('provisional', scenario?.rttMs.p99 ?? -1, provisional.maxRttP99Ms,
      scenario !== undefined && scenario.rttMs.count > 0 && scenario.rttMs.p99 <= provisional.maxRttP99Ms),
    connectionP99: gate('provisional', scenario?.connectionMs.p99 ?? -1, provisional.maxConnectionP99Ms,
      scenario !== undefined && scenario.connectionMs.count > 0 && scenario.connectionMs.p99 <= provisional.maxConnectionP99Ms),
    throughputRatio: gate('provisional', ratio, provisional.minThroughputRatio,
      scenario !== undefined && ratio >= provisional.minThroughputRatio),
    rssGrowthPerHour: gate('provisional', resources?.rssMiB.growthPerHour ?? null,
      provisional.maxRssGrowthMiBPerHour, enoughSamples && enoughObservation
      && resources!.rssMiB.growthPerHour !== null
      && resources!.rssMiB.growthPerHour <= provisional.maxRssGrowthMiBPerHour),
  });
}
