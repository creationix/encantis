# Encantis Language Reference

Encantis is a systems programming language that compiles to WebAssembly. It provides direct memory control, explicit types, and zero-cost abstractions while generating compact, efficient WASM modules.

## Sample Programs

### Hello World

```ents
export "mem" memory 1

-- Import JavaScript console.log
import "env" "log" func log(msg: [u8])

export "main"
func main()
  -- Log "Hello, World!" to console
  -- JavaScript host will receive the string pointer and length and read from linear memory
  log("Hello, World!\n")
end
```

### Fibonacci

```ents
export "fib"
func fib(n: i32) -> i32
  if n < 2 then
    return n
  end
  return fib(n - 1) + fib(n - 2)
end
```

### Sum Array

```ents
-- Named return value, for..in iterator over slice
func sum(arr: [i32]) -> (total: i32)
  total = 0
  for elem in arr do
    total += elem
  end
end
```

Named return values are declared in the signature and implicitly returned. The `for..in` loop iterates over elements when given an array or slice.

## Comments

```ents
-- Single line comment (Lua style)
```

## Literals

### Integer Literals

```ents
42              -- decimal, inferred as i32
0xFF            -- hexadecimal
0b1010          -- binary
0o755           -- octal

42:i64          -- explicit type annotation
255:u8          -- explicit type annotation
```

Unsuffixed literals are "comptime" values that adapt to their context. When no context is available, they default to either `i32` or `i64` based on size.

### Float Literals

```ents
3.14            -- inferred as f64
1.0e-10         -- scientific notation
2.5:f32         -- explicit type annotation
```

Float literals default to `f64`. Decimal-to-binary conversion is inherently lossy, so float literals accept the closest representable approximation.

### String Literals

```ents
"hello"           -- type is [u8*5/0], coerces to [u8/0], [u8*5], or [u8]
"line1\nline2"    -- escape sequences: \n \t \r \\ \"
```

String literals are stored in the data section with a null terminator. Their type is `[u8*N/0]` - a comptime-known length that also guarantees null termination. This dual nature allows implicit coercion to:

- `[u8/0]` - null-terminated pointer (single i32)
- `[u8*N]` - fixed-size array (single i32, length known at compile time)
- `[u8]` - runtime slice (i32 pointer + i32 length)

### Boolean Literals

```ents
true
false
```

Booleans are distinct from integers. No implicit truthiness - use explicit comparisons.  Under the hood they are represented as `u1` (0 and 1)

## Declarations

### Variables

```ents
-- Immutable binding (must be initialized)
let x: i32 = 42
let y = 3.14         -- type inferred as f64

-- Mutable local variable
local count: i32 = 0
local ptr: *u8       -- uninitialized

-- Global variable
global total: i32 = 0
```

### Functions

```ents
-- Basic function
func add(a: i32, b: i32) -> i32
  return a + b
end

-- No return type (void)
func greet()
  log("hello")
end

-- Expression body (single expression, implicit return)
func square(x: i32) -> i32 => x * x

-- Named return value (implicitly returned at end)
func double(x: i32) -> (result: i32)
  result = x * 2
end

-- Multiple return values
func divmod(a: i32, b: i32) -> (q: i32, r: i32)
  q = a / b
  r = a % b
end
```

Named return values are declared in the signature with `-> (name: type)`. They act as pre-declared locals and are implicitly returned when the function ends.

### Exports

```ents
-- Export function
export "add"
func add(a: i32, b: i32) -> i32 => a + b

-- Export memory
export "mem" memory 1      -- 1 page = 64KB

-- Export global
export "counter" global counter: i32 = 0
```

### Imports

```ents
-- Import function from host environment
import "env" "log" func log(msg: [u8/0])

-- Import memory
import "env" "memory" memory 1
```

### Memory and Data

```ents
-- Declare memory (pages of 64KB)
memory 1                   -- 1 page
memory 2 16                -- min 2 pages, max 16 pages

-- Store data in linear memory
data 0 "Hello"             -- string at offset 0
data 100 [1, 2, 3, 4]      -- bytes at offset 100
```

## Control Flow

### Conditionals

```ents
if condition then
  -- body
end

if condition then
  -- body
else
  -- alternative
end

if cond1 then
  -- first case
elif cond2 then
  -- second case
elif cond3 then
  -- third case
else
  -- default
end
```

