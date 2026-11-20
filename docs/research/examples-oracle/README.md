# Baseline and differential oracle for examples/

Everything here runs with bun. Paths below are absolute; `S` is
`$SCRATCH`.

| File | What it is |
|---|---|
| `build-entries.ts` | Builds every example entry of a checkout: debug (`encantis wasm`), release (`encantis wasm --release`), sizes, ABI. |
| `probe-build.ts` | Builds each entry with every top-level function of the entry file exported, for files that export little or nothing. |
| `diff-exports.ts` | The oracle: calls two builds of a module the same way and compares everything a host sees, call by call. |
| `diff-runner.ts` | One module of a comparison, in a child process (started by `diff-exports.ts`). |
| `diff-common.ts`, `wasm-info.ts` | Seeded random numbers and value encoding; a wasm binary reader (types, imports, exports, globals, data). |
| `examples.config.json` | Per-module options for the examples (the browser games start with `init(1)`). |

## The baseline (f5b2f97)

| Path under `S` | Contents |
|---|---|
| `base-wt/` | Detached worktree at f5b2f97 with `bun install`. Never edited. |
| `base/<rel>.wasm` | Debug build of each of the 83 entries, e.g. `base/examples/crypto/sha256/sha256.ents.wasm`. |
| `base-release/<rel>.wasm` | Release build of each. |
| `base-probe/<rel>.wasm` | Probe build of each (all top-level functions exported). `base/probe-report.json` lists the functions added. |
| `base/sizes.json` | `{rel: release bytes}`. Equal to the `measured` of every example in `scripts/size-budgets.json`. |
| `base/abi.json` | `{rel: {imports, exports}}` with wasm types, from the debug build (the release build has the same ABI). |
| `base/build-report.json` | Each build's status (all 83 built). |
| `base/tests.txt` | `encantis test` of every entry with tests: 76 files, 418 tests, all pass. |
| `base/examples-all.txt` | `bun run examples:all` at base. |
| `base/browser-sizes.json` | `examples/browser/build.ts`'s `dist/sizes.json` at base. |

The entries are the files `scripts/examples.ts` builds (a directory's
`main.ents`, else the file named like the directory, else every file in it)
plus every `examples/**/*.ents` with a `test` block. Not entries:
`examples/modular/util.ents` and `examples/math/trig/test.ents` (imported or
standalone, no tests).

## Building the new side

Build the changed entries of the working tree the same way, into a scratch
directory of your own (every path absolute; the tool runs the CLI with the
checkout as its working directory):

```sh
bun $S/tools/build-entries.ts $REPO \
  --debug /tmp/new --release /tmp/new-release --sizes /tmp/new-sizes.json \
  --only examples/crypto/sha256/sha256.ents,examples/alloc/heap.ents
bun $S/tools/probe-build.ts $REPO /tmp/new-probe --only examples/types/language-features.ents
```

Without `--only` every entry is built (about 2 minutes for debug and release,
2 jobs; `--jobs N`). `--list` prints the entries. `--compiler <repo>` takes
the compiler from another checkout, for a copy of `examples/` and `lib/` that
has none.

Size: compare `/tmp/new-sizes.json` with `$S/base/sizes.json`.

## Running the oracle

```sh
bun $S/tools/diff-exports.ts $S/base/examples/crypto/sha256/sha256.ents.wasm /tmp/new/examples/crypto/sha256/sha256.ents.wasm
bun $S/tools/diff-exports.ts $S/base /tmp/new --config $S/tools/examples.config.json   # every .wasm under /tmp/new against base/
```

Exit status: 0 identical, 1 a mismatch, 2 a usage error. In directory mode
every module under the new directory is compared with the one at the same
path under the base directory (one with no base counts as a mismatch); base
modules the new directory lacks are counted and not compared, so building
only the changed entries is enough.

