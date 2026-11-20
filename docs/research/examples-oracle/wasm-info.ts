// A small WebAssembly binary reader: the type, import, function, table,
// memory, global, export and data sections, enough to describe a module's
// ABI (its imports and exports with their wasm types) and where its active
// data segments lie. Used by diff-exports.ts and build-entries.ts.

export type ValType = 'i32' | 'i64' | 'f32' | 'f64' | 'v128' | 'funcref' | 'externref' | string

export interface FuncType {
  params: ValType[]
  results: ValType[]
}

export interface Limits {
  min: number
  max?: number
  shared?: boolean
  memory64?: boolean
}

export type ExternDesc =
  | { kind: 'function'; type: FuncType }
  | { kind: 'table'; elem: ValType; limits: Limits }
  | { kind: 'memory'; limits: Limits }
  | { kind: 'global'; type: ValType; mutable: boolean }
  | { kind: 'tag'; type: FuncType }

export interface ImportInfo {
  module: string
  name: string
  desc: ExternDesc
}

export interface ExportInfo {
  name: string
  desc: ExternDesc
  index: number
}

export interface DataSegment {
  // Constant offset of an active segment in memory 0, or undefined when
  // the segment is passive or its offset is not a plain i32.const.
  offset?: number
  length: number
}

export interface ModuleInfo {
  types: FuncType[]
  imports: ImportInfo[]
  exports: ExportInfo[]
  // Every function in index space order (imports first) with its type.
  funcTypes: FuncType[]
  memories: Limits[] // memory index space (imports first)
  globals: { type: ValType; mutable: boolean; init?: number | bigint }[]
  tables: { elem: ValType; limits: Limits }[]
  data: DataSegment[]
  start?: number
}

class Reader {
  pos = 0
  constructor(public bytes: Uint8Array) {}
  byte(): number {
    if (this.pos >= this.bytes.length) throw new Error('unexpected end of module')
    return this.bytes[this.pos++]
  }
  u32(): number {
    let result = 0
    let shift = 0
    for (;;) {
      const b = this.byte()
      result += (b & 0x7f) * 2 ** shift
      if ((b & 0x80) === 0) return result
      shift += 7
    }
  }
  s32(): number {
    return Number(this.sN(32))
  }
  s64(): bigint {
    return this.sN(64)
  }
  sN(n: number): bigint {
    let result = 0n
    let shift = 0n
    let b: number
    do {
      b = this.byte()
      result |= BigInt(b & 0x7f) << shift
      shift += 7n
    } while (b & 0x80)
    if (shift < BigInt(n) && b & 0x40) result |= -1n << shift
    return BigInt.asIntN(n, result)
  }
  name(): string {
    const len = this.u32()
    const s = new TextDecoder().decode(this.bytes.subarray(this.pos, this.pos + len))
    this.pos += len
    return s
  }
  skip(n: number) {
    this.pos += n
  }
}

function valType(r: Reader): ValType {
  const b = r.byte()
  switch (b) {
    case 0x7f: return 'i32'
    case 0x7e: return 'i64'
    case 0x7d: return 'f32'
    case 0x7c: return 'f64'
    case 0x7b: return 'v128'
    case 0x70: return 'funcref'
    case 0x6f: return 'externref'
    case 0x64:
    case 0x63: {
      // (ref ht) / (ref null ht): heap type is an s33
      const ht = Number(r.sN(33))
      return `${b === 0x63 ? 'ref null' : 'ref'} ${ht}`
    }
    default: return `0x${b.toString(16)}`
  }
}

function limits(r: Reader): Limits {
  const flags = r.byte()
  const min = r.u32()
  const l: Limits = { min }
  if (flags & 1) l.max = r.u32()
  if (flags & 2) l.shared = true
  if (flags & 4) l.memory64 = true
  return l
}

// Reads a constant expression up to its `end`, returning its value when it
// is a single constant.
function constExpr(r: Reader): number | bigint | undefined {
  let value: number | bigint | undefined
  let ops = 0
  for (;;) {
    const op = r.byte()
    if (op === 0x0b) return ops === 1 ? value : undefined
    ops++
    switch (op) {
      case 0x41: value = r.s32(); break
      case 0x42: value = r.s64(); break
      case 0x43: value = new DataView(r.bytes.buffer, r.bytes.byteOffset + r.pos, 4).getFloat32(0, true); r.skip(4); break
      case 0x44: value = new DataView(r.bytes.buffer, r.bytes.byteOffset + r.pos, 8).getFloat64(0, true); r.skip(8); break
      case 0x23: r.u32(); value = undefined; break // global.get
      case 0xd0: r.sN(33); value = undefined; break // ref.null
      case 0xd2: r.u32(); value = undefined; break // ref.func
      case 0x6a: case 0x6b: case 0x6c: case 0x7c: case 0x7d: case 0x7e: value = undefined; break // extended const
      case 0xfd: { // v128.const
        const sub = r.u32()
        if (sub === 12) r.skip(16)
        value = undefined
        break
      }
      default: throw new Error(`unsupported opcode 0x${op.toString(16)} in a constant expression`)
    }
  }
}

