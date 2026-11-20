#!/usr/bin/env bun
// Differential oracle: do two builds of a module behave the same for a host?
//
//   bun diff-exports.ts <base.wasm> <new.wasm> [options]
//   bun diff-exports.ts <base-dir> <new-dir> [options]     every .wasm in both
//
// See README.md beside this file for the options, what is compared and the
// limits. Exit 0 when identical, 1 on any mismatch, 2 on a usage error.

import { readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { Rng, showArg } from './diff-common'
import { abiOf, readModule, type FuncType, type ModuleInfo, type ValType } from './wasm-info'

// ---------------------------------------------------------------- options

interface ModuleOptions {
  calls: number
  seed: number
  only?: string[]
  skip: string[]
  init: { name: string; args?: string[] }[]
  timeout: number
  scribble: number
  scribbleFrom: number
  log: number
  noMemory: boolean
  memRanges: [number, number][] | null
  memCap: number
  trace: number
  wasiStreams: boolean
  hostView: boolean
  internalGlobals: boolean
}

const argv = process.argv.slice(2)
function usage(msg?: string): never {
  if (msg) console.error(`error: ${msg}`)
  console.error(`usage: bun diff-exports.ts <base.wasm|dir> <new.wasm|dir> [--calls N] [--seed S] [--json]
       [--only a,b] [--skip a,b] [--init name[:arg,arg]]... [--timeout ms] [--scribble P]
       [--scribble-from F] [--log N] [--verbose]
       [--no-memory] [--mem-range lo:hi[,lo:hi]] [--mem-cap pages] [--trace N] [--wasi-streams] [--host-view]
       [--no-internal-globals] [--config file.json]`)
  process.exit(2)
}

const positional: string[] = []
const base: ModuleOptions = { calls: 2000, seed: 1, skip: [], init: [], timeout: 3000, scribble: 0.25, scribbleFrom: 0.5, log: 0, noMemory: false, memRanges: null, memCap: 2048, trace: 30, wasiStreams: false, hostView: false, internalGlobals: true }
let json = false
let verbose = false
let configFile: string | undefined
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const val = () => {
    const v = argv[++i]
    if (v === undefined) usage(`${a} needs a value`)
    return v
  }
  const num = () => {
    const v = Number(val())
    if (!Number.isFinite(v)) usage(`${a} needs a number`)
    return v
  }
  switch (a) {
    case '--calls': base.calls = num(); break
    case '--seed': base.seed = num(); break
    case '--json': json = true; break
    case '--verbose': case '-v': verbose = true; break
    case '--only': base.only = val().split(',').filter(Boolean); break
    case '--skip': base.skip.push(...val().split(',').filter(Boolean)); break
    case '--init': base.init.push(parseInit(val())); break
    case '--timeout': base.timeout = num(); break
    case '--scribble': base.scribble = num(); break
    case '--scribble-from': base.scribbleFrom = num(); break
    case '--log': base.log = num(); break
    case '--no-memory': base.noMemory = true; break
    case '--wasi-streams': base.wasiStreams = true; break
    case '--host-view': base.hostView = true; break
    case '--no-internal-globals': base.internalGlobals = false; break
    case '--mem-range': base.memRanges = parseRanges(val()); break
    case '--mem-cap': base.memCap = num(); break
    case '--trace': base.trace = num(); break
    case '--config': configFile = val(); break
    case '--help': case '-h': usage()
    default:
      if (a.startsWith('--')) usage(`unknown option ${a}`)
      positional.push(a)
  }
}
if (positional.length !== 2) usage()

function parseInit(s: string) {
  const c = s.indexOf(':')
  return c < 0 ? { name: s } : { name: s.slice(0, c), args: s.slice(c + 1).split(',') }
}
function parseRanges(s: string): [number, number][] {
  return s.split(',').map(r => {
    const [lo, hi] = r.split(':').map(Number)
    if (!(hi > lo)) usage(`bad memory range ${r}`)
    return [lo, hi] as [number, number]
  })
}

// --------------------------------------------------------------- runners

const runnerPath = join(import.meta.dir, 'diff-runner.ts')

