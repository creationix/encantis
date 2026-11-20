// One module of a diff-exports.ts comparison, run in a child process so that
// a call that never returns can be killed. It instantiates the module with
// deterministic stub imports, makes the calls the driver sends, and answers
// each with the call's outcome, the imports it called and the state a host
// sees afterwards (exported globals, a hash of each memory).

import { Rng, encodeValue, type HostRef } from './diff-common'
import { capMemories, exposeInternals, readModule, type FuncType, type ModuleInfo, type ValType } from './wasm-info'

interface Options {
  path: string
  seed: number
  memCap: number
  noMemory: boolean
  memRanges: [number, number][] | null
  // Compare what a WASI program writes to each fd in a call, not how it is
  // split into fd_write calls, and do not log fd_read at all.
  wasiStreams: boolean
  // Export what a host cannot see, so that it is compared too.
  internals: { memory: boolean; globals: boolean }
}

let opts: Options
let info: ModuleInfo
let instance: WebAssembly.Instance | undefined
const importedMemories: { key: string; mem: WebAssembly.Memory }[] = []
let importLog: string[] = []
const importCounts = new Map<string, number>()
let callIndex = -1
const streams = new Map<number, number[]>()

class ProcExit extends Error {
  constructor(public code: number) {
    super(`proc_exit(${code})`)
  }
}

// Host references: one object per id, so identity holds within this process.
const refs = new Map<number, HostRef>()
function ref(id: number): HostRef {
  let r = refs.get(id)
  if (!r) {
    r = { __ref: id }
    refs.set(id, r)
  }
  return r
}

function bump(key: string): number {
  const n = importCounts.get(key) ?? 0
  importCounts.set(key, n + 1)
  return n
}

// A value an import gives back: mostly small numbers, some edges, some noise.
function importValue(rng: Rng, t: ValType): unknown {
  switch (t) {
    case 'i32': {
      const r = rng.int(10)
      if (r < 5) return rng.int(64)
      if (r < 7) return rng.pick([0, 1, -1, 2, 255, 256, 65535, 0x7fffffff, -0x80000000])
      return rng.u32() | 0
    }
    case 'i64': {
      const r = rng.int(10)
      if (r < 5) return BigInt(rng.int(64))
      if (r < 7) return rng.pick([0n, 1n, -1n, 0x7fffffffffffffffn, -0x8000000000000000n])
      return BigInt.asIntN(64, rng.u64())
    }
    case 'f32':
    case 'f64': {
      const r = rng.int(10)
      const x = r < 6 ? (rng.float() - 0.5) * 2 * rng.pick([1, 10, 1000]) : rng.pick([0, -0, 1, -1, 0.5, Number.NaN, Infinity, -Infinity])
      return t === 'f32' ? Math.fround(x) : x
    }
    case 'externref':
      return rng.chance(0.05) ? null : ref(1 + rng.int(8))
    default:
      return null
  }
}

function memory(): WebAssembly.Memory | undefined {
  const ex = instance?.exports
  if (ex) {
    if (ex.memory instanceof WebAssembly.Memory) return ex.memory
    for (const v of Object.values(ex)) if (v instanceof WebAssembly.Memory) return v
  }
  return importedMemories[0]?.mem
}

// The bytes the program reads from stdin in call k: text most of the time
// (digits, letters, spaces, newlines), sometimes raw bytes, of a length
// from nothing to some kilobytes. Each call has its own stream.
let stdin: { data: Uint8Array; pos: number; rng: Rng } | null = null
function stdinStream() {
  if (stdin) return stdin
  const rng = new Rng(`${opts.seed}|stdin|${callIndex}`)
  const len = rng.pick([0, 1, rng.range(1, 64), rng.range(64, 2048), rng.range(2048, 20000)])
  const data = new Uint8Array(len)
  const mode = rng.int(10)
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzonetwothreefourfivesixseveneightnine     '
  for (let i = 0; i < len; i++) {
    if (mode < 2) data[i] = rng.u32() & 0xff
    else data[i] = rng.chance(1 / 12) ? 10 : alphabet.charCodeAt(rng.int(alphabet.length))
  }
  stdin = { data, pos: 0, rng }
  return stdin
}

const EFAULT = 21
const EBADF = 8
const ENOSYS = 52

