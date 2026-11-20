# Function values and indirect calls: the recommended design

For the owner, who asked on 17 Nov 2026: "we want real indirect calls, but let's consider carefully. Encantis should
have little magic in the wasm translation (despite the name, lol)".

- **Base.** Worktree `<scratch>/methods` (branch `claude/method-calls`, HEAD 5fca5c9), read only. Paths without
  a directory are in `packages/compiler/` there; line numbers are of that worktree unless a path says otherwise.
- **What it builds on.** The judges' winner, [DESIGN-minimal.md](DESIGN-minimal.md), with the grafts both judges named
  ([JUDGE-owner.md](JUDGE-owner.md), [JUDGE-engineer.md](JUDGE-engineer.md)) and a fix for every flaw they found.
  Appendix B lists each flaw, what I checked myself, and what this document does about it. The research is in
  [NOTES-language.md](NOTES-language.md) and [NOTES-wasm.md](NOTES-wasm.md).
- **Validation.** Every WAT block below is a file in `exp/final/`. Each was assembled with the compiler's own wabt 1.0.39
  and flags, parsed again with every post-MVP feature turned off, optimized with the CLI's `wasm-opt -Oz` flags, and run
  on bun 1.4.4 and node 22.23.4, before and after optimization (Appendix A). The Encantis sources cannot be compiled
  yet; each WAT block is M's output for the same program with a `u32` in place of each function value, edited by hand
  where this design changes it. Scratch-local numbers such as `$__coal_idx_388` are source offsets and illustrative.

## Summary

