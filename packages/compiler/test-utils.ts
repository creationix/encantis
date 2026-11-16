import { loadModule } from './loader'
import { typecheck, typecheckProgram } from './checker'
import { moduleToWat, programToWat } from './codegen'
import { parse } from './parser'
import { resolve } from 'path'
import wabt from 'wabt'

// The WAT of one module given as source text, checked without its tests as
// `encantis compile` does. Throws on a parse or check error.
export function watOfSource(source: string): string {
  const parsed = parse(source)
  if (parsed.errors.length > 0 || !parsed.module) {
    throw new Error(`Parse errors:\n${parsed.errors.map(e => e.message).join('\n')}`)
  }
  const check = typecheck(parsed.module, { includeTests: false })
  if (check.errors.length > 0) {
    throw new Error(`Type errors:\n${check.errors.map(e => e.message).join('\n')}`)
  }
  return moduleToWat(parsed.module, check)
}

// WAT to a validated binary, with the feature flags the command line uses.
export async function wasmOfWat(wat: string, name = 'test.wat'): Promise<Uint8Array> {
  const w = await wabt()
  const mod = w.parseWat(name, wat, { simd: true, multi_value: true, bulk_memory: true })
  try {
    mod.validate()
    return mod.toBinary({}).buffer
  } finally {
    mod.destroy()
  }
}

export async function wasmOfSource(source: string): Promise<Uint8Array> {
  return wasmOfWat(watOfSource(source))
}

export async function compileToWasm(entryPath: string): Promise<Uint8Array> {
  const absPath = resolve(entryPath)
  const load = await loadModule(absPath)
  if (load.errors.length > 0) {
    throw new Error(`Load errors in ${entryPath}:\n${load.errors.map(e => e.message).join('\n')}`)
  }

  const check = typecheckProgram(load.modules, absPath, { includeTests: false })
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
