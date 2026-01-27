// Meta.json builder for Encantis
// Produces LSP-compatible metadata: types, symbols, hints

import type * as AST from './ast'
import { typecheck, typeKey, type TypeCheckResult, type Symbol } from './checker'
import { type ResolvedType, typeToString, byteSize, func, manyPointer, primitive, VOID } from './types'
import { LineMap } from './position'
import { extractComments, findDocComment, type Comment } from './comments'
import { buildDataSection, type DataRef } from './data-pack'

// === Builtin Function Signatures ===

const BUILTIN_SIGNATURES: Record<string, ResolvedType> = {
  memset: func(
    [
      { name: 'dest', type: manyPointer(primitive('u8')) },
      { name: 'value', type: primitive('u8') },
      { name: 'len', type: primitive('u32') },
    ],
    [],
  ),
  memcpy: func(
    [
      { name: 'dest', type: manyPointer(primitive('u8')) },
      { name: 'src', type: manyPointer(primitive('u8')) },
      { name: 'len', type: primitive('u32') },
    ],
    [],
  ),
}

// Build a simplified expression string for hover hints
// Complex sub-expressions are replaced with "..."
function simplifyExpr(expr: AST.Expr, source: string): string {
  switch (expr.kind) {
    case 'IdentExpr':
      return expr.name
    case 'LiteralExpr':
      // Show simple literals as-is
      if (expr.value.kind === 'int' || expr.value.kind === 'float' || expr.value.kind === 'bool') {
        return source.slice(expr.span.start, expr.span.end)
      }
      return '...'
    case 'MemberExpr': {
      const obj = simplifyExpr(expr.object, source)
      if (expr.member.kind === 'field') return `${obj}.${expr.member.name}`
      if (expr.member.kind === 'deref') return `${obj}.*`
      if (expr.member.kind === 'index') return `${obj}.${expr.member.value}`
      if (expr.member.kind === 'type') {
        // Get the type name from source
        const exprText = source.slice(expr.span.start, expr.span.end)
        const dotIdx = exprText.lastIndexOf('.')
        return dotIdx !== -1 ? `${obj}.${exprText.slice(dotIdx + 1)}` : `${obj}.?`
      }
      return `${obj}.?`
    }
    case 'IndexExpr': {
      const obj = simplifyExpr(expr.object, source)
      const idx = simplifyExpr(expr.index, source)
      // Only show index if it's simple (identifier or number)
      if (expr.index.kind === 'IdentExpr' ||
          (expr.index.kind === 'LiteralExpr' && (expr.index.value.kind === 'int' || expr.index.value.kind === 'float'))) {
        return `${obj}[${idx}]`
      }
      return `${obj}[...]`
    }
    case 'CallExpr': {
      const callee = simplifyExpr(expr.callee, source)
      return `${callee}(...)`
    }
    case 'UnaryExpr': {
      const operand = simplifyExpr(expr.operand, source)
      return `${expr.op}${operand}`
    }
    default:
      return '...'
  }
}

// === Meta Output Types ===

export interface MetaOutput {
  $schema?: string
  src: string
  types: MetaType[]
  symbols: MetaSymbol[]
  hints: Record<string, MetaHint>
  errors?: MetaError[]
}

export interface MetaType {
  type: string
  symbol?: number // Index into symbols array if this type is named
}

export interface MetaSymbol {
  name: string
  kind: 'func' | 'type' | 'unique' | 'global' | 'local' | 'param' | 'return' | 'def'
  type: number // Index into types array
  def: string // "line:col" (0-indexed)
  refs: string[] // ["line:col", ...]
  doc?: string
  value?: string // For def constants: the literal value
  inline?: boolean // For functions: whether it's an inline function
}

export interface MetaHint {
  len: number
  type: number // Index into types array
  symbol?: number // Index into symbols array
  value?: string // For compile-time constant expressions
  expr?: string // Full expression path (e.g., "hash_state.u64[0]")
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
  const checkResult = typecheck(module)

  const builder = new MetaBuilder(module, source, lineMap, comments, checkResult)
  return builder.build(options?.srcPath ?? 'file://./source.ents')
}

// === Meta Builder ===

class MetaBuilder {
  private typeRegistry = new TypeRegistry()
  private symbols: MetaSymbol[] = []
  private symbolIndexByName = new Map<string, number>()
  private hints: Record<string, MetaHint> = {}
  private literalRefs: Map<number, DataRef> = new Map()

