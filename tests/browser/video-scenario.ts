import type { VideoScenarioInput, VideoScenarioResult } from './types.js';

/**
 * Raw-wire video E2E running entirely inside the browser.
 *
 * Proves what no unit test can: that a real decoder accepts what this bridge negotiates and sends.
 * It uses no SDK, so the wire contract is exercised rather than a client library's idea of it.
 *
 * @param input Runtime connection settings, never stored in the report.
 * @returns Anonymized measurements, e.g. `{framesDecoded: 42, frameWidth: 320, ...}`.
 */
export async function browserVideoScenario(input: VideoScenarioInput): Promise<VideoScenarioResult> {
  type Wire = Record<string, any>;
  const CONTROL = 'ros.control.v1';
  const deadline = performance.now() + input.timeoutMs;
  const messages: Wire[] = [];
  let request = 0;

  /** Check a condition with a fixed classification. Example: (true,'stage'); no return value. */
  function check(condition: unknown, stage: string): asserts condition { if (!condition) throw new Error(stage); }
  /** Wait briefly within the overall deadline. Example input: 20 ms; no return value. */
  async function tick(ms = 20): Promise<void> {
    check(performance.now() < deadline, 'scenario_deadline');
    await new Promise<void>(resolve => setTimeout(resolve, ms));
  }
  /** Wait for a condition. Inputs: predicate and stage; no return value. */
  async function until(condition: () => boolean, stage: string, duration = 20000): Promise<void> {
    const expires = Math.min(deadline, performance.now() + duration);
    while (!condition()) { check(performance.now() < expires, stage); await tick(); }
  }
  /** Wait for an asynchronous condition. Inputs: predicate and stage; no return value. */
  async function untilAsync(condition: () => Promise<boolean>, stage: string, duration = 20000): Promise<void> {
    const expires = Math.min(deadline, performance.now() + duration);
    while (!await condition()) { check(performance.now() < expires, stage); await tick(100); }
  }

  const pc = new RTCPeerConnection({ iceServers: [] });
  try {
    // Receive-only video sections alongside the three DataChannels, exactly as a UI would create them.
    const transceivers = Array.from({ length: input.slots }, () => pc.addTransceiver('video', { direction: 'recvonly' }));
    const channels = new Map<string, RTCDataChannel>();
    for (const label of [CONTROL, 'ros.reliable.v1', 'ros.realtime.v1']) {
      const realtime = label === 'ros.realtime.v1';
      const channel = pc.createDataChannel(label, realtime ? { ordered: false, maxRetransmits: 0 } : { ordered: true });
      channel.binaryType = 'arraybuffer';
      channel.onmessage = event => {
        const text = typeof event.data === 'string' ? event.data : new TextDecoder('utf-8', { fatal: true }).decode(event.data as ArrayBuffer);
        messages.push(JSON.parse(text));
      };
      channels.set(label, channel);
    }

    await pc.setLocalDescription(await pc.createOffer());
    await until(() => pc.iceGatheringState === 'complete', 'ice_gathering');
    check(pc.localDescription, 'missing_offer');
    const response = await fetch(`${input.url.replace(/\/$/, '')}/offer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.credential}` },
      body: JSON.stringify({ type: 'offer', sdp: pc.localDescription.sdp }),
      signal: AbortSignal.timeout(Math.max(1, Math.min(20000, deadline - performance.now()))),
    });
    check(response.status === 200, 'offer_rejected');
    const answer: RTCSessionDescriptionInit = await response.json();
    check(answer.type === 'answer' && typeof answer.sdp === 'string', 'invalid_answer');
    // The answer must offer to send, not to receive: this bridge never accepts video.
    check(/a=sendonly/.test(answer.sdp), 'answer_not_sendonly');
    check((answer.sdp.match(/^m=video/gm) ?? []).length === input.slots, 'answer_video_sections');
    await pc.setRemoteDescription(answer);
    await until(() => [...channels.values()].every(channel => channel.readyState === 'open'), 'channels_open');

    /** Send a control request and await its response. Inputs: op and fields; returns the response. */
    async function control(op: string, fields: Wire): Promise<Wire> {
      const id = `v${++request}`;
      channels.get(CONTROL)!.send(JSON.stringify({ v: 1, op, id, ...fields }));
      let found = -1;
      await until(() => (found = messages.findIndex(wire => wire.id === id)) !== -1, `control_${op}`);
      return messages.splice(found, 1)[0]!;
    }

    const welcome = await (async () => {
      channels.get(CONTROL)!.send(JSON.stringify({ v: 1, op: 'hello' }));
      let found = -1;
      await until(() => (found = messages.findIndex(wire => wire.op === 'welcome')) !== -1, 'hello');
      return messages.splice(found, 1)[0]!;
    })();
    check(Array.isArray(welcome.video) && welcome.video.length > 0, 'welcome_video_catalog');
    const track = welcome.video[0].track as string;

    // A negotiated section stays silent until it is asked for: nothing should decode yet.
    await tick(300);
    check(await framesDecoded(transceivers[0]) === 0, 'video_before_subscribe');

    const subscribed = await control('video.subscribe', { track });
    check(subscribed.op === 'video.subscribed', 'video_subscribe_rejected');
    const mid = subscribed.mid as string;
    const transceiver = transceivers.find(candidate => candidate.mid === mid);
    check(transceiver !== undefined, 'video_mid_not_negotiated');

    // The decisive assertion: a real decoder produced frames from what this bridge sent.
    await untilAsync(async () => await framesDecoded(transceiver) > 0, 'video_frames_decoded');
    const active = await inbound(transceiver);
    const frameWidth = Number(active.frameWidth ?? 0), frameHeight = Number(active.frameHeight ?? 0);
    check(frameWidth > 0 && frameHeight > 0, 'video_frame_size');

    const stopped = await control('video.unsubscribe', { mid });
    check(stopped.op === 'video.unsubscribed', 'video_unsubscribe_rejected');
    // After unsubscribing the encoder stops, so the decoded count must settle.
    await tick(1500);
    const settled = await framesDecoded(transceiver);
    await tick(1500);
    check(await framesDecoded(transceiver) === settled, 'video_still_flowing_after_unsubscribe');

    // Resuming reuses the same section without renegotiation.
    const resumed = await control('video.subscribe', { track });
    check(resumed.mid === mid, 'video_mid_changed_on_resume');
    await untilAsync(async () => await framesDecoded(transceiver) > settled, 'video_not_resumed');

    return {
      framesDecoded: await framesDecoded(transceiver),
      frameWidth, frameHeight,
      keyFramesDecoded: Number(active.keyFramesDecoded ?? 0),
      mid, track, slots: input.slots,
      assertions: {
        silentBeforeSubscribe: 'PASS', decodedAfterSubscribe: 'PASS',
        stoppedAfterUnsubscribe: 'PASS', resumedOnSameSection: 'PASS',
      },
    };
  } catch (error) {
    // Carry the receiver counters so a failure says whether packets arrived at all, rather than only
    // that nothing decoded. Counters describe this session, not the host.
    const diagnostics: Record<string, number | string> = {};
    try {
      const stats = await pc.getStats();
      stats.forEach(stat => {
        if (stat.type !== 'inbound-rtp' || stat.kind !== 'video') return;
        for (const key of ['packetsReceived', 'bytesReceived', 'framesReceived', 'framesDecoded', 'framesDropped', 'pliCount', 'packetsLost', 'ssrc']) {
          if (typeof stat[key] === 'number') diagnostics[key] = ((diagnostics[key] as number) ?? 0) + stat[key];
        }
        // What the decoder believes it is being sent; a mismatch here explains packets that never
        // become frames.
        const codec = stat.codecId === undefined ? undefined : stats.get(stat.codecId);
        if (codec !== undefined) diagnostics.codec = `${codec.mimeType}|pt=${codec.payloadType}|${codec.sdpFmtpLine ?? ''}`;
        if (typeof stat.decoderImplementation === 'string') diagnostics.decoder = stat.decoderImplementation;
      });
    } catch { /* Statistics are diagnostic only; never mask the original failure. */ }
    return { failure: error instanceof Error ? error.message : 'unknown_failure', diagnostics };
  } finally {
    pc.close();
  }

  /** Read the inbound video statistics. Input: transceiver; returns the stats object or an empty one. */
  async function inbound(transceiver: RTCRtpTransceiver): Promise<Record<string, unknown>> {
    let found: Record<string, unknown> = {};
    (await pc.getStats()).forEach(stat => {
      if (stat.type === 'inbound-rtp' && stat.kind === 'video' && stat.trackIdentifier === transceiver.receiver.track.id) found = stat;
    });
    return found;
  }

  /** Count decoded frames. Input: transceiver; returns the count, zero when nothing decoded yet. */
  async function framesDecoded(transceiver: RTCRtpTransceiver): Promise<number> {
    return Number((await inbound(transceiver)).framesDecoded ?? 0);
  }
}
