import { describe, test, expect } from 'bun:test'
import { instantiate } from '@encantis/compiler/test-utils'
import { resolve } from 'path'

describe('arena allocator', () => {
  test('init, alloc, and reset', async () => {
    const inst = await instantiate(resolve(import.meta.dir, 'arena.ents'))
    const e = inst.exports as any

    e.arena_init(1024)
    expect(e.arena_used()).toBe(0)

    const p1 = e.arena_alloc(64)
    expect(p1 >>> 0).not.toBe(0xFFFFFFFF)
    expect(e.arena_used()).toBe(64)

    const p2 = e.arena_alloc(128)
    expect(p2 >>> 0).not.toBe(0xFFFFFFFF)
    expect(p2).toBe(p1 + 64)
    expect(e.arena_used()).toBe(192)

    e.arena_reset()
    expect(e.arena_used()).toBe(0)

    // Can re-allocate after reset
    const p3 = e.arena_alloc(32)
    expect(p3).toBe(p1) // same base offset
  })

  test('overflow returns sentinel', async () => {
    const inst = await instantiate(resolve(import.meta.dir, 'arena.ents'))
    const e = inst.exports as any

    e.arena_init(100)
    const ok = e.arena_alloc(90)
    expect(ok >>> 0).not.toBe(0xFFFFFFFF)

    const fail = e.arena_alloc(20) // 90 + 20 > 100
    expect(fail >>> 0).toBe(0xFFFFFFFF)
  })

  test('write and read through arena memory', async () => {
    const inst = await instantiate(resolve(import.meta.dir, 'arena.ents'))
    const e = inst.exports as any
    const mem = inst.exports.mem as WebAssembly.Memory

    e.arena_init(256)
    const ptr = e.arena_alloc(8)
    const view = new Uint8Array(mem.buffer)
    view[ptr] = 42
    view[ptr + 7] = 255
    expect(view[ptr]).toBe(42)
    expect(view[ptr + 7]).toBe(255)
  })

  test('arena_free releases heap memory', async () => {
    const inst = await instantiate(resolve(import.meta.dir, 'arena.ents'))
    const e = inst.exports as any

    e.arena_init(512)
    expect(e.heap_bytes_used()).toBe(512)

    e.arena_free()
    expect(e.heap_bytes_used()).toBe(0)
    expect(e.arena_used()).toBe(0)
  })
})
