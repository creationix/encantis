# Encantis Grammar Reference

This document provides examples and human-readable explanations of Encantis syntax.

**Grammar Source of Truth:** [`packages/compiler/src/grammar/encantis.ohm`](../packages/compiler/src/grammar/encantis.ohm)

For the authoritative grammar definition, always refer to the Ohm grammar file. This document focuses on examples and clarifications.

---

## Identifiers and Naming

[Grammar: `ident`, `typeIdent`](../packages/compiler/src/grammar/encantis.ohm#L244-L251)

**Regular identifiers** (functions, variables) start with lowercase:
```encantis
count
user-name
my_value
calculate-total
```

**Type identifiers** start with uppercase:
```encantis
Point
Vector3D
CartesianPoint
FileHandle
UserId
```

Identifiers can contain letters, digits, underscores, and hyphens.

---

## Literals

[Grammar: `literal`](../packages/compiler/src/grammar/encantis.ohm#L189-L225)

### Numbers

**Integers** support multiple bases:
```encantis
42              // decimal
0xFF            // hexadecimal
0b1010          // binary (10)
0o755           // octal (493)
0d10B           // dozenal/base-12 (143 decimal)
-123            // negative
```

**Floats:**
```encantis
3.14159
-2.5
1.0e10          // scientific notation
6.022e23
-1.5e-10
```

### Strings

**UTF-8 strings:**
```encantis
"Hello, world!"
'single quotes work too'
"escape sequences: \n \t \\ \" \'"
"\x48\x69"      // hex escapes in UTF-8
```

**Raw bytes:**
```encantis
x"48 65 6C 6C 6F"              // hex bytes (spaces optional)
b"SGVsbG8gV29ybGQh"             // base64
```

### Booleans

```encantis
true
false
```

---

## Comments

[Grammar: `comment`](../packages/compiler/src/grammar/encantis.ohm#L261-L265)

```encantis
// Single-line comment

/* 
 * Multi-line
 * block comment
 */
 
func add(a: i32, b: i32) -> i32 {  // inline comment
  return a + b
}
```

---

## Top-Level Declarations

[Grammar: `Declaration`](../packages/compiler/src/grammar/encantis.ohm#L6-L14)

A module consists of zero or more declarations:

### Imports

[Grammar: `ImportDecl`](../packages/compiler/src/grammar/encantis.ohm#L22-L30)

**Single import:**
```encantis
import "env" "log" func(message: *[!]u8)
```

**Grouped imports:**
```encantis
import "wasi" (
  "fd_write" func(fd: i32, iovs: *[*]u8, iovs_len: i32, nwritten: *u32) -> i32
  "fd_read" func(fd: i32, iovs: *[*]u8, iovs_len: i32, nread: *u32) -> i32
)
```

**Global and memory imports:**
```encantis
import "env" "memory_offset" global g_offset: i32
import "env" "memory" memory 1
```

### Exports

[Grammar: `ExportDecl`](../packages/compiler/src/grammar/encantis.ohm#L36-L40)

```encantis
// Export a function (name inferred from identifier)
export func add(a: i32, b: i32) -> i32 {
  return a + b
}

// Export with explicit name (when different from identifier)
export "_start" func main() { }

// Export a global (name inferred from identifier)
export global counter: i32 = 0

// Export memory (explicit name required)
export "memory" memory 1
```

### Functions

[Grammar: `FuncDecl`, `FuncSignature`](../packages/compiler/src/grammar/encantis.ohm#L46-L53)

**Basic function:**
```encantis
func add(a: i32, b: i32) -> i32 {
  return a + b
}
```

**Arrow body** (implicit return):
```encantis
func double(x: i32) -> i32 => x * 2
```

**Named outputs:**
```encantis
func divmod(a: i32, b: i32) -> (quotient: i32, remainder: i32) {
  return (a / b, a % b)
}
```

**Inline hint:**
```encantis
inline func square(x: f32) -> f32 => x * x
```

**Anonymous/lambda:**
```encantis
func(x: i32) -> i32 => x + 1
```

**No parameters or return:**
```encantis
func get_pi() -> f64 => 3.14159
func print_hello() { /* side effects */ }
```

**Function types** (right-associative):
```encantis
type BinaryOp = (i32, i32) -> i32
type Mapper = i32 -> i32
type Curried = i32 -> i32 -> i32    // same as i32 -> (i32 -> i32)
```

### Type Declarations

[Grammar: `TypeDecl`](../packages/compiler/src/grammar/encantis.ohm#L20)

```encantis
// Type alias
type Coordinate = (x: f64, y: f64)

// Struct type
type Point3D = (x: f64, y: f64, z: f64)

// Function type
type BinaryOp = (i32, i32) -> i32

// Pointer type
type BytePtr = *u8

// Array type
type Buffer = [1024]u8
```

### Definitions (Constants)

[Grammar: `DefDecl`](../packages/compiler/src/grammar/encantis.ohm#L59)

Compile-time constants:
```encantis
def pi = 3.14159:f64
def max_size = 1024:i32
def greeting = "Hello, world!"
def enabled = true
```

### Globals

[Grammar: `GlobalDecl`](../packages/compiler/src/grammar/encantis.ohm#L65)

Mutable runtime variables:
```encantis
// Uninitialized (zero-initialized)
global counter: i32

// Initialized
global max_connections: i32 = 100

// Type inferred
global greeting = "Hello"
```

### Memory

[Grammar: `MemoryDecl`](../packages/compiler/src/grammar/encantis.ohm#L71-L73)

```encantis
// Basic memory: 1 page minimum (64KB)
memory 1

// With max: 1 page min, 16 pages max (1MB)
memory 1 16
```

---

## Types

[Grammar: `Type`, `BaseType`](../packages/compiler/src/grammar/encantis.ohm#L100-L120)

```ebnf
type            = base_type "->" type            -- function type
                | base_type                      -- non-function type

base_type       = primitive_type
                | pointer_type
                | array_type
                | composite_type
---

## Types

[Grammar: `Type`, `BaseType`](../packages/compiler/src/grammar/encantis.ohm#L100-L120)

### Primitive Types

```encantis
i8  i16  i32  i64      // signed integers
u8  u16  u32  u64      // unsigned integers
f32  f64               // floats
bool                   // boolean
```

### Composite Types (Tuples/Structs)

[Grammar: `BaseType` composite case](../packages/compiler/src/grammar/encantis.ohm#L113)

**Anonymous tuple:**
```encantis
(i32, i32)             // 2-tuple
()                     // unit type (void)
```

**Named fields (struct):**
```encantis
(x: f64, y: f64)       // Point struct
(name: []u8, age: u32) // Person struct
```

**Mixed (rare):**
```encantis
(i32, name: []u8)      // Positional i32, named []u8 field
```

### Pointer Types

[Grammar: `BaseType` pointer case](../packages/compiler/src/grammar/encantis.ohm#L109)

```encantis
*i32                   // pointer to i32
*Point                 // pointer to Point type
**u8                   // pointer to pointer
```

### Bracket Types (Pointers)

[Grammar: `BaseType` array case, `arrayTypePrefix`](../packages/compiler/src/grammar/encantis.ohm#L110-L118)

All bracket types are pointers (no by-value arrays). Syntax: `[*? length? framing*]T`

**Many-pointers** (thin, just ptr):
```encantis
[*]u8                  // many-pointer, unknown length
[*!]u8                 // null-terminated
[*?]u8                 // LEB128-prefixed
[*10]u8                // known length 10
[*_]u8                 // inferred length
[*10!]u8               // known length + null-terminated
```

**Slices** (fat, ptr + runtime length):
```encantis
[]u8                   // slice, runtime length only
[!]u8                  // slice + null-terminated
[?]u8                  // slice + LEB128-prefixed
[5]u8                  // slice + known length 5 (redundant)
[_]u8                  // slice + inferred length
[5!]u8                 // slice + known length + null-terminated
```

**Multi-dimensional (flat layout):**
```encantis
[*!!]u8                // double null-terminated (2D)
[*??]u8                // LEB128 count + per-element LEB128 lengths
[*!?]u8                // null-term outer, LEB128 inner
```

**Multi-dimensional (pointer indirection):**
```encantis
[*][*!]u8              // many-pointer to null-term strings
[][]u8                 // slice of slices
[*][5]u8               // many-pointer to length-5 slices
```

### Function Types

[Grammar: `Type` func case](../packages/compiler/src/grammar/encantis.ohm#L100-L101)

**Right-associative** (curried by default):
```encantis
i32 -> i32                    // Simple function
(i32, i32) -> i32             // Multiple inputs
(x: i32) -> (result: i32)     // Named params/returns
i32 -> i32 -> i32             // Curried: i32 -> (i32 -> i32)
(i32 -> i32) -> i32           // Higher-order function
```

### Compile-Time Types

[Grammar: `ComptimeType`](../packages/compiler/src/grammar/encantis.ohm#L125-L127)

```encantis
int(42)                // Comptime integer literal
float(3.14)            // Comptime float literal
```

These are used internally for type inference.

---

## Statements

[Grammar: `Statement`](../packages/compiler/src/grammar/encantis.ohm#L133-L141)

### Let (Variable Declaration)

[Grammar: `LetStmt`](../packages/compiler/src/grammar/encantis.ohm#L143)

```encantis
let x = 42                    // Type inferred
let y: i32 = 100              // Explicit type
let point = (x: 1.0, y: 2.0)  // Struct binding
let (a, b) = (10, 20)         // Destructuring
```

### Set (Assignment with Declaration)

[Grammar: `SetStmt`](../packages/compiler/src/grammar/encantis.ohm#L145)

Like `let` but emphasizes reassignment intent:
```encantis
set count: i32 = 0
set total = count + 10
```

### Assignment

[Grammar: `AssignmentStmt`, `assignOp`](../packages/compiler/src/grammar/encantis.ohm#L157-L163)

```encantis
x = 42                        // Simple assignment
count += 1                    // Compound assignment
total *= 2
bits &= 0xFF
value <<= 1                   // Shift left
value +|= 10                  // Wrapping add
```

### If/Elif/Else

[Grammar: `IfExpr` (also used as statement)](../packages/compiler/src/grammar/encantis.ohm#L184-L188)

```encantis
if x > 0 {
  return x
} elif x < 0 {
  return -x
} else {
  return 0
}

// Single-line with arrow body
if condition => do_something()
```

### While Loop

[Grammar: `WhileStmt`](../packages/compiler/src/grammar/encantis.ohm#L147)

```encantis
while count < 10 {
  count += 1
}
```

### For Loop

[Grammar: `ForStmt`, `ForBinding`](../packages/compiler/src/grammar/encantis.ohm#L149-L152)

```encantis
// Value only
for item in items {
  process(item)
}

// With index
for i, item in items {
  print(i, item)
}
```

### Infinite Loop

[Grammar: `LoopStmt`](../packages/compiler/src/grammar/encantis.ohm#L154)

```encantis
loop {
  if done { break }
  // ...
}
```

### Control Flow

[Grammar: `ReturnStmt`, `BreakStmt`, `ContinueStmt`, `WhenClause`](../packages/compiler/src/grammar/encantis.ohm#L156-L161)

```encantis
return 42
return (x, y)                 // Multiple values

break
continue

// Conditional control flow
return 0 when x == 0
break when done
continue when skip
```

---

## Patterns (Destructuring)

[Grammar: `Pattern`, `PatternList`, `PatternElem`](../packages/compiler/src/grammar/encantis.ohm#L175-L181)

### Positional Binding

```encantis
let (a, b) = get_point()      // Bind by position
let (x, y, z) = vec3
```

### Named Binding

```encantis
// Shorthand: field name = variable name
let (x:, y:) = point

// Explicit: field name : variable name
let (x: px, y: py) = point

// Mixed
let (x:, y: pos_y) = point
```

### Nested Patterns

```encantis
let (pos: (x:, y:), vel: (vx, vy)) = entity
```

---

## Expressions

[Grammar: `Expr` and precedence hierarchy](../packages/compiler/src/grammar/encantis.ohm#L189-L219)

### Precedence (Low to High)

1. **Logical OR** `||`
2. **Logical AND** `&&`
3. **Logical NOT** `!`
4. **Comparison** `==` `!=` `<` `>` `<=` `>=`
5. **Bitwise OR** `|`
6. **Bitwise XOR** `^`
7. **Bitwise AND** `&`
8. **Shift** `<<` `>>` `<<<` `>>>`
9. **Addition** `+` `-` `+|` `-|` (wrapping)
10. **Multiplication** `*` `/` `%` `*|` (wrapping)
11. **Unary** `-` `~` `&` (negate, complement, address-of)
12. **Cast/Annotation** `as` `:`
13. **Postfix** `.` `[]` `()`

### Operators by Category

**Logical:**
```encantis
a && b                        // Logical AND
a || b                        // Logical OR
!a                            // Logical NOT
```

**Comparison:**
```encantis
a == b                        // Equal
a != b                        // Not equal
a < b                         // Less than
a <= b                        // Less or equal
a > b                         // Greater than
a >= b                        // Greater or equal
```

**Arithmetic:**
```encantis
a + b                         // Add
a - b                         // Subtract
a * b                         // Multiply
a / b                         // Divide
a % b                         // Remainder

// Wrapping (no overflow trap)
a +| b
a -| b
a *| b
```

**Bitwise:**
```encantis
a & b                         // AND
a | b                         // OR
a ^ b                         // XOR
~a                            // NOT (complement)
```

**Shift:**
```encantis
a << b                        // Shift left
a >> b                        // Shift right (arithmetic)
a <<< b                       // Rotate left
a >>> b                       // Rotate right
```

**Unary:**
```encantis
-x                            // Negate
~x                            // Bitwise complement
&x                            // Address-of (pointer)
```

### Type Annotation and Cast

[Grammar: `CastExpr`](../packages/compiler/src/grammar/encantis.ohm#L221-L224)

```encantis
42:i32                        // Type annotation
3.14:f64
value as u32                  // Runtime cast
ptr as *u8                    // Pointer cast
```

### Member Access

[Grammar: `AccessSuffix`](../packages/compiler/src/grammar/encantis.ohm#L168-L173)

```encantis
point.x                       // Field access
tuple.0                       // Tuple index
ptr.*                         // Dereference
value.i32                     // Type-punned access
```

### Indexing

```encantis
array[i]                      // Array index
matrix[i][j]                  // Multi-dimensional
```

### Function Call

[Grammar: `PostfixOp` call case](../packages/compiler/src/grammar/encantis.ohm#L231)

```encantis
add(1, 2)                     // Positional args
Point(x: 1.0, y: 2.0)         // Named args
Point(x:, y:)                 // Shorthand (x=x, y=y)
```

### Literals and Constructors

```encantis
42                            // Integer
3.14                          // Float
"hello"                       // String
true                          // Boolean
()                            // Unit
(1, 2)                        // Tuple
(x: 1, y: 2)                  // Struct
[1, 2, 3]                     // Array literal
Point(1.0, 2.0)               // Type constructor
```

### If Expression

[Grammar: `IfExpr`](../packages/compiler/src/grammar/encantis.ohm#L242-L246)

```encantis
let result = if x > 0 { 1 } else { -1 }

let sign = if x > 0 => 1
  elif x < 0 => -1
  else => 0
```

### Match Expression

[Grammar: `MatchExpr`, `MatchArm`](../packages/compiler/src/grammar/encantis.ohm#L252-L256)

```encantis
match value {
  0 => "zero"
  1 => "one"
  2, 3, 4 => "small"
  _ => "other"
}

match status {
  200 => { handle_success() }
  404 => { handle_not_found() }
  _ => { handle_error() }
}
```

---

## Complete Examples

### Hello World

```encantis
export "_start" func main() {
  // WASI example would go here
}
```

### Math Functions

```encantis
func abs(x: f64) -> f64 {
  if x < 0.0 => -x else => x
}

func max(a: i32, b: i32) -> i32 {
  if a > b => a else => b
}

func fibonacci(n: i32) -> i32 {
  if n <= 1 => n
  else => fibonacci(n - 1) + fibonacci(n - 2)
}
```

### Structs and Tuples

```encantis
type Point = (x: f64, y: f64)
type PolarPoint = (distance: f64, angle: f64)

func to_polar(point: Point) -> PolarPoint {
  let (x:, y:) = point
  let distance = sqrt(x * x + y * y)
  let angle = atan2(y, x)
  return (distance:, angle:)
}
```

### Arrays and Loops

```encantis
func sum_array(arr: []i32) -> i32 {
  let total = 0
  for value in arr {
    total += value
  }
  return total
}

func find_max(arr: []f64) -> f64 {
  let result = arr[0]
  for i, value in arr {
    if value > result {
      result = value
    }
  }
  return result
}
```

---

For the complete and authoritative grammar, always refer to [`packages/compiler/src/grammar/encantis.ohm`](../packages/compiler/src/grammar/encantis.ohm).

---

For the complete and authoritative grammar, always refer to [`packages/compiler/src/grammar/encantis.ohm`](../packages/compiler/src/grammar/encantis.ohm).
