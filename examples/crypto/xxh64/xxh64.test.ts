import { expect, test } from 'bun:test'
import { xxh64 } from './xxh64.js'

test('generates expected hashes', () => {
  expect(xxh64('')).toBe(0xef46db3751d8e999n)
  expect(xxh64('/blog/[slug]')).toBe(0xa03423257dbc684en)
  expect(xxh64('10.0.0.50', 0xa03423257dbc684en)).toBe(0x191a5c72be370c76n)
  expect(xxh64('10.0.0.51', 0xa03423257dbc684en)).toBe(0x248ada99b67f8c68n)
  expect(xxh64('10.0.0.52', 0xa03423257dbc684en)).toBe(0x51aa6394e3f7c05en)
  expect(xxh64('10.0.0.53', 0xa03423257dbc684en)).toBe(0x2cecde5cb46c84b6n)
  expect(xxh64('10.0.0.54', 0xa03423257dbc684en)).toBe(0x0c7cdbd96f0a5b6bn)
})
