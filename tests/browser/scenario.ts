import type { ScenarioInput, ScenarioResult } from './types.js';

/** ブラウザ内で完結するraw wire E2E。入力: 実行時接続情報、出力: 匿名観測値。@param input 設定 @returns 実測結果 */
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
  let fatal: string | undefined;
  const rejectedTwists = new Set<string>();
  const runNonce = crypto.getRandomValues(new Uint32Array(2));

  /** 固定の分類で条件を検証する。入力例: (true,'stage')、出力なし。 */
  function check(condition: unknown, stage: string): asserts condition { if (!condition) throw new Error(stage); }
  /** 全体deadline内の短い待機。入力例: 20ms、出力なし。 */
  async function tick(ms = 20): Promise<void> {
    check(fatal === undefined, fatal ?? 'invalid_incoming_message');
    check(performance.now() < deadline, 'scenario_deadline');
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(ms, Math.max(1, deadline - performance.now()))));
  }
  /** peer状態を観測して有限時間待つ。入力例: 条件/段階、出力なし。 */
  async function until(condition: () => boolean, stage: string, duration = 15000): Promise<void> {
    const expires = Math.min(deadline, performance.now() + duration);
    while (!condition()) { check(performance.now() < expires, stage); await tick(); }
  }
  /** request識別子を再利用せず生成する。入力: connection、出力例: r1。 */
  function id(connection: Connection): string { return `r${++connection.request}`; }
  /** channelへraw JSONを送る。入力: connection/label/wire、出力なし。 */
  function send(connection: Connection, label: string, wire: Wire): void {
    const channel = connection.channels.get(label);
    check(channel?.readyState === 'open', 'channel_not_open');
    channel.send(JSON.stringify({ v: 1, ...wire }));
  }
  /** 有界queueから該当応答だけを消費する。入力: predicate、出力: wire。 */
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
  /** request ID付きcontrolを送り期待operationを待つ。入力: op/fields、出力: 応答。 */
  async function request(connection: Connection, op: string, fields: Wire, expected: string): Promise<Wire> {
    const requestId = id(connection);
    send(connection, CONTROL, { op, id: requestId, ...fields });
    const result = await receive(connection, wire => wire.id === requestId, `control_${op}`);
    check(result.op === expected, `control_${op}_rejected`);
    return result;
  }

  /** 3本の実DataChannelとICE交換を確立する。入力なし、出力: 接続。 */
  async function connect(): Promise<Connection> {
    const start = performance.now();
    const pc = new RTCPeerConnection({ iceServers: input.iceServers ?? [], iceTransportPolicy: input.relayOnly ? 'relay' : 'all' });
    active.add(pc);
    const connection: Connection = { pc, channels: new Map(), messages: [], streams: new Set(), epoch: '', request: 0 };
    for (const label of [CONTROL, 'ros.reliable.v1', 'ros.realtime.v1']) {
      const realtime = label === 'ros.realtime.v1';
      const channel = pc.createDataChannel(label, realtime ? { ordered: false, maxRetransmits: 0 } : { ordered: true });
      channel.binaryType = 'arraybuffer';
      // SDKを介さず、受信handlerをhello/readyより前に登録する。
      channel.onmessage = event => {
        try {
          check(connection.messages.length < 1000, 'incoming_queue_limit');
          const text = typeof event.data === 'string' ? event.data : new TextDecoder('utf-8', { fatal: true }).decode(event.data as ArrayBuffer);
          const wire: Wire = JSON.parse(text);
          check(wire !== null && typeof wire === 'object' && wire.v === 1 && typeof wire.op === 'string', 'invalid_wire');
          // 応答はcontrol、購読したString/observedはreliableというwire契約を確認する。
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
    // credentialとSDPはページ内だけに保持し、reportや例外には含めない。
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
    check(['/input', '/output', '/command', '/observed'].every(topic => names.has(topic)), 'catalog_mismatch');
    connection.epoch = welcome.epoch;
    check(!epochs.includes(connection.epoch), 'reused_epoch');
    epochs.push(connection.epoch);
    connectionMs.push(performance.now() - start);
    // nominated/selectedの実candidate pairをgetStatsから取得する。
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

  /** subscribe応答後にreadyを送る。入力: connection/Topic、出力: stream ID。 */
  async function subscribe(connection: Connection, topic: string): Promise<string> {
    const result = await request(connection, 'subscribe', { topic }, 'subscribed');
    check(typeof result.stream_id === 'string' && result.epoch === connection.epoch, 'invalid_subscribed');
    connection.streams.add(result.stream_id);
    send(connection, CONTROL, { op: 'ready', stream_id: result.stream_id });
    return result.stream_id;
  }
  /** 全6fieldの新しい入力値を生成する。入力なし、出力: Twist。 */
  function twist(): Wire {
    const value = ++sampleSequence / 32;
    return { linear: { x: runNonce[0]! / 4294967296 + value, y: -0.5, z: 0.125 },
      angular: { x: 0.25, y: -0.125, z: -(runNonce[1]! / 4294967296 + value) } };
  }
  /** JSON key順に依存せず全6fieldを正規化する。入力: Twist、出力: fingerprint。 */
  function fingerprint(value: Wire): string | undefined {
    if (!value || Object.keys(value).length !== 2 || !value.linear || !value.angular || Object.keys(value.linear).length !== 3 || Object.keys(value.angular).length !== 3) return undefined;
    const fields = [value.linear.x, value.linear.y, value.linear.z, value.angular.x, value.angular.y, value.angular.z];
    return fields.every(field => typeof field === 'number' && Number.isFinite(field)) ? JSON.stringify(fields) : undefined;
  }
  /** 独立ROS対向nodeのJSON Stringから観測値を取得する。入力: wire、出力: fingerprint。 */
  function observedFingerprint(wire: Wire): string | undefined {
    if (wire.op !== 'message' || typeof wire.data?.data !== 'string') return undefined;
    try { return fingerprint(JSON.parse(wire.data.data)); } catch { return undefined; }
  }
  /** native対向nodeのJSON Stringを全field比較する。入力: message/期待値、出力: 一致。 */
  function sameTwist(wire: Wire, expected: Wire): boolean {
    return observedFingerprint(wire) === fingerprint(expected);
  }
  /** commandを1回送りROS API応答を確認する。入力: handle/lease/epoch/data、出力: 応答。 */
  async function command(connection: Connection, handle: string, lease: string, epoch: string, data: Wire): Promise<Wire> {
    const seq = String(++commandSequence);
    const requestId = id(connection);
    send(connection, 'ros.realtime.v1', { op: 'publish', id: requestId, handle, lease_id: lease, epoch, seq, data });
    return receive(connection, wire => (wire.op === 'published_to_ros' && wire.handle === handle && wire.seq === seq) || (wire.op === 'error' && wire.id === requestId), 'command_ack');
  }
  /** 新しいarmと入力から正常command対照を確認する。入力: connection/handle/stream、出力: lease ID。 */
  async function positiveCommand(connection: Connection, handle: string, observed: string): Promise<string> {
    const lease = await request(connection, 'arm', { handle }, 'lease');
    const expected = twist();
    const result = await command(connection, handle, lease.lease_id, connection.epoch, expected);
    check(result.op === 'published_to_ros', 'normal_command_rejected');
    await receive(connection, wire => wire.stream_id === observed && sameTwist(wire, expected), 'normal_command_observation');
    return lease.lease_id;
  }
  /** 負の試験前に前の正常sampleの飛行中messageを回収する。入力: stream、出力なし。 */
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
  /** 拒否後の観測windowで新規commandが届かないことを検証する。入力: stream、出力なし。 */
  async function observeNothing(connection: Connection, stream: string): Promise<void> {
    const untilTime = performance.now() + 400;
    while (performance.now() < untilTime) {
      check(!connection.messages.some(message => message.wire.stream_id === stream), 'rejected_command_observed');
      check(fatal === undefined, fatal ?? 'invalid_incoming_message');
      await tick();
    }
  }

  try {
    // 初回+再接続2回で、同じpageでもsession/epochを使い回さないことを確認する。
    for (let iteration = 0; iteration < 3; iteration++) {
      const connection = await connect();
      const output = await subscribe(connection, '/output');
      const observed = await subscribe(connection, '/observed');
      const publisher = await request(connection, 'advertise', { topic: '/input' }, 'advertised');
      const commander = await request(connection, 'advertise', { topic: '/command' }, 'advertised');
      const marker = crypto.randomUUID();
      let echoed = false;
      let seq = 0;
      // rclpy対向nodeとのDDS matchingは固有markerの実echoで確認する。
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
      const previousLease = await positiveCommand(connection, commander.handle, observed);
      await settle(connection, observed);
      // browserとGatewayのclock原点を比較せず、250ms lease受領後400ms以上待つ。
      const expireAt = performance.now() + 400;
      await until(() => performance.now() >= expireAt, 'lease_expiry_wait', 1000);
      const expiredPayload = twist();
      rejectedTwists.add(fingerprint(expiredPayload)!);
      const expired = await command(connection, commander.handle, previousLease, connection.epoch, expiredPayload);
      check(expired.op === 'error', 'expired_lease_accepted');
      await observeNothing(connection, observed);
      await positiveCommand(connection, commander.handle, observed);
      // 二度目以降は実際の前session epochを新しいhandleに付けて拒否を確認する。
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
      await request(connection, 'unadvertise', { handle: publisher.handle }, 'unadvertised');
      await request(connection, 'unadvertise', { handle: commander.handle }, 'unadvertised');
      check(fatal === undefined, fatal ?? 'invalid_incoming_message');
      connection.pc.close(); active.delete(connection.pc);
    }
    return { connectionMs, localCandidateTypes, reconnections: 2, assertions: {
      stringEcho: 'PASS', twistEcho: 'PASS', expiredLeaseRejected: 'PASS', expiredCommandNotObserved: 'PASS',
      oldEpochRejected: 'PASS', oldEpochCommandNotObserved: 'PASS', distinctEpochs: 'PASS', selectedCandidate: 'PASS',
    } };
  } catch (error) {
    // ブラウザAPIの生の例外は接続情報を含みうるため、既知の試験段階だけを返す。
    const known = new Set(['scenario_deadline', 'channel_not_open', 'invalid_incoming_message', 'peer_failed', 'ice_gathering',
      'missing_offer', 'offer_rejected', 'invalid_answer', 'channels_open', 'hello', 'welcome_rejected', 'catalog_mismatch',
      'reused_epoch', 'selected_pair_missing', 'candidate_type_missing', 'relay_required', 'invalid_subscribed', 'command_ack',
      'normal_command_rejected', 'normal_command_observation', 'observation_not_quiet', 'rejected_command_observed',
      'string_echo_timeout', 'string_publish_ack', 'string_publish_rejected', 'lease_expiry_wait', 'expired_lease_accepted', 'old_epoch_accepted']);
    for (const op of ['subscribe', 'advertise', 'arm', 'unsubscribe', 'unadvertise']) {
      known.add(`control_${op}`); known.add(`control_${op}_rejected`);
    }
    const message = error instanceof Error ? error.message : '';
    return { failure: known.has(message) ? message : 'browser_scenario_failed' };
  } finally { for (const pc of active) pc.close(); }
}
