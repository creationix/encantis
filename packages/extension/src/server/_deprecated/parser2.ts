// Encantis Parser v2 - Hand-written recursive descent parser
// Based on grammar.md formal specification

// =============================================================================
// SPANS AND SOURCE LOCATIONS
// =============================================================================

export interface Span {
  start: number;  // byte offset
  end: number;    // byte offset (exclusive)
}

export function spanUnion(a: Span, b: Span): Span {
  return { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) };
}

export function spanFrom(start: Span, end: Span): Span {
  return { start: start.start, end: end.end };
}

// =============================================================================
// TOKENS
// =============================================================================

export type TokenKind =
  // Literals
  | 'NUMBER' | 'STRING' | 'IDENT' | 'TYPE_IDENT'
  // Keywords
  | 'if' | 'elif' | 'else' | 'while' | 'for' | 'in' | 'loop' | 'match'
  | 'break' | 'continue' | 'return' | 'when'
  | 'func' | 'let' | 'set' | 'global' | 'def' | 'type'
  | 'import' | 'export' | 'memory' | 'data' | 'inline' | 'unique'
  | 'as' | 'true' | 'false'
  // Operators
  | '+' | '-' | '*' | '/' | '%'
  | '+|' | '-|' | '*|'  // saturating operators
  | '&' | '|' | '^' | '~'
  | '<<' | '>>' | '<<<' | '>>>'
  | '==' | '!=' | '<' | '>' | '<=' | '>='
  | '&&' | '||' | '!'
  | '=' | '+=' | '-=' | '*=' | '/=' | '%='
  | '+|=' | '-|=' | '*|='  // saturating assignment
  | '&=' | '|=' | '^=' | '<<=' | '>>=' | '<<<=' | '>>>='
  // Punctuation
  | '(' | ')' | '[' | ']' | '{' | '}'
  | ',' | ':' | '.' | '->' | '=>' | '_'
  // Special
  | 'EOF' | 'ERROR';

export interface Token {
  kind: TokenKind;
  text: string;
  span: Span;
}

// =============================================================================
// AST TYPES
// =============================================================================

// Base interface for all AST nodes
export interface AstNode {
  span: Span;
}

// Error node - inserted when parsing fails
export interface ErrorNode extends AstNode {
  kind: 'Error';
  message: string;
  partial?: AstNode;  // partially parsed content
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type Type =
  | PrimitiveType
  | PointerType
  | SliceType
  | ArrayType
  | NullTermType
  | TupleType
  | StructType
  | NamedType
  | ErrorType;

export interface PrimitiveType extends AstNode {
  kind: 'PrimitiveType';
  name: 'i8' | 'i16' | 'i32' | 'i64' | 'u8' | 'u16' | 'u32' | 'u64' | 'f32' | 'f64' | 'bool';
}

export interface PointerType extends AstNode {
  kind: 'PointerType';
  target: Type;
}

export interface SliceType extends AstNode {
  kind: 'SliceType';
  element: Type;
}

export interface ArrayType extends AstNode {
  kind: 'ArrayType';
  element: Type;
  length: number;
}

export interface NullTermType extends AstNode {
  kind: 'NullTermType';
  element: Type;
  length?: number;  // optional fixed length
}

export interface TupleType extends AstNode {
  kind: 'TupleType';
  elements: Type[];
}

export interface StructType extends AstNode {
  kind: 'StructType';
  fields: Array<{ name: string; type: Type; span: Span }>;
}

export interface NamedType extends AstNode {
  kind: 'NamedType';
  name: string;
}

export interface ErrorType extends AstNode {
  kind: 'ErrorType';
  message: string;
}

// -----------------------------------------------------------------------------
// Expressions
// -----------------------------------------------------------------------------

export type Expr =
  | NumberLit
  | StringLit
  | BoolLit
  | Identifier
  | BinaryExpr
  | UnaryExpr
  | CallExpr
  | IndexExpr
  | MemberExpr
  | CastExpr
  | AnnotationExpr
  | TupleLit
  | StructLit
  | IfExpr
  | MatchExpr
  | GroupExpr
  | ConstructorExpr
  | ErrorExpr;

export interface NumberLit extends AstNode {
  kind: 'NumberLit';
  value: string;  // keep as string to preserve precision
}

export interface StringLit extends AstNode {
  kind: 'StringLit';
  value: string;  // decoded string content
  encoding: 'utf8' | 'hex' | 'base64';
}

export interface BoolLit extends AstNode {
  kind: 'BoolLit';
  value: boolean;
}

export interface Identifier extends AstNode {
  kind: 'Identifier';
  name: string;
}

export interface BinaryExpr extends AstNode {
  kind: 'BinaryExpr';
  op: string;
  left: Expr;
  right: Expr;
}

export interface UnaryExpr extends AstNode {
  kind: 'UnaryExpr';
  op: string;  // '-', '~', '&', '!'
  operand: Expr;
}

export interface CallExpr extends AstNode {
  kind: 'CallExpr';
  callee: Expr;
  args: Arg[];
}

export interface Arg {
  name?: string;  // for named arguments
  value: Expr;
  span: Span;
}

export interface IndexExpr extends AstNode {
  kind: 'IndexExpr';
  target: Expr;
  index: Expr;
}

export interface MemberExpr extends AstNode {
  kind: 'MemberExpr';
  target: Expr;
  member: string | number;  // field name or tuple index
  isDeref?: boolean;  // for .*
  isTypePun?: Type;  // for .Type
}

export interface CastExpr extends AstNode {
  kind: 'CastExpr';
  expr: Expr;
  type: Type;
}

export interface AnnotationExpr extends AstNode {
  kind: 'AnnotationExpr';
  expr: Expr;
  type: Type;
}

export interface TupleLit extends AstNode {
  kind: 'TupleLit';
  elements: Arg[];
}

export interface StructLit extends AstNode {
  kind: 'StructLit';
  type?: string;  // optional type name
  fields: Arg[];
}

export interface IfExpr extends AstNode {
  kind: 'IfExpr';
  condition: Expr;
  thenBranch: Body;
  elifBranches: Array<{ condition: Expr; body: Body; span: Span }>;
  elseBranch?: Body;
}

export interface MatchExpr extends AstNode {
  kind: 'MatchExpr';
  subject: Expr;
  arms: MatchArm[];
}

export interface MatchArm {
  patterns: MatchPattern[];
  body: Body;
  span: Span;
}

export type MatchPattern =
  | { kind: 'LiteralPattern'; value: NumberLit | StringLit | BoolLit; span: Span }
  | { kind: 'WildcardPattern'; span: Span };

export interface GroupExpr extends AstNode {
  kind: 'GroupExpr';
  expr: Expr;
}

export interface ConstructorExpr extends AstNode {
  kind: 'ConstructorExpr';
  typeName: string;
  args: Arg[];
}

export interface ErrorExpr extends AstNode {
  kind: 'ErrorExpr';
  message: string;
}

// -----------------------------------------------------------------------------
// Patterns (for let/set destructuring)
// -----------------------------------------------------------------------------

export type Pattern =
  | IdentPattern
  | TuplePattern
  | StructPattern
  | ErrorPattern;

export interface IdentPattern extends AstNode {
  kind: 'IdentPattern';
  name: string;
}

export interface TuplePattern extends AstNode {
  kind: 'TuplePattern';
  elements: PatternElement[];
}

export interface StructPattern extends AstNode {
  kind: 'StructPattern';
  fields: PatternField[];
}

export interface PatternElement {
  pattern: Pattern;
  span: Span;
}

export interface PatternField {
  fieldName: string;
  binding?: string;  // if different from fieldName
  span: Span;
}

export interface ErrorPattern extends AstNode {
  kind: 'ErrorPattern';
  message: string;
}

// -----------------------------------------------------------------------------
// Statements
// -----------------------------------------------------------------------------

export type Stmt =
  | LetStmt
  | SetStmt
  | IfStmt
  | WhileStmt
  | ForStmt
  | LoopStmt
  | ReturnStmt
  | BreakStmt
  | ContinueStmt
  | AssignStmt
  | ExprStmt
  | ErrorStmt;

export interface LetStmt extends AstNode {
  kind: 'LetStmt';
  pattern: Pattern;
  type?: Type;
  init?: Expr;
}

export interface SetStmt extends AstNode {
  kind: 'SetStmt';
  pattern: Pattern;
  type?: Type;
  value: Expr;
}

export interface IfStmt extends AstNode {
  kind: 'IfStmt';
  condition: Expr;
  thenBody: Body;
  elifClauses: Array<{ condition: Expr; body: Body; span: Span }>;
  elseBody?: Body;
}

export interface WhileStmt extends AstNode {
  kind: 'WhileStmt';
  condition: Expr;
  body: Body;
}

export interface ForStmt extends AstNode {
  kind: 'ForStmt';
  binding: string;
  indexBinding?: string;
  iterable: Expr;
  body: Body;
}

export interface LoopStmt extends AstNode {
  kind: 'LoopStmt';
  body: Body;
}

export interface ReturnStmt extends AstNode {
  kind: 'ReturnStmt';
  value?: Expr;
  when?: Expr;
}

export interface BreakStmt extends AstNode {
  kind: 'BreakStmt';
  when?: Expr;
}

export interface ContinueStmt extends AstNode {
  kind: 'ContinueStmt';
  when?: Expr;
}

export interface AssignStmt extends AstNode {
  kind: 'AssignStmt';
  target: Expr;  // lvalue
  op: string;  // '=' or compound like '+='
  value: Expr;
}

export interface ExprStmt extends AstNode {
  kind: 'ExprStmt';
  expr: Expr;
}

export interface ErrorStmt extends AstNode {
  kind: 'ErrorStmt';
  message: string;
}

// Body can be block or arrow expression
export type Body =
  | BlockBody
  | ArrowBody;

export interface BlockBody extends AstNode {
  kind: 'BlockBody';
  stmts: Stmt[];
}

export interface ArrowBody extends AstNode {
  kind: 'ArrowBody';
  expr: Expr;
}

// -----------------------------------------------------------------------------
// Top-Level Declarations
// -----------------------------------------------------------------------------

export type Decl =
  | ImportDecl
  | ExportDecl
  | FuncDecl
  | TypeDecl
  | UniqueDecl
  | DefDecl
  | GlobalDecl
  | MemoryDecl
  | DataDecl
  | ErrorDecl;

export interface ImportDecl extends AstNode {
  kind: 'ImportDecl';
  module: string;
  items: ImportItem[];
}

export interface ImportItem {
  externalName: string;
  item: ImportItemKind;
  span: Span;
}

export type ImportItemKind =
  | { kind: 'func'; signature: FuncSignature }
  | { kind: 'global'; name: string; type: Type }
  | { kind: 'memory'; pages: number };

export interface FuncSignature {
  params: FuncParam[];
  returns?: Type | NamedReturns;
}

export interface FuncParam {
  name?: string;
  type: Type;
  span: Span;
}

export interface NamedReturns {
  kind: 'NamedReturns';
  fields: Array<{ name: string; type: Type; span: Span }>;
}

export interface ExportDecl extends AstNode {
  kind: 'ExportDecl';
  exportName: string;
  decl: FuncDecl | GlobalDecl | MemoryDecl;
}

export interface FuncDecl extends AstNode {
  kind: 'FuncDecl';
  name?: string;
  isInline: boolean;
  signature: FuncSignature;
  body: Body;
}

export interface TypeDecl extends AstNode {
  kind: 'TypeDecl';
  name: string;
  type: Type;
}

export interface UniqueDecl extends AstNode {
  kind: 'UniqueDecl';
  name: string;
  type: Type;
}

export interface DefDecl extends AstNode {
  kind: 'DefDecl';
  name: string;
  value: Expr;
}

export interface GlobalDecl extends AstNode {
  kind: 'GlobalDecl';
  name: string;
  type?: Type;
  init?: Expr;
}

export interface MemoryDecl extends AstNode {
  kind: 'MemoryDecl';
  minPages: number;
  maxPages?: number;
}

export interface DataDecl extends AstNode {
  kind: 'DataDecl';
  offset: number;
  value: Expr;
}

export interface ErrorDecl extends AstNode {
  kind: 'ErrorDecl';
  message: string;
}

// -----------------------------------------------------------------------------
// Module (top-level AST)
// -----------------------------------------------------------------------------

export interface Module extends AstNode {
  kind: 'Module';
  decls: Decl[];
}

// =============================================================================
// DIAGNOSTICS
// =============================================================================

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  span: Span;
  severity: DiagnosticSeverity;
  message: string;
}

