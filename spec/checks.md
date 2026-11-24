# Checks

Programs the checker accepts or rejects. An `ents` block with no rule is a whole module. With no `errors` block after it, it must check cleanly. With one, each line is part of an error message the checker must report, in order.

## Returns

A block body with an unnamed result has to return on every path.

```ents
func sign(x: i32) -> i32 {
  return 1 when x > 0
}
```

```errors
function 'sign' can reach its end without returning a value
```

An `if` whose every branch returns, or a loop with no `break`, counts as returning.

```ents
func sign(x: i32) -> i32 {
  if x > 0 { return 1 } elif x < 0 { return -1 } else { return 0 }
}

func first_over(limit: i32) -> i32 {
  let n: i32 = 0
  loop {
    n += 1
    return n when n * n > limit
  }
}
```

Named results are returned as they're set, so falling off the end is fine.

```ents
func divmod(a: u32, b: u32) -> (q: u32, r: u32) {
  q = a / b
  r = a % b
}
```

A bare `return` hands back named results as they are set. With an unnamed result it has nothing to return.

```ents
func sign(x: i32) -> i32 {
  if x < 0 {
    return
  }
  return 1
}
```

```errors
return needs a value: the function returns i32
```

```ents
func clamp(x: i32) -> (r: i32) {
  r = x
  return when x >= 0
  r = 0
}

func log(x: i32) {
  return when x < 0
}
```

A trailing value supplies the named results in order, whatever its own fields are called, and so does an expression body. Each has to fit the result it fills: a literal's elements widen, but the fields of a value that already exists do not.

```ents
func pair(n: u32) -> (u32, u32) => (n, n + 1)

func a(n: u32) -> (lo: u32, hi: u32) { pair(n) }
func b(n: u16) -> (lo: u64, hi: f64) { (n, n) }
func c(n: u16) -> (lo: u64, hi: f64) => (n, n)
func d(n: i32) -> (r: i64) => n
func e(n: u32) -> (lo: u32, hi: u32) => pair(n)
func f(n: u32) -> (hi: u32, lo: u32) => e(n)
func g(n: u32, c: bool) -> (lo: u32, hi: u32) => if c { pair(n) } else { (0, 0) }
```

```ents
func pair(n: u32) -> (u32, u32) => (n, n + 1)

func a(n: u32) -> (lo: u64, hi: u64) { pair(n) }
func b(n: u32) -> (lo: u32, hi: u32) { n }
func c(x: f64) -> (r: i64) => x
func d(n: u32) -> (lo: u64, hi: u64) => pair(n)
func e(n: u32) -> (lo: u32, hi: u32, top: u32) => pair(n)
```

```errors
cannot convert (u32, u32) to (u64, u64) implicitly: convert its fields
cannot assign u32 to (lo: u32, hi: u32)
cannot assign f64 to i64
cannot convert (u32, u32) to (u64, u64) implicitly: convert its fields
cannot assign (u32, u32) to (lo: u32, hi: u32, top: u32)
```

## Operands

The two operands of an arithmetic, bitwise or comparison operator end up in one type: the narrower one widens to the other's. An integer widens to a wider integer that holds all its values, `f32` to `f64`, and an integer to a float whose mantissa holds it.

```ents
func a(r: f64, n: i32) -> f64 => r * n
func b(n: i32, r: f64) -> bool => n < r
func c(x: u8, y: i16, z: i64) -> i64 => x + y + z
func d(x: f32, y: f64) -> f64 => x / y
func e(x: u32, y: i64) -> bool => x == y
func f(x: f32, n: u16) -> f32 => x - n
```

Types neither of which holds the other need a cast: signed with unsigned of the same width, or an integer too wide for the float.

```ents
func a(x: i32, y: u32) -> bool => x < y
func b(x: i32, y: f32) -> bool => x == y
func c(x: i64, y: f64) -> f64 => x * y
```

```errors
mismatched operands for '<': i32 and u32
mismatched operands for '==': i32 and f32
mismatched operands for '*': i64 and f64
```

A constant takes the type it's used as, and each literal has to fit by its own value. A float literal beside an integer makes the operation an `f64` one.

```ents
func a(x: f64) -> bool => x > 0
func b(n: i32) -> f64 => n * 0.5
func c() -> f32 {
  let x: f32 = 1.0 + 16777216
  return x
}
```

```ents
func c() -> f32 {
  let x: f32 = 1.0 + 16777217
  return x
}
```

```errors
cannot assign int(16777217) to f32
```

A `~` of a constant is a bit pattern, not a negative number: it fits the unsigned types its operand fits.

```ents
func align(n: u32) -> u32 => (n + 7) & ~7
func ones() -> u64 {
  let m: u64 = ~0
  return m
}
```

```ents
func a(x: u32) -> u32 => x & -8
func b() -> u8 {
  let m: u8 = ~300
  return m
}
```

```errors
cannot assign int(-8) to u32
cannot assign int(-301) to u8
```

`%`, the bitwise operators and the shifts are for integers. A bool isn't a number, and a number isn't a bool: conditions and the operands of `&&`, `||` and `!` are bools.

```ents
func a(x: f64) -> f64 => x % 2.0
func b(flag: bool, n: i32) -> i32 => flag + n
func c(n: i32) -> bool => !n
func d(n: i32) -> i32 {
  if n { return 1 }
  return 0
}
```

```errors
'%' needs integer operands, not f64
'+' cannot be applied to bool
operand of '!' must be bool, not i32
condition must be bool, not i32
```

A bool casts to a number (0 or 1), but a number doesn't cast to a bool: say which test is meant.

```ents
func a(flag: bool) -> i32 => flag as i32
func b(n: i32) -> bool => n != 0
```

```ents
func a(n: i32) -> bool => n as bool
func b(x: f64) -> bool => bool(x)
```

```errors
cannot cast i32 to bool: compare it instead
cannot cast f64 to bool: compare it instead
```

A shift's count is any integer type; the result has the value's type and sign.

```ents
func a(x: i64, n: u8) -> i64 => x >> n
func b(x: i32, n: u32) -> i32 => x << n
```

## Widening

A value widens wherever it meets a declared type that holds all its values: a `let` with a type, an assignment, an argument, a constructor field, a result.

```ents
type Sample = (count: i64, mean: f64)

func take(x: i64, y: f64) -> f64 => y

func f(n: i32, x: f32) -> f64 {
  let a: i64 = n
  let b: f64 = x
  a = n
  b += n
  set a = n
  let s = Sample(n, x)
  let t: (i64, f64) = (n, n)
  return take(n, n)
}
```

Narrowing, and an integer the float can't hold, need a cast.

```ents
func a(x: i64) -> i32 => x
func b(x: i32) -> f32 => x
func c(x: i64) {
  let y: f64 = x
}
```

```errors
cannot assign i64 to i32
cannot assign i32 to f32
cannot assign i64 to f64
```

The branches of an `if` or `match` used as a value widen to one type: the declared one, or the widest branch. A branch that always exits needs no value.

```ents
func a(c: bool, n: i32, x: f64) -> f64 => if c { n } else { x }

func b(c: bool, n: i32, big: i64) -> i64 {
  let v = if c { n } elif n > 0 { big } else { return 0 }
  return v
}

func c(k: i32, n: i32, big: i64) -> i64 => match k {
  0 => n
  _ => big
}
```

```ents
func a(c: bool, x: i32, y: u32) -> i64 {
  let v = if c { x } else { y }
  return v
}

func b(c: bool, x: i32) -> i32 => if c { x } else { x = 2 }
```

```errors
branches have different types: u32 and i32
this branch has no value: expected i32
```

Branches that are all constants are a constant, typed by where it's used. With no type from there it takes the default that holds every branch: `i32`, or `i64` when any of them needs one. Each branch has to be a value of the type by itself. A 64-bit pattern past an `i64` (`18446744073709551615`) is one only where no branch is negative.

```ents
func a(c: bool) -> i64 {
  let v = if c { -2147483648 } else { 2147483648 }
  return v
}

func b(c: bool) -> i32 {
  let v = if c { -2147483648 } else { 2147483648 }
  return v
}

func c(k: i32, n: u32) -> u32 => n + match k {
  0 => 5
  _ => -1
}

func d(c: bool) -> f64 {
  let v = if c { 1.5 } else { 9007199254740993 }
  return v
}

func e(c: bool) -> i64 {
  let v = if c { -1 } else { 18446744073709551615 }
  return v
}
```

```errors
cannot assign i64 to i32
cannot assign int(-1) to u32
cannot assign int(9007199254740993) to f64
cannot assign int(18446744073709551615) to i64
```

Branches that are tuples agree field by field. A field that is a constant in every branch takes the default that holds each of them; one that is a value in some branch takes the type the values agree on.

```ents
func a(d: i32) -> i32 {
  let (dx, dy) = match d {
    0 => (1, 0)
    1 => (0, 1)
    _ => (-1, -1)
  }
  return dx + dy
}

func b(c: bool, x: i64) -> i64 {
  let t = if c { (1, 2) } else { (x, 4) }
  return t.0
}

func c(c: bool) -> i32 {
  let t = if c { (-2147483648, 1) } else { (2147483648, 2) }
  return t.0
}

func d(c: bool) -> i32 {
  let t = if c { (1, 2) } else { (3, 4, 5) }
  return t.0
}
```

```errors
cannot assign i64 to i32
branches have different types: (int(3), int(4), int(5)) and (int(1), int(2))
```

An `if let` is a value too, and goes on to `elif` and `else` branches like any `if`.

```ents
data scores = [95, 87, 42]:*[_]i32

func a(i: u32) -> i32 {
  let s = if let score = scores[i] { score } else { -1 }
  return s
}

func b(s: []u8, i: u32, wide: i64) -> i64 => if let x = s[i] { x } elif i == 0 { 0 } else { wide }
```

Its branches meet a declared type like any other `if`'s: each widens to it, even where they have no type between them. The binding stays the first branch's.

```ents
func a(p: ?*u8, n: i32, u: u32) -> i64 => if let q = p { n } else { u }

func b(p: ?*u8, n: i32, u: u32) -> i64 {
  let v = if let q = p { n } else { u }
  return v
}

func c(p: ?*u8, u: u32) -> i64 => if let q = p { 1 } else { q.* }
```

```errors
branches have different types: u32 and i32
unknown identifier 'q'
cannot dereference non-pointer type
```

The elements of an array literal settle on a type the same way: each widens to the declared element type, or, without one, to the widest of them.

```ents
func a(m: u8, n: i32, big: i64, x: f32) -> i64 {
  let ints = [m, n, big]
  let halves = [n, 0.5]
  let small: [2]i16 = [300, m]
  let floats: [2]f32 = [0.5, x]
  return ints[0]
}
```

```ents
func a(n: i32, u: u32) -> i32 {
  let r = [n, u]
  return r[0]
}

func b(n: i32) -> i16 {
  let r: [2]i16 = [300, n]
  return r[0]
}
```

```errors
elements have different types: u32 and i32
cannot assign i32 to i16
```

Tuples among the elements agree field by field, as branches do. Tuples that agree on no type (another count of fields, other names, the same names in another order) are of the first one's type, and each of the others meets it as it would any struct: a tuple written out gives its fields by name where it has names and by position where it has none. With the array's type given, each element is checked against that.

```ents
type Pt = (x: i32, y: i32)

func a(n: i64) -> i64 {
  let wide = [(x: 1:u8, y: 2), (x: 300, y: 4)]
  let mixed = [(1, n), (2, 3)]
  let turned = [(y: 1, x: 2), (x: 3, y: 4)]
  let typed: [2]Pt = [(y: 1, x: 2), (x: 3, y: 4)]
  return mixed[1].1 + wide[1].x + turned[1].x + typed[1].x
}
```

