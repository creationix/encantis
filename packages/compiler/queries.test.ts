import { describe, test, expect } from 'bun:test'
import { parse } from './parser'
import { typecheck } from './checker'
import {
  gotoDefinition,
  hover,
  findReferences,
  documentSymbols,
  signatureHelp,
  workspaceSymbols,
  rename,
} from './queries'
import { resolve } from 'path'

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

  test('shows param type inside function', () => {
    const code = `func test(input: []u8, count: u32) -> u64 { return 0 }`
    const { source, module, check } = setup(code)

    const dataOffset = code.indexOf('input')
    const result = hover(source, module, check, dataOffset)
    expect(result).not.toBeNull()
    expect(result!.name).toBe('input')
    expect(result!.type).toContain('[]u8')
  })

  test('shows local type inside function', () => {
    const code = `func test() { let sum: u64 = 0 }`
    const { source, module, check } = setup(code)

    const offset = code.indexOf('sum')
    const result = hover(source, module, check, offset)
    expect(result).not.toBeNull()
    expect(result!.name).toBe('sum')
    expect(result!.type).toBe('u64')
  })

  test('shows type for reference to local', () => {
    const code = `func test() -> u64 { let x: u64 = 42\n return x }`
    const { source, module, check } = setup(code)

    const useOffset = code.lastIndexOf('x')
    const result = hover(source, module, check, useOffset)
    expect(result).not.toBeNull()
    expect(result!.type).toBe('u64')
  })
})

describe('generic types and comptime function parameters', () => {
  const code = `func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
func last(comptime T: type, v: *Vec(T)) -> T => v.ptr[v.len - 1]
func sort(comptime T: type, xs: []mut T, comptime before: (T, T) -> bool) {
  if before(xs.ptr[1], xs.ptr[0]) { xs.ptr[0] = xs.ptr[1] }
}
func ascending(a: i32, b: i32) -> bool => a < b
export func f(v: *Vec(u32), xs: []mut i32) -> u32 {
  sort(xs, ascending)
  return last(v)
}`
  const declared = 'generic type(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)'

  test('hover on a generic type shows its declaration, where it is declared and where it is applied', () => {
    const { source, module, check } = setup(code)
    expect(hover(source, module, check, code.indexOf('Vec'))).toEqual({ name: 'Vec', type: declared, kind: 'typefunc' })
    expect(hover(source, module, check, code.indexOf('Vec(T)'))).toEqual({ name: 'Vec', type: declared, kind: 'typefunc' })
    expect(hover(source, module, check, code.indexOf('Vec(u32)') + 1)).toEqual({ name: 'Vec', type: declared, kind: 'typefunc' })
  })

  test('a generic type is listed as a type, and is found from where it is applied', () => {
    const { source, module, check } = setup(code)
    expect(documentSymbols(source, module, check).map(s => [s.name, s.kind, s.type])).toEqual([
      ['Vec', 'type', declared],
      ['last', 'func', 'generic func(comptime T: type, v: *Vec(T)) -> T'],
      ['sort', 'func', 'generic func(comptime T: type, xs: []mut T, comptime before: (T, T) -> bool)'],
      ['ascending', 'func', 'func(a: i32, b: i32) -> bool'],
      ['f', 'func', 'func(v: *(ptr: [*]mut u32, len: u32, cap: u32), xs: []mut i32) -> u32'],
    ])
    expect(gotoDefinition(source, module, check, code.indexOf('Vec(u32)'))?.location.offset).toBe(0)
    const references = findReferences(source, module, check, code.indexOf('Vec'))
    expect(references?.references.map(r => r.offset).sort((a, b) => a - b)).toEqual([code.indexOf('Vec(T)'), code.indexOf('Vec(u32)')])
  })

  test('a call that gives a function for a comptime parameter shows the instance it uses', () => {
    const { source, module, check } = setup(code)
    expect(hover(source, module, check, code.indexOf('sort(xs, ascending)'))).toEqual({ name: 'sort', type: 'func(xs: []mut i32)', kind: 'generic' })
    // The function given is a use of that function.
    expect(hover(source, module, check, code.indexOf('ascending)'))).toEqual({ name: 'ascending', type: 'func(a: i32, b: i32) -> bool', kind: 'func' })
    expect(findReferences(source, module, check, code.indexOf('ascending'))?.references.map(r => r.offset)).toEqual([code.indexOf('ascending)')])
  })
})

