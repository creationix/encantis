import { describe, test, expect } from 'bun:test'
import { loadModule, isSourceImport, resolveModulePath } from './loader'
import { typecheckProgram } from './checker'
import { programToWat, programToWatWithTests } from './codegen'
import { resolve } from 'path'
import { instantiate } from './test-utils'
import { createTestHost } from './test-host'
import wabt from 'wabt'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fixtures = resolve(import.meta.dir, 'tests/fixtures/modular')

describe('isSourceImport', () => {
  test('relative paths are source imports', () => {
    expect(isSourceImport('./foo')).toBe(true)
    expect(isSourceImport('../bar')).toBe(true)
    expect(isSourceImport('/absolute/path')).toBe(true)
  })

  test('host module names are not source imports', () => {
    expect(isSourceImport('env')).toBe(false)
    expect(isSourceImport('wasi_snapshot_preview1')).toBe(false)
  })
})

describe('resolveModulePath', () => {
  test('appends .ents extension', () => {
    const result = resolveModulePath('./util', '/project/main.ents')
    expect(result).toBe(resolve('/project/util.ents'))
  })

  test('does not double-append .ents', () => {
    const result = resolveModulePath('./util.ents', '/project/main.ents')
    expect(result).toBe(resolve('/project/util.ents'))
  })

  test('resolves relative to importing file directory', () => {
    const result = resolveModulePath('../lib/hash', '/project/src/main.ents')
    expect(result).toBe(resolve('/project/lib/hash.ents'))
  })
})

describe('loadModule', () => {
  test('loads a single file', async () => {
    const result = await loadModule(resolve(fixtures, 'util.ents'))
    expect(result.errors).toEqual([])
    expect(result.modules.size).toBe(1)
    expect(result.entry.module.decls.length).toBeGreaterThan(0)
  })

  test('loads multi-file project', async () => {
    const result = await loadModule(resolve(fixtures, 'main.ents'))
    expect(result.errors).toEqual([])
    expect(result.modules.size).toBe(2)
    expect(result.modules.has(resolve(fixtures, 'main.ents'))).toBe(true)
    expect(result.modules.has(resolve(fixtures, 'util.ents'))).toBe(true)
  })

  test('detects import cycles', async () => {
    const result = await loadModule(resolve(fixtures, 'cycle-a.ents'))
    expect(result.errors.length).toBe(1)
    expect(result.errors[0].message).toContain('cycle')
  })

  test('reports missing modules', async () => {
    const result = await loadModule(resolve(fixtures, 'nonexistent.ents'))
    expect(result.errors.length).toBe(1)
    expect(result.errors[0].message).toContain('not found')
  })

  test('caches modules loaded via multiple paths', async () => {
    // main.ents imports util.ents — loading util directly and via main
    // should result in the same cached module
    const result = await loadModule(resolve(fixtures, 'main.ents'))
    expect(result.errors).toEqual([])
    expect(result.modules.size).toBe(2)
  })
})

describe('cross-module type checking', () => {
  test('resolves symbols from imported module', async () => {
    const load = await loadModule(resolve(fixtures, 'main.ents'))
    expect(load.errors).toEqual([])
    const entryPath = resolve(fixtures, 'main.ents')
    const result = typecheckProgram(load.modules, entryPath)
    expect(result.errors).toEqual([])
    const entryResult = result.results.get(entryPath)!
    expect(entryResult.symbols.has('add')).toBe(true)
    expect(entryResult.symbols.has('double')).toBe(true)
  })

  test('reports symbol-not-found in imported module', async () => {
    const load = await loadModule(resolve(fixtures, 'bad-import.ents'))
    expect(load.errors).toEqual([])
    const entryPath = resolve(fixtures, 'bad-import.ents')
    const result = typecheckProgram(load.modules, entryPath)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0].message).toContain('nonexistent')
    expect(result.errors[0].message).toContain('not exported')
  })
})

