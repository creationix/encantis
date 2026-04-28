# Crypto Challenge Prep Work

Work that needs to land in this repo before we hand [the challenge](crypto-challenge.md) to coding agents. Scoped to compiler/toolchain/docs — the agent-facing seed repo is a separate deliverable.

Sections are in rough dependency order. Each has a one-paragraph rationale, concrete subtasks, and exit criteria.

---

## 0. `memory` keyword cleanup

Now that Encantis owns memory unconditionally (§6), the `memory` keyword's job shrinks to two independent, optional axes: **size** and **export**. Host-imported memory goes away. This is a small grammar/codegen change that lands first because it simplifies §1's memory-dedup rule.

### Final grammar surface

```ents
memory                              // implicit min, unbounded max
memory 8                            // 8 initial pages, unbounded
memory 8 256                        // 8 initial, 256 cap
export memory                       // exported as "memory", implicit min, unbounded
export "mem" memory                 // exported with explicit name
export memory 8                     // exported, 8 initial
export "mem" memory 8 256           // everything explicit
```

### Defaults

| Axis | Default |
|---|---|
| Min pages | `max(1, ceil(static_data_bytes / 65536))` — compiler-computed from `def` data |
| Max pages | unbounded (no max field emitted; runtime caps at its own limit) |
| Exported? | no |
| Export name | `"memory"` when `export memory` is written without an explicit string |

### Subtasks

- [x] **Delete `import … "memory" memory N`** from grammar, parser, checker, and codegen. Host-imported memory contradicts ownership.
- [x] **Make all parameters optional.** Bare `memory` and `export memory` must parse and lower correctly.
- [ ] **Compute implicit min** from static data section size. Floor of 1 page.
- [ ] **Omit max field** in the emitted wasm unless one was specified.
- [x] **Default export name = `"memory"`** when no string is given.
- [ ] **Update grammar spec** in [docs/grammar.md](docs/grammar.md) and the §7 / §8 prose in [docs/encantis.md](docs/encantis.md).
- [ ] **Update existing examples.** [examples/alloc.ents](examples/alloc.ents) uses `export "memory" memory 1` — confirm it still parses; simplify if it reads better as `export memory`.

### Exit criteria

- [ ] All seven syntax variants above parse, check, and lower correctly.
- [ ] No example imports memory.
- [ ] A `.ents` file with no `memory` declaration at all compiles to wasm with a sensibly-sized memory.

---

## 1. Encantis-to-Encantis module system

