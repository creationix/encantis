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

A constant operand counts by its value. An `if` of two literals is not one: it can be either of them.

```ents
data table = [10:u8, 20, 30, 40]
def last = 3

func capped(i: u32#4) -> u8 => table[min(i, last)]
```

```ents
data table = [10:u8, 20, 30, 40]

func f(i: u32#4, far: bool) -> u8 => table[max(i, if far { 100 } else { 1 })]
func g(i: u32#4, far: bool) -> u8 => table[max(if far { 1 } else { 100 }, i)]
```

```errors
runtime index on *[4]u8 requires 'if let' or '??'
runtime index on *[4]u8 requires 'if let' or '??'
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
