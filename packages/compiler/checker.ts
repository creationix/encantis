// Type checker for Encantis
// Produces a TypeCheckResult with concrete types attached to all AST nodes

import type * as AST from './ast'
import { isSourceImport, resolveModulePath } from './loader'
import {
  type ResolvedType,
  type ResolvedField,
  type ArrayRT,
  type ArraySize,
  type PointerRT,
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
  isNumeric,
  byteSize,
  isFixedSizes,
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

export type Symbol =
  | { kind: 'type'; type: ResolvedType; unique: boolean }
  | { kind: 'func'; type: ResolvedType & { kind: 'func' }; inline: boolean }
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
// lives at source offsets i * INSTANCE_STRIDE + original. Everything keyed by
// offset (types, literals, lowered calls) is then per instance with no further
// bookkeeping; an offset at or above the stride is mapped back before it is
// reported.
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

// The type of an expression whose error is already reported. Compared by
// identity, so that what the expression is used for stays silent about it.
export const RECOVERY: ResolvedType = primitive('i32')

export interface Scope {
  parent: Scope | null
  symbols: Map<string, Symbol>
}

// === Type Key Helper ===

/**
 * Create a unique key for the types Map.
 * Uses "offset:kind" format to avoid collisions when nested expressions
 * share the same start offset (e.g., `a > b` where both the binary expr
 * and identifier `a` start at the same position).
 */
export function typeKey(offset: number, kind: string): string {
  return `${offset}:${kind}`
}

export function exprTypeOffset(expr: { kind: string; span: { start: number; end: number } }): number {
  return (expr.kind === 'MemberExpr' || expr.kind === 'BinaryExpr' || expr.kind === 'IndexExpr') ? expr.span.end : expr.span.start
}

// === Type Check Result ===

export interface TypeError {
  offset: number
  message: string
}

// Pending literal for data section serialization (handled by codegen, not checker)
// Serialization type is in the types map at typeKey(id, 'DataTarget')
export interface PendingLiteral {
  id: number          // AST offset (also the key for DataTarget type lookup)
  expr: AST.Expr      // The literal expression (check expr.mut for mutable flag)
}

export interface TypeCheckResult {
  // Type map: "offset:kind" → resolved type
  types: Map<string, ResolvedType>
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
  instances?: { of: AST.FuncDecl; decl: AST.FuncDecl }[]
  // CallExpr span.end → the expression to compile in place of that call: for
  // a call of a generic, the plain call of its instance
  calls?: Map<number, AST.Expr>
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
  // Symbols derive their types from the concretized types map
  for (const [name, sym] of ctx.moduleScope.symbols) {
    if (sym.kind === 'generic') continue
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
      if (item.kind === 'FuncDecl' && item.ident) exportedNames.add(item.ident)
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
        ctx.warnings.push({ offset: defOffset, message: `'${name}' is never used` })
      }
    }
  }

  return {
    types: ctx.types,
    symbols: ctx.moduleScope.symbols,
    errors: ctx.errors,
    warnings: ctx.warnings,
    references: ctx.references,
    symbolRefs: ctx.symbolRefs,
    symbolDefOffsets: ctx.symbolDefOffsets,
    literals: ctx.pendingLiterals,
    instances: ctx.instances.map((i) => ({ of: i.of, decl: i.decl })),
    calls: ctx.calls,
  }
}

/** @deprecated Use typecheck() instead */
export const check = typecheck

