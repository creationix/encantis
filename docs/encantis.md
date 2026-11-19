# Encantis Language Reference

Encantis is a systems programming language that compiles to WebAssembly. A program is one or more source files (`.ents`), and they compile to one WebAssembly module. The language gives direct control of linear memory and has explicit types, and it has no hidden runtime: no garbage collector, no built-in allocator, and no code that the source does not ask for. How a construct maps to WebAssembly is part of the language and is stated where the construct is described: a struct is held in registers, one wasm value per field; a slice is two `i32`s, an address and a length; a loop over a range is a wasm `loop`, and an index the compiler can prove in range is a plain load.

This reference describes the whole language: its syntax as it is written, what each construct means, what is an error, what traps at run time, and how values are laid out in WebAssembly. [`docs/grammar.md`](grammar.md) has the grammar in EBNF, for depth; nothing here depends on it.

## About This Reference

### Examples

Source code is shown in `ents` code blocks. The examples that the compiler can process are run by the project's test suite (`bun test spec`): each is parsed and checked, a whole program is also compiled to WebAssembly and validated, and its `test` blocks are run. So an `assert` in an example states what the compiled program computes.

- A short example can be a fragment: a few statements or an expression without the function around them, or a declaration that uses names declared elsewhere.
- A `test "name" { ... }` block shows results with `assert` ([Tests](#tests)).
- A code block marked `errors` after an example says that the example is refused. Each of its lines is the gist of one error the compiler reports, in the order reported; the full message can say more.
- A code block marked `ents same-wasm` after an example is a second program that compiles to exactly the same `.wasm` file. This is how the reference shows that a feature costs nothing.
- A `text` block holds output, code for another language, or a program of several files.
- A feature that is designed but not implemented is labelled **Not implemented** where it is described, and its examples are not working code. [Implementation Status](#implementation-status) lists every such feature.

### Tools

The compiler's command-line tool is `encantis`:

| Command | What it does |
|---|---|
| `encantis check <file>` | Parses and checks a program, its `test` blocks included; prints each error as `file:line:col: message` |
| `encantis compile <file> [-o out.wat]` | Writes the program as WebAssembly text (WAT) |
| `encantis wasm <file> [-o out.wasm]` | Writes the binary module; `-O` also optimizes it with binaryen, `--release` optimizes harder for size |
| `encantis run <file> [args...]` | Compiles a WASI program and runs its `_start` export, with standard input and output |
| `encantis test <file or directory>` | Runs the `test` blocks of each file ([Tests](#tests)) |
| `encantis fmt <file...>` | Formats source files in place; `fmt --check` only reports the files that need it |
| `encantis ast <file>` | Prints the syntax tree as JSON |

`<file>` is the program's entry module: the files it imports are found from it ([7.1](#71-imports)). The commands `hover`, `definition`, `references`, `symbols`, `signature` and `rename` answer an editor's questions, `meta` prints what the editor is told about a file (its symbols, types, hints and warnings) as JSON, and the VS Code extension in `packages/extension` uses the same compiler for its diagnostics and hovers.

Besides errors, the checker gives warnings, which never stop a build: `'f' is never used` ([3](#3-declarations)), `'max' replaces the builtin max in this module` ([10](#10-builtin-functions)), `memset length is not a compile-time constant — cannot verify bounds (buffer is 8 bytes)` ([10.3](#103-memory-builtins)), `exported function parameter 'p' uses [*] many-pointer — consider []u8 slice for a safe API` ([7.2](#what-the-host-sees)) and `imported generic types are resolved only when the program is checked` ([7.1](#source-modules)). The editor and `meta` show them; `check`, `compile`, `wasm` and `test` do not print them (a known bug).

### A First Program

<!-- spec:begin compile -->

```ents
func is_vowel(c: u8) -> bool => match c {
  'a', 'e', 'i', 'o', 'u' => true
  _ => false
}

// The number of vowels in text
export func vowels(text: []u8) -> (n: u32) {
  for c in text {
    if is_vowel(c) { n += 1 }
  }
}

test "vowels counts a, e, i, o and u" {
  assert vowels("encantis") == 3
  assert vowels("") == 0
}
```

<!-- spec:end -->

A module is a list of declarations, in any order. `vowels` is exported, so the host can call it: in WebAssembly it is a function exported as `vowels` with two `i32` parameters, the address and the length of `text`, and one `i32` result. `is_vowel` is not exported, and is called directly. A slice (`[]u8`) is a view of bytes in the module's memory; `"encantis"` is laid out in memory when the program is compiled and passed as one ([2.6](#26-slices)). `'a'` is the number 97 ([Codepoint Literals](#codepoint-literals)). `n` is a named result: it starts at zero and is returned when the function ends ([3.4](#34-functions)). The `test` block is compiled and run only by `encantis test`.

## Implementation Status

The compiler implements everything this reference describes except what this table lists. Each of these is labelled **Not implemented** in the section that describes it.

| Feature | What the compiler does with it | Described in |
|---|---|---|
| Enum types, `enum Color { Red, Rgb(r: u8, g: u8, b: u8) }` | Parses the declaration and ignores it; naming the type is an error (`unknown type 'Color'`) | [2.9](#29-enum-types-algebraic-data-types) |
| `match` patterns other than numbers, codepoints, bools and `_` | A tuple pattern is refused (`match cannot compare a tuple pattern yet: compare one field at a time`), and a guard (`(x, y) if x == y`) is a syntax error. A lower-case name as a pattern binds nothing (its uses are `unknown identifier`), and a variant or constructor pattern (`Red`, `Point(0, y)`) is accepted and never matches: do not write them | [5.4](#54-match-expressions), [6.3](#63-patterns-in-match-arms) |
| Patterns in function signatures, `func to_polar Point(x, y) -> Polar(d, a)` | Reads the pattern as a generic type and refuses it (`'Point' is not a generic type`) | [6.2](#62-patterns-in-function-signatures) |
| Constructor patterns in `if let` and `let`, `if let Rgb(r, g, b) = c`, `let Point(x, y) = p` | `if let` refuses one (`if let only supports simple bindings`); in a `let` it is a syntax error. `let (x:, y:) = p` destructures a struct | [6.4](#64-if-let-bindings), [6.5](#65-let-destructuring) |
| Assigning a tuple of variables without `set`, `(q, r) = divmod(17, 5)` | A syntax error: write `set (q, r) = divmod(17, 5)` | [4.5](#45-assignment-and-compound-assignment) |
| Destructuring a global, `global (a, b) = (1, 2)` | Refused: `global destructuring is not supported yet` | [3.3](#33-variables) |
| Function values: a function held in a variable, parameter or field, called indirectly | Calling one is refused (`calling a function value is not supported yet: ...`). A program that stores or passes one passes the checker and does not assemble. A function given at compile time, a comptime function parameter, works | [3.4](#function-types-and-pointers), [8.6](#86-comptime-function-parameters) |
| Functions without a name, `func(x: i32) -> i32 => x + 1` at module level, `export "inc" func(x: i32) -> i32 => x + 1` | Accepts one and leaves it out of the module; exported, the module does not assemble (it exports an undefined function), and without an export name it is `Internal parser error: Cannot export anonymous function without explicit name` | [3.4](#34-functions), [7.2](#72-exports) |
| `inline func` | Parses `inline` and ignores it: the function is compiled and called as any other | [3.5](#35-inline-functions) |
| Saturating arithmetic, `+\|`, `-\|`, `*\|` (and `+\|=`, `-\|=`, `*\|=`) | Accepts them and compiles them as the wrapping `+`, `-`, `*`: do not use them | [4.1](#41-arithmetic-operators) |
| A type pun that loads or stores, `ptr.u32` as the `u32` at `ptr`, `ptr.u32 = v` | `ptr.u32` is the pointer as a `[*]u32`, so its value is that pointer, and assigning to it is refused: write `ptr.u32[0]` and `ptr.u32[0] = v` | [4.6](#46-pointer-operations) |
| Reading a `*[?]T` (elements after a LEB128 length) | Lays one out, and refuses indexing it and its `.len` (`... is not supported yet: its length prefix is not read`) | [2.5](#25-pointer-types) |
| Joining a template literal into one `[]u8` (formatting text into a buffer) | A template is the array literal of its fragments, so where a `[]u8` is wanted each `${e}` is one byte, and a `[]u8` there is a type error (`cannot assign *[2]u8 to u8`) | [1.5](#template-literals) |
| Compile-time `if`, `for` and `assert`; comptime parameters other than types, integers and functions (`comptime ok: bool`); generic functions that share a name; writing some comptime arguments and inferring the others; generic types whose body is several statements | Each is refused with an error | [8.9](#89-not-in-this-version), [8.10](#810-how-this-is-compile-time-evaluation) |
| `memory-size()` and `memory-grow(n)` | Not built in: `unknown identifier 'memory-size'` | [10.3](#103-memory-builtins) |
| A host reference in memory | Refused wherever one would be in memory (`cannot point to Canvas: a host reference has no bytes, ...`) | [2.13](#213-host-references) |
| SIMD (`v128`), compile-time execution (`comptime func`), a module system (`module`, `use`), operator overloading, closures | Not parsed: a syntax error | [13](#13-future-additions) |

---

## 1. Lexical Structure

A source file is UTF-8 text: comments, whitespace and the tokens between them, which are names, keywords, literals and punctuation.

### 1.1 Comments and Whitespace

Whitespace is the space, the tab, the line feed and the carriage return, so a line may end in `\n` or `\r\n`. No other character is whitespace: a form feed or a non-breaking space outside a comment, a string or a template is a syntax error. Whitespace separates tokens and means nothing else, line breaks included ([1.6](#16-statements-and-line-breaks)). It is needed only where two tokens would otherwise run together: `let x`, not `letx`; `a+b` and `a + b` are the same, but `a-b` is one name ([1.2](#12-identifiers)).

There are two comments:

- `//` starts a comment that runs to the end of the line.
- `/*` starts a comment that runs to the first `*/`, across lines if it has to. Block comments do not nest: in `/* a /* b */ c */` the comment ends after `b`, and `c */` is read as code.

A comment counts as whitespace, so it may stand wherever whitespace may: between any two tokens, inside a parameter list, at the end of a line. Inside a string or a template, `//` and `/*` are text.

<!-- spec:begin compile -->

```ents
// The next line is a comment of its own.
/* So are these two,
   and the one inside the parameter list. */
func area(w: u32, /* height: */ h: u32) -> u32 {
  return w * h // the line ends the comment
}

test "comments are whitespace" {
  assert area(3, /* inline */ 4) == 12
  assert "// not a comment".len == 16
}
```

<!-- spec:end -->

<!-- spec:begin compile -->

```ents
func f() -> u32 {
  return 1 /* outer /* inner */ still outer? */
}
```

```errors
Line 2, col 44
```

<!-- spec:end -->

A file whose first two characters are `#!` starts with a shebang line, which is skipped as a comment, so a program can run as a script: with `#!/usr/bin/env encantis run` as its first line and its execute bit set, `./tee.ents` runs it. `#!` anywhere else, even after a space at the start of the file, is a syntax error.

<!-- spec:begin compile -->

```ents
#!/usr/bin/env encantis run
export func answer() -> u32 => 42

test "the first line is skipped" {
  assert answer() == 42
}
```

<!-- spec:end -->

### 1.2 Identifiers

An identifier (a name) starts with a lowercase ASCII letter `a`–`z` and goes on with ASCII letters, digits, `_` and `-`. It names a variable, a parameter, a function, a field, a `def`, a `data` block or a global: `count`, `prime32-1`, `merge-round64`, `my_var_2`, `x2`.

- A name never starts with `_`, a digit or an uppercase letter: `_count`, `2x` and `Count` are not names (`Count` is a type name, [1.3](#13-type-identifiers)). `_` alone is not a name either: it is the wildcard of a match arm ([6.3](#63-patterns-in-match-arms)) and the length left to the compiler in `[_]T`.
- A hyphen after the first letter is part of the name, wherever the name stands: `n-1` is one name, not `n` minus 1, and after a dot `x.u32-count` is the member `u32-count`. So subtraction is written with spaces, `n - 1`, and the formatter prints every binary `-` that way.
- Names are ASCII: write no other letter in a name.
- A keyword is reserved only as a whole word: `if-x`, `memory-size`, `true-ish` and `format` are names ([1.4](#14-reserved-keywords)). The names of the primitive types (`u8`, `i32`, `f64`, `bool`, …) and of the builtins (`max`, `memcpy`, …) are not reserved, though naming a variable `u8` only confuses its reader.

Both `snake_case` and hyphens are written; hyphens are common in constants and in names that end in a number (`prime32-1`, `max-wisps`).

<!-- spec:begin compile -->

```ents
def max-size = 1024:u32

func room(used-bytes: u32) -> u32 => max-size - used-bytes   // two names, one subtraction

test "a hyphen joins a name" {
  let n = 10:u32
  let n-1 = 3:u32
  assert room(24) == 1000
  assert n - 1 == 9
  assert n-1 == 3
}
```

<!-- spec:end -->

<!-- spec:begin compile -->

```ents
func f() -> u32 {
  let _count: u32 = 1
  return 1
}
```

```errors
Line 2, col 7
```

<!-- spec:end -->

### 1.3 Type Identifiers

A type name starts with an uppercase ASCII letter `A`–`Z` and goes on as a name does: `Point`, `Vec3`, `My-Type`, `Pair_2`. Every type a program declares is named this way, which keeps it apart from the primitive types (`i32`, `f64`, …) and from names:

<!-- spec:begin compile -->

```ents
type point = (x: f32, y: f32)
```

```errors
Line 1, col 6
```

<!-- spec:end -->

The case alone tells the parser whether a word is a type or a name, without looking for a declaration: in `let point = Point(1.0, 2.0)`, `point` is a variable and `Point(…)` builds a `Point`.

<!-- spec:begin compile -->

```ents
type Point = (x: f32, y: f32)

func distance2(a: Point, b: Point) -> f32 {
  let dx = a.x - b.x
  let dy = a.y - b.y
  return dx * dx + dy * dy
}

test "Point is a type, point a variable" {
  let point = Point(1.0, 2.0)
  assert distance2(point, Point(4.0, 6.0)) == 25.0
}
```

<!-- spec:end -->

A type can be named anywhere in its module, above its declaration as well as below it: in another type, a signature, a global's or a `data`'s type and initializer. The types of a module are resolved before anything else in it, so names that lead to one another resolve in whatever order they are declared.

<!-- spec:begin compile -->

```ents
global origin: Pair = (1, 2)
data corners: *[2]Pair = [(3, 4), (5, 6)]
type Pair = (first: Coord, second: Coord)
type Coord = Size
type Size = u32

export func far() -> Size => origin.first + origin.second + corners[1].second
```

<!-- spec:end -->

The type parameters of a generic function are type identifiers too: in `func max(comptime T: type, a: T, b: T)`, `T` is a type inside the function (see [8. Generics](#8-generics)).

### 1.4 Reserved Keywords

These words are reserved: none of them is a name, so none can name a variable, a parameter, a function or a field.

| Kind | Keywords |
|------|----------|
| Control flow | `if` `elif` `else` `match` `while` `for` `in` `loop` `break` `continue` `return` `when` `defer` |
| Declarations | `func` `let` `set` `global` `def` `data` `type` `enum` `import` `export` `memory` `inline` `comptime` |
| Values and operators | `true` `false` `mut` `as` `sizeof` |
| Types of constants | `int` `float` |

A keyword is a whole word: followed by a letter, a digit, `_` or `-` it is part of a longer name (`if-x`, `format`, `memory-size`). `int` and `float` are the types of constants that have no type yet, as messages show them: `cannot assign int(300) to u8` ([2.10](#comptime-literal-promotion)). `enum` is reserved for enum types, which are not implemented ([2.9](#29-enum-types-algebraic-data-types)).

Three words have a meaning only where they stand, and are names everywhere else: `assert` at the start of a statement, `test` at the start of a declaration (a test block), and `host` as the whole right side of a type declaration, `type Canvas = host` ([2.13](#213-host-references)).

<!-- spec:begin compile -->

```ents
func pick(test: u32, host: u32) -> u32 => if test > host { test } else { host }

test "test and host are names here" {
  let assert-count = pick(2, 5)
  assert assert-count == 5
}
```

<!-- spec:end -->

<!-- spec:begin compile -->

```ents
func f() -> u32 {
  let sizeof = 4
  return 1
}
```

```errors
Line 2, col 7
```

<!-- spec:end -->

### 1.5 Literals

A literal writes a value into the program. Most literals have no type of their own: a number takes the type of the place it is used ([Comptime Literal Promotion](#comptime-literal-promotion)), an array the element type wanted there, and only where nothing gives one does a literal take its default:

| Literal | Examples | With nothing to give it a type |
|---------|----------|--------------------------------|
| Integer | `42`, `0xFF`, `0b1010`, `-7` | `i32`, or `i64` when it does not fit an `i32` |
| Float | `3.14`, `1.0e-9`, `-0.5` | `f64` |
| Boolean | `true`, `false` | `bool` |
| String | `"hi"`, `x"ff00"`, `b"aGk="` | `*[N]u8`, a pointer to its N bytes |
| Codepoint | `'a'`, `'\n'`, `'ok'` | an integer constant (`'a'` is 97); several are a tuple |
| Template | `` `hi ${name}` `` | the array literal of its fragments |
| Array | `[1, 2, 3]`, `[0:u8; 64]` | `[N]T`, a value in registers ([2.4](#24-fixed-arrays-value-type)) |
| Tuple, struct | `(1, 2.0)`, `(x: 1, y: 2)`, `Point(1.0, 2.0)` | a tuple ([2.7](#27-tuple-types)), a struct ([2.8](#28-struct-types)) |

`:T` after a literal gives it a type: `42:i64`, `255:u8`, `2.5:f32`, `[0:u8; 64]`. The value has to be one of that type, which is never a conversion: `300:u8` is `cannot assign int(300) to u8`, and `1.5:i32` is `cannot assign float(1.5) to i32`. An integer is a value of a float type when the float holds it exactly, so `1:f64` is the float `1.0`. The same `:T` after any operand is a type annotation: `x:i64` widens an `i32` variable, and nothing narrows ([2.10](#210-type-conversions)). It binds as tightly as `as`, so `-5:u8` is `(-5):u8`, an error.

#### Integer Literals

An integer literal is decimal, or has a prefix that names its radix:

| Form | Radix | Digits | Example |
|------|-------|--------|---------|
| `123` | 10 | `0`–`9` | `42` |
| `0x` | 16 | `0`–`9`, `a`–`f`, `A`–`F` | `0xFF` is 255 |
| `0b` | 2 | `0`, `1` | `0b1010` is 10 |
| `0o` | 8 | `0`–`7` | `0o755` is 493 |
| `0d` | 12 (dozenal) | `0`–`9`, `a` or `A` (ten), `b` or `B` (eleven) | `0d1a` is 1 × 12 + 10 = 22 |

- The prefixes are lowercase: `0X1F` is a syntax error.
- Leading zeros change nothing: `007` is the decimal 7, not octal.
- There are no digit separators: `1_000` is a syntax error.
- Each digit is one of its radix: `0b2` and `0o8` are not literals.
- A `-` before a literal is part of it, with or without a space: `-0x10` is the constant -16, and `-2147483648` is an `i32` constant, not the negation of a number too large for one.
- A literal is a number, not a bit pattern: `0xFFFFFFFF` is 4294967295, which a `u32` holds and an `i32` does not (for the `i32` with those bits, write `-1`, or `0xFFFFFFFF as i32`).

An integer constant takes the type of where it is used, and has to fit it. Where nothing gives it a type, it is an `i32` when it fits one, and an `i64` when it fits that: `2147483647` is an `i32`, `2147483648` an `i64`. Give a larger one its type: `18446744073709551615:u64`, or `let x: u128 = 18446744073709551616`. An integer becomes an `i32.const` or `i64.const` in WebAssembly (and several `i64` values for the wide types of [2.2](#22-primitive-types)).

<!-- spec:begin compile -->

```ents
def mask = 0xFF:u32

func width(x: i32) -> u32 => 32
func width(x: i64) -> u32 => 64

test "integer literals" {
  assert 42 == 0x2A
  assert 0b1010 == 10
  assert 0o755 == 493
  assert 0d1a == 22
  assert 0dB == 11
  assert 007 == 7
  assert -0x10 == -16
  assert (0x1234 & mask) == 0x34
}

test "an untyped integer constant is an i32 when it fits, else an i64" {
  let small = 2147483647
  let big = 2147483648
  let bits = 0xFFFFFFFF
  assert width(small) == 32
  assert width(big) == 64
  assert width(bits) == 64
}
```

<!-- spec:end -->

<!-- spec:begin compile -->

```ents
func f() -> u32 {
  let a: u8 = 300
  let b = 1.5:i32
  let c: i32 = 0xFFFFFFFF
  return 0
}
```

```errors
cannot assign int(300) to u8
cannot assign float(1.5) to i32
cannot assign int(4294967295) to i32
```

```ents
def million = 1_000_000
```

```errors
Line 1, col 16
```

<!-- spec:end -->

#### Float Literals

A float literal is digits, a point, digits, and an optional exponent: `e` or `E`, an optional sign, and digits. Both sides of the point need a digit: `3.14`, `0.5`, `1.0`, `1.5e3`, `6.022E23`, `2.5e-10`.

- `1.`, `.5` and `1e10` are not floats: write `1.0`, `0.5` and `1.0e10`.
- There are no hexadecimal floats, and no literal for infinity or NaN: `1.0 / 0.0` is infinity.
- A `-` before the literal is part of it, as for integers, so `-0.0` is negative zero.

A float constant takes the float type of where it is used, and is an `f64` where nothing gives it one: `let z = 1.3` is an `f64`, so passing `z` for an `f32` is an error, while `1.3` itself is a value of either. A decimal fraction has no exact binary value, so a float literal is rounded to its type, and `0.1:f32` is the `f32` nearest 0.1. An integer constant is a value of a float type when that type holds it exactly ([Comptime Literal Promotion](#comptime-literal-promotion)). A float becomes an `f64.const` or `f32.const`.

<!-- spec:begin compile -->

```ents
func half(x: f64) -> f64 => x * 0.5
func third(x: f32) -> f32 => x / 3.0

test "float literals" {
  assert half(3.0) == 1.5
  assert 1.5e3 == 1500.0
  assert 2.5E-1 == 0.25
  assert third(1.5) == 0.5
  let one: f64 = 1
  assert one == 1.0
  assert 1.0 / -0.0 < 0.0
}
```

<!-- spec:end -->

<!-- spec:begin compile -->

```ents
func f() -> f32 {
  let z = 1.3
  return z
}
```

```errors
cannot assign f64 to f32
```

```ents
func one() -> f64 => 1.
```

```errors
Line 1, col 24
```

<!-- spec:end -->

#### Boolean Literals

`true` and `false` are the two values of `bool`, and its only literals. A bool is not a number: an integer is no condition (`if n` is `condition must be bool, not i32`; compare, `if n != 0`), a bool takes no arithmetic (`'+' cannot be applied to bool: cast it to an integer first`), and nothing becomes a bool by a cast (`cannot cast i32 to bool: compare it instead (x != 0)`). `b as u32` is 1 for `true` and 0 for `false`. In WebAssembly a bool is an `i32` holding 0 or 1, and in memory it is one byte.

<!-- spec:begin compile -->

```ents
data flags = [true, false, true]

func count(bits: []bool) -> u32 {
  let n: u32 = 0
  for b in bits {
    n += b as u32
  }
  return n
}

test "bools" {
  assert count(flags) == 2
  assert sizeof(bool) == 1
  assert true != false
}
```

<!-- spec:end -->

<!-- spec:begin compile -->

```ents
func f(n: i32) -> bool {
  if n {
    return true
  }
  let b: bool = 1
  return n as bool
}
```

```errors
condition must be bool, not i32
cannot assign int(1) to bool
cannot cast i32 to bool: compare it instead (x != 0)
```

<!-- spec:end -->

#### String Literals

A string is written in double quotes and holds UTF-8 text: `"hello"`, `"héllo"` (six bytes: `é` is two). A line break inside the quotes is part of the string. A backslash starts an escape, and these are all of them:

| Escape | Bytes |
|--------|-------|
| `\n` `\t` `\r` | line feed (10), tab (9), carriage return (13) |
| `\\` `\"` `\'` | a backslash, a double quote, a single quote (`"don't"` needs no escape) |
| `\xHH` | the one byte `HH`, two hex digits in either case: `"\xE9"` is one byte, which need not be valid UTF-8 |
| `\u{H…}` | the UTF-8 bytes of the codepoint `H…`, in hex: `"\u{e9}"` is the two bytes of `é` |

Any other character after a backslash is a syntax error, `\0` among them: a zero byte is `\x00`. A `\u{…}` that names no character is an error, a surrogate (`\u{D800}` to `\u{DFFF}`) or past `\u{10FFFF}`.

Two prefixes write bytes rather than text, both with double quotes only:

- `x"…"` holds hex digits, two to a byte, either case, with whitespace allowed between bytes: `x"9d61 b19d"` is the four bytes 0x9D, 0x61, 0xB1, 0x9D. An odd number of digits is a mistake.
- `b"…"` holds base64 (`A`–`Z`, `a`–`z`, `0`–`9`, `+`, `/`), its `=` padding optional, whitespace allowed: `b"SGVsbG8="` and `b"SGVsbG8"` are both the five bytes of `Hello`.

A string is bytes in memory: the compiler lays them out in the data section ([9.0](#90-data-layout)) when it builds the module, and the string's value is their address. A string is constant: nothing writes it, and equal strings may share their bytes. With nothing to give it a type (`let s = "abc"`, the source of `buf[0..3] = "abc"`, a branch of an untyped `if`), a string is a `*[N]u8`, a pointer to its N bytes, whose `.len` is N. It converts to the pointer and slice types of bytes: a `[]u8` (its address and length), a `[*]u8`, and a `*[!]u8` or `[!]u8`, for which it is laid out with a zero byte after it ([2.5](#25-pointer-types)). `mut "abc"` is a `*mut [3]u8`, a writable copy of its own ([The `mut` Keyword on Literals](#the-mut-keyword-on-literals)).

<!-- spec:begin compile -->

```ents
data hello = "Hello"
data key = x"9d61 b19d"
data greeting = b"SGVsbG8="

func count(s: []u8, c: u8) -> u32 {
  let n: u32 = 0
  for b in s {
    if b == c {
      n += 1
    }
  }
  return n
}

test "strings" {
  assert hello.len == 5
  assert key.len == 4 && key[0] == 0x9D
  assert greeting.len == 5 && greeting[4] == 'o'
  assert "é".len == 2
  assert "\xE9".len == 1
  assert "\u{e9}"[1] == 0xA9
  assert count("a\tb\tc", '\t') == 2
  assert count("two
lines", '\n') == 1
}
```

<!-- spec:end -->

<!-- spec:begin compile -->

```ents
data nul = "a\0b"
```

```errors
Line 1, col 15
```

<!-- spec:end -->

A slice counts elements, so a string is only a slice of one-byte elements: `"abc"` for a `[]u32` is a compile error, as three bytes are not three `u32`s. Write the elements as an array literal (`[1, 2, 3]`).

A string is never a character: next to a number, given for one or matched against one it is an error, which shows how the character is written (`'==' cannot be applied to u8 and a string — a string is bytes in memory, not a character: a character is written in single quotes ('a')`).

#### Codepoint Literals

Single quotes hold codepoints, not a string. Each character between them is one codepoint (a Unicode scalar value, never a byte of its UTF-8 encoding), and each codepoint is exactly the integer literal of its value, as if the number were written in its place. The escapes are a string's, with `\xHH` the codepoint `HH`, and a double quote needs no escape (`'"'` is 34).

One codepoint is the value itself, as a parenthesised value is (`'a'` is `(97)`, which is `97`), so it compares, computes, assigns, passes and matches as its number does. It has the type of where it is used, and has to fit it as that number would: `'é'` is 233, which a `u8` holds, and `'ā'` is 257, which a `u8` does not (`cannot assign int(257) to u8`). So `'é'` is not the bytes `é` has in UTF-8 text: to find it there, look for the string `"é"`, two bytes.

<!-- spec:begin compile -->

```ents
def newline = '\n'

func is_lower(c: u8) -> bool => c >= 'a' && c <= 'z'
func digit(c: u8) -> u8 => c - '0'
func vowel(c: u8) -> bool => match c {
  'a', 'e', 'i', 'o', 'u' => true
  _ => false
}

test "a codepoint is its number" {
  assert 'a' == 97
  assert 'é' == 233
  assert '\x7F' == 127
  assert '\u{1F600}' == 128512
  assert newline == 10
  assert is_lower('q') && !is_lower('Q')
  assert digit('7') == 7
  assert vowel('e')
}
```

<!-- spec:end -->

Several codepoints are the tuple of them, values in registers like any tuple: `let (x, y) = 'ok'` binds 111 and 107, and `'RIFF'` passes for a `(u8, u8, u8, u8)` as `(82, 73, 70, 70)` does. A tuple is not an array, so `'abc'` is no `[3]u8`, and neither it nor `(97, 98, 99)` is a row of a table, an element of a `[][3]u8` or what a `*[3]u8` points at: for those, write the string `"abc"` or the array `[97, 98, 99]`.

<!-- spec:begin compile -->

```ents
type Tag = (u8, u8, u8, u8)

func is_riff(t: Tag) -> bool => t.0 == 'R' && t.1 == 'I' && t.2 == 'F' && t.3 == 'F'

test "several codepoints are a tuple" {
  let (x, y) = 'ok'
  assert x == 111 && y == 107
  assert is_riff('RIFF')
  assert !is_riff('WAVE')
}
```

<!-- spec:end -->

A single-quoted literal is never a string, nor an address: where a pointer or a slice is wanted it is an error that shows the string. `''` holds no codepoint and is an error, as is an escape that names no character (`\u{D800}` to `\u{DFFF}`, past `\u{10FFFF}`).

<!-- spec:begin compile -->

```ents
func is_a(c: u8) -> bool => c == "a"
func name() -> []u8 => 'hi'
func big() -> u8 => 'ā'
```

```errors
'==' cannot be applied to u8 and a string — a string is bytes in memory, not a character: a character is written in single quotes ('a')
cannot assign 'hi' to []u8 — a single-quoted literal is codepoints, not a string: a string is written with double quotes ("hi")
cannot assign int(257) to u8
```

```ents
func none() -> u8 => ''
```

```errors
'' holds no character
```

<!-- spec:end -->

#### Template Literals

A template literal is written in backticks. Its text is static, and each `${expr}` in it stands for the value of `expr`; it may span lines. The text takes the escapes of a string, and two of its own: `` \` `` is a backtick and `\${` is the two characters `${`. A `}` in the text is a syntax error (a known bug); write it as `\x7D`.

A template is the array literal of its fragments: `` `Hi ${name}!` `` is `["Hi ", name, "!"]`, the static text as constant strings and each `${e}` the value of `e`, in the order written. A fragment with no text is left out, so `` `${a}${b}` `` has two elements and ``` `` ``` none. Everything an array literal does, a template does ([Array Literals](#array-literals)), and its type comes from where it is used, as an array literal's does:

- Given for a `[][]u8` (a slice of byte slices, what WASI's `fd_write` takes as its iovecs), it is laid out in memory: one cell for its place in the source, in the data section, whose constant fragments are laid out once and may share their bytes with equal strings, and into which each `${e}` is stored every time the template is evaluated ([Literals in Memory](#literals-in-memory)). For a `[]mut []u8` it is written `` mut `…` ``. It meets any other array or slice type the same way: a `[3][]u8` value, a `*[3][]u8`, a `[][!]u8`.
- With nothing to give it a type it is an array value in registers, as `let a = [1, 2, 3]` is a `[3]i32`: `` let t = `Hi ${name}!` `` is a `[3][]u8`, and a `[3][]u8` is not a `[][]u8` (`cannot assign [3][]u8 to [][]u8`). Pass the template where it is used, or give the variable its type: `` let t: [][]u8 = `Hi ${name}!` ``.

Each `${e}` is an element, so it has to be a value of the element type: for a `[][]u8`, a `[]u8` or a string. Nothing turns a number into text: `${n}` with a `u32` is `cannot assign u32 to []u8`; write the digits into a buffer first and interpolate that.

> **Not implemented:** joining a template into one `[]u8`, its fragments copied one after another into a buffer. Given where a `[]u8` is wanted, a template is still the array literal of its fragments, so each `${e}` there is one byte, and a `[]u8` is a type error.

<!-- spec:begin compile -->

```ents
func total(parts: [][]u8) -> u32 {
  let n: u32 = 0
  for p in parts {
    n += p.len
  }
  return n
}

func count(parts: [][]u8) -> u32 => parts.len

test "a template is the array literal of its fragments" {
  let name = "bob"
  assert total(`Hi ${name}!`) == 7
  assert total(["Hi ", name, "!"]) == 7
  assert count(`Hi ${name}!`) == 3
  assert count(`${name}${name}`) == 2
  assert count(``) == 0
  assert total(`a \` and a \${`) == 12     // the text a ` and a ${
}
```

<!-- spec:end -->

The usual use is output, where the fragments go to the host as they are, without being copied into one buffer:

<!-- spec:begin compile -->

```ents
import "wasi_snapshot_preview1" (
  "fd_write" func fd_write(fd: i32, iovs: [][]u8, nwritten: *mut u32) -> i32
)

export func greet(name: []u8) -> i32 => fd_write(1, `Hello, ${name}!\n`, &0)
```

<!-- spec:end -->

<!-- spec:begin compile -->

```ents
func count(parts: [][]u8) -> u32 => parts.len

func f(name: []u8, n: u32) -> u32 {
  let t = `Hi ${name}!`
  return count(t) + count(`n = ${n}`)
}
```

```errors
argument 1: cannot assign [3][]u8 to [][]u8
cannot assign u32 to []u8
```

<!-- spec:end -->

#### Array Literals

An array literal lists its elements, `[a, b, c]` (a trailing comma is allowed), or repeats one, `[v; n]`:

- The elements take the element type wanted where the literal is used. Where none is wanted they widen to the widest of them ([Implicit Widening](#implicit-widening)): `[1, 2.5]` is a `[2]f64`, and `[1:u8, 2:i8]` is `elements have different types: i8 and u8 (cast one explicitly)`.
- In `[v; n]` the count `n` is a compile-time integer: a literal, a `def`, a comptime value parameter, or arithmetic on these. A count known only at run time is `repeat count must be a compile-time integer`, and a negative one `repeat count cannot be negative`. `v` is evaluated once for each element: `[f(); 3]` calls `f` three times.
- `[]` has no element to take a type from, so it needs one given: `let none: []u8 = []` is an empty slice, and `let x = []` is `cannot infer element type of empty array literal`.
- A string is an array literal of bytes, which is always in memory: `"hi"` is `[0x68, 0x69]` laid out as a `*[2]u8`.

With nothing to give it a type, an array literal is a value: `[N]T` in N registers, copied when it is assigned or passed ([2.4](#24-fixed-arrays-value-type)). Where a pointer or a slice is wanted it is laid out in memory instead, as the next section tells, and its count has to be the one wanted: an array literal given for a `*[N]T` has N elements, and each row of a `*[N][M]T`, a `[][M]T` or a `*[NxM]T` has M, as does each literal an element of a `*[N]*[M]T` points at: `cannot assign 2 elements to *[3]i32`. Behind a pointer, a string is the bytes of all the elements: `"abcd"` is a `*[4]u8` or a `*[2]u16`, but not a `*[8]u8` (`cannot assign a string of 4 bytes to *[8]u8`) or the rows of a table.

<!-- spec:begin compile -->

```ents
def n = 4

func sum(xs: []i32) -> i32 {
  let s = 0
  for x in xs {
    s += x
  }
  return s
}

test "array literals" {
  let v = [1, 2, 3]
  assert v[2] == 3 && v.len == 3
  assert sum([1, 2, 3]) == 6
  let zeros = [0:u8; n * 2]
  assert zeros.len == 8
  let mixed = [1, 2.5]
  assert mixed[0] == 1.0
  let none: []i32 = []
  assert sum(none) == 0
}
```

<!-- spec:end -->

<!-- spec:begin compile -->

```ents
func sum(xs: []i32) -> i32 => 0

func f(k: u32) -> i32 {
  let v = [1, 2, 3]
  let e = []
  let r = [0:u8; k]
  return sum(v)
}
```

```errors
cannot infer element type of empty array literal
repeat count must be a compile-time integer
argument 1: cannot assign [3]i32 to []i32
```

<!-- spec:end -->

#### Literals in Memory

A literal is laid out in memory in four cases:

- a string, always;
- an array literal, a template among them, where a pointer or a slice is wanted: an argument, a typed `let`, an assignment, a returned value, a field;
- any literal after `&` ([4.7](#element-addresses-and-writes));
- the value of a `data` declaration ([3.2](#32-data-declarations-data)).

A number or a tuple where a pointer is wanted is not laid out: write `&` before it, `&0:u32` for a `*mut u32` and `&(1, 2)` for a `*mut Point`.

A literal laid out in a function is one cell for its place in the source, in the data section. The compiler writes its constant parts there once, when it builds the module, and never again; the parts known only at run time (`[x, 2]`) are stored into the cell each time the literal is evaluated, in the order written. (A tuple or struct literal with a part known only at run time, `&(x, 0:u32)`, stores its constant fields too each time it is evaluated: a known bug, so do not write to a constant field of such a cell and expect the next evaluation to keep it.) Nothing is allocated when the function runs, and so:

- A cell outlives the call: a pointer to it can be returned and kept.
- What is written through a pointer to a cell stays there: the next evaluation, the next call and a recursive call all see the same cell, like a `static` in C. A cell that must start from its literal's value on each call is set there (`n.* = 0`), or is a variable instead, when it needs no address.
- A pointer kept from an earlier evaluation sees the values of the later one.

A literal with run-time parts, and every `mut` or `&` literal, is a cell of its own, never shared with another literal; equal constant literals may share theirs.

<!-- spec:begin compile -->

```ents
func next-id() -> u32 {
  let n = &0:u32
  n.* += 1
  return n.*
}

func pair(x: u32) -> *[2]u32 => [x, x * 2]

test "a literal in memory is one cell for its place in the source" {
  assert next-id() == 1
  assert next-id() == 2
  let a = pair(1)
  let b = pair(5)
  assert b[1] == 10
  assert a[1] == 10
}
```

<!-- spec:end -->

Rows written in place (`let p: *[2x2]i32 = [[x, 1], [2, 3]]`) are filled the same way. A literal laid out apart from the one it is in, an element of a slice of slices (`[][]i32`), of a pointer to framed arrays (`*[2][!]u8`), what an element of an array of pointers points at (`*[2]*[3]i32 = [[1, 2, 3], [4, 5, 6]]`, `*[2][*]u8 = ["ab", "cd"]`: each element is the address of its literal) or a row of a table ([2.5](#nesting)), is laid out when the program is compiled, so its values must be constants: `let t: [][]i32 = [[a, 2], [3]]` is an error (`an element of [][]i32 is laid out at compile time: its values must be constants`).

#### The `mut` Keyword on Literals

A literal is constant unless it is written with `mut`, wherever it is: where a mutable pointer or slice is wanted, a literal without `mut` is an error that shows it written with the keyword. `let buf: []mut u8 = [0:u8; 20]` is ``a literal is constant: write `mut [0:u8; 20]` for a []mut u8``; the same goes for `data s: []mut i32 = [20, 8]`, an argument `"abc"` for a `[]mut u8` parameter (`mut "abc"`), a slice field of a struct (`Buf(mut [0:u8; 4], 0)`), an element of a slice of mutable slices (`data q: *[2][]mut u8 = [mut "ab", mut "cd"]`), the table literal of a `*mut [N][M]T` and a template literal for a `[]mut []u8` (``mut `a${x}b` ``). The receiver of a method call is shown in parentheses, ``receiver: a literal is constant: write `(mut "abc")` for a []mut u8``, as `mut` goes on the literal itself: `mut "abc".fill()` would be `mut` of the call, and is a syntax error that says so. Only where a mutable pointer or slice is wanted: the fallback of `??` is given for what the whole is given for ([4.7](#the--operator)), so in `println(digits[i..] ?? "")`, with `digits` a `*mut [24]u8` and `println` taking a `[]u8`, `""` needs no `mut`.

`mut` makes the literal writable and its own, shared with no other literal: what it lays out apart too, the rows of a table (`data t: *mut [2][3]i32 = mut [[0; 3]; 2]` is two rows of zeros), the elements of a slice of slices (`mut [[1, 2], [1, 2]]` for a `[][]mut u8`) and the slice fields of its structs. `mut` goes before a literal of any kind; before anything else it is a syntax error (`mut goes before a literal (an array, a string or a tuple), not before …`).

`mut` does not choose where a literal lives; the type it meets does, as for any literal. A string is always in memory, so `mut "hello"` is a `*mut [5]u8`. An array literal given for a `*mut [N]T` or a `[]mut T` is laid out in a writable cell. With nothing to give it a type, a number, a tuple or an array stays a value in registers, where it is a variable's own and writable anyway, and `mut` changes nothing: `let q = mut [1, 2, 3]` is the `[3]i32` that `[1, 2, 3]` is. For a writable cell, write `&` before the literal: `&0:u32` is a `*mut u32`, `&[1, 2, 3]` a `*mut [3]i32`, `&(1.0, 2.0)` a `*mut (f64, f64)`, each a cell of its own, so `&[1, 2]` given for a `*mut [2]i32` needs no `mut`. A number or a tuple is laid out only by `&`: for a `*mut u32`, write `&5`, not `mut 5`. `&` before a string is not needed: a string is already its address.

| Written | With nothing to give it a type |
|---------|--------------------------------|
| `5`, `mut 5` | `i32`: a value in a register |
| `&5` | `*mut i32`: a cell of its own in the data section |
| `(1.0, 2.0)`, `mut (1.0, 2.0)` | `(f64, f64)`: two registers |
| `&(1.0, 2.0)` | `*mut (f64, f64)` |
| `[1, 2, 3]`, `mut [1, 2, 3]` | `[3]i32`: three registers |
| `&[1, 2, 3]` | `*mut [3]i32` |
| `"hello"` | `*[5]u8`: constant bytes in the data section, maybe shared with an equal string |
| `mut "hello"` | `*mut [5]u8`: a writable copy of its own |
| `data buf = mut [0:u8; 1024]` | `buf` is a `*mut [1024]u8` |

<!-- spec:begin compile -->

```ents
func fill(buf: []mut u8, v: u8) -> u32 {
  buf[..] = v
  return buf.len
}

func bump(p: *mut [2]i32) -> i32 {
  p[0] += 1
  return p[0]
}

test "mut and & on literals" {
  assert fill(mut [0:u8; 4], 7) == 4
  let s = mut "abc"
  s[0] = 'A'
  assert s[0] == 'A'
  assert bump(&[1, 2]) == 2
  let cell = &0:u32
  cell.* = 5
  assert cell.* == 5
}
```

<!-- spec:end -->

<!-- spec:begin compile -->

```ents
func fill(buf: []mut u8) -> u32 => buf.len

func f() -> u32 {
  let buf: []mut u8 = [0:u8; 20]
  return fill("abc") + "ab".fill()
}
```

```errors
a literal is constant: write `mut [0:u8; 20]` for a []mut u8
argument 1: a literal is constant: write `mut "abc"` for a []mut u8
receiver: a literal is constant: write `(mut "ab")` for a []mut u8
```

<!-- spec:end -->

#### `def` — Compile-Time Constants

`def` names a compile-time constant: an integer, a float, a bool or a codepoint, or a constant expression of them (`def page = 64 * 1024`). Each use of the name is the value itself, as if it were written there, so a `def` takes no memory and has no address, and an untyped one takes the type of each place it is used. A tuple, an array or a string is not a `def`'s value (`def cannot contain array/string literals — use 'data origin = ...' instead`): lay it out with `data`, or write a `def` for each part. More in [3.1](#31-definitions-def).

<!-- spec:begin compile -->

```ents
def mask51 = 0x7FFFFFFFFFFFF:u64
def pi = 3.14159265
def page = 64 * 1024
def tab = '\t'
def debug = false

data buf = mut [0:u8; page]

test "defs are constants" {
  assert buf.len == 65536
  assert mask51 == (1:u64 << 51) - 1
  assert pi > 3.14 && pi < 3.15
  assert tab == 9
  assert !debug
}
```

<!-- spec:end -->

#### `data` — Data Section Embedding

`data` lays a literal out in the data section and names its address. The value is an ordinary literal, and the name is a pointer to it, typed as tightly as the literal allows: `*[N]T` for an array or a string, `*T` for anything else, `*mut …` when the literal is `mut`. A pointer to an array converts to `[]T` or `[*]T` wherever one is wanted ([9.5](#95-array-type-conversions)).

<!-- spec:begin compile -->

```ents
data table = [1:u64, 2, 3, 4]      // *[4]u64
data key = x"9d61b19deffd5a60"     // *[8]u8
data buf = mut [0:u8; 1024]        // *mut [1024]u8
data count = 5:i32                 // *i32: four bytes
data tally = mut 5:i32             // *mut i32
data origin = (0.0, 0.0)           // *(f64, f64)

func sum(xs: []u64) -> u64 {
  let s: u64 = 0
  for x in xs {
    s += x
  }
  return s
}

test "data is a pointer" {
  assert sum(table) == 10
  assert key.len == 8 && buf.len == 1024
  tally.* += count.*
  assert tally.* == 10
  assert origin.*.1 == 0.0
}
```

<!-- spec:end -->

The difference between `data` and a literal written in place is the name: `data msg = "hello"` gives the bytes a name and an address known when the module is built, while an inline `"hello"` has no name and may share its bytes with equal constant literals. A type written for `data`, and data that refers to other data, are in [3.2](#32-data-declarations-data).

**Zeros are free:** wasm memory starts as zeros, so a data segment stops at the last byte that isn't zero, and `data buf = mut [0:u8; 1024]` emits no data segment at all. The zeros still hold their place: the data after them lies where it would. Laying out zeros takes the compiler no time or memory, however many there are (`mut [0:u8; 2147483648]`). All the data has to fit in the 4 GiB a wasm memory can hold: more is an error.

### 1.6 Statements and Line Breaks

Encantis has no statement separator. A block is a sequence of statements and a module a sequence of declarations, each ending where its grammar ends; line breaks are whitespace like any other. `;` is a syntax error between statements (it appears only in a repeat literal, `[v; n]`). Two statements may share a line, `let a = 1 let b = 2`, but one statement per line is how Encantis is written.

An expression goes on as far as the next token can continue it, across line breaks. So a line that starts with a token that can continue an expression continues the expression of the line before: `(` makes a call, `[` an index, `.` a member, and a binary operator (`+`, `-`, `*`, `&&`, `??`, …) an operation, as do `as` and `:`. Breaking a long expression before an operator is fine for that reason, and a statement that starts with `(` or `[` after one that ends in an expression joins it.

<!-- spec:begin compile -->

```ents
func g(x: u32) -> u32 => x * 10

test "an expression continues on the next line" {
  let a: u32 = 2
  let b = a
    + 3
  let c = g
  (a)
  assert b == 5
  assert c == 20
}
```

<!-- spec:end -->

The same goes for the statements that take an optional value. `return` takes the expression that follows it, on its line or the next: a bare `return` is written last in its block (where the code after it would never run anyway), or with its `when` on the same line, `return when done`. `break` and `continue` take no value, so `break` followed by an expression is two statements.

<!-- spec:begin compile -->

```ents
func f() -> u32 {
  let x: u32 = 1; let y: u32 = 2
  return x + y
}
```

```errors
Line 2, col 17
```

```ents
global count: u32 = 0

func g() -> u32 => 3

func f(done: bool) {
  if done {
    return
  }
  count += 1
}

func h() {
  return
  g()               // read as return g()
}
```

```errors
cannot assign u32 to ()
```

<!-- spec:end -->

---

## 2. Type System

A type is a number or a bool ([2.2](#22-primitive-types)), a value made of other values — a tuple, a struct or a fixed array ([2.7](#27-tuple-types), [2.8](#28-struct-types), [2.4](#24-fixed-arrays-value-type)) — or a reference to memory: a pointer or a slice ([2.5](#25-pointer-types), [2.6](#26-slices)). A host reference ([2.13](#213-host-references)) is a kind of its own. A value is held in registers (wasm locals, parameters, results and globals); only what a pointer or a slice points at is in linear memory ([2.3](#23-value-vs-reference-types)). Types are structural: two types written alike are one type, whatever they are named ([2.11](#211-type-names)); a host type is the one exception. Conversions are in [2.10](#210-type-conversions), and the limits on a type's size in [2.12](#212-limits).

### 2.1 Unified Value Model

A compound value is several values held together, and it is held the way its parts are: a tuple, a struct and a fixed array are their parts, one after another, in registers — one wasm value for each part, or several for a part that is itself compound — and a slice is two, its pointer and its length. None of them is in memory unless a pointer points at it.

| Kind | Written | Its parts | Reached by | Wasm values |
|------|---------|-----------|------------|-------------|
| Tuple ([2.7](#27-tuple-types)) | `(u32, f64)` | values, by position | `.0`, `.1`, ... | one per part |
| Struct ([2.8](#28-struct-types)) | `(x: f32, y: f32)` | named fields, which have positions too | `.x`, or `.0` | one per field |
| Fixed array ([2.4](#24-fixed-arrays-value-type)) | `[4]u32` | N elements of one type | `[k]`, `k` a constant | one per element |
| Slice ([2.6](#26-slices)) | `[]u8` | a pointer and a length | `.ptr`, `.len`, `[i]` | two `i32`s |

A function with several results returns them as a tuple. `let` takes a tuple or a struct apart by position (`let q, r = f()` is `let (q, r) = f()`) or by name (`let (x:, y:) = p` binds the fields `x` and `y`), and `set` does the same to variables that already exist ([6.5](#65-let-destructuring)):

<!-- spec:begin compile -->

```ents
type Point = (x: f32, y: f32)

func divmod(a: u32, b: u32) -> (u32, u32) => (a / b, a % b)
func swap(p: Point) -> Point => (p.y, p.x)

test "taken apart by position or by name" {
  let q, r = divmod(17, 5)
  assert q == 3 && r == 2
  let (x:, y:) = swap(Point(1.0, 2.0))
  assert x == 2.0 && y == 1.0
  set (q, r) = divmod(9, 4)
  assert q == 2 && r == 1
  let p = Point(3.0, 4.0)
  assert p.0 == p.x
}
```

The four kinds are related, but no one of them is another:

- A struct's fields have positions as a tuple's do (`p.0` is `p.x`), but a struct value is not a tuple value without names, nor the other way round: `cannot assign Point to (f32, f32)`. A tuple literal without names gives a struct its fields by position ([2.8](#struct-constructors)).
- A fixed array and a tuple of the same element type are different types: a tuple literal is no array (`cannot assign (int(1), int(2)) to [2]u16`), and an array has no `.0`.
- A slice is made from a tuple of a pointer and a length, `(p, n)` or `(ptr: p, len: n)`, wherever a slice is wanted ([2.6](#26-slices)), but it is not a struct: a pattern does not take it apart (`cannot destructure non-tuple type: []u8`), and it does not convert to or from a struct of the same layout. Read its `.ptr` and `.len`.
- A tuple is one value: given to a function of two parameters it is one argument, not two.
- `==` and `!=` compare numbers, bools and addresses, not compound values: compare a struct, a tuple, an array or a slice part by part.

```ents
type Point = (x: f32, y: f32)
type Span = (ptr: [*]u8, len: u32)

func divmod(a: u32, b: u32) -> (u32, u32) => (a / b, a % b)
func scale(q: u32, r: u32) -> u32 => q * 10 + r

func a(p: Point) -> (f32, f32) => p
func b(s: []u8) -> u32 {
  let (p, n) = s
  return 0
}
func c(s: []u8) -> Span => s
func d() -> u32 => scale(divmod(17, 5))
func e(p: Point, q: Point) -> bool => p == q
```

```errors
cannot assign Point to (f32, f32)
cannot destructure non-tuple type: []u8
cannot assign []u8 to Span
'scale' expected 2 arguments, got 1
argument 1: cannot assign (u32, u32) to u32
'==' cannot be applied to Point and Point
```

<!-- spec:end -->

### 2.2 Primitive Types

| Category | Types | Wasm value | Bytes in memory |
|----------|-------|------------|-----------------|
| Signed integers | `i8`, `i16`, `i32`, `i64` | `i32`, or `i64` for `i64` | 1, 2, 4, 8 |
| Unsigned integers | `u8`, `u16`, `u32`, `u64` | `i32`, or `i64` for `u64` | 1, 2, 4, 8 |
| Wide integers | `i128`, `u128`, `i256`, `u256`, `i512`, `u512` | 2, 4 or 8 `i64`s | 16, 32, 64 |
| Floating point | `f32`, `f64` | `f32`, `f64` | 4, 8 |
| Boolean | `bool` | `i32`, 0 or 1 | 1 |

Integer `+`, `-`, `*`, `<<` and negation wrap: the result is reduced to its type's width, in two's complement, and never traps. Division and remainder trap on a zero divisor, and an `i32` or `i64` division of the most negative value by -1 traps too, as wasm's does ([4.1](#41-arithmetic-operators)). A type narrower than 32 bits is held in an `i32` that always holds a value of that type, so the compiler masks (unsigned) or sign-extends (signed) what an operation leaves there: `250:u8 + 10` is 4, and `127:i8 + 1` is -128. Whether an integer is signed is its type's affair: `i32` and `u32` are the same wasm `i32`, and the operator picks the signed or the unsigned instruction (`/`, `%`, `>>`, the comparisons, widening). The operators themselves are in chapter 4.

<!-- spec:begin compile -->

```ents
func add8(a: u8, b: u8) -> u8 => a + b
func inc8(a: i8) -> i8 => a + 1
func dec(a: u32) -> u32 => a - 1
func bit(b: bool) -> u32 => b as u32

test "integers wrap at their width" {
  assert add8(250, 10) == 4
  assert inc8(127) == -128
  assert dec(0) == 4294967295
  assert bit(3 > 2) == 1
}
```

<!-- spec:end -->

A number written without a type, `300` or `2.5`, has none of its own until its use gives it one ([1.5](#integer-literals), [2.10](#comptime-literal-promotion)); a message shows it as `int(300)` or `float(2.5)`, as in `cannot assign int(300) to u8`.

**`bool`** is `true` or `false`, and no number. A condition is a `bool`, and an integer is not one; arithmetic and ordering do not take a `bool`. `==`, `!=`, `!`, `&&`, `||` and the bitwise `&`, `|`, `^` do. `b as u32` is 0 or 1; nothing casts to a `bool`, so a number is tested with a comparison, `x != 0` ([2.10](#explicit-casts)).

<!-- spec:begin compile -->

```ents
func ready(n: u32) -> bool {
  if n { return true }
  let b: bool = 1
  return b + 1
}
```

```errors
condition must be bool, not u32
cannot assign int(1) to bool
'+' cannot be applied to bool: cast it to an integer first
```

<!-- spec:end -->

**Wide integers.** An `i128` or `u128` is two `i64`s, an `i256` or `u256` four, an `i512` or `u512` eight, least significant first, in registers and in memory alike (in memory, little-endian 64-bit limbs one after another, [9.6](#96-structs-and-slices-in-memory)). These work on them, through helper functions the compiler adds to the module or short `i64` sequences: `+`, `-` and `*` (wrapping, as on any integer), negation, `~`, `&`, `|`, `^`, the shifts and rotations, all six comparisons (signed or unsigned as the type is), widening from a narrower integer and between wide types, casts to a narrower integer (the low bits) and between signed and unsigned, and the builtins `min`, `max` and `abs` ([10.1](#101-numeric-builtins)). Not supported yet, and compile errors: `/` and `%`, the saturating operators, casts to and from a float, and the bit counts `clz`, `ctz` and `popcnt`.

<!-- spec:begin compile -->

```ents
func wide(a: u64, b: u64) -> u128 => (a as u128) * b
func low(x: u128) -> u64 => x as u64
func high(x: u128) -> u64 => (x >> 64) as u64
func less(a: i128, b: i128) -> bool => a < b

test "a u128 holds the whole product of two u64s" {
  let p = wide(0xFFFFFFFFFFFFFFFF, 3)
  assert high(p) == 2
  assert low(p) == 0xFFFFFFFFFFFFFFFD
  assert less(-1, 0)
  assert min(p, 7) == 7
}
```

```ents
func half(x: u128) -> u128 => x / 2
func ratio(x: u128) -> f64 => x as f64
func bits(x: u128) -> u8 => popcnt(x)
```

```errors
'/' on u128 is not supported yet
cannot cast u128 to f64: not supported yet
popcnt requires i32, u32, i64 or u64, got u128
```

<!-- spec:end -->

#### Ranged Integers

An unsigned integer type can carry an upper bound: `u32#N` holds the values 0 through N - 1. The bound is a compile-time fact and nothing more: a `u32#6` is a plain `u32` in WebAssembly, and no instruction checks it. What it buys is an index that needs no bounds check ([4.7](#47-bounds-checked-indexing)).

The `#` follows an unsigned type name (`u8` to `u512`) directly, with no space on either side. The bound written after it is decimal digits or a name — a `def` or a comptime value parameter ([8.7](#87-comptime-value-parameters)) — and any other constant is written in parentheses: `u32#(0x10)`, `u32#(n - 1)`. It is computed exactly, as a length is ([2.4](#24-fixed-arrays-value-type)). A bound is at least 1 (`range bound must be at least 1: u32#0 has no values`) and at most the number of values the type has: `u8#256` is every `u8`, and `u8#300` is `range bound 300 is too large for u8, which has 256 values`. Signed and float types take no bound, and `i32#4`, `u32 #6`, `u32#0x10` are syntax errors; `u32#n-1` names `n-1` (a hyphen joins a name, [1.2](#12-identifiers)).

A value has a range when the compiler can see one:

- a constant that fits it: `let i: u32#6 = 5`;
- the index of a counted loop, `for i in 6` (a `u32#6`), or `for i in n` with `n` a `def` or a value parameter ([5.2](#52-loops));
- an operator with a constant `K` — a literal, a `def` or a value parameter, not an `if` of constants:
  - `x + K`, with `x` ranged (`#N`), is `#(N + K)`, and `x * K` (K above 0) is `#((N - 1) * K + 1)`: a `u32#4 * 2` is a `u32#7`. The constant may stand on either side;
  - for any unsigned `x`, ranged or not, `x & K` (either side) is `#(K + 1)`, `x % K` (K above 0, on the right) is `#K`, and `x >> K` keeps the bits that are left: a `u32 >> 29` is a `u32#8`, a `u32#256 >> 5` a `u32#8`. The count is the one the shift takes ([4.2](#42-bitwise-operators)): `x >> 32` on a `u32` is `x`, with no range. When `x` has a smaller range of its own, it keeps that one;
  - a `u8` or a `u16` is bounded by its width, so a `u8` indexes a `*[256]T` with no check;
- `min` and `max` when every operand is ranged, or a constant inside the widest of those ranges: the result has the widest range. With `i: u32#4`, `min(i, 2)` is a `u32#4`, but `min(i, 7)` a plain `u32` ([10.1](#101-numeric-builtins));
- a comparison that narrows it (below);
- a cast, `x as u32#N`, which is not checked (below).

Nothing else gives a range: `x - K`, `x / K`, `x | K`, `x << K` and arithmetic on two variables are plain `u32`s. So a proven index is written with the operators that keep one: `h >> 5`, not `h / 32`.

<!-- spec:begin compile -->

```ents
def size = 8

data squares = [0:u32, 1, 4, 9, 16, 25, 36, 49]

func square(i: u32#size) -> u32 => squares[i]
func masked(x: u32) -> u32 => squares[x & 7]
func top(x: u32) -> u32 => squares[x >> 29]
func odd(i: u32#4) -> u32 => squares[i * 2 + 1]
func bucket(h: u32#256) -> u32 => squares[h >> 5]
func evens() -> u32 {
  let t: u32 = 0
  for i in 4 { t += squares[i * 2] }
  return t
}
func last(i: u32#(size - 1)) -> u32 => squares[i + 1]
func nibble(x: u32#(0x10)) -> u32 => squares[x >> 1]

test "a ranged index needs no check" {
  assert square(3) == 9
  assert masked(13) == 25
  assert top(0xFFFFFFFF) == 49
  assert odd(3) == 49
  assert bucket(255) == 49
  assert evens() == 56
  assert last(6) == 49
  assert nibble(15) == 49
}
```

An index whose range may pass the length proves nothing, and is checked like any run-time index ([4.7](#47-bounds-checked-indexing)): it is resolved with `if let` or `??`, and anywhere else it is an error:

```ents
data squares = [0:u32, 1, 4, 9, 16, 25, 36, 49]

func a(h: u32#256) -> u32 => squares[h / 32]
func b(i: u32#8) -> u32 => squares[i - 1]
func c(i: u32#8) -> u32 => squares[i + 1]
func d(i: u32#4, j: u32#4) -> u32 => squares[i + j]
```

```errors
runtime index on *[8]u32 requires 'if let' or '??' (no optional type for u32)
runtime index on *[8]u32 requires 'if let' or '??' (no optional type for u32)
index type u32#9 may exceed *[8]u32 bounds
runtime index on *[8]u32 requires 'if let' or '??' (no optional type for u32)
```

<!-- spec:end -->

**Assigning.** A ranged type takes a value whose range fits in it — `u8#8` fits `u8#16`, which fits `u8` — and widens to its plain type and on, like it (`u32#4` to `u32` to `i64`). A plain value, or a constant too large, is an error. A variable keeps the type it is declared with, also one `let` infers: `let k = x & 15` is a `u32#16`, so `k = x` is refused, and a compound assignment has to leave the result in the range (`k &= 7`, `k >>= 1` and `k %= 4` do; `k += 1` does not). A variable meant to take any value is given its plain type, `let k: u32 = x & 15`.

<!-- spec:begin compile -->

```ents
func f(x: u32) -> u32 {
  let i: u32#6 = 6
  let j: u32#6 = x
  let k = x & 15
  k += 1
  k = x
  return 0
}
```

```errors
cannot assign int(6) to u32#6
cannot assign u32 to u32#6
cannot assign u32#17 to u32#16 (the result of '+=')
cannot assign u32 to u32#16
```

<!-- spec:end -->

**Narrowing.** Comparing an unsigned variable (a parameter or a `let`) with a constant narrows its range wherever the comparison is known to hold: inside an `if` branch, in the later `elif` and `else` branches (where the earlier conditions are false), and in the rest of a block after `return`, `break` or `continue when c`, or after an `if c { ... }` whose branch always exits. `!` turns a comparison around, `&&` combines bounds, and `||` narrows only where it is false. The comparison written is the bounds check, so nothing else runs.

<!-- spec:begin compile -->

```ents
data buf = mut [0:u8; 12]

func put(x: u32, v: u8) {
  if x < 12 {
    buf[x] = v                   // x is a u32#12 in this branch
  }
}
func get(x: u32) -> u8 {
  return 0 when x >= 12
  return buf[x]                  // and here: the return above guards it
}
func sum(x: u32, y: u32) -> u8 {
  if x >= 12 || y >= 12 { return 0 }
  return buf[x] + buf[y]         // both are below 12 where the || is false
}

test "a comparison with a constant narrows" {
  put(3, 7)
  put(40, 9)
  assert get(3) == 7
  assert get(40) == 0
  assert sum(3, 3) == 14
}
```

Nothing else narrows: a signed variable, a field (`c.at < 12`), a comparison with a variable, a `while` condition, and a variable assigned anywhere in the region the comparison would cover.

```ents
data buf = mut [0:u8; 12]
type Cursor = (at: u32)

func a(x: i32) -> u8 {
  return 0 when x < 0 || x >= 12
  return buf[x]
}
func b(c: Cursor) -> u8 {
  return 0 when c.at >= 12
  return buf[c.at]
}
func c(x: u32, n: u32) -> u8 {
  return 0 when x >= n
  return buf[x]
}
```

```errors
runtime index on *[12]u8 requires 'if let' or '??' (no optional type for u8)
runtime index on *[12]u8 requires 'if let' or '??' (no optional type for u8)
runtime index on *[12]u8 requires 'if let' or '??' (no optional type for u8)
```

<!-- spec:end -->

**A cast is a promise.** `x as u32#N` gives `x` the range with no check: it is how a program states a fact the compiler cannot see, as `lib/fixedvec.ents` does after `assert v.len > 0` with `(v.len - 1) as u32#n`. A value outside the range is then used as if it were in it, and an index proven by it reads or writes past the array unchecked. Where the fact is not certain, compare instead, and let narrowing give the range.

### 2.3 Value vs Reference Types

Encantis has a simple rule: **`*` means pointer, `[]` means slice — both are references. Everything else is a value**, with one kind that is neither: a host reference.

| Category       | Types                               | Semantics               |
|----------------|-------------------------------------|-------------------------|
| **Values**     | primitives, tuples, structs, `[N]T` | held in registers; passed and assigned by copying |
| **References** | `*T`, `*[N]T`, `*[!]T`, `[*]T`, `[]T`, and their `?` forms | an address (and a slice's length) held in registers, pointing at memory |
| **Host references** | `type Canvas = host` ([2.13](#213-host-references)) | copied like a value, the host's object shared; never in memory |

`[N]T` has brackets but is a value: `N` is a compile-time constant, so the compiler knows how many wasm values it takes. A reference is reached through an address in linear memory.

A parameter is a variable of its function. Assigning to it, or to a field or element of it, changes the function's copy and nothing of the caller's; writing through a reference changes the memory it points at, which the caller sees:

<!-- spec:begin compile -->

```ents
type Point = (x: i32, y: i32)

data origin: Point = mut (0, 0)

func moved(p: Point) -> Point {
  p.x += 1                       // the function's own copy
  return p
}
func move(p: *mut Point) {
  p.x += 1                       // the memory p points at
}

test "a value is copied, a reference shares" {
  let p = Point(1, 2)
  let q = moved(p)
  assert p.x == 1 && q.x == 2
  move(origin)
  move(origin)
  assert origin.x == 2
}
```

<!-- spec:end -->

### 2.4 Fixed Arrays (Value Type)

`[N]T` is N elements of `T`, held by value: like a tuple, it is N times the wasm values of `T` (`[4]u8` is four `i32`s, `[2]u128` four `i64`s), in no memory. It is copied when it is passed, returned or assigned.

**Lengths.** A length is a compile-time constant: a number, a `def` (`def size = 64` makes `[size]u8` and `*mut [size]u8` types), a comptime value parameter ([8.7](#87-comptime-value-parameters)), `sizeof` of a type ([10.4](#104-sizes)), the `.len` of a `*[N]T`, or arithmetic on these, `[k * 2]u8`, `[sizeof(Pt) * 4]u8`. In a signature, a length reads the function's comptime parameters and none of its others: beside `p: *[4]u32`, a parameter `q: *[p.len]u32` is `array length must be a compile-time constant` (in the body, `*[p.len]u32` is a `*[4]u32`). A length is computed exactly, as no type, and the type has the number in it: `[2 + 2]u8` is `[4]u8`. A number with a radix prefix is a length too, `[0x10]u8` is sixteen bytes; the `x` of a packed array's dimensions ([Nesting](#nesting)) is read only between decimal numbers. A length is at least 0 (`[0]u8` holds nothing; `array length cannot be negative: it is -1`), an integer (`array length must be an integer: it is float(2)`) and at most 4294967295, and an array, wherever it is (in registers, in memory or behind a pointer), has at most 4294967295 bytes: `sizeof` of an array is a `u32`, and so is the byte offset of every element a proven index reaches. `*[1000000000]u64` is `array [1000000000]u64 is too large: 8000000000 bytes, more than the 4294967295 a 32-bit memory addresses`. Behind a pointer or a slice, an array of fixed arrays is a table ([Nesting](#nesting)), `n` row pointers, so its size is theirs: `*[65536][65537]u8` is 65536 pointers to rows of 65537 bytes, as `*[65536]*[65537]u8` is. A typed constant is what it is in any expression: `[300:u8]u8` is `cannot assign int(300) to u8`, and `[~0:u8]u8` is `[255]u8`. A length that divides by zero, `[64 / 0]u8`, is `array length divides by zero`. A hyphen joins a name ([1.2](#12-identifiers)), so `[n-1]u8` names `n-1`: write `[n - 1]u8`.

**A length from the literal.** `[_]` in the type given to a literal with `:` takes its length from the literal: `[95, 87, 42]:*[_]i32` is a `*[3]i32`, and `data scores = [95, 87, 42]:*[_]i32` names one. Not implemented: `[_]` as the declared type of a variable, a global or a `data` (`data d: *[_]u8 = [1, 2, 3]`), and a `[_]T` held by value; write the type on the literal instead.

**Indexing.** The elements are registers, which wasm cannot index by a run-time value, so an array held in registers is indexed only by a compile-time constant, checked against N when the program is compiled. A run-time index, a ranged one too, is an error: an array that is indexed at run time belongs in memory, behind a pointer or a slice. An element of an array variable can be assigned, `v[1] = 9`. An array that lies in memory as a field of a struct a pointer points to (`p.items`) has an address, and there it is indexed by any index as the `*[N]T` it is: see [Fixed Arrays in Place](#fixed-arrays-in-place).

**Members.** `v.len` is N and `v.wid` is `sizeof(T)`, both constant `u32`s ([2.5](#25-pointer-types)). `v.ptr` is an error: an array held by value is its elements and has no address, also where it was read out of memory (`p.*`). One that lies in memory has the address of its place, `(&p.items).ptr`.

**No address.** Since it has none, an array held in registers is not passed where a pointer or a slice is wanted: `sum(v)` with `v: [3]i32` and `sum(r: *[3]i32)` is `cannot assign [3]i32 to *[3]i32`, and `v.sum()` is `the receiver is a [3]i32, which is held in registers and has no address`. An element loop needs a slice or a pointer (`cannot iterate over [3]u32`), and `==` does not compare arrays. An array literal is laid out in memory where a pointer or a slice is wanted, so `sum([1, 2, 3])` is fine; its elements are the pointer's elements, so `[[1, 2, 3], [4, 5, 6]]` is no `*[3]i32` (`cannot assign [3]i32 to i32`), and a string is one among them only where an element is a byte.

Fixed arrays suit small data that is read by constant positions: the limbs of a number, the channels of a colour, the coordinates of a vector.

<!-- spec:begin compile -->

```ents
type Rgba = [4]u8

func gray(c: Rgba) -> u8 => ((c[0] as u32 + c[1] + c[2]) / 3) as u8
func opaque(c: Rgba) -> Rgba {
  c[3] = 255
  return c
}

test "a fixed array is values in registers" {
  let c: Rgba = [30, 60, 90, 0]
  assert gray(c) == 60
  assert opaque(c)[3] == 255
  assert c[3] == 0
  assert c.len == 4 && c.wid == 1
}
```

```ents
func pick(v: [4]u8, i: u32, k: u32#4) -> u8 {
  let a = v[i]
  let b = v[k]
  let c = v[4]
  let p = v.ptr
  return 0
}
func total(v: [3]u32) -> u32 {
  let t: u32 = 0
  for x in v { t += x }
  return t
}
func sum(r: *[3]i32) -> i32 => r[0] + r[1] + r[2]
func pass(v: [3]i32) -> i32 => sum(v)
func literal() -> i32 => sum([1, 2, 3])
```

```errors
dynamic index on value type [4]u8 — use a pointer or slice for dynamic access
dynamic index on value type [4]u8 — use a pointer or slice for dynamic access
index 4 out of bounds for [4]u8
cannot take .ptr of [4]u8: a fixed array held by value has no address
cannot iterate over [3]u32: use a count, a slice, or a pointer to a fixed-size array
argument 1: cannot assign [3]i32 to *[3]i32
```

<!-- spec:end -->

### 2.5 Pointer Types

A pointer is an address in the module's one 32-bit linear memory: one wasm `i32` in registers, 4 bytes in memory. Every pointer type starts with `*` or a bracket form, so a reference never looks like a value. What it points at decides how it is read:

| Type | Points at | `.len` | `.wid` | `.ptr` | `p[i]` |
|------|-----------|--------|--------|--------|--------|
| `*T` | one `T`; `p.*` is it | — | — | — | `p[0]` only, as `p.*` ([4.6](#46-pointer-operations)) |
| `*[N]T` | N elements; `p.*` loads all N as a `[N]T` | N | `sizeof(T)` | `[*]T` | checked against N ([4.7](#47-bounds-checked-indexing)) |
| `*[NxM]T` | N rows of M elements, packed | N | `sizeof(T)` | `[*]T` | row `i`, a `*[M]T` at `i × M × sizeof(T)`, checked against N |
| `*[N][M]T` | a table: N pointers to rows of M ([Nesting](#nesting)) | N | 4 | `[*][M]T` | row pointer `i`, loaded, checked against N |
| `*[!]T` | elements up to the first all-zero one | scanned | `sizeof(T)` | `[*]T` | checked against the scanned length |
| `[*]T` | elements, of a count it does not know | — | `sizeof(T)` | itself | not checked |
| `[]T` | a slice: pointer and length ([2.6](#26-slices)) | at run time | `sizeof(T)` | `[*]T` | checked against `.len` |
| `[N]T` | (a value, [2.4](#24-fixed-arrays-value-type)) | N | `sizeof(T)` | — | constant index only |

`.len` is the number of elements (of rows, for `*[NxM]T` and a table), `.wid` the bytes of one element (a row pointer's 4 in a table), and both are `u32`s, constants where the type has the number: `p.len * p.wid` is the bytes a `*[N]T` points at, and `p.len * M * p.wid` those of a packed `*[NxM]T`. A `*T` has no `.len` or `.wid` (`no field 'wid' on type *u64`): `sizeof(T)` is its size. `.ptr` is the address as a many-pointer, `[*]T`, or `[*]mut T` for a mutable pointer or slice; a `[*]T` has no `.len`. Besides these, a pointer to a struct reaches its fields (`p.x`), a pointer to a tuple its parts (`p.0`), through the one pointer ([9.6](#96-structs-and-slices-in-memory)), and every pointer has the type views `p.u8` ... `p.f64` ([4.6](#type-punned-memory-access)).

<!-- spec:begin compile -->

```ents
type Pair = (a: u16, b: u16)

data count = mut 0:u32
data table: *[4]u16 = [10, 20, 30, 40]
data name: *[!]u8 = "ada"
data pairs: *[2]Pair = [(1, 2), (3, 4)]

func bump(p: *mut u32) -> u32 {
  p.* += 1                         // .* is the u32 at p
  return p.*
}
func whole(p: *[4]u16) -> [4]u16 => p.*      // the four elements, loaded
func bytes(p: *[4]u16) -> u32 => p.len * p.wid
func peek(p: [*]u16, i: u32) -> u16 => p[i]   // no length: unchecked
func second(p: *Pair) -> u16 => p.b           // a field through the pointer

test "pointers" {
  assert bump(count) == 1
  assert bump(count) == 2
  assert whole(table)[3] == 40
  assert bytes(table) == 8
  assert peek(table.ptr, 2) == 30
  assert name.len == 3
  assert (name[1] ?? 0) == 'd'
  assert second(&pairs[1]) == 4
}
```

<!-- spec:end -->

**An address as a constant.** A plain pointer (`*T`, `*[N]T`, `*[!]T`, `[*]T`, mutable or not) is an address, and an integer constant that fits 32 bits stands for one with no cast: `global words: [*]mut u32 = 0` is a pointer that a function sets before it is used. A constant that fits an `i32` or a `u32` is taken as its 32-bit pattern (`-1` is the address 4294967295), and one that fits neither is an error (`cannot assign int(5000000000) to u32`). A value of an integer type needs a cast, `x as *u32` ([2.10](#explicit-casts)). A slice is never a number: `cannot assign int(0) to []u8`. A plain pointer 0 is an address like any other, not none, so nothing stops a read through it; where "no pointer" is meant, use an optional, `?*T` (below).

<!-- spec:begin compile -->

```ents
data space = mut [0:u32; 4]

global words: [*]mut u32 = 0          // an address, set before it is used

func setup() { words = space as [*]mut u32 }

test "a constant address for a plain pointer" {
  setup()
  words[1] = 5
  assert space[1] == 5
}
```

```ents
func f(x: u32) -> *u32 => x
func g() -> []u8 => 0
```

```errors
cannot assign u32 to *u32
cannot assign int(0) to []u8
```

<!-- spec:end -->

**Null-terminated arrays.** A `*[!]T` ends at its first element whose bytes are all zero (the terminator the literal is laid out with: one whole element of zeros, a struct's or a slice's `(ptr, len)` too, so the elements of a `*[!][]u8` are pairs as in any array of slices), so `.len` reads elements until it finds it; the scan reads each element as one integer, so `T` must be 1, 2, 4 or 8 bytes wide (`cannot find the length of *[!]Rgb: the scan for its zero end needs elements of 1, 2, 4 or 8 bytes`). Its length known only at run time, an index into a `*[!]T` is checked as one into a slice is ([4.7](#47-bounds-checked-indexing)): `z[i] ?? 0`, `if let x = z[1]`, each scanning for the length. `[!]T` written without the `*` is the same type, held as the same pointer. Neither is a slice until its length is scanned for: `(z.ptr, z.len)` makes one ([9.5](#95-array-type-conversions)), and passing a `*[!]u8` where a `[]u8` is wanted is an error. A packed array is written with its `*`, `*[NxM]T`, and it converts to a slice of its N×M elements.

**Length-prefixed arrays.** Not implemented: a `*[?]T` (a length in LEB128, then the elements) is laid out but not read: indexing one and `.len` are compile errors (`indexing *[?]u8 is not supported yet: its length prefix is not read`).

**Framings with dimensions.** Not implemented: a framing combined with another dimension — `*[5x!]T`, `*[!x!]T`, `*[5x?]T` — is accepted by the grammar and the checker, but neither laid out nor read as the framings say. Write a table of framed rows instead, `*[5][!]T` ([Nesting](#nesting)).

#### Optional Types

A pointer, a slice and a host reference ([2.13](#213-host-references)) can be **optional**: it then holds a value or none. `?` is written directly before `*`, `[]`, `[*]` or a type name: `?*T`, `?*mut T`, `?*[N]T`, `?*[!]T`, `?[*]T`, `?[]T`, `?[]mut T`, `?Name`. Anything else after `?` is a syntax error: `?u32`, `?[4]u8`, `?[!]u8`, `?(*u8)`, `??*u8`. A number has no none, since every bit pattern of a `u8` is a value, and neither has a tuple, a struct or a fixed array. A name is made optional when it names a pointer, a slice or a host type: with `type P = *u8`, `?P` is a `?*u8`, and with `type Count = u32`, `?Count` is `cannot make Count optional: only a pointer, a slice or a host reference has a none`. A type parameter is checked the same way in each instance: `?T` given `T = u32` is that error, `in keep(T = u32)`.

**None** is written `0` wherever an optional is wanted — a `let`, a result, an argument, a field, a global, an element of a literal or of `data` — and in a cast, `0 as ?[]u8` as `0 as ?*u8`. An optional slice that is none is the pointer 0 with the length 0; any slice whose pointer is 0 is none once it is optional. Program data starts at address 8 ([9.0](#90-data-layout)), so no `data` and no literal has the address 0, and an empty slice of real memory (`""`, `p[0..0]`) is not none.

- `x == 0` and `x != 0` ask whether it is none (an optional slice compares its pointer). An optional slice compares with nothing but `0`, and with `==` and `!=` only; an optional pointer compares as a pointer does.
- A plain value widens to an optional implicitly: a `*T` passes for a `?*T`, a `[]T` for a `?[]T`, also as an argument or a result.
- A global of an optional type given no value starts as none. A `let` of an optional pointer or slice given no value is none when the function starts, as every variable of a function is zero then, and it is not reset when control reaches the `let` again: in a loop it keeps what the last pass left in it ([3.3](#33-variables)). (A `let` of an optional host reference starts as none, [2.13](#never-null-and-optional).)
- In WebAssembly an optional is held as its plain form is: an `i32` for a pointer, two for a slice, an `externref` for a host reference.

<!-- spec:begin compile -->

```ents
type Entry = (key: u32, name: ?[]u8)

data entries: *[2]Entry = [(key: 1, name: 0), (key: 2, name: "two")]
global last: ?[]u8 = 0

func find(key: u32) -> ?[]u8 {
  for e in entries {
    return e.name when e.key == key
  }
  return 0
}
func size(s: ?[]u8) -> u32 => if let x = s { x.len } else { 99 }
func cell(p: ?*u32) -> u32 => if p == 0 { 0 } else { 1 }
func unnamed() -> Entry => Entry(9, 0 as ?[]u8)
type Name = []u8
func named(s: ?Name) -> u32 => if let x = s { x.len } else { 99 }
func keep(comptime T: type, x: ?T) -> ?T => x

test "none is 0 for an optional pointer and an optional slice" {
  assert named("ab") == 2
  assert named(0) == 99
  assert size(keep(find(2))) == 3
  assert keep(find(1)) == 0
  assert find(1) == 0
  assert find(2) != 0
  assert size(find(2)) == 3
  assert size(find(3)) == 99
  assert size(0) == 99
  assert size("") == 0
  assert last == 0
  assert cell(0) == 0
  assert unnamed().name == 0
}
```

<!-- spec:end -->

**Resolving.** An optional is used as its plain form only once it is resolved, and two things resolve one: `if let v = x { ... }`, which gives the plain value `v` in its first branch ([`if let` Bindings](#if-let-bindings)), and `x ?? fallback`, which is `x`'s value, or `fallback` where `x` is none ([The `??` Operator](#the--operator)). Until then nothing is read through it: indexing it (`q[0]`), dereferencing it (`p.*`), a member of it (`p.x`, `s.len`, `s.ptr`, a type view), a range of it, a loop over it and moving it (`p + 4`) are all errors (`cannot index ?*[3]i32: it may be none — resolve it with 'if let' or '??' first`). It can be compared, as above, and passed where an optional is wanted.

<!-- spec:begin compile -->

```ents
type Node = (next: ?*Node, value: u32)

data tail: Node = (0, 30)
data head: Node = (tail, 10)

func value-after(n: *Node) -> u32 {
  if let next = n.next {
    return next.value
  }
  return 0
}
func next-or-self(n: *Node) -> *Node => n.next ?? n

test "if let and ?? give the plain pointer" {
  assert value-after(head) == 30
  assert value-after(tail) == 0
  assert next-or-self(tail).value == 30
}
```

A comparison with `0` asks and resolves nothing: it does not change the type of `x`, inside an `if` or after a guard, so `return 0 when p == 0` leaves `p` a `?*u32`. An early exit on none is written with `if let ... else`, or with a fallback:

```ents
func read(p: ?*u32) -> u32 {
  return 0 when p == 0
  return p.*
}
```

```errors
cannot dereference ?*u32: it may be none — resolve it with 'if let' or '??' first
```

No other number is none, a plain slice has no none, and an optional slice is only ever equal or not to none:

```ents
func f(s: ?[]u8) -> bool {
  let a: ?[]u8 = 5
  let b: []u8 = 0
  return s < 0
}
func g(p: ?*u8, s: ?[]u8) {
  let q: *u8 = p
  let t: []u8 = s
  let u = s as []u8
}
type Count = u32
func h(c: ?Count) {}
```

```errors
cannot make Count optional: only a pointer, a slice or a host reference has a none
cannot assign int(5) to ?[]u8
cannot assign int(0) to []u8
'<' cannot be applied to ?[]u8 and int(0)
cannot assign ?*u8 to *u8: it may be none — resolve it with 'if let' or '??' first
cannot assign ?[]u8 to []u8: it may be none — resolve it with 'if let' or '??' first
cannot cast ?[]u8 to []u8: it may be none — resolve it with 'if let' or '??' first
```

<!-- spec:end -->

**Plain types and 0.** A plain type has no none, so `== 0` asks nothing of it: a plain slice or a plain host reference compared with `0` is an error. A plain pointer still compares with 0, as an address compares with any address, not as a none. Given no value, a number, a plain pointer and a plain slice are zero (0, the address 0, the empty slice) when the function starts, and the `let` does not reset them ([3.3](#33-variables)); a plain host reference has no default at all, and gets its value where it is declared, as does a struct or a fixed array that holds one ([2.13](#never-null-and-optional)).

#### Mutability

A pointer is **read-only** unless it is written with `mut`, and so is a slice and a many-pointer:

| Read-only | Writable | |
|-----------|----------|-|
| `*T` | `*mut T` | one `T` |
| `*[N]T` | `*mut [N]T` | N elements (and every other array pointer: `*mut [!]T`, `*mut [N][M]T`, ...) |
| `[*]T` | `[*]mut T` | a many-pointer |
| `[]T` | `[]mut T` | a slice |

Only a `mut` one is written through: with `p` read-only, an assignment to `p.*`, to an element `p[i]`, to a field `p.x`, or through the address `&p[i]` of an element is `cannot write through const pointer — use *mut for mutable access`. A mutable pointer passes where a read-only one of the same type is wanted (the same holds for a slice and a many-pointer, and a `*mut [N]T` becomes a `[]mut T` or a `[]T`), and never the other way round. So a function takes a read-only pointer or slice unless it writes, and then any caller can pass what it has.

`mut` belongs to one pointer: in `*mut *u8` the pointer that is pointed at can be replaced (`p.* = q`), but the byte it points at cannot be written (`p.*.* = 1` is refused). A `data` without `mut` is read-only, and so is a literal: where a mutable pointer or slice is wanted, a literal is written with `mut`, which gives it memory of its own ([The `mut` Keyword on Literals](#the-mut-keyword-on-literals)). A cast between pointer types converts the address, and the type it gives may be `mut` (`p as *mut u8`); a slice is not cast (`cannot cast []u8 to []mut u8`).

<!-- spec:begin compile -->

```ents
data buf = mut [0:u8; 4]
data text = "hi"

func size(msg: []u8) -> u32 => msg.len        // reads only: a const slice
func put(dst: []mut u8, v: u8) -> bool {       // writes: a mutable slice
  if let p = &dst[0] {
    p.* = v
    return true
  }
  return false
}

test "a mutable pointer passes where a const one is wanted" {
  assert size(buf) == 4
  assert put(buf, 7)
  assert buf[0] == 7
  assert size(text) == 2
  assert put(mut "ab", 1)
}
```

```ents
data text = "hi"

func put(dst: []mut u8, v: u8) -> bool => false
func a() -> bool => put(text, 1)
func b() -> bool => put("hi", 1)
func c(p: *u8) { p.* = 1 }
func d(p: *u8) -> *mut u8 => p
func e(p: *mut *u8) { p.*.* = 1 }
```

```errors
argument 1: cannot assign *[2]u8 to []mut u8
argument 1: a literal is constant: write `mut "hi"` for a []mut u8
cannot write through const pointer — use *mut for mutable access
cannot assign *u8 to *mut u8
cannot write through const pointer — use *mut for mutable access
```

<!-- spec:end -->

#### Nesting

A pointer can point at any type that lies in memory: `*[]T` points at a slice (its pointer and length, 8 bytes), `**T` at a pointer, `*[N]Point` at N structs. Arrays of arrays are written two ways:

| Type | In memory | `p[i]` |
|------|-----------|--------|
| `*[NxM]T` | N×M elements in one packed block | the address of row `i`, computed |
| `*[N][M]T` | a table: N row pointers, each row laid out on its own | row pointer `i`, loaded |

The two spellings of a 2D array lie in memory differently. `*[NxM]T` is one packed block of N×M elements: `p[i]` is the address of row `i`, `i × M × sizeof(T)` bytes in, and nothing is loaded. The row index is checked against N as a table's is (below): a constant or ranged one at compile time, any other resolved where it is taken, with `if let r = p[i]` or `p[i] ?? other`. `*[N][M]T` is a **table**: its N elements are pointers to rows of M elements, and each row is laid out on its own. The same goes for any pointer or slice whose element is a fixed array — `*mut [N][M]T`, `[][M]T`, `[]mut [M]T`, `[*][M]T` — and for deeper ones: in `*[2][3][4]T` each element is a `*[3][4]T`, itself a table. Rows that are framed or packed are laid out on their own too: an element of `*[N][!]T` is a `*[!]T`, and one of `*[N][AxB]T` a `*[AxB]T` (so `m[i][j][k]` is cell `k` of row `j` of block `i`); a `*[!][M]T` is a table whose row pointers end with a null one.

A fixed array that is a field of a struct is the exception: it lies in place, packed, wherever the struct is ([Fixed Arrays in Place](#fixed-arrays-in-place)). A generic type that puts a type parameter behind a pointer makes a table of it too when it is given a fixed array, so a row that should lie in place is wrapped in a one-field struct: `Vec((cells: [3]i32))` ([8.5](#85-generic-types)).

In a table:

- `m[i]` loads row pointer `i` (a stride of 4 bytes) and is a `*[M]T`, or a `*mut [M]T` when the table is mutable. `m[i][j]` then indexes that row.
- Each index is bounds-checked on its own, by the rules of [4.7](#47-bounds-checked-indexing): `m[i]` against N (a slice's rows against its `.len`), `m[i][j]` against M; a constant or ranged index is proven at compile time. A row has no optional type: like an element of a value type, a row index that isn't proven is resolved where it is taken, with `if let r = m[i]` or `m[i] ?? other`. `??` and `if let` resolve the index they are given, so in `m[i][j] ?? 0` the row index still has to be in range. A many-pointer (`[*][M]T`) has no length, so its row index is never checked.
- `m.len` is N, the number of rows, and `m[i].len` is M. `m.wid` is 4, the size of a row pointer, so `m.len * m.wid` is the size of the table itself. That is what `memcpy` and `memset` check a length against, and `memzero(m)` is an error: it would point every row at address 0. A row is zeroed or copied as the array it is, `for row in m { memzero(row) }`, and in a deeper table each row of rows: `for row in m { for cells in row { memzero(cells) } }` for a `*mut [2][2][2]T`.
- `sizeof(*[N][M]T)` is 4, as for any pointer. `sizeof([N][M]T)` is `N × M × sizeof(T)`: that is the value, which lies in place as a field of a struct ([9.6](#96-structs-and-slices-in-memory)) or in registers. Reached where it lies in memory, it is packed, the `*[NxM]T` its rows make ([Fixed Arrays in Place](#fixed-arrays-in-place)), not a table.
- `for row in m` binds each row pointer, as `m[i]` gives it: a `*[M]T`, or a `*mut [M]T` in a mutable table.
- `let r = m[i]` is the row pointer, not a copy of the row; `m[i].*` loads the row as a `[M]T` value. A row passes where a `*[M]T` is expected, and like any `*[M]T` where a `[]T` is.
- `m[i][j] = v` writes through the row pointer, so it needs a mutable table. `m[i] = r` stores a row pointer: it points row `i` at `r` (a `*mut [M]T` in a `*mut [N][M]T`), and from then on the two share their cells. To copy values into a row instead, write `m[i].* = [1, 2, 3]`.
- `&m[i]` is the address of the row pointer: a `**[M]T`, or `*mut *mut [M]T` in a mutable table (optional, as in [4.7](#element-addresses-and-writes), when `i` isn't proven).
- `m.*` is an error: the rows lie apart, so there is no `[N][M]T` to load or store whole.
- A table written as a literal is laid out when the program is compiled, rows and table alike, so its values must be constants (a framed or packed row is held as its pointer, so a variable can stand for one). With `mut` each row is its own: `data board: *mut [2][3]i32 = mut [[0; 3]; 2]` is two rows of zeros, not one row twice.

<!-- spec:begin compile -->

```ents
data grid: *[2][3]i32 = [[7, 1, 2], [3, 4, 5]]   // two rows, then a table of their two addresses
data rows: [][2]i32 = [[7, 1], [3, 4], [5, 6]]   // a slice of three row pointers
data board: *mut [2][3]i32 = mut [[0; 3]; 2]
data spare = mut [9:i32, 9, 9]

func cell(i: u32#2, j: u32#3) -> i32 => grid[i][j]
func row-sum(i: u32) -> i32 => if let r = grid[i] { r[0] + r[1] + r[2] } else { 0 }
func second(i: u32) -> i32 => (rows[i] ?? [-1, -1])[1]
func total() -> i32 {
  let t = 0
  for row in grid {
    for v in row { t += v }
  }
  return t
}

test "a table is row pointers" {
  assert cell(1, 2) == 5
  assert row-sum(0) == 10
  assert row-sum(5) == 0
  assert second(1) == 4
  assert second(3) == -1
  assert total() == 22
  assert grid.len == 2 && grid.wid == 4 && grid[1].len == 3
  assert grid[1].*[2] == 5
  board[0][2] = 4
  board[1] = spare
  assert board[0][2] == 4 && board[1][0] == 9
}
```

<!-- spec:end -->

### 2.6 Slices

`[]T` is a pointer and a length, `(ptr: [*]T, len: u32)`: two `i32`s in registers, and 8 bytes in memory, the pointer and then the length. It is the standard way to pass data whose length is known only when the program runs. `[]mut T` is the one that can be written through ([Mutability](#mutability)).

- `s.ptr` is the pointer, a `[*]T` (a `[*]mut T` for a `[]mut T`), `s.len` the number of elements, a `u32`, and `s.wid` the bytes of one element, a constant.
- A `*[N]T` becomes a slice of its N elements wherever a slice is wanted, and so does a string or an array literal; a range `p[a..b]` is a slice of part of an array or of another slice ([4.8](#48-slicerange-syntax)).
- A tuple of a pointer and a length is a slice wherever a slice is wanted: `(p, n)`, or `(ptr: p, len: n)` in either order. A many-pointer alone is not a slice, since it has no length (`cannot assign [*]u32 to []u32`), nor is a `*[!]T` until its length is scanned, `(z.ptr, z.len)`, nor any number.
- The length is known only at run time, so no index into a slice is proven when the program is compiled, a constant one either: every element read is checked against `.len` and resolved with `if let` or `??` ([4.7](#47-bounds-checked-indexing)), and an element is written through its address, `if let p = &s[i] { p.* = v }`.
- `for x in s` loads each element in turn, and `for i, x in s` gives its index too ([5.2](#52-loops)).
- A slice is a value: passing or assigning one copies the pointer and the length, and the elements are shared. Writing through a `[]mut T` changes the memory every slice of it sees.

<!-- spec:begin compile -->

```ents
data primes = [2:u32, 3, 5, 7, 11]

func sum(xs: []u32) -> u32 {
  let t: u32 = 0
  for x in xs { t += x }
  return t
}
func at(xs: []u32, i: u32) -> u32 => xs[i] ?? 0
func view(p: [*]u32, n: u32) -> []u32 => (p, n)
func clear(xs: []mut u32) {
  for i in xs.len {
    if let p = &xs[i] { p.* = 0 }
  }
}

test "a slice is a pointer and a length" {
  assert sum(primes) == 28
  assert sum(primes[1..3]) == 8
  let s = view(primes.ptr, 2)
  assert s.len == 2 && s.wid == 4
  assert at(s, 1) == 3
  assert at(s, 2) == 0
  let scratch: []mut u32 = mut [1, 2, 3]
  clear(scratch)
  assert sum(scratch) == 0
}
```

```ents
func view(p: [*]u32) -> []u32 => p
func first(xs: []u32) -> u32 => xs[0]
```

```errors
cannot assign [*]u32 to []u32
index 0 on []u32 requires 'if let' or '??': a slice's length is only known at run time (no optional type for u32)
```

<!-- spec:end -->

#### Static Memory Allocation

The memory a slice views is laid out by `data` ([3.2](#32-data-declarations-data)) or by a literal given where a slice is wanted ([1.5](#array-literals)). `data` names a pointer to its literal, a `*[N]T` or, with `mut`, a `*mut [N]T`, and that becomes a `[]T` or a `[]mut T` wherever one is wanted ([9.5](#95-array-type-conversions)):

<!-- spec:begin compile -->

```ents
data table = [1:u64, 2, 3, 4]          // table: *[4]u64 (const)
data key = x"9d61b19deffd5a60"          // key: *[8]u8 (const)
data buf = mut [0:u8; 1024]             // buf: *mut [1024]u8 (mutable, its own)

func sum(xs: []u64) -> u64 {
  let t: u64 = 0
  for x in xs { t += x }
  return t
}

test "data is viewed as slices" {
  assert sum(table) == 10
  assert sum(table[2..]) == 7
  assert key.len == 8 && buf.len == 1024
}
```

<!-- spec:end -->

### 2.7 Tuple Types

A tuple is values of any types, by position: `(i32, i32)` is a pair of `i32`s, `(u8, f64, bool)` three values of three types.

- `()` is void, the empty tuple: the type of a function with no result.
- `(x)` is grouping, not a tuple — the type is just `x`.
- `(x, y, ...)` is a tuple, of two or more parts.

Grouping holds wherever a type is written: after a colon, in a `type` declaration, in a cast, as a type argument, and as the type a constructor call names, so `x: (u32)` takes a `u32` and `(Point)(1.0, 2.0)` is `Point(1.0, 2.0)`. A field with a name makes a struct of one field: `(v: f64)`. After `->` the parentheses list the results: `-> (u32)` is one `u32`, `-> (q: i32, r: i32)` two named results, and `-> ((q: i32, r: i32))` one result that is a struct.

A tuple is held as its parts, each in registers of its own: no memory, no pointer. A tuple of tuples is all their parts, and a function's results are a tuple returned as several wasm results. `t.0`, `t.1`, ... reach the parts, and chain, `t.0.1`; a position past the last is `invalid tuple index`. A tuple literal is written the same way, `(a, b)`, and its parts take their types from where it is used, or their defaults ([3.3](#33-variables)). Two tuple types are one type when their parts are, in order.

<!-- spec:begin compile -->

```ents
type Fe = (u64, u64, u64, u64, u64)

func fe-zero() -> Fe => (0, 0, 0, 0, 0)

func fe-add(a: Fe, b: Fe) -> Fe => (
  a.0 + b.0, a.1 + b.1, a.2 + b.2, a.3 + b.3, a.4 + b.4
)

test "a tuple is its values" {
  let one: Fe = (1, 0, 0, 0, 2)
  let two = fe-add(one, one)
  assert two.0 == 2 && two.4 == 4
  assert fe-add(fe-zero(), one).4 == 2
}
```

<!-- spec:end -->

Tuples and fixed arrays `[N]T` are both values held in registers. A tuple's parts may have different types, and names (it is then a struct); an array's elements have one type and are reached by a constant index, `v[k]` — by a run-time index only through a pointer or a slice, in memory ([2.4](#24-fixed-arrays-value-type)). Neither converts to the other ([2.1](#21-unified-value-model)).

### 2.8 Struct Types

A struct is a tuple whose fields have names, written with the same parentheses:

<!-- spec:begin compile -->

```ents
type Point = (x: f32, y: f32)
type Rect = (origin: Point, size: (w: f32, h: f32))
type Color = (r: u8, g: u8, b: u8, a: u8)
```

<!-- spec:end -->

A struct is held as its fields, in registers, in the order they are declared ([9.3](#93-wasm-type-mapping)); in memory they lie one after another, with no padding ([9.6](#96-structs-and-slices-in-memory)). Its fields keep their positions, so `p.0` is `p.x`. Struct types are structural: two struct types with the same field names and types in the same order are one type, whatever they are called ([2.11](#211-type-names)), and a value whose fields are held the same way passes for one (`(x: i8, y: i8)` for `(x: i32, y: i32)`, [9.2](#structural-coercion)). A struct is not compared with `==` ([2.1](#21-unified-value-model)).

#### Struct Constructors

A struct type's name called like a function makes one, with a value for every field: positionally in declaration order, or by name in any order. A field whose value is a variable of the field's name is written with a trailing colon, `(x:, y:)` for `(x: x, y: y)`. Every field gets a value: there are no defaults (`Point expects 2 fields, got 1: no value for y`).

<!-- spec:begin compile -->

```ents
type Point = (x: f32, y: f32)
type Size = (w: f32, h: f32)
type Rect = (origin: Point, size: Size)

func area(r: Rect) -> f32 => r.size.w * r.size.h
func at(x: f32, y: f32) -> Point => (x:, y:)

test "constructors" {
  let p = Point(1.0, 2.0)                       // positional
  let q = Point(y: 4.0, x: 3.0)                 // by name, any order
  let r = Rect(p, (w: 10.0, h: 5.0))            // nested
  assert q.x == 3.0
  assert area(r) == 50.0
  assert at(5.0, 6.0).y == 6.0
}
```

<!-- spec:end -->

<!-- spec:begin compile -->

An argument with a name is for the field of that name, and one without is for the field at its place, so positional and named arguments mix:

```ents
type Point = (x:f32, y:f32)

func half(x: f32) -> Point => Point(x, y: x / 2.0)

test "arguments by place and by name" {
  assert half(4.0).y == 2.0
  assert Point(y: 1.0, x: 3.0).x == 3.0
}
```

Each field is given once:

```ents
type Point = (x:f32, y:f32)

func f(x: f32) -> f32 => Point(x, y: 2.0).y
func g() -> f32 => Point(2.0, x: 1.0).x
func h() -> f32 => Point(y: 1.0, 2.0).x
```

```errors
Point: field 'x' is given twice
Point: field 'y' is given twice
```

A tuple literal with names among its elements gives the fields the same way, wherever it meets a struct: as a variable's value (by `let`, `=` or `set`), an argument, a receiver, a returned value or a function's named results, a field of a larger struct, an element of an array, the value of a global or of `data`, the literal `&` lays out, a value stored through a pointer, or the value of a branch of an `if` or a `match` that is one of these. As a `Point`, `(y: 2.0, x: 1.0)` has an `x` of 1.0. A tuple literal without names gives the fields by position, whatever the struct calls them. Only a literal is taken by name: a value made elsewhere keeps its order, and one whose fields have the struct's names in another order is not that struct ([9.2](#structural-coercion)); it is given the struct's type where it is made. A slice is the struct `(ptr: [*]T, len: u32)`, so `(len: n, ptr: p)` is a slice too:

```ents
type Point = (x:f32, y:f32)

func by_name() -> Point => (y: 2.0, x: 1.0)
func by_place() -> Point => (2.0, 1.0)
func first(p: [*]u8, n: u32) -> []u8 => (len: n, ptr: p)

test "a literal with names by name, one without by position" {
  assert by_name().x == 1.0
  assert by_place().x == 2.0
  assert first("abc" as [*]u8, 2).len == 2
}
```

A name the struct has no field of is an error, and so is a field given twice or not at all. A tuple type without names, such as `(f32, f32)`, has no field a name could give. The errors name the fields there are:

```ents
type Point = (x:f32, y:f32)

func a() -> Point => (x: 1.0, z: 2.0)
func b() -> Point => (x: 1.0)
func c() -> Point => (y: 1.0, 2.0)
func d() -> (f32, f32) => (x: 1.0, y: 2.0)
func e() -> Point {
  let v = (y: 1.0:f32, x: 2.0:f32)
  return v
}
```

```errors
field 'z' not found in Point, whose fields are x and y
Point expects 2 fields, got 1: no value for y
Point: field 'y' is given twice
field 'x' not found in (f32, f32), whose fields have no names: give the values by position
field 'y' not found in (f32, f32), whose fields have no names: give the values by position
cannot assign (y: f32, x: f32) to Point: its fields have the names of Point's in another order, and only a literal gives fields by name; give the value the type Point where it is made
```

The values are computed in the order they are written, and then each goes to its field, for a constructor and a literal alike: `Point(y: f(), x: g())` calls `f` before `g`. Where the fields are written in the order the type declares them, that is all there is to it. Where they are not, a value that something written after it could change or tell apart (a call, a read of memory or of a global, anything that can trap) is computed in its turn and waits in a local until its field's place comes; a constant, a local that no other value sets, or arithmetic on them that cannot trap is computed at its field's place, as nothing can tell the difference:

```ents
type Point = (x:i32, y:i32)

global seen: i32 = 0

func tick(v: i32) -> i32 {
  seen = seen * 10 + v
  return v
}

test "values in the order written, fields by name" {
  let p = Point(y: tick(1), x: tick(2))
  assert seen == 12
  assert p.x == 2
  let q: Point = (y: tick(3), x: tick(4))
  assert seen == 1234
  assert q.y == 3
}
```

<!-- spec:end -->

#### Struct Field Access

A field is reached the same way wherever its struct is: in a variable, behind a pointer, in an array, or in the result of a call, and fields of fields chain. In a variable, each field is a register of its own, and assigning one changes that register. Through a pointer, `p.x` reads or writes memory ([9.6](#96-structs-and-slices-in-memory)), and a write needs a `*mut` pointer. A field of a call's result is read and the rest dropped.

<!-- spec:begin compile -->

```ents
type Point = (x: f32, y: f32)
type Rect = (origin: Point, size: (w: f32, h: f32))

func bounds() -> Rect => Rect(Point(0.0, 0.0), (w: 100.0, h: 50.0))

func nudge(p: *mut Point, list: [*]mut Rect, i: u32) -> f32 {
  p.x = 0.0                    // a field of the Point that p points to
  p.y += 1.0
  list[i].origin.x = p.x       // a field of a field of an element
  let r = bounds()
  r.size.w = 2.0               // a field of a field of a variable
  return bounds().size.h       // a field of a call's result
}

data spot: Point = mut (5.0, 5.0)
data rects: *mut [2]Rect = mut [((1.0, 1.0), (2.0, 2.0)), ((3.0, 3.0), (4.0, 4.0))]

test "fields wherever the struct is" {
  assert nudge(spot, rects as [*]mut Rect, 1) == 50.0
  assert spot.y == 6.0
  assert rects[1].origin.x == 0.0
}
```

<!-- spec:end -->

#### Types That Refer to Themselves

A type can refer to itself through a pointer or a slice: what it holds there is an address, and the field is the type again at any depth. Two such types are one type when nothing on the way round tells them apart, as aliases always are.

<!-- spec:begin compile -->

```ents
type Node = (next: ?*Node, v: u32)
type Tree = (kids: []Tree, v: u32)

export func third(h: *Node) -> u32 {
  if let a = h.next {
    if let b = a.next { return b.v }
  }
  return 0
}

export func depth(t: Tree) -> u32 {
  let deepest: u32 = 0
  for k in t.kids {
    let d = depth(k)
    if d > deepest { deepest = d }
  }
  return deepest + 1
}
```

A type that holds itself as a value, in a field or an array, would have no size:

```ents
type Node = (next: Node, v: u32)
```

```errors
type 'Node' contains itself: a type can only refer to itself through a pointer or a slice
```

<!-- spec:end -->

A struct type can take type parameters: `func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)` declares a generic type, `Vec(u32)` is the struct it gives for `u32`, and `Vec(u32)(p, 0, cap)` constructs one like any constructor ([8.5](#85-generic-types)).

### 2.9 Enum Types (Algebraic Data Types)

> **Not implemented.** Enums are a design. No program can use one: everything below the first example describes the design, not what the compiler does.

What the compiler does with an `enum` declaration: it parses it and then ignores it. The declaration is `enum Name { Variant, Variant(fields), ... }` at module level, where the name and each variant start with a capital letter ([1.3](#13-type-identifiers)), the commas between variants are optional, and a payload is a field list as a struct's is, with or without names (`RGB(r: u8, g: u8, b: u8)` or `RGB(u8, u8, u8)`). Nothing in it is checked (an unknown type in a payload, two variants of one name, two enums of one name, an enum and a `type` of one name all pass), nothing of it is compiled, its name is no type, and its variants are no values: a capitalised name in an expression is a constructor call, so `let c = Red` is a syntax error (`Expected "("`). Nor can it be exported.

<!-- spec:begin compile -->

```ents
enum Color { Red, Green, Blue }

func f(c: Color) -> u32 => 1
```

```errors
unknown type 'Color'
```

<!-- spec:end -->

#### The Design

*Not implemented (design).* An enum is a tagged union: a value is one of several variants, and each variant can carry a payload:

```ents
// Not implemented (design)
enum Color {
  Red,
  Blue,
  Green,
  RGB(r:u8, g:u8, b:u8),
  HSL(h:u8, s:u8, l:u8),
  Grey(b:u8),
  Darker(c:*Color)
}

enum Json {
  Null,
  Boolean(bool),
  Number(f64),
  String([]u8),
  Array([]Json),
  Object([]([]u8, Json))
}
```

Variants without payloads (like `Red`, `Blue`, `Null`) are unit variants. Variants with payloads can have positional or named fields.

**Recursive types:** An enum cannot contain itself directly: recursion goes through a pointer (`*T`) or a slice (`[]T`), as it does for a struct ([Types That Refer to Themselves](#types-that-refer-to-themselves)):

```ents
// Not implemented (design)
enum Tree {
  Leaf(value:i32),
  Node(left:*Tree, right:*Tree)   // pointer indirection
}

enum List {
  Nil,
  Cons(head:i32, tail:*List)      // pointer indirection
}
```

A slice is already a pointer and a length, so `Array([]Json)` needs no `*`.

A `match` takes an enum apart by its variants ([Pattern Matching on Enums](#pattern-matching-on-enums), also not implemented).

#### Enum Representations

*Not implemented (design).* An enum has two representations: **stack** (for passing and returning values) and **memory** (for storing it in linear memory).

##### Stack Representation

*Not implemented (design).* On the stack, an enum is flattened to several WebAssembly values, sized for each enum. The compiler computes the slots needed to hold every variant:

1. **Tag**: always `i32`
2. **Payload slots**: for each position across all variants, the smallest wasm type that holds every type at that position

When a slot must hold both an integer and a float (e.g., `i32` and `f64`), it is an `i64`, and the values are moved in and out of it:
- `f64` ↔ `i64`: `i64.reinterpret_f64` / `f64.reinterpret_i64`
- `i32` → `i64`: `i64.extend_i32_u`
- `i64` → `i32`: `i32.wrap_i64`

**Example — Json:**

| Variant | Slot 0 | Slot 1 |
|---------|--------|--------|
| `Null` | — | — |
| `Boolean(bool)` | bool (→i32) | — |
| `Number(f64)` | f64 | — |
| `String([]u8)` | ptr (i32) | len (i32) |
| `Array([]Json)` | ptr (i32) | len (i32) |
| `Object(...)` | ptr (i32) | len (i32) |
| **Union** | i32 \| f64 | i32 \| — |
| **Wasm type** | i64 | i32 |

**Stack shape: `(i32, i64, i32)`** = tag + slot0 + slot1

**Example — Color:**

| Variant | Slot 0 | Slot 1 | Slot 2 |
|---------|--------|--------|--------|
| `Red/Blue/Green` | — | — | — |
| `RGB` | r (u8→i32) | g (i32) | b (i32) |
| `HSL` | h (i32) | s (i32) | l (i32) |
| `Grey` | b (i32) | — | — |
| `Darker` | ptr (i32) | — | — |
| **Union** | i32 \| — | i32 \| — | i32 \| — |
| **Wasm type** | i32 | i32 | i32 |

**Stack shape: `(i32, i32, i32, i32)`** = tag + 3 slots

##### Memory Representation

*Not implemented (design).* In linear memory, an enum is byte-packed:

1. **Tag**: the smallest unsigned integer that counts the variants
   - up to 256 variants: `u8`
   - up to 65536 variants: `u16`
   - more: `u32`

2. **Payload**: the fields packed at their byte widths, the payload left-aligned and padded at the end to the largest variant's size

**Example — Color (5 bytes):**

```
Red:    [0][__][__][__][__]
Blue:   [1][__][__][__][__]
Green:  [2][__][__][__][__]
RGB:    [3][r][g][b][__]
HSL:    [4][h][s][l][__]
Grey:   [5][b][__][__][__]
Darker: [6][ptr ptr ptr ptr]
```

**Example — Json (9 bytes):**

```
Null:    [0][__ __ __ __ __ __ __ __]
Boolean: [1][b][__ __ __ __ __ __ __]
Number:  [2][f64 f64 f64 f64 f64 f64 f64 f64]
String:  [3][ptr ptr ptr ptr][len len len len]
Array:   [4][ptr ptr ptr ptr][len len len len]
Object:  [5][ptr ptr ptr ptr][len len len len]
```

As everything in memory is ([9.6](#96-structs-and-slices-in-memory)), an enum is laid out with no alignment and no padding but the end padding.

### 2.10 Type Conversions

A value changes type in three ways:

- **Implicitly**, where nothing is lost: a narrower number widens to a type that holds all its values, a mutable pointer is used as a const one, a pointer to an array is used as a slice, and the others listed in [Every Implicit Conversion](#every-implicit-conversion).
- **By taking the type it is used as**: a constant with no type of its own (`42`, `0.5`, a `def` of one, arithmetic on these) becomes a value of whatever type it meets, if that type holds it exactly ([Comptime Literal Promotion](#comptime-literal-promotion)).
- **By a cast**, `x as T` or `T(x)`, for everything that may lose or reinterpret a value: narrowing, a change of signedness, float to integer, a bool to a number, a number to a pointer ([Explicit Casts](#explicit-casts)).

Nothing else converts. Every other mismatch is a compile error, and the error names both types.

#### Implicit Widening

A number widens implicitly to a type that holds every value of its own:

```
i8 → i16 → i32 → i64 → i128 → i256 → i512
u8 → u16 → u32 → u64 → u128 → u256 → u512
f32 → f64
```

An unsigned integer also widens to a wider signed one, which holds all its values: `u8` → `i16`, `u32` → `i64`. A signed integer never widens to an unsigned one (an `i8` is no `u64`), and two types of one width but other signedness, `i32` and `u32`, are neither of them the other.

Integer to float is implicit only when the float's mantissa holds every value of the integer type:

| Float | Integer types that widen to it | Mantissa bits |
|-------|-------------------------------|---------------|
| f32 | i8, u8, i16, u16 | 24 |
| f64 | i8, u8, i16, u16, i32, u32 | 53 |

So an `i32` or `u32` widens to `f64` but not to `f32`, and an `i64` or `u64` to neither.

A ranged integer ([Ranged Integers](#ranged-integers)) widens as the type it ranges over does, and to a wider range of its own type: a `u32#8` is a `u32#16`, a `u32`, an `i64` or an `f64`, but not a `u8`, nor an `i32` (a `u32` is neither).

A value widens wherever two operand types meet or a value meets a declared type:

- **Operators.** The narrower operand of an arithmetic, bitwise or comparison operator widens to the other's type. That is the type of the result (`bool` for a comparison). When neither operand's type holds the other (`i32` and `u32`, `f32` and `i32`), it is an error: cast one side. The count of a shift is the exception, any integer type ([4.2](#42-bitwise-operators)).
- **Declarations and assignments.** A `let` with a type, `=`, `set`, and compound assignment: in `x += n`, `n` widens to the type of `x`, never the other way.
- **Calls and results.** Arguments, struct constructor fields, tuple and array literal elements, `return` values and expression bodies.
- **Branches.** The branches of an `if` or `match` used as a value widen to its declared type, or, without one, to the widest branch.
- **Array literals.** The elements widen to the declared element type, or, without one, to the widest element: `[n, big]` with an `i32` and an `i64` is a `[2]i64`. The value of a repeat literal is an element too: `[n; 3]` for a `*[3]i64` widens `n`, and `[true; 3]` is not three `u32`s. Tuples among the elements agree field by field, as branches do: `[(1, 2), (3, 5000000000)]` is a `[2](i32, i64)`. Tuples that agree on no type (another count of fields, other names, the same names in another order) are of the first one's type, and each of the others meets it as it would any struct: `[(y: 1, x: 2), (x: 3, y: 4)]` has a second element with an `x` of 3 ([2.8](#struct-constructors)), and `(3, 4, 5)` after a `(1, 2)` is an error. A field that is a string of other lengths in each tuple is a slice, as strings of other lengths are by themselves (`["a", "bc"]` is a `[2][]u8`): `[("a", 1), ("bc", 2)]` is a `[2]([]u8, i32)`.

<!-- spec:begin compile -->

```ents
type Sample = (count: i64, mean: f64)

func scale(r: f64, n: i32) -> f64 => r * n        // n widens to f64

func total(a: u8, b: i32, c: i64) -> i64 {
  let sum: i64 = a                                 // u8 to i64
  sum += b                                         // i32 to i64
  return sum + c
}

func sample(n: i32, mean: f32) -> Sample => Sample(n, mean)

func pick(c: bool, n: i32, x: f64) -> f64 {
  let v = if c { n } else { x }                    // an f64: n widens
  return v
}

test "a narrower value widens where it meets a wider type" {
  assert scale(1.5, 4) == 6.0
  assert total(200, -300, 5000000000) == 4999999900
  assert sample(3, 0.5).mean == 0.5
  assert pick(true, -2, 0.5) == -2.0
}
```

<!-- spec:end -->

The conversion is an instruction only when the WebAssembly type changes ([11.1](#111-widening-instructions-implicit)): `u8` → `i64` is `i64.extend_i32_u`, `i32` → `f64` is `f64.convert_i32_s`, and `u8` → `u32` is nothing, since every integer of 32 bits or fewer is a wasm `i32`. Arithmetic is done in the type of the result, so a value is widened before the operation, never after: with `a: u8`, `a + 1` is a `u8` sum that wraps at 256, and `a + n` with `n: u32` adds in 32 bits.

A struct or tuple value that already exists isn't widened field by field: a `(i32, i32)` is not a `(i64, i64)` (`cannot convert (i32, i32) to (i64, i64) implicitly: convert its fields`). Fields that are held the same way convert with the struct, `(x: i8, y: i8)` to `(x: i32, y: i32)` ([9.2](#structural-coercion)), and so do the elements of a fixed array (`[3]u8` to `[3]u32`, not to `[3]u64`). The elements of a literal are converted one by one, so where a `(i64, i64)` is wanted `(t.0, t.1)` is one, and `let t: (i64, f64) = (n, n)` widens `n` twice.

Widening converts values, not memory seen through a pointer or slice: a `u8` is a `u16`, but a `[]u8` is not a `[]u16`, nor a `*u8` a `*u16`. The elements have to be laid out the same ([9.2](#structural-coercion)).

<!-- spec:begin compile -->

```ents
func pair(t: (i32, i32)) -> (i64, i64) => t
func view(s: []u8) -> []u16 => s
```

```errors
cannot convert (i32, i32) to (i64, i64) implicitly: convert its fields
cannot assign []u8 to []u16
```

```ents
func pair(t: (i32, i32)) -> (i64, i64) => (t.0, t.1)    // a literal: each element widens

test "a tuple literal widens element by element" {
  let a, b = pair((-1, 2))
  assert a == -1
  assert b == 2
}
```

<!-- spec:end -->

#### Every Implicit Conversion

This is the whole list. Each conversion applies wherever a value meets a declared type (the places listed above), and a name for a type ([2.11](#211-type-names)) converts as the type it names.

| From | To | Notes |
|------|----|-------|
| a narrower number | a wider number that holds all its values | [Implicit Widening](#implicit-widening) |
| `u32#N` | `u32#M` with M ≥ N, and what `u32` widens to | the same for each unsigned type; a plain unsigned type is bounded by its width, so a `u8` is a `u32#256` |
| an untyped constant | any number type that holds its value exactly | [Comptime Literal Promotion](#comptime-literal-promotion) |
| `*mut T`, `[]mut T`, `[*]mut T` | `*T`, `[]T`, `[*]T` | mutable to const ([Mutability](#mutability)), at the outer level only: a `*mut *mut u8` is no `**u8` |
| `*[N]T` | `[]T` | the slice of its N elements; `*mut [N]T` gives a `[]mut T` or a `[]T` ([9.5](#95-array-type-conversions)) |
| `*[N]T` | `[*]T` | the same address |
| `*[NxM]T` | `[]T` | the slice of its N×M elements ([Nesting](#nesting)) |
| `*[N][M]T` | `[][M]T` | a table is a slice of its row pointers ([Nesting](#nesting)) |
| `*[!]T` | `[*]T` | the same address; it becomes a `[]T` only explicitly, `(z.ptr, z.len)` |
| `[*]T` | `*T` | a pointer to the element it points at |
| `([*]T, u32)`, `(*[N]T, u32)` | `[]T` | a pointer and a length make a slice ([9.4](#94-slice-construction)) |
| `*T`, `[]T`, a host type | `?*T`, `?[]T`, `?Canvas` | a plain value is never none; any of the conversions above can end in an optional: `*[4]u8` → `?[]u8` |
| the literal `0` | any optional | none ([Optional Types](#optional-types), [2.13](#213-host-references)) |
| an integer constant | a pointer, `*T` or `[*]T`, optional or not | a fixed address: `let p: *u32 = 64`; not a slice, which needs a length |
| a string literal | `[]u8`, `*[N]u8` (N its length), `[*]u8`, `*[!]u8`, `*[?]u8`, and their optionals | laid out in memory ([String Literals](#string-literals)) |
| an array literal | `[N]T`, `*[N]T`, `[]T`, `[*]T` and their optionals | in registers for `[N]T`, laid out in memory for the rest ([2.4](#24-fixed-arrays-value-type)) |
| a tuple literal | a struct or tuple type | by name where it has names, by position where not ([2.8](#struct-constructors)), each element converted |
| a struct, tuple or fixed array value | one with the same names whose fields convert with no change in wasm value | `(x: i8, y: i8)` → `(x: i32, y: i32)`, `[3]u8` → `[3]u32` ([9.2](#structural-coercion)) |

A slice converts to a const slice of other elements when each element is read the same in memory: `[]mut []mut u8` → `[][]u8`, `[]u32#4` → `[]u32`. A mutable slice or many-pointer keeps its element type, also when it is made from a `*mut [N]T`, since what is written through it must be a value of that type: a `[]mut u32#4` (or a `*mut [4]u32#4`) is no `[]mut u32`, and a `[]mut []mut u8` no `[]mut []u8`. Otherwise a pointer's target type does not change, but for the outer `mut`: `*[8]u8` is no `*[4]u8`, `*[4]u8` no `*u8`, and `*u8` no `*u16`. Function types convert only to the same function type.

<!-- spec:begin compile -->

```ents
data bytes = mut [1:u8, 2, 3, 4]
data word: *[!]u8 = "hey"

func sum(s: []u8) -> u32 {
  let n: u32 = 0
  for b in s { n += b }
  return n
}
func first(p: [*]u8) -> u8 => p[0]
func peek(p: *u8) -> u8 => p.*
func size(s: ?[]u8) -> u32 => if let t = s { t.len } else { 0 }

test "pointers and slices convert where nothing is lost" {
  assert sum(bytes) == 10              // *mut [4]u8 to []u8: const, with a length of 4
  assert first(bytes) == 1             // *mut [4]u8 to [*]u8
  assert peek(bytes.ptr) == 1          // [*]mut u8 to *u8
  assert size(bytes) == 4              // to an optional slice
  assert size(0) == 0                  // 0 is none
  assert sum((bytes.ptr, 2)) == 3      // a pointer and a length make a slice
  assert first(word) == 104            // *[!]u8 to [*]u8
}
```

<!-- spec:end -->

Each refusal says what is missing, and the fix writes it:

<!-- spec:begin compile -->

```ents
func many(s: []u8) -> [*]u8 => s
func one(p: *[4]u8) -> *u8 => p
func open(p: [*]u8) -> []u8 => p
func scan(z: *[!]u8) -> []u8 => z
func shrink(p: *[8]u8) -> *[4]u8 => p
func flip(x: i32) -> u32 => x
func lose(x: i64) -> f64 => x
func known(p: ?*u8) -> *u8 => p
```

```errors
cannot assign []u8 to [*]u8
cannot assign *[4]u8 to *u8
cannot assign [*]u8 to []u8
cannot assign *[!]u8 to []u8
cannot assign *[8]u8 to *[4]u8
cannot assign i32 to u32
cannot assign i64 to f64
cannot assign ?*u8 to *u8: it may be none — resolve it with 'if let' or '??' first
```

```ents
data bytes = [1:u8, 2, 3, 4, 5, 6, 7, 8]

func many(s: []u8) -> [*]u8 => s.ptr                      // the pointer, without the length
func one(p: *[4]u8) -> *u8 => &p[0]                       // the address of an element
func open(p: [*]u8, n: u32) -> []u8 => (p, n)             // a length the caller vouches for
func scan(z: *[!]u8) -> []u8 => (z.ptr, z.len)            // the length, scanned for
func shrink(p: *[8]u8) -> *[4]u8 => p as *[4]u8           // a cast: the first four
func flip(x: i32) -> u32 => x as u32
func lose(x: i64) -> f64 => x as f64
func known(p: ?*u8, other: *u8) -> *u8 => p ?? other

test "each fix says what the conversion could not" {
  assert many(bytes)[7] == 8
  assert open(bytes.ptr, 3).len == 3
  assert shrink(bytes)[3] == 4
  assert one(shrink(bytes)).* == 1
  assert flip(-1) == 4294967295
  assert lose(-3) == -3.0
  assert known(0, bytes.ptr).* == 1
}
```

<!-- spec:end -->

#### Comptime Literal Promotion

A constant with no type of its own — an integer or float literal written without `:T`, a `def` of one, or an operator applied to these — has no type until it meets one. Messages print it by its value, `int(300)` or `float(1.5)`: `cannot assign int(300) to u8`. It becomes a value of the type it meets when that type holds its value exactly:

- an integer type holds it when it is in the type's range: `255` is a `u8`, `300` and `-1` are not;
- a float type holds an integer constant within the range its mantissa counts exactly: from -2^24 to 2^24 (16777216) for `f32`, from -2^53 to 2^53 for `f64`. Past that the constant is refused, also one the float happens to hold (`16777218` is no `f32` constant: cast it, `16777218 as f32`);
- a float constant (one with a decimal point or an exponent) is never an integer (`cannot assign float(1) to u32`) and takes the nearest value of `f32` or `f64`, as the literal `0.1` is no binary fraction exactly ([Float Literals](#float-literals)). One beyond the largest finite value of its type (about 3.4e38 for `f32`) is no value of it.

Where nothing gives it a type, an integer constant is an `i32`, or an `i64` if it does not fit one, and a float constant an `f64` ([1.5](#15-literals)).

The value is what is checked, not a type: `1.0 + 42` is an `f32` where an `f32` is wanted, since 42 is exactly one, while `1.0 + 16777217` is an error there:

<!-- spec:begin compile -->

```ents
func a() -> f32 => 1.0 + 42          // OK: 42 is an f32 exactly
func b() -> f32 => 1.0 + 16777216    // OK: 2^24 is too
func c() -> f32 => 1.0 + 16777217    // ERROR: the nearest f32 is 16777216
func d() -> u8 => 255 + 1            // ERROR: 256 is no u8
```

```errors
cannot assign int(16777217) to f32
cannot assign int(256) to u8
```

<!-- spec:end -->

A constant expression takes the type it's used as, all the way down to its literals. A float literal beside an integer value makes the operation an `f64` one, if the integer widens to `f64`:

<!-- spec:begin compile -->

```ents
func third() -> f32 {
  let x: f32 = 1.0 / 3       // an f32 division of two f32 constants
  return x
}

func big() -> i64 {
  let x = 5000000000 + 1     // an i64 addition: the 1 isn't an i32
  return x
}

func halves(n: i32) -> f64 => n * 0.5    // 0.5 is an f64, and n widens to it

test "a constant is computed in the type it is used as" {
  assert third() == 1.0:f32 / 3.0:f32
  assert big() == 5000000001
  assert halves(5) == 2.5
}
```

<!-- spec:end -->

Each step of a constant expression is then computed in that type, as it would be for values, and what the compiler proves from a constant (an index in bounds, a range) it proves from that value. As a `u32`, `0 - 1` is 4294967295, so `(0 - 1) / 4` is 1073741823, not 0, and `~0 >> 28` is 15.

The branches of an `if` or `match` that are all constants make a constant too. Where nothing else types it, it takes the default that holds every branch, and each branch has to be a value of the type it ends up with. Branches that are tuples agree field by field, each field as it would by itself:

<!-- spec:begin compile -->

```ents
func pick(c: bool) -> i64 {
  let v = if c { -2147483648 } else { 2147483648 }   // an i64: 2147483648 isn't an i32
  return v
}

func step(d: i32) -> (i32, i32) {
  let (dx, dy) = match d {
    0 => (1, 0)
    1 => (0, 1)
    _ => (-1, -1)                  // dx and dy are i32s
  }
  return (dx, dy)
}

test "constant branches take the default that holds them all" {
  assert pick(false) == 2147483648
  let dx, dy = step(5)
  assert dx == -1
  assert dy == -1
}
```

<!-- spec:end -->

An integer constant with no type that fits no `i64` has no default: `let d = 99999999999999999999` is `cannot assign int(99999999999999999999) to i64`, and the fix is a type, `let x: u128 = 18446744073709551616`. One from 2^63 to 2^64 − 1 should be refused the same way, but is taken as an `i64` and becomes negative with no error (a known bug): give it its type, `18446744073709551615:u64`. Nor have branches of which one is negative and another past an `i64`: `if c { -1 } else { 18446744073709551615 }` needs a type that holds both.

Once a value has a type, it converts only as values do. A `let` without a type gives its constant the default, and from then on it is a value of that type:

<!-- spec:begin compile -->

```ents
func f() -> f32 {
  let z = 1.3            // an f64
  let a: f32 = z
  return a
}
```

```errors
cannot assign f64 to f32
```

<!-- spec:end -->

`int(N)` and `float(X)` can also be written as types, `let x: int(5) = 5`. Such a type has the one value: `let x: int(5) = 7` is `cannot assign int(7) to int(5)`. At run time it is held as its constant's default type (an `i32` for `int(5)`), so a parameter of type `int(5)` in an exported function is an `i32` the host may give any value. They are names for the messages to use, not types to write.

#### Type Errors

Each of these is an error, with the fix it names:

<!-- spec:begin compile -->

```ents
func a(x: i32, y: f32) -> f32 => x + y    // an i32 doesn't fit f32's mantissa
func b(x: i32, y: u32) -> i32 => x + y    // mixed signedness
func c(x: i32, y: u32) -> bool => x < y   // the same goes for comparisons
func d(x: i64) -> i32 => x                // narrowing
func e(f: bool, n: i32) -> i32 => f + n   // a bool is no number
func g(x: f64) -> f64 => x % 2.0          // % and the bitwise operators need integers
```

```errors
mismatched operands for '+': i32 and f32 (cast one side explicitly)
mismatched operands for '+': i32 and u32 (cast one side explicitly)
mismatched operands for '<': i32 and u32 (cast one side explicitly)
cannot assign i64 to i32
'+' cannot be applied to bool: cast it to an integer first
'%' needs integer operands, not f64
```

```ents
func a(x: i32, y: f32) -> f32 => x as f32 + y
func b(x: i32, y: u32) -> i32 => x + y as i32
func c(x: i32, y: u32) -> bool => x < 0 || x as u32 < y    // a negative x is below every u32
func d(x: i64) -> i32 => x as i32
func e(f: bool, n: i32) -> i32 => f as i32 + n
func g(x: f64) -> f64 => x - 2.0 * (x / 2.0).trunc()

test "a cast says which conversion is meant" {
  assert a(2, 0.5) == 2.5
  assert b(-5, 3) == -2
  assert c(-1, 0)
  assert !c(5, 3)
  assert d(4294967297) == 1
  assert e(true, 1) == 2
  assert g(7.5) == 1.5
}
```

<!-- spec:end -->

#### Explicit Casts

A cast is written two ways:

- `x as T`, for any target type `T`.
- `T(x)`, for a primitive type's own name only: `u32(x)`, `f64(n)`, `i8(b)`. It takes exactly one argument (`type cast 'u32' expects 1 argument, got 2`). It is a call in form, so it binds as one: `u32(x).double()` calls `double` on the cast. A name for a primitive type (`type Count = u32`) has no such call (`Count(x)` is an error: write `x as Count`), nor has a ranged type or a type parameter (`T(x)` in a generic says to write `x as T`). A capitalised name with arguments is a struct constructor ([2.8](#struct-constructors)), which builds a value, not a cast.

`as` applies to a postfix expression: a name, a literal, a call, a field, an index, a dereference, or anything in parentheses. Its result takes no postfix operator and no second `as` without parentheses: `x as u32.double()` and `1 as u8 as u16` are syntax errors, and `(x as u32).double()` and `(b as u16) as u32` are what is meant. A unary operator before it applies to the cast: `-x as i32` is `-(x as i32)`. Every binary operator binds looser, so `x as i32 + 1` is `(x as i32) + 1`, and `n as i32 < 0` is `(n as i32) < 0`.

<!-- spec:begin compile -->

```ents
func double(x: u32) -> u32 => x * 2

func a(x: i32) -> u32 => (x as u32).double()
func b(x: i32) -> u32 => u32(x).double()       // the same
func c(x: u32) -> i32 => -x as i32             // -(x as i32)
func d(x: u32) -> bool => x as i32 < 0          // (x as i32) < 0: the top bit
func e(x: f64) -> u32 => x.floor() as u32      // a method call is a postfix expression

test "as binds tighter than every binary operator" {
  assert a(3) == 6
  assert b(3) == 6
  assert c(5) == -5
  assert d(0x80000000)
  assert e(2.7) == 2
}
```

<!-- spec:end -->

A cast converts a single value: a number, a bool or a pointer. What it gives:

| Cast | Value | Wasm |
|------|-------|------|
| integer → narrower integer | its low bits, read as the target type: `300 as u8` is 44, `200 as i8` is -56, `0x100000001 as u32` is 1 | `i32.wrap_i64` from 64 bits; to 8 or 16 bits `i32.and` with 255 or 65535 (unsigned) or `i32.shl` then `i32.shr_s` by 24 or 16 (signed) |
| integer → integer of the same width | the same bits: `-1 as u32` is 4294967295, `4294967295 as i32` is -1 | nothing |
| integer → wider integer | extended by the source's signedness: an `i8` of -1 as a `u64` is 18446744073709551615, a `u8` of 255 as an `i64` is 255 | `i64.extend_i32_s` / `_u` |
| integer → float | the nearest float: `16777217 as f32` is 16777216 | `f32.convert_i32_s` / `_u`, and the `i64` ones |
| float → integer | truncated toward zero: `-3.7 as i32` is -3; **traps** where that is not a value of the 32- or 64-bit integer the target is held in (below) | `i32.trunc_f64_s` / `_u`, and the others |
| `f64` → `f32` | the nearest `f32`; past its range, infinity | `f32.demote_f64` |
| `f32` → `f64` | the same value | `f64.promote_f32` |
| `bool` → number | 0 or 1 | nothing, or a convert to a float |
| pointer → number, number → pointer, pointer → pointer | the address as a `u32`, cast from or to the other type as a `u32` is | nothing between a pointer and a 32-bit integer |
| a type → itself, or one it converts to implicitly | the implicit conversion: `p as ?*u8`, `c as ?Canvas` | as implicit |

**Float to integer traps.** The truncated value has to fit the wasm integer the target is held in: an `i32` for a signed target of 32 bits or fewer, a `u32`'s range for an unsigned one, and 64 bits for `i64` and `u64`. NaN, an infinity, or a value outside that range traps (wasm's `trunc` instructions, [11.2](#112-narrowing-instructions-explicit-cast)). So `3000000000.0 as i32` traps and `3000000000.0 as u32` is 3000000000. A target of 8 or 16 bits is truncated to 32 bits first and then keeps its low bits as an integer cast does: `300.0 as u8` is 44, `200.0 as i8` is -56, and `-1.0 as u8` traps (it is no `u32`), while `-0.5 as u8` is 0. Compare before a cast that may be out of range: `if x >= 0.0 && x < 256.0 { x as u8 }`.

A cast of a constant is computed when the program is compiled, with the value the run-time cast gives: `300 as u8` is the constant 44, `-1 as u32` is 4294967295. A float constant that would trap as an integer is no constant (`global g: i32 = 1.0e30 as i32` is `global initializer must be a compile-time constant`), and in a function it traps where it runs.

<!-- spec:begin compile -->

```ents
func byte(x: i32) -> u8 => x as u8
func signed(x: i32) -> i8 => x as i8
func low(x: i64) -> i32 => x as i32
func wide(x: i8) -> u64 => x as u64
func whole(x: f64) -> i32 => x as i32
func cut(x: f64) -> u8 => x as u8
func near(x: i64) -> f32 => x as f32
func bit(b: bool) -> u32 => b as u32
func address(p: *u8) -> u32 => p as u32

data cell = [7:u8]

test "a cast keeps low bits, extends by the source's sign, truncates floats" {
  assert byte(300) == 44
  assert byte(-1) == 255
  assert signed(200) == -56
  assert low(0x100000001) == 1
  assert wide(-1) == 18446744073709551615
  assert whole(-3.7) == -3
  assert cut(300.0) == 44
  assert near(16777217) == 16777216.0
  assert bit(true) == 1
  assert address(&cell[0]) == 8                // data starts at address 8 (9.0)
  assert (address(&cell[0]) as *u8).* == 7
}
```

<!-- spec:end -->

A cast is required for:

- narrowing, larger to smaller;
- a change of signedness, also in an operation that mixes them (`x + y as i32`);
- integer to float where the float may not hold every value (`i32` → `f32`, `i64` → `f64`), and float to integer;
- `f64` to `f32`;
- a bool to a number;
- a number to a pointer (other than a constant) and a pointer to a number;
- a pointer to a pointer of another target type (`p as *u32`, `p as [*]u16`, `buf as *[4]u8`): the same address, read as the new type. The type views `p.u32` and `p.u8` are another way to write this ([Type-Punned Memory Access](#type-punned-memory-access)).

What a cast refuses:

- **To `bool`.** A bool is 0 or 1, and cutting a number down to a bit doesn't make one: write the comparison (`x != 0`). A bool casts to a number, and to itself.
- **Several values to or from one.** A slice, a struct, a tuple and a fixed array held by value are several values. They are cast only to a type they convert to implicitly and are held the same way as (`s as []u8` for a `[]mut u8`); otherwise use `.ptr`, `.len` or the fields (`cannot cast []u8 to [*]u8`, `cannot cast P to Q`).
- **An optional slice or host reference to its plain form.** It may be none: `cannot cast ?[]u8 to []u8: it may be none — resolve it with 'if let' or '??' first`. An optional pointer is an address, and casts to any pointer as an address does: `p as *u8` with `p: ?*u8` checks nothing.
- **A host reference** to or from anything but its optional form ([2.13](#213-host-references)).
- **A function's name** to a number or an address: a function has no run-time value ([Function Types and Pointers](#function-types-and-pointers)).
- **Between an integer of 128 bits or more and a float**: `cannot cast u128 to f64: not supported yet`. *Not implemented.* Cast through `u64` or `i64` where the value fits one.

A cast to a ranged type (`x as u32#8`) is not checked: it says the value is in range, and the compiler takes the program's word for it, as it does for a many-pointer's index. An index it proves is not bounds-checked, so a wrong one reads or writes past the array. Write it only where the value is known to be in range (the library's `FixedVec` writes `(v.len - 1) as u32#n` after `assert v.len > 0`); otherwise compare, which narrows the range and is the check ([Ranged Integers](#ranged-integers)).

<!-- spec:begin compile -->

```ents
type P = (x: i32, y: i32)
type Q = (a: i32, b: i32)

func a(x: u32) -> bool => x as bool
func b(s: []u8) -> [*]u8 => s as [*]u8
func c(p: P) -> Q => p as Q
func d(x: u128) -> f64 => x as f64
func e(x: u64) -> u32 => u32(x, 0)
```

```errors
cannot cast u32 to bool: compare it instead (x != 0)
cannot cast []u8 to [*]u8
cannot cast P to Q
cannot cast u128 to f64: not supported yet
type cast 'u32' expects 1 argument, got 2
```

A second `as`, or a postfix operator after the type, needs the cast in parentheses:

```ents
func f(x: u16) -> u32 => x as u8 as u32
```

```errors
Expected
```

<!-- spec:end -->

### 2.11 Type Names

`type Name = Type` gives a type a name. A `type` declaration stands at module level (in a function body it is a syntax error), and the name is a type identifier, which starts with a capital letter ([1.3](#13-type-identifiers)). The declarations of a module come in any order: a name can be used above the line that declares it, and names can refer to each other, also round to themselves through a pointer or a slice ([Types That Refer to Themselves](#types-that-refer-to-themselves)). A name is declared once in its module, and it is not exported or imported: a module that needs the type declares it again or writes it out ([7.1](#71-imports)).

A name is not a new type. It is the type it names, wherever it is used: `type Meters = u32` and `type Feet = u32` are both `u32`, so a `Meters` passes where a `Feet` is wanted, and either is a `u32` in arithmetic. Messages say the name that was written (`cannot assign int(8) to Small`). Any type can be named: a number, a ranged integer (`type Small = u32#8`), a pointer, a slice, an array, an optional, a tuple or struct, a function type (`type Scale = (u32) -> u32`), a generic type applied (`type Bytes = Vec(u8)`, [8.5](#85-generic-types)), or a name (`type Pt = Point`). A name in parentheses is the name, as any type is ([2.7](#27-tuple-types)).

<!-- spec:begin compile -->

```ents
type Meters = u32
type Feet = u32
type Count = u32
type Small = u32#8
type Scale = (u32) -> u32

func feet(m: Meters) -> Feet => m * 3                       // a Meters is a u32, and so is a Feet
func clamp(x: u32) -> Small => if x < 8 { x } else { 7 }     // x is a u32#8 where x < 8
func twice(comptime f: Scale, x: u32) -> u32 => f(f(x))      // feet is a (u32) -> u32
func count(n: u64) -> Count => n as Count                    // a cast to the name

test "a name is the type it names" {
  assert feet(2) == 6
  assert clamp(9) == 7
  assert twice(feet, 1) == 9
  assert count(4294967297) == 1
}
```

<!-- spec:end -->

What can be done with the type written out can be done with its name:

- A name for a pointer is dereferenced, one for a slice or an array has `.ptr`, `.len` and elements, and one for an optional is unwrapped by `if let` and `??`.
- A literal is laid out for a name as for the type it names: `data list: S = [4, 5, 6]`, `let q: *A = [1, 2, 3]`.
- A pointer to an array becomes a slice under any of their names, and the conversions of [Every Implicit Conversion](#every-implicit-conversion) apply to names as to what they name.
- A pointer to a name for an array is a pointer to that array in every use: with `type Row = [3]i32`, a `*Row` has `.len` 3, indexes, loops and converts as a `*[3]i32` does and is what `memcpy` takes, and with `type Grid = [2]Row` a `*Grid` is a `*[2][3]i32`, a table ([Nesting](#nesting)). That holds at every depth and through names of names: with `type Cube = [2][3][4]u8`, a `*Cube` is a table of tables as a `*[2][3][4]u8` is, and `c[1][2][3]` loads two row pointers before the byte.
- A name for a struct is its constructor: `Pt(1, 2)` with `type Pt = Point` ([2.8](#struct-constructors)).
- A name for a number is cast to with `as` (`n as Count`). `Count(n)` is no cast: only a primitive type's own name is called as one ([Explicit Casts](#explicit-casts)).

One kind of type is its name, not what it is written as: a host type (`type Canvas = host`, [2.13](#213-host-references)). Each name declared with `host` is a type of its own, and one name of it is the same type in every module of a program.

Names for a pointer, a slice, an optional and an array, each used as what it names:

<!-- spec:begin compile -->

```ents
type P = *mut u32
type S = []u16
type O = ?*u32
type A = [3]u16

data cells = mut [0:u32; 4]
data shorts = [1:u16, 2, 3]
data list: S = [4, 5, 6]

func bump(p: P) -> u32 {
  p.* += 1
  return p.*
}
func last(s: S) -> u16 => s[s.len - 1] ?? 0
func read(o: O) -> u32 => if let q = o { q.* } else { 0 }

test "names are the types they name" {
  let p: P = &cells[0]
  assert bump(p) == 1
  let s: S = shorts
  assert last(s) == 3
  assert read(p) == 1
  assert read(0) == 0
  assert last(list) == 6
  let q: *A = [7, 8, 9]
  assert last(q) == 9
}
```

<!-- spec:end -->

### 2.12 Limits

A program has these limits. Each is checked when it is compiled, and going over is one error where it goes over:

| What | At most | Why |
|------|---------|-----|
| a type, written out in full | 65536 parts | the compiler writes types out to name and lay out values |
| a function's parameters | 1000 registers | the WebAssembly JS API's limit for a function |
| a function's results | 1000 registers | the same |
| the value of an `if`, `if let`, `match` or `??` | 1000 registers | it is the results of a wasm block |
| everything one function holds (parameters, variables, the values its code computes) | 50000 registers | the JS API's limit on a function's locals; it also keeps the body under the 7654321 bytes the API allows |
| a program's globals | 1000000 registers | the JS API's limit for a module |
| a program's imports, and the entry module's exports | 100000 each | the same |
| brackets and prefixes nested in source | 256 deep | the compiler's parser |
| an array's length, and its size | 4294967295 elements, 4294967295 bytes | a 32-bit memory ([2.4](#24-fixed-arrays-value-type)) |

A register is a wasm value: a number, a bool, a pointer or a host reference is one, a slice two, a `u128` two `i64`s, and a struct or an array held by value one for each of its fields and elements. The sections below say how each is counted.

A type has at most 65536 parts written out in full: every name replaced by what it names, and each field, element, pointer and number counted where it stands (a type that refers to itself is counted once round), with an array held by value counted once for each of its elements (below). Names let a type double at every level, `type D2 = (a: D1, b: D1)`, and the compiler writes types out to name instances and to lay out values. A type over the limit is one error where it is declared, or where the generic type that makes it is applied, or, written in place (in a signature, a cast, after a colon, as a type argument), where it is written; the types made of it say nothing more.

<!-- spec:begin compile -->

```ents
type D0 = u8
type D1 = (a: D0, b: D0)
type D2 = (a: D1, b: D1)
type D3 = (a: D2, b: D2)
type D4 = (a: D3, b: D3)
type D5 = (a: D4, b: D4)
type D6 = (a: D5, b: D5)
type D7 = (a: D6, b: D6)
type D8 = (a: D7, b: D7)
type D9 = (a: D8, b: D8)
type D10 = (a: D9, b: D9)
type D11 = (a: D10, b: D10)
type D12 = (a: D11, b: D11)
type D13 = (a: D12, b: D12)
type D14 = (a: D13, b: D13)
type D15 = (a: D14, b: D14)
type D16 = (a: D15, b: D15)
type D17 = (a: D16, b: D16)

func f(p: *D17) -> u8 => p.a.b.a.b.a.b.a.b.a.b.a.b.a.b.a.b.a
```

```errors
type 'D16' is too large: written out in full it has more than 65536 parts
```

<!-- spec:end -->

A value held by value — a parameter, a result, a variable or a global, with each field and element of it — is laid out in registers, so there an array counts each of its elements: `[N]T` is one part and N times what `T` counts (at least once, for `[0]T`), and `[2][2][2]u8` is fifteen parts where it is eight bytes. What a pointer or a slice points to is in memory and counts once, whatever its length: `*[1048576]u8`, `[][4096]u8`, a name for a large array behind a pointer and `data buf = mut [0:u8; 1048576]` are each a few parts, while a global `g: [65536]u8` or a parameter `x: [65536]u8` is over the limit (a function holds its values to far less, below). The parameters and results of a function type are held by value wherever the function type is. A value over the limit is one error where its type is written, or, where none is (`let x = p.*`, `for v in rows`, `if let v = ...`), at the variable.

<!-- spec:begin compile -->

```ents
type Page = [65536]u8
data page = mut [0:u8; 65536]
data buf = mut [0:u8; 1048576]

func first(p: *Page) -> u8 => p[0]
func last(s: []u8) -> u8 => s[s.len - 1] ?? 0
func both() -> u8 => first(page) + last(buf)
func whole(x: [65536]u8) -> u8 => x[0]
```

```errors
type '[65536]u8' is too large: written out in full it has more than 65536 parts
```

<!-- spec:end -->

A function is one wasm function, and every engine takes a wasm function of at most 1000 parameters, 1000 results and 50000 locals, its parameters among them, with a body of at most 7654321 bytes (the limits the WebAssembly JS API sets). What a function holds is counted in registers, the wasm values a value is laid out in: a number, a bool, a pointer or a host reference (2.13) is one, a slice two, a `u128` two `i64`s, and an array held by value or a struct one for each of its elements and fields, `[N]T` N times what `T` is. So:

- The parameters of a function are at most 1000 registers, and so are its results; so are those of an imported function and of a function type wherever it is written. It is said at the parameter or the result that goes over.
- The value an `if`, an `if let`, a `match` or a `??` gives is at most 1000 registers: it is the results of a wasm block.
- A function needs at most 50000 registers in all: those of its parameters and of its variables (a named result, and what a `let`, a `for`, an `if let` or a match arm binds), and those of each value its code computes. Each expression counts its registers, one at least, as often as its code is written out: a fill `[x; N]` writes `x` out N times, a deferred expression is written at the end of its block and at each `return`, `break` and `continue` after it, and a `return` without a value gives the named results back, their registers read again each time. A literal is its elements, of which the constant ones are data where the literal is laid out in memory; and a place read only in part, or written, is not computed: `p.*` in `p.*[3]` and `p.* = v`, `rect` and `rect.origin` in `rect.origin.x`. Nor are the name of a function that is called, a type argument and the count of a fill. A value computes about as much code as it has registers, so this keeps the body within its limit as well. Going over is one error, at the value, the variable or the `return` that goes over, and none is said of a function with an error of its own. A test is a function of its own here, and so is each instance of a generic.

A large value belongs in memory, behind a pointer, where a range copy `p[..] = q[..]` (`memory.copy`) and a range fill `p[..] = 0` (`memory.fill`) move it with one instruction whatever its length ([4.8](#48-slicerange-syntax)). Host references are the exception: they are never in memory, so where they alone take a count over its limit, the error says to hold fewer at once (`a host reference is held only in registers, never in memory: hold fewer at once`).

<!-- spec:begin compile -->

```ents
func copy(p: *mut [4000]u8, q: *[4000]u8) { p.* = q.* }                    // 4002 registers
func move(p: *mut [65536]u8, q: *[65536]u8) { p[..] = q[..] }              // memory.copy
func clear(p: *mut [65536]u8) { p[..] = 0 }                                // memory.fill
func pick(c: bool, p: *[1000]u8, q: *[1000]u8) -> u8 => (if c { p.* } else { q.* })[0]
func first(p: *[65536]u8) -> u8 => p.*[0]                                  // one element is read
```

<!-- spec:end -->

<!-- spec:begin compile -->

```ents
func copy(p: *mut [65536]u8, q: *[65536]u8) { p.* = q.* }
func fill(p: *mut [60000]u8) { p.* = [0; 60000] }
func pick(c: bool, p: *[1001]u8, q: *[1001]u8) -> u8 => (if c { p.* } else { q.* })[0]
func pass(x: [1000]u8, n: u32) -> u8 => x[0]
```

```errors
the parameters are 1001 registers, more than the 1000 a wasm function takes — pass a large value by pointer
function 'copy' needs more than 50000 registers, the most a wasm function has (here [65536]u8 is 65536)
function 'fill' needs more than 50000 registers, the most a wasm function has (here u8, written out 60000 times, is 60000)
an if that gives [1001]u8 gives 1001 registers, more than the 1000 a wasm block gives back
```

<!-- spec:end -->

The modules of a program are one wasm module, which every engine takes with at most 1000000 globals, 100000 imports and 100000 exports. A global held by value is a wasm global for each of its registers; one imported from the host is an import for each, and one the entry module exports an export for each ([7.2](#72-exports)). So the globals of a program are at most 1000000 registers in all, and its imports (a function, or each register of a global) and the exports of its entry module (a function, a memory, or each register of a global) at most 100000 each. Going over is one error, at the global, the import or the export that goes over, the modules taken in the order they are checked, an imported one before the one that imports it.

<!-- spec:begin compile -->

```ents
export global a: [65535]u8
export global b: [65535]u8
```

```errors
the program exports more than 100000 wasm functions, globals and memories, the most a wasm module has (here b: [65535]u8 is 65535)
```

<!-- spec:end -->

Brackets, and prefixes such as `-`, `*`, `?` and `[]` before what they apply to, nest at most 256 deep: `((((x))))` is four levels, and so is `*[]?*u8`. Deeper source is one error, `nested more than 256 deep`, before it is parsed.

### 2.13 Host References

A host reference is a value of the host's (a JavaScript object, a DOM element, a file the host has open) that the module holds and hands back but cannot look into. Its type is declared with `host` as the whole of a type declaration:

<!-- spec:begin compile -->

```ents
type Canvas = host
type Context = host
```

<!-- spec:end -->

Each name declared with `host` is a type of its own: `Canvas` and `Context` are both host references, but neither is assignable to the other. Another name for one is that type (`type Screen = Canvas`). The name is the type program-wide, across source modules too: a module that shares `Canvas` with another declares `type Canvas = host` too, as it restates the signatures it shares, and two modules that each declare `type Handle = host` have one type between them. So a library should choose a name that is its own (`FileHandle`, not `Handle`). Types are otherwise structural (2.11, 7.1, 8.4, 8.5); a host type is the one kind that is its name, and a message that meets two types of one name that are not one type says what each stands for (`cannot assign Canvas (i32) to Canvas (a host type)`). `host` is not reserved, and written anywhere else as a type it is an error (`'host' declares a host reference type: write 'type Canvas = host' and use Canvas`).

A host reference is held where registers are, and nowhere else:

- as a parameter or a result of any function, an imported or exported one too, so the host gives references in and takes them back;
- in a `let` variable or a global: a global of a plain one is imported from the host, and the module's own globals, exported ones too, hold an optional one (below);
- as a field of a struct or tuple, or an element of a fixed array, held in registers (`(c: Canvas, n: i32)` as a value, or `[2]Canvas` in a variable).

It has no bytes, so it is never in memory: no pointer points to one, no slice or many-pointer holds one, and neither does `data` or a literal laid out in memory, nor a struct or array that would be. Each of these is an error, as is `sizeof` of one and the `.wid` of an array of them. *Not implemented:* a way to keep host references in memory (in a wasm table, say) is not designed; a program holds as many as its registers do ([2.12](#212-limits)).

#### Never null, and optional

A plain host type is never null: a `Canvas` is always a value the host gave. So it has no default:

- a `let` of one gets its value where it is declared, and so does one of a struct or a fixed array that holds one (`'c' needs a value where it is declared: a Canvas has no default (a ?Canvas starts as none)`);
- a global's value is a constant, and no constant is a `Canvas`, so a global of one (or of a struct or array that holds one) is imported from the host, which gives its value; the module's own global holds a `?Canvas`, none until it is set (`global 'g' needs a value: ..., and no constant is a Canvas: import the global from the host, or make it hold a ?Canvas, which starts as none`);
- a named result cannot hold one, since a named result starts with a default: return the value instead;
- a `let` of one in a block that may not run (a branch, a loop's body, a match arm) is seen in that block alone, not after it as another variable is (3.3): after the block, it may never have been given its value (`'c' is seen only in the block it is declared in: that block may not have run here, ...`);
- `0` is no `Canvas`, and neither is any other number: `c == 0` on a plain `Canvas` is an error that says to use `?Canvas`.

A reference that may be null is a `?Canvas`, the optional form, written as `?*T` is for a pointer (2.5); `?Screen` is the same type through another name for it. It follows the rules of `?*T`:

- none is written `0`, the literal: also `-0` (the literal with its sign), in parentheses, as the value of a branch, or as a `def` of 0, but nothing computed (`0 + 0` and `-(0)` are not none). A comptime value parameter is the number its call gave, written in its place ([8.7](#87-comptime-value-parameters)): in an instance given 0 it is the literal 0, however the call wrote the 0;
- it starts as none: a `let` or a global of one given no value is none;
- `opt == 0` and `opt != 0` ask whether it is none, and are its only comparisons;
- `if let c = opt { ... }` gives a plain `Canvas` where it is not none, and `opt ?? other` is `opt` unless it is none, and `other` (a `Canvas`) then;
- a `Canvas` widens to a `?Canvas` implicitly (`c as ?Canvas` too), and a `?Canvas` is used as a `Canvas` only once resolved (`cannot assign ?Canvas to Canvas: it may be none — resolve it with 'if let' or '??' first`).

`match` does not take a host reference, optional or not, as it does not take a pointer.

#### At the boundary

The module never makes a null `Canvas`. The host promises one too: where a value of a plain host type comes in from the host, as an exported function's parameter, an imported function's result or an imported global's value, it is checked once, as it comes in, and a null there traps (`unreachable`). So a host that breaks the promise stops the program at the boundary, not somewhere later. A call the module makes to one of its exported functions is not checked again: such a function is exported through an entry that checks what the host gives and then calls it. Nothing is checked anywhere else, nothing for a `?Canvas`, and a program that uses no host type compiles to the same bytes as it would without this rule. An imported global is checked when the module starts (a wasm start function).

`encantis test` runs a module's tests with no host there: an imported function throws if a test calls it, and an imported global is given a value of its type that keeps its promise. For a plain host type that is a stand-in (an empty object), so the module starts and its tests run, those that never read the global too; an optional one is none, a number 0. Only the tests being run have their `test` blocks' imports: a library's test-only import is no part of a program that imports the library ([The Test Host](#the-test-host)).

For a JavaScript host, null is `null`. `undefined` (what a function that returns nothing gives, or a `Map.get` that finds nothing) is a value, not null: it passes for a `Canvas`, and `opt == 0` is false for it.

Nothing else is computed with a host reference: no arithmetic, no other comparison (two references are not compared: there is no equality for them), no cast to or from a number, an address or another host type (`0 as ?Canvas` is none, and `c as ?Canvas` widens), and no condition. It is passed, returned, stored in a variable or a global, and read back.

The compiler keeps host types as types of their own all the way to the code it writes, so another backend can hold them its own way. In WebAssembly both a `Canvas` and a `?Canvas` are an `externref` ([9.3](#93-wasm-type-mapping)), and none is `ref.null extern`. A plain one is not a `(ref extern)`, the type the engine itself keeps from being null, since that needs typed function references, which the compiler does not write ([11](#11-webassembly-reference)); the boundary checks do that work instead. A backend that holds a plain one as a `(ref extern)` can drop them with no change to the source.

<!-- spec:begin compile -->

```ents
type Canvas = host
type Context = host

import "canvas" (
  "context" func context(c: Canvas) -> Context
  "fill" func fill(ctx: Context, x: f32, y: f32, w: f32, h: f32)
)

// None until the host hands in a canvas.
global ctx: ?Context = 0

// The host hands the canvas in once; the module keeps what it needs.
export func start(c: Canvas) {
  ctx = context(c)
}

// Nothing is drawn before there is something to draw on.
export func draw(n: u32) -> u32 {
  if let x = ctx {
    for i in n {
      fill(x, i as f32 * 12.0, 0.0, 10.0, 10.0)
    }
    return n
  }
  return 0
}

export func started() -> bool => ctx != 0
export func stop() { ctx = 0 }

// A struct of a reference and a number is two values in registers.
type Tagged = (c: Canvas, n: i32)
export func tag(c: Canvas, n: i32) -> Tagged => Tagged(c, n + 1)

// A plain one comes out of an optional one with ?? as well.
export func or-else(maybe: ?Canvas, other: Canvas) -> Canvas => maybe ?? other

test "nothing is drawn before there is a context" {
  assert !started()
  assert draw(3) == 0
  stop()
  assert ctx == 0
  assert draw(3) == 0
}
```

`?` makes a host type optional by any name for it, also one declared further down, and a type parameter given a host type. `host` in parentheses is `host`, as any type is (2.7):

```ents
type Holder = (c: ?Canvas, n: i32)
type Canvas = host
type Screen = Canvas
type Window = (host)
export func window(w: Window) -> ?Window => w

func keep(comptime T: type, x: ?T) -> ?T => x
func pick(comptime T: type, x: ?T, d: T) -> T => x ?? d
export func picked(o: ?Canvas, c: Canvas) -> Canvas => pick(o, c)
export func held(h: Holder) -> ?Canvas => h.c
export func screen(s: ?Screen) -> ?Canvas => keep(s)
export func plain(c: Canvas) -> ?Screen => keep(c)

test "an optional one starts as none" {
  let none: ?Screen
  assert none == 0
  assert keep(none) == 0
}
```

None is the literal `0` wherever an optional one is wanted: an element of an array literal or a repeat, a field, a branch with no type of its own, a `def` of 0, and an instance of a generic:

```ents
type Canvas = host
type Pair = (cs: [2]?Canvas, n: i32)
def nothing = 0

global both-none: [2]?Canvas = [0, 0]

export func pair(c: Canvas) -> [2]?Canvas => [c, 0]
export func three() -> [3]?Canvas => [0; 3]
export func field(c: Canvas) -> Pair => Pair([0, c], 1)
export func pick(n: i32, c: ?Canvas) -> ?Canvas {
  let x = if n == 0 { 0 } elif n == 1 { c } else { (0) }
  let y = match n { 0 => c, _ => nothing }
  return if x == 0 { y } else { x }
}
export func grouped(c: Canvas) -> [2]?Canvas => [c, (nothing)]
export func untyped(c: ?Canvas) -> ?Canvas {
  let xs = [c, 0]
  let ys = [0, c]
  return if xs[1] == 0 { ys[0] } else { c }
}
func with-none(comptime T: type, x: T) -> [2]?T => [x, 0]
export func generic(c: Canvas) -> [2]?Canvas => with-none(c)
func given(comptime n: i32) -> ?Canvas => n
export func signed() -> [2]?Canvas => [-0, given(1 - 1)]

func none(a: [2]?Canvas) -> bool => a[0] == 0 && a[1] == 0
test "none is 0 in each place" {
  assert none([0, 0])
  assert none(both-none)
  assert none([nothing, (0)])
  assert pick(0, 0) == 0
  assert pick(2, 0) == 0
  assert three()[2] == 0
  assert none(signed())
}
```

Two host types are two types, neither is a number, a plain one is never null, and the one thing asked of an optional one is whether it is none:

```ents
type Canvas = host
type Context = host

func a(c: Canvas) -> Context => c
func b(c: Canvas) -> u32 => c as u32
func c(x: ?Canvas, y: ?Canvas) -> bool => x == y
func d(x: Canvas) -> Canvas => 1 as Canvas
func e() -> Canvas => 0
func f(c: Canvas) -> bool => c == 0
func g(x: ?Canvas) -> Canvas => x
func h() -> ?Canvas => 0 as Canvas
func i(x: Canvas, y: Canvas) -> bool => x != y
type Point = (x: i32, y: i32)
func j(p: ?Point) {}
func n(c: Canvas) -> i32 {
  let both = [0, c]
  return both[1] + 1
}
func k() -> ?Canvas => 0 + 0
func l(x: ?Canvas) -> bool => x == 1 - 1
func m() -> ?Canvas => "".len as ?Canvas
func o(c: Canvas) -> Context => c as Context
func p(x: ?Canvas) -> Canvas => x as Canvas
type Element = host
func q() -> Element => 0
func r() -> ?Canvas => -(0)
func s(b: bool, x: ?Canvas) -> bool => x == if b { 0 + 0 } else { 0 }
func t(n: i32, x: ?Canvas) -> bool => x == match n { 0 => 0, _ => 1 - 1 }
```

```errors
cannot make Point optional: only a pointer, a slice or a host reference has a none
cannot assign Canvas to Context
cannot cast Canvas to u32: Canvas is a host reference, which is no number and no address
'==' cannot be applied to ?Canvas and ?Canvas: ?Canvas is a host reference that may be none, which is only compared with 0
cannot cast int(1) to Canvas: Canvas is a host reference, which is no number and no address
cannot assign int(0) to Canvas: a Canvas is never null (a host reference that may be null is a ?Canvas)
'==' cannot be applied to Canvas and int(0): a Canvas is never null
cannot assign ?Canvas to Canvas: it may be none — resolve it with 'if let' or '??' first
cannot cast int(0) to Canvas: a Canvas is never null
'!=' cannot be applied to Canvas and Canvas: Canvas is a host reference, which is not compared
elements have different types: int(0) and Canvas
cannot assign int(0) to ?Canvas: none of a ?Canvas is written 0, the literal, and nothing computed is one
'==' cannot be applied to ?Canvas and int(1): none of a ?Canvas is written 0, the literal
cannot cast int(0) to ?Canvas: none of a ?Canvas is written 0, the literal
cannot cast Canvas to Context: they are two host types, and neither is the other
cannot cast ?Canvas to Canvas: it may be none — resolve it with 'if let' or '??' first
cannot assign int(0) to Element: an Element is never null (a host reference that may be null is a ?Element)
cannot assign int(0) to ?Canvas: none of a ?Canvas is written 0, the literal, and nothing computed is one
'==' cannot be applied to ?Canvas and int(0): none of a ?Canvas is written 0, the literal, and nothing computed is one
'==' cannot be applied to ?Canvas and int(1): none of a ?Canvas is written 0, the literal, and nothing computed is one
```

A reference is asked nothing but, for an optional one, whether it is none; and an array of them held in registers is reached by a constant index alone:

```ents
type Canvas = host

func a(c: Canvas, d: Canvas) -> Canvas => c ?? d
func b(c: Canvas) -> i32 => if let x = c { 1 } else { 0 }
func c(c: ?Canvas) -> i32 => match c { 0 => 1, _ => 2 }
func d(c: ?Canvas) -> i32 => if c { 1 } else { 0 }
func e(c: Canvas) -> bool => !c
func f(cs: [3]?Canvas, i: u32) -> ?Canvas => cs[i]
func g(cs: [3]?Canvas) {
  for c in cs {}
}
func h(c: Canvas) -> Canvas {
  for x in [c, c] {
    return x
  }
  return c
}
func k(c: ?Canvas) {
  let cs: [3]?Canvas = [0, 0, 0]
  cs[0..2] = c
}
```

```errors
?? requires an optional expression or bounds-checked index: a Canvas is never null
if let requires an optional expression or bounds-checked index: a Canvas is never null
cannot match ?Canvas against int(0): ?Canvas is a host reference that may be none: ask with == 0 or != 0, or resolve it with if let or ??
condition must be bool, not ?Canvas: ?Canvas is a host reference that may be none
operand of '!' must be bool, not Canvas: a Canvas is never null
dynamic index on value type [3]?Canvas — an element of an array held in registers is reached by a constant index only, and a host reference is never in memory
cannot iterate over [3]?Canvas: an array held in registers is not looped over, and a host reference is never in memory
cannot iterate over [2]Canvas: an array held in registers is not looped over, and a host reference is never in memory: reach each element by a constant index
cannot take a range of [3]?Canvas: an array held in registers has no range, and a host reference is never in memory: reach each element by a constant index
```

A plain host reference has no default, in a variable, a global or a named result, and in a struct or an array either:

```ents
type Canvas = host
type Tagged = (c: Canvas, n: i32)

global g: Canvas
global none: ?Canvas
import "env" "screen" global screen: Canvas
global k: Canvas = screen

func vars() {
  let c: Canvas
  let t: Tagged
  let cs: [2]Canvas
  let (p, q): (Canvas, i32)
  let ok: ?Canvas
}
func result() -> (r: Canvas) {}
func optional-result() -> (r: ?Canvas) {}
func leak(b: bool, given: Canvas) -> Canvas {
  if b {
    let c: Canvas = given
  }
  return c
}
func arm(n: i32, given: Canvas) -> Tagged {
  match n {
    0 => { let t: Tagged = Tagged(given, 1) }
    _ => {}
  }
  return t
}
func none-passes(n: u32, given: Canvas) -> [2]Canvas {
  for i in n {
    let a = [given, given]
  }
  return a
}
func optional(b: bool, given: Canvas) -> ?Canvas {
  if b {
    let o: ?Canvas = given
  }
  return o
}
```

```errors
global 'g' needs a value: a Canvas has no default (a ?Canvas starts as none), and no constant is a Canvas: import the global from the host, or make it hold a ?Canvas, which starts as none
global initializer must be a compile-time constant, and no constant is a Canvas
'c' needs a value where it is declared: a Canvas has no default
't' needs a value where it is declared: Tagged holds Canvas, which has no default
'cs' needs a value where it is declared: [2]Canvas holds Canvas, which has no default
this let needs a value where it is declared: (Canvas, i32) holds Canvas, which has no default
result 'r' cannot start with a default: a Canvas has no default (a ?Canvas starts as none); return the value instead
'c' is seen only in the block it is declared in: that block may not have run here, and a Canvas has no default (a ?Canvas starts as none); declare it before the block, with its value
't' is seen only in the block it is declared in: that block may not have run here, and Tagged holds Canvas, which has no default
'a' is seen only in the block it is declared in: that block may not have run here, and [2]Canvas holds Canvas, which has no default
```

None is in memory, also inside a struct, and also when the type is declared after it is named:

```ents
type Ref = *Holder
type Canvas = host
type Holder = (c: Canvas, n: i32)

func a(p: *Canvas) {}
func b(s: []Canvas) {}
func c(c: Canvas) -> u32 => sizeof(Canvas)
func d(x: host) {}
func e(p: *?Canvas) {}
type Field = (c: host)
func f(c: Canvas) -> u32 {
  let p = &[c, c]
  return p.len
}
func g() -> u32 {
  let p = &[0 as ?Canvas; 4]
  return p.len
}
func h(c: Canvas) -> u32 {
  let cs = [c, c]
  return cs.wid
}
func i(c: Canvas) {
  let cs = [c, c]
  let p = cs.ptr
}
```

```errors
'host' declares a host reference type
cannot point to Holder: it holds Canvas, and a host reference has no bytes, so it is never in memory
cannot point to Canvas: a host reference has no bytes
cannot make a slice of Canvas: a host reference has no bytes
'host' declares a host reference type
cannot point to ?Canvas: a host reference has no bytes
cannot take the size of Canvas: a host reference has no bytes
cannot lay out [2]Canvas: it holds Canvas, and a host reference has no bytes, so it is never in memory
cannot lay out [4]?Canvas: it holds ?Canvas
cannot take the width of Canvas: a host reference has no bytes
cannot take .ptr of [2]Canvas: a fixed array held by value has no address
```

Too many to hold at once is an error of the register limits (2.12), whose advice for a host reference is to hold fewer, not to put them behind a pointer; a value that is over the limit with the host references taken out still gets that advice:

```ents
type Canvas = host

func a(cs: [1001]?Canvas) {}
func b(c: ?Canvas) -> [1001]?Canvas => [c; 1001]
func c(c: ?Canvas, buf: [1200]u8) {}
func d(c: ?Canvas) {
  let many: [60000]?Canvas = [c; 60000]
}
func e(on: bool, c: ?Canvas) {
  let x = if on { [c; 1001] } else { [c; 1001] }
}
type One = (c: ?Canvas)
func f(ones: [1001]One) {}
```

```errors
the parameters are 1001 registers, more than the 1000 a wasm function takes — a host reference is held only in registers, never in memory: hold fewer at once
the results are 1001 registers, more than the 1000 a wasm function gives back — a host reference is held only in registers, never in memory: hold fewer at once
the parameters are 1201 registers, more than the 1000 a wasm function takes — pass a large value by pointer
the parameters are 1001 registers, more than the 1000 a wasm function takes — a host reference is held only in registers, never in memory: hold fewer at once
function 'd' needs more than 50000 registers, the most a wasm function has (here many: [60000]?Canvas is 60000) — a host reference is held only in registers
an if that gives [1001]?Canvas gives 1001 registers, more than the 1000 a wasm block gives back — a host reference is held only in registers
```

Nor is one behind a many-pointer or a framed array, laid out as `data`, or measured in an instance; and no number but the literal `0` is none of an optional one, which has no order either:

```ents
type Canvas = host

func a(p: [*]Canvas) {}
func b(p: *[2]Canvas) {}
func c(p: [!]Canvas) {}
data d = [0 as ?Canvas]
func e() -> ?Canvas => 7
func f(c: ?Canvas) -> bool => c < 0
func size(comptime T: type) -> u32 => sizeof(T)
func g() -> u32 => size(Canvas)
```

```errors
cannot point to Canvas: a host reference has no bytes
cannot point to [2]Canvas: it holds Canvas, and a host reference has no bytes
cannot point to Canvas: a host reference has no bytes
cannot lay out ?Canvas: a host reference has no bytes
cannot assign int(7) to ?Canvas: none of a ?Canvas is written 0, the literal
'<' cannot be applied to ?Canvas and int(0): ?Canvas is a host reference, which has no value the module can compute with
cannot take the size of Canvas: a host reference has no bytes, so it is never in memory (hold it in a variable, a parameter or a global), in size(T = Canvas)
```

A generic type that would put one in memory is refused in the application that does, once for each application however often it is named (8.3), also when the type is named before the host type is declared:

```ents
func Ptr(comptime T: type) -> type => *T
type P = Ptr(Canvas)
type Canvas = host

func a(p: Ptr(Canvas)) {}
func b(p: P) {}
```

```errors
cannot point to Canvas: a host reference has no bytes, so it is never in memory (hold it in a variable, a parameter or a global), in Ptr(Canvas)
```

<!-- spec:end -->

---

## 3. Declarations

A module is a list of declarations. This chapter covers those that name a value or code: `def` (a constant), `data` (bytes laid out in memory), `let` and `global` (variables) and `func` (functions). A type is declared with `type` ([2.11](#211-type-names)) or `enum` ([2.9](#29-enum-types-algebraic-data-types)); `import`, `export` and `memory` are in [7. Modules](#7-modules); a `test` block holds code that checks the module, run by `encantis test` ([Tests](#tests)).

Where each declaration can stand:

| Where | What it holds |
|---|---|
| The module | every declaration: `func`, `def`, `data`, `global`, `type`, `enum`, `import`, `export`, `memory`, `test` |
| A `test` block | `def`, `data`, `func`, `import`, nested `test` blocks, and statements |
| A function body | statements only: `let`, `set`, assignments, loops, `return` and the rest of [5. Statements & Control Flow](#5-statements--control-flow), and expressions |

Anything else is a syntax error at its keyword: a `def`, `data`, `global`, `type` or `func` in a function body, a `global`, `type`, `enum`, `memory` or `export` in a test.

**Order.** The declarations of a module can stand in any order. A function body sees every name of the module, declared above it or below it, and a type sees every type and `def` of the module wherever they are declared (`type Row = [n]u8` can come before `def n = 4`). A value worked out when the program is compiled sees only what is declared above it: the value of a `def`, the values of a `data` block and the initializer of a `global` can name the defs and the data declared before them, and a name declared further down is `unknown identifier`.

<!-- spec:begin compile -->

```ents
export func area() -> u32 => side * side     // side is declared below: a body sees it

def side = 6
def half = side / 2                           // side is declared above
global start: u32 = half                      // so is half

test "a body sees the whole module" {
  assert area() == 36
  assert start == 3
}
```

```ents
global limit: u32 = step * 4
def step = 2
```

```errors
unknown identifier 'step'
cannot assign i32 to u32
global initializer must be a compile-time constant
```

<!-- spec:end -->

**Names.** A name declared at the level of the module belongs to one declaration: a second one of the same name is an error (`'size' is already declared`). Functions are the exception: several can share a name when their parameters differ ([Functions That Share a Name](#functions-that-share-a-name)). A local variable cannot take the name of anything the module declares ([3.3](#33-variables)); a parameter can ([3.4](#34-functions)).

**Unused declarations.** The compiler warns `'x' is never used` for a function, `def`, `data` block, `global` or import of the module that nothing uses and that is not exported. An unused type, parameter or local variable gets no warning. A warning never stops a build, and the command line does not print it ([Tools](#tools)).

### 3.1 Definitions (`def`)

`def name = value` names a compile-time constant. Each use of the name is the value, as if it were written there in parentheses: a `def` takes no memory, has no address and is no wasm global, and each use compiles as the value written there would. `def mask: u32 = 0xff` is `(i32.const 255)` wherever it is used, and `def page = 64 * 1024` used as a `u64` is `(i64.mul (i64.const 64) (i64.const 1024))`, which an optimizer such as `wasm-opt` folds.

The value is one scalar: an integer, a float, `true` or `false`, a codepoint (`'a'`), or an expression of these and of other defs with `+ - * / %`, `& | ^`, the shifts `<<` and `>>`, unary `-` and `~`, `sizeof(T)`, and the `.len` or `.wid` of a `data` array. A rotate, a comparison, `&&`, `||`, `!`, an `if`, a call (of a builtin too), a division by zero, a global and a variable are not constants (`def value must be a compile-time constant`). A `def` always has a value: `def buf: [4096]u8` is a syntax error.

With no type written, a `def` is an untyped constant: each use takes the type that use wants, as the literal itself would, and where nothing says, the literal's default type ([Integer Literals](#integer-literals)). Each use is checked on its own, so a `def page = 64 * 1024` is a `u64` in one place and an `f64` in another, and used as a `u16` it is `cannot assign int(65536) to u16`. With a type, `def mask: u32 = 0xff` (or `def mask = 0xff:u32`), it is of that type at every use, and widens from there as any `u32` does.

<!-- spec:begin compile -->

```ents
def page = 64 * 1024        // untyped: the type of each use
def mask: u32 = 0xff        // typed: a u32 at every use
def slots = 8
def newline = '\n'

data cells = mut [0:u32; slots]

func pages(bytes: u64) -> u64 => (bytes + page - 1) / page
func fraction(bytes: f64) -> f64 => bytes / page
func low(x: u32) -> u32 => x & mask
func is_newline(c: u8) -> bool => c == newline

test "a def is its value at each use" {
  assert pages(100000) == 2
  assert fraction(32768.0) == 0.5
  assert low(0x1234) == 0x34
  assert is_newline(10)
  assert cells.len == slots
}
```

<!-- spec:end -->

A `def` names a number, never something laid out in memory: an array, a string or a tuple is not a `def`'s value. A table of values is `data` ([3.2](#32-data-declarations-data)), and a pair is two defs.

<!-- spec:begin compile -->

```ents
def origin = (0.0, 0.0)
def primes = [2, 3, 5, 7]
def small = 300

func f() -> u8 => small
```

```errors
def cannot contain array/string literals — use 'data origin = ...' instead
def value must be a compile-time constant
def cannot contain array/string literals — use 'data primes = ...' instead
def value must be a compile-time constant
cannot assign int(300) to u8
```

<!-- spec:end -->

The compiler refuses two values these rules allow (known bugs): a value written whole in parentheses, `def k = (1 + 2)`, gets the tuple's error (write `def k = 1 + 2`), and a cast, `def big = 122 as u32`, gets `def value must be a compile-time constant` (write the type with `:`, `def big = 122:u32`). A typed `def` whose value does not fit its type, `def small: u8 = 300`, is reported where it is used, not where it is declared.

A `def` can stand wherever a constant can: in an expression, as the length in a type (`[n]u8`), the bound of a ranged integer (`u32#n`), the count of a repeat literal (`[0; n]`) or of a loop (`for i in n`), a comptime value argument ([8.7](#87-comptime-value-parameters)), a global's initializer and the values of `data`.

A `def` is no variable: assigning it is an error (`cannot assign to 'k': it is not a variable`, [4.5](#45-assignment-and-compound-assignment)). A `let`, a loop variable and a match binding cannot take a def's name (`'k' is already declared in this scope`, `'k' is already declared: a loop variable cannot reuse the name of a def`). A parameter must not take one either: the compiler accepts such a parameter, and every read of it gives the def's value instead of the argument (a known bug).

A `def` declared in a `test` block is that test's: it replaces the name inside that test only, and the rest of the module reads the name as if the test were not there.

Each place the name is written is a use of the def, also where its value is an expression (`def next = 'a' + 1`): the editor shows the def there and goes from there to it, its references are those places, and a def used nowhere is reported as never used.

### 3.2 Data Declarations (`data`)

`data name = literal` lays the literal out in the module's memory and binds the name to its address. The bytes are a wasm data segment: they are in memory when the module starts, and no code fills them in. The name is a constant pointer, and a use of it compiles to `i32.const` of the address. A module that has data has a memory ([7.3](#73-memory-declarations)).

| Value | The name is |
|---|---|
| an array literal, `[1:u64, 2, 3]` | `*[3]u64` |
| a repeat literal, `[0:u8; 1024]` | `*[1024]u8` |
| a string, `"hello"`, `x"9d61b19d"` | `*[5]u8`, `*[4]u8` |
| an array of tuples, `[(0, 0), (4, 3)]` | `*[2](i32, i32)` |
| a tuple, `(0.0, 0.0)` | `*(f64, f64)` |
| a number, `5` or `5:u8` | `*i32`, `*u8` |
| any of these written `mut` | the same pointer, `*mut` |

An untyped number takes its default type, as in a `let` ([Integer Literals](#integer-literals)). The array pointer `*[N]T` keeps the length in its type, so `.len` is a constant, and it converts to `[]T` or `[*]T` wherever one of those is wanted ([9.5](#95-array-type-conversions)): the form without a type is the usual one.

<!-- spec:begin compile -->

```ents
data zeros = [0:u8; 1024]           // *[1024]u8
data key = x"9d61b19deffd5a60"      // *[8]u8
data table = [1:u64, 2, 3, 4]       // *[4]u64
data msg = "hello"                  // *[5]u8
data origin = (0.0, 0.0)            // *(f64, f64)
data corners = [(0, 0), (4, 3)]     // *[2](i32, i32)

func sum(xs: []u64) -> (total: u64) {
  for x in xs {
    total += x
  }
}

test "data is a pointer to its bytes" {
  assert zeros.len == 1024
  assert key[0] == 0x9d
  assert sum(table) == 10
  assert msg.len == 5
  assert origin.1 == 0.0
  assert corners[1].0 == 4
}
```

<!-- spec:end -->

**A type written for data** means one of two things, by the value:

- For an array, repeat or string literal, it is the type of the name: a pointer or a slice to the elements. `data cells: *[3]i32 = [1, 2, 3]` is a `*[3]i32`, `data view: []u8 = "hello"` a slice, whose type does not hold the length, and `data name: *[!]u8 = "hi"` a framed pointer ([2.5](#25-pointer-types)). A value array, `data c: [3]i32 = [...]`, is not such a type: the compiler accepts it, and the module does not assemble (a known bug).
- For a number, a tuple or a struct, it is the type of the value laid out, and the name points to it. `data stats: Tally = mut (0, 0)` is a `*mut Tally`, `data limit: u32 = 100` a `*u32`. So write the value's type here, not a pointer: `data p: *mut Tally = mut (0, 0)` would be a `*mut *mut Tally`, a cell that holds a pointer, and the compiler leaves that cell 0 and lays out no `Tally` (a known bug).

<!-- spec:begin compile -->

```ents
type Tally = (count: u32, total: u64)

data stats: Tally = mut (0, 0)        // *mut Tally
data limit: u32 = 100                 // *u32
data primes: *[4]u16 = [2, 3, 5, 7]   // *[4]u16
data name: []u8 = "encantis"          // []u8

func add(x: u32) {
  stats.count += 1
  stats.total += x
}

test "the type is the value's, or the pointer to an array's elements" {
  add(30)
  add(12)
  assert stats.count == 2
  assert stats.total == 42
  assert limit.* == 100
  assert primes[3] == 7
  assert name.len == 8
}
```

<!-- spec:end -->

An element can be a struct. A tuple gives its fields by position, or by name where it names them, as anywhere a tuple becomes a struct ([2.8](#struct-constructors)); so does a constructor. A slice field written as a string or an array literal points at that literal, which is laid out on its own.

Data is laid out when the program is compiled, so each value in it is known by then: a literal, a constant expression (`1 + 1`, `k * 2` with `def k = 4`, `sizeof(u64)`, `~0`), or the name of other data declared before it, which is that data's address (for a slice field, its address and length). Anything else is an error, `data 'xs' is laid out at compile time: its values must be constants`.

<!-- spec:begin compile -->

```ents
type Point = (x: i32, y: i32)
type City = (name: []u8, at: Point)
type Ref = (p: *[3]i32, n: u32)

def k = 4

data cities: *[2]City = [("Oslo", (3, 4)), City(at: Point(y: 2, x: 1), name: "Rome")]
data ones = [1:i32, 1, 1]
data xs: *[4]u32 = [1 + 1, k * 2, sizeof(u64), ~0]   // 2, 8, 8, 0xFFFFFFFF
data refs: *[1]Ref = [(ones, 3)]                     // the address of ones, and 3

test "data values are constants" {
  assert cities[0].name.len == 4
  assert cities[1].at.x == 1
  assert xs[3] == 0xFFFFFFFF
  assert refs[0].p[2] == 1
  assert refs[0].n == 3
}
```

```ents
func two() -> u32 => 2
data xs = [1, two()]
```

```errors
data 'xs' is laid out at compile time: its values must be constants
```

<!-- spec:end -->

The blocks are laid out one after another from address 8 up, with no padding between them and none inside them: an address need not be a multiple of its type's size, which wasm loads and stores allow. Where data lies in memory, and how equal constant literals share their bytes, is in [9.0](#90-data-layout).

A `data` block declared in a `test` block is that test's, as a `def` there is. The name is no variable: assigning it is an error (`cannot assign to 'buf': it is not a variable`); what it points to is written through it, when it is `mut`.

#### Mutability

Data is const unless its literal is `mut`, and a mutable type needs a `mut` literal ([The `mut` Keyword on Literals](#the-mut-keyword-on-literals)). A static buffer is `data` with a `mut` literal, `data buf = mut [0:u8; 4096]`, a `*mut [4096]u8` of zeros. Const data may share its bytes with other const data and with constant literals elsewhere in the program that are equal to it; mutable data is its own:

<!-- spec:begin compile -->

```ents
data table = [1:u8, 2, 3]           // *[3]u8: may share its bytes
data again = [1:u8, 2, 3]           // equal: may be the same bytes
data buffer = mut [0:u8; 16]        // *mut [16]u8: its own bytes
data counts: []mut u32 = mut [0, 0] // []mut u32: its own

func bump(i: u32#16) -> u8 {
  buffer[i] += 1
  return buffer[i]
}

test "mutable data is written through its name" {
  assert table[2] == again[2]
  assert bump(3) == 1
  assert bump(3) == 2
  if let c = &counts[1] {
    c.* = 9
  }
  assert (counts[1] ?? 0) == 9
}
```

```ents
data sums: []mut u32 = [0, 0]
```

```errors
a literal is constant: write `mut [0, 0]` for a []mut u32
```

<!-- spec:end -->

### 3.3 Variables

A `let` declares a variable of a function; a `global` declares a variable of the module. A variable holds a value: it lives in wasm locals or globals, one for each wasm value of its type (a struct one for each field, a slice its pointer and its length), never in memory.

| Form | Declares |
|---|---|
| `let x: T = v` | `x` of type `T`, set to `v` |
| `let x = v` | `x` of the type of `v` |
| `let x: T` | `x` of type `T`, zero (see below) |
| `let (a, b) = v`, `let a, b = v` | one variable for each element of a tuple or a function's results, by position |
| `let (x:, y: py) = v` | by field name: `x` and `py` hold the fields `x` and `y` |
| `let (a, (b, c)) = v` | nested, by position |
| `let (a, b): (u32, u32) = v` | with a type for the whole |
| `set a, b = v`, `set (x:, y:) = v` | assigns variables that exist, with the same patterns ([4.5](#45-assignment-and-compound-assignment)) |
| `global x: T = v`, `global x = v`, `global x: T` | a variable of the module |

A `let` needs a type or a value (`let needs type annotation or initializer`), and so does a `global` (`global needs type annotation or initializer`). A pattern by position may bind fewer elements than the value has, `let (a, b) = (1, 2, 3)` binds the first two, but not more (`tuple has 2 fields, but pattern has 3`). A named part binds a plain name, not a pattern. The list without parentheses takes no type (`let a, b: u32 = ...` is a syntax error): write `let (a, b): (u32, u32) = ...`. A global binds one name: `global (lo, hi) = ...` is `global destructuring is not supported yet`.

<!-- spec:begin compile -->

```ents
type Body = (pos: (x: f64, y: f64), vel: (x: f64, y: f64))

func divmod(a: u32, b: u32) -> (q: u32, r: u32) => (a / b, a % b)
func body() -> Body => ((1.0, 2.0), (3.0, 4.0))

test "binding forms" {
  let n: u32 = 17
  let half = n / 2                 // a u32, as n is
  let q, r = divmod(n, 5)          // by position: 3 and 2
  let (pos:, vel: v) = body()      // by name: pos, and vel bound as v
  let (a, (b, c)) = (1, (2, 3))    // nested
  set q, r = (r, q)                // existing variables: a swap
  assert half == 8
  assert q == 2
  assert r == 3
  assert pos.x + v.y == 5.0
  assert a + b + c == 6
}
```

```ents
global (lo, hi) = (1:u32, 2:u32)
global spare

func f() -> u32 {
  let y
  return 1
}
```

```errors
global destructuring is not supported yet
global needs type annotation or initializer
let needs type annotation or initializer
```

<!-- spec:end -->

**Zero at the start.** Every variable of a function, each `let` and each named result ([3.4](#34-functions)), is zero when the function is entered: 0, `false`, a null pointer, an empty slice, none for an optional, and each part of a struct or array zero. A `let` with a value sets it each time control reaches the `let`. A `let` without one sets nothing: it holds what it held, so in a loop it holds what the last pass left. A `let` of an optional host reference is the exception: it is none on every pass ([2.13](#213-host-references)).

<!-- spec:begin compile -->

```ents
func last_even(xs: []u32) -> u32 {
  let found: u32                   // 0 until it is set
  for x in xs {
    if x % 2 == 0 {
      found = x
    }
  }
  return found
}

func counts(n: u32) -> u32 {
  let total: u32 = 0
  for i in n {
    let seen: u32                  // not reset: it keeps the last pass's value
    seen += 1
    total += seen
  }
  return total
}

test "a let without a value starts at zero and is never reset" {
  assert last_even([3, 8, 5, 4, 7]) == 4
  assert last_even([1, 3]) == 0
  assert counts(3) == 1 + 2 + 3
}
```

<!-- spec:end -->

A `let` declares a variable of its function, seen from there to the function's end, also after the block it is in has ended; only a `let` in the first branch of an `if let` is seen in that branch alone ([`if let` Bindings](#if-let-bindings)). A variable of a type that has no default, one that holds a plain host reference ([2.13](#213-host-references)), is seen in the block it is declared in alone: after a branch, a loop's body or a match arm, that block may not have run, and the variable would have no value. Its name is its own: it can't be the name of a parameter, a named result or another variable seen there, nor of a global, `def`, `data` block, function or import of the module (`'count' is already declared in this scope`). The variables of a loop, an `if let` and a match arm are seen in their body only ([5.2](#52-loops)).

**Globals.** A `global` is a variable of the module. It keeps its value from one call into the module to the next, and every function of the module reads and assigns it. Each is a mutable wasm global; one of a type that takes several wasm values (a slice, a struct, a wide integer) is that many wasm globals, one for each value, so it works as a local of the same type does. A global can be of any value type but one that holds a plain host reference: its value is a constant, and no constant is one, so such a global is imported from the host ([2.13](#213-host-references)). A global imported from the host is read-only ([7.1](#71-imports)); one is exported with `export global` ([7.2](#72-exports)). A value that never changes is better a `def`, which costs nothing.

A global starts as its initializer, or zero without one:

<!-- spec:begin compile -->

```ents
type Size = (w: i32, h: i32)

global order: []i32                // two wasm globals: the pointer and the length, zero
global size: Size = Size(3, 4)     // one for each field
global scratch: Size               // zero until it's set

data primes = [2:i32, 3, 5, 7]

func keep(list: []i32) -> u32 {
  order = list
  size.h += 1
  scratch = size
  return order.len
}

test "a global keeps its value between calls" {
  assert order.len == 0
  assert scratch.w == 0
  assert keep(primes) == 4
  assert scratch.h == 5
  assert keep(primes) == 4
  assert scratch.h == 6
}
```

<!-- spec:end -->

A constant with no type, alone or as an element of a tuple, takes its default type ([Integer Literals](#integer-literals)), the same for a `let` and a `global`: `global big = 2147483648` is an `i64` and `let t = (3000000000, 1)` an `(i64, i32)`. The variable is of that type from then on, so `global count = 0` holds any `i32` it is assigned.

A global's initializer is a compile-time constant: a literal, an expression of literals and defs (as for a `def`, [3.1](#31-definitions-def)), the address of a `data` block, or a cast of one of these. For a global of several values it's a constructor, tuple or array of those, or a string or `data` array for a slice. It sees only the defs and data declared above it, and never another global (`global initializer must be a compile-time constant`). The compiler works out each value, so it can be written as it's meant:

<!-- spec:begin compile -->

```ents
def page = 64 * 1024
data table = [1:u16, 2, 3]

global limit: u32 = 4 * page     // 262144
global ratio: f64 = 2 / 3.0
global mask: u32 = ~0 << 12
global span: (u32, f64) = (4 * page, 1 / 4.0)
global bits: u32 = -1 as u32     // 4294967295
global low: u8 = 300 as u8       // 44, as the cast gives at run time
global bytes: [*]u8 = table as [*]u8
global halves: f64 = 7 / 2       // 3.5: the division is an f64 one
global pairs: i32 = 7 / 2        // 3

test "an initializer is worked out as the program would" {
  assert limit == 262144
  assert mask == 0xFFFFF000
  assert span.1 == 0.25
  assert bits == 4294967295
  assert low == 44
  assert bytes[2] == 2
  assert halves == 3.5
  assert pairs == 3
}
```

<!-- spec:end -->

The value is the one the expression has at run time, in the types its parts have: `7 / 2` starts an `f64` global as 3.5 and an `i32` one as 3, and `200:u8 + 100:u8` is 44 whatever the global's type.

A cast of an address is a constant when it keeps the address whole: to another pointer type, or to `i32` or `u32`. A value that needs a call or another global isn't a constant: assign it in a function.

### 3.4 Functions

A function declaration is `func`, the function's name, its parameters in parentheses, `->` and its results, and its body:

- **Parameters** are separated by commas: `name: Type` each. A parameter can leave its name out, `func skip(u32, n: u32)`, and then it cannot be read: it is there to match a signature. With a single unnamed parameter the parentheses can go too: `func ignore i32 -> i32 => 0`. Such a parameter is left out of the compiled wasm function, so a call that passes it gives a module that does not assemble, and an exported one is exported with fewer parameters (a known bug). A `comptime` parameter makes the function generic ([8. Generics](#8-generics)).
- **Results** follow `->`: none (leave out `->`, or write `-> ()`), one type (`-> u32`), several in parentheses (`-> (u32, u32)`), or several with names (`-> (q: u32, r: u32)`). One type in parentheses without a name is that type, so `-> (u32)` is one result, and `-> ((q: u32, r: u32))` is one result that is a struct. Name every result or none: with a mix such as `-> (a: u32, u32)` a block body that ends without `return` gives a module that does not assemble (a known bug).
- **The body** is `=> expression` or a block of statements in braces.
- `inline` may stand before `func` ([3.5](#35-inline-functions)), and `export` before both ([7.2](#72-exports)).

<!-- spec:begin compile -->

```ents
global calls: u32 = 0

func add(a: i32, b: i32) -> i32 {
  return a + b
}

func square(x: i32) -> i32 => x * x               // expression body

func divmod(a: u32, b: u32) -> (q: u32, r: u32) {  // named results
  q = a / b
  r = a % b
}

func count() {                                     // no result
  calls += 1
}

test "the four shapes of a function" {
  assert add(2, 3) == 5
  assert square(-4) == 16
  let q, r = divmod(17, 5)
  assert q == 3
  assert r == 2
  count()
  count()
  assert calls == 2
}
```

<!-- spec:end -->

Each function is one wasm function. A parameter is one wasm parameter for each wasm value of its type (a struct one for each field, a slice its pointer and its length), the results are the function's wasm results (several where there are several), and a named result is a local of the function. A call by name is a wasm `call`. Every function of the module is in the output, whether anything calls it or not; a generic function is there as its instances ([8.4](#84-instances)). `divmod` above is:

```wat
(func $divmod (param $a i32) (param $b i32) (result i32 i32)
  (local $q i32)
  (local $r i32)
  (local.set $q (i32.div_u (local.get $a) (local.get $b)))
  (local.set $r (i32.rem_u (local.get $a) (local.get $b)))
  (local.get $q)
  (local.get $r)
)
```

A function can call any function of the module, declared above or below it, and itself: recursion is a plain wasm call on the engine's stack, and a call nested too deep traps.

**Parameters are variables.** A parameter holds a copy of its argument: assigning the parameter, or a field of a struct parameter, changes the function's copy only. A pointer parameter points into the caller's memory, and what is written through it is seen there; only a `*mut` pointer takes writes ([2.5](#25-pointer-types)).

<!-- spec:begin compile -->

```ents
type Point = (x: i32, y: i32)

func moved(p: Point, dx: i32) -> Point {
  p.x += dx                       // the function's own copy
  return p
}

func move(p: *mut Point, dx: i32) {
  p.x += dx                       // the caller's memory
}

data spot: Point = mut (1, 2)

test "a value is copied, a pointer is shared" {
  let a = Point(1, 2)
  let b = moved(a, 10)
  assert a.x == 1
  assert b.x == 11
  move(spot, 10)
  assert spot.x == 11
}
```

<!-- spec:end -->

A parameter's name, and a named result's, is written once in a signature (two parameters of one name are accepted and give a module that does not assemble, and two results of one name are one variable: known bugs). A parameter can have the name of a global, a function, an import or a `data` block of the module, which it hides in the body. It must not have a def's name: such a parameter is accepted, and reading it gives the def's value (a known bug).

**Returning.** An expression body is the function's result, so a function with no result has a block body: `func f() => id(3)` is `cannot assign u32 to ()`, and `func f() => bump()`, where `bump` has no result either, is refused too (`cannot assign () to ()`, a known bug). A block body gives an unnamed result with `return value`, and every way out of the block must be one. The compiler decides this by the block's last statement, which must be:

- a `return` (not `return ... when ...`),
- a `loop` with no `break` out of it,
- an `if` with an `else`, whose every branch ends in one of these, or
- a `match` with a `_` arm, whose every arm ends in one of these.

Anything else is `function 'f' can reach its end without returning a value`: a `while true` loop, a statement after the last `return`, and a trailing value. With an unnamed result the last expression of a block body is not returned: write `return`, or an expression body (`=> if c { 1 } else { 2 }`).

A bare `return` is for a function with no result, or with named results; with an unnamed result it is `return needs a value: the function returns u32`, and a value returned from a function with no result is `cannot assign int(1) to ()`. An expression written as a statement is evaluated and its value dropped: `bump()` alone calls `bump` and drops its result.

<!-- spec:begin compile -->

```ents
func sign(x: i32) -> i32 {
  if x < 0 {
    return -1
  } elif x > 0 {
    return 1
  } else {
    return 0
  }
}

func steps(n: u64) -> u32 {
  let count: u32 = 0
  loop {
    return count when n == 1
    n = if n % 2 == 0 { n / 2 } else { 3 * n + 1 }
    count += 1
  }
}

func pick(c: bool) -> u32 => if c { 1 } else { 2 }

test "every path returns" {
  assert sign(-5) == -1
  assert sign(0) == 0
  assert steps(6) == 8
  assert steps(1) == 0
  assert pick(false) == 2
}
```

```ents
func one() -> u32 { 1 }
func two(c: bool) -> u32 {
  if c { return 2 }
}
func three() -> u32 {
  while true { return 3 }
}
func four() -> u32 { return }
```

```errors
function 'one' can reach its end without returning a value
function 'two' can reach its end without returning a value
function 'three' can reach its end without returning a value
return needs a value: the function returns u32
```

<!-- spec:end -->

**Named results.** Named results are variables of the function, declared in the signature, `-> (name: Type)`. Each starts at zero, as every variable of a function does ([3.3](#33-variables)). The function returns them as they are when it ends: when control reaches the end of the body, at a bare `return`, or at `return value`, which gives values for them. If the body ends in an expression with a value, that value becomes the result, and widens to its type like a `return` value. With several results a value fills them in order, whatever its own fields are called, and a tuple literal with names fills the results of those names ([2.8](#struct-constructors)), also as the value of a branch of an `if` or a `match` (each branch is a value of its own, as in `picked` below). An expression body gives the results the same way.

<!-- spec:begin compile -->

```ents
func split(n: u32) -> (hi: u32, lo: u32) => (n >> 16, n & 0xffff)

func halves(n: u16) -> (hi: u64, lo: f64) {
  (n >> 8, n & 0xff)                     // each element widens to its result
}

func swapped(n: u32) -> (lo: u32, hi: u32) {
  split(n << 16 | n >> 16)               // split's hi and lo fill lo and hi, in order
}

func named(n: u32) -> (hi: u32, lo: u32) => (lo: n & 0xffff, hi: n >> 16)  // a literal with names, by name

func picked(c: bool, n: u32) -> (lo: u32, hi: u32) {
  if c { split(n) } else { (hi: 1, lo: 2) }   // in order in one branch, by name in the other
}

func total(xs: []u32) -> (sum: u32) {
  for x in xs {
    sum += x                             // sum starts at 0
  }
}

test "named results" {
  let (hi:, lo:) = split(0x12345678)
  assert hi == 0x1234 && lo == 0x5678
  let wide, ratio = halves(0x1234)
  assert wide == 0x12 && ratio == 52.0
  assert swapped(0x12345678).lo == 0x5678
  assert named(0x12345678).hi == 0x1234
  assert picked(false, 0).hi == 1
  assert total([1, 2, 3]) == 6
}
```

<!-- spec:end -->

<!-- spec:begin compile -->

A result named like a parameter is that parameter: one variable, which holds the argument and then the result. So it has the parameter's type:

```ents
func round(acc: u64, v: u64) -> (acc: u64) {
  acc = (acc + v) * 31
}

test "a result named like a parameter starts as the argument" {
  assert round(1, 2) == 93
}
```

```ents
func grow(n: u32) -> (n: u64) {
  n = n + 1
}
```

```errors
result 'n' is the parameter 'n', so it has its type: u32, not u64
```

<!-- spec:end -->

**A function has a name.** A module-level `func(x: i32) -> i32 => x + 1` without one is accepted and left out of the module, and `export "inc" func(...)` gives a module that does not assemble: both are known bugs, so name every function. An import item can leave the name out ([7.1](#71-imports)).

A function that takes a type as a parameter, `func max(comptime T: type, a: T, b: T) -> T`, is generic: see [8. Generics](#8-generics).

#### Functions That Share a Name

<!-- spec:begin compile -->

Two functions may have the same name when their parameter lists differ, in the number of parameters or in their types. A call means one of them by its arguments:

```ents
func hash(k: u32) -> u32 => k * 0x45d9f3b
func hash(k: u64) -> u32 => hash((k ^ (k >> 32)) as u32)
func hash(k: []u8) -> (h: u32) {
  h = 0x811c9dc5
  for b in k {
    h = (h ^ (b as u32)) * 0x01000193
  }
}

export func a(n: u32, wide: u64) -> u32 => hash(n) ^ hash(wide)     // hash(k: u32), hash(k: u64)
export func b(name: []u8) -> u32 => hash(name) ^ hash("salt")       // hash(k: []u8), both times

test "each call reaches its own function" {
  assert a(1, 1) == 0
  assert hash(7:u32) == 7 * 0x45d9f3b
  assert b("x") != b("y")
}
```

1. **The function whose parameter types are the argument types is the one called.** `hash(n)` with `n: u32` is `hash(k: u32)`, although a `u32` could also be passed for the `u64` of the second. An untyped literal has no type of its own: beside typed arguments, or typed parts of a tuple, it only has to fit its parameter (see below).
2. **Otherwise it is the only function the arguments can be passed to.** `hash("salt")` is `hash(k: []u8)`: a string is not a number. The argument is then converted as for any call.
3. **Anything else is an error**, whether no function takes the arguments or more than one could:

```ents
func hash(k: u32) -> u32 => k
func hash(k: u64) -> u32 => 1

func f(x: f64) -> u32 => hash(x)
func g() -> u32 => hash(5)
```

```errors
no function 'hash' accepts (f64)
'hash' is ambiguous for (int(5))
```

`hash(5:u64)` says which. A literal has no type of its own and never decides by itself. Beside arguments that have a type it decides nothing either: a function whose typed arguments are exactly its parameter types, and whose literals fit their parameters, is the one called, before any function that would convert an argument. `gt(x, 10)` with `x: u32` is `gt(a: u32, b: u32)`: `x` is a `u32` and `10` fits one, while `gt(a: f64, b: f64)` would convert `x`.

```ents
func gt(a: u32, b: u32) -> bool => a > b
func gt(a: f64, b: f64) -> bool => a > b

export func f(x: u32) -> bool => gt(x, 10)        // gt(a: u32, b: u32)
export func g(x: f64) -> bool => gt(x, 10)        // gt(a: f64, b: f64)
export func h(x: u32) -> bool => gt(x, 2.5)       // 2.5 is no u32: gt(a: f64, b: f64), x converted

test "the typed argument says which" {
  assert f(11)
  assert !f(10)
  assert g(10.5)
  assert !h(2)
}
```

The same holds inside a tuple, a struct literal or `&` of one: its typed parts are exact where they are the parameter's parts, and its literals only have to fit. `far((x, 1))` with `x: u32` is `far(p: (u32, u32))`, and `far((x, 1))` with `x: u64` is the other one. A tuple literal gives a struct's fields by name, or by place where an element has no name ([2.8](#struct-constructors)), and its parts are the fields they give, however deep the literal stands: `(y: 1, x: n)` and `(n, 1)` are as exact for a `(x: u32, y: u32)` as `(x: n, y: 1)` is, and so are `&(y: 1, x: n)` for a `*(x: u32, y: u32)` and `(n: k, at: (y: 1, x: 2))` for a `(at: (x: i32, y: i32), n: u8)`. Laying a literal out this way only settles a call that is not settled without it: where one function is exact for the literal as it is written, that one is called. An array literal is untyped as a whole, even where an element has a type.

```ents
func far(p: (u32, u32)) -> u32 => p.0 + p.1
func far(p: (u64, u64)) -> u32 => 0

export func k(x: u32) -> u32 => far((x, 1))       // far(p: (u32, u32))
export func m(x: u64) -> u32 => far((1, x))       // far(p: (u64, u64))

test "a tuple's typed parts say which" {
  assert k(2) == 3
  assert m(2) == 0
}
```

Only functions that are exact alike remain ambiguous: those whose typed arguments are the same and whose literals fit each of them, as `hash(5)` above, where there is no typed argument at all, and this one, where `x` is a `u8` for both and `3` fits both:

```ents
func put(a: u8, b: u8) -> u32 => 1
func put(a: u8, b: u32) -> u32 => 2

func f(x: u8) -> u32 => put(x, 3)
```

```errors
'put' is ambiguous for (u8, int(3))
```

`put(x, 3:u32)` says which, and `put(x, 300)` needs no help: 300 fits only a `u32`.

What a call's value is used for takes no part in the choice, and neither do results: two functions with the same name and the same parameter types are an error, whatever their parameters are called and whatever they return.

```ents
func hash(k: u32) -> u32 => k
func hash(n: u32) -> u64 => 1
```

```errors
'hash' is already declared with parameters (u32)
```

A name that several functions share says which one only in a call. Anywhere else, as in `let g = hash`, it is an error (`'hash' is the name of several functions: it can only be called, where the arguments say which one`).

Each of the functions is a function of its own in the output, and a call of one is a direct call. In WAT the first one declared keeps the name and each later one carries its parameter types, `$hash:u64`, `$hash:''u8`; the spelling is not part of the language and names do not reach the `.wasm` file. An imported function shares a name in the same way. Every export needs a name of its own:

```ents
export func hash(k: u32) -> u32 => k
export func hash(k: u64) -> u32 => 1
```

```errors
export name 'hash' is used twice: give one an explicit name, as in export "hash_u64" func hash(...)
```

Three things do not share. A generic function's name is unique in its module ([8.1](#81-compile-time-parameters)). A function declared in a `test` block takes over the name of the module's function inside that test ([Declarations in a Test](#declarations-in-a-test)); a name that several functions of the module share cannot be taken over (`'hash' is the name of several functions of the module: a function declared in a test cannot take it over`). And a function declared with the name of a builtin (`min`, `max`, `abs`, ...) takes the builtin's place in its module ([10. Builtin Functions](#10-builtin-functions)): it shares the name with other declared functions, never with the builtin.

Nothing but functions shares a name. A global, `def`, `data` or import has its name to itself in its module, and a function cannot take the name of one, nor can a function or an import declared in a `test`:

```ents
global count: u32 = 0
global count: u64 = 0
def size = 4
func size() -> u32 => 4
```

```errors
'count' is already declared
'size' is already declared
```

A function or a global of another source module imported twice under one name is that one again, not a second declaration.

<!-- spec:end -->

#### Calling Conventions

A call names the function and gives its arguments in parentheses, by position: the first argument goes to the first parameter, and so on. Each argument is evaluated once, left to right, before the call. A call of a function with several results is one value, a tuple of them: bind its parts (`let q, r = divmod(17, 5)`, or by name `let (q:, r:) = ...`), keep it whole (`let d = divmod(9, 4)`, then `d.q`), or take one part (`divmod(7, 2).r`). It is not spread over the parameters of another call.

<!-- spec:begin compile -->

```ents
global trace: u32 = 0

func note(d: u32) -> u32 {
  trace = trace * 10 + d
  return d
}

func three(a: u32, b: u32, c: u32) -> u32 => a * 100 + b * 10 + c
func divmod(a: u32, b: u32) -> (q: u32, r: u32) => (a / b, a % b)

test "arguments are evaluated left to right" {
  assert three(note(1), note(2), note(3)) == 123
  assert trace == 123
}

test "several results are one value" {
  let q, r = divmod(17, 5)
  let d = divmod(9, 4)
  assert q * 10 + r == 32
  assert d.q * 10 + d.r == 21
  assert divmod(7, 2).r == 1
}
```

<!-- spec:end -->

<!-- spec:begin compile -->

A call names none of the parameters, also a call of a builtin (only a constructor's arguments can have names, [2.8](#struct-constructors)), and gives each one argument:

```ents
func sub(a: i32, b: i32) -> i32 => a - b
func divmod(a: u32, b: u32) -> (q: u32, r: u32) => (a / b, a % b)

func f() -> i32 => sub(b: 1, a: 2)
func g(x: f64) -> f64 => sqrt(v: x)
func h() -> u32 => three(divmod(7, 2))
func three(a: u32, b: u32) -> u32 => a + b
```

```errors
'sub' takes positional arguments
'sqrt' takes positional arguments
'three' expected 2 arguments, got 1
argument 1: cannot assign (q: u32, r: u32) to u32
```

<!-- spec:end -->

Any function can also be called as a method of its first argument: `xs.total()` is `total(xs)` ([4.9](#49-method-call-syntax)).

#### Function Types and Pointers

A function type is written `(A, B) -> R`: the parameter types in parentheses, `->`, the result. One parameter needs no parentheses (`i32 -> i32`), `-> ()` is no result, and names are allowed (`(x: i32) -> (r: i32)`). `->` groups to the right: `i32 -> i32 -> i32` is `i32 -> (i32 -> i32)`. A type operator written before a parameter takes the whole function type instead: `[]u8 -> ()` is a slice of functions, `[](u8 -> ())`, and `*u8 -> u32` a pointer to a function. So write the parameters of a function type in parentheses, `([]u8) -> ()`.

A function is given to another function at compile time, for a comptime function parameter: each function given makes a copy of the callee that calls it directly ([8.6](#86-comptime-function-parameters)).

<!-- spec:begin compile -->

```ents
func twice(comptime f: (u32) -> u32, x: u32) -> u32 => f(f(x))
func inc(x: u32) -> u32 => x + 1
func dbl(x: u32) -> u32 => x * 2

test "a function given at compile time" {
  assert twice(inc, 5) == 7
  assert twice(dbl, 5) == 20
}
```

<!-- spec:end -->

> **Not implemented: function values at run time.** A function has no run-time value: no variable, parameter, global, field or memory holds one, and nothing calls through one (an indirect call). Their design is under discussion. Calling a variable or a parameter of a function type is an error, and so is casting or comparing a function's name. Giving a function for a parameter that is not `comptime`, or storing one, is not refused by the compiler, and the module does not assemble (a known bug). A function type written for a global, a parameter or a field compiles to an `i32` that nothing can call.

<!-- spec:begin compile -->

```ents
func inc(x: i32) -> i32 => x + 1
func dec(x: i32) -> i32 => x - 1

func apply(f: (i32) -> i32, x: i32) -> i32 => f(x)
func address() -> u32 => inc as u32
func same() -> bool => inc == dec
```

```errors
calling a function value is not supported yet: only a function named directly, or a comptime function parameter (comptime f: (i32) -> i32), can be called
cannot cast func(x: i32) -> i32 to u32: 'inc' is a function, which has no run-time value yet
'==' cannot be applied to func(x: i32) -> i32 and func(x: i32) -> i32: 'inc' is a function, which has no run-time value yet
```

<!-- spec:end -->

### 3.5 Inline Functions

> **Not implemented:** `inline` is accepted and has no effect. An `inline func` is an ordinary function, and each call of it is a wasm `call`.

`inline` stands before `func` (and after `export`: `export inline func`). An inline function is meant to have its body put in at each call site, with each argument evaluated once into a local of the caller. A program behaves the same either way: inlining changes only its speed and size.

<!-- spec:begin compile -->

```ents
def prime32-1 = 2654435761:u32
def prime32-2 = 2246822519:u32

inline func round32(acc: u32, lane: u32) -> (acc: u32) {
  acc += lane * prime32-2
  acc <<<= 13
  acc *= prime32-1
}

test "an inline function is called as any function is" {
  assert round32(0, 0) == 0
  assert round32(1, 0) == 0xef362000
  assert round32(0, 1) == 0x8df8c7ad
}
```

<!-- spec:end -->

A `def` and an `inline func` differ in what they are:

| | `def` | `inline func` |
|---|---|---|
| What it is | a constant: one value | a function: parameters and a body |
| Checked | at each use, in the type the use wants | once, as any function |
| Arguments | none | each evaluated once |
| Locals and control flow | no | yes |
| In the output | its value, at each use | a function, called with `call` |

A value known when the program is compiled is a `def`; anything that computes from arguments is a function.

---

## 4. Expressions & Operators

An expression computes a value. Its forms are:

- a literal ([1.5](#15-literals)), and the name of a variable, a parameter, a global, a `def` or a `data` block;
- a call `f(a, b)` ([3.4](#34-functions)), a struct constructor `Point(1, 2)` ([2.8](#struct-constructors)), a tuple `(a, b)` or `(x: 1, y: 2)` ([2.7](#27-tuple-types));
- an `if` or a `match` that gives a value ([5.1](#51-conditionals), [5.4](#54-match-expressions)), which stands wherever a name could: `x + if c { 1 } else { 2 }`;
- `sizeof(T)`, the size of a type in bytes, a `u32` constant, and `sizeof data`, the address just past the program's data ([9.0](#90-data-layout));
- a cast `x as T` or `T(x)` and an annotation `x: T` ([2.10](#210-type-conversions));
- the operators of this chapter, and the postfix forms: a member `x.f`, an index `x[i]`, a range `x[a..b]`, a call and a method call `x.f(a)` ([4.4](#44-unary-operators)).

Assignment is a statement, not an expression: `x = v` gives no value ([4.5](#45-assignment-and-compound-assignment)).

#### Precedence

From the loosest binding to the tightest:

| Operators | Grouping | Note |
|-----------|----------|------|
| `??` | does not chain | the left side is a postfix expression ([The `??` Operator](#the--operator)) |
| `\|\|` | left to right | |
| `&&` | left to right | |
| `!` (prefix) | | negates a whole comparison: `!x > 3` is `!(x > 3)` |
| `==` `!=` `<` `>` `<=` `>=` | left to right | `a < b < c` compares the bool `a < b` with `c`, an error |
| `\|` | left to right | |
| `^` | left to right | |
| `&` | left to right | |
| `<<` `>>` `<<<` `>>>` | left to right | |
| `+` `-` | left to right | |
| `*` `/` `%` | left to right | |
| `-` `~` `&` `mut` (prefix) | right to left: `-~x` is `-(~x)` | |
| `x as T`, `x: T` | one per operand | `1 as u8 as u16` is a syntax error: `(1 as u8) as u16` |
| `.f` `.0` `.*` `.u32` `[i]` `[a..b]` `(args)` (postfix) | left to right | |

Where this differs from C:

- The bitwise operators bind tighter than the comparisons: `x & 1 == 0` is `(x & 1) == 0`.
- `!` binds looser than a comparison, and takes a bool: `!a == b` is `!(a == b)`.
- A cast binds tighter than every prefix operator: `-x as i32` is `-(x as i32)`, and `&p[1] as [*]u8` is `&(p[1] as [*]u8)`; write `(&p[1]) as [*]u8` for the address cast.
- `??` binds loosest of all: `xs[i] ?? 0 == 0` is `xs[i] ?? (0 == 0)`; write `(xs[i] ?? 0) == 0`.
- `-` written before a number is part of the number: `-128:i8` is one constant, and `-1 as u32` is the constant 4294967295.

<!-- spec:begin compile -->

```ents
func even(x: u32) -> bool => x & 1 == 0           // (x & 1) == 0
func small(x: u32) -> bool => !x > 3              // !(x > 3)
func shift() -> u32 => 1 << 2 + 3                 // 1 << 5
func either(a: bool, b: bool, c: bool) -> bool => a || b && c
func flip(x: u32) -> i32 => -x as i32             // -(x as i32)
func step(c: bool, x: u32) -> u32 => x + if c { 1 } else { 10 }

test "precedence" {
  assert even(6) && !even(7)
  assert small(2) && !small(4)
  assert shift() == 32
  assert either(true, false, false)
  assert flip(5) == -5
  assert step(false, 5) == 15
}
```

```ents
func between(a: u32, b: u32, c: u32) -> bool => a < b < c
```

```errors
'<' cannot be applied to bool: cast it to an integer first
```

<!-- spec:end -->

#### Evaluation Order

An expression is evaluated left to right, and each of its parts exactly once: the left operand of an operator before the right one, whatever the precedence of the operators around them, and the arguments of a call in the order written (the receiver of a method call first, [4.9](#49-method-call-syntax), and named arguments in the order written too, [2.8](#struct-constructors)). Every operand is computed before its operator applies. Only these evaluate a part when it is needed and not otherwise: `&&` and `||` their right side, `??` its fallback, and `if` and `match` the branch they take. An assignment computes the address of its target first, then the value, then stores it ([4.5](#45-assignment-and-compound-assignment)).

<!-- spec:begin compile -->

```ents
data trail = mut [0:u32; 8]
global count: u32 = 0

func note(v: u32) -> u32 {
  trail[count & 7] = v
  count += 1
  return v
}
func pair(a: u32, b: u32) -> u32 => a * 10 + b
func seen() -> u32 => trail[0] * 1000 + trail[1] * 100 + trail[2] * 10 + trail[3]

test "operands and arguments are evaluated left to right, once" {
  assert note(1) + note(2) * pair(note(3), note(4)) == 69    // 1 + 2 * 34
  assert seen() == 1234                                       // in the order written
  assert !(note(0) == 1 && note(9) == 9)                      // note(9) is not called
  assert count == 5
}
```

<!-- spec:end -->

A trailing comma is accepted after the last element of an array literal (`[1, 2,]`), the last variant of an enum and a `match` arm. Anywhere else it is a syntax error: in the arguments of a call or a constructor, a tuple, a parameter list, a struct type's fields and a pattern.

### 4.1 Arithmetic Operators

| Operator | Description | Types |
|----------|-------------|-------|
| `+` | addition | numbers |
| `-` | subtraction | numbers |
| `*` | multiplication | numbers |
| `/` | division | numbers |
| `%` | remainder | integers |

The two operands have one type, after [implicit widening](#implicit-widening), and that is the type of the result: a `u8` and a `u32` add as `u32`s, an `i32` and an `f64` as `f64`s. Types neither of which holds the other, such as `i32` and `u32`, need a cast (`mismatched operands for '+': i32 and u32 (cast one side explicitly)`). A constant takes the type of the other operand, and has to fit it: `x + 1` with a `u8` `x` is a `u8` addition. An operation on constants alone is computed exactly when the program is compiled, with no width to wrap in ([Comptime Literal Promotion](#comptime-literal-promotion)): `0xFFFFFFFF + 1` is 4294967296, which is an error where a `u32` is wanted. A `bool` takes no arithmetic (`'+' cannot be applied to bool: cast it to an integer first`), and a pointer takes `+` and `-` of an integer ([4.6](#46-pointer-operations)).

**Integers wrap.** `+`, `-` and `*` on integers never trap: the result is reduced to the width of its type, in two's complement, as wasm's `i32.add` and `i64.mul` do. An `i8`, `u8`, `i16` or `u16` is computed in an `i32` and brought back to its width after each operation ([2.2](#22-primitive-types)): `200:u8 + 100` is 44, `100:i8 + 100` is -56. Negation is `0 - x`, so it is allowed on an unsigned type and wraps too: `-x` with a `u32` of 1 is 4294967295.

**Division.** `/` and `%` are signed or unsigned as the operands' type is (`i32.div_s` or `i32.div_u`, `i32.rem_s` or `i32.rem_u`). Integer division truncates toward zero, and the remainder has the sign of the dividend: `-7 / 2` is -3, `-7 % 2` is -1, `7 % -2` is 1. These trap ([9.7](#97-traps)):

- an integer `/` or `%` by zero;
- an `i32` or `i64` `/` of its most negative value by -1, whose quotient does not fit (`%` of the same is 0).

An `i8` or `i16` is divided in 32 bits, so `-128:i8 / -1` does not trap: it is 128, wrapped back to -128. A divisor that is the constant 0 is not caught when the program is compiled: `x / 0` compiles to a division that traps when it runs.

**Floats** follow IEEE 754, as wasm's `f64.div` does, and never trap: `1.0 / 0.0` is infinity and `0.0 / 0.0` is NaN. `%` takes integers only (`'%' needs integer operands, not f64`).

**Wide integers** (`i128` and up) take `+`, `-` and `*`, which wrap as any integer does; `/` and `%` on them are not supported yet (`'/' on u128 is not supported yet`).

<!-- spec:begin compile -->

```ents
func add8(a: u8, b: u8) -> u8 => a + b
func neg(x: u32) -> u32 => -x
func quot(a: i32, b: i32) -> i32 => a / b
func rem(a: i32, b: i32) -> i32 => a % b
func half(n: u32) -> u32 => n / 2
func ratio(a: f64, b: f64) -> f64 => a / b

test "integers wrap, division truncates toward zero" {
  assert add8(200, 100) == 44
  assert neg(1) == 0xFFFFFFFF
  assert quot(-7, 2) == -3
  assert rem(-7, 2) == -1
  assert rem(7, -2) == 1
  assert rem(-2147483648, -1) == 0
  assert half(0xFFFFFFFF) == 0x7FFFFFFF        // unsigned division
  assert ratio(1.0, 0.0) > 1.0e308             // infinity
  let nan = ratio(0.0, 0.0)
  assert nan != nan
}
```

```ents
func mixed(a: i32, b: u32) -> i32 => a + b
func both(a: bool, b: bool) -> bool => a + b
func frac(x: f64) -> f64 => x % 1.0
```

```errors
mismatched operands for '+': i32 and u32 (cast one side explicitly)
'+' cannot be applied to bool: cast it to an integer first
'%' needs integer operands, not f64
```

<!-- spec:end -->

> **Not implemented: saturating arithmetic.** `+|`, `-|` and `*|` (and `+|=`, `-|=`, `*|=`) are meant to clamp at the bounds of the type instead of wrapping: `250:u8 +| 10` is to be 255, and `3:u8 -| 5` 0. The parser accepts them, but the compiler computes them as the wrapping `+`, `-` and `*` (a known bug), so a program must not use them yet. On a wide integer they are an error (`'+|' on u128 is not supported yet`). They bind as `+` and `*` do.

### 4.2 Bitwise Operators

| Operator | Description | Types |
|----------|-------------|-------|
| `&` | bitwise AND | integers, bools |
| `\|` | bitwise OR | integers, bools |
| `^` | bitwise XOR | integers, bools |
| `<<` | shift left | integers |
| `>>` | shift right | integers |
| `<<<` | rotate left | integers |
| `>>>` | rotate right | integers |

`&`, `|` and `^` take two integers of one type after widening, as arithmetic does, or two bools; on bools they evaluate both sides, where `&&` and `||` may skip the right one. A float is no operand (`'&' needs integer operands, not f64`). `>>` keeps the sign of a signed value (`i32.shr_s`) and shifts zeros into an unsigned one (`i32.shr_u`).

`~` of a constant is a bit pattern in the type it's used as, so it fits an unsigned type that holds its operand: `~7` is `0xfffffff8` as a `u32`. A negative constant doesn't: `x & -8` needs a signed `x` (`cannot assign int(-8) to u32`).

The count of a shift or rotate can be any integer type: it doesn't have to match the value, and only its low bits are used: the count modulo the width the value is shifted in, which is 32 bits for a value of 32 bits or fewer and the value's own width otherwise. So `x << 32` on a `u32` is `x`, and on a `u8` too, while `x << 8` on a `u8` is 0. The result has the value's type. If the count's type is wider than the value's, a shift widens the value to that width first, keeping its sign: with a `u8` value and a `u32` count, `x << n` is a `u32`. A constant value has no type of its own and takes the count's: `1 << n` with a `u8` count is a `u8`, so give the `1` a type (`1:u32 << n`) when the result should be wider.

A rotation is always within the value's own width, whatever the count's type: `x <<< 1` on a `u8` moves its top bit to the bottom.

<!-- spec:begin compile -->

```ents
func align(n: u32) -> u32 => (n + 7) & ~7      // round up to a multiple of 8
func low_byte(x: u64) -> u64 => x & ~(~0 << 8)
func halve(x: i32) -> i32 => x >> 1            // keeps the sign
func spread(b: u8, n: u32) -> u32 => b << n    // shifted as a u32: the count is wider
func bit(n: u8) -> u8 => 1 << n                // the 1 takes the count's type
func rotr(x: u32, n: u32) -> u32 => x >>> n
func swap_nibbles(b: u8) -> u8 => b <<< 4

test "bits" {
  assert align(9) == 16
  assert low_byte(0x1234) == 0x34
  assert halve(-8) == -4
  assert spread(0x80, 4) == 0x800
  assert bit(7) == 128
  assert bit(8) == 0
  assert rotr(1, 1) == 0x80000000
  assert swap_nibbles(0x12) == 0x21
}
```

```ents
func mask(x: u32) -> u32 => x & -8
```

```errors
cannot assign int(-8) to u32
```

<!-- spec:end -->

### 4.3 Comparison Operators

| Operator | Description |
|----------|-------------|
| `<` | less than |
| `>` | greater than |
| `<=` | less or equal |
| `>=` | greater or equal |
| `==` | equal |
| `!=` | not equal |

A comparison gives a `bool`. What it compares:

- **Numbers**, of one type after widening, as for arithmetic: an `i32` and a `u32` need a cast. Signed types compare signed (`i32.lt_s`) and unsigned ones unsigned (`i32.lt_u`). Floats compare as IEEE 754 says: NaN is unequal to everything, itself included, so `x != x` is true only for a NaN. Wide integers compare with all six.
- **Bools**, with `==` and `!=` only (`'<' cannot be applied to bool: cast it to an integer first`).
- **Pointers**, with all six, as unsigned addresses. A pointer compares with any other pointer and with an integer of at most 32 bits. An optional pointer compares too, and `p == 0` asks whether it is none ([Optional Types](#optional-types)).
- **Optional slices and optional host references**, only with the literal `0`, by `==` and `!=` ([Optional Types](#optional-types), [2.13](#213-host-references)).

Nothing else compares: a struct, a tuple, a slice or an array is no operand (`'==' cannot be applied to Point and Point`). Compare them part by part: the fields, or the lengths and then the elements.

Comparisons group left to right but do not chain: `a < b < c` compares the bool `a < b` with `c`, which is an error, and `a == b == c` compares `a == b` with a bool `c`. Write `a < b && b < c`.

`&&` and `||` take two bools and evaluate the right side only when it decides the result. `!` takes a bool (`operand of '!' must be bool, not u32`); it binds looser than a comparison, so `!x == y` is `!(x == y)`.

<!-- spec:begin compile -->

```ents
type Point = (x: i32, y: i32)

func same(p: Point, q: Point) -> bool => p.x == q.x && p.y == q.y
func below(a: i32, b: i32) -> bool => a < b
func below_u(a: u32, b: u32) -> bool => a < b
func inside(lo: u32, x: u32, hi: u32) -> bool => lo <= x && x < hi
func is_nan(x: f64) -> bool => x != x
func before(p: [*]u8, q: [*]u8) -> bool => p < q

test "comparisons" {
  assert same(Point(1, 2), Point(1, 2))
  assert below(-1, 0)
  assert !below_u(0xFFFFFFFF, 0)
  assert inside(2, 3, 4)
  assert is_nan(0.0 / 0.0)
  assert before(8 as [*]u8, 0x80000000 as [*]u8)       // unsigned addresses
}
```

```ents
type Point = (x: i32, y: i32)

func same(p: Point, q: Point) -> bool => p == q
func equal(s: []u8, t: []u8) -> bool => s == t
func less(a: bool, b: bool) -> bool => a < b
func zero(x: u32) -> bool => !x
```

```errors
'==' cannot be applied to Point and Point
'==' cannot be applied to []u8 and []u8
'<' cannot be applied to bool: cast it to an integer first
operand of '!' must be bool, not u32
```

<!-- spec:end -->

### 4.4 Unary Operators

The prefix operators:

| Operator | Meaning | Operand | See |
|----------|---------|---------|-----|
| `-x` | negation | a number; before a number literal it is part of the literal | [4.1](#41-arithmetic-operators) |
| `~x` | bitwise NOT | an integer | [4.2](#42-bitwise-operators) |
| `!x` | logical NOT, binding looser than comparisons | a bool | [4.3](#43-comparison-operators) |
| `&x` | the address of a literal, an element or a value in memory | | [Element Addresses and Writes](#element-addresses-and-writes) |
| `mut x` | a writable literal of its own | a literal | [The `mut` Keyword on Literals](#the-mut-keyword-on-literals) |

The postfix forms, which bind tightest and apply left to right:

| Form | Meaning | See |
|------|---------|-----|
| `x.name`, `x.0` | a field of a struct or tuple, also through a pointer to one | [2.7](#27-tuple-types), [2.8](#struct-field-access) |
| `p.*` | the value a `*T` points to | [2.5](#25-pointer-types) |
| `s.len`, `s.ptr`, `s.wid` | the length, the pointer and the element width of a slice or array pointer | [2.5](#25-pointer-types), [2.6](#26-slices) |
| `p.u32` | memory at `p` seen as a `[*]u32` | [Type-Punned Memory Access](#type-punned-memory-access) |
| `x[i]` | an element | [4.7](#47-bounds-checked-indexing) |
| `x[a..b]` | a range of elements, as a slice | [4.8](#48-slicerange-syntax) |
| `f(a, b)` | a call | [3.4](#34-functions) |
| `x.f(a, b)` | a method call, `f(x, a, b)` | [4.9](#49-method-call-syntax) |

<!-- spec:begin compile -->

```ents
func flag(b: bool) -> bool => -b
func invert(x: f64) -> f64 => ~x
```

```errors
'-' needs a number, not bool
'~' needs an integer, not f64
```

`mut` before anything but a literal is a syntax error:

```ents
func cell(x: u32) -> u32 {
  let p = mut x
  return 0
}
```

```errors
mut goes before a literal (an array, a string or a tuple), not before x
```

<!-- spec:end -->

### 4.5 Assignment and Compound Assignment

`target = value` stores a value. The target is a name followed by any number of suffixes, each a field `.x`, a tuple element `.0`, a dereference `.*`, an index `[i]`, a range `[a..b]` or a type view `.u32`:

| Target | What is written |
|--------|-----------------|
| `x` | a variable: a local, a parameter, a named result or a global |
| `p.x`, `t.0` | a field of a struct or tuple variable, or of the struct a pointer points to |
| `p.*` | the value a `*mut T` points to |
| `xs[i]` | an element, at an index known to be in range ([Element Addresses and Writes](#element-addresses-and-writes)) |
| `xs[a..b]` | every element of a range: a fill or a copy ([Filling and Copying](#filling-and-copying)) |
| `p.u32[i]` | an element of a type view ([Type-Punned Memory Access](#type-punned-memory-access)) |

A name alone has to be a variable: a `def`, a `data` block and a function are not (`cannot assign to 'buf': it is not a variable`), and neither is a global imported from the host, which is read-only. With a suffix the name can be anything that leads to a place, so `buf[0] = 1` writes into a `data` block. Writing through a pointer needs a `*mut` one ([Mutability](#mutability)): `cannot write through const pointer — use *mut for mutable access`. Anything else is not a target, and is a syntax error: the result of a call (`get()[1] = 5`), an expression in parentheses (`(p.*).x = 5`) and several variables (`(a, b) = v`, which is written `set (a, b) = v`, below). Name a call's result first: `let p = get()`, then `p[1] = 5`.

The value is checked against the target's type, as a `let` with that type checks it: a constant takes the type, and a narrower number widens to it.

<!-- spec:begin compile -->

```ents
type Point = (x: i32, y: i32)

data cells = mut [0:u32; 4]
global total: u64 = 0

func cell() -> *mut [4]u32 => cells

func fill(p: Point, n: u32) -> i32 {
  p.x = 5                       // a field of a variable
  let c = cell()
  c[1] = n                      // through the pointer a call gave
  cells[3] = 7                  // into a data block
  total = n                     // n widens to u64
  return p.x + p.y
}

test "assignment" {
  assert fill(Point(1, 2), 9) == 7
  assert cells[1] == 9 && cells[3] == 7
  assert total == 9
}
```

```ents
data cells = mut [0:u32; 4]

func cell() -> *mut [4]u32 => cells
func f() { cell()[1] = 5 }
```

```errors
Expected "}"
```

```ents
type Point = (x: i32, y: i32)
def limit = 10
data buf = mut [0:u8; 4]

func f(p: *Point) {
  p.x = 1
  buf = buf
  limit = 3
}
```

```errors
cannot write through const pointer — use *mut for mutable access
cannot assign to 'buf': it is not a variable
cannot assign to 'limit': it is not a variable
```

<!-- spec:end -->

An assignment reads its whole value before it writes any of it, so a value can be rebuilt from itself, in a variable or in memory:

<!-- spec:begin compile -->

```ents
type Point = (x: i32, y: i32)

data spot = mut [Point(1, 2)]

func flip(p: Point, q: *mut Point) -> Point {
  p = Point(p.y, p.x)          // swaps the fields
  q.* = Point(q.y, q.x)        // and so does this, in memory
  return p
}

test "the value is read before it is written" {
  let p = flip(Point(3, 4), &spot[0])
  assert p.x == 4 && p.y == 3
  assert spot[0].x == 2 && spot[0].y == 1
}
```

<!-- spec:end -->

The same holds for a struct, tuple or slice copied over a place that partly overlaps the one it is read from, and for a value that writes on its way: after `q.* = Point(1, if c { q.x = 9 ... })`, `q.x` is 1. A wide integer (`i128` and up) is one scalar, stored limb by limb from the lowest, so it must not partly overlap its source.

The target's address is evaluated once, and before the value, also for a compound assignment: `xs[next()] += 1` calls `next` one time, and `p.* = if c { p = q ... }` writes where `p` pointed before.

#### Assigning Several Variables

`set` assigns to variables that exist, through a pattern, as `let` declares new ones ([3.3](#33-variables)). The parts of the pattern are positional, `set (q, r) = divmod(17, 5)`, or by field name, `set (x: a, y: b) = p`, with `set (x:, y:) = p` short for `set (x: x, y: y) = p`; a part can be a pattern itself, `set (low, (high, wide)) = ...`. Without parentheses, `set q, r = v` is the positional form. `set x = v` with a single name is `x = v`. A tuple, a struct and the several results of a call can be taken apart; a slice cannot (`cannot destructure non-tuple type in set: []u8`: read its `.ptr` and `.len`), and neither can a pointer (take apart `p.*`).

The whole value is computed before any variable is set, so `set a, b = (b, a)` swaps two variables.

<!-- spec:begin compile -->

```ents
type Point = (x: f64, y: f64)

func divmod(a: u32, b: u32) -> (u32, u32) => (a / b, a % b)

func digits(n: u32) -> u32 {
  let q: u32 = 0
  let r: u32 = 0
  set q, r = divmod(n, 10)
  return q + r
}

func swapped(a: u32, b: u32) -> u32 {
  set a, b = (b, a)
  return a * 10 + b
}

func spread(p: Point) -> f64 {
  let x: f64 = 0
  let low: f64 = 0
  let high: f64 = 0
  set (x:, y: low) = p          // x = p.x, low = p.y
  set (low, high) = (low - 1.0, high + 1.0)
  return x + low + high
}

test "set takes a value apart into existing variables" {
  assert digits(42) == 6
  assert swapped(1, 2) == 21
  assert spread(Point(5.0, 2.0)) == 7.0
}
```

<!-- spec:end -->

`set` assigns what `=` would: a tuple literal, or an `if` or `match` whose branches give one, is checked against the types of the variables it sets, as a `let` with those types would check it. Each constant takes its variable's type and each value widens to it:

<!-- spec:begin compile -->

```ents
func parts(n: i32) -> f64 {
  let wide: i64 = 0
  let ratio: f32 = 0
  let mean: f64 = 0
  let (low, high) = (0, 0)
  set (wide, ratio, mean) = (5000000000, 1, n)   // an i64, an f32 and n widened to an f64
  set (low, (high, wide)) = (1, (2, 3))
  return mean + ((low + high) as f64)
}

test "set checks a literal against its variables" {
  assert parts(4) == 7.0
}
```

<!-- spec:end -->

Any other value is already computed, in its own types, and each field has to be held the way its variable is: nothing widens it on the way. A named part names a field the value has, and every variable has to exist:

<!-- spec:begin compile -->

```ents
type Point = (x: f64, y: f64)

func pair() -> (i32, f32) => (1, 2.0)

func f(p: Point) {
  let wide: i64 = 0
  let ratio: f32 = 0
  set (wide, ratio) = pair()
  set (z: ratio) = p
  set sum = 1
}
```

```errors
cannot set 'wide' (i64) from a field of type i32
field 'z' not found in Point
cannot set 'sum': not defined (use 'let' to create a new binding)
```

<!-- spec:end -->

A pattern with more parts than the value has fields is an error (for a `let`, `tuple has 2 fields, but pattern has 3`). A pattern with fewer parts sets the first fields and leaves the rest.

#### Compound Assignment

Compound assignment combines an operation with assignment, on any target:

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
| `x <<<= n` | `x = x <<< n` |
| `x >>>= n` | `x = x >>> n` |

The target is evaluated once, so `xs[next()] += 1` calls `next` one time. The result goes back into `x`, so `n` widens to the type of `x`, never the other way: with `total: u32` and `small: u8`, `total += small` is fine and `small += total` is an error (`cannot assign u32 to u8`): write `small += total as u8`. A shift count (`x <<= n`) can be any integer type. A pointer takes `+=` and `-=` of a byte count ([4.6](#46-pointer-operations)). `+|=`, `-|=` and `*|=` are the saturating operators, which are not implemented ([4.1](#41-arithmetic-operators)).

The result has to fit a range `x`'s type carries ([Ranged Integers](#ranged-integers)), as in the plain `x = x op n`: with `let i = k & 15` (a `u32#16`), `i &= 7`, `i >>= 1` and `i %= 9` keep it, while `i += 1`, `i -= 1`, `i <<= 1` and `i *= 3` are errors (`cannot assign u32#17 to u32#16 (the result of '+=')`), since `buf[i]` on a `*[16]u8` is proven by the range. Only a constant `n` gives the result a range; to step a ranged index, bring it back into range (`i = (i + 1) & 15`) or keep it in a plain `u32`.

<!-- spec:begin compile -->

```ents
data counts = mut [0:u32; 16]
global calls: u32 = 0

func slot(k: u32) -> u32#16 {
  calls += 1
  return k & 15
}

func tally(k: u32, n: u8) {
  counts[slot(k)] += n          // slot is called once; n widens to u32
}

func mix(h: u32, b: u8) -> u32 {
  h ^= b
  h *= 16777619
  h <<<= 5
  return h
}

test "compound assignment" {
  tally(17, 3)
  tally(1, 4)
  assert counts[1] == 7
  assert calls == 2
  assert mix(0, 1) == 0x20003260
}
```

```ents
func f(small: u8, total: u32, k: u32) {
  small += total
  let i = k & 15
  i += 1
}
```

```errors
cannot assign u32 to u8
cannot assign u32#17 to u32#16 (the result of '+=')
```

<!-- spec:end -->

### 4.6 Pointer Operations

#### Arithmetic

`p + n` and `p - n`, with `p` a many-pointer `[*]T` and `n` an integer of at most 32 bits, move `p` by `n` **bytes**, not elements, and give a `[*]T` again; `p += n` and `p -= n` move a pointer variable. To step by elements, multiply by the element width (`p + i * p.wid`), or take an element's address with `&p[i]` ([Element Addresses and Writes](#element-addresses-and-writes)). The distance between two pointers in bytes is the difference of their addresses: `(q as u32) - (p as u32)`. Pointers compare as unsigned addresses ([4.3](#43-comparison-operators)), which is how a loop walks one to an end:

<!-- spec:begin compile -->

```ents
data words = [10:u32, 20, 30, 40]

func sum(p: [*]u32, n: u32) -> u32 {
  let total: u32 = 0
  let end = p + n * p.wid
  while p < end {
    total += p[0]
    p += p.wid                  // 4 bytes on: the next u32
  }
  return total
}

func gap(p: [*]u32, q: [*]u32) -> u32 => (q as u32) - (p as u32)

test "pointer arithmetic counts bytes" {
  assert sum(words, 4) == 100
  assert sum((words as [*]u32) + 8, 2) == 70
  assert gap(words, (words as [*]u32) + 12) == 12
}
```

```ents
func skip(s: []u8) -> []u8 => s + 1
func next(p: ?*u8) -> ?*u8 => p + 1
```

```errors
'+' cannot be applied to []u8 and int(1)
cannot use '+' on ?*u8: it may be none — resolve it with 'if let' or '??' first
```

<!-- spec:end -->

A slice takes no arithmetic: take a range of it instead (`s[1..]`, [4.8](#48-slicerange-syntax)). An optional pointer is resolved first. Write the pointer first: `n + p` is not a pointer.

> **Known bug: pointer arithmetic is not checked to these rules.** The compiler also accepts `+` and `-` on a `*T` and a `*[N]T` (where `p + 4` on a `*[4]u32` still claims four elements, with nothing checked), any other operator on a pointer (`p * 2`, `p & 7`, `p + q`), and gives `p - q` the pointer's type instead of a number. Write only the forms above.

#### Indexing

`p[i]` on a many-pointer `[*]T` is the element `i` places on: the byte offset is `i * sizeof(T)`, so `ptr + n` counts bytes where `ptr[n]` counts elements. A many-pointer has no length, so its index is never checked ([4.7](#47-bounds-checked-indexing)), and `p[-1]` is the element before the one `p` points to.

A `*T` points to one `T`: `p[0]` is that `T`, as `p.*` is, and any other index is an error (`cannot index *u8 past its one element: read it with .*, or index a [*]u8`). A pointer to elements read one after another is a `[*]T`; on a `[*]T`, read the first element as `p[0]`.

`.*` loads what a pointer of known size points at: the `T` of a `*T`, and all N elements of a `*[N]T` as a `[N]T` value. A slice, a many-pointer `[*]T` and a null-terminated `*[!]T` have no whole value to load: index them (`p[0]`). The compiler accepts `.*` on a `[*]T` or a `*[!]T` and compiles it wrongly, loading four bytes and using them as an address (a known bug), so do not write it.

An array pointer, a slice and their elements are indexed with a bounds check where the index is not known to be in range: [4.7](#47-bounds-checked-indexing).

<!-- spec:begin compile -->

```ents
data nums = [10:i32, 20, 30, 40]

func third(p: [*]i32) -> i32 => p[2]          // 8 bytes on
func before(p: [*]i32) -> i32 => p[-1]
func first(p: *i32) -> i32 => p[0]            // the same as p.*

test "a many-pointer indexes by elements" {
  assert third(nums) == 30
  assert third((nums as [*]i32) + 4) == 40
  assert before((nums as [*]i32) + 8) == 20
  assert first(&nums[1]) == 20
}
```

```ents
func second(p: *i32) -> i32 => p[1]
```

```errors
cannot index *i32 past its one element: read it with .*, or index a [*]i32
```

<!-- spec:end -->

#### Type-Punned Memory Access

A type view reads and writes memory as a primitive type other than the one it holds. `p.T`, where `T` is the name of a primitive type (an integer type, `f32`, `f64` or `bool`), is `p` seen as a `[*]T`, or as a `[*]mut T` when `p` is a mutable pointer. So `p.u32[i]` is the `i`-th 32-bit word from `p` (bytes `4 * i` to `4 * i + 3`, little-endian), and `p.u32[i] = v` writes one. `p` is any pointer: a `*T`, a `*[N]T`, a `[*]T`. Like every many-pointer index, a view's index is never checked: it is the explicit way to read memory without a bounds check, where `p[i]` on an array pointer is checked.

<!-- spec:begin compile -->

```ents
data block = mut [1:u8, 2, 3, 4, 5, 6, 7, 8]

func word(i: u32) -> u32 => block.u32[i]      // bytes 4i to 4i + 3
func set_word(i: u32, v: u32) { block.u32[i] = v }
func half(p: [*]u8, i: u32) -> u16 => p.u16[i]
func low(x: *u64) -> u32 => x.u32[0]

test "a view reads memory as another primitive type" {
  assert word(1) == 0x08070605                 // little-endian
  set_word(0, 0x0A0B0C0D)
  assert block[0] == 0x0D
  assert half(block, 1) == 0x0A0B
  assert low(&0x1122334455667788) == 0x55667788
}
```

<!-- spec:end -->

Write a view on a pointer. On a slice, write it on the slice's pointer, `s.ptr.u16[i]`, and keep the bytes read within `s.len`: a view written directly on a slice, on an array held in registers or on a number is accepted by the checker but compiles wrongly (a known bug), so it must not be used.

> **Not implemented:** a view as the single value at `p`. `p.u32` is the pointer, not the `u32` it points at, so assigning to it is an error (`cannot assign to .u32: it is the pointer as [*]mut u32, not the u32 it points at — write .u32[0] = value to store one`): read `p.u32[0]` and write `p.u32[0] = v`. Views of a compound type (a struct, a slice) are not implemented either and do not parse; cast the pointer instead (`p as *Point`, [Explicit Casts](#explicit-casts)).

A member is a type view only when its whole name is a primitive type's. The name after the dot is a whole identifier, hyphens included ([1.2](#12-identifiers)), so a name that merely starts like one, `s.boolish`, `p.i8_le`, `v.u32s()`, `x.u32-count`, `p.u32-1`, is a field or a method ([4.9](#49-method-call-syntax)). The view minus one is written with spaces, `p.u32 - 1`, which is how the formatter prints a subtraction. Without a member of that name the error shows the subtraction:

<!-- spec:begin compile -->

```ents
func f(p: *u8) {
  let q = p.u32-1
}
```

```errors
no field 'u32-1' on type *u8: for a subtraction write `p.u32 - 1`
```

<!-- spec:end -->

### 4.7 Bounds-Checked Indexing

An index is an integer of at most 32 bits, signed or not (`an index must be an integer of at most 32 bits, not i64`); a constant bit pattern is the `u32` it stands for (`~4294967293` is 2, [4.2](#42-bitwise-operators)). It is an offset into 32-bit memory, read as an unsigned number, so a negative one is past any length: `xs[i] ?? 0` with `i: i32` equal to `-1` is `0`, and a negative constant index into a `*[N]T` is an error. A many-pointer checks nothing, and there `p[-1]` is the element before the one `p` points to.

Whether an index into an array pointer or a slice is checked depends on what is known about it when the program is compiled.

**A proven index** needs no check. A constant index into a `*[N]T` is checked against `N` when the program is compiled, and so is a ranged index (`u32#4`, [Ranged Integers](#ranged-integers)), whose type says it is below its bound:

<!-- spec:begin compile -->

```ents
data table = [10, 20, 30, 40]               // *[4]i32

func ends() -> i32 => table[0] + table[3]   // 0 and 3 are below 4
func pick(i: u32#4) -> i32 => table[i]      // so is any u32#4

test "a proven index is read directly" {
  assert ends() == 50
  assert pick(2) == 30
}
```

```ents
data table = [10, 20, 30, 40]

func past() -> i32 => table[4]
func wide(i: u32#5) -> i32 => table[i]
```

```errors
index 4 out of bounds for *[4]i32
index type u32#5 may exceed *[4]i32 bounds
```

<!-- spec:end -->

A slice's length is only known at run time, so a constant index into a slice is checked like any run-time one: `s[0] ?? 0`, or `if let`. A ranged index whose range may pass `N` proves nothing, and is checked like any run-time index: its element is an optional where it can be one, and `if let` or `??` resolves it; anywhere else it is an error.

**A run-time index** is checked when the program runs. Where the element is a pointer or a slice, the element read is an optional, none when the index is out of range (the row pointers of a table are the exception, see [Nesting](#nesting)): `names[i]` on a `[][]u8` is a `?[]u8`. `??` gives a fallback for none, and `if let` branches on it:

<!-- spec:begin compile -->

```ents
data names: [][]u8 = ["Alice", "Bob", "Charlie"]

func name(i: u32) -> []u8 => names[i] ?? "Unknown"

func initial(i: u32) -> u8 {
  if let n = names[i] {         // n is a []u8 here: i was in range
    return n[0] ?? '?'
  }
  return '-'
}

test "a run-time index is resolved with ?? or if let" {
  assert name(1).len == 3
  assert name(7).len == 7
  assert initial(2) == 'C'
  assert initial(3) == '-'
}
```

<!-- spec:end -->

**Primitive element types** have no optional form (no value of a `u8` or an `i32` is left over to mean none), so a run-time index into an array of numbers is resolved where it is written, by `??` or `if let`:

<!-- spec:begin compile -->

```ents
data values = [1, 2, 3, 4]

func get(i: u32) -> i32 => values[i] ?? 0
func twice(i: u32) -> i32 {
  if let v = values[i] {
    return v * 2
  }
  return -1
}

test "an element of numbers is resolved on the spot" {
  assert get(3) == 4
  assert get(4) == 0
  assert twice(1) == 4
  assert twice(-1 as u32) == -1
}
```

```ents
data values = [1, 2, 3, 4]

func get(i: u32) -> i32 => values[i]
```

```errors
runtime index on *[4]i32 requires 'if let' or '??' (no optional type for i32)
```

<!-- spec:end -->

An optional element can be kept and resolved later. The index is checked where the element is read, which gives the element or none (0); `??` or `if let` tests that where it resolves it. An optional is never read through before it is resolved ([Optional Types](#optional-types)): `names[i][0]` and `names[i].len` are errors, `(names[i] ?? "").len` is not. The slice that `??` gives has a run-time length of its own, so an index into it is resolved again:

<!-- spec:begin compile -->

```ents
data names: [][]u8 = ["ab", "cde"]

func first(i: u32) -> u8 => (names[i] ?? "")[0] ?? 0

func size(i: u32) -> u32 {
  let held = names[i]           // a ?[]u8
  let n = held ?? "none"
  return n.len
}

test "a slice that ?? gives is indexed like any slice" {
  assert first(1) == 99
  assert first(5) == 0
  assert size(0) == 2
  assert size(9) == 4
}
```

```ents
data names: [][]u8 = ["ab", "cde"]

func first(i: u32) -> u8 => (names[i] ?? "")[0]
func size(i: u32) -> u32 => names[i].len
```

```errors
index 0 on []u8 requires 'if let' or '??': a slice's length is only known at run time (no optional type for u8)
cannot use .len on ?[]u8: it may be none — resolve it with 'if let' or '??' first
```

<!-- spec:end -->

When the elements are optionals themselves (`[]?*T`), the element of an index that isn't proven is that optional, none when the index is out of range, and `if let` and `??` check both the index and the element. An array value of optionals (`[3]?*T`, held in registers or as a field of a struct in memory, `t.a[1]`) is indexed only by a constant in range, so there they check the element.

#### The `??` Operator

`a ?? b` is the value of `a`, an optional or an index or range that is checked at run time, when it has one, and `b` otherwise: a fallback for an optional pointer, slice or host reference that is none, or for an index or range out of bounds. `b` is evaluated only when it is needed. The result is the plain, non-optional type, and `b` has to be a value of it.

`??` binds more loosely than every other operator, and its left side is a postfix expression: a name, a call, an index, a range, a member, or anything in parentheses. So `xs[i] ?? 0 + 1` is `xs[i] ?? (0 + 1)`, and an operator on the left needs parentheses: `(xs[i] ?? 0) == 0`. It does not chain: `a ?? b ?? c` is a syntax error. To try one value after another, group to the right: in `a ?? (b ?? c)`, `b ?? c` is the fallback of `a`. Grouped to the left, `(a ?? b) ?? c` has nothing left to resolve, as `a ?? b` is not an optional.

<!-- spec:begin compile -->

```ents
data names: [][]u8 = ["ab", "cde"]
data primes = [2:u32, 3, 5, 7]

func name(i: u32) -> []u8 => names[i] ?? "?"
func read(p: ?*u32) -> u32 => (p ?? &0).*
func missing(i: u32) -> bool => (primes[i] ?? 0) == 0
func either(i: u32, j: u32) -> u32 => primes[i] ?? (primes[j] ?? 1)

test "?? gives a fallback" {
  assert name(1).len == 3
  assert name(9).len == 1
  assert read(&primes[3]) == 7
  assert read(0) == 0
  assert missing(4) && !missing(0)
  assert either(9, 2) == 5
  assert either(9, 9) == 1
}
```

```ents
data primes = [2:u32, 3, 5, 7]

func pick(i: u32, j: u32) -> u32 => (primes[i] ?? primes[j]) ?? 1
```

```errors
runtime index on *[4]u32 requires 'if let' or '??' (no optional type for u32)
?? requires an optional expression or bounds-checked index
```

<!-- spec:end -->

Where the whole is given for the const pointer or slice that the left side's value is the mutable one of, the fallback is given for that type: `count(buf[i..] ?? "")`, with `buf` a `*mut [8]u8` and `count` taking a `[]u8`, is a `[]u8`, and the literal there is constant ([1.5](#the-mut-keyword-on-literals)). With a mutable one wanted, or none (`let s = buf[i..] ?? mut ""`), the fallback is for the mutable type.

#### `if let` Bindings

`if let name = value { ... }` runs its first branch when `value` has a value, with `name` bound to it: an optional pointer, slice or host reference that is not none, or an index ([4.7](#47-bounds-checked-indexing)) or range ([4.8](#48-slicerange-syntax)) that is in range. Otherwise it runs its `else` branch, if it has one. The binding has the plain type: a `*T` for a `?*T`, a `[]T` for a `?[]T`, the element for an index.

<!-- spec:begin compile -->

```ents
type Node = (value: u32, next: ?*Node)

data nodes = mut [Node(1, 0), Node(2, 0)]

func total(n: *Node) -> u32 {
  if let next = n.next {        // next is a *Node: the field was not none
    return n.value + total(next)
  }
  return n.value
}

test "if let unwraps an optional pointer" {
  assert total(&nodes[0]) == 1
  nodes[0].next = &nodes[1]
  assert total(&nodes[0]) == 3
}
```

<!-- spec:end -->

`if let` takes an expression that gives an optional (`?*T`, `?[]T`, `?Host`) or an index or range that would give one. On a many-pointer, which has no length, there is nothing to check, and `if let` and `??` are errors (see [Element Addresses and Writes](#element-addresses-and-writes)).

<!-- spec:begin compile -->

The binding is a variable of its own, seen in the first branch only, and so is a `let` in that branch. Like the variables of a loop ([5.2](#52-loops)), it cannot have the name of a variable seen where it is written, so it never hides one and never changes one:

```ents
data cells = [7:u32, 8, 9]

func get(p: ?*u32) -> u32 {
  if let p = p {
    return p.*
  }
  return 0
}

func pick(i: u32) -> u32 {
  let v: u32 = 5
  if let v = cells[i] {
    return v
  }
  return v
}
```

```errors
'p' is already declared: an if let binding cannot reuse the name of a parameter
'v' is already declared: an if let binding cannot reuse the name of a variable in scope
```

After the branch the name is free again: another `if let` can bind it, to a value of another type, and so can a `let`.

```ents
data cells = [7:u32, 8, 9]
data names = ["ab", "cde"]

func size(i: u32) -> u32 {
  let n: u32 = 0
  if let v = cells[i] {
    n += v
  }
  if let v = names[i] {
    n += v.len
  }
  let v: u32 = 100
  return n + v
}

test "an if let binding is a variable of its first branch" {
  assert size(1) == 111
  assert size(5) == 100
}
```

<!-- spec:end -->

It is an `if` in every other way: it can have `elif` and `else` branches, and with an `else` it's an expression whose branches widen to one type. An `elif let` branch is not implemented: it is accepted but binds nothing (a known bug), so write an `if let` inside the `else` branch instead.

<!-- spec:begin compile -->

```ents
data scores = [95, 87, 42]:*[_]i32

func score(i: u32, lenient: bool) -> i64 => if let s = scores[i] { s } elif lenient { 50 } else { -1 }

test "if let gives a value" {
  assert score(1, false) == 87
  assert score(7, true) == 50
  assert score(7, false) == -1
}
```

<!-- spec:end -->

#### Element Addresses and Writes

Writing `items[i] = v` follows the same rules as reading: the index must be proven in range (a constant or a ranged index into a `*[N]T`), or the write is an error, whatever the element is: `ps[i] = q` with a `*mut [4]*u8` and `i: u32` is refused (`writing to an element needs an index known to be in range`) although `ps[i]` reads as an optional. On a slice no index is proven. For an index that can't be proven, take the element's address: `&items[i]` on a slice or `*[N]T` is `?*T`, none when `i` is out of range, so the check is visible in the code:

<!-- spec:begin compile -->

```ents
data buf = mut [0:u8; 4]

func put(s: []mut u8, i: u32, v: u8) -> bool {
  if let p = &s[i] {
    p.* = v
    return true
  }
  return false
}

test "a write at a run-time index goes through the element's address" {
  assert put(buf, 3, 9)
  assert !put(buf, 4, 9)
  assert buf[3] == 9
}
```

```ents
func put(s: []mut u8, i: u32, v: u8) {
  s[i] = v
}
```

```errors
writing to an element of a slice needs its index checked: use if let on its address (&s[i])
```

<!-- spec:end -->

With a proven index, `&items[i]` is a plain `*T`. A many-pointer (`[*]T`) has no length, so indexing it is never checked; casting to one is the explicit way to opt out. `if let` and `??` have nothing to check on its index, and are errors there (`if let has nothing to check here: [*]i32 has no length, so its index is never checked — index it directly`), unless its elements are optionals themselves. On a many-pointer `&p[i]` is a plain `*T` too, the address `i` elements on, also where a pointer is expected. A many-pointer to rows (`[*][M]T`) is a table, whose elements are its row pointers ([Nesting](#nesting)), so there `&p[i]` is a `**[M]T`.

<!-- spec:begin compile -->

`&` takes the address of something in memory: a literal (which gets a cell of its own in the data section, in parentheses or not: `&(8)` is `&8`), an element of an array, slice or many-pointer, or a value that lies in memory, a field of a struct a pointer points to or a part of one (`&p.pos` is a `*mut Vec2` when `p` is a `*mut Body`, [9.6](#fixed-arrays-in-place)). The cell of a literal is one for its place in the source, kept from one evaluation to the next ([1.5](#the-mut-keyword-on-literals)). A part of the literal only known when the program runs is stored into the cell there, each time the `&` is computed, in the order the parts are written: `&(y: f(), x: n)` for a `*Point` calls `f` and then fills in both fields. An array written out where a pointer to an array is wanted is laid out as it is there without the `&`: `&[1, 2]` for a `*[2]i32` is `[1, 2]`. A variable is held in registers and has none, whatever type is expected of `&x`:

```ents
func get(p: *i32) -> i32 => p.*

func third(p: [*]i32) -> i32 => get(&p[2])    // p + 8, the element's address
func cell() -> i32 => get(&5)                   // a cell holding 5
func value(x: i32) -> i32 => get(&x)
```

```errors
'x' has no address: a variable is held in registers
```

<!-- spec:end -->

A value that is already a pointer is not given a cell: `&` before it gives the pointer itself. So `&p`, with `p` a pointer variable, is `p`, and `&"abc"` is the string's own constant `*[3]u8` ([String Literals](#string-literals)), not a writable copy: write `mut "abc"` for that. Whether `&` of a pointer stays allowed is undecided, so do not write it. A cast binds tighter than `&` ([Precedence](#precedence)): `&p[1] as [*]u8` takes the address of `p[1] as [*]u8`; write `(&p[1]) as [*]u8`.

### 4.8 Slice/Range Syntax

A range makes a slice over part of an array or slice, with no copying. It is written only in brackets after the value it ranges over; `a..b` alone is no value (a counted loop is `for i in n`, [5.2](#52-loops)):

| Form | Elements |
|------|----------|
| `xs[a..b]` | from index `a` up to, not including, `b`: `b - a` of them |
| `xs[a..]` | from `a` to the end |
| `xs[..b]` | the first `b` |
| `xs[..]` | all of them, as a slice |

Ranges follow the same bounds rules as indexing. A bound is an integer as an index is, of at most 32 bits, signed or not, and a negative one is out of range as a negative index is: `xs[a..b]` with `a = -1` is none, and on a `*[N]T` a negative constant bound is an error (`range -1..2 is out of bounds for *[4]i32`).

- On a `*[N]T`, constant bounds are checked at compile time, and so are ranged bounds whose types prove `start <= end <= N` (for example `arr[..i]` with `i: u32#8` on a `*[16]u8`). The result is a `[]T`.
- Anything else is an optional `?[]T`, none unless `start <= end <= len`, checked at runtime: `s[i..] ?? ""` or `if let rest = s[i..] { ... }`. On a slice, only the whole slice (`s[..]`) is known to fit.
- A many-pointer (`[*]T`) has no length, so its ranges are unchecked and need an end: `p[0..n]` (`a range on a many-pointer needs an end: it has no length`).

A range of a `*mut [N]T` or `[]mut T` is a `[]mut T`.

<!-- spec:begin compile -->

```ents
data bytes = [1:u8, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]

func sizes() -> u32 => bytes[2..8].len * 1000 + bytes[8..].len * 100 + bytes[..4].len * 10 + bytes[..].len
func head(n: u32#9) -> []u8 => bytes[..n]                  // n <= 8 < 16: proven
func rest(s: []u8, i: u32) -> []u8 => s[i..] ?? ""
func span(p: [*]u8, n: u32) -> []u8 => p[0..n]             // unchecked

test "ranges" {
  assert sizes() == 6856
  assert head(3).len == 3
  assert rest("hello", 2).len == 3
  assert rest("hello", 9).len == 0
  assert span(bytes, 5).len == 5
}
```

```ents
data four = [1, 2, 3, 4]

func before() -> u32 => four[-1..2].len
func tail(p: [*]u8) -> []u8 => p[2..]
```

```errors
range -1..2 is out of bounds for *[4]i32
a range on a many-pointer needs an end: it has no length
```

<!-- spec:end -->

#### Filling and Copying

Assigning to a range fills it or copies into it: `buffer[..] = 0` gives every element the value, and `cv[0..8] = hs[0..8]` copies 8 elements. A range takes `=` only: `buf[0..4] += 1` is `a range can only be assigned with =`.

What is assigned says which. A value that can be assigned to one element is a fill, whatever the element is, and even where it is an array of elements as well (a `Node` of `type Node = *[2]Node`): a number, a struct (`points[0..n] = origin`), a slice (`names[0..3] = "?"` makes each of three `[]u8` the same one-byte string), a pointer, and in a table a row pointer, so every row of the range then points at the same cells. Anything else is the elements to copy: a slice or a pointer to an array of the element type, an array literal (`buf[0..2] = [1, 2]`, laid out as the range's elements are), or an array held in registers, which is stored element by element. A table's rows are copied as its row pointers, so rows of a const table do not go into a mutable one (`cannot copy *[2][3]i32 into a range of *mut [3]i32: its rows are *[3]i32`), as `m[i] = r` is refused for them; an array literal copied there is written `mut`. A value that is neither is refused as the one it was meant as: a value of the element type as written, a `[3]i32` in registers or a const row for a `*mut [2][3]i32`, as a fill (`fill value: cannot assign [3]i32 to *mut [3]i32`, as `m[i] = r` says), anything else as a copy (`cannot copy []u8 into a range of []i32`).

A fill of bytes, or of zeros of any element (a struct of zeros, a wide integer 0, none for an optional slice), is one `memory.fill`; any other fill computes the value once and stores it into each element in a loop. A copy is one `memory.copy`, or the stores of an array held in registers.

The range is written, so it must be known to fit without a runtime check, like an indexed write: constant or ranged bounds on a `*[N]T`, the whole of a slice (`s[..]`), or any range of a many-pointer. A fill can have a runtime length (`buf[..n] = 0` with `n: u32#17` on a `*[16]u8`). A copy needs both lengths known at compile time and equal, so it can't overrun either side. With a length known only at run time, `memcpy` ([10.3](#103-memory-builtins)) copies into an array pointer, with the length written out; into a slice of run-time length, copy element by element.

<!-- spec:begin compile -->

```ents
data hs = [1:u32, 2, 3, 4, 5, 6, 7, 8]
data iv = [9:u32, 10, 11, 12, 13, 14, 15, 16]
data cv = mut [0:u32; 16]

func load() {
  cv[..] = 0                    // fill: every element gets the value
  cv[0..8] = hs[0..8]           // copy 8 elements
  cv[8..16] = iv                // a *[8]u32 copies all of its elements
}

func mark(n: u32#17) {
  cv[..n] = 7                   // a fill can have a run-time length
}

test "a range assignment fills or copies" {
  load()
  assert cv[0] == 1 && cv[7] == 8 && cv[8] == 9 && cv[15] == 16
  mark(2)
  assert cv[1] == 7 && cv[2] == 3
}
```

```ents
func copy(d: []mut u8, s: []u8) { d[..] = s }
func clear(d: []mut u8, n: u32) { d[..n] = 0 }
```

```errors
copying into a range needs both lengths known at compile time; use memcpy for a runtime length
writing to a range needs bounds known to fit: use constant or ranged bounds (on a slice, only s[..])
```

<!-- spec:end -->

### 4.9 Method-Call Syntax

`x.f(a, b)` calls the function `f` with `x` as its first argument, when `x` has no member named `f`. Any function can be called this way; there are no methods to declare. (Elsewhere this is called uniform function call syntax.)

<!-- spec:begin compile -->

```ents
type Point = (x: f64, y: f64)

func length(p: Point) -> f64 => sqrt(p.x * p.x + p.y * p.y)
func scale(p: Point, factor: f64) -> Point => Point(p.x * factor, p.y * factor)
func double(n: u32) -> u32 => n * 2

export func a(p: Point) -> f64 => p.scale(2.0).length()      // length(scale(p, 2.0))
export func b(n: u32) -> u32 => n.double().double()          // any type has them, not only structs
export func c(xs: []u8) -> u32 => xs.len.double()            // .len is the slice's own member

test "method calls" {
  assert a(Point(3.0, 4.0)) == 10.0
  assert b(21) == 84
  assert c("abc") == 6
  assert (4:u32).double() == 8
}
```

1. **Members win.** If the type of `x` has a field `f`, directly or through one pointer, `x.f` is that field, whether or not it is called. What a slice, an array and a pointer have built in (`.ptr`, `.len`, `.wid`, `.*`, `.0`, the type views such as `.u32`) are members in this sense. A many-pointer has no `.len`, so `s.len()` for `s: [*]u8` calls a function `len`.
2. **The receiver is the first argument.** `x.f(a, b)` is `f(x, a, b)`. For a generic `f` ([8. Generics](#8-generics)) the receiver is the first argument that is not a comptime one, and the call is the inferred form, so the receiver usually decides the type parameters. `v.push(u32, 7)`, with the type parameters written after the receiver, is the explicit form and means `push(u32, v, 7)`.
3. **The receiver is passed as written.** It gets the conversions any argument gets (`*mut` to `*`, an array pointer to a slice, a narrower number widened) and nothing more: no address is taken of it, and no pointer is followed for it.
4. **Calls chain left to right.** `v.last().double()` is `double(last(v))`.
5. **It is only syntax.** `x.f(a)` and `f(x, a)` are the same call and compile to the same code. Which function `f` is, among functions that share the name, is decided as for any call ([3.4](#functions-that-share-a-name)). A builtin is called the same way: `x.sqrt()`, `a.min(b)`.

```ents
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
func last(comptime T: type, v: *Vec(T)) -> T => v.ptr[v.len - 1]
func push(comptime T: type, v: *mut Vec(T), x: T) {
  v.ptr[v.len] = x
  v.len += 1
}
func double(n: u32) -> u32 => n * 2

export func f(v: *mut Vec(u32), x: f64) -> u32 {
  v.push(7)                                        // push(v, 7): T = u32, from v
  v.push(u32, 8)                                   // push(u32, v, 8)
  return v.last().double() + (x.sqrt().min(9.5) as u32)
}
```

is the same module as the one written with plain calls:

```ents same-wasm
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
func last(comptime T: type, v: *Vec(T)) -> T => v.ptr[v.len - 1]
func push(comptime T: type, v: *mut Vec(T), x: T) {
  v.ptr[v.len] = x
  v.len += 1
}
func double(n: u32) -> u32 => n * 2

export func f(v: *mut Vec(u32), x: f64) -> u32 {
  push(v, 7)
  push(u32, v, 8)
  return double(last(v)) + (min(sqrt(x), 9.5) as u32)
}
```

A value is held in registers and has no address, so a function that takes a pointer cannot be called on one. This is why a container's header lives in memory ([8.5](#85-generic-types)):

```ents
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
func push(comptime T: type, v: *mut Vec(T), x: T) {
  v.ptr[v.len] = x
  v.len += 1
}

func f(v: Vec(u32)) { v.push(7) }
```

```errors
push takes *mut Vec(u32) first; the receiver is a Vec(u32), which is held in registers and has no address
```

An array written out is not such a value: passed for a pointer it is laid out in memory, as it is when it is the first argument, so `[1, 2, 3].sum()` calls `sum(r: *[3]i32)`, and a table written out with a row known only at run time is refused for that row ([2.5](#nesting)).

Otherwise the errors of `x.f(a)` are those of `f(x, a)`, reported at the name of the method and worded for the call as it was written: `x` is the receiver and the arguments are counted after it, as in `'double' expected 0 arguments after the receiver, got 1` for `n.double(1)`. With neither a member nor a function of that name, one error says both. A field that is called is still the field:

```ents
type Box = (size: u32, n: u32)
func size(b: Box) -> u32 => b.size * b.n

func f(b: Box) -> u32 => b.area(2)
func g(b: Box) -> u32 => b.size()
```

```errors
no field 'area' on type Box, and no function 'area' accepts (Box, int(2))
cannot call non-function type: u32 ('size' is a field here, and a field wins over the function 'size': write size(...))
```

A type written on a literal binds more loosely than a member does, so a literal that is given its type is a receiver in parentheses: `(4:u32).double()`.

<!-- spec:end -->

---

## 5. Statements & Control Flow

A block, `{ ... }`, is a sequence of statements, run in order. Statements need no separator ([1.6](#16-statements-and-line-breaks)). The statements are:

| Statement | What it does | Section |
|---|---|---|
| `let`, `set` | declares variables; assigns several at once | [3.3](#33-variables), [4.5](#45-assignment-and-compound-assignment) |
| `x = v`, `x += v`, … | assigns | [4.5](#45-assignment-and-compound-assignment) |
| an expression | is evaluated and its value dropped: a call, an `if`, a `match` | [5.1](#51-conditionals), [5.4](#54-match-expressions) |
| `while`, `for`, `loop` | repeats a body | [5.2](#52-loops) |
| `return`, `break`, `continue` | leaves the function, the loop, or the pass of the loop | [5.3](#53-control-statements) |
| `defer` | runs an expression when its block exits | [Defer](#defer) |
| `assert` | traps when a condition is false | [Assertions](#assertions) |

`if` and `match` are expressions. Written as a statement, one runs for what its branches do; written where a value is wanted, it gives one.

**Bodies.** Everything that has a body takes either a block or `=>` and one expression: a function ([3.4](#34-functions)), each branch of an `if`, and `while`, `for` and `loop`. A match arm is its patterns, `=>`, and an expression or a block ([5.4](#54-match-expressions)). An arrow body is one expression, never a statement: `for i in n => add(i)` calls `add` on each pass, but `for i in n => t += i` is a syntax error, since an assignment is a statement. Where nothing takes an arrow body's value, as in a loop, the value is dropped.

<!-- spec:begin compile -->

```ents
global ticks: u32 = 0

func tick() { ticks += 1 }

func sign(x: i32) -> i32 => if x < 0 => -1 elif x > 0 => 1 else => 0

func run(n: u32) {
  for i in n => tick()
  while ticks < 10 => tick()
}

test "a body is a block or one expression" {
  assert sign(-4) == -1
  assert sign(0) == 0
  run(3)
  assert ticks == 10
}
```

```ents
func sum(n: u32) -> u32 {
  let t: u32 = 0
  for i in n => t += i
  return t
}
```

```errors
Line 3, col 20
```

<!-- spec:end -->

### 5.1 Conditionals

`if condition body` is followed by any number of `elif condition body` and at most one `else body`. The conditions are evaluated in order, and the body of the first one that holds runs; the conditions after it are not evaluated. When none holds, the `else` body runs, if there is one. The keyword is `elif`: `else if` is a syntax error, since `else` takes a body (a block, or `=>` and an expression). An `if` compiles to a wasm `if`, and each `elif` to an `if` in the `else` of the one before.

<!-- spec:begin compile -->

```ents
global warnings: u32 = 0
global failures: u32 = 0

func report(level: u32) {
  if level >= 2 {
    failures += 1
  } elif level == 1 {
    warnings += 1
  }
}

test "the first condition that holds picks the branch" {
  report(1)
  report(3)
  report(0)
  assert warnings == 1
  assert failures == 1
}
```

```ents
func pick(a: bool, b: bool) -> i32 => if a { 1 } else if b { 2 } else { 3 }
```

```errors
Line 1, col 55
```

<!-- spec:end -->

A condition is a `bool`. A number, a pointer or an optional is not true or false by itself: compare a number (`if n != 0`), and resolve an optional with `if let` ([6.4](#64-if-let-bindings)) or `??`. The same goes for the conditions of `while`, `when` and `assert`, and for the operands of `&&`, `||` and `!`.

<!-- spec:begin compile -->

```ents
func f(n: u32) -> u32 {
  if n {
    return 1
  }
  return 0
}
```

```errors
condition must be bool, not u32
```

<!-- spec:end -->

**As a value.** An `if` with an `else` is also an expression. Its value is the value of the branch taken: the last expression of its block, or the expression after its `=>`. So every branch needs one, unless it always exits (`return`, `break`, `continue`): a branch that ends in a statement and goes on has no value (`this branch has no value: expected i32`). The branches widen to one type, like operands ([Implicit Widening](#implicit-widening)), and with a value the wasm `if` has that type's results. An `if` without an `else` has no value: it is of type `()`, the empty tuple, and using it as a number is an error (`cannot assign () to i32`). A function's block body is not such a value: with an unnamed result its last expression is not returned (write `return`, or an expression body), and with named results it fills them ([3.4](#34-functions)).

A branch whose value has no type of its own takes the type of the others, as a literal does anywhere it meets a typed value: an array literal next to a slice or a pointer is laid out as one, so `if c { xs } else { [] }` with `xs: []i32` is a `[]i32`, and so is `if c { xs } else { [7, 8] }`, with or without a type written for the `let` it is given to. The same goes for the arms of a `match`, and for `elif`. A branch that is itself an `if` or a `match` whose values are array literals is not laid out so: it is checked as a value of its own first, so `if a { xs } else { if b { [1] } else { [] } }` is refused (`branches have different types: [] and [1]i32`), and with literals of one length it is a value such as `[2]i32`, which a slice does not take (`cannot convert [2]i32 to []i32 implicitly`). Write the type where the value is given (`let ys: []i32 = ...`), or use `elif`.

<!-- spec:begin compile -->

```ents
func clamp(x: i32, lo: i32, hi: i32) -> i32 => if x < lo { lo } elif x > hi { hi } else { x }

func widest(small: bool, n: u8, big: u64) -> u64 {
  let v = if small { n } else { big }    // a u64: n widens to it
  return v
}

func values(c: bool, xs: []i32) -> []i32 => if c { xs } else { [7, 8] }

func first_positive(xs: []i32) -> i32 {
  for x in xs {
    let v = if x > 0 { x } else { continue }
    return v
  }
  return 0
}

test "an if with an else is a value" {
  assert clamp(15, 0, 10) == 10
  assert clamp(-3, 0, 10) == 0
  assert widest(true, 200, 9) == 200
  assert values(false, [1]).len == 2
  assert first_positive([-1, 0, 4]) == 4
}
```

```ents
func f(c: bool) -> i32 {
  let x = if c { 1 }
  return x
}

func g(c: bool, t: i32) -> i32 => if c { t } else { t = 0 }
```

```errors
cannot assign () to i32
this branch has no value: expected i32
```

<!-- spec:end -->

Used as a statement, an `if` has no value to agree on: its branches can end in anything, and a value one of them leaves is dropped. A `let` in a branch declares a variable of the function, seen after the `if` as well, but for the exceptions [3.3](#33-variables) lists; the binding of an `if let`, and a `let` in its first branch, are seen in that branch alone.

### 5.2 Loops

| Loop | Runs its body |
|---|---|
| `while condition body` | as long as the condition holds, tested before each pass |
| `for x in iterable body` | once for each number of a count, or for each element of an array or slice |
| `loop body` | until a `break` or a `return` leaves it |

`break` leaves the innermost loop, and `continue` ends the pass: a `while` tests its condition again, a `for` goes on to its next number or element, and a `loop` runs its body again ([5.3](#53-control-statements)). A loop is a statement and has no value. Each compiles to a wasm `loop` inside a `block`: the end of a pass branches back to the `loop`, and `break` branches out of the `block`. A `loop` that no `break` leaves ends only by `return` (or a trap), so a function body that ends in one returns on every path ([3.4](#34-functions)).

<!-- spec:begin compile -->

```ents
func gcd(a: u32, b: u32) -> u32 {
  while b != 0 {
    set a, b = (b, a % b)
  }
  return a
}

// The number of decimal digits of n.
func digits(n: u32) -> u32 {
  let count: u32 = 0
  loop {
    count += 1
    n /= 10
    return count when n == 0
  }
}

test "while and loop" {
  assert gcd(48, 18) == 6
  assert digits(0) == 1
  assert digits(4096) == 4
}
```

<!-- spec:end -->

A `for` binds one variable, `for x in xs`, or two, `for i, x in xs`: the index first, then the element. Each is a plain name. A pattern is not a binding (`for (a, b) in pairs` is a syntax error): take an element apart with a `let` in the body ([3.3](#33-variables)). A loop that doesn't use its variable still names one: `_` is not a name.

#### Counting

`for i in n` runs its body `n` times, with `i` counting from 0 up to `n - 1`. The count is an integer of at most 32 bits (`a loop count must be an integer of at most 32 bits, not i64`), evaluated once, before the loop: changing what it was computed from inside the loop doesn't change how often it runs. `i` is a `u32` that counts up from 0 while it is below the count, so a negative count runs the loop zero times. With a constant count `N`, `i` is a `u32#N` ([Ranged Integers](#ranged-integers)), which proves an index into a `*[N]T` with no run-time check. A constant count that isn't negative is a `u32` too: `for i in 3000000000` counts to it as a `u32` (not as the `i64` the constant is on its own), and a count no `u32` holds, such as `5000000000`, is an error (`cannot assign int(5000000000) to u32`).

There is no range form: `for i in 2..10` is a syntax error. Count from 0 and add the start, or loop over the elements of a range of an array or slice ([4.8](#48-slicerange-syntax)). A count loop has one variable; with two, `for i, j in n`, the first is never set (a known bug).

<!-- spec:begin compile -->

```ents
data weights = [1:u32, 10, 100]
data counts = [4:u32, 2, 7]

func total() -> u32 {
  let t: u32 = 0
  for i in weights.len {
    t += weights[i] * counts[i]    // i is a u32#3: neither index needs a check
  }
  return t
}

// The sum of the numbers from lo up to hi, hi left out.
func span(lo: i32, hi: i32) -> i32 {
  let t = 0
  for k in hi - lo {               // a negative count runs no pass
    t += lo + k as i32
  }
  return t
}

test "counting" {
  assert total() == 724
  assert span(2, 5) == 9
  assert span(5, 2) == 0
}
```

<!-- spec:end -->

#### Elements

`for x in xs` runs its body once for each element of `xs`, first to last, with `x` a copy of the element; `for i, x in xs` also gives the element's index `i`, a `u32` from 0. These have elements a loop walks:

- a slice, `[]T` or `[]mut T`;
- a pointer to a fixed array, `*[N]T` or `*mut [N]T`: a `data` block, a string literal, or a fixed array that lies in memory, such as the field `p.cells` of the struct a pointer `p` points to;
- a table, `*[N][M]T`, whose elements are its row pointers, each a `*[M]T` ([Nesting](#nesting)).

The loop walks a pointer from the first element to the end of the array, loading each element into the variable as it gets there, so it needs no bounds checks. The slice or pointer is evaluated once, before the loop: assigning another slice to the variable it came from changes nothing about the loop. The elements are read one pass at a time, so a write to a later element in the body is what the loop reads when it gets there. An element can be of any type: a struct or a slice is loaded whole, each of its values into a register, and since the variable is a copy, assigning to it doesn't change the array.

<!-- spec:begin compile -->

```ents
type Spot = (c: i32, di: i32, room: i32)

data grid: *[2][3]u8 = [[1, 2, 3], [4, 5, 6]]

func total(list: []Spot) -> i32 {
  let t = 0
  for s in list {
    t += s.c + s.di + s.room
  }
  return t
}

// The index of the first c in s, or s.len.
func find(s: []u8, c: u8) -> u32 {
  for i, x in s {
    return i when x == c
  }
  return s.len
}

// How many times the values rise from one element to the next.
func rises(xs: []i32) -> u32 {
  let count: u32 = 0
  let prev = xs[0] ?? 0
  for x in xs[1..] ?? xs {
    if x > prev {
      count += 1
    }
    prev = x
  }
  return count
}

func grid_sum() -> u32 {
  let t: u32 = 0
  for row in grid {                // each row is a *[3]u8
    for x in row {
      t += x
    }
  }
  return t
}

test "element loops" {
  assert total([Spot(1, 2, 3), Spot(4, 5, 6)]) == 21
  assert find("hello", 'l') == 2
  assert find("hello", 'z') == 5
  assert rises([1, 3, 2, 5]) == 2
  assert rises([]) == 0
  assert grid_sum() == 21
}
```

<!-- spec:end -->

Nothing else is looped over, and each has its way:

- a many-pointer, `[*]T`, has no length: make a slice of it and a length, `let s: []T = (p, n)`;
- a `*[!]T` has its length only when it is scanned for: make the slice once, `(z.ptr, z.len)`, and loop over that;
- a packed `*[NxM]T`: loop over the row index, `for i in p.len`, and then over the row `p[i]`;
- an array held in registers, a `[N]T` variable or an array literal written in place, is indexed by constants only ([2.4](#24-fixed-arrays-value-type)): a loop needs it in memory;
- an optional slice, `?[]T`, may be none: resolve it with `if let` or `??` first;
- a pointer to one value, `*T`, and a number that isn't an integer of at most 32 bits.

<!-- spec:begin compile -->

```ents
func a(p: [*]u32) { for x in p { } }
func b(z: *[!]u8) { for c in z { } }
func c(m: *[2x3]i32) { for r in m { } }
func d(v: [3]u32) { for x in v { } }
func e(o: ?[]u32) { for x in o { } }
func f(n: i64) { for i in n { } }
```

```errors
cannot iterate over [*]u32: use a count, a slice, or a pointer to a fixed-size array
cannot iterate over *[!]u8: use a count, a slice, or a pointer to a fixed-size array
cannot iterate over *[2x3]i32: use a count, a slice, or a pointer to a fixed-size array
cannot iterate over [3]u32: use a count, a slice, or a pointer to a fixed-size array
cannot iterate over ?[]u32: it may be none — resolve it with 'if let' or '??' first
a loop count must be an integer of at most 32 bits, not i64
```

```ents
data name = "abc":*[!]u8
data packed: *[2x3]i32 = [[1, 2, 3], [4, 5, 6]]

func bytes(z: *[!]u8) -> u32 {
  let t: u32 = 0
  let s: []u8 = (z.ptr, z.len)     // scans for the length once
  for c in s {
    t += c
  }
  return t
}

func cells() -> i32 {
  let t = 0
  for i in packed.len {
    for x in packed[i] {
      t += x
    }
  }
  return t
}

test "a slice for a *[!]T, a row index for a *[NxM]T" {
  assert bytes(name) == 294
  assert cells() == 21
}
```

<!-- spec:end -->

#### Loop Variables

<!-- spec:begin compile -->

The variables of a loop, its element and its index, are seen in its body only. They cannot have the name of a variable seen where the loop is: a parameter, a named result, a `let` before the loop ([3.3](#33-variables)), the variable of a loop, `if let` or match arm the loop is in, or a global. Nor can they have the name of a `def` or a `data` block, which stand for a value wherever they are written. So a loop never hides a variable, and never changes one:

```ents
func count(n: u32) -> u32 {
  let t: u32 = 0
  for n in n {
    t += 1
  }
  return t
}

func after() -> u32 {
  let c: u32 = 5
  for c in 3 {
  }
  return c
}

func grid() -> u32 {
  let t: u32 = 0
  for i in 3 {
    for i in 4 {
      t += 1
    }
  }
  return t
}
```

```errors
'n' is already declared: a loop variable cannot reuse the name of a parameter
'c' is already declared: a loop variable cannot reuse the name of a variable in scope
'i' is already declared: a loop variable cannot reuse the name of a loop variable in scope
```

After the loop its names are free again. A later loop can use them, for elements of another type, and a `let` after the loop declares a variable of its own. A function of the module has no value: a loop variable of its name hides it in the body.

```ents
data bytes = [1:u8, 2, 3]
data wides = [1.5, 2.5]

func scale() -> f64 => 2.0

func total() -> f64 {
  let s: f64 = 0
  for v in bytes {
    s += v as f64
  }
  for v in wides {
    s += v
  }
  for scale in 2 {
    s += scale as f64
  }
  let v: f64 = 0.5
  return s * scale() + v
}

test "a loop's variables are its body's" {
  assert total() == 22.5
}
```

<!-- spec:end -->

The body can assign its loop's variables. The element is a copy, so assigning to it changes nothing else. A count's variable is the one the loop steps: after each pass it goes up by one from the value it holds and is compared with the count, so assigning to it changes the passes that follow (`i = n - 1` makes the pass the last). An element loop's index counts on from a value assigned to it, while the elements are walked as before. A `u32#N` variable takes only values below `N` (`cannot assign int(20) to u32#10`).

### 5.3 Control Statements

#### `return`

`return value` ends the function with that value as its result, checked against the result type as a `let` of that type checks its value. A bare `return` is for a function with no result, or with named results, which it returns as they are set; in a function with an unnamed result, `return` needs a value (`return needs a value: the function returns i32`). `return` takes the expression after it, on its line or the next ([1.6](#16-statements-and-line-breaks)), so a bare `return` is written last in its block or with its `when`. Before the function ends, `return` runs the deferred expressions of every block it is in ([Defer](#defer)). A function whose body is a block and whose result is unnamed must end every path with a `return` (`function 'f' can reach its end without returning a value`). The compiler decides this by the body's last statement, which must be a `return` without `when`, a `loop` with no `break` out of it, an `if` with an `else` whose every branch ends so, or a `match` with a `_` arm whose every arm ends so; a trailing value does not count ([3.4](#34-functions)).

#### `break` and `continue`

`break` leaves the innermost loop around it, and `continue` ends that loop's pass ([5.2](#52-loops)). Written in the branch of an `if` or a match arm inside a loop, they act on that loop. Neither takes a value, and neither names a loop: to leave several loops at once, `return` from a function that holds them, or set a variable that the outer loop tests (`break when found`). Both are written inside a loop: one outside every loop is accepted and gives a module that does not assemble (a known bug). Each runs the deferred expressions of the blocks it leaves, up to and including the loop's body.

<!-- spec:begin compile -->

```ents
data grid: *[3][2]u8 = [[1, 2], [3, 4], [5, 6]]

// The index of the first row of grid that holds x, or grid.len.
func row_of(x: u8) -> u32 {
  let row: u32 = 0
  let found = false
  for cells in grid {
    for c in cells {
      if c == x {
        found = true
        break                      // leaves the loop over the cells
      }
    }
    break when found               // leaves the loop over the rows
    row += 1
  }
  return row
}

test "break leaves the innermost loop" {
  assert row_of(4) == 1
  assert row_of(9) == 3
}
```

<!-- spec:end -->

#### `when`

`return`, `break` and `continue` take a `when condition` suffix: the statement happens only if the condition holds, and is `if condition { statement }` written shorter. The condition is evaluated first, and the value of a `return` only when the condition holds. A `break when` or `continue when` with no deferred expressions to run compiles to one wasm `br_if`. Only these three take `when`: `defer f() when c` and `x = 1 when c` are syntax errors; write an `if`.

<!-- spec:begin compile -->

```ents
global calls: u32 = 0

func cost() -> u32 {
  calls += 1
  return 7
}

func price(paid: bool) -> u32 {
  return cost() when paid        // cost() runs only when paid holds
  return 0
}

// The sum of the even numbers of xs, up to the first negative one.
func even_sum(xs: []i32) -> i32 {
  let t = 0
  for x in xs {
    break when x < 0
    continue when x % 2 != 0
    t += x
  }
  return t
}

global seen: u32 = 0

func note(x: u32) {
  return when x == 0
  seen += x
}

test "when" {
  assert price(false) == 0
  assert calls == 0
  assert price(true) == 7
  assert calls == 1
  assert even_sum([2, 3, 4, -1, 6]) == 6
  note(0)
  note(5)
  assert seen == 5
}
```

<!-- spec:end -->

#### Defer

`defer expr` runs `expr` when the enclosing block exits, by any path: falling off
its end, `break` or `continue` (which run the blocks they leave, up to the loop
body), or `return` (which runs every open block). Deferred expressions run
newest first, and only those reached before the exit run. The enclosing block is
the innermost `{ ... }`: a function body, a branch, a loop body (so a `defer`
there runs at the end of each pass) or a match arm. A body written with `=>` holds
no statement, so no `defer`.

<!-- spec:begin compile -->

```ents
global log: u32 = 0

func note(d: u32) { log = log * 10 + d }

func order() {
  defer note(1)
  defer note(2)
  note(3)
}

func late() {
  let d: u32 = 1
  defer note(d)
  d = 7
}

func early(stop: bool) -> u32 {
  defer note(1)
  return 5 when stop
  defer note(2)
  return 6
}

func passes() {
  for i in 3 {
    defer note(i)
    continue when i == 1
    note(5)
  }
}

test "deferred expressions run at exit, newest first" {
  order()
  assert log == 321
  log = 0
  late()
  assert log == 7              // d as it is at exit
  log = 0
  assert early(true) == 5
  assert log == 1              // the second defer was not reached
  log = 0
  passes()
  assert log == 50152          // the end of each pass, continue included
}
```

<!-- spec:end -->

- The deferred expression is evaluated when the block exits, not when `defer`
  runs: `defer note(d)` notes `d` as it is at exit.
- A `return` computes its value first; deferred expressions run after, and the
  value is returned unchanged. With named results, a trailing expression's
  value is stored in them before deferred expressions run.
- `defer` takes an expression, most often a call, and drops its value. An `if`
  defers a choice made at exit, `defer if dirty { flush() }`, and its blocks may
  hold statements. An assignment is a statement, so `defer x = 0` is a syntax
  error.
- A deferred expression can't `return`, or `break` or `continue` a loop outside
  it (`cannot return from inside a deferred expression`, `cannot break out of a
  deferred expression`). A loop inside it can use `break` and `continue` as usual.
- A trap is not an exit of a block: it ends the whole call into wasm, and no
  deferred expression runs ([9.7](#97-traps)).
- Deferred code is emitted inline at each exit. There is no runtime cost and no
  extra wasm features.

Its main use is freeing what a block allocates, on every way out of it. With a bump allocator that is a mark taken on the way in and reset on the way out, as the library's `stack` module (`lib/stack.ents`) is used:

<!-- spec:begin compile -->

```ents
data space = mut [0:u8; 4096]
global top: u32 = 0

func alloc(n: u32) -> [*]mut u8 {
  assert n <= space.len - top      // not top + n <= space.len, which can wrap
  top += n
  return (space as [*]mut u8) + (top - n)
}

func reset(mark: u32) { top = mark }

// The sum of the squares below n, built in scratch memory.
func sum_squares(n: u32) -> u32 {
  let mark = top
  defer reset(mark)                // frees the scratch memory on every way out
  return 0 when n == 0             // runs reset(mark) first
  let squares = alloc(n * 4) as [*]mut u32
  for i in n {
    squares[i] = i * i
  }
  let t: u32 = 0
  for i in n {
    t += squares[i]
  }
  return t
}

test "defer frees on every way out" {
  assert sum_squares(4) == 14
  assert top == 0
  assert sum_squares(0) == 0
  assert top == 0
}
```

<!-- spec:end -->

#### Assertions

`assert condition` is a statement, in any function and in a test. The condition is a `bool` (`condition must be bool, not u32`). When it is false the program traps: `assert c` compiles to `(if (i32.eqz c) (then (unreachable)))`, one test and branch. Optimized builds keep it, as they keep every trap. It takes no message (`assert n > 0, "empty"` is a syntax error): a comment beside it says what it guards. In a test, a false `assert` also makes `encantis test` report its line.

<!-- spec:begin compile -->

```ents
// The mean of xs, rounded down; xs must not be empty.
func mean(xs: []u32) -> u32 {
  assert xs.len > 0
  let t: u64 = 0
  for x in xs {
    t += x
  }
  return (t / xs.len as u64) as u32
}

test "mean" {
  assert mean([2, 4, 9]) == 5
}
```

<!-- spec:end -->

A trap ends the call into wasm at once: nothing after it runs, deferred expressions included, and the host sees an error. Among what traps are a false `assert`, a `match` that no arm matches ([5.4](#54-match-expressions)), an integer division by zero ([4.1](#41-arithmetic-operators)), a load or store outside memory, and a plain host reference that comes in as null ([2.13](#213-host-references)); [9.7](#97-traps) lists them all.

### 5.4 Match Expressions

`match subject { arms }` compares a value with patterns. Each arm is one or more patterns separated by commas, `=>`, and an expression or a block. Arms are separated by whitespace, and a comma may follow an arm, so `match k { 0 => 1, 1 => 2, _ => 3 }` fits on one line.

The subject is evaluated once, before the first test. Then the arms are tried in order: the first arm with a pattern that matches the subject runs, and no later arm is tried. When no arm matches, the program traps (wasm `unreachable`): the compiler does not check that the arms cover every value, and this holds for a `match` used as a statement too. `_` matches any value, so an arm `_ => ...` last makes the `match` cover everything; an arm after it is never tried. A statement `match` that may match nothing ends in `_ => {}`.

These are the patterns that are implemented:

| Pattern | Matches |
|---|---|
| an integer literal: `42`, `-1`, `0x2A`, `0b101` | the subject equal to it |
| a float literal: `1.5` | the subject equal to it |
| one codepoint: `'a'` | the subject equal to its number, 97 ([Codepoint Literals](#codepoint-literals)) |
| `true`, `false` | that bool |
| `_` | any value |

A pattern is compared in the subject's type, so it has to be a value of that type, or it is an error: `300` for a `u8` is `cannot match u8 against int(300)`, and so are `-1` for a `u32` and `1.5` for an `i32`. A string is not a pattern. The subject is an integer, a float or a `bool`, of at most 64 bits; a subject of any other type, a pointer, an optional, a struct or a slice, takes no pattern but `_`. A constant subject (`1`, a `def`, a fixed array's `len`) is compared in its default type.

A `def`'s name is not a pattern: a name in a pattern would be a binding ([6.3](#63-patterns-in-match-arms)), and a binding cannot take a def's name. Write the def's value, or compare with `if` and `elif`. The other patterns of [6.1](#61-pattern-forms), names, tuples, constructors and guards, are not implemented.

<!-- spec:begin compile -->

```ents
global unknown: u32 = 0

func status(code: u32) -> []u8 => match code {
  200 => "OK"
  301, 302 => "Redirect"
  404 => "Not Found"
  _ => {
    unknown += 1
    "Unknown"
  }
}

// How many more brackets s opens than it closes.
func depth(s: []u8) -> i32 {
  let d = 0
  for c in s {
    match c {
      '(', '[', '{' => { d += 1 }
      ')', ']', '}' => { d -= 1 }
      _ => {}
    }
  }
  return d
}

test "match" {
  assert status(302).len == 8
  assert status(500).len == 7
  assert unknown == 1
  assert depth("f(a[1], {b})") == 0
  assert depth("((") == 2
}
```

```ents
def size = 4

func a(x: u8) -> u32 => match x {
  300 => 1
  _ => 0
}

func b(s: []u8) -> u32 => match s {
  "ok" => 1
  _ => 0
}

func c(k: u32) -> u32 => match k {
  size => 1
  _ => 0
}
```

```errors
cannot match u8 against int(300)
cannot match []u8 against a string
'size' is already declared: a match binding cannot reuse the name of a def
```

<!-- spec:end -->

Match is an expression. Used as a value, each arm needs one, unless it always exits, and the arms widen to one type, as the branches of an `if` do ([5.1](#51-conditionals)). Used as a statement, its arms can end in anything. A `match` with a `_` arm whose every arm returns counts as returning ([3.4](#34-functions)).

A `match` compiles to nested wasm `if`s, one for each arm but a `_` one, each testing the subject's equality with the arm's patterns (several patterns are or-ed); the innermost `else` is the `_` arm's body, or `unreachable` where there is none. A subject that is more than a variable's read is computed into a local first.

---

## 6. Pattern Matching

A pattern is written where a value is taken apart or tested. There are two kinds. A binding pattern names the parts of a value, in a `let` or a `set`; it never fails. A match pattern tests a value, in a match arm, and the arm runs only if it matches. `if let` takes one name ([6.4](#64-if-let-bindings)). Patterns in function signatures, constructor patterns and enum patterns are designed and not implemented; each is labelled where it appears below.

### 6.1 Pattern Forms

**Binding patterns**, after `let` and `set` ([3.3](#33-variables), [4.5](#45-assignment-and-compound-assignment)):

| Pattern | Binds |
|---|---|
| `name` | the whole value |
| `(p, q, ...)` | the elements by position, each to a pattern of its own: `(a, (b, c))` nests |
| `(f:)` | the field named `f`, to a variable named `f` |
| `(f: name)` | the field named `f`, to `name` |
| `a, b, ...` | right after `let` or `set`, without parentheses, plain names only: the same as `(a, b, ...)` |

By-position and by-name parts can be mixed: in `let (x, y:) = p`, `x` is the first field and `y` the field named `y`. After `f:` comes a name, not a pattern: `let (pos: (x:, y:)) = b` is a syntax error (bind `pos`, then take it apart with another `let`). `_` is not a pattern either: name a part that is not used, or leave out parts at the end, since a pattern by position may have fewer parts than the value has fields (more is `tuple has 2 fields, but pattern has 3`). A constructor pattern, `let Point(x, y) = p`, is not implemented: it is a syntax error ([6.5](#65-let-destructuring)).

**Match patterns**, in a match arm ([5.4](#54-match-expressions)):

| Pattern | Matches | Status |
|---|---|---|
| `42`, `-1`, `0x2A`, `1.5` | a number equal to the subject | implemented |
| `'a'` | the codepoint's number, 97 | implemented |
| `true`, `false` | that bool | implemented |
| `_` | anything | implemented |
| `p, q` | (an arm's patterns) any one of them | implemented |
| `name` | anything, bound to `name` in the arm | **Not implemented**: accepted, and never matches |
| `(p, q)`, `'ok'` | a tuple, part by part | **Not implemented**: refused |
| `Point(p, q)`, `Point(x: p, y:)` | a struct, field by field | **Not implemented**: accepted, and never matches |
| `Red`, `Rgb(r, g, b)` | a variant of an enum ([2.9](#29-enum-types-algebraic-data-types)) | **Not implemented**: accepted, and never matches |
| `p if condition` | `p`, where the condition holds | **Not implemented**: a syntax error |

The forms that are accepted and never match must not be written: an arm with one never runs. [6.3](#63-patterns-in-match-arms) has the details.

### 6.2 Patterns in Function Signatures

> **Not implemented.** A parameter is `name: Type`, or a type alone for a parameter with no name ([3.4](#34-functions)). The parser reads a type followed by parentheses as a generic type applied to arguments, so a signature written with a pattern is refused.

The design gives a function's input and output as patterns, so that a signature can take a struct apart into its fields:

```ents
// Not implemented: the bindings would be x, y, d and a.
func to_polar CartesianPoint(x, y) -> PolarPoint(d, a)
```

A function takes the struct whole and takes it apart in its body:

<!-- spec:begin compile -->

```ents
type CartesianPoint = (x: f64, y: f64)

func distance(p: CartesianPoint) -> f64 {
  let (x:, y:) = p
  return sqrt(x * x + y * y)
}

test "a parameter is a name and a type" {
  assert distance(CartesianPoint(3.0, 4.0)) == 5.0
}
```

```ents
type CartesianPoint = (x: f64, y: f64)

func first CartesianPoint(x, y) -> f64 => x
```

```errors
'CartesianPoint' is not a generic type
unknown identifier 'x'
```

<!-- spec:end -->

### 6.3 Patterns in Match Arms

The patterns a `match` compares are literals and `_`, several to an arm ([5.4](#54-match-expressions)). The other forms of the table in [6.1](#61-pattern-forms) are designed and not implemented.

#### Binding Patterns

> **Not implemented.** A lower-case name as a pattern is meant to match any value and bind it in its arm. The compiler accepts the name, but binds nothing (a use of it is `unknown identifier`), and the arm never matches (a known bug). Write `_` for an arm that takes any value, and use the subject's own variable in its body.

<!-- spec:begin compile -->

The name is checked as a binding would be. Like the variables of a loop ([5.2](#52-loops)), it cannot have the name of a variable seen where the `match` is, nor a `def`'s:

```ents
func next(n: u32, k: u32) -> u32 => match k {
  0 => 1
  n => n + 1
}
```

```errors
'n' is already declared: a match binding cannot reuse the name of a parameter
```

<!-- spec:end -->

#### Struct and Tuple Patterns

> **Not implemented.** A tuple pattern is refused: `match cannot compare a tuple pattern yet: compare one field at a time`. A literal of several codepoints is the tuple of their numbers ([Codepoint Literals](#codepoint-literals)), so `'ok'` as a pattern is a tuple pattern too, and is refused the same way. A constructor pattern, `Point(0, y)`, is accepted and never matches (a known bug): do not write one. Match one field at a time, or compare with `if` and `elif`.

<!-- spec:begin compile -->

```ents
func vowel(c: u8) -> bool => match c {
  'a', 'e', 'i', 'o', 'u' => true
  _ => false
}

func origin(p: (i32, i32)) -> bool => p.0 == 0 && p.1 == 0

test "one codepoint is a number; a tuple is compared field by field" {
  assert vowel('e')
  assert !vowel('z')
  assert origin((0, 0))
  assert !origin((0, 3))
}
```

```ents
func f(c: u8) -> u32 => match c {
  'ok' => 1
  _ => 0
}

func g(p: (i32, i32)) -> u32 => match p {
  (0, 0) => 1
  _ => 0
}
```

```errors
'ok' is a tuple of codepoints, and match cannot compare a tuple pattern yet: compare one field at a time
match cannot compare a tuple pattern yet: compare one field at a time
```

<!-- spec:end -->

The design compares a struct or a tuple part by part, binds the parts written as names, and takes a guard, `if` and a condition after the pattern. None of this is implemented, and the guard is not parsed:

```ents
// Not implemented.
type Point = (x: i32, y: i32)

func describe(p: Point) -> []u8 => match p {
  Point(0, 0) => "origin"
  Point(0, y) => "on the y axis"
  Point(x:, y: 0) => "on the x axis"
  (x, y) if x == y => "on the diagonal"
  _ => "elsewhere"
}
```

In the design, the case of a name says what it is:

- **Upper case** (`Point`, `Rgb`): a type constructor or an enum variant
- **lower case** (`x`, `y`): a binding, which introduces a variable
- **literals** (`0`, `'a'`, `true`): an exact match
- **`_`**: a wildcard, which matches anything and binds nothing

#### Pattern Matching on Enums

> **Not implemented.** Enum types are not implemented ([2.9](#29-enum-types-algebraic-data-types)), and a variant pattern is accepted and never matches (a known bug).

In the design, `match` takes an enum value apart by its variant:

```ents
// Not implemented.
func describe(c: Color) -> []u8 => match c {
  Red => "red"
  Green => "green"
  Blue => "blue"
  Rgb(r, g, b) => "a mix"
  Grey(level) => "grey"
  Darker(inner) => describe(inner.*)
}
```

In the design, a `match` on an enum is exhaustive: every variant is handled, or there is a `_` arm. As implemented, no `match` is checked for coverage: one that no arm matches traps ([5.4](#54-match-expressions)).

### 6.4 If-Let Bindings

`if let name = value { ... }` runs its first branch when `value` has a value, with `name` bound to it: an optional pointer, slice or host reference that is not none, or an index, range or element address that is in range. What it checks, the type of the binding, where the binding is seen, and how it works as a value are in [`if let` Bindings](#if-let-bindings).

The pattern of an `if let` is one name. Any other is refused, `_`, a literal, a tuple and a constructor alike (`if let only supports simple bindings`), and so is a value with nothing to check (`if let requires an optional expression or bounds-checked index`). An `elif let` branch is accepted but binds nothing (a known bug): write a second `if let` after the first, or inside its `else`.

<!-- spec:begin compile -->

```ents
data names = ["ab", "cde"]

// The length of the name at i, else of the one at j, else 0.
func either(i: u32, j: u32) -> u32 {
  if let a = names[i] {
    return a.len
  }
  if let b = names[j] {
    return b.len
  }
  return 0
}

test "if let binds one name" {
  assert either(1, 0) == 3
  assert either(7, 0) == 2
  assert either(7, 9) == 0
}
```

```ents
data cells = [7:u32, 8, 9]

func a(p: ?*u32) -> u32 {
  if let _ = p {
    return 1
  }
  return 0
}

func b(i: u32) -> u32 {
  if let (x, y) = cells[i] {
    return x
  }
  return 0
}

func c(n: u32) -> u32 {
  if let m = n {
    return m
  }
  return 0
}
```

```errors
if let only supports simple bindings
if let only supports simple bindings
if let requires an optional expression or bounds-checked index
```

<!-- spec:end -->

> **Not implemented:** constructor patterns in `if let`, to test for an enum variant and take it apart. In the design:

```ents
// Not implemented.
if let Rgb(r, g, b) = color {
  draw_rgb(r, g, b)
} elif let Hsl(h, s, l) = color {
  draw_hsl(h, s, l)
} else {
  draw_default()
}
```

### 6.5 Let Destructuring

`let` and `set` take a value apart with a binding pattern ([6.1](#61-pattern-forms)): by position, by field name, nested by position, or as names after `let` without parentheses. A `let` declares the variables ([3.3](#33-variables)); a `set` assigns variables that exist ([4.5](#45-assignment-and-compound-assignment)). Both take apart tuples, structs and the several results of a call, not a slice (`cannot destructure non-tuple type: []u8`: read its `.ptr` and `.len`). The whole value is computed before any variable is given its part.

<!-- spec:begin compile -->

```ents
type Point = (x: f64, y: f64)
type Segment = (from: Point, to: Point)

func divmod(a: u32, b: u32) -> (q: u32, r: u32) => (a / b, a % b)

func length2(s: Segment) -> f64 {
  let (from:, to: end) = s           // by name: from, and to bound as end
  let (x0, y0) = from                // by position
  let (x:, y:) = end
  return (x - x0) * (x - x0) + (y - y0) * (y - y0)
}

test "let takes a value apart" {
  let q, r = divmod(17, 5)           // without parentheses, by position
  let (a, (b, c)) = (1, (2, 3))      // nested
  assert q == 3 && r == 2
  assert a + b + c == 6
  assert length2(Segment(Point(1.0, 1.0), Point(4.0, 5.0))) == 25.0
}
```

<!-- spec:end -->

> **Not implemented:** a constructor pattern, `let Point(x, y) = p`, is a syntax error. Write `let (x, y) = p`, or `let (x:, y:) = p` to take the fields by name.

---

## 7. Modules

A program is one or more source files, and each file is a *module*. The file given to the compiler is the *entry module*; the program is the entry module and every module it imports, directly or through others, and it compiles to one WebAssembly module. A module takes what it needs from outside through imports, from the host or from another source file, and offers what it has through exports.

Each function, global and `data` declaration of each module of the program is in the output, whether anything uses it or not. A generic is the exception: only its instances are, one for each set of compile-time arguments the program uses ([8.4](#84-instances)). An optimized build (`encantis wasm -O` or `--release`) can remove what nothing uses; an unoptimized one keeps it all. So a library that should cost a program nothing it does not use keeps its ordinary functions apart from its generics, in files of their own: `lib/fixedvec.ents` and `lib/ring.ents` hold generics only and import nothing, and the helpers that allocate them on the stack of `lib/stack.ents` are in `lib/fixedalloc.ents`, so a program that does not import that file has none of the stack.

### 7.1 Imports

An import names a module, then the name of each thing it takes from it and that thing's declaration:

```text
import "module" "name" Item

import "module" (
  "name" Item
  "name" Item
  ...
)

Item = func local(parameters) -> results        a function; local and -> results may be left out
     | global local: Type                       a global
     | func Name(comptime parameters) -> type   a generic type, from a source module only
```

- The first string is the module. A string that starts with `./`, `../` or `/` names a source file (below); any other string is a module of the host, `"env"` or `"wasi_snapshot_preview1"` for instance, and is passed to the host as it is written.
- The second string is the name the other side exports. `local` is the name the thing has in this module. The two may differ, so an import renames. Without a local name (`"now" func() -> f64`) the local name is the import's; one that is not an identifier, such as `"console.log"`, then cannot be called, so give it a local name.
- The declaration is written as one in the module would be, without a body: a function's parameters and results as in [3.4](#34-functions) (a host function's parameters may be types without names, `func(i32, i32)`), a global's type after a colon, with no value.
- The grouped form takes one or more items, one after another, with no commas between them. An import, like a declaration, can span lines.
- An import stands at module level, anywhere in the file, and its names are module-level names like those the module declares: they can be used above the import, and a `let` cannot take one (`'log' is already declared in this scope`). An import inside a `test` block is part of the program only when the tests are built, and only for the files whose tests are run ([Tests](#tests)).

Functions that share a name ([3.4](#functions-that-share-a-name)) can be imported under one local name, each with its own parameter types; a local name taken twice with the same parameter types is an error (`'log' is already declared with parameters (i32)`). The same import can be taken twice under two local names.

#### Host imports

A function or global imported from the host is a wasm import, of the module and name written. Its declaration is the whole contract: the host must provide a function or global of that wasm type, as [7.2](#72-exports) says each Encantis type is held. A function is called like any other. A host that reads or writes what a pointer or slice points to, a string given to `log` here, needs the memory exported ([7.3](#73-memory-declarations)):

<!-- spec:begin compile -->

```ents
// The host's "console_log" is called log here
import "env" "console_log" func log(msg: []u8)

// Several items from one module, one after another
import "env" (
  "now" func() -> f64              // called now(): no local name, so the import's
  "columns" global columns: u32
)

// The host reads the strings given to log
export memory

// Logs whether the frame that began at `start` took too long
export func end_frame(start: f64) {
  log(if now() - start > 16.0 { "slow frame" } else { "frame" })
}

// The row of cell i on a screen `columns` cells wide
export func row(i: u32) -> u32 => i / columns
```

<!-- spec:end -->

A generic cannot be imported from the host: `a host import cannot have comptime parameters`.

A value that comes in from the host, as an imported function's result or an imported global's value, is taken as its wasm value: nothing checks that a `u8` is below 256 or a `bool` is 0 or 1. The host has to give values of the declared types. A plain host type is the exception: it is checked for null where it comes in ([2.13](#213-host-references)).

A global imported from the host is the host's, given once when the module starts, so it is read-only: assigning it, a field or an element of it, with `=`, a compound assignment or `set`, is an error. What it points to is not the global: a `*mut` global imported from the host can be written through. A global of several wasm values is imported as one wasm global per value, named as [7.2](#72-exports) says: `size` below is the host's `size_w` and `size_h`.

<!-- spec:begin compile -->

```ents
type Size = (w: i32, h: i32)
import "env" (
  "width" global width: i32
  "size" global size: Size
  "cells" global cells: *mut [4]i32
)

func a() { width = 1 }
func b() { width += 1 }
func c() { size.h = 2 }
func d() { set width = 3 }
func e() { cells[0] = width + size.w }
```

```errors
cannot assign to 'width': a global imported from the host is read-only
cannot assign to 'width': a global imported from the host is read-only
cannot assign to 'size': a global imported from the host is read-only
cannot set 'width': a global imported from the host is read-only
```

<!-- spec:end -->

#### Source modules

A module string that starts with `./`, `../` or `/` names another source file: a path from the directory of the importing file (`/`: from the root of the file system), to which `.ents` is added unless it ends in `.ents`. What is imported is what that file exports ([7.2](#72-exports)), and the two are compiled into one wasm module: a call of an imported function is a direct `call`, and an imported global is the other module's global itself, read and written as any global is.

Each file is one module, however many modules import it and however they write its path: its globals and its data exist once in the program. Two files, the second importing the first under names of its own:

<!-- spec:begin compile -->

```ents
// stats.ents
export global calls: u32 = 0

// How many times c occurs in s
export func count(s: []u8, c: u8) -> (n: u32) {
  calls += 1
  for b in s {
    if b == c { n += 1 }
  }
}

test "count" {
  assert count("banana", 'a') == 3
  assert calls == 1
}
```

```ents
// main.ents
import "./stats" (
  "count" func count_of(s: []u8, c: u8) -> u32
  "calls" global calls: u32
)

export func lines(text: []u8) -> u32 => count_of(text, '\n') + 1
export func reset() { calls = 0 }

test "lines" {
  assert lines("a\nb\nc") == 3
  assert calls == 1
  reset()
  assert calls == 0
}
```

<!-- spec:end -->

The declaration an import writes is checked against nothing: what the other module exports under the name is what is imported, with its own signature, and the importing module is checked against that. Write it as the export is anyway: it is what a reader of the importing file sees, and what an editor knows of the function when it checks that file without the other (below). The kind must match, and the name must be exported:

| Mistake | Error |
|---|---|
| A name the module does not export | `'add' is not exported from './util'` |
| `func` for a global or a generic type | `'counter' in './util' is not a function` |
| `global` for a function or a generic | `'add' in './util' is not a global` |
| `func Name(...) -> type` for anything but a generic type | `'add' in './util' is not a generic type` |
| A path that names no file | `Module not found: /home/me/app/util.ents` |
| Modules that import each other, directly or through others | `Import cycle detected: a.ents → b.ents → a.ents` |

The source modules of a program form a graph without cycles: when two modules need each other, what both need goes into a third that each imports.

Types are structural, so a struct type that two modules share is declared again (or written out) in each; a `type` is not imported. A host type is the exception that keeps the rule: it is its name, program-wide, so a module that shares `Canvas` with another declares `type Canvas = host` too, and is then given the same type ([2.13](#213-host-references)).

Several imports can take one local name, when their parameter types differ: they then share it as functions declared in the module do ([3.4](#functions-that-share-a-name)). `lib/map.ents` imports the `hash` and `eq` functions of `lib/set.ents`, exported under names of their own, as one `hash` and one `eq`:

<!-- spec:begin compile -->

```ents
import "../lib/set" (
  "hash_u32" func hash(k: u32) -> u32
  "hash_u64" func hash(k: u64) -> u32
  "hash_bytes" func hash(k: []u8) -> u32
)

export func mix(id: u32, at: u64, name: []u8) -> u32 => hash(id) ^ hash(at) ^ hash(name)
```

<!-- spec:end -->

A generic function is imported with its signature, comptime parameters included, and a generic type as the function it is, with no body: `func`, its upper-case name, its parameters and `-> type`. Both are the generics of the module that declares them ([8.8](#88-generics-across-modules)). A generic is renamed on import as a function is, which is how two libraries' generics of one name are used in one module: `lib/vec.ents` and `lib/fixedvec.ents` both have a `push`, and a generic's name is unique in its module, so a module that uses both imports one of them under another name:

<!-- spec:begin compile -->

```ents
import "../lib/fixedvec" (
  "FixedVec" func FixedVec(comptime n: u32, comptime T: type) -> type
  "push" func fixed_push(comptime n: u32, comptime T: type, v: *mut FixedVec(n, T), x: T) -> bool
)
import "../lib/vec" (
  "Vec" func Vec(comptime T: type) -> type
  "push" func push(comptime T: type, v: *mut Vec(T), x: T)
)

data cells = mut [0:u32; 2]
data recent: FixedVec(2, u32) = mut (0, cells)

// Adds x to both; false where the fixed one is full
export func add(all: *mut Vec(u32), x: u32) -> bool {
  all.push(x)
  return recent.fixed_push(x)
}

test "the fixed one fills up" {
  assert recent.fixed_push(1)
  assert recent.fixed_push(2)
  assert !recent.fixed_push(3)
}
```

<!-- spec:end -->

When a file is checked without the files it imports (the editor's web worker, a reference example), what an import writes is all there is of it: an imported function is the signature its import writes, and its calls are checked against that. A generic type is unknown there, and so is anything made of it: such a file lists no errors, and has one warning, `imported generic types are resolved only when the program is checked`. The command line and the desktop editor check the program, every module with the modules it imports.

### 7.2 Exports

`export` before a declaration gives it a name outside the module. What can be exported is a function (`func`, also `inline func`), a global, the memory ([7.3](#73-memory-declarations)), and a generic function or generic type, which other source modules can then import. `data`, `def`, `type` and an import cannot be exported (a syntax error): a module shares data through a function or a global that holds its address.

The export name is the declaration's own name, and `"memory"` for the memory. `export "name"` before the declaration gives another name, any string; the declaration keeps its own name in the module. Each export name is used once in a module, so functions that share a name are exported under names of their own:

<!-- spec:begin compile -->

```ents
// Exported as "add", its own name
export func add(a: i32, b: i32) -> i32 => a + b

// Exported as "area"; in the module it is still rect_area
export "area" func rect_area(w: u32, h: u32) -> u32 => w * h

// Functions that share a name are exported under names of their own
export "hash_u32" func hash(k: u32) -> u32 => k * 0x9e3779b1
export "hash_u64" func hash(k: u64) -> u32 => hash((k ^ (k >> 32)) as u32)

// A global the host can read and write, as "frames"
export global frames: u32 = 0

// A struct is one wasm global per field: "size_w" and "size_h"
export global size: (w: u32, h: u32) = (640, 480)

// The memory, as "memory"
export memory

test "exported functions are ordinary functions here" {
  assert add(2, 3) == 5
  assert rect_area(3, 4) == 12
  assert hash(1:u64) == hash(1:u32)
  assert size.w * size.h == 307200
}
```

```ents
export func hash(k: u32) -> u32 => k * 0x9e3779b1
export func hash(k: u64) -> u32 => hash(k as u32)
```

```errors
export name 'hash' is used twice: give one an explicit name, as in export "hash_u64" func hash(...)
```

<!-- spec:end -->

Only the entry module's exports reach the host. In a module that another imports, `export` makes a name importable and nothing more; the memory is the exception, since a program has one ([7.3](#73-memory-declarations)). An exported function is still an ordinary function of its module, called from it like any other.

A generic function or generic type is never exported to the host, since there is no one function of it (and nothing of a generic type exists at run time): its `export` makes it importable by other source modules, and in an entry module it emits nothing, so a library of generics compiles on its own to a module with none of them. To export an instance, write a wrapper: `export func push_u32(v: *mut Vec(u32), x: u32) { push(v, x) }`.

> **Not implemented:** exporting a function without a name, `export "inc" func(x: i32) -> i32 => x + 1`. The compiler accepts it and writes a module that does not assemble; without the export name it stops with an internal error. Give the function a name.

#### What the host sees

An exported or imported function is a wasm function whose parameters and results are the registers of its Encantis parameters and results, in order ([9.3](#93-wasm-type-mapping)):

- a number, `bool` or pointer is one value: `i32` for everything of 32 bits or fewer (`bool`, `u8`, `i16`, `u32`, `*T`, `[*]T`, `*[N]T`), `i64`, `f32` or `f64`; a `u128` is two `i64`s, the low half first, and wider integers one more `i64` for each 64 bits;
- a slice is two `i32`s, its address and its length;
- a struct or tuple is its fields, and a fixed array `[N]T` its N elements, each flattened in turn;
- a host type is an `externref` ([2.13](#213-host-references));
- several results are a wasm multi-value result.

Where a parameter is several wasm values, the WAT names each after its part: `points_ptr` and `points_len` for a slice, `to_x` for a field, `k_0` for an element. The `.wasm` file keeps no names; only the order counts. So `nearest` here is `(param i32 i32 f32 f32) (result i32 f32)` to the host, which passes the address and length of an array of points it wrote in the module's memory:

<!-- spec:begin compile -->

```ents
type Point = (x: f32, y: f32)

export memory

// The point of `points` nearest to `to`, and its squared distance
export func nearest(points: []Point, to: Point) -> (index: u32, dist: f32) {
  dist = 3.4e38
  for i, p in points {
    let dx = p.x - to.x
    let dy = p.y - to.y
    let d = dx * dx + dy * dy
    if d < dist {
      index = i
      dist = d
    }
  }
}

test "nearest" {
  let (index:, dist:) = nearest([(x: 0.0, y: 0.0), (x: 3.0, y: 4.0), (x: 1.0, y: 1.0)], (x: 3.0, y: 3.0))
  assert index == 1
  assert dist == 1.0
}
```

<!-- spec:end -->

The host is trusted to pass values of the declared types. Nothing is checked or masked where a value comes in: a `u8` parameter given 300 is 300 in the function, and a `u32#6` parameter given 7 is 7, though the checker took it to be below 6 ([Ranged Integers](#ranged-integers)). A plain host type is the exception, checked for null ([2.13](#213-host-references)). An exported function that takes a many-pointer (`[*]T`) is warned of, `exported function parameter 'p' uses [*] many-pointer — consider []u8 slice for a safe API`: the host can pass any address and no length, where a slice carries its length.

An exported global is a mutable wasm global, which the host can read and write; one of several values is one wasm global per value, named `name_part` as a parameter is (`size_w`, `order_ptr` and `order_len` for a slice, `pos_0` and `pos_1` for a tuple exported as `"pos"`). A global imported from the host is an immutable wasm global.

#### Starting and running

A module has no code that runs when it starts: a global starts with its constant value, and the data is in the memory as the module is instantiated. The one exception is the null check of the plain host-type globals the module imports, which runs as the wasm start function ([2.13](#213-host-references)). No other code runs but the functions the host calls.

A command-line program that a WASI host runs, as `encantis run file.ents` does, exports its entry point as `_start` and its memory as `memory`, and imports only from `wasi_snapshot_preview1` (as `lib/io.ents` does):

<!-- spec:begin compile -->

```ents
import "wasi_snapshot_preview1" "fd_write" func fd_write(fd: i32, iovs: [][]u8, written: *mut u32) -> i32

export memory

export "_start" func main() {
  fd_write(1, ["Hello, world!\n"], &0:u32)
}
```

<!-- spec:end -->

`encantis run` gives the module no import but WASI's: one from any other module stops it before it starts. It runs `_start` and needs the memory exported under the name `memory`.

### 7.3 Memory Declarations

A program has at most one linear memory, measured in pages of 64 KiB (65536 bytes). It has one when it uses memory: when it has data (a `data` declaration, or a literal laid out in memory), when a pointer or slice is anywhere in it (a parameter, a load or a store), or when a module declares the memory. A program that uses none has no memory.

A memory declaration, `memory`, then optionally a minimum and a maximum in pages, chooses the memory's size; `export` before it also gives it to the host:

| Declaration | Minimum | Maximum | Exported as |
|---|---|---|---|
| `memory` | what the data needs | none | not exported |
| `memory 8` | 8 pages | none | not exported |
| `memory 8 256` | 8 pages | 256 pages | not exported |
| `export memory` | what the data needs | none | `"memory"` |
| `export memory 8 256` | 8 pages | 256 pages | `"memory"` |
| `export "mem" memory 8` | 8 pages | none | `"mem"` |

- The minimum is the number of pages the module has when it starts. Without one written, it is what the data needs: `max(1, ceil(sizeof data / 65536))`, where `sizeof data` is the address just past the last byte of data, which starts at address 8 ([9.0](#90-data-layout)).
- The maximum is how far the memory may grow. Without one, none is written in the module, and the engine's own limit applies.
- A program that uses memory and declares none gets that memory with the minimum the data needs, no maximum, and no export. The declaration is needed only to choose the sizes or to export the memory.
- The numbers are decimal integer literals with `min <= max <= 65536` (65536 pages are 4 GiB), and the minimum is at least what the data needs. The compiler does not check these yet: a module that breaks one fails when it is assembled, or when it is instantiated (`segment is too big` for a minimum too small for its data). Leave the minimum out unless the program needs more than its data.
- A program has one memory declaration at most, in any one of its modules. Where it is, its sizes and its export are the program's memory's, also in a module that another imports.

The host sees the memory only when it is exported. Exporting it is what lets a host read a string a function returns or write an array it passes in, and WASI needs it under the name `memory` ([Starting and running](#starting-and-running)).

<!-- spec:begin compile -->

```ents
// No size written: the minimum is what the data needs, 100008 bytes in 2 pages
export memory

data buf = mut [0:u8; 100000]

// Fills the buffer, and returns its last byte
export func fill(v: u8) -> u8 {
  buf[..] = v
  return buf[99999]
}

test "the data ends at sizeof data" {
  assert fill(7) == 7
  assert sizeof data == 100008
}
```

<!-- spec:end -->

The memory does not grow while the program runs, unless the host grows an exported one: `memory-size` and `memory-grow` are not implemented ([10.3](#103-memory-builtins)). Nothing in it is allocated but the data: the rest, from `sizeof data` up, is the program's to use as it likes ([`lib/stack.ents`](../lib/stack.ents) is one way).

---

## 8. Generics

A generic function is written once and compiled once for each type it is used with. Types are passed as compile-time parameters; nothing of them exists at run time. A generic type ([8.5](#85-generic-types)) is a type with type parameters, a comptime function parameter ([8.6](#86-comptime-function-parameters)) is how a generic is given a function to call, and a comptime value parameter ([8.7](#87-comptime-value-parameters)) is how it is given a number, such as the length of an array, `[n]T`. Two things of the rest of the language are what make generic code read well: method-call syntax, `v.push(7)` ([4.9](#49-method-call-syntax)), and functions that share a name ([3.4](#functions-that-share-a-name)), through which each type brings its own `hash` and `eq` ([8.3](#83-requirements)).

Every example of this chapter is compiled and its tests run, as the reference's examples are; the programs under [`examples/generics/`](../examples/generics) carry more tests of the same functions.

<!-- spec:begin compile -->

### 8.1 Compile-Time Parameters

A parameter marked `comptime` is given at compile time. The function is compiled once for each distinct set of compile-time arguments it is called with, and each copy is an ordinary function that has only the remaining parameters.

```ents
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }

export func widest(a: u32, b: u32) -> u32 => max(u32, a, b)
export func longest(a: f64, b: f64) -> f64 => max(a, b)
```

compiles to exactly the module this does:

```ents same-wasm
func max_f64(a: f64, b: f64) -> f64 => if a > b { a } else { b }
func max_u32(a: u32, b: u32) -> u32 => if a > b { a } else { b }

export func widest(a: u32, b: u32) -> u32 => max_u32(a, b)
export func longest(a: f64, b: f64) -> f64 => max_f64(a, b)
```

A **type parameter** is written `comptime T: type`. Its name starts with an upper-case letter, like every type name. Inside the function `T` is a type: it can be used wherever a type can be written (`x: T`, `[]T`, `*mut T`, `sizeof(T)`, `p as [*]mut T`) and passed on as a type argument (`fact(T, n - 1)`). A comptime parameter may also be a function ([8.6](#86-comptime-function-parameters)) or a number, `comptime n: u32` ([8.7](#87-comptime-value-parameters)). `type` is written in two places only: as the type of a comptime parameter, and as the result of a generic type ([8.5](#85-generic-types)). A type is not a value: `let t: type = u32` is a syntax error.

Rules:

1. Comptime parameters may appear anywhere in the parameter list; by convention they come first, in the order a type writes them: a value parameter `n` before a type parameter `T`, as in `[n]T`. A parameter's type may mention any comptime parameter of the same function.
2. `comptime` is only written in the parameter list of a named function declared with `func` at module level, and in the signature a source import writes for such a function ([7.1](#71-imports)). Every parameter of such a function has a name.
3. A function with a comptime parameter is a *generic function*. It is not a value: it cannot be stored, passed as an argument, or exported to the host (`generic function 'max' must be called`). It can only be called. Its name is unique in its module.
4. A type parameter's name is its own: it is not the name of a type the module declares, before or after the function, and no two parameters of the function share a name.
5. A generic function is checked when it is instantiated, with its comptime arguments filled in, and not before: its body, and its signature beyond the rules above. One that is never called is only parsed, and nothing is emitted for it; a mistake in it, such as an unknown type in its signature, is reported once something calls it, in that instance ([8.3](#83-requirements)).

`comptime` is a reserved word.

Three ways of writing a parameter that are near misses are refused with the fix, and so are the other breaches of these rules:

```ents
type Pt = (q: i32, r: i32)

func a(comptime t: type, x: u32) -> u32 => x
func b(T: type, x: u32) -> u32 => x
func c(comptime N: u32, p: *[N]u8) -> u8 => p[0]
func d(comptime Pt: type, x: Pt) -> Pt => x
func e(comptime T: type, comptime T: type, x: T) -> T => x
func f(comptime T: type, u32) -> u32 => 0
```

```errors
a type parameter's name starts with an upper-case letter: write 'comptime T: type'
a parameter of type 'type' must be comptime: write 'comptime T: type'
a value parameter's name starts with a lower-case letter: write 'comptime n: u32'
type parameter 'Pt' has the name of a type declared in this module
type parameter 'T' is declared twice
a generic function's parameters need names
```

### 8.2 Calling a Generic Function

A call to a generic function is written in one of two forms.

**Explicit.** Every parameter gets an argument, in order. The argument of a type parameter is a type, written as it is after a colon:

```ents
type Pt = (q: i32, r: i32)

func pick(comptime T: type, first: bool, a: T, b: T) -> T => if first { a } else { b }
func head(comptime T: type, xs: []T) -> T => xs.ptr[0]

export func a(c: bool, x: u8, y: u32) -> u32 => pick(u32, c, x, y)      // x is widened, as for any u32 parameter
export func b(c: bool, p: Pt, q: Pt) -> Pt => pick(Pt, c, p, q)
export func c(c: bool, p: (i32, i32), q: (i32, i32)) -> (i32, i32) => pick((i32, i32), c, p, q)
export func d(xs: [][]u8) -> []u8 => head([]u8, xs)
export func e(xs: []*mut Pt) -> *mut Pt => head(*mut Pt, xs)
export func f(xs: []u64) -> u64 => head(u64, xs)
export func g(c: bool, n: []u8, p: Pt) -> []u8 => pick((name: []u8, at: Pt), c, (name: n, at: p), (name: "-", at: p)).name
```

In that position a name is read as a type even if a variable of the same name is in scope (`u8` there is the type, as it is in `let x: u8`).

**Inferred.** All type parameters are left out, and the compiler finds them from the other arguments:

```ents
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }
func head(comptime T: type, xs: []T) -> T => xs.ptr[0]
func swap(comptime T: type, a: *mut T, b: *mut T) {
  let tmp = a.*
  a.* = b.*
  b.* = tmp
}

data primes = [2:u16, 3, 5, 7]

export func a(x: u32, y: u32) -> u32 => max(x, y)          // T = u32
export func b(x: f64) -> f64 => max(x, 0.5)                 // T = f64; the literal is an f64
export func c(x: u64) -> u64 => max(1, x)                   // T = u64, decided by x
export func d(xs: []u64) -> u64 => head(xs)                 // T = u64, from []T
export func e() -> u16 => head(primes)                      // T = u16: a data array is a slice here
export func f(p: *mut i64, q: *mut i64) { swap(p, q) }      // T = i64, from *mut T

test "inferred calls" {
  assert a(3, 7) == 7
  assert b(0.25) == 0.5
  assert c(0) == 1
  assert e() == 2
}
```

**Which form a call is** depends only on how many arguments it has. If a function has `P` parameters of which `K` are type or value parameters, a call with `P` arguments is explicit and a call with `P - K` arguments is inferred. Anything else is an error that says both counts. There is no form that writes some comptime arguments and infers others. Arguments are positional. A value parameter is inferred from the length of an array in an argument's type ([8.7](#87-comptime-value-parameters)).

#### How type parameters are inferred

1. **The first argument that can decide a type parameter decides it.** Go through the parameters left to right. The first one whose written type mentions `T`, and whose argument has a type of its own, decides `T`.
2. **Deciding is matching shapes.** The parameter's written type is laid over the argument's type: `T` against `u32` gives `T = u32`; `[]T` against `[]u64` gives `T = u64`; `*mut T` against `*mut i64` gives `T = i64`; `(T, U)` against `(i32, f64)` gives both. Matching looks through the conversions an argument gets anyway, and through nothing else:

   | Parameter | Argument | Result |
   |---|---|---|
   | `*T` | `*mut X` | `T = X` |
   | `[]T` | `[]mut X` | `T = X` |
   | `[]T`, `[*]T` | `*[N]X` (a `data` array, a string) | `T = X` |
   | `?*T` | `*X` | `T = X` |
   | `*T` | `[*]X` | no match: what a many-pointer points to is not a type by itself. `[*]T` matches it |
   | `T` | a value known to lie in a range, `u32#12` | `T = u32` (the range is dropped, also from the values a tuple argument is made of) |
   | `T` | `u8`, where a later argument is `u32` | `T = u8`: numbers are not widened to make arguments agree |
   | `*Vec(T)` | a pointer to a struct of `Vec`'s shape | `T` from the field that is made of it ([8.5](#85-generic-types)) |
   | `(T) -> T` | a function, `inc` | `T` from its parameter, or else its result |
   | `(T, T)` | a tuple with a literal in it, `(i, 1)` with `i: u32` | `T = u32`, from its typed part |

   Type aliases are transparent, as everywhere.
3. **Untyped literals never decide.** `7`, `0.5` and `[1, 2, 3]` have no type of their own; they take the type the parameter turns out to have. A literal with a type written on it (`7:u8`) is typed and can decide. A tuple decides by the parts of it that are typed, and its literals decide nothing: with `p: (T, T)`, `keep((i, 1))` for an `i: u32` gives `T = u32`, and the `1` is then a `u32`; `keep((1, 2))` decides nothing. So does a struct literal, `(x: i, y: 1)`, and `&` of either. An array literal is untyped as a whole, even where an element has a type.
4. **Every other argument is an ordinary argument.** Once `T` is decided, the remaining arguments are checked against the now-concrete parameter types exactly as for a hand-written function: the same implicit conversions, the same errors.
5. **Nothing is guessed.** If no argument decides a type parameter the call is an error and the type has to be written. That includes a call whose only candidates are literals (`max(1, 2)`) and a type parameter that appears only in the result (`zero()`): the expected type of the call is not used. An argument that has an error of its own decides nothing either, and the call adds no error to it.
6. **`()` is never a type argument.** It has no values, so there is nothing to pass for a parameter of that type. An argument without a value, such as a call of a function that returns nothing, is an error where it stands: `argument 1 of 'id' has no value`.

```ents
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }

func f(a: u8, b: u32) -> u32 => max(a, b)
```

```errors
argument 2: cannot assign u32 to u8
```

`max(b, a)` is accepted (`T = u32`, and `a` widens like any `u8` passed for a `u32`), and so is `max(u32, a, b)`.

```ents
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }
func zero(comptime T: type) -> T => 0

func f() -> i32 => max(1, 2)
func g() -> u32 => zero()
```

```errors
cannot infer T for 'max' from untyped literals: write max(i32, ...) or give a literal its type (1:i32)
cannot infer T for 'zero': write the type argument, as in zero(u32)
```

### 8.3 Requirements

A generic states no requirements. It uses its type parameter, and each use is checked for the concrete type when the generic is instantiated. There are no traits or interfaces: what a type must provide is whatever the generic's body does with it.

Operators are requirements. The operands of an operator are single values: numbers, `bool`s and pointers, each operator with the types [chapter 4](#4-expressions--operators) gives it. No operator is defined for structs, tuples, slices or arrays:

```ents
type Pt = (q: i32, r: i32)
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }

export func f(a: Pt, b: Pt) -> Pt => max(a, b)
```

```errors
'>' cannot be applied to Pt and Pt, in max(T = Pt)
```

This holds for every operator, whether it stands between two operands, before one (`-a`, `~a`, `!a`) or in a compound assignment:

```ents
type Pt = (q: i32, r: i32)
func neg(comptime T: type, a: T) -> T => -a
func add(comptime T: type, a: T, b: T) -> T {
  let sum = a
  sum += b
  return sum
}

export func f(a: Pt, b: Pt) -> Pt => add(neg(a), b)
```

```errors
'-' needs a number, not Pt, in neg(T = Pt)
'+=' cannot be applied to Pt and Pt, in add(T = Pt)
```

The error is reported at the line of the generic's body where it occurs, with types printed as they are in that instance (never as `T`), followed by the instance. An instance shared by calls that wrote `Meters`, `Feet` and `f64` reads the same for all of them: an alias that only renames a type is printed as the type, a struct by its name. Each instance is checked once, so its errors appear once however many calls use it. Every other error of the language can occur in an instance and reads as usual plus the `, in ...` suffix. A module's own errors are listed first, then those of its instances.

The command line also prints the call that first asked for the instance and, where that call is itself in an instance, the call that asked for that one, four of them at most. The editor shows them as the error's related locations.

```text
shapes.ents:2:51: '>' cannot be applied to Pt and Pt, in max(T = Pt)
  required from shapes.ents:4:38
```

**Calls are requirements too.** A call in a generic body, `eq(a, b)` or `k.hash()`, is resolved when the instance is checked, by its name and the types of its arguments ([3.4](#functions-that-share-a-name)). So each type a generic is used with brings its own function:

```ents
func hash(k: u32) -> u32 => k * 0x45d9f3b
func hash(k: []u8) -> (h: u32) {
  h = 0x811c9dc5
  for w in k {
    h = (h ^ (w as u32)) * 0x01000193
  }
}
func eq(a: u32, b: u32) -> bool => a == b
func eq(a: []u8, b: []u8) -> bool {
  return false when a.len != b.len
  for i in a.len {
    return false when a.ptr[i] != b.ptr[i]
  }
  return true
}
func bucket(comptime K: type, k: K, n: u32) -> u32 => k.hash() % n
func same(comptime K: type, a: K, b: K) -> bool => hash(a) == hash(b) && a.eq(b)

export func f(a: []u8, b: []u8) -> u32 => if same(a, b) { bucket(a, 16) } else { bucket(7:u32, 3) }
export func g(a: u32, b: u32) -> bool => same(u32, a, b)
```

`same` for `K = []u8` calls `hash(k: []u8)` and `eq(a: []u8, b: []u8)`; for `K = u32` it calls the other pair. All of them are direct calls, and the module is the one with every function written out under a name of its own:

```ents same-wasm
func hash_u32(k: u32) -> u32 => k * 0x45d9f3b
func hash_bytes(k: []u8) -> (h: u32) {
  h = 0x811c9dc5
  for w in k {
    h = (h ^ (w as u32)) * 0x01000193
  }
}
func eq_u32(a: u32, b: u32) -> bool => a == b
func eq_bytes(a: []u8, b: []u8) -> bool {
  return false when a.len != b.len
  for i in a.len {
    return false when a.ptr[i] != b.ptr[i]
  }
  return true
}
func bucket_bytes(k: []u8, n: u32) -> u32 => hash_bytes(k) % n
func bucket_u32(k: u32, n: u32) -> u32 => hash_u32(k) % n
func same_bytes(a: []u8, b: []u8) -> bool => hash_bytes(a) == hash_bytes(b) && eq_bytes(a, b)
func same_u32(a: u32, b: u32) -> bool => hash_u32(a) == hash_u32(b) && eq_u32(a, b)

export func f(a: []u8, b: []u8) -> u32 => if same_bytes(a, b) { bucket_bytes(a, 16) } else { bucket_u32(7:u32, 3) }
export func g(a: u32, b: u32) -> bool => same_u32(a, b)
```

A type that does not bring a function the body calls is one error for that function, where the generic is first used with the type. It is reported once for the instance, however many calls in the body ask for the function, and it reads the same whether no function of the name takes the type or none of that name is declared at all:

```ents
func hash(k: u32) -> u32 => k * 0x45d9f3b
func hash(k: []u8) -> u32 => k.len
func same(comptime K: type, a: K, b: K) -> bool => hash(a) == hash(b) && eq(a, b)

export func f(a: f64, b: f64) -> bool => same(a, b)
```

```errors
no function 'hash' accepts (f64), in same(K = f64)
no function 'eq' accepts (f64, f64), in same(K = f64)
```

A call with the wrong number of arguments for the one function of its name is a mistake in the body, not a requirement on the type, and reads as it does anywhere (`'eq' expected 2 arguments, got 1, in same(K = u32)`). So is a literal that is wrong as it is written, whatever the type: one without `mut` for a mutable slice (``argument 1: a literal is constant: write `mut "ab"` for a []mut u8, in same(K = u32)``), single quotes where a string is wanted, or a string where a character is.

### 8.4 Instances

An *instance* is one generic function with all its comptime arguments fixed.

- **Identity.** Two calls use the same instance when they name the same generic and their comptime arguments are equal. Types compare structurally, with aliases expanded: `Pt` and the struct `(q: i32, r: i32)` it names are one argument, and so are a type that refers to itself and an alias of it. A host type compares by its name, the one name it has program-wide ([2.13](#213-host-references)): `id(c)` for a `Canvas` and for a `Screen = Canvas` is one instance, and for a `Context` another. The names of a function type's parameters are not part of it. A function given for a comptime function parameter is an argument like a type: two instances are one when their functions are the same function. A number given for a value parameter is one too: two instances are one when theirs are the same number in the parameter's type. Explicit and inferred calls that arrive at the same arguments share the instance, and each call is still checked against the types as it wrote them.
- **Once.** An instance is one function in the output however many calls use it. Across source modules, one whose body calls a function of the module that asked for it is one for each such module ([8.8](#88-generics-across-modules)).
- **On demand.** An instance is created by the first call that needs it. A generic nobody calls has no instances; a generic used only from `test` blocks has instances only in test builds.
- **Zero cost.** An instance is the function you would get by writing the generic out by hand for those arguments, and it compiles to the same bytes. A call compiles to one `call` of the instance with only the non-comptime arguments. Nothing exists at run time for a type parameter, for a generic type, or for a generic that is not used. No function tables and no indirect calls are involved.
- **Statics.** A data literal in a generic body belongs to each instance separately, as it would in hand-written copies; a `mut` literal is one buffer per instance.
- **Recursion.** A generic may call itself or another generic. A generic that instantiates itself with a larger type each time never finishes; the compiler stops with one error after 64 nested instantiations (`too many nested instantiations (64) while instantiating 'f'`), or sooner when one call has led to 1000 instances (`too many instantiations (1000) from one call while instantiating 'f'`) or to type arguments many times the size of its own (`type arguments grow without end while instantiating 'f'`). A type argument written in ordinary code may be of any size.
- **Limits.** A module has fewer than 2^24 (16777216) instances of its generics, and a generic is declared within the first 2^28 bytes (256 MiB) of its file. A call past either is `cannot instantiate 'f': the source is too large or has too many instances`.
- **Place and names.** In the output a generic's place is taken by its instances, in the order of their names. In WAT an instance is named after the generic and its arguments, `$max<u32>`, `$head<''u8>`, `$sort<i32|ascending>`, `$push<8|u32>` (a number in decimal); the exact spelling is not part of the language and names do not reach the `.wasm` file.

```ents
func bytes(comptime T: type, n: u32) -> u32 => n * sizeof(T)
func fact(comptime T: type, n: T) -> T => if n <= 1 { 1 } else { n * fact(T, n - 1) }

export func a() -> u32 => bytes(u64, 3) + bytes((u32, u16), 2)   // 24 + 12
export func b() -> u64 => fact(u64, 20)

test "each instance has its own sizeof, and recursion ends" {
  assert a() == 36
  assert b() == 2432902008176640000
}
```

A recursion whose type argument grows with each level is stopped where it asks for the next level:

```ents
func nest(comptime T: type, x: T) -> u32 => nest((x, x))

export func f() -> u32 => nest(1:u8)
```

```errors
type arguments grow without end while instantiating 'nest'
```

**In the editor.** What a name in a generic's body is depends on the instance, and the editor (hover in the language server, and the `hover`, `definition` and `references` commands) shows what each instance makes of it:

- A parameter, result or local shows the type it is declared with, in terms of the type parameters, and its type in each instance: `x: T — in index_of(T = u32): u32; in index_of(T = f64): f64`. A local whose type is not written is shown in terms of the type parameters where its types in the instances differ as one type parameter's arguments do, and otherwise as each type it is (`f32 or i64`); so it is also where two type parameters are bound alike in every instance, since which one it follows cannot be told. A field after a point is the member in each instance.
- A type parameter shows what each instance binds it to; a value parameter, its declared type and the number each instance was given (`n: u32 — in sum(n = 4): 4; in sum(n = 8): 8`); a comptime function parameter, the function each instance was given.
- A call in the body shows the function each instance calls, where they are not all one function: `eq(y, x)` calls `eq(a: u32, b: u32)` in `index_of(T = u32)` and `eq(a: f64, b: f64)` in `index_of(T = f64)`.
- A generic shows its instances, a call of it the instance it calls, and a method call `x.f(a)` the call `f(x, a)` it is.
- A generic type shows its declaration and its applications (`in Pair(u32): (a: u32, b: u32)`), and its type parameters and fields what each application makes them, also a field of an element it holds (`k` in `items: [*](k: K, v: V)`).

Instances that agree are listed together, and past twelve instances the rest are counted. The references of one of several functions that share a name include a call in a generic's body only where an instance calls that function, and a function no call calls is reported as never used. A generic nothing instantiates has no instance to go by: a call in its body counts as a use of every function of its name, only what is written there (a parameter's type) is shown, and its type parameters and comptime function parameters are found where they are used.

What "zero cost" does not promise: no inlining (a user-declared generic `max` is a call where the builtin `max` is an inline `select`), and no merging of instances that happen to compile to the same bytes (`swap` for `u32` and for `i32` are two functions, as two hand-written functions would be).

**Exporting.** `export func max(comptime T: type, ...)` is accepted and emits nothing: there is no single function to give the host. It makes the generic importable by other source modules ([8.8](#88-generics-across-modules)). To export an instance, export a function that calls it:

```ents
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }

export func max_u32(a: u32, b: u32) -> u32 => max(a, b)
```

### 8.5 Generic Types

A generic type is a function from types to a type. It is declared with `func`, an upper-case name, its comptime parameters, the result `type`, and after `=>` one type, any type: a struct as here, or `*T`, `[n]T`, another generic type applied:

```ents
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
func Pair(comptime A: type, comptime B: type) -> type => (first: A, second: B)

func last(comptime T: type, v: *Vec(T)) -> T => v.ptr[v.len - 1]
func swapped(comptime A: type, comptime B: type, p: Pair(A, B)) -> Pair(B, A) => Pair(B, A)(p.second, p.first)

export func a(v: *Vec(u32)) -> u32 => last(v)
export func b(v: *(ptr: [*]mut f64, len: u32, cap: u32)) -> f64 => last(v)
export func c(p: Pair(u8, u64)) -> Pair(u64, u8) => swapped(p)
export func d() -> u32 => sizeof(Vec(u8)) + sizeof(Pair(u8, u64))     // 12 + 9

test "a pair is swapped, and sizes follow the arguments" {
  let p = c(Pair(u8, u64)(1, 2))
  assert p.first == 2
  assert p.second == 1
  assert d() == 21
}
```

Applying it, `Vec(u32)`, is a type and can be written wherever a type can: a parameter, a result, a field, a cast, `sizeof(Vec(T))`, a `let` annotation, another generic type's body, a type argument. There is no space between the name and the parenthesis (`Vec (u32)` is a syntax error). A generic type's parameters are type parameters, and numbers (`func Ring(comptime n: u32, comptime T: type) -> type`, [8.7](#87-comptime-value-parameters)); a generic type has at least one, and anything else is `generic type 'Vec' takes comptime type and integer parameters only, as (comptime n: u32, comptime T: type)`. All its arguments are always written: `Vec` alone is not a type (`'Vec' is a generic type: write Vec(T)`), and a wrong count is `Vec expects 1 type argument, got 2`.

A generic type is declared at module level, before or after its uses, and its name is unique among the types of its module. Nothing of it exists at run time: one that is never applied is only parsed, and `export func Vec(comptime T: type) -> type => ...` is accepted and gives the host nothing.

**`Vec(u32)` is an alias with parameters.** It *is* the type `(ptr: [*]mut u32, len: u32, cap: u32)`, not a new, distinct type; this is the rule every type name already follows, save a host type, which is its name ([2.13](#213-host-references)). A value built as a plain struct with those fields is a `Vec(u32)`; two generic types with the same body are interchangeable and functions instantiated for them share one copy; `Vec(u8)` and `Vec(u32)` differ because their bodies differ, and the error says so with the names:

```ents
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)

func f(a: *Vec(u8)) -> u32 {
  let b: *Vec(u32) = a
  return b.len
}
```

```errors
cannot assign *Vec(u8) to *Vec(u32)
```

**Inference sees through a generic type** by matching its body: given a `*Vec(u32)`, the parameter `v: *Vec(T)` is laid over `*(ptr: [*]mut u32, len: u32, cap: u32)` and `T = u32` falls out, however the argument's type was written (function `b` above). A type parameter that the body never uses cannot be inferred and must be written at the call:

```ents
func Tagged(comptime T: type) -> type => (id: u32)
func tag(comptime T: type, t: Tagged(T)) -> u32 => t.id + sizeof(T)

func f(t: Tagged(u8)) -> u32 => tag(t)
```

```errors
cannot infer T for 'tag': 'Tagged(T)' does not use T in its fields; write the type argument
```

**Building a value.** A type that is called constructs a value of it. `Vec(T)(p, 0, cap)` constructs like `Point(1, 2)`, by position or by name; a struct literal where the type is known works as for any struct. `T(a, b)` also constructs when `T` is a type parameter that turns out to be a struct or tuple; a generic body that converts numbers writes `x as T`.

```ents
func make(comptime T: type, x: i32) -> T => T(x)

export func f() -> u32 => make(u32, 1)
```

```errors
u32 is not a struct or tuple type: it has no constructor; to convert a number write x as T, in make(T = u32)
```

**Size and layout.** `sizeof(T)` and `sizeof(Vec(T))` are constants in each instance. A struct's size is the sum of its fields' sizes: fields are packed in declaration order with no padding ([9.6](#96-structs-and-slices-in-memory)). `sizeof((bool, u32, []u32))` is 13.

**Where a container's header lives.** A `Vec(u32)` in a local is three wasm locals and has no address. A function that changes a container takes a pointer to it, so the header lives in memory and the program holds a pointer: `vec(u32, 16)` returns `*mut Vec(u32)`.

```ents
data space = mut [0:u8; 1024]
global top: u32 = 0

func alloc(n: u32) -> (p: u32) {
  p = (space as u32) + top
  top += n
}

func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)

func vec(comptime T: type, cap: u32) -> *mut Vec(T) {
  let v = alloc(sizeof(Vec(T))) as *mut Vec(T)
  v.* = Vec(T)(alloc(cap * sizeof(T)) as [*]mut T, 0, cap)
  return v
}

func push(comptime T: type, v: *mut Vec(T), x: T) {
  assert v.len < v.cap
  v.ptr[v.len] = x
  v.len += 1
}

func get(comptime T: type, v: *Vec(T), i: u32) -> T => v.ptr[i]

test "one vector for each element type" {
  let v = vec(u64, 4)
  push(v, 1 << 40)
  push(u64, v, 7)
  assert v.len == 2
  assert get(v, 0) == 1 << 40
  let names = vec([]u8, 2)
  push(names, "tau")
  assert get(names, 0).len == 3
}
```

**A fixed array for T.** With `T = [3]i32`, `[*]mut T` is `[*]mut [3]i32`, a table ([Nesting](#nesting)): each element is a pointer to its row, so code that uses an element as a `T`, as `get` above does, is refused in that instance, with a note that names the rule. For rows packed in place, make the element a struct with an array field, `Vec((cells: [3]i32))`: it lies in place, 12 bytes at a stride of 12, and `v.ptr[i].cells[2]` is one load (an array field is a value: its index is a constant, 2.4); for pointers to rows that lie elsewhere, say so, `Vec(*[3]i32)`.

A generic type may refer to itself through a pointer or a slice, directly or through another generic type, as any type may (2.8): `List(u32)` inside the body of `List(u32)` is the type being made.

```ents
func List(comptime T: type) -> type => (head: T, next: ?*List(T))

export func second(l: *List(u32)) -> u32 => if let n = l.next { n.head } else { 0 }
```

It cannot apply itself to a type made of its parameters: a type function has no conditions, so each level would be a new type and applying it would never end.

```ents
func List(comptime T: type) -> type => (head: T, next: ?*List(*T))
```

```errors
generic type 'List' refers to itself with a type argument that grows, List(*T): applying it would never end
```

Generic types that hold one another in a chain are not that, however long the chain. The compiler stops at 1000 levels, with `generic types are nested more than 1000 deep in 'G0(u8)'` at the application that was written.

**Errors in the body.** A generic type is checked as its applications, as a generic function is as its instances (8.3): an error its arguments make in its body is the application's, reported at its line in the body, once for each application, with the message naming it (`..., in Ring(0, u32)`, [8.7](#87-comptime-value-parameters)) and the use it was required from as a note. That application is then no type, and what is made of it says nothing more; a module that applied another module's generic type is told at its use, `Ring(0, u32) cannot be applied: ...`. A name the body uses that nothing declares is a mistake of the declaration, said once, where it is, when the type is first applied. Where one application inside another has an error, goes too deep or makes the type too large, the whole type is cut short there, with that one error.

### 8.6 Comptime Function Parameters

A **comptime function parameter**, `comptime before: (T, T) -> bool`, is given a function at compile time, by its name. In the instance a call of the parameter, `before(a, b)`, is a direct `call` of the function given: there is no function pointer, no table and no indirect call. This is how a generic is told what to do (the order a sort sorts by, the step a fold takes, what a visitor does with each element), and each function given makes an instance of its own.

```ents
func sort(comptime T: type, xs: []mut T, comptime before: (T, T) -> bool) {
  let p = xs.ptr
  for i in xs.len {
    let x = p[i]
    let j = i
    while j > 0 && before(x, p[j - 1]) {
      p[j] = p[j - 1]
      j -= 1
    }
    p[j] = x
  }
}

func ascending(a: i32, b: i32) -> bool => a < b
func descending(a: i32, b: i32) -> bool => a > b

export func up(xs: []mut i32) { xs.sort(ascending) }
export func down(xs: []mut i32) { xs.sort(descending) }

data nums = mut [5:i32, -1, 8, 3]

test "one sort, two orders" {
  up(nums)
  assert nums[0] == -1
  assert nums[3] == 8
  down(nums)
  assert nums[0] == 8
  assert nums[3] == -1
}
```

`up` and `down` call two copies of `sort`, `sort<i32|ascending>` and `sort<i32|descending>`; the first contains `call $ascending` where the generic says `before(...)`, the second `call $descending`. The module is the one with the two sorts written out by hand:

```ents same-wasm
func sort_ascending(xs: []mut i32) {
  let p = xs.ptr
  for i in xs.len {
    let x = p[i]
    let j = i
    while j > 0 && ascending(x, p[j - 1]) {
      p[j] = p[j - 1]
      j -= 1
    }
    p[j] = x
  }
}

func sort_descending(xs: []mut i32) {
  let p = xs.ptr
  for i in xs.len {
    let x = p[i]
    let j = i
    while j > 0 && descending(x, p[j - 1]) {
      p[j] = p[j - 1]
      j -= 1
    }
    p[j] = x
  }
}

func ascending(a: i32, b: i32) -> bool => a < b
func descending(a: i32, b: i32) -> bool => a > b

export func up(xs: []mut i32) { sort_ascending(xs) }
export func down(xs: []mut i32) { sort_descending(xs) }

data nums = mut [5:i32, -1, 8, 3]

test "one sort, two orders" {
  up(nums)
  assert nums[0] == -1
  assert nums[3] == 8
  down(nums)
  assert nums[0] == 8
  assert nums[3] == -1
}
```

**Declaring one.**

1. Its type is a function type ([Function Types and Pointers](#function-types-and-pointers)): written out, `(T, T) -> bool`; with no result, `(T) -> ()`; with several, `(u32) -> (lo: u32, hi: u32)`; or a name for one, a `type` (`type Cmp = (i32, i32) -> bool`, declared before or after) or an applied generic type whose body is a function type. It may use the function's type and value parameters. Names written for its parameters and results are not part of the type.
2. Its name starts with a lower-case letter (`a comptime function parameter's name starts with a lower-case letter: write 'comptime before: (T, T) -> bool'`) and is not the name of another parameter (`parameter 'before' is declared twice`).
3. In the body the name is the function given, and hides a function of the module of the same name. A parameter with a builtin's name, `comptime max: (u32, u32) -> u32`, replaces the builtin in the body, and the compiler warns once, where the parameter is declared: `'max' replaces the builtin max in the body of 'app'` ([10](#10-builtin-functions)).

```ents
func sort(comptime T: type, xs: []mut T, comptime Before: (T, T) -> bool) { }
func keep(comptime T: type, x: T, comptime f: (T) -> T, f: u32) -> T => x
```

```errors
a comptime function parameter's name starts with a lower-case letter: write 'comptime before: (T, T) -> bool'
parameter 'f' is declared twice
```

**Giving one.** The argument of a comptime function parameter is written in both forms of a call ([8.2](#82-calling-a-generic-function)): `sort(xs, ascending)` is the inferred form of `sort(i32, xs, ascending)`, and `xs.sort(ascending)` is the method form of either ([4.9](#49-method-call-syntax)). Leaving it out is a wrong count of arguments: `'sort' expects 2 arguments, or 3 with its type argument written; got 1`. A generic whose only comptime parameters are functions has the one form. The argument is one of:

- the name of a function declared at module level in this module, before or after the call;
- the name of an imported function, from the host or from another source module ([8.8](#88-generics-across-modules));
- inside a generic, one of its own comptime function parameters, passed on.

Nothing else is a function there: not an expression, not a value of a function type, not a generic function, not a builtin (`abs`, `sqrt`), not a function a `test` declares, and not a name that several functions share ([3.4](#functions-that-share-a-name)), since nothing tells which of them is meant. The argument is a name, never evaluated: nothing of it is left for run time.

**Its type is exactly the declared type**, with the call's type and value arguments put in: the same parameter types and the same result types, in order. Names of parameters and results do not count. A function whose types only convert to the declared ones is refused, so one that takes a `u64` where the parameter says `u32`, or returns a `u8` where it says `u32`, is an error. The one relaxation: a function that lists a struct's fields as its results, `-> (sum: f64, n: u32)`, is one that returns the struct.

**It decides type and value parameters** as any argument does ([8.2](#82-calling-a-generic-function)): the first parameter, left to right, whose type mentions `T` and whose argument has a type decides `T`, and a function's type is matched by its parameter types, or else by its result. In `twice(inc, 5)` below, `T = u32` comes from `inc`, and the `5` is then a `u32`; in `primes.each(add)`, `T = u32` comes from `primes`, and `add` must then be a `(u32) -> ()`.

```ents
global total: u32 = 0

func add(x: u32) { total += x }
func inc(x: u32) -> u32 => x + 1

func each(comptime T: type, xs: []T, comptime visit: (T) -> ()) {
  for x in xs {
    visit(x)
  }
}
func twice(comptime T: type, comptime f: (T) -> T, x: T) -> T => x.f().f()

data primes = [2:u32, 3, 5, 7]

test "a visitor, and a function that decides T" {
  primes.each(add)
  assert total == 17
  assert twice(inc, 5) == 7
  assert twice(u32, inc, 0) == 2
}
```

A step that lists the fields of the struct it returns:

```ents
type Stats = (sum: f64, n: u32)

func fold(comptime step: (Stats, f64) -> Stats, xs: []f64) -> (s: Stats) {
  for x in xs {
    s = step(s, x)
  }
}
func add(s: Stats, x: f64) -> (sum: f64, n: u32) => (s.sum + x, s.n + 1)

data samples = [1.5, 2.5, 4.0]

test "a step that returns Stats by its fields" {
  let s = fold(add, samples)
  assert s.n == 3
  assert s.sum == 8.0
}
```

The arguments that are not functions, or not of the type:

```ents
func twice(comptime T: type, comptime f: (T) -> T, x: T) -> T => f(f(x))
func inc(x: u32) -> u32 => x + 1
func widen(x: u64) -> u32 => x as u32
func narrow(x: u32) -> u8 => x as u8
func pick(comptime T: type, a: T) -> T => a
func hash(x: u32) -> u32 => x
func hash(x: u64) -> u32 => x as u32

func a(x: u32) -> u32 => twice(u32, widen, x)
func b(x: u32) -> u32 => twice(u32, narrow, x)
func c(x: i32) -> i32 => twice(i32, abs, x)
func d(x: u32) -> u32 => twice(u32, pick, x)
func e(x: u32) -> u32 => twice(u32, hash, x)
func g(x: u32) -> u32 => twice(x)
```

```errors
'widen' is (u64) -> u32, but 'twice' needs f: (u32) -> u32
'narrow' is (u32) -> u8, but 'twice' needs f: (u32) -> u32
argument 2 of 'twice' must be the name of a function: f is a comptime function parameter
argument 2 of 'twice' must be the name of a function: f is a comptime function parameter
argument 2 of 'twice' must be the name of a function: f is a comptime function parameter ('hash' has several overloads)
'twice' expects 2 arguments, or 3 with its type argument written; got 1
```

A function declared in a `test` is refused with `argument 1 of 'twice' must be a function declared at module level: 'helper' is declared inside a test`.

**In the instance** the parameter is the function given. A call of it, `f(x)`, or `x.f()` as a method, is a direct call of that function, with that function's parameter and result types. A name the declared type gives a result is therefore not there when the function's results have other names, or none, and a body that reaches a result by name is an error in the instances where it is not there. A result reached by its position, `f(n).1`, is there in every one:

```ents
func second(comptime f: (u32) -> (x: u32, y: u32), n: u32) {
  let y = f(n).y
}
func pair(n: u32) -> (u32, u32) => (n, n + 1)

export func a(n: u32) { second(pair, n) }
```

```errors
no field 'y' on type (u32, u32), in second(f = pair)
```

**It is not a value.** Inside the generic the parameter can be called, and passed on for a comptime function parameter of a generic (another one, or the same one); nothing else. It cannot be stored in a variable, compared, or given for a parameter that is not `comptime`:

```ents
func apply(f: (u32) -> u32, x: u32) -> u32 => x
func inc(x: u32) -> u32 => x + 1

func g(comptime f: (u32) -> u32, x: u32) -> u32 => apply(f, x)
func h(comptime f: (u32) -> u32, x: u32) -> bool => f == inc
func k(comptime f: (u32) -> u32, x: u32) -> u32 {
  let saved = f
  return saved(x)
}

export func a(x: u32) -> u32 => g(inc, x)
export func b(x: u32) -> bool => h(inc, x)
export func c(x: u32) -> u32 => k(inc, x)
```

```errors
'f' is a comptime function parameter: it can only be called, or passed on for a comptime function parameter, in g(f = inc)
'f' is a comptime function parameter: it can only be called, or passed on for a comptime function parameter, in h(f = inc)
'f' is a comptime function parameter: it can only be called, or passed on for a comptime function parameter, in k(f = inc)
```

**Instances.** The function given is one of the instance's comptime arguments ([8.4](#84-instances)): `sort<i32|ascending>` and `sort<i32|descending>` are two functions in the output, and two calls that give the same function (with the same other comptime arguments) share one instance. In the editor, the parameter shows the function each instance was given: `f: (u32) -> u32 — in app(f = inc): inc(x: u32) -> u32; in app(f = dec): dec(x: u32) -> u32`.

**Not implemented: function values at run time.** A parameter of a function type without `comptime` would be a function passed at run time and called indirectly. The language does not have such values ([Function Types and Pointers](#function-types-and-pointers)): calling one is `calling a function value is not supported yet: only a function named directly, or a comptime function parameter (comptime f: (u32) -> u32), can be called`. A function that calls a function it is given takes it as a comptime parameter.

### 8.7 Comptime Value Parameters

A **value parameter**, `comptime n: u32`, is given a number at compile time. Inside the function `n` is that number. It can stand where a number can, and it can size a type: `[n]T` is an array of `n` elements, `*[n]T` a pointer to one, `u32#n` a number below `n`. Each number the function is called with makes an instance of its own, so a length that is a value parameter is part of the instance's types, and whatever the compiler proves from a length written as a number it proves from `n`.

```ents
func sum(comptime n: u32, xs: *[n]u32) -> (total: u32) {
  for i in n {
    total += xs[i]
  }
}

data primes = [2:u32, 3, 5, 7]
data squares = [1:u32, 4, 9, 16, 25, 36, 49, 64]

export func a() -> u32 => sum(primes)          // n = 4, from *[4]u32
export func b() -> u32 => sum(8, squares)      // n written
export func c() -> u32 => sum(2 + 2, primes)   // the instance of a

test "each length is its own function" {
  assert a() == 17
  assert b() == 204
  assert c() == 17
}
```

compiles to exactly the module this does:

```ents same-wasm
func sum_4(xs: *[4]u32) -> (total: u32) {
  for i in 4 {
    total += xs[i]
  }
}
func sum_8(xs: *[8]u32) -> (total: u32) {
  for i in 8 {
    total += xs[i]
  }
}

data primes = [2:u32, 3, 5, 7]
data squares = [1:u32, 4, 9, 16, 25, 36, 49, 64]

export func a() -> u32 => sum_4(primes)
export func b() -> u32 => sum_8(squares)
export func c() -> u32 => sum_4(primes)

test "each length is its own function" {
  assert a() == 17
  assert b() == 204
  assert c() == 17
}
```

In `sum<4>` the loop counter is a `u32#4` and `xs` is a `*[4]u32`, so `xs[i]` is read without a check, as it is in `sum_4`.

Rules:

1. A value parameter is written `comptime n: u32` in the parameter list of a module-level `func`, as every comptime parameter is ([8.1](#81-compile-time-parameters)). Its type is an integer type, `i8` to `i512` or `u8` to `u512`, written out or named, and may carry a range: `comptime n: u32#65` takes the numbers below 65. The type says which numbers the parameter takes, and nothing more: in the body `n` is the number ([below](#inside-the-function)).
2. Its name starts with a lower-case letter, as every value's does (`a value parameter's name starts with a lower-case letter: write 'comptime n: u32'`). A type parameter's starts with an upper-case one.
3. A function with a value parameter is a generic function: it can only be called, it is checked for each instance, and nothing of it is emitted until it is called.
4. Comptime parameters may stand anywhere in the list, and a parameter's type may use any of them. By convention they come first, in the order a type writes them: `n` before `T`, as in `[n]T`.
5. A value parameter's name is not the name of another parameter (`parameter 'n' is declared twice`) or of a result of the function (`result 'n' has the name of the comptime value parameter 'n'`), nor of a `def` of the module (`comptime parameter 'n' has the name of a def declared in this module`; a `def` a `test` declares is not one), and the body does not bind it again (`let n`, `for n in`, an `if let n`, a match arm `n =>`), as for any parameter. It may have the name of a global or a function of the module, which it hides in the body, as any parameter does.
6. A parameter that is not `comptime` cannot size a type: `func f(len: u32, p: *[len]u8)` is `array length must be a compile-time constant: 'len' is a parameter; to give it at compile time, write comptime len: u32`.

#### Inside the function

In an instance, `n` is the number the call gave, written in place of the name, exactly as `def n = 8` would put it there.

- **In an expression** it is that number, and has no type of its own, as a literal has none: it takes the type its place gives it. `x < n`, `let y: u8 = n`, `return n` and `f(n)` are what they are with `8` written there (and the shorthand `P(n:, x:)` is `P(n: 8, x: x)`), and `-n` is the number `-8`, as it is where `def n = 8` puts 8. `let k = n` gives `k` the type `let k = 8` gives (`i32`, or `i64` for a number that an `i32` does not hold): write `let k: u32 = n` for a variable that has one type in every instance.
- **Arithmetic on it is arithmetic on constants**: computed exactly, then held to the type its place gives, as with the number written there. `func dbl(comptime n: u32, x: u32) -> u32 => x + n * 2` called with `n = 3000000000` is `cannot assign int(6000000000) to u32, in dbl(n = 3000000000)`, the error `x + 3000000000 * 2` gives; nothing wraps.
- **It is not a variable.** `n = 3`, `n += 1` and `set (n, x) = ...` are errors (`cannot assign to 'n': it is a comptime value parameter`, `cannot set 'n': it is a comptime value parameter`), and so is a binding that reuses its name; each is reported in every instance, as any mistake in a body is ([8.3](#83-requirements)).
- **In a type** it is a length or a bound: `[n]T`, `*[n]T`, `*mut [n]T`, `[n][m]T`, `*[n][m]T` (a table, [Nesting](#nesting)), `u32#n`, and an argument of a generic type, `Ring(n, T)`. Any constant expression may stand there: `[n * 2]T`, `[(n + 31) / 32]u32`, `[n * sizeof(T)]u8`, `u32#(n + 1)`. A length is written between the brackets; a bound follows `#` directly when it is a name or a number, and in parentheses otherwise.
- **Every rule about a number holds for it**, because in the instance it is one: `for i in n` counts with `i: u32#n` ([Ranged Integers](#ranged-integers)); for an unsigned `x`, `x % n` is a `u32#n` and `x & (n - 1)` is a `u32#n`; `v[n - 1]` is a constant index; `[0:u8; n]` is `n` zeros; `sizeof([n]T)` is `n * sizeof(T)`; `.len` of a `*[n]T` is `n`. So does every rule about the number `0`, where a body is instantiated with it ([Bounds](#bounds)).
- **A test of it is an ordinary `if`.** There is no compile-time `if`: `if n == 0 { ... } else { ... }` is in every instance with both branches, each checked there, and compiles to the test of a constant that the instance written by hand would have.
- **A hyphen joins a name** ([1.2](#12-identifiers)): `n-1` is one name, not `n` minus 1. Write `v[n - 1]`, `[n - 1]T`, `u32#(n - 1)`.

```ents
func last(comptime n: u32, comptime T: type, v: [n]T) -> T => v[n - 1]
func rotl(comptime k: u32, x: u32) -> u32 => (x << k) | (x >> (32 - k))

export func a(x: f64) -> f64 {
  let v: [3]f64 = [x, 2.0, x * 3.0]
  return last(v)                                // n = 3, T = f64, from [3]f64
}
export func mix(a: u32, b: u32) -> u32 => rotl(7, a) ^ rotl(13, b)

test "the last of three, and two rotations" {
  assert a(2.0) == 6.0
  assert mix(1, 0) == 128
  assert mix(0, 1) == 8192
}
```

`last<3|f64>` takes the three values of `v` in three registers and returns the third; `rotl<7>` shifts by `7` and by `32 - 7` (the language's `x <<< k` is one instruction; `rotl` spells it out to show `n` in arithmetic). A value array is held in registers, so it is indexed by constants only, in a generic as anywhere ([2.4](#24-fixed-arrays-value-type)): `v[n - 1]` is one, and `v[i]` in `for i in n` is not.

#### Calling a function with value parameters

The two forms of [8.2](#82-calling-a-generic-function) hold, with value parameters counted with the type parameters: if a function has `P` parameters of which `K` are type or value parameters, a call with `P` arguments is explicit and a call with `P - K` arguments is inferred. A comptime function parameter is written in both forms.

**Explicit.** The argument of a value parameter is a **compile-time constant**, the same kind of expression that may stand in a length: a number (`8`, `0x40`, `8:u32`, `'a'`), a `def`, a value parameter of the enclosing generic, `sizeof` of a type (also of a type parameter), the `.len` and `.wid` of a `*[N]T`, and arithmetic, bitwise operators and shifts on these. A variable, a global, a call, a cast (`4 as u32`; write `4:u32`) or the address of `data` is not one: `argument 1 of 'sum' must be a compile-time constant: n is a comptime value parameter`. It is checked against the parameter's type as any argument is, by its exact value (`sum(0 - 1, p)` is `argument 1: cannot assign int(-1) to u32`), and the instance gets the value it has in that type: `~0` for a `comptime m: u8` is 255.

**Inferred.** A value parameter is found from the other arguments as a type parameter is: going through the parameters left to right, the first one whose written type has `n` as a length, and whose argument has a length in that place, decides it.

| Parameter | Argument | Result |
|---|---|---|
| `*[n]T`, `*mut [n]T` | `*[8]u32`, `*mut [8]u32` (a `data` array; a string `"abc"` is a `*[3]u8`) | `n = 8` |
| `[n]T` | a `[3]f64` held in registers | `n = 3` |
| `*[n][m]T` | `*[2][3]i32` | `n = 2`, `m = 3` |
| `*Ring(n, T)` | a pointer to a struct of `Ring`'s shape | `n` from the field `items: *mut [n]T` |
| `(*[n]u8, u32)` | a tuple `(buf, 1)` | `n` from its typed part |
| `comptime f: (*[n]u8) -> u32` | a function `g(p: *[8]u8) -> u32` | `n = 8`: a function argument decides as any argument does ([8.6](#86-comptime-function-parameters)) |
| `*[n]T` | a slice `[]u32`, a `[*]u32`, a `*[!]u32`, a packed `*[2x3]u32` | nothing: there is no length in the type, or not one of that shape |
| `*[n]T` | a `[4]u32` held in registers | nothing: it has no address ([2.4](#24-fixed-arrays-value-type)), so it matches no pointer, as for `T`; written out, `sum(4, v)` is `argument 2: cannot assign [4]u32 to *[4]u32` |
| `*[n * 2]u8` | `*[8]u8` | nothing: only a length that is the name alone decides |
| `u32#n` | a `u32#8` | nothing: a range is dropped, as it is for `T` |
| `*[n]u32` | an array literal `[1, 2, 3]` | nothing: literals never decide (8.2, rule 3) |

Every other argument is then an ordinary argument of the instance, with the same conversions and the same errors: `join("hel", "lo", big)` below, with a `big` of 8 bytes, is `argument 3: cannot assign *mut [8]u8 to *mut [5]u8`. Nothing is guessed: a value parameter that no argument decides has to be written, and so do the other type and value parameters of that call, since there is no form that writes some of them.

```ents
func sum(comptime n: u32, xs: *[n]u32) -> u32 => 0

func f(xs: []u32) -> u32 => sum(xs)
func g(x: u32, p: *[4]u32) -> u32 => sum(x, p)
```

```errors
cannot infer n for 'sum': a []u32 has no length in its type; write the value argument, as in sum(8, ...)
argument 1 of 'sum' must be a compile-time constant: n is a comptime value parameter
```

#### Arithmetic in types, and when two types are the same

A length or a bound may be any compile-time constant (as for an explicit argument, above). It is computed in each instance, as any constant is ([Comptime Literal Promotion](#comptime-literal-promotion)); a length is used as no type, so it is computed exactly, with nothing to wrap in, even where a part of it is typed (`sizeof(T)` is a `u32`), and the type then has that number in it. Two types are the same when they are the same with their lengths computed, as types always are: in an instance where `n` is 4, `[n * 2]u8`, `[2 * n]u8`, `[n + n]u8` and `[8]u8` are one type. Nothing about lengths is ever compared before they are numbers: a generic is checked only as its instances, so there is no rule of algebra for lengths, and none is needed.

```ents
func join(comptime a: u32, comptime b: u32, x: *[a]u8, y: *[b]u8, out: *mut [a + b]u8) {
  for i in a {
    out[i] = x[i]
  }
  for j in b {
    out[a + j] = y[j]
  }
}

data buf = mut [0:u8; 5]

export func hello() -> u8 {
  join("hel", "lo", buf)      // a = 3, b = 2; out is a *mut [5]u8, which buf is
  return buf[4]
}

test "joined" {
  assert hello() == 111
}
```

A length is a number from 0 to 4294967295, the most a `u32` `.len` holds, and an array, wherever it is (in registers, in memory, or behind a pointer), has at most 4294967295 bytes: `sizeof([n]T)` is a `u32`, and so is the byte offset of every element a proven index reaches. A bound is at least 1 (`u32#0` would have no values) and at most the number of values its type has (`u8#256` is every `u8`). These hold for types written by hand too.

#### Bounds

What a length proves, it proves in every instance. A ranged index below the length is read and written without a check; an index that is not proven is resolved with `if let` or `??`, or is an error, as in hand-written code ([4.7](#47-bounds-checked-indexing)).

```ents
func get(comptime n: u32, comptime T: type, xs: *[n]T, i: u32#n) -> T => xs[i]

data widths = [3:u16, 1, 4, 1, 5, 9, 2, 6]

export func a(k: u32) -> u16 => get(widths, k & 7)
export func b(k: u32) -> u16 => get(widths, k % 8)

test "indexes proven by their ranges" {
  assert a(2) == 4
  assert a(15) == 6
  assert b(13) == 9
}
```

`get<8|u16>` is one load. The proof is the caller's: `get(widths, k)` with a plain `k: u32` is `argument 2: cannot assign u32 to u32#8`, and `get(widths, k & 15)` is `argument 2: cannot assign u32#16 to u32#8`.

**`n = 0`** is a number like any other, so an instance for it is refused exactly where the same function written by hand for 0 is. `u32#0` is no type, so `get` cannot be made for an empty array (`range bound must be at least 1: u32#0 has no values, in get(n = 0, T = u16)`). A loop `for i in 0` counts with a plain `u32`, since its counter has no values to range over, so nothing it indexes is proven:

```ents
func sum(comptime n: u32, xs: *[n]u32) -> (total: u32) {
  for i in n {
    total += xs[i]
  }
}

data none: *[0]u32 = []

export func z() -> u32 => sum(none)
```

```errors
runtime index on *[0]u32 requires 'if let' or '??' (no optional type for u32), in sum(n = 0)
```

A generic that is meant to work for 0 is written so that no index needs a proof: `for x in xs` loops over the `*[n]u32` itself and works for every `n`. A test of `n` does not help, since both branches are in every instance: `if n == 0 { 0 } else { xs[n - 1] }` is still `index -1 out of bounds for *[0]u32, in last(n = 0)`.

#### Generic types with value parameters

A generic type ([8.5](#85-generic-types)) takes value parameters as a generic function does, and is applied to numbers as to types: `Ring(8, u32)`.

```ents
func Ring(comptime n: u32, comptime T: type) -> type => (head: u32#n, count: u32, items: *mut [n]T)

// Adds x after the newest element; when the ring is full, x takes the oldest one's place.
func push(comptime n: u32, comptime T: type, r: *mut Ring(n, T), x: T) {
  r.items[(r.head + r.count) % n] = x
  if r.count < n {
    r.count += 1
  } else {
    r.head = (r.head + 1) % n
  }
}

// The i-th oldest element.
func oldest(comptime n: u32, comptime T: type, r: *Ring(n, T), i: u32#n) -> T => r.items[(r.head + i) % n]

data cells = mut [0:u32; 8]
data log: Ring(8, u32) = mut (0, 0, cells)

export func record(x: u32) { log.push(x) }
export func first() -> u32 => log.oldest(0)

test "the ring keeps the last eight" {
  for i in 10 {
    record(i)
  }
  assert log.count == 8
  assert first() == 2
}
```

`Ring(8, u32)` is the struct `(head: u32#8, count: u32, items: *mut [8]u32)`, as any generic type is its body. Its value arguments are computed before it is applied, so `Ring(8, u32)`, `Ring(4 + 4, u32)` and the struct written out are one type; `Ring(16, u32)` is another because its body is (`cannot assign *mut Ring(16, u32) to *mut Ring(8, u32)`). As for type parameters, a value the body does not use makes no difference: with `func Tagged(comptime n: u32) -> type => (id: u32)`, `Tagged(4)` and `Tagged(5)` are one type. `log.push(x)` finds `n` and `T` from `log` by the body of `Ring`, through `items: *mut [n]T`; `head: u32#n` decides nothing. It builds a value like any generic type, `Ring(8, u32)(0, 0, cells)`, and a method call writes its comptime arguments after the receiver, `log.push(8, u32, x)`, which is `push(8, u32, log, x)`.

Its value arguments are compile-time constants, as an explicit argument of a generic function is ([above](#calling-a-function-with-value-parameters)), checked against the parameter's type the same way: a `def` declared further down is a number there too, `Small(300)` is `argument 1 of 'Small': cannot assign int(300) to u8` for a `comptime n: u8`, and so are the typed `Small(4:u32)` and `Small(sizeof(u64))`, as `cannot assign u32 to u8`. An error that a number makes in the body is the application's (8.5): with `Ring(0, u32)`, `head: u32#0` is `range bound must be at least 1: u32#0 has no values, in Ring(0, u32)`, with the use as a note. A body that applies its type to numbers that grow is stopped: by the parameter's type, as in `func Grow(comptime n: u32) -> type => (a: u32, next: *Grow(n * 2))` (`argument 1 of 'Grow': cannot assign int(4294967296) to u32, in Grow(2147483648)`), or at 1000 levels, with `next: *Grow(n + 1)` (`generic types are nested more than 1000 deep in 'Grow(1)'`).

A generic type may also hold its array in place, as a field: `Buf(n, T)` below is a length and the `n` elements themselves, not a pointer to them.

```ents
func Buf(comptime n: u32, comptime T: type) -> type => (len: u32#(n + 1), items: [n]T)

// Adds x at the end; false, with nothing changed, when it is full.
func push(comptime n: u32, comptime T: type, b: *mut Buf(n, T), x: T) -> bool {
  let i = b.len
  return false when i >= n
  b.items[i] = x            // i is a u32#n here: one store, no check
  b.len = i + 1
  return true
}

// The elements it holds.
func filled(comptime n: u32, comptime T: type, b: *Buf(n, T)) -> []T => b.items[0..b.len]

func third(b: Buf(3, u32)) -> u32 => b.items[2]

data held: Buf(3, u32) = mut (0, [0; 3])

test "an array held in place" {
  assert sizeof(Buf(3, u32)) == 16
  assert held.push(4)
  assert held.push(5)
  let sum: u32 = 0
  for x in held.filled() {
    sum += x
  }
  assert sum == 9
  assert held.push(6)
  assert !held.push(7)
  assert third(held.*) == 6
}
```

`Buf(3, u32)` is sixteen bytes in memory, the length and then the three elements, and four values in registers. Where it lies decides how its array is indexed, as for any array field ([9.6](#fixed-arrays-in-place)). Behind a pointer the field has an address and is the `*[n]T` it is there: a ranged index is proven (`b.items[i]` in `push`, where `return false when i >= n` leaves `i` a `u32#n`), an unproven one is resolved with `if let` or `??`, and `b.items[0..b.len]` is a slice of it. Held in registers, as the parameter of `third` is, it has no address and is indexed by constants only ([2.4](#24-fixed-arrays-value-type)): `b.items[2]` is one value, and `b.items[i]` with an `i: u32` is an error. The length is a `u32#(n + 1)` because it reaches `n` when the buffer is full; `u32#n` would say it stays below.

#### Instances

- **Identity.** Value arguments are equal when they are the same number in the parameter's type: `sum(primes)`, `sum(4, primes)` and `sum(2 + 2, primes)` share `sum<4>`.
- **Names.** In WAT a value argument is written in decimal among the others, in the order of the comptime parameters: `$sum<4>`, `$push<8|u32>`, `$shift<-3>`. Instances take the generic's place in the order of their names as text, so `$rotl<13>` comes before `$rotl<7>`. In messages an instance reads `push(n = 8, T = u32)`.
- **Zero cost.** An instance is the generic with each value parameter replaced by its number, and it compiles to the bytes of that function written by hand. Nothing of `n` exists at run time beyond the constants the hand-written function would have, and none is folded that the hand-written one would not fold: `32 - k` in `rotl<7>` is `(i32.sub (i32.const 32) (i32.const 7))` as `32 - 7` is.
- **Statics.** A literal in the body belongs to each instance, as for type parameters: `func scratch(comptime n: u32) -> *mut [n]u8 => mut [0:u8; n]` is one buffer of `n` bytes for each `n`, laid out once. Every call with the same `n` gets the same buffer.
- **One copy per number.** Each value is a function of its own, as each type is: `sum` over arrays of five lengths is five functions. A long body that needs the length only for a few proofs can take a slice in a plain function and keep the generic a short wrapper.
- **Recursion.** A generic may call itself with the same arguments; that is run-time recursion in one instance. It cannot recurse on a value that changes. There is no compile-time `if`, so both branches of an `if` are in every instance, and each instance asks for the next:

```ents
func pow(comptime e: u32, x: u64) -> u64 => if e == 0 { 1 } else { x * pow(e - 1, x) }

export func cube(x: u64) -> u64 => pow(3, x)
```

```errors
argument 1: cannot assign int(-1) to u32, in pow(e = 0)
```

`pow<3>` asks for `pow<2>`, and so on to `pow<0>`, whose `else` asks for `pow(0 - 1, x)`. A value that grows instead is stopped by its type or by the limits of [8.4](#84-instances) (64 nested instantiations, 1000 from one call). A loop does what such a recursion would: `for i in e { r *= x }`.

#### With the rest of the language

- **Functions that share a name.** A generic with value parameters is still a generic: its name is unique in its module. In an instance `n` is a literal, so a call `gt(x, n)` in the body picks among overloads as `gt(x, 8)` does: the typed `x` decides and the literal only has to fit ([3.4](#functions-that-share-a-name)).
- **Tables.** A pointer or slice whose element is a fixed array is a table ([Nesting](#nesting)) whatever its lengths are: a `t: *[n][m]T` is `n` row pointers, `t.len` is `n` and `t[i].len` is `m`. Lengths are matched by shape, never by layout: `*[n][m]T` against a `*[2][3]i32` gives `n = 2`, `m = 3`. The same holds for a type parameter that turns out to be a fixed array ([8.5](#85-generic-types)): `*[n]T` against a `*[2][3]i32` gives `n = 2` and `T = [3]i32`, and the instance has a table, whose `xs[i]` is a row pointer, not a `T`.
- **Modules.** A source import writes a value parameter as it is declared: `"push" func push(comptime n: u32, comptime T: type, r: *mut Ring(n, T), x: T)` (what the import writes is checked against nothing, [7.1](#71-imports)). An instance belongs to the generic's module ([8.8](#88-generics-across-modules)), and a value argument is computed in the module that wrote it, with that module's `def`s.
- **`def`.** A `def` is a number with a name, so it sizes a type wherever it is in scope, in a generic or not: with `def size = 64`, `*mut [size]u8` and `u32#size` are types.
- **In the editor.** A value parameter shows its number in each instance: `n: u32 — in sum(n = 4): 4; in sum(n = 8): 8`.

A table with value-parameter lengths is read as a table written by hand: here `m[i]` loads the row pointer and `m[i][i]` the cell, both proven by `i: u32#n`.

```ents
func trace(comptime n: u32, m: *[n][n]i32) -> (t: i32) {
  for i in n {
    t += m[i][i]
  }
}

data grid: *[3][3]i32 = [[1, 2, 3], [4, 5, 6], [7, 8, 9]]

export func a() -> i32 => trace(grid)            // n = 3; the second [n] is then checked: a *[3][4]i32 is refused

test "trace" {
  assert a() == 15
}
```

### 8.8 Generics Across Modules

`export func max(comptime T: type, ...)` and `export func Vec(comptime T: type) -> type` make a generic importable by other source modules; to the host they give nothing. A source import names what it uses with its signature, as for any function ([7.1](#71-imports)), comptime parameters included, and a generic type as the function it is. A module beside the library of [`lib/`](../lib/README.md):

```ents
// main.ents, next to lib/
import "./lib/stack" (
  "mark" func mark() -> u32
  "reset" func reset(m: u32)
)
import "./lib/vec" (
  "Vec" func Vec(comptime T: type) -> type
  "vec" func vec(comptime T: type, cap: u32) -> *mut Vec(T)
  "push" func push(comptime T: type, v: *mut Vec(T), x: T)
)

// How many of 0 to n - 1 are odd.
export func odd(n: u32) -> u32 {
  let scope = mark()
  defer reset(scope)
  let v = vec(u32, 16)
  for i in n {
    if i % 2 == 1 {
      v.push(i)
    }
  }
  return v.len
}
```

What the import writes is checked against nothing: the generic is the one the other module declares, with its own signature, and calls are checked against that ([7.1](#71-imports)).

**An instance belongs to the module that declares the generic**, whichever module asks for it: its body's names are that module's names, its errors are reported against that module's source, and its code is emitted with that module's functions. A second module that also pushes to a `Vec(u32)` uses the same instance: the program has one `push<u32>`. A generic type applied in another module is the type its body gives, as in its own. A value argument is computed in the module that writes it, with that module's `def`s.

**Where a call in a generic body is looked up.** A call in an instance's body, `hash(k)`, is resolved among the functions of the generic's own module first, by name and argument types ([3.4](#functions-that-share-a-name)). Where no function there of that name accepts the arguments, it is resolved among the plain (non-generic) functions of the *site*: the module whose ordinary, non-generic code started the chain of instantiations. So a library provides `hash` and `eq` for the common key types, and a program that keeps a `Set(Cell)` of its own `Cell` writes `hash(c: Cell)` and `eq(a: Cell, b: Cell)` in the module that makes the set:

```ents
// cells.ents, next to lib/
import "./lib/stack" (
  "mark" func mark() -> u32
  "reset" func reset(m: u32)
)
import "./lib/set" (
  "Set" func Set(comptime K: type) -> type
  "hashset" func hashset(comptime K: type, bits: u32) -> *mut Set(K)
  "add" func add(comptime K: type, s: *mut Set(K), k: K) -> bool
)

type Cell = (x: i32, y: i32)

func hash(c: Cell) -> u32 => ((c.x * 73856093) ^ (c.y * 19349663)) as u32
func eq(a: Cell, b: Cell) -> bool => a.x == b.x && a.y == b.y

// How many distinct cells a walk of n steps over a 5 by 3 board visits.
export func visited(n: u32) -> u32 {
  let scope = mark()
  defer reset(scope)
  let seen = hashset(Cell, 2)
  for i in n {
    seen.add(Cell((i % 5) as i32, (i % 3) as i32))
  }
  return seen.count
}
```

`add<Cell>` and the `slot<Cell>` it calls are functions of `lib/set.ents` that call this module's `hash` and `eq` directly. The rules of the lookup:

- **The library comes first.** A function of the generic's module that accepts the arguments is the one called, and nothing outside replaces it: a `hash(k: u32)` written in `cells.ents` is not called by a `Set(u32)`, which uses the library's own.
- **Only calls are looked up at the site, and only plain functions.** The types, globals and helpers of a generic's body are always its own module's. A generic function of the site's with the name is not looked up, and the error for want of the function says so in a note: `the site's 'hash' is generic, and only plain functions are looked up at the site`.
- **A comptime function argument is not looked up**: it is written where the generic is called, in the module that calls it ([8.6](#86-comptime-function-parameters)). `sort(xs, by_cost)` with `by_cost` declared in, or imported from, another module is an instance that calls that function directly, and two modules that give the same function, under whatever names they import it, share the instance.
- **An instance that needed the site belongs to that site**, and so does an instance that calls one. Another module that uses the same generic with the same arguments shares it where its own functions of the names looked up are the same functions (both import `hash` and `eq` for `Cell` from one module), and otherwise gets its own copy, which calls its own functions: two functions in the output, the second named with its site after the arguments in WAT, `add<<x:i32|y:i32>>@other`. An instance that did not need the site exists once in the program.

**Errors.** An error in an instance is the generic's module's, at its line in the generic, labelled with the instance, and with the calls it was required from, each in the module of that call. Where the chain of instantiations was started by ordinary code of another module, that module is told too, once, at its call, of the first error of the instance it asked for or of an instance that one's body asked for, however deep; nothing is said at the calls between. For a `cells.ents` that keeps a `Set(Cell)` and writes an `eq` for `Cell` but no `hash`:

```text
lib/set.ents:67:11: no function 'hash' accepts (Cell), in add(K = Cell)
  required from cells.ents:13:15
cells.ents:13:15: add(K = Cell) cannot be instantiated: no function 'hash' accepts (Cell) (set.ents:67:11)
```

Such an error is found when the program is checked: also in a library that was checked on its own and found sound, since what an instance needs depends on its arguments. It stops the build like any other. A file checked without the files it imports (the editor's web worker, a reference example) knows an imported generic only by the signature its import writes, and checks calls against that ([7.1](#71-imports)); what an instance's body needs is found when the program is checked.

The containers of [`lib/`](../lib/README.md) are written this way: `lib/vec.ents`, `lib/set.ents`, `lib/map.ents` and `lib/sort.ents` on the bump stack of `lib/stack.ents`, and `lib/fixedvec.ents`, `lib/ring.ents` and `lib/bits.ents` with their capacity in the type. [`examples/containers/main.ents`](../examples/containers/main.ents) uses them for a type of its own.

### 8.9 Not in This Version

**Not implemented:** none of these is in the language. Each is refused with an error, which keeps its syntax free to be given a meaning.

| Not implemented | What the compiler says |
|---|---|
| A comptime parameter that is a `bool`, a float, a slice or a string, or whose type is a type parameter (`comptime n: T`) | `comptime parameter 'ok' is bool: a comptime parameter is a type (comptime T: type), an integer (comptime n: u32) or a function (comptime f: (T) -> T)` |
| A string or a `data` block for a value parameter | `argument 1 of 'count' must be a compile-time constant: s is a comptime value parameter` |
| A compile-time `if`, `for` or `assert`, and so recursion on a value parameter that ends, `pow(e - 1, x)` in `pow(comptime e: u32, ...)` | An `if` on `e` is an ordinary `if`, with both branches in every instance, so the chain ends at a value the parameter's type refuses (`argument 1: cannot assign int(-1) to u32, in pow(e = 0)`) or at 64 nested instantiations |
| A default for a comptime parameter, `comptime n: u32 = 16` | A syntax error at the `=` |
| Writing some comptime arguments and inferring the others | A wrong count of arguments: `'push' expects 2 arguments, or 4 with its comptime arguments written; got 3` |
| Inference from the type the call's result is given, `let x: u64 = zero()` | `cannot infer T for 'zero': write the type argument, as in zero(u32)` |
| Inferring a value parameter from a length in arithmetic (`*[n * 2]u8`), from a range (`u32#n`) or from an array literal's count | `cannot infer n for 'set_bit': [(n + 31) / 32] does not decide n, only a length that is n alone does; write the value argument, as in set_bit(8, ...)` |
| A packed array whose dimensions are names, `*[n x m]T` | A syntax error at the `x` |
| Generic functions that share a name, with each other or with a function, global, `def`, `data` or import | `'max' is already declared: a generic function's name is unique in its module` |
| A generic function as a value: stored, or passed for a parameter | `generic function 'max' must be called` |
| A generic function or a generic type declared inside a `test` block | `a generic function is declared at module level, not inside a test`; `a generic type is declared at module level, not inside a test` |
| A generic type with a parameter that is neither `comptime X: type` nor an integer (a function, a `bool`), or with no parameter | `generic type 'Vec' takes comptime type and integer parameters only, as (comptime n: u32, comptime T: type)` |
| A generic type with a block body or conditions | A syntax error: its body is one type |
| A type parameter applied to arguments, `T(u32)` as a type | `a type parameter cannot be applied` |
| An expression or a function written in place (a closure) for a comptime function parameter | `argument 3 of 'sort' must be the name of a function: before is a comptime function parameter` |
| A name several functions share, for a comptime function parameter | The same, followed by `('less' has several overloads)` |
| A comptime function parameter used as a value | `'before' is a comptime function parameter: it can only be called, or passed on for a comptime function parameter` |
| Function values at run time, called indirectly ([Function Types and Pointers](#function-types-and-pointers)) | Calling one: `calling a function value is not supported yet: only a function named directly, or a comptime function parameter (comptime f: (u32) -> u32), can be called` |
| Traits, interfaces or declared requirements | No syntax for them: what a generic needs of a type is what its body does with it ([8.3](#83-requirements)) |
| Functions run at compile time, `comptime func`, and tables they compute ([13](#comptime-evaluation)) | A syntax error |

Five of them, in one module:

```ents
func pick(comptime ok: bool, a: u32, b: u32) -> u32 => a
func count(comptime s: u32) -> u32 => s
func zero(comptime T: type) -> T => 0
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }
func pow(comptime e: u32, x: u64) -> u64 => if e == 0 { 1 } else { x * pow(e - 1, x) }

data name = "abc"

func a() -> u32 => count(name)
func b() -> u64 => zero()
func c() -> u32 => max
func d(x: u64) -> u64 => pow(2, x)
```

```errors
comptime parameter 'ok' is bool: a comptime parameter is a type (comptime T: type), an integer (comptime n: u32) or a function (comptime f: (T) -> T)
argument 1 of 'count' must be a compile-time constant: s is a comptime value parameter
cannot infer T for 'zero': write the type argument, as in zero(u32)
generic function 'max' must be called
argument 1: cannot assign int(-1) to u32, in pow(e = 0)
```

The rules of this chapter refuse these too; they are not features to come:

| Refused | Error |
|---|---|
| A host import with comptime parameters, of a generic function or a generic type | `a host import cannot have comptime parameters` |
| A length or a bound that is not a compile-time constant, `[len]u8` with a variable | `array length must be a compile-time constant` (for a parameter, with the hint `to give it at compile time, write comptime len: u32`) |
| A generic type that refers to itself with a type made of its parameters, `List(*T)` in `List(T)` | `generic type 'List' refers to itself with a type argument that grows, List(*T): applying it would never end` |
| A generic type that shares its name with a `type` or another generic type | `'Vec' is already declared: a generic type's name is unique in its module` |
| A generic type without its arguments, or with the wrong number | `'Vec' is a generic type: write Vec(T)`; `Vec expects 1 type argument, got 2` |
| A type that is not generic, applied | `'Point' is not a generic type` |
| A constructor on a type that is not a struct or tuple | `u32 is not a struct or tuple type: it has no constructor; to convert a number write x as T` |
| An array held in registers (a value array, or the array field of a struct held in a variable or parameter) indexed at run time, in a generic as anywhere; behind a pointer an array field is indexed as the `*[n]T` it is there ([9.6](#fixed-arrays-in-place)) | `dynamic index on value type [8]u32 — use a pointer or slice for dynamic access` |

<!-- spec:end -->

### 8.10 How This Is Compile-Time Evaluation

A name bound at compile time is declared at module level (`def n = 64` binds a number, `type Pt = (...)` a type, `func f` a function), or it is a comptime parameter, bound anew by each call of a generic. A compile-time value is a type, a function or a number. The table puts the two kinds of binding side by side; its last column is not in the language ([8.9](#89-not-in-this-version)):

| Bound at compile time | Declared at module level | Given to a generic | Not implemented |
|---|---|---|---|
| a type | `type Pt = (q: i32, r: i32)` | `comptime T: type` | |
| a function | `func f(...)` | `comptime before: (T, T) -> bool` | |
| a number | `def n = 64` | `comptime n: u32`, as in `[n]T` | |
| a type computed from types and numbers | a generic type, `func Vec(comptime T: type) -> type => ...`, applied as `Vec(u32)` | | a body of several statements, conditions |
| a bool | `def debug = false` | | `comptime ok: bool`, with a compile-time `if` |
| a value computed from values | `def bytes = n * 8` | | `comptime func`, and tables computed by it ([13](#comptime-evaluation)) |

A call with comptime arguments is evaluated as far as its comptime parameters go: an application of a generic type completely (the result is a type, and nothing is left for run time), a call of a generic function partially (the result is a function specialised to those arguments, and what is left for run time is a call of it with the other arguments).

Nothing else runs at compile time: the compiler executes no function body. What it evaluates are constant expressions, in a `def`'s value, a length, a range bound and a value argument: numbers, `def`s, value parameters, `sizeof` of a type, the `.len` and `.wid` of a `*[N]T`, and operators on these ([Comptime Literal Promotion](#comptime-literal-promotion)).

---

## 9. Memory Model

A program keeps its values in two places. **Registers** are the wasm values of a function, its parameters, results and locals, and the globals of the module: every variable, parameter, result and global is held there, a value of several parts in several registers ([9.3](#93-wasm-type-mapping)). **Memory** is the module's one linear memory: bytes at 32-bit addresses from 0, in pages of 64 KiB ([7.3](#73-memory-declarations)). A value is in memory only where the program puts it: `data` declarations, literals given where a pointer or a slice is wanted, and `&` of a literal are laid out there when the program is compiled, and a store through a pointer writes there when it runs.

The language allocates nothing at run time. There is no heap, no garbage collector and no stack in memory: a function's variables are wasm locals, and calls use the engine's own call stack. The memory from the end of the data up ([`sizeof data`](#104-sizes)) is the program's to use as it likes; [`lib/stack.ents`](../lib/stack.ents) is a bump allocator over a `data` buffer, and the containers of `lib/` allocate from it.

### 9.0 Data Layout

Data is laid out from address 8 up. Address 0 is the none of an optional pointer or slice ([Optional Types](#optional-types)), so nothing real may live there, and the bytes 0 to 7 are never used. The data of each module is laid out in turn, a module that another imports before the one that imports it; within a module come its `data` declarations in the order they are written, then the literals its code lays out. A program does not depend on that order: it takes an address from the name of the data (`buf as u32`), never writes one as a number.

Entries follow one another with no padding and no alignment, so a `u32` or a `u64` may start at an odd address. A wasm load or store takes any address, so this is never an error, though some engines are slower at an unaligned one. Where alignment matters for speed, the program arranges it: it declares its widest data first, or allocates with an allocator that rounds addresses up (`alloc` of `lib/stack.ents` rounds to 8).

A literal laid out in memory takes one place in the data for each place it is written in the source:

- Equal constant literals may share their bytes: `"abc"` written in two functions can be one address. A `mut` literal and mutable `data` are always their own ([3.2](#32-data-declarations-data)).
- A literal with a part known only at run time, `sum([x, 5, 6])`, is laid out once, with its constant parts. Each time the expression runs, the run-time parts are stored into that place, so a pointer kept from an earlier run sees the values of the latest.
- Bytes that are zero cost nothing in the module: memory starts zeroed, and the data section holds only the others. `data buf = mut [0:u8; 65536]` adds no bytes to the `.wasm` file.

Memory has no read-only part. Const data is const in the type system: nothing writes through a const pointer, but a cast to a `*mut` pointer does (`text as *mut [3]u8`), and every literal that shares those bytes then reads what was written.

`sizeof data` is the address just past the last byte of the program's data: where the memory that nothing is laid out in begins. It is a `u32`, at least 8, the same in every module of the program ([10.4](#104-sizes)). (Known compiler bug: in a program with no data at all it reads 0.)

<!-- spec:begin compile -->

```ents
data greeting = "Hello"
data pair = [7:u32, 8]

func free-start() -> u32 => sizeof data

test "data is laid out from address 8, one entry after another" {
  assert greeting as u32 == 8
  assert pair as u32 == 13          // right after the 5 bytes of greeting: no alignment
  assert pair[1] == 8
  assert free-start() == 21
}
```

<!-- spec:end -->

### 9.1 Stack vs Memory Allocation

Where a value lives follows from how it is declared:

| Declaration | Lives in | As |
|-------------|----------|----|
| `let n: i32` | registers | one wasm local |
| `let p: Point`, with `type Point = (x: f32, y: f32)` | registers | one local per field: `p.x` is `(local.get $p_x)` |
| `let v: [4]u32` | registers | one local per element |
| `let w: u128` | registers | two `i64` locals |
| `let s: []u8` | registers | two `i32` locals, the address and the length |
| `let q: ?*u8`, `let o: ?[]u8` | registers | as the plain pointer and slice, 0 for none |
| `let c: Canvas`, with `type Canvas = host` | registers | one `externref` local |
| `let ptr: *[64]u8 = buffer` | registers | one `i32` local holding an address: nothing is allocated |
| `global g: i32 = 0` | registers | one wasm global, or one per register for a value of several |
| `data buffer = mut [0:u8; 64]` | memory | 64 bytes laid out at compile time; `buffer` is their address, a constant `*mut [64]u8` |
| a literal where a pointer or slice is wanted: `sum([1, 2, 3])`, `log("hi")` | memory | laid out as data is ([9.0](#90-data-layout)) |
| `&5`, or `&(1.0, 2.0)` where a `*Point` is wanted | memory | a cell of its own, which can be written ([4.7](#element-addresses-and-writes)) |

A variable is never in memory, so it has no address: `&x` of a variable is an error, and a fixed array held in a variable is indexed only by a constant ([2.4](#24-fixed-arrays-value-type)). A `def` is no storage at all: its value is put where its name is written ([3.1](#31-definitions-def)), and an array or a string is laid out with `data` instead (`def cannot contain array/string literals — use 'data table = ...' instead`).

<!-- spec:begin compile -->

```ents
type Point = (x: f32, y: f32)

data buffer = mut [0:u8; 64]            // 64 bytes of memory: buffer is a *mut [64]u8

func demo() -> f32 {
  let p = Point(1.0, 2.0)               // two f32 locals
  let ptr: *mut [64]u8 = buffer         // one i32 local, the address of buffer
  ptr[0] = 9                            // a store into memory
  return p.x + ptr[0]                   // a local read, and a load
}

test "registers and memory" {
  assert demo() == 10.0
  assert buffer[0] == 9
}
```

```ents
func address(x: i32) -> *i32 => &x
```

```errors
'x' has no address: a variable is held in registers
```

<!-- spec:end -->

### 9.2 By-Value vs By-Reference Passing

Every argument and result is passed by value. A struct, a tuple or a fixed array goes as its parts, one wasm parameter or result each, in order ([9.3](#93-wasm-type-mapping)); the function gets a copy, and assigning to its parameter changes nothing for the caller. A pointer or a slice is passed the same way, as its address (and length): what is copied is the address, and the memory it points to is shared, so a write through it is seen by the caller.

A function that changes a struct of its caller's takes a pointer to it, and the struct then has to be in memory: `data`, an element of an array in memory, or a field of a struct a pointer points to. A pointer is no struct, and `ptr.*` loads the copy where a value is wanted:

<!-- spec:begin compile -->

```ents
type Point = (x: f32, y: f32)

data spot: Point = mut (3.0, 4.0)       // a *mut Point

func length(p: Point) -> f32 => sqrt(p.x * p.x + p.y * p.y)   // two f32 parameters

func moved(p: Point) -> Point {
  p.x += 1.0                            // the caller's value does not change
  return p
}

func reset(p: *mut Point) {             // one i32 parameter
  p.x = 0.0                             // writes the caller's memory
  p.y = 0.0
}

test "values are copied, memory is shared" {
  let p = Point(3.0, 4.0)
  assert moved(p).x == 4.0
  assert p.x == 3.0
  assert length(spot.*) == 5.0
  reset(spot)
  assert spot.x == 0.0
}
```

A struct passed by value is its fields: to the host and in the `.wasm` file, `length` is the same function as one written with two `f32` parameters.

```ents
type Point = (x: f32, y: f32)

export func length(p: Point) -> f32 => sqrt(p.x * p.x + p.y * p.y)
```

```ents same-wasm
export func length(x: f32, y: f32) -> f32 => sqrt(x * x + y * y)
```

```ents
type Point = (x: f32, y: f32)

func length(p: Point) -> f32 => sqrt(p.x * p.x + p.y * p.y)
func reset(p: *mut Point) { p.* = Point(0.0, 0.0) }

func of(ptr: *Point) -> f32 => length(ptr)
func clear() {
  let p = Point(3.0, 4.0)
  reset(&p)
}
```

```errors
argument 1: cannot assign *Point to Point
'p' has no address: a variable is held in registers
```

<!-- spec:end -->

#### Structural Coercion

A struct or tuple value that already exists converts to another struct type only where nothing has to be computed for it: the two have the same fields, with the same names in the same order, and each field converts to the other's type ([2.10](#implicit-widening)) and is held in the same wasm value ([9.3](#93-wasm-type-mapping)). A `(x: i8, y: i8)` is a `(x: i32, y: i32)`: each field is an `i32` in wasm either way, an `i8` kept sign-extended in it. A `(x: i32, y: i32)` is no `(x: i64, y: i64)`, since each field would have to be converted (`cannot convert BigPoint to Wide implicitly: convert its fields`): the program builds the new struct from the fields, `Wide(p.x, p.y)`, and each field converts there. A field that does not convert at all is the plain error (`cannot assign (x: u32, y: u32) to BigPoint`). A tuple without names is not a struct with names, and a struct with the same names in another order is none either: only a literal gives its fields by name ([2.8](#struct-constructors)).

A literal is different: its elements convert one by one, as any value meets a declared type, by name where it names them. So `(x: n, y: n)` with `n: i32` is a `Wide`, and `(y: 2, x: 1)` is a `BigPoint` with an `x` of 1.

Through a pointer nothing converts: memory is read as the type the pointer gives it, so a pointer converts only to a pointer to the same type (names, field types and order; or the const form of a `*mut`), and a `*(x: i8, y: i8)`, 2 bytes, is no `*BigPoint`, 8 bytes.

<!-- spec:begin compile -->

```ents
type BigPoint = (x: i32, y: i32)
type Wide = (x: i64, y: i64)

func scale(p: BigPoint, k: i32) -> BigPoint => BigPoint(p.x * k, p.y * k)
func sum(w: Wide) -> i64 => w.x + w.y

test "a struct converts when its fields are held the same way" {
  let small = (x: -10:i8, y: 20:i8)
  assert scale(small, 2).x == -20       // i8 fields are i32s already
  let p = BigPoint(1, 2)
  assert sum(Wide(p.x, p.y)) == 3       // i32 to i64: convert the fields
  let n: i32 = 4
  assert sum((x: n, y: n)) == 8         // a literal converts element by element
  assert scale((y: 2, x: 1), 1).x == 1  // and by name
}
```

```ents
type BigPoint = (x: i32, y: i32)
type Wide = (x: i64, y: i64)

func sum(w: Wide) -> i64 => w.x + w.y
func first(p: *BigPoint) -> i32 => p.x

func a(p: BigPoint) -> i64 => sum(p)
func b(q: (x: u32, y: u32)) -> BigPoint => q
func c(q: (i32, i32)) -> BigPoint => q
func d(q: *(x: i8, y: i8)) -> i32 => first(q)
```

```errors
argument 1: cannot convert BigPoint to Wide implicitly: convert its fields
cannot assign (x: u32, y: u32) to BigPoint
cannot assign (i32, i32) to BigPoint
argument 1: cannot assign *(x: i8, y: i8) to *BigPoint
```

<!-- spec:end -->

### 9.3 WASM Type Mapping

Each type is held in registers as these wasm values:

| Encantis | WASM |
|----------|------|
| `i8`, `i16`, `i32`, `u8`, `u16`, `u32` | `i32` |
| `bool` | `i32`: 0 or 1 |
| `i64`, `u64` | `i64` |
| `i128`, `u128` | two `i64`, least significant first |
| `i256`, `u256` | four `i64`, least significant first |
| `i512`, `u512` | eight `i64`, least significant first |
| `f32` | `f32` |
| `f64` | `f64` |
| a ranged integer, `u32#N` | its base type: the range is checked at compile time and nothing of it is left |
| `*T`, `*[N]T`, `*[!]T`, `*[NxM]T`, `*[N][M]T`, `[*]T` | `i32`: the address |
| `[]T` | `i32 i32`: the address, then the length |
| `?*T` and every other optional pointer | `i32`, 0 for none |
| `?[]T` | `i32 i32`, the address 0 and the length 0 for none |
| a host type, `type Canvas = host` | `externref`, never null ([2.13](#213-host-references)) |
| `?Canvas` | `externref`, null for none |
| a struct or tuple, `(a: T1, b: T2, ...)` | the values of each field, in order |
| a fixed array `[N]T` held by value | the values of each element, in order |
| `()` | nothing |

A value of several wasm values is that many parameters, results, locals or globals, in that order: a parameter `p: Point` is two `f32` parameters, a `[]u8` result is two `i32` results. Their names in the WAT text are the compiler's; to the host only the order counts ([7.2](#72-exports)).

An integer narrower than 32 bits is held in its `i32` as the number it is: a `u8` or a `u16` zero-extended, an `i8` or an `i16` sign-extended, and a `bool` is 0 or 1. Each operation keeps it so, by masking or sign-extending its result in its own type: `a + b` on two `u8` values is `(i32.and (i32.add a b) (i32.const 255))`, and on two `i8` values a shift left by 24 and back. So widening one of these to a wider one up to 32 bits costs nothing ([11.1](#111-widening-instructions-implicit)). A value an exported function receives is taken as the host gives it, unchecked: the host passes a value its parameter's type holds.

### 9.4 Slice Construction

A slice is an address and a length. Most slices are made without writing either:

- a pointer to an array is a slice of its whole length wherever a slice is wanted ([9.5](#95-array-type-conversions));
- a range takes part of an array, a slice or a many-pointer: `buf[2..6]`, `s[i..] ?? ""`, `p[0..n]` ([4.8](#48-slicerange-syntax)). A many-pointer has no length, so its range is how a length is given to it.

A pair `(ptr, len)` where a slice is wanted is that slice, for an address and a length that come from elsewhere: a header in memory, the host, arithmetic. The first part is a many-pointer to the slice's elements, as writable as the slice (`slice pointer: cannot assign [*]i32 to [*]mut i32`); a pointer to one value is not one (`slice pointer: cannot assign *i32 to [*]i32`: cast it, `q as [*]i32`). The length is a `u32` (`slice length: cannot assign u64 to u32`). Nothing else is a slice: no other tuple, a single value in parentheses (which is that value), and a many-pointer alone, which has no length.

<!-- spec:begin compile -->

```ents
data buffer = mut [0:u8; 16]

func whole() -> []u8 => buffer                          // *mut [16]u8 to []u8
func middle() -> []mut u8 => buffer[4..12]              // a range, proven at compile time
func first(p: [*]u8, n: u32) -> []u8 => p[0..n]         // a many-pointer is given a length
func at(addr: u32, n: u32) -> []u8 => (addr as [*]u8, n)  // an address and a length from elsewhere

test "slices" {
  assert whole().len == 16
  assert middle().len == 8
  assert first(buffer, 3).len == 3
  let s = at(buffer as u32 + 2, 5)
  assert s.ptr as u32 == buffer as u32 + 2
  assert s.len == 5
}
```

```ents
func f(p: [*]i32, q: *i32, n: u64) {
  let a: []mut i32 = (p, 2)
  let b: []u8 = (p, 2)
  let c: []i32 = (p, n)
  let d: []i32 = (q, 2)
  let e: []i32 = p
  let g: []i32 = (1, 2, 3)
}
```

```errors
slice pointer: cannot assign [*]i32 to [*]mut i32
slice pointer: cannot assign [*]i32 to [*]u8
slice length: cannot assign u64 to u32
slice pointer: cannot assign *i32 to [*]i32
cannot assign [*]i32 to []i32
cannot assign (int(1), int(2), int(3)) to []i32
```

<!-- spec:end -->

### 9.5 Array Type Conversions

| From | To | How |
|------|----|-----|
| `*[N]T` | `[]T` | implicit: a slice of length N |
| `*[N]T` | `[*]T` | implicit, or `p.ptr` |
| `*mut [N]T`, `[]mut T`, `[*]mut T` | the same without `mut` | implicit |
| `[]T` | `[*]T` | `s.ptr` |
| `[]T` | `u32` | `s.len` |
| `*[!]T` | `[*]T` | `z.ptr` |
| `*[!]T` | `[]T` | `(z.ptr, z.len)`: the length is scanned for |
| `[*]T` and a length | `[]T` | `p[0..n]`, or the pair `(p, n)` ([9.4](#94-slice-construction)) |
| `[*]T` | `[]T` | error: it has no length (`cannot assign [*]u8 to []u8`) |
| `*T` | `[*]T` | a cast, `q as [*]T` |
| a pointer or slice of `T` | one of another element `U` | error, also where `T` widens to `U`: the elements would have to be laid out alike ([9.2](#structural-coercion)) |
| a pointer | another pointer type, `u32` or `i32` | a cast ([2.10](#explicit-casts)) |

`*[N]T` to `[]T` is implicit wherever a `[]T` is expected: an argument, an initializer or an assignment, a returned value or an expression body, a branch of an `if` or `match`, and a field of a struct or tuple literal. Pointers to arrays of different lengths in one literal that has no type written are slices of their own lengths, written out or as the branches of an `if` or `match`: with `three: *[3]i32` and `four: *[4]i32`, `let both = [three, four]` is a `[2][]i32` (and so is `global both` or `data both` of it), as `["ab", "cde"]` is a `[2][]u8`, `[[three, three], [four, four]]` is a `[2][2][]i32` and `[(three, 1), (four, 2)]` is a `[2]([]i32, i32)`. Rows written out with no type have to be of one length: `let rows = [[1, 2], [3, 4, 5]]` is an error (`rows of different lengths: ...`), and `data rows: *[2][]i32 = [[1, 2], [3, 4, 5]]` lays them out as slices of their own lengths. A struct or tuple that is already a value is not converted as a whole, as no struct is (`cannot convert (s: *[3]u8, n: u32) to Holder implicitly: convert its fields`): build the struct from its fields, `Holder(t.s, t.n)`, and each field converts.

<!-- spec:begin compile -->

```ents
type Holder = (s: []u8, n: u32)

data three = [1, 2, 3]
data four = [4, 5, 6, 7]
data rows: *[2][]i32 = [[1, 2], [3, 4, 5]]

func total(xs: []i32) -> i32 {
  let t = 0
  for x in xs { t += x }
  return t
}

func lengths() -> u32 {
  let both = [three, four]              // a [2][]i32
  return both[0].len + both[1].len
}

func hold(t: (s: *[3]u8, n: u32)) -> Holder => Holder(t.s, t.n)

test "a pointer to an array is a slice of its length" {
  assert total(three) == 6
  assert lengths() == 7
  assert rows[1].len == 3
  assert hold(("abc", 3)).s.len == 3
}
```

```ents
type Holder = (s: []u8, n: u32)

func hold(t: (s: *[3]u8, n: u32)) -> Holder => t
func widen(s: []u8) -> []u16 => s
func row() -> u32 {
  let rows = [[1, 2], [3, 4, 5]]
  return 0
}
```

```errors
cannot convert (s: *[3]u8, n: u32) to Holder implicitly: convert its fields
cannot assign []u8 to []u16
rows of different lengths
```

<!-- spec:end -->

### 9.6 Structs and Slices in Memory

Any value type but a host reference ([2.13](#213-host-references)) can be an element of an array or the target of a pointer. In memory a value is its parts one after another, in declaration order, with no padding and no alignment: the language is byte-oriented. A number is stored little-endian, as wasm memory is: the `u32` `0x01020304` is the bytes 4, 3, 2, 1 from its address up.

| Type | Bytes in memory |
|------|-----------------|
| `i8`, `u8` | 1 |
| `bool` | 1: 0 or 1 |
| `i16`, `u16` | 2 |
| `i32`, `u32`, `f32` | 4 |
| `i64`, `u64`, `f64` | 8 |
| `i128` ... `u512` | 16 ... 64, as 64-bit limbs, least significant first |
| `*T`, `[*]T`, `*[N]T`, `*[!]T`, and an optional pointer | 4: the address, 0 for none |
| `[]T`, `?[]T` | 8: the address, then the length |
| `[N]T` | N × `sizeof(T)` |
| `(a: T1, b: T2, ...)` | the sum of its fields; field `b` starts where `a` ends |
| `()` | 0 |

`sizeof(T)` is this size ([10.4](#104-sizes)), and it is the stride of `[*]T`, `*[N]T` and `[]T`: element `i` is at `i * sizeof(T)` bytes from the start. A struct inside a struct, or a slice or fixed array inside one, lies in place at its field's offset. The one exception is a fixed array that is the element of a pointer or slice (`*[N][M]T`, `[][M]T`, `[*][M]T`): there each element is a 4-byte pointer to its row, which lies apart ([Nesting](#nesting)).

<!-- spec:begin compile -->

```ents
type Lane = (cells: []i32, free: i32)     // 12 bytes: cells.ptr at 0, cells.len at 4, free at 8
type Slot = (d: i32, lane: Lane)          // 16 bytes: d at 0, lane at 4
type Mixed = (a: u8, b: i16, c: u64)      // 11 bytes: a at 0, b at 1, c at 3

data mixed: Mixed = (1, 0x0203, 4)

test "a struct in memory is its fields, packed" {
  assert sizeof(Lane) == 12
  assert sizeof(Slot) == 16
  assert sizeof(Mixed) == 11
  let bytes = mixed as [*]u8
  assert bytes[1] == 3                    // b starts right after a, its low byte first
  assert bytes[2] == 2
  assert bytes[3] == 4                    // and c right after b
}
```

<!-- spec:end -->

A value in memory is read and written whole or part by part. Each wasm value of it is one load or store at its offset, so there is nothing to pay for the struct: `list[k] = Spot(a, b, c)` is three stores, and `list[k].di` is one load.

<!-- spec:begin compile -->

```ents
type Spot = (c: i32, di: i32, room: i32)

data spots: *mut [4]Spot = mut [(0, 0, 0); 4]
data one: Spot = mut (0, 0, 0)

func sum(s: Spot) -> i32 => s.c + s.di + s.room

func demo(list: [*]mut Spot, k: u32, p: *mut Spot, all: []Spot) -> i32 {
  list[k] = Spot(20, 1, 2)          // three stores
  let s = list[k]                   // three loads: s is a copy, in registers
  p.* = s                           // three stores through a pointer to one struct
  p.di += 1                         // one field through the pointer (p.* is implied)
  list[k + 1] = list[k]             // copied from one place to another
  let t = sum(p.*) + sum(list[k])   // loaded, and passed by value
  for spot in all {                 // each element in turn
    t += spot.room
  }
  return t
}

test "structs in memory are loaded and stored field by field" {
  assert demo(spots, 1, one, spots) == 24 + 23 + 4
  assert spots[2].c == 20
  assert one.di == 2
}
```

<!-- spec:end -->

The same goes for slices held in memory, at any depth: `lists[k] = make()`, `opts[i].lane.cells.len`, `for x in opts[i].lane.cells { ... }`.

#### Fixed Arrays in Place

A fixed array that is a field of a struct in memory lies there in place, its elements one after another at the field's offset. There it has an address, and wherever an index is not a constant it is reached through that address, as the `*[N]T` it is: `p.items[i]` with `p` a `*mut Pool` is `p.items` seen as a `*mut [64]Entity`, indexed. Nothing is loaded but the element, and the rules are a `*[N]T`'s ([4.7](#47-bounds-checked-indexing)): a constant or ranged index is proven and needs no check, any other is resolved with `if let` or `??`, and a write with one goes through the element's address, `&p.items[i]`, a `?*mut Entity`. The pointer is as mutable as the place: through a `*Pool` it is a `*[64]Entity`, and a write is refused as any write through a const pointer is. A loop, a range and `&` reach the array the same way: `for e in p.items`, `p.items[a..b]`, and `&p.items`, which is the `*mut [64]Entity` itself, to pass where a pointer or a slice is wanted. Any other value in memory has its address too: `&p.count` is a `*mut u32`. A constant index picks the element where it lies: `p.items[2].x` is one load at a constant offset.

An array of fixed arrays lies there packed, row after row (`sizeof([N][M]T)` is `N × M × sizeof(T)`), so in place it is the `*[NxM]T` its rows make, not a table ([Nesting](#nesting)): `m.tiles[r][c]` is the byte `r × M + c` from the start of the field, with the row index checked against N and the column against M.

Only a value in memory has an address. A struct in a variable, a parameter or a call's result is held in registers ([9.2](#92-by-value-vs-by-reference-passing)), and so is each field of it: indexing its array at run time is an error, as for any fixed array in registers, and so is `&` of it.

<!-- spec:begin compile -->

```ents
type Entity = (x: i32, y: i32, alive: bool)
type Pool = (count: u32, items: [64]Entity)
type Map = (cols: u32, tiles: [3][4]u8)

data pool: Pool = mut (0, [(0, 0, false); 64])
data map: Map = mut (4, [[0; 4]; 3])

// The next free slot, or none when the pool is full.
func spawn(x: i32, y: i32) -> ?*mut Entity {
  if let e = &pool.items[pool.count] {
    e.* = Entity(x, y, true)
    pool.count += 1
    return e
  }
  return 0 as ?*mut Entity
}

func x-of(i: u32) -> i32 => (pool.items[i] ?? Entity(-1, -1, false)).x
func move(k: u32#64, dx: i32) { pool.items[k].x += dx }

func alive() -> u32 {
  let n: u32 = 0
  for e in pool.items {
    if e.alive { n += 1 }
  }
  return n
}

func all() -> *mut [64]Entity => &pool.items
func count-cell() -> *mut u32 => &pool.count
func set-tile(r: u32#3, c: u32#4, v: u8) { map.tiles[r][c] = v }

test "an array field in memory is indexed there" {
  assert spawn(3, 4) != 0 as ?*mut Entity
  assert spawn(5, 6) != 0 as ?*mut Entity
  move(1, 10)
  assert x-of(1) == 15
  assert x-of(99) == -1
  assert alive() == 2
  assert all()[0].y == 4
  set-tile(2, 3, 9)
  assert map.tiles[2][3] == 9
  for i in 70 { spawn(1, 1) }
  assert pool.count == 64
  let n = count-cell()
  n.* = 0
  assert spawn(7, 7) != 0 as ?*mut Entity
  assert x-of(0) == 7
}
```

An index costs what it does on the `*[N]T` written out by hand:

```ents
type Cell = (x: i32, live: bool)
type Pool = (n: u32, cells: [8]Cell)

export func x-of(p: *Pool, k: u32#8) -> i32 => p.cells[k].x
```

```ents same-wasm
type Cell = (x: i32, live: bool)
type Pool = (n: u32, cells: [8]Cell)

export func x-of(p: *Pool, k: u32#8) -> i32 => (((p as u32) + 4) as *[8]Cell)[k].x
```

The array's place decides, not its type:

```ents
type Cell = (x: i32, live: bool)
type Pool = (n: u32, cells: [8]Cell)

func a(p: *Pool, k: u32#8) { p.cells[k].x = 1 }
func b(v: Pool, i: u32) -> i32 => v.cells[i].x
func c(p: *mut Pool, i: u32) { p.cells[i].x = 3 }
func d(v: Pool) -> *[8]Cell => &v.cells
```

```errors
cannot write through const pointer
dynamic index on value type [8]Cell
writing to an element needs an index known to be in range
'v.cells' has no address: it is part of 'v', a variable held in registers
```

<!-- spec:end -->

### 9.7 Traps

A trap stops the program where it is. The call that the host made into the module ends at once with an error (a `WebAssembly.RuntimeError` in JavaScript); nothing more of the module runs for it, not even a deferred expression ([5.3](#53-control-statements)), and nothing in the language catches it. What the call wrote to memory and to globals before the trap stays written, so a host that calls the module again after a trap finds it as the trap left it.

These trap:

| What | When |
|------|------|
| integer `/` and `%` by zero | `a / b` or `a % b` with `b` zero: signed or unsigned, any width |
| signed `/` that overflows | the most negative value divided by -1, `-2147483648 / -1` (its `%` is 0, no trap) |
| a float cast to an integer that cannot hold it | `x as i32` with `x` NaN, infinite or out of the range of the 32- or 64-bit integer it is truncated to: `1.0e30 as i32`, `-1.0 as u8` (a narrower type is truncated to 32 bits first, then masked: `300.0 as u8` is 44) |
| a load or a store past the end of memory | a many-pointer indexed far past its data, a pointer cast from a number, a `*[!]T` length scan that finds no terminator before the end |
| `memcpy`, `memset`, `memzero`, a range fill or a range copy past the end of memory | a length known only at run time that is too large ([10.3](#103-memory-builtins)) |
| a `match` whose subject matches no arm, with no `_` arm | [5.4](#54-match-expressions) |
| an `assert` whose condition is false | outside `encantis test` as well |
| a call deeper than the engine's call stack | unbounded recursion |
| a host value of a plain host type that is null, where it enters the module | an argument of an exported function, the result of an imported one, an imported global ([2.13](#213-host-references)) |

An imported function can also throw: the host's exception passes through the module's calls in the same way, and nothing of the module runs after it either.

These never trap:

- Integer `+`, `-`, `*`, `<<`, negation and `abs` wrap around in their type: a `u8` 255 plus 1 is 0, and `abs` of the most negative value is that value. A shift count is taken modulo the width ([4.2](#42-bitwise-operators)).
- Float arithmetic follows IEEE 754: `1.0 / 0.0` is infinity and `0.0 / 0.0` is NaN.
- A checked index or range that is out of range gives none, which `if let` or `??` resolves ([4.7](#47-bounds-checked-indexing)). A write into an array or a slice needs an index proven in range at compile time, or goes through `&s[i]`, which is checked the same way, so no such write is out of range at run time.
- A load or a store at any address inside memory, address 0 included. A null pointer is no trap: it reads and writes the unused bytes 0 to 7, which is why an optional pointer is resolved before it is used ([Optional Types](#optional-types)).
- An index into a many-pointer, which is checked against nothing: inside memory it reads or writes whatever is there.

<!-- spec:begin compile -->

```ents
func rem(a: i32, b: i32) -> i32 => a % b
func ratio(a: f64, b: f64) -> f64 => a / b

test "what does not trap" {
  let byte: u8 = 255
  assert byte + 1 == 0                  // wraps in its type
  assert abs(-128:i8) == -128
  assert rem(-2147483648, -1) == 0
  assert ratio(1.0, 0.0) > 1.0e308      // infinity
  let nan = ratio(0.0, 0.0)
  assert nan != nan
  let big = 300.0
  assert big as u8 == 44
}
```

<!-- spec:end -->

---

## 10. Builtin Functions

Encantis provides built-in functions that map directly to WASM instructions. These are called like regular functions: each operand is evaluated once, in order, and they take positional arguments only (`'min' takes positional arguments`). Like any function, a builtin can be called with its first operand as the receiver, `x.sqrt()`, `a.min(b)` ([4.9](#49-method-call-syntax)). Their names are not reserved: a function the program declares with the name of a builtin takes its place. A generic function does too: `func max(comptime T: type, a: T, b: T) -> T` is what `max(a, b)` calls in its module (see [8. Generics](#8-generics)), and so does an imported one. The compiler warns where such a function is declared, once for each declaration (each of the functions that share the name, and one a `test` declares, too): `'max' replaces the builtin max in this module`. A parameter that holds a value, or a local variable, with a builtin's name is no function and replaces nothing: `max(a, b)` beside `let max = 3` is still the builtin, and nothing is said. A comptime function parameter ([8.6](#86-comptime-function-parameters)) is a function: in the body of its generic a call of its name calls the function given for it, so `comptime max: (u32, u32) -> u32` is warned of where it is declared, once: `'max' replaces the builtin max in the body of 'app'`.

| Builtin | Operands | Result | Section |
|---------|----------|--------|---------|
| `sqrt`, `ceil`, `floor`, `trunc`, `nearest` | one float | the same float type | [10.1](#101-numeric-builtins) |
| `copysign` | two floats | the float type | [10.1](#101-numeric-builtins) |
| `abs` | one integer or float | the same type | [10.1](#101-numeric-builtins) |
| `min`, `max` | two integers or two floats | their type | [10.1](#101-numeric-builtins) |
| `clz`, `ctz`, `popcnt` | one `i32`, `u32`, `i64` or `u64` | `u8` | [10.2](#102-integer-builtins) |
| `mul_hi` | two `u64` | `u64` | [10.2](#102-integer-builtins) |
| `memcpy` | `*mut [N]T`, `*[M]U` or `[*]U`, `u32` | nothing | [10.3](#103-memory-builtins) |
| `memset` | `*mut [N]T`, `u8`, `u32` | nothing | [10.3](#103-memory-builtins) |
| `memzero` | `*mut [N]T` | nothing | [10.3](#103-memory-builtins) |
| `sizeof(T)` | a type | `u32` | [10.4](#104-sizes) |
| `sizeof data` | none | `u32` | [10.4](#104-sizes) |

A call with another number of operands is an error that says how many it takes (`abs expects 1 argument, got 2`, `memset expects 3 arguments (dest, value, len), got 2`).

### 10.1 Numeric Builtins

| Function | Input | Returns | Description | WASM |
|----------|-------|---------|-------------|------|
| `sqrt(x)` | `f32`/`f64` | same | Square root; NaN for a negative `x` | `f32.sqrt`/`f64.sqrt` |
| `ceil(x)` | `f32`/`f64` | same | Round up | `f32.ceil`/`f64.ceil` |
| `floor(x)` | `f32`/`f64` | same | Round down | `f32.floor`/`f64.floor` |
| `trunc(x)` | `f32`/`f64` | same | Round toward zero | `f32.trunc`/`f64.trunc` |
| `nearest(x)` | `f32`/`f64` | same | Round to the nearest integer, a half to the even one | `f32.nearest`/`f64.nearest` |
| `copysign(x, y)` | `f32`/`f64` | same | `x` with the sign of `y` | `f32.copysign`/`f64.copysign` |
| `abs(x)` | any integer or float | same | Absolute value | float: `f32.abs`/`f64.abs`; signed integer: a `select` of `x` and `0 - x`; unsigned: `x` itself |
| `min(a, b)` | two integers or two floats | their type | The smaller | float: `f32.min`/`f64.min`; integer: a `select` on `lt_s` or `lt_u` |
| `max(a, b)` | two integers or two floats | their type | The larger | float: `f32.max`/`f64.max`; integer: a `select` on `gt_s` or `gt_u` |

The float builtins take a float, and the others a number: anything else is an error (`sqrt requires a float type, got i32`, `max requires a numeric type, got bool`). Their operands are typed together, like the operands of a binary operator. A literal takes the type of the other operand, whichever comes first, and two typed operands meet at the wider type ([2.10](#implicit-widening)). With only literals, the operands take their default type, `i32` or `f64`, and an integer literal given to a float builtin is an `f64`: `sqrt(2)` is `sqrt(2.0)`, an `f64` also where an `f32` is wanted (`cannot assign f64 to f32`), so a typed literal says which, `sqrt(2.0:f32)`.

On integers, `min` and `max` compare signed or unsigned as the operands' type says, and `abs` of an unsigned value is the value itself. `abs` of the most negative value of a type wraps back to it, as negating it does: `abs(-128:i8)` is `-128`. `min`, `max` and `abs` also take the wide integers, `i128` to `u512`, through functions the compiler adds ([11.5](#115-functions-the-compiler-adds)). `min` and `max` return one of their operands, so when every operand is in a range ([2.2](#ranged-integers)), the result is too: `min(i, 2)` with `i: u32#4` is still a `u32#4`, and indexes a `*[4]T` with no check. On floats they are the wasm instructions: NaN if either operand is NaN, and `-0.0` below `0.0`.

<!-- spec:begin compile -->

```ents
data table = [10:u8, 20, 30, 40]

func clamped(i: u32#4) -> u8 => table[min(i, 2)]   // still a u32#4: no check
func side(area: f64) -> f64 => area.sqrt()

test "numeric builtins" {
  let x: f64 = -3.7
  assert floor(x) == -4.0
  assert ceil(x) == -3.0
  assert trunc(x) == -3.0
  assert nearest(2.5) == 2.0                 // a half goes to the even neighbour
  assert nearest(3.5) == 4.0
  assert copysign(5.0, -1.0) == -5.0
  assert x.abs() == 3.7
  assert side(9.0) == 3.0
  assert clamped(3) == 30
}

test "operands are typed together" {
  let f: f32 = 0.25
  let m: f32 = max(1.0, f)                   // f32, the same as max(f, 1.0)
  assert m == 1.0
  let n: i32 = -7
  let big: i64 = 5000000000
  assert max(n, big) == big                  // i64: n widens
  assert abs(n - 10) == 17
  assert n.min(5) == -7
  assert abs(-128:i8) == -128                // wraps, as -(-128) does
}
```

<!-- spec:end -->

### 10.2 Integer Builtins

| Function | Input | Returns | Description | WASM |
|----------|-------|---------|-------------|------|
| `clz(x)` | `i32`/`u32`/`i64`/`u64` | `u8` | Count of leading zero bits (0 to the width) | `i32.clz`/`i64.clz` |
| `ctz(x)` | `i32`/`u32`/`i64`/`u64` | `u8` | Count of trailing zero bits (0 to the width) | `i32.ctz`/`i64.ctz` |
| `popcnt(x)` | `i32`/`u32`/`i64`/`u64` | `u8` | Count of one bits | `i32.popcnt`/`i64.popcnt` |
| `mul_hi(a, b)` | `u64`, `u64` | `u64` | High 64 bits of the 128-bit product | a call of `$__mul_hi` ([11.5](#115-functions-the-compiler-adds)) |

The bit counts return `u8` because the result can never exceed the bit width of the input (max 64), so it widens implicitly to any integer type. The count is of the operand's own bits, so a narrower or wider integer is an error (`clz requires i32, u32, i64 or u64, got u8`): convert it first (`clz(b as u32) - 24` for a `u8`). Arithmetic on the count alone is `u8` arithmetic, which wraps at 256: widen the count first where the result can pass 255 (`(ctz(x) as u32) * 8`).

`mul_hi` multiplies as unsigned: its operands widen to `u64`, so a `u32` or a `u8` is fine, and a signed one is an error (`mul_hi: cannot assign i64 to u64`).

<!-- spec:begin compile -->

```ents
func bits(x: u64) -> u32 => (ctz(x) as u32) * 8

test "integer builtins" {
  let n: u32 = 0b00001000
  assert clz(n) == 28
  assert ctz(n) == 3
  assert popcnt(n) == 1
  assert clz(0:u32) == 32
  let count: u32 = popcnt(n)                 // u8 widens to u32
  let big: u64 = 0x500000000
  assert big >> ctz(big) == 5                // the count widens to the u64 it shifts
  assert bits(0) == 512                      // ctz(0) * 8 as a u8 would be 0
  assert n.popcnt() == count
}

test "mul_hi" {
  assert mul_hi(0xFFFFFFFFFFFFFFFF, 2) == 1
  assert mul_hi(0xFFFFFFFFFFFFFFFF, 0xFFFFFFFFFFFFFFFF) == 0xFFFFFFFFFFFFFFFE
  let a: u32 = 0x80000000
  assert mul_hi(a, 0x400000000) == 2         // a widens to u64
}
```

```ents
func a(x: u8) -> u8 => clz(x)
func b(x: i64, y: i64) -> u64 => mul_hi(x, y)
func c(x: i32) -> f64 => sqrt(x)
```

```errors
clz requires i32, u32, i64 or u64, got u8
mul_hi: cannot assign i64 to u64
sqrt requires a float type, got i32
```

<!-- spec:end -->

### 10.3 Memory Builtins

| Function | Input | Returns | Description | WASM |
|----------|-------|---------|-------------|------|
| `memcpy(dest, src, len)` | `*mut [N]T`, `*[M]U` or `[*]U`, `u32` | — | Copy `len` bytes from `src` to `dest`; the two may overlap | `memory.copy` |
| `memset(dest, value, len)` | `*mut [N]T`, `u8`, `u32` | — | Set `len` bytes to `value` | `memory.fill` |
| `memzero(dest)` | `*mut [N]T` | — | Set all `N × sizeof(T)` bytes of `dest` to zero | `memory.fill` |

The destination is a pointer to an array of a size known at compile time, of any element type, and it is written, so it is a `*mut`:

- a slice is not one (`memcpy dest: expected *[N]T, got []mut u8`), nor a pointer to one value (`memzero dest: expected *[N]T, got *mut Point`: write `p.* = Point(0, 0)`);
- a `*[!]T` has no size known at compile time: `memcpy` and `memset` take one and check no length against it, and `memzero`, which has no length of its own, refuses it (`memzero dest: *mut [!]u8 has no size known at compile time`);
- a many-pointer has no size to check (`memset dest: many-pointer has no bounds — use a sized pointer for safe memory operations`); to write through one, cast it to the `*mut [N]T` it is known to point to;
- a const pointer is not written through (`memcpy dest: cannot write through const pointer *[4]u8 — use *mut for mutable access`).

The source of a `memcpy` is a pointer to an array, or a many-pointer, which has no size to check; a slice is passed as its `.ptr`. `len` counts bytes, whatever the element types (`memset(words, 0, 16)` clears four `u32`), and `value` is the byte each is set to (`memset value: cannot assign int(256) to u8`). With a constant `len`, the compiler checks it against the size of the destination and of a sized source (`memcpy length 20 exceeds buffer size 16 bytes`). A `len` known only at run time is not checked: it warns that it can't be, and a length past the array but inside memory writes over what follows it, silently; past the end of memory it traps ([9.7](#97-traps)).

The size of a table (`*[N][M]T`) is its N row pointers, 4 bytes each, and `memzero` of a table is an error ([Nesting](#nesting)). A length past a table's bytes is an error, and a runtime length for a table warns, each with a note that the rows lie apart: `n * sizeof(T)` for a `T` that is a fixed array counts the rows' cells, not the table.

The range forms of [4.8](#48-slicerange-syntax) do the same, checked: `p[..] = 0` is `memzero(p)`, a fill of a range of bytes is a `memset` and a copy between ranges of lengths known at compile time a `memcpy`. `memcpy` and `memset` are the forms for a length known only at run time. There is no bulk copy into a slice whose length is known only at run time: neither form takes a slice destination, so such a copy is a loop over the elements ([5.2](#52-loops)).

<!-- spec:begin compile -->

```ents
data bytes = mut [0:u8; 8]
data words = mut [1:u32, 2, 3, 4]

func stamp(upper: bool) { memcpy(bytes, if upper { "ABCD" } else { "abcd" }, 4) }
func copy-from(s: []u8, n: u32) { memcpy(bytes, s.ptr, n) }   // a length known at run time

test "memcpy, memset and memzero" {
  stamp(true)
  assert bytes[3] == 68
  memset(bytes, 7, 2)                   // two bytes
  assert bytes[1] == 7
  assert bytes[2] == 67
  copy-from("hello", 5)
  assert bytes[4] == 111
  memcpy(bytes, bytes[2..8].ptr, 6)     // overlapping: the bytes move down by two
  assert bytes[0] == 108
  memset(words, 0, 8)                   // eight bytes: the first two words
  assert words[1] == 0
  assert words[2] == 3
  memzero(words)
  assert words[3] == 0
}
```

```ents
type Point = (x: i32, y: i32)

data small = [1:u8, 2, 3, 4]
data buf = mut [0:u8; 16]

func a(d: []mut u8, s: []u8) { memcpy(d, s, 4) }
func b(p: *mut Point) { memzero(p) }
func c(d: [*]mut u8) { memset(d, 0, 4) }
func e() { memcpy(small, buf, 4) }
func f() { memcpy(buf, small, 20) }
```

```errors
memcpy dest: expected *[N]T, got []mut u8
memcpy src: expected *[N]T, got []u8
memzero dest: expected *[N]T, got *mut Point
memset dest: many-pointer has no bounds — use a sized pointer for safe memory operations
memcpy dest: cannot write through const pointer *[4]u8 — use *mut for mutable access
memcpy length 20 exceeds buffer size 16 bytes
memcpy length 20 exceeds buffer size 4 bytes
```

<!-- spec:end -->

**Not implemented:** `memory-size()`, the size of the memory in pages of 64 KiB, and `memory-grow(n)`, which would grow it by `n` pages and give the size it had before, or -1 when it cannot grow (`memory.size` and `memory.grow`). A call of either is an error (`unknown identifier 'memory-size'`), and the memory keeps the size it starts with unless the host grows an exported one ([7.3](#73-memory-declarations)).

### 10.4 Sizes

`sizeof(T)` is the number of bytes a value of type `T` takes in memory ([9.6](#96-structs-and-slices-in-memory)): 1 for a `u8` or a `bool`, 4 for any pointer, 8 for any slice, the sum of the fields for a struct, N times the element for `[N]T`, 0 for `()`. Its operand is a type, never a value: `sizeof(x)` of a variable is a syntax error, so the size of what a variable holds is the size of its type. It is a `u32` constant, which widens as a `u32` does (to a `u64`, not to an `i32` or a `u8`: `cannot assign u32 to u8`), and the compiler knows it wherever a constant is wanted: a length (`[sizeof(Pt) * 4]u8`), a range (`u32#(sizeof(Pt))`), a `def`, a global's initializer, a value in `data`. A type with no size is an error: a host reference, which is never in memory (`cannot take the size of Canvas: a host reference has no bytes, so it is never in memory ...`), and a type whose length is only known at run time, `[!]u8` (`sizeof: cannot compute size of dynamically sized type`).

`sizeof data`, written without parentheses (`sizeof(data)` is a syntax error), is the address just past the last byte of the program's data: where memory that nothing is laid out in begins ([9.0](#90-data-layout)). It is a `u32`, the same in every module of a program, and known only once the whole program is laid out: it is read in a function, but it is no constant of the source, so it starts no global, `def` or `data` and is no length (`global initializer must be a compile-time constant`).

<!-- spec:begin compile -->

```ents
type Pt = (x: i32, y: i32)

def pt-size = sizeof(Pt)
data buf = mut [0:u8; sizeof(Pt) * 4]       // room for four
global top: u32 = 0

// n bytes of the memory past the data, nothing freed.
func bump(n: u32) -> u32 {
  let at = sizeof data + top
  top += n
  return at
}

test "sizes" {
  assert sizeof(u8) == 1
  assert sizeof(bool) == 1
  assert sizeof(u128) == 16
  assert sizeof(*u64) == 4
  assert sizeof([]u8) == 8
  assert sizeof((a: u8, b: u32)) == 5
  assert sizeof([3]u16) == 6
  assert pt-size == 8
  assert buf.len == 32
  let wide: u64 = sizeof(Pt)                // a u32 widens
  assert wide == 8
}

test "sizeof data is where free memory starts" {
  let a = bump(16)
  assert a == buf as u32 + 32
  assert bump(4) == a + 16
}
```

```ents
type Canvas = host
data buf = mut [0:u8; 8]
global end: u32 = sizeof data

func a() -> u32 => sizeof(Canvas)
func b() -> u8 => sizeof(u64)
```

```errors
global initializer must be a compile-time constant
cannot take the size of Canvas: a host reference has no bytes, so it is never in memory
cannot assign u32 to u8
```

<!-- spec:end -->

---

## 11. WebAssembly Reference

A program compiles to one wasm module, and the language promises how: what each type is held as ([9.3](#93-wasm-type-mapping)), how it lies in memory ([9.6](#96-structs-and-slices-in-memory)), and the instructions of this chapter. Nothing runs that the source does not show, but for the few functions of [11.5](#115-functions-the-compiler-adds) and the null check of a plain host reference where it enters the module ([2.13](#213-host-references)).

The compiler targets WebAssembly 2.0 engines, and writes only what a program needs of them: multi-value results, mutable globals, bulk memory (`memory.copy`, `memory.fill`) where a range is filled or copied or `memcpy`, `memset` or `memzero` is called, and reference types (`externref`) where a program has a host type. So one with no host type uses no reference types, and one with neither a range fill or copy nor a memory builtin no bulk memory. It writes no sign-extension, saturating conversion or SIMD instruction: the conversions it writes are those of 11.1 and 11.2, and SIMD is a future addition ([13](#13-future-additions)). A host reference ([2.13](#213-host-references)) needs reference types, which every current browser, Node.js and Bun have. Nothing newer is written (typed function references, GC, tail calls): a plain host type is an `externref` checked at the boundary rather than a `(ref extern)`, until the baseline moves.

### 11.1 Widening Instructions (implicit)

| Conversion | Instruction |
|------------|-------------|
| an integer of up to 32 bits to a wider one of up to 32 bits | none |
| an integer of up to 32 bits to `i64` or `u64` | `i64.extend_i32_s` / `_u` |
| `i8`, `u8`, `i16`, `u16` → `f32` | `f32.convert_i32_s` / `_u` |
| an integer of up to 32 bits → `f64` | `f64.convert_i32_s` / `_u` |
| `f32` → `f64` | `f64.promote_f32` |
| an integer → a wide integer (`u128` ...) | the value in the lowest limb; the others 0 for an unsigned value, its sign for a signed one |

Every integer of up to 32 bits lives in a wasm `i32`, already zero- or sign-extended ([9.3](#93-wasm-type-mapping)), so widening among them emits nothing. `_s` or `_u` follows the signedness of the type widened: a `u32` becomes the `i64` of the same number.

### 11.2 Narrowing Instructions (explicit cast)

| Conversion | Instruction |
|------------|-------------|
| `i64`, `u64` → an integer of up to 32 bits | `i32.wrap_i64`, then as below for a narrower one |
| to `u8`, `u16` | `i32.and` with 255 or 65535 |
| to `i8`, `i16` | `i32.shl` by 24 or 16, then `i32.shr_s` back |
| between signed and unsigned of one width, `i32` ↔ `u32` | none: the same bits |
| `i32`, `u32` → `f32` | `f32.convert_i32_s` / `_u` |
| `i64`, `u64` → `f32` | `f32.convert_i64_s` / `_u` |
| `i64`, `u64` → `f64` | `f64.convert_i64_s` / `_u` |
| `f64` → `f32` | `f32.demote_f64` |
| `f32`, `f64` → `i32`, `u32` | `i32.trunc_f32_s` / `_u`, `i32.trunc_f64_s` / `_u` |
| `f32`, `f64` → `i64`, `u64` | `i64.trunc_f32_s` / `_u`, `i64.trunc_f64_s` / `_u` |
| `f32`, `f64` → a narrower integer | the 32-bit truncation, then the mask or the shifts |
| a wide integer → a narrower integer | its lowest limb, then as above |
| `bool` → an integer | none: it is 0 or 1 |
| a pointer → another pointer, `u32` or `i32` | none |

A float truncates toward zero, and the `trunc` instructions trap on NaN, an infinity or a value the 32- or 64-bit integer cannot hold ([9.7](#97-traps)). **Not implemented:** a cast between a float and a wide integer (`cannot cast i128 to f64: not supported yet`).

### 11.3 Control Flow Instructions

| Encantis | WASM |
|----------|------|
| `if`/`elif`/`else` | `if`/`else`, an `elif` as an `if` in the `else`; `(if (result T) ...)` where it gives a value |
| `match` | one comparison per arm in the order written, as nested `if`/`else`; with no `_` arm the last `else` is `unreachable` |
| `while c { ... }` | `(block $break (loop $continue (br_if $break (i32.eqz c)) ... (br $continue)))` |
| `loop { ... }` | `(block $break (loop $continue ... (br $continue)))` |
| `for` | a `block` and a `loop` that step a counter, or an address by the element's size; the body is a `block` of its own, which `continue` leaves to reach the step |
| `break`, `break when c` | `br $break`, `br_if $break c` |
| `continue`, `continue when c` | `br` and `br_if` to the loop's head, or in a `for` to its step |
| `return`, `return x when c` | `return`, `(if c (then x (return)))` |
| `a && b`, `a \|\| b` | `(if (result i32) a (then b) (else (i32.const 0)))`, `(if (result i32) a (then (i32.const 1)) (else b))` |
| `if let`, `??` | an `if` on the check: the index against the length, the pointer against 0 |
| `defer e` | `e` written out again at each way out of its block, after a `return`'s value is computed |
| `assert c` | `(if (i32.eqz c) (then (unreachable)))` |

A `match` is never a `br_table`: its arms are compared one after another. A function's code may end in an `unreachable` that never runs: every path through a function with results returns a value, as the checker requires.

### 11.4 Memory Access

A value in memory is read and written one wasm value at a time, at its offset ([9.6](#96-structs-and-slices-in-memory)):

| Type | Load | Store |
|------|------|-------|
| `i8` | `i32.load8_s` | `i32.store8` |
| `u8`, `bool` | `i32.load8_u` | `i32.store8` |
| `i16` | `i32.load16_s` | `i32.store16` |
| `u16` | `i32.load16_u` | `i32.store16` |
| `i32`, `u32`, a pointer | `i32.load` | `i32.store` |
| `i64`, `u64` | `i64.load` | `i64.store` |
| `f32`, `f64` | `f32.load`, `f64.load` | `f32.store`, `f64.store` |
| a wide integer | one `i64.load` per limb, from the lowest | one `i64.store` per limb |
| a slice, a struct, a fixed array | one access per part, each at its offset | the same |

A constant offset is the instruction's `offset=` immediate: `p.y` of a `*Point` with `type Point = (x: f32, y: f32)` is `(f32.load offset=4 p)`. An index computes the address as the start plus the index times the element's size. The alignment the instructions declare is the natural one, which is only a hint: data is not aligned ([9.0](#90-data-layout)), and an unaligned access gives the same result.

### 11.5 Functions the Compiler Adds

A few operations are calls of a function that the compiler adds to the module, once, where the program uses them:

- `$__mul_hi`, for `mul_hi` ([10.2](#102-integer-builtins));
- `$__w…`, one for each operation on a wide integer (`i128` to `u512`) that the program uses: arithmetic, bitwise operations, shifts and rotations, comparisons, negation, `min`, `max`, `abs`, sign extension, and the store of one into an array literal;
- `$__host_globals`, the module's start function, where it imports a global of a plain host type: it traps when the host gave null ([2.13](#213-host-references)).

`encantis test` compiles each `test` block as a function of its own, and imports `__assert_fail` from the module `test`: there a false `assert` calls it with the source position before it traps, so the runner can say where. A program built otherwise has neither.

---

## Tests

A `test` block is code that a module runs to check itself. It stands in the module beside the code it tests, and it is compiled only when tests are run: `encantis test` builds the module with its tests, while `encantis compile`, `wasm` and `run` leave the tests out, with everything declared inside them. `encantis check` checks them as part of the module.

### Writing a Test

`test` is followed by the test's name, a string, and a block. The block holds statements, as a function body does, and `assert` states what must hold:

<!-- spec:begin compile -->

```ents
export func area(w: u32, h: u32) -> u32 => w * h

test "the area of a square" {
  let side: u32 = 3
  assert area(side, side) == 9
  assert area(side, 0) == 0
}
```

<!-- spec:end -->

A test is declared at module level or inside another test. Its statements are the body of a function with no parameters and no result: a `let` in it is a variable of that test, and `return` ends the test, which then passes. A test calls any function of the module, exported or not, and reads and writes the module's globals and memory.

`test` and `assert` are not reserved words: they can name a variable or a function.

### `assert`

`assert condition` is a statement. The condition is a `bool` (`condition must be bool, not u32`). When it is false the program traps: `assert c` compiles to `(if (i32.eqz c) (then (unreachable)))`.

An `assert` is not only for tests. In a function it is a run-time check that stays in the compiled program, and a false condition stops the program with a trap, as the library's allocator does when it runs out of room ([The Library](#the-library)):

<!-- spec:begin compile -->

```ents
// Half of an even number; an odd one is a mistake of the caller's
export func half(n: u32) -> u32 {
  assert n % 2 == 0
  return n / 2
}

test "half of an even number" {
  assert half(10) == 5
}
```

<!-- spec:end -->

`half(3)` traps. A trap ends the whole call: deferred expressions ([Defer](#defer)) do not run. A false `assert` written in a test's own statements also tells `encantis test` its line, before it traps ([Running Tests](#running-tests)).

### Groups

A test that holds other tests is a group. Its nested tests are run, each reported by its name after the group's: `rectangles > one row`. What a group declares is seen by every test inside it, so a group gathers what its tests share. The tests of a file run in the order they are written, on one instance of the module, so what one test leaves in a global or in memory is there for the next:

<!-- spec:begin compile -->

```ents
global calls: u32 = 0

export func area(w: u32, h: u32) -> u32 {
  calls += 1
  return w * h
}

test "a square" {
  assert area(3, 3) == 9
}

test "rectangles" {
  def wide = 10
  func strip(h: u32) -> u32 => area(wide, h)

  test "one row" {
    assert strip(1) == wide
  }
  test "no rows" {
    assert strip(0) == 0
  }
}

test "the tests share one instance of the module" {
  assert calls == 3
}
```

<!-- spec:end -->

A group holds declarations and tests. Statements written in a group, beside its tests, are checked but never run, and neither is a test without a name, `test { ... }`: both parse, and the compiler should run them or refuse them (an open compiler bug). Give every test a name, and put statements only in a test that holds no tests.

### Declarations in a Test

A test can declare `def`, `data`, functions and imports, and these are the test's own: they are seen inside the test and the tests nested in it, and module code cannot use them.

- A `def` or a `data` block declared in a test replaces a module name of the same name inside that test only. The rest of the module reads the name as if the test were not there.
- A function declared in a test is called by its name in the test, and there it replaces a module function of that name. The compiler also gives it to the tests that come after it in the file (a compiler bug), so give a test's function a name the module does not use.
- An import declared in a test is part of the test build only: a host function or a source file ([7.1](#71-imports)) that only tests use is no part of the compiled program, nor of a program that imports the module. As for functions, the compiler gives it to the later tests too.

A test cannot declare a `global`, a `type`, a `memory` or an `export` (a syntax error), a generic function or a generic type ([8. Generics](#8-generics)). A function or an import declared in a test cannot take the name of a global, `def`, `data` block or import of the module, nor a name that several functions of the module share ([Functions That Share a Name](#functions-that-share-a-name)):

<!-- spec:begin compile -->

```ents
def size = 4
func hash(k: u32) -> u32 => k
func hash(k: u64) -> u32 => 1

test "what a test cannot declare" {
  func size() -> u32 => 4
  func hash(k: u32) -> u32 => 0
  func pick(comptime T: type, a: T) -> T => a
  func Box(comptime T: type) -> type => (v: T)
  assert size == 4
}
```

```errors
'size' is already declared
'hash' is the name of several functions of the module: a function declared in a test cannot take it over
a generic function is declared at module level, not inside a test
a generic type is declared at module level, not inside a test
```

<!-- spec:end -->

### Running Tests

`encantis test file.ents` checks the module with its tests, compiles it, starts one instance of it and runs its tests in the order they are written. Given a directory, it does this for every `.ents` file under it. Only the tests of the files named are run, not those of the modules they import.

A test passes when its statements run to their end (or to a `return`). It fails when an `assert` in it is false or when anything it calls traps: a false `assert` in a function, an import the test host does not provide (below), a division by zero, an access past the end of memory. Each test is reported on a line of its own, a failing `assert` of the test's own statements with its file, line and source, and a summary follows. Were the last `assert` of `no rows` above `assert strip(0) == 1`, in a file `area.ents`, `encantis test area.ents` would print:

```text
  pass: a square
  pass: rectangles > one row
  FAIL: rectangles > no rows
         area.ents:20: assert strip(0) == 1
  pass: the tests share one instance of the module

3 passed, 1 failed
```

The exit status is 1 when a test fails and 0 otherwise. A file that does not check prints its errors and counts as one failure. A module that does not start (its start function traps, or its data does not fit its memory) fails each of its tests with `the module did not start: ...`. `--json` adds a last line with the counts and, for each test, its file, its name, whether it passed and the error it failed with. A file with no tests is skipped, and when no file has any the command says `No tests found`.

### The Test Host

Tests run without the program's host. `encantis test` gives each import of the module a stand-in:

- WASI (`wasi_snapshot_preview1`): `fd_write` to file descriptor 1 or 2 writes to the standard output or error of `encantis test`, and `fd_read` from 0 reads nothing (the end of input). `proc_exit` fails the test, and every other WASI function returns 52 (`ENOSYS`). As under any WASI host, the module has to export its memory (`export memory`, [7.2](#72-exports)), or a WASI call fails the test.
- Any other imported function throws when it is called, which fails the test that called it. The functions that do not reach it are tested as usual.
- An imported global is the zero of its type: 0 for a number, none for an optional host reference. One of a plain host type, which is never null, is a stand-in object ([2.13](#213-host-references)).

In the test build each test is a function exported as `test_` followed by its name, the names of a group and its tests joined by `__`, and each character that is not a letter, a digit or `_` replaced by `_`. Two tests whose names are the same, or become the same this way, make a module that does not assemble (a compiler bug): give each test a name of its own.

A test that holds no statements, `test "todo" {}`, fails (`fn is not a function`), and a test that fails by a trap is reported as `FAIL:` with no reason, which only `--json` gives: both are compiler bugs.

---

## The Library

The directory `lib/` holds modules written in Encantis for what most programs need: text input and output over WASI, parsing bytes, a bump allocator, and containers. They are source files: a program imports from them by relative path, restating each signature it uses ([7.1](#71-imports)), or copies a file next to its own. [`lib/README.md`](../lib/README.md) and the comments of each file give more detail.

### Importing a Library Module

A program in a directory beside `lib/`, which reads numbers one to a line and gives their median:

<!-- spec:begin compile -->

```ents
import "../lib/stack" (
  "mark" func mark() -> u32
  "reset" func reset(m: u32)
)
import "../lib/vec" (
  "Vec" func Vec(comptime T: type) -> type
  "vec" func vec(comptime T: type, cap: u32) -> *mut Vec(T)
  "push" func push(comptime T: type, v: *mut Vec(T), x: T)
  "items_mut" func items_mut(comptime T: type, v: *mut Vec(T)) -> []mut T
)
import "../lib/sort" "sort" func sort(comptime T: type, xs: []mut T, comptime before: (T, T) -> bool)
import "../lib/text" (
  "next_line" func next_line(s: []u8) -> (line: []u8, rest: []u8)
  "parse_u64" func parse_u64(s: []u8) -> (value: u64, rest: []u8, ok: bool)
)

func ascending(a: u64, b: u64) -> bool => a < b

// The median of the numbers in text, one to a line; a line without one is skipped
export func median(text: []u8) -> u64 {
  let scope = mark()
  defer reset(scope)
  let xs = vec(u64, 16)
  let rest = text
  while rest.len > 0 {
    let (line:, rest: after) = next_line(rest)
    let (value:, ok:) = parse_u64(line)
    if ok { xs.push(value) }
    rest = after
  }
  let sorted = xs.items_mut()
  sorted.sort(ascending)
  return sorted[sorted.len / 2] ?? 0
}

test "the median of three numbers" {
  assert median("40\n7\nnone\n12\n") == 12
  assert median("") == 0
}
```

<!-- spec:end -->

Each import names the module by its path from the importing file, without `.ents`, and lists what it uses: the name the module exports, in quotes, then the declaration. A generic function is imported with its comptime parameters, and a generic type as the function it is (`func Vec(comptime T: type) -> type`, [8.8](#88-generics-across-modules)). Each of the library's generics is compiled once for each type it is used with: `vec(u64, 16)` and `xs.push(value)` are a `vec` and a `push` for `u64`, and `sorted.sort(ascending)` a `sort` that calls `ascending` directly. `let scope = mark()` and `defer reset(scope)` free what the function allocates on the stack, on every way out of it.

What a program gets of a library module: a generic is in the program only for the types it is used with, so a container costs what the same code written for one type would. The ordinary functions and the data of an imported module are in the program whether it uses them or not, as for any module: `stack.ents` brings its 256 KiB stack (zeros, which take no bytes in the `.wasm` file, [Data](#data--data-section-embedding)) and five functions, which `vec.ents`, `set.ents`, `map.ents` and `sort.ents` all import; `set.ents` brings its twelve `hash` and `eq` functions, and `map.ents` those too. `fixedvec.ents`, `ring.ents` and `bits.ents` hold generics only and import nothing. A module's tests are never part of a program that imports it.

### `io`: Input and Output over WASI

For programs that a WASI host runs, such as `encantis run`. The program exports its memory (`export memory`), which WASI reads and writes. Nothing allocates: input goes into a buffer the program gives, and output is written from the slices given.

| Function | What it does |
|---|---|
| `read_all(buf: []mut u8) -> []u8` | Reads standard input into `buf`, until its end or until `buf` is full, and returns the part filled |
| `print(s: []u8)` | Writes `s` to standard output |
| `println(s: []u8)` | Writes `s` and a newline |
| `print_u64(n: u64)`, `print_i64(n: i64)` | Writes `n` in decimal (with `-` when negative) and a newline |

<!-- spec:begin compile -->

```ents
import "../lib/io" (
  "read_all" func read_all(buf: []mut u8) -> []u8
  "print_u64" func print_u64(n: u64)
)
import "../lib/text" (
  "next_line" func next_line(s: []u8) -> (line: []u8, rest: []u8)
  "parse_u64" func parse_u64(s: []u8) -> (value: u64, rest: []u8, ok: bool)
)

export memory

data input = mut [0:u8; 65536]

// The sum of the numbers in text, one to a line
func total(text: []u8) -> (sum: u64) {
  let rest = text
  while rest.len > 0 {
    let (line:, rest: after) = next_line(rest)
    let (value:) = parse_u64(line)
    sum += value
    rest = after
  }
}

// Prints the sum of the numbers on standard input
export "_start" func main() {
  print_u64(total(read_all(input)))
}

test "a total of three lines" {
  assert total("12\n30\n\n") == 42
}
```

<!-- spec:end -->

`printf '1\n2\n39\n' | encantis run sum.ents` prints `42`.

### `text`: Parsing Bytes

Results are slices of the input; nothing is copied.

| Function | What it does |
|---|---|
| `eq(a: []u8, b: []u8) -> bool` | Whether `a` and `b` hold the same bytes |
| `starts_with(s: []u8, prefix: []u8) -> bool` | Whether `s` begins with `prefix` |
| `index_of(s: []u8, c: u8) -> u32` | The index of the first `c` in `s`, or `s.len` when there is none |
| `split_once(s: []u8, c: u8) -> (head: []u8, rest: []u8)` | The part before the first `c`, and the part after it (empty when there is no `c`) |
| `next_line(s: []u8) -> (line: []u8, rest: []u8)` | The first line, without its `\n`, and what follows it; a last line with no `\n` is a line |
| `skip_spaces(s: []u8) -> []u8` | `s` without its leading spaces |
| `parse_u64(s: []u8) -> (value: u64, rest: []u8, ok: bool)` | The decimal number at the start of `s`, after any spaces; what follows it; whether there were digits (`value` is 0 when there were none) |
| `parse_i64(s: []u8) -> (value: i64, rest: []u8, ok: bool)` | The same, with an optional `-` or `+` |

### `stack`: A Bump Allocator

A stack of 256 KiB in the module's memory. Allocating moves its top up; nothing is freed one allocation at a time. A scope takes a mark and resets to it, and `defer` ties the reset to every way out of the scope: `let scope = mark()`, then `defer reset(scope)`. Scopes nest. A result that must outlive a scope is allocated before the scope starts.

| Function | What it does |
|---|---|
| `mark() -> u32` | The top of the stack, as an address |
| `reset(m: u32)` | Frees everything allocated since the mark `m` was taken |
| `alloc(n: u32) -> u32` | The address of `n` bytes, aligned to 8. Traps when the stack is full |
| `zeroed(n: u32) -> u32` | The same, the bytes set to zero |
| `extend(n: u32) -> u32` | `n` more bytes right after the top, not aligned: grows the topmost allocation in place |

An address is cast to the pointer it is used as: `alloc(sizeof(Pt) * 4) as [*]mut Pt`. A program that needs a larger stack copies the file and makes its `capacity` and `space` larger.

### `vec`: A Growable Array

`Vec(T)` is `(ptr: [*]mut T, len: u32, cap: u32)`, on the stack of `stack.ents`. It is used through the `*mut Vec(T)` that `vec` returns, and its functions are called as methods ([4.9](#49-method-call-syntax)): `v.push(x)`, `v.len`.

| Function | What it does |
|---|---|
| `vec(comptime T: type, cap: u32) -> *mut Vec(T)` | An empty Vec with room for `cap` elements (at least one) |
| `push(comptime T: type, v: *mut Vec(T), x: T)` | Adds `x` at the end. When it is full, one at the top of the stack grows in place; any other is copied to storage twice its size |
| `pop(comptime T: type, v: *mut Vec(T)) -> T` | Takes the last element off. Traps when there is none |
| `last(comptime T: type, v: *Vec(T)) -> T` | The last element. Traps when there is none |
| `items(comptime T: type, v: *Vec(T)) -> []T` | The elements, valid until the next push |
| `items_mut(comptime T: type, v: *mut Vec(T)) -> []mut T` | The same, to change in place |
| `clear(comptime T: type, v: *mut Vec(T))` | Empties it and keeps its storage |

An element type that is a fixed array makes the Vec a table of row pointers ([Nesting](#nesting)): a `Vec([3]i32)` cannot push a `[3]i32`. A struct with an array field lies in place, so `Vec((cells: [3]i32))` holds packed rows.

### `fixedvec`, `ring`, `bits` and `fixedalloc`: Fixed Capacity

Containers whose capacity is part of their type, a comptime value parameter ([8.7](#87-comptime-value-parameters)). Every index into them is proven by the capacity, so each load and store is a plain one, with no check. They are laid out where the program likes: in `data`, or on the stack with `fixedalloc.ents`.

| Function | What it does |
|---|---|
| `FixedVec(comptime n: u32, comptime T: type) -> type` | `(len: u32#(n + 1), buf: *mut [n]T)`: at most `n` elements, never grown or copied |
| `v.push(x) -> bool` | Adds `x` at the end; false, with nothing changed, when it is full |
| `v.pop() -> T`, `v.last() -> T` | The last element, taken off or not. Traps when there is none |
| `v.items() -> []T`, `v.items_mut() -> []mut T`, `v.clear()`, `v.full() -> bool` | As for a Vec; whether it is full |
| `Ring(comptime n: u32#2147483649, comptime T: type) -> type` | `(head: u32#n, count: u32, items: *mut [n]T)`: the last `n` elements of a stream |
| `r.push(x)` | Adds `x` after the newest; when the ring is full, in the oldest one's place |
| `r.oldest(i: u32#n) -> T`, `r.newest() -> T`, `r.count`, `r.clear()` | The `i`-th oldest; the newest (traps when there is none); how many it holds; empties it |
| `b.set_bit(i)`, `b.clear_bit(i)`, `b.has_bit(i) -> bool`, `b.count_bits() -> u32` | A bitset over a `*mut [w]u32` (`*[w]u32` to read), such as `data seen = mut [0:u32; 4]`: bit `i` is a `u32#(w * 32)` |
| `fixedvec(comptime n: u32, comptime T: type) -> *mut FixedVec(n, T)`, `ring(comptime n: u32, comptime T: type) -> *mut Ring(n, T)` | In `fixedalloc.ents`: an empty one, its header and its `n` elements in one allocation on the stack |

The functions of the first two take `comptime n: u32, comptime T: type` before the container, and those of `bits.ents` take `comptime w: u32`. `FixedVec` and `Ring` can also be laid out in `data`: `data cells = mut [0:u32; 8]` and `data v: FixedVec(8, u32) = mut (0, cells)`. `fixedvec.ents` and `vec.ents` both name their functions `push`, `pop` and so on, and a generic function's name is unique in its module ([8.1](#81-compile-time-parameters)), so a program that uses both renames one on import: `"push" func fixed_push(comptime n: u32, comptime T: type, v: *mut FixedVec(n, T), x: T) -> bool`, called as `v.fixed_push(x)`.

### `set` and `map`: Hashing

`Set(K)` and `Map(K, V)` hash with open addressing and double their table when it is half full, on the stack of `stack.ents`.

| Function | What it does |
|---|---|
| `hashset(comptime K: type, bits: u32) -> *mut Set(K)` | An empty set of `2^bits` slots to start with |
| `s.add(k) -> bool` | Adds `k`; true where it was not in the set |
| `s.has(k) -> bool`, `s.count` | Whether `k` is in the set; how many keys it holds |
| `map(comptime K: type, comptime V: type, bits: u32) -> *mut Map(K, V)` | An empty map |
| `m.insert(k, v) -> bool` | Sets `k`'s value; true where `k` is new |
| `m.lookup(k) -> ?*mut V` | A pointer to `k`'s value, to change in place, or none; valid until the next insert |
| `m.get_or(k, fallback) -> V` | `k`'s value, or `fallback` where it has none |

A set or a map calls `hash(k) -> u32` and `eq(a, b) -> bool` for its key type. `set.ents` has them for `u32`, `u64`, `i32`, `i64`, `[]u8` and `[]u32`. A key is copied into the set by value: a slice key is the slice, not its bytes, which must stay where they are while the set is used. For a key type of its own, a program writes `hash` and `eq` in the module that makes the set, and the set's generic code calls them ([8.8](#88-generics-across-modules)):

<!-- spec:begin compile -->

```ents
type Cell = (x: i32, y: i32)

func hash(c: Cell) -> u32 => ((c.x * 73856093) ^ (c.y * 19349663)) as u32
func eq(a: Cell, b: Cell) -> bool => a.x == b.x && a.y == b.y

test "equal cells hash alike" {
  assert eq(Cell(2, 3), Cell(2, 3))
  assert hash(Cell(2, 3)) == hash(Cell(2, 3))
}
```

<!-- spec:end -->

A narrower integer key (`u8`, `u16`, `i8`, `i16`) fits several of `set.ents`' own functions, which makes the call ambiguous, and the library's functions come before a program's: keep such keys widened, in a `Set(u32)` or a `Set(i32)`.

### `sort`: Sorting

| Function | What it does |
|---|---|
| `sort(comptime T: type, xs: []mut T, comptime before: (T, T) -> bool)` | Sorts `xs` in place, stably: `before(a, b)` says that `a` comes first. Its scratch space is on the stack, freed before it returns |
| `is_sorted(comptime T: type, xs: []T, comptime before: (T, T) -> bool) -> bool` | Whether `xs` is sorted |
| `lower_bound(comptime T: type, xs: []T, x: T, comptime before: (T, T) -> bool) -> u32` | Where `x` goes in sorted `xs`: the first index whose element does not come before `x` |

`before` is a comptime function parameter ([8.6](#86-comptime-function-parameters)): the name of a function declared at module level, in any module. Each comparator is its own copy of `sort`, which calls it directly.

Complete programs that use the library are [`examples/aoc/day1.ents`](../examples/aoc/day1.ents), a WASI program for `encantis run`, and [`examples/containers/main.ents`](../examples/containers/main.ents), which uses every container with a key type of its own.

---

## 12. Examples

Small programs that use the features of the earlier chapters together. Each one compiles, and its `test` blocks show what it computes.

### Hello, World

A program for a WASI host, run with `encantis run hello.ents`:

<!-- spec:begin compile -->

```ents
import "wasi_snapshot_preview1" "fd_write"
  func fd_write(fd: i32, iovs: [][]u8, written: *mut u32) -> i32

export memory

def stdout = 1

func greet(name: []u8) {
  fd_write(stdout, `Hello, ${name}!\n`, &0:u32)
}

export "_start" func main() {
  greet("World")
}
```

<!-- spec:end -->

WASI's `fd_write` takes a list of byte ranges, each an address and a length in memory, which is how a `[][]u8` is laid out; the template literal is such a list, `"Hello, "`, `name` and `"!\n"` ([Template Literals](#template-literals)). `&0:u32` is a cell of memory for the count `fd_write` writes back, and its result, an error code, is dropped. WASI reads the module's memory, so the program exports it. `_start` is the function a WASI host runs.

For a JavaScript host the program imports a function of its own and exports what the host calls:

<!-- spec:begin compile -->

```ents
import "env" "log" func log(msg: []u8)

export memory

export func main() {
  log("Hello, World!\n")
}
```

<!-- spec:end -->

The slice reaches the host as two numbers, the address and the length of the bytes, which the host reads from the exported memory:

```text
const { instance } = await WebAssembly.instantiateStreaming(fetch("hello.wasm"), {
  env: {
    log: (ptr, len) => console.log(new TextDecoder().decode(
      new Uint8Array(instance.exports.memory.buffer, ptr, len))),
  },
})
instance.exports.main()
```

### Fibonacci

<!-- spec:begin compile -->

```ents
// Recursive, with an expression body
export func fib(n: u32) -> u32 => if n < 2 { n } else { fib(n - 1) + fib(n - 2) }

// Iterative: the pair (a, b) steps along the sequence, both at once
export func fib_fast(n: u32) -> (a: u64) {
  let b: u64 = 1
  for i in n {
    set (a, b) = (b, a + b)
  }
}

test "the two agree" {
  assert fib(10) == 55
  assert fib_fast(10) == 55
  assert fib_fast(90) == 2880067194370816120
}
```

<!-- spec:end -->

`fib_fast` returns its named result `a`, which starts at zero. `set (a, b) = (b, a + b)` reads the whole tuple before it assigns either variable ([4.5](#45-assignment-and-compound-assignment)).

### Sum of a Slice

<!-- spec:begin compile -->

```ents
export func sum(xs: []i32) -> (total: i32) {
  for x in xs {
    total += x
  }
}

test "sum" {
  assert sum([1, 2, 3]) == 6
  assert sum([]) == 0
}
```

<!-- spec:end -->

A loop over a slice reads each element once and needs no bounds check ([5.2](#52-loops)). An array literal given for a slice is laid out in memory ([Array Literals](#array-literals)).

### Hex Digits

<!-- spec:begin compile -->

```ents
data digits = "0123456789abcdef"

// The 4 bytes of a word as 8 hex digits
export func to_hex(bytes: *[4]u8, out: *mut [8]u8) {
  for i in bytes.len {
    let b = bytes[i]
    out[i * 2] = digits[b >> 4]
    out[i * 2 + 1] = digits[b & 15]
  }
}

data word = [0xde:u8, 0xad, 0xbe, 0xef]
data text = mut [0:u8; 8]

test "to_hex" {
  to_hex(word, text)
  assert text[0] == 'd'
  assert text[7] == 'f'
}
```

<!-- spec:end -->

Every index here is proven in range when the program is compiled, so each one is a plain load or store with no check ([Ranged Integers](#ranged-integers)): `i` counts to the constant `bytes.len` and is a `u32#4`, so `i * 2 + 1` is below 8, and a `u8` shifted right by 4, or masked with 15, is below 16.

### Looking Up a Record

<!-- spec:begin compile -->

```ents
type Planet = (name: []u8, moons: u32)

data planets: *[4]Planet = [("Mercury", 0), ("Venus", 0), ("Earth", 1), ("Mars", 2)]

func same(a: []u8, b: []u8) -> bool {
  return false when a.len != b.len
  for i, c in a {
    return false when c != (b[i] ?? 0)
  }
  return true
}

// The planet of that name, or none
func find(name: []u8) -> ?*Planet {
  for i in planets.len {
    let p = &planets[i]
    return p when same(p.name, name)
  }
  return 0
}

export func moons(name: []u8) -> u32 => if let p = find(name) { p.moons } else { 0 }

test "a planet is found by name" {
  assert moons("Mars") == 2
  assert moons("Pluto") == 0
  assert find("Venus") != 0
}
```

<!-- spec:end -->

`planets` is laid out in the data section: four structs, each a slice and a number. `&planets[i]` is the address of one, a `*Planet`, and `p.name` reads its field from memory. `find` returns an optional pointer, none (`0`) when no planet has the name, and `if let` gives the plain pointer where there is one ([Optional Types](#optional-types)). In `same`, `b[i]` is checked against `b.len` at run time, and `?? 0` gives the value to use when it is out of range ([4.7](#47-bounds-checked-indexing)).

### Month Names

<!-- spec:begin compile -->

```ents
data months: [][]u8 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

// Months count from 1; any other number has no name
export func month(m: u32) -> []u8 => months[m - 1] ?? "?"

test "month" {
  assert month(1).len == 3
  assert (month(12)[0] ?? 0) == 'D'
  assert (month(0)[0] ?? 0) == '?'
}
```

<!-- spec:end -->

`m - 1` wraps for `m == 0` to the largest `u32`, which is past the end of `months`, so `??` gives `"?"`.

### A Generic Function

<!-- spec:begin compile -->

```ents
// How many elements of xs `keep` says yes to
func count(comptime T: type, xs: []T, comptime keep: (T) -> bool) -> (n: u32) {
  for x in xs {
    if keep(x) { n += 1 }
  }
}

func passing(score: u32) -> bool => score >= 50
func negative(x: i64) -> bool => x < 0

test "one count for each element type and test" {
  let scores: []u32 = [72, 41, 50, 99]
  assert scores.count(passing) == 3
  assert count([-1:i64, 2, -3], negative) == 2
}
```

<!-- spec:end -->

`count` is compiled once for each element type and test function it is called with: `scores.count(passing)` is a `count` for `u32` that calls `passing` directly, with no function table ([8. Generics](#8-generics)). `T` is taken from the arguments, and the first argument can be written as the receiver of a method call ([4.9](#49-method-call-syntax)).

### Complete Programs

The directory `examples/` holds larger programs, each built and tested with the compiler:

- [`examples/aoc/day1.ents`](../examples/aoc/day1.ents): a WASI program that reads its input and prints an answer, with the library's `io` and `text` ([The Library](#the-library)); `encantis run examples/aoc/day1.ents < input.txt`.
- [`examples/containers/main.ents`](../examples/containers/main.ents): the library's Vec, Set, Map and sort used with a struct type of the program's own.
- [`examples/generics/`](../examples/generics): generic functions and types, method calls and comptime function and value parameters.
- [`examples/browser/lantern.ents`](../examples/browser/lantern.ents): a browser game that imports nothing. Each frame the page calls its exported `frame()`, and it leaves drawing and sound commands in its memory for the page to play.
- [`examples/types/host.ents`](../examples/types/host.ents): host references, the host's objects held by the module ([2.13](#213-host-references)).
- [`examples/crypto/`](../examples/crypto): hashes, a permutation, signatures and encodings (SHA-256, BLAKE2b, xxHash, Gimli, Ed25519, base64url and others), written with fixed arrays, wide integers and memory.

---

## 13. Future Additions

Features under consideration for later versions of Encantis. None of them is implemented: the syntax of each is a syntax error, and its examples are not working code. The features designed in the earlier chapters but not implemented (enums, function values, struct patterns and others) are described where they belong and listed in [Implementation Status](#implementation-status).

### SIMD Support

**Not implemented:** there is no `v128` type, and the compiler writes no SIMD instruction ([11](#11-webassembly-reference)).

Access to WebAssembly's 128-bit vector operations:

```ents
let a:v128 = v128_load(ptr)
let b:v128 = v128_load(ptr + 16)
let sum = i32x4_add(a, b)

// Potential syntax for vector literals
let mask:v128 = (0xff:u8, 0xff:u8, 0:u8, 0:u8, ...)
```

**Why:** WebAssembly has SIMD over `v128` values. Crypto, hashing, image processing and numerical code can run several times faster with it: xxHash and Gimli both have vectorized variants that outperform their scalar forms.

### Comptime Evaluation

**Not implemented:** `comptime func` is a syntax error.

Generic functions and generic types take types, functions and numbers at compile time ([8. Generics](#8-generics)). The same mechanism is meant to carry more:

```text
// Compile-time function execution
comptime func generate_table() -> *[256]u8 {
  let table:*[256]u8
  for i in 256 {
    table[i] = crc_byte(i)
  }
  return table
}

def crc_table = generate_table()
```

Compile-time control flow (a comptime `if` that picks a type or a branch, a generic type with a block body, recursion on a value parameter that ends) would follow it.

**Why:** Compile-time values remove the last reasons to duplicate a function. Compile-time execution computes lookup tables, buffer sizes and constants when the program is compiled, so they cost nothing when it runs, and complex initialization needs no start-up code.

### Module System

**Not implemented:** `module` and `use` are syntax errors.

Source modules ([7.1](#71-imports)) import the functions, globals and generics another file exports, each by its signature, and a type is declared again where it is used. A module system would import a module's names without restating them:

```ents
// In math/vector.ents
module math.vector

export type Vec3 = (x:f32, y:f32, z:f32)
export func dot(a:Vec3, b:Vec3) -> f32 => ...

// In main.ents
use math.vector (Vec3, dot)
// or
use math.vector as vec
```

**Why:** Larger projects split their code across files, and restating every signature at each import is what that costs without one.

### Operator Overloading via Method Calls

**Not implemented:** a function cannot be named by an operator.

Operators could stand for function calls, so that a type of the program's own supports the standard operators through ordinary function declarations:

```ents
type Vec2 = (x:f64, y:f64)

func +(a:Vec2, b:Vec2) -> Vec2 =>
  Vec2(a.x + b.x, a.y + b.y)

func *(v:Vec2, s:f64) -> Vec2 =>
  Vec2(v.x * s, v.y * s)

// would then be
let result = (a + b) * 2.0
```

Functions share a name when their parameter types differ ([Functions That Share a Name](#functions-that-share-a-name)), so one operator could have an implementation for each pair of types, and the compiler would pick one by the operand types as it does for any call.

**Why:** It unifies operators with method-call syntax ([4.9](#49-method-call-syntax)): no special mechanism is needed. Operators become functions that share a name, resolved by the rules calls already follow. This keeps the language simple while allowing expressive numeric and container types.

### Closures

**Not implemented:** there is no closure syntax, and function values, which closures would build on, are not implemented either ([Function Types and Pointers](#function-types-and-pointers)).

Functions that capture variables from their enclosing scope. A plain function value is designed as an index into the function table; a closure would carry state as well:

```ents
func make_counter(start: i32) -> () -> i32 {
  let count = start
  return || {
    count += 1
    return count
  }
}

func map(arr: []i32, f: i32 -> i32) -> []i32 {
  // With closures, f could capture external state
}

// Usage
let counter = make_counter(0)
counter()  // 1
counter()  // 2
```

**Implementation approach:**

- Non-capturing functions remain raw table indices (zero overhead)
- Capturing functions become "fat": a struct with function pointer + environment pointer
- Compiler automatically generates environment structs for captured variables
- Callee receives an implicit environment parameter

**Design questions:**

- Syntax: `|| expr`, `|x| expr`, or `func |x| expr`?
- Capture semantics: by-value (copy) or by-reference (requires lifetime tracking)?
- Should closure types be distinct from function types, or unified with automatic coercion?

**Why:** Closures allow functional patterns (map, filter and reduce with the logic written in place), callbacks with context, and remove the boilerplate of passing an environment by hand. Engines with WebAssembly's garbage collection could hold closure environments without manual memory allocation, though the compiler targets WebAssembly 2.0, which has none ([11](#11-webassembly-reference)).
