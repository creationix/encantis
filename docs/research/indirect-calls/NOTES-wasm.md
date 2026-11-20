# NOTES-wasm: the wasm side of indirect calls (bug 10)

Status: COMPLETE 2026-11-17 (single session, no predecessor). Sections: 0 compiler today; 1 experiments (exp/); 2 other toolchains; 3 standards and engine support; 4 cost; 5 constraints for a design.


## 0. Where the compiler stands today (read-only, worktree methods @ 5fca5c9)
- Assembler: `wabt` npm 1.0.39 (root devDependency `^1.0.32`), called as
  `w.parseWat(name, wat, { simd: true, multi_value: true, bulk_memory: true })` then `validate()` and `toBinary({})`:
  packages/cli/src/cli.ts:262, :449, :539; packages/compiler/test-utils.ts:28, :86; extension watPreviewProvider.ts:116.
  No `reference_types`, `tail_call`, `function_references` flags are passed today. (binaryen 129 is also a devDependency, used only as wasm-opt in the extension preview.)
- wabt 1.0.39 feature flags available (node_modules/wabt/index.d.ts:2-32): exceptions, mutable_globals, sat_float_to_int, sign_extension, simd, threads, function_references, multi_value, tail_call, bulk_memory, reference_types, annotations, code_metadata, gc, memory64.
- A function type lowers to ONE i32 ("Function references are table indices"): codegen.ts:151-153 (typeToWasm 'func' -> ['i32']).
- But naming a function as a value emits `(ref.func $f)`: codegen.ts:391-393. These disagree, so a program that only passes a function value prints WAT but does not validate. Experiment exp/fv.ents (pass inc to an unused param):
  `bun cli.ts wasm fv.ents` -> `type mismatch in call, expected [i32, i32] but got [funcref, i32]` AND `function 0 is not declared in any elem sections` (the second error is the declarative-elem rule for ref.func, see below).
- Calling a function value: checker.ts:3327-3336 reports `calling a function value is not supported yet: ...`; codegen.ts:1040-1043 throws for any non-identifier callee. Spec: spec/checks.md:1563-1593.
- byteSize of a func type is null (types.ts:1256-1294 has no 'func' case), so a struct with a function field has no memory layout today.
- Function type equality is structural and ignores param names (types.ts:503-511 typeEquals; canonicalKey types.ts:1341-1344 "names ... are not part of a function's type"); assignability is exact match, no coercion (types.ts:866-880).
- Generics promise no tables: generics.test.ts:1364-1366 and examples/examples.test.ts:85-88 forbid `call_indirect`, `(table`, `(elem`, `ref.func`, `funcref` in generic/example output. docs/encantis.md:2384 ("No function tables and no indirect calls are involved"). docs/encantis.md:1129-1131 says "At runtime, function values are opaque indices into WebAssembly's function table" (status: not implemented).

## 1. Experiments (exp/), runtimes: node v22.23.4 (V8 12.4.254.21-node.57), bun 1.4.4 (JavaScriptCore, WebKit d6375c72)
Harness: exp/asm.mjs assembles with the compiler's own wabt (createRequire from methods/package.json), default flags = Encantis's
`{simd, multi_value, bulk_memory}`. exp/dis.mjs prints wasm2wat of the binary.
SETUP GOTCHA: under `ulimit -v 6000000` node cannot even start wabt: `RangeError: WebAssembly.instantiate(): Out of memory: Cannot
allocate Wasm memory` (V8 reserves ~10 GB of virtual address space per wasm memory for guard-page bounds checks). Run node with
`--disable-wasm-trap-handler` (explicit bounds checks, no reservation). bun is fine as is.

### e01-basic.wat / run01.mjs: table, active segment, call_indirect, traps
- `(table $t 4 funcref)` + `(elem (table $t) (i32.const 1) func $inc $dbl $half)`; slot 0 left null (as clang does).
- `call_indirect $t (type $u32_u32) args... idx` : table immediate (index, defaults to 0), type immediate (a type-section index), the
  i32 table index is the LAST operand, popped after the arguments.
