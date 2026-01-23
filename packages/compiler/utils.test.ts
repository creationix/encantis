import { describe, expect, test } from 'bun:test'
import {
  bytesToHex,
  hexToBytes,
  concatBytes,
  encodeLEB128,
  decodeLEB128,
  serializeInt,
  serializeI32,
  serializeFloat,
  serializeF64,
  bigintReplacer,
} from './utils'

describe('hex encoding', () => {
  test('bytesToHex converts bytes to lowercase hex', () => {
    expect(bytesToHex(new Uint8Array([0x00]))).toBe('00')
    expect(bytesToHex(new Uint8Array([0xff]))).toBe('ff')
    expect(bytesToHex(new Uint8Array([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]))).toBe(
      '0123456789abcdef',
    )
    expect(bytesToHex(new Uint8Array([]))).toBe('')
  })

  test('hexToBytes converts hex string to bytes', () => {
    expect(hexToBytes('00')).toEqual(new Uint8Array([0x00]))
    expect(hexToBytes('ff')).toEqual(new Uint8Array([0xff]))
    expect(hexToBytes('0123456789abcdef')).toEqual(
      new Uint8Array([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]),
    )
    expect(hexToBytes('')).toEqual(new Uint8Array([]))
  })

  test('hexToBytes handles uppercase', () => {
    expect(hexToBytes('ABCDEF')).toEqual(new Uint8Array([0xab, 0xcd, 0xef]))
  })

  test('bytesToHex and hexToBytes are inverses', () => {
    const original = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]) // "Hello"
    expect(hexToBytes(bytesToHex(original))).toEqual(original)
  })
})

describe('concatBytes', () => {
  test('concatenates multiple arrays', () => {
    const a = new Uint8Array([1, 2])
    const b = new Uint8Array([3, 4, 5])
    const c = new Uint8Array([6])
    expect(concatBytes([a, b, c])).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]))
  })

  test('handles empty arrays', () => {
    expect(concatBytes([])).toEqual(new Uint8Array([]))
    expect(concatBytes([new Uint8Array([])])).toEqual(new Uint8Array([]))
    expect(concatBytes([new Uint8Array([1]), new Uint8Array([])])).toEqual(new Uint8Array([1]))
  })

  test('handles single array', () => {
    const a = new Uint8Array([1, 2, 3])
    expect(concatBytes([a])).toEqual(new Uint8Array([1, 2, 3]))
  })
})

describe('LEB128 encoding', () => {
  test('encodeLEB128 encodes small values', () => {
    expect(encodeLEB128(0)).toEqual(new Uint8Array([0x00]))
    expect(encodeLEB128(1)).toEqual(new Uint8Array([0x01]))
    expect(encodeLEB128(127)).toEqual(new Uint8Array([0x7f]))
  })

  test('encodeLEB128 encodes multi-byte values', () => {
    expect(encodeLEB128(128)).toEqual(new Uint8Array([0x80, 0x01]))
    expect(encodeLEB128(255)).toEqual(new Uint8Array([0xff, 0x01]))
    expect(encodeLEB128(300)).toEqual(new Uint8Array([0xac, 0x02]))
    expect(encodeLEB128(16384)).toEqual(new Uint8Array([0x80, 0x80, 0x01]))
  })

  test('decodeLEB128 decodes values', () => {
    expect(decodeLEB128(new Uint8Array([0x00]))).toEqual({ value: 0, bytesRead: 1 })
    expect(decodeLEB128(new Uint8Array([0x7f]))).toEqual({ value: 127, bytesRead: 1 })
    expect(decodeLEB128(new Uint8Array([0x80, 0x01]))).toEqual({ value: 128, bytesRead: 2 })
    expect(decodeLEB128(new Uint8Array([0xac, 0x02]))).toEqual({ value: 300, bytesRead: 2 })
  })

  test('decodeLEB128 with offset', () => {
    const bytes = new Uint8Array([0x99, 0xac, 0x02, 0x77])
    expect(decodeLEB128(bytes, 1)).toEqual({ value: 300, bytesRead: 2 })
  })

  test('encodeLEB128 and decodeLEB128 are inverses', () => {
    for (const n of [0, 1, 127, 128, 255, 300, 16383, 16384, 1000000]) {
      const encoded = encodeLEB128(n)
      const decoded = decodeLEB128(encoded)
      expect(decoded.value).toBe(n)
      expect(decoded.bytesRead).toBe(encoded.length)
    }
  })
})

