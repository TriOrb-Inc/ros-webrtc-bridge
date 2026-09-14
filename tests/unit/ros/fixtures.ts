import { createCodec } from '../../../packages/bridge/src/codec/index.js';
import type { TopicBinding } from '../../../packages/bridge/src/config/types.js';
import type { RosDefinition, RosRegistration } from '../../../packages/bridge/src/ros/types.js';

/** Create the equivalent of a validated binding. Inputs: name,direction; output: a fixture with a readonly contract. */
export function binding(name: string, direction: TopicBinding['direction']): TopicBinding {
  return { publicName: name, rosTopic: name, rosType: 'std_msgs/msg/String', direction,
    rosQos: { reliability: 'reliable', durability: 'volatile', history: 'keep_last', depth: 2 },
    delivery: 'reliable', maxRateHz: 20, queue: { policy: 'fifo', maxMessages: 2 } };
}

/** Create a string registration. Inputs: name,direction; output: {binding,codec}. */
export function registration(name: string, direction: TopicBinding['direction']): RosRegistration {
  return { binding: binding(name, direction), codec: createCodec({ kind: 'object', fields: { data: { kind: 'string' } } }) };
}

/** Create an introspector scalar field. Inputs: 'data','string'; output: ROS field metadata. */
export function field(name: string, type: string, overrides: Partial<RosDefinition['fields'][number]['type']> = {}): RosDefinition['fields'][number] {
  return { name, type: { type, pkgName: null, isPrimitiveType: true, isArray: false,
    isFixedSizeArray: false, arraySize: null, isUpperBound: false, stringUpperBound: null, ...overrides } };
}
