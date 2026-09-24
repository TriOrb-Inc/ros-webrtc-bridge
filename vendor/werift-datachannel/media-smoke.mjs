/**
 * Verify the vendored Werift media path between two local peers, and measure what the bridge design
 * depends on but cannot assume:
 *
 *   - send-only H.264 transceivers added before the answer keep their m-line order and receive mids,
 *     so a negotiated slot can be reported to a client;
 *   - writeRtp reaches the far side intact through DTLS-SRTP, and the sender stamps its own SSRC,
 *     which is what lets one encoded stream be fanned out to peers that negotiated different values;
 *   - RTCP PLI from a receiver surfaces on the sender, because that is how a decoder asks for an IDR;
 *   - what SRTP costs per second of video, because the bridge encrypts inside the Node process.
 *
 * Packets are paced at their media rate. An unpaced burst is not a useful measurement: sending a
 * minute of video instantly overruns the receiver and most of it is discarded, which says nothing
 * about a stream that arrives frame by frame.
 *
 * No arguments. Prints one JSON summary on success. Exits non-zero on any failed expectation.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MediaStreamTrack, RTCPeerConnection, useH264 } from './.runtime/lib/webrtc/src/index.js';

// Local host candidates only; no external STUN/TURN service is required.
const options = { iceServers: [], iceUseIpv6: false, iceAdditionalHostAddresses: ['127.0.0.1'] };
const timeout = Number(process.env.MEDIA_SMOKE_TIMEOUT_MS ?? 60000);
assert(Number.isSafeInteger(timeout) && timeout > 0, 'Invalid MEDIA_SMOKE_TIMEOUT_MS');
// Replaying the recording faster than it was captured raises the packet rate without needing a
// larger fixture, so the measurement can reach the bitrate a real camera track would use.
const frameIntervalMs = Number(process.env.MEDIA_SMOKE_FRAME_INTERVAL_MS ?? 7);
assert(Number.isSafeInteger(frameIntervalMs) && frameIntervalMs > 0, 'Invalid MEDIA_SMOKE_FRAME_INTERVAL_MS');
const rounds = Number(process.env.MEDIA_SMOKE_ROUNDS ?? 10);
assert(Number.isSafeInteger(rounds) && rounds > 0, 'Invalid MEDIA_SMOKE_ROUNDS');
const RTP_HEADER_BYTES = 12;
const CLOCK_HZ = 90000;

/**
 * Split an RFC 4571 framed recording into frames.
 * @param {Buffer} recording Length-prefixed RTP, as produced by GStreamer `rtpstreampay`.
 * @returns {{timestamp: number, packets: Buffer[]}[]} Frames in capture order, e.g. 30 for the fixture.
 */
function parse(recording) {
  const frames = [];
  for (let offset = 0; offset + 2 <= recording.length;) {
    const length = recording.readUInt16BE(offset);
    const packet = recording.subarray(offset + 2, offset + 2 + length);
    offset += 2 + length;
    const timestamp = packet.readUInt32BE(4);
    const current = frames[frames.length - 1];
    if (current !== undefined && current.timestamp === timestamp) current.packets.push(packet);
    else frames.push({ timestamp, packets: [packet] });
  }
  return frames;
}

const sender = new RTCPeerConnection({ ...options, codecs: { video: [useH264()] } });
const receiver = new RTCPeerConnection({ ...options, codecs: { video: [useH264()] } });
const heartbeat = setInterval(() => console.log('Streaming local media...'), 4000);
let deadline;
const expired = new Promise((_, reject) => {
  deadline = setTimeout(() => reject(new Error('Media smoke timed out')), timeout);
});