// =============================================================================
// PARSE RESULT
// =============================================================================

export interface ParseResult {
  ast: Module;
  errors: Diagnostic[];
}

// =============================================================================
// LEXER
// =============================================================================

const KEYWORDS = new Set([
  'if', 'elif', 'else', 'while', 'for', 'in', 'loop', 'match',
  'break', 'continue', 'return', 'when',
  'func', 'let', 'set', 'global', 'def', 'type',
  'import', 'export', 'memory', 'data', 'inline', 'unique',
  'as', 'true', 'false',
]);

const PRIMITIVES = new Set([
  'i8', 'i16', 'i32', 'i64',
  'u8', 'u16', 'u32', 'u64',
  'f32', 'f64', 'bool',
]);

export function tokenize(src: string): { tokens: Token[]; errors: Diagnostic[] } {
  const tokens: Token[] = [];
  const errors: Diagnostic[] = [];
  let pos = 0;

  function peek(offset = 0): string {
    return src[pos + offset] ?? '\0';
  }

  function advance(): string {
    return src[pos++] ?? '\0';
  }

  function match(ch: string): boolean {
    if (peek() === ch) {
      advance();
      return true;
    }
    return false;
  }

  function skipWhitespace(): void {
    while (pos < src.length) {
      const ch = peek();
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        advance();
      } else if (ch === '/' && peek(1) === '/') {
        // Line comment
        while (pos < src.length && peek() !== '\n') advance();
      } else if (ch === '/' && peek(1) === '*') {
        // Block comment
        const start = pos;
        advance(); advance(); // consume /*
        while (pos < src.length && !(peek() === '*' && peek(1) === '/')) {
          advance();
        }
        if (pos >= src.length) {
          errors.push({ span: { start, end: pos }, severity: 'error', message: 'Unterminated block comment' });
        } else {
          advance(); advance(); // consume */
        }
      } else {
        break;
      }
    }
  }

  function scanNumber(): Token {
    const start = pos;
    let text = '';

    // Check for negative (handled by unary operator, but lexer should not consume)
    // Actually, let the parser handle negative as unary

    // Check for base prefix
    if (peek() === '0') {
      const next = peek(1);
      if (next === 'x' || next === 'X') {
        text += advance(); text += advance();
        while (/[0-9a-fA-F]/.test(peek())) text += advance();
        return { kind: 'NUMBER', text, span: { start, end: pos } };
      } else if (next === 'b' || next === 'B') {
        text += advance(); text += advance();
        while (/[01]/.test(peek())) text += advance();
        return { kind: 'NUMBER', text, span: { start, end: pos } };
      } else if (next === 'o' || next === 'O') {
        text += advance(); text += advance();
        while (/[0-7]/.test(peek())) text += advance();
        return { kind: 'NUMBER', text, span: { start, end: pos } };
      }
    }

    // Decimal
    while (/[0-9]/.test(peek())) text += advance();

    // Fractional part
    if (peek() === '.' && /[0-9]/.test(peek(1))) {
      text += advance(); // consume .
      while (/[0-9]/.test(peek())) text += advance();
    }

    // Exponent
    if (peek() === 'e' || peek() === 'E') {
      text += advance();
      if (peek() === '+' || peek() === '-') text += advance();
      while (/[0-9]/.test(peek())) text += advance();
    }

    return { kind: 'NUMBER', text, span: { start, end: pos } };
  }

  function scanString(): Token {
    const start = pos;
    const quote = advance(); // consume opening quote
    let value = '';

    while (pos < src.length && peek() !== quote && peek() !== '\n') {
      if (peek() === '\\') {
        advance(); // consume backslash
        const escaped = advance();
        switch (escaped) {
          case 'n': value += '\n'; break;
          case 't': value += '\t'; break;
          case 'r': value += '\r'; break;
          case '\\': value += '\\'; break;
          case '"': value += '"'; break;
          case 'x': {
            const hex = src.slice(pos, pos + 2);
            if (/^[0-9a-fA-F]{2}$/.test(hex)) {
              value += String.fromCharCode(parseInt(hex, 16));
              pos += 2;
            } else {
              errors.push({ span: { start: pos - 2, end: pos }, severity: 'error', message: 'Invalid hex escape' });
            }
            break;
          }
          default:
            errors.push({ span: { start: pos - 2, end: pos }, severity: 'error', message: `Unknown escape sequence: \\${escaped}` });
        }
      } else {
        value += advance();
      }
    }

    if (peek() !== quote) {
      errors.push({ span: { start, end: pos }, severity: 'error', message: 'Unterminated string literal' });
    } else {
      advance(); // consume closing quote
    }

    return { kind: 'STRING', text: value, span: { start, end: pos } };
  }

  function scanHexString(): Token {
    const start = pos;
    advance(); // consume 'x'
    advance(); // consume '"'
    let bytes: number[] = [];

    while (pos < src.length && peek() !== '"') {
      const ch = peek();
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        advance();
        continue;
      }
      if (/[0-9a-fA-F]/.test(ch)) {
        const hex = src.slice(pos, pos + 2);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          bytes.push(parseInt(hex, 16));
          pos += 2;
        } else {
          errors.push({ span: { start: pos, end: pos + 1 }, severity: 'error', message: 'Incomplete hex byte' });
          advance();
        }
      } else {
        errors.push({ span: { start: pos, end: pos + 1 }, severity: 'error', message: `Invalid character in hex string: ${ch}` });
        advance();
      }
    }

    if (peek() !== '"') {
      errors.push({ span: { start, end: pos }, severity: 'error', message: 'Unterminated hex string' });
    } else {
      advance();
    }

    // Encode bytes back to string for storage
    const value = String.fromCharCode(...bytes);
    return { kind: 'STRING', text: `x"${value}"`, span: { start, end: pos } };
  }

  function scanBase64String(): Token {
    const start = pos;
    advance(); // consume 'b'
    advance(); // consume '"'
    let base64 = '';

    while (pos < src.length && peek() !== '"') {
      const ch = peek();
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        advance();
        continue;
      }
      if (/[A-Za-z0-9+/=]/.test(ch)) {
        base64 += advance();
      } else {
        errors.push({ span: { start: pos, end: pos + 1 }, severity: 'error', message: `Invalid character in base64 string: ${ch}` });
        advance();
      }
    }

    if (peek() !== '"') {
      errors.push({ span: { start, end: pos }, severity: 'error', message: 'Unterminated base64 string' });
    } else {
      advance();
    }

    return { kind: 'STRING', text: `b"${base64}"`, span: { start, end: pos } };
  }

  function scanIdentifier(): Token {
    const start = pos;
    let text = '';

    // First character determines if it's a type identifier (uppercase) or regular
    const first = advance();
    text += first;
    const isTypeIdent = /[A-Z]/.test(first);

    // Continue with identifier characters (including hyphen)
    while (/[a-zA-Z0-9_-]/.test(peek())) {
      text += advance();
    }

    // Check if it's a keyword
    if (KEYWORDS.has(text)) {
      return { kind: text as TokenKind, text, span: { start, end: pos } };
    }

    // Check if it's a primitive type (treated as keyword-like)
    if (PRIMITIVES.has(text)) {
      return { kind: 'IDENT', text, span: { start, end: pos } };
    }

    return { kind: isTypeIdent ? 'TYPE_IDENT' : 'IDENT', text, span: { start, end: pos } };
  }

  function scanOperator(): Token | null {
    const start = pos;
    const ch = peek();

    // Multi-character operators (longest match first)
    const threeChar = src.slice(pos, pos + 3);
    if (['<<<', '>>>', '&&=', '||=', '+|=', '-|=', '*|='].includes(threeChar)) {
      // Check for 4-char operators
      const fourChar = src.slice(pos, pos + 4);
      if (['<<<=', '>>>='].includes(fourChar)) {
        pos += 4;
        return { kind: fourChar as TokenKind, text: fourChar, span: { start, end: pos } };
      }
      pos += 3;
      return { kind: threeChar as TokenKind, text: threeChar, span: { start, end: pos } };
    }

    const twoChar = src.slice(pos, pos + 2);
    if (['==', '!=', '<=', '>=', '<<', '>>', '&&', '||', '->', '=>', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '+|', '-|', '*|'].includes(twoChar)) {
      // Check for 3-char compound assignments
      const threeCharAssign = src.slice(pos, pos + 3);
      if (['<<=', '>>='].includes(threeCharAssign)) {
        pos += 3;
        return { kind: threeCharAssign as TokenKind, text: threeCharAssign, span: { start, end: pos } };
      }
      pos += 2;
      return { kind: twoChar as TokenKind, text: twoChar, span: { start, end: pos } };
    }

    // Single character operators
    if ('+-*/%&|^~<>=!()[]{},:.'.includes(ch)) {
      advance();
      return { kind: ch as TokenKind, text: ch, span: { start, end: pos } };
    }

    // Underscore (wildcard for match patterns)
    if (ch === '_') {
      advance();
      return { kind: '_', text: '_', span: { start, end: pos } };
    }

    return null;
  }

  // Main tokenization loop
  while (pos < src.length) {
    skipWhitespace();
    if (pos >= src.length) break;

    const start = pos;
    const ch = peek();

    // Numbers
    if (/[0-9]/.test(ch)) {
      tokens.push(scanNumber());
      continue;
    }

    // Strings
    if (ch === '"') {
      tokens.push(scanString());
      continue;
    }

    // Hex strings x"..."
    if (ch === 'x' && peek(1) === '"') {
      tokens.push(scanHexString());
      continue;
    }

    // Base64 strings b"..."
    if (ch === 'b' && peek(1) === '"') {
      tokens.push(scanBase64String());
      continue;
    }

    // Identifiers and keywords (must start with letter per grammar)
    if (/[a-zA-Z]/.test(ch)) {
      tokens.push(scanIdentifier());
      continue;
    }

    // Operators and punctuation
    const op = scanOperator();
    if (op) {
      tokens.push(op);
      continue;
    }

    // Unknown character
    errors.push({ span: { start, end: start + 1 }, severity: 'error', message: `Unexpected character: ${ch}` });
    advance();
  }

  tokens.push({ kind: 'EOF', text: '', span: { start: pos, end: pos } });
  return { tokens, errors };
}

