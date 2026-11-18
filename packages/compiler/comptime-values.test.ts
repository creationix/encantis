// Comptime value parameters, `comptime n: u32`, and the types written with
// them, `[n]T` and `u32#n`. The language rules are reference 8.7; the cases
// users are meant to read, one for each error, are in spec/generics.md under
// "Value parameters". These tests pin what those do not: that each instance
// is the function written by hand (the pairs of tests/values), the names and
// identity of instances, programs of several modules, the editor, and the
// grammar.

import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import type * as AST from './ast'
import { parse } from './parser'
import { typecheck, typecheckProgram } from './checker'
import { programToWat } from './codegen'
import { loadModule } from './loader'
import { hover, hoverText, findReferences, type HoverResult } from './queries'
import { compileToWasm, runTestsOfSource, wasmOfWat, watOfSource } from './test-utils'

const valuesDir = join(import.meta.dir, 'tests/values')
const libDir = resolve(import.meta.dir, '../../lib')

function check(source: string) {
  const parsed = parse(source)
  expect(parsed.errors.map((e) => e.message)).toEqual([])
  return { module: parsed.module as AST.Module, result: typecheck(parsed.module as AST.Module) }
}

const errorsOf = (source: string) => check(source).result.errors.map((e) => e.message)

// The instances a module makes, sorted. The module must check.
function instancesOf(source: string): string[] {
  const { result } = check(source)
  expect(result.errors.map((e) => e.message)).toEqual([])
  return result.instances.map((i) => i.decl.ident as string).sort()
}

