import type { MediaSource, VideoDiagnostics, VideoSourceOptions, VideoState, Viewer } from './types.js';

/**
 * One configured video source and its viewers.
 *
 * The encoder exists only while somebody is watching: the first viewer starts it and the last one
 * leaving stops it after a short grace window, so a page reload does not restart the pipeline. All
 * viewers of a source share a single encoded stream; RTP is fanned out unchanged and never queued,
 * because a late frame is worth less than the next one.
 */
export class VideoSource {
  private readonly options: VideoSourceOptions;
  private readonly viewers = new Set<Viewer>();
  private source?: MediaSource;
  // While armed, the encoder still runs with no viewers: the grace window before it stops.
  private cancelGrace?: () => void;
  private cancelStart?: () => void;
  private phase: VideoState = 'idle';
  private lastKeyframeAt = Number.NEGATIVE_INFINITY;
  private packets = 0;
  private keyframeRequests = 0;

  /** Own one validated binding. Input: VideoSourceOptions with injected clock and scheduler; returns a source. */
  constructor(options: VideoSourceOptions) {
    this.options = options;
  }

  /**
   * Whether this source currently holds an encoder. No input; returns true while one runs.
   *
   * True through the grace window as well: the encoder is still running there, just unwatched, so a
   * concurrency bound that ignored it would let one more start than the host was configured for.
   */
  get running(): boolean {
    return this.phase !== 'idle' && this.phase !== 'failed';
  }

  /** Report counters for internal diagnostics. No input; returns a snapshot without paths or payloads. */
  get diagnostics(): VideoDiagnostics {
    return { track: this.options.binding.name, backend: this.options.binding.encoder.backend,
      state: this.phase, viewers: this.viewers.size, packets: this.packets, keyframeRequests: this.keyframeRequests };
  }

  /** Verify the backend before peers are accepted. No input; rejects with an actionable local reason. */
  async probe(): Promise<void> {
    await this.options.create(this.options.binding).probe();
  }

  /**
   * Add a viewer, starting the encoder if it is the first.
   * @param viewer Sink for RTP and lifecycle notifications.
   * @returns void. The viewer is told the current state immediately, e.g. `starting` then `active`.
   */
  add(viewer: Viewer): void {
    this.viewers.add(viewer);
    // Arriving inside the grace window keeps the encoder that never actually stopped, so a page
    // reload costs nothing.
    this.cancelGrace?.();
    this.cancelGrace = undefined;
    // Starting announces the new phase to everyone, including this viewer.
    if (this.phase === 'idle' || this.phase === 'failed') { void this.begin(); return; }
    // Joining mid-stream means the last IDR is already gone, so ask for a new one rather than
    // leaving this viewer with undecodable frames until the next scheduled keyframe.
    if (this.phase === 'active') this.requestKeyframe();
    viewer.state(this.phase);
  }

  /**
   * Remove a viewer, stopping the encoder once nobody is left.
   * @param viewer Previously added sink; removing an unknown viewer is a no-op.
   * @returns void. The stop is deferred by the configured grace window.
   */
  remove(viewer: Viewer): void {
    if (!this.viewers.delete(viewer) || this.viewers.size > 0 || this.phase === 'idle') return;
    // Keep the phase as it is: the encoder is still running, just unwatched. The armed timer is
    // what distinguishes this from an ordinary active source.
    this.cancelGrace = this.options.schedule(() => {
      this.cancelGrace = undefined;
      void this.finish('idle');
    }, this.options.settings.stopGraceMs);
  }

  /** Ask the encoder for an IDR, rate limited. No input; returns void. Bursts of PLI collapse into one. */
  requestKeyframe(): void {
    const now = this.options.clock();
    // A decoder in trouble sends PLI repeatedly. Honouring every one would pin the encoder at its
    // most expensive setting and make the stall worse.
    if (now - this.lastKeyframeAt < this.options.settings.pliMinIntervalMs) return;
    this.lastKeyframeAt = now;
    this.keyframeRequests++;
    try { this.source?.requestKeyframe(); } catch { this.options.onError(); }
  }

  /** Release the encoder and forget every viewer. No input; returns a completion Promise. Idempotent. */
  async close(): Promise<void> {
    this.viewers.clear();
    await this.finish('idle');
  }

  /** Start the encoder for the first viewer. No input; returns a completion Promise. Failures notify viewers. */
  private async begin(): Promise<void> {
    this.phase = 'starting';
    this.notify();
    // An encoder that never emits is indistinguishable from a hung one; bound the wait explicitly.
    this.cancelStart = this.options.schedule(() => { void this.finish('failed'); }, this.options.settings.startTimeoutMs);
    const source = this.options.create(this.options.binding);
    this.source = source;
    try {
      await source.start(packet => this.deliver(packet), () => { void this.finish('failed'); });
    } catch {
      this.options.onError();
      await this.finish('failed');
    }
  }

  /** Fan one RTP packet out to every viewer. Input: complete RTP packet; returns void. */
  private deliver(packet: Buffer): void {
    // The first packet is the only evidence the encoder really produced output.
    if (this.phase === 'starting') {
      this.cancelStart?.();
      this.cancelStart = undefined;
      this.phase = 'active';
      this.notify();
    }
    if (this.phase !== 'active') return;
    this.packets++;
    // One failing peer must not stop delivery to the others, so each write is isolated.
    for (const viewer of this.viewers) {
      try { viewer.write(packet); } catch { this.options.onError(); }
    }
  }

  /** Release the encoder and settle on a terminal phase. Input: resulting state; returns a completion Promise. */
  private async finish(phase: 'idle' | 'failed'): Promise<void> {
    this.cancelStart?.();
    this.cancelStart = undefined;
    this.cancelGrace?.();
    this.cancelGrace = undefined;
    const source = this.source;
    this.source = undefined;
    this.phase = phase;
    this.notify();
    // Stop must not leave a child process behind even when it reports a failure.
    try { await source?.stop(); } catch { this.options.onError(); }
  }

  /** Tell every viewer the current phase. No input; returns void. Notification callbacks must not throw. */
  private notify(): void {
    for (const viewer of this.viewers) viewer.state(this.phase);
  }
}
