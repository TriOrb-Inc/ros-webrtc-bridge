import type { RosQos } from '../config/types.js';
import type { RclModule, RosBackend, RosDefinition } from './types.js';
import { descriptorFromRos } from './descriptor.js';
import { rosRepresentation } from './representation.js';
import type { CodecOptions } from '../codec/index.js';
export type { RclModule, RosDefinition } from './types.js';

/** 起動設定。ROS引数はprocess-global値を暗黙に取り込まず明示注入する。 */
export interface RclOptions {
  readonly nodeName: string;
  readonly namespace: string;
  readonly args: readonly string[];
  readonly spinTimeoutMs: number;
  readonly codecOptions?: Partial<CodecOptions>;
  readonly onError: (error: unknown) => void;
}

/** 専用ROS contextを初期化する。入力: rclnodejs,{nodeName:'bridge',...}。出力: backend。 */
export async function createRclnodejsBackend(rcl: RclModule, options: RclOptions): Promise<RosBackend & {
  resolveTopic(name: string): string;
  describe(type: string): RosDefinition;
}> {
  if (!Number.isSafeInteger(options.spinTimeoutMs) || options.spinTimeoutMs <= 0) throw new TypeError('invalid_spin_timeout');
  const context = new rcl.Context();
  try {
    await rcl.init(context, [...options.args]);
    const node = new rcl.Node(options.nodeName, options.namespace, context);
    const originalNames = new Map<string, string>();
    /** 解決済名に対応する元の名前を取得。入力: '/target'。出力: '/source'。 */
    const original = (topic: string): string => {
      const name = originalNames.get(topic);
      if (name === undefined) throw new Error('ros_topic_not_resolved');
      return name;
    };
    /** 型生成器の結果を取得。入力: 'std_msgs/msg/String'。出力: ROSMessageDef。 */
    const describe = (type: string): RosDefinition => new rcl.MessageIntrospector(type).schema;
    // default profileではなく明示したDDS QoSを構築する。enum値はRMWの公開定義。
    const qos = (value: RosQos): unknown => new rcl.QoS(1, value.depth, value.reliability === 'reliable' ? 1 : 2, value.durability === 'volatile' ? 2 : 1);
    return {
      /** publisher生成。入力: 型名,ROS名,QoS。出力: 同期publisher。 */
      createPublisher(type, topic, policy) {
        const representation = rosRepresentation(descriptorFromRos(type, describe), options.codecOptions);
        const publisher = node.createPublisher(type, original(topic), { qos: qos(policy), enableTypedArray: false });
        if (publisher.topic !== topic) throw new Error('ros_publisher_topic_mismatch');
        // scalar int64はref-napiが受け付けるdecimal stringへ変換する。
        return { publish(native) { publisher.publish(representation.to(native)); } };
      },
      /** subscription生成。入力: 型名,ROS名,QoS,callback。出力: void。 */
      createSubscription(type, topic, policy, callback) {
        // plainで数値配列を通常arrayに統一する。uint8だけはadapter正規化でUint8Arrayに戻す。
        const representation = rosRepresentation(descriptorFromRos(type, describe), options.codecOptions);
        const subscription = node.createSubscription(type, original(topic), { qos: qos(policy), enableTypedArray: false, serializationMode: 'default' }, (native) => {
          try { callback(representation.from(native)); } catch (error) { options.onError(error); }
        });
        if (subscription.topic !== topic) throw new Error('ros_subscription_topic_mismatch');
      },
      /** spin開始。入力: なし。出力: void。Nodeのevent loopをblockしない。 */
      spin() { node.spin(options.spinTimeoutMs); },
      /** 専用contextの全entityを解放。入力: なし。出力: void。 */
      close() { originalNames.clear(); context.shutdown(); },
      /** native remap適用。入力: '/source'。出力例: '/target'。 */
      resolveTopic(name) {
        // resolved名を同じnodeへ再投入すると連鎖ruleが二度適用されるため、元の入力も保持する。
        const resolved = node.resolveTopicName(name);
        originalNames.set(resolved, name);
        return resolved;
      },
      /** binding生成済みROS型を取得。入力: 'std_msgs/msg/String'。出力: ROSMessageDef。 */
      describe,
    };
  } catch (error) {
    // init/node作成の部分失敗でも、他のcontextへ影響させず終了する。
    try { context.shutdown(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'ros_init_cleanup_failed'); }
    throw error;
  }
}
