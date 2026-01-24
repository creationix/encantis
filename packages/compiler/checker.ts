// Type checker for Encantis
// Produces a TypeCheckResult with concrete types attached to all AST nodes

import type * as AST from './ast'
import {
  type ResolvedType,
  type ResolvedField,
  type PrimitiveName,
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
  typeToString,
  comptimeIntFits,
  typeAssignable,
  defaultIndexedType,
  unwrap,
} from './types'

// === Symbol Table ===

// Compile-time constant value (for def constants)
export type ComptimeValue =
  | { kind: 'int'; value: bigint }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }

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
  expr: AST.Expr      // The literal expression
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
      // Comptime lists become slices with concretized element type
      const elemType = u.elements.length > 0
        ? concretizeType(u.elements[0], opts)
        : primitive(opts.defaultInt)
      return {
        kind: 'indexed',
        element: elemType,
        size: null,
        specifiers: [],
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

  // Reference tracking
  references = new Map<number, number[]>() // defOffset → refOffsets
  symbolRefs = new Map<number, number>() // usageOffset → defOffset
  symbolDefOffsets = new Map<string, number>() // name → defOffset

  // Literals that need data section serialization (collected during checking)
  pendingLiterals: PendingLiteral[] = []

  checkModule(module: AST.Module): void {
    // First pass: collect all type aliases, function signatures, globals, defs
    for (const decl of module.decls) {
      this.collectDeclaration(decl)
    }

    // Second pass: check function bodies and expressions
    for (const decl of module.decls) {
      this.checkDeclaration(decl)
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
        // Memory declarations don't add symbols
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
  }

  collectDef(decl: AST.DefDecl): void {
    // Defs are comptime - infer type from literal value
    const type = this.inferExpr(decl.value)
    const value = this.evalComptimeExpr(decl.value)
    if (!value) {
      this.error(decl.span.start, `def value must be a compile-time constant`)
      this.moduleScope.symbols.set(decl.ident, { kind: 'def', type, value: { kind: 'int', value: 0n } })
    } else {
      this.moduleScope.symbols.set(decl.ident, { kind: 'def', type, value })
    }
    this.recordDefinition(decl.ident, decl.span.start)
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
        this.inferExpr(stmt.value)
        break
      case 'WhileStmt':
        this.inferExpr(stmt.condition)
        this.checkBody(stmt.body)
        break
      case 'LoopStmt':
        this.checkBody(stmt.body)
        break
      case 'ForStmt':
        this.inferExpr(stmt.iterable)
        this.checkBody(stmt.body)
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
        this.checkExpr(stmt.value, type)
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
      case 'TuplePattern':
        // TODO: destructure tuple fields
        break
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
        // Default to ? (LEB128) encoding for each nesting level
        const defaultType = defaultIndexedType(type)
        if (defaultType) return defaultType
        // Fallback for empty list or heterogeneous types
        if (type.elements.length === 0) {
          return slice(primitive('i32'))
        }
        const elemType = this.unifyTypes(type.elements)
        return array(elemType, type.elements.length)
      }
      case 'indexed': {
        // Handle comptime indexed ([T]) - default to ? (LEB128)
        if (type.size === 'comptime') {
          const defaultType = defaultIndexedType(type)
          if (defaultType) return defaultType
        }
        return type
      }
      default:
        return type
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
        const specifiers: IndexSpecifierRT[] = type.specifiers.map((s) =>
          s.kind === 'null' ? { kind: 'null' } : { kind: 'prefix' },
        )
        // Handle 'inferred' size - will be filled in by bidirectional checking
        const size = type.size === 'inferred' ? null : type.size
        return indexed(element, size, specifiers)
      }

      case 'CompositeType': {
        const fields = type.fields.map((f) =>
          field(f.ident, this.resolveType(f.type)),
        )
        return tuple(fields)
      }

      case 'BuiltinType': {
        // str is a unique type (UTF-8 string), bytes is a structural alias for *[u8]
        const sliceU8 = pointer(indexed(primitive('u8')))
        if (type.name === 'str') {
          return named('str', sliceU8, true) // unique
        }
        return sliceU8 // bytes is just *[u8]
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
    this.types.set(typeKey(expr.span.start, expr.kind), type)
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
      // Check each element against the inner element type
      if (expr.kind === 'ArrayExpr') {
        // Determine what type to check each element against
        // For stacked specifiers like *[![!u8]], peel off one specifier level
        // so "hello" checks against *[!u8] (not just u8)
        const innerType = this.peelSpecifier(expected)
        for (const elem of expr.elements) {
          this.checkExpr(elem, innerType)
        }
      }
      // Resolve to concrete indexed type based on expected
      const resolved = this.resolveListToIndexed(inferred, expected)
      // For LSP, record the comptime_list type (not resolved) so user sees the literal type
      if (expr.kind === 'ArrayExpr') {
        this.types.set(typeKey(expr.span.start, expr.kind), inferred)
      }
      // Collect literal for deferred serialization (concrete types only)
      if (expected.size !== 'comptime') {
        this.pendingLiterals.push({ id: expr.span.start, expr, type: expected })
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
      if (expr.kind === 'ArrayExpr') {
        // Peel specifiers to get the element type for checking
        // e.g., *[![!u8]] -> *[!u8] for first level, *[!u8] -> u8 for second level
        const innerType = this.peelSpecifier(expected)
        for (const elem of expr.elements) {
          this.checkExpr(elem, innerType)
        }
      }
      // Record the inferred comptime type
      this.types.set(typeKey(expr.span.start, expr.kind), inferred)
      // Collect literal for deferred serialization
      this.pendingLiterals.push({ id: expr.span.start, expr, type: expected })
      // Return concretized type
      return this.concretizeToTarget(inferred, expected)
    }

    // For other types, check assignability and record the inferred type
    if (!typeAssignable(expected, inferred)) {
      this.error(
        expr.span.start,
        `${prefix}cannot assign ${typeToString(inferred)} to ${typeToString(expected)}`,
      )
    }

    // Record the type - use named type if available for better LSP hints
    const recordType = expected.kind === 'named' ? expected : inferred
    this.types.set(typeKey(expr.span.start, expr.kind), recordType)

    // For return value, concretize based on expected type
    return this.concretizeToTarget(inferred, expected)
  }

  // Peel off one specifier level from an indexed type to get the inner element type
  // *[![!u8]] -> *[!u8] (peel first !, remaining is !)
  // *[!u8] -> u8 (peel !, no remaining specifiers = element type)
  // *[*[u8]] -> *[u8] (element is already an indexed type)
  peelSpecifier(t: { kind: 'indexed'; element: ResolvedType; size: number | null; specifiers: IndexSpecifierRT[] }): ResolvedType {
    // If element is already an indexed type (separate brackets), use it directly
    if (t.element.kind === 'indexed') {
      return t.element
    }
    // If we have stacked specifiers, peel one off
    if (t.specifiers.length > 1) {
      return indexed(t.element, null, t.specifiers.slice(1))
    }
    // If we have exactly one specifier, the inner type is just the element with that specifier
    if (t.specifiers.length === 1) {
      return indexed(t.element, null, t.specifiers)
    }
    // No specifiers (plain slice/array) - inner type is just the element
    return t.element
  }

  // Resolve a comptime_list to a concrete indexed type based on expected type
  resolveListToIndexed(list: { kind: 'comptime_list'; elements: ResolvedType[] }, expected: { kind: 'indexed'; element: ResolvedType; size: number | null; specifiers: IndexSpecifierRT[] }): ResolvedType {
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

      case 'GroupExpr':
        return this.inferExpr(expr.expr)

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
        const annotationType = this.resolveType(expr.type)
        this.checkExpr(expr.expr, annotationType)
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
        // String literals are comptime indexed [u8] types
        // They coerce to *[N]u8, []u8, [*:0]u8, etc. based on context
        return comptimeIndexed(primitive('u8'))
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

    switch (expr.member.kind) {
      case 'field': {
        // Look up field in tuple/struct
        if (objType.kind === 'tuple') {
          const f = objType.fields.find((f) => f.name === expr.member.name)
          if (f) return f.type
        }
        // Indexed type built-in fields (slice/array)
        if (objType.kind === 'indexed') {
          if (expr.member.name === 'ptr') return pointer(objType.element)
          if (expr.member.name === 'len') return primitive('u32')
        }
        this.error(expr.span.start, `no field '${expr.member.name}' on type ${typeToString(objType)}`)
        return primitive('i32')
      }

      case 'index': {
        // Tuple index access: t.0, t.1
        if (objType.kind === 'tuple') {
          const idx = expr.member.value
          if (idx >= 0 && idx < objType.fields.length) {
            return objType.fields[idx].type
          }
        }
        this.error(expr.span.start, `invalid tuple index`)
        return primitive('i32')
      }

      case 'deref': {
        // Pointer dereference: p.*
        if (objType.kind === 'pointer') {
          return objType.pointee
        }
        this.error(expr.span.start, `cannot dereference non-pointer`)
        return primitive('i32')
      }

      case 'type': {
        // Type pun: p.u32
        return this.resolveType(expr.member.type)
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