describe('generic functions', () => {
  const code = `func find(comptime T: type, xs: []T, x: T) -> u32 {
  for i, v in xs {
    return i when v == x
  }
  return xs.len
}
func contains(comptime T: type, xs: []T, x: T) -> bool => find(xs, x) < xs.len
export func has_byte(xs: []u8, x: u8) -> bool => contains(xs, x)
export func index_of(xs: []u32, x: u32) -> u32 => find(u32, xs, x)`

  test('hover on the name of a generic shows the signature it was written with', () => {
    const { source, module, check } = setup(code)
    const result = hover(source, module, check, code.indexOf('find'))
    expect(result).toEqual({ name: 'find', type: 'generic func(comptime T: type, xs: []T, x: T) -> u32', kind: 'generic' })
  })

  test('hover on a call shows the signature of the instance that call uses', () => {
    const { source, module, check } = setup(code)
    const inferred = hover(source, module, check, code.indexOf('contains(xs, x)'))
    expect(inferred).toEqual({ name: 'contains', type: 'func(xs: []u8, x: u8) -> bool', kind: 'generic' })
    // Anywhere on the name, also when the type argument is written.
    const explicit = hover(source, module, check, code.indexOf('find(u32') + 2)
    expect(explicit).toEqual({ name: 'find', type: 'func(xs: []u32, x: u32) -> u32', kind: 'generic' })
  })

  test('a generic is listed once, and its instances are not', () => {
    const { source, module, check } = setup(code)
    const symbols = documentSymbols(source, module, check)
    expect(symbols.map(s => [s.name, s.type])).toEqual([
      ['find', 'generic func(comptime T: type, xs: []T, x: T) -> u32'],
      ['contains', 'generic func(comptime T: type, xs: []T, x: T) -> bool'],
      ['has_byte', 'func(xs: []u8, x: u8) -> bool'],
      ['index_of', 'func(xs: []u32, x: u32) -> u32'],
    ])
  })

  test('references to a generic include the calls in generic bodies, at their place in the source', () => {
    const { source, module, check } = setup(code)
    const result = findReferences(source, module, check, code.indexOf('find'))
    expect(result!.references.map(r => r.offset).sort((a, b) => a - b)).toEqual([
      code.indexOf('find(xs, x) <'),
      code.indexOf('find(u32'),
    ])
  })

  test('the signature offered at a call is that of the instance the call uses', () => {
    const { source, module, check } = setup(code)
    expect(signatureHelp(source, module, check, code.indexOf('find(u32') + 1)).toEqual({
      name: 'find',
      params: [{ name: 'xs', type: '[]u32' }, { name: 'x', type: 'u32' }],
      returnType: 'u32',
    })
    // At its declaration a generic has no one signature to offer.
    expect(signatureHelp(source, module, check, code.indexOf('find'))).toBeNull()
  })

  // Two functions with a parameter of one name, the generic one second and
  // first: by name alone, a use in the generic's body would be the other
  // function's parameter, and a rename from it would edit that function.
  const helper = 'func helper(x: []u8) -> u32 => x.len\n'
  const id = 'func id(comptime T: type, x: T) -> T => x\n'
  const user = 'export func f(a: f64, s: []u8) -> f64 => id(a) + (helper(s) as f64)\n'
  for (const shared of [helper + id + user, id + helper + user]) {
    test(`a name in a generic's body is the generic's own (${shared.startsWith(id) ? 'generic first' : 'generic last'})`, () => {
      const { source, module, check } = setup(shared)
      const param = shared.indexOf('x: T')
      const use = shared.indexOf('=> x\n') + 3
      for (const at of [param, use]) {
        expect(gotoDefinition(source, module, check, at)?.location.offset).toBe(param)
        expect(findReferences(source, module, check, at)).toEqual({
          definition: { offset: param, length: 1 },
          references: [{ offset: use, length: 1 }],
        })
        expect(rename(source, module, check, at)?.locations.map(l => l.offset)).toEqual([param, use])
      }
      // The other function's parameter is still its own.
      const other = shared.indexOf('x: []u8')
      expect(rename(source, module, check, shared.indexOf('x.len'))?.locations.map(l => l.offset)).toEqual([other, shared.indexOf('x.len')])
    })
  }

  test('with no instance to go by, a name in a generic\'s body is not guessed', () => {
    const { source, module, check } = setup(helper + id)
    for (const at of [(helper + id).indexOf('x: T'), (helper + id).indexOf('=> x\n') + 3]) {
      expect(gotoDefinition(source, module, check, at)).toBeNull()
      expect(findReferences(source, module, check, at)).toBeNull()
      expect(rename(source, module, check, at)).toBeNull()
    }
    // What the body names in the module is still found.
    const calls = 'func twice(a: u32) -> u32 => a * 2\nfunc g(comptime T: type, n: u32) -> u32 => twice(n)\n'
    const unused = setup(calls)
    expect(gotoDefinition(unused.source, unused.module, unused.check, calls.indexOf('twice(n)'))?.location.offset).toBe(0)
  })

  test('examples/generics/minmax.ents: renaming a parameter of swap stays inside swap', async () => {
    const example = await Bun.file(new URL('../../examples/generics/minmax.ents', import.meta.url)).text()
    const { source, module, check } = setup(example)
    const swap = example.indexOf('func swap(')
    const end = example.indexOf('}', swap)
    const result = rename(source, module, check, example.indexOf('a.*', swap))
    expect(result?.locations.length).toBe(3)
    for (const location of result?.locations ?? []) {
      expect(location.offset).toBeGreaterThan(swap)
      expect(location.offset).toBeLessThan(end)
    }
  })
})

