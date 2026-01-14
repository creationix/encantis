# Encantis Syntax Reference (Derived)

This document describes the syntax of the Encantis language, derived from analysis of example files. Encantis is a systems programming language that compiles to WebAssembly Text Format (WAT). It emphasizes explicit control, static typing, and efficiency while providing modern syntax conveniences.

## Comments

Line comments start with `--` (Lua/Haskell style):

```ents
-- This is a comment
x = 10  -- Inline comment
```

## Primitive Types

### Numeric Types

| Type  | Description                    | WAT Equivalent |
|-------|--------------------------------|----------------|
| `i32` | Signed 32-bit integer          | `i32`          |
| `u32` | Unsigned 32-bit integer        | `i32`          |
| `i64` | Signed 64-bit integer          | `i64`          |
| `u64` | Unsigned 64-bit integer        | `i64`          |
| `f32` | 32-bit floating point          | `f32`          |
| `f64` | 64-bit floating point          | `f64`          |
| `u8`  | Unsigned 8-bit integer (byte)  | `i32` (in loads/stores) |
| `u16` | Unsigned 16-bit integer        | `i32` (in loads/stores) |

Note: Signedness is a type-system concept. At the WASM level, integers are just `i32`/`i64`.

## Type Annotations

Types are specified after a colon `:` following variable names or literals:

```ents
local x: i32              -- Variable with type
local y: u64 = 100        -- Variable with type and initializer
100:u32                   -- Literal with type annotation
```

## Variables

### Local Variables

Local variables are declared with the `local` keyword:

```ents
local x: i32                  -- Uninitialized
local y: f64 = 3.14           -- Initialized with type
local z = 42                  -- Type inferred from initializer
local ptr:*u8 = data.ptr      -- Pointer type
```

### Global Variables

Global variables are declared with the `global` keyword:

```ents
global prime64-1 = 11400714785074694791:u64    -- Immutable global
global mut heap_ptr:*u8 = 0                    -- Mutable global
```

## Compound Types

### Pointer Types

Pointers are declared with `*` prefix. In WASM they are `u32` offsets into linear memory:

```ents
local ptr: *u8           -- Pointer to byte
local arr: *u64          -- Pointer to 64-bit integer
local complex: *(u8 u16) -- Pointer to tuple in memory
```

Pointer operations:
```ents
ptr.*                    -- Dereference: load value at pointer
ptr.u32                  -- Load as specific type
(ptr as *u32).*          -- Cast pointer then dereference
ptr + 8                  -- Pointer arithmetic
```

### Slice Types `[T]`

A slice is a fat pointer with runtime length (two `i32` values: pointer + length):

```ents
local message: [u8]       -- Byte slice (common string type)
local words: [u32]        -- Slice of 32-bit words
local nested: [[u8]]      -- Slice of byte slices
```

Slice properties:
```ents
message.ptr               -- Pointer to data (u32)
message.len               -- Length (u32)
message[i]                -- Element access
```

### Fixed-Length Arrays `[T*N]`

Compile-time known length arrays. Passed by reference:

```ents
local state: [u32*12]     -- Array of exactly 12 u32 values
local buffer: [u8*48]     -- Array of exactly 48 bytes
```

### Null-Terminated Arrays `[T/0]`

C-style null-terminated arrays (single pointer, length determined at runtime):

```ents
local cstring: [u8/0]     -- Null-terminated string
local strings: [[u8/0]/0] -- Null-terminated array of null-terminated strings
```

### Tuple Types `(T1, T2, ...)`

Fixed-size collections of values:

```ents
local point: (f32, f32)           -- Two floats
local result = (10, 20)           -- Tuple literal
var (a, b) = point                -- Destructuring
point.1                           -- First element (1-indexed)
point.2                           -- Second element
```

Alternative space-separated syntax:
```ents
local pair: (i32 i32)
```

### Struct Types `{ name: T, ... }`

Named tuples with field access:

```ents
local point = { x = 3, y = 5 }    -- Struct literal
point.x                            -- Field access
var { x, y } = point               -- Destructuring
```

## Type Definitions

### Interface Types (Aliases)

Type aliases that are interchangeable with the underlying type:

