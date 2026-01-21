import { describe, expect, test } from 'bun:test'
import { parseType, parseTypeAST, astToResolved } from '../type-lib'
import { typeToString } from '../types'

describe('parseType', () => {
  describe('primitive types', () => {
    test('integer types', () => {
      expect(parseType('i8')).toMatchObject({ kind: 'primitive', name: 'i8' })
      expect(parseType('i16')).toMatchObject({ kind: 'primitive', name: 'i16' })
      expect(parseType('i32')).toMatchObject({ kind: 'primitive', name: 'i32' })
      expect(parseType('i64')).toMatchObject({ kind: 'primitive', name: 'i64' })
      expect(parseType('u8')).toMatchObject({ kind: 'primitive', name: 'u8' })
      expect(parseType('u16')).toMatchObject({ kind: 'primitive', name: 'u16' })
      expect(parseType('u32')).toMatchObject({ kind: 'primitive', name: 'u32' })
      expect(parseType('u64')).toMatchObject({ kind: 'primitive', name: 'u64' })
    })

    test('float types', () => {
      expect(parseType('f32')).toMatchObject({ kind: 'primitive', name: 'f32' })
      expect(parseType('f64')).toMatchObject({ kind: 'primitive', name: 'f64' })
    })

    test('bool type', () => {
      expect(parseType('bool')).toMatchObject({ kind: 'primitive', name: 'bool' })
    })
  })

  describe('pointer types', () => {
    test('pointer to primitive', () => {
      const t = parseType('*i32')
      expect(t.kind).toBe('pointer')
      if (t.kind === 'pointer') {
        expect(t.pointee).toMatchObject({ kind: 'primitive', name: 'i32' })
      }
    })

    test('pointer to pointer', () => {
      const t = parseType('**u8')
      expect(t.kind).toBe('pointer')
      if (t.kind === 'pointer') {
        expect(t.pointee.kind).toBe('pointer')
      }
    })
  })

  describe('indexed types', () => {
    test('comptime indexed [T]', () => {
      const t = parseType('[u8]')
      expect(t.kind).toBe('indexed')
      if (t.kind === 'indexed') {
        expect(t.size).toBe('comptime')
        expect(t.specifiers).toHaveLength(0)
        expect(t.element).toMatchObject({ kind: 'primitive', name: 'u8' })
      }
    })

    test('fixed-size array', () => {
      const t = parseType('*[10;u8]')
      expect(t.kind).toBe('pointer')
      if (t.kind === 'pointer' && t.pointee.kind === 'indexed') {
        expect(t.pointee.size).toBe(10)
        expect(t.pointee.element).toMatchObject({ kind: 'primitive', name: 'u8' })
      }
    })

    test('null-terminated (!)', () => {
      const t = parseType('*[!u8]')
      expect(t.kind).toBe('pointer')
      if (t.kind === 'pointer' && t.pointee.kind === 'indexed') {
        expect(t.pointee.specifiers).toHaveLength(1)
        expect(t.pointee.specifiers[0]).toMatchObject({ kind: 'null' })
      }
    })

    test('LEB128-prefixed (?)', () => {
      const t = parseType('*[?u8]')
      expect(t.kind).toBe('pointer')
      if (t.kind === 'pointer' && t.pointee.kind === 'indexed') {
        expect(t.pointee.specifiers).toHaveLength(1)
        expect(t.pointee.specifiers[0]).toMatchObject({ kind: 'prefix', prefixType: 'leb128' })
      }
    })

    test('nested indexed', () => {
      const t = parseType('*[*[u8]]')
      expect(t.kind).toBe('pointer')
      if (t.kind === 'pointer' && t.pointee.kind === 'indexed') {
        expect(t.pointee.element.kind).toBe('pointer')
      }
    })
  })

  describe('tuple types', () => {
    test('empty tuple / void', () => {
      const t = parseType('()')
      expect(t.kind).toBe('tuple')
      if (t.kind === 'tuple') {
        expect(t.fields).toHaveLength(0)
      }
    })

    test('unnamed tuple', () => {
      const t = parseType('(i32, f64)')
      expect(t.kind).toBe('tuple')
      if (t.kind === 'tuple') {
        expect(t.fields).toHaveLength(2)
        expect(t.fields[0].name).toBeNull()
        expect(t.fields[0].type).toMatchObject({ kind: 'primitive', name: 'i32' })
        expect(t.fields[1].type).toMatchObject({ kind: 'primitive', name: 'f64' })
      }
    })

    test('named tuple / struct', () => {
      const t = parseType('(x: i32, y: f64)')
      expect(t.kind).toBe('tuple')
      if (t.kind === 'tuple') {
        expect(t.fields).toHaveLength(2)
        expect(t.fields[0].name).toBe('x')
        expect(t.fields[1].name).toBe('y')
      }
    })

    test('single element tuple', () => {
      const t = parseType('(i32)')
      expect(t.kind).toBe('tuple')
      if (t.kind === 'tuple') {
        expect(t.fields).toHaveLength(1)
      }
    })
  })

  describe('unique types (@ prefix)', () => {
    test('unique type reference parses as TypeRef', () => {
      // @UserId is a reference to a unique type - underlying type resolved at check time
      const ast = parseTypeAST('@UserId')
      expect(ast.kind).toBe('TypeRef')
      if (ast.kind === 'TypeRef') {
        expect(ast.name).toBe('@UserId')
      }
    })

    test('pointer to unique type', () => {
      const ast = parseTypeAST('*@String')
      expect(ast.kind).toBe('PointerType')
      if (ast.kind === 'PointerType') {
        expect(ast.pointee.kind).toBe('TypeRef')
        if (ast.pointee.kind === 'TypeRef') {
          expect(ast.pointee.name).toBe('@String')
        }
      }
    })
  })

  describe('comptime types', () => {
    test('comptime int', () => {
      const t = parseType('int(42)')
      expect(t.kind).toBe('comptime_int')
      if (t.kind === 'comptime_int') {
        expect(t.value).toBe(42n)
      }
    })

    test('comptime int negative', () => {
      const t = parseType('int(-100)')
      expect(t.kind).toBe('comptime_int')
      if (t.kind === 'comptime_int') {
        expect(t.value).toBe(-100n)
      }
    })

    test('comptime float', () => {
      const t = parseType('float(3.14)')
      expect(t.kind).toBe('comptime_float')
      if (t.kind === 'comptime_float') {
        expect(t.value).toBeCloseTo(3.14)
      }
    })
  })

  describe('round-trip', () => {
    test('primitive round-trips', () => {
      for (const name of ['i8', 'i16', 'i32', 'i64', 'u8', 'u16', 'u32', 'u64', 'f32', 'f64', 'bool']) {
        const t = parseType(name)
        expect(typeToString(t)).toBe(name)
      }
    })

    test('pointer round-trips', () => {
      const t = parseType('*i32')
      expect(typeToString(t)).toBe('*i32')
    })

    test('tuple round-trips', () => {
      const t = parseType('(i32, f64)')
      expect(typeToString(t)).toBe('(i32, f64)')
    })
  })
})

describe('parseTypeAST', () => {
  test('returns AST node', () => {
    const ast = parseTypeAST('i32')
    expect(ast.kind).toBe('PrimitiveType')
  })

  test('throws on invalid syntax', () => {
    expect(() => parseTypeAST('not a type!!!')).toThrow()
  })
})

describe('astToResolved', () => {
  test('throws on TypeRef without context', () => {
    const ast = parseTypeAST('MyType')
    expect(() => astToResolved(ast)).toThrow("TypeRef 'MyType' cannot be resolved without context")
  })
})
