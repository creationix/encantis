import { describe, test, expect } from 'bun:test'
import { parse } from './parser'
import { typecheck } from './checker'
import {
  gotoDefinition,
  hover,
  findReferences,
  documentSymbols,
  signatureHelp,
} from './queries'

function setup(code: string) {
  const result = parse(code)
  expect(result.errors).toEqual([])
  const check = typecheck(result.module!)
  return { source: code, module: result.module!, check }
}

describe('gotoDefinition', () => {
  test('finds function definition', () => {
    const code = `func add(a: i32, b: i32) -> i32 => a + b\nfunc test() -> i32 => add(1, 2)`
    const { source, module, check } = setup(code)

    // Find 'add' in the call site (second occurrence)
    const callOffset = code.lastIndexOf('add')
    const result = gotoDefinition(source, module, check, callOffset)
    expect(result).not.toBeNull()
    expect(result!.name).toBe('add')
    // Definition offset is the span start (start of 'func' keyword)
    expect(result!.location.offset).toBe(0)
  })

  test('finds global definition', () => {
    const code = `global counter: i32 = 0\nfunc inc() { counter += 1 }`
    const { source, module, check } = setup(code)

    const useOffset = code.lastIndexOf('counter')
    const result = gotoDefinition(source, module, check, useOffset)
    expect(result).not.toBeNull()
    expect(result!.name).toBe('counter')
  })

  test('returns null for non-identifier position', () => {
    const code = `func test() -> i32 => 42`
    const { source, module, check } = setup(code)

    // Offset at '(' which is not an identifier
    const parenOffset = code.indexOf('(')
    const result = gotoDefinition(source, module, check, parenOffset)
    expect(result).toBeNull()
  })
})

describe('hover', () => {
  test('shows function type', () => {
    const code = `func add(a: i32, b: i32) -> i32 => a + b`
    const { source, module, check } = setup(code)

    const offset = code.indexOf('add')
    const result = hover(source, module, check, offset)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('func')
    expect(result!.type).toContain('i32')
  })

  test('shows def value', () => {
    const code = `def magic = 42:u32`
    const { source, module, check } = setup(code)

    const offset = code.indexOf('magic')
    const result = hover(source, module, check, offset)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('def')
    expect(result!.value).toBe('42')
  })

  test('shows global type', () => {
    const code = `global x: u64 = 0`
    const { source, module, check } = setup(code)

    const offset = code.indexOf('x')
    const result = hover(source, module, check, offset)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('global')
    expect(result!.type).toBe('u64')
  })
})

describe('findReferences', () => {
  test('finds all references to a function', () => {
    const code = `func add(a: i32, b: i32) -> i32 => a + b\nfunc test() -> i32 => add(1, 2)\nfunc test2() -> i32 => add(3, 4)`
    const { source, module, check } = setup(code)

    const offset = code.indexOf('add')
    const result = findReferences(source, module, check, offset)
    expect(result).not.toBeNull()
    expect(result!.references.length).toBeGreaterThanOrEqual(2)
  })

  test('returns empty refs for unused symbol', () => {
    const code = `func unused() -> i32 => 42`
    const { source, module, check } = setup(code)

    const offset = code.indexOf('unused')
    const result = findReferences(source, module, check, offset)
    expect(result).not.toBeNull()
    expect(result!.references.length).toBe(0)
  })
})

describe('documentSymbols', () => {
  test('lists all top-level declarations', () => {
    const code = `
def pi = 3:u32
global counter: i32 = 0
type Point = (x: i32, y: i32)
func add(a: i32, b: i32) -> i32 => a + b
export func main() {}
`
    const { source, module, check } = setup(code)
    const symbols = documentSymbols(source, module, check)

    const names = symbols.map(s => s.name)
    expect(names).toContain('pi')
    expect(names).toContain('counter')
    expect(names).toContain('Point')
    expect(names).toContain('add')
    expect(names).toContain('main')

    const main = symbols.find(s => s.name === 'main')!
    expect(main.exported).toBe(true)

    const add = symbols.find(s => s.name === 'add')!
    expect(add.exported).toBe(false)
    expect(add.kind).toBe('func')
  })
})

describe('signatureHelp', () => {
  test('returns function signature', () => {
    const code = `func add(a: i32, b: i32) -> i32 => a + b`
    const { source, module, check } = setup(code)

    const offset = code.indexOf('add')
    const result = signatureHelp(source, module, check, offset)
    expect(result).not.toBeNull()
    expect(result!.name).toBe('add')
    expect(result!.params).toHaveLength(2)
    expect(result!.params[0].name).toBe('a')
    expect(result!.params[0].type).toBe('i32')
    expect(result!.params[1].name).toBe('b')
  })

  test('handles named returns', () => {
    const code = `func reserve(size: u32) -> (offset: u32) { offset = 0 }`
    const { source, module, check } = setup(code)

    const offset = code.indexOf('reserve')
    const result = signatureHelp(source, module, check, offset)
    expect(result).not.toBeNull()
    expect(result!.returnType).toContain('offset')
    expect(result!.returnType).toContain('u32')
  })

  test('returns null for non-function', () => {
    const code = `global x: i32 = 0`
    const { source, module, check } = setup(code)

    const offset = code.indexOf('x')
    const result = signatureHelp(source, module, check, offset)
    expect(result).toBeNull()
  })
})
