# Encantis Formal Grammar

This document defines the formal syntax of the Encantis language using Extended Backus-Naur Form (EBNF).

## Notation

```
=           definition
|           alternation
[ ... ]     optional (0 or 1)
{ ... }     repetition (0 or more)
( ... )     grouping
"..."       terminal string
'...'       terminal string
UPPER       token/terminal
lower       non-terminal
```

## Lexical Elements

### Identifiers

```ebnf
identifier      = lower_start { ident_char }
type_identifier = upper_start { ident_char }

lower_start     = 'a'..'z'
upper_start     = 'A'..'Z'
ident_char      = 'a'..'z' | 'A'..'Z' | '0'..'9' | '_' | '-'
```

### Keywords

```ebnf
keyword = "if" | "elif" | "else" | "while" | "for" | "in" | "loop" | "match"
        | "break" | "continue" | "return" | "when"
        | "func" | "let" | "set" | "global" | "def" | "type"
        | "import" | "export" | "memory" | "inline" | "unique"
        | "as"
```

### Literals

```ebnf
literal         = number_literal | string_literal | bool_literal

number_literal  = [ "-" ] ( integer_literal | float_literal )

integer_literal = decimal_literal | hex_literal | binary_literal | octal_literal | dozenal_literal
decimal_literal = digit { digit }
hex_literal     = "0x" hex_digit { hex_digit }
binary_literal  = "0b" binary_digit { binary_digit }
octal_literal   = "0o" octal_digit { octal_digit }
dozenal_literal = "0d" dozenal_digit { dozenal_digit }

float_literal   = digit { digit } "." digit { digit } [ exponent ]
exponent        = ( "e" | "E" ) [ "+" | "-" ] digit { digit }

string_literal  = utf8_string | char_string | hex_string | base64_string
utf8_string     = '"' { string_char | escape_seq } '"'
char_string     = "'" { string_char | escape_seq } "'"
hex_string      = 'x"' { hex_byte | whitespace } '"'
base64_string   = 'b"' { base64_char | whitespace } '"'

string_char     = <any UTF-8 char except '"' or '\'>
escape_seq      = '\' ( 'n' | 't' | 'r' | '\' | '"' | 'x' hex_digit hex_digit )
hex_byte        = hex_digit hex_digit
base64_char     = 'A'..'Z' | 'a'..'z' | '0'..'9' | '+' | '/' | '='

bool_literal    = "true" | "false"

digit           = '0'..'9'
hex_digit       = '0'..'9' | 'a'..'f' | 'A'..'F'
binary_digit    = '0' | '1'
octal_digit     = '0'..'7'
dozenal_digit   = '0'..'9' | 'a'..'b' | 'A'..'B'
```

### Comments

```ebnf
comment         = line_comment | block_comment
line_comment    = "//" { <any char except newline> } NEWLINE
block_comment   = "/*" { <any char> } "*/"
```

## Top-Level Declarations

```ebnf
program         = { declaration }

declaration     = import_decl
                | export_decl
                | func_decl
                | type_decl
                | unique_decl
                | def_decl
                | global_decl
                | memory_decl
```

### Imports

```ebnf
import_decl     = "import" string_literal string_literal import_item
                | "import" string_literal "(" { import_group_item } ")"

import_item     = "func" [ identifier ] func_signature
                | "global" identifier ":" type
                | "memory" integer_literal

import_group_item = string_literal import_item
```

### Exports

```ebnf
export_decl     = "export" string_literal exportable

exportable      = func_decl
                | global_decl
                | memory_decl
```

### Functions

```ebnf
func_decl       = [ "inline" ] "func" [ identifier ] func_signature func_body

func_signature  = value_spec [ "->" value_spec ]

value_spec      = type                           -- single value
                | "(" [ field_list ] ")"         -- zero or more values

field_list      = field { "," field }
field           = type                           -- anonymous
                | identifier ":" type            -- named

func_body       = body
```

Examples:

- `func foo i32 -> i32` — single anonymous input/output
- `func foo(a:i32, b:i32) -> i32` — named inputs, single output
- `func foo(a:i32, b:i32) -> (q:i32, r:i32)` — named inputs and outputs
- `func foo()` — no inputs, no return

### Type Declarations

```ebnf
type_decl       = "type" type_identifier "=" type
unique_decl     = "unique" type_identifier "=" type
```

### Definitions

```ebnf
def_decl        = "def" identifier "=" expression
```

The expression is typically a literal with optional type annotation (e.g., `def pi = 3.14159:f64`).

### Globals

```ebnf
global_decl     = "global" identifier [ ":" type ] [ "=" expression ]
```

### Memory

