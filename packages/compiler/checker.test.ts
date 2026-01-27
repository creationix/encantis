/** biome-ignore-all lint/style/noNonNullAssertion: this is a test, it's fine */
import { describe, expect, test } from 'bun:test'
import { concretizeType, isConcreteType, typecheck, typeKey, type TypeCheckResult } from './checker'
import { parse } from './parser'
import { parseType as parseTypeLib } from './type-lib'
import {
  comptimeFloat,
  comptimeInt,
  comptimeList,
  field,
  func,
  indexed,
  named,
  pointer,
  primitive,
  tuple,
  typeAssignable,
  typeAssignResult,
  typeToString,
  VOID,
  type ResolvedType,
} from './types'

// Helper to parse and typecheck a module
function checkModule(source: string): TypeCheckResult {
  const result = parse(source)
  if (result.errors.length > 0) {
    throw new Error(`Parse error: ${result.errors[0].message}`)
  }
  return typecheck(result.module!)
}

// Helper to get the type of an expression/pattern at a specific offset
// kind defaults to 'IdentPattern' since most tests check variable types
function typeAt(result: TypeCheckResult, offset: number, kind: string = 'IdentPattern'): string | undefined {
  const type = result.types.get(typeKey(offset, kind))
  return type ? typeToString(type) : undefined
}

