// Host references (reference 2.13) as the host sees them: JavaScript values
// handed in, held in registers and globals, given to the host's functions and
// handed back, the same values. What the checker refuses is in the
// reference's spec region.

import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { typecheckProgram } from './checker'
import { programToWatWithTests } from './codegen'
import { loadModule } from './loader'
import { importedGlobals } from './test-host'
import { compileToWasm, runTestsOfSource, wasmOfSource, watOfSource } from './test-utils'

const SOURCE = `type Canvas = host
type Context = host
type Screen = Canvas

import "canvas" (
  "context" func context(c: Canvas) -> Context
  "fill" func fill(ctx: Context, x: f32)
)
import "env" "screen" global screen: Screen

global ctx: ?Context
global kept: ?Canvas

export func start(c: Canvas) {
  ctx = context(c)
  kept = c
}
export func draw(n: u32) {
  if let x = ctx {
    for i in n { fill(x, i as f32) }
  }
}
export func same(c: Canvas) -> Canvas => c
export func pick(a: Canvas, b: Canvas, first: bool) -> Canvas => if first { a } else { b }
export func both(c: Canvas, n: i32) -> (c: Canvas, n: i32) => (c, n + 1)
export func kept-one() -> ?Canvas => kept
export func the-screen() -> Screen => screen

type Tagged = (c: Canvas, n: i32)
func untag(t: Tagged) -> Canvas => t.c
export func through(c: Canvas) -> Canvas {
  let pair = [c, c]
  return untag(Tagged(pair[1], 3))
}

func id(comptime T: type, x: T) -> T => x
export func generic(c: Canvas) -> Canvas => id(c)
`

async function instance(wasm: Uint8Array, calls: unknown[][] = [], screen: unknown = { name: 'screen' }) {
  const { instance } = await WebAssembly.instantiate(wasm, {
    canvas: {
      context: (c: unknown) => ({ of: c }),
      fill: (...args: unknown[]) => calls.push(args),
    },
    env: { screen: new WebAssembly.Global({ value: 'externref', mutable: false }, screen) },
  })
  return instance.exports as Record<string, CallableFunction>
}

