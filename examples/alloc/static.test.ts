import { describe, test, expect } from 'bun:test'
import { instantiate } from '@encantis/compiler/test-utils'
import { resolve } from 'path'

describe('static reservation allocator', () => {
  test('reserve, write, read round-trip', async () => {
    const inst = await instantiate(resolve(import.meta.dir, 'static.ents'))
    const e = inst.exports as any

    expect(e.used()).toBe(0)

    const off1 = e.reserve(16)
    expect(off1).toBe(0) // first allocation at offset 0
    expect(e.used()).toBe(16)

    const off2 = e.reserve(32)
    expect(off2).toBe(16) // second allocation right after first
    expect(e.used()).toBe(48)

    // Write and read bytes
    e.write(off1, 42)
    e.write(off1 + 1, 99)
    expect(e.read(off1)).toBe(42)
    expect(e.read(off1 + 1)).toBe(99)

    // Reset clears usage
    e.reset()
    expect(e.used()).toBe(0)
  })

  test('overflow returns 0', async () => {
    const inst = await instantiate(resolve(import.meta.dir, 'static.ents'))
    const e = inst.exports as any

    const ok = e.reserve(4000)
    expect(ok).toBe(0) // first allocation at offset 0

    // This should overflow (4000 + 200 > 4096)
    const fail = e.reserve(200)
    expect(fail >>> 0).toBe(0xFFFFFFFF)
    expect(e.used()).toBe(4000) // unchanged
  })
})
