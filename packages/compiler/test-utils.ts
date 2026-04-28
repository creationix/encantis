import { loadModule } from './loader'
import { typecheckProgram } from './checker'
import { programToWat } from './codegen'
import { resolve } from 'path'
import wabt from 'wabt'

export async function compileToWasm(entryPath: string): Promise<Uint8Array> {
  const absPath = resolve(entryPath)
  const load = await loadModule(absPath)
  if (load.errors.length > 0) {
    throw new Error(`Load errors in ${entryPath}:\n${load.errors.map(e => e.message).join('\n')}`)
  }

  const check = typecheckProgram(load.modules, absPath)
  if (check.errors.length > 0) {
    throw new Error(`Type errors in ${entryPath}:\n${check.errors.map(e => e.message).join('\n')}`)
  }

  const wat = programToWat(load.modules, check.results, absPath)
  const w = await wabt()
  const mod = w.parseWat(entryPath, wat, { simd: true, multi_value: true, bulk_memory: true })
  mod.validate()
  const { buffer } = mod.toBinary({})
  mod.destroy()
  return buffer
}

export async function instantiate(entryPath: string, imports?: Record<string, Record<string, Function | WebAssembly.Global | WebAssembly.Memory | WebAssembly.Table | number>>): Promise<WebAssembly.Instance> {
  const buffer = await compileToWasm(entryPath)
  const module = await WebAssembly.compile(buffer)
  return WebAssembly.instantiate(module, imports)
}