// =============================================================================
// PARSER
// =============================================================================

interface ParserState {
  tokens: Token[];
  pos: number;
  errors: Diagnostic[];
  src: string;
}

function createParser(src: string): ParserState {
  const { tokens, errors } = tokenize(src);
  return { tokens, pos: 0, errors, src };
}

// -----------------------------------------------------------------------------
// Parser Helpers
// -----------------------------------------------------------------------------

function peek(p: ParserState, offset = 0): Token {
  const idx = p.pos + offset;
  return idx < p.tokens.length ? p.tokens[idx] : p.tokens[p.tokens.length - 1];
}

function at(p: ParserState, kind: TokenKind): boolean {
  return peek(p).kind === kind;
}

function atAny(p: ParserState, ...kinds: TokenKind[]): boolean {
  return kinds.includes(peek(p).kind);
}

function advance(p: ParserState): Token {
  const tok = peek(p);
  if (tok.kind !== 'EOF') p.pos++;
  return tok;
}

function expect(p: ParserState, kind: TokenKind, message?: string): Token {
  if (at(p, kind)) {
    return advance(p);
  }
  const tok = peek(p);
  p.errors.push({
    span: tok.span,
    severity: 'error',
    message: message ?? `Expected ${kind}, got ${tok.kind}`,
  });
  // Return synthetic token
  return { kind, text: '', span: tok.span };
}

