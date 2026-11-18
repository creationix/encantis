// What is left out of text that does not parse for the rest to parse.

import { describe, expect, test } from 'bun:test'
import { parse } from '@encantis/compiler/parser'
import { recoverParse } from './recover'

// The names of the declarations that parse, and what was left out
function recovered(text: string): { declared: string[]; leftOut: string[] } | null {
  const result = recoverParse(text, (t) => parse(t))
  if (!result) return null
  // Every offset of the rest is where it is in the text.
  expect(result.text.length).toBe(text.length)
  expect(result.text.split('\n').length).toBe(text.split('\n').length)
  const declared = result.module.decls.map((decl) => {
    const item = decl.kind === 'ExportDecl' ? decl.item : decl
    return item.kind === 'FuncDecl' ? (item.ident ?? '') : item.kind
  })
  return { declared, leftOut: result.leftOut.map((span) => text.slice(span.start, span.end)) }
}

const b = 'func b() -> u32 => 2\n'
const f = 'export func f() -> u32 => b()\n'

describe('text that does not parse', () => {
  test('a line between declarations is left out', () => {
    expect(recovered(`func a() -> u32 => 1\n${b}${f}let = \n`)).toEqual({ declared: ['a', 'b', 'f'], leftOut: ['let = \n'] })
    expect(recovered(`func a() -> u32 => 1\n}\n${b}`)).toEqual({ declared: ['a', 'b'], leftOut: ['}\n'] })
    expect(recovered(`fucn a() -> u32 => 1\n${b}${f}`)).toEqual({ declared: ['b', 'f'], leftOut: ['fucn a() -> u32 => 1\n'] })
  })

  // Where the parser read on into the line, the line goes on with the
  // declaration before it: without the line that one would be another
  // (k = 1 where the text says 1 + 2 and more), so it is left out with it.
  test('a line that goes on with the declaration before it is left out with that', () => {
    expect(recovered(`def k = 1\n  + 2 3\n${b}${f}`)).toEqual({ declared: ['b', 'f'], leftOut: ['def k = 1\n  + 2 3\n'] })
    expect(recovered(`func a() -> u32 => 1\n  + 2 3\n${b}`)).toEqual({ declared: ['b'], leftOut: ['func a() -> u32 => 1\n  + 2 3\n'] })
    // A line before the first declaration goes on with none.
    expect(recovered(`  2 3\n${b}`)).toEqual({ declared: ['b'], leftOut: ['  2 3\n'] })
  })

  test('a declaration that does not end, or is broken inside, is left out', () => {
    expect(recovered(`func a() -> u32 {\n  let x = 1\n\n${b}${f}`)).toEqual({ declared: ['b', 'f'], leftOut: ['func a() -> u32 {\n  let x = 1\n\n'] })
    expect(recovered(`func a() -> u32 {\n  let x = \n  return 1\n}\n${b}${f}`)).toEqual({ declared: ['b', 'f'], leftOut: ['func a() -> u32 {\n  let x = \n  return 1\n}\n'] })
    expect(recovered(`func a( -> u32 => 1\n${b}`)).toEqual({ declared: ['b'], leftOut: ['func a( -> u32 => 1\n'] })
    expect(recovered(`func a() -> u32 => 1\nexport func f() -> u32 {\n  return a(\n}\n${b}`)).toEqual({ declared: ['a', 'b'], leftOut: ['export func f() -> u32 {\n  return a(\n}\n'] })
    expect(recovered(`func a() -> u8 => ''\n${b}`)).toEqual({ declared: ['b'], leftOut: ["func a() -> u8 => ''\n"] })
  })

  // A literal or a comment that is not closed runs on over the rest: the
  // parser stops at the end of the text, or past the next quote of its kind.
  test('a literal or a comment that is not closed is left out with its declaration', () => {
    for (const open of ['"abc', '`abc', "'x", '1 /* x']) {
      expect(recovered(`func a() -> u32 => ${open}\n${b}${f}`)).toEqual({ declared: ['b', 'f'], leftOut: [`func a() -> u32 => ${open}\n`] })
    }
    expect(recovered(`func a() -> []u8 => "abc\n${b}func c() -> []u8 => "c"\n${f}`)).toEqual({ declared: ['b', 'c', 'f'], leftOut: ['func a() -> []u8 => "abc\n'] })
  })

  test('each place that does not parse is left out', () => {
    expect(recovered(`func a() -> u32 => \n${b}func c( => 3\n${f}`)).toEqual({ declared: ['b', 'f'], leftOut: ['func a() -> u32 => \n', 'func c( => 3\n'] })
  })

  // A line of a template's text can start like a declaration.
  test('what looks like a declaration in a template is its text', () => {
    expect(recovered('func a() -> [][]u8 => `x\nfunc b() -> u32 => 2\n` + \nfunc c() -> u32 => 3\n')).toEqual({ declared: ['c'], leftOut: ['func a() -> [][]u8 => `x\nfunc b() -> u32 => 2\n` + \n'] })
  })

  test('text that parses is as it is', () => {
    expect(recovered(`${b}${f}`)).toEqual({ declared: ['b', 'f'], leftOut: [] })
  })
})
