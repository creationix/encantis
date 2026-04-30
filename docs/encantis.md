# Encantis Language Reference

Encantis is a systems programming language that compiles to WebAssembly. It provides direct memory control, explicit types, and zero-cost abstractions while generating compact, efficient WASM modules.

**Grammar source of truth:** [`packages/compiler/src/grammar/encantis.ohm`](../packages/compiler/src/grammar/encantis.ohm) (authoritative). This document is an explanatory guide with examples; consult the Ohm grammar for exact syntax.

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

Hyphens in identifiers are idiomatic for constants and helper functions.

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

### 1.4 Reserved Keywords

The following identifiers are reserved keywords in Encantis (aligns with `encantis.ohm`):

**Control Flow:** `if`, `elif`, `else`, `match`, `while`, `for`, `in`, `loop`, `break`, `continue`, `return`, `when`

**Declarations:** `func`, `let`, `set`, `global`, `def`, `data`, `type`, `import`, `export`, `memory`, `inline`

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
"line1\nline2"    // escape sequences: \n \t \r \\\ \"
'also a string'   // single quotes work too
x"aabbccdd"       // hex bytes: bytes 0xAA, 0xBB, 0xCC, 0xDD
b"SGVsbG8="       // base64 bytes
```

Both single and double quoted strings are equivalent. String literals live in the data section. They are comptime byte arrays that can coerce to any compatible slice type: `[]u8`, `[!]u8` (null-terminated), `[?]u8` (LEB128-prefixed), `[*]u8` (many-pointer), etc. The default type when no annotation is provided is `[_]u8` (fat slice with inferred length).

#### Template Literals

Template literals use backticks and `${expr}` interpolation to combine static text with runtime values:

```ents
`hello ${name}\n`
`Error ${msg}: ${errnos[code]}\n`
`${x} + ${y} = ${x + y}`
```

Template literals produce a **slice of slices** (`[][]u8`) — an array of fragments where static parts are const strings and interpolated parts are runtime `[]u8` values. This maps directly to scatter-gather I/O (WASI's `writev`/iovec pattern):

```ents
// Template literal:
wasi_fd_write(stderr, `Error ${msg}: ${errnos[code]}\n`, nwritten)

// Equivalent manual construction:
data err_iovecs:[]mut []u8 = ["Error ", "", ": ", "", "\n"]
err_iovecs[1] = msg
err_iovecs[3] = errnos[code]
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
data count = mut 5:i32              // count: *mut i32 (mutable)
data origin = (0.0, 0.0)           // origin: *(f64, f64) (const)
```

`data` always produces a pointer. The inferred type is the tightest: `*[N]T` (or `*mut [N]T` with `mut`). This auto-coerces to `[]T` or `[*]T` at call sites.

The difference between `data` and an inline literal: `data` gives the allocation a name. An inline `"hello"` is anonymous and may be deduplicated with other identical const literals. A `data msg = "hello"` is a named allocation at a known address.

**Zero-initialized buffers** are free — wasm memory starts as zeros, so `data buf = mut [0:u8; 1024]` emits no data segment.

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

Fixed arrays can only be indexed by **compile-time constant** expressions, since the elements live in registers, not addressable memory:

```ents
let v: [4]u32 = [1, 2, 3, 4]
let x = v[0]        // OK: constant index
let y = v[3]        // OK: constant index
let z = v[i]        // ERROR: dynamic index requires memory — use a slice or pointer
```

Use fixed arrays for small data that benefits from register access: cryptographic limbs, color channels, coordinate vectors.

### 2.5 Pointer Types

All pointers are `u32` (wasm 32-bit address space). Every pointer type starts with `*` or uses brackets, making references visually distinct from values.

| Type      | Meaning                    | `.len`          | `.wid`             | Indexing            |
|-----------|----------------------------|-----------------|---------------------|---------------------|
| `*T`      | pointer to one T           | N/A             | `sizeof(T)`         | `.*` to dereference |
| `*[N]T`   | pointer to N elements      | N (comptime)    | `sizeof(T)`         | `[i]`               |
| `*[!]T`   | pointer to null-terminated | scans, O(n)     | `sizeof(T)`         | `[i]`               |
| `*[N,M]T` | pointer to N×M packed 2D   | N, M (comptime) | `sizeof(T)`         | `[i,j]`             |
| `[*]T`    | many-pointer (no bounds)   | N/A             | `sizeof(T)`         | `[i]` (unchecked)   |
| `[]T`     | slice (fat pointer)        | runtime         | `sizeof(T)`         | `[i]`               |

`.len` is the element count. `.wid` is the byte width of each element (compile-time constant). Together they give the total byte size: `data.len * data.wid`.

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

Optional values cannot be used directly where non-optional values are expected. You must resolve them using `if let` or `??`:

```ents
let p: ?*u8 = get_optional_ptr()
p.*                              // type error: ?*u8 is not *u8
if let val = p { val.* }         // OK: unwrapped inside if-let
p ?? default_ptr                 // OK: resolved with fallback
```

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
print(buf)                        // OK: mutable → const (implicit coercion)
fill(buf)                         // OK: mutable → mutable
print("hello")                    // OK: const literal → const param
fill("hello")                     // ERROR: const literal → mutable param
```

