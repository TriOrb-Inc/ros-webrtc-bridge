import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { ConfigError, parseBridgeConfig } from '../../../packages/bridge/src/config/index.js';

const source = readFileSync('examples/bridge.yaml', 'utf8');
const options = { availableTypes: ['nav_msgs/msg/Odometry', 'geometry_msgs/msg/Twist'] };

/** 独立fixtureを変更して検証する。入力は変更関数、出力設定。例: version=2 → ConfigError。 */
function changed(edit: (value: any) => void) {
  const value = parse(source);
  edit(value);
  return parseBridgeConfig(stringify(value), options);
}

test('CFG-01/02 公開fixtureの設定を全項目正規化し凍結する', () => {
  const config = parseBridgeConfig(source, options);
  assert.equal(config.version, 1);
  assert.equal(config.robotId, 'robot-01');
  assert.deepEqual(config.limits, { maxPeers: 4, maxMessageBytes: 16384, maxPeerQueueBytes: 262144, maxChannelBufferedBytes: 65536 });
  // 期待値はschema側の変換処理を共有せず記述する。
  assert.deepEqual(config.topics[1], { publicName: '/cmd_vel', rosTopic: '/cmd_vel', rosType: 'geometry_msgs/msg/Twist',
    direction: 'web_to_ros', delivery: 'realtime', maxRateHz: 30,
    rosQos: { reliability: 'reliable', durability: 'volatile', history: 'keep_last', depth: 1 },
    queue: { policy: 'latest', maxMessages: 1 }, access: { publishScope: 'teleop', exclusiveWriter: true }, commandGuard: { required: true, leaseMs: 250 } });
  // 返却後の書換えによって保護条件を変えられないことを確認する。
  for (const value of [config, config.limits, config.topics, config.topics[1], config.topics[1].rosQos,
    config.topics[1].queue, config.topics[1].access, config.topics[1].commandGuard]) {
    assert.equal(Object.isFrozen(value), true);
  }
});

test('CFG-02 公開aliasを維持し、省略/明示のROS名へremapを適用する', () => {
  const document = source.replace('/cmd_vel:', '/operator/velocity:\n    ros_topic: /cmd_vel');
  const config = parseBridgeConfig(document, { ...options, resolveTopic: name => `/robot${name}` });
  assert.equal(config.topics[0].rosTopic, '/robot/odom');
  assert.equal(config.topics[1].rosTopic, '/robot/cmd_vel');
  // Web名はremapによって変わらない。
  assert.equal(config.topics[1].publicName, '/operator/velocity');
  assert.throws(() => parseBridgeConfig(source, { ...options, resolveTopic: () => 'relative' }), ConfigError);
});

test('CFG-01 YAML構文、重複、alias、独自tag、複数文書を拒否する', () => {
  for (const value of ['[', 'version: 1\nversion: 1', 'a: &a {}\nb: *a', 'a: !custom value', '---\na: 1\n---\nb: 2']) {
    assert.throws(() => parseBridgeConfig(value, options), /invalid YAML/);
  }
  // scalar/null/sequenceをmapとして扱わない。
  for (const value of ['', 'null', '3', '[]']) assert.throws(() => parseBridgeConfig(value, options), /object required/);
});

test('CFG-01 設定のbyte上限とTopic数上限を境界で判定する', () => {
  const bytes = Buffer.byteLength(source);
  assert.equal(parseBridgeConfig(source, { ...options, maxConfigBytes: bytes, maxTopics: 2 }).topics.length, 2);
  assert.throws(() => parseBridgeConfig(source, { ...options, maxConfigBytes: bytes - 1 }), /document size/);
  assert.throws(() => parseBridgeConfig(12 as unknown as string, options), /document size/);
  // 容量の上書き値自身も検証対象にする。
  assert.throws(() => parseBridgeConfig(source, { ...options, maxTopics: 1 }), /topic count/);
  assert.throws(() => parseBridgeConfig(source, { ...options, maxTopics: 0 }), ConfigError);
  assert.throws(() => parseBridgeConfig(source, { ...options, maxConfigBytes: -1 }), ConfigError);
  assert.throws(() => changed(v => { v.topics = {}; }), /topic count/);
});

test('CFG-01 不明field・必須field・名前・型・方向を厳格に検証する', () => {
  const edits: ((v: any) => void)[] = [
    v => { v.unexpected = true; }, v => { v.version = 2; }, v => { v.robot_id = 7; },
    v => { v.robot_id = ''; }, v => { v.topics = null; }, v => { v.topics = []; },
    v => { v.topics.bad = v.topics['/odom']; }, v => { v.topics['/odom'].ros_topic = null; },
    v => { v.topics['/odom'].ros_topic = '/bad//name'; }, v => { v.topics['/odom'].ros_type = 'Odometry'; },
    // 不明型はROS graphの接続待ちとは区別して起動時に拒否する。
    v => { v.topics['/odom'].ros_type = 'other/msg/Unknown'; }, v => { v.topics['/odom'].direction = 'both'; },
    v => { v.topics['/odom'].direction = true; }, v => { delete v.topics['/odom'].ros_qos; },
    v => { v.topics['/odom'].queue.extra = 1; }, v => { v.topics['/odom'].ros_qos.history = 'keep_all'; },
  ];
  for (const edit of edits) assert.throws(() => changed(edit), ConfigError);
});

