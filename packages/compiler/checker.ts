// Type checker for Encantis
// Produces a TypeCheckResult with concrete types attached to all AST nodes

import type * as AST from './ast'
import { argValue } from './ast'
import { isSourceImport, resolveModulePath } from './loader'
import {
  type ResolvedType,
  type ResolvedField,
  type ArrayRT,
  type ArraySize,
  type PointerRT,
  type TupleRT,
  type FuncRT,
  primitive,
  pointer,
  slice,
  array,
  comptimeArray,
  comptimeArrayLiteral,
  ptrArray,
  manyPointer,
  tuple,
  func,
  field,
  VOID,
  comptimeInt,
  comptimeFloat,
  comptimeList,
  named,
  forwardRef,
  typeToString,
  typeEquals,
  canonicalKey,
  watSafe,
  comptimeIntFits,
  typeAssignable,
  unwrap,
  isFloat,
  isInteger,
  isSigned,
  isNumeric,
  isComptime,
  intBitWidth,
  isBool,
  byteSize,
  isFixedSizes,
  isValueArray,
  tableRow,
  totalElements,
  optionalOf,
  isOptional,
  unwrapOptional,
  PRIMITIVE_NAMES,
  type PrimitiveName,
} from './types'

// === Symbol Table ===

// Compile-time constant value: what a def is bound to, and what a comptime
// parameter is given
export type ComptimeValue =
  | { kind: 'int'; value: bigint }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'data_ptr'; id: number }  // pointer to data section literal (id is AST offset for literalRefs lookup)
  | { kind: 'type'; type: ResolvedType }  // the argument of `comptime T: type`
  // The argument of a comptime function parameter: a function of the module,
  // by the name it is called by
  | { kind: 'func'; name: string; type: ResolvedType & { kind: 'func' }; inline: boolean }

export type Symbol =
  | { kind: 'type'; type: ResolvedType; unique: boolean }
  // `alias`: a comptime function parameter inside an instance, which stands
  // for the function of that name
  | { kind: 'func'; type: ResolvedType & { kind: 'func' }; inline: boolean; alias?: string }
  | { kind: 'global'; type: ResolvedType }
  | { kind: 'def'; type: ResolvedType; value: ComptimeValue }
  | { kind: 'local'; type: ResolvedType }
  | { kind: 'param'; type: ResolvedType }
  | { kind: 'return'; type: ResolvedType }
  // A function with comptime parameters. It has no type of its own: each
  // distinct set of comptime arguments is an instance, which is an ordinary
  // function. `valid` is false when its declaration already has an error, so
  // that calls don't add theirs.
  | { kind: 'generic'; decl: AST.FuncDecl; owner: CheckContext; instances: Map<string, Instance>; valid: boolean }
  // A generic type: a function from types to a type. Applying it resolves its
  // body with the parameters replaced, in the module that declares it, once
  // for each way its arguments were written (`cache`). The result is the body
  // itself under the name it was applied by, as any type alias is.
  | { kind: 'typefunc'; decl: AST.TypeFuncDecl; owner: CheckContext; cache: Map<string, ResolvedType>; valid: boolean }

// One generic function with its comptime arguments fixed: a copy of the
// declaration with the parameters substituted, collected, checked and compiled
// as an ordinary function of the module that declares the generic.
export interface Instance {
  name: string          // symbol-table key and wasm name: max<u32>
  label: string         // for messages: max(T = u32)
  of: AST.FuncDecl      // the generic's declaration
  decl: AST.FuncDecl    // the substituted copy, its spans shifted by index * INSTANCE_STRIDE
  index: number         // from 1, in the order the module's instances were asked for
  first: boolean        // the generic's first instance: the one the editor's tables are filled from
  args: ComptimeValue[] // in comptime-parameter order
  requestedAt: number   // the call that first asked for it; inside an instance, at that one's offsets
  depth: number         // instantiation nesting, to stop a generic that never stops instantiating
  chain: InstanceChain
}

// Everything one call in ordinary code brought into being: the instance it
// asked for, the instances that one's body asks for, and so on. A generic that
// never stops instantiating itself is stopped by what its chain has used.
interface InstanceChain {
  size: number      // instances asked for so far
  keySize: number   // size of the type arguments the chain started with
  stopped: boolean  // already reported as never ending
}

// The copy of a declaration that instance i (from 1) of a module is made from
// lives at source offsets i * INSTANCE_STRIDE + original. What is keyed by
// node (the types of expressions, their conversions, lowered calls) is per
// instance because the copy's nodes are its own. What is keyed by offset (the
// types of bindings, literal ids, the marks on builtin calls) is per instance
// because its offsets are; an offset at or above the stride is mapped back
// before it is reported.
export const INSTANCE_STRIDE = 2 ** 28
const MAX_INSTANCES = 2 ** 24
// What one chain of instantiations may use before it is taken to be endless.
// Depth stops a generic that asks for one new instance per instance. One that
// asks for two would reach depth 64 after 2^64 instances, so their number is
// bounded too; and one that doubles its type argument would run out of memory
// writing the type down long before either, so a type argument may only be so
// much larger than what the chain started with. A call in ordinary code is
// held to none of this: its type argument is as large as the program made it.
const MAX_INSTANCE_DEPTH = 64
const MAX_CHAIN_INSTANCES = 1000
const MAX_CHAIN_KEY = 4096
const MAX_CHAIN_KEY_GROWTH = 16
// A longer key is cut and closed with a hash where it names the instance.
const MAX_NAME_KEY = 120
// How far out an error in an instance names the calls it was required from
const MAX_NOTES = 4
// A generic type that applies itself is refused where it is declared, so what
// comes this deep is honest nesting: a chain of generic types each holding
// the next. The limit is far above any written by hand and well short of
// what the stack takes.
const MAX_APPLY_DEPTH = 1000

// The type of an expression whose error is already reported. Compared by
// identity, so that what the expression is used for stays silent about it.
const RECOVERY: ResolvedType = primitive('i32')

export interface Scope {
  parent: Scope | null
  symbols: Map<string, Symbol>
}

// === Type Key Helper ===

/**
 * The key of a binding or declaration (a pattern, a field, a loop variable)
 * in the types Map: "offset:kind". Each of those has a source offset of its
 * own. Expressions don't (`a < b / c` and its `b / c` end together, `x as T`
 * starts where `x` does, and a def's value is pasted at each use with its
 * offsets unchanged), so their types are keyed by node, in exprTypes.
 */
export function typeKey(offset: number, kind: string): string {
  return `${offset}:${kind}`
}

// === Type Check Result ===

export interface TypeError {
  offset: number
  message: string
  // For an error inside an instance of a generic: the call that first asked
  // for the instance, then the call that asked for the instance that call is
  // in, and so on outwards.
  notes?: { offset: number; message: string }[]
}

// Pending literal for data section serialization (handled by codegen, not checker)
// Serialization type is in the types map at typeKey(id, 'DataTarget')
export interface PendingLiteral {
  id: number          // AST offset (also the key for DataTarget type lookup)
  expr: AST.Expr      // The literal expression (check expr.mut for mutable flag)
}

export interface TypeCheckResult {
  // Types of bindings and declarations: "offset:kind" → resolved type
  types: Map<string, ResolvedType>
  // The type of every expression, by AST node
  exprTypes: Map<AST.Expr, ResolvedType>
  // Implicit widenings: an expression whose value is used as this wider type
  // (an i32 operand of an i64 addition, an f32 argument for an f64 parameter).
  // Its entry in exprTypes stays the type it's computed in.
  coercions: Map<AST.Expr, ResolvedType>
  // The value of each constant in a global's initializer: the whole of it, or
  // one for each part of a tuple, struct or array of constants.
  constants: Map<AST.Expr, ComptimeValue>
  // Symbol table (module scope)
  symbols: Map<string, Symbol>
  // Type errors
  errors: TypeError[]
  // Warnings (non-blocking)
  warnings: TypeError[]
  // Reference tracking: definition offset → array of reference offsets
  references: Map<number, number[]>
  // Reverse lookup: usage offset → definition offset
  symbolRefs: Map<number, number>
  // Symbol name → definition offset
  symbolDefOffsets: Map<string, number>
  // Literals that need data section serialization (for codegen)
  literals: PendingLiteral[]
  // The instances of this module's generic functions, in the order they were
  // first asked for
  instances: { of: AST.FuncDecl; decl: AST.FuncDecl }[]
  // What to compile in place of a call as written: for a call of a generic,
  // the plain call of its instance; for a call of a comptime function
  // parameter, the call of the function it stands for; for a type that is
  // called (Vec(u32)(p, 0, cap), T(a, b)), the struct of its arguments; for a
  // method call x.f(a), the call f(x, a); for a call of a function that
  // shares its name, the call of the one that was meant
  calls: Map<AST.CallExpr, AST.CallExpr | AST.TupleExpr>
  // The name a function is known by, in `symbols` and in the output, where
  // that is not the name it was declared with: one that shares its name with
  // a function declared before it has a name of its own (hash:''u8).
  funcNames: Map<AST.FuncDecl | AST.ImportFunc, string>
}

// === Concretization Options ===

export interface TypecheckOptions {
  // Default concrete type for untyped integers (default: 'i32')
  defaultInt?: 'i32' | 'i64'
  // Default concrete type for untyped floats (default: 'f64')
  defaultFloat?: 'f32' | 'f64'
  // Absolute path of this module (for resolving source imports)
  filePath?: string
  // Exports from already-typechecked modules (path → symbol table)
  moduleExports?: Map<string, Map<string, Symbol>>
  // Source text (enables identifier offset resolution for hover)
  source?: string
  // Whether to typecheck test block contents (default: true)
  includeTests?: boolean
}

const DEFAULT_OPTIONS: Pick<Required<TypecheckOptions>, 'defaultInt' | 'defaultFloat'> = {
  defaultInt: 'i32',
  defaultFloat: 'f64',
}

// === Main Entry Point ===

/**
 * Type check a module and return concrete types for all AST nodes.
 * This is the single type checking phase that:
 * 1. Infers types for all expressions
 * 2. Validates type compatibility
 * 3. Concretizes comptime types to concrete runtime types
 */
export function typecheck(module: AST.Module, options?: TypecheckOptions): TypeCheckResult {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const ctx = new CheckContext()
  ctx.options = opts
  ctx.source = opts.source
  ctx.filePath = opts.filePath
  ctx.moduleExports = opts.moduleExports
  ctx.checkModule(module)

  // Concretize all comptime types to concrete types (single source of truth)
  for (const [key, type] of ctx.types) {
    ctx.types.set(key, concretizeType(type, opts))
  }
  for (const [expr, type] of ctx.exprTypes) {
    ctx.exprTypes.set(expr, concretizeType(type, opts))
  }
  // Symbols derive their types from the concretized types map
  for (const [name, sym] of ctx.moduleScope.symbols) {
    if (sym.kind === 'generic' || sym.kind === 'typefunc') continue
    // Function symbols already have correct FuncRT from resolveSignature;
    // the types map at their definition offset may hold a non-func type
    // (e.g. a return type or parameter type), so skip the map lookup.
    if (sym.kind === 'func') {
      sym.type = concretizeType(sym.type, opts) as typeof sym.type
      continue
    }
    const defOffset = ctx.symbolDefOffsets.get(name)
    if (defOffset !== undefined) {
      const fromMap = ctx.types.get(typeKey(defOffset, 'IdentPattern'))
        ?? ctx.types.get(typeKey(defOffset, 'Field'))
      if (fromMap) { sym.type = fromMap as typeof sym.type; continue }
    }
    sym.type = concretizeType(sym.type, opts) as typeof sym.type
  }
  // Warn on unused symbols (dead code)
  const exportedNames = new Set<string>()
  for (const decl of module.decls) {
    if (decl.kind === 'ExportDecl') {
      const item = decl.item
      if (item.kind === 'FuncDecl' && item.ident) exportedNames.add(ctx.funcNames.get(item) ?? item.ident)
      if (item.kind === 'GlobalDecl' && item.pattern.kind === 'IdentPattern') exportedNames.add(item.pattern.name)
      if (item.kind === 'MemoryDecl') exportedNames.add('memory')
    }
  }
  for (const [name, defOffset] of ctx.symbolDefOffsets) {
    if (exportedNames.has(name)) continue
    const refs = ctx.references.get(defOffset)
    if (refs && refs.length === 0) {
      const sym = ctx.moduleScope.symbols.get(name)
      if (sym && (sym.kind === 'func' || sym.kind === 'generic' || sym.kind === 'def' || sym.kind === 'global')) {
        ctx.warnings.push({ offset: defOffset, message: `'${declaredName(name)}' is never used` })
      }
    }
  }

  return {
    types: ctx.types,
    exprTypes: ctx.exprTypes,
    coercions: ctx.coercions,
    constants: ctx.constants,
    symbols: ctx.moduleScope.symbols,
    errors: ctx.errors,
    warnings: ctx.warnings,
    references: ctx.references,
    symbolRefs: ctx.symbolRefs,
    symbolDefOffsets: ctx.symbolDefOffsets,
    literals: ctx.pendingLiterals,
    instances: ctx.instances.map((i) => ({ of: i.of, decl: i.decl })),
    calls: ctx.calls,
    funcNames: ctx.funcNames,
  }
}

/** @deprecated Use typecheck() instead */
export const check = typecheck

function getExportedSymbols(module: AST.Module, { symbols, funcNames }: TypeCheckResult): Map<string, Symbol> {
  const exports = new Map<string, Symbol>()
  for (const decl of module.decls) {
    if (decl.kind !== 'ExportDecl') continue
    const item = decl.item
    // Where an export name is used twice, which is an error of this module,
    // the first keeps it: an importer is not told of a second mistake.
    if (exports.has(decl.name)) continue
    if (item.kind === 'FuncDecl' && item.ident) {
      const sym = symbols.get(funcNames.get(item) ?? item.ident)
      if (sym) exports.set(decl.name, sym)
    } else if (item.kind === 'GlobalDecl' && item.pattern.kind === 'IdentPattern') {
      const sym = symbols.get(item.pattern.name)
      if (sym) exports.set(decl.name, sym)
    }
  }
  return exports
}

export interface ProgramCheckResult {
  results: Map<string, TypeCheckResult>
  errors: TypeError[]
}

export function typecheckProgram(
  modules: Map<string, { module: AST.Module }>,
  entryPath: string,
  options?: TypecheckOptions,
): ProgramCheckResult {
  const results = new Map<string, TypeCheckResult>()
  const moduleExports = new Map<string, Map<string, Symbol>>()
  const allErrors: TypeError[] = []
  const visited = new Set<string>()

  function visit(path: string) {
    if (visited.has(path)) return
    visited.add(path)
    const loaded = modules.get(path)
    if (!loaded) return

    function visitImports(items: readonly { kind: string }[]) {
      for (const decl of items) {
        if (decl.kind === 'ImportDecl' && isSourceImport((decl as AST.ImportDecl).module)) {
          const depPath = resolveModulePath((decl as AST.ImportDecl).module, path)
          visit(depPath)
        } else if (options?.includeTests !== false && decl.kind === 'TestDecl') {
          visitImports((decl as AST.TestDecl).children)
        }
      }
    }
    visitImports(loaded.module.decls)

    const result = typecheck(loaded.module, { ...options, filePath: path, moduleExports })
    results.set(path, result)
    allErrors.push(...result.errors)
    moduleExports.set(path, getExportedSymbols(loaded.module, result))
  }

  visit(entryPath)
  return { results, errors: allErrors }
}

// === Concretization ===

/**
 * Concretize a single type, replacing comptime types with concrete defaults.
 */
export function concretizeType(
  t: ResolvedType,
  options: TypecheckOptions = DEFAULT_OPTIONS,
): ResolvedType {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const u = unwrap(t)

  switch (u.kind) {
    case 'comptime_int': {
      const val = u.value
      if (val >= -2147483648n && val <= 2147483647n) return primitive(opts.defaultInt)
      if (val >= 0n && val <= 4294967295n) return primitive('u32')
      if (val >= -9223372036854775808n && val <= 9223372036854775807n) return primitive('i64')
      if (val >= 0n && val <= 18446744073709551615n) return primitive('u64')
      // Auto-size to smallest power-of-two type that fits
      for (const bits of [128, 256, 512]) {
        if (val >= -(2n ** BigInt(bits - 1)) && val <= 2n ** BigInt(bits) - 1n) {
          return primitive(val < 0n ? `i${bits}` as any : `u${bits}` as any)
        }
      }
      return primitive(opts.defaultInt)
    }

    case 'comptime_float':
      return primitive(opts.defaultFloat)

    case 'comptime_list': {
      // Comptime lists become *[_]T with concretized element type (pointer to inferred-size array)
      const elemType = u.elements.length > 0
        ? concretizeType(u.elements[0], opts)
        : primitive(opts.defaultInt)
      return pointer(array(elemType, ['_']))
    }

    case 'tuple':
      return {
        ...u,
        fields: u.fields.map((f) => ({
          ...f,
          type: concretizeType(f.type, opts),
        })),
      }

    case 'slice':
      return slice(concretizeType(u.element, opts), u.mutable, u.optional)

    case 'array': {
      // Concretize element type
      const elemType = concretizeType(u.element, opts)
      // Comptime arrays [_]T stay as [_]T after concretization
      return array(elemType, u.sizes)
    }

    case 'pointer':
      return {
        ...u,
        pointee: concretizeType(u.pointee, opts),
      }

    case 'func':
      return {
        ...u,
        params: u.params.map((p) => ({
          ...p,
          type: concretizeType(p.type, opts),
        })),
        returns: u.returns.map((r) => ({
          ...r,
          type: concretizeType(r.type, opts),
        })),
      }

    case 'named':
      return {
        ...u,
        type: concretizeType(u.type, opts),
      }

    default:
      return u
  }
}

/**
 * Check if a type is fully concrete (no comptime types).
 */
export function isConcreteType(t: ResolvedType): boolean {
  const u = unwrap(t)

  switch (u.kind) {
    case 'comptime_int':
    case 'comptime_float':
    case 'comptime_list':
      return false

    case 'tuple':
      return u.fields.every((f) => isConcreteType(f.type))

    case 'array':
      return isConcreteType(u.element)

    case 'slice':
      return isConcreteType(u.element)

    case 'pointer':
      return isConcreteType(u.pointee)

    case 'func':
      return (
        u.params.every((p) => isConcreteType(p.type)) &&
        u.returns.every((r) => isConcreteType(r.type))
      )

    case 'named':
      return isConcreteType(u.type)

    default:
      return true
  }
}

// === Check Context ===

// What the checker's tables took in while an expression was only being looked
// at (see CheckContext.peek), to take it back. The tables share one journal,
// so a look is undone as a whole: a type left on a node, or a conversion, is
// something codegen would act on.
class Trial {
  private open = 0
  private undo: (() => void)[] = []

  get active(): boolean {
    return this.open > 0
  }

  note(undo: () => void): void {
    this.undo.push(undo)
  }

  begin(): number {
    this.open++
    return this.undo.length
  }

  rollback(mark: number): void {
    while (this.undo.length > mark) this.undo.pop()?.()
    this.open--
  }
}

class TrialMap<K, V> extends Map<K, V> {
  constructor(private trial: Trial) {
    super()
  }

  override set(key: K, value: V): this {
    if (this.trial.active) this.remember(key)
    return super.set(key, value)
  }

  override delete(key: K): boolean {
    if (this.trial.active) this.remember(key)
    return super.delete(key)
  }

  private remember(key: K): void {
    const had = this.has(key)
    const was = this.get(key) as V
    this.trial.note(() => {
      if (had) super.set(key, was)
      else super.delete(key)
    })
  }
}

class TrialSet<T> extends Set<T> {
  constructor(private trial: Trial) {
    super()
  }

  override add(value: T): this {
    if (this.trial.active && !this.has(value)) this.trial.note(() => super.delete(value))
    return super.add(value)
  }

  override delete(value: T): boolean {
    if (this.trial.active && this.has(value)) this.trial.note(() => super.add(value))
    return super.delete(value)
  }
}

class CheckContext {
  source?: string
  // What is recorded per offset and per node can be taken back after an
  // expression was only looked at (see peek).
  trial = new Trial()
  types = new TrialMap<string, ResolvedType>(this.trial)
  exprTypes = new TrialMap<AST.Expr, ResolvedType>(this.trial)
  coercions = new TrialMap<AST.Expr, ResolvedType>(this.trial)
  constants = new TrialMap<AST.Expr, ComptimeValue>(this.trial)
  // if and match expressions used as statements: nothing takes their value,
  // so their branches don't have to agree on a type.
  statementExprs = new TrialSet<AST.Expr>(this.trial)
  // The constant each branch of an if or match of constants is by itself.
  // The branches share one type, and each has to be a value of it.
  branchConstants = new TrialMap<AST.Expr, ResolvedType>(this.trial)
  // The patterns that have declared their local. An operand of a builtin is
  // checked again once its type is settled, statements and all: a `let` in
  // one of its branches is then the same declaration, not a second one.
  // A look (see peek) declares in a scope of its own, and is no first time.
  declared = new TrialSet<AST.Pattern>(this.trial)
  errors: TypeError[] = []
  warnings: TypeError[] = []
  moduleScope: Scope = { parent: null, symbols: new Map() }
  currentScope: Scope = this.moduleScope
  insideIfLetCondition = false
  currentReturnType: ResolvedType | null = null
  // The named results an expression body is being checked against, when
  // there are several: its value fills them in order.
  resultsInOrder: ResolvedType | null = null
  // Loops open around the statement being checked, and the depth at the
  // innermost enclosing defer (null outside one). A deferred expression can't
  // return, or break or continue a loop outside it.
  loopDepth = 0
  deferLoopDepth: number | null = null

  // Cache for resolved type aliases
  typeCache = new Map<string, ResolvedType>()

  // Track type names that are being defined (for recursive type detection)
  pendingTypeNames = new Set<string>()
  // What each `type` of the module is declared as, as written: whether a
  // name stands for a function type is asked before any type is resolved.
  typeBodies = new Map<string, AST.Type>()

  // Reference tracking
  references = new Map<number, number[]>() // defOffset → refOffsets
  symbolRefs = new Map<number, number>() // usageOffset → defOffset
  symbolDefOffsets = new Map<string, number>() // name → defOffset

  // Multi-module support
  filePath?: string
  moduleExports?: Map<string, Map<string, Symbol>>
  options: TypecheckOptions = DEFAULT_OPTIONS

  // Literals that need data section serialization (collected during checking)
  pendingLiterals: PendingLiteral[] = []

  // Generics: the instances this module owns, those whose bodies are still to
  // be checked, the one being checked, and what each call of a generic is
  // compiled as.
  instances: Instance[] = []
  instanceQueue: Instance[] = []
  currentInstance: Instance | null = null
  calls = new TrialMap<AST.CallExpr, AST.CallExpr | AST.TupleExpr>(this.trial)
  // How many literals were registered when the second pass came to each
  // generic, which is where a function written in its place would add its own
  literalSlots = new Map<AST.FuncDecl, number>()
  // Counts every report, also one that repeats an error already listed: an
  // expression can be inferred twice, and fails the second time too.
  errorsReported = 0
  // Where the parameters and locals of the instance being checked are defined
  // in the generic's source, by name. Kept apart from symbolDefOffsets, which
  // holds one definition per name for the whole module.
  instanceDefs = new Map<string, number>()
  // Functions and imports declared inside test blocks. They are registered in
  // module scope, and exist in test builds only.
  testOnly = new Set<string>()
  // The same by symbol: a test's function that takes the name of one of the
  // module's replaces it in module scope, and its name is then no new name.
  testDeclared = new Set<Symbol>()
  // Names of generics that a later declaration tried to take
  contested = new Set<string>()
  // The module's generic types, in the order they are declared, and how deep
  // in applications of them a type is being resolved
  typeFuncs: (Symbol & { kind: 'typefunc' })[] = []
  applyDepth = 0
  // Set where that depth ran out, until the application that began it reports it
  applyTooDeep = false
  // What an inferred call found for its type parameters, or null when it
  // failed. A call nested in another's deciding argument is come to twice, and
  // without this each level of nesting would double the work.
  inferred = new Map<AST.CallExpr, Map<string, ResolvedType> | null>()
  // Functions that share a name. The first one declared is known by the name
  // itself and each later one by a name of its own, made of the name and its
  // parameter types (hash:''u8). `overloads` gives the names a shared name
  // stands for, in the order they were declared.
  overloads = new Map<string, string[]>()
  funcNames = new Map<AST.FuncDecl | AST.ImportFunc, string>()
  // The declarations refused for repeating a function of their name
  repeated = new Set<AST.FuncDecl | AST.ImportFunc>()
  // Where a function imported from another source module comes from, by the
  // name it is known by here (see declareFunc)
  origins = new Map<string, string>()
  // What a call was found to mean, for the same reason `inferred` is kept:
  // which function of a shared name (null when none), and for x.f(a) the
  // call f(x, a) it stands for, or that f is a member of x, or that it failed.
  picked = new Map<AST.CallExpr, string | null>()
  methodCalls = new Map<AST.CallExpr, AST.CallExpr | 'member' | 'failed'>()
  // What a look need not walk again (see inferCall): the type of a call of a
  // function that was checked without an error, the type a call was given
  // when it had one, and the calls that had one while errors were not being
  // reported.
  settled = new Map<AST.CallExpr, ResolvedType>()
  failed = new Map<AST.CallExpr, ResolvedType>()
  // The receiver of each call that was written x.f(a), by the call f(x, a)
  // it stands for: what is said of that call is said of it as it was written.
  receivers = new Map<AST.CallExpr, AST.Expr>()
  refused = new Set<AST.CallExpr>()
  // The scopes that hold what a look at an expression declares (see untraced)
  lookScopes = new WeakSet<Scope>()
  // How many attempts are open (see attempt)
  attempting = 0

  addLiteral(id: number, expr: AST.Expr, serializationType: ArrayRT): void {
    this.types.set(typeKey(id, 'DataTarget'), serializationType)
    this.pendingLiterals.push({ id, expr })
  }

  // Strings whose value was inferred with no type to meet (`let s = "ab"`,
  // the source of `buf[0..2] = "ab"`, a branch of an untyped `if`): a string
  // is always in memory, so each is laid out as its own bytes at the end of
  // the function or declaration it is in, unless something laid it out in
  // the meantime: a type it met, or a literal it is part of.
  unplaced: AST.LiteralExpr[] = []

  private placeInferredStrings(): void {
    if (this.unplaced.length === 0) return
    const parts = new Set<AST.Expr>()
    for (const { expr } of this.pendingLiterals) literalParts(expr, parts)
    for (const lit of this.unplaced) {
      if (lit.dataId !== undefined || parts.has(lit) || lit.value.kind !== 'string') continue
      lit.dataId = lit.span.start
      this.addLiteral(lit.span.start, lit, array(primitive('u8'), [lit.value.bytes.length]))
    }
    this.unplaced = []
  }

  checkModule(module: AST.Module): void {
    // Pre-pass: register all type names (to allow forward references)
    for (const decl of module.decls) {
      this.preRegisterTypes(decl)
    }
    this.checkTypeFuncs()

    // First pass: collect all type aliases, function signatures, globals, defs
    for (const decl of module.decls) {
      this.collectDeclaration(decl)
    }

    this.placeInferredStrings()

    // Resolve any forward references in the type cache
    this.resolveForwardRefs()
    this.checkOverloads()
    this.checkExportNames(module)

    // Second pass: check function bodies and expressions
    for (const decl of module.decls) {
      this.checkDeclaration(decl)
    }

    // The bodies of the instances the module asked for, and of those they ask for
    this.drainInstances()
    this.placeInferredStrings()
    this.placeInstanceLiterals()
  }

  // Pre-register type names so they can be referenced before their full definition
  preRegisterTypes(decl: AST.Declaration): void {
    if (decl.kind === 'TypeDecl') {
      this.pendingTypeNames.add(decl.ident.name)
      if (!this.typeBodies.has(decl.ident.name)) this.typeBodies.set(decl.ident.name, decl.type)
    }
    // A generic type needs nothing resolved to be declared, so every
    // signature of the module can apply it, wherever it stands.
    const item = decl.kind === 'ExportDecl' ? decl.item : decl
    if (item.kind === 'TypeFuncDecl') this.collectTypeFunc(item)
  }

  // === First Pass: Collect Declarations ===

  collectDeclaration(decl: AST.Declaration): void {
    switch (decl.kind) {
      case 'ImportDecl':
        this.collectImport(decl)
        break
      case 'ExportDecl':
        this.collectExport(decl)
        break
      case 'FuncDecl':
        this.collectFunc(decl)
        break
      case 'TypeFuncDecl':
        // Registered with the type names, before anything is resolved
        break
      case 'TypeDecl':
        this.collectTypeDecl(decl)
        break
      case 'DataDecl':
        this.collectData(decl)
        break
      case 'DefDecl':
        this.collectDef(decl)
        break
      case 'GlobalDecl':
        this.collectGlobal(decl)
        break
      case 'MemoryDecl':
        break
      case 'TestDecl':
        break
    }
  }

  collectImport(decl: AST.ImportDecl, inTest = false): void {
    const isSource = isSourceImport(decl.module)
    let depExports: Map<string, Symbol> | undefined
    if (isSource && this.filePath && this.moduleExports) {
      const depPath = resolveModulePath(decl.module, this.filePath)
      depExports = this.moduleExports.get(depPath)
      if (!depExports) {
        this.errors.push({ offset: decl.span.start, message: `Module not found: ${decl.module}` })
        return
      }
    }

    for (const item of decl.items) {
      switch (item.item.kind) {
        case 'ImportFunc': {
          const name = item.item.ident ?? item.name
          if (this.takenByGeneric(name, item.span.start)) break
          if (isGenericSignature(item.item.signature)) {
            this.error(item.span.start, isSource ? `generic functions cannot be imported yet` : `a host import cannot have comptime parameters`)
            break
          }
          if (isSource && depExports) {
            const exported = depExports.get(item.name)
            if (!exported) {
              this.errors.push({ offset: item.span.start, message: `'${item.name}' is not exported from '${decl.module}'` })
              break
            }
            if (exported.kind === 'generic') {
              this.error(item.span.start, `generic functions cannot be imported yet`)
              break
            }
            if (exported.kind !== 'func') {
              this.errors.push({ offset: item.span.start, message: `'${item.name}' in '${decl.module}' is not a function` })
              break
            }
            this.declareFunc(item.item, name, { kind: 'func', type: exported.type, inline: exported.inline }, inTest, `${decl.module}:${item.name}`)
          } else {
            const sig = this.resolveSignature(item.item.signature)
            this.declareFunc(item.item, name, { kind: 'func', type: sig, inline: false }, inTest, isSource ? `${decl.module}:${item.name}` : undefined)
          }
          break
        }
        case 'ImportGlobal': {
          if (this.takenByGeneric(item.item.ident, item.span.start)) break
          if (isSource && depExports) {
            const exported = depExports.get(item.name)
            if (!exported) {
              this.errors.push({ offset: item.span.start, message: `'${item.name}' is not exported from '${decl.module}'` })
              break
            }
            if (exported.kind !== 'global') {
              this.errors.push({ offset: item.span.start, message: `'${item.name}' in '${decl.module}' is not a global` })
              break
            }
            this.moduleScope.symbols.set(item.item.ident, { kind: 'global', type: exported.type })
          } else {
            const type = this.resolveType(item.item.type)
            this.moduleScope.symbols.set(item.item.ident, { kind: 'global', type })
          }
          break
        }
      }
    }
  }

  collectExport(decl: AST.ExportDecl): void {
    // The exported item will be collected when we process it
    switch (decl.item.kind) {
      case 'FuncDecl':
        this.collectFunc(decl.item)
        break
      case 'GlobalDecl':
        this.collectGlobal(decl.item)
        break
      case 'MemoryDecl':
      case 'TypeFuncDecl':
        // Nothing to collect: a generic type is registered with the type names
        break
    }
  }

  // A generic function's name is unique in its module: a declaration that
  // would take the name over is an error and is left out. (Functions that are
  // not generic share a name, see declareFunc; other declarations of one name
  // replace each other silently, as they always have.)
  private takenByGeneric(name: string, offset: number): boolean {
    if (this.moduleScope.symbols.get(name)?.kind !== 'generic') return false
    this.error(offset, `'${name}' is already declared: a generic function's name is unique in its module`)
    this.contested.add(name)
    return true
  }

  collectFunc(decl: AST.FuncDecl, inTest = false): void {
    if (isGenericDecl(decl)) {
      this.collectGeneric(decl)
      return
    }
    if (!decl.ident) return // Anonymous function
    if (this.takenByGeneric(decl.ident, decl.span.start)) return
    const sig = this.resolveSignature(decl.signature)
    this.declareFunc(decl, decl.ident, { kind: 'func', type: sig, inline: decl.inline }, inTest)
  }

  // Enters a function of the module, declared or imported, under its name.
  // Where a function of that name is there already and the two differ in
  // their parameter types, they share the name: the new one is known by a
  // name of its own, and a call says which is meant by its arguments. A
  // function a test declares replaces the module's of that name, as any
  // declaration replaces what is not a function.
  // `origin`: for a function imported from another source module, the module
  // and the name it is exported under. Importing one function twice is no
  // second function: the import is the same one again, as it always was.
  private declareFunc(decl: AST.FuncDecl | AST.ImportFunc, name: string, sym: Symbol & { kind: 'func' }, inTest: boolean, origin?: string): void {
    if (inTest && this.sharedByModule(name, decl.span.start)) {
      // Its own test goes on calling it by the name, and says nothing more.
      this.currentScope.symbols.set(name, sym)
      return
    }
    let known = name
    if (!inTest && this.moduleScope.symbols.get(name)?.kind === 'func') {
      const members = this.overloads.get(name) ?? [name]
      const again = origin === undefined ? undefined : members.find((m) => this.origins.get(m) === origin)
      if (again !== undefined) {
        if (again !== name) this.funcNames.set(decl, again)
        this.moduleScope.symbols.set(again, sym)
        this.recordDefinition(again, decl.span.start)
        return
      }
      const key = paramsKey(sym.type)
      const same = members.flatMap((m) => this.funcType(m) ?? []).find((type) => paramsKey(type) === key)
      if (same) {
        this.error(decl.span.start, `'${name}' is already declared with parameters (${paramsText(same)})`)
        this.repeated.add(decl)
        return
      }
      known = keyedName(`${name}:`, key, '', (taken) => this.moduleScope.symbols.has(taken))
      this.overloads.set(name, [...members, known])
      this.funcNames.set(decl, known)
    }
    if (origin !== undefined && !inTest) this.origins.set(known, origin)
    this.moduleScope.symbols.set(known, sym)
    // Record definition at function name offset (need to find it in span)
    // FuncDecl span starts at 'func' keyword, ident follows
    this.recordDefinition(known, decl.span.start)
  }

  // A test's function takes over the name of the module's function, for the
  // module's code as well. Where several functions share the name there is
  // no one function to stand in for: the module's own calls, and those of
  // its instances, would choose among other functions in a test build than
  // in the build that ships. Reports that, and says whether it did.
  private sharedByModule(name: string, offset: number): boolean {
    if (!this.shared(name)) return false
    this.error(offset, `'${name}' is the name of several functions of the module: a function declared in a test cannot take it over`)
    return true
  }

  // The type of the function known by this name. Undefined where a global, a
  // def or a data declaration of the name came after and replaced it.
  private funcType(known: string): FuncRT | undefined {
    const sym = this.moduleScope.symbols.get(known)
    return sym?.kind === 'func' ? sym.type : undefined
  }

  // A parameter type that names a type declared further down is known only
  // now: two functions of one name that were told apart by it may turn out to
  // take the same types.
  private checkOverloads(): void {
    for (const [name, members] of this.overloads) {
      const seen = new Map<string, FuncRT>()
      const distinct = members.filter((member) => {
        const type = this.funcType(member)
        if (!type) return false
        const key = paramsKey(type)
        const same = seen.get(key)
        if (!same) {
          seen.set(key, type)
          return true
        }
        this.error(this.symbolDefOffsets.get(member) ?? 0, `'${name}' is already declared with parameters (${paramsText(same)})`)
        for (const [decl, known] of this.funcNames) if (known === member) this.repeated.add(decl)
        return false
      })
      this.overloads.set(name, distinct)
    }
  }

  // Two exports of one name would be one name for two things, in the module
  // the host sees and for a module that imports by it.
  private checkExportNames(module: AST.Module): void {
    const used = new Set<string>()
    // Of several memory declarations the first is the module's memory.
    const memory = module.decls.find((d) => d.kind === 'MemoryDecl' || (d.kind === 'ExportDecl' && d.item.kind === 'MemoryDecl'))
    for (const decl of module.decls) {
      if (decl.kind !== 'ExportDecl') continue
      const item = decl.item
      // A generic's export emits nothing, and its name is unique already.
      if (item.kind === 'TypeFuncDecl' || (item.kind === 'FuncDecl' && isGenericDecl(item))) continue
      if (item.kind === 'MemoryDecl' && decl !== memory) continue
      // A declaration that repeats another is that error, and no export.
      if (item.kind === 'FuncDecl' && this.repeated.has(item)) continue
      if (!used.has(decl.name)) {
        used.add(decl.name)
        continue
      }
      let example = `export "${decl.name}_2" memory`
      if (item.kind === 'FuncDecl') {
        const first = item.signature.input.kind === 'CompositeType' ? item.signature.input.fields[0]?.type : undefined
        const hint = first?.kind === 'PrimitiveType' ? first.name : '2'
        example = `export "${decl.name}_${hint}" func ${item.ident ?? ''}(...)`
      } else if (item.kind === 'GlobalDecl') {
        example = `export "${decl.name}_2" global ${item.pattern.kind === 'IdentPattern' ? item.pattern.name : '...'}`
      }
      this.error(decl.span.start, `export name '${decl.name}' is used twice: give one an explicit name, as in ${example}`)
    }
  }

