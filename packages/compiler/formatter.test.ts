import { describe, expect, test } from 'bun:test'
import { formatEncantis } from './formatter'
import { parse } from './parser'

// Every form generics add: comptime parameters first, in the middle and near
// misses of them; type arguments that are parsed as types and ones that are
// expressions; a type parameter used as a type and passed on.
const GENERICS = `type Pt = (q: i32, r: i32)

func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }
func at(xs: []T, comptime T: type, i: u32) -> T => xs.ptr[i]
func head(comptime T: type, xs: []T) -> T => xs.ptr[0]
func both(comptime A: type, comptime B: type, p: (A, B)) -> A => p.0
func bytes(comptime T: type, n: u32) -> u32 => n * sizeof(T)
func fact(comptime T: type, n: T) -> T => if n <= 1 { 1 } else { n * fact(T, n - 1) }
func sort(comptime T: type, xs: []mut T, comptime before: (T, T) -> bool) { }

func swap(comptime T: type, a: *mut T, b: *mut T) {
  let tmp = a.*
  a.* = b.*
  b.* = tmp
}

func cast(comptime T: type, p: u32) -> [*]mut T {
  return p as [*]mut T
}

export func a(p: Pt, q: Pt) -> Pt => max(Pt, p, q)
export func b(xs: [][]u8) -> []u8 => head([]u8, xs)
export func c(xs: []*mut Pt) -> *mut Pt => head(*mut Pt, xs)
export func d(xs: []?*Pt) -> ?*Pt => head(?*Pt, xs)
export func e(xs: [][*]u8, ys: []u8#16) -> u8#16 => head(u8#16, ys) + head([*]u8, xs)[0]
export func f(p: (i32, i32), q: (i32, i32)) -> (i32, i32) => max((i32, i32), p, q)
export func g(xs: [][4]u8) -> u32 => bytes([4]u8, xs.len) + max(u32, 1, -2 as u32)
export func h(x: f64) -> f64 => max(x, 0.5) + fact(f64, 3.0)

test "generics" {
  assert max(u32, 1, 2) == 2
  assert max(i64, -1, 5) == 5
  let x = &1:u32
  let y = &2:u32
  swap(x, y)
  swap(u32, x, y)
}
`

// Generic types and comptime function parameters: a type function, a type
// applied in every place a type is written, a type that is called, and a
// function passed for a comptime parameter.
const GENERIC_TYPES = `func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
func Pair(comptime A: type, comptime B: type) -> type => (first: A, second: B)
export func Slot(comptime K: type) -> type => (used: bool, key: K)

type Bytes = Vec(u8)
global shelf: Vec(u16) = (0 as [*]mut u16, 0, 0)

func last(comptime T: type, v: *Vec(T)) -> T => v.ptr[v.len - 1]
func swapped(comptime A: type, comptime B: type, p: Pair(A, B)) -> Pair(B, A) => Pair(B, A)(p.second, p.first)
func make(comptime T: type, x: i32) -> T => T(x, x)

func sort(comptime T: type, xs: []mut T, comptime before: (T, T) -> bool) {
  if xs.len > 1 && before(xs.ptr[1], xs.ptr[0]) {
    let x = xs.ptr[0]
    xs.ptr[0] = xs.ptr[1]
    xs.ptr[1] = x
  }
}

func ascending(a: i32, b: i32) -> bool => a < b

export func f(v: *mut Vec(u32), p: Pair(u8, Vec(u8)), xs: []mut i32) -> u32 {
  let w: Vec(u8) = Vec(u8)(0 as [*]mut u8, 0, 0)
  let q = Pair(u8, u16)(first: 1, second: 2)
  let r = swapped(Pair(u8, u16)(1, 2))
  sort(xs, ascending)
  sort(i32, xs, ascending)
  return last(v) + last(u32, v) + w.len + sizeof(Vec(Pair(u8, Slot(u8)))) + (v as *Vec(u8)).len + make((i32, i32), 1).0 as u32
}
`

