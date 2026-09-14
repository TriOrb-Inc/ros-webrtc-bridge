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
