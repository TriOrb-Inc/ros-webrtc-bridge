import type { RTCRtpTransceiver } from "./media";
import type { MediaDirection } from "./media/rtpTransceiver";
import { type BundlePolicy, GroupDescription, MediaDescription, SessionDescription } from "./sdp";
import type { RTCDtlsTransport } from "./transport/dtls";
import type { RTCSctpTransport } from "./transport/sctp";
export declare class SDPManager {
    currentLocalDescription?: SessionDescription;
    currentRemoteDescription?: SessionDescription;
    pendingLocalDescription?: SessionDescription;
    pendingRemoteDescription?: SessionDescription;
    readonly cname: string;
    readonly midSuffix: boolean;
    readonly bundlePolicy?: BundlePolicy;
    private seenMid;
    constructor({ cname, midSuffix, bundlePolicy, }: {
        cname: string;
        midSuffix?: boolean;
        bundlePolicy?: BundlePolicy;
    });
    get localDescription(): import("./sdp").RTCSessionDescription | undefined;
    get remoteDescription(): import("./sdp").RTCSessionDescription | undefined;
    /**@private */
    get _localDescription(): SessionDescription | undefined;
    /**@private */
    get _remoteDescription(): SessionDescription | undefined;
    get inactiveRemoteMedia(): MediaDescription | undefined;
    /**
     * Create a MediaDescription for the transceiver.
     */
    createMediaDescriptionForTransceiver(transceiver: RTCRtpTransceiver, direction: MediaDirection): MediaDescription;
    /**
     * Create a MediaDescription for SCTP.
     */
    createMediaDescriptionForSctp(sctp: RTCSctpTransport): MediaDescription;
    /**
     * Add transport information to the MediaDescription.
     */
    addTransportDescription(media: MediaDescription, dtlsTransport: RTCDtlsTransport): void;
    /**
     * Assign a unique MID.
     */
    allocateMid(type?: "dc" | "av" | ""): string;
    parseSdp({ sdp, isLocal, signalingState, type, }: {
        sdp: string;
        isLocal: boolean;
        signalingState: string;
        type: "offer" | "answer" | "pranswer";
    }): SessionDescription;
    private validateDescription;
    /**
     * Build the offer SDP.
     */
    buildOfferSdp(transceivers: RTCRtpTransceiver[], sctpTransport: RTCSctpTransport | undefined): SessionDescription;
    /**
     * Build the answer SDP.
     */
    buildAnswerSdp({ transceivers, sctpTransport, signalingState, }: {
        transceivers: RTCRtpTransceiver[];
        sctpTransport: RTCSctpTransport | undefined;
        signalingState: string;
    }): SessionDescription;
    setLocalDescription(description: SessionDescription): void;
    setRemoteDescription(sessionDescription: RTCSessionDescriptionInit, signalingState: string): SessionDescription | undefined;
    rollbackLocalDescription(signalingState: string): void;
    registerMid(mid: string): void;
    get remoteIsBundled(): GroupDescription | undefined;
    /**
     * Set the local session description and add transport information.
     */
    setLocal(description: SessionDescription, transceivers: RTCRtpTransceiver[], sctpTransport?: {
        dtlsTransport: RTCDtlsTransport;
        mid?: string;
    }): void;
}
export interface RTCSessionDescriptionInit {
    sdp?: string;
    type?: RTCSdpType;
}
export type RTCSdpType = "answer" | "offer" | "pranswer" | "rollback";
