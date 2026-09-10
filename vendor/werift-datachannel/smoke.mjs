/** 2 peer の 3 DataChannel 実送受信を検証する。引数なし、成功時は検証済み channel 数を表示する。 */
import assert from 'node:assert/strict';
import { RTCPeerConnection } from './.runtime/lib/webrtc/src/index.js';

// localhost の host candidate だけで検証し、外部 STUN/TURN を必要としない。
const options = { iceServers: [], iceUseIpv6: false, iceAdditionalHostAddresses: ['127.0.0.1'] };
const sender = new RTCPeerConnection(options);
const receiver = new RTCPeerConnection(options);
const timeout = Number(process.env.TRANSPORT_SMOKE_TIMEOUT_MS ?? 20000);
assert(Number.isSafeInteger(timeout) && timeout > 0, 'Invalid TRANSPORT_SMOKE_TIMEOUT_MS');
// stdout 無出力の長期化を防ぎ、timeout 時は socket を終了処理で閉じる。
const heartbeat = setInterval(() => console.log('Waiting for local DataChannel exchange...'), 5000);
let deadline;
const expired = new Promise((_, reject) => {
  deadline = setTimeout(() => reject(new Error('DataChannel smoke timed out')), timeout);
});

/** 3 種類の channel を開いて往復する。引数なし、全 payload 一致時に resolve する。 */
async function exchange() {
  const received = new Set();
  const definitions = [['control', { ordered: true }], ['reliable', { ordered: true }],
    ['realtime', { ordered: false, maxRetransmits: 0 }],
    ['lifetime', { ordered: false, maxPacketLifeTime: 10000 }]];
  let fail;
  const errors = new Promise((_, reject) => { fail = reject; });
  // 相手側でも配送設定を照合し、受信 payload をそのまま返す。
  receiver.onDataChannel.subscribe((channel) => {
    try {
      channel.onMessage.subscribe((message) => channel.send(message));
      assert.equal(channel.ordered, !['realtime', 'lifetime'].includes(channel.label));
      assert.equal(channel.maxRetransmits, channel.label === 'realtime' ? 0 : null);
      assert.equal(channel.maxPacketLifeTime, channel.label === 'lifetime' ? 10000 : null);
    } catch (error) { fail(error); }
  });
  const deliveries = definitions.map(([label, parameters]) => {
    const channel = sender.createDataChannel(label, parameters);
    const payload = `${label}:` + 'x'.repeat(16384 - label.length - 1);
    // 16 KiB payload の往復と DCEP open を待ち、イベント時の例外も Promise へ伝播する。
    return new Promise((resolve, reject) => {
      channel.onMessage.subscribe((message) => {
        try { assert.equal(message, payload); received.add(label); resolve(); }
        catch (error) { reject(error); }
      });
      channel.stateChange.subscribe((state) => {
        if (state === 'open') channel.send(payload);
      });
    });
  });
  // non-trickle offer/answer を交換し、DTLS/SCTP の実接続を成立させる。
  await sender.setLocalDescription(await sender.createOffer());
  await receiver.setRemoteDescription(sender.localDescription);
  await receiver.setLocalDescription(await receiver.createAnswer());
  await sender.setRemoteDescription(receiver.localDescription);
  await Promise.race([Promise.all(deliveries), errors]);
  assert.equal(received.size, definitions.length);
  console.log(`Verified ${received.size} DataChannels with 16 KiB round trips`);
}

try {
  console.log('Starting local Werift core smoke');
  await Promise.race([exchange(), expired]);
} finally {
  // 成否に関係なく timer と peer を破棄し、検証 process を残さない。
  clearTimeout(deadline);
  clearInterval(heartbeat);
  await Promise.all([sender.close(), receiver.close()]);
}
