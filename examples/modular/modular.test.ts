import { describe, test, expect } from 'bun:test'
import { loadModule } from '@encantis/compiler/loader'
import { typecheckProgram } from '@encantis/compiler/checker'
import { programToWat } from '@encantis/compiler/codegen'
import { resolve } from 'path'

describe('modular example', () => {
  test('compiles to one WAT module', async () => {
    const entryPath = resolve(import.meta.dir, 'main.ents')
    const load = await loadModule(entryPath)
    expect(load.errors).toEqual([])
    expect(load.modules.size).toBe(2)

    const check = typecheckProgram(load.modules, entryPath)
    expect(check.errors).toEqual([])

    const wat = programToWat(load.modules, check.results, entryPath)
    expect(wat).toContain('(module')
    expect(wat).toContain('$util$add')
    expect(wat).toContain('$util$mul')
    expect(wat).toContain('(export "square_sum"')
    expect(wat).not.toContain('(import "./')
  })
})
