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
cannot write through const slice
```

## Globals

A global can be a slice, a struct or a wide integer.

```ents
type Size = (w: i32, h: i32)

global order: []i32 = (0, 0)
global size: Size = Size(3, 4)
global total: u128 = 0

func f(s: []i32) -> u32 {
  order = s
  size.h += 1
  total += 1
  return order.len
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
