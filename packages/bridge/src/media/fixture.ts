import type { MediaSource, MediaSourceFactory, Schedule } from './types.js';

/** One decodable unit: the packets sharing an RTP timestamp, plus how long to hold them on screen. */
interface Frame {
  readonly packets: readonly Buffer[];
  readonly keyframe: boolean;
  readonly delayMs: number;
}

const RTP_HEADER_BYTES = 12;
const FU_A = 28;
const NAL_SPS = 7;
const CLOCK_HZ = 90000;

/** A parsed recording: frames in playback order plus the indices a decoder can join at. */
interface Recording {
  readonly frames: readonly Frame[];
  readonly keyframes: readonly number[];
}

/**
 * Parse an RFC 4571 framed RTP recording.
 * @param fixture Length-prefixed packets, e.g. `<uint16 len><rtp>...` as produced by `rtpstreampay`.
 * @returns Frames and keyframe indices, e.g. `{frames:[...], keyframes:[0, 15]}`.
 */
function parse(fixture: Buffer): Recording {
  const frames: { packets: Buffer[]; keyframe: boolean; timestamp: number }[] = [];
  let offset = 0;
  while (offset + 2 <= fixture.length) {
    const length = fixture.readUInt16BE(offset);
    const packet = fixture.subarray(offset + 2, offset + 2 + length);
    if (length < RTP_HEADER_BYTES + 1 || packet.length !== length) throw new Error('fixture is not a framed RTP recording');
    offset += 2 + length;
    const timestamp = packet.readUInt32BE(4);
    const type = packet[RTP_HEADER_BYTES] & 0x1f;
    // Parameter sets precede every IDR in this recording, so an SPS marks a point a decoder can join
    // at. Whole-frame NAL units carry their type directly; fragments carry it in the FU header.
    const original = type === FU_A ? packet[RTP_HEADER_BYTES + 1] & 0x1f : type;
    const current = frames[frames.length - 1];
    if (current !== undefined && current.timestamp === timestamp) {
      current.packets.push(packet);
      current.keyframe ||= original === NAL_SPS;
    } else {
      frames.push({ packets: [packet], keyframe: original === NAL_SPS, timestamp });
    }
  }
  if (frames.length === 0 || !frames.some(frame => frame.keyframe)) throw new Error('fixture contains no keyframe');
  // Hold each frame for its own duration; the last one reuses the previous gap so the loop is even.
  const gaps = frames.slice(1).map((frame, index) => (frame.timestamp - frames[index].timestamp) / (CLOCK_HZ / 1000));
  const played = frames.map((frame, index) => Object.freeze({
    packets: Object.freeze(frame.packets), keyframe: frame.keyframe,
    delayMs: Math.max(1, Math.round(gaps[index] ?? gaps[gaps.length - 1] ?? 1)),
  }));
  return Object.freeze({
    frames: Object.freeze(played),
    keyframes: Object.freeze(played.flatMap((frame, index) => frame.keyframe ? [index] : [])),
  });
}

/**
 * Build the `fixture` backend: replays a recorded H.264 stream with no encoder, GStreamer or GPU.
 *
 * It exists so the whole media plane - negotiation, lifecycle, authorization, RTP fan-out and real
 * browser playback - is verifiable in CI. It replays what was recorded and therefore ignores the
 * configured input geometry; use a real backend to exercise ROS image validation and encoding.
 *
 * @param fixture RFC 4571 framed RTP recording.
 * @param schedule Cancellable delay used to pace playback.
 * @returns Factory producing one independent player per source.
 */
export function createFixtureFactory(fixture: Buffer, schedule: Schedule): MediaSourceFactory {
  return () => {
    let recording: Recording | undefined;
    let cancel: (() => void) | undefined;
    let cursor = 0, sequence = 0, timestamp = 0;

    /** Emit one frame and schedule the next. Input: packet sink; returns void. */
    const play = (onPacket: (packet: Buffer) => void): void => {
      const frames = recording!.frames;
      const frame = frames[cursor];
      cursor = (cursor + 1) % frames.length;
      for (const packet of frame.packets) {
        // Rewrite sequence and timestamp so looping and keyframe seeks stay monotonic for the
        // receiver. The packet is copied because the sender mutates the header it is given.
        const copy = Buffer.from(packet);
        copy.writeUInt16BE(sequence++ & 0xffff, 2);
        copy.writeUInt32BE(timestamp >>> 0, 4);
        onPacket(copy);
      }
      timestamp = (timestamp + Math.round(frame.delayMs * (CLOCK_HZ / 1000))) >>> 0;
      cancel = schedule(() => play(onPacket), frame.delayMs);
    };

    const source: MediaSource = {
      /** Validate the recording before peers are accepted. No input; rejects with an actionable reason. */
      async probe() { parse(fixture); },
      /** Begin replaying. Inputs: packet sink and failure callback; returns a completion Promise. */
      async start(onPacket) {
        recording = parse(fixture);
        play(onPacket);
      },
      /** Resume from the next joinable point. No input; returns void. */
      requestKeyframe() {
        if (recording === undefined) return;
        // Seek forward so a viewer that joined mid-GOP reaches parameter sets without waiting for
        // the whole recording to come round; past the last one, wrap to the first.
        const keyframes = recording.keyframes;
        cursor = keyframes.find(index => index >= cursor) ?? keyframes[0];
      },
      /** Stop replaying. No input; returns a completion Promise. Safe to call repeatedly. */
      async stop() { cancel?.(); cancel = undefined; },
    };
    return source;
  };
}
