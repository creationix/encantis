# Type System Migration Plan

This document describes the implementation work needed to bring the compiler and examples in line with the redesigned type system documented in `docs/encantis.md`.

## Context

The language design doc (`docs/encantis.md`) was updated on 2026-04-29 with these changes. The compiler still implements the old design. This plan bridges the gap.

## Summary of Design Changes

1. **`[N]T` is a value type** — fixed-size arrays in registers, like tuples. Comptime-only indexing.
2. **`def` is pure substitution** — no memory, no pointers. Just inlines the value.
3. **New `data` keyword** — embeds a literal in the data section, returns a pointer.
4. **Const-by-default pointers** — `*T` is read-only, `*mut T` is writable. Same for `[]T`/`[]mut T`.
5. **`mut` keyword on literals** — forces heap allocation + writability. `mut 5` → `*mut i32`.
6. **Deduplication rule** — const data is deduplicable, mut data gets unique allocations.

## Migration Phases

### Phase 1: Add `data` keyword (grammar + parser + checker + codegen)

This is the smallest useful change. `data` works exactly like today's `def` for memory-backed values.

**Grammar (`encantis-grammar.ohm`):**
- Add `data` as a keyword: add to the keyword list, create `data = "data" ~identChar`
- Add `DataDecl` to `Declaration`: `DataDecl = data ident ":" Type Assign | data ident Assign | data ident ":" Type`
- The grammar is identical to `DefDecl` but with `data` instead of `def`
- `DataDecl` should also be valid as a `TestItem`

**Parser (`encantis-actions.ts`):**
- Add semantic actions for `DataDecl` variants, producing `AST.DataDecl` nodes
- The AST node is structurally identical to `DefDecl` but with `kind: 'DataDecl'`

**AST (`ast.ts`):**
- Add `DataDecl` interface (same shape as `DefDecl`)
- Add to `Declaration` and `TestItem` unions

**Checker (`checker.ts`):**
- Handle `DataDecl` in `checkModule`, `checkTestDecl`, etc.
- `data` ALWAYS produces a pointer type. The checker should:
  - Evaluate the literal value
  - Serialize to the data section (via `pendingLiterals`)
  - Record the symbol as `kind: 'def'` with `value: { kind: 'data_ptr', id }` (reuse existing mechanism)
  - Inferred type: `*[N]T` (tightest pointer). If `mut` is on the literal, `*mut [N]T`.
- The existing `extractDataLiteral` logic in `collectDef` is basically what `data` needs — extract it into a shared function.

**Codegen (`codegen.ts`):**
- Handle `DataDecl` the same way `DefDecl` with `data_ptr` values is handled today
- In `emitTestDecl`, process `DataDecl` items (currently only handles `DefDecl`)

**Important note:** The def scoping fix from this session uses `defKey = name$spanOffset` for test-scoped defs. Apply the same pattern to `data` declarations.

### Phase 2: Migrate examples from `def` to `data`

Every `def` that currently produces a pointer (array literals, string literals, buffer reservations) should become `data`. This is a mechanical search-and-replace guided by the checker:

- `def buf: [N]T` → `data buf = mut [0:T; N]` (mutable buffer reservation)
- `def buf: [N]T = [...]` → `data buf = [...]` or `data buf = mut [...]`
- `def table: *[N]T = [...]` → `data table = [...]`
- `def msg: []u8 = "..."` → `data msg = "..."`
- `def buf = mut [0:u8; N]` → `data buf = mut [0:u8; N]`

Leave scalar `def` unchanged: `def mask51 = 0x7FFFFFFFFFFFF:u64` stays as `def`.

**Files to update (grep for `def.*\[` and `def.*"` and `def.*x"`):**
- `examples/crypto/ed25519/field.ents` — `def mask51` stays, no arrays
- `examples/crypto/ed25519/point.ents` — `def pt-buf: [120]u64` → `data pt-buf = mut [0:u64; 120]`
- `examples/crypto/ed25519/ed25519.ents` — hash-buf, scalar-buf, pt-work, test vectors
- `examples/crypto/sha512/sha512.ents` — IV table, K table, hash state, W buffer, message block
- `examples/crypto/blake2b.ents` — IV, sigma table, state buffers
- `examples/crypto/base64url/base64url.ents` — encode/decode tables
- `examples/crypto/xxh64/xxh64.ents` — prime constants (stay as def), state buffers
- `examples/crypto/gimli/gimli.ents` — state buffer
- `examples/crypto/pow/pow.ents` — state, challenge buffers
- `examples/types/integers.ents` — buf_u8, buf_u16, etc.
- `examples/alloc/*.ents` — heap buffers
- All test blocks with `def name: [N]T` patterns

**Hint:** Many test blocks use `def b: [120]u64` for point buffers or `def s: [32]u8` for scalars. These are mutable buffers written to at runtime, so they become `data b = mut [0:u64; 120]` and `data s = mut [0:u8; 32]`.

### Phase 3: `[N]T` as value type

