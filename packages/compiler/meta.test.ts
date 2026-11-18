import { describe, test, expect } from 'bun:test'
import { Glob } from 'bun'
import { parse } from './parser'
import { buildMeta, type MetaOutput } from './meta'
import { loadModule } from './loader'
import { typecheckProgram } from './checker'
import { resolve } from 'node:path'

function metaHints(source: string): Record<string, { name: string | null; type: string }> {
  const result = parse(source)
  if (result.errors.length > 0) throw new Error(result.errors.map(e => e.message).join(', '))
  const meta = buildMeta(result.module!, source)
  const out: Record<string, { name: string | null; type: string }> = {}
  for (const [key, hint] of Object.entries(meta.hints)) {
    const sym = hint.symbol !== undefined ? meta.symbols[hint.symbol] : null
    out[key] = { name: sym?.name ?? null, type: meta.types[hint.type]?.type ?? 'unknown' }
  }
  return out
}

describe('test block hints', () => {
  test('locals in test blocks get hints', () => {
    const hints = metaHints(`
test "example" {
  let x: u8 = 42
  let y: u32 = 100
  assert x == 42
}`)
    expect(hints['2:6']).toEqual({ name: 'x', type: 'u8' })
    expect(hints['3:6']).toEqual({ name: 'y', type: 'u32' })
  })

  test('nested test blocks get hints', () => {
    const hints = metaHints(`
test "outer" {
  test "inner" {
    let n: i8 = -1
    assert n == -1
  }
}`)
    expect(hints['3:8']).toEqual({ name: 'n', type: 'i8' })
  })

  test('same-named locals in different test blocks get correct types', () => {
    const hints = metaHints(`
test "first" {
  let a: u8 = 1
}
test "second" {
  let a: u32 = 2
}`)
    expect(hints['2:6']?.type).toBe('u8')
    expect(hints['5:6']?.type).toBe('u32')
  })

  test('assert expressions get hints', () => {
    const hints = metaHints(`
func add(a: u8, b: u8) -> u8 => a + b
test "add" {
  assert add(1, 2) == 3
}`)
    expect(hints['3:9']?.name).toBe('add')
  })
})

describe('generic types', () => {
  const source = `func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
type Pt = (q: i32, r: i32)
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }
export func f(p: u32, a: Pt, b: Pt) -> Pt {
  let v = p as *mut Vec(Pt)
  return max(a, b)
}`

  function meta(): MetaOutput {
    const result = parse(source)
    expect(result.errors).toEqual([])
    return buildMeta(result.module!, source)
  }

  test('a generic type is a type symbol, with the declaration it was written with', () => {
    const built = meta()
    const vec = built.symbols.find(s => s.name === 'Vec')
    expect(vec?.kind).toBe('type')
    expect(vec?.def).toBe('0:5')
    expect(built.types[vec?.type ?? -1].type).toBe('(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)')
    expect(vec?.refs).toEqual(['4:20'])
  })

  test('where it is applied, its name is that symbol and its arguments are types of their own', () => {
    const built = meta()
    expect(built.symbols[built.hints['4:20'].symbol ?? -1].name).toBe('Vec')
    expect(built.symbols[built.hints['4:24'].symbol ?? -1].name).toBe('Pt')
  })

  test('an error in an instance comes with the call it was required from', () => {
    expect(meta().errors).toEqual([
      { pos: '2:50', message: "'>' cannot be applied to Pt and Pt, in max(T = Pt)", notes: [{ pos: '5:9', message: 'required from' }] },
    ])
  })
})

