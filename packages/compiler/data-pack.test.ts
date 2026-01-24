import { describe, expect, test } from 'bun:test'
import {
  layoutLiterals,
  type LiteralValue,
  type QualifiedLiteral,
  DataSectionBuilder,
} from './data-pack'
import { indexed, primitive } from './types'
import { parse } from './parser'

// Helper to create a u8 indexed type with specifiers
function u8Indexed(
  size: number | null,
  ...specifiers: Array<'null' | 'leb128'>
) {
  return indexed(
    primitive('u8'),
    size,
    specifiers.map((s) =>
      s === 'null' ? { kind: 'null' as const } : { kind: 'prefix' as const },
    ),
  )
}

// Helper to create bytes literal value
function bytes(str: string): LiteralValue {
  return { kind: 'bytes', data: new TextEncoder().encode(str) }
}

// Helper to create int array literal value
function ints(...values: number[]): LiteralValue {
  return { kind: 'ints', data: values.map(BigInt) }
}

// Helper to create nested literal value
function nested(...elements: LiteralValue[]): LiteralValue {
  return { kind: 'nested', elements }
}

describe('layoutLiterals', () => {
  describe('simple string literals', () => {
    test('u8[4] - fixed size array without terminator', () => {
      const result = layoutLiterals([
        { id: 'a', value: bytes('test'), type: u8Indexed(4) },
      ])

      expect(result.errors).toHaveLength(0)
      const ref = result.refs.get('a')
      expect(ref).toBeDefined()
      expect(ref!.len).toBe(4) // 't', 'e', 's', 't'
      expect(result.entries[0].bytes).toEqual(new Uint8Array([116, 101, 115, 116]))
    })

    test('u8[/0] - null terminated string', () => {
      const result = layoutLiterals([
        { id: 'a', value: bytes('hi'), type: u8Indexed(null, 'null') },
      ])

      expect(result.errors).toHaveLength(0)
      const ref = result.refs.get('a')
      expect(ref).toBeDefined()
      expect(ref!.len).toBe(3) // 'h', 'i', 0
      expect(result.entries[0].bytes).toEqual(new Uint8Array([104, 105, 0]))
    })

    test('u8[/u8] - length prefixed with u8', () => {
      const result = layoutLiterals([
        { id: 'a', value: bytes('abc'), type: u8Indexed(null, 'u8') },
      ])

      expect(result.errors).toHaveLength(0)
      const ref = result.refs.get('a')
      expect(ref).toBeDefined()
      expect(ref!.len).toBe(4) // length byte + 'a', 'b', 'c'
      expect(result.entries[0].bytes).toEqual(new Uint8Array([3, 97, 98, 99]))
    })

    test('u8[/leb128] - LEB128 length prefixed', () => {
      const result = layoutLiterals([
        { id: 'a', value: bytes('ab'), type: u8Indexed(null, 'leb128') },
      ])

      expect(result.errors).toHaveLength(0)
      const ref = result.refs.get('a')
      expect(ref!.len).toBe(3) // LEB128(2) + 'a', 'b'
      expect(result.entries[0].bytes).toEqual(new Uint8Array([2, 97, 98]))
    })
  })

  describe('deduplication', () => {
    test('identical strings are deduplicated', () => {
      const result = layoutLiterals([
        { id: 'a', value: bytes('hello'), type: u8Indexed(null, 'null') },
        { id: 'b', value: bytes('hello'), type: u8Indexed(null, 'null') },
      ])

      expect(result.errors).toHaveLength(0)
      const refA = result.refs.get('a')
      const refB = result.refs.get('b')
      expect(refA!.ptr).toBe(refB!.ptr) // Same pointer
      expect(result.entries).toHaveLength(1) // Only one entry
    })

    test('different strings are not deduplicated', () => {
      const result = layoutLiterals([
        { id: 'a', value: bytes('foo'), type: u8Indexed(null, 'null') },
        { id: 'b', value: bytes('bar'), type: u8Indexed(null, 'null') },
      ])

      expect(result.entries).toHaveLength(2)
      const refA = result.refs.get('a')
      const refB = result.refs.get('b')
      expect(refA!.ptr).not.toBe(refB!.ptr)
    })
  })

  describe('explicit addresses', () => {
    test('explicit address places data at specified offset', () => {
      const result = layoutLiterals([
        { id: 'a', value: bytes('test'), type: u8Indexed(4), address: 100 },
      ])

      expect(result.errors).toHaveLength(0)
      const ref = result.refs.get('a')
      expect(ref!.ptr).toBe(100)
    })

    test('auto entries placed after explicit entries', () => {
      const result = layoutLiterals([
        { id: 'explicit', value: bytes('XXXX'), type: u8Indexed(4), address: 0 },
        { id: 'auto', value: bytes('auto'), type: u8Indexed(4) },
      ])

      expect(result.errors).toHaveLength(0)
      const explicitRef = result.refs.get('explicit')
      const autoRef = result.refs.get('auto')
      expect(explicitRef!.ptr).toBe(0)
      expect(autoRef!.ptr).toBe(4) // After the explicit entry
    })

    test('overlapping explicit entries generate error', () => {
      const result = layoutLiterals([
        { id: 'a', value: bytes('AAAA'), type: u8Indexed(4), address: 0 },
        { id: 'b', value: bytes('BB'), type: u8Indexed(2), address: 2 }, // Overlaps
      ])

      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('overlaps')
    })
  })

  describe('integer arrays', () => {
    test('i32[3] - fixed size i32 array', () => {
      const type = indexed(primitive('i32'), 3, [])
      const result = layoutLiterals([
        { id: 'a', value: ints(1, 2, 3), type },
      ])

      expect(result.errors).toHaveLength(0)
      const ref = result.refs.get('a')
      expect(ref!.len).toBe(12) // 3 * 4 bytes
      // Little endian: 1, 2, 3
      expect(result.entries[0].bytes).toEqual(
        new Uint8Array([1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0]),
      )
    })

    test('u8[4] - byte array', () => {
      const result = layoutLiterals([
        { id: 'a', value: ints(0x41, 0x42, 0x43, 0x44), type: u8Indexed(4) },
      ])

      expect(result.errors).toHaveLength(0)
      expect(result.entries[0].bytes).toEqual(new Uint8Array([0x41, 0x42, 0x43, 0x44]))
    })
  })

  describe('merged specifiers (u8[/0/0])', () => {
    test('u8[/0/0] - double null terminated (string table)', () => {
      // This represents: ["hello", "world"] where each string is null-terminated
      // and the whole thing ends with an extra null
      const type = u8Indexed(null, 'null', 'null')
      const result = layoutLiterals([
        {
          id: 'table',
          value: nested(bytes('hello'), bytes('world')),
          type,
        },
      ])

      expect(result.errors).toHaveLength(0)
      const ref = result.refs.get('table')
      // "hello\0world\0\0" = 5 + 1 + 5 + 1 + 1 = 13 bytes
      expect(ref!.len).toBe(13)
      expect(result.entries[0].bytes).toEqual(
        new Uint8Array([
          104, 101, 108, 108, 111, 0, // "hello\0"
          119, 111, 114, 108, 100, 0, // "world\0"
          0, // final null terminator
        ]),
      )
    })
  })

  describe('substring deduplication', () => {
    test('finds substring within previously written data', () => {
      // Write compound first (sorted by specifier depth), then simpler values
      // should find "hello\0" within "hello\0world\0\0"
      const result = layoutLiterals([
        // Write compound value (2 specifiers) - will be processed first due to sorting
        {
          id: 'compound',
          value: nested(bytes('hello'), bytes('world')),
          type: u8Indexed(null, 'null', 'null'),
        },
        // Write simple values (1 specifier) - should find substrings
        { id: 'first', value: bytes('hello'), type: u8Indexed(null, 'null') },
        { id: 'second', value: bytes('world'), type: u8Indexed(null, 'null') },
      ])

      expect(result.errors).toHaveLength(0)

      // Compound writes "hello\0world\0\0" (13 bytes)
      const compound = result.refs.get('compound')
      expect(compound).toBeDefined()
      expect(compound!.ptr).toBe(0)
      expect(compound!.len).toBe(13)

      // "first" should find "hello\0" at offset 0 within compound
      const first = result.refs.get('first')
      expect(first).toBeDefined()
      expect(first!.ptr).toBe(0) // Found at beginning
      expect(first!.len).toBe(6)

      // "second" should find "world\0" at offset 6 within compound
      const second = result.refs.get('second')
      expect(second).toBeDefined()
      expect(second!.ptr).toBe(6) // Found at offset 6
      expect(second!.len).toBe(6)

      // Total size should only be 13 bytes (compound), not 13 + 6 + 6 = 25
      expect(result.totalSize).toBe(13)
    })

    test('sorting by specifier depth enables deduplication', () => {
      // Even when simpler value comes first in the list,
      // it gets processed after compound due to sorting
      const result = layoutLiterals([
        // Simple value (1 specifier) - listed first but processed second
        { id: 'simple', value: bytes('hello'), type: u8Indexed(null, 'null') },
        // Compound value (2 specifiers) - listed second but processed first
        {
          id: 'compound',
          value: nested(bytes('hello'), bytes('world')),
          type: u8Indexed(null, 'null', 'null'),
        },
      ])

      expect(result.errors).toHaveLength(0)

      // Compound should be at offset 0 (processed first due to sorting)
      const compound = result.refs.get('compound')
      expect(compound!.ptr).toBe(0)
      expect(compound!.len).toBe(13)

      // Simple should find substring within compound
      const simple = result.refs.get('simple')
      expect(simple!.ptr).toBe(0) // Found "hello\0" at offset 0
      expect(simple!.len).toBe(6)

      // Total size is just compound size
      expect(result.totalSize).toBe(13)
    })

    test('raw bytes without specifiers can still be found', () => {
      // Slice content (no specifiers) can be found in terminated content
      const result = layoutLiterals([
        // Null-terminated (1 specifier)
        { id: 'terminated', value: bytes('hello'), type: u8Indexed(null, 'null') },
        // Slice (0 specifiers) - raw bytes
        { id: 'slice', value: bytes('hello'), type: u8Indexed(null) },
      ])

      expect(result.errors).toHaveLength(0)

      // Terminated writes "hello\0" (6 bytes) - processed first (more specifiers)
      const terminated = result.refs.get('terminated')
      expect(terminated!.ptr).toBe(0)
      expect(terminated!.len).toBe(6)

      // Slice finds "hello" within "hello\0"
      const slice = result.refs.get('slice')
      expect(slice!.ptr).toBe(0)
      expect(slice!.len).toBe(5)

      // Total size is just 6 bytes
      expect(result.totalSize).toBe(6)
    })
  })
})