function match(p: ParserState, kind: TokenKind): boolean {
  if (at(p, kind)) {
    advance(p);
    return true;
  }
  return false;
}

function addError(p: ParserState, span: Span, message: string): void {
  p.errors.push({ span, severity: 'error', message });
}

// Check if current token can start an expression
function canStartExpr(p: ParserState): boolean {
  const kind = peek(p).kind;
  return kind === 'NUMBER' || kind === 'STRING' || kind === 'IDENT' || kind === 'TYPE_IDENT' ||
         kind === 'true' || kind === 'false' ||
         kind === '(' || kind === 'if' || kind === 'match' ||
         kind === '-' || kind === '~' || kind === '&' || kind === '!';
}

// Synchronize to a recovery point (statement/declaration boundary)
function synchronize(p: ParserState): void {
  while (!at(p, 'EOF')) {
    const kind = peek(p).kind;
    // Skip to next statement/declaration boundary
    if (kind === 'func' || kind === 'let' || kind === 'set' ||
        kind === 'if' || kind === 'while' || kind === 'for' || kind === 'loop' ||
        kind === 'return' || kind === 'break' || kind === 'continue' ||
        kind === 'import' || kind === 'export' || kind === 'global' ||
        kind === 'memory' || kind === 'data' || kind === 'def' || kind === 'type' ||
        kind === 'unique' || kind === '}') {
      return;
    }
    advance(p);
  }
}

// -----------------------------------------------------------------------------
// Type Parsing
// -----------------------------------------------------------------------------

function parseType(p: ParserState): Type {
  const start = peek(p).span;

  // Pointer type: * Type
  if (match(p, '*')) {
    const target = parseType(p);
    return { kind: 'PointerType', target, span: spanFrom(start, target.span) };
  }

  // Composite/tuple/struct type: ( ... )
  if (at(p, '(')) {
    return parseCompositeType(p);
  }

  // Primitive or named type
  const tok = peek(p);
  if (tok.kind === 'TYPE_IDENT' || tok.kind === 'IDENT') {
    advance(p);
    let baseType: Type;
    if (PRIMITIVES.has(tok.text)) {
      baseType = { kind: 'PrimitiveType', name: tok.text as PrimitiveType['name'], span: tok.span };
    } else if (tok.kind === 'TYPE_IDENT') {
      baseType = { kind: 'NamedType', name: tok.text, span: tok.span };
    } else {
      baseType = { kind: 'PrimitiveType', name: tok.text as PrimitiveType['name'], span: tok.span };
    }

    // Check for indexed type: Type[ ... ]
    if (at(p, '[')) {
      return parseIndexedType(p, baseType);
    }

    return baseType;
  }

  addError(p, tok.span, `Expected type, got ${tok.kind}`);
  advance(p);
  return { kind: 'ErrorType', message: 'Expected type', span: tok.span };
}

function parseIndexedType(p: ParserState, element: Type): Type {
  const start = element.span;
  expect(p, '[');

  // Check for size and/or null-terminator
  let length: number | undefined;
  let isNullTerm = false;

  if (at(p, 'NUMBER')) {
    length = parseInt(advance(p).text, 10);
  }

  if (match(p, '/')) {
    expect(p, 'NUMBER'); // expect 0
    isNullTerm = true;
  }

  const end = expect(p, ']');

  if (isNullTerm) {
    return { kind: 'NullTermType', element, length, span: spanFrom(start, end.span) };
  } else if (length !== undefined) {
    return { kind: 'ArrayType', element, length, span: spanFrom(start, end.span) };
  } else {
    return { kind: 'SliceType', element, span: spanFrom(start, end.span) };
  }
}

function parseCompositeType(p: ParserState): Type {
  const start = expect(p, '(').span;

  if (match(p, ')')) {
    // Unit type ()
    return { kind: 'TupleType', elements: [], span: spanFrom(start, peek(p, -1).span) };
  }

  // Parse first element to determine if struct or tuple
  const firstType = parseType(p);

  if (at(p, ':')) {
    // This is a struct type: (name: Type, ...)
    // Backtrack - we parsed the name as a type
    // Actually, for struct types the syntax is (name: Type), but we parsed Type first
    // Let me re-check the grammar...
    // field = type | identifier ":" type
    // So we need to check if what we parsed was actually an identifier followed by :
    // This is ambiguous in parsing - let's handle it differently
  }

  // For now, parse as tuple
  const elements: Type[] = [firstType];

  while (match(p, ',')) {
      if (at(p, ')')) break;
    elements.push(parseType(p));
    }

  const end = expect(p, ')');
  return { kind: 'TupleType', elements, span: spanFrom(start, end.span) };
}

// -----------------------------------------------------------------------------
// Expression Parsing (Precedence Climbing)
// -----------------------------------------------------------------------------

const PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 4, '!=': 4, '<': 4, '>': 4, '<=': 4, '>=': 4,
  '|': 5,
  '^': 6,
  '&': 7,
  '<<': 8, '>>': 8, '<<<': 8, '>>>': 8,
  '+': 9, '-': 9, '+|': 9, '-|': 9,
  '*': 10, '/': 10, '%': 10, '*|': 10,
};

function parseExpr(p: ParserState, minPrec = 0): Expr {
  let left = parseUnaryExpr(p);

  while (true) {
    const op = peek(p);
    const prec = PRECEDENCE[op.kind];
    if (prec === undefined || prec < minPrec) break;

    advance(p);
    const right = parseExpr(p, prec + 1);
    left = { kind: 'BinaryExpr', op: op.text, left, right, span: spanFrom(left.span, right.span) };
  }

  return left;
}