function wasiImport(name: string, type: FuncType): Function {
  const key = `wasi.${name}`
  const log = (args: unknown[], extra = '') =>
    importLog.push(`${key}(${args.map((a, i) => encodeValue(type.params[i], a)).join(',')})${extra}`)
  const view = () => {
    const m = memory()
    return m ? new DataView(m.buffer) : undefined
  }
  const inBounds = (dv: DataView, p: number, n: number) => p >= 0 && n >= 0 && p + n <= dv.byteLength
  const iovecs = (dv: DataView, iovs: number, n: number): [number, number][] | null => {
    if (!inBounds(dv, iovs >>> 0, (n >>> 0) * 8)) return null
    const out: [number, number][] = []
    for (let i = 0; i < n >>> 0; i++) {
      const p = dv.getUint32((iovs >>> 0) + i * 8, true)
      const l = dv.getUint32((iovs >>> 0) + i * 8 + 4, true)
      if (!inBounds(dv, p, l)) return null
      out.push([p, l])
    }
    return out
  }
  switch (name) {
    case 'fd_write':
      return (fd: number, iovs: number, n: number, nwritten: number) => {
        const dv = view()
        const vs = dv && iovecs(dv, iovs, n)
        if (!dv || !vs || !inBounds(dv, nwritten >>> 0, 4)) {
          log([fd, iovs, n, nwritten], ' = EFAULT')
          return EFAULT
        }
        if (fd !== 1 && fd !== 2) {
          log([fd, iovs, n, nwritten], ' = EBADF')
          return EBADF
        }
        const chunks: number[] = []
        for (const [p, l] of vs) for (let i = 0; i < l; i++) chunks.push(dv.getUint8(p + i))
        dv.setUint32(nwritten >>> 0, chunks.length, true)
        if (opts.wasiStreams) {
          if (!streams.has(fd)) streams.set(fd, [])
          streams.get(fd)!.push(...chunks)
        } else importLog.push(`${key}(fd=${fd}) ${JSON.stringify(Buffer.from(chunks).toString('latin1'))}`)
        return 0
      }
    case 'fd_read':
      return (fd: number, iovs: number, n: number, nread: number) => {
        const dv = view()
        const vs = dv && iovecs(dv, iovs, n)
        if (!dv || !vs || !inBounds(dv, nread >>> 0, 4)) {
          log([fd, iovs, n, nread], ' = EFAULT')
          return EFAULT
        }
        if (fd !== 0) {
          log([fd, iovs, n, nread], ' = EBADF')
          return EBADF
        }
        const s = stdinStream()
        const want = vs.reduce((a, [, l]) => a + l, 0)
        // Half the reads are short, as a pipe's may be.
        const limit = s.rng.chance(0.5) ? want : s.rng.range(1, Math.max(1, want))
        let got = 0
        for (const [p, l] of vs) {
          for (let i = 0; i < l && got < limit && s.pos < s.data.length; i++) {
            dv.setUint8(p + i, s.data[s.pos++])
            got++
          }
        }
        dv.setUint32(nread >>> 0, got, true)
        if (!opts.wasiStreams) importLog.push(`${key}(fd=0, want=${want}) = ${got}`)
        return 0
      }
    case 'proc_exit':
      return (code: number) => {
        log([code])
        throw new ProcExit(code)
      }
    case 'args_sizes_get':
    case 'environ_sizes_get':
      return (a: number, b: number) => {
        const dv = view()
        log([a, b])
        if (!dv || !inBounds(dv, a >>> 0, 4) || !inBounds(dv, b >>> 0, 4)) return EFAULT
        dv.setUint32(a >>> 0, 0, true)
        dv.setUint32(b >>> 0, 0, true)
        return 0
      }
    case 'args_get':
    case 'environ_get':
    case 'fd_close':
      return (...args: unknown[]) => {
        log(args)
        return 0
      }
    case 'clock_time_get':
      return (id: number, precision: bigint, out: number) => {
        const dv = view()
        log([id, precision, out])
        if (!dv || !inBounds(dv, out >>> 0, 8)) return EFAULT
        dv.setBigUint64(out >>> 0, 1_700_000_000_000_000_000n + BigInt(bump(key)) * 1_000_000n, true)
        return 0
      }
    case 'random_get':
      return (buf: number, len: number) => {
        const dv = view()
        log([buf, len])
        if (!dv || !inBounds(dv, buf >>> 0, len >>> 0)) return EFAULT
        const rng = new Rng(`${opts.seed}|${key}|${bump(key)}`)
        for (let i = 0; i < len >>> 0; i++) dv.setUint8((buf >>> 0) + i, rng.u32() & 0xff)
        return 0
      }
    case 'fd_fdstat_get':
      return (fd: number, out: number) => {
        const dv = view()
        log([fd, out])
        if (!dv || !inBounds(dv, out >>> 0, 24)) return EFAULT
        for (let i = 0; i < 24; i++) dv.setUint8((out >>> 0) + i, 0)
        if (fd > 2) return EBADF
        dv.setUint8(out >>> 0, 2) // character device
        return 0
      }
    default:
      return (...args: unknown[]) => {
        log(args, ' = ENOSYS')
        return ENOSYS
      }
  }
}

