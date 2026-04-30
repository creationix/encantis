# Encantis

Encantis is a programming language that compiles to WebAssembly.

## Documentation

- **[docs/grammar.md](docs/grammar.md)** - Formal grammar specification (EBNF). Source of truth for syntax.
- **[docs/encantis.md](docs/encantis.md)** - Language reference. Source of truth for semantics, type system, and behavior.

## Project Structure (Bun Monorepo)

This is a bun workspace with three packages:

- **`packages/compiler/`** - Core language implementation (`@encantis/compiler`)
  - `parser.ts` - Parser (ohm-js based, matches grammar spec)
  - `codegen.ts` - WAT code generation
  - `checker.ts` - Type checker and semantic analysis
  - `ast.ts` - AST type definitions
  - `types.ts` - Resolved type system (ResolvedType, type assignability)
  - `meta.ts` - LSP metadata (symbols, hints, hover)
  - `encantis-grammar.ohm` - Ohm grammar (bundle with `scripts/bundle-grammar.ts`)
  - `encantis-actions.ts` - Parser semantic actions (Ohm → AST)
  - `data-pack.ts` - Data section serialization
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
# Install global command (symlink to TS source, runs via bun)
sudo ln -s /Users/tim/Code/encantis/packages/cli/src/cli.ts /usr/local/bin/encantis

# Then use it
encantis compile <file.ents>              # Output WAT to stdout
encantis compile <file.ents> -o out.wat   # Output to file
encantis ast <file.ents>                  # Output AST as JSON
encantis check <file.ents>                # Check for errors
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

## Key Design Decisions

**Value types are register-flattened:** Structs, tuples, and `[N]T` fixed arrays compile to multiple wasm locals/params — no memory, no pointers. `point.x` → `(local.get $point_x)`. Nested access works: `rect.origin.x` → `(local.get $rect_origin_x)`.

**`def` vs `data`:** `def` is pure compile-time substitution (scalars only). `data` embeds literals in the wasm data section and returns a pointer. `data buf = mut [0:u8; 1024]` → `*mut [1024]u8`.

**Const-by-default pointers:** `*T` is read-only, `*mut T` is writable. Same for `[]T`/`[]mut T` and `[*]T`/`[*]mut T`. Writes through const pointers are checker errors. Mutable pointers coerce to const (widening).
