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
// Structural types
type Point = (x:f32, y:f32)      // OK: Point starts with capital
type point = (x:f32, y:f32)      // ERROR: type names must be capitalized

// Unique types
type @UserId = i64               // OK: UserId starts with capital
type @userId = i64               // ERROR: type names must be capitalized
```

This convention allows the parser to distinguish type references from variable references without forward declarations:

```ents
func distance(a:Point, b:Point) -> f32   // Point is a type
let point = Point(1.0, 2.0)              // point is a variable, Point is a constructor
```

### 1.4 Reserved Keywords

The following identifiers are reserved keywords in Encantis (aligns with `encantis.ohm`):

**Control Flow:** `if`, `elif`, `else`, `match`, `while`, `for`, `in`, `loop`, `break`, `continue`, `return`, `when`

**Declarations:** `func`, `let`, `set`, `global`, `def`, `type`, `import`, `export`, `memory`, `inline`

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

#### Boolean Literals

```ents
true
false
```

Booleans are distinct from integers. No implicit truthiness - use explicit comparisons.  Under the hood they are represented as `u1` (0 and 1)

#### Array Literals

Array literals create fixed-size arrays. Since arrays cannot exist on the stack (only pointers/slices to them), array literals are always memory-backed.

```ents
[1, 2, 3]           // list literal → *[3]i32
[0:u8; 1024]        // repeat literal → *[1024]u8 (1024 copies of 0)
[[1, 2], [3, 4]]    // nested → *[2,2]i32 (packed 2D)
```

The repeat syntax `[expr; count]` creates an array with `count` copies of `expr`. The count must be a compile-time constant.

**Compile-time values only:** Array literals must contain only compile-time constant values. This allows the compiler to intern them in the data section (like strings). For arrays with runtime values, use explicitly pre-allocated mutable buffers via `def mut` at module level.

String literals are just array literals of `u8`:

```ents
"hello"             // equivalent to [0x68, 0x65, 0x6c, 0x6c, 0x6f]
"ABC"               // equivalent to [0x41:u8, 0x42, 0x43]
```

**Inline usage:** Like strings, array literals can appear inline in function bodies. The compiler interns identical literals:

```ents
func example() {
  let coefficients = [1.0, 0.5, 0.25]  // interned, immutable
  let message = "hello"                 // same treatment as arrays
}
```

**Type Annotation Controls Pointer Type:**

The default inferred type for array literals is `*[N]T` (thin pointer with known length). Use type annotations to get other pointer types:

```ents
def buffer = [0:u8; 1024]           // *[1024]u8 (default)
def buffer: []u8 = [0:u8; 1024]     // []u8 (slice)
def buffer: [*]u8 = [0:u8; 1024]    // [*]u8 (many-pointer)
```

---

## 2. Type System

### 2.1 Unified Value Model

Encantis has a unified model for compound values:

| Level | Description | Access |
|-------|-------------|--------|
| **Multiple values** | Base concept - zero or more values | positional |
| **Tuple** | Multiple values with indices | `.0`, `.1`, ... |
| **Struct** | Tuple with named fields | `.name` |
| **Slice** | Struct `(ptr:*T, len:u32)` via `[]T` | `.ptr`, `.len` |

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

**Large integers:** `i128`/`u128` map to WASM SIMD `v128`. `i256`/`u256` use two `v128` registers. `i512`/`u512` use four `v128` registers. Bitwise operations (XOR, AND, OR) are efficient; arithmetic requires multi-instruction sequences.

### 2.3 Pointer Types

Encantis distinguishes between data layouts (how bytes are arranged in memory) and pointer types (how we reference that data).

#### Data Layouts

Data layouts describe memory shape but are not instantiable as variables:

| Syntax | Meaning |
|--------|---------|
| `[N]T` | N elements of T |
| `[N,M]T` | N×M elements packed (2D contiguous) |
| `[!]T` | null-terminated array |
| `[!,N]T` | null-terminated rows of N elements |

#### Pointer Types

| Type | Kind | `.len` | Indexing |
|------|------|--------|----------|
| `*T` | single pointer | N/A | `.*` only |
| `*[N]T` | thin, known length | N (comptime) | `[i]` |
| `*[!]T` | thin, null-terminated | scans | `[i]` |
| `*[N,M]T` | thin, packed 2D | N,M (comptime) | `[i,j]` or `[i][j]` |
| `[*]T` | thin, unknown length | N/A | `[i]` |
| `[]T` | fat slice (ptr+len) | runtime | `[i]` |

```ents
*T              // single pointer - points to one T, dereference with .*
*[N]T           // thin pointer to N elements, compile-time length
*[!]T           // thin pointer to null-terminated array
[*]T            // thin many-pointer, unknown length
[]T             // fat slice - ptr + runtime length
```

All pointers and lengths are `u32` semantics which is `i32` at the WASM level (32-bit address space).

#### Pointer Operations

The dereference operator `.*` is only valid for single pointers `*T`. Array pointers and slices use indexing:

```ents
let p:*u8 = ...
let v = p.*          // OK: dereference single pointer

