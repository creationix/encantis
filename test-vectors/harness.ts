// Layout-agnostic test harness for Encantis wasm modules
// Discovers entrypoints and buffers from the wasm export table.
// No fixed offsets — adapts to whatever the program exports.

export interface WasmHarness {
  instance: WebAssembly.Instance
  memory: WebAssembly.Memory | null
  exports: Record<string, Function>
  writeInput(data: Uint8Array, exportName?: string): { ptr: number; len: number }
  readOutput(ptr: number, len: number): Uint8Array
  call(name: string, ...args: unknown[]): unknown
}

export async function createHarness(
  wasmBuffer: Uint8Array,
  imports?: WebAssembly.Imports,
): Promise<WasmHarness> {
  const module = await WebAssembly.compile(wasmBuffer)
  const instance = await WebAssembly.instantiate(module, imports)

  // Discover memory
  let memory: WebAssembly.Memory | null = null
  for (const [, exp] of Object.entries(instance.exports)) {
    if (exp instanceof WebAssembly.Memory) {
      memory = exp
      break
    }
  }

  // Collect exported functions
  const exports: Record<string, Function> = {}
  for (const [name, exp] of Object.entries(instance.exports)) {
    if (typeof exp === 'function') {
      exports[name] = exp
    }
  }

  function writeInput(data: Uint8Array, exportName?: string): { ptr: number; len: number } {
    if (!memory) throw new Error('No memory exported from wasm module')

    // If the module exports a buffer pointer function, use it
    if (exportName && exports[exportName]) {
      const ptr = (exports[exportName] as Function)() as number
      new Uint8Array(memory.buffer).set(data, ptr)
      return { ptr, len: data.length }
    }

    // Otherwise write at offset 0 (simplest convention)
    new Uint8Array(memory.buffer).set(data, 0)
    return { ptr: 0, len: data.length }
  }

  function readOutput(ptr: number, len: number): Uint8Array {
    if (!memory) throw new Error('No memory exported from wasm module')
    return new Uint8Array(memory.buffer.slice(ptr, ptr + len))
  }

  function call(name: string, ...args: unknown[]): unknown {
    const fn = exports[name]
    if (!fn) throw new Error(`Export '${name}' not found in wasm module`)
    return fn(...args)
  }

  return { instance, memory, exports, writeInput, readOutput, call }
}
