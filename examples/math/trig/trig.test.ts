import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'

const wasmPath = new URL('./trig.wasm', import.meta.url).pathname
const wasmExists = existsSync(wasmPath)

describe.skipIf(!wasmExists)('trig', () => {
  test('converts cartesian to polar', async () => {
    const { toPolar } = await import('./trig.js')
    const [d, a] = toPolar(3.1, 4.2)
    expect(d).toBeCloseTo(5.220153254559187)
    expect(a).toBeCloseTo(0.9354594435495296)
  })

  test('converts polar to cartesian', async () => {
    const { fromPolar, toPolar } = await import('./trig.js')
    const [d, a] = toPolar(3.1, 4.2)
    const [x, y] = fromPolar(d, a)
    expect(x).toBeCloseTo(3.1)
    expect(y).toBeCloseTo(4.2)
  })

  test('handles origin', async () => {
    const { toPolar } = await import('./trig.js')
    const [d] = toPolar(0, 0)
    expect(d).toBe(0)
  })

  test('handles unit circle points', async () => {
    const { fromPolar } = await import('./trig.js')
    const [x, y] = fromPolar(1, 0)
    expect(x).toBeCloseTo(1)
    expect(y).toBeCloseTo(0)

    const [x2, y2] = fromPolar(1, Math.PI / 2)
    expect(x2).toBeCloseTo(0)
    expect(y2).toBeCloseTo(1)
  })
})
