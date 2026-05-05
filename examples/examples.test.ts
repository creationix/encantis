import { describe, test, expect } from 'bun:test'
import { loadModule } from '@encantis/compiler/loader'
import { typecheckProgram } from '@encantis/compiler/checker'
import { programToWatWithTests } from '@encantis/compiler/codegen'
import { resolve } from 'path'
import { readdir } from 'fs/promises'
import wabt from 'wabt'

const examplesDir = resolve(import.meta.dir)

async function findEntsFiles(dir: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.name.endsWith('.ents')) {
      files.push(resolve(entry.parentPath, entry.name))
    }
  }
  return files.sort()
}

const entsFiles = await findEntsFiles(examplesDir)

for (const file of entsFiles) {
  const rel = file.slice(examplesDir.length + 1)

  const load = await loadModule(file, { includeTests: true })
  if (load.errors.length > 0) continue

  const entryMod = load.modules.get(file)
  const hasTests = entryMod?.module.decls.some(d => d.kind === 'TestDecl')
  if (!hasTests) continue

  const check = typecheckProgram(load.modules, file, { includeTests: true })
  if (check.errors.length > 0) continue

  let result: ReturnType<typeof programToWatWithTests>
  try {
    result = programToWatWithTests(load.modules, check.results, file)
  } catch {
    continue
  }

  const { wat, testNames } = result
  if (testNames.length === 0) continue

  const w = await wabt()
  let buffer: Uint8Array
  try {
    const wasmModule = w.parseWat(rel, wat, { simd: true, multi_value: true, bulk_memory: true })
    wasmModule.validate()
    buffer = wasmModule.toBinary({}).buffer
    wasmModule.destroy()
  } catch {
    continue
  }

  const mod = await WebAssembly.compile(buffer)
  const source = entryMod?.source ?? ''

  describe(rel, () => {
    for (const name of testNames) {
      test(name.replace(/_/g, ' '), async () => {
        let failedOffset = -1
        const instance = await WebAssembly.instantiate(mod, {
          test: {
            __assert_fail: (offset: number) => { failedOffset = offset },
          },
        })
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
