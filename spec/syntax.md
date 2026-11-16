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

Each kind of quote can hold the other one, with no escape:

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

```ents Expr
'say "hi"'
```

```json AST
{
  "kind": "LiteralExpr",
  "value": {
    "kind": "string",
    "bytes": "say \"hi\""
  }
}
```

So can test names:

```ents
test "it doesn't choke on quotes" {
  assert true
}
```

## Enum Declarations

Enum declarations can have multiple variants, each of which can be a unit variant, a tuple variant, or a struct variant.  Here are some test cases for enum declarations.

A simple enum literal. Bare unit variants don't parse as expressions yet (enums are design-only), so for now this records the error:

```ents Expr
Red
```

```errors
Expected "("
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

```errors
Expected "("
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