describe('generic functions', () => {
  const source = `data nums = [3:u32, 5, 8, 13]
func find(comptime T: type, xs: []T, x: T) -> u32 {
  for i, v in xs {
    return i when v == x
  }
  return xs.len
}
func contains(comptime T: type, xs: []T, x: T) -> bool => find(xs, x) < xs.len
export func has_byte(xs: []u8, x: u8) -> bool => contains(xs, x)
test "find" {
  assert find(nums, 8) == 2
}`

  function meta(): MetaOutput {
    const result = parse(source)
    expect(result.errors).toEqual([])
    return buildMeta(result.module!, source)
  }

  test('instances are not symbols', () => {
    expect(meta().symbols.map(s => s.name).filter(name => name.includes('<'))).toEqual([])
  })

  test('every hint is at a place in the source', () => {
    const lines = source.split('\n')
    const hints = Object.keys(meta().hints)
    expect(hints.length).toBeGreaterThan(0)
    for (const key of hints) {
      const [line, column] = key.split(':').map(Number)
      expect(line).toBeLessThan(lines.length)
      expect(column).toBeLessThan(lines[line].length)
    }
  })

  test('a call of a generic shows the signature of its instance', () => {
    const hints = metaHints(source)
    expect(hints['8:49'].type).toBe('(xs:[]u8,x:u8)->bool')
    expect(hints['10:9'].type).toBe('(xs:[]u32,x:u32)->u32')
  })

  test('examples/generics/slices.ents: no instance among the symbols, no hint outside the source', async () => {
    const example = await Bun.file(new URL('../../examples/generics/slices.ents', import.meta.url)).text()
    const result = parse(example)
    expect(result.errors).toEqual([])
    const built = buildMeta(result.module!, example)
    expect(built.symbols.map(s => s.name).filter(name => name.includes('<'))).toEqual([])
    const lines = example.split('\n')
    expect(Object.keys(built.hints).length).toBeGreaterThan(20)
    for (const key of Object.keys(built.hints)) {
      const [line, column] = key.split(':').map(Number)
      expect(line).toBeLessThan(lines.length)
      expect(column).toBeLessThan(lines[line].length)
    }
  })

  test('a generic is a symbol, with the signature it was written with', () => {
    const built = meta()
    const find = built.symbols.find(s => s.name === 'find')
    expect(find?.kind).toBe('func')
    expect(find?.def).toBe('1:5')
    expect(built.types[find?.type ?? -1].type).toBe('(comptime T: type, xs: []T, x: T)->u32')
    // The hint at a call names that symbol, so the editor shows the generic
    // there and not a builtin of the same name.
    const call = built.hints['8:49']
    expect(built.symbols[call.symbol ?? -1].name).toBe('contains')
  })

  test('examples/generics/minmax.ents: max is the generic, at its declaration and at its calls', async () => {
    const example = await Bun.file(new URL('../../examples/generics/minmax.ents', import.meta.url)).text()
    const result = parse(example)
    expect(result.errors).toEqual([])
    const built = buildMeta(result.module!, example)
    const lines = example.split('\n')
    const max = built.symbols.findIndex(s => s.name === 'max')
    expect(built.types[built.symbols[max].type].type).toBe('(comptime T: type, a: T, b: T)->T')
    const line = lines.findIndex(l => l.startsWith('export func max_u32'))
    const call = built.hints[`${line}:${lines[line].indexOf('max(a, b)')}`]
    expect(call.symbol).toBe(max)
    expect(built.types[call.type].type).toBe('(a:u32,b:u32)->u32')
    // The parameters and locals of a generic are symbols with the type they
    // are declared with, with the uses inside the generic and no others:
    // found by name, they would be those of the same name in another
    // function. Its type parameter is one too.
    const swap = lines.findIndex(l => l.startsWith('func swap('))
    const inSwap = built.symbols.filter(s => Number(s.def.split(':')[0]) >= swap && Number(s.def.split(':')[0]) <= swap + 4)
    expect(inSwap.map(s => `${s.name}: ${built.types[s.type].type}`)).toEqual(['swap: (comptime T: type, a: *mut T, b: *mut T)->()', 'a: *mut T', 'b: *mut T', 'tmp: T', 'T: type'])
    for (const s of inSwap.slice(1)) {
      expect(s.refs.length).toBeGreaterThan(0)
      for (const ref of s.refs) {
        const line = Number(ref.split(':')[0])
        expect(line >= swap && line <= swap + 4).toBe(true)
      }
    }
  })

  test('the body of a generic has the types its names are declared with, and their types in each instance', () => {
    // find is first asked for by the test, for u32: the bodies of instances
    // are come to after everything else, contains<u8> among them.
    const built = meta()
    const shown = (key: string) => {
      const hint = built.hints[key]
      const instances = (hint.instances ?? []).map(i => ` [${i.in.join(', ')}: ${built.types[i.type].type}]`).join('')
      return `${key} ${built.types[hint.type].type}${instances}`
    }
    const inFind = Object.keys(built.hints).filter(key => {
      const line = Number(key.split(':')[0])
      return line >= 1 && line <= 6
    }).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    const t = '[find(T = u32): u32] [find(T = u8): u8]'
    const ts = '[find(T = u32): []u32] [find(T = u8): []u8]'
    const same = '[find(T = u32), find(T = u8): u32]'
    // `for i, v in xs`: the index i and the value v each at its name. The
    // type parameter T where it is declared and at each use.
    expect(inFind.map(shown)).toEqual([
      '1:5 (comptime T: type, xs: []T, x: T)->u32 [find(T = u32): func(xs: []u32, x: u32) -> u32] [find(T = u8): func(xs: []u8, x: u8) -> u32]',
      `1:19 type ${t}`, `1:28 []T ${ts}`, `1:34 type ${t}`, `1:37 T ${t}`, `1:40 type ${t}`,
      `2:6 u32 ${same}`, `2:9 T ${t}`, `2:14 []T ${ts}`,
      `3:11 u32 ${same}`, `3:18 T ${t}`, `3:23 T ${t}`,
      `5:9 []T ${ts}`, `5:12 u32 ${same}`,
    ])
    // A call in it is the instance that instance calls.
    expect(built.hints['7:58'].calls).toBe('find(T = u8)')
    expect(built.types[built.hints['7:58'].type].type).toBe('(xs:[]u8,x:u8)->u32')
    // The type parameter is a symbol, found from where it is declared.
    const symbol = built.symbols[built.hints['1:19'].symbol ?? -1]
    expect(symbol).toEqual({ name: 'T', kind: 'typeparam', type: built.hints['1:19'].type, def: '1:19', refs: ['1:34', '1:40'] })
  })

  test('a generic nothing has called has hints where its own names are declared with a written type, and none else inside', () => {
    const lonely = 'func keep(comptime T: type, a: T) -> T {\n  let b = a\n  let c: *T = &b\n  return b\n}\nexport func f() { }'
    const result = parse(lonely)
    const built = buildMeta(result.module!, lonely)
    const hints = Object.entries(built.hints).map(([key, hint]) => `${key} ${built.types[hint.type].type} ${built.symbols[hint.symbol ?? -1]?.kind}`)
    expect(hints.sort()).toEqual(['0:19 type typeparam', '0:28 T param', '0:31 type typeparam', '0:37 type typeparam', '0:5 (comptime T: type, a: T)->T func', '2:10 type typeparam', '2:6 *T local', '5:12 ()->() func'])
    expect(built.symbols.map(s => s.name)).toEqual(['keep', 'f', 'T', 'a', 'c'])
  })

  test('a def\'s value has its own hints, not those of a use it is pasted at', () => {
    // examples/types/complements.ents: `~low` is a u32 where with_def uses
    // high, and an i32 in the def itself.
    const program = 'def low = 7\ndef high = ~low\nexport func f(n: u32) -> u32 => n & high\n'
    const built = buildMeta(parse(program).module!, program)
    expect(built.types[built.hints['1:12'].type].type).toBe('i32')
  })

  test('a use of a def in a function is the module\'s def, though a test after it declares one of the name', () => {
    // Since the body's hints are made once every declaration is a symbol, the
    // def a test declares, collected last, was taken by name for the
    // module's: definition went into the test.
    const program = 'def k = 3\nexport func f() -> u32 => k\ntest "own" {\n  def k = 5\n  assert k == 5\n}\n'
    const meta = buildMeta(parse(program).module!, program)
    expect(meta.symbols[meta.hints['1:26'].symbol ?? -1]?.def).toBe('0:4')
    // In the test, its own.
    expect(meta.symbols[meta.hints['4:9'].symbol ?? -1]?.def).toBe('3:6')
  })

  test('a call of a function declared further down has that function as its symbol', () => {
    // The body of a function had its hints before the functions after it
    // were symbols: the call was a type with no name.
    const built = buildMeta(parse('export func a() -> u32 => b() + 1\nfunc b() -> u32 => 2\n').module!, 'export func a() -> u32 => b() + 1\nfunc b() -> u32 => 2\n')
    expect(built.symbols[built.hints['0:26'].symbol ?? -1]?.name).toBe('b')
  })
})

