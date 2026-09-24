import type { VideoBinding } from '../config/types.js';
import type { MediaSource, MediaSourceFactory, WorkerPort, WorkerProcess } from './types.js';

const CONTRACT_VERSION = 1;
const MAX_LINE_BYTES = 8192;
// An RTP packet is bounded by the payloader MTU; anything outside this range means the stream is
// not what the contract promises, so the worker is treated as broken rather than trusted.
const MIN_PACKET_BYTES = 12;
const MAX_PACKET_BYTES = 1500;

/**
 * Split a byte stream into complete lines, bounding what one line may cost.
 * @param onLine Receives each complete line without its terminator.
 * @returns Feed function; call it with each chunk as it arrives.
 */
function lines(onLine: (line: string) => void): (chunk: Buffer) => void {
  let pending = Buffer.alloc(0);
  return chunk => {
    pending = Buffer.concat([pending, chunk]);
    for (let end = pending.indexOf(0x0a); end !== -1; end = pending.indexOf(0x0a)) {
      const line = pending.subarray(0, end);
      pending = pending.subarray(end + 1);
      if (line.length > 0) onLine(line.toString('utf8'));
    }
    // A worker that never emits a newline must not be able to grow this buffer without limit.
    if (pending.length > MAX_LINE_BYTES) throw new Error('worker control line exceeded its limit');
  };
}

/**
 * Split an RFC 4571 framed stream into RTP packets.
 * @param onPacket Receives each complete packet.
 * @returns Feed function; call it with each chunk as it arrives.
 */
function frames(onPacket: (packet: Buffer) => void): (chunk: Buffer) => void {
  let pending = Buffer.alloc(0);
  return chunk => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      if (pending.length < 2) return;
      const length = pending.readUInt16BE(0);
      if (length < MIN_PACKET_BYTES || length > MAX_PACKET_BYTES) throw new Error('worker sent an out-of-range RTP length');
      if (pending.length < 2 + length) return;
      onPacket(pending.subarray(2, 2 + length));
      pending = pending.subarray(2 + length);
    }
  };
}

/**
 * Build a backend that runs one encoder per source in its own process.
 *
 * A process per source is what makes cleanup structural rather than careful: stopping a source ends
 * a process, so a leaked pipeline, ROS subscription or socket is not possible. It also isolates
 * failure, since one backend crashing cannot disturb another.
 *
 * @param port Spawns the worker and reports failures; injected so tests need no child processes.
 * @returns Factory producing one supervised worker per source.
 */
export function createWorkerFactory(port: WorkerPort): MediaSourceFactory {
  return (binding: VideoBinding): MediaSource => {
    let child: WorkerProcess | undefined;

    /**
     * Run the worker until it reports the awaited event or fails.
     * @param request First control message, e.g. `{op:'probe'}`.
     * @param onPacket Receives RTP packets; omitted while probing.
     * @param onFailed Called once if the worker stops unexpectedly.
     * @returns The awaited acknowledgement, e.g. the probe result.
     */
    const begin = (request: Record<string, unknown>, onPacket?: (packet: Buffer) => void,
      onFailed?: () => void): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
      const worker = port.spawn(binding, onPacket !== undefined);
      child = worker;
      let settled = false;
      /** Settle once and report a failure after settling. @param error Reason @returns void */
      const fail = (error: Error): void => {
        if (settled) { onFailed?.(); return; }
        settled = true;
        reject(error);
      };
      const readEvent = lines(line => {
        let event: Record<string, unknown>;
        // A worker that cannot speak the contract is broken, not tolerated.
        try { event = JSON.parse(line) as Record<string, unknown>; }
        catch { fail(new Error('worker sent malformed control output')); return; }
        if (event.v !== CONTRACT_VERSION) { fail(new Error('worker speaks an unsupported contract version')); return; }
        if (event.op === 'failed' || event.op === 'probe_result' && event.ok !== true) {
          fail(new Error(typeof event.cause === 'string' ? event.cause : 'worker reported a failure'));
          return;
        }
        if (event.op === 'probe_result' || event.op === 'started') {
          if (!settled) { settled = true; resolve(event); }
        }
      });
      const readPacket = onPacket === undefined ? undefined : frames(onPacket);
      worker.onOutput(chunk => { try { readEvent(chunk); } catch (error) { fail(error as Error); } });
      worker.onRtp(chunk => { try { readPacket?.(chunk); } catch (error) { fail(error as Error); } });
      worker.onExit(() => { fail(new Error('worker exited before it was asked to stop')); });
      worker.send(JSON.stringify({ v: CONTRACT_VERSION, ...request }) + '\n');
    });

    return {
      /** Prove the backend can encode here. No input; rejects with the worker's actionable reason. */
      async probe() {
        try { await begin({ op: 'probe', spec: specification(binding) }); }
        finally { await this.stop(); }
      },
      /** Start streaming. Inputs: packet and failure callbacks; returns a completion Promise. */
      async start(onPacket, onFailed) {
        await begin({ op: 'start', spec: specification(binding) }, onPacket, onFailed);
      },
      /** Ask the encoder for an IDR. No input; returns void. */
      requestKeyframe() {
        child?.send(JSON.stringify({ v: CONTRACT_VERSION, op: 'force_keyframe' }) + '\n');
      },
      /** End the worker process. No input; returns a completion Promise. Safe to call repeatedly. */
      async stop() {
        const worker = child;
        child = undefined;
        if (worker === undefined) return;
        await worker.stop(JSON.stringify({ v: CONTRACT_VERSION, op: 'shutdown' }) + '\n');
      },
    };
  };
}

/**
 * Reduce a binding to what the worker needs.
 * @param binding Validated track configuration.
 * @returns Specification sent to the worker, e.g. `{ros_topic:'/camera0', input:{...}}`.
 */
function specification(binding: VideoBinding): Record<string, unknown> {
  // Only what the worker acts on crosses the boundary: no scopes, no credentials, no catalog.
  return {
    ros_topic: binding.rosTopic,
    ros_qos: { reliability: binding.rosQos.reliability, depth: binding.rosQos.depth },
    input: { ...binding.input },
    encoder: { backend: binding.encoder.backend, bitrate: binding.encoder.bitrate,
      keyframe_interval: binding.encoder.keyframeInterval, profile: binding.encoder.profile },
  };
}
