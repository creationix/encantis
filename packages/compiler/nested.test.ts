/** biome-ignore-all lint/style/noNonNullAssertion: this is a test, it's fine */
// Nested functions (reference 3.4, Nested Functions): what the checker says
// of them, what they capture and write, and how they compile.
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { typecheck, typecheckProgram, type TypeCheckResult } from './checker'
import { programToWat, programToWatWithTests } from './codegen'
import { loadModule } from './loader'
import { createTestHost } from './test-host'
import { buildMeta } from './meta'
import { documentSymbols, findReferences, gotoDefinition, hover, hoverText, rename } from './queries'
import { parse } from './parser'
import { runTestsOfSource, wasmOfWat, watOfSource } from './test-utils'

function check(source: string): TypeCheckResult {
  const parsed = parse(source, { filePath: 'test.ents' })
  if (parsed.errors.length > 0) throw new Error(`Parse error: ${parsed.errors[0].message}`)
  return typecheck(parsed.module!, { source })
}

const errorsOf = (source: string) => check(source).errors.map((e) => e.message)
const warningsOf = (source: string) => check(source).warnings.map((e) => e.message)

// The variables a nested function captures and writes, by name, in order
function setsOf(result: TypeCheckResult, path: string): { captures: string[]; writes: string[] } {
  const nested = [...result.nested.values()].find((n) => n.path === path)
  if (!nested) throw new Error(`no nested function ${path}: ${[...result.nested.values()].map((n) => n.path).join(', ')}`)
  return { captures: nested.captures.map((v) => v.name), writes: nested.writes.map((v) => v.name) }
}

describe('nested functions: checking', () => {
  test('a nested function that reads and assigns its function\'s variables checks', () => {
    const result = check(`
export func count_over(xs: []u32, limit: u32) -> u32 {
  let n: u32 = 0
  func note(x: u32) {
    if x > limit { n += 1 }
  }
  for x in xs { note(x) }
  return n
}`)
    expect(result.errors).toEqual([])
    expect(setsOf(result, 'count_over.note')).toEqual({ captures: ['limit', 'n'], writes: ['n'] })
  })

  describe('where it is seen (N5, N6)', () => {
    test('before its declaration and after its block', () => {
      expect(errorsOf(`
func f(n: u32) -> u32 {
  let a = twice(n)
  func twice(x: u32) -> u32 => x * 2
  if n > 3 {
    func half(x: u32) -> u32 => x / 2
  }
  return half(a)
}`)).toEqual([
        "'twice' is used before its declaration: a nested function is seen from its declaration to the end of its block",
        "'half' is seen only in the block it is declared in",
      ])
    })

    test('it calls itself, and the nested functions declared before it', () => {
      expect(errorsOf(`
export func f(n: u32) -> u32 {
  func down(k: u32) -> u32 => if k == 0 { 0 } else { down(k - 1) }
  func both(k: u32) -> u32 => down(k) + 1
  return both(n)
}`)).toEqual([])
    })

    test('no mutual recursion: the first does not see the second', () => {
      expect(errorsOf(`
export func f(n: u32) -> u32 {
  func a(k: u32) -> u32 => if k == 0 { 0 } else { b(k - 1) }
  func b(k: u32) -> u32 => a(k)
  return a(n)
}`)).toEqual(["'b' is used before its declaration: a nested function is seen from its declaration to the end of its block"])
    })

    test('in every block, and nested to any depth', () => {
      const result = check(`
export func f(n: u32) -> u32 {
  let total: u32 = 0
  for i in n {
    func add() { total += i }
    add()
  }
  if n > 2 {
    func outer() {
      func inner() { total += 10 }
      inner()
    }
    outer()
  }
  return total
}`)
      expect(result.errors).toEqual([])
      expect(setsOf(result, 'f.add')).toEqual({ captures: ['total', 'i'], writes: ['total'] })
      expect(setsOf(result, 'f.outer')).toEqual({ captures: ['total'], writes: ['total'] })
      expect(setsOf(result, 'f.outer.inner')).toEqual({ captures: ['total'], writes: ['total'] })
    })
  })

  describe('its name (N7 to N9)', () => {
    test('no name of the module, of a variable or of another nested function', () => {
      expect(errorsOf(`
global total: u32 = 0
func size() -> u32 => 4
func f(n: u32) -> u32 {
  func total() -> u32 => 1
  func size() -> u32 => 2
  func n() -> u32 => 3
  for i in 3 { func keep() { } }
  for i in 3 { func keep() { } }
  return 0
}`)).toEqual([
        "'total' is already declared: a nested function cannot reuse the name of a global (first declared at 2:8)",
        "'size' is already declared: a nested function cannot reuse the name of a function of the module (first declared at 3:6)",
        "'n' is already declared: a nested function cannot reuse the name of a parameter (first declared at 4:8)",
        "'keep' is already declared in 'f': a nested function's name is its own in the whole function that declares it (first declared at 8:21)",
      ])
    })

    test('a third declaration of the name is told the place of the first (3.3)', () => {
      expect(errorsOf(`
func helper() -> u32 => 1
import "env" "ext" func ext() -> u32
func f() -> u32 {
  func s() { }
  func s() { }
  func s() { }
  func helper() -> u32 => 2
  if true { func helper() -> u32 => 3 }
  func ext() -> u32 => 4
  func ok(ext: u32) -> u32 => ext
  return helper() + ok(1)
}
test "t" {
  let k: u32 = 1
  func c1() -> u32 => k
  func c1() -> u32 => k + 1
  func c1() -> u32 => k + 2
  assert c1() == 1
}`)).toEqual([
        "'s' is already declared: a nested function cannot reuse the name of a nested function in scope (first declared at 5:8)",
        "'s' is already declared: a nested function cannot reuse the name of a nested function in scope (first declared at 5:8)",
        "'helper' is already declared: a nested function cannot reuse the name of a function of the module (first declared at 2:6)",
        "'helper' is already declared: a nested function cannot reuse the name of a function of the module (first declared at 2:6)",
        "'ext' is already declared: a nested function cannot reuse the name of an import (first declared at 3:25)",
        "'c1' is already declared: a function that uses its test's variables cannot reuse the name of a nested function in scope (first declared at 16:8)",
        "'c1' is already declared: a function that uses its test's variables cannot reuse the name of a nested function in scope (first declared at 16:8)",
      ])
    })

    // Refused as the function's own name, in a block that has ended, a
    // declaration is no first of the name: the one in that block is, and
    // where that was refused in turn, what had the name
    test('a third declaration is told the first place also after a refusal of the function\'s own name', () => {
      expect(errorsOf(`
func helper() -> u32 => 1
export func f(n: u32) -> u32 {
  if n > 1 { func s() { } }
  func s() { }
  func s() { }
  func q(s: u32) -> u32 => s
  for w in 3 { }
  func w() { }
  func w() { }
  if n > 2 { func v() { } }
  let v: u32 = 1
  if n > 3 { func v() { } }
  func helper() -> u32 => 2
  let helper: u32 = 4
  return q(n) + v
}`)).toEqual([
        "'s' is already declared in 'f': a nested function's name is its own in the whole function that declares it (first declared at 4:19)",
        "'s' is already declared: a nested function cannot reuse the name of a nested function in scope (first declared at 4:19)",
        "'s' is already declared: a parameter of a nested function cannot reuse the name of a nested function in scope (first declared at 4:19)",
        "'w' is already declared in 'f': a nested function's name is its own in the whole function that declares it (first declared at 8:7)",
        "'w' is already declared: a nested function cannot reuse the name of a nested function in scope (first declared at 8:7)",
        "'v' is already declared in 'f': a nested function's name is its own in the whole function that declares it (first declared at 11:19)",
        "'v' is already declared: a nested function cannot reuse the name of a variable in scope (first declared at 11:19)",
        "'helper' is already declared: a nested function cannot reuse the name of a function of the module (first declared at 2:6)",
        // The nested function refused the name leaves it with the module's
        // function: the let is told what it is told without it
        "'helper' is already declared in this scope (first declared at 2:6)",
      ])
    })

    test('a variable declared after it cannot take its name, in any block', () => {
      expect(errorsOf(`
func g() -> u32 {
  for i in 3 { func step() { } }
  for step in 3 { }
  if true { func tick() { } }
  let tick: u32 = 4
  let (a, tock): (u32, u32) = (1, 2)
  if true { func tock2() { } }
  return tick + a + tock
}`)).toEqual([
        "'step' is already declared in 'g': a nested function's name is its own in the whole function that declares it (first declared at 3:21)",
        "'tick' is already declared in 'g': a nested function's name is its own in the whole function that declares it (first declared at 5:18)",
      ])
    })

    test('a nested function declared after a variable not seen there', () => {
      expect(errorsOf(`
func g() -> u32 {
  for step in 3 { }
  func step() { }
  return 0
}`)).toEqual(["'step' is already declared in 'g': a nested function's name is its own in the whole function that declares it (first declared at 3:7)"])
    })

    test('its parameters and results hide nothing it could use', () => {
      expect(errorsOf(`
func f(x: u32) -> u32 {
  func g(x: u32) -> u32 => x + 1
  func h(y: u32) -> (x: u32) { x = y }
  func k() -> u32 => 1
  func m(k: u32) -> u32 => k
  return g(x) + h(x) + m(k())
}`)).toEqual([
        "'x' is already declared: a parameter of a nested function cannot reuse the name of a parameter (first declared at 2:8)",
        "'x' is already declared: a result of a nested function cannot reuse the name of a parameter (first declared at 2:8)",
        "'k' is already declared: a parameter of a nested function cannot reuse the name of a nested function in scope (first declared at 5:8)",
      ])
    })

    test('a parameter can have the name of a global or a function of the module, which it hides', () => {
      expect(errorsOf(`
global total: u32 = 0
func size() -> u32 => 4
export func f() -> u32 {
  func g(total: u32, size: u32) -> u32 => total + size
  return g(1, 2)
}`)).toEqual([])
    })

    test('a parameter or a named result takes no def\'s name (3.4), also at the top of a test or in a generic', () => {
      expect(errorsOf(`
def k = 3
export func f(a: u32) -> u32 {
  func g(k: u32) -> u32 => k + 1
  func h(x: u32) -> (k: u32) { k = x }
  return g(a) + h(a)
}
func over(comptime T: type, x: T) -> T {
  func see(k: T) -> T => k
  return see(x)
}
export func use(x: u32) -> u32 => over(x)
export func use2(x: u64) -> u64 => over(x)
test "t" {
  def d = 7
  let z: u32 = 1
  func top(d: u32) -> u32 => d + z
  func plain(d: u32) -> u32 => d
  assert top(1) + plain(1) == 3
}`)).toEqual([
        "'k' is already declared: a parameter cannot reuse the name of a def (first declared at 2:5)",
        "'k' is already declared: a named result cannot reuse the name of a def (first declared at 2:5)",
        // In a generic, once with the declarations, as its own parameters
        // are, not once per instance
        "'k' is already declared: a parameter cannot reuse the name of a def (first declared at 2:5)",
        "'d' is already declared: a parameter cannot reuse the name of a def (first declared at 15:7)",
        "'d' is already declared: a parameter cannot reuse the name of a def (first declared at 15:7)",
      ])
    })

    test('in a generic nothing calls, a nested function\'s parameter with a def\'s name is reported all the same', () => {
      expect(errorsOf(`
def k = 3
func over(comptime T: type, x: T) -> T {
  if x > 0 {
    func see(y: T) -> T {
      func deeper(k: T) -> T => k
      return deeper(y)
    }
    return see(x)
  }
  return x
}
export func use(x: u32) -> u32 => x`)).toEqual([
        "'k' is already declared: a parameter cannot reuse the name of a def (first declared at 2:5)",
      ])
    })

    test('a name declared after it is free for its own variables', () => {
      expect(errorsOf(`
export func f() -> u32 {
  func g() -> u32 {
    let t: u32 = 1
    return t
  }
  let t: u32 = 2
  return g() + t
}`)).toEqual([])
    })

    test('a builtin\'s name replaces the builtin, with a warning', () => {
      const result = check(`
export func f(a: u32) -> u32 {
  func max(x: u32) -> u32 => x
  return max(a)
}`)
      expect(result.errors).toEqual([])
      expect(result.warnings.map((w) => w.message)).toContain("'max' replaces the builtin max in the body of 'f'")
    })
  })

  test('a variable declared after it is not seen in it (N11)', () => {
    expect(errorsOf(`
func f() -> u32 {
  func early() -> u32 => late
  let late: u32 = 5
  return early()
}`)).toEqual(["'late' is declared after 'early': a nested function uses only the variables declared before it"])
  })

  test('the refused forms (N4) and break out of it (N26)', () => {
    expect(errorsOf(`
func f(n: u32) -> u32 {
  func(x: u32) -> u32 => x + 1
  func pick(comptime T: type, a: T) -> T => a
  func Box(comptime T: type) -> type => (v: T)
  for i in n {
    func stop() { break }
    func skip() { continue }
  }
  return pick(1) + 0
}`)).toEqual([
      'a function declared in a function body needs a name: func name(x: T) -> R => ...',
      'a generic function is declared at module level, not inside a function',
      'a generic type is declared at module level, not inside a function',
      'cannot break out of a nested function',
      'cannot continue out of a nested function',
    ])
  })

  test('a loop inside it is its own', () => {
    expect(errorsOf(`
export func f(n: u32) -> u32 {
  func first(k: u32) -> u32 {
    for i in k {
      break when i > 2
      continue
    }
    return 0
  }
  return first(n)
}`)).toEqual([])
  })

  test('it is not a value (N39)', () => {
    expect(errorsOf(`
func apply(f: (u32) -> u32, x: u32) -> u32 => x
func f(x: u32) -> u32 {
  func inc(y: u32) -> u32 => y + 1
  let g = inc
  return apply(inc, x)
}`)).toEqual([
      "'inc' is a nested function: it can only be called, or given for a comptime function parameter",
      "'inc' is a nested function: it can only be called, or given for a comptime function parameter",
    ])
  })

  test('its address and a cast of it say nothing more than N39', () => {
    const n39 = "'inc' is a nested function: it can only be called, or given for a comptime function parameter"
    expect(errorsOf(`
func f(x: u32) -> u32 {
  func inc(y: u32) -> u32 => y + 1
  defer inc
  let p = &inc
  let k = inc as u32
  return x
}`)).toEqual([n39, n39, n39])
  })

  test('a name refused because a variable has it stays the variable\'s', () => {
    const source = `
func f(n: u32) -> (r: u32) {
  func n() -> u32 => 3
  func r() -> u32 => 4
  let a = n + 1
  n = 5
  r = a + n
}`
    expect(errorsOf(source)).toEqual([
      "'n' is already declared: a nested function cannot reuse the name of a parameter (first declared at 2:8)",
      "'r' is already declared: a nested function cannot reuse the name of a named result (first declared at 2:20)",
    ])
    expect(warningsOf(source)).toEqual(["'f' is never used"])
  })

  test('return gives its own result', () => {
    expect(errorsOf(`
func f() -> u32 {
  func g() -> u32 {
    return
  }
  func h() {
    return 1
  }
  return g()
}`)).toEqual(['return needs a value: the function returns u32', 'cannot assign int(1) to ()'])
  })

  test('a nested function nothing calls is never used', () => {
    expect(warningsOf(`
export func f() -> u32 {
  func unused() -> u32 => 1
  func used() -> u32 => 2
  return used()
}`)).toEqual(["'unused' is never used"])
  })
})

describe('nested functions: captures and writes (N13)', () => {
  test('through the functions it calls, in its own functions\' order', () => {
    const result = check(`
export func tally(xs: []u32) -> u32 {
  let total: u32 = 0
  func add(x: u32) { total += x }
  func add_twice(x: u32) {
    add(x)
    add(x)
  }
  for x in xs { add_twice(x) }
  return total
}`)
    expect(setsOf(result, 'tally.add')).toEqual({ captures: ['total'], writes: ['total'] })
    expect(setsOf(result, 'tally.add_twice')).toEqual({ captures: ['total'], writes: ['total'] })
  })

  test('outer function first, each in the order its text declares them', () => {
    const result = check(`
export func f(a: u32) -> (r: u32) {
  let b: u32 = 1
  func g(c: u32) -> u32 {
    let d: u32 = c
    func h() -> u32 => d + b + c + a + r
    return h()
  }
  return g(a)
}`)
    expect(setsOf(result, 'f.g.h')).toEqual({ captures: ['a', 'r', 'b', 'c', 'd'], writes: [] })
    expect(setsOf(result, 'f.g')).toEqual({ captures: ['a', 'r', 'b'], writes: [] })
  })

  test('a grandchild calling its grandparent\'s earlier nested function', () => {
    const result = check(`
export func f() -> u32 {
  let n: u32 = 0
  func bump() { n += 1 }
  func g() {
    func h() { bump() }
    h()
  }
  g()
  return n
}`)
    expect(setsOf(result, 'f.g')).toEqual({ captures: ['n'], writes: ['n'] })
    expect(setsOf(result, 'f.g.h')).toEqual({ captures: ['n'], writes: ['n'] })
  })

  test('a variable named only in a nested function it never calls still counts', () => {
    const result = check(`
export func f() -> u32 {
  let n: u32 = 0
  func g() {
    func h() { n = 1 }
  }
  g()
  return n
}`)
    expect(setsOf(result, 'f.g')).toEqual({ captures: ['n'], writes: ['n'] })
  })

  test('assignments through registers write; through memory they only read', () => {
    const result = check(`
type Point = (x: i32, y: i32)
type Box = (arr: [3]u32, k: u32)
type Holder = (p: *mut Point)
data cells = mut [0:u32; 4]
data spot = mut [0:i32, 0]
export func f(q: *mut Point) -> i32 {
  let p = Point(1, 2)
  let b = Box([1, 2, 3], 4)
  let a: [2][2]u32 = [[1, 2], [3, 4]]
  let s: [*]mut u32 = cells
  let t: []mut u32 = cells
  let h = Holder(spot as *mut Point)
  let pair: (u32, u32) = (1, 2)
  func poke() {
    p.x = 3
    b.arr[1] = 9
    a[1][0] = 7
    s[0] = 1
    t.len = 2
    q.x = 4
    q.* = Point(5, 6)
    h.p.x = 1
    pair.0 = 5
  }
  poke()
  return p.x
}`)
    expect(result.errors).toEqual([])
    expect(setsOf(result, 'f.poke')).toEqual({
      captures: ['q', 'p', 'b', 'a', 's', 't', 'h', 'pair'],
      writes: ['p', 'b', 'a', 't', 'pair'],
    })
  })

  test('set patterns write, at any depth; shorthand names are uses', () => {
    const result = check(`
type Point = (x: i32, y: i32)
func pt() -> Point => Point(1, 2)
export func f() -> i32 {
  let a: i32 = 0
  let b: i32 = 0
  let x: i32 = 0
  let y: i32 = 0
  let z: i32 = 0
  func g() {
    set (a, b) = (1, 2)
    set (x:, y: z) = pt()
  }
  func h() -> Point => Point(x:, y:)
  g()
  return a + b + x + z + h().x
}`)
    expect(result.errors).toEqual([])
    expect(setsOf(result, 'f.g')).toEqual({ captures: ['a', 'b', 'x', 'z'], writes: ['a', 'b', 'x', 'z'] })
    expect(setsOf(result, 'f.h')).toEqual({ captures: ['x', 'y'], writes: [] })
  })

  test('a label names nothing: (a: v) names v', () => {
    const result = check(`
type P = (a: u32, b: u32)
export func f(a: u32, v: u32) -> u32 {
  func g() -> P => P(a: v, b: v)
  return g().a
}`)
    expect(setsOf(result, 'f.g')).toEqual({ captures: ['v'], writes: [] })
  })

  test('nothing captured: no captures', () => {
    const result = check(`
export func area(w: u32, h: u32) -> u32 {
  func double(x: u32) -> u32 => x * 2
  return w.double() * h
}`)
    expect(result.errors).toEqual([])
    expect(setsOf(result, 'area.double')).toEqual({ captures: [], writes: [] })
  })

  test('a recursive nested function writes what it assigns of its function\'s', () => {
    const result = check(`
export func climbs(n: u32) -> (ways: u32, calls: u32) {
  func walk(left: u32) {
    calls += 1
    if left == 0 {
      ways += 1
      return
    }
    walk(left - 1)
    if left >= 2 { walk(left - 2) }
  }
  walk(n)
}`)
    expect(result.errors).toEqual([])
    expect(setsOf(result, 'climbs.walk')).toEqual({ captures: ['ways', 'calls'], writes: ['ways', 'calls'] })
  })

  test('the registers it takes are held to the limits of a wasm function (N40)', () => {
    expect(errorsOf(`
export func f(big: [999]u8) -> u32 {
  let more: [5]u8 = [0, 0, 0, 0, 0]
  func g(x: u32) -> u32 => big[0] + more[0] + x
  return g(1)
}`)).toEqual(["the parameters are 1005 registers with the variables 'g' captures, more than the 1000 a wasm function takes — pass a large value by pointer"])
    expect(errorsOf(`
export func f() -> u32 {
  let big: [999]u8 = [0; 999]
  let more: [5]u8 = [0, 0, 0, 0, 0]
  func g() {
    big[0] = 1
    more[0] = 1
  }
  g()
  return 0
}`)).toEqual([
      "the parameters are 1004 registers with the variables 'g' captures, more than the 1000 a wasm function takes — pass a large value by pointer",
      "the results are 1004 registers with the variables 'g' writes, more than the 1000 a wasm function gives back — give a large value back through a pointer",
    ])
  })
})

