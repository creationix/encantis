# Encantis Grammar

This document gives the syntax of Encantis: every form the parser accepts, as a grammar rule with examples. The parser runs the Ohm grammar [`packages/compiler/encantis-grammar.ohm`](../packages/compiler/encantis-grammar.ohm), and the rules here are its rules, under the same names and with their alternatives in the same order. What each form means (its types, what is an error, what traps, what it compiles to) is in the language reference, [`docs/encantis.md`](encantis.md).

## Notation

- Rules have the Ohm grammar's names. A rule whose name starts with a capital is syntactic: whitespace and comments may stand between its parts. One whose name starts with a lower-case letter is lexical: it is written as one piece, with nothing between its parts.
- `"x"` is the text `x`. `a b` is `a` then `b`. `a | b` tries `a` first and `b` only where `a` does not match: alternatives are ordered, and the first that matches is taken. `a?` is optional, `a*` repeats zero or more times, `a+` one or more times, and `( )` groups.
- `~a` matches nothing and only where `a` does not follow; `&a` matches nothing and only where `a` follows.
- `ListOf<X, ",">` is zero or more `X` separated by commas, and `NonemptyListOf<X, ",">` one or more.
- A keyword in quotes, such as `"let"`, matches only as a whole word: the Ohm grammar has a rule for each (`let = "let" ~identChar`), so `letter` is a name and not `let` followed by `ter`. A few small lexical rules of the Ohm grammar (`binaryDigit`, `hexByte`, `UnsignedType`, ...) are written out in place here.
- `-- text` is a comment. An Ohm case name (`-- named`) is shown where it is the name a message uses.

---

## Lexical Structure

### Whitespace and Comments

```ebnf
space        = " " | "\t" | "\n" | "\r" | comment
comment      = lineComment | blockComment
lineComment  = "//" (~"\n" any)*
blockComment = "/*" (~"*/" any)* "*/"
```

```encantis
// A line comment

/*
 * A block comment
 */

func add(a: i32, b: i32) -> i32 {  // a comment at the end of a line
  return a + b
}
```

Block comments do not nest. A line break is whitespace like any other, and a statement ends only where what it holds can go no further: `f()` with `(x)` on the next line is the call `f()(x)`, and `let a = x` with `-1` on the next line is `let a = x - 1`. A type name followed by `(` is the exception: a generic type applied is written with no space before its parenthesis (below), so a type can end a line.

### Identifiers

```ebnf
ident      = ~keyword lowerStart identChar*
typeIdent  = upperStart identChar*
lowerStart = "a".."z"
upperStart = "A".."Z"
identChar  = letter | digit | "_" | "-"
```

An identifier (a function, a variable, a parameter, a field) starts with a lower-case letter; a type identifier starts with a capital. Both go on with letters, digits, `_` and `-`:

```encantis
count
user-name
my_value
prime32-1
Point
Vector3D
```

A hyphen is part of a name, so `n-1` is one identifier: a subtraction is written with spaces, `n - 1`. The letters are ASCII.

### Keywords

```ebnf
keyword = ( "if" | "elif" | "else" | "while" | "for" | "in" | "loop" | "match"
          | "break" | "continue" | "return" | "when" | "defer"
          | "func" | "let" | "set" | "global" | "data" | "def" | "type" | "enum"
          | "import" | "export" | "memory" | "inline" | "mut"
          | "as" | "true" | "false" | "int" | "float" | "sizeof" | "comptime" ) ~identChar
```

A keyword is not an identifier, though a longer name that starts with one is (`format`, `iffy`, `types`). `comptime` is a keyword: it marks the compile-time parameters of a generic function or a generic type and cannot name a function, a variable or a parameter. `test`, `assert` and `host` are not reserved: each is a keyword only where it starts a test, an `assert` statement or a host type declaration, and anywhere else it is a name.

### Number Literals

```ebnf
numberLiteral  = floatLiteral | intLiteral
intLiteral     = "-"? ( hexLiteral | binaryLiteral | octalLiteral | dozenalLiteral | decimalLiteral )
decimalLiteral = digit+
hexLiteral     = "0x" hexDigit+                 -- hexDigit: 0-9, a-f, A-F
binaryLiteral  = "0b" ("0" | "1")+
octalLiteral   = "0o" ("0".."7")+
dozenalLiteral = "0d" (digit | "a".."b" | "A".."B")+
floatLiteral   = "-"? digit+ "." digit+ exponent?
exponent       = ("e" | "E") ("+" | "-")? digit+
```

```encantis
42              // decimal
0xFF            // hexadecimal (255)
0b1010          // binary (10)
0o755           // octal (493)
0d10B           // dozenal, base 12: a or A is 10, b or B is 11 (155)
-123            // negative

3.14159
-2.5
1.0e10          // an exponent needs the digits and the point before it
6.022e23
-1.5e-10
```

A float has digits on both sides of its point: `1.` and `.5` are not numbers, and neither is `1e10`. A literal's type is written after it with a colon, `42:i64`, `2.5:f32` (`CastExpr`, below).

### String Literals

```ebnf
stringLiteral = utf8String | hexString | base64String
utf8String    = "\"" dqChar* "\""
hexString     = "x\"" (hexDigit hexDigit | space)* "\""
base64String  = "b\"" (base64Char | space)* "\""
base64Char    = letter | digit | "+" | "/" | "="
dqChar        = escapeSeq | ~("\"" | "\\") any
escapeSeq     = "\\" "x" hexDigit hexDigit       -- hex: the byte HH
              | "\\" "u" "{" hexDigit+ "}"       -- unicode: the UTF-8 bytes of codepoint H..
              | "\\" escapeChar                  -- simple
escapeChar    = "n" | "t" | "r" | "\\" | "\"" | "'"
```