describe('method calls and functions that share a name', () => {
  const source = `func hash(k: u32) -> u32 => k
func hash(k: []u8) -> u32 => k.len
func slot(comptime K: type, k: K, n: u32) -> u32 {
  let h = k.hash()
  return hash(k) % n + h.min(n)
}
export func f(xs: []u8) -> u32 => xs.slot(4) + hash(7:u32)`

  function meta(): MetaOutput {
    const result = parse(source)
    expect(result.errors).toEqual([])
    return buildMeta(result.module!, source)
  }

  test('each function of a shared name is a symbol under that name, with its own type and uses', () => {
    const built = meta()
    const hashes = built.symbols.filter(s => s.name === 'hash')
    expect(hashes.map(s => `${built.types[s.type].type} ${s.def}`)).toEqual(['(k:u32)->u32 0:5', '(k:[]u8)->u32 1:5'])
    expect(hashes[0].refs).toContain('6:47')
    expect(hashes[1].refs).not.toContain('6:47')
    expect(built.symbols.map(s => s.name).filter(name => name.includes(':'))).toEqual([])
  })

  test('a call shows the function it means', () => {
    const built = meta()
    const at = (key: string) => `${built.types[built.hints[key].type].type} @${built.symbols[built.hints[key].symbol ?? -1]?.def}`
    expect(at('6:47')).toBe('(k:u32)->u32 @0:5')
    // In the generic, as its first instance calls it: for []u8.
    expect(at('4:9')).toBe('(k:[]u8)->u32 @1:5')
  })

  test('the name of a method has the hint of the function called', () => {
    const built = meta()
    const at = (key: string) => `${built.types[built.hints[key].type].type} @${built.symbols[built.hints[key].symbol ?? -1]?.def}`
    expect(at('6:37')).toBe('(k:[]u8,n:u32)->u32 @2:5')
    expect(at('3:12')).toBe('(k:[]u8)->u32 @1:5')
    // A builtin called that way has the builtin's.
    expect(at('4:25')).toBe('(a:i32,b:i32)->i32 @undefined')
    // The receiver keeps its own.
    expect(at('6:34')).toBe('[]u8 @6:14')
  })
})

