// =============================================================================
// Encantis Parser
// Error-tolerant recursive descent parser
// =============================================================================

import {
  Token, TokenKind, Span, Diagnostic,
  Type, PrimitiveType, SliceType, FixedArrayType, PointerType, TupleType, FunctionType,
  Expr, NumberLiteral, StringLiteral, Identifier, BinaryExpr, UnaryExpr,
  CallExpr, IndexExpr, MemberExpr, CastExpr, TupleExpr, TernaryExpr, ErrorExpr,
  Stmt, LocalDecl, Assignment, ExprStmt, ReturnStmt, IfStmt, WhileStmt,
  ForStmt, LoopStmt, BreakStmt, BranchStmt, ErrorStmt,
  Param, NamedReturn,
  Import, ImportGroup, ImportSingle, ImportItem,
  FuncDecl, FuncBody, ArrowBody, BlockBody,
  ExportDecl, MemoryDecl, GlobalDecl, DefineDecl,
  Module, ParseResult,
  spanFrom, spanUnion,
} from './types';
import { tokenize, TokenizeResult } from './lexer';

// -----------------------------------------------------------------------------
// Parser State
// -----------------------------------------------------------------------------

interface Parser {
  tokens: Token[];
  pos: number;
  src: string;
  errors: Diagnostic[];
}

// -----------------------------------------------------------------------------
// Parser Helpers
// -----------------------------------------------------------------------------

function peek(p: Parser, offset = 0): Token {
  const idx = p.pos + offset;
  return idx < p.tokens.length ? p.tokens[idx] : p.tokens[p.tokens.length - 1];
}

function at(p: Parser, kind: TokenKind): boolean {
  return peek(p).kind === kind;
}

function atAny(p: Parser, ...kinds: TokenKind[]): boolean {
  return kinds.includes(peek(p).kind);
}

function check(p: Parser, kind: TokenKind): Token | null {
  if (at(p, kind)) {
    return peek(p);
  }
  return null;
}

function advance(p: Parser): Token {
  const tok = peek(p);
  if (tok.kind !== 'EOF') {
    p.pos++;
  }
  return tok;
}

function expect(p: Parser, kind: TokenKind, hint?: string): Token {
  const tok = peek(p);
  if (tok.kind === kind) {
    return advance(p);
  }

  // Build helpful error message
  let message = `Expected '${kind}', but found '${tok.kind === 'EOF' ? 'end of file' : tok.text}'.`;
  if (hint) {
    message += ` ${hint}`;
  }

  addError(p, tok.span, message);

  // Return a synthetic token for error recovery
  return {
    kind,
    text: '',
    span: tok.span,
  };
}

function match(p: Parser, kind: TokenKind): Token | null {
  if (at(p, kind)) {
    return advance(p);
  }
  return null;
}

function addError(p: Parser, span: Span, message: string): void {
  p.errors.push({
    span,
    severity: 'error',
    message,
  });
}

// -----------------------------------------------------------------------------
// Error Recovery
// -----------------------------------------------------------------------------

// Skip tokens until we find a synchronization point
function synchronize(p: Parser): void {
  while (!at(p, 'EOF')) {
    // Statement/declaration boundaries
    if (atAny(p, 'func', 'export', 'import', 'global', 'local', 'memory', 'define', 'end')) {
      return;
    }
    advance(p);
  }
}

// Skip to the end of a block (matching 'end')
function skipToEnd(p: Parser): void {
  let depth = 1;
  while (!at(p, 'EOF') && depth > 0) {
    if (atAny(p, 'func', 'if', 'while', 'for', 'loop')) {
      depth++;
    } else if (at(p, 'end')) {
      depth--;
    }
    advance(p);
  }
}

// -----------------------------------------------------------------------------
// Type Parsing
// -----------------------------------------------------------------------------