describe('inside a generic function', () => {
  const code = `func find(comptime T: type, xs: []T, x: T) -> u32 {
  for i, v in xs {
    let same = v == x
    return i when same
  }
  return xs.len
}
func never(comptime T: type, a: T) -> T => a
export func index_of(xs: []u64, x: u64) -> u32 => find(xs, x)
export func has_byte(xs: []u8, x: u8) -> bool => find(xs, x) < xs.len`

  test('hover shows a parameter, a local and their uses as they are in the first instance', () => {
    const { source, module, check } = setup(code)
    const at = (text: string, from = 0) => hover(source, module, check, code.indexOf(text, from))
    expect(at('xs: []T')).toEqual({ name: 'xs', type: '[]u64', kind: 'local' })
    expect(at('x: T')).toEqual({ name: 'x', type: 'u64', kind: 'local' })
    expect(at('same =')).toEqual({ name: 'same', type: 'bool', kind: 'local' })
    expect(at('x\n', code.indexOf('v == x'))).toEqual({ name: 'x', type: 'u64', kind: 'local' })
    expect(at('xs.len')).toEqual({ name: 'xs', type: '[]u64', kind: 'local' })
  })

  test('a generic nothing has called shows nothing inside: there is no instance to go by', () => {
    const { source, module, check } = setup(code)
    expect(hover(source, module, check, code.indexOf('a: T'))).toBeNull()
    expect(hover(source, module, check, code.indexOf('=> a') + 3)).toBeNull()
  })

  test('outside a generic nothing is looked up in an instance', () => {
    const { source, module, check } = setup(code)
    expect(hover(source, module, check, code.indexOf('xs: []u8'))).toEqual({ name: 'xs', type: '[]u8', kind: 'local' })
  })
})

