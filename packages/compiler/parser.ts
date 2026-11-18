// Parser wrapper for Encantis
// Provides a clean API for parsing source code to AST

import type * as ohm from 'ohm-js'
import type { Module, Span } from './ast'
import { LiteralError } from './encantis-actions'
import { grammar, semantics } from './encantis-grammar'

// Re-export all AST types for consumers
export * from './ast'

export interface ParseOptions {
  filePath?: string
  startRule?: string // Grammar rule to start parsing from (default: 'Module')
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
  const { filePath, startRule } = options

  // Blank out shebang line to preserve byte offsets
  if (source.startsWith('#!')) {
    const newline = source.indexOf('\n')
    source = newline >= 0 ? ' '.repeat(newline) + source.slice(newline) : ' '.repeat(source.length)
  }

  // The parser nests a call for each level, and the stack it has is not
  // without end: deeper than the limit is an error before it is parsed.
  const deep = tooDeep(source)
  if (deep !== null) return { module: null, errors: [nestingError(source, deep)] }

  let matchResult: ohm.MatchResult
  try {
    matchResult = grammar.match(source, startRule)
  } catch (e) {
    if (e instanceof RangeError) return { module: null, errors: [nestingError(source, null)] }
    throw e
  }

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
    if (e instanceof RangeError) return { module: null, errors: [nestingError(source, null)] }
    // A literal the grammar accepts but the language does not ('').
    if (e instanceof LiteralError) {
      const before = source.slice(0, e.span.start)
      const line = before.split('\n').length
      const col = e.span.start - before.lastIndexOf('\n')
      return {
        module: null,
        errors: [{ message: `Line ${line}, col ${col}: ${e.message}`, shortMessage: e.message, span: e.span, expected: [] }],
      }
    }
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

// How deep brackets and prefixes may nest: ((( and [[[, and also *[]?*u8 or
// - - x, which parse as deep as brackets do though nothing closes them.
export const MAX_NESTING = 256

function nestingError(source: string, offset: number | null): ParseError {
  const at = offset ?? 0
  const before = source.slice(0, at)
  const line = before.split('\n').length
  const col = at - (before.lastIndexOf('\n') + 1) + 1
  const what = offset === null ? 'nested too deeply to parse' : `nested more than ${MAX_NESTING} deep`
  return {
    message: `Line ${line}, col ${col}: ${what}: brackets, and prefixes such as -, * and [], nest ${MAX_NESTING} deep at most`,
    shortMessage: what,
    span: { start: at, end: at + 1 },
    expected: [],
  }
}

// Where the source first nests more than MAX_NESTING deep, if it does.
function tooDeep(source: string): number | null {
  const { over } = nesting(source, MAX_NESTING)
  return over
}

// How deep the source nests, as the parser nests calls: a level for each open
// bracket, and for each prefix before an operand that is still to come (`-`,
// `*`, `?`, `&`, `mut`, and `[]`, `[*]`, `[4]` where no value stands before
// it). A run of prefixes ends at its operand; one before a bracket lasts as
// long as the bracket does. `over` is where it first goes deeper than `limit`.
export function nesting(source: string, limit = Infinity): { deepest: number; over: number | null } {
  // For each open bracket: the levels outside it, and whether it is the ${ of
  // a template literal, whose } goes back to the template's text.
  const open: { levels: number; template: boolean }[] = []
  let levels = 0
  let run = 0
  let afterOperand = false
  let deepest = 0
  let over: number | null = null
  const reach = (depth: number, at: number) => {
    deepest = Math.max(deepest, depth)
    if (depth > limit && over === null) over = at
  }
  const operand = () => {
    run = 0
    afterOperand = true
  }
  const prefix = (at: number) => {
    run++
    afterOperand = false
    reach(levels + run, at)
  }
  const openBracket = (at: number, template: boolean) => {
    open.push({ levels, template })
    levels += run + 1
    run = 0
    afterOperand = false
    reach(levels, at)
  }
  // The text of a template literal from `i`: to its end, or into a ${
  const templateText = (from: number): number => {
    let i = from
    while (i < source.length) {
      if (source[i] === '\\') i += 2
      else if (source[i] === '`') {
        operand()
        return i + 1
      } else if (source[i] === '$' && source[i + 1] === '{') {
        openBracket(i, true)
        return i + 2
      } else i++
    }
    return i
  }
  let i = 0
  while (i < source.length && over === null) {
    const c = source[i]
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end < 0 ? source.length : end + 2
    } else if (c === '"' || c === "'") {
      i++
      while (i < source.length && source[i] !== c) i += source[i] === '\\' ? 2 : 1
      i++
      operand()
    } else if (c === '`') {
      i = templateText(i + 1)
    } else if (/[A-Za-z0-9_]/.test(c)) {
      let j = i + 1
      while (j < source.length && /[A-Za-z0-9_-]/.test(source[j])) j++
      if (source.slice(i, j) === 'mut') prefix(i)
      else operand()
      i = j
    } else if (c === '[' && !afterOperand && /^\[(\*|[0-9x_!?]*)\]/.test(source.slice(i, i + 64))) {
      prefix(i)
      i = source.indexOf(']', i) + 1
    } else if (c === '(' || c === '{' || c === '[') {
      openBracket(i, false)
      i++
    } else if (c === ')' || c === ']' || c === '}') {
      const was = open.pop()
      levels = was?.levels ?? 0
      operand()
      i = was?.template ? templateText(i + 1) : i + 1
    } else if (!afterOperand && '-~!&*?^'.includes(c)) {
      prefix(i)
      i++
    } else {
      if (!/\s/.test(c)) {
        run = 0
        afterOperand = false
      }
      i++
    }
  }
  return { deepest, over }
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