```ents
type Pt = (x: i32, y: i32)

func a() -> i32 {
  let r = [(1, 2), (3, 4, 5)]
  return r[0].0
}

func b() -> i32 {
  let r = [(y: 1, x: 2), (a: 3, b: 4)]
  return r[1].x
}

func c(p: Pt) -> i32 {
  let r = [(y: 1, x: 2), p]
  return r[1].x
}
```

```errors
cannot assign (int(3), int(4), int(5)) to (i32, i32)
field 'a' not found in (y: i32, x: i32), whose fields are y and x
field 'b' not found in (y: i32, x: i32), whose fields are y and x
cannot assign Pt to (y: i32, x: i32): its fields have the names of (y: i32, x: i32)'s in another order
```

A `match` compares its literal patterns in the subject's type, so each has to be a value of that type.

```ents
func a(x: i64) -> i32 => match x {
  5000000000 => 1
  _ => 0
}

func b(x: u8) -> i32 => match x {
  300 => 1
  _ => 0
}
```

```errors
cannot match u8 against int(300)
```

A constant subject has no type of its own. It is compared in its default type: `i32` or `i64` by its size, `f64` for a float.

```ents
def limit = 1

func a() -> i32 => match limit {
  1 => 2
  _ => 3
}

func b(items: [3]u8) -> i32 => match items.len {
  3 => 2
  _ => 3
}

func c() -> i32 => match 5000000000 {
  5000000000 => 2
  _ => 3
}

func d() -> i32 => match 1 {
  5000000000 => 2
  _ => 3
}
```

```errors
cannot match i32 against int(5000000000)
```

An `if` used as a statement has no value, so its branches can end in anything.

```ents
func one() -> i32 => 1
func two() -> u32 => 2

func f(c: bool, n: i32) {
  if c { one() } else { two() }
  if c { one() } else { n = 2 }
}
```

An array literal in a branch has no type of its own: next to a branch that is a slice or a pointer, it is laid out as one, as it is where a `let` gives the type. The `if` (or `match`) is then of the typed branch's type, and compiles as it does with the type written.

<!-- spec:begin compile -->

```ents
data three = [4:i32, 5, 6]
data pair = [1:i32, 2]

func empty(c: bool, xs: []i32) -> u32 {
  let ys = if c { xs } else { [] }
  return ys.len
}
func listed(c: bool, xs: []i32) -> i32 {
  let ys = if c { [7, 8] } else { xs }
  return (ys[1] ?? 0) + ys.len as i32 * 100
}
func arms(k: u32, xs: []i32) -> u32 {
  let ys = match k {
    0 => xs
    1 => [9]
    _ => [0; 4]
  }
  return ys.len
}
func ptr(c: bool) -> i32 {
  let p = if c { pair } else { [7, 8] }
  return p[1]
}
func found(i: u32, xss: [][]i32) -> u32 {
  let ys = if let x = xss[i] { x } else { [3, 3] }
  return ys.len
}

test "a literal branch is of the typed branch's type" {
  assert empty(true, three) == 3
  assert empty(false, three) == 0
  assert listed(true, three) == 208
  assert listed(false, three) == 305
  assert arms(0, three) + arms(1, three) + arms(2, three) == 8
  assert ptr(true) * 10 + ptr(false) == 28
  assert found(0, [three]) + found(1, [three]) == 5
}
```

```ents same-wasm
data three = [4:i32, 5, 6]
data pair = [1:i32, 2]

func empty(c: bool, xs: []i32) -> u32 {
  let ys: []i32 = if c { xs } else { [] }
  return ys.len
}
func listed(c: bool, xs: []i32) -> i32 {
  let ys: []i32 = if c { [7, 8] } else { xs }
  return (ys[1] ?? 0) + ys.len as i32 * 100
}
func arms(k: u32, xs: []i32) -> u32 {
  let ys: []i32 = match k {
    0 => xs
    1 => [9]
    _ => [0; 4]
  }
  return ys.len
}
func ptr(c: bool) -> i32 {
  let p: *[2]i32 = if c { pair } else { [7, 8] }
  return p[1]
}
func found(i: u32, xss: [][]i32) -> u32 {
  let ys: []i32 = if let x = xss[i] { x } else { [3, 3] }
  return ys.len
}
```

<!-- spec:end -->

An array literal with no type written, of elements of more than one kind, is of the one type they all widen to, and a constant among them meets that type: `[0, p]` is a `[2]?*u8` for `p: ?*u8`, still to be resolved before it is used. Elements with no one such type are an error, not an array of the first one's type:

```ents
func a(p: ?*u8) -> ?*u8 {
  let ps = [0, p]
  return ps[1]
}
func d(s: ?[]u8) -> ?[]u8 {
  let ss = [s, 0]
  return ss[1]
}
func b(s: []u8) -> u32 {
  let ss = [0, s]
  return 1
}
func c(n: i32, p: *u8) -> u32 {
  let xs = [p, n]
  return 1
}
data names: []?[]u8 = [0, "ab", "cde"]
data rows: []?[]i32 = [[1, 2], 0, [3]]
```

```errors
elements have different types: int(0) and []u8
elements have different types: i32 and *u8
```

## Destructuring

A named part of a pattern names a field of the value, in a `set` as in a `let`. A part that names no field would leave its variable as it was.

```ents
type Spot = (c: i32, di: i32, room: i32)

func f(s: Spot) -> i32 {
  let q: i32 = 0
  let room: i32 = 0
  set (room:, di: q) = s
  set (room:, q:) = s
  set (nope: q, room: room) = s
  return q + room
}
```

```errors
field 'q' not found in Spot
field 'nope' not found in Spot
```

## Globals

A global starts as a constant: a literal, a constant expression, or the address of data. An integer constant can start a float or a wider global.

```ents
def page = 64 * 1024
data table = [1:u8, 2, 3]

global size: u32 = 4 * page
global ratio: f64 = 3 / 2.0
global count: i64 = table.len
global mask: u8 = ~0 << 4
global base: [*]u8 = table
```

The value is the one the expression has at run time, in the types its parts have: `7 / 2` is 3.5 as an `f64` and 3 as an `i32`, and `200:u8 + 100:u8` wraps to 44 before it widens.

```ents
global halves: f64 = 7 / 2
global pairs: i32 = 7 / 2
global wrapped: i32 = 200:u8 + 100:u8
```

A cast of a constant is a constant: the value the cast gives at run time. An address stays one as another pointer type or as a 32-bit integer.

```ents
def page = 64 * 1024
data table = [1:u8, 2, 3]

global bits: u32 = -1 as u32
global byte: u8 = 300 as u8
global whole: i32 = 2.9 as i32
global wide: i64 = i64(page)
global words: [*]u16 = table as [*]u16
global start: u32 = table as u32
```

A global can be a slice, a struct, an array or a wide integer. Each of its parts starts as a constant.

```ents
type Size = (w: i32, h: f64)

data table = [1:i32, 2, 3]

global order: []i32 = (0, 0)
global view: []i32 = (table as [*]i32, 2:u32)
global size: Size = Size(3, 2 + 2)
global row: [2]i64 = [1 << 40, 5:i32]
global total: u128 = 1 << 100

func f(s: []i32) -> u32 {
  order = s
  size.h += 1
  total += 1
  return order.len
}
```

A value that only exists at run time can't start one: assign it in a function. Nor can a float cast to an integer type it doesn't fit, which traps at run time.

```ents
func one() -> i32 => 1

global a: i32 = one()
global b: i32 = a
global c: u8 = 200 + 100
global d: i64 = one() as i64
global e: u32 = -1.5 as u32
```

```errors
global initializer must be a compile-time constant
global initializer must be a compile-time constant
cannot assign int(300) to u8
global initializer must be a compile-time constant
global initializer must be a compile-time constant
```

## Defer

A deferred expression runs when its block exits, so it can't leave the block itself.

```ents
func f(n: u32) {
  defer if n > 0 { return }
  loop {
    defer if n > 1 { break }
    break
  }
}
```

```errors
cannot return from inside a deferred expression
cannot break out of a deferred expression
```

A loop inside the deferred expression can still use `break` and `continue`.

```ents
func f() {
  defer if true {
    for j in 3 {
      continue when j == 1
      break when j == 2
    }
  }
}
```

## Variables of a loop, an if let and a match arm

A variable that a `for`, an `if let` or a match arm binds is seen in its body only, and never has the name of a variable seen where it is written: it neither hides a variable nor changes one. That is a parameter, a named result, a `let` before it (seen to the end of its function, also past its block), a variable of a loop, `if let` or match arm around it, a global, or a `def` or `data` block, whose name stands for a value wherever it is written.

```ents
global g: u32 = 1
def k = 30
data xs = [1:u32, 2, 3]

func after() -> u32 {
  let c: u32 = 5
  for c in 3 { }
  return c
}

func count(n: u32) -> u32 {
  let t: u32 = 0
  for n in n { t += 1 }
  return t
}

func filled() -> (n: u32) {
  for n in 3 { }
}

func nested() {
  for i in 3 {
    for i in 4 { }
  }
}

func wide(c: bool) -> i64 {
  let i: i64 = 5000000000
  if c {
    for i in 3 { }
  }
  return i
}

func indexed() -> u32 {
  let v: u32 = 100
  for i, v in xs { }
  return v
}

func names() {
  for g in 3 { }
  for k in 3 { }
  for xs in 3 { }
}

func get(p: ?*u32) -> u32 {
  if let p = p {
    return p.*
  }
  return 0
}

func other(p: ?*u32) -> f64 {
  let q: f64 = 0.5
  if let q = p {
    return q.* as f64
  }
  return q
}

func arm(n: u32, m: u32) -> u32 => match m {
  0 => 1
  n => n + 1
}
```

```errors
'c' is already declared: a loop variable cannot reuse the name of a variable in scope
'n' is already declared: a loop variable cannot reuse the name of a parameter
'n' is already declared: a loop variable cannot reuse the name of a named result
'i' is already declared: a loop variable cannot reuse the name of a loop variable in scope
'i' is already declared: a loop variable cannot reuse the name of a variable in scope
'v' is already declared: a loop variable cannot reuse the name of a variable in scope
'g' is already declared: a loop variable cannot reuse the name of a global
'k' is already declared: a loop variable cannot reuse the name of a def
'xs' is already declared: a loop variable cannot reuse the name of a data block
'p' is already declared: an if let binding cannot reuse the name of a parameter
'q' is already declared: an if let binding cannot reuse the name of a variable in scope
'n' is already declared: a match binding cannot reuse the name of a parameter
```

After the body the names are free again: two loops one after the other can both use `i`, a `let` after a `for c` declares a variable of its own, and `if let`s in turn can bind one name to values of different types. A `let` in a loop's body is still seen to the end of the function. A function has no value, and a binding of its name hides it in the body.

```ents
data bytes = [1:u8, 2, 3]
data wides = [1.5, 2.5]
data cells = [7:u32, 8, 9]

func scale() -> f64 => 2.0

func total(p: ?*f64) -> f64 {
  let s: f64 = 0
  for i in 3 { s += i as f64 }
  for i in 4 { s += i as f64 }
  for v in bytes {
    s += v as f64
    let last = v
  }
  for v in wides { s += v }
  if let q = cells[1] { s += q as f64 }
  if let q = p { s += q.* }
  for scale in 2 { s += scale as f64 }
  let c: u8 = last
  let i: i64 = 5000000000
  let v: f64 = 0.5
  return s * scale() + v
}
```

## Structs in memory

A struct, tuple or slice can be an element or a pointee, and is read and written whole or field by field. A field of the struct a pointer points to is written `p.x`.