function parseUnaryExpr(p: ParserState): Expr {
  const tok = peek(p);

  if (tok.kind === '-' || tok.kind === '~' || tok.kind === '&' || tok.kind === '!') {
    advance(p);
    const operand = parseUnaryExpr(p);
    return { kind: 'UnaryExpr', op: tok.text, operand, span: spanFrom(tok.span, operand.span) };
  }

  return parseCastExpr(p);
}

function parseCastExpr(p: ParserState): Expr {
  let expr = parsePostfixExpr(p);

  // Check for cast (as Type) or annotation (: Type)
  if (match(p, 'as')) {
    const type = parseType(p);
    expr = { kind: 'CastExpr', expr, type, span: spanFrom(expr.span, type.span) };
  } else if (at(p, ':') && peek(p, 1).kind !== '=') {
    // Type annotation, but need to distinguish from assignment context
    // Only parse as annotation if not followed by '='
    advance(p);
    const type = parseType(p);
    expr = { kind: 'AnnotationExpr', expr, type, span: spanFrom(expr.span, type.span) };
  }

  return expr;
}

function parsePostfixExpr(p: ParserState): Expr {
  let expr = parsePrimaryExpr(p);

  while (true) {
    if (match(p, '.')) {
      // Member access
      const member = peek(p);
      if (member.kind === 'NUMBER') {
        // Tuple index .0, .1, etc.
        advance(p);
        expr = { kind: 'MemberExpr', target: expr, member: parseInt(member.text, 10), span: spanFrom(expr.span, member.span) };
      } else if (member.kind === '*') {
        // Dereference .*
        advance(p);
        expr = { kind: 'MemberExpr', target: expr, member: '*', isDeref: true, span: spanFrom(expr.span, member.span) };
      } else if (member.kind === 'IDENT' || member.kind === 'TYPE_IDENT') {
        advance(p);
        // Check if it's a type-punned access (primitive type name)
        if (PRIMITIVES.has(member.text)) {
          const type: PrimitiveType = { kind: 'PrimitiveType', name: member.text as PrimitiveType['name'], span: member.span };
          expr = { kind: 'MemberExpr', target: expr, member: member.text, isTypePun: type, span: spanFrom(expr.span, member.span) };
        } else {
          expr = { kind: 'MemberExpr', target: expr, member: member.text, span: spanFrom(expr.span, member.span) };
        }
      } else {
        addError(p, member.span, 'Expected member name after .');
        break;
      }
    } else if (match(p, '[')) {
      // Index access
          const index = parseExpr(p);
          const end = expect(p, ']');
      expr = { kind: 'IndexExpr', target: expr, index, span: spanFrom(expr.span, end.span) };
    } else if (at(p, '(') && expr.kind === 'Identifier') {
      // Function call - only if callee is identifier-like
      expr = parseCallExpr(p, expr);
    } else if (at(p, '(') && expr.kind === 'MemberExpr') {
      // Method call via UFCS
      expr = parseCallExpr(p, expr);
    } else {
      break;
    }
  }

  return expr;
}

function parseCallExpr(p: ParserState, callee: Expr): CallExpr {
  expect(p, '(');
  const args: Arg[] = [];

  if (!at(p, ')')) {
    args.push(parseArg(p));
    while (match(p, ',')) {
          if (at(p, ')')) break;
      args.push(parseArg(p));
    }
  }

  const end = expect(p, ')');

  return { kind: 'CallExpr', callee, args, span: spanFrom(callee.span, end.span) };
}

function parseArg(p: ParserState): Arg {
  const start = peek(p).span;

  // Check for named argument: name: value or name: (shorthand)
  if (peek(p).kind === 'IDENT' && peek(p, 1).kind === ':') {
    const name = advance(p).text;
    advance(p); // consume :

    if (at(p, ',') || at(p, ')')) {
      // Shorthand: name:
      return { name, value: { kind: 'Identifier', name, span: start }, span: spanFrom(start, peek(p, -1).span) };
    }

    const value = parseExpr(p);
    return { name, value, span: spanFrom(start, value.span) };
  }

  const value = parseExpr(p);
  return { value, span: value.span };
}

function parsePrimaryExpr(p: ParserState): Expr {
  const tok = peek(p);

  switch (tok.kind) {
    case 'NUMBER': {
      advance(p);
      return { kind: 'NumberLit', value: tok.text, span: tok.span };
    }

    case 'STRING': {
      advance(p);
      // Determine encoding from text
      let encoding: 'utf8' | 'hex' | 'base64' = 'utf8';
      let value = tok.text;
      if (tok.text.startsWith('x"')) {
        encoding = 'hex';
        value = tok.text.slice(2, -1);
      } else if (tok.text.startsWith('b"')) {
        encoding = 'base64';
        value = tok.text.slice(2, -1);
      }
      return { kind: 'StringLit', value, encoding, span: tok.span };
    }

    case 'true':
    case 'false':
      advance(p);
      return { kind: 'BoolLit', value: tok.kind === 'true', span: tok.span };

    case 'IDENT':
      advance(p);
      return { kind: 'Identifier', name: tok.text, span: tok.span };

    case 'TYPE_IDENT': {
      // Type constructor: TypeName(args)
      advance(p);
      if (at(p, '(')) {
        const args = parseArgList(p);
        const end = peek(p, -1).span;
        return { kind: 'ConstructorExpr', typeName: tok.text, args, span: spanFrom(tok.span, end) };
      }
      // Just a type reference used as value (probably an error, but let's parse it)
      return { kind: 'Identifier', name: tok.text, span: tok.span };
    }

    case '(': {
      // Could be: grouping, tuple literal, struct literal
      const start = advance(p).span;
    
      if (match(p, ')')) {
        // Empty tuple ()
        return { kind: 'TupleLit', elements: [], span: spanFrom(start, peek(p, -1).span) };
      }

      // Parse first element
      const firstArg = parseArg(p);
    
      if (at(p, ')') && !firstArg.name) {
        // Single expression in parens - grouping
        expect(p, ')');
        return { kind: 'GroupExpr', expr: firstArg.value, span: spanFrom(start, peek(p, -1).span) };
      }

      // Multiple elements or named - tuple/struct literal
      const elements: Arg[] = [firstArg];
      while (match(p, ',')) {
              if (at(p, ')')) break;
        elements.push(parseArg(p));
            }

      const end = expect(p, ')');

      // Determine if struct or tuple based on named fields
      const hasNamed = elements.some(e => e.name !== undefined);
      if (hasNamed) {
        return { kind: 'StructLit', fields: elements, span: spanFrom(start, end.span) };
      }
      return { kind: 'TupleLit', elements, span: spanFrom(start, end.span) };
    }

    case 'if':
      return parseIfExpr(p);

    case 'match':
      return parseMatchExpr(p);

    default:
      addError(p, tok.span, `Unexpected token: ${tok.kind}`);
      advance(p);
      return { kind: 'ErrorExpr', message: `Unexpected ${tok.kind}`, span: tok.span };
  }
}

function parseArgList(p: ParserState): Arg[] {
  expect(p, '(');
  const args: Arg[] = [];

  if (!at(p, ')')) {
    args.push(parseArg(p));
    while (match(p, ',')) {
          if (at(p, ')')) break;
      args.push(parseArg(p));
    }
  }

  expect(p, ')');
  return args;
}

