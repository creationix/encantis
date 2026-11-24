# Syntax

How literals and declarations parse. Each `ents` block is parsed with the grammar rule named after it, and the `json ast` block after it is the AST it must produce. Run `UPDATE_SPEC=1 bun test spec` to refresh the AST blocks after an intended change.

## Number Literals

Here are some test cases for different kinds of number literals.

A decimal integer literal:

```ents Expr
42
```

```json AST
{
  "kind": "LiteralExpr",
  "value": {
    "kind": "int",
    "value": "42",
    "radix": 10
  }
}
```

Negative decimal integer literal:

```ents Expr
-17
```

```json AST
{
  "kind": "LiteralExpr",
  "value": {
    "kind": "int",
    "value": "-17",
    "radix": 10
  }
}
```

A hexadecimal integer literal:

```ents Expr
0x2a
```

```json AST
{
  "kind": "LiteralExpr",
  "value": {
    "kind": "int",
    "value": "42",
    "radix": 16
  }
}
```

A binary integer literal:

```ents Expr
0b101010
```

```json AST
{
  "kind": "LiteralExpr",
  "value": {
    "kind": "int",
    "value": "42",
    "radix": 2
  }
}
```

An octal integer literal:

```ents Expr
0o52
```

```json AST
{
  "kind": "LiteralExpr",
  "value": {
    "kind": "int",
    "value": "42",
    "radix": 8
  }
}
```

A dozenal integer literal:

```ents Expr
0d36
```

```json AST
{
  "kind": "LiteralExpr",
  "value": {
    "kind": "int",
    "value": "42",
    "radix": 12
  }
}
```

A floating point literal:

```ents Expr
3.14
```

```json AST
{
  "kind": "LiteralExpr",
  "value": {
    "kind": "float",
    "value": 3.14
  }
}
```

## String Literals

Here are some test cases for different kinds of string literals.

A simple string literal:

```ents Expr
"Hello, world!"
```

```json AST
{
  "kind": "LiteralExpr",
  "value": {
    "kind": "string",
    "bytes": "Hello, world!"
  }
}
```

A double-quoted string holds a single quote with no escape:

```ents Expr
"don't"
```

```json AST
{
  "kind": "LiteralExpr",
  "value": {
    "kind": "string",
    "bytes": "don't"
  }
}
```

An escape names a byte or a character: `\xHH` is the byte HH, `\u{H..}` the UTF-8 bytes of the character with that codepoint. `"\xE9"` is one byte, `"\u{e9}"` and `"é"` are two:

```ents Expr
"\xE9\u{e9}é\n"
```

```json AST
{
  "kind": "LiteralExpr",
  "value": {
    "kind": "string",
    "bytes": "x\"e9c3a9c3a90a\""
  }
}
```

So can test names:

```ents
test "it doesn't choke on quotes" {
  assert true
}
```

## Codepoint Literals

Single quotes hold codepoints, not a string. One codepoint is an integer literal of that value, as if the number were written there: `'a'` is 97.

```ents Expr
'a'
```

```json AST
{
  "kind": "LiteralExpr",
  "value": {
    "kind": "int",
    "value": "97",
    "radix": 10
  },
  "quoted": true
}
```

Each character is one codepoint, never a byte of its UTF-8 encoding, and so is each escape: `\n`, `\t`, `\r`, `\\`, `\'`, `\"`, `\xHH` (the codepoint HH) and `\u{H..}`. A double quote needs no escape:

```ents Expr
'é'
```

```json AST
{
  "kind": "LiteralExpr",
  "value": {
    "kind": "int",
    "value": "233",
    "radix": 10
  },
  "quoted": true
}
```

```ents Expr
'\u{1F600}'
```

```json AST
{
  "kind": "LiteralExpr",
  "value": {
    "kind": "int",
    "value": "128512",
    "radix": 10
  },
  "quoted": true
}
```

```ents Expr
'"'
```

```json AST
{
  "kind": "LiteralExpr",
  "value": {
    "kind": "int",
    "value": "34",
    "radix": 10
  },
  "quoted": true
}
```

Several codepoints are a tuple of them: `'ok'` is `(111, 107)`.

```ents Expr
'ok'
```

```json AST
{
  "kind": "TupleExpr",
  "elements": [
    {
      "kind": "Arg",
      "name": null,
      "value": {
        "kind": "LiteralExpr",
        "value": {
          "kind": "int",
          "value": "111",
          "radix": 10
        },
        "quoted": true
      }
    },
    {
      "kind": "Arg",
      "name": null,
      "value": {
        "kind": "LiteralExpr",
        "value": {
          "kind": "int",
          "value": "107",
          "radix": 10
        },
        "quoted": true
      }
    }
  ],
  "quoted": true
}
```

