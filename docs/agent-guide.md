# Agent Developer Guide

Best practices for LLM agents developing Encantis code. This guide assumes you have access to the `encantis` CLI and are working on a multi-file project like the crypto challenge.

## Core workflow: edit → check → iterate

Run `encantis check` after every edit. Don't wait until you've written a whole file — check after every function, every type declaration, every significant change. The checker catches errors that are expensive to debug later.

```bash
encantis check src/sha512.ents          # single file
encantis check src/main.ents            # resolves imports across modules
encantis check src/main.ents --json     # structured output for parsing
```

The `--json` flag returns structured diagnostics you can parse programmatically:
```json
[{"file":"src/sha512.ents","line":42,"col":10,"message":"unknown identifier 'rotr' — did you mean 'rotl'?"}]
```

On success:
```json
{"ok":true,"modules":3,"declarations":28}
```

## Querying symbols: use name, not column

All query commands accept `file:line:name` — you don't need to count columns:

```bash
encantis hover src/sha512.ents:12:compress     # hover info for 'compress' on line 12
encantis definition src/sha512.ents:45:round   # jump to where 'round' is defined
encantis references src/sha512.ents:8:K        # find all uses of constant K
encantis signature src/sha512.ents:12:compress # show parameter types
encantis symbols src/sha512.ents               # list all declarations in file
encantis symbols src/                          # find symbols across all files in directory
```

If the same name appears multiple times on a line, the first occurrence is used. You can still use `file:line:col` (1-indexed) when you need precision.

## Rename refactoring

```bash
encantis rename src/sha512.ents:12:compress         # list all locations
encantis rename src/sha512.ents:12:compress --json   # structured for automated edits
```

Returns every location (definition + all references) so you can do a precise rename without regex search-and-replace.

Each parameter, local, loop variable and `if let` binding is its own name, found from where it is defined and from each use: two loops that both use `i`, and a parameter named like a global, are renamed apart. A parameter that is also a named result (`acc` in `func round(acc: u64, v: u64) -> (acc: u64)`) is one name with that result, and a `data` or `def` a test declares is that test's own.

A struct's field is renamed too, from where its struct declares it (a `type`, a generic type, a function's named results) or from any place that names it: `p.x`, `p.x = v`, `Pt(x: 1)`, a literal given for `Pt`, `let (x: a) = p`. Rename lists the declaration and the places where a value of *that* struct names the field. Another struct with the same fields is another struct: where a value of one is given to the other, renaming the field of one leaves the program unchecked, so check after renaming. A named result is a field of what its function returns, so its rename also lists the places that take the result apart (`pair(n).count`, `let (count:) = pair(n)`).

With `--json`, those places are marked `"field": true`. At such a place a shorthand `x:` (followed by `,` or `)`) stands for the field and a variable of its name: write it out as `left: x`, so that the variable keeps its name. From a shorthand itself, rename renames the variable; then write `x: left`. A field of a struct another module declares is refused: rename it in that module, and in each module that names it. On a field's name `definition` and `references` find nothing, and `hover` after a point shows the member's type.

## Queries inside generics

A generic's body is checked once per instance, so `hover` there answers for each instance the program makes (reference 8.4):

```text
$ encantis hover lib.ents:4:42          # x in func index_of(comptime T: type, xs: []T, x: T) -> u32
local x: T — in index_of(T = u32): u32; in index_of(T = f64): f64
$ encantis hover lib.ents:6:eq          # return i when eq(y, x)
func eq: func(a: u32, b: u32) -> bool — in index_of(T = u32): eq(a: u32, b: u32) -> bool; in index_of(T = f64): eq(a: f64, b: f64) -> bool
$ encantis hover lib.ents:12:45         # index_of(fs, 2.0)
generic index_of: func(xs: []f64, x: f64) -> u32 — calls index_of(T = f64)
```

The type before the dash is the declared one (in terms of the type parameters); after it come the instances, those that agree listed together, the first twelve. A method call adds the call it is (`v.push(7)` — `push(v, 7)`), a generic its instances, a generic type its applications. `--json` gives the same as fields: `calls`, `as`, `instances: [{ in: [...], type }]` and `more` (instances not listed). `definition` from a call in a generic's body goes to what the first instance calls; `references` from one of several functions of a name lists the calls in generic bodies that an instance makes of it.

