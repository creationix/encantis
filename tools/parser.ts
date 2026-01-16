// Parser wrapper for Encantis
// Provides a clean API for parsing source code to AST

import { grammar, semantics } from './grammar/actions';
import type { Module, Span } from './ast';

// Re-export all AST types for consumers
export * from './ast';

export interface ParseOptions {
  filePath?: string;
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
export function parse(source: string, options: ParseOptions = {}): ParseResult {
  const { filePath } = options;

  const matchResult = grammar.match(source);

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
    const module = semantics(matchResult).toAST(filePath) as Module;
    return {
      module,
      errors: [],
    };
  } catch (e) {
    // Semantic action error (shouldn't happen with correct grammar)
    return {
      module: null,
      errors: [{
        message: `Internal parser error: ${e instanceof Error ? e.message : String(e)}`,
        shortMessage: 'Internal error',
        span: {
          start: { offset: 0, line: 1, column: 1 },
          end: { offset: 0, line: 1, column: 1 },
          source: filePath,
        },
        expected: [],
      }],
    };
  }
}

/**
 * Extract error information from a failed Ohm match result.
 */
function extractError(matchResult: ohm.MatchResult, source: string, filePath?: string): ParseError {
  // Get position information
  const pos = matchResult.getRightmostFailurePosition();
  const { lineNum, colNum } = getLineAndColumn(source, pos);

  // Get expected tokens
  const expected = matchResult.getExpectedText().split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  return {
    message: matchResult.message ?? 'Parse error',
    shortMessage: matchResult.shortMessage ?? 'Parse error',
    span: {
      start: { offset: pos, line: lineNum, column: colNum },
      end: { offset: pos + 1, line: lineNum, column: colNum + 1 },
      source: filePath,
    },
    expected,
  };
}

/**
 * Get line and column number from an offset in source.
 */
function getLineAndColumn(source: string, offset: number): { lineNum: number; colNum: number } {
  let lineNum = 1;
  let colNum = 1;

  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') {
      lineNum++;
      colNum = 1;
    } else {
      colNum++;
    }
  }

  return { lineNum, colNum };
}

// Import ohm types for type checking
import type * as ohm from 'ohm-js';
