import { boolean, choice, ConfigError, positive, record, string, topicName } from './validation.js';
import type { ConfigOptions, TopicBinding } from './types.js';

/** bindingを正規化する。引数は公開名、map、registry/remap。例: /odom設定 → 凍結したTopicBinding。 */
export function binding(name: string, value: unknown, options: ConfigOptions): TopicBinding {
  const path = `topics.${name}`;
  const map = record(value, ['ros_topic', 'ros_type', 'direction', 'ros_qos', 'delivery', 'max_rate_hz', 'queue', 'access', 'command_guard'], path);
  const publicName = topicName(name, path);
  const target = topicName(map.ros_topic === undefined ? name : map.ros_topic, `${path}.ros_topic`);
  // remapを済ませた名前を保存し、alias違いでもwriterの所有権を共有させる。
  const rosTopic = topicName(options.resolveTopic ? options.resolveTopic(target) : target, `${path}.resolved_topic`);
  const rosType = string(map.ros_type, /^[A-Za-z][A-Za-z0-9_]*\/msg\/[A-Za-z][A-Za-z0-9_]*$/, `${path}.ros_type`);
  if (!options.availableTypes.includes(rosType)) throw new ConfigError(path, 'type unavailable');
  const direction = choice(map.direction, ['ros_to_web', 'web_to_ros'], `${path}.direction`);
  // QoSと配送を別々に検証する。reliable DCでもDDS best_effortは指定可能。
  const qos = record(map.ros_qos, ['reliability', 'durability', 'history', 'depth'], `${path}.ros_qos`);
  const reliability = choice(qos.reliability, ['reliable', 'best_effort'], `${path}.ros_qos.reliability`);
  const durability = choice(qos.durability, ['volatile', 'transient_local'], `${path}.ros_qos.durability`);
  const history = choice(qos.history, ['keep_last'], `${path}.ros_qos.history`);
  // history容量は有限の正整数に限定する。
  const depth = positive(qos.depth, `${path}.ros_qos.depth`, true);
  const delivery = choice(map.delivery, ['reliable', 'realtime'], `${path}.delivery`);
  const maxRateHz = positive(map.max_rate_hz, `${path}.max_rate_hz`, false);
  const queue = record(map.queue, ['policy', 'max_messages'], `${path}.queue`);
  // realtimeの古いsetpointをFIFOで保持しない。latestは1値だけ保存する契約。
  const policy = choice(queue.policy, ['latest', 'fifo'], `${path}.queue.policy`);
  const maxMessages = positive(queue.max_messages, `${path}.queue.max_messages`, true);
  if ((delivery === 'reliable') !== (policy === 'fifo')) throw new ConfigError(path, 'delivery/queue conflict');
  if (policy === 'latest' && maxMessages !== 1) throw new ConfigError(path, 'latest requires one message');
  // 認可ルールはWeb→ROSだけに適用し、未指定時は権限を生成しない。
  const access = parseAccess(map.access, direction, path);
  const commandGuard = parseGuard(map.command_guard, direction, durability, access, path);
  return Object.freeze({ publicName, rosTopic, rosType, direction, delivery, maxRateHz,
    rosQos: Object.freeze({ reliability, durability, history, depth }),
    queue: Object.freeze({ policy, maxMessages }), access, commandGuard });
}

/** publish権限設定を検証する。例: (undefined, ros_to_web, path) → undefined。矛盾は例外。 */
function parseAccess(value: unknown, direction: TopicBinding['direction'], path: string): TopicBinding['access'] {
  if (value === undefined) return undefined;
  if (direction !== 'web_to_ros') throw new ConfigError(path, 'access requires web_to_ros');
  const access = record(value, ['publish_scope', 'exclusive_writer'], `${path}.access`);
  // scope文字列自体を権限として信用せず、認証policyと照合するための識別子にする。
  return Object.freeze({ publishScope: string(access.publish_scope, /^[A-Za-z0-9_.:-]+$/, `${path}.access.publish_scope`),
    exclusiveWriter: boolean(access.exclusive_writer, `${path}.access.exclusive_writer`) });
}

/** command条件を検証する。例: guard省略かつ非排他 → undefined。排他writerのguard省略は例外。 */
function parseGuard(value: unknown, direction: TopicBinding['direction'], durability: string,
  access: TopicBinding['access'], path: string): TopicBinding['commandGuard'] {
  // 排他所有権はguardが管理するため、排他指定だけを受理して無効化しない。
  if (value === undefined) {
    if (access?.exclusiveWriter) throw new ConfigError(path, 'exclusive writer requires command guard');
    return undefined;
  }
  const guard = record(value, ['required', 'lease_ms'], `${path}.command_guard`);
  if (guard.required !== true) throw new ConfigError(path, 'command guard must be required');
  // 型名からcommand用途を推測しない。明示したguardが成立する構成だけを受理する。
  if (direction !== 'web_to_ros' || durability !== 'volatile' || !access?.exclusiveWriter) {
    throw new ConfigError(path, 'command requires web_to_ros, volatile and exclusive writer');
  }
  return Object.freeze({ required: true, leaseMs: positive(guard.lease_ms, `${path}.command_guard.lease_ms`, true) });
}

/** 同じROS出力の設定整合を確認する。入力binding配列、戻り値なし。例: guardあり/なしのalias混在 → 例外。 */
export function checkOutputs(topics: readonly TopicBinding[]): void {
  const outputs = new Map<string, TopicBinding>();
  for (const topic of topics) {
    if (topic.direction !== 'web_to_ros') continue;
    const previous = outputs.get(topic.rosTopic);
    // 同一出力の型・QoS・認可・guardが違う経路を拒否し、緩いaliasへの迂回を防ぐ。
    if (previous && outputContract(previous) !== outputContract(topic)) {
      throw new ConfigError(`topics.${topic.publicName}`, 'conflicting ROS output binding');
    }
    outputs.set(topic.rosTopic, topic);
  }
}

/** 出力の保護条件を比較可能にする。入力binding、出力JSON文字列。例: 同条件alias → 同一文字列。 */
function outputContract(topic: TopicBinding): string {
  return JSON.stringify([topic.rosType, topic.rosQos, topic.access, topic.commandGuard, topic.maxRateHz, topic.delivery, topic.queue]);
}
