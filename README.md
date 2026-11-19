# Encantis

Encantis is a systems programming language that compiles to WebAssembly. It gives you direct control of memory and explicit types, and it compiles to small wasm modules with no runtime.

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
  assert gcd(7, 0) == 7
}
```

```sh
encantis test gcd.ents              # run the inline tests
encantis wasm gcd.ents -o gcd.wasm  # compile to a wasm binary (-O to optimize)
```

## Install

Download the archive for your platform from the [latest release](https://github.com/creationix/encantis/releases/latest), unpack it, and put `encantis` (`encantis.exe` on Windows) somewhere on your `PATH`. The binary is self-contained.

| Platform              | Archive                                |
| --------------------- | -------------------------------------- |
| Linux x64             | `encantis-<version>-linux-x64.tar.gz`    |
| Linux arm64           | `encantis-<version>-linux-arm64.tar.gz`  |
| macOS (Apple silicon) | `encantis-<version>-darwin-arm64.tar.gz` |
| macOS (Intel)         | `encantis-<version>-darwin-x64.tar.gz`   |
| Windows x64           | `encantis-<version>-windows-x64.zip`     |

Each release has a `SHA256SUMS` file to check the archives against (`shasum -a 256 -c SHA256SUMS --ignore-missing`).

The macOS binaries aren't notarized yet. If macOS refuses to open the binary, clear the quarantine flag with `xattr -d com.apple.quarantine encantis`.

### VS Code extension

Each release also has `encantis-vscode-<version>.vsix`, which adds syntax highlighting, diagnostics, hover, formatting, and a live WAT preview. Install it with `code --install-extension encantis-vscode-<version>.vsix`, or with **Extensions: Install from VSIX…** in the command palette.

## Usage

```
encantis check <file>              Parse and type-check
encantis compile <file> [-o out]   Compile to WAT text
encantis wasm <file> [-o out] [-O] Compile to a wasm binary (-O optimizes with binaryen)
encantis wasm <file> --release     Compile to the smallest wasm binary, or fail
encantis test <file>               Run inline tests
encantis run <file> [args...]      Compile and run with WASI
encantis fmt <file...>             Format source files in place
encantis --help                    All commands, including editor queries
encantis --version
```

## Size-focused builds

`--release` builds the smallest module it can:

```sh
encantis wasm app.ents --release -o app.wasm
encantis wasm app.ents --release --size -o app.wasm  # and print its sizes
```

The optimizer is [binaryen](https://github.com/WebAssembly/binaryen), built into `encantis` at a pinned version (`encantis --version` names it). The same source and the same `encantis` give the same bytes on every machine. A release build runs binaryen's `-Oz` until the module stops shrinking, tries `-O3` then `-Oz` the same way, and keeps the smallest result. It never writes a module larger than the unoptimized one.

A release build is strict: if binaryen can't load, rejects the module, or fails, `encantis` exits with status 1 and writes nothing. `-O` runs `-Oz` once, and on failure it warns and writes the unoptimized module instead. Add `--strict-opt` to make that an error too.

`--size` prints the module's size before and after optimizing, and compressed with gzip -9 and brotli. Add `--json` to get one JSON object.

```
unoptimized  3376
optimized    2242  -33.6%
gzip         1074
brotli       986
```

Fourteen examples, the browser games among them, have size budgets in [`scripts/size-budgets.json`](scripts/size-budgets.json): the most bytes each one's release build may take. `bun test` (and so CI) fails when one is over. `bun run size` prints each example's sizes next to its budget. When an example grows on purpose, `bun run size --update` sets every budget to the current size plus 2%.

## Documentation

- [Language reference](docs/encantis.md): semantics, the type system, and behavior.
- [Grammar](docs/grammar.md): the formal syntax.
- [Spec tests](spec/): how the language parses and checks, as markdown examples that run as tests.
- [lib](lib/): helpers for reading input, parsing text and printing, and generic containers (a growable array, a hash set, a hash map, a stable sort) on a bump stack, written in Encantis.
- [Examples](examples/): allocators, data structures, generic functions and types, crypto (BLAKE2b, SHA-2, Ed25519, Gimli), SIMD and WASI programs, each with inline tests.
- [Browser games](examples/browser/): Lantern, a small complete game (under 6 KB compressed with its host, page and levels; keyboard, gamepad and touch), a starter template, and the host contract they share. The Pages workflow publishes it on the repository's GitHub Pages site.

## Development

The compiler, CLI, and VS Code extension are a [Bun](https://bun.sh) workspace:

| Package               | What it is                                       |
| --------------------- | ------------------------------------------------ |
| `packages/compiler`   | Parser, type checker, and WAT code generator     |
| `packages/cli`        | The `encantis` command                           |
| `packages/extension`  | VS Code extension and language server            |

```sh
bun install
bun run cli -- check examples/data/crit-bit/crit-bit.ents  # run the CLI from source
bun test                 # unit tests, spec/*.md, and every example's inline tests
bun run examples:all     # compile every example to WAT and wasm
bun run typecheck
bun run lint
bun run ci               # all of the above, as CI runs it
```

After editing `packages/compiler/encantis-grammar.ohm`, regenerate the bundled grammar with `bun run bundle:grammar`.

### Releasing

Releases are cut from `main` by pushing a version tag:

1. Set `version` in the root `package.json` (for example `0.2.0`) and merge that to `main`.
2. Tag the commit and push the tag: `git tag v0.2.0 && git push origin v0.2.0`. Or run the **Release** workflow by hand on `main` from the Actions tab (`gh workflow run release.yml`), which releases the `package.json` version and creates the tag.

The [release workflow](.github/workflows/release.yml) checks that the tag matches `package.json`, builds the binaries and the `.vsix`, smoke-tests each binary on its own OS, and publishes a GitHub release with the checksums. To build the same artifacts locally, run `bun scripts/build-release.ts` (they go in `release/`).

## License

Licensed under either of the [MIT license](LICENSE-MIT) or the [Apache License, Version 2.0](LICENSE-APACHE), at your option.

Unless you explicitly state otherwise, any contribution you intentionally submit for inclusion in this work, as defined in the Apache-2.0 license, is dual-licensed as above, without any additional terms or conditions.
