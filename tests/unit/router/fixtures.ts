import { createCodec } from '../../../packages/bridge/src/codec/index.js';
import type { BridgeConfig, TopicBinding } from '../../../packages/bridge/src/config/types.js';
import { SessionRouter } from '../../../packages/bridge/src/router/index.js';
import type { Channel, RouterOptions } from '../../../packages/bridge/src/router/types.js';
import { CommandGuard } from '../../../packages/bridge/src/session/command-guard.js';

/** 設定済みbindingを作る。入力例: ('/in','web_to_ros')、出力例: binding。@param name 公開名 @param direction 方向 @param guarded lease有無 @returns binding */
function binding(name: string, direction: TopicBinding['direction'], guarded = false): TopicBinding {
  return { publicName: name, rosTopic: `/robot${name}`, rosType: 'std_msgs/msg/String', direction,
    rosQos: { reliability: 'reliable', durability: 'volatile', history: 'keep_last', depth: 1 },
    delivery: guarded ? 'realtime' : 'reliable', maxRateHz: 100, queue: { policy: guarded ? 'latest' : 'fifo', maxMessages: guarded ? 1 : 2 },
    ...(guarded ? { commandGuard: { required: true as const, leaseMs: 250 } } : {}) };
}

/** wireをJSON bytesへ変換する。入力例: {op:'hello'}、出力例: bytes。@param wire fields @returns bytes */
export function bytes(wire: Record<string, unknown>): Uint8Array { return Buffer.from(JSON.stringify({ v: 1, ...wire })); }

/** 外部I/Oをspyに置換した結合fixture。入力例: ()、出力例: fixture。@param change 設定変更 @returns 制御可能router */
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
      /** listener登録。入力: 公開名/callback、出力: 解除関数。 */
      subscribe(topic, callback) {
        if (state.subscribeThrows) throw new Error('subscribe failed');
        const set = listeners.get(topic) ?? new Set();
        set.add(callback); listeners.set(topic, set);
        callback({ data: 'initial' });
        return () => { set.delete(callback); if (state.cleanupThrows) throw new Error('cleanup failed'); };
      },
      /** 同期ROS publish spy。入力: 公開名/native、出力なし。 */
      publish(topic, native) { if (state.publishThrows) throw new Error('native failed'); published.push({ topic, native }); },
    },
    /** transport spy。入力: label/bytes、出力: 受理可否。 */
    send(channel, raw) {
      if (state.sendThrows) throw new Error('transport failed');
      if (state.blocked) return false;
      output.push({ channel, wire: JSON.parse(Buffer.from(raw).toString('utf8')) });
      return true;
    },
  });
  const router = new SessionRouter(options);
  /** controlを送る。入力例: {op:'hello'}、出力なし。 */
  const control = (wire: Record<string, unknown>): void => router.receive('ros.control.v1', bytes(wire));
  /** ROS sampleを注入する。入力例: '/out',{data:'x'}、出力なし。 */
  const emit = (topic: string, native: unknown): void => { for (const callback of listeners.get(topic) ?? []) callback(native); };
  /** 最新応答を取得する。入力例: ()、出力例: welcome。 */
  const last = (): Record<string, any> => output.at(-1)!.wire;
  return { state, output, published, listeners, options, router, control, emit, last, guard };
}

/** helloとadvertiseを行う。入力例: fixture,'/cmd'、出力例: handle。@param f fixture @param topic 公開名 @returns handle */
export function advertise(f: ReturnType<typeof fixture>, topic = '/in'): string {
  f.control({ op: 'hello' });
  f.control({ op: 'advertise', id: 'ad', topic });
  return f.last().handle as string;
}
