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
// Code Generation Tests (WAT output verification)
// =============================================================================

describe('codegen', () => {
  test('generates simple assignment', () => {
    const src = `
      func test()
        local x: i32 = 10
        x = 20
      end
    `;
    const wat = compile(src);
    expect(wat).toContain('(local.set $x)');
  });

  test('generates compound assignment +=', () => {
    const src = `
      func test()
        local x: i32 = 10
        x += 5
      end
    `;
    const wat = compile(src);
    // Should: get x, push 5, add, set x
    expect(wat).toContain('(local.get $x)');
    expect(wat).toContain('(i32.const 5)');
    expect(wat).toContain('(i32.add)');
    expect(wat).toContain('(local.set $x)');
  });

  test('generates compound assignment -=', () => {
    const src = `
      func test()
        local x: i32 = 10
        x -= 3
      end
    `;
    const wat = compile(src);
    expect(wat).toContain('(local.get $x)');
    expect(wat).toContain('(i32.sub)');
    expect(wat).toContain('(local.set $x)');
  });

  test('generates compound assignment *=', () => {
    const src = `
      func test()
        local x: i32 = 10
        x *= 2
      end
    `;
    const wat = compile(src);
    expect(wat).toContain('(local.get $x)');
    expect(wat).toContain('(i32.mul)');
    expect(wat).toContain('(local.set $x)');
  });

  test('generates compound assignment with expression', () => {
    const src = `
      func test()
        local a: i32 = 1
        local b: i32 = 2
        local c: i32 = 3
        a += b * c
      end
    `;
    const wat = compile(src);
    // a += b * c should be: get a, get b, get c, mul, add, set a
    expect(wat).toContain('(local.get $a)');
    expect(wat).toContain('(local.get $b)');
    expect(wat).toContain('(local.get $c)');
    expect(wat).toContain('(i32.mul)');
    expect(wat).toContain('(i32.add)');
    expect(wat).toContain('(local.set $a)');
  });

  test('generates bitwise compound assignments', () => {
    const src = `
      func test()
        local x: i32 = 0xFF
        x &= 0x0F
        x |= 0x10
        x ^= 0x01
      end
    `;
    const wat = compile(src);
    expect(wat).toContain('(i32.and)');
    expect(wat).toContain('(i32.or)');
    expect(wat).toContain('(i32.xor)');
  });

  test('generates shift compound assignments', () => {
    const src = `
      func test()
        local x: i32 = 1
        x <<= 4
        x >>= 2
      end
    `;
    const wat = compile(src);
    expect(wat).toContain('(i32.shl)');
    expect(wat).toContain('(i32.shr_s)');
  });

  test('generates rotate compound assignments', () => {
    const src = `
      func test()
        local x: i32 = 1
        x <<<= 13
        x >>>= 7
      end
    `;
    const wat = compile(src);
    expect(wat).toContain('(i32.rotl)');
    expect(wat).toContain('(i32.rotr)');
  });

  test('generates rotate binary operators', () => {
    const src = `
      func test(a: i32) -> i32 => (a <<< 5) >>> 3
    `;
    const wat = compile(src);
    expect(wat).toContain('(i32.rotl)');
    expect(wat).toContain('(i32.rotr)');
  });

  test('generates global declarations', () => {
    const src = `
      global prime = 0x9E3779B1:u32
      func test() -> u32 => prime
    `;
    const wat = compile(src);
    expect(wat).toContain('(global $prime');
    expect(wat).toContain('(global.get $prime)');
  });

  // Type-aware codegen tests
  test('generates f64 operations for float variables', () => {
    const src = `
      func test()
        local x: f64 = 1.0
        x += 2.0
      end
    `;
    const wat = compile(src);
    expect(wat).toContain('(f64.add)');
    expect(wat).not.toContain('(i32.add)');
  });

  test('generates f64 binary operations', () => {
    const src = `func test(a: f64, b: f64) -> f64 => a + b * a - b`;
    const wat = compile(src);
    expect(wat).toContain('(f64.add)');
    expect(wat).toContain('(f64.mul)');
    expect(wat).toContain('(f64.sub)');
  });

  test('generates i64 operations for 64-bit integers', () => {
    const src = `func test(a: i64, b: i64) -> i64 => a + b`;
    const wat = compile(src);
    expect(wat).toContain('(i64.add)');
  });

  test('generates correct comparison ops for floats', () => {
    // Use a simple expression that returns 0 or 1 based on comparison
    // (a < b) returns i32 in WAT
    const src = `func test(a: f64, b: f64) -> i32 => a < b`;
    const wat = compile(src);
    expect(wat).toContain('(f64.lt)');  // Not f64.lt_s (floats don't use _s suffix)
  });

  test('generates correct division for floats vs ints', () => {
    const src1 = `func divFloat(a: f64, b: f64) -> f64 => a / b`;
    const wat1 = compile(src1);
    expect(wat1).toContain('(f64.div)');

    const src2 = `func divInt(a: i32, b: i32) -> i32 => a / b`;
    const wat2 = compile(src2);
    expect(wat2).toContain('(i32.div_s)');
  });

  test('generates f64.const for float literals', () => {
    const src = `func test() -> f64 => 3.14`;
    const wat = compile(src);
    expect(wat).toContain('(f64.const 3.14)');
  });

  test('generates i64.const for i64 suffix', () => {
    const src = `func test() -> i64 => 42:i64`;
    const wat = compile(src);
    expect(wat).toContain('(i64.const 42)');
  });

  // Type promotion tests
  test('promotes i32 to f64 in mixed arithmetic', () => {
    const src = `func test(a: f64, b: i32) -> f64 => a + b`;
    const wat = compile(src);
    expect(wat).toContain('(f64.convert_i32_s)');  // Convert i32 to f64
    expect(wat).toContain('(f64.add)');
  });

  test('promotes i32 to i64 in mixed arithmetic', () => {
    const src = `func test(a: i64, b: i32) -> i64 => a + b`;
    const wat = compile(src);
    expect(wat).toContain('(i64.extend_i32_s)');  // Extend i32 to i64
    expect(wat).toContain('(i64.add)');
  });

  test('promotes f32 to f64 in mixed arithmetic', () => {
    const src = `func test(a: f64, b: f32) -> f64 => a * b`;
    const wat = compile(src);
    expect(wat).toContain('(f64.promote_f32)');  // Promote f32 to f64
    expect(wat).toContain('(f64.mul)');
  });

  test('promotes left operand when right is wider', () => {
    const src = `func test(a: i32, b: f64) -> f64 => a + b`;
    const wat = compile(src);
    expect(wat).toContain('(f64.convert_i32_s)');  // Convert left i32 to f64
    expect(wat).toContain('(f64.add)');
  });

  test('uses unsigned conversion for u32 to f64', () => {
    const src = `func test(a: f64, b: u32) -> f64 => a + b`;
    const wat = compile(src);
    expect(wat).toContain('(f64.convert_i32_u)');  // Unsigned conversion
    expect(wat).toContain('(f64.add)');
  });

  test('chains conversions in complex expressions', () => {
    const src = `func test(a: f64, b: i32, c: i32) -> f64 => a + b + c`;
    const wat = compile(src);
    // Both i32s should be converted to f64
    expect(wat).toContain('(f64.convert_i32_s)');
    expect(wat).toContain('(f64.add)');
  });

  // Precision-safe conversion tests
  test('rejects i32 to f32 (lossy)', () => {
    const src = `func test(a: f32, b: i32) -> f32 => a + b`;
    const wat = compile(src);
    // Should emit error comment, not conversion
    expect(wat).toContain(';; ERROR: incompatible types');
    expect(wat).not.toContain('(f32.convert_i32_s)');
  });

  test('rejects i64 to f64 (lossy)', () => {
    const src = `func test(a: f64, b: i64) -> f64 => a + b`;
    const wat = compile(src);
    expect(wat).toContain(';; ERROR: incompatible types');
    expect(wat).not.toContain('(f64.convert_i64_s)');
  });

  test('rejects i64 to f32 (lossy)', () => {
    const src = `func test(a: f32, b: i64) -> f32 => a + b`;
    const wat = compile(src);
    expect(wat).toContain(';; ERROR: incompatible types');
  });

  test('allows i16 to f32 (lossless)', () => {
    const src = `func test(a: f32, b: i16) -> f32 => a + b`;
    const wat = compile(src);
    expect(wat).toContain('(f32.convert_i32_s)');  // i16 is stored as i32 in WASM
    expect(wat).toContain('(f32.add)');
  });

  test('allows i16 to f64 (lossless)', () => {
    const src = `func test(a: f64, b: i16) -> f64 => a + b`;
    const wat = compile(src);
    expect(wat).toContain('(f64.convert_i32_s)');
    expect(wat).toContain('(f64.add)');
  });

  // Comptime literal tests
  test('allows small comptime literal to f32 (value fits)', () => {
    // 42 fits in f32's 24-bit mantissa
    const src = `func test(a: f32) -> f32 => a + 42`;
    const wat = compile(src);
    expect(wat).toContain('(f32.convert_i32_s)');
    expect(wat).toContain('(f32.add)');
  });

  test('allows comptime literal at f32 boundary', () => {
    // 16777216 (2^24) is the max exact integer in f32
    const src = `func test(a: f32) -> f32 => a + 16777216`;
    const wat = compile(src);
    expect(wat).toContain('(f32.convert_i32_s)');
    expect(wat).toContain('(f32.add)');
  });

  test('rejects comptime literal exceeding f32 precision', () => {
    // 16777217 (2^24 + 1) exceeds f32's exact integer range
    const src = `func test(a: f32) -> f32 => a + 16777217`;
    const wat = compile(src);
    expect(wat).toContain(';; ERROR: incompatible types');
  });

  test('allows large comptime literal to f64 (value fits)', () => {
    // Large number that fits in f64's 53-bit mantissa
    const src = `func test(a: f64) -> f64 => a + 9007199254740992`;
    const wat = compile(src);
    expect(wat).toContain('(f64.convert_i32_s)');
    expect(wat).toContain('(f64.add)');
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
