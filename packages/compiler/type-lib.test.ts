import { describe, test, expect } from 'bun:test'
import { parseType, parseTypeAST, astToResolved } from './type-lib'
import { typeToString } from './types'

describe('parseType', () => {
  test('parses primitive types', () => {
    const t = parseType('i32')
    expect(t.kind).toBe('primitive')
  })

  test('parses pointer types', () => {
    const t = parseType('*i32')
    expect(t.kind).toBe('pointer')
  })

  test('parses slice types', () => {
    const t = parseType('[]u8')
    expect(t.kind).toBe('indexed')
  })

  test('parses tuple types', () => {
    const t = parseType('(i32, f64)')
    expect(t.kind).toBe('tuple')
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
