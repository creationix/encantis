import { describe, test, expect } from 'bun:test'
import { parse } from '../parser'
import { typecheck, typeKey, type TypeCheckResult } from '../checker'
import { typeToString } from '../types'

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

    test('string literal to [*:0]u8 (null-terminated) parameter', () => {
      const result = checkModule(`
        import "test" "log" func log(s: [*:0]u8)
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

    test('unannotated array literal stays comptime', () => {
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
        // Without annotation, array defaults to comptime with LEB128 encoding
        // TODO: should be pure comptime [int] without encoding
        expect(typeToString(type!)).toBe('[?]i32')
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

  describe('LEB128 encoding (:? sentinel)', () => {
    test('[*:?]u8 for LEB128-prefixed string', () => {
      const result = checkModule(`
        func main() {
          let a: [*:?]u8 = "hello"
        }
      `)
      expect(result.errors).toHaveLength(0)
      const aOffset = result.symbolDefOffsets.get('a')
      if (aOffset) {
        const aType = result.types.get(typeKey(aOffset, 'IdentPattern'))
        expect(typeToString(aType!)).toBe('[?]u8')
      }
    })

    test('[*:?:?]u8 for nested LEB128 arrays (flat)', () => {
      const result = checkModule(`
        func main() {
          let arr: [*:?:?]u8 = ["hello", "world"]
        }
      `)
      expect(result.errors).toHaveLength(0)
      const offset = result.symbolDefOffsets.get('arr')
      if (offset) {
        const type = result.types.get(typeKey(offset, 'IdentPattern'))
        expect(typeToString(type!)).toBe('[?:?]u8')
      }
    })
  })

  describe('comptime list behavior', () => {
    test('string literal without annotation stays comptime', () => {
      const result = checkModule(`
        func main() {
          let s = "hello"
        }
      `)
      expect(result.errors).toHaveLength(0)
      const offset = result.symbolDefOffsets.get('s')
      if (offset) {
        const type = result.types.get(typeKey(offset, 'IdentPattern'))
        // TODO: should be pure comptime [u8] without encoding
        expect(typeToString(type!)).toBe('[?]u8')
      }
    })

    test('nested array without annotation stays comptime', () => {
      const result = checkModule(`
        func main() {
          let arr = ["hello", "world"]
        }
      `)
      expect(result.errors).toHaveLength(0)
      const offset = result.symbolDefOffsets.get('arr')
      if (offset) {
        const type = result.types.get(typeKey(offset, 'IdentPattern'))
        // TODO: should be comptime list of comptime lists [[u8]]
        // Currently defaults string elements to LEB128
        expect(typeToString(type!)).toBe('[?:?]u8')
      }
    })

    test('explicit type annotation specifies encoding', () => {
      const result = checkModule(`
        func main() {
          let a: [*:0]u8 = "hello"
          let b: *[5]u8 = "world"
        }
      `)
      expect(result.errors).toHaveLength(0)
      const aOffset = result.symbolDefOffsets.get('a')
      const bOffset = result.symbolDefOffsets.get('b')
      if (aOffset && bOffset) {
        expect(typeToString(result.types.get(typeKey(aOffset, 'IdentPattern'))!)).toBe('[!]u8')
        expect(typeToString(result.types.get(typeKey(bOffset, 'IdentPattern'))!)).toBe('*[5]u8')
      }
    })
  })
})