function parseType(p: Parser): Type {
  const start = peek(p);

  // Pointer type: *T
  if (match(p, '*')) {
    const target = parseType(p);
    return {
      kind: 'PointerType',
      target,
      span: spanFrom(start, target),
    };
  }

  // Slice type: [T] or fixed array: [T*N]
  if (match(p, '[')) {
    const element = parseType(p);

    // Check for fixed array: [T*N]
    if (match(p, '*')) {
      const lengthTok = expect(p, 'NUMBER', 'Fixed array length must be a number.');
      const length = parseInt(lengthTok.text, 10);
      const end = expect(p, ']');
      return {
        kind: 'FixedArrayType',
        element,
        length,
        span: spanFrom(start, end),
      };
    }

    const end = expect(p, ']');
    return {
      kind: 'SliceType',
      element,
      span: spanFrom(start, end),
    };
  }

  // Tuple type: (T, T, ...) or function type: (T, T) -> T
  if (match(p, '(')) {
    const elements: Type[] = [];

    if (!at(p, ')')) {
      elements.push(parseType(p));
      while (match(p, ',') || (!at(p, ')') && !at(p, '->') && !at(p, 'EOF'))) {
        if (peek(p, -1).kind !== ',') {
          // Allow space-separated types like (i32 i32)
        }
        if (!at(p, ')') && !at(p, '->')) {
          elements.push(parseType(p));
        }
      }
    }

    const closeParen = expect(p, ')');

    // Check for function type: (T, T) -> T
    if (match(p, '->')) {
      const returnType = parseType(p);
      return {
        kind: 'FunctionType',
        params: elements,
        returns: returnType,
        span: spanFrom(start, returnType),
      };
    }

    return {
      kind: 'TupleType',
      elements,
      span: spanFrom(start, closeParen),
    };
  }

  // Primitive type: i32, u64, f64, etc.
  if (at(p, 'NAME')) {
    const tok = advance(p);
    return {
      kind: 'PrimitiveType',
      name: tok.text,
      span: tok.span,
    };
  }

  // Error: unexpected token
  const tok = peek(p);
  addError(p, tok.span, `Expected a type, but found '${tok.text}'. Valid types: i32, u32, i64, u64, f32, f64, [T], *T, (T, T).`);
  advance(p);
  return {
    kind: 'PrimitiveType',
    name: 'error',
    span: tok.span,
  };
}

// -----------------------------------------------------------------------------
// Expression Parsing (Precedence Climbing)
// -----------------------------------------------------------------------------

// Operator precedence (higher = tighter binding)
const PRECEDENCE: Record<string, number> = {
  'or': 1,
  'and': 2,
  '==': 3, '!=': 3, '<': 3, '>': 3, '<=': 3, '>=': 3,
  '|': 4,
  '^': 5,
  '&': 6,
  '<<': 7, '>>': 7, '<<<': 7, '>>>': 7,
  '+': 8, '-': 8,
  '*': 9, '/': 9, '%': 9,
};

function parseExpr(p: Parser, minPrec = 0): Expr {
  let left = parseUnary(p);

  while (true) {
    const tok = peek(p);
    const prec = PRECEDENCE[tok.kind] ?? PRECEDENCE[tok.text];

    if (prec === undefined || prec < minPrec) {
      break;
    }

    advance(p); // consume operator
    const right = parseExpr(p, prec + 1); // +1 for left-associativity

    left = {
      kind: 'BinaryExpr',
      op: tok.text,
      left,
      right,
      span: spanFrom(left, right),
    };
  }

  // Check for ternary: expr ? expr : expr
  if (match(p, '?')) {
    // This is non-standard but shown in examples
  }

  // Check for 'as' cast: expr as Type
  if (match(p, 'as')) {
    const type = parseType(p);
    left = {
      kind: 'CastExpr',
      expr: left,
      type,
      span: spanFrom(left, type),
    };
  }

  return left;
}

function parseUnary(p: Parser): Expr {
  const tok = peek(p);

  // Unary minus
  if (tok.kind === '-' && !isAtExprEnd(p, -1)) {
    advance(p);
    const operand = parseUnary(p);
    return {
      kind: 'UnaryExpr',
      op: '-',
      operand,
      span: spanFrom(tok, operand),
    };
  }

  // Logical not
  if (at(p, 'not')) {
    advance(p);
    const operand = parseUnary(p);
    return {
      kind: 'UnaryExpr',
      op: 'not',
      operand,
      span: spanFrom(tok, operand),
    };
  }

  // Bitwise not
  if (tok.kind === '~') {
    advance(p);
    const operand = parseUnary(p);
    return {
      kind: 'UnaryExpr',
      op: '~',
      operand,
      span: spanFrom(tok, operand),
    };
  }

  return parsePostfix(p);
}

function isAtExprEnd(p: Parser, offset: number): boolean {
  const prev = peek(p, offset);
  return prev.kind === 'NUMBER' || prev.kind === 'NAME' || prev.kind === ')' || prev.kind === ']';
}

