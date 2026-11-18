// The language server's hover, driven through a connection that only keeps
// the handlers the server registers.

import { describe, expect, test } from 'bun:test'
import type { Connection, Hover, MarkupContent } from 'vscode-languageserver/lib/common/api'
import { startServer } from './serve'

type Handler = (params: unknown) => unknown

// Opens `text` as a document and returns what hovering at an offset shows.
function hoverIn(text: string): (offset: number) => string | null {
  const handlers = new Map<string, Handler>()
  const connection = new Proxy({}, {
    get(_target, name: string) {
      if (name === 'languages') return { semanticTokens: { on: () => {} } }
      if (name === 'sendDiagnostics' || name === 'listen') return () => {}
      return (handler: Handler) => {
        handlers.set(name, handler)
        return { dispose() {} }
      }
    },
  }) as Connection
  startServer(connection)
  const uri = 'file:///hover.ents'
  handlers.get('onDidOpenTextDocument')?.({ textDocument: { uri, languageId: 'encantis', version: 1, text } })
  return (offset) => {
    const before = text.slice(0, offset)
    const position = { line: before.split('\n').length - 1, character: offset - before.lastIndexOf('\n') - 1 }
    const hover = handlers.get('onHover')?.({ textDocument: { uri }, position }) as Hover | null
    return hover ? (hover.contents as MarkupContent).value : null
  }
}