  collectTypeDecl(decl: AST.TypeDecl): void {
    const name = decl.ident.name
    if (this.moduleScope.symbols.get(name)?.kind === 'typefunc') {
      this.error(decl.span.start, `'${name}' is already declared: a generic type's name is unique in its module`)
      this.pendingTypeNames.delete(name)
      return
    }
    // Types with @ prefix are unique/nominal, others are structural aliases
    const unique = name.startsWith('@')
    const resolved = this.resolveType(decl.type)
    this.moduleScope.symbols.set(name, { kind: 'type', type: resolved, unique })
    this.typeCache.set(name, resolved)
    this.recordDefinition(name, decl.ident.span.start)
    // Remove from pending since it's now defined
    this.pendingTypeNames.delete(name)
  }

  // Resolve forward references in all collected types
  resolveForwardRefs(): void {
    // First pass: resolve type aliases
    for (const [name, sym] of this.moduleScope.symbols) {
      if (sym.kind === 'type') {
        const resolved = this.resolveForwardRefsInType(sym.type)
        this.moduleScope.symbols.set(name, { ...sym, type: resolved })
        this.typeCache.set(name, resolved)
      }
    }
    // Second pass: resolve forward refs in all other symbols (funcs, globals, etc.)
    for (const [, sym] of this.moduleScope.symbols) {
      if (sym.kind !== 'type' && sym.kind !== 'generic' && sym.kind !== 'typefunc') {
        sym.type = this.resolveForwardRefsInType(sym.type) as typeof sym.type
      }
    }
  }

  // Recursively replace forward references with actual types
  resolveForwardRefsInType(t: ResolvedType): ResolvedType {
    switch (t.kind) {
      case 'forward_ref': {
        const sym = this.moduleScope.symbols.get(t.name)
        if (sym && sym.kind === 'type') {
          // Return a named reference to the type (don't inline to avoid infinite recursion)
          return named(t.name, sym.type)
        }
        this.error(0, `unresolved forward reference to type '${t.name}' — is it defined in this module?`)
        return primitive('i32')
      }

      case 'pointer':
        return pointer(this.resolveForwardRefsInType(t.pointee), t.boundary, t.mutable, t.optional)

      case 'array':
        return array(this.resolveForwardRefsInType(t.element), t.sizes)

      case 'slice':
        return slice(this.resolveForwardRefsInType(t.element), t.mutable, t.optional)

      case 'tuple':
        return tuple(t.fields.map(f => field(f.name, this.resolveForwardRefsInType(f.type))))

      case 'func':
        return func(
          t.params.map(p => field(p.name, this.resolveForwardRefsInType(p.type))),
          t.returns.map(r => field(r.name, this.resolveForwardRefsInType(r.type)))
        )

      case 'named':
        return named(t.name, this.resolveForwardRefsInType(t.type))

      default:
        // Primitives, void, comptime types don't contain nested types
        return t
    }
  }

  collectDef(decl: AST.DefDecl): void {
    if (this.currentScope === this.moduleScope && this.takenByGeneric(decl.ident, decl.span.start)) return
    // Defs are comptime - infer type from literal value or use LHS type annotation
    const inferredType = this.inferExpr(decl.value)

    // If LHS type annotation is provided, use it; otherwise use inferred type
    const declaredType = decl.type ? this.resolveType(decl.type) : null

    // Use span-based key for defs inside test blocks to avoid name collisions
    const defKey = this.currentScope === this.moduleScope
      ? decl.ident
      : `${decl.ident}$${decl.span.start}`

    // def is pure substitution — reject data literals that need memory
    if (this.isDataLiteralExpr(decl.value.kind === 'AnnotationExpr' ? decl.value.expr : decl.value)) {
      this.error(decl.span.start, `def cannot contain array/string literals — use 'data ${decl.ident} = ...' instead`)
    }

    // Regular comptime value (int, float, bool)
    const type = declaredType ?? inferredType
    const value = this.evalComptimeExpr(decl.value)
    const sym = value
      ? { kind: 'def' as const, type, value }
      : { kind: 'def' as const, type, value: { kind: 'int' as const, value: 0n } }
    if (!value) {
      this.error(decl.span.start, `def value must be a compile-time constant`)
    }
    this.moduleScope.symbols.set(defKey, sym)
    this.currentScope.symbols.set(decl.ident, sym)
    const defIdentOff = this.findIdentOffset(decl.span.start, 'def')
    if (defIdentOff !== null) this.types.set(typeKey(defIdentOff, 'IdentPattern'), type)
    this.recordDefinition(decl.ident, decl.span.start)
  }

  collectData(decl: AST.DataDecl): void {
    if (this.currentScope === this.moduleScope && this.takenByGeneric(decl.ident, decl.span.start)) return
    const inferredType = this.inferExpr(decl.value)
    const declaredType = decl.type ? this.resolveType(decl.type) : null

    // Use span-based key for data inside test blocks to avoid name collisions
    const dataKey = this.currentScope === this.moduleScope
      ? decl.ident
      : `${decl.ident}$${decl.span.start}`

    // (x) is x: the literal laid out is the one inside the parentheses.
    const value = ungrouped(decl.value)

    // A (ptr, len) pair is a slice already: there is no literal to lay out,
    // and so nothing for the name to point at.
    const literal = value.kind === 'AnnotationExpr' ? ungrouped(value.expr) : value
    const literalType = declaredType ?? (value.kind === 'AnnotationExpr' ? inferredType : null)
    if (literal.kind === 'TupleExpr' && literal.elements.length === 2 && literalType && unwrap(literalType).kind === 'slice') {
      this.error(decl.span.start, `data value must be a literal to lay out: a (ptr, len) pair is a slice already`)
      return
    }

    // Check if literal has mut flag
    const isMut = this.exprHasMut(value)
    const dataIdentOff = this.findIdentOffset(decl.span.start, 'data')

    // data ALWAYS produces a pointer. Reuse extractDataLiteral to get the array type.
    const dataLiteral = this.extractDataLiteral(value, inferredType, declaredType)
    if (dataLiteral) {
      // Determine the pointer type with mutability
      let ptrType = dataLiteral.ptrType
      if (isMut && ptrType.kind === 'pointer') {
        ptrType = pointer(ptrType.pointee, ptrType.boundary, true)
      } else if (isMut && ptrType.kind === 'slice') {
        ptrType = slice(ptrType.element, true)
      }
      // Use checkExpr to propagate element types and register the data literal
      // checkExpr's data literal path handles pendingLiterals, dataId, and element checking
      if (ptrType.kind === 'pointer' || ptrType.kind === 'slice') {
        this.checkExpr(dataLiteral.expr, ptrType)
      } else {
        // Rare case: bare array type — register manually
        const dataId = dataLiteral.expr.span.start
        if (dataLiteral.expr.kind === 'ArrayExpr' || dataLiteral.expr.kind === 'RepeatExpr' ||
            dataLiteral.expr.kind === 'LiteralExpr') {
          (dataLiteral.expr as AST.ArrayExpr | AST.RepeatExpr | AST.LiteralExpr).dataId = dataId
        }
        this.addLiteral(dataId, dataLiteral.expr, dataLiteral.indexedType)
      }
      const dataId = dataLiteral.expr.span.start
      const sym = {
        kind: 'def' as const,
        type: ptrType,
        value: { kind: 'data_ptr' as const, id: dataId },
      }
      this.moduleScope.symbols.set(dataKey, sym)
      this.currentScope.symbols.set(decl.ident, sym)
      if (dataIdentOff !== null) this.types.set(typeKey(dataIdentOff, 'IdentPattern'), ptrType)
      this.recordDefinition(decl.ident, decl.span.start)
      return
    }

    // For non-array data (scalars, tuples), still serialize to data section
    const type = declaredType ?? this.concretize(inferredType)
    const expr = value.kind === 'AnnotationExpr' ? ungrouped(value.expr) : value
    const dataId = expr.span.start
    if (expr.kind === 'LiteralExpr' || expr.kind === 'TupleExpr') {
      if (expr.kind === 'LiteralExpr') {
        (expr as AST.LiteralExpr).dataId = dataId
      }
      const arrType: ArrayRT = { kind: 'array', element: type, sizes: [1] }
      this.addLiteral(dataId, expr, arrType)
      const sym = {
        kind: 'def' as const,
        type: pointer(type, false, isMut),
        value: { kind: 'data_ptr' as const, id: dataId },
      }
      this.moduleScope.symbols.set(dataKey, sym)
      this.currentScope.symbols.set(decl.ident, sym)
      if (dataIdentOff !== null) this.types.set(typeKey(dataIdentOff, 'IdentPattern'), pointer(type, false, isMut))
      this.recordDefinition(decl.ident, decl.span.start)
      return
    }

    this.error(decl.span.start, `data value must be a literal (array, string, tuple, or scalar)`)
  }

  // Extract a data section literal from an expression if applicable
  // Returns the literal expression, its array type, and the pointer type
  private extractDataLiteral(
    expr: AST.Expr,
    inferredType: ResolvedType,
    declaredType: ResolvedType | null = null
  ): {
    expr: AST.Expr
    indexedType: ArrayRT
    ptrType: ResolvedType
  } | null {
    // Handle annotation on RHS: [0;12]:*[_]u32 or [1,2,3]:[]u8
    if (expr.kind === 'AnnotationExpr') {
      const innerExpr = ungrouped(expr.expr)
      if (this.isDataLiteralExpr(innerExpr)) {
        if (inferredType.kind === 'pointer' && inferredType.pointee.kind === 'array') {
          return { expr: innerExpr, indexedType: inferredType.pointee, ptrType: inferredType }
        }
        if (inferredType.kind === 'slice') {
          const litSize = this.getLiteralSize(innerExpr)
          if (typeof litSize === 'number') {
            const arrType = array(inferredType.element, [litSize])
            return { expr: innerExpr, indexedType: arrType, ptrType: pointer(arrType) }
          }
        }
        if (inferredType.kind === 'array') {
          return { expr: innerExpr, indexedType: inferredType, ptrType: pointer(inferredType) }
        }
      }
    }

    // Handle type annotation on LHS: def x:*[_]u32 = [0;12]
    // The expr is a bare literal and declaredType is the pointer type
    if (declaredType && this.isDataLiteralExpr(expr)) {
      // Handle explicit pointer type *[_]u32
      if (declaredType.kind === 'pointer' && declaredType.pointee.kind === 'array') {
        let sizes = declaredType.pointee.sizes
        // If sizes includes '_' (inferred), fill it in from literal
        if (sizes && sizes.includes('_')) {
          const literalSize = this.getLiteralSize(expr)
          if (typeof literalSize === 'number') {
            sizes = sizes.map(s => s === '_' ? literalSize : s)
          }
        }
        const arrayType: ArrayRT = {
          ...declaredType.pointee,
          sizes,
        }
        return {
          expr,
          indexedType: arrayType,
          ptrType: declaredType,
        }
      }
      // Handle array type [N]T - reserves memory, type stays as array
      if (declaredType.kind === 'array') {
        let sizes = declaredType.sizes
        if (sizes && sizes.includes('_')) {
          const literalSize = this.getLiteralSize(expr)
          if (typeof literalSize === 'number') {
            sizes = sizes.map(s => s === '_' ? literalSize : s)
          }
        }
        const arrayType: ArrayRT = { ...declaredType, sizes }
        return {
          expr,
          indexedType: arrayType,
          ptrType: arrayType,
        }
      }
      // Handle slice type []T - array literal coerces to slice
      if (declaredType.kind === 'slice') {
        const literalSize = this.getLiteralSize(expr)
        const sizes: ArraySize[] = typeof literalSize === 'number' ? [literalSize] : ['_']
        const arrayType: ArrayRT = {
          kind: 'array',
          element: declaredType.element,
          sizes,
        }
        return {
          expr,
          indexedType: arrayType,
          ptrType: declaredType,  // slice type
        }
      }
    }

    // Handle bare data literals without type annotation: def x = [0;12] or def x = [0:u32;12]
    // These become pointers to array types: *[N]T
    if (!declaredType && this.isDataLiteralExpr(expr)) {
      // Handle when inferred type is already a pointer (from inferRepeat/array())
      if (inferredType.kind === 'pointer' && inferredType.pointee.kind === 'array') {
        const arrayType = inferredType.pointee
        // Get concrete size from literal if inferred
        let sizes = arrayType.sizes
        if (sizes && sizes.includes('_')) {
          const literalSize = this.getLiteralSize(expr)
          if (typeof literalSize === 'number') {
            sizes = sizes.map(s => s === '_' ? literalSize : s)
          }
        }
        const concreteArray: ArrayRT = {
          ...arrayType,
          sizes,
        }
        return {
          expr,
          indexedType: concreteArray,
          ptrType: pointer(concreteArray),
        }
      }

      // Handle when inferred type is comptime_array (from inferRepeat)
      if (inferredType.kind === 'comptime_array') {
        const arrayType: ArrayRT = {
          kind: 'array',
          element: inferredType.element,
          sizes: [inferredType.count],
        }
        return {
          expr,
          indexedType: arrayType,
          ptrType: pointer(arrayType),
        }
      }

      // Handle when inferred type is array (from inferArray/comptimeArray)
      if (inferredType.kind === 'array') {
        // Get concrete size from literal if inferred
        let sizes = inferredType.sizes
        if (sizes && sizes.includes('_')) {
          const literalSize = this.getLiteralSize(expr)
          if (typeof literalSize === 'number') {
            sizes = sizes.map(s => s === '_' ? literalSize : s)
          }
        }
        const arrayType: ArrayRT = {
          kind: 'array',
          element: inferredType.element,
          sizes,
        }
        return {
          expr,
          indexedType: arrayType,
          ptrType: pointer(arrayType),
        }
      }
    }

    return null
  }

  // Check that an assignment target is mutable (for pointer writes)
  // Mutability is fine-grained: writing through a const outer pointer is OK
  // if the inner type at the write point is mutable.
  private checkMutability(target: AST.LValue, offset: number): void {
    // Find the deepest pointer/slice in the lvalue chain and check its mutability
    const writeType = this.findWritePointerType(target)
    if (writeType) {
      const u = unwrap(writeType)
      if (u.kind === 'pointer' && !u.mutable) {
        this.error(offset, `cannot write through const pointer — use *mut for mutable access`)
      }
      if (u.kind === 'slice' && !u.mutable) {
        this.error(offset, `cannot write through const slice — use []mut for mutable access`)
      }
    }
  }

  // Walk an lvalue to find the pointer/slice type that gates the write.
  // For `arr[i] = x`, it's arr's type.
  // For `arr[i].field = x`, it's the element type of arr (the inner pointer/slice).
  // For `p.* = x`, it's p's type.
  private findWritePointerType(target: AST.LValue | AST.Expr): ResolvedType | null {
    // Parentheses: (p.*).x = v
    if (target.kind === 'GroupExpr') return this.findWritePointerType(target.expr)
    if (target.kind === 'TupleExpr' && target.elements.length === 1 && target.elements[0].value) {
      return this.findWritePointerType(target.elements[0].value)
    }
    // Direct index: arr[i] = x — the write goes through arr's pointer
    if (target.kind === 'IndexExpr') {
      const objType = this.inferExpr(target.object)
      // An element of a fixed array is part of whatever holds the array.
      const u = unwrap(objType)
      if (u.kind === 'array' && isValueArray(u)) return this.findWritePointerType(target.object)
      return objType
    }
    // Deref: p.* = x — the write goes through p
    if (target.kind === 'MemberExpr' && target.member.kind === 'deref') {
      return this.inferExpr(target.object)
    }
    // Type pun: p.u32 = x — the write goes through p
    if (target.kind === 'MemberExpr' && target.member.kind === 'type') {
      return this.inferExpr(target.object)
    }
    // Field access: obj.field = x — modifying a field of the element struct
    // requires the container holding that struct to be mutable.
    // arr[i].field = x → check arr's mutability (we're modifying arr's element)
    // BUT: arr[i].field[j] = x → check field's type mutability (writing through a pointer in the field)
    // p.field = x with p a pointer to a struct writes through p. A field of a
    // struct that is itself a field (arr[i].b.c = x) goes through whatever
    // holds the outermost struct; one in a variable needs no pointer at all.
    if (target.kind === 'MemberExpr' && (target.member.kind === 'field' || target.member.kind === 'index')) {
      const objType = this.inferExpr(target.object)
      if (unwrap(objType).kind === 'pointer') return objType
      return this.findWritePointerType(target.object)
    }
    return null
  }


  // Check if an expression (or its inner literal) has the mut flag
  private exprHasMut(expr: AST.Expr): boolean {
    if (expr.kind === 'AnnotationExpr') return this.exprHasMut(expr.expr)
    if (expr.kind === 'ArrayExpr' || expr.kind === 'RepeatExpr' ||
        expr.kind === 'LiteralExpr' || expr.kind === 'TupleExpr') {
      return !!(expr as { mut?: boolean }).mut
    }
    return false
  }

  // Validate data literal byte values against a ranged element type
  // For string/hex literals in data contexts where the element has a max bound
  private validateDataLiteralRange(expr: AST.Expr, innerType: ResolvedType): void {
    // Unwrap array to get the element type (e.g., [16]u8#16 → u8#16)
    let elemType = innerType
    while (elemType.kind === 'array') elemType = elemType.element
    if (elemType.kind !== 'primitive' || elemType.max === undefined) return
    const max = elemType.max
    if (expr.kind === 'LiteralExpr' && expr.value.kind === 'string') {
      for (let i = 0; i < expr.value.bytes.length; i++) {
        if (expr.value.bytes[i] >= max) {
          this.error(expr.span.start, `byte ${i} value 0x${expr.value.bytes[i].toString(16)} exceeds ${typeToString(elemType)} range`)
          return
        }
      }
    }
    if (expr.kind === 'ArrayExpr') {
      for (const elem of expr.elements) {
        this.validateDataLiteralRange(elem, innerType)
      }
    }
  }

  // Check if an expression is a data literal (array, repeat, string, tuple)
  private isDataLiteralExpr(expr: AST.Expr): boolean {
    return expr.kind === 'ArrayExpr' ||
           expr.kind === 'RepeatExpr' ||
           expr.kind === 'TupleExpr' ||
           (expr.kind === 'LiteralExpr' && expr.value.kind === 'string')
  }

  // Get the size of a literal expression (for inferring array/pointer sizes)
  private getLiteralSize(expr: AST.Expr): number | 'inferred' {
    if (expr.kind === 'RepeatExpr') {
      // [value; count] - get count from the literal
      if (expr.count.kind === 'LiteralExpr' && expr.count.value.kind === 'int') {
        return Number(expr.count.value.value)
      }
    }
    if (expr.kind === 'ArrayExpr') {
      // [a, b, c] - count elements
      return expr.elements.length
    }
    if (expr.kind === 'LiteralExpr' && expr.value.kind === 'string') {
      // String literal - length of bytes
      return expr.value.bytes.length
    }
    return 'inferred'
  }

  // Evaluate a compile-time constant expression. `typed` is for a global's
  // initializer, which has to start as the value its expression has at run
  // time: each value is held in the type the checker gave its expression, so
  // arithmetic wraps, divides and shifts as that type does (`7 / 2` is 3.5
  // as an f64), and a cast of a constant is a constant too.
  evalComptimeExpr(expr: AST.Expr, typed = false): ComptimeValue | null {
    const value = this.comptimeValue(expr, typed)
    const type = typed ? this.exprTypes.get(expr) : undefined
    if (!value || !type) return value
    const held = constantIn(value, type)
    // A quotient that doesn't fit is the least value by -1, which traps.
    const overflows = held.kind === 'int' && value.kind === 'int' && held.value !== value.value
    return overflows && expr.kind === 'BinaryExpr' && expr.op === '/' ? null : held
  }

  // The value a constant has in the type it has been given: the one the
  // program computes. The bare value of a bit pattern (~0 as a u32) is
  // negative, and would pass for small where a length or a bound is checked.
  private constantInType(expr: AST.Expr): ComptimeValue | null {
    const value = this.evalComptimeExpr(expr)
    const type = this.exprTypes.get(expr)
    return value?.kind === 'int' && type ? constantIn(value, type) : value
  }

  private comptimeValue(expr: AST.Expr, typed: boolean): ComptimeValue | null {
    // Handle annotation expression (e.g., 42:u32)
    if (expr.kind === 'AnnotationExpr') {
      return this.evalComptimeExpr(expr.expr, typed)
    }

    // Handle literal expression
    if (expr.kind === 'LiteralExpr') {
      const lit = expr.value
      if (lit.kind === 'int') {
        return { kind: 'int', value: lit.value }
      }
      if (lit.kind === 'float') {
        return { kind: 'float', value: lit.value }
      }
      if (lit.kind === 'bool') {
        return { kind: 'bool', value: lit.value }
      }
    }

    // Handle group expression
    const grouped = groupedExpr(expr)
    if (grouped) {
      return this.evalComptimeExpr(grouped, typed)
    }

    // Handle unary negation
    if (expr.kind === 'UnaryExpr' && expr.op === '-') {
      const operand = this.evalComptimeExpr(expr.operand, typed)
      if (operand?.kind === 'int') {
        return { kind: 'int', value: -operand.value }
      }
      if (operand?.kind === 'float') {
        return { kind: 'float', value: -operand.value }
      }
    }

    // Handle bitwise complement
    if (expr.kind === 'UnaryExpr' && expr.op === '~') {
      const operand = this.evalComptimeExpr(expr.operand, typed)
      if (operand?.kind === 'int') {
        return { kind: 'int', value: ~operand.value }
      }
    }

    // Handle binary operations on comptime values
    if (expr.kind === 'BinaryExpr') {
      const left = this.evalComptimeExpr(expr.left, typed)
      const right = this.evalComptimeExpr(expr.right, typed)
      if (left?.kind === 'int' && right?.kind === 'int') {
        const l = left.value
        const r = right.value
        // A sum or a product comes out the same whether its operands have
        // wrapped or not; a quotient, a remainder or a right shift doesn't.
        // They take each operand as its type holds it, once it has one:
        // (0 - 1) / 4 as a u32 divides 4294967295, as the program will.
        const held = (operand: AST.Expr, value: bigint): bigint => {
          const type = this.exprTypes.get(operand)
          const constant = type ? constantIn({ kind: 'int', value }, type) : null
          return constant?.kind === 'int' ? constant.value : value
        }
        const divisor = held(expr.right, r)
        switch (expr.op) {
          case '+': return { kind: 'int', value: l + r }
          case '-': return { kind: 'int', value: l - r }
          case '*': return { kind: 'int', value: l * r }
          case '/': return divisor !== 0n ? { kind: 'int', value: held(expr.left, l) / divisor } : null
          case '%': return divisor !== 0n ? { kind: 'int', value: held(expr.left, l) % divisor } : null
          case '&': return { kind: 'int', value: l & r }
          case '|': return { kind: 'int', value: l | r }
          case '^': return { kind: 'int', value: l ^ r }
          // A wider shift than any integer type isn't a value worth computing.
          // Once the shift has a type, the count is the one its instruction
          // takes: only the low bits (4.2), so `x >> 32` as a u32 is `x >> 0`.
          // What is proved from the value (a range, an index in bounds) has
          // to hold for the value the program computes.
          case '<<':
          case '>>': {
            const width = shiftWidth(this.exprTypes.get(expr))
            const count = width ? r & BigInt(width - 1) : r
            if (count < 0n || count > 512n) return null
            return { kind: 'int', value: expr.op === '<<' ? l << count : held(expr.left, l) >> count }
          }
        }
      }
      const number = (v: ComptimeValue | null) => (v?.kind === 'int' || v?.kind === 'float' ? Number(v.value) : null)
      const l = number(left)
      const r = number(right)
      if (l !== null && r !== null && (left?.kind === 'float' || right?.kind === 'float')) {
        switch (expr.op) {
          case '+': return { kind: 'float', value: l + r }
          case '-': return { kind: 'float', value: l - r }
          case '*': return { kind: 'float', value: l * r }
          case '/': return { kind: 'float', value: l / r }
        }
      }
    }

    // Handle identifier references to other defs
    if (expr.kind === 'IdentExpr') {
      const sym = this.moduleScope.symbols.get(expr.name)
      if (sym?.kind === 'def') {
        return sym.value
      }
    }

    // Handle member access: .len and .wid on pointer-to-array types
    if (expr.kind === 'MemberExpr' && expr.member.kind === 'field') {
      const objType = this.exprTypes.get(expr.object)
        ?? (expr.object.kind === 'IdentExpr' ? typeOfSymbol(this.lookup(expr.object.name)) : undefined)
      if (objType) {
        const arrType = objType.kind === 'pointer' && objType.pointee.kind === 'array' ? objType.pointee
          : objType.kind === 'array' ? objType : null
        if (arrType?.kind === 'array' && arrType.sizes) {
          if (expr.member.name === 'len' && arrType.sizes.length === 1 && typeof arrType.sizes[0] === 'number') {
            return { kind: 'int', value: BigInt(arrType.sizes[0]) }
          }
          if (expr.member.name === 'wid') {
            const elemSize = byteSize(tableRow(objType) ?? arrType.element)
            if (elemSize !== null) return { kind: 'int', value: BigInt(elemSize) }
          }
        }
      }
    }

    // Handle sizeof expression
    if (expr.kind === 'SizeofExpr') {
      const resolvedType = this.resolveType(expr.type)
      const size = byteSize(resolvedType)
      if (size !== null) {
        return { kind: 'int', value: BigInt(size) }
      }
    }

    // A cast (`x as T`, `T(x)`): the operand's value, converted as the cast
    // converts it at run time.
    const castee = typed ? castOperand(expr) : null
    if (castee) {
      const value = this.evalComptimeExpr(castee, true)
      const to = this.exprTypes.get(expr)
      return value && to ? castConstant(value, to) : null
    }

    return null
  }

  collectGlobal(decl: AST.GlobalDecl): void {
    const name = this.patternIdent(decl.pattern)
    if (!name) {
      this.error(decl.pattern.span.start, 'global destructuring is not supported yet')
      return
    }
    if (this.takenByGeneric(name, decl.span.start)) return

    let type: ResolvedType
    if (decl.type) {
      type = this.resolveType(decl.type)
      if (decl.value) {
        // As in checkLetStmt: check the value against the annotation, and take
        // the checked type only when it fills in an inferred size. Otherwise the
        // annotation stands, so `global p: [*]mut i32 = 0` is a pointer, not
        // the literal's i32.
        const resolved = this.checkExpr(decl.value, type)
        if (this.hasInferredSize(type) && this.hasConcreteSize(resolved)) {
          type = resolved
        }
      }
    } else if (decl.value) {
      type = this.inferExpr(decl.value)
    } else {
      this.error(decl.span.start, 'global needs type annotation or initializer')
      type = primitive('i32')
    }

    if (decl.value && !this.isConstantInitializer(decl.value)) {
      this.error(decl.value.span.start, 'global initializer must be a compile-time constant')
    }
    this.moduleScope.symbols.set(name, { kind: 'global', type })
    this.types.set(typeKey(decl.pattern.span.start, decl.pattern.kind), type)
    this.recordDefinition(name, decl.pattern.span.start)
  }

  // A wasm global starts as a constant, so its initializer has to be one: a
  // number or bool the compiler can work out, the address of data or of a
  // function, or a tuple, struct or array of those, which is one wasm global
  // for each. Each value goes to codegen, which emits it where the
  // expression as written would need an instruction (1 + 1, a literal that
  // widens, a cast that narrows).
  private isConstantInitializer(expr: AST.Expr): boolean {
    const value = this.evalComptimeExpr(expr, true)
    if (value) {
      this.constants.set(expr, value)
      return true
    }
    // An address cast to another pointer type or to a 32-bit integer is the
    // same i32, so the same constant.
    const castee = castOperand(expr)
    if (castee) {
      return holdsAddress(this.exprTypes.get(expr)) && holdsAddress(this.exprTypes.get(castee))
        && this.isConstantInitializer(castee)
    }
    switch (expr.kind) {
      case 'AnnotationExpr':
      case 'GroupExpr':
        return this.isConstantInitializer(expr.expr)
      case 'TupleExpr':
        return expr.elements.every(e => e.value !== null && this.isConstantInitializer(e.value))
      case 'CallExpr': {
        // A struct constructor of constants.
        const built = this.calls.get(expr)
        if (built?.kind === 'TupleExpr') return this.isConstantInitializer(built)
        return expr.callee.kind === 'IdentExpr' && this.lookup(expr.callee.name)?.kind === 'type'
          && expr.args.every(a => a.value !== null && this.isConstantInitializer(a.value))
      }
      case 'IdentExpr':
        return this.lookup(expr.name)?.kind === 'func'
      case 'ArrayExpr':
      case 'RepeatExpr':
        // An array behind a pointer or a slice lives in the data section,
        // like a string. One held in registers is its elements.
        if (expr.dataId !== undefined) return true
        return (expr.kind === 'ArrayExpr' ? expr.elements : [expr.value]).every(e => this.isConstantInitializer(e))
      default:
        // A string lives in the data section.
        return this.isDataLiteralExpr(expr)
    }
  }

  // === Second Pass: Check Declarations ===

  checkDeclaration(decl: AST.Declaration): void {
    switch (decl.kind) {
      case 'ExportDecl':
        if (decl.item.kind === 'FuncDecl') {
          if (isGenericDecl(decl.item)) {
            this.skipGenericBody(decl.item)
            break
          }
          this.warnManyPointerParams(decl.item)
          this.checkFuncBody(decl.item)
        }
        break
      case 'FuncDecl':
        if (isGenericDecl(decl)) this.skipGenericBody(decl)
        else this.checkFuncBody(decl)
        break
      case 'TestDecl':
        if (this.options.includeTests !== false) this.checkTestDecl(decl)
        break
      default:
        break
    }
  }

  checkTestDecl(decl: AST.TestDecl): void {
    const testScope: Scope = { parent: this.currentScope, symbols: new Map() }
    const prevScope = this.currentScope
    this.currentScope = testScope
    for (const item of decl.children) {
      switch (item.kind) {
        case 'TestDecl':
          this.checkTestDecl(item)
          break
        case 'ImportDecl': {
          const known = new Set(this.moduleScope.symbols.keys())
          this.collectImport(item, true)
          for (const name of this.moduleScope.symbols.keys()) if (!known.has(name)) this.testOnly.add(name)
          break
        }
        case 'FuncDecl':
          // A function declared in a test is registered in module scope, so
          // two tests declaring one generic would be two functions of one name.
          if (isGenericDecl(item)) {
            this.error(item.span.start, `a generic function is declared at module level, not inside a test`)
            // Known by name all the same, so that its calls say nothing more.
            if (item.ident && !this.moduleScope.symbols.has(item.ident)) {
              this.moduleScope.symbols.set(item.ident, { kind: 'generic', decl: item, owner: this, instances: new Map(), valid: false })
            }
            break
          }
          if (item.ident && !this.moduleScope.symbols.has(item.ident)) this.testOnly.add(item.ident)
          this.collectFunc(item, true)
          // Not one that was refused the name: the module's functions keep it.
          if (item.ident && !this.shared(item.ident)) {
            const declared = this.moduleScope.symbols.get(item.ident)
            if (declared?.kind === 'func') this.testDeclared.add(declared)
          }
          this.checkFuncBody(item)
          break
        case 'TypeFuncDecl':
          // The signatures of the module are resolved before any test is
          // come to, and a type they could not name would be no type of theirs.
          this.error(item.span.start, `a generic type is declared at module level, not inside a test`)
          // Known by name all the same, so that its uses say nothing more.
          if (!this.moduleScope.symbols.has(item.ident)) {
            this.moduleScope.symbols.set(item.ident, { kind: 'typefunc', decl: item, owner: this, cache: new Map(), valid: false })
          }
          break
        case 'DataDecl':
          this.collectData(item)
          break
        case 'DefDecl':
          this.collectDef(item)
          break
        default:
          this.checkStmt(item)
          break
      }
    }
    this.currentScope = prevScope
    this.placeInferredStrings()
  }

  // A many-pointer is refused where it's written through; memcpy may read from one.
  private checkMemOpPtr(expr: AST.Expr, context: string, allowManyPointer = false): ResolvedType {
    const type = this.inferExpr(expr)
    const u = unwrap(type)
    if (u.kind === 'pointer' && u.pointee.kind === 'array') {
      if (u.pointee.sizes === null && !allowManyPointer) {
        this.error(expr.span.start, `${context}: many-pointer has no bounds — use a sized pointer for safe memory operations`)
      }
      // A string literal gets its bytes in the data section when it's checked
      // against the type it's used at, as the argument of a function is. So
      // does one in an arm of an `if` or a `match`. Parentheses around the
      // operand change nothing.
      const value = ungrouped(expr)
      if (value.kind === 'LiteralExpr' || value.kind === 'IfExpr' || value.kind === 'MatchExpr') this.checkExpr(value, type)
      return type
    }
    this.error(expr.span.start, `${context}: expected *[N]T, got ${typeToString(type)}`)
    return type
  }

  private checkMemOpBounds(ptrExpr: AST.Expr, lenExpr: AST.Expr, op: string): void {
    // Find buffer size from the dest pointer type
    let srcExpr = ptrExpr
    if (srcExpr.kind === 'CastExpr') srcExpr = srcExpr.expr
    if (srcExpr.kind === 'MemberExpr' && srcExpr.member.kind === 'type') srcExpr = srcExpr.object

    const srcType = this.exprTypes.get(srcExpr)
    if (!srcType) return

    const arrType = srcType.kind === 'pointer' && srcType.pointee.kind === 'array' ? srcType.pointee : null
    if (!arrType?.sizes || !arrType.sizes.every(s => typeof s === 'number')) return

    const totalCount = totalElements(arrType.sizes)
    if (totalCount === null) return
    const elemSize = byteSize(arrType.element)
    if (elemSize === null) return
    const bufferSize = totalCount * elemSize

    // Length must be a comptime constant to verify bounds
    const len = this.constantInType(lenExpr)
    if (!len || len.kind !== 'int') {
      this.warn(lenExpr.span.start, `${op} length is not a compile-time constant — cannot verify bounds (buffer is ${bufferSize} bytes)`)
      return
    }

    if (Number(len.value) > bufferSize) {
      this.error(lenExpr.span.start, `${op} length ${len.value} exceeds buffer size ${bufferSize} bytes`)
    }
  }

  private isManyPointer(t: ResolvedType): boolean {
    return t.kind === 'pointer' && t.pointee.kind === 'array' && t.pointee.sizes === null
  }

  private warnManyPointerParams(decl: AST.FuncDecl): void {
    if (decl.signature.input.kind !== 'CompositeType') return
    for (const field of decl.signature.input.fields) {
      if (!field.ident) continue
      const type = this.resolveType(field.type)
      if (this.isManyPointer(type)) {
        const inner = type as PointerRT
        const mut = inner.mutable ? 'mut ' : ''
        const elem = typeToString(inner.pointee.kind === 'array' ? inner.pointee.element : inner.pointee)
        this.warn(field.span.start, `exported function parameter '${field.ident}' uses [*] many-pointer — consider []${mut}${elem} slice for a safe API`)
      }
    }
  }

  checkFuncBody(decl: AST.FuncDecl): void {
    // Create function scope with params and named returns
    const funcScope: Scope = { parent: this.currentScope, symbols: new Map() }

    // Add parameters and named returns to scope
    this.bindFields(decl.signature.input, funcScope, 'param')
    this.bindFields(decl.signature.output, funcScope, 'return')
    if (this.currentInstance?.decl === decl) this.bindComptimeFuncs(this.currentInstance, funcScope)

    // Check body
    const prevScope = this.currentScope
    const prevReturnType = this.currentReturnType
    this.currentScope = funcScope
    const results = this.resolveType(decl.signature.output)
    // What follows `->` is a list of results only where it is written in
    // parentheses. An instance's `-> T` is one result, also when T is bound
    // to a tuple or a struct: it is held as the list of that one, so that
    // its fields are not taken for the function's results below.
    const oneTuple = decl.signature.output.kind === 'BoundType' && results.kind === 'tuple'
    this.currentReturnType = oneTuple ? tuple([field(null, results)]) : results
    if (decl.body.kind === 'Block') {
      const output = decl.signature.output
      const named = output.kind === 'CompositeType' && output.fields.some(f => f.ident)
      // With named results, a trailing expression with a value supplies them.
      this.checkBody(decl.body, named)
      const tail = named ? decl.body.stmts.at(-1) : undefined
      const tailType = tail?.kind === 'ExpressionStmt' ? this.exprTypes.get(tail.expr) : undefined
      if (tail?.kind === 'ExpressionStmt' && tailType && tailType.kind !== 'void' && !(tailType.kind === 'tuple' && tailType.fields.length === 0)) {
        this.coerce(tail.expr, tailType, this.resultsFilledBy(tailType))
      }
      // A block body with unnamed results has to return on every path: there
      // are no named locals to return when it falls off the end.
      const resultType = this.currentReturnType
      const hasResult = resultType.kind !== 'void' && !(resultType.kind === 'tuple' && resultType.fields.length === 0)
      if (!named && hasResult && !blockTerminates(decl.body.stmts)) {
        // The name the user wrote, not max<u32>: the message is followed by
        // the instance anyway.
        const name = this.currentInstance?.decl === decl ? this.currentInstance.of.ident : decl.ident
        this.error(decl.span.start, `function '${name ?? 'anonymous'}' can reach its end without returning a value`)
      }
    } else {
      // An expression body supplies the results as a trailing value does:
      // several named ones are filled in order, whatever the value's own
      // fields are called. checkExpr knows the value by this copy of them.
      const results = this.returnValueType()
      const named = results.kind === 'tuple' && results.fields.some(f => f.name)
      const prevResults = this.resultsInOrder
      this.resultsInOrder = named ? tuple(results.fields) : null
      this.checkExpr(decl.body.expr, this.resultsInOrder ?? results)
      this.resultsInOrder = prevResults
    }
    this.currentScope = prevScope
    this.currentReturnType = prevReturnType
    this.placeInferredStrings()
  }

  // The type a returned value is checked against: for a single named result
  // like (ptr: u32), the type inside.
  private returnValueType(): ResolvedType {
    const type = this.currentReturnType ?? VOID
    return type.kind === 'tuple' && type.fields.length === 1 ? type.fields[0].type : type
  }