describe('integer serialization', () => {
  test('serializeInt i8/u8', () => {
    expect(serializeInt(0n, 'i8')).toEqual(new Uint8Array([0x00]))
    expect(serializeInt(127n, 'i8')).toEqual(new Uint8Array([0x7f]))
    expect(serializeInt(-1n, 'i8')).toEqual(new Uint8Array([0xff]))
    expect(serializeInt(255n, 'u8')).toEqual(new Uint8Array([0xff]))
  })

  test('serializeInt i16/u16 little-endian', () => {
    expect(serializeInt(0x0102n, 'i16')).toEqual(new Uint8Array([0x02, 0x01]))
    expect(serializeInt(0xffffn, 'u16')).toEqual(new Uint8Array([0xff, 0xff]))
  })

  test('serializeInt i32/u32 little-endian', () => {
    expect(serializeInt(0x01020304n, 'i32')).toEqual(new Uint8Array([0x04, 0x03, 0x02, 0x01]))
    expect(serializeInt(0xffffffffn, 'u32')).toEqual(new Uint8Array([0xff, 0xff, 0xff, 0xff]))
  })

  test('serializeInt i64/u64 little-endian', () => {
    expect(serializeInt(0x0102030405060708n, 'i64')).toEqual(
      new Uint8Array([0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]),
    )
  })

  test('serializeInt returns null for unknown types', () => {
    expect(serializeInt(0n, 'bool')).toBeNull()
    expect(serializeInt(0n, 'unknown')).toBeNull()
  })

  test('serializeI32 little-endian', () => {
    expect(serializeI32(0x01020304)).toEqual(new Uint8Array([0x04, 0x03, 0x02, 0x01]))
    expect(serializeI32(-1)).toEqual(new Uint8Array([0xff, 0xff, 0xff, 0xff]))
    expect(serializeI32(0)).toEqual(new Uint8Array([0x00, 0x00, 0x00, 0x00]))
  })
})

describe('float serialization', () => {
  test('serializeFloat f32', () => {
    const bytes = serializeFloat(1.0, 'f32')!
    expect(bytes.length).toBe(4)
    // 1.0 in f32 little-endian is 0x3f800000
    expect(bytes).toEqual(new Uint8Array([0x00, 0x00, 0x80, 0x3f]))
  })

  test('serializeFloat f64', () => {
    const bytes = serializeFloat(1.0, 'f64')!
    expect(bytes.length).toBe(8)
    // 1.0 in f64 little-endian is 0x3ff0000000000000
    expect(bytes).toEqual(new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f]))
  })

  test('serializeFloat returns null for unknown types', () => {
    expect(serializeFloat(1.0, 'i32')).toBeNull()
  })

  test('serializeF64', () => {
    const bytes = serializeF64(1.0)
    expect(bytes.length).toBe(8)
    expect(bytes).toEqual(new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f]))
  })

  test('serializeF64 handles special values', () => {
    // Zero
    expect(serializeF64(0.0)).toEqual(new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]))
    // Negative zero
    expect(serializeF64(-0.0)).toEqual(new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80]))
  })
})

describe('bigintReplacer', () => {
  test('converts bigint to string', () => {
    expect(bigintReplacer('key', 123n)).toBe('123')
    expect(bigintReplacer('key', -456n)).toBe('-456')
    expect(bigintReplacer('key', 0n)).toBe('0')
  })

  test('passes through other values', () => {
    expect(bigintReplacer('key', 123)).toBe(123)
    expect(bigintReplacer('key', 'string')).toBe('string')
    expect(bigintReplacer('key', null)).toBeNull()
    expect(bigintReplacer('key', { a: 1 })).toEqual({ a: 1 })
  })

  test('works with JSON.stringify', () => {
    const obj = { num: 42, big: 9007199254740993n, str: 'hello' }
    const json = JSON.stringify(obj, bigintReplacer)
    expect(json).toBe('{"num":42,"big":"9007199254740993","str":"hello"}')
  })
})
