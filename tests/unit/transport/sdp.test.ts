import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOffer } from '../../../packages/bridge/src/transport/sdp.js';

const APPLICATION = ['m=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=sctp-port:5000'];
const VIDEO = ['m=video 9 UDP/TLS/RTP/SAVPF 96', 'a=recvonly', 'a=rtpmap:96 H264/90000', 'a=fmtp:96 packetization-mode=1;profile-level-id=42E01F'];

/** Join SDP lines with CRLF as browsers do. @param lines Sections to concatenate @returns SDP text */
function sdp(...lines: readonly string[][]): string {
  return [['v=0', 'o=- 0 0 IN IP4 127.0.0.1'], ...lines].flat().join('\r\n');
}

/** Assert a fixed internal rejection. @param text Offer @param slots Accepted video slots @param reason Expected name @returns void */
function rejects(text: string, slots: number, reason: string): void {
  assert.throws(() => parseOffer(text, slots), new Error(reason));
}

test('reduces a DataChannel-only offer to its message limit', () => {
  assert.deepEqual(parseOffer(sdp(APPLICATION), 0), { maxMessageBytes: undefined, video: [] });
  assert.equal(parseOffer(sdp([...APPLICATION, 'a=max-message-size:262144']), 0).maxMessageBytes, 262144);
  // Zero is the SDP encoding for "no limit" and must survive as zero rather than becoming absent.
  assert.equal(parseOffer(sdp([...APPLICATION, 'a=max-message-size:0']), 0).maxMessageBytes, 0);
});

test('rejects an ambiguous or unusable message limit', () => {
  rejects(sdp([...APPLICATION, 'a=max-message-size:1', 'a=max-message-size:2']), 0, 'invalid_message_limit');
  rejects(sdp([...APPLICATION, 'a=max-message-size:999999999999999999999999']), 0, 'invalid_message_limit');
});

test('reads the message limit outside video sections only', () => {
  // An attribute smuggled into a media section must not change the DataChannel contract.
  const offer = sdp([...APPLICATION, 'a=max-message-size:1024'], [...VIDEO, 'a=max-message-size:16']);
  assert.equal(parseOffer(offer, 1).maxMessageBytes, 1024);
});

test('requires exactly one DataChannel section', () => {
  rejects('', 0, 'datachannel_only');
  rejects(sdp(), 0, 'datachannel_only');
  rejects(sdp(APPLICATION, APPLICATION), 0, 'datachannel_only');
  rejects(sdp(['m=application 9 UDP/DTLS/SCTP something-else']), 0, 'datachannel_only');
});

test('refuses media types this bridge does not serve', () => {
  rejects(sdp(APPLICATION, ['m=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=recvonly']), 1, 'datachannel_only');
});

test('keeps a deployment without video sections DataChannel-only', () => {
  // With no media plane the offer is refused outright rather than answered with a rejected port.
  rejects(sdp(APPLICATION, VIDEO), 0, 'datachannel_only');
  rejects(sdp(APPLICATION, VIDEO, VIDEO), 1, 'video_slot_limit');
});

test('accepts receive-only H.264 slots in m-line order', () => {
  const second = ['m=video 9 UDP/TLS/RTP/SAVPF 98', 'a=recvonly', 'a=rtpmap:98 H264/90000', 'a=fmtp:98 packetization-mode=1;profile-level-id=640c1f'];
  const shape = parseOffer(sdp(APPLICATION, VIDEO, second), 2);
  assert.deepEqual(shape.video, [{ payloadType: 96, profileLevelId: '42e01f' }, { payloadType: 98, profileLevelId: '640c1f' }]);
  assert.ok(Object.isFrozen(shape.video) && Object.isFrozen(shape.video[0]));
});

test('requires an explicit receive-only direction', () => {
  for (const direction of [[], ['a=sendrecv'], ['a=sendonly'], ['a=inactive']]) {
    rejects(sdp(APPLICATION, [VIDEO[0], ...direction, ...VIDEO.slice(2)]), 1, 'invalid_video_section');
  }
});

test('refuses slots carrying more than one encoding', () => {
  rejects(sdp(APPLICATION, [...VIDEO, 'a=simulcast:recv 1;2']), 1, 'invalid_video_section');
  rejects(sdp(APPLICATION, [...VIDEO, 'a=rid:1 recv']), 1, 'invalid_video_section');
});

test('requires an H.264 payload type this bridge can actually fill', () => {
  const head = ['m=video 9 UDP/TLS/RTP/SAVPF 96', 'a=recvonly'];
  // No H.264 at all.
  rejects(sdp(APPLICATION, [...head, 'a=rtpmap:96 VP8/90000']), 1, 'unsupported_video_codec');
  // H.264 without format parameters: packetization mode is then unknown, not assumed.
  rejects(sdp(APPLICATION, [...head, 'a=rtpmap:96 H264/90000']), 1, 'unsupported_video_codec');
  // Single NAL mode cannot carry the fragmented units the payloader emits.
  rejects(sdp(APPLICATION, [...head, 'a=rtpmap:96 H264/90000', 'a=fmtp:96 packetization-mode=0;profile-level-id=42e01f']), 1, 'unsupported_video_codec');
  // Right mode, but no profile to answer with.
  rejects(sdp(APPLICATION, [...head, 'a=rtpmap:96 H264/90000', 'a=fmtp:96 packetization-mode=1']), 1, 'unsupported_video_codec');
});

test('takes the first H.264 payload and refuses an offer that leads with an unusable one', () => {
  const usable = ['m=video 9 UDP/TLS/RTP/SAVPF 98 96', 'a=recvonly',
    'a=rtpmap:98 H264/90000', 'a=fmtp:98 packetization-mode=1;profile-level-id=42e01f',
    'a=rtpmap:96 H264/90000', 'a=fmtp:96 packetization-mode=0;profile-level-id=42e01f'];
  assert.deepEqual(parseOffer(sdp(APPLICATION, usable), 1).video, [{ payloadType: 98, profileLevelId: '42e01f' }]);

  // Reaching past a leading mode-0 payload would validate an offer this bridge then answers with a
  // payload type the peer never agreed to: the sender stamps packets with the first negotiated
  // codec, not the one chosen here, and the browser counts packets it cannot decode.
  const leadsUnusable = ['m=video 9 UDP/TLS/RTP/SAVPF 96 98', 'a=recvonly',
    'a=rtpmap:96 H264/90000', 'a=fmtp:96 packetization-mode=0;profile-level-id=42e01f',
    'a=rtpmap:98 H264/90000', 'a=fmtp:98 packetization-mode=1;profile-level-id=42e01f'];
  rejects(sdp(APPLICATION, leadsUnusable), 1, 'unsupported_video_codec');

  // The same applies when the leading payload simply has no profile to answer with.
  const leadsProfileless = ['m=video 9 UDP/TLS/RTP/SAVPF 96 98', 'a=recvonly',
    'a=rtpmap:96 H264/90000', 'a=fmtp:96 packetization-mode=1',
    'a=rtpmap:98 H264/90000', 'a=fmtp:98 packetization-mode=1;profile-level-id=42e01f'];
  rejects(sdp(APPLICATION, leadsProfileless), 1, 'unsupported_video_codec');
});

test('bounds the document structure independently of its byte size', () => {
  rejects(['v=0', ...Array.from({ length: 2048 }, () => 'a=x')].join('\r\n'), 0, 'invalid_offer');
});