describe('unified codegen', () => {
  test('unifies data sections from multiple modules', async () => {
    const load = await loadModule(resolve(fixtures, 'data-main.ents'))
    expect(load.errors).toEqual([])
    const entryPath = resolve(fixtures, 'data-main.ents')
    const check = typecheckProgram(load.modules, entryPath)
    expect(check.errors).toEqual([])
    const wat = programToWat(load.modules, check.results, entryPath)
    // Both data segments should appear in one data section
    expect(wat).toContain('hello')
    expect(wat).toContain('goodbye')
    // Only one memory declaration
    const memoryCount = (wat.match(/\(memory /g) || []).length
    expect(memoryCount).toBe(1)
  })

  test('each module reads its own literals, also where two stand at the same offset', async () => {
    // Literals are known by their offset in their module's source, and an
    // instance's by a private offset that is the same in every module for
    // the same place in the generic: lit-util.ents is padded so that both
    // pairs meet.
    const main = await Bun.file(resolve(fixtures, 'lit-main.ents')).text()
    const util = await Bun.file(resolve(fixtures, 'lit-util.ents')).text()
    expect(util.indexOf('"abcd"')).toBe(main.indexOf('"ABCD"'))
    expect(util.indexOf('"util"')).toBe(main.indexOf('"MAIN"'))
    expect(util.indexOf('func upick')).toBe(main.indexOf('func mpick'))
    const instance = await instantiate(resolve(fixtures, 'lit-main.ents'))
    const both = (instance.exports.both as () => number)() >>> 0
    // 'A', 'a', 'M', 'u'
    expect(both.toString(16)).toBe('41614d75')
  })

  test('errors on multiple memory declarations', async () => {
    const load = await loadModule(resolve(fixtures, 'mem-conflict.ents'))
    expect(load.errors).toEqual([])
    const entryPath = resolve(fixtures, 'mem-conflict.ents')
    const check = typecheckProgram(load.modules, entryPath)
    expect(check.errors).toEqual([])
    expect(() => programToWat(load.modules, check.results, entryPath)).toThrow(/Multiple memory declarations/)
  })

  test('compiles multi-file project to single WAT', async () => {
    const load = await loadModule(resolve(fixtures, 'main.ents'))
    expect(load.errors).toEqual([])
    const entryPath = resolve(fixtures, 'main.ents')
    const check = typecheckProgram(load.modules, entryPath)
    expect(check.errors).toEqual([])
    const wat = programToWat(load.modules, check.results, entryPath)
    // util's add should be mangled
    expect(wat).toContain('$util$add')
    // main's double should not be mangled (entry module)
    expect(wat).toContain('$double')
    // call to add should use mangled name
    expect(wat).toContain('(call $util$add')
    // only entry module exports reach wasm wall
    expect(wat).toContain('(export "double"')
    // util's export should NOT be a wasm-level export
    expect(wat).not.toContain('(export "add"')
    // no wasm-level source imports
    expect(wat).not.toContain('(import "./util"')
  })
})

// Generics across modules. tests/fixtures/generics has the plan's a09: a
// library of containers (containers.ents, on the bump stack of stack.ents)
// used by main.ents for a type it declares, with the hash and eq it writes;
// and other.ents, a second module that does the same next to main.
describe('generics across modules', () => {
  const generics = resolve(import.meta.dir, 'tests/fixtures/generics')
  const at = (name: string) => resolve(generics, name)

  async function program(entry: string, includeTests = false) {
    const load = await loadModule(entry, { includeTests })
    expect(load.errors).toEqual([])
    const check = typecheckProgram(load.modules, entry, { includeTests })
    return { load, check }
  }

  async function watOf(entry: string): Promise<string> {
    const { load, check } = await program(entry)
    expect(check.errors).toEqual([])
    return programToWat(load.modules, check.results, entry)
  }

  // The names of the functions of a module, in order
  const funcs = (wat: string) => [...wat.matchAll(/^ {2}\(func \$(\S+)/gm)].map((m) => m[1])
  // The functions a function calls, each once
  const callsIn = (wat: string, name: string) => {
    const start = wat.indexOf(`(func $${name} `)
    const end = wat.indexOf('\n  (func ', start + 1)
    return [...new Set([...wat.slice(start, end < 0 ? undefined : end).matchAll(/\(call \$(\S+?)[\s)]/g)].map((m) => m[1]))]
  }

  // The names of the tests of a program that fail
  async function failingTests(entry: string): Promise<string[]> {
    const { load, check } = await program(entry, true)
    expect(check.errors).toEqual([])
    const { wat, testNames } = programToWatWithTests(load.modules, check.results, entry)
    const w = await wabt()
    const parsed = w.parseWat('test.wat', wat, { simd: true, multi_value: true, bulk_memory: true })
    parsed.validate()
    const mod = await WebAssembly.compile(parsed.toBinary({}).buffer)
    parsed.destroy()
    expect(testNames.length).toBeGreaterThan(0)
    const failed: string[] = []
    for (const name of testNames) {
      let failedAt = -1
      const host = createTestHost(mod, (offset) => {
        failedAt = offset
      })
      const instance = await WebAssembly.instantiate(mod, host.imports)
      host.attach(instance)
      ;(instance.exports[`test_${name}`] as () => void)()
      if (failedAt >= 0) failed.push(name)
    }
    return failed
  }

  const cell = '<<x:i32|y:i32>>'

  test("a09: the library's generics, instantiated for the importer's type, pass its test", async () => {
    expect(await failingTests(at('main.ents'))).toEqual([])
  })

  test("a09: one instance per generic and type, calling the importer's hash and eq directly", async () => {
    const wat = await watOf(at('main.ents'))
    expect(funcs(wat)).toEqual([
      'hash',
      'eq',
      'visited',
      'total',
      'stack$mark',
      'stack$reset',
      'stack$alloc',
      'stack$extend',
      `containers$vec${cell}`,
      'containers$vec<u32>',
      `containers$push${cell}`,
      'containers$push<u32>',
      'containers$items<u32>',
      'containers$zeroed',
      `containers$table${cell}`,
      `containers$hashset${cell}`,
      `containers$slot${cell}`,
      `containers$add${cell}`,
    ])
    expect(callsIn(wat, `containers$add${cell}`)).toEqual(['hash', `containers$slot${cell}`, `containers$table${cell}`])
    expect(callsIn(wat, `containers$slot${cell}`)).toEqual(['eq'])
    expect(wat).not.toMatch(/call_indirect|\(table|\(elem|ref\.func|funcref/)
  })

  test('a09: the library compiled alone emits no generic and exports nothing', async () => {
    const wat = await watOf(at('containers.ents'))
    // zeroed is an ordinary function, and is emitted as every function is.
    expect(funcs(wat)).toEqual(['zeroed', 'stack$mark', 'stack$reset', 'stack$alloc', 'stack$extend'])
    expect(wat).not.toContain('(export')
  })

  test("two modules that push to a Vec(u32) share one instance, and each module's set calls its own hash", async () => {
    expect(await failingTests(at('other.ents'))).toEqual([])
    const wat = await watOf(at('other.ents'))
    const names = funcs(wat)
    for (const shared of ['vec<u32>', 'push<u32>', 'items<u32>', `table${cell}`, `hashset${cell}`]) {
      expect(names.filter((n) => n === `containers$${shared}`)).toHaveLength(1)
    }
    // main is checked first, so its instances keep the plain names.
    expect(callsIn(wat, `containers$add${cell}`)).toEqual(['main$hash', `containers$slot${cell}`, `containers$table${cell}`])
    expect(callsIn(wat, `containers$slot${cell}`)).toEqual(['main$eq'])
    const own = cell.replace(/>$/, '@other>')
    expect(callsIn(wat, `containers$add${own}`)).toEqual(['hash', `containers$slot${own}`, `containers$table${cell}`])
    expect(callsIn(wat, `containers$slot${own}`)).toEqual(['eq'])
  })

  // Sources written to a directory of their own, for the cases a fixture
  // would only repeat
  async function inDir<T>(files: Record<string, string>, run: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'encantis-modules-'))
    try {
      for (const [name, source] of Object.entries(files)) await writeFile(join(dir, name), source)
      return await run(dir)
    } finally {
      await rm(dir, { recursive: true })
    }
  }

  const SORT = `export func sort(comptime T: type, xs: []mut T, comptime before: (T, T) -> bool) {
  let p = xs.ptr
  for i in xs.len {
    let x = p[i]
    let j = i
    while j > 0 && before(x, p[j - 1]) {
      p[j] = p[j - 1]
      j -= 1
    }
    p[j] = x
  }
}
`
  const IMPORT_SORT = 'import "./sorting" "sort" func sort(comptime T: type, xs: []mut T, comptime before: (T, T) -> bool)\n'

  test("a comparator of a third module is called by its module's name, and one function makes one instance", async () => {
    const files = {
      'sorting.ents': SORT,
      'order.ents': 'export func descending(a: i32, b: i32) -> bool => a > b\n',
      'other.ents': `${IMPORT_SORT}import "./order" "descending" func descending(a: i32, b: i32) -> bool
export func down2(xs: []mut i32) { sort(xs, descending) }
`,
      'main.ents': `${IMPORT_SORT}import "./order" "descending" func descending(a: i32, b: i32) -> bool
import "./other" "down2" func down2(xs: []mut i32)
func ascending(a: i32, b: i32) -> bool => a < b
export func down(xs: []mut i32) { sort(xs, descending) }
export func up(xs: []mut i32) { xs.sort(ascending) }
`,
    }
    const wat = await inDir(files, (dir) => watOf(join(dir, 'main.ents')))
    expect(funcs(wat).filter((n) => n.startsWith('sorting$'))).toEqual(['sorting$sort<i32|ascending@main>', 'sorting$sort<i32|descending@order>'])
    expect(callsIn(wat, 'sorting$sort<i32|descending@order>')).toEqual(['order$descending'])
    expect(callsIn(wat, 'sorting$sort<i32|ascending@main>')).toEqual(['ascending'])
    expect(callsIn(wat, 'down')).toEqual(['sorting$sort<i32|descending@order>'])
    expect(callsIn(wat, 'other$down2')).toEqual(['sorting$sort<i32|descending@order>'])
  })
})
