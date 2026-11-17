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

// The AST without source positions.
function shape(source: string): unknown {
  const parsed = parse(source)
  expect(parsed.errors.map(e => e.message)).toEqual([])
  return JSON.parse(
    JSON.stringify(parsed.module, (key, value) => (key === 'span' ? undefined : typeof value === 'bigint' ? `${value}n` : value)),
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
