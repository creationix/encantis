// =============================================================================
// From Zero to WebAssembly with Encantis
// A beginner's guide to the Encantis programming language
// =============================================================================

#set document(
  title: "From Zero to WebAssembly with Encantis",
  author: "The Encantis Team",
)

#set page(
  paper: "us-letter",
  margin: (x: 1.25in, y: 1in),
  numbering: "1",
  header: context {
    if counter(page).get().first() > 1 [
      #emph[From Zero to WebAssembly with Encantis]
      #h(1fr)
      #emph[Chapter #counter(heading).get().first()]
    ]
  },
)

#set text(
  font: "New Computer Modern",
  size: 11pt,
)

#set heading(numbering: "1.")

#set par(
  justify: true,
  leading: 0.65em,
)

#show heading.where(level: 1): it => {
  pagebreak(weak: true)
  v(2em)
  text(size: 24pt, weight: "bold", it)
  v(1em)
}

#show heading.where(level: 2): it => {
  v(1.5em)
  text(size: 14pt, weight: "bold", it)
  v(0.5em)
}

#show raw.where(block: true): it => {
  set text(size: 10pt)
  block(
    fill: luma(245),
    inset: 10pt,
    radius: 4pt,
    width: 100%,
    it,
  )
}

#show raw.where(block: false): it => {
  box(
    fill: luma(240),
    inset: (x: 3pt, y: 0pt),
    outset: (y: 3pt),
    radius: 2pt,
    it,
  )
}

// Custom callout boxes
#let note(body) = {
  block(
    fill: rgb("#e8f4f8"),
    inset: 12pt,
    radius: 4pt,
    width: 100%,
    [*Note:* #body],
  )
}

#let warning(body) = {
  block(
    fill: rgb("#fff3cd"),
    inset: 12pt,
    radius: 4pt,
    width: 100%,
    [*Warning:* #body],
  )
}

#let exercise(number, body) = {
  block(
    stroke: 1pt + luma(200),
    inset: 12pt,
    radius: 4pt,
    width: 100%,
    [*Exercise #number:* #body],
  )
}

// =============================================================================
// TITLE PAGE
// =============================================================================

#align(center)[
  #v(3cm)
  #text(size: 32pt, weight: "bold")[From Zero to WebAssembly]
  #v(0.5cm)
  #text(size: 24pt, weight: "bold")[with Encantis]
  #v(2cm)
  #text(size: 14pt)[_A Beginner's Guide_]
  #v(4cm)
  #text(size: 12pt)[The Encantis Team]
  #v(1fr)
  #text(size: 10pt, fill: luma(100))[Draft Edition]
]

#pagebreak()

// =============================================================================
// TABLE OF CONTENTS
// =============================================================================

#outline(
  title: [Contents],
  indent: 2em,
  depth: 2,
)

#pagebreak()

// =============================================================================
// CHAPTER 1: INTRODUCTION
// =============================================================================

= Introduction

Welcome to Encantis! This book will teach you a programming language designed for writing fast, efficient programs that run in web browsers and beyond.

== What is Encantis?

Encantis is a programming language that compiles to WebAssembly. If those words don't mean much to you yet, don't worry---we'll explain everything.

Think of Encantis as a bridge. On one side, you have ideas you want to express as a computer program. On the other side, you have WebAssembly, a low-level format that computers can execute very quickly. Encantis makes it easier to cross that bridge by giving you a readable, expressive syntax while still producing efficient code.

Here's a tiny taste of what Encantis looks like:

```ents
func add(a: i32, b: i32) -> i32
  => a + b
```

This defines a function called `add` that takes two numbers and returns their sum. Simple, right?

== What is WebAssembly?

WebAssembly (often abbreviated as "WASM") is a way to run programs very fast, especially in web browsers. When you visit a website with a game or a complex application, there's a good chance WebAssembly is involved.

Unlike languages like JavaScript that browsers interpret line by line, WebAssembly programs are compiled ahead of time into a compact binary format. This means they start faster and run more efficiently.

WebAssembly isn't just for browsers, though. It can run on servers, in embedded systems, and anywhere you need portable, fast code.

== Why Learn Encantis?

Learning Encantis teaches you several valuable skills at once:

- *Systems thinking*: You'll understand how computers actually work with memory and numbers
- *Type systems*: You'll learn how types prevent bugs before your program runs
- *Low-level programming*: You'll gain skills applicable to languages like C, Rust, and Zig
- *WebAssembly*: You'll understand the compilation target that's reshaping web development

Encantis is also relatively small. Unlike languages that take years to master, you can become productive in Encantis quickly. This book aims to teach you the entire language.

== How This Book is Organized

Each chapter introduces new concepts, explains them clearly, and shows examples. At the end of most chapters, you'll find exercises to practice what you've learned.

We recommend reading the chapters in order, as later chapters build on earlier ones. Don't skip the exercises---programming is learned by doing, not just reading.

Let's begin!

== Exercises

#exercise(1)[
  In your own words, explain what WebAssembly is and why it's useful. Write 2-3 sentences.
]

#exercise(2)[
  Think of a simple program you'd like to write (a calculator, a game, a utility). Keep this in mind as you learn---by the end of this book, you'll have the skills to build it.
]

// =============================================================================
// CHAPTER 2: YOUR FIRST PROGRAM
// =============================================================================

= Your First Program

Let's write some Encantis code! In this chapter, you'll learn the basic structure of an Encantis program and write your first function.

== The Simplest Program

Here's a complete Encantis program that does almost nothing:

```ents
export "_start"
func ()
end
```

Let's break this down:

- `export "_start"` tells WebAssembly that this function should be visible to the outside world, named `_start`
- `func ()` begins a function definition with no parameters
- `end` closes the function

This program is valid, but boring. Let's make it do something.

== A Function That Adds Numbers

```ents
export "add"
func add(a: i32, b: i32) -> i32
  => a + b
```

This is more interesting! Let's examine each part:

- `export "add"` makes this function available externally as "add"
- `func add` names the function `add`
- `(a: i32, b: i32)` declares two parameters, both of type `i32` (32-bit integer)
- `-> i32` declares that the function returns an `i32`
- `=> a + b` is a shorthand meaning "return the value of a + b"

