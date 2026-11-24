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
      if (name === 'languages') return { semanticTokens: { on: () => {} }, inlayHint: { on: (h: Handler) => handlers.set('onInlayHint', h) } }
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

  test('lists the functions declared in a body inside the function', async () => {
    const s = server()
    const text = `export func f(n: u32) -> u32 {
  func g(x: u32) -> u32 {
    func h() -> u32 => n
    return x + h()
  }
  if n > 1 {
    func k() -> u32 => 2
    return k()
  }
  return g(n)
}
`
    await s.open(uri, text)
    const symbols = s.ask<DocumentSymbol[]>('onDocumentSymbol', { textDocument: { uri } })
    expect(names(symbols)).toEqual([['f', [['g', ['h']], 'k']]])
  })

  // In a test as in a function: those at its top and those in its blocks,
  // and the test named as a string is written
  test('lists the functions declared in a test\'s blocks inside the test', async () => {
    const s = server()
    const text = `test "say \\"hi\\"" {
  let z: u32 = 1
  func plus(x: u32) -> u32 => x + z
  if true {
    func deep() -> u32 => z
    assert deep() == 1
  }
  for i in 2 {
    func step() -> u32 => i + z
    assert step() > 0
  }
  assert plus(1) == 2
}
`
    await s.open(uri, text)
    const symbols = s.ask<DocumentSymbol[]>('onDocumentSymbol', { textDocument: { uri } })
    expect(names(symbols)).toEqual([['test "say \\"hi\\""', ['plus', 'deep', 'step']]])
  })

  // A test's name is selected to its closing quote, past an escaped one, and
  // one that does not parse yet is named as it is once it parses
  test('names and selects a test whose name holds escapes, parsed or not', async () => {
    const s = server()
    const text = `export func f() -> u32 => 1
test "q\\"uote" {
  assert f() == 1
}
test "c\\x01" {
  assert f( == 1
}
test "ok\\x01" {
  assert f() == 1
}
`
    await s.open(uri, text)
    const symbols = s.ask<DocumentSymbol[]>('onDocumentSymbol', { textDocument: { uri } })
    expect(symbols.map((x) => x.name)).toEqual(['f', 'test "q\\"uote"', 'test "c\\u{1}"', 'test "ok\\u{1}"'])
    expect(symbols[1].selectionRange).toEqual({ start: { line: 1, character: 5 }, end: { line: 1, character: 14 } })
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
    // The global, used in area, would be hidden there by its parameter k.
    const used = SHAPES.replace('let w = p.x * k', 'let w = p.x * k * gain').replace('def scale = 3', 'def scale = 3\nglobal gain: i32 = 2')
    expect(await refused(used, used.indexOf('gain:'), 'k')).toContain('some of its uses would mean another thing')
    // A def cannot take the name of a parameter at all.
    const def = SHAPES.replace('let w = p.x * k', 'let w = p.x * k * scale')
    expect(await refused(def, def.indexOf('scale ='), 'k')).toContain("'k' is already declared: a parameter cannot reuse the name of a def")
    // Two locals of a name in one scope
    expect(await refused(SHAPES, SHAPES.indexOf('w * h'), 'h')).toContain("'h' is already declared")
    expect(await refused(SHAPES, SHAPES.indexOf('w * h'), 'loop')).toBe("'loop' is a keyword")
    expect(await refused(SHAPES, SHAPES.indexOf('w * h'), 'min')).toBe("'min' is a builtin")
    expect(await refused(SHAPES, SHAPES.indexOf('w * h'), 'u32')).toBe("'u32' is a type")
    expect(await refused(SHAPES, SHAPES.indexOf('Point ='), 'point')).toContain("is not a type's name")
  })

  test('a local bound by a field of its name keeps the field, and the field renamed keeps the local', async () => {
    const text = `export func pair(n: u32) -> (count: u32, clipped: bool) {
  count = n + 1
  clipped = n > 5
}
export func f(n: u32) -> u32 {
  let (count:, clipped:) = pair(n)
  return if clipped { 0 } else { count }
}
export func g(n: u32) -> u32 => pair(n).count
`
    const out = await renamed(text, text.indexOf('return if clipped') + 10, 'cut')
    expect(out).toContain('let (count:, clipped: cut) = pair(n)')
    expect(out).toContain('return if cut { 0 } else { count }')
    // A named result is a field of what pair returns too, named where the
    // result is taken apart: from its declaration, its uses in pair, or a
    // read of the field, it is renamed in each, and the local keeps its name.
    for (const at of [text.indexOf('count: u32'), text.indexOf('count = n'), text.indexOf('.count') + 1]) {
      expect(await renamed(text, at, 'total')).toBe(`export func pair(n: u32) -> (total: u32, clipped: bool) {
  total = n + 1
  clipped = n > 5
}
export func f(n: u32) -> u32 {
  let (total: count, clipped:) = pair(n)
  return if clipped { 0 } else { count }
}
export func g(n: u32) -> u32 => pair(n).total
`)
    }
  })

  test("a struct's field, where its type declares it and wherever it is named", async () => {
    // From a use: the type, the reads and the write, and not the x of log
    const out = await renamed(SHAPES, SHAPES.indexOf('p.x') + 2, 'left')
    expect(out).toContain('type Point = (left: i32, y: i32)')
    expect(out).toContain('p.left * p.left + p.y * p.y')
    expect(out).toContain('  p.left += by')
    expect(out).toContain('let w = p.left * k')
    expect(out).toContain('"log" func log(x: i32)')
    // In a constructor and in a pattern: a shorthand is written out, and the
    // variable it stands for keeps its name
    const text = `type Point = (x: i32, y: i32)
export func f(x: i32) -> i32 {
  let p = Point(x:, y: 2)
  let (x: a, y:) = p
  return a + y + p.x
}
`
    expect(await renamed(text, text.indexOf('x: i32'), 'left')).toBe(text.replace('Point(x:', 'Point(left: x').replace('(x: a', '(left: a').replace('p.x', 'p.left').replace('(x: i32', '(left: i32'))
    expect(await renamed(text, text.indexOf('y: i32'), 'top')).toBe(text.replace('y: 2', 'top: 2').replace('y:)', 'top: y)').replace('y: i32', 'top: i32'))
    // A builtin is no name to rename
    const s = server()
    await s.open(uri, SHAPES)
    expect(s.at('onPrepareRename', uri, SHAPES, SHAPES.indexOf('i32'))).toBeNull()
  })

  test('a keyword is no name to rename, also where a declaration starts with it', async () => {
    // A data a test declares, where another test declares one of its name
    // too, is defined where its declaration starts, at `data`: the keyword is
    // not its name.
    const text = 'export func f() -> u32 => 1\ntest "t" {\n  data b: *[2]u32 = [1, 2]\n  assert b[0] == 1\n}\ntest "u" {\n  data b: *[2]u32 = [3, 4]\n  assert b[1] == 4\n}\n'
    const s = server()
    await s.open(uri, text)
    expect(s.at('onPrepareRename', uri, text, text.indexOf('data b'))).toBeNull()
    expect(s.at<{ placeholder: string } | null>('onPrepareRename', uri, text, text.indexOf('b: *'))?.placeholder).toBe('b')
  })

  test('a field is not renamed where its struct is given for another that keeps the name', async () => {
    const text = `type Point = (x: i32, y: i32)
type Spot = (x: i32, y: i32)
export func f(p: Point) -> i32 {
  let s: Spot = p
  return s.x
}
`
    expect(await refused(text, text.indexOf('x: i32'), 'left')).toContain("renamed to 'left', the program would not check")
  })

  test('a field another module of the workspace names is not renamed', async () => {
    const lib = 'file:///ws/lib.ents'
    const main = 'file:///ws/main.ents'
    const libText = 'export func pair(n: u32) -> (count: u32, clipped: bool) => (count: n, clipped: n > 9)\n'
    // A comment may stand between import and the module's path
    const mainText = 'import /* shared */ "./lib" "pair" func pair(n: u32) -> (count: u32, clipped: bool)\nexport func f() -> u32 => pair(3).count\n'
    const files = new Map([[pathOf(lib) as string, libText], [pathOf(main) as string, mainText]])
    const s = server({ findFiles: async () => [lib, main], readFile: async (path) => files.get(path) ?? null })
    await s.open(lib, libText)
    const rename = (offset: number, newName: string) => s.at<Promise<WorkspaceEdit>>('onRenameRequest', lib, libText, offset, { newName })
    // main.ents reads count
    await expect(rename(libText.indexOf('count:'), 'total')).rejects.toThrow(
      "renamed to 'total', main.ents, which uses this module, would not check: no field 'count' on type (total: u32, clipped: bool)",
    )
    // It names clipped only in its import, which is not where it reads it
    expect(applied(libText, await rename(libText.indexOf('clipped:'), 'cut'), lib)).toBe(
      'export func pair(n: u32) -> (count: u32, cut: bool) => (count: n, cut: n > 9)\n',
    )
  })

  // A module that never writes pair(n).count still needs count, where it
  // gives what pair returns to a struct of its own with those fields.
  test('a field another module needs to give a whole value to another struct is not renamed', async () => {
    const lib = 'file:///ws/lib.ents'
    const libText = 'export func pair(n: u32) -> (count: u32, clipped: bool) => (count: n, clipped: n > 9)\nexport func other() -> (left: u32, right: u32) => (left: 1, right: 2)\n'
    const mainText = `import "./lib" "pair" func pair(n: u32) -> (count: u32, clipped: bool)
type Pair = (count: u32, clipped: bool)
func take(p: Pair) -> u32 => 1
export func f() -> u32 => take(pair(3))
`
    const files = new Map([[pathOf(lib) as string, libText], [pathOf('file:///ws/main.ents') as string, mainText]])
    const s = server({ findFiles: async () => [lib, 'file:///ws/main.ents'], readFile: async (path) => files.get(path) ?? null })
    await s.open(lib, libText)
    const rename = (offset: number, newName: string) => s.at<Promise<WorkspaceEdit>>('onRenameRequest', lib, libText, offset, { newName })
    for (const field of ['count:', 'clipped:']) {
      await expect(rename(libText.indexOf(field), 'renamed')).rejects.toThrow('main.ents, which uses this module, would not check')
    }
    // A struct no other module gives elsewhere
    expect(applied(libText, await rename(libText.indexOf('left:'), 'first'), lib)).toContain('-> (first: u32, right: u32) => (first: 1, right: 2)')
  })

  test('a file that changes while the rename is checked is not edited, and an edit says its version', async () => {
    const text = 'export func pair(n: u32) -> (count: u32, clipped: bool) => (count: n, clipped: n > 9)\n'
    let listed = (_: string[]) => {}
    let asked = false
    const s = server({
      findFiles: () => {
        asked = true
        return new Promise<string[]>((resolve) => {
          listed = resolve
        })
      },
    })
    s.ask('onInitialize', { capabilities: { workspace: { workspaceEdit: { documentChanges: true } } } })
    await s.open(uri, text)
    // The workspace is listed while the field is renamed; the file is edited then
    const pending = s.at<Promise<WorkspaceEdit>>('onRenameRequest', uri, text, text.indexOf('count:'), { newName: 'total' })
    for (let i = 0; i < 200 && !asked; i++) await Bun.sleep(5)
    expect(asked).toBe(true)
    await s.change(uri, `// a line above\n${text}`)
    listed([])
    await expect(pending).rejects.toThrow('The file changed while the rename was checked')
    // Unchanged, the edit is of the version it was made of
    asked = false
    const again = s.at<Promise<WorkspaceEdit>>('onRenameRequest', uri, `// a line above\n${text}`, text.indexOf('count:') + 16, { newName: 'total' })
    for (let i = 0; i < 200 && !asked; i++) await Bun.sleep(5)
    listed([])
    const edit = await again
    expect(edit.changes).toBeUndefined()
    const [change] = edit.documentChanges as { textDocument: { uri: string; version: number }; edits: unknown[] }[]
    expect(change.textDocument).toEqual({ uri, version: 2 })
    expect(change.edits.length).toBe(2)
  })

  test('a field is not renamed while the workspace cannot be listed, and the listing is not an old one', async () => {
    const lib = 'file:///ws/lib.ents'
    const main = 'file:///ws/main.ents'
    const libText = 'export func pair(n: u32) -> (count: u32, clipped: bool) => (count: n, clipped: n > 9)\n'
    const files = new Map([[pathOf(lib) as string, libText]])
    let found: () => Promise<string[]> = async () => {
      throw new Error('no workspace')
    }
    const s = server({ findFiles: () => found(), readFile: async (path) => files.get(path) ?? null })
    await s.open(lib, libText)
    const rename = () => s.at<Promise<WorkspaceEdit>>('onRenameRequest', lib, libText, libText.indexOf('count:'), { newName: 'total' })
    await expect(rename()).rejects.toThrow("the workspace's files could not all be listed, so the modules that use this one could not be checked: no workspace")
    // A search keeps its listing a while; a rename lists the files again, and
    // finds the module that came since
    found = async () => [lib]
    await s.ask<Promise<unknown>>('onWorkspaceSymbol', { query: '' })
    files.set(pathOf(main) as string, 'import "./lib" "pair" func pair(n: u32) -> (count: u32, clipped: bool)\nexport func f() -> u32 => pair(3).count\n')
    found = async () => [lib, main]
    await expect(rename()).rejects.toThrow('main.ents, which uses this module, would not check')
  })

  test('a field is not renamed where a module that may use it cannot be checked', async () => {
    const lib = 'file:///ws/lib.ents'
    const main = 'file:///ws/main.ents'
    const other = 'file:///ws/other.ents'
    const libText = 'export func pair(n: u32) -> (count: u32, clipped: bool) => (count: n, clipped: n > 9)\n'
    const uses = 'import "./lib" "pair" func pair(n: u32) -> (count: u32, clipped: bool)\nexport func f() -> u32 => pair(3).count\n'
    const files = new Map<string, string | null>([[pathOf(lib) as string, libText], [pathOf(other) as string, 'func unfinished(\n']])
    const s = server({ findFiles: async () => [lib, main, other], readFile: async (path) => files.get(path) ?? null })
    await s.open(lib, libText)
    const rename = () => s.at<Promise<WorkspaceEdit>>('onRenameRequest', lib, libText, libText.indexOf('count:'), { newName: 'total' })
    // A file that is listed and cannot be read may be one that uses it
    await expect(rename()).rejects.toThrow(`${pathOf(main)} could not be read, so whether it uses this module could not be checked`)
    // One that uses it and does not parse, for a declaration that has
    // nothing to do with it: what parses of it imports lib. (other.ents does
    // not parse either, and imports nothing.)
    files.set(pathOf(main) as string, `${uses}func unfinished(\n`)
    await expect(rename()).rejects.toThrow('main.ents, which uses this module, does not parse yet, so it could not be checked')
    // One whose import of it is in what does not parse yet: a test whose
    // brace is not closed, which the recovery of the rest leaves out
    const reads = 'test "reads count" {\n  import "./lib" "pair" func pair(n: u32) -> (count: u32, clipped: bool)\n  assert pair(3).count == 3\n'
    files.set(pathOf(main) as string, `export func g() -> u32 => 1\n${reads}`)
    await expect(rename()).rejects.toThrow('main.ents, which uses this module, does not parse yet, so it could not be checked')
    // ... or through another module that holds it
    files.set(pathOf('file:///ws/mid.ents') as string, 'import "./lib" "pair" func pair(n: u32) -> (count: u32, clipped: bool)\nexport func two() -> u32 => 2\n')
    files.set(pathOf(main) as string, `export func g() -> u32 => 1\n${reads.replace('import "./lib" "pair" func pair(n: u32) -> (count: u32, clipped: bool)', 'import "./mid" "two" func two() -> u32')}`)
    await expect(rename()).rejects.toThrow('main.ents, which uses this module, does not parse yet, so it could not be checked')
    files.delete(pathOf('file:///ws/mid.ents') as string)
    // ... or in an import still being written
    files.set(pathOf(main) as string, 'export func g() -> u32 => 1\nimport "./lib" (\n  "pair" func pair(n: u32) ->\n')
    await expect(rename()).rejects.toThrow('main.ents, which uses this module, does not parse yet, so it could not be checked')
    // One that imports it, and whose program does not load
    files.set(pathOf(main) as string, `import "./gone" "g" func g() -> u32\n${uses}`)
    await expect(rename()).rejects.toThrow('main.ents, which imports this module, could not be checked: its program does not load')
    // Once it parses and loads, it is checked
    files.set(pathOf(main) as string, uses)
    await expect(rename()).rejects.toThrow("main.ents, which uses this module, would not check: no field 'count'")
    // An import that is commented out is none
    files.set(pathOf(main) as string, 'export func g() -> u32 => 1\ntest "t" {\n  // import "./lib" "pair" func pair(n: u32) -> (count: u32, clipped: bool)\n  assert true\n')
    expect(applied(libText, await rename(), lib)).toContain('-> (total: u32, clipped: bool) => (total: n,')
    files.set(pathOf(main) as string, 'export func f() -> u32 => 1\n')
    expect(applied(libText, await rename(), lib)).toContain('-> (total: u32, clipped: bool) => (total: n,')
  })

  test('a field is not renamed where the workspace is listed in part, and a search shows the part', async () => {
    const lib = 'file:///ws/lib.ents'
    const libText = 'export func pair(n: u32) -> (count: u32, clipped: bool) => (count: n, clipped: n > 9)\n'
    const s = server({
      findFiles: async () => ({ uris: [lib, 'file:///ws/other.ents'], incomplete: '/ws/locked could not be read (EACCES)' }),
      readFile: async (path) => (path === pathOf('file:///ws/other.ents') ? 'export func other() -> u32 => 1\n' : null),
    })
    await s.open(lib, libText)
    await expect(s.at<Promise<WorkspaceEdit>>('onRenameRequest', lib, libText, libText.indexOf('count:'), { newName: 'total' })).rejects.toThrow(
      "the workspace's files could not all be listed, so the modules that use this one could not be checked: /ws/locked could not be read (EACCES)",
    )
    // A name that is no field needs no other module checked
    expect(applied(libText, await s.at<Promise<WorkspaceEdit>>('onRenameRequest', lib, libText, libText.indexOf('n: u32'), { newName: 'k' }), lib)).toContain('pair(k: u32)')
    const found = await s.ask<Promise<{ name: string }[]>>('onWorkspaceSymbol', { query: '' })
    expect(found.map((f) => f.name)).toContain('other')
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

describe('inlay hints', () => {
  const text = `type Point = (x: i32, y: i32)
def three = 3
func scale(p: Point, by: i32) -> Point => Point(p.x * by, p.y * by)
export func f(n: u32) -> i32 {
  let p = scale(Point(1, 2), 2)
  let q: Point = scale(p, three)
  for i in n {
    let j = i * 2
  }
  return p.x + q.y
}
`
  type Hint = { position: { line: number; character: number }; label: string }
  // The lines with their hints written in, as ⟨label⟩
  async function hinted(source: string, edited = source, range?: { start: { line: number; character: number }; end: { line: number; character: number } }) {
    const s = server()
    await s.open(uri, source)
    if (edited !== source) await s.change(uri, edited)
    const lines = edited.split('\n')
    const hints = s.ask<Hint[]>('onInlayHint', { textDocument: { uri }, range: range ?? { start: { line: 0, character: 0 }, end: { line: lines.length, character: 0 } } })
    for (const h of [...hints].sort((a, b) => b.position.line - a.position.line || b.position.character - a.position.character)) {
      const line = lines[h.position.line]
      lines[h.position.line] = `${line.slice(0, h.position.character)}⟨${h.label}⟩${line.slice(h.position.character)}`
    }
    return lines.filter((l) => l.includes('⟨')).map((l) => l.trim())
  }

  test('the type of a name bound with none written, and the parameter of a literal argument', async () => {
    expect(await hinted(text)).toEqual([
      'let p⟨: Point⟩ = scale(Point(1, 2), ⟨by:⟩2)',
      'for i⟨: u32⟩ in n {',
      'let j⟨: u32⟩ = i * 2',
    ])
  })

  test('only in the lines asked for', async () => {
    expect(await hinted(text, text, { start: { line: 6, character: 0 }, end: { line: 7, character: 0 } })).toEqual(['for i⟨: u32⟩ in n {'])
  })

  // Written by its names, a type that refers to itself was expanded forever.
  test('a type that refers to itself', async () => {
    const recursive = `type Node = (next: ?*Node, v: u32)
type Even = (odd: ?*Odd, v: u32)
type Odd = (even: ?*Even, v: u32)
export func f(n: *Node, e: *Even) -> u32 {
  let m = n.next
  let o = e.odd
  return n.v
}
`
    expect(await hinted(recursive)).toEqual(['let m⟨: ?*Node⟩ = n.next', 'let o⟨: ?*Odd⟩ = e.odd'])
  })

  test('none in a declaration that does not parse yet', async () => {
    const edited = text.replace('  return p.x + q.y', '  return p.x + (q.y')
    expect(await hinted(text, edited)).toEqual([])
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

  test('the name an if let binds is offered in its branch, and not in the branches after it', async () => {
    const base = `export func f(o: ?*u32, n: u32) -> u32 {
  if let found = o {
    return found.*
  } elif n > 2 {
    return 1
  } else {
    return 0
  }
}
`
    const at = (line: string) => completeIn(base, base.replace(line, `    let z = |\n${line}`)).then((items) => items.map((i) => i.label))
    expect(await at('    return found.*')).toContain('found')
    for (const line of ['    return 1', '    return 0']) {
      const labels = await at(line)
      expect(labels).toContain('n')
      expect(labels).not.toContain('found')
    }
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

describe('workspace symbols', () => {
  test('the declarations of the files the editor finds and of the open documents', async () => {
    const files = new Map([
      [pathOf('file:///ws/a.ents') as string, 'export func alpha() -> u32 => 1\ntype Point = (x: i32, y: i32)\nimport "./b" ("beta" func beta())\n'],
      [pathOf('file:///ws/b.ents') as string, 'export func beta() {}\n'],
    ])
    const s = server({ findFiles: async () => ['file:///ws/a.ents', 'file:///ws/b.ents'], readFile: async (path) => files.get(path) ?? null })
    await s.open('file:///ws/c.ents', 'func gamma() {}\n')
    type Found = { name: string; location: { uri: string; range: { start: { line: number; character: number } } }; containerName?: string }
    const shown = (found: Found[]) => found.map((f) => `${f.name}${f.containerName ? ` in ${f.containerName}` : ''} ${f.location.uri.slice(-6)}:${f.location.range.start.line}:${f.location.range.start.character}`)
    // An import is not a declaration of the file that imports it.
    expect(shown(await s.ask<Promise<Found[]>>('onWorkspaceSymbol', { query: '' }))).toEqual([
      'gamma c.ents:0:5',
      'alpha a.ents:0:12',
      'Point a.ents:1:5',
      'x in Point a.ents:1:14',
      'y in Point a.ents:1:22',
      'beta b.ents:0:12',
    ])
    // The letters of the query, in order
    expect(shown(await s.ask<Promise<Found[]>>('onWorkspaceSymbol', { query: 'pt' }))).toEqual(['Point a.ents:1:5'])
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
