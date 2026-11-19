# Changelog

## 0.3.0

The first release on the Marketplace since 0.0.4, which had syntax highlighting only. The extension now runs the Encantis compiler in a language server:

- Diagnostics as you type, for a file and the `.ents` files it imports
- Hover with types, values and signatures; Go to Definition; Find All References
- Semantic highlighting
- Format Document (the formatter of `encantis fmt`)
- A live WAT preview, raw, flat or folded, optionally optimized as `encantis wasm -O` or `--release` optimize it, with the size of the binary
- Support for VS Code for the Web

Syntax highlighting follows the current language: `defer`, `host` types, `??`, `..`, `~`, optional types, `i512`/`u512`, and the `memzero` and `mul_hi` builtins. `input` and `output` are no longer colored as keywords.

Fixed since the 0.2.1 `.vsix` attached to the GitHub release: optimizing the WAT preview failed outside the machine that built the extension, and the WAT preview in VS Code for the Web was a placeholder.
