import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';

import { analyze, compile, parse, tokenize } from './compile';

// =============================================================================
// Tokenizer Tests
// =============================================================================

describe('tokenizer', () => {
  test('tokenizes basic tokens', () => {
    const { tokens, errors } = tokenize('x + y * 2');
    expect(errors).toHaveLength(0);
    expect(tokens.map(t => t.kind)).toEqual(['NAME', '+', 'NAME', '*', 'NUMBER', 'EOF']);
  });

  test('tokenizes keywords', () => {
    const { tokens, errors } = tokenize('func local return end');
    expect(errors).toHaveLength(0);
    expect(tokens.map(t => t.kind)).toEqual(['func', 'local', 'return', 'end', 'EOF']);
  });

  test('tokenizes hyphenated names', () => {
    const { tokens, errors } = tokenize('prime64-1 fd-write');
    expect(errors).toHaveLength(0);
    expect(tokens.map(t => t.kind)).toEqual(['NAME', 'NAME', 'EOF']);
    expect(tokens[0].text).toBe('prime64-1');
    expect(tokens[1].text).toBe('fd-write');
  });

  test('tokenizes strings', () => {
    const { tokens, errors } = tokenize('"Hello World"');
    expect(errors).toHaveLength(0);
    expect(tokens[0].kind).toBe('STRING');
    expect(tokens[0].text).toBe('"Hello World"');
  });

  test('tokenizes string escapes', () => {
    const { tokens, errors } = tokenize('"Hello\\nWorld"');
    expect(errors).toHaveLength(0);
    expect(tokens[0].kind).toBe('STRING');
  });

  test('tokenizes numbers', () => {
    const { tokens, errors } = tokenize('42 3.14 0xFF 0b1010');
    expect(errors).toHaveLength(0);
    expect(tokens.map(t => t.kind)).toEqual(['NUMBER', 'NUMBER', 'NUMBER', 'NUMBER', 'EOF']);
  });

  test('tokenizes multi-char operators', () => {
    const { tokens, errors } = tokenize('-> => == != <= >= << >> <<<');
    expect(errors).toHaveLength(0);
    expect(tokens.map(t => t.kind)).toEqual(['->', '=>', '==', '!=', '<=', '>=', '<<', '>>', '<<<', 'EOF']);
  });

  test('skips comments', () => {
    const { tokens, errors } = tokenize('x -- this is a comment\ny');
    expect(errors).toHaveLength(0);
    expect(tokens.map(t => t.kind)).toEqual(['NAME', 'NAME', 'EOF']);
  });

  test('reports unterminated string', () => {
    const { tokens, errors } = tokenize('"unterminated');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Unterminated string');
  });
});

// =============================================================================
// Parser Tests
// =============================================================================

describe('parser', () => {
  test('parses simple function', () => {
    const result = parse('func add(a: i32, b: i32) -> i32 => a + b');
    expect(result.errors).toHaveLength(0);
    expect(result.ast.exports).toHaveLength(0);
    expect(result.ast.functions).toHaveLength(1);
  });

  test('parses exported function', () => {
    const result = parse('export "add" func add(a: i32, b: i32) -> i32 => a + b');
    expect(result.errors).toHaveLength(0);
    expect(result.ast.exports).toHaveLength(1);
    expect(result.ast.exports[0].exportName).toBe('add');
  });

  test('parses function with block body', () => {
    const result = parse(`
      func test()
        local x: i32 = 10
        return x
      end
    `);
    expect(result.errors).toHaveLength(0);
    const func = result.ast.functions[0];
    expect(func.body?.kind).toBe('BlockBody');
  });

  test('parses import group', () => {
    const result = parse(`
      import "math" (
        "sin" func (angle: f64) -> f64
        "cos" func (angle: f64) -> f64
      )
    `);
    expect(result.errors).toHaveLength(0);
    expect(result.ast.imports).toHaveLength(1);
    expect(result.ast.imports[0].kind).toBe('ImportGroup');
  });

  test('parses single import', () => {
    const result = parse('import "sys" "print" func print ([u8])');
    expect(result.errors).toHaveLength(0);
    expect(result.ast.imports).toHaveLength(1);
    expect(result.ast.imports[0].kind).toBe('ImportSingle');
  });

  test('parses named returns', () => {
    const result = parse('func divmod(a: i32, b: i32) -> (q: i32, r: i32) => (a / b, a % b)');
    expect(result.errors).toHaveLength(0);
    const func = result.ast.functions[0];
    expect(func.returnType).toBeDefined();
    expect('params' in func.returnType!).toBe(true);
  });

  test('parses local declaration', () => {
    const result = parse(`
      func test()
        local x: i32 = 10
        local y = 20
        local z: f64
      end
    `);
    expect(result.errors).toHaveLength(0);
  });

  test('parses multi-target assignment', () => {
    const result = parse(`
      func test()
        local a: i32
        local b: i32
        a, b = divmod(10, 3)
      end
    `);
    expect(result.errors).toHaveLength(0);
  });

  test('parses if statement', () => {
    const result = parse(`
      func test(x: i32) -> i32
        if x > 0 then
          return 1
        else
          return 0
        end
      end
    `);
    expect(result.errors).toHaveLength(0);
  });

  test('parses while loop', () => {
    const result = parse(`
      func test()
        local i: i32 = 0
        while i < 10 do
          i += 1
        end
      end
    `);
    expect(result.errors).toHaveLength(0);
  });

  test('parses for loop', () => {
    const result = parse(`
      func test()
        local sum: i32 = 0
        for i in 10 do
          sum += i
        end
      end
    `);
    expect(result.errors).toHaveLength(0);
  });

  test('parses slice type', () => {
    const result = parse('func test(data: [u8]) => data');
    expect(result.errors).toHaveLength(0);
  });

  test('parses pointer type', () => {
    const result = parse('func test(ptr: *u32) => ptr');
    expect(result.errors).toHaveLength(0);
  });

  test('error recovery - continues after syntax error', () => {
    const result = parse(`
      func bad( => 42
      func good() => 1
    `);
    // Should have errors but still parse the second function
    expect(result.errors.length).toBeGreaterThan(0);
    // Parser should recover and continue
  });

  test('reports unexpected token at module level', () => {
    const result = parse('xyz');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('Unexpected');
  });
});