```ents
type Spot = (c: i32, di: i32, room: i32)
type Lane = (cells: []i32, free: i32)
type Option = (d: i32, lane: Lane)

func third(list: [*]mut Spot, opts: [*]mut Option, p: *mut Spot) -> i32 {
  list[2] = Spot(20, 1, 2)
  let s = list[2]
  p.* = s
  p.c += 1
  opts[1].lane.free = p.c
  opts[1].lane.cells = opts[0].lane.cells
  let t = opts[1].lane.free
  for x in opts[1].lane.cells { t += x }
  let all: []Spot = (list, 3:u32)
  for spot in all { t += spot.room }
  return t
}
```

A write to a field goes through whatever holds the outermost struct, so that has to be mutable: the pointer `p` in `p.x = v`, the array in `rows[i].at.x = v`. A struct in a variable is written without one.

```ents
type Spot = (c: i32, di: i32)
type Row = (tag: u8, v: [3]i32, at: Spot)

func a(p: *Spot) { p.c = 5 }
func b(rows: [*]Row) { rows[1].at.c = 5 }
func c(r: *Row) { r.v[0] = 1 }
func d(rows: []Row) { rows[0] = Row(1, [1, 2, 3], Spot(4, 5)) }
func e(r: Row, m: *mut Row) {
  r.at.c = 5
  m.at.c = 5
  m.v[2] = r.v[0]
}
```

```errors
cannot write through const pointer
cannot write through const pointer
cannot write through const pointer
writing to an element of a slice needs its index checked: use if let on its address (&s[i])
cannot write through const slice
```

A type pun (`p.u32`) is the pointer itself, seen as a pointer to `u32` values: it loads nothing, so there is no place behind it to assign to. Its element is the place.

```ents
data buf = mut [0:u8; 16]

func a(p: [*]mut u8) -> u32 {
  p.u32[0] = 0x01020304
  buf.u16[1] = 7
  return p.u32[0]
}
```

```ents
data buf = mut [0:u8; 16]

func a(p: [*]mut u8) { p.u32 = 0x01020304 }
func b(s: []mut u8) { s.f64 += 1.5 }
func c() { buf.u16 = 7 }
```

```errors
cannot assign to .u32: it is the pointer as [*]mut u32, not the u32 it points at — write .u32[0] = value
cannot assign to .f64: it is the pointer as [*]mut f64
cannot assign to .u16: it is the pointer as [*]mut u16
```

A fixed array held by value has no `.ptr`, in registers or read out of memory; one that lies in memory has the address of its place:

```ents
type Row = (cells: [2]i32, n: i32)

func a(x: i32, y: i32) -> u32 {
  let v = [x, y]
  return v.ptr as u32
}
func b(p: *Row) -> u32 => p.cells.ptr as u32
func c(p: *Row) -> u32 => (&p.cells).ptr as u32
```

```errors
cannot take .ptr of [2]i32: a fixed array held by value has no address
cannot take .ptr of [2]i32: a fixed array held by value has no address (where it lies in memory, (&p.cells).ptr is its address)
```

An array literal indexed where it is written is its elements, held in registers: a constant index picks one, and any other is an error, as for a fixed array in a variable:

```ents
type Canvas = host

func a(x: u32, y: u32) -> u32 => [x, y][1]
func b(x: u32, y: u32, i: u32) -> u32 => [x, y][i]
func c(i: u32) -> i32 => [10, 20, 30][i] ?? 7
func d(c: Canvas, i: u32) -> Canvas => [c, c][i]
func e(x: u32) -> u32 => [x, x][2]
```

```errors
dynamic index on an array literal — its elements are held in registers and picked by a constant index: lay it out in memory with & to index it at run time
dynamic index on an array literal — its elements are held in registers
dynamic index on an array literal of Canvas — an element of an array held in registers is reached by a constant index only, and a host reference is never in memory
index 2 out of bounds for [2]u32
```

A constant index is any the compiler works out, not only a literal: `(1)`, `0 + 1`, `1 - 1` or a `def`. The elements are the type the literal settles on, as they are in a `let`: strings of different lengths are slices. Laid out in memory with `&`, a literal with no type written is that type too, and is indexed at run time:

<!-- spec:begin compile -->

```ents
type Canvas = host

def one = 1

func a(x: i32, y: i32) -> i32 => [x, y][(1)]
func b(x: i32, y: i32) -> i32 => [x, y][0 + 1]
func c(x: i32, y: i32) -> i32 => [x, y][1 - 1]
func d(x: i32, y: i32) -> i32 => [x, y][one]
func e() -> u32 => ["ab", "cde"][0 + 1].len
func f(c: Canvas, d: Canvas) -> Canvas => [c, d][0 + 1]
func g(x: i32, y: i32, i: u32#2) -> i32 {
  let p = &[x, y]
  return p[i]
}
func h(i: u32#3) -> i32 {
  let p = &[10, 20, 30]
  return p[i]
}
func k(i: u32#2) -> u32 => (&["ab", "cde"])[i].len

test "a constant index picks an element, and a literal laid out with & is indexed at run time" {
  assert a(7, 9) == 9
  assert b(7, 9) == 9
  assert c(7, 9) == 7
  assert d(7, 9) == 9
  assert e() == 3
  assert g(7, 9, 0) == 7
  assert g(7, 9, 1) == 9
  assert h(2) == 30
  assert k(1) == 3
}
```

<!-- spec:end -->

## Structs in array literals

An element of an array literal can be a struct, written as a tuple or with its constructor. It is checked field by field, so a literal field takes its field's type. A slice field can be a string.

```ents
type Mixed = (a: u64, b: u8, name: []u8)

data table: *[2]Mixed = [(1, 2, "x"), Mixed(name: "yz", a: 3, b: 4)]

func f(n: u8) -> u64 {
  let local: *[2]Mixed = [(1, n, "x"), (5, 6, "y")]
  return local[0].a + table[1].a
}
```

```ents
type Mixed = (a: u64, b: u8, name: []u8)

data table: *[2]Mixed = [(1.5, 2, "x"), (1, 300, "y")]
```

```errors
cannot assign float(1.5) to u64
300
```

So is an element that is an array, in an array held in registers (`[2][3]u16`): a literal row is checked element by element against the row's element type, wherever the array meets its type, a `let`, an argument or a field.

<!-- spec:begin compile -->

```ents
type S = (n: u8, m: [2][2]u8)

func pick(w: [2][3]u16) -> u16 => w[1][2]
func rows(k: u8) -> u8 {
  let x: [2][2]u8 = [[k, 2], [3; 2]]
  let s = S(1, [[5, 6], [7, 8]])
  return x[0][0] + x[1][1] + s.m[1][0]
}

test "a row literal of an array held in registers takes the row's element type" {
  assert pick([[1, 2, 3], [4, 5, 300]]) == 300
  assert rows(9) == 19
}
```

<!-- spec:end -->

```ents
func f() -> u8 {
  let x: [2][2]u8 = [[1, 2], [3, 300]]
  return x[0][0]
}
```

```errors
cannot assign int(300) to u8
```

## Literals for mutable pointers and slices

A literal is constant unless it is written with `mut`. Where a mutable pointer or slice is wanted, a literal without the keyword is an error that shows it written with it. `mut` makes all of a literal writable and its own: the rows of a table, the elements of a slice of slices and the slice fields of its structs too.

```ents
type Buf = (bytes: []mut u8, n: u32)

data s: []mut i32 = mut [20, 8]
data t: *mut [2][2]i32 = mut [[1, 2], [1, 2]]
data q: *[2][]mut u8 = [mut "ab", mut "cd"]
data r: [][]mut u8 = mut [[1, 2], [3, 4]]
data bufs: *mut [1]Buf = mut [([0:u8; 4], 0)]

func fill(buf: []mut u8) -> u32 => buf.len
func fill(n: u32) -> u32 => n

func count(s: []u8) -> u32 => s.len

func f() -> u32 {
  let buf: []mut u8 = mut [0:u8; 20]
  let b = Buf(mut [0:u8; 4], 0)
  let cell = &0:u32
  return fill(mut "hello") + fill(buf) + fill(b.bytes) + cell.* + (mut "ab").fill() + count(buf[2..] ?? "")
}
```

```ents
type Buf = (bytes: []mut u8, n: u32)

data s: []mut i32 = [20, 8]
data t: *mut [2][2]i32 = [[1, 2], [1, 2]]
data q: *[2][]mut u8 = [mut "ab", "cd"]
data r: [][]mut u8 = [[0:u8; 2]; 3]
data e: []mut u8 = ""

func fill(buf: []mut u8) -> u32 => buf.len
func fill(n: u32) -> u32 => n

func f(x: i32) -> u32 {
  let buf: []mut u8 = [0:u8; 20]
  let b: Buf = ([0:u8; 4], 0)
  let p: *mut [2]i32 = [x, 8]
  return fill("hello") + fill(buf) + "ab".fill() + fill(buf[2..] ?? "")
}

func g(x: []u8) -> u32 {
  let parts: []mut []u8 = `a${x}b`
  return parts.len
}
```

```errors
a literal is constant: write `mut [20, 8]` for a []mut i32
a literal is constant: write `mut [[1, 2], [1, 2]]` for a *mut [2][2]i32
a literal is constant: write `mut "cd"` for a []mut u8
a literal is constant: write `mut [0:u8; 2]` for a []mut u8
a literal is constant: write `mut ""` for a []mut u8
a literal is constant: write `mut [0:u8; 20]` for a []mut u8
a literal is constant: write `mut [0:u8; 4]` for a []mut u8
a literal is constant: write `mut [x, 8]` for a *mut [2]i32
argument 1: a literal is constant: write `mut "hello"` for a []mut u8
receiver: a literal is constant: write `(mut "ab")` for a []mut u8
a literal is constant: write `mut ""` for a []mut u8
a literal is constant: write `mut `a${x}b`` for a []mut []u8
```

`mut` goes on the literal itself, so before a method call it is a syntax error that shows the parentheses:

```ents
func fill(buf: []mut u8) -> u32 => buf.len
func f() -> u32 => mut "ab".fill()
```

```errors
mut goes on the literal itself: write (mut "ab").fill()
```

## Values in a literal in memory

The value of a repeat literal, and each element of an array literal inside another, meets the element type as an element of the outer literal does: it widens to it, or it is an error.

```ents
data zeros: *mut [4]u8 = mut [0; 4]
data rows: [][]u32 = [[1, 2], [3, 4]]

func f(n: i32) -> i64 {
  let wide: *[3]i64 = [n; 3]
  return wide[2]
}
```

```ents
data flags: []u32 = [true; 3]
data rows: [][]u8 = [[300, 1], [2, 3]]

func f(n: i32) -> u8 {
  let bytes: *[3]u8 = [n; 3]
  return bytes[0]
}
```

```errors
cannot assign bool to u32
cannot assign int(300) to u8
cannot assign i32 to u8
```

Data is laid out when the program is compiled, and nothing fills it in later: each value in it is a literal, a constant expression, or the name of data declared before it. In a function, a literal's values known only at run time are stored into it when it is evaluated, except in a literal laid out apart from it: an element of a slice of slices or a row of a table.

```ents
def k = 4
type Ref = (p: *[3]i32, n: u32)

data ones: *[3]i32 = [1, 1, 1]
data xs: *[4]u32 = [1 + 1, k * 2, sizeof(u64), ~0]
data refs: *[2]Ref = [(ones, 3), Ref(ones, k)]
data names: [][]i32 = [ones, [k, 1]]

func f(x: i32) -> i32 {
  let a: *[2]i32 = [x, 2]
  let p: *[2x2]i32 = [[x, 1], [2, 3]]
  let s: [][]i32 = [ones, [x, 1]]
  return a[0] + p[0][0]
}
```

