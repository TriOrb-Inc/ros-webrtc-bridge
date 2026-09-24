import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { createSecureContext } from 'node:tls';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { createRclnodejsBackend, type RclModule } from '../ros/rclnodejs.js';
import { spawn } from 'node:child_process';
import { createFixtureFactory, createWorkerFactory, timerSchedule } from '../media/index.js';
import type { MediaSourceFactory, WorkerPort, WorkerProcess } from '../media/types.js';
import type { MediaTrack, Peer, VideoSlot } from '../transport/types.js';
import { startApp } from './runtime.js';
import { inspectConfig } from './registry.js';

/** Werift media surface used to answer one receive-only video section. Tests inject the same shape. */
export interface MediaTransport {
  MediaStreamTrack: new (props: { kind: 'video' }) => MediaTrack;
  useH264: (props: Record<string, unknown>) => unknown;
}

/**
 * Attach a send-only H.264 transceiver to a peer.
 *
 * The codec is not assigned here. Werift matches the offer against the list the PeerConnection was
 * built with and stamps the negotiated payload type onto every packet; assigning codecs to the
 * transceiver instead leaves the browser receiving a payload type it never agreed to, which it
 * counts as arriving packets that never become frames.
 *
 * @param transport Werift media constructors.
 * @param peer PeerConnection being answered, before the offer is applied.
 * @returns A slot the media plane writes complete RTP packets into.
 */
export function videoSlot(transport: MediaTransport, peer: Peer,
  offered: { readonly payloadType: number; readonly profileLevelId: string }): VideoSlot {
  const track = new transport.MediaStreamTrack({ kind: 'video' });
  const transceiver = peer.addTransceiver!(track, { direction: 'sendonly' });
  return {
    // The mid is assigned during negotiation, so it is read when answering, not when created.
    get mid(): string { return transceiver.mid ?? ''; },
    // Kept so a track can only be bound to a section whose profile it actually produces.
    profileLevelId: offered.profileLevelId,
    /** Hand one complete RTP packet to the peer. Input: packet; returns void. */
    write(packet: Buffer): void { track.writeRtp(packet); },
    /** Forward the decoder's keyframe requests. Input: callback; returns void. */
    onKeyframeRequest(callback: () => void): void { transceiver.sender.onPictureLossIndication.subscribe(callback); },
    /** Release the track. No input; returns void. */
    stop(): void { track.stop(); },
  };
}

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

/**
 * Validate the supported STUN URI subset without resolving DNS.
 * @param value Candidate deployment URI.
 * @returns Whether the URI is `stun:` with a valid host and optional port. For example, `stun:[2001:db8::1]:3478` returns true.
 */