```ebnf
memory_decl     = "memory" integer_literal [ integer_literal ] [ "{" { data_entry } "}" ]
data_entry      = integer_literal "=>" expression [ "," ]
```

The expression must be a compile-time constant: literals (string, bytes, number) or tuple/struct literals containing only constants.

Examples:

```ents
memory 1              // 1 page minimum (64KB)
memory 1 16           // 1 page min, 16 pages max (1MB)

memory 1 {
  0 => "Hello",             // UTF-8 string at address 0
  5 => 0:u8,                // null terminator at address 5
  16 => x"48 65 6C 6C 6F",  // raw bytes at address 16
  32 => (100:i32, 200:i32), // two i32s serialized at address 32
  40 => (x: 1.0, y: 2.0),   // struct fields serialized at address 40
}
```

## Types

```ebnf
type            = primitive_type
                | pointer_type
                | array_type
                | composite_type
                | type_identifier

primitive_type  = "i8" | "i16" | "i32" | "i64"
                | "u8" | "u16" | "u32" | "u64"
                | "f32" | "f64"
                | "bool"

pointer_type    = "*" type

array_type      = "[" encoding? size? type "]"
encoding        = "?" | "!"
size            = integer_literal ";"

composite_type  = "(" [ field_list ] ")"
```

### Array Types

Arrays use bracket syntax with optional encoding and size specifiers:

| Syntax | Description | Runtime Representation |
|--------|-------------|------------------------|
| `[T]` | Comptime list | None (resolved at compile time) |
| `*[T]` | Slice | ptr + len (fat pointer, 64 bits) |
| `[N;T]` | Inline array | N values on stack/registers |
| `*[N;T]` | Fixed array | ptr to N values in memory |
| `*[?T]` | LEB128-prefixed | ptr (length encoded in data) |
| `*[!T]` | Null-terminated | ptr (sentinel in data) |

The `?` encoding means "how many?" — the length is stored as a LEB128 prefix.
The `!` encoding means "stop!" — a null sentinel terminates the array.

### Nested Arrays

Nesting determines flat vs pointer-indirect memory layout:

**Flat memory (no inner pointer):**

- `*[![!u8]]` — double null-terminated: `"hello\0world\0\0"`
- `*[?[?u8]]` — LEB128 count + LEB128 length per element

**Pointer indirection (inner `*`):**

- `*[!*[!u8]]` — null-term array of pointers to null-term strings
- `*[*[u8]]` — slice of slices (outer has ptr+len, each element has ptr+len)

Examples:

```ents
["hello", "world"]:*[![!u8]]     // Flat: "hello\0world\0\0"
["hello", "world"]:*[!*[!u8]]    // Pointers: [ptr1, ptr2, 0] where ptr1→"hello\0", ptr2→"world\0"
```

### Inline Arrays and SIMD

Inline arrays `[N;T]` store values directly on the stack or in registers:

- `[4;f32]` — 4 floats inline (may auto-promote to v128/f32x4)
- `[2;[2;f32]]` — 2×2 matrix as 4 inline floats

Composite types: `()` (unit), `(i32, i32)` (tuple), `(x:i32, y:i32)` (struct).

## Statements

```ebnf
body            = block | "=>" expression
block           = "{" { statement } "}"

statement       = let_stmt
                | set_stmt
                | if_stmt
                | while_stmt
                | for_stmt
                | loop_stmt
                | return_stmt
                | break_stmt
                | continue_stmt
                | assignment_stmt
                | expression_stmt

let_stmt        = "let" pattern [ ":" type ] [ "=" expression ]
set_stmt        = "set" pattern [ ":" type ] "=" expression

if_stmt         = "if" expression body { elif_clause } [ else_clause ]
elif_clause     = "elif" expression body
else_clause     = "else" body

while_stmt      = "while" expression body

for_stmt        = "for" for_binding "in" expression body
for_binding     = identifier [ "," identifier ]

loop_stmt       = "loop" body

return_stmt     = "return" [ expression ] [ "when" expression ]
break_stmt      = "break" [ "when" expression ]
continue_stmt   = "continue" [ "when" expression ]

assignment_stmt = lvalue assign_op expression
assign_op       = "=" | "+=" | "-=" | "*=" | "/=" | "%="
                | "&=" | "|=" | "^=" | "<<=" | ">>=" | "<<<=" | ">>>="
                | "+|=" | "-|=" | "*|="

expression_stmt = expression
```

## Patterns

```ebnf
pattern         = identifier
                | "(" pattern_list ")"

pattern_list    = pattern_elem { "," pattern_elem }

pattern_elem    = identifier                        -- positional binding
                | identifier ":"                    -- named shorthand (x: binds field x to var x)
                | identifier ":" identifier         -- named explicit (x: y binds field x to var y)
                | "(" pattern_list ")"              -- nested pattern
```

