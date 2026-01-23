import { describe, expect, test } from 'bun:test'
import { parse } from './parser'

describe('parser', () => {
  describe('parse function', () => {
    test('parses empty module', () => {
      const result = parse('')
      expect(result.errors).toHaveLength(0)
      expect(result.module?.kind).toBe('Module')
      expect(result.module?.decls).toHaveLength(0)
    })

    test('parses function declaration', () => {
      const source = `func main() {}`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
      expect(result.module?.decls).toHaveLength(1)
      expect(result.module?.decls[0]?.kind).toBe('FuncDecl')
    })

    test('parses type declaration', () => {
      const source = `type Point = (x: f64, y: f64)`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
      expect(result.module?.decls).toHaveLength(1)
      expect(result.module?.decls[0]?.kind).toBe('TypeDecl')
    })

    test('parses global declaration', () => {
      const source = `global counter: i32 = 0`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
      expect(result.module?.decls).toHaveLength(1)
      expect(result.module?.decls[0]?.kind).toBe('GlobalDecl')
    })

    test('returns parse errors for invalid syntax', () => {
      const source = `func main( {`
      const result = parse(source)
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.module).toBeNull()
    })

    test('parses multiple declarations', () => {
      const source = `
        func add(a: i32, b: i32) -> i32 { return a + b }
        func sub(a: i32, b: i32) -> i32 { return a - b }
      `
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
      expect(result.module?.decls).toHaveLength(2)
    })
  })

  describe('comments', () => {
    test('parses source with comments', () => {
      const source = `
        // This is a comment
        func main() {}
      `
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
      expect(result.module?.decls).toHaveLength(1)
    })
  })
})
