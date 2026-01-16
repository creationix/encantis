# Encantis Language Reference

Encantis is a systems programming language that compiles to WebAssembly. It provides direct memory control, explicit types, and zero-cost abstractions while generating compact, efficient WASM modules.

## Sample Programs

### Hello World

```ents
export "mem" memory 1

// Import JavaScript console.log
import "env" "log" func log(u8[])

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
func fib(n:i32) -> i32 {
  if n < 2 {
    return n
  }
  return fib(n - 1) + fib(n - 2)
}

// Or with expression body:
func fib2(n:i32) -> i32 =>
  if n < 2 { n } else { fib2(n - 1) + fib2(n - 2) }
```

### Sum Array

```ents
// Named return value, for..in iterator over slice
func sum(arr:i32[]) -> (total:i32) {
  total = 0
  for elem in arr {
    total += elem
  }
}
```

Named return values are declared in the signature and implicitly returned. The `for..in` loop iterates over elements when given a slice.

## Comments

```ents
// Single line comment
/* Block comment */
```

## Identifiers

Identifiers can contain letters, digits, underscores, and hyphens. They must start with a lowercase letter:

```ents
count           // simple
prime32-1       // hyphenated
merge-round64   // hyphenated
my_var_2        // underscores and digits
```

Hyphens in identifiers are idiomatic for constants and helper functions.

## Reserved Keywords

The following identifiers are reserved keywords in Encantis:

**Control Flow:** `if`, `elif`, `else`, `while`, `for`, `in`, `loop`, `break`, `continue`, `return`, `when`

**Declarations:** `func`, `let`, `set`, `global`, `def`, `type`, `import`, `export`, `memory`, `data`, `inline`, `unique`

**Operators:** `as`

## Builtin Functions

Encantis provides built-in functions that map directly to WASM instructions. These are called like regular functions.

### Float Builtins (f32/f64)