function getExportedSymbols(module: AST.Module, symbols: Map<string, Symbol>): Map<string, Symbol> {
  const exports = new Map<string, Symbol>()
  for (const decl of module.decls) {
    if (decl.kind !== 'ExportDecl') continue
    const item = decl.item
    if (item.kind === 'FuncDecl' && item.ident) {
      const sym = symbols.get(item.ident)
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
    moduleExports.set(path, getExportedSymbols(loaded.module, result.symbols))
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

// The types map, able to take back what was recorded while an expression was
// only being looked at (see CheckContext.peek).
class TypeTable extends Map<string, ResolvedType> {
  private trials = 0
  private replaced: { key: string; had: boolean; was: ResolvedType | undefined }[] = []

  override set(key: string, type: ResolvedType): this {
    if (this.trials > 0) this.replaced.push({ key, had: this.has(key), was: this.get(key) })
    return super.set(key, type)
  }

  begin(): number {
    this.trials++
    return this.replaced.length
  }

  rollback(mark: number): void {
    while (this.replaced.length > mark) {
      const entry = this.replaced.pop()
      if (!entry) break
      if (entry.had && entry.was) super.set(entry.key, entry.was)
      else this.delete(entry.key)
    }
    this.trials--
  }
}

class CheckContext {
  source?: string
  types = new TypeTable()
  errors: TypeError[] = []
  warnings: TypeError[] = []
  moduleScope: Scope = { parent: null, symbols: new Map() }
  currentScope: Scope = this.moduleScope
  insideIfLetCondition = false
  currentReturnType: ResolvedType | null = null
  // Loops open around the statement being checked, and the depth at the
  // innermost enclosing defer (null outside one). A deferred expression can't
  // return, or break or continue a loop outside it.
  loopDepth = 0
  deferLoopDepth: number | null = null

  // Cache for resolved type aliases
  typeCache = new Map<string, ResolvedType>()

  // Track type names that are being defined (for recursive type detection)
  pendingTypeNames = new Set<string>()

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
  calls = new Map<number, AST.Expr>()
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
  // Names of generics that a later declaration tried to take
  contested = new Set<string>()
  // What an inferred call found for its type parameters, or null when it
  // failed. A call nested in another's deciding argument is come to twice, and
  // without this each level of nesting would double the work.
  inferred = new Map<AST.CallExpr, Map<string, ResolvedType> | null>()

  addLiteral(id: number, expr: AST.Expr, serializationType: ArrayRT): void {
    this.types.set(typeKey(id, 'DataTarget'), serializationType)
    this.pendingLiterals.push({ id, expr })
  }

  checkModule(module: AST.Module): void {
    // Pre-pass: register all type names (to allow forward references)
    for (const decl of module.decls) {
      this.preRegisterTypes(decl)
    }

    // First pass: collect all type aliases, function signatures, globals, defs
    for (const decl of module.decls) {
      this.collectDeclaration(decl)
    }

    // Resolve any forward references in the type cache
    this.resolveForwardRefs()

    // Second pass: check function bodies and expressions
    for (const decl of module.decls) {
      this.checkDeclaration(decl)
    }

    // The bodies of the instances the module asked for, and of those they ask for
    this.drainInstances()
    this.placeInstanceLiterals()
  }

  // Pre-register type names so they can be referenced before their full definition
  preRegisterTypes(decl: AST.Declaration): void {
    if (decl.kind === 'TypeDecl') {
      this.pendingTypeNames.add(decl.ident.name)
    }
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

  collectImport(decl: AST.ImportDecl): void {
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
            this.moduleScope.symbols.set(name, { kind: 'func', type: exported.type, inline: exported.inline })
          } else {
            const sig = this.resolveSignature(item.item.signature)
            this.moduleScope.symbols.set(name, { kind: 'func', type: sig, inline: false })
          }
          this.recordDefinition(name, item.item.span.start)
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
        // Memory declarations don't need collection
        break
    }
  }

  // A generic function's name is unique in its module: a declaration that
  // would take the name over is an error and is left out. (Other declarations
  // of one name replace each other silently, as they always have.)
  private takenByGeneric(name: string, offset: number): boolean {
    if (this.moduleScope.symbols.get(name)?.kind !== 'generic') return false
    this.error(offset, `'${name}' is already declared: a generic function's name is unique in its module`)
    this.contested.add(name)
    return true
  }

  collectFunc(decl: AST.FuncDecl): void {
    if (isGenericDecl(decl)) {
      this.collectGeneric(decl)
      return
    }
    if (!decl.ident) return // Anonymous function
    if (this.takenByGeneric(decl.ident, decl.span.start)) return
    const sig = this.resolveSignature(decl.signature)
    this.moduleScope.symbols.set(decl.ident, {
      kind: 'func',
      type: sig,
      inline: decl.inline,
    })
    // Record definition at function name offset (need to find it in span)
    // FuncDecl span starts at 'func' keyword, ident follows
    this.recordDefinition(decl.ident, decl.span.start)
  }

  collectTypeDecl(decl: AST.TypeDecl): void {
    const name = decl.ident.name
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
      if (sym.kind !== 'type' && sym.kind !== 'generic') {
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

    // Check if literal has mut flag
    const isMut = this.exprHasMut(decl.value)
    const dataIdentOff = this.findIdentOffset(decl.span.start, 'data')

    // data ALWAYS produces a pointer. Reuse extractDataLiteral to get the array type.
    const dataLiteral = this.extractDataLiteral(decl.value, inferredType, declaredType)
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
    const expr = decl.value.kind === 'AnnotationExpr' ? decl.value.expr : decl.value
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
      const innerExpr = expr.expr
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
  private findWritePointerType(target: AST.LValue): ResolvedType | null {
    // Direct index: arr[i] = x — the write goes through arr's pointer
    if (target.kind === 'IndexExpr') {
      return this.inferExpr(target.object)
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
    if (target.kind === 'MemberExpr' && target.member.kind === 'field') {
      if (target.object.kind === 'IndexExpr') {
        // arr[i].field = x — modifying element struct, check outer container
        return this.inferExpr(target.object.object)
      }
      if (target.object.kind === 'MemberExpr' && target.object.member.kind === 'deref') {
        return this.inferExpr(target.object.object)
      }
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

  // Evaluate a compile-time constant expression
  evalComptimeExpr(expr: AST.Expr): ComptimeValue | null {
    // Handle annotation expression (e.g., 42:u32)
    if (expr.kind === 'AnnotationExpr') {
      return this.evalComptimeExpr(expr.expr)
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
    if (expr.kind === 'GroupExpr') {
      return this.evalComptimeExpr(expr.expr)
    }

    // Handle unary negation
    if (expr.kind === 'UnaryExpr' && expr.op === '-') {
      const operand = this.evalComptimeExpr(expr.operand)
      if (operand?.kind === 'int') {
        return { kind: 'int', value: -operand.value }
      }
      if (operand?.kind === 'float') {
        return { kind: 'float', value: -operand.value }
      }
    }

    // Handle binary operations on comptime values
    if (expr.kind === 'BinaryExpr') {
      const left = this.evalComptimeExpr(expr.left)
      const right = this.evalComptimeExpr(expr.right)
      if (left?.kind === 'int' && right?.kind === 'int') {
        const l = left.value
        const r = right.value
        switch (expr.op) {
          case '+': return { kind: 'int', value: l + r }
          case '-': return { kind: 'int', value: l - r }
          case '*': return { kind: 'int', value: l * r }
          case '/': return r !== 0n ? { kind: 'int', value: l / r } : null
          case '%': return r !== 0n ? { kind: 'int', value: l % r } : null
          case '&': return { kind: 'int', value: l & r }
          case '|': return { kind: 'int', value: l | r }
          case '^': return { kind: 'int', value: l ^ r }
          case '<<': return { kind: 'int', value: l << r }
          case '>>': return { kind: 'int', value: l >> r }
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
      const objOffset = exprTypeOffset(expr.object)
      const objType = this.types.get(typeKey(objOffset, expr.object.kind))
        ?? (expr.object.kind === 'IdentExpr' ? typeOfSymbol(this.lookup(expr.object.name)) : undefined)
      if (objType) {
        const arrType = objType.kind === 'pointer' && objType.pointee.kind === 'array' ? objType.pointee
          : objType.kind === 'array' ? objType : null
        if (arrType?.kind === 'array' && arrType.sizes) {
          if (expr.member.name === 'len' && arrType.sizes.length === 1 && typeof arrType.sizes[0] === 'number') {
            return { kind: 'int', value: BigInt(arrType.sizes[0]) }
          }
          if (expr.member.name === 'wid') {
            const elemSize = byteSize(arrType.element)
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

    this.moduleScope.symbols.set(name, { kind: 'global', type })
    this.types.set(typeKey(decl.pattern.span.start, decl.pattern.kind), type)
    this.recordDefinition(name, decl.pattern.span.start)
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
          this.collectImport(item)
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
          this.collectFunc(item)
          this.checkFuncBody(item)
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
  }

  private checkMemOpPtr(expr: AST.Expr, context: string): void {
    const type = this.inferExpr(expr)
    const u = unwrap(type)
    if (u.kind === 'pointer' && u.pointee.kind === 'array') {
      if (u.pointee.sizes === null) {
        this.error(expr.span.start, `${context}: many-pointer has no bounds — use a sized pointer for safe memory operations`)
      }
      return
    }
    this.error(expr.span.start, `${context}: expected *[N]T, got ${typeToString(type)}`)
  }

  private checkMemOpBounds(ptrExpr: AST.Expr, lenExpr: AST.Expr, op: string): void {
    // Find buffer size from the dest pointer type
    let srcExpr = ptrExpr
    if (srcExpr.kind === 'CastExpr') srcExpr = srcExpr.expr
    if (srcExpr.kind === 'MemberExpr' && srcExpr.member.kind === 'type') srcExpr = srcExpr.object

    const srcOffset = exprTypeOffset(srcExpr)
    const srcType = this.types.get(typeKey(srcOffset, srcExpr.kind))
    if (!srcType) return

    const arrType = srcType.kind === 'pointer' && srcType.pointee.kind === 'array' ? srcType.pointee : null
    if (!arrType?.sizes || !arrType.sizes.every(s => typeof s === 'number')) return

    const totalCount = totalElements(arrType.sizes)
    if (totalCount === null) return
    const elemSize = byteSize(arrType.element)
    if (elemSize === null) return
    const bufferSize = totalCount * elemSize

    // Length must be a comptime constant to verify bounds
    const len = this.evalComptimeExpr(lenExpr)
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

    // Check body
    const prevScope = this.currentScope
    const prevReturnType = this.currentReturnType
    this.currentScope = funcScope
    this.currentReturnType = this.resolveType(decl.signature.output)
    if (decl.body.kind === 'Block') {
      this.checkBody(decl.body)
      // A block body with unnamed results has to return on every path: there
      // are no named locals to return when it falls off the end.
      const output = decl.signature.output
      const named = output.kind === 'CompositeType' && output.fields.some(f => f.ident)
      const resultType = this.currentReturnType
      const hasResult = resultType.kind !== 'void' && !(resultType.kind === 'tuple' && resultType.fields.length === 0)
      if (!named && hasResult && !blockTerminates(decl.body.stmts)) {
        // The name the user wrote, not max<u32>: the message is followed by
        // the instance anyway.
        const name = this.currentInstance?.decl === decl ? this.currentInstance.of.ident : decl.ident
        this.error(decl.span.start, `function '${name ?? 'anonymous'}' can reach its end without returning a value`)
      }
    } else {
      this.checkExpr(decl.body.expr, this.currentReturnType)
    }
    this.currentScope = prevScope
    this.currentReturnType = prevReturnType
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

  checkBody(body: AST.FuncBody): void {
    if (body.kind === 'Block') {
      this.checkStmts(body.stmts)
    } else {
      this.inferExpr(body.expr)
    }
  }

  checkStmt(stmt: AST.Statement): void {
    switch (stmt.kind) {
      case 'LetStmt':
        this.checkLetStmt(stmt)
        break
      case 'SetStmt':
        this.checkSetStmt(stmt)
        break
      case 'ExpressionStmt':
        this.inferExpr(stmt.expr)
        break
      case 'DeferStmt': {
        const prev = this.deferLoopDepth
        this.deferLoopDepth = this.loopDepth
        try {
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
          // For single-field named returns like (ptr: u32), check against the inner type
          let checkType = this.currentReturnType
          if (checkType?.kind === 'tuple' && checkType.fields.length === 1) {
            checkType = checkType.fields[0].type
          }
          if (checkType && checkType.kind !== 'void') {
            this.checkExpr(stmt.value, checkType)
          } else {
            this.inferExpr(stmt.value)
          }
        }
        if (stmt.when) this.inferExpr(stmt.when)
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
        this.checkMutability(stmt.target, stmt.span.start)
        const targetUnwrapped = targetType ? unwrap(targetType) : undefined
        if (targetType && stmt.op === '=') {
          this.checkExpr(stmt.value, targetType)
        } else if (targetType && targetUnwrapped?.kind === 'primitive') {
          this.checkExpr(stmt.value, targetType)
        } else {
          this.inferExpr(stmt.value)
        }
        break
      }
      case 'WhileStmt':
        this.inferExpr(stmt.condition)
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
          elemType = iterableType.element
        } else if (pointee?.kind === 'array' && pointee.sizes?.length === 1 && typeof pointee.sizes[0] === 'number') {
          elemType = pointee.element
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
        this.inferExpr(stmt.expr)
        break
      case 'BreakStmt':
      case 'ContinueStmt':
        if (this.deferLoopDepth !== null && this.loopDepth <= this.deferLoopDepth) {
          const what = stmt.kind === 'BreakStmt' ? 'break' : 'continue'
          this.error(stmt.span.start, `cannot ${what} out of a deferred expression`)
        }
        if (stmt.when) this.inferExpr(stmt.when)
        break
    }
  }

  // Check statements in order. After `return/break/continue when c`, or an
  // `if c { ... }` whose branch always exits, c is false for the rest.
  private checkStmts(stmts: AST.Statement[]): void {
    for (let i = 0; i < stmts.length; i++) {
      const stmt = stmts[i]
      this.checkStmt(stmt)
      let exitCond: AST.Expr | null = null
      if ((stmt.kind === 'ReturnStmt' || stmt.kind === 'BreakStmt' || stmt.kind === 'ContinueStmt') && stmt.when) {
        exitCond = stmt.when
      } else if (stmt.kind === 'ExpressionStmt' && stmt.expr.kind === 'IfExpr' && !stmt.expr.pattern &&
        stmt.expr.elifs.length === 0 && !stmt.expr.else_ && alwaysExits(stmt.expr.thenBranch)) {
        exitCond = stmt.expr.condition
      }
      if (exitCond) {
        const rest = stmts.slice(i + 1)
        this.withNarrowing(this.boundsFrom(exitCond, false), rest, () => this.checkStmts(rest))
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
    } else {
      this.error(stmt.span.start, 'let needs type annotation or initializer')
      type = primitive('i32')
    }

    // Add bindings from pattern and record types
    this.bindPattern(stmt.pattern, type)
  }

  checkSetStmt(stmt: AST.SetStmt): void {
    const valueType = this.inferExpr(stmt.value)
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
        for (const element of pattern.elements) {
          if (element.kind === 'named') {
            const varName = element.binding ?? element.field
            const sym = this.lookup(varName)
            if (!sym) {
              this.error(pattern.span.start, `cannot set '${varName}': not defined`)
            }
          } else {
            this.validatePatternBindingsExist(element.pattern, unwrappedType.fields[pattern.elements.indexOf(element)]?.type ?? type)
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
        if (existing) {
          this.error(pattern.span.start, `'${pattern.name}' is already declared in this scope`)
        }
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
    // For MemberExpr, use span.end so chained accesses like a.b.c each get unique keys
    // This allows hover to show: a -> type1, a.b -> type2, a.b.c -> type3
    const offset = exprTypeOffset(expr)
    this.types.set(typeKey(offset, expr.kind), type)
    return type
  }

  // Check an expression against an expected type (top-down / bidirectional)
  // This allows comptime types to resolve based on context
  // Optional errorContext is prepended to error messages (e.g., "argument 1: ")
  checkExpr(expr: AST.Expr, expected: ResolvedType, errorContext?: string): ResolvedType {
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
      this.types.set(typeKey(expr.span.start, expr.kind), result)
      return result
    }

    // Bidirectional: propagate expected type into if-expression branches
    if (expr.kind === 'IfExpr' && !expr.pattern && expr.else_) {
      this.inferExpr(expr.condition)
      this.withNarrowing(this.boundsFrom(expr.condition, true), expr.thenBranch, () => this.checkBodyAgainst(expr.thenBranch, expected))
      const seen = [expr.condition]
      for (const elif of expr.elifs) {
        this.withNarrowing(this.boundsAfterAllFalse(seen), elif, () => {
          this.inferExpr(elif.condition)
          this.withNarrowing(this.boundsFrom(elif.condition, true), elif.thenBranch, () => this.checkBodyAgainst(elif.thenBranch, expected))
        })
        seen.push(elif.condition)
      }
      const else_ = expr.else_
      this.withNarrowing(this.boundsAfterAllFalse(seen), else_, () => this.checkBodyAgainst(else_, expected))
      this.types.set(typeKey(expr.span.start, expr.kind), expected)
      return expected
    }

    // Bidirectional: propagate expected type into match-expression arms
    if (expr.kind === 'MatchExpr') {
      this.inferExpr(expr.subject)
      for (const arm of expr.arms) {
        if (arm.body.kind === 'Block' || arm.body.kind === 'ArrowBody') {
          this.checkBodyAgainst(arm.body, expected)
        } else {
          this.checkExpr(arm.body, expected)
        }
      }
      this.types.set(typeKey(expr.span.start, expr.kind), expected)
      return expected
    }

    const inferred = this.inferExprInner(expr)
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
        this.types.set(typeKey(expr.span.start, expr.kind), inferred)
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
      this.types.set(typeKey(expr.span.start, expr.kind), inferred)
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
      this.types.set(typeKey(expr.span.start, expr.kind), inferred)
      this.addLiteral(expr.span.start, expr, resolvedPointee)
      return resolvedExpected
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
      // Infer mut from target type — no need for explicit mut on the literal
      const targetMut = (expected.kind === 'pointer' && expected.mutable) ||
        (expected.kind === 'slice' && expected.mutable)
      if (targetMut || this.exprHasMut(expr)) {
        if ('mut' in expr) (expr as { mut?: boolean }).mut = true
      }
      this.addLiteral(expr.span.start, expr, arrType)
      if (expr.kind === 'ArrayExpr' || expr.kind === 'RepeatExpr' || expr.kind === 'LiteralExpr') {
        (expr as AST.ArrayExpr | AST.RepeatExpr | AST.LiteralExpr).dataId = expr.span.start
      }
      // Propagate element type into array elements
      if (expr.kind === 'ArrayExpr') {
        const innerType = expected.kind === 'slice' ? expected.element
          : expected.kind === 'pointer' && expected.pointee.kind === 'array' ? this.peelArraySize(expected.pointee)
          : null
        if (innerType) {
          for (const elem of (expr as AST.ArrayExpr).elements) {
            if (this.isDataLiteralExpr(elem)) {
              this.validateDataLiteralRange(elem, innerType)
              this.types.set(typeKey(elem.span.start, elem.kind), innerType)
            } else {
              this.checkExpr(elem, innerType)
            }
          }
        }
      }
      // Record the expected type so codegen knows to emit ptr+len for slices
      this.types.set(typeKey(expr.span.start, expr.kind), expected)
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
        this.types.set(typeKey(expr.span.start, expr.kind), resolved)
        return resolved
      }
    }

    // Propagate expected type into tuple elements for bidirectional inference
    const unwrappedExpected = unwrap(expected)
    if (unwrappedExpected.kind === 'tuple' && inferred.kind === 'tuple' &&
        unwrappedExpected.fields.length === inferred.fields.length &&
        expr.kind === 'TupleExpr') {
      for (let i = 0; i < unwrappedExpected.fields.length; i++) {
        const elemExpr = (expr as AST.TupleExpr).elements[i]
        if (elemExpr?.value) {
          this.checkExpr(elemExpr.value, unwrappedExpected.fields[i].type)
        }
      }
      this.types.set(typeKey(exprTypeOffset(expr), expr.kind), expected)
      return expected
    }

    // For other types, check assignability and record the inferred type
    if (inferred !== RECOVERY && !typeAssignable(expected, inferred)) {
      this.error(
        expr.span.start,
        `${prefix}cannot assign ${typeToString(inferred)} to ${typeToString(expected)}`,
      )
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
    // Use span.end for MemberExpr to match inferExpr behavior (allows distinguishing a.b from a.b.c)
    const typeOffset = exprTypeOffset(expr)
    this.types.set(typeKey(typeOffset, expr.kind), recordType)

    // For return value, concretize based on expected type
    return this.concretizeToTarget(inferred, expected)
  }

  // Peel off one size level from an array type to get the inner element type
  // [N,M]u8 -> [M]u8 (peel first dimension, remaining is M)
  // [N]u8 -> u8 (single dimension, inner type is element)
  // [N][M]u8 -> [M]u8 (element is already an array type)
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

  inferExprInner(expr: AST.Expr): ResolvedType {
    switch (expr.kind) {
      case 'LiteralExpr':
        return this.inferLiteral(expr)

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
        return this.inferArray(expr)

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

      case 'CastExpr':
        // Explicit cast - always returns the target type (may generate conversion code)
        this.inferExpr(expr.expr)
        return this.resolveType(expr.type)

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

  inferLiteral(expr: AST.LiteralExpr): ResolvedType {
    switch (expr.value.kind) {
      case 'int':
        return comptimeInt(expr.value.value)

      case 'float':
        return comptimeFloat(expr.value.value)

      case 'string': {
        // String literals have known length at compile time
        // Default to *[N]u8 - pointer to N-byte array
        const len = expr.value.bytes.length
        return ptrArray(primitive('u8'), len)
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
        return sym.type

      case 'type':
        // Type used as expression (constructor)
        return sym.type

      case 'generic':
        // Where another declaration wanted the name, its uses are not the
        // generic's: the declaration already has the error.
        if (!this.contested.has(expr.name)) {
          this.error(expr.span.start, `generic function '${expr.name}' must be called`)
        }
        return RECOVERY
    }
  }

  inferCall(expr: AST.CallExpr): ResolvedType {
    // A generic comes before the builtins, so that a generic named max or min
    // is the one that is called.
    if (expr.callee.kind === 'IdentExpr') {
      const sym = this.lookup(expr.callee.name)
      if (sym?.kind === 'generic') return this.inferGenericCall(expr, sym, expr.callee.name)
    }
    // T(a, b) in an instance, where T was a type parameter
    if (expr.callee.kind === 'TypeExpr') {
      const name = expr.callee.type.kind === 'BoundType' ? expr.callee.type.name : 'T'
      this.error(expr.span.start, `${name}(...) on a type parameter is not supported yet`)
      for (const arg of expr.args) if (arg.value) this.inferExpr(arg.value)
      return RECOVERY
    }

    // Check for builtin functions first
    if (expr.callee.kind === 'IdentExpr') {
      const builtinResult = this.inferBuiltin(expr, expr.callee.name)
      if (builtinResult !== null) return builtinResult

      // Primitive type cast: u64(x), f32(x), etc.
      if (PRIMITIVE_NAMES.has(expr.callee.name)) {
        const args = expr.args.filter((a): a is AST.Arg & { value: AST.Expr } => a.value !== null)
        if (args.length !== 1) {
          this.error(expr.span.start, `type cast '${expr.callee.name}' expects 1 argument, got ${args.length}`)
        } else {
          this.inferExpr(args[0].value)
        }
        return primitive(expr.callee.name as PrimitiveName)
      }
    }

    const calleeType = this.inferExpr(expr.callee)

    if (calleeType.kind === 'func') {
      // Check argument count
      const argCount = expr.args.filter((a) => a.value).length
      if (argCount !== calleeType.params.length) {
        const calleeName = expr.callee.kind === 'IdentExpr' ? `'${expr.callee.name}' ` : ''
        this.error(
          expr.span.start,
          `${calleeName}expected ${calleeType.params.length} argument${calleeType.params.length === 1 ? '' : 's'}, got ${argCount}`,
        )
      }

      // Use bidirectional type checking for arguments
      // This allows log("message") to propagate *[!u8] to the string literal
      let argIndex = 0
      for (const arg of expr.args) {
        if (arg.value && argIndex < calleeType.params.length) {
          const paramType = calleeType.params[argIndex].type
          this.checkExpr(arg.value, paramType, `argument ${argIndex + 1}`)
          argIndex++
        }
      }

      // Return type of function
      if (calleeType.returns.length === 0) {
        return VOID
      } else if (calleeType.returns.length === 1) {
        return calleeType.returns[0].type
      } else {
        // Multiple returns become a tuple
        return tuple(calleeType.returns)
      }
    }

    // Constructor call (type used as function): each argument is checked against
    // its field, by position or by name (Point(x: 1, y: 2)), so literals and
    // expressions inside it get concrete types.
    if (calleeType.kind === 'tuple') {
      const args = expr.args
      if (args.length !== calleeType.fields.length) {
        this.error(
          expr.span.start,
          `${typeToString(calleeType)} expects ${calleeType.fields.length} field${calleeType.fields.length === 1 ? '' : 's'}, got ${args.length}`,
        )
      }
      args.forEach((arg, i) => {
        // `x:` is shorthand for `x: x`: check the variable it names.
        const value: AST.Expr | null = arg.value ?? (arg.name ? { kind: 'IdentExpr', name: arg.name, span: arg.span } : null)
        if (!value) return
        const field = arg.name ? calleeType.fields.find((f) => f.name === arg.name) : calleeType.fields[i]
        if (field) {
          this.checkExpr(value, field.type, `field ${field.name ?? i}`)
        } else {
          if (arg.name) this.error(arg.span.start, `field '${arg.name}' not found in ${typeToString(calleeType)}`)
          this.inferExpr(value)
        }
      })
      return calleeType
    }

    if (calleeType === RECOVERY) return RECOVERY
    this.error(expr.span.start, `cannot call non-function type: ${typeToString(calleeType)}`)
    return primitive('i32')
  }

  // Handle builtin functions: memset, memcpy, zero
  // Returns null if not a builtin, otherwise returns the result type
  inferBuiltin(expr: AST.CallExpr, name: string): ResolvedType | null {
    const args = expr.args.filter((a): a is AST.Arg & { value: AST.Expr } => a.value !== null)

    switch (name) {
      case 'memzero': {
        // memzero(dest: *[N]T) -> ()
        if (args.length !== 1) {
          this.error(expr.span.start, `memzero expects 1 argument (dest), got ${args.length}`)
          return VOID
        }
        this.checkMemOpPtr(args[0].value, 'memzero dest')
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
        this.inferExpr(args[1].value)
        this.checkExpr(args[2].value, primitive('u32'), 'memcpy len')
        this.checkMemOpBounds(args[0].value, args[2].value, 'memcpy')
        this.checkMemOpBounds(args[1].value, args[2].value, 'memcpy')

        this.types.set(typeKey(expr.span.start, 'BuiltinCall'), VOID)
        return VOID
      }

      // Float-only unary operations: sqrt, ceil, floor, trunc, nearest
      case 'sqrt':
      case 'ceil':
      case 'floor':
      case 'trunc':
      case 'nearest': {
        if (args.length !== 1) {
          this.error(expr.span.start, `${name} expects 1 argument, got ${args.length}`)
          return primitive('f64')
        }
        const argType = this.inferExpr(args[0].value)
        if (!isFloat(argType)) {
          this.error(args[0].value.span.start, `${name} requires a float type, got ${typeToString(argType)}`)
          return primitive('f64')
        }
        this.types.set(typeKey(expr.span.start, 'BuiltinCall'), argType)
        return argType
      }

      // Float-only binary: copysign
      case 'copysign': {
        if (args.length !== 2) {
          this.error(expr.span.start, `copysign expects 2 arguments, got ${args.length}`)
          return primitive('f64')
        }
        const argType = this.inferExpr(args[0].value)
        if (!isFloat(argType)) {
          this.error(args[0].value.span.start, `copysign requires float types, got ${typeToString(argType)}`)
          return primitive('f64')
        }
        this.checkExpr(args[1].value, argType, 'copysign')
        this.types.set(typeKey(expr.span.start, 'BuiltinCall'), argType)
        return argType
      }

      // Numeric binary: min, max (works for all numeric types)
      case 'min':
      case 'max': {
        if (args.length !== 2) {
          this.error(expr.span.start, `${name} expects 2 arguments, got ${args.length}`)
          return primitive('i32')
        }
        const argType = this.inferExpr(args[0].value)
        if (!isNumeric(argType)) {
          this.error(args[0].value.span.start, `${name} requires a numeric type, got ${typeToString(argType)}`)
          return primitive('i32')
        }
        this.checkExpr(args[1].value, argType, name)
        this.types.set(typeKey(expr.span.start, 'BuiltinCall'), argType)
        return argType
      }

      // Numeric unary: abs (works for floats and signed integers)
      case 'abs': {
        if (args.length !== 1) {
          this.error(expr.span.start, `abs expects 1 argument, got ${args.length}`)
          return primitive('i32')
        }
        const argType = this.inferExpr(args[0].value)
        if (!isNumeric(argType)) {
          this.error(args[0].value.span.start, `abs requires a numeric type, got ${typeToString(argType)}`)
          return primitive('i32')
        }
        // For unsigned types, abs is a no-op but we still allow it
        this.types.set(typeKey(expr.span.start, 'BuiltinCall'), argType)
        return argType
      }

      // Integer-only unary: clz, ctz, popcnt
      case 'clz':
      case 'ctz':
      case 'popcnt': {
        if (args.length !== 1) {
          this.error(expr.span.start, `${name} expects 1 argument, got ${args.length}`)
          return primitive('i32')
        }
        const argType = this.inferExpr(args[0].value)
        if (!isInteger(argType)) {
          this.error(args[0].value.span.start, `${name} requires an integer type, got ${typeToString(argType)}`)
          return primitive('i32')
        }
        this.types.set(typeKey(expr.span.start, 'BuiltinCall'), argType)
        return argType
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
        this.checkExpr(args[0].value, primitive('u64'), 'mul_hi a')
        this.checkExpr(args[1].value, primitive('u64'), 'mul_hi b')
        return primitive('u64')
      }

      default:
        return null // Not a builtin
    }
  }

  inferBinary(expr: AST.BinaryExpr): ResolvedType {
    const leftType = this.inferExpr(expr.left)
    const rightType = this.inferExpr(expr.right)
    if (leftType === RECOVERY || rightType === RECOVERY) {
      return ['==', '!=', '<', '>', '<=', '>=', '&&', '||'].includes(expr.op) ? primitive('bool') : RECOVERY
    }

    const left = unwrap(leftType)
    const right = unwrap(rightType)
    const leftIsComptime = left.kind === 'comptime_int' || left.kind === 'comptime_float'
    const rightIsComptime = right.kind === 'comptime_int' || right.kind === 'comptime_float'
    const stripMax = (t: ResolvedType): ResolvedType =>
      t.kind === 'primitive' && t.max !== undefined ? primitive(t.name) : t

    // Operators exist for single values: numbers, bools and pointers. A struct,
    // a slice or an array has none, and codegen would emit an instruction that
    // takes one value for an operand that is several.
    if (expr.op !== '&&' && expr.op !== '||') {
      const sides: [ResolvedType, ResolvedType][] = [[leftType, left], [rightType, right]]
      for (const [written, t] of sides) {
        if (t.kind === 'tuple' || t.kind === 'slice' || t.kind === 'array' || t.kind === 'func' || t.kind === 'void') {
          this.error(expr.span.start, `operator ${expr.op} is not defined for ${typeToString(written)}`)
          return ['==', '!=', '<', '>', '<=', '>='].includes(expr.op) ? primitive('bool') : RECOVERY
        }
      }
    }

    // Comparison and logical operators: propagate concrete type to comptime operand
    // Strip range — comparing u32#8 with a literal shouldn't constrain the literal to <8
    if (['==', '!=', '<', '>', '<=', '>='].includes(expr.op)) {
      if (leftIsComptime && right.kind === 'primitive') {
        this.checkExpr(expr.left, stripMax(rightType))
      } else if (rightIsComptime && left.kind === 'primitive') {
        this.checkExpr(expr.right, stripMax(leftType))
      }
      return primitive('bool')
    }
    if (['&&', '||'].includes(expr.op)) {
      return primitive('bool')
    }

    // Arithmetic with a comptime constant propagates ranges:
    //   u32#4 + 4 → u32#8    (max value: 3+4=7, so <8)
    //   u32#6 * 20 → u32#120 (max value: 5*20=100, so <120... actually (6-1)*20+1 is wrong)
    // For +: u32#N + K → u32#(N+K)      max val is (N-1)+K, so < N+K
    // For *: u32#N * K → u32#((N-1)*K+1) max val is (N-1)*K, so < (N-1)*K+1
    // For an unsigned value and a constant K >= 0:
    //   x & K  → max value K          x % K → max value K-1 (K > 0)
    //   x >> K → max value (max >> K), where max is the range or the type's width
    const computeRange = (base: ResolvedType, operand: bigint, constantOnRight: boolean): ResolvedType => {
      if (base.kind !== 'primitive' || operand < 0n) return stripMax(base)
      const limit = (bound: bigint): ResolvedType => {
        const current = base.max !== undefined ? BigInt(base.max) : unsignedLimit(base)
        const next = current !== null && current < bound ? current : bound
        return next <= BigInt(Number.MAX_SAFE_INTEGER) ? primitive(base.name, Number(next)) : stripMax(base)
      }
      if (isUnsignedName(base.name)) {
        if (expr.op === '&') return limit(operand + 1n)
        if (expr.op === '%' && constantOnRight && operand > 0n) return limit(operand)
        if (expr.op === '>>' && constantOnRight) {
          const max = base.max !== undefined ? BigInt(base.max) : unsignedLimit(base)
          if (max !== null) return limit(((max - 1n) >> operand) + 1n)
        }
      }
      if (base.max === undefined) return stripMax(base)
      if (expr.op === '+') return primitive(base.name, base.max + Number(operand))
      if (expr.op === '*' && operand > 0n) return primitive(base.name, (base.max - 1) * Number(operand) + 1)
      return stripMax(base)
    }

    let resultType = stripMax(leftType)
    if (left.kind === 'primitive' && right.kind === 'primitive') {
      const leftSize = byteSize(left)
      const rightSize = byteSize(right)
      if (leftSize !== null && rightSize !== null && rightSize > leftSize) {
        resultType = stripMax(rightType)
      }
    } else if (right.kind === 'comptime_int' && left.kind === 'primitive') {
      resultType = computeRange(leftType, right.value, true)
    } else if (left.kind === 'comptime_int' && right.kind === 'primitive') {
      resultType = computeRange(rightType, left.value, false)
    } else if (rightIsComptime && left.kind === 'primitive') {
      resultType = stripMax(leftType)
    } else if (leftIsComptime && right.kind === 'primitive') {
      resultType = stripMax(rightType)
    }

    // Propagate concrete type to comptime operands (only for numeric types).
    // The operand gets the plain type: in x % 12 the 12 needn't fit u32#12.
    if (leftIsComptime && right.kind === 'primitive') {
      this.checkExpr(expr.left, stripMax(resultType))
    } else if (rightIsComptime && left.kind === 'primitive') {
      this.checkExpr(expr.right, stripMax(resultType))
    }

    return resultType
  }

  inferUnary(expr: AST.UnaryExpr): ResolvedType {
    // &items[i] is checked as an address, without the bounds rules for reading.
    if (expr.op === '&' && expr.operand.kind === 'IndexExpr') {
      const addr = this.addressOfIndex(expr.operand)
      if (addr) return addr
    }
    const operandType = this.inferExpr(expr.operand)

    switch (expr.op) {
      case '!':
        return primitive('bool')
      case '-':
      case '~':
        return operandType
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
    if (objType === RECOVERY) return RECOVERY

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
            const ws = byteSize(arrayType.element)
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
      const c = this.evalComptimeExpr(e) as unknown as { kind: string; value?: bigint } | null
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
    const objType = unwrap(this.types.get(typeKey(exprTypeOffset(expr.object), expr.object.kind)) ?? this.inferExpr(expr.object))
    const pointee = objType.kind === 'pointer' ? unwrap(objType.pointee) : null
    const size = pointee?.kind === 'array' && pointee.sizes?.length === 1 && typeof pointee.sizes[0] === 'number'
      ? BigInt(pointee.sizes[0]) : null
    const value = (e: AST.Expr | null, fallback: bigint | null): bigint | null => {
      if (!e) return fallback
      const c = this.evalComptimeExpr(e) as unknown as { kind: string; value?: bigint } | null
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
    this.types.set(typeKey(exprTypeOffset(target), target.kind), dst)
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
    const idxType = unwrap(this.inferExpr(expr.index))
    if (idxType.kind === 'comptime_int') this.checkExpr(expr.index, primitive('u32'))
    this.types.set(typeKey(exprTypeOffset(expr), expr.kind), elem)
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
    const idxType = this.types.get(typeKey(exprTypeOffset(expr.index), expr.index.kind))
    if (idxType?.kind !== 'primitive') return false
    if (idxType.max !== undefined) return idxType.max <= arraySize
    // A u8 or u16 can't exceed its width: a u8 always indexes a *[256]T.
    const limit = unsignedLimit(idxType)
    return limit !== null && limit <= 65536n && limit <= BigInt(arraySize)
  }

  inferIndex(expr: AST.IndexExpr): ResolvedType {
    const objType = this.inferExpr(expr.object)
    this.inferExpr(expr.index)
    if (objType === RECOVERY) return RECOVERY

    if (objType.kind === 'slice') {
      const idx = this.evalComptimeExpr(expr.index)
      if (idx === null || idx.kind !== 'int') {
        // Runtime index: return optional if element can be optional, error otherwise
        const elem = objType.element
        if (elem.kind === 'pointer' || elem.kind === 'slice') {
          return optionalOf(elem)
        }
        if (!this.insideIfLetCondition) {
          this.error(expr.index.span.start, `runtime index on []${typeToString(elem)} requires 'if let' or '??' (no optional type for ${typeToString(elem)})`)
        }
      }
      return objType.element
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
              const idxType = this.types.get(typeKey(exprTypeOffset(expr.index), expr.index.kind))
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
                  this.error(expr.index.span.start, `runtime index on *[${n}]${typeToString(elem)} requires 'if let' or '??' (no optional type for ${typeToString(elem)})`)
                }
              }
            }
          } else if (idx.value < 0n || idx.value >= BigInt(n)) {
            this.error(expr.index.span.start, `index ${idx.value} out of bounds for *[${n}]${typeToString(arrayType.element)}`)
          }
        }
        return arrayType.element
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
      let argType: ResolvedType
      if (arg.value) {
        argType = this.inferExpr(arg.value)
      } else if (arg.name) {
        // Shorthand: (x:) means use variable x
        const sym = this.lookup(arg.name)
        argType = typeOfSymbol(sym) ?? primitive('i32')
      } else {
        argType = VOID
      }
      fields.push(field(arg.name, argType))
    }
    // (x) is grouping, not a 1-element tuple
    if (fields.length === 1 && !fields[0].name) return fields[0].type
    return tuple(fields)
  }

  inferArray(expr: AST.ArrayExpr): ResolvedType {
    if (expr.elements.length === 0) {
      // Empty array - needs context to determine element type
      // For now, return comptime list with no elements
      return comptimeList([])
    }

    // Infer element types and unify
    const elemTypes = expr.elements.map((e) => this.inferExpr(e))
    const elementType = this.unifyTypes(elemTypes)

    // Return comptime array literal - can coerce to []T, *[N]T, [N]T
    return comptimeArrayLiteral(elementType, expr.elements.length)
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
    this.inferExpr(expr.condition)
    const thenType = this.withNarrowing(this.boundsFrom(expr.condition, true), expr.thenBranch, () => this.inferBody(expr.thenBranch))
    const seen = [expr.condition]
    for (const elif of expr.elifs) {
      this.withNarrowing(this.boundsAfterAllFalse(seen), elif, () => {
        this.inferExpr(elif.condition)
        this.withNarrowing(this.boundsFrom(elif.condition, true), elif.thenBranch, () => this.inferBody(elif.thenBranch))
      })
      seen.push(elif.condition)
    }
    if (expr.else_) {
      const else_ = expr.else_
      this.withNarrowing(this.boundsAfterAllFalse(seen), else_, () => this.inferBody(else_))
    }
    // Without an else branch, the expression can't produce a value
    if (!expr.else_) return VOID
    return thenType
  }

  inferIfLet(expr: AST.IfExpr): ResolvedType {
    const pattern = expr.pattern
    if (!pattern || pattern.kind !== 'binding') {
      this.error(expr.span.start, 'if let only supports simple bindings')
      return VOID
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
    const thenType = this.inferBody(expr.thenBranch)
    this.currentScope = prevScope

    for (const elif of expr.elifs) {
      this.inferExpr(elif.condition)
      this.inferBody(elif.thenBranch)
    }
    if (expr.else_) {
      this.inferBody(expr.else_)
    }
    if (!expr.else_) return VOID
    return thenType
  }

  private checkBodyAgainst(body: AST.FuncBody, expected: ResolvedType): void {
    if (body.kind === 'Block') {
      for (let i = 0; i < body.stmts.length - 1; i++) {
        this.checkStmt(body.stmts[i])
      }
      const last = body.stmts[body.stmts.length - 1]
      if (last?.kind === 'ExpressionStmt') {
        this.checkExpr(last.expr, expected)
      } else if (last) {
        this.checkStmt(last)
      }
    } else {
      this.checkExpr(body.expr, expected)
    }
  }

  private inferBody(body: AST.FuncBody): ResolvedType {
    if (body.kind === 'Block') {
      for (const stmt of body.stmts) {
        this.checkStmt(stmt)
      }
      // Block's type is the last expression statement, if any
      const last = body.stmts[body.stmts.length - 1]
      if (last?.kind === 'ExpressionStmt') {
        return this.types.get(typeKey(last.expr.span.start, last.expr.kind)) ?? VOID
      }
      return VOID
    }
    return this.inferExpr(body.expr)
  }

  inferMatch(expr: AST.MatchExpr): ResolvedType {
    this.inferExpr(expr.subject)
    let resultType: ResolvedType = VOID
    for (const arm of expr.arms) {
      const armType = arm.body.kind === 'Block' || arm.body.kind === 'ArrowBody'
        ? this.inferBody(arm.body)
        : this.inferExpr(arm.body)
      if (resultType.kind === 'void' && armType.kind !== 'void') {
        resultType = armType
      }
    }
    return resultType
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
        if (!p.comptime) continue
        if (p.type.kind === 'FuncType') {
          reject(at, `comptime parameter '${p.ident}' must be a type parameter: comptime function parameters are not supported yet`)
        } else {
          reject(at, `comptime value parameters are not supported yet: '${p.ident}' must be 'type' or a function type`)
        }
      } else if (!p.comptime) {
        reject(at, `a parameter of type 'type' must be comptime: write 'comptime T: type'`)
      } else if (!/^[A-Z]/.test(p.ident)) {
        reject(at, `a type parameter's name starts with an upper-case letter: write 'comptime T: type'`)
      } else if (typeParams.has(p.ident)) {
        reject(at, `type parameter '${p.ident}' is declared twice`)
      } else if (this.moduleScope.symbols.get(p.ident)?.kind === 'type' || this.pendingTypeNames.has(p.ident)) {
        reject(at, `type parameter '${p.ident}' has the name of a type declared in this module`)
      } else {
        typeParams.add(p.ident)
      }
    }
    return valid
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
    const runtimeCount = params.length - typeParams.length
    if (!explicit && expr.args.length !== runtimeCount) {
      return fail(
        expr.span.start,
        `'${name}' expects ${runtimeCount} argument${runtimeCount === 1 ? '' : 's'}, or ${params.length} with its type argument${typeParams.length === 1 ? '' : 's'} written; got ${expr.args.length}`,
      )
    }
    const pairs: { param: AST.Field; arg: AST.Expr; index: number }[] = []
    for (const param of params) {
      if (isTypeParam(param) && !explicit) continue
      pairs.push({ param, arg: expr.args[pairs.length].value as AST.Expr, index: pairs.length })
    }
    // An argument that stands for a type parameter is not a value, whatever
    // was written there: its error says so and nothing more is said of it.
    values = pairs.flatMap((p) => (isTypeParam(p.param) ? [] : [p.arg]))

    const bound = new Map<string, ResolvedType>()
    if (explicit) {
      for (const { param, arg, index } of pairs) {
        if (!isTypeParam(param)) continue
        const value = this.evalComptimeArg(name, param, arg, index)
        if (value?.kind !== 'type') return fail()
        bound.set(param.ident as string, value.type)
      }
    } else {
      // What the call found the first time it was come to is what it finds now.
      let found = this.inferred.get(expr)
      if (found === undefined) {
        found = this.inferTypeArgs(expr, name, pairs, typeParams)
        this.inferred.set(expr, found)
      }
      if (!found) return fail()
      for (const [param, type] of found) bound.set(param, type)
    }

    // A type declared further down is not known yet while declarations are
    // still being collected (a call in a global's initializer): its instance
    // would be keyed by the name, not by the type.
    for (const p of typeParams) {
      const pending = unresolvedName(bound.get(p) as ResolvedType)
      if (pending) {
        return fail(expr.span.start, `type argument ${p} of '${name}' uses type '${pending}' before it is declared`)
      }
    }

    const args: ComptimeValue[] = typeParams.map((p) => ({ kind: 'type', type: bound.get(p) as ResolvedType }))
    const inst = this.instantiate(sym, args, expr.span.start)
    if (!inst) return fail()

    // Every other argument is an ordinary argument of the instance.
    const sig = sym.owner.signatureAs(inst, args)
    const runtimeArgs: AST.Arg[] = []
    for (const { param, arg, index } of pairs) {
      if (isTypeParam(param)) continue
      this.checkExpr(arg, sig.params[runtimeArgs.length].type, `argument ${index + 1}`)
      runtimeArgs.push(expr.args[index])
    }

    this.calls.set(expr.span.end, {
      kind: 'CallExpr',
      callee: { kind: 'IdentExpr', name: inst.name, span: expr.callee.span },
      args: runtimeArgs,
      span: expr.span,
    })
    // What the editor shows at the call: the signature of the instance, as
    // this call wrote its types
    this.types.set(typeKey(expr.callee.span.start, 'IdentExpr'), sig)
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
  ): Map<string, ResolvedType> | null {
    const bound = new Map<string, ResolvedType>()
    const untyped: { param: AST.Field; arg: AST.Expr; type: ResolvedType }[] = []
    for (const { param, arg, index } of pairs) {
      if (!mentionsUnbound(param.type, typeParams, bound)) continue
      // An argument with an error of its own decides nothing: the type it
      // was given is a guess, and the call would add errors about the guess.
      const reported = this.errorsReported
      const type = this.peek(arg)
      if (type === RECOVERY || this.errorsReported > reported) return null
      if (isUnit(type)) {
        this.error(arg.span.start, `argument ${index + 1} of '${name}' has no value`)
        return null
      }
      if (hasOwnType(type)) matchType(param.type, type, typeParams, bound)
      else untyped.push({ param, arg, type })
    }
    const missing = typeParams.find((p) => !bound.has(p))
    if (!missing) return bound

    const rest = pairs.length > 0 ? ', ...' : ''
    const literals = untyped.filter((u) => mentionsUnbound(u.param.type, [missing], bound))
    if (literals.length === 0) {
      const plural = typeParams.length === 1 ? '' : 's'
      this.error(
        expr.span.start,
        `cannot infer ${missing} for '${name}': write the type argument${plural}, as in ${name}(${typeParams.map(() => 'u32').join(', ')}${rest})`,
      )
      return null
    }
    // What the literals would be on their own, to show what to write
    const guess = new Map(bound)
    for (const u of untyped) matchType(u.param.type, this.concretize(u.type), typeParams, guess)
    const written = typeParams.map((p) => {
      const type = guess.get(p)
      return type ? typeToString(type) : p
    })
    const text = literalText(literals[0].arg)
    const example = text ? ` (${text}:${typeToString(this.concretize(literals[0].type))})` : ''
    this.error(
      expr.span.start,
      `cannot infer ${missing} for '${name}' from untyped literals: write ${name}(${written.join(', ')}${rest}) or give a literal its type${example}`,
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
    const literals = literalMarks(expr)
    const types = this.types.begin()
    const registered = this.pendingLiterals.length
    const warned = this.warnings.length
    const scope = this.currentScope
    this.currentScope = { parent: scope, symbols: new Map() }
    const type = this.inferExpr(expr)
    this.currentScope = scope
    this.warnings.length = warned
    this.pendingLiterals.length = registered
    this.types.rollback(types)
    for (const { node, marks } of literals) {
      delete node.mut
      delete node.dataId
      Object.assign(node, marks)
    }
    return type
  }

  // The one place a comptime argument is evaluated. A type argument is read as
  // a type because of where it stands, as after a colon, and resolved in the
  // calling module.
  private evalComptimeArg(callee: string, param: AST.Field, arg: AST.Expr, index: number): ComptimeValue | null {
    const ast = typeOfArg(arg)
    if (!ast) {
      this.error(arg.span.start, `argument ${index + 1} of '${callee}' must be a type: ${param.ident} is a type parameter`)
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
    const types = args.map((a) => plain((a as ComptimeValue & { kind: 'type' }).type))
    const key = types.map((t) => watSafe(canonicalKey(t))).join('|')
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
    const decl = bindTypes(of, comptimeParams, types, index * INSTANCE_STRIDE)
    decl.ident = instanceName(of.ident as string, key, (name) => owner.moduleScope.symbols.has(name))

    const shown = comptimeParams.map((p, i) => {
      const text = typeToString(types[i])
      return `${p.ident} = ${text.length > 60 ? `${text.slice(0, 57)}...` : text}`
    })
    const label = `${of.ident}(${shown.join(', ')})`
    const held: ComptimeValue[] = types.map((type) => ({ kind: 'type', type }))
    const inst: Instance = { name: decl.ident, label, of, decl, index, first: sym.instances.size === 0, args: held, depth, chain }
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
    const types = args.map((a) => (a as ComptimeValue & { kind: 'type' }).type)
    if (inst.args.every((held, i) => held.kind === 'type' && held.type === types[i])) {
      return (this.moduleScope.symbols.get(inst.name) as Symbol & { kind: 'func' }).type
    }
    // At the instance's offsets, so that an error in the signature is the one
    // the instance already has.
    const comptimeParams = genericParams(inst.of).filter((p) => p.comptime)
    return this.resolveSignature(bindTypes(inst.of, comptimeParams, types, inst.index * INSTANCE_STRIDE, 'signature').signature)
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
      const saved = { scope: this.currentScope, instance: this.currentInstance }
      this.currentScope = this.moduleScope
      this.currentInstance = inst
      this.instanceDefs.clear()
      this.checkFuncBody(inst.decl)
      this.currentScope = saved.scope
      this.currentInstance = saved.instance
    }
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
      if (!locals.has(name) && this.moduleScope.symbols.has(name)) this.recordReference(name, offset)
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
  private atSource(offset: number, message: string): [number, string] {
    if (offset < INSTANCE_STRIDE) return [offset, message]
    const inst = this.instances[Math.floor(offset / INSTANCE_STRIDE) - 1]
    return [offset % INSTANCE_STRIDE, inst ? `${message}, in ${inst.label}` : message]
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
    for (const [candidate] of this.currentScope.symbols) {
      const dist = editDistance(name, candidate)
      if (dist < bestDist) {
        bestDist = dist
        best = candidate
      }
    }
    for (const [candidate] of this.moduleScope.symbols) {
      // Not a name that could have been meant: an instance's, or one the
      // code being checked cannot see.
      if (candidate.includes('<') || !this.lookup(candidate)) continue
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
    ;[offset, message] = this.atSource(offset, message)
    if (!this.errors.some((e) => e.offset === offset && e.message === message)) {
      this.errors.push({ offset, message })
    }
  }

  warn(offset: number, message: string): void {
    ;[offset, message] = this.atSource(offset, message)
    if (!this.warnings.some((w) => w.offset === offset && w.message === message)) {
      this.warnings.push({ offset, message })
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
      // instance only.
      if (this.lookup(name) !== this.moduleScope.symbols.get(name)) {
        local = this.currentInstance?.first ? this.instanceDefs.get(name) : undefined
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

// === Generics helpers ===

// A generic function has no type until it is given its comptime arguments.
export function typeOfSymbol(sym: Symbol | undefined): ResolvedType | undefined {
  return sym && sym.kind !== 'generic' ? sym.type : undefined
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
    case 'GroupExpr':
      return typeOfArg(expr.expr)
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
    default:
      return null
  }
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
function mentionsUnbound(type: AST.Type, typeParams: readonly string[], bound: ReadonlyMap<string, ResolvedType>): boolean {
  switch (type.kind) {
    case 'TypeRef':
      return typeParams.includes(type.name) && !bound.has(type.name)
    case 'PointerType':
      return mentionsUnbound(type.pointee, typeParams, bound)
    case 'IndexedType':
      return mentionsUnbound(type.element, typeParams, bound)
    case 'CompositeType':
      return type.fields.some((f) => mentionsUnbound(f.type, typeParams, bound))
    case 'FuncType':
      return mentionsUnbound(type.input, typeParams, bound) || mentionsUnbound(type.output, typeParams, bound)
    default:
      return false
  }
}

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
        matchType(pattern.pointee, u.pointee, typeParams, bound, false)
      }
      return
    case 'IndexedType': {
      const element =
        u.kind === 'slice' || u.kind === 'array' ? u.element
        : u.kind === 'pointer' && u.pointee.kind === 'array' ? u.pointee.element
        : null
      if (element) matchType(pattern.element, element, typeParams, bound, false)
      return
    }
    case 'CompositeType':
      if (u.kind === 'tuple' && u.fields.length === pattern.fields.length) {
        pattern.fields.forEach((f, i) => {
          matchType(f.type, u.fields[i].type, typeParams, bound, value)
        })
      }
      return
    default:
      return
  }
}

// A copy of a generic's declaration, or of its signature alone, with the type
// parameters replaced by these types and the comptime parameters gone: an
// ordinary function's. Its offsets are the declaration's plus `delta`.
function bindTypes(of: AST.FuncDecl, params: AST.Field[], types: ResolvedType[], delta: number, part?: 'signature'): AST.FuncDecl {
  const bound = new Map(params.map((p, i) => [p.ident as string, types[i]]))
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
function literalMarks(node: unknown, found: { node: LiteralMarks; marks: LiteralMarks }[] = []) {
  if (Array.isArray(node)) {
    for (const n of node) literalMarks(n, found)
  } else if (node !== null && typeof node === 'object' && !(node instanceof Uint8Array)) {
    const n = node as LiteralMarks & { kind?: string }
    if (n.kind === 'LiteralExpr' || n.kind === 'ArrayExpr' || n.kind === 'RepeatExpr' || n.kind === 'TupleExpr') {
      const marks: LiteralMarks = {}
      if ('mut' in n) marks.mut = n.mut
      if ('dataId' in n) marks.dataId = n.dataId
      found.push({ node: n, marks })
    }
    for (const [key, value] of Object.entries(n)) if (key !== 'span') literalMarks(value, found)
  }
  return found
}

// The name of an instance, as a symbol and in WAT: the generic's name and the
// key of its arguments. The key of a large struct type runs to kilobytes, so a
// long one is cut and told apart by a hash of the whole.
function instanceName(generic: string, key: string, taken: (name: string) => boolean): string {
  if (key.length <= MAX_NAME_KEY) return `${generic}<${key}>`
  // FNV-1a, 32 bits from each end of the key
  const hash = (text: string) => {
    let h = 0x811c9dc5
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
    return (h >>> 0).toString(16).padStart(8, '0')
  }
  const short = `${generic}<${key.slice(0, MAX_NAME_KEY / 2)}~${hash(key)}${hash([...key].reverse().join(''))}`
  // Two keys with one hash would be one name: number them apart.
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${short}>` : `${short}~${n}>`
    if (!taken(name)) return name
  }
}

// A number literal as it would be written, for a message
function literalText(expr: AST.Expr): string | null {
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
        if (n.span) names.push({ name: n.name as string, offset: n.span.start })
        break
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
// from another copy, so no offset is moved twice.
function cloneAst(node: unknown, delta: number, subst: (name: string) => AST.BoundType | undefined): unknown {
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
      const type: AST.BoundType = { ...to, span: shift(n.span) }
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
