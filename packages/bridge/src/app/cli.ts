import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { createSecureContext } from 'node:tls';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRclnodejsBackend, type RclModule } from '../ros/rclnodejs.js';
import type { Peer } from '../transport/types.js';
import { startApp } from './runtime.js';
import { inspectConfig } from './registry.js';

/** 正整数の環境設定を読む。入力例: ('7443',7443)。出力: 7443、不正値は起動失敗。 */
export function numberOption(value: string | undefined, fallback: number): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('invalid_numeric_option');
  return number;
}

/** 必須環境値を読む。入力例: env,'BRIDGE_CONFIG'。出力: 非空文字列、欠落時は値を出さず拒否。 */
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`missing_environment:${name}`);
  return value;
}

/** native moduleのロード境界。入力例: 'node:path'。出力: module namespace。 */
export async function loadModule(name: string): Promise<unknown> { return import(name); }

/** HTTPSを起動する。入力: key/cert,host/port,handler。出力: close可能なserver。 */
export async function listenHttps(key: Buffer, cert: Buffer, host: string, port: number,
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  const server = createServer({ key, cert }, (request, response) => { void handler(request, response); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  return {
    address: server.address(),
    /** HTTP socketをすべて切断して待機を完了する。入力なし、出力完了Promise。 */
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => { if (error) reject(error); else resolve(); });
      server.closeAllConnections();
    }),
  };
}

/** envとnative依存を結んで起動する。入力: env,差替可能loader。出力: app。例: ROS設定済みenv → HTTPS ready。 */
export async function launch(env: NodeJS.ProcessEnv, loader: typeof loadModule = loadModule) {
  env = { ...env };
  const credential = required(env, 'BRIDGE_CREDENTIAL');
  if (credential.length < 32) throw new Error('invalid_credential');
  const configPath = required(env, 'BRIDGE_CONFIG');
  const keyPath = required(env, 'BRIDGE_TLS_KEY');
  const certPath = required(env, 'BRIDGE_TLS_CERT');
  // TLSと設定を検証してからnative addonをload/initする。
  const [configSource, key, cert] = await Promise.all([readFile(configPath, 'utf8'), readFile(keyPath), readFile(certPath)]);
  createSecureContext({ key, cert });
  const maxConfigBytes = numberOption(env.BRIDGE_MAX_CONFIG_BYTES, 1048576);
  inspectConfig(configSource, maxConfigBytes);
  const port = numberOption(env.BRIDGE_PORT, 7443);
  if (port > 65535) throw new Error('invalid_port');
  // Nodeの空hostはwildcard bindになりうるため、明示空文字を既定値として扱わない。
  const host = env.BRIDGE_HOST ?? '127.0.0.1';
  if (host.length === 0) throw new Error('invalid_host');
  // 空のallowlistはdefault deny。単一credentialに与える権限をprocess起動時に固定する。
  const subscribeTopics = (env.BRIDGE_SUBSCRIBE_TOPICS ?? '').split(',').filter(Boolean);
  const publishScopes = (env.BRIDGE_PUBLISH_SCOPES ?? '').split(',').filter(Boolean);
  const args: unknown = JSON.parse(env.BRIDGE_ROS_ARGS ?? '[]');
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new Error('invalid_ros_args');
  const settings = { credential, configSource, maxConfigBytes, subscribeTopics, publishScopes,
    timeoutMs: numberOption(env.BRIDGE_NEGOTIATION_TIMEOUT_MS, 30000), maxSdpBytes: numberOption(env.BRIDGE_MAX_SDP_BYTES, 262144),
    requestTimeoutMs: numberOption(env.BRIDGE_REQUEST_TIMEOUT_MS, 10000), routerLimits: {
      maxHandles: numberOption(env.BRIDGE_MAX_HANDLES, 64), maxRequests: numberOption(env.BRIDGE_MAX_REQUESTS, 64),
      requestTtlMs: numberOption(env.BRIDGE_REQUEST_TTL_MS, 30000), maxControlRateHz: numberOption(env.BRIDGE_MAX_CONTROL_RATE_HZ, 100) } };
  const spinTimeoutMs = numberOption(env.BRIDGE_SPIN_TIMEOUT_MS, 10);
  const rcl = (await loader('rclnodejs') as { default: RclModule }).default;
  const transport = await loader('@ros-webrtc/werift-datachannel') as { RTCPeerConnection: new (options: object) => Peer };
  // 公開errorにはpayload、SDP、credentialを含めず固定分類だけを出す。
  const onError = () => { console.log('Bridge resource or ROS callback failed'); };
  return startApp(settings, {
    initialize: () => createRclnodejsBackend(rcl, { nodeName: env.BRIDGE_NODE_NAME ?? 'ros_webrtc_gateway', namespace: '/', args,
      spinTimeoutMs, onError }),
    makePeer: () => new transport.RTCPeerConnection({ iceServers: [] }),
    listen: handler => listenHttps(key, cert, host, port, handler),
    clock: () => performance.now(), onError,
  });
}

/** 常駐CLIを起動してsignal終了を登録する。入力省略時process.env、出力停止関数。importだけでは起動しない。 */
export async function main(env: NodeJS.ProcessEnv = process.env, launcher: typeof launch = launch) {
  console.log('Starting ROS WebRTC bridge');
  const heartbeat = setInterval(() => console.log('ROS WebRTC bridge process active'), 5000);
  try {
    const app = await launcher(env);
    /** signal監視を解除して全資源を閉じる。入力なし、出力完了Promise。 */
    const stop = async () => {
      clearInterval(heartbeat);
      process.off('SIGINT', stop).off('SIGTERM', stop);
      await app.close();
    };
    process.once('SIGINT', stop).once('SIGTERM', stop);
    console.log('ROS WebRTC bridge HTTPS ready');
    return stop;
  } catch (error) { clearInterval(heartbeat); throw error; }
}
