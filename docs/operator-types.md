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

## Slices

Fat pointer: `{ ptr: *T, len: i32 }`

### Operators

| Operator | Result | Notes |
|----------|--------|-------|
| `&s` | `*T` | underlying pointer |
| `#s` | `i32` | length |
| `s[i]` | `T` (place) | bounds-checked |

`&` on a place gives its address; on a slice gives its pointer. `#` also works on arrays (comptime constant).

### Raw vs Checked Access

```encantis
s[i]        // bounds-checked, traps if i >= #s
(&s)[i]     // raw pointer, no check
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
