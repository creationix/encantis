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

Copying or filling through a range isn't implemented yet:

```ents
data buf = mut [0:u8; 16]

func clear() {
  buf[0..8] = 0
}
```

```errors
assigning to a range (bulk copy or fill) is not supported yet
```