#note[
  The `=>` arrow syntax is a shortcut for simple functions. It means "the result of this function is the following expression."
]

== The Longer Form

The same function can be written with explicit `return`:

```ents
export "add"
func add(a: i32, b: i32) -> i32
  return a + b
end
```

Or even more explicitly:

```ents
export "add"
func add(a: i32, b: i32) -> (result: i32)
  result = a + b
end
```

In this version, we name the return value `result`. When the function ends, whatever value is in `result` gets returned automatically.

All three versions produce identical WebAssembly code. Use whichever style feels clearest for your situation.

== Comments

Comments help explain your code. In Encantis, comments start with `--`:

```ents
-- This is a comment
func add(a: i32, b: i32) -> i32
  -- Add the two numbers together
  => a + b
```

Comments are ignored by the compiler. They're for humans reading the code.

#note[
  The `--` comment style comes from languages like Lua and Haskell. Some programmers find it more visually distinct than `//` used in C-style languages.
]

== Module Structure

Every Encantis file is a _module_. A module can contain:

- Imports (bringing in external functions)
- Exports (making things available externally)
- Functions
- Global variables
- Memory declarations
- Type definitions

Here's a more complete example showing several of these:

```ents
-- Import a function from the host environment
import "console" "log"
func log(message: [u8])

-- Declare some memory (1 page = 64KB)
memory 1

-- A global constant
global magic-number = 42:i32

-- An exported function
export "greet"
func greet()
  log("Hello, Encantis!")
end
```

Don't worry if you don't understand everything here yet. We'll cover each concept in detail in later chapters.

== Naming Conventions

Encantis allows hyphens in names, which is unusual:

```ents
func calculate-total-price(unit-price: i32, quantity: i32) -> i32
  => unit-price * quantity
```

This style (sometimes called "kebab-case") can make names more readable. However, you can also use underscores or camelCase if you prefer:

```ents
func calculateTotalPrice(unitPrice: i32, quantity: i32) -> i32
  => unitPrice * quantity
```

Choose a style and be consistent.

== Exercises

#exercise(1)[
  Write a function called `subtract` that takes two `i32` parameters and returns their difference.
]

#exercise(2)[
  Write a function called `square` that takes one `i32` parameter and returns its square (the number multiplied by itself).
]

#exercise(3)[
  Rewrite the `add` function using the explicit `result` variable style shown earlier.
]

// =============================================================================
// CHAPTER 3: TYPES AND VALUES
// =============================================================================

= Types and Values

Every value in Encantis has a _type_. Types tell the compiler what kind of data you're working with, which helps catch errors before your program runs.

== Numeric Types

Encantis has six main numeric types:

#table(
  columns: (auto, auto, auto),
  inset: 8pt,
  align: left,
  [*Type*], [*Description*], [*Range*],
  [`i32`], [Signed 32-bit integer], [-2,147,483,648 to 2,147,483,647],
  [`u32`], [Unsigned 32-bit integer], [0 to 4,294,967,295],
  [`i64`], [Signed 64-bit integer], [Much larger range],
  [`u64`], [Unsigned 64-bit integer], [0 to very large],
  [`f32`], [32-bit floating point], [Decimal numbers],
  [`f64`], [64-bit floating point], [More precise decimals],
)

=== Signed vs Unsigned

"Signed" integers can be negative. "Unsigned" integers are always zero or positive.

```ents
local temperature: i32 = -10   -- Signed: can be negative
local count: u32 = 100         -- Unsigned: always >= 0
```

Why have both? Unsigned integers can represent larger positive numbers. If you know a value will never be negative (like a count or an array index), using unsigned can be beneficial.

=== Integers vs Floating Point

Integers are whole numbers: 1, 42, -7, 1000000.

Floating point numbers have decimal parts: 3.14, -0.5, 2.71828.

```ents
local year: i32 = 2024      -- Integer
local pi: f64 = 3.14159     -- Floating point
```

#warning[
  Floating point arithmetic can have small rounding errors. `0.1 + 0.2` might not exactly equal `0.3`. This is a fundamental limitation of how computers represent decimal numbers, not specific to Encantis.
]

== Small Integer Types

For working with memory, Encantis also has smaller integer types:

#table(
  columns: (auto, auto),
  inset: 8pt,
  align: left,
  [*Type*], [*Description*],
  [`u8`], [Unsigned 8-bit (0 to 255) --- a byte],
  [`u16`], [Unsigned 16-bit (0 to 65,535)],
)

These are used primarily when reading from or writing to memory. We'll cover them more in the chapter on pointers and memory.

== Literals

A _literal_ is a value written directly in your code:

```ents
42          -- Integer literal
3.14        -- Float literal
"hello"     -- String literal
```

=== Integer Literals

Integer literals can be written in several formats:

```ents
42          -- Decimal
0xFF        -- Hexadecimal (255)
0b1010      -- Binary (10)
```

You can add type annotations to specify the exact type:

```ents
42:i32      -- Explicitly i32
42:u64      -- Explicitly u64
100:u8      -- Explicitly u8
```

Without an annotation, integer literals default to `i32`.

=== Float Literals

Float literals have a decimal point:

```ents
3.14        -- Defaults to f64
3.14:f32    -- Explicitly f32
```

=== String Literals

Strings are sequences of characters in double quotes:

```ents
"Hello, World!"
"Line 1\nLine 2"    -- \n is a newline
"Tab\there"         -- \t is a tab
```

Strings in Encantis become byte sequences in memory. We'll explore this more when we discuss slices.

== Type Annotations

When declaring variables or function parameters, you specify types with a colon:

```ents
local x: i32           -- x is an i32
local y: f64 = 3.14    -- y is an f64, initialized to 3.14
```

In many cases, types can be _inferred_ (figured out automatically):

```ents
local z = 42           -- z is i32 (inferred from literal)
local w = x + 10       -- w is i32 (inferred from expression)
```

#note[
  When you're learning, it's good practice to write type annotations explicitly. As you become more comfortable, you can let the compiler infer types where it's clear.
]

