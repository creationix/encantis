// Generic functions: comptime type parameters. The language rules are the
// "Generics" chapter of docs/encantis.md; the cases users are meant to read are
// in spec/generics.md. These tests pin the rules one by one.

import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from './parser'
import { INSTANCE_STRIDE, typecheck, typecheckProgram, type TypecheckOptions } from './checker'
import { programToWat, programToWatWithTests } from './codegen'
import { loadModule } from './loader'
import { compileToWasm, runTestsOfSource, wasmOfSource, wasmOfWat, watOfSource } from './test-utils'
import { typeToString } from './types'

function check(source: string, options?: TypecheckOptions) {
  const parsed = parse(source)
  expect(parsed.errors.map(e => e.message)).toEqual([])
  if (!parsed.module) throw new Error('no module')
  return typecheck(parsed.module, options)
}

const errorsOf = (source: string) => check(source).errors.map(e => e.message)

// Where an error is and what it says, without the calls it was required from
const place = ({ offset, message }: { offset: number; message: string }) => ({ offset, message })

// What the checker says of an operator that its operands do not have. Its
// wording is written once here, as it is once in the checker (noOperator).
const noOperator = (op: string, left: string, right = left) => `'${op}' cannot be applied to ${left} and ${right}`

// How often the checker reads the name of the identifier `name`, which the
// source uses once: a count of how often it comes to that place.
function readsOf(source: string, name: string): number {
  const parsed = parse(source)
  if (!parsed.module) throw new Error('no module')
  let reads = 0
  let found = 0
  const seen = new Set<unknown>()
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object' || seen.has(node)) return
    seen.add(node)
    const n = node as { kind?: string; name?: string }
    if (n.kind === 'IdentExpr' && n.name === name) {
      found++
      Object.defineProperty(n, 'name', {
        enumerable: true,
        get: () => {
          reads++
          return name
        },
      })
      return
    }
    for (const value of Object.values(node)) visit(value)
  }
  visit(parsed.module)
  expect(found).toBe(1)
  typecheck(parsed.module)
  expect(reads).toBeGreaterThan(0)
  return reads
}

// The names of the instances a module ends up with, sorted. Each must check.
function instancesOf(source: string, options?: TypecheckOptions): string[] {
  const result = check(source, options)
  expect(result.errors.map(e => e.message)).toEqual([])
  return result.instances.map(i => i.decl.ident as string).sort()
}

const MAX = 'func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }\n'
const HEAD = 'func head(comptime T: type, xs: []T) -> T => xs.ptr[0]\n'
const ZERO = 'func zero(comptime T: type) -> T => 0\n'
const COUNT = `func count(comptime T: type, xs: []T, x: T) -> u32 {
  let n: u32 = 0
  for v in xs {
    if v == x { n += 1 }
  }
  return n
}
`

describe('calling a generic function', () => {
  test('with the type written, every parameter gets an argument', () => {
    expect(instancesOf(`${MAX}export func f(a: u32, b: u32) -> u32 => max(u32, a, b)`)).toEqual(['max<u32>'])
  })

  test('with the type left out, the other arguments decide it', () => {
    expect(instancesOf(`${MAX}export func f(a: f64, b: f64) -> f64 => max(a, b)`)).toEqual(['max<f64>'])
  })

  test('a type in parentheses is the type inside, as an argument, after a colon and after an arrow', () => {
    const id = 'func id(comptime T: type, a: T) -> T => a\n'
    // After `->` parentheses list the results: ((u32)) is the one result
    // (u32), which is u32.
    expect(instancesOf(`${id}export func f(a: (u32)) -> ((u32)) => id((u32), a)`)).toEqual(['id<u32>'])
    expect(instancesOf(`${id}export func f(a: u32) -> u32 => id(((u32)), a) + id(a)`)).toEqual(['id<u32>'])
    // Inferred from a parameter written in parentheses, as from one without.
    expect(instancesOf(`func id(comptime T: type, a: (T)) -> T => a\nexport func f(a: u32) -> u32 => id(a)`)).toEqual(['id<u32>'])
    // A name makes it a struct of one field.
    expect(errorsOf(`${id}func f(a: u32) -> u32 => id((v: u32), a)`)).toEqual([
      'argument 2: cannot assign u32 to (v: u32)',
      'cannot assign (v: u32) to u32',
    ])
  })

  test('the result of an instance is one value, also when the type argument is a tuple or a struct', async () => {
    // In a hand-written signature `-> (u32)` and `-> (q: i32, r: i32)` list
    // results. An instance's `-> T` never does: its body returns a T.
    const source = `func id(comptime T: type, a: T) -> T => a
func back(comptime T: type, a: T) -> T { return a }
func none(comptime T: type, a: T) -> T { return }
export func f(a: (u32, u8)) -> ((u32, u8)) => back((u32, u8), id(a))
export func g(q: i32, r: i32) -> i32 {
  let p = back((q: i32, r: i32), id((q: i32, r: i32), (q: q, r: r)))
  return p.q + p.r
}`
    expect(instancesOf(source)).toEqual(['back<<q:i32|r:i32>>', 'back<<u32|u8>>', 'id<<q:i32|r:i32>>', 'id<<u32|u8>>'])
    const instance = await WebAssembly.instantiate(await WebAssembly.compile(await wasmOfSource(source)))
    expect((instance.exports.g as (q: number, r: number) => number)(3, 4)).toBe(7)
    // Not a function with the named results q and r, which a bare return hands back.
    expect(errorsOf(`${source}\nexport func h(q: i32) -> i32 => none((q: i32, r: i32), (q: q, r: 2)).q`)).toEqual([
      'return needs a value: the function returns ((q: i32, r: i32)), in none(T = (q: i32, r: i32))',
    ])
  })

  test('a struct type is written in place as a type argument, whatever its fields are', async () => {
    const PICK = 'type Pt = (q: i32, r: i32)\nfunc pick(comptime T: type, first: bool, a: T, b: T) -> T => if first { a } else { b }\nfunc size(comptime T: type) -> u32 => sizeof(T)\n'
    // Fields whose types are no expressions, and one field: (at: Pt) is the
    // name at given a type, in parentheses, and as a type argument the struct.
    const source = `${PICK}export func f(c: bool, s: []u8, p: Pt) -> i32 => pick((name: []u8, at: Pt), c, (name: s, at: p), (name: s, at: p)).at.q
export func g() -> u32 => size((at: Pt)) + size((p: ?*Pt)) + size((n: u8, at: Pt))
func wrap(comptime T: type, x: T) -> u8 => pick((t: T, n: u8), true, (t: x, n: 1), (t: x, n: 2)).n
export func h(x: u64) -> u8 => wrap(x)`
    expect(instancesOf(source)).toEqual([
      "pick<<name:''u8|at:<q:i32|r:i32>>>",
      'pick<<t:u64|n:u8>>',
      'size<<at:<q:i32|r:i32>>>',
      'size<<n:u8|at:<q:i32|r:i32>>>',
      'size<<p:?*<q:i32|r:i32>>>',
      'wrap<u64>',
    ])
    const instance = await WebAssembly.instantiate(await WebAssembly.compile(await wasmOfSource(source)))
    expect((instance.exports.g as () => number)()).toBe(8 + 4 + 9)
    expect((instance.exports.h as (x: bigint) => number)(5n)).toBe(1)
  })

  test('a type argument is written as after a colon', () => {
    const source = `type Pt = (q: i32, r: i32)
func pick(comptime T: type, first: bool, a: T, b: T) -> T => if first { a } else { b }
${HEAD}
export func a(c: bool, p: Pt, q: Pt) -> Pt => pick(Pt, c, p, q)
export func b(c: bool, p: (i32, f64), q: (i32, f64)) -> (i32, f64) => pick((i32, f64), c, p, q)
export func c(xs: [][]u8) -> []u8 => head([]u8, xs)
export func d(xs: []*mut Pt) -> *mut Pt => head(*mut Pt, xs)
export func e(xs: []?*Pt) -> ?*Pt => head(?*Pt, xs)
export func f(xs: [][*]u8) -> [*]u8 => head([*]u8, xs)
export func g(xs: []u64) -> u64 => head(u64, xs)`
    expect(instancesOf(source)).toEqual([
      "head<''u8>",
      "head<'*'u8>",
      'head<*mut.<q:i32|r:i32>>',
      'head<?*<q:i32|r:i32>>',
      'head<u64>',
      'pick<<i32|f64>>',
      'pick<<q:i32|r:i32>>',
    ])
  })

  test('a name in a type position is the type, whatever variables are in scope', () => {
    const source = `${COUNT}export func f(xs: []u8) -> u32 {
  let u8: u32 = 3
  return count(u8, xs, 7) + u8
}`
    expect(instancesOf(source)).toEqual(['count<u8>'])
  })

  test('the argument count alone says which form a call is', () => {
    expect(errorsOf(`${MAX}func f(a: u8) -> u8 => max(a)`)).toEqual([
      "'max' expects 2 arguments, or 3 with its type argument written; got 1",
    ])
    expect(errorsOf(`${MAX}func f(a: u8) -> u8 => max(u8, a, a, a)`)).toEqual([
      "'max' expects 2 arguments, or 3 with its type argument written; got 4",
    ])
    const pair = 'func pair(comptime A: type, comptime B: type, a: A) -> A => a\n'
    expect(errorsOf(`${pair}func f(a: u8) -> u8 => pair(u8, a)`)).toEqual([
      "'pair' expects 1 argument, or 3 with its type arguments written; got 2",
    ])
  })

  test('arguments are positional', () => {
    expect(errorsOf(`${MAX}func f(a: u8) -> u8 => max(a: a, b: a)`)).toEqual(["'max' takes positional arguments"])
  })

  test('a value where the type is expected is an error', () => {
    expect(errorsOf(`${MAX}func f(a: u8) -> u8 => max(a, a, a)`)).toEqual([
      "argument 1 of 'max' must be a type: T is a type parameter",
    ])
    expect(errorsOf(`${MAX}func f(a: u8) -> u8 => max(8, a, a)`)).toEqual([
      "argument 1 of 'max' must be a type: T is a type parameter",
    ])
  })

  test('an unknown type argument is one error', () => {
    expect(errorsOf(`${MAX}func f(a: f64) -> f64 => max(Nope, a, a)`)).toEqual(["unknown type 'Nope'"])
    // Also when the call is inferred twice, as the argument of an inferred call.
    expect(errorsOf(`${MAX}func f(a: f64) -> f64 => max(max(Nope, a, a), a)`)).toEqual(["unknown type 'Nope'"])
  })

  test('an argument is named by its place in the call as written', () => {
    expect(errorsOf(`${MAX}func f(a: u8, b: u32) -> u8 => max(u8, a, b)`)).toEqual(['argument 3: cannot assign u32 to u8'])
    expect(errorsOf(`${MAX}func f(a: u8, b: u32) -> u8 => max(a, b)`)).toEqual(['argument 2: cannot assign u32 to u8'])
  })

  test('a written type argument makes the other arguments ordinary ones', () => {
    // x is a u8 passed for a u32, as for any u32 parameter; 9 becomes a u32.
    expect(instancesOf(`${MAX}export func f(x: u8) -> u32 => max(u32, x, 9)`)).toEqual(['max<u32>'])
  })
})

describe('inferring type parameters', () => {
  test('the first argument that can decide a type parameter decides it', () => {
    expect(instancesOf(`${MAX}export func f(a: u32, b: u8) -> u32 => max(a, b)`)).toEqual(['max<u32>'])
  })

  test('numbers are not widened to make arguments agree', () => {
    expect(errorsOf(`${MAX}func f(a: u8, b: u32) -> u32 => max(a, b)`)).toEqual(['argument 2: cannot assign u32 to u8'])
  })

  test('T against a pointer, a slice and a tuple gives what is inside', () => {
    const source = `${HEAD}
func get(comptime T: type, p: *mut T) -> T => p.*
func both(comptime A: type, comptime B: type, p: (A, B)) -> A => p.0
export func a(xs: []u64) -> u64 => head(xs)
export func b(p: *mut i64) -> i64 => get(p)
export func c(p: (i32, f64)) -> i32 => both(p)`
    expect(instancesOf(source)).toEqual(['both<i32|f64>', 'get<i64>', 'head<u64>'])
  })

  test('*T takes a *mut X', () => {
    const source = `func get(comptime T: type, p: *T) -> T => p.*
export func f(p: *mut u64) -> u64 => get(p)`
    expect(instancesOf(source)).toEqual(['get<u64>'])
  })

  test('[]T takes a []mut X', () => {
    expect(instancesOf(`${HEAD}export func f(xs: []mut u16) -> u16 => head(xs)`)).toEqual(['head<u16>'])
  })

  test('[]T takes a data array and a string, which are pointers to arrays', () => {
    const source = `${HEAD}data primes = [2:u16, 3, 5, 7]
export func a() -> u16 => head(primes)
export func b() -> u8 => head("abc")`
    expect(instancesOf(source)).toEqual(['head<u16>', 'head<u8>'])
  })

  test('[*]T takes a pointer to an array', () => {
    const source = `func first(comptime T: type, xs: [*]T) -> T => xs[0]
data primes = [2:u16, 3, 5, 7]
export func f() -> u16 => first(primes)`
    expect(instancesOf(source)).toEqual(['first<u16>'])
  })

  test('*T does not take a many-pointer: what that points to is no type by itself', () => {
    const addr = 'func addr(comptime T: type, p: *T) -> u32 => p as u32\n'
    // Bound to the array of unknown length behind [*]u8, T had the key of
    // [*]u8 itself, and whichever call came second was checked against the
    // other's instance.
    const source = `${addr}export func one(mp: [*]u8) -> u32 => addr(mp)
export func two(pp: *[*]u8) -> u32 => addr(pp)`
    expect(errorsOf(source)).toEqual(["cannot infer T for 'addr': write the type argument, as in addr(u32, ...)"])
    expect(instancesOf(`${addr}export func two(pp: *[*]u8) -> u32 => addr(pp)\nexport func three(pp: *[*]u8) -> u32 => addr([*]u8, pp)`)).toEqual([
      "addr<'*'u8>",
    ])
    const first = 'func first(comptime T: type, xs: [*]T) -> T => xs[0]\n'
    expect(instancesOf(`${first}export func f(mp: [*]u8) -> u8 => first(mp)`)).toEqual(['first<u8>'])
  })

  test('?*T takes a *X', () => {
    const source = `func or_zero(comptime T: type, p: ?*T) -> u32 => 0
export func f(p: *i64) -> u32 => or_zero(p)`
    expect(instancesOf(source)).toEqual(['or_zero<i64>'])
  })

  test('a range the argument is only known to lie in is dropped', () => {
    const source = `${MAX}export func f() -> u32 {
  let total: u32 = 0
  for i in 12 {
    total += max(i, 3)
  }
  return total
}`
    expect(instancesOf(source)).toEqual(['max<u32>'])
  })

  test('also from the values a tuple argument is made of', () => {
    const source = `func fst(comptime T: type, p: (T, T)) -> T => p.0
func keep(comptime T: type, p: (T, u8)) -> T => p.0
func id(comptime T: type, x: T) -> T => x
export func f(x: u32) -> u32 {
  let total: u32 = fst((x, x))
  for i in 12 { total += fst((i, i)) + keep((i, 1:u8)) + id((i, i)).0 }
  for j in 100 { total += fst((j, j)) + keep((j, 2:u8)) }
  if x < 10 { total += fst((x, x)) }
  return total
}`
    expect(instancesOf(source)).toEqual(['fst<u32>', 'id<<u32|u32>>', 'keep<u32>'])
    // What an error suggests writing is that type too.
    expect(errorsOf(`func pair(comptime T: type, comptime U: type, p: (T, U)) -> T => p.0
export func f() -> u32 {
  let total: u32 = 0
  for i in 3 { total += pair((i, 1)) }
  return total
}`)).toEqual(["cannot infer U for 'pair' from untyped literals: write pair(u32, i32, ...) or give a literal its type"])
  })

  test('a tuple decides by its typed parts, and its literals by themselves never do', () => {
    const KEEP = 'func keep(comptime T: type, p: (T, T)) -> T => p.0\n'
    // i decides T in either place; the literal takes the type T turns out to be.
    expect(instancesOf(`${KEEP}export func f(i: u16) -> u16 => keep((i, 1)) + keep((2, i))`)).toEqual(['keep<u16>'])
    // Also inside a nested tuple, behind a pointer, and with the loop counter's range dropped.
    expect(instancesOf(`func deep(comptime T: type, p: ((T, u8), T)) -> T => p.1
func at(comptime T: type, p: *(T, T)) -> T => p.0
export func f(i: u64) -> u64 => deep(((1, 2), i)) + at(&(i, 1))
export func g() -> (n: u32) { for j in 4 { n += deep(((j, 2), 3)) } }`)).toEqual(['at<u64>', 'deep<u32>', 'deep<u64>'])
    // Only literals: nothing decides.
    expect(errorsOf(`${KEEP}export func f() -> u32 => keep((1, 2))`)).toEqual([
      "cannot infer T for 'keep' from untyped literals: write keep(i32, ...) or give a literal its type",
    ])
    // The first argument that decides decides: here the tuple, by i, and a
    // later u64 is not widened to.
    const KEEP2 = 'func keep2(comptime T: type, p: (T, T), q: T) -> T => q\n'
    expect(errorsOf(`${KEEP2}export func f(i: u32, big: u64) -> u64 => keep2((i, 1), big)`)).toEqual(['argument 2: cannot assign u64 to u32'])
    expect(instancesOf(`${KEEP2}export func f(big: u64) -> u64 => keep2((1, 2), big)`)).toEqual(['keep2<u64>'])
  })

  test('a tuple that decides by its typed parts compiles as the same call written out', async () => {
    const generic = 'func keep(comptime T: type, p: (T, T)) -> T => p.0\nexport func f(i: u32) -> u32 => keep((i, 1)) + keep((2, i))'
    const written = 'func keep(comptime T: type, p: (T, T)) -> T => p.0\nexport func f(i: u32) -> u32 => keep(u32, (i, 1)) + keep(u32, (2, i))'
    expect(await wasmOfSource(generic)).toEqual(await wasmOfSource(written))
  })

  test('a range written in a type is part of the type', () => {
    expect(instancesOf(`${HEAD}export func f(xs: []u8#16) -> u8 => head(xs)`)).toEqual(["head<u8#16>"])
    expect(instancesOf('func get(comptime T: type, p: *T) -> T => p.*\nexport func f(p: *u8#16) -> u8 => get(p)')).toEqual([
      'get<u8#16>',
    ])
  })

  test('aliases are transparent', () => {
    const source = `type Pt = (q: i32, r: i32)
func pick(comptime T: type, first: bool, a: T, b: T) -> T => if first { a } else { b }
export func a(c: bool, p: Pt, q: Pt) -> Pt => pick(c, p, q)
export func b(c: bool, p: (q: i32, r: i32), q: (q: i32, r: i32)) -> Pt => pick(c, p, q)
export func c(c: bool, p: Pt, q: Pt) -> Pt => pick(Pt, c, p, q)
export func d(c: bool, p: Pt, q: Pt) -> Pt => pick((q: i32, r: i32), c, p, q)`
    expect(instancesOf(source)).toEqual(['pick<<q:i32|r:i32>>'])
  })

  test('an untyped literal takes the type a later argument decides', () => {
    expect(instancesOf(`${MAX}export func f(x: u64) -> u64 => max(1, x)`)).toEqual(['max<u64>'])
    expect(instancesOf(`${MAX}export func f(x: f64) -> f64 => max(x, 0.5)`)).toEqual(['max<f64>'])
  })

  test('a literal with its type written on it decides', () => {
    expect(instancesOf(`${MAX}export func f() -> u8 => max(7:u8, 9)`)).toEqual(['max<u8>'])
  })

  test('untyped literals alone decide nothing', () => {
    expect(errorsOf(`${MAX}func f() -> i32 => max(1, 2)`)).toEqual([
      "cannot infer T for 'max' from untyped literals: write max(i32, ...) or give a literal its type (1:i32)",
    ])
    expect(errorsOf(`${MAX}func f() -> f64 => max(1.5, 2.0)`)).toEqual([
      "cannot infer T for 'max' from untyped literals: write max(f64, ...) or give a literal its type (1.5:f64)",
    ])
  })

  test('an array literal is untyped even when an element has a type', () => {
    expect(errorsOf(`${COUNT}func f() -> u32 => count([3:u32, 5, 5], 5)`)).toEqual([
      "cannot infer T for 'count' from untyped literals: write count(u32, ...) or give a literal its type",
    ])
    expect(instancesOf(`${COUNT}export func f() -> u32 => count(u32, [3, 5, 5], 5)`)).toEqual(['count<u32>'])
    expect(instancesOf(`${COUNT}export func f() -> u32 => count([3, 5, 5]:[]u32, 5)`)).toEqual(['count<u32>'])
  })

  test('a type parameter no argument mentions has to be written', () => {
    expect(errorsOf(`${ZERO}func f() -> u32 => zero()`)).toEqual([
      "cannot infer T for 'zero': write the type argument, as in zero(u32)",
    ])
    const make = 'func make(comptime T: type, n: u32) -> T => n as T\n'
    expect(errorsOf(`${make}func f() -> u8 => make(3)`)).toEqual([
      "cannot infer T for 'make': write the type argument, as in make(u32, ...)",
    ])
    expect(instancesOf(`${ZERO}export func f() -> u32 => zero(u32)`)).toEqual(['zero<u32>'])
  })

  // A function type is laid over a function's signature: a function passed
  // for f: (T) -> T decides T, and the literal after it takes that type. inc
  // takes a u32, so the 3 is a u32, not the i32 it would be on its own.
  test('a function type is matched by the signature of a function', () => {
    const source = `func inc(x: u32) -> u32 => x + 1
func wide(x: u64) -> u64 => x
func apply(comptime T: type, f: (T) -> T, x: T) -> T => x
func keep(comptime T: type, f: (T) -> T) -> u32 => sizeof(T)
`
    expect(instancesOf(`${source}export func a() -> u32 => apply(inc, 3) + keep(inc)`)).toEqual(['apply<u32>', 'keep<u32>'])
    expect(instancesOf(`${source}export func b(v: u32) -> u64 => apply(wide, v) + apply(u64, wide, 3)`)).toEqual(['apply<u64>'])
    // The first argument that can decides: the function, which stands first.
    expect(errorsOf(`${source}func c(v: u64) -> u64 => apply(inc, v)`)).toEqual(['argument 2: cannot assign u64 to u32'])
    // Matching only binds, part by part: T is found in add's result, and
    // that add does not fit is the ordinary argument error.
    const two = 'func add(a: u32, b: u32) -> u32 => a + b\n'
    expect(errorsOf(`${source}${two}func d() -> u32 => keep(add)`)).toEqual([
      'argument 1: cannot assign func(a: u32, b: u32) -> u32 to func(u32) -> u32',
    ])
    // The same when a typed argument has the wrong shape for its parameter
    expect(errorsOf(`${COUNT}func d(n: u32) -> u32 => count(n, 5)`)).toEqual([
      "cannot infer T for 'count': write the type argument, as in count(u32, ...)",
    ])
  })

  test('a tuple parameter is matched by a tuple of as many elements only', () => {
    const both = 'func both(comptime A: type, comptime B: type, p: (A, B)) -> A => p.0\n'
    expect(instancesOf(`${both}export func f(t: (i32, f64)) -> i32 => both(t)`)).toEqual(['both<i32|f64>'])
    expect(errorsOf(`${both}func f(t: (i32, f64, u8)) -> i32 => both(t)`)).toEqual([
      "cannot infer A for 'both': write the type arguments, as in both(u32, u32, ...)",
    ])
  })

  test('the type a call is used as is not used to infer', () => {
    expect(errorsOf(`${ZERO}func f() { let x: u32 = zero() }`)).toEqual([
      "cannot infer T for 'zero': write the type argument, as in zero(u32)",
    ])
  })

  test('string, array and if arguments of an inferred call are checked once they have a type', () => {
    const source = `func same(comptime T: type, a: []T, b: []T) -> bool => a.len == b.len
func pick(comptime T: type, first: bool, a: T, b: T) -> T => if first { a } else { b }
export func a(xs: []u8) -> bool => same(xs, "hello")
export func b(xs: []u16) -> bool => same(xs, [1, 2, 3])
export func c(x: u64, c: bool) -> u64 => pick(c, x, if c { 1 } else { 2 })`
    const result = check(source)
    expect(result.errors).toEqual([])
    // Each literal is registered once, although its argument is inferred and then checked.
    expect(result.literals).toHaveLength(2)
  })

  test('() decides nothing: an argument without a value is an error at the argument', () => {
    const source = `type Unit = ()
func nothing() { }
func id(comptime T: type, a: T) -> T => a
func at(comptime T: type, p: *T) -> u32 => p as u32
export func a() { id(nothing()) }
export func b() { id(()) }
export func c(u: Unit) { id(Unit, u) }
export func d(p: *Unit) -> u32 => at(p)`
    expect(errorsOf(source)).toEqual([
      "argument 1 of 'id' has no value",
      "argument 1 of 'id' has no value",
      "type argument T of 'id' cannot be (): it has no values",
      "cannot infer T for 'at': write the type argument, as in at(u32, ...)",
    ])
    expect(check(source).instances).toEqual([])
  })

  describe('an if expression ending in an operator, as the argument that decides', () => {
    // 0.2.1 gave such an if the type () when nothing said what it should be,
    // and the call the error "argument 1 of 'max' has no value".
    test('decides T', () => {
      const source = `${MAX}export func f(c: bool, x: u32, y: u32) -> u32 => max(if c { x + 1 } else { y }, y)`
      expect(instancesOf(source)).toEqual(['max<u32>'])
    })

    test('decides the wider type when its branches differ, and the narrower branch is widened', async () => {
      const source = `${MAX}export func f(c: bool, x: u32, y: u64) -> u64 => max(if c { x + 1 } else { y }, y)`
      expect(instancesOf(source)).toEqual(['max<u64>'])
      // x + 1 is a u32 addition, widened where the branch ends: once, although
      // the argument was inferred to find T and then checked against it.
      const f = funcWat(watOfSource(source), 'f')
      expect(f.match(/i64\.extend_i32_u/g)).toEqual(['i64.extend_i32_u'])
      expect(f).toContain('(i64.extend_i32_u (i32.add (local.get $x) (i32.const 1)))')
      const instance = await WebAssembly.instantiate(await WebAssembly.compile(await wasmOfSource(source)))
      const run = instance.exports.f as (c: number, x: number, y: bigint) => bigint
      expect(run(1, 5, 3n)).toBe(6n)
      expect(run(0, 5, 3n)).toBe(3n)
      expect(run(1, -1, 0n)).toBe(0n)
    })

    test('without an else has no value, and is one error at the argument', () => {
      const source = `${MAX}export func f(c: bool, x: u32, y: u32) -> u32 => max(if c { x + 1 }, y)`
      expect(errorsOf(source)).toEqual(["argument 1 of 'max' has no value"])
    })
  })

  test('a let inside the argument that decides is declared once', () => {
    const source = `${MAX}export func a(c: bool, x: u32, y: u32) -> u32 => max(if c {
  let t: u32 = x * 2
  t
} else { y }, y)
export func b(k: u32, x: u64) -> u64 => max(match k {
  0 => x
  _ => {
    let t = x + 1
    t * 2
  }
}, 7)`
    expect(errorsOf(source)).toEqual([])
    expect(instancesOf(source)).toEqual(['max<u32>', 'max<u64>'])
  })

  test('a let of one name in two arguments that are both looked at is declared twice', () => {
    // A look declares in a scope of its own and takes back what it recorded,
    // also that the let has declared its local: the two lets then meet in one
    // scope when the arguments are checked. (A let that is checked a second
    // time is no second declaration: an operand of a builtin is.)
    const FIRST = 'func first(comptime A: type, comptime B: type, a: A, b: B) -> A => a\n'
    const call = (second: string) => `${FIRST}export func f(c: bool, x: i64, y: i32) -> i64 => first(if c {
  let t = x
  t
} else { 2 }, if c {
  let ${second} = y
  ${second}
} else { 3 })`
    expect(errorsOf(call('t'))).toEqual(["'t' is already declared in this scope"])
    expect(errorsOf(call('u'))).toEqual([])
    // The operand of the builtin min is checked twice inside the look, and twice after it.
    expect(errorsOf(`${MAX}export func f(c: bool, x: i64) -> i64 => max(min(if c {
  let t = 1
  5
} else { 2 }, x), x)`)).toEqual([])
  })

  test('a repeated value meets the element type of the instance, in a body and as an argument', () => {
    // The value of `[n; 2]` is an element of the literal: it widens to the
    // slots of this instance or is an error of this instance, and an argument
    // that was looked at reports it once.
    const WIDE = 'func wide(comptime T: type, n: i32) -> T {\n  let d: *[2]T = [n; 2]\n  return d[1]\n}\n'
    expect(errorsOf(`${WIDE}export func f(n: i32) -> f64 => wide(f64, n) + (wide(i64, n) as f64)`)).toEqual([])
    expect(errorsOf(`${WIDE}export func f(n: i32) -> u8 => wide(u8, n)`)).toEqual(['cannot assign i32 to u8, in wide(T = u8)'])
    const LAST = 'func last(comptime T: type, s: []T) -> T => s[1] ?? 9\n'
    expect(errorsOf(`${LAST}export func f(n: i32) -> i64 => last(i64, [n; 2])`)).toEqual([])
    expect(errorsOf(`${LAST}export func f(n: i32) -> u8 => last(u8, [n; 2])`)).toEqual(['cannot assign i32 to u8'])
  })

  test('the look at the argument that decides leaves nothing in the tables kept by node', () => {
    // The argument is inferred once to find T and then checked against it.
    // What the first pass recorded for its nodes (a type, a widening, an `if`
    // marked as a statement) must not outlive it: with T written, nothing
    // looks first, and both calls have to end up with the same tables.
    const tables = (call: string) => {
      const result = check(`${MAX}export func f(c: bool, a: u64, b: u32, y: u64) -> u64 => ${call}`)
      expect(result.errors).toEqual([])
      const list = (table: Map<{ kind: string }, Parameters<typeof typeToString>[0]>) =>
        [...table].map(([node, type]) => `${node.kind} ${typeToString(type)}`).sort()
      return { types: list(result.exprTypes), coercions: list(result.coercions), bindings: result.types.size }
    }
    const argument = `if c {
  let t = a + b
  if t > 9 { t } else { a + b }
} else { max(a, b) }`
    const inferred = tables(`max(${argument}, y)`)
    expect(inferred).toEqual(tables(`max(u64, ${argument}, y)`))
    // b is widened where it meets a: three times in the argument, never more.
    expect(inferred.coercions.filter(entry => entry === 'IdentExpr u64')).toEqual(Array(3).fill('IdentExpr u64'))
  })

  test('nested inferred calls are not inferred again at each level', () => {
    // Each call is the argument that decides the next one out. Looked at and
    // then checked at every level, 40 levels would be 2^40 looks.
    const nested = (depth: number, inner: string) => `${'id('.repeat(depth)}${inner}${')'.repeat(depth)}`
    const fold = (depth: number) => `${'mix('.repeat(depth)}h${Array.from({ length: depth }, (_, i) => `, x + ${i})`).join('')}`
    const source = `func id(comptime T: type, a: T) -> T => a
func mix(comptime T: type, h: T, v: T) -> T => (h ^ v) * 31
export func a(x: u32) -> u32 => ${nested(40, 'x')}
export func b(h: u64, x: u64) -> u64 => ${fold(40)}`
    const start = performance.now()
    expect(instancesOf(source)).toEqual(['id<u32>', 'mix<u64>'])
    expect(performance.now() - start).toBeLessThan(2000)
  })
})

