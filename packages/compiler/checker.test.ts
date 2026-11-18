/** biome-ignore-all lint/style/noNonNullAssertion: this is a test, it's fine */
import { describe, expect, test } from 'bun:test'
import { concretizeType, isConcreteType, typecheck, typecheckProgram, typeKey, type TypeCheckResult } from './checker'
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

    test('past an i32 is an i64, as a variable of it is', () => {
      // A literal left with no type of its own is emitted in this type, and
      // the variable it starts in the checker's default (i64), not a u32.
      for (const value of [2147483648n, 3000000000n, 4294967295n, 9223372036854775808n, 18446744073709551615n]) {
        expect(concretizeType(comptimeInt(value))).toEqual(primitive('i64'))
      }
      expect(concretizeType(comptimeInt(-2147483649n))).toEqual(primitive('i64'))
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
    // The values go to codegen by initializer, in the order written.
    expect([...result.constants.values()].slice(0, 5)).toEqual([
      { kind: 'int', value: 262144n },
      { kind: 'float', value: 1.5 },
      { kind: 'int', value: 3n },
      { kind: 'int', value: 5n },
      // As a u8 holds it.
      { kind: 'int', value: 240n },
    ])
  })

  test('a constant is worked out in its type, as it would be at run time', () => {
    const result = checkModule(`
      def half = 7 / 2
      global real: f64 = 7 / 2
      global third: f32 = 1 / 3
      global named: f64 = half
      global whole: i32 = half
      global byte: i32 = 200:u8 + 100:u8
      global word: u64 = 0xFFFFFFFF:u32 + 1
      global under: u32 = (7:u32 - 9:u32) / 2
      global count: u32 = 1:u32 << 40
      global down: i32 = -16:i32 >> 34
      global far: u128 = 5:u128 >> 130
      global single: f64 = 0.1:f32 + 0.2:f32
      global big: i64 = 1 << 40
    `)
    expect(result.errors).toEqual([])
    expect([...result.constants.values()]).toEqual([
      // A float division where the literals are floats, an integer one where they're integers.
      { kind: 'float', value: 3.5 },
      { kind: 'float', value: Math.fround(1 / 3) },
      { kind: 'float', value: 3.5 },
      { kind: 'int', value: 3n },
      // Arithmetic wraps to its operands' width before the result widens.
      { kind: 'int', value: 44n },
      { kind: 'int', value: 0n },
      { kind: 'int', value: 2147483647n },
      // A shift uses the low bits of its count.
      { kind: 'int', value: 256n },
      { kind: 'int', value: -4n },
      // A wide integer's too: 130 is 2 in the 128 bits of a u128.
      { kind: 'int', value: 1n },
      { kind: 'float', value: Math.fround(Math.fround(0.1) + Math.fround(0.2)) },
      { kind: 'int', value: 1099511627776n },
    ])
  })

  test('a division that traps at run time is not a constant', () => {
    const message = 'global initializer must be a compile-time constant'
    expect(errs(`global g: i32 = (-2147483648):i32 / -1`)).toEqual([message])
    expect(errs(`global g: i32 = 1 / 0`)).toEqual([message])
    expect(errs(`global g: i32 = (-2147483648):i32 % -1`)).toEqual([])
  })

  test('an initializer that has to be computed at run time is an error', () => {
    const message = 'global initializer must be a compile-time constant'
    expect(errs(`func one() -> i32 => 1\nglobal g: i32 = one()`)).toEqual([message])
    expect(errs(`global a: i32 = 1\nglobal b: i32 = a`)).toEqual([message])
    expect(errs(`func one() -> i32 => 1\nglobal g: i64 = one() as i64`)).toEqual([message])
    expect(errs(`func one() -> i32 => 1\nglobal g: i64 = i64(one())`)).toEqual([message])
    expect(errs(`global g: u8 = 200 + 100`)).toEqual(['cannot assign int(300) to u8'])
  })

  test('a cast of a constant is a constant: the value the cast gives at run time', () => {
    const result = checkModule(`
      def k = 7
      global same: u32 = 5 as u32
      global bits: u32 = -1 as u32
      global wide: i64 = k as i64
      global byte: u8 = 300 as u8
      global small: i8 = i8(200)
      global whole: i32 = 2.9 as i32
      global down: i32 = -2.9 as i32
      global real: f64 = k as f64
      global single: f64 = (0.1 as f32) as f64
      global nearest: f32 = 9007199791611905 as f32
      global flag: u8 = true as u8
      global again: i64 = (-1 as u8) as i64
    `)
    expect(result.errors).toEqual([])
    expect([...result.constants.values()]).toEqual([
      { kind: 'int', value: 5n },
      { kind: 'int', value: 4294967295n },
      { kind: 'int', value: 7n },
      { kind: 'int', value: 44n },
      { kind: 'int', value: -56n },
      { kind: 'int', value: 2n },
      { kind: 'int', value: -2n },
      { kind: 'float', value: 7 },
      { kind: 'float', value: Math.fround(0.1) },
      // Rounded once, as f32.convert_i64_s does: by way of a double it would be 2^53.
      { kind: 'float', value: 9007200328482816 },
      { kind: 'int', value: 1n },
      { kind: 'int', value: 255n },
    ])
  })

  test('an address cast to a pointer or a 32-bit integer is still the address', () => {
    const message = 'global initializer must be a compile-time constant'
    const table = 'data table = mut [1:i32, 2, 3, 4]\n'
    expect(errs(`${table}
      global words: [*]i32 = table as [*]i32
      global bytes: [*]mut u8 = table as [*]mut u8
      global start: u32 = table as u32
      global also: u32 = u32(table)
      global name: [*]u8 = "name" as [*]u8
      global fixed: *mut i32 = 4096 as *mut i32
    `)).toEqual([])
    // Cut down or widened, it's a value only the laid-out module has.
    expect(errs(`${table}global low: u8 = table as u8`)).toEqual([message])
    expect(errs(`${table}global wide: u64 = table as u64`)).toEqual([message])
  })

  test('a float cast to an integer it does not fit is not a constant', () => {
    const message = 'global initializer must be a compile-time constant'
    expect(errs(`global g: u32 = -1.5 as u32`)).toEqual([message])
    expect(errs(`global g: i32 = 3000000000.0 as i32`)).toEqual([message])
    expect(errs(`global g: u32 = -0.5 as u32\nglobal h: u32 = 3000000000.0 as u32`)).toEqual([])
  })

  test('a tuple or struct of constants is a constant too', () => {
    const size = 'type Size = (w: i32, h: i32)\n'
    const message = 'global initializer must be a compile-time constant'
    expect(errs(`${size}global size: Size = Size(3, 4)\nglobal span: (i32, i32) = (1 + 2, 4)\nglobal view: []u8 = (0, 0)`)).toEqual([])
    expect(errs(`${size}func one() -> i32 => 1\nglobal size: Size = Size(one(), 4)`)).toEqual([message])
    expect(errs(`global a: i32 = 1\nglobal pair: (i32, i32) = (a, 2)`)).toEqual([message])
  })

  test('each part of a tuple, struct or array of constants has its value', () => {
    const result = checkModule(`
      type Size = (w: i32, h: f64)
      global size: Size = Size(1 + 2, 4:i32)
      global span: (i64, u128) = (1 << 40, 5)
      global row: [2]i32 = [2 * 3, 7]
    `)
    expect(result.errors).toEqual([])
    expect([...result.constants.values()].map(v => v.kind === 'int' && v.value)).toEqual([3n, 4n, 1n << 40n, 5n, 6n, 7n])
    expect(errs(`func one() -> i32 => 1\nglobal row: [2]i32 = [one(), 2]`)).toEqual(['global initializer must be a compile-time constant'])
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

describe('writes through pointers', () => {
  const errs = (body: string, params = 'p: *Spot, m: *mut Spot') =>
    checkModule(`
      type Spot = (c: i32, di: i32)
      type Row = (tag: u8, v: [3]i32, at: Spot)
      func f(${params}) {
        ${body}
      }
    `).errors.map(e => e.message)
  const constPointer = 'cannot write through const pointer — use *mut for mutable access'

  test('a field of the struct a pointer points to needs a mutable pointer', () => {
    expect(errs('p.c = 5')).toEqual([constPointer])
    expect(errs('p.di += 1')).toEqual([constPointer])
    expect(errs('m.c = 5\nm.di += 1')).toEqual([])
  })

  test('a field of a field goes through whatever holds the outermost struct', () => {
    expect(errs('rows[1].at.c = 5', 'rows: [*]Row')).toEqual([constPointer])
    expect(errs('rows[1].at.c = 5', 'rows: [*]mut Row')).toEqual([])
    expect(errs('r.at.c = 5\nr.at = Spot(1, 2)', 'r: *Row')).toEqual([constPointer, constPointer])
    expect(errs('r.at.c = 5\nr.at = Spot(1, 2)', 'r: *mut Row')).toEqual([])
    expect(errs('rows[1].at.c = 5', 'rows: []Row')).toContain('cannot write through const slice — use []mut for mutable access')
  })

  test('an element of a fixed array in a struct goes through the struct', () => {
    expect(errs('r.v[0] = 1', 'r: *Row')).toEqual([constPointer])
    expect(errs('r.v[0] = 1', 'r: *mut Row')).toEqual([])
    expect(errs('rows[0].v[2] += 1', 'rows: [*]Row')).toEqual([constPointer])
  })

  test('a struct in a variable is written without a pointer', () => {
    expect(errs('r.at.c = 5\nr.v[0] = 1\nr.at = Spot(1, 2)', 'r: Row')).toEqual([])
    // A pointer held in a field of a variable still gates writes through it.
    expect(errs('h.p.c = 5', 'h: (p: *Spot)')).toEqual([constPointer])
    expect(errs('h.p.c = 5', 'h: (p: *mut Spot)')).toEqual([])
  })

  test('a type pun is the pointer, not a place: the place is its element', () => {
    const pun = (type: string, pointer: string) =>
      `cannot assign to .${type}: it is the pointer as ${pointer}, not the ${type} it points at — write .${type}[0] = value to store one`
    for (const type of ['u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'u64', 'i64', 'f32', 'f64', 'bool']) {
      const value = type === 'bool' ? 'true' : '1'
      expect(errs(`b.${type} = ${value}`, 'b: [*]mut u8')).toEqual([pun(type, `[*]mut ${type}`)])
      expect(errs(`b.${type}[0] = ${value}`, 'b: [*]mut u8')).toEqual([])
    }
    // Whatever is punned and whatever is assigned, also with an operator.
    expect(errs('s.u16 = 1', 's: []mut u8')).toEqual([pun('u16', '[*]mut u16')])
    expect(errs('m.u32 = m.u32', 'm: *mut Spot')).toEqual([pun('u32', '[*]mut u32')])
    expect(errs('b.u32 += 1', 'b: [*]mut u8')).toEqual([pun('u32', '[*]mut u32')])
    expect(errs('b.u32 = 1', 'b: [*]u8')).toEqual([pun('u32', '[*]u32')])
    expect(errs('n.u8 = 1', 'n: u32')).toEqual(['cannot assign to .u8: a type pun is not a place a value can be stored to'])
    // The value is still checked.
    expect(errs('b.u32 = nothing', 'b: [*]mut u8')).toEqual([pun('u32', '[*]mut u32'), "unknown identifier 'nothing'"])
  })
})

describe('tables', () => {
  // *[N][M]T, [][M]T and [*][M]T hold pointers to rows laid out apart: an
  // element is a row pointer, *[M]T.
  const tables = `
    data grid: *[2][3]i32 = [[7, 1, 2], [3, 4, 5]]
    data board: *mut [2][3]i32 = mut [[0; 3]; 2]
    data rows: [][2]i32 = [[7, 1], [3, 4], [5, 6]]
    data many: [*][2]i32 = [[7, 1], [3, 4]]
    data cube: *[2][2][2]i32 = [[[1, 2], [3, 4]], [[5, 6], [7, 8]]]
    data spare: *mut [3]i32 = mut [1, 2, 3]
    data fixed: *[3]i32 = [1, 2, 3]
    data pair: *[2]i32 = [5, 6]
  `
  const check = (body: string, params = '') => checkModule(`${tables}\nfunc f(${params}) {\n${body}\n}`)
  const errs = (body: string, params = '') => check(body, params).errors.map(e => e.message)
  const letType = (value: string, params = '') => {
    const source = `${tables}\nfunc f(${params}) {\nlet r = ${value}\n}`
    const result = checkModule(source)
    expect(result.errors.map(e => e.message)).toEqual([])
    return typeAt(result, source.indexOf('let r =') + 4)
  }

  test('an element is a pointer to its row', () => {
    expect(letType('grid[1]')).toBe('*[3]i32')
    expect(letType('board[1]')).toBe('*mut [3]i32')
    expect(letType('rows[i] ?? pair', 'i: u32')).toBe('*[2]i32')
    expect(letType('many[5]')).toBe('*[2]i32')
    expect(letType('cube[1]')).toBe('*[2][2]i32')
    expect(letType('cube[1][0]')).toBe('*[2]i32')
    expect(letType('grid[1][2]')).toBe('i32')
    expect(letType('grid[i][j]', 'i: u32#2, j: u32#3')).toBe('i32')
    expect(letType('&grid[1]')).toBe('**[3]i32')
    // A fixed array that is a field of a struct lies in place.
    expect(letType('ps[1].v', 'ps: *[2](k: u8, v: [2]i32)')).toBe('[2]i32')
    // A packed block is not a table: its row is an address in the block.
    expect(letType('p[1]', 'p: *[2x3]i32')).toBe('*[3]i32')
    expect(letType('p[1]', 'p: *mut [2x3]i32')).toBe('*mut [3]i32')
  })

  test('a run-time index works on both, each checked on its own', () => {
    expect(errs('let a = grid[i][j]\nlet b = cube[i][k][k]', 'i: u32#2, j: u32#3, k: u32#2')).toEqual([])
    expect(errs('let a = grid[i][j]', 'i: u32#3, j: u32#3')).toEqual([
      'index type u32#3 may exceed *[2][3]i32 bounds (max index 2 >= 2) — narrow the index range to fit',
    ])
    expect(errs('let a = grid[0][j]', 'j: u32#4')).toEqual([
      'index type u32#4 may exceed *[3]i32 bounds (max index 3 >= 3) — narrow the index range to fit',
    ])
    expect(errs('let a = grid[2][0]')).toEqual(['index 2 out of bounds for *[2][3]i32'])
  })

  test('a row has no optional type: an unproven row index is resolved where it is taken', () => {
    const unresolved = (table: string) => `runtime index on ${table} requires 'if let' or '??' (rows are not optional)`
    expect(errs('let r = grid[i]', 'i: u32')).toEqual([unresolved('*[2][3]i32')])
    expect(errs('let r = rows[i][0]', 'i: u32')).toEqual([unresolved('[][2]i32')])
    // ?? and if let resolve the index they are given, not the row it is taken from.
    expect(errs('let r = grid[i][0] ?? 0', 'i: u32')).toEqual([unresolved('*[2][3]i32')])
    expect(errs('let r = grid[0][j] ?? 0\nlet s = grid[i] ?? spare', 'i: u32, j: u32')).toEqual([])
    expect(errs('if let r = rows[i] { let x = r[1] }', 'i: u32')).toEqual([])
    // A many-pointer has no length: its rows are never checked.
    expect(errs('let r = many[i][1]', 'i: u32')).toEqual([])
  })

  test('writes go through the row pointer', () => {
    const constPointer = 'cannot write through const pointer — use *mut for mutable access'
    expect(errs('board[i][j] = 5\nboard[1][0] += 1', 'i: u32#2, j: u32#3')).toEqual([])
    expect(errs('grid[1][0] = 5')).toEqual([constPointer])
    expect(errs('if let r = rows[0] { r[0] = 5 }')).toEqual([constPointer])
    // m[i] = r points row i at r.
    expect(errs('board[1] = spare')).toEqual([])
    expect(errs('grid[1] = fixed')).toEqual([constPointer])
    expect(errs('board[1] = fixed')).toEqual(['cannot assign *[3]i32 to *mut [3]i32'])
  })

  test('the rows of a table literal are constants: they are laid out apart, at compile time', () => {
    const row = (type: string) => `a row of ${type} is laid out at compile time: its values must be constants`
    expect(errs('let t: *[2][3]i32 = [[a, 2, 3], [4, 5, 6]]\nlet u: *[2][3]i32 = [v, [1, 2, 3]]\nlet w: [][2]i32 = [[a; 2]; 3]', 'a: i32, v: [3]i32')).toEqual([
      row('*[2][3]i32'), row('*[2][3]i32'), row('[][2]i32'),
    ])
    expect(errs('let t: *[2][3]i32 = [[1, 2, 3], [4, 5, 6]]\nlet u: *[1][1](x: i32, y: i32) = [[(1, -2)]]\nlet r: *mut [3]i32 = mut [a, 2, 3]', 'a: i32')).toEqual([])
  })

  test('len of a packed *[NxM]T is N, its rows; wid of a slice is the width of an element', () => {
    const value = (expr: string, params = '') => errs(`let n: u32#1 = ${expr}`, params)
    // A constant has to fit a ranged type, which pins it down.
    expect(value('p.len', 'p: *[2x3]i32')).toEqual(['cannot assign int(2) to u32#1'])
    expect(value('v.len', 'v: [2x3]i32')).toEqual(['cannot assign int(2) to u32#1'])
    expect(value('s.wid', 's: []u64')).toEqual(['cannot assign int(8) to u32#1'])
    expect(value('rows.wid', 'rows: []mut [3]i32')).toEqual(['cannot assign int(4) to u32#1'])
    expect(value('q.wid', 'q: *[]u16')).toEqual(['cannot assign int(2) to u32#1'])
  })

  test('len and wid are constants', () => {
    // A constant has to fit a ranged type, which pins it down: n < 3, w < 5.
    expect(errs('let n: u32#3 = grid.len\nlet w: u32#5 = grid.wid\nlet c: u32#5 = cube.wid\nlet r: u32#4 = grid[0].len')).toEqual([])
    expect(errs('let n: u32#2 = grid.len\nlet w: u32#4 = grid.wid\nlet c: u32#4 = cube.wid')).toEqual([
      'cannot assign int(2) to u32#2',
      'cannot assign int(4) to u32#4',
      'cannot assign int(4) to u32#4',
    ])
  })

  test('each element of a loop is a row pointer', () => {
    const source = `${tables}\nfunc f() {\nfor r in grid { let a = r[2] }\nfor s in rows { let b = s[1] }\nfor w in board { w[0] = 1 }\n}`
    const result = checkModule(source)
    expect(result.errors.map(e => e.message)).toEqual([])
    expect(typeAt(result, source.indexOf('r in grid'), 'ForBinding')).toBe('*[3]i32')
    expect(typeAt(result, source.indexOf('s in rows'), 'ForBinding')).toBe('*[2]i32')
    expect(typeAt(result, source.indexOf('w in board'), 'ForBinding')).toBe('*mut [3]i32')
  })

  test('a row passes as a pointer or a slice; the table cannot be loaded whole', () => {
    const fns = 'func sum(r: *[3]i32) -> i32 => r[0]\nfunc total(s: []i32) -> i32 => s[0] ?? 0\n'
    const source = (body: string) => `${tables}\n${fns}func f() {\n${body}\n}`
    expect(checkModule(source('let a = sum(grid[1]) + total(grid[1])\nlet v = grid[1].*')).errors.map(e => e.message)).toEqual([])
    expect(errs('let v = grid.*')).toEqual([
      'cannot use .* on *[2][3]i32: a table holds pointers to rows that lie apart — load one row with [i].*',
    ])
  })
})

describe('indexes not known to be in range', () => {
  // Reference 2.5 (Optional Types) and 4.7: an index that isn't proven gives
  // an optional element where there is one, which is resolved before anything
  // is read through it; a slice's length is only known at run time.
  const prelude = `
    type Pt = (x: i32, y: i32)
    data names: [][]u8 = ["Alice", "Bob"]
    data one = 1:i32
    data two = 2:i32
    data ps: *mut [2]*i32 = mut [one, two]
    data bytes: *mut [4]u8 = mut [0; 4]
    data packed: *[2x3]i32 = [[7, 1, 2], [3, 4, 5]]
  `
  const errs = (body: string, params = '') =>
    checkModule(`${prelude}\nfunc f(${params}) {\n${body}\n}`).errors.map(e => e.message)
  const unresolved = (what: string, type: string) => `cannot ${what} ${type}: it may be none — resolve it with 'if let' or '??' first`
  const letType = (value: string, params = '') => {
    const source = `${prelude}\nfunc f(${params}) {\nlet r = ${value}\n}`
    const result = checkModule(source)
    expect(result.errors.map(e => e.message)).toEqual([])
    return typeAt(result, source.indexOf('let r =') + 4)
  }

  test('an element that can be none is an optional, and nothing is read through it', () => {
    expect(letType('names[i]', 'i: u32')).toBe('?[]u8')
    expect(letType('ps[i]', 'i: u32')).toBe('?*i32')
    expect(errs('let n = names[i][0] ?? 0', 'i: u32')).toEqual([unresolved('index', '?[]u8')])
    expect(errs('let n = names[i].len', 'i: u32')).toEqual([unresolved('use .len on', '?[]u8')])
    expect(errs('let n = (names[i] ?? "")[0] ?? 0', 'i: u32')).toEqual([])
  })

  test('an optional is not indexed, dereferenced, ranged, iterated, moved, or read through', () => {
    expect(errs('let a = q[0]', 'q: ?*[3]i32')).toEqual([unresolved('index', '?*[3]i32')])
    expect(errs('let a = p.*', 'p: ?*u8')).toEqual([unresolved('dereference', '?*u8')])
    expect(errs('let a = p.x\nlet b = p.1', 'p: ?*Pt')).toEqual([unresolved('use .x on', '?*Pt'), unresolved('use .1 on', '?*Pt')])
    expect(errs('let a = s.ptr\nlet b = s[1..]', 's: ?[]u8')).toEqual([unresolved('use .ptr on', '?[]u8'), unresolved('take a range of', '?[]u8')])
    expect(errs('for c in s { }', 's: ?[]u8')).toEqual([unresolved('iterate over', '?[]u8')])
    expect(errs('let a = p + 1\np -= 1', 'p: ?[*]u8')).toEqual([unresolved("use '+' on", '?[*]u8'), unresolved("use '-=' on", '?[*]u8')])
    expect(errs('let a = &q[1]', 'q: ?*[3]i32')).toEqual([unresolved('index', '?*[3]i32')])
    expect(errs('let a = p.u32', 'p: ?*u8')).toEqual([unresolved('use .u32 on', '?*u8')])
    // Comparing one, with 0 too, and passing it on as an optional are fine.
    expect(errs('let a = p == 0 as ?*u8\nlet b: ?*u8 = p', 'p: ?*u8')).toEqual([])
  })

  test('a write needs an index known to be in range, whatever the element is', () => {
    expect(errs('ps[i] = q', 'i: u32, q: *i32')).toEqual([
      'writing to an element needs an index known to be in range: use a constant or ranged index, or if let on its address (&xs[i])',
    ])
    expect(errs('ps[i] = q\nps[1] = q\nif let p = &ps[j] { p.* = q }', 'i: u32#2, j: u32, q: *i32')).toEqual([])
    expect(errs('s[i] = t', 's: []mut []u8, i: u32, t: []u8')).toEqual([
      'writing to an element of a slice needs its index checked: use if let on its address (&s[i])',
    ])
    expect(errs('if let p = &s[i] { p.* = t }', 's: []mut []u8, i: u32, t: []u8')).toEqual([])
    // An element that has no optional type is written the same way: the
    // message is about the write, which no ?? can resolve.
    const slice = 'writing to an element of a slice needs its index checked: use if let on its address (&s[i])'
    expect(errs('s[0] = 1\ns[i] = 2\ns[i] += 3', 's: []mut u8, i: u32')).toEqual([slice, slice, slice])
    expect(errs('b[i] = 1\nb[i] |= 2', 'b: *mut [16]u8, i: u32')).toEqual([
      'writing to an element needs an index known to be in range: use a constant or ranged index, or if let on its address (&xs[i])',
      'writing to an element needs an index known to be in range: use a constant or ranged index, or if let on its address (&xs[i])',
    ])
    expect(errs('z[0] = 1', 'z: *mut [!]u8')).toEqual([
      'writing to an element of *mut [!]u8 needs its index checked: its length is only found at run time, by a scan',
    ])
    // A field of the element is written as the element is: once, as a write.
    expect(errs('s[i].x = 1\ns[0].y += 2\nm[i].x = 3', 's: []mut Pt, i: u32, m: *mut [4]Pt')).toEqual([
      slice, slice,
      'writing to an element needs an index known to be in range: use a constant or ranged index, or if let on its address (&xs[i])',
    ])
    // Only the element written to: the row it is in is read.
    expect(errs('m[i][0] = 1', 'm: *mut [2][3]u8, i: u32')).toEqual([
      "runtime index on *[2][3]u8 requires 'if let' or '??' (rows are not optional)",
    ])
    expect(errs('if let p = &s[i] { p.* = 1 }\nb[i & 15] = 1', 's: []mut u8, b: *mut [16]u8, i: u32')).toEqual([])
  })

  test("a slice's length is only known at run time: a constant index is not proven either", () => {
    const constant = (k: number, type: string, why: string) =>
      `index ${k} on ${type} requires 'if let' or '??': a slice's length is only known at run time (${why})`
    expect(errs('let a = s[0]', 's: []u8')).toEqual([constant(0, '[]u8', 'no optional type for u8')])
    expect(errs('let a = rows[1][0]', 'rows: [][2]i32')).toEqual([constant(1, '[][2]i32', 'rows are not optional')])
    expect(errs('s[0] = 1', 's: []mut u8')).toEqual(['writing to an element of a slice needs its index checked: use if let on its address (&s[i])'])
    expect(letType('names[0]')).toBe('?[]u8')
    expect(errs('let a = s[0] ?? 0\nif let b = s[2] { }\nlet c = s.ptr[0]', 's: []u8')).toEqual([])
  })

  test('a *[!]T is indexed like a slice, its length found by a scan; what has no length is not checked', () => {
    const scan = "its length is only found at run time, by a scan"
    expect(errs('let a = z[i]', 'z: *[!]i32, i: u32')).toEqual(["runtime index on *[!]i32 requires 'if let' or '??' (no optional type for i32)"])
    expect(errs('let a = z[1]', 'z: *[!]i32')).toEqual([`index 1 on *[!]i32 requires 'if let' or '??': ${scan} (no optional type for i32)`])
    expect(errs('let a = z[1] ?? 0\nlet n = z.len\nif let b = z[i] { }', 'z: *[!]i32, i: u32')).toEqual([])
    expect(errs('let r = m[0][1] ?? 0\nlet s = m[i]', 'm: *[2][!]u8, i: u32')).toEqual([
      "runtime index on *[2][!]u8 requires 'if let' or '??' (rows are not optional)",
    ])
    expect(errs('let n = s.len', 's: *[!]Pt')).toEqual([])
    expect(errs('let n = s.len', 's: *[!](i32, i32, i32)')).toEqual([
      'cannot find the length of *[!](i32, i32, i32): the scan for its zero end needs elements of 1, 2, 4 or 8 bytes',
    ])
    expect(errs('let a = p[0]\nlet n = p.len', 'p: *[?]u8')).toEqual([
      'indexing *[?]u8 is not supported yet: its length prefix is not read',
      '.len of *[?]u8 is not supported yet: its length prefix is not read',
    ])
    const nothing = (what: string, type: string) => `${what} has nothing to check here: ${type} has no length, so its index is never checked — index it directly`
    expect(errs('let a = mp[i] ?? 0\nif let b = mp[i] { }', 'mp: [*]i32, i: u32')).toEqual([nothing('??', '[*]i32'), nothing('if let', '[*]i32')])
    expect(errs('if let r = many[i] { }', 'many: [*][2]i32, i: u32')).toEqual([nothing('if let', '[*][2]i32')])
    // A many-pointer's element that is an optional is still checked.
    expect(errs('if let p = mp[i] { }', 'mp: [*]?*i32, i: u32')).toEqual([])
  })

  test('a *T is one T: an index past it is refused', () => {
    const past = (type: string, element: string) => `cannot index ${type} past its one element: read it with .*, or index a [*]${element}`
    expect(errs('let a = p[0]\nlet b = q[0]', 'p: *u8, q: *mut Pt')).toEqual([])
    expect(errs('let a = p[1]\nlet b = p[i]', 'p: *u8, i: u32')).toEqual([past('*u8', 'u8'), past('*u8', 'u8')])
    expect(errs('p[3] = 1', 'p: *mut u8')).toEqual([past('*mut u8', 'u8')])
    expect(errs('let a = p[i]\np[i] = 1', 'p: [*]mut u8, i: u32')).toEqual([])
  })

  test('the row index of a packed *[NxM]T is checked against N', () => {
    expect(errs('let a = packed[i][j]', 'i: u32#2, j: u32#3')).toEqual([])
    expect(errs('let a = packed[2][0]')).toEqual(['index 2 out of bounds for *[2x3]i32'])
    expect(errs('let a = packed[i][0]', 'i: u32')).toEqual([
      "runtime index on *[2x3]i32 requires 'if let' or '??' (rows are not optional)",
    ])
    expect(errs('let a = packed[i][0]', 'i: u32#3')).toEqual([
      'index type u32#3 may exceed *[2x3]i32 bounds (max index 2 >= 2) — narrow the index range to fit',
    ])
    expect(errs('if let r = packed[i] { let a = r[0] }\nlet b = (packed[i] ?? packed[0])[1]', 'i: u32')).toEqual([])
  })

  test('a range that may pass N proves nothing: the index is checked as one with no range', () => {
    // An element that can be none is an optional, as for a u32 index.
    expect(letType('ps[j]', 'j: u32#3')).toBe('?*i32')
    // One that can't is resolved where it is taken, if let and ?? checking it.
    expect(errs('let a = bytes[j] ?? 0\nif let b = bytes[j] { }\nif let r = packed[k] { }', 'j: u32#5, k: u32#3')).toEqual([])
    // Elsewhere the range was what was meant to prove it.
    expect(errs('let a = bytes[j]', 'j: u32#5')).toEqual([
      'index type u32#5 may exceed *[4]u8 bounds (max index 4 >= 4) — narrow the index range to fit',
    ])
  })
})

describe('arrays where a pointer is wanted', () => {
  const errs = (source: string) => checkModule(source).errors.map(e => e.message)
  const prelude = 'func sum(r: *[3]i32) -> i32 => r[0] + r[1] + r[2]\nfunc len(s: []i32) -> u32 => s.len\nfunc raw(p: [*]i32) -> i32 => p[0]\n'

  test('a value array has no address: it is no pointer, slice or many-pointer', () => {
    expect(errs(`${prelude}func f(v: [3]i32) -> i32 => sum(v) + len(v) as i32 + raw(v)`)).toEqual([
      'argument 1: cannot assign [3]i32 to *[3]i32',
      'argument 1: cannot assign [3]i32 to []i32',
      'argument 1: cannot assign [3]i32 to [*]i32',
    ])
    expect(errs(`${prelude}func f(x: i32) -> i32 {\n  let v: [3]i32 = [x, 2, 3]\n  return v.sum()\n}`)).toEqual([
      'sum takes *[3]i32 first; the receiver is a [3]i32, which is held in registers and has no address',
    ])
    // A literal is laid out in memory.
    expect(errs(`${prelude}func f() -> i32 => sum([1, 2, 3]) + len([1, 2]) as i32`)).toEqual([])
    // A [!]T is held as its pointer, but has no length to make a slice with
    // until it is scanned for: (v.ptr, v.len) is the slice (9.5).
    expect(errs('func n(s: []u8) -> u32 => s.len\nfunc f(v: [!]u8) -> u32 => n(v)\nfunc g(v: [!]u8) -> u32 {\n  let s: []u8 = v\n  return s.len\n}')).toEqual([
      'argument 1: cannot assign [!]u8 to []u8',
      'cannot assign [!]u8 to []u8',
    ])
    expect(errs('func m(p: [*]u8) -> u8 => p[1]\nfunc z(p: *[!]u8) -> u32 => p.len\nfunc f(v: [!]u8) -> u32 => m(v) as u32 + z(v)')).toEqual([])
    // Nor does a packed [NxM]T written without the *, which is held the same
    // way: the call passed its pointer alone, an invalid module.
    expect(errs('func n(s: []i32) -> u32 => s.len\nfunc f(v: [2x3]i32) -> u32 => n(v)')).toEqual([
      'argument 1: cannot assign [2x3]i32 to []i32',
    ])
  })

  test('the elements of a literal for a *[N]T are its elements, not arrays or strings', () => {
    expect(errs(`${prelude}func f() -> i32 => sum([[1, 2, 3], [4, 5, 6], [7, 8, 9]])`)).toEqual([
      'argument 1: cannot assign [3]i32 to i32', 'argument 1: cannot assign [3]i32 to i32', 'argument 1: cannot assign [3]i32 to i32',
    ])
    expect(errs(`${prelude}func f() -> i32 => sum(["ab", "c", "d"])`)).toEqual(Array(3).fill(
      'argument 1: cannot use a string literal among i32 elements — a string is bytes ([]u8); write the i32 elements as an array literal ([1, 2, 3])',
    ))
    // Among bytes a string is its bytes.
    expect(errs('func b(r: *[3]u8) -> u8 => r[0]\nfunc f() -> u8 => b(["ab", "c"])')).toEqual([])
    // So a table literal is no flat one, and picks the overload for a table.
    expect(errs('func total(m: *[2][3]i32) -> i32 => m[0][0]\nfunc total(r: *[3]i32) -> i32 => r[0]\nfunc f() -> i32 => total([[1, 2, 3], [4, 5, 6]]) + total([1, 2, 3])')).toEqual([])
  })
})

describe('struct elements of an array literal', () => {
  const check = (decl: string) =>
    checkModule(`
      type Mixed = (a: u64, b: u8, name: []u8)
      ${decl}
    `)

  test('a tuple element is checked field by field', () => {
    expect(check('data ok: *[2]Mixed = [(1, 2, "x"), Mixed(3, 4, "yz")]').errors).toEqual([])
    expect(check('data bad: *[1]Mixed = [(1.5, 2, "x")]').errors.map(e => e.message)).toEqual([
      'cannot assign float(1.5) to u64',
    ])
    expect(check('data bad: *[1]Mixed = [(1, 300, "x")]').errors.length).toBe(1)
    expect(check('func f(n: u8) { let l: *[1]Mixed = [(1, n, "x")] }').errors).toEqual([])
    expect(check('func f(n: u64) { let l: *[1]Mixed = [(1, n, "x")] }').errors.map(e => e.message)).toEqual([
      'cannot assign u64 to u8',
    ])
  })

  test('its literals take the types of their fields', () => {
    const result = check('func f(n: u8) { let l: *[1]Mixed = [(5, n, "x")] }')
    const five = [...result.exprTypes].find(([expr]) => expr.kind === 'LiteralExpr')
    expect(five && typeToString(five[1])).toBe('u64')
  })
})

describe('a literal for a mutable pointer or slice', () => {
  const errs = (source: string) => checkModule(source).errors.map(e => e.message)
  const constant = (literal: string, type: string) => `a literal is constant: write \`mut ${literal}\` for a ${type}`

  test('is written with mut, and the error shows it so', () => {
    expect(errs('data s: []mut i32 = [20, 8]')).toEqual([constant('[20, 8]', '[]mut i32')])
    expect(errs('data s: []mut i32 = mut [20, 8]')).toEqual([])
    expect(errs('data s: *mut [2]u8 = "ab"')).toEqual([constant('"ab"', '*mut [2]u8')])
    expect(errs('data s: *mut [3]u8 = mut "a\\n\\""')).toEqual([])
    expect(errs('data s: *mut [3]u8 = "a\\n\\""')).toEqual([constant('"a\\n\\""', '*mut [3]u8')])
    expect(errs('data s: []mut u16 = [0xff; 4]')).toEqual([constant('[0xff; 4]', '[]mut u16')])
    expect(errs('data s: []mut u8 = x"ff 00"')).toEqual([constant('x"ff00"', '[]mut u8')])
    // A long one is shown by its brackets.
    expect(errs('data s: []mut u16 = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000]')).toEqual([constant('[...]', '[]mut u16')])
  })

  test('mut covers what the literal lays out apart', () => {
    const source = 'type B = (bytes: []mut u8, n: u32)\n'
    expect(errs(`${source}data bs: *mut [2]B = mut [([0:u8; 2], 0), B("ab", 1)]`)).toEqual([])
    expect(errs('data ts: *mut [2][2]i32 = [mut [1, 2], [3, 4]]')).toEqual([constant('[mut [1, 2], [3, 4]]', '*mut [2][2]i32')])
    // A constructor's arguments are checked before the literal it is in
    // meets its type: the one keyword is the fix for both.
    expect(errs(`${source}data bs: *mut [2]B = [([0:u8; 2], 0), B("ab", 1)]`))
      .toEqual([`field bytes: ${constant('"ab"', '[]mut u8')}`, constant('[([0:u8; 2], 0), B("ab", 1)]', '*mut [2]B')])
    // In a value, a constructor's fields are what is checked.
    expect(errs(`${source}func f() -> u32 {\n  let a: [2]B = [B("cd", 1), B(mut "ef", 2)]\n  let t: (B, u32) = (B("gh", 1), 2)\n  return 0\n}`))
      .toEqual([`field bytes: ${constant('"cd"', '[]mut u8')}`, `field bytes: ${constant('"gh"', '[]mut u8')}`])
    expect(errs(`${source}data bs: *[2]B = [([0:u8; 2], 0), B("ab", 1)]`)).toEqual([`field bytes: ${constant('"ab"', '[]mut u8')}`, constant('[0:u8; 2]', '[]mut u8')])
    // Nothing else wrong with it, or the other error is the one.
    expect(errs('data s: []mut u32 = "abcd"')).toEqual([expect.stringContaining('cannot assign a string literal to []mut u32')])
  })

  test('the function meant is found as if the literal were mut, and an instance names it', () => {
    expect(errs('func fill(b: []mut u8) -> u32 => b.len\nfunc fill(n: u32) -> u32 => n\nfunc f() -> u32 => fill([0:u8; 4])'))
      .toEqual([`argument 1: ${constant('[0:u8; 4]', '[]mut u8')}`])
    expect(errs('func zeros(comptime T: type, n: T) -> u32 {\n  let b: []mut T = [n; 4]\n  return b.len\n}\nfunc f() -> u32 => zeros(u8, 1)'))
      .toEqual([`${constant('[n; 4]', '[]mut u8')}, in zeros(T = u8)`])
  })

  test('& before a literal is a writable cell of its own', () => {
    expect(errs('func f() -> u32 {\n  let n = &0:u32\n  n.* = 1\n  let p: *mut i32 = &5\n  return n.*\n}')).toEqual([])
    // Also an array laid out where a pointer to an array is wanted, as it
    // is without the & (at the merge of claude/dec-named, which lays it out
    // so, it asked for mut): what it lays out apart is writable too.
    const put = 'type Pt = (x: i32, y: i32)\nfunc put(p: *mut [2]i32) -> i32 => p[0]\nfunc pts(p: *mut [1]Pt) -> i32 => p[0].x\nfunc rows(p: *mut [1][]mut u8) -> u32 => p.len\n'
    expect(errs(`${put}func f() -> i32 => put(&[1, 2]) + put(&[3; 2]) + pts(&[(y: 5, x: 6)]) + rows(&[[1:u8, 2]]) as i32`)).toEqual([])
    expect(errs(`${put}func f() -> i32 => put([1, 2])`)).toEqual([`argument 1: ${constant('[1, 2]', '*mut [2]i32')}`])
  })
})

describe('what a literal error says, wherever the literal is', () => {
  const errs = (source: string) => checkModule(source).errors.map(e => e.message)
  const constant = (literal: string, type: string) => `a literal is constant: write \`mut ${literal}\` for a ${type}`
  const notAString = (quoted: string, type: string) =>
    `cannot assign '${quoted}' to ${type} — a single-quoted literal is codepoints, not a string: a string is written with double quotes ("${quoted}")`

  test('a data slice of a single-quoted literal is told to use double quotes', () => {
    expect(errs("data d: []u8 = 'hi'")).toEqual([notAString('hi', '[]u8')])
    expect(errs("data d: []u8 = ('hi')")).toEqual([notAString('hi', '[]u8')])
    expect(errs("data d: []u8 = 'hi':[]u8")).toEqual([notAString('hi', '[]u8')])
    // A (ptr, len) pair written as numbers is still one.
    expect(errs('data d: []u8 = (104, 105)')).toEqual(['data value must be a literal to lay out: a (ptr, len) pair is a slice already'])
  })

  test('the receiver of a method call is told to write mut in parentheses', () => {
    const source = 'func fill(s: []mut u8) -> u32 => s.len\n'
    expect(errs(`${source}func f() -> u32 => "ab".fill() + [1, 2].fill() + (mut "ok").fill()`))
      .toEqual(['receiver: a literal is constant: write `(mut "ab")` for a []mut u8', 'receiver: a literal is constant: write `(mut [1, 2])` for a []mut u8'])
    // which is how it parses: mut before "ab".fill() is told the same.
    const parsed = parse(`${source}func f() -> u32 => mut "ab".fill()`)
    expect(parsed.errors.map(e => e.shortMessage)).toEqual(['mut goes on the literal itself: write (mut "ab").fill()'])
    expect(parse('func f(x: u8) -> u8 => mut x').errors.map(e => e.shortMessage))
      .toEqual(['mut goes before a literal (an array, a string or a tuple), not before x'])
  })

  test('a template literal is shown as it is written', () => {
    expect(errs('func f(x: []u8) -> u32 {\n  let t: []mut []u8 = `a${x}b\\n`\n  return t.len\n}'))
      .toEqual([constant('`a${x}b\\n`', '[]mut []u8')])
    expect(errs('func f(x: []u8) -> u32 {\n  let t: []mut []u8 = mut `a${x}b`\n  return t.len\n}')).toEqual([])
  })

  test('an instance keeps the error a literal has of its own', () => {
    const source = 'func fill(s: []mut u8) -> u32 => s.len\nfunc greet(s: []u8) -> u32 => s.len\nfunc take(c: u8) -> u8 => c\nfunc first(p: *u8) -> u8 => p.*\n'
    expect(errs(`${source}func h(comptime T: type, x: T) -> u32 => fill("ab")\nfunc f() -> u32 => h(u8, 1)`))
      .toEqual([`argument 1: ${constant('"ab"', '[]mut u8')}, in h(T = u8)`])
    expect(errs(`${source}func h(comptime T: type, x: T) -> u32 => greet('hi') + take("a") + first('a')\nfunc f() -> u32 => h(u8, 1)`))
      .toEqual([
        `argument 1: ${notAString('hi', '[]u8')}, in h(T = u8)`,
        `argument 1: cannot assign *[1]u8 to u8 — a string is bytes in memory, not a character: a character is written in single quotes ('a'), in h(T = u8)`,
        `argument 1: cannot assign 'a' to *u8 — a single-quoted literal is codepoints, not a string: a string is written with double quotes ("a"), in h(T = u8)`,
      ])
    // What the type argument does not bring is still a requirement.
    expect(errs(`${source}func h(comptime T: type, x: T) -> u32 => greet(x)\nfunc f() -> u32 => h(u8, 1)`))
      .toEqual(["no function 'greet' accepts (u8), in h(T = u8)"])
  })

  test('the fallback of ?? is given for what the whole is given for', () => {
    const source = 'func first(s: []u8) -> u32 => s.len\n'
    // A const slice is wanted: "" needs no mut.
    expect(errs(`${source}func f(x: []mut u8, i: u32) -> u32 => first(x[i..] ?? "")`)).toEqual([])
    expect(errs(`${source}func f(t: [][]mut u8) -> u32 {\n  let s: []u8 = t[0] ?? "ab"\n  return first(s)\n}`)).toEqual([])
    // So for a parameter whose type is inferred from the argument.
    expect(errs('func count(comptime T: type, s: []T) -> u32 => s.len\nfunc f(x: []mut u8, i: u32) -> u32 => count(x[i..] ?? "")')).toEqual([])
    // A mutable one is: it does.
    expect(errs(`${source}func f(x: []mut u8, i: u32) -> u32 {\n  let s: []mut u8 = x[i..] ?? ""\n  return s.len\n}`)).toEqual([constant('""', '[]mut u8')])
    expect(errs('func fill(comptime T: type, s: []mut T) -> u32 => s.len\nfunc f(x: []mut u8, i: u32) -> u32 => fill(x[i..] ?? "")')).toEqual([`${constant('""', '[]mut u8')}`])
    expect(errs(`${source}func f(x: []mut u8, i: u32) -> u32 {\n  let s = x[i..] ?? ""\n  return s.len\n}`)).toEqual([constant('""', '[]mut u8')])
  })
})

describe('a string literal as a slice', () => {
  const errs = (source: string) => checkModule(`type Pt = (x: i32, y: i32)\n${source}`).errors.map(e => e.message)
  const assign = (to: string, element = to.replace(/^\??\[\](mut )?/, '')) =>
    `cannot assign a string literal to ${to} — a string is bytes ([]u8); write the ${element} elements as an array literal${/^[iuf]\d+$/.test(element) ? ' ([1, 2, 3])' : ''}`
  const among = (element: string) =>
    `cannot use a string literal among ${element} elements — a string is bytes ([]u8); write the ${element} elements as an array literal ([1, 2, 3])`

  test('is a slice of elements of one byte', () => {
    for (const type of ['[]u8', '?[]u8', '[]i8', '[]bool', '[]u8#128']) {
      expect(errs(`func f() -> u32 { let s: ${type} = "abc"\n return 1 }`)).toEqual([])
    }
    for (const type of ['[]mut u8', '?[]mut u8', '*mut [3]u8']) {
      expect(errs(`func f() -> u32 { let s: ${type} = mut "abc"\n return 1 }`)).toEqual([])
    }
    expect(errs('data names: [][]u8 = ["ab", "c"]\ndata rows: [][][]u8 = [["ab"], ["c", "d"]]\ndata joined: []u8 = ["ab", "c"]')).toEqual([])
  })

  test('is not a slice of anything wider: its bytes are not that many elements', () => {
    for (const type of ['[]u16', '[]u32', '[]mut u32', '?[]u32', '[]u64', '[]f32', '[]f64', '[]Pt', '[][]u8']) {
      expect(errs(`func f() -> u32 { let s: ${type} = "abcd"\n return 1 }`)).toEqual([assign(type)])
    }
  })

  test('wherever it meets the slice type', () => {
    const take = 'func take(xs: []u32) -> u32 => xs.len\n'
    expect(errs(`${take}func f() -> u32 => take("str")`)).toEqual([`argument 1: ${assign('[]u32')}`])
    expect(errs('func f() -> []u32 => "str"')).toEqual([assign('[]u32')])
    expect(errs('func f() -> []u32 { return "str" }')).toEqual([assign('[]u32')])
    expect(errs('func f(c: bool) -> []u16 => if c { "ab" } else { "abcd" }')).toEqual([assign('[]u16'), assign('[]u16')])
    expect(errs('func f(s: []u32) -> u32 { s = "str"\n return s.len }')).toEqual([assign('[]u32')])
    expect(errs('func f(s: []u32) -> u32 { let t: []u32 = s[0..1] ?? "str"\n return t.len }')).toEqual([assign('[]u32')])
    expect(errs('func f() -> u32 { let s = "str":[]u32\n return s.len }')).toEqual([assign('[]u32')])
    expect(errs('data d: []u32 = "str"')).toEqual([assign('[]u32')])
    expect(errs('global g: []u32 = "str"')).toEqual([assign('[]u32')])
    expect(errs('type R = (name: []u32, n: i32)\nfunc f() -> u32 { let r = R("str", 1)\n return r.n as u32 }')).toEqual([
      `field name: ${assign('[]u32')}`,
    ])
    expect(errs('type R = (name: []u32, n: i32)\ndata rs: []R = [("str", 1)]')).toEqual([assign('[]u32')])
  })

  test('nor one of the elements of a slice of anything wider', () => {
    expect(errs('data d: []i32 = [1, "ab"]')).toEqual([among('i32')])
    expect(errs('data d: []u32 = ["abc"; 2]')).toEqual([among('u32')])
    expect(errs('data d: []u32 = [[1, 2], ["abc"]]')).toEqual([among('u32')])
    expect(errs('data d: []u32 = [("abc")]')).toEqual([among('u32')])
    expect(errs('data d: [][]u16 = ["ab", [1, 2]]')).toEqual([assign('[]u16')])
    expect(errs('data d: [][]u32 = [["abc"], [1, 2]]')).toEqual([among('u32')])
    expect(errs('data d: *[2][]u32 = ["abc", "de"]')).toEqual([assign('[]u32'), assign('[]u32')])
    // A struct inside a nested literal is checked as any struct is.
    expect(errs('data d: []Pt = [[(1, 2)], [(3, 4)]]')).toEqual([])
    expect(errs('data d: []Pt = [[("abc", 1)]]')).toEqual(['cannot assign *[3]u8 to i32'])
  })

  test('behind a pointer there is no length to get wrong', () => {
    expect(errs('data a: *[2]u16 = "abcd"\ndata b: [*]u32 = "abcd"\ndata c: *[2x2]u8 = ["ab", "cd"]\ndata d: *[!]u8 = "abc"')).toEqual([])
  })

  test('the same bytes are rejected when they come from a variable', () => {
    expect(errs('data s = "str"\nfunc take(xs: []u32) -> u32 => xs.len\nfunc f() -> u32 => take(s)')).toEqual([
      'argument 1: cannot assign *[3]u8 to []u32',
    ])
  })
})

describe('the values in a literal that is laid out', () => {
  const errs = (source: string) => checkModule(`type Pt = (x: i32, y: i32)\n${source}`).errors.map(e => e.message)

  test('the value of a repeat literal meets the element type, as an element of an array literal does', () => {
    // These were laid out as they came: three bytes as three u32s, 300 as 44.
    expect(errs('data d: []u32 = [true; 3]')).toEqual(['cannot assign bool to u32'])
    expect(errs('data d: *[3]u32 = [1.5; 3]')).toEqual(['cannot assign float(1.5) to u32'])
    expect(errs('data d: []u8 = [300; 3]')).toEqual(['cannot assign int(300) to u8'])
    expect(errs('data d: []Pt = [5; 3]')).toEqual(['cannot assign int(5) to Pt'])
    expect(errs('func f() -> u32 { let d: []u32 = [true; 3]\n return d.len }')).toEqual(['cannot assign bool to u32'])
    expect(errs('type R = (v: []u32, n: i32)\ndata rs: []R = [([true; 3], 1)]')).toEqual(['cannot assign bool to u32'])
    expect(errs('data z: *mut [4]u8 = mut [0; 4]\ndata w: []f32 = [1; 2]\ndata t: []u32 = [7:u8; 3]\ndata b: []bool = [true; 2]\ndata p: []Pt = [(1, 2); 2]')).toEqual([])
  })

  test('a value known at run time widens to the element type or is an error', () => {
    const result = checkModule('func f(n: i32) -> i64 { let d: *[3]i64 = [n; 3]\n return d[2] }')
    expect(result.errors).toEqual([])
    const widened = [...result.coercions].find(([expr]) => expr.kind === 'IdentExpr' && expr.name === 'n')
    expect(widened && typeToString(widened[1])).toBe('i64')
    expect(errs('func take(s: []f64) -> u32 => s.len\nfunc f(n: i32) -> u32 => take([n; 3])')).toEqual([])
    expect(errs('func f(n: i32) -> u8 { let d: *[3]u8 = [n; 3]\n return d[2] }')).toEqual(['cannot assign i32 to u8'])
    expect(errs('func f(x: f64) -> u32 { let d: []i32 = [x; 3]\n return d.len }')).toEqual(['cannot assign f64 to i32'])
  })

  test('so do the elements of a literal inside another', () => {
    expect(errs('data d: [][]u32 = [[true, false], [3, 4]]')).toEqual(['cannot assign bool to u32', 'cannot assign bool to u32'])
    expect(errs('data d: [][]u32 = [[1.5, 2], [3, 4]]')).toEqual(['cannot assign float(1.5) to u32'])
    expect(errs('data d: *[2][2]u32 = [[1.5; 2], [3, 4]]')).toEqual(['cannot assign float(1.5) to u32'])
    expect(errs('data d: [][]u8 = [[300, 1], [3, 4]]')).toEqual(['cannot assign int(300) to u8'])
    expect(errs('data d: [][]u32 = [[1, 2], [3, 4]]\ndata e: *[2][2]u8 = [[1, 2], [3, 4]]')).toEqual([])
  })
})

describe('a slice from a pointer and a length', () => {
  test('is a value, not a literal for the data section', () => {
    const result = checkModule(`
      type Spot = (c: i32, di: i32)
      type Lane = (cells: []i32, at: Spot)
      global lanes: []Lane = (0, 0)
      global rows: [][]i32 = (0, 0)
      func f(p: [*]u8, q: [*][]i32, n: u32) -> u32 {
        let s: []u8 = (p, n)
        let all: [][]i32 = (q, n)
        return s.len + all.len
      }
    `)
    expect(result.errors).toEqual([])
    expect(result.literals).toEqual([])
  })

  test('its parts are a pointer to the elements and a length an i32 holds', () => {
    const errs = (body: string) =>
      checkModule(`func f(p: [*]i32, m: [*]mut i32, n: u32, w: u64, b: u8, i: i32) {\n${body}\n}`).errors.map(e => e.message)
    expect(errs('let s: []i32 = (p, n)\nlet t: []i32 = (m, b)\nlet u: []mut i32 = (m, i)\nlet z: []i32 = (0, 0)')).toEqual([])
    expect(errs('let s: []mut i32 = (p, n)')).toEqual(['slice pointer: cannot assign [*]i32 to [*]mut i32'])
    expect(errs('let s: []u8 = (p, n)')).toEqual(['slice pointer: cannot assign [*]i32 to [*]u8'])
    expect(errs('let s: []i32 = (n, n)')).toEqual(['slice pointer: cannot assign u32 to [*]i32'])
    expect(errs('let s: []i32 = (p, w)')).toEqual(['slice length: cannot assign u64 to u32'])
    expect(errs('let s: []i32 = (p, 2.5)')).toEqual(['slice length: cannot assign float(2.5) to u32'])
  })

  test('no other tuple is a slice, in a variable or in a global', () => {
    const errs = (source: string) => checkModule(source).errors.map(e => e.message)
    expect(errs('global g: []mut i32 = (0)')).toEqual(['cannot assign int(0) to []mut i32'])
    expect(errs('global g: []i32 = (1, 2, 3)')).toEqual(['cannot assign (int(1), int(2), int(3)) to []i32'])
    expect(errs('type R = (name: []u8, n: i32)\nglobal g: R = ((0), 1)')).toEqual(['cannot assign int(0) to []u8'])
    expect(errs('func f() { let s: []i32 = () }')).toEqual(['cannot assign () to []i32'])
    expect(errs('func f() { let s: []u8 = (len: 3) }')).toEqual(['[]u8 expects 2 fields, got 1: no value for ptr'])
    expect(errs('func take(s: []u8) {}\nfunc f() { take((1, 2, 3)) }')).toEqual([
      'argument 1: cannot assign (int(1), int(2), int(3)) to []u8',
    ])
  })

  test('is not the value of a data declaration: there is nothing to lay out', () => {
    // These built invalid wasm, or threw while the data section was laid out.
    const errs = (source: string) => checkModule(source).errors.map(e => e.message)
    const message = 'data value must be a literal to lay out: a (ptr, len) pair is a slice already'
    expect(errs('data s: []i32 = (64, 3)')).toEqual([message])
    expect(errs('data s = ((64, 3)):[]i32')).toEqual([message])
    expect(errs('type Bytes = []u8\ndata s: Bytes = (64, 3)')).toEqual([message])
    // A struct of two fields is a literal, and so is an array of pairs.
    expect(errs('type Point = (x: i32, y: i32)\ndata p: Point = (1, 2)\ndata q = (1, 2)\ndata lists: [][]i32 = [(64, 3)]')).toEqual([])
  })

  test('an element of an array of slices is checked as a slice too', () => {
    const errs = (source: string) => checkModule(source).errors.map(e => e.message)
    expect(errs('data lists: [][]i32 = [(64, 3), [1, 2], ((0, 0))]')).toEqual([])
    expect(errs('data lists: [][]i32 = [(1.5, 2.5)]')).toEqual([
      'slice pointer: cannot assign float(1.5) to [*]i32',
      'slice length: cannot assign float(2.5) to u32',
    ])
    expect(errs('data lists: [][]i32 = [(0, 3, 4)]')).toEqual(['cannot assign (int(0), int(3), int(4)) to []i32'])
    expect(errs('func f(n: u64) { let lists: [][]u8 = [("ab", n)] }')).toEqual(['slice length: cannot assign u64 to u32'])
  })

  test('(x) is x: a slice, a string, an array literal or a pair in parentheses is that slice', () => {
    const result = checkModule(`
      global g: []u8 = ("abc")
      func take(s: []u8) -> u32 => s.len
      func f(s: []u8, p: [*]u8) -> u32 {
        let a: []u8 = (s)
        let b: []i32 = ([1, 2, 3])
        let c: []u8 = ((p, 2))
        return take((s)) + take(("ab")) + a.len + b.len + c.len
      }
    `)
    expect(result.errors).toEqual([])
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

  test('a range from a shift takes the count as the shift does: modulo its width', () => {
    const index = (type: string, size: number, expr: string) => errs(`data t = [0:u8; ${size}]\nfunc f(x: ${type}) -> u8 => t[${expr}]`)
    const exceeds = (type: string, size: number, max: number) =>
      [`index type ${type}#${max} may exceed *[${size}]u8 bounds (max index ${max - 1} >= ${size}) — narrow the index range to fit`]
    // A 32-bit shift by 32 is a shift by 0, however the count is written.
    expect(index('u32', 16, 'x >> 32')).toEqual(exceeds('u32', 16, 4294967296))
    expect(index('u32', 16, 'x >> (16 + 16)')).toEqual(exceeds('u32', 16, 4294967296))
    expect(index('u32', 16, 'x >> 33')).toEqual(exceeds('u32', 16, 2147483648))
    expect(index('u32', 16, 'x >> 60')).toEqual([])
    expect(index('u32', 1, '(x & 63) >> 34')).toEqual(exceeds('u32', 1, 16))
    // A u8 or u16 is shifted as the i32 it's held in.
    expect(index('u8', 1, 'x >> 8')).toEqual([])
    expect(index('u8', 1, 'x >> 32')).toEqual(exceeds('u8', 1, 256))
    expect(index('u16', 1, 'x >> 16')).toEqual([])
    expect(index('u16', 1, 'x >> 32')).toEqual(exceeds('u16', 1, 65536))
    // A rotation keeps every bit: no range.
    const unproven = (size: number) => [`runtime index on *[${size}]u8 requires 'if let' or '??' (no optional type for u8)`]
    expect(index('u32', 16, 'x >>> 28')).toEqual(unproven(16))
    expect(index('u32', 16, 'x <<< 4')).toEqual(unproven(16))
    expect(index('u8', 1, 'x >>> 8')).toEqual(unproven(1))
    // 64 bits, and the wide integers, whose helpers take the count modulo their width.
    const ranged = (type: string, range: number, count: number) => errs(`func f(x: ${type}) { let i: ${type}#${range} = x >> ${count} }`)
    expect(ranged('u64', 16, 60)).toEqual([])
    expect(ranged('u64', 16, 124)).toEqual([])
    expect(ranged('u64', 1, 64)).toEqual(['cannot assign u64 to u64#1'])
    expect(ranged('u128', 16, 124)).toEqual([])
    expect(ranged('u128', 16, 252)).toEqual([])
    expect(ranged('u128', 1, 128)).toEqual(['cannot assign u128 to u128#1'])
    expect(ranged('u256', 1, 256)).toEqual(['cannot assign u256 to u256#1'])
  })

  test('a loop count is an integer of at most 32 bits', () => {
    const loop = (type: string) => errs(`func f(n: ${type}) -> u32 {\n  let t: u32 = 0\n  for i in n { t += i }\n  return t\n}`)
    for (const type of ['u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'u32#9']) expect(loop(type)).toEqual([])
    for (const type of ['i64', 'u64', 'u128', 'f32', 'f64', 'bool']) {
      expect(loop(type)).toEqual([`a loop count must be an integer of at most 32 bits, not ${type}`])
    }
  })

  test('a compound assignment keeps a range only where x = x op v would', () => {
    // x op= v is x = x op v: the result goes back into x, so it has to fit
    // x's range, or an index the range proved would pass the end.
    const body = (init: string, update: string, params = 'x: u32') =>
      errs(`data buf = mut [0:u8; 16]\nfunc f(${params}) {\n  let i = ${init}\n  ${update}\n  buf[i] = 1\n}`)
    const over = (result: string, range: string, op: string) => [`cannot assign ${result} to ${range} (the result of '${op}')`]
    expect(body('x & 15', 'i += 1')).toEqual(over('u32#17', 'u32#16', '+='))
    expect(body('x & 3', 'i <<= 3')).toEqual(over('u32', 'u32#4', '<<='))
    expect(body('x & 7', 'i *= 3')).toEqual(over('u32#22', 'u32#8', '*='))
    expect(body('x >> 28', 'i += 1')).toEqual(over('u32#17', 'u32#16', '+='))
    expect(body('x & 15', 'i -= 1')).toEqual(over('u32', 'u32#16', '-='))
    expect(body('x & 15', 'i += k', 'x: u32, k: u32#1')).toEqual(over('u32', 'u32#16', '+='))
    // As the plain assignment says.
    expect(body('x & 15', 'i = i + 1')).toEqual(['cannot assign u32#17 to u32#16'])
    // A result that stays in the range is fine.
    expect(body('x & 15', 'i &= 7\ni >>= 1\ni %= 9\ni += 0')).toEqual([])
    expect(body('x & 15', 'i *= 1\ni >>= 0')).toEqual([])
    // Through a parameter, a loop variable and an element of a ranged type.
    expect(errs('data buf = mut [0:u8; 16]\nfunc f(i: u32#16) {\n  i += 1\n  buf[i] = 1\n}')).toEqual(over('u32#17', 'u32#16', '+='))
    expect(errs('data buf = mut [0:u8; 16]\nfunc f() {\n  for i in 16 {\n    i += 1\n    buf[i] = 1\n  }\n}')).toEqual(over('u32#17', 'u32#16', '+='))
    expect(errs('data g = mut [0:u8#4; 4]\nfunc f(k: u32#4) {\n  g[k] += 1\n}')).toEqual(over('u8#5', 'u8#4', '+='))
    // Without a range nothing changes.
    expect(body('x', 'i += 1\ni <<= 3', 'x: u32').filter((e) => e.includes('the result'))).toEqual([])
  })

  test('a constant with a shift in it has the value the shift gives in its type', () => {
    const index = (expr: string) => errs(`data t = mut [0:u8; 16]\nfunc f(x: u32) -> u8 => t[${expr}]`)
    // 65535 >> 32 as a u32 is 65535, and 1 >> 32 is 1.
    expect(index('x & (65535 >> 32)')).toEqual(['index type u32#65536 may exceed *[16]u8 bounds (max index 65535 >= 16) — narrow the index range to fit'])
    expect(index('(x & 15) + (1 >> 32)')).toEqual(['index type u32#17 may exceed *[16]u8 bounds (max index 16 >= 16) — narrow the index range to fit'])
    expect(index('x % (4096 >> 40)')).toEqual([])
    expect(index('16 >> 32')).toEqual(['index 16 out of bounds for *[16]u8'])
    expect(index('60 >> 34')).toEqual([])
    expect(errs(`data t = mut [0:u8; 16]\nfunc f() -> ?*mut u8 => &t[16 >> 32]`)).toEqual(['index 16 out of bounds for *[16]u8'])
    expect(errs(`data t = mut [0:u8; 16]\nfunc f() { t[0..(64 >> 32)] = 1 }`)).toEqual(['range 0..64 is out of bounds for *[16]u8'])
    expect(errs(`data t = mut [0:u8; 16]\nfunc f() { memset(t, 1, 64 >> 32) }`)).toEqual(['memset length 64 exceeds buffer size 16 bytes'])
    expect(errs(`data t = mut [0:u8; 1]\nfunc f(x: u32) { if x < (16 >> 32) { t[x] = 1 } }`))
      .toEqual(['index type u32#16 may exceed *[1]u8 bounds (max index 15 >= 1) — narrow the index range to fit'])
  })

  test('a constant is divided and shifted right as its type holds its operands', () => {
    const index = (expr: string) => errs(`data t = mut [0:u8; 16]\nfunc f(x: u32) -> u8 => t[${expr}]`)
    const past = ['index 16 out of bounds for *[16]u8']
    // As a u32, 0 - 1 is 4294967295: that is what is divided, not -1.
    expect(index('(0 - 1) / 268435455')).toEqual(past)
    expect(index('(1 - 2) % 20 + 1')).toEqual(past)
    expect(index('(~0 >> 28) + 1')).toEqual(past)
    expect(index('~0 / 268435455')).toEqual(past)
    expect(index('(0 - 1) / 268435456')).toEqual([])
    expect(index('(0 - 1) % 16')).toEqual([])
    expect(index('~0 >> 28')).toEqual([])
    // A range comes from the same value.
    const over = ['index type u32#17 may exceed *[16]u8 bounds (max index 16 >= 16) — narrow the index range to fit']
    expect(index('x & ((0 - 1) / 268435455)')).toEqual(over)
    expect(index('x % ((0 - 1) / 268435455 + 1)')).toEqual(over)
    expect(index('x & (~0 >> 28)')).toEqual([])
    expect(errs(`data t = mut [0:u8; 16]\nfunc f(x: u32) { if x < (0 - 1) / 268435455 + 1 { t[x] = 1 } }`)).toEqual(over)
    expect(errs(`data t = mut [0:u8; 16]\nfunc f() { t[0..((0 - 1) / 268435455 + 1)] = 1 }`)).toEqual(['range 0..17 is out of bounds for *[16]u8'])
    expect(errs(`data t = mut [0:u8; 16]\nfunc f() { memset(t, 1, (1 - 2) / 4 + 16) }`)).toEqual(['memset length 1073741839 exceeds buffer size 16 bytes'])
    expect(errs(`data t = mut [0:u8; 16]\ndef k = (0 - 1) / 268435455\nfunc f() { t[k] = 1 }`)).toEqual(past)
    // In a narrower type too: as a u8, 0 - 1 is 255.
    expect(errs(`data t = mut [0:u8; 16]\nfunc f(b: u8) -> u8 => t[b & ((0 - 1) / 15)]`))
      .toEqual(['index type u8#18 may exceed *[16]u8 bounds (max index 17 >= 16) — narrow the index range to fit'])
    // A signed type holds -1 as it is: -64 / 4 + 17 is 1.
    expect(errs(`data t = mut [0:u8; 16]\nfunc f(x: i32) -> i32 { let i: i32 = (0 - 64) / 4 + 17\n return i }`)).toEqual([])
    expect(index('(0 - 64) / 4 + 17')).toEqual([])
  })

  test('a range bound or a length is the value its constant has in its type', () => {
    // ~4294967200 is 95 as a u32. As a bare number it is negative, which
    // passed for a bound or a length that fits anything.
    const past = ['range 0..95 is out of bounds for *[16]u8']
    expect(errs(`data t = mut [0:u8; 16]\nfunc f() { t[~4294967295..~4294967200] = 1 }`)).toEqual(past)
    expect(errs(`data t = mut [0:u8; 16]\nfunc f() { t[0..~4294967200] = 1 }`)).toEqual(past)
    expect(errs(`data t = mut [0:u8; 16]\nfunc f() -> []u8 => t[~4294967295..~4294967200]`)).toEqual(past)
    expect(errs(`data t = mut [0:u8; 16]\nfunc f() { t[~4294967295..~4294967279] = 1 }`)).toEqual([])
    expect(errs(`data t = mut [0:u8; 16]\nfunc f() { memset(t, 1, ~4294967200) }`)).toEqual(['memset length 95 exceeds buffer size 16 bytes'])
    expect(errs(`data t = mut [0:u8; 16]\nfunc f() { memset(t, 1, ~0) }`)).toEqual(['memset length 4294967295 exceeds buffer size 16 bytes'])
    expect(errs(`data t = mut [0:u8; 16]\ndata s = [0:u8; 128]\nfunc f() { memcpy(t, s, ~4294967200) }`)).toEqual(['memcpy length 95 exceeds buffer size 16 bytes'])
    expect(errs(`data t = mut [0:u8; 16]\nfunc f() { memset(t, 1, ~4294967279) }`)).toEqual([])
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

  test('(x) is x: a struct in parentheses meets a type as the struct does', () => {
    // One element, whatever the type inside has: this threw in the checker.
    expect(errs(`
      type Point = (x: i32, y: i32)
      type Wide = (a: i64, b: f32)
      type Seg = (a: Point, b: Point)
      data points: *[2]Point = [(Point(1, 2)), ((3, 4))]
      global g: Wide = ((1, 2))
      func mk(n: i32) -> Point { return (Point(n, 2)) }
      func sum(p: Point) -> i32 => p.x + p.y
      func f(c: bool, p: *mut Point) -> i32 {
        let a: Point = (Point(1, 2))
        let w: Wide = (((1, 2)))
        let s: Seg = ((Point(1, 2)), ((3, 4)))
        let b: Point = if c { (Point(1, 2)) } else { ((3, 4)) }
        let d = ((1, 2)):Point
        p.* = (Point(5, 6))
        return sum((Point(1, 2))) + sum(((3, 4)))
      }
    `)).toEqual([])
    // What is inside still has to be that type.
    expect(errs('type Point = (x: i32, y: i32)\nfunc f() { let p: Point = ((1, 2, 3)) }')).toEqual([
      'cannot assign (int(1), int(2), int(3)) to Point',
    ])
    expect(errs('type Point = (x: i32, y: i32)\ndata points: *[1]Point = [((1, 2.5))]')).toEqual([
      'cannot assign float(2.5) to i32',
    ])
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

  test('branches that are all constants default to a type that holds each of them', () => {
    // v is an i64, as its second branch is, whichever branch comes first.
    const narrowed = ['cannot assign i64 to i32']
    expect(errs(`func f(c: bool) -> i32 { let v = if c { -2147483648 } else { 2147483648 }\n return v }`)).toEqual(narrowed)
    expect(errs(`func f(c: bool) -> i32 { let v = if c { 2147483648 } else { -2147483648 }\n return v }`)).toEqual(narrowed)
    expect(errs(`func f(k: i32) -> i32 { let v = match k { 0 => -2147483648\n 1 => 5\n _ => 2147483648 }\n return v }`)).toEqual(narrowed)
    expect(errs(`func f(c: bool, d: bool) -> i32 { let v = if c { -2147483648 } else { if d { 1 } else { 1073741824 * 2 } }\n return v }`)).toEqual(narrowed)
    expect(errs(`func f(c: bool) -> i32 { let v = if c { -2147483648 } else { 2147483647 }\n return v }`)).toEqual([])
    // A 64-bit pattern is an i64, as it is by itself; more bits than that have no default.
    expect(errs(`func f(c: bool) -> i64 { let v = if c { 1 } else { 18446744073709551615 }\n return v }`)).toEqual([])
    expect(errs(`func f(c: bool) -> i64 { let v = if c { 1 } else { 18446744073709551616 }\n return v }`))
      .toEqual(['cannot assign int(18446744073709551616) to i64'])
    expect(errs(`func f() { let v = 18446744073709551616 }`)).toEqual(['cannot assign int(18446744073709551616) to i64'])
    expect(errs(`func f() { let v = -9223372036854775809 }`)).toEqual(['cannot assign int(-9223372036854775809) to i64'])
    expect(errs(`func f() { let v = 18446744073709551615 }`)).toEqual([])
    // As an f64, an integer branch has to be one exactly.
    expect(errs(`func f(c: bool) -> f64 { let v = if c { 1.5 } else { 3 }\n return v }`)).toEqual([])
    expect(errs(`func f(c: bool) -> f64 { let v = if c { 1.5 } else { 9007199254740993 }\n return v }`))
      .toEqual(['cannot assign int(9007199254740993) to f64'])
  })

  test('constant branches of both signs have to be values of the signed default', () => {
    // An i64 has the bits of 18446744073709551615, but they are its -1:
    // both branches came out the same, with nothing said.
    const past = ['cannot assign int(18446744073709551615) to i64']
    expect(errs(`func f(c: bool) -> i64 { let v = if c { -1 } else { 18446744073709551615 }\n return v }`)).toEqual(past)
    expect(errs(`func f(c: bool) -> i64 { let v = if c { 18446744073709551615 } else { -1 }\n return v }`)).toEqual(past)
    expect(errs(`func f(k: i32) -> i64 { let v = match k { 0 => -1\n 1 => 18446744073709551615\n _ => 0 }\n return v }`)).toEqual(past)
    expect(errs(`func f(c: bool, d: bool) -> i64 { let v = if c { if d { -1 } else { 5 } } else { 18446744073709551615 }\n return v }`)).toEqual(past)
    expect(errs(`func f(c: bool, d: bool) -> i64 { let v = if c { -1 } else { if d { 5 } else { 18446744073709551615 } }\n return v }`)).toEqual(past)
    expect(errs(`def k = 3\nfunc f(c: bool) -> i64 { let v = if c { 1 - k } else { 18446744073709551615 }\n return v }`)).toEqual(past)
    expect(errs(`func f(c: bool) -> i64 { let v = if c { -9223372036854775808 } else { 9223372036854775808 }\n return v }`))
      .toEqual(['cannot assign int(9223372036854775808) to i64'])
    expect(errs(`func f(c: bool) -> i32 => match (if c { -1 } else { 18446744073709551615 }) { -1 => 1\n _ => 2 }`)).toEqual(past)
    // Every value of an i64 is fine, and so are 64-bit patterns among themselves.
    expect(errs(`func f(c: bool) -> i64 { let v = if c { -9223372036854775808 } else { 9223372036854775807 }\n return v }`)).toEqual([])
    expect(errs(`func f(c: bool) -> i64 { let v = if c { 0x9E3779B97F4A7C15 } else { 0xcbf29ce484222325 }\n return v }`)).toEqual([])
    expect(errs(`func f(c: bool) -> i64 { let v = if c { -1 } else { ~0 }\n return v }`)).toEqual([])
    // A complement is a pattern itself, not a negative value.
    expect(errs(`func f(c: bool) -> i64 { let v = if c { ~0 } else { 0x8000000000000000 }\n return v }`)).toEqual([])
    expect(errs(`func f(c: bool) -> i64 { let v = if c { ~1 } else { 18446744073709551615 }\n return v }`)).toEqual([])
    // A type that holds them both can be given.
    expect(errs(`func f(c: bool) -> i128 { let v: i128 = if c { -1 } else { 18446744073709551615 }\n return v }`)).toEqual([])
  })

  test('each constant branch has to be a value of the type the expression is used as', () => {
    const negative = ['cannot assign int(-2147483648) to u32']
    expect(errs(`func f(c: bool, n: u32) -> u32 => n / (if c { -2147483648 } else { 2147483648 })`)).toEqual(negative)
    expect(errs(`func f(c: bool, n: u32) -> u32 => n / (if c { 2147483648 } else { -2147483648 })`)).toEqual(negative)
    expect(errs(`func f(k: i32, n: u32) -> u32 => n + match k { 0 => 5\n _ => -1 }`)).toEqual(['cannot assign int(-1) to u32'])
    expect(errs(`func f(c: bool, d: bool, n: u32) -> u32 => n + (if c { 1 } else { if d { 2 } else { -3 } })`)).toEqual(['cannot assign int(-3) to u32'])
    expect(errs(`func f(c: bool, n: i32) -> i32 => n + (if c { -2147483648 } else { 2147483648 })`)).toEqual(['cannot assign int(2147483648) to i32'])
    expect(errs(`func f(c: bool, n: i64) -> i64 => n + (if c { -2147483648 } else { 2147483648 })`)).toEqual([])
    // Not only literal by literal: a negation's operand is in range only once negated.
    expect(errs(`def k = 3\nfunc f(c: bool, n: u32) -> u32 => n / (if c { 5 } else { -k })`)).toEqual(['cannot assign int(-3) to u32'])
    expect(errs(`func f(c: bool, n: u8) -> u8 => n / (if c { 200 } else { -(100) })`)).toEqual(['cannot assign int(-100) to u8'])
    expect(errs(`func f(c: bool, n: i8) -> i8 => n / (if c { 100 } else { -(128) })`)).toEqual([])
    // A complement is a bit pattern of the type, as anywhere else.
    expect(errs(`func f(c: bool, n: u32) -> u32 => n & (if c { ~7 } else { 255 })`)).toEqual([])
  })

  test('the branches of an if let are checked against the type the value is used as', () => {
    // An i32 and a u32 have no type between them, but each widens to the i64 wanted.
    expect(errs(`func f(p: ?*u8, a: i32, b: u32) -> i64 => if let q = p { a } else { b }`)).toEqual([])
    expect(errs(`func f(p: ?*u8, a: i32, b: u32) -> i64 { let v: i64 = if let q = p { a } else { b }\n return v }`)).toEqual([])
    expect(errs(`func f(p: ?*u8, c: bool, a: i32, b: u32) -> i64 => if let q = p { q.* } elif c { a } else { b }`)).toEqual([])
    expect(errs(`func f(p: ?*u8) -> u8 => if let q = p { 1 } else { 300 }`)).toEqual(['cannot assign int(300) to u8'])
    expect(errs(`func f(p: ?*u8, x: f64) -> i64 => if let q = p { q.* } else { x }`)).toEqual(['cannot assign f64 to i64'])
    expect(errs(`func f(p: ?*u8, a: i32) -> i64 => if let q = p { a } else { }`)).toEqual(['this branch has no value: expected i64'])
    // The binding is the then branch's alone.
    expect(errs(`func f(p: ?*u8, b: u32) -> i64 => if let q = p { 1 } else { q.* }`)[0]).toContain("unknown identifier 'q'")
    // With no type wanted, the branches still have to agree between them.
    expect(errs(`func f(p: ?*u8, a: i32, b: u32) -> i64 { let v = if let q = p { a } else { b }\n return v }`))
      .toEqual(['branches have different types: u32 and i32 (cast one explicitly)'])
  })

  test('branches that are tuples with constants in them agree field by field', () => {
    // 0.2.1 built these; comparing the tuples whole, (0, 1) wasn't a (1, 0).
    expect(errs(`func f(d: i32) -> i32 { let (dx, dy) = match d { 0 => (1, 0)\n 1 => (0, 1)\n _ => (-1, -1) }\n return dx + dy }`)).toEqual([])
    expect(errs(`func f(c: bool) -> i32 { let t = if c { (1, 2) } else { (3, 4) }\n return t.1 }`)).toEqual([])
    expect(errs(`func f(c: bool, x: i32) -> i32 { let t = if c { (x, 2) } else { (3, 4) }\n return t.0 }`)).toEqual([])
    expect(errs(`func f(c: bool, x: i32) -> i32 { let t = if c { ((1, 2), x) } else { ((3, 4), 5) }\n return t.0.1 }`)).toEqual([])
    expect(errs(`func f(p: ?*u8) -> i32 { let (a, b) = if let q = p { (1, 2) } else { (3, 4) }\n return a + b }`)).toEqual([])
    // A field takes the type its values would as branches by themselves.
    const source = `func f(c: bool, x: i64) { let t = if c { (-2147483648, 1.5, 1) } else { (2147483648, 2, x) } }`
    const result = checkModule(source)
    expect(result.errors).toEqual([])
    expect(typeAt(result, source.indexOf('t ='))).toBe('(i64, f64, i64)')
    expect(errs(`func f(c: bool) -> i32 { let t = if c { (-2147483648, 1) } else { (2147483648, 2) }\n return t.0 }`)).toEqual(['cannot assign i64 to i32'])
    // Tuples that aren't alike still don't agree.
    expect(errs(`func f(c: bool) { let t = if c { (1, 2) } else { (3, 4, 5) } }`))
      .toEqual(['branches have different types: (int(3), int(4), int(5)) and (int(1), int(2)): give the value its type, as in let v: T = ..., and each branch is checked against T'])
    expect(errs(`func f(c: bool) { let t = if c { (x: 1, y: 2) } else { (y: 3, x: 4) } }`))
      .toEqual(['branches have different types: (y: int(3), x: int(4)) and (x: int(1), y: int(2)): give the value its type, as in let v: T = ..., and each branch is checked against T'])
    expect(errs(`func f(c: bool, x: f64) { let t = if c { (x, 2) } else { (3, true) } }`))
      .toEqual(['branches have different types: (f64, int(2)) and (f64, bool): give the value its type, as in let v: T = ..., and each branch is checked against T'])
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

  test('tuples in an untyped array literal settle on one type as branches do', () => {
    // 445731f took the first element's type and laid the others over it as
    // they came: (3, 4, 5) went into two (i32, i32) slots, (x: 3, y: 4)
    // after a (y:, x:) had an x of 4, and 300 sat in a u8.
    const source = `
      func f(n: i64) {
        let wide = [(x: 1:u8, y: 2), (x: 300, y: 4)]
        let big = [(1, 2), (3, 5000000000)]
        let mixed = [(1, n), (2, 3)]
        let turned = [(y: 1, x: 2), (x: 3, y: 4)]
      }
    `
    const result = checkModule(source)
    expect(result.errors).toEqual([])
    const type = (name: string) => typeAt(result, source.indexOf(`let ${name} =`) + 4)
    expect(type('wide')).toBe('[2](x: i32, y: i32)')
    expect(type('big')).toBe('[2](i32, i64)')
    expect(type('mixed')).toBe('[2](i32, i64)')
    // Tuples that don't agree are of the first one's type, which each of
    // the others meets as it would any struct.
    expect(type('turned')).toBe('[2](y: i32, x: i32)')
    expect(errs(`func f() { let r = [(1, 2), (3, 4, 5)] }`)).toEqual(['cannot assign (int(3), int(4), int(5)) to (i32, i32)'])
    expect(errs(`func f() { let r = [(y: 1, x: 2), (a: 3, b: 4)] }`)).toEqual([
      "field 'a' not found in (y: i32, x: i32), whose fields are y and x",
      "field 'b' not found in (y: i32, x: i32), whose fields are y and x",
    ])
    expect(errs(`func f() { let r = [(1, 2), (x: 3, y: 4)] }`)).toEqual([
      "field 'x' not found in (i32, i32), whose fields have no names: give the values by position",
      "field 'y' not found in (i32, i32), whose fields have no names: give the values by position",
    ])
    expect(errs(`type Pt = (x: i32, y: i32)\ntype Rv = (y: i32, x: i32)\nfunc f(p: Pt, q: Rv) { let r = [p, q] }`)).toEqual([
      "cannot assign Rv to Pt: its fields have the names of Pt's in another order, and only a literal gives fields by name; give the value the type Pt where it is made",
    ])
    // Strings of other lengths still go together, as they did, and are
    // slices, as they are in an array by themselves: each keeps its length
    // (at the merge of claude/dec-named "bc" met a *[1]u8 and was refused;
    // on either branch alone it was laid over one and read as "b").
    expect(errs(`func f() -> i32 { let r = [("a", 1), ("bc", 2)]\n return r[1].1 }`)).toEqual([])
    const strings = `
      func f(x: []u8) {
        let plain = [("a", 1), ("bc", 2)]
        let named = [(n: 1, s: "a"), (s: "bc", n: 2)]
        let both = [("a", "xy"), ("bc", "z")]
        let same = [("a", 1), ("b", 2)]
        let held = [(mut "a", 1), (mut "bc", 2)]
      }
    `
    const settled = checkModule(strings)
    expect(settled.errors).toEqual([])
    const typeOf = (name: string) => typeAt(settled, strings.indexOf(`let ${name} =`) + 4)
    expect(typeOf('plain')).toBe('[2]([]u8, i32)')
    expect(typeOf('named')).toBe('[2](n: i32, s: []u8)')
    expect(typeOf('both')).toBe('[2]([]u8, []u8)')
    expect(typeOf('same')).toBe('[2](*[1]u8, i32)')
    expect(typeOf('held')).toBe('[2]([]mut u8, i32)')
    // With its type given, each element is checked against it, by name where it has names.
    expect(errs(`type Pt = (x: i32, y: i32)\nfunc f() -> i32 { let r: [2]Pt = [(y: 1, x: 2), (x: 3, y: 4)]\n return r[1].x }`)).toEqual([])
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

  test('an expression body fills several named results in order, like a trailing value', () => {
    const pair = 'func pair(n: u32) -> (u32, u32) => (n / 10, n % 10)\n'
    expect(errs(`${pair}func f(n: u32) -> (q: u32, r: u32) => pair(n)`)).toEqual([])
    expect(errs(`${pair}func f(n: u32) -> (q: u32, r: u32) { pair(n) }`)).toEqual([])
    // Whatever the value's own fields are called.
    expect(errs(`func other(n: u32) -> (r: u32, x: u32) => (n, n)\nfunc f(n: u32) -> (q: u32, r: u32) => other(n)`)).toEqual([])
    expect(errs(`func f(t: (u32, u32)) -> (q: u32, r: u32) => t`)).toEqual([])
    expect(errs(`${pair}func f(n: u32, c: bool) -> (q: u32, r: u32) => if c { pair(n) } else { (0, 0) }`)).toEqual([])
    expect(errs(`${pair}func f(n: u32, k: i32) -> (q: u32, r: u32) => match k { 0 => pair(n)\n _ => (n, 1) }`)).toEqual([])
    // Each still has to fit the result it fills, and there have to be as many.
    expect(errs(`${pair}func f(n: u32) -> (q: u64, r: u64) => pair(n)`))
      .toEqual(['cannot convert (u32, u32) to (u64, u64) implicitly: convert its fields'])
    expect(errs(`${pair}func f(n: u32) -> (q: u16, r: u16) => pair(n)`)).toEqual(['cannot assign (u32, u32) to (u16, u16)'])
    expect(errs(`${pair}func f(n: u32) -> (q: u32, r: u32, s: u32) => pair(n)`)).toEqual(['cannot assign (u32, u32) to (q: u32, r: u32, s: u32)'])
    // Elsewhere a tuple's field names count.
    expect(errs(`${pair}func f(n: u32) { let t: (q: u32, r: u32) = pair(n) }`)).toEqual(['cannot assign (u32, u32) to (q: u32, r: u32)'])
  })

  test('a tuple value in parentheses is checked as it is without them', () => {
    // (e) is e. Taken for a tuple literal of one field, a call in
    // parentheses made the checker throw.
    const pair = 'func pair(n: u32) -> (u32, u32) => (n / 10, n % 10)\n'
    expect(errs(`${pair}func f(n: u32) -> (u32, u32) => (pair(n))`)).toEqual([])
    expect(errs(`${pair}func f(n: u32) -> (q: u32, r: u32) => ((pair(n)))`)).toEqual([])
    expect(errs(`${pair}func f(n: u32) -> u32 { let t: (u32, u32) = (pair(n))\n return t.0 }`)).toEqual([])
    expect(errs(`func f(t: (u32, u32)) -> (u32, u32) { return (t) }`)).toEqual([])
    expect(errs(`${pair}func f(n: u32, c: bool) -> (u32, u32) => (if c { pair(n) } else { (1, 2) })`)).toEqual([])
    // A literal in parentheses still takes the expected type field by field.
    expect(errs(`func f(n: u8) -> (i64, u32) => ((n, 300))`)).toEqual([])
    expect(errs(`func f(n: u8) -> (i64, u8) => ((n, 300))`)).toEqual(['cannot assign int(300) to u8'])
    // And the same errors are reported as without the parentheses.
    expect(errs(`${pair}func f(n: u32) { let t: (q: u32, r: u32) = (pair(n)) }`)).toEqual(['cannot assign (u32, u32) to (q: u32, r: u32)'])
    expect(errs(`${pair}func f(n: u32) -> (u64, u64) => (pair(n))`))
      .toEqual(['cannot convert (u32, u32) to (u64, u64) implicitly: convert its fields'])
    expect(errs(`${pair}func f(n: u32) -> (q: u64, r: u64) { (pair(n)) }`))
      .toEqual(['cannot convert (u32, u32) to (u64, u64) implicitly: convert its fields'])
  })

  test('a match pattern has to be a value of the subject\'s type', () => {
    expect(errs(`func f(x: i64) -> i32 => match x { 5000000000 => 1\n _ => 0 }`)).toEqual([])
    expect(errs(`func f(x: f64) -> i32 => match x { 1 => 1\n 2.5 => 2\n _ => 0 }`)).toEqual([])
    expect(errs(`func f(x: u8) -> i32 => match x { 300 => 1\n _ => 0 }`)).toEqual(['cannot match u8 against int(300)'])
    expect(errs(`func f(x: i32) -> i32 => match x { true => 1\n _ => 0 }`)).toEqual(['cannot match i32 against bool'])
    expect(errs(`func f(x: i32) -> i32 => match x { 1.5 => 1\n _ => 0 }`)).toEqual(['cannot match i32 against float(1.5)'])
  })

  test('a constant match subject is compared in its default type', () => {
    expect(errs(`func f() -> i32 => match 1 { 1 => 2\n _ => 3 }`)).toEqual([])
    expect(errs(`def k = 1\nfunc f() -> i32 => match k { 1 => 2\n _ => 3 }`)).toEqual([])
    expect(errs(`func f(a: [3]u8) -> i32 => match a.len { 3 => 2\n _ => 3 }`)).toEqual([])
    expect(errs(`func f() -> i32 => match 5000000000 { 5000000000 => 2\n 1 => 1\n _ => 3 }`)).toEqual([])
    expect(errs(`func f() -> i32 => match 0.5 { 0.5 => 2\n 1 => 1\n _ => 3 }`)).toEqual([])
    expect(errs(`func f(c: bool) -> i32 => match if c { 1 } else { 2 } { 1 => 2\n _ => 3 }`)).toEqual([])
    expect(errs(`func f() -> i32 => match 1 { 5000000000 => 2\n _ => 3 }`)).toEqual(['cannot match i32 against int(5000000000)'])
    expect(errs(`func f() -> i32 => match 1 { 1.5 => 2\n _ => 3 }`)).toEqual(['cannot match i32 against float(1.5)'])
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
    expect(result.errors.map(e => e.message)).toContain('Point expects 2 fields, got 1: no value for y')
  })

  test('an unknown field name is an error', () => {
    const result = checkModule(`
      type Point = (x: i32, y: i32)
      func f() -> Point => Point(x: 1, z: 2)
    `)
    expect(result.errors.map(e => e.message)).toContain("field 'z' not found in Point, whose fields are x and y")
  })
})

// The name after a dot is a whole identifier, hyphens included, as it is
// everywhere else (reference 1.2, 4.6).
describe('members whose name holds a hyphen', () => {
  const errs = (source: string) => checkModule(source).errors.map(e => e.message)

  test('a field named like a type pun and a hyphen is reached as a member', () => {
    const src = `
      type S = (u32-count: u32, bool-ish: bool)
      func f(x: S, p: *S) -> u32 => if x.bool-ish { x.u32-count } else { p.u32-count }
    `
    const result = checkModule(src)
    expect(result.errors.map(e => e.message)).toEqual([])
    const at = src.indexOf('x.u32-count')
    const member = [...result.exprTypes].find(([e]) => e.kind === 'MemberExpr' && e.span.start === at)
    expect(member && typeToString(member[1])).toBe('u32')
  })

  test('a member that is not there, where a subtraction was likely meant, says how to write one', () => {
    expect(errs(`func f(p: *u8) {
  let q = p.u32-1
}`)).toEqual(["no field 'u32-1' on type *u8: for a subtraction write `p.u32 - 1`"])
    expect(errs(`func f(s: []u8) {
  let n = s.len-1
}`)).toEqual(["no field 'len-1' on type []u8: for a subtraction write `s.len - 1`"])
    // The longest part before a hyphen that is a member is the one meant.
    expect(errs(`type S = (a: u32, a-b: u32)
func f(x: S) {
  let n = x.a-b-c
}`))
      .toEqual(["no field 'a-b-c' on type S: for a subtraction write `x.a-b - c`"])
    // Nothing before a hyphen is a member: nothing to suggest.
    expect(errs(`type S = (a: u32)
func f(x: S) {
  let n = x.zz-1
}`)).toEqual(["no field 'zz-1' on type S"])
    // An assignment to one is the same mistake.
    expect(errs(`func f(p: *mut u8) { p.u32-1 = 3 }`)).toEqual(["no field 'u32-1' on type *mut u8: for a subtraction write `p.u32 - 1`"])
  })

  test('the hint writes out what the member is of, however that is written', () => {
    const src = `type Pt = (x: u32, y: u32)
func get(p: Pt) -> Pt => p
func f(p: Pt, ps: []Pt, q: *Pt, t: (Pt, u8)) -> u32 => get(p).y-2 + ps[0].x-1 + q.*.x-1 + (p).y-1 + t.0.x-1
`
    const hints = (messages: string[]) => messages.filter((m) => m.startsWith('no field'))
    const expected = [
      "no field 'y-2' on type Pt: for a subtraction write `get(p).y - 2`",
      "no field 'x-1' on type Pt: for a subtraction write `ps[0].x - 1`",
      "no field 'x-1' on type Pt: for a subtraction write `q.*.x - 1`",
      "no field 'y-1' on type Pt: for a subtraction write `(p).y - 1`",
      "no field 'x-1' on type Pt: for a subtraction write `t.0.x - 1`",
    ]
    // As the command line checks a program: from its files, with their text.
    const path = '/virtual/hint.ents'
    const program = typecheckProgram(new Map([[path, { module: parse(src).module!, source: src }]]), path)
    expect(hints(program.errors.map((e) => e.message))).toEqual(expected)
    // And from the syntax tree alone.
    expect(hints(checkModule(src).errors.map((e) => e.message))).toEqual(expected)
    // What cannot be written out from the tree is left out of the hint.
    expect(hints(checkModule(`type Pt = (x: u32, y: u32)
func f(c: bool, p: Pt) -> u32 => (if c { p } else { p }).x-1
`).errors.map((e) => e.message))).toEqual(["no field 'x-1' on type Pt: for a subtraction write the - with spaces, as in `x - 1`"])
  })
})

// A struct, a tuple, a slice and an array have no operators: the types a
// generic's type argument can be and its body cannot assume operators for.
describe('operands of operators', () => {
  const errs = (source: string) => checkModule(source).errors.map(e => e.message)
  // The checker's wording (noOperator), written once
  const noOperator = (op: string, left: string, right = left) => `'${op}' cannot be applied to ${left} and ${right}`

  test('a struct has no comparison and no arithmetic', () => {
    expect(errs(`
      type Pt = (q: i32, r: i32)
      func a(p: Pt, q: Pt) -> bool => p > q
      func b(p: Pt, q: Pt) -> bool => p == q
      func c(p: Pt, q: Pt) -> Pt => p + q
    `)).toEqual([noOperator('>', 'Pt'), noOperator('==', 'Pt'), noOperator('+', 'Pt')])
  })

  test('a slice, a tuple and an array have none either', () => {
    expect(errs(`
      func a(x: []u8, y: []u8) -> bool => x == y
      func b(x: (i32, i32), y: (i32, i32)) -> bool => x != y
      func c(x: [4]u8, y: [4]u8) -> bool => x < y
      func d(x: []u8) -> bool => x == 0
    `)).toEqual([
      noOperator('==', '[]u8'),
      noOperator('!=', '(i32, i32)'),
      noOperator('<', '[4]u8'),
      noOperator('==', '[]u8', 'int(0)'),
    ])
  })

  test('what has no value has no operators', () => {
    expect(errs(`
      func nothing() { }
      func a() -> bool => nothing() == nothing()
      func b(x: u32) -> u32 => x + nothing()
    `)).toEqual([noOperator('==', '()'), noOperator('+', 'u32', '()')])
  })

  test('the error is the only one: a comparison is still a bool', () => {
    expect(errs(`
      type Pt = (q: i32, r: i32)
      func f(p: Pt, q: Pt) -> u32 {
        if p > q { return 1 }
        let same: bool = p == q
        return 0
      }
    `)).toEqual([noOperator('>', 'Pt'), noOperator('==', 'Pt')])
  })

  test('a unary operator and a compound assignment have no struct or slice operand either', () => {
    expect(errs(`
      type Pt = (q: i32, r: i32)
      func a(p: Pt) -> Pt => -p
      func b(p: Pt) -> Pt => ~p
      func c(p: Pt) -> bool => !p
      func d(xs: []u8) -> []u8 => -xs
      func e(p: Pt, q: Pt) {
        let t = p
        t += q
      }
      func f(xs: []u8, n: u32) {
        let t = xs
        t += n
        t <<= 1
      }
    `)).toEqual([
      "'-' needs a number, not Pt",
      "'~' needs an integer, not Pt",
      "operand of '!' must be bool, not Pt",
      "'-' needs a number, not []u8",
      noOperator('+=', 'Pt'),
      noOperator('+=', '[]u8', 'u32'),
      noOperator('<<=', '[]u8', 'int(1)'),
    ])
  })

  test('function values can be told apart', () => {
    // f == g compiled to one i32.eq on 0.2.1, and still does.
    expect(errs(`
      func same(f: (i32) -> i32, g: (i32) -> i32) -> bool => f == g
      func differ(f: (i32) -> i32, g: (i32) -> i32) -> bool => f != g
    `)).toEqual([])
  })

  test('numbers, bools and pointers keep their operators', () => {
    expect(errs(`
      type Pt = (q: i32, r: i32)
      func a(x: u32, y: u8) -> bool => x > y
      func b(x: bool, y: bool) -> bool => x == y
      func c(p: *Pt, q: *Pt) -> bool => p == q
      func d(p: ?*Pt) -> bool => p != 0
      func e(p: Pt, q: Pt) -> bool => p.q == q.q && p.r < q.r
      func f(xs: []u8, ys: []u8) -> bool => xs.len == ys.len || xs.ptr == ys.ptr
    `)).toEqual([])
  })
})

describe('builtins', () => {
  const errs = (src: string) => checkModule(src).errors.map(e => e.message)
  // The type the builtin call `call` computes in, and the type it returns.
  const types = (params: string, call: string) => {
    const src = `func f(${params}) { let r = ${call} }`
    const result = checkModule(src)
    expect(result.errors.map(e => e.message)).toEqual([])
    return [typeAt(result, src.indexOf(call), 'BuiltinCall'), typeAt(result, src.indexOf('r ='))]
  }

  test('a literal takes the type of the other operand, in either position', () => {
    expect(types('x: f64', 'max(1.0, x)')).toEqual(['f64', 'f64'])
    expect(types('x: f64', 'max(x, 1.0)')).toEqual(['f64', 'f64'])
    expect(types('x: f32', 'min(0.5, x)')).toEqual(['f32', 'f32'])
    expect(types('x: i64', 'max(0, x)')).toEqual(['i64', 'i64'])
    expect(types('x: u8', 'min(200, x)')).toEqual(['u8', 'u8'])
    expect(types('x: f32', 'copysign(1.0, x)')).toEqual(['f32', 'f32'])
  })

  test('a literal that does not fit the other operand is an error in either position', () => {
    expect(errs(`func f(x: u8) -> u8 => max(x, 300)`)).toEqual(['max: cannot assign int(300) to u8'])
    expect(errs(`func f(x: u8) -> u8 => max(300, x)`)).toEqual(['max: cannot assign int(300) to u8'])
    expect(errs(`func f(x: i32) -> i32 => min(1.5, x)`)).toEqual(['min: cannot assign float(1.5) to i32'])
  })

  test('with only literals the operands take their default type', () => {
    expect(types('', 'sqrt(2.0)')).toEqual(['f64', 'f64'])
    expect(types('', 'nearest(2.5)')).toEqual(['f64', 'f64'])
    expect(types('', 'min(3.0, 5.0)')).toEqual(['f64', 'f64'])
    expect(types('', 'copysign(5.0, -1.0)')).toEqual(['f64', 'f64'])
    expect(types('', 'abs(-5.5)')).toEqual(['f64', 'f64'])
    expect(types('', 'abs(-5)')).toEqual(['i32', 'i32'])
    expect(types('', 'max(1, 2)')).toEqual(['i32', 'i32'])
    expect(types('', 'max(1, 5000000000)')).toEqual(['i64', 'i64'])
  })

  test('with only literals the default type is the one the options give', () => {
    const typed = (call: string, options: { defaultInt?: 'i32' | 'i64'; defaultFloat?: 'f32' | 'f64' }) => {
      const src = `func f() { let r = ${call} }`
      const result = typecheck(parse(src).module!, options)
      expect(result.errors.map(e => e.message)).toEqual([])
      return typeAt(result, src.indexOf(call), 'BuiltinCall')
    }
    expect(typed('sqrt(2.0)', { defaultFloat: 'f32' })).toBe('f32')
    expect(typed('copysign(5.0, -1.0)', { defaultFloat: 'f32' })).toBe('f32')
    expect(typed('max(1, 2.5)', { defaultFloat: 'f32' })).toBe('f32')
    expect(typed('max(1, 2)', { defaultInt: 'i64' })).toBe('i64')
    expect(typed('abs(-5)', { defaultInt: 'i64', defaultFloat: 'f32' })).toBe('i64')
    expect(typed('max(1, 2)', { defaultFloat: 'f32' })).toBe('i32')
    // Too big for an i32, they are an i64 whichever is the default.
    expect(typed('max(1, 5000000000)', { defaultInt: 'i32' })).toBe('i64')
    // The result is of that type too: an f32 where an f32 is wanted.
    const result = typecheck(parse('func f() -> f32 => sqrt(2.0)').module!, { defaultFloat: 'f32' })
    expect(result.errors.map(e => e.message)).toEqual([])
    expect(errs('func f() -> f32 => sqrt(2.0)')).toEqual(['cannot assign f64 to f32'])
  })

  test('typed operands meet at the wider type', () => {
    expect(types('a: i32, b: i64', 'max(a, b)')).toEqual(['i64', 'i64'])
    expect(types('a: i64, b: i32', 'max(a, b)')).toEqual(['i64', 'i64'])
    expect(types('a: u8, b: u16', 'min(a, b)')).toEqual(['u16', 'u16'])
    expect(types('a: f32, b: f64', 'min(a, b)')).toEqual(['f64', 'f64'])
    expect(types('a: f32, b: f64', 'copysign(a, b)')).toEqual(['f64', 'f64'])
    expect(types('a: i128, b: i64', 'min(a, b)')).toEqual(['i128', 'i128'])
  })

  test('a narrower operand is marked for widening, as the operand of an operator is', () => {
    const widened = (src: string) => [...checkModule(src).coercions].map(([expr, type]) => [expr.kind === 'IdentExpr' ? expr.name : expr.kind, typeToString(type)])
    expect(widened(`func f(a: i32, b: i64) -> i64 => max(a, b)`)).toEqual([['a', 'i64']])
    expect(widened(`func f(a: f32, b: f64) -> f64 => copysign(a, b)`)).toEqual([['a', 'f64']])
    expect(widened(`func f(a: u32, b: u8) -> u64 => mul_hi(a, b)`)).toEqual([['a', 'u64'], ['b', 'u64']])
    expect(widened(`func f(a: i64, b: i64) -> i64 => max(a, b)`)).toEqual([])
    // An if with a type of its own is widened as a whole.
    expect(widened(`func f(x: i64, a: i32, c: bool) -> i64 => max(x, if c { a } else { 5 })`)).toEqual([['IfExpr', 'i64']])
    // So is a constant that is not a literal: the length of an array is an i32.
    expect(widened(`func f(x: i64, p: *[4]i32) -> i64 => max(x, p.len)`)).toEqual([['MemberExpr', 'i64']])
  })

  test('operands that share no type are an error', () => {
    expect(errs(`func f(a: u32, b: i32) -> u32 => max(a, b)`)).toEqual(['max: cannot assign i32 to u32'])
    expect(errs(`func f(a: i32, b: u32) -> i32 => max(a, b)`)).toEqual(['max: cannot assign u32 to i32'])
    expect(errs(`func f(a: f32, b: i64) -> f32 => min(a, b)`)).toEqual(['min: cannot assign i64 to f32'])
  })

  test('each builtin takes only its own kind of operand', () => {
    expect(errs(`func f(x: i32) -> f64 => sqrt(x)`)).toContain('sqrt requires a float type, got i32')
    expect(errs(`func f(x: f64, n: i32) -> f64 => copysign(x, n)`)).toContain('copysign requires a float type, got i32')
    expect(errs(`func f(x: bool) -> bool => max(x, x)`)).toContain('max requires a numeric type, got bool')
    expect(errs(`func f(p: *u8) -> *u8 => abs(p)`)).toContain('abs requires a numeric type, got *u8')
  })

  test('clz, ctz and popcnt return u8', () => {
    expect(types('x: u32', 'clz(x)')).toEqual(['u32', 'u8'])
    expect(types('x: i64', 'ctz(x)')).toEqual(['i64', 'u8'])
    expect(types('x: u64', 'popcnt(x)')).toEqual(['u64', 'u8'])
    expect(types('', 'clz(1)')).toEqual(['i32', 'u8'])
  })

  test('clz, ctz and popcnt take 32- and 64-bit integers only', () => {
    expect(errs(`func f(x: u8) -> u8 => clz(x)`)).toEqual(['clz requires i32, u32, i64 or u64, got u8'])
    expect(errs(`func f(x: i16) -> u8 => ctz(x)`)).toEqual(['ctz requires i32, u32, i64 or u64, got i16'])
    expect(errs(`func f(x: u128) -> u8 => popcnt(x)`)).toEqual(['popcnt requires i32, u32, i64 or u64, got u128'])
    expect(errs(`func f(x: f64) -> u8 => clz(x)`)).toEqual(['clz requires an integer type, got f64'])
    expect(errs(`func f() -> u8 => popcnt(1.5)`)).toEqual(['popcnt requires an integer type, got float(1.5)'])
  })

  test('min and max keep a range only when every operand is inside it', () => {
    expect(types('i: u32#8, j: u32#4', 'max(i, j)')).toEqual(['u32', 'u32#8'])
    expect(types('i: u32#8, j: u32', 'min(i, j)')).toEqual(['u32', 'u32'])
    expect(types('i: u32#8', 'min(3, i)')).toEqual(['u32', 'u32#8'])
    expect(types('i: u32#8', 'max(i, 3)')).toEqual(['u32', 'u32#8'])
    expect(types('i: u32#8', 'max(i, 100)')).toEqual(['u32', 'u32'])
    expect(types('i: u32#4, b: u8', 'max(i, b)')).toEqual(['u32', 'u32'])
  })

  test('a range is kept through a constant operand only', () => {
    // A def is a constant like a literal.
    const withDef = 'def two = 2\nfunc f(i: u32#8) { let r = max(i, two) }'
    expect(typeAt(checkModule(withDef), withDef.indexOf('r ='))).toBe('u32#8')
    // An if or a match of literals has a literal's type, and any of their values.
    expect(types('i: u32#8, c: bool', 'max(i, if c { 1 } else { 100 })')).toEqual(['u32', 'u32'])
    expect(types('i: u32#8, c: bool', 'max(if c { 1 } else { 100 }, i)')).toEqual(['u32', 'u32'])
    expect(types('i: u32#8, k: i32', 'max(i, match k {\n 0 => 1\n _ => 100\n })')).toEqual(['u32', 'u32'])
    expect(errs(`
      data table = [10:u8, 20, 30, 40]
      func f(i: u32#4, c: bool) -> u8 => table[max(i, if c { 1 } else { 100 })]
    `)).toEqual(["runtime index on *[4]u8 requires 'if let' or '??' (no optional type for u8)"])
  })

  test('a declared function takes the place of the builtin of the same name', () => {
    const result = checkModule(`
      func max(a: i32, b: i32, c: i32) -> i32 => a + b + c
      export func f() -> i32 => max(1, 2, 3)
    `)
    expect(result.errors.map(e => e.message)).toEqual([])
    expect(result.warnings.map(e => e.message)).toEqual(["'max' replaces the builtin max in this module"])
    // A variable of that name is not a function to call: the builtin is still meant.
    expect(errs(`func f(a: i32, b: i32) -> i32 {
      let max = max(a, b)
      return max(max, 0)
    }`)).toEqual([])
  })

  test('an if or a match operand is checked arm by arm', () => {
    // Its arms give it the type of the other operand, or widen to it as a whole.
    expect(types('x: i64, c: bool', 'max(x, if c { 0 - x } else { x })')).toEqual(['i64', 'i64'])
    expect(types('x: i64, c: bool', 'max(if c { 0 - x } else { x }, x)')).toEqual(['i64', 'i64'])
    expect(types('x: f32, c: bool', 'copysign(x, if c { x - 1.0 } else { 1.0 })')).toEqual(['f32', 'f32'])
    expect(types('x: u64, c: bool', 'mul_hi(x, if c { x - 1 } else { x })')).toEqual(['u64', 'u64'])
    expect(errs(`func f(x: i32, c: bool) -> i32 {
      let m = max(x, if c { return -1 } else { 1 })
      return m
    }`)).toEqual([])
    // Its literals take the type of its other arms.
    expect(types('x: i64, k: i32', 'max(x, match k {\n 0 => x + 1\n _ => 5\n })')).toEqual(['i64', 'i64'])
    expect(types('x: i64, a: i32, c: bool', 'max(x, if c { a } else { 5 })')).toEqual(['i64', 'i64'])
    expect(types('a: i32, b: i64, c: bool', 'max(a, if c { b } else { 5 })')).toEqual(['i64', 'i64'])
    expect(errs(`func f(x: f32, c: bool) -> f32 => max(x, if c { x } else { 1.5:f64 })`)).toEqual(['cannot assign f64 to f32'])
  })

  test('a let in a branch of an operand is declared once, however often the operand is checked', () => {
    // A constant operand is checked again against the type of the others,
    // and a pointer operand of memcpy against its own.
    expect(errs(`func f(x: u64, c: bool) -> u64 => mul_hi(if c { let k = 1\n 5 } else { 2 }, x)`)).toEqual([])
    expect(errs(`func f(x: i64, k: i32) -> i64 => max(match k {\n 0 => { let one = 1\n 5 }\n _ => 2\n }, x)`)).toEqual([])
    expect(errs(`func f(x: f32, c: bool) -> f32 => copysign(if c { let k = 1\n 5.0 } else { 2.0 }, x)`)).toEqual([])
    expect(errs(`
      data buf = mut [0:u8; 8]
      func f(c: bool) { memcpy(buf, if c { let k = 1\n "ABCD" } else { "abcd" }, 4) }
    `)).toEqual([])
    // A second let of the name is still one too many.
    expect(errs(`func f(x: i64, c: bool) -> i64 => max(if c { let k = 1\n let k = 2\n 5 } else { 2 }, x)`))
      .toEqual(["'k' is already declared in this scope"])
    expect(errs(`func f(x: i64, c: bool) -> i64 => max(if c { let x = 1\n 5 } else { 2 }, x)`))
      .toEqual(["'x' is already declared in this scope"])
  })

  test('an if or a match operand takes the range away', () => {
    // The range of one arm is not the range of the others.
    expect(types('i: u32#4, j: u32#4, c: bool', 'max(i, if c { j } else { 9 })')).toEqual(['u32', 'u32'])
    expect(types('i: u32#4, j: u32#4, c: bool', 'max(if c { j } else { 9 }, i)')).toEqual(['u32', 'u32'])
    expect(errs(`
      data table = [10:u8, 20, 30, 40]
      func f(i: u32#4, j: u32#4, c: bool) -> u8 => table[max(i, if c { j } else { 9 })]
    `)).toEqual(["runtime index on *[4]u8 requires 'if let' or '??' (no optional type for u8)"])
  })

  test('a function that replaces a builtin is warned of once, where it is declared', () => {
    const src = `
      func max(a: u32, b: u32) -> u32 => a
      func max(a: f64, b: f64) -> f64 => a
      func min(comptime T: type, a: T, b: T) -> T => a
      import "env" "abs" func abs(x: i32) -> i32
      func maximum(a: u32) -> u32 => a
      func clz-of(a: u32) -> u32 => a
      export func f(a: u32, b: f64, sqrt: f64) -> f64 {
        let popcnt = max(a, a) + min(a, a) + maximum(a) + clz-of(a) + abs(1) as u32
        return max(b, b) + sqrt(sqrt) + popcnt as f64
      }
      test "t" {
        func ceil(x: f64) -> f64 => x
        assert ceil(1.5) == 1.5
      }
    `
    const result = checkModule(src)
    expect(result.errors.map(e => e.message)).toEqual([])
    // One for each declaration, plain, shared, generic, imported or in a
    // test, and none for a call or for a parameter or local of the name.
    const replaced = result.warnings.filter(w => w.message.includes('replaces'))
    expect(replaced.map(w => w.message)).toEqual([
      "'max' replaces the builtin max in this module",
      "'max' replaces the builtin max in this module",
      "'min' replaces the builtin min in this module",
      "'abs' replaces the builtin abs in this module",
      "'ceil' replaces the builtin ceil in this module",
    ])
    expect(replaced.map(w => w.offset)).toEqual([
      src.indexOf('func max(a: u32'),
      src.indexOf('func max(a: f64'),
      src.indexOf('func min'),
      src.indexOf('func abs'),
      src.indexOf('func ceil'),
    ])
  })

  test('a comptime function parameter that replaces a builtin in its body is warned of once, where it is declared', () => {
    // Inside the body `max` is the function given for it, not the builtin:
    // the same surprise as a declared function of the name, in a smaller
    // place. Said once, not for each instance.
    const src = `
      func pick(a: u32, b: u32) -> u32 => a * 100 + b
      func last(a: u32, b: u32) -> u32 => b
      func app(comptime max: (u32, u32) -> u32, a: u32) -> u32 => max(a, 1)
      func id(comptime f: (u32, u32) -> u32, max: u32) -> u32 => f(max, 1)
      export func g(a: u32) -> u32 => app(pick, a) + app(last, a) + id(pick, a)
    `
    const result = checkModule(src)
    expect(result.errors.map(e => e.message)).toEqual([])
    const replaced = result.warnings.filter(w => w.message.includes('replaces'))
    expect(replaced.map(w => w.message)).toEqual(["'max' replaces the builtin max in the body of 'app'"])
    expect(replaced.map(w => w.offset)).toEqual([src.indexOf('comptime max')])
  })

  test('a variable in scope hides the declared function, and the builtin is meant again', () => {
    const src = `
      func max(a: i32, b: i32, c: i32) -> i32 => a + b + c
      func f(max: i32) -> i32 => max(max, 2)
      export func g() -> i32 => max(1, 2, 3) + f(4)
    `
    const result = checkModule(src)
    expect(result.errors.map(e => e.message)).toEqual([])
    // Only the call the checker typed as the builtin is marked for codegen.
    expect(typeAt(result, src.indexOf('max(max, 2)'), 'BuiltinCall')).toBe('i32')
    expect(typeAt(result, src.indexOf('max(1, 2, 3)'), 'BuiltinCall')).toBeUndefined()
  })

  test('mul_hi takes operands that widen to u64', () => {
    expect(types('a: u64, b: u64', 'mul_hi(a, b)')).toEqual(['u64', 'u64'])
    expect(types('a: u32, b: u8', 'mul_hi(a, b)')).toEqual(['u64', 'u64'])
    expect(types('a: u32', 'mul_hi(a, 3)')).toEqual(['u64', 'u64'])
    expect(types('', 'mul_hi(0x8000000000000000, 4)')).toEqual(['u64', 'u64'])
    expect(errs(`func f(a: i64, b: u64) -> u64 => mul_hi(a, b)`)).toEqual(['mul_hi: cannot assign i64 to u64'])
    expect(errs(`func f(a: u64, b: u128) -> u64 => mul_hi(a, b)`)).toEqual(['mul_hi: cannot assign u128 to u64'])
    expect(errs(`func f(a: u64) -> u64 => mul_hi(-1, a)`)).toEqual(['mul_hi: cannot assign int(-1) to u64'])
    expect(errs(`func f(a: u64, x: f64) -> u64 => mul_hi(a, x)`)).toEqual(['mul_hi requires an integer type, got f64'])
  })

  test('memzero needs a destination whose size is known', () => {
    expect(errs(`func f(p: *mut [4]u32) { memzero(p) }`)).toEqual([])
    expect(errs(`func f(p: *mut [!]u8) { memzero(p) }`)).toEqual(['memzero dest: *mut [!]u8 has no size known at compile time'])
  })

  test('memcpy checks its source like its destination', () => {
    const src = (param: string) => `
      data buf = mut [0:u8; 16]
      func f(${param}) { memcpy(buf, s, 8) }
    `
    expect(errs(src('s: *[8]u8'))).toEqual([])
    expect(errs(src('s: [*]u8'))).toEqual([])
    expect(errs(src('s: []u8'))).toEqual(['memcpy src: expected *[N]T, got []u8'])
    expect(errs(src('s: i32'))).toEqual(['memcpy src: expected *[N]T, got i32'])
  })
})

describe('functions that share a name', () => {
  const errs = (src: string) => checkModule(src).errors.map(e => e.message)
  // The name of the function each call of `name` in `use` compiles to
  const called = (decls: string, use: string, name = 'hash') => {
    const result = checkModule(`${decls}\n${use}`)
    expect(result.errors.map(e => e.message)).toEqual([])
    const names: string[] = []
    for (const [written, compiled] of result.calls) {
      if (written.callee.kind === 'IdentExpr' && written.callee.name === name && compiled.kind === 'CallExpr' && compiled.callee.kind === 'IdentExpr') {
        names.push(compiled.callee.name)
      }
    }
    return names
  }
  const HASH = `
    func hash(k: u32) -> u32 => k
    func hash(k: u64) -> u32 => 1
    func hash(k: []u8) -> u32 => k.len
    func hash(a: u32, b: u32) -> u32 => a ^ b
  `

  test('each is a function of its own, the later ones under a name made of their parameter types', () => {
    const result = checkModule(HASH)
    expect(result.errors).toEqual([])
    expect([...result.symbols.keys()]).toEqual(['hash', 'hash:u64', "hash:''u8", 'hash:u32|u32'])
    expect([...result.funcNames.values()]).toEqual(['hash:u64', "hash:''u8", 'hash:u32|u32'])
  })

  test('a call means the one whose parameter types are the argument types', () => {
    expect(called(HASH, 'func f(a: u64, s: []u8) -> u32 => hash(a) + hash(s) + hash(1:u64)')).toEqual(['hash:u64', "hash:''u8", 'hash:u64'])
    // The first one declared is called by the name itself: nothing is recorded for it.
    expect(called(HASH, 'func f(a: u32) -> u32 => hash(a)')).toEqual([])
    expect(called(HASH, 'func f(a: u32) -> u32 => hash(a, a)')).toEqual(['hash:u32|u32'])
  })

  test('an exact match wins over one the argument could also be passed to', () => {
    // A u32 can be passed for a u64, and is not: hash(u32) takes it as it is.
    expect(called(HASH, 'func f(a: u32) -> u32 => hash(a) + hash(a + 1)')).toEqual([])
    // A loop counter is a u32 known to lie in a range.
    expect(called(HASH, 'func f() -> (n: u32) { for i in 12 { n += hash(i) } }')).toEqual([])
    const mut = `
      func len(p: *[4]u8) -> u32 => 4
      func len(p: *mut [4]u8) -> u32 => 5
    `
    expect(called(mut, 'func f(p: *mut [4]u8, q: *[4]u8) -> u32 => len(p) + len(q)', 'len')).toEqual(['len:*mut.\'4\'u8'])
  })

  test('a literal beside typed arguments is exact where it fits', () => {
    const gt = `
      func gt(a: u32, b: u32) -> bool => a > b
      func gt(a: f64, b: f64) -> bool => a > b
    `
    // x is a u32: gt(u32, u32) takes it as it is and 10 fits; gt(f64, f64)
    // would convert x. Either side, and as the receiver.
    expect(called(gt, 'func f(x: u32) -> bool => gt(x, 10) || gt(10, x) || x.gt(10)', 'gt')).toEqual([])
    expect(called(gt, 'func f(x: f64) -> bool => gt(x, 10) || gt(1.5, x)', 'gt')).toEqual(['gt:f64|f64', 'gt:f64|f64'])
    // A loop counter in a range is exact as its type, as it is without a literal.
    expect(called(gt, 'func f() -> (n: u32) { for i in 12 { if gt(i, 3) { n += 1 } } }', 'gt')).toEqual([])
    // A literal that does not fit the exact one leaves the conversion.
    expect(called(gt, 'func f(x: u32) -> bool => gt(x, 2.5)', 'gt')).toEqual(['gt:f64|f64'])
    // Two that are exact alike are still ambiguous: the typed u8 is a u8 for
    // both, and 3 fits both.
    const put = `
      func put(a: u8, b: u8) -> u32 => 1
      func put(a: u8, b: u32) -> u32 => 2
    `
    expect(errs(`${put}\nfunc f(x: u8) -> u32 => put(x, 3)`)).toEqual(["'put' is ambiguous for (u8, int(3))"])
    expect(called(put, 'func f(x: u8) -> u32 => put(x, 300) + put(x, 3:u32)', 'put')).toEqual(['put:u8|u32', 'put:u8|u32'])
  })

  test('a literal inside a tuple beside typed values is exact where it fits', () => {
    // (i, 1) is a (u32, u32) for f((u32, u32)) as it stands, and a
    // conversion of i for f((u64, u64)): the same rule as for gt(x, 10), in
    // the parts of the argument. Also by name, nested and behind &.
    const f = `
      type P32 = (x: u32, y: u32)
      type P64 = (x: u64, y: u64)
      func f(p: (u32, u32)) -> u32 => 1
      func f(p: (u64, u64)) -> u32 => 2
      func g(p: P32) -> u32 => 1
      func g(p: P64) -> u32 => 2
      func h(p: ((u32, u32), u8)) -> u32 => 1
      func h(p: ((f64, f64), u8)) -> u32 => 2
      func k(p: *(u32, u32)) -> u32 => 1
      func k(p: *(f64, f64)) -> u32 => 2
    `
    const exact = 'func a(i: u32) -> u32 => f((i, 1)) + f((1, i)) + g((x: i, y: 1)) + h(((i, 1), 2)) + k(&(i, 1))'
    for (const name of ['f', 'g', 'h', 'k']) expect(called(f, exact, name)).toEqual([])
    expect(called(f, 'func a(i: u64) -> u32 => f((i, 1))', 'f')).toEqual(['f:<u64|u64>'])
    expect(called(f, 'func a(i: u64) -> u32 => g((x: 1, y: i))', 'g')).toEqual(['g:<x:u64|y:u64>'])
    // A literal that does not fit the exact one leaves the conversion.
    expect(called(f, 'func a(i: u32) -> u32 => f((i, 5000000000))', 'f')).toEqual(['f:<u64|u64>'])
    // Where each function converts something, as before: ambiguous.
    const both = `
      func m(p: (u64, u64), q: u32) -> u32 => 1
      func m(p: (u32, u32), q: u64) -> u32 => 2
    `
    expect(errs(`${both}\nfunc a(i: u32, j: u32) -> u32 => m((i, 1), j)`)).toEqual(["'m' is ambiguous for ((u32, int(1)), u32)"])
    // Nothing typed in the tuple: nothing to say which.
    expect(errs(`${f}\nfunc a() -> u32 => f((1, 2))`)).toEqual(["'f' is ambiguous for ((int(1), int(2)))"])
  })

  test('without one, the only function the arguments can be passed to', () => {
    const two = `
      func hash(k: u64) -> u32 => 1
      func hash(k: []u8) -> u32 => k.len
    `
    // A u8 widens to a u64, a string is a []u8, and a literal fits one of the two.
    expect(called(two, 'func f(a: u8) -> u32 => hash(a) + hash("abc") + hash(5) + hash([1, 2])')).toEqual(["hash:''u8", "hash:''u8"])
    // A literal is checked against the parameter it would be passed for, as an argument is.
    const sized = `
      func put(b: []u8) -> u32 => 1
      func put(b: []u32) -> u32 => 2
    `
    expect(called(sized, 'func f() -> u32 => put([1, 300])', 'put')).toEqual(["put:''u32"])
  })

  test('an argument that is one value only once a parameter says of what type goes to the only function that takes it', () => {
    // By itself the `if` has branches of two types, and is an error. It
    // takes no part in the first step, and is passed for a []u8 as it would
    // be to a function that has its name to itself.
    const use = 'func f(k: bool) -> u32 => slen(if k { "yes" } else { "no" })'
    expect(called('func slen(s: []u8) -> u32 => s.len\nfunc slen(n: u64) -> u32 => 8', use, 'slen')).toEqual([])
    expect(called('func slen(n: u64) -> u32 => 8\nfunc slen(s: []u8) -> u32 => s.len', use, 'slen')).toEqual(["slen:''u8"])
    // So is a tuple of literals, and the arms of a match.
    const total = 'func total(n: u64) -> u32 => 8\nfunc total(xs: []u32) -> u32 => xs.len\nfunc total(p: (u8, f64)) -> u32 => 2'
    expect(called(total, 'func f(k: bool) -> u32 => total(match k { true => [7], false => [8, 9] }) + total(if k { (1, 2) } else { (3, 4.5) })', 'total')).toEqual([
      "total:''u32",
      'total:<u8|f64>',
    ])
    // Where no function takes it, or more than one does, what is wrong with
    // it by itself is what there is to say.
    expect(errs(`func slen(n: f64) -> u32 => 8\nfunc slen(n: u64) -> u32 => 8\n${use}`)).toEqual(['branches have different types: *[2]u8 and *[3]u8 (cast one explicitly)'])
    expect(errs('func total(xs: []u32) -> u32 => 1\nfunc total(xs: []u64) -> u32 => 2\nfunc f(k: bool) -> u32 => total(if k { [1, 2, 3] } else { [4, 5] })')).toEqual([
      'branches have different types: [2]i32 and [3]i32 (cast one explicitly)',
    ])
  })

  test('none is one error that lists the argument types', () => {
    expect(errs(`${HASH}\nfunc f(x: f64) -> u32 => hash(x)`)).toEqual(["no function 'hash' accepts (f64)"])
    expect(errs(`${HASH}\nfunc f(x: u32) -> u32 => hash(x, x, x)`)).toEqual(["no function 'hash' accepts (u32, u32, u32)"])
    expect(errs(`${HASH}\nfunc f() -> u32 => hash()`)).toEqual(["no function 'hash' accepts ()"])
    expect(errs(`type Cell = (x: i32, y: i32)${HASH}\nfunc f(c: Cell) -> u32 => hash(c)`)).toEqual(["no function 'hash' accepts (Cell)"])
    // Nothing more is said of what the call was used for.
    expect(errs(`${HASH}\nfunc f(x: f64) -> bool => hash(x)`)).toEqual(["no function 'hash' accepts (f64)"])
  })

  test('several is one error too', () => {
    expect(errs(`${HASH}\nfunc f() -> u32 => hash(5)`)).toEqual(["'hash' is ambiguous for (int(5))"])
    expect(errs(`${HASH}\nfunc f(a: u8) -> u32 => hash(a)`)).toEqual(["'hash' is ambiguous for (u8)"])
    // Giving the literal its type says which.
    expect(errs(`${HASH}\nfunc f() -> u32 => hash(5:u64)`)).toEqual([])
  })

  test('an argument with an error of its own is that error alone', () => {
    expect(errs(`${HASH}\nfunc f() -> u32 => hash(nope)`)).toEqual(["unknown identifier 'nope'"])
    expect(errs(`${HASH}\nfunc f(x: f64) -> u32 => hash(hash(x))`)).toEqual(["no function 'hash' accepts (f64)"])
  })

  test('a call that failed is still a use of the functions', () => {
    const result = checkModule(`${HASH}\nexport func f(x: f64) -> u32 => hash(x)`)
    expect(result.warnings).toEqual([])
  })

  test('one that nothing calls is reported by the name it was declared with', () => {
    const src = `${HASH}\nexport func f(x: u32) -> u32 => hash(x)`
    const result = checkModule(src)
    expect(result.warnings.map(w => w.message)).toEqual(["'hash' is never used", "'hash' is never used", "'hash' is never used"])
    expect(result.warnings.map(w => w.offset)).toEqual([src.indexOf('func hash(k: u64'), src.indexOf('func hash(k: []'), src.indexOf('func hash(a:')])
  })

  test('a misspelt name is not answered with the name a function is known by', () => {
    // hash:u64 is one edit from hash_u64, and nothing a program can write.
    expect(errs(`${HASH}\nfunc f(x: u64) -> u32 => hash_u64(x)`)[0]).toBe("unknown identifier 'hash_u64'")
    expect(errs(`${HASH}\nfunc f(x: u64) -> u32 => hasj(x)`)[0]).toBe("unknown identifier 'hasj' — did you mean 'hash'?")
  })

  test('two with the same parameter types are an error at the second', () => {
    const src = 'func hash(k: u32) -> u32 => k\nfunc hash(n: u32) -> u64 => 1'
    const result = checkModule(src)
    expect(result.errors).toEqual([{ offset: src.lastIndexOf('func'), message: "'hash' is already declared with parameters (u32)" }])
    expect(errs('func f() { }\nfunc f() { }')).toEqual(["'f' is already declared with parameters ()"])
    // The names of the parameters and the result are not what tells two
    // apart, nor is a name for a type. The message shows the earlier one's
    // parameters as they were written.
    expect(errs('type Meters = u32\nfunc f(a: Meters, b: []u8) { }\nfunc f(x: u32, y: []u8) -> u32 => 1')).toEqual([
      "'f' is already declared with parameters (Meters, []u8)",
    ])
  })

  test('also when a parameter type is declared further down', () => {
    expect(errs('func f(a: Later) -> i32 => a.x\nfunc f(a: (x: i32)) -> i32 => 1\ntype Later = (x: i32)')).toEqual([
      "'f' is already declared with parameters (Later)",
    ])
    // Refused, it is no second function of the name: the name is the one
    // function's wherever it is used.
    const less = 'func less(a: u32, b: u32) -> bool => a < b\nfunc less(a: Later, b: Later) -> bool => a > b\ntype Later = u32\n'
    expect(errs(`${less}func sort(comptime T: type, xs: []mut T, comptime before: (T, T) -> bool) { }\nfunc f(xs: []mut u32) { sort(xs, less) }`)).toEqual([
      "'less' is already declared with parameters (u32, u32)",
    ])
    const bump = 'type Box = (n: u32)\nfunc bump(b: *mut Box) { b.n += 1 }\nfunc bump(b: *mut Later) { b.n += 2 }\ntype Later = (n: u32)\n'
    expect(errs(`${bump}func f(b: Box) { b.bump() }`)).toEqual([
      "'bump' is already declared with parameters (*mut Box)",
      'bump takes *mut Box first; the receiver is a Box, which is held in registers and has no address',
    ])
    expect(called('func f(a: Later) -> i32 => a.x\nfunc f(a: Other) -> i32 => a.y\ntype Later = (x: i32)\ntype Other = (y: i32)',
      'func g(a: Later, b: Other) -> i32 => f(a) + f(b)', 'f')).toEqual(['f:<y:i32>'])
  })

  test('a generic function cannot share its name', () => {
    expect(errs('func f(comptime T: type, a: T) -> T => a\nfunc f(a: u32) -> u32 => a')).toEqual([
      "'f' is already declared: a generic function's name is unique in its module",
    ])
    expect(errs('func f(a: u32) -> u32 => a\nfunc f(comptime T: type, a: T) -> T => a')).toEqual([
      "'f' is already declared: a generic function's name is unique in its module",
    ])
  })

  test('an imported function shares a name like a declared one', () => {
    const src = `
      import "env" ( "log_u32" func log(x: u32) "log_f64" func log(x: f64) )
      func log(x: []u8) { }
      export func f(a: u32, b: f64, c: []u8) { log(a) log(b) log(c) }
    `
    expect(called(src, '', 'log')).toEqual(['log:f64', "log:''u8"])
    expect(errs('import "env" ( "a" func log(x: u32) "b" func log(y: u32) )')).toEqual(["'log' is already declared with parameters (u32)"])
  })

  test('a global, a def or data that takes the name afterwards is checked without a throw', () => {
    // It is refused ('hash' is already declared), and the functions that
    // shared the name are no reason to fail on that.
    const two = 'func hash(k: u32) -> u32 => k\nfunc hash(k: u64) -> u32 => 1\n'
    for (const taker of ['global hash: u32 = 3', 'def hash = 3', 'data hash = [1:u8, 2]']) {
      expect(() => checkModule(`${two}${taker}\nfunc hash(k: f64) -> u32 => 2\nfunc f(x: u64) -> u32 => hash(x)`)).not.toThrow()
      expect(() => checkModule(`${two}${taker}\nfunc f(x: u64) -> u32 => hash(x)`)).not.toThrow()
    }
  })

  test('one function of another source module imported twice is that function, not a second one', () => {
    const twice = `
      import "./keys" "hash" func hash(k: u32) -> u32
      import "./keys" (
        "hash" func hash(k: u32) -> u32
        "hash_bytes" func hash(k: []u8) -> u32
        "hash_bytes" func hash(k: []u8) -> u32
      )
      func f(k: u32, s: []u8) -> u32 => hash(k) + hash(s)
    `
    const result = checkModule(twice)
    expect(result.errors).toEqual([])
    expect([...result.symbols.keys()]).toEqual(['hash', "hash:''u8", 'f'])
    // Two imports of one name from the host are two functions of one name in the module.
    expect(errs('import "env" "now" func now() -> u64\nimport "env" "now" func now() -> u64')).toEqual(["'now' is already declared with parameters ()"])
  })

  test('one global of another source module imported twice is that global, not a second one', () => {
    expect(errs(`
      import "./keys" "seed" global seed: u32
      import "./keys" ( "seed" global seed: u32 )
      func f() -> u32 => seed
    `)).toEqual([])
    // Another global under that name is a second declaration of it.
    expect(errs(`
      import "./keys" "seed" global seed: u32
      import "./keys" "salt" global seed: u32
      import "env" "now" global now: u64
      import "env" "now" global now: u64
    `)).toEqual(["'seed' is already declared", "'now' is already declared"])
  })

  test('a function a test declares replaces the one of the module, as it always has', () => {
    const result = checkModule(`
      func hash(k: u32) -> u32 => k
      test "t" {
        func hash(k: u64) -> u32 => 1
        assert hash(1:u64) == 1
      }
    `)
    expect(result.errors).toEqual([])
    expect([...result.symbols.keys()]).toEqual(['hash'])
  })

  test('a name that several functions share is not one a test can take over', () => {
    // The test's function stood in for the first of them, for the module's
    // code too: with tests built, a call of the module's own chose among
    // other functions than in the build that ships.
    const shared = `
      func hash(k: u32) -> u32 => 1
      func hash(k: u64) -> u32 => 2
      func bucket(comptime K: type, k: K) -> u32 => hash(k)
      export func f(k: u32) -> u32 => bucket(k) * 10 + hash(k)
    `
    const refused = "'hash' is the name of several functions of the module: a function declared in a test cannot take it over"
    for (const params of ['k: f32', 'k: u64', 'a: u32, b: u32']) {
      const result = checkModule(`${shared}
      test "t" {
        func hash(${params}) -> u32 => 3
        assert f(1) == 11
      }`)
      expect(result.errors.map(e => e.message)).toEqual([refused])
      // What the module's code calls is what it calls without the test.
      expect([...result.symbols.keys()]).toEqual(['hash', 'hash:u64', 'bucket', 'f', 'bucket<u32>'])
    }
    // The test's own calls of it say nothing more, and neither does an import.
    expect(errs(`${shared}
      test "t" {
        func hash(k: f32) -> u32 => 3
        assert hash(1.5) == 3
      }`)).toEqual([refused])
    expect(errs(`${shared}
      test "t" {
        import "env" "hash" func hash(k: f32) -> u32
        assert f(1) == 11
      }`)).toEqual([refused])
  })

  test('a function the program declares takes a builtin\'s name, with every function that shares it', () => {
    const src = `
      type Pt = (q: i32, r: i32)
      func max(a: Pt, b: Pt) -> Pt => if a.q > b.q { a } else { b }
      func max(a: f64, b: f64) -> f64 => if a > b { a } else { b }
      func f(p: Pt, x: f64) -> f64 => max(p, p).q as f64 + max(x, 1.5)
    `
    expect(called(src, '', 'max')).toEqual(['max:f64|f64'])
    // The builtin is gone from the module: two u32s are widened for the one
    // declared function that takes them, and two i64s have none.
    expect(called(`${src}\nfunc g(a: u32) -> f64 => max(a, a)`, '', 'max')).toEqual(['max:f64|f64', 'max:f64|f64'])
    expect(errs(`${src}\nfunc g(a: i64) -> i64 => max(a, a)`)).toEqual(["no function 'max' accepts (i64, i64)"])
  })

  test('each export needs a name of its own', () => {
    const src = 'export func hash(k: u32) -> u32 => k\nexport func hash(k: []u8) -> u32 => k.len'
    expect(checkModule(src).errors).toEqual([{
      offset: src.lastIndexOf('export'),
      message: `export name 'hash' is used twice: give one an explicit name, as in export "hash_2" func hash(...)`,
    }])
    expect(errs('export func hash(k: u32) -> u32 => k\nexport func hash(k: u64) -> u32 => 1')).toEqual([
      `export name 'hash' is used twice: give one an explicit name, as in export "hash_u64" func hash(...)`,
    ])
    expect(errs('export func hash(k: u32) -> u32 => k\nexport "hash_bytes" func hash(k: []u8) -> u32 => k.len')).toEqual([])
    // Any two exports, not only two functions that share a name
    expect(errs('export "x" func a() { }\nexport "x" func b() { }')).toEqual([
      `export name 'x' is used twice: give one an explicit name, as in export "x_2" func b(...)`,
    ])
    expect(errs('export "x" func a() { }\nexport "x" global g: u32 = 0')).toEqual([
      `export name 'x' is used twice: give one an explicit name, as in export "x_2" global g`,
    ])
    // Of several memory declarations only the first is the module's memory,
    // so only its export is one.
    expect(errs('export memory\nexport memory 8\nexport "mem" memory 8 256\nexport "mem" func f() { }')).toEqual([])
    expect(errs('export "memory" func f() { }\nexport memory 8')).toEqual([
      `export name 'memory' is used twice: give one an explicit name, as in export "memory_2" memory`,
    ])
    expect(errs('memory 1\nexport "memory" func f() { }\nexport memory 8')).toEqual([])
  })

  test('the name of several functions is no function value', () => {
    // With no arguments to say which, it was the first one declared: here
    // the one that does not fit, though the other does.
    const inc = 'func inc(a: u64) -> u64 => a + 1\nfunc inc(a: u32) -> u32 => a + 1\n'
    const refused = "'inc' is the name of several functions: it can only be called, where the arguments say which one"
    expect(errs(`${inc}func ap(g: (u32) -> u32, x: u32) -> u32 => x\nfunc f(x: u32) -> u32 => ap(inc, x)`)).toEqual([refused])
    const stored = checkModule(`${inc}export func f(x: u32) -> u32 {\n  let g = inc\n  return x\n}`)
    expect(stored.errors.map(e => e.message)).toEqual([refused])
    // It is a use of each of them all the same.
    expect(stored.warnings).toEqual([])
    // A name that one function has is its value, as before.
    expect(errs('func inc(a: u32) -> u32 => a + 1\nfunc ap(g: (u32) -> u32, x: u32) -> u32 => x\nfunc f(x: u32) -> u32 => ap(inc, x)')).toEqual([])
  })

  test('a declaration that repeats another is that one error, exported or not', () => {
    // It is no function of the module, so it exports nothing: a name for its
    // export would not help.
    expect(errs('export func f(x: u32) -> u32 => 1\nexport func f(x: u32) -> u32 => 2')).toEqual(["'f' is already declared with parameters (u32)"])
    // The same where the two turn out to be one only once a later type is known.
    expect(errs('export func f(x: u32) -> u32 => 1\nexport func f(x: Later) -> u32 => 2\ntype Later = u32')).toEqual([
      "'f' is already declared with parameters (u32)",
    ])
  })
})

describe('calling a function value', () => {
  const errs = (src: string) => checkModule(src).errors.map(e => e.message)
  const refused = (type: string) =>
    `calling a function value is not supported yet: only a function named directly, or a comptime function parameter (comptime f: ${type}), can be called`

  test('is one error, wherever the value is held', () => {
    const inc = 'func inc(a: u32) -> u32 => a + 1\n'
    expect(errs(`${inc}func apply(g: (u32) -> u32, x: u32) -> u32 => g(x)`)).toEqual([refused('(u32) -> u32')])
    expect(errs(`${inc}func f(x: u32) -> u32 {\n  let g = inc\n  return g(x)\n}`)).toEqual([refused('(u32) -> u32')])
    expect(errs(`type S = (cb: (u32, u32) -> bool, n: u32)\nfunc f(s: S) -> bool => s.cb(s.n, 1)`)).toEqual([refused('(u32, u32) -> bool')])
    expect(errs(`type S = (cb: (u32) -> u32, n: u32)\nfunc f(s: *S) -> u32 => s.cb(1)`)).toEqual([refused('(u32) -> u32')])
  })

  test('says nothing more of the call, and still checks its arguments', () => {
    expect(errs('func apply(g: (u32) -> u32, x: u32) -> u64 => g(x)')).toEqual([refused('(u32) -> u32')])
    expect(errs('func apply(g: (u32) -> u32, x: f64) -> u32 => g(x)')).toEqual([refused('(u32) -> u32'), 'argument 1: cannot assign f64 to u32'])
  })

  test('a function named directly is called as before', () => {
    expect(errs('func inc(a: u32) -> u32 => a + 1\nfunc f(x: u32) -> u32 => inc(inc(x))')).toEqual([])
    expect(errs('import "env" "now" func now() -> u64\nfunc f() -> u64 => now()')).toEqual([])
  })
})

describe('types that refer to themselves', () => {
  const errs = (src: string) => checkModule(src).errors.map(e => e.message)
  const holds = (name: string) => `type '${name}' contains itself: a type can only refer to itself through a pointer or a slice`

  test('through a pointer or a slice, a field is the type again, at any depth', () => {
    const node = 'type Node = (next: ?*Node, v: u32)\n'
    expect(errs(`${node}func f(h: *Node) -> ?*Node => h.next`)).toEqual([])
    expect(errs(`${node}func f(h: *Node) -> u32 => if let a = h.next { if let b = a.next { if let c = b.next { c.v } else { 0 } } else { 0 } } else { 0 }`)).toEqual([])
    expect(errs(`${node}func f(h: *Node, p: ?*Node) -> bool {\n  let q: ?*Node = h.next\n  return q == p\n}`)).toEqual([])
    expect(errs('type Tree = (kids: []Tree, v: u32)\nfunc f(t: Tree) -> u32 => if let k = t.kids[0] { if let l = k.kids[1] { l.v } else { 0 } } else { 0 }')).toEqual([])
    expect(errs('type Tree = (kids: [*]Tree, n: u32)\nfunc f(t: *Tree) -> u32 => t.kids[0].kids[1].n')).toEqual([])
    // Through each other, and through another name for it
    expect(errs('type A = (b: ?*B, v: u32)\ntype B = (a: ?*A, w: u32)\nfunc f(a: *A) -> u32 => if let b = a.b { if let c = b.a { c.v } else { 0 } } else { 0 }')).toEqual([])
    expect(errs(`${node}type Link = Node\nfunc f(h: *Link) -> ?*Link => h.next\nfunc g(h: *Node) -> ?*Node => f(h)`)).toEqual([])
  })

  test('two types that refer to themselves are one type when nothing on the way round tells them apart', () => {
    const two = 'type A = (next: ?*A, v: u32)\ntype B = (next: ?*B, v: u32)\ntype C = (next: ?*C, v: u16)\n'
    expect(errs(`${two}func f(a: *A) -> *B => a`)).toEqual([])
    expect(errs(`${two}func f(a: *A) -> *C => a`)).toEqual(['cannot assign *A to *C'])
    expect(errs('type A = (kids: []A, v: u32)\ntype B = (kids: []B, v: u64)\nfunc f(a: []A) -> []B => a')).toEqual(['cannot assign []A to []B'])
  })

  test('holding itself, not through a pointer or a slice, it has no size', () => {
    expect(errs('type N = (a: N, v: u32)\nfunc f(n: *N) -> u32 => n.v')).toEqual([holds('N')])
    expect(errs('type N = (a: [2]N, v: u32)\nfunc f(n: *N) -> u32 => n.v')).toEqual([holds('N')])
    expect(errs('type L = L\nfunc f(n: L) -> u32 => 1')).toEqual([holds('L')])
    // Said where the round is closed
    expect(errs('type A = (b: B, v: u32)\ntype B = (a: ?*A, w: A)\nfunc f(a: A, b: B) -> u32 => a.v')).toEqual([holds('B')])
    expect(errs('type A = B\ntype B = A\nfunc f(n: A) -> u32 => 1')).toEqual([holds('B')])
    expect(errs('func L(comptime T: type) -> type => (head: T, rest: ?*T)\ntype Knot = L(Knot)\nfunc f(p: *Knot) -> u32 => sizeof(Knot)')).toEqual([holds('Knot')])
  })
})

describe('types declared further down', () => {
  const errs = (src: string) => checkModule(src).errors.map(e => e.message)

  test('a chain of names resolves in whatever order it is declared', () => {
    const chain = 'type A = B\ntype B = C\ntype C = u32\n'
    expect(errs(`${chain}func f(a: A) -> u32 => a + 1\nfunc g(x: u32) -> A => x\nfunc h() -> u32 => sizeof(A)`)).toEqual([])
    expect(errs(`${chain}func f(a: A, b: B) -> bool => a == b`)).toEqual([])
    // Through the fields of structs
    const fields = 'type S = (t: T, v: A)\ntype T = (u: U, w: B)\ntype U = (x: C)\n'
    expect(errs(`${fields}${chain}func f(s: S) -> u32 => s.t.u.x + s.t.w + s.v\nfunc g() -> u32 => sizeof(S)`)).toEqual([])
    expect(errs(`${fields}${chain}func f(s: *S) -> u32 => s.t.u.x\nfunc g(x: (t: (u: (x: u32), w: u32), v: u32)) -> S => x`)).toEqual([])
  })

  test('a global, a def or a data that names a type declared below it is checked against that type', () => {
    expect(errs('global one: Byte = 1\nglobal origin: (first: Byte, second: u16) = (1, 2)\ntype Byte = u8\nfunc f() -> u32 => origin.second + one')).toEqual([])
    expect(errs('global origin: P = P(1, 2)\ntype P = (first: Byte, second: u16)\ntype Byte = u8\nfunc f() -> u32 => origin.second')).toEqual([])
    expect(errs('data table = [P(3, 4)]\ndef four: Byte = 4\ntype P = (first: Byte, second: u16)\ntype Byte = u8\nfunc f() -> u32 => (table as *P).second + four')).toEqual([])
    // And refused where it does not fit, as it is above
    expect(errs('global one: Byte = 300\ntype Byte = u8')).toEqual(['cannot assign int(300) to Byte'])
  })
})

describe('types too large to write out', () => {
  const errs = (src: string) => checkModule(src).errors.map(e => e.message)
  const large = (name: string) => `type '${name}' is too large: written out in full it has more than 65536 parts`
  // D(k) = (a: D(k - 1), b: D(k - 1)) has 2^(k + 1) - 1 parts: D15 is the largest under the limit.
  const doubling = (n: number, order: 'up' | 'down' = 'up') => {
    const decls = ['type D0 = u8', ...Array.from({ length: n }, (_, i) => `type D${i + 1} = (a: D${i}, b: D${i})`)]
    return `${(order === 'up' ? decls : decls.reverse()).join('\n')}\n`
  }

  test('is one error, where the first type too large is declared, in whatever order', () => {
    expect(errs(`${doubling(15)}func f(p: *D15) -> u8 => p.a.b.a.b.a.b.a.b.a.b.a.b.a.b.a`)).toEqual([])
    expect(errs(`${doubling(16)}func f(p: *D16) -> u32 => 1`)).toEqual([large('D16')])
    expect(errs(`${doubling(40)}func first(comptime T: type, p: *T) -> *T => p\nfunc f(p: *D40) -> u32 => sizeof(D40)\nfunc g(d: D40, p: *D40) -> *D40 => first(p)`)).toEqual([large('D16')])
    expect(errs(`${doubling(40, 'down')}func f(p: *D40) -> u32 => sizeof(D40)`)).toEqual([large('D16')])
    // Through pointers too: the pointers are written out with what they point to
    expect(errs(`type P0 = u8\n${Array.from({ length: 30 }, (_, i) => `type P${i + 1} = (p: *P${i}, q: *P${i})`).join('\n')}\nfunc f(p: *P30) -> u32 => 1`)).toEqual([large('P15')])
  })

  test('a generic type that doubles is one error where it is applied', () => {
    const D = 'func D(comptime T: type) -> type => (a: T, b: T)\n'
    const nest = (n: number, inner: string) => `${'D('.repeat(n)}${inner}${')'.repeat(n)}`
    expect(errs(`${D}func f(p: *${nest(15, 'u8')}) -> u32 => 1`)).toEqual([])
    expect(errs(`${D}func f(p: *${nest(40, 'u8')}) -> u32 => 1`)).toEqual([large(nest(16, 'u8'))])
    // Inside the body of another, said where that one is applied
    expect(errs(`${D}func Big(comptime T: type) -> type => (x: ${nest(18, 'T')})\nfunc f(p: *Big(u8)) -> u32 => 1`)).toEqual([large('Big(u8)')])
  })

  test('a type made deep by its names is counted however deep it is', () => {
    // 3000 types in a ring through pointers: each is written out through all
    // the others before it comes round, 12000 parts and 9000 levels deep.
    const ring = Array.from({ length: 3000 }, (_, i) => `type T${i} = (n: ?*T${(i + 1) % 3000}, v: u32)`).join('\n')
    expect(errs(`${ring}\nfunc f(t: *T0) -> u32 => if let n = t.n { n.v } else { t.v }`)).toEqual([])
  })

  test('a type written in place is one error where it is written, as a whole', () => {
    // *(a: D14, b: D14) has 65536 parts, *(a: D15, b: D15) 131072
    expect(errs(`${doubling(15)}func f(p: *(a: D14, b: D14)) -> u32 => 1`)).toEqual([])
    expect(errs(`${doubling(15)}func f(p: *(a: D15, b: D15)) -> u32 => 1`)).toEqual([large('*(a: D15, b: D15)')])
    const many = Array.from({ length: 300 }, (_, i) => `f${i}: D15`).join(', ')
    expect(errs(`${doubling(15)}func f(p: *D15) -> u32 {\n  let q = p as *(${many})\n  return 1\n}`)).toEqual([large(`*(${many})`)])
    // As a type argument, and inside a generic, once for each instance it is in
    expect(errs(`${doubling(15)}func id(comptime T: type, p: *T) -> u32 => 1\nfunc f(p: *D15) -> u32 => id((D15, D15), p)`)).toEqual([large('(D15, D15)')])
    expect(errs(`${doubling(15)}func g(comptime T: type, x: T) -> u32 {\n  let q = 0 as *(a: T, b: T)\n  return 1\n}\nfunc f(d: *D15) -> u32 => g(D15, d.*)`)).toEqual([`${large('*(a: D15, b: D15)')}, in g(T = D15)`])
  })
})

describe('a name for a pointer, a slice, an array or an optional', () => {
  const errs = (src: string) => checkModule(src).errors.map(e => e.message)
  const names = `type P = *mut u16
type S = []f64
type A = [4]i8
type M = [*]u32
type O = ?*i32
type PP = *mut P
type PA = *mut [3]u8
type E = []P
`

  test('is the type it names: dereferenced, measured, indexed and unwrapped', () => {
    expect(errs(`${names}func a(p: P) -> u16 => p.*
func b(s: S) -> f64 => s.ptr[0]
func c(s: S) -> u32 => s.len
func d(x: A) -> i8 => x[2]
func e(m: M, i: u32) -> u32 => m[i]
func f(p: O) -> i32 => if let q = p { q.* } else { 4 }
func g(p: PP, q: P) { p.* = q }
func h(p: PA) -> u32 => p.len + p[2] + p.wid
func i(p: O, q: *i32) -> i32 => (p ?? q).*
func j(e: E, i: u32) -> u16 => if let p = e[i] { p.* } else { 0 }
func k(s: S) -> f64 {
  let t: f64 = 0.0
  for v in s { t += v }
  return t
}`)).toEqual([])
  })

  test('lays out a literal, in data or in place, and makes a pointer to it a slice', () => {
    // A data declared with the name, or a literal given for it after a colon
    // (PA is a *mut [3]u8: its literal is written with mut, as for the
    // pointer it names)
    expect(errs(`${names}type B = [3]u16\ntype PB = *B\ndata s: S = [1.5, 2.5]\ndata pa: PA = mut [1, 2, 3]\ndata pb: PB = [4, 5, 6]\ndata ms = mut [0:f64; 4]:S\nfunc f() -> u32 => s.len + pa[1] + pb.len + ms.len`)).toEqual([])
    // A pointer to a name for an array, whatever names the pointer
    expect(errs(`${names}type B = [3]u16\ntype PB = *B\nfunc f() -> []u16 {\n  let q: *B = [1, 2, 3]\n  let r: PB = q\n  let m: [*]u16 = r\n  let s: []u16 = r\n  return q\n}`)).toEqual([])
    // Not as writable as a slice that is: the same refusal as written out
    expect(errs(`${names}type B = [3]u16\nfunc f(q: *B) -> []mut u16 => q`)).toEqual(['cannot assign *B to []mut u16'])
  })

  test('and what cannot be done with the type cannot be done with the name', () => {
    expect(errs(`${names}func a(s: S) -> f64 => s.*`)).toEqual(['cannot use .* on S - use [0] to access the first element'])
    expect(errs(`${names}func a(x: A, i: u32) -> i8 => x[i]`)).toEqual(['dynamic index on value type [4]i8 — use a pointer or slice for dynamic access'])
    expect(errs(`${names}func a(m: M) -> u32 => m.len`)).toEqual(['cannot get .len on unbounded array [*]u32 - length is unknown'])
    expect(errs(`${names}func a(p: P) -> u32 => p[0..2].len`)).toEqual(['cannot take a range of *mut u16: use a slice or a pointer to an array'])
  })
})

describe('arguments by place and by name', () => {
  const errs = (src: string) => checkModule(src).errors.map(e => e.message)

  test('a function or a builtin is called with positional arguments only', () => {
    expect(errs(`
      func f(a: i32, b: i32) -> i32 => a - b
      func g() -> i32 => f(b: 1, a: 2)
      func h(b: i32) -> i32 => f(b:, 3)
      func k(x: i32) -> i32 => x.f(b: 2)
      func m(x: i32, y: i32) -> i32 => min(a: x, b: y)
    `)).toEqual([
      "'f' takes positional arguments",
      "'f' takes positional arguments",
      "'f' takes positional arguments",
      "'min' takes positional arguments",
    ])
    expect(errs(`
      func h(k: u32) -> u32 => k
      func h(k: u64) -> u32 => 1
      func g(x: u32) -> u32 => h(k: x)
    `)).toEqual(["'h' takes positional arguments"])
  })

  test('a constructor gives each field once, by name or by place', () => {
    expect(errs(`
      type Pt = (q: i32, r: i32)
      func a() -> Pt => Pt(1, q: 2)
      func b() -> Pt => Pt(r: 2, 1)
      func c(q: i32) -> Pt => Pt(q, r: 2)
    `)).toEqual(["Pt: field 'q' is given twice", "Pt: field 'r' is given twice"])
  })

  test('a tuple literal with names gives each field of the struct once, by name or by place', () => {
    expect(errs(`
      type Pt = (q: i32, r: i32)
      func a() -> Pt => (q: 1, z: 2)
      func b() -> Pt => (q: 1)
      func c() -> Pt => (q: 1, q: 2)
      func d() -> Pt => (r: 2, 1)
      func e(q: i32) -> Pt => (q, r: 2)
      func f(r: i32) -> Pt => (r:, q: 1)
    `)).toEqual([
      "field 'z' not found in Pt, whose fields are q and r",
      'Pt expects 2 fields, got 1: no value for r',
      "Pt: field 'q' is given twice",
      "Pt: field 'r' is given twice",
    ])
    expect(errs(`
      type One = (v: i32)
      func a() -> One => (w: 5)
    `)).toEqual(["field 'w' not found in One, whose only field is v"])
    expect(errs(`
      func a(p: [*]u8) -> []u8 => (len: 2)
      func b(p: [*]u8) -> []u8 => (ptr: p, len: 2, wid: 3)
    `)).toEqual(['[]u8 expects 2 fields, got 1: no value for ptr', '[]u8 expects 2 fields, got 3'])
    // A value keeps its order: the error says where to give it the type.
    expect(errs(`
      type Pt = (q: i32, r: i32)
      func mk() -> (r: i32, q: i32) => (1, 2)
      func a() -> Pt => mk()
      func b() -> (a: i32, q: i32) => (1, 2)
      func c() -> Pt => b()
    `)).toEqual([
      "cannot assign (r: i32, q: i32) to Pt: its fields have the names of Pt's in another order, and only a literal gives fields by name; give the value the type Pt where it is made",
      'cannot assign (a: i32, q: i32) to Pt',
    ])
    // A tuple type without names, a slice and named results have the
    // fields they have.
    expect(errs(`
      func f() -> (i32, i32) => (y: 1, x: 2)
      func g(p: [*]u8) -> []u8 => (len: 3, p: p)
      func h(p: [*]u8) -> []u8 => (len: 3, len: 4)
      func k() -> (q: i32, r: i32) => (a: 1, r: 2)
      func m(p: [*]u8, n: i64) -> []u8 => (len: n, ptr: p)
    `)).toEqual([
      "field 'y' not found in (i32, i32), whose fields have no names: give the values by position",
      "field 'x' not found in (i32, i32), whose fields have no names: give the values by position",
      "field 'p' not found in []u8: a slice's fields are ptr and len",
      "[]u8: field 'len' is given twice",
      "field 'a' not found in (q: i32, r: i32), whose fields are q and r",
      'slice length: cannot assign i64 to u32',
    ])
  })

  test('branches that give named results by name, in other orders, are no different types', () => {
    expect(errs(`
      func orders(c: bool, n: u32) -> (lo: u32, hi: u32) {
        let k: u32 = n + 1
        if c { (hi: k, lo: 3) } else { (lo: 4, hi: k) }
      }
      func arms(m: u32) -> (lo: u32, hi: u32) {
        match m { 0 => (hi: m, lo: 3), _ => { (lo: m, hi: 1:u8) } }
      }
    `)).toEqual([])
  })

  test('a tuple laid out as a struct in data gives each field a value of its type', () => {
    expect(errs(`
      type Small = (b: u8, w: u32)
      data s: Small = (300, 1)
      data t: Small = (w: 1.5, b: 2)
      data u: Small = (w: 1, b: 2)
    `)).toEqual(['cannot assign int(300) to u8', 'cannot assign float(1.5) to u32'])
  })

  test('a value of a struct type is not a constructor', () => {
    expect(errs(`
      type Pt = (q: i32, r: i32)
      func f(p: Pt) { p(3, 4) }
      func g() {
        let p = Pt(1, 2)
        p(3, 4)
      }
    `)).toEqual(['cannot call non-function type: Pt', 'cannot call non-function type: (q: i32, r: i32)'])
  })
})

describe('a name declared twice at the top of a module', () => {
  const errs = (src: string) => checkModule(src).errors.map(e => e.message)

  test('is one thing: only functions share a name', () => {
    const twice = (name: string) => `'${name}' is already declared`
    expect(errs(`
      global x: i32 = 1
      global x: i64 = 2
      export global y: i32 = 1
      global y: i32 = 2
      def d = 1
      global d: i32 = 2
      global e: i32 = 2
      def e = 1
      data b = [1, 2]
      global b: i32 = 2
      import "m" "g" global g: i32
      global g: i32 = 1
      func f() -> i32 => 1
      global f: i32 = 3
      global h: i32 = 3
      func h() -> i32 => 1
      def k = 4
      import "m" "k" func k() -> i32
    `)).toEqual(['x', 'y', 'd', 'e', 'b', 'g', 'f', 'h', 'k'].map(twice))
    // Functions share a name where their parameters differ.
    expect(errs(`
      func f(a: u32) -> u32 => a
      func f(a: u64) -> u32 => 1
      import "m" "f" func f(a: f64) -> u32
    `)).toEqual([])
  })

  test('the first declaration is the one the name stands for', () => {
    expect(errs(`
      global x: i64 = 1
      global x: f64 = 2.5
      func f() -> i64 => x
    `)).toEqual(["'x' is already declared"])
  })

  test('a test takes over a function of the module, and nothing else', () => {
    const twice = (name: string) => `'${name}' is already declared`
    expect(errs(`
      global x: i32 = 5
      def k = 4
      data b = [1, 2]
      func f() -> i32 => 1
      func get() -> i32 => x + k + b[0] + f()
      test "t" {
        func x() -> i32 => 7
        func k() -> i32 => 7
        func b() -> i32 => 7
        import "env" "x" global x: i32
        import "env" "f" global f: i32
        import "env" "k" func k() -> i32
        assert get() == 11
      }
    `)).toEqual(['x', 'k', 'b', 'x', 'f', 'k'].map(twice))
    // A test's own names, and a function of the module it takes over.
    expect(errs(`
      func f() -> i32 => 1
      test "t" {
        func f() -> i32 => 2
        func h() -> i32 => 3
        import "env" "g" global g: i32
        assert f() + h() + g == 5
      }
      test "u" {
        func h() -> i32 => 4
        assert h() == 4
      }
    `)).toEqual([])
  })
})

describe('only a variable is assigned', () => {
  const errs = (src: string) => checkModule(src).errors.map(e => e.message)

  test('by = or by set: a def, a data block or a function is not one', () => {
    expect(errs(`
      func f() -> i32 => 1
      def k = 3
      data d = [1:u8]
      data e = [2:u8]
      func a() {
        d = e
        k += 1
        f = 5
      }
      func b(p: i32) {
        set d = e
        set (p, k) = (1, 2)
        set (x: p, y: f) = (x: 1, y: 2)
      }
    `)).toEqual([
      "cannot assign to 'd': it is not a variable",
      "cannot assign to 'k': it is not a variable",
      "cannot assign to 'f': it is not a variable",
      "cannot set 'd': it is not a variable",
      "cannot set 'k': it is not a variable",
      "cannot set 'f': it is not a variable",
    ])
    // Locals, params, named results and globals are.
    expect(errs(`
      global g: i32 = 0
      func a(p: i32) -> (q: i32) {
        let v = 0
        set (g, p, v) = (1, 2, 3)
        set q = g + p + v
        g = 4
        p += 1
      }
    `)).toEqual([])
  })
})

describe('a function named where a value is', () => {
  const errs = (src: string) => checkModule(src).errors.map(e => e.message)
  const none = "'f' is a function, which has no run-time value yet"

  test('is no number to cast or to compare', () => {
    expect(errs(`
      func f() -> i32 => 1
      func a() -> i64 => f as i64
      func b() -> u32 => u32(f)
      func c(p: *u8) -> bool => f == p
      func d() -> bool => (f) != f
    `)).toEqual([
      `cannot cast func() -> i32 to i64: ${none}`,
      `cannot cast func() -> i32 to u32: ${none}`,
      `'==' cannot be applied to func() -> i32 and *u8: ${none}`,
      `'!=' cannot be applied to func() -> i32 and func() -> i32: ${none}`,
    ])
  })

  test('while a function value held in a parameter still is one', () => {
    expect(errs(`
      func a(g: (i32) -> i32, h: (i32) -> i32) -> bool => g == h
      func b(g: (i32) -> i32) -> u32 => g as u32
    `)).toEqual([])
  })
})

describe('the variables of a for, an if let or a match arm', () => {
  const errs = (src: string) => checkModule(src).errors.map(e => e.message)
  const loop = (name: string, what: string) => `'${name}' is already declared: a loop variable cannot reuse the name of ${what}`
  const ifLet = (name: string, what: string) => `'${name}' is already declared: an if let binding cannot reuse the name of ${what}`
  const arm = (name: string, what: string) => `'${name}' is already declared: a match binding cannot reuse the name of ${what}`

  test('a loop variable cannot have the name of a variable seen where the loop is', () => {
    // Bug 11 of the board-builder port: the loop took the variable over.
    expect(errs('func f() -> u32 {\n let c: u32 = 5\n for c in 3 { }\n return c\n}')).toEqual([loop('c', 'a variable in scope')])
    expect(errs('func f(n: u32) -> u32 {\n let t: u32 = 0\n for n in n { t += 1 }\n return t\n}')).toEqual([loop('n', 'a parameter')])
    expect(errs('func f() -> (n: u32) {\n for n in 3 { }\n}')).toEqual([loop('n', 'a named result')])
    expect(errs('func f() {\n for i in 3 {\n for i in 4 { }\n }\n}')).toEqual([loop('i', 'a loop variable in scope')])
    // A let is seen to the end of its function, past its block.
    expect(errs('func f(c: bool) -> i64 {\n let i: i64 = 5000000000\n if c {\n for i in 3 { }\n }\n return i\n}'))
      .toEqual([loop('i', 'a variable in scope')])
    expect(errs('func f(c: bool) {\n if c {\n let k: u32 = 1\n }\n for k in 3 { }\n}')).toEqual([loop('k', 'a variable in scope')])
    expect(errs('global g: u32 = 1\nfunc f() {\n for g in 3 { }\n}')).toEqual([loop('g', 'a global')])
    // A def stands for its value wherever it is written: the loop's would never be seen.
    expect(errs('def k = 30\nfunc f() -> u32 {\n let t: u32 = 0\n for k in 3 { t += k }\n return t\n}')).toEqual([loop('k', 'a def')])
    // So does a data block, also in a deferred expression run inside the body.
    expect(errs('data d = [5:u8, 6]\nfunc use(p: *[2]u8) { }\nfunc f(xs: []u8) -> u32 {\n defer use(d)\n for d in xs {\n return 1 when d == 3\n }\n return 0\n}'))
      .toEqual([loop('d', 'a data block')])
  })

  test('both names of a loop are checked, each where it is written', () => {
    const src = 'data xs = [1:u32, 2]\nfunc f() -> u32 {\n let v: u32 = 100\n for i, v in xs { }\n return v\n}'
    const found = checkModule(src).errors
    expect(found.map(e => e.message)).toEqual([loop('v', 'a variable in scope')])
    expect(found[0].offset).toBe(src.indexOf('v in'))
    expect(errs('data xs = [1:u32, 2]\nfunc f(i: u32) {\n for i, v in xs { }\n}')).toEqual([loop('i', 'a parameter')])
    expect(errs('data xs = [1:u32, 2]\nfunc f() {\n for i, i in xs { }\n}')).toEqual([loop('i', 'a loop variable in scope')])
  })

  test('an if let binding cannot have the name of a variable seen where it is', () => {
    expect(errs('func f(p: ?*u32) -> u32 {\n if let p = p {\n return p.*\n }\n return 0\n}')).toEqual([ifLet('p', 'a parameter')])
    // Of the binding's type or another: either was a variable the branch could not see.
    expect(errs('func f(p: ?*u32) -> u32 {\n let q: ?*u32 = 0\n if let q = p {\n return q.*\n }\n return 7\n}'))
      .toEqual([ifLet('q', 'a variable in scope')])
    expect(errs('func f(p: ?*u32) -> f64 {\n let q: f64 = 0.5\n if let q = p {\n return q.* as f64\n }\n return q\n}'))
      .toEqual([ifLet('q', 'a variable in scope')])
    expect(errs('data cells = [7:u32, 8]\nfunc f(i: u32) -> u32 {\n if let v = cells[i] {\n if let v = cells[0] {\n return v\n }\n }\n return 0\n}'))
      .toEqual([ifLet('v', 'an if let binding in scope')])
    expect(errs('data cells = [7:u32, 8]\nfunc f() {\n for v in 2 {\n if let v = cells[v] { }\n }\n}'))
      .toEqual([ifLet('v', 'a loop variable in scope')])
    expect(errs('data cells = [7:u32, 8]\nfunc f(i: u32) {\n if let v = cells[i] {\n for v in 2 { }\n }\n}'))
      .toEqual([loop('v', 'an if let binding in scope')])
    // An elif let binds as an if let does.
    expect(errs('func f(c: bool, p: ?*u32) -> u32 {\n let v: u32 = 9\n if c {\n return 1\n } elif let v = p {\n return 2\n }\n return v\n}'))
      .toEqual([ifLet('v', 'a variable in scope')])
  })

  test('a match binding cannot have the name of a variable seen where the match is', () => {
    expect(errs('func f(n: u32, k: u32) -> u32 => match k {\n 0 => 1\n n => n + 1\n}')).toEqual([arm('n', 'a parameter')])
    // (A tuple pattern is refused as well: match compares no tuple yet.)
    expect(errs('func f(x: i32, p: (i32, i32)) -> i32 => match p {\n (x, 0) => 1\n _ => 0\n}')).toEqual([
      arm('x', 'a parameter'), 'match cannot compare a tuple pattern yet: compare one field at a time',
    ])
    expect(errs('func f(k: u32) -> u32 {\n let t: u32 = 0\n for n in 3 {\n t += match k {\n n => 1\n _ => 0\n }\n }\n return t\n}'))
      .toEqual([arm('n', 'a loop variable in scope')])
  })

  test('the names are free again after the body', () => {
    expect(errs(`
      data bytes = [1:u8, 2, 3]
      data wides = [1.5, 2.5]
      data cells = [7:u32, 8]
      func f(p: ?*f64) -> f64 {
        let s: f64 = 0
        for i in 3 { s += i as f64 }
        for i in 4 { s += i as f64 }
        for v in bytes { s += v as f64 }
        for v in wides { s += v }
        if let q = cells[1] { s += q as f64 }
        if let q = p { s += q.* }
        let v: f64 = 1
        let i: i64 = 5000000000
        let q: u32 = 2
        return s + v
      }
    `)).toEqual([])
    // A function of the module has no value: a binding hides it in its body.
    expect(errs('func b() -> u32 => 1\nfunc f(k: []u8) -> u32 {\n let t: u32 = 0\n for b in k { t += b as u32 }\n return t + b()\n}'))
      .toEqual([])
    // In a test, as in a function.
    expect(errs('test "t" {\n for i in 3 { }\n let i: u32 = 4\n assert i == 4\n}')).toEqual([])
    expect(errs('test "t" {\n let i: u32 = 4\n for i in 3 { }\n}')).toEqual([loop('i', 'a variable in scope')])
  })

  test('a let that takes its names from fields has a name of its own too', () => {
    const P = 'type P = (x: u32, y: u32)\n'
    const taken = (name: string) => `'${name}' is already declared in this scope`
    // In a loop of its name it took over the loop's counter: the loop ran once.
    expect(errs(`${P}func f(p: P) -> u32 {\n let t: u32 = 0\n for x in 3 {\n let (x:, y:) = p\n t += y\n }\n return t\n}`)).toEqual([taken('x')])
    expect(errs(`${P}data cells = [7:u32, 8]\nfunc f(p: P, i: u32) -> u32 {\n if let v = cells[i] {\n let (x: v, y:) = p\n return v + y\n }\n return 0\n}`))
      .toEqual([taken('v')])
    expect(errs(`${P}func f(p: P, x: u32) -> u32 {\n let (x:, y:) = p\n return x + y\n}`)).toEqual([taken('x')])
    expect(errs(`${P}func f(p: P) -> u32 {\n let y: u32 = 1\n let (x:, y:) = p\n return x + y\n}`)).toEqual([taken('y')])
    // Its names are free after a loop of them, and in another function.
    expect(errs(`${P}func f(p: P) -> u32 {\n let t: u32 = 0\n for x in 3 { t += x }\n let (x:, y: k) = p\n return t + x + k\n}\nfunc g(p: P) -> u32 {\n let (x:, y:) = p\n return x\n}`))
      .toEqual([])
    // Checked again as an operand of a builtin, it is the same declaration.
    expect(errs(`${P}func f(p: P, z: i64, c: bool) -> i64 => max(if c {\n let (x:, y:) = p\n 5\n } else { 2 }, z)`)).toEqual([])
  })

  test('a let keeps its rules: in a loop body it is seen to the end of the function', () => {
    expect(errs('func f() -> u32 {\n for i in 3 {\n let last = i\n }\n return last\n}')).toEqual([])
    expect(errs('func f() {\n for i in 3 {\n let x = i\n }\n let x = 2\n}')).toEqual(["'x' is already declared in this scope"])
    expect(errs('func f() {\n for i in 3 {\n let i = 2\n }\n}')).toEqual(["'i' is already declared in this scope"])
    expect(errs('global g: u32 = 1\nfunc f() {\n let g: u32 = 2\n}')).toEqual(["'g' is already declared in this scope"])
    // A let in the first branch of an if let is seen there alone, as it was.
    expect(errs('func f(p: ?*u32) -> u32 {\n if let v = p {\n let x: u32 = v.*\n }\n let x: u32 = 2\n return x\n}')).toEqual([])
  })

  test('a binding checked again is the same declaration', () => {
    // A constant operand of a builtin is checked twice, statements and all:
    // the let after the loop is then already there.
    expect(errs('func f(x: i64, c: bool) -> i64 => max(if c {\n for i in 3 { }\n let i = 1\n 5\n } else { 2 }, x)')).toEqual([])
    expect(errs('func f(x: i64, c: bool, p: ?*u32) -> i64 => max(if c {\n if let v = p { }\n let v = 1\n 5\n } else { 2 }, x)')).toEqual([])
    // And a real collision is reported once.
    expect(errs('func f(x: i64, c: bool) -> i64 => max(if c {\n for x in 3 { }\n 5\n } else { 2 }, x)')).toEqual([loop('x', 'a parameter')])
  })
})