- Results (both engines agree on behaviour, messages differ):
  | case | node 22 (V8) | bun (JSC) |
  |---|---|---|
  | slot 1/2 right sig | 6 / 10 | 6 / 10 |
  | slot 0 null | `null function or function signature mismatch` | `call_indirect to a signature that does not match` |
  | slot 3 f64 sig | `null function or function signature mismatch` | same as null |
  | idx 4 / idx -1 (u32 0xffffffff) | `table index is out of bounds` | `Out of bounds call_indirect` |
  The spec has three distinct traps (spec tests: "undefined element" = OOB, "uninitialized element" = null, "indirect call type
  mismatch"), but both engines fold null into the signature check (a null entry carries no signature, so one compare covers both).
  Consequence for Encantis: a null function value costs nothing extra to check at the call; the trap message cannot say "null".
- The index is unsigned: -1 is OOB, not slot -1.
- JS side: exported table `t.get(0) === null`; `t.get(1)` is a JS function (the "exported function" wrapper, name "0", length 1),
  callable from JS (`t.get(1)(41) === 42`), and identity-stable (`t.get(1) === t.get(1)`).

### e02-structural.wat, e02-provider.wat + e02-consumer.wat / run02.mjs: is the check structural? across modules?
- YES structural. Two identical type entries (wasm2wat shows `(type 0)` and `(type 1)` both `(func (param i32) (result i32))`),
  `$inc` declared with type 0, called with `call_indirect (type 1)`: works in both engines. An inline-typed function and an inline
  `call_indirect (param i32) (result i32)` also work (wabt reuses the first matching type entry for inline signatures).
- Across modules: module A owns and exports a table; module B imports it (`(import "a" "table" (table $t 4 funcref))`), writes its own
  functions into slots 1-2 with an active elem segment ON THE IMPORTED TABLE, and calls A's slot 0 with B's own type entry: works.
  A calls B's `$plus10` with A's type entry: works. A calls B's i64 function: signature-mismatch trap. So function-type identity is
  by shape across module boundaries (MVP types; with Wasm 3.0 GC types it is iso-recursive canonical equality, which for a lone
  non-`sub` func type is still just "same params, same results").

### e03-multivalue.wat / run03.mjs: flattened struct through call_indirect
- `(type $pt_pt (func (param f64 f64 i32) (result f64 f64 i32)))` for `((x: f64, y: f64, tag: u32)) -> (x: f64, y: f64, tag: u32)`:
  call_indirect passes and returns all of them; node and bun both give `[2.5,1.5,7]` / `[3,5,8]`. No memory involved. Needs only
  multi_value (already on). The register-flattening rule carries over unchanged: the wasm signature of a function value is exactly
  the flattened signature of the function.

### e04-refs.wat / run04.mjs: the reference-types instruction set on funcref (all pass on node and bun)
- Assembles with Encantis's current flags `{simd, multi_value, bulk_memory}` AND with `{}`: wabt 1.0.39 turns reference_types on
  by default (flags not passed take wabt defaults). `reference_types:false` rejects `(elem declare ...)`; `bulk_memory:false` rejects
  `(elem (table $t) ...)` (explicit-table / passive / declarative segment syntax came with bulk-memory + reference-types).
  => No new wabt flag is needed for tables, funcref, ref.func, table.* or elem segments.
- Verified behaviour (both engines identical except messages):
  - `ref.is_null`, `ref.null func`, `ref.func $f`; funcref as local (defaults to null), param, result, mutable global
    (`(global $g (mut funcref) (ref.func $inc))`), table element.
  - `table.size` 2; `table.grow $t (ref.func $dbl) 3` returns old size 2, grown slots hold the given init value; growing past the
    declared max (10) returns -1 (no trap).
  - `table.init $t $passive dst 0 2` copies a passive segment; after `elem.drop $passive` a second table.init traps
    (V8 `element segment out of bounds`, JSC `Out of bounds table access`); `table.copy` and `table.fill` work; table.copy out of
    range traps (`table index is out of bounds` / `Out of bounds table access`).
  - Multi-table: a second table `$u2`, `call_indirect $u2 ...` works.
  - Calling a funcref that sits in a global/local: without typed function references there is NO instruction to call a funcref
    directly; it must be written to a table slot first (`call_g`: table.set then call_indirect). call_ref needs typed refs (see e07 and 3).
  - JS boundary: an exported funcref global's `.value` is a callable JS function; an export `(param funcref) (result funcref)`
    passes `null` and wasm function objects through (identity preserved) but a plain JS arrow function is a TypeError
    (V8 `type incompatibility when transforming from/to JS`, JSC `Argument value did not match the reference type`).
  - `Table.prototype.set(i, plainJsFn)` is a TypeError in both (V8: `function-typed object must be null (if nullable) or a Wasm
    function object`). Setting an export of any instance works; calling it with the wrong signature traps as a mismatch.
  - `WebAssembly.Function` (type-reflection proposal) is undefined in node 22 and bun 1.4.4 by default.

### e05-*.wat / run05.mjs, run05b.mjs: the "declared function" rule and memory
- `ref.func $f` inside a function body is valid only if `$f` is mentioned OUTSIDE function bodies: in an elem segment of any mode,
  an export, or a global initialiser (spec: C.refs). e05-declared-export.wat (only exported): valid. e05-declared-none.wat:
  wabt `function 0 is not declared in any elem sections`. e05-declared-decl.wat with `(elem declare func $f)`: valid, +3 bytes.
- The engines enforce it too (run05b strips the elem section by hand): V8 `undeclared reference to function #0`, JSC
  `ref.func index 0 isn't declared`. This is the second error in the exp/fv.ents failure in section 0.
- e05-store-ref.wat: `i32.store` of a funcref -> `type mismatch in i32.store, expected [i32, i32] but got [i32, funcref]`. There is no
  store/load for reference types and a data segment is bytes, so A FUNCREF CAN NEVER BE IN LINEAR MEMORY OR IN `data`.
- e05-data-ref.wat: what CAN be in memory is a table index as an i32. Two `Handler = (run: (u32)->u32, arg: u32)` records laid out in a
  data segment as `{1, 41}`, `{2, 21}` (1 = slot of $inc, 2 = slot of $dbl), called with `call_indirect (type $u) (i32.load offset=4 h)
  (i32.load h)`: both 42 on node and bun. The numbers in the data segment are only meaningful together with the elem segment that
  put $inc at 1 and $dbl at 2 -- the table layout becomes part of the module's ABI (exactly clang's model, see 2).

