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
  array,
  slice,
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

    test('string literal to []u8 (slice) parameter', () => {
      const result = checkModule(`
        import "test" "log" func log(s: []u8)
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
        // Without annotation, array literal concretizes to value array [N]T
        expect(typeToString(type!)).toBe('[3]i32')
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
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].message).toContain('cannot assign')
    })
  })

  describe('framing specifiers (! and ?)', () => {
    // TODO: These tests need semantic work - string literals are [*N]u8 (many-pointers)
    // and can't directly coerce to *[?]u8 or *[!]u8 (pointers to framed arrays)
    test.skip('*[?]u8 for LEB128-prefixed string', () => {
      const result = checkModule(`
        func main() {
          let a: *[?]u8 = "hello"
        }
      `)
      expect(result.errors).toHaveLength(0)
      const aOffset = result.symbolDefOffsets.get('a')
      if (aOffset) {
        const aType = result.types.get(typeKey(aOffset, 'IdentPattern'))
        expect(typeToString(aType!)).toBe('*[?]u8')
      }
    })

    test.skip('*[!]u8 for null-terminated string', () => {
      const result = checkModule(`
        func main() {
          let a: *[!]u8 = "hello"
        }
      `)
      expect(result.errors).toHaveLength(0)
      const aOffset = result.symbolDefOffsets.get('a')
      if (aOffset) {
        const aType = result.types.get(typeKey(aOffset, 'IdentPattern'))
        expect(typeToString(aType!)).toBe('*[!]u8')
      }
    })

    test.skip('*[?]u8 for LEB128-prefixed array', () => {
      const result = checkModule(`
        func main() {
          let arr: *[?]u8 = [1, 2, 3]
        }
      `)
      expect(result.errors).toHaveLength(0)
      const offset = result.symbolDefOffsets.get('arr')
      if (offset) {
        const type = result.types.get(typeKey(offset, 'IdentPattern'))
        expect(typeToString(type!)).toBe('*[?]u8')
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
        // Without annotation, string literal gets *[N]u8 (pointer to N-byte array)
        expect(typeToString(type!)).toBe('*[5]u8')
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
        // Outer: comptime_array of 2 elements, inner: *[5]u8 pointer to 5-byte string
        expect(typeToString(type!)).toBe('[2]*[5]u8')
      }
    })

    // TODO: String literal coercion to *[!]u8 and *[5]u8 needs semantic work
    test.skip('explicit type annotation is preserved', () => {
      const result = checkModule(`
        func main() {
          let a: *[!]u8 = "hello"
          let b: *[5]u8 = "world"
        }
      `)
      expect(result.errors).toHaveLength(0)
      const aOffset = result.symbolDefOffsets.get('a')
      const bOffset = result.symbolDefOffsets.get('b')
      if (aOffset && bOffset) {
        expect(typeToString(result.types.get(typeKey(aOffset, 'IdentPattern'))!)).toBe('*[!]u8')
        expect(typeToString(result.types.get(typeKey(bOffset, 'IdentPattern'))!)).toBe('*[5]u8')
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

    // TODO: String literal coercion to *[_]u8 needs semantic work
    test.skip('*[_]u8 annotation gets filled in with concrete length', () => {
      const result = checkModule(`
        func main() {
          let s: *[_]u8 = "hello"
        }
      `)
      expect(result.errors).toHaveLength(0)
      const offset = result.symbolDefOffsets.get('s')
      if (offset) {
        const type = result.types.get(typeKey(offset, 'IdentPattern'))
        // *[_]u8 should be filled in with actual length
        expect(typeToString(type!)).toBe('*[5]u8')
      }
    })
  })
})

// Parse type with extended syntax for testing (named types with =)
// Syntax: Name=underlying for aliases
function parseType(s: string): ResolvedType {
  s = s.trim()

  // Named type: Name=underlying
  if (s.includes('=')) {
    const eqIdx = s.indexOf('=')
    const typeName = s.slice(0, eqIdx).trim()
    const underlying = s.slice(eqIdx + 1).trim()
    return named(typeName, parseType(underlying))
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

    // Slice compatibility
    ['[]u8', '[]u8', true],
    // TODO: *[N]u8 -> []u8 coercion needs semantic work (pointer-to-array vs slice)
    // ['[]u8', '*[10]u8', true], // fixed size to slice
    // ['[]u8', '*[!]u8', true], // null-term to slice is ok

    // Array size must match
    ['*[10]u8', '*[10]u8', true],
    ['*[10]u8', '*[5]u8', false],
    // ['*[10]u8', '[]u8', false], // TODO: needs semantic work

    // Null-terminated / framing specifier coercion
    ['*[!]u8', '*[!]u8', true],
    // ['*[!]u8', '[]u8', false], // TODO: needs semantic work
    // ['*[!]u8', '*[10]u8', true], // TODO: sized array can coerce to framing type

    // Tuple coercion
    ['(x:i32, y:i32)', '(x:int(1), y:int(2))', true],
    ['(i32, i32)', '(int(1), int(2))', true],
    ['(x:i32, y:i32)', '(x:i32, y:i64)', false], // field type mismatch
    ['(x:i32, y:i32)', '(a:i32, b:i32)', false], // field name mismatch
    ['(i32, i32)', '(i32)', false], // field count mismatch

    // Named types (aliases)
    ['Point=(x:i32, y:i32)', '(x:int(1), y:int(2))', true],
    ['i32', 'Index=i32', true], // alias unwraps

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

    // Integer to float: only when the mantissa holds every value
    ['f32', 'i8', true],
    ['f32', 'u16', true],
    ['f32', 'i32', false], // 24-bit mantissa
    ['f64', 'i32', true],
    ['f64', 'u32', true],
    ['f64', 'i64', false], // 53-bit mantissa
    ['f64', 'u64', false],
    ['i32', 'f32', false], // never the other way
    ['f32', 'int(16777216)', true],
    ['f32', 'int(16777217)', false],
    ['f64', 'int(9007199254740992)', true],
    ['f64', 'int(9007199254740993)', false],

    // A constant integer is an address, not a slice
    ['*u8', 'int(0)', true],
    ['[]u8', 'int(0)', false],

    // A pointer becomes a slice by itself only when it knows its length
    ['[]u8', '*[10]u8', true],
    ['[]u8', '[*]u8', false],
    ['[]u8', '*[!]u8', false],

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
      // Slice to pointer-to-array coercion is now supported
      const r = check('[]u8', '*[10]u8')
      expect(r.compatible).toBe(true)
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

    test('a slice is a view: its elements have to be laid out the same', () => {
      // A u8 widens to a u16, but a []u8 read as []u16 would take two bytes
      // for each element, and run past the end.
      expect(check('[]u16', '[]u8').compatible).toBe(false)
      expect(check('[]u16', '*[10]u8').compatible).toBe(false)
      expect(check('[*]u16', '*[10]u8').compatible).toBe(false)
      expect(check('[]i64', '[]i32').compatible).toBe(false)
      // The same elements, a narrower range, or less mutability are all fine.
      expect(check('[]u8', '[]u8')).toMatchObject({ compatible: true, reinterpret: true })
      expect(check('[]u8', '[]mut u8').compatible).toBe(true)
      expect(check('[][]u8', '[][]mut u8').compatible).toBe(true)
      expect(check('[*]u8', '*[10]u8').compatible).toBe(true)
    })

    test('array with same elements is reinterpretable', () => {
      const r = check('[]u8', '*[10]u8')
      // Fixed array to slice is now compatible
      expect(r.compatible).toBe(true)
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
    test('converts to pointer to inferred-length array with concretized element', () => {
      // comptimeList takes an array of element types
      const type = comptimeList([comptimeInt(1n), comptimeInt(2n)])
      const result = concretizeType(type)
      expect(result.kind).toBe('pointer')
      const ptr = result as {
        kind: 'pointer'
        pointee: {
          kind: 'array'
          element: { kind: 'primitive'; name: string }
          sizes: Array<number | '_' | '!' | '?'> | null
        }
      }
      expect(ptr.pointee.kind).toBe('array')
      expect(ptr.pointee.sizes).toEqual(['_']) // *[_]T - pointer to inferred length array
      expect(ptr.pointee.element.kind).toBe('primitive')
      expect(ptr.pointee.element.name).toBe('i32')
    })

    test('empty list defaults to i32 element type with inferred size', () => {
      const type = comptimeList([])
      const result = concretizeType(type)
      expect(result.kind).toBe('pointer')
      const ptr = result as {
        kind: 'pointer'
        pointee: {
          kind: 'array'
          element: { kind: 'primitive'; name: string }
          sizes: Array<number | '_' | '!' | '?'> | null
        }
      }
      expect(ptr.pointee.sizes).toEqual(['_']) // *[_]T - pointer to inferred length array
      expect(ptr.pointee.element.name).toBe('i32')
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

  describe('array', () => {
    test('concretizes element type', () => {
      const type = array(comptimeInt(0n), [10])
      const result = concretizeType(type)

      expect(result.kind).toBe('array')
      const a = result as { kind: 'array'; element: { kind: string; name?: string }; sizes: Array<number | '_' | '!' | '?'> | null }
      expect(a.element.kind).toBe('primitive')
      expect(a.element.name).toBe('i32')
      expect(a.sizes).toEqual([10])
    })

    test('leaves concrete array unchanged', () => {
      const type = array(primitive('u8'), [100])
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
    expect(checkResult.exprTypes.size).toBeGreaterThan(0)
    for (const type of [...checkResult.types.values(), ...checkResult.exprTypes.values()]) {
      expect(isConcreteType(type)).toBe(true)
    }
  })

  test('respects custom options', () => {
    const code = `func test() => 42`
    const parseResult = parse(code)
    const checkResult = typecheck(parseResult.module!, { defaultInt: 'i64', defaultFloat: 'f32' })

    // Check that the integer literal was concretized to i64
    let foundI64 = false
    for (const [, type] of checkResult.exprTypes) {
      if (type.kind === 'primitive' && type.name === 'i64') {
        foundI64 = true
        break
      }
    }
    expect(foundI64).toBe(true)
  })
})

describe('globals', () => {
  const errs = (src: string) => checkModule(src).errors.map(e => e.message)

  test('an initializer is a constant the compiler can work out', () => {
    const result = checkModule(`
      def page = 64 * 1024
      data table = [1:u8, 2, 3]
      global size: u32 = 4 * page
      global ratio: f64 = 3 / 2.0
      global count: i64 = table.len
      global wide: f64 = 5:i32
      global mask: u8 = ~0 << 4
      global base: [*]u8 = table
      global name: [*]u8 = "name"
    `)
    expect(result.errors).toEqual([])
    const init = (name: string) => {
      const sym = result.symbols.get(name)
      return sym?.kind === 'global' ? sym.init : undefined
    }
    expect(init('size')).toEqual({ kind: 'int', value: 262144n })
    expect(init('ratio')).toEqual({ kind: 'float', value: 1.5 })
    expect(init('count')).toEqual({ kind: 'int', value: 3n })
    expect(init('mask')).toEqual({ kind: 'int', value: -16n })
  })

  test('an initializer that has to be computed at run time is an error', () => {
    const message = 'global initializer must be a compile-time constant'
    expect(errs(`func one() -> i32 => 1\nglobal g: i32 = one()`)).toEqual([message])
    expect(errs(`global a: i32 = 1\nglobal b: i32 = a`)).toEqual([message])
    expect(errs(`global g: i64 = 5 as i64`)).toEqual([message])
    expect(errs(`global g: u8 = 200 + 100`)).toEqual(['cannot assign int(300) to u8'])
  })

  test('a global keeps its pointer annotation over a literal initializer', () => {
    const result = checkModule(`
      type Slot = (key: u32, value: u32)
      global words: [*]mut u32 = 0
      global slots: [*]mut Slot = 0
      func f(p: u32) -> u32 {
        words = p as [*]mut u32
        slots = p as [*]mut Slot
        words[1] = 5
        slots[0].value = words[1]
        return slots[0].value
      }
    `)
    expect(result.errors).toHaveLength(0)
    const words = result.symbols.get('words')
    expect(words?.kind === 'global' && typeToString(words.type)).toBe('[*]mut u32')
  })
})

describe('defer', () => {
  test('a deferred expression cannot return', () => {
    const result = checkModule(`func f(n: u32) { defer if n > 0 { return } }`)
    expect(result.errors.map(e => e.message)).toContain('cannot return from inside a deferred expression')
  })

  test('a deferred expression cannot break or continue an outer loop', () => {
    const result = checkModule(`
      func f(n: u32) {
        loop {
          defer if n > 1 { break }
          defer if n > 2 { continue }
          break
        }
      }
    `)
    const messages = result.errors.map(e => e.message)
    expect(messages).toContain('cannot break out of a deferred expression')
    expect(messages).toContain('cannot continue out of a deferred expression')
  })

  test('a loop inside a deferred expression can break and continue', () => {
    const result = checkModule(`
      func f() {
        defer if true {
          for j in 3 {
            continue when j == 1
            break when j == 2
          }
        }
      }
    `)
    expect(result.errors).toHaveLength(0)
  })
})

describe('missing return', () => {
  const errs = (src: string) => checkModule(src).errors.map(e => e.message)

  test('a block body with an unnamed result must return', () => {
    expect(errs(`func f(x: i32) -> i32 { let y = x }`)).toContain("function 'f' can reach its end without returning a value")
    expect(errs(`func f(x: i32) -> i32 {
      return 1 when x > 0
    }`)).toContain("function 'f' can reach its end without returning a value")
  })

  test('a bare return needs a value when the result is unnamed', () => {
    expect(errs(`func sign(x: i32) -> i32 {
      if x < 0 { return }
      return 1
    }`)).toEqual(['return needs a value: the function returns i32'])
    expect(errs(`func f(x: i32) -> (i32, f64) {
      return when x < 0
      return (x, 1.0)
    }`)).toEqual(['return needs a value: the function returns (i32, f64)'])
  })

  test('a bare return is fine with no result or named results', () => {
    expect(errs(`func f(x: i32) { return when x < 0 }`)).toEqual([])
    expect(errs(`func f(x: i32) -> (r: i32) {
      r = 1
      if x < 0 { return }
      r = 2
    }`)).toEqual([])
    expect(errs(`func divmod(a: u32, b: u32) -> (q: u32, r: u32) {
      return when b == 0
      q = a / b
      r = a % b
    }`)).toEqual([])
  })

  test('returns on every path are accepted', () => {
    expect(errs(`func f(x: i32) -> i32 { return x }`)).toEqual([])
    expect(errs(`func f(x: i32) -> i32 {
      if x > 0 { return 1 } elif x < 0 { return -1 } else { return 0 }
    }`)).toEqual([])
    expect(errs(`func f(x: i32) -> i32 {
      loop {
        return x when x > 10
      }
    }`)).toEqual([])
  })

  test('a match with a catch-all arm, where every arm returns, is accepted', () => {
    expect(errs(`func f(x: i32) -> i32 {
      match x {
        0 => { return 1 }
        _ => { return 2 }
      }
    }`)).toEqual([])
    expect(errs(`func f(x: i32) -> i32 {
      match x {
        0 => { return 1 }
        1 => { return 2 }
      }
    }`)).toContain("function 'f' can reach its end without returning a value")
  })

  test('a loop that can break can reach the end', () => {
    expect(errs(`func f(x: i32) -> i32 {
      loop {
        break when x > 10
      }
    }`)).toContain("function 'f' can reach its end without returning a value")
  })

  test('named results and void functions need no return', () => {
    expect(errs(`func f(x: i32) -> (r: i32) { r = x }`)).toEqual([])
    expect(errs(`func f(x: i32) { let y = x }`)).toEqual([])
  })
})

describe('if expressions as values', () => {
  // The value is the last expression of each branch, whatever kind it is.
  test('an operator, an index or a field in the first branch gives the value its type', () => {
    const source = `
      type Pair = (x: i32, y: i32)
      func f(c: bool, p: i32, l: i32, xs: [*]i32, pair: Pair) -> i32 {
        let a = if c { p - l } else { -1 }
        let b = if c { xs[2] } else { -1 }
        let d = if c { pair.x } else { -1 }
        return a + b + d
      }
    `
    const result = checkModule(source)
    expect(result.errors).toEqual([])
    for (const name of ['a', 'b', 'd']) {
      expect(typeAt(result, source.indexOf(`let ${name} =`) + 4)).toBe('i32')
    }
  })
})

describe('operand types', () => {
  const errs = (src: string) => checkModule(src).errors.map(e => e.message)

  test('operands widen to a common type', () => {
    expect(errs(`
      func a(r: f64, n: i32) -> f64 => r * n
      func b(n: i32, r: f64) -> bool => n < r
      func c(x: u8, y: i16, z: i64) -> i64 => x + y + z
      func d(x: f32, y: f64) -> f64 => x / y
      func e(x: u32, y: i64) -> bool => x == y
      func f(x: f32, n: u16) -> f32 => x - n
    `)).toEqual([])
  })

  test('the checker records each widening for codegen', () => {
    const result = checkModule(`func f(a: i32, b: i64) -> i64 => a + b`)
    const widened = [...result.coercions].map(([expr, type]) => [expr.kind === 'IdentExpr' ? expr.name : expr.kind, typeToString(type)])
    expect(widened).toEqual([['a', 'i64']])
  })

  test('types neither of which holds the other need a cast', () => {
    expect(errs(`func f(a: i32, b: u32) -> bool => a < b`)).toEqual(["mismatched operands for '<': i32 and u32 (cast one side explicitly)"])
    expect(errs(`func f(a: i32, b: f32) -> bool => a == b`)).toEqual(["mismatched operands for '==': i32 and f32 (cast one side explicitly)"])
    expect(errs(`func f(a: i64, b: f64) { let x = a * b }`)).toEqual(["mismatched operands for '*': i64 and f64 (cast one side explicitly)"])
    expect(errs(`func f(a: i8, b: u8) { let x = a + b }`)).toEqual(["mismatched operands for '+': i8 and u8 (cast one side explicitly)"])
  })

  test('bool is not a number', () => {
    expect(errs(`func f(a: bool, b: i32) { let x = a + b }`)).toEqual(["'+' cannot be applied to bool: cast it to an integer first"])
    expect(errs(`func f(a: bool) { let x = -a }`)).toEqual(["'-' needs a number, not bool"])
    expect(errs(`func f(a: bool, b: bool) -> bool => a == b && (a | b) != (a ^ b)`)).toEqual([])
  })

  test('integer operators reject floats', () => {
    expect(errs(`func f(a: f64) { let x = a % 2.0 }`)).toEqual(["'%' needs integer operands, not f64"])
    expect(errs(`func f(a: f64, b: f64) { let x = a & b }`)).toEqual(["'&' needs integer operands, not f64"])
    expect(errs(`func f(a: f32) { let x = a << 1 }`)).toEqual(["'<<' needs integer operands, not f32"])
    expect(errs(`func f(a: f64) { let x = ~a }`)).toEqual(["'~' needs an integer, not f64"])
    expect(errs(`func f() { let x: f32 = 7 % 2 }`)).toEqual(["'%' needs integer operands, not f32"])
  })

  test('logical operators and conditions take bools only', () => {
    expect(errs(`func f(a: i32, b: bool) -> bool => a && b`)).toEqual(["operand of '&&' must be bool, not i32"])
    expect(errs(`func f(a: i64) -> bool => !a`)).toEqual(["operand of '!' must be bool, not i64"])
    expect(errs(`func f(a: i32) { if a { } }`)).toEqual(['condition must be bool, not i32'])
    expect(errs(`func f(a: f64) { while a { break } }`)).toEqual(['condition must be bool, not f64'])
    expect(errs(`func f(a: i64) { return when a }`)).toEqual(['condition must be bool, not i64'])
    expect(errs(`func f(a: i64) { assert a }`)).toEqual(['condition must be bool, not i64'])
    expect(errs(`func f(a: i32) { if a != 0 { } }`)).toEqual([])
  })

  test('a shift takes any integer count and keeps the value\'s sign', () => {
    const source = `func f(a: i32, n: u8, w: u64) {
      let x = a >> n
      let y = a << w
      let z = 1 << w
    }`
    const result = checkModule(source)
    expect(result.errors).toEqual([])
    expect(typeAt(result, source.indexOf('x ='))).toBe('i32')
    expect(typeAt(result, source.indexOf('y ='))).toBe('i64')
    expect(typeAt(result, source.indexOf('z ='))).toBe('u64')
  })

  test('a rotation stays in the value\'s type, whatever the count\'s', () => {
    const source = `func f(a: u16, w: u64) {
      let x = a <<< w
      let y = a >>> w
    }`
    const result = checkModule(source)
    expect(result.errors).toEqual([])
    expect(typeAt(result, source.indexOf('x ='))).toBe('u16')
    expect(typeAt(result, source.indexOf('y ='))).toBe('u16')
  })

  test('constants take the type they are used as, each literal by its own value', () => {
    expect(errs(`func f() {
      let a: f32 = 1.0 + 42
      let b: f32 = 1.0 + 16777216
      let c: f64 = 1 + 2
      let d: i64 = 2 * (3 + 4)
    }`)).toEqual([])
    expect(errs(`func f() { let z: f32 = 1.0 + 16777217 }`)).toEqual(['cannot assign int(16777217) to f32'])
    expect(errs(`func f() { let z: u8 = 200 + 100 }`)).toEqual(['cannot assign int(300) to u8'])
    expect(errs(`func f(n: i32) -> i32 => n * 1.5`)).toEqual(['cannot assign f64 to i32'])
  })

  test('a complement of a constant fits the unsigned types its operand fits', () => {
    expect(errs(`func f(x: u32, y: u8, z: u64, w: u128) {
      let a = x & ~3
      let b: u32 = ~0
      let c = y & ~1
      let d = z & ~0xff
      let e: u8 = ~0 << 4
      let g = x == ~0
      let h = w ^ ~0
      x &= ~7
    }`)).toEqual([])
    expect(errs(`func f() { let a: u8 = ~300 }`)).toEqual(['cannot assign int(-301) to u8'])
    // Arithmetic on a complement is a number again, and a negative one.
    expect(errs(`func f() { let a: u32 = ~0 - 1 }`)).toEqual(['cannot assign int(-2) to u32'])
    expect(errs(`func f(x: u32) -> u32 => x & -4`)).toEqual(['cannot assign int(-4) to u32'])
    // A range is a bound on the value, not a width.
    expect(errs(`func f() { let i: u32#8 = ~3 }`)).toEqual(['cannot assign int(-4) to u32#8'])
    expect(errs(`func f(x: f64) -> f64 => x * ~3`)).toEqual(["'~' needs an integer, not f64"])
  })

  test('a range comes only from a constant whose value is known', () => {
    const index = (expr: string) => errs(`data t = [0:u8; 16]\nfunc f(x: u32, c: bool, k: i32) -> u8 => t[${expr}]`)
    const unproven = ["runtime index on *[16]u8 requires 'if let' or '??' (no optional type for u8)"]
    expect(index('x >> 28')).toEqual([])
    expect(index('x & (3 | 12)')).toEqual([])
    expect(index('x % (4 * 4)')).toEqual([])
    // An if or match of constants is a constant with no one value: x >> 1
    // isn't below 16 because x >> 28 is.
    expect(index('x >> (if c { 1 } else { 28 })')).toEqual(unproven)
    expect(index('x >> (match k { 0 => 28\n _ => 0 })')).toEqual(unproven)
    expect(index('x & (if c { 3 } else { 15 })')).toEqual(unproven)
    expect(index('x & ~15')).toEqual(unproven)
    expect(index('x & (~0 & 7 | 16)')).toEqual(['index type u32#24 may exceed *[16]u8 bounds (max index 23 >= 16) — narrow the index range to fit'])
  })

  test('pointer arithmetic takes 32-bit integers', () => {
    expect(errs(`func f(p: [*]u8, n: u32, q: [*]u8) -> bool => p + n < q`)).toEqual([])
    expect(errs(`func f(p: [*]u8, n: i64) { let q = p + n }`)).toEqual(["'+' cannot be applied to [*]u8 and i64"])
    expect(errs(`func f(a: []u8, b: []u8) -> bool => a == b`)).toEqual(["'==' cannot be applied to []u8 and []u8"])
  })

  test('an index is an integer of at most 32 bits', () => {
    expect(errs(`func f(p: [*]i32, i: i64) -> i32 => p[i]`)).toEqual(['an index must be an integer of at most 32 bits, not i64'])
    expect(errs(`func f(p: [*]i32, i: u8) -> i32 => p[i]`)).toEqual([])
  })

  test('casts convert between numbers, bools and addresses', () => {
    expect(errs(`func f(a: f64, p: *u8, b: bool) -> i64 => (a as i64) + (p as u32) + (b as u8)`)).toEqual([])
    expect(errs(`func f(a: i32) -> []u8 => a as []u8`)).toEqual(['cannot cast i32 to []u8'])
    expect(errs(`func f(a: []u8) -> u32 => u32(a)`)).toEqual(['cannot cast []u8 to u32'])
    expect(errs(`func f(a: u128) -> f64 => a as f64`)).toEqual(['cannot cast u128 to f64: not supported yet'])
  })

  test('a number is not cast to a bool', () => {
    expect(errs(`func f(a: i32) -> bool => a as bool`)).toEqual(['cannot cast i32 to bool: compare it instead (x != 0)'])
    expect(errs(`func f(a: f64) -> bool => bool(a)`)).toEqual(['cannot cast f64 to bool: compare it instead (x != 0)'])
    expect(errs(`func f(p: *u8) -> bool => p as bool`)).toEqual(['cannot cast *u8 to bool: compare it instead (x != 0)'])
    expect(errs(`func f(a: bool) -> bool => (a as bool) == (a as u8 != 0)`)).toEqual([])
  })
})