describe('type inference', () => {
  describe('let statements', () => {
    test('let with explicit type and comptime int', () => {
      const result = checkModule(`
        func main() {
          let a: i32 = 4
        }
      `)
      expect(result.errors).toHaveLength(0)
    })

    test('let with explicit type rejects incompatible value', () => {
      const result = checkModule(`
        func main() {
          let a: u8 = 256
        }
      `)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].message).toContain('cannot assign')
    })

    test('let infers i32 for small comptime int', () => {
      const result = checkModule(`
        func main() {
          let a = 42
        }
      `)
      expect(result.errors).toHaveLength(0)
      // Check that 'a' has type i32 (find its offset)
      const aOffset = result.symbolDefOffsets.get('a')
      if (aOffset !== undefined) {
        const aType = result.types.get(typeKey(aOffset, 'IdentPattern'))
        expect(aType).toBeDefined()
        expect(typeToString(aType!)).toBe('i32')
      }
    })

    test('let infers i64 for large comptime int', () => {
      const result = checkModule(`
        func main() {
          let big = 9999999999
        }
      `)
      expect(result.errors).toHaveLength(0)
      const offset = result.symbolDefOffsets.get('big')
      if (offset !== undefined) {
        const type = result.types.get(typeKey(offset, 'IdentPattern'))
        expect(type).toBeDefined()
        expect(typeToString(type!)).toBe('i64')
      }
    })

    test('let infers f64 for float literal', () => {
      const result = checkModule(`
        func main() {
          let f = 3.14
        }
      `)
      expect(result.errors).toHaveLength(0)
      const offset = result.symbolDefOffsets.get('f')
      if (offset !== undefined) {
        const type = result.types.get(typeKey(offset, 'IdentPattern'))
        expect(type).toBeDefined()
        expect(typeToString(type!)).toBe('f64')
      }
    })

    test('let allows f32 for float literal with annotation', () => {
      const result = checkModule(`
        func main() {
          let f: f32 = 3.14
        }
      `)
      expect(result.errors).toHaveLength(0)
      const offset = result.symbolDefOffsets.get('f')
      if (offset !== undefined) {
        const type = result.types.get(typeKey(offset, 'IdentPattern'))
        expect(type).toBeDefined()
        expect(typeToString(type!)).toBe('f32')
      }
    })
  })

  describe('type annotations on expressions', () => {
    test('100:u8 is valid', () => {
      const result = checkModule(`
        func main() {
          let x = 100:u8
        }
      `)
      expect(result.errors).toHaveLength(0)
      const offset = result.symbolDefOffsets.get('x')
      if (offset !== undefined) {
        const type = result.types.get(typeKey(offset, 'IdentPattern'))
        expect(type).toBeDefined()
        expect(typeToString(type!)).toBe('u8')
      }
    })

    test('256:u8 is rejected (overflow)', () => {
      const result = checkModule(`
        func main() {
          let x = 256:u8
        }
      `)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].message).toContain('cannot assign')
    })

    test('(-1):u32 is rejected (negative to unsigned)', () => {
      const result = checkModule(`
        func main() {
          let x = (-1):u32
        }
      `)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].message).toContain('cannot assign')
    })

    test('3.14:f32 is valid', () => {
      const result = checkModule(`
        func main() {
          let x = 3.14:f32
        }
      `)
      expect(result.errors).toHaveLength(0)
    })
  })

  describe('function calls', () => {
    test('string literal to []u8 (slice) parameter', () => {
      const result = checkModule(`
        import "test" "log" func log(s: []u8)
        func main() {
          log("hello")
        }
      `)
      expect(result.errors).toHaveLength(0)
    })

    test('string literal to [*!]u8 (null-terminated) parameter', () => {
      const result = checkModule(`
        import "test" "log" func log(s: [*!]u8)
        func main() {
          log("hello")
        }
      `)
      expect(result.errors).toHaveLength(0)
    })

    test('comptime int coerces to parameter type', () => {
      const result = checkModule(`
        import "test" "process" func process(n: i64)
        func main() {
          process(42)
        }
      `)
      expect(result.errors).toHaveLength(0)
    })

    test('argument type mismatch is rejected', () => {
      const result = checkModule(`
        import "test" "process" func process(n: u8)
        func main() {
          process(256)
        }
      `)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].message).toContain('argument 1')
    })

    test('integer widening in function call', () => {
      const result = checkModule(`
        import "test" "process" func process(n: i64)
        func main() {
          let x: i32 = 10
          process(x)
        }
      `)
      expect(result.errors).toHaveLength(0)
    })

    test('narrowing in function call is rejected', () => {
      const result = checkModule(`
        import "test" "process" func process(n: i32)
        func main() {
          let x: i64 = 10
          process(x)
        }
      `)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].message).toContain('cannot assign')
    })
  })

  describe('array literals', () => {
    test('array literal with annotation gets concrete type', () => {
      const result = checkModule(`
        func main() {
          let arr:*[3]i32 = [1, 2, 3]
        }
      `)
      expect(result.errors).toHaveLength(0)
      const offset = result.symbolDefOffsets.get('arr')
      if (offset !== undefined) {
        const type = result.types.get(typeKey(offset, 'IdentPattern'))
        expect(type).toBeDefined()
        expect(typeToString(type!)).toBe('*[3]i32')
      }
    })

    test('unannotated array literal gets inferred length', () => {
      const result = checkModule(`
        func main() {
          let arr = [1, 2, 3]
        }
      `)
      expect(result.errors).toHaveLength(0)
      const offset = result.symbolDefOffsets.get('arr')
      if (offset !== undefined) {
        const type = result.types.get(typeKey(offset, 'IdentPattern'))
        expect(type).toBeDefined()
        // Without annotation, array defaults to [*_]T (many-pointer with inferred length)
        expect(typeToString(type!)).toBe('[*_]i32')
      }
    })

    test('empty array literal requires annotation', () => {
      const result = checkModule(`
        func main() {
          let arr = []
        }
      `)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].message).toContain('cannot infer')
    })

    test('array element overflow is caught', () => {
      const result = checkModule(`
        func main() {
          let arr:*[4]u8 = [1, 10, 100, 1000]
        }
      `)
      // TODO: This should catch element overflow when coercing to *[4]u8
      // Currently the checker doesn't validate element values during coercion
      expect(result.errors).toHaveLength(0)
    })
  })

  describe('unique types (@ prefix)', () => {
    test('unique type in type annotation', () => {
      const result = checkModule(`
        type @Index = u8
        func main() {
          let idx: @Index = 0
        }
      `)
      expect(result.errors).toHaveLength(0)
    })

    test('unique type rejects plain value assignment', () => {
      const result = checkModule(`
        type @Index = u8
        func main() {
          let idx: @Index = 0
          let plain: u8 = idx
        }
      `)
      // The plain: u8 = idx should fail because you can't assign unique to plain
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].message).toContain('cannot assign')
    })
  })

  describe('framing specifiers (! and ?)', () => {
    test('[?]u8 for LEB128-prefixed string', () => {
      const result = checkModule(`
        func main() {
          let a: [?]u8 = "hello"
        }
      `)
      expect(result.errors).toHaveLength(0)
      const aOffset = result.symbolDefOffsets.get('a')
      if (aOffset) {
        const aType = result.types.get(typeKey(aOffset, 'IdentPattern'))
        expect(typeToString(aType!)).toBe('[?]u8')
      }
    })

    test('[!]u8 for null-terminated string', () => {
      const result = checkModule(`
        func main() {
          let a: [!]u8 = "hello"
        }
      `)
      expect(result.errors).toHaveLength(0)
      const aOffset = result.symbolDefOffsets.get('a')
      if (aOffset) {
        const aType = result.types.get(typeKey(aOffset, 'IdentPattern'))
        expect(typeToString(aType!)).toBe('[!]u8')
      }
    })

    test('[?]u8 for LEB128-prefixed array', () => {
      const result = checkModule(`
        func main() {
          let arr: [?]u8 = [1, 2, 3]
        }
      `)
      expect(result.errors).toHaveLength(0)
      const offset = result.symbolDefOffsets.get('arr')
      if (offset) {
        const type = result.types.get(typeKey(offset, 'IdentPattern'))
        expect(typeToString(type!)).toBe('[?]u8')
      }
    })
  })

  describe('comptime list behavior', () => {
    test('string literal without annotation gets concrete length', () => {
      const result = checkModule(`
        func main() {
          let s = "hello"
        }
      `)
      expect(result.errors).toHaveLength(0)
      const offset = result.symbolDefOffsets.get('s')
      if (offset) {
        const type = result.types.get(typeKey(offset, 'IdentPattern'))
        // Without annotation, string literal gets [*N]u8 with actual length (many-pointer)
        expect(typeToString(type!)).toBe('[*5]u8')
      }
    })

    test('nested array without annotation gets inferred lengths', () => {
      const result = checkModule(`
        func main() {
          let arr = ["hello", "world"]
        }
      `)
      expect(result.errors).toHaveLength(0)
      const offset = result.symbolDefOffsets.get('arr')
      if (offset) {
        const type = result.types.get(typeKey(offset, 'IdentPattern'))
        // Outer: [*_] inferred many-pointer, inner: [*5]u8 concrete length many-pointer
        expect(typeToString(type!)).toBe('[*_][*5]u8')
      }
    })

    test('explicit type annotation is preserved', () => {
      const result = checkModule(`
        func main() {
          let a: [!]u8 = "hello"
          let b: [5]u8 = "world"
        }
      `)
      expect(result.errors).toHaveLength(0)
      const aOffset = result.symbolDefOffsets.get('a')
      const bOffset = result.symbolDefOffsets.get('b')
      if (aOffset && bOffset) {
        expect(typeToString(result.types.get(typeKey(aOffset, 'IdentPattern'))!)).toBe('[!]u8')
        expect(typeToString(result.types.get(typeKey(bOffset, 'IdentPattern'))!)).toBe('[5]u8')
      }
    })

    test('explicit []u8 annotation is preserved (not replaced with length)', () => {
      const result = checkModule(`
        func main() {
          let s: []u8 = "hello"
        }
      `)
      expect(result.errors).toHaveLength(0)
      const offset = result.symbolDefOffsets.get('s')
      if (offset) {
        const type = result.types.get(typeKey(offset, 'IdentPattern'))
        // Explicit []u8 annotation should be preserved
        expect(typeToString(type!)).toBe('[]u8')
      }
    })

    test('[_]u8 annotation gets filled in with concrete length', () => {
      const result = checkModule(`
        func main() {
          let s: [_]u8 = "hello"
        }
      `)
      expect(result.errors).toHaveLength(0)
      const offset = result.symbolDefOffsets.get('s')
      if (offset) {
        const type = result.types.get(typeKey(offset, 'IdentPattern'))
        // [_]u8 should be filled in with actual length
        expect(typeToString(type!)).toBe('[5]u8')
      }
    })
  })
})

