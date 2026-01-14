# Encantis Type System (Derived)

This document describes the type inference and type system of the Encantis language, derived from analysis of example files and documentation.

## Overview

Encantis uses a strong, static type system with type inference. While the compilation target (WebAssembly) has only four primitive types (`i32`, `i64`, `f32`, `f64`), Encantis extends this with a richer type system that provides:

- Signed/unsigned integer distinction
- Pointer types
- Slice and array types
- Struct and tuple types
- Type aliases and unique types
- Literal type coercion

## Core WASM Types

The underlying WebAssembly types:

| WASM Type | Encantis Types              |
|-----------|----------------------------|
| `i32`     | `i32`, `u32`, `u8`, `u16`, pointers |
| `i64`     | `i64`, `u64`               |
| `f32`     | `f32`                      |
| `f64`     | `f64`                      |

## Type Inference Rules

### Variable Initialization

When a variable is declared with an initializer but no type annotation, the type is inferred from the expression:

```ents
local x = 10              -- x: i32 (default integer type)
local y = 3.14            -- y: f64 (default float type)
local z = a + b           -- z: type of (a + b)
local ptr = data.ptr      -- ptr: type from property access
```

### Literal Types

Literal values have abstract types that can be coerced to concrete types:

#### Integer Literals

```ents
100                       -- Abstract Integer type
100:u32                   -- Concrete u32
100:i64                   -- Concrete i64
```

Integer literals:
- Default to `i32` when no context suggests otherwise
- Can be coerced to any integer type (`i32`, `u32`, `i64`, `u64`)
- Can be coerced to float types when passed to float-expecting functions

#### Float Literals

```ents
3.14                      -- Abstract Float type
3.14:f32                  -- Concrete f32
1f                        -- f32 literal (legacy syntax)
```

Float literals:
- Default to `f64` when no context suggests otherwise
- Can be coerced to `f32` or `f64`

#### String Literals

```ents
"Hello"                   -- Abstract String type
"Hello":[u8]              -- Byte slice (ptr, len pair)
"Hello":[u8/0]            -- Null-terminated string (ptr only)
```

String literals:
- Can be coerced to `[u8]` (slice with pointer and length)
- Can be coerced to `[u8/0]` (null-terminated, adds `\0` to data section)
- Can potentially be coerced to other string-like types (e.g., `Nibs`)

### Contextual Type Inference

Types are inferred from context in several ways:

#### Function Parameter Context

```ents
func process(data: [u8]) -> u32

local msg = "Hello"       -- msg is Abstract String
process(msg)              -- "Hello" coerced to [u8]
```

#### Assignment Context

```ents
local x: u64 = 100        -- 100 coerced to u64
h64 += (len as u64)       -- len coerced via explicit cast
```

#### Binary Operation Context

When two operands of different types are combined, the result type follows rules:

```ents
local a: i32 = 10
local b: u32 = 20
local c = a + b           -- Result type depends on operator and operands
```

### Named Return Value Inference

Functions with named return values infer their type from usage:

```ents
func xxh64 (...) -> (h64: u64)
  h64 = seed + prime64-5  -- h64 type established in signature
  h64 += len              -- Assignment verifies/coerces types
end
```

## Type Coercion

### Implicit Coercions

1. **Literal to Concrete**: Literals coerce to expected types
2. **Smaller to Larger**: Implicit widening may occur (context-dependent)
3. **Pointer Arithmetic**: `ptr + offset` keeps pointer type

### Explicit Coercions (Casts)

Use `as` for explicit type conversion:

```ents
len as u64                -- Extend i32 to i64
ptr as *u32               -- Cast pointer type
(ptr as *u8).*            -- Cast then dereference
```

### Memory View Casts

Reinterpret memory as different type without conversion:

```ents
local state-8 = state:[u8*48]    -- View [u32*12] as [u8*48]
```

This creates a new view of the same memory with different element type.

## Slice and Array Type System

### Slice Types `[T]`

A slice is a fat pointer consisting of two `i32` values:

```
[T] = (ptr: *T, len: u32)
```

Properties:
- `.ptr` - The pointer component (type `*T`)
- `.len` - The length component (type `u32`)
- `[i]` - Element access (type `T`)

The slice type carries the element type `T` which determines:
- Memory access width (`i32.load`, `i64.load`, `i32.load8_u`, etc.)
- Iteration step size
- Element type for `for..in` loops

### Fixed-Length Arrays `[T*N]`

Compile-time sized arrays:

```
[T*N] = *T   (pointer only, length known at compile time)
```

- Length `N` is part of the type, not stored at runtime
- Passed by reference (pointer to start)
- More efficient than slices when length is static

### Null-Terminated Arrays `[T/0]`

C-style strings:

```
[T/0] = *T   (pointer only, length determined by null terminator)
```

- Only stores pointer
- Length computed by iterating to find terminator

### Nested Arrays

```ents
[[u8]]        -- Slice of byte slices
              -- = (*[u8], len) where [u8] = (*u8, len)
              -- Total: (*(*u8, u32), u32)

[[u8*8]*4]    -- Fixed array of fixed arrays
              -- = *[u8*8] (single pointer, all sizes known)
```

## Tuple Type System

Tuples are ordered collections of heterogeneous types:

```ents
(i32, i32)         -- Two i32 values
(f32, f32, f32)    -- Three f32 values
(i32)              -- Single value (equivalent to i32)
()                 -- Unit type (void)
```

### Tuple Flattening

In WASM, tuples are flattened to multiple values:

