# Spec tests

Markdown files that pin down how Encantis behaves, written as prose with examples. `bun test` runs every `*.md` here through `spec.test.ts`. The format doesn't depend on the TypeScript compiler, so another implementation (a Rust port, say) can run the same files.

## Format

Each fenced `ents` block is a test case. The text after the opening fence names the grammar rule to start parsing from (`Expr`, `FuncDecl`, ...); with no rule, the block is a whole module, which is also type-checked.

The blocks after an `ents` block, up to the next one, say what to expect:

- ` ```json ast ` : the AST the source must parse to, without source positions (`span`).
- ` ```errors ` : one line per expected parse or check error, in order. Each line only has to appear somewhere in the error's message.
- ` ```ents same-wasm ` : a second module that the source must compile to the same `.wasm` file as, byte for byte. This is how "costs nothing" is stated: a generic program next to the same program written out by hand.

With no `errors` block, the source must parse (and, for a module, check) without errors. Headings group cases; everything else is prose.

````md
A decimal integer literal:

```ents Expr
42
```

```json ast
{ "kind": "LiteralExpr", "value": { "kind": "int", "value": "42", "radix": 10 } }
```
````

## The language reference

The examples of [`docs/encantis.md`](../docs/encantis.md) that stand between a `<!-- spec:begin -->` line and the next `<!-- spec:end -->` line are run by the same rules, so a chapter written that way is its own test and needs no second copy here. A region opened with `<!-- spec:begin compile -->` asks for more: every module in it that is expected to check, and doesn't import another source file, is also compiled and validated as WebAssembly, and the `test` blocks it has are run. Examples outside a region are not run.

A spec file here can mark a compile region the same way (`generics.md` is one from top to bottom); its blocks outside a region are run as usual, without compiling.

A marker is a comment, which shows nowhere when it is wrong. So the runner fails on a comment that starts with `spec` and is not one of `<!-- spec:begin -->`, `<!-- spec:begin compile -->` and `<!-- spec:end -->`, and on a begin or an end without its partner.

## Updating

After a change that's meant to alter the AST, regenerate the `json ast` blocks and review the diff:

```sh
UPDATE_SPEC=1 bun test spec
```

## Files

- `syntax.md`: literals, enums and match, by grammar rule.
- `checks.md`: programs the checker accepts or rejects, among them functions that share a name.
- `generics.md`: generic functions, generic types, comptime function parameters, method calls and the calls a generic's body makes: how they parse, what is accepted, and the error for everything that is not.

The format comes from an earlier parser experiment, kept in [`experiments/hand-written-compiler`](../experiments/hand-written-compiler).
