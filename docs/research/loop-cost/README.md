# Why idiomatic loops cost release bytes

Measured on 20 November 2026 at 230f6c8, the head of #165 before main was merged into it, with binaryen 129 and the CLI's own `release()`. `codegen.ts` is the same on main at 2b5e033, so the prototype patch here applies there too. Follow-up is in #172 (the decisions), #161 and #257 (bugs the same lowerings fix).

**Paths.** `<230f6c8 checkout>` is a checkout of that commit with `bun install` done. `<230f6c8 checkout with variants>` is the same checkout with the six variants in `variants/` applied. `<scratch>` is the working directory the measurements ran in. Read them as names, not links.

## The question

PR #165 measured a few idiomatic rewrites of loops and left them out because each made a release build larger. The owner asked why, and whether codegen can close the gap or whether it is inherent at this level of abstraction.

| Case | Idiomatic | Hand-written | Delta |
|---|---:|---:|---:|
| Gimli rounds, `for r in rounds { let round = rounds - r ... }` | 637 | 626 | +11 |
| Gimli absorb, `for b in input.len / rate` | 644 | 626 | +18 |
| xxHash32 stripes, `while ptr <= limit` | 386 | 381 | +5 |
| xxHash64 stripes, `while ptr <= limit` | 564 | 559 | +5 |
| Lantern digits, `for k in len` | 7064 | 7055 | +9 |
| Lantern sparks, element loop over the sparks | 7069 | 7055 | +14 |

The six variants are `variants/*.diff`, against the files of #165.

## Answer

Mostly not fundamental. The 62 bytes split three ways:

- **36 bytes come from how the compiler lowers loops.** One of them is a binaryen pass-order effect. Three fixed lowerings, three local rules and one more release try remove them, and none of them changes what §5.2 says a loop does.
- **13 bytes (digits 9, rounds 4) can be removed, but only fragilely.** A lowering removes them, and the modules then match the hand-written ones byte for byte. It needs a rule that matches how the body spells `count - i`, plus an extra optimizer try. Not recommended.
- **13 bytes are inherent under today's semantics:**
  - the xxHash `while` tests (+5 each);
  - absorb's remainder (+7);
  - offset by the sparks pointer walk, which is 4 bytes cheaper than the index form.

### Why the bytes appear

1. **A `for` tests before every pass, the first one included.**
   - A wasm loop is cheapest tested at the bottom, with a `br_if` that reuses the step's `local.tee`.
   - binaryen 129 has no pass that rotates, peels or unrolls a loop, or that rewrites an induction variable, so the shape the compiler emits is the shape that ships.
   - This costs 5 bytes per constant-count loop, 9 bytes in rounds and absorb together.
2. **An element loop loads every part of a struct element**, since §5.2 says each element is loaded whole.
   - A load may trap, and §9.7 needs `trapsNeverHappen=false`, so binaryen keeps each load nobody reads.
   - This costs 18 bytes in sparks.
3. **Two smaller costs:**
   - A counter the body never uses is still counted and compared (3 bytes).
   - `coalesce-locals` runs before `rse` and leaves a zero store behind (4 bytes).
4. **The programs ask for the rest:**
   - a `while` promises a test before its first pass;
   - absorb asks for `input.len % rate`;
   - digits and rounds compute `count - i` on every pass.

## Root causes

Kinds:
- **L:** a lowering change with no new rule;
- **P:** a rule that depends on what the body does;
- **O:** an extra optimizer try;
- **X:** inherent under today's semantics;
- **S:** needs a change to the language.