```errors
an element of [][]i32 is laid out at compile time: its values must be constants
```

```ents
global g: i32 = 3
func one() -> i32 => 1
type Ref = (p: *[3]i32, n: u32)

data ones: *[3]i32 = [1, 1, 1]
data a: *[2]i32 = [g, 1]
data b: *[2]i32 = [one(), 1]
data c: *[1]Ref = [(ones, g as u32)]
data d: [][]i32 = [[g, 1], [2]]
data e: *[2][2]i32 = [[g, 1], [2, 3]]
data f = (g, 1)
```

```errors
data 'a' is laid out at compile time: its values must be constants
data 'b' is laid out at compile time: its values must be constants
data 'c' is laid out at compile time: its values must be constants
an element of [][]i32 is laid out at compile time: its values must be constants
a row of *[2][2]i32 is laid out at compile time: its values must be constants
data 'f' is laid out at compile time: its values must be constants
```

An array literal for a `*[N]T` has N elements, and each row of a table or of a `*[NxM]T` has M. Behind a pointer a string is the bytes of all the elements; the rows of a table are laid out apart, so a string cannot be them.

```ents
data a: *[3]i32 = [1, 2, 3]
data b: *[2]u16 = "abcd"
data c: *[2x2]u8 = ["ab", "cd"]
data d: *[2][2]i32 = [[1, 2], [3, 4]]
data e: *[4]u8 = [7; 4]
data f: *[!]u8 = "abc"
data g: [*]u32 = "abcd"
```

```ents
data a: *[3]i32 = [1, 2]
data b: *[2]i32 = [1, 2, 3]
data c: *[3]i32 = [1; 2]
data d: *[2][2]i32 = [[1, 2], [3]]
data e: [][2]i32 = [[1, 2], [3, 4, 5]]
data f: *[8]u8 = "abcd"
data g: *[4]u32 = "abcd"
data h: *[2][2]u8 = "abcd"

func row() -> *mut [4][]u8 => mut "abcd"
```

```errors
cannot assign 2 elements to *[3]i32
cannot assign 3 elements to *[2]i32
cannot assign 2 elements to *[3]i32
cannot assign 1 element to [2]i32
cannot assign 3 elements to [2]i32
cannot assign a string of 4 bytes to *[8]u8
cannot assign a string of 4 bytes to *[4]u32
cannot assign a string literal to *[2][2]u8 — a string is bytes ([]u8); write the [2]u8 elements as an array literal
cannot assign a string of 4 bytes to *mut [4][]u8
```

So does a type given by its name: a name for the pointer, for the array it points to, or for an element of a literal laid out apart is the type it names.

```ents
type Three = [3]i32
type Triple = *[3]i32
type Row = []i32
type Pair = *[2]i32

data a: *Three = [1, 2]
data b: Triple = [1, 2, 3, 4]
data c: *Three = "ab"

func first(p: *Three) -> i32 => p[0]
func short() -> i32 => first([1, 2])

func rows(x: i32) -> i32 {
  let s: []Row = [[x, 2], [3]]
  let t: *[2]Pair = [[x, 2], [3, 4]]
  return 0
}
```

```errors
cannot assign 2 elements to *Three
cannot assign 4 elements to Triple
cannot assign a string of 2 bytes to *Three
argument 1: cannot assign 2 elements to *Three
an element of []Row is laid out at compile time: its values must be constants
an element of *[2]Pair is laid out at compile time: its values must be constants
```

An element of an array of pointers given a literal is the address of that literal, laid out apart: it has the count its pointer says, its values are constants, and a tuple is not a pointer to a struct.

```ents
type Pt = (x: i32, y: i32)
data ones: *[2]i32 = [1, 1]
data a: *[2]*[2]i32 = [[1, 2], ones]
data b: *[2][*]u8 = ["ab", "cde"]
data c: *[2]*[2]i32 = [[1, 2, 3], [4, 5]]
data d: *[2]*[2]u8 = ["abc", "de"]
data e: *[1]*Pt = [(1, 2)]

func f(x: i32) -> i32 {
  let p: *[2]*[2]i32 = [[x, 2], ones]
  return p[0][0]
}
```

```errors
cannot assign 3 elements to *[2]i32
cannot assign a string of 3 bytes to *[2]u8
cannot assign (int(1), int(2)) to *Pt
an element of *[2]*[2]i32 is laid out at compile time: its values must be constants
```

`memcpy`, `memset` and `memzero` write their destination, as a write through an index does: it is a `*mut` pointer.

```ents
data src = [1:u8, 2, 3, 4]
data dst = [0:u8; 4]
data out = mut [0:u8; 4]

func a() { memcpy(dst, src, 4) }
func b() { memset(dst, 7, 4) }
func c() { memzero(dst) }
func d(p: *[4]u8) { memcpy(p, src, 4) }
func e() { memcpy(out, src, 4) }
```

```errors
memcpy dest: cannot write through const pointer *[4]u8 — use *mut for mutable access
memset dest: cannot write through const pointer *[4]u8 — use *mut for mutable access
memzero dest: cannot write through const pointer *[4]u8 — use *mut for mutable access
memcpy dest: cannot write through const pointer *[4]u8 — use *mut for mutable access
```

## Slices from a pointer and a length

A pair `(ptr, len)` where a slice is expected is that slice, whatever its elements are.

```ents
type Spot = (c: i32, di: i32)
type Lane = (cells: []i32, at: Spot)

global lanes: []Lane = (0, 0)
global rows: [][]i32 = (0, 0)

func f(p: [*]Lane, q: [*][]i32, n: u32) -> u32 {
  lanes = (p, n)
  let all: [][]i32 = (q, n)
  rows = all
  return lanes.len + rows.len
}
```

Its two parts are checked like any value that meets a type: a pointer to the slice's elements, as writable as the slice, and a length that an i32 holds.

```ents
func f(p: [*]i32, n: u64) {
  let a: []mut i32 = (p, 2)
  let b: []u8 = (p, 2)
  let c: []i32 = (p, n)
}
```

```errors
slice pointer: cannot assign [*]i32 to [*]mut i32
slice pointer: cannot assign [*]i32 to [*]u8
slice length: cannot assign u64 to u32
```

No other tuple is a slice. One value in parentheses is that value, so it has to be a slice itself.

```ents
global word: []u8 = ("abc")

func f(s: []u8) -> u32 {
  let t: []u8 = (s)
  return t.len + word.len
}
```

```ents
global a: []mut i32 = (0)
global b: []i32 = (1, 2, 3)

func f() {
  let c: []i32 = ()
}
```

```errors
cannot assign int(0) to []mut i32
cannot assign (int(1), int(2), int(3)) to []i32
cannot assign () to []i32
```

So is an element of a literal of slices: a value in parentheses is that value, and a many-pointer has no length to be one.

```ents
data room = mut [0:u8; 64]

func f() -> u32 {
  let xs: [][]u8 = [(room as [*]u8)]
  let ys: [][]mut u8 = [((room as [*]mut u8)), room]
  return xs.len + ys.len
}
```

```errors
cannot assign [*]u8 to []u8
cannot assign [*]mut u8 to []mut u8
```

<!-- spec:begin compile -->

```ents
data text = "abc"
data more = "hello"

func total(xs: [][]u8) -> u32 {
  let n: u32 = 0
  for x in xs { n += x.len }
  return n
}

test "values in parentheses among slices" {
  let s: []u8 = more
  let xs: [][]u8 = [(text), ("ab"), (s), ((text as [*]u8, 2))]
  assert total(xs) == 3 + 2 + 5 + 2
}
```

<!-- spec:end -->

## Slices from a pointer to an array

A `*[N]T` is a `[]T` of length `N` wherever it meets one: an argument, an initializer, an assignment, a returned value, an expression body, a branch, a field of a struct or tuple literal, and under a name for the slice type.

<!-- spec:begin compile -->

```ents
data text = "abc"
data more = "hello"
type S = []u8
type Holder = (s: []u8, n: u32)

global g: []u8 = text

func ret() -> []u8 { return text }
func arrow() -> []u8 => text
func pick(c: bool) -> []u8 => if c { text } else { more }
func arm(k: u32) -> []u8 => match k { 0 => text, _ => more }
func built() -> Holder => Holder(text, 1)
func literal() -> Holder => (s: more, n: 2)
func pair() -> ([]u8, u32) => (text, 3)
func named() -> u32 {
  let s: S = "abcd"
  s = more
  return s.len
}
func fields() -> u32 {
  let t = (s: text, n: 1:u32)
  let h = Holder(t.s, t.n)
  return h.s.len
}

test "each has the length of its array" {
  assert g.len == 3
  assert ret().len == 3
  assert arrow().len == 3
  assert pick(false).len == 5
  assert arm(0).len == 3
  assert built().s.len == 3
  assert literal().s.len == 5
  let (p, n) = pair()
  assert p.len == 3
  assert named() == 5
  assert fields() == 3
}
```

<!-- spec:end -->

A struct or tuple that is already a value holds a pointer, one wasm value where the slice is two: it is not converted as a whole. Built from its fields, as a literal is, each field converts (`fields` above).

```ents
data text = "abc"
type Holder = (s: []u8, n: u32)

func f() -> u32 {
  let t = (s: text, n: 1:u32)
  let h: Holder = t
  return h.s.len
}
```

```errors
cannot convert (s: *[3]u8, n: u32) to Holder implicitly: convert its fields
```

A table converts the same way, to a slice of rows (`[][2]u16`), in a constructor as in a literal, and in a generic type's constructor. Pointers to arrays of different lengths in one literal are slices of their own lengths, with no type written for it (`[three, four]` is a `[2][]i32`), in a tuple, in rows, in the branches of an `if` or `match` and in a global too.

<!-- spec:begin compile -->

```ents
type Rows = (rows: [][2]u16, base: u32)
type Outer = (inner: Rows, k: u32)
func Of(comptime R: type) -> type => (rows: []R, base: u32)

data table: *[2][2]u16 = [[100, 200], [300, 400]]
data three: *[3]i32 = [1, 2, 3]
data four: *[4]i32 = [4, 5, 6, 7]

func count(r: Rows) -> u32 => r.rows.len
func cell(r: Rows) -> u16 => if let row = r.rows[1] { row[1] } else { 0 }
func any(comptime R: type, r: Of(R)) -> u32 => r.rows.len

test "a table is a slice of its rows" {
  assert count(Rows(table, 0)) == 2
  assert count(Rows(rows: table, base: 0)) == 2
  assert count((table, 0)) == 2
  assert cell(Rows(table, 0)) == 400
  let o = Outer(Rows(table, 0), 1)
  assert o.inner.rows.len == 2
  let p: Outer = ((table, 0), 1)
  assert p.inner.rows.len == 2
  assert any(Of([2]u16)(table, 0)) == 2
  assert any(Of(i32)(four, 0)) == 4
}

test "pointers to arrays of different lengths in one literal" {
  let both = [three, four]
  assert both[0].len == 3
  assert both[1].len == 4
  let words = ["ab", "cde"]
  assert words[1].len == 3
  let some: []i32 = four
  let mixed = [some, three]
  assert mixed[1].len == 3
  let t = ([three, four], 9)
  assert t.0[1].len == 4
  let nested = [[three, four], [four, three]]
  assert nested[1][0].len == 4
  assert nested[1][1].len == 3
}

global names = ["ab", "cde"]
global pair = ([three, four], 9:u32)

test "in the branches of an if or a match, in rows, and in a global" {
  let x = if three[0] == 1 { [three, four] } else { [four, three] }
  assert x[1].len == 4
  let w = if four[0] == 4 { ["ab", "cde"] } else { ["x", "yz"] }
  assert w[0].len == 2
  assert w[1].len == 3
  let m = match three[0] { 1 => [four, three], _ => [three, four] }
  assert m[0].len == 4
  let rows = [[three, three], [four, four]]
  assert rows[0][1].len == 3
  assert rows[1][0].len == 4
  let pairs = [(three, 1), (four, 2)]
  assert pairs[1].0.len == 4
  assert pairs[1].1 == 2
  assert names[1].len == 3
  assert pair.0[1].len == 4
  assert pair.1 == 9
}
```

