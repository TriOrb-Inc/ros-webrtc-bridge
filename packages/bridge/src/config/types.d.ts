/** Startup QoS. keep_all is unsupported until a bounded-capacity contract is defined. */
export interface RosQos {
  readonly reliability: 'reliable' | 'best_effort';
  readonly durability: 'volatile' | 'transient_local';
  readonly history: 'keep_last';
  readonly depth: number;
}

/** Startup binding that separates the public name from the ROS destination. */
export interface TopicBinding {
  readonly publicName: string;
  readonly rosTopic: string;
  readonly rosType: string;
  readonly direction: 'ros_to_web' | 'web_to_ros';
  // Keep DDS QoS and DataChannel delivery choices independent.
  readonly rosQos: Readonly<RosQos>;
  readonly delivery: 'reliable' | 'realtime';
  readonly maxRateHz: number;
  readonly queue: Readonly<{ policy: 'latest' | 'fifo'; maxMessages: number }>;
  // Omitted access settings grant no authorization. The caller must deny authentication and authorization by default.
  readonly access?: Readonly<{ publishScope: string; exclusiveWriter: boolean }>;
  readonly commandGuard?: Readonly<{ required: true; leaseMs: number }>;
}

/** Raw image contract a video source must deliver. Mismatched frames are rejected, never rescaled. */
export interface VideoInput {
  readonly encoding: 'rgb8' | 'bgr8' | 'mono8';
  readonly width: number;
  readonly height: number;
  readonly framerate: number;
}

/** Encoder selection. The backend is always explicit: there is no `auto` value and no fallback. */
export interface VideoEncoder {
  readonly codec: 'h264';
  readonly backend: 'fixture' | 'l4t_v4l2' | 'openh264';
  /** Target rate in bits per second. Each backend converts to the unit its element expects. */
  readonly bitrate: number;
  readonly keyframeInterval: number;
  readonly profile: 'constrained_baseline' | 'main' | 'high';
}

/** One configured video source. Kept apart from TopicBinding: raw frames never enter the JSON path. */
export interface VideoBinding {
  readonly name: string;
  readonly rosTopic: string;
  readonly rosType: string;
  readonly rosQos: Readonly<RosQos>;
  readonly input: Readonly<VideoInput>;
  readonly encoder: Readonly<VideoEncoder>;
  readonly access: Readonly<{ subscribeScope: string }>;
}

/** Timings shared by every video source. All are overridable so deployments can tune them. */
export interface VideoSettings {
  readonly startTimeoutMs: number;
  readonly stopGraceMs: number;
  readonly pliMinIntervalMs: number;
}

/** Capacity bounds for the media plane, validated alongside the DataChannel limits. */
export interface VideoLimits {
  readonly maxTracks: number;
  readonly maxPipelines: number;
  readonly maxSlotsPerPeer: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly maxFramerate: number;
}

/** Configuration validation inputs used after building the type registry; independent of ROS graph publisher presence. */
export interface ConfigOptions {
  readonly availableTypes: readonly string[];
  readonly maxConfigBytes?: number;
  readonly maxTopics?: number;
  /** ROS adapter remapping and normalization. Example: /cmd_vel becomes /robot/cmd_vel. */
  readonly resolveTopic?: (topic: string) => string;
}

/** Validated configuration. Limits are in bytes; peers counts simultaneous peers. */
export interface BridgeConfig {
  readonly version: 1;
  readonly robotId: string;
  readonly topics: readonly TopicBinding[];
  readonly limits: Readonly<{
    maxPeers: number; maxMessageBytes: number;
    maxPeerQueueBytes: number; maxChannelBufferedBytes: number;
  }>;
}

/**
 * Validated media plane, parsed separately from BridgeConfig so raw video never enters the
 * DataChannel contract. Undefined when the deployment serves no video.
 */
export interface VideoConfig {
  readonly settings: Readonly<VideoSettings>;
  readonly limits: Readonly<VideoLimits>;
  readonly tracks: readonly VideoBinding[];
}
