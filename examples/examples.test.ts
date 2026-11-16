import { describe, test, expect } from 'bun:test'
import { loadModule } from '@encantis/compiler/loader'
import { typecheckProgram } from '@encantis/compiler/checker'
import { programToWatWithTests } from '@encantis/compiler/codegen'
import { createTestHost } from '@encantis/compiler/test-host'
import { resolve } from 'path'
import { readdir } from 'fs/promises'
import wabt from 'wabt'

const examplesDir = resolve(import.meta.dir)
// The shared library (lib/) has inline tests too.
const libDir = resolve(import.meta.dir, '../lib')
const repoDir = resolve(import.meta.dir, '..')

async function findEntsFiles(dir: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.name.endsWith('.ents')) {
      files.push(resolve(entry.parentPath, entry.name))
    }
  }
  return files.sort()
}

const entsFiles = [...(await findEntsFiles(examplesDir)), ...(await findEntsFiles(libDir))]

// An example with inline tests that fails to load, check, compile or validate
// registers a failing test instead of being skipped.
function buildFailed(rel: string, stage: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  describe(rel, () => {
    test('builds', () => {
      throw new Error(`${stage} failed: ${message}`)
    })
  })
}

for (const file of entsFiles) {
  const rel = file.startsWith(examplesDir) ? file.slice(examplesDir.length + 1) : file.slice(repoDir.length + 1)

  const load = await loadModule(file, { includeTests: true })
  const entryMod = load.modules.get(file)
  const hasTests = /^\s*test\s+"/m.test(entryMod?.source ?? (await Bun.file(file).text()))
  if (!hasTests) continue

  if (load.errors.length > 0) {
    buildFailed(rel, 'load', load.errors.map(e => e.message ?? String(e)).join('\n'))
    continue
  }

  const check = typecheckProgram(load.modules, file, { includeTests: true })
  if (check.errors.length > 0) {
    buildFailed(rel, 'check', check.errors.map(e => e.message ?? String(e)).join('\n'))
    continue
  }

  let result: ReturnType<typeof programToWatWithTests>
  try {
    result = programToWatWithTests(load.modules, check.results, file)
  } catch (err) {
    buildFailed(rel, 'codegen', err)
    continue
  }

  const { wat, testNames, testTitles } = result
  if (testNames.length === 0) continue

  const w = await wabt()
  let buffer: Uint8Array
  try {
    const wasmModule = w.parseWat(rel, wat, { simd: true, multi_value: true, bulk_memory: true })
    wasmModule.validate()
    buffer = wasmModule.toBinary({}).buffer
    wasmModule.destroy()
  } catch (err) {
    buildFailed(rel, 'wat validation', err)
    continue
  }

  const mod = await WebAssembly.compile(buffer)
  const source = entryMod?.source ?? ''

  describe(rel, () => {
    for (const [t, name] of testNames.entries()) {
      test(testTitles[t], async () => {
        let failedOffset = -1
        const host = createTestHost(mod, (offset) => { failedOffset = offset })
        const instance = await WebAssembly.instantiate(mod, host.imports)
        host.attach(instance)
        const fn = instance.exports[`test_${name}`] as Function
        fn()
        if (failedOffset >= 0) {
          const lines = source.split('\n')
          let line = 1
          let col = 1
          let pos = 0
          while (pos < failedOffset && line <= lines.length) {
            if (pos + lines[line - 1].length + 1 > failedOffset) {
              col = failedOffset - pos + 1
              break
            }
            pos += lines[line - 1].length + 1
            line++
          }
          const srcLine = lines[line - 1]?.trim() ?? ''
          throw new Error(`Assertion failed at ${rel}:${line}: ${srcLine}`)
        }
      })
    }
  })
}