test('CFG-01 末尾改行を名前や型・scopeの一部として受理しない', () => {
  for (const suffix of ['\n', '\r', '\u2028', '\u2029']) {
    assert.throws(() => changed(v => { v.robot_id += suffix; }), ConfigError);
    assert.throws(() => changed(v => { v.topics['/odom'].ros_topic = `/odom${suffix}`; }), ConfigError);
    // JS regexの末尾anchorが最終改行直前へ一致しても、文字列全体の一致を必須とする。
    assert.throws(() => changed(v => { v.topics['/odom'].ros_type += suffix; }), ConfigError);
    assert.throws(() => changed(v => { v.topics['/cmd_vel'].access.publish_scope += suffix; }), ConfigError);
  }
});

test('CFG-01 ROS完全名の長さ上限をremap前後で検証する', () => {
  const name = `/${'a'.repeat(246)}`;
  assert.equal(changed(v => { v.topics['/odom'].ros_topic = name; }).topics[0].rosTopic, name);
  assert.throws(() => changed(v => { v.topics['/odom'].ros_topic = `${name}a`; }), /too long/);
  assert.throws(() => parseBridgeConfig(source, { ...options, resolveTopic: () => `${name}a` }), /too long/);
});

test('CFG-01 数値上限を検証し、QoSとDataChannel配送は独立に設定する', () => {
  for (const value of [0, -1, Infinity, NaN, '1', 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => changed(v => { v.limits.max_peers = value; }), ConfigError);
  }
  for (const [key, value] of [['max_message_bytes', 16385], ['max_peer_queue_bytes', 100], ['max_channel_buffered_bytes', 100]]) {
    assert.throws(() => changed(v => { v.limits[key] = value; }), /inconsistent/);
  }
  // reliable配送がDDS reliabilityを上書きしないことを確認する。
  const config = changed(v => {
    v.topics['/odom'].delivery = 'reliable';
    v.topics['/odom'].queue = { policy: 'fifo', max_messages: 2 };
    v.topics['/odom'].max_rate_hz = 0.5;
    v.topics['/odom'].ros_qos.durability = 'transient_local';
  });
  assert.equal(config.topics[0].rosQos.reliability, 'best_effort');
  assert.equal(config.topics[0].maxRateHz, 0.5);
  assert.equal(config.topics[0].queue.maxMessages, 2);
});

test('CFG-01 配送queueとcommand保護の矛盾を拒否する', () => {
  const edits: ((v: any) => void)[] = [
    v => { v.topics['/odom'].delivery = 'reliable'; }, v => { v.topics['/odom'].queue.max_messages = 2; },
    v => { v.topics['/odom'].queue.policy = 'fifo'; }, v => { v.topics['/cmd_vel'].command_guard.required = false; },
    v => { v.topics['/cmd_vel'].ros_qos.durability = 'transient_local'; },
    // guardを指定しても方向・排他条件が欠ければ許可しない。
    v => { delete v.topics['/cmd_vel'].access; }, v => { v.topics['/cmd_vel'].access.exclusive_writer = false; },
    v => { v.topics['/cmd_vel'].access.exclusive_writer = 'true'; },
    v => { v.topics['/odom'].access = { publish_scope: 'read', exclusive_writer: false }; },
    v => { v.topics['/odom'].command_guard = { required: true, lease_ms: 250 }; },
  ];
  for (const edit of edits) assert.throws(() => changed(edit), ConfigError);
});

test('CFG-01/CMD-03 排他writerはguard必須、非排他writerはguardなしを許可する', () => {
  assert.throws(() => changed(v => { delete v.topics['/cmd_vel'].command_guard; }), /exclusive writer requires command guard/);
  // 複数writerを使う一般Topicは排他指定を解除し、guardを省略する。
  const config = changed(v => {
    v.topics['/cmd_vel'].access.exclusive_writer = false;
    delete v.topics['/cmd_vel'].command_guard;
  });
  assert.equal(config.topics[1].access?.exclusiveWriter, false);
  assert.equal(config.topics[1].commandGuard, undefined);
});

test('CFG-01/CMD-03 同じ出力へ向かうaliasの保護条件を比較する', () => {
  const value = parse(source);
  value.topics['/operator/velocity'] = { ...structuredClone(value.topics['/cmd_vel']), ros_topic: '/cmd_vel' };
  assert.equal(parseBridgeConfig(stringify(value), options).topics.length, 3);
  // 異なる公開名からguardなしで同じROS出力へ迂回できない。
  delete value.topics['/operator/velocity'].command_guard;
  value.topics['/operator/velocity'].access.exclusive_writer = false;
  assert.throws(() => parseBridgeConfig(stringify(value), options), /conflicting ROS output/);
  delete value.topics['/operator/velocity'];
  value.topics['/other'] = { ...structuredClone(value.topics['/cmd_vel']), ros_topic: '/other' };
  // 同じ型でもremap結果が一致した後に衝突を検出する。
  value.topics['/other'].access.publish_scope = 'different';
  assert.throws(() => parseBridgeConfig(stringify(value), { ...options, resolveTopic: () => '/shared' }), /conflicting ROS output/);
});