function parseIfExpr(p: ParserState): IfExpr {
  const start = expect(p, 'if').span;
  const condition = parseExpr(p);
  const thenBranch = parseBody(p);

  const elifBranches: Array<{ condition: Expr; body: Body; span: Span }> = [];
  while (match(p, 'elif')) {
    const elifStart = peek(p, -1).span;
    const elifCond = parseExpr(p);
    const elifBody = parseBody(p);
    elifBranches.push({ condition: elifCond, body: elifBody, span: spanFrom(elifStart, elifBody.span) });
  }

  let elseBranch: Body | undefined;
  if (match(p, 'else')) {
    elseBranch = parseBody(p);
  }

  const endSpan = elseBranch?.span ?? elifBranches[elifBranches.length - 1]?.span ?? thenBranch.span;
  return { kind: 'IfExpr', condition, thenBranch, elifBranches, elseBranch, span: spanFrom(start, endSpan) };
}

function parseMatchExpr(p: ParserState): MatchExpr {
  const start = expect(p, 'match').span;
  const subject = parseExpr(p);
  expect(p, '{');

  const arms: MatchArm[] = [];
  while (!at(p, '}') && !at(p, 'EOF')) {
    const arm = parseMatchArm(p);
    arms.push(arm);
    }

  const end = expect(p, '}');
  return { kind: 'MatchExpr', subject, arms, span: spanFrom(start, end.span) };
}

function parseMatchArm(p: ParserState): MatchArm {
  const startSpan = peek(p).span;
  const patterns = parseMatchPatterns(p);
  expect(p, '=>');

  // After =>, expect either a block { } or an expression
  let body: Body;
  if (at(p, '{')) {
    body = parseBlock(p);
  } else {
    const expr = parseExpr(p);
    body = { kind: 'ArrowBody', expr, span: expr.span };
  }

  return { patterns, body, span: spanFrom(startSpan, body.span) };
}

function parseMatchPatterns(p: ParserState): MatchPattern[] {
  const patterns: MatchPattern[] = [parseMatchPattern(p)];
  while (match(p, ',')) {
      // Check if we're at '=>' which means trailing comma
    if (at(p, '=>')) break;
    patterns.push(parseMatchPattern(p));
  }
  return patterns;
}

function parseMatchPattern(p: ParserState): MatchPattern {
  const tok = peek(p);

  // Wildcard pattern
  if (tok.kind === '_') {
    advance(p);
    return { kind: 'WildcardPattern', span: tok.span };
  }

  // Literal patterns
  if (tok.kind === 'NUMBER') {
    advance(p);
    const lit: NumberLit = { kind: 'NumberLit', value: tok.text, span: tok.span };
    return { kind: 'LiteralPattern', value: lit, span: tok.span };
  }

  if (tok.kind === 'STRING') {
    advance(p);
    let encoding: 'utf8' | 'hex' | 'base64' = 'utf8';
    let value = tok.text;
    if (tok.text.startsWith('x"')) {
      encoding = 'hex';
      value = tok.text.slice(2, -1);
    } else if (tok.text.startsWith('b"')) {
      encoding = 'base64';
      value = tok.text.slice(2, -1);
    }
    const lit: StringLit = { kind: 'StringLit', value, encoding, span: tok.span };
    return { kind: 'LiteralPattern', value: lit, span: tok.span };
  }

  if (tok.kind === 'true' || tok.kind === 'false') {
    advance(p);
    const lit: BoolLit = { kind: 'BoolLit', value: tok.kind === 'true', span: tok.span };
    return { kind: 'LiteralPattern', value: lit, span: tok.span };
  }

  addError(p, tok.span, `Expected pattern (literal or _), got ${tok.kind}`);
  advance(p);
  return { kind: 'WildcardPattern', span: tok.span };
}

// -----------------------------------------------------------------------------
// Pattern Parsing
// -----------------------------------------------------------------------------

function parsePattern(p: ParserState): Pattern {
  const tok = peek(p);

  if (tok.kind === 'IDENT') {
    advance(p);
    return { kind: 'IdentPattern', name: tok.text, span: tok.span };
  }

  if (tok.kind === '(') {
    return parseTupleOrStructPattern(p);
  }

  addError(p, tok.span, 'Expected pattern');
  advance(p);
  return { kind: 'ErrorPattern', message: 'Expected pattern', span: tok.span };
}

function parseTupleOrStructPattern(p: ParserState): Pattern {
  const start = expect(p, '(').span;

  if (match(p, ')')) {
    return { kind: 'TuplePattern', elements: [], span: spanFrom(start, peek(p, -1).span) };
  }

  // Check if first element is named (field: or field: binding)
  const firstTok = peek(p);
  const secondTok = peek(p, 1);

  if (firstTok.kind === 'IDENT' && secondTok.kind === ':') {
    // Struct pattern
    return parseStructPatternContinued(p, start);
  }

  // Tuple pattern
  const elements: PatternElement[] = [];
  elements.push({ pattern: parsePattern(p), span: peek(p, -1).span });

  while (match(p, ',')) {
      if (at(p, ')')) break;
    const elem = parsePattern(p);
    elements.push({ pattern: elem, span: elem.span });
  }

  const end = expect(p, ')');
  return { kind: 'TuplePattern', elements, span: spanFrom(start, end.span) };
}

function parseStructPatternContinued(p: ParserState, start: Span): StructPattern {
  const fields: PatternField[] = [];

  do {
      if (at(p, ')')) break;

    const fieldName = expect(p, 'IDENT').text;
    const fieldStart = peek(p, -1).span;
    expect(p, ':');

    let binding: string | undefined;
    if (at(p, 'IDENT')) {
      binding = advance(p).text;
    }

    fields.push({ fieldName, binding, span: spanFrom(fieldStart, peek(p, -1).span) });
  } while (match(p, ','));

  const end = expect(p, ')');
  return { kind: 'StructPattern', fields, span: spanFrom(start, end.span) };
}

// -----------------------------------------------------------------------------
// Body Parsing (Block or Arrow)
// -----------------------------------------------------------------------------

function parseBody(p: ParserState): Body {

  if (match(p, '=>')) {
    const expr = parseExpr(p);
    return { kind: 'ArrowBody', expr, span: expr.span };
  }

  if (at(p, '{')) {
    return parseBlock(p);
  }

  // Error - expected body
  const tok = peek(p);
  addError(p, tok.span, 'Expected { or =>');
  return { kind: 'BlockBody', stmts: [], span: tok.span };
}

function parseBlock(p: ParserState): BlockBody {
  const start = expect(p, '{').span;

  const stmts: Stmt[] = [];
  while (!at(p, '}') && !at(p, 'EOF')) {
    const stmt = parseStmt(p);
    stmts.push(stmt);
    }

  const end = expect(p, '}');
  return { kind: 'BlockBody', stmts, span: spanFrom(start, end.span) };
}

// -----------------------------------------------------------------------------
// Statement Parsing
// -----------------------------------------------------------------------------

function parseStmt(p: ParserState): Stmt {
  const tok = peek(p);

  switch (tok.kind) {
    case 'let':
      return parseLetStmt(p);
    case 'set':
      return parseSetStmt(p);
    case 'if':
      return parseIfStmt(p);
    case 'while':
      return parseWhileStmt(p);
    case 'for':
      return parseForStmt(p);
    case 'loop':
      return parseLoopStmt(p);
    case 'return':
      return parseReturnStmt(p);
    case 'break':
      return parseBreakStmt(p);
    case 'continue':
      return parseContinueStmt(p);
    default:
      return parseExprOrAssignStmt(p);
  }
}

