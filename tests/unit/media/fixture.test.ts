import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { createFixtureFactory } from '../../../packages/bridge/src/media/index.js';
import { binding, clockwork } from './fixtures.js';

// Tests execute from the build output, so fixtures are addressed from the repository root like the
// rest of the suite does.
const RECORDING = readFileSync(resolve('tests/fixtures/video/h264-320x240.rtp'));

/** Frame one RTP packet as RFC 4571 does. @param packet Raw packet @returns Length-prefixed bytes */
function framed(packet: Buffer): Buffer {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(packet.length);
  return Buffer.concat([length, packet]);
}

/** Build one RTP packet. @param timestamp RTP timestamp @param nal NAL type carried @returns Packet */
function packet(timestamp: number, nal: number): Buffer {
  const value = Buffer.alloc(14);
  value[0] = 0x80;
  value[1] = 96;
  value.writeUInt32BE(timestamp, 4);
  value[12] = nal;
  return value;
}

/** Start a player over a recording. @param recording Framed RTP @returns Player with its clock */
function player(recording: Buffer) {
  const time = clockwork();
  const packets: Buffer[] = [];
  const source = createFixtureFactory(recording, time.schedule)(binding());
  return { time, packets, source, start: () => source.start(packet => { packets.push(packet); }, () => {}) };
}

test('replays the committed recording frame by frame', async () => {
  const p = player(RECORDING);
  await p.start();
  // The first frame carries parameter sets, so a viewer can decode from the very first packet.
  assert.ok(p.packets.length > 0);
  assert.equal(p.packets[0][12] & 0x1f, 7);
  const first = p.packets.length;
  p.time.advance(1000);
  assert.ok(p.packets.length > first, 'playback continues on its own schedule');
  await p.source.stop();
  const settled = p.packets.length;
  p.time.advance(1000);
  assert.equal(p.packets.length, settled, 'stopping cancels the pending frame');
});

test('rewrites sequence and timestamp so looping stays monotonic', async () => {
  const p = player(RECORDING);
  await p.start();
  p.time.advance(60_000);
  const sequences = p.packets.map(value => value.readUInt16BE(2));
  assert.deepEqual(sequences, sequences.map((_, index) => index & 0xffff), 'sequence numbers are contiguous');
  const timestamps = p.packets.map(value => value.readUInt32BE(4));
  assert.ok(timestamps.every((value, index) => index === 0 || value >= timestamps[index - 1]), 'timestamps never go back');
  assert.ok(timestamps[timestamps.length - 1] > timestamps[0], 'the recording looped rather than stalling');
});

test('copies each packet so the sender cannot corrupt the recording', async () => {
  const p = player(RECORDING);
  await p.start();
  p.packets[0].writeUInt32BE(0xdeadbeef, 8);
  const again = player(RECORDING);
  await again.start();
  assert.notEqual(again.packets[0].readUInt32BE(8), 0xdeadbeef);
});

test('seeks forward to the next joinable point, wrapping past the last', async () => {
  const recording = Buffer.concat([0, 1, 2, 3].map(index => framed(packet(index * 3000, index === 0 || index === 2 ? 7 : 1))));
  const p = player(recording);
  // Before starting there is nothing to seek in.
  p.source.requestKeyframe();
  await p.start();
  assert.equal(p.packets.length, 1);
  // Cursor sits on frame 1; the next keyframe is frame 2.
  p.source.requestKeyframe();
  p.time.advance(100);
  assert.equal(p.packets[1].readUInt32BE(4) > 0, true);
  assert.equal(p.packets[1][12] & 0x1f, 7, 'resumed at a keyframe');
  // The cursor now sits past the last keyframe, so the next request wraps to the first.
  p.source.requestKeyframe();
  p.time.advance(100);
  assert.equal(p.packets[p.packets.length - 1][12] & 0x1f, 7);
});

test('groups packets sharing a timestamp into one frame', async () => {
  const recording = Buffer.concat([framed(packet(0, 7)), framed(packet(0, 1)), framed(packet(3000, 1))]);
  const p = player(recording);
  await p.start();
  assert.equal(p.packets.length, 2, 'both packets of the first frame are emitted together');
});

test('paces a single-frame recording without stalling', async () => {
  const p = player(framed(packet(0, 7)));
  await p.start();
  p.time.advance(10);
  assert.ok(p.packets.length >= 2, 'the only frame repeats');
});

test('keeps frames at least one millisecond apart', async () => {
  // Timestamps closer than a millisecond would otherwise schedule a zero delay and spin.
  const recording = Buffer.concat([framed(packet(0, 7)), framed(packet(10, 1))]);
  const p = player(recording);
  await p.start();
  p.time.advance(1);
  assert.equal(p.packets.length, 2);
});

test('rejects a recording it cannot replay', async () => {
  const factory = (value: Buffer) => createFixtureFactory(value, clockwork().schedule)(binding());
  // Truncated final packet.
  await assert.rejects(factory(Buffer.concat([framed(packet(0, 7)).subarray(0, 8)])).probe(), /framed RTP recording/);
  // Length below a complete RTP header.
  await assert.rejects(factory(Buffer.from([0, 4, 1, 2, 3, 4])).probe(), /framed RTP recording/);
  await assert.rejects(factory(Buffer.alloc(0)).probe(), /no keyframe/);
  await assert.rejects(factory(framed(packet(0, 1))).probe(), /no keyframe/);
});

test('accepts the committed recording as joinable', async () => {
  await createFixtureFactory(RECORDING, clockwork().schedule)(binding()).probe();
});

test('finds keyframes inside fragmented units', async () => {
  // A large IDR arrives as FU-A fragments; the original type lives in the fragmentation header.
  const fragment = Buffer.alloc(15);
  fragment[0] = 0x80;
  fragment[1] = 96;
  fragment[12] = 28;
  fragment[13] = 0x80 | 7;
  await createFixtureFactory(framed(fragment), clockwork().schedule)(binding()).probe();
});
