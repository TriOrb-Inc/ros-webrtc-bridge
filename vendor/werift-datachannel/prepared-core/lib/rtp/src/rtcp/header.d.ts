export declare const RTCP_HEADER_SIZE = 4;
export declare class RtcpHeader {
    version: number;
    padding: boolean;
    count: number;
    type: number;
    /**The packet length in 32-bit words, including the header and any padding, minus one. */
    length: number;
    constructor(props?: Partial<RtcpHeader>);
    static serialize(type: number, count: number, payload: Buffer, length: number): Buffer<ArrayBuffer>;
    serialize(): Buffer<ArrayBuffer>;
    static deSerialize(buf: Buffer): RtcpHeader;
}