function parseLetStmt(p: ParserState): LetStmt {
  const start = expect(p, 'let').span;
  const pattern = parsePattern(p);

  let type: Type | undefined;
  if (match(p, ':')) {
    type = parseType(p);
  }

  let init: Expr | undefined;
  if (match(p, '=')) {
    init = parseExpr(p);
  }

  const endSpan = init?.span ?? type?.span ?? pattern.span;
  return { kind: 'LetStmt', pattern, type, init, span: spanFrom(start, endSpan) };
}

function parseSetStmt(p: ParserState): SetStmt {
  const start = expect(p, 'set').span;
  const pattern = parsePattern(p);

  let type: Type | undefined;
  if (match(p, ':')) {
    type = parseType(p);
  }

  expect(p, '=');
  const value = parseExpr(p);

  return { kind: 'SetStmt', pattern, type, value, span: spanFrom(start, value.span) };
}

function parseIfStmt(p: ParserState): IfStmt {
  const start = expect(p, 'if').span;
  const condition = parseExpr(p);
  const thenBody = parseBody(p);

  const elifClauses: Array<{ condition: Expr; body: Body; span: Span }> = [];
  while (match(p, 'elif')) {
    const elifStart = peek(p, -1).span;
    const elifCond = parseExpr(p);
    const elifBody = parseBody(p);
    elifClauses.push({ condition: elifCond, body: elifBody, span: spanFrom(elifStart, elifBody.span) });
  }

  let elseBody: Body | undefined;
  if (match(p, 'else')) {
    elseBody = parseBody(p);
  }

  const endSpan = elseBody?.span ?? elifClauses[elifClauses.length - 1]?.span ?? thenBody.span;
  return { kind: 'IfStmt', condition, thenBody, elifClauses, elseBody, span: spanFrom(start, endSpan) };
}

function parseWhileStmt(p: ParserState): WhileStmt {
  const start = expect(p, 'while').span;
  const condition = parseExpr(p);
  const body = parseBody(p);
  return { kind: 'WhileStmt', condition, body, span: spanFrom(start, body.span) };
}

function parseForStmt(p: ParserState): ForStmt {
  const start = expect(p, 'for').span;
  const binding = expect(p, 'IDENT').text;

  let indexBinding: string | undefined;
  if (match(p, ',')) {
    indexBinding = binding;
    // Swap: first was index, second is element
    const elemBinding = expect(p, 'IDENT').text;
    // Actually grammar says: for_binding = identifier [ "," identifier ]
    // So first is element or index depending on interpretation
    // Let me re-read... "for i, elem in arr" - i is index, elem is element
    // But that contradicts the binding order. Let's keep it simple:
    // for x in ... -> x is element
    // for i, x in ... -> i is index, x is element
  }

  expect(p, 'in');
  const iterable = parseExpr(p);
  const body = parseBody(p);

  return { kind: 'ForStmt', binding: indexBinding ?? binding, indexBinding: indexBinding ? binding : undefined, iterable, body, span: spanFrom(start, body.span) };
}

function parseLoopStmt(p: ParserState): LoopStmt {
  const start = expect(p, 'loop').span;
  const body = parseBody(p);
  return { kind: 'LoopStmt', body, span: spanFrom(start, body.span) };
}

function parseReturnStmt(p: ParserState): ReturnStmt {
  const start = expect(p, 'return').span;

  let value: Expr | undefined;
  let when: Expr | undefined;

  // Check if there's an expression to return
  if (!at(p, 'when') && canStartExpr(p)) {
    value = parseExpr(p);
  }

  if (match(p, 'when')) {
    when = parseExpr(p);
  }

  const endSpan = when?.span ?? value?.span ?? start;
  return { kind: 'ReturnStmt', value, when, span: spanFrom(start, endSpan) };
}

function parseBreakStmt(p: ParserState): BreakStmt {
  const start = expect(p, 'break').span;

  let when: Expr | undefined;
  if (match(p, 'when')) {
    when = parseExpr(p);
  }

  return { kind: 'BreakStmt', when, span: spanFrom(start, when?.span ?? start) };
}

function parseContinueStmt(p: ParserState): ContinueStmt {
  const start = expect(p, 'continue').span;

  let when: Expr | undefined;
  if (match(p, 'when')) {
    when = parseExpr(p);
  }

  return { kind: 'ContinueStmt', when, span: spanFrom(start, when?.span ?? start) };
}

function parseExprOrAssignStmt(p: ParserState): Stmt {
  const expr = parseExpr(p);

  // Check for assignment
  const tok = peek(p);
  if (tok.kind === '=' || tok.kind === '+=' || tok.kind === '-=' || tok.kind === '*=' ||
      tok.kind === '/=' || tok.kind === '%=' || tok.kind === '&=' || tok.kind === '|=' ||
      tok.kind === '^=' || tok.kind === '<<=' || tok.kind === '>>=' ||
      tok.kind === '<<<=' || tok.kind === '>>>=' ||
      tok.kind === '+|=' || tok.kind === '-|=' || tok.kind === '*|=') {
    advance(p);
    const value = parseExpr(p);
    return { kind: 'AssignStmt', target: expr, op: tok.text, value, span: spanFrom(expr.span, value.span) };
  }

  return { kind: 'ExprStmt', expr, span: expr.span };
}

// -----------------------------------------------------------------------------
// Declaration Parsing
// -----------------------------------------------------------------------------

function parseDecl(p: ParserState): Decl {
  const tok = peek(p);

  switch (tok.kind) {
    case 'import':
      return parseImportDecl(p);
    case 'export':
      return parseExportDecl(p);
    case 'func':
    case 'inline':
      return parseFuncDecl(p);
    case 'type':
      return parseTypeDecl(p);
    case 'unique':
      return parseUniqueDecl(p);
    case 'def':
      return parseDefDecl(p);
    case 'global':
      return parseGlobalDecl(p);
    case 'memory':
      return parseMemoryDecl(p);
    case 'data':
      return parseDataDecl(p);
    default:
      addError(p, tok.span, `Unexpected token at top level: ${tok.kind}`);
      advance(p);  // Always advance past the unexpected token
      synchronize(p);
      return { kind: 'ErrorDecl', message: `Unexpected ${tok.kind}`, span: tok.span };
  }
}

function parseImportDecl(p: ParserState): ImportDecl {
  const start = expect(p, 'import').span;
  const module = expect(p, 'STRING').text;

  const items: ImportItem[] = [];

  if (match(p, '(')) {
    // Grouped imports
      while (!at(p, ')') && !at(p, 'EOF')) {
      const externalName = expect(p, 'STRING').text;
      const item = parseImportItem(p);
      items.push({ externalName, item, span: spanFrom(peek(p, -1).span, peek(p, -1).span) });
        }
    expect(p, ')');
  } else {
    // Single import
    const externalName = expect(p, 'STRING').text;
    const item = parseImportItem(p);
    items.push({ externalName, item, span: spanFrom(peek(p, -1).span, peek(p, -1).span) });
  }

  const endSpan = items.length > 0 ? items[items.length - 1].span : start;
  return { kind: 'ImportDecl', module, items, span: spanFrom(start, endSpan) };
}