function validStunUrl(value: string): boolean {
  if (value.length > 2048 || !value.startsWith('stun:')) return false;

  // Split bracketed IPv6 separately so embedded colons cannot be confused with a port separator.
  const authority = value.slice(5);
  const ipv6 = /^\[([^\]]+)\](?::([^:]+))?$/.exec(authority);
  const hostPort = ipv6 ?? /^([^:]+)(?::([^:]+))?$/.exec(authority);
  if (!hostPort) return false;

  // Validate the complete decimal port instead of inheriting Werift's parseInt fallback behavior.
  const host = hostPort[1], port = hostPort[2];
  if (port !== undefined && (!/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) return false;
  if (ipv6) return !host.includes('%') && isIP(host) === 6;
  if (isIP(host) === 4) return true;

  // Accept relative or absolute ASCII DNS names, but not malformed numeric IPv4 lookalikes.
  const dnsHost = host.endsWith('.') ? host.slice(0, -1) : host;
  if (dnsHost.length === 0 || dnsHost.length > 253 || /^[0-9.]+$/.test(dnsHost)) return false;
  return dnsHost.split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

/** Validate deployment ICE settings. Input: process environment; output: Werift peer options. Example: STUN plus 50000-50019 returns one server and the fixed range. */
export function iceOptions(env: NodeJS.ProcessEnv): IceOptions {
  const stunUrl = env.BRIDGE_ICE_STUN_URL;
  if (stunUrl !== undefined && !validStunUrl(stunUrl)) {
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

/**
 * Launch media workers as child processes.
 * @param executable Worker program, e.g. an installed `media_worker.py` wrapper.
 * @param args Fixed leading arguments, e.g. an interpreter and script path.
 * @returns A port the media plane uses without knowing how a worker is started.
 */
export function workerPort(executable: string, args: readonly string[]): WorkerPort {
  return {
    /** Start one worker. Inputs: binding and whether RTP is expected; returns the process. */
    spawn(binding, streaming) {
      // RTP travels on an inherited descriptor rather than a socket, so no other local process can
      // inject into a viewer's stream, and there is no port to allocate or leak.
      const child = spawn(executable, [...args, '--track', binding.name],
        { stdio: ['pipe', 'pipe', 'inherit', streaming ? 'pipe' : 'ignore'] });
      // stdin and stdout are always pipes above, so the streams exist for the life of the process.
      const input = child.stdin!, output = child.stdout!;
      // A program that cannot be spawned at all - a missing or non-executable worker - emits `error`
      // and never `exit`. Treating both as one "gone" event keeps the probe reporting an actionable
      // backend failure instead of waiting for a supervised exit that never arrives, and stops the
      // unhandled emitter error from taking the bridge down.
      const listeners: (() => void)[] = [];
      let gone = false;
      // Draining the list rather than guarding on a flag keeps a second departure harmless without
      // a branch no test can reach: whichever event arrives first has already taken the listeners.
      const depart = (): void => {
        gone = true;
        for (const listener of listeners.splice(0)) listener();
      };
      child.on('error', depart);
      child.once('exit', depart);
      // Writing to a worker that has already gone breaks the pipe. Terminate what may be left rather
      // than letting the stream error reach the process as an unhandled event.
      input.on('error', () => { child.kill('SIGTERM'); });
      const process: WorkerProcess = {
        send(line) { input.write(line); },
        onOutput(callback) { output.on('data', callback); },
        onRtp(callback) { (child.stdio[3] as NodeJS.ReadableStream | null)?.on('data', callback); },
        onExit(callback) { if (gone) { callback(); return; } listeners.push(callback); },
        /** Ask the worker to stop, then make sure it is gone. Input: shutdown line; returns a Promise. */
        async stop(shutdown) {
          if (gone) return;
          const ended = new Promise<void>(resolve => { listeners.push(resolve); });
          input.end(shutdown);
          // A worker that ignores the request must not keep an encoder or ROS node alive. The timer is
          // cleared once it is moot: left armed after a cooperative exit it holds the event loop for
          // its full duration, so shutting the bridge down would stall for three seconds per worker.
          let kill: NodeJS.Timeout | undefined;
          const forced = new Promise<void>(resolve => { kill = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000); });
          try { await Promise.race([ended, forced.then(() => ended)]); } finally { clearTimeout(kill); }
        },
      };
      return process;
    },
  };
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
  const videoScopes = (env.BRIDGE_VIDEO_SCOPES ?? '').split(',').filter(Boolean);
  // The fixture backend replays a recording instead of encoding, so its source is a deployment
  // detail like the TLS material rather than part of the public configuration.
  const videoBackends: Record<string, MediaSourceFactory> = {};
  if (env.BRIDGE_VIDEO_FIXTURE !== undefined) {
    videoBackends.fixture = createFixtureFactory(await readFile(env.BRIDGE_VIDEO_FIXTURE), timerSchedule);
  }
  const args: unknown = JSON.parse(env.BRIDGE_ROS_ARGS ?? '[]');
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new Error('invalid_ros_args');
  // Every GStreamer backend runs in the same worker program; which one it builds comes from the
  // track's configuration, so adding a backend never changes this wiring.
  if (env.BRIDGE_VIDEO_WORKER !== undefined) {
    const factory = createWorkerFactory(workerPort(env.BRIDGE_VIDEO_WORKER_COMMAND ?? 'python3', [env.BRIDGE_VIDEO_WORKER]));
    for (const backend of ['l4t_v4l2', 'openh264']) videoBackends[backend] = factory;
  }
  const peerOptions = iceOptions(env);
  const settings = { credential, configSource, maxConfigBytes, subscribeTopics, publishScopes, videoScopes,
    timeoutMs: numberOption(env.BRIDGE_NEGOTIATION_TIMEOUT_MS, 30000), maxSdpBytes: numberOption(env.BRIDGE_MAX_SDP_BYTES, 262144),
    requestTimeoutMs: numberOption(env.BRIDGE_REQUEST_TIMEOUT_MS, 10000), routerLimits: {
      maxHandles: numberOption(env.BRIDGE_MAX_HANDLES, 64), maxRequests: numberOption(env.BRIDGE_MAX_REQUESTS, 64),
      requestTtlMs: numberOption(env.BRIDGE_REQUEST_TTL_MS, 30000), maxControlRateHz: numberOption(env.BRIDGE_MAX_CONTROL_RATE_HZ, 100) } };
  const spinTimeoutMs = numberOption(env.BRIDGE_SPIN_TIMEOUT_MS, 10);
  const rcl = (await loader('rclnodejs') as { default: RclModule }).default;
  const transport = await loader('@ros-webrtc/werift-datachannel') as MediaTransport & { RTCPeerConnection: new (options: object) => Peer };
  // Public errors expose only fixed classifications, without payloads, SDP, or credentials.
  const onError = () => { console.log('Bridge resource or ROS callback failed'); };
  return startApp(settings, {
    initialize: () => createRclnodejsBackend(rcl, { nodeName: env.BRIDGE_NODE_NAME ?? 'ros_webrtc_gateway', namespace: '/', args,
      spinTimeoutMs, onError }),
    // Declaring the video codec here is what lets werift negotiate a payload type with the browser;
    // the deployment's ICE settings are carried through unchanged.
    makePeer: () => new transport.RTCPeerConnection({ ...peerOptions, codecs: { video: [transport.useH264({})] } }),
    videoBackends,
    makeVideoSlot: (peer, offered) => videoSlot(transport, peer, offered),
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