A function value is one `i32`: the function's **slot**, its index in the program's one wasm table, `$slots`. Only the
functions whose value the program takes have a slot. They are numbered from 1 in the order they stand in the WAT, and
slot 0 is never filled, so 0 means none. The compiler adds two module-level lines, a table and one element segment
that lists the slotted functions in slot order. It adds them only to a program that takes, calls or exports a
function value, so every other program compiles to the same bytes as today. A function's name used as a value is
`(i32.const k)`. A call of a value is one `call_indirect $slots` with the function type's flattened signature written
inline. A call of a function by its name, and a call of a comptime function parameter, stays a direct `call`. In
memory and in `data` a function value is 4 bytes, its slot. A plain function type has no default and is never none;
`?(A) -> R` is the optional one, resolved with `if let` and `??` as `?*T` is. Function values compare with `==` and
`!=` and cast only to `u32` and `i32`. The output is plain wasm MVP: no new engine feature, no assembler or wasm-opt
flag, no harness change. This is the model the reference already states ("function values are opaque indices into
WebAssembly's function table", docs/encantis.md:1131). What it adds is the numbering rule, and the element segment
spells the numbering out in one line.

## Source to wasm: the five common forms

| You write | The wasm is |
|---|---|
| a function's name as a value: `apply(inc, y)` | `(call $apply (i32.const 1) (local.get $y))`: `1` is `inc`'s slot |
| a call of a value: `f(x)`, with `f: (u32) -> u32` | `(call_indirect $slots (param i32) (result i32) (local.get $x) (local.get $f))` |
| a call by name: `inc(x)` | `(call $inc (local.get $x))`, unchanged |
| a comparison: `f == g` | `(i32.eq (local.get $f) (local.get $g))` |
| values in data: `data ops = [inc, dbl]` | `(data (i32.const 8) "\01\00\00\00\02\00\00\00")` |

Once per program that has any of these, after the memory (or after the imports when there is no memory):

```wat
  (table $slots 3 3 funcref)
  (elem (i32.const 1) func $inc $dbl)  ;; slot 1 = $inc, slot 2 = $dbl
```

## 1. The convention

### 1.1 A function value is a slot

A value of a function type is one wasm `i32`, the slot of a function of that type. The functions that have a slot are
in one wasm table, `$slots`, whose elements are `funcref`. Slot 0 of the table is never filled. The number 0 is
therefore never the slot of a function, and it is what an optional function value holds when it is none.

This is the lowering function types already have. `typeToWasm` gives `func` one `i32` (codegen.ts:151-153, "Function
references are table indices"), so parameters, locals, results, struct fields, globals and host-import parameters keep
the wasm types they have today. Only `identToWat` disagrees today: it emits `(ref.func $f)` where an `i32` is declared
(codegen.ts:388-394), which is why no program that passes or stores a function value has ever assembled.

The word "table" already means a `*[N][M]T` of row pointers in Encantis (ref 2.5, docs/encantis.md:345 and :427-456).
The reference and the error messages therefore never call the wasm table a table. A function value is a *slot*, the
functions that have one are *the program's slots*, and the declaration that hands them to the host is
`export slots`. In WAT, where `table` is the only word wasm has, the table is named `$slots`.

### 1.2 Which functions have a slot

A function **has a slot** when its value is taken, that is, when its name is written as a value, anywhere except as
the callee of a call. `f(x)` and `x.f()` call `f`; `g(f)`, `let h = f`, `f == h`, `Handler(f, 1)`, `[f, g]`,
`return f` and `f as u32` take its value. Parentheses do not change this: `(inc)(x)` is the call `inc(x)` (decision
9). Section 2 lists every form a value can take.

- A value counts where it is written in code the build emits: the body of an emitted function (an instance of a
  generic included), a global's initializer, a `data` literal, and, in a test build only, a `test` block.
- Every function of every loaded module is emitted (codegen.ts:3688-3699), so a value taken in a function nobody calls
  still gives a slot. A generic that is never instantiated emits nothing, so a value taken in its body gives none.
- A comptime function argument (`sort(xs, ascending)`, ref 8.6) is not a value: it names the function at compile time
  and the instance calls it directly.
- The functions listed in `export slots = [...]` (section 8.3) have slots whether or not their value is taken.

### 1.3 Slot numbers

Slots are numbered 1, 2, 3, ... in this order:

1. the functions listed in `export slots = [...]`, in the order written, when the entry module has such a list;
2. the other functions whose value is taken in code that a release build emits, in the order the functions stand in
   the WAT. That is the wasm function index order: host imports first, in the order they are declared, module by
   module; then the entry module's functions; then each other source module, in the order the loader first reaches it
   (depth first, loader.ts:58-104); inside a module in declaration order, with a generic's instances in its place,
   sorted by instance name (`funcsInOrder`, codegen.ts:3140-3162);
3. in a test build, the functions whose value is taken only in tests (functions and host imports declared in tests
   included), in the same order.

So the k-th name in the element segment has slot k, and the compiler repeats the list as a comment after the segment
(`;; slot 1 = $inc, slot 2 = $dbl`). A reader never has to count.

Group 3 is there so that a test build does not move a release build's slots. Without it, a value taken only in a
test, or a host import declared in a test (programToWat interleaves those per module, codegen.ts:3627-3653), would
renumber every later slot, and the release functions' WAT would differ between the two builds. With it, the WAT of
every release function is the same in both. Here is one program in both builds (`exp/final/f14-release.wat` and
`f14-test.wat`):

```ents
func inc(x: u32) -> u32 => x + 1
func dbl(x: u32) -> u32 => x * 2
func apply(f: (u32) -> u32, x: u32) -> u32 => f(x)
export func go(x: u32) -> u32 => apply(dbl, x)
test "apply" {
  assert apply(inc, 1) == 2
}
```

```wat
;; release build
  (table $slots 2 2 funcref)
  (elem (i32.const 1) func $dbl)  ;; slot 1 = $dbl
;; test build
  (table $slots 3 3 funcref)
  (elem (i32.const 1) func $dbl $inc)  ;; slot 1 = $dbl, slot 2 = $inc (tests only)
```

`$go` is `(call $apply (i32.const 1) (local.get $x))` in both. In plain WAT order `$inc` would be slot 1 in the test
build and `$go` would pass 2.

Slot numbers are still a property of one build of one program. Taking the value of a function that stands earlier in
the WAT moves the later ones up by one, and nothing promises a number across compiler versions. Code inside the
program never sees this: it writes names, and its `data` is laid out by the same build. A host either looks a slot up
(section 8.3) or pins the numbers with `export slots = [...]`.

### 1.4 What is emitted, and when

The table is emitted when the build has a slotted function, calls a function value, or the entry module declares
`export slots`. Otherwise nothing is emitted, and the module is byte for byte what it is today. With `n` slotted
functions:

```wat
  (table $slots N N funcref)                 ;; N = n + 1
  (elem (i32.const 1) func $f1 $f2 ... $fn)  ;; slot 1 = $f1, ..., slot n = $fn   (only when n > 0)
```

- They stand after the `(memory ...)` line, or after the imports when there is no memory. In the binary, sections have
  a fixed order anyway; the place in the WAT is for the reader.
- **The size** is what the program fills: minimum = maximum = n + 1, as clang and wasm-ld make it without
  `--growable-table`. Nothing in the program grows the table. With `export slots` there is no maximum, so that the host
  can grow it (section 8.3, decision 8).
- **The segment** is one active segment in the MVP form (binary flag 0: table 0, an offset expression, function
  indices; Appendix A shows the bytes `01 00 41 01 0b ...`). It is written without `(table $slots)`. That is not about
  the encoding: wabt writes flag 0 for `(elem (table $slots) (i32.const 1) ...)` too (judge's `j1-flag.wat`). It is
  because the short form is the MVP text form. It parses with wabt's `bulk_memory` and `reference_types` turned off,
  and the long form does not (`unexpected token "(", expected an offset expr`, checked with `exp/final/probe/j1b.mjs`).
- **A program that calls a function value but takes none** (an exported function that the host gives a callback) gets
  `(table $slots 1 1 funcref)` and no segment (`f10-calls-only.wat`). `call_indirect` needs a table to validate. Every
  call of such a value traps, unless the host fills slots, which it can only do with `export slots`.
- **The comment** after the segment costs no bytes. There is deliberately no comment next to each `(i32.const k)`: the
  codegen's own analyses read the WAT text (`isSimple`, codegen.ts:494, matches `(i32.const 1)` exactly), and a slot
  must stay a plain constant to them. The editor shows the name instead (hover and inlay hint `inc: slot 1`, stage 8).
- **Size.** The table section is 7 bytes (6 with no maximum), and the element section is 8 + n bytes while function
  indices stay below 128 (Appendix A).

### 1.5 Function types

Function types keep their syntax (`Type = BaseType "->" Type`, encantis-grammar.ohm:146-147; ref 3.4). Parameter and
result names are not part of the type. That is already true for assignability (types.ts:866-881) and for instance keys
(`canonicalKey`, types.ts:1341-1344), but `typeEquals` compares the names (types.ts:503-511 through `fieldEquals`,
:540-542). It must ignore them for `func`, so that `==`, widening to `?F` and picking by expected type all agree with
assignability (stage 1b).

A function type may name itself, as a pointer type may: `type State = (c: u8) -> State` is a state whose value is the
function that reads the next byte and returns the next state. M already accepts it (`exp/final/probe/t1.ents`); with
values it runs (section 6.5).

**Optional function types** are new: `?` before a function type, or before the name of one.

```ents
type Hook = (key: u32) -> ()
global on_key: ?Hook = 0
func find(name: []u8) -> ?(u32) -> u32 => 0
```

`?` takes the whole function type to its right, as `*` already does (`*i32 -> i32` is `*(i32 -> i32)`): `?(u32) -> ()`
is an optional `(u32) -> ()`. Parentheses cannot help, because `(?(u32) -> ())` is a one-field tuple. That is why
`?Name` exists: `?Hook` is the readable spelling, and the reference shows it first. `?Name` is the optional of the
pointer, slice or function type the name stands for (`?Point` is an error), which also gives aliases of pointer types
an optional spelling they lack today. `?` before a number type or a tuple stays an error.

## 2. Taking a function's value

Each of these, written where a value is, is a function value, and gives the function a slot:

| Written | Is the value of |
|---|---|
| `inc`, a function of the module | `inc`: `(i32.const <slot of inc>)` |
| `log`, a host import `import "env" "log" func log(x: u32)` | the import; an element segment may list imported functions (NOTES-wasm e06) |
| `pick`, imported from a source module | that module's function, `$lib$pick`; the name it is imported under does not matter |
| `before`, a comptime function parameter, inside an instance | the function it was given (section 9) |
| `hash`, a name several functions share, where a function type is expected | the one function of exactly that type (below) |
| a function declared in a `test` | that function, in test builds |

A name several functions share picks by the expected type. A call picks by its arguments; a value has no arguments,
so the type it is expected to have plays their part. Where a function type is expected (a variable's type, a
parameter's, a field's, a result's, an assignment's target, the other operand of `==`, an element of an array literal
whose element type is known), the shared name is the one function of that name whose type is exactly the expected
one, parameter names ignored. Functions that share a name have different parameter types (ref 3.4), so at most one can
match. With no expected function type, or one no member has, it is an error (section 14).

```ents
func hash(x: u32) -> u32 => x * 3
func hash(x: u8) -> u32 => 7
func apply8(f: (u8) -> u32, x: u8) -> u32 => f(x)
export func h(x: u8) -> u32 => apply8(hash, x)    // hash(x: u8): the parameter's type says which
```

```wat
(module
  (table $slots 2 2 funcref)
  (elem (i32.const 1) func $hash:u8)  ;; slot 1 = $hash:u8
  (func $hash (param $x i32) (result i32)
    (i32.mul (local.get $x) (i32.const 3))
  )
  (func $hash:u8 (param $x i32) (result i32)
    (i32.const 7)
  )
  (func $apply8 (param $f i32) (param $x i32) (result i32)
    (call_indirect $slots (param i32) (result i32) (local.get $x) (local.get $f))
  )
  (func $h (param $x i32) (result i32)
    (call $apply8 (i32.const 1) (local.get $x))
  )
  (export "h" (func $h))
)
```

`f11-overload.wat`: `h(9)` = 7.

These are not values, and each is an error with its own message (section 14):

- a **builtin** (`sqrt`, `min`, `clz`): it is an instruction, not a function, so there is nothing to put in a slot. Write
  a function that calls it.
- a **method without its call**, `x.inc`: the value would carry its receiver, which is a closure (section 10). The
  function's own value is written `inc`.
- a **generic**: `max` alone is still not a value (ref 8.1 rule 3) until stage 9, which lets an expected function type
  pick the instance, by the same rule as for a shared name.
- a **shared name where no function type is expected**, and a **type** (`Point(...)` is a constructor, not a function).

## 3. Calling a function value

### 3.1 Which calls are indirect

A call whose callee, with any parentheses around it removed, is the name of a function is what it is today: a direct
`call`, a call of an instance, a builtin, or a constructor. So is a call of a comptime function parameter, which the
instance turns into a direct call (checker.ts:3263-3268). Every other callee of a function type is a value, and its call
is `call_indirect`: a parameter, a local or a global (`f(x)`), a field (`h.run(h.arg)`), an element (`ops[1](x)`), a
call that returns a function (`pick(up)(x)`), an `if`, a `??`.

The call is written

```wat
(call_indirect $slots (param P...) (result R...) <arguments> <callee>)
```

where `P...` and `R...` are the callee's function type flattened exactly as a declaration's parameters and results
are (ref 9.2, 9.3): a struct is one wasm value per field, a slice is `i32 i32`, `-> ()` has no `(result ...)`. The
signature is written inline, so the WAT holds no `(type ...)` declaration. wabt points the instruction at the type
entry of that signature, which is the one functions of that signature already use, or a new one (section 11, item 6).

### 3.2 Arguments

Arguments are checked against the parameter types of the callee's function type, with the conversions every call has
(a narrower number widened, `*mut T` to `*T`, an array pointer to a slice). Codegen takes the parameter types from the
callee's type instead of from a function symbol (the coercion in `callToWat`, codegen.ts:1086-1114).

### 3.3 Evaluation order

The callee is computed first, then the arguments left to right, then the call is made: the order in which they are
written, which is the owner's rule for every expression (decision Q7, reference 2.8 on branch `claude/dec-named`, commit
93aa6ec). `call_indirect` takes the slot last, after the arguments. So the compiler writes the callee's code after the
arguments' code where nobody can tell the difference, and otherwise computes it first into a scratch local.

The test is the one the written-order rule already uses for constructors (`inFieldOrder` on `claude/dec-named`). A
part of the call, the callee or one argument, is **free to move** when nothing before or after it can tell when it
runs: a constant, a local that no other part of the call sets, or arithmetic of those that cannot trap. A call, a load,
a global read, or anything that can trap is not free to move. The callee is written last, as it is, when it is free
to move or when every argument is. Otherwise it is computed first, `(local.set $__tmp_N <callee>)`, and read last,
`(local.get $__tmp_N)`. (The implementation can compile the call as the written tuple `(callee, arguments...)` put in
the order `(arguments..., callee)`, with the same routine.)

| Call | Callee | Arguments | WAT |
|---|---|---|---|
| `f(x)`, `f` a parameter | free | free | callee last |
| `current(x)`, `current` a global | not free | free | callee last |
| `pick(up)(x)` | not free | free | callee last |
| `f(g(y))`, `f` a parameter | free | not free | callee last |
| `next_op()(arg())` | not free | not free | scratch local |
| `h.run(h.arg)`, `h: *Handler` | not free (a load) | not free (a load) | scratch local |
| `h.run(h.arg)`, `h: Handler` in registers | free | free | callee last |

```ents
global step: u32 = 0
func inc(x: u32) -> u32 => x + 1
func dbl(x: u32) -> u32 => x * 2
func next_op() -> (u32) -> u32 {
  step += 1
  return if step % 2 == 0 { inc } else { dbl }
}
func arg() -> u32 {
  step += 10
  return step
}
export func run() -> u32 => next_op()(arg())       // dbl(11) = 22: next_op ran first
export func run2(x: u32) -> u32 => next_op()(x)    // x is free to move: no scratch local
```

```wat
(module
  (table $slots 3 3 funcref)
  (elem (i32.const 1) func $inc $dbl)  ;; slot 1 = $inc, slot 2 = $dbl
  (func $inc (param $x i32) (result i32)
    (i32.add (local.get $x) (i32.const 1))
  )
  (func $dbl (param $x i32) (result i32)
    (i32.mul (local.get $x) (i32.const 2))
  )
  (func $next_op (result i32)
    (global.set $step (i32.add (global.get $step) (i32.const 1)))
    (if (result i32) (i32.eq (i32.rem_u (global.get $step) (i32.const 2)) (i32.const 0)) (then (i32.const 1)) (else (i32.const 2))) (return)
    (unreachable)
  )
  (func $arg (result i32)
    (global.set $step (i32.add (global.get $step) (i32.const 10)))
    (global.get $step) (return)
    (unreachable)
  )
  (func $run (result i32)
    (local $__tmp_0 i32)
    (call_indirect $slots (param i32) (result i32) (local.set $__tmp_0 (call $next_op)) (call $arg) (local.get $__tmp_0))
  )
  (func $run2 (param $x i32) (result i32)
    (call_indirect $slots (param i32) (result i32) (local.get $x) (call $next_op))
  )
  (global $step (mut i32) (i32.const 0))
  (export "run" (func $run))
  (export "run2" (func $run2))
)
```

`f07-order.wat`: `run()` = 22. The other order would give 20.

The rule is deliberately the conservative one of constructors: two loads from one pointer, `h.run(h.arg)`, get a
scratch local although only the order of two identical traps could tell them apart. One rule for every expression is
easier to predict than a sharper rule for calls alone, and `wasm-opt -Oz` removes the local (in f04 it inlines `fire`
into `second` and reads the two fields in either order).

### 3.4 Method-call spelling

`x.f(a)` is `f(x, a)` when `x` has no member `f` (ref 4.9). That stays the whole rule. When `f` is a variable of a
function type (a parameter, a local, a global), `f(x, a)` is a call of that value, and so is `x.f(a)`: `x.f().f()` is
`f(f(x))`. Today only a function, a generic or a builtin can be reached this way (`callable`, checker.ts:3679). Members
still win: `h.run(...)` calls the field `run` even where a variable `run` exists (checker.ts:3381-3396).

### 3.5 What the call does at run time

`call_indirect` checks that the slot is inside the table, that the slot is filled, and that the function in it has the
signature written at the call. For a value the program made, all three hold by construction. For a number from the
host they may not, and the call traps; it never calls a function of another wasm signature. Both engines fold "slot
empty" into the signature check (NOTES-wasm e01; reproduced in Appendix A):

| Case | node 22 (V8) | bun 1.4.4 (JSC) |
|---|---|---|
| slot 0, or a function of another wasm signature | `RuntimeError: null function or function signature mismatch` | `RuntimeError: call_indirect to a signature that does not match` |
| a slot past the end | `RuntimeError: table index is out of bounds` | `RuntimeError: Out of bounds call_indirect` |

The check compares wasm signatures, not Encantis types: `(u32) -> u32` and `(*u8) -> bool` are both
`(param i32) (result i32)`. Inside the language a value is always a slot the program took (sections 4 and 5), so this
matters only for numbers that come from the host, from memory the host wrote, or from past the end of an unchecked
many-pointer.

### 3.6 Example: bug 10

```ents
func apply(f: (u32) -> u32, x: u32) -> u32 => f(x)
func inc(x: u32) -> u32 => x + 1
func dbl(x: u32) -> u32 => x * 2
export func go(y: u32) -> u32 => apply(inc, y) + apply(dbl, y)
```

```wat
(module
  (table $slots 3 3 funcref)
  (elem (i32.const 1) func $inc $dbl)  ;; slot 1 = $inc, slot 2 = $dbl
  (func $apply (param $f i32) (param $x i32) (result i32)
    (call_indirect $slots (param i32) (result i32) (local.get $x) (local.get $f))
  )
  (func $inc (param $x i32) (result i32)
    (i32.add (local.get $x) (i32.const 1))
  )
  (func $dbl (param $x i32) (result i32)
    (i32.mul (local.get $x) (i32.const 2))
  )
  (func $go (param $y i32) (result i32)
    (i32.add (call $apply (i32.const 1) (local.get $y)) (call $apply (i32.const 2) (local.get $y)))
  )
  (export "go" (func $go))
)
```

`f01-apply.wat`, 99 bytes: `go(5)` = 16. In 0.2.1 the same program compiled to `(call $f (local.get $x))` and
`(call $apply_u32 (ref.func $inc) ...)`, which wabt rejects (NOTES-language 3).

### 3.7 Example: locals, a global, a returned function, `==`, `as`, a field, the method spelling

```ents
type Handler = (run: (u32) -> u32, arg: u32)
global current: (u32) -> u32 = inc
func inc(x: u32) -> u32 => x + 1
func dbl(x: u32) -> u32 => x * 2
func pick(up: bool) -> (u32) -> u32 => if up { inc } else { dbl }
export func use_global(x: u32) -> u32 => current(x)
export func set_global(up: bool) { current = pick(up) }
export func same(a: bool, b: bool) -> bool => pick(a) == pick(b)
export func slot_of_dbl() -> u32 => dbl as u32
export func fire(run: (u32) -> u32, arg: u32) -> u32 {
  let h = Handler(run, arg)
  return h.run(h.arg)
}
export func twice(x: u32, f: (u32) -> u32) -> u32 => x.f().f()     // f(f(x))
```

```wat
(module
  (table $slots 3 3 funcref)
  (elem (i32.const 1) func $inc $dbl)  ;; slot 1 = $inc, slot 2 = $dbl
  (func $inc (param $x i32) (result i32)
    (i32.add (local.get $x) (i32.const 1))
  )
  (func $dbl (param $x i32) (result i32)
    (i32.mul (local.get $x) (i32.const 2))
  )
  (func $pick (param $up i32) (result i32)
    (if (result i32) (local.get $up) (then (i32.const 1)) (else (i32.const 2)))
  )
  (func $use_global (param $x i32) (result i32)
    (call_indirect $slots (param i32) (result i32) (local.get $x) (global.get $current))
  )
  (func $set_global (param $up i32)
    (global.set $current (call $pick (local.get $up)))
  )
  (func $same (param $a i32) (param $b i32) (result i32)
    (i32.eq (call $pick (local.get $a)) (call $pick (local.get $b)))
  )
  (func $slot_of_dbl (result i32)
    (i32.const 2)
  )
  (func $fire (param $run i32) (param $arg i32) (result i32)
    (local $h_run i32)
    (local $h_arg i32)
    (local.set $h_run (local.get $run))
    (local.set $h_arg (local.get $arg))
    (call_indirect $slots (param i32) (result i32) (local.get $h_arg) (local.get $h_run)) (return)
    (unreachable)
  )
  (func $twice (param $x i32) (param $f i32) (result i32)
    (call_indirect $slots (param i32) (result i32) (call_indirect $slots (param i32) (result i32) (local.get $x) (local.get $f)) (local.get $f))
  )
  (global $current (mut i32) (i32.const 1))
  (export "use_global" (func $use_global))
  (export "set_global" (func $set_global))
  (export "same" (func $same))
  (export "slot_of_dbl" (func $slot_of_dbl))
  (export "fire" (func $fire))
  (export "twice" (func $twice))
)
```

`f02-values.wat`: `use_global(5)` = 6, and 10 after `set_global(0)`; `same(1, 1)`, `same(1, 0)` = 1, 0;
`slot_of_dbl()` = 2; `fire(1, 41)` = `fire(2, 21)` = 42; `twice(5, 2)` = 20. `fire(0, 1)` and `fire(3, 1)` trap with
the messages of 3.5. The struct `h` is two locals, `$h_run` and `$h_arg`, as any struct in registers is.

## 4. None

> **Note (19 Nov): host references now follow this model.** The owner decided that the caller never sends null for a
> non-nullable type, and host references (ref 2.13, branch `claude/host-refs-fixes`) were changed to match this
> section: a plain host type (`Canvas`) has no default and is never none (a `let` of one, or of a struct or fixed array
> holding one, needs a value where declared, and a named result cannot hold one); `?Canvas` is the optional one, with
> the literal `0` as none, `== 0` / `!= 0`, `if let` and `??`, and a plain one widens to it. The checker asks "does this
> type hold one by value" through one walker (`heldIn` in types.ts) that function values can reuse for 4.1 and
> section 5. Two things learned there apply to 4.1 too. "Set where it is declared" is not "set before it is read": a
> `let` is seen after the block it is in (3.3), so a plain one declared in a branch, a loop's body or a match arm is
> seen in that block alone (`seenInItsBlock`, keyed on `noDefault`, which a plain `F` can join). A global's value is a
> constant and no constant is a `Canvas`, so a global of a plain host type is only ever imported; a plain `F` global
> is fine, since a function's name is a constant. And one difference stays: a host value can come in null from the
> host, so a plain one is checked once where it enters (an exported function's parameter, an imported function's
> result, an imported global), and traps there. Reference 2.5 states the rule for none that `?*T`, `?[]T`, `?Canvas`
> and `?F` share (`0`, `== 0` / `!= 0`, `if let`, `??`, a plain one has no none), with one stated difference: a `let`
> of `?Canvas` given no value is none on every pass of a loop, while one of `?*T` or `?[]T` is uninitialized, and `?F`,
> an `i32` local with no reset as 4.1 plans it, follows `?*T`.

### 4.1 A plain function value has no default

A variable of a plain function type gets its value where it is declared. Today M accepts all of these and gives them
0 (judge's `exp/judge/z1.ents`; `exp/final/probe/r1.ents`), which would make a non-optional function value none:

| Declaration | Today | With this design |
|---|---|---|
| `let f: (u32) -> u32` | `(local $f i32)`, 0 | error: `'f' needs a value where it is declared: a function value has no default (a ?func(u32) -> u32 starts as none)` |
| `let h: Handler`, a struct holding a function value | `(local $h_run i32)`, 0 | error: `'h' needs a value where it is declared: Handler holds a function value, which has no default` |
| `let fs: [2](u32) -> u32` | two locals, 0 | the same error, for an array holding one |
| `global g: (u32) -> u32` | `(global $g (mut i32) (i32.const 0))` | error: `global 'g' needs a value: a function value has no default (a ?func(u32) -> u32 starts as none)` |
| `func f() -> (r: (u32) -> u32)`, a named result | `(local $r i32)`, returns 0 | error: `result 'r' cannot hold a function value: a named result starts with a default, and func(u32) -> u32 has none; return the function instead, or make it ?func(u32) -> u32` |

The rule and the messages are DESIGN-refs' R9 (its E11-E13), reworded for a struct or an array that holds a function
value. For `?F` all three are allowed, and it starts as none. The rule is a checker rule only: the codegen still
declares an `i32` local, which is always set where it is declared.

The literal `0` is not a function value either (`cannot assign int(0) to func(u32) -> u32: a function value is a
function's name`), and section 5 closes the ways to make one from other bytes. Together these make a plain function
value always the slot of a function the program took, unless the host supplied it.

### 4.2 Optional function values

An optional function value, `?F`, is the same `i32`, and 0 is none. It follows the rules of `?*T` (ref 2.5, Optional
Types):

- a function value, or a function's name, widens to it implicitly;
- the literal `0` is none, and no other integer is accepted (unlike `?*T`, which today takes any integer:
  `func c() -> ?*u32 => 5` checks at M);
- `if let f = maybe { ... }` binds `f: F` when `maybe` is not none; `maybe ?? g` is `maybe` unless it is none, and `g`
  then; `maybe == 0` and `maybe != 0` test for none;
- calling it as it is is an error, not a run-time check: `cannot call ?func(u32) -> u32: it may be none; unwrap it with
  if let or ??`. The program says what none means, and the trap stays for numbers from the host.

The code of `if let` and `??` is what `?*T` compiles to today (`$__iflet_ptr_N`, `$__coal_ptr_N`; compare
`exp/final/probe/o2.ents` at M). An optional function value adds no code shape of its own.

### 4.3 Elements of function type

An element read with an index that is not proven in range is optional, as for pointer elements (ref 4.7: "Runtime
indices produce an optional result when the element type is a pointer or slice"; function types join them):
`ops[i]` on `*[3](u32) -> u32` is `?(u32) -> u32`, none when `i` is out of range. A constant index, or one of a ranged
type such as `u32#3`, gives the plain type.

An element that is itself optional (`*[N]?F`) read with any index is `?F`, and it is none when the index is out of
range **or** when the element holds none. `if let` and `??` test both. M gets this wrong for `?*T` elements today:
`qs[i] ?? &d` on `*[3]?*u32` checks only the index, and uses a none element as an address (`exp/final/probe/o1.ents`:
`a(0)` returns 0 where `d` = 7 is right), and `let m = qs[i]` checks nothing at all (`o2.ents`). Stage 1c fixes it for
pointers, and function elements then use the same code.

### 4.4 Example: an optional handler, and optional hooks

```ents
type Hook = (k: u32) -> ()
global last: u32 = 0
global on_key: ?Hook = 0
data more: *mut [2]?Hook = mut [0, 0]
func log_key(k: u32) { last = k }
func log_double(k: u32) { last = k * 2 }
export func set_handler(on: bool) { on_key = if on { log_key } else { 0 } }
export func press(k: u32) -> u32 {
  if let h = on_key { h(k) }
  return last
}
export func press_or(k: u32) -> u32 {
  (on_key ?? log_double)(k)
  return last
}
export func has_handler() -> bool => on_key != 0
export func add_more(i: u32#2) { more[i] = log_double }
export func press_more(i: u32, k: u32) -> u32 {
  (more[i] ?? log_key)(k)       // none when i is out of range, or when the element is none
  return last
}
```

```wat
(module
  (memory 1)
  (table $slots 3 3 funcref)
  (elem (i32.const 1) func $log_key $log_double)  ;; slot 1 = $log_key, slot 2 = $log_double
  (func $log_key (param $k i32)
    (global.set $last (local.get $k))
  )
  (func $log_double (param $k i32)
    (global.set $last (i32.mul (local.get $k) (i32.const 2)))
  )
  (func $set_handler (param $on i32)
    (global.set $on_key (if (result i32) (local.get $on) (then (i32.const 1)) (else (i32.const 0))))
  )
  (func $press (param $k i32) (result i32)
    (local $h i32)
    (local $__iflet_ptr_365 i32)
    (local.set $__iflet_ptr_365 (global.get $on_key))
    (if (local.get $__iflet_ptr_365) (then (local.set $h (local.get $__iflet_ptr_365))
    (call_indirect $slots (param i32) (local.get $k) (local.get $h))))
    (global.get $last) (return)
    (unreachable)
  )
  (func $press_or (param $k i32) (result i32)
    (local $__coal_ptr_454 i32)
    (call_indirect $slots (param i32) (local.get $k) (local.set $__coal_ptr_454 (global.get $on_key))
    (if (result i32) (local.get $__coal_ptr_454) (then (local.get $__coal_ptr_454)) (else (i32.const 2))))
    (global.get $last) (return)
    (unreachable)
  )
  (func $has_handler (result i32)
    (i32.ne (global.get $on_key) (i32.const 0))
  )
  (func $add_more (param $i i32)
    (i32.store (i32.add (i32.const 8) (i32.mul (local.get $i) (i32.const 4))) (i32.const 2))
  )
  (func $press_more (param $i i32) (param $k i32) (result i32)
    (local $__coal_idx_812 i32)
    (local $__coal_ptr_812 i32)
    (local $__coal_len_812 i32)
    (local $__coal_val_812 i32)
    (call_indirect $slots (param i32) (local.get $k) (local.set $__coal_idx_812 (local.get $i))
    (local.set $__coal_ptr_812 (i32.const 8))
    (local.set $__coal_len_812 (i32.const 2))
    (local.set $__coal_val_812 (if (result i32) (i32.lt_u (local.get $__coal_idx_812) (local.get $__coal_len_812)) (then (i32.load (i32.add (local.get $__coal_ptr_812) (i32.mul (local.get $__coal_idx_812) (i32.const 4))))) (else (i32.const 0))))
    (if (result i32) (local.get $__coal_val_812) (then (local.get $__coal_val_812)) (else (i32.const 1))))
    (global.get $last) (return)
    (unreachable)
  )
  (global $last (mut i32) (i32.const 0))
  (global $on_key (mut i32) (i32.const 0))
  (export "set_handler" (func $set_handler))
  (export "press" (func $press))
  (export "press_or" (func $press_or))
  (export "has_handler" (func $has_handler))
  (export "add_more" (func $add_more))
  (export "press_more" (func $press_more))
  ;; 8 zero bytes at 0x8 — more: *mut [2]?(k: u32) -> ()
)
```

`f05-optional.wat`: before `set_handler(1)`, `has_handler()` = 0, `press(3)` = 0 (nothing is called) and `press_or(4)`
= 8; after it, 1, 3 and 4. `press_more(0, 5)` = 5 (the element is none, so `log_key`), `press_more(7, 6)` = 6 (out of
range), and after `add_more(0)`, `press_more(0, 5)` = 10. `press_more` is M's bounds-checked `??` whose result is then
tested for none, the shape ref 4.7 describes for a stored optional element ("a bounds check that produces either the
real value or the zero sentinel, then a separate null check").

## 5. Comparison, other operators, casts

| Expression | Rule | WAT |
|---|---|---|
| `f == g`, `f != g` | both of one function type (parameter names ignored); either side may be optional | `(i32.eq ...)`, `(i32.ne ...)` |
| `f == inc` | a name is its slot (and gets one) | `(i32.eq (local.get $f) (i32.const 1))` |
| `maybe == 0`, `maybe != 0` | only an optional function value against the literal 0 | `(i32.eq (local.get $maybe) (i32.const 0))` |
| `f < g`, `f + 1`, `-f`, `f & 1`, ... | error | |
| `f == p` (a pointer), `f == n` (an integer), `f == g` of two function types | error | |
| `f == 0`, `f` not optional | error: only an optional value can be none | |
| `f as u32`, `f as i32`, `u32(f)` | the slot as a number | `(local.get $f)` |
| `inc as u32` | the slot of `inc` (and gives it one) | `(i32.const 1)` |
| `f as F`, its own type | allowed; nothing happens | `(local.get $f)` |
| `n as (u32) -> u32` | error: a function value is made by naming a function | |
| `f as (i32) -> i32`, another function type | error: function types match exactly | |
| `f as i64`, `f as u8`, `f as *u8`, `f as bool` | error | |

Equality is identity. A function has at most one slot, so two values are equal exactly when they are the same
function. Two functions with the same body are different functions, and `main`'s `inc` is not `lib`'s (section 7).

These rules replace three generations of rules that disagree today:

- At M, `checkAddressOperands` treats a function like a pointer (checker.ts:4174-4189, at :4177), so `f < g`, `f + 1`,
  `f == p` and `==` between two function types are accepted. 8c8cfa6 had allowed only `==` and `!=`; e434de1
  (`claude/operand-types`) replaced that. `exp/final/probe/g10.ents` checks clean at M.
- At M, `castProblem` counts `func` as a single value (checker.ts:6922-6939), so `g as u32`, `g as i64`,
  `n as (u32) -> u32` and `f as (i32) -> i32` are accepted (same probe).
- D6 (`claude/fix2-decls`, e3201ca) refuses a function's *name* in a cast to a number and as an operand, because a name
  had no run-time value. Here a name has one, its slot, so `inc == f` and `inc as u32` become legal and mean what the
  value means. D6's other cases fall under the rules above.

`as u32` is allowed because it is the convention made visible, it is harmless (no cast turns a number back into a
function value), and it serves hashing or logging a function value.

**Memory read as another type (decision 5).** A cast is not the only way to make a value out of a number. A pointer
cast or a pun can read memory as another type, which today lets a program store a `u32` and read it back as a function
value (M accepts `p as *Handler` from a `*u32`, `n as *Handler` from a `u32`, and `h as *mut u32` from a
`*mut Handler`: `exp/final/probe/c1.ents`). In one shared table such a number reaches any function with the same wasm
signature: the judge's `j2-forge.wat` stores 2 and calls it as a `(u32) -> u32`, and it runs `is_null: (*u8) -> bool`
without a trap. The recommended rule closes this inside the language. "Holds a function value" means the type is a
function type or `?F`, or a struct, tuple or fixed array with one among its fields or elements.

1. A cast or a pun (`p.(T)`, ref 4.6) **to** a pointer or slice whose pointee holds a function value is allowed only
   from a pointer or slice of the same pointee type (dropping `mut` is allowed). An integer cannot be cast to one.
2. A cast or a pun **from** a pointer or slice whose pointee holds a function value, to another pointee type, is allowed
   only to a const pointer or slice. Reading the slots as numbers is what `f as u32` already does; writing other bytes
   over them is not allowed.
3. `memzero` of memory that holds a plain function value is refused, because it would write none into it. (`memcpy`
   and `memset` take `*[N]u8`, so rule 2 already covers them.)

With these, a plain function value is always a slot the program took, and an optional one is that or none, with one
exception the language already has for every type: a many-pointer `[*]F` is unchecked (ref 2.5, "caller must ensure
bounds"), so reading past its end, or after byte arithmetic on it (`p + 1`, ref 4.6), reads whatever is there. Numbers
from there, from the host, and from memory the host writes, are checked only by `call_indirect`'s signature check.

## 6. Where function values live

A function value is one `i32` wherever a value is kept, with no exception.

| Place | Representation |
|---|---|
| parameter, local, result | one `i32` (unchanged, codegen.ts:151-153) |
| field of a struct in registers | one `i32` local per field, `$h_run` (unchanged) |
| fixed array in registers, `let ops = [inc, dbl]` | one `i32` local per element, under the value-array rules |
| global | `(global $g (mut i32) (i32.const <slot>))`; a function's name is a constant initializer |
| exported global | the same, exported: `exports.g.value` is the slot |
| imported global | not allowed: the host has no slots before the module is instantiated |
| host-import parameter or result | one `i32` (unchanged, codegen.ts:3303-3361) |
| memory: `*F`, a field of a struct behind a pointer, an element of `*[N]F`, `[]F`, `[*]F` | 4 bytes, little endian, the slot: `sizeof((u32) -> u32) == 4` |
| a `data` literal | 4 bytes per function value, the slot, written by the compiler |

### 6.1 Four bytes

`byteSize` gains `case 'func': return 4` (types.ts:1256-1294 returns null today), and data-pack's `getElementSize` the
same (data-pack.ts:906-932, which falls through to "Default to 1 byte"). This fixes two silent miscompiles of today,
calls or no calls:

- `data ops = [inc, dec]` is accepted, typed `*[2]func(x: u32) -> u32`, laid out as zero bytes, and `ops[1]` is read at
  stride 1, so `ops[0] == ops[1]` (NOTES-language 5; `exp/final/probe/g8.ents`: `(i32.add (i32.const 8) (i32.const 1))`).
- `type Handler = (run: (u32) -> u32, arg: u32)` and `func m(h: *Handler) -> u32 => h.arg` compile to `(local.get $h)`:
  no load at all, the function returns the address (judge's `exp/judge/p2.ents`). Any struct with a function field
  behind a pointer is laid out wrong today.

### 6.2 Data

A function's name in a `data` literal is written as its slot, 4 bytes little endian, in the literal's place, exactly
as clang and Rust put function addresses in `.rodata` (NOTES-wasm 2). Today data-pack writes a zero placeholder for
any element that is not a literal ("Runtime expression — emit zero placeholder", data-pack.ts:552-553), which is where
the zeros come from. The data section is built before the functions are emitted (codegen.ts:3541), so the slot list is
computed first, from the checker's record of values taken, and passed to `buildDataSection`. (The same placeholder
zeroes a `data` name inside another `data` literal, `data ps = [xs, xs]`. That is a separate bug, left out of scope.)

### 6.3 Dispatch tables and records in memory

A dispatch table is a `data` array of function values: memory the program owns, indexed like any array, holding slots.

```ents
type Handler = (run: (u32) -> u32, arg: u32)
func inc(x: u32) -> u32 => x + 1
func dec(x: u32) -> u32 => x - 1
func dbl(x: u32) -> u32 => x * 2
data ops = [inc, dec, dbl]                            // *[3](u32) -> u32
data handlers = [Handler(dbl, 21), Handler(inc, 41)]  // *[2]Handler
data hooks = mut [inc, inc]                           // *mut [2](u32) -> u32
func fire(h: *Handler) -> u32 => h.run(h.arg)
export func op(i: u32, x: u32) -> u32 => (ops[i] ?? inc)(x)
export func second() -> u32 => fire(&handlers[1])
export func set_hook(i: u32#2, f: (u32) -> u32) { hooks[i] = f }
export func run_hook(i: u32#2, x: u32) -> u32 => hooks[i](x)
```

```wat
(module
  (memory 1)
  (table $slots 4 4 funcref)
  (elem (i32.const 1) func $inc $dec $dbl)  ;; slot 1 = $inc, slot 2 = $dec, slot 3 = $dbl
  (func $inc (param $x i32) (result i32)
    (i32.add (local.get $x) (i32.const 1))
  )
  (func $dec (param $x i32) (result i32)
    (i32.sub (local.get $x) (i32.const 1))
  )
  (func $dbl (param $x i32) (result i32)
    (i32.mul (local.get $x) (i32.const 2))
  )
  (func $fire (param $h i32) (result i32)
    (local $__tmp_0 i32)
    (call_indirect $slots (param i32) (result i32) (local.set $__tmp_0 (i32.load (local.get $h))) (i32.load (i32.add (local.get $h) (i32.const 4))) (local.get $__tmp_0))
  )
  (func $op (param $i i32) (param $x i32) (result i32)
    (local $__coal_idx_388 i32)
    (local $__coal_ptr_388 i32)
    (local $__coal_len_388 i32)
    (call_indirect $slots (param i32) (result i32) (local.get $x) (local.set $__coal_idx_388 (local.get $i))
    (local.set $__coal_ptr_388 (i32.const 8))
    (local.set $__coal_len_388 (i32.const 3))
    (if (result i32) (i32.lt_u (local.get $__coal_idx_388) (local.get $__coal_len_388)) (then (i32.load (i32.add (local.get $__coal_ptr_388) (i32.mul (local.get $__coal_idx_388) (i32.const 4))))) (else (i32.const 1))))
  )
  (func $second (result i32)
    (call $fire (i32.add (i32.const 20) (i32.mul (i32.const 1) (i32.const 8))))
  )
  (func $set_hook (param $i i32) (param $f i32)
    (i32.store (i32.add (i32.const 36) (i32.mul (local.get $i) (i32.const 4))) (local.get $f))
  )
  (func $run_hook (param $i i32) (param $x i32) (result i32)
    (call_indirect $slots (param i32) (result i32) (local.get $x) (i32.load (i32.add (i32.const 36) (i32.mul (local.get $i) (i32.const 4)))))
  )
  (export "op" (func $op))
  (export "second" (func $second))
  (export "set_hook" (func $set_hook))
  (export "run_hook" (func $run_hook))
  (data (i32.const 8) "\01\00\00\00\02\00\00\00\03\00\00\00")  ;; ops: *[3](u32) -> u32
  (data (i32.const 20) "\03\00\00\00\15\00\00\00\01\00\00\00)\00\00\00")  ;; handlers: *[2](run: (u32) -> u32, arg: u32)
  (data (i32.const 36) "\01\00\00\00\01\00\00\00")  ;; hooks: *mut [2](u32) -> u32
)
```

`f04-memory.wat`, 303 bytes: `op(0..3, 10)` = 11, 9, 20, 11 (index 3 is out of range, so `inc`); `second()` = 42;
`run_hook(1, 5)` = 6, and 10 after `set_hook(1, 3)`. The memory code (offsets, the bounds check of `??`, the stores) is
what M emits for the same program with `u32` in place of each function value. What is new is the two kinds of
`call_indirect`, the slot bytes in `data`, `h.arg` at offset 4 (which needs byteSize 4), and the scratch local in `fire`
(two loads, section 3.3). No Encantis caller can pass 0 to `set_hook` (0 is no function value), so a plain element is
never 0 unless the host wrote it, and the `??` of `op` only has to check the index. (A host that calls `set_hook(1, 0)`
makes `run_hook(1, 5)` trap.)

A slice of function values works the same way (`f12-slice.wat`, 175 bytes: `first_of(fs: [](u32) -> u32, x: u32) =>
(fs[0] ?? inc)(x)` called with `data ops = [dbl, inc]` gives 10, and 6 for an empty slice).

### 6.4 Multi-value signatures

A function value's signature is the flattened one (ref 9.2, 9.3). `call_indirect` passes and returns several values
with multi-value, which every Encantis build already enables (37 of the 80 corpus files return several values). A
struct goes through as its fields, in registers, with no memory. clang only gets this with its experimental multivalue
ABI (NOTES-wasm 2).

```ents
type Pt = (x: f64, y: f64)
func flip(p: Pt) -> Pt => Pt(p.y, p.x)
func shift(p: Pt) -> Pt => Pt(p.x + 1.0, p.y)
func apply_pt(f: (Pt) -> Pt, p: Pt) -> Pt => f(p)
export func go(up: bool, x: f64, y: f64) -> Pt => apply_pt(if up { flip } else { shift }, Pt(x, y))
```

```wat
(module
  (table $slots 3 3 funcref)
  (elem (i32.const 1) func $flip $shift)  ;; slot 1 = $flip, slot 2 = $shift
  (func $flip (param $p_x f64) (param $p_y f64) (result f64 f64)
    (local.get $p_y) (local.get $p_x)
  )
  (func $shift (param $p_x f64) (param $p_y f64) (result f64 f64)
    (f64.add (local.get $p_x) (f64.const 1)) (local.get $p_y)
  )
  (func $apply_pt (param $f i32) (param $p_x f64) (param $p_y f64) (result f64 f64)
    (call_indirect $slots (param f64 f64) (result f64 f64) (local.get $p_x) (local.get $p_y) (local.get $f))
  )
  (func $go (param $up i32) (param $x f64) (param $y f64) (result f64 f64)
    (call $apply_pt (if (result i32) (local.get $up) (then (i32.const 1)) (else (i32.const 2))) (local.get $x) (local.get $y))
  )
  (export "go" (func $go))
)
```

`f03-multivalue.wat`: `go(1, 2.5, 1.5)` = [1.5, 2.5], `go(0, 2.5, 1.5)` = [3.5, 1.5].

### 6.5 Self-referential function types

```ents
type State = (c: u8) -> State
global words: u32 = 0
func between(c: u8) -> State {
  if c == 32 { return between }
  words += 1
  return inside
}
func inside(c: u8) -> State => if c == 32 { between } else { inside }
export func count(text: []u8) -> u32 {
  let s: State = between
  for c in text { s = s(c) }
  return words
}
export memory
```

The loop body is `(local.set $s (call_indirect $slots (param i32) (result i32) (local.get $c) (local.get $s)))`, and
the states return `(i32.const 1)` and `(i32.const 2)` (`f13-state.wat`, 202 bytes: `count("  two words  and three ")`
= 4). This is DESIGN-explicit's state machine, which the judges asked to keep; an `i32` value can hold it, and M's
checker already accepts the type.

## 7. Several source modules, and separately compiled wasm modules

**One program, one module, one set of slots.** `programToWat` merges every source module into one wasm module
(codegen.ts:3523-3760). A non-entry module's functions are `$<basename>$<name>`, and a source import compiles to a
direct call of that name. A function value that crosses source modules is therefore a slot of the same table, and
identity is program-wide. A function private to a module can still be handed out as a value by a function of that
module, as in C a `static` function's address can. So a library can take its importers' callbacks
(`walk(tree, visitor)`), which DESIGN-explicit could not do.

**A host import declared by two modules is one function (decision 12).** Today two source modules that import
`env.log` emit two `(import "env" "log" (func $log ...))` lines with one name, and wabt refuses the program
(`redefinition of function "$log"`; judge's `exp/judge/dup/`, reproduced at M). The fix this design needs is that
imports are merged by module name and field name: one import, one function index, one slot, so `log == log` holds
across modules. Two declarations of one host function with different signatures are an error. The fix stands alone
(stage 1d).

```ents
// lib.ents
import "env" "log" func log(x: u32)
func secret(x: u32) -> u32 => x * 7
func inc(x: u32) -> u32 => x + 100
export func pick(up: bool) -> (u32) -> u32 => if up { secret } else { inc }
export func logger() -> (u32) -> () => log
```

```ents
// main.ents (the entry)
import "env" "log" func log(x: u32)
import "./lib" (
  "pick" func pick(up: bool) -> (u32) -> u32
  "logger" func logger() -> (u32) -> ()
)
func inc(x: u32) -> u32 => x + 1
export func go(up: bool, x: u32) -> u32 => pick(up)(x)
export func is_inc(up: bool) -> bool => pick(up) == inc
export func same_log() -> bool => logger() == log
```

```wat
(module
  (import "env" "log" (func $log (param $x i32) ))
  (table $slots 5 5 funcref)
  (elem (i32.const 1) func $log $inc $lib$secret $lib$inc)  ;; slot 1 = $log, slot 2 = $inc, slot 3 = $lib$secret, slot 4 = $lib$inc
  (func $inc (param $x i32) (result i32)
    (i32.add (local.get $x) (i32.const 1))
  )
  (func $go (param $up i32) (param $x i32) (result i32)
    (call_indirect $slots (param i32) (result i32) (local.get $x) (call $lib$pick (local.get $up)))
  )
  (func $is_inc (param $up i32) (result i32)
    (i32.eq (call $lib$pick (local.get $up)) (i32.const 2))
  )
  (func $same_log (result i32)
    (i32.eq (call $lib$logger) (i32.const 1))
  )
  (func $lib$secret (param $x i32) (result i32)
    (i32.mul (local.get $x) (i32.const 7))
  )
  (func $lib$inc (param $x i32) (result i32)
    (i32.add (local.get $x) (i32.const 100))
  )
  (func $lib$pick (param $up i32) (result i32)
    (if (result i32) (local.get $up) (then (i32.const 3)) (else (i32.const 4)))
  )
  (func $lib$logger (result i32)
    (i32.const 1)
  )
  (export "go" (func $go))
  (export "is_inc" (func $is_inc))
  (export "same_log" (func $same_log))
)
```

`f08-modules.wat`: `go(1, 3)` = 21, `go(0, 3)` = 103; `is_inc(1)` = `is_inc(0)` = 0, since `main`'s `inc` is not
`lib`'s; `same_log()` = 1. The slots follow the WAT: the import, then `main` (the entry), then `lib`.

**Separately compiled wasm modules** (two `.wasm` files, two instances) have two tables, and a slot of one means nothing
to the other. There is no `import slots`, for the reason there is no memory import (the grammar has neither,
encantis-grammar.ohm:44-50): a shared table needs each module to know which slots are its own (tool-conventions'
`__table_base` and an imported `__indirect_function_table`, NOTES-wasm 2), which is linking, and Encantis links by
compiling the whole program at once. Two instances that must pass callbacks go through the host (section 8.3, recipe 5).

## 8. The host

### 8.1 Without `export slots`

A function value crosses the host boundary as a number. An exported function with a function-typed parameter takes an
`i32`; one that returns a function value returns its slot; an exported global of a function type has the slot as its
value. Without the table the host cannot call such a number. It can keep it and hand it back, which is enough for
opaque handles. Nothing is exported that the program did not export.

### 8.2 Host functions as callbacks: import them

A host function becomes a function value the way every function does: the program imports it and names it as a value.
It gets a slot like any function. No wasm feature is needed: an element segment may list an imported function, and
`call_indirect` then reaches the JS function (NOTES-wasm e06).

### 8.3 `export slots`

`export slots` (or `export "fns" slots`) in the entry module exports the table, under `"slots"` by default, as
`export memory` exports the memory under `"memory"` (ref 7.2). An exported table has no maximum, so the host may grow
it (decision 8). In a module that is not the entry it does nothing, like every export there. It may appear once.

`export slots = [inc, log]` also fixes the first slots: the listed functions get slots 1, 2, ... in the order written,
and get them whether or not the program takes their values. Every other function whose value is taken follows, by the
rule of 1.3. This gives a host or a file of saved numbers an ABI that is a line of source, which test builds and added
values cannot move (decision 6). A listed name must be a function or host import of the entry module, or one it
imports from a source module; a shared name or a generic cannot be listed (write a wrapper).

```ents
import "env" "log" func log(x: u32)
export slots = [inc]
func inc(x: u32) -> u32 => x + 1
export func get_inc() -> (u32) -> u32 => inc
export func call_u32(f: (u32) -> u32, x: u32) -> u32 => f(x)
export func each(n: u32, f: (u32) -> ()) { for i in n { f(i) } }
export func logger() -> (u32) -> () => log
```

```wat
(module
  (import "env" "log" (func $log (param $x i32) ))
  (table $slots (export "slots") 3 funcref)
  (elem (i32.const 1) func $inc $log)  ;; slot 1 = $inc, slot 2 = $log
  (func $inc (param $x i32) (result i32)
    (i32.add (local.get $x) (i32.const 1))
  )
  (func $get_inc (result i32)
    (i32.const 1)
  )
  (func $call_u32 (param $f i32) (param $x i32) (result i32)
    (call_indirect $slots (param i32) (result i32) (local.get $x) (local.get $f))
  )
  (func $each (param $n i32) (param $f i32)
    (local $i i32)
    (local.set $i (i32.const 0))
    (block $break
    (loop $next
    (br_if $break (i32.ge_u (local.get $i) (local.get $n)))
    (block $continue
    (call_indirect $slots (param i32) (local.get $i) (local.get $f))
  )
  (local.set $i (i32.add (local.get $i) (i32.const 1)))
  (br $next)
)
)
)
  (func $logger (result i32)
    (i32.const 2)
  )
  (export "get_inc" (func $get_inc))
  (export "call_u32" (func $call_u32))
  (export "each" (func $each))
  (export "logger" (func $logger))
)
```

`$inc` has slot 1 because it is listed, although the import `$log` stands before it in the WAT. (The loop's
indentation is the codegen's own today.) With it, the host can do all of this (`exp/final/checks.mjs`, run on node 22
and bun):

```js
const logged = []
const { instance } = await WebAssembly.instantiate(bytes, { env: { log: (x) => logged.push(x) } })
const e = instance.exports
e.slots.get(e.get_inc())(41)            // 42: a function value wasm hands out, called by the host
e.call_u32(e.get_inc(), 1)              // 2: handed back in
e.each(3, e.logger())                   // logged = [0, 1, 2]: a host import used as a value, called from wasm
e.call_u32(e.logger(), 1)               // RuntimeError: wrong signature
e.call_u32(0, 1)                        // RuntimeError: none
// A JS function chosen at run time. A table holds only wasm functions (slots.set(i, x => x) is a TypeError in both
// engines), so the JS function goes through a one-function adapter module, as emscripten's addFunction does:
//   (module (import "js" "f" (func $f (param i32) (result i32))) (export "f" (func $f)))
const ad = await WebAssembly.instantiate(adapterBytes, { js: { f: (x) => x * 10 } })
const slot = e.slots.grow(1, ad.instance.exports.f)   // grow returns the old size: the new slot, 3
e.call_u32(slot, 4)                     // 40
e.slots.get(1) === e.slots.get(e.get_inc())           // true: one JS object per wasm function
```

Recipes, in the order a host needs them:

1. **Call a function value wasm returned:** `exports.slots.get(v)(...args)`. The arguments and results are the
   flattened signature; a struct is several JS numbers.
2. **Give wasm a callback known when the program is written:** import it and take its value (8.2).
3. **Give wasm a callback chosen at run time:** `export slots`; wrap the JS function as a wasm function (the adapter
   module, or `new WebAssembly.Function(...)` where type reflection is enabled, which it is not by default in node 22
   or bun, NOTES-wasm e06); `const v = exports.slots.grow(1, wrapped)`; pass `v`.
4. **Find the slot of a function:** list it in `export slots = [...]`; or export a function that returns its value; or
   scan `slots` for `=== exports.f` (identity holds in both engines, NOTES-wasm e11).
5. **Pass a callback from one instance to another:** `b.slots.grow(1, a.slots.get(v))`, and pass the result to `b`.
   Both must `export slots`.

`export slots` exposes every slotted function, module-private ones included, as clang's `--export-table` does; the
reference says so. It changes the module only by the export, the missing maximum and, with a list, the order of the
segment. It is never implied: an exported function or a host import with a function-typed parameter compiles without
it, because a number can be passed and kept without being called.

### 8.4 The hosts this project has

The board-builder port harnesses instantiate with `{}` (builder/check-weave.cjs:206-211), `encantis run` with WASI only
(cli.ts:466-470), and the test host with function imports only (test-host.ts:59 skips any other kind). None of them
supplies a table, and none needs to: the table is defined in the module, never imported, so every harness keeps
working unchanged.

## 9. Generics, and the zero-cost promise

**Comptime function parameters stay compile-time.** `sort(xs, ascending)` still makes the instance
`sort<i32|ascending>`, whose body calls `$ascending` directly; no slot, no table. One sentence of 8.6 changes: inside
the instance, the parameter used as a value is the value of the function it names, so an instance can pass its
comparator on to a run-time parameter, or return it. That costs exactly what writing the function's name in the same
place costs in the hand-written function.

**A generic may call a run-time function value.** The stage-3 error goes away in instances as everywhere
(spec/generics.md:2682-2692 had `, in apply(T = u32)`). A run-time parameter of a function type is called with
`call_indirect` in each instance.

```ents
func apply(comptime T: type, f: (T) -> T, x: T) -> T => f(x)
func twice(comptime T: type, comptime f: (T) -> T, x: T) -> T => f(f(x))
func later(comptime f: (u32) -> u32) -> (u32) -> u32 => f
func inc(x: u32) -> u32 => x + 1
export func go(x: u32) -> u32 => apply(inc, x) + twice(inc, x)
export func pass() -> (u32) -> u32 => later(inc)
```

```wat
(module
  (table $slots 2 2 funcref)
  (elem (i32.const 1) func $inc)  ;; slot 1 = $inc
  (func $apply<u32> (param $f i32) (param $x i32) (result i32)
    (call_indirect $slots (param i32) (result i32) (local.get $x) (local.get $f))
  )
  (func $twice<u32|inc> (param $x i32) (result i32)
    (call $inc (call $inc (local.get $x)))
  )
  (func $later<inc> (result i32)
    (i32.const 1)
  )
  (func $inc (param $x i32) (result i32)
    (i32.add (local.get $x) (i32.const 1))
  )
  (func $go (param $x i32) (result i32)
    (i32.add (call $apply<u32> (i32.const 1) (local.get $x)) (call $twice<u32|inc> (local.get $x)))
  )
  (func $pass (result i32)
    (call $later<inc>)
  )
  (export "go" (func $go))
  (export "pass" (func $pass))
)
```

`f09-generic.wat`, 120 bytes: `go(5)` = 13, `pass()` = 1. The instance names are M's (`exp/final/probe/gen.ents`).
`$inc` is called directly by `$twice<u32|inc>` and has a slot because `go` passes it to `apply`'s run-time parameter
and `later` returns it. Its twin, `f09-twin.wat` (`apply_u32`, `twice_inc`, `later_inc` written by hand, in the same
places), assembles to the same 120 bytes, byte for byte: the instance is the hand-written function, table included.

**Zero cost.** Everything that does not use a function value compiles to exactly the bytes it compiles to today:

- the table and the segment exist only under the condition of 1.4, which no program of the corpus meets (nothing in
  examples/, lib/ or experiments/ stores, passes or calls a run-time function value: NOTES-language 10);
- a function's name as a callee is a direct call, as today, and a comptime function argument is not a value;
- no type declaration, helper function, start function or export is added; type entries come only from functions and
  from `call_indirect`s, which such a program does not have;
- `sizeof`, layouts and data offsets change only for types that hold a function value, and no program that compiles
  correctly today puts one in memory (both such layouts are the miscompiles of 6.1).

The golden test (golden.test.ts, `tests/golden/wasm-sha256.json`) pins the `.wasm` of every example, library and
fixture, and `scripts/watdiff.ts` compares the WAT of every file against a base checkout; both must show no change.
`expectPlainWasm` (generics.test.ts:1365-1369) and the examples check (examples/examples.test.ts:85-91) keep forbidding
`call_indirect`, `(table`, `(elem`, `ref.func` and `funcref` in generic programs that take no function value, and gain
`call_ref`, `(type ` and `table.get` (section 16). New examples that do use function values go in
`examples/functions/`, not `examples/generics/`.

**An instance picked by type** (stage 9): where a function type is expected, a generic's name is checked as a call
whose arguments have that type's parameter types; the rules of ref 8.2 decide the type parameters, the instance is the
one such a call would use, and its type must then be exactly the expected type. `let m: (u32, u32) -> u32 = max` is
the slot of `max<u32>`. A generic with a comptime function parameter has no instance a type can pick. Until stage 9
the error stays `generic function 'max' must be called`, and the workaround is a one-line wrapper.

## 10. Later, not now

- **Closures.** This design adds none and blocks none. A plain function value stays one `i32` forever; making it a
  pointer to `{index, env}` (AssemblyScript) or a pair (TinyGo) later would change every signature and layout that
  holds one. Ref 13 already says "non-capturing functions remain raw table indices" (docs/encantis.md:3177). A closure
  would be a second kind of type holding a function value and an environment: two `i32`s, storable in registers and in
  memory, `(run: (*Env, A) -> R, env: *Env)` in today's terms. spec/checks.md's `Handler = (run: (u32) -> u32, arg:
  u32)` is that shape written by hand, and it works with this design as it stands (3.7, 6.3). A compiler-made lambda
  gets a slot by the same rule as any function whose value is taken. The words this design takes (`?` before a
  function type, `slots` after `export`) touch no closure syntax, and a method value (`x.f` without a call, refused
  here) is exactly what a closure design would define.
- **Typed function references** (`call_ref`, Wasm 3.0). They would drop the run-time signature check, but need type
  declarations, an assembler Encantis does not have (only the wabt nightly 1.0.39-nightly.20251203 parses final
  `call_ref`), Wasm 3.0 engines, and still cannot be stored in memory or `data`. If they are wanted later, the slot stays
  the storage form, and a register form is added behind an explicit conversion (`table.get`), opt-in, without changing
  anything here.
- **Tail calls** (`return_call_indirect`). They need wabt's `tail_call` flag and engines that Wasmi and older wasm2c are
  not. `return f(x)` is a call followed by a return.
- **Named homogeneous tables for dense dispatch.** DESIGN-explicit's `table Opcode: F = [...]` with slot 0 as the first
  handler makes `byte as Opcode` one `call_indirect` with no load, and a forged slot type-safe. It needs a second wasm
  table, so reference types (a wasm-opt flag, no Safari before 15). A `data` dispatch array (6.3) does the same job in
  MVP with one load.

## 11. What the compiler emits that you did not write

The whole list. Each item appears only in a program that takes, calls or exports a function value.

| # | What | Why | How the reader predicts it |
|---|---|---|---|
| 1 | `(table $slots N N funcref)`; `(table $slots (export "slots") N funcref)` under `export slots` | `call_indirect` needs a table, and a table is the only place a wasm function can be named by an `i32`. `funcref` is the only element type an MVP table has. min = max because nothing in the program grows it; no maximum when exported, so the host can (decision 8) | N = 1 + the names in the segment line |
| 2 | `(elem (i32.const 1) func $f1 ... $fn)  ;; slot 1 = $f1, ...` | The table must be filled. One active MVP segment lists exactly the slotted functions, in slot order (1.3); the comment repeats the numbers | the k-th name is slot k, and the comment says so |
| 3 | `(i32.const k)` where the source wrote a function's name as a value | the value is the slot (1.1). It replaces today's ill-typed `(ref.func $f)` | k from the segment line |
| 4 | the slot as 4 little-endian bytes in the data section, for a function's name in a `data` literal | a reference cannot be stored in memory; an index can (6.2), as clang and Rust do in `.rodata` | as 3 |
| 5 | the inline `(param ...) (result ...)` on each `call_indirect` | `call_indirect` must name a signature. It is the callee's function type flattened like any declaration's parameter list; written inline, so no `(type ...)` declaration is needed | the function type, without names |
| 6 | a type-section entry for a called signature no function has (binary only) | wabt resolves an inline signature to the entry of that signature, and adds one when no function has it (`f10-calls-only.wat`) | one per distinct signature; most programs already have it |
| 7 | a scratch local `$__tmp_N`, set before the arguments and read last | the callee is computed first (written order, 3.3), and `call_indirect` takes it last | by the rule of 3.3: only when neither the callee nor every argument is free to move |
| 8 | the test for none after the bounds check of `if let` or `??` on an optional element (`$__coal_val_N`, 4.4); the `$__iflet_ptr_N` and `$__coal_ptr_N` locals around `?F` | the user wrote `if let` or `??`; the compiler picks the instructions, as it does for `?*T` today | the same shapes as for optional pointers |
| 9 | a table section (7 bytes; 6 without a maximum) and an element section (8 + n bytes while function indices stay below 128) | items 1 and 2 | from items 1 and 2 |

Not emitted, but done by the engine on every call of a value: `call_indirect`'s bounds check and signature check, into
which both engines fold the check for an empty slot (3.5).

Never emitted: `ref.func`, `ref.null`, `funcref` locals, globals or parameters, `table.get`, `table.set`, `table.grow`,
`(type ...)` declarations, `(elem declare ...)`, passive segments, a start function, wrapper or thunk functions, an
explicit null check, a run-time registry, an export the program did not write, and a table the program does not use.

What the reader must know that is not in the WAT: that slot 0 is empty on purpose (0 is none), and the numbering rule
of 1.3, including that values taken only in tests come last and that numbers belong to one build.

## 12. Alternatives considered

**Function tables written in the source** ([DESIGN-explicit.md](DESIGN-explicit.md)). `table Op: (x: u32) -> u32 =
[none, inc, dbl]` becomes exactly one table and its segment, and declares a nominal type `Op` whose values are its
slots. It has the least implicit machinery of the three, and a forged slot can only reach that table's functions. It
pays for that in language. A plain function type loses its run-time meaning (its error E1), which contradicts ref 3.4
and rewrites every example there. A table lists only functions its own module can name, so a library cannot take its
importers' callbacks. Each table holds one signature, so a program with two callback signatures needs two tables,
which needs reference types; wasm-opt then fails under the CLI's flags (`Only 1 table definition allowed in MVP`,
verified by the owner judge on x03) and `encantis -O` silently writes unoptimized output (cli.ts:280-283). `none` is
opt-in, so a zeroed `Op` silently calls the first function. A closure has no name to list. This design takes three
things from it: the written order (`export slots = [...]`), the self-referential state machine (6.5), and showing the
numbers to the reader (the segment comment and the editor hover).

**Wasm 3.0 typed function references** ([DESIGN-refs.md](DESIGN-refs.md)). A value is `(ref $sig)`, a name is
`ref.func`, a call is `call_ref`. There is no numbering at all, values cannot be forged, and the host gets real
callable functions with type checks at the boundary. It pays for that in platform. Every program with a function
value needs Wasm 3.0, which excludes Safari 15-17 (the old-Safari case the board-builder port values, moonbit/ENCANTIS.md:3-7),
Wasmi, Wasmer and wasm2c. It needs a non-release assembler (wabt 1.0.39-nightly.20251203, which refuses valid typed
`select` and cannot write recursion groups or GC structs), and `wasm-opt --enable-gc`. Wasm has no equality on
function references, so `f == g` is lost (checker.test.ts:2352-2358), and no store for them, so no function value can
live in memory, a slice, or `data`: a struct holding a callback cannot sit behind a pointer. It also contradicts ref
:1131, :3154 and :3177. This design takes its rule that a function value has no default (4.1), its catch that
`typeEquals` compares parameter names (1.5), and its upgrade path (section 10).

**Every function in the table, slot = function index + 1.** The rule would be simpler: no record of which values are
taken, and a function's slot would follow from its place alone. But every function would be callable by any forged
number of its wasm signature, `export slots` would hand the host every function, wasm-opt could no longer drop any
function (all would be referenced by the segment), and the segment would grow by one or two bytes per function in
every program that uses one function value.

**One table per function type.** A forged number could then reach only functions of one Encantis signature. But two
tables need reference types, which brings back the multi-table cost of the explicit design, and the table would be
chosen by the type, which is magic of its own.

**`funcref` values, called through a hidden one-slot table** (what clang's `__funcref` does without typed references:
`table.set`, `call_indirect`, set the slot back). This is the most machinery of all: a table the program never sees,
written on every call. It also loses equality and storage in memory, as typed references do.

**A table the host owns and the module imports** (the tool-conventions dynamic-linking model, `__table_base`). Every
harness of the project would have to supply a table (the board-builder port instantiates with `{}`, `run` gives WASI only, and the
test host skips non-function imports), and the module would need a base offset to avoid other modules' slots. That is
linking, and Encantis links by compiling the whole program.

**Slot order only from a written list** (the owner judge's form of the graft: with a list, an unlisted value is an
error). It removes the numbering rule, but the entry module cannot name another module's private functions, so a
library that hands out its own private functions as values could not be used in a program that lists its slots. Here a
list fixes the first slots and the rule numbers the rest (decision 6).

## 13. Decisions for the owner

Each has a recommendation; the rest of this document assumes the recommended option.

1. **What a function value is at run time.** (a) Its slot, an `i32` index into one implicit MVP table (this design);
   (b) a slot of a function table the source declares, with a nominal type per table (DESIGN-explicit); (c) a Wasm 3.0
   typed reference, called with `call_ref` (DESIGN-refs). **Recommended: (a).** It is what the reference already
   promises, it keeps every existing lowering, equality and storage in memory, and it runs on every engine Encantis
   targets today.
2. **Which functions have a slot, in what order.** (a) Only those whose value is taken, numbered from 1 in WAT order,
   with values taken only in tests after the others (1.3); (b) the same in plain WAT order, so test builds renumber;
   (c) every function, slot = function index + 1. **Recommended: (a).** It keeps the forging surface and the segment
   small, and a test build never moves a release slot.
3. **Slot 0.** (a) Never filled: 0 is none, and `?F` exists; (b) filled, no optional function values. **Recommended:
   (a)**, as address 0 is for optional pointers (ref 9.0) and slot 0 is for clang, Rust and AssemblyScript.
4. **Defaults.** (a) A plain function type has no default: `let`, `global` and structs or arrays holding one need a
   value where declared, and a named result cannot hold one (4.1); (b) keep today's zero, so a plain function value can
   be none and traps when called. **Recommended: (a).** It makes "a plain function value is a slot the program took"
   true; `?F` is there for values that may be absent.
5. **Memory read as another type.** (a) Refuse pointer casts and puns that make a function value out of other bytes,
   or write other bytes over one, and `memzero` over plain function values (section 5); (b) allow them, as for
   pointers, and rely on `call_indirect`'s wasm-signature check. **Recommended: (a)**, as its own stage (7). It costs
   one "holds a function value" test in three places, and closes the checked way, inside the language, to call a
   function of another Encantis type (judge's `j2-forge.wat`); unchecked many-pointers stay what they are.
6. **Numbers a host can rely on.** (a) `export slots = [f, g]` fixes slots 1, 2, ... in that order, and the rule
   numbers the rest; (b) a list must name every slotted function, and an unlisted value is an error; (c) no list: hosts
   always look slots up. **Recommended: (a)**, as stage 6. (b) cannot work for a library's private functions (section
   12); (c) leaves hosts without an ABI.
7. **The word.** (a) `slots` (`export slots`, "a function's slot"), contextual after `export` only; (b) `table`, wasm's
   word, which already means rows of pointers in Encantis (ref 2.5); (c) `funcs` or `functions`. **Recommended: (a).**
8. **The exported table's size.** (a) No maximum, so the host can grow it to add callbacks chosen at run time (8.3
   recipe 3); (b) min = max always, so host callbacks come only as imports. **Recommended: (a)**, like `export memory`,
   which also has no maximum unless one is written.
9. **Two call spellings.** `(inc)(x)`: (a) the direct call `inc(x)`; (b) an indirect call of `inc`'s value; (c) an
   error. `x.f()` with `f` a variable of a function type: (a) the call `f(x)`; (b) an error, as today. **Recommended:
   (a) for both.** Parentheses only group, and ref 4.9's rule is about a callable name, which a variable of a function
   type is.
10. **Spelling of optional function types and none.** (a) `?(A) -> R` and `?Name`, with none written `0` as for `?*T`;
    (b) only `?Name`, so that `?(u32) -> u32` cannot be misread; (c) a `none` literal. **Recommended: (a).** `none`
    would be a contextual word that a variable can hide (lib/text.ents:110 has one called `none`), and pointers already
    use 0.
11. **Picking by expected type.** A shared name picks its member by the expected function type: (a) in the first
    version; (b) never (write a wrapper). A generic's instance picked the same way: (a) as a later, separate stage;
    (b) never. **Recommended: (a) and (a).** Both use the rule a call uses, with the expected type in place of
    arguments; the generic one is the more complex and nothing in the corpus needs it yet.
12. **A host function two modules import.** (a) One import, one function, one slot (merged by module and field name;
    different signatures are an error); (b) one import per declaration, named per module, so `log` of `main` is not
    `log` of `lib`. **Recommended: (a).** Two declarations of `env.log` are one host function, and today the program
    does not assemble at all.
13. **`def h = inc`.** (a) Stays an error (`def value must be a compile-time constant`); (b) allowed, as another name
    for `inc`, since `def` is substitution. **Recommended: (a) for now.** No program needs it, it would be the first
    `def` that is not a number, and type aliases with comptime parameters cover the uses.
14. **Order of the callee.** (a) Written order with the constructors' "free to move" test (3.3); (b) the same order with
    a sharper test (a global read or a load counts as free when the arguments cannot change it), as DESIGN-minimal had;
    (c) arguments first, callee last, always. **Recommended: (a).** It is the owner's Q7 rule applied to one more
    expression, and (c) would be the only expression not computed in written order.

## 14. Errors

Messages are written as the checker writes types (`typeToString`: `func(u32) -> u32`; `?` in front of an optional
one). In an instance, each is followed by `, in apply(T = u32)`, as every error there is.

**Removed.**

| Today | Why it goes |
|---|---|
| `calling a function value is not supported yet: only a function named directly, or a comptime function parameter (comptime f: (u32) -> u32), can be called` (checker.ts:3327-3336; spec/checks.md:1564-1593, spec/generics.md:2682-2692, ref :1129, 8.7 :2653) | calls of values compile |
| `'before' is a comptime function parameter: it can only be called, or passed on for a comptime function parameter` (checker.ts:3177-3182, ref 8.7 :2647) | its value is the value of the function it names |
| D6: `'==' cannot be applied to ...: 'f' is a function, which has no run-time value yet` and the cast message of the same kind (fix2-decls checker.ts:4320-4323, :4353-4358) | a name has a value, its slot; section 5 decides |
| the codegen throw `Cannot call this expression at offset N: only a named function is called` (codegen.ts:1040-1043) | replaced by `call_indirect` |

**Unchanged.** `cannot assign func(x: u32) -> u32 to func(i32) -> i32` (different function types); `if let requires an
optional expression or bounds-checked index` (on a plain function value); argument count and argument type errors;
`def value must be a compile-time constant` (`def h = inc`, decision 13); the comptime function argument errors of 8.7.

**New or reworded.**

| Case | Message |
|---|---|
| `let f: F` with no value | `'f' needs a value where it is declared: a function value has no default (a ?func(u32) -> u32 starts as none)` |
| `let h: Handler` with no value, Handler holding a function value | `'h' needs a value where it is declared: Handler holds a function value, which has no default` |
| `global g: F` with no value | `global 'g' needs a value: a function value has no default (a ?func(u32) -> u32 starts as none)` |
| a named result that holds a function value | `result 'r' cannot hold a function value: a named result starts with a default, and func(u32) -> u32 has none; return the function instead, or make it ?func(u32) -> u32` |
| an integer for a function value | `cannot assign int(0) to func(u32) -> u32: a function value is a function's name` |
| an integer other than 0 for an optional one | `cannot assign int(5) to ?func(u32) -> u32: a function value is a function's name, or 0 for none` |
| calling an optional function value | `cannot call ?func(u32) -> u32: it may be none; unwrap it with if let or ??` |
| a shared name as a value, no function type expected (`let g = inc`) | `'inc' is the name of several functions: as a value it needs a function type that says which one (let f: func(u64) -> u64 = inc)` |
| a shared name where a function type is expected that no member has | `no function 'inc' is func(u16) -> u16: the functions named 'inc' are func(a: u64) -> u64 and func(a: u32) -> u32` |
| a generic as a value (until stage 9; after it, only where no function type is expected) | `generic function 'max' must be called, or named where a function type picks its instance` |
| a generic where a function type picks no instance (stage 9) | `generic function 'max' has no instance of type func(u32, i64) -> u32: T is u32 from parameter 1 and i64 from parameter 2`; `generic function 'sort' has no instance of type func([]mut i32): its comptime parameter 'before' is a function, which a type does not decide` |
| a builtin as a value (`let r: (f64) -> f64 = sqrt`; today `unknown identifier 'sqrt'`) | `'sqrt' is a builtin, an instruction rather than a function, and has no value: declare a function that calls it` |
| a method without its call (`x.inc`; today `no field 'inc' on type u32`) | `no field 'inc' on type u32 (to take the function's value write inc; a method has no value apart from its receiver)` |
| `f < g`, `f + 1`, `f & g`, ... | `'<' cannot be applied to func(u32) -> u32 and func(u32) -> u32: function values are compared only with == and !=` |
| `-f`, `~f`, `!f` | `'-' cannot be applied to func(u32) -> u32` |
| `f == p`, `f == n`, `==` of two function types | `'==' cannot be applied to func(u32) -> u32 and *u32: a function value is compared only with a function value of its type` |
| `f == 0`, `f` not optional | `'==' cannot be applied to func(u32) -> u32 and int(0): only an optional function value can be none` |
| `f as i64` (any type but `u32`, `i32` and its own) | `cannot cast func(u32) -> u32 to i64: a function value casts only to u32 or i32, its slot` |
| `n as (u32) -> u32` | `cannot cast u32 to func(u32) -> u32: a function value is made by naming a function` |
| `f as (i32) -> i32` | `cannot cast func(u32) -> u32 to func(i32) -> i32: function types match exactly` |
| `p as *Handler` from `*u32` (decision 5, rule 1) | `cannot cast *u32 to *Handler: Handler holds a function value, which memory gives only as its own type` |
| `n as *Handler` from an integer (rule 1) | `cannot cast u32 to *Handler: Handler holds a function value, and its address comes only from the program` |
| `h as *mut u32` from `*mut Handler` (rule 2) | `cannot cast *mut Handler to *mut u32: Handler holds a function value, which only its own type may write (cast to *u32 to read it)` |
| `memzero(hooks)` on plain function values (rule 3) | `memzero cannot clear *mut [2]func(u32) -> u32: a function value has no zero (use ?func(u32) -> u32 for slots that may be empty)` |
| `import "env" "cb" global cb: (u32) -> u32` | `an imported global cannot hold a function value: the host has no slots before the module is instantiated; import the function instead (import "env" "cb" func cb(...))` |
| two declarations of one host function with different signatures | `env.log is imported twice with different signatures: func(x: u32) in main.ents and func(x: u64) in lib.ents` |
| `export slots` twice | `slots are exported twice` |
| `export slots = [hash]`, a shared name, or `[max]`, a generic | `'hash' is the name of several functions and cannot be listed in export slots: list a function that calls the one you mean`; `generic function 'max' cannot be listed in export slots` |
| a function listed twice | `'inc' is listed twice in export slots` |
| `?Point`, a name for a type that is not a pointer, slice or function type | `only pointer, slice and function types can be optional: Point is (x: f64, y: f64)` |
| `?u32`, `?(u32)` | a syntax error, as `?u32` is today |

No new error is a warning. A program that calls a function value it can never fill (it takes none and does not export
its slots) is not an error: it traps at run time, which its first test shows.

## 15. Changes to the reference and the grammar

### 15.1 docs/encantis.md

| Where | Now | Change |
|---|---|---|
| 2.5 Optional Types, :371-397 | "Pointers and slices can be **optional**"; :382 "Only pointer and slice types can be optional" | "Pointers, slices and function values can be optional"; add `?(A) -> R` and `?Name` to the list ("an optional function value: a function's slot, or none (0)"); the representation paragraph adds "an optional function value is the same `i32` slot"; "only the literal 0 is none for a function value" |
| 2.10 Explicit Casts, :825-862 | "A cast converts between numbers and pointers ..." | "A function value casts to `u32` or `i32`, its slot, and to nothing else; nothing casts to a function type. A pointer whose pointee holds a function value casts only as 3.4 says." |
| 3.4 Function Types and Pointers, :1127-1170 | status box :1129; :1131 "At runtime, function values are opaque indices into WebAssembly's function table." | Rename to "Function Values". Drop the status box. Replace :1131 with sections 1.1-1.4 shortened, and add, each inside `<!-- spec:begin compile -->`, "Taking a function's value" (2), "Calling a function value" (3, with the order rule and the trap table), "None and optional function values" (4), "Comparing and casting" (5, with the memory rule). Keep the examples :1133-1170, fixed: `visitor: []u8 -> ()` parses as a slice of functions and becomes `visitor: ([]u8) -> ()`; `get_op(add: bool)` shadows `add`; `map` needs an allocator, not a function value; the curried `i32 -> i32 -> i32` type is fine, but a value of it needs closures (13) |
| D6's text, fix2-decls docs/encantis.md:1211 (if it lands first) | "A function's name is no number either ..." | "A function's name used as a value is its slot (3.4): it compares with `==` and casts to `u32`." |
| 3.3 Variables | | "A variable of a function type, or of a struct or array that holds one, gets its value where it is declared." |
| 4.3 Comparison Operators, :1282 | "`==` and `!=` also compare bools and pointers" | add "and function values of one type (the same slot is the same function); the ordering operators do not" |
| 4.6 Type-Punned Memory Access | | add the memory rule of section 5 (a pun to or from memory holding a function value) |
| 4.7 Bounds-Checked Indexing, :1451 | "produce an optional result when the element type is a pointer or slice" | "... a pointer, a slice or a function type"; add that an optional element is none when the index is out of range or the element is none, and that `if let` and `??` test both (4.3) |
| 4.9 Method-Call Syntax, :1584 | "`x.f(a, b)` calls the function `f` ..." | add "`f` can also be a variable of a function type: `x.f(a)` is then the call `f(x, a)` of that value" |
| 7.1 Imports | | "A host function imported by several modules is one function"; an imported global cannot hold a function value |
| 7.2 Exports, :2085-2108 | the export examples | add `export slots`, `export "fns" slots`, `export slots = [inc, log]`: what is exported, its default name, no maximum, entry module only, once, the written order |
| 7.4 (new) Function Slots | | the host's view: section 8 with recipes 1-5 and the JS, and the warning that numbers belong to one build unless listed |
| 8.1 rule 3, :2158 | "It is not a value ... It can only be called." | "Its name alone is not a value: where a function type is expected, it is the instance that type picks (3.4); otherwise it can only be called. It is never exported to the host." (with stage 9; until then rule 3 stands as it is) |
| 8.4 Instances, :2377-2411 | "An instance is created by the first call that needs it." "No function tables and no indirect calls are involved." | "... by the first call, or the first value, that needs it." "A generic adds no slot and no indirect call of its own: a comptime function parameter is called directly. A run-time parameter of a function type is called like any function value (3.4), in the instance as in the function written out." |
| 8.6, :2623 | "Inside the generic the parameter is not a value ..." | "Inside the generic the parameter can be called, passed on for a comptime function parameter, and used as a value, which is the value of the function it names, as the hand-written function would name it in the same place." |
| 8.7, :2625-2653 | rows for `generic function 'max' must be called` and `'before' is a comptime function parameter`; the sentence that a function value cannot be called at run time | new message for the first; drop the second row; drop the sentence; keep "A generic that calls a function known at compile time takes it as a comptime parameter, which costs no indirect call." |
| 8.8, :2657 | | a row "a function value: a slot, at run time", against the compile-time rows |
| 9.0 Data Layout, :2677 | "Address 0 means "none" for optional pointers and slices" | add "Slot 0 means none for optional function values, and no function has it." |
| 9.3 WASM Type Mapping, :2777-2788 | no row for function types | add `(A) -> R`, `?(A) -> R` → `i32` (the slot) |
| 9.6 Structs and Slices in Memory, :2834 | | add `(A) -> R`, `?(A) -> R`: 4 bytes (the slot) |
| 10 Builtin Functions, :2883 | | "A builtin is an instruction, not a function: it has no value and no slot." |
| 11 WebAssembly Reference, :2976 | | add `call_indirect` (a call of a function value), the table and the segment |
| 13 Closures, :3154 | "Unlike plain function pointers (which are just table indices)" | "Unlike plain function values (slots, 3.4)"; :3175-3180 stays |

### 15.2 Grammar (encantis-grammar.ohm and docs/grammar.md)

No word is reserved.

```ohm
  // encantis-grammar.ohm:151-171, BaseType: after the optional pointer and slice forms
  BaseType = ...
           | "?" Type_func                     -- optFunc
           | "?" typeIdent                     -- optNamed
           ...

  // encantis-grammar.ohm:60-62
  Exportable = FuncDecl
             | GlobalDecl
             | MemoryDecl
             | SlotsDecl

  SlotsDecl = slots ("=" "[" ListOf<ident, ","> "]")?
  slots = "slots" ~identChar                   // not in `keyword`: `slots` stays an identifier elsewhere
```

- `"?" Type_func` requires the `->`, so `?u32` and `?(u32)` still fail to parse, and it takes the whole function type
  to its right: `?(u32) -> u32 -> u32` is an optional `(u32) -> (u32 -> u32)`. `Arg` (:459-465) takes a function type
  as a type argument through `Type_func &("," | ")")`; it gets the same alternative for `BaseType_optFunc`.
- `"?" typeIdent` comes after `optFunc`, so `?Name -> R` is an optional function from `Name`, and it shadows no
  existing form (nothing else starts with `?` and a name).
- `slots` is matched only right after `export` or `export "name"`, where no identifier can stand. `slots` is an
  identifier in the corpus (examples/generics/set.ents:16, examples/types/pointer-globals.ents:9) and stays one.
- AST (ast.ts): `FuncType` (:720-724) and `TypeRef` get `optional?: boolean`, as `PointerType` has; a new
  `SlotsDecl { kind: 'SlotsDecl', order: Ident[] | null }` joins `ExportDecl.item` and the visitor. Actions in
  encantis-actions.ts. Resolved type (types.ts:116-121): `FuncRT.optional?: boolean`; `?Name` resolves to the named
  type with its pointer, slice or function made optional.
- docs/grammar.md: `base_type` (:316-319) gets `| "?" function_type | "?" type_ident`; "Function Types" (:426-437) gets
  the optional form and the sentence on `?`; the exports section gets `export slots`, `export "fns" slots` and the list.

## 16. Tests

### 16.1 Zero cost: what must not change

- `bun test` with `tests/golden/wasm-sha256.json` unchanged for every existing file. New files add entries; no entry
  changes. `bun scripts/watdiff.ts <base checkout>` reports no file whose WAT differs.
- `expectPlainWasm` (generics.test.ts:1365-1369) and the examples check (examples.test.ts:85-91) keep passing, and
  their forbidden list gains `call_ref`, `(type ` and `table.get`, so no later change slips a run-time path into
  generics. Every existing `same-wasm` twin stays byte-identical.
- One negative test: a program with function-typed parameters, fields and globals that never takes, calls or exports
  a function value has no `(table`, no `(elem` and no `call_indirect`.

### 16.2 Spec blocks

- **A new block kind, ` ```wat same-wasm `**: the module must compile to the same `.wasm` as this WAT, assembled with
  the compiler's wabt and flags. It is what "a reader can predict the wasm" means as a test, and it compares bytes,
  not text. **A second kind, ` ```wat `**, from DESIGN-explicit: each line must appear in the compiled WAT, in order,
  as ` ```errors ` lines do. The first pins the bytes; the second shows the reader the lines to expect without pinning
  unrelated formatting. spec/spec.test.ts gets both (beside the `ents same-wasm` handling at :149-164), and
  spec/README.md documents them. The WAT modules of Appendix A are the first set.
- **spec/checks.md**: "Calling a function value" (:1564-1593) becomes "Function values", inside
  `<!-- spec:begin compile -->`, so each accepted module is compiled, validated and its `test` blocks run. Today's three
  programs (a parameter, a local, a field `Handler`) are accepted, with `test` blocks asserting results; the "arguments
  are still checked" block keeps only `argument 1: cannot assign f64 to u32`. One `errors` block per row of section 14.
  The shared-name block at :1549-1562 becomes the pick of section 2 (`apply`'s parameter type names one member) plus an
  error block for `let g = inc`.
- **spec/generics.md**: the block at :2682-2692 becomes an accepted program with a twin (f09's pair), and a twin for a
  comptime function parameter used as a value (`later(inc)` against `later_inc()`). Stage 9 adds a twin for an instance
  picked by type.

### 16.3 Unit tests

| File | What |
|---|---|
| parser.test.ts | `?(u32) -> u32`, `?(u32) -> u32 -> u32`, `(u32) -> ?(u32) -> u32`, `?Hook`, `export slots`, `export "fns" slots`, `export slots = [inc, log]`; `?u32` and `?((u32) -> u32)` still fail; `global slots: u32 = 0` and a field named `slots` still parse |
| types.test.ts | `byteSize` of a function type and an optional one = 4; a struct with a function field = the sum of its fields; `typeEquals` ignores parameter names for `func`; assignability `F` to `?F` and not back, `0` to `?F` only; `canonicalKey` of `?F` differs from `F`'s |
| checker.test.ts | one test per row of section 5 (accepted and refused), replacing "function values can be told apart" (:2352-2358); the value forms of section 2; the no-default rule (4.1); method spelling on a parameter, a local and a global; a field wins over a variable; calling `?F`; the memory rules; an imported global refused; the `export slots` errors; a value taken inside a look (`alone`, `fits`, `peek`) and thrown away records no slot |
| codegen.test.ts | numbering: imports first, then WAT order; two modules; instances in their generic's place; a value taken only in a test comes after every release slot, and the release functions' WAT is the same in both builds; a value taken in an uncalled function has a slot, one in a never-instantiated generic has none; `export slots = [...]` order. Table: absent with no value, `1 1` with calls only, `N N` with values, exported without a maximum. `(i32.const k)` for a name. `call_indirect` signatures for a scalar, a struct (`f64 f64`), a slice (`i32 i32`), no result. The order rule: one test per row of the table in 3.3. A global initialized with a name. The two miscompiles of 6.1 as regression tests. Merged host imports |
| data-pack.test.ts | a function's name in a `data` array and in a struct field of a `data` literal is its slot, 4 bytes little endian; `getElementSize` of a function type = 4 |
| spec/spec.test.ts | the `wat same-wasm` and `wat` block kinds: a matching pair passes, one byte different fails, a missing line fails |

### 16.4 The toolchain promise

- **MVP check**: assemble `examples/functions/` and read the binary back with wabt's `readWasm` with every post-MVP
  feature off except multi-value (DESIGN-explicit's `mvp.mjs`), so that no later change makes function values need a
  new engine feature.
- **Trap tests** check the error's class (`WebAssembly.RuntimeError`), not its message, because V8 and JSC word them
  differently (3.5).
- **A golden test of `-O` output**: run the binaryen devDependency with the CLI's flags
  (`-Oz --enable-bulk-memory --enable-simd --enable-multivalue`, cli.ts:277) on `examples/functions/`, run their tests
  on the result, and pin its hash.
- **The WAT preview**: the extension's `tidyWat` (watPreviewProvider.ts:143-195) folds `(type $x)` references into
  inline signatures, which matches the inline signature of `call_indirect`; one test opens a module with a table.

### 16.5 Examples and hosts

- **examples/functions/** (outside `generics/`, so the plain-wasm check does not apply): `callbacks.ents` (bug 10, a
  global, a returned function, the method spelling), `dispatch.ents` (a `data` dispatch table, `Handler` records,
  mutable hooks), `optional.ents` (4.4), `state.ents` (6.5), each with `test` blocks, pinned by the golden test.
- **A two-module example**, `examples/functions/values/main.ents` and `lib.ents`, with tests that `main`'s `inc` is not
  `lib`'s and that a host import both declare is one value.
- **A host test** for 8.3: a program with `export slots = [...]`, instantiated from JS, running recipes 1-5 with the
  adapter module and the two traps. The existing hosts are untouched.
- **Outside the repository**: the board-builder port's `builder/bugs/10-call-function-parameter.ents` should compile and give
  `apply(descending, 3, 10)`'s value.

## 17. Implementation stages

Each stage is one pull request. Each leaves `bun test` passing, the golden hashes of existing files unchanged (except
where a stage says it fixes a miscompile that a file has) and watdiff empty, and updates the reference sections it
implements. Stages 1a-1d are fixes that stand alone and can land in any order, before the rest.

- **1a. A function value is 4 bytes.** types.ts `byteSize`: `case 'func': return 4` (:1256-1294); data-pack.ts
  `getElementSize` the same (:906-932); the codegen's strides follow. A function's name in a `data` literal becomes the
  error `a function value in data is not supported yet` until stage 3 writes slots, so the zero layout of g8 turns from
  a silent miscompile into an error. Fixes `h.arg` on `*Handler` (p2). Tests: types.test.ts, two codegen regressions.
- **1b. Function types ignore parameter names.** types.ts `typeEquals` for `func` compares types only (:503-511), as
  assignability and `canonicalKey` do. Tests: types.test.ts.
- **1c. Optional elements are tested.** `if let` and `??` on an element of `*[N]?*T` or `[]?*T` test the element as
  well as the index, and a runtime index into one is bounds-checked when the optional is stored (`let m = qs[i]`), as
  ref 4.7 says (o1, o2). Tests: checker and codegen regressions, a spec block. No corpus file has such an element type (no
  `]?*`, `]?[]` or `[]?*` in examples/, lib/ or experiments/), so no golden hash changes.
- **1d. One import per host function.** programToWat (codegen.ts:3627-3653) and the per-module name maps merge host
  imports by module and field name; two declarations with different signatures are an error. Fixes the
  `redefinition of function "$log"` program (judge's `dup/`). Tests: codegen.test.ts, loader tests.
- **2. Checker rules for function values.** Operators and casts per section 5 (a function-value rule in place of the
  pointer one in `checkAddressOperands`, checker.ts:4174-4189; `castProblem`, :6922-6939); no default (4.1); an
  imported global of a function type refused. Checker only. Coordinate with D6 (fix2-decls e3201ca) and e434de1:
  whichever lands second takes these rules and messages. Tests: checker.test.ts rows, spec/checks.md error blocks.
- **3. Values and slots.** Checker: record each value taken, with the unit it is taken in (function, global, `data`
  literal, test) and whether that unit is a test, only in real checks, never in looks (`alone`, `fits`, `peek`; what a
  look records is taken back). A shared name picks by expected type (checker.ts:3183-3189, with the expected type
  through `checkExpr`). A comptime function parameter as a value returns the aliased function's type (checker.ts:
  3177-3182). Builtin and method values get their messages. Codegen: `slotsOf(program)` computes the list of 1.3 from
  the emission order and the record, before the data section (codegen.ts:3541) in both `programToWat` and
  `moduleToWat`; the table and the commented segment after the memory; `identToWat` (codegen.ts:388-394) gives
  `(i32.const k)`; globals initialized with a name (`constantToWat`); data-pack writes slots through a resolver passed
  to `buildDataSection` (the placeholder at data-pack.ts:552-553). After this stage, programs that store, pass, return
  and compare function values assemble and run; calls still give the stage-3 error. Tests: codegen numbering tests,
  data-pack, the zero-cost negative test.
- **4. Calls.** Remove the stage-3 error (checker.ts:3327-3336). `callToWat` (codegen.ts:1036-1043): a callee of a
  function type that is not a function's name becomes `call_indirect $slots` with the flattened signature from its
  `FuncRT`, the argument coercions from the same `FuncRT` (:1086-1114), and the order rule of 3.3 (the constructors'
  `inFieldOrder` from claude/dec-named, or its predicate if that has not landed). `callable` (checker.ts:3679) admits a
  variable of a function type for the method spelling. Generic instances call run-time values. The `wat same-wasm` and
  `wat` spec block kinds. Tests: codegen order tests, spec/checks.md "Function values" in a compile region,
  spec/generics.md twins, bug 10.
- **5. Optional function values.** Grammar `BaseType_optFunc`, `BaseType_optNamed` (bundle with
  `scripts/bundle-grammar.ts`), AST, actions, formatter, hover. `FuncRT.optional`, typeToString, assignability (`F` to
  `?F`, `0` to `?F`). `if let`, `??`, `== 0` on `?F` through the `?*T` paths; calling `?F` refused; a runtime index
  into function elements gives `?F` (4.3). Tests: parser, types, checker, codegen; f05 as a `wat same-wasm` block.
- **6. `export slots`.** Grammar `SlotsDecl` with the optional list; the extension's tmLanguage (`slots` after
  `export`); the exported table without a maximum; the list's order (1.3 group 1) and its errors; reference 7.2 and the
  new 7.4. Tests: the host test of 16.5 (recipes 1-5, the adapter, the traps).
- **7. Memory read as another type** (decision 5). A `holdsFunction(type)` test in `castProblem` for pointer and slice
  casts and integer-to-pointer casts, in the pun view (`p.(T)`), and in `memzero`. Checker only. Tests: checker rows,
  spec error blocks.
- **8. Examples, toolchain tests and the editor.** `examples/functions/` with tests and golden entries; the MVP check,
  the `-O` golden test and the trap-class tests of 16.4; `expectPlainWasm` and the examples check gain `call_ref`,
  `(type ` and `table.get`; hover and an inlay hint `inc: slot 1` on a function's name used as a value (meta.ts),
  computed by the same `slotsOf`; CHANGELOG and README.
- **9. Instances picked by type** (decision 11). A generic's name with an expected function type is checked as a call
  whose arguments have that type's parameter types (`inferGenericCall` with synthetic arguments), and the instance is
  recorded for the name; the messages of section 14; a twin in spec/generics.md; ref 8.1 rule 3. Nothing else depends
  on it.

## 18. Risks that remain

- **Numbers belong to one build.** Without a list, taking the value of a function that stands earlier in the WAT
  renumbers later slots, and a compiler version may change the order. A host or a file that keeps a number across
  builds then calls another function of the same signature, silently. The reference says so where it explains slots,
  and `export slots = [...]` is the fix where numbers are an ABI. Test builds do not renumber release slots (1.3).
- **The run-time check is by wasm signature.** A number from the host, or from memory the host wrote, can call any
  slotted function with the same flattened signature, whatever its Encantis type, as `j2-forge.wat` shows. Inside the
  language the rules of sections 4 and 5 prevent it; without decision 5 they do not.
- **One trap message for none and for a wrong signature** in both engines. The checker refuses a call of `?F`, so only
  numbers from the host can reach it.
- **Performance.** `call_indirect` is not inlined by node 22's V8 (speculative inlining arrived in Chrome M137) or by
  Firefox, and Wasmtime's lazy table init is slow on megamorphic sites (NOTES-wasm 4). The reference says plainly: a
  function known at compile time is a comptime parameter (zero cost); a function value is for choices made at run time.
- **Recording values only in real checks.** A value recorded during one of the checker's looks would give a function a
  slot it should not have, and renumber every later one. The look machinery's "what a look records is taken back" rule
  covers it, and a test pins it (16.3).
- **Dead-function dropping.** Every function is emitted today, so a value taken in a function nobody calls gives a slot
  (builder/README.md item 12 asks for dropping). If dropping comes, it must run before slots are numbered.
- **The `?` reading.** `?(u32) -> u32` is the optional of the whole function type, which a reader may misread, and
  parentheses cannot help. `?Hook` is the readable form, and the reference shows it first.
- **Coordination.** D6 (fix2-decls) and the operand-types change (e434de1) define rules section 5 replaces; the
  written-order rule lives on claude/dec-named. Whichever lands second adopts the other's rules and messages.
- **Hosts.** A JS callback chosen at run time needs the adapter module (or `WebAssembly.Function`, off by default).
  Separately compiled programs share function values only through the host.
- **Not verified here.** Wasmtime and other non-JS engines (MVP tables and `call_indirect` are core wasm, so the risk is
  low; running a downloaded wasmtime wheel was refused in this environment). No implementation exists: the WAT is
  derived by hand from M's output, so the `wat same-wasm` blocks must pin the real codegen when it is written.
- **Adjacent bug, out of scope.** data-pack's zero placeholder also zeroes a `data` name inside another `data` literal
  (`data ps = [xs, xs]`). Stage 3 touches the same code and should not paper over it.

## Appendix A. Validation

Every WAT module of this document is a file in `exp/final/`, checked by `exp/final/run.mjs` with the expected results
in `exp/final/checks.mjs`. For each file the runner (1) assembles it with the compiler's own wabt 1.0.39 and
Encantis's flags `{simd, multi_value, bulk_memory}` (`exp/asm.mjs`), (2) prints the sections, with the table and element
sections in bytes, (3) parses it again with every post-MVP feature off, (4) runs binaryen 129's
`wasm-opt -Oz --enable-bulk-memory --enable-simd --enable-multivalue` (the CLI's `-O`, cli.ts:277, which does not
enable reference types), (5) instantiates it and runs the checks, and (6) runs the same checks on the `-Oz` output.
It also compares the generic program with its hand-written twin byte for byte.

```sh
cd <scratch>/design/indirect-calls/exp/final
ulimit -v 6000000
timeout 120 bun run.mjs
timeout 180 node --disable-wasm-trap-handler run.mjs   # V8 needs this flag under the memory limit
```

Both runs end with `all checks passed`, and `twin f09-generic == f09-twin byte for byte: true`.

| File | Section | Bytes | Table section | Element section | Results (bun 1.4.4 and node 22.23.4 agree; `-Oz` gives the same) |
|---|---|---|---|---|---|
| f01-apply.wat | 3.6 | 99 | `01 70 01 03 03` | `01 00 41 01 0b 02 01 02` | `go(5)` = 16 |
| f02-values.wat | 3.7 | 237 | `01 70 01 03 03` | `01 00 41 01 0b 02 00 01` | 6; 10; [1,0]; 2; [42,42]; 20; slot 0 and slot 3 trap |
| f03-multivalue.wat | 6.4 | 116 | `01 70 01 03 03` | `01 00 41 01 0b 02 00 01` | [1.5,2.5]; [3.5,1.5] |
| f04-memory.wat | 6.3 | 303 | `01 70 01 04 04` | `01 00 41 01 0b 03 00 01 02` | [11,9,20,11]; 42; 6; 10; a 0 the host stores traps |
| f05-optional.wat | 4.4 | 327 | `01 70 01 03 03` | `01 00 41 01 0b 02 00 01` | [0,0]; 8; [1,3,4]; 5; 6; 10 |
| f06-host.wat + f06-adapter.wat | 8.3 | 192 + 33 | `01 70 00 03` (no maximum) | `01 00 41 01 0b 02 01 00` | the JS of 8.3: [3,null]; 1; 42; 2; [0,1,2]; two traps; grow gives 3; 40; `slots.set` of a JS function is a TypeError; identity true |
| f07-order.wat | 3.3 | 157 | `01 70 01 03 03` | `01 00 41 01 0b 02 00 01` | `run()` = 22 (callee first); `run2(3)` = 4 |
| f08-modules.wat | 7 | 177 | `01 70 01 05 05` | `01 00 41 01 0b 04 00 01 05 06` | [21,103]; [0,0]; 1 |
| f09-generic.wat, f09-twin.wat | 9 | 120, 120 | `01 70 01 02 02` | `01 00 41 01 0b 01 03` | 13; 1; identical bytes |
| f10-calls-only.wat | 1.4 | 56 | `01 70 01 01 01` | none | slot 0 traps (null or mismatch), slot 1 traps (out of bounds) |
| f11-overload.wat | 2 | 87 | `01 70 01 02 02` | `01 00 41 01 0b 01 01` | `h(9)` = 7 |
| f12-slice.wat | 6.3 | 175 | `01 70 01 03 03` | `01 00 41 01 0b 02 00 01` | 10; 6; 6 |
| f13-state.wat | 6.5 | 202 | `01 70 01 03 03` | `01 00 41 01 0b 02 00 01` | 4 words |
| f14-release.wat, f14-test.wat | 1.3 | 91, 159 | `01 70 01 02 02`, `01 70 01 03 03` | `01 00 41 01 0b 01 01`, `01 00 41 01 0b 02 02 01` | 10; 10 and the test passes |

How to read the bytes. Table section: 1 table; `70` funcref; limits flag `01` (min and max) or `00` (min only); min;
max. Element section: 1 segment; flags `00` (active, table 0, function indices: the MVP form); the offset
`i32.const 1; end` (`41 01 0b`); the count; the function indices. In f01 they are 1 and 2 because `$apply` is function
0; in f06, `01 00` are `$inc` (function 1) and the import `$log` (function 0), in slot order. Every file also parses with
all post-MVP features off. wabt's text parser does not reject multi-value results with multi-value off, so that check
says nothing about f03; f03 needs multi-value, which Encantis already requires.

The trap messages: V8 `null function or function signature mismatch` and `table index is out of bounds`; JSC
`call_indirect to a signature that does not match` and `Out of bounds call_indirect`. A plain JS function given to
`slots.set`: V8 `WebAssembly.Table.set(): Argument 1 is invalid for table: function-typed object must be null (if
nullable) or a Wasm function object`; JSC `Argument value did not match the reference type`.

The probes at M (`exp/final/probe/`, compiled with `bun packages/cli/src/cli.ts compile` in `<scratch>/methods`):

| Probe | Shows |
|---|---|
| `g10.ents` | `f < g`, `f + 1`, `f == p`, `n as (u32) -> u32`, `f as (i32) -> i32`, `f as i64`, and `==` of types that differ only in parameter names: all accepted today |
| `g8.ents` | `data ops = [inc, dec]`: zero bytes, read at `+0` and `+1` |
| `r1.ents` | `let h: Handler` and `let fs: [2](u32) -> u32` with no value: accepted, zero |
| `t1.ents` | `type State = (c: u8) -> State`: accepted today |
| `c1.ents` | `p as *Handler`, `n as *Handler`, `h as *mut u32`: accepted today |
| `o1.ents` + `o1run.mjs` | `qs[i] ?? &d` on `*[3]?*u32` uses a none element: `a(0)` = 0, where 7 is right |
| `o2.ents` | `let m = qs[i]` on `*mut [2]?*u32`: no bounds check; the `if let` and `??` shapes of `?*T` |
| `gen.ents` | M's instance names `$apply<u32>`, `$twice<u32\|inc>`, `$later<inc>`, and today's `(ref.func $inc)` for an `i32` parameter |
| `tb.ents` + `tb.mjs` | M's test-build WAT: `__assert_fail` import first, test functions after the exports |
| `j1b.mjs` | `(elem (table $slots) ...)` fails to parse with `bulk_memory` and `reference_types` off; `(elem (i32.const 1) ...)` parses |
| `optlook.mjs` | prints a module's `-Oz` output: in f04, wasm-opt inlines `fire` into `second` and drops its scratch local |

The judges' probes reused here: `exp/judge/z1.ents` (zero defaults), `p2.ents` (`h.arg` with no load), `dup/`
(duplicate host import), `j1-flag.wat` (both segment forms encode as flag 0), `j2-forge.wat` (a forged slot runs a
function of another Encantis type).

## Appendix B. The judges' flaws, checked, and what this design does

| Flaw (judge) | Checked | What this design does |
|---|---|---|
| Non-local numbering; test builds number differently (owner M1, engineer 2) | yes: codegen.ts:3140-3162, :3627-3653; loader.ts:58-104; `tb.ents` | values taken only in tests come last, so release slots are the same in test builds (1.3, f14); `export slots = [...]` pins numbers for hosts (8.3); the segment comment and the editor show the numbers |
| Zero defaults make a plain value none (owner M2, engineer 1) | yes: `z1.ents`, `r1.ents` | no default for plain function types, with refs' messages (4.1); `?F` for values that may be absent |
| One table for every signature: forging reaches another Encantis type (owner M3, engineer 3) | yes: `j2-forge.wat`, `c1.ents` | integer-to-function casts refused (5); memory reinterpretation refused (decision 5, stage 7); what remains is the host, checked by `call_indirect` (18) |
| Wrong reason for the short segment form (owner M4, engineer 5) | yes: `j1-flag.wat`, `j1b.mjs` | the stated reason is now the true one: the short form is the MVP text form (1.4) |
| `h.arg` described as "read at the wrong place" (engineer 6) | yes: `p2.ents` | described as it is: no load, the address is returned (6.1) |
| `ops[i] ?? inc` checks the index, not the element (owner) | yes: `o1.ents`, `o2.ents` (and found that M also gets `?*T` elements wrong) | a plain element is never 0 (4.1, 5); an optional element's `if let` and `??` test the element too (4.3), and stage 1c fixes `?*T` |
| `def h = inc` stays an error (owner) | yes | kept as an owner decision with a recommendation (decision 13) |
| `export slots` exposes private functions, no maximum (owner) | yes | stated in 8.3 and the reference; the maximum is decision 8 |
| A host import two modules declare has no defined slot (owner) | yes: `dup/` reproduced | one import, one slot (7, decision 12, stage 1d) |
| Recording values in looks would renumber slots (engineer 4) | yes: the looks are `alone`, `fits`, `peek` | real checks only, with a test (stage 3, 16.3) |
| Recursive function types refused (engineer 7) | no: M already accepts `type State = (c: u8) -> State` (`t1.ents`) | kept, with a run (6.5, f13) |
| `typeEquals` compares parameter names (all; found by refs) | yes: types.ts:503-511, :540-542 | ignored for `func` (1.5, stage 1b) |
| `(inc)(x)` differs between designs (engineer) | yes: refused at M (g12) | a direct call (decision 9) |
| No implementation; scratch-local names and order conditions must be pinned (all) | yes | `wat same-wasm` and `wat` spec blocks (16.2); the order rule is the constructors' (3.3) |
| Ref 3.4's `visitor: []u8 -> ()` is a slice of functions (owner) | yes: the grammar's prefixes take a full Type | rewritten as `([]u8) -> ()` (15.1) |
| The operator and cast rules of M (e434de1) and D6 disagree (all) | yes: `g10.ents` | one table of rules (5); whichever lands second adopts it (stage 2) |
| Not verified on wasmtime or in the extension's preview (owner) | wasmtime: could not run it here; preview: `tidyWat` read | wasmtime still unverified (18); the preview folds `(type $x)` into inline signatures, which matches (16.4) |
| Explicit, refs: their flaws (zero default calls the first function, E1, no library callbacks, multi-table; Wasm 3.0, nightly assembler, no equality, no memory) | read, and re-run by the judges | why not chosen (12) |