  // The type a trailing value has to have to supply the named results. It
  // fills them in order, as `let a, b = f()` binds by position, so the names
  // of its own fields don't matter: the expected type takes them over.
  private resultsFilledBy(valueType: ResolvedType): ResolvedType {
    const results = this.returnValueType()
    const value = unwrap(valueType)
    if (results.kind !== 'tuple' || value.kind !== 'tuple' || value.fields.length !== results.fields.length) return results
    return tuple(results.fields.map((f, i) => field(value.fields[i].name, f.type)))
  }

  private bindFields(type: AST.Type, scope: Scope, kind: 'param' | 'return'): void {
    // Only CompositeType can have named fields
    if (type.kind !== 'CompositeType') return
    for (const field of type.fields) {
      if (field.ident) {
        const resolvedType = this.resolveType(field.type)
        scope.symbols.set(field.ident, { kind, type: resolvedType })
        this.types.set(typeKey(field.span.start, field.kind), resolvedType)
        this.recordDefinition(field.ident, field.span.start)
      }
    }
  }

  checkBody(body: AST.FuncBody, tailValueUsed = false): void {
    if (body.kind === 'Block') {
      this.checkStmts(body.stmts, tailValueUsed)
    } else {
      this.inferExpr(body.expr)
    }
  }

  // valueUsed: the statement is the last of a block whose value something takes.
  checkStmt(stmt: AST.Statement, valueUsed = false): void {
    switch (stmt.kind) {
      case 'LetStmt':
        this.checkLetStmt(stmt)
        break
      case 'SetStmt':
        this.checkSetStmt(stmt)
        break
      case 'ExpressionStmt':
        if (valueUsed) this.statementExprs.delete(stmt.expr)
        else this.statementExprs.add(stmt.expr)
        this.inferExpr(stmt.expr)
        break
      case 'DeferStmt': {
        const prev = this.deferLoopDepth
        this.deferLoopDepth = this.loopDepth
        try {
          this.statementExprs.add(stmt.expr)
          this.inferExpr(stmt.expr)
        } finally {
          this.deferLoopDepth = prev
        }
        break
      }
      case 'ReturnStmt':
        if (this.deferLoopDepth !== null) {
          this.error(stmt.span.start, `cannot return from inside a deferred expression`)
        }
        if (stmt.value) {
          const checkType = this.currentReturnType ? this.returnValueType() : undefined
          if (checkType && checkType.kind !== 'void') {
            this.checkExpr(stmt.value, checkType)
          } else {
            this.inferExpr(stmt.value)
          }
        } else {
          // A bare return hands back the named results as they are set. With
          // an unnamed result there is nothing for it to return.
          const type = this.currentReturnType
          const named = type?.kind === 'tuple' && type.fields.some(f => f.name)
          const hasResult = type && type.kind !== 'void' && !(type.kind === 'tuple' && type.fields.length === 0)
          if (type && hasResult && !named) {
            this.error(stmt.span.start, `return needs a value: the function returns ${typeToString(type)}`)
          }
        }
        if (stmt.when) this.checkCondition(stmt.when)
        break
      case 'AssignmentStmt': {
        if (stmt.target.kind === 'SliceExpr') {
          this.checkRangeAssignment(stmt.target, stmt.op, stmt.value)
          break
        }
        let targetType: ResolvedType | undefined
        if (stmt.target.kind === 'IdentExpr' || stmt.target.kind === 'MemberExpr' || stmt.target.kind === 'IndexExpr') {
          targetType = this.inferExpr(stmt.target)
        }
        // p.u32 is p itself, seen as a pointer to u32 values: it loads nothing,
        // so there is no place behind it to store to. The place is p.u32[0].
        if (stmt.target.kind === 'MemberExpr' && stmt.target.member.kind === 'type') {
          const pun = typeToString(this.resolveType(stmt.target.member.type))
          const pointer = targetType && unwrap(targetType).kind === 'pointer'
          this.error(stmt.span.start, pointer
            ? `cannot assign to .${pun}: it is the pointer as ${typeToString(targetType as ResolvedType)}, not the ${pun} it points at — write .${pun}[0] = value to store one`
            : `cannot assign to .${pun}: a type pun is not a place a value can be stored to`)
          this.inferExpr(stmt.value)
          break
        }
        this.checkMutability(stmt.target, stmt.span.start)
        if (targetType && stmt.op === '=') {
          this.checkExpr(stmt.value, targetType)
        } else if (targetType) {
          this.checkCompoundAssignment(stmt, targetType)
        } else {
          this.inferExpr(stmt.value)
        }
        break
      }
      case 'WhileStmt':
        this.checkCondition(stmt.condition)
        this.checkLoopBody(stmt.body)
        break
      case 'LoopStmt':
        this.checkLoopBody(stmt.body)
        break
      case 'ForStmt': {
        const iterableType = unwrap(this.inferExpr(stmt.iterable))
        // Determine element type from iterable
        let elemType: ResolvedType = primitive('u32') // default: unsigned index
        const pointee = iterableType.kind === 'pointer' ? unwrap(iterableType.pointee) : null
        if (iterableType.kind === 'comptime_int') {
          const rangeMax = Number(iterableType.value)
          elemType = primitive('u32', rangeMax > 0 ? rangeMax : undefined)
        } else if (iterableType.kind === 'slice') {
          elemType = tableRow(iterableType) ?? iterableType.element
        } else if (pointee?.kind === 'array' && pointee.sizes?.length === 1 && typeof pointee.sizes[0] === 'number') {
          elemType = tableRow(iterableType) ?? pointee.element
        } else if (iterableType.kind !== 'primitive') {
          this.error(stmt.iterable.span.start,
            `cannot iterate over ${typeToString(iterableType)}: use a count, a slice, or a pointer to a fixed-size array`)
        }
        // Record the binding types and add them to scope
        this.types.set(typeKey(stmt.binding.span.start, stmt.binding.kind), elemType)
        this.currentScope.symbols.set(stmt.binding.value, { kind: 'local', type: elemType })
        this.recordDefinition(stmt.binding.value, stmt.binding.span.start)
        if (stmt.binding.index) {
          this.currentScope.symbols.set(stmt.binding.index, { kind: 'local', type: primitive('u32') })
          this.recordDefinition(stmt.binding.index, stmt.binding.span.start)
        }
        this.checkLoopBody(stmt.body)
        break
      }
      case 'AssertStmt':
        this.checkCondition(stmt.expr)
        break
      case 'BreakStmt':
      case 'ContinueStmt':
        if (this.deferLoopDepth !== null && this.loopDepth <= this.deferLoopDepth) {
          const what = stmt.kind === 'BreakStmt' ? 'break' : 'continue'
          this.error(stmt.span.start, `cannot ${what} out of a deferred expression`)
        }
        if (stmt.when) this.checkCondition(stmt.when)
        break
    }
  }

  // x op= v is x = x op v with the result stored back in x: the operator has
  // to apply to x's type, and v has to widen to it (x can't widen to v's).
  private checkCompoundAssignment(stmt: AST.AssignmentStmt, targetType: ResolvedType): void {
    const op = stmt.op.slice(0, -1)
    const target = unwrap(targetType)
    if (target.kind !== 'primitive') {
      // p += n moves a pointer: n is an integer that fits an address.
      const valueType = this.inferExpr(stmt.value)
      const value = unwrap(valueType)
      if (target.kind === 'pointer' && value.kind === 'comptime_int') {
        this.coerce(stmt.value, valueType, addressType(value))
      } else if (target.kind !== 'pointer' || !isInteger(value) || (byteSize(value) ?? 8) > 4) {
        this.error(stmt.span.start, noOperator(stmt.op, targetType, valueType))
      }
      return
    }
    const problem = operandProblem(op, targetType)
    if (problem) {
      this.error(stmt.span.start, problem)
      this.inferExpr(stmt.value)
      return
    }
    if (SHIFT_OPS.has(op)) {
      // A count is any integer; a constant one takes x's type.
      const valueType = this.inferExpr(stmt.value)
      const value = unwrap(valueType)
      if (value.kind === 'comptime_int') this.coerce(stmt.value, valueType, stripMax(targetType))
      else if (!isInteger(value)) this.error(stmt.value.span.start, `'${stmt.op}' needs an integer count, not ${typeToString(valueType)}`)
      return
    }
    this.checkExpr(stmt.value, targetType)
  }

  // Check statements in order. After `return/break/continue when c`, or an
  // `if c { ... }` whose branch always exits, c is false for the rest.
  private checkStmts(stmts: AST.Statement[], tailValueUsed = false): void {
    for (let i = 0; i < stmts.length; i++) {
      const stmt = stmts[i]
      this.checkStmt(stmt, tailValueUsed && i === stmts.length - 1)
      let exitCond: AST.Expr | null = null
      if ((stmt.kind === 'ReturnStmt' || stmt.kind === 'BreakStmt' || stmt.kind === 'ContinueStmt') && stmt.when) {
        exitCond = stmt.when
      } else if (stmt.kind === 'ExpressionStmt' && stmt.expr.kind === 'IfExpr' && !stmt.expr.pattern &&
        stmt.expr.elifs.length === 0 && !stmt.expr.else_ && alwaysExits(stmt.expr.thenBranch)) {
        exitCond = stmt.expr.condition
      }
      if (exitCond) {
        const rest = stmts.slice(i + 1)
        this.withNarrowing(this.boundsFrom(exitCond, false), rest, () => this.checkStmts(rest, tailValueUsed))
        return
      }
    }
  }

  checkLoopBody(body: AST.FuncBody): void {
    this.loopDepth++
    try {
      this.checkBody(body)
    } finally {
      this.loopDepth--
    }
  }

  checkLetStmt(stmt: AST.LetStmt): void {
    let type: ResolvedType
    if (stmt.type) {
      type = this.resolveType(stmt.type)
      if (stmt.value) {
        // Use bidirectional type checking - propagate expected type down
        // checkExpr validates compatibility and may fill in 'inferred' sizes
        const resolved = this.checkExpr(stmt.value, type)
        // Only update type if annotation had inferred sizes that got filled in
        // with concrete numbers (not null, 'inferred', or 'comptime')
        if (this.hasInferredSize(type) && this.hasConcreteSize(resolved)) {
          type = resolved
        }
        // Otherwise keep the annotation type (even if there's a type error)
      }
    } else if (stmt.value) {
      const valueType = this.inferExpr(stmt.value)
      // Check for empty comptime_list - needs type annotation
      if (valueType.kind === 'comptime_list' && valueType.elements.length === 0) {
        this.error(stmt.value.span.start, 'cannot infer element type of empty array literal')
      }
      // Concretize comptime types for variables
      type = this.concretize(valueType)
      // A constant initializer takes the variable's type, down to its literals.
      if (isComptimeNumber(valueType)) this.typeConstant(stmt.value, type, valueType, false)
    } else {
      this.error(stmt.span.start, 'let needs type annotation or initializer')
      type = primitive('i32')
    }

    // Add bindings from pattern and record types
    this.bindPattern(stmt.pattern, type)
  }

  checkSetStmt(stmt: AST.SetStmt): void {
    // set x = v assigns like x = v: the value is checked against x's type.
    const sym = stmt.pattern.kind === 'IdentPattern' ? this.lookup(stmt.pattern.name) : undefined
    const valueType = sym && sym.kind !== 'func' && sym.kind !== 'type' && sym.kind !== 'generic' && sym.kind !== 'typefunc'
      ? this.checkExpr(stmt.value, sym.type)
      : this.inferExpr(stmt.value)
    this.validatePatternBindingsExist(stmt.pattern, valueType)
  }

  private validatePatternBindingsExist(pattern: AST.Pattern, type: ResolvedType): void {
    switch (pattern.kind) {
      case 'IdentPattern': {
        const sym = this.lookup(pattern.name)
        if (!sym) {
          this.error(pattern.span.start, `cannot set '${pattern.name}': not defined (use 'let' to create a new binding)`)
        }
        break
      }
      case 'TuplePattern': {
        const unwrappedType = unwrap(type)
        if (unwrappedType.kind !== 'tuple') {
          this.error(pattern.span.start, `cannot destructure non-tuple type in set: ${typeToString(type)}`)
          break
        }
        // A field goes from the stack straight into its variable, so it has
        // to be held the way the variable is: nothing widens it on the way.
        const fits = (varName: string, fieldType: ResolvedType | undefined) => {
          const sym = this.lookup(varName)
          if (!sym || !fieldType || sym.kind === 'func' || sym.kind === 'type' || sym.kind === 'generic' || sym.kind === 'typefunc') return
          if (!typeAssignable(sym.type, fieldType) || !sameRepresentation(fieldType, sym.type)) {
            this.error(pattern.span.start, `cannot set '${varName}' (${typeToString(sym.type)}) from a field of type ${typeToString(fieldType)}`)
          }
        }
        for (const element of pattern.elements) {
          if (element.kind === 'named') {
            const varName = element.binding ?? element.field
            const sym = this.lookup(varName)
            if (!sym) {
              this.error(pattern.span.start, `cannot set '${varName}': not defined`)
            }
            fits(varName, unwrappedType.fields.find(f => f.name === element.field)?.type)
          } else {
            const fieldType = unwrappedType.fields[pattern.elements.indexOf(element)]?.type
            this.validatePatternBindingsExist(element.pattern, fieldType ?? type)
            if (element.pattern.kind === 'IdentPattern') fits(element.pattern.name, fieldType)
          }
        }
        break
      }
    }
  }

  bindPattern(pattern: AST.Pattern, type: ResolvedType): void {
    switch (pattern.kind) {
      case 'IdentPattern': {
        const existing = this.lookup(pattern.name)
        if (existing && !this.declared.has(pattern)) {
          this.error(pattern.span.start, `'${pattern.name}' is already declared in this scope`)
        }
        this.declared.add(pattern)
        this.currentScope.symbols.set(pattern.name, { kind: 'local', type })
        this.types.set(typeKey(pattern.span.start, pattern.kind), type)
        this.recordDefinition(pattern.name, pattern.span.start)
        break
      }
      case 'TuplePattern': {
        // Unwrap named types to get the underlying tuple
        const unwrappedType = unwrap(type)
        if (unwrappedType.kind !== 'tuple') {
          this.error(pattern.span.start, `cannot destructure non-tuple type: ${typeToString(type)}`)
          break
        }
        // Codegen reads the whole tuple's type here, for positional and named
        // elements alike.
        this.types.set(typeKey(pattern.span.start, pattern.kind), unwrappedType)

        for (const element of pattern.elements) {
          if (element.kind === 'named') {
            // Named pattern: (x: a, y: b) or shorthand (x:, y:)
            const tupleField = unwrappedType.fields.find((f) => f.name === element.field)
            if (!tupleField) {
              this.error(pattern.span.start, `field '${element.field}' not found in ${typeToString(type)}`)
              continue
            }
            // binding is null for shorthand (x:) - use field name as variable name
            const varName = element.binding ?? element.field
            this.currentScope.symbols.set(varName, { kind: 'local', type: tupleField.type })
            this.recordDefinition(varName, pattern.span.start)
          } else {
            // Positional pattern: (a, b) - match by index
            const index = pattern.elements.indexOf(element)
            if (index >= unwrappedType.fields.length) {
              this.error(pattern.span.start, `tuple has ${unwrappedType.fields.length} fields, but pattern has ${pattern.elements.length}`)
              continue
            }
            const fieldType = unwrappedType.fields[index].type
            this.bindPattern(element.pattern, fieldType)
          }
        }
        break
      }
    }
  }

  private patternIdent(pattern: AST.Pattern): string | null {
    if (pattern.kind === 'IdentPattern') return pattern.name
    return null
  }

  // Convert comptime types to concrete defaults for storage
  concretize(type: ResolvedType): ResolvedType {
    switch (type.kind) {
      case 'comptime_int': {
        // Default: i32 if it fits, otherwise i64
        const i32Type = primitive('i32')
        if (comptimeIntFits(type.value, i32Type)) {
          return i32Type
        }
        return primitive('i64')
      }
      case 'comptime_float':
        // Default: f64
        return primitive('f64')
      case 'comptime_list': {
        // Default to *[_]T (pointer to inferred length array)
        if (type.elements.length === 0) {
          // Empty list defaults to *[_]i32
          return pointer(array(primitive('i32'), ['_']))
        }
        const elemType = this.concretize(this.unifyTypes(type.elements))
        return pointer(array(elemType, ['_']))
      }
      case 'comptime_array': {
        const elemType = this.concretize(type.element)
        return array(elemType, [type.count])
      }
      case 'array': {
        // Handle comptime array ([_]T) - default to *[_]T (pointer to inferred length array)
        if (type.sizes?.includes('_')) {
          const elemType = this.concretize(type.element)
          return pointer(array(elemType, type.sizes))
        }
        // Always concretize element type (e.g., [100]comptime_int -> [100]i32)
        const elemType = this.concretize(type.element)
        if (elemType !== type.element) {
          return array(elemType, type.sizes)
        }
        return type
      }
      case 'slice': {
        // Concretize element type
        const elemType = this.concretize(type.element)
        if (elemType !== type.element) {
          return slice(elemType)
        }
        return type
      }
      case 'tuple': {
        let changed = false
        const fields = type.fields.map(f => {
          const ct = this.concretize(f.type)
          if (ct !== f.type) changed = true
          return field(f.name, ct)
        })
        return changed ? tuple(fields) : type
      }
      case 'pointer': {
        const ct = this.concretize(type.pointee)
        return ct !== type.pointee ? pointer(ct, type.boundary, type.mutable) : type
      }
      default:
        return type
    }
  }

  // Check if a type contains any 'inferred' sizes that need to be filled in
  hasInferredSize(type: ResolvedType): boolean {
    switch (type.kind) {
      case 'array':
        return (type.sizes?.includes('_') ?? false) || this.hasInferredSize(type.element)
      case 'slice':
        return this.hasInferredSize(type.element)
      case 'pointer':
        return this.hasInferredSize(type.pointee)
      case 'tuple':
        return type.fields.some(f => this.hasInferredSize(f.type))
      default:
        return false
    }
  }

  // Check if a type has concrete (numeric) sizes where annotation had 'inferred'
  // This means the inferred sizes were successfully filled in
  hasConcreteSize(type: ResolvedType): boolean {
    switch (type.kind) {
      case 'array':
        return isFixedSizes(type.sizes) && this.hasConcreteSizeOrNoInferred(type.element)
      case 'slice':
        return this.hasConcreteSizeOrNoInferred(type.element)
      case 'pointer':
        return this.hasConcreteSize(type.pointee)
      case 'tuple':
        return type.fields.every(f => this.hasConcreteSizeOrNoInferred(f.type))
      default:
        return true // Non-array types are "concrete" by default
    }
  }

  // Helper: type has either concrete size or no inferred sizes at all
  hasConcreteSizeOrNoInferred(type: ResolvedType): boolean {
    switch (type.kind) {
      case 'array':
        if (type.sizes?.includes('_')) return false
        return this.hasConcreteSizeOrNoInferred(type.element)
      case 'slice':
        return this.hasConcreteSizeOrNoInferred(type.element)
      case 'pointer':
        return this.hasConcreteSizeOrNoInferred(type.pointee)
      case 'tuple':
        return type.fields.every(f => this.hasConcreteSizeOrNoInferred(f.type))
      default:
        return true
    }
  }

  // Find a common type that all given types can be assigned to
  unifyTypes(types: ResolvedType[]): ResolvedType {
    if (types.length === 0) {
      return primitive('i32')
    }

    // Check if all are comptime_int - default to i32, widen if needed
    if (types.every((t) => t.kind === 'comptime_int')) {
      const values = types.map((t) => (t as { kind: 'comptime_int'; value: bigint }).value)
      // Default to i32 for integer literals (standard default)
      const i32Type = primitive('i32')
      if (values.every((v) => comptimeIntFits(v, i32Type))) {
        return i32Type
      }
      // Widen to i64 if values don't fit in i32
      return primitive('i64')
    }

    // Check if all are comptime_list - recursively unify
    if (types.every((t) => t.kind === 'comptime_list')) {
      const lists = types as { kind: 'comptime_list'; elements: ResolvedType[] }[]
      // Unify all elements from all lists
      const allElements = lists.flatMap((l) => l.elements)
      if (allElements.length === 0) {
        return slice(primitive('i32'))
      }
      const innerType = this.unifyTypes(allElements)
      // All lists should have same length for fixed array, otherwise slice
      const lengths = lists.map((l) => l.elements.length)
      if (lengths.every((len) => len === lengths[0])) {
        return array(innerType, [lengths[0]])
      }
      return slice(innerType)
    }

    // Check if all are pointers to fixed arrays with the same element type
    // e.g., *[8]u8, *[5]u8, *[3]u8 → unify to []u8 if sizes differ, keep *[N]u8 if same
    if (types.every((t) => t.kind === 'pointer' && t.pointee.kind === 'array' && t.pointee.sizes?.length === 1 && typeof t.pointee.sizes[0] === 'number')) {
      const ptrs = types as { kind: 'pointer'; pointee: ArrayRT }[]
      const elemType = ptrs[0].pointee.element
      if (ptrs.every((p) => typeEquals(p.pointee.element, elemType))) {
        const sizes = ptrs.map((p) => p.pointee.sizes?.[0] as number)
        if (sizes.every((s) => s === sizes[0])) {
          return this.concretize(types[0])
        }
        return slice(elemType)
      }
    }

    // Mixed or other types - concretize first element as fallback
    return this.concretize(types[0])
  }

  // === Type Resolution ===

  resolveType(type: AST.Type): ResolvedType {
    switch (type.kind) {
      case 'PrimitiveType':
        return primitive(type.name, type.max)

      case 'PointerType':
        return pointer(this.resolveType(type.pointee), false, type.mutable, type.optional)

      case 'IndexedType': {
        const element = this.resolveType(type.element)

        // Many-pointer [*]T or [*]mut T
        if (type.manyPointer) {
          const result = manyPointer(element, type.mutable)
          if (type.optional) result.optional = true
          return result
        }

        // Slice []T or []mut T
        if (type.size === null && type.specifiers.length === 0) {
          return slice(element, type.mutable, type.optional)
        }

        // Build sizes array from size and specifiers
        const sizes: ArraySize[] = []

        // Add numeric size(s) if present
        if (type.size !== null && type.size !== 'inferred' && type.size !== 'comptime') {
          if (Array.isArray(type.size)) {
            sizes.push(...type.size)
          } else {
            sizes.push(type.size)
          }
        } else if (type.size === 'inferred' || type.size === 'comptime') {
          // Both 'inferred' and 'comptime' map to '_' (compile-time known)
          sizes.push('_')
        }

        // Add framing specifiers (! for null-terminated, ? for LEB prefix)
        for (const spec of type.specifiers) {
          sizes.push(spec.kind === 'null' ? '!' : '?')
        }

        // If only specifiers and no size, that's valid: [!]T, [?]T
        return array(element, sizes.length > 0 ? sizes : null)
      }

      case 'CompositeType': {
        const fields = type.fields.map((f) =>
          field(f.ident, this.resolveType(f.type)),
        )
        return tuple(fields)
      }

      case 'ComptimeIntType':
        return comptimeInt(type.value)

      case 'ComptimeFloatType':
        return comptimeFloat(type.value)

      case 'TypeRef': {
        // Record reference to type
        this.recordReference(type.name, type.span.start)

        const sym = this.moduleScope.symbols.get(type.name)
        if (sym && sym.kind === 'type') {
          // Wrap with named to preserve the alias/unique name
          return named(type.name, sym.type)
        }
        if (sym?.kind === 'typefunc') {
          // Where its declaration has an error, or a type wanted the name,
          // that one error is all there is to say.
          const problem = this.typeFuncProblem(type)
          if (problem) this.error(type.span.start, problem)
          return RECOVERY
        }
        // Check if this is a forward reference to a type being defined
        if (this.pendingTypeNames.has(type.name)) {
          return forwardRef(type.name)
        }
        const similar = this.findSimilar(type.name)
        const hint = similar ? ` — did you mean '${similar}'?` : ''
        this.error(type.span.start, `unknown type '${type.name}'${hint}`)
        return primitive('i32')
      }

      case 'FuncType': {
        // Function type: input -> output
        const params = this.typeToFields(type.input)
        const returns = this.typeToFields(type.output)
        return func(params, returns)
      }

      case 'TypeApply':
        return this.applyTypeFunc(type)

      case 'BoundType':
        // Not wrapped in named(): messages then print the argument (f64), not
        // the parameter (T).
        return type.type

      case 'TypeType':
        this.error(type.span.start, `a parameter of type 'type' must be comptime: write 'comptime T: type'`)
        return RECOVERY
    }
  }

  resolveSignature(sig: AST.FuncSignature): ResolvedType & { kind: 'func' } {
    const params = this.typeToFields(sig.input)
    const returns = this.typeToFields(sig.output)
    return func(params, returns)
  }

  // Convert a Type to a list of fields (for function params/returns)
  // CompositeType with fields -> array of fields
  // Empty CompositeType -> empty array (void)
  // Other types -> single unnamed field
  typeToFields(type: AST.Type): ResolvedField[] {
    if (type.kind === 'CompositeType') {
      // Empty composite = void, return no fields
      if (type.fields.length === 0) {
        return []
      }
      // Composite with fields = tuple/struct
      return type.fields.map((f) => field(f.ident, this.resolveType(f.type)))
    }
    // Single type without name
    return [field(null, this.resolveType(type))]
  }

  // === Expression Type Inference ===

  // Infer the type of an expression (bottom-up)
  inferExpr(expr: AST.Expr): ResolvedType {
    const type = this.inferExprInner(expr)
    // Record type for ALL expressions - codegen needs this
    // Note: comptime types are stored as-is; concretization happens in a later pass
    this.exprTypes.set(expr, type)
    return type
  }

  // Check an expression against an expected type (top-down / bidirectional)
  // This allows comptime types to resolve based on context
  // Optional errorContext is prepended to error messages (e.g., "argument 1: ")
  checkExpr(expr: AST.Expr, expected: ResolvedType, errorContext?: string): ResolvedType {
    // (x) is x, and meets the type as x does: it has one element whatever
    // the type of x is, so nothing below may take it for a tuple of x's fields.
    const grouped = groupedExpr(expr)
    if (grouped) {
      this.coercions.delete(expr)
      const type = this.checkExpr(grouped, expected, errorContext)
      this.exprTypes.set(expr, this.exprTypes.get(grouped) ?? type)
      return type
    }

    // Bidirectional: propagate expected type through & (ref) expressions
    if (expr.kind === 'UnaryExpr' && expr.op === '&' && expected.kind === 'pointer') {
      const operand = expr.operand.kind === 'AnnotationExpr' ? expr.operand.expr : expr.operand
      const isLiteral = operand.kind === 'LiteralExpr' || operand.kind === 'ArrayExpr' ||
        operand.kind === 'RepeatExpr' || operand.kind === 'TupleExpr'
      if (isLiteral && expected.mutable) markMut(operand)
      this.checkExpr(expr.operand, expected.pointee)
      if (isLiteral) {
        // Give the literal its own cell in the data section, as inferExpr does.
        if (operand.kind !== 'TupleExpr') {
          (operand as AST.LiteralExpr | AST.ArrayExpr | AST.RepeatExpr).dataId = operand.span.start
        }
        this.addLiteral(operand.span.start, operand, { kind: 'array', element: expected.pointee, sizes: [1] })
      }
      const result = pointer(expected.pointee, false, expected.mutable)
      this.exprTypes.set(expr, result)
      return result
    }

    // Bidirectional: propagate expected type into if-expression branches
    if (expr.kind === 'IfExpr' && !expr.pattern && expr.else_) {
      this.checkCondition(expr.condition)
      this.withNarrowing(this.boundsFrom(expr.condition, true), expr.thenBranch, () => this.checkBodyAgainst(expr.thenBranch, expected))
      const seen = [expr.condition]
      for (const elif of expr.elifs) {
        this.withNarrowing(this.boundsAfterAllFalse(seen), elif, () => {
          this.checkElifCondition(elif)
          this.withNarrowing(this.boundsFrom(elif.condition, true), elif.thenBranch, () => this.checkBodyAgainst(elif.thenBranch, expected))
        })
        seen.push(elif.condition)
      }
      const else_ = expr.else_
      this.withNarrowing(this.boundsAfterAllFalse(seen), else_, () => this.checkBodyAgainst(else_, expected))
      this.exprTypes.set(expr, expected)
      return expected
    }

    // ...and into those of an if let, where the binding is in scope.
    if (expr.kind === 'IfExpr' && expr.pattern && expr.else_) {
      const type = this.inferIfLet(expr, expected)
      this.exprTypes.set(expr, type)
      return type
    }

    // Bidirectional: propagate expected type into match-expression arms
    if (expr.kind === 'MatchExpr') {
      this.checkMatchSubject(expr)
      for (const arm of expr.arms) {
        if (arm.body.kind === 'Block' || arm.body.kind === 'ArrowBody') {
          this.checkBodyAgainst(arm.body, expected)
        } else {
          this.checkExpr(arm.body, expected)
        }
      }
      this.exprTypes.set(expr, expected)
      return expected
    }

    const inferred = this.inferExprInner(expr, true)
    const prefix = errorContext ? `${errorContext}: ` : ''

    // Helper to check if sizes include inferred marker
    const hasInferredMarker = (sizes: ArraySize[] | null) => sizes?.includes('_') ?? false
    // Helper to fill in inferred sizes with a concrete number
    const fillInferredSize = (sizes: ArraySize[] | null, len: number): ArraySize[] => {
      if (!sizes) return [len]
      return sizes.map(s => s === '_' ? len : s)
    }

    // Handle comptime_list against array types - propagate element type down
    if (inferred.kind === 'comptime_list' && expected.kind === 'array') {
      // If expected has inferred size, fill it in from the literal length
      let resolvedExpected = expected
      if (hasInferredMarker(expected.sizes) && expr.kind === 'ArrayExpr') {
        resolvedExpected = array(expected.element, fillInferredSize(expected.sizes, expr.elements.length))
      }
      // Check each element against the inner element type
      if (expr.kind === 'ArrayExpr') {
        // Determine what type to check each element against
        // For stacked sizes like [!,!]u8, peel off one level
        const innerType = this.peelArraySize(resolvedExpected)
        for (const elem of expr.elements) {
          this.checkExpr(elem, innerType)
        }
      }
      // Resolve to concrete array type based on expected
      const resolved = this.resolveListToArray(inferred, resolvedExpected)
      // For LSP, record the comptime_list type (not resolved) so user sees the literal type
      if (expr.kind === 'ArrayExpr') {
        this.exprTypes.set(expr, inferred)
      }
      // Collect literal for deferred serialization (concrete types only)
      if (!hasInferredMarker(resolvedExpected.sizes)) {
        this.addLiteral(expr.span.start, expr, resolvedExpected)
      }
      return resolved
    }

    // Handle comptime array ([_]T) against concrete array types
    // Must check each element individually to catch overflow (e.g., [1,10,100,1000]:[4]u8)
    if (
      inferred.kind === 'array' &&
      hasInferredMarker(inferred.sizes) &&
      expected.kind === 'array' &&
      !hasInferredMarker(expected.sizes)
    ) {
      // If expected has inferred size, fill it in from the literal length
      let resolvedExpected = expected
      if (hasInferredMarker(expected.sizes) && expr.kind === 'ArrayExpr') {
        resolvedExpected = array(expected.element, fillInferredSize(expected.sizes, expr.elements.length))
      }
      if (expr.kind === 'ArrayExpr') {
        // Peel sizes to get the element type for checking
        const innerType = this.peelArraySize(resolvedExpected)
        for (const elem of expr.elements) {
          this.checkExpr(elem, innerType)
        }
      }
      // Record the inferred comptime type
      this.exprTypes.set(expr, inferred)
      // Collect literal for deferred serialization
      this.addLiteral(expr.span.start, expr, resolvedExpected)
      // Return concretized type
      return this.concretizeToTarget(inferred, resolvedExpected)
    }

    // Handle pointer-to-array with inferred size: *[_]T
    if (
      expected.kind === 'pointer' &&
      expected.pointee.kind === 'array' &&
      hasInferredMarker(expected.pointee.sizes) &&
      (inferred.kind === 'array' && hasInferredMarker(inferred.sizes)) &&
      expr.kind === 'ArrayExpr'
    ) {
      // Fill in the size from the literal
      const resolvedPointee = array(
        expected.pointee.element,
        fillInferredSize(expected.pointee.sizes, expr.elements.length),
      )
      const resolvedExpected = pointer(resolvedPointee)
      // Check elements
      const innerType = this.peelArraySize(resolvedPointee)
      for (const elem of expr.elements) {
        this.checkExpr(elem, innerType)
      }
      // Record and return
      this.exprTypes.set(expr, inferred)
      this.addLiteral(expr.span.start, expr, resolvedPointee)
      return resolvedExpected
    }

    // (ptr, len) against a slice is that slice, built from its two parts: a
    // value like any other tuple, with nothing to lay out in the data section.
    if (expr.kind === 'TupleExpr' && expr.elements.length === 2 && expected.kind === 'slice') {
      // Its parts are checked like any value that meets a type: a pointer to
      // the slice's elements, as writable as the slice, and a length that an
      // i32 holds (an i64 or a float would be the wrong wasm value).
      const [ptr, len] = expr.elements.map(argValue)
      const ptrType = ptr && this.exprTypes.get(ptr)
      if (ptr && ptrType) this.coerce(ptr, ptrType, manyPointer(expected.element, expected.mutable), 'slice pointer: ')
      const lenType = len && this.exprTypes.get(len)
      if (len && lenType) {
        const type = unwrap(lenType)
        if (isComptimeNumber(type)) this.coerce(len, lenType, primitive('u32'), 'slice length: ')
        else if (type.kind !== 'primitive' || !isInteger(type) || (byteSize(type) ?? 8) > 4) {
          this.error(len.span.start, `slice length: cannot assign ${typeToString(lenType)} to u32`)
        }
      }
      this.exprTypes.set(expr, expected)
      return expected
    }

    // No other tuple is a slice.
    if (expr.kind === 'TupleExpr' && expected.kind === 'slice') {
      this.error(expr.span.start, `${prefix}cannot assign ${typeToString(inferred)} to ${typeToString(expected)}`)
      this.exprTypes.set(expr, expected)
      return expected
    }

    // Array/string literals against pointer/slice/framed-array target: allocate in data section
    const isFramedArray = expected.kind === 'array' && expected.sizes?.some(s => s === '!' || s === '?')
    if (
      this.isDataLiteralExpr(expr) &&
      (expected.kind === 'pointer' && expected.pointee.kind === 'array' ||
       expected.kind === 'slice' ||
       isFramedArray)
    ) {
      const litSize = this.getLiteralSize(expr)
      const arrType: ArrayRT = expected.kind === 'slice'
        ? array(expected.element, [typeof litSize === 'number' ? litSize : 0])
        : expected.kind === 'array'
        ? expected
        : (expected.pointee as ArrayRT)
      // A literal given where a mutable pointer or slice is wanted is `mut`
      // without the keyword: a copy of its own, shared with no other data.
      const targetMut = (expected.kind === 'pointer' && expected.mutable) ||
        (expected.kind === 'slice' && expected.mutable)
      if (targetMut) markMut(expr)
      this.addLiteral(expr.span.start, expr, arrType)
      if (expr.kind === 'ArrayExpr' || expr.kind === 'RepeatExpr' || expr.kind === 'LiteralExpr') {
        (expr as AST.ArrayExpr | AST.RepeatExpr | AST.LiteralExpr).dataId = expr.span.start
      }
      if (expr.kind !== 'ArrayExpr') this.checkStringElements(expr, expected, null, prefix)
      // Propagate element type into array elements
      if (expr.kind === 'ArrayExpr') {
        const innerType = expected.kind === 'slice' ? expected.element
          : expected.kind === 'pointer' && expected.pointee.kind === 'array' ? this.peelArraySize(expected.pointee)
          : null
        if (innerType) {
          // A tuple that is a struct element is checked field by field, like
          // any struct value: its literals take their fields' types. One that
          // is a slice element is its (ptr, len), checked as any slice value.
          const inner = unwrap(innerType).kind
          const counted = expected.kind === 'slice' ? countedElement(innerType) : null
          for (const elem of (expr as AST.ArrayExpr).elements) {
            const asValue = elem.kind === 'TupleExpr' && (inner === 'tuple' || (inner === 'slice' && !groupedExpr(elem)))
            if (this.isDataLiteralExpr(elem) && !asValue) {
              this.validateDataLiteralRange(elem, innerType)
              this.checkStringElements(elem, innerType, counted, prefix)
              this.exprTypes.set(elem, innerType)
            } else {
              this.checkExpr(elem, innerType)
            }
          }
        }
      }
      // The rows of a table are laid out apart from it, at compile time: a
      // row or a cell known only at run time has no place to be stored.
      if (tableRow(expected) && (expr.kind === 'ArrayExpr' || expr.kind === 'RepeatExpr')) {
        for (const row of expr.kind === 'ArrayExpr' ? expr.elements : [expr.value]) {
          if (!this.isConstantInitializer(row)) {
            this.error(row.span.start, `a row of ${typeToString(expected)} is laid out at compile time: its values must be constants`)
          }
        }
      }
      // Record the expected type so codegen knows to emit ptr+len for slices
      this.exprTypes.set(expr, expected)
      return expected
    }

    // Handle array with inferred size against array with known size (e.g., RepeatExpr)
    // [_]T with initializer [value; N] should fill in size from N
    if (
      expected.kind === 'array' &&
      hasInferredMarker(expected.sizes) &&
      inferred.kind === 'array' &&
      isFixedSizes(inferred.sizes)
    ) {
      // Fill in the inferred size from the value's known size
      const inferredTotal = totalElements(inferred.sizes)
      if (inferredTotal !== null) {
        const resolved = array(expected.element, fillInferredSize(expected.sizes, inferredTotal))
        this.exprTypes.set(expr, resolved)
        return resolved
      }
    }

    // Propagate expected type into tuple elements for bidirectional inference
    const unwrappedExpected = unwrap(expected)
    if (unwrappedExpected.kind === 'tuple' && inferred.kind === 'tuple' &&
        unwrappedExpected.fields.length === inferred.fields.length &&
        expr.kind === 'TupleExpr') {
      for (let i = 0; i < unwrappedExpected.fields.length; i++) {
        const value = argValue((expr as AST.TupleExpr).elements[i])
        if (value) {
          this.checkExpr(value, unwrappedExpected.fields[i].type)
        }
      }
      this.exprTypes.set(expr, expected)
      return expected
    }

    // Record the type for LSP hints
    // When checking against an explicit type annotation, prefer the expected type
    // so hovers show what the user wrote (e.g., []u8 not [13]u8 for string literals)
    // Exception: when expected has 'inferred' size, use the resolved type with actual length
    const isComptimeLiteral = inferred.kind === 'comptime_int' || inferred.kind === 'comptime_float' ||
      (inferred.kind === 'array' && (hasInferredMarker(inferred.sizes) || isFixedSizes(inferred.sizes)))
    const expectedHasInferredSize = expected.kind === 'array' && hasInferredMarker(expected.sizes)
    const compatible = typeAssignable(expected, inferred)
    const recordType = expected.kind === 'named' ? expected
      : (isComptimeLiteral && !expectedHasInferredSize && compatible ? expected : inferred)
    this.exprTypes.set(expr, recordType)

    // For other types, check assignability; a constant takes the expected
    // type and a narrower value is marked to be widened. The value of an
    // expression body with several named results fills them in order: its
    // own field names give way to theirs (see checkFuncBody).
    const filled = expected === this.resultsInOrder ? this.resultsFilledBy(inferred) : expected
    this.coerce(expr, inferred, filled, prefix)

    // For return value, concretize based on expected type
    return this.concretizeToTarget(inferred, expected)
  }

