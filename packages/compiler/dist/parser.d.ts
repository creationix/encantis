import type { Module, Span } from './ast';
export * from './ast';
export interface ParseOptions {
    filePath?: string;
    startRule?: string;
}
export interface ParseError {
    message: string;
    shortMessage: string;
    span: Span;
    expected: string[];
}
export interface ParseResult {
    module: Module | null;
    errors: ParseError[];
}
/**
 * Parse Encantis source code into an AST.
 *
 * @param source - The source code to parse
 * @param options - Optional configuration (filePath for error messages)
 * @returns ParseResult with module (if successful) and any errors
 */
export declare function parse(source: string, options?: ParseOptions): ParseResult;
//# sourceMappingURL=parser.d.ts.map