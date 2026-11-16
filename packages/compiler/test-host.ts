// Host imports for running a module's inline tests.
//
// Tests get `test.__assert_fail`, and a small WASI preview1 so modules that use
// standard I/O can be tested: writes to fds 1 and 2 go to the host's stdout and
// stderr, stdin reads as empty, and other calls fail with ENOSYS. Any other
// imported function is a stub that throws if a test calls it, so a module that
// imports from its host can still have its other code tested.

const ENOSYS = 52
const EBADF = 8

export interface TestHost {
  imports: Record<string, Record<string, (...args: never[]) => unknown>>
  // Call once the instance exists, so WASI calls can reach its memory.
  attach(instance: WebAssembly.Instance): void
}

export function createTestHost(
  module: WebAssembly.Module,
  onAssertFail: (offset: number) => void,
  write: (fd: number, bytes: Uint8Array) => void = (fd, bytes) => {
    ;(fd === 2 ? process.stderr : process.stdout).write(bytes)
  },
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

  const imports: Record<string, Record<string, (...args: never[]) => unknown>> = {
    test: { __assert_fail: (offset: number) => onAssertFail(offset) },
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
