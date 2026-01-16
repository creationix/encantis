# Encantis

Encantis is a programming language that compiles to WebAssembly.

## Documentation

- **[docs/grammar.md](docs/grammar.md)** - Formal grammar specification (EBNF). Source of truth for syntax.
- **[docs/encantis.md](docs/encantis.md)** - Language reference. Source of truth for semantics, type system, and behavior.

## Project Structure

- `tools/` - Compiler toolchain (lexer, parser, checker, codegen)
  - `parser2.ts` - Active parser (matches grammar spec)
  - `compile.ts` - Compiler entry point and WAT codegen
  - `checker.ts` - Semantic analysis
  - `cli.ts` - CLI interface
- `encantis-ext/` - VS Code extension (syntax highlighting only; LSP disabled pending parser update)
- `examples/` - Example programs
- `docs/` - Language documentation

## CLI Usage

```bash
bun run tools/cli.ts compile <file.ents>           # Output WAT to stdout
bun run tools/cli.ts compile <file.ents> -o out.wat  # Output to file
bun run tools/cli.ts ast <file.ents>               # Output AST as JSON
bun run tools/cli.ts check <file.ents>             # Check for errors
```

## Building Examples

```bash
cd examples
make ast    # Parse all .ents to .ast (JSON)
make wat    # Compile all .ents to .wat
make wasm   # Compile all .wat to .wasm (requires wat2wasm)
make all    # Run all three
```

## Compiler Status

**Working:**
- Parser (parser2.ts) - fully matches grammar spec
- Type checker - basic semantic analysis
- WAT codegen for `examples/math/trig/trig.ents`:
  - Imports, exports, functions
  - Struct/tuple types (flattened to multiple wasm values, NOT memory pointers)
  - Named returns, MemberExpr, StructPattern destructuring
  - Binary operations with type inference
  - Folded S-expression WAT output

**Pending codegen features:**
- IndexExpr (array access)
- LoopStmt, WhileStmt, ForStmt
- MatchExpr
- CastExpr
- GroupExpr passthrough

## Key Design Decision: Struct/Tuple Semantics

Structs and tuples are passed **by-value as multiple wasm values**, NOT as memory pointers:

```encantis
func to_polar(point: CartesianPoint) -> (out: PolarPoint)
```

Compiles to:
```wat
(func $to_polar (param $point_x f64) (param $point_y f64) (result f64 f64)
  (local $out_d f64)
  (local $out_a f64)
  ...
)
```

- `point.x` becomes `(local.get $point_x)` - simple local access, no memory loads
- Struct fields are flattened with underscore: `point` → `$point_x`, `$point_y`
