// The language server's outline, rename, completion and signature help, and
// documents of a web editor's file system, driven through a connection that
// only keeps the handlers the server registers.

import { describe, expect, test } from 'bun:test'
import type { CompletionItem, Connection, DocumentSymbol, SignatureHelp, WorkspaceEdit } from 'vscode-languageserver/lib/common/api'
import { posix, win32 } from 'node:path'
import { pathFor, pathOf, type ServerOptions, startServer, uriFor } from './serve'

type Handler = (params: unknown) => unknown

function server(options: ServerOptions = {}) {
  const handlers = new Map<string, Handler>()
  const sent = new Map<string, { message: string }[]>()
  const connection = new Proxy({}, {
    get(_target, name: string) {
      if (name === 'languages') return { semanticTokens: { on: () => {} } }
      if (name === 'listen') return () => {}
      if (name === 'sendDiagnostics') return (p: { uri: string; diagnostics: { message: string }[] }) => sent.set(p.uri, p.diagnostics)
      return (handler: Handler) => {
        handlers.set(name, handler)
        return { dispose() {} }
      }
    },
  }) as Connection
  startServer(connection, options)
  let version = 1
  const position = (text: string, offset: number) => {
    const before = text.slice(0, offset)
    return { line: before.split('\n').length - 1, character: offset - before.lastIndexOf('\n') - 1 }
  }
  return {
    sent,
    async open(uri: string, text: string) {
      sent.delete(uri)
      handlers.get('onDidOpenTextDocument')?.({ textDocument: { uri, languageId: 'encantis', version: version++, text } })
      for (let i = 0; i < 200 && !sent.has(uri); i++) await Bun.sleep(5)
    },
    async change(uri: string, text: string) {
      sent.delete(uri)
      handlers.get('onDidChangeTextDocument')?.({ textDocument: { uri, version: version++ }, contentChanges: [{ text }] })
      for (let i = 0; i < 200 && !sent.has(uri); i++) await Bun.sleep(5)
    },
    // A request at an offset of a document's text
    at<T>(name: string, uri: string, text: string, offset: number, more: object = {}): T {
      return handlers.get(name)?.({ textDocument: { uri }, position: position(text, offset), ...more }) as T
    },
    ask<T>(name: string, params: unknown): T {
      return handlers.get(name)?.(params) as T
    },
  }
}

// The text with a document's edits applied
function applied(text: string, edit: WorkspaceEdit, uri: string): string {
  const lines = text.split('\n')
  const offset = (p: { line: number; character: number }) => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character
  const edits = [...(edit.changes?.[uri] ?? [])].sort((a, b) => offset(b.range.start) - offset(a.range.start))
  return edits.reduce((t, e) => t.slice(0, offset(e.range.start)) + e.newText + t.slice(offset(e.range.end)), text)
}

const uri = 'file:///project/shapes.ents'
const SHAPES = `import "env" (
  "log" func log(x: i32)
)
type Point = (x: i32, y: i32)
global origin: Point = Point(0, 0)
def scale = 3
func len2(p: Point) -> i32 => p.x * p.x + p.y * p.y
func shift(p: *mut Point, by: i32) {
  p.x += by
}
export func area(p: Point, k: i32) -> i32 {
  let w = p.x * k
  let h = p.y * k
  return w * h
}
test "area" {
  func square(n: i32) -> i32 => n * n
  assert area(Point(2, 3), 1) == square(1) * 6
}
`

describe('the outline', () => {
  const names = (symbols: DocumentSymbol[]): unknown[] => symbols.map((s) => (s.children ? [s.name, names(s.children)] : s.name))

  test('lists the declarations, with what is inside them', async () => {
    const s = server()
    await s.open(uri, SHAPES)
    const symbols = s.ask<DocumentSymbol[]>('onDocumentSymbol', { textDocument: { uri } })
    expect(names(symbols)).toEqual([
      ['import "env"', ['log']],
      ['Point', ['x', 'y']],
      'origin',
      'scale',
      'len2',
      'shift',
      'area',
      ['test "area"', ['square']],
    ])
    // A name is selected where it is written, and an export says so.
    const area = symbols.find((x) => x.name === 'area') as DocumentSymbol
    expect(area.selectionRange.start).toEqual({ line: 10, character: 12 })
    expect(area.detail).toBe('export (p:(x:i32, y:i32), k:i32) -> i32')
  })

  test('keeps a declaration that does not parse while it is written', async () => {
    const s = server()
    await s.open(uri, SHAPES)
    await s.change(uri, SHAPES.replace('  return w * h', '  return w * (h'))
    const symbols = s.ask<DocumentSymbol[]>('onDocumentSymbol', { textDocument: { uri } })
    expect(symbols.map((x) => x.name)).toEqual(['import "env"', 'Point', 'origin', 'scale', 'len2', 'shift', 'area', 'test "area"'])
  })
})