  constructor(
    private module: AST.Module,
    private source: string,
    private lineMap: LineMap,
    private comments: Comment[],
    private checkResult: TypeCheckResult,
  ) {}

  build(srcPath: string): MetaOutput {
    // Build data section to get literal addresses for hover hints
    if (this.checkResult.literals.length > 0) {
      const { literalRefs } = buildDataSection(this.checkResult.literals)
      this.literalRefs = literalRefs
    }

    // Pass 1: Collect symbols (populates typeRegistry)
    this.collectSymbols()

    // Pass 2: Generate hints
    this.generateHints()

    // Build output
    const output: MetaOutput = {
      src: srcPath,
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
      case 'DefDecl':
        this.collectDef(decl)
        break
      case 'GlobalDecl':
        this.collectGlobal(decl)
        break
      case 'MemoryDecl':
        // Memory declarations just specify size, no symbols to collect
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
        // Memory declarations just specify size, no symbols to collect
        break
    }
  }

  private collectFunc(decl: AST.FuncDecl): void {
    if (decl.ident) {
      const sym = this.checkResult.symbols.get(decl.ident)
      if (!sym || sym.kind !== 'func') return

      // Find the function name offset (after "func" keyword)
      const offset = this.findFuncIdentOffset(decl)
      const symbolIndex = this.addSymbol(decl.ident, 'func', sym.type, offset, undefined, decl.inline)

      // Collect params and locals
      this.collectFuncBody(decl, symbolIndex)
    } else {
      // Anonymous function - still collect locals from body
      this.collectFuncBody(decl, -1)
    }
  }

  private findFuncIdentOffset(decl: AST.FuncDecl): number {
    if (!decl.ident) return decl.span.start
    return this.findKeywordIdentOffset(decl.span.start, decl.signature.span.start, 'func')
  }

  /** Find identifier offset after a keyword (e.g., 'func', 'def', 'global') */
  private findKeywordIdentOffset(start: number, end: number, keyword: string): number {
    const searchText = this.source.slice(start, end)
    const keywordIdx = searchText.indexOf(keyword)
    if (keywordIdx !== -1) {
      let i = start + keywordIdx + keyword.length
      while (i < this.source.length && /\s/.test(this.source[i])) i++
      return i
    }
    return start
  }