describe('nested functions: narrowing (N18)', () => {
  const index = 'runtime index on *[4]u32 requires \'if let\' or \'??\''
  const refused = (body: string) => errorsOf(`data buf = [1:u32, 2, 3, 4]\n${body}`).some((e) => e.startsWith(index))

  test('a call of a nested function that assigns the variable', () => {
    expect(refused(`func at(i: u32) -> u32 {
  func far() { i = 100 }
  if i < 4 {
    far()
    return buf[i]
  }
  return 0
}`)).toBe(true)
  })

  test('a call of a call', () => {
    expect(refused(`func at(i: u32) -> u32 {
  func far() { i = 100 }
  func farther() { far() }
  if i < 4 {
    farther()
    return buf[i]
  }
  return 0
}`)).toBe(true)
  })

  test('a method call', () => {
    expect(refused(`func at(i: u32) -> u32 {
  func far(k: u32) { i = k }
  if i < 4 {
    (100).far()
    return buf[i]
  }
  return 0
}`)).toBe(true)
  })

  test('a later operand of the condition', () => {
    expect(refused(`func at(i: u32) -> u32 {
  func far() -> bool {
    i = 100000
    return true
  }
  if i < 4 && far() { return buf[i] }
  return 0
}`)).toBe(true)
  })

  test('a guard\'s condition, and return when', () => {
    expect(refused(`func at(i: u32) -> u32 {
  func far() -> bool {
    i = 100000
    return false
  }
  if i >= 4 || far() { return 0 }
  return buf[i]
}`)).toBe(true)
    expect(refused(`func at(i: u32) -> u32 {
  func far() -> bool {
    i = 100000
    return false
  }
  return 0 when i >= 4 || far()
  return buf[i]
}`)).toBe(true)
  })

  test('an earlier condition, for an elif and an else', () => {
    expect(refused(`func at(i: u32) -> u32 {
  func far() -> bool {
    i = 100000
    return false
  }
  if i >= 4 || far() {
    return 0
  } elif i > 9 {
    return 1
  } else {
    return buf[i]
  }
}`)).toBe(true)
    expect(refused(`func at(i: u32) -> u32 {
  func far() -> bool {
    i = 100000
    return false
  }
  if far() {
    return 0
  } elif i < 4 {
    return buf[i]
  }
  return 0
}`)).toBe(true)
  })

  test('a function declared in the region that assigns it', () => {
    expect(refused(`func at(i: u32) -> u32 {
  if i < 4 {
    func get() -> u32 => buf[i]
    func far() { i = 100 }
    far()
    return get()
  }
  return 0
}`)).toBe(true)
  })

  test('allowed where the nested function only reads, inside one declared in the region, and through recursion', () => {
    expect(refused(`func at(i: u32) -> u32 {
  func look() -> u32 => i
  if i < 4 {
    let k = look()
    return buf[i] + k
  }
  return 0
}`)).toBe(false)
    expect(refused(`func at(i: u32) -> u32 {
  if i < 4 {
    func get() -> u32 => buf[i]
    return get()
  }
  return 0
}`)).toBe(false)
    expect(refused(`func total() -> u32 {
  func from(i: u32) -> u32 {
    if i < 4 { return buf[i] + from(i + 1) }
    i = 0
    return 0
  }
  return from(0)
}`)).toBe(false)
  })

  test('without nested functions: set (i, j) and an if in the condition (pre-existing holes)', () => {
    expect(refused(`func f(i: u32) -> u32 {
  let j: u32 = 0
  if i < 4 {
    set (i, j) = (100000, 0)
    return buf[i]
  }
  return 0
}`)).toBe(true)
    expect(refused(`func c1(i: u32) -> u32 {
  if i < 4 && (if true { i = 100000
    true } else { false }) {
    return buf[i]
  }
  return 0
}`)).toBe(true)
    expect(refused(`func c2(i: u32) -> u32 {
  if i >= 4 || (if true { i = 100000
    false } else { true }) { return 0 }
  return buf[i]
}`)).toBe(true)
    expect(refused(`func c3(i: u32) -> u32 {
  if i >= 4 || (if true { i = 100000
    false } else { true }) {
    return 0
  } else {
    return buf[i]
  }
}`)).toBe(true)
  })

  // An elif let's value runs after the conditions before it: a nested
  // function it calls can write what they narrowed, in its own branch and
  // in every branch after it.
  test('an elif let: its value, its branch, and the conditions before it', () => {
    const bump = `func bump() -> ?*u32 {
    i = 100
    return p
  }`
    expect(refused(`func a(i: u32, p: ?*u32) -> u32 {
  ${bump}
  if i >= 4 {
    return 0
  } elif let q = bump() {
    return buf[i]
  }
  return 0
}`)).toBe(true)
    expect(refused(`func b(i: u32, p: ?*u32) -> u32 {
  ${bump}
  if i >= 4 {
    return 0
  } elif let q = bump() {
    return 1
  } else {
    return buf[i]
  }
}`)).toBe(true)
    expect(refused(`func c(i: u32, p: ?*u32, d: bool) -> u32 {
  ${bump}
  if i >= 4 {
    return 0
  } elif let q = bump() {
    return 1
  } elif d {
    return buf[i]
  }
  return 0
}`)).toBe(true)
    expect(refused(`func d(i: u32, p: ?*u32) -> u32 {
  func bumped() -> bool {
    i = 100
    return false
  }
  if i >= 4 || bumped() {
    return 0
  } elif let q = p {
    return buf[i]
  }
  return 0
}`)).toBe(true)
    // As a value too
    expect(refused(`func e(i: u32, p: ?*u32) -> u32 {
  ${bump}
  let r: u32 = if i >= 4 { 0 } elif let q = bump() { 1 } else { buf[i] }
  return r
}`)).toBe(true)
  })

  test('an elif let that calls nothing that writes keeps the narrowing', async () => {
    const source = `data buf = [1:u32, 2, 3, 4]
data five = [5:u32]
export func a(i: u32, p: ?*u32, d: bool) -> u32 {
  func look() -> u32 => i
  if i >= 4 {
    return 0
  } elif let q = p {
    return buf[i] + look() + q.*
  } elif d {
    return buf[i]
  } else {
    return buf[i] + 1
  }
}
test "narrowed" {
  let x = five as *u32
  assert a(2, 0, false) == 4
  assert a(1, x, false) == 2 + 1 + 5
  assert a(5, x, true) == 0
}`
    expect(errorsOf(source)).toEqual([])
    expect((await runTestsOfSource(source)).failed).toEqual([])
  })
})

describe('nested functions: tests (N36)', () => {
  test('a function at the top of a test that uses its variables is a nested function of the test', () => {
    const result = check(`
test "counts" {
  let seen: u32 = 0
  func see(x: u32) { seen += x }
  see(2)
  see(3)
  assert seen == 5
}`)
    expect(result.errors).toEqual([])
    expect(setsOf(result, '__test1.see')).toEqual({ captures: ['seen'], writes: ['seen'] })
    // Never a function of the module
    expect(result.symbols.has('see')).toBe(false)
  })

  test('one that captures nothing is a function of the test, as it was', () => {
    const result = check(`
test "plain" {
  func twice(x: u32) -> u32 => x * 2
  assert twice(2) == 4
}`)
    expect(result.errors).toEqual([])
    expect(result.nested.size).toBe(0)
    expect(result.symbols.has('twice')).toBe(true)
  })

  test('a name it declares itself is its own, not a use of the test\'s variable of that name', async () => {
    const source = `export func one() -> u32 => 1
test "parameter" {
  let x: u32 = 4
  func double(x: u32) -> u32 => x * 2
  assert double(x) == 8
}
test "named result" {
  let r: u32 = 4
  func two() -> (r: u32) { r = 2 }
  assert two() + r == 6
}
test "group" {
  let x: u32 = 4
  func triple(x: u32) -> u32 => x * 3
  test "inner" {
    assert triple(3) == 9
  }
}`
    const result = check(source)
    expect(result.errors).toEqual([])
    expect([...result.nested.values()].map((n) => n.path)).toEqual([])
    const { ran, failed } = await runTestsOfSource(source)
    expect(ran).toEqual(['parameter', 'named result', 'group > inner'])
    expect(failed).toEqual([])
  })

  test('a capturing one takes no name of the module', () => {
    expect(errorsOf(`
func helper() -> u32 => 1
test "t" {
  let x: u32 = 1
  func helper() -> u32 => x
  assert helper() == 1
}`)).toEqual(["'helper' is already declared: a function that uses its test's variables cannot reuse the name of a function of the module (first declared at 2:6)"])
  })

  test('a capturing one may take a name another test declared, not one its group declared', async () => {
    const source = `
test "plain" {
  func add(x: u32) -> u32 => x + 1000
  assert add(1) == 1001
}
test "imports" {
  import "env" "ask" func ask(x: u32) -> u32
  let k: u32 = 0
  if k == 1 { assert ask(1) == 1 }
}
test "capturing" {
  let k: u32 = 10
  func add(x: u32) -> u32 => x + k
  func ask(x: u32) -> u32 => x + k + 1
  assert add(1) == 11
  assert ask(1) == 12
}
test "group" {
  func helper() -> u32 => 1
  test "in it" {
    let k: u32 = 2
    func helper() -> u32 => k
    assert helper() == 2
  }
}`
    expect(errorsOf(source)).toEqual([
      "'helper' is already declared: a function that uses its test's variables cannot reuse the name of a function of the module (first declared at 19:8)",
    ])
    const fine = source.slice(0, source.indexOf('test "group"'))
    expect(errorsOf(fine)).toEqual([])
    expect(await runTestsOfSource(fine)).toEqual({ ran: ['plain', 'imports', 'capturing'], failed: [] })
  })

  // An earlier nested test of the group that declares the name too leaves
  // it the group's in the next one (a plain one replaces it in its own test)
  test('a capturing one takes no name its group declares, whichever nested test declared it since', () => {
    expect(errorsOf(`
test "g" {
  func helper() -> u32 => 1
  import "env" "ext" func ext() -> u32
  test "t1" {
    func helper() -> u32 => 2
    func ext() -> u32 => 2
    assert helper() + ext() == 4
  }
  test "t2" {
    let k: u32 = 3
    func helper() -> u32 => k
    func ext() -> u32 => k
    assert helper() + ext() == 6
  }
}`)).toEqual([
      "'helper' is already declared: a function that uses its test's variables cannot reuse the name of a function of the module (first declared at 3:8)",
      "'ext' is already declared: a function that uses its test's variables cannot reuse the name of an import (first declared at 4:27)",
    ])
  })

  // The earlier test's function took the name over in module scope (#74),
  // and is not seen in the later test: the module's function is
  test('a capturing one in a later test is told the place of the module\'s function, not an earlier test\'s', () => {
    expect(errorsOf(`func helper() -> u32 => 1
test "a" {
  func helper() -> u32 => 2
  assert helper() == 2
}
test "b" {
  let k: u32 = 3
  func helper() -> u32 => k
  assert helper() == 3
}`)).toEqual(["'helper' is already declared: a function that uses its test's variables cannot reuse the name of a function of the module (first declared at 1:6)"])
  })

  // codegen put a test's def or data in place of the name for the tests
  // after it, and found it for another test's function of the name
  test('a test\'s function may have the name of another test\'s data or def', async () => {
    expect(await runTestsOfSource(`
test "a" {
  data buf = [1:u8, 2]
  def dd = 4
  assert buf[0] == 1 && dd == 4
}
test "b" {
  let k: u32 = 7
  func dd() -> u32 => k + 3
  assert dd() == 10
}
test "c" {
  func buf() -> u32 => 2
  func dd() -> u32 => 3
  assert buf() == 2 && dd() == 3
}`)).toEqual({ ran: ['a', 'b', 'c'], failed: [] })
  })

  test('a group\'s variables: not at its top, not in its nested tests', () => {
    expect(errorsOf(`
test "rectangles" {
  let base: u32 = 1
  func plus(x: u32) -> u32 => x + base
  test "inner" {
    assert plus(1) == 2
    assert base == 1
  }
}`)).toEqual([
      '\'base\' is a variable of the group "rectangles", whose statements are never run (12.3): a function declared at its top cannot use it',
      '\'base\' is a variable of the group "rectangles", whose statements are never run (12.3): a test nested in it cannot use it',
    ])
  })

  test('a group\'s declarations are still seen in its nested tests', () => {
    expect(errorsOf(`
test "group" {
  def k = 3
  data d = [1:u32, 2]
  func helper() -> u32 => 4
  test "inner" {
    assert k + helper() == 7
    assert d[0] == 1
  }
}`)).toEqual([])
  })

  test('a function in a block of a test is a nested function, and messages say "inside a test"', () => {
    const result = check(`
test "blocks" {
  let n: u32 = 0
  for i in 3 {
    func add() { n += i }
    add()
  }
  if true {
    func pick(comptime T: type, a: T) -> T => a
  }
  assert n == 3
}`)
    expect(result.errors.map((e) => e.message)).toEqual(['a generic function is declared at module level, not inside a test'])
    expect(setsOf(result, '__test1.add')).toEqual({ captures: ['n', 'i'], writes: ['n'] })
  })

  // A capturing function is one of the names of its test, as a function or
  // an import of the test is (reference 12.4): no other one takes its name.
  test('a capturing one is one of the names of its test', () => {
    expect(errorsOf(`
test "nested then plain" {
  let x: u32 = 1
  func keep() -> u32 => x
  func keep() -> u32 => 2
  assert keep() == 1
}
test "nested then import" {
  let z: u32 = 1
  func ask() -> u32 => z
  import "env" "ask" func ask() -> u32
  assert ask() == 1
}
test "nested twice" {
  let w: u32 = 1
  func two() -> u32 => w
  func two() -> u32 => w + 1
  assert two() == 1
}`)).toEqual([
      "'keep' is already declared in this test",
      "'ask' is already declared in this test",
      "'two' is already declared: a function that uses its test's variables cannot reuse the name of a nested function in scope (first declared at 16:8)",
    ])
  })

  // A test's function is $__test<n> in the output, and what it declares is
  // named under it, a nested function too (#61): two groups of one name
  // that each give a nested function of one name are two tests apart.
  test('a test\'s nested functions are named under the test, $__test<n>', async () => {
    const source = `func twice(comptime f: (u32) -> u32, x: u32) -> u32 => f(f(x))
test "g" {
  let k: u32 = 1
  if true {
    func f(x: u32) -> u32 => x + k
    assert twice(f, 1) == 3
  }
  test "x" { assert true }
}
test "g" {
  let k: u32 = 2
  if true {
    func f(x: u32) -> u32 => x + k
    assert twice(f, 1) == 5
  }
  test "y" { assert true }
}`
    const result = check(source)
    expect(result.errors).toEqual([])
    expect([...result.nested.values()].map((n) => n.path)).toEqual(['__test1.f', '__test3.f'])
    expect(result.instances.map((i) => i.name)).toEqual(['twice<__test1.f>', 'twice<__test3.f>'])
    expect(await runTestsOfSource(source)).toEqual({ ran: ['g > x', 'g > y'], failed: [] })
  })
})

// How a nested function compiles (N20 to N28): a module-level function
// that takes what it captures after its parameters and gives back what it
// writes after its results.
const sameBytes = async (nested: string, lifted: string) => {
  const [a, b] = [await wasmOfWat(watOfSource(nested)), await wasmOfWat(watOfSource(lifted))]
  expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
}