### e06-host.wat, e06-adapter.wat / run06.mjs: the host gives wasm a callback (node and bun identical)
- (1) Imported function `(import "env" "cb" (func $cb (type $u)))`: `call $cb` works, and the SAME import can be put in a table
  by an elem segment (`(elem (table $t) (i32.const 0) func $inc $cb)`), after which `call_indirect` to slot 1 calls the JS function
  (300 = 3*100). This is the standard, feature-free way to make a host function a function value.
- (2) Host-made table imported: `new WebAssembly.Table({element:'anyfunc', initial:4})` passed as `env.table`; the module's active
  segment writes into it at instantiation; JS then sees `table.get(1)` as a callable function.
- (3) A JS function value chosen at RUN time: `table.set(i, jsFn)` is a TypeError (e04). Portable trick: a one-function adapter
  module `(import "js" "f" (func $f (param i32) (result i32))) (export "f" (func $f))`; its export is a Wasm function object with a
  wasm signature, so `table.set(2, wrapped)` and `table.grow(2, wrapped)` work and call_indirect reaches the JS function (ok:9).
  This is exactly what emscripten's `addFunction` does when `WebAssembly.Function` is missing.
- `WebAssembly.Function` (type-reflection proposal, PHASE 1 per WebAssembly/website features.json): undefined by default in node 22 and bun 1.4.4; node 22 with
  `--experimental-wasm-type-reflection` has it, `new WebAssembly.Function({parameters:['i32'],results:['i32']}, fn)` goes into the
  table and is called (42); a wrong-typed one traps as a signature mismatch. Not something a compiler can rely on.
- wasm -> host: export the table (JS `t.get(i)(args)`), export functions, export a funcref global, or return a funcref from an
  export (all shown in e04). JS receives the same function object each time.

