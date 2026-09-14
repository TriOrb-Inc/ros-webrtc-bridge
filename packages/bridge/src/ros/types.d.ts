import type { Codec } from '../codec/index.js';
import type { RosQos, TopicBinding } from '../config/types.js';

/** Type-validated binding and codec. The wire registry manages schema IDs. */
export interface RosRegistration {
  readonly binding: TopicBinding;
  readonly codec: Codec;
}

/** Process API owning shared ROS entities. Sessions borrow only logical listeners. */
export interface RosAdapter {
  start(): void;
  subscribe(publicName: string, callback: (native: unknown) => void): () => void;
  publish(publicName: string, native: unknown): void;
  close(): void;
}

/** Injection boundary for the external native addon. The factory initializes the context and node before returning. */
export interface RosBackend {
  createPublisher(type: string, topic: string, qos: RosQos): { publish(native: unknown): void };
  createSubscription(type: string, topic: string, qos: RosQos, callback: (native: unknown) => void): void;
  spin(): void;
  close(): void;
}

/** Type metadata from rclnodejs MessageIntrospector; distinct from payloads and wire schemas. */
export interface RosDefinition {
  fields: Array<{ name: string; type: {
    type: string; pkgName: string | null; isPrimitiveType: boolean;
    isArray: boolean; isFixedSizeArray: boolean | null;
    arraySize: number | null; isUpperBound: boolean; stringUpperBound: number | null;
  } }>;
}

/** Minimal API shared by real rclnodejs and the unit-test facade. */
export interface RclModule {
  Context: new () => { shutdown(): void };
  init(context: object, args: string[]): Promise<void>;
  Node: new (name: string, namespace: string, context: object) => RclNode;
  QoS: new (history: number, depth: number, reliability: number, durability: number) => unknown;
  MessageIntrospector: new (type: string) => { schema: RosDefinition };
}

/** DDS operations are limited to synchronous publishing, starting asynchronous spinning, and context-level shutdown. */
export interface RclNode {
  createPublisher(type: string, topic: string, options: object): { readonly topic: string; publish(native: unknown): void };
  createSubscription(type: string, topic: string, options: object, callback: (native: unknown) => void): { readonly topic: string };
  resolveTopicName(name: string): string;
  spin(timeout: number): void;
}
