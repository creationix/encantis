/** biome-ignore-all lint/style/noNonNullAssertion: this is a test, it's fine */
// Nested functions (reference 3.4, Nested Functions): what the checker says
// of them, what they capture and write, and how they compile.
import { describe, expect, test } from 'bun:test'
import { typecheck, type TypeCheckResult } from './checker'
import { parse } from './parser'

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
        "'total' is already declared: a nested function cannot reuse the name of a global",
        "'size' is already declared: a nested function cannot reuse the name of a function of the module",
        "'n' is already declared: a nested function cannot reuse the name of a parameter",
        "'keep' is already declared in 'f': a nested function's name is its own in the whole function that declares it",
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
        "'step' is already declared in 'g': a nested function's name is its own in the whole function that declares it",
        "'tick' is already declared in 'g': a nested function's name is its own in the whole function that declares it",
      ])
    })

    test('a nested function declared after a variable not seen there', () => {
      expect(errorsOf(`
func g() -> u32 {
  for step in 3 { }
  func step() { }
  return 0
}`)).toEqual(["'step' is already declared in 'g': a nested function's name is its own in the whole function that declares it"])
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
        "'x' is already declared: a parameter of a nested function cannot reuse the name of a parameter",
        "'x' is already declared: a result of a nested function cannot reuse the name of a parameter",
        "'k' is already declared: a parameter of a nested function cannot reuse the name of a nested function in scope",
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
    expect(setsOf(result, 'test_counts.see')).toEqual({ captures: ['seen'], writes: ['seen'] })
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

  test('a capturing one takes no name of the module', () => {
    expect(errorsOf(`
func helper() -> u32 => 1
test "t" {
  let x: u32 = 1
  func helper() -> u32 => x
  assert helper() == 1
}`)).toEqual(["'helper' is already declared: a function that uses its test's variables cannot reuse the name of a function of the module"])
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
    expect(setsOf(result, 'test_blocks.add')).toEqual({ captures: ['n', 'i'], writes: ['n'] })
  })
})