export function readModule(bytes: Uint8Array): ModuleInfo {
  const r = new Reader(bytes)
  const magic = [0x00, 0x61, 0x73, 0x6d]
  for (const m of magic) if (r.byte() !== m) throw new Error('not a wasm module')
  r.skip(4) // version
  const info: ModuleInfo = { types: [], imports: [], exports: [], funcTypes: [], memories: [], globals: [], tables: [], data: [] }
  while (r.pos < bytes.length) {
    const id = r.byte()
    const size = r.u32()
    const end = r.pos + size
    switch (id) {
      case 1: { // type
        const n = r.u32()
        for (let i = 0; i < n; i++) {
          const form = r.byte()
          if (form !== 0x60) throw new Error(`unsupported type form 0x${form.toString(16)}`)
          const params: ValType[] = []
          const results: ValType[] = []
          for (let k = r.u32(); k > 0; k--) params.push(valType(r))
          for (let k = r.u32(); k > 0; k--) results.push(valType(r))
          info.types.push({ params, results })
        }
        break
      }
      case 2: { // import
        const n = r.u32()
        for (let i = 0; i < n; i++) {
          const module = r.name()
          const name = r.name()
          const kind = r.byte()
          let desc: ExternDesc
          if (kind === 0) {
            desc = { kind: 'function', type: info.types[r.u32()] }
            info.funcTypes.push(desc.type)
          } else if (kind === 1) {
            const elem = valType(r)
            desc = { kind: 'table', elem, limits: limits(r) }
            info.tables.push({ elem, limits: desc.limits })
          } else if (kind === 2) {
            desc = { kind: 'memory', limits: limits(r) }
            info.memories.push(desc.limits)
          } else if (kind === 3) {
            const type = valType(r)
            const mutable = r.byte() === 1
            desc = { kind: 'global', type, mutable }
            info.globals.push({ type, mutable })
          } else if (kind === 4) {
            r.byte()
            desc = { kind: 'tag', type: info.types[r.u32()] }
          } else throw new Error(`unknown import kind ${kind}`)
          info.imports.push({ module, name, desc })
        }
        break
      }
      case 3: { // function
        const n = r.u32()
        for (let i = 0; i < n; i++) info.funcTypes.push(info.types[r.u32()])
        break
      }
      case 4: { // table
        const n = r.u32()
        for (let i = 0; i < n; i++) {
          const elem = valType(r)
          info.tables.push({ elem, limits: limits(r) })
        }
        break
      }
      case 5: { // memory
        const n = r.u32()
        for (let i = 0; i < n; i++) info.memories.push(limits(r))
        break
      }
      case 6: { // global
        const n = r.u32()
        for (let i = 0; i < n; i++) {
          const type = valType(r)
          const mutable = r.byte() === 1
          const init = constExpr(r)
          info.globals.push({ type, mutable, init })
        }
        break
      }
      case 7: { // export
        const n = r.u32()
        for (let i = 0; i < n; i++) {
          const name = r.name()
          const kind = r.byte()
          const index = r.u32()
          let desc: ExternDesc
          if (kind === 0) desc = { kind: 'function', type: info.funcTypes[index] }
          else if (kind === 1) desc = { kind: 'table', elem: info.tables[index].elem, limits: info.tables[index].limits }
          else if (kind === 2) desc = { kind: 'memory', limits: info.memories[index] }
          else if (kind === 3) desc = { kind: 'global', type: info.globals[index].type, mutable: info.globals[index].mutable }
          else desc = { kind: 'tag', type: { params: [], results: [] } }
          info.exports.push({ name, desc, index })
        }
        break
      }
      case 8: info.start = r.u32(); break
      case 11: { // data
        const n = r.u32()
        for (let i = 0; i < n; i++) {
          const flags = r.u32()
          let offset: number | undefined
          if (flags === 0 || flags === 2) {
            if (flags === 2) r.u32()
            const v = constExpr(r)
            offset = typeof v === 'number' ? v >>> 0 : undefined
          }
          const length = r.u32()
          r.skip(length)
          info.data.push({ offset, length })
        }
        break
      }
      default: break
    }
    r.pos = end
  }
  return info
}

export function funcTypeString(t: FuncType): string {
  return `(${t.params.join(', ')}) -> (${t.results.join(', ')})`
}

function limitsString(l: Limits): string {
  return `${l.min}${l.max !== undefined ? `..${l.max}` : '..'}${l.shared ? ' shared' : ''}${l.memory64 ? ' i64' : ''}`
}