| Function | Description |
|----------|-------------|
| `sqrt(x)` | Square root |
| `abs(x)` | Absolute value |
| `ceil(x)` | Ceiling (round up) |
| `floor(x)` | Floor (round down) |
| `trunc(x)` | Truncate toward zero |
| `nearest(x)` | Round to nearest even (banker's rounding) |
| `min(a, b)` | Minimum of two values |
| `max(a, b)` | Maximum of two values |
| `copysign(x, y)` | Copy sign of y to x |

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

### Integer Builtins

| Function | Description |
|----------|-------------|
| `clz(x)` | Count leading zeros |
| `ctz(x)` | Count trailing zeros |
| `popcnt(x)` | Population count (count 1 bits) |

```ents
let n:u32 = 0b00001000
clz(n)                 // 28 (leading zeros)
ctz(n)                 // 3 (trailing zeros)
popcnt(n)              // 1 (number of 1 bits)
```

### Memory Builtins

| Function | Description |
|----------|-------------|
| `memory-size()` | Current memory size in pages (64KB each) |
| `memory-grow(n)` | Grow memory by n pages, returns previous size or -1 on failure |

```ents
let pages = memory-size()    // current page count
let old = memory-grow(1)     // grow by 1 page, returns old size
if old == -1 {
  // allocation failed
}
```

## Type Identifiers

User-defined type names must start with a capital letter. This distinguishes them from primitive types (`i32`, `f64`, etc.) and regular identifiers:

```ents
type Point = (x:f32, y:f32)      // OK: Point starts with capital
type point = (x:f32, y:f32)      // ERROR: type names must be capitalized

unique String = u8[]             // OK: String starts with capital
unique buffer = u8[]             // ERROR: type names must be capitalized
```

This convention allows the parser to distinguish type references from variable references without forward declarations:

```ents
func distance(a:Point, b:Point) -> f32   // Point is a type
let point = Point(1.0, 2.0)              // point is a variable, Point is a constructor
```

## Literals

### Integer Literals

```ents
42              // decimal, inferred as i32
0xFF            // hexadecimal
0b1010          // binary
0o755           // octal
0d1a            // dozenal (base 12): 1*12 + 10 = 22

42:i64          // explicit type annotation
255:u8          // explicit type annotation
```

Unsuffixed literals are "comptime" values that adapt to their context. When no context is available, they default to either `i32` or `i64` based on size.

### Float Literals

```ents
3.14            // inferred as f64
1.0e-10         // scientific notation
2.5:f32         // explicit type annotation
```

Float literals default to `f64`. Decimal-to-binary conversion is inherently lossy, so float literals accept the closest representable approximation.

### String Literals

```ents
"hello"           // type is u8[5/0], coerces to u8[/0], u8[5], or u8[]
"line1\nline2"    // escape sequences: \n \t \r \\ \"
'also a string'   // single quotes work too
```

Both single and double quoted strings are equivalent. String literals are stored in the data section with a null terminator. Their type is `u8[N/0]` - a comptime-known length that also guarantees null termination. This dual nature allows implicit coercion to:

- `u8[/0]` - null-terminated pointer (single i32)
- `u8[N]` - fixed-size array (single i32, length known at compile time)
- `u8[]` - runtime slice (i32 pointer + i32 length)

### Boolean Literals

```ents
true
false
```

Booleans are distinct from integers. No implicit truthiness - use explicit comparisons.  Under the hood they are represented as `u1` (0 and 1)

## Declarations

### Definitions

Compile-time literal substitution. The value must be a literal - it is textually substituted at each use site:

```ents
def prime32-1 = 2654435761
def prime32-2 = 2246822519
def max-size = 1024

// Using definitions
let hash:u32 = seed + prime32-1
let buffer:u8[max-size]
```

Definitions are inlined at compile time, they do not create runtime variables.

### Variables

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

### Functions

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

Functions can be called with positional or named arguments:

```ents
// Positional arguments (in declaration order)
add(1, 2)
divmod(17, 5)

// Named arguments (any order)
add(a: 1, b: 2)
divmod(b: 5, a: 17)

// Destructure return values
let (q, r) = divmod(17, 5)      // by position
let (q:, r:) = divmod(17, 5)    // by name (trailing colon)
let (q: quotient , r: remainder) = divmod(17, 5)    // with explicit names

```

### Inline Functions

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

### Exports

```ents
// Export function with internal name
export "add"
func add(a:i32, b:i32) -> i32 => a + b

// Export anonymous function (no internal name needed if not called internally)
export "hash"
func (data:u8[], seed:u32) -> u32 {
  // only accessible via export, no internal calls
}

// Export memory
export "mem" memory 1      // 1 page = 64KB

// Export global
export "counter" global counter:i32 = 0
```

### Imports

```ents
// Import function from host environment
import "env" "log" func log(msg:u8[/0])

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
func print(msg:u8[])
```

### Memory and Data

```ents
// Declare memory (pages of 64KB)
memory 1                   // 1 page
memory 2 16                // min 2 pages, max 16 pages

// Store data in linear memory
data 0 "Hello"             // string at offset 0
data 100 x"01 02 03 04"    // bytes at offset 100
```

## Control Flow

### Conditionals

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

### Loops

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

### Control Statements

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

## Type System

### Unified Value Model

Encantis has a unified model for compound values:

| Level | Description | Access |
|-------|-------------|--------|
| **Multiple values** | Base concept - zero or more values | positional |
| **Tuple** | Multiple values with indices | `.0`, `.1`, ... |
| **Struct** | Tuple with named fields | `.name` |
| **Slice** | Struct `(ptr:*T, len:u32)` | `.ptr`, `.len` |

Each level is a superset of the one above:

- All slices are structs (with fields `ptr` and `len`)
- All structs are tuples (fields have positions)
- All tuples are multiple values

This unification means the same patterns work everywhere:

```ents
// Function calls: positional or named
distance(p1, p2)              // positional
distance(a: p1, b: p2)        // named (any order)

// Function returns: destructure either way
let (d, a) = to_polar(point)  // by position
let (d:, a:) = to_polar(point)  // by name (trailing colon)

// Slices work like structs
let (ptr, len) = slice        // by position
let (ptr:, len:) = slice      // by name
```

The `let` keyword creates new bindings, `set` assigns to existing variables:

```ents
let (x:, y:) = point          // declares x and y (by name)
set (x:, y:) = other_point    // updates existing x and y
```

### Primitive Types

| Category | Types |
|----------|-------|
| Signed integers | `i8`, `i16`, `i32`, `i64` |
| Unsigned integers | `u8`, `u16`, `u32`, `u64` |
| Floating point | `f32`, `f64` |
| Boolean | `bool` |

**Note on `bool`:** Semantically equivalent to `u1`, but integers cannot be used where booleans are expected.

### Pointer Types

```ents
*T              // pointer to T
*u8             // byte pointer
*i32            // pointer to i32
```

All pointers are `i32` at the WASM level (32-bit address space).

### Array and Slice Types

Encantis has three array-like types:

| Syntax | Representation | Length | Use Case |
|--------|----------------|--------|----------|
| `T[]` | ptr + len | runtime, stored | General-purpose slices |
| `T[N]` | ptr only | compile-time N | Fixed-size buffers |
| `T[/0]` | ptr only | scan for null | C strings |

#### `T[]` — Runtime Slice

Fat pointer containing pointer and length. Slices behave like a struct `(ptr:*T, len:u32)`:

```ents
let data:u8[] = ...

// Property access
data.ptr        // extract pointer (*u8)
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

#### `T[N]` — Fixed-Size Array

Pointer with compile-time known length:

```ents
let buf:u8[64] = 0     // 64-byte buffer
buf.len                // comptime constant 64
```

#### `T[/0]` — Null-Terminated

Pointer to null-terminated data:

```ents
let cstr:u8[/0] = ...
cstr.len                 // runtime scan for null, O(n)
```

### Tuple Types

```ents
(i32, i32)           // pair of i32
(f64, f64, f64)      // triple of f64
```

### Type Aliases: Structural vs Unique

Encantis supports two kinds of type aliases with different matching semantics. All user-defined type names must start with a capital letter.

#### `type` — Structural Type

Structural types match any value with identical structure. No explicit cast needed:

```ents
type Point = (f32, f32)

func distance(a:Point, b:Point) -> f32 {
  // implementation
}

let p:(f32, f32) = (1.0, 2.0)
distance(p, (3.0, 4.0))            // OK: tuple matches Point structure

let q:(f32, f32, f32) = (1.0, 2.0, 3.0)
distance(q, p)                     // ERROR: (f32, f32, f32) is not (f32, f32)
```

The structure must be exactly identical - extra or missing fields are not allowed.

#### `unique` — Unique Type

Unique types require explicit casts even when the underlying structure is identical:

```ents
unique String = u8[]
unique Bytes = u8[]

func print(s:String) {
  // implementation
}

let data:u8[] = ...
print(data)                        // ERROR: u8[] is not String
print(String(data))                // OK: explicit cast

let b:Bytes = ...
print(b)                           // ERROR: Bytes is not String
print(String(b))                   // OK: explicit cast
```

Use `unique` when you want the compiler to enforce distinctions between semantically different values that happen to share the same representation.

### Struct Types

Structs are tuples with named fields, using the same `()` syntax:

```ents
type Point = (x:f32, y:f32)
type Rect = (origin:Point, size:(w:f32, h:f32))

unique Color = (r:u8, g:u8, b:u8, a:u8)
```

Like other type aliases, `type` creates structural types and `unique` creates nominal types.

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

#### By-Value vs By-Reference Passing

Struct parameters are passed by value—each field becomes a separate WASM argument:

```ents
type Point = (x:f32, y:f32)

// This function receives two f32 WASM parameters
func length(p:Point) -> f32 {
  return sqrt(p.x * p.x + p.y * p.y)
}

let p = Point(3.0, 4.0)
length(p)                  // passes two f32 values on the stack
length(Point(1.0, 2.0))    // also valid
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

### Uniform Function Call Syntax (UFCS)

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
func to_hex(data:u8[]) -> u8[] => ...

let n = 21
n.double()                 // 42

let bytes:u8[] = ...
bytes.to_hex()             // works on slices too
```

Note: There are no implicit built-in methods except for operators that already look like function calls (ex: `sqrt(n)` can be written as `n.sqrt()`). Slice properties like `slice.len` and `slice.ptr` are built-in field access, not method calls.

### Stack vs Memory Allocation

Encantis distinguishes between stack-allocated values (WASM locals) and memory-allocated values (linear memory):

| Declaration | Storage | Address |
|-------------|---------|---------|
| `let x:i32` | WASM local | None (no `&x`) |
| `let p:Point` | Multiple WASM locals | None |
| `let ptr:*Point` | Single WASM local (i32) | Points to memory |
| `let arr:u8[64]` | Linear memory | Has address |
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

Fixed-size arrays (`T[N]`) and globals are always memory-allocated and have addresses.

### WASM Type Mapping

| Encantis | WASM |
|----------|------|
| i8, i16, i32, u8, u16, u32, bool | i32 |
| i64, u64 | i64 |
| f32 | f32 |
| f64 | f64 |
| `*T` | i32 |
| `T[]` | i32, i32 (ptr, len) |
| `T[N]`, `T[/0]` | i32 (ptr only) |
| `(x:T1, y:T2, ...)` | flattened fields (one WASM value per field) |

## Type Conversions

### Implicit Widening

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

### Comptime Literal Promotion

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

### Type Errors

```ents
i32 + f32   // ERROR: i32 exceeds f32's mantissa
i32 + u32   // ERROR: mixed signedness, cast explicitly
i64 → i32   // ERROR: narrowing needs explicit cast
bool + i32  // ERROR: cast bool first
```

### Explicit Casts

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

## Operators

### Arithmetic

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

### Bitwise

| Operator | Description | Types |
|----------|-------------|-------|
| `&` | bitwise AND | integers |
| `\|` | bitwise OR | integers |
| `^` | bitwise XOR | integers |
| `<<` | shift left | integers |
| `>>` | shift right | integers |
| `<<<` | rotate left | integers |
| `>>>` | rotate right | integers |

### Comparison

| Operator | Description |
|----------|-------------|
| `<` | less than |
| `>` | greater than |
| `<=` | less or equal |
| `>=` | greater or equal |
| `==` | equal |
| `!=` | not equal |

All comparisons return `bool`.

### Assignment

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

### Compound Assignment

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

### Unary Operators

| Operator | Description |
|----------|-------------|
| `-x` | negation |
| `!x` | logical NOT (bool only) |
| `~x` | bitwise NOT |
| `x.*` | dereference |

For slice/array length and pointer extraction, use property access: `slice.len`, `slice.ptr`.

## Pointer Operations

### Arithmetic

| Expression | Result |
|------------|--------|
| `ptr + n` | offset forward by n bytes |
| `ptr - n` | offset backward by n bytes |
| `ptr - ptr` | byte distance between pointers |

### Indexing

```ents
let arr:*i32 = ...
arr[2]          // offset by 2 elements (8 bytes for i32)
(arr + 8).*     // equivalent to arr[2]
```

Note: `ptr + n` offsets by bytes, `ptr[n]` offsets by elements.

### Type-Punned Memory Access

Read or write memory as a specific type:

```ents
ptr.u32             // read 4 bytes as u32
ptr.u32 = value     // write u32
ptr.f64             // read 8 bytes as f64

// Compound types need parentheses
ptr.(MyStruct)
ptr.(u8[])
```

## Array Type Conversions

| From | To | How |
|------|----|-----|
| `T[]` | `*T` | `slice.ptr` |
| `T[]` | `u32` | `slice.len` |
| `T[]` | `(*T, u32)` | `(slice.ptr, slice.len)` or destructure |
| `T[N]` | `T[]` | implicit |
| `T[N]` | `*T` | `arr.ptr` |
| `T[/0]` | `*T` | `s.ptr` |
| `T[/0]` | `T[]` | `(s.ptr, s.len)` |
| `(*T, u32)` | `T[]` | implicit |
| `*T` | `T[]` | ERROR - needs length |

```ents
let arr:u8[16] = ...
let slice:u8[] = arr          // OK: implicit

let ptr:*u8 = ...
let slice:u8[] = ptr          // ERROR: need length
let slice:u8[] = (ptr, 64)    // OK: provide length

// Extract components from slice
let (ptr, len) = slice           // by position
let (ptr:, len:) = slice         // by name
```

## WASM Instruction Reference

### Widening (implicit)

| Conversion | Instruction |
|------------|-------------|
| i32 → i64 | i64.extend_i32_s / _u |
| i32 → f32 | f32.convert_i32_s / _u |
| i32 → f64 | f64.convert_i32_s / _u |
| i64 → f32 | f32.convert_i64_s / _u |
| i64 → f64 | f64.convert_i64_s / _u |
| f32 → f64 | f64.promote_f32 |

### Narrowing (explicit cast)

| Conversion | Instruction |
|------------|-------------|
| i64 → i32 | i32.wrap_i64 |
| f64 → f32 | f32.demote_f64 |
| f32 → i32 | i32.trunc_f32_s / _u |
| f64 → i32 | i32.trunc_f64_s / _u |
| f32 → i64 | i64.trunc_f32_s / _u |
| f64 → i64 | i64.trunc_f64_s / _u |

### Control Flow Instructions

| Encantis | WASM |
|----------|------|
| `if`/`elif`/`else` | `if`/`else`/`end` (nested) |
| `while { }` | `block`/`loop` + `br_if` |
| `loop { }` | `loop`/`end` |
| `break` | `br` (to enclosing block) |
| `break when` | `br_if` |
| `continue` | `br` (to loop head) |
| `continue when` | `br_if` (to loop head) |
| `return` | `return` |

## Potential Future Additions

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

### Enums and Sum Types

Tagged unions for representing values that can be one of several variants:

```ents
enum Option<T> {
  None
  Some(T)
}

enum Result<T, E> {
  Ok(T)
  Err(E)
}

enum State {
  Idle
  Running(progress:u32)
  Done(result:i32)
  Failed(code:u32, msg:u8[])
}
```

**Why:** Enables type-safe error handling, optional values, and state machines. Currently these patterns require manual tag fields and discipline. The compiler could enforce exhaustive matching.

### Match Expressions

Pattern matching for cleaner conditional logic:

```ents
match state {
  Idle => start()
  Running(p) => update_progress(p)
  Done(r) => handle_result(r)
  Failed(code, _) => log_error(code)
}

match value & 3 {
  0 => small_swap()
  2 => big_swap()
  _ => {}
}
```

**Why:** Replaces chains of `if`/`elif` with more readable, exhaustive matching. The compiler can warn about unhandled cases. Pairs naturally with enums.

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
comptime func generate_table() -> u8[256] {
  let table:u8[256]
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
func process_file(path:u8[/0]) -> Result {
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
