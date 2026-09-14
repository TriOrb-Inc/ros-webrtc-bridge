export declare class Red {
    header: RedHeader;
    blocks: {
        block: Buffer;
        blockPT: number;
        /**14bit */
        timestampOffset?: number;
    }[];
    static deSerialize(bufferOrArrayBuffer: Buffer | ArrayBuffer): Red;
    serialize(): Buffer<ArrayBuffer>;
}
export declare class RedHeader {
    fields: RedHeaderField[];
    static deSerialize(buf: Buffer): readonly [RedHeader, number];
    serialize(): Buffer<ArrayBuffer>;
}
interface RedHeaderField {
    /**The first header bit indicates whether another header block follows: 1 means another block follows; 0 marks the last header block. */
    fBit: number;
    blockPT: number;
    /**14bit */
    timestampOffset?: number;
    /**10bit */
    blockLength?: number;
}
export {};
