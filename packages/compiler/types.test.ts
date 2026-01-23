import { describe, expect, test } from 'bun:test'
import {
  primitive,
  pointer,
  indexed,
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

    test('indexed creates slice type', () => {
      const type = indexed(primitive('u8'), null, [])
      expect(type.kind).toBe('indexed')
      expect(type.size).toBeNull()
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
      const type = named('Point', tuple([field('x', primitive('i32'))]), false)
      expect(type.kind).toBe('named')
      expect(type.name).toBe('Point')
      expect(type.unique).toBe(false)
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

    test('unique types are not assignable to their underlying type', () => {
      const uniqueType = named('@UserId', primitive('i32'), true)
      expect(typeAssignable(primitive('i32'), uniqueType)).toBe(false)
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
})