== Type Conversions

Sometimes you need to convert between types. Use `as` for explicit conversions:

```ents
local a: i32 = 100
local b: i64 = a as i64     -- Convert i32 to i64

local x: f64 = 3.7
local y: i32 = x as i32     -- Convert f64 to i32 (truncates to 3)
```

#warning[
  Converting from a larger type to a smaller type can lose information. Converting `1000:i32` to `u8` won't fit! Be careful with conversions.
]

== The Unit Type

The unit type `()` represents "nothing" or "no value". It's used for functions that don't return anything:

```ents
func print-hello() -> ()
  -- prints something but returns nothing
end
```

You can omit `-> ()` since returning nothing is the default:

```ents
func print-hello()
  -- same as above
end
```

== Exercises

#exercise(1)[
  What type would you use for:
  - A person's age?
  - The number of stars in a rating (1-5)?
  - A temperature that could be negative?
  - A precise scientific measurement?
]

#exercise(2)[
  Write the following literals with explicit type annotations:
  - The number 256 as a u32
  - The number 3.14159 as an f32
  - The number -1 as an i64
]

#exercise(3)[
  What happens if you try to store the value 300 in a `u8` variable? (Hint: what's the maximum value of a u8?)
]

// =============================================================================
// CHAPTER 4: VARIABLES
// =============================================================================

= Variables

Variables store values that your program can use and modify. Encantis has two kinds of variables: local and global.

== Local Variables

Local variables exist only within a function. They're declared with the `local` keyword:

```ents
func calculate() -> i32
  local x: i32 = 10
  local y: i32 = 20
  local sum: i32 = x + y
  => sum
end
```

=== Declaration and Initialization

You can declare a variable and initialize it in one step:

```ents
local count: i32 = 0           -- Declared and initialized
```

Or declare first, then assign later:

```ents
local count: i32               -- Declared (uninitialized)
count = 0                      -- Assigned
```

#warning[
  Using an uninitialized variable leads to undefined behavior. Always initialize your variables before using them.
]

=== Type Inference

If you provide an initial value, the type can be inferred:

```ents
local x = 42          -- x is i32 (inferred)
local y = 3.14        -- y is f64 (inferred)
local z = x + 10      -- z is i32 (inferred from x)
```

== Mutability

All local variables in Encantis are mutable by default---you can change their values:

```ents
local x = 10
x = 20          -- OK: x is now 20
x = x + 5       -- OK: x is now 25
```

== Global Variables

Global variables exist throughout the entire module. They're declared with the `global` keyword:

```ents
global PI = 3.14159:f64
global MAX-SIZE = 1024:u32
```

=== Immutable Globals

By default, globals are immutable (constant):

```ents
global ANSWER = 42:i32

func test()
  ANSWER = 100    -- ERROR! Cannot modify immutable global
end
```

=== Mutable Globals

Use `mut` to make a global mutable:

```ents
global mut counter: i32 = 0

func increment()
  counter = counter + 1   -- OK: counter is mutable
end
```

#note[
  Prefer immutable globals when possible. Mutable global state can make programs harder to understand and debug.
]

== Scope

A variable's _scope_ is where it can be used. Local variables are scoped to their function:

```ents
func first()
  local x = 10    -- x exists here
end

func second()
  local y = x     -- ERROR! x doesn't exist here
end
```

Variables declared inside blocks (like `if` or `while`) may have more limited scope:

```ents
func example()
  if condition then
    local temp = 42     -- temp exists only in this block
  end
  local y = temp        -- ERROR! temp doesn't exist here
end
```

== Assignment Operators

Encantis provides compound assignment operators for common operations:

```ents
local x = 10

x += 5      -- Same as: x = x + 5  (now 15)
x -= 3      -- Same as: x = x - 3  (now 12)
x *= 2      -- Same as: x = x * 2  (now 24)
x /= 4      -- Same as: x = x / 4  (now 6)
```

These also work for bitwise operations:

```ents
x &= 0xFF   -- Bitwise AND
x |= 0x01   -- Bitwise OR
x ^= 0x10   -- Bitwise XOR
x <<= 2     -- Left shift
x >>= 1     -- Right shift
```

== Multiple Assignment

Encantis supports assigning multiple variables at once using tuple syntax:

```ents
local (a, b) = (10, 20)    -- a = 10, b = 20
```

This is especially useful for swapping values:

```ents
(a, b) = (b, a)    -- Swap a and b!
```

The right side is evaluated completely before any assignment happens, so this swap works correctly without needing a temporary variable.

== Exercises

#exercise(1)[
  Write a function that declares three local variables for a person's name (as a number representing an ID for now), age, and height. Initialize them with reasonable values.
]

#exercise(2)[
  Write code that swaps two variables `x` and `y` using:
  - The tuple assignment method
  - A temporary variable (the traditional way)
]

#exercise(3)[
  Create a global mutable counter and two functions: `increment` that adds 1 to it, and `reset` that sets it back to 0.
]

// =============================================================================
// CHAPTER 5: FUNCTIONS
// =============================================================================

= Functions

Functions are the building blocks of Encantis programs. They let you organize code into reusable pieces.

== Defining Functions

The basic function syntax is:

```ents
func name(parameters) -> return-type
  body
end
```

Let's look at each part:

```ents
func greet(name: [u8]) -> ()
  -- function body here
end
```

- `func` keyword starts the definition
- `greet` is the function name
- `(name: [u8])` declares one parameter called `name` of type `[u8]` (a byte slice)
- `-> ()` indicates no return value
- `end` closes the function

== Parameters

Parameters are inputs to your function. Each parameter needs a name and type:

```ents
func add(a: i32, b: i32) -> i32
  => a + b
```

You can have any number of parameters:

```ents
func no-params() -> i32
  => 42

func one-param(x: i32) -> i32
  => x * 2

func three-params(x: i32, y: i32, z: i32) -> i32
  => x + y + z
```

#note[
  Parameters can be separated by commas or spaces. Both `(a: i32, b: i32)` and `(a: i32 b: i32)` are valid.
]

