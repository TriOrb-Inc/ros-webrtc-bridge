import assert from 'node:assert/strict';
import test from 'node:test';
import { createRclnodejsBackend, type RclModule } from '../../../packages/bridge/src/ros/rclnodejs.js';
import type { RclOptions } from '../../../packages/bridge/src/ros/rclnodejs.js';
import { binding, field } from './fixtures.js';

/** native依存を操作記録するfacadeに差し替える。入力: failure設定。出力: moduleと観測値。 */
function facade(fail: 'none' | 'init' | 'node' | 'cleanup' | 'mismatch' = 'none') {
  const calls: unknown[] = [];
  let callback: (value: unknown) => void = () => {};
  class Context {
    /** context解放を記録。入力: なし。出力: voidまたは意図した失敗。 */
    shutdown() { calls.push('shutdown'); if (fail === 'cleanup') throw new Error('cleanup'); }
  }
  class Node {
    /** node構築を記録。入力: name,namespace,context。出力: node。 */
    constructor(name: string, namespace: string, context: object) {
      calls.push([name, namespace, context instanceof Context]);
      if (fail === 'node' || fail === 'cleanup') throw new Error('node');
    }
    /** publisherを記録。入力: type,topic,options。出力: spy。 */
    createPublisher(type: string, topic: string, options: object) {
      calls.push(['publisher', type, topic, options]);
      return { topic: fail === 'mismatch' ? '/wrong' : `/resolved${topic}`, publish(value: unknown) { calls.push(['publish', value]); } };
    }
    /** callbackを捕捉。入力: type,topic,options,listener。出力: void。 */
    createSubscription(type: string, topic: string, options: object, listener: (value: unknown) => void) {
      calls.push(['subscription', type, topic, options]); callback = listener;
      return { topic: fail === 'mismatch' ? '/wrong' : `/resolved${topic}` };
    }
    /** 名前解決の観測。入力: '/in'。出力: '/resolved/in'。 */
    resolveTopicName(name: string) { return `/resolved${name}`; }
    /** spin設定の記録。入力: 10。出力: void。 */
    spin(timeout: number) { calls.push(['spin', timeout]); }
  }
  class QoS {
    /** enum引数の記録。入力: 1,2,1,2。出力: QoS。 */
    constructor(...values: number[]) { calls.push(['qos', values]); }
  }
  class MessageIntrospector {
    readonly schema = { fields: [field('data', 'string')] };
  }
  const rcl: RclModule = { Context, Node, QoS, MessageIntrospector,
    /** init引数の記録。入力: context,args。出力: Promise<void>。 */
    async init(context, args) { calls.push(['init', context instanceof Context, args]); if (fail === 'init') throw new Error('init'); },
  };
  return { rcl, calls, emit(value: unknown) { callback(value); } };
}

test('QOS-01 native facade: QoS enum、remap、独立context、型取得を接続する', async () => {
  const fake = facade();
  const errors: unknown[] = [];
  const options: RclOptions = { nodeName: 'bridge', namespace: '/', args: ['--ros-args'], spinTimeoutMs: 5, onError: (error) => errors.push(error) };
  const backend = await createRclnodejsBackend(fake.rcl, options);
  assert.equal(backend.resolveTopic('/in'), '/resolved/in');
  assert.deepEqual(backend.describe('std_msgs/msg/String'), { fields: [field('data', 'string')] });
  // reliable/volatileとbest_effort/transient_localのDDS enumを独立期待値で比較する。
  const qos = binding('/in', 'web_to_ros').rosQos;
  backend.createPublisher('std_msgs/msg/String', backend.resolveTopic('/in'), qos).publish({ data: 'hello' });
  const received: unknown[] = [];
  backend.createSubscription('std_msgs/msg/String', backend.resolveTopic('/out'), { ...qos, reliability: 'best_effort', durability: 'transient_local' }, (value) => received.push(value));
  fake.emit({ data: 'response' }); fake.emit({ data: 1 });
  backend.spin(); backend.close();
  assert.deepEqual(received, [{ data: 'response' }]);
  assert.equal(errors.length, 1);
  assert.deepEqual(fake.calls.filter((value) => Array.isArray(value) && value[0] === 'qos'), [['qos', [1, 2, 1, 2]], ['qos', [1, 2, 2, 1]]]);
  assert.deepEqual(fake.calls.at(-2), ['spin', 5]);
  assert.equal(fake.calls.at(-1), 'shutdown');
  assert.ok(fake.calls.some((value) => Array.isArray(value) && value[0] === 'publish' && JSON.stringify(value[1]) === '{"data":"hello"}'));
});

test('CFG-02 native facade: 解決済所有名とnative実名の不一致を起動拒否する', async () => {
  const fake = facade('mismatch');
  const backend = await createRclnodejsBackend(fake.rcl, { nodeName: 'bridge', namespace: '/', args: [], spinTimeoutMs: 5, onError: () => {} });
  const qos = binding('/in', 'web_to_ros').rosQos;
  assert.throws(() => backend.createPublisher('std_msgs/msg/String', '/unknown', qos), /not_resolved/);
  // facadeがnativeの予想外remapを返す場合、公開名のままpublishを許可しない。
  const name = backend.resolveTopic('/in');
  assert.throws(() => backend.createPublisher('std_msgs/msg/String', name, qos), /publisher_topic_mismatch/);
  assert.throws(() => backend.createSubscription('std_msgs/msg/String', name, qos, () => {}), /subscription_topic_mismatch/);
  backend.close();
});

test('LIFE-01 native facade: init/node/cleanup失敗を取りこぼさない', async () => {
  const options: RclOptions = { nodeName: 'bridge', namespace: '/', args: [], spinTimeoutMs: 5, onError: () => {} };
  await assert.rejects(createRclnodejsBackend(facade().rcl, { ...options, spinTimeoutMs: 0 }), /invalid_spin/);
  for (const failure of ['init', 'node', 'cleanup'] as const) {
    const fake = facade(failure);
    await assert.rejects(createRclnodejsBackend(fake.rcl, options), failure === 'cleanup' ? AggregateError : new RegExp(failure));
    assert.equal(fake.calls.at(-1), 'shutdown');
  }
});
