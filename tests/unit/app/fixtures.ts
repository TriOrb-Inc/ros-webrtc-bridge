import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppFactories, AppSettings } from '../../../packages/bridge/src/app/types.js';
import type { DataChannel, Peer } from '../../../packages/bridge/src/transport/types.js';
import type { RosDefinition } from '../../../packages/bridge/src/ros/types.js';

export const source = `version: 1
robot_id: fixture
limits: {max_peers: 1, max_message_bytes: 4096, max_peer_queue_bytes: 65536, max_channel_buffered_bytes: 8192}
topics:
  /out:
    ros_type: std_msgs/msg/String
    direction: ros_to_web
    ros_qos: {reliability: reliable, durability: volatile, history: keep_last, depth: 1}
    delivery: reliable
    max_rate_hz: 10
    queue: {policy: fifo, max_messages: 4}
  /in:
    ros_type: std_msgs/msg/String
    direction: web_to_ros
    ros_qos: {reliability: reliable, durability: volatile, history: keep_last, depth: 1}
    delivery: reliable
    max_rate_hz: 10
    queue: {policy: fifo, max_messages: 4}
    access: {publish_scope: command, exclusive_writer: true}
    command_guard: {required: true, lease_ms: 1000}
`;
export const definition: RosDefinition = { fields: [{ name: 'data', type: { type: 'string', pkgName: null,
  isPrimitiveType: true, isArray: false, isFixedSizeArray: null, arraySize: null, isUpperBound: false, stringUpperBound: null } }] };
export const settings: AppSettings = { credential: randomBytes(32).toString('hex'), configSource: source,
  maxConfigBytes: 1048576, subscribeTopics: ['/out'], publishScopes: ['command'], timeoutMs: 1000,
  maxSdpBytes: 8192, requestTimeoutMs: 100, routerLimits: { maxHandles: 8, maxRequests: 8, requestTtlMs: 30000, maxControlRateHz: 100 } };

/** eventの登録とemitを観測可能にする。入力型、出力signal。例: emit('open') → listener呼出。 */
export function signal<T extends unknown[]>() {
  const callbacks = new Set<(...args: T) => void>();
  return { subscribe(callback: (...args: T) => void) { callbacks.add(callback); return { unSubscribe() { callbacks.delete(callback); } }; },
    emit(...args: T) { for (const callback of callbacks) callback(...args); } };
}

/** peer facadeを作る。入力なし、出力peerと観測channel。例: open() → 3 channel通知。 */
export function fakePeer() {
  const channels = ['ros.control.v1', 'ros.reliable.v1', 'ros.realtime.v1'].map(label => ({ label,
    ordered: label !== 'ros.realtime.v1', negotiated: false, maxRetransmits: label === 'ros.realtime.v1' ? 0 : null,
    maxPacketLifeTime: null, readyState: 'open', bufferedAmount: 0, bufferedAmountLowThreshold: 0,
    onMessage: signal<[string | Buffer]>(), stateChanged: signal<[string]>(), bufferedAmountLow: signal<unknown[]>(),
    sent: [] as Record<string, unknown>[], send(bytes: Buffer) { this.sent.push(JSON.parse(bytes.toString())); } }));
  const peer = { onDataChannel: signal<[DataChannel]>(), connectionStateChange: signal<[string]>(),
    localDescription: { type: 'answer', sdp: 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' },
    async setRemoteDescription() {}, async createAnswer() { return peer.localDescription; }, async setLocalDescription() {}, async close() {},
    open() { for (const channel of channels) peer.onDataChannel.emit(channel); }, channels };
  return peer;
}

/** ROS/HTTPS境界を置換する。入力なし、出力factoryと操作記録。 */
export function fixture() {
  const peers: ReturnType<typeof fakePeer>[] = [];
  let handle!: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  const published: unknown[] = [], events: string[] = [];
  let sample: (value: unknown) => void = () => {};
  const backend = { resolveTopic: (name: string) => `/resolved${name}`, describe: () => definition,
    createPublisher() { return { publish(value: unknown) { published.push(value); } }; },
    createSubscription(_type: string, _topic: string, _qos: unknown, listener: typeof sample) { sample = listener; },
    spin() { events.push('spin'); }, close() { events.push('ros_close'); } };
  const factories: AppFactories = { initialize: async () => backend, clock: () => 10, onError: () => { events.push('error'); },
    makePeer() { const peer = fakePeer(); peers.push(peer); return peer as Peer; },
    async listen(handler) { handle = handler; return { async close() { events.push('http_close'); } }; } };
  /** signalingへofferを入れる。入力なし、出力status。認証はfixture乱数を使用する。 */
  async function offer() {
    const request = Object.assign(new EventEmitter(), { method: 'POST', url: '/offer', headers: {
      authorization: `Bearer ${settings.credential}`, 'content-type': 'application/json' } });
    let status = 0;
    const response = { writeHead(value: number) { status = value; }, end() {} };
    const pending = handle(request as IncomingMessage, response as unknown as ServerResponse);
    request.emit('data', Buffer.from(JSON.stringify({ type: 'offer', sdp: 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' })));
    request.emit('end'); await pending; request.emit('close'); return status;
  }
  return { factories, backend, peers, events, published, offer, sample: (value: unknown) => sample(value) };
}