function parseImportItem(p: ParserState): ImportItemKind {
  if (match(p, 'global')) {
    const name = expect(p, 'IDENT').text;
    expect(p, ':');
    const type = parseType(p);
    return { kind: 'global', name, type };
  }

  if (match(p, 'memory')) {
    const pages = parseInt(expect(p, 'NUMBER').text, 10);
    return { kind: 'memory', pages };
  }

  // Default: function signature
  const signature = parseFuncSignature(p);
  return { kind: 'func', signature };
}

function parseExportDecl(p: ParserState): ExportDecl {
  const start = expect(p, 'export').span;
  const exportName = expect(p, 'STRING').text;

  const tok = peek(p);
  let decl: FuncDecl | GlobalDecl | MemoryDecl;

  if (tok.kind === 'func' || tok.kind === 'inline') {
    decl = parseFuncDecl(p);
  } else if (tok.kind === 'global') {
    decl = parseGlobalDecl(p);
  } else if (tok.kind === 'memory') {
    decl = parseMemoryDecl(p);
  } else {
    addError(p, tok.span, 'Expected func, global, or memory after export');
    synchronize(p);
    // Return a dummy
    decl = { kind: 'FuncDecl', isInline: false, signature: { params: [] }, body: { kind: 'BlockBody', stmts: [], span: tok.span }, span: tok.span };
  }

  return { kind: 'ExportDecl', exportName, decl, span: spanFrom(start, decl.span) };
}

function parseFuncDecl(p: ParserState): FuncDecl {
  const start = peek(p).span;
  const isInline = match(p, 'inline');
  expect(p, 'func');

  let name: string | undefined;
  if (at(p, 'IDENT')) {
    name = advance(p).text;
  }

  const signature = parseFuncSignature(p);
  const body = parseBody(p);

  return { kind: 'FuncDecl', name, isInline, signature, body, span: spanFrom(start, body.span) };
}

function parseFuncSignature(p: ParserState): FuncSignature {
  const params: FuncParam[] = [];
  let returns: Type | NamedReturns | undefined;

  // Parameters
  if (at(p, '(')) {
    expect(p, '(');
  
    if (!at(p, ')')) {
      params.push(parseFuncParam(p));
      while (match(p, ',')) {
              if (at(p, ')')) break;
        params.push(parseFuncParam(p));
      }
    }

      expect(p, ')');
  } else if (at(p, 'IDENT') || at(p, 'TYPE_IDENT')) {
    // Single anonymous parameter (type only)
    const type = parseType(p);
    params.push({ type, span: type.span });
  }

  // Return type
  if (match(p, '->')) {
    if (at(p, '(')) {
      // Could be tuple return or named returns
      const start = advance(p).span;
    
      if (at(p, ')')) {
        // Empty parens - unit return
        advance(p);
        returns = { kind: 'TupleType', elements: [], span: spanFrom(start, peek(p, -1).span) };
      } else {
        // Check if named returns (name: type) or tuple
        const firstTok = peek(p);
        const secondTok = peek(p, 1);

        if (firstTok.kind === 'IDENT' && secondTok.kind === ':') {
          // Named returns
          const fields: Array<{ name: string; type: Type; span: Span }> = [];
          do {
                      if (at(p, ')')) break;
            const fieldStart = peek(p).span;
            const fieldName = expect(p, 'IDENT').text;
            expect(p, ':');
            const fieldType = parseType(p);
            fields.push({ name: fieldName, type: fieldType, span: spanFrom(fieldStart, fieldType.span) });
          } while (match(p, ','));
                  expect(p, ')');
          returns = { kind: 'NamedReturns', fields };
        } else {
          // Tuple return type
          const elements: Type[] = [parseType(p)];
          while (match(p, ',')) {
                      if (at(p, ')')) break;
            elements.push(parseType(p));
          }
                  expect(p, ')');
          returns = { kind: 'TupleType', elements, span: spanFrom(start, peek(p, -1).span) };
        }
      }
    } else {
      returns = parseType(p);
    }
  }

  return { params, returns };
}

function parseFuncParam(p: ParserState): FuncParam {
  const start = peek(p).span;

  // Check for named parameter: name: type
  if (peek(p).kind === 'IDENT' && peek(p, 1).kind === ':') {
    const name = advance(p).text;
    advance(p); // consume :
    const type = parseType(p);
    return { name, type, span: spanFrom(start, type.span) };
  }

  // Anonymous parameter (type only)
  const type = parseType(p);
  return { type, span: type.span };
}

function parseTypeDecl(p: ParserState): TypeDecl {
  const start = expect(p, 'type').span;
  const name = expect(p, 'TYPE_IDENT').text;
  expect(p, '=');
  const type = parseType(p);
  return { kind: 'TypeDecl', name, type, span: spanFrom(start, type.span) };
}

function parseUniqueDecl(p: ParserState): UniqueDecl {
  const start = expect(p, 'unique').span;
  const name = expect(p, 'TYPE_IDENT').text;
  expect(p, '=');
  const type = parseType(p);
  return { kind: 'UniqueDecl', name, type, span: spanFrom(start, type.span) };
}

function parseDefDecl(p: ParserState): DefDecl {
  const start = expect(p, 'def').span;
  const name = expect(p, 'IDENT').text;
  expect(p, '=');
  const value = parseExpr(p);
  return { kind: 'DefDecl', name, value, span: spanFrom(start, value.span) };
}

function parseGlobalDecl(p: ParserState): GlobalDecl {
  const start = expect(p, 'global').span;
  const name = expect(p, 'IDENT').text;

  let type: Type | undefined;
  if (match(p, ':')) {
    type = parseType(p);
  }

  let init: Expr | undefined;
  if (match(p, '=')) {
    init = parseExpr(p);
  }

  const endSpan = init?.span ?? type?.span ?? peek(p, -1).span;
  return { kind: 'GlobalDecl', name, type, init, span: spanFrom(start, endSpan) };
}

function parseMemoryDecl(p: ParserState): MemoryDecl {
  const start = expect(p, 'memory').span;
  const minPages = parseInt(expect(p, 'NUMBER').text, 10);

  let maxPages: number | undefined;
  if (at(p, 'NUMBER')) {
    maxPages = parseInt(advance(p).text, 10);
  }

  const endSpan = peek(p, -1).span;
  return { kind: 'MemoryDecl', minPages, maxPages, span: spanFrom(start, endSpan) };
}

function parseDataDecl(p: ParserState): DataDecl {
  const start = expect(p, 'data').span;
  const offset = parseInt(expect(p, 'NUMBER').text, 10);
  const value = parseExpr(p);
  return { kind: 'DataDecl', offset, value, span: spanFrom(start, value.span) };
}

// -----------------------------------------------------------------------------
// Module Parsing
// -----------------------------------------------------------------------------

function parseModule(p: ParserState): Module {
  const decls: Decl[] = [];

  while (!at(p, 'EOF')) {
    try {
      const decl = parseDecl(p);
      decls.push(decl);
    } catch (e) {
      // Recover from unexpected errors
      synchronize(p);
    }
    }

  const span: Span = decls.length > 0
    ? spanFrom(decls[0].span, decls[decls.length - 1].span)
    : { start: 0, end: 0 };

  return { kind: 'Module', decls, span };
}

// =============================================================================
// PUBLIC API
// =============================================================================

export function parse(src: string): ParseResult {
  const p = createParser(src);
  const ast = parseModule(p);
  return { ast, errors: p.errors };
}
