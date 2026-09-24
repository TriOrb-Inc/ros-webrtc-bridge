import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOffer } from '../../../packages/bridge/src/transport/sdp.js';

const APPLICATION = ['m=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=sctp-port:5000'];
const sdp = (...lines: readonly string[][]): string => [['v=0', 'o=- 0 0 IN IP4 127.0.0.1'], ...lines].flat().join('\r\n');

test('ATTACK: a packetization mode that only looks like mode 1', () => {
  // `.includes('packetization-mode=1')` is a substring test, and both of these contain it.
  for (const fmtp of ['packetization-mode=10;profile-level-id=42e01f',
    'profile-level-id=42e01f;x-packetization-mode=1']) {
    const section = ['m=video 9 UDP/TLS/RTP/SAVPF 96', 'a=recvonly',
      'a=rtpmap:96 H264/90000', `a=fmtp:96 ${fmtp}`];
    assert.throws(() => parseOffer(sdp(APPLICATION, section), 1), new Error('unsupported_video_codec'),
      `accepted "${fmtp}" as packetization mode 1`);
  }
});

test('ATTACK: a payload type outside the range RTP can carry', () => {
  // RTP carries the payload type in seven bits. Anything above 127 cannot be put on the wire, so
  // answering with it would produce a stream the peer can never match.
  for (const pt of ['128', '200', '99999999999999999999']) {
    const section = [`m=video 9 UDP/TLS/RTP/SAVPF ${pt}`, 'a=recvonly',
      `a=rtpmap:${pt} H264/90000`, `a=fmtp:${pt} packetization-mode=1;profile-level-id=42e01f`];
    assert.throws(() => parseOffer(sdp(APPLICATION, section), 1), new Error('unsupported_video_codec'),
      `accepted payload type ${pt}`);
  }
});

test('ATTACK: an offer sized to make the parser backtrack', () => {
  // The single-threaded event loop is every peer's, so parsing cost has to stay proportional to the
  // offer rather than to its shape. A quadratic pattern here froze the whole bridge for seconds.
  const line = `m=application 9 ${'DTLS/SCTP'.repeat(28_000)}`;
  const started = process.hrtime.bigint();
  assert.throws(() => parseOffer(sdp([line, 'a=sctp-port:5000']), 0), new Error('datachannel_only'));
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 250, `parsing a 250 KiB m-line took ${ms.toFixed(0)} ms`);
});

test('ATTACK: a video section declaring an empty mid', () => {
  // werift takes the peer's mid, so an empty one produces a slot the peer can never name in
  // video.unsubscribe - pinning its encoder and its share of the pipeline bound until it disconnects.
  const section = ['m=video 9 UDP/TLS/RTP/SAVPF 96', 'a=recvonly', 'a=mid:',
    'a=rtpmap:96 H264/90000', 'a=fmtp:96 packetization-mode=1;profile-level-id=42e01f'];
  assert.throws(() => parseOffer(sdp(APPLICATION, section), 1), new Error('invalid_video_section'));
  // A named section is unaffected.
  const named = [...section.slice(0, 2), 'a=mid:1', ...section.slice(3)];
  assert.equal(parseOffer(sdp(APPLICATION, named), 1).video.length, 1);
});

test('ATTACK: an offer whose line endings only this side understands', () => {
  // werift splits on CRLF alone. Tokenizing more leniently here would validate sections it never
  // negotiates, and every slot created for one is a transceiver with no mid and no codec.
  const lines = ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'a=sctp-port:5000', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=recvonly', 'a=rtpmap:96 H264/90000',
    'a=fmtp:96 packetization-mode=1;profile-level-id=42e01f'];
  assert.equal(parseOffer(lines.join('\r\n'), 1).video.length, 1, 'CRLF is the wire format and is accepted');
  assert.throws(() => parseOffer(lines.join('\n'), 1), new Error('datachannel_only'));
});
