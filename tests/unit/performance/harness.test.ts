import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPerformanceConfig } from '../../../tests/performance/config.js';
import { evaluateGates } from '../../../tests/performance/gates.js';
import { parseContainerState } from '../../../tests/performance/process.js';
import { parseResourceSample, resourceGrowthPerHour } from '../../../tests/performance/resources.js';
import { performanceScenario } from '../../../tests/performance/scenario.js';
import type { BrowserRunReport, PerformanceConfig, ResourceReport } from '../../../tests/performance/types.js';

/** gate試験用の最小構成を返す。入力なし、出力: 検証済み形状の設定。 */
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

/** gate試験用の成功reportを返す。入力なし、出力: browser集計。 */
function browserReport(): BrowserRunReport {
  return { browserVersion: 'unit', scenario: {
    connectionMs: { count: 1, p50: 5, p95: 5, p99: 5, max: 5 },
    rttMs: { count: 2, p50: 1, p95: 2, p99: 2, max: 2 }, sent: 2, echoed: 2,
    lost: 0, rejected: 0, unexpected: 0, failures: 0,
    throughputMessagesPerSecond: 10, targetMessagesPerSecond: 10,
  } };
}

/** gate試験用の十分な観測を返す。入力なし、出力: resource集計。 */
function resourceReport(): ResourceReport {
  return { samples: 2, observationSeconds: 1, cpuPercent: { average: 1, max: 2 },
    rssMiB: { initial: 10, final: 10, max: 10, growthPerHour: 0 } };
}

test('performance config: profile選択・override・不正境界を検証する', async () => {
  const loaded = await loadPerformanceConfig({ PERFORMANCE_MODE: 'performance', PERFORMANCE_PEERS: '2',
    PERFORMANCE_REQUIRE_NO_CRASH: '1' });
  assert.equal(loaded.workload.peers, 2);
  await assert.rejects(loadPerformanceConfig({ PERFORMANCE_MODE: '../soak' }), /invalid_performance_mode/);
  await assert.rejects(loadPerformanceConfig({ PERFORMANCE_MODE: 'performance', PERFORMANCE_RATE_HZ: '' }), /invalid_performance_rate_hz/);
  await assert.rejects(loadPerformanceConfig({ PERFORMANCE_MODE: 'performance', PERFORMANCE_PEERS: '5' }), /invalid_performance_peers/);
  await assert.rejects(loadPerformanceConfig({ PERFORMANCE_MODE: 'performance', PERFORMANCE_OVERALL_TIMEOUT_SECONDS: '20' }), /invalid_overall_timeout/);
});

test('performance resource: parser・傾き・sample不足を区別する', () => {
  assert.deepEqual(parseResourceSample('12.5%|1GiB / 2GiB'), { cpuPercent: 12.5, rssMiB: 1024 });
  assert.throws(() => parseResourceSample('secret raw output'), /invalid_resource_sample/);
  assert.equal(resourceGrowthPerHour([]), null);
  assert.equal(resourceGrowthPerHour([{ atMs: 0, cpuPercent: 0, rssMiB: 10 }]), null);
  assert.equal(resourceGrowthPerHour([
    { atMs: 0, cpuPercent: 0, rssMiB: 10 },
    { atMs: 3600000, cpuPercent: 0, rssMiB: 12 },
  ]), 2);
});

test('performance gate: 欠測を合格にせず十分な観測だけを通す', () => {
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

test('performance process: Docker状態の正常値と不正値を区別する', () => {
  assert.deepEqual(parseContainerState('true 0 false'), { available: true, running: true, exitCode: 0, oomKilled: false });
  assert.deepEqual(parseContainerState('payload'), { available: false });
});

type FakeMode = 'exact' | 'corrupt' | 'wrong-channel';

/** browser scenario用の最小DataChannelを模倣する。送信は所有PCへ同期せず配送する。 */
class FakeDataChannel {
  readonly readyState = 'open';
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(readonly label: string, private readonly owner: FakePeerConnection) {}
  /** wireをfake serverへ渡す。入力: JSON文字列、出力なし。 */
  send(data: string): void { this.owner.route(this, JSON.parse(data)); }
}

/** WebRTC setup/control/echoだけを再現し、payload破損と誤channelを注入できる。 */
class FakePeerConnection {
  static mode: FakeMode = 'exact';
  readonly connectionState = 'connected';
  readonly iceGatheringState = 'complete';
  readonly channels = new Map<string, FakeDataChannel>();
  localDescription: { type: 'offer'; sdp: string } | null = null;
  /** channelを作る。入力: label、出力: fake channel。 */
  createDataChannel(label: string): FakeDataChannel {
    const channel = new FakeDataChannel(label, this); this.channels.set(label, channel); return channel;
  }
  /** offerを返す。入力なし、出力: 固定SDP。 */
  async createOffer(): Promise<{ type: 'offer'; sdp: string }> { return { type: 'offer', sdp: 'unit' }; }
  /** local descriptionを保存する。入力: offer、出力なし。 */
  async setLocalDescription(value: { type: 'offer'; sdp: string }): Promise<void> { this.localDescription = value; }
  /** answerを受理する。入力: answer、出力なし。 */
  async setRemoteDescription(): Promise<void> {}
  /** fake connectionを閉じる。入力なし、出力なし。 */
  close(): void {}
  /** client wireへcontrol応答またはROS echoを返す。入力: channel/wire、出力なし。 */
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

/** Node globalへfake browser境界を一時注入してscenarioを実行する。入力: mode、出力: scenario結果。 */
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

test('performance scenario: payload完全一致とreliable channelだけをecho成功にする', async () => {
  const exact = await fakeScenario('exact');
  assert.ok(!('failure' in exact) && exact.sent > 0 && exact.echoed === exact.sent && exact.unexpected === 0,
    JSON.stringify(exact));
  for (const mode of ['corrupt', 'wrong-channel'] as const) {
    const invalid = await fakeScenario(mode);
    assert.ok(!('failure' in invalid) && invalid.sent > 0 && invalid.lost > 0 && invalid.unexpected > 0);
  }
});