// Method calls and functions that share a name: receivers of every kind,
// chains, type arguments after the receiver, and members whose names start
// like a primitive type.
const METHODS = `func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
type Box = (u32s: u32, boolish: bool)

func push(comptime T: type, v: *mut Vec(T), x: T) {
  v.ptr[v.len] = x
  v.len += 1
}

func items(comptime T: type, v: *Vec(T)) -> []T => v.ptr[0..v.len]
func hash(k: u32) -> u32 => k * 0x45d9f3b
func hash(k: []u8) -> u32 => k.len
func i8_le(b: Box) -> u32 => b.u32s
func double(n: u32) -> u32 => n * 2

export "hash_bytes" func hash(k: [*]u8, n: u32) -> u32 => k[0..n].hash()

export func f(v: *mut Vec(u8), b: Box, p: *u8) -> u32 {
  v.push(7)
  v.push(u8, 9)
  let n = v.items().hash().double().min(b.i8_le())
  let m = (5:u32).hash() + (n + 1).double() + v.items().len.double() + p.u32[0] + p.u32-1
  return if b.boolish { n.max(m) } else { v.*.len.hash() }
}

test "methods" {
  assert (3:u32).double() == 6
  assert "four".hash() == 4
}
`

// The AST without source positions.
function shape(source: string): unknown {
  const parsed = parse(source)
  expect(parsed.errors.map(e => e.message)).toEqual([])
  return JSON.parse(
    JSON.stringify(parsed.module, (key, value) => (key === 'span' || key === 'identSpan' ? undefined : typeof value === 'bigint' ? `${value}n` : value)),
  )
}

describe('formatter', () => {
  test('formatting generics a second time changes nothing', () => {
    const once = formatEncantis(GENERICS)
    expect(formatEncantis(once)).toBe(once)
  })

  test('formatted generics are the same program', () => {
    expect(shape(formatEncantis(GENERICS))).toEqual(shape(GENERICS))
  })

  test('formatting generic types a second time changes nothing, and leaves the same program', () => {
    const once = formatEncantis(GENERIC_TYPES)
    expect(formatEncantis(once)).toBe(once)
    expect(shape(once)).toEqual(shape(GENERIC_TYPES))
  })

  test('formatting method calls a second time changes nothing, and leaves the same program', () => {
    const once = formatEncantis(METHODS)
    expect(formatEncantis(once)).toBe(once)
    expect(shape(once)).toEqual(shape(METHODS))
  })

  // No space comes between a receiver, the dot and the method, nor between
  // the method and its arguments.
  test('a method call is spaced like a member followed by a call', () => {
    const formatted = formatEncantis('func f(v:*mut V)->u32=>v . items( ) .hash ( ).min( v.u32s ,2 )\n')
    expect(formatted).toBe('func f(v:*mut V) -> u32 => v.items().hash().min(v.u32s, 2)\n')
  })

  // No space is put between a generic type's name and its arguments, where
  // one would make the application no application.
  test('a type function and a type applied are spaced like a function and a call', () => {
    const formatted = formatEncantis('func Vec( comptime T:type )->type=>( ptr:[*]mut T ,len:u32 )\nfunc f(v:*Vec( u32 ))->u32=>Vec(u32)( v.ptr ,0 ).len\n')
    expect(formatted).toBe('func Vec(comptime T:type) -> type => (ptr:[*]mut T, len:u32)\nfunc f(v:*Vec(u32)) -> u32 => Vec(u32)(v.ptr, 0).len\n')
  })

  test('a comptime parameter and a type argument are spaced like any other', () => {
    const formatted = formatEncantis('func max( comptime   T:type ,a :T)->T=>a\nfunc f(a:i32)->i32=>max (i32 , -a)\n')
    expect(formatted).toBe('func max(comptime T:type, a:T) -> T => a\nfunc f(a:i32) -> i32 => max(i32, -a)\n')
  })

  // comptime is a word of the language, not a name. No valid program has a
  // parenthesis or a bracket right after it, but a line being typed may, and
  // there it is not drawn up to it the way the name of a called function is.
  test('comptime is spaced as a keyword', () => {
    expect(formatEncantis('func f(comptime(T): type) {}\n')).toBe('func f(comptime (T):type) {}\n')
    expect(formatEncantis('func f(comptime[n]u8) {}\n')).toBe('func f(comptime [n]u8) {}\n')
    expect(formatEncantis('func f(computed(T), computed[n]) {}\n')).toBe('func f(computed(T), computed[n]) {}\n')
  })
})