describe('rename', () => {
  async function renamed(text: string, at: number, newName: string): Promise<string> {
    const s = server()
    await s.open(uri, text)
    expect(s.at('onPrepareRename', uri, text, at)).not.toBeNull()
    const edit = await s.at<Promise<WorkspaceEdit>>('onRenameRequest', uri, text, at, { newName })
    return applied(text, edit, uri)
  }
  async function refused(text: string, at: number, newName: string): Promise<string> {
    const s = server()
    await s.open(uri, text)
    try {
      await s.at<Promise<WorkspaceEdit>>('onRenameRequest', uri, text, at, { newName })
    } catch (e) {
      return (e as Error).message
    }
    throw new Error('not refused')
  }

  test('a local, at its declaration and at its uses', async () => {
    const out = await renamed(SHAPES, SHAPES.indexOf('w * h'), 'width')
    expect(out).toContain('let width = p.x * k')
    expect(out).toContain('return width * h')
  })

  test("a function where its name is written, not at `func`, and a type", async () => {
    const out = await renamed(SHAPES, SHAPES.indexOf('len2'), 'norm2')
    expect(out).toContain('func norm2(p: Point)')
    const typed = await renamed(SHAPES, SHAPES.indexOf('Point ='), 'Pt')
    expect(typed).toContain('type Pt = (x: i32, y: i32)')
    expect(typed).toContain('global origin: Pt = Pt(0, 0)')
  })

  test('an exported function keeps the name the host knows it by', async () => {
    const out = await renamed(SHAPES, SHAPES.indexOf('area('), 'surface')
    expect(out).toContain('export "area" func surface(p: Point, k: i32)')
    expect(out).toContain('assert surface(Point(2, 3), 1)')
  })

  test('is refused where the new name would mean something else or is no name', async () => {
    // The def, used in area, would be hidden there by its parameter k.
    const used = SHAPES.replace('let w = p.x * k', 'let w = p.x * k * scale')
    expect(await refused(used, used.indexOf('scale ='), 'k')).toContain('some of its uses would mean another thing')
    // Two locals of a name in one scope
    expect(await refused(SHAPES, SHAPES.indexOf('w * h'), 'h')).toContain("'h' is already declared")
    expect(await refused(SHAPES, SHAPES.indexOf('w * h'), 'loop')).toBe("'loop' is a keyword")
    expect(await refused(SHAPES, SHAPES.indexOf('w * h'), 'min')).toBe("'min' is a builtin")
    expect(await refused(SHAPES, SHAPES.indexOf('w * h'), 'u32')).toBe("'u32' is a type")
    expect(await refused(SHAPES, SHAPES.indexOf('Point ='), 'point')).toContain("is not a type's name")
  })

  test('a local bound by a field of its name keeps the field', async () => {
    const text = `export func pair(n: u32) -> (count: u32, clipped: bool) {
  count = n + 1
  clipped = n > 5
}
export func f(n: u32) -> u32 {
  let (count:, clipped:) = pair(n)
  return if clipped { 0 } else { count }
}
`
    const out = await renamed(text, text.indexOf('return if clipped') + 10, 'cut')
    expect(out).toContain('let (count:, clipped: cut) = pair(n)')
    expect(out).toContain('return if cut { 0 } else { count }')
    // The named result itself is a field of what pair returns, read by name.
    expect(await refused(text, text.indexOf('count = n'), 'total')).toContain("'count' is a named result")
  })

  test('a field and a builtin are no names to rename', async () => {
    const s = server()
    await s.open(uri, SHAPES)
    expect(s.at('onPrepareRename', uri, SHAPES, SHAPES.indexOf('p.x') + 2)).toBeNull()
    expect(s.at('onPrepareRename', uri, SHAPES, SHAPES.indexOf('i32'))).toBeNull()
  })
})

