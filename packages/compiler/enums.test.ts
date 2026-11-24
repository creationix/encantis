// Enums (reference 2.9): their declarations, values, the checks on them, and
// how a match, an if let and an elif let take one apart. The wasm an enum
// compiles to is pinned in the codegen part below.
/** biome-ignore-all lint/style/noNonNullAssertion: this is a test, it's fine */
import { describe, expect, test } from 'bun:test'
import { typecheck, type TypeCheckResult } from './checker'
import { moduleToWat, type NestingLimitError } from './codegen'
import { buildMeta } from './meta'
import { documentSymbols, findReferences, gotoDefinition, hover, hoverText, rename } from './queries'
import { parse } from './parser'
import { canonicalKey, byteSize, enumLayout, enumSlots, type EnumRT, type ResolvedType, typeEquals, typeParts, typeRegisters, typeToString, unwrap, wasmTypes } from './types'

function check(source: string): TypeCheckResult {
  const result = parse(source)
  if (result.errors.length > 0) throw new Error(`Parse error: ${result.errors[0].message}`)
  return typecheck(result.module!, { source })
}

// Each error as line:col and its message, in the order reported
function errors(source: string): string[] {
  const lines = (offset: number) => {
    const before = source.slice(0, offset).split('\n')
    return `${before.length}:${before[before.length - 1].length + 1}`
  }
  return check(source).errors.map((e) => `${lines(e.offset)} ${e.message}`)
}

const COLOR = `enum Color {
  Red,
  Blue,
  Green,
  Rgb(r: u8, g: u8, b: u8),
  Hsl(h: u8, s: u8, l: u8),
  Grey(b: u8),
  Darker(c: *Color)
}
`

const JSON_ENUM = `enum Json {
  Null,
  Boolean(bool),
  Number(f64),
  String([]u8),
  Array([]Json),
  Object([]([]u8, Json))
}
`

// The enum a module declares under `name`
function enumOf(source: string, name: string): EnumRT {
  const sym = check(source).symbols.get(name)
  if (sym?.kind !== 'type') throw new Error(`no type ${name}`)
  const e = unwrap(sym.type)
  if (e.kind !== 'enum') throw new Error(`${name} is no enum`)
  return e
}

const SHAPES = `${COLOR}${JSON_ENUM}enum Dir { North, East, South, West }
type Point = (x: f32, y: f32)
enum Shape { Dot(Point), Circle(at: Point, r: f32), Path([]Point) }
enum Num { Int(i64), Float(f64), Small(f32), Pair(u8, f32) }
enum Big { Small2(u32), Large(u128) }
enum Paint { None, Solid(Color), Mix(Color, Color) }
`

describe('an enum in registers and in memory', () => {
  test('the slots of 3.1, each the one type of its values, else i64 if one is 64 bits, else i32', () => {
    const slots = (name: string) => enumSlots(enumOf(SHAPES, name)).join(' ')
    expect(slots('Dir')).toBe('')
    expect(slots('Color')).toBe('i32 i32 i32')
    expect(slots('Json')).toBe('i64 i32')
    expect(slots('Shape')).toBe('i32 i32 f32')
    expect(slots('Num')).toBe('i64 f32')
    expect(slots('Big')).toBe('i64 i64')
    expect(slots('Paint')).toBe('i32 i32 i32 i32 i32 i32 i32 i32')
    expect(wasmTypes(enumOf(SHAPES, 'Json')).join(' ')).toBe('i32 i64 i32')
    expect(typeRegisters(enumOf(SHAPES, 'Paint'))).toBe(9)
  })

  test('the layout of 4.1: the tag, the largest payload, no alignment', () => {
    const size = (name: string) => byteSize(enumOf(SHAPES, name))
    expect([size('Dir'), size('Color'), size('Json'), size('Shape'), size('Num'), size('Big'), size('Paint')]).toEqual([1, 5, 9, 13, 9, 17, 11])
    const many = (n: number) => `enum Many { ${Array.from({ length: n }, (_, i) => `V${i}`).join(' ')} }`
    expect(enumLayout(enumOf(many(256), 'Many'))?.tagBytes).toBe(1)
    expect(enumLayout(enumOf(many(257), 'Many'))?.tagBytes).toBe(2)
    expect(byteSize(enumOf(many(257), 'Many'))).toBe(2)
  })

  test('identity is structural, the name aside; the key spells the structure', () => {
    const a = enumOf('enum A { X, Y(v: u8) }', 'A')
    const b = enumOf('enum B { X, Y(v: u8) }', 'B')
    const c = enumOf('enum C { Y(v: u8), X }', 'C')
    const d = enumOf('enum D { X, Y(v: u16) }', 'D')
    expect([typeEquals(a, b), typeEquals(a, c), typeEquals(a, d)]).toEqual([true, false, false])
    expect(canonicalKey(a)).toBe('enum(X,Y(v:u8))')
    expect(canonicalKey(a)).toBe(canonicalKey(b))
    expect(typeToString(a)).toBe('A')
  })

  test('the parts of 2.12: the enum 1, each variant 1, each field what it counts', () => {
    expect(typeParts(enumOf(SHAPES, 'Dir'))).toBe(5)
    expect(typeParts(enumOf(SHAPES, 'Color'))).toBe(17)
  })

  test('a type that refers to itself through a pointer compares as the others', () => {
    const tree = (name: string) => enumOf(`enum ${name} { Leaf(value: i32), Node(left: *${name}, right: *${name}) }`, name) as ResolvedType
    expect(typeEquals(tree('T1'), tree('T2'))).toBe(true)
    expect(canonicalKey(tree('T1'))).toBe(canonicalKey(tree('T2')))
  })
})

describe('enum declarations', () => {
  test('the running examples are accepted', () => {
    const source = `${COLOR}${JSON_ENUM}enum Dir { North East South West }
type Point = (x: f32, y: f32)
enum Shape { Dot(Point), Circle(at: Point, r: f32), Path([]Point) }
enum Tree { Leaf(value: i32), Node(left: *Tree, right: *Tree) }
type Hue = Color
func f(c: Hue, j: Json, d: Dir, s: Shape, t: Tree) -> Color => c
`
    expect(errors(source)).toEqual([])
  })

  test('each capitalised name is declared once, the first standing (E1)', () => {
    const source = `enum Light { Red, Amber, Green }
enum Color { Red, Blue }
type Amber = u32
type P = (x: i32, y: i32)
type P = (a: u8)
func Vec(comptime T: type) -> type => (p: *T)
type Vec = u32
enum Json { Json }
func f(p: P) -> i32 => p.x
`
    expect(errors(source)).toEqual([
      "2:14 'Red' is already declared (first declared at 1:14)",
      "3:6 'Amber' is already declared (first declared at 1:19)",
      "5:6 'P' is already declared (first declared at 4:6)",
      "7:6 'Vec' is already declared (first declared at 6:6)",
      "8:13 'Json' is already declared (first declared at 8:6)",
    ])
  })

  test('E1 is said before anything else the module has wrong', () => {
    expect(errors('func f(x: Nope) -> u32 => 0\nenum A { X }\nenum B { X }\n')).toEqual([
      "3:10 'X' is already declared (first declared at 2:10)",
      "1:11 unknown type 'Nope'",
    ])
  })

  test('an enum whose variant is refused keeps it, as its structure', () => {
    // The pattern finds Red in B, though the name Red is A's.
    const source = `enum A { Red }
enum B { Red, Blue }
func f(b: B) -> u32 => match b {
  Red => 1
  Blue => 2
}
func g() -> A => Red
`
    expect(errors(source)).toEqual(["2:10 'Red' is already declared (first declared at 1:10)"])
  })

  test('what is wrong in a declaration (E2 to E7)', () => {
    const source = `enum Never {}
enum Bad { A(x: Nope) }
enum Twice { Rgb(r: u8, r: u8) }
enum List { Nil, Cons(i32, List) }
type Pair = (l: List2, n: u32)
enum List2 { Nil2, More(Pair) }
type Canvas = host
enum Pen { Draw(Canvas) }
enum Call { Fn((u32) -> u32) }
enum Later { Hold(Box) }
type Box = (c: Canvas2)
type Canvas2 = host
`
    expect(errors(source)).toEqual([
      "1:6 enum 'Never' has no variants",
      "2:17 unknown type 'Nope'",
      "3:25 Rgb: field 'r' is declared twice",
      "4:1 type 'List' contains itself: a type can only refer to itself through a pointer or a slice",
      "6:1 type 'List2' contains itself: a type can only refer to itself through a pointer or a slice",
      '8:17 an enum payload cannot hold a host reference yet: Canvas, in Draw',
      '9:16 an enum payload cannot hold a function yet: (u32) -> u32, in Fn',
      '10:19 an enum payload cannot hold a host reference yet: Canvas2, in Hold',
    ])
  })

  test('a type parameter cannot take a variant\'s name (E9)', () => {
    expect(errors('enum Color { Red }\nfunc id(comptime Red: type, x: Red) -> Red => x\nfunc Box(comptime Red: type) -> type => (v: Red)\n')).toEqual([
      // A generic type's parameters are checked first (pass 1).
      "3:10 type parameter 'Red' has the name of a variant declared in this module",
      "2:9 type parameter 'Red' has the name of a variant declared in this module",
    ])
  })

  test('a variant is no type, no enum is optional, and no null-terminated array holds one (E10 to E12)', () => {
    const source = `${COLOR}type Cell = (e: E, n: u16)
enum E { A, B(u8) }
func f(c: Red) -> u32 => 1
func g(c: ?Color) -> u32 => 1
func h(p: *[!]Color, q: *[!]Cell, r: *[2][!]Color) -> u32 => 1
func i(p: *[?]Color, q: *[!]u8) -> u32 => 1
func j(p: *[!]Later) -> u32 => 1
type Later = [2]E
`
    expect(errors(source)).toEqual([
      "12:11 'Red' is a variant of Color, not a type: write Color",
      '13:11 cannot make Color optional: only a pointer, a slice or a host reference has a none',
      '14:12 a null-terminated array of an enum is not supported yet: Color',
      '14:26 a null-terminated array of an enum is not supported yet: Cell holds E',
      '14:42 a null-terminated array of an enum is not supported yet: Color',
      '16:12 a null-terminated array of an enum is not supported yet: Later holds E',
    ])
  })

  test('a def is a number or a bool, never a variant (E13)', () => {
    expect(errors(`${COLOR}def c = Red\ndef g = Grey(3)\n`)).toEqual([
      '10:1 def value must be a number or a bool: Red is a value of the enum Color; use a global',
      '11:1 def value must be a number or a bool: Grey(3) is a value of the enum Color; use a global',
    ])
    // That is its one error: each use of it, typed or not, is a refused value.
    expect(errors(`${COLOR}def k = Red\ndef j: u32 = Red\nfunc f() -> u32 {\n  let a: Color = k\n  let b: u32 = j\n  return j + 1\n}\n`)).toEqual([
      '10:1 def value must be a number or a bool: Red is a value of the enum Color; use a global',
      '11:1 def value must be a number or a bool: Red is a value of the enum Color; use a global',
    ])
  })

  test('the type limit counts an enum, its variants and its fields (E8)', () => {
    // 65535 unit variants, and the enum: 65536 parts, which is the limit
    const variants = (n: number) => Array.from({ length: n }, (_, i) => `V${i}`).join(' ')
    expect(errors(`enum Big { ${variants(65535)} }\n`)).toEqual([])
    expect(errors(`enum Big { ${variants(65536)} }\n`)).toEqual(["1:1 type 'Big' is too large: written out in full it has more than 65536 parts"])
  }, 60000)
})