The `then` keyword is required. All branches share a single `end`.

Conditions must be boolean - no implicit truthiness:

```ents
if x then         -- ERROR: x must be bool
if x != 0 then    -- OK: explicit comparison
if flag then      -- OK: flag is bool
```

### Loops

```ents
while condition do       -- condition checked before each iteration
  -- body
end

for i in n do            -- iterate 0 to n-1
  process(i)
end

for elem in arr do       -- iterate over array/slice elements
  process(elem)
end

for i, elem in arr do    -- iterate with index
  process(i, elem)
end

loop                     -- infinite loop
  -- body
end
```

### Control Statements

All control statements support a `when` suffix for conditional execution:

```ents
break                    -- exit innermost loop
break when cond          -- exit if condition is true

continue                 -- skip to next iteration
continue when cond       -- skip if condition is true

return                   -- return from function (void)
return value             -- return with value
return value when cond   -- return if condition is true
```

The `when` form is equivalent to wrapping in `if cond then ... end`.

## Type System

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
*T              -- pointer to T
*u8             -- byte pointer
*i32            -- pointer to i32
```

All pointers are `i32` at the WASM level (32-bit address space).

### Array and Slice Types

Encantis has three array-like types:

| Syntax | Representation | Length | Use Case |
|--------|----------------|--------|----------|
| `[T]` | ptr + len | runtime, stored | General-purpose slices |
| `[T*N]` | ptr only | compile-time N | Fixed-size buffers |
| `[T/0]` | ptr only | scan for null | C strings |

#### `[T]` — Runtime Slice

Fat pointer containing pointer and length:

```ents
let data: [u8] = ...
&data           -- extract pointer (*u8)
#data           -- get length (u32), O(1)
data[i]         -- element access
```

#### `[T*N]` — Fixed-Size Array

Pointer with compile-time known length:

```ents
local buf: [u8*64] = 0    -- 64-byte buffer
#buf                       -- comptime constant 64
```

#### `[T/0]` — Null-Terminated

Pointer to null-terminated data:

```ents
let cstr: [u8/0] = ...
#cstr                      -- runtime scan for null, O(n)
```

### Tuple Types

```ents
(i32, i32)           -- pair of i32
(f64, f64, f64)      -- triple of f64
```

### Type Aliases: Structural vs Unique

Encantis supports two kinds of type aliases with different matching semantics. All user-defined type names must start with a capital letter.

#### `type` — Structural Type

Structural types match any value with identical structure. No explicit cast needed:

```ents
type Point = (f32, f32)

func distance(a: Point, b: Point) -> f32
  -- implementation
end

local p: (f32, f32) = (1.0, 2.0)
distance(p, (3.0, 4.0))            -- OK: tuple matches Point structure

local q: (f32, f32, f32) = (1.0, 2.0, 3.0)
distance(q, p)                     -- ERROR: (f32, f32, f32) is not (f32, f32)
```

The structure must be exactly identical - extra or missing fields are not allowed.

#### `unique` — Unique Type

Unique types require explicit casts even when the underlying structure is identical:

```ents
unique String = [u8]
unique Bytes = [u8]

func print(s: String)
  -- implementation
end

local data: [u8] = ...
print(data)                        -- ERROR: [u8] is not String
print(String(data))                -- OK: explicit cast

local b: Bytes = ...
print(b)                           -- ERROR: Bytes is not String
print(String(b))                   -- OK: explicit cast
```

Use `unique` when you want the compiler to enforce distinctions between semantically different values that happen to share the same representation.

### WASM Type Mapping

| Encantis | WASM |
|----------|------|
| i8, i16, i32, u8, u16, u32, bool | i32 |
| i64, u64 | i64 |
| f32 | f32 |
| f64 | f64 |
| `*T` | i32 |
| `[T]` | i32, i32 (ptr, len) |
| `[T*N]`, `[T/0]` | i32 (ptr only) |

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
let x: f32 = 1.0 + 42        -- OK: 42 fits in f32 mantissa
let y: f32 = 1.0 + 16777216  -- OK: 2^24 is max exact integer
let z: f32 = 1.0 + 16777217  -- ERROR: exceeds f32 precision
```