// The names of the functions of a module, in the order of the output
const funcs = (wat: string) => [...wat.matchAll(/^\s*\(func \$(\S+)/gm)].map((m) => m[1])

// No table and no indirect call: nothing of a value parameter is left at run time
function expectPlainWasm(wat: string): void {
  for (const word of ['call_indirect', '(table', '(elem', 'ref.func', 'funcref']) expect(wat).not.toContain(word)
}

// The generic module and the hand-written one compile to the same .wasm,
// through the assembler of one module and through the program's.
async function expectSameWasm(generic: string, byHand: string): Promise<number> {
  const [watG, watH] = [watOfSource(generic), watOfSource(byHand)]
  expectPlainWasm(watG)
  const [wasmG, wasmH] = [await wasmOfWat(watG), await wasmOfWat(watH)]
  expect(Buffer.from(wasmG).equals(Buffer.from(wasmH))).toBe(true)
  const dir = await mkdtemp(join(tmpdir(), 'encantis-values-'))
  try {
    await writeFile(join(dir, 'generic.ents'), generic)
    await writeFile(join(dir, 'byhand.ents'), byHand)
    const programG = await compileToWasm(join(dir, 'generic.ents'))
    const programH = await compileToWasm(join(dir, 'byhand.ents'))
    expect(Buffer.from(programG).equals(Buffer.from(wasmG))).toBe(true)
    expect(Buffer.from(programH).equals(Buffer.from(wasmG))).toBe(true)
  } finally {
    await rm(dir, { recursive: true })
  }
  return wasmG.length
}

// The declarations of a library file as they are written there, without
// `export`: its generic types and functions, but for those named in `skip`.
async function libraryDecls(file: string, skip: readonly string[]): Promise<string> {
  const source = await readFile(join(libDir, file), 'utf8')
  const parsed = parse(source)
  expect(parsed.errors).toEqual([])
  const texts: string[] = []
  for (const decl of (parsed.module as AST.Module).decls) {
    const item = decl.kind === 'ExportDecl' ? decl.item : decl
    if (item.kind !== 'FuncDecl' && item.kind !== 'TypeFuncDecl') continue
    if (skip.includes(item.ident as string)) continue
    texts.push(source.slice(item.span.start, item.span.end))
  }
  return `${texts.join('\n')}\n`
}

describe('zero cost: each instance is the function written by hand for its number', () => {
  test('every pair of tests/values', async () => {
    const files = (await readdir(valuesDir)).filter((f) => f.endsWith('.generic.ents')).sort()
    expect(files.length).toBeGreaterThanOrEqual(13)
    for (const file of files) {
      const name = file.slice(0, -'.generic.ents'.length)
      const generic = await readFile(join(valuesDir, file), 'utf8')
      const byHand = await readFile(join(valuesDir, `${name}.twin.ents`), 'utf8')
      try {
        await expectSameWasm(generic, byHand)
        if (/^test /m.test(generic)) expect((await runTestsOfSource(generic)).failed).toEqual([])
      } catch (e) {
        throw new Error(`${name}: ${e instanceof Error ? e.message : e}`)
      }
    }
  })

  // The library's functions as lib/ writes them, instantiated as a program
  // that uses them would, against the instances written by hand. None of
  // them checks an index at run time: each is proven by the capacity.
  for (const [pair, file, skip] of [
    ['14-fixedvec', 'fixedvec.ents', []],
    ['15-ring', 'ring.ents', []],
    ['16-bits', 'bits.ents', []],
  ] as const) {
    test(`lib/${file}`, async () => {
      const generic = (await libraryDecls(file, skip)) + (await readFile(join(valuesDir, `${pair}.uses.ents`), 'utf8'))
      const byHand = await readFile(join(valuesDir, `${pair}.twin.ents`), 'utf8')
      await expectSameWasm(generic, byHand)
    })
  }

  // A program that imports a library file, as programs do, against the same
  // program with the instances written by hand in a module of its own. What
  // the file holds besides its generics (data, imports, plain functions)
  // would be in the first and not in the second, and the program's own data
  // would no longer be at the first address data takes.
  for (const [file, uses, lib, byHand] of [
    [
      'bits',
      '"set_bit" func set_bit(comptime w: u32, b: *mut [w]u32, i: u32#(w * 32))\n  "has_bit" func has_bit(comptime w: u32, b: *[w]u32, i: u32#(w * 32)) -> bool',
      'data mine = mut [0:u32; 2]\nexport func a(k: u32) -> bool {\n  mine.set_bit(k & 63)\n  return mine.has_bit(k & 63)\n}\n',
      ['"set_bit_2" func set_bit_2(b: *mut [2]u32, i: u32#64)\n  "has_bit_2" func has_bit_2(b: *[2]u32, i: u32#64) -> bool',
        'export func set_bit_2(b: *mut [2]u32, i: u32#64) {\n  b[i >> 5] |= 1 << (i & 31)\n}\nexport func has_bit_2(b: *[2]u32, i: u32#64) -> bool => ((b[i >> 5] >> (i & 31)) & 1) == 1\n',
        'data mine = mut [0:u32; 2]\nexport func a(k: u32) -> bool {\n  set_bit_2(mine, k & 63)\n  return has_bit_2(mine, k & 63)\n}\n'],
    ],
    [
      'ring',
      '"Ring" func Ring(comptime n: u32#2147483649, comptime T: type) -> type\n  "push" func push(comptime n: u32, comptime T: type, r: *mut Ring(n, T), x: T)',
      'data mine = mut [0:u32; 4]\ndata r: Ring(4, u32) = mut (0, 0, mine)\nexport func a(x: u32) { r.push(x) }\n',
      ['"push_4" func push_4(r: *mut R4, x: u32)',
        'type R4 = (head: u32#4, count: u32, items: *mut [4]u32)\nexport func push_4(r: *mut R4, x: u32) {\n  r.items[(r.head + r.count) % 4] = x\n  if r.count < 4 {\n    r.count += 1\n  } else {\n    r.head = (r.head + 1) % 4\n  }\n}\n',
        'data mine = mut [0:u32; 4]\ndata r: R4 = mut (0, 0, mine)\nexport func a(x: u32) { push_4(r, x) }\n'],
    ],
    [
      'fixedvec',
      '"FixedVec" func FixedVec(comptime n: u32, comptime T: type) -> type\n  "push" func push(comptime n: u32, comptime T: type, v: *mut FixedVec(n, T), x: T) -> bool',
      'data mine = mut [0:u64; 4]\ndata v: FixedVec(4, u64) = mut (0, mine)\nexport func a(x: u64) -> bool => v.push(x)\n',
      ['"push_4" func push_4(v: *mut F4, x: u64) -> bool',
        'type F4 = (len: u32#5, buf: *mut [4]u64)\nexport func push_4(v: *mut F4, x: u64) -> bool {\n  let i = v.len\n  return false when i >= 4\n  v.buf[i] = x\n  v.len = i + 1\n  return true\n}\n',
        'data mine = mut [0:u64; 4]\ndata v: F4 = mut (0, mine)\nexport func a(x: u64) -> bool => push_4(v, x)\n'],
    ],
  ] as const) {
    test(`a program that imports lib/${file}.ents has only the instances it uses of it`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'encantis-values-'))
      try {
        const [restated, hand, main] = byHand
        const addr = 'export func addr() -> u32 => mine as u32\n'
        await writeFile(join(dir, 'g.ents'), `import "${relative(dir, libDir)}/${file}" (\n  ${uses}\n)\n${lib}${addr}`)
        const type = /^type .*\n/.exec(hand)?.[0] ?? ''
        await writeFile(join(dir, 'hand.ents'), hand)
        await writeFile(join(dir, 'h.ents'), `${type}import "./hand" (\n  ${restated}\n)\n${main}${addr}`)
        const [g, h] = [await compileToWasm(join(dir, 'g.ents')), await compileToWasm(join(dir, 'h.ents'))]
        expect(Buffer.from(g).equals(Buffer.from(h))).toBe(true)
        const instance = await WebAssembly.instantiate(await WebAssembly.compile(g))
        expect((instance.exports.addr as () => number)()).toBe(8)
      } finally {
        await rm(dir, { recursive: true })
      }
    })
  }

  test('the push of a FixedVec is the design\'s: one compare, one store, no check', () => {
    const wat = watOfSource(`func FixedVec(comptime n: u32, comptime T: type) -> type => (len: u32#(n + 1), buf: *mut [n]T)
func push(comptime n: u32, comptime T: type, v: *mut FixedVec(n, T), x: T) -> bool {
  let i = v.len
  return false when i >= n
  v.buf[i] = x
  v.len = i + 1
  return true
}
export func f(v: *mut FixedVec(4, u64), x: u64) -> bool => v.push(x)
`)
    expect(wat).toContain(`  (func $push<4|u64> (param $v i32) (param $x i64) (result i32)
    (local $i i32)
    (local.set $i (i32.load (local.get $v)))
    (if (i32.ge_u (local.get $i) (i32.const 4)) (then (i32.const 0) (return)))
    (i64.store (i32.add (i32.load (i32.add (local.get $v) (i32.const 4))) (i32.mul (local.get $i) (i32.const 8))) (local.get $x))
    (i32.store (local.get $v) (i32.add (local.get $i) (i32.const 1)))
    (i32.const 1) (return)
    (unreachable)
  )`)
  })

  test('a constant is not folded that the hand-written function would not fold', () => {
    const wat = watOfSource('func rotl(comptime k: u32, x: u32) -> u32 => (x << k) | (x >> (32 - k))\nexport func f(x: u32) -> u32 => rotl(7, x)\n')
    expect(wat).toContain('(i32.sub (i32.const 32) (i32.const 7))')
  })
})

