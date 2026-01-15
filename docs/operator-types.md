# Operator Type Promotion

## Core Rules

1. **Implicit conversion only when lossless.** Widening within same signedness is safe. Integer→float only when mantissa can hold all values. Narrowing requires explicit cast.

2. **Mixed types widen to common type.** Compiler finds smallest type holding both without loss, or errors.

3. **Ambiguous cases error.** Mixed signedness (`i32 + u32`) requires explicit cast.

## Numeric Types

| Category | Types |
|----------|-------|
| Signed integers | `i8`, `i16`, `i32`, `i64` |
| Unsigned integers | `u8`, `u16`, `u32`, `u64` |
| Floats | `f32`, `f64` |
| Other | `bool`, pointers (i32), slices (ptr+len) |

**Note on `bool`:** Semantically equivalent to `u1`, but integers cannot be used where booleans are expected. No implicit truthiness - use explicit comparisons (`x != 0`).

### Future Considerations

Pending operator overloading or built-in support:

- **decimal** - `(mantissa: i64, exponent: i16)` for exact decimal arithmetic
- **rational** - `(numerator: i64, denominator: i64)` for exact fractions

## WASM Representation

| Encantis Type | WASM Type |
|---------------|-----------|
| i8, i16, i32, u8, u16, u32, bool | i32 |
| i64, u64 | i64 |
| f32 | f32 |
| f64 | f64 |

## Safe Promotions (Implicit)

### Integer Widening

```
i8 → i16 → i32 → i64
u8 → u16 → u32 → u64
```

Smaller type widens to larger. WASM uses `i64.extend_i32_s` (signed) or `i64.extend_i32_u` (unsigned).

### Float Widening

`f32 → f64` via `f64.promote_f32`

### Integer to Float

Only when mantissa can represent all values:

| Float | Safe integer types | Mantissa bits |
|-------|-------------------|---------------|
| f32 | i8, u8, i16, u16 | 24 |
| f64 | i8, u8, i16, u16, i32, u32 | 53 |

## Comptime Literals

### Integer Literals

Untyped literals check actual value, not type:

```encantis
let x: f32 = 1.0 + 42        // OK: 42 fits in f32 mantissa
let y: f32 = 1.0 + 16777216  // OK: 2^24 is max exact integer
let z: f32 = 1.0 + 16777217  // ERROR: exceeds f32 precision
```

Exact ranges: f32 ±2²⁴, f64 ±2⁵³

### Float Literals

Decimal→binary is inherently lossy, so float literals accept closest approximation:

```encantis
let x: f32 = 1.3       // OK: closest f32 approximation
let y: f64 = 1.3       // OK: closest f64 approximation
let z = 1.3            // Inferred as f64

let a: f32 = z         // ERROR: typed f64 → f32 needs cast
let b = x + 1.5        // OK: 1.5 adapts to f32
```

Once typed, normal promotion rules apply.

## Type Errors

### Lossy Integer to Float

```
i32 + f32  → ERROR    // i32 exceeds f32's 24-bit mantissa
i64 + f64  → ERROR    // i64 exceeds f64's 53-bit mantissa
```

### Mixed Signedness

```
i32 + u32  → ERROR    // ambiguous, cast explicitly
```

### Narrowing

```
i64 → i32  → ERROR    // explicit cast required
f64 → f32  → ERROR
```

### Boolean

```
bool + i32  → ERROR   // cast bool first
```

## Explicit Casts

Two syntaxes are supported:

```encantis
// Function-style (binds tightly)
i32(x)              // primitive
(*u8)(ptr)          // pointer
([u8])(ptr)         // slice
(MyStruct)(data)    // struct

// as-style (lower precedence than arithmetic)
x as i32
ptr as *u8
ptr as [u8]
```

Function-style binds tightly like a call; `as` requires parens in expressions:

```encantis
i32(x) + 1      // cast then add
x as i32 + 1    // parses as: x as (i32 + 1) — ERROR
(x as i32) + 1  // cast then add
```