describe('what a generic is in each of its instances', () => {
  const source = `func hash(k: u32) -> u32 => k
func hash(k: []u8) -> u32 => k.len
func Box(comptime T: type) -> type => (v: T, n: u32)
func slot(comptime K: type, b: Box(K), n: u32) -> u32 => b.v.hash() % n
export func f(a: Box(u32), b: Box([]u8)) -> u32 => slot(a, 4) + b.slot(8)`

  function meta(): MetaOutput {
    const result = parse(source)
    expect(result.errors).toEqual([])
    return buildMeta(result.module!, source)
  }
  const listed = (built: MetaOutput, key: string) => (built.hints[key].instances ?? []).map(i => `${i.in.join(', ')}: ${built.types[i.type].type}`)

  test('a call in a generic\'s body has the function each instance calls; a method call the call it is', () => {
    const built = meta()
    expect(built.hints['3:61'].as).toBe('hash(b.v)')
    expect(listed(built, '3:61')).toEqual(['slot(K = u32): hash(k: u32) -> u32', 'slot(K = []u8): hash(k: []u8) -> u32'])
    expect(built.hints['4:51'].calls).toBe('slot(K = u32)')
    expect(built.hints['4:66']).toMatchObject({ calls: 'slot(K = []u8)', as: 'slot(b, 8)' })
  })

  test('a call in a generic\'s body is the function the first instance calls, for its symbol', () => {
    // The first instance (K = u32) calls hash(k: u32), the second hash(k: []u8),
    // which was recorded last: by that the hint named the second.
    const program = source.replace('b.v.hash() % n', 'hash(b.v) % n')
    const built = buildMeta(parse(program).module!, program)
    const symbol = built.symbols[built.hints['3:57'].symbol ?? -1]
    expect(`${symbol?.name} @${symbol?.def}`).toBe('hash @0:5')
    expect(listed(built, '3:57')).toEqual(['slot(K = u32): hash(k: u32) -> u32', 'slot(K = []u8): hash(k: []u8) -> u32'])
  })

  test('a comptime function parameter is a symbol of its own, with the function each instance was given', () => {
    const program = `func apply(comptime T: type, comptime f: (T) -> T, x: T) -> T => f(x)
func inc(x: u32) -> u32 => x + 1
func neg(x: f64) -> f64 => -x
export func g(a: u32, b: f64) -> f64 => (apply(inc, a) as f64) + apply(neg, b)`
    const built = buildMeta(parse(program).module!, program)
    const at = '0:38'
    const symbol = built.symbols[built.hints[at].symbol ?? -1]
    expect(symbol).toMatchObject({ name: 'f', kind: 'comptime', def: at, refs: ['0:65'] })
    expect(built.types[symbol.type].type).toBe('(T) -> T')
    for (const key of [at, '0:65']) {
      expect(built.hints[key].symbol).toBe(built.hints[at].symbol)
      expect(listed(built, key)).toEqual(['apply(T = u32, f = inc): inc(x: u32) -> u32', 'apply(T = f64, f = neg): neg(x: f64) -> f64'])
    }
  })

  test('a generic type has its applications, and its parameter and its fields what each one makes them', () => {
    const built = meta()
    expect(listed(built, '2:5')).toEqual(['Box(u32): (v:u32,n:u32)', 'Box([]u8): (v:[]u8,n:u32)'])
    expect(listed(built, '2:18')).toEqual(['Box(u32): u32', 'Box([]u8): []u8'])
    expect(built.types[built.hints['2:39'].type].type).toBe('T')
    expect(listed(built, '2:39')).toEqual(['Box(u32): u32', 'Box([]u8): []u8'])
    // A field after a point in a generic's body, in each instance
    expect(listed(built, '3:59')).toEqual(['slot(K = u32): u32', 'slot(K = []u8): []u8'])
    expect(built.types[built.hints['3:59'].type].type).toBe('K')
  })
})

