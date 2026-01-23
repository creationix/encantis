import type * as AST from './ast';
import type { IndexedRT } from './types';
export interface DataEntry {
    bytes: Uint8Array;
    offset: number;
    length: number;
    explicit: boolean;
}
export interface DataSection {
    entries: DataEntry[];
    literalMap: Map<number, DataEntry>;
    totalSize: number;
    autoDataStart: number;
    errors: string[];
}
/**
 * Builder for constructing a WASM data section.
 *
 * Two-pass algorithm:
 * 1. Explicit data (from memory declarations) placed at specified offsets
 * 2. Auto data (interned literals) placed after explicit entries
 *
 * Deduplicates identical byte sequences using hex-encoded keys.
 * Also deduplicates by finding substrings within already-written data.
 */
export declare class DataSectionBuilder {
    private explicitEntries;
    private internedMap;
    private literalMap;
    /** Next available offset for placing new interned data */
    private currentOffset;
    setAutoDataStart(offset: number): void;
    build(module: AST.Module): void;
    result(): DataSection;
    private calculateAutoDataStart;
    private collectExplicitData;
    private collectMemoryData;
    private exprToBytes;
    private exprToBytesWithType;
    private getPrimitiveTypeName;
    private collectLiterals;
    private collectLiteralsFromExportable;
    private collectLiteralsFromFunc;
    private collectLiteralsFromBody;
    private collectLiteralsFromStmt;
    private collectLiteralsFromExpr;
    private internLiteral;
    internBytes(bytes: Uint8Array): DataRef;
    private getWrittenBytes;
    private findSubstring;
}
/**
 * Serialize a DataSection to a single byte array for embedding in WASM.
 * @param section The data section to serialize
 * @returns Byte array with all entries at their correct offsets
 */
export declare function serializeDataSection(section: DataSection): Uint8Array;
/**
 * Format a DataSection as WAT data segment declarations.
 * Each entry becomes: (data (i32.const OFFSET) "ESCAPED_BYTES")
 * Non-printable bytes are escaped as \xx hex.
 * @param section The data section to format
 * @returns Array of WAT data segment strings
 */
export declare function dataToWat(section: DataSection): string[];
export interface DataRef {
    ptr: number;
    len: number;
}
/**
 * Serialize a literal expression to bytes based on target type.
 * Handles both merged brackets (*[![!u8]] - single contiguous write) and
 * separate brackets (*[!*[!u8]] - depth-first with pointer arrays).
 * @param expr The literal expression (LiteralExpr or ArrayExpr)
 * @param targetType The indexed type to serialize as
 * @param builder The data section builder for interning
 * @returns DataRef with pointer offset and length for codegen
 */
export declare function serializeLiteral(expr: AST.Expr, targetType: IndexedRT, builder: DataSectionBuilder): DataRef;
export interface QualifiedLiteral {
    value: LiteralValue;
    type: IndexedRT;
    address?: number;
    id?: number | string;
}
export type LiteralValue = {
    kind: 'bytes';
    data: Uint8Array;
} | {
    kind: 'ints';
    data: bigint[];
} | {
    kind: 'floats';
    data: number[];
} | {
    kind: 'nested';
    elements: LiteralValue[];
};
export interface DataLayout {
    refs: Map<number | string, DataRef>;
    entries: DataEntry[];
    totalSize: number;
    errors: string[];
}
/**
 * Lay out a list of qualified literals into a data section.
 * Handles both explicit (user-specified address) and auto (interned) literals.
 *
 * Algorithm:
 * 1. Explicit literals placed at their specified addresses
 * 2. Check for overlapping explicit entries (reports errors)
 * 3. Auto literals interned after explicit entries end
 *
 * @param literals Array of qualified literals with types and optional addresses
 * @returns DataLayout with refs, entries, total size, and any errors
 */
export declare function layoutLiterals(literals: QualifiedLiteral[]): DataLayout;
export interface PendingLiteral {
    id: number;
    expr: AST.Expr;
    type: IndexedRT;
}
export interface DataSectionResult {
    dataBuilder: DataSectionBuilder;
    literalRefs: Map<number, DataRef>;
}
/**
 * Build the data section from pending literals collected during type checking.
 * Sorts literals by priority for better deduplication, then serializes each.
 */
export declare function buildDataSection(literals: PendingLiteral[]): DataSectionResult;
//# sourceMappingURL=data.d.ts.map