# 🏁 Encantis Crypto Challenge: Ed25519, SHA-512/256, and Beyond

Welcome, agent.

You are competing against other agents to implement a **modern, minimal, high-quality cryptographic stack in Encantis**.

Your goal is not just to make it work.

Your goal is to produce the **cleanest, smallest, safest, and fastest implementation**.

---

# 🧠 Philosophy

This challenge optimizes for:

- **Correctness first**
- **Simplicity over cleverness**
- **Small binary size**
- **Performance on WASM**
- **Clear structure and testability**

You are expected to:
- write code that is easy to review
- minimize hidden complexity
- use Encantis idioms effectively
- build strong feedback loops into your work

---

# 🧱 Target Stack

## Required (Phase 1)

- `base64url`
- `sha512`
- `sha512-256`
- `ed25519` (sign + verify)
- `jws` (compact encoding, EdDSA only)

## Required (Phase 1.5)

- `xxh64` (non-cryptographic hash)

## Phase 2 (Advanced)

- `x25519`
- `hkdf` (based on SHA-512 or SHA-512/256)
- Merkle tree hashing utilities

---

# 🧪 What This Must Enable

Your implementation must support:

## OIDC / JWT
- EdDSA (Ed25519) signing
- JWS compact encoding
- base64url encoding/decoding

## Content-addressed structures
- deterministic hashing of structured data
- Merkle tree roots using SHA-512/256

## Internal hashing
- fast non-crypto hashing (`xxh64`)
- structural hashing of JSON-like values

## Future-ready for P2P
- clean extension path for X25519 + HKDF

---

# 🧩 Architecture Requirements

You must structure your implementation into modules:

```

crypto/
base64url.ents
sha512.ents
sha512_256.ents
ed25519/
field.ents
scalar.ents
group.ents
ed25519.ents
jws.ents
xxh64.ents

(optional later)
x25519.ents
hkdf.ents
merkle.ents

```

---

# 🧪 Feedback Loops (CRITICAL)

You will be judged based on how well you validate your own work.

## 1. Test Vectors (Required)

You MUST include:

- SHA-512 test vectors
- SHA-512/256 test vectors
- Ed25519 test vectors (RFC 8032)
- JWS known-good examples

Your implementation must match these exactly.

---

## 2. Cross-Verification (Required)

You must verify outputs against:

- known libraries (Rust, Node, etc.)
- known RFC outputs

---

## 3. Property Tests (Strongly Encouraged)

Examples:

- `verify(sign(m)) == true`
- hash determinism
- Merkle root stability
- base64url roundtrip

---

## 4. Adversarial Tests

You should include tests for:

- invalid signatures
- malformed encodings
- truncated inputs
- boundary cases (0-length, max-length)

---

## 5. Determinism Checks

All algorithms must be:
- deterministic
- reproducible across runs

---

# 🏗️ Implementation Strategy

## Step 1: base64url

- encode/decode
- no padding
- strict validation

---

## Step 2: SHA-512

- implement full compression function
- support streaming API
- verify against test vectors

---

## Step 3: SHA-512/256

- use SHA-512 core
- use correct IV constants
- output 32 bytes

---

## Step 4: Ed25519

### Submodules

- field arithmetic (`2^255 - 19`)
- scalar arithmetic
- group operations

### Requirements

- deterministic signing
- strict verification
- canonical encoding enforcement

---

## Step 5: JWS (EdDSA)

- compact format:
```

base64url(header) + "." + base64url(payload) + "." + signature

````
- only support:
```json
{ "alg": "EdDSA" }
````

---

## Step 6: xxh64

* fast non-crypto hash
* used for:

  * hash tables
  * structural hashing

---

# 🧠 Design Rules

## 1. Keep Values Small and Explicit

Use structs for arithmetic:

```ents
type Fe = (l0:u64, l1:u64, l2:u64, l3:u64, l4:u64)
```

Avoid generic big integer frameworks.

---

## 2. Separate Byte Layer and Math Layer

* bytes: `*[32]u8`, `[]u8`
* math: structs (`Fe`, `Sc`, etc.)

---

## 3. Use Inline Functions Carefully

* small helpers → inline
* large logic → regular functions

---

## 4. Avoid Hidden Allocations

* arrays are explicit memory objects
* prefer stack/struct values where possible

---

## 5. No Clever Tricks Without Explanation

If something is non-obvious:

* document it
* justify it

---

# ⚡ Performance Goals

You should aim for:

* minimal branches in hot loops
* tight arithmetic loops
* minimal temporary allocations
* reuse buffers where possible

But:

> Never sacrifice correctness for speed.

---

# 🔐 Safety Goals

Your implementation should:

* reject invalid inputs
* avoid undefined behavior
* avoid accidental truncation or overflow errors

Constant-time behavior is ideal, but correctness comes first.

---

# 📦 Binary Size Goals

Smaller is better.

You should:

* reuse SHA-512 for SHA-512/256
* avoid duplicate logic
* avoid unnecessary abstractions

---

# 🏆 Evaluation Criteria

You are competing against other agents.

You will be judged on:

## 1. Correctness

* passes all test vectors
* rejects invalid inputs

## 2. Simplicity

* readable
* minimal moving parts
* clean structure

## 3. Performance

* efficient WASM output
* reasonable throughput

## 4. Size

* compact code
* minimal duplication

## 5. Design Quality

* clear module boundaries
* extensibility (X25519, HKDF later)

---

# 🧭 Bonus Challenges

Optional, but will set you apart:

* implement X25519 using shared field code
* implement HKDF-SHA512
* implement Merkle tree hashing
* implement canonical JSON hashing
* implement SSH Ed25519 signatures

---

# 🧾 Final Reminder

You are not writing a demo.

You are writing:

> a **reference-quality cryptographic foundation for Encantis**

Make it:

* correct
* simple
* beautiful
* hard to break
* easy to extend

---

May your gradients flow, your seed be fertile, and your weights find the global optimum.
