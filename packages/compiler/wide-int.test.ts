// Checks wide-integer arithmetic against BigInt on random and edge-case inputs.
import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { instantiate } from './test-utils'

const OPS = ['+', '-', '*', '&', '|', '^', '<<', '>>', '>>>', '<<<'] as const
const CMPS = ['==', '!=', '<', '>', '<=', '>='] as const
const NAMES: Record<string, string> = {
  '+': 'add', '-': 'sub', '*': 'mul', '&': 'and', '|': 'or', '^': 'xor',
  '<<': 'shl', '>>': 'shr', '>>>': 'rotr', '<<<': 'rotl',
  '==': 'eq', '!=': 'ne', '<': 'lt', '>': 'gt', '<=': 'le', '>=': 'ge',
}

// A module exporting every operator for one wide type. Operands go through
// loads from memory, as well as through params, so both the inline paths and
// the helper calls get exercised.
function source(type: string): string {
  const lines = ['export "mem" memory 1']
  for (const op of OPS) lines.push(`export func ${NAMES[op]}(a: ${type}, b: ${type}) -> ${type} => a ${op} b`)
  for (const op of CMPS) lines.push(`export func ${NAMES[op]}(a: ${type}, b: ${type}) -> bool => a ${op} b`)
  lines.push(`export func neg(a: ${type}) -> ${type} => -a`)
  lines.push(`export func not(a: ${type}) -> ${type} => ~a`)
  lines.push(`func load(o: u32) -> ${type} {
  let p = o as *${type}
  return p.*
}`)
  lines.push(`export func mem_add() {
  let p = 128 as *mut ${type}
  p.* = load(0) + load(64)
}`)
  lines.push(`export func mem_xor() {
  let p = 128 as *mut ${type}
  p.* = load(0) ^ load(64)
}`)
  return lines.join('\n')
}

function rng(seed: number) {
  let x = BigInt(seed) | 1n
  return (bits: number) => {
    let out = 0n
    for (let i = 0; i < bits; i += 64) {
      x ^= (x << 13n) & 0xFFFFFFFFFFFFFFFFn
      x ^= x >> 7n
      x ^= (x << 17n) & 0xFFFFFFFFFFFFFFFFn
      out = (out << 64n) | x
    }
    return out & ((1n << BigInt(bits)) - 1n)
  }
}

for (const [type, bits, signed] of [['u128', 128, false], ['i128', 128, true], ['u256', 256, false], ['i256', 256, true]] as const) {
  describe(type, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ents-wide-'))
    const file = join(dir, `${type}.ents`)
    await writeFile(file, source(type))
    const { exports } = await instantiate(file)
    const n = bits / 64
    const mask = (1n << BigInt(bits)) - 1n
    const wrap = (v: bigint) => {
      v &= mask
      return signed && v >> BigInt(bits - 1) ? v - (1n << BigInt(bits)) : v
    }
    const limbs = (v: bigint) => Array.from({ length: n }, (_, i) => BigInt.asIntN(64, (v & mask) >> BigInt(64 * i)))
    const join64 = (parts: bigint[]) => wrap(parts.reduce((acc, p, i) => acc | (BigInt.asUintN(64, p) << BigInt(64 * i)), 0n))
    const call = (name: string, ...args: bigint[]) => (exports[name] as Function)(...args.flatMap(limbs))
    const expected = (op: string, a: bigint, b: bigint): bigint => {
      const k = Number(BigInt.asUintN(64, b & ((1n << 64n) - 1n)) % BigInt(bits))
      switch (op) {
        case '+': return wrap(a + b)
        case '-': return wrap(a - b)
        case '*': return wrap(a * b)
        case '&': return wrap(a & b)
        case '|': return wrap(a | b)
        case '^': return wrap(a ^ b)
        case '<<': return wrap(a << BigInt(k))
        case '>>': return wrap(signed ? a >> BigInt(k) : (a & mask) >> BigInt(k))
        case '>>>': return wrap(((a & mask) >> BigInt(k)) | ((a & mask) << BigInt((bits - k) % bits)))
        case '<<<': return wrap(((a & mask) << BigInt(k)) | ((a & mask) >> BigInt((bits - k) % bits)))
      }
      throw new Error(op)
    }

    const next = rng(bits + (signed ? 1 : 0))
    const edges = [0n, 1n, mask, mask - 1n, 1n << 63n, 1n << 64n, (1n << 64n) - 1n, 1n << BigInt(bits - 1)]
    const shifts = [0n, 1n, 63n, 64n, 65n, 127n, BigInt(bits - 1), BigInt(bits), 200n]
    const pairs: [bigint, bigint][] = []
    for (const a of edges) for (const b of edges) pairs.push([wrap(a), wrap(b)])
    for (let i = 0; i < 200; i++) pairs.push([wrap(next(bits)), wrap(next(bits))])

    test('arithmetic and bitwise operators match BigInt', () => {
      for (const op of OPS) {
        const isShift = op === '<<' || op === '>>' || op === '>>>' || op === '<<<'
        const cases: [bigint, bigint][] = isShift ? pairs.flatMap(([a]) => shifts.map(s => [a, s] as [bigint, bigint])).slice(0, 400) : pairs
        for (const [a, b] of cases) {
          expect([op, a, b, join64(call(NAMES[op], a, b))]).toEqual([op, a, b, expected(op, a, b)])
        }
      }
    })

    test('comparisons match BigInt', () => {
      const cmp: Record<string, (a: bigint, b: bigint) => boolean> = {
        '==': (a, b) => a === b, '!=': (a, b) => a !== b, '<': (a, b) => a < b,
        '>': (a, b) => a > b, '<=': (a, b) => a <= b, '>=': (a, b) => a >= b,
      }
      for (const op of CMPS) {
        for (const [a, b] of [...pairs, ...pairs.map(([a]) => [a, a] as [bigint, bigint])]) {
          expect([op, a, b, call(NAMES[op], a, b) === 1]).toEqual([op, a, b, cmp[op](a, b)])
        }
      }
    })

    test('negation and not match BigInt', () => {
      for (const [a] of pairs) {
        expect(join64(call('neg', a))).toBe(wrap(-a))
        expect(join64(call('not', a))).toBe(wrap(~a))
      }
    })

    test('operands loaded from memory', () => {
      const mem = new BigUint64Array((exports.mem as WebAssembly.Memory).buffer)
      for (const [a, b] of pairs.slice(0, 50)) {
        limbs(a).forEach((v, i) => { mem[i] = BigInt.asUintN(64, v) })
        limbs(b).forEach((v, i) => { mem[8 + i] = BigInt.asUintN(64, v) })
        ;(exports.mem_add as Function)()
        expect(join64(Array.from(mem.slice(16, 16 + n)))).toBe(wrap(a + b))
        ;(exports.mem_xor as Function)()
        expect(join64(Array.from(mem.slice(16, 16 + n)))).toBe(wrap(a ^ b))
      }
    })
  })
}
