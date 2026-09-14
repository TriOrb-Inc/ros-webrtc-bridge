import { setTimeout as delay } from 'node:timers/promises';
import { command } from './process.js';
import type { ResourceReport } from './types.js';

interface Sample { readonly atMs: number; readonly cpuPercent: number; readonly rssMiB: number }

/** Convert Docker size notation to MiB. Example: 1GiB returns 1024. */
function mebibytes(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(B|kB|KB|KiB|MB|MiB|GB|GiB)$/.exec(value.trim());
  if (!match) throw new Error('invalid_resource_sample');
  const factors: Record<string, number> = { B: 1 / 1048576, kB: 1000 / 1048576, KB: 1000 / 1048576,
    KiB: 1 / 1024, MB: 1000000 / 1048576, MiB: 1, GB: 1000000000 / 1048576, GiB: 1024 };
  return Number(match[1]) * factors[match[2]!]!;
}

/** Parse only anonymized CPU/RSS from docker stats. Input: one formatted line; returns sample values. */
export function parseResourceSample(value: string): Omit<Sample, 'atMs'> {
  const match = /^(\d+(?:\.\d+)?)%\|([^|/]+)\s*\//.exec(value.trim());
  if (!match) throw new Error('invalid_resource_sample');
  const cpuPercent = Number(match[1]), rssMiB = mebibytes(match[2]!);
  if (!Number.isFinite(cpuPercent) || !Number.isFinite(rssMiB)) throw new Error('invalid_resource_sample');
  return { cpuPercent, rssMiB };
}

/** Compute least-squares RSS slope in MiB/hour. Input: monotonic-time samples; returns growth rate or null for missing data. */
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

/** Periodically sample the Gateway cgroup using external docker stats. The orchestrator owns start/stop. */
export class ResourceSampler {
  private readonly samples: Sample[] = [];
  private stopping = false;
  private failed = false;
  private running: Promise<void> | undefined;
  private readonly waitController = new AbortController();

  /** Start the sampling loop. Inputs: container name/interval ms; no output. */
  start(container: string, intervalMs: number): void {
    if (this.running !== undefined) throw new Error('resource_sampler_already_started');
    this.running = this.loop(container, intervalMs);
  }

  /** Stop sampling and aggregate results. No input; returns anonymized CPU/RSS statistics. */
  async stop(): Promise<ResourceReport> {
    this.stopping = true;
    // Wait for docker stats itself with a finite timeout, but cancel long inter-sample delays immediately.
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

  /** Repeat bounded commands until stop is requested. Inputs: container/interval; returns a completion Promise. */
  private async loop(container: string, intervalMs: number): Promise<void> {
    while (!this.stopping) {
      const started = performance.now();
      try {
        // docker stats observes CPU differences for about one second; give it a finite deadline independent of the sampling interval.
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
