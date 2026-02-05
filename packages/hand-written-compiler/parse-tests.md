# Parser Tests

Each code block in this file is a separate test case for the parser.  The code block is written in encantis with an optional start state for the parser.  Zero or more expected output blocks can follow the code block.  Each expected output block is labeled with the name of the output to compare against (e.g. `ast`, `types`, etc) and contains the expected output in JSON format.

## Number Literals

Here are some test cases for different kinds of number literals.

A decimal integer literal:

```ents Expr
42
```

```json AST
{
  "type": "IntLiteral",
  "base": 10,
  "value": 42
}
```

Negative decimal integer literal:

```ents Expr
-17
```

```json AST
{
  "type": "IntLiteral",
  "base": 10,
  "value": -17
}
```

A hexadecimal integer literal:

```ents Expr
0x2a
```

```json AST
{
  "type": "IntLiteral",
  "base": 16,
  "value": 42
}
```

A binary integer literal:

```ents Expr
0b101010
```

```json AST
{
  "type": "IntLiteral",
  "base": 2,
  "value": 42
}
```

An octal integer literal:

```ents Expr
0o52
```

```json AST
{
  "type": "IntLiteral",
  "base": 8,
  "value": 42
}
```

A dozenal integer literal:

```ents Expr
0d36
```

```json AST
{
  "type": "IntLiteral",
  "base": 12,
  "value": 42
}
```

A floating point literal:

```ents Expr
3.14
```

```json AST
{
  "type": "FloatLiteral",
  "value": 3.14
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
  "type": "StringLiteral",
  "value": "Hello, world!"
}
```

## Enum Declarations

Enum declarations can have multiple variants, each of which can be a unit variant, a tuple variant, or a struct variant.  Here are some test cases for enum declarations.

A simple enum literal:

```ents Expr
Red
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
  Dark(c: &Color),
  Light(c: &Color),
}
```

The commas between values are completely optional.  Also the field names in the tuple variants are optional.

```ents EnumDecl
enum Color {
  Red Blue Green
  RGB(u8,u8,u8)
  Dark(&Color)
  Light(&Color)
}
```

Enum literals are the bare names for unit variants, and the name with arguments for tuple variants.

```ents Expr
[Red, Green, Dark(Blue), Light(Orange)]
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
