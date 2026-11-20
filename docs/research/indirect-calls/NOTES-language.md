# NOTES: what Encantis has today that bears on function values

Worktree read: <scratch>/methods (branch claude/method-calls, HEAD 5fca5c9). Read only.
Paths below are relative to that worktree unless absolute. "M:" = methods worktree, "D:" = fix2-decls worktree.
0.2.1 release = <0.2.1 checkout> (HEAD 2ba1c05 "Release 0.2.1"), also tag v0.2.1.
Started 2026-11-17. Status: DONE (see section 11 and end).

## 1. Reference text (docs/encantis.md, M)

- 3.4 "Function Types and Pointers" docs/encantis.md:1127-1170.
  - :1129 Status box: "Function types are checked, but a function value has no run-time form yet. Calling one is a
    compile error (`calling a function value is not supported yet: only a function named directly, or a comptime
    function parameter (comptime f: (i32) -> i32), can be called`), and a program that only stores or passes one
    does not assemble." Points to 8.6.
  - :1131 "Function names are first-class values with types corresponding to their signatures. At runtime, function
    values are opaque indices into WebAssembly's function table."
  - :1133-1154 aspirational examples: `let callback: i32 -> i32 = double`, `func apply(x: i32, f: i32 -> i32)`,
    `map(arr: []i32, f: i32 -> i32) -> []i32`, `get_op(add: bool) -> (i32, i32) -> i32` returning a function.
  - :1156-1163 function types need explicit return, `-> ()` for void: `walk(tree: *Tree, visitor: []u8 -> ())`.
  - :1165-1170 `->` right-assoc, curried `i32 -> i32 -> i32` (no closures exist, so currying has no implementation).
- D (fix2-decls) docs/encantis.md:1211 adds: "A function's name is no number either: cast to a number or an address,
  or compared, it is a compile error (`cannot cast func() -> u32 to u32: 'f' is a function, which has no run-time
  value yet`)."
- 13 Future "Closures" docs/encantis.md:3152-3188: "Unlike plain function pointers (which are just table indices),
  closures carry attached state". Implementation approach :3175-3180: non-capturing functions remain raw table
  indices (zero overhead); capturing become "fat": struct of function pointer + environment pointer; compiler
  generates env structs; callee receives an implicit environment parameter. Design questions :3182-3186 (syntax
  `|| expr`, capture by value/ref, closure types distinct or unified with coercion). :3188 cites wasm GC for envs.
- 9.3 WASM Type Mapping docs/encantis.md:2777-2788: no row for function types (table lists ints, floats, *T, []T,
  *[N]T, tuples).
- No "funcref", "call_indirect", "ref.func" or "elem segment" anywhere in docs/encantis.md, docs/grammar.md or spec/ (grep -i).

### Generics chapter (8)
- 8.1 rule 3 docs/encantis.md:2158: "A function with a comptime parameter is a generic function. It is not a value:
  it cannot be stored, passed as an argument, or exported to the host. It can only be called."
- 8.2 inference table :2230: `(T) -> T` parameter against a function `inc` decides T "from its parameter, or else
  its result".
