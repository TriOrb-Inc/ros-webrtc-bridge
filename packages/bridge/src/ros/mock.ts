import type { RosQos } from '../config/types.js';
import type { RosBackend } from './types.js';

/** DDSの代替保証をしないin-memory backend。入力: なし。出力: backendと観測用state。 */
export class MockRosBackend implements RosBackend {
  readonly published: Array<{ type: string; topic: string; qos: RosQos; native: unknown }> = [];
  readonly subscriptions: Array<{ type: string; topic: string; qos: RosQos; callback: (native: unknown) => void }> = [];
  closed = false;
  spinning = false;

  /** publish観測器を作る。入力: 型名,ROS名,QoS。出力: 同期publisher。 */
  createPublisher(type: string, topic: string, qos: RosQos): { publish(native: unknown): void } {
    return {
      // native値はTopicRosAdapterで検証・copy済み。spyはDDS deliveryを推測しない。
      publish: (native) => { this.published.push({ type, topic, qos, native }); },
    };
  }
  /** subscription登録。入力: 型名,ROS名,QoS,callback。出力: void。 */
  createSubscription(type: string, topic: string, qos: RosQos, callback: (native: unknown) => void): void {
    this.subscriptions.push({ type, topic, qos, callback });
  }
  /** callback配送可能な状態を記録する。入力: なし。出力: void。 */
  spin(): void { this.spinning = true; }
  /** 登録を解放する。入力: なし。出力: void。 */
  close(): void {
    this.closed = true;
    this.spinning = false;
    this.subscriptions.length = 0;
  }
  /** 独立した対向node相当の入力を注入する。入力: '/out',{data:'hello'}。出力: void。 */
  emit(topic: string, native: unknown): void {
    // ここではQoSを模擬しない。実DDSの適合はDocker integrationで確認する。
    for (const subscription of this.subscriptions) {
      if (subscription.topic === topic) subscription.callback(native);
    }
  }
}