## Compiling and testing

```bash
encantis compile src/main.ents             # emit WAT to stdout (inspect the output)
encantis wasm src/main.ents                # emit .wasm binary (auto-names output)
encantis wasm src/main.ents -o out.wasm    # emit to specific path
bun test                                   # run all tests
bun run ci                                 # build all examples + run tests
```

If `encantis wasm` fails, the error often comes from wabt validation. These errors reference WAT line numbers, not Encantis source lines. To debug: run `encantis compile` to see the WAT, then look at the failing line.

## Formatting

```bash
encantis fmt src/sha512.ents          # format in place
encantis fmt --check src/sha512.ents  # check without modifying (for CI)
```

The formatter normalizes indentation and collapses multiple blank lines, and leaves the text of every literal as written (a string or a template that goes on over lines keeps its spaces and blank lines). This keeps line numbers stable and predictable — important for your line-based queries.

## Memory reservation pattern

Static buffers are the most common pattern. Declare them with `def`:

```encantis
def state:[8]u64              // 64 bytes, zeroed, mutable
def block:[128]u8             // 128 bytes, zeroed, mutable
def constants:*[80]u64 = [    // read-only, initialized with values
  0x428a2f98d728ae22:u64,
  // ...
]
```

`def name:[N]T` reserves N×sizeof(T) zero bytes. The result type is `*[N]T` (pointer to array) with compile-time `.ptr` and `.len`. It coerces automatically:

- Pass to `func(data: []u8)` → coerces to slice (ptr + len)
- Pass to `func(data: *[N]u8)` → coerces to pointer
- Index with `state[i]` → loads element at offset

## Module imports

Split code across files. The first string in an import that starts with `./` or `../` is a source import — the compiler links it into one wasm module:

```encantis
import "./sha512" "sha512" func sha512(input: []u8) -> [64]u8
import "./sha512" (
  "sha512" func sha512(input: []u8) -> [64]u8
  "sha512_init" func sha512_init(state: *Sha512State)
)
```

## Recommended development sequence

1. **Define types first.** Write your struct/type declarations, run `check`.
2. **Stub functions.** Write signatures with placeholder bodies (`=> 0`), run `check`.
3. **Implement one function at a time.** Write the body, run `check` immediately.
4. **Use `hover` to verify types.** If an expression has a surprising type, hover it.
5. **Use `symbols`** to see what's exported and available for import.
6. **Compile to WAT** to inspect the generated code when debugging.
7. **Write tests early.** The test harness compiles .ents → .wasm → runs it. Fast feedback.

## Common mistakes

- **Forgetting `export "mem" memory`** — if your wasm needs host-accessible memory, export it.
- **Mixed-width arithmetic** — `u32 * u64` widens to u64. If you need u32 result, cast explicitly.
- **Array vs pointer** — `def buf:[N]T` allocates memory. `def ptr:*[N]T = expr` stores a pointer. Different things.
- **Named returns** — `func foo() -> (result: u32) { result = 42 }` — `result` is a local you assign to. Bare `return` pushes it automatically.
- **Lifting a helper or writing a lambda** — there are no lambdas, but a function declared in a body shares the variables of the function around it: `func keep(x: u32) -> bool => x > n` then `xs.count_if(keep)`. It costs what the lifted helper with extra parameters would, so no need to pass `n` by hand or move it to a global.

## Tools reference

| Command | Purpose |
|---------|---------|
| `check <file> [--json]` | Parse + typecheck (resolves imports) |
| `compile <file> [-o out]` | Emit WAT |
| `wasm <file> [-o out]` | Emit WASM binary |
| `hover <file>:<line>:<name>` | Show type info |
| `definition <file>:<line>:<name>` | Go to definition |
| `references <file>:<line>:<name>` | Find all usages |
| `rename <file>:<line>:<name>` | All locations for rename |
| `symbols <file\|dir>` | List declarations |
| `signature <file>:<line>:<name>` | Function signature |
| `fmt <files...> [--check]` | Auto-format |
| `ast <file> [-o out]` | Dump AST as JSON |
| `lsp` | Language server on stdin and stdout (for an editor or an agent's LSP client) |

All query commands support `--json` for structured output.
