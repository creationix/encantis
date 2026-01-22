import { describe, expect, test } from 'bun:test'
import { parse } from '../parser'
import type * as AST from '../ast'
import { collectDefs, inlineDefsExpr, inlineDefs } from '../preprocess'

// === Test Helpers ===

/**
 * Parse a module and collect defs.
 */
function parseDefs(code: string) {
  const result = parse(code)
  if (result.errors.length > 0) {
    throw new Error(`Parse error: ${result.errors[0].message}`)
  }
  return collectDefs(result.module!)
}

/**
 * Parse an expression for testing.
 */
function parseExpr(code: string): AST.Expr {
  const wrappedCode = `func () => ${code}`
  const result = parse(wrappedCode)
  if (result.errors.length > 0) {
    throw new Error(`Parse error: ${result.errors[0].message}`)
  }
  const funcDecl = result.module!.decls[0] as AST.FuncDecl
  if (funcDecl.body.kind !== 'ArrowBody') {
    throw new Error('Expected arrow body')
  }
  return funcDecl.body.expr
}

/**
 * Parse a module and inline defs.
 */
function parseAndInline(code: string): AST.Module {
  const result = parse(code)
  if (result.errors.length > 0) {
    throw new Error(`Parse error: ${result.errors[0].message}`)
  }
  return inlineDefs(result.module!)
}

/**
 * Get the value of a literal expression.
 */
function getLiteralValue(expr: AST.Expr): bigint | number | boolean | null {
  if (expr.kind === 'LiteralExpr') {
    const lit = expr.value
    if (lit.kind === 'int') return lit.value
    if (lit.kind === 'float') return lit.value
    if (lit.kind === 'bool') return lit.value
  }
  if (expr.kind === 'AnnotationExpr') {
    return getLiteralValue(expr.expr)
  }
  return null
}

// === collectDefs Tests ===

describe('collectDefs', () => {
  test('collects single def', () => {
    const defs = parseDefs(`def x = 42`)
    expect(defs.values.has('x')).toBe(true)
    expect(getLiteralValue(defs.values.get('x')!)).toBe(42n)
  })

  test('collects multiple defs', () => {
    const defs = parseDefs(`
      def a = 1
      def b = 2
      def c = 3
    `)
    expect(defs.values.size).toBe(3)
    expect(getLiteralValue(defs.values.get('a')!)).toBe(1n)
    expect(getLiteralValue(defs.values.get('b')!)).toBe(2n)
    expect(getLiteralValue(defs.values.get('c')!)).toBe(3n)
  })

  test('collects typed defs', () => {
    const defs = parseDefs(`def prime = 2654435761:u32`)
    expect(defs.values.has('prime')).toBe(true)
    // The value is an AnnotationExpr wrapping a LiteralExpr
    const value = defs.values.get('prime')!
    expect(getLiteralValue(value)).toBe(2654435761n)
  })

  test('ignores non-def declarations', () => {
    const defs = parseDefs(`
      def x = 1
      func foo() {}
      global y: i32 = 2
    `)
    expect(defs.values.size).toBe(1)
    expect(defs.values.has('x')).toBe(true)
  })
})

// === inlineDefsExpr Tests ===

