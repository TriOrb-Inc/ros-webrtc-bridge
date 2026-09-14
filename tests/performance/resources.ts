import { setTimeout as delay } from 'node:timers/promises';
import { command } from './process.js';
import type { ResourceReport } from './types.js';

interface Sample { readonly atMs: number; readonly cpuPercent: number; readonly rssMiB: number }

/** Dockerの容量表記をMiBへ変換する。入力例: 1GiB、出力: 1024。 */
function mebibytes(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(B|kB|KB|KiB|MB|MiB|GB|GiB)$/.exec(value.trim());
  if (!match) throw new Error('invalid_resource_sample');
  const factors: Record<string, number> = { B: 1 / 1048576, kB: 1000 / 1048576, KB: 1000 / 1048576,
    KiB: 1 / 1024, MB: 1000000 / 1048576, MiB: 1, GB: 1000000000 / 1048576, GiB: 1024 };
  return Number(match[1]) * factors[match[2]!]!;
}

/** docker statsの匿名CPU/RSSだけを解析する。入力: format済み1行、出力: sample値。 */
export function parseResourceSample(value: string): Omit<Sample, 'atMs'> {
  const match = /^(\d+(?:\.\d+)?)%\|([^|/]+)\s*\//.exec(value.trim());
  if (!match) throw new Error('invalid_resource_sample');
  const cpuPercent = Number(match[1]), rssMiB = mebibytes(match[2]!);
  if (!Number.isFinite(cpuPercent) || !Number.isFinite(rssMiB)) throw new Error('invalid_resource_sample');
  return { cpuPercent, rssMiB };
}

/** 最小二乗のRSS傾きをMiB/hourで返す。入力: 単調時刻sample、出力: growth rateまたは欠測null。 */
export function resourceGrowthPerHour(samples: readonly Sample[]): number | null {
  if (samples.length < 2) return null;
  const origin = samples[0]!.atMs;
  const points = samples.map(sample => ({ x: (sample.atMs - origin) / 3600000, y: sample.rssMiB }));
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const numerator = points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0);
  const denominator = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  return denominator === 0 ? null : numerator / denominator;
}

/** 外部docker statsでgateway cgroupを周期sampleする。start/stopの所有権はorchestratorにある。 */
export class ResourceSampler {
  private readonly samples: Sample[] = [];
  private stopping = false;
  private failed = false;
  private running: Promise<void> | undefined;
  private readonly waitController = new AbortController();

  /** sampling loopを開始する。入力: container名/間隔ms、出力なし。 */
  start(container: string, intervalMs: number): void {
    if (this.running !== undefined) throw new Error('resource_sampler_already_started');
    this.running = this.loop(container, intervalMs);
  }

  /** samplingを停止し集計する。入力なし、出力: CPU/RSS匿名統計。 */
  async stop(): Promise<ResourceReport> {
    this.stopping = true;
    // docker stats実行自体は有限timeoutで待つが、sample間の長いdelayは即時解除する。
    this.waitController.abort();
    await this.running;
    if (this.failed || this.samples.length === 0) throw new Error('resource_sampling_failed');
    const cpu = this.samples.map(sample => sample.cpuPercent), rss = this.samples.map(sample => sample.rssMiB);
    const observationSeconds = this.samples.length < 2 ? 0
      : (this.samples.at(-1)!.atMs - this.samples[0]!.atMs) / 1000;
    return Object.freeze({ samples: this.samples.length, observationSeconds,
      cpuPercent: { average: cpu.reduce((sum, value) => sum + value, 0) / cpu.length, max: Math.max(...cpu) },
      rssMiB: { initial: rss[0]!, final: rss.at(-1)!, max: Math.max(...rss), growthPerHour: resourceGrowthPerHour(this.samples) } });
  }

  /** stop要求まで有限commandを繰り返す。入力: container/間隔、出力: 完了promise。 */
  private async loop(container: string, intervalMs: number): Promise<void> {
    while (!this.stopping) {
      const started = performance.now();
      try {
        // docker statsはCPU差分を得るため約1秒観測するので、sampling間隔より独立した有限上限を持たせる。
        const output = await command('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}', container], Math.max(5000, intervalMs * 2));
        this.samples.push({ atMs: performance.now(), ...parseResourceSample(output.split('\n')[0] ?? '') });
      } catch {
        this.failed = true;
        return;
      }
      const remaining = intervalMs - (performance.now() - started);
      if (!this.stopping && remaining > 0) {
        try { await delay(remaining, undefined, { signal: this.waitController.signal }); }
        catch (error) {
          if (!this.stopping || !(error instanceof Error) || error.name !== 'AbortError') throw error;
        }
      }
    }
  }
}
