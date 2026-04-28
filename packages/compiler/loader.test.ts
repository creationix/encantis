import { describe, test, expect } from 'bun:test'
import { loadModule, isSourceImport, resolveModulePath } from './loader'
import { typecheckProgram } from './checker'
import { programToWat } from './codegen'
import { resolve } from 'path'

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
    expect(result).toBe('/project/util.ents')
  })

  test('does not double-append .ents', () => {
    const result = resolveModulePath('./util.ents', '/project/main.ents')
    expect(result).toBe('/project/util.ents')
  })

  test('resolves relative to importing file directory', () => {
    const result = resolveModulePath('../lib/hash', '/project/src/main.ents')
    expect(result).toBe('/project/lib/hash.ents')
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
