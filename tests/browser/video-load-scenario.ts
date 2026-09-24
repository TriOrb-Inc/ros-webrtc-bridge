import type { VideoLoadInput, VideoLoadResult } from './types.js';

/**
 * Multi-viewer and soak behaviour of the video plane, measured in a real browser.
 *
 * Two properties no single-viewer test can show. First, that viewers of one track share the source
 * rather than each getting their own: they all decode at once, and one leaving does not disturb the
 * rest. Second, that repeating the whole connect/subscribe/leave cycle does not degrade - a later
 * cycle decoding less than the first is how a leaked encoder, transceiver or timer shows up from
 * outside the process.
 *
 * @param input Runtime settings, never stored in the report.
 * @returns Anonymized measurements, e.g. `{viewers: {count: 4, ...}, cycles: {...}}`.
 */
export async function browserVideoLoadScenario(input: VideoLoadInput): Promise<VideoLoadResult> {
  type Wire = Record<string, any>;
  const CONTROL = 'ros.control.v1';
  const deadline = performance.now() + input.timeoutMs;

  /** Check a condition with a fixed classification. Example: (true,'stage'); no return value. */
  function check(condition: unknown, stage: string): asserts condition { if (!condition) throw new Error(stage); }
  /** Wait briefly within the overall deadline. Example input: 20 ms; no return value. */
  async function tick(ms = 20): Promise<void> {
    check(performance.now() < deadline, 'scenario_deadline');
    await new Promise<void>(resolve => setTimeout(resolve, ms));
  }
  /** Wait for a condition. Inputs: predicate, stage and budget; no return value. */
  async function until(condition: () => boolean, stage: string, duration = 30000): Promise<void> {
    const expires = Math.min(deadline, performance.now() + duration);
    while (!condition()) { check(performance.now() < expires, stage); await tick(); }
  }

  /** One watching peer. Input: none; returns handles to measure and close it. */
  async function watcher() {
    const messages: Wire[] = [];
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.addTransceiver('video', { direction: 'recvonly' });
    const control = pc.createDataChannel(CONTROL, { ordered: true });
    control.binaryType = 'arraybuffer';
    control.onmessage = event => {
      const text = typeof event.data === 'string' ? event.data : new TextDecoder('utf-8', { fatal: true }).decode(event.data as ArrayBuffer);
      messages.push(JSON.parse(text));
    };
    // The bridge answers a fixed channel set, so open the other two even though this scenario is
    // only interested in video: an offer a UI would not make proves nothing about a UI.
    for (const label of ['ros.reliable.v1', 'ros.realtime.v1']) {
      pc.createDataChannel(label, label === 'ros.realtime.v1' ? { ordered: false, maxRetransmits: 0 } : { ordered: true });
    }
    await pc.setLocalDescription(await pc.createOffer());
    await until(() => pc.iceGatheringState === 'complete', 'ice_gathering');
    // A gateway that accepts the connection and then stalls would otherwise hang here forever: the
    // deadline is only consulted between awaits, and page.evaluate has no timeout of its own.
    const response = await fetch(`${input.url}/offer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.credential}` },
      body: JSON.stringify({ type: 'offer', sdp: pc.localDescription!.sdp }),
      signal: AbortSignal.timeout(Math.max(1000, deadline - performance.now())),
    });
    check(response.ok, 'offer_rejected');
    await pc.setRemoteDescription(await response.json() as RTCSessionDescriptionInit);
    await until(() => control.readyState === 'open', 'control_open');
    control.send(JSON.stringify({ v: 1, op: 'hello' }));
    await until(() => messages.some(message => message.op === 'welcome'), 'welcome');
    const welcome = messages.find(message => message.op === 'welcome')!;
    check(Array.isArray(welcome.video) && welcome.video.length > 0, 'empty_catalog');
    const track = welcome.video[0].track as string;

    /** Read the inbound video statistics. No input; returns decoded frame count. */
    const decoded = async (): Promise<number> => {
      let frames = 0;
      (await pc.getStats()).forEach(report => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') frames = report.framesDecoded ?? 0;
      });
      return frames;
    };
    let requests = 0;
    /** Read the section this peer was given, once the bridge has answered. @returns The mid, or ''. */
    const mid = (): string => (messages.find(message => message.op === 'video.subscribed')?.mid as string) ?? '';
    return {
      track,
      decoded,
      mid,
      /** Give up the track without closing the peer. No input; no return value. */
      unsubscribe: () => control.send(JSON.stringify({ v: 1, op: 'video.unsubscribe', id: `u${requests++}`, mid: mid() })),
      /** Ask for the track. No input; no return value. */
      subscribe: () => control.send(JSON.stringify({ v: 1, op: 'video.subscribe', id: `s${requests++}`, track })),
      /** Report the states the bridge announced. No input; returns the state names. */
      states: () => messages.filter(message => message.op === 'video.state').map(message => message.state as string),
      /** Release the peer. No input; no return value. */
      close: () => pc.close(),
    };
  }

  /** Wait until a watcher has decoded more than a baseline. Inputs: watcher and baseline; returns the count. */
  async function advanced(viewer: { decoded: () => Promise<number> }, baseline: number, stage: string): Promise<number> {
    let frames = baseline;
    // Polling the real decoder is the only honest signal; a frame counter that never moves is the
    // failure this whole scenario exists to catch.
    while (frames <= baseline) { await tick(200); frames = await viewer.decoded(); check(performance.now() < deadline, stage); }
    return frames;
  }

  /** Repeat the whole connect/subscribe/leave cycle. No input; returns the cycle measurements. */
  async function cycles(): Promise<VideoLoadResult> {
    const decoded: number[] = [];
    for (let index = 0; index < input.cycles; index++) {
      const viewer = await watcher();
      try {
        viewer.subscribe();
        const frames = await advanced(viewer, 0, 'cycle_never_decoded');
        await new Promise<void>(resolve => setTimeout(resolve, input.holdMs));
        decoded.push(Math.max(frames, await viewer.decoded()));
      } finally { viewer.close(); }
    }
    check(decoded.every(frames => frames > 0), 'cycle_never_decoded');
    // A later cycle decoding a fraction of the first is what a leak looks like from outside.
    check(decoded[decoded.length - 1] >= decoded[0] / 2, 'cycle_degraded');
    return { phase: 'cycles', cycles: { count: decoded.length, framesDecoded: decoded },
      assertions: { everyCycleDecoded: 'PASS', lastCycleMatchedFirst: 'PASS' } };
  }

  const open: { close: () => void }[] = [];
  try {
    if (input.phase === 'cycles') return await cycles();

    // --- Several viewers of one track, at the same time -------------------------------------------
    const viewers = [];
    for (let index = 0; index < input.viewers; index++) {
      const viewer = await watcher();
      open.push(viewer);
      viewers.push(viewer);
      viewer.subscribe();
    }
    const first: number[] = [];
    for (const viewer of viewers) first.push(await advanced(viewer, 0, 'viewer_never_decoded'));
    check(first.every(frames => frames > 0), 'viewer_never_decoded');

    // Half of them leave. The rest must keep receiving: one peer going away is not a reason for the
    // others to lose their picture, and a per-viewer encoder would show up here.
    const leaving = viewers.slice(0, Math.floor(viewers.length / 2));
    const staying = viewers.slice(leaving.length);
    for (const viewer of leaving) viewer.close();
    let survivorsAdvanced = 0;
    for (const [index, viewer] of staying.entries()) {
      await advanced(viewer, first[leaving.length + index], 'survivor_stalled');
      survivorsAdvanced++;
    }
    // One viewer gives up the track and takes it again while the others keep the source running. The
    // encoder never restarts, so the numbering it resumes on is whatever the others advanced it to -
    // the rejoining decoder has to be able to pick that up.
    const rejoining = staying[0];
    const before = await rejoining.decoded();
    rejoining.unsubscribe();
    await tick(1500);
    rejoining.subscribe();
    const rejoined = await advanced(rejoining, Math.max(before, await rejoining.decoded()), 'rejoin_stalled');

    for (const viewer of staying) viewer.close();
    open.length = 0;

    return {
      phase: 'viewers',
      rejoinedAfter: rejoined,
      viewers: { count: viewers.length, framesDecoded: first, survivorsAdvanced },
      assertions: { everyViewerDecoded: 'PASS', departureDidNotDisturbOthers: 'PASS', rejoinedMidStream: 'PASS' },
    };
  } catch (error) {
    return { failure: error instanceof Error ? error.message : 'unknown_error' };
  } finally {
    for (const viewer of open) { try { viewer.close(); } catch { /* the report already carries the failure */ } }
  }
}