describe('enum values', () => {
  test('unit variants and constructors, by position, by name and mixed', () => {
    const source = `${COLOR}func paint(level: u8, r: u8, g: u8) -> [4]Color => [Red, Grey(level), Rgb(r, b: 0, g: 0), Rgb(g:, r: 1, b: 2)]
global last: Color = Rgb(1, 2, 3)
global red: Color = Red
global none: Color
`
    expect(errors(source)).toEqual([])
  })

  test('what a constructor is told (E14 to E18)', () => {
    const source = `${COLOR}enum Color2 { Rgb2(r: u8, g: u8, b: u8), Grey2(u8) }
func a() -> Color => Red()
func b() -> Color => Rgb
func c() -> Color => Rgb(1)
func d() -> Color => Rgb(1, 2, x: 3)
func e() -> Color => Rgb(1, r: 2, g: 3)
func f(x: i32) -> Color => Rgb(x, 2, 3)
func g() -> Color => Grey(level: 3)
func h() -> Color2 => Grey2(level: 3)
func i() -> Color => Color
func j() -> Color => Color(1)
func k() -> u32 => Purple(1)
`
    expect(errors(source)).toEqual([
      '11:22 Red is a unit variant: write Red, without parentheses',
      '12:22 Rgb carries a payload: write Rgb(r, g, b)',
      '13:22 Rgb expects 3 fields, got 1: no value for g and b',
      "14:32 field 'x' not found in Rgb, whose fields are r, g and b",
      "15:29 Rgb: field 'r' is given twice",
      '16:32 field r: cannot assign i32 to u8',
      "17:27 field 'level' not found in Grey, whose only field is b",
      "18:29 field 'level' not found in Grey2, whose fields have no names: give the values by position",
      "19:22 'Color' is an enum: a value of it is one of its variants (Red, Blue, Green, Rgb, Hsl, Grey or Darker)",
      "20:22 'Color' is an enum: a value of it is one of its variants (Red, Blue, Green, Rgb, Hsl, Grey or Darker)",
      "21:20 unknown identifier 'Purple'",
    ])
  })

  test('a value is no struct: no members, no destructuring (E23, E24)', () => {
    const source = `${COLOR}func mem(c: Color) -> u8 => c.r
func des(c: Color) -> u32 {
  let (a, b) = c
  return 1
}
`
    expect(errors(source)).toEqual([
      "10:29 no field 'r' on type Color: take a variant apart with match or if let",
      '12:7 cannot destructure non-tuple type: Color',
    ])
  })

  test('== and != compare the enums of unit variants (E19)', () => {
    const source = `${COLOR}enum Dir { North, East, South, West }
func is-north(d: Dir) -> bool => d == North
func ne(d: Dir, e: Dir) -> bool => d != e
func eqc(a: Color, b: Color) -> bool => a == b
`
    expect(errors(source)).toEqual(["13:41 '==' cannot be applied to Color and Color: an enum with a payload is compared with match or if let"])
  })

  test('no other operator, builtin, index, count or condition takes an enum (E20)', () => {
    const source = `enum Dir { North, East, South, West }
func plus(d: Dir) -> u32 { let x = d + 1
 return 0 }
func lt(d: Dir, e: Dir) -> bool => d < e
func neg(d: Dir) -> u32 { let x = -d
 return 0 }
func not(d: Dir) -> bool => !d
func inv(d: Dir) -> u32 { let x = ~d
 return 0 }
func cmp(d: Dir) { d += 1 }
func it(d: Dir) { for i in d { } }
func cond(d: Dir) -> u32 => if d { 1 } else { 0 }
`
    expect(errors(source)).toEqual([
      "2:36 '+' cannot be applied to Dir and int(1)",
      "4:36 '<' cannot be applied to Dir and Dir",
      "5:35 '-' needs a number, not Dir",
      "7:30 operand of '!' must be bool, not Dir",
      "8:35 '~' needs an integer, not Dir",
      "10:20 '+=' cannot be applied to Dir and int(1)",
      '11:28 cannot iterate over Dir: use a count, a slice, or a pointer to a fixed-size array',
      '12:32 condition must be bool, not Dir',
    ])
  })

  test('no cast takes or gives an enum; pointers to enums cast as any pointer (E21, E22)', () => {
    const source = `${COLOR}enum Dir { North, East }
func a(c: Color) -> u32 => c as u32
func b() -> Dir => 3 as Dir
func c(c: Color) -> Color => c as Color
func tag-of(p: *Color) -> u8 => (p as *u8).*
func at(a: u32) -> *Color => a as *Color
func bytes(p: *mut Color) -> [*]mut u8 => p as [*]mut u8
`
    expect(errors(source)).toEqual([
      '11:28 cannot cast Color to u32: an enum is no number; match on it',
      '12:20 cannot cast int(3) to Dir: an enum value is made by naming its variant',
    ])
  })

  test('an argument that names a variant is a value, not a type', () => {
    // The calls fail (too many arguments); the names in them are still
    // recorded as uses, and are said as values.
    const source = `${COLOR}enum Paint { None, Solid(Color), Mix(Color, Color) }
func show(p: Paint) -> u32 => 1
func g() -> u32 => show(Solid(Red), 1)
func h() -> u32 => show((Red, Blue), 1)
func id(comptime T: type, x: T) -> T => x
func i() -> Color => id(Red, 1)
`
    const result = check(source)
    expect(errors(source)).toEqual([
      "12:20 'show' expected 1 argument, got 2",
      "13:20 'show' expected 1 argument, got 2",
      '13:25 argument 1: cannot assign (Color, Color) to Paint',
      "15:25 argument 1 of 'id' must be a type: T is a type parameter",
    ])
    const uses = (name: string, line: number) => {
      const lineStart = source.split('\n').slice(0, line - 1).join('\n').length + 1
      const at = source.indexOf(name, lineStart)
      return result.symbolRefs.has(at)
    }
    expect([uses('Solid', 12), uses('Red', 12), uses('Red', 13), uses('Blue', 13)]).toEqual([true, true, true, true])
  })

  test('a type name is a method call\'s receiver where the parameter is a type', () => {
    const source = `${COLOR}type Point = (x: i32, y: i32)
func size(comptime T: type) -> u32 => sizeof(T)
func light(c: Color) -> u8 => 1
func length(p: Point) -> i32 => p.x
func a() -> u32 => Point.size()
func b() -> u32 => Color.size()
func c() -> u8 => Red.light()
func d() -> u8 => Color.light()
func e() -> i32 => Point.length()
`
    expect(errors(source)).toEqual([
      "17:19 'Color' is an enum: a value of it is one of its variants (Red, Blue, Green, Rgb, Hsl, Grey or Darker)",
      "18:20 'Point' is a type; a type can only be passed for a comptime parameter",
    ])
  })

  test('an enum is a type argument, and a generic constructs no enum', () => {
    const source = `${COLOR}func first-or(comptime T: type, xs: []T, d: T) -> T => xs[0] ?? d
func make(comptime T: type) -> T => T(1, 2)
func f(cs: []Color) -> Color => first-or(cs, Blue)
func g() -> Color => make(Color)
`
    expect(errors(source)).toEqual([
      "11:37 'Color' is an enum: a value of it is one of its variants (Red, Blue, Green, Rgb, Hsl, Grey or Darker), in make(T = Color)",
    ])
  })

  test('two enums alike are one type, whatever their names; unlike, two', () => {
    const source = `enum A { X, Y(u8) }
type B = A
func f(a: A) -> B => a
`
    expect(errors(source)).toEqual([])
  })
})

