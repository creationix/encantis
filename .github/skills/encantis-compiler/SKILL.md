# Encantis Compiler Skill

This skill provides context for working with the Encantis programming language compiler and toolchain.

## What is Encantis?

Encantis is a programming language that compiles to WebAssembly. It features a strong type system, struct/tuple types, and direct compilation to WAT (WebAssembly Text Format).

## Project Structure

This is a **Bun monorepo** with three packages:

### `packages/compiler/` (@encantis/compiler)
Core language implementation exported as a library:
- `src/parser.ts` - Parser (ohm-js based, matches grammar spec in docs/grammar.md)
- `src/codegen.ts` - WAT code generation
- `src/checker.ts` - Type checker and semantic analysis
- `src/ast.ts` - AST type definitions
- `src/grammar/` - Grammar definitions (encantis.ohm, actions.ts)

**Exports:** `parser`, `checker`, `codegen`, `ast` as named exports

### `packages/cli/` (@encantis/cli)
Command-line interface:
- `src/cli.ts` - CLI entry point (compile, ast, check commands)
- Depends on `@encantis/compiler` via workspace

### `packages/extension/` (encantis-vscode-ext)
VS Code extension with dual-mode support:
- Node.js desktop mode + WebWorker browser mode
- LSP server with diagnostics and hover
- Depends on `@encantis/compiler` via workspace

### Other Directories
- `examples/` - Example .ents programs with .ast.json, .wat, .wasm outputs
- `docs/` - Language documentation (grammar.md is EBNF spec, encantis.md is language reference)

## Build Commands

```bash
# Install dependencies and link workspaces
bun install

# Build individual packages
bun run build:cli          # Build CLI to packages/cli/dist/cli.js
bun run build:ext          # Build extension (Node.js mode)
bun run build:ext-web      # Build extension (WebWorker mode)

# Watch modes
bun run watch:ext          # Watch extension (Node.js)
bun run watch:ext-web      # Watch extension (WebWorker)

# Run tests
bun test

# Use CLI (after building)
bun packages/cli/dist/cli.js compile <file.ents>              # WAT to stdout
bun packages/cli/dist/cli.js compile <file.ents> -o out.wat   # WAT to file
bun packages/cli/dist/cli.js ast <file.ents>                  # AST as JSON
bun packages/cli/dist/cli.js check <file.ents>                # Type check
```

## Key Design Decisions

### Struct/Tuple Semantics
**Critical:** Structs and tuples are passed **by-value as multiple WebAssembly values**, NOT as memory pointers.

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

- `point.x` becomes `(local.get $point_x)` - direct local access
- Struct fields are flattened with underscore: `point` → `$point_x`, `$point_y`
- No memory loads/stores for struct access

### Import Paths
When working with the compiler packages, use workspace imports:
```typescript
import { parser } from '@encantis/compiler/parser'
import { checker } from '@encantis/compiler/checker'
import { codegen } from '@encantis/compiler/codegen'
import * as AST from '@encantis/compiler/ast'
```

## Compiler Status

### Working Features
- ✅ Parser fully matches grammar spec (docs/grammar.md)
- ✅ Type checker with basic semantic analysis
- ✅ WAT codegen for:
  - Imports, exports, functions
  - Struct/tuple types (flattened)
  - Named returns
  - MemberExpr, StructPattern destructuring
  - Binary operations with type inference
  - Folded S-expression WAT output

### Known Issues
- ⚠️ Compiler has pre-existing TypeScript type errors (not blockers for CLI/extension usage)
- ⚠️ Compiler package doesn't build with `tsc` due to type errors

### Pending Codegen Features
- IndexExpr (array access)
- LoopStmt, WhileStmt, ForStmt
- MatchExpr
- CastExpr
- GroupExpr passthrough

## Documentation Sources

**Source of Truth:**
1. `packages/compiler/src/grammar/encantis.ohm` - Ohm grammar specification (actual source of truth for syntax)
2. `docs/encantis.md` - Language reference for semantics, type system, behavior
3. `docs/grammar.md` - EBNF documentation (outdated, reference only)

**Implementation:**
- Parser uses `encantis.ohm` as the definitive grammar
- Semantic actions in `packages/compiler/src/grammar/actions.ts` build AST from Ohm parse tree
- Type checker implements semantics from encantis.md
- Code generator produces WAT according to design decisions

## Common Tasks

### Adding Parser Features
1. Update `packages/compiler/src/grammar/encantis.ohm` with ohm-js grammar rule
2. Update `packages/compiler/src/grammar/actions.ts` with semantic actions
3. Update `packages/compiler/src/ast.ts` with AST node types
4. (Optional) Update `docs/grammar.md` if maintaining EBNF documentation
5. Test with example .ents file

### Adding Codegen Features
1. Implement in `packages/compiler/src/codegen.ts`
2. Handle AST node type in appropriate visitor method
3. Generate folded S-expression WAT
4. Test compilation with CLI: `bun packages/cli/dist/cli.js compile test.ents`

### Testing Changes
1. Create/update .ents file in `examples/`
2. Run CLI to generate .ast.json and .wat
3. Verify WAT output is correct
4. Optional: Convert to .wasm and test execution

## Workspace Dependencies

Uses bun workspaces with `workspace:*` protocol:
- CLI depends on compiler
- Extension depends on compiler
- Root `package.json` declares workspaces array
- `bunfig.toml` configures workspace behavior

All dependencies are resolved locally during `bun install`.
