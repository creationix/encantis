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
  test('a literal in single quotes shows its codepoints', () => {
    const source = "export func f(c: u8) -> bool => c == 'a' || c == '\\n'\nexport func g() -> i32 {\n  let (o, k) = 'ok'\n  return o + k\n}\n"
    const hover = hoverIn(source)
    expect(hover(source.indexOf("'a'"))).toContain("'a':u8 = 97")
    expect(hover(source.indexOf("'a'") + 1)).toContain("'a':u8 = 97")
    expect(hover(source.indexOf("'\\n'") + 2)).toContain("'\\n':u8 = 10")
    expect(hover(source.indexOf("'ok'") + 2)).toContain("'ok':(i32, i32) = (111, 107)")
  })

  test('a name of the module is shown where it is declared and where it is used', () => {
    const source = 'global x: u32 = 0\nexport func f(n: u32) -> u32 => n + x\n'
    const hover = hoverIn(source)
    expect(hover(source.indexOf('x:'))).toContain('global x:u32')
    expect(hover(source.indexOf('+ x') + 2)).toContain('global x:u32')
    expect(hover(source.indexOf('n +'))).toContain('n:u32')
  })

  // A generic's parameters and body are shown as its first instance has them,
  // and not at all while nothing has called it. By name alone, one of its own
  // names was shown as whatever else is spelled the same.
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
      const own = (offset: number, shown: string) => {
        if (what === 'instantiated') expect(hover(offset)).toContain(shown)
        else expect(hover(offset)).toBeNull()
      }
      // The parameter x and its uses: not the global x.
      own(at('x: T'), 'input x:u32')
      own(at('= x') + 2, 'input x:u32')
      own(at('twice(x)') + 6, 'input x:u32')
      // A parameter and a local named like builtins.
      own(at('max: T'), 'input max:u32')
      own(at('> max') + 2, 'input max:u32')
      own(at('sqrt = x'), 'let sqrt:u32')
      // The type parameter.
      expect(hover(at('T: type'))).toBeNull()
      expect(hover(at('x: T') + 3)).toBeNull()
      // What the body names in the module is still found, and so is the
      // global outside the generic.
      expect(hover(at('twice(x)'))).toContain('twice')
      expect(hover(source.indexOf('x: u32'))).toContain('global x:u32')
    })
  }

  test('a generic type\'s own names are not the module\'s or a builtin\'s', () => {
    // Its type parameter and its fields: by name, the fields were shown as
    // the builtins min and max and as the global len.
    const source = `global len: u32 = 7
func Range(comptime T: type) -> type => (min: T, max: T, len: u32)
export func f(r: Range(u8)) -> u32 => r.len + len
`
    const hover = hoverIn(source)
    const at = (text: string) => source.indexOf(text, source.indexOf('func Range'))
    expect(hover(at('T: type'))).toBeNull()
    expect(hover(at('min: T') + 5)).toBeNull()
    expect(hover(at('min: T'))).toBeNull()
    expect(hover(at('max: T'))).toBeNull()
    expect(hover(at('len: u32'))).toBeNull()
    // The generic type is still shown by its name, where it is declared and
    // where it is applied, and the global outside it.
    expect(hover(at('Range(comptime'))).toContain('Range')
    expect(hover(at('Range(u8)'))).toContain('Range')
    expect(hover(source.indexOf('+ len') + 2)).toContain('global len:u32')
  })

  test('a type parameter of a generic type is not a type of the module with its name', () => {
    const source = 'type T = u64\nfunc Box(comptime T: type) -> type => (v: T)\n'
    const hover = hoverIn(source)
    expect(hover(source.indexOf('T: type'))).toBeNull()
    expect(hover(source.indexOf('v: T') + 3)).toBeNull()
    expect(hover(source.indexOf('T = u64'))).toContain('u64')
  })

  test('a type parameter is not a type of the module with its name', () => {
    // The checker reports the clash; the editor still must not answer for the wrong T.
    const source = 'type T = u64\nfunc id(comptime T: type, x: T) -> T => x\n'
    const hover = hoverIn(source)
    expect(hover(source.indexOf('T: type'))).toBeNull()
    expect(hover(source.indexOf('x: T') + 3)).toBeNull()
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