let arr:*[16]u8 = ...
let v = arr[0]       // OK: index into array pointer
let v = arr.*        // ERROR: use [0] instead

let s:[]u8 = ...
let v = s[0]         // OK: index into slice
let v = s.*          // ERROR: use [0] instead
```

#### Nesting Examples

```ents
[][]T       // slice of slices (element = ptr+len, 8 bytes each)
[]*T        // slice of pointers (element = 4 bytes each)
*[]T        // pointer to a slice struct (points to 8 bytes)
[][N]T      // slice of N-element arrays (element = N×sizeof(T))
*[N][M]T    // pointer to N pointers to M-element arrays
*[N,M]T     // pointer to N×M packed elements (contiguous 2D)
```

### 2.4 Array and Slice Types

Arrays cannot exist on the stack (only pointers/slices to them can) because dynamic indexing requires memory access.

#### `[]T` — Runtime Slice (Fat Pointer)

Fat pointer containing pointer and length. Slices behave like a struct `(ptr:[*]T, len:u32)`:

```ents
let data:[]u8 = ...

// Property access
data.ptr        // extract pointer ([*]u8)
data.len        // get length (u32), O(1)
data[i]         // element access

// Tuple-style access (0-indexed)
data.0          // same as data.ptr
data.1          // same as data.len

// Destructuring
let (ptr, len) = data             // by position
let (ptr:, len:) = data           // by name
let (ptr: p, len: n) = data       // renamed bindings
```

#### `*[N]T` — Thin Pointer to Fixed Array

Pointer to N elements with compile-time known length:

```ents
let buf:*[16]u8 = ...
buf[0]              // first element
buf[15]             // last element
buf.len             // 16 (compile-time constant)
```

#### `*[!]T` — Thin Pointer to Null-Terminated

Pointer to null-terminated data:

```ents
let cstr:*[!]u8 = ...
cstr[0]             // first byte
cstr.len            // runtime scan for null, O(n)
```

#### `*[N,M]T` — Thin Pointer to Packed Multi-Dimensional

Pointer to contiguous N×M elements (2D array with no pointer indirection):

```ents
def sigma:*[12,16]u8 = [
  x"00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f",
  x"0e 0a 04 08 09 0f 0d 06 01 0c 00 02 0b 07 05 03",
  // ... 10 more rows
]

sigma[round]        // returns *[16]u8 (pointer to row)
sigma[round, i]     // returns u8 (element at row,col)
sigma[round][i]     // same as above (chained indexing)
```

#### `[*]T` — Thin Many-Pointer (Unknown Length)

Thin pointer to multiple elements with unknown length:

```ents
let mp:[*]u8 = ...
mp[i]               // element access (caller must ensure bounds)
// mp.len          // not available - length unknown
```

### 2.5 Tuple Types

```ents
(i32, i32)           // pair of i32
(f64, f64, f64)      // triple of f64
```

Standard tuple semantics apply:

- `()` is void (0-tuple)
- `(x)` is grouping, not a tuple — the type is just `x`
- `(x, y, ...)` is a tuple (2+ elements)

### 2.6 Struct Types

Structs are tuples with named fields, using the same `()` syntax:

```ents
type Point = (x:f32, y:f32)
type Rect = (origin:Point, size:(w:f32, h:f32))

type @Color = (r:u8, g:u8, b:u8, a:u8)
```

Structural aliases omit `@`; nominal aliases use `@Name` with the same `type` keyword.

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

### 2.7 Enum Types (Algebraic Data Types)

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

### 2.8 Type Conversions

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

### 3.1 Definitions

Definitions bind compile-time constant values. The behavior depends on whether the value can exist on the stack:

#### Compile-time Substitution (stack-representable values)

For scalars and tuples, `def` performs textual substitution - the value is inlined at each use site:

```ents
def prime32-1 = 2654435761
def prime32-2 = 2246822519
def max-size = 1024
def origin = (0.0, 0.0)

