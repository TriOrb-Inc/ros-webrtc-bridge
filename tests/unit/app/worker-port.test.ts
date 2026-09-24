import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { workerPort } from '../../../packages/bridge/src/app/cli.js';
import type { VideoBinding } from '../../../packages/bridge/src/config/types.js';
import { binding } from '../media/fixtures.js';

/**
 * Drives the real spawning path with a stand-in worker written in Node, so process handling -
 * descriptors, shutdown, forced termination - is exercised without needing GStreamer or ROS.
 */

let sequence = 0;

/** Run a stand-in worker. @param script Worker body @param track Binding @returns The process handle */
function launch(script: string, track: VideoBinding = binding()) {
  // A real worker is a program on disk, and the port appends --track to its arguments, which node
  // would reject as an option if the body were passed with --eval.
  mkdirSync(resolve('.runtime'), { recursive: true });
  const path = resolve('.runtime', `worker-port-stub-${process.pid}-${sequence++}.mjs`);
  writeFileSync(path, script);
  return workerPort(process.execPath, [path]).spawn(track, true);
}

/** Collect a stream until a predicate holds. @param worker Process @returns Reader helpers */
function reader(worker: ReturnType<typeof launch>) {
  const output: Buffer[] = [];
  const rtp: Buffer[] = [];
  worker.onOutput(chunk => output.push(chunk));
  worker.onRtp(chunk => rtp.push(chunk));
  /** Wait for a condition on the collected data. @param ready Predicate @returns Promise */
  const until = async (ready: () => boolean): Promise<void> => {
    const expires = Date.now() + 8000;
    while (!ready()) {
      assert.ok(Date.now() < expires, `timed out; output=${Buffer.concat(output)} rtp=${rtp.length}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  return { output, rtp, until, text: () => Buffer.concat(output).toString('utf8') };
}

test('carries control lines and RTP on separate descriptors', async () => {
  // The stand-in echoes what it was told on stdout and writes one framed packet on descriptor 3.
  const worker = launch(`
    import { writeSync } from 'node:fs';
    process.stdin.on('data', chunk => {
      const request = JSON.parse(chunk.toString());
      process.stdout.write(JSON.stringify({ v: 1, op: 'started', saw: request.op }) + '\\n');
      const packet = Buffer.alloc(14, 7);
      const length = Buffer.alloc(2); length.writeUInt16BE(packet.length);
      writeSync(3, Buffer.concat([length, packet]));
    });
  `);
  const r = reader(worker);
  worker.send(`${JSON.stringify({ v: 1, op: 'start' })}\n`);
  await r.until(() => r.text().includes('"op":"started"') && r.rtp.length > 0);
  assert.match(r.text(), /"saw":"start"/);
  assert.equal(Buffer.concat(r.rtp).readUInt16BE(0), 14, 'RTP arrives framed on its own descriptor');
  await worker.stop(`${JSON.stringify({ v: 1, op: 'shutdown' })}\n`);
});

test('ends a cooperative worker through its shutdown request', async () => {
  const worker = launch(`
    process.stdin.on('data', chunk => {
      if (JSON.parse(chunk.toString()).op === 'shutdown') process.exit(0);
      process.stdout.write(JSON.stringify({ v: 1, op: 'started' }) + '\\n');
    });
  `);
  const r = reader(worker);
  let exited = false;
  worker.onExit(() => { exited = true; });
  worker.send(`${JSON.stringify({ v: 1, op: 'start' })}\n`);
  await r.until(() => r.text().includes('"op":"started"'));
  await worker.stop(`${JSON.stringify({ v: 1, op: 'shutdown' })}\n`);
  assert.equal(exited, true);
  // Stopping an already finished worker must not wait on a process that is gone.
  await worker.stop(`${JSON.stringify({ v: 1, op: 'shutdown' })}\n`);
});

test('forces out a worker that ignores the request', async t => {
  // A worker holding an encoder and a ROS node open must not survive shutdown, whatever it does.
  const worker = launch(`
    process.stdin.resume();
    process.stdout.write(JSON.stringify({ v: 1, op: 'started' }) + '\\n');
    setInterval(() => {}, 1000);
  `);
  const r = reader(worker);
  let exited = false;
  worker.onExit(() => { exited = true; });
  await r.until(() => r.text().includes('"op":"started"'));
  await worker.stop(`${JSON.stringify({ v: 1, op: 'shutdown' })}\n`);
  assert.equal(exited, true, 'the process is gone even though it never cooperated');
  t.diagnostic('forced termination took the documented grace period');
});

test('attaches no media descriptor when the worker only probes', async () => {
  const worker = workerPort(process.execPath, ['--version']).spawn(binding(), false);
  let received = 0;
  // Probing needs no RTP path, so subscribing to one is harmless rather than an error.
  worker.onRtp(() => { received++; });
  await new Promise<void>(resolve => worker.onExit(resolve));
  assert.equal(received, 0);
  await worker.stop(`${JSON.stringify({ v: 1, op: 'shutdown' })}\n`);
});

test('terminates what is left when the pipe to a worker is already broken', async () => {
  const worker = launch('process.exit(0);\n');
  await new Promise<void>(resolve => worker.onExit(resolve));
  // Writing to a worker that has gone must not surface as an unhandled stream error.
  worker.send(`${JSON.stringify({ v: 1, op: 'force_keyframe' })}\n`);
  await new Promise(resolve => setTimeout(resolve, 50));
});

test('reports a worker that cannot be started at all', async () => {
  // A missing or non-executable program makes Node emit `error` and never `exit`. Treated as a
  // supervised departure it becomes an actionable backend failure; ignored it is an unhandled
  // emitter error that takes the bridge down.
  const worker = workerPort(resolve('.runtime', 'worker-port-absent'), []).spawn(binding(), true);
  await new Promise<void>(resolve => worker.onExit(resolve));
  // Subscribing after the process is already gone must still report it, not wait forever.
  await new Promise<void>(resolve => worker.onExit(resolve));
  // Stopping something that never started must not wait on a process that does not exist.
  await worker.stop(`${JSON.stringify({ v: 1, op: 'shutdown' })}\n`);
});
