import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { createSecureContext } from 'node:tls';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRclnodejsBackend, type RclModule } from '../ros/rclnodejs.js';
import type { Peer } from '../transport/types.js';
import { startApp } from './runtime.js';
import { inspectConfig } from './registry.js';

/** Read a positive integer from environment configuration. Example: ('7443',7443) returns 7443; invalid values fail startup. */
export function numberOption(value: string | undefined, fallback: number): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('invalid_numeric_option');
  return number;
}

type IceOptions = Readonly<{
  iceServers: readonly Readonly<{ urls: string }>[];
  icePortRange?: readonly [number, number];
}>;

/** Validate deployment ICE settings. Input: process environment; output: Werift peer options. Example: STUN plus 50000-50019 returns one server and the fixed range. */
export function iceOptions(env: NodeJS.ProcessEnv): IceOptions {
  const stunUrl = env.BRIDGE_ICE_STUN_URL;
  if (stunUrl !== undefined && (!/^stuns?:[^\s]+$/.test(stunUrl) || stunUrl.length > 2048)) {
    throw new Error('invalid_ice_stun_url');
  }

  // Require both bounds together so deployments cannot silently fall back to random UDP ports.
  const minimum = env.BRIDGE_ICE_PORT_MIN;
  const maximum = env.BRIDGE_ICE_PORT_MAX;
  if ((minimum === undefined) !== (maximum === undefined)) throw new Error('invalid_ice_port_range');
  if (minimum === undefined || maximum === undefined) {
    return { iceServers: stunUrl === undefined ? [] : [{ urls: stunUrl }] };
  }

  const min = numberOption(minimum, 1), max = numberOption(maximum, 1);
  if (max > 65535 || min >= max) throw new Error('invalid_ice_port_range');
  return {
    iceServers: stunUrl === undefined ? [] : [{ urls: stunUrl }],
    icePortRange: [min, max],
  };
}

/** Read a required environment value. Example: env,'BRIDGE_CONFIG' returns a nonempty string; reject missing values without disclosing them. */
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`missing_environment:${name}`);
  return value;
}

/** Native module loading boundary. Example input: 'node:path'; output: module namespace. */
export async function loadModule(name: string): Promise<unknown> { return import(name); }

/** Start HTTPS. Inputs: key/cert, host/port, handler. Returns a server that can be closed. */
export async function listenHttps(key: Buffer, cert: Buffer, host: string, port: number,
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  const server = createServer({ key, cert }, (request, response) => { void handler(request, response); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  return {
    address: server.address(),
    /** Disconnect all HTTP sockets and finish waiting. No input; returns a completion Promise. */
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => { if (error) reject(error); else resolve(); });
      server.closeAllConnections();
    }),
  };
}

/** Start with environment settings and native dependencies. Inputs: env, replaceable loader. Returns the app. A ROS-configured env starts HTTPS. */
export async function launch(env: NodeJS.ProcessEnv, loader: typeof loadModule = loadModule) {
  env = { ...env };
  const credential = required(env, 'BRIDGE_CREDENTIAL');
  if (credential.length < 32) throw new Error('invalid_credential');
  const configPath = required(env, 'BRIDGE_CONFIG');
  const keyPath = required(env, 'BRIDGE_TLS_KEY');
  const certPath = required(env, 'BRIDGE_TLS_CERT');
  // Validate TLS and configuration before loading or initializing the native addon.
  const [configSource, key, cert] = await Promise.all([readFile(configPath, 'utf8'), readFile(keyPath), readFile(certPath)]);
  createSecureContext({ key, cert });
  const maxConfigBytes = numberOption(env.BRIDGE_MAX_CONFIG_BYTES, 1048576);
  inspectConfig(configSource, maxConfigBytes);
  const port = numberOption(env.BRIDGE_PORT, 7443);
  if (port > 65535) throw new Error('invalid_port');
  // An empty Node host can bind to a wildcard; do not treat an explicitly empty string as the default.
  const host = env.BRIDGE_HOST ?? '127.0.0.1';
  if (host.length === 0) throw new Error('invalid_host');
  // Empty allowlists deny by default. Fix permissions granted to the single credential at process startup.
  const subscribeTopics = (env.BRIDGE_SUBSCRIBE_TOPICS ?? '').split(',').filter(Boolean);
  const publishScopes = (env.BRIDGE_PUBLISH_SCOPES ?? '').split(',').filter(Boolean);
  const args: unknown = JSON.parse(env.BRIDGE_ROS_ARGS ?? '[]');
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new Error('invalid_ros_args');
  const peerOptions = iceOptions(env);
  const settings = { credential, configSource, maxConfigBytes, subscribeTopics, publishScopes,
    timeoutMs: numberOption(env.BRIDGE_NEGOTIATION_TIMEOUT_MS, 30000), maxSdpBytes: numberOption(env.BRIDGE_MAX_SDP_BYTES, 262144),
    requestTimeoutMs: numberOption(env.BRIDGE_REQUEST_TIMEOUT_MS, 10000), routerLimits: {
      maxHandles: numberOption(env.BRIDGE_MAX_HANDLES, 64), maxRequests: numberOption(env.BRIDGE_MAX_REQUESTS, 64),
      requestTtlMs: numberOption(env.BRIDGE_REQUEST_TTL_MS, 30000), maxControlRateHz: numberOption(env.BRIDGE_MAX_CONTROL_RATE_HZ, 100) } };
  const spinTimeoutMs = numberOption(env.BRIDGE_SPIN_TIMEOUT_MS, 10);
  const rcl = (await loader('rclnodejs') as { default: RclModule }).default;
  const transport = await loader('@ros-webrtc/werift-datachannel') as { RTCPeerConnection: new (options: object) => Peer };
  // Public errors expose only fixed classifications, without payloads, SDP, or credentials.
  const onError = () => { console.log('Bridge resource or ROS callback failed'); };
  return startApp(settings, {
    initialize: () => createRclnodejsBackend(rcl, { nodeName: env.BRIDGE_NODE_NAME ?? 'ros_webrtc_gateway', namespace: '/', args,
      spinTimeoutMs, onError }),
    makePeer: () => new transport.RTCPeerConnection(peerOptions),
    listen: handler => listenHttps(key, cert, host, port, handler),
    clock: () => performance.now(), onError,
  });
}

/** Start the persistent CLI and register shutdown signals. Defaults to process.env; returns a stop function. Importing does not start it. */
export async function main(env: NodeJS.ProcessEnv = process.env, launcher: typeof launch = launch) {
  console.log('Starting ROS WebRTC bridge');
  const heartbeat = setInterval(() => console.log('ROS WebRTC bridge process active'), 5000);
  try {
    const app = await launcher(env);
    /** Remove signal handlers and close all resources. No input; returns a completion Promise. */
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
