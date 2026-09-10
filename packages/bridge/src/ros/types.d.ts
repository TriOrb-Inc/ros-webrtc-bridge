import type { Codec } from '../codec/index.js';
import type { RosQos, TopicBinding } from '../config/types.js';

/** 型検証済みbindingとcodec。schema IDはwire registryが管理する。 */
export interface RosRegistration {
  readonly binding: TopicBinding;
  readonly codec: Codec;
}

/** 共有ROS entityを所有するprocess側API。logical listenerだけをsessionへ貸す。 */
export interface RosAdapter {
  start(): void;
  subscribe(publicName: string, callback: (native: unknown) => void): () => void;
  publish(publicName: string, native: unknown): void;
  close(): void;
}

/** 外部native addonを注入する境界。factory完了時にcontext/nodeを初期化済みとする。 */
export interface RosBackend {
  createPublisher(type: string, topic: string, qos: RosQos): { publish(native: unknown): void };
  createSubscription(type: string, topic: string, qos: RosQos, callback: (native: unknown) => void): void;
  spin(): void;
  close(): void;
}

/** rclnodejs MessageIntrospectorの型情報。payloadやwire schemaと混同しない。 */
export interface RosDefinition {
  fields: Array<{ name: string; type: {
    type: string; pkgName: string | null; isPrimitiveType: boolean;
    isArray: boolean; isFixedSizeArray: boolean | null;
    arraySize: number | null; isUpperBound: boolean; stringUpperBound: number | null;
  } }>;
}

/** 実rclnodejsとunit facadeが共有する必要最小限のAPI。 */
export interface RclModule {
  Context: new () => { shutdown(): void };
  init(context: object, args: string[]): Promise<void>;
  Node: new (name: string, namespace: string, context: object) => RclNode;
  QoS: new (history: number, depth: number, reliability: number, durability: number) => unknown;
  MessageIntrospector: new (type: string) => { schema: RosDefinition };
}

/** DDS実体の操作は同期publish、非同期spinの開始、context単位終了に限定する。 */
export interface RclNode {
  createPublisher(type: string, topic: string, options: object): { readonly topic: string; publish(native: unknown): void };
  createSubscription(type: string, topic: string, options: object, callback: (native: unknown) => void): { readonly topic: string };
  resolveTopicName(name: string): string;
  spin(timeout: number): void;
}
