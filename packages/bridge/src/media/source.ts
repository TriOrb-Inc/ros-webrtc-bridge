import type { MediaSource, VideoDiagnostics, VideoSourceOptions, VideoState, Viewer } from './types.js';

/** H.264 RTP clock, fixed by RFC 6184. Used to space one encoder's stream after the previous one. */
const CLOCK_HZ = 90000;

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
  private failedAt = Number.NEGATIVE_INFINITY;
  // RTP numbering for the track, which outlives any single encoder. See `renumber`.
  private sequence = 0;
  private emitted = 0;
  private origin?: number;
  private shift = 0;
  private packets = 0;
  private keyframeRequests = 0;
  // Pending while an encoder is being released; a restart waits on it so one track never holds two.
  private release?: Promise<void>;

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
    // The release window counts too: after the phase is terminal the worker has not necessarily
    // exited, and a wedged one is held for the forced-stop interval - exactly when letting another
    // encoder start would exceed the bound the host was configured for.
    return this.release !== undefined || (this.phase !== 'idle' && this.phase !== 'failed');
  }

  /** Report counters for internal diagnostics. No input; returns a snapshot without paths or payloads. */
  get diagnostics(): VideoDiagnostics {
    return { track: this.options.binding.name, backend: this.options.binding.encoder.backend,
      state: this.phase, viewers: this.viewers.size, packets: this.packets, keyframeRequests: this.keyframeRequests };
  }

  /**
   * Whether a subscription may start this source now. No input; returns false inside a retry window.
   *
   * Retrying is deliberately a peer's decision, which means the rate is a peer's decision too.
   * Against a backend that always fails - an unplugged camera - that turns each subscription into a
   * worker process, and the control rate limit alone allows a hundred a second. This is asked before
   * the viewer is taken on, so a refused peer holds no state and can simply ask again later.
   */
  get retryable(): boolean {
    return this.options.clock() - this.failedAt >= this.options.settings.retryMinIntervalMs;
  }

  /**
   * Verify the backend before peers are accepted. No input; rejects with an actionable local reason.
   *
   * Bounded, because this runs before the listener opens: a worker that is spawned and then wedges -
   * a pipeline that never leaves its state change, a device that never answers - would otherwise
   * leave the bridge with no HTTPS listener, no error and no exit, still printing that it is alive.
   */
  async probe(): Promise<void> {
    const source = this.options.create(this.options.binding);
    let cancel: (() => void) | undefined;
    let expired = false;
    const deadline = new Promise<never>((_, reject) => {
      cancel = this.options.schedule(() => {
        expired = true;
        reject(new Error('backend did not answer the probe'));
      }, this.options.settings.startTimeoutMs);
    });
    try { await Promise.race([source.probe(), deadline]); }
    finally {
      cancel?.();
      // A probe releases its own worker whichever way it answers. One that never answers leaves a
      // process behind, and that one is ours to end.
      if (expired) await source.stop().catch(() => { this.options.onError(); });
    }
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
    // A start suspended on a release is still in flight, and its own finish had nothing to stop yet.
    // Waiting here is what makes close mean the encoder is gone rather than scheduled to appear.
    await this.release;
  }

  /** Start the encoder for the first viewer. No input; returns a completion Promise. Failures notify viewers. */
  private async begin(): Promise<void> {
    this.phase = 'starting';
    this.notify();
    // An encoder that never emits is indistinguishable from a hung one; bound the wait explicitly.
    this.cancelStart = this.options.schedule(() => { void this.finish('failed'); }, this.options.settings.startTimeoutMs);
    // The phase above already claims this source, so a second viewer will not start a third encoder
    // while this waits for the previous one to finish going away. Only await when there is something
    // to wait for: awaiting nothing would still yield, and the encoder would no longer start in the
    // same turn as the subscription that asked for it.
    if (this.release !== undefined) await this.release;
    // Anything terminal that happened while this waited - shutdown, the last viewer leaving, the start
    // deadline expiring - means the start is no longer wanted, and whatever ran then found no source
    // to stop because this one did not exist yet. Creating it now would leave a worker with no
    // viewer, no grace timer and no deadline: nothing in the state machine could reach it again.
    if (this.phase !== 'starting' || this.viewers.size === 0) return;
    // Each encoder starts its own numbering; the next packet establishes how to continue the track's.
    this.origin = undefined;
    const source = this.options.create(this.options.binding);
    this.source = source;
    try {
      // Both callbacks are ignored once this source has been superseded. A stopped worker can still
      // have a packet in flight and can still report its own exit, and either one arriving late
      // would otherwise act on whatever replaced it: marking a starting stream active with a stale
      // frame, or failing an encoder that is perfectly healthy.
      await source.start(
        packet => { if (this.source === source) this.deliver(packet); },
        () => { if (this.source === source) void this.finish('failed'); });
    } catch {
      this.options.onError();
      await this.finish('failed');
    }
  }

  /**
   * Renumber one packet so the track is continuous across encoder restarts.
   *
   * The sender adds a constant offset to whatever it is given rather than renumbering, so a restarted
   * encoder - every resume after the grace window - arrives at the decoder as a fresh random sequence
   * and timestamp base on an unchanged SSRC. A browser treats that as a discontinuity it cannot
   * resynchronise and silently drops the stream. The bridge owns the track, so it owns the numbering:
   * sequence numbers simply continue, and timestamps keep their within-stream deltas while the new
   * stream is shifted to resume one frame after the last one ended.
   *
   * @param packet Complete RTP packet, rewritten in place as the sender also does.
   * @returns void
   */
  private renumber(packet: Buffer): void {
    const original = packet.readUInt32BE(4);
    if (this.origin === undefined) {
      this.origin = original;
      const step = Math.round(CLOCK_HZ / this.options.binding.input.framerate);
      this.shift = (this.emitted + step - original) >>> 0;
    }
    this.emitted = (original + this.shift) >>> 0;
    packet.writeUInt32BE(this.emitted, 4);
    packet.writeUInt16BE(this.sequence++ & 0xffff, 2);
  }

  /** Fan one RTP packet out to every viewer. Input: complete RTP packet; returns void. */
  private deliver(packet: Buffer): void {
    // Only the live source reaches here, and a live source is starting or active - `finish` drops
    // its reference before anything else can happen - so no terminal phase needs guarding against.
    // The first packet is the only evidence the encoder really produced output.
    if (this.phase === 'starting') {
      this.cancelStart?.();
      this.cancelStart = undefined;
      this.phase = 'active';
      this.notify();
    }
    this.packets++;
    this.renumber(packet);
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
    if (phase === 'failed') this.failedAt = this.options.clock();
    this.notify();
    // A failure ends every attachment it just reported. Leaving them would send a restart triggered
    // by somebody else to peers that are not watching, and hold the viewer count above zero so that
    // restart could never stop.
    if (phase === 'failed') this.viewers.clear();
    // Stop must not leave a child process behind even when it reports a failure. Guarded because a
    // second finish - a start deadline and a grace window can expire in the same turn - would
    // otherwise clear the release the first one is still waiting on.
    if (source === undefined) return;
    this.release = source.stop().catch(() => { this.options.onError(); });
    try { await this.release; } finally { this.release = undefined; }
  }

  /** Tell every viewer the current phase. No input; returns void. Notification callbacks must not throw. */
  private notify(): void {
    for (const viewer of this.viewers) viewer.state(this.phase);
  }
}
