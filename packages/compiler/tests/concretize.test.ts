import { describe, expect, test } from 'bun:test'
import {
  concretizeType,
  isConcreteType,
  typecheck,
} from '../checker'
import {
  primitive,
  comptimeInt,
  comptimeFloat,
  comptimeList,
  tuple,
  field,
  pointer,
  indexed,
  func,
  VOID,
} from '../types'
import { parse } from '../parser'

// === concretizeType Tests ===

describe('concretizeType', () => {
  describe('comptime_int', () => {
    test('converts to i32 by default', () => {
      const type = comptimeInt(42n)
      const result = concretizeType(type)
      expect(result.kind).toBe('primitive')
      expect((result as { kind: 'primitive'; name: string }).name).toBe('i32')
    })

    test('converts to i64 when specified', () => {
      const type = comptimeInt(42n)
      const result = concretizeType(type, { defaultInt: 'i64', defaultFloat: 'f64' })
      expect(result.kind).toBe('primitive')
      expect((result as { kind: 'primitive'; name: string }).name).toBe('i64')
    })

    test('preserves comptime value info by replacing with concrete type', () => {
      const type = comptimeInt(9999999999n)
      const result = concretizeType(type)
      // Value is lost, but type is concrete
      expect(result.kind).toBe('primitive')
    })
  })

  describe('comptime_float', () => {
    test('converts to f64 by default', () => {
      const type = comptimeFloat(3.14)
      const result = concretizeType(type)
      expect(result.kind).toBe('primitive')
      expect((result as { kind: 'primitive'; name: string }).name).toBe('f64')
    })

    test('converts to f32 when specified', () => {
      const type = comptimeFloat(3.14)
      const result = concretizeType(type, { defaultInt: 'i32', defaultFloat: 'f32' })
      expect(result.kind).toBe('primitive')
      expect((result as { kind: 'primitive'; name: string }).name).toBe('f32')
    })
  })

  describe('comptime_list', () => {
    test('converts to slice with concretized element', () => {
      // comptimeList takes an array of element types
      const type = comptimeList([comptimeInt(1n), comptimeInt(2n)])
      const result = concretizeType(type)
      expect(result.kind).toBe('indexed')
      const indexed = result as { kind: 'indexed'; element: { kind: 'primitive'; name: string }; size: number | null }
      expect(indexed.size).toBeNull() // slice
      expect(indexed.element.kind).toBe('primitive')
      expect(indexed.element.name).toBe('i32')
    })

    test('empty list defaults to i32 element type', () => {
      const type = comptimeList([])
      const result = concretizeType(type)
      expect(result.kind).toBe('indexed')
      const indexed = result as { kind: 'indexed'; element: { kind: 'primitive'; name: string }; size: number | null }
      expect(indexed.element.name).toBe('i32')
    })
  })

  describe('primitives', () => {
    test('leaves i32 unchanged', () => {
      const type = primitive('i32')
      const result = concretizeType(type)
      expect(result).toEqual(type)
    })

    test('leaves f64 unchanged', () => {
      const type = primitive('f64')
      const result = concretizeType(type)
      expect(result).toEqual(type)
    })

    test('leaves bool unchanged', () => {
      const type = primitive('bool')
      const result = concretizeType(type)
      expect(result).toEqual(type)
    })
  })

  describe('tuple', () => {
    test('concretizes all fields', () => {
      const type = tuple([
        field('x', comptimeInt(1n)),
        field('y', comptimeFloat(2.0)),
      ])
      const result = concretizeType(type)

      expect(result.kind).toBe('tuple')
      const t = result as { kind: 'tuple'; fields: Array<{ name: string | null; type: { kind: string; name?: string } }> }
      expect(t.fields[0].type.kind).toBe('primitive')
      expect(t.fields[0].type.name).toBe('i32')
      expect(t.fields[1].type.kind).toBe('primitive')
      expect(t.fields[1].type.name).toBe('f64')
    })

    test('leaves concrete fields unchanged', () => {
      const type = tuple([
        field('a', primitive('i32')),
        field('b', primitive('f64')),
      ])
      const result = concretizeType(type)
      expect(result).toEqual(type)
    })

    test('handles nested tuples', () => {
      const inner = tuple([field('x', comptimeInt(0n))])
      const outer = tuple([field('inner', inner)])
      const result = concretizeType(outer)

      expect(result.kind).toBe('tuple')
      const t = result as { kind: 'tuple'; fields: Array<{ type: { kind: string; fields?: Array<{ type: { kind: string; name?: string } }> } }> }
      expect(t.fields[0].type.kind).toBe('tuple')
      expect(t.fields[0].type.fields![0].type.kind).toBe('primitive')
      expect(t.fields[0].type.fields![0].type.name).toBe('i32')
    })
  })

  describe('indexed', () => {
    test('concretizes element type', () => {
      const type = indexed(comptimeInt(0n), 10)
      const result = concretizeType(type)

      expect(result.kind).toBe('indexed')
      const i = result as { kind: 'indexed'; element: { kind: string; name?: string }; size: number | null }
      expect(i.element.kind).toBe('primitive')
      expect(i.element.name).toBe('i32')
      expect(i.size).toBe(10)
    })

    test('leaves concrete array unchanged', () => {
      const type = indexed(primitive('u8'), 100)
      const result = concretizeType(type)
      expect(result).toEqual(type)
    })
  })

  describe('pointer', () => {
    test('concretizes pointee type', () => {
      const type = pointer(comptimeInt(0n))
      const result = concretizeType(type)

      expect(result.kind).toBe('pointer')
      const p = result as { kind: 'pointer'; pointee: { kind: string; name?: string } }
      expect(p.pointee.kind).toBe('primitive')
      expect(p.pointee.name).toBe('i32')
    })

    test('leaves concrete pointer unchanged', () => {
      const type = pointer(primitive('u8'))
      const result = concretizeType(type)
      expect(result).toEqual(type)
    })
  })

  describe('func', () => {
    test('concretizes params and returns', () => {
      const type = func(
        [field('x', comptimeInt(0n))],
        [field(null, comptimeFloat(0))]
      )
      const result = concretizeType(type)

      expect(result.kind).toBe('func')
      const f = result as {
        kind: 'func'
        params: Array<{ type: { kind: string; name?: string } }>
        returns: Array<{ type: { kind: string; name?: string } }>
      }
      expect(f.params[0].type.kind).toBe('primitive')
      expect(f.params[0].type.name).toBe('i32')
      expect(f.returns[0].type.kind).toBe('primitive')
      expect(f.returns[0].type.name).toBe('f64')
    })
  })

  describe('void', () => {
    test('leaves void unchanged', () => {
      const result = concretizeType(VOID)
      expect(result).toEqual(VOID)
    })
  })
})

