import { describe, expect, test } from 'bun:test'
import { parse } from './parser'
import type { EnumDecl } from './ast'

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

  describe('enum declarations', () => {
    test('parses simple enum with unit variants', () => {
      const source = `enum Color { Red, Blue, Green }`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
      expect(result.module?.decls).toHaveLength(1)
      const decl = result.module?.decls[0] as EnumDecl
      expect(decl.kind).toBe('EnumDecl')
      expect(decl.ident).toBe('Color')
      expect(decl.variants).toHaveLength(3)
      expect(decl.variants[0].name).toBe('Red')
      expect(decl.variants[0].fields).toBeNull()
    })

    test('parses enum with payload variants', () => {
      const source = `enum Option { None, Some(value: i32) }`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
      const decl = result.module?.decls[0] as EnumDecl
      expect(decl.kind).toBe('EnumDecl')
      expect(decl.variants).toHaveLength(2)
      expect(decl.variants[0].name).toBe('None')
      expect(decl.variants[0].fields).toBeNull()
      expect(decl.variants[1].name).toBe('Some')
      expect(decl.variants[1].fields).toHaveLength(1)
    })

    test('parses enum with multiple field variants', () => {
      const source = `enum Color { RGB(r: u8, g: u8, b: u8), Grey(b: u8) }`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
      const decl = result.module?.decls[0] as EnumDecl
      expect(decl.variants[0].name).toBe('RGB')
      expect(decl.variants[0].fields).toHaveLength(3)
      expect(decl.variants[1].name).toBe('Grey')
      expect(decl.variants[1].fields).toHaveLength(1)
    })

    test('parses enum with positional fields', () => {
      const source = `enum Json { Number(f64), Boolean(bool) }`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
      const decl = result.module?.decls[0] as EnumDecl
      expect(decl.variants[0].fields).toHaveLength(1)
    })
  })

  describe('match expressions', () => {
    test('parses match with literal patterns', () => {
      const source = `func test(x: i32) -> i32 { match x { 0 => 1, 1 => 2, _ => 0 } }`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
    })

    test('parses match with variant patterns', () => {
      const source = `func test(c: Color) { match c { Red => 1, Blue => 2 } }`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
    })

    test('parses match with constructor patterns', () => {
      const source = `func test(c: Color) { match c { RGB(r, g, b) => r, Grey(b) => b } }`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
    })

    test('parses match with tuple patterns', () => {
      const source = `func test(p: (i32, i32)) { match p { (0, y) => y, (x, 0) => x, _ => 0 } }`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
    })

    test('parses match with named pattern elements', () => {
      const source = `func test(p: Point) { match p { Point(x: 0, y:) => y, _ => 0 } }`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
    })

    test('parses match with binding patterns', () => {
      const source = `func test(x: i32) { match x { n => n * 2 } }`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
    })
  })

  describe('if-let expressions', () => {
    test('parses if-let with variant pattern', () => {
      const source = `func test(c: Color) { if let RGB(r, g, b) = c { r } }`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
    })

    test('parses if-let with else branch', () => {
      const source = `func test(opt: Option) { if let Some(x) = opt { x } else { 0 } }`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
    })

    test('parses if-let with elif-let', () => {
      const source = `func test(c: Color) { if let RGB(r, g, b) = c { r } elif let Grey(b) = c { b } else { 0 } }`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
    })

    test('parses if-let with tuple pattern', () => {
      const source = `func test(p: (i32, i32)) { if let (0, y) = p { y } }`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
    })

    test('parses mixed if and elif-let', () => {
      const source = `func test(c: Color, x: bool) { if x { 1 } elif let RGB(r, g, b) = c { r } else { 0 } }`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
    })
  })
})
