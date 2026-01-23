// Parser wrapper for Encantis
// Provides a clean API for parsing source code to AST
import { grammar, semantics } from './grammar/actions';
// Re-export all AST types for consumers
export * from './ast';
/**
 * Parse Encantis source code into an AST.
 *
 * @param source - The source code to parse
 * @param options - Optional configuration (filePath for error messages)
 * @returns ParseResult with module (if successful) and any errors
 */
export function parse(source, options = {}) {
    const { filePath, startRule } = options;
    const matchResult = grammar.match(source, startRule);
    if (matchResult.failed()) {
        // Extract error information from Ohm's match result
        const error = extractError(matchResult, source, filePath);
        return {
            module: null,
            errors: [error],
        };
    }
    // Parse successful - convert to AST
    try {
        const module = semantics(matchResult).toAST();
        return {
            module,
            errors: [],
        };
    }
    catch (e) {
        // Semantic action error (shouldn't happen with correct grammar)
        return {
            module: null,
            errors: [
                {
                    message: `Internal parser error: ${e instanceof Error ? e.message : String(e)}`,
                    shortMessage: 'Internal error',
                    span: { start: 0, end: 0 },
                    expected: [],
                },
            ],
        };
    }
}
/**
 * Extract error information from a failed Ohm match result.
 */
function extractError(matchResult, _source, _filePath) {
    const pos = matchResult.getRightmostFailurePosition();
    const expected = matchResult
        .getExpectedText()
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    return {
        message: matchResult.message,
        shortMessage: matchResult.shortMessage,
        span: { start: pos, end: pos + 1 },
        expected,
    };
}
//# sourceMappingURL=parser.js.map