<!-- spec:end -->

Rows of different lengths have no type together in registers: data lays them out as slices of their own lengths (`data rows: *[2][]i32 = [[1, 2], [3, 4, 5]]`).

```ents
data three: *[3]i32 = [1, 2, 3]
data four: *[4]i32 = [4, 5, 6, 7]

func f() -> u32 {
  let rows = [[three], [four, three]]
  let cells = [[1, 2], [3, 4, 5]]
  return rows[1][0].len
}
```

```errors
rows of different lengths: this one has 2 elements and the first 1; give the rows one length, or lay them out as slices with data
rows of different lengths: this one has 3 elements and the first 2; give the rows one length, or lay them out as slices, data rows: *[2][]i32 = ...
```

## Bounds

An index into a `*[N]T` needs no check when its type proves it's below `N`. Ranges come from `for i in N`, from `&` and `%` with a constant, from `>>` on a fixed-width value, and from the width of `u8` and `u16`.

```ents
data buf = mut [0:u8; 16]
data grid = mut [0:u8; 256]

func f(x: u32, b: u8) {
  for i in 16 { buf[i] = 0 }
  buf[x & 15] = 1
  buf[x % 16] = 2
  buf[x >> 28] = 3
  grid[b] = 4
}
```

The constant has to have a value of its own. An `if` or `match` of constants is typed like one but can be any of them, and a complement has all its high bits set: neither bounds the result.

```ents
data buf = mut [0:u8; 16]

func a(x: u32, wide: bool) { buf[x >> (if wide { 1 } else { 28 })] = 1 }
func b(x: u32) { buf[x & ~15] = 2 }
```

```errors
writing to an element needs an index known to be in range
writing to an element needs an index known to be in range
```

A shift takes its count modulo the width it's done in, 32 bits for a `u32` or anything narrower. So `x >> 32` is `x`, not 0, and bounds nothing, while `x >> 60` shifts by 28. A constant with a shift inside it has the value the shift gives it: `65535 >> 32` is 65535 as a `u32`, and 16 is no index into 16 elements.

```ents
data buf = mut [0:u8; 16]

func a(x: u32) { buf[x >> 60] = 1 }
func b(x: u32) { buf[x >> 32] = 2 }
func c(x: u32) { buf[x >> (16 + 16)] = 3 }
func d(x: u32) { buf[x & (65535 >> 32)] = 4 }
func e() { buf[16 >> 32] = 5 }
func f(b: u8) { buf[b >> 36] = 6 }
```

```errors
index type u32#4294967296 may exceed *[16]u8 bounds
index type u32#4294967296 may exceed *[16]u8 bounds
index type u32#65536 may exceed *[16]u8 bounds
index 16 out of bounds for *[16]u8
```

A constant is worked out in the type it takes, step by step, as the program does it. As a `u32`, `0 - 1` is 4294967295, and that is what a division, a remainder or a right shift is given: `(0 - 1) / 268435455` is 16, `~0 >> 28` is 15.

```ents
data buf = mut [0:u8; 16]

func a() { buf[(0 - 1) / 268435455] = 1 }
func b(x: u32) { buf[x & ((0 - 1) / 268435455)] = 2 }
func c() { buf[(1 - 2) % 20 + 1] = 3 }
func d(x: u32) { buf[x & (~0 >> 28)] = 4 }
func e() { buf[(0 - 1) % 16] = 5 }
func f() { memset(buf, 0, (1 - 2) / 4 + 16) }
```

```errors
index 16 out of bounds for *[16]u8
index type u32#17 may exceed *[16]u8 bounds
index 16 out of bounds for *[16]u8
memset length 1073741839 exceeds buffer size 16 bytes
```

A range bound and a length are that value too: `~4294967200` is 95 as a `u32`, not a negative number that would fit anywhere.

```ents
data buf = mut [0:u8; 16]

func a() { buf[~4294967295..~4294967200] = 1 }
func b() { memset(buf, 0, ~4294967200) }
func c() { buf[~4294967295..~4294967279] = 1 }
```

```errors
range 0..95 is out of bounds for *[16]u8
memset length 95 exceeds buffer size 16 bytes
```

A comparison with a constant narrows the variable where it holds: inside the branch, in later branches of the same `if`, and after an exit that the comparison guards.

```ents
data buf = mut [0:u8; 12]

func f(x: u32) -> u8 {
  if x < 12 { buf[x] = 1 }
  return 0 when x >= 12
  return buf[x]
}

func g(x: u32) -> u8 {
  if x >= 12 { return 0 }
  return buf[x]
}
```

A bound that's too loose, a variable assigned in the narrowed region, a signed index, or an `||` that doesn't guarantee the bound, all leave the index unproven.

```ents
data buf = mut [0:u8; 12]

func a(x: u32) { if x < 13 { buf[x] = 1 } }
func b(x: u32) {
  if x < 12 {
    x += 1
    buf[x] = 1
  }
}
func c(x: i32) { if x < 12 { buf[x] = 1 } }
func d(x: u32) { if x < 12 || x == 50 { buf[x] = 1 } }
```

```errors
index type u32#13 may exceed *[12]u8 bounds
writing to an element needs an index known to be in range
writing to an element needs an index known to be in range
writing to an element needs an index known to be in range
```

For an index that can't be proven, `&items[i]` is an optional pointer, so the check is written out.

```ents
data buf = mut [0:u8; 12]

func put(s: []mut u8, i: u32, v: u8) -> bool {
  if let p = &s[i] {
    p.* = v
    return true
  }
  return false
}

func put_buf(i: u32, v: u8) {
  if let p = &buf[i] { p.* = v }
}
```

## Tables

In a pointer or slice whose element is a fixed array (`*[N][M]T`, `[][M]T`, `[*][M]T`), each element is a pointer to its row. `m[i]` is that row pointer, a `*[M]T`, and `m[i][j]` indexes the row. Each index is checked on its own, and both can be known only at run time.

```ents
data grid: *[2][3]i32 = [[7, 1, 2], [3, 4, 5]]
data board: *mut [2][3]i32 = mut [[0; 3]; 2]

func sum(r: *[3]i32) -> i32 => r[0] + r[1] + r[2]

func cell(i: u32#2, j: u32#3) -> i32 => grid[i][j]

func put(i: u32#2, j: u32#3, v: i32) {
  board[i][j] = v
}

func rows(i: u32#2) -> i32 {
  let r = grid[i]
  return sum(r) + sum(board[i])
}
```

A row has no optional type. A row index that isn't known to be in range is resolved where it is taken, with `if let` or `??`, against `N` or a slice's length. `??` and `if let` resolve only the index they are given, so the row in `m[i][j] ?? 0` still has to be in range.

```ents
data grid: *[2][3]i32 = [[7, 1, 2], [3, 4, 5]]
data rows: [][2]i32 = [[7, 1], [3, 4]]

func a(i: u32, j: u32#3) -> i32 => grid[i][j]
func b(i: u32, j: u32#2) -> i32 => rows[i][j] ?? 0
func c(i: u32#3, j: u32#3) -> i32 => grid[i][j]
```

```errors
runtime index on *[2][3]i32 requires 'if let' or '??' (rows are not optional)
runtime index on [][2]i32 requires 'if let' or '??' (rows are not optional)
index type u32#3 may exceed *[2][3]i32 bounds (max index 2 >= 2)
```

```ents
data grid: *[2][3]i32 = [[7, 1, 2], [3, 4, 5]]
data rows: [][2]i32 = [[7, 1], [3, 4]]
data zeros: *[2]i32 = [0, 0]

func a(i: u32, j: u32#3) -> i32 => if let r = grid[i] { r[j] } else { 0 }
func b(i: u32, j: u32#2) -> i32 => (rows[i] ?? zeros)[j]
```

A write goes through the row pointer, so the table has to be mutable. Assigning to `m[i]` points the row elsewhere; there is no `[N][M]T` in the table to load or store whole.

```ents
data grid: *[2][3]i32 = [[7, 1, 2], [3, 4, 5]]
data board: *mut [2][3]i32 = mut [[0; 3]; 2]
data spare: *mut [3]i32 = mut [1, 2, 3]

func f() {
  grid[0][0] = 1
  board[1] = spare
  board[0] = grid[0]
  let all = grid.*
}
```

```errors
cannot write through const pointer
cannot assign *[3]i32 to *mut [3]i32
cannot use .* on *[2][3]i32
```

A table literal is laid out when the program is compiled, its rows apart from it, so every value in it is a constant.

```ents
func f(a: i32) -> i32 {
  let t: *[2][3]i32 = [[a, 2, 3], [4, 5, 6]]
  return t[0][0]
}
```

```errors
a row of *[2][3]i32 is laid out at compile time: its values must be constants
```

A table's own bytes are its row pointers, 4 for each row: `memcpy` and `memset` check a length against them, and `memzero` of a table is refused, since it would point every row at address 0. A row is zeroed, or copied, as the array it is.

```ents
data board: *mut [2][3]i32 = mut [[1, 2, 3], [4, 5, 6]]
data grid: *[2][3]i32 = [[7, 1, 2], [3, 4, 5]]

data cube: *mut [2][2][2]i32 = mut [[[1, 2], [3, 4]], [[5, 6], [7, 8]]]

func f() {
  memcpy(board, grid, 24)
  memzero(board)
  memzero(cube)
}
```

```errors
memcpy length 24 exceeds buffer size 8 bytes
memzero dest: *mut [2][3]i32 is a table, its elements pointers to rows (reference 2.5): zero each row, for row in board { memzero(row) }
memzero dest: *mut [2][2][2]i32 is a table, its elements pointers to rows (reference 2.5): zero each row, for row in cube { for cells in row { memzero(cells) } }
```

<!-- spec:begin compile -->

```ents
data board: *mut [2][3]i32 = mut [[1, 2, 3], [4, 5, 6]]
data grid: *[2][3]i32 = [[7, 1, 2], [3, 4, 5]]
data after: *[2]i32 = [77, 88]
data cube: *mut [2][2][2]i32 = mut [[[1, 2], [3, 4]], [[5, 6], [7, 8]]]

func clear() {
  for row in board { memzero(row) }
  for row in cube { for cells in row { memzero(cells) } }
}
func fill(i: u32#2) {
  memcpy(board[i], grid[i], 12)
}

test "rows are zeroed and copied one by one" {
  clear()
  assert board[1][2] == 0
  assert cube[1][1][1] == 0
  assert cube[0][1][0] == 0
  fill(1)
  assert board[1][0] == 3
  assert board[0][0] == 0
  assert after[0] == 77
}
```

<!-- spec:end -->

A name for the array is the array (reference 2.11): with `type Grid = [2][3]i32`, a `*Grid` is a `*[2][3]i32`, a table, and a `*Row` is a `*[3]i32`. They compile to the module written without the names.

<!-- spec:begin compile -->

