# Research archive

Designs, notes and tools written while working on the compiler, the reference and the examples, kept here so they
are not lost. **None of this is the language.** [`docs/encantis.md`](../encantis.md) is the source of truth for
semantics; a design here describes a proposal that is not implemented unless the reference says so.

Paths in these files that start with `<scratch>/`, `<board-builder port>/` or `<0.2.1 checkout>` pointed at working
directories that no longer exist; read them as names, not links. Line numbers refer to the commits each file names.

| What | Status | Decide or follow up in |
|---|---|---|
| [`indirect-calls/`](indirect-calls/DESIGN.md): run-time function values (a function's value is its slot, an `i32` index into one implicit table; `call_indirect`), with the WAT worked out by hand and checked, 14 decisions for the owner (section 13), stages and tests. `NOTES-language.md` and `NOTES-wasm.md` are the research it was built on. Written against `claude/method-calls` 5fca5c9 (17 November 2026). | Design, not implemented. Owner's stance (17 November): yes to real indirect calls, "but let's consider carefully. Encantis should have little magic in the wasm translation". | #167 (and closures, #168) |
| [`comptime-values/DESIGN.md`](comptime-values/DESIGN.md): comptime value parameters (`comptime n: u32`, `[n]T`). | Implemented in #32; kept as the record of why. | none |
| [`design-review-observations.md`](design-review-observations.md): the factual observations of a design review that proposed simplifications (several ways to lay out a literal, the table rule for `[N]T`, optionals, `[!]T` spellings, overloads, `let` scope). | The proposals were not decided. Most observations became owner questions of #149. | #171 |
| [`loop-cost/`](loop-cost/README.md): why idiomatic loops cost release bytes (62 bytes over six cases of #165), attributed byte by byte to the lowering, binaryen 129's passes and the programs themselves; a flagged prototype of the lowerings in `codegen.ts`, measured over the 96 programs of `examples/` and `lib/` (−662 bytes with every rule), with the tools, probes and data. Measured at 230f6c8, 20 November 2026. | Research, not implemented. Three lowerings, three body rules and a release try for the owner to decide. | #172 (decisions), #161 and #257 (bugs the lowerings fix) |
| [`examples-oracle/`](examples-oracle/README.md): the differential oracle used to check the examples rewrite (#165) call by call against the base build, the probe builder that exports every function, the Lantern replay and the mutation tests that validated the oracle. | Research tools; not wired into CI. | #165 (where it was used), #172 (the loop-cost research may use it) |