  // Peel off one size level from an array type to get the inner element type
  // [N,M]u8 -> [M]u8 (peel first dimension, remaining is M)
  // [N]u8 -> u8 (single dimension, inner type is element)
  // [N][M]u8 -> [M]u8 (element is already an array type)
  // A string literal is bytes, and a slice is counted in elements. So a string
  // can only be a slice, or lie among the elements of one, where an element is
  // one byte: three bytes are not three u32s, nor three quarters of one.
  // `expr` is laid out as a `type`; `counted` is the element type of the slice
  // whose length the bytes of `expr` count towards, if there is one. The array
  // and repeat literals inside a literal are followed from here because they
  // are laid out with it, not checked one by one.
  //
  // What they hold in the end is a value, and it meets the element type as an
  // element of the outermost literal does (`among` says `expr` is one): it
  // widens to it or is an error. So `[true; 3]` is not three u32s, and the
  // i32 of `[n; 3]` is extended before it is stored into i64 slots.
  private checkStringElements(expr: AST.Expr, type: ResolvedType, counted: ResolvedType | null, prefix: string, among = false): void {
    const value = expr
    while (expr.kind === 'AnnotationExpr' || expr.kind === 'GroupExpr') expr = expr.expr
    const t = unwrap(type)
    if (expr.kind === 'LiteralExpr' && expr.value.kind === 'string') {
      const element = t.kind === 'slice' ? t.element : counted
      if (!element || byteSize(element) === 1) return
      const elements = typeToString(element)
      const what = t.kind === 'slice'
        ? `cannot assign a string literal to ${typeToString(type)}`
        : `cannot use a string literal among ${elements} elements`
      const example = isNumeric(element) ? ' ([1, 2, 3])' : ''
      this.error(expr.span.start, `${prefix}${what} — a string is bytes ([]u8); write the ${elements} elements as an array literal${example}`)
      return
    }
    if (expr.kind === 'TupleExpr' || expr.kind === 'CallExpr') {
      // A struct inside a nested literal is checked as any struct value is;
      // (x) around anything else is grouping.
      if (t.kind === 'tuple') this.checkExpr(expr, type)
      else if (expr.kind === 'TupleExpr' && expr.elements.length === 1 && expr.elements[0].value) {
        this.checkStringElements(expr.elements[0].value, type, counted, prefix, among)
      } else if (among) this.checkExpr(value, type)
      return
    }
    if (expr.kind !== 'ArrayExpr' && expr.kind !== 'RepeatExpr') {
      if (among) this.checkExpr(value, type)
      return
    }
    const inner = t.kind === 'slice' ? t.element
      : t.kind === 'pointer' && t.pointee.kind === 'array' ? this.peelArraySize(t.pointee)
      : t.kind === 'array' ? this.peelArraySize(t)
      : type
    const innerCounted = t.kind === 'slice' ? countedElement(inner) : t.kind === 'pointer' ? null : counted
    // Only where the literal is laid out as elements is `inner` their type.
    const elements = inner !== type
    for (const elem of expr.kind === 'ArrayExpr' ? expr.elements : [expr.value]) {
      this.checkStringElements(elem, inner, innerCounted, prefix, elements)
    }
  }

  peelArraySize(t: ArrayRT): ResolvedType {
    // If element is already an array type (nested brackets), use it directly
    if (t.element.kind === 'array') {
      return t.element
    }
    // If we have multiple sizes (multi-dimensional), peel one off
    if (t.sizes && t.sizes.length > 1) {
      return array(t.element, t.sizes.slice(1))
    }
    // Single dimension or no sizes: inner type is just the element
    return t.element
  }

  // Resolve a comptime_list to a concrete array type based on expected type
  resolveListToArray(list: { kind: 'comptime_list'; elements: ResolvedType[] }, expected: ArrayRT): ResolvedType {
    // Size is either expected size or list length
    const sizes = expected.sizes ?? [list.elements.length]
    // Element type from expected
    const elemType = expected.element
    return array(elemType, sizes)
  }

  // Concretize a comptime type to match expected type
  concretizeToTarget(type: ResolvedType, expected: ResolvedType): ResolvedType {
    if (type.kind === 'comptime_int' && expected.kind === 'primitive') {
      return expected
    }
    if (type.kind === 'comptime_float' && expected.kind === 'primitive') {
      return expected
    }
    if (type.kind === 'comptime_list' && expected.kind === 'array') {
      return this.resolveListToArray(type, expected)
    }
    // Handle comptime array type ([_]T) against concrete array type
    if (type.kind === 'array' && type.sizes?.includes('_') && expected.kind === 'array') {
      return expected
    }
    // Fall back to default concretization
    return this.concretize(type)
  }

  // typedByContext: the expression is about to meet an expected type.
  inferExprInner(expr: AST.Expr, typedByContext = false): ResolvedType {
    // Inferring afresh: whatever context marked it for widening before is gone.
    this.coercions.delete(expr)
    switch (expr.kind) {
      case 'LiteralExpr':
        return this.inferLiteral(expr, typedByContext)

      case 'IdentExpr':
        return this.inferIdent(expr)

      case 'CallExpr':
        return this.inferCall(expr)

      case 'BinaryExpr':
        return this.inferBinary(expr)

      case 'UnaryExpr':
        return this.inferUnary(expr)

      case 'MemberExpr':
        return this.inferMember(expr)

      case 'IndexExpr':
        return this.inferIndex(expr)

      case 'SliceExpr':
        return this.inferSlice(expr)

      case 'CoalesceExpr':
        return this.inferCoalesce(expr)

      case 'TupleExpr':
        return this.inferTuple(expr)

      case 'TypeExpr': {
        const shown = expr.type.kind === 'TypeRef' ? expr.type.name : typeToString(this.resolveType(expr.type))
        this.error(expr.span.start, `'${shown}' is a type; a type can only be passed for a comptime parameter`)
        return RECOVERY
      }

      case 'ArrayExpr':
        return this.inferArray(expr, typedByContext)

      case 'RepeatExpr':
        return this.inferRepeat(expr)

      case 'GroupExpr':
        return this.inferExpr(expr.expr)

      case 'SizeofExpr':
        return this.inferSizeof(expr)

      case 'SizeofDataExpr':
        return primitive('u32')

      case 'IfExpr':
        return this.inferIf(expr)

      case 'MatchExpr':
        return this.inferMatch(expr)

      case 'CastExpr': {
        // Explicit cast - always returns the target type (may generate conversion code)
        const from = this.inferExpr(expr.expr)
        const to = this.resolveType(expr.type)
        const problem = castProblem(from, to)
        if (problem) this.error(expr.span.start, problem)
        return to
      }

      case 'AnnotationExpr': {
        // Type annotation - use bidirectional type checking to propagate type down
        // This allows [1,2,3]:[]i8 to know each element should be i8
        let annotationType = this.resolveType(expr.type)
        this.checkExpr(expr.expr, annotationType)
        // Fill in inferred size from literal if annotation has inferred size
        if (annotationType.kind === 'array' && annotationType.sizes?.includes('_')) {
          const literalSize = this.getLiteralSize(expr.expr)
          if (typeof literalSize === 'number') {
            annotationType = array(
              annotationType.element,
              annotationType.sizes.map(s => s === '_' ? literalSize : s),
            )
          }
        }
        if (annotationType.kind === 'pointer' && annotationType.pointee.kind === 'array' &&
            annotationType.pointee.sizes?.includes('_')) {
          const literalSize = this.getLiteralSize(expr.expr)
          if (typeof literalSize === 'number') {
            annotationType = pointer(
              array(annotationType.pointee.element, annotationType.pointee.sizes.map(s => s === '_' ? literalSize : s)),
              annotationType.boundary,
              annotationType.mutable,
            )
          }
        }
        return annotationType
      }
    }
  }

  inferLiteral(expr: AST.LiteralExpr, typedByContext = false): ResolvedType {
    switch (expr.value.kind) {
      case 'int':
        return comptimeInt(expr.value.value)

      case 'float':
        return comptimeFloat(expr.value.value)

      case 'string': {
        // String literals have known length at compile time
        // Default to *[N]u8 - pointer to N-byte array; `mut "ab"` is a
        // writable copy of its own, a *mut [N]u8.
        const len = expr.value.bytes.length
        if (!typedByContext && expr.dataId === undefined) this.unplaced.push(expr)
        return pointer(array(primitive('u8'), [len]), false, !!expr.mut)
      }

      case 'bool':
        return primitive('bool')
    }
  }

  inferIdent(expr: AST.IdentExpr): ResolvedType {
    const sym = this.lookup(expr.name)
    if (!sym) {
      if (PRIMITIVE_NAMES.has(expr.name)) {
        this.error(expr.span.start, `'${expr.name}' is a type; a type can only be passed for a comptime parameter`)
        return RECOVERY
      }
      const similar = this.findSimilar(expr.name)
      const hint = similar ? ` — did you mean '${similar}'?` : ''
      this.error(expr.span.start, `unknown identifier '${expr.name}'${hint}`)
      return primitive('i32')
    }

    // Record this as a reference to the symbol
    this.recordReference(expr.name, expr.span.start)

    switch (sym.kind) {
      case 'local':
      case 'param':
      case 'return':
        return this.narrowedType(expr.name) ?? sym.type
      case 'global':
      case 'def':
        return sym.type

      case 'func':
        if (sym.alias) {
          // It stands for a function chosen at compile time; there is no
          // value of it to hold or to pass at run time.
          this.error(expr.span.start, `'${expr.name}' is a comptime function parameter: it can only be called, or passed on for a comptime function parameter`)
          return RECOVERY
        }
        // Of functions that share the name, the arguments of a call say
        // which is meant, and a value has none: it would be the first one
        // declared, whatever was wanted of it.
        if (this.shared(expr.name) && sym === this.moduleScope.symbols.get(expr.name)) {
          for (const member of this.overloads.get(expr.name) ?? []) this.recordReference(member, expr.span.start)
          this.error(expr.span.start, `'${expr.name}' is the name of several functions: it can only be called, where the arguments say which one`)
          return RECOVERY
        }
        return sym.type

      case 'type':
        // Type used as expression (constructor)
        return sym.type

      case 'typefunc':
        if (sym.valid && !this.contested.has(expr.name)) {
          this.error(expr.span.start, `'${expr.name}' is a generic type: write ${typeFuncForm(sym.decl)}`)
        }
        return RECOVERY

      case 'generic':
        // Where another declaration wanted the name, its uses are not the
        // generic's: the declaration already has the error.
        if (!this.contested.has(expr.name)) {
          this.error(expr.span.start, `generic function '${expr.name}' must be called`)
        }
        return RECOVERY
    }
  }

  // A call is looked at before it is checked, by the call it is an argument
  // or the receiver of, and that one by the next: without a memory each level
  // of a chain would walk all the levels below it again. So a look at a call
  // that is known to check gives its type. A look at one whose errors are
  // listed fails as it did, and so does an attempt at one that failed in an
  // attempt, which keeps nothing of a failure but that it was one. Only a
  // look is cut short: what the check records, it records.
  inferCall(expr: AST.CallExpr): ResolvedType {
    if (this.trial.active) {
      const settled = this.settled.get(expr)
      if (settled) return settled
      const failed = this.failed.get(expr) ?? (this.attempting && this.refused.has(expr) ? RECOVERY : undefined)
      if (failed) {
        this.errorsReported++
        return failed
      }
    }
    const reported = this.errorsReported
    const type = this.inferCallInner(expr)
    if (this.errorsReported > reported) {
      if (this.attempting) this.refused.add(expr)
      else this.failed.set(expr, type)
    }
    return type
  }

  // Whether a look would be cut short at this call
  private known(call: AST.CallExpr): boolean {
    return this.settled.has(call) || this.failed.has(call) || (this.attempting > 0 && this.refused.has(call))
  }

  private inferCallInner(expr: AST.CallExpr): ResolvedType {
    // x.f(a) is the call f(x, a) where x has no member f.
    if (expr.callee.kind === 'MemberExpr' && expr.callee.member.kind === 'field') {
      const result = this.inferMethodCall(expr, expr.callee.object, expr.callee.member.name)
      if (result) return result
    }
    // A generic comes before the builtins, so that a generic named max or min
    // is the one that is called.
    // `named`: the function the callee stands for, where its name alone does
    // not say which that is.
    let named: (Symbol & { kind: 'func' }) | null = null
    // `required`: the call is of the one function of its name, from the body
    // of an instance.
    let required: string | null = null
    if (expr.callee.kind === 'IdentExpr') {
      const name = expr.callee.name
      const sym = this.lookup(name)
      if (sym?.kind === 'generic') return this.inferGenericCall(expr, sym, name)
      if (sym?.kind === 'typefunc') return this.typeAsValue(expr, sym)
      if (sym?.kind === 'func' && sym.alias) {
        // A comptime function parameter, in an instance, is the function it
        // was given: the call compiles as a direct call of that one.
        named = sym
        this.calls.set(expr, { ...expr, callee: { ...expr.callee, name: sym.alias } })
        this.recordReference(name, expr.callee.span.start)
      } else if (sym?.kind === 'func' && sym === this.moduleScope.symbols.get(name)) {
        // Of functions that share the name, the arguments say which is
        // meant.
        const members = this.overloads.get(name) ?? [name]
        if (members.length > 1) {
          const member = this.pickOverload(expr, name, members)
          if (member === null) return RECOVERY
          named = this.moduleScope.symbols.get(member) as Symbol & { kind: 'func' }
          if (member !== name) this.calls.set(expr, { ...expr, callee: { ...expr.callee, name: member } })
          this.recordReference(member, expr.callee.span.start)
        } else if (this.currentInstance && expr.args.filter((a) => a.value).length === sym.type.params.length) {
          // What the body of an instance calls is what it requires of its
          // type arguments: see below, where the arguments are checked.
          named = sym
          required = name
          this.recordReference(name, expr.callee.span.start)
        }
      }
    }
    // A type that is called constructs a value of it: Vec(u32)(p, 0, cap),
    // T(a, b) in an instance, where T was a type parameter, and (T, T)(a, b).
    const built = expr.callee.kind === 'TypeExpr' ? expr.callee.type
      : expr.callee.kind === 'CallExpr' || expr.callee.kind === 'TupleExpr' ? typeOfArg(expr.callee)
      : null
    if (built) return this.inferConstructor(expr, built)

    // Check for builtin functions first. A function the program declares takes
    // the place of the builtin of the same name.
    if (expr.callee.kind === 'IdentExpr') {
      const declared = this.lookup(expr.callee.name)?.kind === 'func'
      const builtinResult = declared ? null : this.inferBuiltin(expr, expr.callee.name)
      if (builtinResult !== null) return builtinResult

      // Primitive type cast: u64(x), f32(x), etc.
      if (PRIMITIVE_NAMES.has(expr.callee.name)) {
        const args = expr.args.filter((a): a is AST.Arg & { value: AST.Expr } => a.value !== null)
        const to = primitive(expr.callee.name as PrimitiveName)
        if (args.length !== 1) {
          this.error(expr.span.start, `type cast '${expr.callee.name}' expects 1 argument, got ${args.length}`)
        } else {
          const problem = castProblem(this.inferExpr(args[0].value), to)
          if (problem) this.error(expr.span.start, problem)
        }
        return to
      }

      // In an instance, a name that is nothing at all is a function the type
      // arguments were required to bring and did not.
      if (this.currentInstance && !this.lookup(expr.callee.name)) {
        const types = expr.args.flatMap((a) => (a.value ? [this.shownArg(a.value, (value) => this.inferExpr(value))] : []))
        this.requirement(expr.span.start, `no function '${expr.callee.name}' accepts (${types.join(', ')})`)
        return RECOVERY
      }
    }

    const calleeType = named ? named.type : this.inferExpr(expr.callee)
    if (named) this.exprTypes.set(expr.callee, calleeType)

    if (calleeType.kind === 'func') {
      // Only a function that is named can be called: the call compiles to
      // a direct call of it. A function held in a variable, a field or a
      // parameter would need an indirect call, which nothing emits.
      const direct = expr.callee.kind === 'IdentExpr' && this.lookup(expr.callee.name)?.kind === 'func'
      if (!direct) {
        this.error(
          expr.span.start,
          `calling a function value is not supported yet: only a function named directly, or a comptime function parameter (comptime f: ${signatureText(calleeType)}), can be called`,
        )
      }

      // Check argument count
      const argCount = expr.args.filter((a) => a.value).length
      if (argCount !== calleeType.params.length) {
        const calleeName = expr.callee.kind === 'IdentExpr' ? `'${expr.callee.name}' ` : ''
        this.error(expr.span.start, `${calleeName}expected ${this.counted(expr, calleeType.params.length, argCount)}`)
      }

      // Use bidirectional type checking for arguments
      // This allows log("message") to propagate *[!u8] to the string literal
      const listed = this.errors.length
      const reported = this.errorsReported
      let argIndex = 0
      for (const arg of expr.args) {
        if (arg.value && argIndex < calleeType.params.length) {
          const paramType = calleeType.params[argIndex].type
          this.checkExpr(arg.value, paramType, this.place(expr, argIndex))
          argIndex++
        }
      }
      if (required !== null && this.errorsReported > reported && this.notAccepted(expr, required, listed)) return RECOVERY

      // Return type of function
      const result = calleeType.returns.length === 0 ? VOID
        : calleeType.returns.length === 1 ? calleeType.returns[0].type
        // Multiple returns become a tuple
        : tuple(calleeType.returns)
      if (this.picked.get(expr) && this.errorsReported === reported) this.settled.set(expr, result)
      return result
    }

    // Constructor call (type used as function): each argument is checked against
    // its field, by position or by name (Point(x: 1, y: 2)), so literals and
    // expressions inside it get concrete types.
    // A `type` that names another name for a struct (type IntVec = Vec(u32))
    // constructs what that one does.
    const namesType = expr.callee.kind === 'IdentExpr' && this.lookup(expr.callee.name)?.kind === 'type'
    const struct = namesType ? unwrap(calleeType) : calleeType
    if (struct.kind === 'tuple') {
      this.checkConstructorArgs(expr, struct, typeToString(calleeType))
      return calleeType
    }

    if (calleeType === RECOVERY) return RECOVERY
    // x.f(a) where f is a field of x that cannot be called, and a function f
    // is there: the field won, and the function was likely meant.
    const field = expr.callee.kind === 'MemberExpr' && expr.callee.member.kind === 'field' ? expr.callee.member.name : null
    const hidden = field === null ? undefined : this.lookup(field)
    if (field !== null && (hidden?.kind === 'func' || hidden?.kind === 'generic')) {
      this.recordReference(field, expr.callee.span.end - field.length)
      this.error(
        expr.span.start,
        `cannot call non-function type: ${typeToString(calleeType)} ('${field}' is a field here, and a field wins over the function '${field}': write ${field}(...))`,
      )
      for (const arg of expr.args) {
        if (arg.value && !typeOfArg(arg.value)) this.inferExpr(arg.value)
      }
      return RECOVERY
    }
    this.error(expr.span.start, `cannot call non-function type: ${typeToString(calleeType)}`)
    return primitive('i32')
  }

  // The arguments of a constructor, each against the field it is for. Gives
  // the arguments each field was given, in the order of the fields.
  private checkConstructorArgs(expr: AST.CallExpr, struct: TupleRT, shown: string): AST.Arg[][] {
    const args = expr.args
    const given = new Map<ResolvedField, AST.Arg[]>()
    if (args.length !== struct.fields.length) {
      this.error(
        expr.span.start,
        `${shown} expects ${struct.fields.length} field${struct.fields.length === 1 ? '' : 's'}, got ${args.length}`,
      )
    }
    args.forEach((arg, i) => {
      // `x:` is shorthand for `x: x`: check the variable it names.
      const value = argValue(arg)
      if (!value) return
      const field = arg.name ? struct.fields.find((f) => f.name === arg.name) : struct.fields[i]
      if (field) {
        given.set(field, [...(given.get(field) ?? []), arg])
        this.checkExpr(value, field.type, `field ${field.name ?? i}`)
      } else {
        if (arg.name) this.error(arg.span.start, `field '${arg.name}' not found in ${shown}`)
        this.inferExpr(value)
      }
    })
    return struct.fields.map((f) => given.get(f) ?? [])
  }

  // Vec(u32)(p, 0, cap), or T(a, b) in an instance: a value of the type the
  // callee is, built from its fields by position or by name. It compiles as
  // the fields' values in the order of the type, which is what the same
  // struct written out as a literal compiles as.
  private inferConstructor(expr: AST.CallExpr, built: AST.Type): ResolvedType {
    const fail = (message?: string): ResolvedType => {
      if (message) this.error(expr.span.start, message)
      // A type among the arguments, T(u8), is part of the same mistake.
      for (const arg of expr.args) {
        const value = argValue(arg)
        if (value && !typeOfArg(value)) this.inferExpr(value)
      }
      return RECOVERY
    }
    const before = this.errorsReported
    const type = this.resolveType(built)
    if (type === RECOVERY || this.errorsReported > before) return fail()
    const struct = unwrap(type)
    if (struct.kind !== 'tuple') {
      return fail(`${typeToString(type)} is not a struct or tuple type: it has no constructor; to convert a number write x as T`)
    }
    const given = this.checkConstructorArgs(expr, struct, typeToString(type))
    if (given.every((args) => args.length === 1)) {
      this.calls.set(expr, { kind: 'TupleExpr', elements: given.map((args) => args[0]), span: expr.span })
    } else if (this.errorsReported === before) {
      // As many arguments as fields, each for a field there is: then one
      // field has two of them.
      const twice = given.findIndex((args) => args.length > 1)
      if (twice >= 0) {
        this.error(given[twice][1].span.start, `${typeToString(type)}: field '${struct.fields[twice].name ?? twice}' is given twice`)
      }
    }
    return type
  }

  // A generic type where a value is expected: applied, it is a type like any
  // other; called without its type arguments, it is not yet one.
  private typeAsValue(expr: AST.CallExpr, sym: Symbol & { kind: 'typefunc' }): ResolvedType {
    const name = (expr.callee as AST.IdentExpr).name
    this.recordReference(name, expr.callee.span.start)
    const applied = typeOfArg(expr)
    if (applied) {
      this.error(expr.span.start, `'${typeText(applied)}' is a type; a type can only be passed for a comptime parameter`)
    } else {
      if (sym.valid && !this.contested.has(name)) {
        this.error(expr.span.start, `'${name}' is a generic type: write ${typeFuncForm(sym.decl)}`)
      }
      for (const arg of expr.args) {
        const value = argValue(arg)
        if (value && !typeOfArg(value)) this.inferExpr(value)
      }
    }
    return RECOVERY
  }

  // Reports what a call asks for and nothing provides. In an instance that
  // is something its body requires of the type arguments, and it is said
  // once for the instance, however many of its calls ask for it.
  private requirement(offset: number, message: string): void {
    if (this.currentInstance) {
      const said = this.atSource(offset, message).message
      if (this.errors.some((e) => e.message === said)) {
        this.errorsReported++
        return
      }
    }
    this.error(offset, message)
  }

  // An argument as a message about its call lists it: by its type, or, where
  // a type was written for a comptime parameter, by that type.
  private shownArg(arg: AST.Expr, typeOf: (arg: AST.Expr) => ResolvedType): string {
    const written = typeOfArg(arg)
    return written ? typeText(written) : typeToString(typeOf(arg))
  }

  // What a message calls the argument at `index` of a call: its place as the
  // call was written. Of x.f(a), which is held as f(x, a), x is the receiver
  // and a the first argument.
  private place(call: AST.CallExpr, index: number): string {
    const receiver = this.receivers.get(call)
    if (!receiver) return `argument ${index + 1}`
    const slot = call.args.findIndex((a) => a.value === receiver)
    return index === slot ? 'receiver' : `argument ${index < slot ? index + 1 : index}`
  }

  // "2 arguments, got 3", counted as the call was written: the receiver of
  // x.f(a) is not one of what stands in the parentheses.
  private counted(call: AST.CallExpr, wanted: number, got: number, between = ', '): string {
    const plural = (n: number) => `${n} argument${n === 1 ? '' : 's'}`
    if (!this.receivers.has(call)) return `${plural(wanted)}${between}got ${got}`
    // A function that takes nothing has no place for a receiver either.
    if (wanted === 0) return `${plural(0)}${between}got ${got}: the receiver is one`
    return `${plural(wanted - 1)} after the receiver${between}got ${got - 1}`
  }

  // A call of `name` with its type arguments written, as a message shows it:
  // in the form the call has, f(u32, ...) or x.f(u32, ...).
  private written(call: AST.CallExpr, name: string, typeArgs: string[], values: number): string {
    const receiver = this.receivers.get(call)
    const rest = values - (receiver ? 1 : 0) > 0 ? ', ...' : ''
    const before = !receiver ? '' : receiver.kind === 'IdentExpr' ? `${receiver.name}.` : '.'
    return `${before}${name}(${typeArgs.join(', ')}${rest})`
  }

  // Which of the functions that share a name a call means: the one whose
  // parameter types are the argument types, or else the only one the
  // arguments can be passed to. Null, with the error reported, when there is
  // none or more than one.
  private pickOverload(expr: AST.CallExpr, name: string, members: readonly string[]): string | null {
    const args = expr.args.flatMap((a) => (a.value ? [a.value] : []))
    const fail = (message?: string): null => {
      if (!this.attempting) this.picked.set(expr, null)
      if (message) this.requirement(expr.span.start, message)
      // A call that failed is still a use of what it tried to call.
      for (const member of members) this.recordReference(member, expr.callee.span.start)
      for (const arg of args) this.inferExpr(arg)
      return null
    }
    const known = this.picked.get(expr)
    if (known) return known
    if (known === null) return fail()

    // What each argument is by itself. One that is nothing by itself takes
    // no part in the first step: an `if` whose branches are literals of two
    // shapes has a type only where a parameter gives it one.
    const alone = args.map((arg) => this.alone(arg))
    const types = alone.flatMap((type) => type ?? [])
    const typed = types.length === args.length

    const candidates = members.flatMap((member) => {
      const sym = this.moduleScope.symbols.get(member)
      return sym?.kind === 'func' && sym.type.params.length === args.length ? [{ member, params: sym.type.params }] : []
    })
    // The type of a value that is only known to lie in a range (a loop
    // counter that is a u32#12) is its type without the range, unless a
    // parameter asks for that very range.
    const key = (type: ResolvedType) => (hasOwnType(type) ? canonicalKey(type) : null)
    const same = (param: ResolvedType, arg: ResolvedType) => key(arg) !== null && key(arg) === key(param)
    let found = typed ? candidates.filter((c) => c.params.every((p, i) => same(p.type, types[i]))) : []
    if (typed && found.length !== 1) found = candidates.filter((c) => c.params.every((p, i) => same(p.type, withoutRanges(types[i]))))
    if (found.length !== 1) found = candidates.filter((c) => args.every((arg, i) => this.fits(arg, c.params[i].type)))
    if (found.length !== 1) {
      // An argument that is nothing by itself, and that no one function gives
      // a type: what is wrong with it is what there is to say.
      if (!typed) return fail()
      const shown = args.map((arg, i) => this.shownArg(arg, () => types[i])).join(', ')
      return fail(found.length === 0 ? `no function '${name}' accepts (${shown})` : `'${name}' is ambiguous for (${shown})`)
    }
    this.picked.set(expr, found[0].member)
    return found[0].member
  }

  // The type an expression has by itself, or null where it has an error of
  // its own, which is not reported: whoever asks goes on to check the
  // expression, against a type that may be the one thing it lacked. A call
  // lacks nothing: it is what it is whatever is expected of it, and its
  // errors are reported here.
  private alone(expr: AST.Expr): ResolvedType | null {
    const look = () => {
      const reported = this.errorsReported
      const type = this.inferExpr(expr)
      return this.errorsReported > reported || unresolved(type) ? null : type
    }
    if (expr.kind !== 'CallExpr') return this.attempt(expr, look)
    const settled = this.settled.get(expr)
    if (settled) return settled
    if (this.failed.has(expr) || (this.attempting && this.refused.has(expr))) return null
    return this.untraced(expr, look)
  }

  // In an instance, arguments that the one function of a name does not take
  // are something the body requires of the type arguments and they do not
  // bring: one error, in place of the one each argument was given (those
  // listed from `listed` on). Only where each argument is something by
  // itself: an error of its own stays as it is.
  private notAccepted(expr: AST.CallExpr, name: string, listed: number): boolean {
    const args = expr.args.flatMap((a) => (a.value ? [a.value] : []))
    const types = args.flatMap((arg) => this.alone(arg) ?? [])
    if (types.length !== args.length) return false
    this.errors.length = listed
    const shown = args.map((arg, i) => this.shownArg(arg, () => types[i])).join(', ')
    this.requirement(expr.span.start, `no function '${name}' accepts (${shown})`)
    return true
  }

  // Whether an argument can be passed for a parameter of this type: it is
  // checked as the argument of a call is, and nothing of the check stays.
  private fits(arg: AST.Expr, type: ResolvedType): boolean {
    return this.attempt(arg, () => {
      const reported = this.errorsReported
      this.checkExpr(arg, type)
      return this.errorsReported === reported
    })
  }

  // x.f(a, b) where x has no member f is the call f(x, a, b): the receiver is
  // the first argument that is not a comptime one, passed as it is written.
  // Gives the type of that call, or null where f is a member of x and the
  // call is one of that member's value.
  private inferMethodCall(expr: AST.CallExpr, receiver: AST.Expr, name: string): ResolvedType | null {
    // What is said of the call is said at the method's name: the calls of a
    // chain all start where the chain does.
    const at = expr.callee.span.end - name.length
    const fail = (message?: string): ResolvedType => {
      if (!this.attempting) this.methodCalls.set(expr, 'failed')
      if (message) this.requirement(at, message)
      this.inferExpr(receiver)
      for (const arg of expr.args) {
        if (arg.value && !typeOfArg(arg.value)) this.inferExpr(arg.value)
      }
      return RECOVERY
    }
    let call = this.methodCalls.get(expr)
    if (call === 'member') return null
    if (call === 'failed') return fail()
    if (!call) {
      // A chain is looked at from where it starts: each of its calls then
      // looks no further down than the call before it.
      const below: AST.CallExpr[] = []
      for (let r = receiver; r.kind === 'CallExpr' && r.callee.kind === 'MemberExpr' && !this.known(r); r = r.callee.object) {
        below.push(r)
      }
      for (let i = below.length - 1; i > 0; i--) this.alone(below[i])
      // Members win, so the receiver's type is needed before anything else.
      // A receiver that is nothing by itself has no members to speak of: it
      // may still be what the function's first parameter takes, as the same
      // expression is when it is written as the first argument.
      const type = this.alone(receiver)
      if (type && hasMember(type, name)) {
        this.methodCalls.set(expr, 'member')
        return null
      }

      // The call is written out with the method's name where it stands, so
      // that what is said about the callee is said there, and so that each
      // call of a chain, which all start where the chain does, has a place
      // of its own.
      const callee: AST.IdentExpr = { kind: 'IdentExpr', name, span: { start: at, end: expr.callee.span.end } }
      const self: AST.Arg = { kind: 'Arg', name: null, value: receiver, span: receiver.span }
      const sym = this.lookup(name)
      const slot = sym?.kind === 'generic' ? receiverSlot(sym.decl, expr.args.length + 1) : 0
      call = {
        kind: 'CallExpr',
        callee,
        args: [...expr.args.slice(0, slot), self, ...expr.args.slice(slot)],
        span: { start: at, end: expr.span.end },
      }
      this.receivers.set(call, receiver)
      // A builtin is a function too, unless something of the program has
      // its name.
      const callable = sym?.kind === 'generic' || sym?.kind === 'func' || (!sym && BUILTIN_NAMES.has(name))
      // With nothing that could take it, what is wrong with the receiver is
      // all there is to say. Functions that share the name and a generic
      // find that out for themselves.
      const single = sym?.kind === 'func' && !this.shared(name) ? sym : null
      const first = single?.type.params[0]?.type
      if (!type && (!callable || (single && !(first && this.fits(receiver, first))))) return fail()
      if (!callable && type) {
        const types = [typeToString(type), ...expr.args.flatMap((a) => (a.value ? [this.shownArg(a.value, (value) => this.peek(value))] : []))]
        return fail(`no field '${name}' on type ${typeToString(type)}, and no function '${name}' accepts (${types.join(', ')})`)
      }
      // A value has no address, and none is taken for it.
      const pointer = sym && type ? this.pointerWanted(sym, name, expr.args, receiver, type) : null
      if (pointer && type) {
        this.recordReference(name, at)
        return fail(`${name} takes ${pointer} first; the receiver is a ${typeToString(type)}, which is held in registers and has no address`)
      }
      this.methodCalls.set(expr, call)
    }
    this.calls.set(expr, call)
    const reported = this.errorsReported
    const result = this.inferExpr(call)
    // A builtin's value can be a constant, which is more than its type.
    if (this.errorsReported === reported && this.lookup(name)) this.settled.set(expr, result)
    return result
  }

  // Whether several functions of the module share this name
  private shared(name: string): boolean {
    return (this.overloads.get(name)?.length ?? 1) > 1
  }

  // The pointer type a function takes as its first argument, where the
  // receiver of a method call is a value of what that pointer points to.
  // A literal is no such value: passed for a pointer it is data in memory,
  // as it is when it is written as the first argument. An array written out
  // is one even where it can't be laid out (a row of a table known only at
  // run time): what is wrong with it is said as it is of the argument.
  private pointerWanted(sym: Symbol, name: string, args: AST.Arg[], value: AST.Expr, receiver: ResolvedType): string | null {
    if (unwrap(receiver).kind === 'pointer' || isArrayLiteral(value)) return null
    const pointsTo = (type: ResolvedType): boolean => {
      const u = unwrap(type)
      return u.kind === 'pointer' && typeAssignable(u.pointee, receiver) && !this.fits(value, type)
    }
    if (sym.kind === 'func') {
      // Of functions that share the name, another may take the value.
      const first = this.shared(name) ? undefined : sym.type.params[0]?.type
      return first && pointsTo(first) ? typeToString(first) : null
    }
    if (sym.kind !== 'generic' || !sym.valid) return null
    const params = genericParams(sym.decl)
    const first = params.find((p) => !p.comptime)
    if (!first || first.type.kind !== 'PointerType') return null
    const typeParams = params.filter(isTypeParam).map((p) => p.ident as string)
    const expand = (applied: AST.TypeApply) => sym.owner.expandTypeApply(applied)
    const bound = new Map<string, ResolvedType>()
    // A type that resolves without a word, or null: this only asks.
    const quietly = (owner: CheckContext, resolve: () => ResolvedType) =>
      owner.attempt(null, () => {
        const reported = owner.errorsReported
        const type = resolve()
        return owner.errorsReported === reported ? type : null
      })
    if (args.length + 1 === params.length) {
      // The type arguments are written, after the receiver.
      params.filter((p) => p !== first).forEach((p, i) => {
        const value = args[i].value
        const written = isTypeParam(p) && value ? typeOfArg(value) : null
        const type = written && quietly(this, () => this.resolveType(written))
        if (type) bound.set(p.ident as string, type)
      })
    } else {
      // The receiver decides them as it would behind the pointer.
      matchType(first.type.pointee, receiver, typeParams, bound, false, expand)
    }
    if (mentionsUnbound(first.type, typeParams, bound, expand)) return null
    const wanted = quietly(sym.owner, () => sym.owner.resolveBound(first.type, bound))
    return wanted && pointsTo(wanted) ? typeToString(wanted) : null
  }

