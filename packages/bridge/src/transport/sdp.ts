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
  // Exactly how werift tokenizes it (`sdp.split("\r\n")`), because this is the validator and that is
  // the negotiator: accepting bare newlines here would describe sections werift never sees, and the
  // slots created for them would be transceivers with no mid and no codec that answer nobody.
  const lines = sdp.split('\r\n');
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
  // An empty mid negotiates a slot the peer can never name again, so it could never unsubscribe the
  // track bound to it: the encoder and its share of the pipeline bound would be pinned for the
  // life of the connection.
  if (lines.some(line => /^a=mid:\s*$/.test(line))) throw new Error('invalid_video_section');
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
    // RTP carries the payload type in seven bits. Anything larger cannot go on the wire, so
    // answering with it would describe a stream the peer could never match. Browsers use the whole
    // range rather than only 96-127: a real Chromium offer carries H.264 on 39, 41 and 43.
    if (payloadType > 127) break;
    const fmtp = lines.find(candidate => candidate.startsWith(`a=fmtp:${payloadType} `));
    if (fmtp === undefined) break;
    // Compare whole parameters, not substrings. `packetization-mode=10` and a vendor parameter
    // ending in `packetization-mode=1` both contain the text and neither one means mode 1.
    const parameters = fmtp.slice(`a=fmtp:${payloadType} `.length).split(';').map(parameter => parameter.trim());
    // packetization-mode=1 is required: the payloader emits fragmented NAL units, which mode 0 forbids.
    if (!parameters.includes('packetization-mode=1')) break;
    const profile = parameters.find(parameter => /^profile-level-id=[0-9A-Fa-f]{6}$/.test(parameter));
    if (profile === undefined) break;
    return Object.freeze({ payloadType, profileLevelId: profile.slice('profile-level-id='.length).toLowerCase() });
  }
  throw new Error('unsupported_video_codec');
}

/**
 * Recognise the DataChannel media section.
 * @param line One `m=` line, e.g. `m=application 9 UDP/DTLS/SCTP webrtc-datachannel`.
 * @returns Whether it is the SCTP DataChannel section this bridge serves.
 *
 * Split into fields rather than matched with a pattern. The obvious pattern needs two unbounded
 * runs of non-space either side of a literal, which backtracks quadratically: an offer within the
 * documented size limit, made of one long m-line, held the event loop for seconds - and the loop is
 * single threaded, so that is every peer and every channel, not just the one that sent it.
 */
function datachannelSection(line: string): boolean {
  const fields = line.split(' ');
  return fields.length === 4 && fields[0] === 'm=application'
    && fields[2].includes('DTLS/SCTP') && fields[3] === 'webrtc-datachannel';
}

/**
 * Validate an offer and reduce it to the facts the transport acts on.
 * @param sdp Complete offer text.
 * @param maxVideo Video slots this deployment accepts; zero keeps the endpoint DataChannel-only.
 * @returns The accepted shape. Every rejection uses a fixed internal name that is never sent to peers.
 */
export function parseOffer(sdp: string, maxVideo: number): OfferShape {
  const { session, sections } = split(sdp);
  const application = sections.filter(lines => datachannelSection(lines[0]));
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
