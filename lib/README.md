# lib

Small helpers written in Encantis. They're plain source files: import them by relative path, or copy them next to your program.

- `io.ents` and `text.ents` are for programs that read text and print results (Advent of Code style). They don't allocate: input goes into a buffer you provide, and parsing returns slices of it.
- `stack.ents`, `vec.ents`, `set.ents`, `map.ents` and `sort.ents` are generic containers, for any element or key type, on a bump stack. Each element type is its own copy of the functions that use it, so a container costs what the same code written for that one type would.

## io.ents

Standard input and output over WASI, for programs run with `encantis run`.

| Function | What it does |
| --- | --- |
| `read_all(buf: []mut u8) -> []u8` | Reads all of stdin into `buf`, returns the filled part |
| `print(s: []u8)`, `println(s: []u8)` | Writes `s` (and a newline) to stdout |
| `print_u64(n: u64)`, `print_i64(n: i64)` | Writes a number and a newline |

## text.ents

| Function | What it does |
| --- | --- |
| `eq(a, b) -> bool`, `starts_with(s, prefix) -> bool` | Compare bytes |
| `index_of(s, c) -> u32` | First index of byte `c`, or `s.len` |
| `split_once(s, c) -> (head, rest)` | Split at the first `c` |
| `next_line(s) -> (line, rest)` | The first line (without `\n`) and what follows |
| `skip_spaces(s) -> []u8` | `s` without leading spaces |
| `parse_u64(s) -> (value, rest, ok)`, `parse_i64(...)` | A decimal number after any spaces, and what follows it |

## stack.ents

A bump stack of 256 KiB. Nothing is freed one by one: a scope takes a mark and resets to it, and `defer` does that on every way out.

| Function | What it does |
| --- | --- |
| `mark() -> u32`, `reset(m: u32)` | The top of the stack, and freeing everything allocated since |
| `alloc(n: u32) -> u32`, `zeroed(n: u32) -> u32` | `n` bytes, 8-byte aligned (zeroed: all zero). Traps when the stack is full |
| `extend(n: u32) -> u32` | `n` more bytes right after the top |

## vec.ents

`Vec(T)` is `(ptr: [*]mut T, len: u32, cap: u32)`, used through the `*mut Vec(T)` that `vec` returns.

| Function | What it does |
| --- | --- |
| `vec(T, cap) -> *mut Vec(T)` | An empty Vec with room for `cap` |
| `v.push(x)`, `v.pop() -> T`, `v.last() -> T` | At the end. One at the top of the stack grows in place; any other is copied |
| `v.items() -> []T`, `v.items_mut() -> []mut T` | The elements, until the next push |
| `v.clear()` | Empties it |

An element that is a fixed array is a table of rows (reference 2.5): `Vec([3]i32)` holds row pointers, and a push of a `[3]i32` is refused. A struct with an array field lies in place: `Vec((cells: [3]i32))` holds packed rows.

## set.ents and map.ents

`Set(K)` and `Map(K, V)` hash with open addressing and double when half full.

| Function | What it does |
| --- | --- |
| `hashset(K, bits) -> *mut Set(K)` | An empty set of 2^bits slots to start with |
| `s.add(k) -> bool`, `s.has(k) -> bool`, `s.count` | Add (true where `k` is new), test, count |
| `map(K, V, bits) -> *mut Map(K, V)` | An empty map |
| `m.insert(k, v) -> bool` | Set `k`'s value (true where `k` is new) |
| `m.lookup(k) -> ?*mut V`, `m.get_or(k, fallback) -> V` | `k`'s value, to change in place or to read |

A set or a map calls `hash(k)` and `eq(a, b)` for its key type. `set.ents` has them for `u32`, `u64`, `i32`, `i64`, `[]u8` and `[]u32` (exported as `hash_u32`, `eq_u32`, ...). For a key type of your own, write them in the module that makes the set: a call in a generic's body that its own module has no function for is looked up in the module whose code made the instance.

```text
type Cell = (x: i32, y: i32)
func hash(c: Cell) -> u32 => ((c.x * 73856093) ^ (c.y * 19349663)) as u32
func eq(a: Cell, b: Cell) -> bool => a.x == b.x && a.y == b.y
```

## sort.ents

| Function | What it does |
| --- | --- |
| `xs.sort(before)` | Sorts `xs: []mut T` in place, stably. `before(a, b)` says `a` comes first |
| `xs.is_sorted(before) -> bool` | Whether it is sorted |
| `xs.lower_bound(x, before) -> u32` | Where `x` goes in sorted `xs` |

`before` is a comptime function parameter: the name of a function, from any module. Each comparator is its own copy of `sort`, which calls it directly.

## What a program gets of them

A generic is in the program only for the types it is used with, and one the program never uses is not there at all. The ordinary functions of a module are in every program that imports it, used or not, as for any module: `set.ents` brings its twelve `hash` and `eq` functions (and `map.ents`, which imports them, those too), and `sort.ents` the four small comparators its tests use.

## Using them

Source imports list the functions they use, with their signatures:

```ents
import "../lib/io" (
  "read_all" func read_all(buf: []mut u8) -> []u8
  "print_u64" func print_u64(n: u64)
)
import "../lib/text" (
  "next_line" func next_line(s: []u8) -> (line: []u8, rest: []u8)
)

export memory

data input = mut [0:u8; 65536]

export "_start" func main() {
  let text = read_all(input)
  // ...
}
```

`examples/aoc/day1.ents` is a complete program: `encantis run examples/aoc/day1.ents < input.txt`.

The generics of the containers are imported with their signatures too, and a generic type as the function it is:

```text
import "../lib/stack" (
  "mark" func mark() -> u32
  "reset" func reset(m: u32)
)
import "../lib/vec" (
  "Vec" func Vec(comptime T: type) -> type
  "vec" func vec(comptime T: type, cap: u32) -> *mut Vec(T)
  "push" func push(comptime T: type, v: *mut Vec(T), x: T)
  "items" func items(comptime T: type, v: *Vec(T)) -> []T
)

export func total(n: u32) -> (s: u32) {
  let scope = mark()
  defer reset(scope)
  let v = vec(u32, 16)
  for i in n {
    v.push(i)
  }
  for x in v.items() {
    s += x
  }
}
```

`examples/containers/main.ents` uses all of them.