function genericImport(mod: string, name: string, type: FuncType): Function {
  const key = `${mod}.${name}`
  return (...args: unknown[]) => {
    const n = bump(key)
    importLog.push(`${key}(${args.map((a, i) => encodeValue(type.params[i], a)).join(',')})`)
    const rng = new Rng(`${opts.seed}|${key}|${n}`)
    const results = type.results.map(t => importValue(rng, t))
    return results.length === 0 ? undefined : results.length === 1 ? results[0] : results
  }
}

function buildImports(): WebAssembly.Imports {
  const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {}
  for (const imp of info.imports) {
    const ns = (imports[imp.module] ??= {})
    const d = imp.desc
    const key = `${imp.module}.${imp.name}`
    if (d.kind === 'function') {
      ns[imp.name] = (imp.module === 'wasi_snapshot_preview1' || imp.module === 'wasi_unstable'
        ? wasiImport(imp.name, d.type)
        : genericImport(imp.module, imp.name, d.type)) as WebAssembly.ImportValue
    } else if (d.kind === 'memory') {
      const max = Math.max(d.limits.min, Math.min(d.limits.max ?? opts.memCap, opts.memCap))
      const mem = new WebAssembly.Memory({ initial: d.limits.min, maximum: max, shared: d.limits.shared } as WebAssembly.MemoryDescriptor)
      importedMemories.push({ key, mem })
      ns[imp.name] = mem
    } else if (d.kind === 'table') {
      ns[imp.name] = new WebAssembly.Table({ element: d.elem === 'externref' ? 'externref' : 'anyfunc', initial: d.limits.min, maximum: d.limits.max } as WebAssembly.TableDescriptor)
    } else if (d.kind === 'global') {
      const rng = new Rng(`${opts.seed}|${key}|global`)
      ns[imp.name] = new WebAssembly.Global({ value: d.type as WebAssembly.ValueType, mutable: d.mutable }, importValue(rng, d.type))
    }
  }
  return imports
}

function trapKind(e: unknown): string {
  if (e instanceof ProcExit) return `exit(${e.code})`
  const err = e as Error
  const msg = String(err?.message ?? e).replace(/\s*\(evaluating .*\)\s*$/s, '')
  if (e instanceof WebAssembly.RuntimeError) return `trap: ${msg}`
  if (e instanceof RangeError && /stack/i.test(msg)) return 'stack overflow'
  return `${err?.constructor?.name ?? 'Error'}: ${msg}`
}

function hashBytes(b: Uint8Array): string {
  return Bun.hash(b).toString(16)
}

function state() {
  const globals: Record<string, string> = {}
  const mems: Record<string, string> = {}
  if (instance) {
    for (const e of info.exports) {
      const v = instance.exports[e.name]
      if (e.desc.kind === 'global') {
        try {
          globals[e.name] = encodeValue(e.desc.type, (v as WebAssembly.Global).value)
        } catch (err) {
          globals[e.name] = `unreadable ${e.desc.type}`
        }
      } else if (e.desc.kind === 'memory' && !opts.noMemory) {
        mems[e.name] = describeMemory(v as WebAssembly.Memory)
      }
    }
  }
  if (!opts.noMemory) for (const { key, mem } of importedMemories) mems[`import ${key}`] = describeMemory(mem)
  return { globals, mems }
}