```ents
func divmod(a: i32, b: i32) -> (i32, i32)
```

Compiles to:
```wat
(func $divmod (param i32 i32) (result i32 i32) ...)
```

### Tuple Element Access

```ents
point.1              -- First element (1-indexed)
point.2              -- Second element
```

### Tuple Destructuring

```ents
local (a, b) = (10, 20)
(x, y) = to_polar(r, theta)
```

## Struct Type System

Structs are named tuples with structural typing:

```ents
{ x: f32, y: f32 }           -- Struct type
{ x = 3.0, y = 5.0 }         -- Struct literal
```

### Structural Subtyping

A struct with more fields can be used where fewer fields are expected:

```ents
local point3d = { x = 1f, y = 2f, z = 3f }

func distance2d(p: { x: f32, y: f32 }) -> f32
  -- Only uses x and y

distance2d(point3d)          -- OK: z is ignored
```

The compiler extracts only the needed fields when passing to functions.

### Struct Destructuring

```ents
var { x, y } = point         -- Extract named fields
```

## Pointer Type System

Pointers carry the type they point to:

```ents
*u8              -- Pointer to byte
*u64             -- Pointer to 64-bit integer
*[u8]            -- Pointer to byte slice (rare)
*(u8, u16)       -- Pointer to tuple in memory
```

### Dereference Type Rules

```ents
ptr: *u32
ptr.*            -- Type: u32 (loads as i32.load)

ptr: *u8
ptr.*            -- Type: u8 (loads as i32.load8_u)

ptr: *u64
ptr.*            -- Type: u64 (loads as i64.load)
```

### Pointer Casting

```ents
(ptr as *u32).*              -- Cast changes load type
ptr as *u8                   -- Reinterpret pointer
```

## Function Type System

### Function Types

Functions have explicit parameter and return types:

```ents
(i32, i32) -> i32            -- Takes two i32, returns one
(a: f64, b: f64) -> (f64)    -- Named parameters
([u8]) -> ()                 -- Takes slice, returns nothing
```

### Function Pointer Types

```ents
local fn: (i32, i32) -> i32  -- Function pointer type
fn(1, 2)                     -- Indirect call via table
```

### Type Inference in Anonymous Functions

```ents
local add = (a, b) => a + b
-- Types of a, b inferred from usage context
```

## Type Aliases

### Interface Types (Non-unique)

Create interchangeable type aliases:

```ents
interface Point = (f32, f32)

local p: Point = (3.0, 4.0)  -- Same as (f32, f32)
```

`Point` and `(f32, f32)` are completely interchangeable.

### Unique Types

Create distinct types requiring explicit conversion:

```ents
type String = [u8]

local bytes: [u8] = "hello"
local str: String = String(bytes)    -- Must cast explicitly
```

Use cases:
- Prevent mixing semantically different values
- Game indices, user IDs, etc.
- Domain-specific type safety

## Type Inference Algorithm

Based on the `type-algorithm.md` documentation:

### 1. Gather Constraints

For each expression, gather type constraints:
- Literal constraints (can be multiple types)
- Variable references (must match declared type)
- Binary operations (operands must be compatible)
- Function calls (arguments must match parameters)

### 2. Unification

Resolve constraints by unification:
- Concrete types unify only with themselves
- Abstract literal types unify with compatible concrete types
- Tuples unify element-wise

### 3. Defaulting

When types remain ambiguous after unification:
- Integer literals default to `i32`
- Float literals default to `f64`
- String literals default based on context

### 4. Error on Ambiguity

If unification fails or ambiguity remains:
- Report type error
- Suggest adding type annotation

## Compile-Time Type Checking

Types are fully resolved at compile time:
- No runtime type information in generated WASM
- All memory access patterns determined statically
- Type-based optimizations (load widths, etc.) computed at compile time

## Memory Representation

### Primitives

| Type    | Size    | WASM Load         |
|---------|---------|-------------------|
| `i32`   | 4 bytes | `i32.load`        |
| `u32`   | 4 bytes | `i32.load`        |
| `i64`   | 8 bytes | `i64.load`        |
| `u64`   | 8 bytes | `i64.load`        |
| `f32`   | 4 bytes | `f32.load`        |
| `f64`   | 8 bytes | `f64.load`        |
| `u8`    | 1 byte  | `i32.load8_u`     |
| `u16`   | 2 bytes | `i32.load16_u`    |

### Compound Types

| Type         | Memory Representation          |
|--------------|-------------------------------|
| `[T]`        | Two `i32` locals (ptr, len)   |
| `[T*N]`      | Single `i32` local (ptr)      |
| `[T/0]`      | Single `i32` local (ptr)      |
| `(T1, T2)`   | Multiple locals, one per element |
| `{a:T1, b:T2}` | Multiple locals, one per field |
| `*T`         | Single `i32` local            |

## Type-Specific Operations

### Slice Operations

```ents
slice.len                    -- Access length (u32)
slice.ptr                    -- Access pointer (*T)
slice[i]                     -- Element access (T)
slice.ptr += n               -- Advance pointer
slice.len -= n               -- Reduce length
```

### Fixed Array Operations

```ents
array[i]                     -- Element access (T)
array.fill(value)            -- Fill all elements
array.ptr                    -- Get pointer to start
```

### Comparison by Type

Comparison operators (`<`, `>`, `<=`, `>=`) choose signed vs unsigned operations based on type:

```ents
local a: i32, b: i32
a < b                        -- i32.lt_s (signed)

local x: u32, y: u32
x < y                        -- i32.lt_u (unsigned)
```
