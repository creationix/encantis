import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'

const wasmPath = new URL('./xxh32.wasm', import.meta.url).pathname
const wasmExists = existsSync(wasmPath)

describe.skipIf(!wasmExists)('xxh32', () => {
  test('generates expected hashes', async () => {
    const { xxh32 } = await import('./xxh32.js')
    expect(xxh32('')).toBe(0x02cc5d05)
    expect(xxh32('/blog/[slug]')).toBe(0xa326e96f)
    expect(xxh32('10.0.0.50', 0xa326e96f)).toBe(0xeb775bdf)
    expect(xxh32('10.0.0.51', 0xa326e96f)).toBe(0x75c92a0b)
    expect(xxh32('10.0.0.52', 0xa326e96f)).toBe(0x80165ec5)
    expect(xxh32('10.0.0.53', 0xa326e96f)).toBe(0xef6aeecf)
    expect(xxh32('10.0.0.54', 0xa326e96f)).toBe(0x0eb74b71)
  })
})
