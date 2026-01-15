// =============================================================================
// Encantis Lexer (Tokenizer)
// Converts source text into a stream of tokens
// =============================================================================

import { Token, TokenKind, Span, Diagnostic } from './types';

// -----------------------------------------------------------------------------
// Keywords
// -----------------------------------------------------------------------------

const KEYWORDS: Set<string> = new Set([
  'import', 'export', 'func', 'local', 'global', 'end',
  'if', 'then', 'elif', 'else', 'while', 'do', 'for', 'in',
  'loop', 'break', 'continue', 'br', 'return', 'when', 'and', 'or', 'not', 'as',
  'memory', 'def', 'define', 'interface', 'type', 'unique', 'let', 'set',
]);

// -----------------------------------------------------------------------------
// Multi-character operators (longest first for correct matching)
// -----------------------------------------------------------------------------

const MULTI_CHAR_OPS: string[] = [
  // 4-char
  '<<<=', '>>>=',
  // 3-char
  '>>>', '<<<', '>>=', '<<=',
  // 2-char
  '->',  '=>',  '==',  '!=',  '<=',  '>=',  '<<',  '>>',
  '+=',  '-=',  '*=',  '/=',  '%=',  '&=',  '|=',  '^=',
];

// Single-character punctuation and operators
const SINGLE_CHAR_OPS: Set<string> = new Set([
  '(', ')', '[', ']', '{', '}', ':', ',', '=', '.', '*',
  '+', '-', '/', '%', '&', '|', '^', '~', '<', '>', '#',
]);

// -----------------------------------------------------------------------------
// Lexer State
// -----------------------------------------------------------------------------

interface Lexer {
  src: string;
  pos: number;
  tokens: Token[];
  errors: Diagnostic[];
}

// -----------------------------------------------------------------------------
// Character Classification
// -----------------------------------------------------------------------------

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isHexDigit(ch: string): boolean {
  return isDigit(ch) || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}

function isNameStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isNameContinue(ch: string): boolean {
  return isNameStart(ch) || isDigit(ch) || ch === '-';
}

// -----------------------------------------------------------------------------
// Lexer Helpers
// -----------------------------------------------------------------------------

function peek(l: Lexer, offset = 0): string {
  return l.src[l.pos + offset] || '';
}

function advance(l: Lexer, count = 1): void {
  l.pos += count;
}

function emit(l: Lexer, kind: TokenKind, start: number, text?: string): void {
  l.tokens.push({
    kind,
    text: text ?? l.src.slice(start, l.pos),
    span: { start, end: l.pos },
  });
}

function addError(l: Lexer, start: number, message: string): void {
  l.errors.push({
    span: { start, end: l.pos },
    severity: 'error',
    message,
  });
}

// -----------------------------------------------------------------------------
// Skip Whitespace and Comments
// -----------------------------------------------------------------------------

function skipWhitespaceAndComments(l: Lexer): void {
  while (l.pos < l.src.length) {
    const ch = peek(l);

    if (isWhitespace(ch)) {
      advance(l);
      continue;
    }

    // Line comment: --
    if (ch === '-' && peek(l, 1) === '-') {
      advance(l, 2);
      while (l.pos < l.src.length && peek(l) !== '\n') {
        advance(l);
      }
      continue;
    }

    break;
  }
}

// -----------------------------------------------------------------------------
// Read String Literal
// -----------------------------------------------------------------------------

function readString(l: Lexer): void {
  const start = l.pos;
  const quote = peek(l);
  advance(l); // Skip opening quote

  let value = '';
  let hasError = false;

  while (l.pos < l.src.length) {
    const ch = peek(l);

    if (ch === quote) {
      advance(l);
      emit(l, 'STRING', start, l.src.slice(start, l.pos));
      return;
    }

    if (ch === '\n') {
      addError(l, start, 'Unterminated string literal. Strings cannot span multiple lines.');
      emit(l, 'STRING', start);
      return;
    }

    if (ch === '\\') {
      advance(l);
      const escape = peek(l);
      switch (escape) {
        case 'n': value += '\n'; break;
        case 't': value += '\t'; break;
        case 'r': value += '\r'; break;
        case '\\': value += '\\'; break;
        case '"': value += '"'; break;
        case "'": value += "'"; break;
        case '0': value += '\0'; break;
        case 'x':
          // Hex escape: \xNN
          advance(l);
          if (isHexDigit(peek(l)) && isHexDigit(peek(l, 1))) {
            const hex = l.src.slice(l.pos, l.pos + 2);
            value += String.fromCharCode(parseInt(hex, 16));
            advance(l);
          } else {
            addError(l, l.pos - 2, 'Invalid hex escape sequence. Expected \\xNN where N is a hex digit.');
            hasError = true;
          }
          break;
        default:
          addError(l, l.pos - 1, `Unknown escape sequence '\\${escape}'. Valid escapes: \\n \\t \\r \\\\ \\" \\' \\0 \\xNN`);
          hasError = true;
          value += escape;
      }
      advance(l);
    } else {
      value += ch;
      advance(l);
    }
  }

  addError(l, start, 'Unterminated string literal. Add a closing quote.');
  emit(l, 'STRING', start);
}

