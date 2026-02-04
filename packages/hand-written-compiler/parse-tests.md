# Parser Tests

Each code block in this file is a separate test case for the parser.  The code block is written in encantis with an optional start state for the parser.  Zero or more expected output blocks can follow the code block.  Each expected output block is labeled with the name of the output to compare against (e.g. `ast`, `types`, etc) and contains the expected output in JSON format.

## Enum Declarations

Enum declarations can have multiple variants, each of which can be a unit variant, a tuple variant, or a struct variant.  Here are some test cases for enum declarations.

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
// A slice of colors
[Red, Green, Dark(Blue), Light(Orange)]:[Color]
```

These enum variants can be pattern matched using a match expression.

```ents Expr
func colorToHex(color: Color) -> u32 => match color {
  Red => 0xff0000,
  Blue => 0x0000ff,
  Green => 0x00ff00,
  RGB(r,g,b) => (r as u32) << 16 | (g as u32) << 8 | (b as u32),
  Dark(c) => colorToHex(c) >> 1 & 0x7f7f7f,
  Light(c) => colorToHex(c) << 1 | 0x010101,
}
```
