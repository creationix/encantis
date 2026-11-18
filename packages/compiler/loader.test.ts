import { describe, test, expect } from 'bun:test'
import { loadModule, isSourceImport, resolveModulePath } from './loader'
import { typecheckProgram } from './checker'
import { programToWat, programToWatWithTests } from './codegen'
import { resolve } from 'path'
import { compileToWasm, instantiate } from './test-utils'
import { createTestHost } from './test-host'
import wabt from 'wabt'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

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

  test('reads files through the reader it is given', async () => {
    // The editor gives the documents it has open, which can differ from
    // what is on disk, and has no disk at all in a browser.
    const files = new Map([
      [resolve('/memory/main.ents'), 'import "./lib" "max" func max(comptime T: type, a: T, b: T) -> T\nexport func f(a: u32) -> u32 => max(a, 1)\n'],
      [resolve('/memory/lib.ents'), 'export func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }\n'],
    ])
    const read: string[] = []
    const readFile = async (path: string) => {
      read.push(path)
      return files.get(path) ?? null
    }
    const result = await loadModule('/memory/main.ents', { readFile })
    expect(result.errors).toEqual([])
    expect([...result.modules.keys()]).toEqual([resolve('/memory/main.ents'), resolve('/memory/lib.ents')])
    expect(read).toEqual([resolve('/memory/main.ents'), resolve('/memory/lib.ents')])
    const check = typecheckProgram(result.modules, resolve('/memory/main.ents'))
    expect(check.errors).toEqual([])
    const missing = await loadModule('/memory/other.ents', { readFile })
    expect(missing.errors.map((e) => e.message)).toEqual([`Module not found: ${resolve('/memory/other.ents')}`])
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

  // Z9: the program of three modules is the module written out by hand in
  // one file (byhand.ents): the same functions with the same bodies, once
  // each name of a function or global is read as its counterpart and scratch
  // locals, which are named after where they are in the source, are read
  // alike; and, since names do not reach the .wasm file, the same bytes.
  test('a09 is its single-file hand specialisation: function for function, and byte for byte', async () => {
    const renamed: Record<string, string> = {
      'stack$mark': 'mark',
      'stack$reset': 'reset',
      'stack$alloc': 'alloc',
      'stack$extend': 'extend',
      'stack$top': 'top',
      [`containers$vec${cell}`]: 'vec_cell',
      'containers$vec<u32>': 'vec_u32',
      [`containers$push${cell}`]: 'push_cell',
      'containers$push<u32>': 'push_u32',
      'containers$items<u32>': 'items_u32',
      'containers$zeroed': 'zeroed',
      [`containers$table${cell}`]: 'table_cell',
      [`containers$hashset${cell}`]: 'hashset_cell',
      [`containers$slot${cell}`]: 'slot_cell',
      [`containers$add${cell}`]: 'add_cell',
    }
    const read = (wat: string, names: Record<string, string>) => {
      let text = wat
      for (const [from, to] of Object.entries(names)) {
        for (const end of [' ', ')', '\n']) text = text.split(`$${from}${end}`).join(`$${to}${end}`)
      }
      text = text.replace(/\$(__[a-z_]+?)_\d+/g, (_m, name) => `$${name}_#`)
      const bodies = [...text.matchAll(/^ {2}\(func \$(\S+)[\s\S]*?^ {2}\)$/gm)].map((m) => m[0])
      const rest = text.replace(/^ {2}\(func \$(\S+)[\s\S]*?^ {2}\)$/gm, '').split('\n').filter((l) => l.trim())
      return { bodies, rest }
    }
    const generic = read(await watOf(at('main.ents')), renamed)
    const byHand = read(await watOf(at('byhand.ents')), {})
    expect(generic.bodies).toHaveLength(18)
    expect(generic.bodies).toEqual(byHand.bodies)
    expect(generic.rest).toEqual(byHand.rest)
    expect(Buffer.from(await compileToWasm(at('main.ents'))).equals(Buffer.from(await compileToWasm(at('byhand.ents'))))).toBe(true)
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
    const own = `${cell}@other`
    expect(callsIn(wat, `containers$add${own}`)).toEqual(['hash', `containers$slot${own}`, `containers$table${cell}`])
    expect(callsIn(wat, `containers$slot${own}`)).toEqual(['eq'])
  })

  test("a type without the hash the library's set calls: the library's error, and one at the call that asked", async () => {
    const { check } = await program(at('nohash.ents'))
    const lib = await Bun.file(at('containers.ents')).text()
    const main = await Bun.file(at('nohash.ents')).text()
    const inAdd = lib.indexOf('hash(k)')
    const call = main.indexOf('add(Cell(x, 1))')
    expect(check.results.get(at('containers.ents'))?.errors).toEqual([
      {
        offset: inAdd,
        message: "no function 'hash' accepts (Cell), in add(K = Cell)",
        notes: [{ offset: call, message: 'required from', path: at('nohash.ents') }],
      },
    ])
    expect(check.results.get(at('nohash.ents'))?.errors).toEqual([
      { offset: call, message: "add(K = Cell) cannot be instantiated: no function 'hash' accepts (Cell) (containers.ents:77:11)" },
    ])
    // The library was checked, and found sound, before this module asked
    // for the instance: the program's errors are what its modules hold at
    // the end, and they stop the build.
    expect(check.errors.map((e) => e.message)).toEqual([
      "no function 'hash' accepts (Cell), in add(K = Cell)",
      "add(K = Cell) cannot be instantiated: no function 'hash' accepts (Cell) (containers.ents:77:11)",
    ])
    expect((await program(at('containers.ents'))).check.errors).toEqual([])
  })

  // Sources written to a directory of their own, for the cases a fixture
  // would only repeat
  async function inDir<T>(files: Record<string, string>, run: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'encantis-modules-'))
    try {
      for (const [name, source] of Object.entries(files)) {
        await mkdir(dirname(join(dir, name)), { recursive: true })
        await writeFile(join(dir, name), source)
      }
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

  // The site is the module whose ordinary code started the chain, however
  // many generics of how many modules the chain goes through; and a generic
  // that calls an instance which is a site's own is that site's own too.
  test('a chain through generics of two modules looks up at the module that started it', async () => {
    const files = {
      'p.ents': 'export func bucket(comptime K: type, k: K, n: u32) -> u32 => hash(k) % n\n',
      'o.ents': 'import "./p" "bucket" func bucket(comptime K: type, k: K, n: u32) -> u32\nexport func wrapper(comptime K: type, k: K) -> u32 => bucket(k, 4)\n',
      'n.ents': 'import "./o" "wrapper" func wrapper(comptime K: type, k: K) -> u32\ntype Cell = (x: i32, y: i32)\nfunc hash(c: Cell) -> u32 => c.x as u32\nexport func g(c: Cell) -> u32 => wrapper(c)\n',
      'm.ents': 'import "./o" "wrapper" func wrapper(comptime K: type, k: K) -> u32\nimport "./n" "g" func g(c: (x: i32, y: i32)) -> u32\ntype Cell = (x: i32, y: i32)\nfunc hash(c: Cell) -> u32 => c.y as u32\nexport func f(c: Cell) -> u32 => wrapper(c) * 10 + g(c)\n',
    }
    await inDir(files, async (dir) => {
      const wat = await watOf(join(dir, 'm.ents'))
      const m = `${cell}@m`
      expect(callsIn(wat, `p$bucket${cell}`)).toEqual(['n$hash'])
      expect(callsIn(wat, `p$bucket${m}`)).toEqual(['hash'])
      expect(callsIn(wat, `o$wrapper${cell}`)).toEqual([`p$bucket${cell}`])
      expect(callsIn(wat, `o$wrapper${m}`)).toEqual([`p$bucket${m}`])
      const instance = await instantiate(join(dir, 'm.ents'))
      // m's hash is y, n's is x: (7 % 4) * 10 + 5 % 4
      expect((instance.exports.f as (x: number, y: number) => number)(5, 7)).toBe(31)
    })
  })

  // A module's own function given for a comptime parameter, and a function
  // of the generic's module found at the site, are two things however they
  // are named: each call runs the function it names, in either order.
  test("a site's own function of a name the generic's module also has is not taken for that one", async () => {
    const LIB = 'export func apply(comptime T: type, x: T, comptime f: (T) -> T) -> T => f(hook(x))\nexport func inc(x: i32) -> i32 => x + 1\n'
    const IMPORT = 'import "./lib" (\n  "apply" func apply(comptime T: type, x: T, comptime f: (T) -> T) -> T\n  "inc" func linc(x: i32) -> i32\n)\n'
    const B = 'func hook(x: i32) -> i32 => x * 100\nfunc inc(x: i32) -> i32 => x - 1\n'
    for (const calls of [
      'export func b1(x: i32) -> i32 => apply(x, linc)\nexport func b2(x: i32) -> i32 => apply(x, inc)\n',
      'export func b2(x: i32) -> i32 => apply(x, inc)\nexport func b1(x: i32) -> i32 => apply(x, linc)\n',
    ]) {
      const files = {
        'lib.ents': LIB,
        'a.ents': `${IMPORT}func hook(x: i32) -> i32 => x * 10\nexport func a(x: i32) -> i32 => apply(x, linc)\n`,
        'b.ents': `${IMPORT}${B}${calls}`,
        'main.ents': 'import "./a" "a" func a(x: i32) -> i32\nimport "./b" ("b1" func b1(x: i32) -> i32  "b2" func b2(x: i32) -> i32)\nexport func fa(x: i32) -> i32 => a(x)\nexport func fb1(x: i32) -> i32 => b1(x)\nexport func fb2(x: i32) -> i32 => b2(x)\n',
      }
      await inDir(files, async (dir) => {
        const instance = await instantiate(join(dir, 'main.ents'))
        const run = (name: string) => (instance.exports[name] as (x: number) => number)(1)
        // lib's inc of a's hook, lib's inc of b's hook, b's inc of b's hook
        expect([run('fa'), run('fb1'), run('fb2')]).toEqual([11, 101, 99])
      })
    }
  })

  // What a site lookup finds is what tells instances apart: two modules
  // whose hash is one module's share the instance, and a module with a hash
  // of its own has its own.
  test("sites whose functions of the names looked up are the same functions share the instance", async () => {
    const CELL = 'type Cell = (x: i32, y: i32)\n'
    const IMPORTS = `import "./p" "bucket" func bucket(comptime K: type, k: K, n: u32) -> u32\nimport "./cells" "hash" func hash(c: (x: i32, y: i32)) -> u32\n${CELL}`
    const files = {
      'p.ents': 'export func bucket(comptime K: type, k: K, n: u32) -> u32 => hash(k) % n\n',
      'cells.ents': `${CELL}export func hash(c: Cell) -> u32 => c.x as u32\n`,
      'a.ents': `${IMPORTS}export func fa(c: Cell) -> u32 => bucket(c, 4)\n`,
      'b.ents': `${IMPORTS}export func fb(c: Cell) -> u32 => bucket(c, 4)\n`,
      'c.ents': `import "./p" "bucket" func bucket(comptime K: type, k: K, n: u32) -> u32\n${CELL}func hash(c: Cell) -> u32 => c.y as u32\nexport func fc(c: Cell) -> u32 => bucket(c, 4)\n`,
      'main.ents': 'import "./a" "fa" func fa(c: (x: i32, y: i32)) -> u32\nimport "./b" "fb" func fb(c: (x: i32, y: i32)) -> u32\nimport "./c" "fc" func fc(c: (x: i32, y: i32)) -> u32\nexport func f(x: i32, y: i32) -> u32 => fa((x, y)) * 100 + fb((x, y)) * 10 + fc((x, y))\n',
    }
    await inDir(files, async (dir) => {
      const wat = await watOf(join(dir, 'main.ents'))
      expect(funcs(wat).filter((n) => n.startsWith('p$'))).toEqual([`p$bucket${cell}`, `p$bucket${cell}@c`])
      expect(callsIn(wat, `p$bucket${cell}`)).toEqual(['cells$hash'])
      expect(callsIn(wat, `p$bucket${cell}@c`)).toEqual(['c$hash'])
      const instance = await instantiate(join(dir, 'main.ents'))
      expect((instance.exports.f as (x: number, y: number) => number)(5, 7)).toBe(113)
    })
  })

  // A function given for a comptime parameter is the function, under
  // whichever name a module imports it.
  test('one function given under two names makes one instance', async () => {
    const files = {
      'util.ents': 'export func inc(x: i32) -> i32 => x + 1\n',
      'lib.ents': 'import "./util" "inc" func uinc(x: i32) -> i32\nexport func apply(comptime T: type, x: T, comptime f: (T) -> T) -> T => f(x)\nexport func lib_inc(x: i32) -> i32 => apply(x, uinc)\n',
      'main.ents': 'import "./lib" (\n  "apply" func apply(comptime T: type, x: T, comptime f: (T) -> T) -> T\n  "lib_inc" func lib_inc(x: i32) -> i32\n)\nimport "./util" "inc" func inc(x: i32) -> i32\nexport func f(x: i32) -> i32 => apply(x, inc) + lib_inc(x)\n',
    }
    await inDir(files, async (dir) => {
      const wat = await watOf(join(dir, 'main.ents'))
      expect(funcs(wat).filter((n) => n.startsWith('lib$apply'))).toEqual(['lib$apply<i32|inc@util>'])
      expect(callsIn(wat, 'lib$apply<i32|inc@util>')).toEqual(['util$inc'])
    })
  })

  // However deep in the library the error is, the module that asked has one
  // error at its call, naming the error and where it is; and the calls in
  // between, in whichever modules, have none.
  test('an error deep in a chain is told once at the call of ordinary code that started it', async () => {
    const files = {
      'lib.ents': 'export func slot(comptime K: type, k: K) -> bool => eq(k, k)\nexport func add(comptime K: type, k: K) -> u32 => if slot(k) { hash(k) } else { 0 }\n',
      'main.ents': 'import "./lib" "add" func add(comptime K: type, k: K) -> u32\ntype Cell = (x: i32, y: i32)\nfunc hash(c: Cell) -> u32 => c.x as u32\nexport func f(c: Cell) -> u32 => add(c)\n',
    }
    await inDir(files, async (dir) => {
      const { check } = await program(join(dir, 'main.ents'))
      expect(check.results.get(join(dir, 'lib.ents'))?.errors.map((e) => e.message)).toEqual(["no function 'eq' accepts (Cell, Cell), in slot(K = Cell)"])
      expect(check.results.get(join(dir, 'main.ents'))?.errors.map((e) => e.message)).toEqual([
        "add(K = Cell) cannot be instantiated: no function 'eq' accepts (Cell, Cell), in slot(K = Cell) (lib.ents:1:53)",
      ])
    })
    const chain = {
      'b.ents': 'export func g(comptime T: type, x: T) -> T => x * x\n',
      'a.ents': 'import "./b" "g" func g(comptime T: type, x: T) -> T\nexport func f(comptime T: type, x: T) -> T => g(x)\n',
      'main.ents': 'import "./a" "f" func f(comptime T: type, x: T) -> T\ntype Pt = (x: i32, y: i32)\nexport func h(p: Pt) -> i32 => f(p).x\n',
    }
    await inDir(chain, async (dir) => {
      const { check } = await program(join(dir, 'main.ents'))
      const errors = (name: string) => check.results.get(join(dir, name))?.errors.map((e) => e.message)
      expect(errors('b.ents')).toEqual(["'*' cannot be applied to Pt and Pt, in g(T = Pt)"])
      expect(errors('a.ents')).toEqual([])
      expect(errors('main.ents')).toEqual(["f(T = Pt) cannot be instantiated: '*' cannot be applied to Pt and Pt, in g(T = Pt) (b.ents:1:47)"])
    })
  })

  // Two modules with one file name are two modules in the output too: their
  // functions and instances have a prefix each.
  test('two modules with one file name have their own functions and instances', async () => {
    const files = {
      'x/lib.ents': 'export func big(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }\nexport func tag() -> u32 => 1\n',
      'y/lib.ents': 'export func big(comptime T: type, a: T, b: T) -> T => if a < b { a } else { b }\nexport func tag() -> u32 => 2\n',
      'main.ents': 'import "./x/lib" ("big" func xbig(comptime T: type, a: T, b: T) -> T  "tag" func xtag() -> u32)\nimport "./y/lib" ("big" func ybig(comptime T: type, a: T, b: T) -> T  "tag" func ytag() -> u32)\nexport func run() -> u32 => xbig(3:u32, 5) * 1000 + ybig(3:u32, 5) * 100 + xtag() * 10 + ytag()\n',
    }
    await inDir(files, async (dir) => {
      const wat = await watOf(join(dir, 'main.ents'))
      expect(funcs(wat)).toEqual(['run', 'lib$big<u32>', 'lib$tag', 'lib~2$big<u32>', 'lib~2$tag'])
      const instance = await instantiate(join(dir, 'main.ents'))
      expect((instance.exports.run as () => number)()).toBe(5312)
    })
  })

  // Each mistake in importing a generic is one error, and the uses of what
  // was not imported say nothing more.
  test('a wrong generic import is one error', async () => {
    const LIB = 'export func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32)\nexport func len(comptime T: type, v: *Vec(T)) -> u32 => v.len\nexport func plain(x: u32) -> u32 => x\n'
    const cases: [string, string][] = [
      ['import "./lib" "Vec" func Vec(comptime T: type) -> type\nfunc Vec(comptime T: type) -> type => (ptr: [*]T)\nexport func f(v: *Vec(u32)) -> u32 => v.ptr[0]\n', "'Vec' is already declared: a generic type's name is unique in its module"],
      ['import "./lib" "plain" func Plain(comptime T: type) -> type\nexport func f(v: *Plain(u32)) -> u32 => 0\n', "'plain' in './lib' is not a generic type"],
      ['import "./lib" "Nope" func Nope(comptime T: type) -> type\nexport func f(v: *Nope(u32)) -> u32 => 0\n', "'Nope' is not exported from './lib'"],
      ['import "./lib" "len" func len(comptime T: type, v: *Vec(T)) -> u32\nfunc len(x: u32) -> u32 => x\n', "'len' is already declared: a generic function's name is unique in its module"],
    ]
    for (const [main, message] of cases) {
      const errors = await inDir({ 'lib.ents': LIB, 'main.ents': main }, async (dir) => (await program(join(dir, 'main.ents'))).check.errors)
      expect(errors.map((e) => e.message)).toEqual([message])
    }
  })

  // The literals of an instance are its module's: they are laid out with
  // that module's, where an instance asked for there would have them, and
  // read through that module's map, also where an offset of the module that
  // asked meets one of the instance's.
  test("an instance another module asks for reads its own module's literals", async () => {
    const files = {
      'names.ents': 'export func name(comptime T: type, x: T) -> []u8 => "lib"\n',
      'main.ents': `import "./names" "name" func name(comptime T: type, x: T) -> []u8
export func f() -> u32 {
  let mine = "MAIN"
  let theirs = name(1:u8)
  return ((mine[0] ?? 0) as u32) << 8 | ((theirs[0] ?? 0) as u32)
}
`,
    }
    await inDir(files, async (dir) => {
      const instance = await instantiate(join(dir, 'main.ents'))
      expect((instance.exports.f as () => number)()).toBe(('M'.charCodeAt(0) << 8) | 'l'.charCodeAt(0))
    })
  })

  // A requirement is looked up in the generic's module and at the site, and
  // nowhere else: a function a third module has is found only where the
  // site imports it, and then it is that module's function that is called.
  test('a requirement that only a third module provides is found only where the site imports it', async () => {
    const BUCKET = 'export func bucket(comptime K: type, k: K, n: u32) -> u32 => hash(k) % n\n'
    const CELL = 'type Cell = (x: i32, y: i32)\n'
    const files = {
      'buckets.ents': BUCKET,
      'cells.ents': `${CELL}export func hash(c: Cell) -> u32 => (c.x * 31 + c.y) as u32\n`,
      'without.ents': `import "./buckets" "bucket" func bucket(comptime K: type, k: K, n: u32) -> u32\n${CELL}export func f(c: Cell) -> u32 => bucket(c, 8)\n`,
      'with.ents': `import "./buckets" "bucket" func bucket(comptime K: type, k: K, n: u32) -> u32\nimport "./cells" "hash" func hash(c: (x: i32, y: i32)) -> u32\n${CELL}export func f(c: Cell) -> u32 => c.bucket(8)\n`,
    }
    await inDir(files, async (dir) => {
      const { check } = await program(join(dir, 'without.ents'))
      expect(check.errors.map((e) => e.message)).toEqual([
        "no function 'hash' accepts (Cell), in bucket(K = Cell)",
        "bucket(K = Cell) cannot be instantiated: no function 'hash' accepts (Cell) (buckets.ents:1:62)",
      ])
      const wat = await watOf(join(dir, 'with.ents'))
      expect(callsIn(wat, `buckets$bucket${cell}`)).toEqual(['cells$hash'])
      const instance = await instantiate(join(dir, 'with.ents'))
      expect((instance.exports.f as (x: number, y: number) => number)(2, 3)).toBe((2 * 31 + 3) % 8)
    })
  })

  // The containers of lib/, used from another module
  const lib = resolve(import.meta.dir, '../../lib')
  const VEC = `import "${lib}/vec" (
  "Vec" func Vec(comptime T: type) -> type
  "vec" func vec(comptime T: type, cap: u32) -> *mut Vec(T)
  "push" func push(comptime T: type, v: *mut Vec(T), x: T)
  "items" func items(comptime T: type, v: *Vec(T)) -> []T
)
`

  // lib/sort's sort calls the builtin min. A builtin answers in every
  // module, so the instance does not depend on the module that asked: two
  // modules that sort one type with one comparator share it.
  test("a builtin in a generic's body does not make its instance a site's own", async () => {
    const SORT = `import "${lib}/sort" "sort" func sort(comptime T: type, xs: []mut T, comptime before: (T, T) -> bool)\nimport "./order" "descending" func descending(a: u32, b: u32) -> bool\n`
    const files = {
      'order.ents': 'export func descending(a: u32, b: u32) -> bool => a > b\n',
      'other.ents': `${SORT}export func down2(xs: []mut u32) { xs.sort(descending) }\n`,
      // A function of the module named like the builtin changes nothing.
      'main.ents': `${SORT}import "./other" "down2" func down2(xs: []mut u32)\nfunc min(a: u32, b: u32) -> u32 => a\nexport func down(xs: []mut u32) { xs.sort(descending) }\nexport func least(a: u32) -> u32 => min(a, 1)\n`,
    }
    const wat = await inDir(files, (dir) => watOf(join(dir, 'main.ents')))
    expect(funcs(wat).filter((n) => n.startsWith('sort$sort<'))).toEqual(['sort$sort<u32|descending@order>'])
    expect(callsIn(wat, 'down')).toEqual(['sort$sort<u32|descending@order>'])
    expect(callsIn(wat, 'other$down2')).toEqual(['sort$sort<u32|descending@order>'])
    expect(callsIn(wat, 'sort$sort<u32|descending@order>')).not.toContain('min')
  })

  test('a library file compiled alone emits no generic, and exports none', async () => {
    for (const name of ['stack', 'vec', 'set', 'map', 'sort']) {
      const wat = await watOf(join(lib, `${name}.ents`))
      expect(funcs(wat).filter((n) => n.includes('<'))).toEqual([])
      const exported = [...wat.matchAll(/\(export "([^"]+)"/g)].map((m) => m[1])
      for (const generic of ['Vec', 'vec', 'push', 'pop', 'items', 'Set', 'hashset', 'add', 'has', 'Map', 'map', 'insert', 'lookup', 'sort']) {
        expect(exported).not.toContain(generic)
      }
    }
  })

  // A fixed array for T is a table of rows (reference 2.5, owner decision
  // Q1): an element of the Vec's [*]mut [3]i32 is a pointer to its row, and
  // push, which stores a T there and computes the storage in sizeof(T), is
  // refused for it, never compiled to something that is wrong. A struct of
  // one field lies in place.
  test('Vec([3]i32) is refused in push with the table rule, and Vec((cells: [3]i32)) is packed', async () => {
    const files = {
      'rows.ents': `${VEC}export func f(r: *[3]i32) -> u32 {
  let rows = vec([3]i32, 2)
  rows.push(r.*)
  return rows.len
}
`,
      'packed.ents': `${VEC}type Row = (cells: [3]i32)
export func f(n: i32) -> i32 {
  let rows = vec(Row, 1)
  for i in 3 {
    rows.push(Row([n, i as i32, 7]))
  }
  let words = rows.ptr as [*]i32
  return words[8] + words[3] * 10
}
`,
    }
    await inDir(files, async (dir) => {
      const { check } = await program(join(dir, 'rows.ents'))
      const errors = check.results.get(join(lib, 'vec.ents'))?.errors ?? []
      expect(errors.map((e) => e.message)).toEqual(['cannot assign [3]i32 to *mut [3]i32, in push(T = [3]i32)'])
      expect(errors[0].notes?.[0].message).toStartWith('in a [*]mut [3]i32 each element is a pointer to its row (reference 2.5)')
      expect(check.results.get(join(dir, 'rows.ents'))?.errors.map((e) => e.message)).toEqual([
        'push(T = [3]i32) cannot be instantiated: cannot assign [3]i32 to *mut [3]i32 (vec.ents:53:18)',
      ])
      const instance = await instantiate(join(dir, 'packed.ents'))
      // Rows of 12 bytes one after another: word 8 is the last row's 7, word 3 the second row's n.
      expect((instance.exports.f as (n: number) => number)(5)).toBe(57)
    })
  })
})
