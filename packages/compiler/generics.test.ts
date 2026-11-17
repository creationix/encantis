// Generic functions: comptime type parameters. The language rules are the
// "Generics" chapter of docs/encantis.md; the cases users are meant to read are
// in spec/generics.md. These tests pin the rules one by one.

import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from './parser'
import { typecheck, typecheckProgram, type TypecheckOptions } from './checker'
import { programToWat, programToWatWithTests } from './codegen'
import { loadModule } from './loader'
import { compileToWasm, wasmOfSource, wasmOfWat, watOfSource } from './test-utils'

function check(source: string, options?: TypecheckOptions) {
  const parsed = parse(source)
  expect(parsed.errors.map(e => e.message)).toEqual([])
  if (!parsed.module) throw new Error('no module')
  return typecheck(parsed.module, options)
}

const errorsOf = (source: string) => check(source).errors.map(e => e.message)

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
  let u8 = 3
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
    // 0.2.1 gives such an if the type () when nothing says what it should be:
    // let m = if c { x + 1 } else { y } is "cannot assign () to u32" there too.
    const source = `${MAX}export func f(c: bool, x: u32, y: u32) -> u32 => max(if c { x + 1 } else { y }, y)`

    test('is one error, at the argument', () => {
      expect(errorsOf(source)).toEqual(["argument 1 of 'max' has no value"])
    })

    test.todo('decides T (needs claude/operand-types)', () => {
      expect(instancesOf(source)).toEqual(['max<u32>'])
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
    const source = `func leak(comptime T: type, x: T) -> T => x + hidden
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

  // The checker only: a call in a global's initializer, generic or not, is
  // not a valid wasm initializer on 0.2.1, so this is no accepted program.
  test('a call in a global initializer is instantiated when the global is collected', () => {
    const source = `${MAX}global limit: u32 = max(u32, 3, 4)
export func f() -> u32 => limit`
    expect(instancesOf(source)).toEqual(['max<u32>'])
  })

  test('a type argument has to be declared before a call that runs during collection', () => {
    const source = `func pick(comptime T: type, first: bool, a: T, b: T) -> T => if first { a } else { b }
global g: i32 = pick(Late, true, (1, 2), (3, 4)).q
type Late = (q: i32, r: i32)`
    expect(errorsOf(source)).toContain("type argument T of 'pick' uses type 'Late' before it is declared")
  })
})

describe('errors in an instance', () => {
  const POSITIVE = 'func positive(comptime T: type, x: T) -> bool => x > 0\n'

  test('are reported in the generic, with types as the instance has them, followed by the instance', () => {
    const source = `${POSITIVE}export func f(x: f64) -> bool => positive(x)`
    const result = check(source)
    expect(result.errors).toEqual([
      { offset: source.indexOf('0\n'), message: 'cannot assign int(0) to f64, in positive(T = f64)' },
    ])
  })

  test('appear once, however many calls use the instance', () => {
    const source = `${POSITIVE}export func a(x: f64) -> bool => positive(x)
export func b(x: f64) -> bool => positive(f64, x) && positive(x + 1.0)`
    expect(errorsOf(source)).toEqual(['cannot assign int(0) to f64, in positive(T = f64)'])
  })

  test('appear once per instance that has them', () => {
    const source = `${POSITIVE}export func a(x: f64, y: f32, z: u8) -> bool => positive(x) && positive(y) && positive(z)`
    expect(errorsOf(source)).toEqual([
      'cannot assign int(0) to f64, in positive(T = f64)',
      'cannot assign int(0) to f32, in positive(T = f32)',
    ])
  })

  test('read the same whichever alias a call wrote: an alias that only renames a type is not named', () => {
    // One instance for Meters, Feet and f64. Named after the first call, its
    // error would read differently when the calls change places.
    const calls = ['positive(m)', 'positive(Feet, f)', 'positive(x)']
    for (const order of [calls, [...calls].reverse()]) {
      const source = `type Meters = f64
type Feet = f64
${POSITIVE}export func f(m: Meters, f: Feet, x: f64) -> bool => ${order.join(' && ')}`
      expect(errorsOf(source)).toEqual(['cannot assign int(0) to f64, in positive(T = f64)'])
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
    const source = `${POSITIVE}export func a(x: f64) -> bool => positive(x)
export func b() -> i32 => missing`
    expect(errorsOf(source)).toEqual([
      "unknown identifier 'missing'",
      'cannot assign int(0) to f64, in positive(T = f64)',
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
      { offset: source.indexOf('a > b'), message: 'operator > is not defined for Pt, in max(T = Pt)' },
    ])
    const eq = `func same(comptime T: type, a: T, b: T) -> bool => a == b
export func f(a: []u8, b: []u8) -> bool => same(a, b)`
    expect(errorsOf(eq)).toEqual(['operator == is not defined for []u8, in same(T = []u8)'])
  })

  // Checked for the two operands of an operator only. claude/operand-types
  // checks unary operators and compound assignment, for hand-written code as
  // for instances; until it lands these pass the checker and compile to an
  // instruction that takes one value for an operand that is two.
  test.todo('a unary operator or compound assignment the type argument does not have is an error (needs claude/operand-types)', () => {
    const source = `type Pt = (q: i32, r: i32)
func neg(comptime T: type, a: T) -> T => -a
func twice(comptime T: type, a: T) -> T {
  let b = a
  b += a
  return b
}
func not(comptime T: type, a: T) -> bool => !a
export func f(p: Pt) -> Pt => twice(neg(p))
export func g(p: Pt) -> bool => not(p)`
    expect(errorsOf(source)).toHaveLength(3)
  })

  test('a type parameter cannot construct yet', () => {
    const source = `func make(comptime T: type, x: i32) -> T => T(x, x)
export func f() -> (i32, i32) => make((i32, i32), 1)`
    expect(errorsOf(source)).toEqual(['T(...) on a type parameter is not supported yet, in make(T = (i32, i32))'])
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
    const type = result.types.get(`${at}:IdentExpr`)
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
  // Z1. The sizes are those of the hand-written sides compiled by 0.2.1.
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

  // PENDING claude/operand-types. An argument that is implicitly widened to a
  // parameter of another wasm type (u32 for a u64) is accepted by the checker
  // and not converted by callToWat, for generic and ordinary calls alike; that
  // branch owns the conversion. What this branch guarantees is the inference:
  // T is decided by the first argument, and the later one is checked against it.
  describe('a later argument is widened to T', () => {
    const source = `func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }
export func widen(a: u64, b: u32) -> u64 => max(a, b)
`

    test('T is decided by the first argument and the call checks', () => {
      expect(instancesOf(source)).toEqual(['max<u64>'])
    })

    test.todo('the widened argument is converted (needs claude/operand-types)', async () => {
      const wat = watOfSource(source)
      expect(funcWat(wat, 'widen')).toContain('(call $max<u64> (local.get $a) (i64.extend_i32_u (local.get $b)))')
      await wasmOfWat(wat)
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
    // The example writes `b as u64`; without the cast this needs claude/operand-types (see the todo above).
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