function parsePostfix(p: Parser): Expr {
  let expr = parsePrimary(p);

  while (true) {
    // Function call: expr(args)
    if (at(p, '(')) {
      advance(p);
      const args: Expr[] = [];

      if (!at(p, ')')) {
        args.push(parseExpr(p));
        while (match(p, ',')) {
          args.push(parseExpr(p));
        }
      }

      const end = expect(p, ')');
      expr = {
        kind: 'CallExpr',
        callee: expr,
        args,
        span: spanFrom(expr, end),
      };
      continue;
    }

    // Index: expr[index]
    if (at(p, '[')) {
      advance(p);
      const index = parseExpr(p);
      const end = expect(p, ']');
      expr = {
        kind: 'IndexExpr',
        object: expr,
        index,
        span: spanFrom(expr, end),
      };
      continue;
    }

    // Member access: expr.member or expr.*
    if (at(p, '.')) {
      advance(p);
      const tok = peek(p);

      if (tok.kind === 'NAME' || tok.kind === 'NUMBER' || tok.kind === '*') {
        advance(p);
        expr = {
          kind: 'MemberExpr',
          object: expr,
          member: tok.text,
          span: spanFrom(expr, tok),
        };
        continue;
      }

      addError(p, tok.span, `Expected property name after '.', but found '${tok.text}'.`);
    }

    break;
  }

  return expr;
}

function parsePrimary(p: Parser): Expr {
  const tok = peek(p);

  // Number literal
  if (tok.kind === 'NUMBER') {
    advance(p);

    // Check for type annotation: 100:u32
    let suffix: string | undefined;
    if (match(p, ':')) {
      const typeTok = expect(p, 'NAME', 'Expected type name after ":".');
      suffix = typeTok.text;
    }

    return {
      kind: 'NumberLiteral',
      value: tok.text,
      suffix,
      span: suffix ? spanFrom(tok, peek(p, -1)) : tok.span,
    };
  }

  // String literal
  if (tok.kind === 'STRING') {
    advance(p);
    // Parse string content (remove quotes, handle escapes)
    const raw = tok.text;
    const value = parseStringContent(raw);
    return {
      kind: 'StringLiteral',
      value,
      raw,
      span: tok.span,
    };
  }

  // Identifier
  if (tok.kind === 'NAME') {
    advance(p);
    return {
      kind: 'Identifier',
      name: tok.text,
      span: tok.span,
    };
  }

  // Parenthesized expression or tuple
  if (tok.kind === '(') {
    advance(p);

    // Empty tuple
    if (at(p, ')')) {
      const end = advance(p);
      return {
        kind: 'TupleExpr',
        elements: [],
        span: spanFrom(tok, end),
      };
    }

    const first = parseExpr(p);

    // Check for tuple: (a, b, c)
    if (at(p, ',')) {
      const elements: Expr[] = [first];
      while (match(p, ',')) {
        elements.push(parseExpr(p));
      }
      const end = expect(p, ')');
      return {
        kind: 'TupleExpr',
        elements,
        span: spanFrom(tok, end),
      };
    }

    // Just parenthesized expression
    expect(p, ')');
    return first;
  }

  // Error: unexpected token
  addError(p, tok.span, `Expected an expression, but found '${tok.text}'.`);
  advance(p);
  return {
    kind: 'ErrorExpr',
    message: `Unexpected token: ${tok.text}`,
    span: tok.span,
  };
}

function parseStringContent(raw: string): string {
  // Remove quotes
  const inner = raw.slice(1, -1);

  // Process escape sequences
  let result = '';
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === '\\' && i + 1 < inner.length) {
      const next = inner[i + 1];
      switch (next) {
        case 'n': result += '\n'; i += 2; break;
        case 't': result += '\t'; i += 2; break;
        case 'r': result += '\r'; i += 2; break;
        case '\\': result += '\\'; i += 2; break;
        case '"': result += '"'; i += 2; break;
        case "'": result += "'"; i += 2; break;
        case '0': result += '\0'; i += 2; break;
        case 'x':
          if (i + 3 < inner.length) {
            const hex = inner.slice(i + 2, i + 4);
            result += String.fromCharCode(parseInt(hex, 16));
            i += 4;
          } else {
            result += next;
            i += 2;
          }
          break;
        default:
          result += next;
          i += 2;
      }
    } else {
      result += inner[i];
      i++;
    }
  }

  return result;
}