```ents
interface Point = (f32 f32)       -- Tuple alias
interface Pair: (f32 f32)         -- Alternative syntax
```

### Unique Types

Distinct types requiring explicit casting:

```ents
type String = [u8]                -- Distinct from [u8]
type GameIndex: u32               -- Distinct from u32
```

Usage:
```ents
local s: String = String(bytes)   -- Explicit cast required
```

## Functions

### Function Definitions

```ents
-- Named function with explicit return type
func add (a: i32, b: i32) -> i32
  return a + b
end

-- Named return values
func xxh64 (ptr: *u64, len: u32, seed: u64) -> (h64: u64)
  -- h64 is automatically returned
end

-- Arrow syntax for single expressions
func negate (x: i32) -> i32
  => -x

-- Alternative: inline arrow
func add (a: i32, b: i32) -> i32 => a + b

-- Multiple return values
func divmod (a: i32, b: i32) -> (i32, i32)
  => (a / b, a % b)

-- Anonymous parameters (less common)
func (x: f64, y: f64) -> f64
  => sqrt(x * x + y * y)

-- Void return
func process (data: [u8]) -> ()
  -- ...
end

-- Implicit void return
func process (data: [u8])
  -- ...
end
```

### Anonymous Functions (Lambdas)

```ents
local add = (a, b) => a + b
local square = x => x * x
local add-inline = (a: i32, b: i32) => a + b
```

### Function Calls

```ents
result = add(1, 2)                -- Standard call
result = func-name(arg1, arg2)    -- Dash-case names allowed
```

### Exports and Imports

```ents
-- Export function
export "xxh64"
func xxh64 (ptr: *u64, len: u32) -> u64
  -- ...
end

-- Import function
import "math" (
  "sin" func (angle: f64) -> f64
  "cos" func (angle: f64) -> f64
)

-- Alternative import syntax
import "sys" "print"
func print ([u8])

-- Single-line import
import "print" func print (String) -> ()
```

## Operators

### Arithmetic
| Operator | Description      |
|----------|------------------|
| `+`      | Addition         |
| `-`      | Subtraction      |
| `*`      | Multiplication   |
| `/`      | Division         |
| `%`      | Modulo           |

### Bitwise
| Operator | Description      |
|----------|------------------|
| `&`      | Bitwise AND      |
| `\|`     | Bitwise OR       |
| `^`      | Bitwise XOR      |
| `~`      | Bitwise NOT      |
| `<<`     | Left shift       |
| `>>`     | Right shift      |
| `<<<`    | Rotate left      |
| `>>>`    | Rotate right     |

### Comparison
| Operator | Description         |
|----------|---------------------|
| `==`     | Equal               |
| `!=`     | Not equal           |
| `<`      | Less than           |
| `>`      | Greater than        |
| `<=`     | Less than or equal  |
| `>=`     | Greater than or equal |

### Logical
| Operator | Description      |
|----------|------------------|
| `and`    | Logical AND      |
| `or`     | Logical OR       |
| `not`    | Logical NOT      |

### Assignment
```ents
x = value            -- Simple assignment
x += value           -- Add and assign
x -= value           -- Subtract and assign
x *= value           -- Multiply and assign
x /= value           -- Divide and assign
x ^= value           -- XOR and assign
x |= value           -- OR and assign
x &= value           -- AND and assign
x <<= value          -- Left shift and assign
x >>= value          -- Right shift and assign
x <<<= value         -- Rotate left and assign
```

### Ternary Operator
```ents
result = condition ? true_value : false_value
```

### Type Cast
```ents
(ptr as *u32).*       -- Cast pointer type
len as u64            -- Cast value type
value:[T*N]           -- Memory view cast (reinterpret)
```

## Control Flow

### Conditionals

```ents
if condition then
  -- body
end

if condition then
  -- true body
else
  -- false body
end

if cond1 then
  -- first
elif cond2 then
  -- second
else
  -- default
end
```

### Loops

#### While Loop
```ents
while condition do
  -- body
end
```

#### Basic Loop (infinite)
```ents
loop
  -- body
  br                   -- Branch to loop start
  br when condition    -- Conditional branch
end
```

#### Forever Loop
```ents
forever
  -- body (explicit break needed)
end
```

#### For-In Loops

