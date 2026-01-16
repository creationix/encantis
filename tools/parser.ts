// Parser wrapper for Encantis
// Provides a clean API for parsing source code to AST

import type * as ohm from 'ohm-js'
import type { Module, Span } from './ast'
import { grammar, semantics } from './grammar/actions'

// Re-export all AST types for consumers
export * from './ast'

export interface ParseOptions {
  filePath?: string
}

export interface ParseError {
  message: string
  shortMessage: string
  span: Span
  expected: string[]
}

export interface ParseResult {
  module: Module | null
  errors: ParseError[]
}

/**
 * Parse Encantis source code into an AST.
 *
 * @param source - The source code to parse
 * @param options - Optional configuration (filePath for error messages)
 * @returns ParseResult with module (if successful) and any errors
 */
export function parse(source: string, options: ParseOptions = {}): ParseResult {
  const { filePath } = options

  const matchResult = grammar.match(source)

  if (matchResult.failed()) {
    // Extract error information from Ohm's match result
    const error = extractError(matchResult, source, filePath)
    return {
      module: null,
      errors: [error],
    }
  }

  // Parse successful - convert to AST
  try {
    const module = semantics(matchResult).toAST() as Module
    return {
      module,
      errors: [],
    }
  } catch (e) {
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
    }
  }
}

/**
 * Extract error information from a failed Ohm match result.
 */
function extractError(
  matchResult: ohm.FailedMatchResult,
  _source: string,
  _filePath?: string,
): ParseError {
  const pos = matchResult.getRightmostFailurePosition()
  const expected = matchResult
    .getExpectedText()
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  return {
    message: matchResult.message,
    shortMessage: matchResult.shortMessage,
    span: { start: pos, end: pos + 1 },
    expected,
  }
}