describe('values meeting an expected type', () => {
  const errs = (src: string) => checkModule(src).errors.map(e => e.message)

  test('a narrower value widens in every position', () => {
    expect(errs(`
      type Pair = (a: i64, b: f64)
      global total: f64 = 0.0
      func take(x: i64, y: f64) -> f64 => y
      func f(n: i32, x: f32) -> f64 {
        let a: i64 = n
        let b: f64 = x
        a = n
        b += n
        total = n
        set a = n
        let p = Pair(n, x)
        let q: (i64, f64) = (n, n)
        return take(n, n)
      }
      func g(c: bool, n: i32, x: f64) -> f64 => if c { n } else { x }
      func h(k: i32, n: i32, big: i64) -> i64 => match k { 0 => n
        _ => big }
    `)).toEqual([])
  })

  test('narrowing and lossy conversions stay errors', () => {
    expect(errs(`func f(a: i64) -> i32 => a`)).toEqual(['cannot assign i64 to i32'])
    expect(errs(`func f(a: i32) -> f32 => a`)).toEqual(['cannot assign i32 to f32'])
    expect(errs(`func f(a: i64) { let x: f64 = a }`)).toEqual(['cannot assign i64 to f64'])
    expect(errs(`func f(a: f64) { let x: f32 = 0.0\n x += a }`)).toEqual(['cannot assign f64 to f32'])
    expect(errs(`func f(a: i64) { let x: i32 = 0\n set x = a }`)).toEqual(['cannot assign i64 to i32'])
  })

  test('the branches of an if or match settle on one type', () => {
    const source = `func f(c: bool, n: i32, big: i64, x: f64) {
      let a = if c { n } else { big }
      let b = if c { 1 } else { x }
      let d = match n { 0 => n
        _ => big }
      let e = if c { 1 } else { 2 }
    }`
    const result = checkModule(source)
    expect(result.errors).toEqual([])
    expect(typeAt(result, source.indexOf('a ='))).toBe('i64')
    expect(typeAt(result, source.indexOf('b ='))).toBe('f64')
    expect(typeAt(result, source.indexOf('d ='))).toBe('i64')
    expect(typeAt(result, source.indexOf('e ='))).toBe('i32')
  })

  test('branches that cannot agree are an error where the value is used', () => {
    expect(errs(`func f(c: bool, a: i32, b: u32) { let v = if c { a } else { b } }`))
      .toEqual(['branches have different types: u32 and i32 (cast one explicitly)'])
    expect(errs(`func f(c: bool, a: i32) -> i32 => if c { a } else { a = 2 }`))
      .toEqual(['this branch has no value: expected i32'])
  })

  test('an if statement\'s branches need not agree', () => {
    expect(errs(`
      func a() -> i32 => 1
      func b() -> u32 => 2
      func f(c: bool, n: i32) {
        if c { a() } else { b() }
        if c { a() } else { n = 2 }
        match n { 0 => a()
          _ => b() }
      }
    `)).toEqual([])
  })

  test('the elements of an untyped array literal settle on one type', () => {
    const source = `
      func f(a: u8, b: i32, c: i64, x: f64, i: u32#4) {
        let ints = [a, b, c]
        let consts = [1, c, -2]
        let floats = [b, x, 2]
        let halves = [b, 0.5]
        let wide = [a, 300]
        let big = [1, 5000000000]
        let mixed = [1, 2.5]
        let ranged = [i, 9]
      }
    `
    const result = checkModule(source)
    expect(result.errors).toEqual([])
    const type = (name: string) => typeAt(result, source.indexOf(`let ${name} =`) + 4)
    expect(type('ints')).toBe('[3]i64')
    expect(type('consts')).toBe('[3]i64')
    expect(type('floats')).toBe('[3]f64')
    expect(type('halves')).toBe('[2]f64')
    expect(type('wide')).toBe('[2]i32')
    expect(type('big')).toBe('[2]i64')
    expect(type('mixed')).toBe('[2]f64')
    // One element's range says nothing about the others.
    expect(type('ranged')).toBe('[2]u32')
  })

  test('elements that cannot agree are an error', () => {
    expect(errs(`func f(a: i32, b: u32) { let r = [a, b] }`)).toEqual(['elements have different types: u32 and i32 (cast one explicitly)'])
    expect(errs(`func f(a: i32, b: bool) { let r = [a, b] }`)).toEqual(['elements have different types: bool and i32 (cast one explicitly)'])
    expect(errs(`func f(a: i64, x: f64) { let r = [x, a] }`)).toEqual(['elements have different types: i64 and f64 (cast one explicitly)'])
  })

  test('a declared element type is what each element has to fit', () => {
    expect(errs(`func f(m: u8, x: f32, n: i32) {
      let a: [2]i16 = [300, m]
      let b: [2]f32 = [0.5, x]
      let c: [2]i64 = [5000000000, n]
      let d: [2]i64 = [m, n]
    }`)).toEqual([])
    expect(errs(`func f(n: i32) { let a: [2]i16 = [300, n] }`)).toEqual(['cannot assign i32 to i16'])
    expect(errs(`func f(m: u8) { let a: [3]i16 = [300, m] }`)).toEqual(['cannot assign [2]i32 to [3]i16'])
  })

  test('a trailing expression is checked against the named result it supplies', () => {
    expect(errs(`func f(n: i32) -> (r: i64) { n }`)).toEqual([])
    expect(errs(`func f(n: i64) -> (r: i32) { n }`)).toEqual(['cannot assign i64 to i32'])
    expect(errs(`func g() {}\nfunc f(n: i64) -> (r: i32) { r = 1\n g() }`)).toEqual([])
  })

  test('a trailing value fills several named results in order', () => {
    const pair = 'func pair(n: u32) -> (u32, u32) => (n, n)\n'
    const named = 'func pair(n: u32) -> (x: u32, y: u32) => (n, n)\n'
    expect(errs(`func f(n: i32) -> (r: i32, s: i32) { (n, n) }`)).toEqual([])
    expect(errs(`func f(n: i32) -> (r: i64, s: f64) { (n, n) }`)).toEqual([])
    expect(errs(`${pair}func f(n: u32) -> (q: u32, r: u32) { pair(n) }`)).toEqual([])
    expect(errs(`${named}func f(n: u32) -> (q: u32, r: u32) { pair(n) }`)).toEqual([])
    expect(errs(`${pair}func f(n: u32) -> (q: u64, r: u64) { pair(n) }`)).toEqual(['cannot convert (u32, u32) to (u64, u64) implicitly: convert its fields'])
    expect(errs(`${pair}func f(n: u32) -> (q: u32, r: bool) { pair(n) }`)).toEqual(['cannot assign (u32, u32) to (u32, bool)'])
    expect(errs(`func f(n: u32) -> (q: u32, r: u32) { n }`)).toEqual(['cannot assign u32 to (q: u32, r: u32)'])
  })

  test('an expression body supplies named results', () => {
    expect(errs(`func f(n: i32) -> (r: i64) => n`)).toEqual([])
    expect(errs(`func f(n: i32) -> (r: i64, s: f64) => (n, n)`)).toEqual([])
    expect(errs(`func f(x: f64) -> (r: i64) => x`)).toEqual(['cannot assign f64 to i64'])
  })

  test('a match pattern has to be a value of the subject\'s type', () => {
    expect(errs(`func f(x: i64) -> i32 => match x { 5000000000 => 1\n _ => 0 }`)).toEqual([])
    expect(errs(`func f(x: f64) -> i32 => match x { 1 => 1\n 2.5 => 2\n _ => 0 }`)).toEqual([])
    expect(errs(`func f(x: u8) -> i32 => match x { 300 => 1\n _ => 0 }`)).toEqual(['cannot match u8 against int(300)'])
    expect(errs(`func f(x: i32) -> i32 => match x { true => 1\n _ => 0 }`)).toEqual(['cannot match i32 against bool'])
    expect(errs(`func f(x: i32) -> i32 => match x { 1.5 => 1\n _ => 0 }`)).toEqual(['cannot match i32 against float(1.5)'])
  })

  test('a tuple literal names its fields in order or not at all', () => {
    const point = 'type P = (x: i32, y: i32)\n'
    const swapped = ["field 'y' is in the place of 'x': the elements of a tuple literal go in order", "field 'x' is in the place of 'y': the elements of a tuple literal go in order"]
    expect(errs(`${point}func f() { let p: P = (x: 2, y: 1)\n let q: P = (2, 1) }`)).toEqual([])
    expect(errs(`${point}func f() -> P => P(y: 1, x: 2)`)).toEqual([])
    expect(errs(`${point}func f() { let p: P = (y: 1, x: 2) }`)).toEqual(swapped)
    expect(errs(`${point}func f() -> P => (y: 1, x: 2)`)).toEqual(swapped)
    expect(errs(`${point}func f(x: i32, y: i32) -> (x: i32, y: i32) { (y:, x:) }`)).toEqual(swapped)
    expect(errs(`${point}func g(p: P) {}\nfunc f() { g((y: 1, x: 2)) }`)).toEqual(swapped.map(m => `argument 1: ${m}`))
    // Names for a tuple that has none are just labels.
    expect(errs(`func f(n: i32) { let t: (i64, f64) = (count: n, mean: n) }`)).toEqual([])
  })

  test('a struct value is not widened field by field', () => {
    expect(errs(`
      type Small = (a: i32, b: i32)
      type Big = (a: i64, b: i64)
      func f(s: Small) -> Big => s
    `)).toEqual(['cannot convert Small to Big implicitly: convert its fields'])
    expect(errs(`
      func two() -> (i32, i32) => (1, 2)
      func f() { let a: i64 = 0\n let b: i64 = 0\n set (a, b) = two() }
    `)).toEqual(["cannot set 'a' (i64) from a field of type i32", "cannot set 'b' (i64) from a field of type i32"])
  })
})

describe('struct constructors', () => {
  test('arguments are checked against their fields', () => {
    const result = checkModule(`
      type Point = (x: i32, y: i32)
      func f(n: i32) -> Point => Point(n, n * 2)
      func g() -> Point => Point(y: 1, x: -2)
    `)
    expect(result.errors).toHaveLength(0)
  })

  test('the wrong number of arguments is an error', () => {
    const result = checkModule(`
      type Point = (x: i32, y: i32)
      func f() -> Point => Point(1)
    `)
    expect(result.errors.map(e => e.message)).toContain('(x: i32, y: i32) expects 2 fields, got 1')
  })

  test('an unknown field name is an error', () => {
    const result = checkModule(`
      type Point = (x: i32, y: i32)
      func f() -> Point => Point(x: 1, z: 2)
    `)
    expect(result.errors.map(e => e.message)).toContain("field 'z' not found in (x: i32, y: i32)")
  })
})
