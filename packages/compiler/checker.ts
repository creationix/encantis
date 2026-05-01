// Type checker for Encantis
// Produces a TypeCheckResult with concrete types attached to all AST nodes

import type * as AST from './ast'
import { isSourceImport, resolveModulePath } from './loader'
import {
  type ResolvedType,
  type ResolvedField,
  type ArrayRT,
  type ArraySize,
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
  isNumeric,
  byteSize,
  isFixedSizes,
  totalElements,
  optionalOf,
  isOptional,
  unwrapOptional,
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
  | { kind: 'global'; type: ResolvedType }
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
    const defOffset = ctx.symbolDefOffsets.get(name)
    if (defOffset !== undefined) {
      const fromMap = ctx.types.get(typeKey(defOffset, 'IdentPattern'))
        ?? ctx.types.get(typeKey(defOffset, 'Field'))
      if (fromMap) { sym.type = fromMap as typeof sym.type; continue }
    }
    sym.type = concretizeType(sym.type, opts) as typeof sym.type
  }
  return {
    types: ctx.types,
    symbols: ctx.moduleScope.symbols,
    errors: ctx.errors,
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

    for (const decl of loaded.module.decls) {
      if (decl.kind === 'ImportDecl' && isSourceImport(decl.module)) {
        const depPath = resolveModulePath(decl.module, path)
        visit(depPath)
      }
    }

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
  errors: TypeError[] = []
  moduleScope: Scope = { parent: null, symbols: new Map() }
  currentScope: Scope = this.moduleScope
  insideIfLetCondition = false
  currentReturnType: ResolvedType | null = null

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
    // Update all type symbols to resolve forward references
    for (const [name, sym] of this.moduleScope.symbols) {
      if (sym.kind === 'type') {
        const resolved = this.resolveForwardRefsInType(sym.type)
        this.moduleScope.symbols.set(name, { ...sym, type: resolved })
        this.typeCache.set(name, resolved)
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
        return pointer(this.resolveForwardRefsInType(t.pointee))

      case 'array':
        return array(this.resolveForwardRefsInType(t.element), t.sizes)

      case 'slice':
        return slice(this.resolveForwardRefsInType(t.element))

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

    let type: ResolvedType
    if (decl.type) {
      type = this.resolveType(decl.type)
      if (decl.value) {
        // Use bidirectional type checking to fill in inferred sizes
        type = this.checkExpr(decl.value, type)
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
          this.checkFuncBody(decl.item)
        }
        break
      case 'FuncDecl':
        this.checkFuncBody(decl)
        break
      case 'TestDecl':
        this.checkTestDecl(decl)
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
      for (const stmt of body.stmts) {
        this.checkStmt(stmt)
      }
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
      case 'ReturnStmt':
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
        this.checkBody(stmt.body)
        break
      case 'LoopStmt':
        this.checkBody(stmt.body)
        break
      case 'ForStmt': {
        const iterableType = this.inferExpr(stmt.iterable)
        // Determine element type from iterable
        let elemType: ResolvedType = primitive('u32') // default: unsigned index
        if (iterableType.kind === 'comptime_int') {
          elemType = primitive('u32')
        } else if (iterableType.kind === 'array') {
          elemType = iterableType.element
        } else if (iterableType.kind === 'slice') {
          elemType = iterableType.element
        } else if (iterableType.kind === 'pointer' && iterableType.pointee.kind === 'array') {
          elemType = iterableType.pointee.element
        }
        // Record the binding type and add to scope
        this.types.set(typeKey(stmt.binding.span.start, stmt.binding.kind), elemType)
        this.currentScope.symbols.set(stmt.binding.value, { kind: 'local', type: elemType })
        this.recordDefinition(stmt.binding.value, stmt.binding.span.start)
        this.checkBody(stmt.body)
        break
      }
      case 'AssertStmt':
        this.inferExpr(stmt.expr)
        break
      case 'BreakStmt':
      case 'ContinueStmt':
        if (stmt.when) this.inferExpr(stmt.when)
        break
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
            this.types.set(typeKey(pattern.span.start, pattern.kind), type)
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
        return primitive(type.name)

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
      this.checkExpr(expr.operand, expected.pointee)
      const result = pointer(expected.pointee, false, expected.mutable)
      this.types.set(typeKey(expr.span.start, expr.kind), result)
      return result
    }

    // Bidirectional: propagate expected type into if-expression branches
    if (expr.kind === 'IfExpr' && !expr.pattern && expr.else_) {
      this.inferExpr(expr.condition)
      this.checkBodyAgainst(expr.thenBranch, expected)
      for (const elif of expr.elifs) {
        this.inferExpr(elif.condition)
        this.checkBodyAgainst(elif.thenBranch, expected)
      }
      this.checkBodyAgainst(expr.else_, expected)
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

    // Array/string literals against pointer/slice target: allocate in data section
    if (
      this.isDataLiteralExpr(expr) &&
      (expected.kind === 'pointer' && expected.pointee.kind === 'array' ||
       expected.kind === 'slice')
    ) {
      const litSize = this.getLiteralSize(expr)
      const arrType: ArrayRT = expected.kind === 'slice'
        ? array(expected.element, [typeof litSize === 'number' ? litSize : 0])
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
            this.checkExpr(elem, innerType)
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
    if (!typeAssignable(expected, inferred)) {
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

      case 'CoalesceExpr':
        return this.inferCoalesce(expr)

      case 'TupleExpr':
        return this.inferTuple(expr)

      case 'ArrayExpr':
        return this.inferArray(expr)

      case 'RepeatExpr':
        return this.inferRepeat(expr)

      case 'GroupExpr':
        return this.inferExpr(expr.expr)

      case 'SizeofExpr':
        return this.inferSizeof(expr)

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

    // Constructor call (type used as function)
    if (calleeType.kind === 'tuple') {
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
      case 'memset': {
        // memset(dest: [*]u8, value: u8, len: u32) -> ()
        // Low-level byte-based memory fill
        if (args.length !== 3) {
          this.error(expr.span.start, `memset expects 3 arguments (dest, value, len), got ${args.length}`)
          return VOID
        }

        // Dest must be [*]u8 (many-pointer to bytes)
        this.checkExpr(args[0].value, manyPointer(primitive('u8')), 'memset dest')

        // Value should be u8 (byte value)
        this.checkExpr(args[1].value, primitive('u8'), 'memset value')

        // Length in bytes (u32 for full memory range)
        this.checkExpr(args[2].value, primitive('u32'), 'memset len')

        // Record as builtin call for codegen
        this.types.set(typeKey(expr.span.start, 'BuiltinCall'), VOID)
        return VOID
      }

      case 'memcpy': {
        // memcpy(dest: [*]u8, src: [*]u8, len: u32) -> ()
        // Low-level byte-based memory copy
        if (args.length !== 3) {
          this.error(expr.span.start, `memcpy expects 3 arguments (dest, src, len), got ${args.length}`)
          return VOID
        }

        // Both must be [*]u8 (many-pointers to bytes)
        this.checkExpr(args[0].value, manyPointer(primitive('u8')), 'memcpy dest')
        this.checkExpr(args[1].value, manyPointer(primitive('u8')), 'memcpy src')

        // Length in bytes (u32 for full memory range)
        this.checkExpr(args[2].value, primitive('u32'), 'memcpy len')

        // Record as builtin call for codegen
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

    const left = unwrap(leftType)
    const right = unwrap(rightType)
    const leftIsComptime = left.kind === 'comptime_int' || left.kind === 'comptime_float'
    const rightIsComptime = right.kind === 'comptime_int' || right.kind === 'comptime_float'

    // Comparison and logical operators: propagate concrete type to comptime operand
    if (['==', '!=', '<', '>', '<=', '>='].includes(expr.op)) {
      if (leftIsComptime && right.kind === 'primitive') {
        this.checkExpr(expr.left, rightType)
      } else if (rightIsComptime && left.kind === 'primitive') {
        this.checkExpr(expr.right, leftType)
      }
      return primitive('bool')
    }
    if (['&&', '||'].includes(expr.op)) {
      return primitive('bool')
    }

    // Arithmetic/bitwise: determine result type, then propagate to comptime operands
    let resultType = leftType
    if (left.kind === 'primitive' && right.kind === 'primitive') {
      const leftSize = byteSize(left)
      const rightSize = byteSize(right)
      if (leftSize !== null && rightSize !== null && rightSize > leftSize) {
        resultType = rightType
      }
    } else if (rightIsComptime && left.kind === 'primitive') {
      resultType = leftType
    } else if (leftIsComptime && right.kind === 'primitive') {
      resultType = rightType
    }

    // Propagate concrete type to comptime operands (only for numeric types)
    if (leftIsComptime && right.kind === 'primitive') {
      this.checkExpr(expr.left, resultType)
    } else if (rightIsComptime && left.kind === 'primitive') {
      this.checkExpr(expr.right, resultType)
    }

    return resultType
  }

  inferUnary(expr: AST.UnaryExpr): ResolvedType {
    const operandType = this.inferExpr(expr.operand)

    switch (expr.op) {
      case '!':
        return primitive('bool')
      case '-':
      case '~':
        return operandType
      case '&': {
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
            // .len is only valid if length is determinable (fixed sizes or framing)
            if (objType.sizes === null) {
              this.error(expr.span.start, `cannot get .len on unbounded array ${typeToString(objType)} - length is unknown`)
              return primitive('u32')
            }
            return primitive('u32')
          }
          if (expr.member.name === 'wid') return primitive('u32')
        }
        // Pointer-to-array type built-in fields: .ptr, .len, .wid
        if (objType.kind === 'pointer' && objType.pointee.kind === 'array') {
          const arrayType = objType.pointee
          if (expr.member.name === 'ptr') {
            return manyPointer(arrayType.element)
          }
          if (expr.member.name === 'len') {
            // Same length rules apply to pointer-to-array
            if (arrayType.sizes === null) {
              this.error(expr.span.start, `cannot get .len on unbounded array ${typeToString(arrayType)} - length is unknown`)
              return primitive('u32')
            }
            return primitive('u32')
          }
          if (expr.member.name === 'wid') return primitive('u32')
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

  inferIndex(expr: AST.IndexExpr): ResolvedType {
    const objType = this.inferExpr(expr.object)
    this.inferExpr(expr.index)

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
            // Runtime index: return optional if element can be optional, error otherwise
            const elem = arrayType.element
            if (elem.kind === 'pointer' || elem.kind === 'slice') {
              return optionalOf(elem)
            }
            if (!this.insideIfLetCondition) {
              this.error(expr.index.span.start, `runtime index on *[${n}]${typeToString(elem)} requires 'if let' or '??' (no optional type for ${typeToString(elem)})`)
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
        argType = sym ? sym.type : primitive('i32')
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
    const thenType = this.inferBody(expr.thenBranch)
    for (const elif of expr.elifs) {
      this.inferExpr(elif.condition)
      this.inferBody(elif.thenBranch)
    }
    if (expr.else_) {
      this.inferBody(expr.else_)
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
    const size = byteSize(resolvedType)
    if (size === null) {
      this.error(expr.span.start, `sizeof: cannot compute size of dynamically sized type`)
    }
    // sizeof always returns u32 (natural size type for WebAssembly)
    return primitive('u32')
  }

  // === Scope Lookup ===

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
    // Avoid duplicate errors at the same offset
    if (!this.errors.some((e) => e.offset === offset && e.message === message)) {
      this.errors.push({ offset, message })
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