describe('instances', () => {
  const SUM = 'func sum(comptime n: u32, xs: *[n]u32) -> u32 => xs.len\n'

  test('explicit, inferred and computed arguments of one number share an instance', () => {
    expect(instancesOf(`${SUM}def four = 4\ndata p = [1:u32, 2, 3, 4]\nexport func a() -> u32 => sum(p) + sum(4, p) + sum(2 + 2, p) + sum(four, p) + sum(4:u32, p) + sum(0x4, p)`)).toEqual(['sum<4>'])
  })

  test('are named by their numbers in decimal, and placed in the order of their names as text', () => {
    const source = 'func rotl(comptime k: u32, x: u32) -> u32 => (x << k) | (x >> (32 - k))\nfunc shift(comptime k: i32, x: i32) -> i32 => x + k\n'
      + 'export func a(x: u32) -> u32 => rotl(7, x) ^ rotl(13, x) ^ rotl(0x10, x)\nexport func b(x: i32) -> i32 => shift(0 - 3, x) + shift(3, x)\n'
    expect(funcs(watOfSource(source))).toEqual(['rotl<13>', 'rotl<16>', 'rotl<7>', 'shift<-3>', 'shift<3>', 'a', 'b'])
  })

  test('a number is held as its parameter\'s type holds it', () => {
    expect(instancesOf('func mask(comptime m: u8, x: u8) -> u8 => x & m\nexport func f(x: u8) -> u8 => mask(~0, x) & mask(255, x)')).toEqual(['mask<255>'])
    expect(instancesOf('func big(comptime n: u64, x: u64) -> u64 => x + n\nexport func f(x: u64) -> u64 => big(1 << 40, x)')).toEqual(['big<1099511627776>'])
  })

  test('the label of an error names the number', () => {
    expect(errorsOf('func f(comptime n: u32, comptime T: type, x: T) -> u8 {\n  let b: u8 = n\n  return b\n}\nexport func g() -> u8 => f(300, u8, 1)')).toEqual([
      'cannot assign int(300) to u8, in f(n = 300, T = u8)',
    ])
  })

  test('a value parameter of a generic type is computed before the type is made', () => {
    const RING = 'func Ring(comptime n: u32, comptime T: type) -> type => (head: u32#n, items: *mut [n]T)\n'
    expect(errorsOf(`${RING}func f(a: *mut Ring(8, u32)) -> *mut Ring(4 + 4, u32) => a\nfunc g(a: *mut Ring(8, u32)) -> *mut (head: u32#8, items: *mut [8]u32) => a`)).toEqual([])
    expect(errorsOf(`${RING}func f(a: *mut Ring(16, u32)) -> *mut Ring(8, u32) => a`)).toEqual(['cannot assign *mut Ring(16, u32) to *mut Ring(8, u32)'])
    // A value the body does not use makes no difference: a generic type is its body.
    expect(errorsOf('func Tagged(comptime n: u32) -> type => (id: u32)\nfunc f(a: Tagged(4)) -> Tagged(5) => a')).toEqual([])
  })

  test('a call whose callee is no generic type stays a value: Cell(1, 2) is a Cell', () => {
    expect(instancesOf('type Cell = (x: i32, y: i32)\nfunc keep(comptime T: type, x: T) -> T => x\nexport func f() -> i32 => keep(Cell(1, 2)).x')).toEqual(['keep<<x:i32|y:i32>>'])
    // Where it is one, its numbers are given to its value parameters.
    expect(instancesOf('func Ring(comptime n: u32, comptime T: type) -> type => (head: u32#n, items: *mut [n]T)\nfunc keep(comptime T: type, x: T) -> u32 => sizeof(T)\nexport func f(p: *mut [8]u8) -> u32 => keep(Ring(8, u8)(0, p)) + keep(Ring(8, u8), Ring(8, u8)(1, p))')).toHaveLength(1)
  })

  test('a buffer for each number, laid out once', async () => {
    const source = 'func scratch(comptime n: u32) -> *mut [n]u8 => mut [0:u8; n]\nexport func a() -> u32 => (scratch(16) as u32) + (scratch(64) as u32)\nexport func b() -> bool => scratch(16) == scratch(16)\n'
    const wat = watOfSource(source)
    expect(wat).toContain('16 zero bytes at 0x8')
    expect(wat).toContain('64 zero bytes at 0x18')
  })

  test('n = 0 is a number like any other', () => {
    expect(errorsOf('func total(comptime n: u32, xs: *[n]u32) -> (t: u32) {\n  for x in xs {\n    t += x\n  }\n}\ndata none: *[0]u32 = []\nexport func z() -> u32 => total(none)')).toEqual([])
    expect(errorsOf('func scratch(comptime n: u32) -> *mut [n]u8 => mut [0:u8; n]\nexport func z() -> *mut [0]u8 => scratch(0)')).toEqual([])
  })
})