describe('instances', () => {
  test('explicit and inferred calls that arrive at the same arguments share one', () => {
    const source = `${MAX}export func a(x: u32, y: u32) -> u32 => max(x, y)
export func b(x: u32, y: u32) -> u32 => max(u32, x, y)
export func c(x: u32) -> u32 => max(x, 1) + max(u32, 2, x)`
    expect(instancesOf(source)).toEqual(['max<u32>'])
  })

  test('a call is checked against its own spelling of the type, whichever call made the instance', () => {
    const source = `type Meters = u32
type Feet = u32
func id(comptime T: type, a: T) -> T => a
export func m(x: Meters) -> Meters => id(Meters, x)
export func f(y: f64) -> Feet => id(Feet, y)
export func g(y: f64) -> u32 => id(u32, y)`
    expect(errorsOf(source)).toEqual(['argument 2: cannot assign f64 to Feet', 'argument 2: cannot assign f64 to u32'])
  })

  test('a type that recurses through an alias of itself is one type argument', async () => {
    const source = `type Node = (next: ?*Link, v: i32)
type Link = Node
func val(comptime T: type, p: *T) -> u32 => sizeof(T)
export func a(p: *Node) -> u32 => val(p)
export func b(p: *Link) -> u32 => val(p)
export func c(p: *Node) -> u32 => val(Link, p)
export func d(p: *Link) -> u32 => val(Node, p)`
    expect(instancesOf(source)).toEqual(['val<<next:?*@0|v:i32>>'])

    // A mutable literal is one buffer per instance, so the count shows at run time.
    const counting = `type Node = (next: ?*Link, v: i32)
type Link = Node
func cell(comptime T: type) -> *mut [1]u32 => mut [0:u32; 1]
func bump(comptime T: type) -> u32 {
  let c = cell(T) as *mut u32
  c.* += 1
  return c.*
}
export func f() -> u32 => bump(Node) * 10 + bump(Link)`
    expect((await run(counting)).f()).toBe(12)
  })

  test('the same recursive struct written twice is accepted in either order', () => {
    // The checker does not see that these two are one type (0.2.1 does not
    // either), so neither call may be checked against the other's spelling.
    const calls = ['export func a(t: *Twice) -> u32 => tail(t)', 'export func b(o: *(v: i32, next: ?*Node)) -> u32 => tail(o)']
    for (const order of [calls, [...calls].reverse()]) {
      const source = `type Node = (v: i32, next: ?*Node)
type Twice = (v: i32, next: ?*Node)
func tail(comptime T: type, p: *T) -> u32 => p as u32
${order.join('\n')}`
      expect(instancesOf(source)).toHaveLength(1)
    }
  })

  test('function types that differ in the names of their parameters are one type argument', () => {
    const source = `func inc(x: i32) -> i32 => x + 1
func dec(y: i32) -> i32 => y - 1
func hold(comptime F: type, f: F, v: i32) -> i32 => v
export func a(v: i32) -> i32 => hold(inc, v) + hold(dec, v)
export func b(v: i32, g: (i32) -> i32) -> i32 => hold(g, v) + hold((i32) -> i32, inc, v)`
    expect(instancesOf(source)).toEqual(['hold<<i32>=><i32>>'])
  })

  test('a generic nobody calls has none, and its body is not checked', () => {
    const source = `func unused(comptime T: type, x: T) -> T => nothing(x) + Missing(1)
export func f() -> u32 => 1`
    const result = check(source)
    expect(result.errors).toEqual([])
    expect(result.instances).toEqual([])
    expect(result.warnings.map(w => w.message)).toEqual(["'unused' is never used"])
  })

  test('a generic used only by a test has an instance only when tests are checked', () => {
    const source = `${MAX}export func f(a: u32) -> u32 => max(a, 1)
test "wide" {
  assert max(i64, -1, 5) == 5
}`
    expect(instancesOf(source, { includeTests: false })).toEqual(['max<u32>'])
    expect(instancesOf(source, { includeTests: true })).toEqual(['max<i64>', 'max<u32>'])
  })

  test('a generic may call itself and other generics', () => {
    const source = `func fact(comptime T: type, n: T) -> T => if n <= 1 { 1 } else { n * fact(T, n - 1) }
func even(comptime T: type, n: T) -> bool => if n == 0 { true } else { odd(n - 1) }
func odd(comptime T: type, n: T) -> bool => if n == 0 { false } else { even(T, n - 1) }
${MAX}func min(comptime T: type, a: T, b: T) -> T => if a < b { a } else { b }
func clamp(comptime T: type, x: T, lo: T, hi: T) -> T => min(max(x, lo), hi)
export func a() -> u64 => fact(u64, 20)
export func b(n: u32) -> bool => even(n)
export func c(x: i32) -> i32 => clamp(x, 0, 10)`
    expect(instancesOf(source)).toEqual(['clamp<i32>', 'even<u32>', 'fact<u64>', 'max<i32>', 'min<i32>', 'odd<u32>'])
  })

  describe('a generic that never stops instantiating itself is one error', () => {
    test('when each instance asks for one more', () => {
      const source = `func deep(comptime T: type, n: u32) -> u32 => if n == 0 { sizeof(T) } else { deep(*T, n - 1) }
export func f() -> u32 => deep(u8, 3)`
      const errors = errorsOf(source)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toStartWith("too many nested instantiations (64) while instantiating 'deep', in deep(T = ***")
      // The type that grew is cut, not printed in full.
      expect(errors[0].length).toBeLessThan(160)
    })

    test('when each instance asks for two more, long before 64 levels of them exist', () => {
      const source = `func grow(comptime T: type, n: u32) -> u32 {
  return 0 when n == 0
  return grow(*T, n - 1) + grow([]T, n - 1)
}
export func f() -> u32 => grow(u8, 2)`
      const start = performance.now()
      const errors = errorsOf(source)
      expect(performance.now() - start).toBeLessThan(5000)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toStartWith("too many instantiations (1000) from one call while instantiating 'grow', in grow(T = ")
    })

    test('when the type argument doubles, long before it is written out 64 times over', () => {
      const source = `func deep(comptime T: type, x: T) -> u32 => deep((T, T), (x, x))
export func f() -> u32 => deep(u8, 1)`
      const errors = errorsOf(source)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toStartWith("type arguments grow without end while instantiating 'deep', in deep(T = ((((")
      expect(errors[0].length).toBeLessThan(160)
    })
  })

  test('a type argument may be as large as the program makes it', () => {
    // Written out with its aliases expanded, World is some 5000 characters.
    // That is the size of a type, not a sign of endless instantiation.
    const source = `type Vec3 = (x: f64, y: f64, z: f64)
type Body = (position: Vec3, velocity: Vec3, acceleration: Vec3, mass: f64, radius: f64)
type Four = (first: Body, second: Body, third: Body, fourth: Body)
type Sixteen = (north: Four, south: Four, east: Four, west: Four)
type World = (inner: Sixteen, middle: Sixteen, outer: Sixteen, age: u64)
type Worlds = (here: World, there: World)
func size(comptime T: type) -> u32 => sizeof(T)
func addr(comptime T: type, p: *T) -> u32 => p as u32
func both(comptime T: type, p: *T) -> u32 => addr(p) + size(T) + size((T, T))
export func a() -> u32 => size(World)
export func b(w: *World) -> u32 => both(w)
export func c(w: *Worlds) -> u32 => addr(w)`
    const names = instancesOf(source)
    expect(names).toHaveLength(5)
    // The name of an instance stays short, and still tells World from Worlds.
    for (const name of names) expect(name.length).toBeLessThan(100)
    expect(new Set(names).size).toBe(5)
    expect(names.filter(n => n.startsWith('addr<'))).toHaveLength(2)
  })

  test('a generic sees its own module, not the locals of its caller', () => {
    const source = `func leak(comptime T: type, x: T) -> T {
  let seen = hidden
  return x
}
export func f() -> u32 {
  let hidden: u32 = 1
  return leak(hidden)
}`
    expect(errorsOf(source)).toEqual(["unknown identifier 'hidden', in leak(T = u32)"])
  })

  test('an instance does not see what a test declares', () => {
    // A function declared in a test is registered in module scope, and
    // instance bodies are checked after the tests. The call would check, and
    // then name a function the instance's code does not have.
    const source = `func apply(comptime T: type, a: T) -> T => twice(a as u32) as T
test "group" {
  import "env" "probe" func probe(x: u32)
  func twice(a: u32) -> u32 => a * 2
  test "inner" {
    assert apply(u8, 21) == 42
  }
}`
    expect(errorsOf(source)).toEqual(["no function 'twice' accepts (u32), in apply(T = u8)"])
    expect(errorsOf(source.replace('twice(a as u32) as T', 'a\nfunc g(comptime T: type, a: T) { probe(1) }\nexport func h() { g(u8, 1) }'))).toEqual([
      "no function 'probe' accepts (int(1)), in g(T = u8)",
    ])
    // A function of the module that a test declares again is still the module's.
    const shadowed = `func twice(a: u32) -> u32 => a + a
func apply(comptime T: type, a: T) -> T => twice(a as u32) as T
test "group" {
  func twice(a: u32) -> u32 => a * 2
  assert apply(u8, 21) == 42
}`
    expect(errorsOf(shadowed)).toEqual([])
  })

  test('a call in a global initializer is no constant, a generic\'s no more than another\'s', () => {
    const notConstant = ['global initializer must be a compile-time constant']
    expect(errorsOf(`${MAX}global limit: u32 = max(u32, 3, 4)
export func f() -> u32 => limit`)).toEqual(notConstant)
    expect(errorsOf(`func max_u32(a: u32, b: u32) -> u32 => if a > b { a } else { b }
global limit: u32 = max_u32(3, 4)
export func f() -> u32 => limit`)).toEqual(notConstant)
  })

  // The initializer of a global and the value of a def are inferred while
  // declarations are still being collected, before they are found not to be
  // constants. A type argument declared further down is not resolved yet
  // there; instantiated all the same, the instance would be made for the
  // name alone and its errors would be about that.
  test('a type argument may be declared after a call that is inferred during collection', () => {
    // The types of a module are collected before its globals and defs, so
    // the type is no part of what is wrong, wherever it is declared.
    const pick = 'func pick(comptime T: type, first: bool, a: T, b: T) -> T => if first { a } else { b }\n'
    expect(errorsOf(`${pick}global g: i32 = pick(Late, true, (1, 2), (3, 4)).q
type Late = (q: i32, r: i32)`)).toEqual(['global initializer must be a compile-time constant'])
    expect(errorsOf(`${pick}def d = pick(Late, true, (1, 2), (3, 4)).q
type Late = (q: i32, r: i32)
export func f() -> i32 => d`)).toEqual(['def value must be a compile-time constant'])
    expect(errorsOf(`type Late = (q: i32, r: i32)
${pick}global g: i32 = pick(Late, true, (1, 2), (3, 4)).q`)).toEqual(['global initializer must be a compile-time constant'])
  })
})

describe('errors in an instance', () => {
  // 300 is a literal that a u8 and an i8 cannot hold, and a u32 can.
  const OVER = 'func over(comptime T: type, x: T) -> bool => x > 300\n'

  test('are reported in the generic, with types as the instance has them, followed by the instance', () => {
    const source = `${OVER}export func f(x: u8) -> bool => over(x)`
    const result = check(source)
    expect(result.errors).toEqual([
      {
        offset: source.indexOf('300\n'),
        message: 'cannot assign int(300) to u8, in over(T = u8)',
        notes: [{ offset: source.indexOf('over(x)'), message: 'required from' }],
      },
    ])
  })

  test('appear once, however many calls use the instance', () => {
    const source = `${OVER}export func a(x: u8) -> bool => over(x)
export func b(x: u8) -> bool => over(u8, x) && over(x + 1)`
    expect(errorsOf(source)).toEqual(['cannot assign int(300) to u8, in over(T = u8)'])
  })

  test('appear once per instance that has them', () => {
    const source = `${OVER}export func a(x: u8, y: i8, z: u32) -> bool => over(x) && over(y) && over(z)`
    expect(errorsOf(source)).toEqual([
      'cannot assign int(300) to u8, in over(T = u8)',
      'cannot assign int(300) to i8, in over(T = i8)',
    ])
  })

  test('read the same whichever alias a call wrote: an alias that only renames a type is not named', () => {
    // One instance for Meters, Feet and u8. Named after the first call, its
    // error would read differently when the calls change places.
    const calls = ['over(m)', 'over(Feet, f)', 'over(x)']
    for (const order of [calls, [...calls].reverse()]) {
      const source = `type Meters = u8
type Feet = u8
${OVER}export func f(m: Meters, f: Feet, x: u8) -> bool => ${order.join(' && ')}`
      expect(errorsOf(source)).toEqual(['cannot assign int(300) to u8, in over(T = u8)'])
    }
  })

  test('name a struct by its alias, and an alias of the alias by the struct\'s', () => {
    const source = `type Pt = (q: i32, r: i32)
type Hex = Pt
func bad(comptime T: type, x: T) -> bool => 1
export func f(a: Hex, b: *Hex) -> bool => bad(a) && bad(b)`
    expect(errorsOf(source)).toEqual([
      'cannot assign int(1) to bool, in bad(T = Pt)',
      'cannot assign int(1) to bool, in bad(T = *Pt)',
    ])
  })

  test('come after the errors of the module itself', () => {
    const source = `${OVER}export func a(x: u8) -> bool => over(x)
export func b() -> i32 => missing`
    expect(errorsOf(source)).toEqual([
      "unknown identifier 'missing'",
      'cannot assign int(300) to u8, in over(T = u8)',
    ])
  })

  test('name the generic, not the instance, when a function is named', () => {
    const source = `func noret(comptime T: type, x: T) -> T { let y = x }
export func f(x: u32) -> u32 => noret(x)`
    expect(errorsOf(source)).toEqual([
      "function 'noret' can reach its end without returning a value, in noret(T = u32)",
    ])
  })

  test('an operator the type argument does not have is an error in the instance', () => {
    const source = `type Pt = (q: i32, r: i32)
${MAX}export func f(a: Pt, b: Pt) -> Pt => max(a, b)
export func g(a: u32, b: u32) -> u32 => max(a, b)`
    expect(check(source).errors.map(place)).toEqual([
      { offset: source.indexOf('a > b'), message: `${noOperator('>', 'Pt')}, in max(T = Pt)` },
    ])
    const eq = `func same(comptime T: type, a: T, b: T) -> bool => a == b
export func f(a: []u8, b: []u8) -> bool => same(a, b)`
    expect(errorsOf(eq)).toEqual([`${noOperator('==', '[]u8')}, in same(T = []u8)`])
  })

  // The checks are the ones every function gets (inferUnary, compound
  // assignment): an instance is told what the same function written by hand
  // for that type would be told, once, with the instance after it.
  test('a unary operator or compound assignment the type argument does not have is an error in the instance', () => {
    const generics = `type Pt = (q: i32, r: i32)
func neg(comptime T: type, a: T) -> T => -a
func inv(comptime T: type, a: T) -> T => ~a
func not(comptime T: type, a: T) -> bool => !a
func twice(comptime T: type, a: T) -> T {
  let b = a
  b += a
  return b
}
func shl(comptime T: type, a: T) -> T {
  let b = a
  b <<= 1
  return b
}
`
    const source = `${generics}export func f(p: Pt) -> Pt => shl(twice(inv(neg(p))))
export func g(p: Pt, q: Pt) -> bool => not(p) && not(q)
export func h(xs: []u8) -> []u8 => shl(twice(inv(neg(xs))))
export func k(xs: []u8) -> bool => not(xs)`
    const result = check(source)
    const at = (text: string) => source.indexOf(text)
    const expected = (type: string) => [
      { offset: at('-a'), message: `'-' needs a number, not ${type}, in neg(T = ${type})` },
      { offset: at('~a'), message: `'~' needs an integer, not ${type}, in inv(T = ${type})` },
      { offset: at('b += a'), message: `${noOperator('+=', type)}, in twice(T = ${type})` },
      { offset: at('b <<= 1'), message: `${noOperator('<<=', type, 'int(1)')}, in shl(T = ${type})` },
      // This one points at the operand.
      { offset: at('!a') + 1, message: `operand of '!' must be bool, not ${type}, in not(T = ${type})` },
    ]
    const byPlace = (a: { offset: number; message: string }, b: { offset: number; message: string }) =>
      a.offset - b.offset || (a.message < b.message ? -1 : 1)
    expect(result.errors.map(place).sort(byPlace)).toEqual([...expected('Pt'), ...expected('[]u8')].sort(byPlace))
    // The types that have these operators are untouched by the checks.
    expect(errorsOf(`${generics}export func ok(x: i32, y: bool) -> bool => not(y) && twice(neg(inv(shl(x)))) > 0`)).toEqual([])
  })

  test('a type parameter that is not a struct or tuple has no constructor', () => {
    const source = `func make(comptime T: type, x: i32) -> T => T(x, x)
export func f() -> (i32, i32) => make((i32, i32), 1)`
    expect(errorsOf(source)).toEqual([])
    const number = 'u32 is not a struct or tuple type: it has no constructor; to convert a number write x as T, in make(T = u32)'
    expect(errorsOf(source.replace(/\(i32, i32\)/g, 'u32'))).toEqual([number])
    // Its arguments are still checked: their own mistakes are not hidden.
    expect(errorsOf(source.replace(/\(i32, i32\)/g, 'u32').replace('T(x, x)', 'T(x, nope)'))).toEqual([
      number,
      "unknown identifier 'nope', in make(T = u32)",
    ])
    // A type among them is part of the one mistake: T was taken for a
    // generic type, and that a type is no value needs no saying.
    expect(errorsOf(source.replace(/\(i32, i32\)/g, 'u32').replace('T(x, x)', 'T(u8)'))).toEqual([number])
  })

  test('a warning in an instance is placed in the generic and names the instance', () => {
    const source = `data buf = mut [0:u8; 16]
func clear(comptime T: type, n: u32, x: T) -> T {
  memset(buf, 0, n)
  return x
}
export func f(n: u32) -> u32 => clear(n, n) + (clear(n, 1:u8) as u32)`
    const warning = 'memset length is not a compile-time constant — cannot verify bounds (buffer is 16 bytes)'
    const offset = source.indexOf('n)\n  return')
    expect(check(source).warnings.map(place)).toEqual([
      { offset, message: `${warning}, in clear(T = u32)` },
      { offset, message: `${warning}, in clear(T = u8)` },
    ])
  })
})

describe('one mistake, one error', () => {
  test('a failed call says nothing about what its result is used for', () => {
    const source = `${MAX}${ZERO}func takes(x: f64) -> f64 => x
func a() -> f64 => max(1, 2)
func b() -> f64 {
  let x: f64 = zero()
  return takes(x)
}
func c() -> f64 => takes(max(3, 4)) + 1.0`
    expect(errorsOf(source)).toEqual([
      "cannot infer T for 'max' from untyped literals: write max(i32, ...) or give a literal its type (1:i32)",
      "cannot infer T for 'zero': write the type argument, as in zero(u32)",
      "cannot infer T for 'max' from untyped literals: write max(i32, ...) or give a literal its type (3:i32)",
    ])
  })

  test('nor about its fields, its elements, or the operators and calls it is given to', () => {
    const source = `type Pt = (q: i32, r: i32)
func pick(comptime T: type, first: bool, a: T, b: T) -> T => if first { a } else { b }
func id(comptime T: type, a: T) -> T => a
export func a(c: bool) -> i32 {
  let p = pick(c, Pt(1, 2))
  return p.q + p.r
}
export func b() -> i32 {
  let p = id((1, 2))
  return p.0
}
export func c(c: bool) -> i32 => pick(c)[0] * 2 + pick(c)(1)`
    expect(errorsOf(source)).toEqual([
      "'pick' expects 3 arguments, or 4 with its type argument written; got 2",
      "cannot infer T for 'id' from untyped literals: write id((i32, i32), ...) or give a literal its type",
      "'pick' expects 3 arguments, or 4 with its type argument written; got 1",
      "'pick' expects 3 arguments, or 4 with its type argument written; got 1",
    ])
  })

  test('an argument with an error of its own decides nothing', () => {
    // The unknown name would otherwise decide T = i32, and x would not fit it.
    expect(errorsOf(`${MAX}export func f(x: u32) -> u32 => max(nope, x)`)).toEqual(["unknown identifier 'nope'"])
    expect(errorsOf(`${MAX}export func f(x: u32) -> u32 => max(x.nope, x)`)).toEqual(["no field 'nope' on type u32"])
  })

  test('a failed call nested in failed calls is reported once, and in no more time', () => {
    const source = `func id(comptime T: type, a: T) -> T => a
export func f(x: u32) -> u32 => ${'id('.repeat(40)}nope${')'.repeat(40)}`
    const start = performance.now()
    expect(errorsOf(source)).toEqual(["unknown identifier 'nope'"])
    expect(performance.now() - start).toBeLessThan(2000)
  })

  test('a failed call still reports what is wrong with its arguments', () => {
    expect(errorsOf(`${MAX}func f() -> u32 => max(nope)`)).toEqual([
      "'max' expects 2 arguments, or 3 with its type argument written; got 1",
      "unknown identifier 'nope'",
    ])
  })

  test('a generic function is not a value', () => {
    expect(errorsOf(`${MAX}func f() -> u32 { let g = max\n  return 1 }`)).toEqual(["generic function 'max' must be called"])
    expect(errorsOf(`${MAX}func takes(x: f64) -> f64 => x\nfunc f() -> f64 => takes(max)`)).toEqual([
      "generic function 'max' must be called",
    ])
  })

  test('a type is not a value', () => {
    const source = `type Pt = (q: i32, r: i32)
func takes(x: f64) -> f64 => x
func a() -> f64 => takes(Pt)
func b() -> f64 => takes([]u8)`
    expect(errorsOf(source)).toEqual([
      "'Pt' is a type; a type can only be passed for a comptime parameter",
      "'[]u8' is a type; a type can only be passed for a comptime parameter",
    ])
  })

  test('the name of a primitive type is a type wherever it stands', () => {
    // One argument short, so this is the inferred form and u32 stands for a value.
    expect(errorsOf(`${MAX}export func f(x: u32) -> u32 => max(u32, x)`)).toEqual([
      "'u32' is a type; a type can only be passed for a comptime parameter",
    ])
    expect(errorsOf('export func f() -> u32 { let x = u32\n  return x }')).toEqual([
      "'u32' is a type; a type can only be passed for a comptime parameter",
    ])
  })

  test('a value written for a type parameter is that error only', () => {
    const source = `type Pt = (q: i32, r: i32)
func size(comptime T: type) -> u32 => sizeof(T)
export func a() -> u32 => size(pt)`
    expect(errorsOf(source)).toEqual(["argument 1 of 'size' must be a type: T is a type parameter"])
  })

  test('calls of a generic declared in a test add nothing to its error', () => {
    const source = `test "local generic" {
  func inner(comptime T: type, a: T) -> T => a
  let x: u8 = 1
  assert inner(x) == 1
  assert inner(u8, 2) == 2
}
test "another" {
  func inner(comptime T: type, a: T) -> T => a
  assert inner(u8, 2) == 2
}`
    expect(errorsOf(source)).toEqual([
      'a generic function is declared at module level, not inside a test',
      'a generic function is declared at module level, not inside a test',
    ])
  })

  test('calls of a generic whose declaration is wrong add nothing', () => {
    const source = `func f(comptime t: type, x: u32) -> u32 => x
export func g() -> u32 => f(u32, 1) + f(2)`
    expect(errorsOf(source)).toEqual([
      "a type parameter's name starts with an upper-case letter: write 'comptime T: type'",
    ])
  })
})

describe('declaring a generic function', () => {
  const cases: [string, string, string][] = [
    [
      'a comptime parameter of a float type',
      'func f(comptime r: f64) -> u32 => 0',
      "comptime parameter 'r' is f64: a comptime parameter is a type (comptime T: type), an integer (comptime n: u32) or a function (comptime f: (T) -> T)",
    ],
    [
      'a lower-case type parameter',
      'func f(comptime t: type) -> u32 => 0',
      "a type parameter's name starts with an upper-case letter: write 'comptime T: type'",
    ],
    [
      'a type parameter without comptime',
      'func f(T: type, a: T) -> u32 => 0',
      "a parameter of type 'type' must be comptime: write 'comptime T: type'",
    ],
    ['an unnamed parameter', 'func f(comptime T: type, u32) -> u32 => 0', "a generic function's parameters need names"],
    ['no name', 'func (comptime T: type, a: T) -> T => a', 'a generic function needs a name'],
    [
      'a type parameter named like a type',
      'type Pt = (q: i32, r: i32)\nfunc f(comptime Pt: type, a: Pt) -> u32 => 0',
      "type parameter 'Pt' has the name of a type declared in this module",
    ],
    [
      'a type parameter named like a type declared further down',
      'func f(comptime Pt: type, a: Pt) -> u32 => 0\ntype Pt = (q: i32, r: i32)',
      "type parameter 'Pt' has the name of a type declared in this module",
    ],
    [
      'a type parameter declared twice',
      'func f(comptime T: type, comptime T: type, a: T) -> u32 => 0',
      "type parameter 'T' is declared twice",
    ],
    [
      'the name of another function',
      'func max(a: u32) -> u32 => a\nfunc max(comptime T: type, a: T) -> T => a',
      "'max' is already declared: a generic function's name is unique in its module",
    ],
    [
      'a name another function takes later',
      'func max(comptime T: type, a: T) -> T => a\nfunc max(a: u32) -> u32 => a',
      "'max' is already declared: a generic function's name is unique in its module",
    ],
    [
      'the name of another generic',
      'func max(comptime T: type, a: T) -> T => a\nfunc max(comptime T: type, a: T, b: T) -> T => a',
      "'max' is already declared: a generic function's name is unique in its module",
    ],
    // Whatever is declared after a generic cannot take its name. The uses of
    // the name are then the generic's, called or not, and say nothing more.
    // (The parser has already put 4 wherever the def's name is used.)
    [
      'a name a def takes later',
      'func size(comptime T: type, a: T) -> T => a\ndef size = 4\nexport func f() -> u32 => size',
      "'size' is already declared: a generic function's name is unique in its module",
    ],
    [
      'a name a global takes later',
      'func count(comptime T: type, a: T) -> T => a\nglobal count: u32 = 0\nexport func f() -> u32 => count + count(u32, 1)',
      "'count' is already declared: a generic function's name is unique in its module",
    ],
    [
      'a name a data declaration takes later',
      'func table(comptime T: type, a: T) -> T => a\ndata table = [1:u8, 2, 3]\nexport func f() -> u32 => table(u32, 1)',
      "'table' is already declared: a generic function's name is unique in its module",
    ],
    [
      'a name an import takes later',
      'func log(comptime T: type, a: T) -> T => a\nimport "env" "log" func log(x: u32)\nexport func f() -> u32 => log(u32, 1)',
      "'log' is already declared: a generic function's name is unique in its module",
    ],
    [
      'a declaration inside a test',
      'test "t" {\n  func id(comptime T: type, a: T) -> T => a\n}',
      'a generic function is declared at module level, not inside a test',
    ],
    [
      // In a file checked on its own the import's signature is all there is
      // of the generic, and it is held to the rules of a declaration.
      'a source import whose signature breaks a rule',
      'import "./lib" "pick" func pick(T: type, a: u32) -> u32',
      "a parameter of type 'type' must be comptime: write 'comptime T: type'",
    ],
    [
      'a host import',
      'import "env" "max" func max(comptime T: type, a: T, b: T) -> T',
      'a host import cannot have comptime parameters',
    ],
  ]
  for (const [what, source, message] of cases) {
    test(`${what} is one error`, () => {
      expect(errorsOf(source)).toEqual([message])
    })
  }

  test('type parameters may stand anywhere in the list', () => {
    const source = `func at(xs: []T, comptime T: type, i: u32) -> T => xs.ptr[i]
export func a(xs: []u16) -> u16 => at(xs, 2)
export func b(xs: []u8) -> u8 => at(xs, u8, 2)`
    expect(instancesOf(source)).toEqual(['at<u16>', 'at<u8>'])
  })

  test('a generic named like a builtin is the one that is called', () => {
    const source = `func max(comptime T: type, a: T, b: T, c: T) -> T => if a > b { a } else { c }
export func f(a: u32) -> u32 => max(a, 1, 2)`
    expect(instancesOf(source)).toEqual(['max<u32>'])
  })

  test('an exported generic is not reported as unused', () => {
    // It is a function that replaces a builtin, which is said once.
    expect(check(`export ${MAX}`).warnings.map(w => w.message)).toEqual(["'max' replaces the builtin max in this module"])
    expect(check(`export ${MAX.replace('max', 'largest')}`).warnings).toEqual([])
  })

  // A file checked on its own, as the editor checks one whose imports it
  // cannot read: an imported generic is the signature its import writes. Its
  // instances are functions of the module that declares it, which exports
  // none, so the file is compiled only as part of its program.
  test('a source import, in a file checked on its own, is its signature', () => {
    const source = 'import "./lib" "max" func max(comptime T: type, a: T, b: T) -> T\nexport func f(a: u32, b: u32) -> u32 => max(a, b)\nexport func g(a: f64) -> f64 => a.max(0.5)\n'
    const result = check(source)
    expect(result.errors).toEqual([])
    expect(result.instances.map((i) => i.name)).toEqual(['max<u32>', 'max<f64>'])
    expect(() => watOfSource(source)).toThrow('a module that imports a generic function is compiled as part of its program')
    expect(errorsOf('import "./lib" "max" func max(comptime T: type, a: T, b: T) -> T\nfunc f(a: u8, b: u32) -> u32 => max(a, b)')).toEqual([
      'argument 2: cannot assign u32 to u8',
    ])
  })

  test('a generic type imported in a file checked on its own leaves its errors to the program', () => {
    const result = check('import "./lib" "Vec" func Vec(comptime T: type) -> type\nexport func f(v: *Vec(u32)) -> u32 => v.len + nowhere\n')
    expect(result.partial).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.warnings.map((w) => w.message)).toEqual(['imported generic types are resolved only when the program is checked'])
    expect(() => watOfSource('import "./lib" "Vec" func Vec(comptime T: type) -> type\n')).toThrow(/compiled as part of its program/)
  })

  // The import may be written as if the function were ordinary; what the
  // other module exports under that name is what counts, as it is for any
  // function a source module imports.
  test('a generic of another module is imported as what it is, whatever signature the import writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'encantis-generics-'))
    try {
      await writeFile(join(dir, 'util.ents'), `export ${MAX}`)
      const entry = join(dir, 'main.ents')
      await writeFile(entry, 'import "./util" "max" func max(a: u32, b: u32) -> u32\nexport func f(a: u32) -> u32 => max(a, 1)\n')
      const load = await loadModule(entry)
      const program = typecheckProgram(load.modules, entry, { includeTests: false })
      expect(program.errors).toEqual([])
      expect(programToWat(load.modules, program.results, entry)).toContain('(call $util$max<u32> (local.get $a) (i32.const 1))')
    } finally {
      await rm(dir, { recursive: true })
    }
  })
})

// The checker keeps the type of an expression, its implicit conversion and
// the call a generic call compiles to by AST node. An instance has its own
// because its nodes are its own: a node two instances shared would give both
// one type and one conversion.
describe('the nodes of an instance', () => {
  const source = `def limit = 10
type Pt = (q: i32, r: i32)
func pick(comptime T: type, c: bool, a: T, b: T) -> T => if c { a } else { b }
func busy(comptime T: type, xs: []T, x: T, n: u32) -> T {
  let p: Pt = (q: 1, r: 2)
  let q = Pt(q: p.q, r: 2)
  let text = "abc"
  let total: u32 = n + limit + sizeof(T) + text.len + (q.r as u32)
  let best = x
  for i, v in xs {
    best = pick(v > best, v, best)
    best = match i {
      0 => best
      _ => pick(T, total > 0.5 as u32, best, v)
    }
  }
  return best
}
export func a(xs: []u32) -> u32 => busy(xs, 1, 2)
export func b(xs: []u64) -> u64 => busy(u64, xs, 1, 2)`

  // Every object of a syntax tree. The bytes of a string are data, and what
  // a bound type parameter holds is a resolved type: neither is a node.
  function nodesOf(root: unknown, found = new Set<object>()): Set<object> {
    if (root === null || typeof root !== 'object' || root instanceof Uint8Array || found.has(root)) return found
    found.add(root)
    for (const [key, value] of Object.entries(root)) {
      if ((root as { kind?: string }).kind === 'BoundType' && key === 'type') continue
      nodesOf(value, found)
    }
    return found
  }

  const result = check(source)
  const trees = (name: string) => result.instances.filter(i => i.of.ident === name)
  const instance = (name: string) => {
    const found = result.instances.find(i => i.decl.ident === name)
    if (!found) throw new Error(`no instance ${name}`)
    return found.decl
  }
  // The node of an instance that was copied from this place in the source
  const at = (decl: object, kind: string, text: string) => {
    const offset = source.indexOf(text)
    const found = [...nodesOf(decl)].filter((n) => {
      const node = n as { kind?: string; span?: { start: number } }
      return node.kind === kind && node.span !== undefined && node.span.start % INSTANCE_STRIDE === offset
    })
    expect(found.length).toBe(1)
    return found[0] as Parameters<typeof result.exprTypes.get>[0]
  }

  test('are its own: none is shared with the generic or with another instance', () => {
    expect(result.errors).toEqual([])
    expect(result.instances.map(i => i.decl.ident).sort()).toEqual(['busy<u32>', 'busy<u64>', 'pick<u32>', 'pick<u64>'])
    for (const name of ['busy', 'pick']) {
      const [first, second] = trees(name)
      const sets = [nodesOf(first.of), nodesOf(first.decl), nodesOf(second.decl)]
      expect(sets[0].size).toBeGreaterThan(20)
      for (const [i, set] of sets.entries()) {
        for (const other of sets.slice(i + 1)) {
          expect([...set].filter(node => other.has(node))).toEqual([])
        }
      }
    }
  })

  test('the generic itself is never given a type: only its copies are checked', () => {
    for (const { of } of result.instances) {
      const typed = [...nodesOf(of)].filter(node => result.exprTypes.has(node as never) || result.coercions.has(node as never))
      expect(typed).toEqual([])
    }
  })

  test('each instance has the type of an expression as its own type argument makes it', () => {
    const typeIn = (name: string, kind: string, text: string) => {
      const type = result.exprTypes.get(at(instance(name), kind, text))
      return type?.kind === 'primitive' ? type.name : type?.kind
    }
    expect(typeIn('busy<u32>', 'IdentExpr', 'v > best')).toBe('u32')
    expect(typeIn('busy<u64>', 'IdentExpr', 'v > best')).toBe('u64')
    expect(typeIn('busy<u32>', 'CallExpr', 'pick(T, total')).toBe('u32')
    expect(typeIn('busy<u64>', 'CallExpr', 'pick(T, total')).toBe('u64')
    // What does not depend on T is typed the same in each, on separate nodes.
    expect(typeIn('busy<u32>', 'BinaryExpr', 'v > best')).toBe('bool')
    expect(typeIn('busy<u64>', 'BinaryExpr', 'v > best')).toBe('bool')
  })

  test('each call in an instance is lowered to the call of that instance\'s own callee', () => {
    const lowered = (name: string, text: string) => {
      const call = result.calls.get(at(instance(name), 'CallExpr', text) as never)
      return call?.callee.kind === 'IdentExpr' ? call.callee.name : undefined
    }
    expect(lowered('busy<u32>', 'pick(v > best')).toBe('pick<u32>')
    expect(lowered('busy<u64>', 'pick(v > best')).toBe('pick<u64>')
    expect(lowered('busy<u32>', 'pick(T, total')).toBe('pick<u32>')
    expect(lowered('busy<u64>', 'pick(T, total')).toBe('pick<u64>')
    // The lowered call is compiled with the argument nodes that were checked.
    const written = at(instance('busy<u64>'), 'CallExpr', 'pick(T, total') as unknown as { args: object[] }
    const plain = result.calls.get(written as never) as unknown as { args: object[] }
    expect(plain.args).toEqual(written.args.slice(1))
    for (const [i, arg] of plain.args.entries()) expect(arg).toBe(written.args[i + 1])
  })
})

describe('the editor', () => {
  // The TextMate grammar is a file nothing else reads: a word missing from it
  // shows as a plain name in the editor and in every highlighted code block.
  test('comptime is highlighted as a keyword', async () => {
    const grammar = await Bun.file(new URL('../extension/encantis.tmlanguage.json', import.meta.url)).json()
    const patterns: { name: string; match: string }[] = grammar.repository.keywords.patterns
    const scopes = (line: string) => patterns.filter(p => new RegExp(p.match).test(line)).map(p => p.name)
    expect(scopes('func max(comptime T: type)')).toContain('storage.type.encantis')
    expect(scopes('comptime')).toEqual(['storage.type.encantis'])
    expect(scopes('comptimes')).toEqual([])
  })

  // host is a type only as all of a type declaration, and not reserved: the
  // declaration is highlighted, a variable named host is not. The rule is
  // tried before the type keyword's, which would otherwise take `type` and
  // leave host a plain name.
  test('a host type declaration is highlighted, and host elsewhere is a name', async () => {
    const grammar = await Bun.file(new URL('../extension/encantis.tmlanguage.json', import.meta.url)).json()
    const keywords: { name?: string; match: string; captures?: Record<string, { name: string }> }[] = grammar.repository.keywords.patterns
    const rule = keywords.find((p) => p.captures?.['4']?.name === 'support.type.host.encantis')
    expect(rule).toBeDefined()
    const typeKeyword = keywords.findIndex((p) => p.name === 'storage.type.encantis' && new RegExp(p.match).test('type'))
    expect(keywords.indexOf(rule as (typeof keywords)[number])).toBeLessThan(typeKeyword)
    const re = new RegExp((rule as { match: string }).match)
    expect(re.exec('type Canvas = host')?.[4]).toBe('host')
    expect(re.test('type Canvas = hosts')).toBe(false)
    expect(re.test('let host = 2')).toBe(false)
  })
})

describe('what an instance leaves in the tables the editor reads', () => {
  const source = `${COUNT}
func twice(x: u32) -> u32 => x * 2
func sum(comptime T: type, xs: []T) -> (total: T) {
  total = 0
  for v in xs {
    total += v
  }
  if false { total = twice(1) as T }
}
export func f(xs: []u8, ys: []u64) -> u64 => (count(xs, 7) as u64) + sum(ys) + (sum(xs) as u64)
export func g(x: f64) -> f64 => sum(x)`

  test('every offset is inside the source', () => {
    const result = check(source)
    const inside = (offset: number) => offset >= 0 && offset < source.length
    expect(result.errors.length).toBeGreaterThan(0)
    for (const e of [...result.errors, ...result.warnings]) expect(inside(e.offset)).toBe(true)
    for (const [def, refs] of result.references) {
      expect(inside(def)).toBe(true)
      for (const ref of refs) expect(inside(ref)).toBe(true)
    }
    for (const [use, def] of result.symbolRefs) {
      expect(inside(use)).toBe(true)
      expect(inside(def)).toBe(true)
    }
    for (const [, def] of result.symbolDefOffsets) expect(inside(def)).toBe(true)
  })

  test('a helper only a generic body calls is used; an instance is not a definition', () => {
    const result = check(source)
    expect(result.warnings.map(w => w.message)).toEqual([])
    expect([...result.symbolDefOffsets.keys()].filter(name => name.includes('<'))).toEqual([])
    const twice = result.symbolDefOffsets.get('twice') as number
    expect(result.references.get(twice)).toEqual([source.indexOf('twice(1)')])
  })

  test('what a generic names is used by it, also when nothing in the module instantiates it', () => {
    // A module that exports its generics has no instance of them.
    const library = `type Pt = (q: i32, r: i32)
global calls: u32 = 0
func helper(a: u32) -> u32 => a + 1
func inner(comptime T: type, a: T) -> T => a
export func outer(comptime T: type, a: T) -> u32 {
  calls += 1
  let p: Pt = (q: 1, r: 2)
  return helper(sizeof(T)) + (inner(a) as u32)
}
func shadows(comptime T: type, helper2: T) -> T {
  let unused_plain = helper2
  return unused_plain
}
func helper2(a: u32) -> u32 => a
func unused_plain(a: u32) -> u32 => a`
    const result = check(library)
    expect(result.errors).toEqual([])
    // A name the generic declares itself is not the module's.
    expect(result.warnings.map(w => w.message)).toEqual([
      "'shadows' is never used",
      "'helper2' is never used",
      "'unused_plain' is never used",
    ])
    const pt = result.symbolDefOffsets.get('Pt') as number
    expect(result.references.get(pt)).toEqual([library.indexOf('Pt = (q: 1')])
  })

  test('the callee of a call holds the signature of its instance', () => {
    const result = check(source)
    const at = source.indexOf('count(xs, 7)')
    const callee = [...result.exprTypes.keys()].filter(e => e.kind === 'IdentExpr' && e.span.start === at)
    expect(callee.length).toBe(1)
    const type = result.exprTypes.get(callee[0])
    expect(type?.kind).toBe('func')
    if (type?.kind !== 'func') return
    expect(type.params.map(p => p.name)).toEqual(['xs', 'x'])
    expect(type.params[1].type).toEqual({ kind: 'primitive', name: 'u8' })
  })
})

// === What a generic compiles to ===