This is the biggest change. Currently `[N]T` in `def` silently becomes `*[N]T`. After this phase, `[N]T` is a value type — N values in registers.

**Checker changes:**
- `[N]T` resolves to a value type (like tuples), not a pointer
- Indexing `[N]T` only allowed with compile-time constant indices
  - but if we're already indexing into something heap allocated, dynamic access works like normal.  structs may have inline fixed-width arrays and dynamic access works (within bounds) as calculated offsets
- Dynamic indexing on `[N]T` (when not heap allocated) produces a clear error: "dynamic index requires a pointer type — use `*[N]T` or `[]T`"
- `[N]T` flattens to N wasm values, like tuples
- `[N]T` where N × sizeof(T) is too large should warn (suggested limit: 16-32 values)

**Codegen changes:**
- `[N]T` lowers to N locals (like tuples)
- `v[0]`, `v[1]` on a value `[N]T` generates `local.get $v_0`, `local.get $v_1`
- Codegen for `[N]T` parameters: flatten to N params
- Codegen for `[N]T` returns: N return values
- Assignment `v[i] = x` where `i` is comptime: `local.set $v_i`
- This is essentially the same as anonymous tuple codegen with `.0`, `.1` access

**Key insight from this session:** Anonymous tuples `(u64, u64, u64, u64, u64)` already work as value types with `.0`-`.4` access. `[5]u64` should generate identical wasm — just with `[i]` syntax instead of `.N`. The codegen can reuse the tuple flattening infrastructure.

### Phase 4: Const-by-default pointers

**Grammar:**
- Allow `mut` in type positions: `*mut T`, `[]mut T`, `[*]mut T`
- The `mut` keyword already exists in the grammar as a UnaryExpr prefix
- Need to extend `Type` rules to accept `mut` modifier

**Checker:**
- Add `mutable: boolean` field to pointer/slice/manyPointer resolved types
- Default to `false` (const)
- `mut` on a literal expression sets the mutable flag on the resulting pointer type
- Type assignability: mutable → const is OK, const → mutable is error
- Check assignments through pointers: `p[i] = x` requires `p` to be `*mut`
- Check `.*` store: `p.* = x` requires `*mut T`

**Codegen:**
- No wasm-level changes needed — mutability is a compile-time check only
- The actual memory stores are the same regardless of const/mut

**Data packer:**
- Track mutability on each data section entry
- Deduplicate entries that are const and have identical content
- Never deduplicate mut entries

**Important:** This is a breaking change for all existing code that writes through pointers. Every function that mutates through a pointer parameter needs `mut` in the type. Plan for a migration period or batch-update all examples.

### Phase 5: `def` cleanup

After phases 1-4, `def` should ONLY produce inline constants. Any remaining `def` that produces a pointer is a bug.

- Audit all `def` declarations
- Verify none produce `data_ptr` values
- Remove `extractDataLiteral` from `collectDef` (move it to `collectData`)
- `def` with array/string literal on RHS becomes a comptime value (inlined), NOT a pointer

## Testing Strategy

- After each phase, run `bun test` and `bun packages/cli/src/cli.ts test examples/`
- The test suite currently has 375 unit tests and 121 example tests
- Ed25519 key derivation (RFC 8032 test vector) is a good integration test
- Add unit tests for new `data` keyword in `checker.test.ts` and `codegen.test.ts`

## Known Issues from This Session

1. **`def` name collisions in test blocks** — Fixed with span-based mangling (`name$offset`). Apply the same fix to `data` declarations.

2. **`checkFuncBody` scope chain** — Fixed: function scopes now parent to `currentScope` (not `moduleScope`). Important for test-local functions accessing test-local `data` declarations.

3. **Bidirectional type inference for arrow bodies** — Fixed: arrow body expressions are now checked against the return type. This enables `(0, 0, 0, 0, 0)` to infer as `(u64, u64, u64, u64, u64)` from the return type.

4. **Assignment type propagation** — Fixed: assignments propagate target type to value for scalar targets. Important for `data buf = mut [0:u8; 1024]` where the literal needs to know the element type.

5. **Multi-dimensional array indexing** — Broken in codegen. `buf[1][2]` on a `[N,M]T` generates incorrect pointer loads. This needs fixing but is separate from the type system migration.

6. **Nested struct codegen** — Tuples of tuples (like `type Point = (x: Fe, y: Fe, z: Fe, t: Fe)`) don't flatten correctly. The Ed25519 point module works around this by using flat memory buffers. Fixing this is separate.

7. **`&` operator is a no-op in codegen** — It returns the operand unchanged. This was fine when `def` arrays were already pointers, but with the new design `&` might need real semantics (address-of for values on the stack). Consider deferring this or making `&` an error until properly implemented.

## Recommended Order

Phase 1 → Phase 2 → Phase 5 → Phase 3 → Phase 4

Do `data` keyword first (it's additive, nothing breaks). Migrate examples. Clean up `def`. Then tackle value-type `[N]T` (biggest codegen change). Finally add const/mut (biggest checker change, touches all examples).

Phases 3 and 4 can be done independently of each other.