  // Handle builtin functions: memset, memcpy, zero
  // Returns null if not a builtin, otherwise returns the result type.
  // The BuiltinCall entry each one records is what tells codegen that the call
  // is to the builtin: the name alone could be a function of the program's.
  inferBuiltin(expr: AST.CallExpr, name: string): ResolvedType | null {
    if (!BUILTIN_NAMES.has(name)) return null
    const args = expr.args.filter((a): a is AST.Arg & { value: AST.Expr } => a.value !== null)

    switch (name) {
      case 'memzero': {
        // memzero(dest: *[N]T) -> ()
        if (args.length !== 1) {
          this.error(expr.span.start, `memzero expects 1 argument (dest), got ${args.length}`)
          return VOID
        }
        const dest = unwrap(this.checkMemOpPtr(args[0].value, 'memzero dest'))
        // memzero has no length operand: the destination's type gives it.
        if (dest.kind === 'pointer' && dest.pointee.kind === 'array' && dest.pointee.sizes !== null && byteSize(dest.pointee) === null) {
          this.error(args[0].value.span.start, `memzero dest: ${typeToString(dest)} has no size known at compile time`)
        }
        this.types.set(typeKey(expr.span.start, 'BuiltinCall'), VOID)
        return VOID
      }

      case 'memset': {
        // memset(dest: *[N]T, value: u8, len: u32) -> ()
        if (args.length !== 3) {
          this.error(expr.span.start, `memset expects 3 arguments (dest, value, len), got ${args.length}`)
          return VOID
        }

        this.checkMemOpPtr(args[0].value, 'memset dest')
        this.checkExpr(args[1].value, primitive('u8'), 'memset value')
        this.checkExpr(args[2].value, primitive('u32'), 'memset len')
        this.checkMemOpBounds(args[0].value, args[2].value, 'memset')

        this.types.set(typeKey(expr.span.start, 'BuiltinCall'), VOID)
        return VOID
      }

      case 'memcpy': {
        // memcpy(dest: *[_]u8, src: *[_]u8, len: u32) -> ()
        if (args.length !== 3) {
          this.error(expr.span.start, `memcpy expects 3 arguments (dest, src, len), got ${args.length}`)
          return VOID
        }

        this.checkMemOpPtr(args[0].value, 'memcpy dest')
        this.checkMemOpPtr(args[1].value, 'memcpy src', true)
        this.checkExpr(args[2].value, primitive('u32'), 'memcpy len')
        this.checkMemOpBounds(args[0].value, args[2].value, 'memcpy')
        this.checkMemOpBounds(args[1].value, args[2].value, 'memcpy')

        this.types.set(typeKey(expr.span.start, 'BuiltinCall'), VOID)
        return VOID
      }

      // Float-only: sqrt, ceil, floor, trunc, nearest, copysign
      case 'sqrt':
      case 'ceil':
      case 'floor':
      case 'trunc':
      case 'nearest':
      case 'copysign': {
        const arity = name === 'copysign' ? 2 : 1
        if (args.length !== arity) {
          this.error(expr.span.start, `${name} expects ${arity} argument${arity === 1 ? '' : 's'}, got ${args.length}`)
          return primitive('f64')
        }
        return this.builtinOperandType(expr, name, args, 'float')
      }

      // Numeric binary: min, max (works for all numeric types)
      case 'min':
      case 'max': {
        if (args.length !== 2) {
          this.error(expr.span.start, `${name} expects 2 arguments, got ${args.length}`)
          return primitive('i32')
        }
        return this.builtinOperandType(expr, name, args, 'numeric')
      }

      // Numeric unary: abs (works for floats and integers; an unsigned value is its own abs)
      case 'abs': {
        if (args.length !== 1) {
          this.error(expr.span.start, `abs expects 1 argument, got ${args.length}`)
          return primitive('i32')
        }
        return this.builtinOperandType(expr, name, args, 'numeric')
      }

      // Integer-only unary: clz, ctz, popcnt. The count fits a u8 whatever the
      // operand's width, so it widens to any integer type.
      case 'clz':
      case 'ctz':
      case 'popcnt': {
        if (args.length !== 1) {
          this.error(expr.span.start, `${name} expects 1 argument, got ${args.length}`)
          return primitive('u8')
        }
        const operandType = this.builtinOperandType(expr, name, args, 'integer')
        // The count is of the operand's own bits, and wasm counts in 32 or 64.
        if (intBitWidth(operandType) !== 32 && intBitWidth(operandType) !== 64) {
          this.error(args[0].value.span.start, `${name} requires i32, u32, i64 or u64, got ${typeToString(operandType)}`)
        }
        return primitive('u8')
      }

      // sizeof(T) - returns byte size of a type as comptime u32
      case 'sizeof': {
        if (args.length !== 1) {
          this.error(expr.span.start, `sizeof expects 1 argument (a type), got ${args.length}`)
          return comptimeInt(0n)
        }

        // The argument should be a type name (identifier)
        const arg = args[0].value
        if (arg.kind !== 'IdentExpr') {
          this.error(arg.span.start, `sizeof expects a type name, got ${arg.kind}`)
          return comptimeInt(0n)
        }

        // Look up the type
        const sym = this.moduleScope.symbols.get(arg.name)
        if (!sym || sym.kind !== 'type') {
          this.error(arg.span.start, `sizeof: unknown type '${arg.name}'`)
          return comptimeInt(0n)
        }

        // Compute byte size
        const size = byteSize(sym.type)
        if (size === null) {
          this.error(arg.span.start, `sizeof: cannot compute size of type '${arg.name}' (dynamically sized)`)
          return comptimeInt(0n)
        }

        // Record as builtin call for codegen
        this.types.set(typeKey(expr.span.start, 'BuiltinCall'), comptimeInt(BigInt(size)))
        return comptimeInt(BigInt(size))
      }

      case 'mul_hi': {
        if (args.length !== 2) {
          this.error(expr.span.start, `mul_hi expects 2 arguments, got ${args.length}`)
          return primitive('u64')
        }
        // The product is of two u64s, so that is the type the operands meet at.
        this.builtinOperandType(expr, name, args, 'integer', primitive('u64'))
        return primitive('u64')
      }

      default:
        return null // Not a builtin
    }
  }

  // Types the operands of a numeric builtin together, the way a binary operator
  // types its own: typed operands meet at the wider type, and a literal takes
  // that type wherever it stands, so max(1.0, x) is max(x, 1.0). With only
  // literals it's their default type. A builtin that computes in one type
  // only (mul_hi) gives it as `fixed`: every operand has to widen to it.
  // A narrower operand is marked to be widened like any other value (coerce).
  // Records the type the builtin computes in for codegen and returns the type
  // of its result, for a builtin that returns one of its operands.
  private builtinOperandType(
    expr: AST.CallExpr,
    name: string,
    args: { value: AST.Expr }[],
    kind: 'float' | 'integer' | 'numeric',
    fixed: ResolvedType | null = null,
  ): ResolvedType {
    const accepts = kind === 'float' ? isFloat : kind === 'integer' ? isInteger : isNumeric
    const wanted = kind === 'float' ? 'a float type' : kind === 'integer' ? 'an integer type' : 'a numeric type'
    // What checking goes on with after an operand of the wrong kind.
    const fallback = primitive(kind === 'float' ? 'f64' : 'i32')
    const types = args.map((arg) => this.inferExpr(arg.value))
    // Inference types an `if` or a `match` from all of its arms, and leaves it
    // without a type when one of them has no value. Checking it against the
    // type of the other operands is what says which arm that is.
    const branching = args.map((arg) => arg.value.kind === 'IfExpr' || arg.value.kind === 'MatchExpr')
    // An operand that takes its type from the others: a constant, and a
    // branching one that inference left without a type.
    const hasTyped = fixed !== null || types.some((t) => !isComptime(t) && accepts(t))
    const fromOthers = types.map((t, i) => isComptime(t) || (hasTyped && branching[i] && t.kind === 'void'))

    let common = fixed
    for (const [i, type] of types.entries()) {
      if (fromOthers[i]) continue
      if (!accepts(type)) {
        this.error(args[i].value.span.start, `${name} requires ${wanted}, got ${typeToString(type)}`)
        return fallback
      }
      const plain = stripMax(type)
      if (common === null || (!fixed && !typeAssignable(common, plain) && typeAssignable(plain, common))) {
        common = plain
      } else if (!typeAssignable(common, plain)) {
        this.error(args[i].value.span.start, `${name}: cannot assign ${typeToString(type)} to ${typeToString(common)}`)
        return common
      }
    }
    if (common === null) {
      const floatLiteral = types.find((t) => t.kind === 'comptime_float')
      if (floatLiteral && kind === 'integer') {
        this.error(args[0].value.span.start, `${name} requires ${wanted}, got ${typeToString(floatLiteral)}`)
        return fallback
      }
      // The default type is the configured one (TypecheckOptions). Integers
      // too big for an i32 are an i64 whichever that is.
      const sized = this.unifyTypes(types)
      common = floatLiteral || kind === 'float' ? concretizeType(comptimeFloat(0), this.options)
        : typeEquals(sized, primitive('i32')) ? concretizeType(comptimeInt(0n), this.options)
        : sized
    }
    for (const [i, type] of types.entries()) {
      if (fromOthers[i]) this.checkExpr(args[i].value, common, name)
      else this.coerce(args[i].value, type, common, `${name}: `)
    }
    this.types.set(typeKey(expr.span.start, 'BuiltinCall'), common)

    // A result that is one of the operands is in a range when they all are: the
    // widest of their ranges. A literal only has to fit the type to be an
    // operand, but has to be inside that range for the result to be. Only a
    // constant whose value is known counts as one, and a branching operand
    // never does: no one arm's value or range speaks for the others.
    const ranges = types.flatMap((t) => (t.kind === 'primitive' && t.max !== undefined ? [t.max] : []))
    if (common.kind !== 'primitive' || ranges.length === 0) return common
    const widest = Math.max(...ranges)
    const inRange = types.every((t, i) => {
      if (branching[i]) return false
      if (t.kind === 'primitive') return t.max !== undefined
      const constant = isComptime(t) ? this.evalComptimeExpr(args[i].value) : null
      return constant?.kind === 'int' && constant.value >= 0n && constant.value < BigInt(widest)
    })
    return inRange ? primitive(common.name, widest) : common
  }

  inferBinary(expr: AST.BinaryExpr): ResolvedType {
    const leftType = this.inferExpr(expr.left)
    const rightType = this.inferExpr(expr.right)
    if (leftType === RECOVERY || rightType === RECOVERY) {
      return ['==', '!=', '<', '>', '<=', '>=', '&&', '||'].includes(expr.op) ? primitive('bool') : RECOVERY
    }
    const op = expr.op

    if (op === '&&' || op === '||') {
      this.requireBool(expr.left, leftType, `operand of '${op}'`)
      this.requireBool(expr.right, rightType, `operand of '${op}'`)
      return primitive('bool')
    }

    const left = unwrap(leftType)
    const right = unwrap(rightType)
    const comparison = COMPARISON_OPS.has(op)
    // The type the expression keeps when its operands are rejected: the wider
    // operand's, which is the likeliest to let checking go on without a
    // second error.
    const wider = (isFloat(right) && !isFloat(left)) || (byteSize(right) ?? 0) > (byteSize(left) ?? 0)
    const fallback = comparison ? primitive('bool') : stripMax(wider ? rightType : leftType)

    // A string is bytes in memory, never a character: next to a number its
    // value would be its address. Quotes of either kind make a string.
    const string = (operand: AST.Expr): AST.LiteralExpr | null => {
      let e = ungrouped(operand)
      while (e.kind === 'AnnotationExpr') e = ungrouped(e.expr)
      return e.kind === 'LiteralExpr' && e.value.kind === 'string' ? e : null
    }
    const isAddress = (t: ResolvedType) => t.kind === 'pointer' || t.kind === 'func' || t.kind === 'slice'
    const lone = string(expr.left) && !string(expr.right) && !isAddress(right) ? string(expr.left)
      : string(expr.right) && !string(expr.left) && !isAddress(left) ? string(expr.right)
      : null
    if (lone?.value.kind === 'string') {
      const shown = (operand: AST.Expr, type: ResolvedType) => (string(operand) === lone ? 'a string' : typeToString(type))
      const bytes = lone.value.bytes
      const hint = bytes.length === 1 ? `; write its byte as a number (${bytes[0]})` : ''
      this.error(expr.span.start, `'${op}' cannot be applied to ${shown(expr.left, leftType)} and ${shown(expr.right, rightType)} — a string is bytes in memory, not a character${hint}`)
      return comparison ? primitive('bool') : this.concretize(stripMax(lone === string(expr.left) ? rightType : leftType))
    }

    if (!isScalar(left) || !isScalar(right)) {
      this.checkAddressOperands(expr, leftType, rightType)
      return fallback
    }

    const problem = operandProblem(op, leftType) ?? operandProblem(op, rightType)
    if (problem) {
      this.error(expr.span.start, problem)
      return fallback
    }

    // Arithmetic with a comptime constant propagates ranges:
    //   u32#4 + 4 → u32#8    (max value: 3+4=7, so <8)
    //   u32#6 * 20 → u32#120 (max value: 5*20=100, so <120... actually (6-1)*20+1 is wrong)
    // For +: u32#N + K → u32#(N+K)      max val is (N-1)+K, so < N+K
    // For *: u32#N * K → u32#((N-1)*K+1) max val is (N-1)*K, so < (N-1)*K+1
    // For an unsigned value and a constant K >= 0:
    //   x & K  → max value K          x % K → max value K-1 (K > 0)
    //   x >> K → max value (max >> K), where max is the range or the type's width
    // The bound comes from the constant's own value. An if or match of
    // constants has a constant type but no one value: no range from that.
    const computeRange = (base: ResolvedType, constant: AST.Expr, constantOnRight: boolean): ResolvedType => {
      const value = this.evalComptimeExpr(constant)
      if (base.kind !== 'primitive' || value?.kind !== 'int' || value.value < 0n) return stripMax(base)
      const operand = value.value
      const limit = (bound: bigint): ResolvedType => {
        const current = base.max !== undefined ? BigInt(base.max) : unsignedLimit(base)
        const next = current !== null && current < bound ? current : bound
        return next <= BigInt(Number.MAX_SAFE_INTEGER) ? primitive(base.name, Number(next)) : stripMax(base)
      }
      if (isUnsignedName(base.name)) {
        if (expr.op === '&') return limit(operand + 1n)
        if (expr.op === '%' && constantOnRight && operand > 0n) return limit(operand)
        if (expr.op === '>>' && constantOnRight) {
          // The count as the shift takes it: modulo the width it's done in.
          const max = base.max !== undefined ? BigInt(base.max) : unsignedLimit(base)
          const width = shiftWidth(base)
          if (max !== null && width) return limit(((max - 1n) >> (operand & BigInt(width - 1))) + 1n)
        }
      }
      if (base.max === undefined) return stripMax(base)
      if (expr.op === '+') return primitive(base.name, base.max + Number(operand))
      if (expr.op === '*' && operand > 0n) return primitive(base.name, (base.max - 1) * Number(operand) + 1)
      return stripMax(base)
    }

    // Two constants: the operands take the result's type, so that 1.0 + 2 is
    // a float addition and 5000000000 + 1 a 64-bit one, whatever type the
    // context then gives the whole expression.
    if (isComptimeNumber(left) && isComptimeNumber(right)) {
      if (comparison) {
        const type = left.kind === 'comptime_float' || right.kind === 'comptime_float'
          ? this.concretize(comptimeFloat(0))
          : this.unifyTypes([left, right])
        this.coerce(expr.left, leftType, type)
        this.coerce(expr.right, rightType, type)
        return primitive('bool')
      }
      const result = this.constantResult(expr, left, right)
      this.typeConstant(expr.left, result, leftType)
      this.typeConstant(expr.right, result, rightType)
      return result
    }

    if (SHIFT_OPS.has(op)) {
      // 1 << n has n's type.
      if (left.kind === 'comptime_int') {
        const type = stripMax(rightType)
        this.coerce(expr.left, leftType, type)
        return type
      }
      if (right.kind === 'comptime_int') {
        this.coerce(expr.right, rightType, stripMax(leftType))
        return computeRange(leftType, expr.right, true)
      }
      // The count keeps its own type: only its low bits matter. The value is
      // shifted in its own type too, unless the count is wider: then in the
      // count's width, with the value's sign (u8 << u32 is a 32-bit shift).
      // A rotation is always within the value's own width.
      const width = byteSize(right) ?? 0
      const rotation = op === '<<<' || op === '>>>'
      if (rotation || width <= (byteSize(left) ?? 0)) return stripMax(leftType)
      const type = primitive(`${isSigned(left) ? 'i' : 'u'}${width * 8}` as PrimitiveName)
      this.coerce(expr.left, leftType, type)
      return type
    }

    // A constant takes the other operand's plain type: comparing a u32#8 with
    // a literal, or x % 12, shouldn't need the literal to be below the range.
    if (isComptimeNumber(left) || isComptimeNumber(right)) {
      const constantOnRight = isComptimeNumber(right)
      const constant = constantOnRight ? right : left
      const [constantExpr, otherExpr] = constantOnRight ? [expr.right, expr.left] : [expr.left, expr.right]
      const otherType = constantOnRight ? leftType : rightType
      // A float constant next to an integer is a float operation, when the
      // integer widens to the default float: n * 1.5 with an i32 n is an f64.
      const float = this.concretize(comptimeFloat(0))
      if (constant.kind === 'comptime_float' && isInteger(otherType) && typeAssignable(float, stripMax(otherType))) {
        this.coerce(constantExpr, constant, float)
        this.coerce(otherExpr, otherType, float)
        return comparison ? primitive('bool') : float
      }
      this.coerce(constantExpr, constant, stripMax(otherType))
      if (comparison) return primitive('bool')
      return constant.kind === 'comptime_int' ? computeRange(otherType, constantExpr, constantOnRight) : stripMax(otherType)
    }

    // Two values: the narrower one widens to the other's type. Types neither
    // of which holds the other (i32 and u32, i32 and f32) need a cast.
    const plainLeft = stripMax(leftType)
    const plainRight = stripMax(rightType)
    let type: ResolvedType
    if (typeEquals(unwrap(plainLeft), unwrap(plainRight)) || typeAssignable(plainLeft, plainRight)) {
      type = plainLeft
    } else if (typeAssignable(plainRight, plainLeft)) {
      type = plainRight
    } else {
      this.error(expr.span.start, `mismatched operands for '${op}': ${typeToString(leftType)} and ${typeToString(rightType)} (cast one side explicitly)`)
      return fallback
    }
    this.coerce(expr.left, leftType, type)
    this.coerce(expr.right, rightType, type)
    return comparison ? primitive('bool') : type
  }

  // The type of a constant operator expression: its value when that can be
  // computed, so that the context can check it fits. An operand further from
  // zero stands in for it, so that the type the expression defaults to holds
  // its operands too: 5000000000 - 4999999999 is an i64 subtraction.
  private constantResult(expr: AST.BinaryExpr, left: ResolvedType, right: ResolvedType): ResolvedType {
    if (left.kind === 'comptime_int' && right.kind === 'comptime_int') {
      const value = this.evalComptimeExpr(expr)
      // Bitwise operators and shifts keep a bit pattern one: ~0 << 4, ~3 | 1.
      const bits = (left.bits || right.bits) && (BITWISE_OPS.has(expr.op) || SHIFT_OPS.has(expr.op))
      const result: ResolvedType = value?.kind === 'int' ? comptimeInt(value.value, bits) : left
      return [left, right].reduce((widest, t) => (magnitude(t) > magnitude(widest) ? t : widest), result)
    }
    const number = (t: ResolvedType) => (t.kind === 'comptime_int' || t.kind === 'comptime_float' ? Number(t.value) : 0)
    const l = number(left)
    const r = number(right)
    switch (expr.op) {
      case '+': return comptimeFloat(l + r)
      case '-': return comptimeFloat(l - r)
      case '*': return comptimeFloat(l * r)
      case '/': return comptimeFloat(l / r)
      default: return comptimeFloat(l)
    }
  }

  // An operator with a pointer operand works on addresses, which are 32 bits:
  // the other operand is a pointer too, or an integer no wider than that.
  private checkAddressOperands(expr: AST.BinaryExpr, leftType: ResolvedType, rightType: ResolvedType): void {
    const check = (operand: AST.Expr, type: ResolvedType): boolean => {
      const t = unwrap(type)
      if (t.kind === 'pointer' || t.kind === 'func') return true
      if (t.kind === 'comptime_int') {
        this.coerce(operand, type, addressType(t))
        return true
      }
      return isInteger(t) && (byteSize(t) ?? 8) <= 4
    }
    const leftOk = check(expr.left, leftType)
    const rightOk = check(expr.right, rightType)
    if (!leftOk || !rightOk) {
      this.error(expr.span.start, noOperator(expr.op, leftType, rightType))
    }
  }

  private checkCondition(expr: AST.Expr): void {
    this.requireBool(expr, this.inferExpr(expr), 'condition')
  }

  // `elif let x = e` tests an optional, not a bool.
  private checkElifCondition(elif: AST.ElifBranch): void {
    if (elif.pattern) this.inferExpr(elif.condition)
    else this.checkCondition(elif.condition)
  }

  // Report a condition or logical operand that isn't a bool: there is no
  // implicit truthiness.
  private requireBool(expr: AST.Expr, type: ResolvedType, what: string): void {
    if (type !== RECOVERY && !isBool(type)) {
      this.error(expr.span.start, `${what} must be bool, not ${typeToString(type)}`)
    }
  }

  // Make an expression, already inferred as `actual`, give a value of type
  // `expected`. A constant takes the type itself, down to its literals. A
  // narrower value keeps its type and is marked to be widened where it's
  // used. Anything else is an error.
  private coerce(expr: AST.Expr, actual: ResolvedType, expected: ResolvedType, prefix = ''): void {
    // Its error is already reported: what it is used for says nothing more.
    // Nor does what is assigned to something of a type that did not resolve.
    if (actual === RECOVERY || unresolved(expected)) return
    const from = unwrap(actual)
    const to = unwrap(expected)
    // An array literal's own type is a guess from its elements ([0.5, x] an
    // f64 one). With the right number of them, what counts is that each fits
    // its place, which is checked below.
    const literal = expr.kind === 'ArrayExpr' || expr.kind === 'RepeatExpr'
    const elementwise = literal && from.kind === 'comptime_array' && to.kind === 'array'
      && to.sizes?.length === 1 && to.sizes[0] === from.count
    if (!elementwise && !typeAssignable(expected, actual)) {
      this.error(expr.span.start, `${prefix}cannot assign ${typeToString(actual)} to ${typeToString(expected)}`)
      return
    }
    const grouped = groupedExpr(expr)
    if (to.kind === 'primitive' && isComptimeNumber(from)) {
      this.typeConstant(expr, expected, actual)
    } else if (to.kind === 'pointer' && from.kind === 'comptime_int') {
      // A constant address is a 32-bit value, whatever it's computed from.
      this.coerce(expr, actual, addressType(from), prefix)
      this.exprTypes.set(expr, expected)
    } else if (to.kind === 'primitive' && from.kind === 'primitive') {
      if (from.name !== to.name) {
        this.exprTypes.set(expr, actual)
        this.coercions.set(expr, expected)
      }
    } else if (grouped && from.kind === 'tuple' && to.kind === 'tuple') {
      // (e) is e: a tuple in parentheses is converted as it is without them.
      this.coerce(grouped, actual, expected, prefix)
    } else if (expr.kind === 'TupleExpr' && from.kind === 'tuple' && to.kind === 'tuple') {
      // A tuple literal is converted element by element.
      for (const [i, element] of expr.elements.entries()) {
        const value = argValue(element)
        if (value) this.coerce(value, from.fields[i].type, to.fields[i].type, prefix)
      }
    } else if ((expr.kind === 'ArrayExpr' || expr.kind === 'RepeatExpr') && from.kind === 'comptime_array' && to.kind === 'array') {
      // So is an array literal held in registers. (One that goes to the data
      // section has had its elements checked against the element type.)
      const elementType = this.peelArraySize(to)
      for (const element of expr.kind === 'ArrayExpr' ? expr.elements : [expr.value]) {
        const type = this.exprTypes.get(element)
        if (type) this.coerce(element, type, elementType, prefix)
      }
    } else if (!sameRepresentation(from, to)) {
      // Any other struct or tuple value is several wasm values already on
      // the stack: its fields can't be widened in place.
      this.error(expr.span.start, `${prefix}cannot convert ${typeToString(actual)} to ${typeToString(expected)} implicitly: convert its fields`)
    }
  }

  // Give a constant expression the type it's used as. Its operands are
  // constants too, so the type goes down to the literals: 1.0 / 3 as an f32
  // is an f32 division of two f32 constants. `type` is a concrete type, or
  // the comptime type of an enclosing constant expression; `actual` is the
  // comptime type the expression was inferred as.
  private typeConstant(expr: AST.Expr, type: ResolvedType, actual: ResolvedType, checkLiterals = true): void {
    const again = (inner: AST.Expr, check = checkLiterals) => {
      const innerType = this.exprTypes.get(inner)
      if (innerType && isComptimeNumber(unwrap(innerType))) this.typeConstant(inner, type, innerType, check)
      else if (innerType && !isComptimeNumber(unwrap(type))) this.coerce(inner, innerType, type)
    }
    // A branch is one of the values the expression can have, so it has to be
    // a value of the type by itself, not only literal by literal: -1 is no
    // branch of a u32. A default type is chosen to hold its integers; as a
    // float it has to hold them exactly.
    // With a negative branch the default is a signed type, and the other
    // branches have to be values of it too, not only bits it has: no 64-bit
    // type holds both -1 and 18446744073709551615.
    const least = checkLiterals ? null : this.leastBranch(expr)
    const tail = (body: AST.FuncBody | AST.Expr) => {
      const value = bodyValue(body)
      if (!value) return
      const own = this.branchConstants.get(value)
      const checked = checkLiterals || isFloat(type) || (least !== null && least < 0n)
      if (own && checked && !isComptimeNumber(unwrap(type)) && !typeAssignable(type, own)) {
        this.error(value.span.start, `cannot assign ${typeToString(own)} to ${typeToString(type)}`)
        again(value, false)
      } else {
        again(value)
      }
    }
    switch (expr.kind) {
      case 'LiteralExpr': {
        // Each literal has to fit by its own value: 1.0 + 16777217 isn't an f32.
        // One that isn't checked that way (the operand of a negation, a
        // constant with no type but its default) still has to be a number
        // the type has the bits for: 18446744073709551616 is no i64.const.
        const own = this.inferLiteral(expr)
        const fits = checkLiterals ? typeAssignable(type, own) : own.kind !== 'comptime_int' || hasBitsFor(type, own.value)
        if (!isComptimeNumber(type) && !fits) {
          this.error(expr.span.start, `cannot assign ${typeToString(own)} to ${typeToString(type)}`)
        }
        break
      }
      case 'GroupExpr':
      case 'TupleExpr': {
        const inner = groupedExpr(expr)
        if (inner) again(inner)
        break
      }
      case 'UnaryExpr':
        if (expr.op === '~' && (isFloat(type) || type.kind === 'comptime_float')) {
          this.error(expr.span.start, `'~' needs an integer, not ${typeToString(type)}`)
        }
        // The operand of a negation is only in range once negated: -(128) is an i8.
        again(expr.operand, false)
        break
      case 'BinaryExpr': {
        // 7 % 2 can't be computed as a float, nor 1 / 3 as an i128 yet.
        const problem = operandProblem(expr.op, type)
        if (problem) this.error(expr.span.start, problem)
        again(expr.left)
        again(expr.right)
        break
      }
      case 'IfExpr':
        tail(expr.thenBranch)
        for (const elif of expr.elifs) tail(elif.thenBranch)
        if (expr.else_) tail(expr.else_)
        break
      case 'MatchExpr':
        for (const arm of expr.arms) tail(arm.body)
        break
      default: {
        // A constant with a fixed form (items.len, sizeof(T)) is emitted in its
        // default type and converted like any other value.
        if (isComptimeNumber(unwrap(type))) return
        const own = this.concretize(actual)
        this.exprTypes.set(expr, own)
        const from = unwrap(own)
        const to = unwrap(type)
        if (from.kind === 'primitive' && to.kind === 'primitive' && from.name !== to.name) {
          this.coercions.set(expr, type)
        }
        return
      }
    }
    this.exprTypes.set(expr, type)
  }

  // The least constant an if or match of constants can be, through branches
  // that are ifs or matches themselves. Null for any other expression. A
  // complement doesn't count: ~0 is a bit pattern, not a negative value.
  private leastBranch(expr: AST.Expr): bigint | null {
    const bodies = expr.kind === 'IfExpr' ? [expr.thenBranch, ...expr.elifs.map(elif => elif.thenBranch), expr.else_]
      : expr.kind === 'MatchExpr' ? expr.arms.map(arm => arm.body)
      : null
    if (!bodies) return null
    let least: bigint | null = null
    for (const body of bodies) {
      const value = body && bodyValue(body)
      const own = value && this.branchConstants.get(value)
      if (!value || !own || (own.kind === 'comptime_int' && own.bits)) continue
      const inner = groupedExpr(value) ?? value
      const constant = this.evalComptimeExpr(inner)
      const low = inner.kind === 'IfExpr' || inner.kind === 'MatchExpr' ? this.leastBranch(inner)
        : constant?.kind === 'int' ? constant.value
        : null
      if (low !== null && (least === null || low < least)) least = low
    }
    return least
  }

  inferUnary(expr: AST.UnaryExpr): ResolvedType {
    // &items[i] is checked as an address, without the bounds rules for reading.
    if (expr.op === '&' && expr.operand.kind === 'IndexExpr') {
      const addr = this.addressOfIndex(expr.operand)
      if (addr) return addr
    }
    const operandType = this.inferExpr(expr.operand)
    const operand = unwrap(operandType)

    switch (expr.op) {
      case '!':
        this.requireBool(expr.operand, operandType, `operand of '!'`)
        return primitive('bool')
      case '-':
        if (operand.kind === 'comptime_int') return comptimeInt(-operand.value)
        if (operand.kind === 'comptime_float') return comptimeFloat(-operand.value)
        if (!isNumeric(operand)) {
          this.error(expr.span.start, `'-' needs a number, not ${typeToString(operandType)}`)
        }
        // The operand's range doesn't survive: -x of a u32#8 isn't below 8.
        return stripMax(operandType)
      case '~':
        // A bit pattern: ~3 is -4, and in a u32 it's 0xfffffffc.
        if (operand.kind === 'comptime_int') return comptimeInt(~operand.value, true)
        if (!isInteger(operand)) {
          this.error(expr.span.start, `'~' needs an integer, not ${typeToString(operandType)}`)
        }
        return stripMax(operandType)
      case '&': {
        if (expr.operand.kind === 'IndexExpr') {
          const addr = this.addressOfIndex(expr.operand)
          if (addr) return addr
        }
        if (operandType.kind === 'pointer' || operandType.kind === 'slice') {
          return operandType
        }
        // Address-of on a value: anonymous data section allocation
        const innerExpr = expr.operand
        const litExpr = innerExpr.kind === 'AnnotationExpr' ? innerExpr.expr : innerExpr
        if (litExpr.kind === 'LiteralExpr' || litExpr.kind === 'ArrayExpr' ||
            litExpr.kind === 'RepeatExpr' || litExpr.kind === 'TupleExpr') {
          const dataId = litExpr.span.start
          if (litExpr.kind === 'LiteralExpr' || litExpr.kind === 'ArrayExpr' || litExpr.kind === 'RepeatExpr') {
            (litExpr as AST.LiteralExpr | AST.ArrayExpr | AST.RepeatExpr).dataId = dataId
          }
          const arrType: ArrayRT = { kind: 'array', element: operandType, sizes: [1] }
          // &literal is a writable cell of its own: never share its bytes.
          markMut(litExpr)
          this.addLiteral(dataId, litExpr, arrType)
          return pointer(operandType, false, true)
        }
        this.error(expr.span.start, `& requires a literal or a pointer/slice operand`)
        return pointer(operandType, false, true)
      }
    }
  }

  inferMember(expr: AST.MemberExpr): ResolvedType {
    const objType = this.inferExpr(expr.object)
    if (unresolved(objType)) return RECOVERY

    // Unwrap named types to access underlying structure
    const unwrappedType = unwrap(objType)

    switch (expr.member.kind) {
      case 'field': {
        const fieldName = expr.member.name
        // Look up field in tuple/struct
        if (unwrappedType.kind === 'tuple') {
          const f = unwrappedType.fields.find((f) => f.name === fieldName)
          if (f) return f.type
        }
        // Auto-deref: pointer to tuple allows field access (loads from memory)
        if (unwrappedType.kind === 'pointer') {
          const pointeeType = unwrap(unwrappedType.pointee)
          if (pointeeType.kind === 'tuple') {
            const f = pointeeType.fields.find((f) => f.name === fieldName)
            if (f) return f.type
          }
        }
        // Slice built-in fields: .ptr, .len
        if (objType.kind === 'slice') {
          if (expr.member.name === 'ptr') {
            return manyPointer(objType.element, objType.mutable)
          }
          if (expr.member.name === 'len') {
            return primitive('u32')
          }
        }
        // Auto-deref: pointer to slice allows .ptr/.len access
        if (objType.kind === 'pointer' && objType.pointee.kind === 'slice') {
          const sliceType = objType.pointee
          if (expr.member.name === 'ptr') {
            return manyPointer(sliceType.element)
          }
          if (expr.member.name === 'len') {
            return primitive('u32')
          }
        }
        // Array type built-in fields: .ptr, .len, .wid
        if (objType.kind === 'array') {
          if (expr.member.name === 'ptr') {
            return manyPointer(objType.element)
          }
          if (expr.member.name === 'len') {
            if (objType.sizes === null) {
              this.error(expr.span.start, `cannot get .len on unbounded array ${typeToString(objType)} - length is unknown`)
              return primitive('u32')
            }
            const total = totalElements(objType.sizes)
            if (total !== null) return comptimeInt(BigInt(total))
            return primitive('u32')
          }
          if (expr.member.name === 'wid') {
            const ws = byteSize(objType.element)
            if (ws !== null) return comptimeInt(BigInt(ws))
            return primitive('u32')
          }
        }
        // Pointer-to-array type built-in fields: .ptr, .len, .wid
        if (objType.kind === 'pointer' && objType.pointee.kind === 'array') {
          const arrayType = objType.pointee
          if (expr.member.name === 'ptr') {
            return manyPointer(arrayType.element)
          }
          if (expr.member.name === 'len') {
            if (arrayType.sizes === null) {
              this.error(expr.span.start, `cannot get .len on unbounded array ${typeToString(arrayType)} - length is unknown`)
              return primitive('u32')
            }
            const total = totalElements(arrayType.sizes)
            if (total !== null) return comptimeInt(BigInt(total))
            return primitive('u32')
          }
          if (expr.member.name === 'wid') {
            const ws = byteSize(tableRow(objType) ?? arrayType.element)
            if (ws !== null) return comptimeInt(BigInt(ws))
            return primitive('u32')
          }
        }
        this.error(expr.span.start, `no field '${expr.member.name}' on type ${typeToString(objType)}`)
        return primitive('i32')
      }

      case 'index': {
        // Tuple index access: t.0, t.1
        if (unwrappedType.kind === 'tuple') {
          const idx = expr.member.value
          if (idx >= 0 && idx < unwrappedType.fields.length) {
            return unwrappedType.fields[idx].type
          }
        }
        // Auto-deref: pointer to tuple allows index access
        if (unwrappedType.kind === 'pointer') {
          const pointeeType = unwrap(unwrappedType.pointee)
          if (pointeeType.kind === 'tuple') {
            const idx = expr.member.value
            if (idx >= 0 && idx < pointeeType.fields.length) {
              return pointeeType.fields[idx].type
            }
          }
        }
        this.error(expr.span.start, `invalid tuple index`)
        return primitive('i32')
      }

      case 'deref': {
        // Pointer dereference: p.* - only valid for basic pointers *T
        // Many-pointers [*]T and slices []T should use [0] syntax instead
        if (objType.kind === 'pointer') {
          // A table is row pointers, not the rows: there is no [N][M]T in
          // memory to load or store whole.
          if (tableRow(objType)) {
            this.error(expr.span.start, `cannot use .* on ${typeToString(objType)}: a table holds pointers to rows that lie apart — load one row with [i].*`)
          }
          return objType.pointee
        }
        if (objType.kind === 'array' || objType.kind === 'slice') {
          this.error(expr.span.start, `cannot use .* on ${typeToString(objType)} - use [0] to access the first element`)
          return objType.element
        }
        this.error(expr.span.start, `cannot dereference non-pointer type ${typeToString(objType)}`)
        return primitive('i32')
      }

      case 'type': {
        // Type pun: ptr.u32, array.u64, etc.
        // Returns a many-pointer to the punned type, preserving mutability
        const punType = this.resolveType(expr.member.type)

        // For slice types: []u8.u32 → [*]u32 (preserves slice mutability)
        if (objType.kind === 'slice') {
          return manyPointer(punType, objType.mutable)
        }

        // For array or comptime_array: [N]u8.u32 → [*]u32
        if (objType.kind === 'array' || objType.kind === 'comptime_array') {
          return manyPointer(punType)
        }

        // For pointer types: preserve mutability through type pun
        if (objType.kind === 'pointer') {
          return manyPointer(punType, objType.mutable)
        }

        // Default: just return the punned type
        return punType
      }
    }
  }

