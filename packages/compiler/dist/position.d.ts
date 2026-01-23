export interface Position {
    line: number;
    col: number;
}
/**
 * LineMap provides efficient byte offset to line:col conversion.
 * Build once per source file, then O(log n) lookups via binary search.
 */
export declare class LineMap {
    private source;
    private lineStarts;
    constructor(source: string);
    /**
     * Convert byte offset to 0-indexed line:col position.
     */
    offsetToPosition(offset: number): Position;
    /**
     * Format position as "line:col" string (0-indexed).
     */
    positionKey(offset: number): string;
    /**
     * Get span length in characters (for the "len" field in hints).
     * For ASCII, this equals byte length. For UTF-8 with multi-byte chars,
     * this returns the actual character count.
     */
    spanLength(start: number, end: number): number;
    /**
     * Convert 0-indexed line:col position back to byte offset.
     */
    positionToOffset(pos: Position): number;
    /**
     * Get the source text for a span.
     */
    getText(start: number, end: number): string;
    /**
     * Get total number of lines.
     */
    get lineCount(): number;
}
/**
 * Format position as "line:col" string.
 */
export declare function positionKey(pos: Position): string;
//# sourceMappingURL=position.d.ts.map