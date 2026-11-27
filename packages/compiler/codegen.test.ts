import { describe, expect, test } from 'bun:test'
import { parse } from './parser'
import { typecheck } from './checker'
import type * as AST from './ast'
import {
  exprToWat,
  stmtToWat,
  funcToWat,
  moduleToWat,
  typeToWasm,
} from './codegen'
import { primitive, comptimeInt, comptimeFloat, tuple, field, VOID } from './types'

// === Test Helpers ===

/**
 * Parse an expression, type-check it in a minimal context, and generate WAT.
 * Useful for testing tiny snippets like `1 + 2`.
 */
function exprWat(code: string): string {
  // Wrap in a function body to parse as expression
  // Function signature requires (params) -> return, so we use () -> i32
  const wrappedCode = `func test() -> i32 => ${code}`
  const parseResult = parse(wrappedCode)

  if (parseResult.errors.length > 0) {
    throw new Error(`Parse error: ${parseResult.errors[0].message}`)
  }

  const module = parseResult.module as AST.Module
  if (!module || !module.decls) {
    throw new Error('Failed to parse module')
  }
  const funcDecl = module.decls[0] as AST.FuncDecl

  if (funcDecl.body.kind !== 'ArrowBody') {
    throw new Error('Expected arrow body')
  }

  const expr = funcDecl.body.expr
  const checkResult = typecheck(module)

  const ctx = {
    types: checkResult.types,
    exprTypes: checkResult.exprTypes,
    coercions: checkResult.coercions,
    constants: checkResult.constants,
    symbols: checkResult.symbols,
    addressed: checkResult.addressed,
    locals: new Map<string, string[]>(),
    params: new Map<string, string[]>(),
    indent: 0,
  }

  return exprToWat(expr, ctx)
}

/**
 * Parse a statement within a function body and generate WAT.
 */
function stmtWat(code: string): string {
  const wrappedCode = `func test() { ${code} }`
  const parseResult = parse(wrappedCode)

  if (parseResult.errors.length > 0) {
    throw new Error(`Parse error: ${parseResult.errors[0].message}`)
  }

  const module = parseResult.module as AST.Module
  if (!module || !module.decls) {
    throw new Error('Failed to parse module')
  }
  const funcDecl = module.decls[0] as AST.FuncDecl

  if (funcDecl.body.kind !== 'Block') {
    throw new Error('Expected block body')
  }

  const stmt = funcDecl.body.stmts[0]
  const checkResult = typecheck(module)

  const ctx = {
    types: checkResult.types,
    exprTypes: checkResult.exprTypes,
    coercions: checkResult.coercions,
    constants: checkResult.constants,
    symbols: checkResult.symbols,
    addressed: checkResult.addressed,
    locals: new Map<string, string[]>(),
    params: new Map<string, string[]>(),
    indent: 0,
  }

  return stmtToWat(stmt, ctx)
}

/**
 * Parse a function declaration and generate WAT.
 */
function funcWat(code: string): string {
  const parseResult = parse(code)

  if (parseResult.errors.length > 0) {
    throw new Error(`Parse error: ${parseResult.errors[0].message}`)
  }

  const module = parseResult.module as AST.Module
  if (!module || !module.decls) {
    throw new Error('Failed to parse module')
  }
  const decl = module.decls[0]

  let funcDecl: AST.FuncDecl
  if (decl.kind === 'FuncDecl') {
    funcDecl = decl
  } else if (decl.kind === 'ExportDecl' && decl.item.kind === 'FuncDecl') {
    funcDecl = decl.item
  } else {
    throw new Error('Expected function declaration')
  }

  const checkResult = typecheck(module)
  return funcToWat(funcDecl, checkResult)
}

/**
 * Parse a complete module and generate WAT.
 */
function modWat(code: string): string {
  const parseResult = parse(code)

  if (parseResult.errors.length > 0) {
    throw new Error(`Parse error: ${parseResult.errors[0].message}`)
  }

  const module = parseResult.module as AST.Module
  if (!module || !module.decls) {
    throw new Error('Failed to parse module')
  }
  const checkResult = typecheck(module)
  // A program the checker refuses has no meaning to compile.
  if (checkResult.errors.length > 0) {
    throw new Error(`Check error: ${checkResult.errors.map((e) => e.message).join('; ')}`)
  }
  return moduleToWat(module, checkResult)
}

// === Type Mapping Tests ===

describe('typeToWasm', () => {
  test('primitive types', () => {
    expect(typeToWasm(primitive('i32'))).toEqual(['i32'])
    expect(typeToWasm(primitive('i64'))).toEqual(['i64'])
    expect(typeToWasm(primitive('f32'))).toEqual(['f32'])
    expect(typeToWasm(primitive('f64'))).toEqual(['f64'])
    expect(typeToWasm(primitive('bool'))).toEqual(['i32'])
  })

  test('small integer types map to i32', () => {
    expect(typeToWasm(primitive('i8'))).toEqual(['i32'])
    expect(typeToWasm(primitive('i16'))).toEqual(['i32'])
    expect(typeToWasm(primitive('u8'))).toEqual(['i32'])
    expect(typeToWasm(primitive('u16'))).toEqual(['i32'])
    expect(typeToWasm(primitive('u32'))).toEqual(['i32'])
  })

  test('large integer types map to i64', () => {
    expect(typeToWasm(primitive('i64'))).toEqual(['i64'])
    expect(typeToWasm(primitive('u64'))).toEqual(['i64'])
  })

  test('comptime types throw errors (must be concretized first)', () => {
    expect(() => typeToWasm(comptimeInt(42n))).toThrow('comptime_int should be concretized before codegen')
    expect(() => typeToWasm(comptimeFloat(3.14))).toThrow('comptime_float should be concretized before codegen')
  })

  test('tuples flatten to multiple values', () => {
    const pointType = tuple([
      field('x', primitive('f64')),
      field('y', primitive('f64')),
    ])
    expect(typeToWasm(pointType)).toEqual(['f64', 'f64'])
  })

  test('void returns empty array', () => {
    expect(typeToWasm(VOID)).toEqual([])
  })
})

// === Expression Codegen Tests ===