  // items[start..end] is a []T over the same memory. On a *[N]T, constant
  // bounds, or ranged ones that fit, are checked at compile time and give a
  // []T. On a many-pointer the range is unchecked, like its indexing, and needs
  // an end. Otherwise the result is ?[]T: none unless start <= end <= length,
  // checked at runtime.
  inferSlice(expr: AST.SliceExpr): ResolvedType {
    const objType = unwrap(this.inferExpr(expr.object))
    const bound = (e: AST.Expr | null): { value: bigint | null; max: bigint | null } => {
      if (!e) return { value: null, max: null }
      const t = unwrap(this.inferExpr(e))
      if (t.kind === 'comptime_int') this.checkExpr(e, primitive('u32'))
      else if (t.kind !== 'primitive' || !isUnsignedName(t.name)) {
        this.error(e.span.start, `range bound must be an unsigned integer, not ${typeToString(t)}`)
      }
      const c = this.constantInType(e) as unknown as { kind: string; value?: bigint } | null
      if (c && c.kind === 'int' && typeof c.value === 'bigint') return { value: c.value, max: c.value + 1n }
      const limit = t.kind === 'primitive' ? (t.max !== undefined ? BigInt(t.max) : unsignedLimit(t)) : null
      return { value: null, max: limit }
    }
    const start = bound(expr.start)
    const end = bound(expr.end)

    let elem: ResolvedType
    let mutable: boolean
    let proven: boolean
    const pointee = objType.kind === 'pointer' ? unwrap(objType.pointee) : null
    if (objType.kind === 'slice') {
      elem = objType.element
      mutable = !!objType.mutable
      // Only the whole slice is known to fit.
      proven = (expr.start === null || start.value === 0n) && expr.end === null
    } else if (pointee?.kind === 'array' && pointee.sizes === null) {
      elem = pointee.element
      mutable = !!(objType as { mutable?: boolean }).mutable
      if (!expr.end) this.error(expr.span.start, `a range on a many-pointer needs an end: it has no length`)
      proven = true
    } else if (pointee?.kind === 'array' && pointee.sizes?.length === 1 && typeof pointee.sizes[0] === 'number') {
      elem = pointee.element
      mutable = !!(objType as { mutable?: boolean }).mutable
      const n = BigInt(pointee.sizes[0])
      const s = expr.start ? start : { value: 0n, max: 1n }
      const e = expr.end ? end : { value: n, max: n + 1n }
      // Proven when the end can't pass n and the start can't pass the end.
      const endFits = e.max !== null && e.max <= n + 1n
      const startFits = s.value === 0n || (e.value !== null && s.max !== null && s.max <= e.value + 1n)
      proven = endFits && startFits
      if (s.value !== null && e.value !== null && (s.value > e.value || e.value > n)) {
        this.error(expr.span.start, `range ${s.value}..${e.value} is out of bounds for *[${n}]${typeToString(elem)}`)
        proven = true // already reported; don't add a second error
      }
    } else {
      this.error(expr.span.start, `cannot take a range of ${typeToString(objType)}: use a slice or a pointer to an array`)
      return slice(primitive('u8'))
    }
    return slice(elem, mutable, !proven)
  }

  // The number of elements in a range, when it's known at compile time.
  rangeLength(expr: AST.SliceExpr): bigint | null {
    const objType = unwrap(this.exprTypes.get(expr.object) ?? this.inferExpr(expr.object))
    const pointee = objType.kind === 'pointer' ? unwrap(objType.pointee) : null
    const size = pointee?.kind === 'array' && pointee.sizes?.length === 1 && typeof pointee.sizes[0] === 'number'
      ? BigInt(pointee.sizes[0]) : null
    const value = (e: AST.Expr | null, fallback: bigint | null): bigint | null => {
      if (!e) return fallback
      const c = this.constantInType(e) as unknown as { kind: string; value?: bigint } | null
      return c && c.kind === 'int' && typeof c.value === 'bigint' ? c.value : null
    }
    const start = value(expr.start, 0n)
    const end = value(expr.end, size)
    return start !== null && end !== null && end >= start ? end - start : null
  }

  // dst[a..b] = v fills the range with v; dst[a..b] = src copies src into it.
  // The range is written, so it must be in bounds without a runtime check, like
  // an indexed write. A copy also needs both lengths known at compile time and
  // equal; memcpy is the explicit form for a runtime length.
  checkRangeAssignment(target: AST.SliceExpr, op: string, value: AST.Expr): void {
    if (op !== '=') {
      this.error(target.span.start, `a range can only be assigned with =`)
      return
    }
    const dst = this.inferSlice(target)
    this.exprTypes.set(target, dst)
    if (dst.kind !== 'slice') return
    if (dst.optional) {
      this.error(target.span.start, `writing to a range needs bounds known to fit: use constant or ranged bounds (on a slice, only s[..])`)
    }
    if (!dst.mutable) {
      this.error(target.span.start, `cannot write through a const range — use *mut or []mut for mutable access`)
    }
    const elem = dst.element
    const valueType = unwrap(this.inferExpr(value))
    const isScalar = valueType.kind === 'primitive' || valueType.kind === 'comptime_int' || valueType.kind === 'comptime_float'
    if (isScalar) {
      const e = unwrap(elem)
      const oneValue = (e.kind === 'primitive' && !/^[iu](128|256|512)$/.test(e.name)) || e.kind === 'pointer'
      if (!oneValue) {
        this.error(value.span.start, `filling a range needs an element of one value, not ${typeToString(elem)}`)
        return
      }
      this.checkExpr(value, elem, 'fill value: ')
      return
    }
    // A copy: the source is a slice or pointer to an array of the same elements.
    const srcElem = valueType.kind === 'slice' ? valueType.element
      : valueType.kind === 'pointer' && unwrap(valueType.pointee).kind === 'array' ? (unwrap(valueType.pointee) as ArrayRT).element
      : valueType.kind === 'array' ? valueType.element
      : null
    if (!srcElem || !typeEquals(unwrap(srcElem), unwrap(elem))) {
      this.error(value.span.start, `cannot copy ${typeToString(valueType)} into a range of ${typeToString(elem)}`)
      return
    }
    if (valueType.kind === 'slice' && valueType.optional) {
      this.error(value.span.start, `the source range may be out of bounds: resolve it with ?? or if let first`)
      return
    }
    const dstLen = this.rangeLength(target)
    let srcLen: bigint | null = null
    if (value.kind === 'SliceExpr') srcLen = this.rangeLength(value)
    else {
      const arr = valueType.kind === 'pointer' ? unwrap(valueType.pointee) : valueType
      if (arr.kind === 'array' && arr.sizes?.length === 1 && typeof arr.sizes[0] === 'number') srcLen = BigInt(arr.sizes[0])
    }
    if (dstLen === null || srcLen === null) {
      this.error(target.span.start, `copying into a range needs both lengths known at compile time; use memcpy for a runtime length`)
    } else if (dstLen !== srcLen) {
      this.error(target.span.start, `cannot copy ${srcLen} elements into a range of ${dstLen}`)
    }
  }

  // The type of &items[i] for a slice or *[N]T: *T when the index is known to
  // be in range, otherwise ?*T (none when out of range, checked at runtime).
  // Returns null for other containers, which keep the usual rules.
  private addressOfIndex(expr: AST.IndexExpr): ResolvedType | null {
    const objType = unwrap(this.inferExpr(expr.object))
    let elem: ResolvedType
    let mutable: boolean
    let size: number | null
    if (objType.kind === 'slice') {
      elem = objType.element
      mutable = !!objType.mutable
      size = null
    } else if (objType.kind === 'pointer' && objType.pointee.kind === 'array' &&
      objType.pointee.sizes?.length === 1 && typeof objType.pointee.sizes[0] === 'number') {
      elem = objType.pointee.element
      mutable = !!objType.mutable
      size = objType.pointee.sizes[0]
    } else {
      return null
    }
    // The element of a table is its row pointer: &m[i] is where that is.
    elem = tableRow(objType) ?? elem
    this.inferIndexValue(expr.index)
    this.exprTypes.set(expr, elem)
    const idx = this.evalComptimeExpr(expr.index)
    let proven = false
    if (size !== null) {
      if (idx && idx.kind === 'int') {
        if (idx.value < 0n || idx.value >= BigInt(size)) {
          this.error(expr.index.span.start, `index ${idx.value} out of bounds for *[${size}]${typeToString(elem)}`)
        }
        proven = true
      } else {
        proven = this.indexInRange(expr, size)
      }
    }
    return pointer(elem, false, mutable, !proven)
  }

  private indexInRange(expr: AST.IndexExpr, arraySize: number): boolean {
    const idxType = this.exprTypes.get(expr.index)
    if (idxType?.kind !== 'primitive') return false
    if (idxType.max !== undefined) return idxType.max <= arraySize
    // A u8 or u16 can't exceed its width: a u8 always indexes a *[256]T.
    const limit = unsignedLimit(idxType)
    return limit !== null && limit <= 65536n && limit <= BigInt(arraySize)
  }

  // An index is an offset in 32-bit memory: an integer no wider than that.
  private inferIndexValue(index: AST.Expr): ResolvedType {
    const type = this.inferExpr(index)
    const t = unwrap(type)
    if (t.kind === 'comptime_int') {
      this.coerce(index, type, addressType(t))
    } else if (!isInteger(t) || (byteSize(t) ?? 8) > 4) {
      this.error(index.span.start, `an index must be an integer of at most 32 bits, not ${typeToString(type)}`)
    }
    return type
  }

  inferIndex(expr: AST.IndexExpr): ResolvedType {
    // if let and ?? resolve the index they are given, not one it is taken
    // from: in m[i][j] ?? 0 the row m[i] still has to be in range.
    const resolvable = this.insideIfLetCondition
    this.insideIfLetCondition = false
    const objType = this.inferExpr(expr.object)
    this.insideIfLetCondition = resolvable
    this.inferIndexValue(expr.index)
    if (unresolved(objType)) return RECOVERY

    // An element of a table is its row pointer. A row has no optional type:
    // like a value element, an index not known to be in range is resolved
    // where it is taken, with if let or ??.
    const row = tableRow(objType)
    const noOptional = (elem: ResolvedType) => row ? 'rows are not optional' : `no optional type for ${typeToString(elem)}`

    if (objType.kind === 'slice') {
      const idx = this.evalComptimeExpr(expr.index)
      if (idx === null || idx.kind !== 'int') {
        // Runtime index: return optional if element can be optional, error otherwise
        const elem = objType.element
        if (elem.kind === 'pointer' || elem.kind === 'slice') {
          return optionalOf(elem)
        }
        if (!this.insideIfLetCondition) {
          this.error(expr.index.span.start, `runtime index on []${typeToString(elem)} requires 'if let' or '??' (${noOptional(elem)})`)
        }
      }
      return row ?? objType.element
    }

    if (objType.kind === 'comptime_array') {
      return objType.element
    }

    if (objType.kind === 'array') {
      // Multi-dimensional: [N,M]T indexed once returns *[M]T
      if (objType.sizes && objType.sizes.length > 1) {
        const remainingDims = objType.sizes.slice(1)
        return pointer(array(objType.element, remainingDims))
      }
      // Value array [N]T: require compile-time constant index
      if (objType.sizes && objType.sizes.length === 1 && typeof objType.sizes[0] === 'number') {
        const n = objType.sizes[0]
        const idx = this.evalComptimeExpr(expr.index)
        if (idx === null || idx.kind !== 'int') {
          this.error(expr.index.span.start, `dynamic index on value type [${n}]${typeToString(objType.element)} — use a pointer or slice for dynamic access`)
        } else if (idx.value < 0n || idx.value >= BigInt(n)) {
          this.error(expr.index.span.start, `index ${idx.value} out of bounds for [${n}]${typeToString(objType.element)}`)
        }
      }
      return objType.element
    }

    if (objType.kind === 'pointer') {
      // If pointing to an array type (e.g., *[12]u32 or *[12,16]u32)
      if (objType.pointee.kind === 'array') {
        const arrayType = objType.pointee
        // Multi-dimensional: *[N,M]T indexed once returns *[M]T
        if (arrayType.sizes && arrayType.sizes.length > 1) {
          const remainingDims = arrayType.sizes.slice(1)
          return pointer(array(arrayType.element, remainingDims))
        }
        // Fixed-size pointer array *[N]T: check bounds
        if (arrayType.sizes && arrayType.sizes.length === 1 && typeof arrayType.sizes[0] === 'number') {
          const n = arrayType.sizes[0]
          const idx = this.evalComptimeExpr(expr.index)
          if (idx === null || idx.kind !== 'int') {
            // Ranged index: statically safe if max <= array size
            if (!this.indexInRange(expr, n)) {
              const idxType = this.exprTypes.get(expr.index)
              if (idxType?.kind === 'primitive' && idxType.max !== undefined) {
                const elem = arrayType.element
                const canBeOptional = elem.kind === 'pointer' || elem.kind === 'slice'
                const hint = canBeOptional
                  ? ` — narrow the index range or use 'if let'/'??' for bounds checking`
                  : ` — narrow the index range to fit`
                this.error(expr.index.span.start, `index type ${typeToString(idxType)} may exceed *[${n}]${typeToString(elem)} bounds (max index ${idxType.max - 1} >= ${n})${hint}`)
              } else {
                const elem = arrayType.element
                if (elem.kind === 'pointer' || elem.kind === 'slice') {
                  return optionalOf(elem)
                }
                if (!this.insideIfLetCondition) {
                  this.error(expr.index.span.start, `runtime index on *[${n}]${typeToString(elem)} requires 'if let' or '??' (${noOptional(elem)})`)
                }
              }
            }
          } else if (idx.value < 0n || idx.value >= BigInt(n)) {
            this.error(expr.index.span.start, `index ${idx.value} out of bounds for *[${n}]${typeToString(arrayType.element)}`)
          }
        }
        return row ?? arrayType.element
      }
      return objType.pointee
    }

    this.error(expr.span.start, `cannot index type ${typeToString(objType)} — indexing requires an array, slice, or pointer type`)
    return primitive('i32')
  }

  inferCoalesce(expr: AST.CoalesceExpr): ResolvedType {
    // Infer the left expression — allow runtime indexing for primitive elements
    this.insideIfLetCondition = true
    const leftType = this.inferExpr(expr.expr)
    this.insideIfLetCondition = false

    // Determine the unwrapped type
    let elemType: ResolvedType
    if (isOptional(leftType)) {
      elemType = unwrapOptional(leftType)
    } else if (expr.expr.kind === 'IndexExpr') {
      // Primitive element: leftType is already the unwrapped element type
      elemType = leftType
    } else {
      this.error(expr.span.start, '?? requires an optional expression or bounds-checked index')
      elemType = leftType
    }

    // Check fallback type is compatible (checkExpr handles coercion)
    this.checkExpr(expr.fallback, elemType)

    // Record element type for codegen
    this.types.set(typeKey(expr.span.start, 'CoalesceBinding'), elemType)

    return elemType
  }

  inferTuple(expr: AST.TupleExpr): ResolvedType {
    const fields: ResolvedField[] = []
    for (const arg of expr.elements) {
      // Shorthand: (x:) means use variable x
      const value = argValue(arg)
      const argType = value ? this.inferExpr(value) : VOID
      fields.push(field(arg.name, argType))
    }
    // (x) is grouping, not a 1-element tuple
    if (fields.length === 1 && !fields[0].name) return fields[0].type
    return tuple(fields)
  }

  // typedByContext: the elements are about to be checked against a declared
  // element type, one by one, so they aren't settled on a type here.
  inferArray(expr: AST.ArrayExpr, typedByContext = false): ResolvedType {
    if (expr.elements.length === 0) {
      // Empty array - needs context to determine element type
      // For now, return comptime list with no elements
      return comptimeList([])
    }

    // Infer element types and unify
    const elemTypes = expr.elements.map((e) => this.inferExpr(e))
    const numbers = elemTypes.every(t => isScalar(unwrap(t)))
    const elementType = numbers && !typedByContext
      ? this.unifyElements(expr.elements, elemTypes)
      : this.unifyTypes(elemTypes)

    // Return comptime array literal - can coerce to []T, *[N]T, [N]T
    return comptimeArrayLiteral(elementType, expr.elements.length)
  }

  // The element type of an array literal of numbers with no declared type:
  // the one type they all widen to, like the branches of an if. Each element
  // is converted to it.
  private unifyElements(elements: AST.Expr[], types: ResolvedType[]): ResolvedType {
    if (types.every(isComptimeNumber)) {
      // All constants: the default type that holds them all.
      const type = types.some(t => t.kind === 'comptime_float') ? this.concretize(comptimeFloat(0)) : this.unifyTypes(types)
      for (const [i, element] of elements.entries()) this.typeConstant(element, type, types[i])
      return type
    }
    const { type, odd } = this.commonType(types)
    if (odd) {
      const at = elements[types.indexOf(odd)]
      this.error(at.span.start, `elements have different types: ${typeToString(odd)} and ${typeToString(type)} (cast one explicitly)`)
      return type
    }
    for (const [i, element] of elements.entries()) this.coerce(element, types[i], type)
    return type
  }

  inferRepeat(expr: AST.RepeatExpr): ResolvedType {
    // [value; count] - repeat value count times
    const valueType = this.inferExpr(expr.value)
    this.inferExpr(expr.count) // Type check the count expression

    // Count should be a compile-time integer
    const countValue = this.evalComptimeExpr(expr.count)
    if (!countValue || countValue.kind !== 'int') {
      this.error(expr.count.span.start, 'repeat count must be a compile-time integer')
      return comptimeArray(valueType)
    }

    const count = Number(countValue.value)
    if (count < 0) {
      this.error(expr.count.span.start, 'repeat count cannot be negative')
      return comptimeArrayLiteral(valueType, 0)
    }

    // Return comptime array literal - can coerce to []T, *[N]T, [N]T
    return comptimeArrayLiteral(valueType, count)
  }

  inferIf(expr: AST.IfExpr): ResolvedType {
    if (expr.pattern) {
      return this.inferIfLet(expr)
    }
    const valueUsed = !this.statementExprs.has(expr)
    this.checkCondition(expr.condition)
    const branches: Branch[] = []
    const thenType = this.withNarrowing(this.boundsFrom(expr.condition, true), expr.thenBranch, () => this.inferBody(expr.thenBranch, valueUsed))
    branches.push({ body: expr.thenBranch, type: thenType })
    const seen = [expr.condition]
    for (const elif of expr.elifs) {
      this.withNarrowing(this.boundsAfterAllFalse(seen), elif, () => {
        this.checkElifCondition(elif)
        const type = this.withNarrowing(this.boundsFrom(elif.condition, true), elif.thenBranch, () => this.inferBody(elif.thenBranch, valueUsed))
        branches.push({ body: elif.thenBranch, type })
      })
      seen.push(elif.condition)
    }
    if (expr.else_) {
      const else_ = expr.else_
      const type = this.withNarrowing(this.boundsAfterAllFalse(seen), else_, () => this.inferBody(else_, valueUsed))
      branches.push({ body: else_, type })
    }
    // Without an else branch, the expression can't produce a value
    if (!expr.else_) return VOID
    return this.unifyBranches(branches, valueUsed)
  }

  // The type of an if or match with no expected type: the one type every
  // branch's value widens to. A branch that always exits has no say, and if
  // any other branch has no value, neither has the expression. Branches that
  // don't agree are an error where the value is used; in a statement they
  // just leave the expression without one.
  private unifyBranches(branches: Branch[], valueUsed: boolean): ResolvedType {
    const valued = branches.filter(b => !bodyExits(b.body))
    if (valued.length === 0 || valued.some(b => b.type.kind === 'void')) return VOID
    let type = valued[0].type
    if (valued.every(b => isComptimeNumber(b.type))) {
      // All constants: the expression is one too, typed by where it's used.
      // Every branch takes the type that holds them all, so they agree on a
      // default when nothing else types them: -2147483648 and 2147483648
      // are an i64 together, whichever comes first.
      type = standIn(valued.map(b => b.type))
      for (const b of valued) {
        const value = bodyValue(b.body)
        if (!value) continue
        this.branchConstants.set(value, b.type)
        this.typeConstant(value, type, b.type)
      }
      return type
    }
    const common = this.commonType(valued.map(b => b.type))
    type = common.type
    const odd = valued.find(b => b.type === common.odd)
    if (odd) {
      if (!valueUsed) return VOID
      const at = bodyValue(odd.body) ?? odd.body
      this.error(at.span.start, `branches have different types: ${typeToString(odd.type)} and ${typeToString(type)} (cast one explicitly)`)
      return type
    }
    for (const b of valued) {
      const value = bodyValue(b.body)
      if (value) this.coerce(value, b.type, type)
    }
    return type
  }

  // The one type several values, not all of them constants, widen to: the
  // widest of them. `odd` is one that doesn't widen to it, when they have no
  // such type.
  private commonType(types: ResolvedType[]): { type: ResolvedType; odd?: ResolvedType } {
    // Tuples with constants in them agree field by field, as their fields
    // would as values by themselves: (1, 0) and (0, n) are an (i32, i32).
    // A field that is a constant in each takes the default that holds them.
    const tuples = types.filter((t): t is TupleRT => t.kind === 'tuple')
    const [first] = tuples
    const alike = tuples.length === types.length && tuples.every(t =>
      t.fields.length === first.fields.length && t.fields.every((f, i) => f.name === first.fields[i].name))
    if (alike && tuples.some(holdsConstant)) {
      const tupleType = tuple(first.fields.map((f, i) => {
        const of = tuples.map(t => t.fields[i].type)
        return field(f.name, of.every(isComptimeNumber) ? this.concretize(standIn(of)) : this.commonType(of).type)
      }))
      return { type: tupleType, odd: types.find(t => !typeAssignable(tupleType, t)) }
    }
    let type = types[0]
    for (const t of types) {
      const constant = isComptimeNumber(unwrap(t))
      if (isComptimeNumber(unwrap(type)) || (!constant && typeAssignable(t, type))) type = t
    }
    // One value's range says nothing about the others'.
    type = stripMax(type)
    // A constant too big for that type widens it, if its own default type
    // holds the rest: n and 5000000000 are an i64.
    for (const t of types) {
      const own = this.concretize(t)
      if (isComptimeNumber(t) && !typeAssignable(type, t) && typeAssignable(own, type)) type = own
    }
    return { type, odd: types.find(t => !typeAssignable(type, t)) }
  }

  // expected: the type the value is used as, when the context gives one.
  // Each branch is then checked against it, as in a plain if; without one
  // the branches settle on a type between them.
  inferIfLet(expr: AST.IfExpr, expected?: ResolvedType): ResolvedType {
    const pattern = expr.pattern
    if (!pattern || pattern.kind !== 'binding') {
      this.error(expr.span.start, 'if let only supports simple bindings')
      return VOID
    }
    const valueUsed = !this.statementExprs.has(expr)
    const branches: Branch[] = []
    const branch = (body: AST.FuncBody) => {
      if (expected) this.checkBodyAgainst(body, expected)
      else branches.push({ body, type: this.inferBody(body, valueUsed) })
    }

    // Infer the condition — allow runtime indexing for primitive elements
    this.insideIfLetCondition = true
    const condType = this.inferExpr(expr.condition)
    this.insideIfLetCondition = false

    // Determine the unwrapped type
    let elemType: ResolvedType
    if (isOptional(condType)) {
      elemType = unwrapOptional(condType)
    } else if (expr.condition.kind === 'IndexExpr') {
      // Primitive element: condType is already the unwrapped element type
      elemType = condType
    } else {
      this.error(expr.span.start, 'if let requires an optional expression or bounds-checked index')
      elemType = condType
    }

    // Bind the pattern variable in a new scope for the then-branch
    const prevScope = this.currentScope
    this.currentScope = { parent: prevScope, symbols: new Map() }
    this.currentScope.symbols.set(pattern.name, { kind: 'local', type: elemType })
    this.types.set(typeKey(expr.condition.span.start, 'IfLetBinding'), elemType)
    this.recordDefinition(pattern.name, expr.condition.span.start)
    branch(expr.thenBranch)
    this.currentScope = prevScope

    for (const elif of expr.elifs) {
      this.checkElifCondition(elif)
      branch(elif.thenBranch)
    }
    if (expr.else_) branch(expr.else_)
    if (!expr.else_) return VOID
    return expected ?? this.unifyBranches(branches, valueUsed)
  }

  private checkBodyAgainst(body: AST.FuncBody, expected: ResolvedType): void {
    if (body.kind === 'Block') {
      for (let i = 0; i < body.stmts.length - 1; i++) {
        this.checkStmt(body.stmts[i])
      }
      const last = body.stmts[body.stmts.length - 1]
      if (last?.kind === 'ExpressionStmt') {
        this.statementExprs.delete(last.expr)
        this.checkExpr(last.expr, expected)
        return
      }
      if (last) this.checkStmt(last)
      const wanted = expected.kind !== 'void' && !(expected.kind === 'tuple' && expected.fields.length === 0)
      if (wanted && !bodyExits(body)) {
        this.error(last?.span.start ?? body.span.start, `this branch has no value: expected ${typeToString(expected)}`)
      }
    } else {
      this.checkExpr(body.expr, expected)
    }
  }

  // valueUsed: whether something takes the value of the body's last expression.
  private inferBody(body: AST.FuncBody | AST.Expr, valueUsed = true): ResolvedType {
    if (body.kind === 'Block') {
      for (const [i, stmt] of body.stmts.entries()) {
        this.checkStmt(stmt, valueUsed && i === body.stmts.length - 1)
      }
      // Block's type is the last expression statement, if any
      const last = body.stmts[body.stmts.length - 1]
      if (last?.kind === 'ExpressionStmt') {
        return this.exprTypes.get(last.expr) ?? VOID
      }
      return VOID
    }
    const expr = body.kind === 'ArrowBody' ? body.expr : body
    if (valueUsed) this.statementExprs.delete(expr)
    else this.statementExprs.add(expr)
    return this.inferExpr(expr)
  }

  // A literal pattern is compared with the subject, so it has to be a value
  // of the subject's type.
  private checkMatchSubject(expr: AST.MatchExpr): void {
    let subjectType = this.inferExpr(expr.subject)
    // A constant subject (1, a def, a fixed array's len) has no type for the
    // patterns to be compared in: it takes its default one, as the
    // initializer of a let without a type does.
    if (isComptimeNumber(subjectType)) {
      const type = this.concretize(subjectType)
      this.typeConstant(expr.subject, type, subjectType, false)
      subjectType = type
    }
    const subject = unwrap(stripMax(subjectType))
    for (const arm of expr.arms) {
      for (const pattern of arm.patterns) {
        if (pattern.kind !== 'literal') continue
        const value = pattern.value
        const type = value.kind === 'int' ? comptimeInt(value.value)
          : value.kind === 'float' ? comptimeFloat(value.value)
          : value.kind === 'bool' ? primitive('bool')
          : null
        const comparable = subject.kind === 'primitive' && (byteSize(subject) ?? 16) <= 8
        if (!type || !comparable || !typeAssignable(subject, type)) {
          const shown = type ? typeToString(type) : 'a string'
          this.error(arm.span.start, `cannot match ${typeToString(subjectType)} against ${shown}`)
        }
      }
    }
  }

  inferMatch(expr: AST.MatchExpr): ResolvedType {
    const valueUsed = !this.statementExprs.has(expr)
    this.checkMatchSubject(expr)
    const branches: Branch[] = expr.arms.map(arm => ({ body: arm.body, type: this.inferBody(arm.body, valueUsed) }))
    return this.unifyBranches(branches, valueUsed)
  }

  inferSizeof(expr: AST.SizeofExpr): ResolvedType {
    const resolvedType = this.resolveType(expr.type)
    // Codegen takes the operand from here: resolving the AST again, it would
    // not know what a type parameter was bound to.
    this.types.set(typeKey(expr.span.start, 'SizeofType'), resolvedType)
    const size = byteSize(resolvedType)
    if (size === null) {
      this.error(expr.span.start, `sizeof: cannot compute size of dynamically sized type`)
    }
    // sizeof always returns u32 (natural size type for WebAssembly)
    return primitive('u32')
  }

  // === Generics ===
  //
  // A function with a comptime parameter is a generic. Nothing of it is
  // resolved where it is declared. A call finds its comptime arguments, and
  // each distinct set of them gets an instance: a copy of the declaration with
  // the parameters replaced by their arguments, collected and checked as an
  // ordinary function of the module that declares the generic. The call is
  // recorded as a plain call of that instance.

  private collectGeneric(decl: AST.FuncDecl): void {
    const valid = this.checkGenericDecl(decl)
    if (!decl.ident) return
    if (this.moduleScope.symbols.has(decl.ident)) {
      this.error(decl.span.start, `'${decl.ident}' is already declared: a generic function's name is unique in its module`)
      return
    }
    this.moduleScope.symbols.set(decl.ident, { kind: 'generic', decl, owner: this, instances: new Map(), valid })
    this.recordDefinition(decl.ident, decl.span.start)
  }

  // Whether a type as written is a function type: one written out, or a name
  // for one, a `type` or an applied generic type. A name is the type it names
  // here as anywhere, and this is asked while types are still unresolved.
  private namesFuncType(type: AST.Type, seen = new Set<string>()): boolean {
    if (type.kind === 'FuncType') return true
    if (type.kind !== 'TypeRef' && type.kind !== 'TypeApply') return false
    if (seen.has(type.name)) return false
    seen.add(type.name)
    const sym = this.moduleScope.symbols.get(type.name)
    const body = type.kind === 'TypeRef' ? this.typeBodies.get(type.name) : sym?.kind === 'typefunc' ? sym.decl.body : undefined
    return body !== undefined && this.namesFuncType(body, seen)
  }

  // What a generic is checked for where it is declared. The rest of it waits
  // for an instance, where its types are known.
  private checkGenericDecl(decl: AST.FuncDecl): boolean {
    let valid = true
    const reject = (offset: number, message: string) => {
      valid = false
      this.error(offset, message)
    }
    if (!decl.ident) reject(decl.span.start, `a generic function needs a name`)
    const params = genericParams(decl)
    const unnamed = params.find((p) => !p.ident)
    if (unnamed) reject(unnamed.span.start, `a generic function's parameters need names`)
    const typeParams = new Set<string>()
    for (const p of params) {
      if (!p.ident) continue
      const at = p.span.start
      if (p.type.kind !== 'TypeType') {
        // A comptime parameter of a function type is given a function.
        if (!p.comptime) continue
        if (!this.namesFuncType(p.type)) {
          reject(at, `comptime value parameters are not supported yet: '${p.ident}' must be 'type' or a function type`)
        } else if (params.some((other) => other !== p && other.ident === p.ident)) {
          // In the instance it is a function of that name, which the other
          // parameter of the name would hide, or be hidden by.
          reject(at, `parameter '${p.ident}' is declared twice`)
        }
      } else if (!p.comptime) {
        reject(at, `a parameter of type 'type' must be comptime: write 'comptime T: type'`)
      } else if (!/^[A-Z]/.test(p.ident)) {
        reject(at, `a type parameter's name starts with an upper-case letter: write 'comptime T: type'`)
      } else if (typeParams.has(p.ident)) {
        reject(at, `type parameter '${p.ident}' is declared twice`)
      } else if (this.isTypeName(p.ident)) {
        reject(at, `type parameter '${p.ident}' has the name of a type declared in this module`)
      } else {
        typeParams.add(p.ident)
      }
    }
    // What the declaration says of generic types is checked here, by name
    // alone. An instance would say it once for each set of arguments, and an
    // inferred call that cannot find T through `v: *Vec(T, T)` would say
    // that it cannot, which is not the mistake.
    // A name a type parameter was refused for is still that parameter's here.
    const own = new Set(params.flatMap((p) => (p.type.kind === 'TypeType' && p.ident ? [p.ident] : [])))
    for (const used of typeUses([decl.signature, decl.body])) {
      if (own.has(used.name)) {
        if (used.kind === 'TypeApply') reject(used.span.start, `a type parameter cannot be applied`)
        continue
      }
      const problem = this.typeFuncProblem(used)
      if (problem) reject(used.span.start, problem)
    }
    return valid
  }

  private isTypeName(name: string): boolean {
    const kind = this.moduleScope.symbols.get(name)?.kind
    return kind === 'type' || kind === 'typefunc' || this.pendingTypeNames.has(name)
  }

  // === Generic types ===
  //
  // `func Vec(comptime T: type) -> type => (...)` is a function from types to
  // a type. Applying it, Vec(u32), resolves its body with the parameters
  // replaced by the arguments. Nothing new comes of that: the result is the
  // body's type under the name it was applied by, as a `type` alias is the
  // type it names. That is all "structural" takes.

  private collectTypeFunc(decl: AST.TypeFuncDecl): void {
    // A type parameter is in no applied type: the body is resolved with the
    // argument in the place of every use. Where it is declared and used is
    // read off the declaration, as for a generic function's, for the editor
    // to find.
    const used = typeUses(decl.body)
    for (const param of decl.params) {
      if (!isTypeParam(param) || !param.identSpan) continue
      const declared = param.identSpan.start
      const uses = used.filter((t) => t.name === param.ident).map((t) => t.span.start)
      this.references.set(declared, uses)
      for (const use of uses) this.symbolRefs.set(use, declared)
    }
    if (this.moduleScope.symbols.has(decl.ident)) {
      this.error(decl.span.start, `'${decl.ident}' is already declared: a generic type's name is unique in its module`)
      return
    }
    const sym: Symbol & { kind: 'typefunc' } = { kind: 'typefunc', decl, owner: this, cache: new Map(), valid: true }
    this.moduleScope.symbols.set(decl.ident, sym)
    this.typeFuncs.push(sym)
    this.recordDefinition(decl.ident, decl.span.start)
  }

  // What a generic type is checked for where it is declared, once every type
  // name of the module is known: its parameters, and that applying it ends.
  private checkTypeFuncs(): void {
    for (const sym of this.typeFuncs) {
      const { decl } = sym
      const reject = (offset: number, message: string) => {
        sym.valid = false
        this.error(offset, message)
      }
      // A `type` declaration of the same name is refused where it stands.
      if (this.pendingTypeNames.has(decl.ident)) this.contested.add(decl.ident)
      if (decl.params.length === 0 || decl.params.some((p) => !isTypeParam(p) || !/^[A-Z]/.test(p.ident ?? ''))) {
        reject(decl.span.start, `generic type '${decl.ident}' takes comptime type parameters only, as (comptime T: type)`)
        continue
      }
      const names = new Set<string>()
      for (const p of decl.params) {
        const name = p.ident as string
        if (names.has(name)) reject(p.span.start, `type parameter '${name}' is declared twice`)
        else if (this.isTypeName(name)) reject(p.span.start, `type parameter '${name}' has the name of a type declared in this module`)
        names.add(name)
      }
      const applied = typeApplications(decl.body).find((t) => names.has(t.name))
      if (applied) reject(applied.span.start, `a type parameter cannot be applied`)
    }
    // A type function has no conditions, so one whose body applies it again,
    // directly or through another, never comes to an end. (Through a `type`
    // it does: that is a forward reference, as in any recursive type.)
    for (const sym of this.typeFuncs) {
      if (!sym.valid) continue
      const reaches = (from: Symbol & { kind: 'typefunc' }, seen: Set<Symbol>): (Symbol & { kind: 'typefunc' })[] | null => {
        for (const applied of typeApplications(from.decl.body)) {
          const next = this.moduleScope.symbols.get(applied.name)
          if (next?.kind !== 'typefunc' || seen.has(next)) continue
          if (next === sym) return [from]
          seen.add(next)
          const rest = reaches(next, seen)
          if (rest) return [from, ...rest]
        }
        return null
      }
      const round = reaches(sym, new Set())
      if (!round) continue
      const first = typeApplications(sym.decl.body).find((applied) => {
        const next = this.moduleScope.symbols.get(applied.name)
        return next === sym || (next?.kind === 'typefunc' && round.includes(next))
      })
      this.error((first ?? sym.decl).span.start, `generic type '${sym.decl.ident}' refers to itself`)
      // One error for the whole round: the others on it are part of the same mistake.
      for (const member of round) member.valid = false
    }
  }

  // What is wrong with the way a type names a generic type, if anything: a
  // generic type without its arguments, or an application of what is no
  // generic type, or with the wrong number of arguments. Null also for a
  // generic type whose declaration has the error.
  private typeFuncProblem(used: AST.TypeRef | AST.TypeApply): string | null {
    const { name } = used
    const sym = this.moduleScope.symbols.get(name)
    if (used.kind === 'TypeRef') {
      const bare = sym?.kind === 'typefunc' && sym.valid && !this.contested.has(name)
      return bare ? `'${name}' is a generic type: write ${typeFuncForm(sym.decl)}` : null
    }
    if (sym?.kind !== 'typefunc') {
      if (sym?.kind === 'type' || this.pendingTypeNames.has(name)) return `'${name}' is not a generic type`
      const similar = this.findSimilar(name)
      return `unknown generic type '${name}'${similar ? ` — did you mean '${similar}'?` : ''}`
    }
    const params = sym.decl.params.length
    if (!sym.valid || used.args.length === params) return null
    return `${name} expects ${params} type argument${params === 1 ? '' : 's'}, got ${used.args.length}`
  }

  // Vec(u32): the generic type's body with its parameters replaced by these
  // arguments, resolved in the module that declares it.
  private applyTypeFunc(type: AST.TypeApply): ResolvedType {
    const { name } = type
    const at = type.span.start
    this.recordReference(name, at)
    const before = this.errorsReported
    const args = type.args.map((a) => this.resolveType(a))
    const problem = this.typeFuncProblem(type)
    if (problem) this.error(at, problem)
    const sym = this.moduleScope.symbols.get(name)
    // Where the generic type's declaration has the error, that is all.
    if (problem || sym?.kind !== 'typefunc' || !sym.valid) return RECOVERY
    const params = sym.decl.params
    if (this.errorsReported > before) return RECOVERY
    const vague = args.findIndex((a) => !hasOwnType(a))
    if (vague >= 0) {
      this.error(type.args[vague].span.start, `type argument ${params[vague].ident} of '${name}' must be a concrete type`)
      return RECOVERY
    }

    const owner = sym.owner
    const shown = `${name}(${args.map((a) => typeToString(a)).join(', ')})`
    // While declarations are still being collected a type can hold a
    // reference to one declared further down. What is resolved then is not
    // kept: the same application resolves to the finished type later.
    const settled = owner.pendingTypeNames.size === 0 && this.pendingTypeNames.size === 0
    // By what the arguments are and by how they were written: Vec(Meters) and
    // Vec(u32) are one type, and each reads as it was written.
    const key = `${args.map((a) => canonicalKey(a)).join('|')} ${shown}`
    const cached = settled ? sym.cache.get(key) : undefined
    if (cached) return cached
    if (owner.applyDepth >= MAX_APPLY_DEPTH) {
      owner.applyTooDeep = true
      return RECOVERY
    }
    const bound = new Map(params.map((p, i) => [p.ident as string, args[i]]))
    const body = cloneAst(sym.decl.body, 0, (param) => {
      const to = bound.get(param)
      return to && { kind: 'BoundType', name: param, type: to, span: { start: 0, end: 0 } }
    }) as AST.Type
    owner.applyDepth++
    const resolved = named(shown, owner.resolveType(body))
    owner.applyDepth--
    // Nothing of a type that was cut short is a type. The error is one, at
    // the application that was written: the declarations it went through are
    // each as they should be.
    if (owner.applyTooDeep) {
      if (owner.applyDepth === 0) {
        owner.applyTooDeep = false
        this.error(at, `generic types are nested more than ${MAX_APPLY_DEPTH} deep in '${shown}'`)
      }
      return RECOVERY
    }
    if (settled) sym.cache.set(key, resolved)
    return resolved
  }

