import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPerformanceConfig } from '../../../tests/performance/config.js';
import { evaluateGates } from '../../../tests/performance/gates.js';
import { parseContainerState } from '../../../tests/performance/process.js';
import { parseResourceSample, resourceGrowthPerHour } from '../../../tests/performance/resources.js';
import { performanceScenario } from '../../../tests/performance/scenario.js';
import type { BrowserRunReport, PerformanceConfig, ResourceReport } from '../../../tests/performance/types.js';

/** Return minimal gate-test configuration. No input; output: configuration with a validated shape. */
function config(): PerformanceConfig {
  return {
    version: 1, mode: 'unit',
    workload: { peers: 1, rateHz: 10, payloadBytes: 64, warmupSeconds: 0, durationSeconds: 1, drainTimeoutSeconds: 1 },
    timing: { overallTimeoutSeconds: 10, resourceSampleSeconds: 1, heartbeatSeconds: 1 },
    budgets: {
      invariants: { maxLoss: 0, maxRejects: 0, maxUnexpected: 0, maxRssMiB: 128,
        requireNoCrash: true, requireNoOom: true, requireCleanup: true },
      provisional: { maxRttP99Ms: 10, maxConnectionP99Ms: 100, minThroughputRatio: 0.5,
        maxRssGrowthMiBPerHour: 10 },
    },
  };
}

/** Return a successful gate-test report. No input; output: browser aggregates. */
function browserReport(): BrowserRunReport {
  return { browserVersion: 'unit', scenario: {
    connectionMs: { count: 1, p50: 5, p95: 5, p99: 5, max: 5 },
    rttMs: { count: 2, p50: 1, p95: 2, p99: 2, max: 2 }, sent: 2, echoed: 2,
    lost: 0, rejected: 0, unexpected: 0, failures: 0,
    throughputMessagesPerSecond: 10, targetMessagesPerSecond: 10,
  } };
}

/** Return sufficient observations for gate tests. No input; output: resource aggregates. */
function resourceReport(): ResourceReport {
  return { samples: 2, observationSeconds: 1, cpuPercent: { average: 1, max: 2 },
    rssMiB: { initial: 10, final: 10, max: 10, growthPerHour: 0 } };
}

test('performance config: validate profile selection, overrides, and invalid boundaries', async () => {
  const loaded = await loadPerformanceConfig({ PERFORMANCE_MODE: 'performance', PERFORMANCE_PEERS: '2',
    PERFORMANCE_REQUIRE_NO_CRASH: '1' });
  assert.equal(loaded.workload.peers, 2);
  await assert.rejects(loadPerformanceConfig({ PERFORMANCE_MODE: '../soak' }), /invalid_performance_mode/);
  await assert.rejects(loadPerformanceConfig({ PERFORMANCE_MODE: 'performance', PERFORMANCE_RATE_HZ: '' }), /invalid_performance_rate_hz/);
  await assert.rejects(loadPerformanceConfig({ PERFORMANCE_MODE: 'performance', PERFORMANCE_PEERS: '5' }), /invalid_performance_peers/);
  await assert.rejects(loadPerformanceConfig({ PERFORMANCE_MODE: 'performance', PERFORMANCE_OVERALL_TIMEOUT_SECONDS: '20' }), /invalid_overall_timeout/);
});

test('performance resource: distinguish parsing, slopes, and insufficient samples', () => {
  assert.deepEqual(parseResourceSample('12.5%|1GiB / 2GiB'), { cpuPercent: 12.5, rssMiB: 1024 });
  assert.throws(() => parseResourceSample('secret raw output'), /invalid_resource_sample/);
  assert.equal(resourceGrowthPerHour([]), null);
  assert.equal(resourceGrowthPerHour([{ atMs: 0, cpuPercent: 0, rssMiB: 10 }]), null);
  assert.equal(resourceGrowthPerHour([
    { atMs: 0, cpuPercent: 0, rssMiB: 10 },
    { atMs: 3600000, cpuPercent: 0, rssMiB: 12 },
  ]), 2);
});

test('performance gate: require sufficient observations instead of passing missing measurements', () => {
  const running = { available: true, running: true, exitCode: 0, oomKilled: false } as const;
  const missing = evaluateGates(config(), browserReport(), { ...resourceReport(), samples: 1,
    observationSeconds: 0, rssMiB: { ...resourceReport().rssMiB, growthPerHour: null } }, running, running, true);
  assert.equal(missing.resourceSamples?.pass, false);
  assert.equal(missing.resourceObservationSeconds?.pass, false);
  assert.equal(missing.rssGrowthPerHour?.pass, false);
  assert.equal(Object.values(evaluateGates(config(), browserReport(), resourceReport(), running, running, true))
    .every(gate => gate.pass), true);
  assert.equal(Object.values(evaluateGates(config(), undefined, undefined, { available: false }, running, false))
    .every(gate => gate.pass), false);
});