As a match pattern, one codepoint is its number, and several are the tuple pattern of them.

```ents Expr
match c {
  'a', '\n' => 1
  'ok' => 2
  _ => 0
}
```

```json AST
{
  "kind": "MatchExpr",
  "subject": {
    "kind": "IdentExpr",
    "name": "c"
  },
  "arms": [
    {
      "kind": "MatchArm",
      "patterns": [
        {
          "kind": "literal",
          "value": {
            "kind": "int",
            "value": "97",
            "radix": 10
          }
        },
        {
          "kind": "literal",
          "value": {
            "kind": "int",
            "value": "10",
            "radix": 10
          }
        }
      ],
      "body": {
        "kind": "LiteralExpr",
        "value": {
          "kind": "int",
          "value": "1",
          "radix": 10
        }
      }
    },
    {
      "kind": "MatchArm",
      "patterns": [
        {
          "kind": "tuple",
          "elements": [
            {
              "kind": "positional",
              "pattern": {
                "kind": "literal",
                "value": {
                  "kind": "int",
                  "value": "111",
                  "radix": 10
                }
              }
            },
            {
              "kind": "positional",
              "pattern": {
                "kind": "literal",
                "value": {
                  "kind": "int",
                  "value": "107",
                  "radix": 10
                }
              }
            }
          ],
          "quoted": true
        }
      ],
      "body": {
        "kind": "LiteralExpr",
        "value": {
          "kind": "int",
          "value": "2",
          "radix": 10
        }
      }
    },
    {
      "kind": "MatchArm",
      "patterns": [
        {
          "kind": "wildcard"
        }
      ],
      "body": {
        "kind": "LiteralExpr",
        "value": {
          "kind": "int",
          "value": "0",
          "radix": 10
        }
      }
    }
  ]
}
```

Single quotes hold at least one character:

```ents Expr
''
```

```errors
'' holds no character
```

A string's name for an import, an export or a test is double-quoted:

```ents
import 'env' 'f' func()
```

```errors
Expected
```

## Enum Declarations

Enum declarations can have multiple variants, each of which can be a unit variant, a tuple variant, or a struct variant.  Here are some test cases for enum declarations.

A unit variant is its bare name, which parses as a name (the checker finds what it names):

```ents Expr
Red
```

```json ast
{
  "kind": "IdentExpr",
  "name": "Red"
}
```

A tuple variant enum literal:

```ents Expr
RGB(255,0,0)
```

A more complex enum declaration with multiple variants:

```ents EnumDecl
enum Color {
  Red, Blue, Green,
  RGB(r: u8,g: u8,b: u8),
  Dark(c: *Color),
  Light(c: *Color),
}
```

The commas between values are completely optional.  Also the field names in the tuple variants are optional.

```ents EnumDecl
enum Color {
  Red Blue Green
  RGB(u8,u8,u8)
  Dark(*Color)
  Light(*Color)
}
```

Enum literals are the bare names for unit variants, and the name with arguments for tuple variants.

```ents Expr
[Red, Green, Dark(Blue), Light(Orange)]
```

```json ast
{
  "kind": "ArrayExpr",
  "elements": [
    {
      "kind": "IdentExpr",
      "name": "Red"
    },
    {
      "kind": "IdentExpr",
      "name": "Green"
    },
    {
      "kind": "CallExpr",
      "callee": {
        "kind": "IdentExpr",
        "name": "Dark"
      },
      "args": [
        {
          "kind": "Arg",
          "name": null,
          "value": {
            "kind": "IdentExpr",
            "name": "Blue"
          }
        }
      ]
    },
    {
      "kind": "CallExpr",
      "callee": {
        "kind": "IdentExpr",
        "name": "Light"
      },
      "args": [
        {
          "kind": "Arg",
          "name": null,
          "value": {
            "kind": "IdentExpr",
            "name": "Orange"
          }
        }
      ]
    }
  ]
}
```

These enum variants can be pattern matched using a match expression.

```ents FuncDecl
func colorToHex(color: Color) -> u32 => match color {
  Red => 0xff0000,
  Blue => 0x0000ff,
  Green => 0x00ff00,
  RGB(r,g,b) => (r as u32) << 16 | (g as u32) << 8 | (b as u32),
  Dark(c) => colorToHex(c) >> 1 & 0x7f7f7f,
  Light(c) => colorToHex(c) << 1 | 0x010101,
}
```