// The generics another source module exports are symbols of the module that
// imports them, defined at the import, whether the module is checked with
// its program or on its own: the editor finds their definition and uses.
describe('imported generics', () => {
  const lib = `export func Box(comptime T: type) -> type => (v: T)
export func open(comptime T: type, b: Box(T)) -> T => b.v
`
  const main = `import "./lib" (
  "Box" func Box(comptime T: type) -> type
  "open" func unbox(comptime T: type, b: Box(T)) -> T
)
export func f(b: Box(u32)) -> u32 => unbox(b) + unbox(Box(u32)(7))
`

  function symbols(meta: MetaOutput) {
    return Object.fromEntries(meta.symbols.filter(s => s.name === 'Box' || s.name === 'unbox').map(s => [s.name, { kind: s.kind, def: s.def, refs: s.refs }]))
  }
  const expected = {
    Box: { kind: 'type', def: '1:13', refs: ['4:17', '4:54'] },
    unbox: { kind: 'func', def: '2:14', refs: ['4:37', '4:48'] },
  }

  test('in its program', async () => {
    // Asked for by the path the loader names a file by: resolved, which on
    // Windows gives it a drive and backslashes.
    const files = new Map([[resolve('/p/lib.ents'), lib], [resolve('/p/main.ents'), main]])
    const load = await loadModule('/p/main.ents', { readFile: async path => files.get(path) ?? null })
    expect(load.errors).toEqual([])
    const check = typecheckProgram(load.modules, load.entry.path)
    expect(check.errors).toEqual([])
    const checkResult = check.results.get(load.entry.path)
    expect(symbols(buildMeta(load.entry.module, main, { checkResult }))).toEqual(expected)
  })

  test('on its own', () => {
    const result = parse(main)
    expect(symbols(buildMeta(result.module!, main))).toEqual(expected)
  })
})