Positional vs named patterns:

- `(a, b)` — positional: binds by position
- `(x:, y:)` — named shorthand: binds fields x, y to variables x, y
- `(x: a, y: b)` — named explicit: binds field x to a, field y to b

## Expressions

Expressions are defined by precedence level (lowest to highest).

### Logical

```ebnf
expression      = or_expr
or_expr         = and_expr { "||" and_expr }
and_expr        = not_expr { "&&" not_expr }
not_expr        = "!" not_expr | comparison_expr
```

### Comparison

```ebnf
comparison_expr = bitor_expr { compare_op bitor_expr }
compare_op      = "==" | "!=" | "<" | ">" | "<=" | ">="
```

### Bitwise

```ebnf
bitor_expr      = bitxor_expr { "|" bitxor_expr }
bitxor_expr     = bitand_expr { "^" bitand_expr }
bitand_expr     = shift_expr { "&" shift_expr }
```

### Shift

```ebnf
shift_expr      = add_expr { shift_op add_expr }
shift_op        = "<<" | ">>" | "<<<" | ">>>"
```

### Arithmetic

```ebnf
add_expr        = mul_expr { add_op mul_expr }
add_op          = "+" | "-" | "+|" | "-|"

mul_expr        = unary_expr { mul_op unary_expr }
mul_op          = "*" | "/" | "%" | "*|"
```

### Unary

```ebnf
unary_expr      = "-" unary_expr
               | "~" unary_expr
               | "&" unary_expr
               | cast_expr
```

### Cast and Annotation

```ebnf
cast_expr       = postfix_expr [ "as" type ]       -- runtime cast
                | postfix_expr [ ":" type ]        -- type annotation
```

### Postfix

```ebnf
postfix_expr    = primary_expr { postfix_op }
postfix_op      = "." identifier                    -- field access
               | "." integer_literal                -- tuple index (.0, .1, ...)
               | "." "*"                            -- dereference
               | "." type                           -- type-punned access
               | "[" expression "]"                 -- index
               | "(" [ arg_list ] ")"               -- call
```

### Primary

```ebnf
primary_expr    = literal
               | identifier
               | type_identifier [ "(" [ arg_list ] ")" ]   -- constructor
               | "(" expression ")"                          -- grouping
               | "(" [ arg_list ] ")"                        -- tuple/struct literal
               | if_expr
               | match_expr

if_expr         = "if" expression body [ elif_expr | else_expr ]
elif_expr       = "elif" expression body [ elif_expr | else_expr ]
else_expr       = "else" body

match_expr      = "match" expression "{" { match_arm } "}"
match_arm       = match_patterns "=>" ( block | expression )
match_patterns  = match_pattern { "," match_pattern }
match_pattern   = literal | "_"

arg_list        = arg { "," arg }
arg             = expression
               | identifier ":" expression          -- named argument
               | identifier ":"                     -- shorthand (field: field)
```

## L-Values

```ebnf
lvalue          = identifier
               | lvalue "." identifier              -- field
               | lvalue "." integer_literal         -- tuple index
               | lvalue "." "*"                     -- deref
               | lvalue "." type                    -- type-pun
               | lvalue "[" expression "]"          -- index
               | pattern                            -- destructuring
```

## Operator Precedence (lowest to highest)

| Precedence | Operators | Associativity |
|------------|-----------|---------------|
| 1 | `\|\|` | left |
| 2 | `&&` | left |
| 3 | `!` | prefix |
| 4 | `==` `!=` `<` `>` `<=` `>=` | left |
| 5 | `\|` | left |
| 6 | `^` | left |
| 7 | `&` | left |
| 8 | `<<` `>>` `<<<` `>>>` | left |
| 9 | `+` `-` | left |
| 10 | `*` `/` `%` | left |
| 11 | `-` `~` `&` (unary) | prefix |
| 12 | `as` `:` | left |
| 13 | `.` `[]` `()` | left (postfix) |

## Builtin Functions

The following identifiers are reserved as builtin functions:

```ebnf
builtin_func    = "sqrt" | "abs" | "ceil" | "floor" | "trunc" | "nearest"
                | "min" | "max" | "copysign"
                | "clz" | "ctz" | "popcnt"
                | "memory-size" | "memory-grow"
```

## Whitespace and Formatting

- Whitespace (spaces, tabs, newlines) separates tokens but is otherwise ignored
- Statements are separated by newlines or can appear on the same line
- Blocks use `{` and `}` delimiters
- No semicolons required
