export interface Comment {
    text: string;
    line: number;
    col: number;
    endLine: number;
    endCol: number;
    kind: 'line' | 'block';
}
/**
 * Extract all comments from source code.
 * Returns comments with 0-indexed line/col positions (LSP-compatible).
 */
export declare function extractComments(source: string): Comment[];
/**
 * Find doc comments for a declaration at the given position.
 * A doc comment is a comment that immediately precedes a declaration
 * (on the previous line(s) with no blank lines between).
 *
 * @param comments All comments in the source
 * @param declLine Declaration line (0-indexed)
 * @returns Doc comment text (lines joined) or null if none
 */
export declare function findDocComment(comments: Comment[], declLine: number): string | null;
//# sourceMappingURL=comments.d.ts.map