describe('expression codegen', () => {
  describe('literals', () => {
    test('integer literal', () => {
      expect(exprWat('42')).toBe('(i32.const 42)')
    })

    test('negative integer', () => {
      expect(exprWat('-5')).toBe('(i32.const -5)')
    })

    test('float literal', () => {
      expect(exprWat('3.14')).toBe('(f64.const 3.14)')
    })

    test('boolean true', () => {
      expect(exprWat('true')).toBe('(i32.const 1)')
    })

    test('boolean false', () => {
      expect(exprWat('false')).toBe('(i32.const 0)')
    })
  })

  describe('binary operations', () => {
    test('addition', () => {
      expect(exprWat('1 + 2')).toBe('(i32.add (i32.const 1) (i32.const 2))')
    })

    test('subtraction', () => {
      expect(exprWat('5 - 3')).toBe('(i32.sub (i32.const 5) (i32.const 3))')
    })

    test('multiplication', () => {
      expect(exprWat('4 * 5')).toBe('(i32.mul (i32.const 4) (i32.const 5))')
    })

    test('division', () => {
      const wat = exprWat('10 / 2')
      expect(wat).toContain('i32.div')
    })

    test('modulo', () => {
      const wat = exprWat('10 % 3')
      expect(wat).toContain('i32.rem')
    })

    test('float addition', () => {
      expect(exprWat('1.0 + 2.0')).toBe('(f64.add (f64.const 1) (f64.const 2))')
    })

    test('nested operations', () => {
      const wat = exprWat('1 + 2 * 3')
      // Should respect precedence: 1 + (2 * 3)
      expect(wat).toContain('i32.add')
      expect(wat).toContain('i32.mul')
    })

    test('comparison equals', () => {
      expect(exprWat('5 == 5')).toBe('(i32.eq (i32.const 5) (i32.const 5))')
    })

    test('comparison not equals', () => {
      expect(exprWat('5 != 3')).toBe('(i32.ne (i32.const 5) (i32.const 3))')
    })

    test('comparison less than', () => {
      const wat = exprWat('3 < 5')
      expect(wat).toContain('i32.lt')
    })

    test('comparison greater than', () => {
      const wat = exprWat('5 > 3')
      expect(wat).toContain('i32.gt')
    })

    test('bitwise and', () => {
      expect(exprWat('5 & 3')).toBe('(i32.and (i32.const 5) (i32.const 3))')
    })

    test('bitwise or', () => {
      expect(exprWat('5 | 3')).toBe('(i32.or (i32.const 5) (i32.const 3))')
    })

    test('bitwise xor', () => {
      expect(exprWat('5 ^ 3')).toBe('(i32.xor (i32.const 5) (i32.const 3))')
    })

    test('left shift', () => {
      expect(exprWat('1 << 4')).toBe('(i32.shl (i32.const 1) (i32.const 4))')
    })

    test('logical and', () => {
      const wat = exprWat('true && false')
      // Comptime booleans may be evaluated directly
      expect(wat).toContain('i32')
    })

    test('logical or', () => {
      const wat = exprWat('false || true')
      expect(wat).toContain('i32')
    })
  })

  describe('signed vs unsigned operations', () => {
    test('signed division uses div_s', () => {
      const wat = funcWat('func div(a: i32, b: i32) -> i32 => a / b')
      expect(wat).toContain('i32.div_s')
    })

    test('unsigned division uses div_u', () => {
      const wat = funcWat('func div(a: u32, b: u32) -> u32 => a / b')
      expect(wat).toContain('i32.div_u')
    })

    test('signed modulo uses rem_s', () => {
      const wat = funcWat('func rem(a: i32, b: i32) -> i32 => a % b')
      expect(wat).toContain('i32.rem_s')
    })

    test('unsigned modulo uses rem_u', () => {
      const wat = funcWat('func rem(a: u32, b: u32) -> u32 => a % b')
      expect(wat).toContain('i32.rem_u')
    })

    test('signed less than uses lt_s', () => {
      const wat = funcWat('func lt(a: i32, b: i32) -> bool => a < b')
      expect(wat).toContain('i32.lt_s')
    })

    test('unsigned less than uses lt_u', () => {
      const wat = funcWat('func lt(a: u32, b: u32) -> bool => a < b')
      expect(wat).toContain('i32.lt_u')
    })

    test('signed greater than uses gt_s', () => {
      const wat = funcWat('func gt(a: i32, b: i32) -> bool => a > b')
      expect(wat).toContain('i32.gt_s')
    })

    test('unsigned greater than uses gt_u', () => {
      const wat = funcWat('func gt(a: u32, b: u32) -> bool => a > b')
      expect(wat).toContain('i32.gt_u')
    })

    test('signed right shift uses shr_s', () => {
      const wat = funcWat('func shr(a: i32, b: i32) -> i32 => a >> b')
      expect(wat).toContain('i32.shr_s')
    })

    test('unsigned right shift uses shr_u', () => {
      const wat = funcWat('func shr(a: u32, b: u32) -> u32 => a >> b')
      expect(wat).toContain('i32.shr_u')
    })

    test('rotate right uses rotr, whatever the sign', () => {
      expect(funcWat('func rot(a: i32, b: i32) -> i32 => a >>> b')).toContain('(i32.rotr (local.get $a) (local.get $b))')
      expect(funcWat('func rot(a: u64, b: u64) -> u64 => a >>> b')).toContain('(i64.rotr (local.get $a) (local.get $b))')
      expect(funcWat('func rot(a: u32, b: u32) -> u32 { a >>>= b\n return a }')).toContain('(i32.rotr (local.get $a) (local.get $b))')
    })

    test('an 8- or 16-bit rotation stays within its width', () => {
      expect(funcWat('func rot(a: u8, b: u8) -> u8 => a <<< b'))
        .toContain('(i32.and (i32.rotl (i32.mul (local.get $a) (i32.const 16843009)) (local.get $b)) (i32.const 255))')
      expect(funcWat('func rot(a: u16, b: u16) -> u16 => a >>> b'))
        .toContain('(i32.and (i32.rotr (i32.mul (local.get $a) (i32.const 65537)) (local.get $b)) (i32.const 65535))')
      expect(funcWat('func rot(a: i8, b: u8) -> i8 => a <<< b'))
        .toContain('(i32.rotl (i32.mul (i32.and (local.get $a) (i32.const 255)) (i32.const 16843009)) (local.get $b))')
    })

    test('64-bit unsigned division uses i64.div_u', () => {
      const wat = funcWat('func div(a: u64, b: u64) -> u64 => a / b')
      expect(wat).toContain('i64.div_u')
    })

    test('64-bit signed division uses i64.div_s', () => {
      const wat = funcWat('func div(a: i64, b: i64) -> i64 => a / b')
      expect(wat).toContain('i64.div_s')
    })
  })

  // An operand is typed by its own node: a nested expression that starts or
  // ends where its parent does must not take the parent's type.
  describe('nested operands keep their own types', () => {
    test('signed division on the right of a comparison', () => {
      const wat = funcWat('func f(a: i32, b: i32, c: i32) -> bool => a < b / c')
      expect(wat).toContain('(i32.lt_s (local.get $a) (i32.div_s (local.get $b) (local.get $c)))')
    })

    test('64-bit addition on the right of a comparison', () => {
      const wat = funcWat('func f(a: i64, b: i64, c: i64) -> bool => a < b + c')
      expect(wat).toContain('(i64.lt_s (local.get $a) (i64.add (local.get $b) (local.get $c)))')
    })

    test('float multiplication on the right of a comparison', () => {
      const wat = funcWat('func f(a: f64, b: f64) -> bool => a >= 0.72 * b')
      expect(wat).toContain('(f64.ge (local.get $a) (f64.mul (f64.const 0.72) (local.get $b)))')
    })

    test('a narrower product is computed in its own type, then widened', () => {
      const wat = funcWat('func f(a: i64, b: i32, c: i32) -> i64 => a + b * c')
      expect(wat).toContain('(i64.add (local.get $a) (i64.extend_i32_s (i32.mul (local.get $b) (local.get $c))))')
    })

    test('a narrower sum on the right of a comparison widens with its sign', () => {
      const wat = funcWat('func f(a: i64, b: i32, c: i32) -> bool => a < b + c')
      expect(wat).toContain('(i64.lt_s (local.get $a) (i64.extend_i32_s (i32.add (local.get $b) (local.get $c))))')
    })

    test('comparisons on both sides of a logical operator', () => {
      const wat = funcWat('func f(a: i64, b: i64) -> bool => a == b && a < b - 1')
      expect(wat).toContain('(i64.eq (local.get $a) (local.get $b))')
      expect(wat).toContain('(i64.lt_s (local.get $a) (i64.sub (local.get $b) (i64.const 1)))')
    })

    test('a member expression argument is found by a builtin', () => {
      const wat = funcWat('func f(a: []u8, b: []u8) -> u32 => min(a.len, b.len)')
      expect(wat).toContain('i32.lt_u')
    })

    test('a compound assignment reads the type of an operator value', () => {
      const wat = funcWat(`func f(a: i32, b: i32) -> i64 {
        let x: i64 = 1
        x += a * b
        return x
      }`)
      expect(wat).toContain('(i64.add (local.get $x) (i64.extend_i32_s (i32.mul (local.get $a) (local.get $b))))')
    })
  })

  // The checker marks each value that meets a wider type; codegen converts it
  // there, and only where the wasm type changes.
  describe('implicit widening', () => {
    test('an integer operand of a float operation', () => {
      const wat = funcWat('func f(r: f64, n: i32) -> f64 => r * n')
      expect(wat).toContain('(f64.mul (local.get $r) (f64.convert_i32_s (local.get $n)))')
    })

    test('an unsigned operand converts unsigned', () => {
      const wat = funcWat('func f(r: f64, n: u32) -> bool => n >= r')
      expect(wat).toContain('(f64.ge (f64.convert_i32_u (local.get $n)) (local.get $r))')
    })

    test('f32 promotes to f64', () => {
      const wat = funcWat('func f(a: f32, b: f64) -> f64 => a + b')
      expect(wat).toContain('(f64.add (f64.promote_f32 (local.get $a)) (local.get $b))')
    })

    test('integers extend by their own sign', () => {
      const wat = funcWat('func f(a: i32, b: u32, c: i64) -> i64 => a + c + b')
      expect(wat).toContain('(i64.add (i64.add (i64.extend_i32_s (local.get $a)) (local.get $c)) (i64.extend_i32_u (local.get $b)))')
    })

    test('widening within 32 bits costs nothing', () => {
      const wat = funcWat('func f(a: u8, b: i32) -> bool => a < b')
      expect(wat).toContain('(i32.lt_s (local.get $a) (local.get $b))')
    })

    test('a float constant makes an integer operand a float', () => {
      const wat = funcWat('func f(n: i32) -> f64 => n * 0.5')
      expect(wat).toContain('(f64.mul (f64.convert_i32_s (local.get $n)) (f64.const 0.5))')
    })

    test('let, assignment and compound assignment', () => {
      const wat = funcWat(`func f(n: i32, x: f32) -> f64 {
        let a: f64 = n
        a = x
        a += n
        a /= x
        return a
      }`)
      expect(wat).toContain('(local.set $a (f64.convert_i32_s (local.get $n)))')
      expect(wat).toContain('(local.set $a (f64.promote_f32 (local.get $x)))')
      expect(wat).toContain('(local.set $a (f64.add (local.get $a) (f64.convert_i32_s (local.get $n))))')
      expect(wat).toContain('(local.set $a (f64.div (local.get $a) (f64.promote_f32 (local.get $x))))')
    })

    test('return, with a block or an expression body', () => {
      expect(funcWat('func f(n: i32) -> i64 { return n }')).toContain('(i64.extend_i32_s (local.get $n)) (return)')
      expect(funcWat('func f(x: f32) -> f64 => x')).toContain('(f64.promote_f32 (local.get $x))')
    })

    test('call arguments and constructor fields', () => {
      const wat = modWat(`
        type Pair = (a: i64, b: f64)
        func take(x: i64, y: f64) -> f64 => y
        func f(n: i32) -> f64 => take(n, n)
        func g(a: i32, b: f32) -> Pair => Pair(a:, b:)
      `)
      expect(wat).toContain('(call $take (i64.extend_i32_s (local.get $n)) (f64.convert_i32_s (local.get $n)))')
      expect(wat).toContain('(i64.extend_i32_s (local.get $a)) (f64.promote_f32 (local.get $b))')
    })

    test('if and match branches', () => {
      const wat = funcWat('func f(c: bool, n: i32, x: f64) -> f64 => if c { n } else { x }')
      expect(wat).toContain('(if (result f64) (local.get $c) (then (f64.convert_i32_s (local.get $n))) (else (local.get $x)))')
      const inferred = funcWat(`func f(c: bool, n: i32, big: i64) -> i64 {
        let v = if c { n } else { big }
        return v
      }`)
      expect(inferred).toContain('(if (result i64) (local.get $c) (then (i64.extend_i32_s (local.get $n))) (else (local.get $big)))')
      const matched = funcWat(`func f(k: i32, n: i32, big: i64) -> i64 => match k { 0 => n
        _ => big }`)
      expect(matched).toContain('(then (i64.extend_i32_s (local.get $n)))')
    })

    test('a constant is emitted in the type it is used as', () => {
      expect(funcWat('func f() -> f32 { let x: f32 = 1.0 / 3\n return x }')).toContain('(f32.div (f32.const 1) (f32.const 3))')
      expect(funcWat('func f(n: i64) -> i64 => n + 2 * 3')).toContain('(i64.add (local.get $n) (i64.mul (i64.const 2) (i64.const 3)))')
      expect(funcWat('func f(x: f64) -> bool => x > 0')).toContain('(f64.gt (local.get $x) (f64.const 0))')
    })

    test('the elements of an array literal', () => {
      const wat = funcWat(`func f(n: i32) -> f64 {
        let a: [2]f64 = [n, 2]
        let b: [2]i64 = [0; 2]
        return a[0]
      }`)
      expect(wat).toContain('(local.set $a_0 (f64.convert_i32_s (local.get $n)))')
      expect(wat).toContain('(local.set $a_1 (f64.const 2))')
      expect(wat).toContain('(local.set $b_1 (i64.const 0))')
    })

    test('the elements of an untyped array literal, to the widest of them', () => {
      const wat = funcWat(`func f(n: i32, big: i64) -> i64 {
        let a = [n, big, 1]
        return a[0]
      }`)
      expect(wat).toContain('(local.set $a_0 (i64.extend_i32_s (local.get $n)))')
      expect(wat).toContain('(local.set $a_1 (local.get $big))')
      expect(wat).toContain('(local.set $a_2 (i64.const 1))')
    })

    test('an integer literal is float data in a float array', () => {
      const wat = modWat(`
        export memory 1
        data halves = [1:f32, 2, 3]
        export func f() -> f32 => halves[1]
      `)
      // 1.0, 2.0, 3.0 as little-endian f32: 0000803f 00000040 00004040
      expect(wat).toContain('"\\00\\00\\80?\\00\\00\\00@\\00\\00@@"')
    })

    test('a complement is computed in the type it is used as', () => {
      expect(funcWat('func f(x: u64) -> u64 => x & ~0xff')).toContain('(i64.and (local.get $x) (i64.xor (i64.const 255) (i64.const -1)))')
      expect(funcWat('func f(x: u8) -> bool => x == ~0')).toContain('(i32.eq (local.get $x) (i32.and (i32.xor (i32.const 0) (i32.const -1)) (i32.const 255)))')
    })

    test('a constant with a fixed form is converted like a value', () => {
      const wat = funcWat('func f(p: *[4]i32) -> i64 { let n: i64 = p.len\n return n }')
      expect(wat).toContain('(local.set $n (i64.extend_i32_s (i32.const 4)))')
    })
  })

  describe('operators', () => {
    test('float division in a compound assignment', () => {
      const wat = funcWat('func f(x: f64) -> f64 { x /= 2.0\n return x }')
      expect(wat).toContain('(f64.div (local.get $x) (f64.const 2))')
    })

    test('a shift count is fitted to the value, which keeps its sign', () => {
      expect(funcWat('func f(x: i64, n: u8) -> i64 => x >> n')).toContain('(i64.shr_s (local.get $x) (i64.extend_i32_u (local.get $n)))')
      expect(funcWat('func f(x: i32, n: u64) -> i64 => x >> n')).toContain('(i64.shr_s (i64.extend_i32_s (local.get $x)) (local.get $n))')
      expect(funcWat('func f(x: u32, n: u64) -> u32 { x <<= n\n return x }')).toContain('(i32.shl (local.get $x) (i32.wrap_i64 (local.get $n)))')
    })

    test('a wide operand widens with its sign', () => {
      const wat = funcWat('func f(x: i128, n: i32) -> i128 => x + n')
      expect(wat).toContain('(call $__w1_sext_2 (i64.extend_i32_s (local.get $n)))')
    })

    test('a match compares its patterns in the subject\'s type', () => {
      const wat = funcWat(`func f(x: i64) -> i32 => match x {
        5000000000 => 1
        _ => 0
      }`)
      expect(wat).toContain('(i64.eq (local.get $x) (i64.const 5000000000))')
    })

    test('a trailing expression widens to the named result', () => {
      const wat = funcWat('func f(n: i32) -> (r: i64) { n }')
      expect(wat).toContain('(i64.extend_i32_s (local.get $n))\n(local.set $r)')
    })

    test('a trailing tuple literal fills the named results, each element widened', () => {
      const wat = funcWat('func f(n: i32) -> (r: i64, s: f64) { (n, n) }')
      expect(wat).toContain('(i64.extend_i32_s (local.get $n)) (f64.convert_i32_s (local.get $n))\n(local.set $s)\n(local.set $r)')
    })

    test('an expression body is the named results: nothing is returned after it', () => {
      const wat = funcWat('func f(n: i32) -> (r: i64, s: f64) => (n, n)')
      expect(wat).toContain('(i64.extend_i32_s (local.get $n)) (f64.convert_i32_s (local.get $n))')
      expect(wat).not.toContain('local.get $r')
    })

    test('an expression body passes a call\'s values on as the named results', () => {
      const wat = funcWat(`func f(n: u32) -> (q: u32, r: u32) => pair(n)
        func pair(n: u32) -> (u32, u32) => (n / 10, n % 10)`)
      expect(wat).toContain('(result i32 i32)')
      expect(wat).toContain('(call $pair (local.get $n))')
      expect(wat).not.toContain('local.get $q')
    })

    test('a match evaluates a computed subject once, into a scratch local', () => {
      const wat = funcWat(`func f(a: i64, b: i64) -> i32 => match a * b {
        6 => 1
        8 => 2
        _ => 0
      }`)
      expect(wat).toContain('(local.set $__match_')
      expect(wat.match(/i64\.mul/g)).toHaveLength(1)
      expect(wat).toMatch(/\(i64\.eq \(local\.get \$__match_\d+\) \(i64\.const 8\)\)/)
    })

    test('the scratch local of a match is declared wherever the match stands', () => {
      // The pass that declares a function's locals didn't look inside the
      // index of an assignment's target, the value of a `set` or a repeated
      // value. A match there kept its subject in a local nothing declared.
      const subject = 'match x + 1 {\n 1 => 2\n _ => 3\n }'
      for (const body of [
        `buf[((${subject}) as u32) & 3] = 7`,
        `buf[((${subject}) as u32) & 3] += 7`,
        `let a = 0\n let d = 0\n set (a, d) = ((${subject}), 1)`,
        `let r = [(${subject}); 2]`,
      ]) {
        const wat = funcWat(`func f(x: i32) {\n ${body}\n}\ndata buf = mut [0:u8; 4]`)
        const scratch = wat.match(/\$__match_\d+/)?.[0]
        expect(scratch).toBeDefined()
        expect(wat).toContain(`(local ${scratch} i32)`)
      }
    })

    test('a match reads a plain subject directly', () => {
      const wat = funcWat(`func f(k: i32) -> i32 => match k {
        6 => 1
        _ => 0
      }`)
      expect(wat).toContain('(i32.eq (local.get $k) (i32.const 6))')
      expect(wat).not.toContain('__match_')
    })

    test('a match on a subject of several values keeps it in no local', () => {
      const wat = funcWat('func f(s: []u8) -> i32 => match s { _ => 1 }')
      expect(wat).not.toContain('__match_')
      expect(wat).not.toContain('local.get $s_ptr')
    })

    test('a match evaluates a subject of several values once, and drops them', () => {
      const wat = funcWat(`func f() -> i32 => match g() { _ => 1 }
        func g() -> (i32, i64) => (1, 2)`)
      expect(wat).toContain('(call $g)\n(drop)\n(drop)\n(i32.const 1)')
      expect(wat).not.toContain('__match_')
    })

    test('a match evaluates a subject with no value', () => {
      const wat = funcWat(`func f() -> i32 => match g() { _ => 1 }
        func g() {}`)
      expect(wat).toContain('(call $g)\n(i32.const 1)')
      expect(wat).not.toContain('(drop)')
    })

    test('a match loads a subject of several values from memory, and drops them all', () => {
      // A tuple behind a pointer is one load for each field: as many values as are dropped.
      const behind = funcWat('func f(p: *(u32, u32)) -> i32 => match p.* { _ => 5 }')
      expect(behind).toContain('(i32.load (local.get $p)) (i32.load offset=4 (local.get $p))\n(drop)\n(drop)\n(i32.const 5)')
      const element = funcWat('func f(s: [](u32, u64)) -> i32 => match s[0] { _ => 5 }')
      expect(element).toContain('(i64.load offset=4 (local.get $__tmp_0))\n(drop)\n(drop)\n(i32.const 5)')
      expect(behind + element).not.toContain('__match_')
    })

    test('a match arm block gives its value', () => {
      const wat = funcWat(`func f(k: i32) -> i32 => match k {
        0 => { let x = k + 1\n x * 2 }
        _ => 7
      }`)
      expect(wat).toContain('(then (local.set $x (i32.add (local.get $k) (i32.const 1)))\n(i32.mul (local.get $x) (i32.const 2)))')
    })
  })

  describe('narrowing casts', () => {
    test('an i64 cast to an 8- or 16-bit type is cut to its width', () => {
      expect(funcWat('func f(x: i64) -> u8 => x as u8')).toContain('(i32.and (i32.wrap_i64 (local.get $x)) (i32.const 255))')
      expect(funcWat('func f(x: u64) -> i16 => x as i16')).toContain('(i32.shr_s (i32.shl (i32.wrap_i64 (local.get $x)) (i32.const 16)) (i32.const 16))')
    })

    test('a float cast to an 8- or 16-bit type is cut to its width', () => {
      expect(funcWat('func f(x: f64) -> u8 => x as u8')).toContain('(i32.and (i32.trunc_f64_u (local.get $x)) (i32.const 255))')
      expect(funcWat('func f(x: f32) -> i8 => i8(x)')).toContain('(i32.shr_s (i32.shl (i32.trunc_f32_s (local.get $x)) (i32.const 24)) (i32.const 24))')
    })

    test('a cast to a 32-bit type needs no cut', () => {
      expect(funcWat('func f(x: i64) -> u32 => x as u32')).toContain('  (i32.wrap_i64 (local.get $x))\n')
      expect(funcWat('func f(x: f64) -> i32 => x as i32')).toContain('  (i32.trunc_f64_s (local.get $x))\n')
    })
  })

  describe('unary operations', () => {
    test('logical not', () => {
      const wat = exprWat('!true')
      expect(wat).toContain('i32.eqz')
    })

    test('bitwise not', () => {
      const wat = exprWat('~5')
      expect(wat).toContain('i32.xor')
    })
  })

  describe('conditionals', () => {
    test('if expression', () => {
      const wat = exprWat('if true { 1 } else { 2 }')
      expect(wat).toContain('if')
      expect(wat).toContain('then')
      expect(wat).toContain('else')
    })

    test('constant branches are all emitted in the type that holds each of them', () => {
      const wat = funcWat(`func f(c: bool) -> i64 {
        let v = if c { -2147483648 } else { 2147483648 }
        return v
      }`)
      expect(wat).toContain('(local $v i64)')
      expect(wat).toContain('(if (result i64) (local.get $c) (then (i64.const -2147483648)) (else (i64.const 2147483648)))')
    })

    test('tuple branches of constants are emitted field by field in one type', () => {
      const wat = funcWat(`func f(c: bool, x: i64) -> i64 {
        let (a, b) = if c { (1, 2) } else { (x, 4) }
        return a + b
      }`)
      expect(wat).toContain('(local $a i64)')
      expect(wat).toContain('(local $b i32)')
      expect(wat).toContain('(if (result i64 i32) (local.get $c) (then (i64.const 1) (i32.const 2)) (else (local.get $x) (i32.const 4)))')
    })

    test('a tuple literal in parentheses takes the expected type field by field', () => {
      const wat = funcWat('func f(n: u8) -> (i64, u32) => ((n, 300))')
      expect(wat).toContain('(i64.extend_i32_u (local.get $n)) (i32.const 300)')
    })

    test('an if let used as a value leaves the value of each branch', () => {
      const wat = funcWat('func f(s: []u8, i: u32, d: i32) -> i32 => if let b = s[i] { b } else { d }')
      expect(wat).toMatch(/\(if \(result i32\) \(i32\.lt_u [^\n]*\(then \(local\.set \$b \(i32\.load8_u [^\n]*\n\(local\.get \$b\)\) \(else \(local\.get \$d\)\)\)/)
      expect(wat).not.toContain('(drop)')
    })

    test('an if let widens each branch to the type its value is used as', () => {
      const wat = funcWat('func f(p: ?*u8, a: i32, b: u32) -> i64 => if let q = p { a } else { b }')
      expect(wat).toContain('(if (result i64)')
      expect(wat).toContain('(i64.extend_i32_s (local.get $a))')
      expect(wat).toContain('(i64.extend_i32_u (local.get $b))')
    })

    test('an if let keeps its elif branches', () => {
      const wat = funcWat(`func f(s: []u8, i: u32, c: bool) -> i32 {
        if let b = s[i] { return 1 } elif c { return 2 } else { return 3 }
      }`)
      expect(wat).toContain('(else (if  (local.get $c) (then (i32.const 2) (return)) (else (i32.const 3) (return))))')
    })

    // Issue #43: an elif let was accepted and bound nothing.
    test('an elif let tests its value and binds it as an if let does', async () => {
      const { stmt, value, write, chain } = await run(`
        data cells = mut [7:u32, 8, 9]
        data names = ["ab", "cde"]
        export func stmt(c: i32, i: u32, j: u32) -> u32 {
          if c == 1 {
            return 1
          } elif let a = names[i] {
            return a.len + 10
          } elif let b = cells[j] {
            return b + 100
          }
          return 0
        }
        export func value(c: i32, i: u32) -> u32 => if c == 1 { 1 } elif let p = &cells[i] { p.* + 20 } elif c == 2 { 2 } else { 0 }
        export func write(c: i32, i: u32, v: u32) -> u32 {
          if c == 1 { } elif let p = &cells[i] { p.* = v }
          return cells[2]
        }
        export func chain(i: u32, j: u32) -> u32 => if let a = cells[i] { a } elif let s = names[j] { s.len * 1000 } else { 5 }
      `)
      expect([stmt(1, 0, 0), stmt(0, 1, 0), stmt(0, 9, 2), stmt(0, 9, 3)]).toEqual([1, 13, 109, 0])
      expect([value(1, 0), value(0, 1), value(2, 7), value(0, 7)]).toEqual([1, 28, 2, 0])
      expect([write(1, 2, 50), write(0, 2, 60), write(0, 3, 70)]).toEqual([9, 60, 60])
      expect([chain(0, 0), chain(5, 0), chain(5, 1), chain(5, 2)]).toEqual([7, 2000, 3000, 5])
    })

    test('an elif let compiles to an if let in the else of the branch before it', () => {
      const wat = funcWat(`func f(c: bool, p: ?*u8) -> u32 {
        if c { return 1 } elif let q = p { return q.* as u32 }
        return 0
      }`)
      expect(wat).toMatch(/\(if {2}\(local\.get \$c\) \(then \(i32\.const 1\) \(return\)\) \(else \(local\.set \$__iflet_ptr_\w+ \(local\.get \$p\)\)\n\(if {2}\(local\.get \$__iflet_ptr_\w+\) \(then \(local\.set \$q \(local\.get \$__iflet_ptr_\w+\)\)/)
    })
  })
})

// === Statement Codegen Tests ===

describe('statement codegen', () => {
  test('return statement', () => {
    const wat = stmtWat('return 42')
    expect(wat).toContain('i32.const 42')
    expect(wat).toContain('return')
  })

  test('conditional return', () => {
    const wat = stmtWat('return 1 when true')
    expect(wat).toContain('if')
    expect(wat).toContain('return')
  })
})

// === Function Codegen Tests ===

describe('function codegen', () => {
  test('simple function', () => {
    const wat = funcWat('func add(a: i32, b: i32) -> i32 => a + b')
    expect(wat).toContain('(func $add')
    expect(wat).toContain('(param $a i32)')
    expect(wat).toContain('(param $b i32)')
    expect(wat).toContain('(result i32)')
    expect(wat).toContain('i32.add')
  })

  test('void function', () => {
    const wat = funcWat('func noop() {}')
    expect(wat).toContain('(func $noop')
    expect(wat).not.toContain('result')
  })

  test('function with local', () => {
    const wat = funcWat(`
      func test() -> i32 {
        let x: i32 = 5
        return x
      }
    `)
    expect(wat).toContain('(local $x i32)')
    expect(wat).toContain('local.set $x')
    expect(wat).toContain('local.get $x')
  })

  test('function with float params', () => {
    const wat = funcWat('func scale(x: f64, s: f64) -> f64 => x * s')
    expect(wat).toContain('(param $x f64)')
    expect(wat).toContain('(param $s f64)')
    expect(wat).toContain('(result f64)')
    expect(wat).toContain('f64.mul')
  })
})

// === Defer Codegen Tests ===

describe('defer codegen', () => {
  // Offsets of each needle in order; -1 where one is missing or out of order.
  const order = (wat: string, needles: string[]) => {
    let at = 0
    return needles.map(n => { const i = wat.indexOf(n, at); if (i >= 0) at = i + n.length; return i })
  }

  test('runs at the end of the block, newest first', () => {
    const wat = funcWat(`
      func f() {
        defer one()
        defer two()
        three()
      }
    `)
    expect(order(wat, ['call $three', 'call $two', 'call $one']).every((i) => i >= 0)).toBe(true)
  })

  test('runs before return, after the value is computed', () => {
    const wat = funcWat(`
      func f(x: i32) -> i32 {
        defer done()
        return x + 1
      }
    `)
    expect(order(wat, ['i32.add', 'call $done', 'return']).every((i) => i >= 0)).toBe(true)
  })

  test('conditional exits run their defers only when taken', () => {
    const wat = funcWat(`
      func f(x: i32) -> i32 {
        defer done()
        return 0 when x == 0
        return 1
      }
    `)
    // Inside the if, and again before the final return.
    expect(wat.match(/call \$done/g)?.length).toBe(2)
    expect(wat).toMatch(/\(if[\s\S]*call \$done[\s\S]*\(return\)/)
  })

  test("break and continue run the loop body defers, not the function's", () => {
    const wat = funcWat(`
      func f() {
        defer outer()
        loop {
          defer inner()
          break
        }
      }
    `)
    // inner: once, before the break that ends the body; outer: once, at the end.
    expect(wat.match(/call \$inner/g)?.length).toBe(1)
    expect(wat.match(/call \$outer/g)?.length).toBe(1)
    expect(order(wat, ['call $inner', 'br $break']).every((i) => i >= 0)).toBe(true)
  })

  test('runs at the end of a test block', async () => {
    const { mkdtemp, writeFile } = await import('fs/promises')
    const { tmpdir } = await import('os')
    const { join } = await import('path')
    const { loadModule } = await import('./loader')
    const { typecheckProgram } = await import('./checker')
    const { programToWatWithTests } = await import('./codegen')
    const file = join(await mkdtemp(join(tmpdir(), 'ents-')), 'defer-test.ents')
    await writeFile(file, `
      func done() {}
      test "cleanup" {
        defer done()
        assert true
      }
    `)
    const load = await loadModule(file, { includeTests: true })
    const check = typecheckProgram(load.modules, file, { includeTests: true })
    const { wat } = programToWatWithTests(load.modules, check.results, file)
    const testFunc = wat.slice(wat.indexOf(';; test "cleanup"'))
    expect(testFunc).toContain('call $done')
  })

  test('only defers already reached run at an early exit', () => {
    const wat = funcWat(`
      func f(x: i32) {
        return when x == 0
        defer later()
      }
    `)
    const early = wat.slice(0, wat.indexOf('(return)'))
    expect(early).not.toContain('call $later')
  })
})

// === Values in Memory ===

// Compiles a module, validates the wasm and returns its exports.
async function run(code: string): Promise<Record<string, (...args: number[]) => unknown>> {
  const { default: wabt } = await import('wabt')
  const wasm = (await wabt()).parseWat('test.wat', modWat(code), { multi_value: true, bulk_memory: true })
  wasm.validate()
  const { buffer } = wasm.toBinary({})
  wasm.destroy()
  const { instance } = await WebAssembly.instantiate(buffer, {})
  return instance.exports as Record<string, (...args: number[]) => unknown>
}

// The body of one function of a module, one instruction per line.
function bodyOf(code: string, name: string): string[] {
  const parseResult = parse(code)
  if (parseResult.errors.length > 0) {
    throw new Error(`Parse error: ${parseResult.errors[0].message}`)
  }
  const module = parseResult.module as AST.Module
  const decl = module.decls.find((d): d is AST.FuncDecl => d.kind === 'FuncDecl' && d.ident === name)
  if (!decl) throw new Error(`No function ${name}`)
  const lines = funcToWat(decl, typecheck(module)).split('\n').map((l) => l.trim())
  return lines.slice(1, -1).filter((l) => l !== '' && !l.startsWith('(local $'))
}

const SPOT = `
  data space = mut [0:u8; 256]
  type Spot = (c: i32, di: i32, room: i32)
  type Lane = (cells: []i32, free: i32)
  type Option = (d: i32, lane: Lane)
  global calls: u32 = 0
  func next() -> u32 {
    calls += 1
    return calls
  }
  func make(n: i32) -> Spot => Spot(n, n + 1, n + 2)
  func pair() -> []i32 => ((space as [*]i32), 2:u32)
`

describe('counted loops', () => {
  test('a negative signed count runs the loop zero times', async () => {
    const { count, small, unsigned } = await run(`
      export func count(n: i32) -> i32 {
        let t = 0
        for i in n {
          t += 1
          break when t > 1000
        }
        return t
      }
      export func small(n: i8) -> i32 {
        let t = 0
        for i in n { t += 1 }
        return t
      }
      export func unsigned(n: u32) -> u32 {
        let t: u32 = 0
        for i in n {
          t += 1
          break when t > 1000
        }
        return t
      }
    `)
    expect([count(3), count(0), count(-1), count(-2147483648), count(2147483647)]).toEqual([3, 0, 0, 0, 1001])
    expect([small(5), small(-3)]).toEqual([5, 0])
    // An unsigned count of 2^32 - 1 is that many.
    expect([unsigned(3), unsigned(0), unsigned(-1)]).toEqual([3, 0, 1001])
  })

  // Issue #257: a signed count was compared signed, so an i given 2^31 or
  // more was below it, and the loop did not end.
  test('the variable of a signed count is a u32, compared unsigned with it', async () => {
    const code = `
      func five() -> i32 => 5
      global g: i32 = 5
      type L = (n: i8, m: u32)
      export func c_assign_signed(n: i32) -> u32 {
        let t: u32 = 0
        for i in n { t += 1  if t == 1 { i = 0x80000000 }  break when t > 10 }
        return t
      }
      export func call() -> u32 {
        let t: u32 = 0
        for i in five() { t += 1  if t == 1 { i = 0x80000000 }  break when t > 10 }
        return t
      }
      export func changed(n: i32) -> u32 {
        let t: u32 = 0
        for i in n { n = -1  t += 1  if t == 1 { i = 0x80000000 }  break when t > 10 }
        return t
      }
      export func glob() -> u32 {
        let t: u32 = 0
        for i in g { t += 1  if t == 1 { i = 0x80000000 }  break when t > 10 }
        return t
      }
      export func field(n: i32) -> u32 {
        let l = L(n as i8, 0)
        let t: u32 = 0
        for i in l.n { t += 1  if t == 1 { i = 200 }  break when t > 10 }
        return t
      }
      export func steps(n: i32) -> u32 {
        let t: u32 = 0
        for i in n { t += i }
        return t
      }
    `
    const { c_assign_signed, call, changed, glob, field, steps } = await run(code)
    expect([c_assign_signed(5), call(), changed(5), glob(), field(5)]).toEqual([1, 1, 1, 1, 1])
    // A negative count still runs no pass, and one that isn't runs as many.
    expect([c_assign_signed(-1), c_assign_signed(0), changed(-5), field(-3), steps(4), steps(-4), steps(-2147483648)]).toEqual([0, 0, 0, 0, 6, 0, 0])
    // The count is tested for being above 0 once, before the first pass,
    // and i is compared unsigned with it after each pass (11.3).
    expect(bodyOf('func steps(n: i32) -> u32 {\n let t: u32 = 0\n for i in n { t += i }\n return t\n}', 'steps')).toEqual([
      '(local.set $t (i32.const 0))',
      '(local.set $i (i32.const 0))',
      '(if $break (i32.gt_s (local.get $n) (i32.const 0)) (then',
      '(loop $next',
      '(block $continue',
      '(local.set $t (i32.add (local.get $t) (local.get $i)))',
      ')',
      '(br_if $next (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $n)))',
      ')',
      '))',
      '(local.get $t) (return)',
      '(unreachable)',
    ])
  })

  test('an unsigned or constant count is compared unsigned, and only a negative one is guarded signed', () => {
    const wat = modWat(`
      def k = -3
      export func f(n: u32) -> u32 {
        let t: u32 = 0
        for i in n { t += 1 }
        for i in 4 { t += 1 }
        for i in -3 { t += 1 }
        for i in k { t += 1 }
        return t
      }
    `)
    const step = (count: string) => `(br_if $next (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) ${count}))`
    expect(wat).toContain('(if $break (local.get $n) (then')
    expect(wat).toContain(step('(local.get $n)'))
    expect(wat).toContain('(if $break (i32.const 4) (then')
    expect(wat).toContain(step('(i32.const 4)'))
    // -3 and the def k of it: a signed guard, and the step unsigned.
    expect(wat.match(/\(if \$break \(i32\.gt_s \(i32\.const -3\) \(i32\.const 0\)\) \(then/g)?.length).toBe(2)
    expect(wat.split(step('(i32.const -3)')).length - 1).toBe(2)
    expect(wat).not.toMatch(/i32\.(ge|lt)_s/)
  })

  test('the count is evaluated once, before the loop', async () => {
    const code = `
      global calls: i32 = 0
      global limit: u32 = 3
      func next() -> u32 {
        calls += 1
        return 4
      }
      export func call() -> i32 {
        calls = 0
        let t = 0
        for i in next() { t += 1 }
        return calls * 100 + t
      }
      export func local(n: u32) -> u32 {
        let t: u32 = 0
        for i in n {
          n = 0
          t += 1
        }
        return t
      }
      export func glob() -> u32 {
        limit = 3
        let t: u32 = 0
        for i in limit {
          limit = 1
          t += 1
        }
        return t
      }
      export func steady(n: u32) -> u32 {
        let t: u32 = 0
        for i in n { t += i }
        return t
      }
      type Lim = (n: u32, m: u32)
      global glim: Lim = (n: 4, m: 0)
      export func field(n: u32) -> u32 {
        let p: Lim = (n: n, m: 0)
        let t: u32 = 0
        for i in p.n {
          p.n = 1
          t += 1
        }
        return t
      }
      export func gfield() -> u32 {
        glim = (n: 4, m: 0)
        let t: u32 = 0
        for i in glim.n {
          glim.n = 1
          t += 1
        }
        return t
      }
      export func fill(xs: []mut u8) {
        for i in xs.len { xs.ptr[i] = 7 }
      }
    `
    const { call, local, glob, steady, field, gfield } = await run(code)
    expect([call(), local(5), glob(), steady(4)]).toEqual([104, 5, 3, 6])
    // Assigning a field of the variable the count is read from changes it
    // too. (A loop variable cannot take its name: `for n in n` over a
    // parameter n is refused, see checker.test.)
    expect([field(5), gfield()]).toEqual([5, 4])
    // A variable the body doesn't change is read where it is compared; a
    // store through a pointer it holds doesn't change it.
    expect(modWat(code)).toContain('(br_if $next (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $n)))')
    expect(modWat(code)).toContain('(br_if $next (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $xs_len)))')
  })
})

// The lowerings of a `for` that the reference states in 11.3, instruction by
// instruction, and what follows from them in 5.2.
describe('for loop lowerings', () => {
  // A loop's scratch locals are named by its offset in the source.
  const shape = (code: string, name: string) => bodyOf(code, name).map((l) => l.replace(/__for_(ptr|end|left)_\d+/g, '__for_$1'))
  const COUNTS = `
    func next() -> u32 => 3
    func constant() -> (t: u32) { for i in 4 { t += i } }
    func variable(n: u32) -> (t: u32) { for i in n { t += i } }
    func computed(n: u32) -> (t: u32) { for i in n * 2 { t += i } }
    func called() -> (t: u32) { for i in next() { t += i } }
    func signed(n: i32) -> (t: u32) { for i in n { t += i } }
    func negative() -> (t: u32) { for i in -3 { t += i } }
  `
  // i = 0; an if on the guard around a loop whose body is the $continue
  // block, then the step, tested unsigned against the count.
  const countLoop = (guard: string, count: string) => [
    '(local.set $i (i32.const 0))',
    `(if $break ${guard} (then`,
    '(loop $next',
    '(block $continue',
    '(local.set $t (i32.add (local.get $t) (local.get $i)))',
    ')',
    `(br_if $next (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) ${count}))`,
    ')',
    '))',
    '(local.get $t)',
  ]

  test('a count loop is an if on the count around a loop tested after each step', () => {
    // A constant, and a variable the body leaves alone, are read where used.
    expect(shape(COUNTS, 'constant')).toEqual(countLoop('(i32.const 4)', '(i32.const 4)'))
    expect(shape(COUNTS, 'variable')).toEqual(countLoop('(local.get $n)', '(local.get $n)'))
    // Anything else is evaluated once, into a scratch local.
    expect(shape(COUNTS, 'computed')).toEqual([
      '(local.set $__tmp_0 (i32.mul (local.get $n) (i32.const 2)))',
      ...countLoop('(local.get $__tmp_0)', '(local.get $__tmp_0)'),
    ])
    expect(shape(COUNTS, 'called')).toEqual([
      '(local.set $__tmp_0 (call $next))',
      ...countLoop('(local.get $__tmp_0)', '(local.get $__tmp_0)'),
    ])
    // A signed count is guarded by being above 0, and then compared unsigned
    // too; a negative constant is a signed count.
    expect(shape(COUNTS, 'signed')).toEqual(countLoop('(i32.gt_s (local.get $n) (i32.const 0))', '(local.get $n)'))
    expect(shape(COUNTS, 'negative')).toEqual(countLoop('(i32.gt_s (i32.const -3) (i32.const 0))', '(i32.const -3)'))
  })

  const WALKS = `
    type Spot = (c: i32, di: i32, room: i32)
    data words = [1:u32, 2, 3]
    data none: *[0]u32 = []
    func array() -> (t: u32) { for x in words { t += x } }
    func array_index() -> (t: u32) { for i, x in words { t += x + i } }
    func slice(s: []u16) -> (t: u32) { for x in s { t += x } }
    func slice_index(s: []u16) -> (t: u32) { for i, x in s { t += x + i } }
    func spots(s: []Spot) -> (t: i32) { for p in s { t += p.room } }
    func empty() -> (t: u32) { for x in none { t += x } }
    func empty_index() -> (t: u32) { for i, x in none { t += i } }
  `

  test('a *[N]T walk is tested after each pass, for the pointer being at the end', () => {
    const walk = (bind: string, body: string, step: string[]) => [
      '(local.set $__for_ptr (i32.const 0))',
      '(local.set $__for_end (i32.add (local.get $__for_ptr) (i32.const 12)))',
      '(block $break',
      '(loop $next',
      bind,
      '(block $continue',
      body,
      ')',
      ...step,
      '(br_if $next (i32.ne (local.tee $__for_ptr (i32.add (local.get $__for_ptr) (i32.const 4))) (local.get $__for_end)))',
      ')',
      ')',
      '(local.get $t)',
    ]
    const bind = '(local.set $x (i32.load (local.get $__for_ptr)))'
    expect(shape(WALKS, 'array')).toEqual(walk(bind, '(local.set $t (i32.add (local.get $t) (local.get $x)))', []))
    expect(shape(WALKS, 'array_index')).toEqual([
      '(local.set $i (i32.const 0))',
      ...walk(bind, '(local.set $t (i32.add (local.get $t) (i32.add (local.get $x) (local.get $i))))', [
        '(local.set $i (i32.add (local.get $i) (i32.const 1)))',
      ]),
    ])
    // A *[0]T has no pass: the pointer is evaluated, and that is all, after
    // the index is set, as in any walk.
    expect(shape(WALKS, 'empty')).toEqual(['(drop (i32.const 0))', '(local.get $t)'])
    expect(shape(WALKS, 'empty_index')).toEqual(['(local.set $i (i32.const 0))', '(drop (i32.const 0))', '(local.get $t)'])
  })

  test('a slice walk counts the elements it has left', () => {
    const walk = (bind: string[], body: string, stride: number, step: string[]) => [
      '(local.get $s_ptr) (local.get $s_len)',
      '(local.set $__for_left)',
      '(local.set $__for_ptr)',
      '(block $break',
      '(loop $next',
      '(br_if $break (i32.eqz (local.get $__for_left)))',
      ...bind,
      '(block $continue',
      body,
      ')',
      `(local.set $__for_ptr (i32.add (local.get $__for_ptr) (i32.const ${stride})))`,
      '(local.set $__for_left (i32.sub (local.get $__for_left) (i32.const 1)))',
      ...step,
      '(br $next)',
      ')',
      ')',
      '(local.get $t)',
    ]
    const bind = ['(local.set $x (i32.load16_u (local.get $__for_ptr)))']
    expect(shape(WALKS, 'slice')).toEqual(walk(bind, '(local.set $t (i32.add (local.get $t) (local.get $x)))', 2, []))
    expect(shape(WALKS, 'slice_index')).toEqual([
      '(local.set $i (i32.const 0))',
      ...walk(bind, '(local.set $t (i32.add (local.get $t) (i32.add (local.get $x) (local.get $i))))', 2, [
        '(local.set $i (i32.add (local.get $i) (i32.const 1)))',
      ]),
    ])
    // A struct element is loaded whole, each part at its offset.
    expect(shape(WALKS, 'spots')).toEqual(walk([
      '(i32.load (local.get $__for_ptr)) (i32.load offset=4 (local.get $__for_ptr)) (i32.load offset=8 (local.get $__for_ptr))',
      '(local.set $p_room)',
      '(local.set $p_di)',
      '(local.set $p_c)',
    ], '(local.set $t (i32.add (local.get $t) (local.get $p_room)))', 12, []))
  })

  test('counts 0, 1, 3, past 2^31, and negative ones', async () => {
    const { passes, big, bigvar, negative, span } = await run(`
      export func passes(n: u32) -> (t: u32) {
        for i in n { t += 1 }
      }
      // After i = 2999999996 the passes for 2999999997 to 2999999999 follow.
      export func big() -> (t: u32) {
        for i in 3000000000 {
          t += 1
          if t == 1 { i = 2999999996 }
        }
      }
      export func bigvar(n: u32) -> (t: u32) {
        for i in n {
          t += 1
          if t == 1 { i = 2999999996 }
        }
      }
      export func negative() -> (t: u32) {
        for i in -3 { t += 1 }
      }
      export func span(lo: i32, hi: i32) -> (t: i32) {
        for k in hi - lo { t += lo + k as i32 }
      }
    `)
    expect([passes(0), passes(1), passes(3)]).toEqual([0, 1, 3])
    expect([big(), bigvar(3000000000), negative()]).toEqual([4, 4, 0])
    expect([span(2, 5), span(5, 2), span(-2, 2)]).toEqual([9, 0, -2])
  })

  test('assigning i changes the passes that follow; the step is compared unsigned', async () => {
    const { far, wrap, signedFar, signedWrap, high, highUnsigned } = await run(`
      export func far(n: u32) -> (t: u32) {
        for i in n {
          t += 1
          if t == 1 { i = 100 }
        }
      }
      export func wrap(n: u32) -> (t: u32) {
        for i in n {
          t += 1
          if t == 1 { i = 0xFFFFFFFF }
        }
      }
      export func signedFar(n: i32) -> (t: u32) {
        for i in n {
          t += 1
          if t == 1 { i = 100 }
        }
      }
      export func signedWrap(n: i32) -> (t: u32) {
        for i in n {
          t += 1
          if t == 1 { i = 0xFFFFFFFF }
        }
      }
      export func high(n: i32) -> (t: u32) {
        for i in n {
          t += 1
          if t == 1 { i = 0x80000000 }
          break when t > 10
        }
      }
      export func highUnsigned(n: u32) -> (t: u32) {
        for i in n {
          t += 1
          if t == 1 { i = 0x80000000 }
          break when t > 10
        }
      }
    `)
    // Past the count: that pass is the last.
    expect([far(5), far(200), signedFar(5), signedFar(200)]).toEqual([1, 100, 1, 100])
    // The step wraps: after 0xFFFFFFFF the next pass has i = 0.
    expect([wrap(3), signedWrap(3)]).toEqual([4, 4])
    // 0x80000001 is past a signed count of 5 as it is past an unsigned one
    // (#257: the step was compared signed, and the loop went on).
    expect([high(5), highUnsigned(5)]).toEqual([1, 1])
  })

  test('continue, break and defer, in count loops, walks and nested loops', async () => {
    const { skip, stop, deferred, walkDigits, walkArray, nested, logged } = await run(`
      global log: u32 = 0
      data digits = [3:u8, 0, 4, 9, 5]
      func note(k: u32) { log = log * 10 + k }
      export func skip(n: u32) -> (t: u32) {
        for i in n {
          continue when i % 2 == 0
          t += i
        }
      }
      export func stop(n: u32) -> (t: u32) {
        for i in n {
          break when i == 3
          t += 1
        }
      }
      export func deferred(n: u32) -> u32 {
        log = 0
        for i in n {
          defer note(i + 1)
          continue when i == 0
          break when i == 2
          note(7)
        }
        return log
      }
      func walk(s: []u8) -> (t: u32) {
        for i, x in s {
          defer note(i)
          continue when x == 0
          break when x == 9
          t = t * 10 + x
        }
      }
      export func walkDigits() -> u32 {
        log = 0
        return walk(digits)
      }
      export func walkArray() -> (t: u32) {
        for i, x in digits {
          continue when x == 0
          break when x == 9
          t = t * 10 + x + i
        }
      }
      export func nested(n: u32) -> (t: u32) {
        for i in n {
          for j in 3 {
            continue when j == 1
            t += 1
          }
          break when i == 2
        }
      }
      export func logged() -> u32 => log
    `)
    expect([skip(6), skip(0), stop(10), stop(2)]).toEqual([9, 0, 3, 2])
    // Each pass runs its defer on its way out: by continue, at the end, by
    // break.
    expect([deferred(5), deferred(0)]).toEqual([1723, 0])
    expect(walkDigits()).toBe(34)
    expect(logged()).toBe(123)
    expect(walkArray()).toBe(36)
    expect([nested(5), nested(1)]).toEqual([6, 2])
  })

  // A walk never compares the pointer with an end address that wraps (#161):
  // it runs its passes from any start and traps at the first element past
  // memory, here one page.
  test('a walk that leaves memory traps at the first element past it', async () => {
    const m = await run(`
      export func count8(s: []u8) -> (n: u32) {
        for x in s { n += 1 }
      }
      export func count32(s: []u32) -> (n: u32) {
        for x in s { n += 1 }
      }
      export func arr(a: u32) -> (t: u32) {
        let p = a as *[4]u32
        for x in p { t += 1 }
      }
      export func huge(a: u32) -> (t: u32) {
        let p = a as *[1073741823]u32
        for x in p {
          t += 1
          break when t == 100000
        }
      }
      export func assigned(s: []u8) -> (n: u32) {
        for i, x in s {
          n += 1
          i = 0
        }
      }
    `)
    const end = 65536
    // A slice that ends at 2^32, and one whose len * 4 is past it.
    expect(() => m.count8(0xfffffff0 | 0, 32)).toThrow('Out of bounds')
    expect(() => m.count32(64, 0x40000001)).toThrow('Out of bounds')
    // A *[4]u32 whose end wraps, and one of 2^30 - 1 elements at 4096,
    // whose end address 4096 + 4 * (2^30 - 1) wraps to 4092, below it.
    expect(() => m.arr(0xfffffff8 | 0)).toThrow('Out of bounds')
    expect(() => m.huge(4096)).toThrow('Out of bounds')
    // A loop that assigns its index walks the elements as before.
    expect(() => m.assigned(0xfffffff0 | 0, 32)).toThrow('Out of bounds')
    expect(m.assigned(8, 3)).toBe(3)
    // Up to the end of memory, and one element past it.
    expect([m.count8(end - 6, 6), m.count32(end - 16, 4), m.arr(end - 16)]).toEqual([6, 4, 4])
    expect(() => m.count8(end - 6, 7)).toThrow('Out of bounds')
    expect(() => m.count32(end - 16, 5)).toThrow('Out of bounds')
    expect(() => m.arr(end - 12)).toThrow('Out of bounds')
  })
})

describe('structs in memory', () => {
  test('a struct is stored one field at a time, at its offset, through one address', () => {
    const body = bodyOf(`${SPOT}
      func store(list: [*]mut Spot, k: u32, a: i32) { list[k] = Spot(a, 1, 2) }
    `, 'store')
    expect(body).toEqual([
      '(i32.store (local.tee $__tmp_0 (i32.add (local.get $list) (i32.mul (local.get $k) (i32.const 12)))) (local.get $a))',
      '(i32.store offset=4 (local.get $__tmp_0) (i32.const 1))',
      '(i32.store offset=8 (local.get $__tmp_0) (i32.const 2))',
    ])
  })

  test('a struct is loaded one field at a time, from one address', () => {
    const body = bodyOf(`${SPOT}
      func load(list: [*]Spot, k: u32) -> i32 {
        let s = list[k]
        return s.room
      }
    `, 'load')
    expect(body.slice(0, 3)).toEqual([
      '(local.set $s_c (i32.load (local.tee $__tmp_0 (i32.add (local.get $list) (i32.mul (local.get $k) (i32.const 12))))))',
      '(local.set $s_di (i32.load offset=4 (local.get $__tmp_0)))',
      '(local.set $s_room (i32.load offset=8 (local.get $__tmp_0)))',
    ])
  })

  test('an address in a local needs no scratch local', () => {
    const wat = modWat(`${SPOT}
      func copy(p: *mut Spot, q: *Spot) { p.* = q.* }
    `)
    expect(wat).toContain('(local.get $p) (i32.load (local.get $q))\n    (local.get $p) (i32.load offset=4 (local.get $q))\n    (local.get $p) (i32.load offset=8 (local.get $q))')
    expect(wat).not.toContain('$__tmp')
  })

  test('fields narrower than a word load and store at their width', () => {
    const wat = modWat(`
      type Mixed = (a: u8, b: i16, c: u64, d: f32)
      func get(p: *Mixed) -> Mixed => p.*
      func put(p: *mut Mixed, m: Mixed) { p.* = m }
    `)
    expect(wat).toContain('(i32.load8_u (local.get $p)) (i32.load16_s offset=1 (local.get $p)) (i64.load offset=3 (local.get $p)) (f32.load offset=11 (local.get $p))')
    expect(wat).toContain('(i32.store8 (local.get $p) (local.get $m_a))')
    expect(wat).toContain('(i32.store16 offset=1 (local.get $p) (local.get $m_b))')
    expect(wat).toContain('(i64.store offset=3 (local.get $p) (local.get $m_c))')
    expect(wat).toContain('(f32.store offset=11 (local.get $p) (local.get $m_d))')
  })

  test('a field through a pointer is read and written at its offset', () => {
    const body = bodyOf(`${SPOT}
      func turn(p: *mut Spot) -> i32 {
        p.c = 5
        p.di += 2
        return p.room
      }
    `, 'turn')
    expect(body.slice(0, 3)).toEqual([
      '(i32.store (local.get $p) (i32.const 5))',
      '(i32.store (i32.add (local.get $p) (i32.const 4)) (i32.add (i32.load (i32.add (local.get $p) (i32.const 4))) (i32.const 2)))',
      '(i32.load (i32.add (local.get $p) (i32.const 8))) (return)',
    ])
  })

  test('fields of fields add up to one offset', () => {
    const wat = modWat(`${SPOT}
      func put(opts: [*]mut Option, i: u32) { opts[i].lane.free = 1 }
      func len(opts: [*]Option, i: u32) -> u32 => opts[i].lane.cells.len
      func lane(p: *Option) -> Lane => p.lane
    `)
    expect(wat).toContain('(i32.store (i32.add (i32.add (local.get $opts) (i32.mul (local.get $i) (i32.const 16))) (i32.const 12)) (i32.const 1))')
    expect(wat).toContain('(i32.load offset=4 (i32.add (i32.add (local.get $opts) (i32.mul (local.get $i) (i32.const 16))) (i32.const 4)))')
    expect(wat).toContain('(i32.load (local.tee $__tmp_0 (i32.add (local.get $p) (i32.const 4)))) (i32.load offset=4 (local.get $__tmp_0)) (i32.load offset=8 (local.get $__tmp_0))')
  })

  test("a call's result is stored from scratch locals", () => {
    const body = bodyOf(`${SPOT}
      func put(list: [*]mut Spot, lists: [*]mut []i32, k: u32) {
        list[k] = make(1)
        lists[k] = pair()
      }
    `, 'put')
    expect(body).toEqual([
      '(local.tee $__tmp_0 (i32.add (local.get $list) (i32.mul (local.get $k) (i32.const 12))))',
      '(call $make (i32.const 1))',
      '(local.set $__tmp_2)',
      '(local.set $__tmp_1)',
      '(i32.store)',
      '(i32.store offset=4 (local.get $__tmp_0) (local.get $__tmp_1))',
      '(i32.store offset=8 (local.get $__tmp_0) (local.get $__tmp_2))',
      '(i32.add (local.get $lists) (i32.mul (local.get $k) (i32.const 8)))',
      '(call $pair)',
      '(local.set $__tmp_3)',
      '(i32.store)',
      '(i32.store offset=4 (i32.add (local.get $lists) (i32.mul (local.get $k) (i32.const 8))) (local.get $__tmp_3))',
    ])
  })

  test('a value that reads memory is read whole before any of it is written', () => {
    const body = bodyOf(`
      func swap(p: *mut (i32, i32)) { p.* = (p.1, p.0) }
    `, 'swap')
    expect(body).toEqual([
      '(local.get $p) (i32.load (i32.add (local.get $p) (i32.const 4)))',
      '(local.get $p) (i32.load (local.get $p))',
      '(i32.store offset=4)',
      '(i32.store)',
    ])
  })

  test('a copy reads every field before it stores any', () => {
    const body = bodyOf(`${SPOT}
      func copy(a: [*]mut Spot, i: u32, j: u32) { a[i] = a[j] }
    `, 'copy')
    expect(body).toEqual([
      '(local.tee $__tmp_1 (i32.add (local.get $a) (i32.mul (local.get $i) (i32.const 12)))) (i32.load (local.tee $__tmp_0 (i32.add (local.get $a) (i32.mul (local.get $j) (i32.const 12)))))',
      '(local.get $__tmp_1) (i32.load offset=4 (local.get $__tmp_0))',
      '(local.get $__tmp_1) (i32.load offset=8 (local.get $__tmp_0))',
      '(i32.store offset=8)',
      '(i32.store offset=4)',
      '(i32.store)',
    ])
  })

  test('the address is the one the target named before the value was computed', async () => {
    // A value that assigns on its way (an if with statements) can move the
    // pointer the target names: every part still goes where it pointed.
    const { whole, field, slice, index } = await run(`
      type Point = (x: i32, y: i32)
      type P3 = (x: i32, y: i32, z: i32)
      data cells: *mut [2]Point = mut [Point(0, 0), Point(0, 0)]
      data threes: *mut [2]P3 = mut [P3(0, 0, 0), P3(0, 0, 0)]
      data names: *mut [2][]u8 = mut ["", ""]
      data three: *[1]i32 = [3]
      export func whole(c: bool) -> i32 {
        let p: *mut Point = &cells[0]
        let q: *mut Point = &cells[1]
        p.* = if c {
          p = q
          Point(1, 2)
        } else { Point(3, 4) }
        return cells[0].x * 1000 + cells[0].y * 100 + cells[1].x * 10 + cells[1].y
      }
      export func field(c: bool) -> i32 {
        let p: *mut P3 = &threes[0]
        let q: *mut P3 = &threes[1]
        p.* = P3(if c {
          p = q
          1
        } else { 4 }, 2, three[0])
        return threes[0].x * 100 + threes[0].y * 10 + threes[0].z + threes[1].x + threes[1].y + threes[1].z
      }
      export func slice(c: bool) -> u32 {
        let p: *mut []u8 = &names[0]
        let q: *mut []u8 = &names[1]
        p.* = if c {
          p = q
          "abc"
        } else { "de" }
        return names[0].len * 10 + names[1].len
      }
      export func index(c: bool) -> u32 {
        let i: u32#2 = 0
        names[i] = if c {
          i = 1
          "abcd"
        } else { "de" }
        return names[0].len * 10 + names[1].len
      }
    `)
    expect([whole(1), field(1), slice(1), index(1)]).toEqual([1200, 123, 30, 40])
  })

  test('a later part that writes memory runs before any part is stored', async () => {
    // The value is computed whole first: what a part of it stores on its way
    // is overwritten by the assignment, not the other way round.
    const { struct, three, slice, array, fill } = await run(`
      type Point = (x: i32, y: i32)
      type P3 = (x: i32, y: i32, z: i32)
      data cells: *mut [1]Point = mut [Point(0, 0)]
      data threes: *mut [1]P3 = mut [P3(0, 0, 0)]
      data names: *mut [1][]u8 = mut [""]
      data pairs: *mut [1][2]i32 = mut [[0, 0]]
      data bytes: *[3]u8 = "abc"
      export func struct(c: bool) -> i32 {
        let p: *mut Point = &cells[0]
        p.* = Point(1, if c {
          p.x = 9
          2
        } else { 2 })
        return p.x * 10 + p.y
      }
      export func three(c: bool) -> i32 {
        let p: *mut P3 = &threes[0]
        p.* = P3(1, 2, if c {
          p.x = 8
          p.y = 9
          3
        } else { 3 })
        return p.x * 100 + p.y * 10 + p.z
      }
      export func slice(c: bool) -> u32 {
        let p: *mut []u8 = &names[0]
        p.* = (bytes as [*]u8, if c {
          p.* = "zzzzzzz"
          3
        } else { 3 })
        return p.len * 10 + (if p.ptr as u32 == bytes as u32 { 1 } else { 0 })
      }
      export func array(c: bool) -> i32 {
        let p: *mut [2]i32 = pairs[0]
        p.* = [1, if c {
          p.*[0] = 9
          2
        } else { 2 }]
        return p.*[0] * 10 + p.*[1]
      }
      export func fill(c: bool) -> i32 {
        let p: *mut Point = &cells[0]
        p.* = Point(1, if c {
          memset(cells, 7, 4)
          2
        } else { 2 })
        return p.x * 10 + p.y
      }
    `)
    expect([struct(1), three(1), slice(1), array(1), fill(1)]).toEqual([12, 123, 31, 12, 12])
  })

  test('a copy over a place that overlaps its source arrives whole', async () => {
    const { spots, slices } = await run(`${SPOT}
      export func spots() -> i32 {
        let list = space as [*]mut Spot
        list[0] = Spot(1, 2, 3)
        list[1] = Spot(4, 5, 6)
        // q starts one field into list[0]: the copy must not read what it wrote.
        let q = ((space as u32) + 4) as *mut Spot
        q.* = list[0]
        return list[0].c + list[0].di * 10 + list[0].room * 100 + list[1].c * 1000 + list[1].di * 10000
      }
      export func slices() -> u32 {
        let w = ((space as u32) + 64) as [*]mut u32
        w[0] = 1
        w[1] = 2
        w[2] = 3
        let a = ((space as u32) + 64) as *mut []u8
        let b = ((space as u32) + 68) as *mut []u8
        b.* = a.*
        return w[0] + w[1] * 10 + w[2] * 100
      }
    `)
    expect(spots()).toBe(1 + 10 + 200 + 3000 + 50000)
    expect(slices()).toBe(1 + 10 + 200)
  })

  test('an address with effects is evaluated once', () => {
    const code = (stmt: string) => `${SPOT}
      func f(list: [*]mut Spot, lists: [*]mut []i32, xs: [*]mut u64, ws: [*]mut u128) {
        ${stmt}
      }
    `
    for (const stmt of [
      'list[next()] = Spot(1, 2, 3)',
      'list[next()] = make(1)',
      'let s = list[next()]',
      'list[next()].di += 1',
      'lists[next()] = pair()',
      'lists[next()] = lists[0]',
      'let s = lists[next()]',
      'let n = lists[next()].len',
      'xs[next()] += 1',
      'ws[next()] = ws[0]',
      'let w = ws[next()]',
    ]) {
      expect(`${stmt}: ${bodyOf(code(stmt), 'f').join('\n').match(/call \$next/g)?.length}`).toBe(`${stmt}: 1`)
    }
  })

  test('an address that reads memory is evaluated once, before its own stores', async () => {
    const code = `${SPOT}
      export func slot() -> u32 {
        let m = space as [*]mut []u8
        let w = space as [*]mut u32
        // m[0].ptr is 0, so the target is m[0]: storing its pointer must not
        // move where its length goes.
        m[(m[0].ptr as u32)] = ((space as [*]u8), 9:u32)
        return w[1]
      }
      export func limb() -> u64 {
        let ws = ((space as u32) + 64) as [*]mut u128
        let w = ((space as u32) + 64) as [*]mut u64
        let v: u128 = 3
        ws[(w[0] as u32)] = (v << 64) | v
        return w[0] + w[1] * 10
      }
    `
    const wat = modWat(code)
    expect(wat).toContain('(i32.store (local.tee $__tmp_0 (i32.add (local.get $m) (i32.mul (i32.load (i32.add (local.get $m) (i32.mul (i32.const 0) (i32.const 8)))) (i32.const 8)))) (i32.const 8))\n    (i32.store offset=4 (local.get $__tmp_0) (i32.const 9))')
    const { slot, limb } = await run(code)
    expect(slot()).toBe(9)
    expect(limb()).toBe(33n)
  })

  test('scalar, slice and wide accesses keep their form', () => {
    const wat = modWat(`${SPOT}
      func f(xs: [*]mut i32, lists: [*]mut []i32, ws: [*]mut u128, i: u32, s: []i32, w: u128) -> u32 {
        xs[i] = 5
        xs[i] += 1
        lists[i] = s
        let t = lists[i]
        ws[i] = w
        ws[i + 1] = ws[i]
        return lists[i].len + t.len
      }
    `)
    const lists = '(i32.add (local.get $lists) (i32.mul (local.get $i) (i32.const 8)))'
    const xs = '(i32.add (local.get $xs) (i32.mul (local.get $i) (i32.const 4)))'
    const ws = '(i32.add (local.get $ws) (i32.mul (local.get $i) (i32.const 16)))'
    const after = '(i32.add (local.get $ws) (i32.mul (i32.add (local.get $i) (i32.const 1)) (i32.const 16)))'
    expect(wat).toContain(`(i32.store ${xs} (i32.const 5))`)
    expect(wat).toContain(`(i32.store ${xs} (i32.add (i32.load ${xs}) (i32.const 1)))`)
    expect(wat).toContain(`(i32.store ${lists} (local.get $s_ptr))\n    (i32.store offset=4 ${lists} (local.get $s_len))`)
    expect(wat).toContain(`(local.set $t_ptr (i32.load ${lists}))\n    (local.set $t_len (i32.load offset=4 ${lists}))`)
    expect(wat).toContain(`(i32.add (i32.load offset=4 ${lists}) (local.get $t_len))`)
    // A wide integer is one scalar: limb by limb, in order, also for a copy.
    expect(wat).toContain(`(i64.store offset=0 ${ws} (local.get $w_0))\n    (i64.store offset=8 ${ws} (local.get $w_1))`)
    expect(wat).toContain(`(i64.store offset=0 ${after} (i64.load offset=0 ${ws}))\n    (i64.store offset=8 ${after} (i64.load offset=8 ${ws}))`)
    expect(wat).not.toContain('$__tmp')
  })

  test('a slice copied from memory is read whole before it is stored', () => {
    const body = bodyOf(`${SPOT}
      func f(lists: [*]mut []i32, i: u32) { lists[i + 1] = lists[i] }
    `, 'f')
    const lists = '(i32.add (local.get $lists) (i32.mul (local.get $i) (i32.const 8)))'
    const after = '(i32.add (local.get $lists) (i32.mul (i32.add (local.get $i) (i32.const 1)) (i32.const 8)))'
    expect(body).toEqual([
      `${after} (i32.load ${lists})`,
      `${after} (i32.load offset=4 ${lists})`,
      '(i32.store offset=4)',
      '(i32.store)',
    ])
  })

  test('an element loop loads each struct into its binding', () => {
    const body = bodyOf(`${SPOT}
      func total(list: []Spot) -> i32 {
        let t = 0
        for s in list { t += s.room }
        return t
      }
    `, 'total').join('\n')
    expect(body).toMatch(/\(i32\.load \(local\.get \$__for_ptr_\d+\)\) \(i32\.load offset=4 \(local\.get \$__for_ptr_\d+\)\) \(i32\.load offset=8 \(local\.get \$__for_ptr_\d+\)\)\n\(local\.set \$s_room\)\n\(local\.set \$s_di\)\n\(local\.set \$s_c\)/)
    expect(body).toMatch(/\(local\.set \$__for_ptr_\d+ \(i32\.add \(local\.get \$__for_ptr_\d+\) \(i32\.const 12\)\)\)/)
  })

  test('an element that is a pointer is loaded, a row of a packed array is not', () => {
    const wat = modWat(`${SPOT}
      func room(ps: [*]*Spot, i: u32) -> i32 => ps[i].room
      func cell(m: *[4x8]u8, i: u32#4, j: u32#8) -> u8 => m[i][j]
    `)
    expect(wat).toContain('(i32.load (i32.add (i32.load (i32.add (local.get $ps) (i32.mul (local.get $i) (i32.const 4)))) (i32.const 8)))')
    expect(wat).toContain('(i32.load8_u (i32.add (i32.add (local.get $m) (i32.mul (local.get $i) (i32.const 8))) (local.get $j)))')
  })

  test('whole structs, fields and loops run', async () => {
    const { total, turned, nested, once } = await run(`${SPOT}
      func sum(s: Spot) -> i32 => s.c + s.di * 10 + s.room * 100
      func turn(p: *mut Spot) {
        p.c = 5
        p.di += 2
      }
      export func total() -> i32 {
        let list = space as [*]mut Spot
        list[0] = Spot(1, 2, 3)
        list[1] = make(4)
        list[2] = list[0]
        list[2] = Spot(list[2].room, list[2].c, list[2].di)
        let all: []Spot = (list, 3:u32)
        let t = 0
        for s in all { t += sum(s) }
        return t + sum(list[1])
      }
      export func turned() -> i32 {
        let list = space as [*]mut Spot
        list[1] = Spot(1, 40, 3)
        turn(((space as u32) + sizeof(Spot)) as *mut Spot)
        let s = list[1]
        return sum(s)
      }
      export func nested() -> i32 {
        let w = ((space as u32) + 128) as [*]mut i32
        w[0] = 3
        w[1] = 4
        let opts = ((space as u32) + 64) as [*]mut Option
        opts[1] = Option(7, Lane(w[0..2], 9))
        opts[1].lane.free += 1
        opts[2].lane = opts[1].lane
        opts[2].lane.cells = pair()
        let t = opts[1].d + opts[2].lane.free + (opts[2].lane.cells.len as i32)
        for x in opts[1].lane.cells { t += x }
        return t
      }
      export func once() -> u32 {
        let list = space as [*]mut Spot
        list[next()] = Spot(1, 2, 3)
        let s = list[next() - 1]
        list[next() - 2].c += (s.room as i32)
        return calls * 10 + (list[1].c as u32)
      }
    `)
    expect(total()).toBe(321 + 654 + 213 + 654)
    expect(turned()).toBe(5 + 420 + 300)
    expect(nested()).toBe(7 + 10 + 2 + 3 + 4)
    expect(once()).toBe(34)
  })

  test('an element is destructured into existing variables', async () => {
    const { f } = await run(`${SPOT}
      export func f() -> i32 {
        let list = space as [*]mut Spot
        list[1] = Spot(1, 2, 3)
        let (c, di, room) = list[1]
        list[2] = Spot(4, 5, 6)
        set (c, di, room) = list[2]
        let p = ((space as u32) + 12) as *Spot
        set (room:, c:) = p.*
        return c + di * 10 + room * 100
      }
    `)
    expect(f()).toBe(351)
  })

  test("a wide array literal's slots are not taken for values", async () => {
    // The literal stores its runtime element through a helper call and then
    // gives its address: with the slice after it, as many parts as T has values.
    const { f } = await run(`${SPOT}
      type T = (p: *[1]u128, s: []i32)
      func wide() -> u128 => 5
      export func f() -> u32 {
        let t: T = T([wide()], pair())
        let ts = ((space as u32) + 64) as [*]mut T
        ts[1] = T([wide()], pair())
        return t.s.len + (t.p[0] as u32) * 10 + ts[1].s.len * 100 + (ts[1].p[0] as u32) * 1000
      }
    `)
    expect(f()).toBe(5252)
  })

  test('a bounds-checked struct element is one value, however many parts it has', async () => {
    // The ?? form sets scratch locals before its `if`; with six fields it has
    // as many top-level parts as the struct has values.
    const { get } = await run(`
      data space = mut [0:u8; 256]
      type Six = (a: i32, b: i32, c: i32, d: i32, e: i32, f: i32)
      export func get(i: u32) -> i32 {
        let xs = space as *mut [2]Six
        xs[1] = Six(1, 2, 3, 4, 5, 6)
        let s: []Six = xs
        let q = s[i] ?? Six(9, 9, 9, 9, 9, 9)
        xs[0] = s[i] ?? Six(7, 7, 7, 7, 7, 7)
        return q.a + q.f + xs[0].e
      }
    `)
    expect(get(1)).toBe(12)
    expect(get(7)).toBe(25)
  })
})

describe('struct values in registers and on the stack', () => {
  const RECT = `
    type Point = (x: i32, y: i32)
    type Rect = (origin: Point, size: Point)
    func rect() -> Rect => Rect(Point(1, 2), Point(3, 4))
  `

  test("a field of a call's result drops the other values", () => {
    const wat = modWat(`${RECT}
      func first() -> i32 => rect().origin.x
      func third() -> i32 => rect().size.x
      func size() -> Point => rect().size
    `)
    expect(wat).toContain('(block (result i32) (call $rect) (drop) (drop) (drop))')
    expect(wat).toContain('(block (result i32) (call $rect) (drop) (local.set $__tmp_0) (drop) (drop) (local.get $__tmp_0))')
    expect(wat).toContain('(block (result i32 i32) (call $rect) (local.set $__tmp_1) (local.set $__tmp_0) (drop) (drop) (local.get $__tmp_0) (local.get $__tmp_1))')
  })

  test('a field of a struct written out in place is just that part', () => {
    const wat = modWat(`${RECT}
      func f(a: i32, b: i32) -> i32 => Rect(Point(a, b), Point(b, a)).size.x
    `)
    expect(bodyOf(`${RECT}
      func f(a: i32, b: i32) -> i32 => Rect(Point(a, b), Point(b, a)).size.x
    `, 'f')).toEqual(['(local.get $b)'])
    expect(wat).not.toContain('$__tmp')
  })

  test('a part that is left out still runs if it could trap', async () => {
    const code = `${RECT}
      type Wide = (a: i64, b: i32)
      data space = mut [0:u8; 16]
      export func div(n: i32) -> i32 => Point(7, 1 / n).x
      export func rem(n: i32) -> i32 => (5 % n, 7).1
      export func wide(n: i32) -> i32 => Wide(1:i64 / (n as i64), 7).b
      export func convert(x: f64) -> i32 => Point(7, x as i32).x
      export func load(p: *i32) -> i32 => Rect(Point(7, 8), Point(p.*, 9)).origin.x
      export func bound(n: i32) -> i32 {
        let x = (7, 1 / n).0
        return x
      }
      export func ptr(n: u32) -> u32 => ((space as [*]u8, 1 / n):[]u8).ptr as u32 - space as u32
      export func len(n: u32) -> u32 => (((1 / n) as [*]u8, 3):[]u8).len
      export func index(n: u32) -> u32 => (((space as [*]u8, 1 / n):[]u8)[0] ?? 0) as u32
      export func address(n: u32) -> u32 {
        if let p = &((space as [*]u8, 1 / n):[]u8)[0] { return p.* as u32 }
        return 9
      }
    `
    const m = await run(code)
    expect([m.div(1), m.rem(1), m.wide(1), m.convert(1.5), m.load(8), m.bound(1)]).toEqual([7, 7, 7, 7, 7, 7])
    expect([m.ptr(1), m.len(1), m.index(1), m.address(1)]).toEqual([0, 3, 0, 0])
    // Division by zero, a float no i32 holds, a load from outside memory.
    for (const name of ['div', 'rem', 'wide', 'bound', 'ptr', 'len', 'index', 'address']) expect(() => m[name](0)).toThrow()
    expect(() => m.convert(1e30)).toThrow()
    expect(() => m.load(-4)).toThrow()
    // A part that can't trap and has no effects is still just left out.
    expect(bodyOf(`${RECT}
      func f(a: i32, b: i64) -> i32 => Rect(Point(a, a + 1), Point(a * 2, (b >> 1) as i32)).origin.x
    `, 'f')).toEqual(['(local.get $a)'])
  })

  test('a slice on the stack keeps its own form', () => {
    const wat = modWat(`
      data space = mut [0:u8; 16]
      func pair() -> []i32 => ((space as [*]i32), 2:u32)
      func len() -> u32 => pair().len
      func second() -> i32 => pair().ptr[1]
    `)
    expect(wat).toMatch(/\(block \(result i32\) \(call \$pair\) \(local\.set \$__len_\d+\) \(drop\) \(local\.get \$__len_\d+\)\)/)
    expect(wat).toContain('(i32.load (i32.add (block (result i32) (call $pair) (drop)) (i32.mul (i32.const 1) (i32.const 4))))')
  })

  test('a field of a field is assigned in its own register', () => {
    const body = bodyOf(`${RECT}
      func f(r: Rect) -> i32 {
        r.origin.x = 7
        r.origin.y += 1
        r.size = Point(8, 9)
        return r.origin.x
      }
    `, 'f')
    expect(body.slice(0, 4)).toEqual([
      '(local.set $r_origin_x (i32.const 7))',
      '(local.set $r_origin_y (i32.add (local.get $r_origin_y) (i32.const 1)))',
      '(local.set $r_size_x (i32.const 8))',
      '(local.set $r_size_y (i32.const 9))',
    ])
  })

  test('a struct rebuilt from its own fields is read before it is set', () => {
    const body = bodyOf(`${RECT}
      func f(p: Point, q: Point) -> Point {
        p = Point(p.y, p.x)
        q = Point(q.x, p.y)
        return p
      }
    `, 'f')
    expect(body.slice(0, 5)).toEqual([
      '(local.get $p_y) (local.get $p_x)',
      '(local.set $p_y)',
      '(local.set $p_x)',
      // Nothing q reads is set before it is read: part by part, as before.
      '(local.set $q_x (local.get $q_x))',
      '(local.set $q_y (local.get $p_y))',
    ])
  })

  test('fields of values on the stack run', async () => {
    const { f } = await run(`${RECT}
      type Lists = (tight: []i32, chain: []i32)
      data space = mut [0:u8; 16]
      func lists() -> Lists {
        let w = space as [*]mut i32
        w[1] = 42
        return Lists((w, 1:u32), (w, 2:u32))
      }
      export func f() -> i32 {
        let r = rect()
        r.origin = Point(r.origin.y, r.origin.x)
        r.size.y += 10
        return (lists().chain.len as i32) + lists().chain.ptr[1] + rect().size.x * 100 + r.origin.x * 1000 + r.size.y * 10000
      }
    `)
    expect(f()).toBe(2 + 42 + 300 + 2000 + 140000)
  })
})

describe('what the editor is told adds no memory', () => {
  // The checker records the type of each name a for, an if let or a named
  // part of a pattern binds, at the name. A pointer bound only that way is no
  // reason for the module to have a memory: the value it is taken from never
  // was one.
  test('a pointer taken out of a struct by a named part of a pattern', () => {
    const wat = modWat(`export func f(t: (a: *u8, b: u32)) -> u32 {
  let (a:, b:) = t
  return b
}`)
    expect(wat).not.toContain('memory')
  })
})

describe('bools in memory', () => {
  const FLAGS = `
    data space = mut [0:u8; 16]
    type Cell = (open: bool, seen: bool, id: u16)
  `

  test('a bool is loaded and stored as the one byte it takes', () => {
    const wat = modWat(`${FLAGS}
      func get(flags: [*]bool, i: u32) -> bool => flags[i]
      func put(flags: [*]mut bool, i: u32) { flags[i] = true }
      func cell(p: *Cell) -> Cell => p.*
      func mark(p: *mut Cell) { p.seen = true }
    `)
    expect(wat).toContain('(i32.load8_u (i32.add (local.get $flags) (local.get $i)))')
    expect(wat).toContain('(i32.store8 (i32.add (local.get $flags) (local.get $i)) (i32.const 1))')
    expect(wat).toContain('(i32.load8_u (local.get $p)) (i32.load8_u offset=1 (local.get $p)) (i32.load16_u offset=2 (local.get $p))')
    expect(wat).toContain('(i32.store8 (i32.add (local.get $p) (i32.const 1)) (i32.const 1))')
  })

  test('neighbouring bools keep their values', async () => {
    const { f } = await run(`${FLAGS}
      export func f() -> i32 {
        let flags = space as [*]mut bool
        flags[1] = true
        flags[2] = true
        flags[0] = true
        flags[1] = false
        let cells = ((space as u32) + 8) as [*]mut Cell
        cells[0] = Cell(false, true, 513)
        cells[0].open = true
        cells[0].seen = false
        let r = 0
        if flags[0] { r += 1 }
        if flags[1] { r += 10 }
        if flags[2] { r += 100 }
        if cells[0].open { r += 1000 }
        if cells[0].seen { r += 10000 }
        return r + (cells[0].id as i32) * 100000
      }
    `)
    expect(f()).toBe(51301101)
  })
})

// === Globals of Several Values ===

describe('globals of several wasm values', () => {
  const GLOBALS = `
    type Spot = (c: i32, di: i32, room: i32)
    type Lane = (cells: []i32, free: i32)
    global order: []i32 = (0, 0)
    global here: Spot = Spot(1, 2, 3)
    global lane: Lane
    global wide: u128 = 5
    global count: u32 = 7
  `

  test('each value is its own wasm global, with its part of the initializer', () => {
    const wat = modWat(GLOBALS)
    expect(wat).toContain('(global $order_ptr (mut i32) (i32.const 0))\n  (global $order_len (mut i32) (i32.const 0))')
    expect(wat).toContain('(global $here_c (mut i32) (i32.const 1))\n  (global $here_di (mut i32) (i32.const 2))\n  (global $here_room (mut i32) (i32.const 3))')
    expect(wat).toContain('(global $lane_cells_ptr (mut i32) (i32.const 0))\n  (global $lane_cells_len (mut i32) (i32.const 0))\n  (global $lane_free (mut i32) (i32.const 0))')
    expect(wat).toContain('(global $wide_0 (mut i64) (i64.const 5))\n  (global $wide_1 (mut i64) (i64.const 0))')
    // A global of one value is declared as before.
    expect(wat).toContain('(global $count (mut i32) (i32.const 7))')
  })

  test('each part starts as one constant, whatever expression gives it', () => {
    const wat = modWat(`
      type Size = (w: u8, h: f64)
      def page = 64 * 1024
      data table = [1:u8, 2, 3]
      global size: Size = Size(200 + 55, 5:i32)
      global span: (i64, f32) = (4 * page, 1 / 4.0)
      global view: []u8 = (table, 1 + 2)
      global row: [2]i32 = [~0 << 4, page]
      global big: u128 = 1 << 100
      global low: i128 = -(1 << 70) + 4
    `)
    expect(wat).toContain('(global $size_w (mut i32) (i32.const 255))\n  (global $size_h (mut f64) (f64.const 5))')
    expect(wat).toContain('(global $span_0 (mut i64) (i64.const 262144))\n  (global $span_1 (mut f32) (f32.const 0.25))')
    expect(wat).toMatch(/\(global \$view_ptr \(mut i32\) \(i32\.const \d+\)\)\n {2}\(global \$view_len \(mut i32\) \(i32\.const 3\)\)/)
    expect(wat).toContain('(global $row_0 (mut i32) (i32.const -16))\n  (global $row_1 (mut i32) (i32.const 65536))')
    expect(wat).toContain('(global $big_0 (mut i64) (i64.const 0))\n  (global $big_1 (mut i64) (i64.const 68719476736))')
    expect(wat).toContain('(global $low_0 (mut i64) (i64.const 4))\n  (global $low_1 (mut i64) (i64.const -64))')
  })

  test('a cast in a part is a constant: the value the cast gives', () => {
    const wat = modWat(`
      type Size = (w: u8, h: f64)
      def page = 64 * 1024
      data table = mut [1:i32, 2, 3, 4]
      global words: []i32 = (table as [*]i32, 4:u32)
      global bytes: []mut u8 = (table as [*]mut u8, sizeof(i32) as u32)
      global size: Size = Size(300 as u8, page as f64)
      global row: [2]i64 = [-1 as i64, (-1 as u32) as i64]
      global big: u128 = -1 as u128
    `)
    expect(wat).toMatch(/\(global \$words_ptr \(mut i32\) \(i32\.const 8\)\)\n {2}\(global \$words_len \(mut i32\) \(i32\.const 4\)\)/)
    expect(wat).toMatch(/\(global \$bytes_ptr \(mut i32\) \(i32\.const 8\)\)\n {2}\(global \$bytes_len \(mut i32\) \(i32\.const 4\)\)/)
    expect(wat).toContain('(global $size_w (mut i32) (i32.const 44))\n  (global $size_h (mut f64) (f64.const 65536))')
    expect(wat).toContain('(global $row_0 (mut i64) (i64.const -1))\n  (global $row_1 (mut i64) (i64.const 4294967295))')
    expect(wat).toContain('(global $big_0 (mut i64) (i64.const -1))\n  (global $big_1 (mut i64) (i64.const -1))')
  })

  test('a cast of a value that is not constant cannot start a part', () => {
    const errors = (source: string) => {
      const parsed = parse(source)
      return parsed.module ? typecheck(parsed.module as AST.Module).errors.map(e => e.message) : ['parse error']
    }
    const message = 'global initializer must be a compile-time constant'
    expect(errors(`func one() -> i32 => 1\nglobal size: (u8, f64) = (one() as u8, 1.0)`)).toEqual([message])
    // An address cut down isn't known until data is laid out.
    expect(errors(`data table = [1:i32, 2]\nglobal words: []i32 = ((table as u8) as [*]i32, 2)`)).toEqual([message])
  })

  test('a slice global starts as a string or a data array', () => {
    const wat = modWat(`
      data buf = mut [0:u8; 16]
      global message: []u8 = "hello"
      global room: []mut u8 = buf
    `)
    expect(wat).toMatch(/\(global \$message_ptr \(mut i32\) \(i32\.const \d+\)\)\n {2}\(global \$message_len \(mut i32\) \(i32\.const 5\)\)/)
    expect(wat).toMatch(/\(global \$room_ptr \(mut i32\) \(i32\.const \d+\)\)\n {2}\(global \$room_len \(mut i32\) \(i32\.const 16\)\)/)
  })

  test('reads, writes and fields use the parts', () => {
    const body = (stmts: string) => bodyOf(`${GLOBALS}
      func f(s: []i32, p: Spot) -> i32 {
        ${stmts}
        return 0
      }
    `, 'f').slice(0, -2)
    expect(body('order = s')).toEqual(['(global.set $order_ptr (local.get $s_ptr))', '(global.set $order_len (local.get $s_len))'])
    expect(body('let t = order')).toEqual(['(local.set $t_ptr (global.get $order_ptr))', '(local.set $t_len (global.get $order_len))'])
    expect(body('let n = order.len')).toEqual(['(local.set $n (global.get $order_len))'])
    expect(body('here.di += 1')).toEqual(['(global.set $here_di (i32.add (global.get $here_di) (i32.const 1)))'])
    expect(body('lane.cells = s')).toEqual(['(global.set $lane_cells_ptr (local.get $s_ptr))', '(global.set $lane_cells_len (local.get $s_len))'])
    expect(body('let n = lane.cells.len')).toEqual(['(local.set $n (global.get $lane_cells_len))'])
    expect(body('count += 1')).toEqual(['(global.set $count (i32.add (global.get $count) (i32.const 1)))'])
    // A struct rebuilt from its own fields is read before any part is set.
    expect(body('here = Spot(here.room, here.c, here.di)')).toEqual([
      '(global.get $here_room) (global.get $here_c) (global.get $here_di)',
      '(global.set $here_room)',
      '(global.set $here_di)',
      '(global.set $here_c)',
    ])
  })

  test('exports and host imports name each part', () => {
    const wat = modWat(`
      import "env" "limit" global limit: (lo: i32, hi: i32)
      import "env" "base" global base: u32
      export global seen: []i32 = (0, 0)
      export "n" global count: u32 = 0
      func f() -> i32 => limit.hi
    `)
    expect(wat).toContain('(import "env" "limit_lo" (global $limit_lo i32))\n  (import "env" "limit_hi" (global $limit_hi i32))')
    expect(wat).toContain('(import "env" "base" (global $base i32))')
    expect(wat).toContain('(export "seen_ptr" (global $seen_ptr))\n  (export "seen_len" (global $seen_len))')
    expect(wat).toContain('(export "n" (global $count))')
    expect(wat).toContain('(global.get $limit_hi)')
  })

  test('slice and struct globals run', async () => {
    const { f } = await run(`${GLOBALS}
      data buf = mut [0:u8; 64]
      func words() -> []i32 => ((buf as [*]i32), 3:u32)
      export func f() -> i32 {
        order = words()
        order.len -= 1
        let w = buf as [*]mut i32
        w[1] = 40
        lane = Lane(order, 2)
        lane.free += 1
        here = Spot(here.room, here.c, here.di)
        wide += 1
        let t = (order.len as i32) + lane.free + here.c * 10 + here.di * 100 + (wide as i32) * 1000
        for x in lane.cells { t += x }
        return t
      }
    `)
    expect(f()).toBe(2 + 3 + 30 + 100 + 6000 + 40)
  })

  test('globals of constant expressions run', async () => {
    const { f } = await run(`
      type In = (x: i32, y: f32)
      type Out = (tag: u8, pos: In, w: i64, big: u128)
      global o: Out = Out(w: 1 << 33, tag: 1 + 1, pos: In(y: 1, x: 2 * 3), big: 1 << 100)
      global row: [3]f64 = [1 + 1, 5:i32, 0.5]
      export func f() -> f64 => f64(o.tag) * 100.0 + f64(o.pos.x) * 10.0 + o.pos.y + f64(o.w) + f64((o.big >> 98) as u64) + row[0] + row[1] + row[2]
    `)
    expect(f()).toBe(200 + 60 + 1 + 2 ** 33 + 4 + 7.5)
  })
})

describe('tables', () => {
  // The data packer lays *[N][M]T, [][M]T and [*][M]T out as rows apart and a
  // table of their addresses; every read and write goes through that table.
  const TABLES = `
    data grid: *[2][3]i32 = [[7, 1, 2], [3, 4, 5]]
    data rows: [][2]i32 = [[7, 1], [3, 4], [5, 6]]
    data many: [*][2]i32 = [[10, 11], [12, 13]]
    data cube: *[2][2][2]i32 = [[[1, 2], [3, 4]], [[5, 6], [7, 8]]]
  `
  const cells = (f: (i: number, j: number) => unknown, n: number, m: number) =>
    Array.from({ length: n }, (_, i) => Array.from({ length: m }, (_, j) => f(i, j))).flat()

  test('a cell is read through its row pointer, with constant or run-time indexes', async () => {
    const { at, k00, k12, deep, slice, many2 } = await run(`${TABLES}
      export func at(i: u32#2, j: u32#3) -> i32 => grid[i][j]
      export func k00() -> i32 => grid[0][0]
      export func k12() -> i32 => grid[1][2]
      export func deep(i: u32#2, j: u32#2, k: u32#2) -> i32 => cube[i][j][k]
      export func slice(i: u32, j: u32#2) -> i32 => if let r = rows[i] { r[j] } else { -1 }
      export func many2(i: u32, j: u32#2) -> i32 => many[i][j]
    `)
    expect(cells(at, 2, 3)).toEqual([7, 1, 2, 3, 4, 5])
    expect([k00(), k12()]).toEqual([7, 5])
    expect(cells((i, j) => [deep(i, j, 0), deep(i, j, 1)], 2, 2).flat()).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect([slice(0, 0), slice(0, 1), slice(1, 0), slice(2, 1), slice(3, 0)]).toEqual([7, 1, 3, 6, -1])
    expect([many2(0, 1), many2(1, 0)]).toEqual([11, 12])
  })

  test('a row index is checked against N or the slice length, at a stride of 4', async () => {
    const { row, slice } = await run(`${TABLES}
      export func row(i: u32) -> i32 => if let r = grid[i] { r[0] * 10 + r[2] } else { -1 }
      export func slice(i: u32) -> i32 => (rows[i] ?? cube[1][1])[1]
    `)
    expect([row(0), row(1), row(2), row(-1)]).toEqual([72, 35, -1, -1])
    expect([slice(0), slice(2), slice(3)]).toEqual([1, 6, 8])
    expect(modWat(`${TABLES}\nexport func f(i: u32#2) -> u32 => grid[i] as u32`)).toMatch(/\(i32\.mul \(local\.get \$i\) \(i32\.const 4\)\)/)
  })

  test('writes go through the row pointer, and a row can be pointed elsewhere', async () => {
    const { write, repoint, distinct } = await run(`
      data board: *mut [2][3]i32 = mut [[0; 3]; 2]
      data other: *mut [2][3]i32 = mut [[0, 0, 0], [0, 0, 0]]
      data zeros: *[2][3]i32 = [[0, 0, 0], [0, 0, 0]]
      data spare: *mut [3]i32 = mut [40, 41, 42]
      export func write(i: u32#2, j: u32#3, v: i32) -> i32 {
        board[i][j] = v
        board[i][j] += 1
        return board[i][j]
      }
      export func repoint() -> i32 {
        board[1] = spare
        board[1][0] = 50
        return spare[0] * 100 + board[1][2]
      }
      export func distinct() -> i32 {
        other[0][1] = 7
        // Each row of a mutable table is its own, shared with no other data.
        return other[1][1] * 100 + zeros[0][1] * 10 + other[0][1]
      }
    `)
    expect([write(1, 2, 8), write(0, 0, 3), write(1, 0, 0)]).toEqual([9, 4, 1])
    expect(repoint()).toBe(5042)
    expect(distinct()).toBe(7)
  })

  test('rows that are framed or packed are row pointers too, and a *[!]T is checked against its scanned length', async () => {
    const { row, name, cell, lens, wide, framed } = await run(`
      data m: *[2][!]u8 = ["ab", "cde"]
      data names: [][!]u8 = ["alice", "bob"]
      data k: *[2][2x2]i32 = [[[1, 2], [3, 4]], [[5, 6], [7, 8]]]
      data t: *[!][2]i32 = [[7, 1], [3, 4]]
      data z: *[!]i32 = [7, 1, 3]
      data w: *[!]u64 = [7, 1, 3]
      export func row(i: u32, j: u32) -> u32 => if let r = m[i] { (r[j] ?? 0) as u32 + r.len * 1000 } else { 9 }
      export func name(i: u32) -> u32 => if let r = names[i] { r.len } else { 99 }
      export func cell(i: u32#2, j: u32#2, l: u32#2) -> i32 => k[i][j][l]
      export func lens() -> u32 => t.len * 100 + z.len * 10 + w.len
      export func wide(i: u32) -> u64 => w[i] ?? 0
      export func framed(i: u32) -> i32 => if let r = t[i] { r[0] * 10 + r[1] } else { -1 }
    `)
    expect([row(0, 0), row(0, 1), row(0, 2), row(1, 2), row(2, 0)]).toEqual([2097, 2098, 2000, 3101, 9])
    expect([name(0), name(1), name(2)]).toEqual([5, 3, 99])
    expect([cell(0, 0, 0), cell(1, 0, 1), cell(1, 1, 1)]).toEqual([1, 6, 8])
    expect(lens()).toBe(233)
    expect([wide(0), wide(2), wide(3)]).toEqual([7n, 3n, 0n])
    expect([framed(0), framed(1), framed(2)]).toEqual([71, 34, -1])
  })

  test('a *[!]T of structs or slices ends with one whole zero element, which its scan finds', async () => {
    // Each is followed by bytes that aren't zero: a terminator shorter than
    // an element would let the scan run on into them.
    const { pairs, alias, rows, words, local } = await run(`
      type Pr = (a: u16, b: u16)
      type W = u16
      data pr: *[!]Pr = [(a: 1, b: 2), (a: 0, b: 3), (a: 4, b: 0)]
      data after: *[4]u8 = [7, 7, 7, 7]
      data wa: *[!]W = [1, 2]
      data after2: *[4]u8 = [7, 7, 7, 7]
      data rs: *[2][!]Pr = [[(a: 1, b: 1)], [(a: 2, b: 2), (a: 3, b: 0)]]
      data after3: *[4]u8 = [7, 7, 7, 7]
      data ws: *[!][]u8 = ["ab", "f", "cde"]
      data after4: *[4]u8 = [7, 7, 7, 7]
      export func pairs(i: u32) -> u32 => pr.len * 1000 + (if let x = pr[i] { x.a as u32 * 10 + x.b as u32 } else { 99 })
      export func alias() -> u32 => wa.len
      export func rows() -> u32 => (if let r = rs[1] { r.len } else { 9 }) * 10 + (if let r = rs[0] { r.len } else { 9 })
      export func words(i: u32) -> u32 => ws.len * 10 + (if let x = ws[i] { x.len } else { 9 })
      export func local() -> u32 {
        let z: *[!]Pr = [(a: 5, b: 6), (a: 7, b: 8)]
        return z.len
      }
    `)
    expect([pairs(0), pairs(1), pairs(2), pairs(3)]).toEqual([3012, 3003, 3040, 3099])
    expect([alias(), rows(), local()]).toEqual([2, 21, 2])
    expect([words(0), words(1), words(2), words(3)]).toEqual([32, 31, 33, 39])
  })

  test('len of a packed block is its rows, and wid of a slice the width of an element', async () => {
    const { lens, size } = await run(`
      data m: *[2x3]i32 = [[7, 1, 2], [3, 4, 5]]
      data words: []u64 = [1, 2, 3]
      data rows: [][3]i32 = [[1, 2, 3], [4, 5, 6]]
      export func lens() -> u32 => m.len * 1000 + words.wid * 100 + rows.wid * 10 + (if m.len == 2 { 1 } else { 0 })
      export func size(s: []u64) -> u32 => s.len * s.wid
    `)
    expect(lens()).toBe(2841)
    expect(size(0, 5)).toBe(40)
  })

  test('len, wid, sizeof, loops, lets, arguments and ranges', async () => {
    const { lens, loops, pass, addr, range, copy } = await run(`${TABLES}
      data board: *mut [2][3]i32 = mut [[0; 3]; 2]
      data rowsOf: *mut [2][3]i32 = mut [[7, 1, 2], [3, 4, 5]]
      func sum(r: *[3]i32) -> i32 => r[0] + r[1] + r[2]
      func total(s: []i32) -> i32 {
        let t = 0
        for x in s { t += x }
        return t
      }
      export func lens() -> u32 => grid.len * 10000 + grid.wid * 1000 + grid[0].len * 100 + sizeof(*[2][3]i32) * 10 + sizeof([2][3]i32) / 6
      export func loops() -> i32 {
        let t = 0
        for k, r in grid { t += r[2] * (k as i32 + 1) }
        for s in rows { t += s[0] * 100 }
        return t
      }
      export func pass(i: u32#2) -> i32 {
        let r = grid[i]
        return sum(r) * 100 + total(grid[i])
      }
      export func addr(i: u32#2) -> i32 {
        let p = &grid[i]
        return p.*[1]
      }
      export func range() -> i32 {
        let s = grid[1..]
        return (s.len as i32) * 100 + s.ptr[0][2]
      }
      export func copy() -> i32 {
        board[0..2] = rowsOf[0..2]
        return board[1][2] * 10 + board[0][0]
      }
    `)
    expect(lens()).toBe(24344)
    expect(loops()).toBe(2 + 10 + 1500)
    expect([pass(0), pass(1)]).toEqual([1010, 1212])
    expect([addr(0), addr(1)]).toEqual([1, 4])
    expect(range()).toBe(105)
    expect(copy()).toBe(57)
  })
})

describe('filling a range', () => {
  test('a fill of zeros is one memory.fill, whatever the element is held in', async () => {
    const code = `
      type Pt = (x: i32, y: i32)
      data pts: *mut [3]Pt = mut [(x: 1, y: 1); 3]
      data wide = mut [1:u128; 4]
      data names: *mut [2]?[]u8 = mut ["a", "b"]
      export func zero() -> i32 {
        pts[0..3] = Pt(0, 0)
        wide[1..4] = 0
        names[0..2] = 0
        let none = if names[1] == 0 { 1 } else { 0 }
        return pts[2].y + (wide[0] as i32) * 10 + (wide[3] as i32) * 100 + none * 1000
      }
    `
    const wat = modWat(code)
    expect(wat.match(/memory\.fill/g)?.length).toBe(3)
    expect(wat).not.toContain('loop')
    expect((await run(code)).zero()).toBe(1010)
  })

  test('a value that is an element fills, though it is an array of elements too', async () => {
    // A Node points to two Nodes: other is an element of cells and an array
    // of them. It is an element, so every element of the range is other.
    const code = `
      type Node = *[2]Node
      data cells: *mut [2]Node = mut [0; 2]
      data other: *mut [2]Node = mut [0; 2]
      export func fill() -> i32 {
        cells[0..2] = other
        return if cells[0] == other && cells[1] == other { 1 } else { 0 }
      }
    `
    expect(modWat(code)).not.toContain('memory.copy')
    expect((await run(code)).fill()).toBe(1)
  })
})

describe('indexes not known to be in range', () => {
  test('an optional element read at an unproven index is none when the index is out of range', async () => {
    const code = `
      data names: [][]u8 = ["Alice", "Bob", "Charlie"]
      data numbers: *[2]i32 = [7, 8]
      data cells: *mut [2]*i32 = mut [0, 0]
      export func setup() {
        cells[0] = numbers.ptr as *i32
        cells[1] = (numbers.ptr + 4) as *i32
      }
      export func len(i: u32) -> u32 {
        let n = names[i]
        if let s = n { return s.len }
        return 99
      }
      export func cell(i: u32) -> i32 {
        let p = cells[i]
        return if let q = p { q.* } else { -1 }
      }
    `
    const { setup, len, cell } = await run(code)
    setup()
    expect([len(0), len(2), len(3), len(-1), len(1000000)]).toEqual([5, 7, 99, 99, 99])
    expect([cell(0), cell(1), cell(2), cell(-1)]).toEqual([7, 8, -1, -1])
    expect(modWat(code)).toContain('(if (result i32 i32) (i32.lt_u (local.get $i) (i32.const 3))')
  })

  test('an index whose range may pass N is checked at run time', async () => {
    const { cell, byte, row } = await run(`
      data numbers: *[2]i32 = [7, 8]
      data cells: *mut [2]*i32 = mut [0, 0]
      data bytes: *[2]u8 = [5, 6]
      data packed: *[2x2]i32 = [[1, 2], [3, 4]]
      export func cell(j: u32#3) -> i32 {
        cells[0] = numbers.ptr as *i32
        cells[1] = (numbers.ptr + 4) as *i32
        let p = cells[j]
        return if let q = p { q.* } else { -1 }
      }
      export func byte(j: u32#3) -> u32 => (bytes[j] ?? 9) as u32 * 10 + (if let b = bytes[j] { b as u32 } else { 9 })
      export func row(j: u32#3) -> i32 => if let r = packed[j] { r[1] } else { -1 }
    `)
    expect([cell(0), cell(1), cell(2)]).toEqual([7, 8, -1])
    expect([byte(0), byte(1), byte(2)]).toEqual([55, 66, 99])
    expect([row(0), row(1), row(2)]).toEqual([2, 4, -1])
  })

  test('the row of a packed *[NxM]T is checked against N by if let and ??', async () => {
    const { row, cell } = await run(`
      data m: *[2x3]i32 = [[7, 1, 2], [3, 4, 5]]
      data zeros: *[3]i32 = [0, 0, 0]
      export func row(i: u32) -> i32 => if let r = m[i] { r[0] * 10 + r[2] } else { -1 }
      export func cell(i: u32) -> i32 => (m[i] ?? zeros)[1]
    `)
    expect([row(0), row(1), row(2), row(-1)]).toEqual([72, 35, -1, -1])
    expect([cell(0), cell(1), cell(2)]).toEqual([1, 4, 0])
  })

  test('if let and ?? on an element that is an optional itself check the element too', async () => {
    const { setup, bound, fallback } = await run(`
      data one: *[1]i32 = [7]
      data ps: *mut [2]?*i32 = mut [0, 0]
      export func setup() { ps[0] = one.ptr as *i32 }
      export func bound(i: u32) -> i32 => if let p = ps[i] { p.* } else { -1 }
      export func fallback(i: u32) -> i32 => (ps[i] ?? one.ptr as *i32).* - 7
    `)
    setup()
    expect([bound(0), bound(1), bound(2), bound(-1)]).toEqual([7, -1, -1, -1])
    expect([fallback(0), fallback(1), fallback(2)]).toEqual([0, 0, 0])
  })

  test('so do they on an element of an array value of optionals, also a field in memory', async () => {
    const { run: go } = await run(`
      type U = (n: u8)
      type T = (a: [3]?*U, n: u8)
      data us: *[2]U = [(n: 7), (n: 9)]
      data cell = mut [0:u8; 16]
      func f(t: *T) -> u8 => if let x = t.a[1] { x.n } else { t.n }
      func k(t: *T) -> u8 => (t.a[2] ?? (us as *U)).n
      func v(a: [3]?*U) -> u8 => if let x = a[0] { x.n } else { 1 }
      export func run() -> u32 {
        let t = cell as *mut T
        t.* = T([0 as ?*U, (us as u32 + 1) as *U, 0 as ?*U], 5)
        let first = f(t) as u32
        t.a[1] = 0 as ?*U
        return first * 10000 + f(t) as u32 * 1000 + k(t) as u32 * 10 + v(t.a)
      }
    `)
    expect(go()).toBe(95071)
  })
})

describe('literals where a pointer is wanted', () => {
  test('a table literal calls the overload for a table, a flat one the flat one', async () => {
    const { t, f } = await run(`
      func total(m: *[2][3]i32) -> i32 => m[0][0] + m[1][2]
      func total(r: *[3]i32) -> i32 => r[0] + r[1] + r[2]
      export func t() -> i32 => total([[1, 2, 3], [4, 5, 6]])
      export func f() -> i32 => total([1, 2, 3])
    `)
    expect([t(), f()]).toEqual([7, 6])
  })
})

describe('structs in data arrays', () => {
  test('of a type declared further down, through a chain of names, are laid out as that type', async () => {
    const { pair, short, real, repeat } = await run(`
      data pairs: *[2]Pair = [(1, 2), Pair(3, -4)]
      data reals: *[2]Real = [1.5, 2.5]
      type Pair = (first: Byte, second: Short)
      type Byte = u8
      type Short = Small
      type Small = i16
      type Real = Wide
      type Wide = f64
      export func pair() -> i32 => pairs[1].second * 10 + pairs[0].first
      export func short() -> i32 {
        let s: []Short = [5, 6, 7]
        return s[2] ?? 0
      }
      export func real() -> f64 => reals[1]
      export func repeat() -> i32 {
        let r: *[3]Short = [-2:Short; 3]
        return r[2]
      }
    `)
    expect([pair(), short(), real(), repeat()]).toEqual([-39, 7, 2.5, -2])
  })

  test('of a type that refers to itself are laid out as that type, at any depth', async () => {
    const { total, names, inner } = await run(`
      type Dir = (name: []u8, subs: []Dir, size: Size)
      type Size = u32
      func List(comptime T: type) -> type => (items: []List(T), v: T)
      data root: *[1]Dir = [(name: "root", subs: [(name: "bin", subs: [], size: 3), (name: "etc", subs: [(name: "x", subs: [], size: 1)], size: 2)], size: 9)]
      data lists: *[1]List(i16) = [(items: [(items: [], v: -7)], v: 5)]
      func sizes(d: Dir) -> u32 {
        let t: u32 = d.size
        for s in d.subs { t += sizes(s) }
        return t
      }
      func letters(d: Dir) -> u32 {
        let t: u32 = d.name.len
        for s in d.subs { t += letters(s) }
        return t
      }
      export func total() -> u32 => sizes(root[0])
      export func names() -> u32 => letters(root[0])
      export func inner() -> i32 => if let i = lists[0].items[0] { i.v } else { 0 }
    `)
    expect([total(), names(), inner()]).toEqual([15, 11, -7])
  })

  test('constant tuples and constructors are laid out in the data section', () => {
    const wat = modWat(`
      type Point = (x: i32, y: i32)
      data pairs = [(1, 2), (3, 4)]
      data points: *[2]Point = [Point(x: 5, y: 6), Point(y: 8, x: 7)]
      data mixed = [(1:u8, 2:i16, 3:u64)]
    `)
    // A segment stops at its last byte that isn't zero: memory starts as zeros.
    expect(wat).toContain('"\\01\\00\\00\\00\\02\\00\\00\\00\\03\\00\\00\\00\\04"')
    // A constructor can name its fields in any order.
    expect(wat).toContain('"\\05\\00\\00\\00\\06\\00\\00\\00\\07\\00\\00\\00\\08"')
    expect(wat).toContain('"\\01\\02\\00\\03"')
  })

  test('an address given for a pointer is laid out as that address', async () => {
    const { next, bytes, maybe, cell, count } = await run(`
      type Link = (value: i32, next: *Link, bytes: [*]u8, maybe: ?*i32)
      data links: *[2]Link = [(1, 64, 72, 0), Link(2, 80, 88, 96)]
      data cells: []*i32 = [16, 24]
      data same: *[3]*i32 = [32; 3]
      export func next() -> u32 => links[1].next as u32
      export func bytes() -> u32 => links[0].bytes as u32
      export func maybe() -> u32 => if let p = links[1].maybe { p as u32 } else { 0 }
      export func cell() -> u32 => (cells.ptr.u32[1]) + (same[2] as u32)
      export func count() -> u32 => cells.len
    `)
    expect([next(), bytes(), maybe(), cell(), count()]).toEqual([80, 72, 96, 56, 2])
  })

  test('a tuple gives its fields by name where it names them, by position where not, in data as in a variable', async () => {
    const { f } = await run(`
      type Point = (x: i32, y: i32)
      data points: *[2]Point = [(y: 8, x: 7), (8, 7)]
      export func f(a: i32) -> i32 {
        let p: Point = (y: 8, x: 7)
        let local: *[1]Point = [(y: a, x: 7)]
        return p.x + points[0].x * 10 + local[0].x * 100 + points[1].x * 1000
      }
    `)
    expect(f(8)).toBe(8777)
  })

  test('(x) is x: a literal in parentheses is laid out as the literal', async () => {
    const { elems, fields, whole, nested } = await run(`
      type Point = (x: i32, y: i32)
      type Row = (s: []i32, name: []u8, at: Point, tag: u8)
      data points: *[2]Point = [(Point(1, 2)), ((3, 4))]
      data rows: *[1]Row = [(Row(([4, 5, 6]), ("ab"), ((7, 8)), (9)))]
      data xs: []i32 = ([4, 5, 6])
      data k: i32 = (5)
      data names: [][]u8 = [("ab"), ("cde")]
      export func elems() -> i32 => points[0].x * 1000 + points[0].y * 100 + points[1].x * 10 + points[1].y
      export func fields() -> u32 {
        let r = rows[0]
        return r.s.len * 10000 + (r.s.ptr[1] as u32) * 1000 + r.name.len * 100 + (r.at.y as u32) * 10 + (r.tag as u32)
      }
      export func whole() -> u32 => xs.len * 100 + (xs.ptr[2] as u32) * 10 + (k.* as u32)
      export func nested() -> u32 => names.len * 100 + names.ptr[0].len * 10 + names.ptr[1].len
    `)
    expect([elems(), fields(), whole(), nested()]).toEqual([1234, 35289, 365, 223])
  })

  test('slice and fixed-array fields', async () => {
    const code = `
      type Named = (name: []u8, at: (x: i8, y: i8), dims: [3]u16, last: u8)
      data people: *[2]Named = [("ab", (1, -2), [3:u16, 4, 5], 6), Named("cde", (7, 8), [9:u16, 10, 11], 12)]
      export func f(i: u32#2) -> u32 {
        let p = people[i]
        return p.name.len + (p.name.ptr[1] as u32) * 10 + (p.dims[2] as u32) * 10000 + (p.last as u32) * 1000000
      }
      export func y() -> i32 => people[0].at.y as i32
    `
    const { f, y } = await run(code)
    expect(f(0)).toBe(2 + 980 + 50000 + 6000000)
    expect(f(1)).toBe(3 + 1000 + 110000 + 12000000)
    expect(y()).toBe(-2)
    // The names lie apart from the array, which holds their (ptr, len).
    expect(modWat(code)).toContain('"ab"')
  })

  test('pointer fields given as literals', async () => {
    const { f } = await run(`
      type Entry = (key: *[!]u8, raw: [*]u8, fixed: *[3]u8, code: u8)
      data entries: *[2]Entry = [("ab", "cd", "efg", 1), Entry("hij", "kl", [1:u8, 2, 3], 2)]
      export func f(i: u32#2) -> u32 {
        let e = entries[i]
        let key = e.key as [*]u8
        let n: u32 = 0
        while key[n] != 0 { n += 1 }
        return n + (e.raw[1] as u32) * 10 + (e.fixed[2] as u32) * 10000 + (e.code as u32) * 10000000
      }
    `)
    expect(f(0)).toBe(2 + 1000 + 1030000 + 10000000)
    expect(f(1)).toBe(3 + 1080 + 30000 + 20000000)
  })

  test('only a struct with a runtime field is stored when its literal is reached', async () => {
    const code = `
      type Point = (x: i32, y: i32)
      export func corner(a: i32) -> i32 {
        let local: *[3]Point = [(x: 1, y: 2), (x: a, y: 4), Point(5, 6)]
        return local[1].x + local[1].y * 10 + local[0].y * 100 + local[2].x * 1000
      }
    `
    expect(modWat(code).match(/i32\.store/g)?.length).toBe(2)
    const { corner } = await run(code)
    expect(corner(7)).toBe(5247)
  })

  test('a slice given as (ptr, len) is laid out as that pointer and length', async () => {
    // A pair of constants is data, like any tuple of constants: it read back
    // as (0, 0), in a struct and as an element of an array of slices.
    const { field, local, slices, mixed } = await run(`
      type Row = (s: []i32, tag: u8)
      type Outer = (row: Row, name: ?[]u8)
      data rows: *[2]Row = [((64, 3), 7), Row((0, 4), 8)]
      data outer: Outer = (((128, 5), 6), ("abc", 2))
      data lists: [][]i32 = [(64, 3), [1, 2], ((128, 4))]
      export func field() -> u32 {
        let name = outer.name ?? "?"
        let both = (rows[0].s.ptr as u32) * 100000 + rows[0].s.len * 10000 + rows[1].s.len * 1000 + (rows[1].tag as u32) * 100
        return both + outer.row.s.len * 10 + name.len
      }
      export func local() -> u32 {
        let two: []Row = [((64, 3), 7), Row((0, 4), 8)]
        return two.ptr[0].s.len * 1000 + (two.ptr[0].tag as u32) * 100 + two.ptr[1].s.len * 10 + (two.ptr[1].tag as u32)
      }
      export func slices() -> u32 => (lists.ptr[0].ptr as u32) * 1000 + lists.ptr[0].len * 100 + lists.ptr[1].len * 10 + lists.ptr[2].len
      export func mixed(p: [*]i32, n: u32) -> u32 {
        let three: [][]i32 = [(p, n), (64, 2), [7, 8, 9]]
        return three.ptr[0].len * 100 + three.ptr[1].len * 10 + three.ptr[2].len
      }
    `)
    expect([field(), local(), slices(), mixed(0, 5)]).toEqual([6434852, 3748, 64324, 523])
  })

  test('a repeat literal of a runtime value is stored when it is reached', async () => {
    // [v; N] is data only when v is: these read back zeros.
    const code = `
      type Row = (v: [3]i32, tag: i32)
      type Named = (s: []i32, tag: i32)
      global calls: i32 = 0
      func next() -> i32 {
        calls += 1
        return calls
      }
      func sum(s: []i32) -> i32 => s.ptr[0] * 100 + s.ptr[1] * 10 + s.ptr[2]
      func read(r: Row) -> i32 => r.v[0] * 1000 + r.v[1] * 100 + r.v[2] * 10 + r.tag
      export func field(n: i32) -> i32 {
        let rows: *[1]Row = [Row([n + 1; 3], 7)]
        return read(rows[0])
      }
      export func mutable(n: i32) -> i32 {
        let rows: *mut [1]Row = mut [Row([n; 3], 7)]
        return read(rows[0])
      }
      export func slice(n: i32) -> i32 {
        let rows: []Named = [(([n; 3]), 7)]
        return sum(rows.ptr[0].s) * 10 + rows.ptr[0].tag
      }
      export func whole(n: i32) -> i32 {
        let xs: *[3]i32 = [n + 1; 3]
        let last = xs[2]
        let rows: *[2]Row = [Row([n; 3], n); 2]
        let both = rows[1].v[2] * 100 + rows[1].tag * 10 + rows[0].tag
        return sum([n; 3]) * 10000 + last * 1000 + both
      }
      export func each() -> i32 {
        // The value is computed for every slot, as in a repeat that is a value.
        let rows: *[1]Row = [Row([next(); 3], 0)]
        let value: [3]i32 = [next(); 3]
        return read(rows[0]) + value[0] * 100 + value[1] * 10 + value[2]
      }
      export func fixed() -> i32 {
        let rows: *[1]Row = [Row([4; 3], 7)]
        return read(rows[0])
      }
    `
    const { field, mutable, slice, whole, each, fixed } = await run(code)
    expect([field(1), mutable(2), slice(2), whole(2), each(), fixed()]).toEqual([2227, 2227, 2227, 2223222, 1230 + 456, 4447])
    // A repeat of constants stays in the data section, with no stores.
    expect(modWat(`
      type Row = (v: [3]i32, tag: i32)
      func fixed() -> *[1]Row => [Row([4; 3], 7)]
      func zeros() -> []u8 => [0; 16]
    `)).not.toContain('store')
  })

  test('a repeated runtime value is widened to the slots it is stored in', async () => {
    // It was stored as it came, and an i32 in an i64 slot is not valid wasm.
    const { wide, real, field, arg } = await run(`
      type Row = (v: []i64, tag: u8)
      func last(s: []i64) -> i64 => s[2] ?? 9
      export func wide(n: i32) -> i64 {
        let d: *[3]i64 = [n; 3]
        return d[0] + d[2]
      }
      export func real(n: i32) -> f64 {
        let d: *mut [2]f64 = mut [n; 2]
        return d[1]
      }
      export func field(n: i32) -> i64 {
        let rows: *[1]Row = [([n; 3], 7)]
        return last(rows[0].v) + rows[0].tag
      }
      export func arg(n: u8) -> i64 => last([n; 3])
    `)
    expect([wide(-5), real(-5), field(-5), arg(200)]).toEqual([-10n, -5, 2n, 200n])
  })

  test("a runtime struct's literal fields take the fields' types", async () => {
    const { f } = await run(`
      type Mixed = (a: u64, b: u8, c: f32)
      export func f(x: u8) -> f32 {
        let l: *[2]Mixed = [(5, x, 1.5), (7, 2, 2.5)]
        return (l[0].a as f32) + (l[0].b as f32) + l[0].c + l[1].c
      }
    `)
    expect(f(3)).toBe(12)
  })
})

describe('a slice from an array literal', () => {
  test('has the length of the literal in elements, not bytes', async () => {
    const code = `
      type Pair = (a: i32, b: i32)
      export func f(n: i32) -> u32 {
        let s: []i32 = [1, 2, 3]
        let r: []i32 = [1, n]
        let p: []Pair = [(1, 2), (n, 4)]
        let z: []u16 = [0:u16; 7]
        let b: []u8 = "abcd"
        return s.len + r.len * 10 + p.len * 100 + z.len * 1000 + b.len * 10000
      }
    `
    expect(modWat(code)).toMatch(/\(local\.set \$s_len \(i32\.const 3\)\)/)
    const { f } = await run(code)
    expect(f(5)).toBe(47223)
  })

  test('a string is the slice of its bytes, with a whole length', async () => {
    const code = `
      data names: [][]u8 = ["ab", "cde", ""]
      func take(s: []u8) -> u32 => s.len
      export func f() -> u32 {
        let signed: []i8 = "abc"
        let joined: []u8 = ["ab", "c"]
        return take("abcd") + signed.len * 10 + joined.len * 100 + names.ptr[1].len * 1000 + names.len * 10000
      }
    `
    // Every length the literals give is a whole number.
    expect(modWat(code)).not.toMatch(/\(i32\.const [^)]*\./)
    const { f } = await run(code)
    expect(f()).toBe(33334)
  })

  test('data, arguments and nested slices count elements too', async () => {
    const { f } = await run(`
      data lists: [][]i32 = [[1, 2], [3]]
      data table: []u64 = [1, 2, 3]
      func take(s: []i32) -> u32 => s.len
      export func f() -> i32 {
        let t = 0
        for l in lists {
          for x in l { t += x }
          t += (l.len as i32) * 100
        }
        return t + (lists.len as i32) * 1000 + (table.len as i32) * 10000 + (take([4, 5, 6, 7]) as i32) * 100000
      }
    `)
    expect(f()).toBe(6 + 300 + 2000 + 30000 + 400000)
  })
})

describe('a slice from a pointer and a length', () => {
  test('in parentheses it is the same slice', async () => {
    const { f, g } = await run(`
      type Named = (name: []u8, n: i32)
      global word: []u8 = ("abc")
      func take(s: []u8) -> u32 => s.len
      export func f() -> u32 {
        let nums: []i32 = ([1, 2, 3])
        let named = Named(("ab"), 1)
        return take(("abcd")) + word.len * 10 + nums.len * 100 + (nums.ptr[2] as u32) * 1000 + named.name.len * 10000
      }
      export func g(p: [*]u8, n: u32) -> u32 {
        let s: []u8 = ((p, n))
        return take((s))
      }
    `)
    expect(f()).toBe(23334)
    expect(g(8, 5)).toBe(5)
  })

  test('nothing is laid out in the data section for it', () => {
    const wat = modWat(`
      data buf = mut [0:u8; 16]
      func f(n: u32) -> u32 {
        let s: []u8 = ((buf as [*]u8), n)
        return s.len
      }
    `)
    expect(wat.match(/zero bytes|\(data /g)?.length).toBe(1)
  })

  test('slices of structs and of slices', async () => {
    const { f } = await run(`
      data space = mut [0:u8; 64]
      type Lane = (cells: []i32, free: i32)
      type Option = (d: i32, lane: Lane)
      global opts: []Option = (0, 0)
      global rows: [][]i32 = (0, 0)
      export func f() -> u32 {
        let lists = space as [*]mut []i32
        lists[1] = ((space as [*]i32), 5:u32)
        let all: [][]i32 = (lists, 2:u32)
        rows = all
        opts = ((space as [*]Option), 3:u32)
        let n: u32 = 0
        for row in rows { n += row.len }
        return n + opts.len * 10 + all.len * 100
      }
    `)
    expect(f()).toBe(235)
  })
})

// === Builtin Codegen Tests ===

describe('builtin codegen', () => {
  // WAT of the first function of a module, which must check without errors.
  const funcWat = (code: string) => {
    const module = parse(code).module as AST.Module
    const checkResult = typecheck(module)
    expect(checkResult.errors.map(e => e.message)).toEqual([])
    return funcToWat(module.decls[0] as AST.FuncDecl, checkResult)
  }
  // Its body alone: no header, no local declarations.
  const body = (code: string) => funcWat(code).split('\n').slice(1, -1).map(l => l.trim()).filter(l => l && !l.startsWith('(local ')).join(' ')
  const count = (wat: string, needle: string) => wat.split(needle).length - 1
  const calls = `
    func g(x: i32) -> i32 => x
    func h(x: i32) -> i32 => x
  `

  describe('the operand type comes from the checker, whatever the operand is', () => {
    test('abs of a difference', () => {
      expect(body('func f(a: f64, b: f64) -> f64 => abs(a - b)')).toBe('(f64.abs (f64.sub (local.get $a) (local.get $b)))')
      expect(body('func f(a: i64, b: i64) -> i64 => abs(a - b)')).toContain('i64.ge_s')
    })

    test('abs of a field, an element and a dereference', () => {
      expect(body('func f(p: (x: f32, y: f32)) -> f32 => abs(p.x)')).toBe('(f32.abs (local.get $p_x))')
      expect(body('func f(p: *[4]f64) -> f64 => abs(p[1])')).toStartWith('(f64.abs (f64.load')
      expect(body('func f(p: *f64) -> f64 => abs(p.*)')).toBe('(f64.abs (f64.load (local.get $p)))')
    })

    test('min and max compare unsigned operands unsigned', () => {
      expect(body('func f(a: []u8, b: []u8) -> u32 => min(a.len, b.len)'))
        .toBe('(select (local.get $a_len) (local.get $b_len) (i32.lt_u (local.get $a_len) (local.get $b_len)))')
      expect(body('func f(a: u32, b: u32) -> u32 => max(a + 1, b)')).toContain('i32.gt_u')
      expect(body('func f(p: *[4]u32, b: u32) -> u32 => min(p[1], b)')).toContain('i32.lt_u')
    })

    test('min and max of wider and float operands', () => {
      expect(body('func f(a: i64, b: i64) -> i64 => max(a + 1, b)')).toContain('i64.gt_s')
      expect(body('func f(a: f64, b: f64) -> f64 => max(a - b, b)')).toBe('(f64.max (f64.sub (local.get $a) (local.get $b)) (local.get $b))')
    })
  })

  describe('operands used twice', () => {
    test('locals and constants are repeated, as before', () => {
      expect(body('func f(a: i32, b: i32) -> i32 => min(a, b)')).toBe('(select (local.get $a) (local.get $b) (i32.lt_s (local.get $a) (local.get $b)))')
      expect(body('func f(a: u64) -> u64 => max(a, 10)')).toBe('(select (local.get $a) (i64.const 10) (i64.gt_u (local.get $a) (i64.const 10)))')
      expect(body('func f(a: i32) -> i32 => abs(a)')).toBe('(select (local.get $a) (i32.sub (i32.const 0) (local.get $a)) (i32.ge_s (local.get $a) (i32.const 0)))')
      expect(funcWat('func f(a: i32, b: i32) -> i32 => min(a, b)')).not.toContain('(local $')
    })

    test('anything else is evaluated once, into a scratch local', () => {
      const wat = funcWat(`func f(a: i32) -> i32 => max(g(a), h(a))${calls}`)
      expect(count(wat, 'call $g')).toBe(1)
      expect(count(wat, 'call $h')).toBe(1)
      expect(wat.indexOf('call $g')).toBeLessThan(wat.indexOf('call $h'))
      expect(wat).toMatch(/\(select \(local\.tee (\$__max_0_\d+) \(call \$g \(local\.get \$a\)\)\) \(local\.tee (\$__max_1_\d+) \(call \$h \(local\.get \$a\)\)\) \(i32\.gt_s \(local\.get \1\) \(local\.get \2\)\)\)/)
      expect(wat).toMatch(/\(local \$__max_0_\d+ i32\)/)
      expect(wat).toMatch(/\(local \$__max_1_\d+ i32\)/)
    })

    test('only the operand that needs it gets a scratch local', () => {
      const wat = funcWat('func f(a: i64, b: i64) -> i64 => min(a, b * 2)')
      expect(wat).toMatch(/\(select \(local\.get \$a\) \(local\.tee (\$__min_1_\d+) \(i64\.mul \(local\.get \$b\) \(i64\.const 2\)\)\) \(i64\.lt_s \(local\.get \$a\) \(local\.get \1\)\)\)/)
      expect(wat).toMatch(/\(local \$__min_1_\d+ i64\)/)
      expect(wat).not.toContain('$__min_0_')
    })

    test('integer abs evaluates its operand once', () => {
      const wat = funcWat(`func f(a: i32) -> i32 => abs(g(a))${calls}`)
      expect(count(wat, 'call $g')).toBe(1)
      expect(wat).toMatch(/\(local \$__abs_0_\d+ i32\)/)
    })

    test('a local the other operand assigns is read once', () => {
      const src = (assigned: string) => `
        func f(x: i32, x2: i32) -> i32 => max(x, if x > 0 {
          ${assigned} = 7
          ${assigned}
        } else { 0 })
      `
      expect(funcWat(src('x'))).toMatch(/\(select \(local\.tee \$__max_0_\d+ \(local\.get \$x\)\)/)
      expect(funcWat(src('x2'))).toMatch(/\(select \(local\.get \$x\) \(local\.tee \$__max_1_\d+ /)
    })

    test('a global is read once when the other operand may change it', () => {
      const src = (second: string) => `
        global g: i32 = 0
        global h: i32 = 0
        func bump() -> i32 { g += 1
          return g }
        func set_g(a: i32) -> i32 { g = a
          return a }
        func f(a: i32) -> i32 => max(g, ${second})
      `
      const repeated = /\(select \(global\.get \$g\) .*\(i32\.gt_s \(global\.get \$g\) /
      const once = /\(select \(local\.tee \$__max_0_\d+ \(global\.get \$g\)\)/
      expect(modWat(src('a'))).toMatch(repeated)
      expect(modWat(src('a + h'))).toMatch(repeated)
      expect(modWat(src('bump()'))).toMatch(once)
      expect(modWat(src('set_g(a) + 1'))).toMatch(once)
      expect(modWat(src('if a > 0 {\n g = 7\n g } else { 0 }'))).toMatch(once)
    })

    test('scratch locals are declared wherever the call stands', () => {
      const declared = (code: string) => expect(funcWat(code + calls)).toMatch(/\(local \$__max_0_\d+ i32\)/)
      declared('func f(p: *mut [8]i32, a: i32) { p[max(g(a), 0) as u32 & 7] = 1 }')
      declared('func f(a: i32) -> (x: i32, y: i32) { set (x, y) = (max(g(a), 0), 1) }')
      declared(`func f(a: i32) -> i32 {
        match max(g(a), 0) {
          0 => { return 1 }
          _ => { return 2 }
        }
      }`)
      // A repeated value: 0.2.1 built this, pasting the operand in twice.
      declared('func f(a: i32) -> [2]i32 => [max(g(a), 0); 2]')
    })
  })

  describe('operand and result types', () => {
    test('a literal is typed by the other operand, in either position', () => {
      expect(body('func f(x: f64) -> f64 => max(1.0, x)')).toBe('(f64.max (f64.const 1) (local.get $x))')
      expect(body('func f(x: f32) -> f32 => copysign(1.0, x)')).toBe('(f32.copysign (f32.const 1) (local.get $x))')
      expect(body('func f(x: i64) -> i64 => max(0, x)')).toBe('(select (i64.const 0) (local.get $x) (i64.gt_s (i64.const 0) (local.get $x)))')
      expect(body('func f() -> f64 => sqrt(2.0)')).toBe('(f64.sqrt (f64.const 2))')
    })

    test('a narrower operand is widened to the type of the operation', () => {
      expect(body('func f(a: i64, b: i32) -> i64 => max(a, b)')).toContain('(i64.gt_s (local.get $a) (i64.extend_i32_s (local.get $b)))')
      expect(body('func f(a: u32, b: u64) -> u64 => min(a, b)')).toContain('(i64.lt_u (i64.extend_i32_u (local.get $a)) (local.get $b))')
      expect(body('func f(a: f64, b: f32) -> f64 => min(a, b)')).toBe('(f64.min (local.get $a) (f64.promote_f32 (local.get $b)))')
      expect(body('func f(a: f32, b: f64) -> f64 => copysign(a, b)')).toBe('(f64.copysign (f64.promote_f32 (local.get $a)) (local.get $b))')
      expect(body('func f(a: u32, b: u64) -> u64 => mul_hi(a, b)')).toBe('(call $__mul_hi (i64.extend_i32_u (local.get $a)) (local.get $b))')
    })

    test('a length, a constant with a form of its own, is widened once', () => {
      expect(body('func f(x: i64, p: *[4]i32) -> i64 => max(x, p.len)'))
        .toBe('(select (local.get $x) (i64.extend_i32_s (i32.const 4)) (i64.gt_s (local.get $x) (i64.extend_i32_s (i32.const 4))))')
      expect(body('func f(x: f64, p: *[4]i32) -> f64 => min(p.len, x)')).toBe('(f64.min (f64.convert_i32_s (i32.const 4)) (local.get $x))')
      expect(body('func f(p: *[4]i32) -> i64 => abs(p.len)')).toStartWith('(i64.extend_i32_s (select (i32.const 4) ')
    })

    test('the literal arms of an if or a match operand take its type, and it is widened as a whole', () => {
      expect(body('func f(x: i64, k: i32) -> i64 => max(x, match k {\n 0 => x + 1\n _ => 5\n })')).toContain('(else (i64.const 5))')
      expect(body('func f(x: i64, a: i32, c: bool) -> i64 => max(x, if c { a } else { 5 })'))
        .toContain('(i64.extend_i32_s (if (result i32) (local.get $c) (then (local.get $a)) (else (i32.const 5))))')
      expect(body('func f(x: i64, c: bool) -> i64 => max(x, if c { 0 - x } else { 5 })'))
        .toContain('(if (result i64) (local.get $c) (then (i64.sub (i64.const 0) (local.get $x))) (else (i64.const 5)))')
    })

    test('a declared function is called in place of the builtin of the same name', () => {
      const wat = modWat(`
        func abs(x: i32) -> i32 => x + 1
        export func f(x: i32) -> i32 => abs(x)
      `)
      expect(wat).toContain('(call $abs (local.get $x))')
      expect(wat).not.toContain('select')
    })

    test('where a variable hides that function, the builtin is compiled, as the checker typed it', () => {
      const wat = modWat(`
        func max(a: i32, b: i32, c: i32) -> i32 => a + b + c
        func f(max: i32) -> i32 => max(max, 2)
        func g(n: i32) -> i32 {
          for max in 4 { n = max(n, max as i32) }
          return n
        }
        export func h() -> i32 => max(1, 2, 3) + f(4) + g(0)
      `)
      expect(wat).toContain('(select (local.get $max) (i32.const 2) (i32.gt_s (local.get $max) (i32.const 2)))')
      expect(wat).toContain('(select (local.get $n) (local.get $max) (i32.gt_s (local.get $n) (local.get $max)))')
      expect(wat).toContain('(call $max (i32.const 1) (i32.const 2) (i32.const 3))')
    })

    test('mul_hi computes in u64: a literal is one, a narrower operand is widened', () => {
      expect(body('func f(a: u64) -> u64 => mul_hi(a, 3)')).toBe('(call $__mul_hi (local.get $a) (i64.const 3))')
      expect(body('func f(a: u8, b: u32) -> u64 => mul_hi(a, b)')).toBe('(call $__mul_hi (i64.extend_i32_u (local.get $a)) (i64.extend_i32_u (local.get $b)))')
    })

    test('a string literal operand of memcpy is placed in the data section', () => {
      const wat = modWat(`
        data buf = mut [0:u8; 16]
        func f() { memcpy(buf, "abcd", 4) }
      `)
      expect(wat).toContain('(data (i32.const 24) "abcd")')
      expect(wat).toContain('(memory.copy (i32.const 8) (i32.const 24) (i32.const 4))')
    })

    test('so is one in an arm of an if operand', () => {
      const wat = modWat(`
        data buf = mut [0:u8; 16]
        func f(c: bool) { memcpy(buf, if c { "abcd" } else { "wxyz" }, 4) }
      `)
      expect(wat).toContain('(data (i32.const 24) "abcd")')
      expect(wat).toContain('(data (i32.const 28) "wxyz")')
      expect(wat).toContain('(then (i32.const 24)) (else (i32.const 28))')
    })

    test('and one in a branch of an if let operand', () => {
      const wat = modWat(`
        data buf = mut [0:u8; 16]
        func f(s: []u8, i: u32, c: bool) { memcpy(buf, if let b = s[i] { "abcd" } elif c { "mnop" } else { "wxyz" }, 4) }
      `)
      expect(wat).toContain('(data (i32.const 24) "abcd")')
      expect(wat).toContain('(data (i32.const 28) "mnop")')
      expect(wat).toContain('(data (i32.const 32) "wxyz")')
      expect(wat).toContain('(i32.const 24)) (else (if (result i32) (local.get $c) (then (i32.const 28)) (else (i32.const 32))))')
    })

    test('and one in parentheses', () => {
      const wat = modWat(`
        data buf = mut [0:u8; 16]
        func f(c: bool) {
          memcpy(buf, ("abcd"), 4)
          memcpy(buf, (if c { "mnop" } else { "wxyz" }), 4)
        }
      `)
      expect(wat).toContain('(memory.copy (i32.const 8) (i32.const 24) (i32.const 4))')
      expect(wat).toContain('(then (i32.const 28)) (else (i32.const 32))')
    })

    test('abs of a small integer stays in its type', () => {
      expect(body('func f(a: i8) -> i8 => abs(a)'))
        .toBe('(select (local.get $a) (i32.shr_s (i32.shl (i32.sub (i32.const 0) (local.get $a)) (i32.const 24)) (i32.const 24)) (i32.ge_s (local.get $a) (i32.const 0)))')
      expect(body('func f(a: u16) -> u16 => abs(a + 1)')).toBe('(i32.and (i32.add (local.get $a) (i32.const 1)) (i32.const 65535))')
    })

    test('clz, ctz and popcnt give a u8, whatever the operand width', () => {
      expect(body('func f(a: u32) -> u8 => clz(a)')).toBe('(i32.clz (local.get $a))')
      expect(body('func f(a: u64) -> u8 => ctz(a)')).toBe('(i32.wrap_i64 (i64.ctz (local.get $a)))')
      expect(body('func f(a: u64) -> u32 => popcnt(a)')).toBe('(i32.wrap_i64 (i64.popcnt (local.get $a)))')
    })

    test('a 64-bit count used in 64-bit arithmetic is not narrowed and widened again', () => {
      expect(body('func f(a: u64) -> u64 => a >> ctz(a)')).toBe('(i64.shr_u (local.get $a) (i64.ctz (local.get $a)))')
      expect(body('func f(a: u64) -> u64 => clz(a)')).toBe('(i64.clz (local.get $a))')
      expect(body('func f(a: u64) -> u64 => popcnt(a) as u64')).toBe('(i64.popcnt (local.get $a))')
      expect(body('func f(a: u32, b: u64) -> u64 => b >> clz(a)')).toBe('(i64.shr_u (local.get $b) (i64.extend_i32_u (i32.clz (local.get $a))))')
    })
  })
})

// === Module Codegen Tests ===

describe('sizeof', () => {
  // The operand is the type the checker resolved. 0.2.1 resolved it again in
  // codegen with a resolver of its own, which took a many-pointer for the
  // array of unknown length behind it and gave it the size 0.
  test('a many-pointer has the size of a pointer', () => {
    const wat = modWat('export func f() -> u32 => sizeof([*]u64) * 16 + sizeof(*u64)')
    expect(wat).toContain('(i32.add (i32.mul (i32.const 4) (i32.const 16)) (i32.const 4))')
  })

  test('the forms 0.2.1 sized correctly are unchanged', () => {
    const sizes = (code: string) => [...modWat(code).matchAll(/\(i32\.const (\d+)\)/g)].map(m => Number(m[1]))
    expect(sizes(`type Pt = (q: i32, r: i32)
type List = (next: ?*List, v: u64)
export func a() -> u32 => sizeof(Pt) + sizeof(*Pt) + sizeof([]u8) + sizeof([4]u32)
export func b() -> u32 => sizeof([2x3]f32) + sizeof(u8#16) + sizeof((u8, u64)) + sizeof(?*u8)
export func c() -> u32 => sizeof(List) + sizeof(u512) + sizeof(bool) + sizeof(?[]u8) + sizeof(())
`)).toEqual([8, 4, 8, 16, 24, 1, 9, 4, 12, 64, 1, 8, 0])
  })
})

describe('module codegen', () => {
  test('simple module with export', () => {
    const wat = modWat(`
      export "double" func double(x: i32) -> i32 => x * 2
    `)
    expect(wat).toContain('(module')
    expect(wat).toContain('(func $double')
    expect(wat).toContain('(export "double" (func $double))')
  })

  test('module with import', () => {
    const wat = modWat(`
      import "env" "log" func log(x: i32)
    `)
    expect(wat).toContain('(import "env" "log"')
    expect(wat).toContain('(func $log')
  })

  test('module with multiple functions', () => {
    const wat = modWat(`
      export "add" func add(a: i32, b: i32) -> i32 => a + b
      export "sub" func sub(a: i32, b: i32) -> i32 => a - b
    `)
    expect(wat).toContain('(func $add')
    expect(wat).toContain('(func $sub')
    expect(wat).toContain('(export "add"')
    expect(wat).toContain('(export "sub"')
  })

  test('a global starts as one constant, whatever expression gives it', () => {
    const wat = modWat(`
      def page = 64 * 1024
      data table = [1:u8, 2, 3]
      global zero: i32 = 0
      global size: u32 = 4 * page
      global ratio: f32 = 1.0 / 3
      global count: i64 = table.len
      global wide: f64 = 5:i32
      global mask: u8 = ~0 << 4
      global ones: u64 = ~0
    `)
    expect(wat).toContain('(global $zero (mut i32) (i32.const 0))')
    expect(wat).toContain('(global $size (mut i32) (i32.const 262144))')
    expect(wat).toContain('(global $ratio (mut f32) (f32.const 0.3333333432674408))')
    expect(wat).toContain('(global $count (mut i64) (i64.const 3))')
    expect(wat).toContain('(global $wide (mut f64) (f64.const 5))')
    expect(wat).toContain('(global $mask (mut i32) (i32.const 240))')
    expect(wat).toContain('(global $ones (mut i64) (i64.const 18446744073709551615))')
  })

  test('a cast of a constant starts a global as the value the cast gives', () => {
    const wat = modWat(`
      type Spot = (c: i64, di: i32)
      def k = 7
      data table = mut [1:i32, 2, 3, 4]
      global same: u32 = 5 as u32
      global call: u32 = u32(5)
      global bits: u32 = -1 as u32
      global real: f64 = 1.5 as f64
      global named: u32 = k as u32
      global size: u32 = sizeof(Spot) as u32
      global start: u32 = table as u32
      global words: [*]i32 = table as [*]i32
      global bytes: [*]u8 = table as [*]u8
      global wide: i64 = 5 as i64
      global byte: u8 = 300 as u8
      global small: i8 = 200 as i8
      global single: f32 = 1.5 as f32
      global whole: i32 = 2.9 as i32
      global cut: u32 = 5000000000 as u32
    `)
    // What 0.2.1 emitted for these, when the cast left the wasm value alone.
    expect(wat).toContain('(global $same (mut i32) (i32.const 5))')
    expect(wat).toContain('(global $call (mut i32) (i32.const 5))')
    expect(wat).toContain('(global $bits (mut i32) (i32.const -1))')
    expect(wat).toContain('(global $real (mut f64) (f64.const 1.5))')
    expect(wat).toContain('(global $named (mut i32) (i32.const 7))')
    expect(wat).toContain('(global $size (mut i32) (i32.const 12))')
    expect(wat).toContain('(global $start (mut i32) (i32.const 8))')
    expect(wat).toContain('(global $words (mut i32) (i32.const 8))')
    expect(wat).toContain('(global $bytes (mut i32) (i32.const 8))')
    // A cast that needs an instruction at run time: its result.
    expect(wat).toContain('(global $wide (mut i64) (i64.const 5))')
    expect(wat).toContain('(global $byte (mut i32) (i32.const 44))')
    expect(wat).toContain('(global $small (mut i32) (i32.const -56))')
    expect(wat).toContain('(global $single (mut f32) (f32.const 1.5))')
    expect(wat).toContain('(global $whole (mut i32) (i32.const 2))')
    expect(wat).toContain('(global $cut (mut i32) (i32.const 705032704))')
  })

  test('a global starts as what its expression gives at run time', () => {
    const wat = modWat(`
      global real: f64 = 7 / 2
      global third: f32 = 1 / 3
      global byte: i32 = 200:u8 + 100:u8
      global word: u64 = 0xFFFFFFFF:u32 + 1
      global count: u32 = 1:u32 << 40
      global zero: f64 = 0.0 * -1.0
    `)
    expect(wat).toContain('(global $real (mut f64) (f64.const 3.5))')
    expect(wat).toContain('(global $third (mut f32) (f32.const 0.3333333432674408))')
    expect(wat).toContain('(global $byte (mut i32) (i32.const 44))')
    expect(wat).toContain('(global $word (mut i64) (i64.const 0))')
    expect(wat).toContain('(global $count (mut i32) (i32.const 256))')
    expect(wat).toContain('(global $zero (mut f64) (f64.const -0))')
  })

  test('export without explicit name uses function name', () => {
    const wat = modWat(`
      export func multiply(a: i32, b: i32) -> i32 => a * b
    `)
    expect(wat).toContain('(func $multiply')
    expect(wat).toContain('(export "multiply" (func $multiply))')
  })

  test('export with explicit name can differ from function name', () => {
    const wat = modWat(`
      export "_start" func main() {}
    `)
    expect(wat).toContain('(func $main')
    expect(wat).toContain('(export "_start" (func $main))')
  })
})

// Where a value is a call, or the last expression of a block is not a plain
// name, its type is the one recorded for that expression itself. These were
// miscompiled while types were found by where an expression starts.
describe('a call, a member or an operator wherever a value stands', () => {
  // The body of the first function of a module that checks and assembles.
  const body = (code: string) => {
    const wat = modWat(code)
    const start = wat.indexOf('(func ')
    return wat.slice(start, wat.indexOf('\n  )', start)).split('\n').slice(1).map(l => l.trim()).filter(l => l && !l.startsWith('(local ')).join(' ')
  }
  const validates = async (code: string) => {
    const wabt = await (await import('wabt')).default()
    const module = wabt.parseWat('t.wat', modWat(code), { multi_value: true, bulk_memory: true })
    try {
      module.validate()
    } finally {
      module.destroy()
    }
  }
  const pair = 'func two(a: i64) -> (i64, i64) => (a, a + 1)\n'

  test('set (a, b) = f()', async () => {
    const code = `func f(x: i64) -> i64 {\n  let a: i64 = 0\n  let b: i64 = 0\n  set (a, b) = two(x)\n  return a + b\n}\n${pair}`
    expect(body(code)).toContain('(call $two (local.get $x)) (local.set $b) (local.set $a)')
    await validates(code)
  })

  test('a call as an arrow body is converted to the result type', async () => {
    const code = 'func f(x: u32) -> u64 => g(x)\nfunc g(x: u32) -> u32 => x'
    expect(body(code)).toBe('(i64.extend_i32_u (call $g (local.get $x)))')
    await validates(code)
  })

  test('a call as the value of a compound assignment', async () => {
    const code = 'func f(x: u32) -> (n: u64) {\n  n += g(x)\n  n *= g(x) + g(x)\n}\nfunc g(x: u32) -> u32 => x'
    expect(body(code)).toContain('(local.set $n (i64.add (local.get $n) (i64.extend_i32_u (call $g (local.get $x)))))')
    await validates(code)
  })

  test('min(a.len, b.len) on u32 compares unsigned', async () => {
    const code = 'func f(a: []u8, b: []u8) -> u32 => min(a.len, b.len)'
    expect(body(code)).toContain('i32.lt_u')
    expect(body(code)).not.toContain('i32.lt_s')
    await validates(code)
  })

  test('abs(a - b) on f64 keeps f64.abs', async () => {
    const code = 'func f(a: f64, b: f64) -> f64 => abs(a - b)'
    expect(body(code)).toBe('(f64.abs (f64.sub (local.get $a) (local.get $b)))')
    await validates(code)
  })

  test('let z = if c { p.x } else { p.y }', async () => {
    const code = 'func f(c: bool, p: (x: f64, y: f64)) -> f64 {\n  let z = if c { p.x } else { p.y }\n  return z\n}'
    expect(body(code)).toContain('(local.set $z (if (result f64) (local.get $c) (then (local.get $p_x)) (else (local.get $p_y))))')
    await validates(code)
  })

  test('the same where the call is written with a receiver', async () => {
    const code = `func f(x: i64) -> (n: i64) {\n  let a: i64 = 0\n  let b: i64 = 0\n  set (a, b) = x.two()\n  n += a.max(b).abs()\n}\n${pair}`
    expect(body(code)).toContain('(call $two (local.get $x)) (local.set $b) (local.set $a)')
    await validates(code)
  })
})

describe('functions that share a name, in the output', () => {
  test('each is emitted where it is declared, the later ones under their own names', () => {
    const wat = modWat(`
      func size(a: u32) -> u32 => 4
      export func f(p: *u8, x: u64) -> u32 => size(1:u32) + size(x) + p.size()
      func size(a: u64) -> u32 => 8
      func size(p: *u8) -> u32 => 1
    `)
    expect([...wat.matchAll(/^\s*\(func \$(\S+)/gm)].map(m => m[1])).toEqual(['size', 'f', 'size:u64', 'size:*u8'])
    expect(wat).toContain('(i32.add (i32.add (call $size (i32.const 1)) (call $size:u64 (local.get $x))) (call $size:*u8 (local.get $p)))')
  })

  test('an import that shares its name is declared under its own', () => {
    const wat = modWat(`
      import "env" ( "log_u32" func log(x: u32) "log_f64" func log(x: f64) )
      export func f(a: u32, b: f64) { log(a) log(b) }
    `)
    expect(wat).toContain('(import "env" "log_u32" (func $log (param $x i32) ))')
    expect(wat).toContain('(import "env" "log_f64" (func $log:f64 (param $x f64) ))')
    expect(wat).toContain('(call $log (local.get $a))')
    expect(wat).toContain('(call $log:f64 (local.get $b))')
  })

  test('funcToWat finds a function that shares its name by its declaration', () => {
    const module = parse('func size(a: u32) -> u32 => 4\nfunc size(a: u64) -> u32 => 8').module as AST.Module
    const checkResult = typecheck(module)
    expect(funcToWat(module.decls[1] as AST.FuncDecl, checkResult)).toStartWith('(func $size:u64 (param $a i64) (result i32)')
  })
})

describe('members named like a primitive type', () => {
  test('a field whose name starts like one is read and written as any field', () => {
    const wat = modWat(`
      type S = (u32s: u32, boolish: bool, i8_le: u8)
      export func f(s: *mut S, v: S) -> u32 {
        s.u32s = 7
        s.i8_le += 1
        return s.u32s + v.u32s
      }
    `)
    expect(wat).toContain('(i32.store (local.get $s) (i32.const 7))')
    expect(wat).toContain('(i32.add (i32.load (local.get $s)) (local.get $v_u32s))')
  })

  test('a function of such a name is called as a method, and the type pun is still the pun', () => {
    const wat = modWat(`
      func u32s(n: u32) -> u32 => n * 4
      export func f(n: u32, p: *u8) -> u32 => n.u32s() + p.u32[0]
    `)
    expect(wat).toContain('(i32.add (call $u32s (local.get $n)) (i32.load (i32.add (local.get $p) ')
  })

  test('a field whose name is one and a hyphen is read and written as any field', () => {
    const wat = modWat(`
      type S = (u32-count: u32, bool-ish: bool)
      func u32-twice(n: u32) -> u32 => n * 2
      export func f(s: *mut S, v: S, p: *u8) -> u32 {
        s.u32-count = 7
        return s.u32-count + v.u32-count + v.u32-count.u32-twice() + p.u32[0] - 1
      }
    `)
    expect(wat).toContain('(i32.store (local.get $s) (i32.const 7))')
    expect(wat).toContain('(i32.add (i32.load (local.get $s)) (local.get $v_u32-count))')
    expect(wat).toContain('(call $u32-twice (local.get $v_u32-count))')
    // p.u32[0] - 1, with spaces, is the subtraction.
    expect(wat).toMatch(/\(i32\.sub \(i32\.add .*\(i32\.load \(i32\.add \(local\.get \$p\) .*\(i32\.const 1\)\) \(return\)/)
  })
})

describe('declarations take the types they are checked as', () => {
  test('a constant past an i32 with no type is an i64, alone or in a tuple, local or global', async () => {
    const x = await run(`
      global big = 2147483648
      global count = 0
      export func pair() -> i64 {
        let t = (3000000000, 1)
        return t.0 + (t.1 as i64)
      }
      export func parts() -> i64 {
        let (p, q) = (3000000000, 2147483648)
        return p - q
      }
      export func named() -> i64 {
        let t = (x: 3000000000, y: 1)
        return t.x
      }
      export func wide() -> i64 => big + 1
      export func bump() -> i32 {
        count = 7
        count += 1
        return count
      }
    `)
    expect(x.pair()).toBe(3000000001n)
    expect(x.parts()).toBe(852516352n)
    expect(x.named()).toBe(3000000000n)
    expect(x.wide()).toBe(2147483649n)
    expect(x.bump()).toBe(8)
  })

  test('a constant loop count is a u32, past an i32 too', async () => {
    const x = await run(`
      def big = 3000000000
      export func lit() -> u32 {
        let n: u32 = 0
        for i in 3000000000 {
          n = i
          if i == 3 { break }
        }
        return n
      }
      export func named() -> u32 {
        let n: u32 = 0
        for i in big {
          n += 1
          if i == 4 { break }
        }
        return n
      }
      export func top() -> u32 {
        let n: u32 = 0
        for i in (1 << 31) + 1 {
          n = i
          if i == 6 { break }
        }
        return n
      }
    `)
    expect(x.lit()).toBe(3)
    expect(x.named()).toBe(5)
    expect(x.top()).toBe(6)
    const errs = typecheck(parse('func f() { for i in 5000000000 { } }').module as AST.Module).errors.map((e) => e.message)
    expect(errs).toEqual(['cannot assign int(5000000000) to u32'])
  })
})

describe('set takes the types of the variables it sets', () => {
  test('constants in a tuple, or in the branches that give one, take each variable\'s type', async () => {
    const x = await run(`
      export func lits() -> i64 {
        let a: i64 = 0
        let b: i64 = 0
        set (a, b) = (1, 2)
        return a * 10 + b
      }
      export func mixed() -> f64 {
        let a: f32 = 0
        let b: u64 = 0
        let c: f64 = 0
        let x: i32 = 5
        set (a, b, c) = (1, 2, x)
        return (a as f64) * 100 + (b as f64) * 10 + c
      }
      export func branches(c: bool) -> i64 {
        let a: i64 = 0
        let b: u64 = 0
        set (a, b) = if c { (1, 2) } else { (3, 4) }
        return a * 10 + (b as i64)
      }
      export func named() -> i64 {
        let a: i64 = 0
        let b: f64 = 0
        set (x: a, y: b) = (y: 2, x: 1)
        return a * 10 + (b as i64)
      }
    `)
    expect(x.lits()).toBe(12n)
    expect(x.mixed()).toBe(125)
    expect(x.branches(1)).toBe(12n)
    expect(x.branches(0)).toBe(34n)
    expect(x.named()).toBe(12n)
  })

  test('globals, struct variables and the parts of a nested pattern are set', async () => {
    const x = await run(`
      type Pt = (x: i32, y: i32)
      global g1: i64 = 0
      global g2: f32 = 0
      global gp: Pt = Pt(0, 0)
      global gs: []u8 = "ab"
      data four = [1:u8, 2, 3, 4]
      export func globals() -> i64 {
        set (g1, g2) = (4, 5)
        set gp = Pt(6, 7)
        set gs = four
        return g1 * 1000 + (g2 as i64) * 100 + (gp.y as i64) * 10 + (gs.len as i64)
      }
      export func local() -> i32 {
        let p = Pt(1, 2)
        set p = Pt(3, 4)
        return p.x * 10 + p.y
      }
      export func nested() -> i32 {
        let a: i32 = 0
        let b: i32 = 0
        let c: i32 = 0
        set (a, (b, c)) = (1, (2, 3))
        let (d, (e, f)) = (4, (5, 6))
        return a * 100000 + b * 10000 + c * 1000 + d * 100 + e * 10 + f
      }
    `)
    expect(x.globals()).toBe(4574n)
    expect(x.local()).toBe(34)
    expect(x.nested()).toBe(123456)
  })

  test('a value that is already on the stack is not widened field by field', () => {
    const errs = typecheck(parse(`
      func pair() -> (i32, i32) => (1, 2)
      func f() {
        let a: i64 = 0
        let b: i32 = 0
        set (a, b) = pair()
      }
    `).module as AST.Module).errors.map((e) => e.message)
    expect(errs).toEqual(["cannot set 'a' (i64) from a field of type i32"])
  })
})

describe('arguments by place and by name', () => {
  test('a constructor takes each named argument for its field, and the others by place', async () => {
    const x = await run(`
      type Pt = (q: i32, r: i32)
      type Wide = (a: i64, b: f64, c: u8)
      global gp: Pt = Pt(r: 4, q: 3)
      data dp: *[2]Pt = [Pt(r: 6, q: 5), Pt(7, r: 8)]
      export func mixed(q: i32) -> i32 {
        let p = Pt(q, r: 2)
        return p.q * 10 + p.r
      }
      export func swapped() -> i32 {
        let p = Pt(r: 2, q: 1)
        return p.q * 10 + p.r
      }
      export func short(q: i32, r: i32) -> i32 => Pt(r:, q:).q * 10 + Pt(r:, q:).r
      export func wide() -> f64 {
        let w = Wide(c: 3, a: 1, b: 2)
        return (w.a as f64) * 100 + w.b * 10 + (w.c as f64)
      }
      export func glob() -> i32 => gp.q * 10 + gp.r
      export func dat() -> i32 => dp[0].q * 1000 + dp[0].r * 100 + dp[1].q * 10 + dp[1].r
    `)
    expect(x.mixed(1)).toBe(12)
    expect(x.swapped()).toBe(12)
    expect(x.short(1, 2)).toBe(12)
    expect(x.wide()).toBe(123)
    expect(x.glob()).toBe(34)
    expect(x.dat()).toBe(5678)
  })

  test('the values of a constructor are computed in the order they are written', async () => {
    const x = await run(`
      type Pt = (q: i32, r: i32)
      func Pair(comptime A: type, comptime B: type) -> type => (first: A, second: B)
      global seen: i32 = 0
      func tick(v: i32) -> i32 {
        seen = seen * 10 + v
        return v
      }
      export func plain() -> i32 {
        seen = 0
        let p = Pt(r: tick(1), q: tick(2))
        return seen * 100 + p.q * 10 + p.r
      }
      export func generic() -> i32 {
        seen = 0
        let p = Pair(i32, i32)(second: tick(1), first: tick(2))
        return seen * 100 + p.first * 10 + p.second
      }
      export func mixed() -> i32 {
        seen = 0
        let p = Pt(tick(2), r: tick(1))
        return seen * 100 + p.q * 10 + p.r
      }
      data cell = mut [Pt(0, 0), Pt(5, 6)]
      export func stored() -> i32 {
        seen = 0
        cell[0] = Pt(r: tick(1), q: tick(2))
        return seen * 100 + cell[0].q * 10 + cell[0].r
      }
      export func read() -> i32 {
        let p: *mut Pt = &cell[1]
        let v = Pt(r: p.q, q: put(p))
        return v.q * 10 + v.r
      }
      func put(p: *mut Pt) -> i32 {
        p.q = 7
        return 8
      }
    `)
    expect(x.plain()).toBe(1221)
    expect(x.generic()).toBe(1221)
    expect(x.mixed()).toBe(2121)
    expect(x.stored()).toBe(1221)
    // The load is written first: it reads 5, before the call writes 7.
    expect(x.read()).toBe(85)
  })

  test('the fields in the order of the type, or values free to move, wait in no scratch local', () => {
    const body = (src: string) => bodyOf(`
      type Pt = (q: i32, r: i32)
      global g: i32 = 0
      func one() -> i32 => 1
      func two() -> i32 => 2
      func f(k: i32, p: *Pt) -> Pt => ${src}
    `, 'f').join(' ')
    // In the order of the type, by name or not: what the fields are written as.
    expect(body('Pt(q: one(), r: two())')).toBe(body('Pt(one(), two())'))
    // A constant or a local goes to its place as it is.
    expect(body('Pt(r: k + 1, q: two())')).toBe(body('Pt(two(), k + 1)'))
    expect(body('Pt(r: one(), q: 3)')).toBe(body('Pt(3, one())'))
    // A call, a load or a global read written before what comes first waits.
    expect(body('Pt(r: one(), q: two())')).toBe(
      '(local.set $__tmp_0 (call $one)) (call $two) (local.get $__tmp_0)')
    expect(body('Pt(r: p.q, q: two())')).toBe(
      '(local.set $__tmp_0 (i32.load (local.get $p))) (call $two) (local.get $__tmp_0)')
    expect(body('Pt(r: g, q: two())')).toBe('(local.set $__tmp_0 (global.get $g)) (call $two) (local.get $__tmp_0)')
  })

  test('a local that a value written after it sets, and a value that can trap, wait too', async () => {
    const x = await run(`
      type Pt = (q: i32, r: i32)
      global seen: i32 = 0
      func tick(v: i32) -> i32 {
        seen = seen * 10 + v
        return v
      }
      export func local() -> i32 {
        let k = 1
        let p: Pt = (r: k, q: if true { k = 4
          k } else { 0 })
        return p.q * 10 + p.r
      }
      export func trap(z: i32) -> i32 {
        let p: Pt = (r: 10 / z, q: tick(9))
        return p.q + p.r
      }
      export func calls() -> i32 => seen
    `)
    expect(x.local()).toBe(41)
    expect(() => x.trap(0)).toThrow()
    expect(x.calls()).toBe(0)
    expect(x.trap(2)).toBe(14)
    expect(x.calls()).toBe(9)
  })

  test('a value of several wasm values waits in as many scratch locals', async () => {
    const x = await run(`
      type Wide = (a: u128, b: u8)
      type Pp = (p: (u32, u32), q: u32)
      global seen: u32 = 0
      func two() -> u32 {
        seen = seen * 10 + 2
        return 2
      }
      func big() -> u128 {
        seen = seen * 10 + 3
        return 7
      }
      func pair() -> (u32, u32) {
        seen = seen * 10 + 4
        return (5, 6)
      }
      export func wide() -> u32 {
        seen = 0
        let w = Wide(b: two() as u8, a: big())
        return seen * 100 + (w.a as u32) * 10 + (w.b as u32)
      }
      export func pp() -> u32 {
        seen = 0
        let w = Pp(q: two(), p: pair())
        return seen * 1000 + w.p.0 * 100 + w.p.1 * 10 + w.q
      }
    `)
    expect(x.wide()).toBe(2372)
    expect(x.pp()).toBe(24562)
  })
})

describe('a tuple literal with names gives each field by name', () => {
  test('wherever it meets a struct', async () => {
    const x = await run(`
      type Pt = (x: i32, y: i32)
      type Box = (lo: Pt, hi: Pt)
      type Small = (b: u8, w: u32)
      global g: Pt = (y: 1, x: 2)
      data d: *[2]Pt = [(y: 3, x: 4), Pt(y: 5, x: 6)]
      data s: Small = (w: 300, b: 7)
      data words = [1:u8, 2, 3, 4]
      func get-x(p: Pt) -> i32 => p.x
      func ret() -> Pt {
        return (y: 7, x: 8)
      }
      func arrow() -> Pt => (y: 9, x: 10)
      func store(p: *mut Pt) {
        p.* = (y: 11, x: 12)
      }
      func box() -> Box => (hi: (y: 13, x: 14), lo: (y: 15, x: 16))
      func at() -> *Pt => &(y: 17, x: 18)
      func view() -> []u8 => (len: 3, ptr: words as [*]u8)
      export func let_() -> i32 {
        let p: Pt = (y: 1, x: 2)
        return p.x * 10 + p.y
      }
      export func arg() -> i32 => get-x((y: 1, x: 2))
      export func returned() -> i32 => ret().x * 100 + arrow().x
      export func global_() -> i32 => g.x * 10 + g.y
      export func data_() -> i32 => d[0].x * 10 + d[1].x
      export func data_struct() -> i32 => (s.b as i32) * 1000 + (s.w as i32)
      data cell = mut [Pt(0, 0)]
      export func stored() -> i32 {
        store(&cell[0])
        return cell[0].x * 100 + cell[0].y
      }
      export func field() -> i32 {
        let b = box()
        return b.lo.x * 100 + b.hi.x
      }
      export func assigned() -> i32 {
        let p: Pt = (1, 2)
        p = (y: 3, x: 4)
        return p.x * 10 + p.y
      }
      export func receiver() -> i32 => (y: 1, x: 2).get-x()
      export func branch(c: bool) -> i32 {
        let p: Pt = if c { (y: 1, x: 2) } else { (x: 3, y: 4) }
        return p.x
      }
      export func address() -> i32 => at().x
      export func slice() -> i32 => (view().len as i32) * 10 + (view().ptr[2] as i32)
      export func registers() -> i32 {
        let a: [2]Pt = [(y: 1, x: 2), (3, 4)]
        return a[0].x * 1000 + a[0].y * 100 + a[1].x * 10 + a[1].y
      }
    `)
    expect(x.let_()).toBe(21)
    expect(x.arg()).toBe(2)
    expect(x.returned()).toBe(810)
    expect(x.global_()).toBe(21)
    expect(x.data_()).toBe(46)
    expect(x.data_struct()).toBe(7300)
    expect(x.stored()).toBe(1211)
    expect(x.field()).toBe(1614)
    expect(x.assigned()).toBe(43)
    expect(x.receiver()).toBe(2)
    expect(x.branch(1)).toBe(2)
    expect(x.branch(0)).toBe(3)
    expect(x.address()).toBe(18)
    expect(x.slice()).toBe(33)
    expect(x.registers()).toBe(2134)
  })

  test('computing its values in the order they are written', async () => {
    const x = await run(`
      type Pt = (q: i32, r: i32)
      global seen: i32 = 0
      func tick(v: i32) -> i32 {
        seen = seen * 10 + v
        return v
      }
      data cell = mut [Pt(0, 0)]
      export func literal() -> i32 {
        seen = 0
        let p: Pt = (r: tick(1), q: tick(2))
        return seen * 100 + p.q * 10 + p.r
      }
      export func stored() -> i32 {
        seen = 0
        cell[0] = (r: tick(1), q: tick(2))
        return seen * 100 + cell[0].q * 10 + cell[0].r
      }
    `)
    expect(x.literal()).toBe(1221)
    expect(x.stored()).toBe(1221)
    const body = (src: string) => bodyOf(`
      type Pt = (q: i32, r: i32)
      func one() -> i32 => 1
      func two() -> i32 => 2
      func f(k: i32) -> Pt => ${src}
    `, 'f').join(' ')
    expect(body('(q: one(), r: two())')).toBe(body('(one(), two())'))
    expect(body('(r: one(), q: 3)')).toBe(body('(3, one())'))
    expect(body('(r: one(), q: two())')).toBe('(local.set $__tmp_0 (call $one)) (call $two) (local.get $__tmp_0)')
  })

  test('and fills named results by name', async () => {
    const x = await run(`
      func trailing() -> (q: i32, r: i32) {
        (r: 1, q: 2)
      }
      func arrow() -> (q: i32, r: i32) => (r: 1, q: 2)
      func returned() -> (q: i32, r: i32) {
        return (r: 1, q: 2)
      }
      func by_place() -> (q: i32, r: i32) => (1, 2)
      export func f() -> i32 {
        let (q: a, r: b) = trailing()
        let (q: c, r: d) = arrow()
        let (q: e, r: h) = returned()
        let (q: k, r: m) = by_place()
        return a * 1000 + c * 100 + e * 10 + k + (b + d + h + m) * 10000
      }
    `)
    expect(x.f()).toBe(52221)
  })

  test('also through an if or a match that ends a block body, as in an expression body', async () => {
    const x = await run(`
      func split(n: u32) -> (hi: u32, lo: u32) => (n >> 16, n & 0xffff)
      func trailing_if(c: bool) -> (q: i32, r: i32) {
        if c { (r: 1, q: 2) } else { (r: 3, q: 4) }
      }
      func trailing_match(k: i32) -> (q: i32, r: i32) {
        match k { 0 => (r: 1, q: 2), _ => { (r: 3, q: 4) } }
      }
      func arrow_if(c: bool) -> (q: i32, r: i32) => if c { (r: 1, q: 2) } else { (r: 3, q: 4) }
      func mixed(c: bool, n: u32) -> (lo: u32, hi: u32) {
        if c { split(n) } else { (hi: 1, lo: 2) }
      }
      func orders(c: bool, n: u32) -> (lo: u32, hi: u32) {
        let k: u32 = n + 1
        if c { (hi: k, lo: 3) } else { (lo: 4, hi: k) }
      }
      export func f() -> i32 {
        let (q: a) = trailing_if(true)
        let (q: b) = trailing_if(false)
        let (q: c) = trailing_match(0)
        let (q: d) = trailing_match(1)
        let (q: e) = arrow_if(false)
        return a * 10000 + b * 1000 + c * 100 + d * 10 + e
      }
      export func g() -> u32 => mixed(true, 0x50006).lo * 100 + mixed(false, 0).lo * 10 + mixed(false, 0).hi
      export func h() -> u32 => orders(true, 1).lo * 1000 + orders(true, 1).hi * 100 + orders(false, 4).lo * 10 + orders(false, 4).hi
    `)
    expect(x.f()).toBe(24244)
    expect(x.g()).toBe(521)
    // Branches that give the same names in another order are not of
    // different types: each fills the results by name.
    expect(x.h()).toBe(3245)
  })

  test('in a generic, and to decide a type parameter', async () => {
    const x = await run(`
      func Pair(comptime A: type, comptime B: type) -> type => (first: A, second: B)
      func first_of(comptime T: type, p: (a: T, b: u8)) -> T => p.a
      func keep(comptime T: type, p: Pair(T, u8)) -> T => p.first
      func make(comptime T: type, x: T) -> Pair(T, u8) => (second: 3, first: x)
      export func f(x: u64, y: u8) -> u64 {
        let m = make(x)
        return first_of((b: y, a: x)) * 1000 + keep((second: y, first: x)) * 100 + m.first * 10 + (m.second as u64)
      }
    `)
    expect(x.f(5n as never, 1)).toBe(5553n)
  })

  test('in an array with no type, whose tuples settle on one type as branches do', async () => {
    // At 445731f the elements were laid over the first one's type as they
    // came: 300 sat in a u8 (188 below) and 5000000000 in an i32.
    const x = await run(`
      export func wide() -> i32 {
        let v = [(x: 1:u8, y: 2), (x: 300, y: 4)]
        return v[1].x * 10 + v[1].y
      }
      export func big() -> i64 {
        let v = [(1, 2), (3, 5000000000)]
        return v[1].1 + (v[0].0 as i64)
      }
      export func turned() -> i32 {
        let v = [(y: 1, x: 2), (x: 3, y: 4)]
        return v[1].x * 10 + v[1].y
      }
      global g = [(y: 1, x: 2), (x: 5, y: 6)]
      export func global_() -> i32 => g[1].x * 10 + g[1].y
      export func strings() -> i32 {
        let v = [("a", 1), ("bc", 2), ("def", 3)]
        return v[2].0.len as i32 * 100 + v[1].0.len as i32 * 10 + v[0].0.len as i32
      }
      export func named() -> i32 {
        let v = [(n: 1, s: "a"), (s: "bc", n: 2)]
        return v[1].n * 10 + v[1].s.len as i32
      }
      global gs = [("ab", 1), ("c", 2)]
      export func gstrings() -> i32 => gs[0].0.len as i32 * 10 + gs[1].0.len as i32
    `)
    // Strings of other lengths each keep their length.
    expect([x.strings(), x.named(), x.gstrings()]).toEqual([321, 22, 21])
    expect(x.wide()).toBe(3004)
    expect(x.big()).toBe(5000000001n)
    // A tuple with names meets the first one's type by name.
    expect(x.turned()).toBe(34)
    expect(x.global_()).toBe(56)
  })
})

describe('the address of an element, where a pointer is expected', () => {
  test('of a many-pointer is the element\'s address, not its value', async () => {
    const x = await run(`
      type Pt = (x: i32, y: i32)
      data cells = mut [10:i32, 20, 30, 40]
      data pts = mut [Pt(1, 2), Pt(3, 4)]
      func get(p: *i32) -> i32 => p.*
      func put(p: *mut Pt) { p.x = 9 }
      export func many(i: u32) -> i32 {
        let list = cells as [*]mut i32
        let q = &list[i]
        return get(q) + get(&list[i + 1])
      }
      export func many_struct() -> i32 {
        let list = pts as [*]mut Pt
        put(&list[1])
        return pts[1].x * 10 + pts[1].y
      }
      export func fixed() -> i32 => get(&cells[2])
      export func cell() -> i32 => get(&5)
    `)
    expect(x.many(1)).toBe(50)
    expect(x.many_struct()).toBe(94)
    expect(x.fixed()).toBe(30)
    expect(x.cell()).toBe(5)
  })

  test('of a literal in parentheses is a cell holding it', async () => {
    const x = await run(`
      func get(p: *i32) -> i32 => p.*
      func pair(p: *(i32, i32)) -> i32 => p.0 * 10 + p.1
      export func expected() -> i32 => get(&(8))
      export func typed() -> i32 => get(&(6:i32)) + get(&(1):i32)
      export func inferred() -> i32 {
        let p = &(9)
        return p.*
      }
      export func tuple() -> i32 => pair(&((1, 2)))
    `)
    expect(x.expected()).toBe(8)
    expect(x.typed()).toBe(7)
    expect(x.inferred()).toBe(9)
    expect(x.tuple()).toBe(12)
  })

  test('of a tuple with values only known when the program runs is a cell that is given them', async () => {
    // At 445731f the cell of &(y: t(1), x: t(n)) held zeros and t was never
    // called. (That such a cell shares no bytes with an equal literal is
    // claude/fix2-literals' 052c7ef.)
    const x = await run(`
      type Pt = (x: i32, y: i32)
      type Box = (lo: Pt, k: i32)
      global seen: i32 = 0
      func t(v: i32) -> i32 {
        seen = seen * 10 + v
        return v
      }
      func get(p: *Pt) -> i32 => p.x * 10 + p.y
      export func runtime(n: i32) -> i32 => get(&(y: t(1), x: t(n)))
      export func seen_() -> i32 => seen
      export func nested(n: i32) -> i32 {
        let p: *Box = &(k: t(3), lo: (y: n, x: 5))
        return p.lo.x * 100 + p.lo.y * 10 + p.k
      }
      export func written(n: i32) -> i32 {
        let p: *mut Pt = &mut (y: n, x: 7)
        p.y += 1
        return get(p)
      }
    `)
    expect(x.runtime(2)).toBe(21)
    expect(x.seen_()).toBe(12)
    expect(x.nested(4)).toBe(543)
    expect(x.written(5)).toBe(76)
  })

  test('of an array written out is that array laid out, as it is without the &', async () => {
    const x = await run(`
      type Pt = (x: i32, y: i32)
      func row(p: *[2]i32) -> i32 => p[0] * 10 + p[1]
      func pts(p: *[2]Pt) -> i32 => p[0].x * 1000 + p[0].y * 100 + p[1].x * 10 + p[1].y
      func put(p: *mut [2]i32) -> i32 {
        p[0] = 9
        return row(p)
      }
      export func ints(v: i32) -> i32 => row(&[1, 2]) * 10000 + row(&[3; 2]) * 100 + row(&[v, 4])
      export func structs() -> i32 {
        let p: *[2]Pt = &[(y: 5, x: 6), Pt(7, 8)]
        return pts(p)
      }
      export func own() -> i32 => put(&[1, 2]) * 100 + row([1, 2])
    `)
    expect(x.ints(5)).toBe(123354)
    expect(x.structs()).toBe(6578)
    expect(x.own()).toBe(9212)
  })

  test('of a row of a many-pointer table is where its row pointer is', async () => {
    const x = await run(`
      data rows: *mut [2][3]i32 = mut [[1, 2, 3], [4, 5, 6]]
      func sum(r: *[3]i32) -> i32 => r[0] + r[1] * 10 + r[2] * 100
      export func row(i: u32) -> i32 {
        let q = &(rows as [*][3]i32)[i]
        return sum(q.*)
      }
      export func write(i: u32) -> i32 {
        let q: *mut *mut [3]i32 = &(rows as [*]mut [3]i32)[i]
        q.*[0] = 9
        return sum(rows[1])
      }
    `)
    expect(x.row(1)).toBe(654)
    expect(x.write(1)).toBe(659)
    const errs = typecheck(parse(`
      func sum(r: *[3]i32) -> i32 => r[0]
      func f(p: [*][3]i32, i: u32) -> i32 => sum(&p[i])
    `).module as AST.Module).errors.map((e) => e.message)
    expect(errs).toEqual(['argument 1: cannot assign **[3]i32 to *[3]i32'])
  })

  test('of a variable is none', () => {
    const errs = typecheck(parse(`
      type Pt = (x: i32, y: i32)
      func get(p: *i32) -> i32 => p.*
      func put(p: *mut Pt) { p.x = 9 }
      func a(x: i32) -> i32 => get(&x)
      func b() {
        let p = Pt(1, 2)
        put(&p)
      }
    `).module as AST.Module).errors.map((e) => e.message)
    expect(errs).toEqual(["'x' has no address: a variable is held in registers", "'p' has no address: a variable is held in registers"])
  })

  // #37: & before a pointer was the pointer itself, silently.
  test('of a pointer that is in no cell is an error', () => {
    const errs = typecheck(parse(`
      type Pt = (x: i32, y: i32)
      type P = *i32
      data buf = [1:u8, 2, 3]
      global where: *i32 = 16 as *i32
      func get(p: *i32) -> i32 => p.*
      func id(p: *i32) -> *i32 => p
      func a(p: *i32) -> i32 => get(&p)
      func b(s: []u8) -> u32 => (&s).len
      func c(m: [*]i32) -> [*]i32 => &m
      func d(o: ?*i32) -> ?*i32 => &o
      func e(p: *i32) -> i32 => get(&id(p))
      func f(p: *i32) -> i32 => get(&p.id())
      func g(n: u32) -> i32 => get(&(n as *i32))
      func h(base: [*]u32, k: u32) -> [*]Pt => &base[k] as [*]Pt
      func i() -> *[3]u8 => &buf
      func j() -> *i32 => &where
      func k(p: P) -> P => &p
      func l(c: bool, p: *i32, q: *i32) -> *i32 => &(if c { p } else { q })
      func m(p: ?*i32, q: *i32) -> *i32 => &(p ?? q)
      func o() -> u32 => (&(4096:*u32)) as u32
      func q() -> u32 => (&(0:?*u32)) as u32
      func n() -> u32 {
        let s: []u8 = "ab"
        let t = &s
        return t.len
      }
    `).module as AST.Module).errors.map((e) => e.message)
    expect(errs).toEqual([
      "'p' is already a pointer (*i32): drop the &",
      "'s' is already a pointer ([]u8): drop the &",
      "'m' is already a pointer ([*]i32): drop the &",
      "'o' is already a pointer (?*i32): drop the &",
      "'id(p)' is already a pointer (*i32): drop the &",
      "'p.id()' is already a pointer (*i32): drop the &",
      "'(n as *i32)' is already a pointer (*i32): drop the &",
      "'base[k] as [*]Pt' is already a pointer ([*]Pt): drop the & (a cast binds tighter than &: for the address of base[k], write (&base[k]) as [*]Pt)",
      "'buf' is already a pointer (*[3]u8): drop the &",
      "'where' is already a pointer (*i32): drop the &",
      "'p' is already a pointer (P): drop the &",
      "this value is already a pointer (*i32): drop the &",
      "this value is already a pointer (*i32): drop the &",
      "this value is already a pointer (*u32): drop the &",
      "this value is already a pointer (?*u32): drop the &",
      "'s' is already a pointer ([]u8): drop the &",
    ])
  })

  test('of a pointer in a test, and of what another module gives', async () => {
    expect(typecheck(parse(`
      test "t" {
        let p = 8 as *i32
        let q = &p
        assert q == p
      }
    `).module as AST.Module).errors.map((e) => e.message)).toEqual(["'p' is already a pointer (*i32): drop the &"])
    const { typecheckProgram } = await import('./checker')
    const { resolve } = await import('node:path')
    const [lib, main] = [resolve('/p/lib.ents'), resolve('/p/main.ents')]
    const modules = new Map([
      [lib, 'export func cell() -> *i32 => 8 as *i32\nexport global where: *i32 = 16 as *i32\n'],
      [main, 'import "./lib" (\n  "cell" func cell() -> *i32\n  "where" global where: *i32\n)\nfunc get(p: *i32) -> i32 => p.*\nexport func a() -> i32 => get(&cell())\nexport func b() -> i32 => get(&where)\nexport func c() -> i32 => get(&cell().*)\n'],
    ].map(([path, src]) => [path, { module: parse(src).module as AST.Module, source: src }]))
    expect(typecheckProgram(modules, main).errors.map((e) => e.message)).toEqual([
      "'cell()' is already a pointer (*i32): drop the &",
      "'where' is already a pointer (*i32): drop the &",
    ])
  })

  test('of a pointer in a generic, in the instance whose type is a pointer', () => {
    const errs = typecheck(parse(`
      func g(comptime T: type, x: T) -> T => &x
      func h(comptime T: type, p: *(v: T)) -> *T => &p.v
      func use1(p: *i32) -> *i32 => g(*i32, p)
      func use2(p: *(v: *i32)) -> **i32 => h(*i32, p)
    `).module as AST.Module).errors.map((e) => e.message)
    expect(errs).toEqual(["'x' is already a pointer (*i32): drop the &, in g(T = *i32)"])
  })

  // A cast binds tighter than &: `&x as T` is `&(x as T)`. What was meant
  // is said where x has an address, and only there.
  test('of a cast says what was meant where what is cast has an address', () => {
    const errs = typecheck(parse(`
      type Pt = (x: i32, y: i32)
      func a(base: [*]Pt, k: u32) -> [*]Pt => &base[k] as [*]Pt
      func b(base: [*]Pt, k: u32) -> u32 => &base[k] as u32
      func c(p: [*]u32) -> u32 => &p[1] as u32
      func d(pp: **i32) -> u32 => &pp.* as u32
      func e(p: *Pt) -> *u8 => &p.x as *u8
      func f(m: *[3x4]u8) -> [*]u8 => &m[1] as [*]u8
      func g(a: i32) -> u32 {
        let s: Pt = (a, 2)
        return (&s.x as *u8) as u32
      }
      func h(a: [4]u32) -> u32 => (&a[1] as *u8) as u32
      func i(p: *Pt) -> *u8 => &(p.x as *u8)
      func j(z: *[!]u8) -> [*]u8 => &z[0] as [*]u8
    `).module as AST.Module).errors.map((e) => e.message)
    expect(errs).toEqual([
      'cannot cast Pt to [*]Pt (a cast binds tighter than &: for the address of base[k], write (&base[k]) as [*]Pt)',
      'cannot cast Pt to u32 (a cast binds tighter than &: for the address of base[k], write (&base[k]) as u32)',
      '& requires a literal, a value in memory, or an element of an array, slice or many-pointer (a cast binds tighter than &: for the address of p[1], write (&p[1]) as u32)',
      '& requires a literal, a value in memory, or an element of an array, slice or many-pointer (a cast binds tighter than &: for the address of pp.*, write (&pp.*) as u32)',
      "'p.x as *u8' is already a pointer (*u8): drop the & (a cast binds tighter than &: for the address of p.x, write (&p.x) as *u8)",
      "'m[1] as [*]u8' is already a pointer ([*]u8): drop the & (a cast binds tighter than &: for the address of m[1], write (&m[1]) as [*]u8)",
      "'s.x as *u8' is already a pointer (*u8): drop the &",
      "'a[1] as *u8' is already a pointer (*u8): drop the &",
      "'(p.x as *u8)' is already a pointer (*u8): drop the &",
      "index 0 on *[!]u8 requires 'if let' or '??': its length is only found at run time, by a scan (no optional type for u8)",
    ])
  })

  test('of a string, an array or a tuple literal is as before', () => {
    const result = typecheck(parse(`
      func a() -> u32 {
        let p = &"abc"
        return p.len
      }
      func b() -> u32 => (&"abc":[]u8).len
      func c() -> u32 => (&[1, 2]).len
      func d() -> i32 => (&(1, 2)).0
    `).module as AST.Module)
    expect(result.errors.map((e) => e.message)).toEqual([])
  })

  test('of an element of a *[!]T is refused', () => {
    const errs = typecheck(parse(`
      func a(z: *[!]u8, i: u32) -> ?*u8 => &z[i]
      func b(z: *[!]*u8) -> ?**u8 => &z[0]
    `).module as AST.Module).errors.map((e) => e.message)
    expect(errs).toEqual([
      "cannot take the address of an element of *[!]u8: make a slice of it first, (z.ptr, z.len), and take the address of the slice's element",
      "cannot take the address of an element of *[!]*u8: make a slice of it first, (z.ptr, z.len), and take the address of the slice's element",
    ])
  })

  // At d4bce9e such an address was taken a second time where the operand
  // was inferred again: `&b.id` given to a function of a shared name was a
  // **u32, and refused.
  test('of a place inferred again is taken once', async () => {
    const x = await run(`
      type Pt = (x: i32, y: i32)
      type Node = (id: u32, pos: Pt, next: ?*Node, row: [4]u8)
      memory 1
      func pick(p: *i32) -> u32 => 1
      func pick(p: *u32) -> u32 => 2
      func pick(p: *?*Node) -> u32 => 3
      func pick(p: *Pt) -> u32 => 4
      func pick(p: *[4]u8) -> u32 => 5
      func id(comptime T: type, x: T) -> T => x
      func len2(p: *Pt) -> i32 => p.x * p.x + p.y * p.y
      export func shared(n: u32) -> u32 {
        let b = n as *mut Node
        return pick(&b.pos.x) + pick(&b.id) * 10 + pick(&b.next) * 100 + pick(&b.pos) * 1000 +
          pick(&b.row) * 10000 + pick(&(b as *u32).*) * 100000
      }
      export func generic(n: u32) -> u32 {
        let b = n as *Node
        return ((id(&b.pos.y) as u32) - n) + ((id(&b.next) as u32) - n) * 100 + ((id(&b.row) as u32) - n) * 10000
      }
      export func method(n: u32) -> i32 {
        let b = n as *mut Node
        b.pos = Pt(3, 4)
        return (&b.pos).len2()
      }
    `)
    expect(x.shared(64)).toBe(254321)
    expect(x.generic(64)).toBe(161208)
    expect(x.method(64)).toBe(25)
  })

  test('of a pointer or a slice that lies in memory is where it is', async () => {
    const x = await run(`
      type Node = (val: i32, next: ?*Node, items: []u8, many: [*]u8)
      memory 1
      func link(n: *mut Node) -> *mut ?*Node => &n.next
      func items(n: *Node) -> *[]u8 => &n.items
      func many(n: *Node) -> *[*]u8 => &n.many
      func slot(a: [*]*i32, i: u32) -> **i32 => &a[i]
      func through(pp: **i32) -> **i32 => &pp.*
      func row(p: *[3x4]u8) -> *[4]u8 => &p[1]
      export func next_at(n: u32) -> u32 => link(n as *mut Node) as u32
      export func items_at(n: u32) -> u32 => items(n as *Node) as u32
      export func many_at(n: u32) -> u32 => many(n as *Node) as u32
      export func slot_at(a: u32, i: u32) -> u32 => slot(a as [*]*i32, i) as u32
      export func through_at(pp: u32) -> u32 => through(pp as **i32) as u32
      export func row_at(p: u32) -> u32 => row(p as *[3x4]u8) as u32
      export func store(n: u32, v: u32) -> u32 {
        let cell = link(n as *mut Node)
        cell.* = v as *Node
        return ((n as *Node).next ?? (0 as *Node)) as u32
      }
    `)
    expect(x.next_at(64)).toBe(68)
    expect(x.items_at(64)).toBe(72)
    expect(x.many_at(64)).toBe(80)
    expect(x.slot_at(100, 3)).toBe(112)
    expect(x.through_at(40)).toBe(40)
    expect(x.row_at(200)).toBe(204)
    expect(x.store(64, 1234)).toBe(1234)
  })
})

describe('the wasm names of variables', () => {
  test('a part of a variable is never another variable', async () => {
    const x = await run(`
      type P = (x: i32, y: i32)
      global g: P = P(1, 2)
      global g_x: f64 = 2.5
      export func local() -> f64 {
        let a_x: f64 = 2.5
        let a = P(1, 2)
        return a_x + (a.x as f64)
      }
      export func param(s: []u8) -> u32 {
        let s_ptr = s.ptr
        s_ptr += 1
        return (s_ptr as u32) - (s.ptr as u32)
      }
      export func field(r: P) -> i32 {
        let r_y: i32 = 40
        return r.y + r_y
      }
      export func both() -> f64 {
        g.x += 1
        return g_x + (g.x as f64)
      }
    `)
    expect(x.local()).toBe(3.5)
    expect(x.param(0, 3)).toBe(1)
    expect(x.field(1, 2)).toBe(42)
    expect(x.both()).toBe(4.5)
  })

  test('two parts of one variable named alike are two', async () => {
    // A field x_y, and the field y of a field x: both parts are named t_x_y.
    const source = `
      type In = (y: i32)
      type T = (x: In, x_y: i32)
      type W = (x: In, x_y: f64)
      type P = (x: i32, y: i32)
      import "env" "h" func host(a: P, a_x: f64, w: W) -> i32
      global g: T = T(In(1), 2)
      data ts = [T(In(3), 4), T(In(5), 6)]
      func mk(a: i32, b: i32) -> T => T(In(a), b)
      export func local(a: i32, b: i32) -> i32 {
        let t = mk(a, b)
        return t.x.y * 10 + t.x_y
      }
      export func param(w: W) -> f64 => (w.x.y as f64) + w.x_y
      export func glob() -> i32 => g.x.y * 10 + g.x_y
      export func walk() -> i32 {
        let s = 0
        for t in ts { s += t.x.y * 10 + t.x_y }
        return s
      }
      export func bound(i: u32) -> i32 => if let t = ts[i] { t.x.y * 10 + t.x_y } else { -1 }
    `
    const { default: wabt } = await import('wabt')
    const wasm = (await wabt()).parseWat('test.wat', modWat(source), { multi_value: true, bulk_memory: true })
    wasm.validate()
    const { buffer } = wasm.toBinary({})
    wasm.destroy()
    const { instance } = await WebAssembly.instantiate(buffer, { env: { h: () => 0 } })
    const x = instance.exports as Record<string, (...args: number[]) => unknown>
    expect(x.local(1, 2)).toBe(12)
    expect(x.param(1, 2.5)).toBe(3.5)
    expect(x.glob()).toBe(12)
    expect(x.walk()).toBe(90)
    expect(x.bound(1)).toBe(56)
  })

  // The parts of a value are named in time linear in their count: a global of
  // 65535 bytes took 9.5 seconds, a variable of 49990 six.
  test('the registers of a large value are named as fast as there are many', () => {
    const wat = modWat(`
      global g: [65535]u8
      export func f() -> u8 {
        let x: [49990]u8
        x[49989] = g[65534]
        return x[49989]
      }
    `)
    expect(wat).toContain('(global $g_65534 (mut i32) (i32.const 0))')
    expect(wat).toContain('(local.set $x_49989 (global.get $g_65534))')
  }, 4000)

  test('a name goes to the first variable that asks, and another gets it with a prefix', () => {
    const wat = modWat(`
      type P = (x: i32, y: i32)
      global g: P = P(1, 2)
      global g_x: f64 = 2.5
      export func f(a_x: f64) -> f64 {
        let a = P(1, 2)
        return a_x + (a.x as f64) + g_x
      }
    `)
    expect(wat).toContain('(func $f (param $a_x f64) (result f64)')
    // All the parts of the variable that asked later, so they read as one.
    expect(wat).toContain('(local $_1_a_x i32)\n    (local $_1_a_y i32)')
    expect(wat).toContain('(global $g_x (mut i32) (i32.const 1))')
    expect(wat).toContain('(global $_1_g_x (mut f64) (f64.const 2.5))')
  })

  // What the checker accepts, compiled and run.
  const accepted = async (code: string) => {
    const module = parse(code).module as AST.Module
    expect(typecheck(module).errors.map((e) => e.message)).toEqual([])
    return { x: await run(code), wat: modWat(code) }
  }

  test('if let bindings of one name in turn are variables of their own, whatever their types', async () => {
    const { x } = await accepted(`
      data cells = [7:u32, 8, 9]
      data wides = [1.5, 2.5]
      data names = ["ab", "cde"]
      export func size(i: u32) -> f64 {
        let n: f64 = 0
        if let v = cells[i] {
          n += v as f64
        }
        if let v = wides[i] {
          n += v
        }
        if let v = names[i] {
          n += v.len as f64
        }
        let v: u32 = 100
        return n + (v as f64)
      }
      func sum(p: ?*u32, q: ?*f64) -> f64 {
        let n: f64 = 0
        if let v = p {
          n += v.* as f64
        }
        if let v = q {
          n += v.*
        }
        return n
      }
      export func pointers() -> f64 => sum(&cells[1], &wides[0]) + sum(0, 0)
    `)
    expect(x.size(1)).toBe(113.5)
    expect(x.size(2)).toBe(109)
    expect(x.size(5)).toBe(100)
    expect(x.pointers()).toBe(9.5)
  })

  test('a loop variable is seen in its body only, and its name is free after it', async () => {
    const { x, wat } = await accepted(`
      data bytes = [1:u8, 2, 3]
      data wides = [1.5, 2.5]
      func scale() -> u32 => 10
      export func two_loops() -> f64 {
        let s: f64 = 0
        for v in bytes {
          s += v as f64
        }
        for v in wides {
          s += v
        }
        return s
      }
      export func then_let() -> i64 {
        let t: u32 = 0
        for c in 3 {
          t += c
        }
        let c: i64 = 5000000000
        return c + (t as i64)
      }
      export func in_branch(k: bool) -> f64 {
        let s: f64 = 0
        if k {
          for c in wides {
            s += c
          }
        }
        for c in 2 {
          s += c as f64
        }
        let c: f64 = 0.25
        return s + c
      }
      export func hides() -> u32 {
        let t: u32 = 0
        for scale in 3 {
          t += scale
        }
        return t * scale()
      }
    `)
    expect(x.two_loops()).toBe(10)
    expect(x.then_let()).toBe(5000000003n)
    expect(x.in_branch(1)).toBe(5.25)
    expect(x.in_branch(0)).toBe(1.25)
    expect(x.hides()).toBe(30)
    // Variables of one name and wasm type that are never seen at once
    // share a local; another wasm type takes the next prefix.
    const body = wat.slice(wat.indexOf('(func $in_branch'), wat.indexOf('(func $hides'))
    expect(body.match(/\(local \$(?!__)\w+ \w+\)/g)).toEqual(['(local $s f64)', '(local $c f64)', '(local $_1_c i32)'])
  })

  test('a let without a value does not start as what a variable of its name left', async () => {
    const { x } = await accepted(`
      data cells = [7:u32, 8, 9]
      export func after_loop() -> u32 {
        let t: u32 = 0
        for c in 3 {
          t += c
        }
        let c: u32
        return t * 100 + c
      }
      export func after_branch(i: u32) -> u32 {
        if let v = cells[i] {
          let k: u32 = v
        }
        let k: u32
        return k
      }
      export func pair_after_loop() -> u32 {
        for a in 2 {
        }
        let (a, b): (u32, u32)
        return a + b
      }
    `)
    expect(x.after_loop()).toBe(300)
    expect(x.after_branch(0)).toBe(0)
    expect(x.pair_after_loop()).toBe(0)
  })
})

describe('literals', () => {
  test('-0.0 is minus zero, written as a literal, a def, a global, data or a pattern', async () => {
    const { lit, single, viaDef, inGlobal, inData, pattern } = await run(`
      def z = -0.0
      global g: f64 = -0.0
      data d: *[1]f64 = [-0.0]
      export func lit() -> f64 => 1.0 / -0.0
      export func single() -> f32 => 1.0:f32 / -0.0:f32
      export func viaDef() -> f64 => 1.0 / z
      export func inGlobal() -> f64 => 1.0 / g
      export func inData() -> f64 => 1.0 / d[0]
      export func pattern(x: f64) -> i32 => match x {
        -0.0 => 1
        _ => 0
      }
    `)
    expect([lit(), single(), viaDef(), inGlobal(), inData()]).toEqual(Array(5).fill(-Infinity))
    expect(pattern(0)).toBe(1)
  })
})

describe('a literal in single quotes is codepoints', () => {
  // Each codepoint is the int literal of its value, written there.
  const quoted = `
    def newline = '\\n'
    func take(c: u8) -> u8 => c
    func tag(t: (u8, u8, u8, u8)) -> u32 => (t.0 as u32) * 1000000 + (t.1 as u32) * 10000 + (t.2 as u32) * 100 + t.3
    export func is_a(c: u8) -> bool => c == 'a'
    export func offset(c: u8) -> u8 => c - 'a'
    export func put() -> u8 {
      let b: u8 = 'é'
      return b
    }
    export func give() -> u8 => take('\\x7f')
    export func vowel(c: u8) -> i32 => match c {
      'a', 'e', 'i', 'o', 'u' => 1
      '\\u{e9}', '\\'' => 2
      _ => 0
    }
    export func lower(c: u8) -> bool => c >= 'a' && c <= 'z' || c == newline
    export func pair() -> i32 {
      let (o, k) = 'ok'
      return o * 1000 + k
    }
    export func riff() -> u32 => tag('RIFF')
    export func wide() -> u32 => '😀'
  `
  const numbers = quoted
    .replace("'\\n'", '10').replaceAll("'a'", '97').replace("'é'", '233').replace("'\\x7f'", '127')
    .replace("'e', 'i', 'o', 'u'", '101, 105, 111, 117').replace("'\\u{e9}', '\\''", '233, 39')
    .replace("'z'", '122').replace("'ok'", '(111, 107)').replace("'RIFF'", '(82, 73, 70, 70)').replace("'😀'", '128512')

  test('compile to what their numbers do', () => {
    expect(numbers).not.toContain("'")
    expect(modWat(quoted)).toBe(modWat(numbers))
  })

  test('compare, compute, assign, pass and match as their numbers', async () => {
    const f = await run(quoted)
    expect([f.is_a(97), f.is_a(98), f.offset(100), f.put(), f.give()]).toEqual([1, 0, 3, 233, 127])
    expect([f.vowel(111), f.vowel(233), f.vowel(39), f.vowel(98)]).toEqual([1, 2, 2, 0])
    expect([f.lower(109), f.lower(10), f.lower(65)]).toEqual([1, 1, 0])
    expect([f.pair(), f.riff(), f.wide()]).toEqual([111107, 82737070, 128512])
  })
})

describe('the fallback of ?? given for a const slice', () => {
  test('is a const literal, and the value is the one there is', async () => {
    const source = `
      data buf = mut [1:u8, 2, 3]
      func count(s: []u8) -> u32 => s.len
      func head(s: []u8) -> u8 => s[0] ?? 0
      export func len(i: u32) -> u32 => count(buf[i..] ?? "none")
      export func at(i: u32) -> u8 => head(buf[i..] ?? "none")
    `
    expect(typecheck(parse(source).module!).errors).toEqual([])
    const { len, at } = await run(source)
    expect([len(0), len(2), len(3), len(4), len(9)]).toEqual([3, 1, 0, 4, 4])
    expect([at(0), at(2), at(3), at(4)]).toEqual([1, 3, 0, 110])
  })
})

describe('an escape in a string', () => {
  test('\\xHH is that byte, \\u{H..} the UTF-8 bytes of that character', async () => {
    const { at } = await run(`
      data s = "\\xE9\\u{e9}\\u{1F600}\\x41"
      export func at(i: u32#8) -> u8 => s[i]
    `)
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => at(i))).toEqual([0xe9, 0xc3, 0xa9, 0xf0, 0x9f, 0x98, 0x80, 0x41])
  })

  test('so in a template literal', async () => {
    const { first, len } = await run(`
      func first-of(t: [][]u8) -> u8 => if let s = t[0] { s[0] ?? 0 } else { 0 }
      func len-of(t: [][]u8) -> u32 => if let s = t[0] { s.len } else { 0 }
      export func first() -> u8 => first-of(\`\\xFF\`)
      export func len() -> u32 => len-of(\`\\xFF\\u{e9}\`)
    `)
    expect([first(), len()]).toEqual([0xff, 3])
  })
})

describe('a string with no type to meet', () => {
  test('is laid out wherever its value is used', async () => {
    const f = await run(`
      data buf = mut [0:u8; 8]
      export func untyped() -> u8 { let s = "ABCD"
        return s[0] }
      export func branch(c: bool) -> u8 { let s = if c { "AB" } else { "CD" }
        return s[0] }
      export func arm(c: u32) -> u8 { let s = match c { 0 => "AB" _ => "CD" }
        return s[0] }
      export func grouped() -> u8 { let s = ("EF")
        return s[0] }
      export func field() -> u8 { let t = ("GH", 1)
        return t.0[0] }
      export func index() -> u8 => "LMN"[1]
      export func ranged() -> u8 { buf[0..4] = "OPQR"
        return buf[1] }
      export func deref() -> u8 { let a = "WX".*
        return a[1] }
    `)
    const got = ['untyped', 'branch', 'arm', 'grouped', 'field', 'index', 'ranged', 'deref'].map((name) => f[name](0))
    expect(got.map((c) => String.fromCharCode(c as number))).toEqual(['A', 'C', 'A', 'E', 'G', 'M', 'P', 'X'])
  })

  test('an empty one is there, at an address that is not none', async () => {
    // Address 0 is none for an optional pointer or slice; an empty literal
    // had it, so `""` given for a ?[]u8 read as none.
    const { a, b, c, d } = await run(`
      data nothing: *[0]u8 = []
      func has(s: ?[]u8) -> i32 => if let t = s { 1 } else { 0 }
      func hasm(s: ?[]mut u8) -> i32 => if let t = s { 1 } else { 0 }
      func hasp(p: ?*[0]u8) -> i32 => if let q = p { 1 } else { 0 }
      export func a() -> i32 => has("")
      export func b() -> i32 => hasm(mut "")
      export func c() -> i32 {
        let e: []mut u8 = mut []
        return hasm(e)
      }
      export func d() -> i32 => hasp(nothing)
    `)
    expect([a(), b(), c(), d()]).toEqual([1, 1, 1, 1])
  })

  test('mut makes it a writable copy of its own', async () => {
    const { write, same } = await run(`
      export func write() -> u8 {
        let p = mut "UV"
        p[0] = 7
        return p[0]
      }
      export func same() -> u8 {
        let q = "UV"
        return q[0]
      }
    `)
    expect([write(), same()]).toEqual([7, 85])
  })
})

describe('a mut literal given for a mutable pointer or slice', () => {
  test('is a copy of its own', async () => {
    const { run: go } = await run(`
      data c: []i32 = [20, 8]
      data s: []mut i32 = mut [20, 8]
      data u: *mut [_]i32 = mut [20, 8]
      data t: *mut [2][2]i32 = mut [[1, 2], [1, 2]]
      data cstr = "hi"
      data str: []mut u8 = mut "hi"
      func fill(buf: []mut u8, v: u8) -> []u8 {
        if let e = &buf[0] { e.* = v }
        return buf
      }
      export func run() -> i32 {
        if let e = &s[0] { e.* = 5 }
        u[1] = 7
        t[0][0] = 9
        if let e = &str[0] { e.* = 1 }
        let a = fill(mut [0:u8; 2], 3)
        let b = fill(mut [0:u8; 2], 4)
        let p: *mut [2]i32 = mut [20, 8]
        p[0] = 6
        return (c[0] ?? 0) * 1000000 + (c[1] ?? 0) * 10000 + t[1][0] * 1000 + (cstr[0] as i32) + ((a[0] ?? 0) as i32) * 10 + ((b[0] ?? 0) as i32) * 100
      }
    `)
    // c is untouched, t's rows are two, cstr is "h", a and b are two buffers
    expect(go()).toBe(20081000 + 104 + 30 + 400)
  })

  test('so is each element of a slice of mutable slices, and each row of a mutable pointer to framed arrays', async () => {
    // Each element written with mut, or all of them under the mut of the literal they are in.
    const { run: go } = await run(`
      data c = "ab"
      data cc: *[2]u8 = [1, 2]
      data p: *mut [2][!]u8 = mut ["ab", "ab"]
      data q: *[2][]mut u8 = [mut "ab", mut "ab"]
      data r: [][]mut u8 = mut [[1, 2], [1, 2]]
      export func run(v: u8) -> u32 {
        if let a = p[0] {
          let w = a as [*]mut u8
          w[0] = v
        }
        if let e = &q[0][0] { e.* = v }
        if let b = r[0] { if let e = &b[0] { e.* = v } }
        let s: [][]mut u8 = [mut [1, 2], mut [1, 2]]
        if let d = s[0] { if let e = &d[0] { e.* = v } }
        let rows = (if let e = r[1] { e[0] ?? 0 } else { 0 }) * 10 + (if let f = s[1] { f[0] ?? 0 } else { 0 })
        return (c[0] as u32) * 100000 + (cc[0] as u32) * 10000 + ((q[1][0] ?? 0) as u32) * 100 + (rows as u32)
      }
    `)
    // c, cc, q's second row, r's and s's second rows are as written
    expect(go(9)).toBe(9700000 + 10000 + 9700 + 11)
  })
})

describe('values of literals laid out in memory', () => {
  test('a constant expression in data is its value, in a list, a table or a generic', async () => {
    const f = await run(`
      def k = 4
      data xs: *[3]i32 = [1 + 1, k * 2, -3]
      data ys: *[4]u32 = [sizeof(u16), k + 1, 1 << 3, ~0]
      data tt: *[2][2]u32 = [[sizeof(u64), k * 2], [~0, 3]]
      data fs: *[2]f32 = [1 / 4, k * 0.5]
      func Pair(comptime A: type, comptime B: type) -> type => (first: A, second: B)
      func gen(comptime T: type) -> u32 {
        let m: *[2][2]u32 = [[sizeof(T), 1], [2, sizeof(Pair(T, T))]]
        return m[0][0] * 100 + m[1][1]
      }
      export func list() -> i32 => xs[0] * 100 + xs[1] * 10 + xs[2]
      export func words() -> u32 => ys[0] * 1000 + ys[1] * 100 + ys[2]
      export func all() -> u32 => ys[3]
      export func table() -> u32 => tt[0][0] * 100 + tt[0][1] * 10 + tt[1][1]
      export func ones() -> u32 => tt[1][0]
      export func floats() -> f32 => fs[0] + fs[1]
      export func generic() -> u32 => gen(u16) * 1000 + gen(u64)
    `)
    expect([f.list(), f.words(), (f.all() as number) >>> 0, f.table(), (f.ones() as number) >>> 0, f.floats(), f.generic()])
      .toEqual([277, 2508, 0xffffffff, 883, 0xffffffff, 2.25, 204816])
  })

  test('the name of other data in a field is its address, and for a slice its length', async () => {
    const f = await run(`
      type Ref = (p: *[3]i32, k: u32)
      type View = (s: []i32, k: u32)
      data ones: *[3]i32 = [1, 1, 1]
      data twos: *[3]i32 = [2, 2, 2]
      data refs: *[2]Ref = [(ones, 5), Ref(twos, 6)]
      data views: *[1]View = [(twos, 7)]
      data names: [][]i32 = [ones, twos]
      export func a() -> u32 => (refs[0].p as u32) * 1000 + refs[0].k
      export func b() -> u32 => (refs[1].p as u32) * 1000 + refs[1].k
      export func c() -> i32 => refs[1].p[2] * 100 + (views[0].s[1] ?? 0) * 10 + (views[0].s.len as i32)
      export func d() -> u32 => (ones as u32) * 1000 + (twos as u32)
      export func e() -> i32 => if let s = names[1] { (s[0] ?? 0) * 10 + (s.len as i32) } else { 0 }
      export func local() -> i32 {
        let r: *[1]Ref = [(twos, 9)]
        return r[0].p[0] * 10 + (r[0].k as i32)
      }
    `)
    const [ones, twos] = [Math.floor((f.d() as number) / 1000), (f.d() as number) % 1000]
    expect([f.a(), f.b(), f.c(), f.e(), f.local()]).toEqual([ones * 1000 + 5, twos * 1000 + 6, 223, 23, 29])
  })

  test('a repeat count written as a constant expression is its value', async () => {
    // The data packer threw "RepeatExpr count must be an int literal", and a
    // repeat in registers had no values.
    const { f, g } = await run(`
      def k = 4
      data a = mut [0:u8; k]
      data b: *[4]u8 = [1; 2 + 2]
      export func f() -> u32 => a.len * 10 + (b[3] as u32)
      export func g(x: i32) -> i32 {
        let v: [4]i32 = [x; k]
        let p: *[4]i32 = [x + 1; 2 * 2]
        return v[3] * 10 + p[3]
      }
    `)
    expect([f(), g(5)]).toEqual([41, 56])
  })

  test('a repeat whose element is a slice is that many slices', async () => {
    // The data packer threw "Expected ArrayExpr for separate brackets, got
    // RepeatExpr" for these on 0.2.1.
    const { counts, local } = await run(`
      data d: [][]u8 = [[1; 2]; 3]
      data e: *[3][]u8 = [[1, 2]; 3]
      data f: [][]u8 = ["ab"; 3]
      export func counts() -> u32 => d.len * 1000 + (d[2] ?? "").len * 100 + (e[1].len) * 10 + f.len
      export func local(n: u32) -> u32 {
        let x: []u8 = "abc"
        let a: *[3][]u8 = [x; 3]
        let s: [][]u8 = [x; 2]
        return a[2].len * 100 + s.len * 10 + (if let r = s[n] { r.len } else { 0 })
      }
    `)
    expect([counts(), local(1), local(5)]).toEqual([3223, 323, 320])
  })

  test('a literal with values only known at run time is a cell of its own', async () => {
    const { two, packed } = await run(`
      export func two(x: i32, y: i32) -> i32 {
        let a: *[2]i32 = [x, 2]
        let b: *[2]i32 = [y, 2]
        let c: *[2]i32 = [1 + 1, 2]
        return a[0] * 100 + b[0] * 10 + c[0]
      }
      export func packed(x: i32) -> i32 {
        let p: *[2x2]i32 = [[x, 1], [2, x + 1]]
        let q: *[2x3]i32 = [[x; 3], [7; 3]]
        return p[0][0] * 10000 + p[0][1] * 1000 + p[1][1] * 100 + q[0][2] * 10 + q[1][1]
      }
    `)
    expect([two(3, 4), packed(5)]).toEqual([342, 51657])
  })

  test('an element of an array of pointers given a literal is the address of that literal', async () => {
    // Each was laid out in place, as if the type were *[2][2]i32: pa[1][0]
    // read 167772160, and a run-time element was stored past the cell.
    const f = await run(`
      data ones: *[3]i32 = [1, 1, 1]
      data pa: *[2]*[2]i32 = [[1, 2], [3, 4]]
      data pn: *[2]*[3]i32 = [ones, [7, 1 + 1, 9]]
      data ps: *[2][*]u8 = ["ab", "cd"]
      data pm: *[2]*mut [2]i32 = [mut [1, 2], mut [1, 2]]
      export func a() -> i32 => pa[0][1] * 10 + pa[1][0]
      export func b() -> i32 => pn[0][2] * 100 + pn[1][1] * 10 + pn[1][2]
      export func c() -> u8 => ps[1][1]
      export func d() -> i32 {
        pm[0][0] = 9
        return pm[1][0] * 10 + pa[0][0]
      }
      export func e(x: *[2]i32) -> i32 {
        let p: *[3]*[2]u8 = ["AB", [7; 2], "CD"]
        let q: *[2]*[2]i32 = [[5, 6], x]
        return (p[2][1] as i32) * 1000 + (p[1][0] as i32) * 100 + q[0][1] * 10 + q[1][0]
      }
      export func pa1() -> *[2]i32 => pa[1]
    `)
    const pa1 = f.pa1() as number
    expect([f.a(), f.b(), f.c(), f.d(), f.e(pa1)]).toEqual([23, 129, 100, 11, 68000 + 700 + 60 + 3])
  })

  test('a parameter named like data is not that data', async () => {
    // The values of a literal are worked out at the end of the function,
    // when its names are out of scope: these read as the module's data.
    // (A binding cannot be named like data: see checker.test.)
    const f = await run(`
      type R = (p: *[3]i32, n: u32)
      data ones: *[3]i32 = [1, 1, 1]
      data twos: *[3]i32 = [2, 2, 2]
      data many: [][]i32 = [twos, twos]
      func param(ones: *[3]i32) -> i32 {
        let held: *[1]*[3]i32 = [ones]
        let r: *[1]R = [(ones, 1)]
        return held[0][0] * 10 + r[0].p[1]
      }
      func binding(o: ?*[3]i32) -> i32 {
        if let one = o {
          let held: *[1]*[3]i32 = [one]
          return held[0][2]
        }
        return 0
      }
      func slices(ones: []i32) -> u32 {
        let held: [][]i32 = [ones, ones]
        return if let r = held[1] { r.len } else { 0 }
      }
      export func a() -> i32 => param(twos)
      export func b() -> i32 => binding(twos)
      export func c() -> u32 => slices(twos[0..2])
      export func d() -> i32 {
        let t: i32 = 0
        for one in many {
          let held: [][]i32 = [one]
          t = t + (if let r = held[0] { r[0] ?? 0 } else { 0 })
        }
        return t
      }
    `)
    expect([f.a(), f.b(), f.c(), f.d()]).toEqual([22, 2, 2, 4])
  })
})

describe('data larger than memory', () => {
  test('is an error, not addresses past what an i32 holds', () => {
    // Zeros cost nothing to lay out, so nothing stopped data that no wasm
    // memory holds: c's address was written as (i32.const 5000000008).
    expect(() => modWat('data a = mut [0:u8; 3000000000]\ndata b = mut [0:u8; 2000000000]\ndata c = [7:u8, 8]')).toThrow(
      'the data takes 5000000010 bytes of memory, more than the 4294967296 (4 GiB) a wasm memory can hold',
    )
    // 4 GiB to the byte is what a memory holds.
    expect(modWat('data a = mut [0:u8; 4294967287]\ndata c = [7:u8]\nexport func f() -> u8 => c[0]')).toContain('(memory 65536)')
  })
})

describe('a value in memory', () => {
  test('is not counted out in registers to reach a member of it', () => {
    // p.a[1] is an array in memory, 2^29 values were it held: working out which
    // of them p.a[1][0] would be ran out of memory, where it is only an address.
    const at = Array.from({ length: 30 }, (_, i) => (i % 2 ? '[0]' : '[1]')).join('')
    const wat = modWat(`type S = (b: u8, a: ${'[2]'.repeat(30)}u8)\nexport func f(p: *S) -> u8 => p.a${at}`)
    // b, then 1 at each even level: 1 + 2^29 + 2^27 + ... + 2^1
    expect(wat).toContain('(i32.load8_u (i32.add (local.get $p) (i32.const 715827883)))')
  })
})

describe('a constant expression as the index of a value array', () => {
  // The checker proves the index of a value array with any constant, and
  // codegen picks the element by the value the checker worked out. Before,
  // only a literal was read here, and each of these threw in codegen.
  const twinOf = (source: string, constant: string) => {
    expect(modWat(source.replaceAll('INDEX', constant))).toBe(modWat(source.replaceAll('INDEX', '2')))
  }
  test('read from an array held in registers', () => {
    const f = 'export func f(x: f64) -> f64 {\n  let v: [3]f64 = [x, 2.0, x * 3.0]\n  return v[INDEX]\n}'
    expect(modWat(f.replace('INDEX', '1 + 1'))).toContain('(local.get $v_2)')
    for (const index of ['1 + 1', '(2)', '((2))', '3 - 1', '2:u32', 'k - 1', 'two', 'sizeof(u16)']) {
      twinOf(`def k = 3\n${f}\ndef two = 2`, index)
    }
  })
  test('a field of a struct in registers and in memory', () => {
    twinOf('type Buf = (len: u32, items: [3]u8)\nexport func f(b: Buf) -> u8 => b.items[INDEX]', '1 + 1')
    twinOf('type Buf = (len: u32, items: [3]u8)\nexport func f(b: *Buf) -> u8 => b.items[INDEX]', '1 + 1')
    twinOf('type Buf = (len: u32, items: [3]u8)\ndata held: Buf = (3, [1, 2, 3])\nexport func f() -> u8 => held.items[INDEX]', '(2)')
  })
  test('a store', () => {
    twinOf('export func f() -> u32 {\n  let w: [3]u32 = [1, 2, 3]\n  w[INDEX] = 7\n  return w[2]\n}', '1 + 1')
    twinOf('type Buf = (len: u32, items: [3]u8)\nexport func f(b: *mut Buf) { b.items[INDEX] = 9 }', '1 + 1')
  })
})

describe('the functions and exports of tests', () => {
  // Each test is a function exported as test: and its name, which no export
  // of the module can begin with, and its function and those it declares
  // have names in the WAT that no function of the module can have.
  const runTests = async (source: string, others?: Record<string, string>) => (await import('./test-utils')).runTestsOfSource(source, others)

  test('a module function or export named as the test build names a test', async () => {
    expect(await runTests(`
      func test_xor() -> u32 => 1
      export func test_and() -> u32 => 2
      export "test_or" func g() -> u32 => 3
      func test_a_b() -> u32 => 4
      import "env" "test_host" func test_host() -> u32
      func test_two(x: u32) -> u32 => x
      func test_two(x: u64) -> u32 => 6
      func test_id(comptime T: type, x: T) -> T => x
      test "xor" { assert test_xor() == 1 }
      test "and" { assert test_and() == 2 }
      test "or" { assert g() == 3 }
      test "a b" { assert test_a_b() == 4 }
      test "host" { assert test_two(5:u64) == 6 }
      test "two" { assert test_id(u8, 7) == 7 }
    `)).toEqual({ ran: ['xor', 'and', 'or', 'a b', 'host', 'two'], failed: [] })
  })

  test('the functions tests declare are told apart, whatever the names of the tests', async () => {
    // test "a" with b_f, test "a_b" with f; a group and a test of one name;
    // a test without a name that declares what its group does.
    expect(await runTests(`
      test "a" {
        func b_f() -> u32 => 1
        assert b_f() == 1
      }
      test "a_b" {
        func f() -> u32 => 2
        assert f() == 2
      }
      test "g" {
        func h() -> u32 => 3
        test {
          func h() -> u32 => 3
        }
        test "x" { assert h() == 3 }
      }
      test "g" {
        func h() -> u32 => 3
        assert h() == 3
      }
    `)).toEqual({ ran: ['a', 'a_b', 'g > x', 'g'], failed: [] })
    // A function without a name is left out, as at module level.
    expect(await runTests(`
      test "a" {
        func(x: u32) -> u32 => x
        func(x: u32) -> u32 => x + 1
        assert true
      }
    `)).toEqual({ ran: ['a'], failed: [] })
  })

  test('what tests import is told apart from the module and from other tests', async () => {
    // A host function or global a test imports is named in the WAT under
    // the test, beside a module function of its name and the same import in
    // another test or group; a global's parts are named apart, as a module
    // global's are. A function a test imports from another module is that
    // module's, whatever the test calls it, and leaves the module's function
    // of that name to the module.
    const lib = 'export func one() -> u32 => 1\nexport global five: u32 = 5\n'
    expect(await runTests(`
      func f() -> u32 => 2
      func one() -> u32 => 3
      export func g() -> u32 => f() + one()
      test "a" {
        import "env" "f" func f() -> u32
        import "env" "p" global p: (x: u32, y: u32)
        import "env" "p_x" global p_x: u32
        assert g() == 5
        assert p.x == 0 && p_x == 0
      }
      test "b" {
        import "env" "f" func f() -> u32
        import "env" "p" global p: (x: u32, y: u32)
        assert p.y == 0
      }
      test "c" {
        import "env" "f" func f() -> u32
        test "x" { assert true }
        test "y" { assert f() == 0 }
      }
      test "d" {
        import "./lib" ( "one" func one() -> u32 )
        assert one() == 1
        assert g() == 5
      }
      test "e" {
        import "./lib" (
          "one" func uno() -> u32
          "five" global five: u32
        )
        assert uno() == 1 && five == 5
      }
    `, { 'lib.ents': lib })).toEqual({ ran: ['a', 'b', 'c > x', 'c > y', 'd', 'e'], failed: ['c > y'] })
  })

  test('the test build exports each test as test: and its name', async () => {
    const { mkdtemp, writeFile, rm } = await import('fs/promises')
    const { tmpdir } = await import('os')
    const { join } = await import('path')
    const { loadModule } = await import('./loader')
    const { typecheckProgram } = await import('./checker')
    const { programToWatWithTests } = await import('./codegen')
    const dir = await mkdtemp(join(tmpdir(), 'ents-'))
    try {
      const file = join(dir, 'names.ents')
      await writeFile(file, 'export func f() -> u32 => 1\ntest "a square" { assert true }\ntest "rectangles" {\n  test "one row" { assert true }\n}\ntest "a-z" { assert true }\ntest "two\\nlines" { assert true }\ntest "\\u{1F600}" { assert true }\n')
      const load = await loadModule(file, { includeTests: true })
      const check = typecheckProgram(load.modules, file, { includeTests: true })
      const { wat, testExports, testTitles } = programToWatWithTests(load.modules, check.results, file)
      // A character is a code point, and a line end in a name ends no line of the WAT.
      expect(testExports).toEqual(['test:a_square', 'test:rectangles__one_row', 'test:a_z', 'test:two_lines', 'test:_'])
      expect(testTitles).toEqual(['a square', 'rectangles > one row', 'a-z', 'two\nlines', '\u{1F600}'])
      // A host that runs the tests itself finds them in the order to run them.
      const { wasmOfWat } = await import('./test-utils')
      const exported = WebAssembly.Module.exports(await WebAssembly.compile(await wasmOfWat(wat))).map((e) => e.name)
      expect(exported.filter((name) => name.startsWith('test:'))).toEqual(testExports)
      expect(exported).toContain('f')
    } finally {
      await rm(dir, { recursive: true })
    }
  })
})