  private collectFuncBody(decl: AST.FuncDecl, _funcSymbolIndex: number): void {
    // Build set of return names to check for input/output aliasing
    const returnNames = new Set<string>()
    if (decl.signature.output.kind === 'CompositeType') {
      for (const ret of decl.signature.output.fields) {
        if (ret.ident) returnNames.add(ret.ident)
      }
    }

    // Collect parameters (only CompositeType has named fields)
    // Skip params that also appear in output - they'll be tagged as 'return'
    if (decl.signature.input.kind === 'CompositeType') {
      for (const param of decl.signature.input.fields) {
        if (param.ident && !returnNames.has(param.ident)) {
          const type = this.checkResult.types.get(typeKey(param.span.start, param.kind))
          if (type) {
            this.addSymbol(param.ident, 'param', type, param.span.start)
          }
        }
      }
    }

    // Collect named returns (only CompositeType has named fields)
    if (decl.signature.output.kind === 'CompositeType') {
      for (const ret of decl.signature.output.fields) {
        if (ret.ident) {
          const type = this.checkResult.types.get(typeKey(ret.span.start, ret.kind))
          if (type) {
            this.addSymbol(ret.ident, 'return', type, ret.span.start)
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
      // Collect for loop binding variables
      if (stmt.kind === 'ForStmt') {
        // The value binding (e.g., 'col' in 'for col in 0..4')
        const valueType = this.checkResult.types.get(typeKey(stmt.binding.span.start, stmt.binding.kind))
        if (valueType) {
          this.addSymbol(stmt.binding.value, 'local', valueType, stmt.binding.span.start)
        }
        // The optional index binding (e.g., 'i' in 'for i, col in items')
        if (stmt.binding.index) {
          // Index is always u32/usize - use same type lookup for now
          const indexType = this.checkResult.types.get(typeKey(stmt.binding.span.start, 'ForBindingIndex'))
          if (indexType) {
            this.addSymbol(stmt.binding.index, 'local', indexType, stmt.binding.span.start)
          }
        }
      }
      // Recurse into nested blocks (while, loop, for)
      if ('body' in stmt && stmt.body.kind === 'Block') {
        this.collectLocalsFromBlock(stmt.body)
      }
      // Recurse into if/match expressions (they're expressions, not statements)
      if (stmt.kind === 'ExpressionStmt') {
        this.collectLocalsFromExpr(stmt.expr)
      }
    }
  }

  private collectLocalsFromExpr(expr: AST.Expr): void {
    if (expr.kind === 'IfExpr') {
      if (expr.thenBranch.kind === 'Block') {
        this.collectLocalsFromBlock(expr.thenBranch)
      }
      for (const elif of expr.elifs) {
        if (elif.thenBranch.kind === 'Block') {
          this.collectLocalsFromBlock(elif.thenBranch)
        }
      }
      if (expr.else_?.kind === 'Block') {
        this.collectLocalsFromBlock(expr.else_)
      }
    } else if (expr.kind === 'MatchExpr') {
      for (const arm of expr.arms) {
        if (arm.body.kind === 'Block') {
          this.collectLocalsFromBlock(arm.body)
        }
      }
    }
  }

  private collectLocal(pattern: AST.Pattern): void {
    if (pattern.kind === 'IdentPattern') {
      const type = this.checkResult.types.get(typeKey(pattern.span.start, pattern.kind))
      if (type) {
        this.addSymbol(pattern.name, 'local', type, pattern.span.start)
      }
    }
    // TODO: Handle TuplePattern
  }

  private collectTypeDecl(decl: AST.TypeDecl): void {
    const sym = this.checkResult.symbols.get(decl.ident.name)
    if (!sym || sym.kind !== 'type') return

    // Types with @ prefix are unique/nominal, others are structural aliases
    const kind = decl.ident.name.startsWith('@') ? 'unique' : 'type'
    const symbolIndex = this.addSymbol(decl.ident.name, kind, sym.type, decl.ident.span.start)
    this.typeRegistry.registerWithSymbol(sym.type, symbolIndex)
  }

  private collectDef(decl: AST.DefDecl): void {
    const sym = this.checkResult.symbols.get(decl.ident)
    if (!sym || sym.kind !== 'def') return

    // Find the def name offset (after "def" keyword)
    const offset = this.findDefIdentOffset(decl)

    // Format the comptime value for display
    let valueStr: string | undefined
    if (sym.value.kind === 'int') {
      valueStr = sym.value.value.toString()
    } else if (sym.value.kind === 'float') {
      valueStr = sym.value.value.toString()
    } else if (sym.value.kind === 'bool') {
      valueStr = sym.value.value ? 'true' : 'false'
    } else if (sym.value.kind === 'data_ptr') {
      const ref = this.literalRefs.get(sym.value.id)
      if (ref) {
        valueStr = `0x${ref.ptr.toString(16)}`
      }
    }

    this.addSymbol(decl.ident, 'def', sym.type, offset, valueStr)
  }

  private findDefIdentOffset(decl: AST.DefDecl): number {
    return this.findKeywordIdentOffset(decl.span.start, decl.span.end, 'def')
  }

  private collectGlobal(decl: AST.GlobalDecl): void {
    const name = this.patternIdent(decl.pattern)
    if (!name) return

    const sym = this.checkResult.symbols.get(name)
    if (!sym || sym.kind !== 'global') return

    const offset = this.findGlobalIdentOffset(decl)
    this.addSymbol(name, 'global', sym.type, offset)
  }

  private findGlobalIdentOffset(decl: AST.GlobalDecl): number {
    return decl.pattern.span.start
  }

  private addSymbol(
    name: string,
    kind: MetaSymbol['kind'],
    type: ResolvedType,
    offset: number,
    value?: string,
    inline?: boolean,
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
    if (value) symbol.value = value
    if (inline) symbol.inline = true

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
        // MemoryDecl just specifies size, no hints needed
        break
      case 'FuncDecl':
        this.generateHintsForFunc(decl)
        break
      case 'TypeDecl':
        this.generateHintsForTypeDecl(decl)
        break
      case 'DefDecl':
        this.generateHintsForDef(decl)
        break
      case 'GlobalDecl':
        this.generateHintsForGlobal(decl)
        break
      case 'MemoryDecl':
        // Memory declarations just specify size, no hints needed
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

      // Hints for parameters (only CompositeType has named fields)
      if (decl.signature.input.kind === 'CompositeType') {
        for (const param of decl.signature.input.fields) {
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

      // Hints for named returns (only CompositeType has named fields)
      if (decl.signature.output.kind === 'CompositeType') {
        for (const ret of decl.signature.output.fields) {
          if (ret.ident) {
            const retSymbolIndex = this.symbolIndexByName.get(ret.ident)
            if (retSymbolIndex !== undefined) {
              this.addHint(
                ret.span.start,
                ret.ident.length,
                this.symbols[retSymbolIndex].type,
                retSymbolIndex,
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
        // LValue can be IdentExpr, MemberExpr, IndexExpr, or Pattern
        if (stmt.target.kind === 'IdentExpr' || stmt.target.kind === 'MemberExpr' || stmt.target.kind === 'IndexExpr') {
          this.generateHintsForExpr(stmt.target)
        }
        this.generateHintsForExpr(stmt.value)
        break
      case 'WhileStmt':
        this.generateHintsForExpr(stmt.condition)
        if (stmt.body.kind === 'Block') this.generateHintsForBlock(stmt.body)
        break
      case 'LoopStmt':
        if (stmt.body.kind === 'Block') this.generateHintsForBlock(stmt.body)
        break
      case 'ForStmt': {
        // Generate hint for the binding variable
        const bindingSymbolIndex = this.symbolIndexByName.get(stmt.binding.value)
        if (bindingSymbolIndex !== undefined) {
          this.addHint(
            stmt.binding.span.start,
            stmt.binding.value.length,
            this.symbols[bindingSymbolIndex].type,
            bindingSymbolIndex,
          )
        }
        this.generateHintsForExpr(stmt.iterable)
        if (stmt.body.kind === 'Block') this.generateHintsForBlock(stmt.body)
        break
      }
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
    // MemberExpr uses span.end as key to distinguish chained accesses (a.b vs a.b.c)
    const typeOffset = expr.kind === 'MemberExpr' ? expr.span.end : expr.span.start
    const type = this.checkResult.types.get(typeKey(typeOffset, expr.kind))

    switch (expr.kind) {
      case 'IdentExpr': {
        const symbolIndex = this.symbolIndexByName.get(expr.name)
        // Check for builtin functions when no symbol is found
        const effectiveType = type ?? BUILTIN_SIGNATURES[expr.name]
        if (effectiveType) {
          const typeIndex = this.typeRegistry.register(effectiveType)
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
        // Add hint for the member access itself
        if (type && expr.member.kind === 'field') {
          const typeIndex = this.typeRegistry.register(type)
          // Find member name position by searching for ".name" in the expression span
          const exprText = this.source.slice(expr.span.start, expr.span.end)
          const dotIdx = exprText.lastIndexOf('.' + expr.member.name)
          if (dotIdx !== -1) {
            const memberOffset = expr.span.start + dotIdx + 1 // +1 to skip the dot
            // Compute compile-time value for .len and .wid on indexed types
            let comptimeValue: string | undefined
            const objTypeOffset = expr.object.kind === 'MemberExpr' ? expr.object.span.end : expr.object.span.start
            const objType = this.checkResult.types.get(typeKey(objTypeOffset, expr.object.kind))
            if (objType) {
              // Get the indexed type (either directly or through pointer)
              const indexedType = objType.kind === 'indexed' ? objType
                : (objType.kind === 'pointer' && objType.pointee.kind === 'indexed') ? objType.pointee
                : null
              if (indexedType && indexedType.kind === 'indexed') {
                if (expr.member.name === 'len' && typeof indexedType.size === 'number') {
                  comptimeValue = String(indexedType.size)
                } else if (expr.member.name === 'wid') {
                  const elemSize = byteSize(indexedType.element)
                  if (elemSize !== null) {
                    comptimeValue = String(elemSize)
                  }
                }
              }
            }
            // Use simplified expression for cleaner hover display
            const simplifiedExpr = simplifyExpr(expr, this.source)
            this.addHint(memberOffset, expr.member.name.length, typeIndex, undefined, comptimeValue, simplifiedExpr)
          }
        }
        // Handle deref: .* - show full expression context
        if (type && expr.member.kind === 'deref') {
          const typeIndex = this.typeRegistry.register(type)
          const exprText = this.source.slice(expr.span.start, expr.span.end)
          const dotStarIdx = exprText.lastIndexOf('.*')
          if (dotStarIdx !== -1) {
            const memberOffset = expr.span.start + dotStarIdx + 1 // position of *
            const simplifiedExpr = simplifyExpr(expr, this.source)
            this.addHint(memberOffset, 1, typeIndex, undefined, undefined, simplifiedExpr)
          }
        }
        // Handle type punning: .u8, .u32, etc. - show the resolved type after punning
        if (type && expr.member.kind === 'type') {
          const typeIndex = this.typeRegistry.register(type)
          const exprText = this.source.slice(expr.span.start, expr.span.end)
          const dotIdx = exprText.lastIndexOf('.')
          if (dotIdx !== -1) {
            const memberOffset = expr.span.start + dotIdx + 1 // +1 to skip the dot
            const typeName = exprText.slice(dotIdx + 1)
            const simplifiedExpr = simplifyExpr(expr, this.source)
            this.addHint(memberOffset, typeName.length, typeIndex, undefined, undefined, simplifiedExpr)
          }
        }
        break

      case 'IndexExpr': {
        this.generateHintsForExpr(expr.object)
        this.generateHintsForExpr(expr.index)
        // Add hints for the brackets showing the element type (result of indexing)
        if (type) {
          const typeIndex = this.typeRegistry.register(type)
          const exprText = this.source.slice(expr.span.start, expr.span.end)
          const openBracketIdx = exprText.indexOf('[')
          const closeBracketIdx = exprText.lastIndexOf(']')
          // Use simplified expression for cleaner hover display
          const simplifiedExpr = simplifyExpr(expr, this.source)
          if (openBracketIdx !== -1) {
            this.addHint(expr.span.start + openBracketIdx, 1, typeIndex, undefined, undefined, simplifiedExpr)
          }
          if (closeBracketIdx !== -1) {
            this.addHint(expr.span.start + closeBracketIdx, 1, typeIndex, undefined, undefined, simplifiedExpr)
          }
        }
        break
      }

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

  private generateHintsForDef(decl: AST.DefDecl): void {
    const symbolIndex = this.symbolIndexByName.get(decl.ident)
    if (symbolIndex !== undefined) {
      const offset = this.findDefIdentOffset(decl)
      this.addHint(offset, decl.ident.length, this.symbols[symbolIndex].type, symbolIndex)
    }
    this.generateHintsForExpr(decl.value)
  }

  private generateHintsForGlobal(decl: AST.GlobalDecl): void {
    const name = this.patternIdent(decl.pattern)
    if (name) {
      const symbolIndex = this.symbolIndexByName.get(name)
      if (symbolIndex !== undefined) {
        const offset = this.findGlobalIdentOffset(decl)
        this.addHint(offset, name.length, this.symbols[symbolIndex].type, symbolIndex)
      }
    }
    if (decl.type) this.generateHintsForTypeExpr(decl.type)
    if (decl.value) this.generateHintsForExpr(decl.value)
  }

  private patternIdent(pattern: AST.Pattern): string | null {
    if (pattern.kind === 'IdentPattern') return pattern.name
    return null
  }

  private addHint(
    offset: number,
    len: number,
    typeIndex: number,
    symbolIndex?: number,
    value?: string,
    expr?: string,
  ): void {
    const key = this.lineMap.positionKey(offset)
    const hint: MetaHint = { len, type: typeIndex }
    if (symbolIndex !== undefined) hint.symbol = symbolIndex
    if (value !== undefined) hint.value = value
    if (expr !== undefined) hint.expr = expr
    this.hints[key] = hint
  }
}

// === Type Registry ===

class TypeRegistry {
  private types: MetaType[] = []
  private typeIndex = new Map<string, number>()

  register(type: ResolvedType): number {
    // For named types (type aliases/uniques), register the underlying type
    // which already has the symbol reference from collectTypeDecl
    if (type.kind === 'named') {
      return this.register(type.type)
    }

    const key = typeToString(type, { compact: true })
    const existing = this.typeIndex.get(key)
    if (existing !== undefined) return existing

    const index = this.types.length
    this.types.push({ type: key })
    this.typeIndex.set(key, index)
    return index
  }

  registerWithSymbol(type: ResolvedType, symbolIndex: number): number {
    const key = typeToString(type, { compact: true })
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