describe('inlineDefsExpr', () => {
  test('replaces single identifier', () => {
    const defs = parseDefs(`def x = 42`)
    const expr = parseExpr('x')
    const result = inlineDefsExpr(expr, defs)

    expect(result.kind).toBe('LiteralExpr')
    expect(getLiteralValue(result)).toBe(42n)
  })

  test('leaves non-def identifiers unchanged', () => {
    const defs = parseDefs(`def x = 42`)
    const expr = parseExpr('y')
    const result = inlineDefsExpr(expr, defs)

    expect(result.kind).toBe('IdentExpr')
    expect((result as AST.IdentExpr).name).toBe('y')
  })

  test('replaces in binary expression', () => {
    const defs = parseDefs(`def x = 10`)
    const expr = parseExpr('x + 5')
    const result = inlineDefsExpr(expr, defs)

    expect(result.kind).toBe('BinaryExpr')
    const binary = result as AST.BinaryExpr
    expect(getLiteralValue(binary.left)).toBe(10n)
    expect(getLiteralValue(binary.right)).toBe(5n)
  })

  test('replaces both sides of binary expression', () => {
    const defs = parseDefs(`
      def a = 3
      def b = 7
    `)
    const expr = parseExpr('a * b')
    const result = inlineDefsExpr(expr, defs)

    expect(result.kind).toBe('BinaryExpr')
    const binary = result as AST.BinaryExpr
    expect(getLiteralValue(binary.left)).toBe(3n)
    expect(getLiteralValue(binary.right)).toBe(7n)
  })

  test('replaces in nested expressions', () => {
    const defs = parseDefs(`def x = 2`)
    const expr = parseExpr('(x + 1) * x')
    const result = inlineDefsExpr(expr, defs)

    expect(result.kind).toBe('BinaryExpr')
    const binary = result as AST.BinaryExpr

    // Left side: (x + 1) -> (2 + 1)
    // Parser may treat single-element parens as TupleExpr
    expect(['GroupExpr', 'TupleExpr']).toContain(binary.left.kind)
    let innerBinary: AST.BinaryExpr
    if (binary.left.kind === 'GroupExpr') {
      const group = binary.left as AST.GroupExpr
      innerBinary = group.expr as AST.BinaryExpr
    } else {
      // TupleExpr with single element
      const tuple = binary.left as AST.TupleExpr
      innerBinary = tuple.elements[0].value as AST.BinaryExpr
    }
    expect(innerBinary.kind).toBe('BinaryExpr')
    expect(getLiteralValue(innerBinary.left)).toBe(2n)

    // Right side: x -> 2
    expect(getLiteralValue(binary.right)).toBe(2n)
  })

  test('replaces in unary expression', () => {
    const defs = parseDefs(`def x = 5`)
    const expr = parseExpr('-x')
    const result = inlineDefsExpr(expr, defs)

    expect(result.kind).toBe('UnaryExpr')
    const unary = result as AST.UnaryExpr
    expect(getLiteralValue(unary.operand)).toBe(5n)
  })

  test('preserves typed def values', () => {
    const defs = parseDefs(`def prime = 2654435761:u32`)
    const expr = parseExpr('prime')
    const result = inlineDefsExpr(expr, defs)

    expect(result.kind).toBe('AnnotationExpr')
    expect(getLiteralValue(result)).toBe(2654435761n)
  })
})

// === inlineDefs (full module) Tests ===

