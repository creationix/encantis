
# Encantis: A Minimal Infix Language for WebAssembly

Encantis is a low‑level programming language that compiles directly to the WebAssembly Text Format (WAT). It’s designed to give you explicit control over memory and types while using modern, readable syntax. Encantis omits runtime libraries, garbage collection, and dynamic memory allocation—you manage everything, which lets you write very efficient WebAssembly code.

---

## Table of Contents

1. [Overview and Philosophy](#overview-and-philosophy)
2. [Core Syntax](#core-syntax)
    - [Comments](#comments)
    - [Function Definitions](#function-definitions)
    - [Inline Expressions and Blocks](#inline-expressions-and-blocks)
3. [Imports and Exports](#imports-and-exports)
4. [Variables, Scoping, and the Type System](#variables-scoping-and-the-type-system)
5. [Control Flow Constructs](#control-flow-constructs)
6. [Loops and Destructuring](#loops-and-destructuring)
7. [Operators](#operators)
8. [Memory Management](#memory-management)
9. [Memory Types](#memory-types)
10. [Example Program](#example-program)
11. [Compilation and Interoperability](#compilation-and-interoperability)
12. [Additional Notes](#additional-notes)

---

## 1. Overview and Philosophy

- **Low-Level, Explicit, and Efficient:**  
  Encantis compiles directly to WAT, mapping nearly one-to-one with WebAssembly instructions. You must explicitly manage memory using constructs like bump allocators.

- **No Garbage Collection:**  
  All memory is statically allocated or manually managed. There is no runtime memory management.

- **Explicit Types Everywhere:**  
  Function signatures, variable declarations, and expressions require type annotations. Even literal integers start as an abstract `int` until context or inline annotation (e.g., `25:i32`) gives them a concrete type.

- **Modern Syntax with Classic Semantics:**  
  The language uses an infix notation with idioms (if‑else, loops, destructuring) similar to C, C++, and JavaScript while exposing the low‑level memory model of WebAssembly.

---

## 2. Core Syntax

### Comments

- Line comments start with `--`:
  ```ents
  -- This is a single-line comment.
  ```

### Function Definitions

- **Signature:**  
  Every function must list all its parameters with types and its return types.
  ```ents
  func add(a:i32, b:i32) -> i32 => a + b
  ```
- **Multiple Returns:**  
  Use tuple syntax to return several values.
  ```ents
  func idiv(n:i32, d:i32) -> (q:i32, r:i32) => (n / d, n % d)
  ```

### Inline Expressions and Blocks

- **Single Expression Body:**  
  Use `=>` for one‑line functions.
- **Block Body:**  
  Enclose multiple statements between `do` and `end`.
  ```ents
  func mul(a:i32, b:i32) -> i32 do
    return a * b
  end
  ```

---

## 3. Imports and Exports

### Imports

- Import external functions using a namespace and string identifiers:
  ```ents
  import "sys" "println" func print(msg:[u8])
  ```
- Imports can be grouped:
  ```ents
  import "sys" (
    "print" func print(msg:[u8])
    "copy"  func copy(dst:*u8, src:[u8])
  )
  ```

### Exports

- Export functions to make them callable from the host:
  ```ents
  export "main" func () do
    print("Hello World")
  end
  ```

---

## 4. Variables, Scoping, and the Type System

### Variables

- **Local Variables:**  
  Must include a type annotation unless assigned a literal with a concrete type.
  ```ents
  local num2:i32 = 25    -- '25' is inferred as 25:i32
  local num3 = 25:i64    -- num3 is of type i64
  ```
- **Global Variables:**  
  Global variables are declared at the top level. Updatable globals must be explicitly marked mutable:
  ```ents
  global mut count:u32
  ```

### The Type System

- **Literal Integers:**  
  Start as the abstract type `int` (arbitrary precision) and are made concrete by context or explicit annotation.

- **Literal Strings:**  
  Literal strings have the type `[u8*L]`, where `L` is their byte length.
  ```ents
  local message = "Hello Friends"  -- type: [u8*13]
  ```

- **Type Conversions:**  
  Literal strings can be coerced to slices `[u8]` or null-terminated arrays `[u8/0]`, and fixed length arrays can be coerced to slices.

---

## 5. Control Flow Constructs

### Conditionals

- **If‑Else Chains:**  
  Use standard `if`, `elif`, and `else` statements:
  ```ents
  if cond then
    doSomething()
  elif otherCond then
    doSomethingElse()
  else
    fallback()
  end
  ```

### Inline Conditionals

- **When / Unless:**  
  Allows one‑line conditional statements, reducing nesting:
  ```ents
  return 0 when n == 0
  print("Warning") unless condition
  ```

---

## 6. Loops and Destructuring

### Loops

- **While Loop:**  
  Executes as long as the condition is true:
  ```ents
  while condition do
    -- loop body
  end
  ```

- **For Loop:**  
  Iterates over a collection or range; works naturally with slices, strings, and fixed arrays:
  ```ents
  for char in "Hello" do
    print(char)
  end
  ```

### Destructuring

- **Swapping Variables:**  
  Inline destructuring enables elegant swapping or tuple unpacking:
  ```ents
  (a, b) = (b, a + b)
  ```

---

## 7. Operators

Encantis supports a rich set of operators following precedences similar to C/C++/JavaScript.

### Arithmetic Operators

- `+`, `-`, `*`, `/`, `%`  
  The compiler selects the appropriate wasm opcode (e.g., `i32.add`) based on the types.

### Bitwise Operators

- Bitwise AND (`&`), OR (`|`), XOR (`^`), shifts (`<<`, `>>`) and rotates (`<<<` for rotate left, `>>>` for rotate right).

### Comparison Operators

- Equality: `==` and `!=`
- Relational: `<`, `>`, `<=`, `>=`

---

## 8. Memory Management

Encantis does not include garbage collection. You must manage memory manually using, for instance, a bump allocator:

```ents
global mut heap_ptr:*u8 = INITIAL-HEAP-OFFSET

export "malloc" func malloc(size:i32) -> *u8 do
  local old_ptr = heap_ptr
  heap_ptr += size
  return old_ptr
end
```

- **Bump Allocator:**  
  A simple allocator that increases a global pointer (`heap_ptr`) by the requested size.
- **Data Segments:**  
  Literal strings and static data are embedded in the WebAssembly data segment.

---

## 9. Memory Types

Encantis distinguishes between four key memory types. In the headers below, `T` is a placeholder for any type (e.g., `u8` in examples).

1. **Pointers (`*T`):**  
   - Represent raw memory addresses.  
   - **Example:**  
     ```ents
     local mem:*u8 = malloc(10)
     local first_byte:u8 = mem.*   -- same as mem[0]
     ```

2. **Slices (`[T]`):**  
   - A slice is represented by two inlined values: a pointer and a length.  
   - **Example:**  
     ```ents
     local msg:[u8] = "Hello"   -- becomes a (pointer, length) pair
     print(msg)                 -- passes both pointer and length
     ```

3. **Null Terminated Arrays (`[T/0]`):**  
   - Like slices but with an automatically appended null terminator (`\0`), often used for C-style strings.  
   - **Example:**  
     ```ents
     local c_str:[u8/0] = "Goodbye"
     ```

4. **Fixed Length Arrays (`[T*L]`):**  
   - Arrays with a compile‑time constant length, where `L` is the length.  
   - **Example:**  
     ```ents
     local fixed:[u8*5] = "Hello"
     print(fixed as [u8])  -- coerces fixed array to a slice for printing
     ```

Each memory type is optimized for different use cases—from low‑level pointer arithmetic to safe and efficient handling of dynamic data.

---

## 10. Example Program

The following complete Encantis program demonstrates:
- Memory management using a bump allocator.
- Concatenation of two slices using the native `memory.copy` opcode (enabled by the WebAssembly bulk‑memory extension).
- Printing the concatenated result via an exported function.

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
  memory.copy(buf + a.len, b)    -- Copy slice b into buf starting at a.len.
  return (buf, len)
end

-- greet concatenates a literal with a host-supplied message and prints it.
export "greet" func greet(msg:[u8]) do
  print(concat("Hello ", msg))
end
```

**Explanation:**
- **Memory Allocation:**  
  A global bump pointer (`heap_ptr`) is used by `malloc` to allocate memory starting from `INITIAL-HEAP-OFFSET`.
- **Native Memory Copy:**  
  The built‑in `memory.copy` opcode is used in `concat` for efficient copying of byte slices.
- **Slice Concatenation:**  
  `concat` returns a new slice as a tuple (pointer, length).
- **Use of Literals:**  
  The literal `"Hello "` is stored as a fixed-length string (`[u8*6]`) and used as a slice (`[u8]`) when passed to `concat`.
- **Printing:**  
  The host function `print` accepts a slice and outputs the concatenated message.

---

## 11. Compilation and Interoperability

- **Compilation:**  
  Encantis source files (`.ents`) compile to WAT, then to a `.wasm` binary, which you can execute in Node.js, browsers, Bun, or any WebAssembly runtime.
  
- **Interfacing:**  
  Slices are designed to easily pass between WebAssembly and host code, represented simply as (pointer, length) pairs.
  
- **Data Segments:**  
  Static data (such as string literals) is embedded directly in the module’s data segment. For instance, `"Hello "` might be stored at a known offset (e.g., offset 0).

---

## 12. Additional Notes

- **Global Mutability:**  
  Updateable global variables must be declared with `global mut`.
- **Type Inference for Literals:**  
  Literal integers are initially abstract (`int`) and become concrete based on their usage or explicit annotations.
- **No Runtime Library:**  
  All functionality—memory management, string operations, etc.—must be programmed explicitly.
- **Direct WebAssembly Mapping:**  
  The language provides near one‑to‑one mappings to WebAssembly operations, such as using `memory.copy` for efficient memory transfers.
