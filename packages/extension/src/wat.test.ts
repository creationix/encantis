// The WAT preview: a program compiled with what it imports, shown in each
// mode, and measured as the CLI would write it.

import { describe, expect, test } from 'bun:test'
import { optimizeWasm, watToWasm } from '@encantis/cli/src/wasm'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { compileToWat, renderWat, type ReadFile } from './wat'

const examples = resolve(import.meta.dir, '../../../examples')
const fromDisk: ReadFile = path => readFile(path, 'utf8').catch(() => null)
const optimize = (wasm: Uint8Array, level: 'optimize' | 'release') => optimizeWasm(wasm, level)

async function watOf(path: string, read: ReadFile = fromDisk, withTests = false): Promise<string> {
  const compiled = await compileToWat(path, read, withTests)
  if ('error' in compiled) throw new Error(compiled.error)
  return compiled.wat
}

describe('compileToWat', () => {
  test('compiles a program with the module it imports', async () => {
    const wat = await watOf(join(examples, 'modular/main.ents'))
    expect(wat).toContain('(export "square_sum"')
    expect(wat).toContain('i32.mul')
  })

  test('reads each file through readFile, the text being edited included', async () => {
    const main = join(examples, 'modular/main.ents')
    const asked: string[] = []
    const edited = 'export func twice(a: i32) -> i32 => a * 2\n'
    const wat = await watOf(main, path => {
      asked.push(path)
      return path === main ? Promise.resolve(edited) : fromDisk(path)
    })
    expect(asked).toEqual([main])
    expect(wat).toContain('(export "twice"')
  })

  test('says why a program does not compile', async () => {
    const path = '/virtual/bad.ents'
    const typeError = await compileToWat(path, async () => 'export func f() -> i32 => nope\n', false)
    expect(typeError).toEqual({ error: expect.stringContaining(';; Type errors:') })
    const missing = await compileToWat(path, async p => (p === path ? 'import "./gone" ("g" func g())\n' : null), false)
    expect(missing).toEqual({ error: expect.stringContaining('Module not found') })
    // Nested deeper than wabt reads (reference 2.12): 75 whiles
    let body = 'acc += 1'
    for (let i = 74; i >= 0; i--) body = `let w${i}: u32 = 0\nwhile w${i} < 1 {\nw${i} += 1\n${body}\n}`
    const deep = await compileToWat(path, async () => `export func run() -> u32 {\nlet acc: u32 = 0\n${body}\nreturn acc\n}\n`, false)
    expect(deep).toEqual({ error: expect.stringContaining(";; function 'run' nests its code 7620 deep in wasm") })
  })

  test('includes the tests only when asked', async () => {
    const main = join(examples, 'modular/main.ents')
    expect(await watOf(main)).not.toContain('(export "test:')
    expect(await watOf(main, fromDisk, true)).toContain('(export "test:')
  })
})

describe('renderWat', () => {
  const file = join(examples, 'math/arithmetic.ents')

  test('raw is the compiler WAT, measured as `encantis wasm` writes it', async () => {
    const wat = await watOf(file)
    const { text, wasmSize } = await renderWat(wat, 'raw', 'none')
    expect(text).toBe(wat)
    expect(wasmSize).toBe((await watToWasm(file, wat)).length)
  })

  test('flat and folded are what wabt reads back, with the compiler names', async () => {
    const wat = await watOf(file)
    const flat = await renderWat(wat, 'flat', 'none')
    const folded = await renderWat(wat, 'folded', 'none')
    expect(flat.text).toContain('(module')
    expect(folded.text).not.toBe(flat.text)
    expect(flat.wasmSize).toBe(folded.wasmSize)
    const name = wat.match(/\(func (\$[\w-]+)/)?.[1] ?? ''
    expect(name).not.toBe('')
    expect(flat.text).toContain(name)
  })

  test('optimized as `encantis wasm -O` and `--release` optimize', async () => {
    const wat = await watOf(file)
    const wasm = await watToWasm(file, wat)
    for (const level of ['optimize', 'release'] as const) {
      const { text, wasmSize } = await renderWat(wat, 'folded', level, optimize)
      expect(wasmSize).toBe((await optimizeWasm(wasm, level)).length)
      expect(text).toContain('(module')
    }
  })

  test('without an optimizer (the web) is never optimized', async () => {
    const wat = await watOf(file)
    const { wasmSize } = await renderWat(wat, 'folded', 'release')
    expect(wasmSize).toBe((await watToWasm(file, wat)).length)
  })

  test('says why the optimizer failed', async () => {
    const wat = await watOf(file)
    const { text, wasmSize } = await renderWat(wat, 'folded', 'optimize', () => Promise.reject(new Error('no binaryen')))
    expect(wasmSize).toBeNull()
    expect(text).toContain(';; optimization error: no binaryen')
  })
})