describe('hover', () => {
  test('a name of the module is shown where it is declared and where it is used', () => {
    const source = 'global x: u32 = 0\nexport func f(n: u32) -> u32 => n + x\n'
    const hover = hoverIn(source)
    expect(hover(source.indexOf('x:'))).toContain('global x:u32')
    expect(hover(source.indexOf('+ x') + 2)).toContain('global x:u32')
    expect(hover(source.indexOf('n +'))).toContain('n:u32')
  })

  // A generic's own names are shown with the type they are declared with and,
  // below it, their type in each instance; while nothing has called it, only
  // where a type is written. By name alone, one of its own names was shown as
  // whatever else is spelled the same.
  const generic = `global x: u32 = 0
func id(comptime T: type, x: T, max: T) -> T {
  let sqrt = x
  return if sqrt > max { sqrt } else { twice(x) }
}
func twice(n: u32) -> u32 => n * 2
`
  for (const [what, source] of [
    ['never instantiated', generic],
    ['instantiated', `${generic}export func f(n: u32) -> u32 => id(n, 9) + x\n`],
  ]) {
    test(`a generic's own names are not the module's or a builtin's (${what})`, () => {
      const hover = hoverIn(source)
      const at = (text: string) => source.indexOf(text, source.indexOf('func id'))
      const instance = '\n\n- in `id(T = u32)`: `u32`'
      // Declared with its type written: shown so with no instance too.
      const declared = (offset: number, shown: string) => {
        expect(hover(offset)).toBe(`\`\`\`encantis\n${shown}\n\`\`\`${what === 'instantiated' ? instance : ''}`)
      }
      // Used, or declared without a type: known only from an instance.
      const own = (offset: number, shown: string) => {
        if (what === 'instantiated') expect(hover(offset)).toBe(`\`\`\`encantis\n${shown}\n\`\`\`${instance}`)
        else expect(hover(offset)).toBeNull()
      }
      // The parameter x and its uses: not the global x.
      declared(at('x: T'), 'input x:T')
      own(at('= x') + 2, 'input x:T')
      own(at('twice(x)') + 6, 'input x:T')
      // A parameter and a local named like builtins.
      declared(at('max: T'), 'input max:T')
      own(at('> max') + 2, 'input max:T')
      own(at('sqrt = x'), 'let sqrt:u32')
      // The type parameter, where it is declared and where it is used.
      declared(at('T: type'), 'comptime T:type')
      declared(at('x: T') + 3, 'comptime T:type')
      // What the body names in the module is still found, and so is the
      // global outside the generic.
      expect(hover(at('twice(x)'))).toContain('twice')
      expect(hover(source.indexOf('x: u32'))).toContain('global x:u32')
    })
  }

  test('a generic type\'s own names are not the module\'s or a builtin\'s', () => {
    // Its type parameter and its fields, as declared and in each
    // application: by name, the fields were shown as the builtins min and
    // max and as the global len.
    const source = `global len: u32 = 7
func Range(comptime T: type) -> type => (min: T, max: T, len: u32)
export func f(r: Range(u8)) -> u32 => r.len + len
`
    const hover = hoverIn(source)
    const at = (text: string) => source.indexOf(text, source.indexOf('func Range'))
    const shown = (text: string, details: string) => `\`\`\`encantis\n${text}\n\`\`\`\n\n- in \`Range(u8)\`: \`${details}\``
    expect(hover(at('T: type'))).toBe(shown('comptime T:type', 'u8'))
    expect(hover(at('min: T') + 5)).toBe(shown('comptime T:type', 'u8'))
    expect(hover(at('min: T'))).toBe(shown('min:T', 'u8'))
    expect(hover(at('max: T'))).toBe(shown('max:T', 'u8'))
    expect(hover(at('len: u32'))).toBe(shown('len:u32', 'u32'))
    // The generic type is shown by its name with its applications, where it
    // is declared and where it is applied, and the global outside it.
    const range = shown('type Range = (comptime T:type) -> type => (min:T, max:T, len:u32)', '(min:u8, max:u8, len:u32)')
    expect(hover(at('Range(comptime'))).toBe(range)
    expect(hover(at('Range(u8)'))).toBe(range)
    expect(hover(source.indexOf('+ len') + 2)).toContain('global len:u32')
  })

  test('a type parameter of a generic type is not a type of the module with its name', () => {
    const source = 'type T = u64\nfunc Box(comptime T: type) -> type => (v: T)\n'
    const hover = hoverIn(source)
    expect(hover(source.indexOf('T: type'))).toBe('```encantis\ncomptime T:type\n```')
    expect(hover(source.indexOf('v: T') + 3)).toBe('```encantis\ncomptime T:type\n```')
    expect(hover(source.indexOf('T = u64'))).toContain('u64')
  })

  test('a type parameter is not a type of the module with its name', () => {
    // The checker reports the clash; the editor still must not answer for the wrong T.
    const source = 'type T = u64\nfunc id(comptime T: type, x: T) -> T => x\n'
    const hover = hoverIn(source)
    expect(hover(source.indexOf('T: type'))).toBe('```encantis\ncomptime T:type\n```')
    expect(hover(source.indexOf('x: T') + 3)).toBe('```encantis\ncomptime T:type\n```')
    expect(hover(source.indexOf('T = u64'))).toContain('u64')
  })

  // Each name is what it is where it stands. By name, a field of a type was
  // shown as the global it is spelled like, the binding of an if let had no
  // hover, the index of a for was shown as its value, and a global's own
  // declaration as a parameter spelled like it.
  test('a field, a binding and a parameter named like a global are themselves', () => {
    const source = `global x: u32 = 7
type Pt = (x: i32, y: i32)
export func f(p: Pt, xs: []u32, o: ?*u32) -> u32 {
  let s = p.x as u32
  for i, v in xs {
    s += v * i
  }
  if let q = o {
    s += q.*
  }
  return s + x
}
export func g(x: u8) -> u8 => x
`
    const hover = hoverIn(source)
    expect(hover(source.indexOf('x: i32'))).toBeNull()
    expect(hover(source.indexOf('y: i32'))).toBeNull()
    expect(hover(source.indexOf('p.x') + 2)).toContain('p.x:i32')
    expect(hover(source.indexOf('i, v'))).toContain('let i:u32')
    expect(hover(source.indexOf('v in'))).toContain('let v:u32')
    expect(hover(source.indexOf('q = o'))).toContain('let q:*u32')
    expect(hover(source.indexOf('x: u32'))).toContain('global x:u32')
    expect(hover(source.indexOf('+ x') + 2)).toContain('global x:u32')
    expect(hover(source.indexOf('x: u8'))).toContain('input x:u8')
  })
})

// The handlers the server registers for a document, called at an offset
function serverFor(text: string): (handler: string, offset: number, extra?: object) => unknown {
  const handlers = new Map<string, Handler>()
  const connection = new Proxy({}, {
    get(_target, name: string) {
      if (name === 'languages') return { semanticTokens: { on: () => {} } }
      if (name === 'sendDiagnostics' || name === 'listen') return () => {}
      return (handler: Handler) => {
        handlers.set(name, handler)
        return { dispose() {} }
      }
    },
  }) as Connection
  startServer(connection)
  const uri = 'file:///hover.ents'
  handlers.get('onDidOpenTextDocument')?.({ textDocument: { uri, languageId: 'encantis', version: 1, text } })
  return (handler, offset, extra = {}) => {
    const before = text.slice(0, offset)
    const position = { line: before.split('\n').length - 1, character: offset - before.lastIndexOf('\n') - 1 }
    return handlers.get(handler)?.({ textDocument: { uri }, position, ...extra })
  }
}