### e07-*.wat, e08-*.wat / run07*.mjs: typed function references and tail calls
ASSEMBLERS:
- wabt 1.0.39 (the compiler's assembler) CANNOT do typed function references in their final form:
  - without `function_references`: `(param $f (ref $u))` -> `expected i32, i64, f32, f64, v128, externref, exnref or funcref`;
  - with `function_references` (+gc, +tail_call): `call_ref $u` -> `unexpected token $u` (wabt still expects the pre-standard
    call_ref with no type immediate); `(ref null $u)` -> `unexpected token "null"`; `return_call_ref` -> `unexpected token`;
    and the minimal subset it parses (e07-wabt-min.wat) fails its own validator: `(ref.func $inc)` is typed `funcref`, not
    `(ref $u)` (`expected [(ref 0), i32] but got [funcref, i32]`).
- wabt 1.0.39 DOES do tail calls with `tail_call: true`: e08-tail.wat (`return_call`, `return_call_indirect`) assembles (118 B);
  without the flag: `opcode not allowed: return_call_indirect`.
- binaryen 129 `wasm-as` (already a devDependency) assembles all of it with `--enable-reference-types --enable-gc --enable-tail-call`
  (binaryen files call_ref under GC: `call_ref requires gc [--enable-gc]`). BUT binaryen is an optimising IR, not a faithful
  assembler: `wasm-dis` of its output shows names dropped, the `(elem declare ...)` dropped/regenerated, and `call_ref $u x
  (ref.null $u)` REWRITTEN to `(drop ..) (drop (ref.null nofunc)) (unreachable)`. So the bytes are not "the WAT you wrote".
- wabt NIGHTLY `wabt@1.0.39-nightly.20251203` (npm dist-tag `nightly`; `latest` is still 1.0.39), installed only in the
  scratchpad, with `{function_references, tail_call}`: assembles e07-typed-refs.wat, e07b-null-call-ref.wat, e08-tail-ref.wat in
  their final Wasm 3.0 syntax, faithfully (exp/*.wabtn.txt: `call_ref 0` kept on the null constant, `(elem declare func 0 1)` kept,
  typed table segment `(ref null 0) (ref.func 0) (ref.func 1)`); engines validate and run them with the same results as below
  (exp/run07e.mjs, run07f.mjs). So typed refs need either a wabt nightly (or a newer release) or a different assembler.
ENGINES (binaries from binaryen, and again from the wabt nightly; all default flags, no --experimental needed):
  | test | node 22.23.4 (V8 12.4.254.21-node.57) | bun 1.4.4 (JSC) |
  |---|---|---|
  | `(ref $u)` param + `call_ref $u` | ok | ok |
  | `(ref null $u)` local + `br_on_null` | ok (10 / -1) | ok |
  | `call_ref` on a run-time null | trap `dereferencing a null pointer` | trap `call_ref to a null reference` |
  | typed table `(table 2 (ref null $u))` + `table.get` + `call_ref` (no signature check at all) | ok | ok |
  | non-nullable table `(table 2 (ref $u) (ref.func $inc))` (needs an init expr) | ok | ok |
  | `return_call` + `return_call_indirect`, 1e6-deep mutual recursion | ok 1000000 | ok 1000000 |
  | `return_call_ref`, 1e6 deep | ok | ok |

### e10-*.wat / run10.mjs, run10b.mjs: funcref has no equality and no way back to an index
- `ref.eq` on two funcrefs is INVALID: binaryen `ref.eq's left argument should be a subtype of eqref`; engines (byte-patched module,
  run10b): V8 `ref.eq[0] expected either eqref or (ref null shared eq), found local.get of type funcref`, JSC `ref.eq ref0 to type
  RefNull expected Eqref`. funcref is not under eqref in the Wasm 3.0 hierarchy. wabt 1.0.39 does not even parse `ref.eq`.
- There is no instruction that gives the table index of a funcref. The only way to get an i32 for one is to put it in a NEW slot:
  `table.grow $t f 1` returns the old size = the new index (e10-intern.wat: three calls -> 1, 2, 3, table size 4). Without ref.eq a
  module cannot even look for an existing slot, so every store of a funcref into memory would allocate a slot (a leak) -- this is
  what emscripten `addFunction` does from JS.
- Today's language already compiles `f == g` on function values to one `i32.eq` (checker.test.ts:2352-2358, "function values can be
  told apart"). That only survives with the i32-index representation.
### e11-identity.wat / run11.mjs: host can find a function's slot
- `exports.inc === table.get(1)` and `ref.func $inc` returned to JS `=== exports.inc` (node and bun): one JS object per wasm
  function, so a host can map an export to its slot by scanning an exported table. No name/slot metadata is required.

## 2. What other toolchains emit (compiled here; disassembled with the compiler's wabt via exp/wasm2wat.mjs)
SIDE EFFECT: `rustup target add wasm32-unknown-unknown` was run (installs rust-std into ~/.rustup; no worktree touched).

### clang 18.1.3 + wasm-ld 18 (exp/clang/fp.c -> fp.wasm, `clang --target=wasm32 -O1 -nostdlib -Wl,--no-entry`)
- One table `(table $T0 4 4 funcref)` = 1 + number of ADDRESS-TAKEN functions; min = max (not growable) unless
  `-Wl,--growable-table` (then `4 funcref`, no max). Named `__indirect_function_table` in the symbol table; exported under that
  name only with `-Wl,--export-table` (fp-export-table.wasm); in a relocatable .o it is an IMPORT (fp.o has an import section).
- One active segment `(elem (i32.const 1) func $dbl $inc $swap)`: slot 0 is never filled, so a null function pointer is 0 and
  `f == 0` compiles to `i32.eqz` (is_null). Calling a null pointer traps as a null/mismatch at call_indirect.
- `never_taken` (only called directly) has no slot (it was inlined; a non-inlined direct-only function would also get none):
  the linker puts in the table exactly the functions whose address is taken (relocation R_WASM_TABLE_INDEX_*).
- A function pointer is an i32 table index everywhere: `pick` stores `select 1 2` into the global `slot` (in memory),
  `handlers[]` in .rodata is `\02\00\00\00 )\00\00\00 \01\00\00\00 \15\00\00\00` = {inc=2, 41}, {dbl=1, 21}: STATIC DATA HOLDS
  TABLE INDICES, which wasm-ld resolves at link time (reloc.DATA in fp.o).
- `apply(f, x)` = `local.get x; local.get f; call_indirect $T0 (type $t0)` -- the type is the shared type-section entry, the same one
  inc/dbl declare.
- Struct by value (`Pt (*)(Pt)`): default C ABI passes it in MEMORY (sret pointer + byval pointer: `(type $t1 (func (param i32 i32)))`,
  shadow-stack `__stack_pointer` traffic). With `-mmultivalue -Xclang -target-abi -Xclang experimental-mv` the type becomes
  `(func (param f64 f64 i32) (result f64 f64 i32))` and the stack traffic disappears -- i.e. Encantis's flattening is what clang's
  experimental multivalue ABI does.
- `-mtail-call`: `return f(x)` becomes `return_call_indirect (type $t0)`.
- `-mreference-types` (LLVM 18): same text, code section +12 B: the call_indirect table immediate is written as a 5-byte padded
  LEB so the linker can relocate it (table numbers become symbols). Section listing via exp/sections.mjs.

### clang `__funcref` (a C function pointer that IS a wasm funcref), LLVM 18.1.3, `-mreference-types` (exp/clang/funcref.c, funcref.s)
- `typedef int (*__funcref fref)(int)` can be a param/local but not in memory (a `static fref g` is rejected), and a call through it is
  lowered to a hidden 1-slot table: `.tabletype __funcref_call_table, funcref, 1`; `i32.const 0; local.get f; table.set
  __funcref_call_table; ...; i32.const 0; call_indirect __funcref_call_table, (i32) -> (i32)`; then `table.set` the slot back to
  `ref.null_func`. Exactly the trick of exp/e04 `call_g`. Emitting an object file with it crashes LLVM 18 (`fatal error: error in
  backend: undefined table symbol cannot be weak`; `-S` works). LLVM PR #162227 (Oct 2025, llvm-commits) lowers such calls to
  `ref.cast` + `call_ref` when GC is enabled, replacing the table workaround.

### rustc 1.97.0, wasm32-unknown-unknown (exp/rust/fp.rs, `-C opt-level=1 -C panic=abort`)
- Identical model to clang (same LLVM backend + wasm-ld): `(table $T0 5 5 funcref)`, `(elem (i32.const 1) func dbl inc swap
  <closure shim>)`, slot 0 null.
- `Option<fn(u32)->u32>` uses 0 as None (null-pointer niche): `maybe` is `br_if` on the i32 then `call_indirect (type $t0)`.
- `static HANDLERS: [Handler; 2]` in .rodata is `\02..)\00..\01..\15..` -- table indices in data, exactly as C.
- A non-capturing closure coerced to `fn(Pt)->Pt` gets its own slot (a `FnOnce::call_once` shim). `&dyn Fn` would be a
  (data ptr, vtable ptr) pair with the vtable holding table indices (devirtualised here, since only one closure type existed).
- Aggregates by value go through memory (`swap` is `(param i32 i32)`: sret + pointer), as in C.

### The convention clang, Rust and Zig share: WebAssembly/tool-conventions (fetched 2026-11-17)
- Linking.md "Processing Relocations": "R_WASM_TABLE_INDEX_* relocations cannot fail. The output Wasm file shall contain a
  newly-synthesised table, which contains an entry for all defined or imported symbols referenced by table relocations. The output
  table elements shall begin at a non-zero offset within the table, so that a `call_indirect 0` instruction is guaranteed to fail.
  ... for ... weakly-undefined function symbols ... the value `0` is written". Relocations: `R_WASM_TABLE_INDEX_SLEB` = "a function
  table index ... immediate argument of a `i32.const` instruction, e.g. taking the address of a function"; `R_WASM_TABLE_INDEX_I32`
  = "... e.g. taking the address of a function in a static data initializer"; `R_WASM_TYPE_INDEX_LEB` = "the type immediate in a
  `call_indirect`" and the linker synthesises the type section.
- BasicCABI.md: "A null pointer (for all types) has the value zero" -- function pointers included.
- DynamicLinking.md: shared modules import `env.__indirect_function_table` (shared by all modules) and `env.__table_base` (the
  module's slice of it); a main module exports `memory` and `__indirect_function_table`.
- Zig's own wasm linker (src/link/Wasm.zig) follows the same spec: synthesised `__indirect_function_table`, `export_table` and
  `growable_table` options, exported under that name (zig linker tests); LLVM-backend Zig is the clang model above.

### Go 1.24.7, GOOS=wasip1 GOARCH=wasm (exp/go/main.go: `apply(inc, 41)`; 1.6 MB binary)
- Every Go function has the SAME wasm type `(func (param i32) (result i32))` (param = resume point, result = "unwind"); Go
  arguments live on Go's own stack in linear memory (`global $g0` = SP). One `(table 5208 funcref)`, one big elem segment
  (2114 B) starting at 4096.
- A func value is a pointer to a funcval in memory; the call loads the PC from it, nil-checks explicitly (`i64.eqz` ->
  `runtime.sigpanic`), computes the table index as `PC >> 16` and does `call_indirect $T0 (type $t0)`. All 80 call_indirects in
  the binary use that one type, so the engine's signature check can never fail: Go chose a uniform ABI over wasm's typed calls.

### TinyGo (docs: tinygo.org/docs/concepts/compiler-internals/calling-convention)
- Func values are "fat function pointers" {context, function pointer}, expanded into separate arguments; "Non-exported functions
  have two extra `i8*` parameters ... The first extra parameter is the context for when the function is a function pointer". Via
  LLVM the function pointer part is a table index (clang model).
### AssemblyScript 0.28.9 (installed in scratchpad only; exp/as/fp.ts -> fp.wat, `asc -O1 --runtime stub`)
- `(table $0 3 3 funcref)`, `(elem $0 (i32.const 1) $fp/dbl $fp/inc)`, slot 0 null -- same table layout as clang.
- BUT a function value is NOT the table index: it is a pointer to a static `Function` object in a data segment
  (`(data (i32.const 24) "\04\00\00\00\08\00\00\00\01")` = header rtId 4, size 8, then `_index` = 1 (dbl), `_env` = 0; the inc object at
  56 holds `_index` = 2). `index(i)` returns 32 or 64 (object addresses). A call is `i32.load` of `_index` then
  `call_indirect (type $0)`: one extra load per call, to leave room for closures (`_env`).

### MoonBit (docs.moonbitlang.com FFI page, error E4151)
- `FuncRef[T]` "represents closed function of type T", maps to wasm `funcref`, must not capture locals. Its wasm-gc backend keeps
  data in GC structs/arrays, not linear memory. Closure lowering not documented. Grain: not found.

## 3. Standards status and support (sources)
- Wasm 3.0 was declared complete on 17 Sep 2025 (webassembly.org/news/2025-09-17-wasm-3.0, by Andreas Rossberg): includes
  64-bit address space, multiple memories, GC, TYPED REFERENCES (`call_ref`), TAIL CALLS, exception handling, relaxed SIMD,
  deterministic profile, custom annotations; JS string builtins on the JS side. Reference types, bulk memory and multi-value are
  Wasm 2.0 (already relied on by Encantis: multi_value, bulk_memory flags).
- github.com/WebAssembly/website features.json (fetched 2026-11-17), first version with the feature on by default:
  | engine | reference types | tail calls | typed function refs | GC | type reflection (`WebAssembly.Function`) |
  |---|---|---|---|---|---|
  | Chrome | 96 | 112 | 119 | 119 | flag only |
  | Firefox | 79 | 121 | 120 | 120 | flag (Nightly on) |
  | Safari | 15 | 18.2 | 18 | 18.2 | 18.2: only Module.imports/exports |
  | Node.js | 17.2 | 20.0 | 22.0 | 22.0 | `--experimental-wasm-type-reflection` |
  | Deno | 1.16 | 1.32 | 1.38 | 1.38 | v8 flag |
  | Wasmtime | 0.20 | 22 (Cranelift, default on) | 47 | 47 | - |
  | Wasmer | 2.0 | 7.1 | no | no | 2.0 |
  | wasm3 | 0.9.0 | 0.9.0 | 0.9.2 | no | - |
  | Wasmi | 0.24 | 0.28 | NO | no | - |
  | wazero | yes | flag | flag | no | - |
  | wasm2c (wabt) | 1.0.31 | 1.0.42 | no | no | - |
  | Binaryen | yes | yes | yes | yes | - |
  Proposal phases there: reference types 5, tail call 5, typed function references 5, type reflection 1.
- Verified here: node 22.23.4 and bun 1.4.4 run call_ref / (ref $t) / br_on_null / typed tables / return_call / return_call_indirect /
  return_call_ref with NO flags (section 1, e07/e08). There are no engine feature flags to pass for any of this on these versions.
  The only "flags" are ASSEMBLER flags (wabt `reference_types` (default on), `tail_call`, `function_references`; binaryen
  `--enable-reference-types --enable-gc --enable-tail-call`).

## 4. Cost of call_indirect vs call
- exp/e09-bench.wat + e09-bench-ref.wat / run09.mjs: 1e8 calls of a 1-instruction function in a loop, best of 5 (rough; shared
  machine; numbers are loop+call):
  | | call | call_indirect, 1 target | call_indirect, 2 alternating | call_ref |
  |---|---|---|---|---|
  | node 22 (V8 12.4, default tiers) | 1.82 ns | 2.10 | 2.41 | 2.14 |
  | node `--no-liftoff` | 1.87 | 2.08 | 2.45 | 2.17 |
  | node `--liftoff-only` | 1.73 | 2.32 | 3.26 | 2.33 |
  | bun 1.4.4 (JSC) | 0.41 | 0.72 | 1.32 | 0.72 |
  So call_indirect costs a fraction of a ns over a call here (bounds check + signature compare + loads + indirect branch), and
  call_ref costs the same as a monomorphic call_indirect on both engines. The real cost of an indirect call is the lost inlining.
- V8 (v8.dev/blog/wasm-speculative-optimizations): without inlining a call_indirect must bounds-check the index and "check whether the
  function at this index has the correct signature"; Chrome M137 shipped speculative call_indirect inlining with deopts (call_ref
  inlining existed since the WasmGC launch); Dart microbenchmarks +50% avg (1.19x for call_indirect inlining alone), larger apps
  1-8%. node 22's V8 12.4 predates M137 (V8 13.7), so it does not inline call_indirect.
- Wasmtime (PR descriptions bytecodealliance/wasmtime #8509, #11626; zulip issue #6429): call_indirect = load table base/len from
  vmctx, bounds check, Spectre mask, load funcref, LAZY-INIT check (initialise the entry on first use), load signature id and
  compare. Lazy init is "~15x more expensive" in a micro-benchmark where every call hits a different callee, but wins at
  instantiation of big modules. Optional `cache_call_indirects` config keeps a per-call-site cache. Signature-check elision for
  immutable tables whose entries all match is only proposed (#13445, unmerged).
- Firefox: no speculative call_indirect inlining (bugzilla 1914423 open).

## 5. What makes "little magic" hard (and what is NOT hard) -- the wasm facts a design must respect
NOT hard (verified):
- No new assembler flags for an i32-index design: tables, funcref, elem segments (active/passive/declarative), table.*, ref.* already
  assemble with Encantis's flags (wabt turns reference_types on by default) -- e04.
- Type-section entries: the codegen never writes `(type ...)` today (grep: no `(type $` in codegen.ts) and need not start: wabt
  finds or creates the entry for an inline `call_indirect (param ..) (result ..)` (e02 `via_inline`), and the check is structural
  across type entries and across modules (e02). The type immediate is a deterministic function of the flattened signature.
- Multi-value / flattened structs work unchanged through call_indirect and call_ref (e03).
- Null: if slot 0 is never filled, the i32 0 is a null that traps on call at no extra cost (folded into the signature check) and
  `f == 0` is `i32.eqz` -- the same convention as Encantis's optional pointers, clang, Rust (Option<fn>) and AssemblyScript.
HARD / IMPLICIT MACHINERY a reader would not see in source:
1. A table must exist and be filled. With i32 indices: `(table N funcref)` plus an active `(elem (i32.const 1) func ...)` that the
   user never wrote. Its contents (which functions get slots) and its ORDER (which number each function is) become part of the
   module's ABI the moment an index is stored in memory/data or handed to the host.
   Precedent in Encantis: memory is emitted implicitly when needed, with optional explicit `memory`/`export memory` declarations
   (codegen.ts:3075-3097; docs/encantis.md 7.2-7.3). A table could follow the same pattern (implicit, with an optional explicit
   declaration to size/export/import it).
2. Slot numbering. clang/Rust number slots in linker order (exp/clang: dbl=1, inc=2, swap=3 -- not source order). Since Encantis
   compiles the whole program to one module (programToWat(load.modules, ...), cli.ts:256), it can assign slots by a rule the reader
   can predict (e.g. declaration order of functions used as values, from 1). A function used only by direct call gets no slot
   (clang does the same).
3. ref.func needs a declaration outside function bodies (an elem segment, export or global init), else invalid in wabt AND in
   engines (e05). Any design with ref.func emits at least `(elem declare func ...)` the user did not write -- or the active segment
   that fills the table serves the purpose.
4. Two representations do not mix freely:
   - register form (funcref / (ref $t)): may live in locals, params, results, globals, tables; NOT in linear memory, NOT in `data`
     (e05-store-ref: no store instruction for references), no equality (e10), cannot become an index without allocating a slot.
   - memory form (i32 table index): may live anywhere an i32 can, including structs in memory and `data` (e05-data-ref, clang and
     Rust put indices in .rodata), compares with i32.eq, but is only meaningful with THE table that the index was assigned in.
   Converting index -> funcref is `table.get` (cheap); funcref -> index is impossible without table.grow (e10). So a function type
   that can be a struct field in memory, a `data` element, a slice element or a host-visible number must be the i32 index.
   byteSize(func) would be 4 (today null: types.ts:1256-1294).
5. Calling a register-form funcref without typed refs needs a hidden table slot (e04 call_g; clang's `__funcref_call_table`):
   that is magic. With typed refs it is `call_ref $t` -- no table, no index, no run-time signature check (static typing), but a
   null check on `(ref null $t)`. So "function value = funcref" only makes sense together with typed function references.
6. Typed function references need explicit `(type $t (func ...))` declarations (a heap type is named by index; there is no inline
   form for `(ref $t)`), wabt nightly or another assembler (wabt 1.0.39 cannot), and Wasm 3.0 engines (node >= 22, Chrome >= 119,
   Firefox >= 120, Safari >= 18(.2), Wasmtime >= 47; NOT Wasmi, Wasmer, wasm2c, w2c2). call_indirect works everywhere since MVP.
7. Operand order: call_indirect pops the i32 index (call_ref pops the ref) AFTER the arguments, so for `f(x)` the callee value is
   pushed last. If the callee expression has effects or is not a plain local (`get_handler()(x)`, `h.run(h.arg)` with `h` in memory),
   source order "callee, then args" needs a scratch local -- the same issue the codegen already handles for other reorderings.
8. Host interop: an exported function taking a function value receives an i32 (index form) the host can only produce if it knows the
   table: export the table (then exports.f === table.get(slot), e11) or let the host import/own the table (e06; then the module must
   not collide with the host's slots: tool-conventions solve it with `__table_base` -- more machinery). A JS function becomes a value
   only through an import (`import "env" "cb" func ...`, then it can get a slot like any function, e06) or an adapter module;
   `Table.set(i, plainJsFn)` is a TypeError and `WebAssembly.Function` is not available by default (e04/e06).
9. Generics promise no tables (generics.test.ts:1364-1366, examples.test.ts:85-88): comptime function parameters stay direct calls;
   a design must emit no table/elem/ref.func/call_indirect when no function is used as a run-time value, so those tests keep
   passing and twins stay byte-identical.
10. Existing codegen inconsistency to fix in any design: codegen.ts:391-393 emits `(ref.func $f)` for a function named as a value
    while codegen.ts:151-153 types it as i32 (exp/fv.ents fails validation with both errors).

## How to re-run
`cd exp; ulimit -v 6000000; timeout 60 node --disable-wasm-trap-handler runNN.mjs; timeout 60 bun runNN.mjs`.
Typed-ref binaries: `bun asm-nightly.mjs <dir with wabt@1.0.39-nightly.20251203> X.wat X.wabtn.wasm` (the nightly was installed under the
session scratchpad, which may be gone) or binaryen: `node --disable-wasm-trap-handler <methods>/node_modules/binaryen/bin/wasm-as
--enable-reference-types --enable-gc --enable-tail-call X.wat -o X.binaryen.wasm`. clang: `clang --target=wasm32 -O1 -nostdlib
-Wl,--no-entry fp.c -o fp.wasm`; rust: `rustc --target wasm32-unknown-unknown --crate-type cdylib -C opt-level=1 -C panic=abort -A warnings
fp.rs`; go: `GOOS=wasip1 GOARCH=wasm go build` in exp/go (fp.wat deleted: 492k lines; regenerate with `node wasm2wat.mjs go/fp.wasm`).

## Left to do
- (nothing essential) Possible extras: wasmtime/wasm-tools not installed here, so wasmtime behaviour is from features.json and PRs
  only; Grain's closure lowering not found.
