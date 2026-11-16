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
    expect(wat).toContain('(i32.store (local.get $p) (i32.load (local.get $q)))')
    expect(wat).toContain('(i32.store offset=8 (local.get $p) (i32.load offset=8 (local.get $q)))')
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

  test('a copy between two places goes field by field', () => {
    const body = bodyOf(`${SPOT}
      func copy(a: [*]mut Spot, i: u32, j: u32) { a[i] = a[j] }
    `, 'copy')
    expect(body).toEqual([
      '(i32.store (local.tee $__tmp_1 (i32.add (local.get $a) (i32.mul (local.get $i) (i32.const 12)))) (i32.load (local.tee $__tmp_0 (i32.add (local.get $a) (i32.mul (local.get $j) (i32.const 12))))))',
      '(i32.store offset=4 (local.get $__tmp_1) (i32.load offset=4 (local.get $__tmp_0)))',
      '(i32.store offset=8 (local.get $__tmp_1) (i32.load offset=8 (local.get $__tmp_0)))',
    ])
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

  test('scalar and slice accesses keep their form', () => {
    const wat = modWat(`${SPOT}
      func f(xs: [*]mut i32, lists: [*]mut []i32, i: u32, s: []i32) -> u32 {
        xs[i] = 5
        xs[i] += 1
        lists[i] = s
        let t = lists[i]
        lists[i + 1] = lists[i]
        return lists[i].len + t.len
      }
    `)
    const lists = '(i32.add (local.get $lists) (i32.mul (local.get $i) (i32.const 8)))'
    const after = '(i32.add (local.get $lists) (i32.mul (i32.add (local.get $i) (i32.const 1)) (i32.const 8)))'
    const xs = '(i32.add (local.get $xs) (i32.mul (local.get $i) (i32.const 4)))'
    expect(wat).toContain(`(i32.store ${xs} (i32.const 5))`)
    expect(wat).toContain(`(i32.store ${xs} (i32.add (i32.load ${xs}) (i32.const 1)))`)
    expect(wat).toContain(`(i32.store ${lists} (local.get $s_ptr))\n    (i32.store offset=4 ${lists} (local.get $s_len))`)
    expect(wat).toContain(`(local.set $t_ptr (i32.load ${lists}))\n    (local.set $t_len (i32.load offset=4 ${lists}))`)
    expect(wat).toContain(`(i32.store ${after} (i32.load ${lists}))\n    (i32.store offset=4 ${after} (i32.load offset=4 ${lists}))`)
    expect(wat).toContain(`(i32.add (i32.load offset=4 ${lists}) (local.get $t_len))`)
    expect(wat).not.toContain('$__tmp')
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

  test('a slice on the stack keeps its own form', () => {
    const wat = modWat(`
      data space = mut [0:u8; 16]
      func pair() -> []i32 => ((space as [*]i32), 2:u32)
      func len() -> u32 => pair().len
      func second() -> i32 => pair()[1]
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
