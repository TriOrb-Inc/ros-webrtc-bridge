import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import rclnodejs from 'rclnodejs';
import { createCodec } from '../../packages/bridge/src/codec/index.js';
import type { TopicBinding } from '../../packages/bridge/src/config/types.js';
import { TopicRosAdapter } from '../../packages/bridge/src/ros/adapter.js';
import { descriptorFromRos } from '../../packages/bridge/src/ros/descriptor.js';
import { createRclnodejsBackend, type RclModule } from '../../packages/bridge/src/ros/rclnodejs.js';

/** 短いpoll区間で独立対向nodeの応答を待つ。入力: 操作,完了条件,deadline。出力: Promise<void>。 */
async function exchange(send: () => void, done: () => boolean, deadlineMs: number): Promise<void> {
  const deadline = performance.now() + deadlineMs;
  let nextReport = performance.now();
  while (!done()) {
    if (performance.now() >= deadline) throw new Error('independent_ros_response_timeout');
    send();
    // DDS discoveryを固定sleepで成功扱いせず、応答を観測できるまで有界に再試行する。
    if (performance.now() >= nextReport) { console.log('waiting for independent ROS response'); nextReport += 4000; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('実ROS TYPE-01/CFG-02: 連鎖remapを一度だけ適用して独立rclpyと交換する', { timeout: 45000 }, async () => {
  console.log(`native ROS test: distro=${process.env.ROS_DISTRO}, arch=${process.arch}, node=${process.version}`);
  const peer = spawn('python3', ['/bridge/tests/ros/peer.py'], { stdio: 'inherit', env: { ...process.env, ROS_TEST_TIMEOUT_SECONDS: '40' } });
  let adapter: TopicRosAdapter | undefined;
  const errors: unknown[] = [];
  try {
  const backend = await createRclnodejsBackend(rclnodejs as unknown as RclModule, {
    nodeName: 'bridge_native_test', namespace: '/', spinTimeoutMs: 5,
    args: ['--ros-args', '-r', '/bridge_test/input_alias:=/bridge_test/in', '-r', '/bridge_test/in:=/bridge_test/wrong_input',
      '-r', '/bridge_test/output_alias:=/bridge_test/out', '-r', '/bridge_test/out:=/bridge_test/wrong_output'], onError: (error) => errors.push(error),
  });
  // public名を保ちながらnative remap結果を出力Topicへ適用する。
  assert.equal(backend.resolveTopic('/bridge_test/input_alias'), '/bridge_test/in');
  const bindings: TopicBinding[] = [
    { publicName: '/input', rosTopic: '/bridge_test/input_alias', rosType: 'std_msgs/msg/String', direction: 'web_to_ros' },
    { publicName: '/output', rosTopic: '/bridge_test/output_alias', rosType: 'std_msgs/msg/String', direction: 'ros_to_web' },
    { publicName: '/command', rosTopic: '/bridge_test/cmd_vel', rosType: 'geometry_msgs/msg/Twist', direction: 'web_to_ros' },
    { publicName: '/observed', rosTopic: '/bridge_test/observed', rosType: 'std_msgs/msg/String', direction: 'ros_to_web' },
    { publicName: '/custom_in', rosTopic: '/bridge_test/custom_in', rosType: 'bridge_test_interfaces/msg/BridgeFrame', direction: 'web_to_ros' },
    { publicName: '/custom_out', rosTopic: '/bridge_test/custom_out', rosType: 'bridge_test_interfaces/msg/BridgeFrame', direction: 'ros_to_web' },
  ].map((item) => ({ ...item, rosTopic: backend.resolveTopic(item.rosTopic), rosQos: { history: 'keep_last', depth: 10, reliability: 'reliable', durability: 'volatile' },
    delivery: 'reliable', maxRateHz: 20, queue: { policy: 'fifo', maxMessages: 10 } })) as TopicBinding[];
  const registry = bindings.map((binding) => ({ binding, codec: createCodec(descriptorFromRos(binding.rosType, backend.describe), { allowNonFinite: false }) }));
  assert.equal(bindings[0]!.rosTopic, '/bridge_test/in');
  assert.equal(bindings[1]!.rosTopic, '/bridge_test/out');
  adapter = new TopicRosAdapter(registry, backend, (error) => errors.push(error));
    adapter.start();
    let echoed: unknown;
    let observed: unknown;
    let customEchoed: unknown;
    adapter.subscribe('/output', (value) => { echoed = value; });
    adapter.subscribe('/observed', (value) => { observed = JSON.parse((value as { data: string }).data); });
    adapter.subscribe('/custom_out', (value) => { customEchoed = value; });
    // 固有markerと完全Twistを独立rclpy側の受信結果から検証する。
    const marker = { data: `独立ROS-${process.pid}` };
    await exchange(() => adapter!.publish('/input', marker), () => echoed !== undefined, 15000);
    assert.deepEqual(echoed, marker);
    const command = { linear: { x: 0.125, y: -0.5, z: 0 }, angular: { x: 0, y: 0, z: -0.25 } };
    await exchange(() => adapter!.publish('/command', command), () => observed !== undefined, 15000);
    assert.deepEqual(observed, command);
    const custom = { meta: { source: 'native-test', stamp: { sec: -1, nanosec: 999999999 } },
      signed_value: -9223372036854775808n, unsigned_value: 18446744073709551615n,
      payload: new Uint8Array([0, 127, 128, 255]), samples: [0.25, -0.5, 1.5] };
    await exchange(() => adapter!.publish('/custom_in', custom), () => customEchoed !== undefined, 15000);
    assert.deepEqual(customEchoed, custom);
    assert.deepEqual(errors, []);
    console.log('native String, Twist, and external BridgeFrame bidirectional validation passed');
  } finally {
    try { adapter?.close(); } finally {
    peer.kill('SIGTERM');
    // 対向processの待機も有限にし、終了しない場合は明示的に強制終了する。
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => { peer.kill('SIGKILL'); resolve(null); }, 2000);
      peer.once('exit', (value) => { clearTimeout(timer); resolve(value); });
    });
    assert.equal(code, 0, 'independent ROS peer must exit cleanly');
    }
  }
});
