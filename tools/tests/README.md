# Analyser Test Vectors

Test vectors for the semantic analyser (checker). Each test is a `.ents` source file paired with a `.meta.json` file containing expected analysis output.

## File Format

- `name.ents` - Encantis source code
- `name.meta.json` - Expected types, symbols, hints, and data sections
- `name.ast.json` - (optional) AST output for reference

See [meta-schema.json](meta-schema.json) for the full schema.

## Running Tests

```bash
bun test tools/tests/analyser.test.ts
```

## Test Coverage Goals

### Data Section

- String literals and interning
- Escape sequences (`\n`, `\t`, `\x00`, etc.)
- Hex strings (`x"deadbeef"`)
- Null terminators and deduplication
- Overlapping string suffixes
- Explicit memory offsets
- Tuples/arrays with embedded data

### Type Inference

- **Literals**: int (decimal, hex, binary), float, bool, string
- **Typed literals**: `42:i64`, `3.14:f32`
- **Variables**: let with/without type annotation, inference from initializer
- **Functions**: signatures, params, returns, multi-return
- **Imports**: imported functions and globals
- **Type aliases**: `type Point = (x: f32, y: f32)`
- **Unique types**: `unique Index = i32`
- **Expressions**: binary ops, unary ops, calls, member access
- **Comptime types**: `comptime_int(N)`, `comptime_float(N)`, `comptime_string(len)`

### Symbols

- Definition positions
- Reference tracking (for rename/find-references)
- Symbol kinds: func, type, unique, global, local, param, def
- Doc comments from preceding `//` or `/* */`

### Hints

- Type information for hover
- Symbol links for go-to-definition
- Data section references for literals

### Errors

- Type mismatches
- Undefined identifiers
- Invalid coercions