describe('host references', () => {
  test('are externrefs in wasm, and only there', () => {
    const wat = watOfSource(SOURCE)
    expect(wat).toContain('(func $same (param $c externref) (result externref)')
    expect(wat).toContain('(import "env" "screen" (global $screen externref))')
    expect(wat).toContain('(global $kept (mut externref) (ref.null extern))')
    // A plain one the host gives is checked where it comes in.
    expect(wat).toContain('(func $same (param $c externref) (result externref)\n    (if (ref.is_null (local.get $c)) (then (unreachable)))')
    expect(wat).toContain('(func $__host_globals\n    (if (ref.is_null (global.get $screen)) (then (unreachable)))')
    expect(wat).toContain('(func $id<Canvas> (param $x externref) (result externref)')
  })

  test('come back as the same JavaScript values', async () => {
    const m = await instance(await wasmOfSource(SOURCE))
    const a = { name: 'a' }
    const b = { name: 'b' }
    expect(m.same(a)).toBe(a)
    expect(m.same('text')).toBe('text')
    expect(m.same(undefined)).toBe(undefined)
    expect(m.pick(a, b, 1)).toBe(a)
    expect(m.pick(a, b, 0)).toBe(b)
    expect(m.both(a, 4)).toEqual([a, 5])
    expect(m.through(a)).toBe(a)
    expect(m.generic(b)).toBe(b)
  })

  test('a global holds one from call to call, and an optional one is null until given one', async () => {
    const calls: unknown[][] = []
    const screen = { name: 'screen' }
    const m = await instance(await wasmOfSource(SOURCE), calls, screen)
    expect(m['kept-one']()).toBe(null)
    const canvas = { name: 'canvas' }
    m.start(canvas)
    expect(m['kept-one']()).toBe(canvas)
    m.draw(2)
    expect(calls).toEqual([[{ of: canvas }, 0], [{ of: canvas }, 1]])
    // The context the host made is the one it is given back each time.
    expect(calls[0][0]).toBe(calls[1][0])
    expect(m['the-screen']()).toBe(screen)
  })

  test('none of an optional one is 0 in the module and null in JavaScript', async () => {
    const source = `type Canvas = host
type Context = host
import "canvas" (
  "context" func context(c: Canvas) -> Context
  "maybe" func maybe(c: ?Canvas) -> ?Context
)

global ctx: ?Context = 0
export func start(c: ?Canvas) {
  if let given = c { ctx = context(given) }
}
export func ready() -> bool => ctx != 0
export func reset() { ctx = 0 }
export func none() -> ?Canvas => 0
export func cast-none() -> ?Canvas => 0 as ?Canvas
export func is-null(c: ?Canvas) -> bool => c == 0
export func not-null(c: ?Canvas) -> bool => 0 != c
export func given-none() -> ?Context => maybe(0)
export func or-else(c: ?Canvas, d: Canvas) -> Canvas => c ?? d
export func widened(c: Canvas) -> ?Canvas => c
export func unset() -> ?Canvas {
  let c: ?Canvas
  return c
}
`
    const given: unknown[] = []
    const { instance } = await WebAssembly.instantiate(await wasmOfSource(source), {
      canvas: {
        context: (c: unknown) => (given.push(c), { of: c }),
        maybe: (c: unknown) => (given.push(c), null),
      },
    })
    const m = instance.exports as Record<string, CallableFunction>
    expect(m.none()).toBe(null)
    expect(m['cast-none']()).toBe(null)
    expect(m.unset()).toBe(null)
    expect(m['is-null'](null)).toBe(1)
    expect(m['is-null']({})).toBe(0)
    expect(m['not-null'](null)).toBe(0)
    expect(m['not-null']({})).toBe(1)
    // undefined is a value of the host's, not null.
    expect(m['is-null'](undefined)).toBe(0)
    m.start(null)
    expect(m.ready()).toBe(0)
    expect(given).toEqual([])
    m.start({ name: 'canvas' })
    expect(m.ready()).toBe(1)
    m.reset()
    expect(m.ready()).toBe(0)
    expect(m['given-none']()).toBe(null)
    expect(given.at(-1)).toBe(null)
    const a = { name: 'a' }
    const d = { name: 'd' }
    expect(m['or-else'](a, d)).toBe(a)
    expect(m['or-else'](null, d)).toBe(d)
    expect(m.widened(a)).toBe(a)
  })

  // A 0 that reaches its place only through a conversion (an element of a
  // literal, a branch with no type of its own, an if let's or elif let's
  // too, a def, an instance) is the null reference as well, not an i32.
  test('none written 0 is null wherever it is written', async () => {
    const source = `type Canvas = host
type W = (cs: [2]?Canvas, n: i32)
def z = 0
def zz = z
global g: [2]?Canvas = [0, 0]
export func pair(c: Canvas) -> [2]?Canvas => [c, 0]
export func rep() -> [3]?Canvas => [0; 3]
export func glob() -> [2]?Canvas => g
func take(a: [2]?Canvas) -> ?Canvas => a[1]
export func arg(c: Canvas) -> ?Canvas => take([c, 0])
export func field(c: Canvas) -> W => W([0, c], 1)
export func elf(n: i32, c: ?Canvas) -> ?Canvas {
  let x = if n == 0 { 0 } elif n == 1 { c } else { 0 }
  return x
}
export func mat(n: i32, c: ?Canvas) -> ?Canvas {
  let x = match n { 0 => 0, _ => c }
  return x
}
export func eqif(b: bool, c: Canvas) -> bool => (if b { c as ?Canvas } else { 0 }) == 0
export func paren(c: Canvas) -> [2]?Canvas => [c, (0)]
export func defz(c: Canvas) -> [2]?Canvas => [c, zz]
export func untyped(c: ?Canvas) -> ?Canvas {
  let xs = [c, 0]
  return xs[1]
}
func pr(comptime T: type, x: T) -> [2]?T => [x, 0]
export func gen(c: Canvas) -> [2]?Canvas => pr(c)
data cell = 7:u32
func at(k: u32) -> ?*u32 => if k == 0 { 0 } else { cell }
export func iflet(k: u32) -> ?Canvas => (if let v = at(k) { 0 } else { 0 }) as ?Canvas
export func eliflet(b: bool, k: u32) -> ?Canvas => (if b { 0 } elif let v = at(k) { 0 } else { 0 }) as ?Canvas
export func eqlet(k: u32, c: ?Canvas) -> bool => c == (if let v = at(k) { 0 } else { 0 })
`
    const { instance } = await WebAssembly.instantiate(await wasmOfSource(source), {})
    const m = instance.exports as Record<string, CallableFunction>
    const o = { name: 'o' }
    expect(m.pair(o)).toEqual([o, null])
    expect(m.rep()).toEqual([null, null, null])
    expect(m.glob()).toEqual([null, null])
    expect(m.arg(o)).toBe(null)
    expect(m.field(o)).toEqual([null, o, 1])
    expect([m.elf(0, o), m.elf(1, o), m.elf(2, o)]).toEqual([null, o, null])
    expect([m.mat(0, o), m.mat(1, o)]).toEqual([null, o])
    expect([m.eqif(1, o), m.eqif(0, o)]).toEqual([0, 1])
    expect(m.paren(o)).toEqual([o, null])
    expect(m.defz(o)).toEqual([o, null])
    expect(m.untyped(o)).toBe(null)
    expect(m.gen(o)).toEqual([o, null])
    expect([m.iflet(0), m.iflet(1)]).toEqual([null, null])
    expect([m.eliflet(1, 0), m.eliflet(0, 0), m.eliflet(0, 1)]).toEqual([null, null, null])
    expect([m.eqlet(0, null), m.eqlet(1, null), m.eqlet(1, o)]).toEqual([1, 1, 0])
  })

  // An array literal indexed where it is written is its elements: a
  // constant index picks one, of host references or of numbers alike, and
  // nothing is read from memory.
  test('an array literal indexed where it is written picks an element', async () => {
    // A constant index is any the checker works out: (1), 0 + 1, 1 - 1.
    const source = `type Canvas = host
data t = [100, 200, 300, 400]
export func second(c: Canvas, d: Canvas) -> Canvas => [c, d][1]
export func first(c: ?Canvas) -> ?Canvas => [0, c][0]
export func number(x: u32, y: u32) -> u32 => [x, y][1]
export func summed(c: Canvas, d: Canvas) -> Canvas => [c, d][0 + 1]
export func grouped(c: Canvas, d: Canvas) -> Canvas => [c, d][(0)]
export func numbers(x: u32, y: u32) -> u32 => [x, y][(1)] * 100 + [x, y][1 - 1] * 10 + [x][0 + 0]
export func len() -> u32 => ["ab", "cde"][0 + 1].len
export func used() -> i32 => t[0]
`
    expect(watOfSource(source)).not.toContain('.load (i32.add (local')
    const { instance } = await WebAssembly.instantiate(await wasmOfSource(source), {})
    const m = instance.exports as Record<string, CallableFunction>
    const [c, d] = [{ name: 'c' }, { name: 'd' }]
    expect(m.second(c, d)).toBe(d)
    expect(m.first(c)).toBe(null)
    expect(m.number(4, 9)).toBe(9)
    expect(m.summed(c, d)).toBe(d)
    expect(m.grouped(c, d)).toBe(c)
    expect(m.numbers(4, 9)).toBe(944)
    expect(m.len()).toBe(3)
  })

  // An array literal with no type written, laid out with &, is the type a
  // let of it holds: what is known only at run time is stored into it.
  test('an untyped literal laid out with & holds its values', async () => {
    const source = `export func pair(a: i32, b: i32, i: u32#2) -> i32 {
  let p = &[a, b]
  return p[i]
}
export func three(i: u32#3) -> i32 {
  let p = &[10, 20, 30]
  return p[i]
}
export func lengths(i: u32#2) -> u32 => (&["ab", "cde"])[i].len
`
    const { instance } = await WebAssembly.instantiate(await wasmOfSource(source), {})
    const m = instance.exports as Record<string, CallableFunction>
    expect([m.pair(7, 9, 0), m.pair(7, 9, 1)]).toEqual([7, 9])
    expect([m.three(0), m.three(2)]).toEqual([10, 30])
    expect([m.lengths(0), m.lengths(1)]).toEqual([2, 3])
  })

  // A let is seen after the block it is in (3.3), but one that holds a
  // plain reference only in its block: after a branch or a loop that did
  // not run it would be null. Read where it is declared, it is the value it
  // was given, and an optional one read after its block is none.
  test('a plain one declared in a block is seen in that block alone', async () => {
    for (const body of ['if b {\n    let c = given\n  }\n  return c', 'for i in n {\n    let c = (given, 1)\n  }\n  return c.0', 'match n {\n    0 => { let c = [given] }\n    _ => {}\n  }\n  return c[0]']) {
      const source = `type Canvas = host\nexport func f(b: bool, n: u32, given: Canvas) -> Canvas {\n  ${body}\n}\n`
      expect(() => watOfSource(source)).toThrow("'c' is seen only in the block it is declared in: that block may not have run here")
    }
    // A test's statements are a body of their own, with the same rule.
    const tested = `type Canvas = host\nimport "env" "screen" global screen: Canvas\ntest "t" {\n  let n = 1\n  if n == 2 {\n    let c = screen\n  }\n  let o: ?Canvas = c\n  assert o != 0\n}\n`
    await expect(runTestsOfSource(tested)).rejects.toThrow("'c' is seen only in the block it is declared in: that block may not have run here")
    const source = `type Canvas = host
import "env" "show" func show(c: Canvas) -> i32
export func inside(b: bool, given: Canvas) -> i32 {
  let total = 0
  if b {
    let c = given
    for i in 2 {
      if i > 0 { total += show(c) }
    }
  }
  return total
}
export func optional(b: bool, given: Canvas) -> ?Canvas {
  if b {
    let o: ?Canvas = given
  }
  return o
}
`
    const shown: unknown[] = []
    const { instance } = await WebAssembly.instantiate(await wasmOfSource(source), { env: { show: (c: unknown) => shown.push(c) } })
    const m = instance.exports as Record<string, CallableFunction>
    const given = { name: 'given' }
    expect([m.inside(1, given), m.inside(0, given)]).toEqual([1, 0])
    expect(shown).toEqual([given])
    expect([m.optional(1, given), m.optional(0, given)]).toEqual([given, null])
  })

  // Wasm sets a local to null once per call: a let given no value is none
  // on each pass of a loop all the same, in a struct or an array too.
  test('an optional one given no value is none on every pass of a loop', async () => {
    const source = `type Canvas = host
type Pair = (c: ?Canvas, n: i32)
import "env" "mk" func mk() -> Canvas
export func run() -> u32 {
  let made: u32 = 0
  for i in 3 {
    let c: ?Canvas
    let p: Pair
    let cs: [2]?Canvas
    if c == 0 && p.c == 0 && cs[1] == 0 {
      c = mk()
      p.c = mk()
      cs[1] = mk()
      made += 1
    }
  }
  return made
}
`
    const { instance } = await WebAssembly.instantiate(await wasmOfSource(source), { env: { mk: () => ({ made: 1 }) } })
    expect((instance.exports.run as CallableFunction)()).toBe(3)
  })

  // The host promises a plain one is never null. Where one comes in from the
  // host it is checked, once, and a broken promise traps there.
  test('a plain one the host gives as null traps where it comes in', async () => {
    const source = `type Canvas = host
type Tagged = (c: Canvas, n: i32)
import "env" (
  "make" func make(n: i32) -> Canvas
  "pair" func pair(n: i32) -> (n: i32, c: Canvas)
  "maybe" func maybe(n: i32) -> ?Canvas
  "screen" global screen: Canvas
  "other" global other: ?Canvas
)
export func id(c: Canvas) -> Canvas => c
export func tag(t: Tagged) -> i32 => t.n
export func second(a: [2]Canvas) -> Canvas => a[1]
export func made(n: i32) -> Canvas => make(n)
export func paired(n: i32) -> i32 => pair(n).n
export func maybe-none(n: i32) -> bool => maybe(n) == 0
export func the-screen() -> Canvas => screen
export func optional(c: ?Canvas) -> bool => c == 0
`
    const wasm = await wasmOfSource(source)
    const env = (screen: unknown) => ({
      env: {
        make: (n: number) => (n === 0 ? null : { made: n }),
        pair: (n: number) => [n, n === 0 ? null : { pair: n }],
        maybe: (n: number) => (n === 0 ? null : { maybe: n }),
        screen: new WebAssembly.Global({ value: 'externref', mutable: false }, screen),
        other: new WebAssembly.Global({ value: 'externref', mutable: false }, null),
      },
    })
    const screen = { name: 'screen' }
    const { instance } = await WebAssembly.instantiate(wasm, env(screen))
    const m = instance.exports as Record<string, CallableFunction>
    const a = { name: 'a' }
    expect(m.id(a)).toBe(a)
    expect(() => m.id(null)).toThrow(/nreachable/)
    expect(m.tag(a, 3)).toBe(3)
    expect(() => m.tag(null, 3)).toThrow(/nreachable/)
    expect(m.second(a, a)).toBe(a)
    expect(() => m.second(null, a)).toThrow(/nreachable/)
    expect(() => m.second(a, null)).toThrow(/nreachable/)
    expect(m.made(2)).toEqual({ made: 2 })
    expect(() => m.made(0)).toThrow(/nreachable/)
    expect(m.paired(2)).toBe(2)
    expect(() => m.paired(0)).toThrow(/nreachable/)
    // Nothing is checked for an optional one.
    expect(m['maybe-none'](0)).toBe(1)
    expect(m.optional(null)).toBe(1)
    expect(m['the-screen']()).toBe(screen)
    // An imported global is checked when the module starts.
    await expect(WebAssembly.instantiate(wasm, env(null))).rejects.toThrow(/nreachable/)
  })

  // Only a value that comes in from the host is checked: no check where a
  // module's own value is passed on, and none for a module without host types.
  test('the checks are at the boundary and nowhere else', () => {
    const wat = watOfSource(`type Canvas = host
import "env" "show" func show(c: Canvas)
func inner(c: Canvas) -> Canvas => c
export func outer(c: Canvas) -> Canvas {
  show(c)
  return inner(c)
}
`)
    expect(wat.match(/ref\.is_null/g)?.length).toBe(1)
    expect(wat).toContain('(func $outer (param $c externref) (result externref)\n    (if (ref.is_null (local.get $c)) (then (unreachable)))')
    expect(wat).not.toContain('start')
  })

  // An exported function the module calls too checks what the host gives
  // it in a wrapper the host calls: the module's own calls, with values
  // that are never null already, are not checked again.
  test('a call the module makes to an exported function is not checked', async () => {
    const source = `type Canvas = host
export func draw(c: Canvas, n: i32) -> i32 => n + 1
export func many(c: Canvas, n: u32) -> i32 {
  let total = 0
  for i in n {
    total += draw(c, 0)
  }
  return total
}
`
    const wat = watOfSource(source)
    expect(wat).toContain('(func $draw (param $c externref) (param $n i32) (result i32)\n    (i32.add')
    expect(wat).toContain('(func $__export_draw (param externref) (param i32) (result i32)\n    (if (ref.is_null (local.get 0)) (then (unreachable)))\n    (call $draw (local.get 0) (local.get 1))')
    expect(wat).toContain('(export "draw" (func $__export_draw))')
    expect(wat).toContain('(export "many" (func $many))')
    expect(wat.match(/ref\.is_null/g)?.length).toBe(2)
    const { instance } = await WebAssembly.instantiate(await wasmOfSource(source), {})
    const m = instance.exports as Record<string, CallableFunction>
    const c = { name: 'c' }
    expect([m.draw(c, 4), m.many(c, 3)]).toEqual([5, 3])
    expect(() => m.draw(null, 4)).toThrow(/nreachable/)
    expect(() => m.many(null, 3)).toThrow(/nreachable/)
  })

  // Two modules' types of one name that are not one type are told apart in
  // a message by what each stands for.
  test('a message tells two types of one name apart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'encantis-host-'))
    try {
      await writeFile(join(dir, 'lib.ents'), 'type Canvas = host\nexport func keep(c: Canvas) -> Canvas => c\n')
      await writeFile(join(dir, 'main.ents'), 'type Canvas = i32\nimport "./lib" "keep" func keep(c: Canvas) -> Canvas\nexport func run(c: Canvas) -> Canvas => keep(c)\n')
      await expect(compileToWasm(join(dir, 'main.ents'))).rejects.toThrow('cannot assign Canvas (i32) to Canvas (a host type)')
      // A name for another host type is told apart by the type it names.
      await writeFile(join(dir, 'main.ents'), 'type Surface = host\ntype Canvas = Surface\nimport "./lib" "keep" func keep(c: Canvas) -> Canvas\nexport func run(c: Canvas) -> Canvas => keep(c)\n')
      await expect(compileToWasm(join(dir, 'main.ents'))).rejects.toThrow('argument 1: cannot assign Canvas (host type Surface) to Canvas (a host type)')
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  // Each module's names are its own (7.1): two modules of a program can
  // import host functions and globals under one name, the same ones or
  // others, and each calls its own
  test('two modules import host functions and globals under one name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'encantis-host-'))
    try {
      await writeFile(join(dir, 'gen.ents'), 'export func apply(comptime k: () -> u32) -> u32 => k()\n')
      await writeFile(join(dir, 'lib.ents'), `import "./gen.ents" ("apply" func apply(comptime k: () -> u32) -> u32)
import "env" "a" func f() -> u32
import "env" "now" func now() -> u32
import "env" "g" global g: u32
export func lib_code() -> u32 => f() * 100 + apply(now) * 10 + g
`)
      await writeFile(join(dir, 'main.ents'), `import "./lib.ents" ("lib_code" func lib_code() -> u32)
import "./gen.ents" ("apply" func apply(comptime k: () -> u32) -> u32)
import "env" "b" func f() -> u32
import "env" "now" func now() -> u32
import "env" "g2" global g: u32
export func m() -> u32 => lib_code() * 1000 + f() * 100 + apply(now) * 10 + g
`)
      const bytes = await compileToWasm(join(dir, 'main.ents'))
      const env = { a: () => 1, b: () => 2, now: () => 3, g: new WebAssembly.Global({ value: 'i32' }, 4), g2: new WebAssembly.Global({ value: 'i32' }, 5) }
      const { instance } = await WebAssembly.instantiate(bytes, { env })
      expect((instance.exports.m as () => number)()).toBe(134235)
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  // The test host gives each imported global the zero of its type: none
  // for an optional host reference.
  test('the tests of a module that imports globals run with their zeros', async () => {
    const source = `type Canvas = host
import "env" (
  "screen" global screen: ?Canvas
  "n" global n: i32
  "big" global big: i64
  "x" global x: f64
)
test "imported globals are zero" {
  assert screen == 0
  assert n == 0 && big == 0 && x == 0.0
}
`
    expect(await runTestsOfSource(source)).toEqual({ ran: ['imported globals are zero'], failed: [] })
    const types = importedGlobals(await wasmOfSource(source)).map((g) => `${g.module}.${g.name}: ${g.type}`)
    expect(types).toEqual(['env.screen: externref', 'env.n: i32', 'env.big: i64', 'env.x: f64'])
  })

  // A plain host global is never null, in a test too: the test host gives
  // it a stand-in, so the module starts and its tests run, also those that
  // never read it. One a test section imports is checked as well.
  test('the tests of a module that imports a plain one run with a stand-in', async () => {
    const source = `type Canvas = host
type Pair = (c: Canvas, n: i32)
import "env" (
  "screen" global screen: Canvas
  "pair" global pair: Pair
)
export func add(a: i32, b: i32) -> i32 => a + b
test "adds" {
  assert add(1, 2) == 3
}
test "the screen is there" {
  import "env" "spare" global spare: Canvas
  let o: ?Canvas = screen
  let p: ?Canvas = pair.c
  let q: ?Canvas = spare
  assert o != 0 && p != 0 && q != 0
}
`
    expect(await runTestsOfSource(source)).toEqual({ ran: ['adds', 'the screen is there'], failed: [] })
  })

  // A source module's imported globals are checked when the program
  // starts, not only the entry module's.
  test("a library's imported plain global is checked where the program starts", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'encantis-host-'))
    try {
      await writeFile(join(dir, 'lib.ents'), 'type Canvas = host\nimport "env" "scr" global scr: Canvas\nexport func screen() -> Canvas => scr\n')
      await writeFile(join(dir, 'main.ents'), 'type Canvas = host\nimport "./lib" "screen" func screen() -> Canvas\nexport func run() -> Canvas => screen()\n')
      const path = join(dir, 'main.ents')
      const load = await loadModule(path)
      const check = typecheckProgram(load.modules, path)
      expect(check.errors).toEqual([])
      const built = programToWatWithTests(load.modules, check.results, path)
      expect(built.wat).toMatch(/\(if \(ref\.is_null \(global\.get \$[\w$.-]*scr\)\) \(then \(unreachable\)\)\)/)
      expect(built.wat).toContain('(start $__host_globals)')
      expect(built.standIns).toEqual([{ module: 'env', name: 'scr' }])
      const bytes = await compileToWasm(path)
      const scr = { name: 'screen' }
      const { instance } = await WebAssembly.instantiate(bytes, { env: { scr: new WebAssembly.Global({ value: 'externref' }, scr) } })
      expect((instance.exports.run as CallableFunction)()).toBe(scr)
      await expect(WebAssembly.instantiate(bytes, { env: { scr: new WebAssembly.Global({ value: 'externref' }, null) } })).rejects.toThrow(/nreachable/)
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  // Only the modules whose tests are built have their test sections'
  // imports: a library's test-only import is not part of its importer's
  // test build, and is not checked there.
  test('a library test section import is not in its importer test build', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'encantis-host-'))
    try {
      await writeFile(join(dir, 'lib.ents'), 'type Canvas = host\nexport func one() -> i32 => 1\ntest "lib test" {\n  import "env" "scr" global scr: Canvas\n  let o: ?Canvas = scr\n  assert o != 0\n}\n')
      await writeFile(join(dir, 'main.ents'), 'import "./lib" "one" func one() -> i32\nexport func two() -> i32 => one() + 1\ntest "main test" {\n  assert two() == 2\n}\n')
      const path = join(dir, 'main.ents')
      const load = await loadModule(path, { includeTests: true })
      const check = typecheckProgram(load.modules, path, { includeTests: true })
      expect(check.errors).toEqual([])
      const built = programToWatWithTests(load.modules, check.results, path)
      expect(built.wat).not.toContain('"scr"')
      expect(built.wat).not.toContain('$__host_globals')
      expect(built.standIns).toEqual([])
      const lib = programToWatWithTests(load.modules, check.results, path, [join(dir, 'lib.ents')])
      expect(lib.standIns).toEqual([{ module: 'env', name: 'scr' }])
      expect(lib.wat).toContain('(start $__host_globals)')
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  test('two source modules share a host type by its name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'encantis-host-'))
    try {
      await writeFile(join(dir, 'lib.ents'), 'type Canvas = host\nglobal held: ?Canvas\nexport func keep(c: Canvas) -> Canvas {\n  held = c\n  return held ?? c\n}\n')
      await writeFile(join(dir, 'main.ents'), 'type Canvas = host\nimport "./lib" "keep" func keep(c: Canvas) -> Canvas\nexport func run(c: Canvas) -> Canvas => keep(c)\n')
      const { instance } = await WebAssembly.instantiate(await compileToWasm(join(dir, 'main.ents')), {})
      const run = instance.exports.run as CallableFunction
      const value = { name: 'shared' }
      expect(run(value)).toBe(value)
    } finally {
      await rm(dir, { recursive: true })
    }
  })
})