describe('highlights', () => {
  type Highlight = { range: { start: { line: number; character: number } }; kind: number }
  const at = (h: Highlight) => `${h.range.start.line}:${h.range.start.character}:${h.kind === 3 ? 'write' : 'read'}`

  test("a name's declaration and assignments are writes, its other uses reads", async () => {
    const text = `export func f(n: u32) -> u32 {
  let total = n
  total += 1
  total = total * 2
  if total == 4 { return 0 }
  return total
}
`
    const s = server()
    await s.open(uri, text)
    const highlights = s.at<Highlight[]>('onDocumentHighlight', uri, text, text.indexOf('total == 4'))
    expect(highlights.map(at)).toEqual(['1:6:write', '2:2:write', '3:2:write', '3:10:read', '4:5:read', '5:9:read'])
  })

  test('a field and a builtin have none', async () => {
    const s = server()
    await s.open(uri, SHAPES)
    expect(s.at('onDocumentHighlight', uri, SHAPES, SHAPES.indexOf('p.x') + 2)).toBeNull()
  })
})

describe('completion', () => {
  // Opens the text, edits it to the text with | taken out, and completes at |
  async function complete(edited: string) {
    const s = server()
    await s.open(uri, SHAPES)
    const at = edited.indexOf('|')
    const text = edited.replace('|', '')
    await s.change(uri, text)
    const items = s.at<CompletionItem[]>('onCompletion', uri, text, at)
    const signature = s.at<SignatureHelp | null>('onSignatureHelp', uri, text, at)
    return { labels: items.map((i) => i.label), items, signature }
  }

  test('names in a function being written: its own first, then the module, builtins, types and keywords', async () => {
    const { items } = await complete(SHAPES.replace('  return w * h', '  let z = |\n  return w * h'))
    const sorted = [...items].sort((a, b) => (a.sortText ?? '').localeCompare(b.sortText ?? '')).map((i) => i.label)
    expect(sorted.slice(0, 4)).toEqual(['h', 'k', 'p', 'w'])
    for (const name of ['origin', 'scale', 'len2', 'Point', 'log', 'sqrt', 'u32', 'while']) expect(sorted).toContain(name)
    // Not another function's own names
    expect(sorted).not.toContain('by')
  })

  test('the members of what is before a point', async () => {
    const { items } = await complete(SHAPES.replace('  return w * h', '  let z = p.|\n  return w * h'))
    expect(items.map((i) => [i.label, i.detail])).toEqual([
      ['x', 'i32'],
      ['y', 'i32'],
      // Functions called as methods, p.len2() being len2(p)
      ['len2', '(p: (x: i32, y: i32)) -> i32'],
      ['shift', '(p: *mut (x: i32, y: i32), by: i32)'],
      ['area', '(p: (x: i32, y: i32), k: i32) -> i32'],
    ])
    // Through a pointer, of a local written on a line not yet checked, and
    // of a global
    expect((await complete(SHAPES.replace('  p.x += by', '  p.|'))).labels.slice(0, 2)).toEqual(['x', 'y'])
    expect((await complete(SHAPES.replace('  return w * h', '  let q = origin\n  let z = q.|\n  return w * h'))).labels.slice(0, 2)).toEqual(['x', 'y'])
    expect((await complete(SHAPES.replace('  return w * h', '  let z = origin.|\n  return w * h'))).labels.slice(0, 2)).toEqual(['x', 'y'])
  })

  // Completed in a text of its own, edited to the text with | taken out
  async function completeIn(base: string, edited: string) {
    const s = server()
    await s.open(uri, base)
    const at = edited.indexOf('|')
    const text = edited.replace('|', '')
    await s.change(uri, text)
    return s.at<CompletionItem[]>('onCompletion', uri, text, at)
  }
  const GENERIC = `func Pair(comptime T: type) -> type => (a: T, b: T)
func make(comptime T: type, x: T) -> Pair(T) => Pair(T)(x, x)
func second(comptime T: type, p: Pair(T)) -> T => p.b
type A = (x: i32)
type B = (x: f64)
func fa(a: A) -> i32 => a.x
func fb(b: B) -> f64 => b.x
export func f(n: u32, t: (i32, i32), q: *mut A) -> u32 {
  let v = make(u32, n)
  if n > 3 {
    let inner = 1
  }
  return second(v) + fa(q.*) as u32
}
`

  test('a local of a block that has closed is not offered, one of the block it is in is', async () => {
    const after = await completeIn(GENERIC, GENERIC.replace('  return second', '  let z = |\n  return second'))
    expect(after.map((i) => i.label)).not.toContain('inner')
    expect(after.map((i) => i.label)).toContain('v')
    const within = await completeIn(GENERIC, GENERIC.replace('    let inner = 1', '    let inner = 1\n    let z = |'))
    expect(within.map((i) => i.label)).toContain('inner')
  })

  test('after a point: unnamed fields by position, .* and the type puns of a pointer', async () => {
    const tuple = await completeIn(GENERIC, GENERIC.replace('  return second', '  let z = t.|\n  return second'))
    expect(tuple.map((i) => [i.label, i.detail]).slice(0, 2)).toEqual([['0', 'i32'], ['1', 'i32']])
    const pointer = (await completeIn(GENERIC, GENERIC.replace('  return second', '  let z = q.|\n  return second'))).map((i) => i.label)
    expect(pointer.slice(0, 2)).toEqual(['x', '*'])
    expect(pointer).toContain('u32')
    // A value is no memory to read as another type.
    expect((await completeIn(GENERIC, GENERIC.replace('  return second', '  let z = t.|\n  return second'))).map((i) => i.label)).not.toContain('u32')
  })

  test("a local given a generic's result, on a line not yet checked", async () => {
    const items = await completeIn(GENERIC, GENERIC.replace('  return second', '  let w = make(u32, n)\n  let z = w.|\n  return second'))
    expect(items.map((i) => [i.label, i.detail])).toEqual([
      ['a', 'u32'],
      ['b', 'u32'],
      ['second', '(p: Pair(T)) -> T'],
    ])
  })

  test("methods of a struct, not of another with fields of the same names", async () => {
    const labels = (await completeIn(GENERIC, GENERIC.replace('  return second', '  let z = q.|\n  return second'))).map((i) => i.label)
    expect(labels).toContain('fa')
    expect(labels).not.toContain('fb')
  })

  test('nothing in a comment, a string or a number', async () => {
    expect((await complete(SHAPES.replace('  return w * h', '  // p.|\n  return w * h'))).labels).toEqual([])
    expect((await complete(SHAPES.replace('  return w * h', '  let s = "p.|"\n  return w * h'))).labels).toEqual([])
    expect((await complete(SHAPES.replace('  return w * h', '  let f = 1.|\n  return w * h'))).labels).toEqual([])
  })

  test('signature help: the parameter of the argument written, past a receiver', async () => {
    const call = await complete(SHAPES.replace('  return w * h', '  shift(&mut origin, |\n  return w * h'))
    expect(call.signature?.signatures[0].label).toBe('shift(p: *mut (x: i32, y: i32), by: i32)')
    expect(call.signature?.activeParameter).toBe(1)
    const method = await complete(SHAPES.replace('  return w * h', '  let z = p.area(|\n  return w * h'))
    expect(method.signature?.activeParameter).toBe(1)
    const builtin = await complete(SHAPES.replace('  return w * h', '  let m = min(w, |\n  return w * h'))
    expect(builtin.signature?.signatures[0].label).toBe('min(a: T, b: T) -> T')
  })
})