function describeMemory(m: WebAssembly.Memory): string {
  const bytes = new Uint8Array(m.buffer)
  if (!opts.memRanges) return `${bytes.length}:${hashBytes(bytes)}`
  return `${bytes.length}:${opts.memRanges.map(([a, b]) => hashBytes(bytes.subarray(Math.min(a, bytes.length), Math.min(b, bytes.length)))).join(',')}`
}

// The length of each exported memory and the i32 value of each exported
// global, for the driver to choose addresses with.
function shape() {
  const mems: number[] = []
  const globals: number[] = []
  if (instance) {
    for (const e of info.exports) {
      const v = instance.exports[e.name]
      if (e.desc.kind === 'memory') mems.push((v as WebAssembly.Memory).buffer.byteLength)
      else if (e.desc.kind === 'global' && e.desc.type === 'i32') globals.push((v as WebAssembly.Global).value)
    }
  }
  for (const { mem } of importedMemories) mems.push(mem.buffer.byteLength)
  return { mems, globals }
}

function flushStreams() {
  for (const fd of [...streams.keys()].sort((a, b) => a - b)) {
    importLog.push(`wasi fd ${fd} got ${JSON.stringify(Buffer.from(streams.get(fd)!).toString('latin1'))}`)
  }
  streams.clear()
}

function decodeArg(t: ValType, a: unknown): unknown {
  if (t === 'externref') return a === null ? null : ref((a as { ref: number }).ref)
  return a
}

interface Call {
  k: number
  name: string
  args: unknown[]
  scribble?: { addr: number; bytes: Uint8Array }[]
}

function doCall(c: Call) {
  importLog = []
  callIndex = c.k
  stdin = null
  if (c.scribble) {
    const m = memory()
    if (m) {
      const bytes = new Uint8Array(m.buffer)
      for (const s of c.scribble) if (s.addr + s.bytes.length <= bytes.length) bytes.set(s.bytes, s.addr)
    }
  }
  const e = info.exports.find(x => x.name === c.name)
  if (!instance || !e || e.desc.kind !== 'function') return { outcome: { error: `no function export ${c.name}` }, imports: [], ms: 0 }
  const t = e.desc.type
  const fn = instance.exports[c.name] as Function
  const args = c.args.map((a, i) => decodeArg(t.params[i], a))
  const t0 = performance.now()
  let outcome: { ok: string[] } | { trap: string }
  try {
    const r = fn(...args)
    const rs: unknown[] = t.results.length === 0 ? [] : t.results.length === 1 ? [r] : [...(r as unknown[])]
    outcome = { ok: rs.map((v, i) => encodeValue(t.results[i], v)) }
  } catch (err) {
    outcome = { trap: trapKind(err) }
  }
  flushStreams()
  return { outcome, imports: importLog, ms: performance.now() - t0 }
}

process.on('message', async (msg: any) => {
  try {
    if (msg.op === 'init') {
      opts = msg.opts
      let bytes = new Uint8Array(await Bun.file(opts.path).arrayBuffer())
      bytes = capMemories(bytes, opts.memCap)
      bytes = exposeInternals(bytes, opts.internals).bytes
      info = readModule(bytes)
      importLog = []
      callIndex = -1
      let outcome: { ok: string[] } | { trap: string }
      try {
        const mod = new WebAssembly.Module(bytes)
        instance = new WebAssembly.Instance(mod, buildImports())
        outcome = { ok: [] }
      } catch (err) {
        outcome = { trap: trapKind(err) }
      }
      flushStreams()
      process.send!({ outcome, imports: importLog, state: state(), shape: shape() })
    } else if (msg.op === 'call') {
      const r = doCall(msg.call)
      process.send!({ ...r, state: state(), shape: shape() })
    } else if (msg.op === 'replay') {
      const outcomes = (msg.calls as Call[]).map(c => doCall(c).outcome)
      process.send!({ outcomes, state: state(), shape: shape() })
    } else if (msg.op === 'dump') {
      const mems: Record<string, Uint8Array> = {}
      if (instance) for (const e of info.exports) if (e.desc.kind === 'memory') mems[e.name] = new Uint8Array((instance.exports[e.name] as WebAssembly.Memory).buffer).slice()
      for (const { key, mem } of importedMemories) mems[`import ${key}`] = new Uint8Array(mem.buffer).slice()
      process.send!({ mems })
    }
  } catch (err) {
    process.send!({ fatal: String((err as Error)?.stack ?? err) })
  }
})
process.send!({ ready: true })