describe('generic types with value parameters', () => {
  const RING = 'func Ring(comptime n: u32, comptime T: type) -> type => (head: u32#n, count: u32, items: *mut [n]T)\n'
  const errorsWithNotes = (source: string) => check(source).result.errors.map((e) => ({ offset: e.offset, message: e.message, notes: e.notes?.map((n) => n.offset) }))

  test('an error a number makes in the body is the application\'s: named, with the use it was required from, once for each', () => {
    const source = `${RING}export func f(r: *Ring(0, u32)) -> u32 => r.count\nexport func g(r: *Ring(0, u8)) -> u32 => r.count\nexport func h(r: *Ring(0, u8)) -> u32 => r.count\n`
    const bound = source.indexOf('u32#n') + 'u32#'.length
    expect(errorsWithNotes(source)).toEqual([
      { offset: bound, message: 'range bound must be at least 1: u32#0 has no values, in Ring(0, u32)', notes: [source.indexOf('Ring(0, u32)')] },
      { offset: bound, message: 'range bound must be at least 1: u32#0 has no values, in Ring(0, u8)', notes: [source.indexOf('Ring(0, u8)')] },
    ])
    // And what is made of it says nothing more: Ring(0, u32) is no type.
    expect(errorsOf(`${RING}func push(comptime n: u32, comptime T: type, r: *mut Ring(n, T), x: T) { r.count = 1 }\ndata cells = mut [0:u32; 0]\ndata log: Ring(0, u32) = mut (0, 0, cells)\nexport func f(x: u32) { log.push(x) }\nexport func g(x: u32, r: *mut Ring(0, u32)) { r.push(x) }`)).toEqual([
      'range bound must be at least 1: u32#0 has no values, in Ring(0, u32)',
    ])
  })

  test('so is one inside an instance, with the calls it was required from', () => {
    const source = `${RING}func g(comptime n: u32, p: *mut [8]u32) -> u32 {\n  let r: Ring(n - 8, u32) = (0, 0, p)\n  return r.count\n}\nexport func a(p: *mut [8]u32) -> u32 => g(8, p)\n`
    expect(errorsWithNotes(source)).toEqual([
      { offset: source.indexOf('u32#n') + 'u32#'.length, message: 'range bound must be at least 1: u32#0 has no values, in Ring(0, u32)', notes: [source.indexOf('Ring(n - 8'), source.indexOf('g(8, p)')] },
    ])
  })

  test('a mistake of the declaration is said once, where it is, and only once the type is applied', () => {
    expect(errorsOf('func S(comptime n: u32) -> type => (items: *[n-1]u8, i: u32#n-1)\nexport func h(s: *S(4)) -> u32 => 0\nexport func k(s: *S(5)) -> u32 => 0')).toEqual([
      "unknown identifier 'n-1': a hyphen joins a name; for subtraction write n - 1",
      "unknown identifier 'n-1': a hyphen joins a name; for subtraction write n - 1",
    ])
    // No type is suggested for a length
    expect(errorsOf('func R(comptime n: u32) -> type => (items: *[m]u8)\nexport func f(r: *R(3)) -> u32 => 0')).toEqual(["unknown identifier 'm'"])
    expect(errorsOf('func R(comptime n: u32) -> type => (items: *[m]u8)\nexport func f() -> u32 => 0')).toEqual([])
  })

  test('one that applies itself to numbers that grow is stopped at once', () => {
    expect(errorsOf('func T3(comptime n: u32) -> type => (a: *T3(n + 1), b: *T3(n + 2), c: u32)\nexport func f(t: *T3(1)) -> u32 => t.c')).toEqual([
      "generic types are nested more than 1000 deep in 'T3(1)'",
    ])
    expect(errorsOf('func T2(comptime n: u32) -> type => (a: *T2(n * 2), b: *T2(n * 2 + 1))\nexport func f(t: *T2(1)) -> u32 => 0')).toEqual([
      "argument 1 of 'T2': cannot assign int(4294967296) to u32, in T2(2147483648)",
    ])
    // Numbers that come round make each type once, also while the module's
    // types are collected
    expect(errorsOf('func T(comptime n: u32) -> type => (a: *T((n + 1) % 4), b: *T((n + 2) % 4), c: B)\ntype A = *T(1)\ntype B = u32\nexport func f(t: A) -> u32 => t.a.b.a.c')).toEqual([])
  })

  test('a value argument is a constant like any other: a def declared further down, a typed one by its type', () => {
    expect(errorsOf(`${RING}data cells = mut [0:u32; 8]\ndata log: Ring(cap, u32) = mut (0, 0, cells)\ntype R = Ring(cap, u32)\nexport func f(r: *R) -> *Ring(8, u32) => r\ndef cap = 8`)).toEqual([])
    const SMALL = 'func Small(comptime n: u8) -> type => (items: *[n]u8)\n'
    expect(errorsOf(`${SMALL}export func b(s: Small(4:u32)) -> u32 => 0\nexport func d(s: Small(sizeof(u64))) -> u32 => 0\nexport func e(s: Small(300)) -> u32 => 0`)).toEqual([
      "argument 1 of 'Small': cannot assign u32 to u8",
      "argument 1 of 'Small': cannot assign u32 to u8",
      "argument 1 of 'Small': cannot assign int(300) to u8",
    ])
    expect(errorsOf(`${SMALL}export func f(s: Small(~0)) -> Small(255) => s\nexport func g(s: Small(4:u8)) -> Small(4) => s`)).toEqual([])
  })

  test('cannot infer: the arithmetic of a generic type\'s body is that generic type\'s', () => {
    expect(errorsOf(`${RING}func f(comptime n: u32, r: *Ring(n + 1, u32)) -> u32 => n\ndata cells = mut [0:u32; 8]\ndata log: Ring(8, u32) = mut (0, 0, cells)\nexport func a() -> u32 => f(log)`)).toEqual([
      "cannot infer n for 'f': 'Ring(n + 1, u32)' has no length that is n alone; write the value argument",
    ])
  })
})

