# Encantis for VS Code

Language support for [Encantis](https://github.com/creationix/encantis), a systems programming language that compiles to small WebAssembly modules with no runtime.

```ents
// Greatest common divisor, exported for the host to call.
export func gcd(a: u32, b: u32) -> u32 {
  while b != 0 {
    let t = b
    b = a % b
    a = t
  }
  return a
}

test "gcd" {
  assert gcd(12, 18) == 6
}
```

## Features

The extension runs the Encantis compiler itself, so what it reports is what `encantis check` and `encantis compile` would say. Nothing else needs to be installed.

- **Diagnostics** as you type: parse errors, type errors and warnings, with unused names faded. A file that imports other `.ents` files is checked with them, and an error inside an instance of a generic points back to the calls that asked for it.
- **Hover** shows the type of any name or expression, the value of a `def` or a literal, a function's signature, and for a call of a generic, the instance it calls.
- **Go to Definition**, **Find All References**, and the other uses of the name under the cursor highlighted. A name another `.ents` file exports is defined at its import, and from the import, Go to Definition opens the file at its `export`. An import's path is a link to its file.
- **Completion** of the names in scope, builtins, types and keywords, and after a `.`, of fields, `len`/`ptr`/`wid`, and the functions that can be called as methods (`v.push(x)` for `push(v, x)`), also while the line being written does not parse yet. **Signature help** shows the parameter of the argument being written.
- **Inlay hints** show the type the compiler inferred after a `let` or `for` with none written, by its name where it has one (`let path: *mut Vec(Cell) = vec(Cell, 4)`), and the parameter of a literal argument (`scale(p, by: 2)`). Turn them off with `"[encantis]": { "editor.inlayHints.enabled": "off" }`.
- **Rename** a function, type, global, constant, parameter or local, where it is declared and everywhere it is used. An exported function keeps the name the host knows it by (`export "area" func surface`). A rename is refused, with the reason, where the new name would make the program mean something else: a name it would hide or be hidden by, a keyword or a builtin.
- **Go to Symbol in Workspace** (`Ctrl+T` / `Cmd+T`): the declarations of every `.ents` file in the workspace.
- **Outline**, breadcrumbs and **Go to Symbol in Editor** (`Ctrl+Shift+O` / `Cmd+Shift+O`): the module's declarations, a struct's fields, an import's items and a test's declarations, also while one of them does not parse.
- **Semantic highlighting** of parameters, locals, globals, constants, functions and types, on top of the TextMate grammar. Encantis code blocks in Markdown are highlighted too.
- **Format Document**, the same formatter as `encantis fmt`.
- **WAT preview**: the WebAssembly text a file compiles to, beside it, updated as you type. Open it with the preview button in the editor title bar, **Encantis: Open WAT Preview to the Side** (`Ctrl+K V` / `Cmd+K V`), or **Encantis: Open WAT Preview** (`Ctrl+Shift+V` / `Cmd+Shift+V`). The status bar then shows:
  - the display mode: `raw` (the compiler's output), `flat`, or `folded`,
  - the optimization: off, `-O` or `release`, the same as `encantis wasm -O` and `encantis wasm --release`,
  - whether the file's `test` blocks are compiled in,
  - the size of the `.wasm` binary the CLI would write.

  Click an item to change it.

The extension also works in VS Code for the Web (vscode.dev, github.dev), where it reads a file's imports from the workspace as the desktop does. There the WAT preview is not optimized.

## The compiler

To build, test and run Encantis programs from the command line, get the `encantis` binary for your platform from the [latest release](https://github.com/creationix/encantis/releases/latest). The [language reference](https://github.com/creationix/encantis/blob/main/docs/encantis.md) documents the language.

## Issues

Please report problems at [github.com/creationix/encantis/issues](https://github.com/creationix/encantis/issues).
