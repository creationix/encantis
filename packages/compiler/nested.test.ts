/** biome-ignore-all lint/style/noNonNullAssertion: this is a test, it's fine */
// Nested functions (reference 3.4, Nested Functions): what the checker says
// of them, what they capture and write, and how they compile.
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { typecheck, typecheckProgram, type TypeCheckResult } from './checker'
import { programToWatWithTests } from './codegen'
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
    for (const [name, source] of Object.entries(files)) await writeFile(join(dir, name), source)
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
      ['sort<i32|__test1.closer>', 'sort(T = i32, before = __test1.closer)'],
      ['sort<i32|__test1.desc>', 'sort(T = i32, before = desc)'],
    ])
    const { failed, ran } = await runTestsOfSource(source)
    expect(ran.length).toBe(1)
    expect(failed).toEqual([])
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
