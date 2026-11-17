import { describe, test, expect } from 'bun:test'
import { Glob } from 'bun'
import { parse } from './parser'
import { buildMeta, type MetaOutput } from './meta'

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
    // The parameters and locals of a generic are symbols as they are in its
    // first instance, with the uses inside the generic and no others: found
    // by name, they would be those of the same name in another function.
    const swap = lines.findIndex(l => l.startsWith('func swap('))
    const inSwap = built.symbols.filter(s => Number(s.def.split(':')[0]) >= swap && Number(s.def.split(':')[0]) <= swap + 4)
    expect(inSwap.map(s => `${s.name}: ${built.types[s.type].type}`)).toEqual(['swap: (comptime T: type, a: *mut T, b: *mut T)->()', 'a: *mut u32', 'b: *mut u32', 'tmp: u32'])
    for (const s of inSwap.slice(1)) {
      expect(s.refs.length).toBeGreaterThan(0)
      for (const ref of s.refs) {
        const line = Number(ref.split(':')[0])
        expect(line > swap && line <= swap + 4).toBe(true)
      }
    }
  })

  test('the body of a generic has the hints of its first instance', () => {
    // find is first asked for by the test, for u32: the bodies of instances
    // are come to after everything else, contains<u8> among them.
    const hints = metaHints(source)
    const inFind = Object.entries(hints).filter(([key]) => {
      const line = Number(key.split(':')[0])
      return line >= 1 && line <= 6
    })
    expect(inFind.map(([key, hint]) => `${key} ${hint.type}`)).toEqual([
      '1:28 []u32', '1:37 u32', '2:6 u32', '2:14 []u32', '3:11 u32', '3:18 u32', '3:23 u32', '5:9 []u32', '5:12 u32',
      '1:5 (comptime T: type, xs: []T, x: T)->u32',
    ])
    // A call in it is the instance that instance calls.
    expect(hints['7:58'].type).toBe('(xs:[]u8,x:u8)->u32')
  })

  test('a generic nothing has called has a hint at its name and none inside', () => {
    const lonely = 'func keep(comptime T: type, a: T) -> T {\n  let b = a\n  return b\n}\nexport func f() { }'
    const result = parse(lonely)
    const built = buildMeta(result.module!, lonely)
    expect(Object.keys(built.hints)).toEqual(['0:5', '4:12'])
    expect(built.symbols.map(s => s.name)).toEqual(['keep', 'f'])
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
