# Encantis

Encantis is a programming language that compiles to WebAssembly.

## Documentation

- **[docs/grammar.md](docs/grammar.md)** - Formal grammar specification (EBNF). Source of truth for syntax.
- **[docs/encantis.md](docs/encantis.md)** - Language reference. Source of truth for semantics, type system, and behavior.

## Project Structure (Bun Monorepo)

This is a bun workspace with three packages:

- **`packages/compiler/`** - Core language implementation (`@encantis/compiler`)
  - `src/parser.ts` - Parser (ohm-js based, matches grammar spec)
  - `src/codegen.ts` - WAT code generation
  - `src/checker.ts` - Type checker and semantic analysis
  - `src/ast.ts` - AST type definitions
  - `src/grammar/` - Grammar definitions
  - Exported as library with named exports: `parser`, `checker`, `codegen`, `ast`

- **`packages/cli/`** - Command-line interface (`@encantis/cli`)
  - `src/cli.ts` - CLI entry point
  - Depends on `@encantis/compiler` via workspace

- **`packages/extension/`** - VS Code extension (`encantis-vscode-ext`)
  - Dual-mode: Node.js desktop + WebWorker browser support
  - LSP server with diagnostics, hover, and language features
  - Depends on `@encantis/compiler` via workspace

- **`examples/`** - Example programs
- **`docs/`** - Language documentation

## Setup

```bash
bun install              # Install dependencies and link workspace packages
```

## CLI Usage

```bash
# Build the CLI first
bun run build:cli

# Then use it
bun packages/cli/dist/cli.js compile <file.ents>              # Output WAT to stdout
bun packages/cli/dist/cli.js compile <file.ents> -o out.wat   # Output to file
bun packages/cli/dist/cli.js ast <file.ents>                  # Output AST as JSON
bun packages/cli/dist/cli.js check <file.ents>                # Check for errors
```

## Build Commands

```bash
bun run build:cli        # Build CLI package
bun run build:ext        # Build extension (Node.js mode)
bun run build:ext-web    # Build extension (WebWorker mode)
bun run watch:ext        # Watch extension (Node.js)
bun run watch:ext-web    # Watch extension (WebWorker)
bun test                 # Run tests
```

## Compiler Status

**Working:**
- Parser (`packages/compiler/src/parser.ts`) - fully matches grammar spec
- Type checker - basic semantic analysis
- WAT codegen for examples:
  - Imports, exports, functions
  - Struct/tuple types (flattened to multiple wasm values, NOT memory pointers)
  - Named returns, MemberExpr, StructPattern destructuring
  - Binary operations with type inference
  - Folded S-expression WAT output

**Note:** Compiler has some pre-existing TypeScript type errors that need resolution.

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