describe('inlineDefs', () => {
  test('inlines defs in function body', () => {
    const module = parseAndInline(`
      def x = 42
      func test() -> i32 => x
    `)

    const funcDecl = module.decls.find((d) => d.kind === 'FuncDecl' && d.ident === 'test') as AST.FuncDecl
    expect(funcDecl).toBeDefined()
    expect(funcDecl.body.kind).toBe('ArrowBody')
    const body = funcDecl.body as AST.ArrowBody
    expect(getLiteralValue(body.expr)).toBe(42n)
  })

  test('inlines defs in block body', () => {
    const module = parseAndInline(`
      def multiplier = 2
      func double(x: i32) -> i32 {
        return x * multiplier
      }
    `)

    const funcDecl = module.decls.find((d) => d.kind === 'FuncDecl' && d.ident === 'double') as AST.FuncDecl
    expect(funcDecl.body.kind).toBe('Block')
    const block = funcDecl.body as AST.Block
    const returnStmt = block.stmts[0] as AST.ReturnStmt
    expect(returnStmt.value?.kind).toBe('BinaryExpr')
    const binary = returnStmt.value as AST.BinaryExpr
    expect(getLiteralValue(binary.right)).toBe(2n)
  })

  test('inlines defs in exported function', () => {
    const module = parseAndInline(`
      def answer = 42
      export "getAnswer" func getAnswer() -> i32 => answer
    `)

    const exportDecl = module.decls.find((d) => d.kind === 'ExportDecl') as AST.ExportDecl
    expect(exportDecl.item.kind).toBe('FuncDecl')
    const funcDecl = exportDecl.item as AST.FuncDecl
    expect(funcDecl.body.kind).toBe('ArrowBody')
    const body = funcDecl.body as AST.ArrowBody
    expect(getLiteralValue(body.expr)).toBe(42n)
  })

  test('inlines multiple defs in complex expression', () => {
    const module = parseAndInline(`
      def prime1 = 2654435761:u32
      def prime2 = 2246822519:u32
      func hash(seed: u32, value: u32) -> u32 {
        return seed + value * prime2
      }
    `)

    const funcDecl = module.decls.find((d) => d.kind === 'FuncDecl' && d.ident === 'hash') as AST.FuncDecl
    const block = funcDecl.body as AST.Block
    const returnStmt = block.stmts[0] as AST.ReturnStmt
    expect(returnStmt.value?.kind).toBe('BinaryExpr')

    // seed + (value * prime2)
    const addExpr = returnStmt.value as AST.BinaryExpr
    expect(addExpr.op).toBe('+')
    expect(addExpr.right.kind).toBe('BinaryExpr')
    const mulExpr = addExpr.right as AST.BinaryExpr
    expect(mulExpr.op).toBe('*')
    expect(getLiteralValue(mulExpr.right)).toBe(2246822519n)
  })

  test('inlines defs in global initializer', () => {
    const module = parseAndInline(`
      def defaultValue = 100
      global counter: i32 = defaultValue
    `)

    const globalDecl = module.decls.find((d) => d.kind === 'GlobalDecl') as AST.GlobalDecl
    expect(globalDecl.value).toBeDefined()
    expect(getLiteralValue(globalDecl.value!)).toBe(100n)
  })

  test('inlines defs in let statement', () => {
    const module = parseAndInline(`
      def initial = 0
      func test() {
        let x: i32 = initial
      }
    `)

    const funcDecl = module.decls.find((d) => d.kind === 'FuncDecl') as AST.FuncDecl
    const block = funcDecl.body as AST.Block
    const letStmt = block.stmts[0] as AST.LetStmt
    expect(getLiteralValue(letStmt.value!)).toBe(0n)
  })

  test('inlines defs in assignment', () => {
    const module = parseAndInline(`
      def resetValue = 0
      func test(x: i32) {
        x = resetValue
      }
    `)

    const funcDecl = module.decls.find((d) => d.kind === 'FuncDecl') as AST.FuncDecl
    const block = funcDecl.body as AST.Block
    const assignStmt = block.stmts[0] as AST.AssignmentStmt
    expect(getLiteralValue(assignStmt.value)).toBe(0n)
  })

  test('inlines defs in while condition', () => {
    const module = parseAndInline(`
      def maxIterations = 100
      func test() {
        let i: i32 = 0
        while i < maxIterations {
          i += 1
        }
      }
    `)

    const funcDecl = module.decls.find((d) => d.kind === 'FuncDecl') as AST.FuncDecl
    const block = funcDecl.body as AST.Block
    const whileStmt = block.stmts[1] as AST.WhileStmt
    expect(whileStmt.condition.kind).toBe('BinaryExpr')
    const cond = whileStmt.condition as AST.BinaryExpr
    expect(getLiteralValue(cond.right)).toBe(100n)
  })

  test('inlines defs in if condition', () => {
    const module = parseAndInline(`
      def threshold = 10
      func test(x: i32) -> i32 => if x > threshold { 1 } else { 0 }
    `)

    const funcDecl = module.decls.find((d) => d.kind === 'FuncDecl') as AST.FuncDecl
    const body = funcDecl.body as AST.ArrowBody
    expect(body.expr.kind).toBe('IfExpr')
    const ifExpr = body.expr as AST.IfExpr
    expect(ifExpr.condition.kind).toBe('BinaryExpr')
    const cond = ifExpr.condition as AST.BinaryExpr
    expect(getLiteralValue(cond.right)).toBe(10n)
  })

  test('def can reference another def', () => {
    const module = parseAndInline(`
      def base = 10
      def doubled = base
      func test() -> i32 => doubled
    `)

    // After inlining, doubled should be replaced with base's value
    const funcDecl = module.decls.find((d) => d.kind === 'FuncDecl') as AST.FuncDecl
    const body = funcDecl.body as AST.ArrowBody
    // Note: This test shows that def-to-def references are inlined
    // The value will be 10n because doubled references base
    expect(getLiteralValue(body.expr)).toBe(10n)
  })
})
