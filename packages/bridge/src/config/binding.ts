import { boolean, choice, ConfigError, positive, record, string, topicName } from './validation.js';
import type { ConfigOptions, TopicBinding } from './types.js';

/** Normalize a binding. Inputs: public name, map, registry/remap. Example: /odom config returns a frozen TopicBinding. */
export function binding(name: string, value: unknown, options: ConfigOptions): TopicBinding {
  const path = `topics.${name}`;
  const map = record(value, ['ros_topic', 'ros_type', 'direction', 'ros_qos', 'delivery', 'max_rate_hz', 'queue', 'access', 'command_guard'], path);
  const publicName = topicName(name, path);
  const target = topicName(map.ros_topic === undefined ? name : map.ros_topic, `${path}.ros_topic`);
  // Store the remapped name so aliases share writer ownership.
  const rosTopic = topicName(options.resolveTopic ? options.resolveTopic(target) : target, `${path}.resolved_topic`);
  const rosType = string(map.ros_type, /^[A-Za-z][A-Za-z0-9_]*\/msg\/[A-Za-z][A-Za-z0-9_]*$/, `${path}.ros_type`);
  if (!options.availableTypes.includes(rosType)) throw new ConfigError(path, 'type unavailable');
  const direction = choice(map.direction, ['ros_to_web', 'web_to_ros'], `${path}.direction`);
  // Validate QoS and delivery independently. A reliable DataChannel may use DDS best_effort.
  const qos = record(map.ros_qos, ['reliability', 'durability', 'history', 'depth'], `${path}.ros_qos`);
  const reliability = choice(qos.reliability, ['reliable', 'best_effort'], `${path}.ros_qos.reliability`);
  const durability = choice(qos.durability, ['volatile', 'transient_local'], `${path}.ros_qos.durability`);
  const history = choice(qos.history, ['keep_last'], `${path}.ros_qos.history`);
  // Limit history capacity to finite positive integers.
  const depth = positive(qos.depth, `${path}.ros_qos.depth`, true);
  const delivery = choice(map.delivery, ['reliable', 'realtime'], `${path}.delivery`);
  const maxRateHz = positive(map.max_rate_hz, `${path}.max_rate_hz`, false);
  const queue = record(map.queue, ['policy', 'max_messages'], `${path}.queue`);
  // Do not retain stale realtime setpoints in FIFO order. The latest policy keeps exactly one value.
  const policy = choice(queue.policy, ['latest', 'fifo'], `${path}.queue.policy`);
  const maxMessages = positive(queue.max_messages, `${path}.queue.max_messages`, true);
  if ((delivery === 'reliable') !== (policy === 'fifo')) throw new ConfigError(path, 'delivery/queue conflict');
  if (policy === 'latest' && maxMessages !== 1) throw new ConfigError(path, 'latest requires one message');
  // Apply authorization settings only to Web-to-ROS bindings; omitted settings grant no permissions.
  const access = parseAccess(map.access, direction, path);
  const commandGuard = parseGuard(map.command_guard, direction, durability, access, path);
  return Object.freeze({ publicName, rosTopic, rosType, direction, delivery, maxRateHz,
    rosQos: Object.freeze({ reliability, durability, history, depth }),
    queue: Object.freeze({ policy, maxMessages }), access, commandGuard });
}

/** Validate publish permissions. Example: (undefined, ros_to_web, path) returns undefined; contradictions throw. */
function parseAccess(value: unknown, direction: TopicBinding['direction'], path: string): TopicBinding['access'] {
  if (value === undefined) return undefined;
  if (direction !== 'web_to_ros') throw new ConfigError(path, 'access requires web_to_ros');
  const access = record(value, ['publish_scope', 'exclusive_writer'], `${path}.access`);
  // Treat a scope string as an identifier checked against authentication policy, not as authority itself.
  return Object.freeze({ publishScope: string(access.publish_scope, /^[A-Za-z0-9_.:-]+$/, `${path}.access.publish_scope`),
    exclusiveWriter: boolean(access.exclusive_writer, `${path}.access.exclusive_writer`) });
}

/** Validate command requirements. An omitted guard on a nonexclusive binding returns undefined; exclusive writers require a guard. */
function parseGuard(value: unknown, direction: TopicBinding['direction'], durability: string,
  access: TopicBinding['access'], path: string): TopicBinding['commandGuard'] {
  // The guard manages exclusive ownership; do not accept an exclusive flag that would have no effect.
  if (value === undefined) {
    if (access?.exclusiveWriter) throw new ConfigError(path, 'exclusive writer requires command guard');
    return undefined;
  }
  const guard = record(value, ['required', 'lease_ms'], `${path}.command_guard`);
  if (guard.required !== true) throw new ConfigError(path, 'command guard must be required');
  // Do not infer command usage from type names. Accept only configurations satisfying the explicit guard requirements.
  if (direction !== 'web_to_ros' || durability !== 'volatile' || !access?.exclusiveWriter) {
    throw new ConfigError(path, 'command requires web_to_ros, volatile and exclusive writer');
  }
  return Object.freeze({ required: true, leaseMs: positive(guard.lease_ms, `${path}.command_guard.lease_ms`, true) });
}

/** Check consistency for bindings to the same ROS output. Input: bindings; no return value. Mixing guarded and unguarded aliases throws. */
export function checkOutputs(topics: readonly TopicBinding[]): void {
  const outputs = new Map<string, TopicBinding>();
  for (const topic of topics) {
    if (topic.direction !== 'web_to_ros') continue;
    const previous = outputs.get(topic.rosTopic);
    // Reject conflicting types, QoS, authorization, or guards for one output to prevent bypass through a weaker alias.
    if (previous && outputContract(previous) !== outputContract(topic)) {
      throw new ConfigError(`topics.${topic.publicName}`, 'conflicting ROS output binding');
    }
    outputs.set(topic.rosTopic, topic);
  }
}

/** Make output protection requirements comparable. Input: binding; output: JSON string. Equivalent aliases produce the same string. */
function outputContract(topic: TopicBinding): string {
  return JSON.stringify([topic.rosType, topic.rosQos, topic.access, topic.commandGuard, topic.maxRateHz, topic.delivery, topic.queue]);
}