/** Run the exchange and collect the measurements. No arguments; resolves with the summary object. */
async function exchange() {
  const frames = parse(readFileSync(resolve('tests/fixtures/video/h264-320x240.rtp')));
  assert(frames.length > 0, 'Fixture contains no frames');

  // Two send-only tracks: one slot cannot show that m-line order is preserved.
  const tracks = [new MediaStreamTrack({ kind: 'video' }), new MediaStreamTrack({ kind: 'video' })];
  const transceivers = tracks.map((track) => sender.addTransceiver(track, { direction: 'sendonly' }));
  // The receiver offers matching recvonly slots, as a browser does.
  for (const _ of tracks) receiver.addTransceiver('video', { direction: 'recvonly' });

  let delivered = 0;
  let firstPacket;
  receiver.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe((rtp) => { firstPacket ??= rtp; delivered++; });
  });

  // The receiver is the offerer, mirroring the browser-offers-first contract of the bridge.
  await receiver.setLocalDescription(await receiver.createOffer());
  await sender.setRemoteDescription(receiver.localDescription);
  await sender.setLocalDescription(await sender.createAnswer());
  await receiver.setRemoteDescription(sender.localDescription);

  // A mid is assigned during negotiation, in the order the transceivers were added.
  const mids = transceivers.map((transceiver) => transceiver.mid);
  assert.deepEqual(mids, ['0', '1'], `Unexpected mid assignment: ${JSON.stringify(mids)}`);
  assert.equal((sender.localDescription.sdp.match(/^m=video/gm) ?? []).length, tracks.length,
    'Answer must carry one section per offered video slot');
  assert.match(sender.localDescription.sdp, /a=sendonly/, 'Answered video section must be sendonly');

  await new Promise((connected) => {
    if (sender.connectionState === 'connected') connected();
    else sender.connectionStateChange.subscribe((state) => { if (state === 'connected') connected(); });
  });

  let pliObserved = false;
  transceivers[0].sender.onPictureLossIndication.subscribe(() => { pliObserved = true; });

  // Sequence numbers and timestamps are rewritten per packet. The sender applies only a constant
  // offset, so replaying a recording unchanged repeats sequence numbers and every round after the
  // first is discarded as duplicate: anything replaying a finite recording has to renumber.
  const tick = Math.max(1, Math.round(frameIntervalMs * (CLOCK_HZ / 1000)));
  let sequence = 0, timestamp = 0, sent = 0, payloadBytes = 0;
  const startedAt = process.hrtime.bigint();
  const startedCpu = process.cpuUsage();
  for (let round = 0; round < rounds; round++) {
    for (const frame of frames) {
      for (const packet of frame.packets) {
        const copy = Buffer.from(packet);
        copy.writeUInt16BE(sequence++ & 0xffff, 2);
        copy.writeUInt32BE(timestamp, 4);
        tracks[0].writeRtp(copy);
        sent++;
        payloadBytes += packet.length;
      }
      timestamp = (timestamp + tick) >>> 0;
      await delay(frameIntervalMs);
    }
  }
  // Let the last frames drain before reading the counters.
  await delay(1000);
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const cpu = process.cpuUsage(startedCpu);

  // The sender stamps its own SSRC; the payload is carried through untouched.
  const original = frames[0].packets[0];
  assert.equal(firstPacket.header.ssrc, transceivers[0].sender.ssrc, 'Sender must stamp its own SSRC');
  assert.notEqual(firstPacket.header.ssrc, original.readUInt32BE(8), 'Fixture SSRC must not survive');
  assert.deepEqual(firstPacket.payload, original.subarray(RTP_HEADER_BYTES), 'Payload must arrive unchanged');

  await receiver.getTransceivers()[0].receiver.sendRtcpPLI(firstPacket.header.ssrc);
  await delay(1000);

  const mediaSeconds = (rounds * frames.length * frameIntervalMs) / 1000;
  const cpuMs = (cpu.user + cpu.system) / 1000;
  return {
    frames: frames.length, rounds, sent, delivered,
    loss_pct: Number((100 * (1 - delivered / sent)).toFixed(2)),
    media_s: Number(mediaSeconds.toFixed(1)),
    mbps: Number(((payloadBytes * 8) / mediaSeconds / 1e6).toFixed(2)),
    cpu_ms: Math.round(cpuMs),
    // Cost of the whole send and receive path in this one process, as a share of a single core.
    cpu_pct_of_one_core: Number(((cpuMs / elapsedMs) * 100).toFixed(1)),
    mids, pli_observed: pliObserved,
  };
}

try {
  console.log('Starting local Werift media smoke');
  const summary = await Promise.race([exchange(), expired]);
  assert.equal(summary.delivered, summary.sent, 'Every paced packet must arrive');
  assert.equal(summary.pli_observed, true, 'RTCP PLI must reach the sender');
  console.log(JSON.stringify(summary));
  console.log(`Verified H.264 over SRTP: ${summary.sent} packets, ${summary.mbps} Mbps, `
    + `${summary.cpu_pct_of_one_core}% of one core, PLI observed`);
} finally {
  clearTimeout(deadline);
  clearInterval(heartbeat);
  // close() does not always settle after a media session, so bound it rather than hanging the probe.
  // The bridge's endpoint races peer.close() against its own deadline for the same reason.
  await Promise.race([Promise.all([sender.close(), receiver.close()]), delay(2000)]);
  // Media sessions leave timers behind that would keep the loop alive after the result is known.
  process.exit(process.exitCode ?? 0);
}