describe('a value parameter in the instance', () => {
  test('is declared, so that its name is not bound again, nor assigned to, in each instance', () => {
    const body = 'func f(comptime n: u32) -> u32 {\n  n = 3\n  return 0\n}\n'
    expect(errorsOf(`${body}export func g() -> u32 => f(1) + f(2)`)).toEqual([
      "cannot assign to 'n': it is a comptime value parameter, in f(n = 1)",
      "cannot assign to 'n': it is a comptime value parameter, in f(n = 2)",
    ])
    // A generic nobody calls is only parsed.
    expect(errorsOf(body)).toEqual([])
  })

  test('is not a def a test declares before it', async () => {
    const source = 'test "t" {\n  def n = 99\n  assert n == 99\n}\nfunc f(comptime n: u32) -> u32 => n\nfunc Buf(comptime n: u32) -> type => (items: [n]u8)\nexport func a() -> u32 => f(4) + sizeof(Buf(4))\ntest "u" {\n  assert a() == 8\n}\n'
    expect(errorsOf(source)).toEqual([])
    expect((await runTestsOfSource(source)).failed).toEqual([])
  })

  test('the shorthand (n:) is the number', async () => {
    const generic = 'type P = (n: u32, x: u32)\nfunc make(comptime n: u32, x: u32) -> P => P(n:, x:)\nexport func f(x: u32) -> u32 => make(9, x).n\n'
    const byHand = 'type P = (n: u32, x: u32)\nfunc make_9(x: u32) -> P => P(n: 9, x:)\nexport func f(x: u32) -> u32 => make_9(x).n\n'
    await expectSameWasm(generic, byHand)
  })

  test('picks among functions that share a name as a literal does', async () => {
    const generic = 'func gt(a: u32, b: u32) -> bool => a > b\nfunc gt(a: f64, b: f64) -> bool => a > b\nfunc above(comptime n: u32, x: u32) -> bool => gt(x, n)\nexport func f(x: u32) -> bool => above(8, x)\n'
    const byHand = 'func gt(a: u32, b: u32) -> bool => a > b\nfunc gt(a: f64, b: f64) -> bool => a > b\nfunc above_8(x: u32) -> bool => gt(x, 8)\nexport func f(x: u32) -> bool => above_8(x)\n'
    await expectSameWasm(generic, byHand)
  })
})