describe('method calls and functions that share a name', () => {
  const code = `func hash(k: u32) -> u32 => k
func hash(k: []u8) -> u32 => k.len
func slot(comptime K: type, k: K, n: u32) -> u32 => k.hash() % n
func double(n: u32) -> u32 => n * 2
export func f(xs: []u8) -> u32 => xs.slot(4).double() + hash(7:u32) + hash(xs)`

  test('hover on a call shows the function it means', () => {
    const { source, module, check } = setup(code)
    expect(hover(source, module, check, code.indexOf('hash(7'))).toEqual({ name: 'hash', type: 'func(k: u32) -> u32', kind: 'func' })
    expect(hover(source, module, check, code.indexOf('hash(xs)'))).toEqual({ name: 'hash', type: 'func(k: []u8) -> u32', kind: 'func' })
  })

  test('hover on the name of a method shows the function called', () => {
    const { source, module, check } = setup(code)
    expect(hover(source, module, check, code.indexOf('slot(4)'))).toEqual({ name: 'slot', type: 'func(k: []u8, n: u32) -> u32', kind: 'generic' })
    expect(hover(source, module, check, code.indexOf('double()') + 3)).toEqual({ name: 'double', type: 'func(n: u32) -> u32', kind: 'func' })
  })

  test('a call goes to the declaration of the function it means, and a method to its function', () => {
    const { source, module, check } = setup(code)
    const def = (text: string) => gotoDefinition(source, module, check, code.indexOf(text))?.location.offset
    expect(def('hash(7')).toBe(0)
    expect(def('hash(xs)')).toBe(code.indexOf('func hash(k: []u8)'))
    expect(def('slot(4)')).toBe(code.indexOf('func slot'))
    expect(def('double()')).toBe(code.indexOf('func double'))
  })

  test('the uses of each function of a shared name are its own', () => {
    const { source, module, check } = setup(code)
    const refs = (at: number) => findReferences(source, module, check, at)?.references.map(r => r.offset).sort((a, b) => a - b)
    // In a generic's body a call may mean either: it is a use of both.
    expect(refs(code.indexOf('hash(xs)'))).toEqual([code.indexOf('hash() %'), code.indexOf('hash(xs)')])
    expect(refs(code.indexOf('hash(7'))).toEqual([code.indexOf('hash() %'), code.indexOf('hash(7')])
    expect(refs(code.indexOf('double()'))).toEqual([code.indexOf('double()')])
  })

  test('each is listed with its own signature, under the name it was declared with', () => {
    const { source, module, check } = setup(code)
    expect(documentSymbols(source, module, check).map(s => [s.name, s.type])).toEqual([
      ['hash', 'func(k: u32) -> u32'],
      ['hash', 'func(k: []u8) -> u32'],
      ['slot', 'generic func(comptime K: type, k: K, n: u32) -> u32'],
      ['double', 'func(n: u32) -> u32'],
      ['f', 'func(xs: []u8) -> u32'],
    ])
  })

  test('the signature offered at a call is that of the function it means', () => {
    const { source, module, check } = setup(code)
    expect(signatureHelp(source, module, check, code.indexOf('hash(xs)'))).toEqual({
      name: 'hash',
      params: [{ name: 'k', type: '[]u8' }],
      returnType: 'u32',
    })
    expect(signatureHelp(source, module, check, code.indexOf('slot(4)'))?.params.map(p => p.type)).toEqual(['[]u8', 'u32'])
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

describe('workspaceSymbols', () => {
  test('finds symbols across multiple files', async () => {
    const fixtures = resolve(import.meta.dir, 'tests/fixtures/modular')
    const syms = await workspaceSymbols(fixtures)
    const names = syms.map(s => s.name)
    expect(names).toContain('add')
    expect(names).toContain('double')
    expect(syms.every(s => s.filePath !== undefined)).toBe(true)
  })

  test('filters by query string', async () => {
    const fixtures = resolve(import.meta.dir, 'tests/fixtures/modular')
    const syms = await workspaceSymbols(fixtures, 'add')
    expect(syms.length).toBeGreaterThan(0)
    expect(syms.every(s => s.name.toLowerCase().includes('add'))).toBe(true)
  })

  test('returns empty for no matches', async () => {
    const fixtures = resolve(import.meta.dir, 'tests/fixtures/modular')
    const syms = await workspaceSymbols(fixtures, 'zzz_nonexistent_zzz')
    expect(syms).toEqual([])
  })
})

describe('rename', () => {
  test('finds definition and all references', () => {
    const code = `func add(a: i32, b: i32) -> i32 => a + b\nfunc test() -> i32 => add(1, 2)`
    const { source, module, check } = setup(code)

    const callOffset = code.lastIndexOf('add')
    const result = rename(source, module, check, callOffset)
    expect(result).not.toBeNull()
    expect(result!.oldName).toBe('add')
    // Definition + at least one reference
    expect(result!.locations.length).toBeGreaterThanOrEqual(2)
  })

  test('works from definition site', () => {
    const code = `func add(a: i32, b: i32) -> i32 => a + b\nfunc test() -> i32 => add(1, 2)`
    const { source, module, check } = setup(code)

    const defOffset = code.indexOf('add')
    const result = rename(source, module, check, defOffset)
    expect(result).not.toBeNull()
    expect(result!.locations.length).toBeGreaterThanOrEqual(2)
  })

  test('returns null for non-identifier', () => {
    const code = `func test() -> i32 => 42`
    const { source, module, check } = setup(code)

    const result = rename(source, module, check, code.indexOf('('))
    expect(result).toBeNull()
  })
})