// Using definitions - values are inlined
let hash:u32 = seed + prime32-1
```

Pointer values are also substituted:

```ents
def stack-start: *u8 = 0x1000    // pointer VALUE, not allocation
def null-ptr: *u8 = 0
```

#### Memory Allocation (array/string literals)

Array and string literals cannot exist on the stack, so they are automatically serialized to the data section:

```ents
def buffer = [0:u8; 1024]         // *[1024]u8 (default inference)
def buffer: []u8 = [0:u8; 1024]   // []u8 (explicit slice)
def buffer: [*]u8 = [0:u8; 1024]  // [*]u8 (many-pointer)

def msg = "hello"                 // *[5]u8
def msg: []u8 = "hello"           // []u8
```

#### Memory Allocation with `&` (scalars/tuples)

For values that could exist on the stack but you want in memory, use `&`:

```ents
def pi-ptr = &3.14                // *f64, serializes 8 bytes
def point-ptr = &(1.0, 2.0)       // *(f64, f64), serializes 16 bytes
def answer = &42:i128             // *i128, serializes 16 bytes
```

The `:` type annotation binds tighter than `&`, so `&42:i128` means `&(42:i128)`.

#### Mutability

By default, allocated data goes to the read-only data section. Use `mut` for mutable data:

```ents
def table = [0:u8; 256]           // read-only section
def buffer = mut [0:u8; 1024]     // mutable section
def counter = &mut 0:u32          // mutable scalar
```

### 3.2 Variables

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

### 3.3 Functions

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

### 3.4 Inline Functions

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

### 3.5 Function Overloading

Functions can be overloaded by defining multiple clauses with different patterns. The compiler groups clauses and dispatches based on the pattern:

```ents
// Type-based overloading — different shapes, compile-time dispatch
func process(x: i32) -> i32 => x * 2
func process(x: i32, y: i32) -> i32 => x + y

// Value-based overloading — same shape, runtime dispatch
func factorial(0) -> i32 => 1
func factorial(n: i32) -> i32 => n * factorial(n - 1)

func fib(0) -> i32 => 0
func fib(1) -> i32 => 1
func fib(n: i32) -> i32 => fib(n - 1) + fib(n - 2)
```

#### Dispatch Semantics

**Type/shape dispatch** (different tuple structures) is resolved at compile time. Each unique shape generates a separate WebAssembly function:

```ents
func process(x: i32) -> i32           // compiles to $process_i32
func process(x: i32, y: i32) -> i32   // compiles to $process_i32_i32
```

**Value dispatch** (same shape, different value patterns) compiles to a single WebAssembly function with an internal match:

```ents
// These compile to ONE function with runtime pattern matching
func mul(a: i32, 0) -> i32 => 0
func mul(a: i32, 1) -> i32 => a
func mul(a: i32, 2) -> i32 => a + a
func mul(a: i32, b: i32) -> i32 => a * b

// Compiles to approximately:
// (func $mul (param $a i32) (param $b i32) (result i32)
//   (if (i32.eq (local.get $b) (i32.const 0)) (return (i32.const 0)))
//   (if (i32.eq (local.get $b) (i32.const 1)) (return (local.get $a)))
//   (if (i32.eq (local.get $b) (i32.const 2)) (return (i32.add (local.get $a) (local.get $a))))
//   (i32.mul (local.get $a) (local.get $b)))
```

Clauses are matched in definition order (first match wins). The catch-all pattern with a binding (`b: i32`) should come last.

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
| `+\|` | saturating add | integers |
| `-\|` | saturating subtract | integers |
| `*\|` | saturating multiply | integers |

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

| Expression | Result |
|------------|--------|
| `ptr + n` | offset forward by n bytes |
| `ptr - n` | offset backward by n bytes |
| `ptr - ptr` | byte distance between pointers |

#### Indexing

```ents
let arr:*i32 = ...
arr[2]          // offset by 2 elements (8 bytes for i32)
(arr + 8).*     // equivalent to arr[2]
```

Note: `ptr + n` offsets by bytes, `ptr[n]` offsets by elements.

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

### 4.7 Slice/Range Syntax

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

for elem in arr {        // iterate over array/slice elements
  process(elem)
}

for i, elem in arr {     // iterate with index
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

Encantis has a unified pattern syntax that works consistently across function signatures, match expressions, if-let bindings, and let destructuring. This enables a single grammar rule to express type matching, value matching, and variable binding in all contexts.

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

Functions have multiple inputs and multiple outputs (0 or more each), mapping directly to WASM's multi-value semantics.

The signature syntax determines what bindings exist inside the function body:

```ents
// Named bindings with parens
func to_polar(point: CartesianPoint) -> (out: PolarPoint)
// Call: to_polar(p)
// Bindings: point, out