describe('in a program of several modules', () => {
  test('one instance for every module that asks for it, and a renamed import', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'encantis-values-'))
    try {
      await writeFile(join(dir, 'lib.ents'), `export func Ring(comptime n: u32, comptime T: type) -> type => (head: u32#n, count: u32, items: *mut [n]T)
export func push(comptime n: u32, comptime T: type, r: *mut Ring(n, T), x: T) {
  r.items[(r.head + r.count) % n] = x
  if r.count < n {
    r.count += 1
  } else {
    r.head = (r.head + 1) % n
  }
}
export func total(comptime n: u32, xs: *[n]u32) -> (t: u32) {
  for i in n {
    t += xs[i]
  }
}
`)
      await writeFile(join(dir, 'other.ents'), `import "./lib" (
  "Ring" func Ring(comptime n: u32, comptime T: type) -> type
  "push" func push(comptime n: u32, comptime T: type, r: *mut Ring(n, T), x: T)
)
def eight = 8
export func add_other(r: *mut Ring(eight, u32), x: u32) { r.push(x) }
`)
      const entry = join(dir, 'main.ents')
      await writeFile(entry, `import "./lib" (
  "Ring" func Ring(comptime n: u32, comptime T: type) -> type
  "push" func push(comptime n: u32, comptime T: type, r: *mut Ring(n, T), x: T)
  "total" func sum(comptime n: u32, xs: *[n]u32) -> u32
)
import "./other" "add_other" func add_other(r: *mut Ring(8, u32), x: u32)

data cells = mut [0:u32; 8]
data log: Ring(8, u32) = mut (0, 0, cells)

export func record(x: u32) -> u32 {
  log.push(x)
  add_other(log, x + 1)
  return sum(cells)
}
`)
      const load = await loadModule(entry)
      const result = typecheckProgram(load.modules, entry, { includeTests: false })
      expect(result.errors).toEqual([])
      const wat = programToWat(load.modules, result.results, entry)
      expectPlainWasm(wat)
      expect(funcs(wat)).toEqual(['record', 'lib$push<8|u32>', 'lib$total<8>', 'other$add_other'])
      const instance = await WebAssembly.instantiate(await WebAssembly.compile(await wasmOfWat(wat)))
      expect((instance.exports.record as (x: number) => number)(5)).toBe(11)
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  test('checked on its own, a module that imports one checks its calls against the signature', () => {
    const source = 'import "./lib" "total" func sum(comptime n: u32, xs: *[n]u32) -> u32\ndata p = [1:u32, 2]\nexport func f() -> u32 => sum(p)\nexport func g(xs: []u32) -> u32 => sum(xs)\n'
    expect(errorsOf(source)).toEqual(["cannot infer n for 'sum': a []u32 has no length in its type; write the value argument, as in sum(8, ...)"])
  })
})

describe('in the editor', () => {
  const SOURCE = `func sum(comptime n: u32, xs: *[n]u32) -> (total: u32) {
  for i in n {
    total += xs[i]
  }
}
func Ring(comptime n: u32, comptime T: type) -> type => (head: u32#n, items: *mut [n]T)
data p = [1:u32, 2, 3, 4]
data q = [1:u32, 2, 3, 4, 5, 6, 7, 8]
data cells = mut [0:u8; 8]
data r: Ring(8, u8) = mut (0, cells)
export func a() -> u32 => sum(p) + sum(q)
`
  const { module, result } = check(SOURCE)
  const at = (text: string, nth = 0) => {
    let offset = -1
    for (let i = 0; i <= nth; i++) offset = SOURCE.indexOf(text, offset + 1)
    return offset
  }
  const hoverAt = (offset: number) => hoverText(hover(SOURCE, module, result, offset) as HoverResult)

  test('a value parameter shows its number in each instance, where it is declared and wherever it is used', () => {
    const shown = 'value parameter n: u32 — in sum(n = 4): 4; in sum(n = 8): 8'
    expect(hoverAt(at('n: u32'))).toBe(shown)
    expect(hoverAt(at('[n]') + 1)).toBe(shown)
    expect(hoverAt(at('in n') + 3)).toBe(shown)
  })

  test('so does one of a generic type, in each application', () => {
    expect(hoverAt(at('#n') + 1)).toBe('value parameter n: u32 — in Ring(8, u8): 8')
  })

  test('its references are its uses in the body and in the lengths and bounds of its types', () => {
    const refs = findReferences(SOURCE, module, result, at('n: u32'))
    expect(refs?.definition.offset).toBe(at('n: u32'))
    expect(refs?.references.map((l) => l.offset).sort((x, y) => x - y)).toEqual([at('[n]') + 1, at('in n') + 3])
  })
})

