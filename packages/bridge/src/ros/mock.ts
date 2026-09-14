import type { RosQos } from '../config/types.js';
import type { RosBackend } from './types.js';

/** In-memory backend that provides no DDS guarantees. No input; returns a backend and observable state. */
export class MockRosBackend implements RosBackend {
  readonly published: Array<{ type: string; topic: string; qos: RosQos; native: unknown }> = [];
  readonly subscriptions: Array<{ type: string; topic: string; qos: RosQos; callback: (native: unknown) => void }> = [];
  closed = false;
  spinning = false;

  /** Create a publish observer. Inputs: type name, ROS name, QoS; returns a synchronous publisher. */
  createPublisher(type: string, topic: string, qos: RosQos): { publish(native: unknown): void } {
    return {
      // TopicRosAdapter has validated and copied native values. The spy makes no assumptions about DDS delivery.
      publish: (native) => { this.published.push({ type, topic, qos, native }); },
    };
  }
  /** Register a subscription. Inputs: type name, ROS name, QoS, callback; returns void. */
  createSubscription(type: string, topic: string, qos: RosQos, callback: (native: unknown) => void): void {
    this.subscriptions.push({ type, topic, qos, callback });
  }
  /** Record that callbacks can receive deliveries. No input; returns void. */
  spin(): void { this.spinning = true; }
  /** Release registrations. No input; returns void. */
  close(): void {
    this.closed = true;
    this.spinning = false;
    this.subscriptions.length = 0;
  }
  /** Inject input representing an independent peer node. Inputs: '/out',{data:'hello'}; returns void. */
  emit(topic: string, native: unknown): void {
    // QoS is not simulated here. Validate actual DDS compatibility through Docker integration tests.
    for (const subscription of this.subscriptions) {
      if (subscription.topic === topic) subscription.callback(native);
    }
  }
}