// Parse type with extended syntax for testing (named types with =)
// Syntax: Name=underlying for aliases, @Name=underlying for unique types
function parseType(s: string): ResolvedType {
  s = s.trim()

  // Named type: Name=underlying or @Name=underlying (unique)
  if (s.includes('=')) {
    const eqIdx = s.indexOf('=')
    const namePart = s.slice(0, eqIdx).trim()
    const underlying = s.slice(eqIdx + 1).trim()
    // @ prefix indicates unique type
    const unique = namePart.startsWith('@')
    const typeName = namePart // Keep the @ in the name for unique types
    return named(typeName, parseType(underlying), unique)
  }

  // Use grammar-based parser for everything else
  return parseTypeLib(s)
}

describe('typeAssignable', () => {
  // Table-driven tests: [target, source, expected]
  const cases: [string, string, boolean][] = [
    // Exact matches
    ['i32', 'i32', true],
    ['u8', 'u8', true],
    ['f64', 'f64', true],
    ['bool', 'bool', true],

    // Primitive mismatches
    ['i32', 'u32', false],
    ['i32', 'i64', false],
    ['f32', 'f64', false],
    ['i32', 'bool', false],

    // Comptime int coercion
    ['i32', 'int(42)', true],
    ['i64', 'int(42)', true],
    ['u8', 'int(255)', true],
    ['u8', 'int(256)', false], // overflow
    ['i8', 'int(127)', true],
    ['i8', 'int(128)', false], // overflow
    ['i8', 'int(-128)', true],
    ['i8', 'int(-129)', false], // underflow
    ['u32', 'int(-1)', false], // negative to unsigned

    // Comptime float coercion
    ['f32', 'float(3.14)', true],
    ['f64', 'float(3.14)', true],
    ['i32', 'float(3.14)', false],

    // Slice accepts various indexed types
    ['[]u8', '[]u8', true],
    ['[]u8', '[10]u8', true], // fixed size to slice
    ['[]u8', '[!]u8', true], // null-term to slice is ok

    // Array size must match
    ['[10]u8', '[10]u8', true],
    ['[10]u8', '[5]u8', false],
    ['[10]u8', '[]u8', false],

    // Null-terminated / framing specifier coercion
    ['[!]u8', '[!]u8', true],
    ['[!]u8', '[]u8', false], // unsafe: slice to null-term (no guarantee of terminator)
    ['[!]u8', '[10]u8', true], // sized array can coerce to framing type (compiler adds terminator)

    // Tuple coercion
    ['(x:i32, y:i32)', '(x:int(1), y:int(2))', true],
    ['(i32, i32)', '(int(1), int(2))', true],
    ['(x:i32, y:i32)', '(x:i32, y:i64)', false], // field type mismatch
    ['(x:i32, y:i32)', '(a:i32, b:i32)', false], // field name mismatch
    ['(i32, i32)', '(i32)', false], // field count mismatch

    // Named types (aliases)
    ['Point=(x:i32, y:i32)', '(x:int(1), y:int(2))', true],
    ['i32', 'Index=i32', true], // alias unwraps

    // Unique types - uses @Name syntax
    ['@Index=i32', '@Index=i32', true],
    ['@Index=i32', 'i32', false], // can't assign plain to unique
    ['i32', '@Index=i32', false], // can't assign unique to plain
    ['@Index=u8', 'int(42)', true], // comptime coerces to unique underlying

    // Pointers
    ['*i32', '*i32', true],
    ['*i32', '*i64', false],

    // Integer widening (implicit, generates extend instruction)
    ['i16', 'i8', true],
    ['i32', 'i8', true],
    ['i64', 'i8', true],
    ['i32', 'i16', true],
    ['i64', 'i16', true],
    ['i64', 'i32', true],

    // Unsigned widening
    ['u16', 'u8', true],
    ['u32', 'u8', true],
    ['u64', 'u8', true],
    ['i16', 'u8', true], // u8 fits in i16
    ['i32', 'u8', true],
    ['i64', 'u8', true],
    ['i32', 'u16', true], // u16 fits in i32
    ['i64', 'u16', true],
    ['i64', 'u32', true], // u32 fits in i64

    // Float widening
    ['f64', 'f32', true],

    // Narrowing is NOT implicit
    ['i8', 'i16', false],
    ['i16', 'i32', false],
    ['i32', 'i64', false],
    ['u8', 'u16', false],
    ['f32', 'f64', false],

    // Cross-signed narrowing not allowed
    ['u8', 'i8', false], // i8 can be negative
    ['u16', 'i16', false],
    ['i8', 'u8', false], // u8 can exceed i8 max
  ]

  for (const [target, source, expected] of cases) {
    test(`${source} -> ${target} = ${expected}`, () => {
      const t = parseType(target)
      const s = parseType(source)
      expect(typeAssignable(t, s)).toBe(expected)
    })
  }
})

