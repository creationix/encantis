// Meta.json builder for Encantis
// Produces LSP-compatible metadata: types, symbols, hints

import type * as AST from './ast'
import { check, type TypeCheckResult, type Symbol } from './checker'
import { type ResolvedType, typeToString } from './types'
import { LineMap } from './position'
import { extractComments, findDocComment, type Comment } from './comments'

// === Meta Output Types ===

export interface MetaOutput {
  $schema?: string
  src: string
  data: MetaData[]
  types: MetaType[]
  symbols: MetaSymbol[]
  hints: Record<string, MetaHint>
  errors?: MetaError[]
}

export interface MetaData {
  offset: number
  hex: string
}

export interface MetaType {
  type: string
  symbol?: number // Index into symbols array if this type is named
}

export interface MetaSymbol {
  name: string
  kind: 'func' | 'type' | 'unique' | 'global' | 'local' | 'param' | 'def'
  type: number // Index into types array
  def: string // "line:col" (0-indexed)
  refs: string[] // ["line:col", ...]
  doc?: string
}

export interface MetaHint {
  len: number
  type: number // Index into types array
  symbol?: number // Index into symbols array
  data?: number // Index into data array
}

export interface MetaError {
  pos: string // "line:col"
  message: string
}

// === Main Entry Point ===

export function buildMeta(
  module: AST.Module,
  source: string,
  options?: { srcPath?: string },
): MetaOutput {
  const lineMap = new LineMap(source)
  const comments = extractComments(source)
  const checkResult = check(module)

  const builder = new MetaBuilder(module, source, lineMap, comments, checkResult)
  return builder.build(options?.srcPath ?? 'file://./source.ents')
}

// === Meta Builder ===

class MetaBuilder {
  private typeRegistry = new TypeRegistry()
  private symbols: MetaSymbol[] = []
  private symbolIndexByName = new Map<string, number>()
  private hints: Record<string, MetaHint> = {}
  private data: MetaData[] = []

  constructor(
    private module: AST.Module,
    private source: string,
    private lineMap: LineMap,
    private comments: Comment[],
    private checkResult: TypeCheckResult,
  ) {}

  build(srcPath: string): MetaOutput {
    // Pass 1: Collect symbols (populates typeRegistry)
    this.collectSymbols()

    // Pass 2: Generate hints
    this.generateHints()

    // Build output
    const output: MetaOutput = {
      src: srcPath,
      data: this.data,
      types: this.typeRegistry.getTypes(),
      symbols: this.symbols,
      hints: this.hints,
    }

    // Add errors if any
    if (this.checkResult.errors.length > 0) {
      output.errors = this.checkResult.errors.map((e) => ({
        pos: this.lineMap.positionKey(e.offset),
        message: e.message,
      }))
    }

    return output
  }

  // === Symbol Collection ===

  private collectSymbols(): void {
    for (const decl of this.module.decls) {
      this.collectDeclaration(decl)
    }
  }

