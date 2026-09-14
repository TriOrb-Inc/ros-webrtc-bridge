import { createCodec } from '../../../packages/bridge/src/codec/index.js';
import type { BridgeConfig, TopicBinding } from '../../../packages/bridge/src/config/types.js';
import { SessionRouter } from '../../../packages/bridge/src/router/index.js';
import type { Channel, RouterOptions } from '../../../packages/bridge/src/router/types.js';
import { CommandGuard } from '../../../packages/bridge/src/session/command-guard.js';

/** Create a configured binding. Example: ('/in','web_to_ros') returns a binding. @param name Public name @param direction Direction @param guarded Whether a lease is required @returns Binding */
function binding(name: string, direction: TopicBinding['direction'], guarded = false): TopicBinding {
  return { publicName: name, rosTopic: `/robot${name}`, rosType: 'std_msgs/msg/String', direction,
    rosQos: { reliability: 'reliable', durability: 'volatile', history: 'keep_last', depth: 1 },
    delivery: guarded ? 'realtime' : 'reliable', maxRateHz: 100, queue: { policy: guarded ? 'latest' : 'fifo', maxMessages: guarded ? 1 : 2 },
    ...(guarded ? { commandGuard: { required: true as const, leaseMs: 250 } } : {}) };
}

/** Convert wire fields to JSON bytes. Example: {op:'hello'} returns bytes. @param wire Fields @returns Bytes */
export function bytes(wire: Record<string, unknown>): Uint8Array { return Buffer.from(JSON.stringify({ v: 1, ...wire })); }

/** Integration fixture replacing external I/O with spies. Example: () returns a fixture. @param change Configuration mutation @returns Controllable router */
export function fixture(change: (options: RouterOptions) => RouterOptions = options => options) {
  const state = { now: 0, allowed: true, blocked: false, subscribeThrows: false, publishThrows: false, cleanupThrows: false,
    authorizeHook: (): void => {}, sendThrows: false };
  const listeners = new Map<string, Set<(native: unknown) => void>>();
  const output: { channel: Channel; wire: Record<string, any> }[] = [];
  const published: { topic: string; native: unknown }[] = [];
  const topics = [binding('/out', 'ros_to_web'), binding('/latest', 'ros_to_web', true), binding('/in', 'web_to_ros'), binding('/cmd', 'web_to_ros', true)];
  const config: BridgeConfig = { version: 1, robotId: 'test', topics,
    limits: { maxPeers: 4, maxMessageBytes: 1024, maxPeerQueueBytes: 65536, maxChannelBufferedBytes: 4096 } };
  const codec = createCodec({ kind: 'object', fields: { data: { kind: 'string' } } });
  const guard = new CommandGuard({ clock: () => state.now, authorize: () => state.allowed, maxSessions: 4, maxHandles: 8, leaseMs: 250 });
  const options: RouterOptions = change({ config, guard, epoch: 'epoch-1', clock: () => state.now,
    bindings: topics.map(binding => ({ binding, codec, schemaId: 'schema-1' })),
    authorize: () => { state.authorizeHook(); return state.allowed; },
    limits: { maxHandles: 8, maxRequests: 16, requestTtlMs: 1000, maxControlRateHz: 100 },
    ros: {
      /** Register a listener. Inputs: public name/callback; output: unsubscribe function. */
      subscribe(topic, callback) {
        if (state.subscribeThrows) throw new Error('subscribe failed');
        const set = listeners.get(topic) ?? new Set();
        set.add(callback); listeners.set(topic, set);
        callback({ data: 'initial' });
        return () => { set.delete(callback); if (state.cleanupThrows) throw new Error('cleanup failed'); };
      },
      /** Synchronous ROS publish spy. Inputs: public name/native; no output. */
      publish(topic, native) { if (state.publishThrows) throw new Error('native failed'); published.push({ topic, native }); },
    },
    /** Transport spy. Inputs: label/bytes; output: whether accepted. */
    send(channel, raw) {
      if (state.sendThrows) throw new Error('transport failed');
      if (state.blocked) return false;
      output.push({ channel, wire: JSON.parse(Buffer.from(raw).toString('utf8')) });
      return true;
    },
  });
  const router = new SessionRouter(options);
  /** Send control data. Example input: {op:'hello'}; no output. */
  const control = (wire: Record<string, unknown>): void => router.receive('ros.control.v1', bytes(wire));
  /** Inject a ROS sample. Example inputs: '/out',{data:'x'}; no output. */
  const emit = (topic: string, native: unknown): void => { for (const callback of listeners.get(topic) ?? []) callback(native); };
  /** Retrieve the latest response. Example: () returns welcome. */
  const last = (): Record<string, any> => output.at(-1)!.wire;
  return { state, output, published, listeners, options, router, control, emit, last, guard };
}

/** Perform hello and advertise. Example: fixture,'/cmd' returns a handle. @param f Fixture @param topic Public name @returns Handle */
export function advertise(f: ReturnType<typeof fixture>, topic = '/in'): string {
  f.control({ op: 'hello' });
  f.control({ op: 'advertise', id: 'ad', topic });
  return f.last().handle as string;
}