describe('the grammar', () => {
  const typeOf = (text: string) => {
    const parsed = parse(`func f(x: ${text}) -> u32 => 0`)
    expect(parsed.errors.map((e) => e.message)).toEqual([])
    const decl = (parsed.module as AST.Module).decls[0] as AST.FuncDecl
    return (decl.signature.input as AST.CompositeType).fields[0].type
  }

  test('a length that is not a decimal number is an expression', () => {
    for (const text of ['[n]u8', '[n * 2]u8', '[(n)]u8', '[0x10]u8', '[sizeof(u64) * 4]u8', '[n]mut u8']) {
      const type = typeOf(text) as AST.IndexedType
      expect(type.kind).toBe('IndexedType')
      expect(type.size).toBe('expr')
      expect(type.length).toBeDefined()
    }
    expect((typeOf('[n]mut u8') as AST.IndexedType).mutable).toBe(true)
  })

  test('the bracket forms of before keep their meaning', () => {
    expect((typeOf('[5]u8') as AST.IndexedType).size).toBe(5)
    expect((typeOf('[2x3]u8') as AST.IndexedType).size).toEqual([2, 3])
    expect((typeOf('[_]u8') as AST.IndexedType).size).toBe('inferred')
    expect((typeOf('[!]u8') as AST.IndexedType).specifiers).toEqual([{ kind: 'null' }])
    expect((typeOf('[*]u8') as AST.IndexedType).manyPointer).toBe(true)
    expect((typeOf('[]u8') as AST.IndexedType).size).toBe(null)
  })

  test('a bound is a number, a name, or an expression in parentheses', () => {
    expect(typeOf('u32#16')).toMatchObject({ kind: 'PrimitiveType', name: 'u32', max: 16 })
    expect(typeOf('u32#n')).toMatchObject({ kind: 'PrimitiveType', name: 'u32', bound: { kind: 'IdentExpr', name: 'n' } })
    expect(typeOf('u32#n-1')).toMatchObject({ bound: { kind: 'IdentExpr', name: 'n-1' } })
    expect(typeOf('u32#(n + 1)')).toMatchObject({ kind: 'PrimitiveType', name: 'u32', bound: { kind: 'BinaryExpr', op: '+' } })
  })

  test('a def the parser knows is put in for a bound written as a name, as for any name', () => {
    const parsed = parse('def size = 64\nfunc f(i: u32#size) -> u32 => 0')
    const decl = (parsed.module as AST.Module).decls[1] as AST.FuncDecl
    expect((decl.signature.input as AST.CompositeType).fields[0].type).toMatchObject({ bound: { kind: 'LiteralExpr' } })
  })

  test('a generic type takes values among its arguments', () => {
    const type = typeOf('Ring(8, u32)') as AST.TypeApply
    expect(type.args.map((a) => a.kind)).toEqual(['ValueArg', 'PrimitiveType'])
    expect((typeOf('Bits(n * 2)') as AST.TypeApply).args.map((a) => a.kind)).toEqual(['ValueArg'])
    expect((typeOf('Ring(n, T)') as AST.TypeApply).args.map((a) => a.kind)).toEqual(['ValueArg', 'TypeRef'])
  })

  test('a type with a length that is an expression is an argument', () => {
    const parsed = parse('func g(x: u32) -> u32 => f([n]u8, x)')
    expect(parsed.errors).toEqual([])
  })
})

