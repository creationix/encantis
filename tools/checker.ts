// Type checker / inference pass for Encantis
// Produces a TypeMap keyed by AST node start offset

import type * as AST from './ast'
import {
  type ResolvedType,
  type ResolvedField,
  type PrimitiveName,
  primitive,
  pointer,
  slice,
  array,
  nullterm,
  tuple,
  func,
  field,
  VOID,
  comptimeInt,
  comptimeFloat,
  comptimeString,
  typeToString,
  comptimeIntFits,
} from './types'

// === Symbol Table ===

export type Symbol =
  | { kind: 'type'; type: ResolvedType; unique: boolean }
  | { kind: 'func'; type: ResolvedType & { kind: 'func' }; inline: boolean }
  | { kind: 'global'; type: ResolvedType }
  | { kind: 'def'; type: ResolvedType }
  | { kind: 'local'; type: ResolvedType }
  | { kind: 'param'; type: ResolvedType }
  | { kind: 'return'; type: ResolvedType }

export interface Scope {
  parent: Scope | null
  symbols: Map<string, Symbol>
}

// === Type Check Result ===

export interface TypeError {
  offset: number
  message: string
}

export interface TypeCheckResult {
  // Type map: start offset → resolved type
  types: Map<number, ResolvedType>
  // Symbol table (module scope)
  symbols: Map<string, Symbol>
  // Type errors
  errors: TypeError[]
}

// === Main Entry Point ===

export function check(module: AST.Module): TypeCheckResult {
  const ctx = new CheckContext()
  ctx.checkModule(module)
  return {
    types: ctx.types,
    symbols: ctx.moduleScope.symbols,
    errors: ctx.errors,
  }
}

// === Check Context ===

class CheckContext {
  types = new Map<number, ResolvedType>()
  errors: TypeError[] = []
  moduleScope: Scope = { parent: null, symbols: new Map() }
  currentScope: Scope = this.moduleScope

  // Cache for resolved type aliases
  typeCache = new Map<string, ResolvedType>()

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
      case 'UniqueDecl':
        this.collectUniqueDecl(decl)
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
  }

  collectTypeDecl(decl: AST.TypeDecl): void {
    const resolved = this.resolveType(decl.type)
    this.moduleScope.symbols.set(decl.ident, {
      kind: 'type',
      type: resolved,
      unique: false,
    })
    this.typeCache.set(decl.ident, resolved)
  }

  collectUniqueDecl(decl: AST.UniqueDecl): void {
    const resolved = this.resolveType(decl.type)
    this.moduleScope.symbols.set(decl.ident, {
      kind: 'type',
      type: resolved,
      unique: true,
    })
    this.typeCache.set(decl.ident, resolved)
  }

  collectDef(decl: AST.DefDecl): void {
    // Defs are comptime - infer type from literal value
    const type = this.inferExpr(decl.value)
    this.moduleScope.symbols.set(decl.ident, { kind: 'def', type })
  }

  collectGlobal(decl: AST.GlobalDecl): void {
    let type: ResolvedType
    if (decl.type) {
      type = this.resolveType(decl.type)
    } else if (decl.value) {
      type = this.inferExpr(decl.value)
    } else {
      this.error(decl.span.start, 'global needs type annotation or initializer')
      type = primitive('i32')
    }
    this.moduleScope.symbols.set(decl.ident, { kind: 'global', type })
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

    // Add parameters to scope
    if (decl.signature.params.kind === 'FieldList') {
      for (const param of decl.signature.params.fields) {
        if (param.ident) {
          const type = this.resolveType(param.type)
          funcScope.symbols.set(param.ident, { kind: 'param', type })
        }
      }
    }

    // Add named returns to scope
    if (decl.signature.returns) {
      if (decl.signature.returns.kind === 'FieldList') {
        for (const ret of decl.signature.returns.fields) {
          if (ret.ident) {
            const type = this.resolveType(ret.type)
            funcScope.symbols.set(ret.ident, { kind: 'return', type })
          }
        }
      }
    }

    // Check body
    const prevScope = this.currentScope
    this.currentScope = funcScope
    this.checkBody(decl.body)
    this.currentScope = prevScope
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
        this.inferExpr(stmt.value)
      }
    } else if (stmt.value) {
      const valueType = this.inferExpr(stmt.value)
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
        this.types.set(pattern.span.start, type)
        break
      case 'TuplePattern':
        // TODO: destructure tuple fields
        break
    }
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
      case 'comptime_string':
        // Default: u8[N/0] (null-terminated fixed array)
        return nullterm(primitive('u8'), type.bytes.length)
      default:
        return type
    }
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
        if (type.nullTerminated) {
          return nullterm(element, type.size)
        } else if (type.size !== null) {
          return array(element, type.size)
        } else {
          return slice(element)
        }
      }

      case 'CompositeType': {
        const fields = type.fields.map((f) =>
          field(f.ident, this.resolveType(f.type)),
        )
        return tuple(fields)
      }

      case 'TypeRef': {
        const cached = this.typeCache.get(type.name)
        if (cached) return cached
        const sym = this.moduleScope.symbols.get(type.name)
        if (sym && sym.kind === 'type') {
          this.typeCache.set(type.name, sym.type)
          return sym.type
        }
        this.error(type.span.start, `unknown type: ${type.name}`)
        return primitive('i32')
      }
    }
  }

  resolveSignature(sig: AST.FuncSignature): ResolvedType & { kind: 'func' } {
    const params = this.resolveValueSpec(sig.params)
    const returns = sig.returns ? this.resolveValueSpec(sig.returns) : []
    return func(params, returns)
  }

  resolveValueSpec(spec: AST.ValueSpec): ResolvedField[] {
    if (spec.kind === 'FieldList') {
      return spec.fields.map((f) => field(f.ident, this.resolveType(f.type)))
    }
    // Single type without name
    return [field(null, this.resolveType(spec))]
  }

  // === Expression Type Inference ===

  inferExpr(expr: AST.Expr): ResolvedType {
    const type = this.inferExprInner(expr)
    // Record type for LSP-relevant nodes
    if (this.isLSPRelevant(expr)) {
      this.types.set(expr.span.start, type)
    }
    return type
  }

  isLSPRelevant(expr: AST.Expr): boolean {
    return (
      expr.kind === 'IdentExpr' ||
      expr.kind === 'CallExpr' ||
      expr.kind === 'LiteralExpr'
    )
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

      case 'GroupExpr':
        return this.inferExpr(expr.expr)

      case 'IfExpr':
        return this.inferIf(expr)

      case 'MatchExpr':
        return this.inferMatch(expr)

      case 'CastExpr':
        this.inferExpr(expr.expr)
        return this.resolveType(expr.type)

      case 'AnnotationExpr':
        this.inferExpr(expr.expr)
        return this.resolveType(expr.type)
    }
  }

  inferLiteral(expr: AST.LiteralExpr): ResolvedType {
    switch (expr.value.kind) {
      case 'int':
        return comptimeInt(expr.value.value)

      case 'float':
        return comptimeFloat(expr.value.value)

      case 'string':
        return comptimeString(expr.value.bytes)

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

    // Infer types of arguments
    for (const arg of expr.args) {
      if (arg.value) {
        this.inferExpr(arg.value)
      }
    }

    if (calleeType.kind === 'func') {
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
    this.errors.push({ offset, message })
  }
}
