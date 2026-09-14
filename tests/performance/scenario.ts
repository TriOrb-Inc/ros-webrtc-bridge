import type { Distribution, ScenarioInput, ScenarioResult } from './types.js';

/** Measure real WebRTC-to-ROS-echo-to-Web using only the browser monotonic clock. Inputs: runtime connection details and workload; returns anonymized statistics. */
export async function performanceScenario(input: ScenarioInput): Promise<ScenarioResult> {
  type Wire = Record<string, any>;
  type Pending = { readonly startedMs: number; readonly measured: boolean; readonly payload: string };
  type Connection = { readonly pc: RTCPeerConnection; readonly control: RTCDataChannel; readonly reliable: RTCDataChannel;
    readonly messages: Wire[]; readonly pending: Map<string, Pending>; epoch: string; stream: string; handle: string; request: number; sequence: number };
  const deadline = performance.now() + input.timeoutMs;
  const connections: Connection[] = [];
  const connectionTimes: number[] = [], roundTrips: number[] = [];
  const runId = crypto.randomUUID().replaceAll('-', '');
  let phase: 'setup' | 'warmup' | 'measure' | 'drain' = 'setup';
  let sent = 0, rejected = 0, unexpected = 0;

  /** Check conditions using fixed stages. Example: (true,'stage'); no output. */
  function check(condition: unknown, stage: string): asserts condition {
    if (!condition) throw new Error(stage);
  }

  /** Wait briefly within the overall deadline. Input: maximum ms; output: timer completion. */
  async function tick(milliseconds = 10): Promise<void> {
    check(performance.now() < deadline, 'scenario_deadline');
    await new Promise<void>(resolve => setTimeout(resolve, Math.max(1, Math.min(milliseconds, deadline - performance.now()))));
  }

  /** Wait for a condition until a monotonic deadline. Inputs: predicate/stage/limit; no output. */
  async function until(condition: () => boolean, stage: string, timeoutMs = 20000): Promise<void> {
    const expires = Math.min(deadline, performance.now() + timeoutMs);
    while (!condition()) {
      check(performance.now() < expires, stage);
      await tick();
    }
  }

  /** Send a versioned wire envelope to a channel. Inputs: channel/envelope; no output. */
  function send(channel: RTCDataChannel, wire: Wire): void {
    check(channel.readyState === 'open', 'channel_not_open');
    channel.send(JSON.stringify({ v: 1, ...wire }));
  }

  /** Consume matching control responses with a bounded wait. Inputs: connection/predicate/stage; returns a wire value. */
  async function receive(connection: Connection, predicate: (wire: Wire) => boolean, stage: string): Promise<Wire> {
    let found = -1;
    await until(() => {
      check(!['failed', 'closed'].includes(connection.pc.connectionState), 'peer_failed');
      found = connection.messages.findIndex(predicate);
      return found >= 0;
    }, stage);
    return connection.messages.splice(found, 1)[0]!;
  }

  /** Send control with a request ID and await the expected operation. Inputs: connection/op/fields/expected; returns a response. */
  async function request(connection: Connection, op: string, fields: Wire, expected: string): Promise<Wire> {
    const id = `r${++connection.request}`;
    send(connection.control, { op, id, ...fields });
    const response = await receive(connection, wire => wire.id === id, `control_${op}`);
    check(response.op === expected, `control_${op}_rejected`);
    return response;
  }

  /** Encode an echo identifier as a fixed-byte ASCII String. Inputs: peer/phase/sequence; returns a payload. */
  function payload(peer: number, measured: boolean, sequence: number): string {
    const prefix = `${runId}:${measured ? 'm' : 'w'}:${peer}:${sequence}:`;
    check(prefix.length <= input.payloadBytes, 'payload_too_small');
    return prefix + 'x'.repeat(input.payloadBytes - prefix.length);
  }

  /** Establish one WebRTC peer and subscribe/advertise. Input: peer index; returns a connection. */
  async function connect(peer: number): Promise<Connection> {
    const started = performance.now();
    const pc = new RTCPeerConnection();
    const control = pc.createDataChannel('ros.control.v1', { ordered: true });
    const reliable = pc.createDataChannel('ros.reliable.v1', { ordered: true });
    const realtime = pc.createDataChannel('ros.realtime.v1', { ordered: false, maxRetransmits: 0 });
    const connection: Connection = { pc, control, reliable, messages: [], pending: new Map(), epoch: '', stream: '', handle: '', request: 0, sequence: 0 };
    connections.push(connection);
    // Separate setup responses from load-time ack/echo traffic to keep the receive queue bounded.
    for (const [channel, label] of [[control, 'control'], [reliable, 'reliable']] as const) {
      channel.onmessage = event => {
        try {
          const text = typeof event.data === 'string' ? event.data : new TextDecoder('utf-8', { fatal: true }).decode(event.data as ArrayBuffer);
          const wire: Wire = JSON.parse(text);
          check(wire?.v === 1 && typeof wire.op === 'string', 'invalid_wire');
          if (wire.op === 'message' && wire.stream_id === connection.stream && typeof wire.data?.data === 'string') {
            if (label !== 'reliable') { unexpected++; return; }
            const identifier = wire.data.data.split(':', 5).slice(0, 4).join(':');
            const pending = connection.pending.get(identifier);
            if (pending !== undefined) {
              // Compare the complete transmitted payload, not just the identifying prefix; corrupted tails must not count as success.
              if (wire.data.data !== pending.payload) { unexpected++; return; }
              connection.pending.delete(identifier);
              if (pending.measured) roundTrips.push(performance.now() - pending.startedMs);
            } else if (wire.data.data.startsWith(`${runId}:m:`)) unexpected++;
            return;
          }
          if (label !== 'control') { unexpected++; return; }
          if (phase !== 'setup' && wire.op === 'published_to_ros') return;
          if (phase !== 'setup' && wire.op === 'error') { rejected++; return; }
          check(connection.messages.length < 100, 'control_queue_limit');
          connection.messages.push(wire);
        } catch {
          unexpected++;
        }
      };
    }
    await pc.setLocalDescription(await pc.createOffer());
    await until(() => pc.iceGatheringState === 'complete', 'ice_gathering');
    check(pc.localDescription, 'missing_offer');
    // Keep URLs, credentials, and SDP only inside the page, excluding them from return values.
    const response = await fetch(`${input.url.replace(/\/$/, '')}/offer`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.credential}` },
      body: JSON.stringify({ type: 'offer', sdp: pc.localDescription.sdp }),
      signal: AbortSignal.timeout(Math.max(1, Math.floor(Math.min(20000, deadline - performance.now())))) });
    check(response.status === 200, 'offer_rejected');
    const answer: RTCSessionDescriptionInit = await response.json();
    check(answer.type === 'answer' && typeof answer.sdp === 'string', 'invalid_answer');
    await pc.setRemoteDescription(answer);
    await until(() => control.readyState === 'open' && reliable.readyState === 'open' && realtime.readyState === 'open', 'channels_open');
    send(control, { op: 'hello' });
    const welcome = await receive(connection, wire => wire.op === 'welcome', 'welcome');
    check(typeof welcome.epoch === 'string', 'invalid_welcome');
    connection.epoch = welcome.epoch;
    const subscribed = await request(connection, 'subscribe', { topic: '/performance/output' }, 'subscribed');
    check(typeof subscribed.stream_id === 'string', 'invalid_subscription');
    connection.stream = subscribed.stream_id;
    send(control, { op: 'ready', stream_id: connection.stream });
    const advertised = await request(connection, 'advertise', { topic: '/performance/input' }, 'advertised');
    check(typeof advertised.handle === 'string', 'invalid_publisher');
    connection.handle = advertised.handle;
    connectionTimes.push(performance.now() - started);
    return connection;
  }

  /** Publish to each peer at the configured rate. Inputs: duration/measured; output: send completion. */
  async function load(durationMs: number, measured: boolean): Promise<void> {
    const ends = performance.now() + durationMs;
    const interval = 1000 / input.rateHz + 0.5;
    const next = connections.map(() => performance.now());
    while (performance.now() < ends) {
      const now = performance.now();
      for (let peer = 0; peer < connections.length; peer++) {
        if (now < next[peer]!) continue;
        const connection = connections[peer]!;
        const data = payload(peer, measured, ++connection.sequence);
        const identifier = data.split(':', 5).slice(0, 4).join(':');
        connection.pending.set(identifier, { startedMs: performance.now(), measured, payload: data });
        send(connection.reliable, { op: 'publish', handle: connection.handle, epoch: connection.epoch,
          seq: String(connection.sequence), data: { data } });
        if (measured) sent++;
        next[peer] = now + interval;
      }
      await tick(Math.min(10, Math.max(1, Math.min(...next) - performance.now())));
    }
  }

  /** Aggregate numbers using nearest-rank percentiles. Input: millisecond array; returns p50/p95/p99/max. */
  function distribution(values: readonly number[]): Distribution {
    if (values.length === 0) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    const sorted = [...values].sort((left, right) => left - right);
    const percentile = (fraction: number): number => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
    const rounded = (value: number): number => Math.round(value * 1000) / 1000;
    return { count: sorted.length, p50: rounded(percentile(0.5)), p95: rounded(percentile(0.95)),
      p99: rounded(percentile(0.99)), max: rounded(sorted.at(-1)!) };
  }

  try {
    for (let peer = 0; peer < input.peers; peer++) await connect(peer);
    phase = 'warmup';
    if (input.warmupSeconds > 0) await load(input.warmupSeconds * 1000, false);
    await until(() => connections.every(connection => [...connection.pending.values()].every(item => item.measured)),
      'warmup_drain', input.drainTimeoutSeconds * 1000);
    phase = 'measure';
    const measurementStarted = performance.now();
    await load(input.durationSeconds * 1000, true);
    const measurementSeconds = (performance.now() - measurementStarted) / 1000;
    phase = 'drain';
    try {
      await until(() => connections.every(connection => ![...connection.pending.values()].some(item => item.measured)),
        'measurement_drain', input.drainTimeoutSeconds * 1000);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'measurement_drain') throw error;
    }
    const lost = connections.reduce((total, connection) => total
      + [...connection.pending.values()].filter(item => item.measured).length, 0);
    const echoed = roundTrips.length;
    return { connectionMs: distribution(connectionTimes), rttMs: distribution(roundTrips), sent, echoed, lost, rejected, unexpected,
      failures: lost + rejected + unexpected, throughputMessagesPerSecond: echoed / measurementSeconds,
      targetMessagesPerSecond: input.rateHz * input.peers };
  } catch (error) {
    const known = new Set(['scenario_deadline', 'channel_not_open', 'peer_failed', 'control_queue_limit', 'payload_too_small',
      'ice_gathering', 'missing_offer', 'offer_rejected', 'invalid_answer', 'channels_open', 'welcome', 'invalid_welcome',
      'invalid_subscription', 'invalid_publisher', 'warmup_drain']);
    for (const operation of ['subscribe', 'advertise']) {
      known.add(`control_${operation}`); known.add(`control_${operation}_rejected`);
    }
    const message = error instanceof Error ? error.message : '';
    return { failure: known.has(message) ? message : 'performance_scenario_failed' };
  } finally {
    for (const connection of connections) connection.pc.close();
  }
}