// -----------------------------------------------------------------------------
// Read Number Literal
// -----------------------------------------------------------------------------

function readNumber(l: Lexer): void {
  const start = l.pos;

  // Check for hex: 0x or 0X
  if (peek(l) === '0' && (peek(l, 1) === 'x' || peek(l, 1) === 'X')) {
    advance(l, 2);
    if (!isHexDigit(peek(l))) {
      addError(l, start, 'Invalid hex literal. Expected hex digits after 0x.');
      emit(l, 'NUMBER', start);
      return;
    }
    while (isHexDigit(peek(l))) {
      advance(l);
    }
  }
  // Check for binary: 0b or 0B
  else if (peek(l) === '0' && (peek(l, 1) === 'b' || peek(l, 1) === 'B')) {
    advance(l, 2);
    if (peek(l) !== '0' && peek(l) !== '1') {
      addError(l, start, 'Invalid binary literal. Expected 0 or 1 after 0b.');
      emit(l, 'NUMBER', start);
      return;
    }
    while (peek(l) === '0' || peek(l) === '1') {
      advance(l);
    }
  }
  // Decimal (possibly with decimal point)
  else {
    while (isDigit(peek(l))) {
      advance(l);
    }

    // Check for decimal point
    if (peek(l) === '.' && isDigit(peek(l, 1))) {
      advance(l); // Skip '.'
      while (isDigit(peek(l))) {
        advance(l);
      }
    }

    // Check for exponent
    if (peek(l) === 'e' || peek(l) === 'E') {
      advance(l);
      if (peek(l) === '+' || peek(l) === '-') {
        advance(l);
      }
      if (!isDigit(peek(l))) {
        addError(l, start, 'Invalid number: expected digits after exponent.');
      }
      while (isDigit(peek(l))) {
        advance(l);
      }
    }
  }

  // Check for type suffix (e.g., 100:u32)
  // Note: We don't consume the ':' here; the parser handles type annotations

  emit(l, 'NUMBER', start);
}

// -----------------------------------------------------------------------------
// Read Name or Keyword
// -----------------------------------------------------------------------------

function readNameOrKeyword(l: Lexer): void {
  const start = l.pos;

  while (l.pos < l.src.length && isNameContinue(peek(l))) {
    advance(l);
  }

  const text = l.src.slice(start, l.pos);

  // Check if it's a keyword
  if (KEYWORDS.has(text)) {
    emit(l, text as TokenKind, start, text);
  } else {
    emit(l, 'NAME', start, text);
  }
}

// -----------------------------------------------------------------------------
// Read Punctuation or Operator
// -----------------------------------------------------------------------------

function readPunctOrOp(l: Lexer): void {
  const start = l.pos;

  // Try multi-character operators first (longest match)
  for (const op of MULTI_CHAR_OPS) {
    if (l.src.startsWith(op, l.pos)) {
      advance(l, op.length);
      emit(l, op as TokenKind, start, op);
      return;
    }
  }

  // Single character
  const ch = peek(l);
  if (SINGLE_CHAR_OPS.has(ch)) {
    advance(l);
    emit(l, ch as TokenKind, start, ch);
    return;
  }

  // Unknown character
  advance(l);
  addError(l, start, `Unexpected character '${ch}'. This character is not valid in Encantis.`);
}

// -----------------------------------------------------------------------------
// Main Tokenize Function
// -----------------------------------------------------------------------------

export interface TokenizeResult {
  tokens: Token[];
  errors: Diagnostic[];
}

export function tokenize(src: string): TokenizeResult {
  const l: Lexer = {
    src,
    pos: 0,
    tokens: [],
    errors: [],
  };

  while (l.pos < l.src.length) {
    skipWhitespaceAndComments(l);

    if (l.pos >= l.src.length) {
      break;
    }

    const ch = peek(l);

    if (ch === '"' || ch === "'") {
      readString(l);
    } else if (isDigit(ch)) {
      readNumber(l);
    } else if (isNameStart(ch)) {
      readNameOrKeyword(l);
    } else {
      readPunctOrOp(l);
    }
  }

  // Add EOF token
  l.tokens.push({
    kind: 'EOF',
    text: '',
    span: { start: l.pos, end: l.pos },
  });

  return {
    tokens: l.tokens,
    errors: l.errors,
  };
}

// -----------------------------------------------------------------------------
// Helper: Get line and column from offset
// -----------------------------------------------------------------------------

export function getLineAndColumn(src: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;

  for (let i = 0; i < offset && i < src.length; i++) {
    if (src[i] === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }

  return { line, column };
}

// -----------------------------------------------------------------------------
// Helper: Format error with source context
// -----------------------------------------------------------------------------

export function formatDiagnostic(src: string, diag: Diagnostic): string {
  const { line, column } = getLineAndColumn(src, diag.span.start);
  const severity = diag.severity.toUpperCase();

  // Get the source line
  const lines = src.split('\n');
  const sourceLine = lines[line - 1] || '';

  // Build the pointer line
  const pointer = ' '.repeat(column - 1) + '^'.repeat(Math.max(1, diag.span.end - diag.span.start));

  return [
    `${severity} at line ${line}, column ${column}: ${diag.message}`,
    `  ${sourceLine}`,
    `  ${pointer}`,
  ].join('\n');
}
