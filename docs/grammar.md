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
keyword = "if" | "elif" | "else" | "while" | "for" | "in" | "loop"
        | "break" | "continue" | "return" | "when"
        | "func" | "let" | "set" | "global" | "def" | "type"
        | "import" | "export" | "memory" | "data" | "inline" | "unique"
        | "and" | "or" | "not" | "as"
```

### Literals

```ebnf
literal         = number_literal | string_literal | bool_literal

number_literal  = [ "-" ] ( integer_literal | float_literal ) [ ":" type ]

integer_literal = decimal_literal | hex_literal | binary_literal | octal_literal
decimal_literal = digit { digit }
hex_literal     = "0x" hex_digit { hex_digit }
binary_literal  = "0b" binary_digit { binary_digit }
octal_literal   = "0o" octal_digit { octal_digit }

float_literal   = digit { digit } "." digit { digit } [ exponent ]
exponent        = ( "e" | "E" ) [ "+" | "-" ] digit { digit }

string_literal  = '"' { string_char | escape_seq } '"'
string_char     = <any UTF-8 char except '"' or '\'>
escape_seq      = '\' ( 'n' | 't' | 'r' | '\' | '"' | 'x' hex_digit hex_digit )

bool_literal    = "true" | "false"

digit           = '0'..'9'
hex_digit       = '0'..'9' | 'a'..'f' | 'A'..'F'
binary_digit    = '0' | '1'
octal_digit     = '0'..'7'
```

### Comments

```ebnf
comment         = line_comment | block_comment
line_comment    = "--" { <any char except newline> } NEWLINE
block_comment   = "-<" { <any char> } ">-"
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
                | data_decl
```

### Imports

```ebnf
import_decl     = "import" string_literal string_literal import_item
                | "import" string_literal "(" { import_group_item } ")"

import_item     = func_signature
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

func_signature  = "(" [ param_list ] ")" [ "->" return_type ]

param_list      = param { "," param }
param           = [ identifier ":" ] type

return_type     = type
                | "(" named_field_list ")"

func_body       = block
                | "=>" expression
```

### Type Declarations

```ebnf
type_decl       = "type" type_identifier "=" type
unique_decl     = "unique" type_identifier "=" type
```

### Definitions

```ebnf
def_decl        = "def" identifier "=" literal
```

Note: Type suffix is part of the literal (e.g., `def pi = 3.14159:f64`).

### Globals

```ebnf
global_decl     = "global" identifier [ ":" type ] [ "=" expression ]
```

### Memory

```ebnf
memory_decl     = "memory" integer_literal [ integer_literal ]
data_decl       = "data" integer_literal ( string_literal | "[" byte_list "]" )
byte_list       = integer_literal { "," integer_literal }
```

## Types

```ebnf
type            = primitive_type
                | pointer_type
                | slice_type
                | array_type
                | null_term_type
                | tuple_type
                | struct_type
                | type_identifier

primitive_type  = "i8" | "i16" | "i32" | "i64"
                | "u8" | "u16" | "u32" | "u64"
                | "f32" | "f64"
                | "bool"

pointer_type    = "*" type

slice_type      = type "[" "]"
array_type      = type "[" expression "]"
null_term_type  = type "[" "/" "0" "]"

tuple_type      = "(" type_list ")"
type_list       = type { "," type }

struct_type     = "(" named_field_list ")"
named_field_list = named_field { "," named_field }
named_field     = identifier ":" type
```

## Statements

```ebnf
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
set_stmt        = "set" pattern "=" expression

if_stmt         = "if" expression block { elif_clause } [ else_clause ]
elif_clause     = "elif" expression block
else_clause     = "else" block

while_stmt      = "while" expression block

for_stmt        = "for" for_binding "in" expression block
for_binding     = identifier [ "," identifier ]

loop_stmt       = "loop" block

return_stmt     = "return" [ expression ] [ "when" expression ]
break_stmt      = "break" [ "when" expression ]
continue_stmt   = "continue" [ "when" expression ]

assignment_stmt = lvalue assign_op expression
assign_op       = "=" | "+=" | "-=" | "*=" | "/=" | "%="
                | "&=" | "|=" | "^=" | "<<=" | ">>=" | "<<<=" | ">>>="

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

```ebnf
expression      = or_expr

or_expr         = and_expr { "or" and_expr }
and_expr        = not_expr { "and" not_expr }
not_expr        = "not" not_expr | comparison_expr

comparison_expr = bitor_expr { compare_op bitor_expr }
compare_op      = "==" | "!=" | "<" | ">" | "<=" | ">="

bitor_expr      = bitxor_expr { "|" bitxor_expr }
bitxor_expr     = bitand_expr { "^" bitand_expr }
bitand_expr     = shift_expr { "&" shift_expr }

shift_expr      = add_expr { shift_op add_expr }
shift_op        = "<<" | ">>" | "<<<" | ">>>"

add_expr        = mul_expr { add_op mul_expr }
add_op          = "+" | "-"

mul_expr        = unary_expr { mul_op unary_expr }
mul_op          = "*" | "/" | "%"

unary_expr      = "-" unary_expr
               | "~" unary_expr
               | "&" unary_expr
               | cast_expr

cast_expr       = postfix_expr [ "as" type ]

postfix_expr    = primary_expr { postfix_op }
postfix_op      = "." identifier                    -- field access
               | "." integer_literal                -- tuple index (.0, .1, ...)
               | "." "*"                            -- dereference
               | "." type                           -- type-punned access
               | "[" expression "]"                 -- index
               | "(" [ arg_list ] ")"               -- call

primary_expr    = literal
               | identifier
               | type_identifier [ "(" [ arg_list ] ")" ]   -- constructor
               | "(" expression ")"                          -- grouping
               | "(" [ arg_list ] ")"                        -- tuple/struct literal
               | if_expr

if_expr         = "if" expression block [ elif_expr | else_expr ]
elif_expr       = "elif" expression block [ elif_expr | else_expr ]
else_expr       = "else" block

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
| 1 | `or` | left |
| 2 | `and` | left |
| 3 | `not` | prefix |
| 4 | `==` `!=` `<` `>` `<=` `>=` | left |
| 5 | `\|` | left |
| 6 | `^` | left |
| 7 | `&` | left |
| 8 | `<<` `>>` `<<<` `>>>` | left |
| 9 | `+` `-` | left |
| 10 | `*` `/` `%` | left |
| 11 | `-` `~` `&` (unary) | prefix |
| 12 | `as` | left |
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
