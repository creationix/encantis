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

  test('a comptime function parameter is defined at its name and found at each use', () => {
    // The name stands after the keyword, whatever lies between: it is where
    // the parser read it, with no source text to search for it.
    const program = `func twice(comptime T: type, comptime /* f, the step */ f: (T) -> T, x: T) -> T => f(f(x))
func thrice(comptime T: type, comptime f: (T) -> T, x: T) -> T => twice(T, f, f(x))
func inc(x: u32) -> u32 => x + 1
export func up(x: u32) -> u32 => thrice(inc, x)
`
    const { source, module, check } = setup(program)
    const declared = program.indexOf('f: (T)')
    const uses = [program.indexOf('=> f(f(x))') + 3, program.indexOf('=> f(f(x))') + 5]
    for (const at of [declared, ...uses]) {
      expect(gotoDefinition(source, module, check, at)).toEqual({ name: 'f', location: { offset: declared, length: 1 } })
      expect(rename(source, module, check, at)).toEqual({
        oldName: 'f',
        locations: [declared, ...uses].map(offset => ({ offset, length: 1 })),
      })
    }
    // Passed on for another's comptime function parameter, it is used there too.
    const second = program.indexOf('f: (T)', program.indexOf('func thrice'))
    expect(rename(source, module, check, second)?.locations.map(l => l.offset)).toEqual([
      second, program.indexOf('twice(T, f') + 9, program.indexOf('f(x))', second),
    ])
    // It is the generic's own name: no hover, and not the function it was given.
    expect(hover(source, module, check, declared)).toBeNull()
    expect(rename(source, module, check, program.indexOf('inc'))?.locations.map(l => l.offset)).toEqual([
      program.indexOf('func inc'), program.indexOf('thrice(inc') + 7,
    ])
  })

  // No applied type has the type parameter: it is found from the generic
  // type as written, applied or not, as a generic function's is.
  const shapes = `global len: u32 = 7
func Box(comptime T: type) -> type => (v: T, len: u32)
func Two(comptime T: type, comptime U: type) -> type => (a: Box(T), b: ?*Two(U, T), f: (T, U) -> T)
func open(comptime T: type, b: Box(T)) -> T => b.v
`
  const applied = 'export func f(b: Box(u8), t: *Two(u8, i64)) -> u32 => open(b) + b.len + len\n'
  for (const [what, program] of [['never applied', shapes], ['applied', shapes + applied]]) {
    test(`a generic type's type parameter is defined in its declaration and found at each use (${what})`, () => {
      const { source, module, check } = setup(program)
      const declared = program.indexOf('T: type')
      const use = program.indexOf('v: T') + 3
      for (const at of [declared, use]) {
        expect(gotoDefinition(source, module, check, at)).toEqual({ name: 'T', location: { offset: declared, length: 1 } })
        expect(findReferences(source, module, check, at)).toEqual({
          definition: { offset: declared, length: 1 },
          references: [{ offset: use, length: 1 }],
        })
        expect(rename(source, module, check, at)).toEqual({
          oldName: 'T',
          locations: [declared, use].map(offset => ({ offset, length: 1 })),
        })
      }
      // Each of two type parameters has its own uses: as a type argument of
      // another generic type and of its own, and in a function type.
      const two = program.indexOf('func Two')
      const t = program.indexOf('T: type', two)
      expect(rename(source, module, check, program.indexOf('Box(T)', two) + 4)?.locations.map(l => l.offset)).toEqual([
        t, program.indexOf('Box(T)', two) + 4, program.indexOf('Two(U, T)') + 7, program.indexOf('(T, U)') + 1, program.indexOf('-> T', two) + 3,
      ])
      const u = program.indexOf('U: type')
      expect(rename(source, module, check, u)?.locations.map(l => l.offset)).toEqual([
        u, program.indexOf('Two(U, T)') + 4, program.indexOf('(T, U)') + 4,
      ])
      // The T of the generic function after them is that function's.
      const ofOpen = program.indexOf('T: type', program.indexOf('func open'))
      expect(gotoDefinition(source, module, check, program.indexOf('-> T => b.v') + 3)?.location.offset).toBe(ofOpen)
      expect(rename(source, module, check, ofOpen)?.locations.length).toBe(3)
    })
  }

  test('a generic type\'s own names are not the module\'s names spelled the same', () => {
    // By name, the field len was shown as the global len and the field b as
    // the parameter b of f, and a rename from either edited that one. A
    // generic's own names have no hover and are never looked up by name.
    const program = shapes + applied
    const { source, module, check } = setup(program)
    for (const field of [program.indexOf('len: u32)'), program.indexOf('b: ?*Two')]) {
      expect(hover(source, module, check, field)).toBeNull()
      expect(gotoDefinition(source, module, check, field)).toBeNull()
      expect(findReferences(source, module, check, field)).toBeNull()
      expect(rename(source, module, check, field)).toBeNull()
    }
    expect(hover(source, module, check, program.indexOf('T: type'))).toBeNull()
    expect(hover(source, module, check, program.indexOf('v: T') + 3)).toBeNull()
    // The global is still itself, and so are the generic types: where one is
    // declared and where another names it.
    expect(hover(source, module, check, program.indexOf('len: u32 = 7'))).toEqual({ name: 'len', type: 'u32', kind: 'global' })
    expect(rename(source, module, check, program.indexOf('+ len') + 2)?.locations.map(l => l.offset)).toEqual([
      program.indexOf('len: u32 = 7'), program.indexOf('+ len') + 2,
    ])
    expect(hover(source, module, check, program.indexOf('Box(comptime'))?.kind).toBe('typefunc')
    expect(hover(source, module, check, program.indexOf('a: Box(T)') + 3)?.kind).toBe('typefunc')
  })

  test('a type parameter of a generic type is not a type of the module with its name', () => {
    // The checker reports the clash; the editor still must not answer for the wrong T.
    const clash = 'type T = u64\nfunc Box(comptime T: type) -> type => (v: T)\n'
    const { source, module, check } = setup(clash)
    const declared = clash.indexOf('T: type')
    const use = clash.indexOf('v: T') + 3
    expect(hover(source, module, check, declared)).toBeNull()
    expect(hover(source, module, check, use)).toBeNull()
    expect(gotoDefinition(source, module, check, use)?.location.offset).toBe(declared)
    expect(rename(source, module, check, use)?.locations.map(l => l.offset)).toEqual([declared, use])
    expect(hover(source, module, check, clash.indexOf('T = u64'))).toEqual({ name: 'T', type: 'u64', kind: 'type' })
    expect(rename(source, module, check, clash.indexOf('T = u64'))?.locations.map(l => l.offset)).toEqual([clash.indexOf('T = u64')])
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

  for (const [what, program] of [['never instantiated', `global x: u32 = 0\n${id}`], ['instantiated', `global x: u32 = 0\n${id}${user}`]]) {
    test(`hover on a generic's own name is not that of a module name spelled the same (${what})`, () => {
      // By name, the parameter x was shown as the global x. What a generic's
      // own name is depends on the instance: it is shown as the first one has
      // it, and not at all while there is none.
      const { source, module, check } = setup(program)
      const own = what === 'instantiated' ? { name: 'x', type: 'f64', kind: 'local' } : null
      expect(hover(source, module, check, program.indexOf('x: T'))).toEqual(own)
      expect(hover(source, module, check, program.indexOf('=> x\n') + 3)).toEqual(own)
      expect(hover(source, module, check, program.indexOf('T: type'))).toBeNull()
      expect(hover(source, module, check, program.indexOf('-> T') + 3)).toBeNull()
      // The global is still itself, and the generic its own name.
      expect(hover(source, module, check, program.indexOf('x: u32'))).toEqual({ name: 'x', type: 'u32', kind: 'global' })
      expect(hover(source, module, check, program.indexOf('id('))?.kind).toBe('generic')
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

  // No instance has the type parameter: it is found from the generic as
  // written, used or not.
  const typed = `type Pt = (q: i32, r: i32)
func keep(comptime T: type, x: T) -> T {
  let y: T = x
  return y
}
func both(comptime A: type, comptime B: type, a: A, b: B) -> (A, B) => (keep(A, a), B(b))
`
  const calls = 'export func f(n: u8) -> u8 => keep(n) + both(n, 2:u64).0\n'
  for (const [what, program] of [['never instantiated', typed], ['instantiated', typed + calls]]) {
    test(`a type parameter is defined in its generic and found at each use (${what})`, () => {
      const { source, module, check } = setup(program)
      const declared = program.indexOf('T: type')
      const uses = [program.indexOf('x: T') + 3, program.indexOf('-> T') + 3, program.indexOf('y: T') + 3]
      for (const at of [declared, ...uses]) {
        expect(gotoDefinition(source, module, check, at)).toEqual({ name: 'T', location: { offset: declared, length: 1 } })
        expect(findReferences(source, module, check, at)).toEqual({
          definition: { offset: declared, length: 1 },
          references: uses.map(offset => ({ offset, length: 1 })),
        })
        expect(rename(source, module, check, at)).toEqual({
          oldName: 'T',
          locations: [declared, ...uses].map(offset => ({ offset, length: 1 })),
        })
      }
      // Each of two type parameters has its own uses: as a type, as a type
      // argument and as a constructor.
      const a = program.indexOf('A: type')
      expect(rename(source, module, check, program.indexOf('keep(A') + 5)?.locations.map(l => l.offset)).toEqual([
        a, program.indexOf('a: A') + 3, program.indexOf('(A, B)') + 1, program.indexOf('keep(A') + 5,
      ])
      const b = program.indexOf('B: type')
      expect(rename(source, module, check, b)?.locations.map(l => l.offset)).toEqual([
        b, program.indexOf('b: B') + 3, program.indexOf('(A, B)') + 4, program.indexOf('B(b)'),
      ])
    })
  }

  test('a type parameter with the name of another generic\'s is that generic\'s own', () => {
    const two = 'func one(comptime T: type, x: T) -> T => x\nfunc two(comptime T: type, x: T, y: T) -> T => y\n'
    const { source, module, check } = setup(two)
    const second = two.indexOf('T: type', two.indexOf('func two'))
    expect(rename(source, module, check, two.indexOf('y: T') + 3)?.locations.map(l => l.offset)).toEqual([
      second, two.indexOf('x: T', second) + 3, two.indexOf('y: T') + 3, two.indexOf('-> T', second) + 3,
    ])
    expect(rename(source, module, check, two.indexOf('T: type'))?.locations.length).toBe(3)
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

  test('a function that shares its name is itself at its own declaration', () => {
    // By name alone each of them was the first one declared.
    const { source, module, check } = setup(code)
    const second = code.indexOf('hash(k: []u8)')
    expect(hover(source, module, check, second)).toEqual({ name: 'hash', type: 'func(k: []u8) -> u32', kind: 'func' })
    expect(hover(source, module, check, code.indexOf('hash(k: u32)'))).toEqual({ name: 'hash', type: 'func(k: u32) -> u32', kind: 'func' })
    expect(gotoDefinition(source, module, check, second)?.location.offset).toBe(code.indexOf('func hash(k: []u8)'))
    expect(findReferences(source, module, check, second)?.references.map(r => r.offset).sort((a, b) => a - b)).toEqual([
      code.indexOf('hash() %'),
      code.indexOf('hash(xs)'),
    ])
  })

  test('in a generic\'s body a call is shown and found as the first instance means it', () => {
    // The only instance of slot has K = []u8. The body's own call is recorded
    // as a use of both functions, and by that alone it was the last of them
    // for one question and the first for another.
    const { source, module, check } = setup(code)
    const call = code.indexOf('hash() %')
    expect(hover(source, module, check, call)).toEqual({ name: 'hash', type: 'func(k: []u8) -> u32', kind: 'func' })
    expect(signatureHelp(source, module, check, call)?.params).toEqual([{ name: 'k', type: '[]u8' }])
    expect(gotoDefinition(source, module, check, call)?.location.offset).toBe(code.indexOf('func hash(k: []u8)'))
    // With the other type first, the same body's call is the other function.
    const other = code.replace('xs.slot(4)', '(7:u32).slot(4) + xs.slot(4)')
    const first = setup(other)
    expect(hover(first.source, first.module, first.check, other.indexOf('hash() %'))?.type).toBe('func(k: u32) -> u32')
    expect(gotoDefinition(first.source, first.module, first.check, other.indexOf('hash() %'))?.location.offset).toBe(0)
    // A plain call in the body, and a generic nothing has called.
    const plain = code.replace('k.hash() % n', 'hash(k) % n')
    const p = setup(plain)
    expect(hover(p.source, p.module, p.check, plain.indexOf('hash(k) %'))?.type).toBe('func(k: []u8) -> u32')
    expect(gotoDefinition(p.source, p.module, p.check, plain.indexOf('hash(k) %'))?.location.offset).toBe(plain.indexOf('func hash(k: []u8)'))
  })

  test('a name that functions share is renamed for all of them', () => {
    // A call spells the name, not which function: renaming one function
    // and its calls would leave the generic's body calling a name that the
    // other instances no longer find.
    const { source, module, check } = setup(code)
    const all = [
      code.indexOf('func hash(k: u32)'),
      code.indexOf('func hash(k: []u8)'),
      code.indexOf('hash() %'),
      code.indexOf('hash(7'),
      code.indexOf('hash(xs)'),
    ]
    for (const at of [code.indexOf('hash(k: u32)'), code.indexOf('hash(k: []u8)'), code.indexOf('hash() %'), code.indexOf('hash(7'), code.indexOf('hash(xs)')]) {
      expect(rename(source, module, check, at)?.locations.map(l => l.offset)).toEqual(all)
    }
    // A name one function has is renamed as before.
    expect(rename(source, module, check, code.indexOf('double()'))?.locations.map(l => l.offset)).toEqual([code.indexOf('func double'), code.indexOf('double()')])
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

// Names a function declares for itself were recorded by name, one place per
// name for the whole module: from where one is defined the editor found the
// last of its name (another loop's, another function's parameter), a
// parameter took over the global it is spelled like, the binding of an if
// let was defined at the value it is taken from, and the index and value of
// a for were one name. The fields of a type, after a point and in a named
// argument were looked up by name too.
describe('each name where it is defined', () => {
  const code = `global x: u32 = 7
type Pt = (x: i32, y: i32)
func scale(y: u32) -> u32 => y * x
export func f(p: Pt, xs: []u32, o: ?*u32, w: ?*u64) -> u64 {
  let s: u64 = (p.x + Pt(x: 1, y: 2).y) as u64
  for i, /* each */ v in xs {
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
  let (x: a, y:) = p
  return s + (a + y) as u64 + scale(2) as u64
}
export func g(x: u8, i: u64) -> u64 => x as u64 + i
`
  const { source, module, check } = setup(code)
  // The offset of `text`, or of `name` in it, from the n-th line on
  const at = (line: number, text: string, name = text) => {
    const from = code.split('\n').slice(0, line - 1).join('\n').length
    const found = code.indexOf(text, from)
    expect(found).toBeGreaterThanOrEqual(0)
    return found + text.indexOf(name)
  }
  const offsets = (r: { locations: { offset: number }[] } | null) => r?.locations.map(l => l.offset)
  // A local or parameter: found from its definition and from each use
  const local = (name: string, def: number, uses: number[], type: string) => {
    for (const offset of [def, ...uses]) {
      expect(gotoDefinition(source, module, check, offset)).toEqual({ name, location: { offset: def, length: name.length } })
      expect(findReferences(source, module, check, offset)?.references.map(r => r.offset)).toEqual(uses)
      expect(offsets(rename(source, module, check, offset))).toEqual([def, ...uses])
      expect(hover(source, module, check, offset)).toEqual({ name, type, kind: 'local' })
    }
  }

  test('a local is itself, and not the last of its name in the module', () => {
    local('i', at(6, 'for i', 'i'), [at(7, 'i)')], 'u32')
    local('i', at(9, 'for i', 'i'), [at(10, 'i as')], 'u32#3')
    local('i', at(21, 'i: u64'), [at(21, '+ i', 'i')], 'u64')
    local('s', at(5, 's: u64'), [7, 10, 13, 16, 19].map(line => at(line, 's ')), 'u64')
  })

  test('the binding of an if let is defined at its name, not at the value', () => {
    local('q', at(12, 'q = o'), [at(13, 'q.*')], '*u32')
    local('q', at(15, 'q = w'), [at(16, 'q.*')], '*u64')
    local('o', at(4, 'o: ?'), [at(12, 'o {')], '?*u32')
  })

  test('the index and the value of a for are two names', () => {
    local('i', at(6, 'for i', 'i'), [at(7, 'i)')], 'u32')
    local('v', at(6, 'v in'), [at(7, 'v *')], 'u32')
  })

  test('the variables of a pattern with named parts are each its own', () => {
    local('a', at(18, 'a, y:'), [at(19, 'a +')], 'i32')
    local('y', at(18, 'y:)'), [at(19, 'y)')], 'i32')
  })

  test('a parameter named like a global is the parameter, and the global stays the global', () => {
    local('x', at(21, 'x: u8'), [at(21, 'x as')], 'u8')
    const global = at(1, 'x')
    for (const offset of [global, at(3, 'x\n')]) {
      expect(hover(source, module, check, offset)).toEqual({ name: 'x', type: 'u32', kind: 'global' })
      expect(gotoDefinition(source, module, check, offset)?.location.offset).toBe(global)
      expect(offsets(rename(source, module, check, offset))).toEqual([global, at(3, 'x\n')])
    }
    local('y', at(3, 'y: u32'), [at(3, 'y *')], 'u32')
  })

  // A set wrote to the variable with no record of it: with the module's
  // names looked up by name, its targets were the last variable of their
  // name anywhere, and a rename from the variable left them as they were.
  test('the variables a set assigns are uses of them', () => {
    const program = `func pair(n: u32) -> (u32, u32) => (n, n + 1)
export func f(n: u32) -> u32 {
  let a: u32 = 0
  let b: u32 = 0
  set a, b = pair(n)
  set (x: a, y: b) = (x: b, y: a)
  return a + b
}
export func g(a: u32) -> u32 => a
`
    const { source, module, check } = setup(program)
    const a = program.indexOf('a: u32 = 0')
    const uses = [program.indexOf('a, b ='), program.indexOf('a, y: b)'), program.indexOf('a)\n'), program.indexOf('a + b')]
    for (const offset of [a, ...uses]) {
      expect(gotoDefinition(source, module, check, offset)?.location.offset).toBe(a)
      expect(rename(source, module, check, offset)?.locations.map(l => l.offset)).toEqual([a, ...uses])
      expect(hover(source, module, check, offset)).toEqual({ name: 'a', type: 'u32', kind: 'local' })
    }
  })

  // A result named like a parameter is that parameter: one local, which holds
  // the argument and then the result. With each recorded apart, a rename from
  // the parameter left the result and every use as they were, and one from
  // the result left the parameter: either way the argument was lost.
  test('a parameter that is also a result is one name with it', () => {
    const program = `func step(acc: u64, v: u64) -> (acc: u64) {
  acc += v
  acc *= 3
}
export func f(acc: u64) -> u64 => step(acc, 1)
`
    const { source, module, check } = setup(program)
    const param = program.indexOf('acc: u64, v')
    const result = program.indexOf('acc: u64)')
    const uses = [program.indexOf('acc +='), program.indexOf('acc *=')]
    for (const offset of [param, result, ...uses]) {
      expect(gotoDefinition(source, module, check, offset)?.location.offset).toBe(result)
      expect(findReferences(source, module, check, offset)?.references.map(r => r.offset)).toEqual([param, ...uses])
      expect(rename(source, module, check, offset)?.locations.map(l => l.offset)).toEqual([result, param, ...uses])
      expect(hover(source, module, check, offset)).toEqual({ name: 'acc', type: 'u64', kind: 'local' })
    }
    // The other function's parameter of that name is its own
    const other = program.indexOf('acc: u64) -> u64')
    expect(rename(source, module, check, other)?.locations.map(l => l.offset)).toEqual([other, program.indexOf('acc, 1')])
  })

  // Each test may declare a data or a def of a name another test declares
  // (examples/crypto/ed25519/point.ents: eleven tests, each with its `data b`).
  // From its name, by name, each one was the last of them in the module.
  test('a data a test declares is its own, also from its name', () => {
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
    const { source, module, check } = setup(program)
    const first = program.indexOf('data b')
    const second = program.lastIndexOf('data b')
    for (const [decl, use] of [[first, program.indexOf('b[0]')], [second, program.indexOf('b[1]')]]) {
      for (const offset of [decl + 'data '.length, use]) {
        expect(gotoDefinition(source, module, check, offset)?.location.offset).toBe(decl)
        expect(rename(source, module, check, offset)?.locations.map(l => l.offset)).toEqual([decl, use])
      }
    }
  })

  test('a field is not a name of the module or a parameter spelled the same', () => {
    // In the type, in a named argument, in a pattern: no answer
    for (const field of [at(2, 'x: i32'), at(2, 'y: i32'), at(5, 'x: 1'), at(5, 'y: 2'), at(18, 'x: a')]) {
      expect(hover(source, module, check, field)).toBeNull()
      expect(gotoDefinition(source, module, check, field)).toBeNull()
      expect(findReferences(source, module, check, field)).toBeNull()
      expect(rename(source, module, check, field)).toBeNull()
    }
    // After a point: the member's type, and nothing to go to
    expect(hover(source, module, check, at(5, 'p.x', 'x'))).toEqual({ name: 'x', type: 'i32', kind: 'field' })
    expect(hover(source, module, check, at(5, ').y', 'y'))).toEqual({ name: 'y', type: 'i32', kind: 'field' })
    expect(gotoDefinition(source, module, check, at(5, 'p.x', 'x'))).toBeNull()
    expect(rename(source, module, check, at(5, ').y', 'y'))).toBeNull()
  })
})

describe('a value too large to hold', () => {
  test('is one error, and the editor shows its name without laying it out', () => {
    // s would be 2^30 registers: its hover counted them to say how many slots it takes.
    const code = 'func f(s: (a: (b: [1073741824]u8), c: u8)) -> u8 => s.c\n'
    const result = parse(code)
    const check = typecheck(result.module!)
    expect(check.errors.map((e) => e.message)).toEqual([
      "type '(a: (b: [1073741824]u8), c: u8)' is too large: written out in full it has more than 65536 parts",
    ])
    expect(hover(code, result.module!, check, code.indexOf('s:'))?.name).toBe('s')
    expect(hover(code, result.module!, check, code.indexOf('s.c'))?.name).toBe('s')
  })
})
