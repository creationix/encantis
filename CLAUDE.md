# Encantis

Encantis is a programming language that compiles to WebAssembly.

## Documentation

- **[docs/grammar.md](docs/grammar.md)** - Formal grammar specification (EBNF). Source of truth for syntax.
- **[docs/encantis.md](docs/encantis.md)** - Language reference. Source of truth for semantics, type system, and behavior.

## Project Structure (Bun Monorepo)

This is a bun workspace with three packages:

- **`packages/compiler/`** - Core language implementation (`@encantis/compiler`)
  - `parser.ts` - Parser (ohm-js based, matches grammar spec)
  - `codegen.ts` - WAT code generation
  - `checker.ts` - Type checker and semantic analysis
  - `ast.ts` - AST type definitions
  - `types.ts` - Resolved type system (ResolvedType, type assignability)
  - `meta.ts` - LSP metadata (symbols, hints, hover)
  - `encantis-grammar.ohm` - Ohm grammar (bundle with `scripts/bundle-grammar.ts`)
  - `encantis-actions.ts` - Parser semantic actions (Ohm → AST)
  - `data-pack.ts` - Data section serialization
  - Exported as library with named exports: `parser`, `checker`, `codegen`, `ast`

- **`packages/cli/`** - Command-line interface (`@encantis/cli`)
  - `src/cli.ts` - CLI entry point
  - Depends on `@encantis/compiler` via workspace

- **`packages/extension/`** - VS Code extension (`encantis-vscode-ext`)
  - Dual-mode: Node.js desktop + WebWorker browser support
  - LSP server with diagnostics, hover, and language features
  - Depends on `@encantis/compiler` via workspace

- **`examples/`** - Example programs
- **`docs/`** - Language documentation

## Setup

```bash
bun install              # Install dependencies and link workspace packages
```

## CLI Usage

```bash
# Install global command (symlink to TS source, runs via bun)
sudo ln -s /Users/tim/Code/encantis/packages/cli/src/cli.ts /usr/local/bin/encantis

# Then use it
encantis compile <file.ents>              # Output WAT to stdout
encantis compile <file.ents> -o out.wat   # Output to file
encantis ast <file.ents>                  # Output AST as JSON
encantis check <file.ents>                # Check for errors
```

## Build Commands

```bash
bun run build:cli        # Build CLI package
bun run build:ext        # Bundle the extension: desktop (Node.js) and web (WebWorker)
bun run build:ext-web    # Bundle the web extension only
bun run watch:ext        # Watch extension (Node.js)
bun run watch:ext-web    # Watch extension (WebWorker)
bun run reinstall:ext    # Package the .vsix and install it in VS Code
node packages/extension/test/run.mjs desktop|web <file.vsix>   # Run a .vsix in VS Code, as CI does
bun test                 # Run tests
```

## Key Design Decisions

**Value types are register-flattened:** Structs, tuples, and `[N]T` fixed arrays compile to multiple wasm locals/params — no memory, no pointers. `point.x` → `(local.get $point_x)`. Nested access works: `rect.origin.x` → `(local.get $rect_origin_x)`.

**Fixed arrays in memory are reached through their address:** a `[N]T` that lies in memory (a field of a struct a pointer points to, or a part of one) is, wherever it is indexed at run time, ranged, looped over or given to `&`, the `*[N]T` it is there (`*[NxM]T`, packed, for an array of arrays), as mutable as the place. The checker puts such a node in `TypeCheckResult.addressed` with that pointer as its type, sticky across re-inference (`placeAddress`, `reachInPlace`), and codegen emits its address (`memoryPlace`) instead of loading it. A constant index keeps picking the element where it is. A struct in registers has no address, and neither has any part of it.