test('performance process: distinguish valid and invalid Docker states', () => {
  assert.deepEqual(parseContainerState('true 0 false'), { available: true, running: true, exitCode: 0, oomKilled: false });
  assert.deepEqual(parseContainerState('payload'), { available: false });
});

type FakeMode = 'exact' | 'corrupt' | 'wrong-channel';

/** Simulate a minimal browser-scenario DataChannel. Deliver sends asynchronously to its owning PC. */
class FakeDataChannel {
  readonly readyState = 'open';
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(readonly label: string, private readonly owner: FakePeerConnection) {}
  /** Pass wire data to the fake server. Input: JSON string; no output. */
  send(data: string): void { this.owner.route(this, JSON.parse(data)); }
}

/** Reproduce only WebRTC setup/control/echo, with injectable payload corruption and wrong channels. */
class FakePeerConnection {
  static mode: FakeMode = 'exact';
  readonly connectionState = 'connected';
  readonly iceGatheringState = 'complete';
  readonly channels = new Map<string, FakeDataChannel>();
  localDescription: { type: 'offer'; sdp: string } | null = null;
  /** Create a channel. Input: label; output: fake channel. */
  createDataChannel(label: string): FakeDataChannel {
    const channel = new FakeDataChannel(label, this); this.channels.set(label, channel); return channel;
  }
  /** Return an offer. No input; output: fixed SDP. */
  async createOffer(): Promise<{ type: 'offer'; sdp: string }> { return { type: 'offer', sdp: 'unit' }; }
  /** Store the local description. Input: offer; no output. */
  async setLocalDescription(value: { type: 'offer'; sdp: string }): Promise<void> { this.localDescription = value; }
  /** Accept an answer. Input: answer; no output. */
  async setRemoteDescription(): Promise<void> {}
  /** Close the fake connection. No input or output. */
  close(): void {}
  /** Return a control response or ROS echo to the client. Inputs: channel/wire; no output. */
  route(channel: FakeDataChannel, wire: Record<string, any>): void {
    const control = this.channels.get('ros.control.v1')!, reliable = this.channels.get('ros.reliable.v1')!;
    const deliver = (target: FakeDataChannel, response: Record<string, any>): void =>
      queueMicrotask(() => target.onmessage?.({ data: JSON.stringify({ v: 1, ...response }) }));
    if (channel === control && wire.op === 'hello') deliver(control, { op: 'welcome', epoch: 'epoch' });
    else if (channel === control && wire.op === 'subscribe') deliver(control, { op: 'subscribed', id: wire.id, stream_id: 'stream' });
    else if (channel === control && wire.op === 'advertise') deliver(control, { op: 'advertised', id: wire.id, handle: 'handle' });
    else if (channel === reliable && wire.op === 'publish') {
      deliver(control, { op: 'published_to_ros', handle: wire.handle, seq: wire.seq });
      const data = FakePeerConnection.mode === 'corrupt' ? `${wire.data.data}!` : wire.data.data;
      deliver(FakePeerConnection.mode === 'wrong-channel' ? control : reliable,
        { op: 'message', stream_id: 'stream', data: { data } });
    }
  }
}

/** Run the scenario with temporary fake browser boundaries in Node globals. Input: mode; output: scenario result. */
async function fakeScenario(mode: FakeMode) {
  const originalPeer = globalThis.RTCPeerConnection, originalFetch = globalThis.fetch;
  FakePeerConnection.mode = mode;
  Object.assign(globalThis, { RTCPeerConnection: FakePeerConnection,
    fetch: async () => ({ status: 200, json: async () => ({ type: 'answer', sdp: 'unit' }) }) });
  try {
    return await performanceScenario({ peers: 1, rateHz: 500, payloadBytes: 64, warmupSeconds: 0,
      durationSeconds: 0.01, drainTimeoutSeconds: 0.02, url: 'https://unit', credential: 'unit', timeoutMs: 1000 });
  } finally {
    Object.assign(globalThis, { RTCPeerConnection: originalPeer, fetch: originalFetch });
  }
}

test('performance scenario: accept echoes only with identical payloads on reliable channels', async () => {
  const exact = await fakeScenario('exact');
  assert.ok(!('failure' in exact) && exact.sent > 0 && exact.echoed === exact.sent && exact.unexpected === 0,
    JSON.stringify(exact));
  for (const mode of ['corrupt', 'wrong-channel'] as const) {
    const invalid = await fakeScenario(mode);
    assert.ok(!('failure' in invalid) && invalid.sent > 0 && invalid.lost > 0 && invalid.unexpected > 0);
  }
});
