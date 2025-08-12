
# Encantis: A Minimal Infix Language for WebAssembly

Encantis is a low-level programming language that compiles directly to WebAssembly Text Format (`wat`). It provides modern syntax paired with explicit control over memory and types. With Encantis you write code that nearly maps one-to-one with WebAssembly operations, but with convenience features that help you manage memory without a runtime library or garbage collector.

---

## Table of Contents

1. [Overview and Philosophy](#overview-and-philosophy)
2. [Syntax Overview](#syntax-overview)
3. [Functions, Imports, and Exports](#functions-imports-and-exports)
4. [Variables, Scoping, and Types](#variables-scoping-and-types)
5. [Control Flow](#control-flow)
6. [Loops and Destructuring](#loops-and-destructuring)
7. [Operators](#operators)
8. [Memory Management](#memory-management)
9. [Memory Types](#memory-types)
10. [Example Program](#example-program)
11. [Additional Notes](#additional-notes)

---

## 1. Overview and Philosophy

- **Low-Level Control:** Encantis compiles to WebAssembly, giving you direct access to the underlying instructions.
- **No Garbage Collection:** Memory management is explicit—you allocate and free memory manually.
- **Explicit Typing:** All function signatures and variable declarations require explicit types unless the literal assigned already carries a concrete type.
- **Modern Syntax, Classic Semantics:** The language uses an infix notation with familiar operators (following C/C++/JavaScript conventions) while providing constructs to manage memory directly.

---

## 2. Syntax Overview

- **Infix Notation:** Write arithmetic and logical expressions in the natural human-readable form.
- **Comments:** Line comments start with `--`.  
  ```ents
  -- This is a comment.
  ```
- **Function Bodies:** Either a single expression (using `=>`) or a block delimited by `do` and `end`.  
  ```ents
  func add(a:i32, b:i32) -> i32 => a + b
  
  func mul(a:i32, b:i32) -> i32 do
    return a * b
  end
  ```

---

## 3. Functions, Imports, and Exports

### Function Declarations

- Specify types for all parameters and return values. Multiple return values are allowed:
  ```ents
  func idiv(n:i32, d:i32) -> (q:i32, r:i32) => (n / d, n % d)
  ```

### Imports

- Functions can be imported using either a flat list or a nested block:
  ```ents
  import "sys" "println" func print(msg:[u8])
  ```
  
- You may combine multiple imports from the same module:
  ```ents
  import "sys" (
    "print" func print(msg:[u8])
  )
  ```

### Exports

- Functions are exported similarly, making them accessible to the host:
  ```ents
  export "main" func () do
    print("Hello World")
  end
  ```

---

## 4. Variables, Scoping, and Types

### Variables

- Local variables must specify a type unless the assigned literal already has a concrete type.
  ```ents
  local num2:i32 = 25    -- literal 25 becomes a 25:i32
  local num3 = 25:i64    -- num3 is of type i64
  ```

- **Global variables that can be updated must be declared mutable.**  
  For example, if you need a counter:
  ```ents
  global mut count:u32
  ```

### Types

- **Literal Strings:**  
  - Literal strings have type `[u8*L]` where `L` is their byte length.
  - They can be coerced to:
    - **Slices** (`[u8]`): a pair of pointer and length.
    - **Null Terminated Arrays** (`[u8/0]`): like slices but guaranteed to end with a null (`\0`).
- **Pointers:** Declared as `*T` (e.g. `*u8`) and compile to wasm numeric types (usually `i32`).
- **Fixed Length Arrays:** Declared with a size, e.g., `[u8*5]`. Their length is a compile-time constant.

---

## 5. Control Flow

### Conditionals

Standard `if`, `elif`, and `else` are available:
```ents
if cond then
  doSomething()
elif cond2 then
  doAnotherThing()
else
  fallback()
end
```

### Inline Conditionals

Short-circuit style conditional statements:
```ents
return 0 when n == 0
print("Warning") unless condition
```

---

## 6. Loops and Destructuring

### Loops

- **While Loop:**
  ```ents
  while condition do
    -- loop body
  end
  ```
- **For Loop:** Iterates over arrays, slices, or strings.
  ```ents
  for char in "Hello" do
    print(char)
  end
  ```

### Destructuring

Encantis supports inline destructuring for concise updates, e.g., for swapping values:
```ents
(a, b) = (b, a + b)
```

---

## 7. Operators

Encantis supports a full set of arithmetic, bitwise, and comparison operators with precedences similar to C/C++/JavaScript:

### Arithmetic

- `+`, `-`, `*`, `/`, `%`
  - The exact WebAssembly opcode (e.g., `i32.add`) is chosen according to the type.

### Bitwise

- `&`, `|`, `^`, `<<`, `>>`, `<<<` (rotate left), `>>>` (rotate right)

### Comparison

- `==`, `!=`, `<`, `>`, `<=`, `>=`

---

## 8. Memory Management

Encantis does not provide garbage collection. You must manage memory manually—typically via a bump allocator:

```ents
global mut heap_ptr:*u8 = INITIAL-HEAP-OFFSET

export "malloc" func malloc(size:i32) -> *u8 do
  local old_ptr = heap_ptr
  heap_ptr += size
  return old_ptr
end
```

---

## 9. Memory Types

Encantis distinguishes among four memory types:

1. **Pointers** (`*T`):  
   - Example:  
     ```ents
     local mem:*u8 = malloc(10)
     local first_byte:u8 = mem.*     -- same as mem[0]
     ```
  
2. **Slices** (`[u8]`):  
   - Represented by two inlined values (pointer and length).
   - Example:
     ```ents
     local message:[u8] = "Hello"  -- becomes (pointer, length)
     ```

3. **Null Terminated Arrays** (`[u8/0]`):  
   - Automatically include a null terminator at the end.
   - Example:
     ```ents
     local c_str:[u8/0] = "Goodbye"
     ```

4. **Fixed Length Arrays** (`[u8*L]`):  
   - Size is known at compile-time.
   - Example:
     ```ents
     local fixed:[u8*5] = "Hello"
     print(fixed as [u8])
     ```

Each type serves a distinct purpose—from raw pointer arithmetic to safe string handling and static data representation.

---

## 10. Example Program

Below is a full Encantis program that demonstrates memory allocation, concatenation, and printing using all four memory types where relevant. Notice that rather than importing a `copy` function, we use the native `memory.copy` opcode provided by WebAssembly’s bulk-memory extension.

```ents
import "sys" "print" func print(msg:[u8])

global mut heap_ptr:*u8 = INITIAL-HEAP-OFFSET

export "malloc" func malloc(size:i32) -> *u8 do
  local old_ptr = heap_ptr
  heap_ptr += size
  return old_ptr
end

-- concat concatenates two [u8] slices.
func concat(a:[u8], b:[u8]) -> [u8] do
  local len = a.len + b.len
  local buf = malloc(len)
  memory.copy(buf, a)          -- Copy slice a into buf.
  memory.copy(buf + a.len, b)    -- Copy slice b into buf, starting at a.len.
  return (buf, len)
end

-- greet concatenates a literal with a host-supplied message and prints it.
export "greet" func greet(msg:[u8]) do
  print(concat("Hello ", msg))
end
```

### Explanation

- **Memory Allocation:**  
  A global bump pointer (`heap_ptr`) is used by `malloc` to allocate memory from `INITIAL-HEAP-OFFSET`.

- **Using `memory.copy`:**  
  The builtin `memory.copy` opcode is used in the `concat` function to efficiently copy two slices into a new buffer.

- **Memory Types in Use:**  
  - `"Hello "` is a literal string with type `[u8*6]` that is used as a slice (`[u8]`) in `concat`.
  - `msg` is received as a slice `[u8]` from the host.
  - The concatenated result (a new slice) is returned as a tuple `(pointer, length)`.

---

## 11. Additional Notes

- **Global Mutability:**  
  All global variables that are updated must be declared mutable using `global mut`.
  
- **Type Inference for Literals:**  
  Literal integers start as `int` (arbitrary precision) until context or inline annotations (e.g., `25:i32`) specify a concrete type.
  
- **Data Segments:**  
  Literal strings are stored in the wasm data section. For example, the literal `"Hello "` is placed at offset 0.
  
- **Interoperability:**  
  Encantis’ design makes it straightforward to pass slices between WebAssembly and host environments (using tuples for pointer and length).

- **Compilation:**  
  Encantis source files (`.ents`) compile to `wat`, then to `.wasm` for execution in environments like Node.js, browsers, or Bun.
