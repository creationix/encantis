/** Convert bytes to hex string (lowercase, no prefix) */
export declare function bytesToHex(bytes: Uint8Array): string;
/** Convert hex string to bytes */
export declare function hexToBytes(hex: string): Uint8Array;
/** Concatenate multiple byte arrays */
export declare function concatBytes(parts: Uint8Array[]): Uint8Array;
/** Encode unsigned integer as LEB128 */
export declare function encodeLEB128(value: number): Uint8Array;
/** Decode unsigned LEB128 to number */
export declare function decodeLEB128(bytes: Uint8Array, offset?: number): {
    value: number;
    bytesRead: number;
};
/** Serialize integer to little-endian bytes */
export declare function serializeInt(value: bigint, typeName: string): Uint8Array | null;
/** Fast i32 serialization (common for pointers) */
export declare function serializeI32(value: number): Uint8Array;
/** Serialize float to little-endian bytes */
export declare function serializeFloat(value: number, typeName: string): Uint8Array | null;
/** Fast f64 serialization (common for floats) */
export declare function serializeF64(value: number): Uint8Array;
/** JSON replacer that converts BigInt to string */
export declare function bigintReplacer(_key: string, value: unknown): unknown;
//# sourceMappingURL=utils.d.ts.map