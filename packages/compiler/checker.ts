// Type checker for Encantis
// Produces a TypeCheckResult with concrete types attached to all AST nodes

import type * as AST from './ast'
import {
  type ResolvedType,
  type ResolvedField,
  type IndexSpecifierRT,
  type IndexedRT,
  primitive,
  pointer,
  indexed,
  slice,
  array,
  tuple,
  func,
  field,
  VOID,
  comptimeInt,
  comptimeFloat,
  comptimeList,
  comptimeIndexed,
  named,
  forwardRef,
  manyPointer,
  typeToString,
  comptimeIntFits,
  typeAssignable,
  unwrap,
  isFloat,
  isInteger,
  isNumeric,
  byteSize,
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

// === Type Check Result ===

export interface TypeError {
  offset: number
  message: string
}

// Pending literal for data section serialization (handled by codegen, not checker)
export interface PendingLiteral {
  id: number          // AST offset
  expr: AST.Expr      // The literal expression (check expr.mut for mutable flag)
  type: IndexedRT     // Target type for serialization
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
}

const DEFAULT_OPTIONS: Required<TypecheckOptions> = {
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
  ctx.checkModule(module)

  // Concretize all comptime types to concrete types
  for (const [key, type] of ctx.types) {
    ctx.types.set(key, concretizeType(type, opts))
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

// === Concretization ===

/**
 * Concretize a single type, replacing comptime types with concrete defaults.
 */
export function concretizeType(
  t: ResolvedType,
  options: TypecheckOptions = DEFAULT_OPTIONS,
): ResolvedType {
  const opts: Required<TypecheckOptions> = { ...DEFAULT_OPTIONS, ...options }
  const u = unwrap(t)

  switch (u.kind) {
    case 'comptime_int':
      return primitive(opts.defaultInt)

    case 'comptime_float':
      return primitive(opts.defaultFloat)

    case 'comptime_list': {
      // Comptime lists become [*_]T with concretized element type (many-pointer default)
      const elemType = u.elements.length > 0
        ? concretizeType(u.elements[0], opts)
        : primitive(opts.defaultInt)
      return {
        kind: 'indexed',
        element: elemType,
        size: 'inferred',
        specifiers: [],
        manyPointer: true,
      }
    }

    case 'tuple':
      return {
        ...u,
        fields: u.fields.map((f) => ({
          ...f,
          type: concretizeType(f.type, opts),
        })),
      }

    case 'indexed':
      return {
        ...u,
        // Comptime indexed becomes [_]T (inferred length slice)
        // This is the default when no explicit type annotation is given
        size: u.size === 'comptime' ? 'inferred' : u.size,
        element: concretizeType(u.element, opts),
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

    case 'indexed':
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
  types = new Map<string, ResolvedType>()
  errors: TypeError[] = []
  moduleScope: Scope = { parent: null, symbols: new Map() }
  currentScope: Scope = this.moduleScope

  // Cache for resolved type aliases
  typeCache = new Map<string, ResolvedType>()

  // Track type names that are being defined (for recursive type detection)
  pendingTypeNames = new Set<string>()

  // Reference tracking
  references = new Map<number, number[]>() // defOffset → refOffsets
  symbolRefs = new Map<number, number>() // usageOffset → defOffset
  symbolDefOffsets = new Map<string, number>() // name → defOffset

  // Literals that need data section serialization (collected during checking)
  pendingLiterals: PendingLiteral[] = []

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
    } else if (decl.kind === 'ExportDecl' && decl.item.kind === 'TypeDecl') {
      this.pendingTypeNames.add((decl.item as AST.TypeDecl).ident.name)
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
      case 'DefDecl':
        this.collectDef(decl)
        break
      case 'GlobalDecl':
        this.collectGlobal(decl)
        break
      case 'MemoryDecl':
        // Memory declarations just specify size, no data entries
        break
    }
  }

  collectImport(decl: AST.ImportDecl): void {
    for (const item of decl.items) {
      switch (item.item.kind) {
        case 'ImportFunc': {
          const name = item.item.ident ?? item.name
          const sig = this.resolveSignature(item.item.signature)
          this.moduleScope.symbols.set(name, {
            kind: 'func',
            type: sig,
            inline: false,
          })
          this.recordDefinition(name, item.item.span.start)
          break
        }
        case 'ImportGlobal': {
          const type = this.resolveType(item.item.type)
          this.moduleScope.symbols.set(item.item.ident, {
            kind: 'global',
            type,
          })
          break
        }
        case 'ImportMemory':
          // Memory imports don't add symbols
          break
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
          return named(t.name, sym.type, sym.unique)
        }
        // Type was never defined - this shouldn't happen if pre-registration worked
        this.error(0, `unresolved forward reference to type: ${t.name}`)
        return primitive('i32')
      }

      case 'pointer':
        return pointer(this.resolveForwardRefsInType(t.pointee))

      case 'indexed':
        return indexed(
          this.resolveForwardRefsInType(t.element),
          t.size,
          t.specifiers,
          t.manyPointer
        )

      case 'tuple':
        return tuple(t.fields.map(f => field(f.name, this.resolveForwardRefsInType(f.type))))

      case 'func':
        return func(
          t.params.map(p => field(p.name, this.resolveForwardRefsInType(p.type))),
          t.returns.map(r => field(r.name, this.resolveForwardRefsInType(r.type)))
        )

      case 'named':
        return named(t.name, this.resolveForwardRefsInType(t.type), t.unique)

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

    // Check if this is a data section literal (array/string with pointer type)
    // e.g., def x = [0;12]:[*_]u32 or def x:[*_]u32 = [0;12]
    const dataLiteral = this.extractDataLiteral(decl.value, inferredType, declaredType)
    if (dataLiteral) {
      const dataId = dataLiteral.expr.span.start
      // Set dataId on the literal so it survives def substitution cloning
      if (dataLiteral.expr.kind === 'ArrayExpr' || dataLiteral.expr.kind === 'RepeatExpr' ||
          dataLiteral.expr.kind === 'LiteralExpr') {
        (dataLiteral.expr as AST.ArrayExpr | AST.RepeatExpr | AST.LiteralExpr).dataId = dataId
      }
      // Collect literal for data section and create data_ptr comptime value
      this.pendingLiterals.push({
        id: dataId,
        expr: dataLiteral.expr,
        type: dataLiteral.indexedType,
      })
      this.moduleScope.symbols.set(decl.ident, {
        kind: 'def',
        type: dataLiteral.ptrType,
        value: { kind: 'data_ptr', id: dataId },
      })
      this.recordDefinition(decl.ident, decl.span.start)
      return
    }

    // Regular comptime value (int, float, bool)
    const type = declaredType ?? inferredType
    const value = this.evalComptimeExpr(decl.value)
    if (!value) {
      this.error(decl.span.start, `def value must be a compile-time constant`)
      this.moduleScope.symbols.set(decl.ident, { kind: 'def', type, value: { kind: 'int', value: 0n } })
    } else {
      this.moduleScope.symbols.set(decl.ident, { kind: 'def', type, value })
    }
    this.recordDefinition(decl.ident, decl.span.start)
  }

  // Extract a data section literal from an expression if applicable
  // Returns the literal expression, its indexed type, and the pointer type
  private extractDataLiteral(
    expr: AST.Expr,
    inferredType: ResolvedType,
    declaredType: ResolvedType | null = null
  ): {
    expr: AST.Expr
    indexedType: IndexedRT
    ptrType: ResolvedType
  } | null {
    // Handle annotation on RHS: [0;12]:[*_]u32 -> many-pointer (thin pointer) to indexed
    if (expr.kind === 'AnnotationExpr') {
      const innerExpr = expr.expr
      // Check for indexed type with manyPointer (e.g., [*_]u32, [*12]u8)
      if (this.isDataLiteralExpr(innerExpr) && inferredType.kind === 'indexed' && inferredType.manyPointer) {
        // The element type is what gets stored in memory
        // For [*_]u32 with [0;12], we store 12 u32s and return a pointer
        // Infer size from literal if annotation has inferred size
        let size = inferredType.size
        if (size === 'inferred') {
          size = this.getLiteralSize(innerExpr)
        }
        // Create an indexed type without the manyPointer for the data
        const dataType: IndexedRT = {
          kind: 'indexed',
          element: inferredType.element,
          size,
          specifiers: inferredType.specifiers,
        }
        // Also update the pointer type with the concrete size
        const ptrType: IndexedRT = {
          kind: 'indexed',
          element: inferredType.element,
          size,
          specifiers: inferredType.specifiers,
          manyPointer: true,
        }
        return {
          expr: innerExpr,
          indexedType: dataType,
          ptrType,
        }
      }
      // Also handle explicit pointer type *[_]u32
      if (this.isDataLiteralExpr(innerExpr) && inferredType.kind === 'pointer' && inferredType.pointee.kind === 'indexed') {
        return {
          expr: innerExpr,
          indexedType: inferredType.pointee,
          ptrType: inferredType,
        }
      }
    }

    // Handle type annotation on LHS: def x:[*_]u32 = [0;12]
    // The expr is a bare literal and declaredType is the pointer type
    if (declaredType && this.isDataLiteralExpr(expr)) {
      // Check for indexed type with manyPointer (e.g., [*_]u32)
      if (declaredType.kind === 'indexed' && declaredType.manyPointer) {
        let size = declaredType.size
        if (size === 'inferred') {
          size = this.getLiteralSize(expr)
        }
        const dataType: IndexedRT = {
          kind: 'indexed',
          element: declaredType.element,
          size,
          specifiers: declaredType.specifiers,
        }
        const ptrType: IndexedRT = {
          kind: 'indexed',
          element: declaredType.element,
          size,
          specifiers: declaredType.specifiers,
          manyPointer: true,
        }
        return {
          expr,
          indexedType: dataType,
          ptrType,
        }
      }
      // Handle explicit pointer type *[_]u32
      if (declaredType.kind === 'pointer' && declaredType.pointee.kind === 'indexed') {
        let size = declaredType.pointee.size
        if (size === 'inferred') {
          size = this.getLiteralSize(expr)
        }
        const indexedType: IndexedRT = {
          ...declaredType.pointee,
          size,
        }
        return {
          expr,
          indexedType,
          ptrType: declaredType,
        }
      }
    }

    // Handle bare data literals without type annotation: def x = [0;12] or def x = [0:u32;12]
    // These become many-pointers to the inferred indexed type
    if (!declaredType && this.isDataLiteralExpr(expr) && inferredType.kind === 'indexed') {
      const size = inferredType.size !== 'inferred' ? inferredType.size : this.getLiteralSize(expr)
      const dataType: IndexedRT = {
        kind: 'indexed',
        element: inferredType.element,
        size,
        specifiers: inferredType.specifiers,
      }
      const ptrType: IndexedRT = {
        kind: 'indexed',
        element: inferredType.element,
        size,
        specifiers: inferredType.specifiers,
        manyPointer: true,
      }
      return {
        expr,
        indexedType: dataType,
        ptrType,
      }
    }

    return null
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
      default:
        // Other declarations don't need body checking
        break
    }
  }

  checkFuncBody(decl: AST.FuncDecl): void {
    // Create function scope with params and named returns
    const funcScope: Scope = { parent: this.moduleScope, symbols: new Map() }

    // Add parameters and named returns to scope
    this.bindFields(decl.signature.input, funcScope, 'param')
    this.bindFields(decl.signature.output, funcScope, 'return')

    // Check body
    const prevScope = this.currentScope
    this.currentScope = funcScope
    this.checkBody(decl.body)
    this.currentScope = prevScope
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
        if (stmt.value) this.inferExpr(stmt.value)
        if (stmt.when) this.inferExpr(stmt.when)
        break
      case 'AssignmentStmt':
        // Infer types for both target and value so hints work on both sides
        if (stmt.target.kind === 'IdentExpr' || stmt.target.kind === 'MemberExpr' || stmt.target.kind === 'IndexExpr') {
          this.inferExpr(stmt.target)
        }
        this.inferExpr(stmt.value)
        break
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
        let elemType: ResolvedType = primitive('i32') // fallback
        if (iterableType.kind === 'indexed') {
          elemType = iterableType.element
        } else if (iterableType.kind === 'pointer' && iterableType.pointee.kind === 'indexed') {
          elemType = iterableType.pointee.element
        }
        // Record the binding type and add to scope
        this.types.set(typeKey(stmt.binding.span.start, stmt.binding.kind), elemType)
        this.currentScope.symbols.set(stmt.binding.value, { kind: 'local', type: elemType })
        this.recordDefinition(stmt.binding.value, stmt.binding.span.start)
        this.checkBody(stmt.body)
        break
      }
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
    // set doesn't create new bindings, just reassigns existing ones
    // TODO: validate pattern bindings exist
  }

  bindPattern(pattern: AST.Pattern, type: ResolvedType): void {
    switch (pattern.kind) {
      case 'IdentPattern':
        this.currentScope.symbols.set(pattern.name, { kind: 'local', type })
        // Record type at pattern offset for LSP
        this.types.set(typeKey(pattern.span.start, pattern.kind), type)
        this.recordDefinition(pattern.name, pattern.span.start)
        break
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
        // Default to [*_]T (inferred length many-pointer)
        if (type.elements.length === 0) {
          // Empty list defaults to [*_]i32
          return indexed(primitive('i32'), 'inferred', [], true)
        }
        const elemType = this.concretize(this.unifyTypes(type.elements))
        return indexed(elemType, 'inferred', [], true)
      }
      case 'indexed': {
        // Handle comptime indexed ([T]) - default to [_]T (inferred length)
        if (type.size === 'comptime') {
          const elemType = this.concretize(type.element)
          return indexed(elemType, 'inferred', type.specifiers, type.manyPointer)
        }
        // Always concretize element type (e.g., [100]comptime_int -> [100]i32)
        const elemType = this.concretize(type.element)
        if (elemType !== type.element) {
          return indexed(elemType, type.size, type.specifiers, type.manyPointer)
        }
        return type
      }
      default:
        return type
    }
  }

  // Check if a type contains any 'inferred' sizes that need to be filled in
  hasInferredSize(type: ResolvedType): boolean {
    switch (type.kind) {
      case 'indexed':
        return type.size === 'inferred' || this.hasInferredSize(type.element)
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
      case 'indexed':
        return typeof type.size === 'number' && this.hasConcreteSizeOrNoInferred(type.element)
      case 'pointer':
        return this.hasConcreteSize(type.pointee)
      case 'tuple':
        return type.fields.every(f => this.hasConcreteSizeOrNoInferred(f.type))
      default:
        return true // Non-indexed types are "concrete" by default
    }
  }

  // Helper: type has either concrete size or no inferred sizes at all
  hasConcreteSizeOrNoInferred(type: ResolvedType): boolean {
    switch (type.kind) {
      case 'indexed':
        if (type.size === 'inferred') return false
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
        return array(innerType, lengths[0])
      }
      return slice(innerType)
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
        return pointer(this.resolveType(type.pointee))

      case 'IndexedType': {
        const element = this.resolveType(type.element)
        // Specifiers are only framing markers (! and ?) - length is in type.size
        const specifiers: IndexSpecifierRT[] = type.specifiers.map((s): IndexSpecifierRT =>
          s.kind === 'null' ? { kind: 'null' } : { kind: 'prefix' }
        )
        // Preserve 'inferred' size - will be filled in by bidirectional checking
        return indexed(element, type.size, specifiers, type.manyPointer)
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
          return named(type.name, sym.type, sym.unique)
        }
        // Check if this is a forward reference to a type being defined
        if (this.pendingTypeNames.has(type.name)) {
          return forwardRef(type.name)
        }
        this.error(type.span.start, `unknown type: ${type.name}`)
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
    const offset = expr.kind === 'MemberExpr' ? expr.span.end : expr.span.start
    this.types.set(typeKey(offset, expr.kind), type)
    return type
  }

  // Check an expression against an expected type (top-down / bidirectional)
  // This allows comptime types to resolve based on context
  // Optional errorContext is prepended to error messages (e.g., "argument 1: ")
  checkExpr(expr: AST.Expr, expected: ResolvedType, errorContext?: string): ResolvedType {
    const inferred = this.inferExprInner(expr)
    const prefix = errorContext ? `${errorContext}: ` : ''

    // Handle comptime_list against indexed types - propagate element type down
    if (inferred.kind === 'comptime_list' && expected.kind === 'indexed') {
      // If expected has inferred size, fill it in from the literal length
      let resolvedExpected = expected
      if (expected.size === 'inferred' && expr.kind === 'ArrayExpr') {
        resolvedExpected = indexed(expected.element, expr.elements.length, expected.specifiers, expected.manyPointer)
      }
      // Check each element against the inner element type
      if (expr.kind === 'ArrayExpr') {
        // Determine what type to check each element against
        // For stacked specifiers like *[![!u8]], peel off one specifier level
        // so "hello" checks against *[!u8] (not just u8)
        const innerType = this.peelSpecifier(resolvedExpected)
        for (const elem of expr.elements) {
          this.checkExpr(elem, innerType)
        }
      }
      // Resolve to concrete indexed type based on expected
      const resolved = this.resolveListToIndexed(inferred, resolvedExpected)
      // For LSP, record the comptime_list type (not resolved) so user sees the literal type
      if (expr.kind === 'ArrayExpr') {
        this.types.set(typeKey(expr.span.start, expr.kind), inferred)
      }
      // Collect literal for deferred serialization (concrete types only)
      if (resolvedExpected.size !== 'comptime') {
        this.pendingLiterals.push({ id: expr.span.start, expr, type: resolvedExpected })
      }
      return resolved
    }

    // Handle comptime indexed ([]T) against concrete indexed types
    // Must check each element individually to catch overflow (e.g., [1,10,100,1000]:[4]u8)
    if (
      inferred.kind === 'indexed' &&
      inferred.size === 'comptime' &&
      expected.kind === 'indexed' &&
      expected.size !== 'comptime'
    ) {
      // If expected has inferred size, fill it in from the literal length
      let resolvedExpected = expected
      if (expected.size === 'inferred' && expr.kind === 'ArrayExpr') {
        resolvedExpected = indexed(expected.element, expr.elements.length, expected.specifiers, expected.manyPointer)
      }
      if (expr.kind === 'ArrayExpr') {
        // Peel specifiers to get the element type for checking
        // e.g., *[![!u8]] -> *[!u8] for first level, *[!u8] -> u8 for second level
        const innerType = this.peelSpecifier(resolvedExpected)
        for (const elem of expr.elements) {
          this.checkExpr(elem, innerType)
        }
      }
      // Record the inferred comptime type
      this.types.set(typeKey(expr.span.start, expr.kind), inferred)
      // Collect literal for deferred serialization
      this.pendingLiterals.push({ id: expr.span.start, expr, type: resolvedExpected })
      // Return concretized type
      return this.concretizeToTarget(inferred, resolvedExpected)
    }

    // Handle pointer-to-indexed with inferred size: *[_]T
    if (
      expected.kind === 'pointer' &&
      expected.pointee.kind === 'indexed' &&
      expected.pointee.size === 'inferred' &&
      (inferred.kind === 'indexed' && inferred.size === 'comptime') &&
      expr.kind === 'ArrayExpr'
    ) {
      // Fill in the size from the literal
      const resolvedPointee = indexed(
        expected.pointee.element,
        expr.elements.length,
        expected.pointee.specifiers,
        expected.pointee.manyPointer,
      )
      const resolvedExpected = pointer(resolvedPointee)
      // Check elements
      const innerType = this.peelSpecifier(resolvedPointee)
      for (const elem of expr.elements) {
        this.checkExpr(elem, innerType)
      }
      // Record and return
      this.types.set(typeKey(expr.span.start, expr.kind), inferred)
      this.pendingLiterals.push({ id: expr.span.start, expr, type: resolvedPointee })
      return resolvedExpected
    }

    // Handle indexed with inferred size against indexed with known size (e.g., RepeatExpr)
    // [_]T or [*_]T with initializer [value; N] should fill in size from N
    if (
      expected.kind === 'indexed' &&
      expected.size === 'inferred' &&
      inferred.kind === 'indexed' &&
      typeof inferred.size === 'number'
    ) {
      // Fill in the inferred size from the value's known size
      const resolved = indexed(expected.element, inferred.size, expected.specifiers, expected.manyPointer)
      this.types.set(typeKey(expr.span.start, expr.kind), resolved)
      return resolved
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
      (inferred.kind === 'indexed' && (inferred.size === 'comptime' || typeof inferred.size === 'number'))
    const expectedHasInferredSize = expected.kind === 'indexed' && expected.size === 'inferred'
    const recordType = expected.kind === 'named' ? expected
      : (isComptimeLiteral && !expectedHasInferredSize ? expected : inferred)
    // Use span.end for MemberExpr to match inferExpr behavior (allows distinguishing a.b from a.b.c)
    const typeOffset = expr.kind === 'MemberExpr' ? expr.span.end : expr.span.start
    this.types.set(typeKey(typeOffset, expr.kind), recordType)

    // For return value, concretize based on expected type
    return this.concretizeToTarget(inferred, expected)
  }

  // Peel off one specifier level from an indexed type to get the inner element type
  // *[![!u8]] -> *[!u8] (peel first !, remaining is !)
  // *[!u8] -> u8 (peel !, no remaining specifiers = element type)
  // *[*[u8]] -> *[u8] (element is already an indexed type)
  peelSpecifier(t: IndexedRT): ResolvedType {
    // If element is already an indexed type (separate brackets), use it directly
    // e.g., *[*[u8]] -> *[u8]
    if (t.element.kind === 'indexed') {
      return t.element
    }
    // If we have stacked specifiers (merged brackets), peel one off
    // e.g., *[![!u8]] -> *[!u8] (still indexed with remaining specifiers)
    if (t.specifiers.length > 1) {
      return indexed(t.element, null, t.specifiers.slice(1))
    }
    // One or zero specifiers: inner type is just the element
    // e.g., [!]u8 -> u8, []u8 -> u8
    return t.element
  }

  // Resolve a comptime_list to a concrete indexed type based on expected type
  resolveListToIndexed(list: { kind: 'comptime_list'; elements: ResolvedType[] }, expected: IndexedRT): ResolvedType {
    // Size is either expected size or list length
    const size = expected.size ?? list.elements.length
    // Element type from expected
    const elemType = expected.element
    // Specifiers from expected
    return indexed(elemType, size, expected.specifiers)
  }

  // Concretize a comptime type to match expected type
  concretizeToTarget(type: ResolvedType, expected: ResolvedType): ResolvedType {
    if (type.kind === 'comptime_int' && expected.kind === 'primitive') {
      return expected
    }
    if (type.kind === 'comptime_float' && expected.kind === 'primitive') {
      return expected
    }
    if (type.kind === 'comptime_list' && expected.kind === 'indexed') {
      return this.resolveListToIndexed(type, expected)
    }
    // Handle comptime indexed type against concrete indexed type
    if (type.kind === 'indexed' && type.size === 'comptime' && expected.kind === 'indexed') {
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
        if (annotationType.kind === 'indexed' && annotationType.size === 'inferred') {
          const literalSize = this.getLiteralSize(expr.expr)
          if (literalSize !== 'inferred') {
            annotationType = {
              ...annotationType,
              size: literalSize,
            }
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
        // Default to many-pointer [*N]u8 - can coerce to fat slices via bidirectional typing
        const len = expr.value.bytes.length
        return indexed(primitive('u8'), len, [], true)
      }

      case 'bool':
        return primitive('bool')
    }
  }

  inferIdent(expr: AST.IdentExpr): ResolvedType {
    const sym = this.lookup(expr.name)
    if (!sym) {
      this.error(expr.span.start, `unknown identifier: ${expr.name}`)
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
        this.error(
          expr.span.start,
          `expected ${calleeType.params.length} arguments, got ${argCount}`,
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

      default:
        return null // Not a builtin
    }
  }

  inferBinary(expr: AST.BinaryExpr): ResolvedType {
    const leftType = this.inferExpr(expr.left)
    const rightType = this.inferExpr(expr.right)

    // Comparison operators return bool
    if (['==', '!=', '<', '>', '<=', '>='].includes(expr.op)) {
      return primitive('bool')
    }

    // Logical operators
    if (['&&', '||'].includes(expr.op)) {
      return primitive('bool')
    }

    // Arithmetic/bitwise: result type depends on operands
    // For now, return left type (simplified)
    return leftType
  }

  inferUnary(expr: AST.UnaryExpr): ResolvedType {
    const operandType = this.inferExpr(expr.operand)

    switch (expr.op) {
      case '!':
        return primitive('bool')
      case '-':
      case '~':
        return operandType
      case '&':
        return pointer(operandType)
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
        // Indexed type built-in fields (slice/array): .ptr, .len, .wid
        if (objType.kind === 'indexed') {
          if (expr.member.name === 'ptr') {
            // .ptr returns a many-pointer preserving specifiers from the slice
            return manyPointer(objType.element, objType.specifiers)
          }
          if (expr.member.name === 'len') {
            // .len is only valid if length is determinable:
            // - Fat slices (manyPointer=false) store length in the pointer
            // - Many-pointers with known size [*N]T have compile-time length
            // - Many-pointers with framing [*!]T, [*?]T can calculate length
            // - Bare many-pointers [*]T have no length info
            if (objType.manyPointer && typeof objType.size !== 'number' && objType.specifiers.length === 0) {
              this.error(expr.span.start, `cannot get .len on bare many-pointer ${typeToString(objType)} - length is unknown`)
              return primitive('u32')
            }
            return primitive('u32')
          }
          if (expr.member.name === 'wid') return primitive('u32')
        }
        // Pointer-to-indexed type built-in fields: .ptr, .len, .wid
        if (objType.kind === 'pointer' && objType.pointee.kind === 'indexed') {
          const indexedType = objType.pointee
          if (expr.member.name === 'ptr') {
            // .ptr returns a many-pointer preserving specifiers
            return manyPointer(indexedType.element, indexedType.specifiers)
          }
          if (expr.member.name === 'len') {
            // Same length rules apply to pointer-to-indexed
            if (indexedType.manyPointer && typeof indexedType.size !== 'number' && indexedType.specifiers.length === 0) {
              this.error(expr.span.start, `cannot get .len on bare many-pointer ${typeToString(indexedType)} - length is unknown`)
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
        if (objType.kind === 'indexed') {
          this.error(expr.span.start, `cannot use .* on ${typeToString(objType)} - use [0] to access the first element`)
          return objType.element
        }
        this.error(expr.span.start, `cannot dereference non-pointer type ${typeToString(objType)}`)
        return primitive('i32')
      }

      case 'type': {
        // Type pun: ptr.u32, array.u64, etc.
        // Returns a many-pointer to the punned type (specifiers don't carry over)
        const punType = this.resolveType(expr.member.type)

        // For any indexed type (many-pointer or fat slice): [*]u8.u32, []u8.u32, [12]u8.u32 → [*]u32
        if (objType.kind === 'indexed') {
          return manyPointer(punType)
        }

        // For pointer-to-indexed: *[12]u8.u32 → [*]u32
        if (objType.kind === 'pointer' && objType.pointee.kind === 'indexed') {
          return manyPointer(punType)
        }

        // For plain pointers: *u8.u32 → [*]u32
        if (objType.kind === 'pointer') {
          return manyPointer(punType)
        }

        // Default: just return the punned type
        return punType
      }
    }
  }

  inferIndex(expr: AST.IndexExpr): ResolvedType {
    const objType = this.inferExpr(expr.object)
    this.inferExpr(expr.index)

    if (objType.kind === 'indexed') {
      return objType.element
    }

    if (objType.kind === 'pointer') {
      // If pointing to an indexed type (e.g., *[12]u32), return the element type
      if (objType.pointee.kind === 'indexed') {
        return objType.pointee.element
      }
      return objType.pointee
    }

    this.error(expr.span.start, `cannot index type: ${typeToString(objType)}`)
    return primitive('i32')
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
    return tuple(fields)
  }

  inferArray(expr: AST.ArrayExpr): ResolvedType {
    if (expr.elements.length === 0) {
      // Empty array - needs context to determine element type
      // For now, return comptime list with no elements
      return comptimeList([])
    }

    // Infer element types
    const elemTypes = expr.elements.map((e) => this.inferExpr(e))

    // Use first element's type as the element type (arrays are homogeneous)
    // TODO: unify element types properly
    const elementType = elemTypes[0]

    // Return comptime indexed type: T[]
    return comptimeIndexed(elementType)
  }

  inferRepeat(expr: AST.RepeatExpr): ResolvedType {
    // [value; count] - repeat value count times
    const valueType = this.inferExpr(expr.value)
    this.inferExpr(expr.count) // Type check the count expression

    // Count should be a compile-time integer
    const countValue = this.evalComptimeExpr(expr.count)
    if (!countValue || countValue.kind !== 'int') {
      this.error(expr.count.span.start, 'repeat count must be a compile-time integer')
      return comptimeIndexed(valueType)
    }

    const count = Number(countValue.value)
    if (count < 0) {
      this.error(expr.count.span.start, 'repeat count cannot be negative')
      return comptimeIndexed(valueType)
    }

    // Return indexed type with known size - we know the count at compile time
    return array(valueType, count)
  }

  inferIf(expr: AST.IfExpr): ResolvedType {
    this.inferExpr(expr.condition)
    // TODO: unify branch types
    this.checkBody(expr.thenBranch)
    for (const elif of expr.elifs) {
      this.inferExpr(elif.condition)
      this.checkBody(elif.thenBranch)
    }
    if (expr.else_) {
      this.checkBody(expr.else_)
    }
    return VOID
  }

  inferMatch(expr: AST.MatchExpr): ResolvedType {
    this.inferExpr(expr.subject)
    // TODO: unify arm types
    for (const arm of expr.arms) {
      if (arm.body.kind === 'Block' || arm.body.kind === 'ArrowBody') {
        this.checkBody(arm.body)
      } else {
        this.inferExpr(arm.body)
      }
    }
    return VOID
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

  error(offset: number, message: string): void {
    // Avoid duplicate errors at the same offset
    if (!this.errors.some((e) => e.offset === offset && e.message === message)) {
      this.errors.push({ offset, message })
    }
  }

  // === Reference Tracking ===

  // Record a symbol definition at the given offset
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