| Option | Default | Meaning |
|---|---|---|
| `--calls N` | 2000 | Calls in all, after the `--init` calls. |
| `--seed S` | 1 | Seed for the call sequence, the arguments, the import results, stdin. The same seed gives the same run. Try a few seeds for a file you changed. |
| `--only a,b` / `--skip a,b` | | Call only these exports / not these (for a documented behaviour change). The ABI is still compared for all. |
| `--init name[:a,b]` | | Call this export first, with these arguments (random ones if none given); repeatable. It stays in the rotation; add `--skip name` to call it only once. |
| `--timeout ms` | 3000 | Time a call may take. See *Timeouts*. |
| `--scribble P` | 0.25 | Probability that a later call is preceded by writing 1 to 3 runs of random bytes into memory, mostly where one of the call's i32 arguments points (an input buffer). |
| `--scribble-from F` | 0.5 | Writes happen only from this fraction of the calls on, so that the first half sees the module's state as only its own calls left it. |
| `--no-memory` | | Compare no memory at all (results, traps, imports and globals only). |
| `--mem-range lo:hi,...` | | Compare only these byte ranges of each memory. |
| `--host-view` | | Compare only what the module exports. By default the runner also exports memory 0 and every mutable global the module does not export (as `__oracle_memory`, `__oracle_global_<i>`), since a module that exports no memory still writes its results there. |
| `--no-internal-globals` | | Do not compare unexported globals (they are compared by index, and skipped with a note when the two builds have different numbers of them). |
| `--wasi-streams` | | For WASI programs: compare the bytes written to each fd in a call, not how they are split into `fd_write` calls, and do not log `fd_read` (its requested size). Pair with `--no-memory` when the buffers moved. |
| `--mem-cap pages` | 2048 | Each defined memory's maximum is lowered to this (in both builds alike), so that a random `memory.grow` cannot take gigabytes; growing past it fails (-1) in both. |
| `--trace N` | 30 | Calls shown before a mismatch. |
| `--log N` | 0 | Print the first N calls with their outcome and import calls, to see what the run exercises. |
| `--verbose` | | In directory mode, print each module's calls per export as well. |
| `--json` | | One JSON object (directory mode: `{identical, modules: [...]}`). |
| `--config f.json` | | Per-module options: `{"examples/browser/lantern.ents": {"init": ["init:1"], "skip": [...], "noMemory": true, "wasiStreams": true, "calls": 5000}}`; a key matches a path with or without `.wasm`, or its end. |

## What it compares

1. **The ABI**, from the binaries: every import (module, name, kind, type)
   in order, every export (name, kind, function type, memory/table limits,
   global type and mutability). Any difference is a mismatch and nothing is
   called.
2. **Instantiation**: both modules are instantiated, each in its own child
   process, with the same stub imports. Whether it trapped, the import calls
   of a start function, the globals and a hash of each memory are compared.
   A memory difference here means the data the module lays out changed.
3. **Calls**: every exported function the host can call (v128 in a signature
   cannot cross to JS; those are listed as not called), round robin
   alternating with a random pick, the same sequence on both. Arguments mix
   edges (0, 1, -1, min, max, powers of two and their neighbours), small
   numbers, addresses inside memory (data segment starts and ends, the
   values of i32 globals, low memory, random aligned addresses, the end of
   memory), random bits, and for floats NaN, infinities, -0, extremes, random
   bit patterns. 60% of calls use "sane" arguments (small numbers and
   in-bounds addresses), 40% the wild mix. A quarter of the time an argument
   is an earlier one of its type or one off it, so that comparisons between
   arguments meet at their boundaries. i64 is a BigInt.
4. **After each call**: the results (floats bit for bit, every NaN equal to
   every NaN), whether it trapped and the trap's message (or `exit(n)` for
   WASI `proc_exit`, `stack overflow`), the import calls with their
   arguments, every exported global (and unexported mutable global), and a
   hash of every memory.
5. The first mismatch ends the module: it prints what differs (for memory,
   the differing byte ranges and their bytes), the calls that led there,
   and whether the failing call alone on fresh instances (after the `--init`
   calls) shows it.

### Stub imports

- Every imported function logs its arguments and returns values from a
  generator seeded by the seed, the import's name and its call count, typed
  by its signature (small numbers mostly, some edges; host references are
  objects with an id, rarely null).
- Imported memories, tables and globals are made to their declared limits
  (globals get a seeded value).
- WASI preview 1: `fd_write` to fds 1 and 2 records the bytes (EBADF for
  other fds, EFAULT for a pointer outside memory); `fd_read` from fd 0 serves
  a stream seeded per call: text (digits, letters, spaces, newlines,
  number words) most of the time, raw bytes sometimes, 0 bytes to 20 KB, half
  the reads short; `proc_exit` ends the call as `exit(code)`;
  `args_*`/`environ_*` report nothing, `clock_time_get` a fixed clock,
  `random_get` seeded bytes, `fd_fdstat_get` a character device; anything
  else returns ENOSYS. Each is logged.

### Timeouts

A call that has not returned after `--timeout` ms in either process kills
both processes, counts as the same outcome in both, starts both again and
replays every earlier call; that function then gets tiny arguments (0 to 16,
or an address). After 5 timeouts it is not called again (noted). When only
one side returns in time, the other gets 5 times longer before the call is a
mismatch. Each timeout costs the timeout plus a replay: `pow.ents` `solve`
(difficulty from the arguments) and loops over a huge count are where it
happens.

## Limits: what it cannot see

- **Functions only reached from tests.** 27 entries (most of
  `examples/types`, `examples/math`, `crypto/blake2b.ents`,
  `generics/set.ents`) export no function, so a debug build has nothing to
  call. Compare their probe builds (`base-probe/`, built by
  `probe-build.ts`), and run `encantis test` (compare with
  `base/tests.txt`). A probe build exports functions under their own names:
  renaming a function or changing its parameters is an ABI difference
  there; use `--only`/`--skip`. Inline and generic functions and functions
  declared inside tests are not exported by a probe build; they are seen
  only through the functions that call them.