== Return Values

Functions can return values using several styles:

=== Arrow Syntax

For simple, single-expression functions:

```ents
func double(x: i32) -> i32
  => x * 2
```

=== Explicit Return

For more complex functions:

```ents
func absolute(x: i32) -> i32
  if x < 0 then
    return -x
  else
    return x
  end
end
```

=== Named Returns

You can name return values and they're returned automatically:

```ents
func divide(a: i32, b: i32) -> (quotient: i32)
  quotient = a / b
  -- quotient is returned when function ends
end
```

== Multiple Return Values

Functions can return multiple values using tuples:

```ents
func divmod(a: i32, b: i32) -> (i32, i32)
  => (a / b, a % b)
```

Call it and capture both values:

```ents
local (quot, rem) = divmod(17, 5)
-- quot = 3, rem = 2
```

With named returns:

```ents
func divmod(a: i32, b: i32) -> (quotient: i32, remainder: i32)
  quotient = a / b
  remainder = a % b
end
```

== Calling Functions

Call a function by writing its name followed by arguments in parentheses:

```ents
local result = add(3, 5)           -- result = 8
local (q, r) = divmod(10, 3)       -- q = 3, r = 1
```

Functions can call other functions:

```ents
func square(x: i32) -> i32
  => x * x

func sum-of-squares(a: i32, b: i32) -> i32
  => square(a) + square(b)
```

== Recursive Functions

Functions can call themselves. This is called _recursion_:

```ents
func factorial(n: i32) -> i32
  if n <= 1 then
    return 1
  else
    return n * factorial(n - 1)
  end
end
```

#warning[
  Recursive functions must have a base case (like `n <= 1` above) or they'll run forever!
]

== Exporting Functions

To make a function callable from outside your module, use `export`:

```ents
export "add"
func add(a: i32, b: i32) -> i32
  => a + b
```

The string `"add"` is the name that external code uses. It can be different from the function name:

```ents
export "addition"
func add(a: i32, b: i32) -> i32
  => a + b
```

== Importing Functions

To use functions from outside your module, use `import`:

```ents
import "console" "log"
func log(message: [u8])
```

This imports a function called `log` from a module called `console`. The function signature tells Encantis what parameters and return type to expect.

== Anonymous Functions

You can create functions without names:

```ents
local double = (x: i32) => x * 2
local result = double(5)    -- result = 10
```

This is useful for passing functions as arguments or storing them in variables.

== The Pipe Operator

Encantis has a pipe operator `|>` for chaining function calls:

```ents
local result = value
  |> process-first(%)
  |> process-second(%)
  |> finalize(%)
```

The `%` placeholder receives the piped value. This is equivalent to:

```ents
local result = finalize(process-second(process-first(value)))
```

The pipe version reads top-to-bottom, which many find clearer.

== Exercises

#exercise(1)[
  Write a function `max` that takes two `i32` values and returns the larger one.
]

#exercise(2)[
  Write a function `clamp` that takes three parameters: a value, a minimum, and a maximum. It should return the value if it's between min and max, otherwise return the nearest boundary.
]

#exercise(3)[
  Write a recursive function `fibonacci` that computes the nth Fibonacci number. (Fibonacci: 0, 1, 1, 2, 3, 5, 8, 13, ...)
]

#exercise(4)[
  Write a function `distance` that takes four `f64` parameters (x1, y1, x2, y2) and returns the distance between two points. You'll need to use `sqrt` (assume it's imported).
]

// =============================================================================
// CHAPTER 6: OPERATORS AND EXPRESSIONS
// =============================================================================

= Operators and Expressions

Operators combine values into expressions. Encantis has operators for arithmetic, comparison, logic, and bit manipulation.

== Arithmetic Operators

These work on numeric types:

#table(
  columns: (auto, auto, auto),
  inset: 8pt,
  align: left,
  [*Operator*], [*Name*], [*Example*],
  [`+`], [Addition], [`5 + 3` = 8],
  [`-`], [Subtraction], [`5 - 3` = 2],
  [`*`], [Multiplication], [`5 * 3` = 15],
  [`/`], [Division], [`7 / 3` = 2 (integer)],
  [`%`], [Modulo (remainder)], [`7 % 3` = 1],
)

#note[
  Integer division truncates toward zero. `7 / 3` is `2`, not `2.33`. For decimal results, use floating point types.
]

=== Signed vs Unsigned Division

Division and modulo behave differently for signed vs unsigned types:

```ents
local a: i32 = -7
local b: i32 = 3
local result = a / b    -- -2 (signed division)

local x: u32 = 7
local y: u32 = 3
local result2 = x / y   -- 2 (unsigned division)
```

== Comparison Operators

These compare values and return `i32` (0 for false, 1 for true):

#table(
  columns: (auto, auto, auto),
  inset: 8pt,
  align: left,
  [*Operator*], [*Name*], [*Example*],
  [`==`], [Equal], [`5 == 5` is true],
  [`!=`], [Not equal], [`5 != 3` is true],
  [`<`], [Less than], [`3 < 5` is true],
  [`>`], [Greater than], [`5 > 3` is true],
  [`<=`], [Less or equal], [`3 <= 3` is true],
  [`>=`], [Greater or equal], [`5 >= 5` is true],
)

```ents
local age: i32 = 25
local is-adult = age >= 18          -- 1 (true)
local is-teenager = age >= 13 and age <= 19  -- 0 (false)
```

== Logical Operators

These work with boolean values (0 = false, non-zero = true):

#table(
  columns: (auto, auto, auto),
  inset: 8pt,
  align: left,
  [*Operator*], [*Name*], [*Behavior*],
  [`and`], [Logical AND], [True if both sides true],
  [`or`], [Logical OR], [True if either side true],
  [`not`], [Logical NOT], [Inverts truth value],
)

```ents
local a = 1     -- true
local b = 0     -- false

local c = a and b    -- 0 (false: both must be true)
local d = a or b     -- 1 (true: at least one is true)
local e = not a      -- 0 (inverts true to false)
```

== Bitwise Operators

These operate on the individual bits of integers:

#table(
  columns: (auto, auto, auto),
  inset: 8pt,
  align: left,
  [*Operator*], [*Name*], [*Description*],
  [`&`], [AND], [1 if both bits are 1],
  [`|`], [OR], [1 if either bit is 1],
  [`^`], [XOR], [1 if bits differ],
  [`~`], [NOT], [Flip all bits],
  [`<<`], [Left shift], [Shift bits left],
  [`>>`], [Right shift], [Shift bits right],
  [`<<<`], [Rotate left], [Rotate bits left],
  [`>>>`], [Rotate right], [Rotate bits right],
)

=== Examples

```ents
local a: u32 = 0b1100    -- 12 in binary
local b: u32 = 0b1010    -- 10 in binary

local c = a & b    -- 0b1000 = 8  (AND)
local d = a | b    -- 0b1110 = 14 (OR)
local e = a ^ b    -- 0b0110 = 6  (XOR)
```

=== Shifts

Left shift multiplies by powers of 2:

```ents
local x: u32 = 5
local y = x << 1    -- 10 (5 * 2)
local z = x << 3    -- 40 (5 * 8)
```

Right shift divides by powers of 2:

```ents
local x: u32 = 40
local y = x >> 1    -- 20 (40 / 2)
local z = x >> 2    -- 10 (40 / 4)
```

=== Rotations

Rotations wrap bits around instead of losing them:

```ents
local x: u32 = 0x80000001
local y = x <<< 1    -- Rotates left, wrapping high bit to low
```

This is useful in cryptographic algorithms like XXH64.

== The Ternary Operator

A compact way to choose between two values:

```ents
local result = condition ? value-if-true : value-if-false
```

Example:

```ents
local max = a > b ? a : b    -- Returns larger of a and b
local abs = x < 0 ? -x : x   -- Returns absolute value
```

== Operator Precedence

Operators have different priorities. Multiplication happens before addition:

```ents
local result = 2 + 3 * 4    -- 14, not 20
```

Use parentheses to control order:

```ents
local result = (2 + 3) * 4  -- 20
```

When in doubt, use parentheses! They make your intent clear.

General precedence (highest to lowest):
1. Unary: `-`, `not`, `~`
2. Multiplicative: `*`, `/`, `%`
3. Additive: `+`, `-`
4. Shifts: `<<`, `>>`, `<<<`, `>>>`
5. Comparison: `<`, `>`, `<=`, `>=`, `==`, `!=`
6. Bitwise: `&`, `^`, `|`
7. Logical: `and`, `or`
8. Ternary: `? :`

== Exercises

#exercise(1)[
  What is the value of each expression?
  - `10 + 5 * 2`
  - `(10 + 5) * 2`
  - `17 % 5`
  - `8 >> 2`
]

#exercise(2)[
  Write an expression that:
  - Checks if a number is even (hint: use `%`)
  - Checks if a number is between 1 and 100 (inclusive)
  - Returns the larger of two numbers using the ternary operator
]

#exercise(3)[
  If `x = 0b1010` and `y = 0b1100`, what is:
  - `x & y`
  - `x | y`
  - `x ^ y`
]

// =============================================================================
// CHAPTER 7: CONTROL FLOW
// =============================================================================

= Control Flow

Control flow statements let your program make decisions and repeat actions.

== If Statements

Execute code conditionally:

```ents
if condition then
  -- code runs if condition is true
end
```

With an else branch:

```ents
if score >= 60 then
  pass()
else
  fail()
end
```

Multiple conditions with elif:

```ents
if score >= 90 then
  grade = 'A'
elif score >= 80 then
  grade = 'B'
elif score >= 70 then
  grade = 'C'
else
  grade = 'F'
end
```

#note[
  A condition is "true" if it's non-zero, "false" if it's zero. This matches WebAssembly's semantics.
]

== While Loops

Repeat while a condition is true:

```ents
local count = 0
while count < 10 do
  count += 1
end
-- count is now 10
```

The condition is checked before each iteration. If it's false initially, the body never runs.

=== Breaking Out Early

Use `break` to exit a loop immediately:

```ents
local i = 0
while i < 100 do
  if found-it then
    break        -- Exit the loop
  end
  i += 1
end
```

== For-In Loops

Encantis has convenient `for-in` loops for common iteration patterns.

=== Iterating Over Numbers

```ents
-- Iterate from 0 to 9
for i in 10 do
  process(i)
end
```

This is equivalent to:

```ents
local i = 0
while i < 10 do
  process(i)
  i += 1
end
```

=== Explicit Ranges

For more control, specify start, end, and step:

```ents
-- Count down from 10 to 1
for i in (10, 1, -1) do
  countdown(i)
end
```

The syntax is `(start, end, step)`. The loop continues while the variable hasn't passed the end value.

=== Iterating Over Slices

```ents
local message: [u8] = "Hello"

-- Iterate over each byte
for byte in message do
  process(byte)
end
```

With index and value:

```ents
for (index, byte) in message do
  process-at(index, byte)
end
```

== Basic Loop

For unconditional looping:

```ents
loop
  -- body
  br                     -- Jump back to loop start
end
```

Use `br when condition` for conditional continuation:

```ents
loop
  process()
  br when should-continue    -- Continue if true
end
-- Falls through when condition is false
```

== Forever Loop

An infinite loop (must break or return to exit):

```ents
forever
  if done then
    break
  end
  do-work()
end
```

== Conditional Returns

You can return conditionally in one line:

```ents
func find(needle: i32, haystack: [i32]) -> i32
  for (i, value) in haystack do
    return i when value == needle    -- Return immediately if found
  end
  return -1    -- Not found
end
```

== Nested Loops

Loops can be nested. `break` exits only the innermost loop:

```ents
for row in 10 do
  for col in 10 do
    if grid[row][col] == target then
      break    -- Exits only the col loop
    end
  end
  -- Continues with next row
end
```

== Exercises

#exercise(1)[
  Write a function `count-down` that takes an `i32` parameter `n` and prints numbers from `n` down to 1.
]

#exercise(2)[
  Write a function `sum-to-n` that returns the sum of all integers from 1 to n. Use a while loop.
]