**Host references are their own kind:** `type Canvas = host` declares a nominal `HostRT` (`kind: 'host'`, its declaration's name; equal by name, also across source modules). The kind is kept through checking and only codegen knows it is an `externref` (`typeToWasm`, `ref.null extern` for none, `ref.is_null` for `== 0` and the boundary checks), so another backend can choose its own representation. It is held in registers only (parameters, results, locals, globals, register structs and arrays): `neverInMemory` refuses it behind a pointer, in a slice or many-pointer, in a literal laid out in memory (`&[c, c]` too), in `sizeof` and in an array's `.wid`, checking a type written before the module's types are declared once they are (`typesDeclared`, keeping the generic application it was asked in). Whether a type holds one by value is one walker, `heldIn` in types.ts (`hostIn`, `plainHostIn`), which function values are meant to reuse. A plain host type (`Canvas`) is never null: it has no default (`noDefault`, through `plainHostIn`: a `let` of one, or of a struct or array holding one, needs a value where declared and is seen only in the block it is declared in (`seenInItsBlock`); a global of one is imported, since no constant is one; a named result cannot hold one), `0` is not one, and `c == 0` is refused. `?Canvas` (AST `OptionalType`, `HostRT.optional`) may be null: the literal `0` is none (`ref.null extern`), it starts as none, `== 0` / `!= 0` are its only comparisons (`ref.is_null`), and `if let` / `??` resolve it to a plain one; a plain one widens to it. Inside the module a plain one is never null by construction; a value of one that comes in from the host (an exported function's parameter, an imported function's result, an imported global) is checked once where it comes in (`nonNullSlots`, `nullTrap`, the `$__host_globals` start function; an exported function the module also calls is exported through a checking `$__export_<name>` wrapper, `hostEntry`), and nothing else is. `encantis test` gives an imported global of a plain host type a stand-in object (`standIns`). Other casts, operators and conditions refuse it. `host` written anywhere but all of a type declaration is an error.

**`def` vs `data`:** `def` is pure compile-time substitution (scalars only). `data` embeds literals in the wasm data section and returns a pointer. `data buf = mut [0:u8; 1024]` → `*mut [1024]u8`.

**Const-by-default pointers:** `*T` is read-only, `*mut T` is writable. Same for `[]T`/`[]mut T` and `[*]T`/`[*]mut T`. Writes through const pointers are checker errors. Mutable pointers coerce to const (widening).

**Generics are substitution:** `func max(comptime T: type, a: T, b: T) -> T` is compiled once per distinct `T`. An instance is a copy of the declaration with its comptime parameters replaced, placed at private source offsets (instance `i` at `i * INSTANCE_STRIDE + original`) and checked and compiled like any function; a call of a generic is recorded as a plain call of the instance (`TypeCheckResult.calls`). The copy shares no AST node with the generic or with another instance: the tables keyed by node (`exprTypes`, `coercions`, `calls`) are per instance for that reason, and the ones still keyed by offset (binding types, literal ids, builtin-call marks) because of the private offsets. An instance must compile to the bytes of the same function written by hand, and an unused generic emits nothing: `generics.test.ts` compares whole `.wasm` files.

**Generic types are aliases with parameters:** `func Vec(comptime T: type) -> type => (...)` is a `typefunc` symbol, and `Vec(u32)` (AST `TypeApply`) resolves to its body with the parameters replaced, wrapped in a `named` type for display only. No new `ResolvedType` kind exists, so an applied type is structurally the struct it names. A parameter `v: *Vec(T)` is matched against an argument by expanding the body (`expandTypeApply`). A type that is called (`Vec(T)(p, 0, cap)`, `T(a, b)` in an instance) is recorded in `TypeCheckResult.calls` as the `TupleExpr` of its arguments in field order.

**Method calls are calls:** `x.f(a)` where `x` has no member `f` is recorded in `TypeCheckResult.calls` as the call `f(x, a)`, a `CallExpr` the checker builds with the receiver as the first argument that is not a comptime one, and then checks like any call (for a generic `f` that call is recorded as the call of an instance in turn, and codegen follows both steps). The built call starts at the method's name, not where the receiver does: the calls of a chain `a.f().g()` all start at `a`, and what is still keyed by a call's offset (a builtin's operand type, the call an instance was required from) needs an offset of its own. Members win, so whether `x.f(a)` is a method call depends on the type of `x`.

**Functions that share a name are renamed:** the first function of a name is known by the name, each later one by the name and its parameter types (`hash:''u8`, in `symbols` and in WAT). `TypeCheckResult.funcNames` gives that name for a declaration (a `FuncDecl` or an `ImportFunc`); look a function's symbol up through it, never by `decl.ident` alone. A call of a shared name is recorded in `calls` as the call of the function that was meant. In an instance a call of the one function of a name is checked as any call; where its arguments are refused and each of them is something by itself, what was reported is replaced by one error (`no function 'eq' accepts (u32, u32), in index_of(T = u32)`). A function declared in a `test` cannot take a shared name.

**A look at a call is remembered:** which function a call means is asked by looking at its arguments and receiver with nothing expected of them (`alone`, `fits`, `peek`), and what a look records is taken back. Looks nest, so `inferCall` keeps, for looks only, the type of a method call or picked call that checked (`settled`), the type of a call whose errors are listed (`failed`), and that a call failed where errors were not reported (`refused`). Without them each call of a chain walks every call below it again. The real check of a call is never cut short.

**Comptime function parameters are names:** `comptime before: (T, T) -> bool` is given a module-level function. The function's name is part of the instance's key (`sort<i32|ascending>`); inside the instance the parameter is a `func` symbol with `alias` set, and a call of it is recorded in `calls` as a call of the aliased function.

**Generics across modules belong to their module:** an imported generic or generic type is the exporting module's own symbol, registered under the import's name. An instance is made, checked and emitted in the module that declares the generic, whichever module asks; a call from another module is recorded as a call of the import's name plus the rest of the instance's name, which that module's `externs` (`TypeCheckResult.externs`) map to the owner's instance, and codegen gives it the owner's wasm name. `typecheckProgram` keeps every module's context: after each module it checks the instances asked of other modules where they belong (`drainLate`), to a fixpoint, and finalizes again a module that gained some. A call in an instance body that the owner has no accepting function for is looked up in the instance's `site` (the module whose ordinary code started the chain, see `callAtSite`); such an instance, and one that calls it, is the site's own (`usedSite`), and another site gets its own copy (`key@site`).