describe('nested functions: lowering', () => {
  test('the same module as the function written at module level with its captures (E1)', async () => {
    await sameBytes(`
export func count_over(xs: []u32, limit: u32) -> u32 {
  let n: u32 = 0
  func note(x: u32) {
    if x > limit { n += 1 }
  }
  for x in xs { note(x) }
  return n
}`, `
export func count_over(xs: []u32, limit: u32) -> u32 {
  let n: u32 = 0
  for x in xs { n = note(x, limit, n) }
  return n
}
func note(x: u32, limit: u32, n: u32) -> (n: u32) {
  if x > limit { n += 1 }
}`)
  })

  test('one that captures nothing costs nothing (E2)', async () => {
    await sameBytes(`
export func area(w: u32, h: u32) -> u32 {
  func double(x: u32) -> u32 => x * 2
  return w.double() * h
}`, `
export func area(w: u32, h: u32) -> u32 {
  return double(w) * h
}
func double(x: u32) -> u32 => x * 2`)
  })

  test('recursion with written captures (E3)', async () => {
    await sameBytes(`
export func climbs(n: u32) -> (ways: u32, calls: u32) {
  func walk(left: u32) {
    calls += 1
    if left == 0 {
      ways += 1
      return
    }
    walk(left - 1)
    if left >= 2 { walk(left - 2) }
  }
  walk(n)
}`, `
export func climbs(n: u32) -> (ways: u32, calls: u32) {
  set (ways, calls) = walk(n, ways, calls)
}
func walk(left: u32, ways: u32, calls: u32) -> (ways: u32, calls: u32) {
  calls += 1
  if left == 0 {
    ways += 1
    return
  }
  set (ways, calls) = walk(left - 1, ways, calls)
  if left >= 2 { set (ways, calls) = walk(left - 2, ways, calls) }
}`)
  })

  test('placed after their function, in pre-order (E21)', async () => {
    await sameBytes(`
export func a() -> u32 {
  func b() -> u32 {
    func c() -> u32 => 1
    return c()
  }
  func d() -> u32 => 2
  return b() + d()
}`, `
export func a() -> u32 {
  return b() + d()
}
func b() -> u32 {
  return c()
}
func c() -> u32 => 1
func d() -> u32 => 2`)
  })

  test('a call in an expression that writes a capture is a block; as a statement it is not', () => {
    const wat = watOfSource(`
export func order() -> u32 {
  let n: u32 = 1
  func bump() -> u32 {
    n += 1
    return n
  }
  bump()
  return bump() * 10 + n
}`)
    expect(wat).toContain('(call $order.bump (local.get $n)) (local.set $n)\n')
    expect(wat).toContain('(block (result i32) (call $order.bump (local.get $n)) (local.set $n))')
    expect(wat).toContain('(func $order.bump (param $n i32) (result i32 i32)')
  })

  test('a struct and a slice are captured as their parts', () => {
    const wat = watOfSource(`
type Point = (x: i32, y: i32)
export func walk(steps: u32, xs: []u32) -> i32 {
  let p = Point(0, 0)
  func step() {
    p.x += 1
    p.y -= xs.len as i32
  }
  for i in steps { step() }
  return p.x + p.y
}`)
    expect(wat).toContain('(func $walk.step (param $xs_ptr i32) (param $xs_len i32) (param $p_x i32) (param $p_y i32) (result i32 i32)')
    expect(wat).toContain('(call $walk.step (local.get $xs_ptr) (local.get $xs_len) (local.get $p_x) (local.get $p_y)) (local.set $p_y) (local.set $p_x)')
  })

  test('nested functions run as their function\'s variables say (N14 to N27)', async () => {
    const { failed, ran } = await runTestsOfSource(`
data words = [3:u32, 1, 4]
data tail = [1:u32, 4]
data buf = [1:u32, 2, 3, 4]
type Point = (x: i32, y: i32)
type Box = (arr: [3]u32, k: u32)
data cells = [7:u32, 8, 9]

func order() -> u32 {
  let n: u32 = 1
  func bump() -> u32 {
    n += 1
    return n
  }
  func show(a: u32) -> u32 => a * 100 + n
  return show(bump()) * 10 + n
}
func lost() -> u32 {
  let n: u32 = 1
  func bump() -> u32 {
    n += 5
    return 10
  }
  n += bump()
  return n
}
func kept() -> u32 {
  let n: u32 = 1
  func bump() -> u32 {
    n += 5
    return 10
  }
  n = bump() + n
  return n
}
func thirds(n: u32) -> (count: u32) {
  for i in n {
    func skip() { i += 2 }
    count += 1
    skip()
  }
}
func scaled(i: u32, k: u32) -> u32 {
  if let v = cells[i] {
    func times(m: u32) -> u32 => v * m
    return times(k)
  }
  return 0
}
func walk(steps: u32) -> Point {
  let p = Point(0, 0)
  func step() {
    p.x += 1
    p.y -= 1
  }
  for i in steps { step() }
  return p
}
func poked() -> u32 {
  let b = Box([1, 2, 3], 4)
  let a: [2][2]u32 = [[1, 2], [3, 4]]
  func poke() {
    b.arr[1] = 9
    a[1][0] = 7
  }
  poke()
  return b.arr[1] * 10 + a[1][0]
}
func passes(n: u32) -> u32 {
  let runs: u32 = 0
  func stop() { n = 0 }
  for i in n {
    runs += 1
    stop()
  }
  return runs
}
func later() -> u32 {
  let n: u32 = 0
  func bump() { n += 10 }
  func work() -> u32 {
    defer bump()
    n += 1
    return n
  }
  let r = work()
  return r * 100 + n
}
func outer() -> u32 {
  let n: u32 = 0
  func g() -> (r: u32) {
    defer if true {
      r = 7
      n = 5
    }
    r = 1
  }
  return g() * 10 + n
}
func bare() -> u32 {
  let n: u32 = 0
  func g() -> (r: u32) {
    defer if true { n = 5 }
    r = 1
    return
  }
  return g() * 10 + n
}
func arrow() -> u32 {
  let n: u32 = 2
  func g(x: u32) -> u32 => x + n
  return g(3)
}
func early(k: u32) -> u32 {
  let n: u32 = 0
  func g() -> u32 {
    for i in 10 {
      n += 1
      return i when i == k
    }
    return 99
  }
  let r = g()
  return r * 100 + n
}
func first_of_old(k: u32) -> u32 {
  let rest: []u32 = words
  func drop_one() -> u32 {
    rest = tail
    return k
  }
  return rest[drop_one()] ?? 99
}
func biggest() -> u32 {
  let n: u32 = 1
  func bump() -> u32 {
    n = 50
    return 2
  }
  return max(n, bump())
}
func total() -> u32 {
  func from(i: u32) -> u32 {
    if i < 4 { return buf[i] + from(i + 1) }
    i = 0
    return 0
  }
  return from(0)
}

test "orders" {
  assert order() == 2022
  assert lost() == 11
  assert kept() == 16
}
test "kinds of variables" {
  assert thirds(10) == 4
  assert scaled(1, 3) == 24
  assert scaled(5, 3) == 0
  assert walk(3).x == 3
  assert walk(3).y == -3
  assert poked() == 97
  assert passes(3) == 3
}
test "exits" {
  assert later() == 111
  assert outer() == 75
  assert bare() == 15
  assert arrow() == 5
  assert early(2) == 203
  assert early(20) == 9910
}
test "the object before its index" {
  assert first_of_old(0) == 3
  assert first_of_old(2) == 4
}
test "a builtin's operand read once" {
  assert biggest() == 2
}
test "recursion" {
  assert total() == 10
}
`)
    expect(ran.length).toBe(6)
    expect(failed).toEqual([])
  })
})

describe('nested functions: lowering, more shapes', () => {
  test('an assignment\'s address is taken before its value writes the index back', async () => {
    const { failed } = await runTestsOfSource(`
data buf = mut [0:u32; 8]
func w() -> u32 {
  let i: u32#8 = 1
  func setter() -> u32 {
    i = 5
    return 7
  }
  buf[i] = setter()
  return buf[1] * 10 + buf[5]
}
test "address first" { assert w() == 70 }
`)
    expect(failed).toEqual([])
  })

  test('a function at the top of a test that captures is emitted after the test\'s function', () => {
    const wat = watOfSource(`
test "counts" {
  let seen: u32 = 0
  func see(x: u32) { seen += x }
  see(2)
  assert seen == 2
}`)
    // watOfSource builds no tests: nothing of it is emitted
    expect(wat).not.toContain('see')
  })

  test('nested functions of tests, of a function of a test, and of a case-2 function run', async () => {
    const { failed, ran } = await runTestsOfSource(`
test "counts" {
  let seen: u32 = 0
  func see(x: u32) { seen += x }
  func twice(x: u32) -> u32 {
    func half(y: u32) -> u32 => y / 2
    return half(x) * 4
  }
  see(2)
  see(twice(3))
  for i in 3 {
    func add() { seen += i }
    add()
  }
  assert seen == 9
}
`)
    expect(ran).toEqual(['counts'])
    expect(failed).toEqual([])
  })
})

test("the object of a checked index or a range is evaluated before the index (N16, without nested functions)", async () => {
  const { failed } = await runTestsOfSource(`
data small = [1:u32, 2]
data big = [10:u32, 20, 30, 40, 50, 60, 70, 80]
data words = [3:u32, 1, 4]
data tail = [1:u32, 4]
data cells = mut [5:u32, 6, 7]
export func s1(k: u32) -> u32 {
  let xs: []u32 = small
  return xs[if true { xs = big
    k } else { 0 }] ?? 999
}
export func s2(k: u32) -> u32 {
  let xs: []u32 = small
  if let v = xs[if true { xs = big
    k } else { 0 }] {
    return v
  }
  return 999
}
export func s3(k: u32) -> u32 {
  let xs: []u32 = small
  let ys = xs[0..(if true { xs = big
    k } else { 0 })] ?? xs
  return ys.len
}
export func first_of_old(k: u32) -> u32 {
  let rest: []u32 = words
  let v = rest[if true { rest = tail
    k } else { 0 }] ?? 99
  return v
}
export func addr(k: u32) -> u32 {
  let xs: []mut u32 = cells
  if let p = &xs[if true { xs = xs[0..1] ?? xs
    k } else { 0 }] {
    return p.*
  }
  return 99
}
test "left to right" {
  assert s1(5) == 999
  assert s2(5) == 999
  assert s3(5) == 8
  assert first_of_old(0) == 3
  assert first_of_old(2) == 4
  assert addr(2) == 7
}
`)
  expect(failed).toEqual([])
})

