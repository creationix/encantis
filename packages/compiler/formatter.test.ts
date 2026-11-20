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

  // A host type and its optional form are spaced as any type and ?*T are.
  test('a host type and an optional one are spaced like any other type', () => {
    const formatted = formatEncantis('type Canvas=host\nglobal c : ?Canvas=0\nfunc f(x :?Canvas ,y:Canvas)->Canvas=>x??y\n')
    expect(formatted).toBe('type Canvas = host\nglobal c:?Canvas = 0\nfunc f(x:?Canvas, y:Canvas) -> Canvas => x ?? y\n')
    expect(formatEncantis(formatted)).toBe(formatted)
    expect(shape(formatted)).toEqual(shape('type Canvas = host\nglobal c: ?Canvas = 0\nfunc f(x: ?Canvas, y: Canvas) -> Canvas => x ?? y\n'))
  })

  test('a comptime parameter and a type argument are spaced like any other', () => {
    const formatted = formatEncantis('func max( comptime   T:type ,a :T)->T=>a\nfunc f(a:i32)->i32=>max (i32 , -a)\n')
    expect(formatted).toBe('func max(comptime T:type, a:T) -> T => a\nfunc f(a:i32) -> i32 => max(i32, -a)\n')
  })

  test('prefix operators in assertions stay next to their operands', () => {
    const source = `func ok(x:u32) -> bool => x > 1
func f(n:i32, x:u32) {
  assert ! ok(0)
  assert - n < 1
  assert ~ x != 0
  assert & n != & n
  assert((-n as i64) < 1)
  if true { assert ! ok(0) }
}
test "neg" { assert - 0x10 == -16 }
`
    const expected = `func ok(x:u32) -> bool => x > 1
func f(n:i32, x:u32) {
  assert !ok(0)
  assert -n < 1
  assert ~x != 0
  assert &n != &n
  assert((-n as i64) < 1)
  if true { assert !ok(0) }
}
test "neg" { assert -0x10 == -16 }
`
    const formatted = formatEncantis(source)
    expect(formatted).toBe(expected)
    expect(formatEncantis(formatted)).toBe(formatted)
    expect(shape(formatted)).toEqual(shape(source))
  })

  test('assert used as an identifier keeps call and binary operator spacing', () => {
    const source = `func assert(x:i32) -> i32 => x
func f(x:i32) -> i32 => assert(x) - 1
func g(assert:i32, n:i32) -> i32 {
  return
  assert - n
}
func h(assert:i32, n:i32) -> i32 {
  return assert /* subtraction */ - n
}
func i(assert:i32, n:i32) -> i32 {
  let pair = (0,
  assert - n)
  return pair.1
}
`
    const formatted = formatEncantis(source)
    expect(formatted).toBe(source)
    expect(shape(formatted)).toEqual(shape(source))
  })

  test('block comments stay intact next to assertions and their operators', () => {
    const source = `func f(n:i32) {
  assert /*  gap */ - n < 0
  /* α */ assert - n < 0
  assert - /* operand */ n < 0
  /* assert - n */ let unformatted=1
}
`
    const expected = `func f(n:i32) {
  assert /*  gap */ -n < 0
  /* α */ assert -n < 0
  assert - /* operand */ n < 0
  /* assert - n */ let unformatted=1
}
`
    const formatted = formatEncantis(source)
    expect(formatted).toBe(expected)
    expect(formatEncantis(formatted)).toBe(formatted)
    expect(shape(formatted)).toEqual(shape(source))
  })

  test('incomplete blocks keep the gap after an ambiguous assert operator', () => {
    const broken = `func f(n:i32) {
  assert !ok(0)
  foo()
  assert -n < 0
  assert &  n != &n
  let =
}
`
    expect(formatEncantis(broken)).toBe(broken)
    const unclosed = broken.replace('  let =\n}\n', '')
    expect(formatEncantis(unclosed)).toBe(unclosed)
    const complete = broken.replace('let =', 'let x = 1')
    const formatted = formatEncantis(complete)
    expect(formatted).toBe(complete.replace('&  n', '&n'))
    expect(shape(formatted)).toEqual(shape(complete))
  })

  test('unary spacing looks past inline comments while binary spacing stays binary', () => {
    const source = `func f(n:i32) {
  assert -n == f(1, /* c */ /* d */ -2, /* e */ ! false, /* f */ & &n, n /* g */ -2)
}
`
    const expected = source.replace('! false', '!false').replace('/* g */ -2', '/* g */ - 2')
    const formatted = formatEncantis(source)
    expect(formatted).toBe(expected)
    expect(formatEncantis(formatted)).toBe(formatted)
    expect(shape(formatted)).toEqual(shape(source))
  })

  test('a block comment closing before a multiline literal stays intact', () => {
    const source = "func f() {\n  /* comment\n  end */ let s = `abc  \ndef`\n  /* next\nend */ let q = \"a\n b\"\n}\n"
    expect(formatEncantis(source)).toBe(source)
    expect(shape(formatEncantis(source))).toEqual(shape(source))
  })

  test('large blocks distinguish assertions from continuation expressions', () => {
    const source = `func f(n:i32, assert:i32) {
${'  foo()\n'.repeat(300)}  if true {
    assert & n != 0
  }
  assert - n < 0
  break
  assert - n < 1
  return n
  assert - n < 2
  let n = assert
  assert - n < 3
  let size = sizeof /* data size */ data
  assert - n < 4
  let negated = -1
  assert - n < 5
  let ranged = n as u32#assert
  assert - n < 6
  let other = n ??
  assert &n
  let cell = p. *
  assert & n != 0
  assert assert &n
  defer /* continuation */
  assert -n
}
func arms(n:i32, assert:i32) -> i32 {
${'  foo()\n'.repeat(300)}  return match n { 1 => assert -n, _ => n }
}
`
    const expected = source.replaceAll('assert & n', 'assert &n')
      .replaceAll('assert - n <', 'assert -n <')
      .replace('  assert &n\n', '  assert & n\n')
      .replace('assert assert &n', 'assert assert & n')
      .replace('p. *', 'p.*')
      .replace('  assert -n\n', '  assert - n\n')
      .replace('=> assert -n', '=> assert - n')
    const formatted = formatEncantis(source)
    expect(formatted).toBe(expected)
    expect(formatEncantis(formatted)).toBe(formatted)
    expect(shape(formatted)).toEqual(shape(source))
  })

  test('comments with more text than a probe can use do not change its classification', () => {
    const padding = 'words not code '.repeat(300)
    const source = `func f(n:i32, assert:i32) {
  /* ${padding} */
  let name = assert
  assert - n < 0
  return /* continuation */
  assert -n
}
`
    const formatted = formatEncantis(source)
    expect(formatted).toBe(source.replace('assert - n < 0', 'assert -n < 0').replace('  assert -n\n', '  assert - n\n'))
    expect(formatEncantis(formatted)).toBe(formatted)
    expect(shape(formatted)).toEqual(shape(source))
  })

  // A member's name is a whole identifier, hyphens included: p.u32-1 is a
  // member called u32-1. A subtraction is printed with spaces, so the two
  // read apart, and the formatter never joins or splits a hyphenated name.
  test('a subtraction after a member is spaced, a hyphenated member is not', () => {
    const formatted = formatEncantis('func f(p:*u8,s:[]u8,x:S)->u32=>p.u32 -1+s.len -1+x.u32-count+(p.u32)-1\n')
    expect(formatted).toBe('func f(p:*u8, s:[]u8, x:S) -> u32 => p.u32 - 1 + s.len - 1 + x.u32-count + (p.u32) - 1\n')
    expect(formatEncantis('func f(p:*u8)->u32=>p.u32-1\n')).toBe('func f(p:*u8) -> u32 => p.u32-1\n')
    // What it prints parses as it reads: a subtraction and a member.
    const expr = (source: string) => {
      const result = parse(source, { startRule: 'Expr' })
      expect(result.errors).toEqual([])
      return result.module as unknown
    }
    expect(expr('p.u32 - 1')).toMatchObject({ kind: 'BinaryExpr', op: '-', left: { kind: 'MemberExpr', member: { kind: 'type' } } })
    expect(expr('p.u32-1')).toMatchObject({ kind: 'MemberExpr', member: { kind: 'field', name: 'u32-1' } })
  })

  // comptime is a word of the language, not a name. No valid program has a
  // parenthesis or a bracket right after it, but a line being typed may, and
  // there it is not drawn up to it the way the name of a called function is.
  // A decimal number went on over any point and the letters after an x, so
  // `0..0x1F` was read as the number 0..0x1 and the name F, and came out as
  // `0..0x1 F`; an exponent, an octal or dozenal number and a base64 string
  // were split after their first letter. Every form of literal is one word,
  // right after the points of a range too, and keeps its spacing.
  test('a number and a string literal are never split, after the points of a range neither', () => {
    const literals = ['0x1F', '0b101', '0o17', '0d1B', '31', '2.5', '1.5e3', '1.0e-12', '6.022E+23', '0x1F:u32', '-1', '-1.5e-10', 'n']
    const lines = [
      ...literals.flatMap(n => [`let a = p[0..${n}]`, `let a = p[${n}..]`, `let a = p[..${n}]`, `let a = p[${n}..${n}]`]),
      'let f = 1.0e300', 'let s = b"SGk=" == x"48 69"', 'let q = t.0.len + t.0.1', 'let d = 0d10B + 0o755 * 0b1010',
    ]
    const program = `export func f(p: *[64]u8, t: ((*[2]u8, u8), u8), n: u32) {\n${lines.map(l => `  ${l}\n`).join('')}}\n`
    const formatted = formatEncantis(program.replaceAll(': ', ':'))
    expect(formatted.split('\n').slice(1, -2).map(l => l.trim())).toEqual(lines)
    expect(shape(formatted)).toEqual(shape(program))
  })

  // A string or a template that goes on over lines was formatted line by
  // line, but the spaces a line of it ends with, the indentation of the next
  // and its blank lines are its text: `"ab  \n    cd"` came out as
  // `"ab\n  cd "`, and a template's `${n}` on a line of its own as `$ { n }`.
  test('a string or a template that goes on over lines keeps its text', () => {
    const literal = [
      '"ab   ', '      ', '', '', '   cd { [ ( // not a comment', '  ef"',
    ]
    const template = ['`x${n}', '    y ${n}   ', 'z`']
    const hex = ['x"01', '        02 03"']
    const program = (indent: (line: string) => string) => [
      'export func f(n:u32) -> u32 {',
      `${indent('let a =')} ${literal.join('\n')}`,
      `${indent('let b =')} ${template.join('\n')}.len`,
      `${indent('let c =')} ${hex.join('\n')}`,
      `${indent('return a.len + b + c.len')}`,
      '}',
      '',
    ].join('\n')
    // Up to a literal, and after it, the lines are formatted as any other
    const formatted = formatEncantis(program((line) => `      ${line.replaceAll(' ', '   ')}`))
    expect(formatted).toBe(program((line) => `  ${line}`))
    expect(shape(formatted)).toEqual(shape(program((line) => line)))
    expect(formatEncantis(formatted)).toBe(formatted)
  })

  // A literal in single quotes is codepoints, not a string, and stays as it
  // is written: its quotes, its characters and its escapes.
  test('a literal in single quotes is kept as written', () => {
    const source = "def tab = '\\t'\nfunc f(c:u8)->bool=>c=='a'||c==   '\\''||c=='é'||c=='\\u{e9}'\nfunc g()->i32{\n  let (o,k)='o k'\n  return o -'\\x30'\n}\n"
    const once = formatEncantis(source)
    expect(once).toBe("def tab = '\\t'\nfunc f(c:u8) -> bool => c == 'a' || c == '\\'' || c == 'é' || c == '\\u{e9}'\nfunc g() -> i32 {\n  let (o, k) = 'o k'\n  return o - '\\x30'\n}\n")
    expect(formatEncantis(once)).toBe(once)
    expect(shape(once)).toEqual(shape(source))
  })

  // A space after b would make the base64 string an identifier and a string.
  test('a hex or base64 string keeps its prefix', () => {
    const source = 'data k = b"SGVs bG8="\ndata h = x"41 42"\n'
    expect(formatEncantis(source)).toBe(source)
    expect(shape(formatEncantis(source))).toEqual(shape(source))
  })

  // A ranged type is one word with its bound, a number, a name or the
  // parenthesis of an expression: split at the #, it would not parse.
  test('a length and a bound that are expressions, and a value argument, keep their meaning', () => {
    const source = 'func Ring(comptime n:u32, comptime T:type)->type=>(head:u32#n, count:u32#(n+1), items:*mut [n*2]T, b:[0x10]mut u8)\nfunc f(comptime n:u32, x:*Ring(n*2,u32), y:Ring( 8 ,u32 ), i:u32#16)->u32=>sizeof(Ring(4+4,u32))\n'
    const once = formatEncantis(source)
    expect(once).toBe('func Ring(comptime n:u32, comptime T:type) -> type => (head:u32#n, count:u32#(n + 1), items:*mut [n * 2]T, b:[0x10]mut u8)\nfunc f(comptime n:u32, x:*Ring(n * 2, u32), y:Ring(8, u32), i:u32#16) -> u32 => sizeof (Ring(4 + 4, u32))\n')
    expect(formatEncantis(once)).toBe(once)
    expect(shape(once)).toEqual(shape(source))
  })

  test('comptime is spaced as a keyword', () => {
    expect(formatEncantis('func f(comptime(T): type) {}\n')).toBe('func f(comptime (T):type) {}\n')
    expect(formatEncantis('func f(comptime[n]u8) {}\n')).toBe('func f(comptime [n]u8) {}\n')
    expect(formatEncantis('func f(computed(T), computed[n]) {}\n')).toBe('func f(computed(T), computed[n]) {}\n')
  })
})