describe('match on an enum', () => {
  test('every pattern form, an arm of several patterns, a _ arm', () => {
    const source = `${COLOR}func red-part(c: Color) -> u8 => match c {
  Red => 255
  Rgb(r, _, _) => r
  Grey(b) => b
  _ => 0
}
func light(c: Color) -> u8 => match c {
  Red, Blue, Green => 128
  Rgb(r:, g:, b:) => max(r, max(g, b))
  Hsl(l:) => l
  Grey(b) => b
  Darker(c: inner) => light(inner.*) / 2
}
func any(c: Color) -> u8 => match c {
  Rgb => 1
  Red, _ => 2
}
`
    expect(errors(source)).toEqual([])
  })

  test('a match misses no variant (E25)', () => {
    expect(errors(`${COLOR}func f(c: Color) -> u8 => match c {\n  Red => 1\n  Grey(b) => b\n}\n`)).toEqual([
      '10:27 match on Color does not handle Blue, Green, Rgb, Hsl and Darker: add an arm for each, or a _ arm',
    ])
  })

  test('each refused pattern is one error, and its names say nothing more (E26 to E38)', () => {
    const source = `${COLOR}enum Color2 { Rgb2(r: u8, g: u8, b: u8), Grey2(u8) }
func errs(c: Color, n: u8) -> u8 => match c {
  North => 1
  Grey(0) => 2
  Rgb(r, b:) => r
  Rgb(r, g) => r + g
  Red(x) => x
  Hsl(x: q) => q
  Hsl(h:, h:) => h
  Rgb(r, g, b), Hsl(r, g, b) => r
  Darker(c) => 3
  n => n
  q => q + 1
  0 => 1
  _ => 0
}
func pos(c: Color2) -> u8 => match c {
  Grey2(level: x) => x
  _ => 0
}
`
    expect(errors(source)).toEqual([
      "12:3 Color has no variant 'North': its variants are Red, Blue, Green, Rgb, Hsl, Grey and Darker",
      '13:3 a part of a variant pattern is a name or _: compare the value in the arm',
      '14:3 a variant pattern takes its parts all by position or all by name',
      '15:3 Rgb has 3 fields, but the pattern has 2: give each a name or _',
      '16:3 Red is a unit variant: its pattern is Red, without parentheses',
      "17:3 field 'x' not found in Hsl, whose fields are h, s and l",
      "18:3 Hsl: field 'h' is given twice",
      '19:3 an arm of several patterns binds no names: give Rgb(r, g, b) an arm of its own',
      "20:3 'c' is already declared: a match binding cannot reuse the name of a parameter (first declared at 11:11)",
      "21:3 'n' is already declared: a match binding cannot reuse the name of a parameter (first declared at 11:21)",
      '22:3 a name as the whole pattern is not implemented: write _ and use the subject',
      '23:3 cannot match Color against int(0)',
      "27:3 field 'level' not found in Grey2, whose fields have no names: give the parts by position",
    ])
  })

  test('the names of a refused pattern are refused values in every use', () => {
    const source = `${COLOR}func take(x: u8) -> u8 => x
func f(c: Color) -> u8 {
  let total: u8 = 0
  match c {
    Grey(0, k) => { total = k
 total += k
 return take(k) + k }
    _ => {}
  }
  return total
}
`
    expect(errors(source)).toEqual(['14:5 a part of a variant pattern is a name or _: compare the value in the arm'])
  })

  test('#51: a variant pattern on a value that is no enum is an error', () => {
    const source = `type P = (x: i32, y: i32)
func f(p: P) -> i32 => match p {
  P(0, 0) => 1
  _ => 0
}
func g(x: u32) -> u32 => match x {
  Foo => 1
  Bar(y) => y
  _ => 2
}
func h(p: *Color) -> u8 => match p {
  Grey(b) => b
  _ => 0
}
${COLOR}`
    expect(errors(source)).toEqual([
      '3:3 match cannot compare a struct pattern yet: compare one field at a time',
      '7:3 cannot match u32 against the variant pattern Foo: only an enum has variants',
      '8:3 cannot match u32 against the variant pattern Bar: only an enum has variants',
      '12:3 cannot match *Color against the variant pattern Grey: match what it points to, p.*',
    ])
  })

  test('a variant pattern on a subject whose type is unknown or declared twice says nothing more', () => {
    // The unknown type is the one error, and so is the name declared twice
    expect(errors('func f(c: Colour) -> u32 => match c { Red => 1, Blue => 2 }\nfunc g(c: Colour) -> u8 => if let Rgb(r, g, b) = c { r } elif let Hsl(h, s, l) = c { h } else { 0 }\n')).toEqual([
      "1:11 unknown type 'Colour'",
      "2:11 unknown type 'Colour'",
    ])
    expect(errors('type P = (x: u32)\nenum P { A, B }\nfunc f(p: P) -> u32 => match p { A => 1, B => 2 }\nfunc g(p: P) -> u32 => if let A = p { 1 } else { 0 }\n')).toEqual([
      "2:6 'P' is already declared (first declared at 1:6)",
    ])
    expect(errors('type Vec = (a: u32)\nfunc Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32)\nfunc f(v: *Vec(u32), w: Vec) -> u32 => v.len + w.a\n')).toEqual([
      "2:6 'Vec' is already declared (first declared at 1:6)",
    ])
  })

  test("a type's name as a value is one error wherever a constant is wanted", () => {
    expect(errors(`${COLOR}type Point = (x: f32, y: f32)
global origin: Point = Point
global pair: (Point, u32) = (Point, 1)
data corners: *[1]Point = [Point]
def unit: u32 = Point
global shade: Color = Color
func a() -> *Point => &Point
func b(ps: []Point) -> []Point => ps[Point..]
`).map((e) => e.replace(/ — .*/, ''))).toEqual([
      "11:24 'Point' is a type; a type can only be passed for a comptime parameter",
      "12:30 'Point' is a type; a type can only be passed for a comptime parameter",
      "13:28 'Point' is a type; a type can only be passed for a comptime parameter",
      "14:17 'Point' is a type; a type can only be passed for a comptime parameter",
      "15:23 'Color' is an enum: a value of it is one of its variants (Red, Blue, Green, Rgb, Hsl, Grey or Darker)",
      "16:24 'Point' is a type; a type can only be passed for a comptime parameter",
      "17:38 'Point' is a type; a type can only be passed for a comptime parameter",
    ])
  })

  test('a name as the whole pattern is refused on every subject', () => {
    expect(errors('func f(x: u32) -> u32 => match x {\n  n => 1\n}\n')).toEqual([
      '2:3 a name as the whole pattern is not implemented: write _ and use the subject',
    ])
  })

  test('a name as the whole pattern on an enum is that one error: what the arms cover is not known', () => {
    expect(errors(`${COLOR}func f(c: Color) -> u32 => match c {\n  Red => 1\n  x => 2\n}\n`)).toEqual([
      '12:3 a name as the whole pattern is not implemented: write _ and use the subject',
    ])
  })

  test('a name bound twice in one pattern is refused, and declared once as a refused value', () => {
    const source = `${COLOR}func f(c: Color) -> u8 => match c {
  Rgb(r, r, _) => r + 1
  _ => 0
}
func g(c: Color) -> u8 => if let Hsl(h:, s: h) = c { h } else { 0 }
func h(c: Color) -> u8 => if let Hsl(h, s: h) = c { h } else { 0 }
`
    expect(errors(source)).toEqual([
      "11:3 'r' is already declared: a match binding cannot reuse the name of another in its pattern (first declared at 11:7)",
      "14:27 'h' is already declared: an if let binding cannot reuse the name of another in its pattern (first declared at 14:38)",
      '15:27 a variant pattern takes its parts all by position or all by name',
    ])
  })

  test('a part named as a variable in scope is that one error, and its uses are its own', () => {
    const source = `${COLOR}func f(b: [2]u8, c: Color) -> bool => if let Grey(b) = c { b == 1 } else { false }
func g(b: [2]u8, c: Color) -> bool => match c {
  Grey(b:) => b == 1
  Rgb(_, _, b) => b == 2
  _ => false
}
func h(c: Color) -> bool {
  let r: [2]u8 = [1, 2]
  return if let Rgb(r:, g:, b:) = c { r + g + b == 3 } else { false }
}
`
    expect(errors(source)).toEqual([
      "10:39 'b' is already declared: an if let binding cannot reuse the name of a parameter (first declared at 10:8)",
      "12:3 'b' is already declared: a match binding cannot reuse the name of a parameter (first declared at 11:8)",
      "13:3 'b' is already declared: a match binding cannot reuse the name of a parameter (first declared at 11:8)",
      "18:10 'r' is already declared: an if let binding cannot reuse the name of a variable in scope (first declared at 17:7)",
    ])
  })

  test('a match whose every arm returns returns, with every variant handled', () => {
    const source = `enum Dir { North, East, South, West }
func code(d: Dir) -> u32 {
  match d {
    North => { return 1 }
    East => { return 2 }
    South, West => { return 3 }
  }
}
`
    expect(errors(source)).toEqual([])
  })

  test('a variant pattern in a generic is checked in each instance', () => {
    const source = `${COLOR}func pick(comptime T: type, x: T) -> u32 => match x {
  Red => 1
  _ => 0
}
func a(c: Color) -> u32 => pick(c)
func b(n: u32) -> u32 => pick(n)
`
    expect(errors(source)[0]).toBe('11:3 cannot match u32 against the variant pattern Red: only an enum has variants, in pick(T = u32)')
  })
})