// Builds the program of `main.ents` among `files`, with its tests, and runs
// them, as `encantis test` does
async function runProgram(files: Record<string, string>): Promise<{ ran: string[]; failed: string[]; wat: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'encantis-nested-'))
  try {
    for (const [name, source] of Object.entries(files)) {
      await mkdir(dirname(join(dir, name)), { recursive: true })
      await writeFile(join(dir, name), source)
    }
    const path = join(dir, 'main.ents')
    const load = await loadModule(path, { includeTests: true })
    if (load.errors.length > 0) throw new Error(load.errors.map((e) => e.message).join('\n'))
    const check = typecheckProgram(load.modules, path, { includeTests: true })
    if (check.errors.length > 0) throw new Error(check.errors.map((e) => e.message).join('\n'))
    const { wat, testExports, testTitles, standIns } = programToWatWithTests(load.modules, check.results, path)
    const bytes = await wasmOfWat(wat)
    const module = await WebAssembly.compile(bytes)
    const host = createTestHost(module, () => {}, undefined, bytes, standIns)
    const instance = await WebAssembly.instantiate(module, host.imports)
    host.attach(instance)
    const failed: string[] = []
    for (const [i, name] of testExports.entries()) {
      try {
        ;(instance.exports[name] as () => void)()
      } catch {
        failed.push(testTitles[i])
      }
    }
    return { ran: testTitles, failed, wat }
  } finally {
    await rm(dir, { recursive: true })
  }
}

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
`
const signatureOf = (wat: string, name: string) => wat.split('\n').find((line) => line.trim().startsWith(`(func $${name} `))?.trim()

describe('nested functions: comptime function parameters (N29 to N37)', () => {
  test('a nested function that captures, given for a comptime function parameter (E10)', async () => {
    const source = `${SORT}
export func by_distance(xs: []mut i32, center: i32) -> u32 {
  let compared: u32 = 0
  func closer(a: i32, b: i32) -> bool {
    compared += 1
    return abs(a - center) < abs(b - center)
  }
  xs.sort(closer)
  return compared
}
data nums = mut [5:i32, -1, 8, 3]
test "sorted" {
  assert by_distance(nums, 4) == 6
  assert nums[0] == 5 && nums[1] == 3 && nums[2] == 8 && nums[3] == -1
}`
    const result = check(source)
    expect(result.errors).toEqual([])
    expect(result.instances.map((i) => [i.name, i.label])).toEqual([['sort<i32|by_distance.closer>', 'sort(T = i32, before = by_distance.closer)']])
    const wat = watOfSource(source)
    expect(signatureOf(wat, 'sort<i32|by_distance.closer>')).toBe('(func $sort<i32|by_distance.closer> (param $xs_ptr i32) (param $xs_len i32) (param $center i32) (param $compared i32) (result i32)')
    expect(signatureOf(wat, 'by_distance.closer')).toBe('(func $by_distance.closer (param $a i32) (param $b i32) (param $center i32) (param $compared i32) (result i32 i32)')
    expect((await runTestsOfSource(source)).failed).toEqual([])
  })

  test('a nested function of a generic calls the function given for its parameter (E25)', async () => {
    const source = `func each_twice(comptime visit: (u32) -> (), xs: []u32) {
  func both(x: u32) {
    visit(x)
    visit(x)
  }
  for x in xs { both(x) }
}
export func total_twice(xs: []u32) -> u32 {
  let total: u32 = 0
  func add(x: u32) { total += x }
  each_twice(add, xs)
  return total
}
test "twice" { assert total_twice([1, 2, 3]) == 12 }`
    expect(signatureOf(watOfSource(source), 'each_twice<total_twice.add>.both')).toBe('(func $each_twice<total_twice.add>.both (param $x i32) (param $total i32) (result i32)')
    expect((await runTestsOfSource(source)).failed).toEqual([])
  })

  test('own captures first, then the hidden ones, through two generics (count_seen)', async () => {
    const source = `func count_if(comptime T: type, xs: []T, comptime keep: (T) -> bool) -> (n: u32) {
  for x in xs {
    if keep(x) { n += 1 }
  }
}
func count_seen(comptime T: type, xs: []T, comptime keep: (T) -> bool) -> u32 {
  let seen: u32 = 0
  func k2(x: T) -> bool {
    seen += 1
    return keep(x)
  }
  return xs.count_if(k2) + seen
}
export func over_limit(xs: []u32, limit: u32) -> u32 {
  func big(x: u32) -> bool => x > limit
  return xs.count_seen(big)
}
test "t" { assert over_limit([1, 5, 9], 4) == 5 }`
    const wat = watOfSource(source)
    expect(signatureOf(wat, 'count_seen<u32|over_limit.big>.k2')).toBe('(func $count_seen<u32|over_limit.big>.k2 (param $x i32) (param $seen i32) (param $limit i32) (result i32 i32)')
    expect(signatureOf(wat, 'count_if<u32|count_seen<u32|over_limit.big>.k2>')).toBe('(func $count_if<u32|count_seen<u32|over_limit.big>.k2> (param $xs_ptr i32) (param $xs_len i32) (param $seen i32) (param $limit i32) (result i32 i32)')
    expect((await runTestsOfSource(source)).failed).toEqual([])
  })

  test('two functions given with an overlapping capture: one copy, in parameter order', () => {
    const wat = watOfSource(`func pair(comptime f: () -> u32, comptime g: () -> u32) -> u32 => f() + g()
export func go(a: u32, b: u32) -> u32 {
  let c: u32 = 1
  func one() -> u32 => b + a
  func two() -> u32 {
    c += a
    return c
  }
  return pair(one, two) + c
}`)
    expect(signatureOf(wat, 'pair<go.one|go.two>')).toBe('(func $pair<go.one|go.two> (param $a i32) (param $b i32) (param $c i32) (result i32 i32)')
  })

  describe('a captured variable never shares a register with a variable of the instance of the same name (N30)', () => {
    test('a named result, a let and a loop variable of the generic', async () => {
      const source = `data small = [1:u32, 5, 9, 2, 7]
func count_if(comptime keep: (u32) -> bool, xs: []u32) -> (n: u32) {
  for x in xs {
    if keep(x) { n += 1 }
  }
}
export func by_result() -> u32 {
  let n: u32 = 0
  func inc(x: u32) -> bool {
    n += x
    return n > 6
  }
  let a = count_if(inc, small)
  return a * 10000 + n
}
func count_let(comptime keep: (u32) -> bool, xs: []u32) -> u32 {
  let seen: u32 = 0
  let c: u32 = 0
  for x in xs {
    seen += 1
    if keep(x) { c += 1 }
  }
  return c * 100 + seen
}
export func by_let(k: u32) -> u32 {
  let seen: u32 = 0
  func keep(x: u32) -> bool {
    seen += 10
    return x > k
  }
  return count_let(keep, small) * 1000 + seen
}
func count_loop(comptime keep: (u32) -> bool, n: u32) -> u32 {
  let c: u32 = 0
  for i in n {
    if keep(i) { c += 1 }
  }
  return c
}
export func by_loop_variable(k: u32) -> u32 {
  let i: u32 = 100
  func keep(x: u32) -> bool {
    i += 1
    return x > k
  }
  return count_loop(keep, 8) * 1000 + i
}
test "results" {
  assert by_result() == 30024
  assert by_let(4) == 305050
  assert by_loop_variable(4) == 3108
}`
      const wat = watOfSource(source)
      expect(signatureOf(wat, 'count_if<by_result.inc>')).toBe('(func $count_if<by_result.inc> (param $xs_ptr i32) (param $xs_len i32) (param $n i32) (result i32 i32)')
      expect(wat).toContain('(local $_1_n i32)')
      expect((await runTestsOfSource(source)).failed).toEqual([])
    })

    test('a parameter of the generic, and the comparator of an argsort that captures xs', async () => {
      const source = `${SORT}
data vals = [40:u32, 10, 30, 20]
data idx = mut [0:u32, 1, 2, 3]
export func argsort(xs: []u32, order: []mut u32) {
  func by_value(a: u32, b: u32) -> bool => (xs[a] ?? 0) < (xs[b] ?? 0)
  order.sort(by_value)
}
func count_lim(comptime keep: (u32) -> bool, xs: []u32, limit: u32) -> u32 {
  let c: u32 = 0
  for x in xs {
    if keep(x) && x < limit { c += 1 }
  }
  return c
}
export func by_param(limit: u32) -> u32 {
  func keep(x: u32) -> bool => x > limit
  return count_lim(keep, [1, 5, 9, 2, 7], 8)
}
test "sorted" {
  argsort(vals, idx)
  assert idx[0] == 1 && idx[1] == 3 && idx[2] == 2 && idx[3] == 0
  assert by_param(4) == 2
}`
      expect(signatureOf(watOfSource(source), 'sort<u32|argsort.by_value>')).toBe('(func $sort<u32|argsort.by_value> (param $xs_ptr i32) (param $xs_len i32) (param $_1_xs_ptr i32) (param $_1_xs_len i32)')
      expect((await runTestsOfSource(source)).failed).toEqual([])
    })

    test('a comparator for sort that captures x and i, the names of its locals', async () => {
      const source = `${SORT}
export func by_distance(xs: []mut i32, x: i32) -> u32 {
  let i: u32 = 0
  func closer(a: i32, b: i32) -> bool {
    i += 1
    return abs(a - x) < abs(b - x)
  }
  xs.sort(closer)
  return i
}
data nums = mut [5:i32, -1, 8, 3]
test "sorted" {
  assert by_distance(nums, 4) == 6
  assert nums[0] == 5 && nums[1] == 3 && nums[2] == 8 && nums[3] == -1
}`
      expect((await runTestsOfSource(source)).failed).toEqual([])
    })

    test('a nested function of the generic: its own parameter, and a variable it captures, named like a hidden one', async () => {
      const source = `func each_twice(comptime visit: (u32) -> (), xs: []u32) {
  func both(x: u32) {
    visit(x)
    visit(x)
  }
  for v in xs { both(v) }
}
export func total_twice(xs: []u32, x: u32) -> u32 {
  let total: u32 = 0
  func add(v: u32) { total += v + x }
  each_twice(add, xs)
  return total
}
func outer_g(comptime f: (u32) -> u32, x: u32) -> u32 {
  let acc: u32 = 0
  func step(y: u32) -> u32 {
    acc += f(y)
    return acc
  }
  return step(x) + step(x)
}
export func by_nested(k: u32) -> u32 {
  let acc: u32 = 1
  func f(y: u32) -> u32 {
    acc *= 2
    return y + acc
  }
  return outer_g(f, k) * 100 + acc
}
test "t" {
  assert total_twice([1, 2], 10) == 46
  assert by_nested(3) == 1704
}`
      const wat = watOfSource(source)
      expect(signatureOf(wat, 'each_twice<total_twice.add>.both')).toBe('(func $each_twice<total_twice.add>.both (param $x i32) (param $_1_x i32) (param $total i32) (result i32)')
      expect(signatureOf(wat, 'outer_g<by_nested.f>.step')).toBe('(func $outer_g<by_nested.f>.step (param $y i32) (param $acc i32) (param $_1_acc i32) (result i32 i32 i32)')
      expect((await runTestsOfSource(source)).failed).toEqual([])
    })

    test('a narrowed index of the generic is not overwritten by the write-back', async () => {
      const source = `data buf = [1:u32, 2, 3, 4]
data secret = [77:u32, 88, 99]
func probe(comptime keep: () -> (), n: u32) -> u32 {
  let i = n
  if i < 4 {
    keep()
    return buf[i]
  }
  return 0
}
export func run(k: u32) -> u32 {
  let i: u32 = 0
  func keep() { i = k }
  return probe(keep, 1)
}
test "buf[1]" {
  assert run(5) == 2
  assert run(100000) == 2
}`
      expect((await runTestsOfSource(source)).failed).toEqual([])
    })

    test('in a test, and across modules', async () => {
      expect((await runTestsOfSource(`data small = [1:u32, 5, 9, 2, 7]
func count_if(comptime keep: (u32) -> bool, xs: []u32) -> (n: u32) {
  for x in xs {
    if keep(x) { n += 1 }
  }
}
test "clash" {
  let n: u32 = 0
  func inc(x: u32) -> bool {
    n += x
    return n > 6
  }
  let a = count_if(inc, small)
  assert a == 3
  assert n == 24
}`)).failed).toEqual([])
      const { ran, failed } = await runProgram({
        'main.ents': `import "./lib" (
  "count_seen" func count_seen(comptime T: type, xs: []T, comptime keep: (T) -> bool) -> u32
)
data small = [1:u32, 5, 9, 2, 7]
export func run(limit: u32) -> u32 {
  let seen: u32 = 0
  func big(x: u32) -> bool {
    seen += 1
    return x > limit
  }
  return small.count_seen(big) * 100 + seen
}
test "t" { assert run(4) == 305005 }`,
        'lib.ents': `export func count_seen(comptime T: type, xs: []T, comptime keep: (T) -> bool) -> u32 {
  let seen: u32 = 0
  let c: u32 = 0
  for x in xs {
    seen += 10
    if keep(x) { c += 1 }
  }
  return c * 1000 + seen
}`,
      })
      expect(ran).toEqual(['t'])
      expect(failed).toEqual([])
    })
  })

  test('each instance of a generic has its own nested functions (E11)', async () => {
    const source = `func count_if(comptime T: type, xs: []T, comptime keep: (T) -> bool) -> (n: u32) {
  for x in xs {
    if keep(x) { n += 1 }
  }
}
func over(comptime T: type, xs: []T, limit: T) -> u32 {
  func big(x: T) -> bool => x > limit
  return xs.count_if(big)
}
data small = [1:u32, 5, 9]
data wide = [0.5, 2.5]
test "own" {
  assert over(small, 4:u32) == 2
  assert over(wide, 1.0) == 1
}`
    const result = check(source)
    expect(result.errors).toEqual([])
    expect(result.instances.map((i) => i.name).sort()).toEqual(['count_if<f64|over<f64>.big>', 'count_if<u32|over<u32>.big>', 'over<f64>', 'over<u32>'])
    expect((await runTestsOfSource(source)).failed).toEqual([])
  })

  test('two calls giving one nested function share an instance; two nested functions are two', () => {
    const result = check(`func apply(comptime f: (u32) -> u32, x: u32) -> u32 => f(x)
export func go(n: u32) -> u32 {
  func a(x: u32) -> u32 => x + n
  func b(x: u32) -> u32 => x + n
  let t: u32 = 0
  for i in 3 { t += apply(a, i) }
  return t + apply(a, 1) + apply(b, 1)
}`)
    expect(result.errors).toEqual([])
    expect(result.instances.map((i) => i.name)).toEqual(['apply<go.a>', 'apply<go.b>'])
  })

  test('a generic that gives its own nested function to itself stops at the limit', () => {
    expect(errorsOf(`func start() { }
func grow(comptime f: () -> ()) {
  func again() { f() }
  grow(again)
}
export func go() { grow(start) }`)[0]).toStartWith("too many nested instantiations (64) while instantiating 'grow'")
  })

  test('a nested function that gives itself to a generic it calls: one instance', async () => {
    const source = `func each(comptime f: (u32) -> (), n: u32) {
  for i in n { f(i) }
}
export func depth(n: u32) -> u32 {
  let total: u32 = 0
  func visit(k: u32) {
    total += 1
    if k > 0 { each(visit, k - 1) }
  }
  visit(n)
  return total
}
test "visits" { assert depth(3) == 3 && depth(4) == 5 }`
    const result = check(source)
    expect(result.errors).toEqual([])
    expect(result.instances.map((i) => i.name)).toEqual(['each<depth.visit>'])
    expect((await runTestsOfSource(source)).failed).toEqual([])
  })

  test('functions declared in a test are given too (N37)', async () => {
    const source = `${SORT}
data nums = mut [5:i32, -1, 8, 3]
test "a test sorts with a comparator that captures" {
  let center: i32 = 4
  func closer(a: i32, b: i32) -> bool => abs(a - center) < abs(b - center)
  func desc(a: i32, b: i32) -> bool => a > b
  nums.sort(closer)
  assert nums[0] == 5 && nums[1] == 3 && nums[2] == 8 && nums[3] == -1
  nums.sort(desc)
  assert nums[0] == 8 && nums[3] == -1
}`
    const result = check(source)
    expect(result.errors).toEqual([])
    expect(result.instances.map((i) => [i.name, i.label])).toEqual([
      ['sort<i32|__test1.closer>', 'sort(T = i32, before = test "a test sorts with a comparator that captures".closer)'],
      ['sort<i32|__test1.desc>', 'sort(T = i32, before = test "a test sorts with a comparator that captures".desc)'],
    ])
    const { failed, ran } = await runTestsOfSource(source)
    expect(ran.length).toBe(1)
    expect(failed).toEqual([])
  })

  // An instance given a function a test imports calls the import by its
  // name in the test build: $__test<n>.<name> from the host, the other
  // module's name for a function of a source module.
  test('functions a test imports are given too, from the host or another module', async () => {
    const source = `func apply(comptime f: (u32) -> u32, x: u32) -> u32 => f(x)
test "gives a host import" {
  import "env" "f" func f(x: u32) -> u32
  let k: u32 = 0
  if k == 1 { assert apply(f, 2) == 3 }
}
test "gives a source import" {
  import "./slib.ents" ("g" func tri(x: u32) -> u32)
  assert apply(tri, 2) == 6
}
test "gives a nested function that calls one" {
  import "./slib.ents" ("g" func tri(x: u32) -> u32)
  let k: u32 = 1
  func plus(x: u32) -> u32 => tri(x) + k
  assert apply(plus, 2) == 7
}`
    const { ran, failed, wat } = await runProgram({ 'main.ents': source, 'slib.ents': 'export func g(x: u32) -> u32 => x * 3' })
    expect(wat).toContain('(call $__test1.f (local.get $x))')
    expect(wat).toContain('(call $slib$g (local.get $x))')
    expect(ran).toEqual(['gives a host import', 'gives a source import', 'gives a nested function that calls one'])
    expect(failed).toEqual([])
  })

  // A test's function or import takes the name over in module scope for
  // what is checked after the test (#74), but module code, a generic's
  // instances (checked after every test) and the other tests give the
  // module's function of the name (12.4)
  test('module code and other tests give the module\'s function where a test took its name over', async () => {
    const source = `func helper(x: u32) -> u32 => x + 1
func apply(comptime f: (u32) -> u32, x: u32) -> u32 => f(x)
func outer(comptime T: type, x: T) -> u32 => apply(helper, 2)
export func use(x: u32) -> u32 => outer(x)
test "before them" { assert use(0) == 3 }
test "declares" {
  func helper(x: u32) -> u32 => x * 3
  assert apply(helper, 2) == 6
}
test "imports" {
  import "./slib.ents" ("g" func helper(x: u32) -> u32)
  assert apply(helper, 2) == 6
}
test "from the host" {
  import "env" "helper" func helper(x: u32) -> u32
  let k: u32 = 0
  if k == 1 { assert apply(helper, 2) == 6 }
}
export func later(x: u32) -> u32 => apply(helper, x)
func wrap(comptime T: type, x: T) -> T => apply(helper, x)
test "after them" {
  assert later(2) == 3
  assert wrap(2:u32) == 3
  assert apply(helper, 2) == 3
}`
    const { ran, failed, wat } = await runProgram({ 'main.ents': source, 'slib.ents': 'export func g(x: u32) -> u32 => x * 3' })
    expect(failed).toEqual([])
    expect(ran.length).toBe(5)
    expect(wat.match(/\(func \$apply<[^ ]*/g)).toEqual(['(func $apply<__test2.helper>', '(func $apply<__test4.helper>', '(func $apply<g@slib>', '(func $apply<helper>'])
  })

  // As a module's import of it is: every name of one function makes one
  // instance (8.4)
  test('a function a test imports from another module makes the one instance of that function', async () => {
    const source = `import "./slib.ents" ("g" func g(x: u32) -> u32)
func apply(comptime f: (u32) -> u32, x: u32) -> u32 => f(x)
export func use(x: u32) -> u32 => apply(g, x)
test "a" {
  import "./slib.ents" ("g" func g(x: u32) -> u32)
  assert apply(g, 2) == 6 && use(2) == 6
}
test "b" {
  import "./slib.ents" ("g" func tri(x: u32) -> u32)
  assert apply(tri, 3) == 9
}
export func later(x: u32) -> u32 => apply(g, x) + 1`
    const { failed, wat } = await runProgram({ 'main.ents': source, 'slib.ents': 'export func g(x: u32) -> u32 => x * 3' })
    expect(failed).toEqual([])
    expect(wat.match(/\(func \$apply<[^ ]*/g)).toEqual(['(func $apply<g@slib>'])
  })

  test('across modules: the importer\'s tests call the module\'s function where the module\'s test took its name over', async () => {
    const lib = `func apply(comptime f: (u32) -> u32, x: u32) -> u32 => f(x)
func helper(x: u32) -> u32 => x + 1
test "declares" {
  func helper(x: u32) -> u32 => x + 100
  assert apply(helper, 2) == 102
}
test "imports" {
  import "./slib.ents" ("g" func helper(x: u32) -> u32)
  assert apply(helper, 2) == 6
}
export func later(x: u32) -> u32 => apply(helper, x)
test "after them" { assert later(2) == 3 }`
    const main = `import "./lib.ents" ("later" func later(x: u32) -> u32)
test "main" { assert later(2) == 3 }`
    const { ran, failed } = await runProgram({ 'main.ents': main, 'lib.ents': lib, 'slib.ents': 'export func g(x: u32) -> u32 => x * 3' })
    expect(ran).toEqual(['main'])
    expect(failed).toEqual([])
    expect(await runTestsOfSource(lib, { 'slib.ents': 'export func g(x: u32) -> u32 => x * 3' })).toEqual({ ran: ['declares', 'imports', 'after them'], failed: [] })
  })

  test('narrowing sees a write made through a comptime argument', () => {
    expect(errorsOf(`data buf = [1:u32, 2, 3, 4]
func apply(comptime f: () -> ()) { f() }
func at(i: u32) -> u32 {
  func far() { i = 100 }
  if i < 4 {
    apply(far)
    return buf[i]
  }
  return 0
}`).some((e) => e.startsWith("runtime index on *[4]u32 requires 'if let' or '??'"))).toBe(true)
  })

  test('across modules: the instance of another module\'s generic calls the nested function by its extern name (N33)', async () => {
    const { failed, wat } = await runProgram({
      'sorting.ents': `export ${SORT}`,
      'main.ents': `import "./sorting" "sort" func sort(comptime T: type, xs: []mut T, comptime before: (T, T) -> bool)
export func by_distance(xs: []mut i32, center: i32) -> u32 {
  let compared: u32 = 0
  func closer(a: i32, b: i32) -> bool {
    compared += 1
    return abs(a - center) < abs(b - center)
  }
  xs.sort(closer)
  return compared
}
data nums = mut [5:i32, -1, 8, 3]
test "sorted" {
  assert by_distance(nums, 4) == 6
  assert nums[0] == 5 && nums[1] == 3 && nums[2] == 8 && nums[3] == -1
}`,
    })
    expect(failed).toEqual([])
    expect(signatureOf(wat, 'sorting$sort<i32|by_distance.closer@main>')).toBe('(func $sorting$sort<i32|by_distance.closer@main> (param $xs_ptr i32) (param $xs_len i32) (param $center i32) (param $compared i32) (result i32)')
  })

  test('across modules: count_seen in another module, the same order', async () => {
    const { failed, wat } = await runProgram({
      'lib.ents': `export func count_if(comptime T: type, xs: []T, comptime keep: (T) -> bool) -> (n: u32) {
  for x in xs {
    if keep(x) { n += 1 }
  }
}
export func count_seen(comptime T: type, xs: []T, comptime keep: (T) -> bool) -> u32 {
  let seen: u32 = 0
  func k2(x: T) -> bool {
    seen += 1
    return keep(x)
  }
  return xs.count_if(k2) + seen
}`,
      'main.ents': `import "./lib" "count_seen" func count_seen(comptime T: type, xs: []T, comptime keep: (T) -> bool) -> u32
export func over_limit(xs: []u32, limit: u32) -> u32 {
  func big(x: u32) -> bool => x > limit
  return xs.count_seen(big)
}
test "t" { assert over_limit([1, 5, 9], 4) == 5 }`,
    })
    expect(failed).toEqual([])
    expect(signatureOf(wat, 'lib$count_seen<u32|over_limit.big@main>.k2')).toBe('(func $lib$count_seen<u32|over_limit.big@main>.k2 (param $x i32) (param $seen i32) (param $limit i32) (result i32 i32)')
  })

  // An imported module's tests are checked with the program and not built
  // (12.5): an instance one of them gives its function is not emitted.
  test('across modules: an imported module\'s own tests give their functions, and the importer\'s tests build', async () => {
    const lib = `export func apply(comptime f: (u32) -> u32, x: u32) -> u32 => f(x) + f(x)
export func twice(x: u32) -> u32 => apply(double, x)
func double(x: u32) -> u32 => x * 2
test "lib's plain" {
  func add(x: u32) -> u32 => x + 1
  assert apply(add, 1) == 4
}
test "lib's capturing" {
  let k: u32 = 1
  func add(x: u32) -> u32 => x + k
  assert apply(add, 1) == 4
}
test "lib's import" {
  import "./other.ents" ("g" func tri(x: u32) -> u32)
  assert apply(tri, 1) == 6
}`
    const other = 'export func g(x: u32) -> u32 => x * 3'
    const main = `import "./lib.ents" (
  "apply" func apply(comptime f: (u32) -> u32, x: u32) -> u32
  "twice" func twice(x: u32) -> u32
)
func inc(x: u32) -> u32 => x + 1
test "main's" {
  let k: u32 = 10
  func plus(x: u32) -> u32 => x + k
  assert apply(plus, 1) == 22 && apply(inc, 1) == 4 && twice(3) == 12
}`
    const { ran, failed, wat } = await runProgram({ 'main.ents': main, 'lib.ents': lib, 'other.ents': other })
    expect(ran).toEqual(["main's"])
    expect(failed).toEqual([])
    expect(wat).not.toContain('__test1.add')
    expect(wat).not.toContain('__test2.add')
    expect(wat).not.toContain('__test3.tri')
    expect(wat).toContain('(func $lib$apply<__test1.plus@main>')
    expect(wat).toContain('(func $lib$apply<double>')
    // Built by itself, the module's own tests pass
    expect(await runTestsOfSource(lib, { 'other.ents': other })).toEqual({ ran: ["lib's plain", "lib's capturing", "lib's import"], failed: [] })
  })

  // An instance left out takes with it those given its nested functions,
  // in its module and in a third one, to a fixed point
  test('across modules: an instance given a nested function of one left out is left out too', async () => {
    const third = `export func run(comptime h: (u32) -> u32, x: u32) -> u32 {
  func twice(y: u32) -> u32 => h(h(y))
  return pass(twice, x)
}
export func pass(comptime p: (u32) -> u32, x: u32) -> u32 => p(x)`
    const lib = `import "./third.ents" ("run" func run(comptime h: (u32) -> u32, x: u32) -> u32)
export func apply(comptime f: (u32) -> u32, x: u32) -> u32 {
  func g(y: u32) -> u32 => f(y) + 1
  return run(g, x) + again(g, x)
}
export func again(comptime h: (u32) -> u32, x: u32) -> u32 => h(x)
test "lib's" {
  func add(x: u32) -> u32 => x + 1
  assert apply(add, 1) == 8
}`
    const main = `import "./lib.ents" ("apply" func apply(comptime f: (u32) -> u32, x: u32) -> u32)
func inc(x: u32) -> u32 => x + 1
test "main's" { assert apply(inc, 1) == 8 }`
    const { ran, failed, wat } = await runProgram({ 'main.ents': main, 'lib.ents': lib, 'third.ents': third })
    expect(ran).toEqual(["main's"])
    expect(failed).toEqual([])
    expect(wat).not.toContain('__test1.add')
    expect(wat).toContain('(func $third$pass<run<apply<inc@main>.g@lib>.twice>')
    expect(await runTestsOfSource(lib, { 'third.ents': third })).toEqual({ ran: ["lib's"], failed: [] })
  })
})

describe('nested functions: the editor (N42)', () => {
  const source = `${SORT}
export func by_distance(xs: []mut i32, center: i32) -> u32 {
  let compared: u32 = 0
  func closer(a: i32, b: i32) -> bool {
    compared += 1
    return abs(a - center) < abs(b - center)
  }
  func plain(a: i32) -> i32 => a
  xs.sort(closer)
  return compared + plain(1) as u32
}
`
  const at = (text: string, nth = 0) => {
    let i = -1
    for (let k = 0; k <= nth; k++) i = source.indexOf(text, i + 1)
    return i
  }
  const setup = () => {
    const parsed = parse(source)
    const module = parsed.module!
    return { module, result: typecheck(module, { source }) }
  }

  test('hover on its name, a call and a comptime argument', () => {
    const { module, result } = setup()
    for (const offset of [at('closer(a'), at('closer)')]) {
      const h = hover(source, module, result, offset)!
      expect(hoverText(h)).toBe('func closer: func(a: i32, b: i32) -> bool — nested in by_distance; captures center, compared (writes compared)')
      expect(h.captures).toBe('center, compared (writes compared)')
    }
    expect(hoverText(hover(source, module, result, at('plain(1)'))!)).toBe('func plain: func(a: i32) -> i32 — nested in by_distance')
  })

  test('hover on a captured variable inside it', () => {
    const { module, result } = setup()
    expect(hoverText(hover(source, module, result, at('compared += 1'))!)).toBe('local compared: u32 — captured from by_distance')
    expect(hoverText(hover(source, module, result, at('compared + plain'))!)).toBe('local compared: u32')
  })

  test('definition, references and rename', () => {
    const { module, result } = setup()
    const def = at('closer(a')
    expect(gotoDefinition(source, module, result, at('closer)'))?.location.offset).toBe(def)
    expect(findReferences(source, module, result, def)?.references.map((r) => r.offset)).toEqual([at('closer)')])
    expect(rename(source, module, result, at('closer)'))?.locations.map((l) => l.offset)).toEqual([def, at('closer)')])
    // A captured variable's uses inside the nested function are its uses
    const compared = at('compared: u32')
    expect(gotoDefinition(source, module, result, at('compared += 1'))?.location.offset).toBe(compared)
    expect(rename(source, module, result, compared)?.locations.map((l) => l.offset)).toEqual([compared, at('compared += 1'), at('compared + plain')])
  })

  test('at the top of a test: definition, references and rename from its declaration; hover names the test', () => {
    const src = `export func one() -> u32 => 1
test "t" {
  let k: u32 = 3
  func seek() -> u32 => k
  if true {
    func deep() -> u32 => seek() + k
    assert deep() == 6
  }
}`
    const module = parse(src).module!
    const result = typecheck(module, { source: src, includeTests: true })
    const def = src.indexOf('seek()')
    const call = src.indexOf('seek() +')
    for (const offset of [def, call]) {
      expect(gotoDefinition(src, module, result, offset)?.location.offset).toBe(def)
      expect(findReferences(src, module, result, offset)?.references.map((r) => r.offset)).toEqual([call])
      expect(rename(src, module, result, offset)?.locations.map((l) => l.offset)).toEqual([def, call])
    }
    expect(hoverText(hover(src, module, result, def)!)).toBe('func seek: func() -> u32 — nested in test "t"; captures k')
    expect(hoverText(hover(src, module, result, src.indexOf('deep()'))!)).toBe('func deep: func() -> u32 — nested in test "t"; captures k')
  })

  // A test's frame is __test<n> in the output, and named as its source
  // names it everywhere it is shown: hover and an instance's label
  test('deeper in a test, hover and labels name the test, not __test<n>', () => {
    const src = `func apply(comptime f: (u32) -> u32, x: u32) -> u32 => f(x)
test "one" {
  let k: u32 = 1
  func step(x: u32) -> u32 {
    let y = x + k
    func g() -> u32 => y
    return g()
  }
  assert apply(step, 1) == 2
}`
    const module = parse(src).module!
    const result = typecheck(module, { source: src, includeTests: true })
    expect(result.errors).toEqual([])
    expect(hoverText(hover(src, module, result, src.indexOf('y\n'))!)).toBe('local y: u32 — captured from test "one".step')
    expect(hoverText(hover(src, module, result, src.indexOf('g()'))!)).toBe('func g: func() -> u32 — nested in test "one".step; captures y')
    expect(result.instances.map((i) => [i.name, i.label])).toEqual([['apply<__test1.step>', 'apply(f = test "one".step)']])
    expect([...result.nested.values()].map((n) => n.path)).toEqual(['__test1.step', '__test1.step.g'])
  })

  // Passed on to another generic, the comptime parameter keeps the label of
  // the function given, in messages and hover too
  test('an instance a test\'s function reaches through another generic names the test', () => {
    const src = `func apply(comptime f: (u32) -> u32, x: u32) -> u32 {
  let y: u8 = f(x)
  return y
}
func outer(comptime f: (u32) -> u32, x: u32) -> u32 => apply(f, x) + 1
test "t" {
  func plain(x: u32) -> u32 => x + 1
  let k: u32 = 1
  func cap(x: u32) -> u32 => x + k
  import "env" "h" func hf(x: u32) -> u32
  assert outer(plain, 1) + outer(cap, 1) == 6
  if k == 2 { assert outer(hf, 1) == 3 }
}`
    const module = parse(src).module!
    const result = typecheck(module, { source: src, includeTests: true })
    expect(result.errors.map((e) => e.message)).toEqual([
      'cannot assign u32 to u8, in apply(f = test "t".plain)',
      'cannot assign u32 to u8, in apply(f = test "t".cap)',
      'cannot assign u32 to u8, in apply(f = test "t".hf)',
    ])
    expect(result.instances.map((i) => i.label).filter((l) => l.startsWith('apply'))).toEqual([
      'apply(f = test "t".plain)', 'apply(f = test "t".cap)', 'apply(f = test "t".hf)',
    ])
    expect(hoverText(hover(src, module, result, src.indexOf('f(x)'))!)).toContain('in apply(f = test "t".cap): test "t".cap(x: u32) -> u32')
  })

  // As the test runner names a test: its groups' names before its own, a
  // name written as a string is, and a test without a name as `test`
  test('the test is named as the runner names it, with its groups, its name written as a string', () => {
    const src = `func apply(comptime f: (u32) -> u32, x: u32) -> u32 => f(x)
test {
  let k: u32 = 1
  func step(x: u32) -> u32 => x + k
  assert apply(step, 1) == 2
}
test "g1" {
  test "inner" {
    let k: u32 = 2
    func step(x: u32) -> u32 => x + k
    assert apply(step, 1) == 3
  }
}
test "g2" {
  test "inner" {
    let k: u32 = 3
    func step(x: u32) -> u32 => x + k
    assert apply(step, 1) == 4
  }
}
test "say \\"hi\\"" {
  let k: u32 = 4
  func step(x: u32) -> u32 => x + k
  assert apply(step, 1) == 5
}`
    const module = parse(src).module!
    const result = typecheck(module, { source: src, includeTests: true })
    expect(result.errors).toEqual([])
    expect(result.instances.map((i) => [i.name, i.label])).toEqual([
      ['apply<__test1.step>', 'apply(f = test.step)'],
      ['apply<__test3.step>', 'apply(f = test "g1 > inner".step)'],
      ['apply<__test5.step>', 'apply(f = test "g2 > inner".step)'],
      ['apply<__test6.step>', 'apply(f = test "say \\"hi\\"".step)'],
    ])
    expect(hoverText(hover(src, module, result, src.lastIndexOf('step(x'))!)).toBe('func step: func(x: u32) -> u32 — nested in test "say \\"hi\\""; captures k')
  })

  // A function of a test that captures nothing is the test's too: it and
  // what is nested in it are shown under the test
  test('a test\'s plain function, and what is nested in it, are shown under the test', () => {
    const src = `func apply(comptime f: (u32) -> u32, x: u32) -> u32 => f(x)
test "one" {
  func twice(x: u32) -> u32 => x * 2
  func helper(x: u32) -> u32 {
    let y = x + 1
    func inner(z: u32) -> u32 => y + z
    return apply(twice, 1) + apply(inner, 0)
  }
  assert helper(1) == 4
}`
    const module = parse(src).module!
    const result = typecheck(module, { source: src, includeTests: true })
    expect(result.errors).toEqual([])
    expect(result.instances.map((i) => [i.name, i.label])).toEqual([
      ['apply<__test1.twice>', 'apply(f = test "one".twice)'],
      ['apply<__test1.helper.inner>', 'apply(f = test "one".helper.inner)'],
    ])
    expect(hoverText(hover(src, module, result, src.indexOf('inner(z'))!)).toBe('func inner: func(z: u32) -> u32 — nested in test "one".helper; captures y')
  })

  test('document symbols list it after its function, by its path', () => {
    const { module, result } = setup()
    expect(documentSymbols(source, module, result).map((s) => `${s.name}: ${s.type}`)).toEqual([
      'sort: generic func(comptime T: type, xs: []mut T, comptime before: (T, T) -> bool)',
      'by_distance: func(xs: []mut i32, center: i32) -> u32',
      'by_distance.closer: func(a: i32, b: i32) -> bool',
      'by_distance.plain: func(a: i32) -> i32',
    ])
  })

  test('meta: a symbol of its own, with its uses and its parameters', () => {
    const { module, result } = setup()
    const meta = buildMeta(module, source, { checkResult: result })
    const closer = meta.symbols.find((s) => s.name === 'closer')!
    expect(closer.kind).toBe('func')
    expect(closer.refs.length).toBe(1)
    expect(meta.symbols.some((s) => s.name === 'a' && s.kind === 'param')).toBe(true)
  })
})

// From the third review of the merge of #263
describe('nested functions: names a test takes, messages and the editor', () => {
  const checkWithTests = (source: string) => {
    const module = parse(source, { filePath: 'test.ents' }).module!
    return { module, result: typecheck(module, { source, includeTests: true }) }
  }
  const testErrorsOf = (source: string) => checkWithTests(source).result.errors.map((e) => e.message)

  // What only a test declares or imports is no function of the module's:
  // module code below the test, and a later test, are refused it as a
  // build without tests refuses it (12.4, 8.6)
  test('module code and a later test cannot give a name only a test declares or imports', () => {
    expect(testErrorsOf(`func apply(comptime k: () -> u32) -> u32 => k()
test "declares" {
  func tf() -> u32 => 2
  import "env" "hf" func hf() -> u32
  assert apply(tf) == 2
  if tf() == 3 { assert apply(hf) == 0 }
}
export func below() -> u32 => apply(tf)
export func below_host() -> u32 => apply(hf)
test "later" {
  assert apply(tf) == 2
}`)).toEqual([
      "argument 1 of 'apply' must be the name of a function: k is a comptime function parameter",
      "argument 1 of 'apply' must be the name of a function: k is a comptime function parameter",
      "argument 1 of 'apply' must be the name of a function: k is a comptime function parameter",
    ])
  })

  test('a source function only a test imports is not given in module code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'encantis-nested-'))
    try {
      await writeFile(join(dir, 'slib.ents'), 'export func g() -> u32 => 3')
      await writeFile(join(dir, 'main.ents'), `func apply(comptime k: () -> u32) -> u32 => k()
test "imports" {
  import "./slib.ents" ("g" func tri() -> u32)
  assert apply(tri) == 3
}
export func later() -> u32 => apply(tri)`)
      const path = join(dir, 'main.ents')
      const load = await loadModule(path, { includeTests: true })
      const checked = typecheckProgram(load.modules, path, { includeTests: true })
      expect(checked.errors.map((e) => e.message)).toEqual(["argument 1 of 'apply' must be the name of a function: k is a comptime function parameter"])
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  // lib's own test imports ./s and gives its function to lib's generic: the
  // instance is asked for by that test alone, which main's test build does
  // not build (12.4, 12.5)
  test('an importer\'s test build leaves out an instance only the imported module\'s tests ask for', async () => {
    const lib = `export func apply(comptime k: () -> u32) -> u32 => k()
export func one() -> u32 => 1
test "lib test imports s.x" {
  import "./s.ents" ("x" func sx() -> u32)
  assert apply(sx) == 7
}`
    const s = 'export func x() -> u32 => 7'
    const main = `import "./lib.ents" ("apply" func apply(comptime k: () -> u32) -> u32 "one" func one() -> u32)
export func m() -> u32 => apply(one)
test "main" { assert m() == 1 }`
    const { ran, failed, wat } = await runProgram({ 'main.ents': main, 'lib.ents': lib, 's.ents': s })
    expect({ ran, failed }).toEqual({ ran: ['main'], failed: [] })
    expect(wat.match(/\(func \$lib\$apply<[^ ]*/g)).toEqual(['(func $lib$apply<one>'])
    // lib's own test build has it
    const own = await runProgram({ 'main.ents': lib, 's.ents': s })
    expect(own).toMatchObject({ ran: ['lib test imports s.x'], failed: [] })
    expect(own.wat).toContain('(func $apply<x@s>')
  })

  // What a test build leaves out lays out no data, and what only its tests
  // lay out comes after the program's data, which keeps its addresses and
  // its end where the build has nothing more to lay out (9.0, 12.4)
  test('a test build lays out the data of what it builds, the program\'s first', async () => {
    const gen = `export func tag(comptime k: (u32) -> u32) -> []u8 {
  let s = "a literal of the instance, 40 bytes long"
  return s
}`
    const lib = `import "./gen.ents" ("tag" func tag(comptime k: (u32) -> u32) -> []u8)
export func dbl(x: u32) -> u32 => x * 2
export func one() -> u32 => 1
test "lib asks for tag<dbl> and tag<its own function>" {
  func tf(x: u32) -> u32 => x * 2
  assert tag(dbl).len == 40 && tag(tf).len == 40
  data blob = "lib test data, 20 b."
  assert blob.len == 20
}`
    const main = `import "./lib.ents" ("one" func one() -> u32 "dbl" func dbl(x: u32) -> u32)
import "./gen.ents" ("tag" func tag(comptime k: (u32) -> u32) -> []u8)
test "above the program's data" {
  data early = "a test's data, written first"
  assert early.len == 28 && where_mine() == 8
}
data mine = "abcd"
export func where_mine() -> u32 => mine as u32
export func data_end() -> u32 => sizeof data
test "lib's tests lay out nothing here" {
  assert one() == 1 && where_mine() == 8 && data_end() > 12
}
test "an instance only this test asks for comes after" {
  assert tag(dbl).len == 40 && where_mine() == 8
}`
    const { ran, failed, wat } = await runProgram({ 'main.ents': main, 'lib.ents': lib, 'gen.ents': gen })
    expect({ ran, failed }).toEqual({ ran: ["above the program's data", "lib's tests lay out nothing here", 'an instance only this test asks for comes after'], failed: [] })
    expect(wat).not.toContain('lib test data')
    expect(wat.match(/a literal of the instance/g)).toHaveLength(1)
    // Without that test the build lays out the program's data alone
    const plain = await runProgram({ 'main.ents': main.slice(0, main.indexOf('test "an instance')), 'lib.ents': lib, 'gen.ents': gen })
    expect(plain.wat).not.toContain('a literal of the instance')
  })

  // Each name of a match arm is its own declaration: the later clash with
  // any of them is told what that one could not take. The nested function
  // refused each name leaves it with the global, as if it were not there.
  test('a later clash is told the place of what each name of a refused match arm could not take', () => {
    expect(errorsOf(`global a: u32 = 0
global b: u32 = 0
global total: u32 = 0
export func h(x: u32) -> u32 {
  match x { a, b => { } }
  if true { func a() -> u32 => 1 }
  let a: u32 = 1
  if true { func b() -> u32 => 1 }
  let b: u32 = 1
  match x { 1, total => { } }
  if true { func total() -> u32 => 1 }
  let total: u32 = 1
  return 0
}`).filter((e) => e.includes('in this scope'))).toEqual([
      "'a' is already declared in this scope (first declared at 1:8)",
      "'b' is already declared in this scope (first declared at 2:8)",
      "'total' is already declared in this scope (first declared at 3:8)",
    ])
  })

  // The third declaration of a name is told the first place (3.3): where a
  // nested function was refused a global's, def's or data block's name, or
  // a match arm a global's, the place of what had the name
  test('a later clash is told the place of what a refused nested function or match arm could not take', () => {
    expect(testErrorsOf(`global total: u32 = 0
def k = 3
data bytes = [1:u8, 2]
func f(xs: []u32) -> u32 {
  if true { func total() -> u32 => 1 }
  let total: u32 = 1
  for total in 2 { }
  return 0
}
func g() -> u32 {
  if true { func k() -> u32 => 1 }
  let k: u32 = 1
  return 0
}
func h(xs: []u32) -> u32 {
  match xs.len { total => { } }
  if true { func total() -> u32 => 1 }
  let total: u32 = 1
  if true { func bytes() -> u32 => 1 }
  match xs.len { bytes => { } }
  return 0
}
test "t" {
  def d = 4
  let z: u32 = 1
  if true { func d() -> u32 => z }
  let d: u32 = 2
  assert z == 1
}`)).toEqual([
      // A refused nested function leaves the name with what had it: what is
      // declared after it is told what it is told without it
      "'total' is already declared: a nested function cannot reuse the name of a global (first declared at 1:8)",
      "'total' is already declared in this scope (first declared at 1:8)",
      "'total' is already declared: a loop variable cannot reuse the name of a global (first declared at 1:8)",
      "'k' is already declared: a nested function cannot reuse the name of a def (first declared at 2:5)",
      "'k' is already declared in this scope (first declared at 2:5)",
      "'total' is already declared: a match binding cannot reuse the name of a global (first declared at 1:8)",
      "'total' is already declared: a nested function cannot reuse the name of a global (first declared at 1:8)",
      "'total' is already declared in this scope (first declared at 1:8)",
      "'bytes' is already declared: a nested function cannot reuse the name of a data block (first declared at 3:6)",
      "'bytes' is already declared: a match binding cannot reuse the name of a data block (first declared at 3:6)",
      "'d' is already declared: a nested function cannot reuse the name of a def (first declared at 24:7)",
      "'d' is already declared in this scope (first declared at 24:7)",
    ])
  })

  // Refused for a def's name (#38), a parameter or a named result is what
  // the def is for a later declaration of the name, as a refused let is
  test('a later clash with a parameter refused a def\'s name is told the def\'s place', () => {
    expect(errorsOf(`def k = 3
func f(k: u32) -> u32 {
  if true { func k() -> u32 => 1 }
  for k in 3 { }
  let k: u32 = 4
  return 0
}
func g(x: u32) -> (k: u32) {
  for k in 3 { }
  k = 1
}
func b(x: u32) -> u32 {
  func c(k: u32) -> u32 {
    func d(k: u32) -> u32 => k
    return d(k)
  }
  return c(x)
}`)).toEqual([
      "'k' is already declared: a parameter cannot reuse the name of a def (first declared at 1:5)",
      "'k' is already declared: a named result cannot reuse the name of a def (first declared at 1:5)",
      "'k' is already declared: a nested function cannot reuse the name of a def (first declared at 1:5)",
      "'k' is already declared: a loop variable cannot reuse the name of a def (first declared at 1:5)",
      "'k' is already declared in this scope (first declared at 1:5)",
      "'k' is already declared: a loop variable cannot reuse the name of a def (first declared at 1:5)",
      "'k' is already declared: a parameter cannot reuse the name of a def (first declared at 1:5)",
      "'k' is already declared: a parameter cannot reuse the name of a def (first declared at 1:5)",
    ])
  })

  // A function without a name, or a generic one, is refused before its
  // parameters are read, in a generic's body as in a plain one
  test('in a generic\'s body a nameless or generic nested function gets no def-named parameter error', () => {
    const plain = `def k = 3
func f(x: u32) -> u32 {
  func(k: u32) -> u32 => k
  func pick(comptime T: type, k: T) -> T => k
  return x
}`
    const generic = `def k = 3
func g(comptime T: type, x: T) -> T {
  func(k: u32) -> u32 => k
  func pick(comptime U: type, k: U) -> U => k
  return x
}`
    expect(errorsOf(plain)).toEqual([
      'a function declared in a function body needs a name: func name(x: T) -> R => ...',
      'a generic function is declared at module level, not inside a function',
    ])
    expect(errorsOf(generic)).toEqual([])
  })

  test('a group\'s variable is told with the group named as the runner names it', () => {
    expect(testErrorsOf(`test "out" {
  test "in \\"x\\"" {
    let base: u32 = 1
    test "t" {
      assert base == 1
    }
    func top() -> u32 => base
  }
  test {
    let b2: u32 = 1
    test "u" {
      assert b2 == 1
    }
  }
}`)).toEqual([
      '\'base\' is a variable of the group "out > in \\"x\\"", whose statements are never run (12.3): a test nested in it cannot use it',
      '\'base\' is a variable of the group "out > in \\"x\\"", whose statements are never run (12.3): a function declared at its top cannot use it',
      '\'b2\' is a variable of a group without a name in "out", whose statements are never run (12.3): a test nested in it cannot use it',
    ])
  })

  // A test named with an empty string has a name, written as the string is
  // (the name is refused, 12.6, and what it declares is still named)
  test('a test with an empty name is named test ""', () => {
    const src = `func apply(comptime f: () -> u32) -> u32 => f()
test "" {
  let z: u32 = 1
  func plus() -> u32 => z
  assert apply(plus) == 1
}
test "" {
  let gv: u32 = 1
  test "in" { assert gv == 1 }
}`
    const { module, result } = checkWithTests(src)
    expect(result.errors.map((e) => e.message)).toEqual([
      "a test's name is empty: give it one",
      "a test's name is empty: give it one",
      '\'gv\' is a variable of the group "", whose statements are never run (12.3): a test nested in it cannot use it',
    ])
    expect(hover(src, module, result, src.indexOf('plus()'))?.nestedIn).toBe('test ""')
    expect(hover(src, module, result, src.indexOf('z\n'))?.capturedFrom).toBe('test ""')
  })

  // A function nested in a generic's body is nested in the instance, named
  // by its label as messages name it, not by its key
  test('hover names the instance a nested function is in by its label', () => {
    const src = `func gapply(comptime f: (u32) -> u32, x: u32) -> u32 {
  let v: u32 = x
  func gh(y: u32) -> u32 => f(y + v)
  return gh(x)
}
test "t" {
  let z: u32 = 1
  func plus(x: u32) -> u32 => x + z
  assert gapply(plus, 1) == 3
}`
    const { module, result } = checkWithTests(src)
    expect(result.errors).toEqual([])
    expect(hover(src, module, result, src.indexOf('gh(y'))).toMatchObject({ nestedIn: 'gapply(f = test "t".plus)', captures: 'v, z' })
  })

  // Hover names the function a captured variable is declared in as the
  // checker names it, and a test's name is written as an Encantis string is
  test('captured from names the test as nested in does, escaped as a string is', () => {
    const src = `func apply(comptime f: (u32) -> u32, x: u32) -> u32 => f(x)
test "say \\"hi\\"\\x01" {
  let z: u32 = 1
  func plus(x: u32) -> u32 => x + z
  func plain(x: u32) -> u32 {
    func inner(y: u32) -> u32 => y + x
    return inner(1)
  }
  assert apply(plus, 1) + apply(plain, 1) == 4
}
test "g" {
  test "inner > b" {
    let z: u32 = 2
    func plus(x: u32) -> u32 => x + z
    assert apply(plus, 1) == 3
  }
}
test {
  let z: u32 = 4
  func plus(x: u32) -> u32 => x + z
  assert apply(plus, 1) == 5
}`
    const { module, result } = checkWithTests(src)
    expect(result.errors).toEqual([])
    const at = (text: string, nth = 0) => {
      let i = -1
      for (let k = 0; k <= nth; k++) i = src.indexOf(text, i + 1)
      return i
    }
    expect(hoverText(hover(src, module, result, at('z\n', 0))!)).toBe('local z: u32 — captured from test "say \\"hi\\"\\u{1}"')
    expect(hoverText(hover(src, module, result, at('y + x') + 4)!)).toBe('local x: u32 — captured from test "say \\"hi\\"\\u{1}".plain')
    expect(hoverText(hover(src, module, result, at('z\n', 1))!)).toBe('local z: u32 — captured from test "g > inner > b"')
    expect(hoverText(hover(src, module, result, at('z\n', 2))!)).toBe('local z: u32 — captured from test')
    expect(hoverText(hover(src, module, result, at('plus(x', 1))!)).toBe('func plus: func(x: u32) -> u32 — nested in test "g > inner > b"; captures z')
  })

  test('document symbols list the nested functions of a test, in its blocks too', () => {
    const src = `test "t" {
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
}`
    const { module, result } = checkWithTests(src)
    expect(documentSymbols(src, module, result).map((s) => `${s.name}: ${s.type}`)).toEqual([
      'test "t".plus: func(x: u32) -> u32',
      'test "t".deep: func() -> u32',
      'test "t".step: func() -> u32',
    ])
  })

  // The module's function, given after a test took its name over, is a use
  // of the module's function: renamed with it, defined at it
  test('the editor finds the module\'s function where a comptime argument gives it after a test took its name', () => {
    const src = `func apply(comptime k: () -> u32) -> u32 => k()
func f() -> u32 => 1
export func above() -> u32 => apply(f)
test "takes over f" {
  func f() -> u32 => 2
  assert apply(f) == 2
}
export func below() -> u32 => apply(f)
test "later" {
  assert apply(f) == 1
}`
    const { module, result } = checkWithTests(src)
    expect(result.errors).toEqual([])
    const own = src.indexOf('f() -> u32 => 1')
    const test = src.indexOf('f() -> u32 => 2')
    const uses = ['above() -> u32 => apply(', 'assert apply(', 'below() -> u32 => apply(', 'assert apply(f) == 1'].map((t, i) => src.indexOf(t) + (i === 3 ? 'assert apply('.length : t.length))
    expect(rename(src, module, result, own)?.locations.map((l) => l.offset)).toEqual([own, uses[0], uses[2], uses[3]])
    expect(rename(src, module, result, test)?.locations.map((l) => l.offset)).toEqual([test, uses[1]])
    expect(gotoDefinition(src, module, result, uses[2])?.location.offset).toBe(src.indexOf('func f() -> u32 => 1'))
    expect(gotoDefinition(src, module, result, uses[1])?.location.offset).toBe(src.indexOf('func f() -> u32 => 2'))
    const meta = buildMeta(module, src, { checkResult: result })
    expect(meta.symbols.filter((s) => s.name === 'f').map((s) => s.refs.length)).toEqual([3, 1])
  })

  // Hover there shows the module's function, also at its declaration where
  // the test's function of the name has other parameters
  test('hover shows the module\'s function where a comptime argument gives it after a test took its name', () => {
    const src = `func apply(comptime k: () -> u32) -> u32 => k()
func f() -> u32 => 1
func outer(comptime T: type) -> u32 => apply(f)
test "takes over f" {
  func f(x: u64) -> u64 => x
  assert f(5) == 5
}
export func below() -> u32 => apply(f) + outer(u32)
test "later" {
  assert apply(f) == 1
}`
    const { module, result } = checkWithTests(src)
    expect(result.errors).toEqual([])
    const at = (text: string, skip: number) => src.indexOf(text) + skip
    const shown = (offset: number) => {
      const h = hover(src, module, result, offset)
      return h && `${h.kind} ${h.type}`
    }
    expect(shown(at('f() -> u32 => 1', 0))).toBe('func func() -> u32')
    expect(shown(at('apply(f)\ntest', 6))).toBe('func func() -> u32')
    expect(shown(at('apply(f) + outer', 6))).toBe('func func() -> u32')
    expect(shown(at('apply(f) == 1', 6))).toBe('func func() -> u32')
    expect(shown(at('f(x: u64)', 0))).toBe('func func(x: u64) -> u64')
  })

  // A comptime argument in a generic's body is module code: a use of the
  // module's function, and none of the test's that took the name
  test('a comptime argument in a generic\'s body is a use of the module\'s function only', () => {
    const src = `func apply(comptime f: () -> u32) -> u32 => f()
func shared() -> u32 => 1
test "takes" {
  func shared() -> u32 => 2
  assert apply(shared) == 2
}
func gk(comptime T: type, x: T) -> u32 => apply(shared)
func never(comptime T: type) -> u32 => apply(shared)
export func m3(a: u32) -> u32 => gk(a) + apply(shared)`
    const { module, result } = checkWithTests(src)
    expect(result.errors).toEqual([])
    const own = src.indexOf('shared() -> u32 => 1')
    const test = src.indexOf('shared() -> u32 => 2')
    const inTest = src.indexOf('apply(shared) == 2') + 'apply('.length
    const generic = src.indexOf('x: T) -> u32 => apply(') + 'x: T) -> u32 => apply('.length
    const uninstantiated = src.indexOf('T: type) -> u32 => apply(') + 'T: type) -> u32 => apply('.length
    const below = src.indexOf('gk(a) + apply(') + 'gk(a) + apply('.length
    expect(rename(src, module, result, test)?.locations.map((l) => l.offset)).toEqual([test, inTest])
    expect(rename(src, module, result, own)?.locations.map((l) => l.offset)).toEqual([own, generic, uninstantiated, below])
  })

  // A function or an import declared in a test cannot take the name of an
  // import of the module (12.4), said with where the import's name is, also
  // for the same host function again, whatever its parameters
  test('a test\'s function or import cannot take the name of an import of the module', () => {
    expect(testErrorsOf(`import "env" "e" func e() -> u32
import "env" "f" func f() -> u32
test "function" {
  func e() -> u32 => 9
}
test "another host function" {
  import "env" "e2" func e() -> u32
}
test "the same import again" {
  import "env" "f" func f() -> u32
  assert f() == f()
}
test "the same import again, another signature" {
  import "env" "f" func f() -> u64
}`)).toEqual([
      "'e' is already declared: a function declared in a test cannot reuse the name of an import (first declared at 1:23)",
      "'e' is already declared: an import in a test cannot reuse the name of an import of the module (first declared at 1:23)",
      "'f' is already declared: an import in a test cannot reuse the name of an import of the module (first declared at 2:23)",
      "'f' is already declared: an import in a test cannot reuse the name of an import of the module (first declared at 2:23)",
    ])
  })

  // A name several functions of the module share, imports among them, is
  // refused a test's function or import as that name, wherever it is
  test('a test\'s function or import of a name several imports share is told so', () => {
    const shared = "'log' is the name of several functions of the module: a function declared in a test cannot take it over"
    expect(testErrorsOf(`import "env" "log32" func log(x: u32)
import "env" "log64" func log(x: u64)
test "a function" {
  func log(x: u32) { }
}
test "the first import again" {
  import "env" "log32" func log(x: u32)
}
test "the second import again" {
  import "env" "log64" func log(x: u64)
}
test "another" {
  import "env" "log8" func log(x: u8)
}`)).toEqual([shared, shared, shared, shared])
  })

  // A function of another source module imported again under its name is
  // that one again (3.4), in a test too
  test('a test imports the module\'s function of another source module again', async () => {
    const { ran, failed } = await runProgram({
      'slib.ents': 'export func g() -> u32 => 3\nexport global gl: u32 = 7',
      'main.ents': `import "./slib.ents" ("g" func g() -> u32 "gl" global sg: u32)
export func m() -> u32 => g()
test "again" {
  import "./slib.ents" ("g" func g() -> u32 "gl" global sg: u32)
  assert g() == 3 && m() == 3 && sg == 7
}`,
    })
    expect({ ran, failed }).toEqual({ ran: ['again'], failed: [] })
  })

  // The test runner lists every named test without nested tests
  test('a named test that holds only declarations is built, and passes', async () => {
    expect(await runTestsOfSource(`test "only a declaration" {
  func helper() -> u32 => 1
}
test "empty" { }
test "with a statement" {
  assert 1 == 1
}`)).toEqual({ ran: ['only a declaration', 'empty', 'with a statement'], failed: [] })
  })
})

// Builds the program of `main.ents` among `files` without its tests, as
// `encantis wasm` does, and gives its WAT and, where it imports nothing from
// the host, the exports of an instance of it
// (`env`: the host's functions, where it imports some)
async function buildPlain(files: Record<string, string>, env?: Record<string, unknown>): Promise<{ wat: string; exports?: Record<string, () => number> }> {
  const dir = await mkdtemp(join(tmpdir(), 'encantis-nested-'))
  try {
    for (const [name, source] of Object.entries(files)) {
      await mkdir(dirname(join(dir, name)), { recursive: true })
      await writeFile(join(dir, name), source)
    }
    const path = join(dir, 'main.ents')
    const load = await loadModule(path, { includeTests: false })
    if (load.errors.length > 0) throw new Error(load.errors.map((e) => e.message).join('\n'))
    const checked = typecheckProgram(load.modules, path, { includeTests: false })
    if (checked.errors.length > 0) throw new Error(checked.errors.map((e) => e.message).join('\n'))
    const wat = programToWat(load.modules, checked.results, path)
    const bytes = await wasmOfWat(wat)
    if (wat.includes('(import "env"') && !env) return { wat }
    const instance = await WebAssembly.instantiate(await WebAssembly.compile(bytes), env ? { env } : {})
    return { wat, exports: instance.exports as Record<string, () => number> }
  } finally {
    await rm(dir, { recursive: true })
  }
}

describe('nested functions: test builds, names and the editor (fifth review)', () => {
  // A test's import of another module is part of the program only when the
  // tests are built (7.1): the modules are laid out in the order the build
  // without tests has them, and one that only tests import after all of the
  // program's data, which keeps its addresses (9.0)
  test('a test\'s imports of other modules leave the program\'s data at its addresses', async () => {
    const lib = 'data libdata = "lib"\nexport func where_lib() -> u32 => libdata as u32'
    const a = 'data adata = "a\'s data"\nexport func addr_a() -> u32 => adata as u32'
    const b = 'data bdata = "b\'s data, longer"\nexport func addr_b() -> u32 => bdata as u32'
    // A module only the entry's test imports
    const onlyTests = {
      'lib.ents': lib,
      'w.ents': 'data wdata = "only the tests import this module"\nexport func wlen() -> u32 => wdata.len',
      'main.ents': `import "./lib" "where_lib" func where_lib() -> u32
data mine = "abcd"
export func where_mine() -> u32 => mine as u32
test "a test that imports a module of its own" {
  import "./w" "wlen" func wlen() -> u32
  assert wlen() == 33 && where_lib() == 8 && where_mine() == 11
}`,
    }
    expect((await buildPlain(onlyTests)).exports?.where_mine()).toBe(11)
    expect(await runProgram(onlyTests)).toMatchObject({ failed: [] })
    // A test above the module's imports, which imports one of them
    const both = {
      'a.ents': a,
      'b.ents': b,
      'main.ents': `test "a test above the imports, which imports b" {
  import "./b" "addr_b" func addr_b() -> u32
  assert addr_b() == 16 && addr_a() == 8
}
import "./a" "addr_a" func addr_a() -> u32
import "./b" "addr_b" func addr_b() -> u32
export func where_a() -> u32 => addr_a()
export func where_b() -> u32 => addr_b()`,
    }
    const plain = (await buildPlain(both)).exports
    expect([plain?.where_a(), plain?.where_b()]).toEqual([8, 16])
    expect(await runProgram(both)).toMatchObject({ failed: [] })
    // An imported module's test, checked and not built, imports a module the
    // program imports
    const imported = {
      'a.ents': a,
      'b.ents': b,
      'lib.ents': `${lib}
test "lib's test imports b, which the program imports too" {
  import "./b" "addr_b" func addr_b() -> u32
  assert addr_b() > 0
}`,
      'main.ents': `import "./lib" "where_lib" func where_lib() -> u32
import "./a" "addr_a" func addr_a() -> u32
import "./b" "addr_b" func addr_b() -> u32
export func where() -> u32 => where_lib() * 10000 + addr_a() * 100 + addr_b()
test "the program's data keeps its addresses" {
  assert where_lib() == 8 && addr_a() == 11 && addr_b() == 19
}`,
    }
    expect((await buildPlain(imported)).exports?.where()).toBe(81119)
    expect(await runProgram(imported)).toMatchObject({ failed: [] })
  })

  // An instance that looks a function up at its site is laid out by its
  // arguments and its site, whichever site asked for it first: a test that
  // asks first moves no instance of the program's
  test('an instance a test asks for first leaves the program\'s instances where they are', async () => {
    const site = (n: number) => `import "./gen" "site" func site(comptime T: type, x: T) -> *mut u32
func tick(x: u32) -> u32 => x + ${n}`
    const files = {
      'gen.ents': `export func site(comptime T: type, x: T) -> *mut u32 {
  let c = &mut 0:u32
  c.* = tick(x)
  return c
}`,
      'x.ents': `${site(1000)}
export func one() -> u32 => 1
test "x's test asks for site(u32) with x as the site" {
  assert site(1:u32).* == 1001
}`,
      'zeta.ents': `${site(1)}\nexport func z() -> u32 => site(1:u32) as u32`,
      'alpha.ents': `${site(2)}\nexport func a() -> u32 => site(2:u32) as u32`,
      'main.ents': `import "./x" "one" func one() -> u32
import "./zeta" "z" func z() -> u32
import "./alpha" "a" func a() -> u32
export func where_z() -> u32 => z()
export func where_a() -> u32 => a()
test "the program's cells keep their addresses" {
  assert one() == 1 && where_z() == 12 && where_a() == 8
}`,
    }
    const plain = (await buildPlain(files)).exports
    expect([plain?.where_z(), plain?.where_a()]).toEqual([12, 8])
    expect(await runProgram(files)).toMatchObject({ failed: [] })
  })

  // A host import without a local name that is an identifier cannot be
  // called (7.1), and its name can be any text: its WAT name is one no other
  // declaration has
  test('an import without a local name that cannot be called is a WAT name of its own', async () => {
    const console = `import "env" "console.log" func(msg: []u8)
export func console(msg: []u8) -> u32 {
  func log() -> u32 => msg.len
  return log()
}`
    // In a module another imports, and in the entry
    const lib = await buildPlain({ 'lib.ents': console, 'main.ents': 'import "./lib" "console" func console(msg: []u8) -> u32\nexport memory\nexport func m() -> u32 => console("hello")' })
    expect(lib.wat).toContain('(import "env" "console.log" (func $lib$%console.log ')
    expect(lib.wat).toContain('(func $lib$console.log ')
    const entry = await buildPlain({ 'main.ents': `${console}\nexport memory` })
    expect(entry.wat).toContain('(func $%console.log ')
    // A space, and the names of a test's functions
    expect((await buildPlain({ 'main.ents': 'import "env" "two words" func(x: u32)\nexport func m() -> u32 => 1' })).wat).toContain('$%two%20words')
    expect(await runProgram({
      'main.ents': `import "env" "__test1" func()
import "env" "__test2.helper" func()
export func m() -> u32 => 1
test "one" { assert m() == 1 }
test "two" {
  import "env" "console.log" func(msg: []u8)
  func helper() -> u32 => 2
  func console() -> u32 {
    func log() -> u32 => 3
    return log()
  }
  assert helper() + console() == 5
}`,
    })).toMatchObject({ ran: ['one', 'two'], failed: [] })
  })

  // Each function is emitted with the type of its own declaration, not with
  // that of the last one of its name (12.4: another test can declare its own
  // of the name)
  test('two tests and the module each declare a function of one name, with other parameters', async () => {
    expect(await runProgram({
      'main.ents': `type P = (x: u32, y: u32)
export func f(s: []u8) -> u32 => s.len
export func m() -> u32 => f("abc")
test "a" {
  func f(p: P) -> u32 => p.x + p.y
  let q: P = (x: 1, y: 2)
  assert f(q) == 3 && m() == 3
}
test "b" {
  func f(x: u32) -> (u32, u32) => (x, x + 1)
  let (a, b) = f(4)
  assert a + b == 9 && m() == 3
}`,
    })).toMatchObject({ ran: ['a', 'b'], failed: [] })
  })

  // One file imported by two spellings of its path is the one file: its
  // function imported again under its name is that one again (3.4)
  test('a module imports one function by two spellings of the file\'s path', async () => {
    const { exports } = await buildPlain({
      'lib.ents': 'export func dbl(x: u32) -> u32 => x * 2',
      'main.ents': `import "./lib" "dbl" func dbl(x: u32) -> u32
import "./lib.ents" "dbl" func dbl(x: u32) -> u32
export func m() -> u32 => dbl(1)`,
    })
    expect(exports?.m()).toBe(2)
  })

  // A test's function or import that takes the name of a global the module
  // imports is told where the import's local name is (12.4, 3.3), as for an
  // imported function
  test('a test\'s function or import named like an imported global is told the import\'s place', async () => {
    expect(errorsOf(`import "env" "g" global hg: u32
test "t" {
  func hg() -> u32 => 1
  import "env" "g2" global hg: u32
  assert 1 == 1
}`)).toEqual([
      "'hg' is already declared: a function declared in a test cannot reuse the name of an import (first declared at 1:25)",
      "'hg' is already declared: an import in a test cannot reuse the name of an import of the module (first declared at 1:25)",
    ])
  })

  // A field written alone in a match pattern binds its name where it stands
  test('a field written alone in a match pattern is defined where its name is', () => {
    expect(errorsOf(`export func f(x: u32) -> u32 {
  match x {
    0 => { }
    Pt(_, k:) => { }
    _ => { }
  }
  if true { func k() -> u32 => 1 }
  return 0
}`)).toEqual(["'k' is already declared in 'f': a nested function's name is its own in the whole function that declares it (first declared at 4:11)"])
  })

  // A refused nested function leaves the name with what had it: a later
  // declaration is told the place of the name's first declaration, with the
  // message of that one's kind, also after a match binding of the name
  test('a let after a refused nested function is told what it is told without it', () => {
    expect(errorsOf(`func tf() -> u32 => 1
global gl: u32 = 0
export func f(x: u32) -> u32 {
  match x {
    0 => { }
    tf => { }
    _ => { }
  }
  if true { func tf() -> u32 => 2 }
  let tf: u32 = 1
  return 0
}
export func k(x: u32) -> u32 {
  if true { func gl() -> u32 => 2 }
  for gl in 2 { }
  let gl: u32 = 1
  return 0
}`)).toEqual([
      "'tf' is already declared: a nested function cannot reuse the name of a function of the module (first declared at 1:6)",
      "'tf' is already declared in this scope (first declared at 1:6)",
      "'gl' is already declared: a nested function cannot reuse the name of a global (first declared at 2:8)",
      "'gl' is already declared: a loop variable cannot reuse the name of a global (first declared at 2:8)",
      "'gl' is already declared in this scope (first declared at 2:8)",
    ])
  })

  // A test's import from another module is an import, and a group's function
  // refused the name of its import leaves the name with the import
  test('a capturing function named like its group\'s import is told the import', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'encantis-nested-'))
    try {
      await writeFile(join(dir, 'lib.ents'), 'export func dbl(x: u32) -> u32 => x * 2')
      const source = `test "grp" {
  import "./lib.ents" "dbl" func dbl(x: u32) -> u32
  func dbl(x: u32) -> u32 => x
  test "inner" {
    let v: u32 = 1
    func dbl(x: u32) -> u32 => x + v
    assert v == 1
  }
}
test "grp2" {
  import "./lib.ents" "dbl" func dbl(x: u32) -> u32
  test "inner" {
    let v: u32 = 1
    func dbl(x: u32) -> u32 => x + v
    assert v == 1
  }
}`
      const path = join(dir, 'main.ents')
      await writeFile(path, source)
      const load = await loadModule(path, { includeTests: true })
      expect(typecheckProgram(load.modules, path, { includeTests: true }).errors.map((e) => e.message)).toEqual([
        "'dbl' is already declared in this test",
        "'dbl' is already declared: a function that uses its test's variables cannot reuse the name of an import (first declared at 2:34)",
        "'dbl' is already declared: a function that uses its test's variables cannot reuse the name of an import (first declared at 11:34)",
      ])
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  // The editor at a name that is none where it is used, a function only a
  // test declares given outside the test (12.4), finds nothing
  test('hover, definition and references find nothing at a function only a test declares, given outside it', () => {
    const source = `func apply(comptime k: () -> u32) -> u32 => k()
test "declares tf" {
  func tf() -> u32 => 2
  assert apply(tf) == 2
}
export func below() -> u32 => apply(tf)
func gen(comptime T: type) -> u32 => apply(tf)
`
    const parsed = parse(source, { filePath: 'test.ents' })
    const result = typecheck(parsed.module!, { source })
    for (const at of [source.indexOf('apply(tf)\n') + 6, source.lastIndexOf('apply(tf)') + 6]) {
      expect(hover(source, parsed.module!, result, at)).toBeNull()
      expect(gotoDefinition(source, parsed.module!, result, at)).toBeNull()
      expect(findReferences(source, parsed.module!, result, at)).toBeNull()
      expect(rename(source, parsed.module!, result, at)).toBeNull()
    }
    // In the test it is the test's
    expect(hover(source, parsed.module!, result, source.indexOf('apply(tf)') + 6)?.name).toBe('tf')
  })

  // A test's data or def is its own: module code after the test uses the
  // module's, and the editor finds the module's there
  test('references of the module\'s data are those of module code after a test declares its own', () => {
    const source = `data buf = [1:u8, 2, 3]
test "takes" {
  data buf = [9:u16, 9]
  def k = 5
  assert buf[1] == 9 && k == 5
}
export func below() -> u32 => buf[2] as u32
`
    const parsed = parse(source, { filePath: 'test.ents' })
    const result = typecheck(parsed.module!, { source })
    const lines = (r: ReturnType<typeof findReferences>) => r?.references.map((l) => source.slice(0, l.offset).split('\n').length)
    expect(lines(findReferences(source, parsed.module!, result, source.indexOf('buf ')))).toEqual([7])
    expect(lines(findReferences(source, parsed.module!, result, source.indexOf('buf = [9')))).toEqual([5])
    expect(hover(source, parsed.module!, result, source.indexOf('buf[1]'))?.type).toBe('*[2]u16')
    expect(hover(source, parsed.module!, result, source.indexOf('k == 5'))?.value).toBe('5')
    expect(hover(source, parsed.module!, result, source.indexOf('buf[2]'))?.type).toBe('*[3]u8')
  })

  // A keyword is no name: the first keyword of a declaration, where the
  // checker records it, is not the name declared after it
  test('hover, definition and rename find nothing at a declaration\'s keyword', () => {
    const source = `export inline func helper(x: u32) -> u32 => x + 1
test "t" {
  func helper(x: u32) -> u32 => x + 100
  assert helper(1) == 101
}
`
    const parsed = parse(source, { filePath: 'test.ents' })
    const result = typecheck(parsed.module!, { source })
    for (const word of ['export', 'inline', 'func']) {
      const at = source.indexOf(word)
      expect(hover(source, parsed.module!, result, at)).toBeNull()
      expect(gotoDefinition(source, parsed.module!, result, at)).toBeNull()
      expect(rename(source, parsed.module!, result, at)).toBeNull()
    }
    expect(hover(source, parsed.module!, result, source.indexOf('helper'))?.name).toBe('helper')
  })

  // A label is cut between characters and outside a string's escapes
  test('a long label is cut between characters', () => {
    const name = `${'x'.repeat(46)}\u{1F600}\u{1F600}\u{1F600}\u{1F600}`
    const source = `func gapply(comptime f: (u32) -> u32, x: u32) -> u32 {
  func gh(y: u32) -> u32 => f(y)
  return gh(x)
}
test "${name}" {
  let z: u32 = 1
  func plus(x: u32) -> u32 => x + z
  assert gapply(plus, 1) == 2
}
test "${'y'.repeat(44)}\\u{1}\\u{1}\\u{1}" {
  let z: u32 = 1
  func plus2(x: u32) -> u32 => x + z
  assert gapply(plus2, 1) == 2
}`
    const parsed = parse(source, { filePath: 'test.ents' })
    const result = typecheck(parsed.module!, { source })
    const labels = result.instances.map((i) => i.label)
    expect(labels).toEqual([
      `gapply(f = test "${'x'.repeat(46)}\u{1F600}\u{1F600}...)`,
      // Not \u{1}\u, which cut 57 characters from the start
      `gapply(f = test "${'y'.repeat(44)}\\u{1}...)`,
    ])
    expect(labels.every((label) => label.isWellFormed())).toBe(true)
  })

  // At a nested function in a generic's body: nested in the generic, and
  // what it captures in each instance
  test('hover at a nested function of a generic names what it captures in each instance', () => {
    const source = `func gapply(comptime f: (u32) -> u32, x: u32) -> u32 {
  let v: u32 = x
  func gh(y: u32) -> u32 => f(y + v)
  return gh(x)
}
func modf(x: u32) -> u32 => x + 1
export func usemod(n: u32) -> u32 {
  func addn(x: u32) -> u32 => x + n
  return gapply(addn, 1) + gapply(modf, 2)
}
`
    const parsed = parse(source, { filePath: 'test.ents' })
    const result = typecheck(parsed.module!, { source })
    expect(hoverText(hover(source, parsed.module!, result, source.indexOf('gh(y'))!)).toBe(
      'func gh: func(y: u32) -> u32 — nested in gapply; in gapply(f = usemod.addn): captures v, n; in gapply(f = modf): captures v',
    )
  })

  // A function of another module given for a comptime parameter is named by
  // its name there and its file, as the instance's label names it
  test('hover names a function of another module given to a generic by its name and file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'encantis-nested-'))
    try {
      await writeFile(join(dir, 'lib.ents'), 'export func g(x: u32) -> u32 => x + 1')
      const source = `import "./lib.ents" ("g" func mg(x: u32) -> u32)
func gapply(comptime f: (u32) -> u32, x: u32) -> u32 => f(x)
export func m() -> u32 => gapply(mg, 1)
`
      const path = join(dir, 'main.ents')
      await writeFile(path, source)
      const load = await loadModule(path, { includeTests: true })
      const result = typecheckProgram(load.modules, path, { includeTests: true }).results.get(path)!
      const module = load.modules.get(path)!.module
      expect(hover(source, module, result, source.indexOf('f(x)'))?.instances).toEqual([{ in: ['gapply(f = g (lib.ents))'], type: 'g (lib.ents)(x: u32) -> u32' }])
    } finally {
      await rm(dir, { recursive: true })
    }
  })
})

