# Changelog

## 0.4.0

- Rename a struct's field or a function's named result: where it is declared and wherever it is named (`p.x`, constructors, literals and patterns), a shorthand written out so its variable keeps its name. Refused where a value is given to another struct with the same fields, or where another file of the workspace would no longer check. Rename is no longer offered on the keyword a test's `data` starts with.
- Go to Symbol in Workspace (Ctrl+T) over the workspace's `.ents` files.
- Brackets and prefixes nest at most 128 deep, as the compiler now allows (it was 256, which the parser's stack did not always hold).
- Inlay hints: the inferred type of a `let` or `for` binding with none written, and the parameter name of a literal argument.
- Completion no longer offers a local of a block that has closed; after a `.` it offers `.*` on a pointer, the type puns (`.u32`, …) of a pointer, slice or array, and a tuple's unnamed fields (`.0`); a local just given a generic's result (`let v = vec(Cell, 4)`) has its fields and methods; and a struct's methods are no longer offered for another struct whose fields have the same names.
- The other uses of the name under the cursor are highlighted, its declaration and assignments as writes.
- A backtick closes itself and surrounds a selection, as a template string's quotes; `<` and `>` no longer do. Toggle Line Comment works in VS Code versions before 1.96.

## 0.3.1

- The WAT preview compiles again once typing stops for a moment, not on every keystroke: with a large program and `--release`, each key held VS Code up for up to a second.
- The preview's status bar is shown while a preview is visible, with the size of the one in front, and no longer stays after the preview is closed.
- A preview of a file with `#` or `?` in its name opens.
- Go to Definition on an import of another `.ents` file opens that file at its `export`, and the import's path is a link to the file.
- Completion: names in scope, builtins, types and keywords, and after a `.` fields and methods, also in a line that does not parse yet. Signature help.
- Rename, checked: a rename that would change what the program means is refused, with the reason. An exported function keeps its export name.
- Outline, breadcrumbs and Go to Symbol in Editor.
- VS Code for the Web reads a file's imports from the workspace, instead of checking each file on its own.

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