// === isConcreteType Tests ===

describe('isConcreteType', () => {
  test('primitives are concrete', () => {
    expect(isConcreteType(primitive('i32'))).toBe(true)
    expect(isConcreteType(primitive('f64'))).toBe(true)
    expect(isConcreteType(primitive('bool'))).toBe(true)
    expect(isConcreteType(primitive('u8'))).toBe(true)
  })

  test('comptime_int is not concrete', () => {
    expect(isConcreteType(comptimeInt(42n))).toBe(false)
  })

  test('comptime_float is not concrete', () => {
    expect(isConcreteType(comptimeFloat(3.14))).toBe(false)
  })

  test('comptime_list is not concrete', () => {
    expect(isConcreteType(comptimeList([primitive('i32')]))).toBe(false)
  })

  test('tuple with comptime field is not concrete', () => {
    const type = tuple([
      field('a', primitive('i32')),
      field('b', comptimeInt(0n)),
    ])
    expect(isConcreteType(type)).toBe(false)
  })

  test('tuple with all concrete fields is concrete', () => {
    const type = tuple([
      field('a', primitive('i32')),
      field('b', primitive('f64')),
    ])
    expect(isConcreteType(type)).toBe(true)
  })

  test('void is concrete', () => {
    expect(isConcreteType(VOID)).toBe(true)
  })

  test('pointer to comptime is not concrete', () => {
    expect(isConcreteType(pointer(comptimeInt(0n)))).toBe(false)
  })

  test('pointer to primitive is concrete', () => {
    expect(isConcreteType(pointer(primitive('u8')))).toBe(true)
  })
})

// === typecheck integration tests ===

describe('typecheck', () => {
  test('produces concrete types for all expressions', () => {
    const code = `func test() -> i32 => 42`
    const parseResult = parse(code)
    const checkResult = typecheck(parseResult.module!)

    // All types should be concrete after typecheck
    for (const [, type] of checkResult.types) {
      expect(isConcreteType(type)).toBe(true)
    }
  })

  test('respects custom options', () => {
    const code = `func test() => 42`
    const parseResult = parse(code)
    const checkResult = typecheck(parseResult.module!, { defaultInt: 'i64', defaultFloat: 'f32' })

    // Check that the integer literal was concretized to i64
    let foundI64 = false
    for (const [, type] of checkResult.types) {
      if (type.kind === 'primitive' && type.name === 'i64') {
        foundI64 = true
        break
      }
    }
    expect(foundI64).toBe(true)
  })
})
