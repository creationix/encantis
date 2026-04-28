# Constant-Time Guidance

## Non-goal

Encantis does not currently guarantee constant-time codegen for any construct. The patterns below are best-effort based on how the compiler currently lowers to WebAssembly. WASM engines may further transform code in ways that break constant-time properties.

## Reliably constant-time

These compile to fixed-cost WASM instructions with no branches:

- **Bitwise ops** (`&`, `|`, `^`, `~`) — always a single instruction
- **Shifts and rotates** (`<<`, `>>`, `<<<`) — always a single instruction
- **Add, sub, mul** — always a single instruction
- **Integer comparisons returning bool** (`==`, `!=`, `<`, `>`, `<=`, `>=`) — compile to a single comparison instruction

## Conditional select (cmov idiom)

WASM has no `cmov` instruction. Use the bitwise select pattern:

```encantis
// Constant-time select: returns a when mask is all-1s, b when mask is all-0s
func ct_select(mask: u64, a: u64, b: u64) -> u64 {
  return (mask & a) | (~mask & b)
}
```

For boolean conditions, first expand to a full mask:

```encantis
// Convert bool (0 or 1) to mask (0x0 or 0xFFFFFFFFFFFFFFFF)
func bool_to_mask(b: u64) -> u64 {
  return 0 - b
}
```

## DO NOT use on secret data

- **`if` / `match` on secrets** — compiles to branches; timing varies with the taken path
- **Memory access at secret indices** — cache-timing side channel; WASM engines don't guarantee constant-time memory access
- **Division / modulo on secrets** — some engines use variable-time algorithms

## WASM SIMD (u128)

v128 bitwise operations (`v128.and`, `v128.or`, `v128.xor`, `v128.not`) are constant-time on all known engines. The cmov pattern works identically on u128:

```encantis
func ct_select128(mask: u128, a: u128, b: u128) -> u128 {
  return (mask & a) | (~mask & b)
}
```