  // The body of a generic type as one application of it reads: the parameters
  // replaced by the types written for them, unresolved. This is how a
  // parameter `v: *Vec(T)` is laid over an argument to find T.
  private expandTypeApply(applied: AST.TypeApply): AST.Type | null {
    const sym = this.moduleScope.symbols.get(applied.name)
    if (sym?.kind !== 'typefunc' || !sym.valid || applied.args.length !== sym.decl.params.length) return null
    const args = new Map(sym.decl.params.map((p, i) => [p.ident as string, applied.args[i]]))
    return cloneAst(sym.decl.body, 0, (param) => args.get(param)) as AST.Type
  }

  // A call of a generic function: find the comptime arguments, get the
  // instance, check the remaining arguments against its signature and record
  // the plain call it compiles to.
  inferGenericCall(expr: AST.CallExpr, sym: Symbol & { kind: 'generic' }, name: string): ResolvedType {
    // However the call fails, the values among its arguments are still
    // inferred, so that their own errors appear. Until the form of the call is
    // known, those are the arguments that cannot be read as types.
    let values = expr.args.flatMap((a) => (a.value && !typeOfArg(a.value) ? [a.value] : []))
    const fail = (offset?: number, message?: string): ResolvedType => {
      if (offset !== undefined && message) this.error(offset, message)
      for (const value of values) this.inferExpr(value)
      return RECOVERY
    }
    this.recordReference(name, expr.callee.span.start)
    if (!sym.valid) return fail()

    // Which form the call is depends only on how many arguments it has: all
    // the type parameters are written, or all are left out.
    const params = genericParams(sym.decl)
    const typeParams = params.filter(isTypeParam).map((p) => p.ident as string)
    if (expr.args.some((a) => a.name !== null || a.value === null)) {
      return fail(expr.span.start, `'${name}' takes positional arguments`)
    }
    const explicit = expr.args.length === params.length
    // A comptime function parameter is always written, in either form.
    const runtimeCount = params.length - typeParams.length
    if (!explicit && expr.args.length !== runtimeCount) {
      // A generic with comptime function parameters only has the one form.
      const receiver = this.receivers.has(expr) && runtimeCount > 0 ? 1 : 0
      const between = typeParams.length === 0 ? ', ' : `, or ${params.length - receiver} with its type argument${typeParams.length === 1 ? '' : 's'} written; `
      return fail(expr.span.start, `'${name}' expects ${this.counted(expr, runtimeCount, expr.args.length, between)}`)
    }
    const pairs: { param: AST.Field; arg: AST.Expr; index: number }[] = []
    for (const param of params) {
      if (isTypeParam(param) && !explicit) continue
      pairs.push({ param, arg: expr.args[pairs.length].value as AST.Expr, index: pairs.length })
    }
    // An argument that stands for a comptime parameter is not a value,
    // whatever was written there: its error says so and nothing more is said
    // of it.
    values = pairs.flatMap((p) => (p.param.comptime ? [] : [p.arg]))

    const funcs = new Map<AST.Field, ComptimeValue & { kind: 'func' }>()
    for (const { param, arg, index } of pairs) {
      if (!param.comptime || isTypeParam(param)) continue
      const value = this.evalComptimeArg(name, param, arg, this.place(expr, index))
      if (value?.kind !== 'func') return fail()
      funcs.set(param, value)
    }

    const bound = new Map<string, ResolvedType>()
    if (explicit) {
      for (const { param, arg, index } of pairs) {
        if (!isTypeParam(param)) continue
        const value = this.evalComptimeArg(name, param, arg, this.place(expr, index))
        if (value?.kind !== 'type') return fail()
        bound.set(param.ident as string, value.type)
      }
    } else {
      // What the call found the first time it was come to is what it finds now.
      let found = this.inferred.get(expr)
      if (found === undefined) {
        found = this.inferTypeArgs(expr, name, pairs, typeParams, funcs, sym.owner)
        if (found || !this.attempting) this.inferred.set(expr, found)
      }
      if (!found) return fail()
      for (const [param, type] of found) bound.set(param, type)
    }

    // A type declared further down is not known yet while declarations are
    // still being collected. A call in a global's initializer or a def's
    // value is inferred there, before it is rejected for not being a
    // constant: its instance would be keyed by the name, not by the type.
    for (const p of typeParams) {
      const pending = unresolvedName(bound.get(p) as ResolvedType)
      if (pending) {
        return fail(expr.span.start, `type argument ${p} of '${name}' uses type '${pending}' before it is declared`)
      }
    }

    // A function given for a comptime parameter has to be of the type the
    // parameter declares, now that its type parameters are known.
    for (const { param, arg } of pairs) {
      const given = funcs.get(param)
      if (!given) continue
      const wanted = sym.owner.comptimeParamType(param, bound)
      if (!wanted) return fail()
      if (!sameSignature(wanted, given.type)) {
        const written = arg.kind === 'IdentExpr' ? arg.name : given.name
        return fail(
          arg.span.start,
          `'${written}' is ${signatureText(given.type)}, but '${name}' needs ${param.ident}: ${signatureText(wanted)}`,
        )
      }
    }

    const args: ComptimeValue[] = params
      .filter((p) => p.comptime)
      .map((p) => funcs.get(p) ?? { kind: 'type', type: bound.get(p.ident as string) as ResolvedType })
    const inst = this.instantiate(sym, args, expr.span.start)
    if (!inst) return fail()

    // Every other argument is an ordinary argument of the instance.
    const sig = sym.owner.signatureAs(inst, args)
    const runtimeArgs: AST.Arg[] = []
    for (const { param, arg, index } of pairs) {
      if (param.comptime) continue
      this.checkExpr(arg, sig.params[runtimeArgs.length].type, this.place(expr, index))
      runtimeArgs.push(expr.args[index])
    }

    // The arguments are the written call's own nodes, so the types and
    // conversions recorded for them are the ones the plain call is compiled with.
    this.calls.set(expr, {
      kind: 'CallExpr',
      callee: { kind: 'IdentExpr', name: inst.name, span: expr.callee.span },
      args: runtimeArgs,
      span: expr.span,
    })
    // What the editor shows at the call: the signature of the instance, as
    // this call wrote its types
    this.exprTypes.set(expr.callee, sig)
    if (sig.returns.length === 0) return VOID
    return sig.returns.length === 1 ? sig.returns[0].type : tuple(sig.returns)
  }

  // The type parameters of an inferred call, found from its arguments; null,
  // with the error reported, when they cannot be. The first argument that can
  // decide a type parameter decides it. An untyped literal never does: it takes
  // the type the parameter turns out to have.
  private inferTypeArgs(
    expr: AST.CallExpr,
    name: string,
    pairs: { param: AST.Field; arg: AST.Expr; index: number }[],
    typeParams: string[],
    funcs: ReadonlyMap<AST.Field, ComptimeValue & { kind: 'func' }>,
    owner: CheckContext,
  ): Map<string, ResolvedType> | null {
    const bound = new Map<string, ResolvedType>()
    const untyped: { param: AST.Field; arg: AST.Expr; type: ResolvedType }[] = []
    const typed: AST.Field[] = []
    // A generic type in a parameter's declared type is seen through: what
    // counts is what its body does with the type parameter.
    const expand = (applied: AST.TypeApply) => owner.expandTypeApply(applied)
    const mentions = (type: AST.Type, of: readonly string[]) => mentionsUnbound(type, of, bound, expand)
    const match = (pattern: AST.Type, actual: ResolvedType, into: Map<string, ResolvedType>, value = true) =>
      matchType(pattern, actual, typeParams, into, value, expand)
    for (const { param, arg, index } of pairs) {
      if (!mentions(param.type, typeParams)) continue
      // The signature of a function given for a comptime parameter decides
      // like any argument's type. Nothing of it is a value the call holds.
      const given = funcs.get(param)
      if (given) {
        match(param.type, given.type, bound, false)
        typed.push(param)
        continue
      }
      // An argument with an error of its own decides nothing: the type it
      // was given is a guess, and the call would add errors about the guess.
      const reported = this.errorsReported
      const type = this.peek(arg)
      if (type === RECOVERY || this.errorsReported > reported) return null
      if (isUnit(type)) {
        this.error(arg.span.start, `${this.place(expr, index)} of '${name}' has no value`)
        return null
      }
      if (hasOwnType(type)) {
        match(param.type, type, bound)
        typed.push(param)
      } else {
        untyped.push({ param, arg, type })
      }
    }
    const missing = typeParams.find((p) => !bound.has(p))
    if (!missing) return bound

    const literals = untyped.filter((u) => mentions(u.param.type, [missing]))
    // An argument with a type of its own that mentions the parameter and did
    // not decide it: its shape did not match. What the literals would be on
    // their own is then no hint at what was meant.
    const passedOver = typed.some((p) => mentions(p.type, [missing]))
    // A generic type that is given the parameter and has no field of it:
    // nothing can be found out through that one.
    const unused = pairs
      .flatMap(({ param }) => typeApplications(param.type))
      .find((applied) => applied.args.some((a) => mentionsUnbound(a, [missing], bound)) && !mentions(applied, [missing]))
    if (unused && literals.length === 0 && !passedOver) {
      this.error(
        expr.span.start,
        `cannot infer ${missing} for '${name}': '${typeText(unused)}' does not use ${missing} in its fields; write the type argument`,
      )
      return null
    }
    if (literals.length === 0 || passedOver) {
      const plural = typeParams.length === 1 ? '' : 's'
      this.error(
        expr.span.start,
        `cannot infer ${missing} for '${name}': write the type argument${plural}, as in ${this.written(expr, name, typeParams.map(() => 'u32'), pairs.length)}`,
      )
      return null
    }
    // What the literals would be on their own, to show what to write
    const guess = new Map(bound)
    for (const u of untyped) match(u.param.type, this.concretize(u.type), guess)
    const written = typeParams.map((p) => {
      const type = guess.get(p)
      return type ? typeToString(type) : p
    })
    const text = literalText(literals[0].arg)
    const example = text ? ` (${text}:${typeToString(this.concretize(literals[0].type))})` : ''
    this.error(
      expr.span.start,
      `cannot infer ${missing} for '${name}' from untyped literals: write ${this.written(expr, name, written, pairs.length)} or give a literal its type${example}`,
    )
    return null
  }

  // The type an expression has by itself, found without leaving a trace. An
  // argument that may decide a type parameter is looked at before the type it
  // is checked against is known, and then checked as any argument is. Whatever
  // the look recorded has to go: a `let` inside the argument would be declared
  // twice, a literal it took the address of would stay marked as its own
  // writable cell, and the call would no longer compile to what the same call
  // of a hand-written function does. Errors stay: the check repeats them.
  private peek(expr: AST.Expr): ResolvedType {
    return this.untraced(expr, () => this.inferExpr(expr))
  }

  // Runs a look at `expr` and takes back what it recorded. Errors stay.
  private untraced<T>(expr: AST.Expr | null, look: () => T): T {
    // A call the look will not walk (see inferCall) keeps its marks.
    const literals = literalMarks(expr, (call) => this.known(call))
    const recorded = this.trial.begin()
    const registered = this.pendingLiterals.length
    const unplaced = this.unplaced.length
    const warned = this.warnings.length
    const scope = this.currentScope
    this.currentScope = { parent: scope, symbols: new Map() }
    this.lookScopes.add(this.currentScope)
    const found = look()
    this.currentScope = scope
    this.warnings.length = warned
    this.pendingLiterals.length = registered
    this.unplaced.length = unplaced
    this.trial.rollback(recorded)
    for (const { node, marks } of literals) {
      delete node.mut
      delete node.dataId
      Object.assign(node, marks)
    }
    return found
  }

  // A look whose errors go too: it asks whether something would check, where
  // a no is an answer and not yet a mistake. A call that fails in one is not
  // remembered as failed (see `picked`): its error is yet to be reported.
  attempt<T>(expr: AST.Expr | null, look: () => T): T {
    const errors = this.errors.length
    const reported = this.errorsReported
    this.attempting++
    const found = this.untraced(expr, look)
    this.attempting--
    this.errors.length = errors
    this.errorsReported = reported
    return found
  }

  // The one place a comptime argument is evaluated. A type argument is read as
  // a type because of where it stands, as after a colon, and resolved in the
  // calling module.
  private evalComptimeArg(callee: string, param: AST.Field, arg: AST.Expr, place: string): ComptimeValue | null {
    if (!isTypeParam(param)) {
      // A function parameter is given a function of the module by its name,
      // or, inside an instance, a comptime function parameter passed on.
      const target = arg.kind === 'IdentExpr' ? this.lookup(arg.name) : undefined
      if (arg.kind !== 'IdentExpr' || target?.kind !== 'func') {
        this.error(arg.span.start, `${place} of '${callee}' must be the name of a function: ${param.ident} is a comptime function parameter`)
        return null
      }
      // Functions that share the name are told apart by the arguments of a
      // call, and here there are none.
      if (this.shared(arg.name) && target === this.moduleScope.symbols.get(arg.name)) {
        for (const member of this.overloads.get(arg.name) ?? []) this.recordReference(member, arg.span.start)
        this.error(arg.span.start, `${place} of '${callee}' must be the name of a function: ${param.ident} is a comptime function parameter ('${arg.name}' has several overloads)`)
        return null
      }
      this.recordReference(arg.name, arg.span.start)
      // A function a test declares has a wasm name of its test's, which the
      // instance, a function of the module, could not call.
      const ofTest = this.testDeclared.has(target) || (this.testOnly.has(arg.name) && target === this.moduleScope.symbols.get(arg.name))
      if (ofTest) {
        this.error(arg.span.start, `${place} of '${callee}' must be a function declared at module level: '${arg.name}' is declared inside a test`)
        return null
      }
      return { kind: 'func', name: target.alias ?? arg.name, type: target.type, inline: target.inline }
    }
    const ast = typeOfArg(arg)
    if (!ast) {
      this.error(arg.span.start, `${place} of '${callee}' must be a type: ${param.ident} is a type parameter`)
      return null
    }
    const before = this.errorsReported
    const type = this.resolveType(ast)
    if (this.errorsReported > before) return null
    if (!hasOwnType(type)) {
      this.error(arg.span.start, `type argument ${param.ident} of '${callee}' must be a concrete type`)
      return null
    }
    if (isUnit(type)) {
      this.error(arg.span.start, `type argument ${param.ident} of '${callee}' cannot be (): it has no values`)
      return null
    }
    return { kind: 'type', type }
  }

  // The instance of a generic for these comptime arguments: made once, in the
  // module that declares the generic, whoever asks.
  private instantiate(sym: Symbol & { kind: 'generic' }, args: ComptimeValue[], at: number): Instance | null {
    const of = sym.decl
    const comptimeParams = genericParams(of).filter((p) => p.comptime)
    // The instance holds its type arguments without the aliases that only
    // rename a type: calls that wrote Meters, Feet and u32 share it, and its
    // own messages should not read as if one of them had been singled out.
    const held: ComptimeValue[] = args.map((a) => (a.kind === 'type' ? { kind: 'type', type: plain(a.type) } : a))
    // A function is the function of that name: two instances are one when
    // their functions are.
    const key = held.map((a) => (a.kind === 'type' ? watSafe(canonicalKey(a.type)) : a.kind === 'func' ? a.name : '')).join('|')
    const existing = sym.instances.get(key)
    if (existing) return existing

    // An instance asked for from an instance's body draws on that one's chain.
    const requester = this.currentInstance
    const depth = (requester?.depth ?? 0) + 1
    let chain: InstanceChain = { size: 1, keySize: key.length, stopped: false }
    if (requester) {
      chain = requester.chain
      if (chain.stopped) return null
      const endless =
        depth > MAX_INSTANCE_DEPTH ? `too many nested instantiations (${MAX_INSTANCE_DEPTH})`
        : chain.size >= MAX_CHAIN_INSTANCES ? `too many instantiations (${MAX_CHAIN_INSTANCES}) from one call`
        : key.length > Math.max(MAX_CHAIN_KEY, chain.keySize * MAX_CHAIN_KEY_GROWTH) ? `type arguments grow without end`
        : null
      if (endless) {
        chain.stopped = true
        this.error(at, `${endless} while instantiating '${of.ident}'`)
        return null
      }
      chain.size++
    }

    const owner = sym.owner
    const index = owner.instances.length + 1
    // Offsets have to stay exact integers, and below the next instance's.
    if (of.span.end >= INSTANCE_STRIDE || index >= MAX_INSTANCES) {
      this.error(at, `cannot instantiate '${of.ident}': the source is too large or has too many instances`)
      return null
    }
    const decl = bindTypes(of, comptimeParams, held, index * INSTANCE_STRIDE)
    decl.ident = instanceName(of.ident as string, key, (name) => owner.moduleScope.symbols.has(name))

    const shown = comptimeParams.map((p, i) => {
      const value = held[i]
      const text = value.kind === 'type' ? typeToString(value.type) : value.kind === 'func' ? value.name : ''
      return `${p.ident} = ${text.length > 60 ? `${text.slice(0, 57)}...` : text}`
    })
    const label = `${of.ident}(${shown.join(', ')})`
    const inst: Instance = { name: decl.ident, label, of, decl, index, first: sym.instances.size === 0, args: held, requestedAt: at, depth, chain }
    sym.instances.set(key, inst)
    owner.instances.push(inst)
    owner.instanceQueue.push(inst)
    // The signature exists from here on, which is all a call needs. The body
    // waits for drainInstances.
    owner.collectFunc(decl)
    return inst
  }

  // The signature of an instance as one call sees it: the generic's, with that
  // call's own type arguments. Calls that write one type in different ways (an
  // alias, the struct it names, a second alias) share the instance, and each
  // is checked, and reads in its messages and in the editor, as it was
  // written. Checking against the first caller's spelling instead would make
  // what a call is told, and for the types the checker cannot see through
  // whether it is accepted at all, depend on which call came first.
  signatureAs(inst: Instance, args: ComptimeValue[]): ResolvedType & { kind: 'func' } {
    const same = (held: ComptimeValue, arg: ComptimeValue) => held.kind !== 'type' || (arg.kind === 'type' && held.type === arg.type)
    if (inst.args.every((held, i) => same(held, args[i]))) {
      return (this.moduleScope.symbols.get(inst.name) as Symbol & { kind: 'func' }).type
    }
    // At the instance's offsets, so that an error in the signature is the one
    // the instance already has.
    const comptimeParams = genericParams(inst.of).filter((p) => p.comptime)
    return this.resolveSignature(bindTypes(inst.of, comptimeParams, args, inst.index * INSTANCE_STRIDE, 'signature').signature)
  }

  // The type a comptime function parameter declares, with the call's type
  // arguments: what the function given for it has to be. Null when it does
  // not resolve; the declaration then has the error.
  comptimeParamType(param: AST.Field, bound: ReadonlyMap<string, ResolvedType>): FuncRT | null {
    const before = this.errorsReported
    const type = this.resolveBound(param.type, bound)
    const declared = unwrap(type)
    return declared.kind === 'func' && this.errorsReported === before ? declared : null
  }

  // A type as a generic's declaration writes it, with these type arguments
  resolveBound(type: AST.Type, bound: ReadonlyMap<string, ResolvedType>): ResolvedType {
    return this.resolveType(
      cloneAst(type, 0, (name) => {
        const to = bound.get(name)
        return to && { kind: 'BoundType', name, type: to, span: { start: 0, end: 0 } }
      }) as AST.Type,
    )
  }

  // Inside an instance a comptime function parameter is the function it was
  // given, under the parameter's name: the body then needs no rule of its
  // own to call it.
  private bindComptimeFuncs(inst: Instance, scope: Scope): void {
    const comptimeParams = genericParams(inst.of).filter((p) => p.comptime)
    comptimeParams.forEach((param, i) => {
      const value = inst.args[i]
      if (value.kind !== 'func') return
      const name = param.ident as string
      scope.symbols.set(name, { kind: 'func', type: value.type, inline: value.inline, alias: value.name })
      // For the editor: the parameter is defined at its name, which stands
      // after the `comptime` its span starts with.
      if (param.identSpan) this.recordDefinition(name, inst.index * INSTANCE_STRIDE + param.identSpan.start)
    })
  }

  // Instance bodies are checked when the checker is at rest, each as a function
  // of the module that declares the generic: a generic's body sees its own
  // module, and nothing of a caller's locals, loops or narrowed ranges.
  // Instances a body asks for join the queue. Recursion needs nothing special:
  // an instance is known before its body is checked.
  private drainInstances(): void {
    for (let inst = this.instanceQueue.shift(); inst; inst = this.instanceQueue.shift()) {
      // Of a chain that never ends, the one error is all there is to say.
      if (inst.chain.stopped) continue
      this.currentInstance = inst
      this.instanceDefs.clear()
      this.checkFuncBody(inst.decl)
    }
    this.currentInstance = null
  }

  // A generic's body is checked per instance, with its types filled in, and
  // not where it is declared.
  private skipGenericBody(decl: AST.FuncDecl): void {
    this.literalSlots.set(decl, this.pendingLiterals.length)
    // What the declaration names in its module is used by it, instantiated
    // or not: a module that only exports its generics has no instance of them,
    // and every helper of theirs would be reported as never used. Without
    // types this is read off the syntax: a name the generic itself declares
    // (a parameter, a let, a loop variable) is taken to be that one.
    const { names, locals } = namesIn(decl)
    for (const { name, offset } of names) {
      if (locals.has(name) || !this.moduleScope.symbols.has(name)) continue
      // Which of the functions that share a name a call means is known only
      // in an instance: all of them count as used.
      for (const known of this.overloads.get(name) ?? [name]) this.recordReference(known, offset)
    }
    // A type parameter is in no instance: the copy is made without it, and
    // with the type in the place of every use. Where it is declared and used
    // is read off the declaration too, for the editor to find.
    for (const param of genericParams(decl)) {
      if (!isTypeParam(param) || !param.identSpan) continue
      const declared = param.identSpan.start
      const uses = names.filter((n) => n.name === param.ident).map((n) => n.offset)
      this.references.set(declared, uses)
      for (const use of uses) this.symbolRefs.set(use, declared)
    }
  }

  // The literals of an instance body are registered when the body is checked,
  // after everything else in the module. Data is laid out in the order
  // literals are registered, so they are moved to where the same function
  // written by hand in the generic's place would have registered them: the
  // instances of one generic follow each other in the order of their names,
  // as their code does. Without this a generic with a string in its body and
  // its hand-written twin would differ in every address.
  private placeInstanceLiterals(): void {
    const own = this.pendingLiterals.filter((lit) => lit.id < INSTANCE_STRIDE)
    if (own.length === this.pendingLiterals.length) return
    const ofInstance = (inst: Instance) => {
      const base = inst.index * INSTANCE_STRIDE
      return this.pendingLiterals.filter((lit) => lit.id >= base && lit.id < base + INSTANCE_STRIDE)
    }
    const placed: { at: number; literals: PendingLiteral[] }[] = []
    for (const [generic, at] of this.literalSlots) {
      const instances = this.instances.filter((inst) => inst.of === generic).sort((a, b) => (a.name < b.name ? -1 : 1))
      placed.push({ at, literals: instances.flatMap(ofInstance) })
    }
    // Slots were noted in source order: filling the last one first leaves the
    // positions of the earlier ones as they were noted.
    for (const { at, literals } of placed.reverse()) own.splice(at, 0, ...literals)
    this.pendingLiterals = own
  }

  // An offset inside an instance, as the place in the generic's source it was
  // copied from, with the instance named in the message.
  private atSource(offset: number, message: string): TypeError {
    if (offset < INSTANCE_STRIDE) return { offset, message }
    const inst = this.instances[Math.floor(offset / INSTANCE_STRIDE) - 1]
    if (!inst) return { offset: offset % INSTANCE_STRIDE, message }
    // The calls the instance exists for: the one that first asked for it,
    // and while that call is inside an instance, the one that asked for that.
    const notes: NonNullable<TypeError['notes']> = []
    for (let at = inst.requestedAt; notes.length < MAX_NOTES; ) {
      notes.push({ offset: at % INSTANCE_STRIDE, message: 'required from' })
      const outer = this.instances[Math.floor(at / INSTANCE_STRIDE) - 1]
      if (!outer) break
      at = outer.requestedAt
    }
    return { offset: offset % INSTANCE_STRIDE, message: `${message}, in ${inst.label}`, notes }
  }

  // === Scope Lookup ===

  // === Range narrowing ===
  //
  // A comparison with a constant narrows an unsigned variable's range where it
  // is known to hold: `if i < 12 { ... }` makes i a u32#12 inside the branch,
  // and `return when i >= 12` makes it one for the rest of the block. That is
  // what lets `buf[i]` on a *[12]T skip the bounds check. A variable assigned
  // anywhere in the region isn't narrowed.

  private narrowings: Map<string, ResolvedType>[] = []

  private narrowedType(name: string): ResolvedType | undefined {
    for (let i = this.narrowings.length - 1; i >= 0; i--) {
      const t = this.narrowings[i].get(name)
      if (t) return t
    }
    return undefined
  }

  // Run check with the given bounds in effect, for variables region doesn't assign.
  private withNarrowing<T>(bounds: Map<string, bigint>, region: unknown, check: () => T): T {
    const types = new Map<string, ResolvedType>()
    for (const [name, bound] of bounds) {
      const sym = this.lookup(name)
      if (!sym || (sym.kind !== 'local' && sym.kind !== 'param' && sym.kind !== 'return')) continue
      const base = unwrap(this.narrowedType(name) ?? sym.type)
      if (base.kind !== 'primitive' || !isUnsignedName(base.name)) continue
      if (assignsVariable(region, name)) continue
      const current = base.max !== undefined ? BigInt(base.max) : unsignedLimit(base)
      if (current !== null && current <= bound) continue
      if (bound > BigInt(Number.MAX_SAFE_INTEGER)) continue
      types.set(name, primitive(base.name, Number(bound)))
    }
    if (types.size === 0) return check()
    this.narrowings.push(types)
    try {
      return check()
    } finally {
      this.narrowings.pop()
    }
  }

  // Upper bounds (exclusive) that hold for variables when cond is true (or false).
  private boundsFrom(cond: AST.Expr, truth: boolean): Map<string, bigint> {
    const out = new Map<string, bigint>()
    const add = (name: string, bound: bigint) => {
      const prev = out.get(name)
      if (prev === undefined || bound < prev) out.set(name, bound)
    }
    const merge = (m: Map<string, bigint>) => { for (const [k, v] of m) add(k, v) }
    let e = cond
    while (e.kind === 'TupleExpr' && e.elements.length === 1 && e.elements[0].value && !e.elements[0].name) e = e.elements[0].value
    if (e.kind === 'UnaryExpr' && e.op === '!') return this.boundsFrom(e.operand, !truth)
    if (e.kind !== 'BinaryExpr') return out
    if ((e.op === '&&' && truth) || (e.op === '||' && !truth)) {
      merge(this.boundsFrom(e.left, truth))
      merge(this.boundsFrom(e.right, truth))
      return out
    }
    // Normalize to `name OP constant`, then to an exclusive bound when it holds.
    const flip: Record<string, string> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=' }
    let op: string = e.op
    let name: string | null = null
    let constant: AST.Expr | null = null
    if (e.left.kind === 'IdentExpr') {
      name = e.left.name
      constant = e.right
    } else if (e.right.kind === 'IdentExpr' && flip[op]) {
      name = e.right.name
      constant = e.left
      op = flip[op]
    }
    if (!name || !constant) return out
    const k = this.evalComptimeExpr(constant) as unknown as { kind: string; value?: bigint } | null
    if (!k || k.kind !== 'int' || typeof k.value !== 'bigint' || k.value < 0n) return out
    const holds = truth ? op : ({ '<': '>=', '<=': '>', '>': '<=', '>=': '<', '==': '!=', '!=': '==' } as Record<string, string>)[op]
    if (holds === '<' && k.value > 0n) add(name, k.value)
    else if (holds === '<=' || holds === '==') add(name, k.value + 1n)
    return out
  }

  // Bounds that hold after each of these conditions was false.
  private boundsAfterAllFalse(conds: AST.Expr[]): Map<string, bigint> {
    const out = new Map<string, bigint>()
    for (const c of conds) {
      for (const [k, v] of this.boundsFrom(c, false)) {
        const prev = out.get(k)
        if (prev === undefined || v < prev) out.set(k, v)
      }
    }
    return out
  }

  lookup(name: string): Symbol | undefined {
    let scope: Scope | null = this.currentScope
    while (scope) {
      const sym = scope.symbols.get(name)
      if (sym) {
        // An instance is a function of the module, and its body is checked
        // after the tests. What a test declared is not there for it: the
        // function would not exist in a build without tests, and in one with
        // them it is not a name the instance's code can call.
        const hidden = this.currentInstance && scope === this.moduleScope && this.testOnly.has(name)
        return hidden ? undefined : sym
      }
      scope = scope.parent
    }
    return undefined
  }

  // === Error Reporting ===

  private findSimilar(name: string): string | null {
    let best: string | null = null
    let bestDist = 3
    // What a look at an expression declares goes into a scope of its own,
    // which is no reason to suggest another name than the check will.
    let local = this.currentScope
    while (local.parent && this.lookScopes.has(local)) local = local.parent
    for (const [candidate] of local.symbols) {
      const dist = editDistance(name, candidate)
      if (dist < bestDist) {
        bestDist = dist
        best = candidate
      }
    }
    for (const [candidate] of this.moduleScope.symbols) {
      // Not a name that could have been meant: an instance's, the one a
      // function that shares its name is known by, or one the code being
      // checked cannot see.
      if (candidate.includes('<') || candidate.includes(':') || !this.lookup(candidate)) continue
      const dist = editDistance(name, candidate)
      if (dist < bestDist) {
        bestDist = dist
        best = candidate
      }
    }
    return best
  }

  error(offset: number, message: string): void {
    this.errorsReported++
    const error = this.atSource(offset, message)
    if (!this.errors.some((e) => e.offset === error.offset && e.message === error.message)) {
      this.errors.push(error)
    }
  }

  warn(offset: number, message: string): void {
    const warning = this.atSource(offset, message)
    if (!this.warnings.some((w) => w.offset === warning.offset && w.message === warning.message)) {
      this.warnings.push(warning)
    }
  }

  // === Reference Tracking ===

  findIdentOffset(declStart: number, keyword: string): number | null {
    if (!this.source) return null
    let i = declStart + keyword.length
    while (i < this.source.length && /\s/.test(this.source[i])) i++
    return i
  }

  recordDefinition(name: string, offset: number): void {
    if (offset >= INSTANCE_STRIDE) {
      // An instance's parameters and locals are copies of the generic's. The
      // first instance stands for the generic where the editor asks what a
      // name in its body is: its definitions are recorded at their place in
      // the generic's source. The copies in other instances would only repeat
      // them, and none of them is one of the module's names.
      const inst = this.currentInstance
      if (inst?.first && Math.floor(offset / INSTANCE_STRIDE) === inst.index) {
        this.instanceDefs.set(name, offset % INSTANCE_STRIDE)
        this.references.set(offset % INSTANCE_STRIDE, [])
      }
      return
    }
    this.symbolDefOffsets.set(name, offset)
    this.references.set(offset, [])
  }

  // Record a reference to a symbol (looks up def offset by name)
  recordReference(name: string, refOffset: number): void {
    let local: number | undefined
    if (refOffset >= INSTANCE_STRIDE) {
      // From an instance, a use is recorded at its place in the generic's
      // source: of a module-level name always (a helper that only generic
      // bodies call is used), of the instance's own names for the first
      // instance only, which is the one whose definitions are held.
      if (this.lookup(name) !== this.moduleScope.symbols.get(name)) {
        local = this.instanceDefs.get(name)
        if (local === undefined) return
      }
      refOffset %= INSTANCE_STRIDE
    }
    const defOffset = local ?? this.symbolDefOffsets.get(name)
    if (defOffset !== undefined) {
      const refs = this.references.get(defOffset)
      if (refs && !refs.includes(refOffset)) {
        refs.push(refOffset)
      }
      this.symbolRefs.set(refOffset, defOffset)
    }
  }
}

// The names inferBuiltin answers to. What is asked of a name before a call
// of it is inferred (whether x.sqrt() can be the call sqrt(x)) is asked here.
const BUILTIN_NAMES: ReadonlySet<string> = new Set([
  'memzero', 'memset', 'memcpy',
  'sqrt', 'ceil', 'floor', 'trunc', 'nearest', 'copysign',
  'min', 'max', 'abs',
  'clz', 'ctz', 'popcnt',
  'sizeof', 'mul_hi',
])

// === Generics helpers ===

// A generic function or type has no type until it is given its comptime
// arguments.
function typeOfSymbol(sym: Symbol | undefined): ResolvedType | undefined {
  return sym && sym.kind !== 'generic' && sym.kind !== 'typefunc' ? sym.type : undefined
}

// A signature is generic when a parameter is comptime, or is of type `type`
// (which only a comptime parameter can be; the checker says so).
function isGenericSignature(signature: AST.FuncSignature): boolean {
  const input = signature.input
  return input.kind === 'CompositeType' && input.fields.some((f) => f.comptime || f.type.kind === 'TypeType')
}

export function isGenericDecl(decl: AST.FuncDecl): boolean {
  return isGenericSignature(decl.signature)
}

function genericParams(decl: AST.FuncDecl): AST.Field[] {
  return (decl.signature.input as AST.CompositeType).fields
}

function isTypeParam(param: AST.Field): boolean {
  return param.comptime === true && param.type.kind === 'TypeType'
}

// Where the receiver of a method call stands among the arguments of the call
// it is written for: it is the first argument that is not a comptime one.
// With every type parameter written, v.push(u32, 7), those come before it as
// they do in push(u32, v, 7); a comptime function parameter is written in
// either form.
function receiverSlot(decl: AST.FuncDecl, argCount: number): number {
  const params = genericParams(decl)
  const written = argCount === params.length ? params : params.filter((p) => !isTypeParam(p))
  return Math.max(0, written.findIndex((p) => !p.comptime))
}

// Whether `x.name` is a member of a value of this type, as inferMember finds
// one: a field of a struct, also through one pointer, or what a slice, an
// array or a pointer to one has built in.
function hasMember(type: ResolvedType, name: string): boolean {
  const u = unwrap(type)
  const struct = u.kind === 'pointer' ? unwrap(u.pointee) : u
  if (struct.kind === 'tuple' && struct.fields.some((f) => f.name === name)) return true
  const held = type.kind === 'pointer' ? type.pointee : type
  if (held.kind === 'slice') return name === 'ptr' || name === 'len'
  // A many-pointer has no length: `len` is no member of it.
  return held.kind === 'array' && (name === 'ptr' || name === 'wid' || (name === 'len' && held.sizes !== null))
}

// A call argument read as a type, by its syntax alone: what could be written
// after a colon. Forms that only a type can have are already a TypeExpr; the
// rest are expressions that are also types (u32, (i32, i32)). Null for
// anything else: a variable, a literal, ().
function typeOfArg(expr: AST.Expr): AST.Type | null {
  switch (expr.kind) {
    case 'TypeExpr':
      return expr.type
    case 'IdentExpr':
      return PRIMITIVE_NAMES.has(expr.name)
        ? { kind: 'PrimitiveType', name: expr.name as AST.PrimitiveType['name'], span: expr.span }
        : null
    case 'TupleExpr': {
      if (expr.elements.length === 0) return null
      const fields: AST.Field[] = []
      for (const el of expr.elements) {
        const type = el.value ? typeOfArg(el.value) : null
        if (!type) return null
        fields.push({ kind: 'Field', ident: el.name, type, span: el.span })
      }
      return { kind: 'CompositeType', fields, span: expr.span }
    }
    case 'CallExpr': {
      // Vec(u32): a generic type applied, when every argument is a type
      if (expr.callee.kind !== 'IdentExpr' || !/^[A-Z]/.test(expr.callee.name) || expr.args.length === 0) return null
      const args: AST.Type[] = []
      for (const arg of expr.args) {
        const type = arg.value && !arg.name ? typeOfArg(arg.value) : null
        if (!type) return null
        args.push(type)
      }
      return { kind: 'TypeApply', name: expr.callee.name, args, span: expr.span }
    }
    default:
      return null
  }
}

// Every type name written under an AST node, at any depth, applied or not:
// Pt, Vec(T), and the Slot(K) inside Set(Slot(K)).
function typeUses(node: unknown, found: (AST.TypeRef | AST.TypeApply)[] = []): (AST.TypeRef | AST.TypeApply)[] {
  if (Array.isArray(node)) {
    for (const n of node) typeUses(n, found)
  } else if (node !== null && typeof node === 'object' && !(node instanceof Uint8Array)) {
    const n = node as { kind?: string }
    if (n.kind === 'TypeRef' || n.kind === 'TypeApply') found.push(n as AST.TypeRef | AST.TypeApply)
    for (const [key, value] of Object.entries(n)) if (key !== 'span') typeUses(value, found)
  }
  return found
}

// The applications among them: Vec(T), and the Slot(K) inside Set(Slot(K)).
function typeApplications(node: unknown): AST.TypeApply[] {
  return typeUses(node).filter((t): t is AST.TypeApply => t.kind === 'TypeApply')
}

// How a generic type is applied, for a message: Vec(T), Pair(A, B)
function typeFuncForm(decl: AST.TypeFuncDecl): string {
  return `${decl.ident}(${decl.params.map((p) => p.ident).join(', ')})`
}