- 8.6 Comptime Function Parameters :2533-2623. :2535 "This is how a sort takes its comparator without a function
  pointer". sort(xs, ascending) -> instance contains `call $ascending`; twin module :2558-2592 (same-wasm block).
  :2594 the argument must be the NAME of a module function (declared at module level or imported; not generic,
  not an expression, not a test's function, not an overloaded name) or an enclosing comptime fn param passed on;
  "Two instances are the same when the functions are the same function." :2596 param type may be a named alias
  (`type Cmp = (i32, i32) -> bool`). :2598 names of params ignored when matching. :2623 "Inside the generic the
  parameter is not a value. It can be called, and passed on ...; it cannot be stored or passed as an ordinary
  argument."
- 8.7 Not in This Version :2625-2653. Rows :2636 `generic function 'max' must be called`; :2645-2647 comptime fn
  argument not a name / overloaded name / comptime fn param used as a value. :2653: "A function passed for an
  ordinary parameter of function type decides `T` like any other argument, but a function value cannot be called at
  run time yet, in a generic or anywhere else: the call is `calling a function value is not supported yet: ...`.
  A generic that calls a function takes it as a comptime parameter."
- 8.8 :2657-2669 table: "a function" bound at compile time at module level (`func f`) and as parameter
  (`comptime before: (T, T) -> bool`); no run-time column.

- 8.4 docs/encantis.md:2384 "Zero cost ... No function tables and no indirect calls are involved." Enforced by
  generics.test.ts:1364-1369 `expectPlainWasm`: forbids 'call_indirect', '(table', '(elem', 'ref.func', 'funcref' in
  the WAT of every generic twin test (used at :1396 in expectSameWasm, :1715, :2471, :3058, :3096, :3320, :3362,
  :4223, :5215). CONSTRAINT: a program that uses no function value must keep emitting no table/elem/ref.func, or
  these tests (and the byte-identical twins) break.
- examples/generics/sort.ents:1-3 comment: "The comparator is a comptime function parameter ... No function table,
  no call_indirect."
- Name collision: Encantis already uses the word "table" for a pointer to rows, `*[N][M]T` (2.5 Nesting,
  docs/encantis.md:345, :435-456; RT.tableRow in codegen). A design that says "function table" must not reuse that
  word unqualified.

## 2. Stage 3 error (calling a function value)
- Introduced by 4a39d81 (2026-11-17, "Add method-call syntax and functions that share a name"); commit msg: "Calling
  a function held in a variable, a parameter or a field has never compiled: the module named a function that does
  not exist. It is now one error from the checker, in generic and hand-written code alike." Documented 8ac7dae.
- checker.ts:3327-3337 (M): if calleeType.kind==='func', `direct` = callee is IdentExpr and lookup(name).kind==='func';
  otherwise error at expr.span.start: `calling a function value is not supported yet: only a function named
  directly, or a comptime function parameter (comptime f: ${signatureText(calleeType)}), can be called`. Arguments
  are still checked afterwards (:3339+). Comment: "A function held in a variable, a field or a parameter would need
  an indirect call, which nothing emits."
- Spec blocks: spec/checks.md:1564-1593 "## Calling a function value": param `apply(f)`, local `let g = inc; g(x)`,
  field `h.run(h.arg)` with `type Handler = (run: (u32) -> u32, arg: u32)` -> 3x the error; args still checked.
  spec/generics.md:2682-2692: in an instance, error suffixed `, in apply(T = u32)`.
- codegen.ts:1036-1043 (M) callToWat: non-IdentExpr callee throws `Cannot call this expression ...: only a named
  function is called`. An IdentExpr callee that is a local/param would emit `(call $f ...)` (what 0.2.1 did).

## 3. Experiments (scratch: /tmp/claude-0/-home-user/c2838201-d71f-55a0-bc1a-cc2e586d01ea/scratchpad/fv)
apply.ents = `func apply_u32(f: (u32) -> u32, x: u32) -> u32 => f(x)` / `func inc(x: u32) -> u32 => x + 1` /
`export func go(y: u32) -> u32 => apply_u32(inc, y)` (same as <scratch>/gtypes-scratch/repair/p/rt2.ents).
- 0.2.1 (`bun <0.2.1 checkout>/packages/cli/src/cli.ts compile`) emits exactly:
  ```
  (module
    (func $apply_u32 (param $f i32) (param $x i32) (result i32)
      (call $f (local.get $x))
    )
    (func $inc (param $x i32) (result i32)
      (i32.add (local.get $x) (i32.const 1))
    )
    (func $go (param $y i32) (result i32)
      (call $apply_u32 (ref.func $inc) (local.get $y))
    )
    (export "go" (func $go))
  )
  ```
  `wasm`: `WAT error: parseWat failed: apply.ents:3:11: error: undefined function variable "$f"`. Two defects: the
  call names the PARAMETER as a function (`call $f`), and the argument is a funcref passed for an i32 param with no
  elem declaration (wabt reports those once the first is gone, see pass.ents).
- HEAD (methods) `check`: apply.ents:1:51: calling a function value is not supported yet ... (comptime f: (u32) -> u32)
- HEAD, store/pass only (no call) - checker accepts, codegen emits `ref.func` where an i32 is declared:
  - pass.ents `keep(inc, y)`: `(call $keep (ref.func $inc) (local.get $y))` -> validate: "type mismatch in call,
    expected [i32, i32] but got [funcref, i32]" + "function 1 is not declared in any elem sections".
  - store.ents `global g: (u32) -> u32 = inc` + `let h: (u32) -> u32 = inc` + `h == g`: emits
    `(global $g (mut i32) (ref.func $inc))`, `(local $h i32) (local.set $h (ref.func $inc))`,
    `(i32.eq (local.get $h) (global.get $g))` -> "type mismatch in initializer expression, expected [i32] but got
    [funcref]" + "type mismatch in local.set". (No "not declared" error: ref.func in a global initializer counts as
    a declaration.) Checker accepted `h == g` (both are variables, 8c8cfa6).
  - field.ents `type Op = (name: u32, run: (u32) -> u32)`, `Op(1, inc)` returned: `(func $mk (result i32 i32)
    (i32.const 1) (ref.func $inc))` -> "type mismatch in implicit return, expected [i32, i32] but got [i32, funcref]".
  So today the run-time representation is HALF decided: types lower to one i32 (codegen.ts:151-153 "Function
  references are table indices"), but a function NAME as a value lowers to `ref.func` (codegen.ts:391-394), a
  funcref. No table, no elem segment, no call_indirect is emitted anywhere.

## 4. Grammar of function types and calls
- encantis-grammar.ohm:146-147 (packages/compiler/encantis-grammar.ohm): `Type = BaseType "->" Type -- func | BaseType
  -- base` (right-assoc). docs/grammar.md:316-317 same EBNF; :426-437 examples; :238-242 `type BinaryOp = ...`.
- AST ast.ts:718-723 `FuncType { input: Type; output: Type }`. Resolved types.ts:116-121 `FuncRT { kind:'func';
  params: ResolvedField[]; returns: ResolvedField[] }` (fields keep names).
- encantis-grammar.ohm:151-170: pointer/slice/array prefixes take a full `Type`, so `*i32 -> i32` parses as
  `*(i32 -> i32)` (verified: hover shows `p: *func(i32) -> i32`), `[4](u32) -> u32` is `[4]((u32)->u32)` (array of 4
  function values). There is no optional function type (`?` only before `*`, `[]`, `[*]`, :151-156).
  `*((u32) -> u32)` with extra parens is a pointer to a ONE-FIELD TUPLE (g3: "cannot assign func(x: u32) -> u32 to
  (func(u32) -> u32)"); `*mut (u32) -> u32` works.
- Function signatures: encantis-grammar.ohm:72-78; FuncSignature `ParamList ("->" Type)?`, so a function can return a
  function type: `func pick(up: bool) -> (u32) -> u32` parses and checks (g4).
- Calls: encantis-grammar.ohm:364-367 `PostfixExpr = PrimaryExpr PostfixOp*`, `PostfixOp = AccessSuffix | "(" ArgList?
  ")" -- call`: ANY postfix expression can be called syntactically (`h.run(x)`, `ops[1](3)`, `pick(up)(5)`).
  docs/grammar.md:720-752. Arg :459-465 includes `Type_func &("," | ")") -- funcType` so a function TYPE can be a
  type argument (`apply((u32) -> u32, f)`, grammar.md:745).
- Member call: `x.f(a)` is a method call only where x has no member f (CLAUDE.md "Method calls are calls", ref 4.9).
  A FIELD of function type wins: `h.run(h.arg)` is a call of the field value (today the stage-3 error, spec/checks.md
  :1576). A non-function field called while a function of that name exists: checker.ts:3383-3395 error "cannot call
  non-function type: u32 ('size' is a field here, and a field wins over the function 'size': write size(...))"
  (ref docs/encantis.md:1666-1679).

## 5. Checker today (M unless noted)
- Function NAME as a value: checker.ts:3176-3191 returns `sym.type` (a FuncRT). Refused when: the name is a comptime
  fn param (`'before' is a comptime function parameter: it can only be called, or passed on ...`, :3177-3182); the
  name is shared by several functions (`'inc' is the name of several functions: it can only be called, where the
  arguments say which one`, :3183-3189; spec/checks.md:1549-1562); a generic (`generic function 'max' must be
  called`, ref 8.7 :2636). A function declared in a `test` can be a value too (its WAT name is `__test_<t>_<name>`).
- Parameter / local / global / struct field / array element of function type: all accepted by the checker;
  typed as FuncRT; lowered as ONE i32 (codegen.ts:151-153). Storing through a pointer works as i32.store
  (g9: `p: *mut (u32) -> u32`, `p.* = g` -> `(i32.store (local.get $p) (local.get $g))`).
- byteSize(func) = null (types.ts:1256-1294, default case): `sizeof((u32) -> u32)` is "cannot compute size of
  dynamically sized type" (g1). Consequence, SILENT MISCOMPILE today: `data ops = [inc, dec]` is accepted, typed
  `*[2]func(x: u32) -> u32`, laid out as "16 zero bytes at 0x8", and `ops[1]` loads with stride 1
  (`(i32.load (i32.add (i32.const 8) (i32.const 1)))`); g8.ents validates (90 bytes) and `f == g` of ops[1], ops[0]
  is true. A run-time index into it is refused: "runtime index on *[2]func(x: u32) -> u32 requires 'if let' or '??'
  (no optional type for func(x: u32) -> u32)" (g7).
- Assignability types.ts:866-881: function types must match exactly (param and result types by typeEquals; param
  NAMES ignored here) - "Functions are reference types (table indices), so no coercion is possible". But typeEquals
  for 'func' (types.ts:503-511) DOES compare field names (fieldEquals :539-541). canonicalKey (types.ts:1341-1344)
  drops names: "(x: i32) -> i32 and (y: i32) -> i32 take the same functions".
- Operators on function VALUES (variables): checker.ts:4024 sends non-scalar operands to checkAddressOperands
  (:4174-4189) which accepts `t.kind === 'pointer' || t.kind === 'func'` (:4177) like an address. So at M (and D) ALL
  of `f < g`, `f + 1` (typed as a function), `f == p` (function vs pointer) are ACCEPTED (g10). 8c8cfa6 (2026-11-16,
  "Operand validation: let function values be compared") had allowed only ==/!= and kept order/arithmetic an
  error; that rule was replaced by e434de1 ("Type both operands of an operator", claude/operand-types) and the
  `f < g` test is gone: checker.test.ts:2352-2358 at M keeps only `f == g`, `f != g` ("f == g compiled to one i32.eq
  on 0.2.1, and still does"). Ref 8.3 docs/encantis.md:2267 no longer mentions function values.
- Casts: castProblem checker.ts:6922-6939 treats 'func' as a single value like a number/pointer, so `g as u32`,
  `n as (u32) -> u32` (forging a function value from an integer) and `f as (i32, i32) -> i32` (re-typing to ANOTHER
  signature) are all accepted at M and D (g6, g10). `n as (u32)->u32` compiles to `(local.get $n)`.
- D6 (fix-round 2, worktree <scratch>/fix2-decls, commit e3201ca 2026-11-17 "Refuse a second declaration of
  a name, and a function's name as a number"; progress <scratch>/fix2-scratch/PROGRESS-fix-decls.md:14):
  a function NAME in a cast to a number/address or as an operand of an operator is an error; a function value
  held in a parameter still compares/casts. Code (D): checker.ts:4320-4323 in checkAddressOperands
  (`'${op}' cannot be applied to ...: 'f' is a function, which has no run-time value yet`), functionNamed
  :4344-4350 (IdentExpr whose symbol is a non-alias func), castProblemOf :4353-4358 (`cannot cast func() -> i32 to
  i64: 'f' is a function, which has no run-time value yet`; casting a name to a FUNCTION type is still allowed),
  used at :3211 (as) and :3425 (u32(f)). Tests D checker.test.ts:3121-3149 ("a function named where a value is":
  `f as i64`, `u32(f)`, `f == p`, `(f) != f` errors; `g == h`, `g as u32` on params OK). Ref D
  docs/encantis.md:1211. D on g6: `inc == inc`, `inc as u32`, `g == inc` -> 3 errors; `g == h`, `g as u32`, `n as
  (u32)->u32` OK. Commit msg: "A function's name where a value is compiles to a wasm funcref ... A function value
  held in a parameter is an i32 and is still compared and cast as before."
  The D6 note itself: "Storing/passing a function name still 'does not assemble' as ref 3.4 says".

## 6. Codegen today (M)
- typeToWasm 'func' -> ['i32'] codegen.ts:151-153 ("Function references are table indices"). So a function value is
  one i32 in params, locals, results, struct fields (flattened), globals (`(global $g (mut i32) ...)`), host
  import params (g5: `(import "env" "each" (func $each (param $f i32) (param $n i32)))`) and memory.
- identToWat codegen.ts:388-394: a module symbol of kind 'func' used as a value -> `(ref.func $<watName>)` (watName
  via nameMap, so cross-module mangled names). This is the ONLY reference-types instruction emitted, and it is
  always ill-typed against the i32 it is used as. No `(table`, `(elem`, `call_indirect`, `table.*`, `(type` decls.
  call_indirect appears in codegen.ts only inside effect regexes (:498, :513, :516, :901, :1218).
- constantToWat codegen.ts:3399-3418 returns null for a ComptimeValue of kind 'func' (no constant for a function).
- Examples of the invalid output (section 3): pass, local.set, global init, multi-value return, if-result
  `(if (result i32) (local.get $up) (then (ref.func $inc)) (else (ref.func $dec)))` (g4), `i32.eq (ref.func $inc)
  (ref.func $inc)` (g6 at M).
- Exported global of function type (g5): `(global $hook (mut i32) (ref.func $inc))` + `(export "hook" (global $hook))`.

- History: 0.2.1 codegen.ts:901-909 (<0.2.1 checkout>) compiled a non-identifier callee to a bare stub
  `(call_indirect <callee>)` (no type, no args: invalid); an identifier callee that is a param compiled to
  `(call $f ...)`. M replaced the stub with a throw (codegen.ts:1036-1043). `ref.func` + `func -> i32` date back to
  836fbb7 (2026-04-28).
- Other: `def h = inc` is refused ("def value must be a compile-time constant", g11); `(inc)(x)` (a parenthesised
  name) is a function VALUE call and refused (direct only for a bare IdentExpr callee, checker.ts:3331; g12).
- Comptime fn params (the only working "function argument"): ComptimeValue kind 'func' {name, type, inline}
  checker.ts:62-70; evalComptimeArg :5758-5783 (must be an IdentExpr naming a non-shared, non-test module function or
  a comptime fn param passed on, then `name: target.alias ?? arg.name`); instance key joins func names
  (:5815, e.g. `sort<i32|ascending>`); bindComptimeFuncs :5906-5912 binds the param as a `func` symbol with `alias`;
  a call of it is rewritten in `calls` to a direct call of the alias (:3263-3268).

## 7. Wasm features emitted today, and imports/exports
- Assembler flags everywhere: wabt `parseWat(..., { simd: true, multi_value: true, bulk_memory: true })` cli.ts:262
  (wasm), :449 (run), :539 (test); examples/examples.test.ts:71; test-utils.ts:28, :86; extension
  watPreviewProvider.ts:117-119. wabt is 1.0.39 (node_modules/wabt/package.json) whose DEFAULTS already enable
  mutable_globals, sat_float_to_int, sign_extension, simd, multi_value, bulk_memory, reference_types (index.js
  `const FEATURES=Object.freeze({...})`); function_references, gc, tail_call, exceptions, threads, memory64,
  multi_memory, extended_const are off. So wabt would accept ref.func/tables today; it rejects `call_ref`
  (function_references off).
- wasm-opt: CLI `-O` runs `npx wasm-opt -Oz --enable-bulk-memory --enable-simd --enable-multivalue` (cli.ts:277);
  extension watPreviewProvider.ts:88 `--enable-multivalue --enable-bulk-memory`. Tested (binaryen 129): an MVP
  module with `(table 2 funcref)`, `(elem (i32.const 0) $inc $dec)`, `call_indirect` optimizes fine with the CLI
  flags; a module with `ref.func`/`ref.is_null` fails validation: "ref.func requires reference-types
  [--enable-reference-types]".
- What the corpus actually uses (all 80 .ents under examples/ and lib/ compiled at M to WAT in scratch fv/corpus):
  multi-value results in 37 files; memory.fill 10, memory.copy 3 (bulk memory); `(global ... (mut ...))` 20 files
  (every global is emitted mutable, codegen.ts:3394); exported globals 2 files (mutable-global export); memory
  defined in-module and exported in 16 files (`(memory (export "name") N)`, codegen.ts:3093-3097); host function
  imports in 4 files ("math", "sys", "wasi_snapshot_preview1"). ZERO files with sign-extension ops, trunc_sat, v128,
  ref.func, call_indirect, `(table`, `(elem`, `(start`, imported globals, imported memory. Codegen has no emitter
  for extend8_s/16_s, trunc_sat, table.*, memory.grow/size (grep codegen.ts).
- The board-builder port verification (builder/README.md "Wasm features"): the 0.2.1 weave.wasm needs only multi-value and
  bulk memory ("no sign extension, saturating conversion, reference types, tables, SIMD, exported globals or memory
  growth"). <board-builder port>/moonbit/ENCANTIS.md:5-7: "Encantis does produce what old Safari needs. Both
  kernels I ported compile to plain wasm MVP" (iOS 15 fallback was the question); :313-316 "Revisit Encantis once it
  has closures or at least callable function pointers ...".
- Imports (grammar encantis-grammar.ohm:44-50): `import "mod" "name" func f(...)` and `... global g: T` only. No
  memory import, no table import. Host import emission codegen.ts:3303-3375: params flattened per type (a function
  type param is one i32), global imports one wasm global per part, IMMUTABLE (`(global $g i32)`, no mut).
- Exports (grammar :56-62): Exportable = FuncDecl | GlobalDecl | MemoryDecl. No table export. exportToWat
  codegen.ts:3419-3445: func by watName; a multi-value global as one export per part (`order_ptr`, `order_len`,
  ref 7.2 docs/encantis.md:2108); memory `(export "name" (memory 0))`. A generic is never exported
  (isGenericExport codegen.ts:3168-3170; ref 8.1 rule 3).
- Memory: at most one per program (programToWat throws "Multiple memory declarations"); implicit `(memory N)` when
  data or pointers are used (usesMemory).

## 8. Several source modules -> ONE wasm module (programToWat codegen.ts:3523-3760)
- Every loaded source module is emitted into a single `(module ...)`: host imports of all modules (and of tests in
  test mode) first, one memory, then the functions of every module, globals of every module, exports of the ENTRY
  module only, test functions, one data section shared by all modules (literals of all modules collected into one
  DataSectionBuilder, :3536-3547), helpers.
- Names: the entry module's functions/globals keep their names; every other module's are prefixed with the file's
  basename: `$<basename>$<name>` (modulePrefix :3519-3521; e.g. examples/modular/main.wat `$util$add`,
  `$util$mul`). Instances are prefixed the same way (:3579-3582). A source import (`import "./util" ("add" func
  add(...))`, path starting ./ ../ / loader.ts:23-25) is resolved to the dependency's mangled name and compiles to a
  DIRECT call (buildFullNameMap :3597-3620). Exports of a non-entry module do not become wasm exports.
- Consequence for function values: there is no wasm-level linking between Encantis modules; a function value
  crossing modules is a reference to a function of the same wasm module. Experiment fv/mm: lib.ents exports
  `get_secret() -> (u32) -> u32 => secret` (a PRIVATE function of lib); main imports it; output has
  `(func $lib$get_secret (result i32) (ref.func $lib$secret))` in the same module as `$go`. One module-wide table
  would serve every module; identity (`==`) is program-wide.
- All functions of every loaded module are emitted even if unused (lib's `$lib$inc` emitted though main never calls
  it); builder/README.md item 12 asks for dead-function dropping.
- Test functions: a function declared in a test block is emitted as `__test_<prefix>_<name>` (emitTestDecl
  codegen.ts:3197, name at :3230); tests are exported as `test_<name>`.

## 9. Hosts that run Encantis output
- Runtimes here: bun 1.4.4 (reports process.version v26.3.0), node v22.23.4. Both run an MVP module with a funcref
  table, active elem segment and call_indirect (fv/rt-mvp.wasm: apply(0,5)=6, apply(1,5)=4; index 7 traps: node
  "RuntimeError table index is out of bounds", bun "Out of bounds call_indirect"). NOTE for experiments: under
  `ulimit -v 6000000`, node cannot instantiate any module that has a memory (V8 reserves more virtual memory);
  build with bun, run memory-less modules in node, or use bun.
- CLI (packages/cli/src/cli.ts): `wasm` writes the binary (no name section, toBinary({})); `run` instantiates with
  `{ wasi_snapshot_preview1: wasi.wasiImport }` only (cli.ts:466-470) and calls `_start` via wasi.start; `test`
  builds programToWatWithTests and instantiates with createTestHost (cli.ts:549-553), then calls each exported
  `test_<name>`.
- Test host packages/compiler/test-host.ts:53-71: provides `test.__assert_fail`, a small WASI (fd_write/fd_read/
  proc_exit, others ENOSYS), and a throwing stub for every other imported FUNCTION; non-function imports (globals,
  and any future table/memory import) are skipped (`imp.kind !== 'function'`), so a module importing one would fail
  to link in tests. Same host in examples/examples.test.ts:94-97 and test-utils.ts:54-56.
- VS Code extension (packages/extension): compiles in Node or a WebWorker, never instantiates wasm; the WAT preview
  (src/watPreviewProvider.ts:14-121) runs programToWat, wabt parseWat with the same flags, optional wasm-opt with
  `--enable-multivalue --enable-bulk-memory` (:88), and wabt readWasm/toText. tidyWat (:143-195, type defs at :160-164) folds `(type $x
  (func ...))` declarations into the lines that use them - it strips type defs, so a call_indirect `(type $t)`
  would be rewritten too.
- The board-builder port harnesses (<board-builder port>/moonbit/encantis): builder/check-weave.cjs:206-211
  `WebAssembly.compile(fs.readFileSync(wasmPath))` + `WebAssembly.instantiate(module, {})` - NO imports; the module
  exports memory "mem" and functions in_ptr/fin_ptr/out_ptr/weave/draws/trace_ptr (contract :14-30). check.cjs:9-10,
  check-features.cjs:50, solver/check.cjs:28 likewise instantiate with `{}`. weave.wasm is built from four source
  modules + ../stack/stack.ents merged by programToWat (builder/README.md "Files", "Build and check"). Node 22.
  ENCANTIS.md:220 shows host imports used once (`import "Math" "pow" func pow(...)`, instantiated with `{ Math }`).


## 10. Every place in the corpus that passes, stores or would call a function value
Searched: examples/ and lib/ (80 .ents), docs/*.md, spec/*.md, experiments/, crypto-challenge*.md, README.md,
<board-builder port>/moonbit/encantis (all .ents/.md), <board-builder port>/moonbit/ENCANTIS.md.
Patterns: a parameter/field/global/type alias whose type contains `->`; callback|dispatch|handler|vtable|comparator|
visitor|closure|lambda|indirect.

A. Working code (compiles today) - all COMPILE-TIME function arguments, no run-time function value:
- examples/generics/sort.ents:10 `sort(comptime T, xs: []mut T, comptime before: (T, T) -> bool)`; :23
  `twice(comptime T, comptime f: (T) -> T, x: T)`. Comment :1-3 "No function table, no call_indirect". Wants: a
  comparator; a function applied twice.
- spec/generics.md (8.6 tests): :1926, :2007, :2033-2034 (each/both passing a comptime fn on), :2049 first(cmp),
  :2059-2138 sort variants and errors, :2097 `type Cmp = (i32, i32) -> bool`, :2154, :2170, :2196, :2366-2367
  (`xs.ptr[0].before(xs.ptr[1])` - a comptime fn param called with method syntax), :2697 pick(before).
- docs/encantis.md 8.6 :2537-2621 sort/ascending/descending, twice(inc, 5).

B. Spec/doc blocks that pass a RUN-TIME function value (checked as errors, or only typed):
- spec/generics.md:850 `apply(comptime T: type, f: (T) -> T, x: T) -> T => x` (f is an ordinary parameter: passing
  `add` there is "argument 1: cannot assign func(a: u32, b: u32) -> u32 to func(u32) -> u32"); :2684-2691 apply
  calling a run-time `f` in an instance -> the stage-3 error ", in apply(T = u32)".
- spec/checks.md:1549-1562 `apply(g: (u32) -> u32, x)` given an overloaded name -> "'inc' is the name of several
  functions ..."; :1564-1593 "Calling a function value": a parameter `apply(f, x) => f(x)`, a local `let g = inc;
  g(x)`, a struct FIELD `type Handler = (run: (u32) -> u32, arg: u32)` with `h.run(h.arg)` -> 3 errors. (Handler is
  the "callback + its argument" shape: a function paired with its context.)
- docs/encantis.md 3.4 :1133-1170 (aspirational, not run): local `let callback: i32 -> i32 = double`, `binary_op`,
  `apply(x, f)`, `map(arr, f) -> []i32`, a function returning a function `get_op(add: bool) -> (i32, i32) -> i32`
  (run-time choice between add_fn/sub_fn = dispatch), `walk(tree: *Tree, visitor: []u8 -> ())` (visitor callback),
  curried `i32 -> i32 -> i32`. 13 Closures :3156-3173 `make_counter(start) -> () -> i32` (capturing),
  `map(arr, f)`.
- docs/grammar.md:238-242, :256-257, :426-437 function type examples; :745 `apply((u32) -> u32, f)` type argument.

C. The board-builder port (Encantis 0.2.1 ports of the MoonBit game core):
- builder/bugs/10-call-function-parameter.ents: `apply(f: (i32, i32) -> i32, a, b) => f(a, b)`,
  `apply(descending, 3, 10)` -> 0.2.1 "undefined function variable "$f"". Header: "So a sort cannot take its
  comparator: weave.ents writes survey's one sort out by hand."
- builder/weave.ents:521-534: hand-written stable insertion sort by `cost` (JS: `order.slice().sort((x, y) =>
  cost[y] - cost[x])`); the comparator reads a GLOBAL (`cost`), so it is a plain top-level function, known at compile
  time. NOTES.md:56-62: "A comparator ... became a hand-written stable insertion sort in survey() (9 lines). A
  function passed as an argument cannot be called at all (bug 10)"; "Lambdas in filter, some, map, makei: 6 sites,
  each an explicit loop or a small named function". NOTES.md:114-118 "Sorts with comparators".
- builder/NOTES.md:25-55, README.md "How it is written": MoonBit's weave has 25 local closures over ~30 shared names;
  the port made them top-level functions over module globals (32 + 28 globals). "None of the 25 closures is ever
  passed as a value, which is why this worked."
- solver/solver.ents:286-300: insertion into `tries` keeping a stable order (solver/README.md:35-36: "an insertion
  sort in place of `ssort` with a comparator"; :65 no closures, state in globals).
- stack/containers.draft.ents:13, :53-94 and stack/README.md:100-110: a Set(K)/Map/sort wanted once per program;
  hash/eq found by name for K (duck-typed requirements, now generics), not function values.
- builder/README.md "What to add", item 9: "Function values that can be called (bugs/10), then generics. In this
  port: one sort, 9 lines." Item 10: "Closures: last. None of the 25 escapes ... What globals cost (a reset by hand,
  no reentrancy, signatures that hide what they touch) is better answered by a context struct behind a pointer".
- ENCANTIS.md:201-202 needs table: "Stable sort with comparators (7 sites) | stable_sort_by | No callable function
  pointers, so a sort per site"; "Closures capturing mutable locals (~25 local fns in weave.mbt, 11 in hex.mbt)".
  :10 "no closures or callable function pointers"; :313-316 revisit once it has "callable function pointers".
- generics/design-language.md:695 "Calling a function-typed runtime value | unchanged from today (invalid; a
  comparator is a comptime parameter)"; :738 G4 "No new wasm. No table, no call_indirect, no ref.func ...".

D. Nothing in examples/, lib/ or experiments/ stores, passes or calls a run-time function value; no dispatch table,
vtable or host callback exists anywhere in the corpus. Host imports in the corpus are plain functions (math, sys,
WASI). The data-structure examples (trie, crit-bit, ringbuf) have no visitor or callback.

What the programs want, by evidence: (1) comparators for a sort - 1 site in builder, 1 in solver, 7 in the game
core - all statically known functions, often reading globals (comptime fn params already cover these since stage 2);
(2) small lambdas for filter/some/map (6 sites) - want anonymous functions, not run-time values; (3) non-escaping
closures (25 + 11) - globals worked; a context struct behind a pointer is the suggested answer; (4) the reference's
aspirational uses: a function chosen at run time (get_op), a callback/visitor (walk), a stored callback (local,
global, struct field, Handler = function + argument), returning a function. None of (4) has a real program yet.

## 11. Constraints / facts a design must respect (summary)
- A function value already has a decided TYPE-level lowering: one i32 (codegen.ts:151-153), and the reference says
  "opaque indices into WebAssembly's function table" (:1131) and "plain function pointers (which are just table
  indices)" (:3154). Params, struct fields, globals, host-import params, memory slots already carry it as i32.
- What is undecided/broken: the VALUE of a function name (today `ref.func`, ill-typed), the call (refused), the
  table and elem segment (never emitted), byteSize (null -> data arrays of functions silently zero), operator and
  cast rules (any address-like operator and any cast accepted on function values, including integer -> function
  and signature -> signature).
- Programs that use no function value must keep producing the same bytes: generics twins (expectSameWasm) and
  expectPlainWasm in generics.test.ts:1364-1369, examples.test.ts:86-91 forbid table/elem/ref.func/funcref/
  call_indirect in generic programs; G6 "old programs unchanged".
- A program is ONE wasm module (programToWat); functions of other source modules are `$<basename>$<name>`;
  only the entry module exports; so one module-wide table and program-wide function identity are available.
- Toolchain: wabt 1.0.39 defaults accept reference types; wasm-opt invocations (CLI -O, extension) do NOT pass
  --enable-reference-types, so `ref.func`/`ref.null`/`table.get` etc. fail there while an MVP table + active elem +
  call_indirect pass. The board-builder port review values plain-MVP output for old Safari (ENCANTIS.md:5-7).
- Hosts instantiate with `{}` (the board-builder port), WASI only (`run`), or test host (function imports only). None supplies
  a table import; nothing reads a table export. The grammar has no table/memory import and no table export.
- Calls: any postfix expression is syntactically callable; a field wins over a method of the same name, so
  `h.run(x)` with a function-typed field `run` is a call of the field value (spec/checks.md:1576).
- A comptime function parameter is a NAME, resolved to a direct call (ref 8.6; CLAUDE.md M "Comptime function
  parameters are names"); an ordinary parameter of function type can already decide T (ref 8.2 table :2230).
- Names: the word "table" already means a `*[N][M]T` of row pointers in Encantis (ref 2.5).

Status: DONE (all items of the task covered). Scratch programs: /tmp/claude-0/-home-user/c2838201-d71f-55a0-bc1a-cc2e586d01ea/scratchpad/fv
(apply, pass, store, field, g1-g12, mm/, rt-mvp.wat, ref.wat, corpus/*.wat) - may be lost on restart.
