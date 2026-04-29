# Session Report: Bugs Found & Fixed

## Codegen Bugs Fixed

### 1. For-loop codegen was a stub (infinite loop)
`forToWat` emitted `(loop (br $continue))` without initializing the counter, checking the bound, or incrementing. Fixed to properly emit `local.set $i 0`, `br_if $break (ge $i $limit)`, `local.set $i (add $i 1)`.

### 2. Match default case trapped
Match expressions without a wildcard `_` case generated `(else (unreachable))` for unmatched values. Gimli's `match round & 3` hit this on values 1 and 3. Fix: users must add `_ => {}` for non-exhaustive matches.

### 3. Named return locals on bare return
`return` inside a function with named returns (e.g. `-> (result: u32)`) didn't push the named return values. Fixed `returnToWat` to emit `(local.get $result)` before `(return)` for bare returns.

### 4. Type-punned indexed stores ignored element size
`heap.u32[1] = value` stored at byte offset 1 instead of offset 4. The `assignLvalue` for IndexExpr didn't use element-size-aware offset calculation. Fixed by sharing `indexOffset()` between load and store paths.

### 5. Sub-word stores used wrong instruction
`buf[i] = value` for u8 arrays generated `i32.store` instead of `i32.store8`. Fixed `v128StoreSequence` to emit `i32.store8` for u8/i8 and `i32.store16` for u16/i16.

### 6. Sub-word casts didn't mask
`x as u8` between i32 types was a no-op. Fixed `castToWat` to emit `(i32.and $x (i32.const 255))` for u8, sign-extend for i8, etc.

### 7. Implicit return widening missing
Arrow functions like `func widen(x: u32) -> u64 => x` didn't insert `i64.extend_i32_u`. Fixed `funcToWat` to coerce the body expression type to the declared return type.

### 8. WAT comments broke nested S-expressions
String literal codegen emitted `(i32.const 0) ;; string literal` — the `;;` comment truncated the rest of the line inside nested expressions. Removed all WAT comments from generated code.

### 9. Multi-dim array indexing loaded instead of computing pointer
`sigma[round]` on `*[12,16]u8` generated `(i32.load ...)` instead of just computing the address. When the result type is a pointer (remaining dimensions), `indexToWat` now returns the offset without loading.

### 10. BinaryExpr type key collisions
Nested binary expressions like `a + b == c` shared the same `span.start` offset, causing the outer `==` (type: bool) to overwrite the inner `+` (type: u128). Fixed by recording BinaryExpr types at `span.end` instead of `span.start`.

### 11. Multi-v128 equality chaining
`i32.and` for u512 equality (4 v128 lanes) was passed all 4 values at once instead of chaining: `(i32.and (i32.and (i32.and a b) c) d)`.

### 12. Expression statement drop
Calling a function that returns a value as a statement (for side effects) left the return value on the wasm stack. Fixed `ExpressionStmt` codegen to emit `(drop)` for each return slot.

### 13. Duplicate locals in test functions
Multiple `for i in ...` loops in the same test function generated duplicate `(local $i i32)` declarations. Fixed with deduplication filter.

### 14. Comptime int auto-sizing
Large hex literals like `0x44bc2cf5ad770999` defaulted to i32 and silently truncated. Fixed concretization to pick i64 when the value doesn't fit i32, and larger types up to u4096.

### 15. Mixed-width binary ops
`u32 * u64` returned u32 (left type) instead of u64 (wider type). Fixed `inferBinary` to pick the wider integer type. Codegen now coerces both operands to the result type.

## Checker Bugs Fixed

### 16. Parenthesized expressions typed as tuples
`(x as u64) * 8` — the `(x as u64)` parsed as a 1-element TupleExpr, giving type `(u64)` instead of `u64`. Rather than unwrapping (which broke `(-1):u32` rejection), fixed codegen to unwrap 1-element tuples when looking up operand types.

### 17. comptime_array not handled in extractDataLiteral
`def buf = mut [0:u8; 64]` failed as "not a compile-time constant" because `inferRepeat` returns `comptime_array` which `extractDataLiteral` didn't recognize. Added `comptime_array` case.

## Design Decisions Made

### 18. `def name:[N]T` syntax for buffer reservation
Array type in `def` without initializer auto-allocates zero-initialized mutable memory. `buf` has type `[N]T` (owned array) not `*[N]T` (pointer). Coerces to `*[N]T` or `[]T` at call sites.

### 19. Inline test blocks with shared scope
`test "group" { def ...; func ...; test "case" { ... } }` — defs and funcs inside test groups are only emitted in test mode. Nested tests get prefixed names.

### 20. Enums deferred
The slot-unification stack representation adds implicit compiler complexity. Crypto code uses sentinels, not sum types. Deferred in favor of simpler Zig-style design later.

## Known Limitations (Not Fixed)

### A. Tuple destructuring in test blocks
`let (x:, y:) = swap(10, 20)` inside test function codegen assigns in wrong order. Workaround: use a helper function for destructuring.

### B. Member access on multi-value call results
`swap(10, 20).x` leaves extra values on the stack. Must assign to a local first, then access fields.

### C. v128 exports prevent module instantiation
Bun's wasm engine refuses to instantiate modules with v128 in any export signature, even if those exports are never called from JS. Blake2b functions had to be un-exported for tests.

### D. Blake2b-512 correctness unverified
Blake2b-256 produces correct output. Blake2b-512 compiles but hasn't been tested against reference vectors.

### E. Parenthesized expressions still typed as tuples
`(expr)` parses as `TupleExpr` not `GroupExpr`. The codegen works around it but the checker records `(T)` instead of `T`. A grammar fix (ensuring `(Expr)` matches `group` before `tupleOrStruct`) would be cleaner.

## Test Coverage Summary

80 inline tests across examples:
- **integers.ents**: 22 tests (u1-u512, signed/unsigned, heap, punning, widening, narrowing)
- **language-features.ents**: 13 tests (structs, control flow, floats, globals, loops, sizeof)
- **ringbuf.ents**: 5 tests (FIFO, wraparound, full/empty)
- **sha512.ents**: 3 NIST vectors
- **sha512-256.ents**: 2 NIST vectors
- **blake2b.ents**: 3 tests (first bytes, determinism, abc≠empty)
- **gimli.ents**: 3 tests (spec vector, all-zero, double permute)
- **xxh64.ents**: 4 tests (abc, hello, foobar, seeded)
- **xxh32.ents**: 4 tests (abc, hello, foobar, seeded)
- **xoroshiro128+.ents**: 4 tests (3 outputs + state verification)
- **base64url.ents**: 3 tests (encode, decode, invalid rejection)
- **pow.ents**: 3 tests (solve+verify, rejection, difficulty-8)
- **static/heap/arena allocators**: 7 tests total
- **modular example**: 1 test
- **arithmetic.ents**: 3 tests
