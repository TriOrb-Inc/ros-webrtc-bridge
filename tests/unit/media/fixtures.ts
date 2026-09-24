import type { Schedule } from '../../../packages/bridge/src/media/types.js';
import type { VideoBinding, VideoConfig } from '../../../packages/bridge/src/config/types.js';

/** Deterministic scheduler. No input; returns a Schedule plus controls to fire or inspect pending delays. */
export function clockwork() {
  let now = 0;
  const pending = new Map<number, { at: number; callback: () => void }>();
  let next = 0;
  const schedule: Schedule = (callback, delayMs) => {
    const handle = next++;
    pending.set(handle, { at: now + delayMs, callback });
    return () => { pending.delete(handle); };
  };
  return {
    schedule,
    /** Read the injected monotonic clock. No input; returns milliseconds. */
    clock: () => now,
    /** Count delays still armed. No input; returns the pending count. */
    armed: () => pending.size,
    /**
     * Advance time, firing everything due.
     * @param ms Milliseconds to advance, e.g. 5000 for a grace window.
     * @returns void
     */
    advance(ms: number) {
      now += ms;
      for (const [handle, entry] of [...pending]) {
        if (entry.at > now) continue;
        pending.delete(handle);
        entry.callback();
      }
    },
  };
}

/** Build a validated-shaped video binding. @param change Field overrides @returns Binding */
export function binding(change: Partial<VideoBinding> = {}): VideoBinding {
  return {
    name: 'front', rosTopic: '/camera/front/image_raw', rosType: 'sensor_msgs/msg/Image',
    rosQos: { reliability: 'best_effort', durability: 'volatile', history: 'keep_last', depth: 1 },
    input: { encoding: 'rgb8', width: 1280, height: 720, framerate: 30 },
    encoder: { codec: 'h264', backend: 'fixture', bitrate: 4000000, keyframeInterval: 30, profile: 'constrained_baseline' },
    access: { subscribeScope: 'video.front' }, ...change,
  };
}

/** Build a validated-shaped media plane. @param tracks Bindings to serve @returns Video configuration */
export function videoConfig(tracks: readonly VideoBinding[] = [binding()],
  limits: Partial<VideoConfig['limits']> = {}): VideoConfig {
  return {
    settings: { startTimeoutMs: 5000, stopGraceMs: 5000, retryMinIntervalMs: 1000, pliMinIntervalMs: 200 },
    limits: { maxTracks: 4, maxPipelines: 2, maxSlotsPerPeer: 2, maxWidth: 1920, maxHeight: 1080, maxFramerate: 60, ...limits },
    tracks,
  };
}

/** Record viewer activity. @param onWrite Optional write hook, e.g. to simulate a failing peer @returns Spy viewer */
export function viewer(onWrite: () => void = () => {}) {
  const packets: Buffer[] = [];
  const states: string[] = [];
  return {
    packets, states,
    sink: {
      /** Collect one RTP packet. Input: packet; returns void. */
      write(packet: Buffer) { packets.push(packet); onWrite(); },
      /** Collect one lifecycle notification. Input: state; returns void. */
      state(state: string) { states.push(state); },
    },
  };
}

/**
 * Build one RTP packet, as every backend is required to emit.
 * @param marker Payload byte a test can recognise. @param sequence Sequence number. @param timestamp RTP timestamp.
 * @returns A 13-byte packet: a complete header plus the marker.
 */
export function rtpPacket(marker = 1, sequence = 0, timestamp = 0): Buffer {
  const packet = Buffer.alloc(13);
  packet[0] = 0x80;
  packet[1] = 96;
  packet.writeUInt16BE(sequence & 0xffff, 2);
  packet.writeUInt32BE(timestamp >>> 0, 4);
  packet[12] = marker;
  return packet;
}
