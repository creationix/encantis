// Encantis Parser v2 Test Suite
// Table-driven tests with input strings and expected AST structures

import { describe, test, expect } from 'bun:test';
import {
  tokenize,
  parse,
  type Token,
  type TokenKind,
  type Expr,
  type Stmt,
  type Decl,
  type Type,
  type Pattern,
  type Module,
  type ParseResult,
} from './parser2';

// =============================================================================
// LEXER TESTS
// =============================================================================

describe('Lexer', () => {
  describe('Number literals', () => {
    const cases: Array<{ input: string; kind: TokenKind; text: string }> = [
      { input: '42', kind: 'NUMBER', text: '42' },
      { input: '0', kind: 'NUMBER', text: '0' },
      { input: '123456789', kind: 'NUMBER', text: '123456789' },
      { input: '3.14', kind: 'NUMBER', text: '3.14' },
      { input: '0.5', kind: 'NUMBER', text: '0.5' },
      { input: '1e10', kind: 'NUMBER', text: '1e10' },
      { input: '1E10', kind: 'NUMBER', text: '1E10' },
      { input: '1e+10', kind: 'NUMBER', text: '1e+10' },
      { input: '1e-10', kind: 'NUMBER', text: '1e-10' },
      { input: '3.14e2', kind: 'NUMBER', text: '3.14e2' },
      { input: '0x1A', kind: 'NUMBER', text: '0x1A' },
      { input: '0xFF', kind: 'NUMBER', text: '0xFF' },
      { input: '0xDEADBEEF', kind: 'NUMBER', text: '0xDEADBEEF' },
      { input: '0b1010', kind: 'NUMBER', text: '0b1010' },
      { input: '0b11111111', kind: 'NUMBER', text: '0b11111111' },
      { input: '0o755', kind: 'NUMBER', text: '0o755' },
      { input: '0o777', kind: 'NUMBER', text: '0o777' },
    ];

    for (const { input, kind, text } of cases) {
      test(`tokenizes ${input}`, () => {
        const { tokens, errors } = tokenize(input);
        expect(errors).toHaveLength(0);
        expect(tokens[0].kind).toBe(kind);
        expect(tokens[0].text).toBe(text);
      });
    }
  });

  describe('String literals', () => {
    const cases: Array<{ input: string; text: string }> = [
      { input: '"hello"', text: 'hello' },
      { input: '""', text: '' },
      { input: '"hello world"', text: 'hello world' },
      { input: '"line1\\nline2"', text: 'line1\nline2' },
      { input: '"tab\\there"', text: 'tab\there' },
      { input: '"quote\\"here"', text: 'quote"here' },
      { input: '"backslash\\\\"', text: 'backslash\\' },
      { input: '"hex\\x41"', text: 'hexA' },
    ];

    for (const { input, text } of cases) {
      test(`tokenizes ${input}`, () => {
        const { tokens, errors } = tokenize(input);
        expect(errors).toHaveLength(0);
        expect(tokens[0].kind).toBe('STRING');
        expect(tokens[0].text).toBe(text);
      });
    }
  });

  describe('Hex strings', () => {
    test('tokenizes simple hex string', () => {
      const { tokens, errors } = tokenize('x"48656C6C6F"');
      expect(errors).toHaveLength(0);
      expect(tokens[0].kind).toBe('STRING');
      expect(tokens[0].text).toContain('x"');
    });

    test('tokenizes hex string with spaces', () => {
      const { tokens, errors } = tokenize('x"48 65 6C 6C 6F"');
      expect(errors).toHaveLength(0);
      expect(tokens[0].kind).toBe('STRING');
    });

    test('handles incomplete hex byte', () => {
      const { tokens, errors } = tokenize('x"4"');
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('Base64 strings', () => {
    test('tokenizes simple base64 string', () => {
      const { tokens, errors } = tokenize('b"SGVsbG8="');
      expect(errors).toHaveLength(0);
      expect(tokens[0].kind).toBe('STRING');
      expect(tokens[0].text).toContain('b"');
    });

    test('tokenizes base64 string with padding', () => {
      const { tokens, errors } = tokenize('b"SGVsbG8gV29ybGQ="');
      expect(errors).toHaveLength(0);
      expect(tokens[0].kind).toBe('STRING');
    });
  });

  describe('Identifiers and keywords', () => {
    const cases: Array<{ input: string; kind: TokenKind; text: string }> = [
      { input: 'foo', kind: 'IDENT', text: 'foo' },
      { input: 'bar123', kind: 'IDENT', text: 'bar123' },
      { input: 'my-var', kind: 'IDENT', text: 'my-var' },
      { input: 'my_var', kind: 'IDENT', text: 'my_var' },
      { input: 'MyType', kind: 'TYPE_IDENT', text: 'MyType' },
      { input: 'Vec3', kind: 'TYPE_IDENT', text: 'Vec3' },
      { input: 'if', kind: 'if', text: 'if' },
      { input: 'elif', kind: 'elif', text: 'elif' },
      { input: 'else', kind: 'else', text: 'else' },
      { input: 'while', kind: 'while', text: 'while' },
      { input: 'for', kind: 'for', text: 'for' },
      { input: 'in', kind: 'in', text: 'in' },
      { input: 'loop', kind: 'loop', text: 'loop' },
      { input: 'break', kind: 'break', text: 'break' },
      { input: 'continue', kind: 'continue', text: 'continue' },
      { input: 'return', kind: 'return', text: 'return' },
      { input: 'when', kind: 'when', text: 'when' },
      { input: 'func', kind: 'func', text: 'func' },
      { input: 'let', kind: 'let', text: 'let' },
      { input: 'set', kind: 'set', text: 'set' },
      { input: 'global', kind: 'global', text: 'global' },
      { input: 'def', kind: 'def', text: 'def' },
      { input: 'type', kind: 'type', text: 'type' },
      { input: 'import', kind: 'import', text: 'import' },
      { input: 'export', kind: 'export', text: 'export' },
      { input: 'memory', kind: 'memory', text: 'memory' },
      { input: 'data', kind: 'data', text: 'data' },
      { input: 'inline', kind: 'inline', text: 'inline' },
      { input: 'unique', kind: 'unique', text: 'unique' },
      { input: 'as', kind: 'as', text: 'as' },
      { input: 'true', kind: 'true', text: 'true' },
      { input: 'false', kind: 'false', text: 'false' },
      // Primitive types are identifiers (not keywords)
      { input: 'i32', kind: 'IDENT', text: 'i32' },
      { input: 'f64', kind: 'IDENT', text: 'f64' },
      { input: 'bool', kind: 'IDENT', text: 'bool' },
    ];

    for (const { input, kind, text } of cases) {
      test(`tokenizes ${input} as ${kind}`, () => {
        const { tokens, errors } = tokenize(input);
        expect(errors).toHaveLength(0);
        expect(tokens[0].kind).toBe(kind);
        expect(tokens[0].text).toBe(text);
      });
    }
  });

  describe('Operators', () => {
    const cases: Array<{ input: string; kinds: TokenKind[] }> = [
      { input: '+ - * / %', kinds: ['+', '-', '*', '/', '%'] },
      { input: '& | ^ ~', kinds: ['&', '|', '^', '~'] },
      { input: '<< >> <<< >>>', kinds: ['<<', '>>', '<<<', '>>>'] },
      { input: '== != < > <= >=', kinds: ['==', '!=', '<', '>', '<=', '>='] },
      { input: '&& || !', kinds: ['&&', '||', '!'] },
      { input: '= += -= *= /= %=', kinds: ['=', '+=', '-=', '*=', '/=', '%='] },
      { input: '&= |= ^= <<= >>=', kinds: ['&=', '|=', '^=', '<<=', '>>='] },
      { input: '<<<= >>>=', kinds: ['<<<=', '>>>='] },
      { input: '-> =>', kinds: ['->', '=>'] },
      { input: '( ) [ ] { }', kinds: ['(', ')', '[', ']', '{', '}'] },
      { input: ', : .', kinds: [',', ':', '.'] },
    ];

    for (const { input, kinds } of cases) {
      test(`tokenizes operators: ${input}`, () => {
        const { tokens, errors } = tokenize(input);
        expect(errors).toHaveLength(0);
        const opTokens = tokens.filter(t => t.kind !== 'EOF' && t.kind !== 'NEWLINE');
        expect(opTokens.map(t => t.kind)).toEqual(kinds);
      });
    }
  });

  describe('Comments', () => {
    test('skips line comments', () => {
      const { tokens, errors } = tokenize('foo // this is a comment\nbar');
      expect(errors).toHaveLength(0);
      const idents = tokens.filter(t => t.kind === 'IDENT');
      expect(idents.map(t => t.text)).toEqual(['foo', 'bar']);
    });

    test('skips block comments', () => {
      const { tokens, errors } = tokenize('foo /* block comment */ bar');
      expect(errors).toHaveLength(0);
      const idents = tokens.filter(t => t.kind === 'IDENT');
      expect(idents.map(t => t.text)).toEqual(['foo', 'bar']);
    });

    test('handles multiline block comments', () => {
      const { tokens, errors } = tokenize('foo /* line 1\nline 2\nline 3 */ bar');
      expect(errors).toHaveLength(0);
      const idents = tokens.filter(t => t.kind === 'IDENT');
      expect(idents.map(t => t.text)).toEqual(['foo', 'bar']);
    });

    test('reports unterminated block comment', () => {
      const { tokens, errors } = tokenize('foo /* unterminated');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toContain('Unterminated block comment');
    });
  });

  describe('Span tracking', () => {
    test('tracks token spans correctly', () => {
      const { tokens, errors } = tokenize('foo bar');
      expect(errors).toHaveLength(0);
      expect(tokens[0].span).toEqual({ start: 0, end: 3 });
      expect(tokens[1].span).toEqual({ start: 4, end: 7 });
    });

    test('tracks multichar operator spans', () => {
      const { tokens, errors } = tokenize('a <<= b');
      expect(errors).toHaveLength(0);
      expect(tokens[1].kind).toBe('<<=');
      expect(tokens[1].span).toEqual({ start: 2, end: 5 });
    });
  });
});

// =============================================================================
// EXPRESSION PARSING TESTS
// =============================================================================

describe('Expression Parsing', () => {
  // Helper to parse a single expression
  function parseExpr(src: string): Expr {
    const result = parse(`func test() => ${src}`);
    const func = result.ast.decls[0] as any;
    return func.body.expr;
  }

  describe('Literals', () => {
    const cases: Array<{ input: string; kind: string; check: (e: Expr) => void }> = [
      { input: '42', kind: 'NumberLit', check: (e: any) => expect(e.value).toBe('42') },
      { input: '3.14', kind: 'NumberLit', check: (e: any) => expect(e.value).toBe('3.14') },
      { input: '0xFF', kind: 'NumberLit', check: (e: any) => expect(e.value).toBe('0xFF') },
      { input: '"hello"', kind: 'StringLit', check: (e: any) => expect(e.value).toBe('hello') },
      { input: 'true', kind: 'BoolLit', check: (e: any) => expect(e.value).toBe(true) },
      { input: 'false', kind: 'BoolLit', check: (e: any) => expect(e.value).toBe(false) },
      { input: 'foo', kind: 'Identifier', check: (e: any) => expect(e.name).toBe('foo') },
    ];

    for (const { input, kind, check } of cases) {
      test(`parses ${input} as ${kind}`, () => {
        const expr = parseExpr(input);
        expect(expr.kind).toBe(kind);
        check(expr);
      });
    }
  });

  describe('Type-annotated literals', () => {
    test('parses number with type suffix', () => {
      const expr = parseExpr('42:i64') as any;
      expect(expr.kind).toBe('AnnotationExpr');
      expect(expr.expr.kind).toBe('NumberLit');
      expect(expr.expr.value).toBe('42');
      expect(expr.type.kind).toBe('PrimitiveType');
      expect(expr.type.name).toBe('i64');
    });
  });

  describe('Binary expressions', () => {
    const cases: Array<{ input: string; op: string }> = [
      { input: '1 + 2', op: '+' },
      { input: '1 - 2', op: '-' },
      { input: '1 * 2', op: '*' },
      { input: '1 / 2', op: '/' },
      { input: '1 % 2', op: '%' },
      { input: 'a && b', op: '&&' },
      { input: 'a || b', op: '||' },
      { input: 'a == b', op: '==' },
      { input: 'a != b', op: '!=' },
      { input: 'a < b', op: '<' },
      { input: 'a > b', op: '>' },
      { input: 'a <= b', op: '<=' },
      { input: 'a >= b', op: '>=' },
      { input: 'a & b', op: '&' },
      { input: 'a | b', op: '|' },
      { input: 'a ^ b', op: '^' },
      { input: 'a << b', op: '<<' },
      { input: 'a >> b', op: '>>' },
      { input: 'a <<< b', op: '<<<' },
      { input: 'a >>> b', op: '>>>' },
    ];

    for (const { input, op } of cases) {
      test(`parses ${input}`, () => {
        const expr = parseExpr(input);
        expect(expr.kind).toBe('BinaryExpr');
        expect((expr as any).op).toBe(op);
      });
    }
  });

  describe('Operator precedence', () => {
    test('multiplication before addition', () => {
      const expr = parseExpr('1 + 2 * 3') as any;
      // Should be: 1 + (2 * 3)
      expect(expr.kind).toBe('BinaryExpr');
      expect(expr.op).toBe('+');
      expect(expr.left.kind).toBe('NumberLit');
      expect(expr.right.kind).toBe('BinaryExpr');
      expect(expr.right.op).toBe('*');
    });

    test('comparison before logical', () => {
      const expr = parseExpr('a < b && c > d') as any;
      // Should be: (a < b) && (c > d)
      expect(expr.kind).toBe('BinaryExpr');
      expect(expr.op).toBe('&&');
      expect(expr.left.op).toBe('<');
      expect(expr.right.op).toBe('>');
    });

    test('bitwise before comparison', () => {
      const expr = parseExpr('a & b == c | d') as any;
      // Should be: (a & b) == (c | d)
      expect(expr.kind).toBe('BinaryExpr');
      expect(expr.op).toBe('==');
    });

    test('shift before bitwise', () => {
      const expr = parseExpr('a << b & c >> d') as any;
      // Should be: (a << b) & (c >> d)
      expect(expr.kind).toBe('BinaryExpr');
      expect(expr.op).toBe('&');
    });

    test('left associativity', () => {
      const expr = parseExpr('1 - 2 - 3') as any;
      // Should be: (1 - 2) - 3
      expect(expr.kind).toBe('BinaryExpr');
      expect(expr.op).toBe('-');
      expect(expr.left.kind).toBe('BinaryExpr');
      expect(expr.left.op).toBe('-');
      expect(expr.right.value).toBe('3');
    });
  });

  describe('Unary expressions', () => {
    const cases: Array<{ input: string; op: string }> = [
      { input: '-x', op: '-' },
      { input: '~x', op: '~' },
      { input: '!x', op: '!' },
      { input: '&x', op: '&' },
    ];

    for (const { input, op } of cases) {
      test(`parses ${input}`, () => {
        const expr = parseExpr(input);
        expect(expr.kind).toBe('UnaryExpr');
        expect((expr as any).op).toBe(op);
      });
    }

    test('chains unary operators', () => {
      const expr = parseExpr('--x') as any;
      expect(expr.kind).toBe('UnaryExpr');
      expect(expr.op).toBe('-');
      expect(expr.operand.kind).toBe('UnaryExpr');
      expect(expr.operand.op).toBe('-');
    });
  });

  describe('Postfix expressions', () => {
    test('parses field access', () => {
      const expr = parseExpr('foo.bar') as any;
      expect(expr.kind).toBe('MemberExpr');
      expect(expr.target.name).toBe('foo');
      expect(expr.member).toBe('bar');
    });

    test('parses tuple index access', () => {
      const expr = parseExpr('tuple.0') as any;
      expect(expr.kind).toBe('MemberExpr');
      expect(expr.member).toBe(0);
    });

    test('parses nested member access', () => {
      const expr = parseExpr('a.b.c') as any;
      expect(expr.kind).toBe('MemberExpr');
      expect(expr.member).toBe('c');
      expect(expr.target.kind).toBe('MemberExpr');
      expect(expr.target.member).toBe('b');
    });

    test('parses dereference', () => {
      const expr = parseExpr('ptr.*') as any;
      expect(expr.kind).toBe('MemberExpr');
      expect(expr.isDeref).toBe(true);
    });

    test('parses type-punned access', () => {
      const expr = parseExpr('x.i32') as any;
      expect(expr.kind).toBe('MemberExpr');
      expect(expr.isTypePun).toBeDefined();
      expect(expr.isTypePun.name).toBe('i32');
    });

    test('parses index access', () => {
      const expr = parseExpr('arr[0]') as any;
      expect(expr.kind).toBe('IndexExpr');
      expect(expr.target.name).toBe('arr');
      expect(expr.index.value).toBe('0');
    });

    test('parses nested index access', () => {
      const expr = parseExpr('arr[0][1]') as any;
      expect(expr.kind).toBe('IndexExpr');
      expect(expr.index.value).toBe('1');
      expect(expr.target.kind).toBe('IndexExpr');
    });

    test('parses function call', () => {
      const expr = parseExpr('foo(1, 2)') as any;
      expect(expr.kind).toBe('CallExpr');
      expect(expr.callee.name).toBe('foo');
      expect(expr.args).toHaveLength(2);
    });

    test('parses function call with no args', () => {
      const expr = parseExpr('foo()') as any;
      expect(expr.kind).toBe('CallExpr');
      expect(expr.args).toHaveLength(0);
    });

    test('parses function call with named args', () => {
      const expr = parseExpr('foo(x: 1, y: 2)') as any;
      expect(expr.kind).toBe('CallExpr');
      expect(expr.args[0].name).toBe('x');
      expect(expr.args[1].name).toBe('y');
    });

    test('parses method call', () => {
      const expr = parseExpr('obj.method(1)') as any;
      expect(expr.kind).toBe('CallExpr');
      expect(expr.callee.kind).toBe('MemberExpr');
      expect(expr.callee.member).toBe('method');
    });
  });

  describe('Cast expressions', () => {
    test('parses cast with as', () => {
      const expr = parseExpr('x as i64') as any;
      expect(expr.kind).toBe('CastExpr');
      expect(expr.expr.name).toBe('x');
      expect(expr.type.name).toBe('i64');
    });
  });

  describe('Grouping and tuples', () => {
    test('parses grouping expression', () => {
      const expr = parseExpr('(1 + 2)') as any;
      expect(expr.kind).toBe('GroupExpr');
      expect(expr.expr.kind).toBe('BinaryExpr');
    });

    test('parses empty tuple', () => {
      const expr = parseExpr('()') as any;
      expect(expr.kind).toBe('TupleLit');
      expect(expr.elements).toHaveLength(0);
    });

    test('parses tuple literal', () => {
      const expr = parseExpr('(1, 2, 3)') as any;
      expect(expr.kind).toBe('TupleLit');
      expect(expr.elements).toHaveLength(3);
    });

    test('parses struct literal', () => {
      const expr = parseExpr('(x: 1, y: 2)') as any;
      expect(expr.kind).toBe('StructLit');
      expect(expr.fields).toHaveLength(2);
      expect(expr.fields[0].name).toBe('x');
      expect(expr.fields[1].name).toBe('y');
    });

    test('parses struct literal with shorthand', () => {
      const expr = parseExpr('(x:, y:)') as any;
      expect(expr.kind).toBe('StructLit');
      expect(expr.fields[0].name).toBe('x');
      // Shorthand: value should be identifier with same name
      expect(expr.fields[0].value.kind).toBe('Identifier');
      expect(expr.fields[0].value.name).toBe('x');
    });
  });

  describe('Type constructor expressions', () => {
    test('parses type constructor', () => {
      const expr = parseExpr('Vec3(1, 2, 3)') as any;
      expect(expr.kind).toBe('ConstructorExpr');
      expect(expr.typeName).toBe('Vec3');
      expect(expr.args).toHaveLength(3);
    });

    test('parses type constructor with named args', () => {
      const expr = parseExpr('Point(x: 10, y: 20)') as any;
      expect(expr.kind).toBe('ConstructorExpr');
      expect(expr.args[0].name).toBe('x');
    });
  });

  describe('If expressions', () => {
    test('parses simple if expression', () => {
      const expr = parseExpr('if a => b') as any;
      expect(expr.kind).toBe('IfExpr');
      expect(expr.condition.name).toBe('a');
      expect(expr.thenBranch.kind).toBe('ArrowBody');
    });

    test('parses if-else expression', () => {
      const expr = parseExpr('if a => b else => c') as any;
      expect(expr.kind).toBe('IfExpr');
      expect(expr.elseBranch).toBeDefined();
    });

    test('parses if-elif-else expression', () => {
      const expr = parseExpr('if a => 1 elif b => 2 else => 3') as any;
      expect(expr.kind).toBe('IfExpr');
      expect(expr.elifBranches).toHaveLength(1);
      expect(expr.elseBranch).toBeDefined();
    });
  });
});

// =============================================================================
// TYPE PARSING TESTS
// =============================================================================

describe('Type Parsing', () => {
  // Helper to parse a type from a global declaration
  function parseType(src: string): Type {
    const result = parse(`global x: ${src}`);
    const decl = result.ast.decls[0] as any;
    return decl.type;
  }

  describe('Primitive types', () => {
    const primitives = ['i8', 'i16', 'i32', 'i64', 'u8', 'u16', 'u32', 'u64', 'f32', 'f64', 'bool'];
    for (const prim of primitives) {
      test(`parses ${prim}`, () => {
        const type = parseType(prim);
        expect(type.kind).toBe('PrimitiveType');
        expect((type as any).name).toBe(prim);
      });
    }
  });

  describe('Pointer types', () => {
    test('parses pointer to primitive', () => {
      const type = parseType('*i32') as any;
      expect(type.kind).toBe('PointerType');
      expect(type.target.kind).toBe('PrimitiveType');
      expect(type.target.name).toBe('i32');
    });

    test('parses pointer to pointer', () => {
      const type = parseType('**i32') as any;
      expect(type.kind).toBe('PointerType');
      expect(type.target.kind).toBe('PointerType');
      expect(type.target.target.name).toBe('i32');
    });
  });

  describe('Slice types', () => {
    test('parses slice type', () => {
      const type = parseType('i32[]') as any;
      expect(type.kind).toBe('SliceType');
      expect(type.element.name).toBe('i32');
    });
  });

  describe('Array types', () => {
    test('parses fixed-size array', () => {
      const type = parseType('i32[10]') as any;
      expect(type.kind).toBe('ArrayType');
      expect(type.element.name).toBe('i32');
      expect(type.length).toBe(10);
    });
  });

  describe('Null-terminated types', () => {
    test('parses null-terminated slice', () => {
      const type = parseType('u8[/0]') as any;
      expect(type.kind).toBe('NullTermType');
      expect(type.element.name).toBe('u8');
      expect(type.length).toBeUndefined();
    });

    test('parses null-terminated fixed array', () => {
      const type = parseType('u8[256/0]') as any;
      expect(type.kind).toBe('NullTermType');
      expect(type.length).toBe(256);
    });
  });

  describe('Named types', () => {
    test('parses named type', () => {
      const type = parseType('MyType') as any;
      expect(type.kind).toBe('NamedType');
      expect(type.name).toBe('MyType');
    });
  });

  describe('Composite types', () => {
    test('parses unit type', () => {
      const type = parseType('()') as any;
      expect(type.kind).toBe('TupleType');
      expect(type.elements).toHaveLength(0);
    });

    test('parses tuple type', () => {
      const type = parseType('(i32, i64)') as any;
      expect(type.kind).toBe('TupleType');
      expect(type.elements).toHaveLength(2);
      expect(type.elements[0].name).toBe('i32');
      expect(type.elements[1].name).toBe('i64');
    });
  });
});

// =============================================================================
// PATTERN PARSING TESTS
// =============================================================================

describe('Pattern Parsing', () => {
  // Helper to parse a pattern from a let statement
  function parsePattern(src: string): Pattern {
    const result = parse(`func test() { let ${src} = 0 }`);
    const func = result.ast.decls[0] as any;
    const stmt = func.body.stmts[0];
    return stmt.pattern;
  }

  test('parses identifier pattern', () => {
    const pattern = parsePattern('x');
    expect(pattern.kind).toBe('IdentPattern');
    expect((pattern as any).name).toBe('x');
  });

  test('parses tuple pattern', () => {
    const pattern = parsePattern('(a, b)') as any;
    expect(pattern.kind).toBe('TuplePattern');
    expect(pattern.elements).toHaveLength(2);
    expect(pattern.elements[0].pattern.name).toBe('a');
    expect(pattern.elements[1].pattern.name).toBe('b');
  });

  test('parses nested tuple pattern', () => {
    const pattern = parsePattern('(a, (b, c))') as any;
    expect(pattern.kind).toBe('TuplePattern');
    expect(pattern.elements[1].pattern.kind).toBe('TuplePattern');
  });

  test('parses struct pattern with shorthand', () => {
    const pattern = parsePattern('(x:, y:)') as any;
    expect(pattern.kind).toBe('StructPattern');
    expect(pattern.fields[0].fieldName).toBe('x');
    expect(pattern.fields[0].binding).toBeUndefined();
  });

  test('parses struct pattern with explicit binding', () => {
    const pattern = parsePattern('(x: a, y: b)') as any;
    expect(pattern.kind).toBe('StructPattern');
    expect(pattern.fields[0].fieldName).toBe('x');
    expect(pattern.fields[0].binding).toBe('a');
  });
});

// =============================================================================
// STATEMENT PARSING TESTS
// =============================================================================

describe('Statement Parsing', () => {
  // Helper to parse a statement from a function body
  function parseStmt(src: string): Stmt {
    const result = parse(`func test() { ${src} }`);
    const func = result.ast.decls[0] as any;
    return func.body.stmts[0];
  }

  describe('Let statements', () => {
    test('parses let with init', () => {
      const stmt = parseStmt('let x = 1') as any;
      expect(stmt.kind).toBe('LetStmt');
      expect(stmt.pattern.name).toBe('x');
      expect(stmt.init.value).toBe('1');
    });

    test('parses let with type annotation', () => {
      const stmt = parseStmt('let x: i32 = 1') as any;
      expect(stmt.kind).toBe('LetStmt');
      expect(stmt.type.name).toBe('i32');
    });

    test('parses let without init', () => {
      const stmt = parseStmt('let x: i32') as any;
      expect(stmt.kind).toBe('LetStmt');
      expect(stmt.init).toBeUndefined();
    });

    test('parses let with destructuring', () => {
      const stmt = parseStmt('let (a, b) = tuple') as any;
      expect(stmt.kind).toBe('LetStmt');
      expect(stmt.pattern.kind).toBe('TuplePattern');
    });
  });

  describe('Set statements', () => {
    test('parses set statement', () => {
      const stmt = parseStmt('set x = 1') as any;
      expect(stmt.kind).toBe('SetStmt');
      expect(stmt.pattern.name).toBe('x');
      expect(stmt.value.value).toBe('1');
    });

    test('parses set with type annotation', () => {
      const stmt = parseStmt('set x: i64 = 1') as any;
      expect(stmt.kind).toBe('SetStmt');
      expect(stmt.type.name).toBe('i64');
    });
  });

  describe('Assignment statements', () => {
    const cases: Array<{ input: string; op: string }> = [
      { input: 'x = 1', op: '=' },
      { input: 'x += 1', op: '+=' },
      { input: 'x -= 1', op: '-=' },
      { input: 'x *= 2', op: '*=' },
      { input: 'x /= 2', op: '/=' },
      { input: 'x %= 2', op: '%=' },
      { input: 'x &= 0xFF', op: '&=' },
      { input: 'x |= 0xFF', op: '|=' },
      { input: 'x ^= 0xFF', op: '^=' },
      { input: 'x <<= 1', op: '<<=' },
      { input: 'x >>= 1', op: '>>=' },
      { input: 'x <<<= 1', op: '<<<=' },
      { input: 'x >>>= 1', op: '>>>=' },
    ];

    for (const { input, op } of cases) {
      test(`parses ${input}`, () => {
        const stmt = parseStmt(input) as any;
        expect(stmt.kind).toBe('AssignStmt');
        expect(stmt.op).toBe(op);
      });
    }

    test('parses assignment to member', () => {
      const stmt = parseStmt('obj.x = 1') as any;
      expect(stmt.kind).toBe('AssignStmt');
      expect(stmt.target.kind).toBe('MemberExpr');
    });

    test('parses assignment to index', () => {
      const stmt = parseStmt('arr[0] = 1') as any;
      expect(stmt.kind).toBe('AssignStmt');
      expect(stmt.target.kind).toBe('IndexExpr');
    });
  });

  describe('If statements', () => {
    test('parses simple if', () => {
      const stmt = parseStmt('if x { y }') as any;
      expect(stmt.kind).toBe('IfStmt');
      expect(stmt.condition.name).toBe('x');
      expect(stmt.thenBody.kind).toBe('BlockBody');
    });

    test('parses if with arrow body', () => {
      const stmt = parseStmt('if x => y') as any;
      expect(stmt.kind).toBe('IfStmt');
      expect(stmt.thenBody.kind).toBe('ArrowBody');
    });

    test('parses if-else', () => {
      const stmt = parseStmt('if x { a } else { b }') as any;
      expect(stmt.kind).toBe('IfStmt');
      expect(stmt.elseBody).toBeDefined();
    });

    test('parses if-elif-else chain', () => {
      const stmt = parseStmt('if a { 1 } elif b { 2 } elif c { 3 } else { 4 }') as any;
      expect(stmt.kind).toBe('IfStmt');
      expect(stmt.elifClauses).toHaveLength(2);
      expect(stmt.elseBody).toBeDefined();
    });
  });

  describe('While statements', () => {
    test('parses while loop', () => {
      const stmt = parseStmt('while x { y }') as any;
      expect(stmt.kind).toBe('WhileStmt');
      expect(stmt.condition.name).toBe('x');
    });

    test('parses while with arrow body', () => {
      const stmt = parseStmt('while x => y') as any;
      expect(stmt.kind).toBe('WhileStmt');
      expect(stmt.body.kind).toBe('ArrowBody');
    });
  });

  describe('For statements', () => {
    test('parses for-in loop', () => {
      const stmt = parseStmt('for x in arr { body }') as any;
      expect(stmt.kind).toBe('ForStmt');
      expect(stmt.binding).toBe('x');
      expect(stmt.iterable.name).toBe('arr');
    });
  });

  describe('Loop statements', () => {
    test('parses infinite loop', () => {
      const stmt = parseStmt('loop { body }') as any;
      expect(stmt.kind).toBe('LoopStmt');
      expect(stmt.body.kind).toBe('BlockBody');
    });
  });

  describe('Return statements', () => {
    test('parses return with value', () => {
      const stmt = parseStmt('return 42') as any;
      expect(stmt.kind).toBe('ReturnStmt');
      expect(stmt.value.value).toBe('42');
    });

    test('parses return without value', () => {
      const stmt = parseStmt('return') as any;
      expect(stmt.kind).toBe('ReturnStmt');
      expect(stmt.value).toBeUndefined();
    });

    test('parses conditional return', () => {
      const stmt = parseStmt('return x when cond') as any;
      expect(stmt.kind).toBe('ReturnStmt');
      expect(stmt.when).toBeDefined();
      expect(stmt.when.name).toBe('cond');
    });
  });

  describe('Break statements', () => {
    test('parses break', () => {
      const stmt = parseStmt('break') as any;
      expect(stmt.kind).toBe('BreakStmt');
    });

    test('parses conditional break', () => {
      const stmt = parseStmt('break when cond') as any;
      expect(stmt.kind).toBe('BreakStmt');
      expect(stmt.when.name).toBe('cond');
    });
  });

  describe('Continue statements', () => {
    test('parses continue', () => {
      const stmt = parseStmt('continue') as any;
      expect(stmt.kind).toBe('ContinueStmt');
    });

    test('parses conditional continue', () => {
      const stmt = parseStmt('continue when cond') as any;
      expect(stmt.kind).toBe('ContinueStmt');
      expect(stmt.when.name).toBe('cond');
    });
  });

  describe('Expression statements', () => {
    test('parses function call as statement', () => {
      const stmt = parseStmt('foo()') as any;
      expect(stmt.kind).toBe('ExprStmt');
      expect(stmt.expr.kind).toBe('CallExpr');
    });
  });
});

// =============================================================================
// DECLARATION PARSING TESTS
// =============================================================================

describe('Declaration Parsing', () => {
  describe('Function declarations', () => {
    test('parses simple function', () => {
      const result = parse('func foo() { }');
      const decl = result.ast.decls[0] as any;
      expect(decl.kind).toBe('FuncDecl');
      expect(decl.name).toBe('foo');
      expect(decl.signature.params).toHaveLength(0);
    });

    test('parses function with arrow body', () => {
      const result = parse('func foo() => 42');
      const decl = result.ast.decls[0] as any;
      expect(decl.body.kind).toBe('ArrowBody');
      expect(decl.body.expr.value).toBe('42');
    });

    test('parses function with params', () => {
      const result = parse('func add(a: i32, b: i32) => a + b');
      const decl = result.ast.decls[0] as any;
      expect(decl.signature.params).toHaveLength(2);
      expect(decl.signature.params[0].name).toBe('a');
      expect(decl.signature.params[0].type.name).toBe('i32');
    });

    test('parses function with return type', () => {
      const result = parse('func foo() -> i32 => 42');
      const decl = result.ast.decls[0] as any;
      expect(decl.signature.returns.kind).toBe('PrimitiveType');
      expect(decl.signature.returns.name).toBe('i32');
    });

    test('parses function with single anonymous param', () => {
      const result = parse('func double i32 -> i32 => 0');
      const decl = result.ast.decls[0] as any;
      expect(decl.signature.params).toHaveLength(1);
      expect(decl.signature.params[0].type.name).toBe('i32');
      expect(decl.signature.params[0].name).toBeUndefined();
    });

    test('parses inline function', () => {
      const result = parse('inline func foo() => 42');
      const decl = result.ast.decls[0] as any;
      expect(decl.isInline).toBe(true);
    });

    test('parses anonymous function', () => {
      const result = parse('func() => 42');
      const decl = result.ast.decls[0] as any;
      expect(decl.kind).toBe('FuncDecl');
      expect(decl.name).toBeUndefined();
    });
  });

  describe('Type declarations', () => {
    test('parses type alias', () => {
      const result = parse('type Int = i32');
      const decl = result.ast.decls[0] as any;
      expect(decl.kind).toBe('TypeDecl');
      expect(decl.name).toBe('Int');
      expect(decl.type.name).toBe('i32');
    });

    test('parses unique type', () => {
      const result = parse('unique UserId = i32');
      const decl = result.ast.decls[0] as any;
      expect(decl.kind).toBe('UniqueDecl');
      expect(decl.name).toBe('UserId');
    });
  });

  describe('Def declarations', () => {
    test('parses simple def', () => {
      const result = parse('def pi = 3.14159');
      const decl = result.ast.decls[0] as any;
      expect(decl.kind).toBe('DefDecl');
      expect(decl.name).toBe('pi');
      expect(decl.value.value).toBe('3.14159');
    });
  });

  describe('Global declarations', () => {
    test('parses global with init', () => {
      const result = parse('global counter: i32 = 0');
      const decl = result.ast.decls[0] as any;
      expect(decl.kind).toBe('GlobalDecl');
      expect(decl.name).toBe('counter');
      expect(decl.type.name).toBe('i32');
      expect(decl.init.value).toBe('0');
    });

    test('parses global without init', () => {
      const result = parse('global x: i32');
      const decl = result.ast.decls[0] as any;
      expect(decl.init).toBeUndefined();
    });
  });

  describe('Memory declarations', () => {
    test('parses memory with min pages', () => {
      const result = parse('memory 1');
      const decl = result.ast.decls[0] as any;
      expect(decl.kind).toBe('MemoryDecl');
      expect(decl.minPages).toBe(1);
      expect(decl.maxPages).toBeUndefined();
    });

    test('parses memory with min and max pages', () => {
      const result = parse('memory 1 16');
      const decl = result.ast.decls[0] as any;
      expect(decl.minPages).toBe(1);
      expect(decl.maxPages).toBe(16);
    });
  });

  describe('Data declarations', () => {
    test('parses data with string', () => {
      const result = parse('data 0 "Hello"');
      const decl = result.ast.decls[0] as any;
      expect(decl.kind).toBe('DataDecl');
      expect(decl.offset).toBe(0);
      expect(decl.value.kind).toBe('StringLit');
    });

    test('parses data with number', () => {
      const result = parse('data 100 42');
      const decl = result.ast.decls[0] as any;
      expect(decl.offset).toBe(100);
      expect(decl.value.kind).toBe('NumberLit');
    });
  });

  describe('Import declarations', () => {
    test('parses single import', () => {
      const result = parse('import "env" "print" (n: i32)');
      const decl = result.ast.decls[0] as any;
      expect(decl.kind).toBe('ImportDecl');
      expect(decl.module).toBe('env');
      expect(decl.items).toHaveLength(1);
      expect(decl.items[0].externalName).toBe('print');
      expect(decl.items[0].item.kind).toBe('func');
    });

    test('parses global import', () => {
      const result = parse('import "env" "value" global x: i32');
      const decl = result.ast.decls[0] as any;
      expect(decl.items[0].item.kind).toBe('global');
      expect(decl.items[0].item.name).toBe('x');
    });

    test('parses memory import', () => {
      const result = parse('import "env" "memory" memory 1');
      const decl = result.ast.decls[0] as any;
      expect(decl.items[0].item.kind).toBe('memory');
      expect(decl.items[0].item.pages).toBe(1);
    });
  });

  describe('Export declarations', () => {
    test('parses function export', () => {
      const result = parse('export "add" func add(a: i32, b: i32) -> i32 => a + b');
      const decl = result.ast.decls[0] as any;
      expect(decl.kind).toBe('ExportDecl');
      expect(decl.exportName).toBe('add');
      expect(decl.decl.kind).toBe('FuncDecl');
    });

    test('parses global export', () => {
      const result = parse('export "counter" global counter: i32 = 0');
      const decl = result.ast.decls[0] as any;
      expect(decl.decl.kind).toBe('GlobalDecl');
    });

    test('parses memory export', () => {
      const result = parse('export "memory" memory 1');
      const decl = result.ast.decls[0] as any;
      expect(decl.decl.kind).toBe('MemoryDecl');
    });
  });
});

// =============================================================================
// COMPLETE MODULE TESTS
// =============================================================================

describe('Complete Module Parsing', () => {
  test('parses empty module', () => {
    const result = parse('');
    expect(result.ast.kind).toBe('Module');
    expect(result.ast.decls).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test('parses module with multiple declarations', () => {
    const src = `
      memory 1
      global counter: i32 = 0

      func increment() {
        counter += 1
      }

      export "main" func main() {
        increment()
      }
    `;
    const result = parse(src);
    expect(result.errors).toHaveLength(0);
    expect(result.ast.decls).toHaveLength(4);
  });

  test('parses complex function', () => {
    const src = `
      func factorial(n: i32) -> i32 {
        if n <= 1 { return 1 }
        return n * factorial(n - 1)
      }
    `;
    const result = parse(src);
    expect(result.errors).toHaveLength(0);
    const func = result.ast.decls[0] as any;
    expect(func.name).toBe('factorial');
    expect(func.body.stmts).toHaveLength(2);
  });
});

// =============================================================================
// ERROR RECOVERY TESTS
// =============================================================================

describe('Error Recovery', () => {
  test('recovers from missing closing paren', () => {
    const result = parse('func foo( { }');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.ast.decls).toHaveLength(1);
  });

  test('recovers from unexpected token', () => {
    const result = parse(`
      func foo() { }
      @#$ invalid
      func bar() { }
    `);
    expect(result.errors.length).toBeGreaterThan(0);
    // Should still parse both functions
    const funcs = result.ast.decls.filter(d => d.kind === 'FuncDecl');
    expect(funcs.length).toBeGreaterThanOrEqual(1);
  });

  test('continues parsing after syntax error in expression', () => {
    const result = parse(`
      func foo() {
        let x = 1 + +
        let y = 2
      }
    `);
    expect(result.errors.length).toBeGreaterThan(0);
    // Should still produce a function with statements
    expect(result.ast.decls).toHaveLength(1);
  });

  test('handles unterminated string', () => {
    const result = parse('data 0 "unterminated');
    expect(result.errors.length).toBeGreaterThan(0);
    // Should still produce a parse tree
    expect(result.ast.decls.length).toBeGreaterThanOrEqual(1);
  });

  test('produces ErrorExpr for invalid expression', () => {
    const result = parse('func foo() => @');
    expect(result.errors.length).toBeGreaterThan(0);
    const func = result.ast.decls[0] as any;
    expect(func.body.expr.kind).toBe('ErrorExpr');
  });

  test('recovers from missing type in declaration', () => {
    const result = parse('global x:');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.ast.decls).toHaveLength(1);
  });
});

// =============================================================================
// SPAN TESTS FOR AST NODES
// =============================================================================

describe('AST Node Spans', () => {
  test('tracks expression spans correctly', () => {
    const result = parse('func f() => 42');
    const func = result.ast.decls[0] as any;
    const expr = func.body.expr;
    // Number literal should have correct span
    expect(expr.span.start).toBeGreaterThanOrEqual(0);
    expect(expr.span.end).toBeGreaterThan(expr.span.start);
  });

  test('tracks binary expression spans', () => {
    const result = parse('func f() => 1 + 2');
    const func = result.ast.decls[0] as any;
    const expr = func.body.expr;
    // Binary expr span should encompass both operands
    expect(expr.span.start).toBeLessThanOrEqual(expr.left.span.start);
    expect(expr.span.end).toBeGreaterThanOrEqual(expr.right.span.end);
  });

  test('tracks function declaration spans', () => {
    const result = parse('func foo() { }');
    const func = result.ast.decls[0] as any;
    expect(func.span.start).toBe(0);
    expect(func.span.end).toBeGreaterThan(func.span.start);
  });

  test('tracks statement spans', () => {
    const result = parse('func f() { let x = 1 }');
    const func = result.ast.decls[0] as any;
    const stmt = func.body.stmts[0];
    expect(stmt.span.start).toBeGreaterThan(0);
    expect(stmt.span.end).toBeGreaterThan(stmt.span.start);
  });
});

// =============================================================================
// EDGE CASES
// =============================================================================

describe('Edge Cases', () => {
  test('handles deeply nested expressions', () => {
    const result = parse('func f() => ((((1))))');
    expect(result.errors).toHaveLength(0);
    const func = result.ast.decls[0] as any;
    expect(func.body.expr.kind).toBe('GroupExpr');
  });

  test('handles long chains of binary operators', () => {
    const result = parse('func f() => 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10');
    expect(result.errors).toHaveLength(0);
  });

  test('handles long chains of member access', () => {
    const result = parse('func f() => a.b.c.d.e.f.g.h.i.j');
    expect(result.errors).toHaveLength(0);
  });

  test('handles empty blocks', () => {
    const result = parse('func f() { }');
    expect(result.errors).toHaveLength(0);
    const func = result.ast.decls[0] as any;
    expect(func.body.stmts).toHaveLength(0);
  });

  test('handles multiple statements on same line', () => {
    // This may or may not work depending on grammar design
    // Just checking it doesn't crash
    const result = parse('func f() { let x = 1 let y = 2 }');
    expect(result.ast.decls).toHaveLength(1);
  });

  test('handles identifier with hyphen', () => {
    const result = parse('func my-function() => 0');
    expect(result.errors).toHaveLength(0);
    const func = result.ast.decls[0] as any;
    expect(func.name).toBe('my-function');
  });

  test('handles builtin function names as identifiers', () => {
    // sqrt, abs etc are builtins but should parse as identifiers
    const result = parse('func f() => sqrt(x)');
    expect(result.errors).toHaveLength(0);
    const func = result.ast.decls[0] as any;
    expect(func.body.expr.kind).toBe('CallExpr');
    expect(func.body.expr.callee.name).toBe('sqrt');
  });
});
