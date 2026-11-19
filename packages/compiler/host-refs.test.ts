// Host references (reference 2.13) as the host sees them: JavaScript values
// handed in, held in registers and globals, given to the host's functions and
// handed back, the same values. What the checker refuses is in the
// reference's spec region.

import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileToWasm, wasmOfSource, watOfSource } from './test-utils'

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
  // literal, a branch with no type of its own, a def, an instance) is the
  // null reference as well, not an i32.
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

  // Two modules' types of one name that are not one type are told apart in
  // a message by what each stands for.
  test('a message tells two types of one name apart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'encantis-host-'))
    try {
      await writeFile(join(dir, 'lib.ents'), 'type Canvas = host\nexport func keep(c: Canvas) -> Canvas => c\n')
      await writeFile(join(dir, 'main.ents'), 'type Canvas = i32\nimport "./lib" "keep" func keep(c: Canvas) -> Canvas\nexport func run(c: Canvas) -> Canvas => keep(c)\n')
      await expect(compileToWasm(join(dir, 'main.ents'))).rejects.toThrow('cannot assign Canvas (i32) to Canvas (a host type)')
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
