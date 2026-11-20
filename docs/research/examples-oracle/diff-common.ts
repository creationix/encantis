// Shared by diff-exports.ts (the driver) and diff-runner.ts (one module in a
// child process): deterministic random numbers and a canonical encoding of
// wasm values, so that two runs compare as strings.

import type { ValType } from './wasm-info'

// sfc32: a small, fast generator with 128 bits of state.
export class Rng {
  a: number
  b: number
  c: number
  d: number
  constructor(seed: number | string) {
    const h = typeof seed === 'number' ? hash32(`seed:${seed}`) : hash32(seed)
    // splitmix32 to fill the state
    let s = h >>> 0
    const next = () => {
      s = (s + 0x9e3779b9) | 0
      let z = s
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b)
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35)
      return (z ^ (z >>> 16)) >>> 0
    }
    this.a = next()
    this.b = next()
    this.c = next()
    this.d = next()
    for (let i = 0; i < 12; i++) this.u32()
  }
  u32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0
    this.d = (this.d + 1) | 0
    this.a = this.b ^ (this.b >>> 9)
    this.b = (this.c + (this.c << 3)) | 0
    this.c = (this.c << 21) | (this.c >>> 11)
    this.c = (this.c + t) | 0
    return t >>> 0
  }
  // Uniform in [0, n) for n up to 2^32.
  int(n: number): number {
    return n <= 0 ? 0 : Math.floor((this.u32() / 4294967296) * n)
  }
  // Uniform in [lo, hi].
  range(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1)
  }
  chance(p: number): boolean {
    return this.u32() / 4294967296 < p
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)]
  }
  u64(): bigint {
    return (BigInt(this.u32()) << 32n) | BigInt(this.u32())
  }
  float(): number {
    return this.u32() / 4294967296
  }
  bytes(n: number): Uint8Array {
    const out = new Uint8Array(n)
    for (let i = 0; i < n; i++) out[i] = this.u32() & 0xff
    return out
  }
}

// FNV-1a then a murmur3 finalizer.
export function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

const f32 = new Float32Array(1)
const u32of32 = new Uint32Array(f32.buffer)
const f64 = new Float64Array(1)
const u32of64 = new Uint32Array(f64.buffer)

const hex8 = (n: number) => (n >>> 0).toString(16).padStart(8, '0')

// A host reference handed across the boundary: an object with an id.
export interface HostRef {
  __ref: number
}

// A wasm value as a string that compares bit-exactly: floats by their bits,
// every NaN as `NaN` (a payload is not compared), i64 by its signed value,
// a host reference by its id.
export function encodeValue(type: ValType, v: unknown): string {
  switch (type) {
    case 'i32':
      return `${(v as number) | 0}`
    case 'i64':
      return `${BigInt.asIntN(64, v as bigint)}n`
    case 'f32': {
      const x = v as number
      if (Number.isNaN(x)) return 'NaN'
      f32[0] = x
      return `f32:${hex8(u32of32[0])}`
    }
    case 'f64': {
      const x = v as number
      if (Number.isNaN(x)) return 'NaN'
      f64[0] = x
      return `f64:${hex8(u32of64[1])}${hex8(u32of64[0])}`
    }
    case 'externref':
      if (v === null || v === undefined) return 'null'
      if (typeof v === 'object' && v !== null && '__ref' in v) return `ref#${(v as HostRef).__ref}`
      return `ref?${typeof v}`
    case 'funcref':
      return v === null ? 'null' : 'func'
    default:
      return `${type}?${String(v)}`
  }
}

// Readable form of an argument the driver sends (numbers, bigints, refs).
export function showArg(type: ValType, v: unknown): string {
  if (type === 'i64') return `${v}n`
  if (type === 'externref') return v === null ? 'null' : `ref#${(v as { ref: number }).ref}`
  if (type === 'f32' || type === 'f64') {
    const x = v as number
    return Object.is(x, -0) ? '-0' : `${x}`
  }
  return `${v}`
}
