import { describe, expect, test } from 'bun:test'
import {
  buildDataSection,
  layoutLiterals,
  type LiteralValue,
  type QualifiedLiteral,
  DataSectionBuilder,
  dataToWat,
} from './data-pack'
import { typecheck } from './checker'
import { array, primitive, type ArraySize } from './types'
import { parse } from './parser'

// Helper to create a u8 array type with sizes/framings
// size: numeric size or null for unbounded
// framings: '!' for null-terminated, '?' for LEB128 prefix
function u8Array(
  size: number | null,
  ...framings: Array<'null' | 'leb128' | 'u8'>
) {
  const sizes: ArraySize[] = []
  if (size !== null) {
    sizes.push(size)
  }
  for (const f of framings) {
    if (f === 'null') sizes.push('!')
    else if (f === 'leb128') sizes.push('?')
    // Note: 'u8' prefix is treated as LEB128 for now
    else if (f === 'u8') sizes.push('?')
  }
  return array(primitive('u8'), sizes.length > 0 ? sizes : null)
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
        { id: 'a', value: bytes('test'), type: u8Array(4) },
      ])

      expect(result.errors).toHaveLength(0)
      const ref = result.refs.get('a')
      expect(ref).toBeDefined()
      expect(ref!.len).toBe(4) // 't', 'e', 's', 't'
      expect(result.entries[0].bytes).toEqual(new Uint8Array([116, 101, 115, 116]))
    })

    test('u8[/0] - null terminated string', () => {
      const result = layoutLiterals([
        { id: 'a', value: bytes('hi'), type: u8Array(null, 'null') },
      ])

      expect(result.errors).toHaveLength(0)
      const ref = result.refs.get('a')
      expect(ref).toBeDefined()
      expect(ref!.len).toBe(3) // 'h', 'i', 0
      expect(result.entries[0].bytes).toEqual(new Uint8Array([104, 105, 0]))
    })

    test('u8[/u8] - length prefixed with u8', () => {
      const result = layoutLiterals([
        { id: 'a', value: bytes('abc'), type: u8Array(null, 'u8') },
      ])

      expect(result.errors).toHaveLength(0)
      const ref = result.refs.get('a')
      expect(ref).toBeDefined()
      expect(ref!.len).toBe(4) // length byte + 'a', 'b', 'c'
      expect(result.entries[0].bytes).toEqual(new Uint8Array([3, 97, 98, 99]))
    })

    test('u8[/leb128] - LEB128 length prefixed', () => {
      const result = layoutLiterals([
        { id: 'a', value: bytes('ab'), type: u8Array(null, 'leb128') },
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
        { id: 'a', value: bytes('hello'), type: u8Array(null, 'null') },
        { id: 'b', value: bytes('hello'), type: u8Array(null, 'null') },
      ])

      expect(result.errors).toHaveLength(0)
      const refA = result.refs.get('a')
      const refB = result.refs.get('b')
      expect(refA!.ptr).toBe(refB!.ptr) // Same pointer
      expect(result.entries).toHaveLength(1) // Only one entry
    })

    test('different strings are not deduplicated', () => {
      const result = layoutLiterals([
        { id: 'a', value: bytes('foo'), type: u8Array(null, 'null') },
        { id: 'b', value: bytes('bar'), type: u8Array(null, 'null') },
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
        { id: 'a', value: bytes('test'), type: u8Array(4), address: 100 },
      ])

      expect(result.errors).toHaveLength(0)
      const ref = result.refs.get('a')
      expect(ref!.ptr).toBe(100)
    })

    test('auto entries placed after explicit entries', () => {
      const result = layoutLiterals([
        { id: 'explicit', value: bytes('XXXX'), type: u8Array(4), address: 0 },
        { id: 'auto', value: bytes('auto'), type: u8Array(4) },
      ])

      expect(result.errors).toHaveLength(0)
      const explicitRef = result.refs.get('explicit')
      const autoRef = result.refs.get('auto')
      expect(explicitRef!.ptr).toBe(0)
      expect(autoRef!.ptr).toBe(4) // After the explicit entry
    })

    test('overlapping explicit entries generate error', () => {
      const result = layoutLiterals([
        { id: 'a', value: bytes('AAAA'), type: u8Array(4), address: 0 },
        { id: 'b', value: bytes('BB'), type: u8Array(2), address: 2 }, // Overlaps
      ])

      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('overlaps')
    })
  })

  describe('integer arrays', () => {
    test('i32[3] - fixed size i32 array', () => {
      const type = array(primitive('i32'), [3])
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
        { id: 'a', value: ints(0x41, 0x42, 0x43, 0x44), type: u8Array(4) },
      ])

      expect(result.errors).toHaveLength(0)
      expect(result.entries[0].bytes).toEqual(new Uint8Array([0x41, 0x42, 0x43, 0x44]))
    })
  })

  describe('merged specifiers (u8[/0/0])', () => {
    test('u8[/0/0] - double null terminated (string table)', () => {
      // This represents: ["hello", "world"] where each string is null-terminated
      // and the whole thing ends with an extra null
      const type = u8Array(null, 'null', 'null')
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
          type: u8Array(null, 'null', 'null'),
        },
        // Write simple values (1 specifier) - should find substrings
        { id: 'first', value: bytes('hello'), type: u8Array(null, 'null') },
        { id: 'second', value: bytes('world'), type: u8Array(null, 'null') },
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
        { id: 'simple', value: bytes('hello'), type: u8Array(null, 'null') },
        // Compound value (2 specifiers) - listed second but processed first
        {
          id: 'compound',
          value: nested(bytes('hello'), bytes('world')),
          type: u8Array(null, 'null', 'null'),
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
        { id: 'terminated', value: bytes('hello'), type: u8Array(null, 'null') },
        // Slice (0 specifiers) - raw bytes
        { id: 'slice', value: bytes('hello'), type: u8Array(null) },
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

describe('buildDataSection', () => {
  // A module the checker rejects: the second literal has a float for an i32.
  const check = typecheck(parse('data ok = [1, 2]\ndata bad: *[2]i32 = [1, 2.5]').module!)

  test('a literal that cannot be laid out stops the build', () => {
    expect(check.errors.map(e => e.message)).toEqual(['cannot assign float(2.5) to i32'])
    expect(() => buildDataSection(check.literals, check.types)).toThrow('Cannot serialize float literal')
  })

  test('tolerant, it is left out and the others are laid out', () => {
    const { literalRefs } = buildDataSection(check.literals, check.types, { tolerant: true })
    expect([...literalRefs.values()]).toEqual([{ ptr: 8, len: 8 }])
  })
})

describe('tables', () => {
  // The bytes of a module's data section, as 32-bit words from address 8.
  const words = (source: string): number[] => {
    const check = typecheck(parse(source).module!)
    expect(check.errors.map(e => e.message)).toEqual([])
    const section = buildDataSection(check.literals, check.types).dataBuilder.result()
    const memory = new Uint8Array(section.totalSize)
    for (const entry of section.entries) memory.set(entry.bytes, entry.offset)
    return Array.from(new Uint32Array(memory.buffer.slice(8)))
  }

  test('the rows lie apart, and the table holds their addresses', () => {
    expect(words('data m: *[2][3]i32 = [[7, 1, 2], [3, 4, 5]]')).toEqual([7, 1, 2, 3, 4, 5, 8, 20])
    expect(words('data s: [][2]i32 = [[7, 1], [3, 4]]')).toEqual([7, 1, 3, 4, 8, 16])
  })

  test('a many-pointer to rows holds row pointers too, not (ptr, len) pairs', () => {
    expect(words('data p: [*][2]i32 = [[7, 1], [3, 4]]')).toEqual([7, 1, 3, 4, 8, 16])
  })

  test('a repeated row is a row for each element', () => {
    expect(words('data c: *[3][2]i32 = [[1, 2]; 3]')).toEqual([1, 2, 8, 8, 8])
  })

  test('the rows of a mutable table are its own', () => {
    // Each row of `mut` has an address of its own, even where the bytes are
    // the same as another row's or another literal's.
    expect(words('data a: *[2]i32 = [0, 0]\ndata b: *mut [2][2]i32 = mut [[0; 2]; 2]')).toEqual([0, 0, 0, 0, 0, 0, 16, 24])
  })
})

describe('zeros', () => {
  const sectionOf = (source: string) => {
    const check = typecheck(parse(source).module!)
    expect(check.errors.map(e => e.message)).toEqual([])
    return buildDataSection(check.literals, check.types).dataBuilder.result()
  }

  test('a buffer of zeros costs nothing to lay out, however large', () => {
    // 2 GiB: as bytes, more memory than the compiler has. It keeps its place
    // and size, and has no bytes to write.
    const section = sectionOf('data space = mut [0:u8; 2147483648]\ndata tail = [7:u8]\ndata table = [0:u32; 1073741824]')
    expect(section.entries.map((e) => [e.offset, e.length, e.head.length])).toEqual([
      [8, 2147483648, 0],
      [2147483656, 1, 1],
      [2147483657, 4294967296, 0],
    ])
    expect(dataToWat(section)).toEqual([
      '  ;; 2147483648 zero bytes at 0x8 — 2147483648 zero bytes',
      '(data (i32.const 2147483656) "\\07")  ;; 1 bytes',
      '  ;; 4294967296 zero bytes at 0x80000009 — 4294967296 zero bytes',
    ])
  })

  test('a segment stops at the last byte that is not zero, and the zeros after it still hold their place', () => {
    const source = 'data a = [1:u32, 2, 0]\ndata b = [0:u8, 0, 0]\ndata c = [2:u8, 0]\ndata d: *[2]u16 = [0, 3]\ndata e = [0:u8; 9]'
    expect(dataToWat(sectionOf(source))).toEqual([
      '(data (i32.const 8) "\\01\\00\\00\\00\\02")  ;; [1, 2, 0]',
      '(data (i32.const 20) "\\00\\00\\03")  ;; [196608]',
    ])
    // b is three of a's zeros, c is a's 2 and the zero after it, and e the
    // last seven of a's zeros and the first two of d's: found in the zeros
    // that are only counted, as in bytes written out.
    const check = typecheck(parse(source).module!)
    const refs = [...buildDataSection(check.literals, check.types).literalRefs.values()]
    expect(refs.map((r) => r.ptr)).toEqual([8, 9, 12, 20, 13])
  })
})
