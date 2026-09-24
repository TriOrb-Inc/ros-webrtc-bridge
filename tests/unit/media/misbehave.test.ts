import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerFactory } from '../../../packages/bridge/src/media/index.js';
import type { WorkerPort, WorkerProcess } from '../../../packages/bridge/src/media/types.js';
import { binding } from './fixtures.js';

/** A worker whose output a test drives byte by byte. No input; returns the port and its controls. */
function port() {
  let output: ((chunk: Buffer) => void) | undefined;
  let rtp: ((chunk: Buffer) => void) | undefined;
  const state = { stopped: 0 };
  const value: WorkerPort = {
    spawn() {
      const process: WorkerProcess = {
        send() {}, onOutput(callback) { output = callback; }, onRtp(callback) { rtp = callback; },
        onExit() {}, async stop() { state.stopped++; },
      };
      return process;
    },
  };
  return { value, state, say: (t: string) => output?.(Buffer.from(t)), feed: (b: Buffer) => rtp?.(b) };
}

/** Frame one RTP packet as the contract requires. @param length Packet length @returns Framed bytes */
function framed(length: number): Buffer {
  const header = Buffer.alloc(2);
  header.writeUInt16BE(length);
  return Buffer.concat([header, Buffer.alloc(length, 1)]);
}

const READY = `${JSON.stringify({ v: 1, op: 'started', payload_type: 96 })}\n`;

test('ATTACK: a worker sending RTP before it says it started', async () => {
  // The media descriptor is live from the moment the process exists, so a worker can push packets
  // before acknowledging the request. They must be delivered, not dropped or double counted.
  const p = port();
  const packets: Buffer[] = [];
  const source = createWorkerFactory(p.value)(binding());
  const starting = source.start(packet => packets.push(packet), () => {});
  p.feed(framed(12));
  p.say(READY);
  await starting;
  assert.equal(packets.length, 1);
});

test('ATTACK: a worker repeating or contradicting its own acknowledgement', async () => {
  const p = port();
  let failures = 0;
  const source = createWorkerFactory(p.value)(binding());
  const starting = source.start(() => {}, () => { failures++; });
  p.say(READY);
  await starting;
  // A second `started`, and a probe result that belongs to a different request, must not resettle
  // an already running source.
  p.say(READY);
  p.say(`${JSON.stringify({ v: 1, op: 'probe_result', ok: true })}\n`);
  assert.equal(failures, 0);
  // A failure after starting is still a failure, reported once.
  p.say(`${JSON.stringify({ v: 1, op: 'failed', cause: 'device lost' })}\n`);
  assert.equal(failures, 1);
});

test('ATTACK: a worker framing RTP just outside the contract', async () => {
  for (const length of [11, 1501]) {
    const p = port();
    let failures = 0;
    const source = createWorkerFactory(p.value)(binding());
    const starting = source.start(() => {}, () => { failures++; });
    p.say(READY);
    await starting;
    p.feed(framed(length));
    assert.equal(failures, 1, `length ${length} must fail the source`);
  }
});

test('ATTACK: a worker killed mid-packet must not be reported as a failure', async () => {
  // Stopping a worker kills it wherever it happens to be, including part way through writing an
  // RFC 4571 frame. The bytes left in the pipe can decode as a length the contract forbids. That is
  // a shutdown we asked for, not a source failure - and reporting it as one leaves the track marked
  // failed, which a retry interval then holds for its whole window.
  const p = port();
  let failures = 0;
  const source = createWorkerFactory(p.value)(binding());
  const starting = source.start(() => {}, () => { failures++; });
  p.say(READY);
  await starting;
  await source.stop();
  p.feed(Buffer.from([0x00, 0x03]));   // a truncated frame header left in the pipe
  assert.equal(failures, 0);
});

test('ATTACK: a worker sending malformed control output as it is killed', async () => {
  // Same shutdown, the other descriptor: a half-written NDJSON line is not a contract violation
  // worth failing a source that is already gone.
  const p = port();
  let failures = 0;
  const source = createWorkerFactory(p.value)(binding());
  const starting = source.start(() => {}, () => { failures++; });
  p.say(READY);
  await starting;
  await source.stop();
  p.say('{"v": 1, "op": "sta\n');
  assert.equal(failures, 0);
});
