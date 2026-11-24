// The language server's hover, driven through a connection that only keeps
// the handlers the server registers.

import { describe, expect, test } from 'bun:test'
import type { Connection, Hover, Location, MarkupContent } from 'vscode-languageserver/lib/common/api'
import { posix, win32 } from 'node:path'
import { pathOf, startServer, uriOf } from './serve'

type Handler = (params: unknown) => unknown

// Opens `text` as a document and returns what hovering at an offset shows.
function hoverIn(text: string): (offset: number) => string | null {
  const handlers = new Map<string, Handler>()
  const connection = new Proxy({}, {
    get(_target, name: string) {
      if (name === 'languages') return { semanticTokens: { on: () => {} }, inlayHint: { on: () => {} } }
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
      if (name === 'languages') return { semanticTokens: { on: () => {} }, inlayHint: { on: () => {} } }
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

// A document that imports other source files is checked as part of its
// program, read from the open documents and, where the server can, from
// disk. Where an import cannot be read the document is checked on its own.
describe('a document with source imports', () => {
  const LIB = 'export func bucket(comptime K: type, k: K, n: u32) -> u32 => hash(k) % n\nfunc hash(k: u32) -> u32 => k * 0x45d9f3b\n'
  const MAIN = 'import "./lib" "bucket" func bucket(comptime K: type, k: K, n: u32) -> u32\nexport func f(x: f64) -> u32 => bucket(x, 16)\nexport func g(x: u32) -> u32 => bucket(x, 16)\n'
  const libUri = 'file:///project/lib.ents'
  const mainUri = 'file:///project/main.ents'

  type Sent = { uri: string; diagnostics: { message: string; relatedInformation?: { location: { uri: string } }[] }[] }

  // Opens the documents in order, with the reader given, and returns what
  // the server says of the last one.
  async function open(documents: [string, string][], readFile?: (path: string) => Promise<string | null>) {
    const handlers = new Map<string, Handler>()
    const sent: Sent[] = []
    const connection = new Proxy({}, {
      get(_target, name: string) {
        if (name === 'languages') return { semanticTokens: { on: () => {} }, inlayHint: { on: () => {} } }
        if (name === 'listen') return () => {}
        if (name === 'sendDiagnostics') return (params: Sent) => sent.push(params)
        return (handler: Handler) => {
          handlers.set(name, handler)
          return { dispose() {} }
        }
      },
    }) as Connection
    startServer(connection, { readFile })
    for (const [uri, text] of documents) {
      handlers.get('onDidOpenTextDocument')?.({ textDocument: { uri, languageId: 'encantis', version: 1, text } })
    }
    const [uri, text] = documents[documents.length - 1]
    for (let i = 0; i < 100 && !sent.some((s) => s.uri === uri); i++) await Bun.sleep(5)
    // A place in the last document, as a request names it
    const at = (offset: number) => {
      const before = text.slice(0, offset)
      return { textDocument: { uri }, position: { line: before.split('\n').length - 1, character: offset - before.lastIndexOf('\n') - 1 } }
    }
    const hover = (offset: number) => {
      const shown = handlers.get('onHover')?.(at(offset)) as Hover | null
      return shown ? (shown.contents as MarkupContent).value : null
    }
    return { diagnostics: sent.filter((s) => s.uri === uri).at(-1)?.diagnostics ?? [], hover, at, handlers, sent }
  }

  const failed = "bucket(K = f64) cannot be instantiated: no function 'hash' accepts (f64) (lib.ents:1:62)"

  test('an import the server reads from disk', async () => {
    // Asked for by the path the loader names it by: on Windows with a drive.
    const files = new Map([[pathOf(libUri), LIB]])
    const { diagnostics, hover } = await open([[mainUri, MAIN]], async (path) => files.get(path) ?? null)
    expect(diagnostics.map((d) => d.message)).toEqual([failed])
    // The call shows the instance it calls, with its signature.
    expect(hover(MAIN.lastIndexOf('bucket('))).toBe('```encantis\nfunc bucket(k:u32, n:u32) -> u32\n```\n\ncalls `bucket(K = u32)`')
  })

  test('an import that is open, with no disk to read', async () => {
    const { diagnostics } = await open([[libUri, LIB], [mainUri, MAIN]])
    expect(diagnostics.map((d) => d.message)).toEqual([failed])
  })

  test('an imported generic is defined at its import, and used at its calls', async () => {
    const { at, handlers } = await open([[libUri, LIB], [mainUri, MAIN]])
    const call = MAIN.lastIndexOf('bucket(')
    const line = (location: Location) => `${location.range.start.line}:${location.range.start.character}`
    expect(line(handlers.get('onDefinition')?.(at(call)) as Location)).toBe('0:29')
    const references = handlers.get('onReferences')?.({ ...at(call), context: { includeDeclaration: false } }) as Location[]
    expect(references.map(line)).toEqual(['1:32', '2:32'])
  })

  // From the import, the next step: what the other file exports, from the
  // name it is exported by and from the name it is given here. A use still
  // goes to the import (above), and so does a host's import, which has no
  // file.
  test('an import is defined where the file it imports from exports it', async () => {
    const { at, handlers } = await open([[libUri, LIB], [mainUri, MAIN]])
    const definition = (offset: number) => handlers.get('onDefinition')?.(at(offset)) as Location | null
    const exported = { uri: libUri, range: { start: { line: 0, character: 12 }, end: { line: 0, character: 18 } } }
    expect(definition(MAIN.indexOf('"bucket"'))).toEqual(exported)
    expect(definition(MAIN.indexOf('"bucket"') + 3)).toEqual(exported)
    expect(definition(MAIN.indexOf('func bucket') + 7)).toEqual(exported)
    // A parameter of the signature the import writes is no step to the export.
    expect(definition(MAIN.indexOf('k: K'))).toBeNull()
  })

  test('an export read from disk, and a global', async () => {
    const lib = 'global unused: u32 = 0\nexport "limit" global max-items: u32 = 4\n'
    const main = 'import "./lib" "limit" global limit: u32\nexport func f() -> u32 => limit\n'
    const files = new Map([[pathOf(libUri), lib]])
    const { at, handlers } = await open([[mainUri, main]], async (path) => files.get(path) ?? null)
    const definition = handlers.get('onDefinition')?.(at(main.indexOf('limit:'))) as Location
    // The file's URI as made from its path: on Windows with its drive
    expect(definition).toEqual({ uri: uriOf(pathOf(libUri) as string), range: { start: { line: 1, character: 22 }, end: { line: 1, character: 31 } } })
  })

  test("an import's path is a link to its file", async () => {
    const source = `import "./lib" "bucket" func bucket(comptime K: type, k: K, n: u32) -> u32\nimport "env" "log" func log(x: u32)\nexport func g(x: u32) -> u32 => bucket(x, 16)\n`
    const { handlers } = await open([[libUri, LIB], [mainUri, source]])
    const links = handlers.get('onDocumentLinks')?.({ textDocument: { uri: mainUri } })
    expect(links).toEqual([{ range: { start: { line: 0, character: 8 }, end: { line: 0, character: 13 } }, target: libUri }])
  })

  test('a document is checked again when a file of its program changes', async () => {
    const { diagnostics, sent, handlers } = await open([[libUri, LIB], [mainUri, MAIN]])
    expect(diagnostics.map((d) => d.message)).toEqual([failed])
    const fixed = `${LIB}func hash(k: f64) -> u32 => 1\n`
    handlers.get('onDidChangeTextDocument')?.({ textDocument: { uri: libUri, version: 2 }, contentChanges: [{ text: fixed }] })
    const latest = () => sent.filter((s) => s.uri === mainUri).at(-1)?.diagnostics
    for (let i = 0; i < 100 && latest()?.length !== 0; i++) await Bun.sleep(5)
    expect(latest()).toEqual([])
  })

  test('an import that cannot be read: the document is checked by the signatures its imports write', async () => {
    const { diagnostics } = await open([[mainUri, MAIN]])
    expect(diagnostics).toEqual([])
  })

  // An open document is found by the path of its file, not by a URI made
  // again from that path: VS Code encodes more of a path than encodeURI does
  // (here the parentheses; on Windows the colon of every drive, d%3A), and
  // the document was not found, nor was the document's own text read on
  // Windows.
  test('an open import is found by its path, however its URI is written', async () => {
    const dir = 'file:///project/my%20%28copy%29'
    const { diagnostics } = await open([[`${dir}/lib.ents`, LIB], [`${dir}/main.ents`, MAIN]])
    expect(diagnostics.map((d) => d.message)).toEqual([failed])
  })
})

// The path of a file a file: URI names, as the loader names it, and back:
// on Windows the path has its drive, with the letter in one case whichever
// a client writes, and backslashes. Emulated with path.win32 on any platform.
describe('file URIs and paths', () => {
  test('on Windows', () => {
    expect(pathOf('file:///d%3A/a/encantis/main.ents', win32)).toBe('d:\\a\\encantis\\main.ents')
    expect(pathOf('file:///D:/a/encantis/main.ents', win32)).toBe('d:\\a\\encantis\\main.ents')
    expect(pathOf('file:///c%3A/Users/me/my%20%28copy%29/lib.ents', win32)).toBe('c:\\Users\\me\\my (copy)\\lib.ents')
    expect(pathOf('file://server/share/lib.ents', win32)).toBe('\\\\server\\share\\lib.ents')
    for (const path of ['d:\\a\\encantis\\main.ents', 'c:\\my (copy)\\a#b?c 100%.ents', '\\\\server\\share\\lib.ents']) {
      expect(pathOf(uriOf(path, win32), win32)).toBe(path)
    }
    expect(uriOf('d:\\a\\b c\\lib.ents', win32)).toBe('file:///d:/a/b%20c/lib.ents')
  })

  test('elsewhere', () => {
    expect(pathOf('file:///project/my%20%28copy%29/main.ents', posix)).toBe('/project/my (copy)/main.ents')
    for (const path of ['/project/main.ents', '/my (copy)/a#b?c 100%.ents', '/a\\b.ents']) {
      expect(pathOf(uriOf(path, posix), posix)).toBe(path)
    }
    expect(uriOf('/a/b c/lib.ents', posix)).toBe('file:///a/b%20c/lib.ents')
  })

  test('a document that is no file has no path', () => {
    expect(pathOf('untitled:Untitled-1')).toBeNull()
    expect(pathOf('vscode-vfs://github/creationix/encantis/main.ents')).toBeNull()
  })
})

// A document opened in the server and then edited: each change replaces its
// text, as an editor sends it.
function editedServer(text: string) {
  const handlers = new Map<string, Handler>()
  const connection = new Proxy({}, {
    get(_target, name: string) {
      if (name === 'languages') return { semanticTokens: { on: () => {} }, inlayHint: { on: () => {} } }
      if (name === 'sendDiagnostics' || name === 'listen') return () => {}
      return (handler: Handler) => {
        handlers.set(name, handler)
        return { dispose() {} }
      }
    },
  }) as Connection
  startServer(connection)
  const uri = 'file:///edited.ents'
  let current = text
  let version = 1
  handlers.get('onDidOpenTextDocument')?.({ textDocument: { uri, languageId: 'encantis', version, text } })
  return {
    change(next: string) {
      current = next
      version++
      handlers.get('onDidChangeTextDocument')?.({ textDocument: { uri, version }, contentChanges: [{ text: next }] })
    },
    at(handler: string, offset: number, extra: object = {}) {
      const before = current.slice(0, offset)
      const position = { line: before.split('\n').length - 1, character: offset - before.lastIndexOf('\n') - 1 }
      return handlers.get(handler)?.({ textDocument: { uri }, position, ...extra })
    },
  }
}

describe('queries of edited text', () => {
  const start = (location: unknown) => {
    const { line, character } = (location as Location).range.start
    return `${line}:${character}`
  }
  const shown = (hover: unknown) => (hover ? ((hover as Hover).contents as MarkupContent).value : null)

  // While the text does not parse, the last analysis was of older text: the
  // call of b was answered with a and a's uses, and hover described a (and a
  // renamed local by its old name). The queries answer from an analysis of
  // the text as it is now, with the line that does not parse left out.
  test('while a line does not parse, the rest is answered as it is now', () => {
    const before = 'func a() -> u32 => 1\nfunc b() -> u32 => 2\nexport func f(x: u32) -> u32 {\n  let y = x\n  return a() + y\n}\n'
    const server = editedServer(before)
    expect(start(server.at('onDefinition', before.lastIndexOf('a()')))).toBe('0:5')
    const broken = 'func a() -> u32 => 1\nfunc b() -> u32 => 2\nexport func f(x: u32) -> u32 {\n  let z = x\n  return b() + z\n}\nlet = \n'
    server.change(broken)
    const call = broken.lastIndexOf('b()')
    expect(shown(server.at('onHover', call))).toBe('```encantis\nfunc b() -> u32\n```')
    expect(start(server.at('onDefinition', call))).toBe('1:5')
    expect((server.at('onReferences', call, { context: { includeDeclaration: true } }) as unknown[]).map(start)).toEqual(['1:5', '4:9'])
    expect(shown(server.at('onHover', broken.lastIndexOf('z')))).toBe('```encantis\nlet z:u32\n```')
    // What does not parse is not answered for.
    expect(server.at('onHover', broken.indexOf('let ='))).toBeNull()
    // Once it parses, it is answered from its own analysis.
    const fixed = broken.replace('let = \n', '')
    server.change(fixed)
    expect(start(server.at('onDefinition', fixed.lastIndexOf('b()')))).toBe('1:5')
  })

  // What was left out can declare a name the rest uses: without it, the
  // analysis knows the name not at all and takes it for anything (here the
  // type P, so that q was shown as an i32), or takes it for another thing
  // (the other function h; a builtin, whose name a function there can
  // take). What it says of a declaration that names such a name, of one
  // that names what such a declaration declares (the global origin), of a
  // generic one of them calls (its instances are made by its calls), and of
  // what was left out itself is not shown.
  test('what can differ once what is left out is written again is not answered for', () => {
    const before = `type P = (x: i32, y: i32)
func h(x: u32) -> u32 => x
func id(comptime T: type, v: T) -> T => v
func two() -> u32 => 2
global origin: P = (x: 0, y: 0)
export func f() -> u32 {
  let r = h(two())
  return min(r, two())
}
export func g(q: P) -> i32 => id(q).x
export func d() -> i32 {
  let o = origin
  return 0
}
type Q = (p: P)
global gq: Q
export func dq() -> u32 {
  let z = gq
  return 1
}
func gone() -> u64 => 1
export func e() -> u32 {
  let w = gone()
  return 1
}
func id2(comptime T: type, v: T) -> T => v
export func k(n: u32) -> u32 => id2(n)
export func s() -> []u8 => "abc"
`
    const server = editedServer(before)
    expect(shown(server.at('onHover', before.indexOf('q: P')))).toBe('```encantis\ninput q:(x:i32, y:i32)\n```')
    expect(shown(server.at('onHover', before.indexOf('=> v') + 3))).toContain('in `id(T = P)`')
    expect(shown(server.at('onHover', before.indexOf('"abc"')))).toContain('"abc":[]u8 = 0x')
    const broken = `${before.replace('y: i32)\n', 'y:\n').replace('func gone() -> u64 => 1', 'func gone() -> u64 =>')}func h(x: f64) -> []u8 {\n  let min = "min"\n  return h(id2(1.5)\n}\n`
    server.change(broken)
    const at = (text: string, skip = 0) => broken.indexOf(text) + skip
    for (const query of ['onHover', 'onDefinition']) {
      for (const offset of [at('h(two'), at('min(r'), at('h(x: u32)'), at('r = h'), at('q: P'), at('=> v', 3), at('o = origin'), at('z = gq'), at('w = gone'), broken.indexOf('=> v', at('func id2')) + 3, at('min = "'), at('h(id2')]) {
        expect(server.at(query, offset)).toBeNull()
      }
    }
    for (const offset of [at('h(x: u32)'), at('two()')]) {
      expect(server.at('onReferences', offset, { context: { includeDeclaration: true } })).toBeNull()
    }
    // What names none of it still is, but where data is laid out is not
    // known: what is left out can have data.
    expect(shown(server.at('onHover', at('k(n')))).toBe('```encantis\nfunc k(n:u32) -> u32\n```')
    expect(shown(server.at('onHover', at('(n)', 1)))).toBe('```encantis\ninput n:u32\n```')
    expect(shown(server.at('onHover', at('"abc"')))).toBe('```encantis\n"abc":[]u8\n```')
    expect(start(server.at('onDefinition', at('two()')))).toBe('3:5')
  })

  // A line that goes on with the declaration before it (the parser read on
  // into it) was left out alone, and that declaration was answered for as
  // the part before the line: def k as 1, where the text says 1 + 2 and more.
  test('a declaration that goes on into a line that does not parse is not answered for', () => {
    const before = 'def k = 1\n  + 2.5\nexport func f() -> f64 => k\nexport func g(x: u32) -> u32 => x\n'
    const server = editedServer(before)
    expect(shown(server.at('onHover', before.lastIndexOf('k')))).toBe('```encantis\ndef k:f64 = 3.5\n```')
    const broken = before.replace('2.5', '2.5 x')
    server.change(broken)
    expect(server.at('onHover', broken.lastIndexOf('k'))).toBeNull()
    expect(server.at('onDefinition', broken.lastIndexOf('k'))).toBeNull()
    expect(server.at('onHover', broken.indexOf('k'))).toBeNull()
    expect(shown(server.at('onHover', broken.lastIndexOf('x')))).toBe('```encantis\ninput x:u32\n```')
  })

  // Checked on its own (the web's editor reads no files), a module that
  // imports a generic type lists no errors: nothing says what depends on
  // what is left out, and nothing is answered for.
  test('a module whose errors are left to its program is not answered for while it does not parse', async () => {
    const before = 'import "./lib" "Vec" func Vec(comptime T: type) -> type\ntype P = (x: i32, y: i32)\nexport func g(q: P) -> i32 => q.x\n'
    const server = editedServer(before)
    // Its program is read first (here it cannot be): no file is read, and
    // what is waited for is done before a timer is.
    await Bun.sleep(0)
    expect(shown(server.at('onHover', before.indexOf('q: P')))).toBe('```encantis\ninput q:(x:i32, y:i32)\n```')
    const broken = before.replace('y: i32)\n', 'y:\n')
    server.change(broken)
    await Bun.sleep(0)
    expect(server.at('onHover', broken.indexOf('q: P'))).toBeNull()
  })

  // Where no part of the text can be left out for the rest to parse, there
  // is no analysis of it, and none of older text answers.
  test('with no analysis of the text as it is now, nothing is answered from an older one', () => {
    const before = 'func a() -> u32 => 1\nfunc b() -> u32 => 2\nexport func f() -> u32 => a()\n'
    const server = editedServer(before)
    expect(shown(server.at('onHover', before.lastIndexOf('a()')))).toBe('```encantis\nfunc a() -> u32\n```')
    const broken = `${before.replace('=> a()', '=> b()')}${'let =\nfunc c() -> u32 => 3\n'.repeat(10)}`
    server.change(broken)
    const call = broken.lastIndexOf('b()')
    expect(server.at('onHover', call)).toBeNull()
    expect(server.at('onDefinition', call)).toBeNull()
    // A primitive type is the same whatever the text says.
    expect(shown(server.at('onHover', broken.indexOf('u32')))).toBe('32-bit unsigned integer')
  })
})

describe('a def of a single-quoted literal', () => {
  // A def's value is put where it is used, still quoted: its use was shown
  // as the codepoint alone, with no def to go to.
  test('is the def where it is used', () => {
    const source = "def lf = '\\n'\nexport func f(c: u8) -> bool => c == lf || c == '\\n'\n"
    const server = serverFor(source)
    const value = (hover: unknown) => ((hover as Hover).contents as MarkupContent).value
    const start = (location: unknown) => (location as { range: { start: { line: number; character: number } } }).range.start
    const use = source.indexOf('== lf') + 3
    expect(value(server('onHover', use))).toBe('```encantis\ndef lf:u8 = 10\n```')
    expect(start(server('onDefinition', use))).toEqual({ line: 0, character: 4 })
    // Its references are where it is declared and where it is used; the
    // literal written in the body is no use of it.
    expect((server('onReferences', use, { context: { includeDeclaration: true } }) as unknown[]).map(start)).toEqual([{ line: 0, character: 4 }, { line: 1, character: 37 }])
    // The literal itself is still its codepoint, in the def and in the body.
    expect(value(server('onHover', source.indexOf("'\\n'")))).toContain("'\\n':i32 = 10")
    expect(value(server('onHover', source.lastIndexOf("'\\n'")))).toContain("'\\n':u8 = 10")
  })
})

describe('a def where it is used', () => {
  // A def's value is put where its name is written, and the checker sees
  // only the value there: the references of a def were its declaration
  // alone, and where the value is an expression ('a' + 1, 1 + 2) its use was
  // the expression's parts, with no def to go to.
  test('is the def, also one whose value is an expression, and each use is a reference', () => {
    const source = "def n = 1 + 2\ndef nxt = 'a' + 1\ndef lf: u8 = '\\n'\nexport func f(c: u8) -> bool => c == nxt || c == lf || n + n == 6\n"
    const server = serverFor(source)
    const value = (hover: unknown) => ((hover as Hover).contents as MarkupContent).value
    const start = (location: unknown) => {
      const { line, character } = (location as Location).range.start
      return `${line}:${character}`
    }
    const references = (offset: number) => (server('onReferences', offset, { context: { includeDeclaration: true } }) as unknown[]).map(start)
    const n = [source.indexOf('n + n'), source.indexOf('n == 6')]
    for (const at of [source.indexOf('n ='), ...n]) {
      if (at !== source.indexOf('n =')) expect(value(server('onHover', at))).toBe('```encantis\ndef n:i32 = 3\n```')
      expect(start(server('onDefinition', at))).toBe('0:4')
      expect(references(at)).toEqual(['0:4', '3:55', '3:59'])
    }
    const nxt = source.indexOf('== nxt') + 3
    expect(value(server('onHover', nxt))).toBe('```encantis\ndef nxt:u8 = 98\n```')
    expect(start(server('onDefinition', nxt))).toBe('1:4')
    expect(references(nxt)).toEqual(['1:4', '3:37'])
    const lf = source.indexOf('== lf') + 3
    expect(value(server('onHover', lf))).toBe('```encantis\ndef lf:u8 = 10\n```')
    expect(references(lf)).toEqual(['2:4', '3:49'])
    // What the value holds is shown where the def is declared.
    expect(value(server('onHover', source.indexOf("'a'")))).toContain("'a':i32 = 97")
  })

  // A minus before a def's value is taken into it (-k is the literal -5),
  // which starts at the minus: the use, from the minus on, was that literal,
  // and the name with its minus was no name.
  test('is the def where it is negated', () => {
    const source = 'def k = 5\ndef h: f64 = 0.5\nexport func f(x: i32) -> f64 => (-k + k - -x) as f64 + -h\n'
    const server = serverFor(source)
    const value = (hover: unknown) => ((hover as Hover).contents as MarkupContent).value
    const start = (location: unknown) => {
      const { line, character } = (location as Location).range.start
      return `${line}:${character}`
    }
    for (const at of [source.indexOf('-k'), source.indexOf('-k') + 1]) {
      expect(value(server('onHover', at))).toBe('```encantis\ndef k:i32 = 5\n```')
      expect(start(server('onDefinition', at))).toBe('0:4')
    }
    expect((server('onReferences', source.indexOf('-k') + 1, { context: { includeDeclaration: false } }) as unknown[]).map(start)).toEqual(['2:34', '2:38'])
    expect(start(server('onDefinition', source.indexOf('-h') + 1))).toBe('1:4')
    // A negated name of any other kind is the name.
    expect(value(server('onHover', source.indexOf('-x') + 1))).toBe('```encantis\ninput x:i32\n```')
  })

  // The count of a repeated value was shown as its type alone, and what a
  // defer runs was not looked at: a use there was listed among the def's
  // references, with no def to go to from it (nor any other name there).
  test('is the def where it counts a repeated value and where a defer uses it', () => {
    const source = 'def k = 4\ndata buf = mut [0:u8; k]\nglobal g: i32 = 0\nfunc bump(n: i32) { g += n }\nexport func f(x: i32) -> u8 {\n  defer bump(k + x)\n  return buf[0]\n}\n'
    const server = serverFor(source)
    const value = (hover: unknown) => ((hover as Hover).contents as MarkupContent).value
    const start = (location: unknown) => {
      const { line, character } = (location as Location).range.start
      return `${line}:${character}`
    }
    for (const at of [source.indexOf('; k') + 2, source.indexOf('(k') + 1]) {
      expect(value(server('onHover', at))).toBe('```encantis\ndef k:i32 = 4\n```')
      expect(start(server('onDefinition', at))).toBe('0:4')
    }
    expect((server('onReferences', 4, { context: { includeDeclaration: false } }) as unknown[]).map(start)).toEqual(['1:22', '5:13'])
    expect(start(server('onDefinition', source.indexOf('bump(k')))).toBe('3:5')
    expect(value(server('onHover', source.indexOf('+ x') + 2))).toBe('```encantis\ninput x:i32\n```')
  })

  // A range was not looked at, as a value or as what is filled or copied
  // into: a def used as a bound was listed among its references, with no def
  // to go to from it, and the names there (what is ranged, a bound) showed
  // nothing.
  test('is the def where it bounds a range, read or written', () => {
    const source = 'def k = 2\ndata buf = mut [0:u8; 4]\nexport func f(a: u32, s: []u8) -> u32 {\n  buf[0..k] = 7\n  return if let r = s[a..k] { r.len } else { 0 }\n}\n'
    const server = serverFor(source)
    const value = (hover: unknown) => ((hover as Hover).contents as MarkupContent).value
    const start = (location: unknown) => {
      const { line, character } = (location as Location).range.start
      return `${line}:${character}`
    }
    for (const at of [source.indexOf('..k]') + 2, source.lastIndexOf('..k]') + 2]) {
      expect(value(server('onHover', at))).toBe('```encantis\ndef k:u32 = 2\n```')
      expect(start(server('onDefinition', at))).toBe('0:4')
    }
    expect((server('onReferences', 4, { context: { includeDeclaration: false } }) as unknown[]).map(start)).toEqual(['3:9', '4:25'])
    expect(value(server('onHover', source.indexOf('[a..') + 1))).toBe('```encantis\ninput a:u32\n```')
    expect(start(server('onDefinition', source.indexOf('s[a')))).toBe('2:22')
    expect(start(server('onDefinition', source.indexOf('buf[0')))).toBe('1:5')
  })
})

describe('a single-quoted literal in a template', () => {
  // What a template's ${...} holds is code: a literal there was passed over
  // with the template's text, from one backtick to the next, and hovering it
  // showed nothing. A quote there may hold a } or a backtick.
  test('shows its codepoints in an interpolation', () => {
    const source = `func name(c: u8) -> []u8 => "x"
func pair(a: u8, b: u8) -> []u8 => "y"
export func g() -> [][]u8 => \`<\${name('a')}|\${pair('}', '\`')}>\` // 'c'
export func h() -> u8 => 'd'
`
    const hover = hoverIn(source)
    for (const [literal, shown] of [["'a'", "'a':u8 = 97"], ["'}'", "'}':u8 = 125"], ["'`'", "'`':u8 = 96"], ["'d'", "'d':u8 = 100"]]) {
      for (const at of [0, 1, 2]) expect(hover(source.indexOf(literal) + at)).toContain(shown)
    }
    // The template's text is still its own, and a comment is not code.
    expect(hover(source.indexOf('|'))).toContain('"|":[]u8')
    expect(hover(source.indexOf('>`'))).toContain('">":[]u8')
    expect(hover(source.indexOf("'c'") + 1)).toBeNull()
  })

  // A template's text can go on over lines, and was read a line at a time:
  // a piece of text on a later line showed nothing, and an apostrophe there
  // was taken for a quote, so that a literal after it showed nothing either.
  test('a piece of text is whole over lines, and an apostrophe in it is text', () => {
    const source = "func take(c: u8) -> []u8 => \"x\"\nexport func g() -> [][]u8 => `first\nit's ${take('m')} end\nlast`\n/* don't\n'q' */ export func h() -> []u8 => \"one\ntwo\"\n"
    const hover = hoverIn(source)
    for (const at of [0, 1, 2]) expect(hover(source.indexOf("'m'") + at)).toContain("'m':u8 = 109")
    for (const at of [source.indexOf('first'), source.indexOf("it's") + 2]) expect(hover(at)).toContain('"first\\nit\'s ":[]u8')
    expect(hover(source.indexOf('last'))).toContain('" end\\nlast":[]u8')
    // So can a string, and a comment, which is not code.
    expect(hover(source.indexOf('two'))).toContain('"one\\ntwo":[]u8')
    expect(hover(source.indexOf("'q'") + 1)).toBeNull()
    // What is shown is the piece of text, from its first line to its last.
    const range = (serverFor(source)('onHover', source.indexOf('last')) as Hover).range
    expect(range).toEqual({ start: { line: 2, character: 17 }, end: { line: 3, character: 4 } })
  })

  // An escaped backtick or ${ is the template's text: the piece of text
  // ended at it.
  test('a piece of text is whole past an escape', () => {
    const source = 'func name(c: u8) -> []u8 => "x"\nexport func g() -> [][]u8 => `a\\`b${name(1)}c\\${d ${name(2)}`\n'
    const hover = hoverIn(source)
    for (const at of [0, 1, 2, 3]) expect(hover(source.indexOf('a\\`b') + at)).toContain('"a\\`b":[]u8')
    for (const at of [0, 1, 2, 3, 4, 5]) expect(hover(source.indexOf('c\\${d') + at)).toContain('"c\\${d ":[]u8')
  })
})

// What hover says of a nested function and of what it captures, as the CLI
// does, and where a name given for a comptime function parameter is defined
describe('nested functions in the editor', () => {
  const source = `func apply(comptime f: (u32) -> u32, x: u32) -> u32 => f(x)
export func count_over(xs: []u32, limit: u32) -> u32 {
  let n: u32 = 0
  func note(x: u32) {
    if x > limit { n += 1 }
  }
  for x in xs { note(x) }
  return n
}
export func outer(n: u32) -> u32 {
  func g(x: u32) -> u32 => x + n
  return apply(g, 1)
}
test "t" {
  let z: u32 = 1
  func plus(x: u32) -> u32 => x + z
  assert apply(plus, 1) == 2
}
`
  test('hover shows where it is nested, what it captures and where a capture is from', () => {
    const hover = hoverIn(source)
    expect(hover(source.indexOf('note(x: u32)'))).toContain('nested in `count_over`; captures limit, n (writes n)')
    expect(hover(source.indexOf('note(x) }'))).toContain('nested in `count_over`; captures limit, n (writes n)')
    expect(hover(source.indexOf('limit { n'))).toContain('captured from `count_over`')
    expect(hover(source.indexOf('apply(g') + 6)).toContain('nested in `outer`; captures n')
    expect(hover(source.indexOf('apply(plus') + 6)).toContain('nested in `test "t"`; captures z')
  })

  test('definition at a name given for a comptime function parameter', () => {
    const ask = serverFor(source)
    const line = (offset: number) => source.slice(0, offset).split('\n').length - 1
    const def = (offset: number) => (ask('onDefinition', offset) as Location | null)?.range.start.line
    expect(def(source.indexOf('apply(g') + 6)).toBe(line(source.indexOf('func g')))
    expect(def(source.indexOf('apply(plus') + 6)).toBe(line(source.indexOf('func plus')))
  })
})