```ents
-- Integer iteration (0 to N-1)
for i in 10 do
  -- i iterates 0, 1, 2, ..., 9
end

-- With explicit type
for i:i32 in 10 do
  -- i is explicitly i32
end

-- Explicit range (start, end, step)
for i:i32 in (10, 1, -1) do
  -- i iterates 10, 9, 8, ..., 1
end

-- Slice iteration
for byte in message do
  -- byte is each element in slice
end

-- Slice iteration with index
for (i, byte) in message do
  -- i is index, byte is value
end

-- Fixed-length array iteration
for c in buffer do
  -- iterates through [u8*48]
end

-- Null-terminated iteration
for c in cstring do
  -- stops at null byte
end
```

### Early Exit and Control

```ents
return                      -- Return from function
return value                -- Return with value
return value when condition -- Conditional return
break                       -- Exit current loop
br                          -- Branch to loop start
br when condition           -- Conditional branch to loop start
```

## Memory

### Memory Declaration

```ents
memory 1                    -- Declare memory with 1 page (64KB)
memory mem 1                -- Named memory
export "memory" memory 1    -- Exported memory
```

### Memory Operations

```ents
ptr.*                       -- Load from pointer
ptr.u32                     -- Load as u32
ptr.u8                      -- Load as u8
state.fill(0)               -- Fill array with value
memcpy(dest, src, len)      -- Memory copy
memory.copy(dest, src)      -- Alternative syntax
```

### Data Sections

```ents
data 0 (
  message -> "Hello World\n":[u8]
  outsize -> u32
)
```

## Module-Level Constructs

### Globals

```ents
global CONSTANT = 42:i32           -- Immutable
global mut counter:i32 = 0         -- Mutable
```

### Defines (Compile-time Constants/Macros)

```ents
define rate-in-bytes = 16:u32              -- Simple constant
define min(a, b) = a < b ? a : b           -- Macro function
define min(a:u32, b:u32):u32 = a < b ? a : b  -- Typed macro
```

### Exports

```ents
export "function_name"
func ...

export "memory"
memory 1

export "global_name"
global ...
```

### Imports

```ents
-- Import with module name and function name
import "wasi_snapshot_preview1" (
  "fd_write" func fd-write (fd:u32, iovec:[[u8]], outsize:*u32) -> result:i32
)

-- Simple import
import "math" (
  "sin" func (angle:f64) -> f64
  "cos" func (angle:f64) -> f64
)
```

## Special Syntax

### Pipe Operator

Chain function calls with `|>` and `%` placeholder:

```ents
local message = alloc(0)
  |> write-str(%, greeting)
  |> write-str(%, name)
  |> write-i32(%, 42)
```

### Tuple Destructuring

```ents
local (a, b) = (10, 20)
(state[0], state[1]) = (state[1], state[0])  -- Swap
d, a = to_polar(x, y)                         -- Multiple return
```

### Type-based Conditionals

```ents
return write-str(dest, val) when val is String
return write-i32(dest, val) when val is Number
```

## Naming Conventions

- Function and variable names can use `dash-case` (kebab-case)
- Identifiers can contain hyphens: `rate-in-bytes`, `xxh64`, `fd-write`
- Constants often use `UPPER_SNAKE_CASE` or `dash-case`

## String Literals

```ents
"Hello World"              -- UTF-8 string, type depends on context
"Hello":[u8]               -- Explicit slice type
"Hello\n"                  -- Escape sequences supported
"Hello\00"                 -- Null byte
```

## Numeric Literals

```ents
42                         -- Integer literal
3.14                       -- Float literal
0x9e377900                 -- Hexadecimal
100:u32                    -- With type annotation
1f                         -- Float (f32) - older syntax
```

## Summary of Block Delimiters

| Construct    | Start              | End     |
|--------------|--------------------|---------
| Function     | `func ... do`      | `end`   |
| Function     | `func ...`         | `end`   |
| If           | `if ... then`      | `end`   |
| While        | `while ... do`     | `end`   |
| Loop         | `loop`             | `end`   |
| For          | `for ... do`       | `end`   |
| Forever      | `forever`          | `end`   |
| Block        | `block[-name]`     | `end`   |

Note: The `do` keyword is optional in some contexts when the body follows on a new line.
