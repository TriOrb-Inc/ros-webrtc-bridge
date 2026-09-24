import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerFactory } from '../../../packages/bridge/src/media/index.js';
import type { WorkerPort, WorkerProcess } from '../../../packages/bridge/src/media/types.js';
import { binding } from './fixtures.js';

/** Frame one RTP packet as the worker does. @param packet Raw packet @returns Length-prefixed bytes */
function framed(packet: Buffer): Buffer {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(packet.length);
  return Buffer.concat([length, packet]);
}

/** Build a controllable worker process. No input; returns the port plus handles to drive it. */
function port() {
  const sent: string[] = [];
  const state = { spawned: 0, stopped: 0, streaming: false, track: '' };
  let output: ((chunk: Buffer) => void) | undefined;
  let rtp: ((chunk: Buffer) => void) | undefined;
  let exit: (() => void) | undefined;
  const value: WorkerPort = {
    spawn(track, streaming) {
      state.spawned++; state.streaming = streaming; state.track = track.name;
      const process: WorkerProcess = {
        send(line) { sent.push(line); },
        onOutput(callback) { output = callback; },
        onRtp(callback) { rtp = callback; },
        onExit(callback) { exit = callback; },
        async stop(shutdown) { state.stopped++; sent.push(shutdown); },
      };
      return process;
    },
  };
  return { value, sent, state,
    /** Emit worker control output. @param text Raw bytes @returns void */
    say: (text: string) => output?.(Buffer.from(text)),
    /** Emit framed RTP. @param chunk Raw bytes @returns void */
    feed: (chunk: Buffer) => rtp?.(chunk),
    /** Report process exit. @returns void */
    die: () => exit?.() };
}

const READY = `${JSON.stringify({ v: 1, op: 'started', payload_type: 96 })}\n`;
const PROBED = `${JSON.stringify({ v: 1, op: 'probe_result', ok: true, backend: 'openh264', profile_idc: 66 })}\n`;

test('sends the track specification and nothing else', async () => {
  const p = port();
  const source = createWorkerFactory(p.value)(binding({ encoder: { ...binding().encoder, backend: 'openh264' } }));
  const probing = source.probe();
  p.say(PROBED);
  await probing;
  const request = JSON.parse(p.sent[0]);
  assert.equal(request.v, 1);
  assert.equal(request.op, 'probe');
  // Scopes, catalog names and credentials must not cross the process boundary.
  assert.deepEqual(Object.keys(request.spec).sort(), ['encoder', 'input', 'ros_qos', 'ros_topic']);
  assert.deepEqual(request.spec.encoder, { backend: 'openh264', bitrate: 4000000, keyframe_interval: 30, profile: 'constrained_baseline' });
  assert.equal(request.spec.ros_topic, '/camera/front/image_raw');
  assert.equal(p.state.streaming, false, 'probing needs no media descriptor');
  assert.equal(p.state.stopped, 1, 'the probe releases its worker');
});

test('streams RTP once the worker reports it started', async () => {
  const p = port();
  const packets: Buffer[] = [];
  const source = createWorkerFactory(p.value)(binding());
  const starting = source.start(packet => packets.push(packet), () => {});
  p.say(READY);
  await starting;
  assert.equal(p.state.streaming, true);
  // Packets may arrive split across chunks and several to a chunk.
  const first = framed(Buffer.alloc(12, 1)), second = framed(Buffer.alloc(20, 2));
  const stream = Buffer.concat([first, second]);
  p.feed(stream.subarray(0, 5));
  assert.equal(packets.length, 0, 'a partial frame is held until it is complete');
  p.feed(stream.subarray(5));
  assert.deepEqual(packets.map(packet => packet.length), [12, 20]);

  source.requestKeyframe();
  assert.deepEqual(JSON.parse(p.sent.at(-1)!), { v: 1, op: 'force_keyframe' });
  await source.stop();
  assert.deepEqual(JSON.parse(p.sent.at(-1)!), { v: 1, op: 'shutdown' });
  // Stopping twice must not touch a worker that is already gone.
  await source.stop();
  assert.equal(p.state.stopped, 1);
});