// -----------------------------------------------------------------------------
// Statement Parsing
// -----------------------------------------------------------------------------

function parseStmt(p: Parser): Stmt {
  // Local declaration: local name: type = expr
  if (at(p, 'local')) {
    return parseLocalDecl(p);
  }

  // Return statement: return expr [when cond]
  if (at(p, 'return')) {
    return parseReturnStmt(p);
  }

  // If statement
  if (at(p, 'if')) {
    return parseIfStmt(p);
  }

  // While statement
  if (at(p, 'while')) {
    return parseWhileStmt(p);
  }

  // For statement
  if (at(p, 'for')) {
    return parseForStmt(p);
  }

  // Loop statement
  if (at(p, 'loop')) {
    return parseLoopStmt(p);
  }

  // Break statement
  if (at(p, 'break')) {
    const tok = advance(p);
    return { kind: 'BreakStmt', span: tok.span };
  }

  // Branch statement: br [when cond]
  if (at(p, 'br')) {
    const tok = advance(p);
    let condition: Expr | undefined;
    if (match(p, 'when')) {
      condition = parseExpr(p);
    }
    return {
      kind: 'BranchStmt',
      condition,
      span: condition ? spanFrom(tok, condition) : tok.span,
    };
  }

  // Expression or assignment
  return parseExprOrAssignment(p);
}

function parseLocalDecl(p: Parser): LocalDecl {
  const start = expect(p, 'local');
  const nameTok = expect(p, 'NAME', 'Expected variable name after "local".');
  const name = nameTok.text;

  let type: Type | undefined;
  let init: Expr | undefined;

  // Optional type annotation
  if (match(p, ':')) {
    type = parseType(p);
  }

  // Optional initializer
  if (match(p, '=')) {
    init = parseExpr(p);
  }

  return {
    kind: 'LocalDecl',
    name,
    type,
    init,
    span: spanFrom(start, init ?? type ?? nameTok),
  };
}

function parseReturnStmt(p: Parser): ReturnStmt {
  const start = expect(p, 'return');

  // Check for immediate 'when' (return when cond)
  if (at(p, 'when')) {
    advance(p);
    const condition = parseExpr(p);
    return {
      kind: 'ReturnStmt',
      condition,
      span: spanFrom(start, condition),
    };
  }

  // Check for value
  if (!atAny(p, 'end', 'else', 'elif', 'EOF') && !isStatementStart(p)) {
    const value = parseExpr(p);

    // Check for 'when' after value
    if (match(p, 'when')) {
      const condition = parseExpr(p);
      return {
        kind: 'ReturnStmt',
        value,
        condition,
        span: spanFrom(start, condition),
      };
    }

    return {
      kind: 'ReturnStmt',
      value,
      span: spanFrom(start, value),
    };
  }

  return {
    kind: 'ReturnStmt',
    span: start.span,
  };
}

function isStatementStart(p: Parser): boolean {
  return atAny(p, 'local', 'return', 'if', 'while', 'for', 'loop', 'break', 'br');
}

function parseIfStmt(p: Parser): IfStmt {
  const start = expect(p, 'if');
  const condition = parseExpr(p);
  expect(p, 'then', 'Expected "then" after if condition.');

  const thenBody: Stmt[] = [];
  while (!atAny(p, 'else', 'elif', 'end', 'EOF')) {
    thenBody.push(parseStmt(p));
  }

  let elseBody: Stmt[] | undefined;

  if (match(p, 'elif')) {
    // Treat elif as nested if in else
    p.pos--; // Back up to re-parse as 'if'
    p.tokens[p.pos] = { ...p.tokens[p.pos], kind: 'if', text: 'if' };
    elseBody = [parseIfStmt(p)];
  } else if (match(p, 'else')) {
    elseBody = [];
    while (!atAny(p, 'end', 'EOF')) {
      elseBody.push(parseStmt(p));
    }
  }

  const end = expect(p, 'end', 'Expected "end" to close if statement.');

  return {
    kind: 'IfStmt',
    condition,
    thenBody,
    elseBody,
    span: spanFrom(start, end),
  };
}

function parseWhileStmt(p: Parser): WhileStmt {
  const start = expect(p, 'while');
  const condition = parseExpr(p);
  expect(p, 'do', 'Expected "do" after while condition.');

  const body: Stmt[] = [];
  while (!atAny(p, 'end', 'EOF')) {
    body.push(parseStmt(p));
  }

  const end = expect(p, 'end', 'Expected "end" to close while loop.');

  return {
    kind: 'WhileStmt',
    condition,
    body,
    span: spanFrom(start, end),
  };
}

