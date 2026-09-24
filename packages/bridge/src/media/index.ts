import { VideoSource } from './source.js';
import type { VideoBinding, VideoConfig } from '../config/types.js';
import type { MediaSourceFactory, Schedule, VideoDiagnostics, Viewer } from './types.js';
export { createFixtureFactory } from './fixture.js';
export { createWorkerFactory } from './worker.js';
export type { MediaSource, MediaSourceFactory, Schedule, VideoState, Viewer, WorkerPort, WorkerProcess } from './types.js';

/**
 * Cancellable delay backed by real timers.
 * @param callback Runs once when the delay elapses, e.g. stopping an unwatched encoder.
 * @param delayMs Delay in milliseconds, e.g. 5000 for a stop grace window.
 * @returns Canceller; calling it prevents the callback from running.
 */
export const timerSchedule: Schedule = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => { clearTimeout(timer); };
};

/** Everything the media plane needs from outside. Backends are injected, never discovered. */
export interface MediaOptions {
  readonly config: VideoConfig;
  /** One factory per backend id in use. A missing entry fails the probe rather than falling back. */
  readonly backends: Readonly<Record<string, MediaSourceFactory>>;
  readonly clock: () => number;
  readonly schedule: Schedule;
  readonly onError: () => void;
}

/**
 * The media plane: configured video sources, their viewers, and the probe that runs before any peer
 * is accepted. It owns no transport and no ROS state, so raw video never touches the JSON path.
 */
export class MediaService {
  private readonly sources = new Map<string, VideoSource>();
  private readonly options: MediaOptions;
  private closed = false;

  /** Create one source per configured track. Input: MediaOptions; returns a service. Backends stay idle. */
  constructor(options: MediaOptions) {
    this.options = options;
    for (const binding of options.config.tracks) {
      this.sources.set(binding.name, new VideoSource({
        binding, settings: options.config.settings, create: this.factory(binding),
        clock: options.clock, schedule: options.schedule, onError: options.onError,
      }));
    }
  }

  /** Video sections one peer may negotiate. No input; returns the configured slot limit. */
  get maxSlots(): number { return this.options.config.limits.maxSlotsPerPeer; }

  /** List tracks a client is allowed to see. Input: scope predicate; returns catalog entries. */
  catalog(allowed: (binding: VideoBinding) => boolean): { track: string; codec: string }[] {
    // Backend, ROS topic and bitrate stay private: they describe the host, not the offered stream.
    return this.options.config.tracks.filter(allowed).map(binding => ({ track: binding.name, codec: binding.encoder.codec }));
  }

  /** Report per-source counters for internal diagnostics. No input; returns a snapshot. */
  get diagnostics(): VideoDiagnostics[] {
    return [...this.sources.values()].map(source => source.diagnostics);
  }

  /**
   * Verify every configured backend before the listener opens.
   * @returns Resolves when all tracks encoded successfully; rejects with the first actionable reason.
   */
  async probe(): Promise<void> {
    for (const [name, source] of this.sources) {
      // Report the configuration path, track and backend so the operator can act without reading code.
      const backend = this.options.config.tracks.find(track => track.name === name)!.encoder.backend;
      await source.probe().catch((error: unknown) => {
        throw new Error(`video_tracks.${name}.encoder.backend: ${backend} unavailable: ${error instanceof Error ? error.message : 'probe failed'}`);
      });
    }
  }

  /**
   * Attach a viewer to a source, starting the encoder if it is the first.
   * @param track Configured track name, e.g. `front`.
   * @param viewer Sink for RTP and lifecycle notifications.
   * @returns void. An unknown track is rejected rather than created on demand.
   */
  attach(track: string, viewer: Viewer): void {
    const source = this.source(track);
    // `max_pipelines` bounds how many encoders may run at once, which is what protects the GPU and
    // the host. Subscriptions to different tracks arrive independently, so the bound has to be
    // applied here; refusing is the documented behaviour, because quietly exceeding a configured
    // resource limit is worse than a peer being told it cannot watch a third stream right now.
    if (!source.running && this.running() >= this.options.config.limits.maxPipelines) throw new Error('video_pipeline_limit');
    // Refuse before taking the viewer on, so a peer inside the retry window holds no state and its
    // next request is a fresh one rather than an idempotent no-op against a track it never got.
    if (!source.retryable) throw new Error('video_retry_too_soon');
    source.add(viewer);
  }

  /** Count the encoders currently running. No input; returns the number of non-idle sources. */
  private running(): number {
    return [...this.sources.values()].filter(source => source.running).length;
  }

  /** Detach a viewer. Inputs: track name and viewer; returns void. The encoder stops after the grace window. */
  detach(track: string, viewer: Viewer): void {
    this.source(track).remove(viewer);
  }

  /** Ask a source for an IDR. Input: track name; returns void. Repeated requests are rate limited. */
  requestKeyframe(track: string): void {
    this.source(track).requestKeyframe();
  }

  /** Release every source. No input; returns a completion Promise. Safe to call repeatedly. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.sources.values()].map(source => source.close()));
  }

  /** Resolve a configured source. Input: track name; returns the source. Unknown names throw. */
  private source(track: string): VideoSource {
    const source = this.sources.get(track);
    if (source === undefined || this.closed) throw new Error('unknown_video_track');
    return source;
  }

  /** Resolve the factory for a binding's backend. Input: binding; returns a factory that fails on probe. */
  private factory(binding: VideoBinding): MediaSourceFactory {
    const backend = this.options.backends[binding.encoder.backend];
    // A backend the build does not provide must fail loudly at probe time, with the same message
    // shape as a missing GStreamer element - never by quietly selecting a different encoder.
    return backend ?? (() => ({
      async probe() { throw new Error('backend is not available in this build'); },
      async start() { throw new Error('backend is not available in this build'); },
      requestKeyframe() {},
      async stop() {},
    }));
  }
}
