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
import { compileToWasm, wasmOfSource, wasmOfWat, watOfSource } from './test-utils'
import { typeToString } from './types'

function check(source: string, options?: TypecheckOptions) {
  const parsed = parse(source)
  expect(parsed.errors.map(e => e.message)).toEqual([])
  if (!parsed.module) throw new Error('no module')
  return typecheck(parsed.module, options)
}

const errorsOf = (source: string) => check(source).errors.map(e => e.message)

// What the checker says of an operator that its operands do not have. Its
// wording is written once here, as it is once in the checker (noOperator).
const noOperator = (op: string, left: string, right = left) => `'${op}' cannot be applied to ${left} and ${right}`

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

  test('a type in parentheses is the tuple of one element it is after a colon', () => {
    const id = 'func id(comptime T: type, a: T) -> T => a\n'
    // After `->` parentheses list the results, so one result that is a tuple
    // of one element is written ((u32)).
    expect(instancesOf(`${id}export func f(a: (u32)) -> ((u32)) => id((u32), a)`)).toEqual(['id<<u32>>'])
    expect(errorsOf(`${id}func f(a: u32) -> u32 => id((u32), a)`)).toEqual([
      'argument 2: cannot assign u32 to (u32)',
      'cannot assign (u32) to u32',
    ])
  })

  test('the result of an instance is one value, also when the type argument is a tuple or a struct', async () => {
    // In a hand-written signature `-> (u32)` and `-> (q: i32, r: i32)` list
    // results. An instance's `-> T` never does: its body returns a T.
    const source = `func id(comptime T: type, a: T) -> T => a
func back(comptime T: type, a: T) -> T { return a }
func none(comptime T: type, a: T) -> T { return }
export func f(a: (u32)) -> ((u32)) => back((u32), id(a))
export func g(q: i32, r: i32) -> i32 {
  let p = back((q: i32, r: i32), id((q: i32, r: i32), (q: q, r: r)))
  return p.q + p.r
}`
    expect(instancesOf(source)).toEqual(['back<<q:i32|r:i32>>', 'back<<u32>>', 'id<<q:i32|r:i32>>', 'id<<u32>>'])
    const instance = await WebAssembly.instantiate(await WebAssembly.compile(await wasmOfSource(source)))
    expect((instance.exports.g as (q: number, r: number) => number)(3, 4)).toBe(7)
    // Not a function with the named results q and r, which a bare return hands back.
    expect(errorsOf(`${source}\nexport func h(q: i32) -> i32 => none((q: i32, r: i32), (q: q, r: 2)).q`)).toEqual([
      'return needs a value: the function returns ((q: i32, r: i32)), in none(T = (q: i32, r: i32))',
    ])
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
    expect(errorsOf(`func keep(comptime T: type, p: (T, u8)) -> T => p.0
export func f() -> u32 {
  let total: u32 = 0
  for i in 3 { total += keep((i, 1)) }
  return total
}`)).toEqual(["cannot infer T for 'keep' from untyped literals: write keep(u32, ...) or give a literal its type"])
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

  // Matching does not look into a function type (that comes with comptime
  // function parameters). A function passed for f: (T) -> T decides nothing,
  // and the literal after it is no hint at T: inc takes a u32, not an i32.
  test('a function type is not matched, and the literals after it are not taken as a hint', () => {
    const source = `func inc(x: u32) -> u32 => x + 1
func apply(comptime T: type, f: (T) -> T, x: T) -> T => x
func keep(comptime T: type, f: (T) -> T) -> u32 => sizeof(T)
`
    expect(errorsOf(`${source}func a() -> u32 => apply(inc, 3)`)).toEqual([
      "cannot infer T for 'apply': write the type argument, as in apply(u32, ...)",
    ])
    expect(errorsOf(`${source}func b() -> u32 => keep(inc)`)).toEqual([
      "cannot infer T for 'keep': write the type argument, as in keep(u32, ...)",
    ])
    // An argument that does decide T, and the type written, are accepted.
    expect(instancesOf(`${source}export func c(v: u32) -> u32 => apply(inc, v) + apply(u32, inc, 3) + keep(u32, inc)`)).toEqual([
      'apply<u32>',
      'keep<u32>',
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
    expect(errorsOf(source)).toEqual([
      "unknown identifier 'twice', in apply(T = u8)",
      'cannot call non-function type: i32, in apply(T = u8)',
    ])
    expect(errorsOf(source.replace('twice(a as u32) as T', 'a\nfunc g(comptime T: type, a: T) { probe(1) }\nexport func h() { g(u8, 1) }'))).toEqual([
      "unknown identifier 'probe', in g(T = u8)",
      'cannot call non-function type: i32, in g(T = u8)',
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
  test('a type argument has to be declared before a call that is inferred during collection', () => {
    const pick = 'func pick(comptime T: type, first: bool, a: T, b: T) -> T => if first { a } else { b }\n'
    const late = "type argument T of 'pick' uses type 'Late' before it is declared"
    expect(errorsOf(`${pick}global g: i32 = pick(Late, true, (1, 2), (3, 4)).q
type Late = (q: i32, r: i32)`)).toEqual([late, 'global initializer must be a compile-time constant'])
    expect(errorsOf(`${pick}def d = pick(Late, true, (1, 2), (3, 4)).q
type Late = (q: i32, r: i32)
export func f() -> i32 => d`)).toEqual([late, 'def value must be a compile-time constant'])
    // Declared first, the type is no part of what is wrong.
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
      { offset: source.indexOf('300\n'), message: 'cannot assign int(300) to u8, in over(T = u8)' },
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
    expect(check(source).errors).toEqual([
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
    expect([...result.errors].sort(byPlace)).toEqual([...expected('Pt'), ...expected('[]u8')].sort(byPlace))
    // The types that have these operators are untouched by the checks.
    expect(errorsOf(`${generics}export func ok(x: i32, y: bool) -> bool => not(y) && twice(neg(inv(shl(x)))) > 0`)).toEqual([])
  })

  test('a type parameter cannot construct yet', () => {
    const source = `func make(comptime T: type, x: i32) -> T => T(x, x)
export func f() -> (i32, i32) => make((i32, i32), 1)`
    expect(errorsOf(source)).toEqual(['T(...) on a type parameter is not supported yet, in make(T = (i32, i32))'])
    // Its arguments are still checked: their own mistakes are not hidden.
    expect(errorsOf(source.replace('T(x, x)', 'T(x, nope)'))).toEqual([
      'T(...) on a type parameter is not supported yet, in make(T = (i32, i32))',
      "unknown identifier 'nope', in make(T = (i32, i32))",
    ])
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
    expect(check(source).warnings).toEqual([
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
      'a comptime function parameter',
      'func sort(comptime T: type, xs: []mut T, comptime before: (T, T) -> bool) { }',
      "comptime parameter 'before' must be a type parameter: comptime function parameters are not supported yet",
    ],
    [
      'a comptime value parameter',
      'func f(comptime n: u32) -> u32 => n',
      "comptime value parameters are not supported yet: 'n' must be 'type'",
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
      'a source import',
      'import "./lib" "max" func max(comptime T: type, a: T, b: T) -> T',
      'generic functions cannot be imported yet',
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
    expect(check(`export ${MAX}`).warnings).toEqual([])
  })

  // The import may be written as if the function were ordinary; what the
  // other module exports under that name is what counts.
  test('a generic of another module cannot be imported under a plain signature either', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'encantis-generics-'))
    try {
      await writeFile(join(dir, 'util.ents'), `export ${MAX}`)
      const entry = join(dir, 'main.ents')
      await writeFile(entry, 'import "./util" "max" func max(a: u32, b: u32) -> u32\nexport func f(a: u32) -> u32 => max(a, 1)\n')
      const load = await loadModule(entry)
      const program = typecheckProgram(load.modules, entry, { includeTests: false })
      expect(program.errors.map(e => e.message)).toEqual(['generic functions cannot be imported yet'])
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
    expect(await expectSameWasm(Z1_GENERIC, Z1_BY_HAND)).toHaveLength(535)
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

  test('no offset of an instance reaches the tables the editor reads', async () => {
    for (const name of ['pick.ents', 'minmax.ents', 'slices.ents']) {
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