#exercise(3)[
  Write a function `find-first-space` that takes a `[u8]` string and returns the index of the first space character (32 in ASCII), or -1 if not found. Use a for-in loop.
]

#exercise(4)[
  Write a function that computes `x^n` (x raised to the power n) using a loop. Assume n >= 0.
]

// =============================================================================
// CHAPTER 8: ARRAYS AND SLICES
// =============================================================================

= Arrays and Slices

Arrays and slices let you work with sequences of values.

== Slices: `[T]`

A slice is a view into a sequence of values. It consists of:
- A pointer to the first element
- A length (number of elements)

```ents
local message: [u8] = "Hello"
-- message.ptr points to 'H'
-- message.len is 5
```

=== Creating Slices

String literals automatically become slices when needed:

```ents
local greeting: [u8] = "Hello, World!"
```

=== Accessing Elements

Use square brackets with an index (starting from 0):

```ents
local first = message[0]     -- 'H' (72 in ASCII)
local second = message[1]    -- 'e' (101 in ASCII)
local last = message[message.len - 1]
```

#warning[
  Encantis does not check array bounds at runtime. Accessing `message[100]` when length is 5 will read invalid memory!
]

=== Slice Properties

Every slice has `.ptr` and `.len`:

```ents
local data: [u8] = "Hello"
local pointer = data.ptr    -- Memory address of first byte
local length = data.len     -- 5
```

=== Modifying Slice Views

You can adjust a slice to view a subset:

```ents
-- Move past first 2 bytes
data.ptr += 2
data.len -= 2
-- data now represents "llo"
```

This doesn't copy data---it just changes what portion you're viewing.

== Fixed-Length Arrays: `[T*N]`

When the length is known at compile time, use fixed-length syntax:

```ents
local buffer: [u8*10]        -- Exactly 10 bytes
local state: [u32*12]        -- Exactly 12 u32 values
```

=== Advantages

- Only stores a pointer (length is known from type)
- Passed by reference efficiently
- Compiler knows exact size for optimizations

```ents
func process-state(state: [u32*12])
  for i in 12 do
    state[i] = state[i] * 2
  end
end
```

== Null-Terminated Arrays: `[T/0]`

C-style strings use a null byte (0) to mark the end:

```ents
local cstring: [u8/0] = "Hello"
-- Stored as: H e l l o \0
```

The length isn't stored; you find it by scanning for the null:

```ents
for char in cstring do
  -- Automatically stops at null
  process(char)
end
```

== Nested Arrays

Arrays can contain other arrays:

```ents
local matrix: [[i32]]        -- Slice of slices
local strings: [[u8]]        -- Slice of strings
```

Fixed-size version:

```ents
local grid: [[i32*3]*3]      -- 3x3 grid
```

== Iteration Patterns

=== Simple Iteration

```ents
for value in array do
  process(value)
end
```

=== With Index

```ents
for (i, value) in array do
  array[i] = value * 2
end
```

=== Manual Iteration

For more control:

```ents
local i = 0
while i < array.len do
  process(array[i])
  i += 1
end
```

== Common Operations

=== Finding an Element

```ents
func find(needle: u8, haystack: [u8]) -> i32
  for (i, byte) in haystack do
    return i when byte == needle
  end
  return -1
end
```

=== Summing Elements

```ents
func sum(numbers: [i32]) -> i32
  local total = 0
  for n in numbers do
    total += n
  end
  => total
end
```

=== Copying Data

```ents
func copy(dest: [u8], src: [u8])
  for i in src.len do
    dest[i] = src[i]
  end
end
```

== Memory Layout

Understanding how arrays are stored helps you use them effectively:

- `[u8]` slice: 8 bytes (4-byte pointer + 4-byte length)
- `[u32]` slice: 8 bytes (same structure)
- `[u8*10]`: Just a pointer (4 bytes), length known from type
- `[u8/0]`: Just a pointer, length computed at runtime

The actual data is elsewhere in memory, pointed to by the pointer.

== Exercises

#exercise(1)[
  Write a function `count-char` that counts how many times a byte appears in a `[u8]` slice.
]

#exercise(2)[
  Write a function `reverse` that reverses a `[u8]` array in place. (Hint: swap first with last, second with second-to-last, etc.)
]

#exercise(3)[
  Write a function `starts-with` that checks if one `[u8]` slice starts with another. Return 1 for true, 0 for false.
]

// =============================================================================
// CHAPTER 9: POINTERS AND MEMORY
// =============================================================================

= Pointers and Memory

Encantis gives you direct control over memory through pointers. This chapter explains how memory works and how to manipulate it safely.

== Linear Memory

WebAssembly uses _linear memory_: a single, contiguous array of bytes. Think of it as a giant array that your program can read from and write to.

```ents
memory 1    -- Allocate 1 page (64 KB) of memory
```

Each page is 64 kilobytes. You can allocate multiple pages:

```ents
memory 10   -- Allocate 10 pages (640 KB)
```

== Pointers

A pointer is a number representing a memory address. In Encantis (and WebAssembly), pointers are 32-bit unsigned integers.

```ents
local ptr: *u8           -- Pointer to a byte
local data-ptr: *u32     -- Pointer to a 32-bit integer
local array-ptr: *[u8]   -- Pointer to a byte slice
```

== Dereferencing

To read the value at a pointer's address, use `.*`:

```ents
local ptr: *u32 = some-address
local value = ptr.*      -- Load the u32 at that address
```

To write to that address:

```ents
ptr.* = 42              -- Store 42 at the pointer's address
```

== Pointer Arithmetic

You can add to pointers to move through memory:

```ents
local ptr: *u8 = start-address
ptr += 1                -- Move to next byte
ptr += 10               -- Skip 10 bytes
```

#warning[
  Pointer arithmetic is in bytes, regardless of the pointer type. Moving a `*u32` pointer by 1 moves 1 byte, not 4!
]

To move by element size:

```ents
local ptr: *u32 = array-start
ptr += 4                -- Move to next u32 (4 bytes)
```

== Type-Specific Loads

You can load memory as different types:

