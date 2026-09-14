import type { RosQos } from '../config/types.js';
import type { RclModule, RosBackend, RosDefinition } from './types.js';
import { descriptorFromRos } from './descriptor.js';
import { rosRepresentation } from './representation.js';
import type { CodecOptions } from '../codec/index.js';
export type { RclModule, RosDefinition } from './types.js';

/** Startup settings. Inject ROS arguments explicitly instead of implicitly using process-global values. */
export interface RclOptions {
  readonly nodeName: string;
  readonly namespace: string;
  readonly args: readonly string[];
  readonly spinTimeoutMs: number;
  readonly codecOptions?: Partial<CodecOptions>;
  readonly onError: (error: unknown) => void;
}

/** Initialize a dedicated ROS context. Inputs: rclnodejs,{nodeName:'bridge',...}; returns a backend. */
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
    /** Get the original name corresponding to a resolved name. Example: '/target' returns '/source'. */
    const original = (topic: string): string => {
      const name = originalNames.get(topic);
      if (name === undefined) throw new Error('ros_topic_not_resolved');
      return name;
    };
    /** Get type generator output. Input: 'std_msgs/msg/String'; returns ROSMessageDef. */
    const describe = (type: string): RosDefinition => new rcl.MessageIntrospector(type).schema;
    // Construct explicit DDS QoS rather than a default profile. Enum values follow the public RMW definitions.
    const qos = (value: RosQos): unknown => new rcl.QoS(1, value.depth, value.reliability === 'reliable' ? 1 : 2, value.durability === 'volatile' ? 2 : 1);
    return {
      /** Create a publisher. Inputs: type name, ROS name, QoS; returns a synchronous publisher. */
      createPublisher(type, topic, policy) {
        const representation = rosRepresentation(descriptorFromRos(type, describe), options.codecOptions);
        const publisher = node.createPublisher(type, original(topic), { qos: qos(policy), enableTypedArray: false });
        if (publisher.topic !== topic) throw new Error('ros_publisher_topic_mismatch');
        // Preserve the bigint representation required by generated message setters for scalar int64 values.
        return { publish(native) { publisher.publish(representation.to(native)); } };
      },
      /** Create a subscription. Inputs: type name, ROS name, QoS, callback; returns void. */
      createSubscription(type, topic, policy, callback) {
        // Use plain output to normalize numeric sequences to arrays; adapter normalization restores only uint8 to Uint8Array.
        const representation = rosRepresentation(descriptorFromRos(type, describe), options.codecOptions);
        const subscription = node.createSubscription(type, original(topic), { qos: qos(policy), enableTypedArray: false, serializationMode: 'default' }, (native) => {
          try { callback(representation.from(native)); } catch (error) { options.onError(error); }
        });
        if (subscription.topic !== topic) throw new Error('ros_subscription_topic_mismatch');
      },
      /** Start spinning. No input; returns void. Does not block the Node event loop. */
      spin() { node.spin(options.spinTimeoutMs); },
      /** Release all entities in the dedicated context. No input; returns void. */
      close() { originalNames.clear(); context.shutdown(); },
      /** Apply native remapping. Example: '/source' returns '/target'. */
      resolveTopic(name) {
        // Retain the original input: passing the resolved name into the same node could apply chained rules twice.
        const resolved = node.resolveTopicName(name);
        originalNames.set(resolved, name);
        return resolved;
      },
      /** Get a ROS type with generated bindings. Input: 'std_msgs/msg/String'; returns ROSMessageDef. */
      describe,
    };
  } catch (error) {
    // Clean up partial initialization or node-creation failures without affecting other contexts.
    try { context.shutdown(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'ros_init_cleanup_failed'); }
    throw error;
  }
}
