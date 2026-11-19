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

global ctx: Context
global kept: Canvas

export func start(c: Canvas) {
  ctx = context(c)
  kept = c
}
export func draw(n: u32) {
  for i in n { fill(ctx, i as f32) }
}
export func same(c: Canvas) -> Canvas => c
export func pick(a: Canvas, b: Canvas, first: bool) -> Canvas => if first { a } else { b }
export func both(c: Canvas, n: i32) -> (c: Canvas, n: i32) => (c, n + 1)
export func kept-one() -> Canvas => kept
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

async function instance(wasm: Uint8Array, calls: unknown[][] = [], screen: unknown = null) {
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

  test('a global holds one from call to call, and is null until given one', async () => {
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

  test('null is 0 in the module and null in JavaScript', async () => {
    const source = `type Canvas = host
type Context = host
import "canvas" "context" func context(c: Canvas) -> Context

global ctx: Context = 0
export func start(c: Canvas) {
  if c != 0 { ctx = context(c) }
}
export func ready() -> bool => ctx != 0
export func reset() { ctx = 0 }
export func none() -> Canvas => 0
export func cast-none() -> Canvas => 0 as Canvas
export func is-null(c: Canvas) -> bool => c == 0
export func given-none() -> Context => context(0)
export func unset() -> Canvas {
  let c: Canvas
  return c
}
`
    const given: unknown[] = []
    const { instance } = await WebAssembly.instantiate(await wasmOfSource(source), {
      canvas: { context: (c: unknown) => (given.push(c), { of: c }) },
    })
    const m = instance.exports as Record<string, CallableFunction>
    expect(m.none()).toBe(null)
    expect(m['cast-none']()).toBe(null)
    expect(m.unset()).toBe(null)
    expect(m['is-null'](null)).toBe(1)
    expect(m['is-null']({})).toBe(0)
    // undefined is a value of the host's, not null.
    expect(m['is-null'](undefined)).toBe(0)
    m.start(null)
    expect(m.ready()).toBe(0)
    expect(given).toEqual([])
    m.start({ name: 'canvas' })
    expect(m.ready()).toBe(1)
    m.reset()
    expect(m.ready()).toBe(0)
    m['given-none']()
    expect(given.at(-1)).toBe(null)
  })

  test('two source modules share a host type by its name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'encantis-host-'))
    try {
      await writeFile(join(dir, 'lib.ents'), 'type Canvas = host\nglobal held: Canvas\nexport func keep(c: Canvas) -> Canvas {\n  held = c\n  return held\n}\n')
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
