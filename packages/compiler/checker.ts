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
  comptimeIntFits,
  typeAssignable,
  unwrap,
  isFloat,
  isInteger,
  isSigned,
  isNumeric,
  isBool,
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

// Compile-time constant value (for def constants)
export type ComptimeValue =
  | { kind: 'int'; value: bigint }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'data_ptr'; id: number }  // pointer to data section literal (id is AST offset for literalRefs lookup)

export type Symbol =
  | { kind: 'type'; type: ResolvedType; unique: boolean }
  | { kind: 'func'; type: ResolvedType & { kind: 'func' }; inline: boolean }
  // init: the value of the initializer, when it's a constant expression
  | { kind: 'global'; type: ResolvedType; init?: ComptimeValue }
  | { kind: 'def'; type: ResolvedType; value: ComptimeValue }
  | { kind: 'local'; type: ResolvedType }
  | { kind: 'param'; type: ResolvedType }
  | { kind: 'return'; type: ResolvedType }

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
      if (sym && (sym.kind === 'func' || sym.kind === 'def' || sym.kind === 'global')) {
        ctx.warnings.push({ offset: defOffset, message: `'${name}' is never used` })
      }
    }
  }

  return {
    types: ctx.types,
    exprTypes: ctx.exprTypes,
    coercions: ctx.coercions,
    symbols: ctx.moduleScope.symbols,
    errors: ctx.errors,
    warnings: ctx.warnings,
    references: ctx.references,
    symbolRefs: ctx.symbolRefs,
    symbolDefOffsets: ctx.symbolDefOffsets,
    literals: ctx.pendingLiterals,
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

class CheckContext {
  source?: string
  types = new Map<string, ResolvedType>()
  exprTypes = new Map<AST.Expr, ResolvedType>()
  coercions = new Map<AST.Expr, ResolvedType>()
  // if and match expressions used as statements: nothing takes their value,
  // so their branches don't have to agree on a type.
  statementExprs = new Set<AST.Expr>()
  // The constant each branch of an if or match of constants is by itself.
  // The branches share one type, and each has to be a value of it.
  branchConstants = new Map<AST.Expr, ResolvedType>()
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
          if (isSource && depExports) {
            const exported = depExports.get(item.name)
            if (!exported) {
              this.errors.push({ offset: item.span.start, message: `'${item.name}' is not exported from '${decl.module}'` })
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

  collectFunc(decl: AST.FuncDecl): void {
    if (!decl.ident) return // Anonymous function
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
      if (sym.kind !== 'type') {
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
        ?? (expr.object.kind === 'IdentExpr' ? this.lookup(expr.object.name)?.type : undefined)
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

    const init = decl.value ? this.globalInitializer(decl.value) : undefined
    this.moduleScope.symbols.set(name, init ? { kind: 'global', type, init } : { kind: 'global', type })
    this.types.set(typeKey(decl.pattern.span.start, decl.pattern.kind), type)
    this.recordDefinition(name, decl.pattern.span.start)
  }

  // A wasm global starts as a constant, so its initializer has to be one: a
  // number or bool the compiler can work out, the address of data or of a
  // function, or a tuple or struct of those. A number's value goes to
  // codegen, which emits it when the expression as written would need an
  // instruction (1 + 1, a literal that widens, a cast that narrows).
  private globalInitializer(expr: AST.Expr): ComptimeValue | undefined {
    const value = this.evalComptimeExpr(expr, true)
    if (!value && !this.isConstantInitializer(expr)) {
      this.error(expr.span.start, 'global initializer must be a compile-time constant')
    }
    return value ?? undefined
  }

  private isConstantInitializer(expr: AST.Expr): boolean {
    if (this.evalComptimeExpr(expr, true)) return true
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
      case 'CallExpr':
        // A struct constructor of constants.
        return expr.callee.kind === 'IdentExpr' && this.lookup(expr.callee.name)?.kind === 'type'
          && expr.args.every(a => a.value !== null && this.isConstantInitializer(a.value))
      case 'IdentExpr':
        return this.lookup(expr.name)?.kind === 'func'
      default:
        // A string or an array literal lives in the data section.
        return this.isDataLiteralExpr(expr)
    }
  }

  // === Second Pass: Check Declarations ===

  checkDeclaration(decl: AST.Declaration): void {
    switch (decl.kind) {
      case 'ExportDecl':
        if (decl.item.kind === 'FuncDecl') {
          this.warnManyPointerParams(decl.item)
          this.checkFuncBody(decl.item)
        }
        break
      case 'FuncDecl':
        this.checkFuncBody(decl)
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
        case 'ImportDecl':
          this.collectImport(item)
          break
        case 'FuncDecl':
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

    // Check body
    const prevScope = this.currentScope
    const prevReturnType = this.currentReturnType
    this.currentScope = funcScope
    this.currentReturnType = this.resolveType(decl.signature.output)
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
        this.error(decl.span.start, `function '${decl.ident ?? 'anonymous'}' can reach its end without returning a value`)
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
        this.error(stmt.span.start, `'${stmt.op}' cannot be applied to ${typeToString(targetType)} and ${typeToString(valueType)}`)
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
    const valueType = sym && sym.kind !== 'func' && sym.kind !== 'type'
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
          if (!sym || !fieldType || sym.kind === 'func' || sym.kind === 'type') return
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
              this.exprTypes.set(elem, innerType)
            } else {
              this.checkExpr(elem, innerType)
            }
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

    // (e) is e, not a tuple literal of one field: what's expected of a
    // tuple in parentheses is expected of the tuple itself.
    const unwrappedExpected = unwrap(expected)
    const grouped = groupedExpr(expr)
    if (grouped && unwrappedExpected.kind === 'tuple' && inferred.kind === 'tuple') {
      const type = this.checkExpr(grouped, expected, errorContext)
      this.exprTypes.set(expr, this.exprTypes.get(grouped) ?? type)
      return type
    }

    // Propagate expected type into tuple elements for bidirectional inference
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
    }
  }

  inferCall(expr: AST.CallExpr): ResolvedType {
    // Check for builtin functions first
    if (expr.callee.kind === 'IdentExpr') {
      const builtinResult = this.inferBuiltin(expr, expr.callee.name)
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
        const value = argValue(arg)
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
      this.error(expr.span.start, `'${expr.op}' cannot be applied to ${typeToString(leftType)} and ${typeToString(rightType)}`)
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
    if (!isBool(type)) {
      this.error(expr.span.start, `${what} must be bool, not ${typeToString(type)}`)
    }
  }

  // Make an expression, already inferred as `actual`, give a value of type
  // `expected`. A constant takes the type itself, down to its literals. A
  // narrower value keeps its type and is marked to be widened where it's
  // used. Anything else is an error.
  private coerce(expr: AST.Expr, actual: ResolvedType, expected: ResolvedType, prefix = ''): void {
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
  // that are ifs or matches themselves. Null for any other expression.
  private leastBranch(expr: AST.Expr): bigint | null {
    const bodies = expr.kind === 'IfExpr' ? [expr.thenBranch, ...expr.elifs.map(elif => elif.thenBranch), expr.else_]
      : expr.kind === 'MatchExpr' ? expr.arms.map(arm => arm.body)
      : null
    if (!bodies) return null
    let least: bigint | null = null
    for (const body of bodies) {
      const value = body && bodyValue(body)
      if (!value || !this.branchConstants.has(value)) continue
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
    const objType = this.inferExpr(expr.object)
    this.inferIndexValue(expr.index)

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
    const size = byteSize(resolvedType)
    if (size === null) {
      this.error(expr.span.start, `sizeof: cannot compute size of dynamically sized type`)
    }
    // sizeof always returns u32 (natural size type for WebAssembly)
    return primitive('u32')
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
      if (sym) return sym
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
      const dist = editDistance(name, candidate)
      if (dist < bestDist) {
        bestDist = dist
        best = candidate
      }
    }
    return best
  }

  error(offset: number, message: string): void {
    if (!this.errors.some((e) => e.offset === offset && e.message === message)) {
      this.errors.push({ offset, message })
    }
  }

  warn(offset: number, message: string): void {
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
    this.symbolDefOffsets.set(name, offset)
    this.references.set(offset, [])
  }

  // Record a reference to a symbol (looks up def offset by name)
  recordReference(name: string, refOffset: number): void {
    const defOffset = this.symbolDefOffsets.get(name)
    if (defOffset !== undefined) {
      const refs = this.references.get(defOffset)
      if (refs && !refs.includes(refOffset)) {
        refs.push(refOffset)
      }
      this.symbolRefs.set(refOffset, defOffset)
    }
  }
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

function stripMax(t: ResolvedType): ResolvedType {
  return t.kind === 'primitive' && t.max !== undefined ? primitive(t.name) : t
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
