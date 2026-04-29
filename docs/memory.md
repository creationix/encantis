# Memory in Encantis

## No conventions

Encantis has **no memory-layout conventions**. There is no reserved offset, no required export beyond memory itself, no "heap base," no implicit allocator, and no notion of "input scratch" or "output scratch."

The language gives you four primitives:

- `memory` — declares linear memory (optional; implicit when static data exists)
- `def` / `def mut` — compile-time constants and static data buffers
- `global` — mutable module-level variables
- `memory-grow` — grow linear memory at runtime (not yet implemented)

Everything else is library code. The program is in complete control.

## Three reference patterns

These are *examples and starting points, not requirements*. You are free to write your own allocator, ignore these entirely, or mix and match. A smaller, algorithm-tailored allocator may outperform a generic one.

### 1. Static reservation (no allocator)

Declare a fixed-size mutable buffer at compile time. The program owns N bytes at a known offset. No free-lists, no bump pointers.

```encantis
def buf:[4096]u8
global cursor: u32 = 0

func reserve(size: u32) -> u32 {
  return 0xFFFFFFFF when cursor + size > 4096
  let offset = cursor
  cursor += size
  return offset
}
```

**When to use:** Fixed-size working memory where the total is known at compile time. SHA-512 state buffers, base64url scratch, JWS assembly. Most crypto primitives reach for this.

### 2. Heap allocator (malloc/free)

General-purpose allocator backed by a static buffer. Tagged-block design: each block has an 8-byte header (size + free flag).

```encantis
import "./heap" (
  "malloc" func malloc(size: u32) -> u32
  "free" func free(ptr: u32)
)
```

**When to use:** Dynamic allocation with explicit lifetime management. Data structures with unpredictable sizes.

### 3. Arena allocator (bump within malloc'd chunk)

An arena owns a chunk obtained via `malloc`. Allocation bumps a cursor; `arena_reset` drops back to start; `arena_free` returns the chunk to the heap.

```encantis
import "./arena" (
  "arena_init" func arena_init(size: u32)
  "arena_alloc" func arena_alloc(size: u32) -> u32
  "arena_reset" func arena_reset()
  "arena_free" func arena_free()
)
```

**When to use:** Many small allocations with a shared lifetime. Ed25519 scratch buffers, intermediate computations that all get discarded together.

## memory-grow ownership

`memory-grow` is called by the heap allocator when its backing store is exhausted. Static reservation never grows. Arenas grow indirectly through the heap. The language has no opinion on who calls `memory-grow` — it's just another instruction available to any code.

## No standard exports

Beyond `memory` (if exported), nothing is fixed. The program declares whatever entrypoints and buffers it wants. The host harness discovers them by reading the wasm export table. There is no "standard" memory layout, no required buffer names, and no coordination on offsets between modules.

## Host discovery pattern

The host reads the wasm export table to find:
- Memory (`WebAssembly.Memory`)
- Functions (entrypoints, buffer accessors)
- Globals (if exported)

No prior coordination needed — the host adapts to whatever the program exports.
