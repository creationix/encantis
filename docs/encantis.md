# Encantis Language Reference

Encantis is a systems programming language that compiles to WebAssembly. It provides direct memory control, explicit types, and zero-cost abstractions while generating compact, efficient WASM modules.

**Grammar source of truth:** [`packages/compiler/encantis-grammar.ohm`](../packages/compiler/encantis-grammar.ohm) (authoritative). This document is an explanatory guide with examples; consult the Ohm grammar for exact syntax.

---

## 1. Lexical Structure

### 1.1 Comments

```ents
// Single line comment
/* Block comment */
```

### 1.2 Identifiers

Identifiers can contain letters, digits, underscores, and hyphens. They must start with a lowercase letter:

```ents
count           // simple
prime32-1       // hyphenated
merge-round64   // hyphenated
my_var_2        // underscores and digits
```

Hyphens in identifiers are idiomatic for constants and helper functions. A name holds its hyphens wherever it stands, after a dot too (`x.u32-count` is the member `u32-count`), so a subtraction is written with spaces: `n - 1`. The formatter prints every binary `-` that way.

### 1.3 Type Identifiers

User-defined type names must start with a capital letter. This distinguishes them from primitive types (`i32`, `f64`, etc.) and regular identifiers:

```ents
type Point = (x:f32, y:f32)      // OK: Point starts with capital
type point = (x:f32, y:f32)      // ERROR: type names must be capitalized
```

This convention allows the parser to distinguish type references from variable references without forward declarations:

```ents
func distance(a:Point, b:Point) -> f32   // Point is a type
let point = Point(1.0, 2.0)              // point is a variable, Point is a constructor
```

A type can be named anywhere in its module, above its declaration as well as below it: in another type, a signature, a global's or a `data`'s type and initializer. The types of a module are resolved before anything else in it, so names that lead to one another resolve in whatever order they are declared.

<!-- spec:begin compile -->

```ents
global origin: Pair = (1, 2)
data corners: *[2]Pair = [(3, 4), (5, 6)]
type Pair = (first: Coord, second: Coord)
type Coord = Size
type Size = u32

export func far() -> Size => origin.first + origin.second + corners[1].second
```

<!-- spec:end -->

