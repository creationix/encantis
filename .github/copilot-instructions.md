# Encantis Project Instructions

## Project Overview

Encantis is a programming language that compiles to WebAssembly. This is a **Bun monorepo** with workspace-based architecture.

## Workspace Structure

- `packages/compiler/` - Core language implementation (@encantis/compiler)
- `packages/cli/` - Command-line interface (@encantis/cli)
- `packages/extension/` - VS Code extension (encantis-vscode-ext)
- `examples/` - Example .ents programs
- `docs/` - Language documentation (grammar.md, encantis.md)

## Technology Stack

- **Runtime**: Bun (primary build system and runtime)
- **Language**: TypeScript
- **Parser**: ohm-js (grammar-based parser generator)
- **Packaging**: Bun workspaces with `workspace:*` dependencies
- **Linter/Formatter**: Biome

## Coding Standards

### TypeScript
- Use ES modules (`import`/`export`)
- Prefer `type` over `interface` for type definitions
- Use explicit return types for public functions
- Avoid `any`, use `unknown` when type is truly unknown

### Import Paths
- Within monorepo, use workspace package names:
  ```typescript
  import { parser } from '@encantis/compiler/parser'
  import { checker } from '@encantis/compiler/checker'
  ```
- Never use relative paths like `../../tools/` (tools no longer exists)

### File Organization
- Compiler source: `packages/compiler/src/`
- CLI source: `packages/cli/src/`
- Extension source: `packages/extension/src/`

### Build Commands
- Use `bun run build:cli`, `bun run build:ext`, etc. (see package.json scripts)
- Never reference `packages/cli/dist/cli.js` in source code (only for runtime)
- Build outputs to `dist/` or `out/` directories (gitignored)

## Critical Design Decisions

### Struct/Tuple Semantics
**This is fundamental to the language:**

Structs and tuples are passed **by-value as multiple WebAssembly values**, NOT as memory pointers.

Example:
```encantis
func to_polar(point: CartesianPoint) -> (out: PolarPoint)
```

Compiles to WAT with flattened parameters:
```wat
(func $to_polar (param $point_x f64) (param $point_y f64) (result f64 f64)
```

When generating code or explaining semantics:
- Struct fields become multiple locals/params with underscore: `point.x` → `$point_x`
- No memory loads/stores for struct access
- Direct local.get operations only

## Documentation

### Sources of Truth
1. **Grammar**: `packages/compiler/src/grammar/encantis.ohm` (Ohm grammar - actual source of truth)
2. **Semantics**: `docs/encantis.md` (language reference)
3. **Grammar Docs**: `docs/grammar.md` (EBNF documentation - outdated, reference only)
4. **Implementation**: Parser uses encantis.ohm directly

### When Adding Features
1. Update `packages/compiler/src/grammar/encantis.ohm` with Ohm grammar rule
2. Update semantic actions (`packages/compiler/src/grammar/actions.ts`)
3. Update AST types (`packages/compiler/src/ast.ts`)
4. Update codegen (`packages/compiler/src/codegen.ts`)
5. (Optional) Update `docs/grammar.md` if maintaining EBNF documentation

## Common Issues to Avoid

❌ **Don't** use old paths like `tools/`, `ext/` - they were migrated to `packages/`
❌ **Don't** create scripts in `/scripts/` - they were removed (broken dependencies)
❌ **Don't** use `npm` or `yarn` - this project uses Bun exclusively
❌ **Don't** build with `tsc` in compiler package - it has known type errors
❌ **Don't** treat structs as memory pointers in codegen

✅ **Do** use workspace imports (`@encantis/compiler`)
✅ **Do** use bun commands (`bun run`, `bun test`)
✅ **Do** follow `encantis.ohm` grammar exactly when parsing
✅ **Do** flatten structs to multiple values in WAT output
✅ **Do** read `packages/compiler/src/grammar/encantis.ohm` for syntax and `docs/encantis.md` for semantics

## Testing

- Run tests with `bun test`
- Test CLI with example .ents files: `bun packages/cli/dist/cli.js compile examples/math/trig/trig.ents`
- Verify WAT output manually or compile to WASM

## Known Limitations

- Compiler package has pre-existing TypeScript type errors (doesn't block CLI/extension usage)
- Some codegen features pending: IndexExpr, loops, MatchExpr, CastExpr
- Extension LSP features may be incomplete

## When In Doubt

1. Check `.github/skills/encantis-compiler/SKILL.md` for detailed context
2. Reference `packages/compiler/src/grammar/encantis.ohm` for syntax questions
3. Reference `docs/encantis.md` for semantic questions
4. Look at existing examples in `examples/` directory
5. Note: `docs/grammar.md` is outdated EBNF documentation, use encantis.ohm instead