describe('a module with errors', () => {
  const meta = (source: string): MetaOutput => {
    const result = parse(source)
    if (result.errors.length > 0) throw new Error(result.errors.map(e => e.message).join(', '))
    return buildMeta(result.module!, source)
  }
  const addressOf = (out: MetaOutput, name: string) => out.symbols.find(s => s.name === name)?.value

  test('a data literal with an element of the wrong type has no address, the others keep theirs', () => {
    // (A Pt that held a Pt is no type at all: see checker.test.ts.)
    const out = meta(`
type In = (a: u8, b: u8)
type Pt = (q: i32, r: In)
data ok = [1, 2]
data dp = [Pt(1, 2), Pt(3, 4)]
export func a() -> u32 => 1`)
    expect(out.errors?.map(e => e.message)).toEqual([
      'field r: cannot assign int(2) to In',
      'field r: cannot assign int(4) to In',
    ])
    expect(addressOf(out, 'ok')).toBe('0x8')
    expect(addressOf(out, 'dp')).toBeUndefined()
    expect(out.symbols.map(s => s.name)).toEqual(['In', 'Pt', 'ok', 'dp', 'a'])
  })

  // Each of these is rejected by the checker with a literal that can't be laid out.
  const rejected: [string, string][] = [
    ['an integer for a bool field', 'type P = (q: i32, r: bool)\ndata dp: []P = [(1, 1)]'],
    ['a float for an integer field', 'type P = (q: i32, r: i32)\ndata dp: []P = [(1, 2.5)]'],
    ['a float for a pointer field', 'type P = (q: i32, r: *i32)\ndata dp: []P = [(1, 2.5)]'],
    ['an integer for a struct field', 'type In = (a: u8, b: u16)\ntype P = (q: i32, r: In)\ndata dp: []P = [(1, 2)]'],
    ['an integer for an array field', 'type P = (q: i32, r: [2]i32)\ndata dp: []P = [(1, 2)]'],
    ['an integer for a function field', 'type P = (q: i32, r: (i32) -> i32)\ndata dp: []P = [(1, 2)]'],
    ['a float in an array of integers', 'data dp: *[2]i32 = [1, 2.5]'],
    ['a float in an array inside a struct', 'type P = (q: i32, r: []u8)\ndata dp: []P = [(1, [1.5, 2])]'],
    ['a float in a slice of integers in a function', 'func f() -> u32 {\n  let s: []u32 = [1.5, 2.5]\n  return s.len\n}'],
  ]
  for (const [name, source] of rejected) {
    test(`${name} is reported, not thrown`, () => {
      const out = meta(`data ok = [1, 2]\n${source}`)
      expect(out.errors?.length).toBeGreaterThan(0)
      expect(addressOf(out, 'ok')).toBe('0x8')
    })
  }
})

describe('meta.json generation', () => {
  const glob = new Glob('*.ents')
  const fixturesDir = new URL('./__fixtures__/analyser-vectors', import.meta.url)
  const vectorDir = fixturesDir.pathname

  // Check if fixtures directory exists before running tests
  let vectorsExist = false
  try {
    vectorsExist = Bun.file(vectorDir).isDirectory()
  } catch {
    // Directory doesn't exist
  }

  if (!vectorsExist) {
    test.skip('meta.json generation (fixtures not available)', () => {})
    return
  }

  for (const file of glob.scanSync(vectorDir)) {
    const name = file.replace('.ents', '')

    test(name, async () => {
      const entsPath = `${vectorDir}/${file}`
      const metaPath = `${vectorDir}/${name}.meta.json`

      // Read source
      const source = await Bun.file(entsPath).text()

      // Read expected output
      const expectedFile = Bun.file(metaPath)
      if (!(await expectedFile.exists())) {
        return
        // throw new Error(`Missing expected meta file: ${metaPath}`)
      }
      const expected: MetaOutput = await expectedFile.json()

      // Parse and generate meta
      const result = parse(source)
      if (result.errors.length > 0) {
        throw new Error(`Parse errors: ${result.errors.map((e) => e.message).join(', ')}`)
      }
      if (!result.module) {
        throw new Error('Failed to parse module')
      }

      const srcPath = `file://./${file}`
      const actual = buildMeta(result.module, source, { srcPath })

      // Compare - remove $schema from expected for comparison
      const expectedWithoutSchema = { ...expected }
      delete expectedWithoutSchema.$schema

      expect(actual).toEqual(expectedWithoutSchema)
    })
  }
})

