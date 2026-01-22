import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'

const wasmPath = new URL('./xxh64.wasm', import.meta.url).pathname
const wasmExists = existsSync(wasmPath)

describe.skipIf(!wasmExists)('xxh64', () => {
  test('generates expected hashes', async () => {
    const { xxh64 } = await import('./xxh64.js')
    expect(xxh64('')).toBe(0xef46db3751d8e999n)
    expect(xxh64('/blog/[slug]')).toBe(0xa03423257dbc684en)
    expect(xxh64('10.0.0.50', 0xa03423257dbc684en)).toBe(0x191a5c72be370c76n)
    expect(xxh64('10.0.0.51', 0xa03423257dbc684en)).toBe(0x248ada99b67f8c68n)
    expect(xxh64('10.0.0.52', 0xa03423257dbc684en)).toBe(0x51aa6394e3f7c05en)
    expect(xxh64('10.0.0.53', 0xa03423257dbc684en)).toBe(0x2cecde5cb46c84b6n)
    expect(xxh64('10.0.0.54', 0xa03423257dbc684en)).toBe(0x0c7cdbd96f0a5b6bn)
  })
})
