import type { ScenarioInput, ScenarioResult } from './types.js';

/** Raw-wire E2E running entirely inside the browser. Input: runtime connection settings; returns anonymized measurements. */
export async function browserScenario(input: ScenarioInput): Promise<ScenarioResult> {
  type Wire = Record<string, any>;
  type Received = { label: string; wire: Wire };
  type Connection = { pc: RTCPeerConnection; channels: Map<string, RTCDataChannel>; messages: Received[]; streams: Set<string>; epoch: string; request: number };
  const deadline = performance.now() + input.timeoutMs;
  const active = new Set<RTCPeerConnection>();
  const connectionMs: number[] = [];
  const localCandidateTypes: string[] = [];
  const epochs: string[] = [];
  const CONTROL = 'ros.control.v1';
  let commandSequence = 0;
  let sampleSequence = 0;
  let customSequence = 0;
  let fatal: string | undefined;
  const rejectedTwists = new Set<string>();
  const runNonce = crypto.getRandomValues(new Uint32Array(2));

  /** Check a condition with a fixed classification. Example: (true,'stage'); no return value. */
  function check(condition: unknown, stage: string): asserts condition { if (!condition) throw new Error(stage); }
  /** Wait briefly within the overall deadline. Example input: 20 ms; no return value. */
  async function tick(ms = 20): Promise<void> {
    check(fatal === undefined, fatal ?? 'invalid_incoming_message');
    check(performance.now() < deadline, 'scenario_deadline');
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(ms, Math.max(1, deadline - performance.now()))));
  }
  /** Observe peer state with a finite wait. Inputs: condition/stage; no return value. */
  async function until(condition: () => boolean, stage: string, duration = 15000): Promise<void> {
    const expires = Math.min(deadline, performance.now() + duration);
    while (!condition()) { check(performance.now() < expires, stage); await tick(); }
  }
  /** Generate nonreused request IDs. Input: connection; returns e.g. r1. */
  function id(connection: Connection): string { return `r${++connection.request}`; }
  /** Send raw JSON to a channel. Inputs: connection/label/wire; no return value. */
  function send(connection: Connection, label: string, wire: Wire): void {
    const channel = connection.channels.get(label);
    check(channel?.readyState === 'open', 'channel_not_open');
    channel.send(JSON.stringify({ v: 1, ...wire }));
  }
  /** Consume only matching responses from a bounded queue. Input: predicate; returns a wire value. */
  async function receive(connection: Connection, predicate: (wire: Wire) => boolean, stage: string, duration = 15000): Promise<Wire> {
    let found = -1;
    await until(() => {
      check(fatal === undefined, fatal ?? 'invalid_incoming_message');
      check(!['failed', 'closed'].includes(connection.pc.connectionState), 'peer_failed');
      found = connection.messages.findIndex(message => predicate(message.wire));
      return found !== -1;
    }, stage, duration);
    return connection.messages.splice(found, 1)[0]!.wire;
  }
  /** Send control with a request ID and await the expected operation. Inputs: op/fields; returns a response. */
  async function request(connection: Connection, op: string, fields: Wire, expected: string): Promise<Wire> {
    const requestId = id(connection);
    send(connection, CONTROL, { op, id: requestId, ...fields });
    const result = await receive(connection, wire => wire.id === requestId, `control_${op}`);
    check(result.op === expected, `control_${op}_rejected`);
    return result;
  }

  /** Establish three real DataChannels and exchange ICE information. No input; returns a connection. */
  async function connect(): Promise<Connection> {
    const start = performance.now();
    const pc = new RTCPeerConnection({ iceServers: input.iceServers ?? [], iceTransportPolicy: input.relayOnly ? 'relay' : 'all' });
    active.add(pc);
    const connection: Connection = { pc, channels: new Map(), messages: [], streams: new Set(), epoch: '', request: 0 };
    for (const label of [CONTROL, 'ros.reliable.v1', 'ros.realtime.v1']) {
      const realtime = label === 'ros.realtime.v1';
      const channel = pc.createDataChannel(label, realtime ? { ordered: false, maxRetransmits: 0 } : { ordered: true });
      channel.binaryType = 'arraybuffer';
      // Register receive handlers before hello/ready without using the SDK.
      channel.onmessage = event => {
        try {
          check(connection.messages.length < 1000, 'incoming_queue_limit');
          const text = typeof event.data === 'string' ? event.data : new TextDecoder('utf-8', { fatal: true }).decode(event.data as ArrayBuffer);
          const wire: Wire = JSON.parse(text);
          check(wire !== null && typeof wire === 'object' && wire.v === 1 && typeof wire.op === 'string', 'invalid_wire');
          // Verify the wire contract: responses use control; subscribed String/observed data uses reliable.
          if (wire.op === 'message') {
            check(label === 'ros.reliable.v1' && connection.streams.has(wire.stream_id) && wire.epoch === connection.epoch, 'wrong_delivery_channel');
            const fingerprint = observedFingerprint(wire);
            if (fingerprint !== undefined && rejectedTwists.has(fingerprint)) fatal = 'rejected_command_observed';
          } else check(label === CONTROL, 'wrong_delivery_channel');
          connection.messages.push({ label, wire });
        } catch { fatal = 'invalid_incoming_message'; }
      };
      connection.channels.set(label, channel);
    }
    await pc.setLocalDescription(await pc.createOffer());
    await until(() => pc.iceGatheringState === 'complete', 'ice_gathering');
    check(pc.localDescription, 'missing_offer');
    // Keep credentials and SDP only inside the page, excluding them from reports and exceptions.
    const response = await fetch(`${input.url.replace(/\/$/, '')}/offer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.credential}` },
      body: JSON.stringify({ type: 'offer', sdp: pc.localDescription.sdp }), signal: AbortSignal.timeout(Math.max(1, Math.min(20000, deadline - performance.now()))),
    });
    check(response.status === 200, 'offer_rejected');
    const answer: RTCSessionDescriptionInit = await response.json();
    check(answer.type === 'answer' && typeof answer.sdp === 'string', 'invalid_answer');
    await pc.setRemoteDescription(answer);
    await until(() => [...connection.channels.values()].every(channel => channel.readyState === 'open'), 'channels_open');
    send(connection, CONTROL, { op: 'hello' });
    const welcome = await receive(connection, wire => wire.op === 'welcome' || wire.op === 'error', 'hello');
    check(welcome.op === 'welcome' && typeof welcome.epoch === 'string', 'welcome_rejected');
    const names = new Set(welcome.catalog.map((topic: Wire) => topic.topic));
    check(['/input', '/output', '/command', '/observed', '/custom_input', '/custom_output'].every(topic => names.has(topic)), 'catalog_mismatch');
    connection.epoch = welcome.epoch;
    check(!epochs.includes(connection.epoch), 'reused_epoch');
    epochs.push(connection.epoch);
    connectionMs.push(performance.now() - start);
    // Read the actual nominated/selected candidate pair from getStats.
    const stats = await pc.getStats();
    let pairId: string | undefined;
    stats.forEach(stat => { if (stat.type === 'transport' && stat.selectedCandidatePairId) pairId = stat.selectedCandidatePairId; });
    let pair = pairId === undefined ? undefined : stats.get(pairId);
    if (!pair) stats.forEach(stat => { if (stat.type === 'candidate-pair' && stat.nominated && stat.state === 'succeeded') pair = stat; });
    check(pair?.localCandidateId, 'selected_pair_missing');
    const local = stats.get(pair.localCandidateId);
    check(['host', 'srflx', 'prflx', 'relay'].includes(local?.candidateType), 'candidate_type_missing');
    if (input.relayOnly) check(local.candidateType === 'relay', 'relay_required');
    localCandidateTypes.push(local.candidateType);
    return connection;
  }

  /** Send ready after the subscribe response. Inputs: connection/topic; returns a stream ID. */
  async function subscribe(connection: Connection, topic: string): Promise<string> {
    const result = await request(connection, 'subscribe', { topic }, 'subscribed');
    check(typeof result.stream_id === 'string' && result.epoch === connection.epoch, 'invalid_subscribed');
    connection.streams.add(result.stream_id);
    send(connection, CONTROL, { op: 'ready', stream_id: result.stream_id });
    return result.stream_id;
  }
  /** Generate fresh values for all six fields. No input; returns a Twist. */
  function twist(): Wire {
    const value = ++sampleSequence / 32;
    return { linear: { x: runNonce[0]! / 4294967296 + value, y: -0.5, z: 0.125 },
      angular: { x: 0.25, y: -0.125, z: -(runNonce[1]! / 4294967296 + value) } };
  }
  /** Normalize all six fields independently of JSON key order. Input: Twist; returns a fingerprint. */
  function fingerprint(value: Wire): string | undefined {
    if (!value || Object.keys(value).length !== 2 || !value.linear || !value.angular || Object.keys(value.linear).length !== 3 || Object.keys(value.angular).length !== 3) return undefined;
    const fields = [value.linear.x, value.linear.y, value.linear.z, value.angular.x, value.angular.y, value.angular.z];
    return fields.every(field => typeof field === 'number' && Number.isFinite(field)) ? JSON.stringify(fields) : undefined;
  }
  /** Extract observations from the independent ROS peer's JSON String. Input: wire value; returns a fingerprint. */
  function observedFingerprint(wire: Wire): string | undefined {
    if (wire.op !== 'message' || typeof wire.data?.data !== 'string') return undefined;
    try { return fingerprint(JSON.parse(wire.data.data)); } catch { return undefined; }
  }
  /** Compare every field in the native peer's JSON String. Inputs: message/expected value; returns whether they match. */
  function sameTwist(wire: Wire, expected: Wire): boolean {
    return observedFingerprint(wire) === fingerprint(expected);
  }
  /** Generate wire boundary values for all fields of the external ROS package. No input; returns BridgeFrame. */
  function customFrame(): Wire {
    return { meta: { source: `browser-${++customSequence}`, stamp: { sec: -1, nanosec: 999999999 } },
      signed_value: '-9223372036854775808', unsigned_value: '18446744073709551615',
      payload: 'AH+A/w==', samples: [0.25, -0.5, 1.5] };
  }
  /** Compare every BridgeFrame field independently of JSON key order. Inputs: message/expected value; returns whether they match. */
  function sameCustom(wire: Wire, expected: Wire): boolean {
    const value = wire.data;
    return value?.meta?.source === expected.meta.source && value?.meta?.stamp?.sec === expected.meta.stamp.sec
      && value?.meta?.stamp?.nanosec === expected.meta.stamp.nanosec && value?.signed_value === expected.signed_value
      && value?.unsigned_value === expected.unsigned_value && value?.payload === expected.payload
      && Array.isArray(value?.samples) && value.samples.length === 3
      && value.samples.every((sample: unknown, index: number) => sample === expected.samples[index]);
  }
  /** Send one command and check the ROS API response. Inputs: handle/lease/epoch/data; returns a response. */
  async function command(connection: Connection, handle: string, lease: string, epoch: string, data: Wire): Promise<Wire> {
    const seq = String(++commandSequence);
    const requestId = id(connection);
    send(connection, 'ros.realtime.v1', { op: 'publish', id: requestId, handle, lease_id: lease, epoch, seq, data });
    return receive(connection, wire => (wire.op === 'published_to_ros' && wire.handle === handle && wire.seq === seq) || (wire.op === 'error' && wire.id === requestId), 'command_ack');
  }
  /** Verify a positive control using a fresh arm and input. Inputs: connection/handle/stream; returns a lease ID. */
  async function positiveCommand(connection: Connection, handle: string, observed: string): Promise<string> {
    const lease = await request(connection, 'arm', { handle }, 'lease');
    const expected = twist();
    const result = await command(connection, handle, lease.lease_id, connection.epoch, expected);
    check(result.op === 'published_to_ros', 'normal_command_rejected');
    await receive(connection, wire => wire.stream_id === observed && sameTwist(wire, expected), 'normal_command_observation');
    return lease.lease_id;
  }
  /** Drain in-flight messages from the previous positive sample before negative tests. Input: stream; no return value. */
  async function settle(connection: Connection, stream: string): Promise<void> {
    let quietSince = performance.now();
    const expires = Math.min(deadline, quietSince + 3000);
    while (performance.now() - quietSince < 200) {
      check(performance.now() < expires, 'observation_not_quiet');
      const before = connection.messages.length;
      connection.messages = connection.messages.filter(message => message.wire.stream_id !== stream);
      if (connection.messages.length !== before) quietSince = performance.now();
      await tick();
    }
  }
  /** Verify no new commands arrive during the observation window after rejection. Input: stream; no return value. */
  async function observeNothing(connection: Connection, stream: string): Promise<void> {
    const untilTime = performance.now() + 400;
    while (performance.now() < untilTime) {
      check(!connection.messages.some(message => message.wire.stream_id === stream), 'rejected_command_observed');
      check(fatal === undefined, fatal ?? 'invalid_incoming_message');
      await tick();
    }
  }

  try {
    // Use an initial connection and two reconnects to verify sessions and epochs are never reused, even within one page.
    for (let iteration = 0; iteration < 3; iteration++) {
      const connection = await connect();
      const output = await subscribe(connection, '/output');
      const observed = await subscribe(connection, '/observed');
      const customOutput = await subscribe(connection, '/custom_output');
      const publisher = await request(connection, 'advertise', { topic: '/input' }, 'advertised');
      const commander = await request(connection, 'advertise', { topic: '/command' }, 'advertised');
      const customPublisher = await request(connection, 'advertise', { topic: '/custom_input' }, 'advertised');
      const marker = crypto.randomUUID();
      let echoed = false;
      let seq = 0;
      // Verify DDS matching with the rclpy peer through an actual unique-marker echo.
      const echoDeadline = Math.min(deadline, performance.now() + 15000);
      while (!echoed) {
        check(performance.now() < echoDeadline, 'string_echo_timeout');
        const publishSeq = String(++seq);
        send(connection, 'ros.reliable.v1', { op: 'publish', handle: publisher.handle, epoch: connection.epoch, seq: publishSeq, data: { data: marker } });
        const ack = await receive(connection, wire => wire.op === 'published_to_ros' && wire.handle === publisher.handle && wire.seq === publishSeq, 'string_publish_ack');
        check(ack.op === 'published_to_ros', 'string_publish_rejected');
        const retryAt = Math.min(echoDeadline, performance.now() + 250);
        while (performance.now() < retryAt && !echoed) {
          const found = connection.messages.findIndex(message => message.wire.stream_id === output && message.wire.data?.data === marker);
          if (found !== -1) { connection.messages.splice(found, 1); echoed = true; }
          else await tick();
        }
      }
      // Round-trip all fields of a type generated in an external overlay without fixing a dependency in the core package.
      const custom = customFrame();
      const customPublishSeq = String(customSequence);
      send(connection, 'ros.reliable.v1', { op: 'publish', handle: customPublisher.handle,
        epoch: connection.epoch, seq: customPublishSeq, data: custom });
      const customAck = await receive(connection, wire => wire.op === 'published_to_ros'
        && wire.handle === customPublisher.handle && wire.seq === customPublishSeq, 'custom_publish_ack');
      check(customAck.op === 'published_to_ros', 'custom_publish_rejected');
      await receive(connection, wire => wire.stream_id === customOutput && sameCustom(wire, custom), 'custom_echo');
      const previousLease = await positiveCommand(connection, commander.handle, observed);
      await settle(connection, observed);
      // Wait at least 400 ms after receiving a 250 ms lease; do not compare browser and Gateway clock origins.
      const expireAt = performance.now() + 400;
      await until(() => performance.now() >= expireAt, 'lease_expiry_wait', 1000);
      const expiredPayload = twist();
      rejectedTwists.add(fingerprint(expiredPayload)!);
      const expired = await command(connection, commander.handle, previousLease, connection.epoch, expiredPayload);
      check(expired.op === 'error', 'expired_lease_accepted');
      await observeNothing(connection, observed);
      await positiveCommand(connection, commander.handle, observed);
      // On subsequent connections, attach the actual previous session epoch to a new handle and verify rejection.
      if (iteration > 0) {
        await settle(connection, observed);
        const lease = await request(connection, 'arm', { handle: commander.handle }, 'lease');
        const rejectedPayload = twist();
        rejectedTwists.add(fingerprint(rejectedPayload)!);
        const rejected = await command(connection, commander.handle, lease.lease_id, epochs[iteration - 1]!, rejectedPayload);
        check(rejected.op === 'error', 'old_epoch_accepted');
        await observeNothing(connection, observed);
        await positiveCommand(connection, commander.handle, observed);
      }
      await request(connection, 'unsubscribe', { stream_id: output }, 'unsubscribed');
      await request(connection, 'unsubscribe', { stream_id: observed }, 'unsubscribed');
      await request(connection, 'unsubscribe', { stream_id: customOutput }, 'unsubscribed');
      await request(connection, 'unadvertise', { handle: publisher.handle }, 'unadvertised');
      await request(connection, 'unadvertise', { handle: commander.handle }, 'unadvertised');
      await request(connection, 'unadvertise', { handle: customPublisher.handle }, 'unadvertised');
      check(fatal === undefined, fatal ?? 'invalid_incoming_message');
      connection.pc.close(); active.delete(connection.pc);
    }
    return { connectionMs, localCandidateTypes, reconnections: 2, assertions: {
      stringEcho: 'PASS', twistEcho: 'PASS', customInterfaceEcho: 'PASS', expiredLeaseRejected: 'PASS', expiredCommandNotObserved: 'PASS',
      oldEpochRejected: 'PASS', oldEpochCommandNotObserved: 'PASS', distinctEpochs: 'PASS', selectedCandidate: 'PASS',
    } };
  } catch (error) {
    // Raw browser exceptions may contain connection details; return only known test stages.
    const known = new Set(['scenario_deadline', 'channel_not_open', 'invalid_incoming_message', 'peer_failed', 'ice_gathering',
      'missing_offer', 'offer_rejected', 'invalid_answer', 'channels_open', 'hello', 'welcome_rejected', 'catalog_mismatch',
      'reused_epoch', 'selected_pair_missing', 'candidate_type_missing', 'relay_required', 'invalid_subscribed', 'command_ack',
      'normal_command_rejected', 'normal_command_observation', 'observation_not_quiet', 'rejected_command_observed',
      'string_echo_timeout', 'string_publish_ack', 'string_publish_rejected', 'custom_publish_ack', 'custom_publish_rejected',
      'custom_echo', 'lease_expiry_wait', 'expired_lease_accepted', 'old_epoch_accepted']);
    for (const op of ['subscribe', 'advertise', 'arm', 'unsubscribe', 'unadvertise']) {
      known.add(`control_${op}`); known.add(`control_${op}_rejected`);
    }
    const message = error instanceof Error ? error.message : '';
    return { failure: known.has(message) ? message : 'browser_scenario_failed' };
  } finally { for (const pc of active) pc.close(); }
}