The challenge mandates a multi-file layout (`crypto/sha512.ents`, `ed25519/field.ents`, …). Today only WASM-host imports exist ([checker.ts:345-371](packages/compiler/checker.ts#L345-L371), [codegen.ts:1660-1713](packages/compiler/codegen.ts#L1660-L1713)). We compile to a single monolithic wasm, so this is symbol resolution + emit-everything-into-one-module — not multi-binary linking.

### Syntax

Reuse the existing import grammar; discriminate on whether the first string looks like a path:

```ents
import "env" "log" func log(msg: []u8)              // host import (existing)
import "./sha512" func sha512(input: []u8) -> []u8  // Encantis source import (new)
import "./sha512" "sha512" func hash(...)            // with rename
import "./sha512" (
  func sha512(input: []u8) -> []u8
  func sha512_init() -> Sha512State
)
```

Discriminator: first string starts with `./`, `../`, or `/` → Encantis source import. Otherwise → host import. No grammar changes.

### Subtasks

- [ ] **Module loader.** New file (e.g. `packages/compiler/loader.ts`). Resolves paths relative to the importing file, reads, parses, caches by absolute path, detects cycles. Returns a DAG of parsed modules.
- [ ] **Cross-module symbol resolution.** Extend the import branch in `checker.ts` so a source import looks up the symbol in the imported module's exported decls and unifies the signature.
- [ ] **Unified codegen.** Codegen iterates all loaded modules' decls, not just the entry module's. Internal names get mangled with a module prefix (`sha512$sha512`); only names that surface as wasm-level exports keep their clean form. Wasm-level exports come exclusively from the entry module's `export` decls — `export` in a non-entry module just means "visible to importing Encantis files," it does not punch through to the wasm wall.
- [ ] **Unified data arena.** All modules share one linear memory and one data section. The arena assigns `def` byte offsets program-wide; `def` decls from any module emit into the same section in load order.
- [ ] **Unified function and global index spaces.** Same fix as data offsets — function indices and `global` indices are assigned across the whole program, not per-module.
- [ ] **At most one `memory` declaration program-wide.** With §0 in place, modules don't need to declare memory at all — it's implicit. A module can still write `memory 8` or `export "mem" memory` to set sizing or export name; if more than one loaded module does so, that's an error. Non-declaring modules silently use whatever the entry module set (or the implicit defaults).

### Design decisions to nail down

- **Inline functions across files.** Cleanest answer: importing an `inline func` works, but the loader exposes the AST body so codegen can re-inline at the call site. If that's too much for v1, disallow `export` on `inline func` and revisit.
- **Type identity.** Already structural per [docs/encantis.md §8.2](docs/encantis.md). No work needed.

Resolved (no further discussion needed):

- `export` in non-entry modules is intra-language visibility only; only entry-module `export`s reach the wasm wall.
- All modules share one linear memory and one data arena; one module declares `memory`.

### Exit criteria

- [ ] Two-file fixture in `examples/` (e.g. `examples/modular/main.ents` imports `examples/modular/util.ents`) compiles to one wasm and runs in the test harness.
- [ ] Cycle detection emits a clear error (not infinite loop / stack overflow).
- [ ] Symbol-not-found in imported file emits a diagnostic with the right span.
- [ ] All existing single-file examples still compile.

---

## 2. Large-integer lowering

`u128/i128/u256/i256/u512/i512` currently throw at [codegen.ts:73-84](packages/compiler/codegen.ts#L73-L84). [examples/crypto/blake2b.ents](examples/crypto/blake2b.ents) already fails for this reason. Ed25519 field arithmetic can be written with 5×u64 limbs and dodge this — but `xxh64`-style hashing and several JWS / SHA-512 micro-optimizations want it, and the whole point of the type system saying "u128 maps to v128" is that codegen should honor it.

### Subtasks

- [ ] **u128/i128 → single v128.** Bitwise (XOR, AND, OR, NOT) is one v128 instruction. Add/sub via `i64x2.add` / `i64x2.sub` (paired with carry handling for true 128-bit add). Multiply via decomposed 64×64→128.
- [ ] **u256/i256 → two v128 registers; u512/i512 → four.** Lowering passes that flatten these into multiple WASM SIMD locals, the same way structs flatten today.
- [ ] **`ptr.u128` / `ptr.u256` / `ptr.u512` type-punned loads/stores.** Map to `v128.load` / `v128.store` (and pairs/quads for the larger types). Required by blake2b-style code (`h.u512[0]`, `h.u256[0]`).
- [ ] **Array layouts.** `[N]u128` should pack as N×16 bytes; `*[N]u256` as N×32 bytes. Make sure `sizeof` returns the right answer.
- [ ] **Implicit widenings.** Per [docs/encantis.md §2.8](docs/encantis.md#28-type-conversions), `u32 → u64 → u128 → …` should widen implicitly when no precision is lost. Codegen needs the conversion sequences.
- [ ] **Cast lowering.** Narrowing casts (`u128 → u64`) need to discard the high lane.
- [ ] **64×64 → 128 multiply primitive.** WASM has no native instruction. Either:
  - Emit a known software sequence (Karatsuba or schoolbook on `i64x2`), OR
  - Add an `intrinsic` builtin (`mul_hi(a:u64, b:u64) -> u64`) so users can compose it.
  The second is cheaper to ship; the first is what the type system implies.
- [ ] **Test fixture.** A small example exercising u128 add/mul/xor/load/store, plus a test that the wasm output matches a reference implementation.

### Exit criteria

- [ ] [blake2b.ents](examples/crypto/blake2b.ents) compiles and produces correct hashes.
- [ ] A targeted test exercises u128 arithmetic round-trip through wasm.

---

## 3. `.ents` → `.wasm` pipeline

Today the CLI emits WAT text only. `wabt` is in [package.json](package.json#L21) as a devDependency but is never imported. Without binary wasm, every example test silently skips ([xxh64.test.ts:7](examples/crypto/xxh64/xxh64.test.ts#L7) is `describe.skipIf(!wasmExists)`).

### Subtasks

- [ ] **Add `compile --wasm` to the CLI.** Pipe WAT through `wabt.parseWat(name, watText).toBinary({})`. Write the buffer with `Bun.write`.
- [ ] **Or a separate `wasm` subcommand.** Less ambiguous: `cli wasm <file.ents> -o out.wasm` and keep `cli compile` as WAT.
- [ ] **Sourcemaps?** Wabt can emit them. Probably skip for v1.
- [ ] **Surface wabt errors.** Wabt's parse errors are unhelpful — wrap with the source span where possible.

### Exit criteria

- [ ] `bun cli wasm examples/crypto/xxh64/xxh64.ents` produces a working `xxh64.wasm`.
- [ ] xxh64 test no longer skips and passes.

---

## 4. Examples build & test runner

Both [Makefile](Makefile) and the prose in CLAUDE.md reference `bun run examples:all` and `bun run examples:check`, but neither script exists in any [package.json](package.json). The xxh64 example has a `.test.ts` and a `.js` host wrapper, but nothing materializes the `.wasm`. We need this end-to-end loop working before agents arrive — they will live or die by their feedback loop.

### Subtasks

- [ ] **`examples:check`.** Walk `examples/`, run the parser + checker on each `.ents`, fail with a non-zero exit on any error.
- [ ] **`examples:all`.** Walk `examples/`, run check + WAT + WASM emission, write artifacts alongside the source (`foo.ents` → `foo.wat`, `foo.wasm`).
- [ ] **`examples:clean`.** Delete generated artifacts.
- [ ] **CI hookup.** `bun test` already exists; add `bun run examples:all && bun test` as the canonical "everything green" command.
- [ ] **Convention for multi-file examples.** Decide what the entry file is — probably `<dirname>/<dirname>.ents` or an explicit `main.ents`.

### Exit criteria

- [ ] `bun run examples:all` produces `.wasm` for every example that's expected to compile (and lists the ones that don't, without crashing).
- [ ] `bun test` runs the example test suites against real wasm.

---

## 5. Type checker gaps

Listed in priority order for what the challenge will hit.

- [ ] **Pattern-binding validation** ([checker.ts:902](packages/compiler/checker.ts#L902) TODO). Agents will write match arms with destructuring; missing/duplicated bindings need diagnostics.
- [ ] **Branch type unification** (TODOs near [checker.ts:1976/2007/2021](packages/compiler/checker.ts#L1976)). `if` and `match` arms must have a common type or the result type is wrong.
- [ ] **Enum codegen + checker.** [ast.ts:124](packages/compiler/ast.ts#L124) has `EnumDecl` but the checker has zero cases for it and codegen doesn't handle the stack representation described in [docs/encantis.md §2.7](docs/encantis.md#27-enum-types-algebraic-data-types). Required only if we want `Result<T, E>` style error returns. Recommend deferring unless the challenge prose explicitly leans on enums.
- [ ] **Pre-existing TS errors in the compiler.** Per CLAUDE.md, the compiler has type errors. Either fix or add a specific allowlist — don't ship a state where `tsc` is meaningless.

---

## 6. Memory: three reference allocators, zero language conventions

**Encantis the language has no memory-layout conventions whatsoever.** There is no reserved offset, no required export beyond memory itself, no "heap base" the language knows about, no implicit allocator, no notion of "input scratch" or "output scratch." The language gives you four primitives — `memory N`, `def [mut] = …`, `global`, `memory-grow` — and the program is in complete control of everything else. Allocators are *library code*, not language features. Agents pick whichever (or none) fits their algorithm and `import` it like any other module.

What we ship is three reference allocators that span the spectrum from "everything static" to "everything dynamic." These are *examples and starting points, not requirements* — agents are explicitly free to write their own allocator if they want, ignore ours entirely, or mix and match. The challenge prose should say so directly: a smaller, algorithm-tailored allocator may well outscore a generic one on size and speed, and the language imposes nothing that would stop an agent from doing that.

### Subtasks

- [ ] **Static reservation (no allocator at all).** The simplest pattern: declare a fixed-size mutable buffer at compile time and export it as a slice. The program never touches a free-list or a bump pointer — it owns N bytes at a known offset, period. This is what most of SHA-512, base64url, and JWS will reach for.

  You mentioned having added syntax for "mutable declarations that reserve memory and export the start offset and length as a slice." **First task: confirm whether that's in-grammar today or still pending.** Search the grammar and checker for `mut` decls + `export`-of-slice. If it exists, document it. If it doesn't, spec and add it — the natural form is something like `export def buf: []u8 = mut [0:u8; 4096]`, which compiles to two exported i32 globals (ptr and len). This is a hard prerequisite for the other two allocators, since they themselves use the static-reservation pattern to claim their backing storage.

- [ ] **`malloc` / `free` module** (`examples/alloc/heap.ents`). General-purpose allocator with explicit `free`. Surface: `malloc(size: u32) -> [*]u8`, `free(ptr: [*]u8)`, plus a usage accessor for tests. Implementation: size-classed free-lists or tagged blocks — pick the simplest correct version. Backs its heap with a static reservation that calls `memory-grow` when exhausted.

- [ ] **Arena allocator on top of `malloc`/`free`** (`examples/alloc/arena.ents`). An arena owns one or more chunks obtained via `malloc`; `arena_alloc(arena, size)` bumps within the current chunk; `arena_reset(arena)` drops back to a saved mark; `arena_free(arena)` returns all chunks to the heap. This composition (arena over malloc) is the canonical example of *why* Encantis-to-Encantis imports matter, and it's what Ed25519 scratch buffers will want.

- [ ] **`memory-grow` ownership.** Document who calls it: malloc, when it's about to fail. The static-reservation pattern never grows. Arenas grow indirectly through malloc. The language has no opinion.

- [ ] **No "standard exports."** State explicitly in the docs that beyond `mem`, *nothing* is fixed. The program declares whatever entrypoints and buffers it wants; the host harness discovers them by reading the wasm export table.

- [ ] **Docs.** Write `docs/memory.md` covering: the no-conventions principle (front and center), the three reference patterns with one-line guidance on when to pick each, the static-reservation syntax, and the host-discovery pattern. Make it unambiguous that these are libraries, not language features — the language is the four primitives above.

### Exit criteria

- [ ] All three patterns compile, have unit tests, and are usable via `import` across files.
- [ ] One example each: a primitive that uses static reservation only (e.g. base64url), a primitive that uses malloc/free directly, and a primitive that uses an arena.
- [ ] An agent reading only `docs/memory.md` can pick the right pattern for their algorithm and wire it to the host without any prior coordination on offsets.

---

## 7. Constant-time guidance (docs only, no compiler change)

Crypto wants branchless code on secret data. Encantis hasn't said which constructs are guaranteed branchless. We don't need to add primitives for v1, but we need to tell agents what to use.

### Subtasks

- [ ] **Document in `docs/constant-time.md`** which patterns are reliably constant-time on current codegen:
  - Bitwise ops, shifts, rotates → always
  - `match` on a small `u8` → likely `br_table`, branches but uniform
  - `if` on secret data → DO NOT
  - Memory access at secret indices → DO NOT
- [ ] **Idiom for cmov:** show `(mask & a) | (~mask & b)` and document it as the recommended select.
- [ ] **State the non-goal.** "Encantis does not currently guarantee constant-time codegen for any construct. The patterns below are best-effort." Don't oversell.

---

## 8. Test-vector harness (scaffolding for the seed repo)

This is the host-side TypeScript that drives compiled wasm with known inputs and compares to a trusted reference. Lives in the seed repo, not here, but we need to prototype it here so we know it works.

### Subtasks

- [ ] **Vector files.** RFC 8032 Ed25519 vectors, NIST SHA-512 vectors, JWS round-trip examples. Check in as JSON/hex.
- [ ] **Reference oracles.** Bun has WebCrypto for SHA-512. Use `@noble/curves` for Ed25519 ground truth. Vendor or pin.
- [ ] **Layout-agnostic runner.** Since the program owns memory (§6), the runner instantiates the wasm, reads the export table to find the agent's declared buffer pointers/lengths and entrypoints, writes inputs into those buffers, calls the entrypoint, and reads outputs from declared output buffers. No fixed offsets in the harness.
- [ ] **Determinism check.** Run the same input twice; assert byte-equal output.
- [ ] **Adversarial tests.** Truncated signatures, malformed base64url, zero-length input, etc.

### Exit criteria

- [ ] At least one full primitive (probably SHA-512) wired end-to-end here as a proof of concept, then ported to the seed repo.

---

## 9. LSP improvements

Several agent runtimes consume LSP — Copilot, opencode, Claude Code in VS Code, Cursor, and others — so the LSP is part of the agent-facing surface, not just human ergonomics. The current implementation is hover + diagnostics ([packages/extension/](packages/extension/)); passable for single-file work but missing the navigation features that matter most once code is split across modules. Most of these are mechanical given the checker already has the resolved information.

### Subtasks (priority order)

- [ ] **Goto-definition.** Within-file first, then cross-module once §1 lands. The checker resolves symbols already; the LSP just surfaces the declaration site.
- [ ] **Document symbols.** Outline of a file (functions, types, globals). Cheap — the AST has everything.
- [ ] **Workspace symbols.** "Find by name across the project." Needs the module loader from §1 so the LSP can index the whole DAG.
- [ ] **Find references.** "Where is `field_add` called?" — shares indexing with workspace symbols.
- [ ] **Diagnostic quality pass.** Audit compiler errors for clear messages and accurate spans. Agents triage from these; bad spans waste turns.
- [ ] **Hover improvements.** Show full type signatures including imported symbols; show `def` values for compile-time constants; show inferred types on `let` bindings.
- [ ] **Signature help.** Parameter names and types while inside a call. Lower priority but cheap.

### Out of scope for v1

- Rename refactoring
- Completion (agents generate code; completion mostly serves humans)
- Code actions / quick fixes

### Exit criteria

- [ ] Goto-definition works within and across modules.
- [ ] Document and workspace symbols work.
- [ ] A coding agent with LSP access can navigate a multi-module crypto implementation by following type and symbol references without falling back to grep.

---

## 10. CLI: same intelligence as the LSP

Not every agent runs inside an editor. Headless agents — CI-driven runs, opencode in agent mode, claude-code without VS Code, custom orchestrators — reach the language through the CLI. **Anything the LSP exposes, the CLI must expose too.** Same query layer, two front-ends. This both serves headless agents and prevents the two surfaces from drifting apart.

The current CLI ([packages/cli/src/cli.ts](packages/cli/src/cli.ts)) has `check`, `ast`, `meta`, `compile`. We need richer query subcommands and structured output.

### Subtasks

- [ ] **Refactor LSP queries into a shared library.** Goto-def, hover, references, workspace symbols, document symbols, signature help — all become pure functions in `@encantis/compiler` that take a parsed program plus a query and return results. Both the LSP server and the CLI call into them; no logic duplication.
- [ ] **`cli check`** — already exists. Verify diagnostics include severity, span (file:line:col), code, and message. Human-readable by default; one diagnostic per line.
- [ ] **`cli definition <file>:<line>:<col>`** — print the declaration site for the symbol at that position.
- [ ] **`cli hover <file>:<line>:<col>`** — print type, doc string, and (for `def` constants) the literal value.
- [ ] **`cli references <file>:<line>:<col>`** — list every use site of the symbol.
- [ ] **`cli symbols [<file>]`** — document symbols (one file) or workspace symbols (no arg).
- [ ] **`cli signature <file>:<line>:<col>`** — signature help inside a function call.
- [ ] **Universal `--json` flag.** Every query supports JSON output for agents that want structured input/output.
- [ ] **Stable exit codes.** `0` clean, `1` diagnostics present, `2` invocation problem. Agents script against these.

### Exit criteria

- [ ] Every LSP capability in §9 has a CLI equivalent producing the same data.
- [ ] Both LSP and CLI go through the same query functions in `@encantis/compiler`.
- [ ] An agent with no editor can run `bun cli check src/ --json` and `bun cli definition file.ents:42:10 --json` and parse the output programmatically.

---

## Suggested sequence

Aim for ~1 week of compiler work, in this order:

1. **`memory` cleanup** (§0). Small, isolated, removes a contradiction with the ownership rule and makes §1 cleaner. Few hours.
2. **Pipeline plumbing** (§§3 + 4). Until `bun run examples:all` produces wasm and `bun test` exercises it, you can't tell whether anything else is regressing. Half a day.
3. **Module system** (§1). The biggest user-visible change. Get a two-file fixture green. ~2 days.
4. **Large-int lowering** (§2). Get blake2b.ents passing as the milestone. ~2 days.
5. **Static-reservation syntax + reference allocators** (§6 first three subtasks). Confirm or add the export-as-slice form, then write `heap.ents` and `arena.ents` on top of it. ~1 day.
6. **Type checker gaps** (§5, items 1 & 2). Half a day. Defer enums.
7. **Shared query layer + LSP/CLI parity** (§§9 + 10). Refactor LSP queries into pure functions in `@encantis/compiler`, then surface them through both the LSP and the CLI. Goto-def, document/workspace symbols, hover, references. ~1 day. Depends on §1 for cross-module queries.
8. **Docs** (§§6 + 7). Half a day, can run in parallel with above.
9. **Harness prototype** (§8). Half a day; the bulk lives in the seed repo.

Once 1–7 are green and the docs in 8 exist, the seed repo is a packaging exercise: copy `docs/`, copy a couple of working examples, write the agent-facing README, freeze the test vectors, ship.
