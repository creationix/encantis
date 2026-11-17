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

// === Module Codegen Tests ===

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