| Cause | Bytes of 62 | Kind | Fix (prototype flags) | Measured |
|---|---|---|---|---|
| A count loop tests before every pass, with a top `if` and a re-read of the counter | 9 (rounds 5, absorb 4) | L | `if` guard on the count, then the loop, the step, and `br_if $next (i32.lt_u (local.tee $i (i32.add $i 1)) COUNT)`. A signed count gets an `i32.gt_s COUNT 0` guard (`rot,gif,ltu`). | Corpus −392 (debug −238); rounds 11 → 4, absorb 18 → 14. Per loop: −5 for a constant count, −10 for a nested constant pair, −2 to −6 for a computed count, 0 for an unsigned variable count (+2 when the body uses `i + 1`), +3 for a signed variable count (+5 with `i + 1`; none in the corpus), +1 when the body starts with `break when`. Fixes #257 at 0 bytes. |
| A `*[N]T` walk tests before its first pass, and its end `ptr + N*size` wraps (#161) | 0 | L | A rotated pointer walk with no guard, tested at the bottom with `i32.ne p end` (`erotk,ene`) | Corpus −21 (Lantern −15). `ne` costs the same as `lt_u`, file for file. Must land with the row above, or sparks widens from +14 to +19. |
| A slice walk compares `ptr` with `ptr + len*size`, which wraps (#161) | 0 | L | Count the elements left down to 0, also in loops that assign the index (`ewalks,ewalksi`) | Corpus −15 on the full stack (`types/ranges` +3). |
| Unread struct parts are loaded ("loaded whole", §5.2), and binaryen keeps each dropped load because it may trap | 18 (sparks) | P | Load the parts the body reads, plus the element's last part (`ewit`) | Corpus −24, all in Lantern; sparks +14 → −4. The trap condition is the same, because every part is loaded with an `offset=` immediate from one base. Checked on straddles of structs, nested structs, tuples, `[3]u16`, slice and `u128` fields, and tables. |
| A count variable the body never names is still counted up and compared | 3 (absorb) | P | When the count is not a constant and the body neither reads nor assigns `i`, count a copy of the count down (`downv,fixassign`) | Corpus −54; absorb 635 → 632. |
| `for i, x` keeps a pointer and an index, and copies a slice the body does not change | 0 | P | Step only `i` when the body does not assign it, and read a slice the body leaves alone in place (`eidxi,esteady,fixassign`) | Corpus −93. Wrapping slices now trap, as §5.2 says. |
| `coalesce-locals` runs before `rse` and leaves a counter's zero store | 4 (absorb) | O | A third release try: `rse` once, then `-Oz` to convergence; the smallest try wins | −59 at today's lowering, −63 on top of everything. No file can grow. It must be an extra try: as a replacement it grows `generics/sort.ents` by 16. |
| Rounds computes `rounds - r` and compares `r` with 24 | 6 (4 after rotation) | X for a fixed lowering; P+O with a body-pattern rule | `downip`: count a copy `c` down with `r = count - c` when every read of `r` is `count - r`; the rotated stack also needs a simplify-locals try | Rounds reaches the hand bytes (626 = 626 at today's lowering, 621 = 621 on the full stack with the try, 633 without it). Corpus 0. Fragile; not recommended. |
| Digits counts up and computes `len - 1 - k` | 9 | X for a fixed lowering; P+O with a body-pattern rule | `downip2` plus a simplify-locals, optimize-instructions try | 7053 = 7053 with the try, +13 under plain release. Corpus 0. Other bodies grow 4 to 10 bytes, and constant loops grow from 6 to 32 or 35 bytes. Not recommended. |
| Absorb asks for `input.len % rate` and keeps `input.len` alive after the loop | 7 | X | None. Only rewriting the program, taking the remainder from the loop's exit value, reaches the hand module's 626. | 628 against 621 under every lowering |
| A `while` tests before its first pass (xxHash) | 10 (5 each) | X (S to change) | None under today's semantics | The test is observable: at `(0xfffffff0, 0x40)` the do-while traps and the `while` returns c44f79fc. A guarded rotation is 387 against 386, and rotating every `while` costs +137 over the corpus. |
| The pointer walk's absolute start and end, against the index loop's offset addressing | −4 (sparks) | X, in the idiom's favour | none needed | |

Why binaryen does not do this itself (traced pass by pass with `BINARYEN_PASS_DEBUG=3`):
- `remove-unused-brs` turns the compiler's `block (loop (br_if $break (ge_u r 24)) ... (br $next))` into `loop (if (lt_u r 24) (then ... (br 1)))`, which still tests at the top.
- binaryen 129 has no loop rotation, inversion or first-iteration peeling, and no induction-variable or strength-reduction pass.
- `precompute-propagate` cannot see that the first test is always true, because the counter has two reaching sets.
- `--traps-never-happen`, `--ignore-implicit-traps`, `-O4`, `--licm`, `--monomorphize` and `--flatten --rereloop` leave the gap as it is or make it wider.
- When the compiler emits the rotated shape, a constant guard folds away (`remove-unused-brs`, then `vacuum`), so it costs nothing.

## Corpus totals

The corpus is the 96 programs of `examples/` and `lib/` at 230f6c8. Release bytes come from the CLI's `release()`. The "with rse try" column adds the third try. Data: `data/corpus-*.jsonl`, one line per file.

| Set | Flags | Release | With rse try | Debug |
|---|---|---:|---:|---:|
| base | none | 59899 | 59840 | 85744 |
| L1En | count-loop rotation and the `*[N]T` walk (`rot,gif,erotk,ene`) | 59486 | 59435 | 85486 |
| LEn | all three L lowerings (`rot,gif,erotk,ewalks,ltu,ene,ewalksi`) | 59473 | 59426 | 85314 |
| FULLn | L and P (`rot,gif,downv,erotk,eidxi,esteady,fixassign,ewit,ewalks,ltu,ene,ewalksi`) | 59300 | 59237 | 85010 |

Which files grow:
- **FULLn with the rse try** (−662, −1.1%): `types/ranges` +3 and `types/ranged-writes` +1. The six cases go from 62 to 26 bytes.
- **LEn with the rse try** (−473): `aoc/day1` +6, `types/ranges` +3 and `types/ranged-writes` +1. The six cases go from 62 to 47 bytes.

**Tests.** Under base, LEn and FULLn, all 569 example tests (99 files) and all 736 spec tests pass. The study's own semantic probes pass under LEn and FULLn:
- sem-loops, rotate-sem and assign2;
- the wrap probes in `probes/bugs.ents`.

**Behaviour differences.** Under FULLn, 47 values of the element probes differ from base, and each is a call that returned and now traps, on an input whose end address wraps (#161). In the count probes the only change is `c_assign_signed(5)`, which goes from 11 to 1 (#257).

## Recommendation

1. **Adopt the three L lowerings**, each with a sentence in §11.3. They also fix #161 and #257.
   - Count loop: `rot,gif,ltu`.
   - `*[N]T` walk tested after each pass with `i32.ne`: `erotk,ene`. It must land with the count loop.
   - Slice walk counting the elements left: `ewalks,ewalksi`.
2. **Add the `rse` try to `release()`** as a third try, not a replacement.
3. **Decide on the three P rules.** Each is one sentence in §5.2 or §11.3, and each must check that the body does not assign the variable (`fixassign`; `mayChange` is conservative and safe). Without that check:
   - `for i in n { t += 1; i = 100 }` runs 5 passes instead of 1;
   - `for i, x in s { n += 1; i = 0 }` never ends.
4. **Do not adopt the body-pattern rules** (`downip`, `downip2`, with their extra tries). If reverse walks should cost nothing, decide on a reverse count form (S) instead. Otherwise document these idioms in §5.2:
   - `while i > 0 { i -= 1 }` for a reverse walk;
   - `loop { ...; break when ... }` for a loop that runs at least once.

### Tests to pin the lowerings

- Golden WAT for a constant, a variable, a computed and a signed count.
- Counts 0, 1, 3000000000 and −3; `span(5, 2) == 0`.
- A count that changes in the body.
- In the body: `i = 100`, `i = 0xFFFFFFFF`, and `i = 0x80000000` with a signed count.
- `continue`, `break` and `defer`.
- The wrap probes trap: `count8((0xFFFFFFF0, 32))`, `count32((64, 0x40000001))`, `arr_ptr(0xFFFFFFF8)`, `arr_ptr_huge(4096)`.
- A loop that assigns its index, over a wrapping slice.

## Measured and not recommended

- Rotating `while`: +137 over the corpus; xxh32 387 against 386.
- Rotating slice loops behind a length guard: +4 in each of 4 files.
- `elazy` (loading parts lazily): −31 over the corpus, but `first1((65519, 3))` returns 0 instead of trapping.
- `trapsNeverHappen`: deletes the traps of `assert`, of division by zero and of out-of-bounds loads.
- Ignoring implicit traps: deletes the division and out-of-bounds traps.
  - The conclusion rests on the `wasm-opt` CLI. The `iit` flag of `tools/opt.ts` does nothing in binaryen.js 129.
- Counting down as a fixed rule: +347 over the corpus, and +263 for constant counts only.
- Induction-variable rewriting in the compiler.
- `lowMemoryUnused`: it folds only offsets below 1024, which is an 11.4 question (#158).

## Reference edits if adopted

- **11.3, the `for` row:**
  - A count loop is an `if` on the count around a loop tested after each step.
  - A `*[N]T` walk is tested after each pass.
  - A slice walk counts the elements left.
  - One clause for each P rule adopted.
- **§5.2 Elements:** if `ewit` is adopted, "the parts the body reads, and the last part" replaces "loaded whole". Optionally, name `loop { ... break when }` as the at-least-once form.
- **`release()` in `packages/cli/src/wasm.ts`:** list the `rse` try in its comment.

## What the skeptics changed

Two adversarial reviews of the synthesis corrected these points:
- Digits and rounds are P+O by a body pattern, not inherent.
- Rotation costs 0 bytes for an unsigned variable count only when the body does not use `i + 1`, and +2 when it does. A computed count saves 2 to 6 bytes.
- The rotated `*[N]T` walk with `lt_u` runs one pass for a huge `N`, so its test is `ne`.
- `ewalks` grows `ranges` and `day1`, and it missed loops that assign the index, so `ewalksi` was added.
- The L-only set grows three files, not one.
- They added the signed-count bug (#257), the non-termination of `eidxi` without the assignment check, and the `offset=` condition of the `ewit` rule.

## Files

- **`lowering-prototype.diff`:** a patch to `packages/compiler/codegen.ts`.
  - Every rule is behind a flag in the `LOWER` environment variable, read once when `codegen.ts` is imported. With `LOWER` unset, the output is today's.
  - Flags measured and recommended: `rot`, `gif`, `ltu`, `erotk`, `ene`, `ewalks`, `ewalksi`.
  - P rules: `downv`, `eidxi`, `esteady`, `ewit`, with `fixassign`.
  - The other flags (`down`, `rotk`, `rotu`, `erot`, `eidx`, `eidxs`, `eoff`, `eoffk`, `elazy`, `ewalk`, `wrot`) are variants that were measured and dropped.
  - It is a research prototype, not a change to merge as it is.
- **`variants/`:** the six idiomatic rewrites, as diffs against the files of #165.
- **`tools/`:**
  - `build.ts` builds one file under `CC` and `LOWER`.
  - `six.ts` builds the six cases and their bases.
  - `corpus.ts` and `runcorpus.sh` build the corpus.
  - `opt.ts` runs release variants, including the `rse` try (`releaseWith`); `m.ts` has its per-function sizes.
  - `cmp.py` compares two corpus files.
  - They are kept as they were used: `CC` points at a compiler directory (the patched `packages/compiler`), and the paths are the placeholders above.
- **`probes/`:** `bugs.ents` and `run.ts`, the wrap and signed-count probes of #161 and #257.
- **`data/`:** `six.jsonl` (the six cases under each set, release bytes and with the `rse` try) and `corpus-*.jsonl`.

To rerun:
1. Apply `lowering-prototype.diff` to a copy of `packages/compiler`.
2. Apply `variants/*.diff` to the examples of #165.
3. From the tools' directory, run `CC=<patched compiler> LOWER=<flags> bun six.ts`.
