# File Ages in Encantis Repository

This document lists all git-tracked files with their creation and last modification dates.

## Summary

- **Oldest files**: Core language design files from October 2021
- **Most active examples**: `examples/crypto/xxh32/` and `examples/crypto/xxh64/` (June 2024 - January 2026)
- **Deprecated samples**: Located in `samples.deprecated/` - marked as outdated
- **Key documentation**: `syntax.md`, `type-algorithm.md`

## Files by Last Modified Date (Most Recent First)

| File | Created | Last Modified |
|------|---------|---------------|
| examples/Makefile | 2026-01-14 | 2026-01-14 |
| examples/crypto/xxh32/xxh32.wasm | 2026-01-14 | 2026-01-14 |
| examples/crypto/xxh64/xxh64.wasm | 2026-01-14 | 2026-01-14 |
| examples/math/trig/trig.ents.mjs | 2026-01-14 | 2026-01-14 |
| examples/math/trig/trig.ents.wasm | 2026-01-14 | 2026-01-14 |
| examples/math/trig/trig.ents.wat | 2026-01-14 | 2026-01-14 |
| Makefile | 2021-11-04 | 2026-01-14 |
| examples/crypto/xxh32/xxh32.ents | 2024-06-07 | 2026-01-14 |
| examples/crypto/xxh32/xxh32.js | 2024-06-08 | 2026-01-14 |
| examples/crypto/xxh32/xxh32.test.ts | 2024-06-08 | 2026-01-14 |
| examples/crypto/xxh32/xxh32.wat | 2024-06-07 | 2026-01-14 |
| examples/crypto/xxh64/xxh64.ents | 2024-06-07 | 2026-01-14 |
| examples/crypto/xxh64/xxh64.html | 2024-06-07 | 2026-01-14 |
| examples/crypto/xxh64/xxh64.js | 2024-06-07 | 2026-01-14 |
| examples/crypto/xxh64/xxh64.test.ts | 2024-06-07 | 2026-01-14 |
| examples/crypto/xxh64/xxh64.wat | 2024-06-07 | 2026-01-14 |
| examples/math/trig/trig.ents | 2023-05-20 | 2026-01-14 |
| samples.deprecated/gimli.md | 2025-04-30 | 2026-01-14 |
| samples.deprecated/iteration.md | 2025-04-30 | 2026-01-14 |
| samples.deprecated/generated/README.md | 2025-04-07 | 2026-01-14 |
| samples.deprecated/generated/README2.md | 2025-04-07 | 2026-01-14 |
| samples.deprecated/generated/greet.ents | 2025-04-07 | 2026-01-14 |
| samples.deprecated/generated/greet.mjs | 2025-04-07 | 2026-01-14 |
| samples.deprecated/generated/greet.wat | 2025-04-07 | 2026-01-14 |
| samples.deprecated/generated/Makefile | 2025-04-07 | 2026-01-14 |
| samples.deprecated/core/string-mem.ents | 2025-04-02 | 2026-01-14 |
| samples.deprecated/core/compile.mjs | 2025-03-28 | 2026-01-14 |
| samples.deprecated/core/trig.ents.mjs | 2025-03-28 | 2026-01-14 |
| samples.deprecated/core/trig.ents.wat | 2025-03-28 | 2026-01-14 |
| .vscode/extensions.json | 2021-11-06 | 2024-06-07 |
| tools/compile.test.ts | 2024-06-07 | 2024-06-07 |
| tools/compile.ts | 2024-06-07 | 2024-06-07 |
| syntax.md | 2021-10-03 | 2024-05-21 |
| type-algorithm.md | 2023-05-20 | 2023-05-20 |
| tools/encantis-format.js | 2022-01-18 | 2022-01-19 |
| README.md | 2021-11-05 | 2022-04-07 |
| tools/package.json | 2022-01-18 | 2022-01-18 |
| tools/extension.js | 2021-10-12 | 2021-11-05 |
| tools/parse-helpers.js | 2021-10-16 | 2021-11-05 |
| tools/parse-type.js | 2021-10-16 | 2021-11-05 |
| tools/test-parser.js | 2021-10-30 | 2021-11-05 |

## Key .ents Files (Source Examples)

### Active Examples (Recommended for Analysis)

| File | Created | Last Modified | Notes |
|------|---------|---------------|-------|
| examples/crypto/xxh64/xxh64.ents | 2024-06-07 | 2026-01-14 | **Most current** - XXH64 hash implementation |
| examples/crypto/xxh32/xxh32.ents | 2024-06-07 | 2026-01-14 | **Most current** - XXH32 hash implementation |
| examples/math/trig/trig.ents | 2023-05-20 | 2026-01-14 | Trigonometry functions |

### Deprecated Samples (May Be Out of Date)

| File | Created | Last Modified | Notes |
|------|---------|---------------|-------|
| samples.deprecated/generated/greet.ents | 2025-04-07 | 2026-01-14 | Greeting example |
| samples.deprecated/core/string-mem.ents | 2025-04-02 | 2026-01-14 | String/memory handling |
| samples.deprecated/gimli.ents | 2021-11-08 | 2026-01-14 | Gimli permutation (older) |
| samples.deprecated/trie.ents | 2022-01-18 | 2026-01-14 | Trie data structure |
| samples.deprecated/core/hello.ents | 2023-05-13 | 2026-01-14 | Hello world example |
| samples.deprecated/core/hello-simple.ents | 2023-05-13 | 2026-01-14 | Simple hello world |
| samples.deprecated/core/hello-nibs.ents | 2023-05-13 | 2026-01-14 | Nibs encoding example |
| samples.deprecated/core/simple.ents | 2023-05-13 | 2026-01-14 | Simple syntax demo |
| samples.deprecated/core/slice-syntax.ents | 2023-05-13 | 2026-01-14 | Slice syntax demo |
| samples.deprecated/core/middleware.ents | 2023-05-20 | 2026-01-14 | Middleware pattern |
| samples.deprecated/core/hello2.ents | 2023-05-20 | 2026-01-14 | Another hello example |
| samples.deprecated/core/trig.ents | 2023-05-20 | 2026-01-14 | Older trig version |
| samples.deprecated/add.ents | 2021-10-08 | 2026-01-14 | Very old - simple add |
| samples.deprecated/server.ents | 2021-11-02 | 2026-01-14 | Very old - server pattern |
| samples.deprecated/tee.ents | 2021-10-21 | 2026-01-14 | Very old - tee operation |
| samples.deprecated/xxh32.ents | 2024-06-07 | 2026-01-14 | Duplicate of examples/ |
| samples.deprecated/xxh64.ents | 2024-06-07 | 2026-01-14 | Duplicate of examples/ |

## Documentation Files

| File | Created | Last Modified | Notes |
|------|---------|---------------|-------|
| syntax.md | 2021-10-03 | 2024-05-21 | Core syntax documentation |
| type-algorithm.md | 2023-05-20 | 2023-05-20 | Type inference algorithm |
| samples.deprecated/gimli.md | 2025-04-30 | 2026-01-14 | Gimli function explanation |
| samples.deprecated/iteration.md | 2025-04-30 | 2026-01-14 | Iteration semantics |
| samples.deprecated/generated/README.md | 2025-04-07 | 2026-01-14 | Generated code docs |
| samples.deprecated/generated/README2.md | 2025-04-07 | 2026-01-14 | Additional generated docs |
