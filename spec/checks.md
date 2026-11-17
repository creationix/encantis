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
runtime index on *[16]u8 requires 'if let' or '??'
runtime index on *[16]u8 requires 'if let' or '??'
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
runtime index on *[12]u8 requires 'if let' or '??'
runtime index on *[12]u8 requires 'if let' or '??'
runtime index on *[12]u8 requires 'if let' or '??'
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