test('reports the worker reason for a failed probe', async () => {
  const p = port();
  const source = createWorkerFactory(p.value)(binding());
  const probing = source.probe();
  p.say(`${JSON.stringify({ v: 1, op: 'probe_result', ok: false, cause: 'required GStreamer element nvv4l2h264enc was not found' })}\n`);
  await assert.rejects(probing, new Error('required GStreamer element nvv4l2h264enc was not found'));
});

test('treats a worker that cannot speak the contract as broken', async () => {
  for (const [line, reason] of [
    ['not json\n', 'worker sent malformed control output'],
    [`${JSON.stringify({ v: 2, op: 'started' })}\n`, 'worker speaks an unsupported contract version'],
    [`${JSON.stringify({ v: 1, op: 'failed', cause: 'pipeline error' })}\n`, 'pipeline error'],
    [`${JSON.stringify({ v: 1, op: 'failed' })}\n`, 'worker reported a failure'],
    [`${JSON.stringify({ v: 1, op: 'probe_result', ok: false })}\n`, 'worker reported a failure'],
  ] as const) {
    const p = port();
    const starting = createWorkerFactory(p.value)(binding()).start(() => {}, () => {});
    p.say(line);
    await assert.rejects(starting, new Error(reason));
  }
});

test('bounds a worker that never terminates a line', async () => {
  const p = port();
  const starting = createWorkerFactory(p.value)(binding()).start(() => {}, () => {});
  p.say('x'.repeat(9000));
  await assert.rejects(starting, new Error('worker control line exceeded its limit'));
});

test('rejects an RTP length the contract does not allow', async () => {
  // Too short to hold a header, and longer than any payloader MTU: both mean the stream is not what
  // the contract promises, so the source fails rather than forwarding whatever arrived.
  for (const length of [0, 1600]) {
    const p = port();
    let failures = 0;
    const source = createWorkerFactory(p.value)(binding());
    const starting = source.start(() => {}, () => { failures++; });
    p.say(READY);
    await starting;
    p.feed(Buffer.from([length >> 8, length & 0xff]));
    assert.equal(failures, 1, `length ${length} must fail the source`);
  }
});

test('ignores blank lines and skips output the worker interleaves', async () => {
  const p = port();
  const source = createWorkerFactory(p.value)(binding());
  const starting = source.start(() => {}, () => {});
  p.say('\n');
  p.say(`${JSON.stringify({ v: 1, op: 'stats', frames_in: 3 })}\n`);
  p.say(READY);
  await starting;
  await source.stop();
});

test('reports an exit before and after the source started', async () => {
  const early = port();
  const starting = createWorkerFactory(early.value)(binding()).start(() => {}, () => {});
  early.die();
  await assert.rejects(starting, new Error('worker exited before it was asked to stop'));

  const late = port();
  let failures = 0;
  const source = createWorkerFactory(late.value)(binding());
  const running = source.start(() => {}, () => { failures++; });
  late.say(READY);
  await running;
  late.die();
  assert.equal(failures, 1, 'an exit after starting is reported to the lifecycle, not thrown');
});

test('keeps a keyframe request harmless when no worker is running', () => {
  const p = port();
  createWorkerFactory(p.value)(binding()).requestKeyframe();
  assert.deepEqual(p.sent, []);
});

test('does not report an exit we asked for as a failure', async () => {
  // A worker leaving because the last viewer did is the normal case. Reporting it drove the source
  // to `failed` after it had already stopped, and could stop a replacement started in the meantime.
  const p = port();
  let failures = 0;
  const source = createWorkerFactory(p.value)(binding());
  const starting = source.start(() => {}, () => { failures++; });
  p.say(READY);
  await starting;
  await source.stop();
  p.die();
  assert.equal(failures, 0);
});

test('passes an output geometry to the worker only when one is configured', async () => {
  const p = port();
  const scaled = binding({ output: { width: 1280, height: 720 } });
  const source = createWorkerFactory(p.value)(scaled);
  const probing = source.probe();
  p.say(PROBED);
  await probing;
  assert.deepEqual(JSON.parse(p.sent[0]).spec.output, { width: 1280, height: 720 });
});
