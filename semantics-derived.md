# Encantis Language Semantics (Derived)

This document provides a comprehensive semantic specification of the Encantis programming language, derived from analysis of example files and documentation. Encantis is a systems programming language that compiles to WebAssembly Text Format (WAT).

## Table of Contents

1. [Design Philosophy](#design-philosophy)
2. [Module Structure](#module-structure)
3. [Declarations](#declarations)
4. [Expressions](#expressions)
5. [Statements](#statements)
6. [Control Flow](#control-flow)
7. [Memory Model](#memory-model)
8. [Type System](#type-system)
9. [Compilation Model](#compilation-model)

---

## Design Philosophy

Encantis is designed with the following goals:

1. **Direct WASM Mapping**: Language constructs map closely to WebAssembly primitives
2. **Zero-Cost Abstractions**: Type system features have no runtime overhead
3. **Explicit Control**: Memory layout and operations are explicit and predictable
4. **Modern Syntax**: Readable syntax with conveniences like type inference and destructuring
5. **Safety Through Types**: Compile-time type checking prevents common errors

---

## Module Structure

An Encantis module corresponds to a WebAssembly module and consists of:

### Top-Level Elements

```ents
-- 1. Imports (functions, memories, globals)
import "module" "name" func signature

-- 2. Memory declarations
memory N
export "name" memory N

-- 3. Global declarations
global name = value:type
global mut name:type = value

-- 4. Data sections
data offset (...)

-- 5. Type definitions
interface Name = Type
type Name = Type

-- 6. Constant/macro definitions
define name = value
define name(params) = expr

-- 7. Function definitions
func name (params) -> return
  body
end
```

### Module Compilation

A module compiles to a WASM module containing:
- Type section (function signatures)
- Import section
- Function section
- Table section (for indirect calls)
- Memory section
- Global section
- Export section
- Element section (function table entries)
- Data section (static data)
- Code section (function bodies)

---

## Declarations

### Local Variables

**Syntax:**
```ents
local name: Type
local name: Type = expression
local name = expression
```

**Semantics:**
- Declares a local variable within a function scope
- Variables are mutable by default
- Type can be inferred from initializer
- Uninitialized variables have undefined values (must be assigned before use)

**Compilation:**
```wat
(local $name type)
(local.set $name expression)
```

### Global Variables

**Syntax:**
```ents
global name = value:type          -- Immutable
global mut name:type = value      -- Mutable
```

**Semantics:**
- Declares a module-level global
- Immutable globals must be initialized with constant expressions
- Mutable globals can be modified during execution

**Compilation:**
```wat
(global $name type (type.const value))        -- Immutable
(global $name (mut type) (type.const value))  -- Mutable
```

### Compile-Time Definitions

**Syntax:**
```ents
define name = value
define name:type = value
define name(params) = expression
```

**Semantics:**
- Evaluated at compile time
- `define` without parameters creates a named constant
- `define` with parameters creates a macro (inline expansion)
- Not present in generated WASM

---

## Expressions

### Literals

| Literal Type | Examples | Semantics |
|-------------|----------|-----------|
| Integer | `42`, `0xFF`, `100:u64` | Abstract integer, coerced by context |
| Float | `3.14`, `1.0:f32` | Abstract float, coerced by context |
| String | `"hello"`, `"hi":[u8]` | Inserted into data section |

**Integer Literal Evaluation:**
1. If type annotation present, use that type
2. If used where specific type expected, coerce to that type
3. Otherwise, default to `i32`

**String Literal Evaluation:**
1. String bytes inserted into linear memory (data section)
2. For `[u8]`: Returns `(ptr, len)` tuple
3. For `[u8/0]`: Appends null byte, returns `ptr` only

### Operators

**Arithmetic (all numeric types):**
```
a + b    →    type.add
a - b    →    type.sub
a * b    →    type.mul
a / b    →    type.div_s (signed) or type.div_u (unsigned)
a % b    →    type.rem_s (signed) or type.rem_u (unsigned)
```

**Bitwise (integer types):**
```
a & b    →    type.and
a | b    →    type.or
a ^ b    →    type.xor
~a       →    type.xor (with -1)
a << b   →    type.shl
a >> b   →    type.shr_s (signed) or type.shr_u (unsigned)
a <<< b  →    type.rotl
a >>> b  →    type.rotr
```

**Comparison (returns i32: 0 or 1):**
```
a == b   →    type.eq
a != b   →    type.ne
a < b    →    type.lt_s or type.lt_u
a > b    →    type.gt_s or type.gt_u
a <= b   →    type.le_s or type.le_u
a >= b   →    type.ge_s or type.ge_u
```

**Logical:**
```
a and b  →    i32.and (after converting to i32)
a or b   →    i32.or (after converting to i32)
not a    →    i32.eqz
```

### Ternary Expression

**Syntax:**
```ents
condition ? true_expr : false_expr
```

**Semantics:**
- Evaluates condition
- Returns `true_expr` if non-zero, `false_expr` otherwise
- Both branches must have compatible types

**Compilation:**
```wat
(if (result type)
  condition
  (then true_expr)
  (else false_expr))
```

### Type Cast

**Syntax:**
```ents
expression as Type
```

**Semantics:**
- Converts value to target type
- For numeric types: may extend, truncate, or reinterpret
- For pointer types: reinterprets the address

**Compilation examples:**
```
i32 as i64    →    i64.extend_i32_s or i64.extend_i32_u
i64 as i32    →    i32.wrap_i64
f32 as f64    →    f64.promote_f32
*u8 as *u32   →    (no-op, just type change)
```

### Memory View Cast

**Syntax:**
```ents
value:[Type]
```

**Semantics:**
- Creates a new view of memory with different type interpretation
- No runtime conversion, just reinterpretation
- Common use: viewing `[u32*12]` as `[u8*48]`

### Property Access

**Syntax:**
```ents
expr.property
expr.N          -- Tuple: 1-indexed
```

**Semantics:**

For slices `[T]`:
```ents
slice.ptr       -- Returns pointer component (*T, as i32)
slice.len       -- Returns length component (u32)
```

For tuples `(T1, T2, ...)`:
```ents
tuple.1         -- First element
tuple.2         -- Second element
```

For structs `{a: T1, b: T2}`:
```ents
struct.a        -- Named field access
struct.b
```

### Array/Slice Indexing

**Syntax:**
```ents
array[index]
```

**Semantics:**
- For `[T]`: `ptr + index * sizeof(T)` then load
- For `[T*N]`: `ptr + index * sizeof(T)` then load (no bounds check)
- No runtime bounds checking (by design, for performance)

**Compilation:**
```wat
-- For [u8] indexed by i
(i32.load8_u (i32.add (local.get $ptr) (local.get $i)))

-- For [u32] indexed by i
(i32.load (i32.add (local.get $ptr) (i32.mul (local.get $i) (i32.const 4))))
```

### Pointer Dereference

**Syntax:**
```ents
ptr.*           -- Load value at pointer
ptr.T           -- Load as specific type T
```

**Semantics:**
- Loads from memory at pointer address
- Load width determined by pointer type
- Can specify explicit type for type-punning

### Function Calls

**Syntax:**
```ents
function(arg1, arg2, ...)
function(arg1 arg2 ...)    -- Space-separated also valid
```

**Semantics:**
- Arguments evaluated left-to-right
- Arguments pushed to stack
- Call instruction executed
- Results left on stack

**Compilation:**
```wat
(call $function arg1 arg2 ...)
```

### Pipe Operator

**Syntax:**
```ents
value |> function(%, other_args)
```

**Semantics:**
- `%` placeholder receives the piped value
- Allows chaining transformations

**Equivalent to:**
```ents
function(value, other_args)
```

---

## Statements

### Assignment

**Syntax:**
```ents
variable = expression
variable op= expression      -- Compound: +=, -=, *=, etc.
```

**Semantics:**
- Evaluates right-hand side
- Stores result in variable
- For compound assignment: `x op= y` ≡ `x = x op y`

### Tuple Destructuring Assignment

**Syntax:**
```ents
(a, b) = (expr1, expr2)
(a, b) = function()          -- Multiple return values
```

**Semantics:**
- Right side evaluated fully before assignment
- Enables atomic swap: `(a, b) = (b, a)`

**Compilation (for swap):**
```wat
;; Save both values
(local.get $a)
(local.get $b)
;; Assign in reverse order (stack is LIFO)
(local.set $a)
(local.set $b)
```

### Return

**Syntax:**
```ents
return
return expression
return expression when condition
```

**Semantics:**
- Exits function, returning value(s) to caller
- Conditional return only executes if condition is true
- Named return values are returned implicitly at function end

### Expression Statements

Any expression can be a statement; its value is discarded:

```ents
function()      -- Call for side effects
ptr += 8        -- Compound assignment
```

---

## Control Flow

### If Statement

**Syntax:**
```ents
if condition then
  body
end

if condition then
  then_body
else
  else_body
end

if cond1 then
  body1
elif cond2 then
  body2
else
  body3
end
```

**Semantics:**
- Condition evaluated as i32 (0 = false, non-zero = true)
- Only one branch executed
- `elif` is syntactic sugar for nested if/else

**Compilation:**
```wat
(if condition
  (then body)
  (else other_body))
```

### While Loop

**Syntax:**
```ents
while condition do
  body
end
```

**Semantics:**
- Condition checked before each iteration
- Loop exits when condition is false (zero)

**Compilation:**
```wat
(block $exit
  (loop $continue
    (br_if $exit (i32.eqz condition))
    body
    (br $continue)))
```

### Basic Loop

**Syntax:**
```ents
loop
  body
  br                      -- Branch to loop start
  br when condition       -- Conditional branch
end
```

**Semantics:**
- Unconditional loop (no implicit exit condition)
- Must use `br`, `break`, or `return` to exit
- `br` jumps to loop start
- `br when cond` jumps to start only if condition true

**Compilation:**
```wat
(block $exit
  (loop $start
    body
    (br_if $start condition)  -- br when
    (br $start)))             -- br
```

### Forever Loop

**Syntax:**
```ents
forever
  body
end
```

**Semantics:**
- Infinite loop
- Must use `break` or `return` to exit
- Equivalent to `loop` with unconditional `br`

### For-In Loop

**Integer Iteration:**
```ents
for i in N do
  -- i iterates: 0, 1, 2, ..., N-1
end

for i in (start, end, step) do
  -- i iterates from start toward end by step
end
```

**Semantics:**
- Loop variable is local to loop body
- Range is evaluated once before loop starts
- For simple `for i in N`: iterates 0 to N-1 (exclusive upper bound)

**Compilation:**
```wat
(local $i i32)
(local.set $i (i32.const 0))
(block $exit
  (loop $continue
    (br_if $exit (i32.ge_s (local.get $i) (i32.const N)))
    body
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $continue)))
```

**Slice Iteration:**
```ents
for element in slice do
  -- element is each value in slice
end

for (index, element) in slice do
  -- index is position, element is value
end
```

**Semantics:**
- Iterates through slice elements
- Pointer advanced by element size each iteration
- Loop exits when pointer reaches end (ptr >= ptr + len)

**Compilation:**
```wat
(local $current_ptr i32)
(local $end_ptr i32)
(local.set $current_ptr (local.get $slice_ptr))
(local.set $end_ptr (i32.add (local.get $slice_ptr) (local.get $slice_len)))
(block $exit
  (loop $continue
    (br_if $exit (i32.ge_u (local.get $current_ptr) (local.get $end_ptr)))
    ;; element = load from current_ptr
    body
    (local.set $current_ptr (i32.add (local.get $current_ptr) (i32.const element_size)))
    (br $continue)))
```

**Null-Terminated Iteration:**
```ents
for char in cstring do
  -- char is each byte until null
end
```

**Semantics:**
- Loads each element until null (0) is found
- Loop exits on null, not after null

---

## Memory Model

### Linear Memory

Encantis uses WebAssembly's linear memory model:

- Memory is a contiguous array of bytes
- Addressed by `i32` offsets
- Default page size: 64KB
- Memory can grow at runtime (not shrink)

### Memory Declaration

```ents
memory N                    -- N initial pages
memory name N               -- Named memory
export "name" memory N      -- Exported memory
```

### Data Sections

Static data placed in memory at compile time:

```ents
data offset (
  label -> "string literal":[u8]
  label -> type               -- Reserve space
)
```

**Semantics:**
- Offset is memory address
- Labels become compile-time constants with assigned addresses
- String literals encoded as UTF-8

### Memory Operations

**Load:**
```ents
ptr.*                       -- Load at pointer (type from ptr)
ptr.T                       -- Load as explicit type
```

**Store:**
```ents
ptr.* = value               -- Store at pointer
```

**Built-in operations:**
```ents
memcpy(dest, src, len)      -- Copy memory
array.fill(value)           -- Fill array with value
memory.copy(dest, src)      -- Alternative copy syntax
```

### Pointer Arithmetic

```ents
ptr + offset                -- Advance by bytes
ptr += offset               -- Advance in place
```

**Note:** Pointer type is preserved; offset is in bytes.

### Slice Manipulation

```ents
slice.ptr += n              -- Advance pointer
slice.len -= n              -- Reduce length
```

Common pattern for consuming input:
```ents
while input.len > 0 do
  -- Process input[0]
  input.ptr += 1
  input.len -= 1
end
```

---

## Type System

### Type Hierarchy

```
Types
├── Numeric
│   ├── Integer
│   │   ├── Signed: i32, i64
│   │   └── Unsigned: u32, u64, u8, u16
│   └── Float: f32, f64
├── Pointer: *T
├── Array
│   ├── Slice: [T]
│   ├── Fixed: [T*N]
│   └── Null-terminated: [T/0]
├── Compound
│   ├── Tuple: (T1, T2, ...)
│   └── Struct: {name: T, ...}
├── Function: (params) -> result
└── User-defined
    ├── Interface (alias)
    └── Type (unique)
```

### Type Equivalence

**Structural Equivalence:**
- Tuples: Same element types in same order
- Structs: Same field names and types (order may vary)
- Arrays: Same element type and size (for fixed)

**Name Equivalence:**
- `interface` types are aliases (structurally equivalent)
- `type` definitions create unique types (require explicit cast)

### Type Inference

1. **Constraint Gathering**: Collect type constraints from all expressions
2. **Unification**: Resolve constraints to concrete types
3. **Defaulting**: Unresolved literals default to `i32`/`f64`
4. **Checking**: Verify all types are compatible

### Subtyping

**Struct Subtyping:**
A struct with more fields is a subtype of one with fewer:

```ents
{x: f32, y: f32, z: f32} <: {x: f32, y: f32}
```

When calling a function expecting fewer fields, only matching fields are passed.

---

## Compilation Model

### Function Compilation

```ents
func name (a: T1, b: T2) -> (result: R)
  local x: T3
  body
end
```

Compiles to:
```wat
(func $name (param $a t1) (param $b t2) (result r)
  (local $result r)
  (local $x t3)
  ;; body compiled here
  (local.get $result))
```

### Expression Evaluation

Expressions compile to WASM instructions that push results to the value stack:

```ents
a + b * c
```

Compiles to:
```wat
(local.get $a)
(i32.mul (local.get $b) (local.get $c))
(i32.add)
```

### Stack Management

- WASM is stack-based; values pushed/popped implicitly
- Multiple return values handled via multi-value extension
- Named returns are locals that are retrieved at function end

### Optimization Opportunities

The compiler may perform:
- Constant folding for `define` values
- Inlining of small functions/macros
- Dead code elimination
- Type-directed load/store selection

---

## Appendix: Example Compilation

### Source

```ents
export "add"
func add (a: i32, b: i32) -> (sum: i32)
  sum = a + b
end
```

### Compiled WAT

```wat
(module
  (func $add (export "add") (param $a i32) (param $b i32) (result i32)
    (local $sum i32)
    (local.set $sum
      (i32.add
        (local.get $a)
        (local.get $b)))
    (local.get $sum)))
```

### Source (More Complex)

```ents
func sum_bytes (data: [u8]) -> (total: u32)
  total = 0
  for byte in data do
    total += byte
  end
end
```

### Compiled WAT

```wat
(func $sum_bytes (param $data_ptr i32) (param $data_len i32) (result i32)
  (local $total i32)
  (local $current_ptr i32)
  (local $end_ptr i32)

  (local.set $total (i32.const 0))
  (local.set $current_ptr (local.get $data_ptr))
  (local.set $end_ptr (i32.add (local.get $data_ptr) (local.get $data_len)))

  (block $exit
    (loop $continue
      (br_if $exit (i32.ge_u (local.get $current_ptr) (local.get $end_ptr)))
      (local.set $total
        (i32.add
          (local.get $total)
          (i32.load8_u (local.get $current_ptr))))
      (local.set $current_ptr
        (i32.add (local.get $current_ptr) (i32.const 1)))
      (br $continue)))

  (local.get $total))
```

---

## Related Documents

- [syntax-derived.md](syntax-derived.md) - Detailed syntax reference
- [types-derived.md](types-derived.md) - Type system details
- [file-ages.md](file-ages.md) - File modification history