A string is written in double quotes and is bytes in memory:

```encantis
"Hello, world!"
"escapes: \n \t \r \\ \" \'"
"\x48\x69"          // \xHH is the byte HH
"\u{e9}"            // \u{H..} is the UTF-8 bytes of that codepoint: two here
x"48 65 6C 6c 6F"   // hex bytes, either case; spaces between them are ignored
b"SGVs bG8="        // base64 bytes; spaces are ignored too
```

### Codepoint Literals

```ebnf
codepointLiteral = "'" sqChar* "'"
sqChar           = escapeSeq | ~("'" | "\\") any
```

Single quotes hold codepoints, not a string: each character or escape between them is one codepoint. One codepoint is the integer literal of its value; several are a tuple of them. The escapes are a string's, with `\xHH` the codepoint HH. `''` is an error, and so is a `\u{..}` that names no character (a surrogate, or past `10FFFF`).

```encantis
'a'             // 97
'é'             // 233
'\u{1F600}'     // 128512
'ok'            // the tuple (111, 107)
```

### Template Literals

```ebnf
TemplateLiteral = noSubTemplate                                          -- plain
                | templateHead Expr (templateMiddle Expr)* templateTail  -- interpolated
noSubTemplate   = "`" templateChar* "`"
templateHead    = "`" templateChar* "${"
templateMiddle  = "}" templateChar* "${"
templateTail    = "}" templateChar* "`"
templateChar    = "\\`" | "\\${" | escapeSeq | ~("`" | "${" | "}" | "\\") any
```

```encantis
`hello ${name}\n`
`${x} of ${total} done`
```

A template literal is a list of byte strings, a `[][]u8`: its text and the value of each `${...}` in order. `` \` `` and `\${` write a backtick and `${`. A `}` cannot be written in its text.

### Boolean Literals

```ebnf
boolLiteral = "true" | "false"
literal     = numberLiteral | stringLiteral | codepointLiteral | boolLiteral
```

---

## Modules and Declarations

```ebnf
Module      = Declaration*
Declaration = ImportDecl | ExportDecl | FuncDecl | TypeDecl | EnumDecl
            | DataDecl | DefDecl | GlobalDecl | MemoryDecl | TestDecl
```

A module, one source file, is a list of declarations in any order. Statements stand only in function bodies and tests.

### Imports

```ebnf
ImportDecl      = "import" stringLiteral "(" ImportGroupItem+ ")"   -- group
                | "import" stringLiteral ImportGroupItem            -- single
ImportGroupItem = stringLiteral ImportItem
ImportItem      = "func" typeIdent ParamList "->" "type"            -- typeFunc: a generic type
                | "func" ident? FuncSignature                       -- func
                | "global" ident TypeAnnotation                     -- global
```

The first string names the module: a host module (`"env"`, `"wasi_snapshot_preview1"`), or another source file when it starts with `./`, `../` or `/`. The second names what is imported, and the declaration after it gives the name it is known by here and its signature:

```encantis
import "env" "log" func log(msg: []u8)

import "wasi_snapshot_preview1" (
  "fd_write" func fd_write(fd: i32, iovs: [][]u8, nwritten: *mut u32) -> i32
  "fd_read" func fd_read(fd: i32, iovs: [][]mut u8, nread: *mut u32) -> i32
)

import "env" "memory_offset" global offset: i32
```

**Generics from another source module:** a generic function is imported with its signature, comptime parameters included. A generic type is imported as the function it is, with no body: `func`, its upper-case name, its parameter list and `-> type`. This is the only import item whose name is upper-case.

```encantis
import "./containers" (
  "Vec" func Vec(comptime T: type) -> type
  "vec" func vec(comptime T: type, cap: u32) -> *mut Vec(T)
  "push" func push(comptime T: type, v: *mut Vec(T), x: T)
)
```

An imported function may be written without a name, but then nothing can call it.

### Exports

```ebnf
ExportDecl = "export" stringLiteral Exportable   -- named
           | "export" Exportable                 -- unnamed
Exportable = FuncDecl | GlobalDecl | MemoryDecl
```

```encantis
export func add(a: i32, b: i32) -> i32 => a + b    // exported as "add"
export "_start" func main() { }                    // exported as "_start"
export global counter: i32 = 0
export memory                                      // exported as "memory"
export memory 8
export "mem" memory 8 256
```

An export without a string takes the declaration's name. A function without a name can only be exported with one, `export "hash" func (data: []u8) -> u32 { ... }` (the reference, 7.2, says what the compiler does with it).

### Functions

```ebnf
FuncDecl      = "func" typeIdent ParamList "->" "type" "=>" Type   -- typeFunc: a generic type
              | "inline"? "func" ident? FuncSignature Body        -- func
FuncSignature = ParamList ("->" Type)?                             -- params
              | BaseType ("->" Type)?                              -- plain: an unnamed input
ParamList     = "(" ListOf<Param, ","> ")"
Param         = "comptime" typeIdent ":" "type"     -- comptimeType: a type parameter
              | "comptime" ident ":" "type"         -- comptimeTypeLower: a near miss
              | "comptime" ident TypeAnnotation     -- comptimeValue: a function or value parameter
              | "comptime" typeIdent TypeAnnotation -- comptimeValueUpper: a near miss
              | typeIdent ":" "type"                -- typeNoComptime: a near miss
              | Field                               -- plain
FieldList     = NonemptyListOf<Field, ",">
Field         = ident TypeAnnotation                -- named
              | Type                                -- anonymous
TypeAnnotation = ":" Type
Body          = Block                               -- block
              | "=>" Expr                           -- arrow
Block         = "{" Statement* "}"
```

```encantis
func add(a: i32, b: i32) -> i32 {
  return a + b
}

func double(x: i32) -> i32 => x * 2               // an arrow body is the result

func divmod(a: i32, b: i32) -> (quotient: i32, remainder: i32) {
  quotient = a / b                                // named results, returned at the end
  remainder = a % b
}

func get_pi() -> f64 => 3.14159
func reset() { }                                  // no result

func negate i32 -> i32 => 0                       // the plain form: an unnamed input
inline func square(x: f32) -> f32 => x * x        // inline is accepted and has no effect
```

There is no lambda: a function is declared at module level, in a test, or as a statement in a body (a nested function, reference 3.4). The result after `->` is a type; `-> (q: i32, r: i32)` lists two named results.

**Compile-time parameters** (generic functions):

```encantis
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }
func at(xs: []T, comptime T: type, i: u32) -> T => xs.ptr[i]
func sum(comptime n: u32, xs: *[n]u32) -> (s: u32) {
  for x in xs { s += x }
}
func sort(comptime T: type, xs: []mut T, comptime before: (T, T) -> bool) { }
```

A `comptime` parameter of a function type is given the name of a function, and one of an integer type (`comptime n: u32`) a number. The checker tells them apart by the type; a parameter of any other type is an error.

`comptime` can only be written in the parameter list of a declaration or of an import item. A struct type, a result, an enum payload and a function type are lists of fields, not of parameters, so `type P = (comptime T: type)` and `-> (comptime T: type)` are syntax errors, and `type` is not a type anywhere else (`let t: type` is a syntax error too).

Three near misses, `comptime t: type` (a lower-case type parameter), `T: type` (no `comptime`) and `comptime N: u32` (an upper-case value parameter, with `[N]T` where it is used), are parsed so that the compiler can say what to write instead.

**Generic types** (a function from types to a type):

```encantis
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
func Pair(comptime A: type, comptime B: type) -> type => (first: A, second: B)
func Ring(comptime n: u32, comptime T: type) -> type => (head: u32#n, items: *mut [n]T)
```

The name is upper-case, the result is the keyword `type`, and the body is one type after `=>`: there is no block body. Its parameters are type parameters and value parameters. It may be exported like a function. Only a generic type has a result of `type`; `func vec(...) -> type` with a lower-case name is a syntax error.

### Type Declarations

```ebnf
TypeDecl = "type" typeIdent "=" Type
```

```encantis
type Point = (x: f64, y: f64)        // a struct
type Pair = (i32, i32)               // a tuple
type BinaryOp = (i32, i32) -> i32    // a function type
type BytePtr = *u8                   // a pointer
type Buffer = [1024]u8               // a fixed array
type Canvas = host                   // a host reference type
```

A type's name is upper-case. `host` is a type only as the whole right side of a type declaration: it declares a host reference type, a type of its own that the module cannot look into (reference 2.13). `?Canvas` is its optional form, which may be none (written `0`); a plain `Canvas` never is.

### Enum Declarations

```ebnf
EnumDecl    = "enum" typeIdent "{" EnumVariant* "}"
EnumVariant = typeIdent ("(" FieldList ")")? ","?
```

```encantis
enum Shape {
  Empty,
  Circle(r: f64),
  Rect(w: f64, h: f64)
}
```

**Not implemented:** an enum declaration parses and is ignored, and naming its type is an error (reference 2.9).

### Definitions

```ebnf
DefDecl = "def" ident ":" Type "=" Expr   -- typed
        | "def" ident "=" Expr            -- bare
```

```encantis
def pi = 3.14159:f64
def max-size: u32 = 1024
def enabled = true
def next = 'a' + 1
```

A `def` names a compile-time value, a number or a bool, written in place wherever the name is used. A string or an array is not one: `data` lays those out in memory.

### Data

```ebnf
DataDecl = "data" ident ":" Type "=" Expr   -- typed
         | "data" ident "=" Expr            -- bare
```

```encantis
data greeting = "Hello, world!"           // *[13]u8
data table = [1:u64, 2, 3, 4]             // *[4]u64
data buf = mut [0:u8; 1024]               // *mut [1024]u8
data names: [][]u8 = ["Ada", "Grace"]     // a slice of slices
```

### Globals

```ebnf
GlobalDecl      = "global" PatternWithType ("=" Expr)?
PatternWithType = Pattern TypeAnnotation?
```

```encantis
global counter: i32                 // zero until it is set
global limit: u32 = 100
global origin = 0:u32               // the type from the value
global name: []u8 = "default"
```

A global holds one variable. The grammar takes a pattern, `global (a, b) = (1, 2)`, which the compiler refuses (`global destructuring is not supported yet`).

### Memory

```ebnf
MemoryDecl = "memory" intLiteral intLiteral?   -- sized
           | "memory"                          -- bare
```

```encantis
memory          // the compiler sizes it from the program's data, with no maximum
memory 8        // at least 8 pages of 64 KiB
memory 8 256    // at least 8 pages, at most 256
```

### Tests

```ebnf
TestDecl  = "test" stringLiteral TestBlock   -- named
          | "test" TestBlock                 -- anonymous
TestBlock = "{" TestItem* "}"
TestItem  = TestDecl | ImportDecl | DataDecl | DefDecl | FuncDecl | Statement
```

```encantis
test "parsing" {
  def limit = 10
  func twice(x: u32) -> u32 => x * 2

  test "small numbers" {
    assert twice(3) == 6
  }
  test "the limit" {
    assert twice(limit) == 20
  }
}
```

A test holds statements, declarations of its own and nested tests (reference, chapter Tests). The compiler runs only named tests that hold statements and no nested tests: the statements of an anonymous test, and those beside nested tests, parse and are never run.

---

## Types

```ebnf
Type = BaseType "->" Type   -- func: a function type, right-associative
     | BaseType             -- base

BaseType = "?" "[*]" "mut" Type                          -- optManyPointerMut
         | "?" "[*]" Type                                -- optManyPointer
         | "?" "[]" "mut" Type                           -- optSliceMut
         | "?" "[]" Type                                 -- optSlice
         | "?" "*" "mut" Type                            -- optPointerMut
         | "?" "*" Type                                  -- optPointer
         | "?" typeIdent                                 -- optNamed
         | "[" arrayFramings "]" "mut" Type              -- arrayMut
         | "[" arrayFramings "]" Type                    -- array
         | ~BracketForm "[" Expr "]" "mut" Type          -- lengthMut
         | ~BracketForm "[" Expr "]" Type                -- length
         | ~BracketForm "[" typeIdent "]" "mut" Type     -- lengthUpperMut: a near miss
         | ~BracketForm "[" typeIdent "]" Type           -- lengthUpper: a near miss
         | "[*]" "mut" Type                              -- manyPointerMut
         | "[*]" Type                                    -- manyPointer
         | "[]" "mut" Type                               -- sliceMut
         | "[]" Type                                     -- slice
         | "*" "mut" Type                                -- pointerMut
         | "*" Type                                      -- pointer
         | "^" Type                                      -- boundaryPointer
         | "(" FieldList? ")"                            -- composite
         | ComptimeType                                  -- comptimeScalar
         | rangedHead Expr ")"                           -- rangedComputed
         | rangedUnsigned                                -- rangedPrimitive
         | PrimitiveType                                 -- primitive
         | "host"                                        -- host
         | typeApplyHead NonemptyListOf<TypeArg, ","> ")" -- apply
         | typeIdent                                     -- named

BracketForm    = "[" ("*" | "!" | "?")
arrayFramings  = arrayFraming ("x" arrayFraming)*
arrayFraming   = "_"                                     -- inferred
               | ~("0" ("x" | "o" | "b" | "d")) digit+   -- explicit
               | "!"                                     -- nullTerminated
               | "?"                                     -- leb128Prefixed
typeApplyHead  = typeIdent "("
TypeArg        = Type &("," | ")")                       -- type
               | Expr                                    -- value
PrimitiveType  = "i512" | "i256" | "i128" | "i64" | "i32" | "i16" | "i8"
               | "u512" | "u256" | "u128" | "u64" | "u32" | "u16" | "u8"
               | "f32" | "f64" | "bool"
rangedUnsigned = unsignedName "#" (digit+ | ident)
rangedHead     = unsignedName "#("
unsignedName   = "u512" | "u256" | "u128" | "u64" | "u32" | "u16" | "u8"
ComptimeType   = "int" "(" intLiteral ")"                -- int
               | "float" "(" floatLiteral ")"            -- float
```

`mut` after `[]`, `[*]` and `*` makes a pointer or slice writable. `mut` after the brackets of a fixed array (`[N]mut T`, `[!]mut T`) parses and means nothing: the compiler drops it, so write `*mut [N]T`. `^T` parses, and the compiler stops on it with an internal error: it is not a type of the language.

**Nesting.** Brackets (`(`, `[`, `{`, and the `${` of a template literal), and prefixes before what they apply to (`-`, `~`, `!`, `&`, `*`, `?`, `^`, `mut`, `[]`, `[*]`, `[N]`), nest at most 128 deep: a prefix counts until its operand, and one before a bracket as long as the bracket is open. Deeper source is the error `nested more than 128 deep` at the first place it goes deeper, and is not parsed.

### Primitive and Ranged Types

```encantis
i8  i16  i32  i64  i128  i256  i512     // signed integers
u8  u16  u32  u64  u128  u256  u512     // unsigned integers
f32  f64                                // floats
bool
```

An unsigned integer type can carry an upper bound: `u32#N` holds the values `0` to `N - 1`.

```encantis
u8#16                  // 0 to 15
u32#6                  // 0 to 5
u32#n                  // a bound that is a name: a def, or a value parameter
u32#(n + 1)            // any other constant, in parentheses
```

A name after `#` is lexical, as an identifier is, so `u32#n-1` is the bound named `n-1`: write `u32#(n - 1)`. There is no space before or after the `#`.

### Tuples and Structs

```encantis
(i32, i32)             // a tuple of two
()                     // no value: the result of a function that returns nothing
(x: f64, y: f64)       // a struct
(name: []u8, age: u32)
(v: f64)               // a struct of one field
```

**Grouping:** one type without a name in parentheses is that type, wherever a type is written: `(u32)` is `u32`, `((i32, i32))` is `(i32, i32)`, and `(Point)(1.0, 2.0)` constructs a `Point`. There is no tuple of one element. After `->` the parentheses list the results, so `-> ((q: i32, r: i32))` is one result that is a struct, where `-> (q: i32, r: i32)` is two named results.

### Pointers, Slices and Many-Pointers

```encantis
*i32                   // a pointer to one i32, read-only
*mut Point             // a pointer through which a Point is written
**u8                   // a pointer to a pointer
[]u8                   // a slice: an address and a length
[]mut u8               // a slice through which bytes are written
[*]u8                  // a many-pointer: an address, no length
?*Node                 // an optional pointer: a pointer or none
?[]u8                  // an optional slice
?Canvas                // a named type made optional (a host type, or a name for a pointer or slice)
*[]u8                  // a pointer to a slice
[][]u8                 // a slice of slices
```

### Array Types

An array type is a bracket form followed by the element type. A length is a decimal number or any compile-time constant expression: `[n]T`, `[k * 2]T`, `[(n + 31) / 32]u32`, `[sizeof(T) * 4]u8`, `[0x10]u8`. The bracket forms of `arrayFramings` are tried first; whatever else stands between the brackets is read as an expression, unless it starts with `*`, `!` or `?`, as the forms `[*]`, `[!]` and `[?]` do. A near miss of one of those, `[*:0]u8` or `[!u8]`, is a syntax error at the place that form went wrong. The `x` between dimensions is read only between decimal numbers, so `[0x10]u8` is sixteen bytes and `[2x3]u8` a packed block of two rows of three.

```encantis
[5]u8                  // five bytes held by value, in registers
[n]u32                 // a length that is a def or a value parameter
*[16]u8                // a pointer to 16 bytes
*mut [16]u8            // the same, writable
*[!]u8                 // a pointer to bytes ending at a zero byte
[!]u8                  // the same pointer, written without the *
*[?]u8                 // a pointer to bytes after their LEB128 length
*[2x3]i32              // a pointer to 2 rows of 3, packed
*[2][3]i32             // a pointer to a table: 2 pointers to rows of 3
[*][5]u8               // a many-pointer to row pointers, rows of 5
[][3]i32               // a slice of row pointers
*[_]u8                 // a length inferred from the value: data a: *[_]u8 = "abc"
```

Only `[N]T` with a length is a value; every other bracket form is a pointer or a slice. Behind a pointer or a slice, an element that is a fixed array is a row of its own, reached through a row pointer (a table); `[NxM]` lays rows out packed (reference 2.5).

### Generic Types Applied

**A generic type applied**, `Vec(u32)`, `Map(K, Vec(V))`, `*mut Vec(T)`, `Ring(8, u32)`, is a type wherever a type is written. There is no space between the name and the parenthesis: a type can end a line, and the next one can start with a parenthesis. An argument is a type where it parses as one, and otherwise an expression, a number for a value parameter (`Ring(8, u32)`, `Bits(n * 2)`).

### Function Types

```encantis
i32 -> i32                    // one input, one result
(i32, i32) -> i32             // two inputs
(x: i32) -> (result: i32)     // named inputs and results
i32 -> i32 -> i32             // i32 -> (i32 -> i32)
(i32 -> i32) -> i32           // a function that takes a function
() -> ()                      // nothing in, nothing out
```

### Compile-Time Types

```encantis
int(42)                // the type of the untyped integer constant 42
float(3.14)            // the type of the untyped float constant 3.14
```

These are the types of constants that have no type of their own, as the compiler's messages name them (`cannot assign int(300) to u8`).

---

## Statements

```ebnf
Statement = FuncDecl | LetStmt | SetStmt | WhileStmt | ForStmt | LoopStmt
          | ReturnStmt | BreakStmt | ContinueStmt | DeferStmt | AssertStmt
          | AssignmentStmt | ExpressionStmt
```

A `func` in a body declares a nested function (reference 3.4); it has the module rule's forms, and the checker refuses the generic ones there. `func` and `inline` are keywords, so no other statement starts with them.

Function syntax Encantis does not have gets a syntax error that says what to write instead, in place of the list of what was expected: a lambda (`|x| x > n`, `|| true`, `(x) => x + 1`, `x => x + 1`, `(x: u32) -> u32 => ...`), `fn` where a declaration or an argument starts (`fn twice(x: u32) ...`, `fn(x) { ... }`), `func` where an expression is wanted, and `export` inside a body or a test. Reference 3.4 lists the rules; every other syntax error keeps the list.

### Let and Set

```ebnf
LetStmt      = "let" MultiPattern "=" Expr          -- multi
             | "let" PatternWithType ("=" Expr)?    -- single
SetStmt      = "set" MultiPattern "=" Expr          -- multi
             | "set" PatternWithType "=" Expr       -- single
MultiPattern = ident "," NonemptyListOf<ident, ",">
```

`let` declares variables; `set` assigns variables that exist, by the same patterns:

```encantis
let x = 42                    // the type from the value
let y: i32 = 100
let ptr: *u8                  // no value until one is assigned
let (a, b) = (10, 20)         // by position
let q, r = divmod(17, 5)      // by position, without parentheses
let (x:, y:) = point          // fields by name

set (a, b) = (b, a)           // swaps: the whole value is read before either is set
set q, r = divmod(18, 5)
```

### Assignment

```ebnf
AssignmentStmt = LValue assignOp Expr
LValue         = ident AccessSuffix*
assignOp       = "<<<=" | ">>>=" | "<<=" | ">>="
               | "+|=" | "-|=" | "*|="
               | "+=" | "-=" | "*=" | "/=" | "%="
               | "&=" | "|=" | "^="
               | "="
```

```encantis
x = 42
count += 1
bits &= 0xFF
value <<<= 13                 // rotate left
p.x = 1.0                     // a field
buf[i] = 0                    // an element
ptr.* = v                     // through a pointer
grid[r][c] = 1
```

The target is a name followed by accesses. A tuple of names is assigned with `set`: `(a, b) = ...` is a syntax error. `+|=`, `-|=` and `*|=` are the saturating forms. **Not implemented:** the compiler compiles them as `+=`, `-=` and `*=` (reference 4.1).

### Loops

```ebnf
WhileStmt  = "while" Expr Body
ForStmt    = "for" ForBinding "in" Expr Body
ForBinding = ident "," ident                    -- withIndex
           | ident                              -- valueOnly
LoopStmt   = "loop" Body
```

```encantis
while count < 10 {
  count += 1
}

for i in 10 { total += i }       // 0 to 9
for item in items { use(item) }  // the elements of a slice or a *[N]T
for i, item in items { }         // with the index first

loop {
  break when done
}
```

### Return, Break and Continue

```ebnf
ReturnStmt   = "return" Expr? WhenClause?
BreakStmt    = "break" WhenClause?
ContinueStmt = "continue" WhenClause?
WhenClause   = "when" Expr
```

```encantis
return 42
return (x, y)                 // two values
return                        // no result, or the named results as they are
return 0 when x == 0          // only when the condition holds
break when done
continue when skip
```

### Defer and Assert

```ebnf
DeferStmt  = "defer" Expr
AssertStmt = "assert" Expr
```

```encantis
defer reset(m)                // runs when the block exits, newest first
assert n % 2 == 0             // traps when false
```

### Expression Statements

```ebnf
ExpressionStmt = Expr
```

A call, an `if` or a `match` stands as a statement; the value of a call, if any, is dropped.

---

## Patterns

```ebnf
Pattern     = "(" PatternList ")"   -- tuple
            | ident                 -- ident
PatternList = NonemptyListOf<PatternElem, ",">
PatternElem = ident ":" ident       -- namedExplicit: the field, then the variable
            | ident ":"             -- namedShort: a variable named like the field
            | Pattern               -- positional
```

```encantis
let (a, b) = get_pair()           // by position
let ((a, b), c) = nested()        // positions nest
let (x:, y:) = point              // by name: x and y
let (x: px, y: py) = point        // by name, into px and py
let (x:, y: pos_y) = point        // mixed
```

A field taken by name is bound to a variable: a pattern does not nest after `name:`.

---

## Expressions

### Precedence

From the loosest binding to the tightest:

| Level | Operators | Rule |
|---|---|---|
| 1 | `??` | `CoalesceExpr` |
| 2 | `\|\|` | `OrExpr` |
| 3 | `&&` | `AndExpr` |
| 4 | `!` | `NotExpr` |
| 5 | `==` `!=` `<` `>` `<=` `>=` | `CompareExpr` |
| 6 | `\|` | `BitOrExpr` |
| 7 | `^` | `BitXorExpr` |
| 8 | `&` | `BitAndExpr` |
| 9 | `<<` `>>` `<<<` `>>>` | `ShiftExpr` |
| 10 | `+` `-` `+\|` `-\|` | `AddExpr` |
| 11 | `*` `/` `%` `*\|` | `MulExpr` |
| 12 | `-` `~` `&` `mut` (prefix) | `UnaryExpr` |
| 13 | `as`, `:` | `CastExpr` |
| 14 | `.`, `[ ]`, `( )` (suffix) | `PostfixExpr` |

```ebnf
Expr         = CoalesceExpr
CoalesceExpr = PostfixExpr "??" OrExpr        -- coalesce
             | OrExpr
OrExpr       = OrExpr "||" AndExpr            -- or
             | AndExpr
AndExpr      = AndExpr "&&" NotExpr           -- and
             | NotExpr
NotExpr      = "!" NotExpr                    -- not
             | CompareExpr
CompareExpr  = CompareExpr compareOp BitOrExpr -- compare
             | BitOrExpr
compareOp    = "==" | "!=" | "<=" | ">=" | "<" | ">"
BitOrExpr    = BitOrExpr "|" ~"|" BitXorExpr   -- or
             | BitXorExpr
BitXorExpr   = BitXorExpr "^" BitAndExpr      -- xor
             | BitAndExpr
BitAndExpr   = BitAndExpr "&" ~"&" ShiftExpr  -- and
             | ShiftExpr
ShiftExpr    = ShiftExpr shiftOp AddExpr      -- shift
             | AddExpr
shiftOp      = "<<<" | ">>>" | "<<" | ">>"
AddExpr      = AddExpr addOp MulExpr          -- add
             | MulExpr
addOp        = "+|" | "-|" | "+" | "-"
MulExpr      = MulExpr mulOp UnaryExpr        -- mul
             | UnaryExpr
mulOp        = "*|" | "*" | "/" | "%"
UnaryExpr    = "-" UnaryExpr                  -- neg
             | "~" UnaryExpr                  -- complement
             | "&" UnaryExpr                  -- ref
             | "mut" UnaryExpr                -- mut
             | CastExpr
CastExpr     = PostfixExpr "as" Type          -- cast
             | PostfixExpr TypeAnnotation     -- annotation
             | PostfixExpr
PostfixExpr  = PrimaryExpr PostfixOp*
PostfixOp    = AccessSuffix
             | "(" ArgList? ")"                -- call
```

Binary operators group from the left: `a - b - c` is `(a - b) - c`. Some consequences of the levels:

- The left side of `??` is a postfix expression (an index, a call, a member, a name, a parenthesized expression), and its right side is anything of level 2 or tighter: `xs[i] ?? 0 + 1` is `xs[i] ?? (0 + 1)`. `??` does not chain: `a ?? b ?? c` is a syntax error, so write `a ?? (b ?? c)`.
- `!` binds more loosely than a comparison: `!a == b` is `!(a == b)`.
- A cast binds more tightly than a prefix operator: `-x as u32` is `-(x as u32)`, and `&p[1] as [*]u8` is `&(p[1] as [*]u8)`; write `(&p[1]) as [*]u8` for the address cast.
- `x:u32.f()` reads `u32.f()` as the type, which is a syntax error: write `(x:u32).f()`.

### Operators

```encantis
a + b      a - b      a * b      a / b      a % b     // arithmetic; integers wrap
a +| b     a -| b     a *| b                          // saturating: not implemented
a & b      a | b      a ^ b      ~a                   // bitwise
a << b     a >> b                                     // shifts; >> keeps the sign of a signed value
a <<< b    a >>> b                                    // rotations
a == b     a != b     a < b      a <= b    a > b    a >= b
a && b     a || b     !a                              // bools; && and || skip the right side when they can
-x                                                    // negation
&x                                                    // an address (of a literal: a new cell)
mut [0:u8; 16]                                        // a literal in writable memory of its own
xs[i] ?? 0                                            // the element, or 0 when i is out of range
```

### Casts and Type Annotations

```encantis
42:i32                        // a constant given its type
value as u32                  // a conversion
ptr as *u8                    // a pointer cast
u32(value)                    // a conversion written as a call
```

### Accesses

```ebnf
AccessSuffix = "." digit+                         -- tupleIndex
             | "." "*"                            -- deref
             | "." PrimitiveType ~identChar       -- typePun
             | "." ident                          -- field
             | "[" Expr? ".." Expr? "]"           -- slice
             | "[" Expr "]"                       -- index
```

```encantis
point.x                       // a field, or a method: p.scale(2.0)
pair.0                        // a tuple element by position
ptr.*                         // what a pointer points to
bytes.u32                     // a type pun: the pointer as a [*]u32
xs[i]                         // an element
matrix[i][j]
s[2..5]                       // a range: elements 2 to 4
s[..n]    s[n..]    s[..]     // from the start, to the end, all
```

The name after the dot is a whole identifier, by the same rule as everywhere else: letters, digits, `_` and `-`. A member is a type pun only when that whole name is a primitive type's: `p.u32` and `p.u8[4]` are; `s.boolish`, `p.i8_le`, `v.u32s()`, `x.u32-count` and `p.u32-1` name a field or a method (`u32-count`, `u32-1`). A subtraction needs spaces, `p.u32 - 1`, as it does after a name (`n-1` is one identifier), and the formatter prints every binary `-` with spaces, so the two read differently. Where a member such as `u32-1` does not exist but the part before a hyphen does, the error says ``for a subtraction write `p.u32 - 1` ``.

### Primary Expressions

```ebnf
PrimaryExpr = IfExpr
            | MatchExpr
            | TemplateLiteral
            | ArrayLiteral
            | "sizeof" "data"                     -- sizeofData
            | "sizeof" "(" Type ")"               -- sizeof
            | "(" ArgList ")"                     -- tupleOrStruct
            | "(" Expr ")"                        -- group
            | "(" ")"                             -- unit
            | typeIdent "(" ArgList? ")"          -- constructor
            | literal
            | ident
ArrayLiteral = "[" Expr ";" Expr "]"              -- repeat: value; count
             | "[" ListOf<Expr, ","> ","? "]"     -- list
```

```encantis
42    3.14    "hello"    'a'    true                // literals
()                                                  // no value
(1, 2)                                              // a tuple
(x: 1, y: 2)                                        // a struct
(x:, y:)                                            // fields named like variables: (x: x, y: y)
[1, 2, 3]                                           // an array
[0:u8; 1024]                                        // 1024 zero bytes
Point(1.0, 2.0)                                     // a constructor
Point(y: 2.0, x: 1.0)                               // fields by name
Vec(u32)(p, 0, 16)                                  // the constructor of a generic type applied
sizeof(u64)                                         // the size of a type in bytes
sizeof data                                         // the end of the program's data
```

A type that is called constructs a value of it. `Vec(u32)(p, 0, 16)` parses as a call of a call; the checker reads the inner one as the type. A named argument of a constructor and a named element of a tuple literal are the same syntax and mean the same: the value of the field of that name, whatever its place, while an element without a name is the field at its place. Values are computed in the order they are written (reference 2.8).

### Calls and Arguments

```ebnf
ArgList       = NonemptyListOf<Arg, ",">
Arg           = ident ":" Expr                 -- named
              | ident ":"                      -- shorthand
              | TypeLit &("," | ")")           -- type
              | Expr &("," | ")")              -- positional
              | Type &("," | ")")              -- otherType
              | Expr                           -- unfinished
TypeLit       = &typeOnlyStart BaseType
typeOnlyStart = "?" | "*" | "[*]" | "[]" | arrayPrefix | rangedHead | rangedUnsigned | bareTypeIdent
arrayPrefix   = "[" arrayFramings "]"
bareTypeIdent = typeIdent ~"("
```

```encantis
add(1, 2)                     // arguments by position
Point(x: 1.0, y: 2.0)         // a constructor takes names too
Point(x:, y:)                 // shorthand: x: x, y: y
p.scale(2.0)                  // a method call: scale(p, 2.0), where p has no member scale
v.items().sort(less)          // calls chain
(4:u32).double()              // a literal with its type written on it is a receiver in parentheses
```

**Method calls.** `x.f(a)` is a member access followed by a call: no rule of its own. The checker reads it as `f(x, a)` where `x` has no member `f`, so whether it is a method call depends on the type of `x`, not on how it is written.

**Type arguments.** A call of a generic function may pass a type where the parameter is `comptime T: type`:

```encantis
max(u32, a, b)                // u32 is an identifier, read as a type by its position
pick((i32, i32), c, p, q)     // a tuple of identifiers, read as a type by its position
head([]u8, xs)                // []u8 can only be a type: parsed as one
head(*mut Point, xs)
first(Point, ps)              // a bare type name is not an expression: parsed as a type
apply((u32) -> u32, f)        // so is a function type
pick((name: []u8, at: Point), a, b)   // and a struct type whose fields are not all expressions
```

An argument is parsed as a type when it starts in a way no expression can (`?`, `*`, `[*]`, `[]`, `[N]`, `u8#16`, `u8#n`, `u8#(`, an upper-case name that is not followed by `(`), or when it is no expression but is a type, such as a function type or a struct type with a field type like `[]u8` or `Point`; the type is followed by `,` or `)`. Everything else stays an expression: `u32`, `(i32, i32)`, `(q: i32, r: i32)`, `(at: Point)` (the name `at` given a type, in parentheses), `Point(1, 2)`, `[4]`, `[]`. The checker reads such an expression as a type where the parameter is a type parameter, so a type argument is always written as it would be after a colon. So a struct type with named fields is written in place like any other type argument: `(q: i32, r: i32)` is an expression read as a type, and `(name: []u8, at: Point)` is parsed as a type because it is no expression.

A generic type applied is an expression of the same kind: `first(Vec(u32), vs)` parses as a call inside a call, and is read as a type by its position. Its own arguments follow the same rule, so `first(Vec([]u8), vs)` works too. A call with numbers among its arguments, `Ring(8, u32)`, is read as a type where its callee is a generic type in scope, each number given to a value parameter; `Cell(1, 2)` with `Cell` a struct type stays a value.

**Value arguments.** Where the parameter is `comptime n: u32`, the argument is an expression, a compile-time constant: `sum(8, xs)`, `sum(2 + 2, xs)`, `fill(n * 2, xs, 7)`.

### If

```ebnf
IfExpr     = "if" "let" MatchPattern "=" Expr Body ElifBranch* ElseBranch?   -- ifLet
           | "if" Expr Body ElifBranch* ElseBranch?                          -- if
ElifBranch = "elif" "let" MatchPattern "=" Expr Body                         -- elifLet
           | "elif" Expr Body                                                -- elif
ElseBranch = "else" Body
```

```encantis
if x > 0 {
  return x
} elif x < 0 {
  return -x
}

let sign = if x > 0 { 1 } elif x < 0 { -1 } else { 0 }
let sign2 = if x > 0 => 1 elif x < 0 => -1 else => 0    // arrow bodies are expressions

if let name = names[i] { print(name) } else { print("none") }
let n = if let p = maybe { p.* } else { 0 }
```

A branch is a block or `=>` and one expression: `if c => r = 1` is a syntax error, as an assignment is a statement. `elif let` parses, and the compiler does not bind its name (a compiler bug): write `else { if let ... }`.

### Match

```ebnf
MatchExpr        = "match" Expr "{" MatchArm* "}"
MatchArm         = NonemptyListOf<MatchPattern, ","> "=>" (Block | Expr) ","?
MatchPattern     = typeIdent "(" MatchPatternList ")"   -- constructor
                 | "(" MatchPatternList ")"             -- tuple
                 | typeIdent                            -- variant
                 | literal                              -- literal
                 | ident                                -- binding
                 | "_"                                  -- wildcard
MatchPatternList = NonemptyListOf<MatchPatternElem, ",">
MatchPatternElem = ident ":" MatchPattern               -- named
                 | ident ":"                            -- namedShort
                 | MatchPattern                         -- positional
```

```encantis
let word: []u8 = match n {
  0 => "zero"
  1 => "one"
  2, 3, 4 => "a few"
  _ => "many"
}

match status {
  200 => { handle_success() }
  404 => { handle_not_found() }
  _ => { handle_error() }
}
```

The compiler compares numbers, codepoints and bools, and `_` matches anything. **Not implemented:** binding, variant, constructor and tuple patterns parse, and are not matched (reference 6.3). There is no guard: `n if n > 3 => ...` is a syntax error.

---

## Complete Examples

### Hello World

A WASI program, run with `encantis run hello.ents`:

```encantis
import "wasi_snapshot_preview1" "fd_write"
  func fd_write(fd: i32, iovs: [][]u8, written: *mut u32) -> i32

export memory

export "_start" func main() {
  fd_write(1, ["Hello, World!\n"], &0:u32)
}
```

### Math Functions

```encantis
func clamp(x: i32, lo: i32, hi: i32) -> i32 => if x < lo => lo elif x > hi => hi else => x

func fibonacci(n: u32) -> u32 => if n < 2 { n } else { fibonacci(n - 1) + fibonacci(n - 2) }

func gcd(a: u32, b: u32) -> u32 {
  let x = a
  let y = b
  while y != 0 {
    set (x, y) = (y, x % y)
  }
  return x
}
```

### Structs and Tuples

```encantis
type Point = (x: f64, y: f64)
type Polar = (distance: f64, slope: f64)

func to_polar(point: Point) -> Polar {
  let (x:, y:) = point
  let distance = sqrt(x * x + y * y)
  let slope = if x == 0.0 { 0.0 } else { y / x }
  return (distance:, slope:)
}
```

### Arrays and Loops

```encantis
func sum(arr: []i32) -> (total: i32) {
  for value in arr {
    total += value
  }
}

func find_max(arr: []f64) -> f64 {
  let result = arr[0] ?? 0.0
  for value in arr {
    if value > result { result = value }
  }
  return result
}
```
