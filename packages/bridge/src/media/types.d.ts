import type { VideoBinding, VideoSettings } from '../config/types.js';

/** Lifecycle of one configured source, as reported to subscribed clients. Never carries a cause. */
export type VideoState = 'starting' | 'active' | 'idle' | 'failed';

/**
 * One encoder implementation behind the platform-neutral seam. Everything specific to a backend -
 * GStreamer element names, device nodes, bitrate units - lives on the far side of this interface.
 */
export interface MediaSource {
  /**
   * Prove the backend can actually encode on this host, before any peer is accepted.
   * @returns Resolves when the backend produced output; rejects with an actionable local reason.
   */
  probe(): Promise<void>;
  /**
   * Begin producing RTP.
   * @param onPacket Receives each complete RTP packet, e.g. a 1200-byte FU-A fragment.
   * @param onFailed Called once if the encoder stops unexpectedly.
   */
  start(onPacket: (packet: Buffer) => void, onFailed: () => void): Promise<void>;
  /** Ask for an IDR, e.g. after RTCP PLI or when a viewer joins mid-stream. */
  requestKeyframe(): void;
  /** Release the encoder, ROS subscription and any child process. Safe to call repeatedly. */
  stop(): Promise<void>;
}

/** Build the encoder selected by a track's configuration. Missing backends fail here, never silently. */
export type MediaSourceFactory = (binding: VideoBinding) => MediaSource;

/**
 * Cancellable delay. Injected so lifecycle boundaries - the stop grace window, the start deadline -
 * can be tested at exact equality with a fake clock instead of by sleeping.
 */
export type Schedule = (callback: () => void, delayMs: number) => () => void;

/** One client watching a source. The source never learns which PeerConnection it belongs to. */
export interface Viewer {
  /** Deliver one complete RTP packet. */
  write(packet: Buffer): void;
  /** Report a lifecycle change. Must not throw. */
  state(state: VideoState): void;
}

/** Everything a VideoSource needs from outside, so the class itself owns no global state. */
export interface VideoSourceOptions {
  readonly binding: VideoBinding;
  readonly settings: Readonly<VideoSettings>;
  readonly create: MediaSourceFactory;
  readonly clock: () => number;
  readonly schedule: Schedule;
  readonly onError: () => void;
}

/** Per-source counters exposed through internal diagnostics. Carries no paths and no payloads. */
export interface VideoDiagnostics {
  readonly track: string;
  readonly backend: string;
  readonly state: VideoState;
  readonly viewers: number;
  readonly packets: number;
  readonly keyframeRequests: number;
}

/** One running worker process, reduced to what supervision needs. Injected so tests spawn nothing. */
export interface WorkerProcess {
  /** Write one NDJSON control line to the worker. */
  send(line: string): void;
  /** Receive the worker's NDJSON output as it arrives. */
  onOutput(callback: (chunk: Buffer) => void): void;
  /** Receive RFC 4571 framed RTP as it arrives. */
  onRtp(callback: (chunk: Buffer) => void): void;
  /** Called once when the process ends, for any reason. */
  onExit(callback: () => void): void;
  /** Ask the worker to shut down, then ensure the process is gone. */
  stop(shutdown: string): Promise<void>;
}

/** Spawns workers. The only place that knows how a worker is launched on this host. */
export interface WorkerPort {
  /**
   * Start one worker.
   * @param binding Track the worker will serve.
   * @param streaming True when RTP is expected, so the caller can attach the media descriptor.
   * @returns The running process.
   */
  spawn(binding: VideoBinding, streaming: boolean): WorkerProcess;
}