Once a value has a concrete type, normal promotion rules apply:

```ents
let z = 1.3            -- inferred as f64
let a: f32 = z         -- ERROR: f64 → f32 needs explicit cast
```

### Type Errors

```ents
i32 + f32   -- ERROR: i32 exceeds f32's mantissa
i32 + u32   -- ERROR: mixed signedness, cast explicitly
i64 → i32   -- ERROR: narrowing needs explicit cast
bool + i32  -- ERROR: cast bool first
```

### Explicit Casts

Two syntaxes:

```ents
-- Function-style (binds tightly)
i32(x)
f64(value)
(*u8)(ptr)

-- as-style (lower precedence)
x as i32
ptr as *u8
```

Function-style binds like a call; `as` requires parens in expressions:

```ents
i32(x) + 1      -- cast then add
x as i32 + 1    -- ERROR: parses as x as (i32 + 1)
(x as i32) + 1  -- OK: cast then add
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
x = 42                   -- simple variable assignment
arr[i] = value           -- indexed assignment
ptr.* = value            -- dereference assignment
ptr.u32 = value          -- type-punned memory write
(a, b) = divmod(10, 3)   -- tuple destructuring
```

Assignment targets (lvalues) can be:

| Target | Description |
|--------|-------------|
| `name` | Local or global variable |
| `arr[i]` | Array/slice element |
| `ptr.*` | Dereferenced pointer |
| `ptr.T` | Type-punned memory location |
| `(a, b, ...)` | Tuple destructuring |

Tuple destructuring unpacks multiple values in a single assignment:

```ents
(q, r) = divmod(17, 5)   -- q = 3, r = 2
(x, y) = (y, x)          -- swap values
(ptr, len) = slice       -- extract components from multi-value types
```

Any type with multiple underlying values can be destructured (slices, tuples, etc).

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

```ents
count += 1               -- increment variable
arr[i] += delta          -- modify array element
ptr.* ^= mask            -- XOR through pointer
```

### Unary Operators

| Operator | Description |
|----------|-------------|
| `-x` | negation |
| `!x` | logical NOT (bool only) |
| `~x` | bitwise NOT |
| `&x` | address-of (pointer) |
| `#x` | length (arrays/slices) |
| `x.*` | dereference |

## Pointer Operations

### Arithmetic

| Expression | Result |
|------------|--------|
| `ptr + n` | offset forward by n bytes |
| `ptr - n` | offset backward by n bytes |
| `ptr - ptr` | byte distance between pointers |

### Indexing

```ents
let arr: *i32 = ...
arr[2]          -- offset by 2 elements (8 bytes for i32)
(arr + 8).*     -- equivalent to arr[2]
```

Note: `ptr + n` offsets by bytes, `ptr[n]` offsets by elements.

### Type-Punned Memory Access

Read or write memory as a specific type:

```ents
ptr.u32             -- read 4 bytes as u32
ptr.u32 = value     -- write u32
ptr.f64             -- read 8 bytes as f64

-- Compound types need parentheses
ptr.(MyStruct)
ptr.([u8])
```

## Array Type Conversions

| From | To | How |
|------|----|-----|
| `[T]` | `*T` | `&slice` |
| `[T*N]` | `[T]` | implicit |
| `[T*N]` | `*T` | `&arr` |
| `[T/0]` | `*T` | `&s` |
| `[T/0]` | `[T]` | `(&s, #s)` |
| `(*T, uint)` | `[T]` | implicit |
| `*T` | `[T]` | ERROR - needs length |

```ents
let arr: [u8*16] = ...
let slice: [u8] = arr          -- OK: implicit

let ptr: *u8 = ...
let slice: [u8] = ptr          -- ERROR: need length
let slice: [u8] = (ptr, 64)    -- OK: provide length
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
| `if`/`elif`/`else`/`end` | `if`/`else`/`end` (nested) |
| `while`/`do`/`end` | `block`/`loop` + `br_if` |
| `loop`/`end` | `loop`/`end` |
| `break` | `br` (to enclosing block) |
| `break when` | `br_if` |
| `continue` | `br` (to loop head) |
| `continue when` | `br_if` (to loop head) |
| `return` | `return` |
