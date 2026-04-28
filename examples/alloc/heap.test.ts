import { describe, test, expect } from 'bun:test'
import { instantiate } from '@encantis/compiler/test-utils'
import { resolve } from 'path'

describe('heap allocator', () => {
  test('malloc returns valid offsets', async () => {
    const inst = await instantiate(resolve(import.meta.dir, 'heap.ents'))
    const e = inst.exports as any

    const p1 = e.malloc(16)
    expect(p1 >>> 0).not.toBe(0xFFFFFFFF)

    const p2 = e.malloc(32)
    expect(p2 >>> 0).not.toBe(0xFFFFFFFF)
    expect(p2).toBeGreaterThan(p1)
  })

  test('malloc and free cycle', async () => {
    const inst = await instantiate(resolve(import.meta.dir, 'heap.ents'))
    const e = inst.exports as any

    const p1 = e.malloc(100)
    expect(p1 >>> 0).not.toBe(0xFFFFFFFF)
    const used1 = e.heap_used()
    expect(used1).toBe(100)

    e.free(p1)
    const used2 = e.heap_used()
    expect(used2).toBe(0)
  })

  test('can write and read through allocated memory', async () => {
    const inst = await instantiate(resolve(import.meta.dir, 'heap.ents'))
    const e = inst.exports as any
    const mem = (inst.exports.mem as WebAssembly.Memory)

    const ptr = e.malloc(8)
    const view = new Uint8Array(mem.buffer)
    view[ptr] = 42
    view[ptr + 1] = 99
    expect(view[ptr]).toBe(42)
    expect(view[ptr + 1]).toBe(99)
  })
})
