import { describe, expect, test } from 'bun:test'
import { grammar, semantics } from './encantis-grammar'

describe('encantis-actions', () => {
  describe('grammar parsing', () => {
    test('parses simple function', () => {
      const source = `func add(a: i32, b: i32) -> i32 { return a + b }`
      const match = grammar.match(source)
      expect(match.succeeded()).toBe(true)
    })

    test('parses global declaration', () => {
      const source = `global counter: i32 = 0`
      const match = grammar.match(source)
      expect(match.succeeded()).toBe(true)
    })

    test('parses memory declaration', () => {
      const source = `memory 1`
      const match = grammar.match(source)
      expect(match.succeeded()).toBe(true)
    })

    test('parses memory declaration with max', () => {
      const source = `memory 1 4`
      const match = grammar.match(source)
      expect(match.succeeded()).toBe(true)
    })
  })

  describe('semantic actions', () => {
    test('converts function to AST', () => {
      const source = `func add(a: i32, b: i32) -> i32 { return a + b }`
      const match = grammar.match(source, 'FuncDecl')
      expect(match.succeeded()).toBe(true)
      
      const ast = semantics(match).toAST()
      expect(ast.kind).toBe('FuncDecl')
      expect(ast.ident).toBe('add')
    })
  })
})