// Constructor pattern syntax — destructured bindings
func to_polar CartesianPoint(x, y) -> PolarPoint(d, a)
// Call: to_polar(1, 2)
// Bindings: x, y, d, a

// Bare type — no bindings, called without parens
func double i32 -> i32
// Call: double 5
// Bindings: none (use traditional return)
```

All three forms can define the same underlying function type — they differ only in bindings and calling convention.

#### Calling Convention: Parens vs Bare

The signature syntax determines how a function is called:

| Signature Input | Call Syntax |
|-----------------|-------------|
| `(x: T)` | `func(value)` — parens required |
| `(T)` | `func(value)` — parens required |
| `T` | `func value` — bare (no parens) |
| `T(a, b)` | `func(a, b)` — parens required (tuple fields) |

```ents
// Bare input — bare call
func double i32 -> i32 => ...
let x = double 5

// Paren input — paren call
func double(n: i32) -> i32 => ...
let x = double(5)

// Both define the same type (i32 -> i32) but different calling conventions
```

For multi-value inputs (tuples), parens are always required since the values are comma-separated.

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

The compiler enforces exhaustive matching — all variants must be handled, or a wildcard `_` pattern must be present.

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

Use `if let` when you only need to check for one variant:

```ents
if let RGB(r, g, b) = color {
  // only runs if color is RGB
  draw_rgb(r, g, b)
}

// With else branch
if let Some(value) = maybe_result {
  process(value)
} else {
  handle_missing()
}

// Chained with elif let
if let RGB(r, g, b) = color {
  draw_rgb(r, g, b)
} elif let HSL(h, s, l) = color {
  draw_hsl(h, s, l)
} else {
  draw_default()
}
```

This is syntactic sugar for a match with a single pattern and wildcard fallthrough. Use `if let` when you care about one specific variant; use `match` when handling multiple variants or when exhaustiveness checking is valuable.

### 6.5 Let Destructuring

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

// Import memory
import "env" "memory" memory 1
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

// Export memory (explicit name required - memory has no internal name)
export "mem" memory 1      // 1 page = 64KB

// Export global - name defaults to global identifier
export global counter:i32 = 0
```

### 7.3 Memory Declarations

Static data is declared inside a `memory` block. Expressions must be comptime (literals or tuples/structs of literals).

```ents
// Declare memory (pages of 64KB)
memory 1                   // min 1 page
memory 2 16                // min 2 pages, max 16 pages

// Initialize memory with constants
memory 1 {
  0   => "Hello",             // UTF-8 string at offset 0
  6   => 0:u8,                 // null terminator
  16  => x"01 02 03 04",       // raw bytes at offset 16
  32  => (100:i32, 200:i32),   // tuple of i32s at 32
  48  => (x: 1.0, y: 2.0),     // struct at 48
  numbers => (1, 2, 3),        // tuple of i32s at auto-assigned offset (stored in `numbers`)
  answer:u64 => 42,            // 8 byte unsigned integer at auto-assigned offset stored in `answer`
  (name:, age:) => ("Bob", 26) // tuple of ([]u8, i32) with `name` being a fat pointer and `age` a simple pointer.
}
```

---

## 8. Memory Model

### 8.1 Stack vs Memory Allocation

Encantis distinguishes between stack-allocated values (WASM locals) and memory-allocated values (linear memory):

| Declaration | Storage | Address |
|-------------|---------|---------|
| `let x:i32` | WASM local | None (no `&x`) |
| `let p:Point` | Multiple WASM locals | None |
| `let ptr:*Point` | Single WASM local (i32) | Points to memory |
| `let arr:*[64]u8` | Linear memory | Has address |
| `global g:i32` | Linear memory | Has address |

Primitives and small structs declared as `let` are stored in WASM locals—fast registers with no memory address. Pointers like `*Point` are single i32 values pointing to data serialized in linear memory.

```ents
let p:Point = Point(1.0, 2.0)   // two f32 WASM locals, no address
let ptr:*Point = &heap_point    // one i32 local pointing to 8 bytes in memory

// Stack allocation: fields are separate values
let a = p.x                      // reads from WASM local

// Memory allocation: fields are serialized
let b = ptr.x                    // reads from linear memory at ptr+0
```

Fixed-size arrays (`*[N]T`) and globals are always memory-allocated and have addresses.

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
