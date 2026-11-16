# Hand-written compiler experiment (paused)

A restart of the parser from February 2026, kept for reference. It isn't part of the workspace, CI doesn't build it, and nothing depends on it.

- `encantis-grammar.ohm`: a rewrite of the grammar.
- `encantis-actions.ts`: semantic actions for part of it (literals so far).
- `parse-tests.md`: parser cases in a markdown format, with the AST this design was aiming for. Most of those ASTs don't match what the actions produce yet.
- `test-grammar.ts`: the runner for that file (`bun test-grammar.ts`).

The markdown format lives on in [`spec/`](../../spec), where it runs against the real compiler as part of `bun test`.