```ents
type Row = [3]i32
type Grid = [2]Row
type Tab = *[2]Row

data grid: *Grid = [[1, 2, 3], [4, 5, 6]]
data tab: Tab = [[0, 1, 2], [3, 4, 5]]
data spare: *mut Row = mut [0, 0, 0]
data four: *[4]i32 = [7, 8, 9, 10]

func at(g: *Grid, i: u32, j: u32) -> i32 => if let r = g[i] { r[j] ?? -1 } else { -2 }
func total(g: *Grid) -> i32 {
  let n = 0
  for row in g {
    for x in row { n += x }
  }
  return n
}
func second(g: *Grid) -> i32 => (&g[1]).*[0]
func first(g: *Grid) -> i32 => if let r = g[1] { r[0] } else { 0 }
func last(r: *Row) -> i32 => r[r.len - 1]
func count(comptime T: type, s: []T) -> u32 => s.len
func copy(r: *Row) -> i32 {
  memcpy(spare, r, 12)
  return spare[2]
}
func lengths(r: *Row) -> u32 {
  let both = [r, four]
  return both[0].len + both[1].len
}
func rows(t: Tab) -> u32 => t.len + t[1].len

test "a pointer to a name for an array is a pointer to the array" {
  assert at(grid, 1, 2) == 6
  assert at(grid, 2, 0) == -2
  assert total(grid) == 21
  assert second(grid) == 4
  assert first(grid) == 4
  assert last(grid[1]) == 6
  assert count(grid) == 2
  assert count(grid[0]) == 3
  assert copy(grid[1]) == 6
  assert lengths(grid[0]) == 7
  assert rows(tab) == 5
  assert total(tab) == 15
}
```

```ents same-wasm
data grid: *[2][3]i32 = [[1, 2, 3], [4, 5, 6]]
data tab: *[2][3]i32 = [[0, 1, 2], [3, 4, 5]]
data spare: *mut [3]i32 = mut [0, 0, 0]
data four: *[4]i32 = [7, 8, 9, 10]

func at(g: *[2][3]i32, i: u32, j: u32) -> i32 => if let r = g[i] { r[j] ?? -1 } else { -2 }
func total(g: *[2][3]i32) -> i32 {
  let n = 0
  for row in g {
    for x in row { n += x }
  }
  return n
}
func second(g: *[2][3]i32) -> i32 => (&g[1]).*[0]
func first(g: *[2][3]i32) -> i32 => if let r = g[1] { r[0] } else { 0 }
func last(r: *[3]i32) -> i32 => r[r.len - 1]
func count(comptime T: type, s: []T) -> u32 => s.len
func copy(r: *[3]i32) -> i32 {
  memcpy(spare, r, 12)
  return spare[2]
}
func lengths(r: *[3]i32) -> u32 {
  let both = [r, four]
  return both[0].len + both[1].len
}
func rows(t: *[2][3]i32) -> u32 => t.len + t[1].len
```

<!-- spec:end -->

So it is at every depth, and through names of names: with `type Cube = [2][3][4]u8`, a `*Cube` is a table of tables, `c[1]` a `*[3][4]u8` loaded from it and `c[1][2]` a `*[4]u8` loaded from that, as in the `*[2][3][4]u8` it stands for. A slice or many-pointer of a name for rows, a table of names, and a type parameter that is one read the same way.

<!-- spec:begin compile -->

```ents
type Cube = [2][3][4]u8
type Box = Cube
type Plane = [3][4]u8
type Hyper = [2]Box

data cube: *Box = [[[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]], [[13, 14, 15, 16], [17, 18, 19, 20], [21, 22, 23, 24]]]
data planes: []Plane = [[[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]], [[13, 14, 15, 16], [17, 18, 19, 20], [21, 22, 23, 24]]]
data hyper: *Hyper = [[[[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]], [[[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 9]]]]

func at(c: *Box) -> u8 => c[1][2][3]
func plane(s: []Plane, i: u32) -> u8 => if let p = s[i] { p[2][3] } else { 0 }
func many(m: [*]Plane) -> u8 => m[1][2][3]
func deep(h: *Hyper) -> u8 => h[1][1][2][3]
func whole(comptime T: type, p: *T) -> u8 => p[1][2][3]
func viaWhole(c: *Box) -> u8 => whole(Cube, c)
func lens(c: *Cube) -> u32 => c.len * 100 + c[0].len * 10 + c[0][0].len

test "a name for an array of arrays is the table it stands for" {
  assert at(cube) == 24
  assert plane(planes, 1) == 24
  assert plane(planes, 2) == 0
  assert many(cube as [*]Plane) == 24
  assert deep(hyper) == 9
  assert viaWhole(cube) == 24
  assert lens(cube) == 234
}
```

```ents same-wasm
data cube: *[2][3][4]u8 = [[[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]], [[13, 14, 15, 16], [17, 18, 19, 20], [21, 22, 23, 24]]]
data planes: [][3][4]u8 = [[[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]], [[13, 14, 15, 16], [17, 18, 19, 20], [21, 22, 23, 24]]]
data hyper: *[2][2][3][4]u8 = [[[[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]], [[[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 9]]]]

func at(c: *[2][3][4]u8) -> u8 => c[1][2][3]
func plane(s: [][3][4]u8, i: u32) -> u8 => if let p = s[i] { p[2][3] } else { 0 }
func many(m: [*][3][4]u8) -> u8 => m[1][2][3]
func deep(h: *[2][2][3][4]u8) -> u8 => h[1][1][2][3]
func whole(comptime T: type, p: *T) -> u8 => p[1][2][3]
func viaWhole(c: *[2][3][4]u8) -> u8 => whole([2][3][4]u8, c)
func lens(c: *[2][3][4]u8) -> u32 => c.len * 100 + c[0].len * 10 + c[0][0].len
```

<!-- spec:end -->

## Ranges

`items[a..b]` is a slice of the elements from `a` up to (not including) `b`. Either bound can be left out. On a `*[N]T`, constant bounds are checked at compile time, and so are ranged ones whose types prove the range fits.

```ents
data text = "hello, world"

func parts(i: u32#8) -> u32 {
  let hello = text[0..5]
  let world = text[7..]
  let all = text[..]
  let head = text[..i]
  return hello.len + world.len + all.len + head.len
}
```

```ents
data text = "hello, world"

func f() -> u32 {
  return text[5..20].len
}
```

```errors
range 5..20 is out of bounds for *[12]u8
```

A range that can't be proven is an optional slice: none unless the start is at most the end and the end at most the length. On a slice, only the whole slice is known to fit.

```ents
func rest(s: []u8, i: u32) -> []u8 {
  return s[i..] ?? ""
}
```

```ents
func rest(s: []u8, i: u32) -> []u8 {
  return s[i..]
}
```

```errors
cannot assign ?[]u8 to []u8
```

A bound is an integer as an index is: of at most 32 bits, signed or not. A negative one is out of range, as a negative index is: read as an unsigned number it is past any length. On a many-pointer nothing is checked, and a negative bound is before the element it points to, as a negative index is. A bit pattern is the `u32` it stands for, in an index as in a bound: `~4294967293` is 2.

<!-- spec:begin compile -->

```ents
data xs = [1:i32, 2, 3, 4]

func at(i: i32) -> i32 => xs[i] ?? -1
func part(a: i32, b: i32) -> u32 => if let s = xs[a..b] { s.len } else { 99 }
func rest(s: []i32, a: i8) -> u32 => if let r = s[a..] { r.len } else { 99 }
func before(a: i32, b: i32) -> i32 {
  let p = xs as [*]i32 + 8
  let s = p[a..b]
  return (s[0] ?? 0) * 100 + s.len as i32
}
func pattern() -> i32 => xs[~4294967293] + xs[~4294967294..].len as i32

test "a negative bound is out of range, as a negative index is" {
  assert at(-1) == -1
  assert part(1, 3) == 2
  assert part(-1, 2) == 99
  assert part(0, -1) == 99
  assert part(-1, -1) == 99
  assert rest(xs, 1) == 3
  assert rest(xs, -1) == 99
  assert before(-2, 0) == 102
  assert pattern() == 6
}
```

<!-- spec:end -->

```ents
data xs = [1:i32, 2, 3, 4]

func a(i: u64) -> u32 => (xs[i..] ?? xs).len
func b() -> u32 => xs[-1..2].len
func c(f: f32) -> u32 => (xs[..f] ?? xs).len
```

```errors
a range bound must be an integer of at most 32 bits, not u64
range -1..2 is out of bounds for *[4]i32
a range bound must be an integer of at most 32 bits, not f32
```

A many-pointer has no length, so its ranges are unchecked and need an end.

```ents
func view(p: [*]u8, n: u32) -> []u8 {
  return p[0..n]
}

func tail(p: [*]u8) -> u32 {
  return p[1..].len
}
```

```errors
a range on a many-pointer needs an end
```

For the same reason it isn't a slice as it stands: only a pointer to a fixed-size array, which knows its length, becomes one by itself.

```ents
data text = "hello"

func length(s: []u8) -> u32 => s.len

func a() -> u32 => length(text)
func b(p: [*]u8, n: u32) -> u32 => length(p[0..n])
```

```ents
func length(s: []u8) -> u32 => s.len

func a(p: [*]u8) -> u32 => length(p)
func b(p: [*]u8) -> []u8 => p
```

```errors
argument 1: cannot assign [*]u8 to []u8
cannot assign [*]u8 to []u8
```

A slice or a pointer is a view of memory, so widening doesn't reach through it: a `u8` is a `u16`, but three bytes aren't three `u16`s. The elements have to be laid out the same; a narrower range or less mutability is fine.

```ents
func total(s: []u16) -> u32 => s.len
func bytes(s: []u8) -> u32 => s.len

func a(s: []mut u8) -> u32 => bytes(s)
func b(n: u8) -> u32 => total([n, 2, 3])
```

```ents
data raw = [1:u8, 2, 3]

func total(s: []u16) -> u32 => s.len

func a(s: []u8) -> u32 => total(s)
func b() -> u32 => total(raw)
```

```errors
argument 1: cannot assign []u8 to []u16
argument 1: cannot assign *[3]u8 to []u16
```

A string literal is bytes, so the same holds for one written where the slice is wanted: it is a slice of one-byte elements, and no other. Inside an array literal a string stands for its bytes or, where the elements are slices, for one of them.

```ents
data names: [][]u8 = ["ab", "c"]
data joined: []u8 = ["ab", "c"]

func bytes(s: []u8) -> u32 => s.len

func a() -> u32 => bytes("str")
func b() -> u32 {
  let signed: []i8 = "str"
  return signed.len
}
```

```ents
data words: []u32 = [1, "ab"]
data lists: [][]u16 = ["ab", [1, 2]]

func total(s: []u32) -> u32 => s.len

func a() -> u32 => total("str")
func b() -> []u16 => "abcd"
```

```errors
cannot use a string literal among u32 elements
cannot assign a string literal to []u16
argument 1: cannot assign a string literal to []u32 — a string is bytes ([]u8); write the u32 elements as an array literal ([1, 2, 3])
cannot assign a string literal to []u16
```

A literal in single quotes is codepoints, not a string: `'a'` is the integer 97, exactly as if `97` were written there, and `'ok'` is the tuple `(111, 107)`. Each character is one codepoint, whatever its UTF-8 bytes: `'é'` is 233, which a `u8` holds. So with `c: u8` a codepoint compares, computes, assigns, passes and matches as its number does. A string next to a pointer is the address of its bytes.