describe('nested functions: test builds, names and the editor (sixth review)', () => {
  // An instance that looks a function up at its site, shared by several
  // modules, is laid out by the first module of the program that asks for
  // it, whoever asks first in the test build: an imported module's test, or
  // a module a test above the imports checks first (8.8, 9.0)
  test('an instance several modules share keeps its place, whoever asks for it first', async () => {
    const gen = `export func site(comptime T: type, x: T) -> *mut u32 {
  let c = &mut 0:u32
  c.* = tick(x)
  return c
}`
    const shares = `import "./gen" "site" func site(comptime T: type, x: T) -> *mut u32
import "./t" "tick" func tick(x: u32) -> u32`
    const files = {
      'gen.ents': gen,
      't.ents': 'export func tick(x: u32) -> u32 => x + 1',
      'x.ents': `${shares}
export func one() -> u32 => 1
test "x's test asks for site(u32) first, with t's tick, as a does" {
  assert site(1:u32).* == 2
}`,
      'a.ents': `${shares}\nexport func pa() -> u32 => site(1:u32) as u32`,
      'c.ents': `import "./gen" "site" func site(comptime T: type, x: T) -> *mut u32
func tick(x: u32) -> u32 => x + 100
export func pc() -> u32 => site(1:u32) as u32`,
      'main.ents': `import "./x" "one" func one() -> u32
import "./a" "pa" func pa() -> u32
import "./c" "pc" func pc() -> u32
export func addr_a() -> u32 => pa()
export func addr_c() -> u32 => pc()
test "the program's cells keep their addresses" {
  assert one() == 1 && addr_a() == 8 && addr_c() == 12
}`,
    }
    const plain = (await buildPlain(files)).exports
    expect([plain?.addr_a(), plain?.addr_c()]).toEqual([8, 12])
    expect(await runProgram(files)).toMatchObject({ failed: [] })
    // A test above the imports imports zz, which shares m's instance
    const above = {
      'gen.ents': gen,
      't.ents': 'export func tick(x: u32) -> u32 => x + 1',
      'm.ents': `${shares}\nexport func p() -> u32 => site(1:u32) as u32`,
      'zz.ents': `${shares}\nexport func p() -> u32 => site(1:u32) as u32`,
      'n.ents': `import "./gen" "site" func site(comptime T: type, x: T) -> *mut u32
func tick(x: u32) -> u32 => x + 100
export func p() -> u32 => site(1:u32) as u32`,
      'main.ents': `test "a test above the imports imports zz" {
  import "./zz" "p" func pzz() -> u32
  assert pzz() > 0
}
import "./m" "p" func pm() -> u32
import "./n" "p" func pn() -> u32
import "./zz" "p" func pzz() -> u32
export func addr_m() -> u32 => pm()
export func addr_n() -> u32 => pn()
test "the program's cells keep their addresses" {
  assert addr_m() == 8 && addr_n() == 12 && pzz() == 8
}`,
    }
    const plainAbove = (await buildPlain(above)).exports
    expect([plainAbove?.addr_m(), plainAbove?.addr_n()]).toEqual([8, 12])
    expect(await runProgram(above)).toMatchObject({ failed: [] })
  })

  // An instance of the program's generic that only a module only tests
  // import asks for is laid out after the program's data, as that module's
  // own data is (9.0)
  test('an instance only a module that tests import asks for comes after the program\'s data', async () => {
    const files = {
      'gen.ents': 'export func cell(comptime T: type) -> *mut u32 => &mut 0:u32',
      'only.ents': `import "./gen" "cell" func cell(comptime T: type) -> *mut u32
export func ocell() -> u32 => cell(u64) as u32`,
      'main.ents': `import "./gen" "cell" func cell(comptime T: type) -> *mut u32
data mine = "main's data"
export func addr_mine() -> u32 => mine as u32
export func addr_cell() -> u32 => cell(u8) as u32
test "the program's data keeps its addresses" {
  import "./only" "ocell" func ocell() -> u32
  assert ocell() == 23 && addr_cell() == 8 && addr_mine() == 12
}`,
    }
    const plain = (await buildPlain(files)).exports
    expect([plain?.addr_cell(), plain?.addr_mine()]).toEqual([8, 12])
    expect(await runProgram(files)).toMatchObject({ failed: [] })
  })

  // Files of one name are numbered in the order the program has them, a
  // test's import of the second changing nothing: the instances named after
  // them keep their places (9.0)
  test('two files of one name keep their tags when a test imports the second first', async () => {
    const files = {
      'gen.ents': `export func apply(comptime f: () -> u32) -> *mut u32 {
  let c = &mut 0:u32
  c.* = f()
  return c
}`,
      'x/s.ents': 'export func inc() -> u32 => 100',
      'y/s.ents': 'export func inc() -> u32 => 200',
      'main.ents': `test "a test above the imports imports y/s" {
  import "./y/s" "inc" func yinc() -> u32
  assert yinc() == 200
}
import "./gen" "apply" func apply(comptime f: () -> u32) -> *mut u32
import "./x/s" "inc" func xinc() -> u32
import "./y/s" "inc" func yinc() -> u32
export func addr_x() -> u32 => apply(xinc) as u32
export func addr_y() -> u32 => apply(yinc) as u32
test "the program's cells keep their addresses" {
  assert addr_x() == 8 && addr_y() == 12
}`,
    }
    const built = await buildPlain(files)
    expect([built.exports?.addr_x(), built.exports?.addr_y()]).toEqual([8, 12])
    expect(built.wat).toContain('$gen$apply<inc@s>')
    expect(built.wat).toContain('$gen$apply<inc@s~2>')
    expect(await runProgram(files)).toMatchObject({ failed: [] })
  })

  // An import that cannot be called (7.1) is no name a call or an instance
  // meets: one named like an instance, or like a nested function's path or
  // a test's nested function (console.log, __test1.f), from the host or
  // from another source module
  test('an import that cannot be called takes no instance\'s or function\'s name', async () => {
    const instance = await buildPlain({
      'main.ents': `import "env" "apply<inc>" func(x: u64) -> u32
func apply(comptime f: () -> u32, x: u32) -> u32 => f() + x
func inc() -> u32 => 1
export func m() -> u32 => apply(inc, 5)`,
    }, { 'apply<inc>': () => 999 })
    expect(instance.wat).toContain('(import "env" "apply<inc>" (func $%apply<inc> ')
    expect(instance.exports?.m()).toBe(6)
    const files = {
      'lib.ents': 'export "console.log" func shout(x: u32) -> u32 => x * 1000\nexport "__test1.f" func tf(x: u32) -> u32 => x * 2000',
      'main.ents': `import "./lib" ("console.log" func(x: u32) -> u32
  "__test1.f" func(x: u32) -> u32)
export func console(x: u32) -> u32 {
  func log(y: u32) -> u32 => y + 1
  return log(x)
}
test "t" {
  let k: u32 = 1
  func f(x: u32) -> u32 => x + k
  assert f(5) == 6 && console(5) == 6
}`,
    }
    expect((await buildPlain(files)).exports?.console(5)).toBe(6)
    expect(await runProgram(files)).toMatchObject({ ran: ['t'], failed: [] })
  })

  // A function a test imports keeps its own signature, and a call is
  // checked as the function it calls gives back: neither is the last of its
  // name (12.4)
  test('a test\'s import keeps its own signature, and module code\'s call its own function', async () => {
    expect(await runProgram({
      'main.ents': `global no: bool = false
test "t1 imports f" {
  import "env" "f" func f(x: u64) -> u64
  if no { assert f(1:u64) == 2:u64 }
}
test "t2 declares f" {
  func f(x: i32) -> i32 => x - 1
  assert f(5:i32) == 4:i32
}`,
    })).toMatchObject({ ran: ['t1 imports f', 't2 declares f'], failed: [] })
    expect(await runProgram({
      'main.ents': `type Canvas = host
export func f() -> u32 => 1
export func callf() -> u32 => f()
test "t" {
  import "env" "f" func f() -> Canvas
  assert callf() == 1
}`,
    })).toMatchObject({ ran: ['t'], failed: [] })
  })

  // An import refused as a second of its test's names is the name all the
  // same, and a later declaration of the name is told the first, as after a
  // function refused so (3.3: a third declaration is told the first)
  test('a later clash after an import refused as a test\'s second name is told the first', () => {
    expect(errorsOf(`export func f() -> u32 => 1
test "group" {
  func ee() -> u32 => 3
  import "env" "ee" func ee() -> u32
  import "./lib" "dbl" func dd(x: u32) -> u32
  import "./lib" "g" global dd: u32
  test "inner" {
    let v: u32 = 1
    func ee() -> u32 => v
    func dd() -> u32 => v
    assert true
  }
}
test "same test" {
  func e2() -> u32 => 3
  import "env" "e2" func e2() -> u32
  let e2: u32 = 1
  assert true
}`)).toEqual([
      "'ee' is already declared in this test",
      "'dd' is already declared in this test",
      "'ee' is already declared: a function that uses its test's variables cannot reuse the name of a function of the module (first declared at 3:8)",
      "'dd' is already declared: a function that uses its test's variables cannot reuse the name of an import (first declared at 5:29)",
      "'e2' is already declared in this test",
      "'e2' is already declared in this scope (first declared at 15:8)",
    ])
  })

  // A global another source module gives is an import, whichever kind of a
  // test's function takes its name, as a host global is
  test('an imported global is an import to every function a test declares', () => {
    expect(errorsOf(`import "./lib" "g" global g: u32
export func f() -> u32 => g
test "plain" {
  func g() -> u32 => 1
  assert true
}
test "capturing" {
  let v: u32 = 0
  func g() -> u32 => v
  assert true
}
test "in a block" {
  if true { func g() -> u32 => 1 }
  assert true
}`)).toEqual([
      "'g' is already declared: a function declared in a test cannot reuse the name of an import (first declared at 1:27)",
      "'g' is already declared: a function that uses its test's variables cannot reuse the name of an import (first declared at 1:27)",
      "'g' is already declared: a nested function cannot reuse the name of an import (first declared at 1:27)",
    ])
  })

  // A test's import of a global named like a function the module imports is
  // told the import's place, as one named like an imported global is
  test('a test\'s global import named like an imported function is told the import\'s place', () => {
    expect(errorsOf(`import "./lib" "dbl" func dbl(x: u32) -> u32
import "env" "hf" func hf() -> u32
export func f() -> u32 => dbl(1) + hf()
test "t" {
  import "./lib" "g" global dbl: u32
  import "env" "x" global hf: u32
  assert true
}`)).toEqual([
      "'dbl' is already declared: an import in a test cannot reuse the name of an import of the module (first declared at 1:27)",
      "'hf' is already declared: an import in a test cannot reuse the name of an import of the module (first declared at 2:24)",
    ])
  })

  // A module checked on its own, as the editor does where it cannot load the
  // program, tells one file's spellings apart no more than a program does
  test('one file by two spellings of its path is one file in a module checked on its own', () => {
    expect(errorsOf(`import "./lib" "dbl" func dbl(x: u32) -> u32
import "./lib.ents" "dbl" func dbl(x: u32) -> u32
import "./lib" "g" global g: u32
import "./lib.ents" "g" global g: u32
export func f() -> u32 => dbl(g)
test "t" {
  import "./sub/../lib" "dbl" func dbl(x: u32) -> u32
  assert f() == 14
}`)).toEqual([])
  })

  // A name only a test declares is no name outside the test, also where the
  // use is checked before the test: module code above it, and a generic's
  // body declared above it (12.4)
  test('a name only a test declares is none outside it, above the test too', () => {
    for (const source of [
      `func apply(comptime k: () -> u32) -> u32 => k()
export func above() -> u32 => apply(tf)
test "declares tf" {
  func tf() -> u32 => 2
  assert apply(tf) == 2
}
`,
      `func apply(comptime k: () -> u32) -> u32 => k()
func gen(comptime T: type) -> u32 => apply(tf)
test "declares tf" {
  func tf() -> u32 => 2
  assert apply(tf) == 2
}
export func e() -> u32 => gen(u32)
`,
    ]) {
      const parsed = parse(source, { filePath: 'test.ents' })
      const result = typecheck(parsed.module!, { source })
      const use = source.indexOf('apply(tf)') + 6
      expect(hover(source, parsed.module!, result, use)).toBeNull()
      expect(gotoDefinition(source, parsed.module!, result, use)).toBeNull()
      expect(findReferences(source, parsed.module!, result, use)).toBeNull()
      // The test's own use is the test's function
      const own = source.lastIndexOf('apply(tf)') + 6
      expect(gotoDefinition(source, parsed.module!, result, own)).not.toBeNull()
    }
  })

  // A nested function of a generic's body is the body's own name, also where
  // a test declares a function of the name below
  test('a generic\'s nested function named like a test\'s function is the generic\'s', () => {
    const source = `func wrap(comptime T: type, x: T) -> T {
  func helper(a: T) -> T => a
  return helper(x)
}
export func one() -> u32 => wrap(1:u32)
test "t" {
  func helper(a: u32) -> u32 => a + 1
  assert wrap(3:u32) == 3 && helper(1) == 2
}
`
    const parsed = parse(source, { filePath: 'test.ents' })
    const result = typecheck(parsed.module!, { source })
    expect(hoverText(hover(source, parsed.module!, result, source.indexOf('helper(x)'))!)).toBe('func helper: func(a: u32) -> u32 — nested in wrap(T = u32)')
  })

  // Two functions of one name from two files of one name, given to a
  // generic, are told apart by the files' paths (8.4)
  test('functions of two files of one name are named by the files\' paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'encantis-nested-'))
    try {
      await mkdir(join(dir, 'a'))
      await mkdir(join(dir, 'b'))
      await writeFile(join(dir, 'a/lib.ents'), 'export func g(x: u32) -> u32 => x + 1')
      await writeFile(join(dir, 'b/lib.ents'), 'export func g(x: u32) -> u32 => x + 2')
      const source = `import "./a/lib" "g" func g(x: u32) -> u32
import "./b/lib" "g" func h(x: u32) -> u32
func local(comptime f: (u32) -> u32, x: u32) -> u32 => f(x)
export func m() -> u32 => local(g, 1) + local(h, 2)
`
      const path = join(dir, 'main.ents')
      await writeFile(path, source)
      const load = await loadModule(path, { includeTests: true })
      const result = typecheckProgram(load.modules, path, { includeTests: true }).results.get(path)!
      const module = load.modules.get(path)!.module
      expect(hover(source, module, result, source.indexOf('f(x)'))?.instances).toEqual([
        { in: ['local(f = g (a/lib.ents))'], type: 'g (a/lib.ents)(x: u32) -> u32' },
        { in: ['local(f = g (b/lib.ents))'], type: 'g (b/lib.ents)(x: u32) -> u32' },
      ])
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  // An import's and an export's names are any text: written as WAT strings,
  // escaped (7.1, 7.2)
  test('names of imports and exports with quotes, backslashes or other letters build', async () => {
    const wat = watOfSource(`import "e\\"nv" ("a\\"b" func ab(x: u32) "u\\\\v" func(x: u32) "é" func(x: u32))
export "größe \\"w\\"" func m() -> u32 {
  ab(1)
  return 1
}`)
    const module = await WebAssembly.compile(await wasmOfWat(wat))
    expect(WebAssembly.Module.imports(module).map((i) => `${i.module}/${i.name}`)).toEqual(['e"nv/a"b', 'e"nv/u\\v', 'e"nv/é'])
    expect(WebAssembly.Module.exports(module).map((e) => e.name)).toEqual(['größe "w"'])
    const built = { wat }
    expect(built.wat).toContain('(import "e\\22nv" "a\\22b" (func $ab ')
    expect(built.wat).toContain('(import "e\\22nv" "u\\5cv" ')
    expect(built.wat).toContain('(import "e\\22nv" "\\c3\\a9" ')
    expect(built.wat).toContain('(export "gr\\c3\\b6\\c3\\9fe \\22w\\22" (func $m))')
  })
})

describe('nested functions: names, imports and the editor (seventh review)', () => {
  // An import that cannot be called is named in messages as it is written,
  // not by the % the checker knows it by (7.1, 12.4)
  test('messages name an import that cannot be called as it is written', () => {
    expect(errorsOf(`import "env" (
  "x.y" func(a: i32)
  "x.y" func(a: i64)
)
test "t" {
  import "env" "x.y" func(a: f32)
  assert true
}`)).toEqual([`'x.y' is the name of several functions of the module: a function declared in a test cannot take it over`])
    const unknown = errorsOf(`import "env" "console.log" func(msg: []u8)
export func m() {
  consolelog("hi")
}
test "t" {
  import "env" "a.b" func(x: u32)
  ab(1)
}`)
    expect(unknown).toContain(`unknown identifier 'consolelog' — did you mean 'console.log'?`)
    expect(unknown).toContain(`unknown identifier 'ab' — did you mean 'a.b'?`)
  })

  // Host functions of one name with other parameters, imported without a
  // local name, are called by that name (7.1), here and in an imported module
  test('functions of one name imported without a local name build and are called', async () => {
    const calls: number[] = []
    const env = new Proxy({}, { get: () => (x?: number) => (calls.push(x ?? -1), x === undefined ? 1.5 : x * 10) })
    const one = await buildPlain({
      'main.ents': `import "env" (
  "now" func() -> f64
  "now" func(x: i32) -> f64
)
export func m() -> f64 => now() + now(1:i32)`,
    }, env as Record<string, unknown>)
    expect(one.wat).toContain('(import "env" "now" (func $now:i32 (param $x i32) (result f64)))')
    expect((one.exports as unknown as { m: () => number }).m()).toBe(11.5)
    const imported = await buildPlain({
      'lib.ents': `import "env" ("tick" func() -> u32 "tick" func(x: u32) -> u32)
export func lt() -> u32 => tick() + tick(1)`,
      'main.ents': `import "./lib" "lt" func lt() -> u32
export func m2() -> u32 => lt()`,
    }, { tick: (x?: number) => (x === undefined ? 5 : x * 10) })
    expect(imported.wat).toContain('(func $lib$tick:u32 (param $x i32) (result i32))')
    expect(imported.exports?.m2()).toBe(15)
  })

  // The second of two imports of one name in one test, refused, is told the
  // first, also where the two are items of one import, whatever held the
  // name before: the module's function, or another test's (12.4, 3.3)
  test('a refused second item of an import is told the first item', () => {
    expect(errorsOf(`func f(x: u32) -> u32 => x
export func m() -> u32 => f(1)
test "t" {
  func f(x: u32) -> u32 => x
  assert f(1) == 1
}
test "u" {
  import "env" ("a" func f(x: u32) -> u32 "b" func f(x: u32) -> u32)
  let f: u32 = 1
  assert true
}
test "v" {
  let y: u32 = 1
  import "env" ("a" func f(x: u32) -> u32 "b" func f(x: u32) -> u32)
  func f() -> u32 => y
  assert true
}`)).toEqual([
      `'f' is already declared in this test`,
      `'f' is already declared in this scope (first declared at 8:26)`,
      `'f' is already declared in this test`,
      `'f' is already declared: a function that uses its test's variables cannot reuse the name of an import (first declared at 14:26)`,
    ])
    // A global first, with nothing of the name before
    expect(errorsOf(`test "t" {
  let y: u32 = 1
  import "env" ("a" global f: u32 "b" func f(x: u32) -> u32)
  func f() -> u32 => y
  assert true
}`)).toEqual([
      `'f' is already declared in this test`,
      `'f' is already declared: a function that uses its test's variables cannot reuse the name of an import (first declared at 3:28)`,
    ])
  })

  // Checked without a path (the editor's fallback), a source import is no
  // host import of the module whose name is its path spelled alike (7.1)
  test('checked without a path, a source import is not a host module of its file\'s name', () => {
    expect(errorsOf(`import "lib.ents" "f" func f(x: u32) -> u32
export func use() -> u32 => f(1)
test "t" {
  import "./lib" "f" func f(x: u32) -> u32
  assert f(1) > 0
}`)).toEqual([`'f' is already declared: an import in a test cannot reuse the name of an import of the module (first declared at 1:28)`])
    // One file's spellings are still one file
    expect(errorsOf(`import "./lib" "f" func f(x: u32) -> u32
export func use() -> u32 => f(1)
test "t" {
  import "./sub/../lib.ents" "f" func f(x: u32) -> u32
  assert f(1) > 0
}`)).toEqual([])
  })

  // A nested function of a generic's body is the body's own, also where a
  // test above the generic declares a function of the name: the editor
  // finds it at its call (Nested Functions, 12.4)
  test('a generic\'s nested function named like a test\'s function above it is the generic\'s', () => {
    const source = `test "declares tf" {
  func tf() -> u32 => 2
  assert gen(1 as u32) == 3
  assert tf() == 2
}
func gen(comptime T: type, x: T) -> u32 {
  func tf() -> u32 => 3
  return tf()
}
export func above() -> u32 => gen(1 as u32)
`
    const parsed = parse(source, { filePath: 'test.ents' })
    const result = typecheck(parsed.module!, { source })
    expect(result.errors).toEqual([])
    const call = source.indexOf('tf()\n}')
    expect(result.unseen.has(call)).toBe(false)
    expect(hoverText(hover(source, parsed.module!, result, call)!)).toBe('func tf: func() -> u32 — nested in gen(T = u32)')
    const declared = source.indexOf('tf() -> u32 => 3')
    expect(gotoDefinition(source, parsed.module!, result, call)?.location.offset).toBe(declared)
  })

  // At its call, a generic's nested function is the generic's for every
  // question, not a test's function of the name: definition, references and
  // rename (Nested Functions, 12.4)
  test('definition, references and rename at a generic\'s nested function named like a test\'s', () => {
    const source = `func wrap(comptime T: type, x: T) -> T {
  func helper(a: T) -> T => a
  return helper(x)
}
export func one() -> u32 => wrap(1:u32)
test "t" {
  func helper(a: u32) -> u32 => a + 1
  assert wrap(3:u32) == 3 && helper(1) == 2
}
`
    const parsed = parse(source, { filePath: 'test.ents' })
    const result = typecheck(parsed.module!, { source })
    const call = source.indexOf('helper(x)')
    const declared = source.indexOf('helper(a: T)')
    expect(gotoDefinition(source, parsed.module!, result, call)?.location.offset).toBe(declared)
    expect(findReferences(source, parsed.module!, result, call)?.references.map((r) => r.offset)).toEqual([call])
    expect(rename(source, parsed.module!, result, call)?.locations.map((l) => l.offset)).toEqual([declared, call])
    // The test's function is its own
    const testCall = source.indexOf('helper(1)')
    expect(rename(source, parsed.module!, result, testCall)?.locations.map((l) => l.offset)).toEqual([source.indexOf('helper(a: u32)'), testCall])
  })

  // One function imported twice is one name: the second import's local
  // name is one more place of the first, also where a test imports it
  // again (3.4, 12.4)
  test('definition, references and rename at a function imported again', () => {
    const source = `import "./lib" "dbl" func dbl(x: u32) -> u32
import "./lib" "dbl" func dbl(x: u32) -> u32
export func m() -> u32 => dbl(1) + dbl(2)
test "t" {
  import "./lib" "dbl" func dbl(x: u32) -> u32
  assert dbl(3) == 6
}
`
    const parsed = parse(source, { filePath: 'test.ents' })
    const result = typecheck(parsed.module!, { source })
    const second = source.indexOf('dbl(x', source.indexOf('\n'))
    const first = source.indexOf('func dbl')
    const uses = [second, source.indexOf('dbl(1)'), source.indexOf('dbl(2)')]
    expect(gotoDefinition(source, parsed.module!, result, second)?.location.offset).toBe(first)
    expect(findReferences(source, parsed.module!, result, second)?.references.map((r) => r.offset)).toEqual(uses)
    expect(rename(source, parsed.module!, result, second)?.locations.map((l) => l.offset)).toEqual([first + 5, ...uses])
  })

  // A test's function refused its name shows its own type in hover, as the
  // language server shows it (12.4)
  test('hover at a refused test function shows its own type', () => {
    const source = `func hash(k: u32) -> u32 => k
func hash(k: u64) -> u32 => 1
test "declares a name it cannot" {
  func hash(k: f64) -> f64 => k
  assert hash(1.0) == 1.0
}
export func m() -> u32 => hash(2:u32)
`
    const parsed = parse(source, { filePath: 'test.ents' })
    const result = typecheck(parsed.module!, { source })
    expect(hover(source, parsed.module!, result, source.indexOf('hash(k: f64)'))?.type).toBe('func(k: f64) -> f64')
    expect(hover(source, parsed.module!, result, source.indexOf('hash(k: u64)'))?.type).toBe('func(k: u64) -> u32')
  })

  // Where every instance of a generic's nested function has one signature,
  // hover gives it as before, however the source spaces it, with no
  // signature per instance (hover --json keeps its shape)
  test('hover at a generic\'s nested function whose instances agree gives their one signature', () => {
    const source = `type Num = u32
func gapply(comptime f: (u32) -> u32, x: u32) -> u32 {
  let v: u32 = x
  func gh( y:Num,
          // the second
          z: Num )->Num => f(y) + v + z
  return gh(x, x)
}
func modf(x: u32) -> u32 => x + 1
func bf(x: u32) -> u32 => x
export func agree(n: u32) -> u32 => gapply(modf, 2) + gapply(bf, 3)
`
    const parsed = parse(source, { filePath: 'test.ents' })
    const result = typecheck(parsed.module!, { source })
    expect(hover(source, parsed.module!, result, source.indexOf('gh('))).toEqual({
      name: 'gh',
      type: 'func(y: u32, z: u32) -> u32',
      kind: 'func',
      nestedIn: 'gapply',
      capturesIn: [{ in: ['gapply(f = modf)', 'gapply(f = bf)'], type: 'v' }],
    })
    // Where they differ, the generic's own, on one line and without comments
    const typed = `func gapply(comptime T: type, x: T) -> u32 {
  func gh(a: [*]T, // first
          b: [*]T /* second */) -> T => 1 as T
  return gh(0 as [*]T, 0 as [*]T) as u32
}
export func two() -> u32 => gapply(u32, 2) + gapply(u64, 3)
`
    const typedParsed = parse(typed, { filePath: 'test.ents' })
    const typedResult = typecheck(typedParsed.module!, { source: typed })
    expect(hover(typed, typedParsed.module!, typedResult, typed.indexOf('gh('))?.type).toBe('func(a: [*]T, b: [*]T) -> T')
  })

  // An import's or an export's name is UTF-8 text: a byte that is part of
  // no character is refused, not written as another name (7.2)
  test('import and export names that are not UTF-8 are refused', () => {
    expect(parse('export "a\\x80" func f() -> u32 => 1').errors.map((e) => e.shortMessage)).toEqual([`an export's name is UTF-8 text: \\x80 is no character of it`])
    expect(parse('import "env" "b\\xff" func g(x: u32)').errors.map((e) => e.shortMessage)).toEqual([`the name an import gives is UTF-8 text: \\xff is no character of it`])
    expect(parse('import "e\\xe2\\x82" ("g" func g(x: u32))').errors.map((e) => e.shortMessage)).toEqual([`a module an import names is UTF-8 text: \\xe2 is no character of it`])
    expect(parse('export "\\xe2\\x82\\xac" func f() -> u32 => 1').errors).toEqual([])
  })
})

describe('nested functions: names, places and the editor (eighth review)', () => {
  // A name several functions of the module share is named as the import
  // writes it, a ':' of its own included (7.1, 12.4)
  test('the shared-name message keeps a colon of the import\'s name', () => {
    expect(errorsOf(`import "env" ("a:b" func(a: i32) "a:b" func(a: i64))
import "env" ("a" func(a: i32) "a" func(a: i64))
import "env" (":" func(a: i32) ":" func(a: i64))
test "t" {
  import "env" "a:b" func(a: f32)
  import "env" "a" func(a: f32)
  import "env" ":" func(a: f32)
  assert true
}`)).toEqual([
      `'a:b' is the name of several functions of the module: a function declared in a test cannot take it over`,
      `'a' is the name of several functions of the module: a function declared in a test cannot take it over`,
      `':' is the name of several functions of the module: a function declared in a test cannot take it over`,
    ])
  })

  // Module code below a test reads a name as if the test were not there: a
  // clash there is told the module's declaration, also after the test's
  // grouped import of the name; in the test, its first item (12.4, 3.3)
  test('module code below a test is told the module\'s declaration of a name', () => {
    expect(errorsOf(`func f(x: u32) -> u32 => x
export func m() -> u32 => f(1)
test "t" {
  import "env" ("a1" func f(x: u32) -> u32 "a2" func f(x: u32) -> u32)
  let f: u32 = 1
  assert f > 0
}
test "u" {
  import "env" "b1" func f(x: u32) -> u32
  assert f(1) > 0
}
export func m2() -> u32 {
  let f: u32 = 3
  let f: u32 = 4
  return f
}`)).toEqual([
      `'f' is already declared in this test`,
      `'f' is already declared in this scope (first declared at 4:27)`,
      `'f' is already declared in this scope (first declared at 1:6)`,
      `'f' is already declared in this scope (first declared at 1:6)`,
    ])
  })
})