```ents
local ptr: *u8 = address
local byte = ptr.*           -- Load as u8
local word = (ptr as *u32).* -- Load as u32 (4 bytes)
```

Or use property syntax:

```ents
local byte = ptr.u8         -- Load as u8
local word = ptr.u32        -- Load as u32
```

== Memory Declaration and Data Sections

Static data can be placed in memory at compile time:

```ents
export "memory"
memory 1

data 0 (
  greeting -> "Hello, World!":[u8]
)
```

This places the string at memory address 0. The label `greeting` becomes a compile-time constant.

== Working with Slices in Memory

A slice is stored as two values: pointer and length. When you have a slice, you can access its components:

```ents
local msg: [u8] = "Hello"
local ptr = msg.ptr      -- Address of 'H'
local len = msg.len      -- 5
```

You can manually construct a slice from pointer and length:

```ents
local my-slice = (some-ptr, some-len) as [u8]
```

== Memory Operations

=== Memory Copy

Copy bytes from one location to another:

```ents
memcpy(dest-ptr, src-ptr, byte-count)
```

Or copy a slice:

```ents
memory.copy(dest-ptr, source-slice)
```

=== Fill Memory

Fill an array with a value:

```ents
state.fill(0)    -- Set all elements to 0
```

== A Practical Example: Simple Allocator

Here's a basic memory allocator:

```ents
global mut heap-ptr: *u8 = 1024  -- Start heap at offset 1024

func alloc(size: u32) -> *u8
  local result = heap-ptr
  heap-ptr += size
  => result
end
```

#warning[
  This simple allocator never frees memory! Real allocators are much more complex.
]

== Safety Considerations

Encantis does not have:
- Automatic bounds checking
- Garbage collection
- Null pointer protection

You are responsible for:
- Not reading/writing past array bounds
- Not using freed memory
- Not dereferencing invalid pointers

These responsibilities give you control but require care.

== Exercises

#exercise(1)[
  Write a function that takes a `*u8` pointer and a length, and returns the sum of all bytes at that location.
]

#exercise(2)[
  Write a function `zero-memory` that takes a `*u8` pointer and a length, and sets all bytes to zero.
]

#exercise(3)[
  Explain what would happen if you tried to read from address 1,000,000 when you only allocated 1 page (64KB) of memory.
]

// =============================================================================
// CHAPTER 10: COMPOUND TYPES
// =============================================================================

= Compound Types

Compound types let you group related values together.

== Tuples

A tuple is an ordered collection of values:

```ents
local point: (f32, f32) = (3.0, 4.0)
local result: (i32, i32) = (10, 20)
```

=== Accessing Tuple Elements

Use `.1`, `.2`, etc. (1-indexed):

```ents
local x = point.1    -- 3.0
local y = point.2    -- 4.0
```

=== Destructuring

Unpack a tuple into separate variables:

```ents
local (x, y) = point
-- x = 3.0, y = 4.0
```

=== Multiple Return Values

Tuples are how functions return multiple values:

```ents
func minmax(a: i32, b: i32) -> (i32, i32)
  if a < b then
    => (a, b)
  else
    => (b, a)
  end
end

local (minimum, maximum) = minmax(10, 5)
-- minimum = 5, maximum = 10
```

== Structs

Structs are like tuples but with named fields:

```ents
local person = {
  age = 25,
  height = 180
}
```

=== Accessing Fields

```ents
local a = person.age       -- 25
local h = person.height    -- 180
```

=== Destructuring Structs

```ents
local { age, height } = person
-- age = 25, height = 180
```

=== Struct Types

The type of a struct lists its fields:

```ents
local point: { x: f32, y: f32 } = { x = 1.0, y = 2.0 }
```

== Type Aliases

Create shorter names for complex types:

=== Interface (Alias)

An interface creates an alias that's interchangeable with the original:

```ents
interface Point = (f32, f32)

local p: Point = (3.0, 4.0)
local q: (f32, f32) = p      -- OK: same type
```

=== Unique Type

A unique type requires explicit conversion:

```ents
type UserId = u32
type ProductId = u32

local user: UserId = UserId(42)
local product: ProductId = ProductId(42)

-- user = product    -- ERROR: different types!
```

This prevents accidentally mixing values that happen to have the same underlying representation.

== Structural Subtyping

Structs with more fields can be used where fewer are expected:

```ents
local point3d = { x = 1.0, y = 2.0, z = 3.0 }

func distance2d(p: { x: f32, y: f32 }) -> f32
  => sqrt(p.x * p.x + p.y * p.y)

local d = distance2d(point3d)  -- OK: z is ignored
```

The function only sees the fields it asked for.

== Memory Representation

Tuples and structs are flattened into separate values:

```ents
local point: (f32, f32) = (3.0, 4.0)
```

Becomes two separate local variables internally:

```wat
(local $point_1 f32)
(local $point_2 f32)
```

There's no runtime overhead for using compound types---they're a compile-time organization tool.

== Exercises

#exercise(1)[
  Create a tuple type for representing a color as (red, green, blue) where each component is a `u8`.
]

#exercise(2)[
  Write a function that takes two points as `{ x: f32, y: f32 }` and returns their midpoint.
]

#exercise(3)[
  Create unique types for `Meters` and `Feet` (both `f32` underneath). Write functions to convert between them.
]

// =============================================================================
// CHAPTER 11: PUTTING IT ALL TOGETHER
// =============================================================================

= Putting It All Together

Let's build a complete program that demonstrates everything you've learned.

== A Sum Function

We'll build a function that sums all bytes in a slice:

```ents
export "sum-bytes"
func sum-bytes(data: [u8]) -> (total: u32)
  total = 0
  for byte in data do
    total += byte
  end
end
```

Let's trace through what happens:

1. Function receives a slice (pointer + length)
2. Initialize `total` to 0
3. Loop through each byte
4. Add each byte to total
5. Return total automatically (named return)

== A More Complex Example: Counting Characters

Count how many times a specific character appears:

```ents
export "count-char"
func count-char(text: [u8], target: u8) -> (count: u32)
  count = 0
  for char in text do
    if char == target then
      count += 1
    end
  end
end
```