describe('generics in the editor', () => {
  const source = `func eq(a: u32, b: u32) -> bool => a == b
func eq(a: f64, b: f64) -> bool => a == b
func eq(a: i64, b: i64) -> bool => a == b
func index_of(comptime T: type, xs: []T, x: T) -> u32 {
  for i, y in xs {
    return i when eq(y, x)
  }
  return xs.len
}
func twice(n: u32) -> u32 => n * 2
data us = [1:u32, 2, 3]
data fs = [1.0:f64, 2.0]
export func f() -> u32 => index_of(us, 2) + index_of(fs, 2.0) + (7:u32).twice()
`
  const value = (hover: unknown) => ((hover as Hover).contents as MarkupContent).value

  test('hover in a generic\'s body lists what a name is and what a call calls in each instance', () => {
    const server = serverFor(source)
    expect(value(server('onHover', source.indexOf('x: T')))).toBe(
      '```encantis\ninput x:T\n```\n\n- in `index_of(T = u32)`: `u32`\n- in `index_of(T = f64)`: `f64`',
    )
    expect(value(server('onHover', source.indexOf('eq(y')))).toBe(
      '```encantis\nfunc eq(a:u32, b:u32) -> bool\n```\n\n- in `index_of(T = u32)`: `eq(a:u32, b:u32) -> bool`\n- in `index_of(T = f64)`: `eq(a:f64, b:f64) -> bool`',
    )
  })

  test('hover at a call says which instance it calls, and at a method the call it is', () => {
    const server = serverFor(source)
    expect(value(server('onHover', source.indexOf('index_of(fs')))).toBe(
      '```encantis\nfunc index_of(xs:[]f64, x:f64) -> u32\n```\n\ncalls `index_of(T = f64)`',
    )
    expect(value(server('onHover', source.indexOf('twice()')))).toBe(
      '```encantis\nfunc twice(n:u32) -> u32\n```\n\nthe call `twice((7:u32))`',
    )
  })

  test('definition and references follow what the checker recorded, per instance in a generic\'s body', () => {
    const server = serverFor(source)
    const line = (offset: number) => source.slice(0, offset).split('\n').length - 1
    const call = source.indexOf('eq(y')
    const at = (location: unknown) => (location as { range: { start: { line: number; character: number } } }).range.start
    expect(at(server('onDefinition', call))).toEqual({ line: 0, character: 5 })
    const refs = (text: string, includeDeclaration = false) =>
      (server('onReferences', source.indexOf(text), { context: { includeDeclaration } }) as unknown[]).map(at)
    const used = { line: line(call), character: call - source.lastIndexOf('\n', call) - 1 }
    expect(refs('eq(a: u32')).toEqual([used])
    expect(refs('eq(a: f64')).toEqual([used])
    // No instance has T = i64.
    expect(refs('eq(a: i64')).toEqual([])
    expect(refs('eq(a: i64', true)).toEqual([{ line: 2, character: 5 }])
  })

  test('a name with no hint is not a type parameter or a comptime parameter spelled like it', () => {
    // f in the slice has no hint, and was looked up by name: it was shown as
    // the comptime parameter f of twice.
    const program = `data space = mut [0:u8; 64]
func twice(comptime T: type, comptime f: (T) -> T, x: T) -> T => f(f(x))
func inc(x: u32) -> u32 => x + 1
func sum(xs: []u32) -> u32 => xs.len
export func g() -> u32 => twice(inc, 1)
test "t" {
  let f = space as [*]mut u32
  f[0] = 1
  assert sum(f[0..1]) == 1
}
`
    const server = serverFor(program)
    const shown = server('onHover', program.indexOf('f[0..1]')) as Hover | null
    expect(shown === null || !value(shown).includes('comptime')).toBe(true)
    // Where they have hints, they are themselves.
    expect(value(server('onHover', program.indexOf('f: (T)')))).toStartWith('```encantis\ncomptime f:(T) -> T\n```')
    expect(value(server('onHover', program.indexOf('f(x)')))).toStartWith('```encantis\ncomptime f:(T) -> T\n```')
  })
})
