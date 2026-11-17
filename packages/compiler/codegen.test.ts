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
    const testFunc = wat.slice(wat.indexOf('(func $test_cleanup'))
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
      export func shadow(n: u32) -> u32 {
        let t: u32 = 0
        for i in n {
          t += 1
          for n in 1 { t += 0 }
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
    `
    const { call, local, shadow, glob, steady } = await run(code)
    expect([call(), local(5), shadow(4), glob(), steady(4)]).toEqual([104, 5, 4, 3, 6])
    // A variable the body doesn't change is read where it is compared.
    expect(modWat(code)).toContain('(br_if $break (i32.ge_u (local.get $i) (local.get $n)))')
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
      data cells: *mut [2]Point = [Point(0, 0), Point(0, 0)]
      data threes: *mut [2]P3 = [P3(0, 0, 0), P3(0, 0, 0)]
      data names: *mut [2][]u8 = ["", ""]
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
      data cells: *mut [1]Point = [Point(0, 0)]
      data threes: *mut [1]P3 = [P3(0, 0, 0)]
      data names: *mut [1][]u8 = [""]
      data pairs: *mut [1][2]i32 = [[0, 0]]
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
        board[0..2] = grid[0..2]
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
})

describe('structs in data arrays', () => {
  test('constant tuples and constructors are laid out in the data section', () => {
    const wat = modWat(`
      type Point = (x: i32, y: i32)
      data pairs = [(1, 2), (3, 4)]
      data points: *[2]Point = [Point(x: 5, y: 6), Point(y: 8, x: 7)]
      data mixed = [(1:u8, 2:i16, 3:u64)]
    `)
    expect(wat).toContain('"\\01\\00\\00\\00\\02\\00\\00\\00\\03\\00\\00\\00\\04\\00\\00\\00"')
    // A constructor can name its fields in any order.
    expect(wat).toContain('"\\05\\00\\00\\00\\06\\00\\00\\00\\07\\00\\00\\00\\08\\00\\00\\00"')
    expect(wat).toContain('"\\01\\02\\00\\03\\00\\00\\00\\00\\00\\00\\00"')
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

  test('a tuple gives its fields by position, in data as in a variable', async () => {
    const { f } = await run(`
      type Point = (x: i32, y: i32)
      data points: *[1]Point = [(y: 8, x: 7)]
      export func f(a: i32) -> i32 {
        let p: Point = (y: 8, x: 7)
        let local: *[1]Point = [(y: a, x: 7)]
        return p.x + points[0].x * 10 + local[0].x * 100
      }
    `)
    expect(f(8)).toBe(888)
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
})
