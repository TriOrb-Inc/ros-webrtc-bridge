/** 起動時のQoS。keep_allは有限容量の仕様が決まるまで対象外。 */
export interface RosQos {
  readonly reliability: 'reliable' | 'best_effort';
  readonly durability: 'volatile' | 'transient_local';
  readonly history: 'keep_last';
  readonly depth: number;
}

/** 公開名とROS接続先を分離した起動時binding。 */
export interface TopicBinding {
  readonly publicName: string;
  readonly rosTopic: string;
  readonly rosType: string;
  readonly direction: 'ros_to_web' | 'web_to_ros';
  // DDS QoSとDataChannel配送の選択は独立に保持する。
  readonly rosQos: Readonly<RosQos>;
  readonly delivery: 'reliable' | 'realtime';
  readonly maxRateHz: number;
  readonly queue: Readonly<{ policy: 'latest' | 'fifo'; maxMessages: number }>;
  // access未指定は認可付与ではない。認証・認可は呼出側でdefault denyとする。
  readonly access?: Readonly<{ publishScope: string; exclusiveWriter: boolean }>;
  readonly commandGuard?: Readonly<{ required: true; leaseMs: number }>;
}

/** 型registryの構築後に使う設定検証の入力。ROS graphのpublisher有無とは無関係。 */
export interface ConfigOptions {
  readonly availableTypes: readonly string[];
  readonly maxConfigBytes?: number;
  readonly maxTopics?: number;
  /** ROS adapterによるremap・正規化。例: /cmd_vel → /robot/cmd_vel。 */
  readonly resolveTopic?: (topic: string) => string;
}

/** 検証済み設定。limitsの単位はbytes、peersは同時peer数。 */
export interface BridgeConfig {
  readonly version: 1;
  readonly robotId: string;
  readonly topics: readonly TopicBinding[];
  readonly limits: Readonly<{
    maxPeers: number; maxMessageBytes: number;
    maxPeerQueueBytes: number; maxChannelBufferedBytes: number;
  }>;
}
