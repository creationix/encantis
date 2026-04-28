import { describe, test, expect } from 'bun:test'
import { instantiate } from '@encantis/compiler/test-utils'
import { resolve } from 'path'

function setU128(view: DataView, offset: number, lo: bigint, hi: bigint) {
  view.setBigUint64(offset, lo, true)
  view.setBigUint64(offset + 8, hi, true)
}

function getU128(view: DataView, offset: number): [bigint, bigint] {
  return [view.getBigUint64(offset, true), view.getBigUint64(offset + 8, true)]
}

describe('u128 wasm round-trip', () => {
  async function setup() {
    const inst = await instantiate(resolve(import.meta.dir, 'u128test.ents'))
    const mem = inst.exports.mem as WebAssembly.Memory
    const view = new DataView(mem.buffer)
    return { e: inst.exports as any, view }
  }

  test('xor128', async () => {
    const { e, view } = await setup()
    setU128(view, 0, 0xFF00FF00FF00FF00n, 0x00FF00FF00FF00FFn)
    setU128(view, 16, 0xFFFFFFFFFFFFFFFFn, 0xFFFFFFFFFFFFFFFFn)
    e.test_xor()
    expect(getU128(view, 32)).toEqual([0x00FF00FF00FF00FFn, 0xFF00FF00FF00FF00n])
  })

  test('add128', async () => {
    const { e, view } = await setup()
    setU128(view, 0, 1n, 0n)
    setU128(view, 16, 2n, 0n)
    e.test_add()
    expect(getU128(view, 32)).toEqual([3n, 0n])
  })

  test('and128', async () => {
    const { e, view } = await setup()
    setU128(view, 0, 0xFF00n, 0n)
    setU128(view, 16, 0x0FF0n, 0n)
    e.test_and()
    expect(getU128(view, 32)).toEqual([0x0F00n, 0n])
  })

  test('or128', async () => {
    const { e, view } = await setup()
    setU128(view, 0, 0xFF00n, 0n)
    setU128(view, 16, 0x00FFn, 0n)
    e.test_or()
    expect(getU128(view, 32)).toEqual([0xFFFFn, 0n])
  })

  test('not128', async () => {
    const { e, view } = await setup()
    setU128(view, 0, 0n, 0n)
    e.test_not()
    expect(getU128(view, 32)).toEqual([0xFFFFFFFFFFFFFFFFn, 0xFFFFFFFFFFFFFFFFn])
  })

  test('eq128', async () => {
    const { e, view } = await setup()
    setU128(view, 0, 42n, 0n)
    setU128(view, 16, 42n, 0n)
    expect(e.test_eq()).toBe(1)

    setU128(view, 16, 43n, 0n)
    expect(e.test_eq()).toBe(0)

    setU128(view, 0, 0n, 1n)
    setU128(view, 16, 0n, 2n)
    expect(e.test_eq()).toBe(0)
  })

  test('widen64', async () => {
    const { e, view } = await setup()
    e.test_widen(12345n)
    expect(getU128(view, 32)).toEqual([12345n, 0n])
  })

  test('narrow128', async () => {
    const { e, view } = await setup()
    setU128(view, 0, 99n, 777n)
    expect(e.test_narrow()).toBe(99n)
  })

  test('mul_hi', async () => {
    const { e } = await setup()
    // 2^32 * 2^32 = 2^64 → high 64 bits = 1
    expect(e.test_mul_hi(0x100000000n, 0x100000000n)).toBe(1n)
    // small * small → 0 in high bits
    expect(e.test_mul_hi(100n, 200n)).toBe(0n)
  })
})
