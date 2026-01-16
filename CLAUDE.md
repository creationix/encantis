# Encantis

Encantis is a programming language that compiles to WebAssembly.

## Documentation

- **[docs/grammar.md](docs/grammar.md)** - Formal grammar specification (EBNF). Source of truth for syntax.
- **[docs/encantis.md](docs/encantis.md)** - Language reference. Source of truth for semantics, type system, and behavior.

## Project Structure

- `tools/` - Compiler toolchain (lexer, parser, checker, codegen)
- `encantis-ext/` - VS Code extension (syntax highlighting only; LSP disabled pending parser update)
- `examples/` - Example programs
- `docs/` - Language documentation

## Current Status

The LSP and compiler are being updated to match the grammar spec. The VS Code extension currently provides syntax highlighting only. Example files follow the grammar spec and may not parse with the old toolchain.
