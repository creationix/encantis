// Host imports for running a module's inline tests.
//
// Tests get `test.__assert_fail`, and a small WASI preview1 so modules that use
// standard I/O can be tested: writes to fds 1 and 2 go to the host's stdout and
// stderr, stdin reads as empty, and other calls fail with ENOSYS. Any other
// imported function is a stub that throws if a test calls it, so a module that
// imports from its host can still have its other code tested. An imported
// global is given the zero of its wasm type (0, 0n, null), read from the
// module's import section when its bytes are given.

const ENOSYS = 52
const EBADF = 8

export interface TestHost {
  imports: Record<string, Record<string, ((...args: never[]) => unknown) | WebAssembly.Global>>
  // Call once the instance exists, so WASI calls can reach its memory.
  attach(instance: WebAssembly.Instance): void
}

export function createTestHost(
  module: WebAssembly.Module,
  onAssertFail: (offset: number) => void,
  write: (fd: number, bytes: Uint8Array) => void = (fd, bytes) => {
    ;(fd === 2 ? process.stderr : process.stdout).write(bytes)
  },
  // The module's bytes, for the types of the globals it imports
  bytes?: Uint8Array,
): TestHost {
  let memory: WebAssembly.Memory | null = null
  const view = () => {
    if (!memory) throw new Error('WASI call from a module that exports no memory')
    return new DataView(memory.buffer)
  }

  const wasi: Record<string, (...args: number[]) => number> = {
    fd_write(fd, iovs, iovsLen, nwritten) {
      if (fd !== 1 && fd !== 2) return EBADF
      const dv = view()
      let total = 0
      for (let i = 0; i < iovsLen; i++) {
        const ptr = dv.getUint32(iovs + i * 8, true)
        const len = dv.getUint32(iovs + i * 8 + 4, true)
        write(fd, new Uint8Array(dv.buffer, ptr, len).slice())
        total += len
      }
      dv.setUint32(nwritten, total, true)
      return 0
    },
    fd_read(fd, _iovs, _iovsLen, nread) {
      if (fd !== 0) return EBADF
      view().setUint32(nread, 0, true)
      return 0
    },
    proc_exit(code) {
      throw new Error(`proc_exit(${code}) during a test`)
    },
  }

  const imports: TestHost['imports'] = {
    test: { __assert_fail: (offset: number) => onAssertFail(offset) },
  }
  for (const g of bytes ? importedGlobals(bytes) : []) {
    const zero = ZEROS[g.type]
    if (zero === undefined) continue
    imports[g.module] ??= {}
    imports[g.module][g.name] = new WebAssembly.Global({ value: g.type as keyof WebAssembly.ValueTypeMap, mutable: g.mutable }, zero)
  }
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.kind !== 'function' || (imp.module === 'test' && imp.name === '__assert_fail')) continue
    if (!imports[imp.module]) imports[imp.module] = {}
    const ns = imports[imp.module]
    if (imp.module === 'wasi_snapshot_preview1') {
      ns[imp.name] = wasi[imp.name] ?? (() => ENOSYS)
    } else {
      ns[imp.name] = () => {
        throw new Error(`host import ${imp.module}.${imp.name} isn't available in tests`)
      }
    }
  }

  return {
    imports,
    attach(instance) {
      const found = Object.values(instance.exports).find(e => e instanceof WebAssembly.Memory)
      memory = (found as WebAssembly.Memory | undefined) ?? null
    },
  }
}

// The zero of each wasm value type a JavaScript host can give (no v128)
const ZEROS: Record<string, unknown> = { i32: 0, i64: 0n, f32: 0, f64: 0, externref: null, anyfunc: null }

const VALUE_TYPES: Record<number, string> = { 0x7f: 'i32', 0x7e: 'i64', 0x7d: 'f32', 0x7c: 'f64', 0x7b: 'v128', 0x70: 'anyfunc', 0x6f: 'externref' }

// The globals a module imports, with their types, read from the import
// section of its bytes (the JS API's Module.imports says only that each is a
// global).
export function importedGlobals(bytes: Uint8Array): { module: string; name: string; type: string; mutable: boolean }[] {
  let at = 8
  const u32 = (): number => {
    let result = 0
    let shift = 0
    for (;;) {
      const b = bytes[at++]
      result |= (b & 0x7f) << shift
      if ((b & 0x80) === 0) return result >>> 0
      shift += 7
    }
  }
  const name = (): string => {
    const length = u32()
    const text = new TextDecoder().decode(bytes.subarray(at, at + length))
    at += length
    return text
  }
  const limits = () => {
    const flags = bytes[at++]
    u32()
    if (flags & 1) u32()
  }
  const found: { module: string; name: string; type: string; mutable: boolean }[] = []
  while (at < bytes.length) {
    const id = bytes[at++]
    const size = u32()
    const end = at + size
    if (id !== 2) {
      at = end
      continue
    }
    for (let count = u32(); count > 0; count--) {
      const module = name()
      const field = name()
      const kind = bytes[at++]
      if (kind === 0) u32()
      else if (kind === 1) {
        at++
        limits()
      } else if (kind === 2) limits()
      else if (kind === 3) {
        const type = VALUE_TYPES[bytes[at++]] ?? 'unknown'
        found.push({ module, name: field, type, mutable: bytes[at++] === 1 })
      }
    }
    break
  }
  return found
}