// =============================================================================
// Checker Tests
// =============================================================================

describe('checker', () => {
  test('reports undefined variable', () => {
    const result = analyze('func f() => unknown_var');
    const errors = result.errors.filter(e => e.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.message.includes('Undefined variable'))).toBe(true);
  });

  test('reports undefined function', () => {
    const result = analyze('func f() => unknown_func()');
    const errors = result.errors.filter(e => e.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.message.includes('Undefined function'))).toBe(true);
  });

  test('accepts defined variables', () => {
    const result = analyze(`
      func f() -> i32
        local x: i32 = 10
        return x
      end
    `);
    const errors = result.errors.filter(e => e.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  test('accepts function parameters', () => {
    const result = analyze('func f(x: i32) -> i32 => x');
    const errors = result.errors.filter(e => e.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  test('accepts imported functions', () => {
    const result = analyze(`
      import "math" (
        "sin" func (angle: f64) -> f64
      )
      func f(x: f64) -> f64 => sin(x)
    `);
    const errors = result.errors.filter(e => e.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  test('reports duplicate variable', () => {
    const result = analyze(`
      func f()
        local x: i32 = 1
        local x: i32 = 2
      end
    `);
    const errors = result.errors.filter(e => e.severity === 'error');
    expect(errors.some(e => e.message.includes('Duplicate'))).toBe(true);
  });

  test('checks argument count', () => {
    const result = analyze(`
      func add(a: i32, b: i32) -> i32 => a + b
      func f() => add(1)
    `);
    const errors = result.errors.filter(e => e.severity === 'error');
    expect(errors.some(e => e.message.includes('argument'))).toBe(true);
  });
});

// =============================================================================
// Integration Tests
// =============================================================================

describe('integration', () => {
  test('parses trig.ents without errors', () => {
    const src = readFileSync('examples/math/trig/trig.ents', 'utf8');
    const result = parse(src);

    // Log any errors for debugging
    if (result.errors.length > 0) {
      console.log('Parse errors:', result.errors);
    }

    expect(result.errors).toHaveLength(0);
  });

  test('checks trig.ents without errors', () => {
    const src = readFileSync('examples/math/trig/trig.ents', 'utf8');
    const result = analyze(src);

    // Filter to just errors (not warnings)
    const errors = result.errors.filter(e => e.severity === 'error');

    // Log any errors for debugging
    if (errors.length > 0) {
      console.log('Check errors:', errors);
    }

    expect(errors).toHaveLength(0);
  });

  test('compiles simple function to WAT', () => {
    const src = 'export "add" func add(a: i32, b: i32) -> i32 => a + b';
    const wat = compile(src);

    expect(wat).toContain('(module');
    expect(wat).toContain('(func $add');
    expect(wat).toContain('(export "add")');
    expect(wat).toContain('(param $a i32)');
    expect(wat).toContain('(param $b i32)');
  });

  test('compile throws on error', () => {
    const src = 'func f() => undefined_var';
    expect(() => compile(src)).toThrow();
  });
});

// =============================================================================
// Error Message Quality Tests (for LLM-friendliness)
// =============================================================================

describe('error messages', () => {
  test('includes helpful context for undefined variable', () => {
    const result = analyze('func f() => foo');
    const error = result.errors.find(e => e.message.includes('Undefined'));
    expect(error).toBeDefined();
    expect(error?.message).toContain("'foo'");
    expect(error?.message).toContain('local');  // Suggests fix
  });

  test('includes helpful context for undefined function', () => {
    const result = analyze('func f() => bar()');
    const error = result.errors.find(e => e.message.includes('Undefined'));
    expect(error).toBeDefined();
    expect(error?.message).toContain("'bar'");
  });

  test('includes expected vs actual for argument count', () => {
    const result = analyze(`
      func add(a: i32, b: i32) -> i32 => a + b
      func f() => add(1)
    `);
    const error = result.errors.find(e => e.message.includes('argument'));
    expect(error).toBeDefined();
    expect(error?.message).toMatch(/expects.*2/);
    expect(error?.message).toMatch(/got.*1/);
  });
});