== Finding a Substring

Check if one slice contains another:

```ents
export "contains"
func contains(haystack: [u8], needle: [u8]) -> u32
  -- Can't contain something longer
  return 0 when needle.len > haystack.len

  -- Check each possible starting position
  for i in (haystack.len - needle.len + 1) do
    local found = 1

    -- Check if needle matches at position i
    for j in needle.len do
      if haystack[i + j] != needle[j] then
        found = 0
        break
      end
    end

    return 1 when found == 1
  end

  => 0  -- Not found
end
```

== A Hash Function Structure

Here's a simplified structure of the XXH64 hash from the examples:

```ents
-- Constants
global prime1 = 11400714785074694791:u64
global prime2 = 14029467366897019727:u64

-- Helper function
func round(acc: u64, value: u64) -> (acc: u64)
  acc += value * prime2
  acc <<<= 31          -- Rotate left
  acc *= prime1
end

-- Main hash function (simplified)
export "hash"
func hash(data: [u8], seed: u64) -> (h: u64)
  h = seed

  for byte in data do
    h ^= byte * prime1
    h <<<= 11
    h *= prime1
  end

  -- Finalization
  h ^= h >> 33
  h *= prime2
  h ^= h >> 29
end
```

This demonstrates:
- Global constants
- Helper functions
- Bitwise operations (XOR, rotate, shift)
- Loop iteration over slices

== Complete Module Structure

Here's a template for a complete module:

```ents
-- Imports
import "env" "log"
func log(message: [u8])

-- Memory
export "memory"
memory 1

-- Constants
global VERSION = 1:u32

-- Helper functions
func helper(x: i32) -> i32
  => x * 2
end

-- Exported functions
export "main"
func main(input: [u8]) -> u32
  local result = 0

  for byte in input do
    result += helper(byte)
  end

  log("Processing complete")
  => result
end
```

== What You've Learned

Congratulations! You now understand:

- *Types*: Primitives, pointers, slices, tuples, structs
- *Variables*: Local and global, mutable and immutable
- *Functions*: Parameters, returns, recursion
- *Operators*: Arithmetic, comparison, logical, bitwise
- *Control flow*: Conditionals, loops, early returns
- *Memory*: Linear memory, pointers, data sections

== Next Steps

To continue learning:

1. *Study the examples*: The `examples/` directory has real-world code
2. *Write your own programs*: The best way to learn is by doing
3. *Read the generated WAT*: Understanding the output helps you write better code
4. *Explore WebAssembly*: Learn about the runtime environment

== Final Exercise

#exercise("Final")[
  Write a complete Encantis module that:

  1. Exports a function `process-text` that takes a `[u8]` string
  2. Returns the count of vowels (a, e, i, o, u---both cases)
  3. Uses at least one helper function
  4. Uses appropriate types and control flow

  This exercise combines everything you've learned!
]

// =============================================================================
// APPENDIX: QUICK REFERENCE
// =============================================================================

= Appendix: Quick Reference

== Types

#table(
  columns: (auto, auto),
  inset: 8pt,
  align: left,
  [*Type*], [*Description*],
  [`i32`], [Signed 32-bit integer],
  [`u32`], [Unsigned 32-bit integer],
  [`i64`], [Signed 64-bit integer],
  [`u64`], [Unsigned 64-bit integer],
  [`f32`], [32-bit float],
  [`f64`], [64-bit float],
  [`u8`], [Unsigned byte],
  [`*T`], [Pointer to T],
  [`[T]`], [Slice of T (ptr + len)],
  [`[T*N]`], [Fixed array of N elements],
  [`[T/0]`], [Null-terminated array],
  [`(T1, T2)`], [Tuple],
  [`{a: T}`], [Struct],
)

== Operators

#table(
  columns: (auto, auto, auto),
  inset: 6pt,
  align: left,
  [*Category*], [*Operators*], [*Notes*],
  [Arithmetic], [`+`, `-`, `*`, `/`, `%`], [Division truncates for integers],
  [Comparison], [`==`, `!=`, `<`, `>`, `<=`, `>=`], [Return 0 or 1],
  [Logical], [`and`, `or`, `not`], [0 = false, non-zero = true],
  [Bitwise], [`&`, `|`, `^`, `~`], [Operate on bits],
  [Shift], [`<<`, `>>`], [Left/right shift],
  [Rotate], [`<<<`, `>>>`], [Left/right rotate],
  [Ternary], [`? :`], [`cond ? a : b`],
)

== Control Flow

```ents
-- Conditionals
if cond then ... end
if cond then ... else ... end
if cond then ... elif cond then ... else ... end

-- Loops
while cond do ... end
for i in N do ... end
for i in (start, end, step) do ... end
for value in slice do ... end
for (i, value) in slice do ... end
loop ... br ... end
forever ... break ... end

-- Exit
return value
return value when condition
break
br
br when condition
```

== Function Syntax

```ents
-- Basic
func name(param: Type) -> ReturnType
  body
end

-- Arrow (single expression)
func name(param: Type) -> Type => expression

-- Named return
func name(param: Type) -> (result: Type)
  result = ...
end

-- Multiple returns
func name() -> (Type1, Type2)
  => (value1, value2)
end

-- Export
export "external-name"
func name() ...

-- Import
import "module" "name"
func name(params) -> Type
```

== Memory

```ents
memory N                    -- Declare N pages
ptr.*                       -- Dereference
ptr.T                       -- Load as type T
ptr += offset               -- Pointer arithmetic
slice.ptr                   -- Slice pointer
slice.len                   -- Slice length
slice[i]                    -- Element access
```

== Keywords

`func`, `local`, `global`, `mut`, `export`, `import`, `memory`, `data`,
`if`, `then`, `elif`, `else`, `end`, `while`, `do`, `for`, `in`, `loop`,
`forever`, `break`, `br`, `when`, `return`, `as`, `and`, `or`, `not`,
`interface`, `type`, `define`

#v(2em)
#align(center)[
  #text(size: 14pt, style: "italic")[
    Happy coding with Encantis!
  ]
]