  private collectDeclaration(decl: AST.Declaration): void {
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
        // Memory declarations handled separately
        break
    }
  }

  private collectImport(decl: AST.ImportDecl): void {
    for (const item of decl.items) {
      if (item.item.kind === 'ImportFunc') {
        const name = item.item.ident ?? item.name
        const sym = this.checkResult.symbols.get(name)
        if (sym && sym.kind === 'func') {
          // Find the position of the function name in the import
          const offset = this.findImportFuncOffset(item, name)
          this.addSymbol(name, 'func', sym.type, offset)
        }
      }
    }
  }

  private findImportFuncOffset(item: AST.ImportItem, name: string): number {
    // If ident is specified, use its position in the ImportFunc
    // Otherwise, the name comes from item.name
    if (item.item.kind === 'ImportFunc' && item.item.ident) {
      // Search for the ident after "func" keyword
      const funcStart = item.item.span.start
      const searchText = this.source.slice(funcStart, item.item.span.end)
      const funcIdx = searchText.indexOf('func')
      if (funcIdx !== -1) {
        const afterFunc = funcStart + funcIdx + 4
        const identIdx = this.source.indexOf(item.item.ident, afterFunc)
        if (identIdx !== -1) return identIdx
      }
    }
    // Fallback to item span start
    return item.span.start
  }

  private collectExport(decl: AST.ExportDecl): void {
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

  private collectFunc(decl: AST.FuncDecl): void {
    if (decl.ident) {
      const sym = this.checkResult.symbols.get(decl.ident)
      if (!sym || sym.kind !== 'func') return

      // Find the function name offset (after "func" keyword)
      const offset = this.findFuncIdentOffset(decl)
      const symbolIndex = this.addSymbol(decl.ident, 'func', sym.type, offset)

      // Collect params and locals
      this.collectFuncBody(decl, symbolIndex)
    } else {
      // Anonymous function - still collect locals from body
      this.collectFuncBody(decl, -1)
    }
  }

  private findFuncIdentOffset(decl: AST.FuncDecl): number {
    if (!decl.ident) return decl.span.start
    // Search for "func" then find the identifier
    const searchStart = decl.span.start
    const funcText = this.source.slice(searchStart, decl.signature.span.start)
    const funcIdx = funcText.indexOf('func')
    if (funcIdx !== -1) {
      const afterFunc = searchStart + funcIdx + 4
      // Skip whitespace
      let i = afterFunc
      while (i < this.source.length && /\s/.test(this.source[i])) i++
      return i
    }
    return decl.span.start
  }

  private collectFuncBody(decl: AST.FuncDecl, _funcSymbolIndex: number): void {
    // Collect parameters
    if (decl.signature.params.kind === 'FieldList') {
      for (const param of decl.signature.params.fields) {
        if (param.ident) {
          const type = this.checkResult.types.get(param.span.start)
          if (type) {
            this.addSymbol(param.ident, 'param', type, param.span.start)
          }
        }
      }
    }

    // Collect locals from body
    if (decl.body.kind === 'Block') {
      this.collectLocalsFromBlock(decl.body)
    }
  }

  private collectLocalsFromBlock(block: AST.Block): void {
    for (const stmt of block.stmts) {
      if (stmt.kind === 'LetStmt') {
        this.collectLocal(stmt.pattern)
      }
      // Recurse into nested blocks
      if (stmt.kind === 'WhileStmt' && stmt.body.kind === 'Block') {
        this.collectLocalsFromBlock(stmt.body)
      }
      if (stmt.kind === 'LoopStmt' && stmt.body.kind === 'Block') {
        this.collectLocalsFromBlock(stmt.body)
      }
      if (stmt.kind === 'ForStmt' && stmt.body.kind === 'Block') {
        this.collectLocalsFromBlock(stmt.body)
      }
    }
  }

  private collectLocal(pattern: AST.Pattern): void {
    if (pattern.kind === 'IdentPattern') {
      const type = this.checkResult.types.get(pattern.span.start)
      if (type) {
        this.addSymbol(pattern.name, 'local', type, pattern.span.start)
      }
    }
    // TODO: Handle TuplePattern
  }

  private collectTypeDecl(decl: AST.TypeDecl): void {
    const sym = this.checkResult.symbols.get(decl.ident.name)
    if (!sym || sym.kind !== 'type') return

    const symbolIndex = this.addSymbol(
      decl.ident.name,
      'type',
      sym.type,
      decl.ident.span.start,
    )

    // Register the type with symbol reference
    this.typeRegistry.registerWithSymbol(sym.type, symbolIndex)
  }

  private collectUniqueDecl(decl: AST.UniqueDecl): void {
    const sym = this.checkResult.symbols.get(decl.ident.name)
    if (!sym || sym.kind !== 'type') return

    const symbolIndex = this.addSymbol(
      decl.ident.name,
      'unique',
      sym.type,
      decl.ident.span.start,
    )

    // Register the type with symbol reference
    this.typeRegistry.registerWithSymbol(sym.type, symbolIndex)
  }

  private collectDef(decl: AST.DefDecl): void {
    const sym = this.checkResult.symbols.get(decl.ident)
    if (!sym || sym.kind !== 'def') return

    // Find the def name offset (after "def" keyword)
    const offset = this.findDefIdentOffset(decl)
    this.addSymbol(decl.ident, 'def', sym.type, offset)
  }

  private findDefIdentOffset(decl: AST.DefDecl): number {
    const searchText = this.source.slice(decl.span.start, decl.span.end)
    const defIdx = searchText.indexOf('def')
    if (defIdx !== -1) {
      const afterDef = decl.span.start + defIdx + 3
      let i = afterDef
      while (i < this.source.length && /\s/.test(this.source[i])) i++
      return i
    }
    return decl.span.start
  }

  private collectGlobal(decl: AST.GlobalDecl): void {
    const sym = this.checkResult.symbols.get(decl.ident)
    if (!sym || sym.kind !== 'global') return

    // Find the global name offset
    const offset = this.findGlobalIdentOffset(decl)
    this.addSymbol(decl.ident, 'global', sym.type, offset)
  }

  private findGlobalIdentOffset(decl: AST.GlobalDecl): number {
    const searchText = this.source.slice(decl.span.start, decl.span.end)
    const globalIdx = searchText.indexOf('global')
    if (globalIdx !== -1) {
      const afterGlobal = decl.span.start + globalIdx + 6
      let i = afterGlobal
      while (i < this.source.length && /\s/.test(this.source[i])) i++
      return i
    }
    return decl.span.start
  }

  private addSymbol(
    name: string,
    kind: MetaSymbol['kind'],
    type: ResolvedType,
    offset: number,
  ): number {
    const typeIndex = this.typeRegistry.register(type)
    const defPos = this.lineMap.positionKey(offset)

    // Get doc comment - only for module-level declarations
    let doc: string | null = null
    if (kind === 'func' || kind === 'type' || kind === 'unique' || kind === 'global' || kind === 'def') {
      const declLine = this.lineMap.offsetToPosition(offset).line
      doc = findDocComment(this.comments, declLine)
    }

    // Get references - use checker's recorded definition offset, not the display offset
    const checkerDefOffset = this.checkResult.symbolDefOffsets.get(name)
    const refs = checkerDefOffset !== undefined
      ? this.checkResult.references.get(checkerDefOffset) ?? []
      : []
    const refPositions = refs.map((r) => this.lineMap.positionKey(r))

    const symbol: MetaSymbol = {
      name,
      kind,
      type: typeIndex,
      def: defPos,
      refs: refPositions,
    }
    if (doc) symbol.doc = doc

    const index = this.symbols.length
    this.symbols.push(symbol)
    this.symbolIndexByName.set(name, index)

    return index
  }

  // === Hints Generation ===

  private generateHints(): void {
    for (const decl of this.module.decls) {
      this.generateHintsForDecl(decl)
    }
  }

  private generateHintsForDecl(decl: AST.Declaration): void {
    switch (decl.kind) {
      case 'ImportDecl':
        this.generateHintsForImport(decl)
        break
      case 'ExportDecl':
        if (decl.item.kind === 'FuncDecl') {
          this.generateHintsForFunc(decl.item)
        }
        break
      case 'FuncDecl':
        this.generateHintsForFunc(decl)
        break
      case 'TypeDecl':
        this.generateHintsForTypeDecl(decl)
        break
      case 'UniqueDecl':
        this.generateHintsForUniqueDecl(decl)
        break
      case 'DefDecl':
        this.generateHintsForDef(decl)
        break
      case 'GlobalDecl':
        this.generateHintsForGlobal(decl)
        break
    }
  }

  private generateHintsForImport(decl: AST.ImportDecl): void {
    for (const item of decl.items) {
      if (item.item.kind === 'ImportFunc') {
        const name = item.item.ident ?? item.name
        const symbolIndex = this.symbolIndexByName.get(name)
        if (symbolIndex !== undefined) {
          const offset = this.findImportFuncOffset(item, name)
          this.addHint(offset, name.length, this.symbols[symbolIndex].type, symbolIndex)
        }
      }
    }
  }

  private generateHintsForFunc(decl: AST.FuncDecl): void {
    // Handle named functions
    if (decl.ident) {
      const symbolIndex = this.symbolIndexByName.get(decl.ident)
      if (symbolIndex !== undefined) {
        // Hint for function name
        const offset = this.findFuncIdentOffset(decl)
        this.addHint(offset, decl.ident.length, this.symbols[symbolIndex].type, symbolIndex)
      }

      // Hints for parameters
      if (decl.signature.params.kind === 'FieldList') {
        for (const param of decl.signature.params.fields) {
          if (param.ident) {
            const paramSymbolIndex = this.symbolIndexByName.get(param.ident)
            if (paramSymbolIndex !== undefined) {
              this.addHint(
                param.span.start,
                param.ident.length,
                this.symbols[paramSymbolIndex].type,
                paramSymbolIndex,
              )
            }
          }
        }
      }
    }

    // Hints for body (process even for anonymous functions)
    if (decl.body.kind === 'Block') {
      this.generateHintsForBlock(decl.body)
    } else {
      this.generateHintsForExpr(decl.body.expr)
    }
  }

  private generateHintsForBlock(block: AST.Block): void {
    for (const stmt of block.stmts) {
      this.generateHintsForStmt(stmt)
    }
  }

  private generateHintsForStmt(stmt: AST.Statement): void {
    switch (stmt.kind) {
      case 'LetStmt':
        this.generateHintsForPattern(stmt.pattern)
        if (stmt.type) this.generateHintsForTypeExpr(stmt.type)
        if (stmt.value) this.generateHintsForExpr(stmt.value)
        break
      case 'SetStmt':
        if (stmt.type) this.generateHintsForTypeExpr(stmt.type)
        this.generateHintsForExpr(stmt.value)
        break
      case 'ExpressionStmt':
        this.generateHintsForExpr(stmt.expr)
        break
      case 'ReturnStmt':
        if (stmt.value) this.generateHintsForExpr(stmt.value)
        if (stmt.when) this.generateHintsForExpr(stmt.when)
        break
      case 'AssignmentStmt':
        this.generateHintsForExpr(stmt.value)
        break
      case 'WhileStmt':
        this.generateHintsForExpr(stmt.condition)
        if (stmt.body.kind === 'Block') this.generateHintsForBlock(stmt.body)
        break
      case 'LoopStmt':
        if (stmt.body.kind === 'Block') this.generateHintsForBlock(stmt.body)
        break
      case 'ForStmt':
        this.generateHintsForExpr(stmt.iterable)
        if (stmt.body.kind === 'Block') this.generateHintsForBlock(stmt.body)
        break
      case 'BreakStmt':
      case 'ContinueStmt':
        if (stmt.when) this.generateHintsForExpr(stmt.when)
        break
    }
  }

  private generateHintsForPattern(pattern: AST.Pattern): void {
    if (pattern.kind === 'IdentPattern') {
      const symbolIndex = this.symbolIndexByName.get(pattern.name)
      if (symbolIndex !== undefined) {
        this.addHint(
          pattern.span.start,
          pattern.name.length,
          this.symbols[symbolIndex].type,
          symbolIndex,
        )
      }
    }
    // TODO: Handle TuplePattern
  }

  private generateHintsForExpr(expr: AST.Expr): void {
    const type = this.checkResult.types.get(expr.span.start)

    switch (expr.kind) {
      case 'IdentExpr': {
        const symbolIndex = this.symbolIndexByName.get(expr.name)
        if (type) {
          const typeIndex = this.typeRegistry.register(type)
          this.addHint(expr.span.start, expr.name.length, typeIndex, symbolIndex)
        }
        break
      }

      case 'LiteralExpr': {
        if (type) {
          const typeIndex = this.typeRegistry.register(type)
          const len = this.lineMap.spanLength(expr.span.start, expr.span.end)
          this.addHint(expr.span.start, len, typeIndex)
        }
        break
      }

      case 'CallExpr':
        this.generateHintsForExpr(expr.callee)
        for (const arg of expr.args) {
          if (arg.value) this.generateHintsForExpr(arg.value)
        }
        break

      case 'BinaryExpr':
        this.generateHintsForExpr(expr.left)
        this.generateHintsForExpr(expr.right)
        break

      case 'UnaryExpr':
        this.generateHintsForExpr(expr.operand)
        break

      case 'MemberExpr':
        this.generateHintsForExpr(expr.object)
        break

      case 'IndexExpr':
        this.generateHintsForExpr(expr.object)
        this.generateHintsForExpr(expr.index)
        break

      case 'TupleExpr':
        for (const elem of expr.elements) {
          if (elem.value) this.generateHintsForExpr(elem.value)
        }
        break

      case 'ArrayExpr': {
        // Record hint for the array literal itself (comptime_list type)
        if (type) {
          const typeIndex = this.typeRegistry.register(type)
          const len = this.lineMap.spanLength(expr.span.start, expr.span.end)
          this.addHint(expr.span.start, len, typeIndex)
        }
        // Recurse into elements
        for (const elem of expr.elements) {
          this.generateHintsForExpr(elem)
        }
        break
      }

      case 'GroupExpr':
        this.generateHintsForExpr(expr.expr)
        break

      case 'IfExpr':
        this.generateHintsForExpr(expr.condition)
        if (expr.thenBranch.kind === 'Block') {
          this.generateHintsForBlock(expr.thenBranch)
        }
        for (const elif of expr.elifs) {
          this.generateHintsForExpr(elif.condition)
          if (elif.thenBranch.kind === 'Block') {
            this.generateHintsForBlock(elif.thenBranch)
          }
        }
        if (expr.else_?.kind === 'Block') {
          this.generateHintsForBlock(expr.else_)
        }
        break

      case 'MatchExpr':
        this.generateHintsForExpr(expr.subject)
        for (const arm of expr.arms) {
          if (arm.body.kind === 'Block') {
            this.generateHintsForBlock(arm.body)
          } else if (arm.body.kind === 'ArrowBody') {
            this.generateHintsForExpr(arm.body.expr)
          } else {
            this.generateHintsForExpr(arm.body)
          }
        }
        break

      case 'CastExpr':
        this.generateHintsForExpr(expr.expr)
        this.generateHintsForTypeExpr(expr.type)
        break

      case 'AnnotationExpr':
        this.generateHintsForExpr(expr.expr)
        this.generateHintsForTypeExpr(expr.type)
        break
    }
  }

  private generateHintsForTypeExpr(type: AST.Type): void {
    if (type.kind === 'TypeRef') {
      const symbolIndex = this.symbolIndexByName.get(type.name)
      if (symbolIndex !== undefined) {
        this.addHint(
          type.span.start,
          type.name.length,
          this.symbols[symbolIndex].type,
          symbolIndex,
        )
      }
    }
    // Recurse into compound types
    if (type.kind === 'PointerType') {
      this.generateHintsForTypeExpr(type.pointee)
    }
    if (type.kind === 'IndexedType') {
      this.generateHintsForTypeExpr(type.element)
    }
    if (type.kind === 'CompositeType') {
      for (const field of type.fields) {
        this.generateHintsForTypeExpr(field.type)
      }
    }
  }

  private generateHintsForTypeDecl(decl: AST.TypeDecl): void {
    const symbolIndex = this.symbolIndexByName.get(decl.ident.name)
    if (symbolIndex !== undefined) {
      this.addHint(
        decl.ident.span.start,
        decl.ident.name.length,
        this.symbols[symbolIndex].type,
        symbolIndex,
      )
    }
  }

  private generateHintsForUniqueDecl(decl: AST.UniqueDecl): void {
    const symbolIndex = this.symbolIndexByName.get(decl.ident.name)
    if (symbolIndex !== undefined) {
      this.addHint(
        decl.ident.span.start,
        decl.ident.name.length,
        this.symbols[symbolIndex].type,
        symbolIndex,
      )
    }
  }

  private generateHintsForDef(decl: AST.DefDecl): void {
    const symbolIndex = this.symbolIndexByName.get(decl.ident)
    if (symbolIndex !== undefined) {
      const offset = this.findDefIdentOffset(decl)
      this.addHint(offset, decl.ident.length, this.symbols[symbolIndex].type, symbolIndex)
    }
    this.generateHintsForExpr(decl.value)
  }

  private generateHintsForGlobal(decl: AST.GlobalDecl): void {
    const symbolIndex = this.symbolIndexByName.get(decl.ident)
    if (symbolIndex !== undefined) {
      const offset = this.findGlobalIdentOffset(decl)
      this.addHint(offset, decl.ident.length, this.symbols[symbolIndex].type, symbolIndex)
    }
    if (decl.type) this.generateHintsForTypeExpr(decl.type)
    if (decl.value) this.generateHintsForExpr(decl.value)
  }

  private addHint(
    offset: number,
    len: number,
    typeIndex: number,
    symbolIndex?: number,
    dataIndex?: number,
  ): void {
    const key = this.lineMap.positionKey(offset)
    const hint: MetaHint = { len, type: typeIndex }
    if (symbolIndex !== undefined) hint.symbol = symbolIndex
    if (dataIndex !== undefined) hint.data = dataIndex
    this.hints[key] = hint
  }
}

