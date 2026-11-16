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

    test('logical right shift always uses shr_u', () => {
      const wat = funcWat('func shr(a: i32, b: i32) -> i32 => a >>> b')
      expect(wat).toContain('i32.shr_u')
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
