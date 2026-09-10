import { createCodec } from '../../../packages/bridge/src/codec/index.js';
import type { TopicBinding } from '../../../packages/bridge/src/config/types.js';
import type { RosDefinition, RosRegistration } from '../../../packages/bridge/src/ros/types.js';

/** 検証済みbinding相当を作る。入力: name,direction。出力: readonly契約のfixture。 */
export function binding(name: string, direction: TopicBinding['direction']): TopicBinding {
  return { publicName: name, rosTopic: name, rosType: 'std_msgs/msg/String', direction,
    rosQos: { reliability: 'reliable', durability: 'volatile', history: 'keep_last', depth: 2 },
    delivery: 'reliable', maxRateHz: 20, queue: { policy: 'fifo', maxMessages: 2 } };
}

/** string登録を作る。入力: name,direction。出力: {binding,codec}。 */
export function registration(name: string, direction: TopicBinding['direction']): RosRegistration {
  return { binding: binding(name, direction), codec: createCodec({ kind: 'object', fields: { data: { kind: 'string' } } }) };
}

/** introspectorのscalar fieldを作る。入力: 'data','string'。出力: ROS field metadata。 */
export function field(name: string, type: string, overrides: Partial<RosDefinition['fields'][number]['type']> = {}): RosDefinition['fields'][number] {
  return { name, type: { type, pkgName: null, isPrimitiveType: true, isArray: false,
    isFixedSizeArray: false, arraySize: null, isUpperBound: false, stringUpperBound: null, ...overrides } };
}