- **Deep state.** Paths that need a long, specific sequence of calls are
  rarely reached by random calls: in `browser/lantern.ents` clearing a level
  (collecting every spark) never happens in a random run, so a change in
  what follows a cleared level goes unseen (mutant m8). Games and stateful
  modules need a scripted oracle (replay recorded inputs, or drive the game
  to the state).
- **Structured memory input.** Memory is filled only by the module itself and
  by random scribbles: a function that needs a well-formed structure in
  memory (a valid ed25519 signature, a tree a caller built, a base64 string
  of valid characters with the right length) reaches its deep paths only by
  luck. Groups add specific oracles for those (known-answer vectors, a
  reference implementation, round trips such as encode then decode).
- **Narrow conditions.** A difference that shows for one value in 2^32 is
  found only if an edge or a correlated argument happens to hit it
  (mutant m5, `x > hi` against `x > hi + 1` in `clamp`, was found at call
  1813 of 2000). Use more calls (`--calls 20000`) and other seeds for code
  with such boundaries.
- **Data layout.** A rewrite that moves, adds or removes data changes memory
  from instantiation on: the oracle stops there. `--no-memory` then compares
  results, traps, imports and globals only, which misses a function whose
  output goes to memory (mutant m2b: sha256 writes its hash through a
  pointer). Prefer `--mem-range` over the regions that did not move, or a
  specific oracle that reads the output where each build puts it. Addresses
  a function returns (`commands()` in the games) change with the layout too.
- **Floats through JS.** A NaN's payload cannot be compared (JS may
  canonicalize it), so every NaN equals every NaN.
- **Timing and size.** Speed is not compared; a call that is much slower in
  one build but within 6x the timeout passes. Size is compared separately
  (`sizes.json`).
- **Not called.** Exports with v128 in their signature; tables are compared
  by ABI only (not their contents).
- **Traps by message.** Two different traps with the same message (two
  different out-of-bounds accesses) compare equal; the memory and globals
  after the trap are still compared.

## Self-test (baseline step 4)

- Base against base, every entry, directory mode: 83 of 83 identical, debug
  builds (`baseline/selftest-base-vs-base.txt`) and probe builds
  (`baseline/selftest-probe-vs-probe.txt`). The same seed twice gives the
  same JSON.
- Base debug against base release with `--host-view`: 83 of 83 identical
  (`baseline/selftest-debug-vs-release-hostview.txt`). Without it 17
  test-only modules differ at instantiation, correctly: binaryen drops the
  memory nothing uses, and the default compares unexported memory
  (`baseline/selftest-debug-vs-release.txt`). Compare debug with debug.
- Synthetic modules: a call that hangs in one build only (reported after
  6x the timeout), a trap in one build only, an extra import call, all
  caught; a hidden counter added to one build is not compared (the two have
  different numbers of unexported globals, noted).
- Mutants (`$S/baseline/mutants/mutate.ts`, results in
  `$S/baseline/mutants/results.txt`), each in a copy of `examples/` and
  `lib/` outside both worktrees, built with the base compiler, seed 1:

| Mutant | Change | Result |
|---|---|---|
| m1 | base64url `encode`: `while i + 3 <= len` to `< len` (loop off by one) | caught at call 5, `encode(13, 15, 17, 167)`: result 16 against 12 |
| m2 | sha256 `big-sigma1`: rotation 21 to 22 (constant in code) | caught at call 0 (the hash, in unexported memory); not with `--host-view`, since sha256 exports no memory |
| m2b | sha256 round constant `0x71374491` to `...90` (constant in data) | caught at instantiation (initial memory); not with `--no-memory` |
| m3 | heap `malloc`: `block_size - size` to `size - block_size` (swapped operands) | caught at call 0 (memory) |
| m4 | language-features `fibonacci`: `while i < n` to `<= n`, a function only tests call | debug build identical (nothing exported); probe build caught at call 20 |
| m5 | `clamp`: `x > hi` to `x > hi + 1` (differs at one value) | probe build caught at call 1813 of 2000; with `--only clamp` at call 11, 44, 9, 53 for seeds 2 to 5 |
| m6 | `clamp`: `x > hi` to `x >= hi` (equivalent) | identical, as it should be |
| m7 | tee: read size after the first read 1024 to 1000 (same output) | caught by default (the `fd_read` size); identical with `--wasi-streams --no-memory` |
| m8 | lantern: pause after a cleared level 1.6 to 1.7 s | not caught, with or without `--init init` (deep state, see Limits) |
| m9 | lantern: player speed 5.0 to 5.5 | caught at call 35 (memory: the player's position) |

What this says for use: run the changed entry with the defaults, then with
`--only` on each function you changed (calls concentrate there) and two or
three seeds; for a test-only file compare its probe build; for a data layout
change, a game or a WASI program, read the Limits and add the group's own
check.
