import assert from 'node:assert/strict';
import test from 'node:test';
import { createRclnodejsBackend, type RclModule } from '../../../packages/bridge/src/ros/rclnodejs.js';
import type { RclOptions } from '../../../packages/bridge/src/ros/rclnodejs.js';
import { binding, field } from './fixtures.js';

/** Replace native dependencies with a recording facade. Input: failure settings; output: module and observations. */
function facade(fail: 'none' | 'init' | 'node' | 'cleanup' | 'mismatch' = 'none') {
  const calls: unknown[] = [];
  let callback: (value: unknown) => void = () => {};
  class Context {
    /** Record context release. No input; output: void or an intentional failure. */
    shutdown() { calls.push('shutdown'); if (fail === 'cleanup') throw new Error('cleanup'); }
  }
  class Node {
    /** Record node construction. Inputs: name,namespace,context; output: node. */
    constructor(name: string, namespace: string, context: object) {
      calls.push([name, namespace, context instanceof Context]);
      if (fail === 'node' || fail === 'cleanup') throw new Error('node');
    }
    /** Record a publisher. Inputs: type,topic,options; output: spy. */
    createPublisher(type: string, topic: string, options: object) {
      calls.push(['publisher', type, topic, options]);
      return { topic: fail === 'mismatch' ? '/wrong' : `/resolved${topic}`, publish(value: unknown) { calls.push(['publish', value]); } };
    }
    /** Capture a callback. Inputs: type,topic,options,listener; output: void. */
    createSubscription(type: string, topic: string, options: object, listener: (value: unknown) => void) {
      calls.push(['subscription', type, topic, options]); callback = listener;
      return { topic: fail === 'mismatch' ? '/wrong' : `/resolved${topic}` };
    }
    /** Observe name resolution. Input: '/in'; output: '/resolved/in'. */
    resolveTopicName(name: string) { return `/resolved${name}`; }
    /** Record spin settings. Input: 10; output: void. */
    spin(timeout: number) { calls.push(['spin', timeout]); }
  }
  class QoS {
    /** Record enum arguments. Inputs: 1,2,1,2; output: QoS. */
    constructor(...values: number[]) { calls.push(['qos', values]); }
  }
  class MessageIntrospector {
    readonly schema = { fields: [field('data', 'string')] };
  }
  const rcl: RclModule = { Context, Node, QoS, MessageIntrospector,
    /** Record initialization arguments. Inputs: context,args; output: Promise<void>. */
    async init(context, args) { calls.push(['init', context instanceof Context, args]); if (fail === 'init') throw new Error('init'); },
  };
  return { rcl, calls, emit(value: unknown) { callback(value); } };
}

test('QOS-01 native facade: connect QoS enums, remapping, independent contexts, and type lookup', async () => {
  const fake = facade();
  const errors: unknown[] = [];
  const options: RclOptions = { nodeName: 'bridge', namespace: '/', args: ['--ros-args'], spinTimeoutMs: 5, onError: (error) => errors.push(error) };
  const backend = await createRclnodejsBackend(fake.rcl, options);
  assert.equal(backend.resolveTopic('/in'), '/resolved/in');
  assert.deepEqual(backend.describe('std_msgs/msg/String'), { fields: [field('data', 'string')] });
  // Compare reliable/volatile and best_effort/transient_local DDS enums against independent expectations.
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

test('CFG-02 native facade: reject startup when resolved ownership names differ from native names', async () => {
  const fake = facade('mismatch');
  const backend = await createRclnodejsBackend(fake.rcl, { nodeName: 'bridge', namespace: '/', args: [], spinTimeoutMs: 5, onError: () => {} });
  const qos = binding('/in', 'web_to_ros').rosQos;
  assert.throws(() => backend.createPublisher('std_msgs/msg/String', '/unknown', qos), /not_resolved/);
  // Do not permit publication under the public name when the facade returns unexpected native remapping.
  const name = backend.resolveTopic('/in');
  assert.throws(() => backend.createPublisher('std_msgs/msg/String', name, qos), /publisher_topic_mismatch/);
  assert.throws(() => backend.createSubscription('std_msgs/msg/String', name, qos, () => {}), /subscription_topic_mismatch/);
  backend.close();
});

test('LIFE-01 native facade: capture initialization, node, and cleanup failures', async () => {
  const options: RclOptions = { nodeName: 'bridge', namespace: '/', args: [], spinTimeoutMs: 5, onError: () => {} };
  await assert.rejects(createRclnodejsBackend(facade().rcl, { ...options, spinTimeoutMs: 0 }), /invalid_spin/);
  for (const failure of ['init', 'node', 'cleanup'] as const) {
    const fake = facade(failure);
    await assert.rejects(createRclnodejsBackend(fake.rcl, options), failure === 'cleanup' ? AggregateError : new RegExp(failure));
    assert.equal(fake.calls.at(-1), 'shutdown');
  }
});
