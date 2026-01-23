import { describe, expect, test } from 'bun:test'
import type * as AST from './ast'

describe('AST types', () => {
  describe('Module', () => {
    test('creates a valid module', () => {
      const module: AST.Module = {
        kind: 'Module',
        decls: [],
        span: { start: 0, end: 0 },
      }
      expect(module.kind).toBe('Module')
      expect(module.decls).toHaveLength(0)
    })
  })

  describe('FuncDecl', () => {
    test('creates a function declaration', () => {
      const funcDecl: AST.FuncDecl = {
        kind: 'FuncDecl',
        inline: false,
        ident: 'main',
        signature: {
          kind: 'FuncSignature',
          input: { kind: 'CompositeType', fields: [], span: { start: 0, end: 0 } },
          output: { kind: 'CompositeType', fields: [], span: { start: 0, end: 0 } },
          span: { start: 0, end: 0 },
        },
        body: {
          kind: 'Block',
          stmts: [],
          span: { start: 0, end: 0 },
        },
        span: { start: 0, end: 0 },
      }
      expect(funcDecl.kind).toBe('FuncDecl')
      expect(funcDecl.ident).toBe('main')
    })
  })

  describe('Literals', () => {
    test('creates an integer literal', () => {
      const intLiteral: AST.LiteralValue = {
        kind: 'int',
        value: 42n,
        radix: 10,
      }
      expect(intLiteral.kind).toBe('int')
      expect(intLiteral.value).toBe(42n)
    })

    test('creates a float literal', () => {
      const floatLiteral: AST.LiteralValue = {
        kind: 'float',
        value: 3.14,
      }
      expect(floatLiteral.kind).toBe('float')
      expect(floatLiteral.value).toBe(3.14)
    })

    test('creates a boolean literal', () => {
      const boolLiteral: AST.LiteralValue = {
        kind: 'bool',
        value: true,
      }
      expect(boolLiteral.kind).toBe('bool')
      expect(boolLiteral.value).toBe(true)
    })

    test('creates a string literal', () => {
      const bytes = new TextEncoder().encode('hello')
      const stringLiteral: AST.LiteralValue = {
        kind: 'string',
        bytes,
      }
      expect(stringLiteral.kind).toBe('string')
      expect(stringLiteral.bytes).toEqual(bytes)
    })
  })

  describe('Patterns', () => {
    test('creates an identifier pattern', () => {
      const pattern: AST.IdentPattern = {
        kind: 'IdentPattern',
        name: 'x',
        span: { start: 0, end: 1 },
      }
      expect(pattern.kind).toBe('IdentPattern')
      expect(pattern.name).toBe('x')
    })

    test('creates a tuple pattern', () => {
      const pattern: AST.TuplePattern = {
        kind: 'TuplePattern',
        elements: [
          { kind: 'positional', pattern: { kind: 'IdentPattern', name: 'x', span: { start: 0, end: 1 } } },
          { kind: 'positional', pattern: { kind: 'IdentPattern', name: 'y', span: { start: 3, end: 4 } } },
        ],
        span: { start: 0, end: 5 },
      }
      expect(pattern.kind).toBe('TuplePattern')
      expect(pattern.elements).toHaveLength(2)
    })
  })
})