function parseForStmt(p: Parser): ForStmt {
  const start = expect(p, 'for');

  // Variable(s): for i or for (i, v)
  let variable: string;
  let variableType: Type | undefined;

  if (match(p, '(')) {
    // Tuple pattern for (index, value)
    const nameTok = expect(p, 'NAME');
    variable = nameTok.text;
    if (match(p, ':')) {
      variableType = parseType(p);
    }
    // Skip second variable for now (we'll handle it in checker)
    if (match(p, ',')) {
      expect(p, 'NAME');
      if (match(p, ':')) {
        parseType(p);
      }
    }
    expect(p, ')');
  } else {
    const nameTok = expect(p, 'NAME', 'Expected variable name after "for".');
    variable = nameTok.text;
    if (match(p, ':')) {
      variableType = parseType(p);
    }
  }

  expect(p, 'in', 'Expected "in" after for variable.');
  const iterable = parseExpr(p);
  expect(p, 'do', 'Expected "do" after for iterable.');

  const body: Stmt[] = [];
  while (!atAny(p, 'end', 'EOF')) {
    body.push(parseStmt(p));
  }

  const end = expect(p, 'end', 'Expected "end" to close for loop.');

  return {
    kind: 'ForStmt',
    variable,
    variableType,
    iterable,
    body,
    span: spanFrom(start, end),
  };
}

function parseLoopStmt(p: Parser): LoopStmt {
  const start = expect(p, 'loop');

  const body: Stmt[] = [];
  while (!atAny(p, 'end', 'EOF')) {
    body.push(parseStmt(p));
  }

  const end = expect(p, 'end', 'Expected "end" to close loop.');

  return {
    kind: 'LoopStmt',
    body,
    span: spanFrom(start, end),
  };
}