describe('lengths and bounds in hand-written code', () => {
  test('sizeof of the largest array an array can be', () => {
    expect(watOfSource('export func f() -> u32 => sizeof([536870911]u64)')).toContain('(i32.const 4294967288)')
    expect(errorsOf('export func f() -> u32 => sizeof([536870912]u64)')).toEqual([
      'array [536870912]u64 is too large: 4294967296 bytes, more than the 4294967295 a 32-bit memory addresses',
    ])
  })

  test('a def sizes a type, and the type has the number in it', async () => {
    const generic = 'def size = 64\ndef k = 2\ndata buf = mut [0:u8; size]\nexport func f(i: u32#size) -> u8 => buf[i]\nexport func g(p: *[k * 2]u32) -> u32 => p.len\n'
    const byHand = 'def size = 64\ndef k = 2\ndata buf = mut [0:u8; 64]\nexport func f(i: u32#64) -> u8 => buf[i]\nexport func g(p: *[4]u32) -> u32 => p.len\n'
    await expectSameWasm(generic, byHand)
  })

  test('a name that is no constant is one error, wherever it is declared', () => {
    expect(errorsOf('export func f(p: *[g]u8) -> u32 => 0\nglobal g: u32 = 3')).toEqual(['array length must be a compile-time constant'])
    expect(errorsOf('export func f(p: *[h]u8) -> u32 => 0\nfunc h() -> u32 => 1')).toEqual(['array length must be a compile-time constant'])
    expect(errorsOf('export func f(p: *[zz + 1]u8) -> u32 => 0')).toEqual(["unknown identifier 'zz'"])
    expect(errorsOf('type B = *[k]u8\ndef k = 2\nexport func f(b: B) -> u32 => b.len')).toEqual([])
  })

  test('a typed constant is what it is in any expression', async () => {
    expect(errorsOf('export func f(p: *[300:u8]u8) -> u32 => p.len')).toEqual(['cannot assign int(300) to u8'])
    await expectSameWasm('def m = ~0:u8\nexport func a(p: *[m]u8) -> u32 => p.len\nexport func b(i: u32#(~0:u8)) -> u32 => i\n', 'export func a(p: *[255]u8) -> u32 => p.len\nexport func b(i: u32#255) -> u32 => i\n')
    expect(instancesOf('func len(comptime n: u32, p: *[n]u8) -> u32 => n\ndef m = ~0:u8\nexport func e(p: *[m]u8) -> u32 => len(~0:u8, p) + len(p)')).toEqual(['len<255>'])
  })

  test('behind a pointer, an array of arrays is a table of row pointers, and its size is theirs', () => {
    expect(errorsOf('export func f(t: *[65536][65537]u8, i: u32#65536) -> u32 => t[i].len\nfunc tr(comptime n: u32, comptime T: type, t: *[n]T) -> u32 => t.len\nexport func g(t: *[65536][65537]u8) -> u32 => tr(t)')).toEqual([])
    // Held by value, it is n rows of m; n row pointers are 4 bytes each.
    expect(errorsOf('export func f() -> u32 => sizeof([65536][65537]u8)\nexport func g(t: *[1073741824][2]u8) -> u32 => t.len')).toEqual([
      'array [1073741824][2]u8 is too large: 4294967296 bytes, more than the 4294967295 a 32-bit memory addresses',
      'array [65536][65537]u8 is too large: 4295032832 bytes, more than the 4294967295 a 32-bit memory addresses',
    ])
  })

  test('one error for each mistake', () => {
    // A parameter's .len is no constant in its signature
    expect(errorsOf('export func c(p: *[4]u32, r: *[p.len]u32) -> u32 => 0\nexport func d(p: *[4]u32, i: u32#(p.len)) -> u32 => 0')).toEqual([
      'array length must be a compile-time constant',
      'range bound must be a compile-time constant',
    ])
    // A name in a round of defs, met again once a name like it is declared
    expect(errorsOf('export func f(p: *[k]u8) -> u32 => p.len\ndef k = j + 1\ndef j = k + 1')).toEqual([
      "unknown identifier 'j'",
      'def value must be a compile-time constant',
      'def value must be a compile-time constant',
    ])
  })

  test('a division by zero says so', () => {
    expect(errorsOf('func chunk(comptime n: u32, p: *[64 / n]u8) -> u32 => p.len\nexport func a(p: *[8]u8) -> u32 => chunk(0, p)\nexport func h(p: *[7 % 0]u8) -> u32 => p.len')).toEqual([
      'array length divides by zero',
      'array length divides by zero, in chunk(n = 0)',
    ])
    expect(errorsOf('func Ring(comptime n: u32) -> type => (head: u32#n)\nfunc s(comptime n: u32) -> u32 => n\nexport func k(r: *Ring(8 / 0)) -> u32 => s(1 % 0)')).toEqual([
      "argument 1 of 'Ring' divides by zero",
      "argument 1 of 's' divides by zero",
    ])
  })

  test('[0x10]u8 is sixteen bytes', () => {
    expect(watOfSource('export func f(p: *[0x10]u8) -> u32 => p.len')).toContain('(i32.const 16)')
  })
})