The type parameters of a generic function are type identifiers too: in `func max(comptime T: type, a: T, b: T)`, `T` is a type inside the function (see [8. Generics](#8-generics)).

### 1.4 Reserved Keywords

The following identifiers are reserved keywords in Encantis (aligns with `encantis.ohm`):

**Control Flow:** `if`, `elif`, `else`, `match`, `while`, `for`, `in`, `loop`, `break`, `continue`, `return`, `when`, `defer`

**Declarations:** `func`, `let`, `set`, `global`, `def`, `data`, `type`, `import`, `export`, `memory`, `inline`, `comptime`

**Types / Builtins:** `int`, `float`

**Operator:** `as`

### 1.5 Literals

#### Integer Literals

```ents
42              // decimal, inferred as i32
0xFF            // hexadecimal
0b1010          // binary
0o755           // octal
0d1a            // dozenal (base 12): 1*12 + 10 = 22

42:i64          // explicit type annotation
255:u8          // explicit type annotation
```

Unsuffixed literals are "natural" values that adapt to their context. When no context is available, they default to either `i32` or `i64` based on size.

#### Float Literals

```ents
3.14            // inferred as f64
1.0e-10         // scientific notation
2.5:f32         // explicit type annotation
```

Float literals default to `f64`. Decimal-to-binary conversion is inherently lossy, so float literals accept the closest representable approximation.

#### String Literals

```ents
"hello"           // UTF-8 string literal
"line1\nline2"    // escape sequences: \n \t \r \\ \' \"
"\xE9"            // \xHH is the byte HH: one byte
"\u{e9}"          // \u{H..} is a character by its codepoint: its UTF-8 bytes, two here
x"aabbccdd"       // hex bytes: bytes 0xAA, 0xBB, 0xCC, 0xDD
b"SGVsbG8="       // base64 bytes
```

A string is written in double quotes; single quotes hold codepoints ([Codepoint Literals](#codepoint-literals)). The `x` and `b` prefixes take double quotes only. String literals live in the data section. They are comptime byte arrays that can coerce to any compatible slice type: `[]u8`, `[!]u8` (null-terminated), `[?]u8` (LEB128-prefixed), `[*]u8` (many-pointer), etc. With no type to meet (`let s = "abc"`, the source of `buf[0..3] = "abc"`, a branch of an untyped `if`), a string is a `*[N]u8`, a pointer to its bytes; `mut "abc"` is a `*mut [3]u8` to a copy of its own.

A slice counts elements, so a string is only a slice of one-byte elements: `"abc"` for a `[]u32` is a compile error, as three bytes are not three `u32`s. Write the elements as an array literal (`[1, 2, 3]`).

A string is never a character: next to a number, given for one or matched against one it is an error, which shows how the character is written (`'==' cannot be applied to u8 and a string — a string is bytes in memory, not a character: a character is written in single quotes ('a')`).

#### Codepoint Literals

Single quotes hold codepoints, not a string. Each character between them is one codepoint (a Unicode scalar value, never a byte of its UTF-8 encoding), and each codepoint is exactly the integer literal of its value, as if the number were written in its place:

```ents
'a'               // 97
'é'               // 233: a u8 holds it, as it holds 233
'ā'               // 257: too big for a u8, as 257 is
'\n'              // 10; also \t \r \\ \' \" (and ' needs no escape in "don't")
'\x7F'            // 127: \xHH is the codepoint HH
'\u{1F600}'       // 128512: \u{H..} is the codepoint H..
'ok'              // the tuple (111, 107)
```

One codepoint is the value itself, as a parenthesised value is (`'a'` is `(97)`, which is `97`), so it compares, computes, assigns, passes and matches as its number does. With `c: u8`:

```ents
def newline = '\n'

func is_lower(c: u8) -> bool => c >= 'a' && c <= 'z'
func digit(c: u8) -> u8 => c - '0'
func vowel(c: u8) -> bool => match c {
  'a', 'e', 'i', 'o', 'u' => true
  _ => false
}
```

Several codepoints are the tuple of them, values in registers like any tuple: `let (x, y) = 'ok'` binds 111 and 107, and `'RIFF'` passes for a `(u8, u8, u8, u8)` as `(82, 73, 70, 70)` does. A tuple is not an array, so `'abc'` is no `[3]u8`, and neither it nor `(97, 98, 99)` is a row of a table, an element of a `[][3]u8` or what a `*[3]u8` points at: for those, write the string `"abc"` or the array `[97, 98, 99]`.

A single-quoted literal is never a string, nor an address: where a pointer or a slice is wanted it is an error that shows the string (`cannot assign 'hi' to []u8 — a single-quoted literal is codepoints, not a string: a string is written with double quotes ("hi")`). `''` holds no codepoint and is an error, as is an escape that names no character (`\u{D800}` to `\u{DFFF}`, past `\u{10FFFF}`).

#### Template Literals

Template literals use backticks and `${expr}` interpolation to combine static text with runtime values:

```ents
`hello ${name}\n`
`Error ${msg}: ${errnos[code] ?? "unknown"}\n`
`${x} + ${y} = ${x + y}`
```

Template literals produce a **slice of slices** (`[][]u8`) — an array of fragments where static parts are const strings and interpolated parts are runtime `[]u8` values. This maps directly to scatter-gather I/O (WASI's `writev`/iovec pattern):

```ents
// Template literal:
wasi_fd_write(stderr, `Error ${msg}: ${errnos[code] ?? "unknown"}\n`, nwritten)

// Equivalent manual construction:
data err_iovecs:*mut [5][]u8 = mut ["Error ", "", ": ", "", "\n"]
err_iovecs[1] = msg
err_iovecs[3] = errnos[code] ?? "unknown"
wasi_fd_write(stderr, err_iovecs, nwritten)
```

**Implementation:** Each template literal gets a unique mutable iovec array in the data section. Static fragments (e.g., `"Error "`, `": "`, `"\n"`) are const and may be deduplicated across the program. The iovec array itself is `mut` (unique per source location) since its dynamic slots are filled at runtime.

**Type coercion:** The default type is `[][]u8`, suitable for any function accepting a slice of slices. Other coercions may be supported in the future (e.g., concatenating into a single `[]u8` with a buffer).

Each `${expr}` must produce a `[]u8` value. Non-string types would require an explicit conversion (no implicit `toString`).

#### Boolean Literals

```ents
true
false
```

Booleans are distinct from integers. No implicit truthiness - use explicit comparisons.  Under the hood they are represented as `u1` (0 and 1)

#### Array Literals

```ents
[1, 2, 3]           // [3]i32 — value type
[0:u8; 1024]        // [1024]u8 — repeat syntax (value; count)
```

String literals are array literals of `u8`:

```ents
"hello"             // equivalent to [0x68, 0x65, 0x6c, 0x6c, 0x6f]
```

An array literal given for a `*[N]T` has N elements, and each row of a `*[N][M]T`, a `[][M]T` or a `*[NxM]T` has M, as does each literal an element of a `*[N]*[M]T` points at: `cannot assign 2 elements to *[3]i32`. Behind a pointer, a string is the bytes of all the elements: `"abcd"` is a `*[4]u8` or a `*[2]u16`, but not a `*[8]u8` (`cannot assign a string of 4 bytes to *[8]u8`) or the rows of a table.

An array literal given where a pointer or slice is wanted is laid out in memory. In a function, its values that are only known when the program runs (`[x, 2]`) are stored into it each time it is evaluated: the literal is a cell of its own for that place in the source, never shared with another literal, so a pointer kept from an earlier evaluation sees the values of the later one. Rows written in place (`let p: *[2x2]i32 = [[x, 1], [2, 3]]`) are filled the same way. A literal laid out apart from the one it is in, an element of a slice of slices (`[][]i32`), of a pointer to framed arrays (`*[2][!]u8`), what an element of an array of pointers points at (`*[2]*[3]i32 = [[1, 2, 3], [4, 5, 6]]`, `*[2][*]u8 = ["ab", "cd"]`: each element is the address of its literal) or a row of a table ([2.5](#nesting)), is laid out when the program is compiled, so its values must be constants: `let t: [][]i32 = [[a, 2], [3]]` is an error (`an element of [][]i32 is laid out at compile time: its values must be constants`).

#### The `mut` Keyword on Literals

`mut` does two things: it forces the value into memory and marks it writable.

```ents
5                   // value, lives in a register
mut 5               // heap-allocated, type becomes *mut i32
(1.0, 2.0)          // value, two registers
mut (1.0, 2.0)      // heap-allocated, type becomes *mut (f64, f64)
"hello"             // already in memory (strings always are), const, deduplicable
mut "hello"          // in memory, mutable, unique copy
[1, 2, 3]           // value, three registers
mut [0:u8; 1024]    // heap-allocated, type becomes *mut [1024]u8
```

Without `mut`, literals that need memory (strings, large arrays) are embedded as **const** — the compiler may deduplicate identical content. With `mut`, each use gets a unique allocation that can be written to.

A literal is constant unless it is written with `mut`, wherever it is: where a mutable pointer or slice is wanted, a literal without `mut` is an error that shows it written with the keyword. `let buf: []mut u8 = [0:u8; 20]` is ``a literal is constant: write `mut [0:u8; 20]` for a []mut u8``; the same goes for `data s: []mut i32 = [20, 8]`, an argument `"abc"` for a `[]mut u8` parameter (`mut "abc"`), a slice field of a struct (`Buf(mut [0:u8; 4], 0)`), an element of a slice of mutable slices (`data q: *[2][]mut u8 = [mut "ab", mut "cd"]`), the table literal of a `*mut [N][M]T` and a template literal for a `[]mut []u8` (``mut `a${x}b` ``). The receiver of a method call is shown in parentheses, ``receiver: a literal is constant: write `(mut "abc")` for a []mut u8``, as `mut` goes on the literal itself: `mut "abc".fill()` would be `mut` of the call, and is a syntax error that says so. Only where a mutable pointer or slice is wanted: the fallback of `??` is given for what the whole is given for ([4.7](#the--operator)), so in `println(digits[i..] ?? "")`, with `digits` a `*mut [24]u8` and `println` taking a `[]u8`, `""` needs no `mut`.

`mut` makes the whole literal writable and its own, shared with no other literal: what it lays out apart too, the rows of a table (`data t: *mut [2][3]i32 = mut [[0; 3]; 2]` is two rows of zeros), the elements of a slice of slices (`mut [[1, 2], [1, 2]]` for a `[][]mut u8`) and the slice fields of its structs. `&` before a literal makes a writable cell of its own as well (`let n = &0:u32` is a `*mut u32`), and so `&[1, 2]` given for a `*mut [2]i32` needs no `mut`.

#### `def` — Compile-Time Constants

`def` binds a name to a compile-time value. It's pure substitution — the value is inlined wherever the name appears. No memory, no pointer.

```ents
def mask51 = 0x7FFFFFFFFFFFF:u64
def pi = 3.14159265
def fe-zero = (0, 0, 0, 0, 0)
```

#### `data` — Data Section Embedding

`data` serializes a literal into the wasm data section and binds the name to a pointer. The RHS is a normal literal — no special rules.

```ents
data table = [1:u64, 2, 3, 4]      // table: *[4]u64 (const)
data key = x"9d61b19deffd5a60"      // key: *[8]u8 (const)
data buf = mut [0:u8; 1024]         // buf: *mut [1024]u8 (mutable)
data count = 5:i32                  // count: *i32 (const, embedded as 4 bytes)
data tally = mut 5:i32              // tally: *mut i32 (mutable)
data origin = (0.0, 0.0)           // origin: *(f64, f64) (const)
```

`data` always produces a pointer. The inferred type is the tightest: `*[N]T` (or `*mut [N]T` with `mut`). This auto-coerces to `[]T` or `[*]T` wherever one is expected (9.5).

The difference between `data` and an inline literal: `data` gives the allocation a name. An inline `"hello"` is anonymous and may be deduplicated with other identical const literals. A `data msg = "hello"` is a named allocation at a known address.

**Zeros are free** — wasm memory starts as zeros, so a data segment stops at the last byte that isn't zero, and `data buf = mut [0:u8; 1024]` emits no data segment at all. The zeros still hold their place: the data after them lies where it would. Laying out zeros takes the compiler no time or memory, however many there are (`mut [0:u8; 2147483648]`). All the data has to fit in the 4 GiB a wasm memory can hold: more is an error.

---

## 2. Type System

### 2.1 Unified Value Model

Encantis has a unified model for compound values:

| Level               | Description                          | Access          |
|---------------------|--------------------------------------|-----------------|
| **Multiple values** | Base concept - zero or more values   | positional      |
| **Tuple**           | Multiple values with indices         | `.0`, `.1`, ... |
| **Struct**          | Tuple with named fields              | `.name`         |
| **Slice**           | Struct `(ptr:*T, len:u32)` via `[]T` | `.ptr`, `.len`  |

Each level is a superset of the one above:

- All slices are structs (with fields `ptr` and `len`)
- All structs are tuples (fields have positions)
- All tuples are multiple values

This unification means the same patterns work everywhere:

```ents
// Function calls: positional arguments
distance(p1, p2)

// Function returns: destructure multiple values or tuples
let d, a = to_polar(point)    // multiple values by position
let (d:, a:) = get_tuple()    // tuple destructuring by name

// Slices work like structs
let (ptr, len) = slice        // by position
let (ptr:, len:) = slice      // by name
```

The `let` keyword creates new bindings, `set` assigns to existing variables:

```ents
let (x:, y:) = point          // declares x and y (by name)
set (x:, y:) = other_point    // updates existing x and y
```

### 2.2 Primitive Types

| Category | Types |
|----------|-------|
| Signed integers | `i8`, `i16`, `i32`, `i64`, `i128`, `i256`, `i512` |
| Unsigned integers | `u8`, `u16`, `u32`, `u64`, `u128`, `u256`, `u512` |
| Floating point | `f32`, `f64` |
| Boolean | `bool` |

**Note on `bool`:** Semantically equivalent to `u1`, but integers cannot be used where booleans are expected.

**Large integers:** `i128`/`u128` through `i512`/`u512` are lowered to multiple `i64` values. Bitwise operations (XOR, AND, OR) are efficient; arithmetic requires multi-instruction sequences.

#### Ranged Integers

Unsigned integer types can carry an upper bound using `#`: `u32#N` means values in the range `[0, N)` (0 through N-1). The bound is checked at compile time and erased at runtime — a `u32#6` is still a `u32` in WebAssembly.

The bound is a number, a name (`u32#size` with a `def size`, or a comptime value parameter, `u32#n`), or any compile-time constant in parentheses, `u32#(n + 1)`, computed exactly as a length is ([2.4](#24-fixed-arrays-value-type)). It is at least 1, since `u32#0` would have no values (`range bound must be at least 1: u32#0 has no values`), and at most the number of values its type has: `u8#256` is every `u8`, and `u8#300` is `range bound 300 is too large for u8, which has 256 values`.

```ents
func get(buf: *[120]u64, i: u32#6) -> u64 => buf[i * 20]
//                            ^^^^ index is statically known to be < 6
//                                 so buf[i * 20] needs no bounds check
```

**Range propagation:** Arithmetic on ranged types propagates the bound:

```ents
for i in 6 {           // i has type u32#6 (values 0..5)
  let offset = i * 20  // offset has type u32#101 (max value: 5*20=100)
}
```

**Safe indexing:** When the index type's bound is within the array size, the compiler skips the bounds check entirely:

```ents
data table = [10, 20, 30, 40]  // *[4]i32
for i in 4 {                    // i: u32#4
  table[i]                      // no bounds check needed: max index 3 < 4
}
```

**Widening:** A narrower ranged type is assignable to a wider one: `u8#8` fits `u8#16` fits `u8`.

**Ranges from operators:** For an unsigned `x` and a constant `K`, `x & K` is `#(K+1)`, `x % K` is `#K`, and `x >> K` keeps the bits that are left (`u32 >> 28` is `u32#16`). The count is the one the shift takes (§4.2): `x >> 32` on a `u32` is `x`, with no range, and `x >> 60` is `x >> 28`. A `u8` or `u16` is bounded by its width, so a `u8` always indexes a `*[256]T` without a check.

**Narrowing:** Comparing an unsigned variable with a constant narrows its range wherever the comparison is known to hold:

```ents
data buf = mut [0:u8; 12]

func f(x: u32) -> u8 {
  if x < 12 {
    buf[x] = 1               // x: u32#12 here
  }
  return 0 when x >= 12
  return buf[x]              // and here: the return above guards it
}
```

It applies inside an `if` branch, to later `elif` and `else` branches (where earlier conditions are false), and to the rest of a block after `return`, `break` or `continue when c`, or after `if c { ... }` whose branch always exits. `&&` combines bounds; `||` only narrows when it's false. A variable assigned anywhere in the narrowed region isn't narrowed. The comparison you write is the bounds check, so nothing extra runs.

### 2.3 Value vs Reference Types

Encantis has a simple rule: **`*` means pointer, `[]` means slice — both are references. Everything else is a value.**

| Category       | Types                               | Semantics               |
|----------------|-------------------------------------|-------------------------|
| **Values**     | primitives, tuples, structs, `[N]T` | passed by value, copied |
| **References** | `*T`, `*[N]T`, `[*]T`, `[]T`        | pointer to memory       |

`[N]T` has brackets but is a value type — the `N` is a compile-time constant, so the compiler knows exactly how many wasm values to emit. The reference types all involve runtime indirection through memory addresses.

Mutating a value parameter does NOT affect the caller. Mutating through a reference DOES.

### 2.4 Fixed Arrays (Value Type)

`[N]T` is a fixed-size array of N elements, passed by value. Like tuples, small fixed arrays compile to multiple wasm values — no memory allocation.

```ents
[5]u64              // 5 u64 values (same wasm representation as a 5-tuple)
[4]u8               // 4 u8 values
[3](f32, f32)       // 3 pairs of f32
```

**Lengths.** A length is a compile-time constant: a number, a `def` (`def size = 64` makes `[size]u8` and `*mut [size]u8` types), a comptime value parameter ([8.7](#87-comptime-value-parameters)), `sizeof` of a type, the `.len` of a `*[N]T`, or arithmetic on these, `[k * 2]u8`, `[sizeof(Pt) * 4]u8`. In a signature, a length reads the function's comptime parameters and none of its others: beside `p: *[4]u32`, a parameter `q: *[p.len]u32` is `array length must be a compile-time constant` (in the body, `*[p.len]u32` is a `*[4]u32`). A length is computed exactly, as no type, and the type has the number in it: `[2 + 2]u8` is `[4]u8`. A number with a radix prefix is a length too, `[0x10]u8` is sixteen bytes; the `x` of a packed array's dimensions (2.5) is read only between decimal numbers. A length is at most 4294967295, and an array, wherever it is (in registers, in memory or behind a pointer), has at most 4294967295 bytes: `sizeof` of an array is a `u32`, and so is the byte offset of every element a proven index reaches. `*[1000000000]u64` is `array [1000000000]u64 is too large: 8000000000 bytes, more than the 4294967295 a 32-bit memory addresses`. Behind a pointer or a slice, an array of fixed arrays is a table ([Nesting](#nesting)), `n` row pointers, so its size is theirs: `*[65536][65537]u8` is 65536 pointers to rows of 65537 bytes, as `*[65536]*[65537]u8` is. A typed constant is what it is in any expression: `[300:u8]u8` is `cannot assign int(300) to u8`, and `[~0:u8]u8` is `[255]u8`. A length that divides by zero, `[64 / 0]u8`, is `array length divides by zero`. A hyphen joins a name (1.2), so `[n-1]u8` names `n-1`: write `[n - 1]u8`.

A fixed array held in registers can only be indexed by **compile-time constant** expressions, since its elements live in registers, not addressable memory:

```ents
let v: [4]u32 = [1, 2, 3, 4]
let x = v[0]        // OK: constant index
let y = v[3]        // OK: constant index
let z = v[i]        // ERROR: dynamic index requires memory — use a slice or pointer
```

A fixed array that lies in memory, as a field of a struct a pointer points to (`p.items`), has an address, and there it is indexed by any index as the `*[N]T` it is: see [Fixed Arrays in Place](#fixed-arrays-in-place).

Use fixed arrays for small data that benefits from register access: cryptographic limbs, color channels, coordinate vectors.

A fixed array held in registers has no address, so it is not passed where a pointer or a slice is wanted: `sum(v)` with `v: [3]i32` and `sum(r: *[3]i32)` is an error (`cannot assign [3]i32 to *[3]i32`), as is `v.sum()` (`the receiver is a [3]i32, which is held in registers and has no address`). Nor has it a `.ptr`: a fixed array held by value is its elements, also where it is read out of memory, so `v.ptr` is `cannot take .ptr of [3]i32: a fixed array held by value has no address`. One that lies in memory has the address of its place, `(&p.items).ptr`. An array literal is laid out in memory where a pointer or slice is wanted, so `sum([1, 2, 3])` is fine; its elements are the pointer's elements, so `[[1, 2, 3], [4, 5, 6]]` is no `*[3]i32` (`cannot assign [3]i32 to i32`), and a string is one among them only where an element is a byte.

### 2.5 Pointer Types

All pointers are `u32` (wasm 32-bit address space). Every pointer type starts with `*` or uses brackets, making references visually distinct from values.

| Type       | Meaning                          | `.len`          | `.wid`              | Indexing                         |
|------------|----------------------------------|-----------------|---------------------|----------------------------------|
| `*T`       | pointer to one T                 | N/A             | `sizeof(T)`         | `.*` to dereference              |
| `*[N]T`    | pointer to N elements            | N (comptime)    | `sizeof(T)`         | `[i]`                            |
| `*[!]T`    | pointer to null-terminated       | scans, O(n)     | `sizeof(T)`         | `[i]`                            |
| `*[N][M]T` | pointer to a table of N rows     | N (comptime)    | 4 (a row pointer)   | `[i]` → `*[M]T`, loaded          |
| `*[NxM]T`  | pointer to N×M packed 2D         | N (comptime)    | `sizeof(T)`         | `[i]` → `*[M]T`, computed        |
| `[*]T`     | many-pointer (no bounds)         | N/A             | `sizeof(T)`         | `[i]` (unchecked)                |
| `[]T`      | slice (fat pointer)              | runtime         | `sizeof(T)`         | `[i]`                            |

`.len` is the element count. `.wid` is the byte width of each element (compile-time constant). Together they give the total byte size: `data.len * data.wid`. A packed `*[NxM]T` counts its rows (`.len` is N, as `p[i]` takes a row) but measures an element (`.wid` is `sizeof(T)`), so its size is `p.len * M * p.wid`.

A `*[!]T` ends at its first element whose bytes are all zero (the terminator the literal is laid out with: one whole element of zeros, a struct's or a slice's `(ptr, len)` too, so the elements of a `*[!][]u8` are pairs as in any array of slices), so `.len` reads elements until it finds it; the scan reads each element as one integer, so `T` must be 1, 2, 4 or 8 bytes wide. Its length known only at run time, an index into a `*[!]T` is checked as one into a slice is ([4.7](#47-bounds-checked-indexing)): `z[i] ?? 0`, `if let x = z[1]`, each scanning for the length. A `[!]T` written without the `*` is held as the same pointer, and reads the same way. Neither is a slice until its length is scanned for: `(z.ptr, z.len)` makes one ([9.5](#95-array-type-conversions)), and passing a `[!]u8` where a `[]u8` is wanted is an error (as it is for a packed `[NxM]T` written without the `*`; `*[NxM]T` is a slice of its N×M elements).

> **Status: a `*[?]T` (a length prefix in LEB128, then the elements) is laid out but not read yet:** indexing one and `.len` are compile errors (`indexing *[?]u8 is not supported yet: its length prefix is not read`).

```ents
let p: *u8 = ...
let v = p.*          // dereference single pointer

let buf: *[16]u8 = ...
buf[0]               // index into array pointer
buf.len              // 16 (compile-time constant)
buf.wid              // 1 (sizeof(u8), compile-time constant)

let s: []u64 = ...
s.len                // element count (runtime)
s.wid                // 8 (sizeof(u64), compile-time constant)
s.ptr                // raw pointer ([*]u64)

let mp: [*]u8 = ...
mp[i]                // caller must ensure bounds
mp.wid               // 1 (sizeof(u8))
```

#### Optional Types

Pointers and slices can be **optional** using the `?` prefix. An optional pointer/slice uses `0` as a sentinel meaning "none":

```ents
?*T              // optional pointer — either valid *T or none (ptr=0)
?[]T             // optional slice — either valid []T or none (ptr=0)
?*[N]T           // optional pointer to array
?[*]T            // optional many-pointer
```

Only pointer and slice types can be optional — primitives like `u8` have no sentinel value (every bit pattern is valid).

None is written `0` for both, wherever an optional is wanted: a `let`, a result, an argument, a field, a global, an element of a literal or of `data`, and cast, `0 as ?[]u8` as `0 as ?*u8`. For an optional slice it is the pointer 0 with a length of 0. Both compare with `0`, which for a slice compares its pointer, with `==` and `!=` only:

<!-- spec:begin compile -->

```ents
type Entry = (key: u32, name: ?[]u8)

data entries: *[2]Entry = [(key: 1, name: 0), (key: 2, name: "two")]
global last: ?[]u8 = 0

func find(key: u32) -> ?[]u8 {
  for e in entries {
    return e.name when e.key == key
  }
  return 0
}
func size(s: ?[]u8) -> u32 => if let x = s { x.len } else { 99 }
func cell(p: ?*u32) -> u32 => if p == 0 { 0 } else { 1 }
func unnamed() -> Entry => Entry(9, 0 as ?[]u8)

test "none is 0 for an optional pointer and an optional slice" {
  assert find(1) == 0
  assert find(2) != 0
  assert size(find(2)) == 3
  assert size(find(3)) == 99
  assert size(0) == 99
  assert last == 0
  assert cell(0) == 0
  assert unnamed().name == 0
}
```

Any other number is no slice, a slice that isn't optional has no none, and an optional slice is only ever equal or not to none:

```ents
func f(s: ?[]u8) -> bool {
  let a: ?[]u8 = 5
  let b: []u8 = 0
  return s < 0
}
```

```errors
cannot assign int(5) to ?[]u8
cannot assign int(0) to []u8
'<' cannot be applied to ?[]u8 and int(0)
```

<!-- spec:end -->

Optional values cannot be used directly where non-optional values are expected. You must resolve them using `if let` or `??`:

```ents
let p: ?*u8 = get_optional_ptr()
p.*                              // type error: ?*u8 is not *u8
if let val = p { val.* }         // OK: unwrapped inside if-let
p ?? default_ptr                 // OK: resolved with fallback
```

Nothing is read through an optional before it is resolved: indexing it (`q[0]`), dereferencing it (`p.*`), a member of it (`p.x`, `s.len`, `s.ptr`, a type pun), a range of it, a loop over it, and moving it (`p + 4`) are all errors (`cannot index ?*[3]i32: it may be none — resolve it with 'if let' or '??' first`). It can be compared (an optional slice only with `0`), and passed where an optional is expected.

**Representation:** At the WASM level, optional pointers/slices have the same representation as their non-optional counterparts — a single `i32` for pointers, `(i32, i32)` for slices. The value `0` (null pointer) means "none." For slices, `ptr=0` means none (distinguishable from an empty slice which has `ptr≠0, len=0`).

**Data section layout:** To ensure address `0` is never a valid data pointer, the compiler reserves the first 4 bytes of linear memory when any optional types are used and the first data entry would otherwise start at offset 0.

**Assignability:** Non-optional values widen to optional implicitly (`*T` → `?*T`), but the reverse requires explicit unwrapping.

#### Mutability

By default, pointers are **read-only** (`const`). Add `mut` to allow writes:

```ents
*T                   // read-only pointer (default)
*mut T               // mutable pointer
[]u8                 // read-only slice (default)
[]mut u8             // mutable slice
[*]u8                // read-only many-pointer (default)
[*]mut u8            // mutable many-pointer
```

```ents
func print(msg: []u8)            // read-only: cannot write through msg
func fill(buf: []mut u8)         // mutable: can write through buf

data buf = mut [0:u8; 1024]
data text = "hello"
print(buf)                        // OK: mutable → const (implicit coercion)
fill(buf)                         // OK: mutable → mutable
print("hello")                    // OK: const literal → const param
fill(text)                        // ERROR: const data → mutable param
fill("hello")                     // ERROR: a literal is constant: write `mut "hello"` for a []mut u8
fill(mut "hello")                 // OK: a mutable copy of its own
```

**Coercion:** mutable pointers implicitly coerce to read-only (widening). The reverse is an error.

See [The `mut` Keyword on Literals](#the-mut-keyword-on-literals) for how `mut` interacts with literal expressions and `data` declarations.

#### Nesting

```ents
*[]T        // pointer to a slice (points to ptr+len pair)
*[N][M]T    // pointer to N pointers to M-element arrays
*[NxM]T     // pointer to N×M packed elements (contiguous 2D)
```

The two spellings of a 2D array lie in memory differently. `*[NxM]T` is one packed block of N×M elements: `p[i]` is the address of row `i`, `i × M × sizeof(T)` bytes in, and nothing is loaded. The row index is checked against N as a table's is (below): a constant or ranged one at compile time, any other resolved where it is taken, with `if let r = p[i]` or `p[i] ?? other`. `*[N][M]T` is a **table**: its N elements are pointers to rows of M elements, and each row is laid out on its own. The same goes for any pointer or slice whose element is a fixed array — `*mut [N][M]T`, `[][M]T`, `[]mut [M]T`, `[*][M]T` — and for deeper ones: in `*[2][3][4]T` each element is a `*[3][4]T`, itself a table. Rows that are framed or packed are laid out on their own too: an element of `*[N][!]T` is a `*[!]T`, and one of `*[N][AxB]T` a `*[AxB]T` (so `m[i][j][k]` is cell `k` of row `j` of block `i`); a `*[!][M]T` is a table whose row pointers end with a null one.

```ents
data grid: *[2][3]i32 = [[7, 1, 2], [3, 4, 5]]   // two rows, then a table of their two addresses
data rows: [][2]i32 = [[7, 1], [3, 4], [5, 6]]   // a slice of three row pointers

func cell(i: u32#2, j: u32#3) -> i32 => grid[i][j]
func row-sum(i: u32) -> i32 => if let r = grid[i] { r[0] + r[1] + r[2] } else { 0 }
```

In a table:

- `m[i]` loads row pointer `i` (a stride of 4 bytes) and is a `*[M]T`, or a `*mut [M]T` when the table is mutable. `m[i][j]` then indexes that row.
- Each index is bounds-checked on its own, by the rules of [4.7](#47-bounds-checked-indexing): `m[i]` against N (a slice's rows against its `.len`), `m[i][j]` against M; a constant or ranged index is proven at compile time. A row has no optional type: like an element of a value type, a row index that isn't proven is resolved where it is taken, with `if let r = m[i]` or `m[i] ?? other`. `??` and `if let` resolve the index they are given, so in `m[i][j] ?? 0` the row index still has to be in range. A many-pointer (`[*][M]T`) has no length, so its row index is never checked.
- `m.len` is N, the number of rows, and `m[i].len` is M. `m.wid` is 4, the size of a row pointer, so `m.len * m.wid` is the size of the table itself. That is what `memcpy` and `memset` check a length against, and `memzero(m)` is an error: it would point every row at address 0. A row is zeroed or copied as the array it is, `for row in m { memzero(row) }`, and in a deeper table each row of rows: `for row in m { for cells in row { memzero(cells) } }` for a `*mut [2][2][2]T`.
- `sizeof(*[N][M]T)` is 4, as for any pointer. `sizeof([N][M]T)` is `N × M × sizeof(T)`: that is the value, which lies in place as a field of a struct ([9.6](#96-structs-and-slices-in-memory)) or in registers. Reached where it lies in memory, it is packed, the `*[NxM]T` its rows make ([Fixed Arrays in Place](#fixed-arrays-in-place)), not a table.
- `for row in m` binds each row pointer, as `m[i]` gives it: a `*[M]T`, or a `*mut [M]T` in a mutable table.
- `let r = m[i]` is the row pointer, not a copy of the row; `m[i].*` loads the row as a `[M]T` value. A row passes where a `*[M]T` is expected, and like any `*[M]T` where a `[]T` is.
- `m[i][j] = v` writes through the row pointer, so it needs a mutable table. `m[i] = r` stores a row pointer: it points row `i` at `r` (a `*mut [M]T` in a `*mut [N][M]T`), and from then on the two share their cells. To copy values into a row instead, write `m[i].* = [1, 2, 3]`.
- `&m[i]` is the address of the row pointer: a `**[M]T`, or `*mut *mut [M]T` in a mutable table (optional, as in [4.7](#element-addresses-and-writes), when `i` isn't proven).
- `m.*` is an error: the rows lie apart, so there is no `[N][M]T` to load or store whole.
- A table written as a literal is laid out when the program is compiled, rows and table alike, so its values must be constants (a framed or packed row is held as its pointer, so a variable can stand for one). With `mut` each row is its own: `data board: *mut [2][3]i32 = mut [[0; 3]; 2]` is two rows of zeros, not one row twice.

### 2.6 Slices

`[]T` is a fat pointer: a `(ptr: [*]T, len: u32)` pair. Slices are the standard way to pass variable-length data.

```ents
let text: []u8 = "hello"        // read-only slice (default)
let buf: []mut u8 = get-buf()   // mutable slice

text.ptr        // extract pointer
text.len        // get length (u32)
text[i] ?? 0    // element access (read), checked against text.len
if let p = &buf[i] { p.* = 0 }   // element write (only on []mut)
```

A slice's length is a run-time value, so no index into a slice is known to be in range at compile time, a constant one either: every element read is checked against `.len` and resolved with `if let` or `??` ([4.7](#47-bounds-checked-indexing)), and an element is written through its address.

Slices are value types at the language level (the ptr+len pair is copied), but the data they point to is shared. Mutating through a `[]mut` slice affects the underlying memory.

#### Static Memory Allocation

Use `data` to allocate in the wasm data section:

```ents
data table = [1:u64, 2, 3, 4]          // table: *[4]u64 (const, deduplicable)
data key = x"9d61b19deffd5a60"          // key: *[8]u8 (const)
data buf = mut [0:u8; 1024]             // buf: *mut [1024]u8 (mutable, unique)
```

The inferred type is `*[N]T` (const) or `*mut [N]T` (when `mut` is used). These auto-coerce to `[]T` or `[]mut T` wherever one is expected (9.5).

### 2.7 Tuple Types

```ents
(i32, i32)           // pair of i32
(f64, f64, f64)      // triple of f64
```

Standard tuple semantics:

- `()` is void (0-tuple)
- `(x)` is grouping, not a tuple — the type is just `x`
- `(x, y, ...)` is a tuple (2+ elements)

Grouping holds wherever a type is written: after a colon, in a `type` declaration, in a cast, as a type argument, and as the type a constructor call names, so `x: (u32)` takes a `u32` and `(Point)(1.0, 2.0)` is `Point(1.0, 2.0)`. A field with a name makes a struct of one field: `(v: f64)`. After `->` the parentheses list the results: `-> (u32)` is one `u32`, `-> (q: i32, r: i32)` two named results, and `-> ((q: i32, r: i32))` one result that is a struct.

Tuples compile to multiple wasm values — no memory, no pointers. Access elements by position or name:

```ents
type Fe = (u64, u64, u64, u64, u64)

func fe-zero() -> Fe => (0, 0, 0, 0, 0)

func fe-add(a: Fe, b: Fe) -> Fe => (
  a.0 + b.0, a.1 + b.1, a.2 + b.2, a.3 + b.3, a.4 + b.4
)
```

Tuples and fixed arrays `[N]T` are closely related — both are value types stored in registers. The difference: tuples can have mixed field types and named fields; fixed arrays have uniform element type and integer indices.

The key distinction: **tuples are values** (registers, stack, multi-value returns), **arrays are memory** (linear memory, pointer-indexed).

### 2.8 Struct Types

Structs are tuples with named fields, using the same `()` syntax:

```ents
type Point = (x:f32, y:f32)
type Rect = (origin:Point, size:(w:f32, h:f32))
type Color = (r:u8, g:u8, b:u8, a:u8)
```

#### Struct Constructors

Two constructor syntaxes are supported:

```ents
// Positional (fields in declaration order)
let p = Point(1.0, 2.0)

// Named (any order, self-documenting)
let q = Point(y: 4.0, x: 3.0)

// Nested structs
let r = Rect(Point(0.0, 0.0), (w: 100.0, h: 50.0))

// Shorthand: trailing colon when variable name matches field name
let x = 3.0
let y = 4.0
let p = (x:, y:)             // equivalent to (x: x, y: y)
```

<!-- spec:begin compile -->

An argument with a name is for the field of that name, and one without is for the field at its place, so positional and named arguments mix:

```ents
type Point = (x:f32, y:f32)

func half(x: f32) -> Point => Point(x, y: x / 2.0)

test "arguments by place and by name" {
  assert half(4.0).y == 2.0
  assert Point(y: 1.0, x: 3.0).x == 3.0
}
```

Each field is given once:

```ents
type Point = (x:f32, y:f32)

func f(x: f32) -> f32 => Point(x, y: 2.0).y
func g() -> f32 => Point(2.0, x: 1.0).x
func h() -> f32 => Point(y: 1.0, 2.0).x
```

```errors
Point: field 'x' is given twice
Point: field 'y' is given twice
```

A tuple literal with names among its elements gives the fields the same way, wherever it meets a struct: as a variable's value (by `let`, `=` or `set`), an argument, a receiver, a returned value or a function's named results, a field of a larger struct, an element of an array, the value of a global or of `data`, the literal `&` lays out, a value stored through a pointer, or the value of a branch of an `if` or a `match` that is one of these. As a `Point`, `(y: 2.0, x: 1.0)` has an `x` of 1.0. A tuple literal without names gives the fields by position, whatever the struct calls them. Only a literal is taken by name: a value made elsewhere keeps its order, and one whose fields have the struct's names in another order is not that struct ([9.2](#structural-coercion)); it is given the struct's type where it is made. A slice is the struct `(ptr: [*]T, len: u32)`, so `(len: n, ptr: p)` is a slice too:

```ents
type Point = (x:f32, y:f32)

func by_name() -> Point => (y: 2.0, x: 1.0)
func by_place() -> Point => (2.0, 1.0)
func first(p: [*]u8, n: u32) -> []u8 => (len: n, ptr: p)

test "a literal with names by name, one without by position" {
  assert by_name().x == 1.0
  assert by_place().x == 2.0
  assert first("abc" as [*]u8, 2).len == 2
}
```

A name the struct has no field of is an error, and so is a field given twice or not at all. A tuple type without names, such as `(f32, f32)`, has no field a name could give. The errors name the fields there are:

```ents
type Point = (x:f32, y:f32)

func a() -> Point => (x: 1.0, z: 2.0)
func b() -> Point => (x: 1.0)
func c() -> Point => (y: 1.0, 2.0)
func d() -> (f32, f32) => (x: 1.0, y: 2.0)
func e() -> Point {
  let v = (y: 1.0:f32, x: 2.0:f32)
  return v
}
```

```errors
field 'z' not found in Point, whose fields are x and y
Point expects 2 fields, got 1: no value for y
Point: field 'y' is given twice
field 'x' not found in (f32, f32), whose fields have no names: give the values by position
field 'y' not found in (f32, f32), whose fields have no names: give the values by position
cannot assign (y: f32, x: f32) to Point: its fields have the names of Point's in another order, and only a literal gives fields by name; give the value the type Point where it is made
```

The values are computed in the order they are written, and then each goes to its field, for a constructor and a literal alike: `Point(y: f(), x: g())` calls `f` before `g`. Where the fields are written in the order the type declares them, that is all there is to it. Where they are not, a value that something written after it could change or tell apart (a call, a read of memory or of a global, anything that can trap) is computed in its turn and waits in a local until its field's place comes; a constant, a local that no other value sets, or arithmetic on them that cannot trap is computed at its field's place, as nothing can tell the difference:

```ents
type Point = (x:i32, y:i32)

global seen: i32 = 0

func tick(v: i32) -> i32 {
  seen = seen * 10 + v
  return v
}

test "values in the order written, fields by name" {
  let p = Point(y: tick(1), x: tick(2))
  assert seen == 12
  assert p.x == 2
  let q: Point = (y: tick(3), x: tick(4))
  assert seen == 1234
  assert q.y == 3
}
```

<!-- spec:end -->

#### Struct Field Access

```ents
let p:Point = Point(3.0, 4.0)
let x = p.x              // field read
p.y = 5.0                // field write
```

A field is reached the same way wherever its struct is: in a variable, behind a pointer, in an array, or in the result of a call. Fields of fields chain.

```ents
type Point = (x:f32, y:f32)
type Rect = (origin:Point, size:(w:f32, h:f32))

func bounds() -> Rect => Rect(Point(0.0, 0.0), (w: 100.0, h: 50.0))

func nudge(p:*mut Point, list:[*]mut Rect, i:u32) -> f32 {
  p.x = 0.0                    // a field of the Point that p points to
  p.y += 1.0
  list[i].origin.x = p.x       // a field of a field of an element
  let r = bounds()
  r.size.w = 2.0               // a field of a field of a variable
  return bounds().size.h       // a field of a call's result
}
```

`p.x` through a pointer reads or writes memory (§9.6), and a write needs a `*mut` pointer. In a variable, each field is a register of its own.

#### Types That Refer to Themselves

A type can refer to itself through a pointer or a slice: what it holds there is an address, and the field is the type again at any depth. Two such types are one type when nothing on the way round tells them apart, as aliases always are.

<!-- spec:begin compile -->

```ents
type Node = (next: ?*Node, v: u32)
type Tree = (kids: []Tree, v: u32)

export func third(h: *Node) -> u32 {
  if let a = h.next {
    if let b = a.next { return b.v }
  }
  return 0
}

export func depth(t: Tree) -> u32 {
  let deepest: u32 = 0
  for k in t.kids {
    let d = depth(k)
    if d > deepest { deepest = d }
  }
  return deepest + 1
}
```

A type that holds itself as a value, in a field or an array, would have no size:

```ents
type Node = (next: Node, v: u32)
```

```errors
type 'Node' contains itself: a type can only refer to itself through a pointer or a slice
```

<!-- spec:end -->

A struct type can take type parameters: `func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)` declares a generic type, `Vec(u32)` is the struct it gives for `u32`, and `Vec(u32)(p, 0, cap)` constructs one like any constructor ([8.5](#85-generic-types)).

### 2.9 Enum Types (Algebraic Data Types)

> **Status: Design only** — enums are parsed but not yet type-checked or compiled.

Enums are tagged unions representing values that can be one of several variants. Each variant can optionally carry payload data:

```ents
enum Color {
  Red,
  Blue,
  Green,
  RGB(r:u8, g:u8, b:u8),
  HSL(h:u8, s:u8, l:u8),
  Grey(b:u8),
  Darker(c:*Color)
}

enum Json {
  Null,
  Boolean(bool),
  Number(f64),
  String([]u8),
  Array([]Json),
  Object([]([]u8, Json))
}
```

Variants without payloads (like `Red`, `Blue`, `Null`) are unit variants. Variants with payloads can have positional or named fields.

**Recursive types:** Enums cannot directly contain themselves — recursion must go through an indirection. Use `*T` (pointer) or `[]T` (slice) for recursive references:

```ents
enum Tree {
  Leaf(value:i32),
  Node(left:*Tree, right:*Tree)   // pointer indirection
}

enum List {
  Nil,
  Cons(head:i32, tail:*List)      // pointer indirection
}
```

Slices (`[]T`) are already indirect (fat pointers to heap data), so `Array([]Json)` is valid without explicit `*`.

#### Enum Representations

Enums have two representations: **stack** (for passing/returning values) and **memory** (for serialization to linear memory).

##### Stack Representation

On the stack, enums are flattened to multiple WebAssembly values using per-enum sizing. The compiler computes the minimal slot types needed to hold all variants:

1. **Tag**: Always `i32`
2. **Payload slots**: For each "position" across all variants, use the smallest wasm type that can hold all types at that position

When a slot must hold both integer and float types (e.g., `i32` and `f64`), use `i64` and reinterpret:
- `f64` ↔ `i64`: use `i64.reinterpret_f64` / `f64.reinterpret_i64`
- `i32` → `i64`: use `i64.extend_i32_u`
- `i64` → `i32`: use `i32.wrap_i64`

**Example — Json:**

| Variant | Slot 0 | Slot 1 |
|---------|--------|--------|
| `Null` | — | — |
| `Boolean(bool)` | bool (→i32) | — |
| `Number(f64)` | f64 | — |
| `String([]u8)` | ptr (i32) | len (i32) |
| `Array([]Json)` | ptr (i32) | len (i32) |
| `Object(...)` | ptr (i32) | len (i32) |
| **Union** | i32 \| f64 | i32 \| — |
| **Wasm type** | i64 | i32 |

**Stack shape: `(i32, i64, i32)`** = tag + slot0 + slot1

**Example — Color:**

| Variant | Slot 0 | Slot 1 | Slot 2 |
|---------|--------|--------|--------|
| `Red/Blue/Green` | — | — | — |
| `RGB` | r (u8→i32) | g (i32) | b (i32) |
| `HSL` | h (i32) | s (i32) | l (i32) |
| `Grey` | b (i32) | — | — |
| `Darker` | ptr (i32) | — | — |
| **Union** | i32 \| — | i32 \| — | i32 \| — |
| **Wasm type** | i32 | i32 | i32 |

**Stack shape: `(i32, i32, i32, i32)`** = tag + 3 slots

##### Memory Representation

In linear memory, enums are byte-packed for compact storage:

1. **Tag**: Smallest integer type for the variant count
   - ≤256 variants: `u8`
   - ≤65536 variants: `u16`
   - ≤2³² variants: `u32`

2. **Payload**: Fields packed at natural byte widths, end-padded to max variant size

**Example — Color (5 bytes):**

```
Red:    [0][__][__][__][__]
Blue:   [1][__][__][__][__]
Green:  [2][__][__][__][__]
RGB:    [3][r][g][b][__]
HSL:    [4][h][s][l][__]
Grey:   [5][b][__][__][__]
Darker: [6][ptr ptr ptr ptr]
```

**Example — Json (9 bytes):**

```
Null:    [0][__ __ __ __ __ __ __ __]
Boolean: [1][b][__ __ __ __ __ __ __]
Number:  [2][f64 f64 f64 f64 f64 f64 f64 f64]
String:  [3][ptr ptr ptr ptr][len len len len]
Array:   [4][ptr ptr ptr ptr][len len len len]
Object:  [5][ptr ptr ptr ptr][len len len len]
```

Memory layout uses end-padding (payload left-aligned) with no alignment requirements — the language is byte-oriented.

### 2.10 Type Conversions

#### Implicit Widening

Encantis allows implicit widening when no precision is lost:

```
i8 → i16 → i32 → i64
u8 → u16 → u32 → u64
f32 → f64
```

An unsigned integer also widens to a wider signed one, which holds all its values: `u8` → `i16`, `u32` → `i64`.

Integer to float is implicit only when the float's mantissa can hold all values:

| Float | Safe integer types | Mantissa bits |
|-------|-------------------|---------------|
| f32 | i8, u8, i16, u16 | 24 |
| f64 | i8, u8, i16, u16, i32, u32 | 53 |

A value widens wherever two operand types meet or a value meets a declared type:

- **Operators.** The narrower operand of an arithmetic, bitwise or comparison operator widens to the other's type. That is the type of the result (`bool` for a comparison).
- **Declarations and assignments.** A `let` with a type, `=`, `set`, and compound assignment: in `x += n`, `n` widens to the type of `x`.
- **Calls and results.** Arguments, struct constructor fields, tuple and array literal elements, `return` values and expression bodies.
- **Branches.** The branches of an `if` or `match` used as a value widen to its declared type, or, without one, to the widest branch.
- **Array literals.** The elements widen to the declared element type, or, without one, to the widest element: `[n, big]` with an `i32` and an `i64` is a `[2]i64`. The value of a repeat literal is an element too: `[n; 3]` for a `*[3]i64` widens `n`, and `[true; 3]` is not three `u32`s. Tuples among the elements agree field by field, as branches do: `[(1, 2), (3, 5000000000)]` is a `[2](i32, i64)`. Tuples that agree on no type (another count of fields, other names, the same names in another order) are of the first one's type, and each of the others meets it as it would any struct: `[(y: 1, x: 2), (x: 3, y: 4)]` has a second element with an `x` of 3 ([2.8](#struct-constructors)), and `(3, 4, 5)` after a `(1, 2)` is an error. A field that is a string of other lengths in each tuple is a slice, as strings of other lengths are by themselves (`["a", "bc"]` is a `[2][]u8`): `[("a", 1), ("bc", 2)]` is a `[2]([]u8, i32)`.

```ents
type Sample = (count: i64, mean: f64)

func scale(r: f64, n: i32) -> f64 => r * n        // n widens to f64

func total(a: u8, b: i32, c: i64) -> i64 {
  let sum: i64 = a                                 // u8 to i64
  sum += b                                         // i32 to i64
  return sum + c
}

func sample(n: i32, sum: f32) -> Sample => Sample(n, sum)

func pick(c: bool, n: i32, x: f64) -> f64 {
  let v = if c { n } else { x }                    // an f64: n widens
  return v
}
```

The conversion is an instruction only when the WebAssembly type changes ([11.1](#111-widening-instructions-implicit)). Integers up to 32 bits share an `i32`, so `u8` → `i32` is free.

A struct or tuple value that already exists isn't widened field by field: a `(i32, i32)` is not a `(i64, i64)` (see [9.2](#structural-coercion)). The elements of a literal are, one by one: `let t: (i64, f64) = (n, n)`.

Widening converts values, not memory seen through a pointer or slice: a `u8` is a `u16`, but a `[]u8` is not a `[]u16`. The elements have to be laid out the same ([9.2](#structural-coercion)).

#### Comptime Literal Promotion

Unsuffixed literals check actual value, not type:

```ents
let x:f32 = 1.0 + 42        // OK: 42 fits in f32 mantissa
let y:f32 = 1.0 + 16777216  // OK: 2^24 is max exact integer
let z:f32 = 1.0 + 16777217  // ERROR: exceeds f32 precision
```

A constant expression takes the type it's used as, all the way down to its literals. A float literal beside an integer value makes the operation an `f64` one, if the integer widens to `f64`:

```ents
func third() -> f32 {
  let x: f32 = 1.0 / 3       // an f32 division of two f32 constants
  return x
}

func big() -> i64 {
  let x = 5000000000 + 1     // an i64 addition: the 1 isn't an i32
  return x
}

func halves(n: i32) -> f64 => n * 0.5    // 0.5 is an f64, and n widens to it
```

Each step of a constant expression is then computed in that type, as it would be for values, and what the compiler proves from a constant (an index in bounds, a range) it proves from that value. As a `u32`, `0 - 1` is 4294967295, so `(0 - 1) / 4` is 1073741823, not 0, and `~0 >> 28` is 15.

The branches of an `if` or `match` that are all constants make a constant too. Where nothing else types it, it takes the default that holds every branch, and each branch has to be a value of the type it ends up with:

```ents
func pick(c: bool) -> i64 {
  let v = if c { -2147483648 } else { 2147483648 }   // an i64: 2147483648 isn't an i32
  return v
}
```

Branches that are tuples agree field by field, each field as it would by itself:

```ents
func step(d: i32) -> (i32, i32) {
  let (dx, dy) = match d {
    0 => (1, 0)
    1 => (0, 1)
    _ => (-1, -1)                  // dx and dy are i32s
  }
  return (dx, dy)
}
```

An integer constant with no type that fits neither an `i64` nor a `u64` has no default: give it a type (`let x: u128 = 18446744073709551616`). Nor have branches of which one is negative and another past an `i64`: `if c { -1 } else { 18446744073709551615 }` needs a type that holds both.

Once a value has a concrete type, normal promotion rules apply:

```ents
let z = 1.3            // inferred as f64
let a:f32 = z          // ERROR: f64 → f32 needs explicit cast
```

#### Type Errors

```ents
i32 + f32   // ERROR: i32 exceeds f32's mantissa
i32 + u32   // ERROR: mixed signedness, cast explicitly
i32 < u32   // ERROR: the same goes for comparisons
i64 → i32   // ERROR: narrowing needs explicit cast
bool + i32  // ERROR: cast bool first
f64 % 2.0   // ERROR: % and the bitwise operators need integers
```

#### Explicit Casts

Two syntaxes:

```ents
// Function-style (binds tightly, primitive types only)
i32(x)
f64(value)

// as-style (also binds tightly — at the postfix level)
x as i32
ptr as *u8
```

Both forms bind tighter than arithmetic, so no parens are needed:

```ents
x as i32 + 1     // OK: parses as (x as i32) + 1
i32(x) + 1       // OK: same result
```

For type-punned memory access, use the member syntax instead of casts:

```ents
ptr.u8              // read memory as u8
ptr.u32             // read memory as u32
```

Casts are required for:

- Narrowing (larger → smaller)
- Lossy integer→float
- Mixed signedness operations
- Bool→integer

A cast converts between numbers and pointers, and turns a bool into a number (0 or 1). Nothing casts to `bool`: write the comparison (`x != 0`). A slice or a struct is several values: it can't be cast to or from a single one (use `.ptr`, `.len` or its fields).

### 2.11 Type Names

A `type` declaration gives a type a name, and the name is that type wherever it is used: what can be done with the type written out can be done with the name. A name for a pointer is dereferenced, one for a slice or an array has `.ptr`, `.len` and elements, one for an optional is unwrapped by `if let` and `??`, a literal is laid out for a name as for the type it names (`data list: S = [4, 5, 6]`, `let q: *A = [1, 2, 3]`), and a pointer to an array becomes a slice under any of their names. A pointer to a name for an array is a pointer to that array in every use: with `type Row = [3]i32`, a `*Row` has `.len` 3, indexes, loops and converts as a `*[3]i32` does and is what `memcpy` takes, and with `type Grid = [2]Row` a `*Grid` is a `*[2][3]i32`, a table ([Nesting](#nesting)). That holds at every depth and through names of names: with `type Cube = [2][3][4]u8`, a `*Cube` is a table of tables as a `*[2][3][4]u8` is, and `c[1][2][3]` loads two row pointers before the byte. A generic type applied is a name of the same kind (8.5).

<!-- spec:begin compile -->

```ents
type P = *mut u32
type S = []u16
type O = ?*u32
type A = [3]u16

data cells = mut [0:u32; 4]
data shorts = [1:u16, 2, 3]
data list: S = [4, 5, 6]

func bump(p: P) -> u32 {
  p.* += 1
  return p.*
}
func last(s: S) -> u16 => s[s.len - 1] ?? 0
func read(o: O) -> u32 => if let q = o { q.* } else { 0 }

test "names are the types they name" {
  let p = cells as P
  assert bump(p) == 1
  let s: S = shorts
  assert last(s) == 3
  assert read(p) == 1
  assert read(0 as O) == 0
  assert last(list) == 6
  let q: *A = [7, 8, 9]
  assert last(q) == 9
}
```

<!-- spec:end -->

### 2.12 Limits

A type has at most 65536 parts written out in full: every name replaced by what it names, and each field, element, pointer and number counted where it stands (a type that refers to itself is counted once round), with an array held by value counted once for each of its elements (below). Names let a type double at every level, `type D2 = (a: D1, b: D1)`, and the compiler writes types out to name instances and to lay out values. A type over the limit is one error where it is declared, or where the generic type that makes it is applied, or, written in place (in a signature, a cast, after a colon, as a type argument), where it is written; the types made of it say nothing more.

<!-- spec:begin compile -->

```ents
type D0 = u8
type D1 = (a: D0, b: D0)
type D2 = (a: D1, b: D1)
type D3 = (a: D2, b: D2)
type D4 = (a: D3, b: D3)
type D5 = (a: D4, b: D4)
type D6 = (a: D5, b: D5)
type D7 = (a: D6, b: D6)
type D8 = (a: D7, b: D7)
type D9 = (a: D8, b: D8)
type D10 = (a: D9, b: D9)
type D11 = (a: D10, b: D10)
type D12 = (a: D11, b: D11)
type D13 = (a: D12, b: D12)
type D14 = (a: D13, b: D13)
type D15 = (a: D14, b: D14)
type D16 = (a: D15, b: D15)
type D17 = (a: D16, b: D16)

func f(p: *D17) -> u8 => p.a.b.a.b.a.b.a.b.a.b.a.b.a.b.a.b.a
```

```errors
type 'D16' is too large: written out in full it has more than 65536 parts
```

<!-- spec:end -->

A value held by value — a parameter, a result, a variable or a global, with each field and element of it — is laid out in registers, so there an array counts each of its elements: `[N]T` is one part and N times what `T` counts (at least once, for `[0]T`), and `[2][2][2]u8` is fifteen parts where it is eight bytes. What a pointer or a slice points to is in memory and counts once, whatever its length: `*[1048576]u8`, `[][4096]u8`, a name for a large array behind a pointer and `data buf = mut [0:u8; 1048576]` are each a few parts, while a global `g: [65536]u8` or a parameter `x: [65536]u8` is over the limit (a function holds its values to far less, below). The parameters and results of a function type are held by value wherever the function type is. A value over the limit is one error where its type is written, or, where none is (`let x = p.*`, `for v in rows`, `if let v = ...`), at the variable.

<!-- spec:begin compile -->

```ents
type Page = [65536]u8
data page = mut [0:u8; 65536]
data buf = mut [0:u8; 1048576]

func first(p: *Page) -> u8 => p[0]
func last(s: []u8) -> u8 => s[s.len - 1] ?? 0
func both() -> u8 => first(page) + last(buf)
func whole(x: [65536]u8) -> u8 => x[0]
```

```errors
type '[65536]u8' is too large: written out in full it has more than 65536 parts
```

<!-- spec:end -->

A function is one wasm function, and every engine takes a wasm function of at most 1000 parameters, 1000 results and 50000 locals, its parameters among them, with a body of at most 7654321 bytes (the limits the WebAssembly JS API sets). What a function holds is counted in registers, the wasm values a value is laid out in: a number, a bool or a pointer is one, a slice two, a `u128` two `i64`s, and an array held by value or a struct one for each of its elements and fields, `[N]T` N times what `T` is. So:

- The parameters of a function are at most 1000 registers, and so are its results; so are those of an imported function and of a function type wherever it is written. It is said at the parameter or the result that goes over.
- The value an `if`, an `if let`, a `match` or a `??` gives is at most 1000 registers: it is the results of a wasm block.
- A function needs at most 50000 registers in all: those of its parameters and of its variables (a named result, and what a `let`, a `for`, an `if let` or a match arm binds), and those of each value its code computes. Each expression counts its registers, one at least, as often as its code is written out: a fill `[x; N]` writes `x` out N times, a deferred expression is written at the end of its block and at each `return`, `break` and `continue` after it, and a `return` without a value gives the named results back, their registers read again each time. A literal is its elements, of which the constant ones are data where the literal is laid out in memory; and a place read only in part, or written, is not computed: `p.*` in `p.*[3]` and `p.* = v`, `rect` and `rect.origin` in `rect.origin.x`. Nor are the name of a function that is called, a type argument and the count of a fill. A value computes about as much code as it has registers, so this keeps the body within its limit as well. Going over is one error, at the value, the variable or the `return` that goes over, and none is said of a function with an error of its own. A test is a function of its own here, and so is each instance of a generic.

A large value belongs in memory, behind a pointer, where a range copy `p[..] = q[..]` (`memory.copy`) and a range fill `p[..] = 0` (`memory.fill`) move it with one instruction whatever its length ([4.8](#48-slicerange-syntax)).

<!-- spec:begin compile -->

```ents
func copy(p: *mut [4000]u8, q: *[4000]u8) { p.* = q.* }                    // 4002 registers
func move(p: *mut [65536]u8, q: *[65536]u8) { p[..] = q[..] }              // memory.copy
func clear(p: *mut [65536]u8) { p[..] = 0 }                                // memory.fill
func pick(c: bool, p: *[1000]u8, q: *[1000]u8) -> u8 => (if c { p.* } else { q.* })[0]
func first(p: *[65536]u8) -> u8 => p.*[0]                                  // one element is read
```

<!-- spec:end -->

<!-- spec:begin compile -->

```ents
func copy(p: *mut [65536]u8, q: *[65536]u8) { p.* = q.* }
func fill(p: *mut [60000]u8) { p.* = [0; 60000] }
func pick(c: bool, p: *[1001]u8, q: *[1001]u8) -> u8 => (if c { p.* } else { q.* })[0]
func pass(x: [1000]u8, n: u32) -> u8 => x[0]
```

```errors
the parameters are 1001 registers, more than the 1000 a wasm function takes — pass a large value by pointer
function 'copy' needs more than 50000 registers, the most a wasm function has (here [65536]u8 is 65536)
function 'fill' needs more than 50000 registers, the most a wasm function has (here u8, written out 60000 times, is 60000)
an if that gives [1001]u8 gives 1001 registers, more than the 1000 a wasm block gives back
```

<!-- spec:end -->

The modules of a program are one wasm module, which every engine takes with at most 1000000 globals, 100000 imports and 100000 exports. A global held by value is a wasm global for each of its registers; one imported from the host is an import for each, and one the entry module exports an export for each ([7.2](#72-exports)). So the globals of a program are at most 1000000 registers in all, and its imports (a function, or each register of a global) and the exports of its entry module (a function, a memory, or each register of a global) at most 100000 each. Going over is one error, at the global, the import or the export that goes over, the modules taken in the order they are checked, an imported one before the one that imports it.

<!-- spec:begin compile -->

```ents
export global a: [65535]u8
export global b: [65535]u8
```

```errors
the program exports more than 100000 wasm functions, globals and memories, the most a wasm module has (here b: [65535]u8 is 65535)
```

<!-- spec:end -->

Brackets, and prefixes such as `-`, `*`, `?` and `[]` before what they apply to, nest at most 256 deep: `((((x))))` is four levels, and so is `*[]?*u8`. Deeper source is one error, `nested more than 256 deep`, before it is parsed.

### 2.13 Host References

A host reference is a value of the host's (a JavaScript object, a DOM element, a file the host has open) that the module holds and hands back but cannot look into. Its type is declared with `host` as the whole of a type declaration:

```ents
type Canvas = host
type Context = host
```

Each declaration is a type of its own: `Canvas` and `Context` are both host references, but neither is assignable to the other. Another name for one is that type (`type Screen = Canvas`). The name is the type, also across source modules: a module that shares `Canvas` with another declares `type Canvas = host` too, as it restates the signatures it shares. `host` is not reserved, and written anywhere else as a type it is an error (`'host' declares a host reference type: write 'type Canvas = host' and use Canvas`).

A host reference is held where registers are, and nowhere else:

- as a parameter or a result of any function, an imported or exported one too, so the host gives references in and takes them back;
- in a `let` variable or a global, an imported or exported global too;
- as a field of a struct or tuple, or an element of a fixed array, held in registers (`(c: Canvas, n: i32)` as a value, or `[2]Canvas` in a variable).

It has no bytes, so it is never in memory: no pointer points to one, no slice or many-pointer holds one, and neither does `data` or a literal laid out in memory, nor a struct or array that would be. Each of these is an error, as is `sizeof` of one and the `.wid` of an array of them. How a host reference is kept in memory is a design still to come.

#### Never null, and optional

A plain host type is never null: a `Canvas` is always a value the host gave. So it has no default, as a plain function value has none (3.4):

- a `let` or a global of one gets its value where it is declared, and so does one of a struct or a fixed array that holds one (`'c' needs a value where it is declared: a Canvas has no default (a ?Canvas starts as none)`);
- a named result cannot hold one, since a named result starts with a default: return the value instead;
- `0` is no `Canvas`, and neither is any other number: `c == 0` on a plain `Canvas` is an error that says to use `?Canvas`.

A reference that may be null is a `?Canvas`, the optional form, written as `?*T` is for a pointer (2.5); `?Screen` is the same type through another name for it. It follows the rules of `?*T`:

- none is written `0`, the literal: also in parentheses, as the value of a branch, or as a `def` of 0, but nothing computed (`0 + 0` is not none);
- it starts as none: a `let` or a global of one given no value is none;
- `opt == 0` and `opt != 0` ask whether it is none, and are its only comparisons;
- `if let c = opt { ... }` gives a plain `Canvas` where it is not none, and `opt ?? other` is `opt` unless it is none, and `other` (a `Canvas`) then;
- a `Canvas` widens to a `?Canvas` implicitly (`c as ?Canvas` too), and a `?Canvas` is used as a `Canvas` only once resolved (`cannot assign ?Canvas to Canvas: it may be null — resolve it with 'if let' or '??' first`).

`match` does not take a host reference, optional or not, as it does not take a pointer.

#### At the boundary

The module never makes a null `Canvas`. The host promises one too: where a value of a plain host type comes in from the host, as an exported function's parameter, an imported function's result or an imported global's value, it is checked once, as it comes in, and a null there traps (`unreachable`). So a host that breaks the promise stops the program at the boundary, not somewhere later. Nothing is checked anywhere else, nothing for a `?Canvas`, and a program that uses no host type compiles to the same bytes as it would without this rule. An imported global is checked when the module starts (a wasm start function).

For a JavaScript host, null is `null`. `undefined` (what a function that returns nothing gives, or a `Map.get` that finds nothing) is a value, not null: it passes for a `Canvas`, and `opt == 0` is false for it.

Nothing else is computed with a host reference: no arithmetic, no other comparison (two references are not compared: there is no equality for them), no cast to or from a number, an address or another host type (`0 as ?Canvas` is none, and `c as ?Canvas` widens), and no condition. It is passed, returned, stored in a variable or a global, and read back.

The compiler keeps host types as types of their own all the way to the code it writes, so another backend can hold them its own way. In WebAssembly both a `Canvas` and a `?Canvas` are an `externref` today. A later backend may hold a plain one as a `(ref extern)`, which the engine itself keeps from being null, and drop the boundary checks, with no change to the source.

<!-- spec:begin compile -->

```ents
type Canvas = host
type Context = host

import "canvas" (
  "context" func context(c: Canvas) -> Context
  "fill" func fill(ctx: Context, x: f32, y: f32, w: f32, h: f32)
)

// None until the host hands in a canvas.
global ctx: ?Context = 0

// The host hands the canvas in once; the module keeps what it needs.
export func start(c: Canvas) {
  ctx = context(c)
}

// Nothing is drawn before there is something to draw on.
export func draw(n: u32) -> u32 {
  if let x = ctx {
    for i in n {
      fill(x, i as f32 * 12.0, 0.0, 10.0, 10.0)
    }
    return n
  }
  return 0
}

export func started() -> bool => ctx != 0
export func stop() { ctx = 0 }

// A struct of a reference and a number is two values in registers.
type Tagged = (c: Canvas, n: i32)
export func tag(c: Canvas, n: i32) -> Tagged => Tagged(c, n + 1)

// A plain one comes out of an optional one with ?? as well.
export func or-else(maybe: ?Canvas, other: Canvas) -> Canvas => maybe ?? other

test "nothing is drawn before there is a context" {
  assert !started()
  assert draw(3) == 0
  stop()
  assert ctx == 0
  assert draw(3) == 0
}
```

`?` makes a host type optional by any name for it, also one declared further down, and a type parameter given a host type. `host` in parentheses is `host`, as any type is (2.7):

```ents
type Holder = (c: ?Canvas, n: i32)
type Canvas = host
type Screen = Canvas
type Window = (host)
export func window(w: Window) -> ?Window => w

func keep(comptime T: type, x: ?T) -> ?T => x
export func held(h: Holder) -> ?Canvas => h.c
export func screen(s: ?Screen) -> ?Canvas => keep(s)
export func plain(c: Canvas) -> ?Screen => keep(c)

test "an optional one starts as none" {
  let none: ?Screen
  assert none == 0
  assert keep(none) == 0
}
```

None is the literal `0` wherever an optional one is wanted: an element of an array literal or a repeat, a field, a branch with no type of its own, a `def` of 0, and an instance of a generic:

```ents
type Canvas = host
type Pair = (cs: [2]?Canvas, n: i32)
def nothing = 0

global both-none: [2]?Canvas = [0, 0]

export func pair(c: Canvas) -> [2]?Canvas => [c, 0]
export func three() -> [3]?Canvas => [0; 3]
export func field(c: Canvas) -> Pair => Pair([0, c], 1)
export func pick(n: i32, c: ?Canvas) -> ?Canvas {
  let x = if n == 0 { 0 } elif n == 1 { c } else { (0) }
  let y = match n { 0 => c, _ => nothing }
  return if x == 0 { y } else { x }
}
export func grouped(c: Canvas) -> [2]?Canvas => [c, (nothing)]
export func untyped(c: ?Canvas) -> ?Canvas {
  let xs = [c, 0]
  let ys = [0, c]
  return if xs[1] == 0 { ys[0] } else { c }
}
func with-none(comptime T: type, x: T) -> [2]?T => [x, 0]
export func generic(c: Canvas) -> [2]?Canvas => with-none(c)

func none(a: [2]?Canvas) -> bool => a[0] == 0 && a[1] == 0
test "none is 0 in each place" {
  assert none([0, 0])
  assert none(both-none)
  assert none([nothing, (0)])
  assert pick(0, 0) == 0
  assert pick(2, 0) == 0
  assert three()[2] == 0
}
```

Two host types are two types, neither is a number, a plain one is never null, and the one thing asked of an optional one is whether it is none:

```ents
type Canvas = host
type Context = host

func a(c: Canvas) -> Context => c
func b(c: Canvas) -> u32 => c as u32
func c(x: ?Canvas, y: ?Canvas) -> bool => x == y
func d(x: Canvas) -> Canvas => 1 as Canvas
func e() -> Canvas => 0
func f(c: Canvas) -> bool => c == 0
func g(x: ?Canvas) -> Canvas => x
func h() -> ?Canvas => 0 as Canvas
func i(x: Canvas, y: Canvas) -> bool => x != y
type Point = (x: i32, y: i32)
func j(p: ?Point) {}
func n(c: Canvas) -> i32 {
  let both = [0, c]
  return both[1] + 1
}
func k() -> ?Canvas => 0 + 0
func l(x: ?Canvas) -> bool => x == 1 - 1
func m() -> ?Canvas => "".len as ?Canvas
```

```errors
cannot make Point optional: a name is made optional only for a host type
cannot assign Canvas to Context
cannot cast Canvas to u32: Canvas is a host reference, which is no number and no address
'==' cannot be applied to ?Canvas and ?Canvas: ?Canvas is a host reference that may be null, which is only compared with 0
cannot cast int(1) to Canvas
cannot assign int(0) to Canvas: a Canvas is never null (a host reference that may be null is a ?Canvas)
'==' cannot be applied to Canvas and int(0): a Canvas is never null
cannot assign ?Canvas to Canvas: it may be null — resolve it with 'if let' or '??' first
cannot cast int(0) to Canvas: a Canvas is never null
'!=' cannot be applied to Canvas and Canvas: Canvas is a host reference, which is not compared
elements have different types: int(0) and Canvas
cannot assign int(0) to ?Canvas: none of a ?Canvas is written 0, the literal, and nothing computed is one
'==' cannot be applied to ?Canvas and int(1): none of a ?Canvas is written 0, the literal
cannot cast int(0) to ?Canvas: none of a ?Canvas is written 0, the literal
```

A plain host reference has no default, in a variable, a global or a named result, and in a struct or an array either:

```ents
type Canvas = host
type Tagged = (c: Canvas, n: i32)

global g: Canvas
global none: ?Canvas

func vars() {
  let c: Canvas
  let t: Tagged
  let cs: [2]Canvas
  let ok: ?Canvas
}
func result() -> (r: Canvas) {}
func optional-result() -> (r: ?Canvas) {}
```

```errors
global 'g' needs a value: a Canvas has no default (a ?Canvas starts as none)
'c' needs a value where it is declared: a Canvas has no default
't' needs a value where it is declared: Tagged holds Canvas, which has no default
'cs' needs a value where it is declared: [2]Canvas holds Canvas, which has no default
result 'r' cannot start with a default: a Canvas has no default (a ?Canvas starts as none); return the value instead
```

None is in memory, also inside a struct, and also when the type is declared after it is named:

```ents
type Ref = *Holder
type Canvas = host
type Holder = (c: Canvas, n: i32)

func a(p: *Canvas) {}
func b(s: []Canvas) {}
func c(c: Canvas) -> u32 => sizeof(Canvas)
func d(x: host) {}
func e(p: *?Canvas) {}
type Field = (c: host)
func f(c: Canvas) -> u32 {
  let p = &[c, c]
  return p.len
}
func g() -> u32 {
  let p = &[0 as ?Canvas; 4]
  return p.len
}
func h(c: Canvas) -> u32 {
  let cs = [c, c]
  return cs.wid
}
func i(c: Canvas) {
  let cs = [c, c]
  let p = cs.ptr
}
```

```errors
'host' declares a host reference type
cannot point to Holder: it holds Canvas, and a host reference has no bytes, so it is never in memory
cannot point to Canvas: a host reference has no bytes
cannot make a slice of Canvas: a host reference has no bytes
'host' declares a host reference type
cannot point to ?Canvas: a host reference has no bytes
cannot take the size of Canvas: a host reference has no bytes
cannot lay out in memory [2]Canvas: it holds Canvas
cannot lay out in memory [4]?Canvas: it holds ?Canvas
cannot take the width of Canvas: a host reference has no bytes
cannot take .ptr of [2]Canvas: a fixed array held by value has no address
```

A generic type that would put one in memory is refused in the application that does, once for each application however often it is named (8.3), also when the type is named before the host type is declared:

```ents
func Ptr(comptime T: type) -> type => *T
type P = Ptr(Canvas)
type Canvas = host

func a(p: Ptr(Canvas)) {}
func b(p: P) {}
```

```errors
cannot point to Canvas: a host reference has no bytes, so it is never in memory (hold it in a variable, a parameter or a global), in Ptr(Canvas)
```

<!-- spec:end -->

---

## 3. Declarations

### 3.1 Definitions (`def`)

`def` binds compile-time constant values. The value is inlined at every use site — no memory, no pointer, no address.

```ents
def prime32-1 = 2654435761
def max-size = 1024
def origin = (0.0, 0.0)
def mask51 = 0x7FFFFFFFFFFFF:u64

// Using definitions — values are inlined
let hash: u32 = seed + prime32-1
```

`def` is pure substitution. The compiler replaces every reference to the name with the value. Types are inferred from the value or declared on the left:

```ents
def max-size = 1024              // inferred i32
def max-len: u32 = 1024          // explicit u32
```

Each place the name is written is a use of the def, also where its value is an expression (`def next = 'a' + 1`): the editor shows the def there and goes from there to it, its references are those places, and a def used nowhere is reported as never used.

A `def` declared in a `test` block is that test's: it replaces the name inside that test only, and the rest of the module reads the name as if the test were not there.

### 3.2 Data Declarations (`data`)

`data` allocates a value in the wasm data section and binds the name to a pointer.

```ents
data buf = [0:u8; 1024]             // buf: *[1024]u8
data key = x"9d61b19deffd5a60"      // key: *[8]u8
data table = [1:u64, 2, 3, 4]       // table: *[4]u64
data msg = "hello"                   // msg: *[5]u8
data origin = (0.0, 0.0)            // origin: *(f64, f64)
data corners = [(0, 0), (4, 3)]     // corners: *[2](i32, i32)
```

The inferred type is the tightest pointer (`*[N]T`), which auto-coerces to `[]T` or `[*]T` wherever one is expected (9.5). Annotate the LHS to force a specific type:

```ents
data buf = [0:u8; 1024]             // *[1024]u8 (best practice)
data view: []u8 = [0:u8; 1024]      // []u8 (slice, loses compile-time length)
```

An element can be a struct. A tuple gives its fields by position, or by name where it names them, as anywhere a tuple becomes a struct ([2.8](#struct-constructors)); so does a constructor. A slice field written as a string or an array literal points at that literal, which is laid out on its own:

```ents
type Point = (x:i32, y:i32)
type City = (name:[]u8, at:Point)

data cities:*[2]City = [("Oslo", (3, 4)), City(at: Point(y: 2, x: 1), name: "Rome")]
```

Data is laid out when the program is compiled, and no code fills it in later, so each value in it is known by then: a literal, a constant expression (`1 + 1`, `k * 2` with `def k = 4`, `sizeof(u64)`, `~0`), or the name of other data declared before it, which is that data's address (for a slice field, its address and length). Anything else is an error, `data 'xs' is laid out at compile time: its values must be constants`.

```ents
def k = 4
type Ref = (p:*[3]i32, n:u32)

data ones:*[3]i32 = [1, 1, 1]
data xs:*[4]u32 = [1 + 1, k * 2, sizeof(u64), ~0]   // 2, 8, 8, 0xFFFFFFFF
data refs:*[1]Ref = [(ones, 3)]                       // the address of ones, and 3
```

#### Mutability

Data is const unless its literal is `mut`, and a mutable type needs a `mut` literal ([The `mut` Keyword on Literals](#the-mut-keyword-on-literals)). Const data may share its bytes with equal literals; mutable data is its own:

```ents
data table = [0:u8; 256]            // *[256]u8: shared, may be deduplicated
data buffer = mut [0:u8; 1024]      // *mut [1024]u8: unique, never deduplicated
data counts: []mut u32 = mut [0, 0] // []mut u32: unique
data sums: []mut u32 = [0, 0]       // ERROR: a literal is constant: write `mut [0, 0]` for a []mut u32
```

### 3.3 Variables

```ents
// Mutable let variable
let count:i32 = 0
let ptr:*u8       // uninitialized

// Global variable (a wasm global)
global total:i32 = 0
```

A `let` declares a variable of its function, seen from there to the function's end, also after the block it is in has ended; only a `let` in the first branch of an `if let` is seen in that branch alone ([`if let` Bindings](#if-let-bindings)). Its name is its own: it can't be the name of a parameter, a named result or another variable seen there, nor of a global, `def`, `data` block or function of the module (`'count' is already declared in this scope`). The variables of a loop, an `if let` and a match arm are seen in their body only ([5.2](#52-loops)).

A global can be of any value type. One that takes several wasm values (a slice, a struct, a wide integer) is that many wasm globals, one per value, so it works like a local of the same type:

```ents
type Size = (w:i32, h:i32)

global order:[]i32 = (0, 0)        // two wasm globals: the pointer and the length
global size:Size = Size(3, 4)      // one per field
global scratch:Size                // zero until it's set

func keep(list:[]i32) -> u32 {
  order = list
  size.h += 1
  scratch = size
  return order.len
}
```

Type annotations are optional when the type can be inferred from the initializer:

```ents
global counter = 0:u32           // type inferred from suffix
let result = compute()           // type inferred from return type
let pair = (1.0, 2.0)            // type inferred as (f64, f64)
```

A constant with no type, alone or as an element of a tuple, takes its default type ([1.5](#integer-literals)), the same for a `let` and a `global`: `global big = 2147483648` is an `i64` and `let t = (3000000000, 1)` an `(i64, i32)`. The variable is of that type from then on, so `global count = 0` holds any `i32` it is assigned.

A global's initializer is a compile-time constant: a literal, an expression of literals and defs, the address of a `data` block, or a cast of one of these. For a global of several values it's a constructor, tuple or array of those, or a string or `data` array for a slice. The compiler works out each value, so it can be written as it's meant:

```ents
def page = 64 * 1024
data table = [1:u16, 2, 3]

global limit: u32 = 4 * page     // 262144
global ratio: f64 = 2 / 3.0
global mask: u32 = ~0 << 12
global span: (u32, f64) = (4 * page, 1 / 4.0)
global bits: u32 = -1 as u32     // 4294967295
global low: u8 = 300 as u8       // 44, as the cast gives at run time
global bytes: [*]u8 = table as [*]u8
```

The value is the one the expression has at run time, in the types its parts have: `7 / 2` starts an `f64` global as 3.5 and an `i32` one as 3, and `200:u8 + 100:u8` is 44 whatever the global's type.

A cast of an address is a constant when it keeps the address whole: to another pointer type, or to `i32` or `u32`. A value that needs a call or another global isn't a constant: assign it in a function.

### 3.4 Functions

```ents
// Basic function with block body
func add(a:i32, b:i32) -> i32 {
  return a + b
}

// No return type (void)
func greet() {
  log("hello")
}

// Expression body (single expression, implicit return)
func square(x:i32) -> i32 => x * x

// Named return value (implicitly returned at end)
func double(x:i32) -> (result:i32) {
  result = x * 2
}

// Multiple return values
func divmod(a:i32, b:i32) -> (q:i32, r:i32) {
  q = a / b
  r = a % b
}
```

Named return values are declared in the signature with `-> (name:type)`. They act as pre-declared lets and are implicitly returned when the function ends. If the body ends in an expression with a value, that value becomes the result, and widens to its type like a `return` value. With several results a value fills them in order, whatever its own fields are called, and a tuple literal with names fills the results of those names ([2.8](#struct-constructors)), also as the value of a branch of an `if` or a `match` (each branch is a value of its own, as in `picked` below). An expression body gives the results the same way.

```ents
func split(n: u32) -> (hi: u32, lo: u32) => (n >> 16, n & 0xffff)

func halves(n: u16) -> (hi: u64, lo: f64) {
  (n >> 8, n & 0xff)                     // each element widens to its result
}

func swapped(n: u32) -> (lo: u32, hi: u32) {
  split(n << 16 | n >> 16)               // split's hi and lo fill lo and hi, in order
}

func turned(n: u32) -> (lo: u32, hi: u32) => split(n << 16 | n >> 16)   // the same, as an expression body

func named(n: u32) -> (hi: u32, lo: u32) => (lo: n & 0xffff, hi: n >> 16)  // a literal with names, by name

func picked(c: bool, n: u32) -> (lo: u32, hi: u32) {
  if c { split(n) } else { (hi: 1, lo: 2) }   // in order in one branch, by name in the other
}
```

<!-- spec:begin compile -->

A result named like a parameter is that parameter: one variable, which holds the argument and then the result. So it has the parameter's type:

```ents
func round(acc: u64, v: u64) -> (acc: u64) {
  acc = (acc + v) * 31
}

test "a result named like a parameter starts as the argument" {
  assert round(1, 2) == 93
}
```

```ents
func grow(n: u32) -> (n: u64) {
  n = n + 1
}
```

```errors
result 'n' is the parameter 'n', so it has its type: u32, not u64
```

<!-- spec:end -->

A function that takes a type as a parameter, `func max(comptime T: type, a: T, b: T) -> T`, is generic: see [8. Generics](#8-generics).

#### Functions That Share a Name

<!-- spec:begin compile -->

Two functions may have the same name when their parameter lists differ, in the number of parameters or in their types. A call means one of them by its arguments:

```ents
func hash(k: u32) -> u32 => k * 0x45d9f3b
func hash(k: u64) -> u32 => hash((k ^ (k >> 32)) as u32)
func hash(k: []u8) -> (h: u32) {
  h = 0x811c9dc5
  for b in k {
    h = (h ^ (b as u32)) * 0x01000193
  }
}

export func a(n: u32, wide: u64) -> u32 => hash(n) ^ hash(wide)     // hash(k: u32), hash(k: u64)
export func b(name: []u8) -> u32 => hash(name) ^ hash("salt")       // hash(k: []u8), both times

test "each call reaches its own function" {
  assert a(1, 1) == 0
  assert hash(7:u32) == 7 * 0x45d9f3b
  assert b("x") != b("y")
}
```

1. **The function whose parameter types are the argument types is the one called.** `hash(n)` with `n: u32` is `hash(k: u32)`, although a `u32` could also be passed for the `u64` of the second. An untyped literal has no type of its own: beside typed arguments, or typed parts of a tuple, it only has to fit its parameter (see below).
2. **Otherwise it is the only function the arguments can be passed to.** `hash("salt")` is `hash(k: []u8)`: a string is not a number. The argument is then converted as for any call.
3. **Anything else is an error**, whether no function takes the arguments or more than one could:

```ents
func hash(k: u32) -> u32 => k
func hash(k: u64) -> u32 => 1

func f(x: f64) -> u32 => hash(x)
func g() -> u32 => hash(5)
```

```errors
no function 'hash' accepts (f64)
'hash' is ambiguous for (int(5))
```

`hash(5:u64)` says which. A literal has no type of its own and never decides by itself. Beside arguments that have a type it decides nothing either: a function whose typed arguments are exactly its parameter types, and whose literals fit their parameters, is the one called, before any function that would convert an argument. `gt(x, 10)` with `x: u32` is `gt(a: u32, b: u32)`: `x` is a `u32` and `10` fits one, while `gt(a: f64, b: f64)` would convert `x`.

```ents
func gt(a: u32, b: u32) -> bool => a > b
func gt(a: f64, b: f64) -> bool => a > b

export func f(x: u32) -> bool => gt(x, 10)        // gt(a: u32, b: u32)
export func g(x: f64) -> bool => gt(x, 10)        // gt(a: f64, b: f64)
export func h(x: u32) -> bool => gt(x, 2.5)       // 2.5 is no u32: gt(a: f64, b: f64), x converted

test "the typed argument says which" {
  assert f(11)
  assert !f(10)
  assert g(10.5)
  assert !h(2)
}
```

The same holds inside a tuple, a struct literal or `&` of one: its typed parts are exact where they are the parameter's parts, and its literals only have to fit. `far((x, 1))` with `x: u32` is `far(p: (u32, u32))`, and `far((x, 1))` with `x: u64` is the other one. A tuple literal gives a struct's fields by name, or by place where an element has no name ([2.8](#struct-constructors)), and its parts are the fields they give, however deep the literal stands: `(y: 1, x: n)` and `(n, 1)` are as exact for a `(x: u32, y: u32)` as `(x: n, y: 1)` is, and so are `&(y: 1, x: n)` for a `*(x: u32, y: u32)` and `(n: k, at: (y: 1, x: 2))` for a `(at: (x: i32, y: i32), n: u8)`. Laying a literal out this way only settles a call that is not settled without it: where one function is exact for the literal as it is written, that one is called. An array literal is untyped as a whole, even where an element has a type.

```ents
func far(p: (u32, u32)) -> u32 => p.0 + p.1
func far(p: (u64, u64)) -> u32 => 0

export func k(x: u32) -> u32 => far((x, 1))       // far(p: (u32, u32))
export func m(x: u64) -> u32 => far((1, x))       // far(p: (u64, u64))

test "a tuple's typed parts say which" {
  assert k(2) == 3
  assert m(2) == 0
}
```

Only functions that are exact alike remain ambiguous: those whose typed arguments are the same and whose literals fit each of them, as `hash(5)` above, where there is no typed argument at all, and this one, where `x` is a `u8` for both and `3` fits both:

```ents
func put(a: u8, b: u8) -> u32 => 1
func put(a: u8, b: u32) -> u32 => 2

func f(x: u8) -> u32 => put(x, 3)
```

```errors
'put' is ambiguous for (u8, int(3))
```

`put(x, 3:u32)` says which, and `put(x, 300)` needs no help: 300 fits only a `u32`.

What a call's value is used for takes no part in the choice, and neither do results: two functions with the same name and the same parameter types are an error, whatever their parameters are called and whatever they return.

```ents
func hash(k: u32) -> u32 => k
func hash(n: u32) -> u64 => 1
```

```errors
'hash' is already declared with parameters (u32)
```

A name that several functions share says which one only in a call. Anywhere else, as in `let g = hash`, it is an error (`'hash' is the name of several functions: it can only be called, where the arguments say which one`).

Each of the functions is a function of its own in the output, and a call of one is a direct call. In WAT the first one declared keeps the name and each later one carries its parameter types, `$hash:u64`, `$hash:''u8`; the spelling is not part of the language and names do not reach the `.wasm` file. An imported function shares a name in the same way. Every export needs a name of its own:

```ents
export func hash(k: u32) -> u32 => k
export func hash(k: u64) -> u32 => 1
```

```errors
export name 'hash' is used twice: give one an explicit name, as in export "hash_u64" func hash(...)
```

Three things do not share. A generic function's name is unique in its module ([8.1](#81-compile-time-parameters)). A function declared in a `test` block takes over the name of the module's function, as it always has; a name that several functions of the module share cannot be taken over (`'hash' is the name of several functions of the module: a function declared in a test cannot take it over`). And a function declared with the name of a builtin (`min`, `max`, `abs`, ...) takes the builtin's place in its module ([10. Builtin Functions](#10-builtin-functions)): it shares the name with other declared functions, never with the builtin.

Nothing but functions shares a name. A global, `def`, `data` or import has its name to itself in its module, and a function cannot take the name of one, nor can a function or an import declared in a `test`:

```ents
global count: u32 = 0
global count: u64 = 0
def size = 4
func size() -> u32 => 4
```

```errors
'count' is already declared
'size' is already declared
```

A function or a global of another source module imported twice under one name is that one again, not a second declaration.

<!-- spec:end -->

#### Calling Conventions

Functions are called with positional arguments only:

```ents
// Positional arguments (in declaration order)
add(1, 2)
divmod(17, 5)

// Receive multiple return values
let q, r = divmod(17, 5)

// Destructure tuple return values (parens match the tuple)
let (x:, y:) = get_point()
```

<!-- spec:begin compile -->

An argument goes to the parameter at its place, so a call of a function, or of a builtin, names none of them (only a constructor's arguments can have names, [2.8](#struct-constructors)):

```ents
func sub(a: i32, b: i32) -> i32 => a - b

func f() -> i32 => sub(b: 1, a: 2)
func g(x: f64) -> f64 => sqrt(v: x)
```

```errors
'sub' takes positional arguments
'sqrt' takes positional arguments
```

<!-- spec:end -->

#### Function Types and Pointers

> **Status: not yet implemented.** Function types are checked, but a function value has no run-time form yet. Calling one is a compile error (`calling a function value is not supported yet: only a function named directly, or a comptime function parameter (comptime f: (i32) -> i32), can be called`), and a program that only stores or passes one does not assemble. A function's name is no number either: cast to a number or an address, or compared, it is a compile error (`cannot cast func() -> u32 to u32: 'f' is a function, which has no run-time value yet`). To give a function to another function today, pass it at compile time: see [8.6 Comptime Function Parameters](#86-comptime-function-parameters).

Function names are first-class values with types corresponding to their signatures. At runtime, function values are opaque indices into WebAssembly's function table.

```ents
// Function type syntax: input -> output
let callback: i32 -> i32 = double
let binary_op: (i32, i32) -> i32 = add

// Calling through function pointers
let result = callback(5)    // calls double(5)

// Higher-order functions
func apply(x: i32, f: i32 -> i32) -> i32 {
  return f(x)
}

func map(arr: []i32, f: i32 -> i32) -> []i32 {
  // apply f to each element
}

// Functions that return functions
func get_op(add: bool) -> (i32, i32) -> i32 {
  if add { return add_fn } else { return sub_fn }
}
```

Function types require explicit return types — use `-> ()` for void-returning functions:

```ents
// Callback that takes a key and returns nothing
func walk(tree: *Tree, visitor: []u8 -> ()) {
  // call visitor(key) for each key in tree
}
```

The `->` operator is right-associative, enabling curried function types:

```ents
// Curried function type: takes i32, returns function
let curried: i32 -> i32 -> i32   // same as: i32 -> (i32 -> i32)
```

### 3.5 Inline Functions

> **Status: Parsed but not yet implemented** — `inline` is accepted by the parser but functions are compiled as regular calls.

Inline functions are guaranteed to be inlined at each call site. Unlike `def` which performs textual substitution, inline functions have proper type checking and evaluate each argument exactly once:

```ents
// Inline function with expression body
inline func square(x:i32) -> i32 => x * x

// Inline function with block body
inline func round32(seed:u32, value:u32) -> u32 {
  seed += value * prime32-2
  seed <<<= 13
  seed *= prime32-1
  return seed
}
```

Key differences from `def`:

| Feature | `def` | `inline func` |
|---------|-------|---------------|
| Type checking | None (textual) | Full |
| Argument evaluation | Multiple (substituted) | Once |
| Can have locals | No | Yes |
| Can have control flow | No | Yes |

Use `def` for simple literal constants. Use `inline func` when you need type safety and guaranteed single evaluation of arguments:

```ents
def pi = 3.14159:f64              // simple constant
inline func clamp(x:i32, lo:i32, hi:i32) -> i32 =>
  if x < lo { lo }
  elif x > hi { hi }
  else { x }
```

---

## 4. Expressions & Operators

### 4.1 Arithmetic Operators

| Operator | Description | Types |
|----------|-------------|-------|
| `+` | addition | numeric |
| `-` | subtraction | numeric |
| `*` | multiplication | numeric |
| `/` | division | numeric |
| `%` | remainder | integers only |
| `+\|` | saturating add (not yet implemented) | integers |
| `-\|` | saturating subtract (not yet implemented) | integers |
| `*\|` | saturating multiply (not yet implemented) | integers |

The two operands have one type, after [implicit widening](#implicit-widening), and that is the type of the result. Types neither of which holds the other, such as `i32` and `u32`, need a cast.

Saturating operators clamp at type boundaries instead of wrapping:

```ents
let a:u8 = 250
let b = a +| 10      // 255 (clamped, not 4)
let c = a -| 255     // 0 (clamped, not wraparound)

let x:i8 = 100
let y = x +| 50      // 127 (max i8)
let z = x -| 200     // -128 (min i8)
```

### 4.2 Bitwise Operators

| Operator | Description | Types |
|----------|-------------|-------|
| `&` | bitwise AND | integers |
| `\|` | bitwise OR | integers |
| `^` | bitwise XOR | integers |
| `<<` | shift left | integers |
| `>>` | shift right | integers |
| `<<<` | rotate left | integers |
| `>>>` | rotate right | integers |

`&`, `|` and `^` also take two bools. `>>` keeps the sign of a signed value.

`~` of a constant is a bit pattern in the type it's used as, so it fits an unsigned type that holds its operand: `~7` is `0xfffffff8` as a `u32`. A negative constant doesn't: `x & -8` needs a signed `x`.

```ents
func align(n: u32) -> u32 => (n + 7) & ~7     // round up to a multiple of 8
func low_byte(x: u64) -> u64 => x & ~(~0 << 8)
```

The count of a shift or rotate can be any integer type: it doesn't have to match the value, and only its low bits are used: the count modulo the width the value is shifted in, which is 32 bits for a value of 32 bits or fewer and the value's own width otherwise. So `x << 32` on a `u32` is `x`, and on a `u8` too, while `x << 8` on a `u8` is 0. The result has the value's type. If the count's type is wider than the value's, a shift widens the value to that width first, keeping its sign: with a `u8` value and a `u32` count, `x << n` is a `u32`. A constant value has no type of its own and takes the count's: `1 << n` with a `u8` count is a `u8`, so give the `1` a type (`1:u32 << n`) when the result should be wider.

A rotation is always within the value's own width, whatever the count's type: `x <<< 1` on a `u8` moves its top bit to the bottom.

```ents
func rotr(x: u32, n: u32) -> u32 => x >>> n
func swap_nibbles(b: u8) -> u8 => b <<< 4
```

### 4.3 Comparison Operators

| Operator | Description |
|----------|-------------|
| `<` | less than |
| `>` | greater than |
| `<=` | less or equal |
| `>=` | greater or equal |
| `==` | equal |
| `!=` | not equal |

All comparisons return `bool`. The operands widen to one type, as for arithmetic. `==` and `!=` also compare bools and pointers; the ordering operators also compare pointers.

`&&` and `||` take bools and evaluate the right side only when it's needed.

### 4.4 Unary Operators

| Operator | Description |
|----------|-------------|
| `-x` | negation (numbers) |
| `!x` | logical NOT (bool only) |
| `~x` | bitwise NOT (integers) |
| `x.*` | dereference |

For slice/array length and pointer extraction, use property access: `slice.len`, `slice.ptr`.

### 4.5 Assignment and Compound Assignment

```ents
x = 42                   // simple variable assignment
arr[i] = value           // indexed assignment
ptr.* = value            // dereference assignment
ptr.u32 = value          // type-punned memory write
(a, b) = divmod(10, 3)   // tuple destructuring
```

Assignment targets (lvalues) can be:

| Target | Description |
|--------|-------------|
| `name` | Local or global variable |
| `arr[i]` | Array/slice element |
| `ptr.*` | Dereferenced pointer |
| `ptr.T` | Type-punned memory location |
| `(a, b, ...)` | Positional destructuring |
| `(x:, y:, ...)` | Named destructuring (trailing colon) |

> **Status: the type-punned write is not implemented.** `ptr.T` is the pointer as a `[*]T` (see [Type-Punned Memory Access](#type-punned-memory-access)), so `ptr.u32 = value` is a compile error: write `ptr.u32[0] = value`.

An assignment reads its whole value before it writes any of it, so a value can be rebuilt from itself, in a variable or in memory:

```ents
type Point = (x:i32, y:i32)

func flip(p:Point, q:*mut Point) -> Point {
  p = Point(p.y, p.x)          // swaps the fields
  q.* = Point(q.y, q.x)        // and so does this, in memory
  return p
}
```

The same holds for a struct, tuple or slice copied over a place that partly overlaps the one it is read from, and for a value that writes on its way: after `q.* = Point(1, if c { q.x = 9 ... })`, `q.x` is 1. A wide integer (`i128` and up) is one scalar, stored limb by limb from the lowest, so it must not partly overlap its source.

The target's address is evaluated once, and before the value, also for a compound assignment: `xs[next()] += 1` calls `next` one time, and `p.* = if c { p = q ... }` writes where `p` pointed before.

> **Status: Destructuring is not yet fully implemented in codegen.**

Positional destructuring unpacks multiple values in a single assignment:

```ents
(q, r) = divmod(17, 5)   // q = 3, r = 2
(x, y) = (y, x)          // swap values
(ptr, len) = slice       // extract components from multi-value types
```

Named destructuring extracts fields by name (trailing colon):

```ents
type Point = (x:f64, y:f64)
let p = Point(3.0, 4.0)

// Shorthand: trailing colon means variable names match field names
let (x:, y:) = p           // declares x = 3.0, y = 4.0

// Explicit: rename fields to different variables
let (x: px, y: py) = p     // declares px = 3.0, py = 4.0

// Use set to assign to existing variables
let a:f64
let b:f64
set (x: a, y: b) = p       // assigns a = 3.0, b = 4.0
```

A named part names a field of the value, in a `set` as in a `let`: `set (z: a) = p` is an error, `field 'z' not found in Point`.

Any type with multiple underlying values can be destructured (slices, tuples, structs, etc).

`set` assigns what `=` would: a tuple literal, or an `if` or `match` whose branches give one, is checked against the types of the variables it sets, as a `let` with those types would check it. Each constant takes its variable's type and each value widens to it, and a part of the pattern can be a pattern itself:

```ents
func parts(n: i32) -> f64 {
  let wide: i64 = 0
  let ratio: f32 = 0
  let mean: f64 = 0
  let (low, high) = (0, 0)
  set (wide, ratio, mean) = (5000000000, 1, n)   // an i64, an f32 and n widened to an f64
  set (low, (high, wide)) = (1, (2, 3))
  return mean + ((low + high) as f64)
}
```

Any other value is already on the stack, and each field has to be held the way its variable is: `set (wide, ratio) = pair()`, where `pair` returns `(i32, f32)`, is an error (`cannot set 'wide' (i64) from a field of type i32`).

`=`, a compound assignment and `set` assign to variables: locals, parameters, named results and globals. A `def`, a `data` block and a function are not variables, and naming one is an error (`cannot assign to 'buf': it is not a variable`, `cannot set 'buf': it is not a variable`).

#### Compound Assignment

Compound assignment combines an operation with assignment. Works with any valid lvalue:

| Operator | Equivalent |
|----------|------------|
| `x += n` | `x = x + n` |
| `x -= n` | `x = x - n` |
| `x *= n` | `x = x * n` |
| `x /= n` | `x = x / n` |
| `x %= n` | `x = x % n` |
| `x &= n` | `x = x & n` |
| `x \|= n` | `x = x \| n` |
| `x ^= n` | `x = x ^ n` |
| `x <<= n` | `x = x << n` |
| `x >>= n` | `x = x >> n` |
| `x <<<= n` | `x = x <<< n` |
| `x >>>= n` | `x = x >>> n` |
| `x +\|= n` | `x = x +\| n` |
| `x -\|= n` | `x = x -\| n` |
| `x *\|= n` | `x = x *\| n` |

```ents
count += 1               // increment variable
arr[i] += delta          // modify array element
ptr.* ^= mask            // XOR through pointer
```

The result goes back into `x`, so `n` widens to the type of `x`, never the other way: `total += small` is fine, `small += total` needs `small += total as i32`. A shift count (`x <<= n`) can be any integer type.

The result has to fit a range `x`'s type carries ([Ranged Integers](#ranged-integers)), as in the plain `x = x op n`: with `let i = k & 15` (a `u32#16`), `i &= 7`, `i >>= 1` and `i %= 9` keep it, while `i += 1`, `i -= 1`, `i <<= 1` and `i *= 3` are errors (`cannot assign u32#17 to u32#16 (the result of '+=')`), since `buf[i]` on a `*[16]u8` is proven by the range. Only a constant `n` gives the result a range; to step a ranged index, bring it back into range (`i = (i + 1) & 15`) or keep it in a plain `u32`.

### 4.6 Pointer Operations

#### Arithmetic

Only many-pointers are allowed to do pointer arithmetic. Single pointers and fat slices do not support arithmetic.

| Expression | Result |
|------------|--------|
| `ptr + n` | offset forward by n bytes |
| `ptr - n` | offset backward by n bytes |
| `ptr - ptr` | byte distance between pointers |

#### Indexing

```ents
let arr:[*]i32 = ...
arr[2]          // offset by 2 elements (8 bytes for i32)
(arr + 8).*     // equivalent to arr[2]
```

Note: `ptr + n` offsets by bytes, `ptr[n]` offsets by elements.

A `*T` points to one `T`: `p[0]` is that `T`, as `p.*` is, and any other index is an error (`cannot index *u8 past its one element: read it with .*, or index a [*]u8`). A pointer to bytes read one after another is a `[*]u8`.

For arrays and slices with known bounds, runtime indexing is bounds-checked. See [4.7 Bounds-Checked Indexing](#47-bounds-checked-indexing) for details on how `if let`, `??`, and optional types interact with indexing.

#### Type-Punned Memory Access

Read or write memory as a specific type:

```ents
ptr.u32             // read 4 bytes as u32
ptr.u32 = value     // write u32
ptr.f64             // read 8 bytes as f64

// Compound types need parentheses
ptr.(MyStruct)
ptr.([]u8)
```

> **Status: `ptr.T` does not load or store yet.** It is the pointer itself as a `[*]T`, so the value is its element: read `ptr.u32[0]`, write `ptr.u32[0] = value`. Assigning to the pun (`ptr.u32 = value`) is a compile error.

A member is a type view only when its whole name is a primitive type's. The name after the dot is a whole identifier, hyphens included (§1.2), so a name that merely starts like one, `s.boolish`, `p.i8_le`, `v.u32s()`, `x.u32-count`, `p.u32-1`, is a field or a method ([4.9](#49-method-call-syntax)). The view minus one is written with spaces, `p.u32 - 1`, which is how the formatter prints a subtraction. Without a member of that name the error shows the subtraction:

<!-- spec:begin compile -->

```ents
func f(p: *u8) {
  let q = p.u32-1
}
```

```errors
no field 'u32-1' on type *u8: for a subtraction write `p.u32 - 1`
```

<!-- spec:end -->

### 4.7 Bounds-Checked Indexing

An index is an integer of at most 32 bits, signed or not (`an index must be an integer of at most 32 bits, not i64`); a constant bit pattern is the `u32` it stands for (`~4294967293` is 2, [4.2](#42-bitwise-operators)). It is an offset into 32-bit memory, read as an unsigned number, so a negative one is past any length: `xs[i] ?? 0` with `i: i32` equal to `-1` is `0`, and a negative constant index into a `*[N]T` is an error. A many-pointer checks nothing, and there `p[-1]` is the element before the one `p` points to.

Array and slice indexing follows strict rules based on whether the index is known at compile time:

**Compile-time constant indices** are statically verified against the known array length:

```ents
data table = [10, 20, 30, 40]    // *[4]i32
let x = table[0]                  // OK: 0 < 4
let y = table[3]                  // OK: 3 < 4
let z = table[4]                  // compile error: index 4 out of bounds for *[4]i32
```

A slice's length is only known at run time, so a constant index into a slice is checked like any run-time one: `s[0] ?? 0`, or `if let`. A ranged index (`u32#4`) proves itself against a `*[N]T` the same way a constant does ([Ranged Integers](#ranged-integers)). One whose range may pass N proves nothing, and is checked like any run-time index: its element is an optional where it can be one, and `if let` or `??` resolves it; anywhere else it is an error (`index type u32#5 may exceed *[4]u8 bounds`).

**Runtime indices** produce an optional result when the element type is a pointer or slice, since the access might be out of bounds (the row pointers of a table are the exception, see [Nesting](#nesting)):

```ents
data names:[][]u8 = ["Alice", "Bob", "Charlie"]
let name = names[i]               // type: ?[]u8 (optional — might be OOB)
```

The optional result must be resolved before use via `if let` or `??`:

```ents
// Resolve with fallback value
let name = names[i] ?? "Unknown"  // type: []u8

// Resolve with branching
if let name = names[i] {
  // name is []u8 here, guaranteed in bounds
  print(name)
} else {
  print("not found")
}
```

**Primitive element types** cannot be optional (no sentinel value exists for `u8`, `i32`, etc.), so runtime indexing into arrays of primitives requires immediate resolution:

```ents
data values = [1, 2, 3, 4]
let v = values[i]                 // type error: no ?i32 type exists
let v = values[i] ?? 0            // OK: resolved immediately
if let v = values[i] { ... }      // OK: resolved with branching
```

**Explicit optional storage:** When inferring an optional type, you can also store the result for later resolution:

```ents
let msg = strings[idx]            // inferred as ?[]u8
// ... later ...
let resolved = msg ?? "default"   // resolve when needed
```

This generates a bounds check that produces either the real value or the zero sentinel, then a separate null check when unwrapping. If `msg` is only used once, wasm-opt will typically fuse these into a single bounds check. An optional element is never read through before it is resolved (see [Optional Types](#optional-types)): `names[i][0]` and `names[i].len` are errors, `(names[i] ?? "").len` is not. The slice that `??` gives has a run-time length of its own, so an index into it is resolved again:

<!-- spec:begin compile -->

```ents
data names: [][]u8 = ["ab", "cde"]

func first(i: u32) -> u8 => (names[i] ?? "")[0] ?? 0

test "a slice that ?? gives is indexed like any slice" {
  assert first(1) == 99
  assert first(5) == 0
}
```

```ents
data names: [][]u8 = ["ab", "cde"]

func first(i: u32) -> u8 => (names[i] ?? "")[0]
```

```errors
index 0 on []u8 requires 'if let' or '??': a slice's length is only known at run time (no optional type for u8)
```

<!-- spec:end -->

When the elements are optionals themselves (`[]?*T`), the element of an index that isn't proven is that optional, none when the index is out of range, and `if let` and `??` check both the index and the element. An array value of optionals (`[3]?*T`, held in registers or as a field of a struct in memory, `t.a[1]`) is indexed only by a constant in range, so there they check the element.

#### The `??` Operator

The coalesce operator `??` resolves an optional or out-of-bounds index with a fallback value:

```ents
let name = names[i] ?? "Unknown"     // bounds-checked index with fallback
let ptr = optional_ptr ?? default    // null-checked pointer with fallback
```

The fallback value must be assignable to the element/unwrapped type. The result type is the non-optional type. Where the whole is given for the const pointer or slice that the left side's value is the mutable one of, the fallback is given for that type: `count(buf[i..] ?? "")`, with `buf` a `*mut [8]u8` and `count` taking a `[]u8`, is a `[]u8`, and the literal there is constant ([1.5](#the-mut-keyword-on-literals)). With a mutable one wanted, or none (`let s = buf[i..] ?? mut ""`), the fallback is for the mutable type.

#### `if let` Bindings

`if let` checks an optional value or performs a bounds-checked index, binding the result on success:

```ents
// Bounds-checked indexing
if let name = names[i] {
  // name is []u8 — guaranteed in bounds
  print(name)
}

// Optional pointer unwrapping
if let data = entry.dynamic {
  // data is *Dynamic — guaranteed non-null
  process(data)
} else {
  // entry.dynamic was none (ptr=0)
  handle_missing()
}
```

`if let` works with any expression that produces an optional type (`?*T`, `?[]T`) or with index expressions that would produce an optional result.

<!-- spec:begin compile -->

The binding is a variable of its own, seen in the first branch only, and so is a `let` in that branch. Like the variables of a loop ([5.2](#52-loops)), it cannot have the name of a variable seen where it is written, so it never hides one and never changes one:

```ents
data cells = [7:u32, 8, 9]

func get(p: ?*u32) -> u32 {
  if let p = p {
    return p.*
  }
  return 0
}

func pick(i: u32) -> u32 {
  let v: u32 = 5
  if let v = cells[i] {
    return v
  }
  return v
}
```

```errors
'p' is already declared: an if let binding cannot reuse the name of a parameter
'v' is already declared: an if let binding cannot reuse the name of a variable in scope
```

After the branch the name is free again: another `if let` can bind it, to a value of another type, and so can a `let`.

```ents
data cells = [7:u32, 8, 9]
data names = ["ab", "cde"]

func size(i: u32) -> u32 {
  let n: u32 = 0
  if let v = cells[i] {
    n += v
  }
  if let v = names[i] {
    n += v.len
  }
  let v: u32 = 100
  return n + v
}

test "an if let binding is a variable of its first branch" {
  assert size(1) == 111
  assert size(5) == 100
}
```

<!-- spec:end -->

It is an `if` in every other way: it can have `elif` and `else` branches, and with an `else` it's an expression whose branches widen to one type.

```ents
data scores = [95, 87, 42]:*[_]i32

func score(i: u32, lenient: bool) -> i64 => if let s = scores[i] { s } elif lenient { 50 } else { -1 }
```

#### Element Addresses and Writes

Writing `items[i] = v` follows the same rules as reading: the index must be proven in range (a constant or a ranged index into a `*[N]T`), or the write is an error, whatever the element is: `ps[i] = q` with a `*mut [4]*u8` and `i: u32` is refused (`writing to an element needs an index known to be in range`) although `ps[i]` reads as an optional. On a slice no index is proven. For an index that can't be proven, take the element's address: `&items[i]` on a slice or `*[N]T` is `?*T`, none when `i` is out of range, so the check is visible in the code:

```ents
func put(s: []mut u8, i: u32, v: u8) -> bool {
  if let p = &s[i] {
    p.* = v
    return true
  }
  return false
}
```

With a proven index, `&items[i]` is a plain `*T`. A many-pointer (`[*]T`) has no length, so indexing it is never checked; casting to one is the explicit way to opt out. `if let` and `??` have nothing to check on its index, and are errors there (`if let has nothing to check here: [*]i32 has no length, so its index is never checked — index it directly`), unless its elements are optionals themselves. On a many-pointer `&p[i]` is a plain `*T` too, the address `i` elements on, also where a pointer is expected. A many-pointer to rows (`[*][M]T`) is a table, whose elements are its row pointers ([Nesting](#nesting)), so there `&p[i]` is a `**[M]T`.

<!-- spec:begin compile -->

`&` takes the address of something in memory: a literal (which gets a cell of its own in the data section, in parentheses or not: `&(8)` is `&8`), an element of an array, slice or many-pointer, or a value that lies in memory, a field of a struct a pointer points to or a part of one (`&p.pos` is a `*mut Vec2` when `p` is a `*mut Body`, [9.6](#fixed-arrays-in-place)). A part of the literal only known when the program runs is stored into the cell there, each time the `&` is computed, in the order the parts are written: `&(y: f(), x: n)` for a `*Point` calls `f` and then fills in both fields. An array written out where a pointer to an array is wanted is laid out as it is there without the `&`: `&[1, 2]` for a `*[2]i32` is `[1, 2]`. A variable is held in registers and has none, whatever type is expected of `&x`:

```ents
func get(p: *i32) -> i32 => p.*

func third(p: [*]i32) -> i32 => get(&p[2])    // p + 8, the element's address
func cell() -> i32 => get(&5)                   // a cell holding 5
func value(x: i32) -> i32 => get(&x)
```

```errors
'x' has no address: a variable is held in registers
```

<!-- spec:end -->

### 4.8 Slice/Range Syntax

A range makes a slice over part of an array or slice, with no copying:

```ents
let arr:*[16]u8 = ...
arr[2..8]       // []u8 from index 2 to 7 (length 6)
arr[8..]        // []u8 from 8 to end
arr[..4]        // []u8 from 0 to 3
arr[..]         // []u8 whole array as slice
```

Ranges follow the same bounds rules as indexing. A bound is an integer as an index is, of at most 32 bits, signed or not, and a negative one is out of range as a negative index is: `xs[a..b]` with `a = -1` is none, and on a `*[N]T` a negative constant bound is an error (`range -1..2 is out of bounds for *[4]i32`).

- On a `*[N]T`, constant bounds are checked at compile time, and so are ranged bounds whose types prove `start <= end <= N` (for example `arr[..i]` with `i: u32#8` on a `*[16]u8`). The result is a `[]T`.
- Anything else is an optional `?[]T`, none unless `start <= end <= len`, checked at runtime: `s[i..] ?? ""` or `if let rest = s[i..] { ... }`. On a slice, only the whole slice (`s[..]`) is known to fit.
- A many-pointer (`[*]T`) has no length, so its ranges are unchecked and need an end: `p[0..n]`.

A range of a `*mut [N]T` or `[]mut T` is a `[]mut T`.

#### Filling and Copying

Assigning to a range fills it or copies into it:

```ents
buffer[0..1024] = 0       // fill: every element gets the value
cv[0..8] = hs[0..8]       // copy 8 elements
cv[8..16] = iv            // a *[8]T copies all of its elements
```

What is assigned says which. A value that can be assigned to one element is a fill, whatever the element is, and even where it is an array of elements as well (a `Node` of `type Node = *[2]Node`): a number, a struct (`points[0..n] = origin`), a slice (`names[0..3] = "?"` makes each of three `[]u8` the same one-byte string), a pointer, and in a table a row pointer, so every row of the range then points at the same cells. Anything else is the elements to copy: a slice or a pointer to an array of the element type, an array literal (`buf[0..2] = [1, 2]`, laid out as the range's elements are), or an array held in registers, which is stored element by element. A table's rows are copied as its row pointers, so rows of a const table do not go into a mutable one (`cannot copy *[2][3]i32 into a range of *mut [3]i32: its rows are *[3]i32`), as `m[i] = r` is refused for them; an array literal copied there is written `mut`. A value that is neither is refused as the one it was meant as: a value of the element type as written, a `[3]i32` in registers or a const row for a `*mut [2][3]i32`, as a fill (`fill value: cannot assign [3]i32 to *mut [3]i32`, as `m[i] = r` says), anything else as a copy (`cannot copy []u8 into a range of []i32`).

A fill of bytes, or of zeros of any element (a struct of zeros, a wide integer 0, none for an optional slice), is one `memory.fill`; any other fill computes the value once and stores it into each element in a loop. A copy is one `memory.copy`, or the stores of an array held in registers.

The range is written, so it must be known to fit without a runtime check, like an indexed write: constant or ranged bounds on a `*[N]T`, the whole of a slice (`s[..]`), or any range of a many-pointer. A fill can have a runtime length (`buf[..n] = 0` with `n: u32#17` on a `*[16]u8`). A copy needs both lengths known at compile time and equal, so it can't overrun either side; for a length known only at runtime, use `memcpy` (§10.3), where the length is written out.

### 4.9 Method-Call Syntax

`x.f(a, b)` calls the function `f` with `x` as its first argument, when `x` has no member named `f`. Any function can be called this way; there are no methods to declare. (Elsewhere this is called uniform function call syntax.)

<!-- spec:begin compile -->

```ents
type Point = (x: f64, y: f64)

func length(p: Point) -> f64 => sqrt(p.x * p.x + p.y * p.y)
func scale(p: Point, factor: f64) -> Point => Point(p.x * factor, p.y * factor)
func double(n: u32) -> u32 => n * 2

export func a(p: Point) -> f64 => p.scale(2.0).length()      // length(scale(p, 2.0))
export func b(n: u32) -> u32 => n.double().double()          // any type has them, not only structs
export func c(xs: []u8) -> u32 => xs.len.double()            // .len is the slice's own member

test "method calls" {
  assert a(Point(3.0, 4.0)) == 10.0
  assert b(21) == 84
  assert c("abc") == 6
  assert (4:u32).double() == 8
}
```

1. **Members win.** If the type of `x` has a field `f`, directly or through one pointer, `x.f` is that field, whether or not it is called. What a slice, an array and a pointer have built in (`.ptr`, `.len`, `.wid`, `.*`, `.0`, the type views such as `.u32`) are members in this sense. A many-pointer has no `.len`, so `s.len()` for `s: [*]u8` calls a function `len`.
2. **The receiver is the first argument.** `x.f(a, b)` is `f(x, a, b)`. For a generic `f` ([8. Generics](#8-generics)) the receiver is the first argument that is not a comptime one, and the call is the inferred form, so the receiver usually decides the type parameters. `v.push(u32, 7)`, with the type parameters written after the receiver, is the explicit form and means `push(u32, v, 7)`.
3. **The receiver is passed as written.** It gets the conversions any argument gets (`*mut` to `*`, an array pointer to a slice, a narrower number widened) and nothing more: no address is taken of it, and no pointer is followed for it.
4. **Calls chain left to right.** `v.last().double()` is `double(last(v))`.
5. **It is only syntax.** `x.f(a)` and `f(x, a)` are the same call and compile to the same code. Which function `f` is, among functions that share the name, is decided as for any call ([3.4](#functions-that-share-a-name)). A builtin is called the same way: `x.sqrt()`, `a.min(b)`.

```ents
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
func last(comptime T: type, v: *Vec(T)) -> T => v.ptr[v.len - 1]
func push(comptime T: type, v: *mut Vec(T), x: T) {
  v.ptr[v.len] = x
  v.len += 1
}
func double(n: u32) -> u32 => n * 2

export func f(v: *mut Vec(u32), x: f64) -> u32 {
  v.push(7)                                        // push(v, 7): T = u32, from v
  v.push(u32, 8)                                   // push(u32, v, 8)
  return v.last().double() + (x.sqrt().min(9.5) as u32)
}
```

is the same module as the one written with plain calls:

```ents same-wasm
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
func last(comptime T: type, v: *Vec(T)) -> T => v.ptr[v.len - 1]
func push(comptime T: type, v: *mut Vec(T), x: T) {
  v.ptr[v.len] = x
  v.len += 1
}
func double(n: u32) -> u32 => n * 2

export func f(v: *mut Vec(u32), x: f64) -> u32 {
  push(v, 7)
  push(u32, v, 8)
  return double(last(v)) + (min(sqrt(x), 9.5) as u32)
}
```

A value is held in registers and has no address, so a function that takes a pointer cannot be called on one. This is why a container's header lives in memory ([8.5](#85-generic-types)):

```ents
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
func push(comptime T: type, v: *mut Vec(T), x: T) {
  v.ptr[v.len] = x
  v.len += 1
}

func f(v: Vec(u32)) { v.push(7) }
```

```errors
push takes *mut Vec(u32) first; the receiver is a Vec(u32), which is held in registers and has no address
```

An array written out is not such a value: passed for a pointer it is laid out in memory, as it is when it is the first argument, so `[1, 2, 3].sum()` calls `sum(r: *[3]i32)`, and a table written out with a row known only at run time is refused for that row ([2.5](#nesting)).

Otherwise the errors of `x.f(a)` are those of `f(x, a)`, reported at the name of the method and worded for the call as it was written: `x` is the receiver and the arguments are counted after it, as in `'double' expected 0 arguments after the receiver, got 1` for `n.double(1)`. With neither a member nor a function of that name, one error says both. A field that is called is still the field:

```ents
type Box = (size: u32, n: u32)
func size(b: Box) -> u32 => b.size * b.n

func f(b: Box) -> u32 => b.area(2)
func g(b: Box) -> u32 => b.size()
```

```errors
no field 'area' on type Box, and no function 'area' accepts (Box, int(2))
cannot call non-function type: u32 ('size' is a field here, and a field wins over the function 'size': write size(...))
```

A type written on a literal binds more loosely than a member does, so a literal that is given its type is a receiver in parentheses: `(4:u32).double()`.

<!-- spec:end -->

---

## 5. Statements & Control Flow

### 5.1 Conditionals

```ents
if condition {
  // body
}

if condition {
  // body
} else {
  // alternative
}

if cond1 {
  // first case
} elif cond2 {
  // second case
} elif cond3 {
  // third case
} else {
  // default
}
```

Conditions must be boolean - no implicit truthiness:

```ents
if x { ... }      // ERROR: x must be bool
if x != 0 { ... } // OK: explicit comparison
if flag { ... }   // OK: flag is bool
```

The same goes for `while`, `when`, `assert`, and the operands of `&&`, `||` and `!`.

An `if` with an `else` is also an expression. Its value is the last expression of the branch taken, so every branch needs one, unless it always exits (`return`, `break`, `continue`). The branches widen to one type, like operands ([2.10](#implicit-widening)). A branch whose value has no type of its own takes the type of the others, as a literal does anywhere it meets a typed value: an array literal next to a slice or a pointer is laid out as one, so `if c { xs } else { [] }` with `xs: []i32` is a `[]i32`, and so is `if c { xs } else { [7, 8] }`, with or without a type written for the `let` it is given to. The same goes for the arms of a `match`, and for `elif`. A branch that is itself an `if` or a `match` whose values are array literals is not laid out so: it is checked as a value of its own first, so `if a { xs } else { if b { [1] } else { [] } }` is refused (`branches have different types: [] and [1]i32`), and with literals of one length it is a value such as `[2]i32`, which a slice does not take (`cannot convert [2]i32 to []i32 implicitly`). Write the type where the value is given (`let ys: []i32 = ...`), or use `elif`.

```ents
func sign(x: i32) -> i32 => if x < 0 { -1 } elif x > 0 { 1 } else { 0 }

func gap(found: bool, p: i32, l: i32) -> i32 {
  let v = if found { p - l } else { -1 }
  return v
}
```

Used as a statement, an `if` has no value to agree on: its branches can end in anything.

### 5.2 Loops

```ents
while condition {        // condition checked before each iteration
  // body
}

for i in num {           // iterate 0 to n-1
  process(i)
}

for elem in items {      // iterate over the elements of a slice or *[N]T
  process(elem)
}

for i, elem in items {   // with the index (u32) first
  process(i, elem)
}

loop {                   // infinite loop
  // body
}
```

A counted loop's count is an integer of at most 32 bits (`a loop count must be an integer of at most 32 bits, not i64`), evaluated once, before the loop: changing what it was computed from inside the loop doesn't change how often it runs. `i` is a `u32` (a `u32#N` for a constant `N`) that counts up from 0 while it is below the count, so a negative count runs the loop zero times. A constant count that isn't negative is a `u32` too: `for i in 3000000000` counts to it as a `u32` (not as the `i64` the constant is on its own), and a count no `u32` holds, such as `5000000000`, is an error.

An element loop walks a pointer from the first element to the end and loads each element into the binding, so it needs no bounds checks. It works on slices (`[]T`) and pointers to fixed-size arrays (`*[N]T`); a many-pointer (`[*]T`) has no length to stop at.

The element can be of any type: a struct or a slice is loaded whole, each of its values into a register. The binding is a copy, so assigning to it doesn't change the array.

```ents
type Spot = (c:i32, di:i32, room:i32)

func total(list:[]Spot) -> i32 {
  let t = 0
  for s in list {
    t += s.c + s.di + s.room
  }
  return t
}
```

<!-- spec:begin compile -->

The variables of a loop, its element and its index, are seen in its body only. They cannot have the name of a variable seen where the loop is: a parameter, a named result, a `let` before the loop ([3.3](#33-variables)), the variable of a loop, `if let` or match arm the loop is in, or a global. Nor can they have the name of a `def` or a `data` block, which stand for a value wherever they are written. So a loop never hides a variable, and never changes one:

```ents
func count(n: u32) -> u32 {
  let t: u32 = 0
  for n in n {
    t += 1
  }
  return t
}

func after() -> u32 {
  let c: u32 = 5
  for c in 3 {
  }
  return c
}

func grid() -> u32 {
  let t: u32 = 0
  for i in 3 {
    for i in 4 {
      t += 1
    }
  }
  return t
}
```

```errors
'n' is already declared: a loop variable cannot reuse the name of a parameter
'c' is already declared: a loop variable cannot reuse the name of a variable in scope
'i' is already declared: a loop variable cannot reuse the name of a loop variable in scope
```

After the loop its names are free again. A later loop can use them, for elements of another type, and a `let` after the loop declares a variable of its own. A function of the module has no value: a loop variable of its name hides it in the body.

```ents
data bytes = [1:u8, 2, 3]
data wides = [1.5, 2.5]

func scale() -> f64 => 2.0

func total() -> f64 {
  let s: f64 = 0
  for v in bytes {
    s += v as f64
  }
  for v in wides {
    s += v
  }
  for scale in 2 {
    s += scale as f64
  }
  let v: f64 = 0.5
  return s * scale() + v
}

test "a loop's variables are its body's" {
  assert total() == 22.5
}
```

<!-- spec:end -->

### 5.3 Control Statements

All control statements support a `when` suffix for conditional execution:

```ents
break                    // exit innermost loop
break when cond          // exit if condition is true

continue                 // skip to next iteration
continue when cond       // skip if condition is true

return                   // return from function (void)
return value             // return with value
return value when cond   // return if condition is true
```

The `when` form is equivalent to wrapping in `if cond { ... }`.

A bare `return` is for a function with no result, or with named results, which it returns as they are set. In a function with an unnamed result, `return` needs a value.

#### Defer

`defer expr` runs `expr` when the enclosing block exits, by any path: falling off
its end, `break` or `continue` (which run the blocks they leave, up to the loop
body), or `return` (which runs every open block). Deferred expressions run
newest first, and only those reached before the exit run.

```ents
data space = mut [0:u8; 65536]
global top: u32 = 0

func mark() -> u32 => top
func reset(m: u32) { top = m }

export func work(n: u32) -> u32 {
  let m = mark()
  defer reset(m)            // every allocation below is freed on return
  return 0 when n == 0      // runs reset(m) first
  for i in n {
    let inner = mark()
    defer reset(inner)      // freed at the end of each iteration
    // ...
  }
  return n
}
```

- The deferred expression is evaluated when the block exits, not when `defer`
  runs: `defer log(i)` logs `i` as it is at exit.
- A `return` computes its value first; deferred expressions run after, and the
  value is returned unchanged. With named results, a trailing expression's
  value is stored in them before deferred expressions run.
- A deferred expression can't `return`, or `break` or `continue` a loop outside
  it. A loop inside it can use `break` and `continue` as usual.
- Deferred code is emitted inline at each exit. There is no runtime cost and no
  extra wasm features.

### 5.4 Match Expressions

Match expressions provide multi-way branching on values:

```ents
match value {
  0 => handle_zero()
  1 => handle_one()
  _ => handle_other()
}
```

Match arms are tested in order. The subject is evaluated once, before the first test. A literal pattern is compared in the subject's type, so it has to be a value of that type (`300` doesn't match a `u8`). A constant subject (`1`, a `def`, a fixed array's `len`) is compared in its default type. The `_` pattern matches any value and serves as the default case. Each arm can use either expression body (`=>`) or block body:

```ents
let result = match code {
  200 => "OK"
  404 => "Not Found"
  500 => {
    log_error(code)
    "Server Error"
  }
  _ => "Unknown"
}
```

Match is an expression and returns a value. All arms must have compatible types: they widen to one type, like the branches of an `if`.

```ents
let msg:[]u8 = match status & 3 {
  0 => "idle"
  1 => "running"
  2 => "done"
  _ => "error"
}
```

Multiple values can share an arm by using multiple patterns (comma-separated). A pattern is a number, a codepoint (`'a'`, [1.5](#codepoint-literals)) or a bool. A string is not one, and no tuple pattern is compared yet, `'ok'` (the tuple `(111, 107)`) included: match one field at a time.

```ents
match c {
  'a', 'e', 'i', 'o', 'u' => true   // 97, 101, 105, 111, 117
  _ => false
}
```

---

## 6. Pattern Matching

Encantis has a unified pattern syntax that works consistently across match expressions, if-let bindings, and let destructuring. This enables a single grammar rule to express type matching, value matching, and variable binding in all contexts.

### 6.1 Pattern Forms

| Syntax | Description | Bindings |
|--------|-------------|----------|
| `T` | Bare type | none |
| `(T)` | Grouped type (same as bare, but affects calling convention) | none |
| `(name: T)` | Single named binding | `name` |
| `(a: T1, b: T2, ...)` | Tuple with named bindings | `a`, `b`, ... |
| `T(a, b, ...)` | Constructor pattern (destructures T) | `a`, `b`, ... |
| `literal` | Literal value match | none |

### 6.2 Patterns in Function Signatures

Functions have multiple inputs and multiple outputs (0 or more each), mapping directly to WASM's multi-value semantics. All function calls require parentheses.

The signature syntax determines what bindings exist inside the function body:

```ents
// Named parameter binding
func to_polar(point: CartesianPoint) -> (out: PolarPoint)
// Bindings: point, out

// Constructor pattern — destructures into field bindings
func to_polar CartesianPoint(x, y) -> PolarPoint(d, a)
// Bindings: x, y, d, a

// Anonymous parameter — no binding, use positional access
func double i32 -> i32
// Bindings: none (use return statement)
```

### 6.3 Patterns in Match Arms

The same pattern syntax works in match arms:

```ents
// Match with constructor patterns
match point {
  CartesianPoint(0, 0) => "origin"
  CartesianPoint(x, 0) => format("x-axis at {}", x)
  CartesianPoint(0, y) => format("y-axis at {}", y)
  CartesianPoint(x, y) => format("({}, {})", x, y)
}

// Named field patterns
match point {
  Point(x: 0, y:) => use_y(y)      // match x=0, bind y
  Point(x:, y: 0) => use_x(x)      // bind x, match y=0
  _ => default()
}
```

#### Pattern Matching on Enums

> **Status: Not yet implemented** — depends on enum type support.

Use `match` to destructure enum variants:

```ents
func describe(c:Color) -> []u8 {
  match c {
    Red => "red"
    Blue => "blue"
    Green => "green"
    RGB(r, g, b) => format("rgb({}, {}, {})", r, g, b)
    HSL(h, s, l) => format("hsl({}, {}, {})", h, s, l)
    Grey(b) => format("grey({})", b)
    Darker(inner) => format("darker({})", describe(inner.*))
  }
}
```

The compiler enforces exhaustive matching when matching an enum — all variants must be handled, or a wildcard `_` pattern must be present.

#### Struct and Tuple Patterns

> **Status: Not yet implemented** — `match` compares numbers, codepoints and bools; a tuple pattern is refused (`match cannot compare a tuple pattern yet: compare one field at a time`).

Pattern matching works on structs and tuples too, not just enums:

```ents
type Point = (x:i32, y:i32)

func describe_point(p:Point) -> []u8 {
  match p {
    Point(0, 0) => "origin"
    Point(0, y) => format("y-axis at {}", y)
    Point(x, 0) => format("x-axis at {}", x)
    Point(x, y) => format("({}, {})", x, y)
  }
}

// Anonymous tuple patterns too (not yet: the compiler refuses a tuple pattern)
func check_pair(pair:(i32, i32)) -> bool {
  match pair {
    (0, 0) => true
    (x, y) if x == y => true  // guard clause
    _ => false
  }
}
```

The convention distinguishes patterns by case:

- **Uppercase** (`Point`, `RGB`) — type constructor or variant
- **lowercase** (`x`, `y`) — binding (introduces a variable)
- **literals** (`0`, `'a'`, `true`) — exact match
- **`_`** — wildcard (match anything, don't bind)

<!-- spec:begin compile -->

A binding is a variable of its arm, seen in the arm's body only. Like the variables of a loop ([5.2](#52-loops)), it cannot have the name of a variable seen where the `match` is:

```ents
func next(n: u32, k: u32) -> u32 => match k {
  0 => 1
  n => n + 1
}
```

```errors
'n' is already declared: a match binding cannot reuse the name of a parameter
```

<!-- spec:end -->

### 6.4 If-Let Bindings

`if let` has two primary uses: bounds-checked indexing and optional unwrapping.

#### Bounds-Checked Indexing

`if let` with an index expression performs a runtime bounds check. If the index is in range, the element is loaded and bound to the variable. If out of bounds, the else branch executes:

```ents
data names = ["Alice", "Bob", "Charlie"]

if let name = names[i] {
  // name is []u8 — index was in bounds
  print(name)
} else {
  print("index out of range")
}
```

For arrays with compile-time known lengths (e.g., `*[N]T`), the bounds check compares the runtime index against the constant length. For slices (`[]T`), it compares against the runtime `.len` field.

#### Optional Unwrapping

`if let` with an optional expression (`?*T` or `?[]T`) performs a null check. If the pointer is non-zero, the value is bound; otherwise the else branch executes:

```ents
type Entry = (name: []u8, next: ?*Entry)

if let next = entry.next {
  // next is *Entry — guaranteed non-null
  process(next)
}
```

#### Pattern Matching

> **Status: Not yet implemented** — pattern matching with constructors depends on enum type support.

`if let` will also support constructor patterns for enum destructuring:

```ents
if let RGB(r, g, b) = color {
  draw_rgb(r, g, b)
} elif let HSL(h, s, l) = color {
  draw_hsl(h, s, l)
} else {
  draw_default()
}
```

### 6.5 Let Destructuring

> **Status: Not yet fully implemented in codegen.**

```ents
// If-let with pattern
if let CartesianPoint(x, y) = maybe_point {
  process(x, y)
}

// Let destructuring
let CartesianPoint(x, y) = get_point()
let (x:, y:) = get_point()  // equivalent with punning
```

---

## 7. Modules

### 7.1 Imports

```ents
// Import function from host environment
import "env" "log" func log(msg:[]u8)

```

Multiple imports from the same module can be grouped:

```ents
import "math" (
  "sin" func sin(angle:f64) -> f64
  "cos" func cos(angle:f64) -> f64
  "atan2" func atan2(y:f64, x:f64) -> f64
)
```

Whitespace is flexible - the import and function signature can span multiple lines:

```ents
import "sys" "print"
func print(msg:[]u8)
```

#### Source modules

A module string that starts with `./`, `../` or `/` names another source file (`.ents` is added): the two are compiled into one wasm module, and what is imported is what that file exports. Imports inside a `test` block are followed only when tests are built.

```text
import "./util" "add" func add(a: i32, b: i32) -> i32
import "../lib/text" (
  "next_line" func next_line(s: []u8) -> (line: []u8, rest: []u8)
)
```

The signature an import writes is documentation: what the other module exports under the name is what is called, and the module that imports it is checked against that. A name that is not exported is `'add' is not exported from './util'`. Types are structural, so a struct type used across modules is declared again (or written out) where it is needed; a `type` is not imported.

A generic function is imported with its signature, comptime parameters included, and a generic type as the function it is, with no body: `func`, its upper-case name, its parameters and `-> type`. Both are the generics of the module that declares them: see [8.7 Generics Across Modules](#88-generics-across-modules).

```text
import "./containers" (
  "Vec" func Vec(comptime T: type) -> type
  "push" func push(comptime T: type, v: *mut Vec(T), x: T)
)
```

When a file is checked without the files it imports (the editor's web worker, a spec block), a generic function it imports is the signature its import writes, and its calls are checked against that signature. A generic type is unknown there, and so is anything made of it: such a file lists no errors, and has one warning, `imported generic types are resolved only when the program is checked`. The command line and the desktop editor check the program.

### 7.2 Exports

```ents
// Export function - name defaults to function identifier
export func add(a:i32, b:i32) -> i32 => a + b

// Export with explicit name (when export name differs from internal name)
export "_start" func main() { ... }

// Export anonymous function (explicit name required)
export "hash" func (data:[]u8, seed:u32) -> u32 {
  // only accessible via export, no internal calls
}

// Export memory (name defaults to "memory")
export memory              // implicit min, unbounded max
export memory 8            // 8 pages min
export "mem" memory 8 256  // explicit name, 8 min, 256 max

// Export global - name defaults to global identifier
export global counter:i32 = 0
```

A global of several wasm values is exported (and imported from the host) as one wasm global per value, each named for its part the way a local's registers are: `export global order:[]i32` exports `order_ptr` and `order_len`, and a struct global `size:(w:i32, h:i32)` exports `size_w` and `size_h`.

Only the entry module's exports reach the host. In a module that another imports, `export` makes a name importable. A generic function or generic type is never exported to the host, since there is no one function of it (and nothing of a generic type exists at run time): its `export` makes it importable by other source modules, and in an entry module it emits nothing, so a library of generics compiles on its own to a module with none of them. To export an instance, write a wrapper: `export func push_u32(v: *mut Vec(u32), x: u32) { push(v, x) }`.

### 7.3 Memory Declarations

```ents
// Declare memory (pages of 64KB)
memory                     // compiler computes min from static data, no max
memory 8                   // min 8 pages
memory 8 256               // min 8 pages, max 256 pages
```

When no min is specified, the compiler computes it as `max(1, ceil(static_data_bytes / 65536))`. When no max is specified, no upper bound is emitted (the runtime caps at its own limit).

---

## 8. Generics

A generic function is written once and compiled once for each type it is used with. Types are passed as compile-time parameters; nothing of them exists at run time. A generic type ([8.5](#85-generic-types)) is a type with type parameters, a comptime function parameter ([8.6](#86-comptime-function-parameters)) is how a generic is given a function to call, and a comptime value parameter ([8.7](#87-comptime-value-parameters)) is how it is given a number, such as the length of an array, `[n]T`. Two things of the rest of the language are what make generic code read well: method-call syntax, `v.push(7)` ([4.9](#49-method-call-syntax)), and functions that share a name ([3.4](#functions-that-share-a-name)), through which each type brings its own `hash` and `eq` ([8.3](#83-requirements)).

The examples of this chapter are run as tests: each one is checked, compiled and validated, the `test` blocks in them are run, and each `errors` block is what the compiler reports for the example before it (see [`spec/README.md`](../spec/README.md)). The programs under [`examples/generics/`](../examples/generics) carry more tests of the same functions.

<!-- spec:begin compile -->

### 8.1 Compile-Time Parameters

A parameter marked `comptime` is given at compile time. The function is compiled once for each distinct set of compile-time arguments it is called with, and each copy is an ordinary function that has only the remaining parameters.

```ents
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }

export func widest(a: u32, b: u32) -> u32 => max(u32, a, b)
export func longest(a: f64, b: f64) -> f64 => max(a, b)
```

compiles to exactly the module this does:

```ents same-wasm
func max_f64(a: f64, b: f64) -> f64 => if a > b { a } else { b }
func max_u32(a: u32, b: u32) -> u32 => if a > b { a } else { b }

export func widest(a: u32, b: u32) -> u32 => max_u32(a, b)
export func longest(a: f64, b: f64) -> f64 => max_f64(a, b)
```

A **type parameter** is written `comptime T: type`. Its name starts with an upper-case letter, like every type name. Inside the function `T` is a type: it can be used wherever a type can be written (`x: T`, `[]T`, `*mut T`, `sizeof(T)`, `p as [*]mut T`) and passed on as a type argument (`fact(T, n - 1)`). A comptime parameter may also be a function ([8.6](#86-comptime-function-parameters)) or a number, `comptime n: u32` ([8.7](#87-comptime-value-parameters)).

Rules:

1. Comptime parameters may appear anywhere in the parameter list; by convention they come first, in the order a type writes them: a value parameter `n` before a type parameter `T`, as in `[n]T`. A parameter's type may mention any comptime parameter of the same function.
2. `comptime` is only written in the parameter list of a named function declared with `func` at module level. Every parameter of such a function has a name.
3. A function with a comptime parameter is a *generic function*. It is not a value: it cannot be stored, passed as an argument, or exported to the host. It can only be called. Its name is unique in its module.
4. The body of a generic function is checked when the function is instantiated, with the types filled in, and not before. A generic function that is never called is only parsed, and nothing is emitted for it.

`comptime` is a reserved word.

### 8.2 Calling a Generic Function

A call to a generic function is written in one of two forms.

**Explicit.** Every parameter gets an argument, in order. The argument of a type parameter is a type, written as it is after a colon:

```ents
type Pt = (q: i32, r: i32)

func pick(comptime T: type, first: bool, a: T, b: T) -> T => if first { a } else { b }
func head(comptime T: type, xs: []T) -> T => xs.ptr[0]

export func a(c: bool, x: u8, y: u32) -> u32 => pick(u32, c, x, y)      // x is widened, as for any u32 parameter
export func b(c: bool, p: Pt, q: Pt) -> Pt => pick(Pt, c, p, q)
export func c(c: bool, p: (i32, i32), q: (i32, i32)) -> (i32, i32) => pick((i32, i32), c, p, q)
export func d(xs: [][]u8) -> []u8 => head([]u8, xs)
export func e(xs: []*mut Pt) -> *mut Pt => head(*mut Pt, xs)
export func f(xs: []u64) -> u64 => head(u64, xs)
export func g(c: bool, n: []u8, p: Pt) -> []u8 => pick((name: []u8, at: Pt), c, (name: n, at: p), (name: "-", at: p)).name
```

In that position a name is read as a type even if a variable of the same name is in scope (`u8` there is the type, as it is in `let x: u8`).

**Inferred.** All type parameters are left out, and the compiler finds them from the other arguments:

```ents
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }
func head(comptime T: type, xs: []T) -> T => xs.ptr[0]
func swap(comptime T: type, a: *mut T, b: *mut T) {
  let tmp = a.*
  a.* = b.*
  b.* = tmp
}

data primes = [2:u16, 3, 5, 7]

export func a(x: u32, y: u32) -> u32 => max(x, y)          // T = u32
export func b(x: f64) -> f64 => max(x, 0.5)                 // T = f64; the literal is an f64
export func c(x: u64) -> u64 => max(1, x)                   // T = u64, decided by x
export func d(xs: []u64) -> u64 => head(xs)                 // T = u64, from []T
export func e() -> u16 => head(primes)                      // T = u16: a data array is a slice here
export func f(p: *mut i64, q: *mut i64) { swap(p, q) }      // T = i64, from *mut T

test "inferred calls" {
  assert a(3, 7) == 7
  assert b(0.25) == 0.5
  assert c(0) == 1
  assert e() == 2
}
```

**Which form a call is** depends only on how many arguments it has. If a function has `P` parameters of which `K` are type or value parameters, a call with `P` arguments is explicit and a call with `P - K` arguments is inferred. Anything else is an error that says both counts. There is no form that writes some comptime arguments and infers others. Arguments are positional. A value parameter is inferred from the length of an array in an argument's type ([8.7](#87-comptime-value-parameters)).

#### How type parameters are inferred

1. **The first argument that can decide a type parameter decides it.** Go through the parameters left to right. The first one whose written type mentions `T`, and whose argument has a type of its own, decides `T`.
2. **Deciding is matching shapes.** The parameter's written type is laid over the argument's type: `T` against `u32` gives `T = u32`; `[]T` against `[]u64` gives `T = u64`; `*mut T` against `*mut i64` gives `T = i64`; `(T, U)` against `(i32, f64)` gives both. Matching looks through the conversions an argument gets anyway, and through nothing else:

   | Parameter | Argument | Result |
   |---|---|---|
   | `*T` | `*mut X` | `T = X` |
   | `[]T` | `[]mut X` | `T = X` |
   | `[]T`, `[*]T` | `*[N]X` (a `data` array, a string) | `T = X` |
   | `?*T` | `*X` | `T = X` |
   | `*T` | `[*]X` | no match: what a many-pointer points to is not a type by itself. `[*]T` matches it |
   | `T` | a value known to lie in a range, `u32#12` | `T = u32` (the range is dropped, also from the values a tuple argument is made of) |
   | `T` | `u8`, where a later argument is `u32` | `T = u8`: numbers are not widened to make arguments agree |
   | `*Vec(T)` | a pointer to a struct of `Vec`'s shape | `T` from the field that is made of it ([8.5](#85-generic-types)) |
   | `(T) -> T` | a function, `inc` | `T` from its parameter, or else its result |
   | `(T, T)` | a tuple with a literal in it, `(i, 1)` with `i: u32` | `T = u32`, from its typed part |

   Type aliases are transparent, as everywhere.
3. **Untyped literals never decide.** `7`, `0.5` and `[1, 2, 3]` have no type of their own; they take the type the parameter turns out to have. A literal with a type written on it (`7:u8`) is typed and can decide. A tuple decides by the parts of it that are typed, and its literals decide nothing: with `p: (T, T)`, `keep((i, 1))` for an `i: u32` gives `T = u32`, and the `1` is then a `u32`; `keep((1, 2))` decides nothing. So does a struct literal, `(x: i, y: 1)`, and `&` of either. An array literal is untyped as a whole, even where an element has a type.
4. **Every other argument is an ordinary argument.** Once `T` is decided, the remaining arguments are checked against the now-concrete parameter types exactly as for a hand-written function: the same implicit conversions, the same errors.
5. **Nothing is guessed.** If no argument decides a type parameter the call is an error and the type has to be written. That includes a call whose only candidates are literals (`max(1, 2)`) and a type parameter that appears only in the result (`zero()`): the expected type of the call is not used. An argument that has an error of its own decides nothing either, and the call adds no error to it.
6. **`()` is never a type argument.** It has no values, so there is nothing to pass for a parameter of that type. An argument without a value, such as a call of a function that returns nothing, is an error where it stands: `argument 1 of 'id' has no value`.

```ents
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }

func f(a: u8, b: u32) -> u32 => max(a, b)
```

```errors
argument 2: cannot assign u32 to u8
```

`max(b, a)` is accepted (`T = u32`, and `a` widens like any `u8` passed for a `u32`), and so is `max(u32, a, b)`.

```ents
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }
func zero(comptime T: type) -> T => 0

func f() -> i32 => max(1, 2)
func g() -> u32 => zero()
```

```errors
cannot infer T for 'max' from untyped literals: write max(i32, ...) or give a literal its type (1:i32)
cannot infer T for 'zero': write the type argument, as in zero(u32)
```

### 8.3 Requirements

A generic states no requirements. It uses its type parameter, and each use is checked for the concrete type when the generic is instantiated. There are no traits or interfaces: what a type must provide is whatever the generic's body does with it.

Operators are requirements. The operands of an operator are single values: numbers, `bool`s and pointers, each operator with the types [chapter 4](#4-expressions--operators) gives it. No operator is defined for structs, tuples, slices or arrays:

```ents
type Pt = (q: i32, r: i32)
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }

export func f(a: Pt, b: Pt) -> Pt => max(a, b)
```

```errors
'>' cannot be applied to Pt and Pt, in max(T = Pt)
```

This holds for every operator, whether it stands between two operands, before one (`-a`, `~a`, `!a`) or in a compound assignment:

```ents
type Pt = (q: i32, r: i32)
func neg(comptime T: type, a: T) -> T => -a
func add(comptime T: type, a: T, b: T) -> T {
  let sum = a
  sum += b
  return sum
}

export func f(a: Pt, b: Pt) -> Pt => add(neg(a), b)
```

```errors
'-' needs a number, not Pt, in neg(T = Pt)
'+=' cannot be applied to Pt and Pt, in add(T = Pt)
```

The error is reported at the line of the generic's body where it occurs, with types printed as they are in that instance (never as `T`), followed by the instance. An instance shared by calls that wrote `Meters`, `Feet` and `f64` reads the same for all of them: an alias that only renames a type is printed as the type, a struct by its name. Each instance is checked once, so its errors appear once however many calls use it. Every other error of the language can occur in an instance and reads as usual plus the `, in ...` suffix. A module's own errors are listed first, then those of its instances.

The command line also prints the call that first asked for the instance and, where that call is itself in an instance, the call that asked for that one, four of them at most. The editor shows them as the error's related locations.

```text
shapes.ents:2:51: '>' cannot be applied to Pt and Pt, in max(T = Pt)
  required from shapes.ents:4:38
```

**Calls are requirements too.** A call in a generic body, `eq(a, b)` or `k.hash()`, is resolved when the instance is checked, by its name and the types of its arguments ([3.4](#functions-that-share-a-name)). So each type a generic is used with brings its own function:

```ents
func hash(k: u32) -> u32 => k * 0x45d9f3b
func hash(k: []u8) -> (h: u32) {
  h = 0x811c9dc5
  for w in k {
    h = (h ^ (w as u32)) * 0x01000193
  }
}
func eq(a: u32, b: u32) -> bool => a == b
func eq(a: []u8, b: []u8) -> bool {
  return false when a.len != b.len
  for i in a.len {
    return false when a.ptr[i] != b.ptr[i]
  }
  return true
}
func bucket(comptime K: type, k: K, n: u32) -> u32 => k.hash() % n
func same(comptime K: type, a: K, b: K) -> bool => hash(a) == hash(b) && a.eq(b)

export func f(a: []u8, b: []u8) -> u32 => if same(a, b) { bucket(a, 16) } else { bucket(7:u32, 3) }
export func g(a: u32, b: u32) -> bool => same(u32, a, b)
```

`same` for `K = []u8` calls `hash(k: []u8)` and `eq(a: []u8, b: []u8)`; for `K = u32` it calls the other pair. All of them are direct calls, and the module is the one with every function written out under a name of its own:

```ents same-wasm
func hash_u32(k: u32) -> u32 => k * 0x45d9f3b
func hash_bytes(k: []u8) -> (h: u32) {
  h = 0x811c9dc5
  for w in k {
    h = (h ^ (w as u32)) * 0x01000193
  }
}
func eq_u32(a: u32, b: u32) -> bool => a == b
func eq_bytes(a: []u8, b: []u8) -> bool {
  return false when a.len != b.len
  for i in a.len {
    return false when a.ptr[i] != b.ptr[i]
  }
  return true
}
func bucket_bytes(k: []u8, n: u32) -> u32 => hash_bytes(k) % n
func bucket_u32(k: u32, n: u32) -> u32 => hash_u32(k) % n
func same_bytes(a: []u8, b: []u8) -> bool => hash_bytes(a) == hash_bytes(b) && eq_bytes(a, b)
func same_u32(a: u32, b: u32) -> bool => hash_u32(a) == hash_u32(b) && eq_u32(a, b)

export func f(a: []u8, b: []u8) -> u32 => if same_bytes(a, b) { bucket_bytes(a, 16) } else { bucket_u32(7:u32, 3) }
export func g(a: u32, b: u32) -> bool => same_u32(a, b)
```

A type that does not bring a function the body calls is one error for that function, where the generic is first used with the type. It is reported once for the instance, however many calls in the body ask for the function, and it reads the same whether no function of the name takes the type or none of that name is declared at all:

```ents
func hash(k: u32) -> u32 => k * 0x45d9f3b
func hash(k: []u8) -> u32 => k.len
func same(comptime K: type, a: K, b: K) -> bool => hash(a) == hash(b) && eq(a, b)

export func f(a: f64, b: f64) -> bool => same(a, b)
```

```errors
no function 'hash' accepts (f64), in same(K = f64)
no function 'eq' accepts (f64, f64), in same(K = f64)
```

A call with the wrong number of arguments for the one function of its name is a mistake in the body, not a requirement on the type, and reads as it does anywhere (`'eq' expected 2 arguments, got 1, in same(K = u32)`). So is a literal that is wrong as it is written, whatever the type: one without `mut` for a mutable slice (``argument 1: a literal is constant: write `mut "ab"` for a []mut u8, in same(K = u32)``), single quotes where a string is wanted, or a string where a character is.

### 8.4 Instances

An *instance* is one generic function with all its comptime arguments fixed.

- **Identity.** Two calls use the same instance when they name the same generic and their comptime arguments are equal. Types compare structurally, with aliases expanded: `Pt` and the struct `(q: i32, r: i32)` it names are one argument, and so are a type that refers to itself and an alias of it. The names of a function type's parameters are not part of it. A function given for a comptime function parameter is an argument like a type: two instances are one when their functions are the same function. A number given for a value parameter is one too: two instances are one when theirs are the same number in the parameter's type. Explicit and inferred calls that arrive at the same arguments share the instance, and each call is still checked against the types as it wrote them.
- **Once.** An instance is one function in the output however many calls use it. Across source modules, one whose body calls a function of the module that asked for it is one for each such module ([8.8](#88-generics-across-modules)).
- **On demand.** An instance is created by the first call that needs it. A generic nobody calls has no instances; a generic used only from `test` blocks has instances only in test builds.
- **Zero cost.** An instance is the function you would get by writing the generic out by hand for those arguments, and it compiles to the same bytes. A call compiles to one `call` of the instance with only the non-comptime arguments. Nothing exists at run time for a type parameter, for a generic type, or for a generic that is not used. No function tables and no indirect calls are involved.
- **Statics.** A data literal in a generic body belongs to each instance separately, as it would in hand-written copies; a `mut` literal is one buffer per instance.
- **Recursion.** A generic may call itself or another generic. A generic that instantiates itself with a larger type each time never finishes; the compiler stops with one error after 64 nested instantiations, or sooner when one call has led to 1000 instances or to type arguments many times the size of its own. A type argument written in ordinary code may be of any size.
- **Place and names.** In the output a generic's place is taken by its instances, in the order of their names. In WAT an instance is named after the generic and its arguments, `$max<u32>`, `$head<''u8>`, `$sort<i32|ascending>`, `$push<8|u32>` (a number in decimal); the exact spelling is not part of the language and names do not reach the `.wasm` file.

```ents
func bytes(comptime T: type, n: u32) -> u32 => n * sizeof(T)
func fact(comptime T: type, n: T) -> T => if n <= 1 { 1 } else { n * fact(T, n - 1) }

export func a() -> u32 => bytes(u64, 3) + bytes((u32, u16), 2)   // 24 + 12
export func b() -> u64 => fact(u64, 20)

test "each instance has its own sizeof, and recursion ends" {
  assert a() == 36
  assert b() == 2432902008176640000
}
```

**In the editor.** What a name in a generic's body is depends on the instance, and the editor (hover in the language server, and the `hover`, `definition` and `references` commands) shows what each instance makes of it:

- A parameter, result or local shows the type it is declared with, in terms of the type parameters, and its type in each instance: `x: T — in index_of(T = u32): u32; in index_of(T = f64): f64`. A local whose type is not written is shown in terms of the type parameters where its types in the instances differ as one type parameter's arguments do, and otherwise as each type it is (`f32 or i64`); so it is also where two type parameters are bound alike in every instance, since which one it follows cannot be told. A field after a point is the member in each instance.
- A type parameter shows what each instance binds it to; a value parameter, its declared type and the number each instance was given (`n: u32 — in sum(n = 4): 4; in sum(n = 8): 8`); a comptime function parameter, the function each instance was given.
- A call in the body shows the function each instance calls, where they are not all one function: `eq(y, x)` calls `eq(a: u32, b: u32)` in `index_of(T = u32)` and `eq(a: f64, b: f64)` in `index_of(T = f64)`.
- A generic shows its instances, a call of it the instance it calls, and a method call `x.f(a)` the call `f(x, a)` it is.
- A generic type shows its declaration and its applications (`in Pair(u32): (a: u32, b: u32)`), and its type parameters and fields what each application makes them, also a field of an element it holds (`k` in `items: [*](k: K, v: V)`).

Instances that agree are listed together, and past twelve instances the rest are counted. The references of one of several functions that share a name include a call in a generic's body only where an instance calls that function, and a function no call calls is reported as never used. A generic nothing instantiates has no instance to go by: a call in its body counts as a use of every function of its name, only what is written there (a parameter's type) is shown, and its type parameters and comptime function parameters are found where they are used.

What "zero cost" does not promise: no inlining (a user-declared generic `max` is a call where the builtin `max` is an inline `select`), and no merging of instances that happen to compile to the same bytes (`swap` for `u32` and for `i32` are two functions, as two hand-written functions would be).

**Exporting.** `export func max(comptime T: type, ...)` is accepted and emits nothing: there is no single function to give the host. It makes the generic importable by other source modules ([8.8](#88-generics-across-modules)). To export an instance, export a function that calls it:

```ents
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }

export func max_u32(a: u32, b: u32) -> u32 => max(a, b)
```

### 8.5 Generic Types

A generic type is a function from types to a type. It is declared with `func`, an upper-case name, the result `type`, and a type after `=>`:

```ents
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
func Pair(comptime A: type, comptime B: type) -> type => (first: A, second: B)

func last(comptime T: type, v: *Vec(T)) -> T => v.ptr[v.len - 1]
func swapped(comptime A: type, comptime B: type, p: Pair(A, B)) -> Pair(B, A) => Pair(B, A)(p.second, p.first)

export func a(v: *Vec(u32)) -> u32 => last(v)
export func b(v: *(ptr: [*]mut f64, len: u32, cap: u32)) -> f64 => last(v)
export func c(p: Pair(u8, u64)) -> Pair(u64, u8) => swapped(p)
export func d() -> u32 => sizeof(Vec(u8)) + sizeof(Pair(u8, u64))     // 12 + 9

test "a pair is swapped, and sizes follow the arguments" {
  let p = c(Pair(u8, u64)(1, 2))
  assert p.first == 2
  assert p.second == 1
  assert d() == 21
}
```

Applying it, `Vec(u32)`, is a type and can be written wherever a type can: a parameter, a result, a field, a cast, `sizeof(Vec(T))`, a `let` annotation, another generic type's body, a type argument. There is no space between the name and the parenthesis. A generic type's parameters are type parameters, and numbers (`func Ring(comptime n: u32, comptime T: type) -> type`, [8.7](#87-comptime-value-parameters)); all are always written: `Vec` alone is not a type.

A generic type is declared at module level, before or after its uses, and its name is unique among the types of its module. Nothing of it exists at run time: one that is never applied is only parsed, and `export func Vec(comptime T: type) -> type => ...` is accepted and gives the host nothing.

**`Vec(u32)` is an alias with parameters.** It *is* the type `(ptr: [*]mut u32, len: u32, cap: u32)`, not a new, distinct type; this is the rule every type name already follows. A value built as a plain struct with those fields is a `Vec(u32)`; two generic types with the same body are interchangeable and functions instantiated for them share one copy; `Vec(u8)` and `Vec(u32)` differ because their bodies differ, and the error says so with the names:

```ents
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)

func f(a: *Vec(u8)) -> u32 {
  let b: *Vec(u32) = a
  return b.len
}
```

```errors
cannot assign *Vec(u8) to *Vec(u32)
```

**Inference sees through a generic type** by matching its body: given a `*Vec(u32)`, the parameter `v: *Vec(T)` is laid over `*(ptr: [*]mut u32, len: u32, cap: u32)` and `T = u32` falls out, however the argument's type was written (function `b` above). A type parameter that the body never uses cannot be inferred and must be written at the call:

```ents
func Tagged(comptime T: type) -> type => (id: u32)
func tag(comptime T: type, t: Tagged(T)) -> u32 => t.id + sizeof(T)

func f(t: Tagged(u8)) -> u32 => tag(t)
```

```errors
cannot infer T for 'tag': 'Tagged(T)' does not use T in its fields; write the type argument
```

**Building a value.** A type that is called constructs a value of it. `Vec(T)(p, 0, cap)` constructs like `Point(1, 2)`, by position or by name; a struct literal where the type is known works as for any struct. `T(a, b)` also constructs when `T` is a type parameter that turns out to be a struct or tuple; a generic body that converts numbers writes `x as T`.

```ents
func make(comptime T: type, x: i32) -> T => T(x)

export func f() -> u32 => make(u32, 1)
```

```errors
u32 is not a struct or tuple type: it has no constructor; to convert a number write x as T, in make(T = u32)
```

**Size and layout.** `sizeof(T)` and `sizeof(Vec(T))` are constants in each instance. A struct's size is the sum of its fields' sizes: fields are packed in declaration order with no padding ([9.6](#96-structs-and-slices-in-memory)). `sizeof((bool, u32, []u32))` is 13.

**Where a container's header lives.** A `Vec(u32)` in a local is three wasm locals and has no address. A function that changes a container takes a pointer to it, so the header lives in memory and the program holds a pointer: `vec(u32, 16)` returns `*mut Vec(u32)`.

```ents
data space = mut [0:u8; 1024]
global top: u32 = 0

func alloc(n: u32) -> (p: u32) {
  p = (space as u32) + top
  top += n
}

func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)

func vec(comptime T: type, cap: u32) -> *mut Vec(T) {
  let v = alloc(sizeof(Vec(T))) as *mut Vec(T)
  v.* = Vec(T)(alloc(cap * sizeof(T)) as [*]mut T, 0, cap)
  return v
}

func push(comptime T: type, v: *mut Vec(T), x: T) {
  assert v.len < v.cap
  v.ptr[v.len] = x
  v.len += 1
}

func get(comptime T: type, v: *Vec(T), i: u32) -> T => v.ptr[i]

test "one vector for each element type" {
  let v = vec(u64, 4)
  push(v, 1 << 40)
  push(u64, v, 7)
  assert v.len == 2
  assert get(v, 0) == 1 << 40
  let names = vec([]u8, 2)
  push(names, "tau")
  assert get(names, 0).len == 3
}
```

**A fixed array for T.** With `T = [3]i32`, `[*]mut T` is `[*]mut [3]i32`, a table ([Nesting](#nesting)): each element is a pointer to its row, so code that uses an element as a `T`, as `get` above does, is refused in that instance, with a note that names the rule. For rows packed in place, make the element a struct with an array field, `Vec((cells: [3]i32))`: it lies in place, 12 bytes at a stride of 12, and `v.ptr[i].cells[2]` is one load (an array field is a value: its index is a constant, 2.4); for pointers to rows that lie elsewhere, say so, `Vec(*[3]i32)`.

A generic type may refer to itself through a pointer or a slice, directly or through another generic type, as any type may (2.8): `List(u32)` inside the body of `List(u32)` is the type being made.

```ents
func List(comptime T: type) -> type => (head: T, next: ?*List(T))

export func second(l: *List(u32)) -> u32 => if let n = l.next { n.head } else { 0 }
```

It cannot apply itself to a type made of its parameters: a type function has no conditions, so each level would be a new type and applying it would never end.

```ents
func List(comptime T: type) -> type => (head: T, next: ?*List(*T))
```

```errors
generic type 'List' refers to itself with a type argument that grows, List(*T): applying it would never end
```

Generic types that hold one another in a chain are not that, however long the chain. The compiler stops at 1000 levels, with `generic types are nested more than 1000 deep in 'G0(u8)'` at the application that was written.

**Errors in the body.** A generic type is checked as its applications, as a generic function is as its instances (8.3): an error its arguments make in its body is the application's, reported at its line in the body, once for each application, with the message naming it (`..., in Ring(0, u32)`, [8.7](#87-comptime-value-parameters)) and the use it was required from as a note. That application is then no type, and what is made of it says nothing more; a module that applied another module's generic type is told at its use, `Ring(0, u32) cannot be applied: ...`. A name the body uses that nothing declares is a mistake of the declaration, said once, where it is, when the type is first applied. Where one application inside another has an error, goes too deep or makes the type too large, the whole type is cut short there, with that one error.

### 8.6 Comptime Function Parameters

A **function parameter**, `comptime before: (T, T) -> bool`, is given the name of a function. Inside the generic, `before(a, b)` is a direct call of that function. This is how a sort takes its comparator without a function pointer:

```ents
func sort(comptime T: type, xs: []mut T, comptime before: (T, T) -> bool) {
  let p = xs.ptr
  for i in xs.len {
    let x = p[i]
    let j = i
    while j > 0 && before(x, p[j - 1]) {
      p[j] = p[j - 1]
      j -= 1
    }
    p[j] = x
  }
}

func ascending(a: i32, b: i32) -> bool => a < b
func descending(a: i32, b: i32) -> bool => a > b

export func up(xs: []mut i32) { sort(xs, ascending) }
export func down(xs: []mut i32) { sort(xs, descending) }
```

`up` and `down` call two different copies of `sort`; one contains `call $ascending`, the other `call $descending`. The module is the one with the two sorts written out:

```ents same-wasm
func sort_ascending(xs: []mut i32) {
  let p = xs.ptr
  for i in xs.len {
    let x = p[i]
    let j = i
    while j > 0 && ascending(x, p[j - 1]) {
      p[j] = p[j - 1]
      j -= 1
    }
    p[j] = x
  }
}

func sort_descending(xs: []mut i32) {
  let p = xs.ptr
  for i in xs.len {
    let x = p[i]
    let j = i
    while j > 0 && descending(x, p[j - 1]) {
      p[j] = p[j - 1]
      j -= 1
    }
    p[j] = x
  }
}

func ascending(a: i32, b: i32) -> bool => a < b
func descending(a: i32, b: i32) -> bool => a > b

export func up(xs: []mut i32) { sort_ascending(xs) }
export func down(xs: []mut i32) { sort_descending(xs) }
```

Comptime function parameters are always written, also in the inferred form: `sort(xs, ascending)` is the inferred form of `sort(i32, xs, ascending)`, and with a receiver `xs.sort(ascending)` is too ([4.9](#49-method-call-syntax)). The argument is the name of a function of the module (declared at module level or imported; not a generic, not an expression, not a function a `test` declares, not a name that several functions share), or a comptime function parameter of the enclosing generic passed on. Two instances are the same when the functions are the same function.

The parameter's type is a function type, written out or named: with `type Cmp = (i32, i32) -> bool`, `comptime before: Cmp` is the same parameter, and so is one typed by an applied generic type whose body is a function type.

The function's signature can decide a type parameter like any other argument, and it has to be exactly the type the parameter declares, with the names of its parameters and results left aside: names are no part of a function's type. Exact, for now: a function that a value of the declared type could be converted to is not taken, so one that takes a `u64` where the parameter says `u32`, or returns a `u8` where it says `u32`, is an error (accepting what is assignable may come later). The one relaxation: a function that lists a struct's fields as its results, `-> (sum: f64, n: u32)`, is one that returns the struct:

```ents
func twice(comptime T: type, comptime f: (T) -> T, x: T) -> T => f(f(x))
func inc(x: u32) -> u32 => x + 1

export func a() -> u32 => twice(inc, 5)          // T = u32, from inc; the 5 is a u32

test "the function decides T" {
  assert a() == 7
  assert twice(u32, inc, 0) == 2
}
```

```ents
func sort(comptime T: type, xs: []mut T, comptime before: (T, T) -> bool) { }
func inc(x: u32) -> u32 => x + 1

func f(xs: []mut i32) { sort(xs, inc) }
```

```errors
'inc' is (u32) -> u32, but 'sort' needs before: (i32, i32) -> bool
```

```ents
func twice(comptime T: type, comptime f: (T) -> T, x: T) -> T => f(f(x))
func widen(x: u64) -> u32 => x as u32
func narrow(x: u32) -> u8 => x as u8

func a(x: u32) -> u32 => twice(u32, widen, x)
func b(x: u32) -> u32 => twice(u32, narrow, x)
```

```errors
'widen' is (u64) -> u32, but 'twice' needs f: (u32) -> u32
'narrow' is (u32) -> u8, but 'twice' needs f: (u32) -> u32
```

In the instance a call of the parameter is a call of the function given, and its results are that function's. A name the declared type gives a result is not there when the function's results have other names, or none, so a body that reaches a result by its name is an error in the instance:

```ents
func second(comptime f: (u32) -> (x: u32, y: u32), n: u32) {
  let y = f(n).y
}
func pair(n: u32) -> (u32, u32) => (n, n + 1)

func a(n: u32) { second(pair, n) }
```

```errors
no field 'y' on type (u32, u32), in second(f = pair)
```

Inside the generic the parameter is not a value. It can be called, and passed on for a comptime function parameter of another generic; it cannot be stored or passed as an ordinary argument.

### 8.7 Comptime Value Parameters

A **value parameter**, `comptime n: u32`, is given a number at compile time. Inside the function `n` is that number. It can stand where a number can, and it can size a type: `[n]T` is an array of `n` elements, `*[n]T` a pointer to one, `u32#n` a number below `n`. Each number the function is called with makes an instance of its own, so a length that is a value parameter is part of the instance's types, and whatever the compiler proves from a length written as a number it proves from `n`.

```ents
func sum(comptime n: u32, xs: *[n]u32) -> (total: u32) {
  for i in n {
    total += xs[i]
  }
}

data primes = [2:u32, 3, 5, 7]
data squares = [1:u32, 4, 9, 16, 25, 36, 49, 64]

export func a() -> u32 => sum(primes)          // n = 4, from *[4]u32
export func b() -> u32 => sum(8, squares)      // n written
export func c() -> u32 => sum(2 + 2, primes)   // the instance of a

test "each length is its own function" {
  assert a() == 17
  assert b() == 204
  assert c() == 17
}
```

compiles to exactly the module this does:

```ents same-wasm
func sum_4(xs: *[4]u32) -> (total: u32) {
  for i in 4 {
    total += xs[i]
  }
}
func sum_8(xs: *[8]u32) -> (total: u32) {
  for i in 8 {
    total += xs[i]
  }
}

data primes = [2:u32, 3, 5, 7]
data squares = [1:u32, 4, 9, 16, 25, 36, 49, 64]

export func a() -> u32 => sum_4(primes)
export func b() -> u32 => sum_8(squares)
export func c() -> u32 => sum_4(primes)

test "each length is its own function" {
  assert a() == 17
  assert b() == 204
  assert c() == 17
}
```

In `sum<4>` the loop counter is a `u32#4` and `xs` is a `*[4]u32`, so `xs[i]` is read without a check, as it is in `sum_4`.

Rules:

1. A value parameter is written `comptime n: u32` in the parameter list of a module-level `func`, as every comptime parameter is ([8.1](#81-compile-time-parameters)). Its type is an integer type, `i8` to `i512` or `u8` to `u512`, written out or named, and may carry a range: `comptime n: u32#65` takes the numbers below 65. The type says which numbers the parameter takes, and nothing more: in the body `n` is the number ([below](#inside-the-function)).
2. Its name starts with a lower-case letter, as every value's does. A type parameter's starts with an upper-case one.
3. A function with a value parameter is a generic function: it can only be called, it is checked for each instance, and nothing of it is emitted until it is called.
4. Comptime parameters may stand anywhere in the list, and a parameter's type may use any of them. By convention they come first, in the order a type writes them: `n` before `T`, as in `[n]T`.
5. A value parameter's name is not the name of another parameter or a result of the function, nor of a `def` of the module, and the body does not bind it again (`let n`, `for n in`, a match arm `n =>`), as for any parameter.

#### Inside the function

In an instance, `n` is the number the call gave, written in place of the name, exactly as `def n = 8` would put it there.

- **In an expression** it is that number, and has no type of its own, as a literal has none: it takes the type its place gives it. `x < n`, `let y: u8 = n`, `return n` and `f(n)` are what they are with `8` written there, and `-n` is the number `-8`, as it is where `def n = 8` puts 8. `let k = n` gives `k` the type `let k = 8` gives (`i32`, or `i64` for a number that an `i32` does not hold): write `let k: u32 = n` for a variable that has one type in every instance.
- **It is not a variable.** `n = 3`, `n += 1` and `set (n, x) = ...` are errors, and so is a binding that reuses its name; each is reported in every instance, as any mistake in a body is ([8.3](#83-requirements)).
- **In a type** it is a length or a bound: `[n]T`, `*[n]T`, `*mut [n]T`, `[n][m]T`, `*[n][m]T` (a table, [Nesting](#nesting)), `u32#n`, and an argument of a generic type, `Ring(n, T)`. Any constant expression may stand there: `[n * 2]T`, `[(n + 31) / 32]u32`, `[n * sizeof(T)]u8`, `u32#(n + 1)`. A length is written between the brackets; a bound follows `#` directly when it is a name or a number, and in parentheses otherwise.
- **Every rule about a number holds for it**, because in the instance it is one: `for i in n` counts with `i: u32#n` ([Ranged Integers](#ranged-integers)); for an unsigned `x`, `x % n` is a `u32#n` and `x & (n - 1)` is a `u32#n`; `v[n - 1]` is a constant index; `[0:u8; n]` is `n` zeros; `sizeof([n]T)` is `n * sizeof(T)`; `.len` of a `*[n]T` is `n`. So does every rule about the number `0`, where a body is instantiated with it ([Bounds](#bounds)).
- **A hyphen joins a name** ([1.2](#12-identifiers)): `n-1` is one name, not `n` minus 1. Write `v[n - 1]`, `[n - 1]T`, `u32#(n - 1)`.

```ents
func last(comptime n: u32, comptime T: type, v: [n]T) -> T => v[n - 1]
func rotl(comptime k: u32, x: u32) -> u32 => (x << k) | (x >> (32 - k))

export func a(x: f64) -> f64 {
  let v: [3]f64 = [x, 2.0, x * 3.0]
  return last(v)                                // n = 3, T = f64, from [3]f64
}
export func mix(a: u32, b: u32) -> u32 => rotl(7, a) ^ rotl(13, b)
```

`last<3|f64>` takes the three values of `v` in three registers and returns the third; `rotl<7>` shifts by `7` and by `32 - 7` (the language's `x <<< k` is one instruction; `rotl` spells it out to show `n` in arithmetic). A value array is held in registers, so it is indexed by constants only, in a generic as anywhere ([2.4](#24-fixed-arrays-value-type)): `v[n - 1]` is one, and `v[i]` in `for i in n` is not.

#### Calling a function with value parameters

The two forms of [8.2](#82-calling-a-generic-function) hold, with value parameters counted with the type parameters: if a function has `P` parameters of which `K` are type or value parameters, a call with `P` arguments is explicit and a call with `P - K` arguments is inferred. A comptime function parameter is written in both forms.

**Explicit.** The argument of a value parameter is a **compile-time constant**, the same kind of expression that may stand in a length: a number (`8`, `0x40`, `8:u32`, `'a'`), a `def`, a value parameter of the enclosing generic, `sizeof` of a type (also of a type parameter), the `.len` and `.wid` of a `*[N]T`, and arithmetic, bitwise operators and shifts on these. A variable, a global, a call or the address of `data` is not one. It is checked against the parameter's type as any argument is, by its exact value (`sum(0 - 1, p)` is `argument 1: cannot assign int(-1) to u32`), and the instance gets the value it has in that type: `~0` for a `comptime m: u8` is 255.

**Inferred.** A value parameter is found from the other arguments as a type parameter is: going through the parameters left to right, the first one whose written type has `n` as a length, and whose argument has a length in that place, decides it.

| Parameter | Argument | Result |
|---|---|---|
| `*[n]T`, `*mut [n]T` | `*[8]u32`, `*mut [8]u32` (a `data` array; a string `"abc"` is a `*[3]u8`) | `n = 8` |
| `[n]T` | a `[3]f64` held in registers | `n = 3` |
| `*[n][m]T` | `*[2][3]i32` | `n = 2`, `m = 3` |
| `*Ring(n, T)` | a pointer to a struct of `Ring`'s shape | `n` from the field `items: *mut [n]T` |
| `(*[n]u8, u32)` | a tuple `(buf, 1)` | `n` from its typed part |
| `comptime f: (*[n]u8) -> u32` | a function `g(p: *[8]u8) -> u32` | `n = 8`: a function argument decides as any argument does ([8.6](#86-comptime-function-parameters)) |
| `*[n]T` | a slice `[]u32`, a `[*]u32`, a `*[!]u32`, a packed `*[2x3]u32` | nothing: there is no length in the type, or not one of that shape |
| `*[n]T` | a `[4]u32` held in registers | nothing: it has no address ([2.4](#24-fixed-arrays-value-type)), so it matches no pointer, as for `T`; written out, `sum(4, v)` is `argument 2: cannot assign [4]u32 to *[4]u32` |
| `*[n * 2]u8` | `*[8]u8` | nothing: only a length that is the name alone decides |
| `u32#n` | a `u32#8` | nothing: a range is dropped, as it is for `T` |
| `*[n]u32` | an array literal `[1, 2, 3]` | nothing: literals never decide (8.2, rule 3) |

Every other argument is then an ordinary argument of the instance, with the same conversions and the same errors: `join("hel", "lo", big)` below, with a `big` of 8 bytes, is `argument 3: cannot assign *mut [8]u8 to *mut [5]u8`. Nothing is guessed: a value parameter that no argument decides has to be written, and so do the other type and value parameters of that call, since there is no form that writes some of them.

```ents
func sum(comptime n: u32, xs: *[n]u32) -> u32 => 0

func f(xs: []u32) -> u32 => sum(xs)
func g(x: u32, p: *[4]u32) -> u32 => sum(x, p)
```

```errors
cannot infer n for 'sum': a []u32 has no length in its type; write the value argument, as in sum(8, ...)
argument 1 of 'sum' must be a compile-time constant: n is a comptime value parameter
```

#### Arithmetic in types, and when two types are the same

A length or a bound may be any compile-time constant (as for an explicit argument, above). It is computed in each instance, as any constant is ([Comptime Literal Promotion](#comptime-literal-promotion)); a length is used as no type, so it is computed exactly, with nothing to wrap in, even where a part of it is typed (`sizeof(T)` is a `u32`), and the type then has that number in it. Two types are the same when they are the same with their lengths computed, as types always are: in an instance where `n` is 4, `[n * 2]u8`, `[2 * n]u8`, `[n + n]u8` and `[8]u8` are one type. Nothing about lengths is ever compared before they are numbers: a generic is checked only as its instances, so there is no rule of algebra for lengths, and none is needed.

```ents
func join(comptime a: u32, comptime b: u32, x: *[a]u8, y: *[b]u8, out: *mut [a + b]u8) {
  for i in a {
    out[i] = x[i]
  }
  for j in b {
    out[a + j] = y[j]
  }
}

data buf = mut [0:u8; 5]

export func hello() -> u8 {
  join("hel", "lo", buf)      // a = 3, b = 2; out is a *mut [5]u8, which buf is
  return buf[4]
}

test "joined" {
  assert hello() == 111
}
```

A length is a number from 0 to 4294967295, the most a `u32` `.len` holds, and an array, wherever it is (in registers, in memory, or behind a pointer), has at most 4294967295 bytes: `sizeof([n]T)` is a `u32`, and so is the byte offset of every element a proven index reaches. A bound is at least 1 (`u32#0` would have no values) and at most the number of values its type has (`u8#256` is every `u8`). These hold for types written by hand too.

#### Bounds

What a length proves, it proves in every instance. A ranged index below the length is read and written without a check; an index that is not proven is resolved with `if let` or `??`, or is an error, as in hand-written code ([4.7](#47-bounds-checked-indexing)).

```ents
func get(comptime n: u32, comptime T: type, xs: *[n]T, i: u32#n) -> T => xs[i]

data widths = [3:u16, 1, 4, 1, 5, 9, 2, 6]

export func a(k: u32) -> u16 => get(widths, k & 7)
export func b(k: u32) -> u16 => get(widths, k % 8)
```

`get<8|u16>` is one load. The proof is the caller's: `get(widths, k)` with a plain `k: u32` is `argument 2: cannot assign u32 to u32#8`, and `get(widths, k & 15)` is `argument 2: cannot assign u32#16 to u32#8`.

**`n = 0`** is a number like any other, so an instance for it is refused exactly where the same function written by hand for 0 is. `u32#0` is no type, so `get` cannot be made for an empty array. A loop `for i in 0` counts with a plain `u32`, since its counter has no values to range over, and nothing it indexes is proven; nor does `i >= 0` narrow anything:

```ents
func sum(comptime n: u32, xs: *[n]u32) -> (total: u32) {
  for i in n {
    total += xs[i]
  }
}

data none: *[0]u32 = []

export func z() -> u32 => sum(none)
```

```errors
runtime index on *[0]u32 requires 'if let' or '??' (no optional type for u32), in sum(n = 0)
```

A generic that is meant to work for 0 says so in its body, as hand-written code would (`for x in xs` over the `*[n]u32` itself needs no index).

#### Generic types with value parameters

A generic type ([8.5](#85-generic-types)) takes value parameters as a generic function does, and is applied to numbers as to types: `Ring(8, u32)`.

```ents
func Ring(comptime n: u32, comptime T: type) -> type => (head: u32#n, count: u32, items: *mut [n]T)

// Adds x after the newest element; when the ring is full, x takes the oldest one's place.
func push(comptime n: u32, comptime T: type, r: *mut Ring(n, T), x: T) {
  r.items[(r.head + r.count) % n] = x
  if r.count < n {
    r.count += 1
  } else {
    r.head = (r.head + 1) % n
  }
}

// The i-th oldest element.
func oldest(comptime n: u32, comptime T: type, r: *Ring(n, T), i: u32#n) -> T => r.items[(r.head + i) % n]

data cells = mut [0:u32; 8]
data log: Ring(8, u32) = mut (0, 0, cells)

export func record(x: u32) { log.push(x) }
export func first() -> u32 => log.oldest(0)

test "the ring keeps the last eight" {
  for i in 10 {
    record(i)
  }
  assert log.count == 8
  assert first() == 2
}
```

`Ring(8, u32)` is the struct `(head: u32#8, count: u32, items: *mut [8]u32)`, as any generic type is its body. Its value arguments are computed before it is applied, so `Ring(8, u32)`, `Ring(4 + 4, u32)` and the struct written out are one type; `Ring(16, u32)` is another because its body is (`cannot assign *mut Ring(16, u32) to *mut Ring(8, u32)`). As for type parameters, a value the body does not use makes no difference: with `func Tagged(comptime n: u32) -> type => (id: u32)`, `Tagged(4)` and `Tagged(5)` are one type. `log.push(x)` finds `n` and `T` from `log` by the body of `Ring`, through `items: *mut [n]T`; `head: u32#n` decides nothing. It builds a value like any generic type, `Ring(8, u32)(0, 0, cells)`, and a method call writes its comptime arguments after the receiver, `log.push(8, u32, x)`, which is `push(8, u32, log, x)`.

Its value arguments are compile-time constants, as an explicit argument of a generic function is ([above](#calling-a-function-with-value-parameters)), checked against the parameter's type the same way: a `def` declared further down is a number there too, `Small(300)` is `argument 1 of 'Small': cannot assign int(300) to u8` for a `comptime n: u8`, and so are the typed `Small(4:u32)` and `Small(sizeof(u64))`, as `cannot assign u32 to u8`. An error that a number makes in the body is the application's (8.5): with `Ring(0, u32)`, `head: u32#0` is `range bound must be at least 1: u32#0 has no values, in Ring(0, u32)`, with the use as a note. A body that applies its type to numbers that grow is stopped at once, by the parameter's type (`T(n * 2)`: `argument 1 of 'T': cannot assign int(4294967296) to u32, in T(2147483648)`) or at 1000 levels (`T(n + 1)`).

A generic type may also hold its array in place:

```ents
func Buf(comptime n: u32, comptime T: type) -> type => (len: u32#(n + 1), items: [n]T)

func third(b: Buf(3, u8)) -> u8 => b.items[2]
data held: Buf(3, u8) = (3, [1, 2, 3])

export func size() -> u32 => sizeof(Buf(3, u8))            // 4 + 3
export func t() -> u8 => third(Buf(3, u8)(0, [7, 8, 9]))
export func h() -> u8 => held.items[1]

test "an array held in place" {
  assert size() == 7
  assert t() == 9
  assert h() == 2
}
```

`Buf(3, u8)` is four values in registers and seven bytes in memory, its elements inside it. An array held in place, in registers or as a field in memory, is indexed by constants only ([2.4](#24-fixed-arrays-value-type)): `b.items[2]` is one read, and `b.items[i]` is an error. A container that is indexed at run time holds a pointer to its elements, as `Ring` does. The length is a `u32#(n + 1)` because it reaches `n` when the buffer is full; `u32#n` would say it stays below.

#### Instances

- **Identity.** Value arguments are equal when they are the same number in the parameter's type: `sum(primes)`, `sum(4, primes)` and `sum(2 + 2, primes)` share `sum<4>`.
- **Names.** In WAT a value argument is written in decimal among the others, in the order of the comptime parameters: `$sum<4>`, `$push<8|u32>`, `$shift<-3>`. Instances take the generic's place in the order of their names as text, so `$rotl<13>` comes before `$rotl<7>`. In messages an instance reads `push(n = 8, T = u32)`.
- **Zero cost.** An instance is the generic with each value parameter replaced by its number, and it compiles to the bytes of that function written by hand. Nothing of `n` exists at run time beyond the constants the hand-written function would have, and none is folded that the hand-written one would not fold: `32 - k` in `rotl<7>` is `(i32.sub (i32.const 32) (i32.const 7))` as `32 - 7` is.
- **Statics.** A literal in the body belongs to each instance, as for type parameters: `func scratch(comptime n: u32) -> *mut [n]u8 => mut [0:u8; n]` is one buffer of `n` bytes for each `n`, laid out once. Every call with the same `n` gets the same buffer.
- **One copy per number.** Each value is a function of its own, as each type is: `sum` over arrays of five lengths is five functions. A long body that needs the length only for a few proofs can take a slice in a plain function and keep the generic a short wrapper.
- **Recursion.** A generic may call itself with the same arguments; that is run-time recursion in one instance. It cannot recurse on a value that changes. There is no compile-time `if`, so both branches of an `if` are in every instance, and each instance asks for the next:

```ents
func pow(comptime e: u32, x: u64) -> u64 => if e == 0 { 1 } else { x * pow(e - 1, x) }

export func cube(x: u64) -> u64 => pow(3, x)
```

```errors
argument 1: cannot assign int(-1) to u32, in pow(e = 0)
```

`pow<3>` asks for `pow<2>`, and so on to `pow<0>`, whose `else` asks for `pow(0 - 1, x)`. A value that grows instead is stopped by its type or by the limits of [8.4](#84-instances) (64 nested instantiations, 1000 from one call). A loop does what such a recursion would: `for i in e { r *= x }`.

#### With the rest of the language

- **Functions that share a name.** A generic with value parameters is still a generic: its name is unique in its module. In an instance `n` is a literal, so a call `gt(x, n)` in the body picks among overloads as `gt(x, 8)` does: the typed `x` decides and the literal only has to fit ([3.4](#functions-that-share-a-name)).
- **Tables.** A pointer or slice whose element is a fixed array is a table ([Nesting](#nesting)) whatever its lengths are: a `t: *[n][m]T` is `n` row pointers, `t.len` is `n` and `t[i].len` is `m`. Lengths are matched by shape, never by layout: `*[n][m]T` against a `*[2][3]i32` gives `n = 2`, `m = 3`. The same holds for a type parameter that turns out to be a fixed array ([8.5](#85-generic-types)): `*[n]T` against a `*[2][3]i32` gives `n = 2` and `T = [3]i32`, and the instance has a table, whose `xs[i]` is a row pointer, not a `T`.
- **Modules.** A source import restates a value parameter as it is declared: `"push" func push(comptime n: u32, comptime T: type, r: *mut Ring(n, T), x: T)`. An instance belongs to the generic's module ([8.8](#88-generics-across-modules)), and a value argument is computed in the module that wrote it, with that module's `def`s.
- **`def`.** A `def` is a number with a name, so it can now size a type outside generics too: with `def size = 64`, `*mut [size]u8` and `u32#size` are types.
- **In the editor.** A value parameter shows its number in each instance: `n: u32 — in sum(n = 4): 4; in sum(n = 8): 8`.

A table with value-parameter lengths is read as a table written by hand: here `m[i]` loads the row pointer and `m[i][i]` the cell, both proven by `i: u32#n`.

```ents
func trace(comptime n: u32, m: *[n][n]i32) -> (t: i32) {
  for i in n {
    t += m[i][i]
  }
}

data grid: *[3][3]i32 = [[1, 2, 3], [4, 5, 6], [7, 8, 9]]

export func a() -> i32 => trace(grid)            // n = 3; the second [n] is then checked: a *[3][4]i32 is refused

test "trace" {
  assert a() == 15
}
```

### 8.8 Generics Across Modules

`export func max(comptime T: type, ...)` and `export func Vec(comptime T: type) -> type` make a generic importable by other source modules. A source import names what it uses with its signature, as for any function ([7.1](#71-imports)), and a generic type as the function it is:

```ents
import "./containers" (
  "Vec" func Vec(comptime T: type) -> type
  "vec" func vec(comptime T: type, cap: u32) -> *mut Vec(T)
  "push" func push(comptime T: type, v: *mut Vec(T), x: T)
)

export func total(n: u32) -> u32 {
  let v = vec(u32, 16)
  for i in n {
    v.push(i)
  }
  return v.len
}
```

An instance belongs to the module that declares the generic: its body's names are that module's names, its errors are reported against that module's source, and its code is emitted with that module's functions. A second module that also pushes to a `Vec(u32)` uses the same instance: the program has one `push<u32>`. A generic type applied in another module is the type its body gives, as in its own.

**Where a call in a generic body is looked up.** In the generic's own module first. Where no function there of the callee's name takes the arguments, in the *site*: the module whose ordinary (non-generic) code started the chain of instantiations. So a library provides `hash` and `eq` for the common key types, and a program that uses `Set(Cell)` with its own `Cell` writes `hash(c: Cell)` and `eq(a: Cell, b: Cell)` in the module that makes the set:

```ents
import "./containers" (
  "Set" func Set(comptime K: type) -> type
  "hashset" func hashset(comptime K: type, bits: u32) -> *mut Set(K)
  "add" func add(comptime K: type, s: *mut Set(K), k: K) -> bool
)

type Cell = (x: i32, y: i32)

func hash(c: Cell) -> u32 => ((c.x * 73856093) ^ (c.y * 19349663)) as u32
func eq(a: Cell, b: Cell) -> bool => a.x == b.x && a.y == b.y

export func visited(n: u32) -> u32 {
  let seen = hashset(Cell, 2)
  for i in n {
    seen.add(Cell((i % 5) as i32, (i % 3) as i32))
  }
  return seen.count
}
```

`add<Cell>` and the `slot<Cell>` it calls are functions of `./containers` that call this module's `hash` and `eq` directly. A library's own functions come first and cannot be replaced from outside. Only the site's plain functions are looked up: a generic of the site's of the name is not, and an error for want of the function says so in a note. Only the callee of a call is looked up at the site: the types, globals and helpers of a generic's body are always its own module's, and a comptime function argument is written where the generic is called.

An instance whose body needed the site belongs to that site, and so does an instance that calls one. Another module that uses the same generic with the same arguments shares it where its own functions of the names looked up are the same functions (both import `hash` and `eq` for `Cell` from one module), and otherwise gets its own copy, calling its own functions: two functions in the output, the second named with its site after the arguments in WAT, `add<<x:i32|y:i32>>@other`. Instances that did not need the site exist once in the program.

A function of another module given for a comptime function parameter is called by that module's name for it: `sort(xs, by_cost)` with `by_cost` declared in, or imported from, another module is an instance that calls that function directly, and two modules that give the same function share it.

**Errors.** An error in an instance is the generic's module's, at its line in the generic, labelled with the instance, and with the calls it was required from, each in the module of that call. Where the chain of instantiations was started by ordinary code of another module, that module is told too, once, at its call, of the first error of the instance it asked for or of an instance that one's body asked for, however deep; nothing is said at the calls between:

```text
containers.ents:77:11: no function 'hash' accepts (Cell), in add(K = Cell)
  required from main.ents:18:15
main.ents:18:15: add(K = Cell) cannot be instantiated: no function 'hash' accepts (Cell) (containers.ents:77:11)
```

Such an error is found when the program is checked, also in a library that was checked on its own and found sound before, and it stops the build like any other.

The containers of [`lib/`](../lib/README.md) are written this way: `lib/vec.ents`, `lib/set.ents`, `lib/map.ents` and `lib/sort.ents`, on the bump stack of `lib/stack.ents`. [`examples/containers/main.ents`](../examples/containers/main.ents) uses them for a type of its own.

### 8.9 Not in This Version

Each of these is rejected with an error that says so, so the syntax stays free for a later version.

| Not supported | What the compiler says |
|---|---|
| A comptime parameter that is neither a type, an integer nor a function: a `bool`, a float, a slice, a type parameter (`comptime n: T`) | `comptime parameter 'ok' is bool: a comptime parameter is a type (comptime T: type), an integer (comptime n: u32) or a function (comptime f: (T) -> T)` |
| A value parameter whose argument is a string or a `data` block | `argument 1 of 'f' must be a compile-time constant: s is a comptime value parameter` |
| Recursion on a value parameter that changes, `pow(e - 1, x)` in `pow(comptime e: u32, ...)` | the chain ends in a value its type refuses (`argument 1: cannot assign int(-1) to u32, in pow(e = 0)`), or at 64 nested instantiations |
| A packed array whose dimensions are not numbers, `*[n x m]T` | a syntax error at the `x` |
| An array field in memory indexed at run time | `dynamic index on value type [8]u32 — use a pointer or slice for dynamic access` |
| A default value, `comptime n: u32 = 16` | a syntax error |
| A length that is not a constant, `[len]u8` with a variable | `array length must be a compile-time constant` |
| A generic function declared inside a `test` block | `a generic function is declared at module level, not inside a test` |
| A generic function that shares its name with another function, global, `def`, `data` or import | `'max' is already declared: a generic function's name is unique in its module` |
| A generic host import | `a host import cannot have comptime parameters` |
| A generic function used as a value | `generic function 'max' must be called` |
| A generic type with a parameter that is neither `comptime X: type` nor an integer, or with none | `generic type 'Vec' takes comptime type and integer parameters only, as (comptime n: u32, comptime T: type)` |
| A generic type that refers to itself with a type made of its parameters, `List(*T)` in `List(T)` | `generic type 'List' refers to itself with a type argument that grows, List(*T): applying it would never end` |
| A generic type declared inside a `test` block | `a generic type is declared at module level, not inside a test` |
| A generic type that shares its name with a `type` or another generic type | `'Vec' is already declared: a generic type's name is unique in its module` |
| A generic type without its arguments, or with the wrong number | `'Vec' is a generic type: write Vec(T)`; `Vec expects 1 type argument, got 2` |
| A type that is not generic, applied | `'Point' is not a generic type` |
| A type parameter that is applied, `T(u32)` as a type | `a type parameter cannot be applied` |
| A constructor on a type that is not a struct or tuple | `u32 is not a struct or tuple type: it has no constructor; to convert a number write x as T` |
| A comptime function argument that is not the name of a function | `argument 3 of 'sort' must be the name of a function: before is a comptime function parameter` |
| A comptime function argument that is a name several functions share | the same, followed by `('less' has several overloads)` |
| A comptime function parameter used as a value | `'before' is a comptime function parameter: it can only be called, or passed on for a comptime function parameter` |

Also not in this version: a generic type with a block body or conditions (a syntax error: its body is one type), writing some comptime arguments and inferring others, inference from the expected result type, generic functions that share a name, traits or declared requirements, compile-time `if`, `for` and `assert`, and `comptime func`. A value parameter is decided only by a length that is its name alone: not by `[n * 2]`, by a range, or by an array literal's count.

A limit older than generics is met through them. A function passed for an ordinary parameter of function type decides `T` like any other argument, but a function value cannot be called at run time yet, in a generic or anywhere else: the call is `calling a function value is not supported yet: only a function named directly, or a comptime function parameter (comptime f: (u32) -> u32), can be called`. A generic that calls a function takes it as a comptime parameter.

<!-- spec:end -->

### 8.10 How This Is Compile-Time Evaluation

Encantis already has names bound at compile time: `def n = 64` binds a number, `type Pt = (...)` binds a type, and `sizeof(T)` is an expression the compiler evaluates. Generics add one thing: **a name bound at compile time can be a parameter**, and a compile-time value can be a type, a function or a number.

| Bound at compile time | Module level | Parameter | Later |
|---|---|---|---|
| a type | `type Pt = (q: i32, r: i32)` | `comptime T: type` | |
| a function | `func f(...)` | `comptime before: (T, T) -> bool` | |
| a number | `def n = 64` | `comptime n: u32`; `[n]T` | |
| a bool | `def debug = false` | | `comptime ok: bool`, with a compile-time `if` |
| a type computed from types | | `func Vec(comptime T: type) -> type => ...` | block bodies, conditions |
| a value computed from values | `def bytes = n * 8` | | `comptime func`, tables |

A call with comptime arguments is evaluated as far as its comptime parameters go: for a generic type completely (the result is a type and nothing is left for run time), for a generic function partially (the result is a specialised function, and what is left for run time is the call of it).

---

## 9. Memory Model

### 9.0 Data Layout

Program data (`data` declarations and literals that need memory) is placed from address 8 up. Address 0 means "none" for optional pointers and slices, so nothing real may live there; the first 8 bytes stay unused, which also keeps data 8-byte aligned. `sizeof data` is the address just past the last byte of data, where free memory begins.

### 9.1 Stack vs Memory Allocation

Encantis distinguishes between register storage (WASM locals/globals) and linear memory:

| Declaration | Storage | Notes |
|-------------|---------|-------|
| `let x:i32` | WASM local | Function-scoped register |
| `let p:Point` | Multiple WASM locals | Fields are separate registers |
| `let ptr:*[64]u8` | Single WASM local (i32) | Holds a pointer, doesn't allocate |
| `global g:i32` | WASM global | Module-scoped register |
| `global s:[]u8` | Two WASM globals (ptr, len) | One per value, like a local |
| `def buffer = [0:u8; 64]` | Linear memory | Allocates 64 bytes in data section |

Primitives and structs are stored in WASM locals/globals—fast registers with no memory address. Pointer variables are single i32 values that reference memory allocated via `def`.

```ents
let p:Point = Point(1.0, 2.0)   // two f32 WASM locals
def buffer = [0:u8; 64]         // allocates 64 bytes in data section
let ptr:*[64]u8 = buffer        // one i32 local holding pointer to buffer

// Locals: fields are separate registers
let a = p.x                      // reads from WASM local

// Memory: data is serialized bytes
let b = ptr[0]                   // reads from linear memory
```

Array and string literals in `def` declarations are serialized to the data section of the WASM module.

### 9.2 By-Value vs By-Reference Passing

Struct parameters are passed by value—each field becomes a separate WASM argument:

```ents
type Point = (x:f32, y:f32)

// This function receives two f32 WASM parameters
func length(p:Point) -> f32 {
  return sqrt(p.x * p.x + p.y * p.y)
}

let p = Point(3.0, 4.0)
length(p)                      // passes p.x, p.y as separate values
length(Point(1.0, 2.0))        // also valid
```

You cannot pass a pointer where a by-value struct is expected:

```ents
let ptr:*Point = ...
length(ptr)                // ERROR: expected Point, got *Point
length(ptr.*)              // OK: dereference to get by-value Point
```

For by-reference semantics, explicitly accept a pointer. The caller must ensure the data is serialized in linear memory:

```ents
func modify(p:*mut Point) {
  p.x = 0.0
  p.y = 0.0
}

let p = Point(3.0, 4.0)
modify(&p)                 // ERROR: p has no address (stack-allocated)

let mem_p:*mut Point = allocate_point()
modify(mem_p)              // OK: mem_p points to linear memory
```

#### Structural Coercion

Structural struct types match any value with coercible fields at each position, and with the same names. A tuple literal is matched by name where it has names, so `(y: 20, x: 10)` is a `BigPoint` with an `x` of 10, and by position where it has none ([2.8](#struct-constructors)):

```ents
type BigPoint = (x:i32, y:i32)

func scale(p:BigPoint, factor:i32) -> BigPoint {
  return BigPoint(p.x * factor, p.y * factor)
}

// OK: fields coerce i8 → i32 (by-value, compiler inserts conversions)
let small = (x: 10:i8, y: 20:i8)
scale(small, 2)
```

> **Status:** only fields that are held the same way coerce (`i8` → `i32`, both a wasm `i32`). A field that needs a conversion (`i32` → `i64`, integer → float) is a checker error for a value that already exists; a literal's elements are converted one by one ([2.10](#implicit-widening)).

This coercion only applies to by-value passing. For pointers, exact memory layout is required:

```ents
func process(p:*BigPoint) {
  // reads/writes memory directly, expects 8 bytes (2 x i32)
}

let small:(x:i8, y:i8) = (x: 10, y: 20)
process(&small)            // ERROR: layout mismatch (2 bytes vs 8 bytes)
```

### 9.3 WASM Type Mapping

| Encantis | WASM |
|----------|------|
| i8, i16, i32, u8, u16, u32, bool | i32 |
| i64, u64 | i64 |
| f32 | f32 |
| f64 | f64 |
| `*T` | i32 |
| `[]T` | i32, i32 (ptr, len) |
| `*[N]T`, `*[!]T` | i32 (ptr only) |
| `(x:T1, y:T2, ...)` | flattened fields (one WASM value per field) |
| a host type (`type Canvas = host`) | externref, null for `0` ([2.13](#213-host-references)) |

### 9.4 Slice Construction

Slices are multi-value pairs (pointer + length). When you have separate components, construct a slice by assigning a tuple to a slice-typed binding:

```ents
data buffer = mut [0:u8; 1024]
let ptr = buffer as [*]u8
let slice:[]u8 = (ptr, 512:u32)     // tuple coerces to slice
```

Fixed-size pointer types coerce to slices implicitly (the compiler knows the length):

```ents
data buffer = mut [0:u8; 1024]
let slice:[]u8 = buffer              // *[1024]u8 → []u8 implicit
```

### 9.5 Array Type Conversions

| From | To | How |
|------|----|-----|
| `[]T` | `[*]T` | `slice.ptr` |
| `[]T` | `u32` | `slice.len` |
| `[]T` | `([*]T, u32)` | `(slice.ptr, slice.len)` or destructure |
| `*[N]T` | `[]T` | implicit |
| `*[N]T` | `[*]T` | `arr.ptr` |
| `*[!]T` | `[*]T` | `s.ptr` |
| `*[!]T` | `[]T` | `(s.ptr, s.len)` (len computed by scan) |
| `([*]T, u32)` | `[]T` | implicit |
| `[*]T` | `[]T` | ERROR - needs length |

```ents
let arr:*[16]u8 = ...
let slice:[]u8 = arr           // OK: implicit

let ptr:*u8 = ...
let slice:[]u8 = ptr           // ERROR: need length
let slice:[]u8 = (ptr, 64)     // OK: provide length

// Extract components from slice
let (ptr, len) = slice           // by position
let (ptr:, len:) = slice         // by name
```

`*[N]T` to `[]T` is implicit wherever a `[]T` is expected: an argument, an initializer or an assignment, a returned value or an expression body, a branch of an `if` or `match`, and a field of a struct or tuple literal. Pointers to arrays of different lengths in one literal that has no type written are slices of their own lengths, written out or as the branches of an `if` or `match`: with `three: *[3]i32` and `four: *[4]i32`, `let both = [three, four]` is a `[2][]i32` (and so is `global both` or `data both` of it), as `["ab", "cde"]` is a `[2][]u8`, `[[three, three], [four, four]]` is a `[2][2][]i32` and `[(three, 1), (four, 2)]` is a `[2]([]i32, i32)`. Rows written out with no type have to be of one length: `let rows = [[1, 2], [3, 4, 5]]` is an error (`rows of different lengths: ...`), and `data rows: *[2][]i32 = [[1, 2], [3, 4, 5]]` lays them out as slices of their own lengths. A struct or tuple that is already a value is not converted as a whole, as no struct is (`cannot convert (s: *[3]u8, n: u32) to Holder implicitly: convert its fields`): build the struct from its fields, `Holder(t.s, t.n)`, and each field converts.

### 9.6 Structs and Slices in Memory

Any value type can be an element of an array or the target of a pointer. In memory a value is its parts one after another, in declaration order, with no padding and no alignment: the language is byte-oriented.

| Type | Bytes in memory |
|------|-----------------|
| `i8`, `u8`, `bool` | 1 |
| `i16`, `u16` | 2 |
| `i32`, `u32`, `f32` | 4 |
| `i64`, `u64`, `f64` | 8 |
| `i128` ... `u512` | 16 ... 64, as 64-bit limbs, least significant first |
| `*T`, `[*]T`, `*[N]T` | 4 |
| `[]T` | 8: the pointer, then the length |
| `[N]T` | N × `sizeof(T)` |
| `(a:T1, b:T2, ...)` | the sum of its fields; field `b` starts where `a` ends |

`sizeof(T)` is this size, and it is the stride of `[*]T`, `*[N]T` and `[]T`: element `i` is at `i * sizeof(T)` bytes from the start. A struct inside a struct, or a slice or fixed array inside one, lies in place at its field's offset. The one exception is a fixed array that is the element of a pointer or slice (`*[N][M]T`, `[][M]T`, `[*][M]T`): there each element is a 4-byte pointer to its row, which lies apart ([Nesting](#nesting)).

```ents
type Lane = (cells:[]i32, free:i32)       // 12 bytes: cells.ptr 0, cells.len 4, free 8
type Option = (d:i32, lane:Lane)          // 16 bytes: d 0, lane 4
type Mixed = (a:u8, b:i16, c:u64)         // 11 bytes: a 0, b 1, c 3
```

A value in memory is read and written whole or part by part. Each wasm value of it is one load or store at its offset, so there is nothing to pay for the struct: `list[k] = Spot(a, b, c)` is three stores, and `list[k].di` is one load.

```ents
type Spot = (c:i32, di:i32, room:i32)

func sum(s:Spot) -> i32 => s.c + s.di + s.room

func demo(list:[*]mut Spot, k:u32, p:*mut Spot, all:[]Spot) -> i32 {
  list[k] = Spot(20, 1, 2)       // store a whole struct
  let s = list[k]                // load one: s is a copy, in registers
  p.* = s                        // through a pointer to one struct
  p.di += 1                      // one field through the pointer (p.* is implied)
  list[k + 1] = list[k]          // copy from one place to another
  let t = sum(p.*) + sum(list[k])   // pass by value
  for spot in all {              // each element in turn
    t += spot.room
  }
  return t
}
```

The same goes for slices held in memory, at any depth: `lists[k] = make()`, `opts[i].lane.cells.len`, `for x in opts[i].lane.cells { ... }`.

#### Fixed Arrays in Place

A fixed array that is a field of a struct in memory lies there in place, its elements one after another at the field's offset. There it has an address, and wherever an index is not a constant it is reached through that address, as the `*[N]T` it is: `p.items[i]` with `p` a `*mut Pool` is `p.items` seen as a `*mut [64]Entity`, indexed. Nothing is loaded but the element, and the rules are a `*[N]T`'s ([4.7](#47-bounds-checked-indexing)): a constant or ranged index is proven and needs no check, any other is resolved with `if let` or `??`, and a write with one goes through the element's address, `&p.items[i]`, a `?*mut Entity`. The pointer is as mutable as the place: through a `*Pool` it is a `*[64]Entity`, and a write is refused as any write through a const pointer is. A loop, a range and `&` reach the array the same way: `for e in p.items`, `p.items[a..b]`, and `&p.items`, which is the `*mut [64]Entity` itself, to pass where a pointer or a slice is wanted. Any other value in memory has its address too: `&p.count` is a `*mut u32`. A constant index picks the element where it is, as before: `p.items[2].x` is one load at a constant offset.

An array of fixed arrays lies there packed, row after row (`sizeof([N][M]T)` is `N × M × sizeof(T)`), so in place it is the `*[NxM]T` its rows make, not a table ([Nesting](#nesting)): `m.tiles[r][c]` is the byte `r × M + c` from the start of the field, with the row index checked against N and the column against M.

Only a value in memory has an address. A struct in a variable, a parameter or a call's result is held in registers ([9.2](#92-by-value-vs-by-reference-passing)), and so is each field of it: indexing its array at run time is an error, as for any fixed array in registers, and so is `&` of it.

<!-- spec:begin compile -->

```ents
type Entity = (x: i32, y: i32, alive: bool)
type Pool = (count: u32, items: [64]Entity)
type Map = (cols: u32, tiles: [3][4]u8)

data pool: Pool = mut (0, [(0, 0, false); 64])
data map: Map = mut (4, [[0; 4]; 3])

// The next free slot, or none when the pool is full.
func spawn(x: i32, y: i32) -> ?*mut Entity {
  if let e = &pool.items[pool.count] {
    e.* = Entity(x, y, true)
    pool.count += 1
    return e
  }
  return 0 as ?*mut Entity
}

func x-of(i: u32) -> i32 => (pool.items[i] ?? Entity(-1, -1, false)).x
func move(k: u32#64, dx: i32) { pool.items[k].x += dx }

func alive() -> u32 {
  let n: u32 = 0
  for e in pool.items {
    if e.alive { n += 1 }
  }
  return n
}

func all() -> *mut [64]Entity => &pool.items
func count-cell() -> *mut u32 => &pool.count
func set-tile(r: u32#3, c: u32#4, v: u8) { map.tiles[r][c] = v }

test "an array field in memory is indexed there" {
  assert spawn(3, 4) != 0 as ?*mut Entity
  assert spawn(5, 6) != 0 as ?*mut Entity
  move(1, 10)
  assert x-of(1) == 15
  assert x-of(99) == -1
  assert alive() == 2
  assert all()[0].y == 4
  set-tile(2, 3, 9)
  assert map.tiles[2][3] == 9
  for i in 70 { spawn(1, 1) }
  assert pool.count == 64
  let n = count-cell()
  n.* = 0
  assert spawn(7, 7) != 0 as ?*mut Entity
  assert x-of(0) == 7
}
```

An index costs what it does on the `*[N]T` written out by hand:

```ents
type Cell = (x: i32, live: bool)
type Pool = (n: u32, cells: [8]Cell)

export func x-of(p: *Pool, k: u32#8) -> i32 => p.cells[k].x
```

```ents same-wasm
type Cell = (x: i32, live: bool)
type Pool = (n: u32, cells: [8]Cell)

export func x-of(p: *Pool, k: u32#8) -> i32 => (((p as u32) + 4) as *[8]Cell)[k].x
```

The array's place decides, not its type:

```ents
type Cell = (x: i32, live: bool)
type Pool = (n: u32, cells: [8]Cell)

func a(p: *Pool, k: u32#8) { p.cells[k].x = 1 }
func b(v: Pool, i: u32) -> i32 => v.cells[i].x
func c(p: *mut Pool, i: u32) { p.cells[i].x = 3 }
func d(v: Pool) -> *[8]Cell => &v.cells
```

```errors
cannot write through const pointer
dynamic index on value type [8]Cell
writing to an element needs an index known to be in range
'v.cells' has no address: it is part of 'v', a variable held in registers
```

<!-- spec:end -->

---

## 10. Builtin Functions

Encantis provides built-in functions that map directly to WASM instructions. These are called like regular functions: each operand is evaluated once, in order. Like any function, a builtin can be called with its first operand as the receiver, `x.sqrt()`, `a.min(b)` ([4.9](#49-method-call-syntax)). Their names are not reserved: a function the program declares with the name of a builtin takes its place. A generic function does too: `func max(comptime T: type, a: T, b: T) -> T` is what `max(a, b)` calls in its module (see [8. Generics](#8-generics)), and so does an imported one. The compiler warns where such a function is declared, once for each declaration (each of the functions that share the name, and one a `test` declares, too): `'max' replaces the builtin max in this module`. A parameter that holds a value, or a local variable, with a builtin's name is no function and replaces nothing: `max(a, b)` beside `let max = 3` is still the builtin, and nothing is said. A comptime function parameter ([8.6](#86-comptime-function-parameters)) is a function: in the body of its generic a call of its name calls the function given for it, so `comptime max: (u32, u32) -> u32` is warned of where it is declared, once: `'max' replaces the builtin max in the body of 'app'`.

### 10.1 Numeric Builtins

| Function | Input | Returns | Description |
|----------|-------|---------|-------------|
| `sqrt(x)` | f32/f64 | same | Square root |
| `ceil(x)` | f32/f64 | same | Ceiling (round up) |
| `floor(x)` | f32/f64 | same | Floor (round down) |
| `trunc(x)` | f32/f64 | same | Truncate toward zero |
| `nearest(x)` | f32/f64 | same | Round to nearest even (banker's rounding) |
| `copysign(x, y)` | f32/f64 | same | Copy sign of y to x |
| `abs(x)` | any numeric | same | Absolute value |
| `min(a, b)` | any numeric | same | Minimum of two values |
| `max(a, b)` | any numeric | same | Maximum of two values |

```ents
let x:f64 = -3.7
sqrt(abs(x))           // 1.9235...
floor(x)               // -4.0
ceil(x)                // -3.0
trunc(x)               // -3.0
nearest(2.5)           // 2.0
min(3.0, 5.0)          // 3.0
copysign(5.0, -1.0)    // -5.0
```

The operands of a builtin are typed together, like the operands of a binary operator. A literal takes the type of the other operand, whichever comes first, and two typed operands meet at the wider type (§2.10). With only literals, the operands take their default type (`i32`, `f64`).

```ents
let x:f32 = 0.25
let n:i32 = -7
let big:i64 = 5000000000
max(1.0, x)            // f32, the same as max(x, 1.0)
max(n, big)            // i64: n widens
abs(n - 10)            // 17
```

On integers, `min` and `max` compare signed or unsigned as the operands' type says, and `abs` of an unsigned value is the value itself. `abs` of the most negative value of a type wraps back to it, as negating it does: `abs(-128:i8)` is `-128`. `min` and `max` return one of their operands, so when every operand is in a range (§2.2), the result is too: `min(i, 2)` with `i: u32#4` is still a `u32#4`.

### 10.2 Integer Builtins

| Function | Input | Returns | Description |
|----------|-------|---------|-------------|
| `clz(x)` | i32/i64/u32/u64 | u8 | Count leading zeros (0 to bit width) |
| `ctz(x)` | i32/i64/u32/u64 | u8 | Count trailing zeros (0 to bit width) |
| `popcnt(x)` | i32/i64/u32/u64 | u8 | Population count (0 to bit width) |
| `mul_hi(a, b)` | u64, u64 | u64 | High 64 bits of the 128-bit product |

The bit counts return `u8` because the result can never exceed the bit width of the input (max 64), enabling implicit widening to any integer type. The count is of the operand's own bits, so a narrower or wider integer is an error: convert it first (`clz(b as u32) - 24` for a `u8`).

```ents
let n:u32 = 0b00001000
clz(n)                 // 28:u8 (leading zeros)
ctz(n)                 // 3:u8 (trailing zeros)
popcnt(n)              // 1:u8 (number of 1 bits)

// Result implicitly widens to target type
let count:u32 = popcnt(n)    // u8 → u32 implicit
let big:u64 = 0x500000000
let odd = big >> ctz(big)    // the count widens to the u64 it shifts: 5

// Arithmetic on the count alone is u8 arithmetic: widen it first if the
// result can pass 255
let offset = u64(clz(n)) * 8
```

### 10.3 Memory Builtins

| Function | Input | Returns | Description |
|----------|-------|---------|-------------|
| `memcpy(dest, src, len)` | *mut [N]u8, *[M]u8, u32 | — | Copy `len` bytes (`memory.copy`); regions may overlap |
| `memset(dest, value, len)` | *mut [N]u8, u8, u32 | — | Set `len` bytes to `value` (`memory.fill`) |
| `memzero(dest)` | *mut [N]T | — | Set all of `dest` to zero (`memory.fill`); its size comes from its type |
| `memory-size()` | — | i32 | Current memory size in pages (64KB each) |
| `memory-grow(n)` | i32 | i32 | Grow by n pages, returns previous size or -1 on failure |

`memcpy` and `memset` take pointers to sized arrays. The destination is written, so it is a `*mut` pointer, as for a write through an index: `memcpy dest: cannot write through const pointer *[4]u8 — use *mut for mutable access`. With a constant `len`, the compiler checks it against both sizes; with a runtime `len` it warns that it can't. The source of a `memcpy` can also be a many-pointer (`[*]u8`), which has no size to check; a slice is passed as its `.ptr`. Range assignment (§4.8) is the checked form for compile-time sizes.

The size of a table (`*[N][M]T`) is its N row pointers, 4 bytes each, and `memzero` of a table is an error ([Nesting](#nesting)). A length past a table's bytes is an error, and a runtime length for a table warns, each with a note that the rows lie apart: `n * sizeof(T)` for a `T` that is a fixed array counts the rows' cells, not the table.

> **Status: not yet implemented** — `memory-size` and `memory-grow` are not in the compiler yet.

```ents
let pages = memory-size()    // current page count
let old = memory-grow(1)     // grow by 1 page, returns old size
if old == -1 {
  // allocation failed
}
```

---

## 11. WebAssembly Reference

### 11.1 Widening Instructions (implicit)

| Conversion | Instruction |
|------------|-------------|
| i32 → i64 | i64.extend_i32_s / _u |
| i8, u8, i16, u16 → f32 | f32.convert_i32_s / _u |
| i32 → f64 | f64.convert_i32_s / _u |
| f32 → f64 | f64.promote_f32 |

Here `i32` stands for every integer type up to 32 bits: they all live in a wasm `i32`, so widening among them emits nothing. `_s` or `_u` follows the signedness of the type widened.

### 11.2 Narrowing Instructions (explicit cast)

| Conversion | Instruction |
|------------|-------------|
| i64 → i32 | i32.wrap_i64 |
| i32, u32 → f32 | f32.convert_i32_s / _u |
| i64 → f32 | f32.convert_i64_s / _u |
| i64 → f64 | f64.convert_i64_s / _u |
| f64 → f32 | f32.demote_f64 |
| f32 → i32 | i32.trunc_f32_s / _u |
| f64 → i32 | i32.trunc_f64_s / _u |
| f32 → i64 | i64.trunc_f32_s / _u |
| f64 → i64 | i64.trunc_f64_s / _u |

### 11.3 Control Flow Instructions

| Encantis | WASM |
|----------|------|
| `if`/`elif`/`else` | `if`/`else`/`end` (nested) |
| `match { }` | `br_table` or nested `if`/`else` |
| `while { }` | `block`/`loop` + `br_if` |
| `loop { }` | `loop`/`end` |
| `break` | `br` (to enclosing block) |
| `break when` | `br_if` |
| `continue` | `br` (to loop head) |
| `continue when` | `br_if` (to loop head) |
| `return` | `return` |

---

## 12. Examples

### Hello World

```ents
export "mem" memory 1

// Import JavaScript console.log
import "env" "log" func log([]u8)

export "main"
func main() {
  // Log "Hello, World!" to console
  // JavaScript host will receive the string pointer and length and read from linear memory
  log("Hello, World!\n")
}
```

### Fibonacci

```ents
export "fib"
func fib(n:i32)->i32 {
  if n < 2 {
    return n
  }
  return fib(n - 1) + fib(n - 2)
}

// Or with expression body:
func fib2(n:i32)->i32 =>
  if n < 2 { n } else { fib2(n - 1) + fib2(n - 2) }
```

### Sum Array

```ents
// Named return value, for..in iterator over slice
func sum(arr:[]i32)->(total:i32) {
  total = 0
  for elem in arr {
    total += elem
  }
}
```

Named return values are declared in the signature and implicitly returned. The `for..in` loop iterates over elements when given a slice.

---

## 13. Future Additions

Features under consideration for future versions of Encantis.

### SIMD Support

Access to WASM's 128-bit vector operations:

```ents
let a:v128 = v128_load(ptr)
let b:v128 = v128_load(ptr + 16)
let sum = i32x4_add(a, b)

// Potential syntax for vector literals
let mask:v128 = (0xff:u8, 0xff:u8, 0:u8, 0:u8, ...)
```

**Why:** WASM has full SIMD support via v128 types. Crypto, hashing, image processing, and numerical code can see 2-4x speedups. xxHash and Gimli both have vectorized variants that significantly outperform scalar implementations.

### Comptime Evaluation

Generic functions and generic types take types, functions and numbers at compile time ([8. Generics](#8-generics)). The same mechanism is meant to carry more:

```text
// Compile-time function execution
comptime func generate_table() -> *[256]u8 {
  let table:*[256]u8
  for i in 256 {
    table[i] = crc_byte(i)
  }
  return table
}

def crc_table = generate_table()
```

This is not parsed today. Compile-time control flow (a comptime `if` that picks a type or a branch, a generic type with a block body, recursion on a value parameter that ends) comes after it.

**Why:** Compile-time values remove the last reasons to duplicate a function. Compile-time execution enables computing lookup tables, buffer sizes, and constants at compile time, reducing runtime overhead and allowing complex initialization without startup cost.

### Module System

Source modules exist today ([7.1](#71-imports)): a file imports the functions, globals and generics another file exports, by their signatures. What a module system would add is importing a module's names without restating them:

```ents
// In math/vector.ents
module math.vector

export type Vec3 = (x:f32, y:f32, z:f32)
export func dot(a:Vec3, b:Vec3) -> f32 => ...

// In main.ents
use math.vector (Vec3, dot)
// or
use math.vector as vec
```

**Why:** Larger projects split code across files, and restating every signature at each import is the cost of that today.

### Operator Overloading via Method Calls

Operators could desugar to function calls, allowing user-defined types to support standard operators through regular function definitions:

```ents
type Vec2 = (x:f64, y:f64)

func +(a:Vec2, b:Vec2) -> Vec2 =>
  Vec2(a.x + b.x, a.y + b.y)

func *(v:Vec2, s:f64) -> Vec2 =>
  Vec2(v.x * s, v.y * s)

// Now works naturally:
let result = (a + b) * 2.0
```

Functions already share a name when their parameter types differ ([3.4](#functions-that-share-a-name)), so one operator name can have an implementation for each pair of types, and the compiler would pick one by the operand types as it does for any call.

**Why:** Unifies operators with method-call syntax ([4.9](#49-method-call-syntax)): no special mechanism needed. Operators become functions that share a name, resolved by the rules calls already follow. This keeps the language simple while enabling expressive numeric and container types.

### Closures

Functions that capture variables from their enclosing scope. Unlike plain function pointers (which are just table indices), closures carry attached state:

```ents
func make_counter(start: i32) -> () -> i32 {
  let count = start
  return || {
    count += 1
    return count
  }
}

func map(arr: []i32, f: i32 -> i32) -> []i32 {
  // With closures, f could capture external state
}

// Usage
let counter = make_counter(0)
counter()  // 1
counter()  // 2
```

**Implementation approach:**

- Non-capturing functions remain raw table indices (zero overhead)
- Capturing functions become "fat": a struct with function pointer + environment pointer
- Compiler automatically generates environment structs for captured variables
- Callee receives an implicit environment parameter

**Design questions:**

- Syntax: `|| expr`, `|x| expr`, or `func |x| expr`?
- Capture semantics: by-value (copy) or by-reference (requires lifetime tracking)?
- Should closure types be distinct from function types, or unified with automatic coercion?

**Why:** Enables functional patterns (map/filter/reduce with inline logic), callbacks with context, and eliminates manual environment-passing boilerplate. WebAssembly's GC proposal (now shipped) makes closure environments easier to manage without manual memory allocation.