```ents
def newline = '\n'

func is_a(c: u8) -> bool => c == 'a'
func is_b(c: u8) -> bool => ('b') != c
func offset(c: u8) -> u8 => c - 'a'
func next() -> bool => 'a' + 1 == 98
func put() -> u8 {
  let c: u8 = 'a'
  return c
}
func take(c: u8) -> u8 => c
func give() -> u8 => take('a')
func vowel(c: u8) -> bool => match c {
  'a', 'e', 'i', 'o', 'u' => true
  _ => false
}
func is_e(c: u8) -> bool => c == 'é' || c == '\xE9' || c == '\u{e9}'
func at_end(c: u8) -> bool => c == newline || c == '\''
func lower(c: u8) -> bool => c >= 'a' && c <= 'z'
func pair() -> i32 {
  let (o, k) = 'ok'
  return o * 1000 + k
}
func tag(t: (u8, u8, u8, u8)) -> u8 => t.0
func riff() -> u8 => tag('RIFF')
func same(p: *[2]u8) -> bool => p == "ab"
```

A codepoint that does not fit is refused as its number is. A string is never a character, and a single-quoted literal is never a string, nor an address.

```ents
func latin() -> u8 {
  let c: u8 = '\u{101}'
  return c
}
func is_a(c: u8) -> bool => c == "a"
func before(c: u32) -> bool => c < "ab"
func put() { let c: u8 = "a" }
func greet(s: []u8) -> u32 => s.len
func hello() -> u32 => greet('hi')
func same(p: *[2]u8) -> bool => p == 'ab'
func first(p: *u8) -> u8 => p.*
func a() -> u8 => first('a')
func vowel(c: u8) -> bool => match c {
  "a" => true
  _ => false
}
func ok(t: (u8, u8)) -> bool => match t {
  'ok' => true
  _ => false
}
```

```errors
cannot assign int(257) to u8
'==' cannot be applied to u8 and a string — a string is bytes in memory, not a character: a character is written in single quotes ('a')
'<' cannot be applied to u32 and a string — a string is bytes in memory, not a character
cannot assign *[1]u8 to u8 — a string is bytes in memory, not a character: a character is written in single quotes ('a')
argument 1: cannot assign 'hi' to []u8 — a single-quoted literal is codepoints, not a string: a string is written with double quotes ("hi")
'==' cannot be applied to *[2]u8 and 'ab' — a single-quoted literal is codepoints, not a string: a string is written with double quotes ("ab")
argument 1: cannot assign 'a' to *u8 — a single-quoted literal is codepoints, not a string: a string is written with double quotes ("a")
cannot match u8 against a string — a string is bytes in memory, not a character: a character is written in single quotes ('a')
'ok' is a tuple of codepoints, and match cannot compare a tuple pattern yet: compare one field at a time
```

Nor is one a slice in data:

```ents
data greeting: []u8 = 'hi'
```

```errors
cannot assign 'hi' to []u8 — a single-quoted literal is codepoints, not a string: a string is written with double quotes ("hi")
```

Single quotes hold at least one character, and an escape names a character: `\u{D800}` to `\u{DFFF}` are UTF-16 surrogates, and none is past `\u{10FFFF}`.

```ents
func f() -> u8 => ''
```

```errors
'' holds no character: write one or more between single quotes, or "" for an empty string
```

```ents
func f() -> u32 => '\u{d800}'
```

```errors
\u{d800} is not a character: D800 to DFFF are UTF-16 surrogates, not codepoints
```

Assigning to a range fills it (`buf[a..b] = 0`) or copies into it (`buf[a..b] = src`), as `memory.fill` and `memory.copy`. The range is written, so it must be known to fit, like an indexed write. A fill can have a runtime length; a copy needs both lengths known at compile time, and equal.

```ents
data buf = mut [0:u8; 16]
data src = [1:u8, 2, 3, 4]

func f(n: u32#17) {
  buf[..] = 0
  buf[..n] = 1
  buf[4..8] = src
  buf[0..2] = src[2..4]
}
```

```ents
data buf = mut [0:u8; 16]
data src = [1:u8, 2, 3, 4]

func a(i: u32) { buf[i..] = 0 }
func b() { buf[0..8] = src }
func c(s: []u8) { buf[0..4] = s }
```

```errors
writing to a range needs bounds known to fit
cannot copy 4 elements into a range of 8
copying into a range needs both lengths known at compile time; use memcpy
```

A value that can be assigned to one element fills the range, whatever the element is: a struct, a slice, a string where the elements are slices, a wide integer, a row pointer of a table. Anything else is copied in: an array literal is laid out as the range's elements are, and an array held in registers is stored element by element. A generic fills with a value of its type parameter for any type.

<!-- spec:begin compile -->

```ents
type Pt = (x: i32, y: i32)

data cells = mut [0:u8; 64]
data grid: *mut [3][2]i32 = mut [[1, 2], [3, 4], [5, 6]]
data spare: *mut [2]i32 = mut [9, 8]
data wide = mut [0:u128; 4]
data ints = mut [0:i32; 4]

func points(v: Pt) {
  let p = cells as [*]mut Pt
  p[0..3] = v
}
func lists(xs: []i32) {
  let p = cells as [*]mut []i32
  p[0..3] = xs
}
func names() {
  let p = cells as [*]mut []u8
  p[1..3] = "abc"
}
func rows() { grid[0..2] = spare }
func big() { wide[1..3] = 5 }
func literal(x: i32) { ints[1..4] = [x, 7, 8] }
func held() {
  let a: [2]i32 = [5, 6]
  ints[0..2] = a
}
func table(comptime T: type, n: u32, v: T) -> [*]mut T {
  let p = cells as [*]mut T
  p[0..n] = v
  return p
}

test "a range is filled with a struct, a slice, a row pointer, a wide integer" {
  points((x: 3, y: -4))
  assert (cells as [*]Pt)[2].y == -4
  assert (cells as [*]i32)[6] == 0
  lists([1, 2, 3, 4])
  assert (cells as [*][]i32)[2].len == 4
  assert ((cells as [*][]i32)[2].ptr)[3] == 4
  names()
  assert (cells as [*][]u8)[2].len == 3
  assert (cells as [*][]u8)[0].len == 4
  rows()
  grid[0][0] = 1
  assert grid[1][0] == 1
  assert grid[2][0] == 5
  big()
  assert wide[0] == 0
  assert wide[2] == 5
  assert wide[3] == 0
}

test "an array literal or an array in registers is copied in" {
  literal(9)
  held()
  assert ints[0] == 5
  assert ints[1] == 6
  assert ints[2] == 7
  assert ints[3] == 8
}

test "a generic fills with a value of its type parameter" {
  assert table(i32, 4, -2)[3] == -2
  assert table([]u8, 4, "xy")[3].len == 2
  assert table(Pt, 4, (x: 1, y: 2))[3].x == 1
}
```

<!-- spec:end -->

A fill value that is no element, or a copy whose elements are not the range's, is refused for what it is. A table's elements are its row pointers: rows of a const table are not copied into a mutable one, as `m[i] = r` is refused for them, and an array in registers has no rows to point to. A value of the element type as it is written, a row in registers, or a const row for a mutable table, is meant to fill, and is refused as `m[i] = r` is.

```ents
type Pt = (x: i32, y: i32)

data cells = mut [0:u8; 64]
data grid: *[2][2]i32 = [[1, 2], [3, 4]]
data board: *mut [2][2]i32 = mut [[0, 0], [0, 0]]

func a() {
  let p = cells as [*]mut Pt
  p[0..3] = 0
}
func b(xs: []u8) {
  let p = cells as [*]mut []i32
  p[0..3] = xs
}
func c() { board[0..2] = grid }
func d() { board[0..2] = [[1, 2], [3, 4]] }
func e() {
  let v: [2][2]i32 = [[1, 2], [3, 4]]
  board[0..2] = v
}
func f(row: [2]i32) { board[0..2] = row }
func g() { board[0..2] = grid[1] }
func h(comptime T: type, p: *mut [2]T, v: T) { p[0..2] = v }
func k(row: [2]i32) { h([2]i32, board, row) }
```

```errors
fill value: cannot assign int(0) to Pt
cannot copy []u8 into a range of []i32
cannot copy *[2][2]i32 into a range of *mut [2]i32: its rows are *[2]i32
a literal is constant: write `mut [[1, 2], [3, 4]]` for a *mut [2][2]i32
cannot copy [2][2]i32 into a range of *mut [2]i32: its rows are held in registers
fill value: cannot assign [2]i32 to *mut [2]i32
fill value: cannot assign *[2]i32 to *mut [2]i32
fill value: cannot assign [2]i32 to *mut [2]i32, in h(T = [2]i32)
```

## Builtins

The operands of a numeric builtin are typed together, as the operands of a binary operator are. A literal takes the type of the other operand, whichever of them comes first; with only literals, they take their default type.

```ents
func at_least_one(x: f64) -> f64 => max(1.0, x)
func at_most_one(x: f32) -> f32 => min(x, 1.0)
func not_negative(n: i64) -> i64 => max(0, n)
func sign_of(x: f32) -> f32 => copysign(1.0, x)
func constants() -> f64 => sqrt(2.0) + nearest(2.5) + min(3.0, 5.0) + copysign(5.0, -1.0)
func whole() -> i32 => abs(-5) + max(1, 2)
```

```ents
func f(x: u8) -> u8 => max(300, x)
func g(x: i32) -> i32 => min(x, 1.5)
```

```errors
max: cannot assign int(300) to u8
min: cannot assign float(1.5) to i32
```

Typed operands meet at the wider of their types. Types that neither widen to the other don't mix.

```ents
func widest(a: i32, b: i64) -> i64 => max(a, b)
func least(a: u64, b: u8) -> u64 => min(a, b)
func with_sign(x: f32, y: f64) -> f64 => copysign(x, y)
```

```ents
func f(a: u32, b: i32) -> u32 => max(a, b)
func g(a: f32, b: i64) -> f32 => min(a, b)
```

```errors
max: cannot assign i32 to u32
min: cannot assign i64 to f32
```

`sqrt`, `ceil`, `floor`, `trunc`, `nearest` and `copysign` take floats; `min`, `max` and `abs` take any numeric type.

```ents
func f(n: i32) -> f64 => sqrt(n)
func g(b: bool) -> bool => max(b, b)
```

```errors
sqrt requires a float type, got i32
max requires a numeric type, got bool
cannot assign i32 to bool
```

`clz`, `ctz` and `popcnt` take an `i32`, `u32`, `i64` or `u64` and return a `u8`, which widens to any integer type.

```ents
func leading(x: u32) -> u8 => clz(x)
func ones(x: u64) -> u32 => popcnt(x)
func strip(x: u64) -> u64 => x >> ctz(x)
```

```ents
func f(x: u8) -> u8 => clz(x)
func g(x: u128) -> u8 => popcnt(x)
func h(x: f64) -> u8 => ctz(x)
```

```errors
clz requires i32, u32, i64 or u64, got u8
popcnt requires i32, u32, i64 or u64, got u128
ctz requires an integer type, got f64
```

`min` and `max` return one of their operands, so the result is in a range when every operand is.

```ents
data table = [10:u8, 20, 30, 40]

func clamped(i: u32#4) -> u8 => table[min(i, 2)]
func either(i: u32#4, j: u32#2) -> u8 => table[max(i, j)]
```

```ents
data table = [10:u8, 20, 30, 40]

func f(i: u32#4) -> u8 => table[max(i, 9)]
```

```errors
runtime index on *[4]u8 requires 'if let' or '??'
```

A constant operand counts by its value. An `if` is not one, and it has no range either: it can be any of its arms.

```ents
data table = [10:u8, 20, 30, 40]
def last = 3

func capped(i: u32#4) -> u8 => table[min(i, last)]
```

```ents
data table = [10:u8, 20, 30, 40]

func f(i: u32#4, far: bool) -> u8 => table[max(i, if far { 100 } else { 1 })]
func g(i: u32#4, far: bool) -> u8 => table[max(if far { 1 } else { 100 }, i)]
func h(i: u32#4, j: u32#4, far: bool) -> u8 => table[max(i, if far { j } else { 9 })]
```