// === Type Registry ===

class TypeRegistry {
  private types: MetaType[] = []
  private typeIndex = new Map<string, number>()

  register(type: ResolvedType): number {
    // For named types (type aliases/uniques), register the underlying type
    // which already has the symbol reference from collectTypeDecl/collectUniqueDecl
    if (type.kind === 'named') {
      return this.register(type.type)
    }

    const key = metaTypeString(type)
    const existing = this.typeIndex.get(key)
    if (existing !== undefined) return existing

    const index = this.types.length
    this.types.push({ type: key })
    this.typeIndex.set(key, index)
    return index
  }

  registerWithSymbol(type: ResolvedType, symbolIndex: number): number {
    const key = metaTypeString(type)
    const existing = this.typeIndex.get(key)
    if (existing !== undefined) {
      // Update existing entry with symbol reference
      this.types[existing].symbol = symbolIndex
      return existing
    }

    const index = this.types.length
    this.types.push({ type: key, symbol: symbolIndex })
    this.typeIndex.set(key, index)
    return index
  }

  getTypes(): MetaType[] {
    return this.types
  }
}

// === Type String Formatting (meta-specific) ===

function metaTypeString(t: ResolvedType): string {
  switch (t.kind) {
    case 'primitive':
      return t.name

    case 'pointer':
      return `*${metaTypeString(t.pointee)}`

    case 'indexed': {
      const elem = metaTypeString(t.element)
      const specs = t.specifiers
        .map((s) => (s.kind === 'null' ? '/0' : `/${s.prefixType}`))
        .join('')
      if (t.size === 'comptime') {
        // Comptime list: T[]
        return `${elem}[]`
      } else if (t.size === null) {
        // Slice (no specifiers) or serialized (with specifiers)
        if (specs) {
          return `${elem}[${specs}]`
        } else {
          return `${elem}[#]`
        }
      } else {
        // Fixed array: T[N] or T[N/0] etc.
        return `${elem}[${t.size}${specs}]`
      }
    }

    case 'tuple': {
      if (t.fields.length === 0) return '()'
      const fields = t.fields.map(metaFieldString).join(',')
      return `(${fields})`
    }

    case 'func': {
      // Meta format: (params)->returns (no spaces, no "func" prefix)
      const params =
        t.params.length === 0 ? '()' : `(${t.params.map(metaFieldString).join(',')})`
      if (t.returns.length === 0) return `${params}->()`
      const returns =
        t.returns.length === 1 && t.returns[0].name === null
          ? metaTypeString(t.returns[0].type)
          : `(${t.returns.map(metaFieldString).join(',')})`
      return `${params}->${returns}`
    }

    case 'void':
      return '()'

    case 'comptime_int':
      return `comptime_int(${t.value})`

    case 'comptime_float':
      return `comptime_float(${t.value})`

    case 'comptime_list':
      return `[${t.elements.map(metaTypeString).join(',')}]`

    case 'named':
      return t.name
  }
}

function metaFieldString(f: { name: string | null; type: ResolvedType }): string {
  if (f.name) {
    return `${f.name}:${metaTypeString(f.type)}`
  }
  return metaTypeString(f.type)
}