// One line per extern: what a host sees of it.
export function describeExtern(d: ExternDesc): string {
  switch (d.kind) {
    case 'function': return `func ${funcTypeString(d.type)}`
    case 'table': return `table ${d.elem} ${limitsString(d.limits)}`
    case 'memory': return `memory ${limitsString(d.limits)}`
    case 'global': return `global ${d.mutable ? 'mut ' : ''}${d.type}`
    case 'tag': return `tag ${funcTypeString(d.type)}`
  }
}

// The ABI as plain JSON, for abi.json and for comparison.
export function abiOf(info: ModuleInfo) {
  return {
    imports: info.imports.map(i => ({ module: i.module, name: i.name, kind: i.desc.kind, type: describeExtern(i.desc) })),
    exports: info.exports.map(e => ({ name: e.name, kind: e.desc.kind, type: describeExtern(e.desc) })),
  }
}

function leb(n: number): number[] {
  const out: number[] = []
  do {
    let b = n & 0x7f
    n = Math.floor(n / 128)
    if (n > 0) b |= 0x80
    out.push(b)
  } while (n > 0)
  return out
}

// The module with the maximum of each memory it defines lowered to `cap`
// pages (or to its minimum, when that is higher). Two modules given the same
// cap stay comparable: memory.grow past it fails (-1) in both. Everything
// but the memory section is copied as it is.
export function capMemories(bytes: Uint8Array, cap: number): Uint8Array {
  const r = new Reader(bytes)
  r.skip(8)
  const parts: Uint8Array[] = [bytes.subarray(0, 8)]
  let changed = false
  while (r.pos < bytes.length) {
    const start = r.pos
    const id = r.byte()
    const size = r.u32()
    const end = r.pos + size
    if (id === 5) {
      const n = r.u32()
      const body: number[] = [...leb(n)]
      for (let i = 0; i < n; i++) {
        const l = limits(r)
        if (l.memory64) throw new Error('memory64 is not supported')
        let max = l.max
        if (max === undefined || max > cap) {
          max = Math.max(cap, l.min)
          changed = true
        }
        body.push(1 | (l.shared ? 2 : 0), ...leb(l.min), ...leb(max))
      }
      parts.push(new Uint8Array([5, ...leb(body.length), ...body]))
    } else {
      parts.push(bytes.subarray(start, end))
    }
    r.pos = end
  }
  if (!changed) return bytes
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

const SECTION_ORDER: Record<number, number> = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 12: 10, 10: 11, 11: 12 }

// The module with what a host cannot see exported as well: memory 0 as
// `__oracle_memory` when no export names it, and each mutable global no
// export names as `__oracle_global_<index>`. Returns the names added.
export function exposeInternals(bytes: Uint8Array, opts: { memory: boolean; globals: boolean }): { bytes: Uint8Array; added: string[] } {
  const info = readModule(bytes)
  const extra: { name: string; kind: number; index: number }[] = []
  if (opts.memory && info.memories.length > 0 && !info.exports.some(e => e.desc.kind === 'memory' && e.index === 0)) {
    extra.push({ name: '__oracle_memory', kind: 2, index: 0 })
  }
  if (opts.globals) {
    info.globals.forEach((g, i) => {
      if (g.mutable && !info.exports.some(e => e.desc.kind === 'global' && e.index === i)) extra.push({ name: `__oracle_global_${i}`, kind: 3, index: i })
    })
  }
  if (extra.length === 0) return { bytes, added: [] }
  const enc = new TextEncoder()
  const entry = (x: { name: string; kind: number; index: number }) => {
    const n = enc.encode(x.name)
    return [...leb(n.length), ...n, x.kind, ...leb(x.index)]
  }
  const r = new Reader(bytes)
  r.skip(8)
  const parts: Uint8Array[] = [bytes.subarray(0, 8)]
  let done = false
  const exportSection = (existing: number[][]) => {
    const body = [...leb(existing.length + extra.length), ...existing.flat(), ...extra.flatMap(entry)]
    return new Uint8Array([7, ...leb(body.length), ...body])
  }
  while (r.pos < bytes.length) {
    const start = r.pos
    const id = r.byte()
    const size = r.u32()
    const end = r.pos + size
    if (!done && id !== 0 && SECTION_ORDER[id] > SECTION_ORDER[7]) {
      parts.push(exportSection([]))
      done = true
    }
    if (id === 7) {
      const n = r.u32()
      const existing: number[][] = []
      for (let i = 0; i < n; i++) {
        const s = r.pos
        r.name()
        r.byte()
        r.u32()
        existing.push([...bytes.subarray(s, r.pos)])
      }
      parts.push(exportSection(existing))
      done = true
    } else parts.push(bytes.subarray(start, end))
    r.pos = end
  }
  if (!done) parts.push(exportSection([]))
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return { bytes: out, added: extra.map(x => x.name) }
}