describe('if let and elif let on an enum', () => {
  test('each pattern form', () => {
    const source = `${COLOR}func grey-of(c: Color) -> u8 => if let Grey(b) = c { b } elif let Rgb(g:) = c { g } else { 0 }
func red(c: Color) -> bool => if let Red = c { true } else { false }
func at(p: *Color) -> bool => if let Rgb = p.* { true } else { false }
func parts(c: Color) -> u8 => if let Hsl(h, _, l) = c { h + l } else { 0 }
`
    expect(errors(source)).toEqual([])
  })

  test('what an if let is told (E27, E28, E38 to E40)', () => {
    const source = `${COLOR}type P = (x: i32, y: i32)
func f(c: Color, x: u32, p: P) -> u32 {
  if let c2 = c { return 1 }
  if let Foo = x { return 2 }
  if let P(a, b) = p { return 3 }
  if let 0 = x { return 4 }
  if let Grey(c) = c { return 5 }
  if let North = c { return 6 }
  return 0
}
`
    expect(errors(source)).toEqual([
      '12:3 if let requires an optional expression or bounds-checked index: Color is an enum, taken apart with a variant pattern, if let Red = c',
      '13:3 cannot match u32 against the variant pattern Foo: only an enum has variants',
      '14:3 if let cannot compare a struct pattern yet: take it apart with let (a, b) = p',
      '15:3 if let takes a name, or a variant pattern of an enum',
      "16:3 'c' is already declared: an if let binding cannot reuse the name of a parameter (first declared at 11:8)",
      "17:3 Color has no variant 'North': its variants are Red, Blue, Green, Rgb, Hsl, Grey and Darker",
    ])
  })

  test('a value that needs its index checked is not resolved by a variant pattern', () => {
    const source = `${COLOR}func f(xs: []Color, i: u32) -> u8 {
  if let Grey(b) = xs[i] { return b }
  if let c = xs[i] { if let Grey(b) = c { return b } }
  return 0
}
`
    expect(errors(source)).toEqual(["11:23 runtime index on []Color requires 'if let' or '??' (no optional type for Color)"])
  })
})

// === The wasm an enum compiles to ===

function wat(source: string): string {
  const parsed = parse(source)
  if (parsed.errors.length > 0) throw new Error(`Parse error: ${parsed.errors[0].message}`)
  const result = typecheck(parsed.module!, { source })
  if (result.errors.length > 0) throw new Error(`Check error: ${result.errors.map((e) => e.message).join('; ')}`)
  return moduleToWat(parsed.module!, result)
}

// One function or global of a module's WAT, as the compiler writes it, its
// lines trimmed
function watOf(source: string, start: string): string {
  const text = wat(source)
  const at = text.indexOf(start)
  if (at < 0) throw new Error(`no ${start} in\n${text}`)
  let depth = 0
  for (let i = at; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return text.slice(at, i + 1).split('\n').map((l) => l.trim()).join('\n')
  }
  throw new Error('unbalanced')
}

async function binary(source: string): Promise<Uint8Array> {
  const { default: wabt } = await import('wabt')
  const module = (await wabt()).parseWat('test.wat', wat(source), { multi_value: true, bulk_memory: true })
  module.validate()
  const { buffer } = module.toBinary({})
  module.destroy()
  return buffer
}

async function instance(source: string, imports: WebAssembly.Imports = {}): Promise<Record<string, unknown>> {
  const { instance } = await WebAssembly.instantiate(await binary(source), imports)
  return instance.exports as Record<string, unknown>
}

const lines = (...ls: string[]) => ls.join('\n')

describe('an enum in registers (3.1 to 3.4)', () => {
  const SOURCE = `${COLOR}${JSON_ENUM}type Point = (x: f32, y: f32)
enum Shape { Dot(Point), Circle(at: Point, r: f32), Path([]Point) }
enum Paint { None, Solid(Color), Mix(Color, Color) }
enum Dir { North, East, South, West }
export func grey(level: u8) -> Color => Grey(level)
export func red() -> Color => Red
export func number(x: f64) -> Json => Number(x)
export func flag(b: bool) -> Json => Boolean(b)
export func text(s: []u8) -> Json => String(s)
export func disk(p: Point, r: f32) -> Shape => Circle(p, r)
func make-color() -> Color => Grey(3)
func make-point() -> Point => (1.0, 2.0)
export func solid() -> Paint => Solid(make-color())
export func dot() -> Shape => Dot(make-point())
export func is-north(d: Dir) -> bool => d == North
global last: Json = Number(1.5)
global start: Shape = Dot((1.0, 2.0))
global none: Json
enum M { A(i32), B(f64) }
global minus: M = A(-1)
`

  test('building a variant: its tag, its payload in its slots, zeros', () => {
    expect(watOf(SOURCE, '(func $grey')).toBe(lines('(func $grey (param $level i32) (result i32 i32 i32 i32)', '(i32.const 5) (local.get $level) (i32.const 0) (i32.const 0)', ')'))
    expect(watOf(SOURCE, '(func $red')).toBe(lines('(func $red  (result i32 i32 i32 i32)', '(i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)', ')'))
    expect(watOf(SOURCE, '(func $number')).toBe(lines('(func $number (param $x f64) (result i32 i64 i32)', '(i32.const 2) (i64.reinterpret_f64 (local.get $x)) (i32.const 0)', ')'))
    expect(watOf(SOURCE, '(func $flag')).toBe(lines('(func $flag (param $b i32) (result i32 i64 i32)', '(i32.const 1) (i64.extend_i32_u (local.get $b)) (i32.const 0)', ')'))
    expect(watOf(SOURCE, '(func $text')).toBe(lines('(func $text (param $s_ptr i32) (param $s_len i32) (result i32 i64 i32)', '(i32.const 3) (i64.extend_i32_u (local.get $s_ptr)) (local.get $s_len)', ')'))
    expect(watOf(SOURCE, '(func $disk')).toBe(lines('(func $disk (param $p_x f32) (param $p_y f32) (param $r f32) (result i32 i32 i32 f32)', '(i32.const 1) (i32.reinterpret_f32 (local.get $p_x)) (i32.reinterpret_f32 (local.get $p_y)) (local.get $r)', ')'))
    expect(watOf(SOURCE, '(func $is-north')).toBe(lines('(func $is-north (param $d i32) (result i32)', '(i32.eq (local.get $d) (i32.const 0))', ')'))
  })

  test('a payload computed whole goes through scratch locals only where a value is converted', () => {
    expect(watOf(SOURCE, '(func $solid')).toBe(lines('(func $solid  (result i32 i32 i32 i32 i32 i32 i32 i32 i32)', '(i32.const 1) (call $make-color) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)', ')'))
    expect(watOf(SOURCE, '(func $dot')).toBe(lines(
      '(func $dot  (result i32 i32 i32 f32)',
      '(local $__tmp_0 f32)',
      '(local $__tmp_1 f32)',
      '(i32.const 0) (call $make-point)',
      '(local.set $__tmp_1)',
      '(local.set $__tmp_0)',
      '(i32.reinterpret_f32 (local.get $__tmp_0)) (i32.reinterpret_f32 (local.get $__tmp_1)) (f32.const 0)',
      ')',
    ))
  })

  test('a global holds the exact bits a value has at run time', () => {
    const text = wat(SOURCE)
    const globals = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('(global'))
    expect(globals).toEqual([
      '(global $last_tag (mut i32) (i32.const 2))',
      '(global $last_0 (mut i64) (i64.const 4609434218613702656))',
      '(global $last_1 (mut i32) (i32.const 0))',
      '(global $start_tag (mut i32) (i32.const 0))',
      '(global $start_0 (mut i32) (i32.const 1065353216))',
      '(global $start_1 (mut i32) (i32.const 1073741824))',
      '(global $start_2 (mut f32) (f32.const 0))',
      '(global $none_tag (mut i32) (i32.const 0))',
      '(global $none_0 (mut i64) (i64.const 0))',
      '(global $none_1 (mut i32) (i32.const 0))',
      '(global $minus_tag (mut i32) (i32.const 0))',
      '(global $minus_0 (mut i64) (i64.const 4294967295))',
    ])
  })

  test('an enum costs nothing: the same module as its registers written out', async () => {
    const same = async (a: string, b: string) => expect(Buffer.from(await binary(a)).equals(Buffer.from(await binary(b)))).toBe(true)
    await same(`${COLOR}export func grey(level: u8) -> Color => Grey(level)\n`, 'export func grey(level: u8) -> (u32, u32, u32, u32) => (5, level, 0, 0)\n')
    await same('enum M { A(i32), B(f64) }\nexport global g: M = A(-1)\n', 'export global g_tag: u32 = 0\nexport global g_0: u64 = 4294967295\n')
  })

  test('a host reads one value one way: the global and the result of A(-1) hold the same bits', async () => {
    const exports = await instance('enum M { A(i32), B(f64) }\nexport global g: M = A(-1)\nexport func h(x: i32) -> M => A(x)\n')
    const g0 = (exports.g_0 as WebAssembly.Global).value
    const [tag, slot] = (exports.h as (x: number) => [number, bigint])(-1)
    expect([tag, slot, g0]).toEqual([0, 4294967295n, 4294967295n])
  })

  test('a payload the compiler works out is folded to constants in a global, whatever its slot', async () => {
    const source = `${COLOR}enum M { A(i32), B(f64), L(u128), U(u32) }
type Px = (c: Color, a: u8)
enum Paint { None, Solid(Color) }
def k = 7
export global c: Color = Grey(3 + 4)
export global a: M = A(k * -1000)
export global f: M = B(1.5 * 2.0)
export global w: M = L(1 << 100)
export global s: M = U(sizeof(u32))
export global px: Px = Px(Grey(1 + 1), 2)
export global p: Paint = Solid(Grey(k + 1))
export global xs: [2]Color = [Grey(0x0f & 0x3), Red]
def k32: u32 = 5
data buf = [1:u8, 2, 3]
export global ps: M = U((sizeof(u32)))
export global pl: M = L((buf.len))
export global pk: M = B(((k32)))
export global pa: M = L((5:u32))
export global plain: u64 = (sizeof(u32))
export global wide: u128 = ((k32))
export global sum: u64 = (sizeof(u32) + 116)
export global sums: [2]i64 = [(0 - 1), (sizeof(u32) + 116)]
export global ps2: M = L((sizeof(u32) + 1))
`
    const globals = wat(source).split('\n').filter((l) => l.trim().startsWith('(global'))
    // Each initializer is one constant instruction
    for (const g of globals) expect(g).toMatch(/^ *\(global \$\S+ \(mut [if](32|64)\) \([if](32|64)\.const [^\s()]+\)\)$/)
    const exports = await instance(source)
    const value = (name: string) => (exports[name] as WebAssembly.Global).value
    expect(['c_tag', 'c_0', 'a_tag', 'a_0', 'f_0', 'w_tag', 'w_0', 'w_1', 's_0', 'px_c_0', 'px_a', 'p_tag', 'p_0', 'p_1', 'xs_0_0'].map(value))
      .toEqual([5, 7, 0, 4294960296n, 0x4008000000000000n, 2, 0n, 1n << 36n, 4n, 2, 2, 1, 5, 8, 3])
    // Parentheses are their value, which widens as it would without them.
    expect(['ps_0', 'pl_0', 'pl_1', 'pk_0', 'pa_0', 'plain', 'wide_0', 'wide_1'].map(value))
      .toEqual([4n, 3n, 0n, 0x4014000000000000n, 5n, 4n, 5n, 0n])
    // ...also where they widen as a whole, a sum in parentheses
    expect(['sum', 'sums_0', 'sums_1', 'ps2_0', 'ps2_1'].map(value)).toEqual([120n, -1n, 120n, 5n, 0n])
  })

  test('enums in structs, arrays, instances and branches are their registers', () => {
    const source = `${COLOR}type Px = (c: Color, a: u8)
export func col(p: Px) -> Color => p.c
func id(comptime T: type, x: T) -> T => x
export func viaid(c: Color) -> Color => id(c)
`
    expect(watOf(source, '(func $col')).toBe(lines(
      '(func $col (param $p_c_tag i32) (param $p_c_0 i32) (param $p_c_1 i32) (param $p_c_2 i32) (param $p_a i32) (result i32 i32 i32 i32)',
      '(local.get $p_c_tag) (local.get $p_c_0) (local.get $p_c_1) (local.get $p_c_2)',
      ')',
    ))
    // An instance's name spells its enum argument's structure.
    expect(wat(source)).toContain('(func $id<enum<Red|Blue|Green|Rgb<r:u8|g:u8|b:u8>|')
  })
})

