import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseDocument } from 'yaml';
import type { InvariantBudget, PerformanceConfig, ProvisionalBudget, TimingConfig, WorkloadConfig } from './types.js';

type MapValue = Record<string, unknown>;

/** Validate the object boundary and unknown keys. Example: ({a:1},['a']) returns a map. */
function map(value: unknown, keys: readonly string[], name: string): MapValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid_${name}`);
  const result = value as MapValue;
  if (Object.keys(result).some(key => !keys.includes(key))) throw new Error(`invalid_${name}`);
  return result;
}

/** Range-check a finite positive number. Example: (10,1,100,false) returns 10. */
function number(value: unknown, name: string, minimum: number, maximum: number, integer: boolean): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`invalid_${name}`);
  }
  return value;
}

/** Accept booleans only. Example: (true,'gate') returns true. */
function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`invalid_${name}`);
  return value;
}

/** Validate profile workload. Input: unvalidated map; returns bounded configuration. */
function workload(value: unknown): WorkloadConfig {
  const input = map(value, ['peers', 'rateHz', 'payloadBytes', 'warmupSeconds', 'durationSeconds', 'drainTimeoutSeconds'], 'workload');
  return Object.freeze({
    peers: number(input.peers, 'peers', 1, 4, true),
    rateHz: number(input.rateHz, 'rate_hz', 0.1, 500, false),
    payloadBytes: number(input.payloadBytes, 'payload_bytes', 64, 12000, true),
    warmupSeconds: number(input.warmupSeconds, 'warmup_seconds', 0, 3600, false),
    durationSeconds: number(input.durationSeconds, 'duration_seconds', 1, 86400, false),
    drainTimeoutSeconds: number(input.drainTimeoutSeconds, 'drain_timeout_seconds', 1, 300, false),
  });
}

/** Validate timeouts and sampling intervals. Input: unvalidated map; returns timing configuration. */
function timing(value: unknown): TimingConfig {
  const input = map(value, ['overallTimeoutSeconds', 'resourceSampleSeconds', 'heartbeatSeconds'], 'timing');
  return Object.freeze({
    overallTimeoutSeconds: number(input.overallTimeoutSeconds, 'overall_timeout_seconds', 10, 90000, false),
    resourceSampleSeconds: number(input.resourceSampleSeconds, 'resource_sample_seconds', 0.25, 60, false),
    heartbeatSeconds: number(input.heartbeatSeconds, 'heartbeat_seconds', 1, 5, false),
  });
}

/** Validate crash, loss, and resource safety invariants. Input: map; returns an invariant budget. */
function invariants(value: unknown): InvariantBudget {
  const input = map(value, ['maxLoss', 'maxRejects', 'maxUnexpected', 'maxRssMiB', 'requireNoCrash', 'requireNoOom', 'requireCleanup'], 'invariants');
  return Object.freeze({
    maxLoss: number(input.maxLoss, 'max_loss', 0, 1000000, true),
    maxRejects: number(input.maxRejects, 'max_rejects', 0, 1000000, true),
    maxUnexpected: number(input.maxUnexpected, 'max_unexpected', 0, 1000000, true),
    maxRssMiB: number(input.maxRssMiB, 'max_rss_mib', 1, 1048576, false),
    requireNoCrash: boolean(input.requireNoCrash, 'require_no_crash'),
    requireNoOom: boolean(input.requireNoOom, 'require_no_oom'),
    requireCleanup: boolean(input.requireCleanup, 'require_cleanup'),
  });
}

/** Validate uncalibrated PoC performance thresholds. Input: map; returns a provisional budget. */
function provisional(value: unknown): ProvisionalBudget {
  const input = map(value, ['maxRttP99Ms', 'maxConnectionP99Ms', 'minThroughputRatio', 'maxRssGrowthMiBPerHour'], 'provisional');
  return Object.freeze({
    maxRttP99Ms: number(input.maxRttP99Ms, 'max_rtt_p99_ms', 1, 600000, false),
    maxConnectionP99Ms: number(input.maxConnectionP99Ms, 'max_connection_p99_ms', 1, 600000, false),
    minThroughputRatio: number(input.minThroughputRatio, 'min_throughput_ratio', 0, 1, false),
    maxRssGrowthMiBPerHour: number(input.maxRssGrowthMiBPerHour, 'max_rss_growth_mib_per_hour', 0, 1048576, false),
  });
}

/** Apply a numeric environment override. Inputs: current value/env name/range; returns the overridden value. */
function environmentNumber(current: number, env: NodeJS.ProcessEnv, name: string, minimum: number, maximum: number, integer = false): number {
  const raw = env[name];
  if (raw === undefined) return current;
  if (raw.trim() === '') throw new Error(`invalid_${name.toLowerCase()}`);
  return number(Number(raw), name.toLowerCase(), minimum, maximum, integer);
}

/** Apply a 0/1 boolean environment override. Inputs: current value/env name; returns a boolean. */
function environmentBoolean(current: boolean, env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name];
  if (raw === undefined) return current;
  if (raw !== '0' && raw !== '1') throw new Error(`invalid_${name.toLowerCase()}`);
  return raw === '1';
}

/** Apply environment overrides to a profile. Inputs: profile/env; returns a frozen PerformanceConfig. */
function overrides(mode: string, base: Omit<PerformanceConfig, 'mode' | 'version'>, env: NodeJS.ProcessEnv): PerformanceConfig {
  const w = base.workload, t = base.timing, i = base.budgets.invariants, p = base.budgets.provisional;
  const configured: PerformanceConfig = {
    version: 1,
    mode,
    workload: {
      peers: environmentNumber(w.peers, env, 'PERFORMANCE_PEERS', 1, 4, true),
      rateHz: environmentNumber(w.rateHz, env, 'PERFORMANCE_RATE_HZ', 0.1, 500),
      payloadBytes: environmentNumber(w.payloadBytes, env, 'PERFORMANCE_PAYLOAD_BYTES', 64, 12000, true),
      warmupSeconds: environmentNumber(w.warmupSeconds, env, 'PERFORMANCE_WARMUP_SECONDS', 0, 3600),
      durationSeconds: environmentNumber(w.durationSeconds, env, 'PERFORMANCE_DURATION_SECONDS', 1, 86400),
      drainTimeoutSeconds: environmentNumber(w.drainTimeoutSeconds, env, 'PERFORMANCE_DRAIN_TIMEOUT_SECONDS', 1, 300),
    },
    timing: {
      overallTimeoutSeconds: environmentNumber(t.overallTimeoutSeconds, env, 'PERFORMANCE_OVERALL_TIMEOUT_SECONDS', 10, 90000),
      resourceSampleSeconds: environmentNumber(t.resourceSampleSeconds, env, 'PERFORMANCE_RESOURCE_SAMPLE_SECONDS', 0.25, 60),
      heartbeatSeconds: environmentNumber(t.heartbeatSeconds, env, 'PERFORMANCE_HEARTBEAT_SECONDS', 1, 5),
    },
    budgets: { invariants: {
      ...i,
      maxLoss: environmentNumber(i.maxLoss, env, 'PERFORMANCE_MAX_LOSS', 0, 1000000, true),
      maxRejects: environmentNumber(i.maxRejects, env, 'PERFORMANCE_MAX_REJECTS', 0, 1000000, true),
      maxUnexpected: environmentNumber(i.maxUnexpected, env, 'PERFORMANCE_MAX_UNEXPECTED', 0, 1000000, true),
      maxRssMiB: environmentNumber(i.maxRssMiB, env, 'PERFORMANCE_MAX_RSS_MIB', 1, 1048576),
      requireNoCrash: environmentBoolean(i.requireNoCrash, env, 'PERFORMANCE_REQUIRE_NO_CRASH'),
      requireNoOom: environmentBoolean(i.requireNoOom, env, 'PERFORMANCE_REQUIRE_NO_OOM'),
      requireCleanup: environmentBoolean(i.requireCleanup, env, 'PERFORMANCE_REQUIRE_CLEANUP'),
    }, provisional: {
      maxRttP99Ms: environmentNumber(p.maxRttP99Ms, env, 'PERFORMANCE_MAX_RTT_P99_MS', 1, 600000),
      maxConnectionP99Ms: environmentNumber(p.maxConnectionP99Ms, env, 'PERFORMANCE_MAX_CONNECTION_P99_MS', 1, 600000),
      minThroughputRatio: environmentNumber(p.minThroughputRatio, env, 'PERFORMANCE_MIN_THROUGHPUT_RATIO', 0, 1),
      maxRssGrowthMiBPerHour: environmentNumber(p.maxRssGrowthMiBPerHour, env, 'PERFORMANCE_MAX_RSS_GROWTH_MIB_PER_HOUR', 0, 1048576),
    } },
  };
  if (configured.timing.overallTimeoutSeconds <= configured.workload.warmupSeconds + configured.workload.durationSeconds + configured.workload.drainTimeoutSeconds) {
    throw new Error('invalid_overall_timeout');
  }
  return Object.freeze(configured);
}

/** Read JSON/YAML configuration and return the selected profile. Input: env; returns validated configuration. */
export async function loadPerformanceConfig(env: NodeJS.ProcessEnv = process.env): Promise<PerformanceConfig> {
  const path = resolve(env.PERFORMANCE_CONFIG ?? 'tests/performance/default.json');
  const source = await readFile(path, 'utf8');
  if (Buffer.byteLength(source) > 1048576) throw new Error('performance_config_too_large');
  const document = parseDocument(source, { uniqueKeys: true, schema: 'core' });
  if (document.errors.length || document.warnings.length) throw new Error('invalid_performance_config');
  const root = map(document.toJS({ maxAliasCount: 0 }), ['version', 'profiles'], 'config');
  if (root.version !== 1) throw new Error('invalid_config_version');
  const profiles = map(root.profiles, Object.keys(Object(root.profiles)), 'profiles');
  const mode = env.PERFORMANCE_MODE ?? 'performance';
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(mode) || profiles[mode] === undefined) throw new Error('invalid_performance_mode');
  const profile = map(profiles[mode], ['workload', 'timing', 'budgets'], 'profile');
  const budget = map(profile.budgets, ['invariants', 'provisional'], 'budgets');
  return overrides(mode, { workload: workload(profile.workload), timing: timing(profile.timing),
    budgets: { invariants: invariants(budget.invariants), provisional: provisional(budget.provisional) } }, env);
}