// The names of the functions of a module, in the order they are emitted.
function funcs(wat: string): string[] {
  return [...wat.matchAll(/^\s*\(func \$(\S+)/gm)].map(m => m[1])
}

// The text of one function.
function funcWat(wat: string, name: string): string {
  const start = wat.indexOf(`(func $${name} `)
  if (start < 0) throw new Error(`no function ${name} in\n${wat}`)
  const next = wat.indexOf('\n  (', start + 1)
  return wat.slice(start, next < 0 ? undefined : next)
}

// Generics are compile-time only: no function tables, no indirect calls.
function expectPlainWasm(wat: string): void {
  for (const forbidden of ['call_indirect', '(table', '(elem', 'ref.func', 'funcref']) {
    expect(wat).not.toContain(forbidden)
  }
}

// The functions that differ between two WATs, with function names replaced by
// their position so that a generic's instances and hand-written functions of
// other names compare equal.
function watDifference(a: string, b: string): string {
  const numbered = (wat: string) => {
    const names = funcs(wat)
    let text = wat
    for (const name of [...names].sort((x, y) => y.length - x.length)) {
      text = text.split(`$${name}`).join(`$f${names.indexOf(name)}`)
    }
    return text.split(/\n(?= {2}\(func )/)
  }
  const [fa, fb] = [numbered(a), numbered(b)]
  const out: string[] = []
  for (let i = 0; i < Math.max(fa.length, fb.length); i++) {
    if (fa[i] !== fb[i]) out.push(`--- generic\n${fa[i] ?? '(nothing)'}\n--- by hand\n${fb[i] ?? '(nothing)'}`)
  }
  return out.join('\n')
}

// A generic program and the same program written out by hand are the same
// .wasm file. Both assemblers are held to it: moduleToWat, which compiles one
// module in memory, and programToWat, which the command line uses.
async function expectSameWasm(generic: string, byHand: string): Promise<Uint8Array> {
  const [watG, watH] = [watOfSource(generic), watOfSource(byHand)]
  expectPlainWasm(watG)
  const [wasmG, wasmH] = [await wasmOfWat(watG), await wasmOfWat(watH)]
  if (!Buffer.from(wasmG).equals(Buffer.from(wasmH))) {
    throw new Error(`the generic program and the hand-written one differ:\n${watDifference(watG, watH)}`)
  }

  const dir = await mkdtemp(join(tmpdir(), 'encantis-generics-'))
  try {
    await writeFile(join(dir, 'generic.ents'), generic)
    await writeFile(join(dir, 'byhand.ents'), byHand)
    const programG = await compileToWasm(join(dir, 'generic.ents'))
    const programH = await compileToWasm(join(dir, 'byhand.ents'))
    expect(Buffer.from(programG).equals(Buffer.from(programH))).toBe(true)
  } finally {
    await rm(dir, { recursive: true })
  }
  return wasmG
}

async function run(source: string): Promise<Record<string, (...args: (number | bigint)[]) => unknown>> {
  const instance = await WebAssembly.instantiate(await WebAssembly.compile(await wasmOfSource(source)))
  return instance.exports as Record<string, (...args: (number | bigint)[]) => unknown>
}

const DOC_GENERIC = `func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }

export func widest(a: u32, b: u32) -> u32 => max(u32, a, b)
export func longest(a: f64, b: f64) -> f64 => max(a, b)
`

const DOC_BY_HAND = `func max_f64(a: f64, b: f64) -> f64 => if a > b { a } else { b }
func max_u32(a: u32, b: u32) -> u32 => if a > b { a } else { b }

export func widest(a: u32, b: u32) -> u32 => max_u32(a, b)
export func longest(a: f64, b: f64) -> f64 => max_f64(a, b)
`

// Explicit and inferred calls, a generic calling generics, *mut T, []T with a
// named result, a u128 instance (which needs a wide-integer helper), and an
// unused generic whose body could never check.
const Z1_GENERIC = `func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }
func min(comptime T: type, a: T, b: T) -> T => if a < b { a } else { b }
func clamp(comptime T: type, x: T, lo: T, hi: T) -> T => min(max(x, lo), hi)

func swap(comptime T: type, a: *mut T, b: *mut T) {
  let tmp = a.*
  a.* = b.*
  b.* = tmp
}

func sum(comptime T: type, xs: []T) -> (total: T) {
  total = 0
  for v in xs {
    total += v
  }
}

func unused(comptime T: type, x: T) -> T => nothing(x)

export func max_u32(a: u32, b: u32) -> u32 => max(a, b)
export func max_f64(a: f64, b: f64) -> f64 => max(f64, a, b)
export func clamp_i32(x: i32, lo: i32, hi: i32) -> i32 => clamp(x, lo, hi)
export func swap_u64(a: *mut u64, b: *mut u64) { swap(a, b) }
export func sum_u8(xs: []u8) -> u8 => sum(xs)
export func sum_u128(xs: []u128) -> u128 => sum(u128, xs)
`

// Each generic's place is taken by its instances in the order of their names:
// max<f64>, max<i32>, max<u32>; sum<u128>, sum<u8>.
const Z1_BY_HAND = `func max_f64_(a: f64, b: f64) -> f64 => if a > b { a } else { b }
func max_i32_(a: i32, b: i32) -> i32 => if a > b { a } else { b }
func max_u32_(a: u32, b: u32) -> u32 => if a > b { a } else { b }
func min_i32_(a: i32, b: i32) -> i32 => if a < b { a } else { b }
func clamp_i32_(x: i32, lo: i32, hi: i32) -> i32 => min_i32_(max_i32_(x, lo), hi)

func swap_u64_(a: *mut u64, b: *mut u64) {
  let tmp = a.*
  a.* = b.*
  b.* = tmp
}

func sum_u128_(xs: []u128) -> (total: u128) {
  total = 0
  for v in xs {
    total += v
  }
}

func sum_u8_(xs: []u8) -> (total: u8) {
  total = 0
  for v in xs {
    total += v
  }
}

export func max_u32(a: u32, b: u32) -> u32 => max_u32_(a, b)
export func max_f64(a: f64, b: f64) -> f64 => max_f64_(a, b)
export func clamp_i32(x: i32, lo: i32, hi: i32) -> i32 => clamp_i32_(x, lo, hi)
export func swap_u64(a: *mut u64, b: *mut u64) { swap_u64_(a, b) }
export func sum_u8(xs: []u8) -> u8 => sum_u8_(xs)
export func sum_u128(xs: []u128) -> u128 => sum_u128_(xs)
`

describe('zero cost', () => {
  // Z1. The sizes are those of the hand-written sides compiled by 0.2.1, and
  // by the stack of fixes this branch now stands on.
  test('the example of the reference is the module written by hand, byte for byte', async () => {
    expect(await expectSameWasm(DOC_GENERIC, DOC_BY_HAND)).toHaveLength(105)
  })

  test('a larger program is the module written by hand, byte for byte', async () => {
    expect(await expectSameWasm(Z1_GENERIC, Z1_BY_HAND)).toHaveLength(525)
  })

  test('data literals in a generic body are laid out as in the functions written by hand', async () => {
    const generic = `data first = "first"
func greet(comptime T: type, x: T) -> []u8 => if x > 0 { "hello" } else { "bye" }
func name(comptime T: type) -> []u8 => "name"
export func a() -> []u8 => greet(u32, 1)
export func b() -> []u8 => "world!"
export func c() -> []u8 => greet(7:u8)
export func d() -> []u8 => name(u8)
func tail(comptime T: type, x: T) -> []u8 => "tail"
export func e() -> []u8 => tail(a().len)
export func f() -> u8 => first.*[0]
`
    const byHand = `data first = "first"
func greet_u32(x: u32) -> []u8 => if x > 0 { "hello" } else { "bye" }
func greet_u8(x: u8) -> []u8 => if x > 0 { "hello" } else { "bye" }
func name_u8() -> []u8 => "name"
export func a() -> []u8 => greet_u32(1)
export func b() -> []u8 => "world!"
export func c() -> []u8 => greet_u8(7:u8)
export func d() -> []u8 => name_u8()
func tail_u32(x: u32) -> []u8 => "tail"
export func e() -> []u8 => tail_u32(a().len)
export func f() -> u8 => first.*[0]
`
    await expectSameWasm(generic, byHand)
  })

  test('a type parameter in every position a type can be written', async () => {
    const generic = `data room = mut [0:u8; 64]

func store(comptime T: type, at: u32, x: T) -> *mut T {
  let p = ((room as u32) + at * sizeof(T)) as *mut T
  let copy: T = x
  p.* = copy
  return p
}
func load(comptime T: type, at: u32) -> T => (room as [*]T)[at]
func widen(comptime T: type, n: u8) -> T => (n as T) + 1:T
func window(comptime T: type, n: u32) -> []mut T => (room as [*]mut T)[0..n]
func total(comptime T: type, n: u32) -> (sum: T) {
  let xs: []T = window(T, n)
  sum = 0
  for x in xs {
    sum += x
  }
}

export func a(x: u16) -> u16 => store(u16, 3, x).* + load(u16, 3)
export func b(x: f64) -> f64 => store(1, x).* + load(f64, 1)
export func c(n: u8) -> u64 => widen(u64, n) + (widen(i32, n) as u64)
export func d(n: u32) -> u32 => total(u32, n) + window(u8, n).len
`
    const byHand = `data room = mut [0:u8; 64]

func store_f64(at: u32, x: f64) -> *mut f64 {
  let p = ((room as u32) + at * sizeof(f64)) as *mut f64
  let copy: f64 = x
  p.* = copy
  return p
}
func store_u16(at: u32, x: u16) -> *mut u16 {
  let p = ((room as u32) + at * sizeof(u16)) as *mut u16
  let copy: u16 = x
  p.* = copy
  return p
}
func load_f64(at: u32) -> f64 => (room as [*]f64)[at]
func load_u16(at: u32) -> u16 => (room as [*]u16)[at]
func widen_i32(n: u8) -> i32 => (n as i32) + 1:i32
func widen_u64(n: u8) -> u64 => (n as u64) + 1:u64
func window_u32(n: u32) -> []mut u32 => (room as [*]mut u32)[0..n]
func window_u8(n: u32) -> []mut u8 => (room as [*]mut u8)[0..n]
func total_u32(n: u32) -> (sum: u32) {
  let xs: []u32 = window_u32(n)
  sum = 0
  for x in xs {
    sum += x
  }
}

export func a(x: u16) -> u16 => store_u16(3, x).* + load_u16(3)
export func b(x: f64) -> f64 => store_f64(1, x).* + load_f64(1)
export func c(n: u8) -> u64 => widen_u64(n) + (widen_i32(n) as u64)
export func d(n: u32) -> u32 => total_u32(n) + window_u8(n).len
`
    await expectSameWasm(generic, byHand)
    const exports = await run(generic)
    expect(exports.a(7)).toBe(14)
    expect(exports.b(1.5)).toBe(3)
    expect(exports.c(4)).toBe(10n)
  })

  test('a mutable literal in a generic body is one buffer per instance', async () => {
    const generic = `func cell(comptime T: type, x: T) -> *mut T {
  let p = &0:T
  p.* = x
  return p
}
export func a() -> *mut u32 => cell(u32, 1)
export func b() -> *mut u64 => cell(u64, 2)
`
    const byHand = `func cell_u32(x: u32) -> *mut u32 {
  let p = &0:u32
  p.* = x
  return p
}
func cell_u64(x: u64) -> *mut u64 {
  let p = &0:u64
  p.* = x
  return p
}
export func a() -> *mut u32 => cell_u32(1)
export func b() -> *mut u64 => cell_u64(2)
`
    await expectSameWasm(generic, byHand)
    const exports = await run(generic)
    expect(exports.a()).not.toBe(exports.b())
  })

  test('the literals of instances are laid out in the order of the instances, not of the calls', async () => {
    // Asked for as u8, f64, i16; emitted, like the functions, as f64, i16, u8.
    const generic = `func scratch(comptime T: type, x: T) -> *mut [4]u8 => mut "abcd"
export func s1() -> *mut [4]u8 => scratch(1:u8)
export func s2() -> *mut [4]u8 => scratch(1.5:f64)
export func s3() -> *mut [4]u8 => scratch(1:i16)
`
    const byHand = `func scratch_f64(x: f64) -> *mut [4]u8 => mut "abcd"
func scratch_i16(x: i16) -> *mut [4]u8 => mut "abcd"
func scratch_u8(x: u8) -> *mut [4]u8 => mut "abcd"
export func s1() -> *mut [4]u8 => scratch_u8(1:u8)
export func s2() -> *mut [4]u8 => scratch_f64(1.5:f64)
export func s3() -> *mut [4]u8 => scratch_i16(1:i16)
`
    await expectSameWasm(generic, byHand)
    const exports = await run(generic)
    expect([exports.s2(), exports.s3(), exports.s1()]).toEqual([8, 12, 16])
  })

  test('a pointer or slice type that is only measured gives the module no memory', async () => {
    const generic = `func size(comptime T: type) -> u32 => sizeof(T)
export func f() -> u32 => size(*u8) + size([]u8) + sizeof(*u32)
`
    const byHand = `func size_slice() -> u32 => sizeof([]u8)
func size_pointer() -> u32 => sizeof(*u8)
export func f() -> u32 => size_pointer() + size_slice() + sizeof(*u32)
`
    expect(watOfSource(generic)).not.toContain('(memory')
    await expectSameWasm(generic, byHand)
  })

  test('a literal in the argument that decides T keeps its place among the literals of the call', async () => {
    // The look at &7:u32 comes before "x" is checked. What it registered must
    // go, or 7 would be laid out before "x" and every address would differ.
    const generic = `func pair(comptime T: type, s: []u8, p: *mut T) -> u32 => s.len + (p as u32)
export func f() -> u32 => pair("x", &7:u32) + pair("yz", &9:u32)
`
    const byHand = `func pair_u32(s: []u8, p: *mut u32) -> u32 => s.len + (p as u32)
export func f() -> u32 => pair_u32("x", &7:u32) + pair_u32("yz", &9:u32)
`
    await expectSameWasm(generic, byHand)
  })

  test('the address of a literal passed for a read-only *T is shared, as for a hand-written function', async () => {
    // Inferring T looks at &7:u32 before it is known to be read-only. That
    // look must not leave the literal marked as a cell of its own.
    const generic = `func load(comptime T: type, p: *T) -> T => p.*
export func a() -> u32 => load(&7:u32) + load(&7:u32)
export func b() -> u64 => load(&9:u64) + load(u64, &9:u64)
`
    const byHand = `func load_u32(p: *u32) -> u32 => p.*
func load_u64(p: *u64) -> u64 => p.*
export func a() -> u32 => load_u32(&7:u32) + load_u32(&7:u32)
export func b() -> u64 => load_u64(&9:u64) + load_u64(&9:u64)
`
    await expectSameWasm(generic, byHand)
  })

  // Z3
  test('a generic nobody calls leaves no trace', async () => {
    const program = `data greeting = "hi"
export func double(x: u32) -> u32 => x * 2
export func first() -> u8 => greeting.*[0]
`
    const withUnused = `func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }
${program}func fill(comptime T: type, xs: []mut T, x: T) {
  let p = xs.ptr
  for i in xs.len {
    p[i] = x
  }
}
export func never(comptime T: type, x: T) -> []u8 => "never"
`
    await expectSameWasm(withUnused, program)
    expect(funcs(watOfSource(withUnused))).toEqual(['double', 'first'])
  })

  // Z4
  test('one instance, however the same type argument arrives', () => {
    const wat = watOfSource(`type Pt = (q: i32, r: i32)
func pick(comptime T: type, first: bool, a: T, b: T) -> T => if first { a } else { b }
export func a(c: bool, p: Pt, q: Pt) -> Pt => pick(c, p, q)
export func b(c: bool, p: (q: i32, r: i32), q: (q: i32, r: i32)) -> Pt => pick(c, p, q)
export func c(c: bool, p: Pt, q: Pt) -> Pt => pick((q: i32, r: i32), c, pick(Pt, c, p, q), q)
`)
    expect(funcs(wat)).toEqual(['pick<<q:i32|r:i32>>', 'a', 'b', 'c'])
    expectPlainWasm(wat)
  })

  // Z6
  test('an instance has the non-comptime parameters, flattened, and a call passes exactly those', () => {
    const wat = watOfSource(`type Pt = (q: i32, r: i32)
func pick(comptime T: type, first: bool, a: T, b: T) -> T => if first { a } else { b }
func head(comptime T: type, xs: []T) -> T => xs.ptr[0]
export func a(c: bool, p: Pt, q: Pt) -> Pt => pick(Pt, c, p, q)
export func b(xs: []f64) -> f64 => head(xs)
`)
    expect(funcWat(wat, 'pick<<q:i32|r:i32>>')).toStartWith(
      '(func $pick<<q:i32|r:i32>> (param $first i32) (param $a_q i32) (param $a_r i32) (param $b_q i32) (param $b_r i32) (result i32 i32)',
    )
    expect(funcWat(wat, 'a')).toContain(
      '(call $pick<<q:i32|r:i32>> (local.get $c) (local.get $p_q) (local.get $p_r) (local.get $q_q) (local.get $q_r))',
    )
    expect(funcWat(wat, 'head<f64>')).toStartWith('(func $head<f64> (param $xs_ptr i32) (param $xs_len i32) (result f64)')
    expect(funcWat(wat, 'b')).toContain('(call $head<f64> (local.get $xs_ptr) (local.get $xs_len))')
  })

  // Z7
  test('an instance only a test asks for is in test builds only', async () => {
    const source = `func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }
export func f(a: u32) -> u32 => max(a, 1)
test "wide" {
  assert max(i64, -1, 5) == 5
}
`
    expect(funcs(watOfSource(source))).toEqual(['max<u32>', 'f'])

    const dir = await mkdtemp(join(tmpdir(), 'encantis-generics-'))
    try {
      const path = join(dir, 'tested.ents')
      await writeFile(path, source)
      const load = await loadModule(path, { includeTests: true })
      const check = typecheckProgram(load.modules, path, { includeTests: true })
      expect(check.errors).toEqual([])
      const { wat } = programToWatWithTests(load.modules, check.results, path)
      expect(funcs(wat)).toEqual(['max<i64>', 'max<u32>', 'f', 'test_wide'])
      await wasmOfWat(wat)
    } finally {
      await rm(dir, { recursive: true })
    }
  })
})

// What the stack of compiler fixes added (implicit conversions recorded by
// node, values loaded from and stored to memory by their type, scratch locals
// of its own) is new ground for the claim. Each pair is a program that leans
// on one of those and the same program written by hand.
describe('zero cost, on what the fix branches added', () => {
  test('a widened argument, at the call and inside the instance', async () => {
    const generic = `func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }
func scale(comptime T: type, x: T, by: u32) -> T => x * by
export func a(x: u64, y: u32) -> u64 => max(x, y)
export func b(x: f64, y: f32, n: u32) -> f64 => max(x, y) + scale(x, n)
export func c(x: i64, y: u8) -> i64 => scale(max(i64, x, y), y)
export func d(x: u128, y: u64) -> u128 => max(x, y)
`
    const byHand = `func max_f64(a: f64, b: f64) -> f64 => if a > b { a } else { b }
func max_i64(a: i64, b: i64) -> i64 => if a > b { a } else { b }
func max_u128(a: u128, b: u128) -> u128 => if a > b { a } else { b }
func max_u64(a: u64, b: u64) -> u64 => if a > b { a } else { b }
func scale_f64(x: f64, by: u32) -> f64 => x * by
func scale_i64(x: i64, by: u32) -> i64 => x * by
export func a(x: u64, y: u32) -> u64 => max_u64(x, y)
export func b(x: f64, y: f32, n: u32) -> f64 => max_f64(x, y) + scale_f64(x, n)
export func c(x: i64, y: u8) -> i64 => scale_i64(max_i64(x, y), y)
export func d(x: u128, y: u64) -> u128 => max_u128(x, y)
`
    await expectSameWasm(generic, byHand)
    const exports = await run(generic)
    expect(exports.a(5n, 7)).toBe(7n)
    expect(exports.b(1.5, 2.5, 2)).toBe(5.5)
    expect(exports.c(-5n, 3)).toBe(9n)
    expect(exports.d(0n, 1n, 5n)).toEqual([0n, 1n])
  })

  test('an instance over a struct that is loaded from and stored to memory', async () => {
    const generic = `type Spot = (c: i32, di: i32, room: i32)
type Mixed = (a: u8, b: i16, c: u64, d: f32)
data space = mut [0:u8; 256]

func cell(comptime T: type, i: u32) -> *mut T => ((space as u32) + i * sizeof(T)) as *mut T
func load(comptime T: type, p: *T) -> T => p.*
func store(comptime T: type, p: *mut T, v: T) { p.* = v }
func swap(comptime T: type, a: *mut T, b: *mut T) {
  let tmp = a.*
  a.* = b.*
  b.* = tmp
}
func put(comptime T: type, list: [*]mut T, i: u32, v: T) { list[i] = v }
func get(comptime T: type, list: [*]T, i: u32) -> T => list[i]

export func spot(i: u32, j: u32) -> i32 {
  store(cell(Spot, i), Spot(1, 2, 3))
  store(Spot, cell(Spot, j), Spot(4, 5, 6))
  swap(cell(Spot, i), cell(Spot, j))
  let s = load(cell(Spot, i))
  put(space as [*]mut Spot, 7, s)
  return get(space as [*]Spot, 7).room + s.c
}
export func mixed(i: u32) -> u64 {
  store(cell(Mixed, i), Mixed(1, -2, 3, 0.5))
  swap(cell(Mixed, i), cell(Mixed, i + 1))
  let m = load(cell(Mixed, i + 1))
  return m.c + (m.a as u64)
}
`
    const byHand = `type Spot = (c: i32, di: i32, room: i32)
type Mixed = (a: u8, b: i16, c: u64, d: f32)
data space = mut [0:u8; 256]

func cell_mixed(i: u32) -> *mut Mixed => ((space as u32) + i * sizeof(Mixed)) as *mut Mixed
func cell_spot(i: u32) -> *mut Spot => ((space as u32) + i * sizeof(Spot)) as *mut Spot
func load_mixed(p: *Mixed) -> Mixed => p.*
func load_spot(p: *Spot) -> Spot => p.*
func store_mixed(p: *mut Mixed, v: Mixed) { p.* = v }
func store_spot(p: *mut Spot, v: Spot) { p.* = v }
func swap_mixed(a: *mut Mixed, b: *mut Mixed) {
  let tmp = a.*
  a.* = b.*
  b.* = tmp
}
func swap_spot(a: *mut Spot, b: *mut Spot) {
  let tmp = a.*
  a.* = b.*
  b.* = tmp
}
func put_spot(list: [*]mut Spot, i: u32, v: Spot) { list[i] = v }
func get_spot(list: [*]Spot, i: u32) -> Spot => list[i]

export func spot(i: u32, j: u32) -> i32 {
  store_spot(cell_spot(i), Spot(1, 2, 3))
  store_spot(cell_spot(j), Spot(4, 5, 6))
  swap_spot(cell_spot(i), cell_spot(j))
  let s = load_spot(cell_spot(i))
  put_spot(space as [*]mut Spot, 7, s)
  return get_spot(space as [*]Spot, 7).room + s.c
}
export func mixed(i: u32) -> u64 {
  store_mixed(cell_mixed(i), Mixed(1, -2, 3, 0.5))
  swap_mixed(cell_mixed(i), cell_mixed(i + 1))
  let m = load_mixed(cell_mixed(i + 1))
  return m.c + (m.a as u64)
}
`
    await expectSameWasm(generic, byHand)
    expect((await run(generic)).spot(0, 1)).toBe(10)
    expect((await run(generic)).mixed(2)).toBe(4n)
  })

  test('a []T of structs with an element loop, and a bool field in memory', async () => {
    const generic = `type Spot = (c: i32, di: i32, room: i32)
type Seat = (room: i32, taken: bool)
data space = mut [0:u8; 256]

func rooms(comptime T: type, xs: []T) -> (n: i32) {
  n = 0
  for v in xs {
    n += v.room
  }
}
func last(comptime T: type, xs: []T, or: T) -> T {
  let found = or
  for i, v in xs {
    if i > 0 { found = v }
  }
  return found
}
func fill(comptime T: type, xs: []mut T, v: T) {
  let p = xs.ptr
  for i in xs.len {
    p[i] = v
  }
}
func count(comptime T: type, xs: []T, x: T) -> u32 {
  let n: u32 = 0
  for v in xs {
    if v == x { n += 1 }
  }
  return n
}
func load(comptime T: type, p: *T) -> T => p.*
func store(comptime T: type, p: *mut T, v: T) { p.* = v }

export func spots(n: u32) -> i32 {
  let xs: []mut Spot = (space as [*]mut Spot, n)
  fill(xs, Spot(1, 2, 3))
  return rooms(xs) + last(xs, Spot(0, 0, 0)).di
}
export func seats(n: u32) -> i32 {
  let xs: []mut Seat = (space as [*]mut Seat, n)
  fill(xs, Seat(7, true))
  let s = last(Seat, xs, Seat(0, false))
  return if s.taken { rooms(xs) } else { 0 }
}
export func seat(room: i32, taken: bool) -> bool {
  let p = space as *mut Seat
  store(p, Seat(room, taken))
  p.taken = !load(p).taken
  return load(p).taken
}
export func flags(n: u32) -> u32 {
  let xs: []mut bool = (space as [*]mut bool, n)
  store(space as *mut bool, true)
  fill(xs[1..] ?? xs, false)
  return count(xs, true) * 100 + count(bool, xs, false)
}
`
    const byHand = `type Spot = (c: i32, di: i32, room: i32)
type Seat = (room: i32, taken: bool)
data space = mut [0:u8; 256]

func rooms_spot(xs: []Spot) -> (n: i32) {
  n = 0
  for v in xs {
    n += v.room
  }
}
func rooms_seat(xs: []Seat) -> (n: i32) {
  n = 0
  for v in xs {
    n += v.room
  }
}
func last_spot(xs: []Spot, or: Spot) -> Spot {
  let found = or
  for i, v in xs {
    if i > 0 { found = v }
  }
  return found
}
func last_seat(xs: []Seat, or: Seat) -> Seat {
  let found = or
  for i, v in xs {
    if i > 0 { found = v }
  }
  return found
}
func fill_spot(xs: []mut Spot, v: Spot) {
  let p = xs.ptr
  for i in xs.len {
    p[i] = v
  }
}
func fill_seat(xs: []mut Seat, v: Seat) {
  let p = xs.ptr
  for i in xs.len {
    p[i] = v
  }
}
func fill_bool(xs: []mut bool, v: bool) {
  let p = xs.ptr
  for i in xs.len {
    p[i] = v
  }
}
func count_bool(xs: []bool, x: bool) -> u32 {
  let n: u32 = 0
  for v in xs {
    if v == x { n += 1 }
  }
  return n
}
func load_seat(p: *Seat) -> Seat => p.*
func store_seat(p: *mut Seat, v: Seat) { p.* = v }
func store_bool(p: *mut bool, v: bool) { p.* = v }

export func spots(n: u32) -> i32 {
  let xs: []mut Spot = (space as [*]mut Spot, n)
  fill_spot(xs, Spot(1, 2, 3))
  return rooms_spot(xs) + last_spot(xs, Spot(0, 0, 0)).di
}
export func seats(n: u32) -> i32 {
  let xs: []mut Seat = (space as [*]mut Seat, n)
  fill_seat(xs, Seat(7, true))
  let s = last_seat(xs, Seat(0, false))
  return if s.taken { rooms_seat(xs) } else { 0 }
}
export func seat(room: i32, taken: bool) -> bool {
  let p = space as *mut Seat
  store_seat(p, Seat(room, taken))
  p.taken = !load_seat(p).taken
  return load_seat(p).taken
}
export func flags(n: u32) -> u32 {
  let xs: []mut bool = (space as [*]mut bool, n)
  store_bool(space as *mut bool, true)
  fill_bool(xs[1..] ?? xs, false)
  return count_bool(xs, true) * 100 + count_bool(xs, false)
}
`
    await expectSameWasm(generic, byHand)
    const exports = await run(generic)
    expect(exports.spots(3)).toBe(11)
    expect(exports.seats(2)).toBe(14)
    expect(exports.seat(5, 1)).toBe(0)
    expect(exports.seat(5, 0)).toBe(1)
    expect(exports.flags(4)).toBe(103)
  })

  // A match subject and the operands of an integer min, max and abs are kept
  // in locals named after their place in the source, and an address that is
  // used twice in a local the function numbers. In an instance the first kind
  // must not carry the instance's private offsets.
  test('scratch locals, a global of several values and an element read with a fallback', async () => {
    const generic = `type Spot = (c: i32, di: i32, room: i32)
data table = [3:u32, 1, 4, 1, 5]
data space = mut [0:u8; 64]
global saved: Spot = Spot(0, 0, 0)
global calls: u32 = 0

func bucket(comptime T: type, x: T, y: T) -> i32 => match (x + y) / 2 {
  0 => 0
  1 => 10
  _ => -1
}
func spread(comptime T: type, a: T, b: T, c: T) -> T => max(a + b, b + c) - min(a * b, abs(c - a))
func pick(comptime T: type, xs: []T, i: u32, fallback: T) -> T => xs[i] ?? fallback
func keep(comptime T: type, v: T) -> T {
  calls += 1
  saved = v
  return saved
}
func first(comptime T: type, xs: []T, fallback: T) -> T {
  if let v = xs[0] { return v }
  return fallback
}
func bump(comptime T: type, p: *mut T, by: T) {
  p.* += by
  p.* <<= 1
}

export func a(x: u32, y: u32) -> i32 => bucket(x, y) + bucket(u8, 3, 1)
export func b(x: i32, y: i64) -> i64 => (spread(x, 2, 3) as i64) + spread(y, 2, 3)
export func c(i: u32) -> u32 => pick(table, i, 9) + first(table[i..] ?? table[0..1], 7)
export func d(n: i32) -> i32 {
  let list: []mut Spot = (space as [*]mut Spot, 2:u32)
  list.ptr[1] = keep(Spot(n, 2, 3))
  return pick(list, 1, saved).c + first(Spot, list, saved).room
}
export func e(v: u64) -> u64 {
  let p = space as *mut u64
  bump(p, v)
  bump(space as *mut u16, 3)
  return p.*
}
`
    const byHand = `type Spot = (c: i32, di: i32, room: i32)
data table = [3:u32, 1, 4, 1, 5]
data space = mut [0:u8; 64]
global saved: Spot = Spot(0, 0, 0)
global calls: u32 = 0

func bucket_u32(x: u32, y: u32) -> i32 => match (x + y) / 2 {
  0 => 0
  1 => 10
  _ => -1
}
func bucket_u8(x: u8, y: u8) -> i32 => match (x + y) / 2 {
  0 => 0
  1 => 10
  _ => -1
}
func spread_i32(a: i32, b: i32, c: i32) -> i32 => max(a + b, b + c) - min(a * b, abs(c - a))
func spread_i64(a: i64, b: i64, c: i64) -> i64 => max(a + b, b + c) - min(a * b, abs(c - a))
func pick_spot(xs: []Spot, i: u32, fallback: Spot) -> Spot => xs[i] ?? fallback
func pick_u32(xs: []u32, i: u32, fallback: u32) -> u32 => xs[i] ?? fallback
func keep_spot(v: Spot) -> Spot {
  calls += 1
  saved = v
  return saved
}
func first_spot(xs: []Spot, fallback: Spot) -> Spot {
  if let v = xs[0] { return v }
  return fallback
}
func first_u32(xs: []u32, fallback: u32) -> u32 {
  if let v = xs[0] { return v }
  return fallback
}
func bump_u16(p: *mut u16, by: u16) {
  p.* += by
  p.* <<= 1
}
func bump_u64(p: *mut u64, by: u64) {
  p.* += by
  p.* <<= 1
}

export func a(x: u32, y: u32) -> i32 => bucket_u32(x, y) + bucket_u8(3, 1)
export func b(x: i32, y: i64) -> i64 => (spread_i32(x, 2, 3) as i64) + spread_i64(y, 2, 3)
export func c(i: u32) -> u32 => pick_u32(table, i, 9) + first_u32(table[i..] ?? table[0..1], 7)
export func d(n: i32) -> i32 {
  let list: []mut Spot = (space as [*]mut Spot, 2:u32)
  list.ptr[1] = keep_spot(Spot(n, 2, 3))
  return pick_spot(list, 1, saved).c + first_spot(list, saved).room
}
export func e(v: u64) -> u64 {
  let p = space as *mut u64
  bump_u64(p, v)
  bump_u16(space as *mut u16, 3)
  return p.*
}
`
    await expectSameWasm(generic, byHand)
    expect((await run(generic)).a(1, 1)).toBe(9)
    expect((await run(generic)).b(1, 1n)).toBe(6n)
    expect((await run(generic)).c(0)).toBe(6)
    expect((await run(generic)).c(9)).toBe(12)
    expect((await run(generic)).d(5)).toBe(5)
    expect((await run(generic)).e(5n)).toBe(26n)
    // The names are those of the generic's source, the same in each instance.
    const wat = watOfSource(generic)
    const scratch = (name: string) => [...funcWat(wat, name).matchAll(/\(local (\$__[\w]+)/g)].map(m => m[1])
    expect(scratch('bucket<u32>').length).toBeGreaterThan(0)
    expect(scratch('bucket<u8>')).toEqual(scratch('bucket<u32>'))
    expect(scratch('spread<i32>').length).toBeGreaterThan(0)
    expect(scratch('spread<i64>')).toEqual(scratch('spread<i32>'))
    expect(scratch('pick<u32>').length).toBeGreaterThan(0)
  })

  // The argument that decides T is looked at once and then checked: what the
  // look recorded for an inner call and its conversions must be gone, and
  // what the check records must be there, at every level of nesting.
  test('calls nested in the argument that decides, each with an argument that is widened', async () => {
    const generic = `func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }
func min2(comptime T: type, a: T, b: T) -> T => if a < b { a } else { b }
func mid(comptime T: type, a: T, b: T, c: T) -> T => max(min2(a, b), min2(max(a, b), c))
export func f(a: u64, b: u32, c: u16) -> u64 => max(max(a, b), c)
export func g(a: u32, c: u16) -> u32 => max(max(a, c), c)
export func h(a: u64, b: u32, c: u8) -> u64 => mid(a + b, b, c)
export func i(a: i16, b: i8) -> i32 => mid(i32, a, b, a + b)
export func j(a: u32, b: u16) -> u64 => max(a, b)
`
    const byHand = `func max_i32(a: i32, b: i32) -> i32 => if a > b { a } else { b }
func max_u32(a: u32, b: u32) -> u32 => if a > b { a } else { b }
func max_u64(a: u64, b: u64) -> u64 => if a > b { a } else { b }
func min2_i32(a: i32, b: i32) -> i32 => if a < b { a } else { b }
func min2_u64(a: u64, b: u64) -> u64 => if a < b { a } else { b }
func mid_i32(a: i32, b: i32, c: i32) -> i32 => max_i32(min2_i32(a, b), min2_i32(max_i32(a, b), c))
func mid_u64(a: u64, b: u64, c: u64) -> u64 => max_u64(min2_u64(a, b), min2_u64(max_u64(a, b), c))
export func f(a: u64, b: u32, c: u16) -> u64 => max_u64(max_u64(a, b), c)
export func g(a: u32, c: u16) -> u32 => max_u32(max_u32(a, c), c)
export func h(a: u64, b: u32, c: u8) -> u64 => mid_u64(a + b, b, c)
export func i(a: i16, b: i8) -> i32 => mid_i32(a, b, a + b)
export func j(a: u32, b: u16) -> u64 => max_u32(a, b)
`
    await expectSameWasm(generic, byHand)
    const exports = await run(generic)
    // b is a u32: all its bits set is 4294967295, not -1.
    expect(exports.f(1n, -1, 3)).toBe(4294967295n)
    expect(exports.g(5, 9)).toBe(9)
    expect(exports.h(10n, 4, 7)).toBe(7n)
    expect(exports.i(-3, 5)).toBe(2)
    expect(exports.j(7, 9)).toBe(9n)
  })

  // One body, read with three type arguments: a let that widens its value
  // for one of them and not for another, a compound assignment through a
  // pointer, and a match whose subject is kept in a scratch local of the
  // instance's own wasm type.
  test('one body widens, assigns and matches differently in each instance', async () => {
    const generic = `data nums8 = [1:u8, 2, 3]
data nums64 = [1:u64, 2, 3]
data numsf = [1.5:f64, 2.5]
data cell = mut [0:u8; 16]
func accum(comptime T: type, xs: []T, seed: u8) -> T {
  let total: T = seed
  for x in xs { total += x }
  return total + seed
}
func bump(comptime T: type, p: *mut T, by: u8) -> T {
  p.* += by
  p.* *= by
  return p.*
}
func kind(comptime T: type, x: T, y: T) -> i32 => match x + y {
  0 => 0
  7 => 1
  _ => 2
}
export func a(s: u8) -> u8 => accum(nums8, s)
export func b(s: u8) -> u64 => accum(nums64, s)
export func c(s: u8) -> f64 => accum(numsf, s)
export func d(by: u8) -> u64 => bump(cell as *mut u64, by) + bump(cell as *mut u8, by) + bump(cell as *mut u16, by)
export func e(x: u64, y: u8) -> i32 => kind(x, y) + kind(y, y) + kind(i64, y, 3)
`
    const byHand = `data nums8 = [1:u8, 2, 3]
data nums64 = [1:u64, 2, 3]
data numsf = [1.5:f64, 2.5]
data cell = mut [0:u8; 16]
func accum_f64(xs: []f64, seed: u8) -> f64 {
  let total: f64 = seed
  for x in xs { total += x }
  return total + seed
}
func accum_u64(xs: []u64, seed: u8) -> u64 {
  let total: u64 = seed
  for x in xs { total += x }
  return total + seed
}
func accum_u8(xs: []u8, seed: u8) -> u8 {
  let total: u8 = seed
  for x in xs { total += x }
  return total + seed
}
func bump_u16(p: *mut u16, by: u8) -> u16 {
  p.* += by
  p.* *= by
  return p.*
}
func bump_u64(p: *mut u64, by: u8) -> u64 {
  p.* += by
  p.* *= by
  return p.*
}
func bump_u8(p: *mut u8, by: u8) -> u8 {
  p.* += by
  p.* *= by
  return p.*
}
func kind_i64(x: i64, y: i64) -> i32 => match x + y {
  0 => 0
  7 => 1
  _ => 2
}
func kind_u64(x: u64, y: u64) -> i32 => match x + y {
  0 => 0
  7 => 1
  _ => 2
}
func kind_u8(x: u8, y: u8) -> i32 => match x + y {
  0 => 0
  7 => 1
  _ => 2
}
export func a(s: u8) -> u8 => accum_u8(nums8, s)
export func b(s: u8) -> u64 => accum_u64(nums64, s)
export func c(s: u8) -> f64 => accum_f64(numsf, s)
export func d(by: u8) -> u64 => bump_u64(cell as *mut u64, by) + bump_u8(cell as *mut u8, by) + bump_u16(cell as *mut u16, by)
export func e(x: u64, y: u8) -> i32 => kind_u64(x, y) + kind_u8(y, y) + kind_i64(y, 3)
`
    await expectSameWasm(generic, byHand)
    const exports = await run(generic)
    expect(exports.a(1)).toBe(8)
    expect(exports.b(2)).toBe(10n)
    expect(exports.c(1)).toBe(6)
    // 3 squared as a u64; its low byte, 9, plus 3 times 3 as a u8; that
    // byte, 36, plus 3 times 3 as a u16.
    expect(exports.d(3)).toBe(162n)
    expect(exports.e(4n, 3)).toBe(5)
    expect(exports.e(0n, 0)).toBe(2)
    const wat = watOfSource(generic)
    expect(funcWat(wat, 'accum<u64>')).toContain('(local.set $total (i64.extend_i32_u (local.get $seed)))')
    expect(funcWat(wat, 'accum<f64>')).toContain('(local.set $total (f64.convert_i32_u (local.get $seed)))')
    expect(funcWat(wat, 'accum<u8>')).toContain('(local.set $total (local.get $seed))')
    const subject = (name: string) => funcWat(wat, name).match(/\(local \$__match_\d+ (i32|i64)\)/)?.[1]
    expect([subject('kind<u8>'), subject('kind<u64>'), subject('kind<i64>')]).toEqual(['i32', 'i64', 'i64'])
  })

  // The parser puts a def's value where the def is named. In an instance
  // those nodes are copies too, at the offsets of the def's own text moved
  // into the instance's range; the strings of an instance are laid out
  // among the module's data where the generic stands.
  test("a module's defs in a generic's body, and a struct with a bool through memory", async () => {
    const generic = `def limit = 10
def wide: u64 = 1 << 40
def cells = sizeof(u64) * 2 + 1
def half = 0.5
type Flag = (on: bool, n: u16, w: u64)
data space = mut [0:u8; 128]
data before = "before"
func clamp(comptime T: type, x: T) -> T => if x > limit { limit } else { x }
func stretch(comptime T: type, x: T) -> u64 => wide + x * cells
func name(comptime T: type, x: T) -> []u8 {
  let tag: []u8 = "tag"
  if x > limit { return "large" }
  return tag
}
func flip(comptime T: type, p: *mut T, f: Flag) -> Flag {
  let q = p as *mut Flag
  let old = q.*
  q.* = (on: !f.on, n: f.n + limit, w: wide)
  return old
}
func scaled(comptime T: type, x: T) -> f64 => x * half + limit
data after = "after"
export func a(x: u8, y: u64, z: i32) -> u64 => clamp(x) + clamp(y) + (clamp(z) as u64)
export func b(x: u8, y: u32) -> u64 => stretch(x) + stretch(y)
export func c(x: u16, y: i64) -> u32 => name(x).len + name(y).len + before.len + after.len
export func d(f: Flag) -> u64 {
  let was = flip(space as *mut Flag, f)
  let now = flip(space as *mut u64, was)
  return if now.on { now.w } else { now.n as u64 }
}
export func e(x: f32, y: u16) -> f64 => scaled(x) + scaled(y)
`
    const byHand = `def limit = 10
def wide: u64 = 1 << 40
def cells = sizeof(u64) * 2 + 1
def half = 0.5
type Flag = (on: bool, n: u16, w: u64)
data space = mut [0:u8; 128]
data before = "before"
func clamp_i32(x: i32) -> i32 => if x > limit { limit } else { x }
func clamp_u64(x: u64) -> u64 => if x > limit { limit } else { x }
func clamp_u8(x: u8) -> u8 => if x > limit { limit } else { x }
func stretch_u32(x: u32) -> u64 => wide + x * cells
func stretch_u8(x: u8) -> u64 => wide + x * cells
func name_i64(x: i64) -> []u8 {
  let tag: []u8 = "tag"
  if x > limit { return "large" }
  return tag
}
func name_u16(x: u16) -> []u8 {
  let tag: []u8 = "tag"
  if x > limit { return "large" }
  return tag
}
func flip_flag(p: *mut Flag, f: Flag) -> Flag {
  let q = p as *mut Flag
  let old = q.*
  q.* = (on: !f.on, n: f.n + limit, w: wide)
  return old
}
func flip_u64(p: *mut u64, f: Flag) -> Flag {
  let q = p as *mut Flag
  let old = q.*
  q.* = (on: !f.on, n: f.n + limit, w: wide)
  return old
}
func scaled_f32(x: f32) -> f64 => x * half + limit
func scaled_u16(x: u16) -> f64 => x * half + limit
data after = "after"
export func a(x: u8, y: u64, z: i32) -> u64 => clamp_u8(x) + clamp_u64(y) + (clamp_i32(z) as u64)
export func b(x: u8, y: u32) -> u64 => stretch_u8(x) + stretch_u32(y)
export func c(x: u16, y: i64) -> u32 => name_u16(x).len + name_i64(y).len + before.len + after.len
export func d(f: Flag) -> u64 {
  let was = flip_flag(space as *mut Flag, f)
  let now = flip_u64(space as *mut u64, was)
  return if now.on { now.w } else { now.n as u64 }
}
export func e(x: f32, y: u16) -> f64 => scaled_f32(x) + scaled_u16(y)
`
    await expectSameWasm(generic, byHand)
    expect((await run(generic)).a(200, 3n, 50)).toBe(23n)
    // Twice 1 << 40, and 17 cells times 2 and times 3.
    expect((await run(generic)).b(2, 3)).toBe(2199023255637n)
    expect((await run(generic)).c(5, 5n)).toBe(17)
    expect((await run(generic)).c(50, 50n)).toBe(21)
    // The second flip reads back what the first stored: on is the opposite
    // of what came in, n is 5 + 10.
    expect((await run(generic)).d(0, 5, 9n)).toBe(1099511627776n)
    expect((await run(generic)).d(1, 5, 9n)).toBe(15n)
    expect((await run(generic)).e(3, 4)).toBe(23.5)
  })
})

describe('compiling generics', () => {
  test("a generic's place is taken by its instances, in the order of their names", () => {
    const wat = watOfSource(`export func first(a: u32) -> u32 => min(max(a, 1), 9)
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }
export func middle(a: f64, b: i8) -> f64 => max(a, 1.5) + (max(b, 3) as f64)
func min(comptime T: type, a: T, b: T) -> T => if a < b { a } else { b }
export func last(a: u8) -> u8 => min(a, max(a, 1))
`)
    expect(funcs(wat)).toEqual(['first', 'max<f64>', 'max<i8>', 'max<u32>', 'max<u8>', 'middle', 'min<u32>', 'min<u8>', 'last'])
  })

  test('operators on T are those of the type argument', () => {
    const wat = watOfSource(Z1_GENERIC)
    expect(funcWat(wat, 'max<u32>')).toContain('i32.gt_u')
    expect(funcWat(wat, 'max<i32>')).toContain('i32.gt_s')
    expect(funcWat(wat, 'max<f64>')).toContain('f64.gt')
    expect(funcWat(wat, 'clamp<i32>')).toContain('(call $min<i32> (call $max<i32> (local.get $x) (local.get $lo)) (local.get $hi))')
  })

  test('a generic named like a builtin is called, not the builtin', () => {
    const wat = watOfSource(DOC_GENERIC)
    expect(funcWat(wat, 'widest')).toContain('(call $max<u32> (local.get $a) (local.get $b))')
    expect(wat).not.toContain('select')
  })

  test('an exported generic is not exported to the host', async () => {
    const source = `export func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }
export func f(a: u32) -> u32 => max(a, 1)
`
    const wat = watOfSource(source)
    expect([...wat.matchAll(/\(export "(\w+)"/g)].map(m => m[1])).toEqual(['f'])
    await wasmOfWat(wat)
    // A library of generics alone is an empty module.
    const library = watOfSource('export func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }\n')
    expect(funcs(library)).toEqual([])
    await wasmOfWat(library)
  })

  test('sizeof and recursion follow the type argument', async () => {
    const source = `func bytes(comptime T: type, n: u32) -> u32 => n * sizeof(T)
func fact(comptime T: type, n: T) -> T => if n <= 1 { 1 } else { n * fact(T, n - 1) }
export func a() -> u32 => bytes(u64, 3) + bytes((u32, u16), 2)
export func b() -> u64 => fact(u64, 20)
export func c() -> u32 => fact(u32, 5)
`
    const wat = watOfSource(source)
    expect(funcWat(wat, 'bytes<u64>')).toContain('(i32.const 8)')
    expect(funcWat(wat, 'bytes<<u32|u16>>')).toContain('(i32.const 6)')
    const exports = await run(source)
    expect(exports.a()).toBe(36)
    expect(exports.b()).toBe(2432902008176640000n)
    expect(exports.c()).toBe(120)
  })

  test('generic functions over slices and pointers run', async () => {
    const source = `data nums = [3:u32, 5, 8, 13]
data room = mut [0:u8; 64]

func find(comptime T: type, xs: []T, x: T) -> u32 {
  for i, v in xs {
    return i when v == x
  }
  return xs.len
}
func contains(comptime T: type, xs: []T, x: T) -> bool => find(xs, x) < xs.len
func fill(comptime T: type, xs: []mut T, x: T) {
  let p = xs.ptr
  for i in xs.len {
    p[i] = x
  }
}
func sum(comptime T: type, xs: []T) -> (total: T) {
  total = 0
  for v in xs {
    total += v
  }
}
func swap(comptime T: type, a: *mut T, b: *mut T) {
  let tmp = a.*
  a.* = b.*
  b.* = tmp
}
export func a() -> u32 => find(nums, 8)
export func b() -> bool => contains(nums, 4)
export func c() -> u64 {
  let cells = (room as [*]mut u64)[0..4]
  fill(cells, 5)
  cells.ptr[3] = 9
  swap(room as *mut u64, ((room as u32) + 24) as *mut u64)
  return sum(cells) + cells.ptr[0]
}
`
    const wat = watOfSource(source)
    // find<u32> exists once, although contains reaches it too.
    expect(funcs(wat).filter(name => name.startsWith('find'))).toEqual(['find<u32>'])
    expectPlainWasm(wat)
    const exports = await run(source)
    expect(exports.a()).toBe(2)
    expect(exports.b()).toBe(0)
    expect(exports.c()).toBe(33n)
  })

  // 0.2.1 gave the address of the slot for an element that is itself a
  // pointer. Values are loaded from memory by their type now, in an instance
  // by the type its argument makes the element.
  test('an element read out of memory is loaded as the type argument says', async () => {
    const generic = `type Pt = (q: i32, r: i32)
data cells = mut [0:u32; 6]
${HEAD}export func first(xs: []*mut Pt) -> *mut Pt => head(*mut Pt, xs)
export func pointer(v: u32) -> u32 {
  cells[1] = v
  return first((cells as [*]*mut Pt)[1..3]) as u32
}
export func point(q: i32, r: i32) -> i32 {
  cells[2] = q as u32
  cells[3] = r as u32
  let p = head((cells as [*]Pt)[1..3])
  return p.q - p.r
}
export func slice(n: u32) -> u32 {
  cells[4] = 16
  cells[5] = n
  return head([]u8, (cells as [*][]u8)[2..3]).len
}`
    const wat = watOfSource(generic)
    expect(funcWat(wat, 'head<*mut.<q:i32|r:i32>>')).toContain('(i32.load ')
    const exports = await run(generic)
    expect(exports.pointer(0xABCD)).toBe(0xABCD)
    expect(exports.point(9, 4)).toBe(5)
    expect(exports.slice(77)).toBe(77)
    await expectSameWasm(generic, generic
      .replace(HEAD, `func head_bytes(xs: [][]u8) -> []u8 => xs.ptr[0]
func head_ptr(xs: []*mut Pt) -> *mut Pt => xs.ptr[0]
func head_pt(xs: []Pt) -> Pt => xs.ptr[0]
`)
      .replace('head(*mut Pt, xs)', 'head_ptr(xs)')
      .replace('head((cells', 'head_pt((cells')
      .replace('head([]u8, (cells', 'head_bytes((cells'))
  })

  test('the instances of a module that is not the entry carry its prefix', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'encantis-generics-'))
    try {
      await writeFile(
        join(dir, 'util.ents'),
        `func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }
export func largest(a: u32, b: u32, c: u32) -> u32 => max(max(a, b), c)
`,
      )
      const entry = join(dir, 'main.ents')
      await writeFile(
        entry,
        `import "./util" "largest" func largest(a: u32, b: u32, c: u32) -> u32
func max(comptime T: type, a: T, b: T) -> T => if a < b { a } else { b }
export func f(a: u32) -> u32 => largest(a, 2, max(a, 3))
`,
      )
      const load = await loadModule(entry)
      const check = typecheckProgram(load.modules, entry, { includeTests: false })
      expect(check.errors).toEqual([])
      const wat = programToWat(load.modules, check.results, entry)
      expect(funcs(wat).sort()).toEqual(['f', 'max<u32>', 'util$largest', 'util$max<u32>'])
      const instance = await WebAssembly.instantiate(await WebAssembly.compile(await wasmOfWat(wat)))
      // The entry's max is the smaller of two, util's the larger.
      expect((instance.exports.f as (a: number) => number)(7)).toBe(7)
      expect((instance.exports.f as (a: number) => number)(1)).toBe(2)
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  // The copy an instance is made from has offsets of its own, numbered by the
  // order in which instances were asked for. None of that may show in the
  // output: the text of an instance is the same wherever its first call stands.
  test('the text of an instance does not depend on the order of unrelated calls', () => {
    const generics = `func total(comptime T: type, xs: []T) -> u64 {
  let sum: u64 = 0
  for v in xs { sum += v as u64 }
  return sum
}
func first_or(comptime T: type, xs: []T, otherwise: T) -> T => xs[0] ?? otherwise
func second(comptime T: type, xs: []T) -> T {
  if let v = xs[1] { return v }
  return 0
}
func longer(comptime T: type, a: []T, b: []T) -> u32 => (if a.len > b.len { a } else { b }).len
func rest(comptime T: type, xs: []T) -> []T => xs.ptr[1..xs.len]
func clear(comptime T: type, xs: []mut T) { xs[0..] = 0 }
func target(comptime T: type, p: ?*T) -> T {
  if let q = p { return q.* }
  return 0
}
`
    const uses = (first: string, then: string) => `${generics}
export func f(xs: []mut ${first}, ys: []mut ${then}, p: ?*${first}, q: ?*${then}) -> u64 {
  let a = total(xs) + (first_or(xs, 1) as u64) + (second(xs) as u64) + (target(p) as u64)
  let b = total(ys) + (first_or(ys, 1) as u64) + (second(ys) as u64) + (target(q) as u64)
  clear(xs)
  clear(ys)
  return a + b + ((longer(xs, xs) + rest(xs).len + longer(ys, ys) + rest(ys).len) as u64)
}
`
    const [bytesFirst, wordsFirst] = [watOfSource(uses('u8', 'u64')), watOfSource(uses('u64', 'u8'))]
    const instances = funcs(bytesFirst).filter(name => name.includes('<'))
    expect(instances).toHaveLength(14)
    for (const name of instances) expect(funcWat(wordsFirst, name)).toBe(funcWat(bytesFirst, name))
    // A scratch local is named after its place in the generic's source.
    const text = instances.map(name => funcWat(bytesFirst, name)).join('\n')
    const scratch = [...text.matchAll(/\$__\w+?_(\d+)\b/g)].map(m => Number(m[1]))
    expect(scratch.length).toBeGreaterThan(20)
    expect(Math.max(...scratch)).toBeLessThan(generics.length)
  })

  // An argument that is implicitly widened to a parameter of another wasm type
  // (a u32 for a u64) is converted where it is passed, by the conversion the
  // checker records for any expression that meets a wider type: there is no
  // second mechanism for the arguments of a generic call.
  describe('a later argument is widened to T', () => {
    const source = `func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }
export func widen(a: u64, b: u32) -> u64 => max(a, b)
`

    test('T is decided by the first argument and the call checks', () => {
      expect(instancesOf(source)).toEqual(['max<u64>'])
    })

    test('the widened argument is converted', async () => {
      const wat = watOfSource(source)
      expect(funcWat(wat, 'widen')).toContain('(call $max<u64> (local.get $a) (i64.extend_i32_u (local.get $b)))')
      const instance = await WebAssembly.instantiate(await WebAssembly.compile(await wasmOfWat(wat)))
      const widen = instance.exports.widen as (a: bigint, b: number) => bigint
      expect(widen(1n, 7)).toBe(7n)
      expect(widen(0x1_0000_0000n, -1)).toBe(0x1_0000_0000n)
    })

    test('the conversion is recorded for the call that needs it, whichever call made the instance', () => {
      const callers = [
        'export func widen(a: u64, b: u32) -> u64 => max(a, b)',
        'export func plain(a: u64, b: u64) -> u64 => max(a, b)',
        'export func signed(a: i64, b: i32) -> i64 => max(a, b)',
        'export func promoted(a: f64, b: f32) -> f64 => max(a, b)',
      ]
      for (const order of [callers, [...callers].reverse()]) {
        const wat = watOfSource(`${MAX}${order.join('\n')}\n`)
        expect(funcWat(wat, 'widen')).toContain('(call $max<u64> (local.get $a) (i64.extend_i32_u (local.get $b)))')
        expect(funcWat(wat, 'plain')).toContain('(call $max<u64> (local.get $a) (local.get $b))')
        expect(funcWat(wat, 'signed')).toContain('(call $max<i64> (local.get $a) (i64.extend_i32_s (local.get $b)))')
        expect(funcWat(wat, 'promoted')).toContain('(call $max<f64> (local.get $a) (f64.promote_f32 (local.get $b)))')
      }
    })

    // The body of an instance is checked with its own type argument, on its
    // own nodes: what widens in one instance does not in another.
    test('an instance widens in its body what its own type argument makes narrower', async () => {
      const generic = `func add(comptime T: type, a: T, n: u32) -> T => a + n
export func a(x: u64, n: u32) -> u64 => add(x, n)
export func b(x: u32, n: u32) -> u32 => add(x, n)
export func c(x: f64, n: u32) -> f64 => add(x, n)
export func d(x: i64, n: u8) -> i64 => add(i64, x, n)
`
      const wat = watOfSource(generic)
      expect(funcWat(wat, 'add<u64>')).toContain('(i64.add (local.get $a) (i64.extend_i32_u (local.get $n)))')
      expect(funcWat(wat, 'add<u32>')).toContain('(i32.add (local.get $a) (local.get $n))')
      expect(funcWat(wat, 'add<f64>')).toContain('(f64.add (local.get $a) (f64.convert_i32_u (local.get $n)))')
      expect(funcWat(wat, 'add<i64>')).toContain('(i64.add (local.get $a) (i64.extend_i32_u (local.get $n)))')
      await expectSameWasm(generic, `func add_f64(a: f64, n: u32) -> f64 => a + n
func add_i64(a: i64, n: u32) -> i64 => a + n
func add_u32(a: u32, n: u32) -> u32 => a + n
func add_u64(a: u64, n: u32) -> u64 => a + n
export func a(x: u64, n: u32) -> u64 => add_u64(x, n)
export func b(x: u32, n: u32) -> u32 => add_u32(x, n)
export func c(x: f64, n: u32) -> f64 => add_f64(x, n)
export func d(x: i64, n: u8) -> i64 => add_i64(x, n)
`)
    })
  })
})

// === The example programs ===
//
// examples/generics/*.ents run their own inline tests (examples/examples.test.ts).
// These pin what `encantis compile` makes of them.

// === Generic types and comptime function parameters ===

const VEC = 'func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)\n'
const PAIR = 'func Pair(comptime A: type, comptime B: type) -> type => (first: A, second: B)\n'
const LAST = 'func last(comptime T: type, v: *Vec(T)) -> T => v.ptr[v.len - 1]\n'

describe('generic types', () => {
  test('the forms that are not a generic type, or not an application of one, do not parse', () => {
    const fails = (source: string) => parse(source).errors.map(e => e.shortMessage)
    // A generic type has no block body: its body is a type.
    expect(fails('func Vec(comptime T: type) -> type { }')).toEqual(['Line 1, col 36: expected "=>"'])
    // The parenthesis follows the name directly: a type can end a line.
    expect(fails('func f(v: Vec (u32)) { }')).toHaveLength(1)
    expect(fails('func f(v: Vec()) { }')).toHaveLength(1)
    // A function whose result is `type` has an upper-case name.
    expect(fails('func vec(comptime T: type) -> type => (T, T)')).toHaveLength(1)
    // What it does not change: a function from a named type, without a name.
    expect(fails('func Point -> Point => p')).toEqual([])
  })

  test('an applied type is its body: same-shaped generic types and the struct written out reach one instance', () => {
    const source = `${VEC}func Stack(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
${LAST}export func a(v: *Vec(u64)) -> u64 => last(v)
export func b(v: *Stack(u64)) -> u64 => last(v)
export func c(v: *(ptr: [*]mut u64, len: u32, cap: u32)) -> u64 => last(v)
export func d(v: *mut Vec(u64)) -> u64 => last(u64, v)
export func e(v: *Stack(u64)) -> u64 => last(u64, v)`
    expect(instancesOf(source)).toEqual(['last<u64>'])
    // Nothing of Vec or Stack is in the output: a generic type is not there
    // at run time.
    expect(funcs(watOfSource(source))).toEqual(['last<u64>', 'a', 'b', 'c', 'd', 'e'])
  })

  test('a value of one applied type is a value of any type with that body, and of no other', () => {
    const source = `${VEC}func Stack(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
type Bytes = Vec(u8)
export func f(a: Vec(u8)) -> u32 {
  let b: Stack(u8) = a
  let c: (ptr: [*]mut u8, len: u32, cap: u32) = b
  let d: Bytes = c
  let e: Vec(u8) = d
  return e.len
}`
    expect(errorsOf(source)).toEqual([])
    // Different arguments are different bodies, and the error names the types
    // as they were written.
    expect(errorsOf(`${VEC}func f(a: *Vec(u8)) -> u32 {
  let b: *Vec(u32) = a
  return b.len
}`)).toEqual(['cannot assign *Vec(u8) to *Vec(u32)'])
  })

  // Vec(Meters) and Vec(u32) are one type. Each is still shown with the
  // argument its reader wrote, whichever of the two was applied first.
  test('an applied type reads as it was written', () => {
    expect(errorsOf(`${VEC}type Meters = u32
func f(a: *Vec(u32), b: *Vec(Meters)) -> u32 {
  let same: *Vec(Meters) = a
  let x: *Vec(u8) = a
  let y: *Vec(u8) = b
  return same.len + x.len + y.len
}`)).toEqual(['cannot assign *Vec(u32) to *Vec(u8)', 'cannot assign *Vec(Meters) to *Vec(u8)'])
  })

  test('is written wherever a type is: parameter, result, field, cast, sizeof, let, another generic type, type argument', async () => {
    const source = `${VEC}${PAIR}func Table(comptime K: type, comptime V: type) -> type => (keys: Vec(K), rows: [*]mut Pair(K, Vec(V)), n: u32)
type Named = (name: Vec(u8), id: u32)
global shelf: Vec(u16) = (0 as [*]mut u16, 0, 0)
func id(comptime T: type, x: T) -> T => x
func keys(comptime K: type, comptime V: type, t: *Table(K, V)) -> Vec(K) => t.keys
export func f(t: *Table(u8, f64), n: Named, a: u32) -> u32 {
  let k: Vec(u8) = keys(t)
  let p = a as *mut Vec(Pair(u8, u8))
  let v = id(Vec(u8), n.name)
  let w = id(*Vec(u16), 0 as *Vec(u16))
  return k.len + v.cap + shelf.len + sizeof(Table(u8, Vec(u64))) + sizeof(?*Vec(u8)) + (p as u32) + (w as u32)
}`
    expect(instancesOf(source)).toEqual(["id<*<ptr:'*'mut.u16|len:u32|cap:u32>>", "id<<ptr:'*'mut.u8|len:u32|cap:u32>>", 'keys<u8|f64>'])
    await wasmOfSource(source)
  })

  // The host's function takes and returns the struct's values, as the one
  // declared with the struct written out does: read off the syntax, the
  // applied type was no parameter and no result at all.
  test('in the signature of a host import it is the struct written out', async () => {
    const use = (vec: string) => `export func go() -> u32 => draw((1, 2), 3) + make(4).second + far(0 as *mut ${vec})`
    const applied = `import "env" "draw" func draw(p: Pair(u8, u32), n: u32) -> u32
import "env" "make" func make(n: u32) -> Pair(u8, u32)
import "env" "far" func far(v: *mut Vec(u8)) -> (u32)
${VEC}${PAIR}${use('Vec(u8)')}`
    const written = `import "env" "draw" func draw(p: (first: u8, second: u32), n: u32) -> u32
import "env" "make" func make(n: u32) -> (first: u8, second: u32)
import "env" "far" func far(v: *mut (ptr: [*]mut u8, len: u32, cap: u32)) -> (u32)
${use('(ptr: [*]mut u8, len: u32, cap: u32)')}`
    await expectSameWasm(applied, written)
    expect(watOfSource(applied)).toContain('(import "env" "draw" (func $draw (param $p_first i32) (param $p_second i32) (param $n i32) (result i32)))')
  })

  test('may be declared after its uses, and reached through a type that refers to it', async () => {
    // List applies nothing: Node is a forward reference, as in any type that
    // refers to itself.
    const source = `type Node = List(u32)
export func first(n: *Node) -> u32 => n.head
export func third(u: *Use(u8)) -> u32 => u.later.x + u.a
func List(comptime T: type) -> type => (head: T, next: ?*Node)
func Use(comptime T: type) -> type => (a: T, later: Later)
type Later = (x: u32)`
    expect(errorsOf(source)).toEqual([])
    await wasmOfSource(source)
  })

  test('may refer to itself through a pointer or a slice, and costs what the type written out does', async () => {
    const generic = `func Node(comptime T: type) -> type => (next: ?*Node(T), v: T)
func Tree(comptime T: type) -> type => (kids: []Tree(T), v: T)
func Even(comptime T: type) -> type => (odd: ?*Odd(T), v: T)
func Odd(comptime T: type) -> type => (even: ?*Even(T), v: T)
func sum(comptime T: type, h: ?*Node(T)) -> T {
  let total: T = 0
  let p = h
  while true {
    if let n = p {
      total += n.v
      p = n.next
    } else {
      return total
    }
  }
  return total
}
export func a(h: *Node(u32)) -> u32 => sum(h) + sum(h.next)
export func b(h: *Node(u8)) -> u8 => if let n = h.next { if let m = n.next { m.v } else { 0 } } else { 0 }
export func c(t: Tree(i64)) -> i64 => if let k = t.kids[0] { if let l = k.kids[0] { l.v } else { k.v } } else { t.v }
export func d(e: *Even(u16)) -> u16 => if let o = e.odd { if let f = o.even { f.v } else { o.v } } else { e.v }
`
    const byHand = `type Node32 = (next: ?*Node32, v: u32)
type Node8 = (next: ?*Node8, v: u8)
type Tree64 = (kids: []Tree64, v: i64)
type Even16 = (odd: ?*Odd16, v: u16)
type Odd16 = (even: ?*Even16, v: u16)
func sum(h: ?*Node32) -> u32 {
  let total: u32 = 0
  let p = h
  while true {
    if let n = p {
      total += n.v
      p = n.next
    } else {
      return total
    }
  }
  return total
}
export func a(h: *Node32) -> u32 => sum(h) + sum(h.next)
export func b(h: *Node8) -> u8 => if let n = h.next { if let m = n.next { m.v } else { 0 } } else { 0 }
export func c(t: Tree64) -> i64 => if let k = t.kids[0] { if let l = k.kids[0] { l.v } else { k.v } } else { t.v }
export func d(e: *Even16) -> u16 => if let o = e.odd { if let f = o.even { f.v } else { o.v } } else { e.v }
`
    await expectSameWasm(generic, byHand)
  })

  test('a generic function takes a type that refers to itself under any of its names as one type', () => {
    const source = `type Node = (next: ?*Node, v: u32)
type Link = Node
func List(comptime T: type) -> type => (next: ?*List(T), v: T)
func first(comptime T: type, n: *T) -> *T => n
export func f(a: *Node, b: *Link, c: *List(u32)) -> u32 => first(a).v + first(b).v + first(c).v
`
    // Named by the type, cut where it comes round to itself
    expect(instancesOf(source)).toEqual(['first<<next:?*@0|v:u32>>'])
  })

  test('one generic type applied inside its own application is seen through to T, where a type that refers to itself stops', () => {
    const source = `${VEC}func Id(comptime T: type) -> type => T
func List(comptime T: type) -> type => (next: ?*List(T), v: T)
func same(comptime T: type, x: Id(Id(T))) -> Id(T) => x
func deep(comptime T: type, v: *Vec(Vec(T))) -> T => v.ptr[0].ptr[0]
func head(comptime T: type, l: *List(List(T))) -> T => l.v.v
export func a(x: u64) -> u64 => same(x)
export func b(v: *Vec(Vec(i64))) -> i64 => deep(v)
export func c(l: *List(List(u8))) -> u8 => head(l)`
    expect(instancesOf(source)).toEqual(['deep<i64>', 'head<u8>', 'same<u64>'])
  })

  test('sizeof follows the type arguments in each instance', async () => {
    const source = `${VEC}${PAIR}func size(comptime T: type) -> u32 => sizeof(Vec(T)) + sizeof(Pair(T, bool)) * 100
export func a() -> u32 => size(u8)
export func b() -> u32 => size(u64)
export func c() -> u32 => sizeof(Vec(u8)) + sizeof(Pair(u8, u64)) * 100`
    const { a, b, c } = await run(source)
    // The header is three words whatever T is; a pair is its fields, packed.
    expect(a()).toBe(12 + 2 * 100)
    expect(b()).toBe(12 + 9 * 100)
    expect(c()).toBe(12 + 9 * 100)
  })

  test('T is inferred through a generic type, by its body', () => {
    const source = `${VEC}${PAIR}${LAST}func Map(comptime K: type, comptime V: type) -> type => (keys: [*]mut K, vals: [*]mut Pair(K, V), n: u32)
func val(comptime K: type, comptime V: type, m: *Map(K, V), i: u32) -> V => m.vals[i].second
func swapped(comptime A: type, comptime B: type, p: Pair(A, B)) -> Pair(B, A) => Pair(B, A)(p.second, p.first)
export func a(v: *mut Vec(u8)) -> u8 => last(v)
export func b(m: *Map(u8, f64)) -> f64 => val(m, 2)
export func c(p: Pair(u8, u64)) -> Pair(u64, u8) => swapped(p)
export func d(p: (first: i32, second: f32)) -> f32 => swapped(swapped(swapped(p))).first
export func e(v: *(ptr: [*]mut i16, len: u32, cap: u32)) -> i16 => last(v)`
    expect(instancesOf(source)).toEqual(['last<i16>', 'last<u8>', 'swapped<f32|i32>', 'swapped<i32|f32>', 'swapped<u8|u64>', 'val<u8|f64>'])
    // What does not have the body's shape decides nothing.
    expect(errorsOf(`${VEC}${LAST}func f(v: *(ptr: [*]mut u8, len: u32)) -> u8 => last(v)`)).toEqual([
      "cannot infer T for 'last': write the type argument, as in last(u32, ...)",
    ])
  })

  test('a type parameter the generic type has no field of cannot be inferred through it', () => {
    const source = `func Tagged(comptime T: type) -> type => (id: u32)
func tag(comptime T: type, t: Tagged(T)) -> u32 => t.id + sizeof(T)
`
    expect(errorsOf(`${source}func f(t: Tagged(u8)) -> u32 => tag(t)`)).toEqual([
      "cannot infer T for 'tag': 'Tagged(T)' does not use T in its fields; write the type argument",
    ])
    expect(instancesOf(`${source}export func f(t: Tagged(u8)) -> u32 => tag(u8, t) + tag(u64, t)`)).toEqual(['tag<u64>', 'tag<u8>'])
  })

  const rejected: [string, string, string[]][] = [
    ['without its arguments', `${VEC}func f(v: *Vec) -> u32 => 0`, ["'Vec' is a generic type: write Vec(T)"]],
    ['with the wrong number of arguments', `${VEC}func f(v: *Vec(u32, u8)) -> u32 => 0`, ['Vec expects 1 type argument, got 2']],
    ['with too few arguments', `${PAIR}func f(v: *Pair(u32)) -> u32 => 0`, ['Pair expects 2 type arguments, got 1']],
    ['a type that is not generic, applied', 'type Point = (x: i32, y: i32)\nfunc f(v: *Point(u32)) -> u32 => 0', ["'Point' is not a generic type"]],
    ['a name that is no type, applied', `${VEC}func f(v: *Vex(u32)) -> u32 => 0`, ["unknown generic type 'Vex' — did you mean 'Vec'?"]],
    ['an argument that is not a concrete type', `${VEC}func f(v: *Vec(int(5))) -> u32 => 0`, ["type argument T of 'Vec' must be a concrete type"]],
    [
      'a generic type that refers to itself with an argument that grows',
      'func List(comptime T: type) -> type => (head: T, next: ?*List(*T))\nfunc f(a: *List(u32), b: *List(u8)) -> u32 => 0',
      ["generic type 'List' refers to itself with a type argument that grows, List(*T): applying it would never end"],
    ],
    [
      'generic types that refer to each other with an argument that grows',
      'func A(comptime T: type) -> type => (x: T, b: *B([]T))\nfunc B(comptime T: type) -> type => (y: T, a: *A(T))\nfunc f(a: *A(u32), b: *B(u8)) -> u32 => 0',
      ["generic type 'A' refers to itself with a type argument that grows, B([]T): applying it would never end"],
    ],
    [
      'a generic type that holds itself, not through a pointer',
      'func List(comptime T: type) -> type => (head: T, next: List(T))\nfunc f(a: *List(u32), b: *List(u8)) -> u32 => 0',
      ["generic type 'List' contains itself: a type can only refer to itself through a pointer or a slice"],
    ],
    [
      'no parameters',
      'func Vec() -> type => u32\nfunc f(v: Vec(u32)) -> u32 => 0',
      ["generic type 'Vec' takes comptime type and integer parameters only, as (comptime n: u32, comptime T: type)"],
    ],
    [
      'a parameter that is not comptime',
      'func Vec(comptime T: type, n: u32) -> type => (T, u32)\nfunc f(v: Vec(u32)) -> u32 => 0',
      ["generic type 'Vec' takes comptime type and integer parameters only, as (comptime n: u32, comptime T: type)"],
    ],
    ['a type parameter declared twice', 'func Two(comptime A: type, comptime A: type) -> type => (A, A)', ["type parameter 'A' is declared twice"]],
    [
      'a type parameter named like a type',
      'type Pt = (q: i32, r: i32)\nfunc Two(comptime Pt: type) -> type => (Pt, Pt)',
      ["type parameter 'Pt' has the name of a type declared in this module"],
    ],
    ['a type parameter applied in a generic type', 'func Bad(comptime F: type) -> type => (x: F(u32))\nfunc f(v: *Bad(u32)) -> u32 => 0', ['a type parameter cannot be applied']],
    [
      'a type parameter applied in a generic function',
      'func bad(comptime F: type, x: F(u32)) -> u32 => 0\nfunc f() -> u32 => bad(u32, 1)',
      ['a type parameter cannot be applied'],
    ],
    [
      'a generic type declared in a test',
      'test "t" {\n  func Two(comptime T: type) -> type => (T, T)\n  let v: Two(u32) = (1, 2)\n  assert v.0 == 1\n}',
      ['a generic type is declared at module level, not inside a test'],
    ],
    [
      'a type of the same name',
      `${VEC}type Vec = (a: u32)\nfunc f(v: *Vec(u32), w: Vec) -> u32 => v.len`,
      ["'Vec' is already declared: a generic type's name is unique in its module"],
    ],
    [
      'a second generic type of the same name',
      `${VEC}func Vec(comptime T: type) -> type => (T, T)\nfunc f(v: *Vec(u32)) -> u32 => v.len`,
      ["'Vec' is already declared: a generic type's name is unique in its module"],
    ],
    [
      'a type parameter of a function named like a generic type',
      `${VEC}func f(comptime Vec: type, x: Vec) -> Vec => x`,
      ["type parameter 'Vec' has the name of a type declared in this module"],
    ],
    ['an unknown type in the body', 'func Bad(comptime T: type) -> type => (t: T, n: Nope)\nfunc f(a: *Bad(u32), b: *Bad(u8)) -> u32 => 0', ["unknown type 'Nope'"]],
  ]
  for (const [what, source, errors] of rejected) {
    test(`${what} is one error`, () => {
      expect(errorsOf(source)).toEqual(errors)
    })
  }

  // Nothing in a chain refers to itself, however long it is: each generic
  // type holds the next one. The limit that stops a runaway is far beyond
  // what is written by hand, and says what it is.
  test('a long chain of generic types is not one that refers to itself', async () => {
    const chain = (n: number) => `${Array.from({ length: n - 1 }, (_, i) => `func G${i}(comptime T: type) -> type => (x: G${i + 1}(T), t: u8)`).join('\n')}
func G${n - 1}(comptime T: type) -> type => (x: T, t: u8)
export func size() -> u32 => sizeof(G0(u8))
export func last(g: *G0(u8)) -> u8 => g.t`
    const { size } = await run(chain(66))
    expect(size()).toBe(67)
    // Once for each application that was written: the signature's, then the body's.
    expect(check(chain(1001)).errors.map(place)).toEqual([
      { offset: chain(1001).lastIndexOf('G0(u8)'), message: "generic types are nested more than 1000 deep in 'G0(u8)'" },
      { offset: chain(1001).indexOf('G0(u8)'), message: "generic types are nested more than 1000 deep in 'G0(u8)'" },
    ])
  })

  test('a type that did not resolve says nothing more where it is pointed to, indexed or assigned', () => {
    const source = `${VEC}func a(v: *Vec(Vec)) -> u32 => v.len
func b(v: *Vex(u8), w: []Vec(u8, u8)) -> u32 => v.ptr[0] + w[0].len + w.len
func c() -> u32 {
  let v: Vec = (0 as [*]mut u8, 1, 2)
  return v.len
}`
    expect(errorsOf(source)).toEqual([
      "'Vec' is a generic type: write Vec(T)",
      "unknown generic type 'Vex' — did you mean 'Vec'?",
      'Vec expects 1 type argument, got 2',
      "'Vec' is a generic type: write Vec(T)",
    ])
  })

  test('nor where a `type` names it', () => {
    const source = `${VEC}type V = Vec(u32, u8)
type L = List(u32)
func List(comptime T: type) -> type => (head: T, next: ?*List(*T))
func f(v: *V) -> u32 => v.len
func g(v: V, vs: []V) -> u32 => v.len + vs[0].cap
func h(l: *L) -> u32 => l.head
func k() -> u32 {
  let v: V = (0 as [*]mut u32, 1, 2)
  return v.len
}`
    expect(errorsOf(source)).toEqual([
      "generic type 'List' refers to itself with a type argument that grows, List(*T): applying it would never end",
      'Vec expects 1 type argument, got 2',
    ])
  })

  // An instance would repeat such an error for each set of type arguments,
  // and the inferred call of c, which cannot find T through *Vec(T, T), would
  // say that it cannot infer T.
  test('how a generic function names a generic type is checked where it is declared, once whatever calls it', () => {
    const source = `${VEC}type Pt = (q: i32, r: i32)
func a(comptime T: type, v: *Vec, x: T) -> T => x
func b(comptime T: type, v: *Pt(T), x: T) -> T => x
func c(comptime T: type, v: *Vec(T, T)) -> T => v.ptr[0]
func d(comptime T: type, x: T) -> u32 => sizeof(Vex(T))
export func f(v: *Vec(u8), p: *Pt) -> u32 => a(v, 1:u32) + a(v, 2:u8) + b(p, 3:u32) + c(v) + d(4:u32) + d(5:u8)`
    expect(check(source).errors).toEqual([
      { offset: source.indexOf('Vec, x'), message: "'Vec' is a generic type: write Vec(T)" },
      { offset: source.indexOf('Pt(T)'), message: "'Pt' is not a generic type" },
      { offset: source.indexOf('Vec(T, T)'), message: 'Vec expects 1 type argument, got 2' },
      { offset: source.indexOf('Vex(T)'), message: "unknown generic type 'Vex' — did you mean 'Vec'?" },
    ])
  })

  test('a generic type nobody applies is not resolved, and one that is exported is nothing to the host', async () => {
    const program = 'export func f(a: u32) -> u32 => a + 1\n'
    const unused = `func Unused(comptime T: type) -> type => (nope: Nope, t: T)
export func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
`
    expect(errorsOf(unused + program)).toEqual([])
    expect(watOfSource(unused + program)).toBe(watOfSource(program))
    await expectSameWasm(unused + program, program)
  })
})

describe('a type that is called constructs a value', () => {
  test('the spellings of one struct value compile to the same code', () => {
    const body = (make: string) => `${VEC}type VecU32 = (ptr: [*]mut u32, len: u32, cap: u32)
export func f(p: u32, c: u32) -> u32 {
  let v = ${make}
  return v.cap + v.len
}`
    const wat = (make: string) => funcWat(watOfSource(body(make)), 'f')
    const applied = wat('Vec(u32)(p as [*]mut u32, 0, c)')
    expect(applied).toContain('(local.set $v_ptr (local.get $p))')
    // The alias's constructor, the struct literal where the type is known,
    // and the fields by name in another order.
    expect(wat('VecU32(p as [*]mut u32, 0, c)')).toBe(applied)
    expect(wat('(ptr: p as [*]mut u32, len: 0, cap: c):Vec(u32)')).toBe(applied)
    expect(wat('Vec(u32)(cap: c, ptr: p as [*]mut u32, len: 0)')).toBe(applied)
  })

  test('T(a, b) constructs in an instance, by position or by name, and so does a tuple of types', async () => {
    const source = `${VEC}type Pt = (q: i32, r: i32)
func make(comptime T: type, x: i32) -> T => T(x, x + 1)
func named(comptime T: type, x: i32) -> T => T(r: x, q: x + 1)
func empty(comptime T: type) -> Vec(T) => Vec(T)(ptr: 0 as [*]mut T, cap: 4, len: 0)
func three(comptime T: type, x: T) -> (T, T, T) => (T, T, T)(x, x, x)
export func a() -> i32 => make(Pt, 10).r * 100 + make((i32, i32), 20).0
export func b() -> i32 => named(Pt, 10).q
export func c() -> u32 => empty(u8).cap + three(7:u32).2 + (u32, u32)(1, 2).1`
    expect(instancesOf(source)).toEqual(['empty<u8>', 'make<<i32|i32>>', 'make<<q:i32|r:i32>>', 'named<<q:i32|r:i32>>', 'three<u32>'])
    const { a, b, c } = await run(source)
    expect(a()).toBe(11 * 100 + 20)
    expect(b()).toBe(11)
    expect(c()).toBe(4 + 7 + 2)
  })

  test('its arguments are checked as those of any constructor, and a field is given once', () => {
    const f = (make: string) => errorsOf(`${VEC}func f(p: [*]mut u32) -> u32 {
  let v = ${make}
  return 0
}`)
    expect(f('Vec(u32)(p, 0)')).toEqual(['Vec(u32) expects 3 fields, got 2: no value for cap'])
    expect(f('Vec(u32)(p, 0, 4.5)')).toEqual(['field cap: cannot assign float(4.5) to u32'])
    expect(f('Vec(u32)(p, 0, size: 4)')).toEqual(["field 'size' not found in Vec(u32), whose fields are ptr, len and cap"])
    expect(f('Vec(u32)(ptr: p, len: 0, ptr: p)')).toEqual(["Vec(u32): field 'ptr' is given twice"])
    expect(f('Vec(u32)(p, 0, len: 4)')).toEqual(["Vec(u32): field 'len' is given twice"])
  })

  test('a generic type where a value is expected is one error', () => {
    const f = (value: string) => errorsOf(`${VEC}func f(p: [*]mut u32) -> u32 {
  let v = ${value}
  return v.len
}`)
    expect(f('Vec(p, 0, 4)')).toEqual(["'Vec' is a generic type: write Vec(T)"])
    expect(f('Vec(u32)')).toEqual(["'Vec(u32)' is a type; a type can only be passed for a comptime parameter"])
    expect(f('Vec([]u8)')).toEqual(["'Vec([]u8)' is a type; a type can only be passed for a comptime parameter"])
    expect(f('Vex(u32)(p, 0, 4)')).toEqual(["unknown generic type 'Vex' — did you mean 'Vec'?"])
  })

  test('in a data literal and a global initializer it is the data the alias\'s constructor is', async () => {
    await expectSameWasm(DATA_GENERIC, DATA_BY_HAND)
    const { a, b, c } = await run(DATA_GENERIC)
    expect(a()).toBe(2.5)
    expect(b()).toBe(4)
    expect(c(9)).toBe(94)
  })

  // The applied type is itself a name for its body, so the `type` is a name
  // for a name: its constructor is still the struct's.
  test('a type that names an applied type constructs what the applied type does', async () => {
    const use = `data table = [PP(1, 2), QQ(second: 4, first: 3)]
global origin: PP = PP(0, 0)
func take(p: PP) -> u32 => p.second
export func go() -> u32 => take(PP(1, 5)) + take(QQ(second: 7, first: 2)) + IntVec(0 as [*]mut u32, 3, 4).cap + (table as [*]PP)[1].second + origin.second`
    const generic = `${PAIR}${VEC}type PP = Pair(u8, u32)
type QQ = PP
type IntVec = Vec(u32)
${use}`
    const byHand = `type PP = (first: u8, second: u32)
type QQ = (first: u8, second: u32)
type IntVec = (ptr: [*]mut u32, len: u32, cap: u32)
${use}`
    await expectSameWasm(generic, byHand)
    const { go } = await run(generic)
    expect(go()).toBe(5 + 7 + 4 + 4)
    // A value of that type is not a constructor because its type has a name.
    expect(errorsOf(`${PAIR}type PP = Pair(u8, u32)\nfunc f(p: PP) -> i32 => p(1, 2)`)).toEqual(['cannot call non-function type: PP'])
  })
})

const SORT = `func sort(comptime T: type, xs: []mut T, comptime before: (T, T) -> bool) {
  let p = xs.ptr
  for i in xs.len {
    let x = p[i]
    let j = i
    while j > 0 && before(x, p[j - 1]) {
      p[j] = p[j - 1]
      j -= 1
    }
    p[j] = x
  }
}
func ascending(a: i32, b: i32) -> bool => a < b
func descending(a: i32, b: i32) -> bool => a > b
`

describe('comptime function parameters', () => {
  test('a call of the parameter is a direct call of the function it was given', () => {
    const wat = watOfSource(`${SORT}export func up(xs: []mut i32) { sort(xs, ascending) }
export func down(xs: []mut i32) { sort(xs, descending) }`)
    expect(funcs(wat)).toEqual(['sort<i32|ascending>', 'sort<i32|descending>', 'ascending', 'descending', 'up', 'down'])
    expect(funcWat(wat, 'sort<i32|ascending>')).toContain('(call $ascending (local.get $x) ')
    expect(funcWat(wat, 'sort<i32|ascending>')).not.toContain('$descending')
    expect(funcWat(wat, 'sort<i32|descending>')).toContain('(call $descending (local.get $x) ')
    expect(funcWat(wat, 'up')).toContain('(call $sort<i32|ascending> (local.get $xs_ptr) (local.get $xs_len))')
    expectPlainWasm(wat)
  })

  test('the function is part of what an instance is, however the call is written', () => {
    const source = `${SORT}func longer(a: f64, b: f64) -> bool => a > b
export func a(xs: []mut i32) { sort(xs, ascending) }
export func b(xs: []mut i32) { sort(i32, xs, ascending) }
export func c(xs: []mut i32) { sort(xs, descending) }
export func d(xs: []mut f64) { sort(xs, longer) }`
    expect(instancesOf(source)).toEqual(['sort<f64|longer>', 'sort<i32|ascending>', 'sort<i32|descending>'])
  })

  test('the signature of the function decides a type parameter, like any argument', async () => {
    const source = `func twice(comptime T: type, comptime f: (T) -> T, x: T) -> T => f(f(x))
func inc(x: u32) -> u32 => x + 1
func half(x: f64) -> f64 => x / 2.0
export func a() -> u32 => twice(inc, 5) + twice(u32, inc, 0)
export func b() -> f64 => twice(half, 10)`
    expect(instancesOf(source)).toEqual(['twice<f64|half>', 'twice<u32|inc>'])
    const { a, b } = await run(source)
    expect(a()).toBe(7 + 2)
    expect(b()).toBe(2.5)
    // The first argument that can decides: here the function.
    expect(errorsOf(`${source}\nfunc c(x: u64) -> u64 => twice(inc, x)`)).toEqual(['argument 2: cannot assign u64 to u32'])
  })

  test('is passed on to another generic, and reaches one instance by either way', async () => {
    const source = `func each(comptime T: type, xs: []T, comptime f: (T) -> T) -> T => f(xs.ptr[0])
func both(comptime T: type, xs: []T, comptime g: (T) -> T) -> T => each(xs, g) + each(T, xs, g)
func inc(x: u32) -> u32 => x + 1
func dec(x: u32) -> u32 => x - 1
data nums = [10:u32, 20]
export func a() -> u32 => both(nums, inc) * 100 + both(nums, dec) + each(nums, inc)`
    expect(instancesOf(source)).toEqual(['both<u32|dec>', 'both<u32|inc>', 'each<u32|dec>', 'each<u32|inc>'])
    const wat = watOfSource(source)
    // The instance the parameter was passed on to calls the function itself.
    expect(funcWat(wat, 'each<u32|dec>')).toContain('(call $dec ')
    expect(funcWat(wat, 'both<u32|dec>')).toContain('(call $each<u32|dec> ')
    expectPlainWasm(wat)
    const { a } = await run(source)
    expect(a()).toBe(22 * 100 + 18 + 11)
  })

  test('an imported function and a generic without type parameters', async () => {
    const source = `import "env" "cmp" func cmp(a: i32, b: i32) -> bool
func apply(comptime f: (i32, i32) -> bool, x: i32) -> bool => f(x, 0)
func neg(a: i32, b: i32) -> bool => a < b
export func a(x: i32) -> bool => apply(cmp, x) || apply(neg, x)`
    expect(instancesOf(source)).toEqual(['apply<cmp>', 'apply<neg>'])
    expect(funcWat(watOfSource(source), 'apply<cmp>')).toContain('(call $cmp (local.get $x) (i32.const 0))')
    await wasmOfSource(source)
    // It has the one form: there is no type argument to leave out.
    expect(errorsOf(`${source}\nfunc b() -> bool => apply(cmp)`)).toEqual(["'apply' expects 2 arguments, got 1"])
  })

  const wrong: [string, string, string][] = [
    ['a number', 'sort(xs, 5)', "argument 2 of 'sort' must be the name of a function: before is a comptime function parameter"],
    ['an expression', 'sort(xs, if xs.len > 1 { ascending } else { descending })', "argument 2 of 'sort' must be the name of a function: before is a comptime function parameter"],
    ['a name that is not declared', 'sort(xs, nope)', "argument 2 of 'sort' must be the name of a function: before is a comptime function parameter"],
    ['a builtin', 'sort(xs, min)', "argument 2 of 'sort' must be the name of a function: before is a comptime function parameter"],
    ['a generic function', 'sort(xs, pick)', "argument 2 of 'sort' must be the name of a function: before is a comptime function parameter"],
    ['a variable', 'sort(xs, xs)', "argument 2 of 'sort' must be the name of a function: before is a comptime function parameter"],
    ['a function of another signature', 'sort(xs, inc)', "'inc' is (u32) -> u32, but 'sort' needs before: (i32, i32) -> bool"],
    ['a function of another signature, the type written', 'sort(i32, xs, wide)', "'wide' is (i64, i64) -> bool, but 'sort' needs before: (i32, i32) -> bool"],
  ]
  for (const [what, call, message] of wrong) {
    test(`${what} for a comptime function parameter is one error`, () => {
      const source = `${SORT}func pick(comptime T: type, a: T, b: T) -> bool => a < b
func inc(x: u32) -> u32 => x + 1
func wide(a: i64, b: i64) -> bool => a < b
export func f(xs: []mut i32) { ${call} }`
      expect(errorsOf(source)).toEqual([message])
    })
  }

  // A name is the type it names here as anywhere: whether the parameter is a
  // function parameter is not a matter of how its type is spelled.
  test('its type may be a name for a function type: a `type`, or an applied generic type', async () => {
    const source = (fn: string, cmp: string) => `func twice(comptime T: type, comptime f: ${fn}, x: T) -> T => f(f(x))
func thrice(comptime T: type, comptime f: ${fn}, x: T) -> T => f(twice(f, x))
func pick(a: i32, b: i32, comptime before: ${cmp}) -> i32 => if before(a, b) { a } else { b }
func Fn(comptime T: type) -> type => (T) -> T
type Cmp = Less
type Less = (i32, i32) -> bool
func inc(x: u32) -> u32 => x + 1
func lt(a: i32, b: i32) -> bool => a < b
func gt(a: i32, b: i32) -> bool => a > b
export func a() -> u32 => twice(inc, 5) + thrice(inc, 1)
export func b(x: i32, y: i32) -> i32 => pick(x, y, lt) - pick(x, y, gt)
`
    await expectSameWasm(source('Fn(T)', 'Cmp'), source('(T) -> T', '(i32, i32) -> bool'))
    expect(instancesOf(source('Fn(T)', 'Cmp'))).toEqual(['pick<gt>', 'pick<lt>', 'thrice<u32|inc>', 'twice<u32|inc>'])
    expect(errorsOf(`${source('Fn(T)', 'Cmp')}func c(x: i32) -> i32 => pick(x, x, inc)`)).toEqual([
      "'inc' is (u32) -> u32, but 'pick' needs before: (i32, i32) -> bool",
    ])
    // A name for an integer type makes a value parameter, and one for any
    // other type is refused.
    expect(errorsOf(`type Meters = u32\n${PAIR}func f(comptime T: type, comptime n: Meters, comptime p: Pair(T, T)) -> u32 => 0`)).toEqual([
      "comptime parameter 'p' is Pair(T, T): a comptime parameter is a type (comptime T: type), an integer (comptime n: u32) or a function (comptime f: (T) -> T)",
    ])
  })

  // The hand-written fold calls add_f64 and assigns what it returns to an
  // Acc: the generic one takes the function the same way. What could not be
  // assigned there, results without the fields' names, is not taken here.
  test('a function that lists a struct\'s fields as its results is one that returns the struct', async () => {
    const fold = (step: string, result: string) => `func Acc(comptime T: type) -> type => (sum: T, n: u32)
func fold(comptime T: type, xs: []T, comptime step: (Acc(T), T) -> ${step}, init: T) -> Acc(T) {
  let acc = Acc(T)(init, 0)
  for x in xs { acc = step(acc, x) }
  return acc
}
func add_f64(a: (sum: f64, n: u32), x: f64) -> ${result} => (a.sum + x, a.n + 1)
export func b(xs: []f64) -> u32 => fold(f64, xs, add_f64, 0.5).n`
    const byHand = `type AccF64 = (sum: f64, n: u32)
func fold_f64(xs: []f64, init: f64) -> AccF64 {
  let acc = AccF64(init, 0)
  for x in xs { acc = add_f64(acc, x) }
  return acc
}
func add_f64(a: (sum: f64, n: u32), x: f64) -> (sum: f64, n: u32) => (a.sum + x, a.n + 1)
export func b(xs: []f64) -> u32 => fold_f64(xs, 0.5).n`
    await expectSameWasm(fold('Acc(T)', '(sum: f64, n: u32)'), byHand)
    expect(instancesOf(fold('(sum: T, n: u32)', 'Acc(f64)'))).toEqual(['fold<f64|add_f64>'])
    expect(errorsOf(fold('Acc(T)', '(f64, u32)'))).toEqual([
      "'add_f64' is ((sum: f64, n: u32), f64) -> (f64, u32), but 'fold' needs step: (Acc(f64), f64) -> Acc(f64)",
    ])
    expect(errorsOf(fold('Acc(T)', '(total: f64, n: u32)'))).toEqual([
      "'add_f64' is ((sum: f64, n: u32), f64) -> (total: f64, n: u32), but 'fold' needs step: (Acc(f64), f64) -> Acc(f64)",
    ])
    // The names of several results that are no struct's fields are not compared.
    const div = `func both(comptime T: type, comptime f: (T, T) -> (T, T), a: T, b: T) -> T {
  let (q, r) = f(a, b)
  return q + r
}
func divmod(a: u32, b: u32) -> (q: u32, r: u32) => (a / b, a % b)
export func g(a: u32, b: u32) -> u32 => both(divmod, a, b)`
    expect(instancesOf(div)).toEqual(['both<u32|divmod>'])
  })

  test('a function a test declares cannot be given: it is no function of the module', () => {
    const source = `${SORT}data space = mut [0:u8; 64]
test "t" {
  func by_low_bits(a: i32, b: i32) -> bool => (a & 7) < (b & 7)
  sort((space as [*]mut i32)[0..4], by_low_bits)
}`
    expect(check(source).errors.map(e => e.message)).toEqual([
      "argument 2 of 'sort' must be a function declared at module level: 'by_low_bits' is declared inside a test",
    ])
    // It is used all the same: the call names it.
    expect(check(source).warnings.map(w => w.message).filter(m => m.includes('by_low_bits'))).toEqual([])
  })

  // The test's function replaces the module's in scope. The instance would
  // call the module's, a function other than the one the test named.
  test("nor can a test's function that has the name of a function of the module", () => {
    const source = `func twice(comptime T: type, comptime f: (T) -> T, x: T) -> T => f(f(x))
func helper(x: u32) -> u32 => x + 1
export func go() -> u32 => twice(helper, 1)
test "t" {
  func helper(x: u32) -> u32 => x + 10
  assert helper(1) == 11
  assert twice(helper, 1) == 21
}`
    expect(check(source).errors.map(e => e.message)).toEqual([
      "argument 1 of 'twice' must be a function declared at module level: 'helper' is declared inside a test",
    ])
    expect(check(source, { includeTests: false }).errors).toEqual([])
  })

  test('the parameter is not a value: it is called, or passed on', () => {
    const source = `func keep(comptime T: type, x: T, comptime f: (T) -> T) -> T {
  let g = f
  return f(x)
}
func inc(x: u32) -> u32 => x + 1
export func a() -> u32 => keep(1:u32, inc)`
    expect(errorsOf(source)).toEqual([
      "'f' is a comptime function parameter: it can only be called, or passed on for a comptime function parameter, in keep(T = u32, f = inc)",
    ])
  })

  test('what a declaration is refused for', () => {
    expect(errorsOf(`${SORT.replace('comptime before: (T, T) -> bool', 'comptime before: (T, T) -> bool, before: u32')}`)).toEqual([
      "parameter 'before' is declared twice",
    ])
    // A local of the parameter's name is refused as one of any parameter's is.
    const shadowed = `func f(comptime T: type, x: T, comptime g: (T) -> T) -> T {
  let g = x
  return g
}
func inc(x: u32) -> u32 => x + 1
export func a() -> u32 => f(1:u32, inc)`
    expect(errorsOf(shadowed)).toEqual(["'g' is already declared in this scope, in f(T = u32, g = inc)"])
    // The type it declares is resolved where the generic is, once.
    const unknown = `func f(comptime T: type, x: T, comptime g: (Nope) -> T) -> T => x
func inc(x: u32) -> u32 => x + 1
export func a() -> u32 => f(1:u32, inc) + f(u32, 2, inc)`
    expect(errorsOf(unknown)).toEqual(["unknown type 'Nope'"])
  })

  test('a loop variable in an instance cannot have the name of a parameter or a variable', () => {
    const source = `func each(comptime T: type, xs: []T, comptime g: (T) -> T) -> T {
  let t: T = 0
  for g in xs { t += g }
  for t in xs { }
  return t
}
func inc(x: u32) -> u32 => x + 1
export func a(xs: []u32) -> u32 => each(xs, inc)`
    expect(errorsOf(source)).toEqual([
      "'g' is already declared: a loop variable cannot reuse the name of a parameter, in each(T = u32, g = inc)",
      "'t' is already declared: a loop variable cannot reuse the name of a variable in scope, in each(T = u32, g = inc)",
    ])
  })

  test('the loops of an instance leave their names free after them', async () => {
    const source = `func twice(comptime T: type, xs: []T) -> T {
  let t: T = 0
  for x in xs { t += x }
  for x in xs { t += x }
  let x: T = 1
  return t + x
}
data a = [1:u32, 2, 3]
data b = [0.5, 1.5]
test "both instances" {
  assert twice(u32, a) == 13
  assert twice(f64, b) == 5
}`
    expect(errorsOf(source)).toEqual([])
    expect(await runTestsOfSource(source)).toEqual({ ran: ['both instances'], failed: [] })
  })

  test('the editor finds the parameter at its name', () => {
    const source = `${SORT}export func up(xs: []mut i32) { sort(xs, ascending) }`
    const result = check(source, { source })
    const def = source.indexOf('before: (T, T)')
    expect(result.references.get(def)).toEqual([source.indexOf('before(x, p[j - 1])')])
    // The function it was given is used, by the call that gives it.
    expect(result.references.get(result.symbolDefOffsets.get('ascending') as number)).toEqual([source.indexOf('ascending) }')])
    expect(result.warnings.map(w => w.message)).toEqual(["'descending' is never used"])
  })
})

describe('generic types and comptime functions in a program of two modules', () => {
  // Each module's generics are its own: an instance carries its module's
  // prefix, and calls the function of that name in its own module.
  test('an instance calls the function of its own module, under its module\'s prefix', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'encantis-generics-'))
    try {
      await writeFile(join(dir, 'lib.ents'), `func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
func sort(comptime T: type, xs: []mut T, comptime before: (T, T) -> bool) {
  let p = xs.ptr
  for i in xs.len {
    let x = p[i]
    let j = i
    while j > 0 && before(x, p[j - 1]) {
      p[j] = p[j - 1]
      j -= 1
    }
    p[j] = x
  }
}
func ascending(a: i32, b: i32) -> bool => a < b
func last(comptime T: type, v: *Vec(T)) -> T => v.ptr[v.len - 1]
export func sort_up(xs: []mut i32) { sort(xs, ascending) }
export func top(v: *(ptr: [*]mut i32, len: u32, cap: u32)) -> i32 => last(v)
`)
      const entry = join(dir, 'main.ents')
      await writeFile(entry, `import "./lib" (
  "sort_up" func sort_up(xs: []mut i32)
  "top" func top(v: *(ptr: [*]mut i32, len: u32, cap: u32)) -> i32
)
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
func descending(a: i32, b: i32) -> bool => a > b
func ascending(a: i32, b: i32) -> bool => a > b
func pick(comptime T: type, a: T, b: T, comptime before: (T, T) -> bool) -> T => if before(a, b) { a } else { b }
data space = mut [0:u8; 64]
export func run() -> i32 {
  let a = space as [*]mut i32
  a[0] = 3
  a[1] = 1
  a[2] = 2
  sort_up(a[0..3])
  let v: Vec(i32) = Vec(i32)(a, 3, 4)
  let h = (space as u32 + 32) as *mut Vec(i32)
  h.* = v
  return top(h) * 100 + pick(a[0], a[1], descending) * 10 + pick(a[0], a[1], ascending)
}
`)
      const load = await loadModule(entry)
      const check = typecheckProgram(load.modules, entry, { includeTests: false })
      expect(check.errors).toEqual([])
      const wat = programToWat(load.modules, check.results, entry)
      expectPlainWasm(wat)
      expect(funcs(wat)).toEqual([
        'descending', 'ascending', 'pick<i32|ascending>', 'pick<i32|descending>', 'run',
        'lib$sort<i32|ascending>', 'lib$ascending', 'lib$last<i32>', 'lib$sort_up', 'lib$top',
      ])
      expect(funcWat(wat, 'lib$sort<i32|ascending>')).toContain('(call $lib$ascending ')
      expect(funcWat(wat, 'pick<i32|ascending>')).toContain('(call $ascending ')
      const instance = await WebAssembly.instantiate(await WebAssembly.compile(await wasmOfWat(wat)))
      // lib sorts 3, 1, 2 upwards; the entry's own `ascending` says greater.
      expect((instance.exports.run as () => number)()).toBe(322)
    } finally {
      await rm(dir, { recursive: true })
    }
  })
})

describe('functions that share a name in a program of two modules', () => {
  test('each is exported under a name of its own and imported under the shared one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'encantis-overloads-'))
    try {
      // A function of the name `hash_bytes` that is not the exported one:
      // an import is found by the name of the export.
      await writeFile(join(dir, 'keys.ents'), `export "hash_u32" func hash(k: u32) -> u32 => k * 3
export "hash_bytes" func hash(k: []u8) -> u32 => k.len
func hash(k: u64) -> u32 => 7
func hash_bytes(k: []u8) -> u32 => 99
export func both(k: u64) -> u32 => k.hash() + hash(1:u32) + hash_bytes("") - 99
`)
      const entry = join(dir, 'main.ents')
      await writeFile(entry, `import "./keys" (
  "hash_u32" func hash(k: u32) -> u32
  "hash_bytes" func hash(k: []u8) -> u32
  "both" func both(k: u64) -> u32
)
func hash(k: f64) -> u32 => 100
func bucket(comptime K: type, k: K) -> u32 => k.hash()
export func run(s: []u8) -> u32 => bucket(5:u32) + bucket(s) * 10 + bucket(1.5:f64) + both(0) * 1000
`)
      const load = await loadModule(entry)
      const check = typecheckProgram(load.modules, entry, { includeTests: false })
      expect(check.errors).toEqual([])
      const wat = programToWat(load.modules, check.results, entry)
      expectPlainWasm(wat)
      expect(funcs(wat)).toEqual([
        'hash:f64', "bucket<''u8>", 'bucket<f64>', 'bucket<u32>', 'run',
        'keys$hash', "keys$hash:''u8", 'keys$hash:u64', 'keys$hash_bytes', 'keys$both',
      ])
      expect(funcWat(wat, "bucket<''u8>")).toContain("(call $keys$hash:''u8 ")
      expect(funcWat(wat, 'bucket<u32>')).toContain('(call $keys$hash ')
      expect(funcWat(wat, 'bucket<f64>')).toContain('(call $hash:f64 ')
      expect(funcWat(wat, 'keys$both')).toContain('(call $keys$hash:u64 ')
      const instance = await WebAssembly.instantiate(await WebAssembly.compile(await wasmOfWat(wat)))
      expect((instance.exports.run as (ptr: number, len: number) => number)(0, 4)).toBe(15 + 40 + 100 + 10000)
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  test('two exports of one name are an error of the module that has them, and of no module that imports one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'encantis-overloads-'))
    try {
      // The import was bound to the last export of the name, and the call
      // that fits the first was reported in the importer as well.
      await writeFile(join(dir, 'keys.ents'), 'export func hash(k: u32) -> u32 => k * 3\nexport func hash(k: []u8) -> u32 => k.len\n')
      const entry = join(dir, 'main.ents')
      await writeFile(entry, 'import "./keys" (\n  "hash" func hash(k: u32) -> u32\n)\nexport func f() -> u32 => hash(1:u32)\n')
      const load = await loadModule(entry)
      const check = typecheckProgram(load.modules, entry, { includeTests: false })
      expect([...check.results.values()].flatMap(result => result.errors.map(e => e.message))).toEqual([
        `export name 'hash' is used twice: give one an explicit name, as in export "hash_2" func hash(...)`,
      ])
    } finally {
      await rm(dir, { recursive: true })
    }
  })
})

describe('where an instance was required from', () => {
  test('an error in an instance carries the call that first asked for the instance', () => {
    const source = `type Pt = (q: i32, r: i32)
${MAX}export func f(a: Pt, b: Pt) -> Pt => max(a, b)
export func g(a: Pt, b: Pt) -> Pt => max(Pt, b, a)`
    expect(check(source).errors).toEqual([
      {
        offset: source.indexOf('a > b'),
        message: `${noOperator('>', 'Pt')}, in max(T = Pt)`,
        notes: [{ offset: source.indexOf('max(a, b)'), message: 'required from' }],
      },
    ])
  })

  test('and the calls that call was required from, four at most', () => {
    const source = `func f6(comptime T: type, a: T) -> bool => a > a
func f5(comptime T: type, a: T) -> bool => f6(a)
func f4(comptime T: type, a: T) -> bool => f5(a)
func f3(comptime T: type, a: T) -> bool => f4(a)
func f2(comptime T: type, a: T) -> bool => f3(a)
func f1(comptime T: type, a: T) -> bool => f2(a)
export func g(xs: []u8) -> bool => f1(xs)
export func h(x: u32) -> bool => f4(x)`
    const result = check(source)
    expect(result.errors.map(e => e.message)).toEqual([`${noOperator('>', '[]u8')}, in f6(T = []u8)`])
    // Innermost first: the call in f5 asked for f6, the call in f4 for f5, ...
    expect(result.errors[0].notes).toEqual(['f6(a)', 'f5(a)', 'f4(a)', 'f3(a)'].map(call => ({ offset: source.indexOf(call), message: 'required from' })))
    // Every position is in the source.
    for (const note of result.errors[0].notes ?? []) expect(note.offset).toBeLessThan(source.length)
  })

  test('a warning in an instance has them too, and an error outside an instance has none', () => {
    const source = `data buf = mut [0:u8; 16]
func clear(comptime T: type, n: u32, x: T) -> T {
  memset(buf, 0, n)
  return x
}
export func f(n: u32) -> u32 => clear(n, n) + nope`
    const result = check(source)
    expect(result.warnings.map(w => w.notes)).toEqual([[{ offset: source.indexOf('clear(n, n)'), message: 'required from' }]])
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors.some(e => 'notes' in e)).toBe(false)
  })
})

describe('a fixed array for T makes [*]T, []T and *[N]T tables', () => {
  const VEC = 'func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)\n'
  const rowNote = (table: string) =>
    `in a ${table} each element is a pointer to its row (reference 2.5): for packed rows use a struct with an array field, (cells: [3]i32), or *[3]i32 for the pointers`

  test('an element used as T is refused, with a note that names the rule and the ways round it', () => {
    const source = `${VEC}func get(comptime T: type, v: *Vec(T), i: u32) -> T => v.ptr[i]
func keep(comptime T: type, x: T) -> T => x
func pass(comptime T: type, v: *Vec(T)) -> T => keep(T, v.ptr[0])
func each(comptime T: type, s: []T) -> u32 {
  let n: u32 = 0
  for e in s {
    let x: T = e
    n += 1
  }
  return n
}
func second(comptime T: type, p: *[2]T) -> T => p[1]
export func a(v: *Vec([3]i32)) -> i32 => get(v, 0)[1] + pass(v)[0]
export func b(s: [][3]i32) -> u32 => each(s)
export func c(p: *[2][3]i32) -> i32 => second(p)[0]`
    const result = check(source)
    expect(result.errors.map(e => e.message)).toEqual([
      'cannot assign *mut [3]i32 to [3]i32, in get(T = [3]i32)',
      'argument 2: cannot assign *mut [3]i32 to [3]i32, in pass(T = [3]i32)',
      'cannot assign *[3]i32 to [3]i32, in each(T = [3]i32)',
      'cannot assign *[3]i32 to [3]i32, in second(T = [3]i32)',
    ])
    expect(result.errors.map(e => e.notes?.[0])).toEqual([
      { offset: source.indexOf('v.ptr[i]'), message: rowNote('[*]mut [3]i32') },
      { offset: source.indexOf('v.ptr[0]'), message: rowNote('[*]mut [3]i32') },
      { offset: source.indexOf('x: T = e') + 'x: T = '.length, message: rowNote('[][3]i32') },
      { offset: source.indexOf('p[1]'), message: rowNote('*[2][3]i32') },
    ])
    // The calls the instances were required from come after it.
    expect(result.errors.map(e => e.notes?.[1]?.message)).toEqual(Array(4).fill('required from'))
  })

  test('an element reached through its address, or compared with a T, gets the note too', () => {
    const source = `func at(comptime T: type, s: *[2]T) -> T {
  let p = &s[1]
  return p.*
}
func first(comptime T: type, s: []T) -> T {
  if let p = &s[0] { return p.* }
  return s[1] ?? s[0]
}
func same(comptime T: type, s: *[2]T, x: T) -> bool => s[0] == x
export func f(t: *[2][3]i32, u: [][3]i32) -> i32 => at(t)[0] + first(u)[1] + (same(t, [1, 2, 3]) as i32)`
    const result = check(source)
    expect(result.errors.map(e => e.message)).toEqual([
      'cannot assign *[3]i32 to [3]i32, in at(T = [3]i32)',
      'cannot assign *[3]i32 to [3]i32, in first(T = [3]i32)',
      // A row is no optional: the fallback's index has to be resolved
      // where it is taken (4.7), in an instance too.
      "index 0 on [][3]i32 requires 'if let' or '??': a slice's length is only known at run time (rows are not optional), in first(T = [3]i32)",
      'cannot assign *[3]i32 to [3]i32, in first(T = [3]i32)',
      "'==' cannot be applied to *[3]i32 and [3]i32, in same(T = [3]i32)",
    ])
    expect(result.errors.map(e => e.notes?.[0]?.message)).toEqual([
      rowNote('*[2][3]i32'), rowNote('[][3]i32'), 'required from', rowNote('[][3]i32'), rowNote('*[2][3]i32'),
    ])
  })

  // fix-round-2 types &p[i] of a many-pointer table as where the row pointer
  // is, a **[M]T: at the merge of claude/dec-latetypes such an address,
  // given where the generic wants a *T, lost the note it had on that branch.
  test('the address of an element of a many-pointer table, where a *T is wanted, gets the note too', () => {
    const source = `func at(comptime T: type, p: [*]T, i: u32) -> *T => &p[i]
export func f(p: [*][3]i32) -> i32 => at(p, 1)[2]`
    const result = check(source)
    expect(result.errors.map(e => e.message)).toEqual(['cannot assign **[3]i32 to *[3]i32, in at(T = [3]i32)'])
    expect(result.errors[0].notes?.[0]?.message).toBe(rowNote('[*][3]i32'))
  })

  test('a pointer to a T that is no element of a table gets no such note', () => {
    const source = `func load(comptime T: type, p: *T) -> T => p
export func f(p: *[3]i32) -> i32 => load(p)[0]`
    const result = check(source)
    expect(result.errors.map(e => e.message)).toEqual(['cannot assign *[3]i32 to [3]i32, in load(T = [3]i32)'])
    expect(result.errors[0].notes).toEqual([{ offset: source.indexOf('load(p)'), message: 'required from' }])
  })

  test('bytes counted with sizeof(T) are not the table: memcpy is checked against its pointers, memzero is refused', () => {
    const source = `data a: *mut [2][3]i32 = mut [[1, 2, 3], [4, 5, 6]]
data b: *[2][3]i32 = [[7, 8, 9], [10, 11, 12]]
data n: *mut [2]u32 = mut [1, 2]
func copy(comptime T: type, d: *mut [2]T, s: *[2]T) {
  memcpy(d, s, 2 * sizeof(T))
}
func clear(comptime T: type, p: *mut [2]T) {
  memzero(p)
}
export func f() {
  copy(a, b)
  clear(a)
  copy(n, n)
  clear(n)
}`
    const result = check(source)
    expect(result.errors.map(e => e.message)).toEqual([
      'memcpy length 24 exceeds buffer size 8 bytes, in copy(T = [3]i32)',
      'memzero dest: *mut [2][3]i32 is a table, its elements pointers to rows (reference 2.5): zero each row, for row in p { memzero(row) }, in clear(T = [3]i32)',
    ])
    const advice = 'for packed rows use a struct with an array field, (cells: [3]i32), or *[3]i32 for the pointers'
    expect(result.errors.map(e => e.notes?.[0])).toEqual([
      { offset: source.indexOf('d, s, 2'), message: `a *mut [2][3]i32 is a table of 2 pointers to rows, which lie apart (reference 2.5): ${advice}` },
      { offset: source.indexOf('p)\n}'), message: advice },
    ])
  })

  test('a length only known when the program runs warns with the same note, for a table only', () => {
    const source = `data a: *mut [2][3]i32 = mut [[1, 2, 3], [4, 5, 6]]
data b: *[2][3]i32 = [[7, 8, 9], [10, 11, 12]]
data n: *mut [2]u32 = mut [1, 2]
func fill(comptime T: type, d: *mut [2]T, s: *[2]T, k: u32) {
  memcpy(d, s, k * sizeof(T))
}
export func f(k: u32) {
  fill(a, b, k)
  fill(n, n, k)
}`
    const result = check(source)
    expect(result.errors).toEqual([])
    expect(result.warnings.map(w => w.message)).toEqual([
      'memcpy length is not a compile-time constant — cannot verify bounds (buffer is 8 bytes), in fill(T = [3]i32)',
      'memcpy length is not a compile-time constant — cannot verify bounds (buffer is 8 bytes), in fill(T = u32)',
    ])
    const advice = 'for packed rows use a struct with an array field, (cells: [3]i32), or *[3]i32 for the pointers'
    expect(result.warnings.map(w => w.notes?.[0])).toEqual([
      { offset: source.indexOf('d, s, k'), message: `a *mut [2][3]i32 is a table of 2 pointers to rows, which lie apart (reference 2.5): ${advice}` },
      { offset: source.indexOf('fill(n, n'), message: 'required from' },
    ])
  })

  test('outside a generic too, the note says to go row by row', () => {
    const source = `data a: *mut [2][3]i32 = mut [[1, 2, 3], [4, 5, 6]]
export func f() {
  memset(a, 0, 24)
}`
    expect(check(source).errors).toEqual([{
      offset: source.indexOf('24'),
      message: 'memset length 24 exceeds buffer size 8 bytes',
      notes: [{ offset: source.indexOf('a, 0'), message: 'a *mut [2][3]i32 is a table of 2 pointers to rows, which lie apart (reference 2.5): set the rows one by one, as the arrays they are' }],
    }])
  })
})

const ZC2_GENERIC = `data heap = mut [0:u8; 4096]
global top: u32 = 0
func alloc(n: u32) -> u32 {
  let p = (heap as u32) + top
  top += n
  return p
}
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
func vec(comptime T: type, cap: u32) -> *mut Vec(T) {
  let v = alloc(sizeof(Vec(T))) as *mut Vec(T)
  v.*.ptr = alloc(cap * sizeof(T)) as [*]mut T
  v.*.len = 0
  v.*.cap = cap
  return v
}
func push(comptime T: type, v: *mut Vec(T), x: T) {
  if v.*.len == v.*.cap {
    let moved = alloc(v.*.cap * 2 * sizeof(T)) as [*]mut T
    for i in v.*.len {
      moved[i] = v.*.ptr[i]
    }
    v.*.ptr = moved
    v.*.cap *= 2
  }
  v.*.ptr[v.*.len] = x
  v.*.len += 1
}
func items(comptime T: type, v: *Vec(T)) -> []mut T => v.*.ptr[0..v.*.len]
func sort(comptime T: type, xs: []mut T, comptime before: (T, T) -> bool) {
  let p = xs.ptr
  for i in xs.len {
    let x = p[i]
    let j = i
    while j > 0 && before(x, p[j - 1]) {
      p[j] = p[j - 1]
      j -= 1
    }
    p[j] = x
  }
}
func ascending(a: u64, b: u64) -> bool => a < b
func descending(a: u64, b: u64) -> bool => a > b
func shorter(a: []u8, b: []u8) -> bool => a.len < b.len
export func run(n: u32, up: bool) -> u64 {
  let v = vec(u64, 2)
  for i in n {
    push(v, i as u64)
  }
  if up {
    sort(items(v), ascending)
  } else {
    sort(u64, items(v), descending)
  }
  return v.*.ptr[0]
}
export func words(a: []u8, b: []u8) -> u32 {
  let w = vec([]u8, 1)
  push([]u8, w, a)
  push(w, b)
  sort(items(w), shorter)
  return w.*.ptr[0].len
}
`

const ZC2_BY_HAND = `data heap = mut [0:u8; 4096]
global top: u32 = 0
type VecU64 = (ptr: [*]mut u64, len: u32, cap: u32)
type VecBytes = (ptr: [*]mut []u8, len: u32, cap: u32)
func alloc(n: u32) -> u32 {
  let p = (heap as u32) + top
  top += n
  return p
}
func vec_bytes(cap: u32) -> *mut VecBytes {
  let v = alloc(sizeof(VecBytes)) as *mut VecBytes
  v.*.ptr = alloc(cap * sizeof([]u8)) as [*]mut []u8
  v.*.len = 0
  v.*.cap = cap
  return v
}
func vec_u64(cap: u32) -> *mut VecU64 {
  let v = alloc(sizeof(VecU64)) as *mut VecU64
  v.*.ptr = alloc(cap * sizeof(u64)) as [*]mut u64
  v.*.len = 0
  v.*.cap = cap
  return v
}
func push_bytes(v: *mut VecBytes, x: []u8) {
  if v.*.len == v.*.cap {
    let moved = alloc(v.*.cap * 2 * sizeof([]u8)) as [*]mut []u8
    for i in v.*.len {
      moved[i] = v.*.ptr[i]
    }
    v.*.ptr = moved
    v.*.cap *= 2
  }
  v.*.ptr[v.*.len] = x
  v.*.len += 1
}
func push_u64(v: *mut VecU64, x: u64) {
  if v.*.len == v.*.cap {
    let moved = alloc(v.*.cap * 2 * sizeof(u64)) as [*]mut u64
    for i in v.*.len {
      moved[i] = v.*.ptr[i]
    }
    v.*.ptr = moved
    v.*.cap *= 2
  }
  v.*.ptr[v.*.len] = x
  v.*.len += 1
}
func items_bytes(v: *VecBytes) -> []mut []u8 => v.*.ptr[0..v.*.len]
func items_u64(v: *VecU64) -> []mut u64 => v.*.ptr[0..v.*.len]
func sort_bytes_shorter(xs: []mut []u8) {
  let p = xs.ptr
  for i in xs.len {
    let x = p[i]
    let j = i
    while j > 0 && shorter(x, p[j - 1]) {
      p[j] = p[j - 1]
      j -= 1
    }
    p[j] = x
  }
}
func sort_u64_ascending(xs: []mut u64) {
  let p = xs.ptr
  for i in xs.len {
    let x = p[i]
    let j = i
    while j > 0 && ascending(x, p[j - 1]) {
      p[j] = p[j - 1]
      j -= 1
    }
    p[j] = x
  }
}
func sort_u64_descending(xs: []mut u64) {
  let p = xs.ptr
  for i in xs.len {
    let x = p[i]
    let j = i
    while j > 0 && descending(x, p[j - 1]) {
      p[j] = p[j - 1]
      j -= 1
    }
    p[j] = x
  }
}
func ascending(a: u64, b: u64) -> bool => a < b
func descending(a: u64, b: u64) -> bool => a > b
func shorter(a: []u8, b: []u8) -> bool => a.len < b.len
export func run(n: u32, up: bool) -> u64 {
  let v = vec_u64(2)
  for i in n {
    push_u64(v, i as u64)
  }
  if up {
    sort_u64_ascending(items_u64(v))
  } else {
    sort_u64_descending(items_u64(v))
  }
  return v.*.ptr[0]
}
export func words(a: []u8, b: []u8) -> u32 {
  let w = vec_bytes(1)
  push_bytes(w, a)
  push_bytes(w, b)
  sort_bytes_shorter(items_bytes(w))
  return w.*.ptr[0].len
}
`

// The same vector with the fields reached through the pointer, the header
// stored and loaded whole, and elements that are structs with a bool.
const NATURAL_GENERIC = `data space = mut [0:u8; 4096]
global top: u32 = 0
func alloc(n: u32) -> (p: u32) {
  top = (top + 7) & 0xFFFFFFF8
  p = (space as u32) + top
  top += n
}
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
func Slot(comptime K: type) -> type => (used: bool, hash: u32, key: K)
func vec(comptime T: type, cap: u32) -> *mut Vec(T) {
  let v = alloc(sizeof(Vec(T))) as *mut Vec(T)
  v.* = Vec(T)(alloc(cap * sizeof(T)) as [*]mut T, 0, cap)
  return v
}
func push(comptime T: type, v: *mut Vec(T), x: T) {
  if v.len == v.cap {
    let moved = alloc(v.cap * 2 * sizeof(T)) as [*]mut T
    for i in v.len {
      moved[i] = v.ptr[i]
    }
    v.ptr = moved
    v.cap *= 2
  }
  v.ptr[v.len] = x
  v.len += 1
}
func get(comptime T: type, v: *Vec(T), i: u32) -> T => v.ptr[i]
func header(comptime T: type, v: *Vec(T)) -> Vec(T) => v.*
export func slots(n: u32) -> u32 {
  let v = vec(Slot(u64), 1)
  for i in n {
    push(v, Slot(u64)(i % 2 == 0, i * 7, (i as u64) << 40))
  }
  let h = header(v)
  let last = get(v, h.len - 1)
  return if last.used { last.hash + h.cap } else { ((last.key >> 40) as u32) + h.len }
}
export func bytes(a: []u8, b: []u8) -> u32 {
  let w = vec([]u8, 1)
  push(w, a)
  push(w, b)
  return get(w, 1).len + header(w).cap
}
`

const NATURAL_BY_HAND = `data space = mut [0:u8; 4096]
global top: u32 = 0
func alloc(n: u32) -> (p: u32) {
  top = (top + 7) & 0xFFFFFFF8
  p = (space as u32) + top
  top += n
}
type SlotU64 = (used: bool, hash: u32, key: u64)
type VecSlot = (ptr: [*]mut SlotU64, len: u32, cap: u32)
type VecBytes = (ptr: [*]mut []u8, len: u32, cap: u32)
func vec_bytes(cap: u32) -> *mut VecBytes {
  let v = alloc(sizeof(VecBytes)) as *mut VecBytes
  v.* = VecBytes(alloc(cap * sizeof([]u8)) as [*]mut []u8, 0, cap)
  return v
}
func vec_slot(cap: u32) -> *mut VecSlot {
  let v = alloc(sizeof(VecSlot)) as *mut VecSlot
  v.* = VecSlot(alloc(cap * sizeof(SlotU64)) as [*]mut SlotU64, 0, cap)
  return v
}
func push_bytes(v: *mut VecBytes, x: []u8) {
  if v.len == v.cap {
    let moved = alloc(v.cap * 2 * sizeof([]u8)) as [*]mut []u8
    for i in v.len {
      moved[i] = v.ptr[i]
    }
    v.ptr = moved
    v.cap *= 2
  }
  v.ptr[v.len] = x
  v.len += 1
}
func push_slot(v: *mut VecSlot, x: SlotU64) {
  if v.len == v.cap {
    let moved = alloc(v.cap * 2 * sizeof(SlotU64)) as [*]mut SlotU64
    for i in v.len {
      moved[i] = v.ptr[i]
    }
    v.ptr = moved
    v.cap *= 2
  }
  v.ptr[v.len] = x
  v.len += 1
}
func get_bytes(v: *VecBytes, i: u32) -> []u8 => v.ptr[i]
func get_slot(v: *VecSlot, i: u32) -> SlotU64 => v.ptr[i]
func header_bytes(v: *VecBytes) -> VecBytes => v.*
func header_slot(v: *VecSlot) -> VecSlot => v.*
export func slots(n: u32) -> u32 {
  let v = vec_slot(1)
  for i in n {
    push_slot(v, SlotU64(i % 2 == 0, i * 7, (i as u64) << 40))
  }
  let h = header_slot(v)
  let last = get_slot(v, h.len - 1)
  return if last.used { last.hash + h.cap } else { ((last.key >> 40) as u32) + h.len }
}
export func bytes(a: []u8, b: []u8) -> u32 {
  let w = vec_bytes(1)
  push_bytes(w, a)
  push_bytes(w, b)
  return get_bytes(w, 1).len + header_bytes(w).cap
}
`

const DATA_GENERIC = `func Pair(comptime A: type, comptime B: type) -> type => (first: A, second: B)
global origin: Pair(i32, f64) = Pair(i32, f64)(1, 2.5)
data table = [Pair(u8, u16)(1, 2), Pair(u8, u16)(3, 4)]
export func a() -> f64 => origin.second
export func b() -> u32 => (table as [*]Pair(u8, u16))[1].second as u32
export func c(x: u16) -> u32 {
  let local: []Pair(u8, u16) = [Pair(u8, u16)(1, x), Pair(u8, u16)(3, 4)]
  return (local.ptr[0].second as u32) * 10 + (local.ptr[1].second as u32)
}
`

const DATA_BY_HAND = `type P = (first: u8, second: u16)
type Q = (first: i32, second: f64)
global origin: Q = Q(1, 2.5)
data table = [P(1, 2), P(3, 4)]
export func a() -> f64 => origin.second
export func b() -> u32 => (table as [*]P)[1].second as u32
export func c(x: u16) -> u32 {
  let local: []P = [P(1, x), P(3, 4)]
  return (local.ptr[0].second as u32) * 10 + (local.ptr[1].second as u32)
}
`

describe('zero cost, generic types and comptime function parameters', () => {
  // The size is that of the hand-written side compiled by the branch this one
  // stands on.
  test('a vector for two element types and a sort with three comparators are the module written by hand', async () => {
    expect(await expectSameWasm(ZC2_GENERIC, ZC2_BY_HAND)).toHaveLength(1314)
    const wat = watOfSource(ZC2_GENERIC)
    expect(funcs(wat)).toEqual([
      'alloc', "vec<''u8>", 'vec<u64>', "push<''u8>", 'push<u64>', "items<''u8>", 'items<u64>',
      "sort<''u8|shorter>", 'sort<u64|ascending>', 'sort<u64|descending>', 'ascending', 'descending', 'shorter', 'run', 'words',
    ])
    const { run: sorted } = await run(ZC2_GENERIC)
    expect(sorted(5, 1)).toBe(0n)
    expect(sorted(5, 0)).toBe(4n)
  })

  test('with fields through the pointer, the header stored and loaded whole, and struct elements', async () => {
    expect(await expectSameWasm(NATURAL_GENERIC, NATURAL_BY_HAND)).toHaveLength(907)
    const { slots } = await run(NATURAL_GENERIC)
    // The fifth slot is used: its hash, 4 * 7, and the capacity grown to 8.
    expect(slots(5)).toBe(28 + 8)
    // The fourth is not: its key, 3, and the length.
    expect(slots(4)).toBe(3 + 4)
  })

  test('generic types that nothing applies, or that only unused generics apply, add nothing', async () => {
    const unused = `${VEC}${PAIR}func Slot(comptime K: type) -> type => (used: bool, key: K)
func first(comptime T: type, v: *Vec(Pair(T, Slot(T)))) -> T => v.ptr[0].first
`
    await expectSameWasm(unused + DOC_BY_HAND, DOC_BY_HAND)
  })
})

// The stage 2 pair with every call that has a receiver written as a method
// call. The hand-written side is ZC2_BY_HAND itself.
const ZC2_METHODS = ZC2_GENERIC
  .replace('push(v, i as u64)', 'v.push(i as u64)')
  .replace('sort(items(v), ascending)', 'v.items().sort(ascending)')
  .replace('sort(u64, items(v), descending)', 'v.items().sort(u64, descending)')
  .replace('push([]u8, w, a)', 'w.push([]u8, a)')
  .replace('push(w, b)', 'w.push(b)')
  .replace('sort(items(w), shorter)', 'w.items().sort(shorter)')

// Two key types in one module: each instance calls the hash and the eq of its
// own key type, which the hand-written side names apart.
const OVERLOADS_GENERIC = `func hash(k: u32) -> u32 => k * 0x45d9f3b
func hash(k: []u8) -> (h: u32) {
  h = 0x811c9dc5
  for w in k {
    h = (h ^ (w as u32)) * 0x01000193
  }
}
func eq(a: u32, b: u32) -> bool => a == b
func eq(a: []u8, b: []u8) -> bool {
  return false when a.len != b.len
  for i in a.len {
    return false when a.ptr[i] != b.ptr[i]
  }
  return true
}
func bucket(comptime K: type, k: K, n: u32) -> u32 => k.hash() % n
func same(comptime K: type, a: K, b: K) -> bool => hash(a) == hash(b) && a.eq(b)

export func f(a: []u8, b: []u8) -> u32 => if same(a, b) { bucket(a, 16) } else { bucket(7:u32, 3) }
export func g(a: u32, b: u32) -> bool => same(u32, a, b)
`

const OVERLOADS_BY_HAND = `func hash_u32(k: u32) -> u32 => k * 0x45d9f3b
func hash_bytes(k: []u8) -> (h: u32) {
  h = 0x811c9dc5
  for w in k {
    h = (h ^ (w as u32)) * 0x01000193
  }
}
func eq_u32(a: u32, b: u32) -> bool => a == b
func eq_bytes(a: []u8, b: []u8) -> bool {
  return false when a.len != b.len
  for i in a.len {
    return false when a.ptr[i] != b.ptr[i]
  }
  return true
}
func bucket_bytes(k: []u8, n: u32) -> u32 => hash_bytes(k) % n
func bucket_u32(k: u32, n: u32) -> u32 => hash_u32(k) % n
func same_bytes(a: []u8, b: []u8) -> bool => hash_bytes(a) == hash_bytes(b) && eq_bytes(a, b)
func same_u32(a: u32, b: u32) -> bool => hash_u32(a) == hash_u32(b) && eq_u32(a, b)

export func f(a: []u8, b: []u8) -> u32 => if same_bytes(a, b) { bucket_bytes(a, 16) } else { bucket_u32(7:u32, 3) }
export func g(a: u32, b: u32) -> bool => same_u32(a, b)
`

describe('method-call syntax', () => {
  const PUSH = `${VEC}func push(comptime T: type, v: *mut Vec(T), x: T) {
  v.ptr[v.len] = x
  v.len += 1
}
func get(comptime T: type, v: *Vec(T), i: u32) -> T => v.ptr[i]
func items(comptime T: type, v: *Vec(T)) -> []T => v.ptr[0..v.len]
`
  const DOUBLE = 'func double(n: u32) -> u32 => n * 2\n'
  // What each call written with a receiver compiles as: the callee and how many arguments it is given
  const compiled = (source: string) => {
    const result = check(source)
    expect(result.errors.map(e => e.message)).toEqual([])
    const final = (call: (typeof result.calls extends Map<infer K, unknown> ? K : never)): string => {
      const next = result.calls.get(call)
      if (next?.kind === 'CallExpr') return final(next)
      return `${call.callee.kind === 'IdentExpr' ? call.callee.name : '?'}/${call.args.length}`
    }
    return [...result.calls.keys()].filter(c => c.callee.kind === 'MemberExpr').map(final)
  }

  test('x.f(a) is f(x, a) where x has no member f', () => {
    expect(compiled(`${DOUBLE}func add(a: u32, b: u32) -> u32 => a + b
export func f(x: u32) -> u32 => x.double() + x.add(3)`)).toEqual(['double/1', 'add/2'])
  })

  test('for a generic the receiver is the first argument that is not a comptime one, and decides its type', () => {
    expect(compiled(`${PUSH}export func f(v: *mut Vec(u8)) -> u8 {
  v.push(7)
  return v.get(0)
}`)).toEqual(['push<u8>/2', 'get<u8>/2'])
  })

  test('type arguments written after the receiver are the explicit form', () => {
    const source = `${PUSH}export func f(v: *mut Vec(u8), w: *mut Vec(u64)) -> u8 {
  v.push(u8, 9)
  w.push(u64, 9)
  return v.get(u8, 0)
}`
    expect(compiled(source)).toEqual(['push<u8>/2', 'push<u64>/2', 'get<u8>/2'])
    // As in push(u64, v, 9), the written type is what the receiver is checked against.
    expect(errorsOf(source.replace('w.push(u64, 9)', 'v.push(u64, 9)'))).toEqual(['receiver: cannot assign *mut Vec(u8) to *mut Vec(u64)'])
  })

  test('a comptime function parameter is written in either form, wherever it is declared', () => {
    const sort = `func first(comptime T: type, comptime before: (T, T) -> bool, xs: []T) -> T => if before(xs.ptr[0], xs.ptr[1]) { xs.ptr[0] } else { xs.ptr[1] }
func less(a: u8, b: u8) -> bool => a < b
`
    expect(compiled(`${sort}export func f(xs: []u8) -> u8 => xs.first(less) + xs.first(u8, less)`)).toEqual(['first<u8|less>/1', 'first<u8|less>/1'])
  })

  test('calls chain from left to right', () => {
    const source = `${PUSH}${DOUBLE}func total(xs: []u32) -> (s: u32) {
  for x in xs { s += x }
}
export func f(v: *Vec(u32)) -> u32 => v.items().total().double()`
    // The order the calls are recorded in says nothing: each is looked up by its node.
    expect(compiled(source).sort()).toEqual(['double/1', 'items<u32>/1', 'total/1'])
    expect(funcWat(watOfSource(source), 'f')).toContain('(call $double (call $total (call $items<u32> (local.get $v))))')
  })

  test('each receiver is evaluated once, before the arguments of its call', async () => {
    const source = `global n: u32 = 0
func tick() -> u32 {
  n += 1
  return n
}
func pair(a: u32, b: u32) -> u32 => a * 10 + b
export func once() -> u32 => tick().pair(tick())
export func chain() -> u32 => tick().pair(tick()).pair(tick()) * 100 + n`
    expect((await run(source)).once()).toBe(12)
    // pair(1, 2) = 12, then pair(12, 3) = 123, and tick ran three times
    expect((await run(source)).chain()).toBe(12303)
  })

  test('a field wins over a function of the same name', async () => {
    const source = `type Box = (size: u32, n: u32)
func size(b: Box) -> u32 => 99
func n(b: *Box) -> u32 => 98
export func a(b: Box) -> u32 => b.size
export func b(b: Box) -> u32 => size(b)
export func c(b: *Box) -> u32 => b.n + n(b)`
    expect(compiled(source)).toEqual([])
    const { a, b } = await run(source)
    expect(a(5, 6)).toBe(5)
    expect(b(5, 6)).toBe(99)
    // Called, the field is still the field, and the error says what was likely meant.
    expect(errorsOf(`${source}\nexport func d(b: Box) -> u32 => b.size()`)).toEqual([
      "cannot call non-function type: u32 ('size' is a field here, and a field wins over the function 'size': write size(...))",
    ])
  })

  test('what a slice and an array have built in are members too', () => {
    const source = `func len(xs: []u8) -> u32 => 7
func ptr(xs: *[4]u8) -> u32 => 8
func wid(xs: []u8) -> u32 => 9
data four = [1:u8, 2, 3, 4]
export func f(xs: []u8) -> u32 => xs.len + four.len + (four.ptr as u32) + xs.wid + len(xs) + ptr(four) + wid(xs)`
    expect(compiled(source)).toEqual([])
    // .wid of a slice is the width of an element (reference 2.5), so a call of
    // it is the field, as for any member.
    expect(errorsOf(`func wid(xs: []u8) -> u32 => 9\nfunc f(xs: []u8) -> u32 => xs.wid()`)).toEqual([
      "cannot call non-function type: int(1) ('wid' is a field here, and a field wins over the function 'wid': write wid(...))",
    ])
    expect(errorsOf(`func wid(xs: [][3]i32) -> u32 => 9\nfunc f(rows: [][3]i32) -> u32 => rows.wid()`)).toEqual([
      "cannot call non-function type: int(4) ('wid' is a field here, and a field wins over the function 'wid': write wid(...))",
    ])
  })

  test('a many-pointer has no length, so len is a function it can be the receiver of', () => {
    // .len of a [*]u8 is an error of its own: it is no member that could win.
    const len = 'func len(s: [*]u8) -> u32 => 3\n'
    expect(compiled(`${len}func f(s: [*]u8, sized: *[4]u8) -> u32 => s.len() + sized.len`)).toEqual(['len/1'])
    expect(errorsOf('func f(s: [*]u8) -> u32 => s.len()')).toEqual(["no field 'len' on type [*]u8, and no function 'len' accepts ([*]u8)"])
    // What it does have is still a member.
    expect(errorsOf('func ptr(s: [*]u8) -> u32 => 3\nfunc f(s: [*]u8) -> u32 => s.ptr()')).toEqual([
      "cannot call non-function type: [*]u8 ('ptr' is a field here, and a field wins over the function 'ptr': write ptr(...))",
    ])
  })

  test('the receiver is passed as written: no address is taken of a value', () => {
    expect(errorsOf(`${PUSH}export func f(v: Vec(u32)) { v.push(7) }`)).toEqual([
      'push takes *mut Vec(u32) first; the receiver is a Vec(u32), which is held in registers and has no address',
    ])
    // The same with the type argument written after the receiver.
    expect(errorsOf(`${PUSH}export func f(v: Vec(u32)) { v.push(u32, 7) }`)).toEqual([
      'push takes *mut Vec(u32) first; the receiver is a Vec(u32), which is held in registers and has no address',
    ])
    // A value of another type is an argument that does not fit, as in push(u8, v, 7).
    expect(errorsOf(`${PUSH}export func f(v: Vec(u32)) { v.push(u8, 7) }`)).toEqual([
      'receiver: cannot assign Vec(u32) to *mut Vec(u8)',
    ])
    expect(errorsOf(`type Pt = (q: i32, r: i32)
func norm(p: *Pt) -> i32 => p.q + p.r
export func f(p: Pt) -> i32 => p.norm()`)).toEqual([
      'norm takes *Pt first; the receiver is a Pt, which is held in registers and has no address',
    ])
  })

  test('nor is a pointer followed for a value', () => {
    expect(errorsOf(`type Pt = (q: i32, r: i32)
func norm(p: Pt) -> i32 => p.q + p.r
export func f(p: *Pt) -> i32 => p.norm()`)).toEqual(['receiver: cannot assign *Pt to Pt'])
    // p.* is the value.
    expect(compiled(`type Pt = (q: i32, r: i32)
func norm(p: Pt) -> i32 => p.q + p.r
export func f(p: *Pt) -> i32 => p.*.norm()`)).toEqual(['norm/1'])
  })

  test('the receiver gets the conversions any argument gets', async () => {
    const source = `func wide(n: u64) -> u64 => n + 1
func count(xs: []u8) -> u32 => xs.len
func first(p: *u32) -> u32 => p.*
data four = [1:u8, 2, 3, 4]
export func a(x: u8) -> u64 => x.wide()
export func b() -> u32 => four.count() + "ab".count()
export func c(p: *mut u32) -> u32 => p.first()`
    expect(compiled(source)).toEqual(['wide/1', 'count/1', 'count/1', 'first/1'])
    const { a, b } = await run(source)
    expect(a(255)).toBe(256n)
    expect(b()).toBe(6)
  })

  test('a builtin is called the same way, unless the program declares the name', async () => {
    const source = `export func a(x: f64) -> f64 => x.sqrt().max(1.5)
export func b(x: i32, y: i32) -> u8 => x.min(y).abs().clz()`
    const { a, b } = await run(source)
    expect(a(16)).toBe(4)
    expect(a(1)).toBe(1.5)
    expect(b(-3, 5)).toBe(30)
    expect(watOfSource(source)).toContain('(f64.max (f64.sqrt (local.get $x)) (f64.const 1.5))')
    expect(compiled(`func abs(x: i32) -> i32 => 1\nexport func a(x: i32) -> i32 => x.abs()`)).toEqual(['abs/1'])
  })

  test('what fails among a builtin\'s operands is reported as in the plain call', () => {
    // Whether `min` here is the builtin is asked before its operands are
    // checked; the answer must not swallow what they report.
    const hash = 'func hash(k: u32) -> u32 => k\nfunc hash(k: u64) -> u32 => 1\n'
    for (const operand of ['y.nope()', 'hash(z)', 'head(7)']) {
      const method = errorsOf(`${hash}${HEAD}export func f(x: u32, y: u32, z: f64) -> u32 => x.min(${operand})`)
      const plain = errorsOf(`${hash}${HEAD}export func f(x: u32, y: u32, z: f64) -> u32 => min(x, ${operand})`)
      expect(method.length).toBeGreaterThan(0)
      expect(method).toEqual(plain)
    }
  })

  test('each builtin of a chain keeps the type it computes in', async () => {
    // The calls of a chain all start where the chain does; what is recorded
    // for a builtin by place must not be shared between them.
    const { f } = await run('export func f(x: i64, y: u8) -> u8 => x.clz().max(y)')
    expect(f(1n, 3)).toBe(63)
    expect(f(-1n, 3)).toBe(3)
  })

  test('a comptime function parameter is called the same way inside the generic', () => {
    expect(instancesOf(`func pick(comptime T: type, a: T, b: T, comptime before: (T, T) -> bool) -> T => if a.before(b) { a } else { b }
func less(a: i32, b: i32) -> bool => a < b
export func f(a: i32, b: i32) -> i32 => a.pick(b, less)`)).toEqual(['pick<i32|less>'])
  })

  test('with neither a member nor a function of the name, one error says both', () => {
    expect(errorsOf(`type Pt = (q: i32, r: i32)\nexport func f(p: Pt, x: u32) -> u32 => p.area(x, 2)`)).toEqual([
      "no field 'area' on type Pt, and no function 'area' accepts (Pt, u32, int(2))",
    ])
    expect(errorsOf(`${DOUBLE}export func f(x: u32) -> u32 => x.dubble().double()`)).toEqual([
      "no field 'dubble' on type u32, and no function 'dubble' accepts (u32)",
    ])
    // A variable of the name is no function to call it by.
    expect(errorsOf('export func f(x: u32, g: u32) -> u32 => x.g()')).toEqual(["no field 'g' on type u32, and no function 'g' accepts (u32)"])
  })

  test('a receiver with an error of its own is that error alone', () => {
    expect(errorsOf(`${DOUBLE}export func f() -> u32 => nope.double().double()`)).toEqual(["unknown identifier 'nope'"])
    expect(errorsOf(`${DOUBLE}export func f(p: (q: u32)) -> u32 => p.r.double()`)).toEqual(["no field 'r' on type (q: u32)"])
  })

  test('the errors of the call are those of f(x, a), said of the call as it was written, at the name of the method', () => {
    // The receiver is the receiver, and the arguments are counted after it:
    // x.double(1) has one argument, not two.
    const source = `${DOUBLE}export func f(x: u32, y: f64) -> u32 => x.double(1) + y.double()`
    expect(check(source).errors.map(place)).toEqual([
      { offset: source.indexOf('double(1)'), message: "'double' expected 0 arguments after the receiver, got 1" },
      { offset: source.indexOf('y.double'), message: 'receiver: cannot assign f64 to u32' },
    ])
    const add = 'func add(n: u32, m: u32) -> u32 => n + m\n'
    expect(errorsOf(`${add}export func f(x: u32) -> u32 => x.add() + x.add(1.5)`)).toEqual([
      "'add' expected 1 argument after the receiver, got 0",
      'argument 1: cannot assign float(1.5) to u32',
    ])
    expect(errorsOf('func nothing() -> u32 => 0\nexport func f(x: u32) -> u32 => x.nothing()')).toEqual([
      "'nothing' expected 0 arguments, got 1: the receiver is one",
    ])
    expect(errorsOf(`${MAX}export func f(x: u32) -> u32 => x.max() + x.max(u32, 1.5) + x.max(u8, 3)`)).toEqual([
      "'max' expects 1 argument after the receiver, or 2 with its type argument written; got 0",
      'argument 2: cannot assign float(1.5) to u32',
      'receiver: cannot assign u32 to u8',
    ])
    expect(errorsOf(`${ZERO}export func f(x: u32) -> u32 => x.zero()`)).toEqual(["receiver of 'zero' must be a type: T is a type parameter"])
    // The plain call counts and numbers as it always did.
    expect(errorsOf(`${add}${MAX}export func f(x: u32) -> u32 => add(x) + add(x, 1.5) + max(x)`)).toEqual([
      "'add' expected 2 arguments, got 1",
      'argument 2: cannot assign float(1.5) to u32',
      "'max' expects 2 arguments, or 3 with its type argument written; got 1",
    ])
  })

  test('what a message suggests writing is in the form the call has', () => {
    const make = 'func make(comptime T: type, n: u32) -> T => n as T\n'
    expect(errorsOf(`${make}export func f(x: u32) -> u64 => x.make()`)).toEqual(["cannot infer T for 'make': write the type argument, as in x.make(u32)"])
    expect(errorsOf(`${make}export func f(x: u32) -> u64 => make(x)`)).toEqual(["cannot infer T for 'make': write the type argument, as in make(u32, ...)"])
    // A literal in parentheses is still the literal to give a type.
    expect(errorsOf(`${MAX}export func f() -> u32 => (3).max(6)`)).toEqual([
      "cannot infer T for 'max' from untyped literals: write .max(i32, ...) or give a literal its type (3:i32)",
    ])
    expect(errorsOf(`${MAX}export func f() -> u32 => max((3), 6)`)).toEqual([
      "cannot infer T for 'max' from untyped literals: write max(i32, ...) or give a literal its type (3:i32)",
    ])
  })

  test('every error of a call with a receiver is at the name of the method', () => {
    const source = `${PUSH}type Pt = (q: i32, r: i32)
func hash(k: u32) -> u32 => k
func hash(k: u64) -> u32 => 1
export func f(p: Pt, v: Vec(u32)) -> u32 {
  v.push(7)
  return p.q.area() + p.r.hash()
}`
    expect(check(source).errors.map(place)).toEqual([
      { offset: source.indexOf('push(7)'), message: 'push takes *mut Vec(u32) first; the receiver is a Vec(u32), which is held in registers and has no address' },
      { offset: source.indexOf('area()'), message: "no field 'area' on type i32, and no function 'area' accepts (i32)" },
      { offset: source.indexOf('hash()'), message: "no function 'hash' accepts (i32)" },
    ])
  })

  test('an error in an instance is required from the method, not from where its chain starts', () => {
    const source = `type Pt = (q: i32, r: i32)
${MAX}func id(comptime T: type, a: T) -> T => a
export func f(a: Pt, b: Pt) -> Pt => a.id().max(b)`
    expect(check(source).errors).toEqual([{
      offset: source.indexOf('a > b'),
      message: `${noOperator('>', 'Pt')}, in max(T = Pt)`,
      notes: [{ offset: source.indexOf('max(b)'), message: 'required from' }],
    }])
  })

  test('a long chain is checked in a time that grows with its length', () => {
    const chain = (calls: number, receiver: string) => `func inc(n: u32) -> u32 => n + 1
${MAX}export func f(x: u32) -> u32 => ${receiver}${'.inc().max(x)'.repeat(calls)}`
    expect(errorsOf(chain(60, 'x'))).toEqual([])
    expect(errorsOf(chain(60, 'nope'))).toEqual(["unknown identifier 'nope'"])
    // Each call looks at its receiver before it is checked. Where that look
    // walked the whole chain below, the start of the chain was read once for
    // every call after it: now as often for 80 calls as for 20.
    const shared = (calls: number) => `func inc(n: u32) -> u32 => n + 1
func inc(n: u64) -> u64 => n + 1
export func f(seed: u32) -> u32 => seed${'.inc()'.repeat(calls)}`
    for (const program of [(calls: number) => chain(calls / 2, 'seed').replace('x: u32', 'x: u32, seed: u32'), (calls: number) => chain(calls / 2, 'nope'), shared]) {
      const start = program(20).includes('nope') ? 'nope' : 'seed'
      expect(readsOf(program(80), start)).toBe(readsOf(program(20), start))
    }
  })

  test('a receiver that is one value only once the parameter says of what type is passed as the argument is', async () => {
    // By itself the `if` has branches of two types, and no members to look
    // for: it is the first argument of the function all the same.
    const total = `func total(xs: []u32) -> (s: u32) {
  for x in xs {
    s += x
  }
}
`
    const method = `${total}export func f(k: bool) -> u32 => (if k { [1, 2, 3] } else { [4, 5] }).total()`
    const plain = `${total}export func f(k: bool) -> u32 => total(if k { [1, 2, 3] } else { [4, 5] })`
    await expectSameWasm(method, plain)
    // The same where the name is shared, and where the function is generic
    // as far as a plain call of it goes.
    const shared = `${total}func total(x: u64) -> u32 => 1\n`
    await expectSameWasm(method.replace(total, shared), plain.replace(total, shared))
    const count = `${COUNT}export func f(k: bool) -> u32 => `
    expect(errorsOf(`${count}(if k { [1, 2, 3] } else { [4, 5] }).count(4)`)).toEqual(errorsOf(`${count}count(if k { [1, 2, 3] } else { [4, 5] }, 4)`))
    // Where nothing takes it, what is wrong with it is all that is said.
    expect(errorsOf(`${DOUBLE}export func f(k: bool) -> u32 => (if k { [1, 2, 3] } else { [4, 5] }).double()`)).toEqual([
      'branches have different types: [2]i32 and [3]i32 (cast one explicitly)',
    ])
  })

  test('a literal receiver is data where the function takes a pointer, as the same literal is as an argument', async () => {
    const first = 'func first(a: *[2]f64) -> f64 => a[0]\n'
    await expectSameWasm(`${first}export func f() -> f64 => [1, 2.5].first()`, `${first}export func f() -> f64 => first([1, 2.5])`)
    const len = 'func len3(a: *[3]u8) -> u32 => a.len\n'
    await expectSameWasm(`${len}export func f() -> u32 => "abc".len3() + [1:u8, 2, 3].len3()`, `${len}export func f() -> u32 => len3("abc") + len3([1:u8, 2, 3])`)
    // With the type argument of a generic written, the pointer type is known.
    const head = 'func head3(comptime T: type, a: *[3]T) -> T => a[0]\n'
    await expectSameWasm(`${head}export func f() -> u8 => [1:u8, 2, 3].head3(u8)`, `${head}export func f() -> u8 => head3(u8, [1:u8, 2, 3])`)
  })

  test('the method is used, and found from its name in the call', () => {
    const source = `${DOUBLE}${PUSH}export func f(v: *mut Vec(u32), x: u32) -> u32 {
  v.push(x.double())
  return v.get(0)
}`
    const result = check(source)
    expect(result.warnings.map(w => w.message)).toEqual(["'items' is never used"])
    const at = source.indexOf('double()')
    expect(result.symbolRefs.get(at)).toBe(source.indexOf('func double'))
    expect(result.symbolRefs.get(source.indexOf('push(x'))).toBe(source.indexOf('func push'))
    // What the editor shows there: the function as this call uses it.
    const callee = [...result.exprTypes].find(([e]) => e.kind === 'IdentExpr' && e.span.start === source.indexOf('push(x'))
    expect(callee && typeToString(callee[1])).toStartWith('func(v: *mut (ptr: [*]mut u32, ')
  })

  test('the method is used where its receiver is wrong, as the function is in f(x)', () => {
    // A receiver with an error of its own still names the function: that
    // error is said once, and nothing says the function is never used.
    const sum = 'data grid: *[2][3]i32 = [[7, 1, 2], [3, 4, 5]]\nfunc sum(r: *[3]i32) -> i32 => r[0] + r[1] + r[2]\n'
    const dbl = 'func dbl(n: u32) -> u32 => n * 2\n'
    for (const [method, plain] of [
      [`${sum}export func f(i: u32) -> i32 => grid[i].sum()`, `${sum}export func f(i: u32) -> i32 => sum(grid[i])`],
      [`${dbl}export func f() -> u32 => nope.dbl()`, `${dbl}export func f() -> u32 => dbl(nope)`],
    ]) {
      const m = check(method)
      expect(m.errors[0].message).toBe(check(plain).errors[0].message)
      expect(m.warnings).toEqual([])
      expect(check(plain).warnings).toEqual([])
      const name = method.includes('sum()') ? 'sum' : 'dbl'
      expect(m.symbolRefs.get(method.indexOf(`${name}()`))).toBe(method.indexOf(`func ${name}`))
    }
  })

  test('a method only a generic nobody calls uses is still used', () => {
    // Which of the two it would be is known only in an instance: both count.
    const result = check(`func hash(k: u32) -> u32 => k
func hash(k: u64) -> u32 => 1
func bucket(comptime K: type, k: K, n: u32) -> u32 => k.hash() % n`)
    expect(result.warnings.map(w => w.message)).toEqual(["'bucket' is never used"])
  })
})

describe('what a generic body calls is required of its type arguments', () => {
  const INDEX_OF = `func index_of(comptime T: type, xs: []T, x: T) -> u32 {
  for i, e in xs {
    return i when eq(e, x)
  }
  return xs.len
}
`
  const PT = 'type Pt = (q: i32, r: i32)\nfunc eq(a: Pt, b: Pt) -> bool => a.q == b.q && a.r == b.r\n'

  test('each instance calls the function for its own type, directly', () => {
    const source = `${PT}func eq(a: u32, b: u32) -> bool => a == b
${INDEX_OF}export func f(xs: []u32, ps: []Pt, p: Pt) -> u32 => index_of(xs, 3) + ps.index_of(p)`
    const wat = watOfSource(source)
    expectPlainWasm(wat)
    expect(funcs(wat)).toEqual(['eq', 'eq:u32|u32', 'index_of<<q:i32|r:i32>>', 'index_of<u32>', 'f'])
    expect(funcWat(wat, 'index_of<u32>')).toContain('(call $eq:u32|u32 ')
    expect(funcWat(wat, 'index_of<<q:i32|r:i32>>')).toContain('(call $eq ')
  })

  test('a type the function does not take is one error, with the instance named', () => {
    const source = `${PT}${INDEX_OF}export func f(xs: []u32) -> u32 => index_of(xs, 3)`
    expect(check(source).errors).toEqual([{
      offset: source.indexOf('eq(e, x)'),
      message: "no function 'eq' accepts (u32, u32), in index_of(T = u32)",
      notes: [{ offset: source.indexOf('index_of(xs, 3)'), message: 'required from' }],
    }])
  })

  test('so is a function that is not there at all', () => {
    expect(errorsOf(`${INDEX_OF}export func f(xs: []u32) -> u32 => index_of(xs, 3)`)).toEqual([
      "no function 'eq' accepts (u32, u32), in index_of(T = u32)",
    ])
    expect(errorsOf(`func bucket(comptime K: type, k: K, n: u32) -> u32 => k.hash() % n
export func f(x: f64) -> u32 => bucket(x, 4)`)).toEqual([
      "no field 'hash' on type f64, and no function 'hash' accepts (f64), in bucket(K = f64)",
    ])
  })

  test('it is said once for the instance, however many calls ask for it', () => {
    const source = `func hash(k: u32) -> u32 => k
func hash(k: []u8) -> u32 => k.len
func same(comptime K: type, a: K, b: K) -> bool => hash(a) == hash(b) && a.hash() == b.hash()
export func f(a: f64, b: f64) -> bool => same(a, b)
export func g(a: bool, b: bool) -> bool => same(a, b)`
    expect(check(source).errors.map(place)).toEqual([
      { offset: source.indexOf('hash(a)'), message: "no function 'hash' accepts (f64), in same(K = f64)" },
      { offset: source.indexOf('hash(a)'), message: "no function 'hash' accepts (bool), in same(K = bool)" },
    ])
  })

  test('each missing function is an error of its own', () => {
    expect(errorsOf(`${OVERLOADS_GENERIC}export func h(a: f64, b: f64) -> bool => same(a, b)`)).toEqual([
      "no function 'hash' accepts (f64), in same(K = f64)",
      "no function 'eq' accepts (f64, f64), in same(K = f64)",
    ])
  })

  test('a call with the wrong number of arguments is no requirement: it reads as in any function', () => {
    expect(errorsOf(`func eq(a: u32, b: u32) -> bool => a == b
${INDEX_OF.replace('eq(e, x)', 'eq(e)')}export func f(xs: []u32) -> u32 => index_of(xs, 3)`)).toEqual([
      "'eq' expected 2 arguments, got 1, in index_of(T = u32)",
    ])
  })

  test('an argument is converted as for any call of the function', async () => {
    const source = `func wide(n: u64) -> u64 => n + 1
func step(comptime T: type, x: T) -> u64 => wide(x) + x.wide()
export func f(x: u8) -> u64 => step(x) + step(x as u64)`
    const { f } = await run(source)
    expect(f(4)).toBe(20n)
  })

  test('an argument that is one value only once the parameter says of what type is passed as in any function', async () => {
    // By itself each `if` and the `match` has branches of two types and is
    // an error. What the body requires must not be asked of the argument alone.
    const helpers = `func slen(s: []u8) -> u32 => s.len
func total(xs: []u32) -> (s: u32) {
  for x in xs {
    s += x
  }
}
func first(p: (u32, u64)) -> u32 => p.0
`
    const body = 'slen(if k { "yes" } else { "no" }) + total(match k { true => [7], false => [8, 9] }) + first(if k { (1, 2) } else { (3, 4) })'
    const generic = `${helpers}func g(comptime T: type, c: T, k: bool) -> u32 => ${body}
export func f(c: u32, k: bool) -> u32 => g(c, k)`
    const byHand = `${helpers}func g_u32(c: u32, k: bool) -> u32 => ${body}
export func f(c: u32, k: bool) -> u32 => g_u32(c, k)`
    await expectSameWasm(generic, byHand)
    const { f } = await run(generic)
    expect(f(0, 1)).toBe(3 + 7 + 1)
    expect(f(0, 0)).toBe(2 + 17 + 3)
  })

  test('where an argument has an error of its own the call reads as in any function', () => {
    // Nothing is required of T here: what is wrong is in the arguments.
    expect(errorsOf(`func eq(a: u32, b: u32) -> bool => a == b
func g(comptime T: type, x: T) -> bool => eq(x, nope)
export func f(x: u32) -> bool => g(x)`)).toEqual(["unknown identifier 'nope', in g(T = u32)", 'argument 2: cannot assign i32 to u32, in g(T = u32)'])
  })

  test('a function value is not called in an instance either', () => {
    expect(errorsOf(`func apply(comptime T: type, f: (T) -> T, x: T) -> T => f(x)
func inc(a: u32) -> u32 => a + 1
export func g(x: u32) -> u32 => apply(inc, x)`)).toEqual([
      'calling a function value is not supported yet: only a function named directly, or a comptime function parameter (comptime f: (u32) -> u32), can be called, in apply(T = u32)',
    ])
  })

  test('a function that shares its name is not given for a comptime function parameter', () => {
    const source = `func pick(comptime T: type, a: T, b: T, comptime before: (T, T) -> bool) -> T => if before(a, b) { a } else { b }
func less(a: i32, b: i32) -> bool => a < b
func less(a: f64, b: f64) -> bool => a < b
export func f(a: i32, b: i32) -> i32 => pick(a, b, less)`
    const result = check(source)
    expect(result.errors.map(e => e.message)).toEqual([
      "argument 3 of 'pick' must be the name of a function: before is a comptime function parameter ('less' has several overloads)",
    ])
    expect(result.warnings).toEqual([])
  })
})

describe('zero cost, method calls and functions that share a name', () => {
  test('the stage 2 program written with method calls is the same module written by hand', async () => {
    expect(ZC2_METHODS).not.toBe(ZC2_GENERIC)
    expect(ZC2_METHODS.match(/\.(push|items|sort)\(/g)).toHaveLength(9)
    expect(await expectSameWasm(ZC2_METHODS, ZC2_BY_HAND)).toHaveLength(1314)
  })

  test('x.f(a) and f(x, a) are the same code', async () => {
    const plain = await wasmOfSource(ZC2_GENERIC)
    expect(Buffer.from(await wasmOfSource(ZC2_METHODS)).equals(Buffer.from(plain))).toBe(true)
    // Scratch locals are named after the place that needs them, so the text
    // differs there and the bytes do not.
    const methods = `func double(n: u32) -> u32 => n * 2
func total(xs: []u32) -> (s: u32) {
  for x in xs { s += x }
}
export func f(xs: []u32, a: u32, b: u32) -> u32 => xs.ptr[1..3].total() + (a + 1).min(b).double() + xs.total().double().double()`
    const calls = methods.replace(/=> xs\.ptr.*$/, '=> total(xs.ptr[1..3]) + double(min(a + 1, b)) + double(double(total(xs)))')
    expect(calls).not.toBe(methods)
    await expectSameWasm(methods, calls)
  })

  test('each instance calling the function for its own key type is the module written by hand', async () => {
    expect(await expectSameWasm(OVERLOADS_GENERIC, OVERLOADS_BY_HAND)).toHaveLength(354)
    expect(funcs(watOfSource(OVERLOADS_GENERIC))).toEqual([
      'hash', "hash:''u8", 'eq', "eq:''u8|''u8", "bucket<''u8>", 'bucket<u32>', "same<''u8>", 'same<u32>', 'f', 'g',
    ])
  })

  test('a function that shares its name and that nothing calls is still one function, as written by hand', async () => {
    await expectSameWasm(
      'func hash(k: u32) -> u32 => k\nfunc hash(k: u64) -> u32 => 1\nexport func f(x: u64) -> u32 => x.hash()',
      'func hash_u32(k: u32) -> u32 => k\nfunc hash_u64(k: u64) -> u32 => 1\nexport func f(x: u64) -> u32 => hash_u64(x)',
    )
  })

  test('an exported function that shares its name is exported under the name it is given', async () => {
    const source = 'export func hash(k: u32) -> u32 => k\nexport "hash_wide" func hash(k: u64) -> u32 => 1'
    const { hash, hash_wide } = await run(source)
    expect(hash(7)).toBe(7)
    expect(hash_wide(7n)).toBe(1)
    await expectSameWasm(source, 'export func hash(k: u32) -> u32 => k\nexport func hash_wide(k: u64) -> u32 => 1')
  })
})

// What the review of the branches below changed, met inside generic code that
// uses generic types, constructors on them and comptime function parameters.
// Each program is also the module written by hand.
describe('a value in parentheses, a repeat, a match, an if let and a store, with generic types', () => {
  const POINT = 'func Pt(comptime T: type) -> type => (x: T, y: T)\nfunc Box(comptime T: type) -> type => (v: T)\n'

  test('a constructor in parentheses is the struct it builds, and fills named results in order', async () => {
    const generic = `data room = mut [0:u8; 64]
${POINT}func mk(comptime T: type, a: T, b: T) -> Pt(T) {
  let p = (Pt(T)(a, b))
  return ((p))
}
func second(comptime T: type, a: T, b: T) -> T => (Pt(T)(a, b)).y
func first(comptime P: type, a: i32, b: i32) -> i32 {
  let p: P = (P(a, b))
  return p.x
}
func put(comptime T: type, at: *mut Box(T), x: T) { at.* = (Box(T)(x)) }
func two(comptime T: type, a: T, b: T) -> (lo: T, hi: T) => (Pt(T)(y: a, x: b))
export func f(a: i32, b: i32) -> i32 {
  let p = mk(a, b)
  put(room as *mut Box(i32), second(a, b) + first(Pt(i32), a, b))
  let (lo, hi) = two(a, b)
  return p.x * 10000 + p.y * 1000 + (room as *Box(i32)).v * 100 + lo * 10 + hi
}
`
    const byHand = `data room = mut [0:u8; 64]
type Pt = (x: i32, y: i32)
type Box = (v: i32)
func mk(a: i32, b: i32) -> Pt {
  let p = (Pt(a, b))
  return ((p))
}
func second(a: i32, b: i32) -> i32 => (Pt(a, b)).y
func first(a: i32, b: i32) -> i32 {
  let p: Pt = (Pt(a, b))
  return p.x
}
func put(at: *mut Box, x: i32) { at.* = (Box(x)) }
func two(a: i32, b: i32) -> (lo: i32, hi: i32) => (Pt(y: a, x: b))
export func f(a: i32, b: i32) -> i32 {
  let p = mk(a, b)
  put(room as *mut Box, second(a, b) + first(a, b))
  let (lo, hi) = two(a, b)
  return p.x * 10000 + p.y * 1000 + (room as *Box).v * 100 + lo * 10 + hi
}
`
    await expectSameWasm(generic, byHand)
    const { f } = await run(generic)
    // mk: (3, 4); stored: 4 + 3; two: x = 4 fills lo, y = 3 fills hi.
    expect(f(3, 4)).toBe(34743)
  })

  test('the type that is called, in parentheses, is the type inside', async () => {
    // As for a type argument (see 'a type in parentheses is the type
    // inside'), and as a value in parentheses is the value inside.
    const generic = `${POINT}type Q = (x: i32, y: i32)
export func f(a: i32, b: i32) -> i32 => (Pt(i32))(a, b).x * 100 + ((Q))(a, b).y * 10 + (Box(i32))(a).v
`
    const byHand = `type Pt = (x: i32, y: i32)
type Box = (v: i32)
export func f(a: i32, b: i32) -> i32 => Pt(a, b).x * 100 + Pt(a, b).y * 10 + Box(a).v
`
    await expectSameWasm(generic, byHand)
    expect((await run(generic)).f(3, 4)).toBe(343)
    expect(errorsOf(`${POINT}export func f(a: i32) -> i32 => (Box(i32))(Box(i32)(a)).v`)).toEqual([
      'field v: cannot assign Box(i32) to i32',
    ])
  })

  test('a repeat literal of constructors stores what is only known when the program runs', async () => {
    const generic = `${POINT}func fill(comptime T: type, a: T, b: T) -> T {
  let d: *[3]Pt(T) = [Pt(T)(a, b); 3]
  return d[2].y
}
func wide(comptime T: type, n: i32) -> T {
  let d: *[2]Box(T) = [Box(T)(n); 2]
  return d[1].v
}
func rep(comptime T: type, v: T) -> T {
  let d: []T = [(v); 2]
  return d[1] ?? v
}
export func f(a: u8, b: u8, n: i32) -> i64 {
  let p = rep((Pt(i32)(n, n + 1)))
  return wide(i64, n) * 1000 + (fill(a, b) as i64) * 100 + (p.x * 10 + p.y) as i64
}
`
    const byHand = `type Pt8 = (x: u8, y: u8)
type Pt32 = (x: i32, y: i32)
type Box = (v: i64)
func fill(a: u8, b: u8) -> u8 {
  let d: *[3]Pt8 = [Pt8(a, b); 3]
  return d[2].y
}
func wide(n: i32) -> i64 {
  let d: *[2]Box = [Box(n); 2]
  return d[1].v
}
func rep(v: Pt32) -> Pt32 {
  let d: []Pt32 = [(v); 2]
  return d[1] ?? v
}
export func f(a: u8, b: u8, n: i32) -> i64 {
  let p = rep((Pt32(n, n + 1)))
  return wide(n) * 1000 + (fill(a, b) as i64) * 100 + (p.x * 10 + p.y) as i64
}
`
    await expectSameWasm(generic, byHand)
    const { f } = await run(generic)
    expect(f(5, 6, 2)).toBe(2000n + 600n + 23n)
    expect(f(5, 6, -2)).toBe(-2000n + 600n - 21n)
    // The repeated value is an element of the instance's literal.
    const bad = (body: string) => errorsOf(`${POINT}func bad(comptime T: type, n: i32) -> u32 {\n  ${body}\n  return d.len\n}\nexport func f(n: i32) -> u32 => bad(i64, n)`)
    expect(bad('let d: []Box(T) = [Box(T)(true); 3]')).toEqual(['field v: cannot assign bool to i64, in bad(T = i64)'])
    expect(bad('let d: []Box(T) = [n; 3]')).toEqual(['cannot assign i32 to Box(i64), in bad(T = i64)'])
    expect(bad('let d: []Box(T) = [Box(T)(n); 3]')).toEqual([])
  })

  test('a slice field takes a (ptr, len) pair in a constructor, in a function and in data', async () => {
    const generic = `data room = mut [7:u8; 16]
func Named(comptime T: type) -> type => (name: []u8, value: T)
data table = [Named(u16)(("abc", 2), 513), Named(u16)("xyz", 7), (Named(u16)(name: ("q", 1), value: 9))]
func wrap(comptime T: type, p: [*]u8, n: u32, x: T) -> Named(T) => (Named(T)(((p, n)), x))
export func f(i: u32, n: u32) -> u32 {
  let t = (table as [*]Named(u16))[i]
  let w = wrap(room as [*]u8, n, 5:u8)
  return t.name.len * 100000 + (t.name[0] ?? 0) as u32 * 100 + t.value as u32 * 1000000 + w.name.len * 10 + w.value as u32
}
`
    const byHand = `data room = mut [7:u8; 16]
type Named = (name: []u8, value: u16)
type Named8 = (name: []u8, value: u8)
data table = [Named(("abc", 2), 513), Named("xyz", 7), (Named(name: ("q", 1), value: 9))]
func wrap(p: [*]u8, n: u32, x: u8) -> Named8 => (Named8(((p, n)), x))
export func f(i: u32, n: u32) -> u32 {
  let t = (table as [*]Named)[i]
  let w = wrap(room as [*]u8, n, 5:u8)
  return t.name.len * 100000 + (t.name[0] ?? 0) as u32 * 100 + t.value as u32 * 1000000 + w.name.len * 10 + w.value as u32
}
`
    await expectSameWasm(generic, byHand)
    const { f } = await run(generic)
    expect(f(0, 3)).toBe(513000000 + 200000 + 9700 + 35)
    expect(f(1, 3)).toBe(7000000 + 300000 + 12000 + 35)
    expect(f(2, 4)).toBe(9000000 + 100000 + 11300 + 45)
    // A tuple that is no pair is no slice, and neither is a constructor.
    expect(errorsOf(`func Pr(comptime A: type, comptime B: type) -> type => (a: A, b: B)
func bad(comptime T: type, p: [*]T, n: u32) -> []T => Pr([*]T, u32)(p, n)
export func f(p: [*]u8) -> u32 => bad(p, 1).len`)).toEqual(['cannot assign Pr([*]u8, u32) to []u8, in bad(T = u8)'])
  })

  const VEC_AT = `data room = mut [0:u8; 256]
global calls: u32 = 0
${VEC}${PAIR}func bump() -> u32 {
  calls += 1
  return calls
}
func make(comptime T: type, at: u32, len: u32) -> *mut Vec(T) {
  let v = ((room as u32) + at) as *mut Vec(T)
  v.* = Vec(T)(((room as u32) + at + 16) as [*]mut T, len, 8)
  return v
}
`
  const VEC_AT_BY_HAND = `data room = mut [0:u8; 256]
global calls: u32 = 0
type Vec = (ptr: [*]mut u16, len: u32, cap: u32)
type Pair = (first: u16, second: u32)
func bump() -> u32 {
  calls += 1
  return calls
}
func make(at: u32, len: u32) -> *mut Vec {
  let v = ((room as u32) + at) as *mut Vec
  v.* = Vec(((room as u32) + at + 16) as [*]mut u16, len, 8)
  return v
}
`

  test('a match on a field of a Vec(T), and on a subject of several values', async () => {
    const generic = `${VEC_AT}func kind(comptime T: type, v: *Vec(T)) -> u32 => match v.len {
  0 => 10
  1, 2 => 20
  _ => 30
}
func whole(comptime T: type, v: *Vec(T)) -> u32 => match v.* { _ => 5 }
func built(comptime T: type, x: T) -> u32 => match Pair(T, u32)(x, bump()) { _ => calls }
func mark(comptime T: type, v: *mut Vec(T), x: T) -> T {
  v.ptr[(match bump() { 2 => 1:u32, _ => 2 }) & 3] = x
  let d: *[2]T = [(match v.len { 0 => x, _ => v.ptr[1] }); 2]
  return d[1]
}
export func f(n: u32, x: u16) -> u32 {
  let v = make(u16, 0, n)
  return kind(v) * 10000 + whole(v) * 1000 + built(x) * 100 + mark(v, x) as u32
}
`
    const byHand = `${VEC_AT_BY_HAND}func kind(v: *Vec) -> u32 => match v.len {
  0 => 10
  1, 2 => 20
  _ => 30
}
func whole(v: *Vec) -> u32 => match v.* { _ => 5 }
func built(x: u16) -> u32 => match Pair(x, bump()) { _ => calls }
func mark(v: *mut Vec, x: u16) -> u16 {
  v.ptr[(match bump() { 2 => 1:u32, _ => 2 }) & 3] = x
  let d: *[2]u16 = [(match v.len { 0 => x, _ => v.ptr[1] }); 2]
  return d[1]
}
export func f(n: u32, x: u16) -> u32 {
  let v = make(0, n)
  return kind(v) * 10000 + whole(v) * 1000 + built(x) * 100 + mark(v, x) as u32
}
`
    await expectSameWasm(generic, byHand)
    const { f } = await run(generic)
    // The call in the constructor that is matched runs once, and the one in
    // the index once more: the element stored is the one read back.
    expect(f(3, 77)).toBe(300000 + 5000 + 100 + 77)
    expect((await run(generic)).f(0, 9)).toBe(100000 + 5000 + 100 + 9)
  })

  test('an if let over an optional applied type meets the type that is wanted', async () => {
    const generic = `data bytes = mut [0:u8; 8]
${VEC_AT}func head(comptime T: type, v: ?*Vec(T), zero: T) -> Pair(T, u32) {
  let p: Pair(T, u32) = if let w = v { (w.ptr[0], w.len) } else { (zero, 0) }
  return p
}
func count(comptime T: type, v: ?*Vec(T), small: i8, big: u32) -> i64 {
  let n: i64 = if let w = v { w.len } elif big == 0 { small } else { big }
  return n
}
func stamp(comptime T: type, v: ?*Vec(T)) -> u8 {
  memcpy(bytes, if let w = v { "ABCD" } else { ("abcd") }, 4)
  return bytes[1]
}
export func f(some: bool, x: u16, big: u32) -> i64 {
  let made = make(u16, 0, 3)
  made.ptr[0] = x
  let v: ?*Vec(u16) = if some { made } else { 0 }
  let p = head(v, 9)
  return count(v, -1, big) * 1000000 + (p.first as u32 * 1000 + p.second * 100 + stamp(v) as u32) as i64
}
`
    const byHand = `data bytes = mut [0:u8; 8]
${VEC_AT_BY_HAND}func head(v: ?*Vec, zero: u16) -> Pair {
  let p: Pair = if let w = v { (w.ptr[0], w.len) } else { (zero, 0) }
  return p
}
func count(v: ?*Vec, small: i8, big: u32) -> i64 {
  let n: i64 = if let w = v { w.len } elif big == 0 { small } else { big }
  return n
}
func stamp(v: ?*Vec) -> u8 {
  memcpy(bytes, if let w = v { "ABCD" } else { ("abcd") }, 4)
  return bytes[1]
}
export func f(some: bool, x: u16, big: u32) -> i64 {
  let made = make(0, 3)
  made.ptr[0] = x
  let v: ?*Vec = if some { made } else { 0 }
  let p = head(v, 9)
  return count(v, -1, big) * 1000000 + (p.first as u32 * 1000 + p.second * 100 + stamp(v) as u32) as i64
}
`
    await expectSameWasm(generic, byHand)
    const { f } = await run(generic)
    expect(f(1, 7, 5)).toBe(3000000n + 7000n + 300n + 66n)
    expect(f(0, 7, 4000000000)).toBe(4000000000000000n + 9000n + 98n)
    expect(f(0, 7, 0)).toBe(-1000000n + 9000n + 98n)
    expect(errorsOf(`${VEC}func bad(comptime T: type, v: ?*Vec(T), f: f64) -> u32 {
  let n: u32 = if let w = v { w.len } else { f }
  return n
}
export func f(v: ?*Vec(u8)) -> u32 => bad(v, 0.5)`)).toEqual(['cannot assign f64 to u32, in bad(T = u8)'])
  })

  test('a Vec(T) stored through its pointer is computed whole, and goes where the target pointed', async () => {
    const generic = `${VEC_AT}func later(comptime T: type, v: *mut Vec(T), c: bool) -> u32 {
  v.* = Vec(T)(0 as [*]mut T, 1, if c {
    v.len = 8
    v.ptr = 64 as [*]mut T
    2
  } else { 2 })
  return (v.ptr as u32) * 100 + v.len * 10 + v.cap
}
func grown(comptime T: type, v: *mut Vec(T), comptime grow: (*mut Vec(T)) -> u32) -> u32 {
  v.* = Vec(T)(0 as [*]mut T, 1, grow(v))
  return (v.ptr as u32) * 100 + v.len * 10 + v.cap
}
func double(v: *mut Vec(u16)) -> u32 {
  v.len = 9
  v.ptr = 32 as [*]mut u16
  return 4
}
func moved(comptime T: type, p: *mut Vec(T), q: *mut Vec(T), c: bool) -> u32 {
  let cur = p
  cur.* = if c {
    cur = q
    Vec(T)(0 as [*]mut T, 1, 2)
  } else { Vec(T)(0 as [*]mut T, 3, 4) }
  return p.len * 1000 + p.cap * 100 + q.len * 10 + q.cap
}
export func f(c: bool) -> u32 => later(make(u16, 0, 0), c) * 1000000 + grown(make(u16, 64, 0), double) * 10000 + moved(make(u16, 128, 0), make(u16, 192, 0), c)
`
    const byHand = `${VEC_AT_BY_HAND}func later(v: *mut Vec, c: bool) -> u32 {
  v.* = Vec(0 as [*]mut u16, 1, if c {
    v.len = 8
    v.ptr = 64 as [*]mut u16
    2
  } else { 2 })
  return (v.ptr as u32) * 100 + v.len * 10 + v.cap
}
func grown(v: *mut Vec) -> u32 {
  v.* = Vec(0 as [*]mut u16, 1, double(v))
  return (v.ptr as u32) * 100 + v.len * 10 + v.cap
}
func double(v: *mut Vec) -> u32 {
  v.len = 9
  v.ptr = 32 as [*]mut u16
  return 4
}
func moved(p: *mut Vec, q: *mut Vec, c: bool) -> u32 {
  let cur = p
  cur.* = if c {
    cur = q
    Vec(0 as [*]mut u16, 1, 2)
  } else { Vec(0 as [*]mut u16, 3, 4) }
  return p.len * 1000 + p.cap * 100 + q.len * 10 + q.cap
}
export func f(c: bool) -> u32 => later(make(0, 0), c) * 1000000 + grown(make(64, 0)) * 10000 + moved(make(128, 0), make(192, 0), c)
`
    await expectSameWasm(generic, byHand)
    const { f } = await run(generic)
    // What a later field wrote on its way is overwritten by the store, and
    // the store goes to the Vec the target named before the value moved it.
    expect(f(1)).toBe(12 * 1000000 + 14 * 10000 + 1208)
    expect(f(0)).toBe(12 * 1000000 + 14 * 10000 + 3408)
  })

  test('a comparator given at compile time runs once in the subject of a match', async () => {
    const generic = `global calls: u32 = 0
${PAIR}func order(a: i32, b: i32) -> i32 {
  calls += 1
  return if a < b { -1 } elif a > b { 1 } else { 0 }
}
func pick(comptime T: type, comptime cmp: (T, T) -> i32, a: T, b: T) -> T => match cmp(a, b) {
  -1 => b
  1 => a
  _ => a
}
func both(comptime T: type, comptime cmp: (T, T) -> i32, a: T, b: T) -> Pair(T, i32) {
  let lo = a
  let d: i32 = 0
  set (lo, d) = ((match cmp(a, b) { 1 => b, _ => a }), max(match cmp(a, b) { 1 => 5, _ => 6 }, 2))
  return Pair(T, i32)(lo, d)
}
export func f(a: i32, b: i32) -> i32 {
  let p = both(order, a, b)
  return pick(order, a, b) * 1000 + p.first * 100 + p.second * 10 + calls as i32
}
`
    const byHand = `global calls: u32 = 0
type Pair = (first: i32, second: i32)
func order(a: i32, b: i32) -> i32 {
  calls += 1
  return if a < b { -1 } elif a > b { 1 } else { 0 }
}
func pick(a: i32, b: i32) -> i32 => match order(a, b) {
  -1 => b
  1 => a
  _ => a
}
func both(a: i32, b: i32) -> Pair {
  let lo = a
  let d: i32 = 0
  set (lo, d) = ((match order(a, b) { 1 => b, _ => a }), max(match order(a, b) { 1 => 5, _ => 6 }, 2))
  return Pair(lo, d)
}
export func f(a: i32, b: i32) -> i32 {
  let p = both(a, b)
  return pick(a, b) * 1000 + p.first * 100 + p.second * 10 + calls as i32
}
`
    await expectSameWasm(generic, byHand)
    expect((await run(generic)).f(3, 4)).toBe(4000 + 300 + 60 + 3)
    expect((await run(generic)).f(4, 3)).toBe(4000 + 300 + 50 + 3)
    expect(errorsOf(`func inc(x: u32) -> u32 => x + 1
func bad(comptime T: type, comptime f: (T) -> T, x: T) -> T => match f(x) {
  1.5 => x
  _ => x
}
export func g(x: u32) -> u32 => bad(inc, x)`)).toEqual(['cannot match u32 against float(1.5), in bad(T = u32, f = inc)'])
  })

  test('a field of a constructor is selected: a part beside it that could trap still runs', async () => {
    const generic = `${PAIR}func Buf(comptime T: type) -> type => (items: []T, used: u32)
func first(comptime T: type, x: T, n: u32) -> T => Pair(T, u32)(x, 100 / n).first
func head(comptime P: type, x: i32, n: i32) -> i32 => (P(x, x % n)).first
func used(comptime T: type, p: [*]T, n: u32) -> u32 => Buf(T)((p, 8 / n), 1).used
export func f(x: f64, n: u32) -> f64 => first(x, n) + (head(Pair(i32, i32), 7, n as i32) + used(8 as [*]u16, n) as i32) as f64
`
    const byHand = `type PairF = (first: f64, second: u32)
type PairI = (first: i32, second: i32)
type Buf = (items: []u16, used: u32)
func first(x: f64, n: u32) -> f64 => PairF(x, 100 / n).first
func head(x: i32, n: i32) -> i32 => (PairI(x, x % n)).first
func used(p: [*]u16, n: u32) -> u32 => Buf((p, 8 / n), 1).used
export func f(x: f64, n: u32) -> f64 => first(x, n) + (head(7, n as i32) + used(8 as [*]u16, n) as i32) as f64
`
    await expectSameWasm(generic, byHand)
    const { f } = await run(generic)
    expect(f(1.5, 4)).toBe(9.5)
    expect(() => f(1.5, 0)).toThrow()
  })
})

// A pointer or slice whose element is a fixed array is a table of row
// pointers (reference 2.5, Nesting). An applied type is the type its body
// names, so a table inside a generic type, or one that a type argument makes,
// is a table by the same rule, and the instance is the table code by hand.
describe('tables inside generic types, constructors and comptime functions', () => {
  test('a generic struct with a table field, built by a constructor given a table', async () => {
    const generic = `data cells8: *mut [2][3]u8 = mut [[1, 2, 3], [4, 5, 6]]
data cells32: *mut [2][3]i32 = mut [[10, 20, 30], [40, 50, 60]]
func Board(comptime T: type) -> type => (cells: *mut [2][3]T, n: u32)
func board(comptime T: type, m: *mut [2][3]T) -> Board(T) => Board(T)(m, m.len * 100 + m.wid)
func put(comptime T: type, b: Board(T), i: u32#2, j: u32#3, v: T) {
  b.cells[i][j] = v
}
func total(comptime T: type, b: Board(T)) -> T {
  let t: T = 0
  for r in b.cells {
    t += r[0] + r[1] + r[2]
  }
  return t
}
export func a(i: u32#2, j: u32#3, v: u8) -> u32 {
  let b = board(cells8)
  put(b, i, j, v)
  return (b.cells[i][j] as u32) * 1000 + total(b) as u32
}
export func c(i: u32#2, j: u32#3, v: i32) -> i32 {
  let b = board(cells32)
  put(b, i, j, v)
  return total(b) * 1000 + b.n as i32
}
`
    const byHand = `data cells8: *mut [2][3]u8 = mut [[1, 2, 3], [4, 5, 6]]
data cells32: *mut [2][3]i32 = mut [[10, 20, 30], [40, 50, 60]]
type B32 = (cells: *mut [2][3]i32, n: u32)
type B8 = (cells: *mut [2][3]u8, n: u32)
func board32(m: *mut [2][3]i32) -> B32 => B32(m, m.len * 100 + m.wid)
func board8(m: *mut [2][3]u8) -> B8 => B8(m, m.len * 100 + m.wid)
func put32(b: B32, i: u32#2, j: u32#3, v: i32) {
  b.cells[i][j] = v
}
func put8(b: B8, i: u32#2, j: u32#3, v: u8) {
  b.cells[i][j] = v
}
func total32(b: B32) -> i32 {
  let t: i32 = 0
  for r in b.cells {
    t += r[0] + r[1] + r[2]
  }
  return t
}
func total8(b: B8) -> u8 {
  let t: u8 = 0
  for r in b.cells {
    t += r[0] + r[1] + r[2]
  }
  return t
}
export func a(i: u32#2, j: u32#3, v: u8) -> u32 {
  let b = board8(cells8)
  put8(b, i, j, v)
  return (b.cells[i][j] as u32) * 1000 + total8(b) as u32
}
export func c(i: u32#2, j: u32#3, v: i32) -> i32 {
  let b = board32(cells32)
  put32(b, i, j, v)
  return total32(b) * 1000 + b.n as i32
}
`
    await expectSameWasm(generic, byHand)
    const { a, c } = await run(generic)
    // Row 1 of cells8 becomes [4, 5, 9]; n is N * 100 + the width of a row pointer.
    expect(a(1, 2, 9)).toBe(9024)
    expect(c(1, 0, 7)).toBe(177204)
  })

  test('a generic type as the row: *[2]Row(T) and []Row(T) are tables, a range of one a slice of rows', async () => {
    const generic = `data grid: *[2]Row(i32) = [[1, 2, 3], [4, 5, 6]]
data lines: []Row(u16) = [[7, 8, 9], [1, 1, 1], [2, 0, 2]]
func Row(comptime T: type) -> type => [3]T
func pick(comptime T: type, s: []Row(T), i: u32, j: u32#3) -> T => if let r = s[i] { r[j] } else { 0 }
func back(comptime T: type, m: *[2]Row(T), i: u32) -> *[3]T => m[i] ?? m[1]
func tail(comptime T: type, m: *[2]Row(T)) -> []Row(T) => m[1..2]
export func a(i: u32, j: u32#3) -> u16 => pick(lines, i, j)
export func b(i: u32, j: u32#3) -> i32 => back(grid, i)[j] * 10 + tail(grid).len as i32 + grid.wid as i32 * 100
`
    const byHand = `data grid: *[2][3]i32 = [[1, 2, 3], [4, 5, 6]]
data lines: [][3]u16 = [[7, 8, 9], [1, 1, 1], [2, 0, 2]]
func pick(s: [][3]u16, i: u32, j: u32#3) -> u16 => if let r = s[i] { r[j] } else { 0 }
func back(m: *[2][3]i32, i: u32) -> *[3]i32 => m[i] ?? m[1]
func tail(m: *[2][3]i32) -> [][3]i32 => m[1..2]
export func a(i: u32, j: u32#3) -> u16 => pick(lines, i, j)
export func b(i: u32, j: u32#3) -> i32 => back(grid, i)[j] * 10 + tail(grid).len as i32 + grid.wid as i32 * 100
`
    await expectSameWasm(generic, byHand)
    const { a, b } = await run(generic)
    expect([a(0, 1), a(2, 2), a(3, 0)]).toEqual([8, 2, 0])
    expect([b(0, 2), b(5, 0)]).toEqual([431, 441])
  })

  test('Vec([3]i32) holds row pointers, and Vec(*[3]i32) is a Vec of them', async () => {
    // [*]mut T with T = [3]i32 is [*]mut [3]i32, a table: an element is a
    // *mut [3]i32 at a stride of 4, not a [3]i32 at a stride of sizeof(T).
    const generic = `data space = mut [0:u8; 64]
data grid: *mut [3][3]i32 = mut [[1, 2, 3], [4, 5, 6], [7, 8, 9]]
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
func at(comptime T: type, v: *Vec(T), i: u32) -> T => v.ptr[i]
func row(comptime T: type, v: *Vec(T), i: u32) -> *mut T => v.ptr[i]
func width(comptime T: type, v: *Vec(T)) -> u32 => v.ptr.wid * 100 + sizeof(T)
export func a(i: u32, j: u32#3) -> i32 {
  let v = space as *mut Vec([3]i32)
  v.* = Vec([3]i32)(grid, 3, 3)
  return row(v, i)[j] * 1000 + width(v) as i32
}
export func b(j: u32#3) -> i32 {
  let v = ((space as u32) + 16) as *mut Vec(*[3]i32)
  v.* = Vec(*[3]i32)(((space as u32) + 32) as [*]mut *[3]i32, 0, 3)
  for r in grid {
    v.ptr[2 - v.len] = r
    v.len += 1
  }
  return at(v, 0)[j] * 10 + width(v) as i32
}
`
    const byHand = `data space = mut [0:u8; 64]
data grid: *mut [3][3]i32 = mut [[1, 2, 3], [4, 5, 6], [7, 8, 9]]
type VecP = (ptr: [*]mut *[3]i32, len: u32, cap: u32)
type VecR = (ptr: [*]mut [3]i32, len: u32, cap: u32)
func at(v: *VecP, i: u32) -> *[3]i32 => v.ptr[i]
func row(v: *VecR, i: u32) -> *mut [3]i32 => v.ptr[i]
func widthR(v: *VecR) -> u32 => v.ptr.wid * 100 + sizeof([3]i32)
func widthP(v: *VecP) -> u32 => v.ptr.wid * 100 + sizeof(*[3]i32)
export func a(i: u32, j: u32#3) -> i32 {
  let v = space as *mut VecR
  v.* = VecR(grid, 3, 3)
  return row(v, i)[j] * 1000 + widthR(v) as i32
}
export func b(j: u32#3) -> i32 {
  let v = ((space as u32) + 16) as *mut VecP
  v.* = VecP(((space as u32) + 32) as [*]mut *[3]i32, 0, 3)
  for r in grid {
    v.ptr[2 - v.len] = r
    v.len += 1
  }
  return at(v, 0)[j] * 10 + widthP(v) as i32
}
`
    await expectSameWasm(generic, byHand)
    const { a, b } = await run(generic)
    expect(a(1, 2)).toBe(6412)
    expect(b(1)).toBe(484)
    // What is written for any T and returns the element is refused for a row type, as by hand.
    expect(errorsOf(`func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
func at(comptime T: type, v: *Vec(T), i: u32) -> T => v.ptr[i]
export func f(v: *Vec([3]i32)) -> i32 => at(v, 0)[0]`)).toEqual(['cannot assign *mut [3]i32 to [3]i32, in at(T = [3]i32)'])
  })

  test('comptime functions given rows and tables, and filling a mutable table', async () => {
    const generic = `data rows: [][3]i32 = [[1, 2, 3], [4, 5, 6], [7, 8, 9]]
data board: *mut [2][3]u8 = mut [[0; 3]; 2]
func fold(comptime R: type, s: []R, comptime f: (*R) -> i32) -> i32 {
  let t = 0
  for r in s {
    t = t * 10 + f(r)
  }
  return t
}
func fill(comptime T: type, m: *mut [2][3]T, i: u32#2, comptime g: (u32, u32) -> T) {
  let r = m[i]
  for j in 3 {
    r[j] = g(i, j)
  }
}
func first(r: *[3]i32) -> i32 => r[0]
func last(r: *[3]i32) -> i32 => r[2]
func mul(i: u32, j: u32) -> u8 => ((i + 1) * (j + 2)) as u8
export func a() -> i32 => fold(rows, first) * 1000 + fold(rows, last)
export func b(i: u32#2, j: u32#3) -> u8 {
  fill(board, 1, mul)
  return board[i][j]
}
`
    const byHand = `data rows: [][3]i32 = [[1, 2, 3], [4, 5, 6], [7, 8, 9]]
data board: *mut [2][3]u8 = mut [[0; 3]; 2]
func fold_first(s: [][3]i32) -> i32 {
  let t = 0
  for r in s {
    t = t * 10 + first(r)
  }
  return t
}
func fold_last(s: [][3]i32) -> i32 {
  let t = 0
  for r in s {
    t = t * 10 + last(r)
  }
  return t
}
func fill(m: *mut [2][3]u8, i: u32#2) {
  let r = m[i]
  for j in 3 {
    r[j] = mul(i, j)
  }
}
func first(r: *[3]i32) -> i32 => r[0]
func last(r: *[3]i32) -> i32 => r[2]
func mul(i: u32, j: u32) -> u8 => ((i + 1) * (j + 2)) as u8
export func a() -> i32 => fold_first(rows) * 1000 + fold_last(rows)
export func b(i: u32#2, j: u32#3) -> u8 {
  fill(board, 1)
  return board[i][j]
}
`
    await expectSameWasm(generic, byHand)
    const { a, b } = await run(generic)
    expect(a()).toBe(147369)
    // Row 1 is filled; row 0, its own row of zeros, is not.
    expect([b(1, 2), b(0, 2)]).toEqual([8, 0])
  })

  test('a deeper table in a generic struct, and the table rules inside an instance', async () => {
    const generic = `data cube: *[2][2][3]i32 = [[[1, 2, 3], [4, 5, 6]], [[7, 8, 9], [10, 11, 12]]]
func Cube(comptime T: type) -> type => (m: *[2][2][3]T, tag: T)
func at(comptime T: type, c: Cube(T), i: u32#2, j: u32#2, k: u32#3) -> T => c.m[i][j][k] + c.tag
func widths(comptime T: type, c: Cube(T)) -> u32 => c.m.wid * 100 + c.m[0].wid * 10 + c.m[0][0].wid
export func a(i: u32#2, j: u32#2, k: u32#3) -> i32 => at(Cube(i32)(cube, 100), i, j, k)
export func w() -> u32 => widths(Cube(i32)(cube, 0))
`
    const byHand = `data cube: *[2][2][3]i32 = [[[1, 2, 3], [4, 5, 6]], [[7, 8, 9], [10, 11, 12]]]
type Cube = (m: *[2][2][3]i32, tag: i32)
func at(c: Cube, i: u32#2, j: u32#2, k: u32#3) -> i32 => c.m[i][j][k] + c.tag
func widths(c: Cube) -> u32 => c.m.wid * 100 + c.m[0].wid * 10 + c.m[0][0].wid
export func a(i: u32#2, j: u32#2, k: u32#3) -> i32 => at(Cube(cube, 100), i, j, k)
export func w() -> u32 => widths(Cube(cube, 0))
`
    await expectSameWasm(generic, byHand)
    const { a, w } = await run(generic)
    expect([a(1, 0, 2), a(0, 1, 0)]).toEqual([109, 104])
    expect(w()).toBe(444)

    expect(errorsOf(`data grid: *[2][3]i32 = [[1, 2, 3], [4, 5, 6]]
func Board(comptime T: type) -> type => (cells: *[2][3]T, n: u32)
func whole(comptime T: type, b: Board(T)) -> [2][3]T => b.cells.*
func lit(comptime T: type, x: T) -> T {
  let m: *[2][2]T = [[x, 1], [2, 3]]
  return m[1][1]
}
func row(comptime T: type, b: Board(T), i: u32) -> *[3]T => b.cells[i]
export func f(x: u8, i: u32) -> u8 => lit(x) + whole(Board(i32)(grid, 0))[0][0] as u8 + row(Board(i32)(grid, 0), i)[0] as u8`)).toEqual([
      'a row of *[2][2]u8 is laid out at compile time: its values must be constants, in lit(T = u8)',
      'cannot use .* on *[2][3]i32: a table holds pointers to rows that lie apart — load one row with [i].*, in whole(T = i32)',
      "runtime index on *[2][3]i32 requires 'if let' or '??' (rows are not optional), in row(T = i32)",
    ])
  })
})

describe('method calls on tables', () => {
  // What is said of a call with a receiver is what is said of the call
  // written with the receiver as its first argument, at the same place.
  const said = (source: string) => check(source).errors.map((e) => `${source.slice(e.offset, e.offset + 9)}: ${e.message}`)

  test('a table written out with a row known only at run time is a literal as a receiver too, not a value without an address', () => {
    const row = 'a row of *[2][3]i32 is laid out at compile time: its values must be constants'
    const tsum = 'func tsum(m: *[2][3]i32) -> i32 => m[1][2]\n'
    const g = 'func g(comptime T: type, m: *[2][3]T) -> T => m[1][0]\n'
    for (const [method, plain] of [
      [`${tsum}export func a(x: i32) -> i32 => [[x, 2, 3], [4, 5, 6]].tsum()`, `${tsum}export func a(x: i32) -> i32 => tsum([[x, 2, 3], [4, 5, 6]])`],
      [`${tsum}export func a(x: i32) -> i32 => ([[1, 2, 3], [x, 5, 6]]).tsum()`, `${tsum}export func a(x: i32) -> i32 => tsum(([[1, 2, 3], [x, 5, 6]]))`],
      [`${tsum}export func a(x: i32) -> i32 => [[x; 3]; 2].tsum()`, `${tsum}export func a(x: i32) -> i32 => tsum([[x; 3]; 2])`],
      [`${g}export func a(x: i32) -> i32 => [[x, 1, 2], [3, 4, 5]].g(i32)`, `${g}export func a(x: i32) -> i32 => g(i32, [[x, 1, 2], [3, 4, 5]])`],
    ]) {
      expect(said(method)).toHaveLength(1)
      expect(said(method)[0]).toEndWith(`: ${row}`)
      expect(said(method)).toEqual(said(plain))
    }
  })

  test('a row is the receiver as the row pointer m[i] is, and what a table has built in is a member', async () => {
    const decls = `func sum(r: *[3]i32) -> i32 => r[0] + r[1] + r[2]
func fill(r: *mut [3]i32, v: i32) {
  for j in 3 {
    r[j] = v + (j as i32)
  }
}
func cell(m: *[2][3]i32, i: u32#2, j: u32#3) -> i32 => m[i][j]
func double(n: u32) -> u32 => n * 2
func firsts(rows: [][3]u16) -> (t: u32) {
  t = 0
  for r in rows {
    t = t * 100 + (r[0] as u32)
  }
}
data grid: *[2][3]i32 = [[1, 2, 3], [4, 5, 6]]
data board: *mut [2][3]i32 = mut [[0; 3]; 2]
data rows: [][3]u16 = [[10, 20, 30], [40, 50, 60], [70, 80, 90]]
data tab: *[3][3]u16 = [[11, 21, 31], [41, 51, 61], [71, 81, 91]]
`
    const method = `${decls}export func a(i: u32) -> i32 => (grid[i] ?? grid[0]).sum() * 100 + grid.cell(1, 2)
export func b(v: i32) -> i32 {
  board[0].fill(v)
  board[1].fill(v * 10)
  let s = 0:i32
  for row in board {
    s = s * 1000 + row.sum()
  }
  return s
}
export func c(i: u32) -> u32 => grid.len.double() * 100 + grid.wid.double() * 10 + (if let r = rows[i] { r.len } else { 0 }) + tab[1..].firsts() * 1000
`
    const plain = `${decls}export func a(i: u32) -> i32 => sum(grid[i] ?? grid[0]) * 100 + cell(grid, 1, 2)
export func b(v: i32) -> i32 {
  fill(board[0], v)
  fill(board[1], v * 10)
  let s = 0:i32
  for row in board {
    s = s * 1000 + sum(row)
  }
  return s
}
export func c(i: u32) -> u32 => double(grid.len) * 100 + double(grid.wid) * 10 + (if let r = rows[i] { r.len } else { 0 }) + firsts(tab[1..]) * 1000
`
    await expectSameWasm(method, plain)
    const { a, b, c } = await run(method)
    expect([a(1), a(2)]).toEqual([1506, 606])
    expect(b(1)).toBe(6033)
    // .len is 2 rows, .wid the 4 bytes of a row pointer
    expect([c(0), c(3)]).toEqual([4171483, 4171480])
    expect(errorsOf(`func len(m: *[2][3]i32) -> u32 => 9\ndata grid: *[2][3]i32 = [[1, 2, 3], [4, 5, 6]]\nexport func f() -> u32 => grid.len()`)).toEqual([
      "cannot call non-function type: int(2) ('len' is a field here, and a field wins over the function 'len': write len(...))",
    ])
  })

  test('functions that share a name tell a table, a packed block and a flat array apart, and a row from a slice', async () => {
    const data = `data t: *[2][3]i32 = [[1, 2, 3], [4, 5, 6]]
data p: *[2x3]i32 = [[7, 8, 9], [10, 11, 12]]
data s: *[6]i32 = [13, 14, 15, 16, 17, 18]
data u: *mut [2][3]i32 = mut [[1, 2, 3], [4, 5, 6]]
data flat: []i32 = [7, 8, 9, 10]
`
    const shared = `func corner(m: *[2][3]i32) -> i32 => m[1][2] * 100 + m[0][0]
func corner(m: *[2x3]i32) -> i32 => m[1][2] * 1000 + m[0][1]
func corner(m: *[6]i32) -> i32 => m[5] * 10000 + m[2]
func view(m: [][3]i32) -> u32 => m.len * 10 + m.ptr.wid
func view(m: []i32) -> u32 => 1000 + m.len
func pick(r: *[3]i32) -> i32 => r[2]
func pick(r: []i32) -> i32 => 100 + (r.len as i32)
${data}export func a() -> i32 => t.corner() + p.corner() + s.corner() + u.corner()
export func b() -> u32 => t.view() * 1000000 + p.view() * 1000 + s.view()
export func c(i: u32#2) -> i32 => t[i].pick() * 1000 + flat.pick() + u[0].corner_row()
func corner_row(r: *mut [3]i32) -> i32 => r[0] * 10000
`
    const byHand = `func corner_t(m: *[2][3]i32) -> i32 => m[1][2] * 100 + m[0][0]
func corner_p(m: *[2x3]i32) -> i32 => m[1][2] * 1000 + m[0][1]
func corner_s(m: *[6]i32) -> i32 => m[5] * 10000 + m[2]
func view_t(m: [][3]i32) -> u32 => m.len * 10 + m.ptr.wid
func view_s(m: []i32) -> u32 => 1000 + m.len
func pick_r(r: *[3]i32) -> i32 => r[2]
func pick_s(r: []i32) -> i32 => 100 + (r.len as i32)
${data}export func a() -> i32 => corner_t(t) + corner_p(p) + corner_s(s) + corner_t(u)
export func b() -> u32 => view_t(t) * 1000000 + view_s(p) * 1000 + view_s(s)
export func c(i: u32#2) -> i32 => pick_r(t[i]) * 1000 + pick_s(flat) + corner_row(u[0])
func corner_row(r: *mut [3]i32) -> i32 => r[0] * 10000
`
    await expectSameWasm(shared, byHand)
    const { a, b, c } = await run(shared)
    expect(a()).toBe(193225)
    // the table is a slice of 2 rows; the packed block and the flat array are 6 elements
    expect(b()).toBe(25007006)
    expect(c(1)).toBe(16104)
    // None of the three is the other, and a row of a mutable table is taken by both of these.
    expect(errorsOf(`func f(m: *[2x3]i32) -> u32 => 2\nfunc f(m: *[6]i32) -> u32 => 3\n${data}export func a() -> u32 => t.f()`)).toEqual([
      "no function 'f' accepts (*[2][3]i32)",
    ])
    expect(errorsOf(`func f(m: *[2x3]i32) -> u32 => 2\n${data}export func a() -> u32 => t.f()`)).toEqual(['receiver: cannot assign *[2][3]i32 to *[2x3]i32'])
    expect(errorsOf(`func pick(r: *[3]i32) -> i32 => r[2]\nfunc pick(r: []i32) -> i32 => 1\n${data}export func a() -> i32 => u[1].pick()`)).toEqual([
      "'pick' is ambiguous for (*mut [3]i32)",
    ])
  })

  test('a row decides T of a generic *[3]T or []T, and a table decides T of *[2][3]T and R of *[2]R', async () => {
    const data = `data grid: *[2][3]i32 = [[1, 2, 3], [4, 5, 6]]
data bytes: *[2][3]u8 = [[7, 8, 9], [10, 11, 12]]
`
    const generic = `func total(comptime T: type, r: *[3]T) -> T => r[0] + r[1] + r[2]
func first(comptime T: type, xs: []T) -> T => xs[0] ?? 0
func cell(comptime T: type, m: *[2][3]T, i: u32#2, j: u32#3) -> T => m[i][j]
func rowlen(comptime R: type, m: *[2]R, i: u32#2) -> u32 => m[i].len * 10 + m.wid
func fold(comptime T: type, m: *[2][3]T, comptime f: (*[3]T) -> T) -> (t: T) {
  t = 0
  for row in m {
    t += row.f()
  }
}
func rsum(r: *[3]i32) -> i32 => r[0] + r[1] + r[2]
${data}export func a() -> i32 => grid[1].total() * 100 + grid[0].first() + grid.cell(1, 0) * 10000 + grid.fold(rsum) * 1000000
export func b() -> u32 => (bytes[1].total() as u32) + (bytes.cell(0, 2) as u32) * 1000 + grid.rowlen(1) * 100000 + bytes.rowlen(0) * 10000000
`
    const byHand = `func total_i32(r: *[3]i32) -> i32 => r[0] + r[1] + r[2]
func total_u8(r: *[3]u8) -> u8 => r[0] + r[1] + r[2]
func first_i32(xs: []i32) -> i32 => xs[0] ?? 0
func cell_i32(m: *[2][3]i32, i: u32#2, j: u32#3) -> i32 => m[i][j]
func cell_u8(m: *[2][3]u8, i: u32#2, j: u32#3) -> u8 => m[i][j]
func rowlen_i32(m: *[2][3]i32, i: u32#2) -> u32 => m[i].len * 10 + m.wid
func rowlen_u8(m: *[2][3]u8, i: u32#2) -> u32 => m[i].len * 10 + m.wid
func fold_i32_rsum(m: *[2][3]i32) -> (t: i32) {
  t = 0
  for row in m {
    t += rsum(row)
  }
}
func rsum(r: *[3]i32) -> i32 => r[0] + r[1] + r[2]
${data}export func a() -> i32 => total_i32(grid[1]) * 100 + first_i32(grid[0]) + cell_i32(grid, 1, 0) * 10000 + fold_i32_rsum(grid) * 1000000
export func b() -> u32 => (total_u8(bytes[1]) as u32) + (cell_u8(bytes, 0, 2) as u32) * 1000 + rowlen_i32(grid, 1) * 100000 + rowlen_u8(bytes, 0) * 10000000
`
    await expectSameWasm(generic, byHand)
    const { a, b } = await run(generic)
    expect(a()).toBe(21041501)
    // m.wid in the instance is the 4 bytes of a row pointer, not sizeof(R)
    expect(b()).toBe(343409033)
  })
})

describe('examples/generics', () => {
  const dir = join(import.meta.dir, '../../examples/generics')

  async function compileExample(name: string): Promise<string> {
    const path = join(dir, name)
    const load = await loadModule(path)
    expect(load.errors).toEqual([])
    const check = typecheckProgram(load.modules, path, { includeTests: false })
    expect(check.errors).toEqual([])
    const wat = programToWat(load.modules, check.results, path)
    expectPlainWasm(wat)
    await wasmOfWat(wat)
    return wat
  }

  test('pick.ents: one function per type argument, nothing for pick itself', async () => {
    const wat = await compileExample('pick.ents')
    // pick<i64> is absent: only a test asks for it.
    expect(funcs(wat)).toEqual(['pick<<q:i32|r:i32>>', 'pick<f64>', 'pick<u32>', 'pick_u32', 'pick_f64', 'pick_pt'])
    // The bool and two flattened Pts.
    expect(funcWat(wat, 'pick<<q:i32|r:i32>>')).toStartWith(
      '(func $pick<<q:i32|r:i32>> (param $first i32) (param $a_q i32) (param $a_r i32) (param $b_q i32) (param $b_r i32) (result i32 i32)',
    )
  })

  test('minmax.ents: operators of each type, a generic calling generics, a generic named like a builtin', async () => {
    const wat = await compileExample('minmax.ents')
    expect(funcs(wat)).toEqual([
      'max<f64>', 'max<i32>', 'max<u32>', 'max<u64>', 'min<i32>', 'clamp<i32>', 'swap<u32>',
      'max_u32', 'max_i32', 'max_f64', 'clamp_i32', 'swap_u32', 'widen',
    ])
    expect(funcWat(wat, 'max<u32>')).toContain('i32.gt_u')
    expect(funcWat(wat, 'max<i32>')).toContain('i32.gt_s')
    expect(funcWat(wat, 'max<f64>')).toContain('f64.gt')
    expect(funcWat(wat, 'clamp<i32>')).toContain('(call $min<i32> (call $max<i32> (local.get $x) (local.get $lo)) (local.get $hi))')
    expect(funcWat(wat, 'max_u32')).toContain('(call $max<u32> (local.get $a) (local.get $b))')
    expect(wat).not.toContain('select')
    expect(funcWat(wat, 'widen')).toContain('(call $max<u64> (local.get $a) (i64.extend_i32_u (local.get $b)))')
  })

  test('slices.ents: T found inside []T, one instance however it is reached', async () => {
    const wat = await compileExample('slices.ents')
    // find<u8> exists once, although has_byte reaches it through contains.
    expect(funcs(wat)).toEqual(['find<u32>', 'find<u8>', 'contains<u8>', 'sum<u64>', 'find_u32', 'has_byte', 'sum_u64'])
  })

  test('vec.ents: a generic type, its instances, and nothing for the type or for what only tests use', async () => {
    const wat = await compileExample('vec.ents')
    expect(funcs(wat)).toEqual(['alloc', 'reset', 'vec<u32>', 'push<u32>', 'items<u32>', 'sum_to'])
    expect(funcWat(wat, 'vec<u32>')).toContain('(call $alloc (i32.const 12))')
  })

  test('sort.ents: one copy of sort for each comparator, each calling its own directly', async () => {
    const wat = await compileExample('sort.ents')
    expect(funcs(wat)).toEqual([
      'sort<i32|ascending>', 'sort<i32|by_cost_desc>', 'ascending', 'by_cost_desc', 'longer', 'inc', 'sort_ids', 'sort_up',
    ])
    expect(funcWat(wat, 'sort<i32|ascending>')).toContain('(call $ascending ')
    expect(funcWat(wat, 'sort<i32|by_cost_desc>')).toContain('(call $by_cost_desc ')
  })

  test('the tests of vec.ents and sort.ents pass', async () => {
    for (const [name, count] of [['vec.ents', 6], ['sort.ents', 4]] as const) {
      const { ran, failed } = await runTestsOfSource(await Bun.file(join(dir, name)).text())
      expect(failed).toEqual([])
      expect(ran).toHaveLength(count)
    }
  })

  test('methods.ents: the receiver decides T, and each chain is nested direct calls', async () => {
    const wat = await compileExample('methods.ents')
    // What only the tests use (u8 vectors, pop, get, find, unique) is absent.
    expect(funcs(wat)).toEqual(['alloc', 'reset', 'vec<u32>', 'push<u32>', 'items<u32>', 'double', 'sum_to'])
    expect(funcWat(wat, 'sum_to')).toContain('(call $push<u32> (local.get $v) (local.get $i))')
    const source = await Bun.file(join(dir, 'methods.ents')).text()
    // v.push(i) and push(v, i) are the same instruction, and so is every other pair.
    const plain = source
      .replace('v.push(i)\n', 'push(v, i)\n')
      .replace('for x in v.items()', 'for x in items(v)')
    expect(plain).not.toBe(source)
    expect(funcWat(watOfSource(plain), 'sum_to')).toContain('(call $push<u32> (local.get $v) (local.get $i))')
    expect(Buffer.from(await wasmOfSource(plain)).equals(Buffer.from(await wasmOfSource(source)))).toBe(true)
  })

  test('methods.ents with its tests: chains through generics and plain functions', async () => {
    const source = await Bun.file(join(dir, 'methods.ents')).text()
    const { ran, failed } = await runTestsOfSource(source)
    expect(failed).toEqual([])
    expect(ran).toEqual([
      'the receiver decides T',
      'explicit type arguments come after the receiver',
      'calls chain, and plain functions are methods too',
    ])
    const result = check(source)
    expect(result.errors).toEqual([])
    expect(result.instances.map(i => i.decl.ident as string).sort()).toEqual([
      'contains<u32>', 'contains<u8>', 'find<u32>', 'find<u8>', 'get<u32>', 'get<u8>', 'items<u32>', 'items<u8>',
      'pop<u32>', 'push<u32>', 'push<u8>', 'unique<u32>', 'unique<u8>', 'vec<u32>', 'vec<u8>',
    ])
  })

  test('set.ents: each instance calls the hash and the eq of its own key type', async () => {
    const dirOf = await mkdtemp(join(tmpdir(), 'encantis-set-'))
    try {
      const path = join(dirOf, 'set.ents')
      await writeFile(path, await Bun.file(join(dir, 'set.ents')).text())
      const load = await loadModule(path, { includeTests: true })
      const checked = typecheckProgram(load.modules, path, { includeTests: true })
      expect(checked.errors).toEqual([])
      const { wat } = programToWatWithTests(load.modules, checked.results, path)
      expectPlainWasm(wat)
      expect(funcs(wat).filter(name => !name.startsWith('test_'))).toEqual([
        'alloc', "hashset<''u32>", 'hashset<u32>', "slot<''u32>", 'slot<u32>', "has<''u32>", 'has<u32>', "add<''u32>", 'add<u32>',
        'hash', 'eq', "hash:''u32", "eq:''u32|''u32",
      ])
      const calls = (name: string) => [...new Set([...funcWat(wat, name).matchAll(/\(call \$(\S+?)[\s)]/g)].map(m => m[1]))]
      expect(calls('add<u32>')).toEqual(['hash', 'slot<u32>'])
      expect(calls('slot<u32>')).toEqual(['eq'])
      expect(calls("add<''u32>")).toEqual(["hash:''u32", "slot<''u32>"])
      expect(calls("slot<''u32>")).toEqual(["eq:''u32|''u32"])
      expect(calls("has<''u32>")).toEqual(["slot<''u32>", "hash:''u32"])
    } finally {
      await rm(dirOf, { recursive: true })
    }
    // Without its tests nothing asks for a set: the two pairs are all there is.
    expect(funcs(await compileExample('set.ents'))).toEqual(['alloc', 'hash', 'eq', "hash:''u32", "eq:''u32|''u32"])
    const { ran, failed } = await runTestsOfSource(await Bun.file(join(dir, 'set.ents')).text())
    expect(failed).toEqual([])
    expect(ran).toEqual(['a set of u32', 'a set of slices compares contents', 'a set of 2^bits slots holds 2^bits - 1 keys'])
  })

  // The two examples reach fields through the pointer (`v.len`), store a
  // struct whole and keep a flag as a bool. Written as they were before
  // structs and bools could be stored through a pointer, with an explicit
  // `.*`, a u32 for the flag and one store for each field, they pass the same
  // tests, and so they do with more of their calls written as method calls.
  test('methods.ents and set.ents pass their tests with an explicit .* and one store for each field, and with method calls', async () => {
    const edit = (source: string, edits: [string | RegExp, string][]) => {
      for (const [from, to] of edits) {
        if (typeof from === 'string') expect(source).toContain(from)
        else expect(source).toMatch(from)
        source = source.replaceAll(from, to)
      }
      return source
    }
    // The edits are written with \n: a checkout on Windows has \r\n.
    const text = async (name: string) => (await Bun.file(join(dir, name)).text()).replaceAll('\r\n', '\n')
    const methods = await text('methods.ents')
    const explicitMethods = edit(methods, [
      [/\b([uv])\.(len|cap|ptr)\b/g, '$1.*.$2'],
      ['  v.* = Vec(T)(alloc(room * sizeof(T)) as [*]mut T, 0, room)\n',
        '  let made = Vec(T)(alloc(room * sizeof(T)) as [*]mut T, 0, room)\n  v.*.ptr = made.ptr\n  v.*.len = made.len\n  v.*.cap = made.cap\n'],
    ])
    expect(explicitMethods).toContain('v.*.len += 1')
    expect((await runTestsOfSource(explicitMethods)).failed).toEqual([])
    const methodCalls = edit(methods, [
      ['find(xs, x) < xs.len', 'xs.find(x) < xs.len'],
      ['unique(repeats)', 'repeats.unique()'],
      ['unique(letters)', 'letters.unique()'],
    ])
    expect((await runTestsOfSource(methodCalls)).failed).toEqual([])
    const set = await text('set.ents')
    const explicitSet = edit(set, [
      ['(used: bool, hash: u32, key: K)', '(used: u32, hash: u32, key: K)'],
      ['  s.* = Set(K)(p as [*]mut Slot(K), size - 1, 0)\n', '  s.slots = p as [*]mut Slot(K)\n  s.mask = size - 1\n  s.count = 0\n'],
      ['  s.slots[i] = (used: true, hash: h, key: k)\n', '  s.slots[i].used = 1\n  s.slots[i].hash = h\n  s.slots[i].key = k\n'],
      ['return i when !s.slots[i].used', 'return i when s.slots[i].used == 0'],
      ['return false when s.slots[i].used\n', 'return false when s.slots[i].used != 0\n'],
      ['s.slot(k.hash(), k)].used\n', 's.slot(k.hash(), k)].used != 0\n'],
      [/\bs\.(slots|mask|count)\b/g, 's.*.$1'],
    ])
    expect(explicitSet).toContain('s.*.slots[i].used = 1')
    const explicitRun = await runTestsOfSource(explicitSet)
    expect(explicitRun.failed).toEqual([])
    expect(explicitRun.ran).toHaveLength(3)
    const setCalls = edit(set, [['eq(s.slots[i].key, k)', 's.slots[i].key.eq(k)']])
    const callsRun = await runTestsOfSource(setCalls)
    expect(callsRun.failed).toEqual([])
    expect(callsRun.ran).toHaveLength(3)
    // set.ents writes hash as a method call; written as a plain call it is the same.
    const plainSet = edit(set, [
      ['let h = k.hash()', 'let h = hash(k)'],
      ['s.slot(k.hash(), k)', 's.slot(hash(k), k)'],
    ])
    const plainRun = await runTestsOfSource(plainSet)
    expect(plainRun.failed).toEqual([])
    expect(plainRun.ran).toHaveLength(3)
  })

  test('no offset of an instance reaches the tables the editor reads', async () => {
    for (const name of ['pick.ents', 'minmax.ents', 'slices.ents', 'vec.ents', 'sort.ents', 'methods.ents', 'set.ents']) {
      const source = await Bun.file(join(dir, name)).text()
      const result = check(source)
      const inside = (offset: number) => offset >= 0 && offset < source.length
      expect(result.errors).toEqual([])
      expect(result.instances.length).toBeGreaterThan(3)
      for (const w of result.warnings) expect(inside(w.offset)).toBe(true)
      for (const [def, refs] of result.references) {
        expect(inside(def)).toBe(true)
        for (const ref of refs) expect(inside(ref)).toBe(true)
      }
      for (const [use, def] of result.symbolRefs) {
        expect(inside(use)).toBe(true)
        expect(inside(def)).toBe(true)
      }
    }
  })
})