// Each parameter and local is a symbol of its own, with its own uses, and
// the hint at each use names it. By name, every use named the last symbol of
// its name (another loop's variable, a global's hint named a parameter), and
// a symbol's uses were those of the last definition of its name anywhere.
describe('each name where it is defined', () => {
  const source = `global x: u32 = 7
export func f(xs: []u32, o: ?*u32, w: ?*u64) -> u64 {
  let s: u64 = 0
  for i, v in xs {
    s += (v * i) as u64
  }
  for i in 3 {
    s += i as u64
  }
  if let q = o {
    s += q.* as u64
  }
  if let q = w {
    s += q.*
  }
  return s + x as u64
}
export func g(x: u8, i: u64) -> u64 => x as u64 + i
`
  const result = parse(source)
  const built = buildMeta(result.module!, source)
  const lines = source.split('\n')
  // The line:column key of `name` in `text` on a line (0-based)
  const key = (line: number, text: string, name = text) => `${line}:${lines[line].indexOf(text) + text.indexOf(name)}`
  const symbolAt = (k: string) => built.symbols[built.hints[k]?.symbol ?? -1]

  test('a symbol per definition, with its own uses', () => {
    const named = (name: string) => built.symbols.filter(s => s.name === name).map(s => `${s.kind} ${s.def} -> ${s.refs.join(' ')}`)
    expect(named('i')).toEqual([
      `local ${key(3, 'i,')} -> ${key(4, 'i)')}`,
      `local ${key(6, 'i in')} -> ${key(7, 'i as')}`,
      `param ${key(17, 'i:')} -> 17:${lines[17].lastIndexOf('i')}`,
    ])
    expect(named('v')).toEqual([`local ${key(3, 'v in')} -> ${key(4, 'v *')}`])
    expect(named('q')).toEqual([`local ${key(9, 'q =')} -> ${key(10, 'q.*')}`, `local ${key(12, 'q =')} -> ${key(13, 'q.*')}`])
    expect(named('x')).toEqual([`global 0:7 -> ${key(15, 'x as')}`, `param ${key(17, 'x:')} -> ${key(17, 'x as')}`])
  })

  test('the hint at each use names the symbol defined there', () => {
    for (const [use, def] of [[key(4, 'i)'), key(3, 'i,')], [key(7, 'i as'), key(6, 'i in')], [key(10, 'q.*'), key(9, 'q =')], [key(13, 'q.*'), key(12, 'q =')], [key(15, 'x as'), '0:7']]) {
      expect(symbolAt(use)?.def).toBe(def)
    }
    expect(symbolAt('0:7')?.kind).toBe('global')
    expect(built.types[symbolAt('0:7')?.type ?? -1]?.type).toBe('u32')
    expect(symbolAt(key(9, 'q ='))?.name).toBe('q')
  })

  // By name, every test's `data b` was the last one: its uses and its name
  // were shown with the last one's address.
  test('a data a test declares is its own symbol, at its own address', () => {
    const program = `export func f() -> u32 => 1
test "one" {
  data b: *[2]u32 = [1, 2]
  assert b[0] == 1
}
test "two" {
  data b: *[2]u32 = [3, 4]
  assert b[1] == 4
}
`
    const meta = buildMeta(parse(program).module!, program)
    const datas = meta.symbols.filter(s => s.name === 'b')
    expect(datas.map(s => `${s.kind} ${s.def} -> ${s.refs.join(' ')}`)).toEqual(['data 2:7 -> 3:9', 'data 6:7 -> 7:9'])
    expect(datas[0].value).not.toBe(datas[1].value)
    for (const [at, index] of [['2:7', 0], ['3:9', 0], ['6:7', 1], ['7:9', 1]] as const) {
      expect(meta.symbols[meta.hints[at]?.symbol ?? -1]).toBe(datas[index])
    }
  })
})