describe('an enum in memory (4.1 to 4.6)', () => {
  const SOURCE = `${COLOR}enum Dir { North, East, South, West }
type Pixel = (c: Color, a: u8)
export func load(p: *Color) -> Color => p.*
export func load-dir(p: *Dir) -> Dir => p.*
export func put(p: *mut Color, k: u8) { p.* = Grey(k) }
export func copy(p: *mut Color, c: Color) { p.* = c }
export func load-px(q: *Pixel) -> Pixel => q.*
export func store-px(q: *mut Pixel, px: Pixel) { q.* = px }
export func put-px(q: *mut Pixel, k: u8) { q.* = Pixel(Grey(k), 9) }
func make-px() -> Pixel => Pixel(Rgb(1, 2, 3), 4)
export func call-px(q: *mut Pixel) { q.* = make-px() }
export func clear(xs: *mut [4]Color) { xs[..] = Red }
export func greys(xs: *mut [4]Color, k: u8) { xs[..] = Grey(k) }
export func fill(xs: *mut [4]Color, c: Color) { xs[..] = c }
export func zero(p: *mut Color) { p.* = Red }
export func size() -> u32 => sizeof(Color) + sizeof(Pixel) * 10
export memory 1
`

  const LOAD = [
    '(local.tee $__tmp_0 (i32.load8_u (local.get $p)))',
    '(if (result i32 i32 i32) (i32.eq (local.get $__tmp_0) (i32.const 3))',
    '(then (i32.load8_u offset=1 (local.get $p)) (i32.load8_u offset=2 (local.get $p)) (i32.load8_u offset=3 (local.get $p)))',
    '(else (if (result i32 i32 i32) (i32.eq (local.get $__tmp_0) (i32.const 4))',
    '(then (i32.load8_u offset=1 (local.get $p)) (i32.load8_u offset=2 (local.get $p)) (i32.load8_u offset=3 (local.get $p)))',
    '(else (if (result i32 i32 i32) (i32.eq (local.get $__tmp_0) (i32.const 5))',
    '(then (i32.load8_u offset=1 (local.get $p)) (i32.const 0) (i32.const 0))',
    '(else (if (result i32 i32 i32) (i32.eq (local.get $__tmp_0) (i32.const 6))',
    '(then (i32.load offset=1 (local.get $p)) (i32.const 0) (i32.const 0))',
    '(else (i32.const 0) (i32.const 0) (i32.const 0)))))))))',
  ]
  const STORE = (p: string, reg: (n: string) => string) => [
    `(i32.store8 (local.get ${p}) ${reg('tag')})`,
    `(if (i32.eq ${reg('tag')} (i32.const 3))`,
    `(then (i32.store8 offset=1 (local.get ${p}) ${reg('0')}) (i32.store8 offset=2 (local.get ${p}) ${reg('1')}) (i32.store8 offset=3 (local.get ${p}) ${reg('2')}))`,
    `(else (if (i32.eq ${reg('tag')} (i32.const 4))`,
    `(then (i32.store8 offset=1 (local.get ${p}) ${reg('0')}) (i32.store8 offset=2 (local.get ${p}) ${reg('1')}) (i32.store8 offset=3 (local.get ${p}) ${reg('2')}))`,
    `(else (if (i32.eq ${reg('tag')} (i32.const 5))`,
    `(then (i32.store8 offset=1 (local.get ${p}) ${reg('0')}))`,
    `(else (if (i32.eq ${reg('tag')} (i32.const 6))`,
    `(then (i32.store offset=1 (local.get ${p}) ${reg('0')})))))))))`,
  ]

  test('a load reads the tag, then the fields of the variant it names', () => {
    expect(watOf(SOURCE, '(func $load ')).toBe(lines('(func $load (param $p i32) (result i32 i32 i32 i32)', '(local $__tmp_0 i32)', ...LOAD, ')'))
    expect(watOf(SOURCE, '(func $load-dir')).toBe(lines('(func $load-dir (param $p i32) (result i32)', '(i32.load8_u (local.get $p))', ')'))
  })

  test('a store writes the tag and that variant\'s fields, never the padding', () => {
    expect(watOf(SOURCE, '(func $put ')).toBe(lines('(func $put (param $p i32) (param $k i32)', '(i32.store8 (local.get $p) (i32.const 5))', '(i32.store8 offset=1 (local.get $p) (local.get $k))', ')'))
    expect(watOf(SOURCE, '(func $copy')).toBe(lines(
      '(func $copy (param $p i32) (param $c_tag i32) (param $c_0 i32) (param $c_1 i32) (param $c_2 i32)',
      ...STORE('$p', (n) => `(local.get $c_${n})`),
      ')',
    ))
  })

  test('a struct that holds an enum is loaded and stored part by part', () => {
    expect(watOf(SOURCE, '(func $load-px')).toBe(lines(
      '(func $load-px (param $q i32) (result i32 i32 i32 i32 i32)',
      '(local $__tmp_0 i32)',
      ...LOAD.map((l) => l.replaceAll('$p)', '$q)')).map((l, i, all) => (i === all.length - 1 ? `${l} (i32.load8_u offset=5 (local.get $q))` : l)),
      ')',
    ))
    expect(watOf(SOURCE, '(func $store-px')).toBe(lines(
      '(func $store-px (param $q i32) (param $px_c_tag i32) (param $px_c_0 i32) (param $px_c_1 i32) (param $px_c_2 i32) (param $px_a i32)',
      ...STORE('$q', (n) => `(local.get $px_c_${n})`),
      '(i32.store8 offset=5 (local.get $q) (local.get $px_a))',
      ')',
    ))
    expect(watOf(SOURCE, '(func $put-px')).toBe(lines(
      '(func $put-px (param $q i32) (param $k i32)',
      '(i32.store8 (local.get $q) (i32.const 5))',
      '(i32.store8 offset=1 (local.get $q) (local.get $k))',
      '(i32.store8 offset=5 (local.get $q) (i32.const 9))',
      ')',
    ))
    const temps = ['tag', '0', '1', '2'].map((n, i) => [n, `(local.get $__tmp_${i})`])
    expect(watOf(SOURCE, '(func $call-px')).toBe(lines(
      '(func $call-px (param $q i32)',
      ...[0, 1, 2, 3, 4].map((i) => `(local $__tmp_${i} i32)`),
      '(call $make-px)',
      ...[4, 3, 2, 1, 0].map((i) => `(local.set $__tmp_${i})`),
      ...STORE('$q', (n) => Object.fromEntries(temps)[n]),
      '(i32.store8 offset=5 (local.get $q) (local.get $__tmp_4))',
      ')',
    ))
  })

  test('a range fill of enums is a loop of stores, never one memory.fill', () => {
    const clear = watOf(SOURCE, '(func $clear')
    expect(clear).not.toContain('memory.fill')
    expect(clear).toContain('(i32.store8 (local.get $__bulk_p_')
    const greys = watOf(SOURCE, '(func $greys')
    expect(greys).toMatch(/\(local\.get \$k\)\n\(local\.set \$__tmp_0\)\n\(block/)
    expect(greys).toMatch(/\(i32\.store8 \(local\.get \$__bulk_p_\d+\) \(i32\.const 5\)\)\n\(i32\.store8 offset=1 \(local\.get \$__bulk_p_\d+\) \(local\.get \$__tmp_0\)\)/)
  })

  test('the bytes a store leaves, and a tag stored in its width', async () => {
    const exports = await instance(SOURCE)
    const memory = new Uint8Array((exports.memory as WebAssembly.Memory).buffer)
    const call = (name: string, ...args: (number | bigint)[]) => (exports[name] as (...a: (number | bigint)[]) => unknown)(...args)
    // Red stored over Rgb(1, 2, 3) leaves the bytes of the payload.
    call('copy', 100, 3, 1, 2, 3)
    call('zero', 100)
    expect([...memory.slice(100, 105)]).toEqual([0, 1, 2, 3, 0])
    // A host's tag of 259 for a Color is stored as 3, Rgb, and the if for
    // its fields matches no variant: the fields keep what they held.
    memory.set([9, 7, 7, 7, 7], 200)
    call('copy', 200, 259, 1, 2, 3)
    expect([...memory.slice(200, 205)]).toEqual([3, 7, 7, 7, 7])
    // A fill over 0xff bytes leaves their padding.
    memory.fill(0xff, 300, 320)
    call('clear', 300)
    expect([...memory.slice(300, 310)]).toEqual([0, 0xff, 0xff, 0xff, 0xff, 0, 0xff, 0xff, 0xff, 0xff])
    call('greys', 300, 7)
    expect([...memory.slice(300, 305)]).toEqual([5, 7, 0xff, 0xff, 0xff])
    call('fill', 300, 3, 1, 2, 3)
    expect([...memory.slice(315, 320)]).toEqual([3, 1, 2, 3, 0xff])
    // A load after a store gives the value; a struct that holds one too.
    call('put', 400, 42)
    expect(call('load', 400)).toEqual([5, 42, 0, 0])
    call('put-px', 410, 8)
    expect(call('load-px', 410)).toEqual([5, 8, 0, 0, 9])
    call('call-px', 420)
    expect(call('load-px', 420)).toEqual([3, 1, 2, 3, 4])
    expect(call('size')).toBe(5 + 6 * 10)
  })

  test('data lays out each variant: its tag, its fields, zeros for the padding', () => {
    const source = `${COLOR}${JSON_ENUM}enum Dir { North, East }
data palette: *[3]Color = [Red, Rgb(10, 20, 30), Grey(7)]
data doc: *[2]Json = [String("hi"), Number(1.5)]
data spot = mut [Red]
data xs: *[?]Dir = [North, East]
`
    const text = wat(source)
    expect(text).toContain('"\\00\\00\\00\\00\\00\\03\\0a\\14\\1e\\00\\05\\07")  ;; palette: *[3]Color')
    expect(text).toMatch(/\(data \(i32\.const (\d+)\) "hi"\)\n\s*\(data \(i32\.const \d+\) "\\03\\(..)\\00\\00\\00\\02\\00\\00\\00\\02\\00\\00\\00\\00\\00\\00\\f8\?"\)  ;; doc: \*\[2\]Json/)
    expect(text).toContain('"\\02\\00\\01")  ;; xs: *[?]Dir')
    expect(text).toContain('spot: *mut [1]Color')
    // An f32 given for an f64 field is the f32 widened, as in a register
    expect(wat('enum V { Z, D(f64) }\ndef t: f32 = 0.1\ndata d: *[3]V = [D(t), D((t)), D(-t)]\n'))
      .toContain('"\\01\\00\\00\\00\\a0\\99\\99\\b9?\\01\\00\\00\\00\\a0\\99\\99\\b9?\\01\\00\\00\\00\\a0\\99\\99\\b9\\bf")  ;; d: *[3]V')
  })
})

describe('match, if let and elif let on an enum (5.1 to 5.8)', () => {
  const SOURCE = `${COLOR}${JSON_ENUM}enum Dir { North, East, South, West }
export func red-part(c: Color) -> u8 => match c {
  Red => 255
  Rgb(r, _, _) => r
  Grey(b) => b
  _ => 0
}
func pick() -> Json => Number(2.5)
export func as-number(j: Json) -> f64 => match j {
  Number(x) => x
  Boolean(b) => if b { 1.0 } else { 0.0 }
  _ => 0.0
}
export func picked() -> f64 => match pick() {
  Number(x) => x
  _ => 0.0
}
export func turn(d: Dir) -> Dir => match d {
  North => East
  East => South
  South => West
  West => North
}
export func level(p: *Color) -> u8 => match p.* {
  Grey(b) => b
  _ => 0
}
export func grey-of(c: Color) -> u8 => if let Grey(b) = c { b } elif let Rgb(g:) = c { g } else { 0 }
export func is-red-at(p: *Color) -> bool => if let Red = p.* { true } else { false }
export func dir-at(p: *mut u8) -> u32 => match (p as *mut Dir).* {
  North => 1
  East => 2
  South => 3
  West => 4
}
export func dir-or(p: *mut u8) -> u32 => match (p as *mut Dir).* {
  North => 1
  East => 2
  South => 3
  West => 4
  _ => 5
}
export func light(c: Color) -> u8 => match c {
  Red, Blue, Green => 128
  Rgb(r:, g:, b:) => max(r, max(g, b))
  Hsl(l:) => l
  Grey(b) => b
  Darker(c: inner) => light(inner.*) / 2
}
export memory 1
`

  test('the arms are nested ifs on the tag; bindings are set from their slots', () => {
    expect(watOf(SOURCE, '(func $red-part')).toBe(lines(
      '(func $red-part (param $c_tag i32) (param $c_0 i32) (param $c_1 i32) (param $c_2 i32) (result i32)',
      '(local $r i32)',
      '(local $b i32)',
      '(if (result i32) (i32.eq (local.get $c_tag) (i32.const 0))',
      '(then (i32.const 255))',
      '(else (if (result i32) (i32.eq (local.get $c_tag) (i32.const 3))',
      '(then (local.set $r (local.get $c_0)) (local.get $r))',
      '(else (if (result i32) (i32.eq (local.get $c_tag) (i32.const 5))',
      '(then (local.set $b (local.get $c_0)) (local.get $b))',
      '(else (i32.const 0)))))))',
      ')',
    ))
    expect(watOf(SOURCE, '(func $as-number')).toBe(lines(
      '(func $as-number (param $j_tag i32) (param $j_0 i64) (param $j_1 i32) (result f64)',
      '(local $x f64)',
      '(local $b i32)',
      '(if (result f64) (i32.eq (local.get $j_tag) (i32.const 2))',
      '(then (local.set $x (f64.reinterpret_i64 (local.get $j_0))) (local.get $x))',
      '(else (if (result f64) (i32.eq (local.get $j_tag) (i32.const 1))',
      '(then (local.set $b (i32.wrap_i64 (local.get $j_0))) (if (result f64) (local.get $b) (then (f64.const 1)) (else (f64.const 0))))',
      '(else (f64.const 0)))))',
      ')',
    ))
  })

  test('a subject that is no variable is evaluated once, into scratch locals', () => {
    expect(watOf(SOURCE, '(func $picked')).toBe(lines(
      '(func $picked  (result f64)',
      '(local $x f64)',
      '(local $__tmp_0 i32)',
      '(local $__tmp_1 i64)',
      '(local $__tmp_2 i32)',
      '(call $pick)',
      '(local.set $__tmp_2)',
      '(local.set $__tmp_1)',
      '(local.set $__tmp_0)',
      '(if (result f64) (i32.eq (local.get $__tmp_0) (i32.const 2))',
      '(then (local.set $x (f64.reinterpret_i64 (local.get $__tmp_1))) (local.get $x))',
      '(else (f64.const 0)))',
      ')',
    ))
  })

  test('a subject in memory is loaded whole, then matched', () => {
    const level = watOf(SOURCE, '(func $level')
    expect(level).toContain('(local.tee $__tmp_0 (i32.load8_u (local.get $p)))')
    expect(level).toMatch(/\(local\.set \$__tmp_4\)\n\(local\.set \$__tmp_3\)\n\(local\.set \$__tmp_2\)\n\(local\.set \$__tmp_1\)\n\(if \(result i32\) \(i32\.eq \(local\.get \$__tmp_1\) \(i32\.const 5\)\)\n\(then \(local\.set \$b \(local\.get \$__tmp_2\)\) \(local\.get \$b\)\)\n\(else \(i32\.const 0\)\)\)/)
    expect(watOf(SOURCE, '(func $is-red-at')).toContain('(if (result i32) (i32.eq (local.get $__tmp_1) (i32.const 0)) (then (i32.const 1)) (else (i32.const 0)))')
  })

  test('an exhaustive match tests every variant, the last too, and traps on a tag no variant has', () => {
    expect(watOf(SOURCE, '(func $turn')).toContain('(i32.eq (local.get $d) (i32.const 3))\n(then (i32.const 0))\n(else (unreachable))')
    expect(watOf(SOURCE, '(func $grey-of')).toContain('(if (result i32) (i32.eq (local.get $c_tag) (i32.const 5)) (then (local.set $b (local.get $c_0)) (local.get $b)) (else (if (result i32) (i32.eq (local.get $c_tag) (i32.const 3)) (then (local.set $g (local.get $c_1)) (local.get $g)) (else (i32.const 0)))))')
  })

  test('the same modules as the numbers written out', async () => {
    const same = async (a: string, b: string) => expect(Buffer.from(await binary(a)).equals(Buffer.from(await binary(b)))).toBe(true)
    await same(
      'enum Dir { North, East, South, West }\nexport func turn(d: Dir) -> Dir => match d {\n  North => East\n  East => South\n  South => West\n  West => North\n}\n',
      'export func turn(d: u32) -> u32 => match d {\n  0 => 1\n  1 => 2\n  2 => 3\n  3 => 0\n}\n',
    )
    await same(
      `${JSON_ENUM}export func classify(j: Json) -> u32 => match j {\n  Null => 0\n  Number(_) => 1\n  _ => 2\n}\n`,
      'export func classify(tag: u32, a: u64, b: u32) -> u32 => match tag {\n  0 => 0\n  2 => 1\n  _ => 2\n}\n',
    )
  })

  test('a tag no variant has traps in a match, unless a _ arm takes it', async () => {
    const exports = await instance(SOURCE)
    const memory = new Uint8Array((exports.memory as WebAssembly.Memory).buffer)
    const call = (name: string, ...args: (number | bigint)[]) => (exports[name] as (...a: (number | bigint)[]) => unknown)(...args)
    memory[100] = 2
    expect(call('dir-at', 100)).toBe(3)
    memory[100] = 9
    expect(() => call('dir-at', 100)).toThrow()
    expect(call('dir-or', 100)).toBe(5)
    expect(call('red-part', 9, 0, 0, 0)).toBe(0)
    expect(() => call('light', 9, 0, 0, 0)).toThrow()
  })

  test('what each arm gives, run', async () => {
    const exports = await instance(SOURCE)
    const memory = new Uint8Array((exports.memory as WebAssembly.Memory).buffer)
    const call = (name: string, ...args: (number | bigint)[]) => (exports[name] as (...a: (number | bigint)[]) => unknown)(...args)
    expect([call('red-part', 0, 0, 0, 0), call('red-part', 3, 7, 8, 9), call('red-part', 5, 6, 0, 0), call('red-part', 1, 0, 0, 0)]).toEqual([255, 7, 6, 0])
    expect(call('picked')).toBe(2.5)
    expect(call('as-number', 1, 1n, 0)).toBe(1)
    expect([call('turn', 0), call('turn', 3)]).toEqual([1, 0])
    memory.set([5, 33, 0, 0, 0], 200)
    expect(call('level', 200)).toBe(33)
    memory.set([4, 1, 2, 30, 0], 210)
    expect([call('grey-of', 5, 4, 0, 0), call('grey-of', 3, 1, 2, 3), call('grey-of', 0, 0, 0, 0)]).toEqual([4, 2, 0])
    expect([call('is-red-at', 200), call('light', 4, 1, 2, 30)]).toEqual([0, 30])
    memory.set([3, 10, 40, 20, 0], 220)
    expect(call('light', 6, 220, 0, 0)).toBe(20)
  })

  // wabt, which the command line assembles with, reads nested code to a depth
  // of only about 150: a chain of more than 64 tests is one block of ifs.
  test('a load, a store or a match of many tests is flat, and runs', async () => {
    const variants = (n: number) => Array.from({ length: n }, (_, k) => `V${k}(u8)`).join(', ')
    const flat = (source: string, start: string) => watOf(source, start).includes('(block $__tests')
    const at = (n: number) => `enum E { ${variants(n)} }\nexport func ld(p: *E) -> E => p.*\nexport func st(p: *mut E, e: E) { p.* = e }\n`
    expect([flat(at(64), '(func $ld'), flat(at(64), '(func $st')]).toEqual([false, false])
    expect([flat(at(65), '(func $ld'), flat(at(65), '(func $st')]).toEqual([true, true])
    const arms = Array.from({ length: 200 }, (_, k) => `  V${k}(x) => x + ${k}`).join('\n')
    const numbers = Array.from({ length: 200 }, (_, k) => `  ${k} => ${k * 3}`).join('\n')
    const source = `${at(200)}export func code(e: E) -> u32 => match e {\n${arms}\n}\nexport func triple(d: u32) -> u32 => match d {\n${numbers}\n  _ => 7\n}\nexport memory 1\n`
    expect([flat(source, '(func $code'), flat(source, '(func $triple')]).toEqual([true, true])
    const exports = await instance(source)
    const memory = new Uint8Array((exports.memory as WebAssembly.Memory).buffer)
    const call = (name: string, ...args: number[]) => (exports[name] as (...a: number[]) => unknown)(...args)
    memory.set([150, 42], 100)
    expect(call('ld', 100)).toEqual([150, 42])
    memory.set([199, 9], 100)
    expect(call('ld', 100)).toEqual([199, 9])
    memory.fill(0xee, 200, 203)
    call('st', 200, 151, 7)
    expect([...memory.slice(200, 203)]).toEqual([151, 7, 0xee])
    expect([call('code', 0, 5), call('code', 64, 1), call('code', 199, 1)]).toEqual([5, 65, 200])
    expect(() => call('code', 200, 0)).toThrow()
    expect([call('triple', 0), call('triple', 150), call('triple', 199), call('triple', 200)]).toEqual([0, 450, 597, 7])
  })

  test('chains in one another are flat where, nested, they would be too deep together', async () => {
    // A match in the _ arm of a match in the _ arm of another: three chains
    // of 56 tests, 168 ifs one inside another if all were nested.
    const match = (subject: string, base: number, rest: string) =>
      `match ${subject} {\n${Array.from({ length: 56 }, (_, k) => `  V${k} => ${base + k}`).join('\n')}\n  _ => ${rest}\n}`
    const variants = Array.from({ length: 60 }, (_, k) => `V${k}`).join(', ')
    const source = `enum A { ${variants} }\nenum B { ${variants.replace(/V/g, 'W')} }\nenum C { ${variants.replace(/V/g, 'X')} }\n`
      + `export func pick(a: A, b: B, c: C) -> u32 => ${match('a', 0, match('b', 100, match('c', 200, '999').replace(/V(\d+) =>/g, 'X$1 =>')).replace(/V(\d+) =>/g, 'W$1 =>'))}\n`
    const text = watOf(source, '(func $pick')
    // The innermost is nested; each around it would put it more than 100
    // deep, and is flat, the middle one's ifs in the block of the outer one,
    // whose _ arm it is all of
    expect(text.split('(block $__tests').length - 1).toBe(1)
    const exports = await instance(source)
    const pick = exports.pick as (a: number, b: number, c: number) => number
    expect([pick(3, 0, 0), pick(57, 5, 0), pick(57, 58, 55), pick(59, 59, 59)]).toEqual([3, 105, 255, 999])
  })

  // The deepest some WAT nests: ifs, blocks and loops
  const depthOf = (wat: string) => {
    let depth = 0
    let max = 0
    const open: boolean[] = []
    for (let i = 0; i < wat.length; i++) {
      if (wat[i] === '(') {
        const control = /^(?:if|block|loop)\b/.test(wat.slice(i + 1, i + 7))
        open.push(control)
        if (control) max = Math.max(max, ++depth)
      } else if (wat[i] === ')' && open.pop()) depth--
    }
    return max
  }
  const numbered = (n: number, value: (k: number) => string) => Array.from({ length: n }, (_, k) => `${k} => ${value(k)}`).join(' ')

  test('a long chain stays nested where that nests less: its deep code is in its first arm', async () => {
    // A match of 65 arms whose first holds a match of 64: nested, 1 + 64
    // deep; flat, its first arm would be 2 deep (its block and its if)
    const outer = (inner: string) => `match x { 0 => ${inner} ${numbered(64, (k) => `${1000 + k}`).replace(/^0 => 1000 /, '')} 64 => 7 _ => 8 }`
    const inner = `match y { ${numbered(64, (k) => `${k + 1}`)} _ => 9999 }`
    const one = `export func run(x: u32, y: u32) -> u32 => ${outer(inner)}\n`
    const text = watOf(one, '(func $run')
    expect(text.includes('(block $__tests')).toBe(false)
    expect(depthOf(text)).toBe(65)
    // 45 of them, each in the first arm of the one before (the module of
    // #263's base, which assembles there), put the function more than 100
    // deep: it is written with each match in the form that nests less
    let body = inner
    for (let i = 0; i < 45; i++) body = outer(body)
    const source = `export func run(x: u32, y: u32) -> u32 => ${body}\n`
    expect(depthOf(watOf(source, '(func $run'))).toBeLessThanOrEqual(100)
    const run = (await instance(source)).run as (x: number, y: number) => number
    expect([run(0, 0), run(0, 63), run(0, 64), run(1, 0), run(64, 0), run(65, 0)]).toEqual([1, 64, 9999, 1001, 7, 8])
  })

  test('a match all of whose _ arm is a flat match puts its ifs in the same block', async () => {
    // 120 matches of 60 arms, each the _ arm of the one before: nested, 7200
    // ifs deep; each a block of its own, 120 blocks deep
    let body = '5000'
    for (let i = 119; i >= 0; i--) body = `match x { ${numbered(60, (k) => `${i * 100 + k}`).replace(/(\d+) =>/g, (_, k) => `${+k + i} =>`)} _ => ${body} }`
    const source = `export func run(x: u32) -> u32 => ${body}\n`
    const text = watOf(source, '(func $run')
    expect(text.split('(block $__tests').length - 1).toBe(1)
    expect(depthOf(text)).toBeLessThan(70)
    const run = (await instance(source)).run as (x: number) => number
    expect([run(0), run(59), run(60), run(178), run(179)]).toEqual([0, 59, 159, 11959, 5000])
  })

  test('a function whose code nests too deep is written again with each chain in the form that nests less', async () => {
    // A match of 64 arms inside 30 loops: nested, 30 * 3 + 64 deep; the
    // match alone nests 64, no more than a chain may, but in the function it
    // is flat
    let body = `acc += match x { ${numbered(64, (k) => `${k * 2}`)} _ => 1 }`
    for (let i = 29; i >= 0; i--) body = `for i${i} in 1 {\n${body}\n}`
    const source = `global acc: u32 = 0\nexport func run(x: u32) -> u32 {\nacc = 0\n${body}\nreturn acc\n}\n`
    const text = watOf(source, '(func $run')
    expect(text.split('(block $__tests').length - 1).toBe(1)
    expect(depthOf(text)).toBeLessThanOrEqual(30 * 3 + 2)
    const run = (await instance(source)).run as (x: number) => number
    expect([run(0), run(63), run(64)]).toEqual([0, 126, 1])
  })

  test('code nested deeper than wasm text tools read is one error, at its function', () => {
    // 75 whiles one inside another are 150 blocks and loops: wabt fails on
    // them, or never finishes
    let body = 'acc += 1'
    for (let i = 74; i >= 0; i--) body = `let w${i}: u32 = 0\nwhile w${i} < 1 {\nw${i} += 1\n${body}\n}`
    const source = `export func run() -> u32 {\nlet acc: u32 = 0\n${body}\nreturn acc\n}\n`
    expect(() => wat(source)).toThrow("function 'run' nests its code 7620 deep in wasm, more than the 7000 that wasm text tools read")
    try {
      wat(source)
    } catch (e) {
      expect((e as NestingLimitError).offset).toBe(source.indexOf('func run'))
    }
    // 60 of them, 120 deep, are read
    let shallow = 'acc += 1'
    for (let i = 59; i >= 0; i--) shallow = `let w${i}: u32 = 0\nwhile w${i} < 1 {\nw${i} += 1\n${shallow}\n}`
    expect(() => wat(`export func run() -> u32 {\nlet acc: u32 = 0\n${shallow}\nreturn acc\n}\n`)).not.toThrow()
  })
})

describe('the editor (6.7)', () => {
  const SOURCE = `enum Color { Red, Rgb(r: u8, g: u8, b: u8), Hsl(h: u8, s: u8, l: u8) }
func light(c: Color) -> u8 => match c {
  Red => 128
  Rgb(r, _, _) => r
  Hsl(l:) => l
}
func f() -> u8 => light(Hsl(l: 3, h: 1, s: 2))
func g() -> Color => Red
`
  const parsed = parse(SOURCE)
  const result = typecheck(parsed.module!, { source: SOURCE })
  // The offset of the n-th `word` (from 0) as a whole name
  const at = (word: string, n = 0) => {
    const re = new RegExp(`(?<![A-Za-z0-9_-])${word}(?![A-Za-z0-9_-])`, 'g')
    let m: RegExpExecArray | null = null
    for (let i = 0; i <= n; i++) m = re.exec(SOURCE)
    if (!m) throw new Error(`no ${word} ${n}`)
    return m.index
  }
  const shown = (offset: number) => {
    const r = hover(SOURCE, parsed.module!, result, offset)
    return r ? hoverText(r) : null
  }

  test('hover', () => {
    expect(shown(at('Color'))).toBe('type Color: enum { Red, Rgb(r: u8, g: u8, b: u8), Hsl(h: u8, s: u8, l: u8) }')
    expect(shown(at('Color', 1))).toBe('type Color: enum { Red, Rgb(r: u8, g: u8, b: u8), Hsl(h: u8, s: u8, l: u8) }')
    expect(shown(at('Red'))).toBe('variant Red: Color = 0')
    expect(shown(at('Red', 1))).toBe('variant Red: Color = 0')
    expect(shown(at('Rgb'))).toBe('variant Rgb: (r: u8, g: u8, b: u8) -> Color = 1')
    expect(shown(at('Hsl', 2))).toBe('variant Hsl: (h: u8, s: u8, l: u8) -> Color = 2')
    expect(shown(at('r', 1))).toBe('local r: u8')
    expect(shown(at('l'))).toBe('field l: u8')
    expect(shown(at('l', 3))).toBe('field l: u8')
  })

  test('definition and references', () => {
    const def = (offset: number) => gotoDefinition(SOURCE, parsed.module!, result, offset)?.location.offset
    expect(def(at('Red', 2))).toBe(at('Red'))
    expect(def(at('Hsl', 2))).toBe(at('Hsl'))
    expect(def(at('Color', 1))).toBe(at('Color'))
    expect(def(at('r', 2))).toBe(at('r', 1))
    expect(def(at('l', 3))).toBe(at('l'))
    const refs = (offset: number) => findReferences(SOURCE, parsed.module!, result, offset)?.references.map((r) => r.offset)
    expect(refs(at('Red'))).toEqual([at('Red', 1), at('Red', 2)])
    expect(refs(at('l'))).toEqual([at('l', 1), at('l', 3)])
  })

  test('an enum left out declares nothing: no answer at its variants or payload fields', () => {
    const source = 'enum Q { A(m: u8) }\nenum Q { B, C(n: u16) }\nenum R { B }\nfunc f() -> R => B\n'
    const p = parse(source)
    const checked = typecheck(p.module!, { source })
    for (const offset of [source.indexOf('n: u16'), source.indexOf('B, C'), source.indexOf('C(n')]) {
      expect([hover(source, p.module!, checked, offset), gotoDefinition(source, p.module!, checked, offset), findReferences(source, p.module!, checked, offset), rename(source, p.module!, checked, offset)]).toEqual([null, null, null, null])
    }
  })

  test("a payload field named before its value is the field, whatever is spelled like it; a shorthand reads the variable", () => {
    const source = 'enum Color { Red, Grey(b: u8), Rgb(r: u8, g: u8) }\ndef b = 7\ndef r = 5\nfunc f(c: Color) -> u8 => match c {\n  Grey(b: v) => v + b\n  _ => 0\n}\nfunc g() -> Color => Rgb(r:, g: 1)\n'
    const p = parse(source)
    const checked = typecheck(p.module!, { source })
    const label = source.indexOf('b: v')
    expect(gotoDefinition(source, p.module!, checked, label)?.location.offset).toBe(source.indexOf('b: u8'))
    expect(rename(source, p.module!, checked, label)?.locations.map((l) => l.offset)).toEqual([source.indexOf('b: u8'), label])
    const shorthand = source.indexOf('r:,')
    expect(hoverText(hover(source, p.module!, checked, shorthand)!)).toBe('def r: i32 = 5')
    expect(gotoDefinition(source, p.module!, checked, shorthand)?.location.offset).toBe(source.indexOf('def r'))
  })

  test('rename finds an enum, a variant and a payload field everywhere the module names it', () => {
    const places = (offset: number) => rename(SOURCE, parsed.module!, result, offset)?.locations.map((l) => l.offset)
    expect(places(at('Color'))).toEqual([at('Color'), at('Color', 1), at('Color', 2)])
    expect(places(at('Hsl'))).toEqual([at('Hsl'), at('Hsl', 1), at('Hsl', 2)])
    expect(places(at('l'))).toEqual([at('l'), at('l', 1), at('l', 3)])
  })

  test('the outline and the metadata list the enum and its variants', () => {
    expect(documentSymbols(SOURCE, parsed.module!, result).map((s) => `${s.kind} ${s.name}`).slice(0, 4)).toEqual(['type Color', 'variant Red', 'variant Rgb', 'variant Hsl'])
    const meta = buildMeta(parsed.module!, SOURCE, { checkResult: result })
    const variant = meta.symbols.find((s) => s.name === 'Rgb')
    expect(variant?.kind).toBe('variant')
    expect(variant?.value).toBe('1')
    expect(meta.types[variant?.type ?? -1]?.type).toBe('(r: u8, g: u8, b: u8) -> Color')
    expect(meta.symbols.find((s) => s.name === 'r' && s.kind === 'local')).toBeDefined()
  })

  test('a name of a refused pattern is shown with no type, where it is bound and where it is used', () => {
    const source = `enum Color { Red, Rgb(r: u8, g: u8, b: u8) }
func f(c: Color) -> u8 => match c {
  Rgb(r, b:) => r
  _ => 0
}
`
    const p = parse(source)
    const checked = typecheck(p.module!, { source })
    expect(checked.errors.map((e) => e.message)).toEqual(['a variant pattern takes its parts all by position or all by name'])
    const bound = source.indexOf('r, b:')
    const used = source.indexOf('=> r') + 3
    const shown = { name: 'r', type: '', kind: 'local' }
    expect([hover(source, p.module!, checked, bound), hover(source, p.module!, checked, used)]).toEqual([shown, shown])
    expect(hoverText(shown)).toBe('local r')
    // Its uses are its own, a symbol with no type to show
    const meta = buildMeta(p.module!, source, { checkResult: checked })
    const key = (offset: number) => `${source.slice(0, offset).split('\n').length - 1}:${offset - source.lastIndexOf('\n', offset - 1) - 1}`
    const symbols = [meta.hints[key(bound)], meta.hints[key(used)]].map((h) => (h?.symbol !== undefined ? meta.symbols[h.symbol] : undefined))
    expect(symbols.map((s) => s && { name: s.name, refused: s.refused, def: s.def, refs: s.refs })).toEqual([
      { name: 'r', refused: true, def: key(bound), refs: [key(used)] },
      { name: 'r', refused: true, def: key(bound), refs: [key(used)] },
    ])
  })

  test('a variable given a refused value is shown with no type', () => {
    const source = 'type P = (x: u32)\nfunc f(b: bool, s: P, z: Nope) -> u32 {\n  let x = -b\n  let y = s & 1\n  let w = z\n  return 0\n}\n'
    const p = parse(source)
    const checked = typecheck(p.module!, { source })
    for (const [name, at] of [['x', 'x ='], ['y', 'y ='], ['w', 'w ='], ['z', 'z: Nope'], ['z', 'z\n']]) {
      expect(hover(source, p.module!, checked, source.indexOf(at))).toEqual({ name, type: '', kind: 'local' })
    }
  })
})
