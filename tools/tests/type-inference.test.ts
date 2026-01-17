import { describe, test, expect } from 'bun:test'
import { parse } from '../parser'
import { check, type TypeCheckResult } from '../checker'
import { typeToString } from '../types'

// Helper to parse and check a module
function checkModule(source: string): TypeCheckResult {
  const result = parse(source)
  if (result.errors.length > 0) {
    throw new Error(`Parse error: ${result.errors[0].message}`)
  }
  return check(result.module!)
}

// Helper to get the type of an expression at a specific offset
function typeAt(result: TypeCheckResult, offset: number): string | undefined {
  const type = result.types.get(offset)
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
        const aType = result.types.get(aOffset)
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
        const type = result.types.get(offset)
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
        const type = result.types.get(offset)
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
        const type = result.types.get(offset)
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
    test('string literal to u8[] parameter', () => {
      const result = checkModule(`
        import "test" "log" func log(str: u8[])
        func main() {
          log("hello")
        }
      `)
      expect(result.errors).toHaveLength(0)
    })

    test('string literal to u8[/0] parameter', () => {
      const result = checkModule(`
        import "test" "log" func log(str: u8[/0])
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
    test('infers element type from elements', () => {
      const result = checkModule(`
        func main() {
          let arr = [1, 2, 3]
        }
      `)
      expect(result.errors).toHaveLength(0)
      const offset = result.symbolDefOffsets.get('arr')
      if (offset !== undefined) {
        const type = result.types.get(offset)
        expect(type).toBeDefined()
        expect(typeToString(type!)).toBe('i32[3]')
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
  })

  describe('tagged types', () => {
    test('tagged type in type annotation', () => {
      const result = checkModule(`
        func main() {
          let idx: u8@Index = 0
        }
      `)
      expect(result.errors).toHaveLength(0)
    })

    test('tagged type rejects plain value assignment', () => {
      const result = checkModule(`
        func main() {
          let idx: u8@Index = 0
          let plain: u8 = idx
        }
      `)
      // The plain: u8 = idx should fail because you can't assign tagged to plain
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].message).toContain('cannot assign')
    })
  })
})