function parseExprOrAssignment(p: Parser): Stmt {
  // Parse first expression
  const first = parseExpr(p);

  // Check for multi-target assignment: a, b = expr
  if (at(p, ',')) {
    const targets: Identifier[] = [];

    if (first.kind !== 'Identifier') {
      addError(p, first.span, 'Assignment target must be a variable name.');
    } else {
      targets.push(first);
    }

    while (match(p, ',')) {
      const expr = parseExpr(p);
      if (expr.kind !== 'Identifier') {
        addError(p, expr.span, 'Assignment target must be a variable name.');
      } else {
        targets.push(expr);
      }
    }

    expect(p, '=', 'Expected "=" in multi-target assignment.');
    const value = parseExpr(p);

    return {
      kind: 'Assignment',
      targets,
      value,
      span: spanFrom(first, value),
    };
  }

  // Check for simple assignment: a = expr
  if (at(p, '=')) {
    advance(p);
    const value = parseExpr(p);

    if (first.kind !== 'Identifier') {
      addError(p, first.span, 'Assignment target must be a variable name.');
    }

    return {
      kind: 'Assignment',
      targets: first.kind === 'Identifier' ? [first] : [],
      value,
      span: spanFrom(first, value),
    };
  }

  // Check for compound assignment: a += expr
  const compoundOps = ['+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '<<<=', '>>>='];
  const tok = peek(p);
  if (compoundOps.includes(tok.kind)) {
    advance(p);
    const value = parseExpr(p);

    if (first.kind !== 'Identifier') {
      addError(p, first.span, 'Compound assignment target must be a variable name.');
    }

    return {
      kind: 'Assignment',
      targets: first.kind === 'Identifier' ? [first] : [],
      op: tok.kind,
      value,
      span: spanFrom(first, value),
    };
  }

  // Just an expression statement
  return {
    kind: 'ExprStmt',
    expr: first,
    span: first.span,
  };
}

// -----------------------------------------------------------------------------
// Top-Level Parsing
// -----------------------------------------------------------------------------

function parseParam(p: Parser): Param {
  const nameTok = expect(p, 'NAME', 'Expected parameter name.');
  expect(p, ':', 'Expected ":" after parameter name.');
  const type = parseType(p);

  return {
    name: nameTok.text,
    type,
    span: spanFrom(nameTok, type),
  };
}

function parseParamList(p: Parser): Param[] {
  expect(p, '(');
  const params: Param[] = [];

  if (!at(p, ')')) {
    // Check for type-only params like ([u8], f64, [u8])
    if (at(p, '[') || (at(p, 'NAME') && (peek(p, 1).kind === ',' || peek(p, 1).kind === ')'))) {
      // Type-only list
      const type = parseType(p);
      params.push({ name: `_${params.length}`, type, span: type.span });

      while (match(p, ',')) {
        const t = parseType(p);
        params.push({ name: `_${params.length}`, type: t, span: t.span });
      }
    } else {
      // Named params
      params.push(parseParam(p));
      while (match(p, ',')) {
        params.push(parseParam(p));
      }
    }
  }

  expect(p, ')');
  return params;
}

function parseFuncDecl(p: Parser): FuncDecl {
  const start = expect(p, 'func');

  // Optional name
  let name: string | undefined;
  if (at(p, 'NAME') && peek(p, 1).kind === '(') {
    name = advance(p).text;
  }

  // Parameters
  const params = parseParamList(p);

  // Return type
  let returnType: Type | NamedReturn | undefined;
  if (match(p, '->')) {
    // Check for named returns: (d:f64, a:f64)
    if (at(p, '(') && peek(p, 1).kind === 'NAME' && peek(p, 2).kind === ':') {
      advance(p); // consume '('
      const returnParams: Param[] = [];
      returnParams.push(parseParam(p));
      while (match(p, ',')) {
        returnParams.push(parseParam(p));
      }
      expect(p, ')');
      returnType = { params: returnParams, span: spanFrom(start, peek(p, -1)) };
    } else {
      returnType = parseType(p);
    }
  }

  // Body: arrow or block
  let body: FuncBody | undefined;

  if (match(p, '=>')) {
    // Arrow body: => expr, expr
    const exprs: Expr[] = [];
    exprs.push(parseExpr(p));
    while (match(p, ',')) {
      exprs.push(parseExpr(p));
    }
    body = {
      kind: 'ArrowBody',
      exprs,
      span: spanFrom(exprs[0], exprs[exprs.length - 1]),
    };
  } else if (!at(p, 'EOF') && !atAny(p, 'export', 'import', 'global', 'memory', 'define', 'func')) {
    // Block body
    const stmts: Stmt[] = [];
    while (!atAny(p, 'end', 'EOF')) {
      stmts.push(parseStmt(p));
    }
    const end = expect(p, 'end', 'Expected "end" to close function body.');
    body = {
      kind: 'BlockBody',
      stmts,
      span: spanFrom(start, end),
    };
  }

  return {
    kind: 'FuncDecl',
    name,
    params,
    returnType,
    body,
    span: spanFrom(start, body ?? (returnType as any) ?? peek(p, -1)),
  };
}

function parseImport(p: Parser): Import {
  const start = expect(p, 'import');
  const moduleStr = expect(p, 'STRING', 'Expected module name string after "import".');
  const module = parseStringContent(moduleStr.text);

  // Grouped import: import "math" ( ... )
  if (at(p, '(')) {
    advance(p);
    const items: ImportItem[] = [];

    while (!atAny(p, ')', 'EOF')) {
      const exportStr = expect(p, 'STRING', 'Expected export name string in import group.');
      const exportName = parseStringContent(exportStr.text);
      expect(p, 'func', 'Expected "func" after export name in import.');

      // Optional local name
      let localName: string | undefined;
      if (at(p, 'NAME') && peek(p, 1).kind === '(') {
        localName = advance(p).text;
      }

      const params = parseParamList(p);

      let returnType: Type | undefined;
      if (match(p, '->')) {
        returnType = parseType(p);
      }

      items.push({
        exportName,
        localName,
        params,
        returnType,
        span: spanFrom(exportStr, returnType ?? peek(p, -1)),
      });
    }

    const end = expect(p, ')');
    return {
      kind: 'ImportGroup',
      module,
      items,
      span: spanFrom(start, end),
    };
  }

  // Single import: import "sys" "print-f64-pair" func print (...)
  const exportStr = expect(p, 'STRING', 'Expected export name string after module name.');
  const exportName = parseStringContent(exportStr.text);
  expect(p, 'func', 'Expected "func" after export name in import.');

  let localName: string | undefined;
  if (at(p, 'NAME')) {
    localName = advance(p).text;
  }

  // Parse function type
  const params = parseParamList(p);
  let returns: Type = { kind: 'TupleType', elements: [], span: peek(p).span };
  if (match(p, '->')) {
    returns = parseType(p);
  }

  const funcType: FunctionType = {
    kind: 'FunctionType',
    params: params.map(p => p.type),
    returns,
    span: spanFrom(start, returns),
  };

  return {
    kind: 'ImportSingle',
    module,
    exportName,
    localName,
    funcType,
    span: spanFrom(start, funcType),
  };
}

function parseExport(p: Parser): ExportDecl {
  const start = expect(p, 'export');
  const nameStr = expect(p, 'STRING', 'Expected export name string after "export".');
  const exportName = parseStringContent(nameStr.text);

  // What follows? func, memory, global
  if (at(p, 'func')) {
    const decl = parseFuncDecl(p);
    return {
      kind: 'ExportDecl',
      exportName,
      decl,
      span: spanFrom(start, decl),
    };
  }

  if (at(p, 'memory')) {
    const memStart = advance(p);
    let name: string | undefined;
    if (at(p, 'NAME')) {
      name = advance(p).text;
    }
    const pagesTok = expect(p, 'NUMBER', 'Expected number of pages for memory.');
    const pages = parseInt(pagesTok.text, 10);

    const decl: MemoryDecl = {
      kind: 'MemoryDecl',
      name,
      pages,
      span: spanFrom(memStart, pagesTok),
    };

    return {
      kind: 'ExportDecl',
      exportName,
      decl,
      span: spanFrom(start, decl),
    };
  }

  // Error
  addError(p, peek(p).span, 'Expected "func" or "memory" after export name.');
  synchronize(p);

  // Return placeholder
  return {
    kind: 'ExportDecl',
    exportName,
    decl: {
      kind: 'FuncDecl',
      params: [],
      span: start.span,
    },
    span: start.span,
  };
}

function parseGlobal(p: Parser): GlobalDecl {
  const start = expect(p, 'global');

  const mutable = !!match(p, 'mut');
  const nameTok = expect(p, 'NAME', 'Expected global variable name.');
  const name = nameTok.text;

  let type: Type | undefined;
  if (match(p, ':')) {
    type = parseType(p);
  }

  expect(p, '=', 'Expected "=" in global declaration.');
  const init = parseExpr(p);

  return {
    kind: 'GlobalDecl',
    name,
    mutable,
    type,
    init,
    span: spanFrom(start, init),
  };
}

function parseMemory(p: Parser): MemoryDecl {
  const start = expect(p, 'memory');

  let name: string | undefined;
  if (at(p, 'NAME')) {
    name = advance(p).text;
  }

  const pagesTok = expect(p, 'NUMBER', 'Expected number of pages for memory.');
  const pages = parseInt(pagesTok.text, 10);

  return {
    kind: 'MemoryDecl',
    name,
    pages,
    span: spanFrom(start, pagesTok),
  };
}

function parseModule(p: Parser): Module {
  const imports: Import[] = [];
  const exports: ExportDecl[] = [];
  const globals: GlobalDecl[] = [];
  const memories: MemoryDecl[] = [];
  const defines: DefineDecl[] = [];
  const functions: FuncDecl[] = [];

  const start = peek(p);

  while (!at(p, 'EOF')) {
    if (at(p, 'import')) {
      imports.push(parseImport(p));
    } else if (at(p, 'export')) {
      exports.push(parseExport(p));
    } else if (at(p, 'global')) {
      globals.push(parseGlobal(p));
    } else if (at(p, 'memory')) {
      memories.push(parseMemory(p));
    } else if (at(p, 'func')) {
      functions.push(parseFuncDecl(p));
    } else {
      // Unexpected token
      const tok = peek(p);
      addError(p, tok.span, `Unexpected '${tok.text}' at module level. Expected: import, export, func, global, or memory.`);
      synchronize(p);
    }
  }

  const end = peek(p);

  return {
    kind: 'Module',
    imports,
    exports,
    globals,
    memories,
    defines,
    functions,
    span: { start: start.span.start, end: end.span.end },
  };
}

// -----------------------------------------------------------------------------
// Main Parse Function
// -----------------------------------------------------------------------------

export function parse(src: string): ParseResult {
  const { tokens, errors: lexErrors } = tokenize(src);

  const p: Parser = {
    tokens,
    pos: 0,
    src,
    errors: [...lexErrors],
  };

  const ast = parseModule(p);

  return {
    ast,
    errors: p.errors,
  };
}