**Coercion:** mutable pointers implicitly coerce to read-only (widening). The reverse is an error.

See [The `mut` Keyword on Literals](#the-mut-keyword-on-literals) for how `mut` interacts with literal expressions and `data` declarations.

#### Nesting

```ents
*[]T        // pointer to a slice (points to ptr+len pair)
*[N][M]T    // pointer to N pointers to M-element arrays
*[N,M]T     // pointer to N×M packed elements (contiguous 2D)
```

### 2.6 Slices

`[]T` is a fat pointer: a `(ptr: [*]T, len: u32)` pair. Slices are the standard way to pass variable-length data.

```ents
let text: []u8 = "hello"        // read-only slice (default)
let buf: []mut u8 = get-buf()   // mutable slice

text.ptr        // extract pointer
text.len        // get length (u32)
text[i]         // element access (read)
buf[i] = 0      // element write (only on []mut)
```

Slices are value types at the language level (the ptr+len pair is copied), but the data they point to is shared. Mutating through a `[]mut` slice affects the underlying memory.

#### Static Memory Allocation

Use `data` to allocate in the wasm data section:

```ents
data table = [1:u64, 2, 3, 4]          // table: *[4]u64 (const, deduplicable)
data key = x"9d61b19deffd5a60"          // key: *[8]u8 (const)
data buf = mut [0:u8; 1024]             // buf: *mut [1024]u8 (mutable, unique)
```

The inferred type is `*[N]T` (const) or `*mut [N]T` (when `mut` is used). These auto-coerce to `[]T` or `[]mut T` at call sites.

### 2.7 Tuple Types

```ents
(i32, i32)           // pair of i32
(f64, f64, f64)      // triple of f64
```

Standard tuple semantics:

- `()` is void (0-tuple)
- `(x)` is grouping, not a tuple — the type is just `x`
- `(x, y, ...)` is a tuple (2+ elements)

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

#### Struct Field Access

```ents
let p:Point = Point(3.0, 4.0)
let x = p.x              // field read
p.y = 5.0                // field write
```

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

Integer to float is implicit only when the float's mantissa can hold all values:

| Float | Safe integer types | Mantissa bits |
|-------|-------------------|---------------|
| f32 | i8, u8, i16, u16 | 24 |
| f64 | i8, u8, i16, u16, i32, u32 | 53 |

#### Comptime Literal Promotion

Unsuffixed literals check actual value, not type:

```ents
let x:f32 = 1.0 + 42        // OK: 42 fits in f32 mantissa
let y:f32 = 1.0 + 16777216  // OK: 2^24 is max exact integer
let z:f32 = 1.0 + 16777217  // ERROR: exceeds f32 precision
```

Once a value has a concrete type, normal promotion rules apply:

```ents
let z = 1.3            // inferred as f64
let a:f32 = z          // ERROR: f64 → f32 needs explicit cast
```

#### Type Errors

```ents
i32 + f32   // ERROR: i32 exceeds f32's mantissa
i32 + u32   // ERROR: mixed signedness, cast explicitly
i64 → i32   // ERROR: narrowing needs explicit cast
bool + i32  // ERROR: cast bool first
```

#### Explicit Casts

Two syntaxes:

```ents
// Function-style (binds tightly)
i32(x)
f64(value)
(*u8)(ptr)

// as-style (lower precedence)
x as i32
ptr as *u8
```

Function-style binds like a call; `as` requires parens in expressions:

```ents
i32(x) + 1      // cast then add
x as i32 + 1    // ERROR: parses as x as (i32 + 1)
(x as i32) + 1  // OK: cast then add
```

Casts are required for:

- Narrowing (larger → smaller)
- Lossy integer→float
- Mixed signedness operations
- Bool→integer

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
def max-size: u32 = 1024         // explicit u32
```

### 3.2 Data Declarations (`data`)

`data` allocates a value in the wasm data section and binds the name to a pointer.

```ents
data buf = [0:u8; 1024]             // buf: *[1024]u8
data key = x"9d61b19deffd5a60"      // key: *[8]u8
data table = [1:u64, 2, 3, 4]       // table: *[4]u64
data msg = "hello"                   // msg: *[5]u8
data origin = (0.0, 0.0)            // origin: *(f64, f64)
```

The inferred type is the tightest pointer (`*[N]T`), which auto-coerces to `[]T` or `[*]T` at call sites. Annotate the LHS to force a specific type:

```ents
data buf = [0:u8; 1024]             // *[1024]u8 (best practice)
data buf: []u8 = [0:u8; 1024]       // []u8 (slice, loses compile-time length)
```

#### Mutability

By default, data is mutable (wasm linear memory is always writable). Use `mut` on the literal to signal intent and prevent deduplication:

```ents
data table = [0:u8; 256]            // shared, may be deduplicated
data buffer = mut [0:u8; 1024]      // unique, never deduplicated
```

### 3.3 Variables

```ents
// Mutable let variable
let count:i32 = 0
let ptr:*u8       // uninitialized

// Global variable (stored in linear memory)
global total:i32 = 0
```

Type annotations are optional when the type can be inferred from the initializer:

```ents
global counter = 0:u32           // type inferred from suffix
let result = compute()           // type inferred from return type
let pair = (1.0, 2.0)            // type inferred as (f64, f64)
```

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

Named return values are declared in the signature with `-> (name:type)`. They act as pre-declared lets and are implicitly returned when the function ends.

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

#### Function Types and Pointers

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

### 4.3 Comparison Operators

| Operator | Description |
|----------|-------------|
| `<` | less than |
| `>` | greater than |
| `<=` | less or equal |
| `>=` | greater or equal |
| `==` | equal |
| `!=` | not equal |

All comparisons return `bool`.

### 4.4 Unary Operators

| Operator | Description |
|----------|-------------|
| `-x` | negation |
| `!x` | logical NOT (bool only) |
| `~x` | bitwise NOT |
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

Any type with multiple underlying values can be destructured (slices, tuples, structs, etc).

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

### 4.7 Bounds-Checked Indexing

Array and slice indexing follows strict rules based on whether the index is known at compile time:

**Compile-time constant indices** are statically verified against the known array length:

```ents
data table = [10, 20, 30, 40]    // *[4]i32
let x = table[0]                  // OK: 0 < 4
let y = table[3]                  // OK: 3 < 4
let z = table[4]                  // compile error: index 4 out of bounds for *[4]i32
```

**Runtime indices** produce an optional result when the element type is a pointer or slice, since the access might be out of bounds:

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

This generates a bounds check that produces either the real value or the zero sentinel, then a separate null check when unwrapping. If `msg` is only used once, wasm-opt will typically fuse these into a single bounds check.

#### The `??` Operator

The coalesce operator `??` resolves an optional or out-of-bounds index with a fallback value:

```ents
let name = names[i] ?? "Unknown"     // bounds-checked index with fallback
let ptr = optional_ptr ?? default    // null-checked pointer with fallback
```

The fallback value must be assignable to the element/unwrapped type. The result type is the non-optional type.

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

### 4.8 Slice/Range Syntax

> **Status: Not yet implemented.**

Create slices from existing arrays using range syntax:

```ents
let arr:*[16]u8 = ...
arr[2..8]       // []u8 from index 2 to 7 (length 6)
arr[8..]        // []u8 from 8 to end
arr[..4]        // []u8 from 0 to 3
arr[..]         // []u8 whole array as slice
```

Bulk copy via slice assignment (uses `memory.copy`):

```ents
cv[0..8] = hs[0..8]       // copy 8 elements
cv[8..16] = iv[0..8]      // copy to different offset
```

Bulk fill (uses `memory.fill`):

```ents
buffer[0..1024] = 0       // zero 1024 bytes
```

### 4.8 UFCS (Uniform Function Call Syntax)

> **Status: Not yet implemented.**

Any function can be called using method syntax. If `f(a, b, c)` is valid, then `a.f(b, c)` is also valid:

```ents
func length(p:Point) -> f32 {
  return sqrt(p.x * p.x + p.y * p.y)
}

func scale(p:Point, factor:f32) -> Point {
  return Point(p.x * factor, p.y * factor)
}

let p = Point(3.0, 4.0)
p.length()                 // same as length(p)
p.scale(2.0)               // same as scale(p, 2.0)

// Chaining
p.scale(2.0).length()      // same as length(scale(p, 2.0))
```

UFCS works for all types, not just structs:

```ents
func double(x:i32) -> i32 => x * 2
func to_hex(data:[]u8) -> []u8 => ...

let n = 21
n.double()                 // 42

let data:[]u8 = ...
data.to_hex()              // works on slices too
```

Note: There are no implicit built-in methods except for operators that already look like function calls (ex: `sqrt(n)` can be written as `n.sqrt()`). Slice properties like `slice.len` and `slice.ptr` are built-in field access, not method calls.

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

### 5.2 Loops

```ents
while condition {        // condition checked before each iteration
  // body
}

for i in num {           // iterate 0 to n-1
  process(i)
}

for elem in arr {        // iterate over array/slice elements (not yet implemented)
  process(elem)
}

for i, elem in arr {     // iterate with index (not yet implemented)
  process(i, elem)
}

loop {                   // infinite loop
  // body
}
```

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

### 5.4 Match Expressions

Match expressions provide multi-way branching on values:

```ents
match value {
  0 => handle_zero()
  1 => handle_one()
  _ => handle_other()
}
```

Match arms are tested in order. The `_` pattern matches any value and serves as the default case. Each arm can use either expression body (`=>`) or block body:

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

Match is an expression and returns a value. All arms must have compatible types:

```ents
let msg:[]u8 = match status & 3 {
  0 => "idle"
  1 => "running"
  2 => "done"
  _ => "error"
}
```

Multiple values can share an arm by using multiple patterns (comma-separated):

```ents
match char {
  'a', 'e', 'i', 'o', 'u' => true
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

// Anonymous tuple patterns work too
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
- **literals** (`0`, `"hello"`) — exact match
- **`_`** — wildcard (match anything, don't bind)

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

### 7.3 Memory Declarations

```ents
// Declare memory (pages of 64KB)
memory                     // compiler computes min from static data, no max
memory 8                   // min 8 pages
memory 8 256               // min 8 pages, max 256 pages
```

When no min is specified, the compiler computes it as `max(1, ceil(static_data_bytes / 65536))`. When no max is specified, no upper bound is emitted (the runtime caps at its own limit).

---

## 8. Memory Model

### 8.1 Stack vs Memory Allocation

Encantis distinguishes between register storage (WASM locals/globals) and linear memory:

| Declaration | Storage | Notes |
|-------------|---------|-------|
| `let x:i32` | WASM local | Function-scoped register |
| `let p:Point` | Multiple WASM locals | Fields are separate registers |
| `let ptr:*[64]u8` | Single WASM local (i32) | Holds a pointer, doesn't allocate |
| `global g:i32` | WASM global | Module-scoped register |
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

### 8.2 By-Value vs By-Reference Passing

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
func modify(p:*Point) {
  p.x = 0.0
  p.y = 0.0
}

let p = Point(3.0, 4.0)
modify(&p)                 // ERROR: p has no address (stack-allocated)

let mem_p:*Point = allocate_point()
modify(mem_p)              // OK: mem_p points to linear memory
```

#### Structural Coercion

Structural struct types match any value with coercible fields at each position:

```ents
type BigPoint = (x:i32, y:i32)

func scale(p:BigPoint, factor:i32) -> BigPoint {
  return BigPoint(p.x * factor, p.y * factor)
}

// OK: fields coerce i8 → i32 (by-value, compiler inserts conversions)
let small = (x: 10:i8, y: 20:i8)
scale(small, 2)
```

This coercion only applies to by-value passing. For pointers, exact memory layout is required:

```ents
func process(p:*BigPoint) {
  // reads/writes memory directly, expects 8 bytes (2 x i32)
}

let small:(x:i8, y:i8) = (x: 10, y: 20)
process(&small)            // ERROR: layout mismatch (2 bytes vs 8 bytes)
```

### 8.3 WASM Type Mapping

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

### 8.4 Slice Constructors

Slices can be constructed explicitly from pointer and length components:

```ents
[]u8(ptr, len)           // construct []u8 from components
[][]u8(iovec_ptr, count) // construct slice of slices
```

This is useful when you have separate pointer and length values:

```ents
def buffer = [0:u8; 1024]
let slice = []u8(buffer, 1024)      // construct slice from pointer + length
```

### 8.5 Array Type Conversions

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

---

## 9. Builtin Functions

Encantis provides built-in functions that map directly to WASM instructions. These are called like regular functions.

### 9.1 Float Builtins

| Function | Input | Returns | Description |
|----------|-------|---------|-------------|
| `sqrt(x)` | f32/f64 | same | Square root |
| `abs(x)` | f32/f64 | same | Absolute value |
| `ceil(x)` | f32/f64 | same | Ceiling (round up) |
| `floor(x)` | f32/f64 | same | Floor (round down) |
| `trunc(x)` | f32/f64 | same | Truncate toward zero |
| `nearest(x)` | f32/f64 | same | Round to nearest even (banker's rounding) |
| `min(a, b)` | f32/f64 | same | Minimum of two values |
| `max(a, b)` | f32/f64 | same | Maximum of two values |
| `copysign(x, y)` | f32/f64 | same | Copy sign of y to x |

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

### 9.2 Integer Builtins

| Function | Input | Returns | Description |
|----------|-------|---------|-------------|
| `clz(x)` | i32/i64/u32/u64 | u8 | Count leading zeros (0 to bit width) |
| `ctz(x)` | i32/i64/u32/u64 | u8 | Count trailing zeros (0 to bit width) |
| `popcnt(x)` | i32/i64/u32/u64 | u8 | Population count (0 to bit width) |

These functions return `u8` because the result can never exceed the bit width of the input (max 64), enabling implicit widening to any integer type.

```ents
let n:u32 = 0b00001000
clz(n)                 // 28:u8 (leading zeros)
ctz(n)                 // 3:u8 (trailing zeros)
popcnt(n)              // 1:u8 (number of 1 bits)

// Result implicitly widens to target type
let count:u32 = popcnt(n)    // u8 → u32 implicit
let offset:u64 = clz(n) * 8  // u8 → u64 implicit
```

### 9.3 Memory Builtins

| Function | Input | Returns | Description |
|----------|-------|---------|-------------|
| `memory-size()` | — | i32 | Current memory size in pages (64KB each) |
| `memory-grow(n)` | i32 | i32 | Grow by n pages, returns previous size or -1 on failure |

```ents
let pages = memory-size()    // current page count
let old = memory-grow(1)     // grow by 1 page, returns old size
if old == -1 {
  // allocation failed
}
```

---

## 10. WebAssembly Reference

### 10.1 Widening Instructions (implicit)

| Conversion | Instruction |
|------------|-------------|
| i32 → i64 | i64.extend_i32_s / _u |
| i32 → f32 | f32.convert_i32_s / _u |
| i32 → f64 | f64.convert_i32_s / _u |
| i64 → f32 | f32.convert_i64_s / _u |
| i64 → f64 | f64.convert_i64_s / _u |
| f32 → f64 | f64.promote_f32 |

### 10.2 Narrowing Instructions (explicit cast)

| Conversion | Instruction |
|------------|-------------|
| i64 → i32 | i32.wrap_i64 |
| f64 → f32 | f32.demote_f64 |
| f32 → i32 | i32.trunc_f32_s / _u |
| f64 → i32 | i32.trunc_f64_s / _u |
| f32 → i64 | i64.trunc_f32_s / _u |
| f64 → i64 | i64.trunc_f64_s / _u |

### 10.3 Control Flow Instructions

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

## 11. Examples

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

## 12. Future Additions

Features under consideration for future versions of Encantis.

### Generics

Parameterized types and functions would enable reusable algorithms without code duplication:

```ents
func swap<T>(a:*T, b:*T) {
  let tmp = a.*
  a.* = b.*
  b.* = tmp
}

type Vec<T> = (data:*T, len:u32, cap:u32)
```

**Why:** Currently, utilities like `swap`, `min`, `max`, or data structures like vectors must be duplicated for each type. Generics enable writing code once that works for any type, critical for building reusable libraries.

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

Compile-time computation beyond simple literals:

```ents
def page_size = 64 * 1024
def buffer_pages = 4
def buffer_size = page_size * buffer_pages

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

**Why:** Enables computing lookup tables, buffer sizes, and constants at compile time. Reduces runtime overhead and allows complex initialization without startup cost.

### Module System

Multi-file organization beyond WASM imports:

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

**Why:** Larger projects need to split code across files. Currently the only modularity is WASM-level imports from the host environment. A proper module system enables code organization and selective visibility.

### Defer

Guaranteed cleanup at scope exit:

```ents
func process_file(path:[*:0]u8) -> Result {
  let handle = open(path)
  defer close(handle)

  let buffer = allocate(1024)
  defer free(buffer)

  // Multiple return paths - cleanup always runs
  return when check_header(handle) == false { Err(BadHeader) }

  process(handle, buffer)
  return Ok(())
}
```

**Why:** Ensures resources are released regardless of how a function exits. Reduces bugs from forgotten cleanup, especially with multiple return paths or error conditions.

### Operator Overloading via UFCS

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

Combined with function overloading, the same operator name can have multiple implementations for different type signatures. The compiler selects the correct overload based on argument types.

**Why:** Unifies operators with UFCS—no special mechanism needed. Operators become overloaded functions resolved by the same rules as method calls. This keeps the language simple while enabling expressive numeric and container types.

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