class Runner {
  proc: ReturnType<typeof Bun.spawn>
  waiting: ((m: any) => void) | null = null
  ready: Promise<void>
  dead = false
  constructor() {
    let ready!: () => void
    this.ready = new Promise(r => (ready = r))
    this.proc = Bun.spawn(['bun', runnerPath], {
      ipc: (m: any) => {
        if (m?.ready) return ready()
        const w = this.waiting
        this.waiting = null
        w?.(m)
      },
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    this.proc.exited.then(() => {
      this.dead = true
      const w = this.waiting
      this.waiting = null
      w?.({ fatal: 'runner exited' })
    })
  }
  send(msg: unknown): Promise<any> {
    if (this.dead) return Promise.resolve({ fatal: 'runner exited' })
    return new Promise(r => {
      this.waiting = r
      this.proc.send(msg)
    })
  }
  kill() {
    this.dead = true
    try {
      this.proc.kill(9)
    } catch {}
  }
}

const TIMEOUT = Symbol('timeout')
function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  return new Promise(res => {
    const t = setTimeout(() => res(TIMEOUT), Math.max(0, ms))
    p.then(v => {
      clearTimeout(t)
      res(v)
    })
  })
}

// Sends one message to both and waits for both, or for the deadline. When
// only one answers in time the other gets `grace` times longer.
async function both(a: Runner, b: Runner, msg: unknown, timeout: number, grace = 5) {
  const t0 = performance.now()
  const pa = a.send(msg)
  const pb = b.send(msg)
  let ra = await within(pa, timeout)
  let rb = await within(pb, timeout - (performance.now() - t0))
  if (ra === TIMEOUT && rb !== TIMEOUT) ra = await within(pa, timeout * grace)
  else if (rb === TIMEOUT && ra !== TIMEOUT) rb = await within(pb, timeout * grace)
  return { ra, rb, ms: performance.now() - t0 }
}

// ------------------------------------------------------------ arguments

const EDGE_I32 = [0, 1, -1, 2, 3, 4, 7, 8, 15, 16, 31, 32, 33, 63, 64, 100, 127, 128, 255, 256, 1000, 1023, 1024, 4095, 4096, 65535, 65536, 0x7fffffff, -0x80000000, -2, 0x7ffffffe]
const EDGE_I64 = [0n, 1n, -1n, 2n, 3n, 7n, 8n, 63n, 64n, 255n, 256n, 0xffffffffn, 0x100000000n, 0x7fffffffn, -0x80000000n, 0x7fffffffffffffffn, -0x8000000000000000n, -2n, (1n << 51n) - 1n, 1n << 51n, (1n << 52n) - 1n]
const EDGE_F = [0, -0, 1, -1, 0.5, -0.5, 2, Number.NaN, Infinity, -Infinity, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, 1e-30, -1e30, 2 ** 31, 2 ** 32, 2 ** 63, -(2 ** 31) - 1, 4294967296.5, 3.4028234663852886e38, 1.1754943508222875e-38, 0.1, Math.PI]

class ArgGen {
  memLen = 65536
  anchors: number[] = []
  globalAnchors: number[] = []
  constructor(public rng: Rng, info: ModuleInfo) {
    for (const d of info.data) if (d.offset !== undefined) this.anchors.push(d.offset, d.offset + d.length)
    for (const g of info.globals) if (g.type === 'i32' && typeof g.init === 'number' && g.init > 0) this.anchors.push(g.init)
  }
  update(shape: { mems: number[]; globals: number[] } | undefined) {
    if (!shape) return
    if (shape.mems.length) this.memLen = shape.mems[0]
    else this.memLen = 0
    this.globalAnchors = shape.globals.filter(g => g > 0 && g < this.memLen)
  }
  address(inBounds: boolean): number {
    const { rng, memLen } = this
    if (memLen === 0) return rng.int(1024)
    if (!inBounds) return (memLen - rng.pick([0, 1, 2, 4, 8, 16, 32, 64]) + rng.pick([0, 0, 1, 1024])) | 0
    const r = rng.int(10)
    const anchors = this.globalAnchors.length ? [...this.anchors, ...this.globalAnchors] : this.anchors
    if (r < 4 && anchors.length) return Math.max(0, Math.min(memLen - 1, rng.pick(anchors) + rng.pick([0, 0, 0, 1, 4, 8, 16, 32, -1, -8])))
    if (r < 6) return 8 + rng.int(Math.min(memLen - 8, 4096)) & ~7
    const align = rng.pick([1, 4, 8, 16])
    return Math.floor(rng.int(Math.max(8, memLen - 4096)) / align) * align
  }
  i32(sane: boolean): number {
    const { rng } = this
    if (sane) {
      const r = rng.int(10)
      if (r < 4) return rng.int(33)
      if (r < 6) return rng.int(1025)
      return this.address(true)
    }
    const r = rng.int(20)
    if (r < 3) return rng.int(65)
    if (r < 7) return rng.pick(EDGE_I32)
    if (r < 9) return (2 ** rng.int(32) + rng.pick([-1, 0, 0, 1])) | 0
    if (r < 13) return this.address(rng.chance(0.7))
    if (r < 15) return rng.int(65536)
    return rng.u32() | 0
  }
  i64(sane: boolean): bigint {
    const { rng } = this
    if (sane) {
      const r = rng.int(10)
      if (r < 4) return BigInt(rng.int(33))
      if (r < 6) return BigInt(rng.int(1025))
      if (r < 7) return BigInt(this.address(true))
      if (r < 8) return BigInt(rng.u32()) & ((1n << 51n) - 1n) | (BigInt(rng.u32() & 0x7ffff) << 32n)
      return BigInt.asIntN(64, rng.u64())
    }
    const r = rng.int(20)
    if (r < 3) return BigInt(rng.int(65))
    if (r < 8) return rng.pick(EDGE_I64)
    if (r < 11) return BigInt.asIntN(64, (1n << BigInt(rng.int(64))) + BigInt(rng.pick([-1, 0, 0, 1])))
    if (r < 13) return BigInt(rng.u32() | 0)
    return BigInt.asIntN(64, rng.u64())
  }
  float(sane: boolean, single: boolean): number {
    const { rng } = this
    let x: number
    if (sane) {
      const r = rng.int(10)
      if (r < 3) x = rng.range(-10, 10)
      else if (r < 9) x = (rng.float() - 0.5) * 2 * rng.pick([1, 10, 100, 1000])
      else x = rng.pick([0, 1, 0.5, -1])
    } else {
      const r = rng.int(10)
      if (r < 4) x = rng.pick(EDGE_F)
      else if (r < 6) {
        const dv = new DataView(new ArrayBuffer(8))
        if (single) {
          dv.setUint32(0, rng.u32())
          x = dv.getFloat32(0)
        } else {
          dv.setUint32(0, rng.u32())
          dv.setUint32(4, rng.u32())
          x = dv.getFloat64(0)
        }
      } else x = (rng.float() - 0.5) * 2 * 10 ** rng.range(-3, 9)
    }
    return single ? Math.fround(x) : x
  }
  value(t: ValType, sane: boolean): unknown {
    switch (t) {
      case 'i32': return this.i32(sane)
      case 'i64': return this.i64(sane)
      case 'f32': return this.float(sane, true)
      case 'f64': return this.float(sane, false)
      case 'externref': return !sane && this.rng.chance(0.1) ? null : { ref: 1 + this.rng.int(4) }
      default: return null
    }
  }
  // Random bytes to write into memory before a call: mostly where one of
  // the call's i32 arguments points, as an input buffer would be.
  scribble(p: number, args: unknown[], types: ValType[]) {
    const { rng } = this
    if (this.memLen === 0 || !rng.chance(p)) return undefined
    const ptrs = args.filter((a, i) => types[i] === 'i32' && typeof a === 'number' && a >= 0 && a < this.memLen) as number[]
    const out: { addr: number; bytes: Uint8Array }[] = []
    for (let n = rng.range(1, 3); n > 0; n--) {
      const len = rng.chance(0.2) ? rng.range(64, 512) : rng.range(1, 64)
      const at = ptrs.length && rng.chance(0.6) ? rng.pick(ptrs) + rng.pick([0, 0, 0, 1, 4, 8, 16]) : this.address(true)
      const addr = Math.max(0, Math.min(this.memLen - len, at))
      out.push({ addr, bytes: rng.bytes(len) })
    }
    return out
  }
  // Now and then an argument is an earlier one of its type, or one off it:
  // the boundaries where `x > hi` and `i < n` turn are where values meet.
  correlate(args: unknown[], types: ValType[]) {
    const { rng } = this
    for (let j = 1; j < args.length; j++) {
      if (!rng.chance(0.25)) continue
      const earlier = types.slice(0, j).map((t, i) => i).filter(i => types[i] === types[j])
      if (!earlier.length) continue
      const a = args[rng.pick(earlier)]
      const d = rng.pick([0, 1, -1, 0, 1, -1, 2, -2])
      if (types[j] === 'i32') args[j] = ((a as number) + d) | 0
      else if (types[j] === 'i64') args[j] = BigInt.asIntN(64, (a as bigint) + BigInt(d))
      else if (types[j] === 'f32') args[j] = Math.fround((a as number) + d)
      else if (types[j] === 'f64') args[j] = (a as number) + d
    }
  }
  // Arguments for a function that has timed out before: small numbers and
  // the module's own addresses.
  tiny(t: ValType): unknown {
    const { rng } = this
    if (t === 'i32') return rng.chance(0.85) ? rng.int(17) : this.address(true)
    if (t === 'i64') return BigInt(rng.int(17))
    return this.value(t, true)
  }
}

function parseArg(t: ValType, s: string): unknown {
  if (t === 'i64') return BigInt(s.replace(/n$/, ''))
  if (t === 'externref') return s === 'null' ? null : { ref: Number(s.replace(/^ref#/, '')) }
  if (t === 'f32') return Math.fround(Number(s))
  return Number(s)
}

// ------------------------------------------------------------ comparison

interface Call {
  k: number
  name: string
  args: unknown[]
  scribble?: { addr: number; bytes: Uint8Array }[]
}
interface Step {
  call: Call
  outcome: any
  ms?: number
}
interface Reply {
  outcome: any
  imports: string[]
  state: { globals: Record<string, string>; mems: Record<string, string> }
  shape?: { mems: number[]; globals: number[] }
  fatal?: string
}

function show(info: ModuleInfo, c: Call): string {
  const e = info.exports.find(x => x.name === c.name)
  const t = e?.desc.kind === 'function' ? e.desc.type : undefined
  const args = c.args.map((a, i) => showArg(t?.params[i] ?? 'i32', a)).join(', ')
  const scr = c.scribble ? ` [after writing ${c.scribble.map(s => `${s.bytes.length}B@${s.addr}`).join(' ')}]` : ''
  return `#${c.k} ${c.name}(${args})${scr}`
}

function showOutcome(o: any): string {
  if (!o) return '?'
  if (o.timeout) return 'timeout'
  if (o.trap) return o.trap
  if (o.error) return `error: ${o.error}`
  return o.ok.length === 0 ? 'ok' : `-> ${o.ok.join(', ')}`
}

// Where two replies differ, as lines; empty when they are the same.
function differences(ra: Reply, rb: Reply): { parts: string[]; lines: string[] } {
  const parts: string[] = []
  const lines: string[] = []
  if (JSON.stringify(ra.outcome) !== JSON.stringify(rb.outcome)) {
    parts.push('result')
    lines.push(`result: base ${showOutcome(ra.outcome)}`, `        new  ${showOutcome(rb.outcome)}`)
  }
  if (JSON.stringify(ra.imports) !== JSON.stringify(rb.imports)) {
    parts.push('imports')
    const n = Math.max(ra.imports.length, rb.imports.length)
    let i = 0
    while (i < n && ra.imports[i] === rb.imports[i]) i++
    lines.push(`import calls: ${ra.imports.length} in base, ${rb.imports.length} in new; first difference at #${i}:`)
    lines.push(`  base ${ra.imports[i] ?? '(none)'}`.slice(0, 600), `  new  ${rb.imports[i] ?? '(none)'}`.slice(0, 600))
  }
  const ga = ra.state.globals
  const gb = rb.state.globals
  for (const g of new Set([...Object.keys(ga), ...Object.keys(gb)])) {
    if (ga[g] !== gb[g]) {
      if (!parts.includes('globals')) parts.push('globals')
      lines.push(`global ${g}: base ${ga[g]}, new ${gb[g]}`)
    }
  }
  const ma = ra.state.mems
  const mb = rb.state.mems
  for (const m of new Set([...Object.keys(ma), ...Object.keys(mb)])) {
    if (ma[m] !== mb[m]) {
      if (!parts.includes('memory')) parts.push('memory')
      lines.push(`memory ${m}: base ${ma[m]?.split(':')[0]} bytes, new ${mb[m]?.split(':')[0]} bytes, contents differ`)
    }
  }
  return { parts, lines }
}

async function memoryDetail(a: Runner, b: Runner): Promise<string[]> {
  const [da, db] = await Promise.all([within(a.send({ op: 'dump' }), 10000), within(b.send({ op: 'dump' }), 10000)])
  if (da === TIMEOUT || db === TIMEOUT) return ['(memory dump timed out)']
  const lines: string[] = []
  for (const name of Object.keys(da.mems)) {
    const x: Uint8Array = da.mems[name]
    const y: Uint8Array | undefined = db.mems[name]
    if (!y) continue
    const n = Math.max(x.length, y.length)
    const ranges: [number, number][] = []
    let diff = 0
    for (let i = 0; i < n; i++) {
      if (x[i] !== y[i]) {
        diff++
        const last = ranges[ranges.length - 1]
        if (last && i - last[1] <= 8) last[1] = i + 1
        else ranges.push([i, i + 1])
      }
    }
    if (diff === 0) continue
    lines.push(`memory ${name}: ${diff} bytes differ in ${ranges.length} ranges: ${ranges.slice(0, 8).map(([s, e]) => `[${s}, ${e})`).join(' ')}${ranges.length > 8 ? ' ...' : ''}`)
    const [s, e] = ranges[0]
    const hex = (u: Uint8Array) => Array.from(u.subarray(s, Math.min(e, s + 32)), v => (v ?? 0).toString(16).padStart(2, '0')).join(' ')
    lines.push(`  at ${s}: base ${hex(x)}`, `  at ${s}: new  ${hex(y)}`)
  }
  return lines
}

interface Result {
  base: string
  new: string
  identical: boolean
  abi: string[]
  calls: number
  seed: number
  exportsCalled: string[]
  notCallable: string[]
  coverage: Record<string, { calls: number; ok: number; traps: Record<string, number>; timeouts: number }>
  mismatch?: { at: string; parts: string[]; detail: string[]; trace: string[]; alone?: boolean }
  notes: string[]
  log: string[]
  ms: number
}

async function compareModules(basePath: string, newPath: string, o: ModuleOptions): Promise<Result> {
  const t0 = performance.now()
  const ia = readModule(new Uint8Array(await Bun.file(basePath).arrayBuffer()))
  const ib = readModule(new Uint8Array(await Bun.file(newPath).arrayBuffer()))
  const res: Result = { base: basePath, new: newPath, identical: true, abi: [], calls: 0, seed: o.seed, exportsCalled: [], notCallable: [], coverage: {}, notes: [], log: [], ms: 0 }

  // The ABI: imports and exports by name, kind and type.
  const aa = abiOf(ia)
  const ab = abiOf(ib)
  const key = (x: { module?: string; name: string }) => (x.module !== undefined ? `${x.module}.${x.name}` : x.name)
  for (const [what, xs, ys] of [['import', aa.imports, ab.imports], ['export', aa.exports, ab.exports]] as const) {
    const mx = new Map<string, string>(xs.map((x: any) => [key(x), x.type]))
    const my = new Map<string, string>(ys.map((y: any) => [key(y), y.type]))
    for (const [k, t] of mx) {
      if (!my.has(k)) res.abi.push(`${what} ${k} (${t}) is missing in new`)
      else if (my.get(k) !== t) res.abi.push(`${what} ${k}: base ${t}, new ${my.get(k)}`)
    }
    for (const [k, t] of my) if (!mx.has(k)) res.abi.push(`${what} ${k} (${t}) is new`)
  }
  if (JSON.stringify(aa.imports) !== JSON.stringify(ab.imports) && res.abi.length === 0) res.abi.push('imports are in a different order')
  if (res.abi.length) {
    res.identical = false
    res.mismatch = { at: 'ABI', parts: ['abi'], detail: res.abi, trace: [] }
    res.ms = performance.now() - t0
    return res
  }

  const v128 = (t: FuncType) => [...t.params, ...t.results].some(x => x !== 'i32' && x !== 'i64' && x !== 'f32' && x !== 'f64' && x !== 'externref')
  const fns = ia.exports.filter(e => e.desc.kind === 'function')
  const callable: string[] = []
  for (const e of fns) {
    if (e.desc.kind !== 'function') continue
    if (o.only && !o.only.includes(e.name)) continue
    if (o.skip.includes(e.name)) continue
    if (v128(e.desc.type)) {
      res.notCallable.push(`${e.name} (a v128 or reference type a host cannot pass)`)
      continue
    }
    callable.push(e.name)
  }
  for (const n of [...(o.only ?? []), ...o.skip, ...o.init.map(i => i.name)]) {
    if (!fns.some(e => e.name === n)) res.notes.push(`no function export named ${n}`)
  }
  res.exportsCalled = callable
  const typeOf = (name: string) => (fns.find(e => e.name === name)!.desc as { type: FuncType }).type

  // Memory a module does not export and mutable globals it does not export
  // are compared too, unless --host-view; the globals by index, so only
  // when both modules have as many.
  const hidden = (i: ModuleInfo) => i.globals.filter((g, x) => g.mutable && !i.exports.some(e => e.desc.kind === 'global' && e.index === x)).length
  let internalGlobals = !o.hostView && o.internalGlobals
  if (internalGlobals && hidden(ia) !== hidden(ib)) {
    internalGlobals = false
    res.notes.push(`unexported mutable globals not compared: ${hidden(ia)} in base, ${hidden(ib)} in new`)
  }
  const internals = { memory: !o.hostView, globals: internalGlobals }
  const runOpts = (path: string) => ({ path: resolve(path), seed: o.seed, memCap: o.memCap, noMemory: o.noMemory, memRanges: o.memRanges, wasiStreams: o.wasiStreams, internals })
  let A = new Runner()
  let B = new Runner()
  const steps: Step[] = []
  const rng = new Rng(`${o.seed}|calls`)
  const gen = new ArgGen(rng, ia)

  const fail = async (at: string, d: { parts: string[]; lines: string[] }, ra?: Reply, rb?: Reply) => {
    res.identical = false
    const detail = [...d.lines]
    if (d.parts.includes('memory') && ra && rb) detail.push(...(await memoryDetail(A, B)))
    const trace = steps.slice(-o.trace).map(s => `${show(ia, s.call)} ${showOutcome(s.outcome)}`)
    if (steps.length > o.trace) trace.unshift(`... ${steps.length - o.trace} earlier calls (--trace N shows more)`)
    res.mismatch = { at, parts: d.parts, detail, trace }
  }

  // Start both: each with its own module.
  await Promise.all([A.ready, B.ready])
  const init = async () => {
    const [ra, rb] = await Promise.all([A.send({ op: 'init', opts: runOpts(basePath) }), B.send({ op: 'init', opts: runOpts(newPath) })])
    return { ra: ra as Reply, rb: rb as Reply }
  }
  const restart = async () => {
    A.kill()
    B.kill()
    A = new Runner()
    B = new Runner()
    await Promise.all([A.ready, B.ready])
    return init()
  }
  try {
    {
      const { ra, rb } = await init()
      if (ra.fatal || rb.fatal) throw new Error(`runner failed: ${ra.fatal ?? rb.fatal}`)
      const d = differences(ra, rb)
      if (d.parts.length) {
        await fail('instantiation', d, ra, rb)
        if (d.parts.length === 1 && d.parts[0] === 'memory') {
          res.mismatch!.detail.push('the initial memory differs: the data the module lays out changed; if that is intended, --no-memory or --mem-range compares the rest')
        }
        return res
      }
      if (ra.outcome.trap) {
        res.notes.push(`instantiation traps in both: ${ra.outcome.trap}`)
        return res
      }
      gen.update(ra.shape)
    }

    // The calls: the --init calls first, then round robin alternating with
    // a random pick.
    const initCalls: Call[] = []
    let k = 0
    for (const ic of o.init) {
      if (!fns.some(e => e.name === ic.name)) continue
      const t = typeOf(ic.name)
      const args = ic.args ? t.params.map((p, i) => parseArg(p, ic.args![i] ?? '0')) : t.params.map(p => gen.value(p, true))
      initCalls.push({ k: k++, name: ic.name, args })
    }
    const timeouts = new Map<string, number>()
    let active = [...callable]
    let rr = 0
    const next = (i: number): Call | undefined => {
      if (i < initCalls.length) return initCalls[i]
      if (i - initCalls.length >= o.calls || active.length === 0) return undefined
      const name = i % 2 === 0 ? active[rr++ % active.length] : rng.pick(active)
      const t = typeOf(name)
      // A function that timed out gets tiny arguments from then on.
      const slow = (timeouts.get(name) ?? 0) > 0
      const sane = rng.chance(0.6)
      const args = t.params.map(p => (slow ? gen.tiny(p) : gen.value(p, sane)))
      gen.correlate(args, t.params)
      // Memory is written into only in the later calls, so that the earlier
      // ones see the module's state as only its own calls left it.
      const late = i - initCalls.length >= o.calls * o.scribbleFrom
      return { k: k++, name, args, scribble: late ? gen.scribble(o.scribble, args, t.params) : undefined }
    }
    for (let i = 0, call = next(0); call; call = next(++i)) {
      const cov = (res.coverage[call.name] ??= { calls: 0, ok: 0, traps: {}, timeouts: 0 })
      cov.calls++
      res.calls++
      const { ra, rb } = await both(A, B, { op: 'call', call }, o.timeout)
      if (ra === TIMEOUT && rb === TIMEOUT) {
        // Both still running: count it as the same, start again and replay
        // what came before.
        cov.timeouts++
        const n = (timeouts.get(call.name) ?? 0) + 1
        timeouts.set(call.name, n)
        steps.push({ call, outcome: { timeout: true } })
        if (n >= 5) {
          active = active.filter(x => x !== call.name)
          res.notes.push(`${call.name} timed out 5 times in both; not called again`)
        }
        const r = await restart()
        const d0 = differences(r.ra, r.rb)
        if (d0.parts.length) {
          await fail('instantiation (restart)', d0, r.ra, r.rb)
          return res
        }
        const replay = steps.filter(s => !s.outcome.timeout).map(s => s.call)
        const { ra: pa, rb: pb } = await both(A, B, { op: 'replay', calls: replay }, o.timeout * 2 + replay.length * 50)
        if (pa === TIMEOUT || pb === TIMEOUT) {
          res.notes.push('replay after a timeout timed out; stopped')
          break
        }
        if (JSON.stringify(pa.outcomes) !== JSON.stringify(pb.outcomes) || JSON.stringify(pa.state) !== JSON.stringify(pb.state)) {
          await fail(`replay after timeout at ${show(ia, call)}`, { parts: ['replay'], lines: ['the replayed calls differ'] }, pa, pb)
          return res
        }
        res.notes.push(`${show(ia, call)} timed out in both (${o.timeout} ms); restarted and replayed ${replay.length} calls`)
        gen.update(pa.shape)
        continue
      }
      if (ra === TIMEOUT || rb === TIMEOUT) {
        const slow = ra === TIMEOUT ? 'base' : 'new'
        steps.push({ call, outcome: ra === TIMEOUT ? { timeout: true } : ra.outcome })
        await fail(show(ia, call), { parts: ['time'], lines: [`${slow} did not return within ${o.timeout * 6} ms; the other returned ${showOutcome((ra === TIMEOUT ? rb : ra)?.outcome)}`] })
        return res
      }
      if (ra.fatal || rb.fatal) throw new Error(`runner failed: ${ra.fatal ?? rb.fatal}`)
      steps.push({ call, outcome: ra.outcome })
      if (steps.length <= o.log) {
        res.log.push(`${show(ia, call)} ${showOutcome(ra.outcome)}`)
        for (const imp of ra.imports.slice(0, 20)) res.log.push(`    ${imp.slice(0, 300)}`)
        if (ra.imports.length > 20) res.log.push(`    ... ${ra.imports.length - 20} more import calls`)
      }
      if (ra.outcome.ok) cov.ok++
      else if (ra.outcome.trap) cov.traps[ra.outcome.trap] = (cov.traps[ra.outcome.trap] ?? 0) + 1
      const d = differences(ra, rb)
      if (d.parts.length) {
        await fail(show(ia, call), d, ra, rb)
        // Does the call alone, on fresh instances after the init calls,
        // show it?
        const r = await restart()
        if (!differences(r.ra, r.rb).parts.length) {
          if (initCalls.length && call.k >= initCalls.length) await both(A, B, { op: 'replay', calls: initCalls }, o.timeout * 2)
          const again = await both(A, B, { op: 'call', call }, o.timeout)
          if (again.ra !== TIMEOUT && again.rb !== TIMEOUT) res.mismatch!.alone = differences(again.ra, again.rb).parts.length > 0
        }
        return res
      }
      gen.update(ra.shape)
    }
    return res
  } finally {
    A.kill()
    B.kill()
    res.ms = performance.now() - t0
  }
}

// ---------------------------------------------------------------- output

function printResult(r: Result, verbose: boolean) {
  const rel = r.base
  if (r.log.length) {
    console.log(`first ${r.log.filter(l => l.startsWith('#')).length} calls of ${rel} (base outcomes, then its import calls):`)
    for (const l of r.log) console.log(`  ${l}`)
  }
  if (r.identical) {
    console.log(`IDENTICAL ${rel} vs ${r.new}: ${r.calls} calls (seed ${r.seed}), ${(r.ms / 1000).toFixed(1)} s`)
  } else {
    console.log(`MISMATCH ${rel} vs ${r.new} at ${r.mismatch!.at}`)
    for (const l of r.mismatch!.detail) console.log(`  ${l}`)
    if (r.mismatch!.alone !== undefined) console.log(r.mismatch!.alone ? '  the call alone, on fresh instances (after any --init), shows it' : '  the call alone does not show it: it depends on the calls before')
    if (r.mismatch!.trace.length) {
      console.log('  calls that led there (base outcomes):')
      for (const l of r.mismatch!.trace) console.log(`    ${l}`)
    }
  }
  if (verbose || !r.identical) {
    const cov = Object.entries(r.coverage)
    if (cov.length) {
      console.log('  calls per export: ok / trapped / timed out')
      for (const [name, c] of cov) {
        const traps = Object.entries(c.traps).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join('; ')
        console.log(`    ${name}: ${c.calls} calls, ${c.ok} ok${traps ? `, ${traps}` : ''}${c.timeouts ? `, ${c.timeouts} timeouts` : ''}`)
      }
    } else if (r.identical) console.log('  no function export was called')
    for (const n of r.notCallable) console.log(`  not called: ${n}`)
    for (const n of r.notes) console.log(`  note: ${n}`)
  }
}

async function wasmFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile() && e.name.endsWith('.wasm')) out.push(relative(dir, join(e.parentPath, e.name)))
  }
  return out.sort()
}

const [pa, pb] = positional
const isDir = async (p: string) => (await stat(p).catch(() => null))?.isDirectory() ?? false
let config: Record<string, Partial<ModuleOptions> & { init?: (string | { name: string; args?: string[] })[] }> = {}
if (configFile) config = await Bun.file(configFile).json()
const optionsFor = (rel: string): ModuleOptions => {
  // A key names a module by its path, with or without .wasm, or by the end
  // of its path (examples/browser/lantern.ents).
  const key = Object.keys(config).find(k => [k, `${k}.wasm`].some(x => rel === x || rel.endsWith(`/${x}`)))
  const c = key ? config[key] : {}
  return { ...base, ...c, init: c.init ? c.init.map(x => (typeof x === 'string' ? parseInit(x) : x)) : base.init, skip: [...base.skip, ...(c.skip ?? [])] } as ModuleOptions
}

if ((await isDir(pa)) && (await isDir(pb))) {
  // Every module the new directory has is compared with its base; base
  // modules the new directory lacks are counted, not compared.
  const fa = new Set(await wasmFiles(pa))
  const fb = await wasmFiles(pb)
  const results: Result[] = []
  let bad = 0
  for (const rel of fb) {
    if (!fa.has(rel)) {
      bad++
      if (!json) console.log(`NO BASE  ${rel} is not in ${pa}`)
      continue
    }
    const r = await compareModules(join(pa, rel), join(pb, rel), optionsFor(rel))
    r.base = rel
    r.new = rel
    results.push(r)
    if (!r.identical) bad++
    if (!json) printResult(r, verbose)
  }
  const unbuilt = [...fa].filter(rel => !fb.includes(rel))
  if (!json && unbuilt.length) console.log(`${unbuilt.length} base modules are not in ${pb} and were not compared`)
  if (json) console.log(JSON.stringify({ identical: bad === 0, modules: results }, null, 2))
  else console.log(`\n${results.length} compared, ${bad} not identical`)
  process.exit(bad ? 1 : 0)
} else {
  const r = await compareModules(pa, pb, optionsFor(pa))
  if (json) console.log(JSON.stringify(r, null, 2))
  else printResult(r, true)
  process.exit(r.identical ? 0 : 1)
}