```errors
runtime index on *[4]u8 requires 'if let' or '??'
runtime index on *[4]u8 requires 'if let' or '??'
runtime index on *[4]u8 requires 'if let' or '??'
```

An `if` or a `match` operand has the type its arms widen to, like any `if`, and then widens to the other operand's as a whole. One of constants alone takes the other operand's type, arm by arm.

```ents
func mirror(x: i64, flip: bool) -> i64 => max(x, if flip { 0 - x } else { x })
func stepped(x: i64, k: i32) -> i64 => max(x, match k {
  0 => x + 1
  _ => 5
})
func widened(x: i64, a: i32, small: bool) -> i64 => max(x, if small { a } else { 5 })
```

An arm can have statements before its value. A `let` among them is declared once, also where the operand is checked a second time to give its constants the other operand's type.

```ents
func floored(x: i64, strict: bool) -> i64 => max(x, if strict {
  let margin = 3
  5
} else { 2 })
```

```ents
func f(x: f32, c: bool) -> f32 => max(x, if c { x } else { 1.5:f64 })
```

```errors
cannot assign f64 to f32
```

`mul_hi` multiplies two `u64`s: a narrower unsigned operand widens, a signed one doesn't.

```ents
func high(a: u32, b: u64) -> u64 => mul_hi(a, b)
func scaled(a: u64) -> u64 => mul_hi(a, 0x8000000000000000)
```

```ents
func f(a: i64, b: u64) -> u64 => mul_hi(a, b)
func g(a: u64) -> u64 => mul_hi(a, -1)
```

```errors
mul_hi: cannot assign i64 to u64
mul_hi: cannot assign int(-1) to u64
```

A function the program declares takes the builtin's name. A variable in scope hides that function, and the name is the builtin's again.

```ents
func max(a: i32, b: i32, c: i32) -> i32 => a + b + c

func all() -> i32 => max(1, 2, 3)
func either(max: i32, other: i32) -> i32 => max(max, other)
```

```ents
func max(a: i32, b: i32, c: i32) -> i32 => a + b + c

func f() -> i32 => max(1, 2)
```

```errors
'max' expected 3 arguments, got 2
```

`memcpy` reads from a pointer to an array; `memzero` needs a destination whose size is known.

```ents
data buf = mut [0:u8; 16]

func from_slice(s: []u8) { memcpy(buf, s, 8) }
func zero(p: *mut [!]u8) { memzero(p) }
```

```errors
memcpy src: expected *[N]T, got []u8
memzero dest: *mut [!]u8 has no size known at compile time
```

## Functions that share a name

Two functions may have one name when their parameter lists differ in length or in types. A call means the one whose parameter types are the argument types.

```ents
func size(a: u8) -> u32 => 1
func size(a: u32) -> u32 => 4
func size(a: u64) -> u32 => 8
func size(a: u32, b: u32) -> u32 => 8
func size(p: *u8) -> u32 => 1
func size(p: *mut u8) -> u32 => 2
func size() -> u32 => 0

func exact(a: u8, b: u32, c: u64) -> u32 => size(a) + size(b) + size(c) + size(b, b) + size()
func writable(p: *mut u8, q: *u8) -> u32 => size(p) + size(q)
func counted() -> (n: u32) {
  for i in 12 {
    n += size(i)             // a u32 that is known to lie in a range is a u32
  }
}
```

An untyped literal has no type of its own: beside typed arguments it only has to fit, and the function whose typed arguments match exactly is the one meant, before one that would convert them.

```ents
func gt(a: u32, b: u32) -> bool => a > b
func gt(a: f64, b: f64) -> bool => a > b
func put(a: u8, b: u8) -> u32 => 1
func put(a: u8, b: u32) -> u32 => 2

func typed(x: u32, y: f64, z: u8) -> u32 => if gt(x, 10) && gt(10, x) && gt(y, 10) && x.gt(3) { put(z, 300) } else { put(z, 3:u8) }
```

So in a tuple, a struct literal or `&` of one: its typed parts are exact where they are the parameter's, and its literals only have to fit.

```ents
type P32 = (x: u32, y: u32)
type P64 = (x: u64, y: u64)
func far(p: (u32, u32)) -> u32 => 1
func far(p: (u64, u64)) -> u32 => 2
func near(p: P32) -> u32 => 1
func near(p: P64) -> u32 => 2
func at(p: *(u32, u32)) -> u32 => 1
func at(p: *(f64, f64)) -> u32 => 2

func parts(i: u32, w: u64) -> u32 => far((i, 1)) + far((1, w)) + near((x: i, y: 1)) + near((x: 1, y: w)) + at(&(i, 1))
```

Where two are exact alike, as `put(z, 3)` is for both `put`s, that is still ambiguous (below), and so is a call where each function would convert something: `m((i, 1), j)` for `m(p: (u64, u64), q: u32)` and `m(p: (u32, u32), q: u64)`.

Without such a function, it means the only one the arguments can be passed to, with the conversions an argument gets.

```ents
func show(n: u64) -> u32 => 8
func show(s: []u8) -> u32 => s.len
func fill(b: []u8) -> u32 => 1
func fill(b: []u32) -> u32 => 4

data four = [1:u8, 2, 3, 4]

func widened(a: u8, b: u32) -> u32 => show(a) + show(b) + show(7)
func strings() -> u32 => show("text") + show(four)
func literals() -> u32 => fill([1, 300]) + fill("ab")       // 300 is no u8; a string is no []u32
```

No function that takes the arguments is one error, and so is more than one that could.

```ents
type Cell = (x: i32, y: i32)

func hash(k: u32) -> u32 => k
func hash(k: u64) -> u32 => 1
func put(a: u8, b: u8) -> u32 => 1
func put(a: u8, b: u32) -> u32 => 2

func a(c: Cell) -> u32 => hash(c)
func b(x: f64) -> u32 => hash(x, x)
func c() -> u32 => hash(5)
func d(x: u8) -> u32 => hash(x)
func e() -> u32 => hash()
func f(z: u8) -> u32 => put(z, 3)
func m(p: (u64, u64), q: u32) -> u32 => 1
func m(p: (u32, u32), q: u64) -> u32 => 2
func g(i: u32, j: u32) -> u32 => m((i, 1), j)
```

```errors
no function 'hash' accepts (Cell)
no function 'hash' accepts (f64, f64)
'hash' is ambiguous for (int(5))
'hash' is ambiguous for (u8)
no function 'hash' accepts ()
'put' is ambiguous for (u8, int(3))
'm' is ambiguous for ((u32, int(1)), u32)
```

An argument with an error of its own is that error alone, and nothing more is said of what the call's value is used for.

```ents
func hash(k: u32) -> u32 => k
func hash(k: u64) -> u32 => 1

func a() -> u32 => hash(nope)
func b(x: f64) -> bool => hash(hash(x))
```

```errors
unknown identifier 'nope'
no function 'hash' accepts (f64)
```

Two functions of one name need different parameter types. The names of the parameters, the result and a name for a type do not tell them apart; a type declared further down is the type it names.

```ents
type Meters = u32

func hash(k: u32) -> u32 => k
func hash(n: Meters) -> u64 => 1
func none() { }
func none() -> u32 => 0
func late(a: Later) -> i32 => a.x
func late(a: (x: i32)) -> i32 => 1

type Later = (x: i32)
```

```errors
'hash' is already declared with parameters (u32)
'none' is already declared with parameters ()
'late' is already declared with parameters (Later)
```

An imported function shares a name like a declared one.

```ents
import "env" (
  "log_u32" func log(x: u32)
  "log_f64" func log(x: f64)
)
func log(s: []u8) { }

export func f(n: u32, x: f64) {
  log(n)
  log(x)
  log("done")
}
```

```ents
import "env" (
  "a" func log(x: u32)
  "b" func log(y: u32)
)
```

```errors
'log' is already declared with parameters (u32)
```

A function the program declares with the name of a builtin takes the builtin's place, and shares the name only with other declared functions.

```ents
type Pt = (q: i32, r: i32)

func max(a: Pt, b: Pt) -> Pt => if a.q > b.q { a } else { b }
func max(a: f64, b: f64) -> f64 => if a > b { a } else { b }

func f(p: Pt, x: f64) -> f64 => (max(p, p).q as f64) + max(x, 1.5)
func g(a: i64) -> i64 => max(a, a)
```

```errors
no function 'max' accepts (i64, i64)
```

Each export needs a name of its own, whatever is exported.

```ents
export func hash(k: u32) -> u32 => k
export "hash_bytes" func hash(k: []u8) -> u32 => k.len
```

```ents
export func hash(k: u32) -> u32 => k
export func hash(k: []u8) -> u32 => k.len
export "hash" global seed: u32 = 1
```

```errors
export name 'hash' is used twice: give one an explicit name, as in export "hash_2" func hash(...)
export name 'hash' is used twice: give one an explicit name, as in export "hash_2" global seed
```

A function declared in a `test` block does not share: it takes over the name, as it always has.

```ents
func hash(k: u32) -> u32 => k

test "its own hash" {
  func hash(k: u64) -> u32 => 1
  assert hash(1:u64) == 1
}
```

A name that several functions of the module share cannot be taken over: there is no one function to stand in for, and the module's own calls would choose among other functions in a test build than in the build that ships.

```ents
func hash(k: u32) -> u32 => k
func hash(k: u64) -> u32 => 1

test "its own hash" {
  func hash(k: f64) -> u32 => 2
  assert hash(1.5) == 2
}
```

```errors
'hash' is the name of several functions of the module: a function declared in a test cannot take it over
```

The name of several functions is no function value: only the arguments of a call say which one is meant.

```ents
func inc(a: u64) -> u64 => a + 1
func inc(a: u32) -> u32 => a + 1
func apply(g: (u32) -> u32, x: u32) -> u32 => x

func f(x: u32) -> u32 => apply(inc, x)
```

```errors
'inc' is the name of several functions: it can only be called, where the arguments say which one
```

## Calling a function value

A function is called by its name. One held in a parameter, a local, a global or a field has no run-time form yet, and calling it is one error.

```ents
type Handler = (run: (u32) -> u32, arg: u32)

func inc(a: u32) -> u32 => a + 1
func apply(f: (u32) -> u32, x: u32) -> u32 => f(x)
func stored(x: u32) -> u32 {
  let g = inc
  return g(x)
}
func field(h: Handler) -> u32 => h.run(h.arg)
```

```errors
calling a function value is not supported yet: only a function named directly, or a comptime function parameter (comptime f: (u32) -> u32), can be called
calling a function value is not supported yet: only a function named directly, or a comptime function parameter (comptime f: (u32) -> u32), can be called
calling a function value is not supported yet: only a function named directly, or a comptime function parameter (comptime f: (u32) -> u32), can be called
```

Its arguments are still checked.

```ents
func apply(f: (u32) -> u32, x: f64) -> u32 => f(x)
```

```errors
calling a function value is not supported yet
argument 1: cannot assign f64 to u32
```

## Types in parentheses

One type without a name in parentheses is that type, wherever it is written: there is no tuple of one element.

```ents
type W = (u32)
type Q = (x: i32, y: i32)

func id(comptime T: type, a: T) -> T => a
func twice(a: (u32)) -> ((u32)) => a * 2
func f(a: W, b: u32) -> u32 {
  let c: (u32) = twice(a) + id((u32), b)
  return c as (u32)
}
func g(a: i32, b: i32) -> i32 => (Q)(a, b).y
```

A name makes a struct of one field, which is not the type of its field.

```ents
func h(a: f64) -> f64 {
  let s: (v: f64) = a
  return s
}
```

```errors
cannot assign f64 to (v: f64)
cannot assign (v: f64) to f64
```