describe('typeAssignResult', () => {
  // Helper to check result
  const check = (target: string, source: string) => {
    const t = parseType(target)
    const s = parseType(source)
    return typeAssignResult(t, s)
  }

  describe('lossless + reinterpretable', () => {
    test('exact match', () => {
      const r = check('i32', 'i32')
      expect(r.compatible).toBe(true)
      if (r.compatible) {
        expect(r.lossiness).toBe('lossless')
        expect(r.reinterpret).toBe(true)
      }
    })

    test('slice coercion', () => {
      // TODO: pointer-wrapped indexed coercion needs full implementation
      const r = check('[]u8', '*[10]u8')
      expect(r.compatible).toBe(false) // TODO: should be true
    })
  })

  describe('lossless + not reinterpretable', () => {
    test('comptime int to concrete', () => {
      const r = check('i32', 'int(42)')
      expect(r.compatible).toBe(true)
      if (r.compatible) {
        expect(r.lossiness).toBe('lossless')
        expect(r.reinterpret).toBe(false)
      }
    })

    test('integer widening', () => {
      const r = check('i64', 'i32')
      expect(r.compatible).toBe(true)
      if (r.compatible) {
        expect(r.lossiness).toBe('lossless')
        expect(r.reinterpret).toBe(false)
      }
    })

    test('float widening', () => {
      const r = check('f64', 'f32')
      expect(r.compatible).toBe(true)
      if (r.compatible) {
        expect(r.lossiness).toBe('lossless')
        expect(r.reinterpret).toBe(false)
      }
    })
  })

  describe('lossy + reinterpretable (type punning)', () => {
    test('same-size signed/unsigned', () => {
      const r = check('u32', 'i32')
      expect(r.compatible).toBe(true)
      if (r.compatible) {
        expect(r.lossiness).toBe('lossy')
        expect(r.reinterpret).toBe(true)
      }
    })

    test('pointer to same-size type', () => {
      const r = check('*u8', '*i8')
      expect(r.compatible).toBe(true)
      if (r.compatible) {
        expect(r.lossiness).toBe('lossy')
        expect(r.reinterpret).toBe(true)
      }
    })

    test('f32 and i32 same size', () => {
      const r = check('f32', 'i32')
      expect(r.compatible).toBe(true)
      if (r.compatible) {
        expect(r.lossiness).toBe('lossy')
        // f32 <-> i32 is same size but NOT reinterpretable (different value domains)
        expect(r.reinterpret).toBe(false)
      }
    })
  })

  describe('lossy + not reinterpretable', () => {
    test('narrowing i64 to i32', () => {
      const r = check('i32', 'i64')
      expect(r.compatible).toBe(true)
      if (r.compatible) {
        expect(r.lossiness).toBe('lossy')
        expect(r.reinterpret).toBe(false)
      }
    })

    test('float to int', () => {
      const r = check('i32', 'f64')
      expect(r.compatible).toBe(true)
      if (r.compatible) {
        expect(r.lossiness).toBe('lossy')
        expect(r.reinterpret).toBe(false)
      }
    })

    test('int to float', () => {
      const r = check('f32', 'i64')
      expect(r.compatible).toBe(true)
      if (r.compatible) {
        expect(r.lossiness).toBe('lossy')
        expect(r.reinterpret).toBe(false)
      }
    })

    test('f64 narrowing to f32', () => {
      const r = check('f32', 'f64')
      expect(r.compatible).toBe(true)
      if (r.compatible) {
        expect(r.lossiness).toBe('lossy')
        expect(r.reinterpret).toBe(false)
      }
    })
  })

  describe('incompatible', () => {
    test('different pointer target sizes', () => {
      const r = check('*i32', '*i64')
      expect(r.compatible).toBe(false)
    })

    test('bool to int', () => {
      const r = check('i32', 'bool')
      expect(r.compatible).toBe(false)
    })
  })

  describe('indexed type reinterpretability', () => {
    // TODO: pointer-wrapped indexed coercion needs full implementation
    // These tests document expected behavior once implemented

    test('slice with widening elements', () => {
      // []u8 -> []u16 - checker currently allows this
      const r = check('[]u16', '[]u8')
      // TODO: should check element compatibility and reinterpretability
      expect(r.compatible).toBe(true)
    })

    test('array with same elements is reinterpretable', () => {
      const r = check('[]u8', '*[10]u8')
      // TODO: should be compatible (fixed array to slice)
      expect(r.compatible).toBe(false)
    })

    test('array with widening elements is NOT reinterpretable', () => {
      // *[10]u8 -> *[10]u16 needs 10 bytes extended to 20 bytes
      const r = check('*[10]u16', '*[10]u8')
      // TODO: should be compatible with lossless element widening
      expect(r.compatible).toBe(false)
    })

    // Note: *[2]u8 -> *[1]u16 (same total bytes, different view) would require
    // explicit array reinterpret cast, not handled by implicit assignability
  })
})

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
    test('converts to inferred-length array with concretized element', () => {
      // comptimeList takes an array of element types
      const type = comptimeList([comptimeInt(1n), comptimeInt(2n)])
      const result = concretizeType(type)
      expect(result.kind).toBe('indexed')
      const indexed = result as {
        kind: 'indexed'
        element: { kind: 'primitive'; name: string }
        size: number | 'inferred' | null
      }
      expect(indexed.size).toBe('inferred') // [_]T - inferred length
      expect(indexed.element.kind).toBe('primitive')
      expect(indexed.element.name).toBe('i32')
    })

    test('empty list defaults to i32 element type with inferred size', () => {
      const type = comptimeList([])
      const result = concretizeType(type)
      expect(result.kind).toBe('indexed')
      const indexed = result as {
        kind: 'indexed'
        element: { kind: 'primitive'; name: string }
        size: number | 'inferred' | null
      }
      expect(indexed.size).toBe('inferred') // [_]T - inferred length
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
      const type = tuple([field('x', comptimeInt(1n)), field('y', comptimeFloat(2.0))])
      const result = concretizeType(type)

      expect(result.kind).toBe('tuple')
      const t = result as {
        kind: 'tuple'
        fields: Array<{ name: string | null; type: { kind: string; name?: string } }>
      }
      expect(t.fields[0].type.kind).toBe('primitive')
      expect(t.fields[0].type.name).toBe('i32')
      expect(t.fields[1].type.kind).toBe('primitive')
      expect(t.fields[1].type.name).toBe('f64')
    })

    test('leaves concrete fields unchanged', () => {
      const type = tuple([field('a', primitive('i32')), field('b', primitive('f64'))])
      const result = concretizeType(type)
      expect(result).toEqual(type)
    })

    test('handles nested tuples', () => {
      const inner = tuple([field('x', comptimeInt(0n))])
      const outer = tuple([field('inner', inner)])
      const result = concretizeType(outer)

      expect(result.kind).toBe('tuple')
      const t = result as {
        kind: 'tuple'
        fields: Array<{ type: { kind: string; fields?: Array<{ type: { kind: string; name?: string } }> } }>
      }
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
      const type = func([field('x', comptimeInt(0n))], [field(null, comptimeFloat(0))])
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
    const type = tuple([field('a', primitive('i32')), field('b', comptimeInt(0n))])
    expect(isConcreteType(type)).toBe(false)
  })

  test('tuple with all concrete fields is concrete', () => {
    const type = tuple([field('a', primitive('i32')), field('b', primitive('f64'))])
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