describe("a web editor's documents", () => {
  test('are named by the paths of their URIs, and the files beside them by theirs', () => {
    const main = 'vscode-vfs://github/creationix/encantis/examples/modular/main.ents'
    expect(pathFor(main, posix)).toBe('/creationix/encantis/examples/modular/main.ents')
    expect(uriFor('/creationix/encantis/examples/modular/util.ents', main, posix)).toBe('vscode-vfs://github/creationix/encantis/examples/modular/util.ents')
    expect(uriFor('/a/my file.ents', main, posix)).toBe('vscode-vfs://github/a/my%20file.ents')
    // On Windows the loader resolves a path with a drive and backslashes: the
    // URI made from it again is the document's.
    expect(uriFor('D:\\creationix\\encantis\\examples\\modular\\main.ents', main, win32)).toBe(main)
    const resolved = pathFor(main, win32) as string
    expect(uriFor(resolved, main, win32)).toBe(main)
    expect(pathFor('untitled:Untitled-1')).toBeNull()
    expect(pathFor('file:///project/a.ents')).toBe(pathOf('file:///project/a.ents'))
  })

  test('import files the server reads through the editor', async () => {
    const main = 'vscode-vfs://github/o/r/main.ents'
    const asked: string[] = []
    const s = server({
      readUri: async (uri) => {
        asked.push(uri)
        return uri.endsWith('/util.ents') ? 'export func add(a: i32, b: i32) -> i32 => a + b\n' : null
      },
    })
    const text = 'import "./util" (\n  "add" func add(a: i32, b: i32) -> i32\n  "mul" func mul(a: i32, b: i32) -> i32\n)\nexport func f(a: i32) -> i32 => mul(add(a, a), a)\n'
    await s.open(main, text)
    for (let i = 0; i < 100 && !s.sent.get(main)?.length; i++) await Bun.sleep(5)
    expect(asked).toEqual(['vscode-vfs://github/o/r/util.ents'])
    expect(s.sent.get(main)?.map((d) => d.message)).toContain("'mul' is not exported from './util'")
  })
})
