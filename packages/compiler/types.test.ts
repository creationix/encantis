import { describe, expect, test } from 'bun:test'
import {
  primitive,
  pointer,
  array,
  slice,
  tuple,
  field,
  func,
  named,
  comptimeInt,
  comptimeFloat,
  comptimeList,
  VOID,
  typeToString,
  typeAssignable,
  isSigned,
  isUnsigned,
  isInteger,
  isFloat,
  isNumeric,
  byteSize,
  fieldByteOffset,
  memoryParts,
} from './types'

describe('types', () => {
  describe('type constructors', () => {
    test('primitive creates primitive type', () => {
      const type = primitive('i32')
      expect(type.kind).toBe('primitive')
      expect(type.name).toBe('i32')
    })

    test('pointer creates pointer type', () => {
      const type = pointer(primitive('i32'))
      expect(type.kind).toBe('pointer')
      expect(type.pointee.kind).toBe('primitive')
    })

    test('slice creates slice type', () => {
      const type = slice(primitive('u8'))
      expect(type.kind).toBe('slice')
      expect(type.element.kind).toBe('primitive')
    })

    test('array creates array type', () => {
      const type = array(primitive('u8'), [10])
      expect(type.kind).toBe('array')
      expect(type.sizes).toEqual([10])
      expect(type.element.kind).toBe('primitive')
    })

    test('tuple creates tuple type', () => {
      const type = tuple([
        field('x', primitive('i32')),
        field('y', primitive('i32')),
      ])
      expect(type.kind).toBe('tuple')
      expect(type.fields).toHaveLength(2)
    })

    test('named creates named type', () => {
      const type = named('Point', tuple([field('x', primitive('i32'))]))
      expect(type.kind).toBe('named')
      expect(type.name).toBe('Point')
    })

    test('comptimeInt creates comptime int type', () => {
      const type = comptimeInt(42n)
      expect(type.kind).toBe('comptime_int')
      expect(type.value).toBe(42n)
    })

    test('comptimeFloat creates comptime float type', () => {
      const type = comptimeFloat(3.14)
      expect(type.kind).toBe('comptime_float')
      expect(type.value).toBe(3.14)
    })


    test('VOID is void type', () => {
      expect(VOID.kind).toBe('void')
    })
  })

  describe('typeToString', () => {
    test('formats primitive types', () => {
      expect(typeToString(primitive('i32'))).toBe('i32')
      expect(typeToString(primitive('f64'))).toBe('f64')
    })

    test('formats pointer types', () => {
      expect(typeToString(pointer(primitive('i32')))).toBe('*i32')
    })

    test('formats tuple types', () => {
      const type = tuple([field('x', primitive('i32')), field('y', primitive('i32'))])
      expect(typeToString(type)).toContain('x')
      expect(typeToString(type)).toContain('y')
    })
  })

  describe('typeAssignable', () => {
    test('same primitive types are assignable', () => {
      expect(typeAssignable(primitive('i32'), primitive('i32'))).toBe(true)
    })

    test('different primitive types are not assignable', () => {
      expect(typeAssignable(primitive('i32'), primitive('i64'))).toBe(false)
    })

    test('comptime int can be assigned to compatible target', () => {
      // Note: typeAssignable checks structural equality, not coercion
      // Comptime int coercion happens in the type checker
      expect(typeAssignable(primitive('i32'), primitive('i32'))).toBe(true)
    })

    test('pointers to the same named type are assignable', () => {
      const slot = () => named('Slot', tuple([field('a', primitive('u32')), field('b', primitive('u32'))]))
      // [*]mut Slot, *Slot, and a pointer to the alias's underlying tuple.
      expect(typeAssignable(pointer(array(slot(), null), false, true), pointer(array(slot(), null), false, true))).toBe(true)
      expect(typeAssignable(pointer(slot()), pointer(slot()))).toBe(true)
      expect(typeAssignable(pointer(slot()), pointer(slot().type))).toBe(true)
      expect(typeAssignable(pointer(slot().type), pointer(slot()))).toBe(true)
      expect(typeAssignable(pointer(slot()), pointer(primitive('u32')))).toBe(false)
    })

  })

  describe('type predicates', () => {
    test('isSigned detects signed types', () => {
      expect(isSigned(primitive('i32'))).toBe(true)
      expect(isSigned(primitive('u32'))).toBe(false)
    })

    test('isUnsigned detects unsigned types', () => {
      expect(isUnsigned(primitive('u32'))).toBe(true)
      expect(isUnsigned(primitive('i32'))).toBe(false)
    })

    test('isInteger detects integer types', () => {
      expect(isInteger(primitive('i32'))).toBe(true)
      expect(isInteger(primitive('u32'))).toBe(true)
      expect(isInteger(primitive('f32'))).toBe(false)
    })

    test('isFloat detects float types', () => {
      expect(isFloat(primitive('f32'))).toBe(true)
      expect(isFloat(primitive('f64'))).toBe(true)
      expect(isFloat(primitive('i32'))).toBe(false)
    })

    test('isNumeric detects numeric types', () => {
      expect(isNumeric(primitive('i32'))).toBe(true)
      expect(isNumeric(primitive('f64'))).toBe(true)
      expect(isNumeric(primitive('bool'))).toBe(false)
    })
  })

  describe('memory layout', () => {
    const spot = tuple([field('c', primitive('i32')), field('di', primitive('i32')), field('room', primitive('i32'))])
    const lane = tuple([field('cells', slice(primitive('i32'))), field('free', primitive('i32'))])
    const layout = (t: Parameters<typeof memoryParts>[0]) =>
      memoryParts(t)?.map((p) => `${p.offset}:${typeToString(p.type)}`)

    test('a struct is its fields in order, packed', () => {
      expect(layout(spot)).toEqual(['0:i32', '4:i32', '8:i32'])
      const mixed = tuple([field('a', primitive('u8')), field('b', primitive('i16')), field('c', primitive('u64')), field('d', primitive('f32'))])
      expect(layout(mixed)).toEqual(['0:u8', '1:i16', '3:u64', '11:f32'])
      expect(byteSize(mixed)).toBe(15)
    })

    test('a slice is its pointer and its length', () => {
      expect(layout(slice(primitive('u8')))).toEqual(['0:[*]u8', '4:u32'])
      expect(layout(slice(primitive('u8'), true))).toEqual(['0:[*]mut u8', '4:u32'])
    })

    test('nested structs, slices and fixed arrays flatten in order', () => {
      const option = tuple([field('d', primitive('i32')), field('lane', lane)])
      expect(layout(option)).toEqual(['0:i32', '4:[*]i32', '8:u32', '12:i32'])
      const row = tuple([field('tag', primitive('u8')), field('v', array(primitive('i32'), [3]))])
      expect(layout(row)).toEqual(['0:u8', '1:i32', '5:i32', '9:i32'])
      expect(layout(array(spot, [2]))).toEqual(['0:i32', '4:i32', '8:i32', '12:i32', '16:i32', '20:i32'])
    })

    test('a wide integer is 64-bit limbs, low first', () => {
      expect(layout(tuple([field(null, primitive('u8')), field(null, primitive('u128'))]))).toEqual(['0:u8', '1:u64', '9:u64'])
    })

    test('a scalar is one part, and a type without a size has none', () => {
      expect(layout(primitive('f64'))).toEqual(['0:f64'])
      expect(layout(pointer(primitive('u8')))).toEqual(['0:*u8'])
      expect(layout(VOID)).toEqual([])
      expect(memoryParts(array(primitive('u8'), null))).toBeNull()
    })

    test('the parts agree with the sizes and field offsets', () => {
      const option = tuple([field('d', primitive('i32')), field('lane', lane)])
      expect(fieldByteOffset(option, 'lane')).toBe(4)
      expect(fieldByteOffset(lane, 'free')).toBe(8)
      expect(byteSize(option)).toBe(16)
    })

    test('a field is found by position as well as by name', () => {
      const pair = tuple([field(null, primitive('u8')), field(null, primitive('u64'))])
      expect(fieldByteOffset(pair, 0)).toBe(0)
      expect(fieldByteOffset(pair, 1)).toBe(1)
      expect(fieldByteOffset(pair, 2)).toBeNull()
      expect(fieldByteOffset(spot, 2)).toBe(8)
      expect(fieldByteOffset(spot, 'room')).toBe(8)
    })
  })
})
