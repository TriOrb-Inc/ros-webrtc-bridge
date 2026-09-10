import assert from 'node:assert/strict';
import test from 'node:test';
import { TopicRosAdapter } from '../../../packages/bridge/src/ros/adapter.js';
import { MockRosBackend } from '../../../packages/bridge/src/ros/mock.js';
import { registration } from './fixtures.js';

test('LIFE-01 ROS adapter: 固定entityとlogical listenerを分離する', () => {
  const backend = new MockRosBackend();
  const errors: unknown[] = [];
  const input = registration('/in', 'web_to_ros');
  // 同じROS出力へ向くaliasは共有publisherを使う。
  const alias = { ...input, binding: { ...input.binding, publicName: '/alias' } };
  const output = registration('/out', 'ros_to_web');
  const outputAlias = { ...output, binding: { ...output.binding, publicName: '/output_alias' } };
  const adapter = new TopicRosAdapter([input, alias, output, outputAlias], backend, (error) => errors.push(error));
  assert.throws(() => adapter.publish('/in', {}), /not_running/);
  adapter.start();
  assert.equal(backend.spinning, true);
  assert.throws(() => adapter.start(), /not_new/);
  // 入力変更がpublish値へ影響せず、未知/逆方向bindingを拒否する。
  const native = { data: 'hello' };
  adapter.publish('/alias', native);
  native.data = 'changed';
  assert.equal((backend.published[0]!.native as { data: string }).data, 'hello');
  assert.throws(() => adapter.publish('/out', {}), /denied/);
  assert.throws(() => adapter.subscribe('/missing', () => {}), /denied/);
  const observed: unknown[] = [];
  const remove = adapter.subscribe('/out', (value) => observed.push(value));
  // listener間のmutationと例外を隔離し、他peerの配送を維持する。
  adapter.subscribe('/out', (value) => { (value as { data: string }).data = 'mutated'; throw new Error('listener'); });
  backend.emit('/other', { data: 'no' });
  backend.emit('/out', { data: 'received' });
  assert.deepEqual(observed, [{ data: 'received' }]);
  assert.equal(errors.length, 1);
  remove(); remove();
  backend.emit('/out', { wrong: true });
  assert.equal(errors.length, 3);
  assert.equal(backend.subscriptions.length, 1);
  // teardown後の飛行中callbackは破棄する。
  const late = backend.subscriptions[0]!.callback;
  adapter.close(); adapter.close();
  late({ data: 'late' });
  assert.equal(backend.closed, true);
  assert.equal(backend.subscriptions.length, 0);
  assert.equal(observed.length, 1);
});

test('LIFE-01 ROS adapter: 重複登録と起動途中の失敗を明示する', () => {
  const entry = registration('/in', 'web_to_ros');
  assert.throws(() => new TopicRosAdapter([entry, entry], new MockRosBackend(), () => {}), /duplicate/);
  for (const cleanupFails of [false, true]) {
    const backend = new MockRosBackend();
    backend.spin = () => { throw new Error('spin failure'); };
    if (cleanupFails) backend.close = () => { throw new Error('cleanup'); };
    // cleanupの有無で元の失敗を失わず、失敗後は再起動を許さない。
    const adapter = new TopicRosAdapter([], backend, () => {});
    assert.throws(() => adapter.start(), cleanupFails ? AggregateError : /spin failure/);
    assert.throws(() => adapter.start(), /not_new/);
  }
});

test('LIFE-01 ROS adapter: listener内のcloseで後続callbackも無効化する', () => {
  const backend = new MockRosBackend();
  const adapter = new TopicRosAdapter([registration('/out', 'ros_to_web')], backend, () => {});
  adapter.start();
  // 外部に解除関数が残っていても、closeは全callback参照を解放する。
  adapter.subscribe('/out', () => adapter.close());
  let calls = 0;
  const remove = adapter.subscribe('/out', () => { calls++; });
  backend.emit('/out', { data: 'close' });
  remove();
  assert.equal(calls, 0);
  assert.equal(backend.closed, true);
});