Casts are required for:
- Narrowing (larger → smaller type)
- Lossy integer→float (when mantissa can't hold all values)
- Mixed signedness operations
- Bool→integer (`i32(flag)`)

## Type-Punned Memory Access

Read or write memory at a pointer as a specific type:

```encantis
ptr.u32             // read 4 bytes as u32
ptr.u32 = value     // write u32 to 4 bytes
ptr.f64             // read 8 bytes as f64
ptr.f64 = value     // write f64 to 8 bytes
```

Equivalent to `(ptr as *T).*` but more ergonomic for DataView-style parsing:

```encantis
// Walking through a byte buffer
local ptr: *u8 = data.ptr
let header = ptr.u32      // read header as u32
ptr += 4
ptr.f64 = 3.14            // write f64 value
ptr += 8
```

For primitives, the type name is used directly. For compound types, wrap in parentheses:

```encantis
ptr.u32           // primitive shorthand
ptr.(MyStruct)    // read/write struct
ptr.([u8])        // read/write slice (ptr + len)
ptr.((i32, f64))  // read/write tuple
```

## Pointer Arithmetic

### Allowed

| Left | Op | Right | Result |
|------|----|-------|--------|
| ptr  | +  | int   | ptr (offset forward) |
| ptr  | -  | int   | ptr (offset backward) |
| ptr  | -  | ptr   | int (byte distance) |

### Errors

| Expression | Error |
|------------|-------|
| `int + ptr` | use `ptr + int` |
| `ptr + ptr` | meaningless |
| `ptr * n` | only +/- allowed |

### Offset Scaling

| Syntax | Scaling | Notes |
|--------|---------|-------|
| `ptr + n` | bytes | raw byte offset |
| `ptr[n]` | elements | scaled by element size |

```encantis
let arr: *i32 = ...
arr[2]          // offset 8 bytes (2 × sizeof(i32))
(arr + 2).*     // offset 2 bytes (wrong!)
(arr + 8).*     // equivalent to arr[2]
```

## Array and Slice Types

Encantis has three array-like types, each with different compile-time vs runtime tradeoffs:

### Type Summary

| Syntax | WASM Representation | Length | Use Case |
|--------|---------------------|--------|----------|
| `[T]` | `(i32, i32)` ptr+len | runtime, stored | General-purpose slices |
| `[T*N]` | `i32` ptr only | comptime constant N | Fixed-size buffers |
| `[T/0]` | `i32` ptr only | runtime, scan for null | C strings, null-terminated data |

### `[T]` — Runtime Slice

Fat pointer containing both pointer and length:

```
{ ptr: *T, len: u32 }
```

| Operator | Result | Notes |
|----------|--------|-------|
| `&s` | `*T` | extract underlying pointer |
| `#s` | `u32` | stored length (O(1)) |
| `s[i]` | `T` | element access |

### `[T*N]` — Fixed-Size Array

Just a pointer at runtime, but compiler knows length N at compile time:

```
*T  (with comptime length N)
```

| Operator | Result | Notes |
|----------|--------|-------|
| `&arr` | `*T` | the pointer itself |
| `#arr` | `u32` | comptime constant N |
| `arr[i]` | `T` | element access |

Useful for stack-allocated buffers, struct fields with known sizes, and WASM linear memory layouts.

### `[T/0]` — Null-Terminated

Just a pointer at runtime, compiler knows to look for null terminator:

```
*T  (null-terminated)
```

| Operator | Result | Notes |
|----------|--------|-------|
| `&s` | `*T` | the pointer itself |
| `#s` | `u32` | runtime scan for null (O(n)) |
| `s[i]` | `T` | element access (no bounds check) |

Used for C-style strings and interop with null-terminated APIs.

### Operators on All Array Types

| Operator | Result | Notes |
|----------|--------|-------|
| `&` | `*T` | underlying pointer |
| `#` | `u32` | length (comptime for `[T*N]`, scan for `[T/0]`) |
| `[i]` | `T` (place) | element access |

### Type Conversions

| From | To | Conversion |
|------|----|------------|
| `[T]` | `*T` | `&slice` — extract pointer |
| `[T*N]` | `[T]` | implicit — length becomes runtime value |
| `[T*N]` | `*T` | `&arr` — just the pointer |
| `[T/0]` | `*T` | `&s` — just the pointer |
| `[T/0]` | `[T]` | `(ptr, #s)` — must compute length |
| `(*T, uint)` | `[T]` | implicit — uint must widen to u32 |
| `*T` | `[T]` | ERROR — requires length |
| `*T` | `[T*N]` | explicit cast with known N |
| `*T` | `[T/0]` | explicit cast (assert null-terminated) |

```encantis
let slice: [u8] = ...
let ptr: *u8 = &slice          // OK: extract pointer

let arr: [u8*16] = ...
let slice: [u8] = arr          // OK: fixed array → slice

let cstr: [u8/0] = ...
let slice: [u8] = (&cstr, #cstr)  // OK: compute length

let ptr: *u8 = ...
let slice: [u8] = ptr          // ERROR: need length
let slice: [u8] = (ptr, 64)    // OK: tuple → slice
```

## Operator Categories

| Category | Operators | Types | Notes |
|----------|-----------|-------|-------|
| Arithmetic | `+` `-` `*` `/` | all numeric | div_s/div_u by signedness |
| Remainder | `%` | integers | rem_s/rem_u |
| Bitwise | `&` `\|` `^` | integers | |
| Shift | `<<` `>>` | integers | shr_s (signed) / shr_u (unsigned) |
| Rotate | `<<<` `>>>` | integers | |
| Comparison | `<` `>` `<=` `>=` `==` `!=` | all numeric | result is bool |

## WASM Conversion Reference

### Widening (implicit)

| Conversion | Instruction |
|------------|-------------|
| i32 → i64 | i64.extend_i32_s / _u |
| i32 → f32 | f32.convert_i32_s / _u |
| i32 → f64 | f64.convert_i32_s / _u |
| i64 → f32 | f32.convert_i64_s / _u |
| i64 → f64 | f64.convert_i64_s / _u |
| f32 → f64 | f64.promote_f32 |

### Narrowing (explicit cast required)

| Conversion | Instruction |
|------------|-------------|
| i64 → i32 | i32.wrap_i64 |
| f64 → f32 | f32.demote_f64 |
| f32 → i32 | i32.trunc_f32_s / _u |
| f64 → i32 | i32.trunc_f64_s / _u |
| f32 → i64 | i64.trunc_f32_s / _u |
| f64 → i64 | i64.trunc_f64_s / _u |
