# Comptime value parameters: design

For the owner, who wrote on 18 November: 'the "comptime n: u32 with [n]T would help containers the most" sounds
great'. This is the design of that feature: value parameters, `comptime n: u32`, and types whose lengths and bounds
are written with them, `[n]T`, `*[n]T`, `u32#n`.

- **Base.** `origin/claude/generics-modules` at a84f5e6 (stage 5, #31, which holds stages 1 to 3, both fix rounds and
  the 17 November decisions), checked out read-only and detached at
  `<scratch>/design/comptime-values/base`. Paths without a directory are in `packages/compiler/` there, and
  line numbers are of that checkout.
- **What it builds on.** The generics plan (`<board-builder port>/moonbit/encantis/generics/PLAN.md`), whose
  section 3.10 already says how value parameters follow ("a value parameter evaluates its argument with the existing
  `evalComptimeExpr` and substitutes a literal"), and the merged stages as their pull requests describe them. Nothing
  here changes a rule of stages 1 to 5 or of the 17 November decisions; where this design touches one, it says so.
- **Evidence.** **[ran]** marks what I ran on the base compiler. The generic side of an example cannot be compiled
  yet, so every WAT block below is the base compiler's output for the example's **hand-written twin** (the generic
  written out by hand for each instance), with the twin's function names replaced by the instance names. That is
  what the zero-cost rule says the instance must be, byte for byte. The pairs are in
  `<scratch>/design/comptime-values/probes/doc/` (`NN.generic.ents`, `NN.twin.ents`, `NN.wat`, `NN.wasm`,
  `build.sh`); each twin compiles, validates, and passes its tests. **[design]** marks what is specified here and run
  nowhere. **[ran: cNN]** marks a probe of the critique, `probes/critique/cNN.ents`, run on the same base.
- **Revised.** A critique checked every example, message and claim against the base compiler and the reference, and
  this text is the revised design. Section 13 lists each change and why. `parts/` holds the text before the
  revision; this file supersedes it.

Contents

1. Summary
2. Decisions, with the alternative to each
3. The language chapter: a new 8.7 "Comptime Value Parameters"
4. The WAT of the chapter's examples
5. Errors, with their exact messages
6. What the container library gains
7. Deliberately left out
8. What changes for programs without value parameters
9. Implementation, by file and function
10. Tests and acceptance
11. Risks and open questions for the owner
12. Appendix: what was run
13. Revisions

---

## 1. Summary

A value parameter is a comptime parameter whose argument is a number. The mechanism is the one stages 1 and 2 built
for types: an instance is a copy of the generic's declaration with each comptime parameter replaced by its argument,
checked and compiled as an ordinary function. A type parameter is replaced by a type; a value parameter is replaced by
its number, as `def n = 8` replaces `n` today. Every rule the language has for a number then applies to it, in an
expression and in a type, with nothing added: `for i in n` counts with a `u32#n`, `x % n` is a `u32#n`, `xs[i]` on a
`*[n]T` with that `i` needs no check, and `[n * 2]T` is a type with a number in it.

```ents
func get(comptime n: u32, comptime T: type, xs: *[n]T, i: u32#n) -> T => xs[i]

data widths = [3:u16, 1, 4, 1, 5, 9, 2, 6]

export func a(k: u32) -> u16 => get(widths, k & 7)     // n = 8, T = u16, from *[8]u16
```

```wat
  (func $get<8|u16> (param $xs i32) (param $i i32) (result i32)
    (i32.load16_u (i32.add (local.get $xs) (i32.mul (local.get $i) (i32.const 2))))
  )
```

The value is inferred from a length in an argument's type (`*[8]u16` gives `n = 8`), or written (`get(8, u16,
widths, k & 7)`); slices, which have no length in their type, never decide it. Generic types take value parameters
too, so a container can carry its capacity in its type: `Ring(8, u32)`, `FixedVec(64, Cell)`. Section 6 shows what
the library gains: a fixed-capacity vector, a ring buffer, a bitset and buffers laid out once per size, each with
unchecked indexing proven by the capacity.

The work is small next to stages 1 to 3: the grammar learns lengths and bounds that are expressions, the checker
learns a third kind of comptime argument (beside types and functions), a length in an inferred argument, and value
arguments of generic types. Codegen is unchanged, apart from one existing fault that instances would reach at once
(section 9, P1). Two existing faults of hand-written code are fixed on the way because numbers from parameters reach
them easily: a type of 4 GiB or more (D9), and the near miss `n-1`, which is one name (D16). About 650 lines with
tests, by the size of the stages before it **[design]**.

What a reader coming from Zig or C++ should know first, since the language has no compile-time `if`: a value
parameter selects nothing. Both branches of every `if` are in every instance, so a generic cannot recurse on a value
that changes (section 3, Instances), and an instance for `n = 0` is refused wherever its body needs a proof that `0`
does not give, as the same function written by hand for 0 is (D8).

## 2. Decisions, with the alternative to each

| # | Question | Decision | Alternative | Why |
|---|---|---|---|---|
| D1 | What `n` is in the body | The number, as a literal: untyped, so its place types it. In the instance it is what `def n = 8` would put there, and it can be used wherever `xs.len` of a `*[n]T` can | A typed constant, as `def n: u32 = 8` is: `let k = n` would be a `u32` in every instance | A typed constant gives no range today **[ran: probes/t5, t18]**: with `def k: u32 = 8`, `for i in k`, `x % k`, `x & (k - 1)` and `x & 7:u32` are plain `u32`s and the index is refused, while with `def k = 8` all are proven. So a typed `n` would lose the proofs that are the point of `[n]T`. Making typed constants give ranges would change hand-written code: `examples/crypto/ed25519/field.ents` writes `let h0 = h0-lo & mask51` with `def mask51 = 0x7FFFFFFFFFFFF:u64` and changes `h0` afterwards, which a ranged `h0` refuses (#29, B3). The cost of the number: `let k = n` is an `i32` (an `i64` past an `i32`), the same as `let k = xs.len` is today **[ran: c10]**; section 3 says to write `let k: u32 = n`. So the parameter's declared type checks the argument and types nothing in the body: with `comptime n: u64`, `let k = n` is still an `i32` for `n = 8`. **A literal, not a scoped `def`:** a `def` the checker resolves by name (one used before its declaration, which the parser does not substitute) gives the same ranges **[ran: c22]**, but it compiles to `(i64.extend_i32_s (i32.const 8))` where the literal gives `(i64.const 8)` **[ran: c28]**, and as a value-array index it crashes codegen **[ran: c27]**. Only the literal is byte for byte what the hand-written twin has. The name is still declared in the instance, for the errors of D14 |
| D2 | Which types a value parameter may have | Every integer type, `i8` to `i512`, `u8` to `u512`, also with a range (`comptime n: u32#65`) | `u32` only; or also `bool` and floats | The type is only what the argument is checked against, and the substitution does not depend on it. `bool` is left out because it would choose nothing: there is no compile-time `if`, and codegen does not drop `if true` **[ran: t20]**, so the instance would test a constant at run time. Floats have no place in a type, and `-0.0` and NaN make poor instance keys |
| D3 | Names | Lower-case, as every value's; an upper-case one is an error that shows the lower-case spelling | Allow `comptime N: u32`, as Zig writes it | Identifiers start lower-case (1.2) and type identifiers upper-case (1.3); the parser tells them apart by that. In a type, `[N]T` would read `N` as a type |
| D4 | Written or inferred | Inferred like a type parameter, and counted with them: `P` arguments explicit, `P - K` inferred, `K` the type and value parameters. The first argument that can decide decides | Always written, as a comptime function parameter is | The request: `*[8]u8` gives `n = 8`. Counting values with types keeps 8.2's one rule for the form of a call |
| D5 | What decides `n` | A length that is the parameter's name alone, `[n]`, in an argument's type that has a length there: an array pointer, an array value, a table, through generic types and typed parts of tuples. Nothing else: slices, many-pointers, `[!]`, packed blocks, `[n * 2]`, a range `u32#n`, array literals | Solve `[n * 2]` against `[8]`; let a range decide; let an array literal decide by its count | There is no algebra of lengths and none is needed elsewhere (D6). A range is only what the checker knows of a value, and a narrower one fits: `k & 3` is a `u32#4`, a fine argument for a `u32#8` parameter, so letting it decide would make `n = 4` where the call meant 8. Ranges are already dropped for `T`. Literals: rule 3 of 8.2 says an array literal is untyped as a whole; its count could decide without ambiguity, which is open question Q1 |
| D6 | Arithmetic in types | Any constant expression in a length or a bound; two types are the same when they are with their lengths computed, in the instance | Only the bare name; or compare lengths as expressions in the generic | A generic is checked only as its instances, so a type with an unknown length is never compared. `[a + b]u8` in `join` is a `[5]u8` and nothing more |
| D7 | Lengths that are expressions outside generics | Yes: a length or bound may be any constant expression in every type, so a `def` sizes a type (`*mut [size]u8`, `u32#size`) | Only inside generics | One rule for types; `def n = 64` is the module-level form of `comptime n: u32` (8.10's table). Today `[k]u8` with a `def k` is a syntax error |
| D8 | `n = 0` | A number like any other. The types it makes are fine except `u32#0`, an error (also written by hand): `[0]T`, `*[0]T`, `for i in 0` and `scratch(0)` are accepted. A body is refused at `n = 0` wherever it relies on a proof that `0` does not give, with the error its hand-written twin gets: `for i in 0` counts with a plain `u32`, since a `u32#0` would have no values, so `xs[i]` in `sum` is unproven **[ran: c01]**; `return false when i >= 0` narrows nothing, so `FixedVec(0, T)`'s store is unproven **[ran: c02]**; `Ring(0, T)` has a `head: u32#0` | Refuse 0 at the call; or make a loop that never runs prove every index in its body (open question Q7) | The owner's rule for types (Q1, 17 Nov): "the usage of T restricts what types T can be". Zero cost holds at `n = 0` too: the instance is refused exactly when its twin is |
| D9 | Lengths, sizes and bounds out of range | Errors everywhere: a length above 4294967295 (no `.len` holds it); an array of more than 4294967295 bytes (`n * sizeof(T)`), in registers, in memory or behind a pointer; a bound of 0; a bound above the number of values of its type (`u8#300`) | Keep accepting them, as hand-written code is today **[ran: t11, t12, t13, c12]** | Numbers from parameters reach these; they are never meant. The size limit is a fault today: `sizeof([536870912]u64)` emits `(i32.const 4294967296)`, which no assembler takes **[ran: c13]**, and an index into a `*[1000000000]u64` is checked against its length but its address `i * 8` wraps past 4 GiB **[ran: c05]**. Below the limit, every proven index's byte offset fits an `i32`. No source in either repository writes any of these; the largest length in either is 16777216 **[ran: grep]** |
| D10 | Instance key and name | The value in decimal, as the parameter's type holds it, among the other comptime arguments in declaration order: `$push<8\|u32>`, `$shift<-3>`; label `push(n = 8, T = u32)` | Typed (`8:u32`) or hexadecimal | Readable, and never equal to a type's key, which starts with no digit and no `-` |
| D11 | Generic types | Take value parameters: `func Ring(comptime n: u32, comptime T: type) -> type`, applied as `Ring(8, u32)` | Value parameters on functions only | A container with its capacity in its type is the request |
| D12 | Order of parameters | Convention only: comptime parameters first, in the order a type writes them, `n` before `T` as in `[n]T` | `T` first, as 8.1's convention says for types and as Zig's `BoundedArray(T, n)` has it | Reads like the type it builds. It is a convention; the language takes either |
| D13 | A value parameter named like a module `def` | An error at the declaration | Let the `def` win silently | The parser substitutes a `def` declared before its use (encantis-actions.ts:1549-1573), so the body would read the `def` and never the parameter. The same check exists for a type parameter named like a type (checker.ts:7137) |
| D14 | Assigning to `n`, or binding its name again in the body (`let n`, `for n in`, `if let n`, a match arm `n =>`) | Errors in each instance, with the instance label, as every mistake in a body is (8.3) **[ran: c16]**. The instance declares `n` in the function's scope, beside the parameters, as a `def` of the number, so the language's own rules find these: `'n' is already declared in this scope` **[ran: c23, for a parameter]**, `'n' is already declared: a match binding cannot reuse the name of a comptime value parameter` (today `... the name of a def` **[ran: c24]**), and for an assignment `cannot assign to 'n': it is a comptime value parameter` (today `it is not a variable` for a `def` **[ran: c25]**): the messages name what `n` is | Report at the declaration, by a walk of the body | Substitution alone would make these silent: `let n = 5` would declare a local nobody reads, since every `n` after it is already the number. Declaring the name reuses every rule about names, in every binding form there is and any added later, where a walk would have to list the forms. A generic nobody calls stays only parsed (8.1, rule 4) |
| D15 | `[0x10]u8` | Sixteen bytes. The packed separator `x` is read only between decimal numbers | Keep: today it is the packed `0 x 10`, with `.len` 0 **[ran: t16]** | Once a length can be any constant, a hexadecimal one has to mean its value |
| D16 | `n-1` | It stays one name (1.2). The message for an unknown name that is a known name, a hyphen and a number says so: `unknown identifier 'n-1': a hyphen joins a name; for subtraction write n - 1` | Today's `unknown identifier 'n-1' — did you mean 'n'?` **[ran: c11]** | `n - 1` is the most common expression in a length and an index of this feature (`v[n - 1]`, `u32#(n - 1)`, `x & (n - 1)`), and today's hint points at the wrong fix |

---

## 3. The language chapter: a new 8.7 "Comptime Value Parameters"

This is the text of a new section **8.7** of `docs/encantis.md`, after "8.6 Comptime Function Parameters"; today's
8.7, 8.8 and 8.9 become 8.8, 8.9 and 8.10. It is written inside the chapter's `<!-- spec:begin compile -->` region,
so the spec runner checks, compiles and validates every block in it, runs its `test` blocks and compares each `ents
same-wasm` pair byte for byte. Section 4 gives the WAT each example compiles to; section 5 the errors; the edits to
8.1, 8.2, 8.4, 8.9 and 8.10 that go with it are in section 9.

> ### 8.7 Comptime Value Parameters
>
> A **value parameter**, `comptime n: u32`, is given a number at compile time. Inside the function `n` is that number. It can stand where a number can, and it can size a type: `[n]T` is an array of `n` elements, `*[n]T` a pointer to one, `u32#n` a number below `n`. Each number the function is called with makes an instance of its own, so a length that is a value parameter is part of the instance's types, and whatever the compiler proves from a length written as a number it proves from `n`.
>
> ```ents
> func sum(comptime n: u32, xs: *[n]u32) -> (total: u32) {
>   for i in n {
>     total += xs[i]
>   }
> }
>
> data primes = [2:u32, 3, 5, 7]
> data squares = [1:u32, 4, 9, 16, 25, 36, 49, 64]
>
> export func a() -> u32 => sum(primes)          // n = 4, from *[4]u32
> export func b() -> u32 => sum(8, squares)      // n written
> export func c() -> u32 => sum(2 + 2, primes)   // the instance of a
>
> test "each length is its own function" {
>   assert a() == 17
>   assert b() == 204
>   assert c() == 17
> }
> ```
>
> compiles to exactly the module this does:
>
> ```ents same-wasm
> func sum_4(xs: *[4]u32) -> (total: u32) {
>   for i in 4 {
>     total += xs[i]
>   }
> }
> func sum_8(xs: *[8]u32) -> (total: u32) {
>   for i in 8 {
>     total += xs[i]
>   }
> }
>
> data primes = [2:u32, 3, 5, 7]
> data squares = [1:u32, 4, 9, 16, 25, 36, 49, 64]
>
> export func a() -> u32 => sum_4(primes)
> export func b() -> u32 => sum_8(squares)
> export func c() -> u32 => sum_4(primes)
>
> test "each length is its own function" {
>   assert a() == 17
>   assert b() == 204
>   assert c() == 17
> }
> ```
>
> In `sum<4>` the loop counter is a `u32#4` and `xs` is a `*[4]u32`, so `xs[i]` is read without a check, as it is in `sum_4`.
>
> Rules:
>
> 1. A value parameter is written `comptime n: u32` in the parameter list of a module-level `func`, as every comptime parameter is ([8.1](#81-compile-time-parameters)). Its type is an integer type, `i8` to `i512` or `u8` to `u512`, written out or named, and may carry a range: `comptime n: u32#65` takes the numbers below 65. The type says which numbers the parameter takes, and nothing more: in the body `n` is the number ([below](#inside-the-function)).
> 2. Its name starts with a lower-case letter, as every value's does. A type parameter's starts with an upper-case one.
> 3. A function with a value parameter is a generic function: it can only be called, it is checked for each instance, and nothing of it is emitted until it is called.
> 4. Comptime parameters may stand anywhere in the list, and a parameter's type may use any of them. By convention they come first, in the order a type writes them: `n` before `T`, as in `[n]T`.
> 5. A value parameter's name is not the name of another parameter or a result of the function, nor of a `def` of the module, and the body does not bind it again (`let n`, `for n in`, a match arm `n =>`), as for any parameter.
>
> #### Inside the function
>
> In an instance, `n` is the number the call gave, written in place of the name, exactly as `def n = 8` would put it there.
>
> - **In an expression** it is that number, and has no type of its own, as a literal has none: it takes the type its place gives it. `x < n`, `let y: u8 = n`, `return n` and `f(n)` are what they are with `8` written there. `let k = n` gives `k` the type `let k = 8` gives (`i32`, or `i64` for a number that an `i32` does not hold): write `let k: u32 = n` for a variable that has one type in every instance.
> - **It is not a variable.** `n = 3`, `n += 1` and `set (n, x) = ...` are errors, and so is a binding that reuses its name; each is reported in every instance, as any mistake in a body is ([8.3](#83-requirements)).
> - **In a type** it is a length or a bound: `[n]T`, `*[n]T`, `*mut [n]T`, `[n][m]T`, `*[n][m]T` (a table, [Nesting](#nesting)), `u32#n`, and an argument of a generic type, `Ring(n, T)`. Any constant expression may stand there: `[n * 2]T`, `[(n + 31) / 32]u32`, `[n * sizeof(T)]u8`, `u32#(n + 1)`. A length is written between the brackets; a bound follows `#` directly when it is a name or a number, and in parentheses otherwise.
> - **Every rule about a number holds for it**, because in the instance it is one: `for i in n` counts with `i: u32#n` ([Ranged Integers](#ranged-integers)); for an unsigned `x`, `x % n` is a `u32#n` and `x & (n - 1)` is a `u32#n`; `v[n - 1]` is a constant index; `[0:u8; n]` is `n` zeros; `sizeof([n]T)` is `n * sizeof(T)`; `.len` of a `*[n]T` is `n`. So does every rule about the number `0`, where a body is instantiated with it ([Bounds](#bounds)).
> - **A hyphen joins a name** ([1.2](#12-identifiers)): `n-1` is one name, not `n` minus 1. Write `v[n - 1]`, `[n - 1]T`, `u32#(n - 1)`.
>
> ```ents
> func last(comptime n: u32, comptime T: type, v: [n]T) -> T => v[n - 1]
> func rotl(comptime k: u32, x: u32) -> u32 => (x << k) | (x >> (32 - k))
>
> export func a(x: f64) -> f64 {
>   let v: [3]f64 = [x, 2.0, x * 3.0]
>   return last(v)                                // n = 3, T = f64, from [3]f64
> }
> export func mix(a: u32, b: u32) -> u32 => rotl(7, a) ^ rotl(13, b)
> ```
>
> `last<3|f64>` takes the three values of `v` in three registers and returns the third; `rotl<7>` shifts by `7` and by `32 - 7` (the language's `x <<< k` is one instruction; `rotl` spells it out to show `n` in arithmetic). A value array is held in registers, so it is indexed by constants only, in a generic as anywhere ([2.4](#24-fixed-arrays-value-type)): `v[n - 1]` is one, and `v[i]` in `for i in n` is not.
>
> #### Calling a function with value parameters
>
> The two forms of [8.2](#82-calling-a-generic-function) hold, with value parameters counted with the type parameters: if a function has `P` parameters of which `K` are type or value parameters, a call with `P` arguments is explicit and a call with `P - K` arguments is inferred. A comptime function parameter is written in both forms.
>
> **Explicit.** The argument of a value parameter is a **compile-time constant**, the same kind of expression that may stand in a length: a number (`8`, `0x40`, `8:u32`, `'a'`), a `def`, a value parameter of the enclosing generic, `sizeof` of a type (also of a type parameter), the `.len` and `.wid` of a `*[N]T`, and arithmetic, bitwise operators and shifts on these. A variable, a global, a call or the address of `data` is not one. It is checked against the parameter's type as any argument is, by its exact value (`sum(0 - 1, p)` is `argument 1: cannot assign int(-1) to u32`), and the instance gets the value it has in that type: `~0` for a `comptime m: u8` is 255.
>
> **Inferred.** A value parameter is found from the other arguments as a type parameter is: going through the parameters left to right, the first one whose written type has `n` as a length, and whose argument has a length in that place, decides it.
>
> | Parameter | Argument | Result |
> |---|---|---|
> | `*[n]T`, `*mut [n]T` | `*[8]u32`, `*mut [8]u32` (a `data` array; a string `"abc"` is a `*[3]u8`) | `n = 8` |
> | `[n]T` | a `[3]f64` held in registers | `n = 3` |
> | `*[n][m]T` | `*[2][3]i32` | `n = 2`, `m = 3` |
> | `*Ring(n, T)` | a pointer to a struct of `Ring`'s shape | `n` from the field `items: *mut [n]T` |
> | `(*[n]u8, u32)` | a tuple `(buf, 1)` | `n` from its typed part |
> | `comptime f: (*[n]u8) -> u32` | a function `g(p: *[8]u8) -> u32` | `n = 8`: a function argument decides as any argument does ([8.6](#86-comptime-function-parameters)) |
> | `*[n]T` | a slice `[]u32`, a `[*]u32`, a `*[!]u32`, a packed `*[2x3]u32` | nothing: there is no length in the type, or not one of that shape |
> | `*[n]T` | a `[4]u32` held in registers | nothing: it has no address ([2.4](#24-fixed-arrays-value-type)), so it matches no pointer, as for `T`; written out, `sum(4, v)` is `argument 2: cannot assign [4]u32 to *[4]u32` |
> | `*[n * 2]u8` | `*[8]u8` | nothing: only a length that is the name alone decides |
> | `u32#n` | a `u32#8` | nothing: a range is dropped, as it is for `T` |
> | `*[n]u32` | an array literal `[1, 2, 3]` | nothing: literals never decide (8.2, rule 3) |
>
> Every other argument is then an ordinary argument of the instance, with the same conversions and the same errors: `join("hel", "lo", big)` below, with a `big` of 8 bytes, is `argument 3: cannot assign *mut [8]u8 to *mut [5]u8`. Nothing is guessed: a value parameter that no argument decides has to be written, and so do the other type and value parameters of that call, since there is no form that writes some of them.
>
> ```ents
> func sum(comptime n: u32, xs: *[n]u32) -> u32 => 0
>
> func f(xs: []u32) -> u32 => sum(xs)
> func g(x: u32, p: *[4]u32) -> u32 => sum(x, p)
> ```
>
> ```errors
> cannot infer n for 'sum': a []u32 has no length in its type; write the value argument, as in sum(8, ...)
> argument 1 of 'sum' must be a compile-time constant: n is a comptime value parameter
> ```
>
> #### Arithmetic in types, and when two types are the same
>
> A length or a bound may be any compile-time constant (as for an explicit argument, above). It is computed in each instance, as any constant is ([Comptime Literal Promotion](#comptime-literal-promotion)); a length is used as no type, so it is computed exactly, with nothing to wrap in, even where a part of it is typed (`sizeof(T)` is a `u32`), and the type then has that number in it. Two types are the same when they are the same with their lengths computed, as types always are: in an instance where `n` is 4, `[n * 2]u8`, `[2 * n]u8`, `[n + n]u8` and `[8]u8` are one type. Nothing about lengths is ever compared before they are numbers: a generic is checked only as its instances, so there is no rule of algebra for lengths, and none is needed.
>
> ```ents
> func join(comptime a: u32, comptime b: u32, x: *[a]u8, y: *[b]u8, out: *mut [a + b]u8) {
>   for i in a {
>     out[i] = x[i]
>   }
>   for j in b {
>     out[a + j] = y[j]
>   }
> }
>
> data buf = mut [0:u8; 5]
>
> export func hello() -> u8 {
>   join("hel", "lo", buf)      // a = 3, b = 2; out is a *mut [5]u8, which buf is
>   return buf[4]
> }
>
> test "joined" {
>   assert hello() == 111
> }
> ```
>
> A length is a number from 0 to 4294967295, the most a `u32` `.len` holds, and an array, wherever it is (in registers, in memory, or behind a pointer), has at most 4294967295 bytes: `sizeof([n]T)` is a `u32`, and so is the byte offset of every element a proven index reaches. A bound is at least 1 (`u32#0` would have no values) and at most the number of values its type has (`u8#256` is every `u8`). These hold for types written by hand too.
>
> #### Bounds
>
> What a length proves, it proves in every instance. A ranged index below the length is read and written without a check; an index that is not proven is resolved with `if let` or `??`, or is an error, as in hand-written code ([4.7](#47-bounds-checked-indexing)).
>
> ```ents
> func get(comptime n: u32, comptime T: type, xs: *[n]T, i: u32#n) -> T => xs[i]
>
> data widths = [3:u16, 1, 4, 1, 5, 9, 2, 6]
>
> export func a(k: u32) -> u16 => get(widths, k & 7)
> export func b(k: u32) -> u16 => get(widths, k % 8)
> ```
>
> `get<8|u16>` is one load. The proof is the caller's: `get(widths, k)` with a plain `k: u32` is `argument 2: cannot assign u32 to u32#8`, and `get(widths, k & 15)` is `argument 2: cannot assign u32#16 to u32#8`.
>
> **`n = 0`** is a number like any other, so an instance for it is refused exactly where the same function written by hand for 0 is. `u32#0` is no type, so `get` cannot be made for an empty array. A loop `for i in 0` counts with a plain `u32`, since its counter has no values to range over, and nothing it indexes is proven; nor does `i >= 0` narrow anything:
>
> ```ents
> func sum(comptime n: u32, xs: *[n]u32) -> (total: u32) {
>   for i in n {
>     total += xs[i]
>   }
> }
>
> data none: *[0]u32 = []
>
> export func z() -> u32 => sum(none)
> ```
>
> ```errors
> runtime index on *[0]u32 requires 'if let' or '??' (no optional type for u32), in sum(n = 0)
> ```
>
> A generic that is meant to work for 0 says so in its body, as hand-written code would (`for x in xs` over the `*[n]u32` itself needs no index).
>
> #### Generic types with value parameters
>
> A generic type ([8.5](#85-generic-types)) takes value parameters as a generic function does, and is applied to numbers as to types: `Ring(8, u32)`.
>
> ```ents
> func Ring(comptime n: u32, comptime T: type) -> type => (head: u32#n, count: u32, items: *mut [n]T)
>
> // Adds x after the newest element; when the ring is full, x takes the oldest one's place.
> func push(comptime n: u32, comptime T: type, r: *mut Ring(n, T), x: T) {
>   r.items[(r.head + r.count) % n] = x
>   if r.count < n {
>     r.count += 1
>   } else {
>     r.head = (r.head + 1) % n
>   }
> }
>
> // The i-th oldest element.
> func oldest(comptime n: u32, comptime T: type, r: *Ring(n, T), i: u32#n) -> T => r.items[(r.head + i) % n]
>
> data cells = mut [0:u32; 8]
> data log: Ring(8, u32) = mut (0, 0, cells)
>
> export func record(x: u32) { log.push(x) }
> export func first() -> u32 => log.oldest(0)
>
> test "the ring keeps the last eight" {
>   for i in 10 {
>     record(i)
>   }
>   assert log.count == 8
>   assert first() == 2
> }
> ```
>
> `Ring(8, u32)` is the struct `(head: u32#8, count: u32, items: *mut [8]u32)`, as any generic type is its body. Its value arguments are computed before it is applied, so `Ring(8, u32)`, `Ring(4 + 4, u32)` and the struct written out are one type; `Ring(16, u32)` is another because its body is (`cannot assign *mut Ring(16, u32) to *mut Ring(8, u32)`). As for type parameters, a value the body does not use makes no difference: with `func Tagged(comptime n: u32) -> type => (id: u32)`, `Tagged(4)` and `Tagged(5)` are one type. `log.push(x)` finds `n` and `T` from `log` by the body of `Ring`, through `items: *mut [n]T`; `head: u32#n` decides nothing. It builds a value like any generic type, `Ring(8, u32)(0, 0, cells)`, and a method call writes its comptime arguments after the receiver, `log.push(8, u32, x)`, which is `push(8, u32, log, x)`.
>
> A generic type may also hold its array in place:
>
> ```ents
> func Buf(comptime n: u32, comptime T: type) -> type => (len: u32#(n + 1), items: [n]T)
>
> func third(b: Buf(3, u8)) -> u8 => b.items[2]
> data held: Buf(3, u8) = (3, [1, 2, 3])
>
> export func size() -> u32 => sizeof(Buf(3, u8))            // 4 + 3
> export func t() -> u8 => third(Buf(3, u8)(0, [7, 8, 9]))
> export func h() -> u8 => held.items[1]
>
> test "an array held in place" {
>   assert size() == 7
>   assert t() == 9
>   assert h() == 2
> }
> ```
>
> `Buf(3, u8)` is four values in registers and seven bytes in memory, its elements inside it. An array held in place, in registers or as a field in memory, is indexed by constants only ([2.4](#24-fixed-arrays-value-type)): `b.items[2]` is one read, and `b.items[i]` is an error. A container that is indexed at run time holds a pointer to its elements, as `Ring` does. The length is a `u32#(n + 1)` because it reaches `n` when the buffer is full; `u32#n` would say it stays below.
>
> #### Instances
>
> - **Identity.** Value arguments are equal when they are the same number in the parameter's type: `sum(primes)`, `sum(4, primes)` and `sum(2 + 2, primes)` share `sum<4>`.
> - **Names.** In WAT a value argument is written in decimal among the others, in the order of the comptime parameters: `$sum<4>`, `$push<8|u32>`, `$shift<-3>`. Instances take the generic's place in the order of their names as text, so `$rotl<13>` comes before `$rotl<7>`. In messages an instance reads `push(n = 8, T = u32)`.
> - **Zero cost.** An instance is the generic with each value parameter replaced by its number, and it compiles to the bytes of that function written by hand. Nothing of `n` exists at run time beyond the constants the hand-written function would have, and none is folded that the hand-written one would not fold: `32 - k` in `rotl<7>` is `(i32.sub (i32.const 32) (i32.const 7))` as `32 - 7` is.
> - **Statics.** A literal in the body belongs to each instance, as for type parameters: `func scratch(comptime n: u32) -> *mut [n]u8 => mut [0:u8; n]` is one buffer of `n` bytes for each `n`, laid out once. Every call with the same `n` gets the same buffer.
> - **One copy per number.** Each value is a function of its own, as each type is: `sum` over arrays of five lengths is five functions. A long body that needs the length only for a few proofs can take a slice in a plain function and keep the generic a short wrapper.
> - **Recursion.** A generic may call itself with the same arguments; that is run-time recursion in one instance. It cannot recurse on a value that changes. There is no compile-time `if`, so both branches of an `if` are in every instance, and each instance asks for the next:
>
> ```ents
> func pow(comptime e: u32, x: u64) -> u64 => if e == 0 { 1 } else { x * pow(e - 1, x) }
>
> export func cube(x: u64) -> u64 => pow(3, x)
> ```
>
> ```errors
> argument 1: cannot assign int(-1) to u32, in pow(e = 0)
> ```
>
> `pow<3>` asks for `pow<2>`, and so on to `pow<0>`, whose `else` asks for `pow(0 - 1, x)`. A value that grows instead is stopped by its type or by the limits of [8.4](#84-instances) (64 nested instantiations, 1000 from one call). A loop does what such a recursion would: `for i in e { r *= x }`.
>
> #### With the rest of the language
>
> - **Functions that share a name.** A generic with value parameters is still a generic: its name is unique in its module. In an instance `n` is a literal, so a call `gt(x, n)` in the body picks among overloads as `gt(x, 8)` does: the typed `x` decides and the literal only has to fit ([3.4](#functions-that-share-a-name)).
> - **Tables.** A pointer or slice whose element is a fixed array is a table ([Nesting](#nesting)) whatever its lengths are: a `t: *[n][m]T` is `n` row pointers, `t.len` is `n` and `t[i].len` is `m`. Lengths are matched by shape, never by layout: `*[n][m]T` against a `*[2][3]i32` gives `n = 2`, `m = 3`. The same holds for a type parameter that turns out to be a fixed array ([8.5](#85-generic-types)): `*[n]T` against a `*[2][3]i32` gives `n = 2` and `T = [3]i32`, and the instance has a table, whose `xs[i]` is a row pointer, not a `T`.
> - **Modules.** A source import restates a value parameter as it is declared: `"push" func push(comptime n: u32, comptime T: type, r: *mut Ring(n, T), x: T)`. An instance belongs to the generic's module ([8.8](#88-generics-across-modules)), and a value argument is computed in the module that wrote it, with that module's `def`s.
> - **`def`.** A `def` is a number with a name, so it can now size a type outside generics too: with `def size = 64`, `*mut [size]u8` and `u32#size` are types.
> - **In the editor.** A value parameter shows its number in each instance: `n: u32 — in sum(n = 4): 4; in sum(n = 8): 8`.
>
> A table with value-parameter lengths is read as a table written by hand: here `m[i]` loads the row pointer and `m[i][i]` the cell, both proven by `i: u32#n`.
>
> ```ents
> func trace(comptime n: u32, m: *[n][n]i32) -> (t: i32) {
>   for i in n {
>     t += m[i][i]
>   }
> }
>
> data grid: *[3][3]i32 = [[1, 2, 3], [4, 5, 6], [7, 8, 9]]
>
> export func a() -> i32 => trace(grid)            // n = 3; the second [n] is then checked: a *[3][4]i32 is refused
>
> test "trace" {
>   assert a() == 15
> }
> ```

---

## 4. The WAT of the chapter's examples

Each block is the base compiler's output for the example's twin (`probes/doc/NN.twin.ents`), with the twin's names
replaced by the instance names (`probes/doc/names.txt`) **[ran]**. Names do not reach the `.wasm`, so this is the
instance's code byte for byte; the twins' `.wasm` sizes are given for the byte comparisons the implementation must
pass (section 10). Scratch locals such as `$__sl_p_256` are named after source offsets, which in an instance are the
generic's, so their numbers in the instance's WAT differ; nothing else does.

**`sum`** (`01`, 231 bytes). Both instances take the generic's place, in name order; `c` calls the instance `a` calls.
The loop's read has no check: the counter is a `u32#4` (or `u32#8`) and `xs` a `*[4]u32` (or `*[8]u32`).

```wat
(module
  (memory 1)
  (func $sum<4> (param $xs i32) (result i32)
    (local $i i32)
    (local $total i32)
    (local.set $i (i32.const 0))
    (block $break
    (loop $next
    (br_if $break (i32.ge_u (local.get $i) (i32.const 4)))
    (block $continue
    (local.set $total (i32.add (local.get $total) (i32.load (i32.add (local.get $xs) (i32.mul (local.get $i) (i32.const 4))))))
  )
  (local.set $i (i32.add (local.get $i) (i32.const 1)))
  (br $next)
)
)
  (local.get $total)
)
  (func $sum<8> (param $xs i32) (result i32)
    (local $i i32)
    (local $total i32)
    (local.set $i (i32.const 0))
    (block $break
    (loop $next
    (br_if $break (i32.ge_u (local.get $i) (i32.const 8)))
    (block $continue
    (local.set $total (i32.add (local.get $total) (i32.load (i32.add (local.get $xs) (i32.mul (local.get $i) (i32.const 4))))))
  )
  (local.set $i (i32.add (local.get $i) (i32.const 1)))
  (br $next)
)
)
  (local.get $total)
)
  (func $a  (result i32)
    (call $sum<4> (i32.const 8))
  )
  (func $b  (result i32)
    (call $sum<8> (i32.const 24))
  )
  (func $c  (result i32)
    (call $sum<4> (i32.const 8))
  )
  (export "a" (func $a))
  (export "b" (func $b))
  (export "c" (func $c))
  (data (i32.const 8) "\02\00\00\00\03\00\00\00\05\00\00\00\07")  ;; primes: *[4]u32
  (data (i32.const 24) "\01\00\00\00\04\00\00\00\09\00\00\00\10\00\00\00\19\00\00\00$\00\00\001\00\00\00@")  ;; squares: *[8]u32
)
```

**`last`** (`02`, 87 bytes). A `[3]f64` is three registers, so `last<3|f64>` has three parameters and the call passes
three values. **[ran]** for the twin written `v[2]`. The instance has `v[3 - 1]`, a constant expression, which the
checker accepts today and codegen does not compile (`Cannot index this expression`, **[ran: t22]**, with `v[1 + 1]`
written by hand). That fault is P1 of section 9, fixed before this feature; after it, `v[3 - 1]` must give this WAT.

```wat
  (func $last<3|f64> (param $v_0 f64) (param $v_1 f64) (param $v_2 f64) (result f64)
    (local.get $v_2)
  )
  (func $a (param $x f64) (result f64)
    (local $v_0 f64)
    (local $v_1 f64)
    (local $v_2 f64)
    (local.set $v_0 (local.get $x))
    (local.set $v_1 (f64.const 2))
    (local.set $v_2 (f64.mul (local.get $x) (f64.const 3)))
    (call $last<3|f64> (local.get $v_0) (local.get $v_1) (local.get $v_2)) (return)
    (unreachable)
  )
```

**`rotl`** (`04`, 86 bytes). The instances are in the order of their names as text: `rotl<13>` before `rotl<7>`. The
constant `32 - k` is left as the subtraction `32 - 7` written by hand is: an instance folds nothing the twin would
not (wasm-opt folds both).

```wat
  (func $rotl<13> (param $x i32) (result i32)
    (i32.or (i32.shl (local.get $x) (i32.const 13)) (i32.shr_u (local.get $x) (i32.sub (i32.const 32) (i32.const 13))))
  )
  (func $rotl<7> (param $x i32) (result i32)
    (i32.or (i32.shl (local.get $x) (i32.const 7)) (i32.shr_u (local.get $x) (i32.sub (i32.const 32) (i32.const 7))))
  )
  (func $mix (param $a i32) (param $b i32) (result i32)
    (i32.xor (call $rotl<7> (local.get $a)) (call $rotl<13> (local.get $b)))
  )
```

**`join`** (`05`, 182 bytes). `out` is a `*mut [5]u8` in `join<3|2>`; `out[a + j]` is `out[3 + j]` with `j: u32#2`,
a `u32#5`, so both stores are unchecked.

```wat
  (func $join<3|2> (param $x i32) (param $y i32) (param $out i32)
    (local $i i32)
    (local $j i32)
    (local.set $i (i32.const 0))
    (block $break
    (loop $next
    (br_if $break (i32.ge_u (local.get $i) (i32.const 3)))
    (block $continue
    (i32.store8 (i32.add (local.get $out) (local.get $i)) (i32.load8_u (i32.add (local.get $x) (local.get $i))))
  )
  (local.set $i (i32.add (local.get $i) (i32.const 1)))
  (br $next)
)
)
  (local.set $j (i32.const 0))
  (block $break
  (loop $next
  (br_if $break (i32.ge_u (local.get $j) (i32.const 2)))
  (block $continue
  (i32.store8 (i32.add (local.get $out) (i32.add (i32.const 3) (local.get $j))) (i32.load8_u (i32.add (local.get $y) (local.get $j))))
)
  (local.set $j (i32.add (local.get $j) (i32.const 1)))
  (br $next)
)
)
)
  (func $hello  (result i32)
    (call $join<3|2> (i32.const 13) (i32.const 16) (i32.const 8))
    (i32.load8_u (i32.add (i32.const 8) (i32.const 4))) (return)
    (unreachable)
  )
```

**`get`** (`03`, 108 bytes). One load; the proof is the caller's `& 7` or `% 8`.

```wat
  (func $get<8|u16> (param $xs i32) (param $i i32) (result i32)
    (i32.load16_u (i32.add (local.get $xs) (i32.mul (local.get $i) (i32.const 2))))
  )
  (func $a (param $k i32) (result i32)
    (call $get<8|u16> (i32.const 8) (i32.and (local.get $k) (i32.const 7)))
  )
  (func $b (param $k i32) (result i32)
    (call $get<8|u16> (i32.const 8) (i32.rem_u (local.get $k) (i32.const 8)))
  )
```

**`Ring`** (`06`, 217 bytes). `Ring(8, u32)` emits nothing; the data `log` is the struct laid out, its `items` the
address of `cells`. `% n` is `i32.rem_u` by the constant 8, and each store and load through `items` is unchecked
because `% 8` is a `u32#8`. The method calls are the plain calls.

```wat
  (func $push<8|u32> (param $r i32) (param $x i32)
    (i32.store (i32.add (i32.load (i32.add (local.get $r) (i32.const 8))) (i32.mul (i32.rem_u (i32.add (i32.load (local.get $r)) (i32.load (i32.add (local.get $r) (i32.const 4)))) (i32.const 8)) (i32.const 4))) (local.get $x))
    (if  (i32.lt_u (i32.load (i32.add (local.get $r) (i32.const 4))) (i32.const 8)) (then (i32.store (i32.add (local.get $r) (i32.const 4)) (i32.add (i32.load (i32.add (local.get $r) (i32.const 4))) (i32.const 1)))) (else (i32.store (local.get $r) (i32.rem_u (i32.add (i32.load (local.get $r)) (i32.const 1)) (i32.const 8)))))
  )
  (func $oldest<8|u32> (param $r i32) (param $i i32) (result i32)
    (i32.load (i32.add (i32.load (i32.add (local.get $r) (i32.const 8))) (i32.mul (i32.rem_u (i32.add (i32.load (local.get $r)) (local.get $i)) (i32.const 8)) (i32.const 4))))
  )
  (func $record (param $x i32)
    (call $push<8|u32> (i32.const 40) (local.get $x))
  )
  (func $first  (result i32)
    (call $oldest<8|u32> (i32.const 40) (i32.const 0))
  )
  (export "record" (func $record))
  (export "first" (func $first))
  ;; 32 zero bytes at 0x8 — cells: *mut [8]u32
  (data (i32.const 40) "\00\00\00\00\00\00\00\00\08")  ;; log: *mut (head: u32#8, count: u32, items: *mut [8]u32)
```

**`Buf`** (`11`, 105 bytes). No instance: `Buf(3, u8)` is a type, and a `Buf(3, u8)` value is four registers.

```wat
  (func $third (param $b_len i32) (param $b_items_0 i32) (param $b_items_1 i32) (param $b_items_2 i32) (result i32)
    (local.get $b_items_2)
  )
  (func $size  (result i32)
    (i32.const 7)
  )
  (func $t  (result i32)
    (call $third (i32.const 0) (i32.const 7) (i32.const 8) (i32.const 9))
  )
```

**`trace`** (`10`, 167 bytes). Two loads per cell, the row pointer and the cell, neither checked.

```wat
  (func $trace<3> (param $m i32) (result i32)
    (local $i i32)
    (local $t i32)
    (local.set $i (i32.const 0))
    (block $break
    (loop $next
    (br_if $break (i32.ge_u (local.get $i) (i32.const 3)))
    (block $continue
    (local.set $t (i32.add (local.get $t) (i32.load (i32.add (i32.load (i32.add (local.get $m) (i32.mul (local.get $i) (i32.const 4)))) (i32.mul (local.get $i) (i32.const 4))))))
  )
  (local.set $i (i32.add (local.get $i) (i32.const 1)))
  (br $next)
)
)
  (local.get $t)
)
```

**`scratch`** (`09`, 67 bytes). One buffer per instance, laid out once; a call is its address.

```wat
  (func $scratch<16>  (result i32)
    (i32.const 8)
  )
  (func $scratch<64>  (result i32)
    (i32.const 24)
  )
  ...
  ;; 16 zero bytes at 0x8 — 16 zero bytes
  ;; 64 zero bytes at 0x18 — 64 zero bytes
```

---

## 5. Errors, with their exact messages

Each mistake is one error, worded as the stages' errors are. An error in an instance is reported at its line in the
generic, labelled `, in f(n = 8)` and with the `required from` notes of stage 2. Where a message is the ordinary one of
hand-written code, the instance adds nothing else. "New" marks a message this design adds; the others exist today
**[ran]** and are reused as they are.

### 5.1 At a declaration

| Mistake | Example | Message |
|---|---|---|
| An upper-case value parameter | `func f(comptime N: u32, p: *[N]u8)` | new: `a value parameter's name starts with a lower-case letter: write 'comptime n: u32'` |
| A comptime parameter of another type | `func f(comptime r: f64)`, `comptime ok: bool`, `comptime s: []u8`, `comptime n: T` with `T` a type parameter | new, replacing `comptime value parameters are not supported yet: 'r' must be 'type' or a function type`: `comptime parameter 'r' is f64: a comptime parameter is a type (comptime T: type), an integer (comptime n: u32) or a function (comptime f: (T) -> T)` |
| Named like a module `def` | `def n = 4` and `func f(comptime n: u32)` | new: `comptime parameter 'n' has the name of a def declared in this module` |
| Named twice | `func f(comptime n: u32, n: u32)` | `parameter 'n' is declared twice` |
| A run-time parameter as a length | `func f(len: u32, p: *[len]u8)` | new: `array length must be a compile-time constant: 'len' is a parameter; to give it at compile time, write comptime len: u32` |
| An unknown name as a length | `func f(comptime n: u32, p: *[m]u8)` | `unknown identifier 'm'`, as in any expression |
| A generic type with a parameter that is neither | `func Box(comptime x: f64) -> type => ...` | new, replacing `generic type 'Box' takes comptime type parameters only, as (comptime T: type)`: `generic type 'Box' takes comptime type and integer parameters only, as (comptime n: u32, comptime T: type)` |
| A packed block whose dimensions are not numbers | `*[n x m]u8` | syntax error at the `x`, as today for any non-number there |

### 5.2 At a call

| Mistake | Example | Message |
|---|---|---|
| A run-time value, a global, a call, a `data` block, or a type for a value parameter | `sum(x, p)` with `x: u32` | new: `argument 1 of 'sum' must be a compile-time constant: n is a comptime value parameter` |
| A value for a type parameter | `get(8, 8, p, i)` | `argument 2 of 'get' must be a type: T is a type parameter` |
| A value its type does not hold | `comptime n: u8` given 300; `comptime n: u32` given -1, 1.5, 4294967296 or `true`; a typed `sizeof(T)` for a `u8` | `argument 1: cannot assign int(300) to u8`, `argument 1: cannot assign int(-1) to u32`, `argument 1: cannot assign float(1.5) to u32`, `argument 1: cannot assign int(4294967296) to u32`, `argument 1: cannot assign bool to u32`, `argument 1: cannot assign u32 to u8` (the messages of any argument) |
| Another count of arguments | `sum(4, 4, p)` | new wording where value parameters are counted: `'sum' expects 1 argument, or 2 with its value argument written; got 3`; with both kinds, `'push' expects 2 arguments, or 4 with its comptime arguments written; got 3`. With type parameters only, the message is today's |
| Named arguments | `sum(n: 4, xs: p)` | `'sum' takes positional arguments` |
| Nothing decides `n` | `pow(x)` with `func pow(comptime e: u32, x: u64) -> u64` | new: `cannot infer e for 'pow': write the value argument, as in pow(8, ...)`; with type parameters to write too, `write the comptime arguments, as in fill(8, u32, ...)` (a value is shown as 8 and a type as u32, as today's message shows u32) |
| A slice where `*[n]T` is wanted | `sum(xs)` with `xs: []u32` | new: `cannot infer n for 'sum': a []u32 has no length in its type; write the value argument, as in sum(8, ...)` |
| `n` only in arithmetic | `set_bit(seen, k % 100)` (07) | new: `cannot infer n for 'set_bit': [(n + 31) / 32] does not decide n, only a length that is n alone does; write the value argument, as in set_bit(8, ...)` |
| A generic type that has no length that is `n` alone | `f(t)` with `func f(comptime n: u32, t: Tagged(n))`, `func Tagged(comptime n: u32) -> type => (id: u32#n)` and `t: Tagged(4)` | new, as today's for `T`: `cannot infer n for 'f': 'Tagged(n)' has no length that is n alone; write the value argument` |
| Only an array literal could decide | `sum([1, 2, 3])` | new: `cannot infer n for 'sum' from an array literal: write sum(3, ...)` (the literal's count) |
| A value array where `*[n]T` is wanted | `sum(v)` with `v: [4]u32` | `cannot infer n for 'sum': write the value argument, as in sum(8, ...)`, today's wording for `T` **[ran: c34]**; written out, `sum(4, v)` is `argument 2: cannot assign [4]u32 to *[4]u32` **[ran: c08]** |
| A later argument of another length | `join("hel", "lo", big)` with `big: *mut [8]u8` | `argument 3: cannot assign *mut [8]u8 to *mut [5]u8` |
| An index not proven | `get(widths, k)` | `argument 2: cannot assign u32 to u32#8` |
| A value array of another length | `pair(a, b)` with `func pair(comptime n: u32, a: [n]f64, b: [n]f64)`, `a: [3]f64` and `b: [4]f64` | `argument 2: cannot assign [4]f64 to [3]f64` |

### 5.3 In an instance

| Mistake | Example | Message |
|---|---|---|
| A bound of 0 | `get("", 0)`: `n = 0` makes `i: u32#0` | new: `range bound must be at least 1: u32#0 has no values, in get(n = 0, T = u8)` |
| A bound past the type | `u8#n` with `n = 300` | new: `range bound 300 is too large for u8, which has 256 values, in f(n = 300)` |
| A negative length | `*[k]u8` with `comptime k: i32` and `k = -1` | new: `array length cannot be negative: it is -1, in f(k = -1)` |
| A length past a `u32` | `*[n]u8` with `comptime n: u64` and `n = 4294967296` | new: `array length 4294967296 is too large: an array has at most 4294967295 elements, in f(n = 4294967296)` |
| Assigned in the body | `n = 3`, `n += 1`, `set (n, x) = ...` | new: `cannot assign to 'n': it is a comptime value parameter, in f(n = 8)`, once in each instance (D14) |
| Its name bound again in the body | `let n = 5`; `match x { n => 1 }` | `'n' is already declared in this scope, in f(n = 8)` (today's message for a parameter **[ran: c23]**); `'n' is already declared: a match binding cannot reuse the name of a comptime value parameter, in f(n = 8)` (today's wording for a `def` or a parameter **[ran: c23, c24]**, naming what `n` is) |
| `n = 0` where the body needs an index proven | `sum(none)` with `none: *[0]u32` | `runtime index on *[0]u32 requires 'if let' or '??' (no optional type for u32), in sum(n = 0)`, the error of the twin **[ran: c01]**; for `FixedVec(0, u64)`'s `push`, `index type u32#1 may exceed *[0]u64 bounds (max index 0 >= 0) — narrow the index range to fit` and `cannot assign u32#2 to u32#1` **[ran: c02]** |
| An array too large for memory | `[n]u64` with `n = 536870912` | new: `array [536870912]u64 is too large: 4294967296 bytes, more than the 4294967295 a 32-bit memory addresses, in f(n = 536870912)` |
| A run-time index into a value array | `for i in n { s += v[i] }` with `v: [n]u32` | `dynamic index on value type [4]u32 — use a pointer or slice for dynamic access, in total(n = 4)` |
| A division by `n = 0` | `x % n` | none: it is `x % 0`, which traps at run time as it does written by hand **[ran: t14]**. See open question Q4 |
| Recursion on a value that shrinks | `pow` of the chapter's Instances | `argument 1: cannot assign int(-1) to u32, in pow(e = 0)` (the message of any argument **[ran: c29]**; the label is the value's) |
| Runaway instantiation | `func count(comptime n: u32, x: u32) -> u32 => if x == 0 { n } else { count(n + 1, x - 1) }` | `too many nested instantiations (64) while instantiating 'count', in count(n = 63)`, once (the wording is today's for types **[ran: t25]**; the label is the value's); the limits of 8.4 (64 nested, 1000 from one call) as for types. A value that doubles at each level is stopped by its type first: `argument 1: cannot assign int(4294967296) to u32, in deep(n = 2147483648)` |
| A literal that does not fit where `n` is put | `let b: u8 = n` with `n = 300` | `cannot assign int(300) to u8, in f(n = 300)` |

### 5.4 In any type, also written by hand

| Mistake | Example | Message |
|---|---|---|
| A length that is not a constant | `let p: *[x]u8 = q` with a local `x` | new: `array length must be a compile-time constant` |
| A bound that is not a constant | `u32#x` | new: `range bound must be a compile-time constant` |
| A length or bound that is not an integer | `[2.5]u8`, `u32#(1.5)` | new: `array length must be an integer: it is float(2.5)`, `range bound must be an integer: it is float(1.5)` |
| `u32#0`, `u8#300`, `*[4294967296]u8`, `*[1000000000]u64` | written by hand | the messages of 5.3 without the label. Today all four are accepted **[ran: t11, t12, t13, c05]**; `sizeof([536870912]u64)` gives `(i32.const 4294967296)`, which no assembler takes **[ran: c13]** |
| A hyphen where a subtraction was meant | `[n-1]u8`, `v[n-1]`, `x & (n-1)` with `n` a name in scope | new: `unknown identifier 'n-1': a hyphen joins a name; for subtraction write n - 1`. Today `unknown identifier 'n-1' — did you mean 'n'?` and, where the context wants a `u32`, a second error, `cannot assign i32 to u32` **[ran: c11]**, which stays (D16 changes the hint only) |

---

## 6. What the container library gains

The library of stage 5 (`lib/vec`, `set`, `map`, `stack`, `sort`) holds its elements behind many-pointers, `[*]mut T`,
whose capacity is a run-time number the code keeps in a field. A many-pointer has no length, so nothing checks an
index into it: the library is correct because its code is, and the compiler takes its word. A value parameter puts the
capacity in the type, so the same code is checked by the compiler and costs nothing more: every index below is proven
and compiles to a plain load or store.

**`lib/fixedvec.ents`: `FixedVec(n, T)`, a vector that never grows.** For a known maximum (the moves of a position,
the neighbours of a cell), with one allocation and no copying. `push` is the example `08`: the `return false when i
>= n` narrows `i` to a `u32#n`, so the store needs no check, and `len` is a `u32#(n + 1)`, so `items` is a slice of
proven bounds. `fixedvec(n, T)` allocates the header and `n` elements on the stack of `lib/stack.ents`, in one
allocation (`alloc(sizeof(FixedVec(n, T)) + n * sizeof(T))`); `pop`, `last` and `clear` are as in `lib/vec.ents`.
The field holding the elements is `buf`, not `items`: a member wins over a function of its name (4.9, rule 1), so with
a field `items`, `v.items()` is the field called, `cannot call non-function type: *mut [4]u64 ('items' is a field
here, and a field wins over the function 'items': write items(...))` **[ran: c03]**.

```ents
export func FixedVec(comptime n: u32, comptime T: type) -> type => (len: u32#(n + 1), buf: *mut [n]T)

export func push(comptime n: u32, comptime T: type, v: *mut FixedVec(n, T), x: T) -> bool {
  let i = v.len
  return false when i >= n
  v.buf[i] = x             // i is a u32#n here: the store needs no check
  v.len = i + 1            // a u32#(n + 1), which len is
  return true
}

export func items(comptime n: u32, comptime T: type, v: *FixedVec(n, T)) -> []T => v.buf[0..v.len]
```

```wat
  (func $push<4|u64> (param $v i32) (param $x i64) (result i32)
    (local $i i32)
    (local.set $i (i32.load (local.get $v)))
    (if (i32.ge_u (local.get $i) (i32.const 4)) (then (i32.const 0) (return)))
    (i64.store (i32.add (i32.load (i32.add (local.get $v) (i32.const 4))) (i32.mul (local.get $i) (i32.const 8))) (local.get $x))
    (i32.store (local.get $v) (i32.add (local.get $i) (i32.const 1)))
    (i32.const 1) (return)
    (unreachable)
  )
  (func $items<4|u64> (param $v i32) (result i32 i32)
    (local $__sl_p_252 i32)
    (local $__sl_b_252 i32)
    (block (result i32 i32)
    (local.set $__sl_p_252 (i32.load (i32.add (local.get $v) (i32.const 4))))
    (local.set $__sl_b_252 (i32.load (local.get $v)))
    (local.get $__sl_p_252) (local.get $__sl_b_252))
  )
```

(`08`, 193 bytes, **[ran]** on the twin. With a plain `len: u32`, `v.buf[0..v.len]` is an optional slice,
`cannot assign ?[]mut u64 to []u64` **[ran: t27]**; with `u32#(n + 1)` it is proven **[ran: t28]**. At `n = 0` the
store is unproven and `push` is refused, as its twin is **[ran: c02]**; a `FixedVec(0, T)` has no use.)

With `T` a fixed array, `FixedVec(n, [3]i32)` holds a table (`buf: *mut [n][3]i32`, row pointers, 8.5), so `push` of
a `[3]i32` is refused in the instance with the table-rule note, as `Vec([3]i32)`'s is; `FixedVec((cells: [3]i32))`
lies in place. Nothing is silently wrong, but `fixedvec`'s `n * sizeof(T)` bytes are not a table's, so the library
documents the struct form.

**`lib/ring.ents`: `Ring(n, T)`, the last `n` of a stream.** The example `06`, with `ring(n, T)` to allocate it and
`newest`; the number held is the field `count` (a function `count` would be hidden by it, as above). `% n` is a
remainder by a constant (engines strength-reduce it; for a power of two it is one `and` after wasm-opt), and every
index is proven by it. `examples/data/ringbuf/ringbuf.ents` is not this: it is a queue, whose `push` refuses a byte when
full and whose `pop` takes the oldest. A `Queue(n, T)` of the same shape (`head: u32#n`, `count`, `buf: *mut [n]T`)
would hold it, with the same proofs; it is not in the three files below.

**`lib/bits.ents`: a bitset of `w` words.** `set_bit`, `clear_bit` and `has_bit` over a `*mut [w]u32`, with an index
`u32#(w * 32)`. (`set` is a keyword, the start of `set (a, b) = ...`: `func set(...)` does not parse **[ran: c33]**.)
The words decide `w`, so calls are inferred: with `seen: *mut [4]u32`, `seen.set_bit(k & 127)` is `set_bit<4>`.
Written by its bit count instead, `*mut [(n + 31) / 32]u32` as in example `07`, the bitset's `n` cannot be found from
the words (100 bits and 97 bits are both 4 words), so every call has to write it. The library takes the word count;
`i >> 5` is then proven below `w` by the range of `i`.

```ents
export func set_bit(comptime w: u32, b: *mut [w]u32, i: u32#(w * 32)) { b[i >> 5] |= 1 << (i & 31) }
export func has_bit(comptime w: u32, b: *[w]u32, i: u32#(w * 32)) -> bool => ((b[i >> 5] >> (i & 31)) & 1) == 1
```

The body of `set_bit<4>` is the body of `set_bit<100>` in `probes/doc/07.wat`, since nothing in it depends on the
number: one shift, one load, one `or`, one store, no check **[ran: 07 for `u32#100`; t29 is the pair on a `*[4]u32`
with `i: u32#128`]**.

**`FixedSet(n, K)` and `FixedMap(n, K, V)`: open addressing with the mask in the type.** `lib/set.ents` keeps `slots:
[*]mut Slot(K)` and `mask: u32` and trusts `h & s.mask` to stay inside. With `slots: *mut [n]Slot(K)`, `h & (n - 1)`
is a `u32#n`, proven for every `n` from 1 (and spread evenly when `n` is a power of two), and the probe `(i + 1) & (n -
1)` stays a `u32#n`. The mask is a constant in the instruction. A fixed set cannot grow; `add` returns false when it is
half full, as the growing one doubles then. This is the shape for kernels with a known bound (the board-builder's
visited cells).

**Buffers laid out once per size.** `func scratch(comptime n: u32) -> *mut [n]u8 => mut [0:u8; n]` (example `09`) is a
static buffer of each size the program asks for, with no allocator and no compile-time cost for its zeros (#29, L10).
Because a static is one per instance, two callers that ask for the same size share it: it is a scratch area, not an
allocator. A pool of a struct type is the same with a cast: `let bytes: *mut [n * sizeof(T)]u8 = mut [0:u8; n *
sizeof(T)]` then `bytes as *mut [n]T` **[ran: t23, written for `[4]Pt`]**. The cast is for a `T` that is not a fixed
array: with `T = [3]i32`, `*mut [n]T` is a table and the cast would read the zero bytes as row pointers. A cast is
never checked, so the library writes this once, inside a function whose `T` it documents, and not as a recipe.

**Names across the library.** A generic's name is unique in its module (8.1, rule 3), and so is an imported one. A
program that imports `push` from `lib/vec` and from `lib/fixedvec` names one of them otherwise in its import
(`"push" func fixed_push(...)`), and calls it so, also as a method. The alternative is generics that share a name,
chosen by the receiver's type, which 8.9 leaves out; open question Q6 asks which the library should assume.

**What the library cannot do yet, and why** (section 7 has the list):

- Hold its elements in place, `(len: u32#(n + 1), buf: [n]T)`, one struct with the array inside. An array field in
  memory is indexed by constants only today (`dynamic index on value type [8]u32` **[ran: t7]**), and `&v.buf` is
  not in the language (stage 5's open question 5). So `buf` is a pointer, which costs a load per access; the
  allocation can still be one block.
- Loop over a `[n]T` held in registers (limbs of a bignum): that needs the loop unrolled at compile time.
- Require `n` to be a power of two, or above 0, at the declaration: there is no compile-time assertion. A body that
  needs `n > 0` says so through its types (`u32#n` refuses 0), or is refused at 0 where it indexes (D8).
- Recurse on `n` (a tree of sizes, a power by squaring): without a compile-time `if` every instance asks for the next
  (section 3, Instances).

---

## 7. Deliberately left out

Each is either an error that says so or a form the grammar does not have, so the spelling stays free.

| Not in this design | What the user sees | Why not now |
|---|---|---|
| A `bool` or float value parameter | `comptime parameter 'ok' is bool: a comptime parameter is a type (comptime T: type), an integer (comptime n: u32) or a function (comptime f: (T) -> T)` | Without a compile-time `if` a `bool` picks nothing (D2) |
| A value parameter whose argument is a string or a `data` block | `argument 1 of 'f' must be a compile-time constant: s is a comptime value parameter` (and the parameter's type is refused first) | An address is fixed only when data is laid out, after checking; a string parameter is a different feature |
| Compile-time `if`, `for` and `assert` (`comptime if n & (n - 1) == 0`, unrolling a loop over a `[n]T`) | not parsed | The next step of 8.10's table. The substitution is the place it plugs into (plan 3.10): the instance key, names and lowering stay |
| Recursion on a value parameter that changes (`pow(e - 1, x)`) | the runaway errors of 5.3: the chain ends in a value its type refuses, or at 64 nested instantiations | Needs a compile-time `if` to end; until then a loop does the same work |
| A loop that never runs proving its body (`for i in 0`, `i >= 0` narrowing) | at `n = 0`, the errors of hand-written code for 0 (5.3) | A change to hand-written code as much as to generics: open question Q7 |
| `comptime func`: functions run at compile time, tables computed at compile time | not parsed | Same |
| Deciding `n` from `[n * 2]`, from a range, from an array literal's count | the `cannot infer n` errors of 5.2 | D5; the literal case is open question Q1 |
| Writing some comptime arguments and inferring others | today's count error, with value parameters counted | 8.2's one rule; relaxing it is compatible later |
| Packed blocks with value dimensions, `*[n x m]T` | syntax error at the `x` | A packed dimension is a number today; `[(n)x(m)]` would need its own lexical rule. A table `*[n][m]T` or a `*[n * m]T` serves |
| An array field in memory indexed at run time; the address of a field | `dynamic index on value type [8]u32 — use a pointer or slice for dynamic access` | Not about value parameters; containers keep `buf: *mut [n]T` (section 6). It is the next thing a fixed container wants |
| Default values (`comptime n: u32 = 16`) | syntax error | No first user; a wrapper function serves |
| A host import with a value parameter | `a host import cannot have comptime parameters` | As for every comptime parameter |
| Two generics of one name told apart by a value (`f(comptime n: u32, ...)` and `f(...)`) | `'f' is already declared: a generic function's name is unique in its module` | As for every generic (stage 3) |
| A length that is not a constant (a run-time array, `[len]u8` with a variable) | `array length must be a compile-time constant` | A slice is the run-time-length type |

## 8. What changes for programs without value parameters

Pre-1.0, breaking changes are fine; each of these is listed for the release notes. None changes the output of any
source in the repository or in the board-builder port: none writes `[0x..]` in a type, `uK#0`, a bound past its type
or an array of 4 GiB (the longest is 16777216 bytes) **[ran: grep over examples, lib, packages, spec, docs and the 38
sources of `<board-builder port>/moonbit/encantis`]**, and the golden hashes pin the rest.

1. **Lengths and bounds can be constant expressions.** `[k]u8`, `[k * 2]u8`, `*[sizeof(Pt) * 4]u8`, `u32#k` and
   `u32#(k + 1)` are types, with `k` a `def`. Today all are syntax errors, so no program that parses changes meaning.
2. **`[0x10]u8` is 16 elements.** Today it is the packed block `0 x 10`, with `.len` 0 **[ran: t16]**. Hexadecimal,
   octal and binary lengths are numbers; `x` separates the dimensions of a packed block of decimal numbers only.
3. **Empty and oversized ranges, lengths and arrays are errors.** `u32#0`, `u8#300` (any bound above 2^width),
   `*[4294967296]u8` (any length above 4294967295) and `*[1000000000]u64` (any array of more than 4294967295 bytes)
   are refused where they are written. Today they are accepted **[ran: t11, t12, t13, c05]**: `u32#0` is a type with
   no values, `sizeof([536870912]u64)` emits `(i32.const 4294967296)`, which the assembler refuses **[ran: c13]**, and
   a checked index into the `*[1000000000]u64` computes an address that wraps past 4 GiB **[ran: c05]**.
4. **A constant expression indexes a value array** (P1). `v[1 + 1]` on a `[3]f64` throws in codegen today
   (`Cannot index this expression`) after the checker accepts it **[ran: t22]**, and so do `v[(2)]`, a constant index
   into an array field of a struct (`b.items[1 + 1]`, in registers or in memory), a store `w[1 + 1] = 7`, and `v[two]`
   with a `def two` declared after the function **[ran: c18, c19, c20, c21, c27]**. Each compiles as its literal
   index does: `v[1 + 1]` to `(local.get $v_2)`.
5. **Messages.** `comptime value parameters are not supported yet: 'n' must be 'type' or a function type` is gone;
   a parameter of another type reads as in 5.1. `generic type 'Vec' takes comptime type parameters only, as (comptime
   T: type)` becomes the wording of 5.1 for a parameter that is neither. The count and inference messages for
   generics with type parameters only are unchanged. `unknown identifier 'n-1' — did you mean 'n'?` becomes
   `unknown identifier 'n-1': a hyphen joins a name; for subtraction write n - 1` where the part before a hyphen is a
   name in scope and the rest a number (D16).

## 9. Implementation, by file and function

The mechanism is stage 1's and stage 2's: a value is one more kind of comptime argument, substituted by `cloneAst`.
No `ResolvedType` kind is added (types hold numbers, as they do now), and nothing in codegen learns about value
parameters: an instance reaches it as an ordinary function with numbers in it. The name is substituted as a literal,
not looked up as a scoped `def`, because only the literal compiles to the twin's bytes (D1, **[ran: c27, c28]**); the
instance also declares the name, so that the rules about names see it (D14).

### P1, before this feature: a constant expression as the index of a value array

`evalComptimeIndex` (codegen.ts:1769) reads only a literal (or an annotated one). Two places find an element of a
value array with it: `memberValues` (codegen.ts:1139-1160), for an array in registers, read or written, and
`memoryPlace` (codegen.ts:1300-1318), for an array field of a struct in memory. The checker accepts any constant (it
proves the index with `evalComptimeExpr`), so each of `v[1 + 1]`, `v[(2)]`, `b.items[1 + 1]` (in registers and in
memory), `w[1 + 1] = 7` and `v[two]` with a `def two` the checker resolves throws `Cannot index this expression` or
`Cannot assign to this expression` **[ran: t22, c18, c19, c20, c21, c27]**. Do what `repeatCount` (codegen.ts:1779)
already does for a repeat count: have the checker record the index's value in its `constants` table wherever it
proves a value-array index, and give `evalComptimeIndex` the context to read it, so that every caller is fixed at once.
Tests: each of those forms, and `v[n - 1]` in an instance, give the WAT of the literal index (`v[2]`, `b.items[2]`).
This is a fix of hand-written code and can be merged on its own.

### Grammar (`encantis-grammar.ohm`, then `bun run bundle:grammar`)

```
// BaseType (ohm:155-178): two alternatives after `array`, one before `rangedPrimitive`,
// and the arguments of an application may be values
BaseType = ...
         | "[" arrayFramings "]" mut Type                -- arrayMut          (as today)
         | "[" arrayFramings "]" Type                    -- array             (as today)
         | "[" Expr "]" mut Type                         -- lengthMut         // [n]mut T, [n * 2]mut T
         | "[" Expr "]" Type                             -- length            // [n]T, [k + 1]T, [0x10]T
         ...
         | rangedHead Expr ")"                           -- rangedComputed    // u32#(n + 1)
         | rangedUnsigned                                -- rangedPrimitive   // u32#16, u32#n
         | typeApplyHead NonemptyListOf<TypeArg, ","> ")" -- apply            // Ring(8, u32), Bits(n * 2)

TypeArg = Type &("," | ")")   -- type
        | Expr                -- value

// ohm:188: a number that starts with a radix prefix is not a dimension, so
// [0x10] fails here and is read as the expression 0x10
arrayFraming = "_" -- inferred | ~("0" ("x" | "o" | "b")) digit+ -- explicit | "!" -- nullTerminated | "?" -- leb128Prefixed

// ohm:196: lexical, as today, with a name as well as digits after the #
rangedUnsigned = unsignedName "#" (digit+ | ident)
rangedHead = unsignedName "#("
unsignedName = "u512" | "u256" | "u128" | "u64" | "u32" | "u16" | "u8"   // today's list, named
```

`[*]`, `[]`, `[_]`, `[!]`, `[?]` and `[2x3]` keep their meaning: each is tried before `length`, and none is an
expression. `Param_comptimeValue` (ohm:93) already parses `comptime n: u32`; add the near miss `comptime typeIdent
TypeAnnotation -- comptimeValueUpper` before it, for 5.1's message. `TypeLit`'s `typeOnlyStart` (ohm:479) needs no
change: `[n]u8` as an argument fails `TypeLit`, fails `Expr &(","|")")` and is read by `Arg_otherType`, and so is
`u32#(n + 1)`; `u32#n` is a `TypeLit`, since `rangedUnsigned` is in `typeOnlyStart`. A name after `#` is lexical and
may hold hyphens, so `u32#n-1` is the bound named `n-1`, and D16's hint applies to it. The grammar
check of the plan (every corpus source parses as before) is the acceptance test of this file (section 10).

### AST (`ast.ts`) and actions (`encantis-actions.ts`)

```ts
interface IndexedType { ...; size: number | number[] | 'inferred' | 'comptime' | 'expr' | null; length?: Expr }  // 'expr': [n]T, with length
interface PrimitiveType { ...; max?: number; bound?: Expr }      // u32#n, u32#(n + 1): bound; u32#16 keeps max
interface ValueArg { kind: 'ValueArg'; value: Expr; span: Span } // a value given to a generic type: the 8 of Ring(8, u32)
interface TypeApply { ...; args: (Type | ValueArg)[] }
interface LiteralExpr { ...; param?: string }                    // set on a value parameter's number in an instance, for messages and hover
```

Actions: `BaseType_length(Mut)` builds an `IndexedType` with `size: 'expr'`; `BaseType_rangedComputed` and a name
after `#` build a `PrimitiveType` with `bound`; `TypeArg_value` builds a `ValueArg`. The parser's `def` substitution
(actions:1549-1573) then reaches lengths for free, since they are expressions; a name after `#` is no `PrimaryExpr`,
so its action looks the name up in `currentDefs` as `PrimaryExpr` does, and builds the same literal or
`AnnotationExpr`. `typeText` (checker.ts:8510) writes the
new forms back as written. Exhaustive readers of `Type` (`astToResolved` in type-lib.ts, `resolveAstType` in
codegen.ts:3807, meta's hint walk) throw on `size: 'expr'` and on `bound`, as they do for `TypeApply`: by the time
codegen runs, every type it needs comes from the checker.

### Checker (`checker.ts`)

| Function (base lines) | Change |
|---|---|
| `ComptimeValue` (70-78) | `{ kind: 'int' }` is already a kind; a value argument is one. No new kind |
| `checkGenericDecl` (7102-7160) | A comptime parameter whose type resolves (by name alone, as `namesFuncType` does) to an integer primitive is a value parameter: refuse an upper-case name, a name of a `def` (`moduleScope.symbols` kind `def`, as 7137 does for a type parameter named like a type) or of another parameter or a named result. Any other type, a type parameter among them: 5.1's message. No walk of the body (D14). Collect the value parameters' names as `typeParams` are collected, so that `typeUses`'s check of generic types sees them as known |
| `isTypeParam` (8378), a new `isValueParam`, `genericParams` | `isValueParam(p)`: `comptime` and not `TypeType` and not a function type. Everywhere stage 1 asks "is it a type parameter" to decide the form of a call, ask "is it a type or value parameter" (`inferable`): `inferGenericCall` 7404-7417 (counting), `receiverSlot` 8387, `written` 4820 |
| `inferGenericCall` (7390-7520) | Explicit form: for a value parameter, `evalComptimeArg`. Inferred form: `inferTypeArgs` binds values too (below). `args` (7483): a value parameter's `ComptimeValue` is `{ kind: 'int', value }`. Counting messages as 5.2 |
| `evalComptimeArg` (7683-7728) | A third branch: `checkExpr(arg, paramType, place)` first, so that a value its type does not hold is the ordinary argument error; then `evalComptimeExpr(arg)`, and on null the 5.2 message `must be a compile-time constant`. The value kept is `constantIn(value, paramType)`, so `~0` for a `u8` is 255. The argument is evaluated in the calling module |
| `inferTypeArgs` (7525-7615) and `matchType` (8836-8915) | `matchType` gets a map of value parameters beside `typeParams`. In the `IndexedType` case: when the pattern has `size: 'expr'` and its `length` is an `IdentExpr` naming an unbound value parameter, and the actual is an array (or a pointer to one, or a slice-free table) with a single numeric size in that place, bind it. In the `PrimitiveType` case nothing binds (a range is dropped). `mentionsUnbound` (8795) treats a length or bound that names a value parameter as a mention, so the "first argument that can decide" walk and the inference errors see it. The new 5.2 messages are chosen where today's `cannot infer` messages are (7573-7612): a slice where the pattern has a length, a pattern whose only mentions are inside arithmetic, a literal |
| `instantiate` (7730-7830) | Key: a value is `String(value)`, joined with the others by `\|` (7739). Label: `n = 8` (7802). Nothing else: depth, chain size and key growth limits hold as they are |
| `bindTypes` (8917-8933) and `cloneAst` (9235-9256) | `subst` returns, for a value parameter's name, the `LiteralExpr` the parser makes for its decimal text (`{ kind: 'LiteralExpr', value: { kind: 'int', value, radix: 10 }, param: 'n' }`; the parser makes `-3` one literal **[ran: t30]**). `cloneAst` puts it in place of an `IdentExpr` that is read, of a length's or a bound's `IdentExpr` and of a field shorthand `(n:)` (whose value is then the literal), and never wraps it in a `TypeExpr`. It leaves the name where it is assigned to (the target of an `AssignmentStmt`, compound ones too, and the names of a `set` pattern), so that the checker finds the symbol below and reports D14's error |
| The check of an instance's body (`checkDeclaration` for `inst.decl`) | Declare each value parameter in the function's own scope, beside the parameters, as a `def` symbol with its value and a mark `valueParam`. Reads never reach it (they are literals); a binding of the name is then `'n' is already declared in this scope`, a match or loop binding the error that names what the name is, and an assignment `cannot assign to 'n'`. Where these messages say what the name is (`a def`, `not a variable`), the mark makes them say `a comptime value parameter` |
| `resolveTypeParts` (3555-3600) | `IndexedType` with `size: 'expr'`: `evalComptimeExpr(length)`, untyped (the length is not passed through `checkExpr` as a `u32`, whose `/`, `%` and `>>` would take wrapped operands, 2347-2373); not a constant, not an integer, negative or above 4294967295 are 5.4's errors and return `RECOVERY`; otherwise the size is the number. Then, for every array with numeric sizes (digits too), its size in bytes, `byteSize`, above 4294967295 is D9's error. A literal's count (`[0:u8; n]`, checked at 6781) gets the same two checks. `PrimitiveType` with `bound`: the same, then the bound checks of 5.4, which also apply to `max` from digits |
| `applyTypeFunc` (7281-7380), `collectTypeFunc` (7172, the check at 7206), `expandTypeApply` (7376) | A generic type takes value parameters (5.1's message for others). An argument for a value parameter is a `ValueArg`: evaluated with `evalComptimeArg`'s rule. Cache key and display: a value as its number, `Ring(8, u32)`. `expandTypeApply` substitutes the value argument's expression into the body, so that `Ring(n, T)` in a pattern exposes `*mut [n]T` |
| `typeOfArg` (8442-8480), and a new `typeApplied` method | `typeOfArg` stays as it is: it reads a type off the syntax alone, and a call whose arguments are not all types is not one. Changing it to keep values would make every constructor call a type application: `Cell(1, 2)` has an upper-case callee and value arguments, so `seen.add(Cell((i % 5) as i32, (i % 3) as i32))` of 8.8 would pass a type where `add` wants a `Cell`. Instead a checker method `typeApplied(expr)` reads a call as a type application only when its callee is a generic type in scope (a `typefunc` symbol, declared or imported), taking each argument as a type or as a `ValueArg` by that generic type's parameter kinds. The places that ask whether a call argument or a callee is a type (the classification of arguments at 7394, `evalComptimeArg` at 7709, the constructor callee at 4507, and the other uses at 4562-5184) ask `typeApplied` first, then `typeOfArg` |
| `importTypeFunc` (1322), `unknownTypeFunc` (1359) | Nothing for a program: an imported generic type is the exported symbol, whose parameter kinds `typeApplied` reads. In a file checked on its own, the kinds come from the parameters the import restates (`"Ring" func Ring(comptime n: u32, comptime T: type) -> type`) |
| `checkFuncBody` | Nothing beyond the declaration above. An instance's body has numbers where `n` was read |
| `atSource`, `recordDefinition`, `recordReference` | Nothing new: a value parameter's name is a parameter of the generic; a reference to it from the body is recorded at its offset in the generic, as for a type parameter's |

### Codegen (`codegen.ts`)

Nothing beyond P1. Instances are emitted by `funcsInOrder` (3494-3511), which sorts their names as text; that order is
what the twins in section 4 are written in.

### Tooling and documentation

- The message for an unknown identifier (`inferIdent`, checker.ts:4351): where the name has a hyphen, the part before
  it is a name in scope and the rest is a number, the hint of D16 in place of `did you mean`.
- `meta.ts` and `instances.ts`: hover on a value parameter, `n: u32 — in sum(n = 4): 4; in sum(n = 8): 8`, from each
  instance's argument (the `param` mark finds the literal in the copy); definition, references and rename as for a type
  parameter. The `listing` of 8.4 (twelve instances, then a count) holds.
- `formatter.ts`: print `[expr]T`, `u32#n`, `u32#(expr)` and value arguments as written; idempotent on every new form.
- The TextMate grammar: a name after `#` and inside brackets in a type is coloured as a value.
- `docs/encantis.md`: the new 8.7 (section 3); in 8.1 rule 1 the convention of D12; in 8.2 the counting sentence ("type
  or value parameters"); 8.4's names and identity bullets; 8.9's table without the value-parameter row and with the
  rows of section 7; 8.10's table row "a number" filled in (`comptime n: u32`; `[n]T`); 2.2 (a bound may be a
  constant expression; the bound limits); 2.4 and 2.5 (lengths are constants); 13's "Comptime Evaluation" rewritten
  without the first step. `docs/grammar.md` for the grammar above. `spec/generics.md`: the case `func zeros(comptime n:
  u32) -> [n]u8 => 0` with `errors: Expected` becomes a compiled case, and every row of section 5 gets a case.
  `CLAUDE.md`'s line on `def` ("scalars only") gains "and sizes types".

## 10. Tests and acceptance

- **Twins.** Each pair of `probes/doc/` becomes an `ents same-wasm` pair in the chapter or a `generics.test.ts`
  comparison through both assemblers, and the generic side must equal the hand-written side compiled by the base,
  byte for byte: `01` 231 bytes, `02` 87 (after P1), `03` 108, `04` 86, `05` 182, `06` 217, `07` 160, `08` 193, `09` 67,
  `10` 167, `11` 105 **[ran: the hand-written sides]**. Add: explicit and inferred calls of one instance; a value passed on
  (`n * 2`) to another generic; a value parameter with a type parameter and a comptime function parameter
  (`sort<8|i32|ascending>` over a `*mut [8]i32`); a generic type with only value parameters; an instance asked for from
  two modules (one instance, `$lib$push<8|u32>`); `u8`, `i32` (negative) and `u64` value parameters.
- **Proofs.** For each of `for i in n`, `x % n`, `x & (n - 1)`, `return false when i >= n` and `u32#n` parameters, the
  instance's index is unchecked (no `if` around the access in its WAT), and a hand-written twin has the same bytes.
- **`n = 0`.** `sum(none)`, `FixedVec(0, u64)`'s `push`, `Ring(0, u32)` and `get("", 0)` give the errors of 5.3 and of
  their twins **[ran: c01, c02 for the twins]**; `scratch(0)` and `for x in xs` over a `*[0]u32` compile **[ran: c35 for
  the twin]**.
- **Names in the body.** `let n`, `for n in`, `if let n`, a match arm `n =>`, `n = 3`, `n += 1` and `set (n, x) = ...`
  each give one error per instance (D14), and a generic nobody calls gives none.
- **P1.** `v[1 + 1]`, `v[(2)]`, `v[k - 1]` with a `def k`, `v[two]` with a `def two` declared after its use,
  `b.items[1 + 1]` in registers and in memory, and `w[1 + 1] = 7` each give the WAT of the literal index.
- **Sizes.** `sizeof([536870912]u64)`, `*[1000000000]u64` and `[n]u64` with `n = 536870912` are refused (D9);
  `sizeof([536870911]u64)` is `(i32.const 4294967288)`.
- **Constructor calls stay values.** A generic called with a constructor argument (`seen.add(Cell(1, 2))`, 8.8's
  example, and `pick(c, Pt(1, 2), p)` of 8.2) checks and compiles as at the base; `Ring(8, u32)(0, 0,
  cells)` and `sizeof(Ring(8, u32))` read `Ring(8, u32)` as a type.
- **Errors.** Every row of section 5 is a `spec/generics.md` case, with one error each and the instance label where 5.3
  gives one.
- **Corpus.** Every `.ents` file and `ents` block of both repositories gives the same WAT, errors and warnings as at
  the base, except the cases named in section 8; the golden hashes are unchanged; the grammar-bundle test passes.
- **Grammar.** The new `BaseType` alternatives change the parse of no corpus source (the check `judge/gram.ts` did for
  the plan), and the forms `[n]T`, `[n]mut T`, `[n * 2]T`, `[(n)]T`, `[0x10]T`, `[2x3]T`, `[_]T`, `[!]T`, `[*]T`, `[]T`,
  `u32#16`, `u32#n`, `u32#(n + 1)`, `Ring(8, u32)`, `Ring(n, T)`, `f([n]u8, x)` parse as section 9 says.
- **Tests that change.** `generics.test.ts` pins `comptime n: u32` and `comptime n: Meters` (a name for `u32`) as
  refused (lines 1074-1076 and 3313-3316); both become value parameters, and `comptime p: Pair(T, T)` beside them
  gets 5.1's new message. `spec/generics.md` (lines 728-748): the `zeros` case is no longer `Expected`, and the
  value-parameter case moves to 5.1's wording.
- **The library.** `lib/fixedvec.ents`, `lib/ring.ents` and `lib/bits.ents` with inline tests, each function a twin of
  its hand-written instance; none emits a check on an indexed access. A test program imports `lib/vec` and
  `lib/fixedvec` together, renaming one `push` (section 6).

## 11. Risks and open questions for the owner

### Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Every number rule now runs inside instances.** `n` is a literal there, so faults in how constants are handled in hand-written code are met at once, as P1 was | The twins compile the instance's shape by hand on the base before the feature lands; P1 (in all its forms, V3) and the size fault of D9 (V2) are the ones found. A literal-shaped fault found later is a fault of hand-written code, with a hand-written repro |
| R2 | **`let k = n` depends on the value**: an `i32` for 8, an `i64` for 3000000000 (D1). An instance for a large `n` can then fail where one for a small `n` checks | Documented in 8.7 with the fix (`let k: u32 = n`). The alternative of D1 removes it at the cost of every range proof |
| R3 | **Huge `[n]T` in registers.** A `[100000]u8` value is 100000 wasm locals, by hand as from a parameter; wasm engines limit locals, parameters and results (a function of 2000 parameters is accepted by the base **[ran: c32]**, and engines commonly cap a function at 1000 parameters, which was not run here) | As for hand-written code; not made worse, but a parameter makes it one number away. A limit on registers per function is a separate change, and the place where it would be reported is the instance, with its label |
| R4 | **Grammar.** Expressions inside types are new. A type is reached where a statement may end (`let x: [n]u8` then a newline and `(`), and `[` `Expr` `]` could take more than it should | The PEG tries every existing bracket form first; the corpus parse check is the guard. An `Expr` in a length cannot contain a newline-sensitive construct that ends a type early, since `]` must follow |
| R5 | **`[0x10]` and `u32#0` change meaning or become errors** | No source in either repository has them (section 8) |
| R6 | **One copy per number.** `sum` over arrays of fifty lengths is fifty functions | As for types (8.4: no merging). Section 3 says it, with the slice-taking core as the remedy |
| R7 | **Data over 4 GiB.** `scratch(3000000000)` and `scratch(3000000001)` together lay out more than a memory holds; codegen throws `the data takes 6000000008 bytes of memory, more than the 4294967296 (4 GiB) a wasm memory can hold` (a thrown error, not a diagnostic) **[ran: c30, written by hand]** | Unchanged here: D9 bounds one array, not the sum. The thrown error could become a diagnostic at the `data` or the instance that crosses the limit |
| R8 | **Names across library files.** `lib/vec` and `lib/fixedvec` both export `push`, `pop`, `last` and `clear`, and a module cannot import two generics of one name | Renaming on import (section 6), or open question Q6 |

### Open questions

| | Question | This design assumes |
|---|---|---|
| Q1 | Should an array literal decide `n` by its count (`sum([1, 2, 3])` gives `n = 3`)? The count is never ambiguous, but 8.2's rule 3 says an array literal is untyped as a whole and decides nothing, and #30's open question 2 asks whether its typed elements should decide `T` | No: one rule for literals. Saying yes later breaks nothing |
| Q2 | `n` in the body: the number (D1), or a typed constant that is always a `u32`, with typed constants made to give ranges in all code (which edits `examples/crypto/ed25519/field.ents`, whose `& mask51` results would become ranged)? | The number |
| Q3 | Should `bool` value parameters come now, before a compile-time `if`, for flags whose branches are cheap at run time? | No (D2) |
| Q4 | A constant divisor of 0 (`x % 0`, and `x % n` with `n = 0`) traps at run time and is accepted by the checker today. An error? | Unchanged; an error would be a hand-written change too |
| Q5 | The order convention `n` before `T` (D12), or `T` first as 8.1 says for type parameters? | `n` first, as `[n]T` |
| Q6 | The three library files of section 6, or fewer (`FixedVec` and `Ring` only)? And their names: the same `push`, `pop`, `last`, `clear` as `lib/vec` (an importer of both renames one, R8), or names of their own (`fixed_push`), or generics that share a name chosen by the receiver's type (left out by 8.9 today)? | All three, small, with tests; the same names as `lib/vec`, renamed on import where both are used |
| Q7 | At `n = 0`, `for i in n` proves nothing about `i` and `i >= 0` narrows nothing, so an instance for 0 of a body that indexes is refused, as its twin is (D8). Should a loop that never runs, and a branch that a comparison makes unreachable, prove every index in them (the code there never runs), in hand-written code and so in instances? | No change: refused, as hand-written code for 0 is. Saying yes later breaks nothing |

### Found on the way, not part of this design

- A `def` used before its declaration is resolved by the checker, not the parser, and compiles differently from one
  declared before its use: `x + late` for a `u64` is `(i64.add (local.get $x) (i64.extend_i32_s (i32.const 8)))`, while
  `x + 8` is `(i64.add (local.get $x) (i64.const 8))` **[ran: c28]**. The output depends on where the `def` stands. The
  plan's step that moves `def` into the checker (plan 3.10, its risk 12) has to emit a `def` as its literal.
- `sizeof` of a type of 4 GiB or more, and the address of an index into one, are wrong today (D9); D9's limit fixes
  both for hand-written code.

## 12. Appendix: what was run

All under `<scratch>/design/comptime-values/probes/`, with the base compiler (`bun
base/packages/cli/src/cli.ts`, a84f5e6; `run.sh` sets `ulimit -v 6000000` and `timeout 60`).

| Probe | What it showed |
|---|---|
| `doc/01`-`11` (`build.sh`) | Each hand-written twin compiles, validates (`wasm` command), and its tests pass where it has tests; sizes as in section 10 |
| `t1`, `t2`, `t3` | `for i in m` with `def m = 8`, `for i in 8` and `for i in p.len` give a `u32#8` counter; `for i in 8:u32` and a typed `def k: u32 = 8` do not (`runtime index on *[8]u8 requires 'if let' or '??'`) |
| `t4` | `let y: u8 = k` with a typed `def k: u32 = 8` is `cannot assign u32 to u8` |
| `t5`, `t6`, `t18` | With a typed constant, `x & (k - 1)`, `x % k`, `x & 7:u32`, `x % 8:u32`, `x >> s` give no range; `p[k - 1]` is still a proven constant index. With an untyped one all are proven |
| `t7` | An array field in memory indexed at run time: `dynamic index on value type [8]u32 — use a pointer or slice for dynamic access` |
| `t8`, `t9`, `t17`, `t29` | A pointer field `items: *mut [8]u32` indexed by a `u32#8` field or parameter, `return false when i >= k` narrowing with a typed constant, `w[i >> 5]` with `i: u32#128` on a `*[4]u32`: all unchecked |
| `t10`, `t19` | `p[i] ?? 0` and `if let v = p[i]` on a proven index are accepted (and still checked at run time) |
| `t11`, `t12`, `t13`, `t15` | `*[0]u8`, `u32#0`, `[0]u32`, `sizeof([0]u64)`, `u32#4294967297`, `u8#300` are accepted; `*[4294967296]u8` is accepted until `.len` (`cannot assign int(4294967296) to u32`); `let i: u32#0 = 0` is `cannot assign int(0) to u32#0` |
| `t14`, `t24`, `t26` | The argument messages reused in 5.2, word for word; `x % 0` is accepted |
| `t16` | `*[0x10]u8` is the packed `0 x 10`: `.len` is `(i32.const 0)` |
| `t20` | `if true { ... }` and `if false { ... }` are emitted as `(if (i32.const 1) ...)`, not folded |
| `t21`, `t22` | `v[k]` on a value array with `def k = 2` compiles; `v[1 + 1]` throws `Cannot index this expression` in codegen (P1) |
| `t23` | A static byte buffer cast to `*mut [4]Pt` and used as a pool |
| `t25` | The runaway message in full: `too many nested instantiations (64) while instantiating 'deep', in deep(T = ***...)` with `required from` notes |
| `t27`, `t28` | `v.items[0..v.len]` on a `*mut [4]u64`: an optional slice with `len: u32`, a proven slice with `len: u32#5` |
| `t30` | The parser makes `-3` one `LiteralExpr` with the value -3 |
| `t31` | A struct holding `[3]u8` in place: built, laid out as `data`, read by constant index; `sizeof` is 7 |
| grep | No `[0x..]` length, `uK#0`, or `u8#` bound above 256 in `examples`, `lib`, `packages`, `spec`, `docs`, or the 38 `.ents` files of `<board-builder port>/moonbit/encantis`. Typed `def`s used with `&` in `examples/crypto/ed25519/field.ents` (`let h0 = h0-lo & mask51`) |

The critique's probes are under `probes/critique/` (`cNN.ents`, run with `../run.sh <path> compile`):

| Probe | What it showed |
|---|---|
| `c01` | `for i in 0` with `xs: *[0]u32`: `runtime index on *[0]u32 requires 'if let' or '??' (no optional type for u32)` (the counter is a plain `u32`) |
| `c02` | `FixedVec` for 0 by hand: `return false when i >= 0` narrows nothing; `index type u32#1 may exceed *[0]u64 bounds (max index 0 >= 0) — narrow the index range to fit`, `cannot assign u32#2 to u32#1` |
| `c03` | A function `items` beside a field `items`: `v.items()` is `cannot call non-function type: *mut [4]u64 ('items' is a field here, and a field wins over the function 'items': write items(...))` |
| `c04` | `~0` passed for a `u8`, and `let m: u8 = ~0`: 255 |
| `c05`, `c13` | `sizeof([536870912]u64)` emits `(i32.const 4294967296)`, which `wasm` refuses (`invalid literal "4294967296"`); `p[i] ?? 0` on a `*[1000000000]u64` checks `i` against the length and computes `p + i * 8` in an `i32` |
| `c06` | `*mut [8]u8` for `*mut [5]u8`: `argument 1: cannot assign *mut [8]u8 to *mut [5]u8`; a string of 5 bytes for `*[3]u8` is refused |
| `c07` | Pointers to structs whose fields differ only in range are not assignable either way (`cannot assign *mut R16 to *mut R8`) |
| `c08` | A `[3]f64` for `*[3]f64`: `argument 1: cannot assign [3]f64 to *[3]f64`; a literal of 2 elements for `*[3]f64`: `argument 1: cannot assign 2 elements to *[3]f64` |
| `c09`, `c10` | `"".len` is 0; `let k = 3000000000` is an `i64`, `let k = p.len` an `i32` |
| `c11` | `n-1` with a parameter `n`: `unknown identifier 'n-1' — did you mean 'n'?`, then `cannot assign i32 to u32` |
| `c12` | `u32#4294967296`, `u8#256` and `u32#4294967297` are accepted |
| `c14` | `'max' expects 2 arguments, or 3 with its type argument written; got 1` (and `got 4`) |
| `c15` | Instances in the order of their names as text: `$id<<u8\|u8>>`, `$id<u16>`, `$id<u8>` |
| `c16` | A mistake in a generic body that does not depend on `T` is reported once in each instance, with its label |
| `c17` | `8 = 3` is a syntax error (what `n = 3` would be if substituted as written) |
| `c18`-`c21` | `held.items[1 + 1]` (an array field in memory), `b.items[1 + 1]` (in registers), `w[1 + 1] = 7` and `v[(2)]` all throw in codegen (`Cannot index this expression`, `Cannot assign to this expression`) |
| `c22` | A `def` used before its declaration gives the ranges of a literal (`for i in late`, `x & (late - 1)`, `x % late` all proven) |
| `c23`, `c24`, `c25` | `let n` beside a parameter `n`: `'n' is already declared in this scope`; a match binding `n`: `... cannot reuse the name of a parameter`; a match binding named like a `def`: `... the name of a def`; `late = 3` for a `def`: `cannot assign to 'late': it is not a variable` |
| `c26`, `c28` | A `def` the checker resolves does not decide `T` and picks overloads as a literal does, but compiles to `(i64.extend_i32_s (i32.const 8))` where the literal compiles to `(i64.const 8)` |
| `c27` | `v[two]` on a value array, `def two` declared after: `Cannot index this expression` |
| `c29` | `let x: u32 = 0 - 1`, `id(0 - 1)`, `id(2147483648 * 2)`, `id8(200 + 100)`: `cannot assign int(-1) to u32` and the like; constants are checked by their exact value |
| `c30` | Two `data` blocks of 3000000000 bytes: codegen throws `the data takes 6000000008 bytes of memory, more than the 4294967296 (4 GiB) a wasm memory can hold` |
| `c31` | `argument 1 of 'max' must be a type: T is a type parameter`; `'max' takes positional arguments` |
| `c32` | A function with a `[2000]u8` parameter (2000 wasm parameters) is accepted |
| `c33` | `func set(...)` is a syntax error: `set` is a keyword |
| `c34` | A `[3]f64` for a generic's `*[3]T`: `cannot infer T for 's': write the type argument, as in s(u32, ...)` |
| `c35` | `for x in xs` over a `*[0]u32` compiles and its test passes: a loop over the elements needs no proof at `n = 0` |
| `doc/07`, `doc/08` | Rebuilt after the renames of section 6 (`set_bit`, `has_bit`; the field `buf`): same sizes, 160 and 193 bytes, tests pass |
| reading | `examples/data/ringbuf/ringbuf.ents` is a queue (push refuses when full, pop takes the oldest), not a ring that overwrites |

Not run by anyone, and therefore design only: the grammar of section 9 and its corpus parse check; every checker
change; the generic sides of the twins; the editor's display; the new messages of section 5 (the reused ones were
run); the library files.

## 13. Revisions

Changes made by the critique of 18 November, each checked on the base compiler (`probes/critique/cNN.ents`) or
against the reference. The text before them is in `parts/` and `DESIGN.orig.md`.

| # | Change | Why |
|---|---|---|
| V1 | D8 and the chapter's Bounds: `n = 0` refuses the bodies that index in `for i in n` or after `i >= n`, with the twin's error; a chapter example and 5.3 rows say so; open question Q7 | The design said `for i in 0` was fine. It is, but its counter is a plain `u32`, so `sum`'s `xs[i]` at `n = 0` is `runtime index on *[0]u32 requires 'if let' or '??'` **[c01]**, and `return false when i >= 0` narrows nothing, so `FixedVec(0, T)`'s store is refused **[c02]** |
| V2 | D9, the chapter, 5.3, 5.4, section 8 and section 9: an array has at most 4294967295 bytes, also behind a pointer, also from a literal's count | Overflow of `n * sizeof(T)` was open. Today `sizeof([536870912]u64)` emits `(i32.const 4294967296)`, which no assembler takes **[c13]**, and a checked index into a `*[1000000000]u64` wraps its address **[c05]**. With the limit, every proven index's byte offset fits an `i32` |
| V3 | P1 widened: `memoryPlace` as well as `memberValues`, writes as well as reads, `v[(2)]`, and a `def` the checker resolves; one fix in `evalComptimeIndex` with the checker's constants | The design named only `memberValues` and `v[1 + 1]`. An array field in memory, a store and a grouped index throw too **[c18-c21, c27]**, and instances make all of them (`b.items[n - 1]`, `w[n - 1] = x`) |
| V4 | D14 and rule 5: assignments to `n` and bindings of its name are errors in each instance, found by declaring `n` in the instance's scope (a `def` marked as a value parameter); no walk of the body at the declaration; 5.1's row moved to 5.3 with a new row for bindings | Substitution alone would make `let n = 5`, `for n in`, a match arm `n =>` silent: a local nobody reads, every later `n` already the number. The language's own checks catch them once the name is declared **[c23, c24, c25]**. Per instance is how every other body mistake is reported **[c16]**, and a generic nobody calls stays only parsed (8.1, rule 4) |
| V5 | D1 and section 9: why `n` is a literal and not a scoped `def` | A `def` the checker resolves gives the same ranges **[c22]** but compiles to `(i64.extend_i32_s (i32.const 8))` where the literal gives `(i64.const 8)` **[c28]**, and crashes as a value-array index **[c27]**; only the literal is the twin's bytes. Also recorded as a side finding in section 11 |
| V6 | Section 9: `typeOfArg` stays syntax-only; a new symbol-aware `typeApplied` reads `Ring(8, u32)` as a type only when `Ring` is a generic type in scope | The design's change (keep values as `ValueArg`) would turn every constructor call with value arguments, `Cell(1, 2)`, into a type application, and break generic calls such as 8.8's `seen.add(Cell(...))` |
| V7 | Section 6 and example `07`: the bitset functions are `set_bit`, `clear_bit`, `has_bit` | `set` is a keyword: `func set(...)` does not parse **[c33]** |
| V8 | Section 6 and example `08`: `FixedVec`'s element field is `buf`; `Ring` has no `count` function | A member wins over a function of its name (4.9): with a field `items`, `v.items()` is `cannot call non-function type ... write items(...)` **[c03]**. Twins rebuilt: same bytes |
| V9 | Section 6: the `ringbuf` claim replaced | `examples/data/ringbuf/ringbuf.ents` is a queue that refuses when full, not a ring that keeps the last `n`; it would be a `Queue(n, T)`, not three lines over `Ring` |
| V10 | Section 6, R8 and Q6: library names that clash with `lib/vec` across modules | Generic names are unique in a module, imports included (8.9), so a program using `Vec` and `FixedVec` renames one `push` on import |
| V11 | Section 6 and the chapter's Tables: `T` a fixed array makes `*[n]T` a table; `FixedVec(n, [3]i32)` refuses `push`; the pool-by-cast recipe is not for such `T` | Owner decision Q1 (17 Nov), "never silently wrong": the cast of zero bytes to `*mut [n][3]i32` would read them as row pointers |
| V12 | The chapter's Instances: recursion on a changing value cannot end, with the `pow` example and its error; section 7 row; summary paragraph | Instance explosion was covered only as a mistake (`count`). With no compile-time `if`, every recursion on `n` is an error (`argument 1: cannot assign int(-1) to u32, in pow(e = 0)`, the wording of any argument **[c29]**), which a reader from Zig or C++ would not expect |
| V13 | The chapter's Instances: one copy per number, with the remedy; R6 | Code size grows with each distinct `n`; the owner sees it before the library does |
| V14 | D16, the chapter, 5.4, section 8, section 9: `n-1` is one name; a hint says to write `n - 1` | Hyphens join names (1.2), and today's hint for `n-1` is `did you mean 'n'?` **[c11]**, which points at the wrong fix for this feature's commonest expression |
| V15 | Rule 1, D1 and Q2: the parameter's declared type checks the argument and types nothing in the body | Implied before, now said: with `comptime n: u64`, `let k = n` is an `i32` for 8 **[c10]**, which would surprise |
| V16 | The chapter: one list of compile-time constants for arguments and for lengths (with `.len`, `.wid`, `sizeof`); lengths computed untyped, exactly | The two lists differed (`.len` in one only). A length checked as a `u32` expression would take wrapped operands in `/`, `%` and `>>` (checker.ts:2347-2373), which `exactly` excludes |
| V17 | The inference table: rows for a value array where `*[n]T` is wanted (no match, as for `T` **[c34]**; the explicit call's error **[c08]**) and for a comptime function argument deciding `n` (8.6) | Two inference cases the table did not cover; both follow existing rules |
| V18 | The generic-type paragraph: a generic type is its body, so a value the body does not use changes nothing (`Tagged(4)` is `Tagged(5)`) | "Its arguments are compared as numbers" said the opposite of 8.5's alias rule |
| V19 | Section 9: `importTypeFunc` and `unknownTypeFunc` rows; `checkGenericDecl` refuses a value parameter named like a result | Interplay with generics across modules: a file checked alone knows the parameter kinds only from the import |
| V20 | R3, R7, sections 10 and 12 | R3 now says the base accepts 2000 wasm parameters **[c32]**; R7 records that data over 4 GiB is a thrown codegen error **[c30]**; tests for each change above; the critique's probes listed |

Checked and found right, so unchanged: the WAT of every example (the twins compile, validate and pass; rebuilt after
V7 and V8 with the same sizes); the reused messages of 5.2 and 5.3 (`argument 1 of 'max' must be a type: T is a type
parameter`, `'max' takes positional arguments` **[c31]**, `argument 1: cannot assign *mut [8]u8 to *mut [5]u8`
**[c06]**, `cannot assign int(-1) to u32` and the like **[c29]**, the count wording **[c14]**); `~0` for a `u8` is
255 **[c04]**; instance order by name as text **[c15]**; pointers to structs whose ranged fields differ are not
assignable **[c07]**, so `Ring`'s inference through `items` cannot let a wider `head` in; value arrays and literals of
the wrong count are refused for array pointers (#29's B9 and B10) **[c08]**; type equality needs no algebra (no type
is compared before an instance; a source import's restated signature is never compared, stage 5). Q1 to Q5 stand as
the designer wrote them.