// A type as it was written, for a message
function typeText(type: AST.Type): string {
  switch (type.kind) {
    case 'PrimitiveType':
      return type.max !== undefined ? `${type.name}#${type.max}` : type.name
    case 'TypeRef':
      return type.name
    case 'TypeApply':
      return `${type.name}(${type.args.map(typeText).join(', ')})`
    case 'BoundType':
      return typeToString(type.type)
    case 'PointerType':
      return `${type.optional ? '?' : ''}*${type.mutable ? 'mut ' : ''}${typeText(type.pointee)}`
    case 'IndexedType': {
      const size = type.manyPointer ? '*' : type.size === null ? '' : Array.isArray(type.size) ? type.size.join('x') : type.size === 'inferred' ? '_' : `${type.size}`
      return `${type.optional ? '?' : ''}[${size}]${type.mutable ? 'mut ' : ''}${typeText(type.element)}`
    }
    case 'CompositeType':
      return `(${type.fields.map((f) => (f.ident ? `${f.ident}: ` : '') + typeText(f.type)).join(', ')})`
    case 'FuncType':
      return `${typeText(type.input)} -> ${typeText(type.output)}`
    case 'ComptimeIntType':
      return `int(${type.value})`
    case 'ComptimeFloatType':
      return `float(${type.value})`
    case 'TypeType':
      return 'type'
  }
}

// A function's type as a comptime function parameter declares it: the types
// of its parameters and results, without their names. Several results keep
// theirs, which are what makes them the fields of a struct.
function signatureText(type: FuncRT): string {
  const list = (fields: ResolvedField[], names: boolean) =>
    fields.map((f) => (names && f.name ? `${f.name}: ` : '') + typeToString(f.type)).join(', ')
  const results = type.returns.length === 1 ? typeToString(type.returns[0].type) : `(${list(type.returns, true)})`
  return `(${list(type.params, false)}) -> ${results}`
}

// Whether a function of the type `given` is what a comptime function
// parameter of the type `wanted` takes: the same type, the names of
// parameters and results aside, or one that differs only in how a struct
// result is written. `-> (sum: f64, n: u32)` lists as results the fields
// that `-> Acc(f64)` returns as one value; a call of either gives the same
// values, and what the first gives can be assigned where the second is expected.
function sameSignature(wanted: FuncRT, given: FuncRT): boolean {
  if (!hasOwnType(wanted) || !hasOwnType(given)) return false
  if (canonicalKey(wanted) === canonicalKey(given)) return true
  const asStruct = ({ params, returns }: FuncRT) => {
    const only = returns.length === 1 ? unwrap(returns[0].type) : null
    return canonicalKey(func(params, [field(null, only?.kind === 'tuple' ? only : tuple(returns))]))
  }
  return asStruct(wanted) === asStruct(given)
}

// Whether a type is the recovery type, or what points to it, holds it or
// names it: a parameter `v: *Vex(u32)` whose type did not resolve, or one
// `v: *V` where `type V = Vex(u32)`. Nothing is said about its fields or
// elements either.
function unresolved(type: ResolvedType): boolean {
  if (type === RECOVERY) return true
  if (type.kind === 'named') return unresolved(type.type)
  if (type.kind === 'pointer') return unresolved(type.pointee)
  return (type.kind === 'slice' || type.kind === 'array') && unresolved(type.element)
}

// Whether a value of this type can decide a type parameter. An untyped literal
// (7, 0.5, [1, 2, 3]) has no type of its own: it takes the one it is used as.
function hasOwnType(type: ResolvedType): boolean {
  const t = unwrap(type)
  switch (t.kind) {
    case 'comptime_int':
    case 'comptime_float':
    case 'comptime_list':
    case 'comptime_array':
      return false
    case 'tuple':
      return t.fields.every((f) => hasOwnType(f.type))
    case 'array':
    case 'slice':
      return hasOwnType(t.element)
    case 'pointer':
      return hasOwnType(t.pointee)
    case 'func':
      return t.params.every((p) => hasOwnType(p.type)) && t.returns.every((r) => hasOwnType(r.type))
    default:
      return true
  }
}

// Whether a type has no values: (), which is also what a call of a function
// without a result has. Nothing can be passed for a parameter of this type, so
// a type parameter is never bound to it.
function isUnit(type: ResolvedType): boolean {
  const t = unwrap(type)
  return t.kind === 'void' || (t.kind === 'tuple' && t.fields.length === 0)
}

// A type without the aliases that only rename it: an alias of a number, a
// pointer, a slice or another alias is replaced by what it names, at any
// depth. The alias of a struct or tuple stays, since its name is how the type
// is known.
function plain(type: ResolvedType): ResolvedType {
  switch (type.kind) {
    case 'named': {
      if (type.type.kind === 'tuple') return type
      return plain(type.type)
    }
    case 'pointer': {
      const pointee = plain(type.pointee)
      return pointee === type.pointee ? type : { ...type, pointee }
    }
    case 'slice':
    case 'array': {
      const element = plain(type.element)
      return element === type.element ? type : { ...type, element }
    }
    case 'tuple': {
      const fields = type.fields.map((f) => field(f.name, plain(f.type)))
      return fields.every((f, i) => f.type === type.fields[i].type) ? type : tuple(fields)
    }
    case 'func': {
      const [params, returns] = [type.params, type.returns].map((fs) => fs.map((f) => field(f.name, plain(f.type))))
      const same = [...params, ...returns].every((f, i) => f.type === [...type.params, ...type.returns][i].type)
      return same ? type : func(params, returns)
    }
    default:
      return type
  }
}

// What a value's type is as a type argument: without a range the value was
// only known to lie in. A loop counter that is a u32#12 here decides u32, also
// as part of a tuple. A range someone wrote stays where a value cannot have
// picked it up: behind a pointer, in a slice, under a struct's name.
function withoutRanges(type: ResolvedType): ResolvedType {
  const u = unwrap(type)
  if (u.kind === 'primitive') return u.max !== undefined ? primitive(u.name) : type
  if (type.kind !== 'tuple') return type
  const fields = type.fields.map((f) => field(f.name, withoutRanges(f.type)))
  return fields.every((f, i) => f.type === type.fields[i].type) ? type : tuple(fields)
}

// The name of a type that is referred to but not resolved yet, if there is
// one. A type that refers to itself keeps a forward reference inside its own
// alias; that one is resolved.
function unresolvedName(type: ResolvedType, inside: readonly string[] = []): string | null {
  const first = (types: ResolvedType[]) => {
    for (const t of types) {
      const name = unresolvedName(t, inside)
      if (name) return name
    }
    return null
  }
  switch (type.kind) {
    case 'forward_ref':
      return inside.includes(type.name) ? null : type.name
    case 'named':
      return inside.includes(type.name) ? null : unresolvedName(type.type, [...inside, type.name])
    case 'pointer':
      return unresolvedName(type.pointee, inside)
    case 'array':
    case 'slice':
      return unresolvedName(type.element, inside)
    case 'tuple':
      return first(type.fields.map((f) => f.type))
    case 'func':
      return first([...type.params, ...type.returns].map((f) => f.type))
    default:
      return null
  }
}

// Whether a parameter's declared type names a type parameter that nothing has
// decided yet.
function mentionsUnbound(
  type: AST.Type,
  typeParams: readonly string[],
  bound: ReadonlyMap<string, ResolvedType>,
  expand?: ExpandTypeApply,
): boolean {
  const inner = (t: AST.Type) => mentionsUnbound(t, typeParams, bound, expand)
  switch (type.kind) {
    case 'TypeRef':
      return typeParams.includes(type.name) && !bound.has(type.name)
    case 'PointerType':
      return inner(type.pointee)
    case 'IndexedType':
      return inner(type.element)
    case 'CompositeType':
      return type.fields.some((f) => inner(f.type))
    case 'FuncType':
      return inner(type.input) || inner(type.output)
    case 'TypeApply': {
      // Seen through, where the generic type is known: Tagged(T) mentions T
      // only if a field of Tagged is made of it.
      const body = expand?.(type)
      return body ? inner(body) : type.args.some(inner)
    }
    default:
      return false
  }
}

// The body of a generic type as one application of it reads, or null where
// the name is not a generic type's
type ExpandTypeApply = (applied: AST.TypeApply) => AST.Type | null

// Lays a parameter's declared type over its argument's type and binds the type
// parameters it finds. It looks through the conversions an argument gets
// anyway (*mut to *, an array pointer to a slice) and only binds: whether the
// argument fits is decided afterwards, by the ordinary argument check.
function matchType(
  pattern: AST.Type,
  actual: ResolvedType,
  typeParams: readonly string[],
  bound: Map<string, ResolvedType>,
  value = true,
  expand?: ExpandTypeApply,
): void {
  const u = unwrap(actual)
  switch (pattern.kind) {
    case 'TypeRef':
      // A later argument never re-decides, and () decides nothing.
      if (!typeParams.includes(pattern.name) || bound.has(pattern.name) || isUnit(actual)) return
      // `value`: nothing but tuples lies between the argument and this part
      // of it, so it is a value the argument holds, not memory it points to.
      bound.set(pattern.name, value ? withoutRanges(actual) : actual)
      return
    case 'PointerType':
      // A many-pointer is not a pointer to something T could be: what it
      // points to is an array of unknown length, which is no type by itself.
      // Only [*]T matches it.
      if (u.kind === 'pointer' && !(u.pointee.kind === 'array' && u.pointee.sizes === null)) {
        matchType(pattern.pointee, u.pointee, typeParams, bound, false, expand)
      }
      return
    case 'IndexedType': {
      const element =
        u.kind === 'slice' || u.kind === 'array' ? u.element
        : u.kind === 'pointer' && u.pointee.kind === 'array' ? u.pointee.element
        : null
      if (element) matchType(pattern.element, element, typeParams, bound, false, expand)
      return
    }
    case 'CompositeType':
      if (u.kind === 'tuple' && u.fields.length === pattern.fields.length) {
        pattern.fields.forEach((f, i) => {
          matchType(f.type, u.fields[i].type, typeParams, bound, value, expand)
        })
      }
      return
    case 'FuncType': {
      // The types of a function's parameters and results are written by
      // someone, like what stands behind a pointer: they bind as they are.
      if (u.kind !== 'func') return
      const side = (written: AST.Type, fields: ResolvedField[]) => {
        const types = written.kind === 'CompositeType' ? written.fields.map((f) => f.type) : [written]
        if (types.length !== fields.length) return
        types.forEach((t, i) => {
          matchType(t, fields[i].type, typeParams, bound, false, expand)
        })
      }
      side(pattern.input, u.params)
      side(pattern.output, u.returns)
      return
    }
    case 'TypeApply': {
      // A generic type is seen through: its body is laid over the argument,
      // however the argument's type was written.
      const body = expand?.(pattern)
      if (body) matchType(body, actual, typeParams, bound, value, expand)
      return
    }
    default:
      return
  }
}

// A copy of a generic's declaration, or of its signature alone, with the type
// parameters replaced by these types and the comptime parameters gone: an
// ordinary function's. Its offsets are the declaration's plus `delta`.
function bindTypes(of: AST.FuncDecl, params: AST.Field[], values: ComptimeValue[], delta: number, part?: 'signature'): AST.FuncDecl {
  const bound = new Map<string, ResolvedType>()
  params.forEach((p, i) => {
    const value = values[i]
    if (value.kind === 'type') bound.set(p.ident as string, value.type)
  })
  const subst = (name: string): AST.BoundType | undefined => {
    const type = bound.get(name)
    return type && { kind: 'BoundType', name, type, span: { start: 0, end: 0 } }
  }
  const decl = (part ? { ...of, signature: cloneAst(of.signature, delta, subst) } : cloneAst(of, delta, subst)) as AST.FuncDecl
  const input = decl.signature.input as AST.CompositeType
  input.fields = input.fields.filter((f) => !f.comptime)
  return decl
}

// The marks the checker leaves on the literals of an expression (that it is
// writable data, and which data entry it is), to put them back as they were.
type LiteralMarks = { mut?: boolean; dataId?: number }
function literalMarks(node: unknown, skip: (call: AST.CallExpr) => boolean, found: { node: LiteralMarks; marks: LiteralMarks }[] = []) {
  if (Array.isArray(node)) {
    for (const n of node) literalMarks(n, skip, found)
  } else if (node !== null && typeof node === 'object' && !(node instanceof Uint8Array)) {
    const n = node as LiteralMarks & { kind?: string }
    if (n.kind === 'CallExpr' && skip(n as AST.CallExpr)) return found
    if (n.kind === 'LiteralExpr' || n.kind === 'ArrayExpr' || n.kind === 'RepeatExpr' || n.kind === 'TupleExpr') {
      const marks: LiteralMarks = {}
      if ('mut' in n) marks.mut = n.mut
      if ('dataId' in n) marks.dataId = n.dataId
      found.push({ node: n, marks })
    }
    for (const [key, value] of Object.entries(n)) if (key !== 'span') literalMarks(value, skip, found)
  }
  return found
}

// The name of an instance, as a symbol and in WAT: the generic's name and the
// key of its arguments.
function instanceName(generic: string, key: string, taken: (name: string) => boolean): string {
  return keyedName(`${generic}<`, key, '>', taken)
}

// A name made of a prefix, a key of types and a suffix: an instance's
// (max<u32>), and that of a function that shares its name (hash:''u8). The
// key of a large struct type runs to kilobytes, so a long one is cut and told
// apart by a hash of the whole.
function keyedName(prefix: string, key: string, suffix: string, taken: (name: string) => boolean): string {
  if (key.length <= MAX_NAME_KEY) return `${prefix}${key}${suffix}`
  // FNV-1a, 32 bits from each end of the key
  const hash = (text: string) => {
    let h = 0x811c9dc5
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
    return (h >>> 0).toString(16).padStart(8, '0')
  }
  const short = `${prefix}${key.slice(0, MAX_NAME_KEY / 2)}~${hash(key)}${hash([...key].reverse().join(''))}`
  // Two keys with one hash would be one name: number them apart.
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${short}${suffix}` : `${short}~${n}${suffix}`
    if (!taken(name)) return name
  }
}

// The parameter types of a function as one key: two functions may share a
// name when theirs differ. A type that is no type of a value (int(5), written
// out as a parameter's) has no canonical key and is told apart as it reads.
function paramsKey(type: FuncRT): string {
  return type.params.map((p) => watSafe(hasOwnType(p.type) ? canonicalKey(p.type) : typeToString(p.type))).join('|')
}

function paramsText(type: FuncRT): string {
  return type.params.map((p) => typeToString(p.type)).join(', ')
}

// The name a function was declared with, from the name it is known by: a
// function that shares its name is known by the name and its parameter types.
export function declaredName(name: string): string {
  const cut = name.indexOf(':')
  return cut < 0 ? name : name.slice(0, cut)
}

// A number literal as it would be written, for a message
function literalText(grouped: AST.Expr): string | null {
  const expr = ungrouped(grouped)
  if (expr.kind !== 'LiteralExpr') return null
  if (expr.value.kind === 'int') return expr.value.value.toString()
  if (expr.value.kind === 'float') {
    return Number.isInteger(expr.value.value) ? expr.value.value.toFixed(1) : String(expr.value.value)
  }
  return null
}

// The names a function declares for itself: parameters, results and locals.
export function localNames(decl: AST.FuncDecl): Set<string> {
  return namesIn(decl).locals
}

// The generic function around `offset` that declares `name` for itself: a
// parameter, a type parameter, a result or a local. Such a name is in no
// table of names, so looked up by name alone it would be taken for whatever
// else is spelled the same: a global, another function's local, a builtin.
// A generic type declares its type parameters and the fields of its body.
export function genericDeclaring(module: AST.Module, offset: number, name: string): AST.FuncDecl | AST.TypeFuncDecl | null {
  for (const decl of module.decls) {
    const item = decl.kind === 'ExportDecl' ? decl.item : decl
    if (offset < item.span.start || offset >= item.span.end) continue
    if (item.kind === 'FuncDecl' && isGenericDecl(item)) return localNames(item).has(name) ? item : null
    if (item.kind === 'TypeFuncDecl') return fieldNames([item.params, item.body]).has(name) ? item : null
  }
  return null
}

// The generic function whose declaration `offset` lies in
export function genericAround(module: AST.Module, offset: number): AST.FuncDecl | null {
  for (const decl of module.decls) {
    const fn = decl.kind === 'FuncDecl' ? decl : decl.kind === 'ExportDecl' && decl.item.kind === 'FuncDecl' ? decl.item : null
    if (fn && isGenericDecl(fn) && offset >= fn.span.start && offset < fn.span.end) return fn
  }
  return null
}

// The names of the fields written under an AST node, at any depth: the
// parameters of a generic type, and the fields of the struct it is.
function fieldNames(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const n of node) fieldNames(n, found)
  } else if (node !== null && typeof node === 'object' && !(node instanceof Uint8Array)) {
    const n = node as { kind?: string; ident?: unknown }
    if (n.kind === 'Field' && typeof n.ident === 'string') found.add(n.ident)
    for (const [key, value] of Object.entries(n)) if (key !== 'span') fieldNames(value, found)
  }
  return found
}

// The names a declaration refers to, with where, and the names it declares.
function namesIn(decl: AST.FuncDecl): { names: { name: string; offset: number }[]; locals: Set<string> } {
  const names: { name: string; offset: number }[] = []
  const locals = new Set<string>()
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (node === null || typeof node !== 'object' || node instanceof Uint8Array) return
    const n = node as Record<string, unknown> & { span?: AST.Span }
    const declares = (name: unknown) => {
      if (typeof name === 'string') locals.add(name)
    }
    switch (n.kind) {
      case 'IdentExpr':
      case 'TypeRef':
      case 'TypeApply':
        if (n.span) names.push({ name: n.name as string, offset: n.span.start })
        break
      case 'CallExpr': {
        // x.f(a) may be a call of the function f.
        const callee = n.callee as AST.Expr
        if (callee.kind === 'MemberExpr' && callee.member.kind === 'field') {
          names.push({ name: callee.member.name, offset: callee.span.end - callee.member.name.length })
        }
        break
      }
      case 'Field':
        declares(n.ident)
        break
      case 'IdentPattern':
      case 'binding':
        declares(n.name)
        break
      case 'named':
        declares(n.binding ?? n.field)
        break
      case 'ForBinding':
        declares(n.value)
        declares(n.index)
        break
    }
    for (const [key, value] of Object.entries(n)) if (key !== 'span') visit(value)
  }
  visit(decl.signature)
  visit(decl.body)
  return { names, locals }
}

// A deep copy of an AST subtree with every span moved by `delta` and every
// type name that `subst` knows replaced by what it returns. This is the whole
// of instantiation: the copy is ordinary source as far as the rest of the
// compiler can tell. It is always made from the declaration as parsed, never
// from another copy, so no offset is moved twice. Every node of the copy is a
// new object (only the bytes of a string are shared): the types and
// conversions the checker records by node are then the copy's alone.
function cloneAst(node: unknown, delta: number, subst: (name: string) => AST.Type | undefined): unknown {
  if (Array.isArray(node)) return node.map((n) => cloneAst(n, delta, subst))
  if (node === null || typeof node !== 'object' || node instanceof Uint8Array) return node
  const n = node as Record<string, unknown>
  const shift = (span: unknown): AST.Span => {
    const { start, end } = span as AST.Span
    return { start: start + delta, end: end + delta }
  }
  if (n.kind === 'TypeRef' || n.kind === 'IdentExpr') {
    const to = subst(n.name as string)
    if (to) {
      const type: AST.Type = { ...to, span: shift(n.span) }
      // An upper-case name is an expression only as the callee of T(a, b)
      return n.kind === 'TypeRef' ? type : { kind: 'TypeExpr', type, span: type.span }
    }
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(n)) {
    out[k] = k === 'span' ? shift(v) : cloneAst(v, delta, subst)
  }
  return out
}

// Each node of a generic's declaration with its copy in one instance. What
// the checker recorded by node is the instance's; the editor asks about the
// generic's own nodes, and finds the answer of an instance through this. The
// copy is cloneAst's: the same shape, save that the comptime parameters are
// gone from its parameter list.
export function instanceNodes(of: AST.FuncDecl, decl: AST.FuncDecl): Map<object, object> {
  const copies = new Map<object, object>()
  const pair = (node: unknown, copy: unknown): void => {
    if (Array.isArray(node) && Array.isArray(copy)) {
      const kept = node.length === copy.length ? node : node.filter((n) => !(n as AST.Field).comptime)
      kept.forEach((n, i) => {
        pair(n, copy[i])
      })
      return
    }
    if (node === null || copy === null || typeof node !== 'object' || typeof copy !== 'object' || node instanceof Uint8Array) return
    copies.set(node, copy)
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'span') pair(value, (copy as Record<string, unknown>)[key])
    }
  }
  pair(of, decl)
  return copies
}

function editDistance(a: string, b: string): number {
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  )
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[a.length][b.length]
}

const COMPARISON_OPS: ReadonlySet<string> = new Set(['==', '!=', '<', '>', '<=', '>='])
const SHIFT_OPS: ReadonlySet<string> = new Set(['<<', '>>', '<<<', '>>>'])
const BITWISE_OPS: ReadonlySet<string> = new Set(['&', '|', '^'])
const SATURATING_OPS: ReadonlySet<string> = new Set(['+|', '-|', '*|'])

function isComptimeNumber(t: ResolvedType): t is ResolvedType & { kind: 'comptime_int' | 'comptime_float' } {
  return t.kind === 'comptime_int' || t.kind === 'comptime_float'
}

// A single number or bool: what the arithmetic, bitwise and comparison
// operators work on.
function isScalar(t: ResolvedType): boolean {
  return t.kind === 'primitive' || isComptimeNumber(t)
}

// A ranged integer type (u32#8) as the plain type its values are held in (u32).
function stripMax(t: ResolvedType): ResolvedType {
  return t.kind === 'primitive' && t.max !== undefined ? primitive(t.name) : t
}

// What an operator or a compound assignment is told when it has no meaning
// for its operands: a struct, a tuple, a slice or an array on either side, or
// a pointer with something that is no address. The one place for the wording,
// which a generic's users meet whenever a type argument lacks an operator.
function noOperator(op: string, left: ResolvedType, right: ResolvedType): string {
  return `'${op}' cannot be applied to ${typeToString(left)} and ${typeToString(right)}`
}

// Why an operator can't take an operand of this type, or null when it can.
function operandProblem(op: string, type: ResolvedType): string | null {
  const t = unwrap(type)
  if (t.kind === 'comptime_float' || isFloat(t)) {
    const integerOnly = op === '%' || BITWISE_OPS.has(op) || SHIFT_OPS.has(op) || SATURATING_OPS.has(op)
    return integerOnly ? `'${op}' needs integer operands, not ${typeToString(type)}` : null
  }
  if (isBool(t)) {
    const boolean = op === '==' || op === '!=' || BITWISE_OPS.has(op)
    return boolean ? null : `'${op}' cannot be applied to bool: cast it to an integer first`
  }
  const wide = t.kind === 'primitive' && (byteSize(t) ?? 0) >= 16
  if (wide && (op === '/' || op === '%' || SATURATING_OPS.has(op))) {
    return `'${op}' on ${typeToString(type)} is not supported yet`
  }
  return null
}

// Why a value of one type can't be cast to another, or null when it can. A
// cast converts between numbers, bools and addresses: single values. Anything
// else (a slice, a struct) can only be cast to a type it's already held as.
function castProblem(from: ResolvedType, to: ResolvedType): string | null {
  const f = unwrap(from)
  const t = unwrap(to)
  const single = (x: ResolvedType) => x.kind === 'primitive' || x.kind === 'pointer' || x.kind === 'func' || isComptimeNumber(x)
  const cannot = `cannot cast ${typeToString(from)} to ${typeToString(to)}`
  if (!single(f) || !single(t)) {
    const same = !single(f) && !single(t) && typeAssignable(to, from) && sameRepresentation(f, t)
    return same ? null : cannot
  }
  const wide = (x: ResolvedType) => x.kind === 'primitive' && (byteSize(x) ?? 0) >= 16
  const float = (x: ResolvedType) => isFloat(x) || x.kind === 'comptime_float'
  if ((wide(f) && float(t)) || (float(f) && wide(t))) return `${cannot}: not supported yet`
  // A bool is 0 or 1. Cutting a number down to its low bits doesn't make one
  // (256 isn't false), and which test is meant is for the program to say.
  if (isBool(t) && !isBool(f)) return `${cannot}: compare it instead (x != 0)`
  return null
}

// The operand of a cast: `x as T`, or `T(x)` with a primitive type.
function castOperand(expr: AST.Expr): AST.Expr | null {
  if (expr.kind === 'CastExpr') return expr.expr
  if (expr.kind !== 'CallExpr' || expr.callee.kind !== 'IdentExpr' || !PRIMITIVE_NAMES.has(expr.callee.name)) return null
  const args = expr.args.filter((a) => a.value !== null)
  return args.length === 1 ? args[0].value : null
}

// A constant as a type holds it: an integer wrapped to the type's width and
// sign, a float rounded to it. Any other type holds the value as it is.
function constantIn(value: ComptimeValue, type: ResolvedType): ComptimeValue {
  const t = unwrap(type)
  if (t.kind !== 'primitive' || isBool(t) || (value.kind !== 'int' && value.kind !== 'float')) return value
  if (isFloat(t)) {
    if (t.name === 'f64') return { kind: 'float', value: Number(value.value) }
    return { kind: 'float', value: value.kind === 'int' ? nearestF32(value.value) : Math.fround(value.value) }
  }
  if (value.kind === 'float') return value
  const bits = (byteSize(t) ?? 4) * 8
  return { kind: 'int', value: isSigned(t) ? BigInt.asIntN(bits, value.value) : BigInt.asUintN(bits, value.value) }
}

// The f32 nearest an integer. Past 53 bits a double is already rounded, and
// rounding it again can land on the other side of a tie. So keep 53 bits,
// the lowest of them set if any bit below it is: that rounds as the integer does.
function nearestF32(n: bigint): number {
  const size = n < 0n ? -n : n
  const cut = BigInt(Math.max(0, size.toString(2).length - 53))
  const sticky = (size & ((1n << cut) - 1n)) !== 0n ? 1n : 0n
  const nearest = Math.fround(Number(((size >> cut) | sticky) << cut))
  return n < 0n ? -nearest : nearest
}

// What a cast makes of a constant: the value its conversion gives at run
// time (10.2). Null where there isn't one to give: a float outside the
// integer type traps, and an address is only known once data is laid out.
function castConstant(value: ComptimeValue, to: ResolvedType): ComptimeValue | null {
  const t = unwrap(to)
  if (value.kind === 'data_ptr') return null
  if (isBool(t)) return value.kind === 'bool' ? value : null
  const number: ComptimeValue = value.kind === 'bool' ? { kind: 'int', value: value.value ? 1n : 0n } : value
  if (number.kind === 'float' && !isFloat(t)) {
    // Toward zero, into the i32 or i64 the type is held in, then cut to the type.
    const whole = Math.trunc(number.value)
    const bits = (byteSize(t) ?? 4) > 4 ? 64 : 32
    const [low, high] = isSigned(t) ? [-(2 ** (bits - 1)), 2 ** (bits - 1)] : [0, 2 ** bits]
    if (!(whole >= low && whole < high)) return null
    return constantIn({ kind: 'int', value: BigInt(whole) }, to)
  }
  return constantIn(number, to)
}

// The width a shift of this type is done in, which its count is taken
// modulo: that of the wasm integer the value is held in (32 bits for a u8),
// or of the whole of a wide integer, whose helpers do the same. None for a
// constant's own type.
function shiftWidth(type: ResolvedType | undefined): number | null {
  const t = type && unwrap(type)
  const size = t?.kind === 'primitive' && isInteger(t) ? byteSize(t) : null
  return size === null ? null : size <= 4 ? 32 : size * 8
}

// Whether a type holds an address whole: a pointer, or a 32-bit integer.
function holdsAddress(type: ResolvedType | undefined): boolean {
  const t = type && unwrap(type)
  return t?.kind === 'pointer' || (t?.kind === 'primitive' && (t.name === 'i32' || t.name === 'u32'))
}

// The type a slice literal's bytes are counted in, to give its length: its
// element. Null when each element is a literal of its own (a slice, an array
// or a pointer), and the literal is the list of them.
function countedElement(element: ResolvedType): ResolvedType | null {
  const kind = unwrap(element).kind
  return kind === 'slice' || kind === 'array' || kind === 'pointer' ? null : element
}

// The integer type a constant has as an address or an offset from one: 32
// bits, signed only when it's negative.
function addressType(constant: ResolvedType & { kind: 'comptime_int' }): ResolvedType {
  return primitive(constant.value < 0n ? 'i32' : 'u32')
}

// The wasm value(s) a primitive is held in: bool and the integers up to 32
// bits share an i32.
function representation(t: ResolvedType & { kind: 'primitive' }): string {
  if (t.name === 'f32' || t.name === 'f64') return t.name
  const size = byteSize(t) ?? 4
  return size <= 4 ? 'i32' : `i${size * 8}`
}

// Whether a value of one type can be used as another it's assignable to
// without converting any of the wasm values it's held in.
function sameRepresentation(from: ResolvedType, to: ResolvedType): boolean {
  const a = unwrap(from)
  const b = unwrap(to)
  if (a.kind === 'primitive' && b.kind === 'primitive') return representation(a) === representation(b)
  if (a.kind === 'tuple' && b.kind === 'tuple') {
    return a.fields.every((f, i) => b.fields[i] !== undefined && sameRepresentation(f.type, b.fields[i].type))
  }
  if (a.kind === 'array' && b.kind === 'array') return sameRepresentation(a.element, b.element)
  return true
}

function isUnsignedName(name: string): boolean {
  return name.startsWith('u')
}

// One past the largest value an unsigned primitive can hold (u8 → 256), or
// null for types that aren't unsigned integers.
function unsignedLimit(t: ResolvedType): bigint | null {
  if (t.kind !== 'primitive' || !isUnsignedName(t.name)) return null
  const bits = Number(t.name.slice(1))
  return Number.isFinite(bits) && bits > 0 ? 1n << BigInt(bits) : null
}

// One branch of an if or match, with the type of its value.
type Branch = { body: AST.FuncBody | AST.Expr; type: ResolvedType }

// The expression inside (x), which parses as a group or a one-element tuple.
function groupedExpr(expr: AST.Expr): AST.Expr | null {
  if (expr.kind === 'GroupExpr') return expr.expr
  if (expr.kind === 'TupleExpr' && expr.elements.length === 1 && !expr.elements[0].name) return expr.elements[0].value
  return null
}

// `expr` without the parentheses around it, however many there are.
function ungrouped(expr: AST.Expr): AST.Expr {
  const inner = groupedExpr(expr)
  return inner ? ungrouped(inner) : expr
}

// An array written out, element by element or as a repeat: passed for a
// pointer, it is laid out in memory.
function isArrayLiteral(expr: AST.Expr): boolean {
  const inner = ungrouped(expr)
  return inner.kind === 'ArrayExpr' || inner.kind === 'RepeatExpr'
}

// How far from zero a constant integer is.
function magnitude(t: ResolvedType): bigint {
  if (t.kind !== 'comptime_int') return 0n
  return t.value < 0n ? -t.value : t.value
}

// Whether constant `a` stands in for `b` too, where one type has to hold
// both: it's further from zero, or as far and positive, which takes a bit
// more as a signed value (-2147483648 is an i32, 2147483648 isn't).
function standsInFor(a: ResolvedType, b: ResolvedType): boolean {
  if (magnitude(a) !== magnitude(b)) return magnitude(a) > magnitude(b)
  return a.kind === 'comptime_int' && b.kind === 'comptime_int' && a.value > b.value
}

// The constant that stands in for all of these: a float if any of them is
// one, or else the integer that stands in for the others.
function standIn(constants: ResolvedType[]): ResolvedType {
  let type = constants[0]
  for (const t of constants) {
    if (type.kind === 'comptime_float') break
    if (t.kind === 'comptime_float' || standsInFor(t, type)) type = t
  }
  return type
}

// Whether a type is a constant's, or a tuple's with one among its fields.
function holdsConstant(t: ResolvedType): boolean {
  return isComptimeNumber(t) || (t.kind === 'tuple' && t.fields.some(f => holdsConstant(f.type)))
}

// Whether an integer type's bits can hold a constant, signed or unsigned:
// what its wasm constant can be written as.
function hasBitsFor(type: ResolvedType, value: bigint): boolean {
  const t = unwrap(type)
  if (t.kind !== 'primitive' || !isInteger(t)) return true
  const bits = BigInt((byteSize(t) ?? 4) * 8)
  return value >= -(1n << (bits - 1n)) && value < 1n << bits
}

// The expression a branch takes its value from, if it ends in one.
function bodyValue(body: AST.FuncBody | AST.Expr): AST.Expr | null {
  if (body.kind === 'ArrowBody') return body.expr
  if (body.kind !== 'Block') return body
  const last = body.stmts.at(-1)
  return last?.kind === 'ExpressionStmt' ? last.expr : null
}

// Whether control never reaches the end of a branch, so it needs no value.
function bodyExits(body: AST.FuncBody | AST.Expr): boolean {
  return bodyTerminates(body) || (body.kind === 'Block' && alwaysExits(body))
}

// Whether a body ends in an unconditional return, break or continue.
function alwaysExits(body: AST.FuncBody): boolean {
  if (body.kind !== 'Block') return false
  const last = body.stmts.at(-1)
  return !!last && (last.kind === 'ReturnStmt' || last.kind === 'BreakStmt' || last.kind === 'ContinueStmt') && !last.when
}

// Whether anything in an AST subtree assigns to the variable `name`.
function assignsVariable(node: unknown, name: string): boolean {
  if (Array.isArray(node)) return node.some(n => assignsVariable(n, name))
  if (!node || typeof node !== 'object') return false
  const n = node as { kind?: string; target?: { kind?: string; name?: string }; pattern?: { kind?: string; name?: string } }
  if (n.kind === 'AssignmentStmt' && n.target?.kind === 'IdentExpr' && n.target.name === name) return true
  if (n.kind === 'SetStmt' && n.pattern?.kind === 'IdentPattern' && n.pattern.name === name) return true
  for (const [k, v] of Object.entries(node)) {
    if (k !== 'span' && typeof v === 'object' && assignsVariable(v, name)) return true
  }
  return false
}

// Flag a literal as mutable data, so the data section gives it its own bytes.
// The literals laid out as parts of `expr`: its elements, the value it
// repeats, the fields of a struct it holds, down to any depth.
function literalParts(expr: AST.Expr, parts: Set<AST.Expr>): void {
  const inner = expr.kind === 'ArrayExpr' ? expr.elements
    : expr.kind === 'RepeatExpr' ? [expr.value]
    : expr.kind === 'TupleExpr' ? expr.elements.map((e) => e.value)
    : expr.kind === 'CallExpr' ? expr.args.map((a) => a.value)
    : expr.kind === 'AnnotationExpr' || expr.kind === 'GroupExpr' ? [expr.expr]
    : []
  for (const part of inner) {
    if (!part || parts.has(part)) continue
    parts.add(part)
    literalParts(part, parts)
  }
}

function markMut(expr: AST.Expr): void {
  if (expr.kind === 'LiteralExpr' || expr.kind === 'ArrayExpr' || expr.kind === 'RepeatExpr' || expr.kind === 'TupleExpr') {
    ;(expr as { mut?: boolean }).mut = true
  }
}

// === Control-flow termination ===

// Whether control can never fall off the end of these statements: they end in
// an unconditional return, a loop with no break out of it, or an if/else whose
// every branch terminates.
export function blockTerminates(stmts: AST.Statement[]): boolean {
  const last = stmts.at(-1)
  if (!last) return false
  switch (last.kind) {
    case 'ReturnStmt':
      return !last.when
    case 'LoopStmt':
      return !breaksOut(last.body)
    case 'ExpressionStmt':
      return exprTerminates(last.expr)
    default:
      return false
  }
}

function bodyTerminates(body: AST.FuncBody | AST.Expr): boolean {
  if (body.kind === 'Block') return blockTerminates(body.stmts)
  if (body.kind === 'ArrowBody') return exprTerminates(body.expr)
  return exprTerminates(body)
}

function exprTerminates(expr: AST.Expr): boolean {
  if (expr.kind === 'IfExpr') {
    return !!expr.else_ && bodyTerminates(expr.thenBranch) &&
      expr.elifs.every(e => bodyTerminates(e.thenBranch)) && bodyTerminates(expr.else_)
  }
  if (expr.kind === 'MatchExpr') {
    // Every arm returns, and some arm catches everything (a wildcard or a bare
    // binding), so no value falls through.
    const catchAll = expr.arms.some(arm => arm.patterns.some(p => p.kind === 'wildcard' || p.kind === 'binding'))
    return catchAll && expr.arms.every(arm => bodyTerminates(arm.body))
  }
  return false
}

// Whether a loop body contains a break for that loop (not for a nested loop).
function breaksOut(body: AST.FuncBody): boolean {
  let found = false
  const visitBody = (b: AST.FuncBody | AST.Expr) => {
    if (b.kind === 'Block') b.stmts.forEach(visitStmt)
    else if (b.kind === 'ArrowBody') visitExpr(b.expr)
    else visitExpr(b)
  }
  const visitStmt = (st: AST.Statement) => {
    if (found) return
    switch (st.kind) {
      case 'BreakStmt':
        found = true
        return
      case 'WhileStmt':
      case 'LoopStmt':
      case 'ForStmt':
        return // a break in there leaves the inner loop
      case 'ExpressionStmt':
      case 'DeferStmt':
        visitExpr(st.expr)
        return
      case 'LetStmt':
        if (st.value) visitExpr(st.value)
        return
      case 'AssignmentStmt':
        visitExpr(st.value)
        return
      case 'ReturnStmt':
        if (st.value) visitExpr(st.value)
        return
    }
  }
  const visitExpr = (e: AST.Expr) => {
    if (found) return
    if (e.kind === 'IfExpr') {
      visitBody(e.thenBranch)
      for (const elif of e.elifs) visitBody(elif.thenBranch)
      if (e.else_) visitBody(e.else_)
    } else if (e.kind === 'MatchExpr') {
      for (const arm of e.arms) visitBody(arm.body)
    }
  }
  visitBody(body)
  return found
}
