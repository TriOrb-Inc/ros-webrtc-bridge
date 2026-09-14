/** Verify DataChannel traffic between two peers. No arguments; report the verified channel count on success. */
import assert from 'node:assert/strict';
import { RTCPeerConnection } from './.runtime/lib/webrtc/src/index.js';

// Use local host candidates only; no external STUN/TURN service is required.
const options = { iceServers: [], iceUseIpv6: false, iceAdditionalHostAddresses: ['127.0.0.1'] };
const sender = new RTCPeerConnection(options);
const receiver = new RTCPeerConnection(options);
const timeout = Number(process.env.TRANSPORT_SMOKE_TIMEOUT_MS ?? 20000);
assert(Number.isSafeInteger(timeout) && timeout > 0, 'Invalid TRANSPORT_SMOKE_TIMEOUT_MS');
// Report progress during waits and close sockets during timeout cleanup.
const heartbeat = setInterval(() => console.log('Waiting for local DataChannel exchange...'), 5000);
let deadline;
const expired = new Promise((_, reject) => {
  deadline = setTimeout(() => reject(new Error('DataChannel smoke timed out')), timeout);
});

/** Open channels and exchange payloads. No arguments; resolve when every payload matches. */
async function exchange() {
  const received = new Set();
  const definitions = [['control', { ordered: true }], ['reliable', { ordered: true }],
    ['realtime', { ordered: false, maxRetransmits: 0 }],
    ['lifetime', { ordered: false, maxPacketLifeTime: 10000 }]];
  let fail;
  const errors = new Promise((_, reject) => { fail = reject; });
  // Verify delivery settings on the peer and echo each received payload unchanged.
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
    // Wait for DCEP opening and 16 KiB round trips; propagate event errors to the promise.
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
  // Exchange a non-trickle offer/answer and establish the DTLS/SCTP connection.
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
  // Dispose of timers and peers on success or failure so the probe process can exit.
  clearTimeout(deadline);
  clearInterval(heartbeat);
  await Promise.all([sender.close(), receiver.close()]);
}
