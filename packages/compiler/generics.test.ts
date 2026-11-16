// Generic functions: comptime type parameters. The language rules are the
// "Generics" chapter of docs/encantis.md; the cases users are meant to read are
// in spec/generics.md. These tests pin the rules one by one.

import { describe, expect, test } from 'bun:test'
import { parse } from './parser'
import { typecheck, type TypecheckOptions } from './checker'

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
  return (result.instances ?? []).map(i => i.decl.ident as string).sort()
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

  test('a range written in a type is part of the type', () => {
    expect(instancesOf(`${HEAD}export func f(xs: []u8#16) -> u8 => head(xs)`)).toEqual(["head<u8#16>"])
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
})

describe('instances', () => {
  test('explicit and inferred calls that arrive at the same arguments share one', () => {
    const source = `${MAX}export func a(x: u32, y: u32) -> u32 => max(x, y)
export func b(x: u32, y: u32) -> u32 => max(u32, x, y)
export func c(x: u32) -> u32 => max(x, 1) + max(u32, 2, x)`
    expect(instancesOf(source)).toEqual(['max<u32>'])
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

  test('a generic that never stops instantiating itself is one error', () => {
    const doubling = `func deep(comptime T: type, x: T) -> u32 => deep((T, T), (x, x))
export func f() -> u32 => deep(u8, 1)`
    const errors = errorsOf(doubling)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toStartWith("too many nested instantiations (64) while instantiating 'deep', in deep(T = ")
    // The type that grew is cut, not printed in full.
    expect(errors[0].length).toBeLessThan(160)

    const pointing = `func deep(comptime T: type, x: T) -> u32 => deep(*T, &x)
export func f() -> u32 => deep(u8, 1)`
    expect(errorsOf(pointing).filter(e => e.includes('too many nested instantiations'))).toHaveLength(1)
  })

  test('a generic sees its own module, not the locals of its caller', () => {
    const source = `func leak(comptime T: type, x: T) -> T => x + hidden
export func f() -> u32 {
  let hidden: u32 = 1
  return leak(hidden)
}`
    expect(errorsOf(source)).toEqual(["unknown identifier 'hidden', in leak(T = u32)"])
  })

  test('a call in a global initializer instantiates like any other', () => {
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

  test('name an alias as the call did', () => {
    const source = `type Meters = f64
${POSITIVE}export func f(x: Meters) -> bool => positive(x)`
    expect(errorsOf(source)).toEqual(['cannot assign int(0) to Meters, in positive(T = Meters)'])
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
      "comptime value parameters are not supported yet: 'n' must be 'type' or a function type",
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
