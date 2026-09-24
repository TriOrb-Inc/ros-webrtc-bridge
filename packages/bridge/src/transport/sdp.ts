/**
 * Bounded SDP inspection for offers. The transport needs three facts before it creates any state:
 * the peer's DataChannel message limit, how many receive-only video slots were offered, and whether
 * every one of them can carry the H.264 profile this bridge sends. Anything else is rejected.
 */
export interface OfferShape {
  /** Peer's advertised receive maximum. Zero means unlimited; undefined means the attribute was absent. */
  readonly maxMessageBytes: number | undefined;
  /** One entry per accepted `m=video` section, in m-line order. Empty for DataChannel-only offers. */
  readonly video: readonly OfferedVideo[];
}

/** A receive-only H.264 slot the browser offered, reduced to what the answer has to agree with. */
export interface OfferedVideo {
  readonly payloadType: number;
  readonly profileLevelId: string;
}

// An offer is attacker-controlled input bounded only by maxSdpBytes, which still allows a document
// made of many tiny lines. Cap the structure separately so parsing cost stays proportional.
const MAX_LINES = 2048;

/**
 * Split an SDP document into its session part and media sections.
 * @param sdp Complete offer text, e.g. `"v=0\r\nm=application 9 ...\r\na=sctp-port:5000"`.
 * @returns Session lines plus one entry per `m=` section, e.g. `{session:['v=0'], sections:[['m=application ...']]}`.
 */
function split(sdp: string): { session: string[]; sections: string[][] } {
  const lines = sdp.split(/\r?\n/);
  if (lines.length > MAX_LINES) throw new Error('invalid_offer');
  const session: string[] = [];
  const sections: string[][] = [];
  for (const line of lines) {
    if (line.startsWith('m=')) sections.push([line]);
    else (sections[sections.length - 1] ?? session).push(line);
  }
  return { session, sections };
}

/**
 * Find the payload type that can carry the H.264 profile this bridge produces.
 * @param lines One media section's lines, e.g. `['m=video 9 UDP/TLS/RTP/SAVPF 96','a=rtpmap:96 H264/90000',...]`.
 * @returns The negotiated slot, e.g. `{payloadType:96, profileLevelId:'42e01f'}`.
 */
function videoSlot(lines: readonly string[]): OfferedVideo {
  // Direction is mandatory here: an offer that omits it means sendrecv, and this bridge never
  // receives video. Treating an absent attribute as "probably recvonly" would accept the wrong thing.
  if (!lines.includes('a=recvonly')) throw new Error('invalid_video_section');
  // Simulcast and RID change how many encodings a single slot carries; that is a separate feature.
  if (lines.some(line => line.startsWith('a=simulcast:') || line.startsWith('a=rid:'))) throw new Error('invalid_video_section');
  // Only the first H.264 payload is considered, and it has to be one this bridge can serve.
  //
  // Picking a later payload would be a trap: the sender stamps packets with the first codec that
  // survives negotiation, so an offer listing an unusable H.264 payload first would validate here
  // and then go out with a payload type the browser never agreed to. That failure is invisible from
  // this side - the peer counts packets and decodes none of them - so it is refused instead.
  for (const line of lines) {
    const rtpmap = /^a=rtpmap:(\d+) H264\/90000$/.exec(line);
    if (rtpmap === null) continue;
    const payloadType = Number(rtpmap[1]);
    const fmtp = lines.find(candidate => candidate.startsWith(`a=fmtp:${payloadType} `));
    // packetization-mode=1 is required: the payloader emits fragmented NAL units, which mode 0 forbids.
    if (fmtp === undefined || !fmtp.includes('packetization-mode=1')) break;
    const profile = /profile-level-id=([0-9A-Fa-f]{6})/.exec(fmtp);
    if (profile === null) break;
    return Object.freeze({ payloadType, profileLevelId: profile[1].toLowerCase() });
  }
  throw new Error('unsupported_video_codec');
}

/**
 * Validate an offer and reduce it to the facts the transport acts on.
 * @param sdp Complete offer text.
 * @param maxVideo Video slots this deployment accepts; zero keeps the endpoint DataChannel-only.
 * @returns The accepted shape. Every rejection uses a fixed internal name that is never sent to peers.
 */
export function parseOffer(sdp: string, maxVideo: number): OfferShape {
  const { session, sections } = split(sdp);
  const application = sections.filter(lines => /^m=application \S+ \S*DTLS\/SCTP\S* webrtc-datachannel$/.test(lines[0]));
  if (application.length !== 1) throw new Error('datachannel_only');
  const video = sections.filter(lines => lines[0].startsWith('m=video '));
  // Anything that is neither the DataChannel section nor a video slot - audio above all - is refused
  // rather than answered with a rejected port, so the peer sees one unambiguous failure.
  if (application.length + video.length !== sections.length) throw new Error('datachannel_only');
  if (video.length > maxVideo) throw new Error(maxVideo === 0 ? 'datachannel_only' : 'video_slot_limit');
  // Read the SCTP limit outside the video sections so an attribute smuggled into a media section
  // cannot widen or narrow the DataChannel contract.
  const limits = [...session, ...application[0]].filter(line => /^a=max-message-size:\d+$/.test(line));
  if (limits.length > 1) throw new Error('invalid_message_limit');
  const advertised = limits.length === 0 ? undefined : Number(limits[0].slice('a=max-message-size:'.length));
  if (advertised !== undefined && !Number.isSafeInteger(advertised)) throw new Error('invalid_message_limit');
  return Object.freeze({ maxMessageBytes: advertised, video: Object.freeze(video.map(videoSlot)) });
}
