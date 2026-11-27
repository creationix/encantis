// Meta.json builder for Encantis
// Produces LSP-compatible metadata: types, symbols, hints

import type * as AST from './ast'
import { typecheck, typeKey, instanceNodes, forNames, namedPartAt, genericDeclaring, isGenericDecl, readAsModuleName, type TypeCheckResult } from './checker'
import { ownName, callOf, memberIn, instancesListed, applicationsListed, genericAround, type GenericInfo } from './instances'
import { type ResolvedType, typeToString, byteSize, func, manyPointer, pointer, array, primitive, VOID, unwrap, tableRow } from './types'
import { LineMap } from './position'
import { extractComments, findDocComment, type Comment } from './comments'
import { buildDataSection, type DataRef } from './data-pack'

// === Builtin Function Signatures ===
// Note: Many builtins are polymorphic. These signatures are for LSP display.
// Actual type checking happens in checker.ts inferBuiltin.

const BUILTIN_SIGNATURES: Record<string, ResolvedType> = {
  // Memory operations
  memzero: func(
    [{ name: 'dest', type: pointer(array(primitive('u8'), ['_'])) }],
    [],
  ),
  memset: func(
    [
      { name: 'dest', type: pointer(array(primitive('u8'), ['_'])) },
      { name: 'value', type: primitive('u8') },
      { name: 'len', type: primitive('u32') },
    ],
    [],
  ),
  memcpy: func(
    [
      { name: 'dest', type: pointer(array(primitive('u8'), ['_'])) },
      { name: 'src', type: pointer(array(primitive('u8'), ['_'])) },
      { name: 'len', type: primitive('u32') },
    ],
    [],
  ),

  // Float math (f32/f64) - shown as f64, actual type inferred from argument
  sqrt: func([{ name: 'x', type: primitive('f64') }], [{ name: null, type: primitive('f64') }]),
  abs: func([{ name: 'x', type: primitive('f64') }], [{ name: null, type: primitive('f64') }]),
  ceil: func([{ name: 'x', type: primitive('f64') }], [{ name: null, type: primitive('f64') }]),
  floor: func([{ name: 'x', type: primitive('f64') }], [{ name: null, type: primitive('f64') }]),
  trunc: func([{ name: 'x', type: primitive('f64') }], [{ name: null, type: primitive('f64') }]),
  nearest: func([{ name: 'x', type: primitive('f64') }], [{ name: null, type: primitive('f64') }]),
  copysign: func(
    [
      { name: 'x', type: primitive('f64') },
      { name: 'y', type: primitive('f64') },
    ],
    [{ name: null, type: primitive('f64') }],
  ),

  // Min/max (all numeric types)
  min: func(
    [
      { name: 'a', type: primitive('i32') },
      { name: 'b', type: primitive('i32') },
    ],
    [{ name: null, type: primitive('i32') }],
  ),
  max: func(
    [
      { name: 'a', type: primitive('i32') },
      { name: 'b', type: primitive('i32') },
    ],
    [{ name: null, type: primitive('i32') }],
  ),

  // Integer bit operations (i32/i64/u32/u64): the count is a u8
  clz: func([{ name: 'x', type: primitive('i32') }], [{ name: null, type: primitive('u8') }]),
  ctz: func([{ name: 'x', type: primitive('i32') }], [{ name: null, type: primitive('u8') }]),
  popcnt: func([{ name: 'x', type: primitive('i32') }], [{ name: null, type: primitive('u8') }]),
}

// Build a simplified expression string for hover hints
// Uses source text directly to handle def-substituted expressions correctly
function simplifyExpr(expr: AST.Expr, source: string): string {
  // For most expressions, just use the source text directly
  // This handles def-substituted expressions correctly (AST has literal, source has identifier)
  const sourceText = source.slice(expr.span.start, expr.span.end)

  // Truncate very long expressions
  if (sourceText.length > 60) {
    return `${sourceText.slice(0, 57)}...`
  }

  return sourceText
}

// === Meta Output Types ===

export interface MetaOutput {
  $schema?: string
  src: string
  types: MetaType[]
  symbols: MetaSymbol[]
  hints: Record<string, MetaHint>
  errors?: MetaError[]
  warnings?: MetaError[]
}

export interface MetaType {
  type: string
  symbol?: number // Index into symbols array if this type is named
}

export interface MetaSymbol {
  name: string
  // typeparam: a generic's `comptime T: type`; comptime: a generic
  // function's comptime function parameter, `comptime before: (T, T) -> bool`
  kind: 'func' | 'type' | 'unique' | 'global' | 'local' | 'param' | 'return' | 'data' | 'def' | 'typeparam' | 'comptime'
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
  exprStart?: number // Column where full expression starts (for highlight range)
  parentKind?: MetaSymbol['kind'] // For member access: kind of the base object's symbol
  inputParam?: boolean // True if this hint is for a function input parameter position
  // The function a call at this name calls, where the name alone does not
  // say it: an instance of a generic (index_of(T = u32)), the function a
  // comptime function parameter stands for
  calls?: string
  // For a method call x.f(a), the call it is: f(x, a)
  as?: string
  // What the name is in each instance there is (queries.ts HoverResult): in
  // a generic's body, in each instance of that generic; for a generic, its
  // instances; for a generic type and its own names, its applications.
  // `type` indexes the types array; `more` counts the instances not listed.
  instances?: { in: string[]; type: number }[]
  more?: number
}

export interface MetaError {
  pos: string // "line:col"
  message: string
  // For an error inside an instance of a generic: the calls that asked for
  // the instance, innermost first. A call in another module of the program
  // has that module's path, and its position is in that module's source.
  notes?: { pos: string; message: string; path?: string }[]
}

// === Main Entry Point ===

export interface MetaOptions {
  srcPath?: string
  // The module's result where it was checked as part of its program (see
  // typecheckProgram): it is then not checked again on its own.
  checkResult?: TypeCheckResult
  // The sources of the program's other modules by path, for the notes of
  // its errors that are in them
  sources?: Map<string, string>
}

export function buildMeta(
  module: AST.Module,
  source: string,
  options?: MetaOptions,
): MetaOutput {
  const lineMap = new LineMap(source)
  const comments = extractComments(source)
  const checkResult = options?.checkResult ?? typecheck(module, { source })

  const builder = new MetaBuilder(module, source, lineMap, comments, checkResult, options?.sources)
  return builder.build(options?.srcPath ?? 'file://./source.ents')
}

// === Meta Builder ===

class MetaBuilder {
  private typeRegistry = new TypeRegistry()
  private symbols: MetaSymbol[] = []
  // The module's names, by the name the checker knows each by
  private symbolIndexByName = new Map<string, number>()
  // The names each test declares (a data, a def, a function). A name of the
  // module is the module's in symbolIndexByName whatever a test declares
  // after it, and a test's own is its own while the test's hints are made:
  // the bodies' hints are made once every declaration is collected.
  private testNames = new Map<AST.TestDecl, Map<string, number>>()
  private moduleNames = new Set<string>()
  private inTest: AST.TestDecl | null = null
  // Every symbol by where the checker recorded its definition. A parameter
  // or local is found only this way: by name it would be the last one of
  // that name, in another function or in another block of this one, and a
  // global would be taken for a parameter spelled like it.
  private symbolIndexByDef = new Map<number, number>()
  private hints: Record<string, MetaHint> = {}
  private literalMap: Map<number, DataRef> = new Map()
  // While the body of a generic is gone through: the copies of its nodes in
  // its first instance, and how far that instance's offsets lie from the
  // generic's. What a name in the body is depends on the instance, and the
  // first one is the one that is shown.
  private copies: Map<object, object> | null = null
  private shift = 0
  // The functions whose bodies have hints to come, with the copies to read a
  // generic's body by
  private bodies = new Map<AST.FuncDecl, { copies: Map<object, object> | null; shift: number }>()
  // Where each hint is, by its key
  private hintOffsets = new Map<string, number>()
  // While a function's body is gone through: its span. A def's value is
  // pasted at each use with its own offsets, and is typed there as that use
  // needs; its hints are the def's own, from where it is declared.
  private within: AST.Span | null = null
  // The symbols of generic functions and types, with their declarations
  private genericSymbols = new Map<number, AST.FuncDecl | AST.TypeFuncDecl>()

  constructor(
    private module: AST.Module,
    private source: string,
    private lineMap: LineMap,
    private comments: Comment[],
    private checkResult: TypeCheckResult,
    private sources?: Map<string, string>,
  ) {}

  build(srcPath: string): MetaOutput {
    // Build data section to get literal addresses for hover hints
    // Use the checker's pending literals which include all def data (arrays, strings, repeats)
    // A module with errors still gets its metadata: a literal the checker
    // rejected may have no layout, and then has no address to show. So does
    // one whose errors are known only in its program (see partial).
    const { literalRefs } = buildDataSection(this.checkResult.literals, this.checkResult.types, {
      tolerant: this.checkResult.errors.length > 0 || this.checkResult.partial,
      calls: this.checkResult.calls,
      constants: this.checkResult.constants,
      fieldOrder: this.checkResult.fieldOrder,
    })
    this.literalMap = literalRefs

    // Pass 1: Collect symbols (populates typeRegistry)
    this.collectSymbols()

    // Pass 2: Generate hints
    this.generateHints()

    // Pass 3: a generic's comptime parameters, and what the names of
    // generics are in each of their instances
    this.addGenericNames()
    this.annotateInstances()

    // Build output
    const output: MetaOutput = {
      src: srcPath,
      types: this.typeRegistry.getTypes(),
      symbols: this.symbols,
      hints: this.hints,
    }

    const report = (e: TypeCheckResult['errors'][number]): MetaError => {
      const reported: MetaError = { pos: this.lineMap.positionKey(e.offset), message: e.message }
      if (e.notes) {
        reported.notes = e.notes.map((n) => {
          const elsewhere = n.path === undefined ? undefined : this.sources?.get(n.path)
          if (n.path === undefined || elsewhere === undefined) return { pos: this.lineMap.positionKey(n.offset), message: n.message }
          return { pos: new LineMap(elsewhere).positionKey(n.offset), message: n.message, path: n.path }
        })
      }
      return reported
    }
    if (this.checkResult.errors.length > 0) output.errors = this.checkResult.errors.map(report)
    if (this.checkResult.warnings.length > 0) output.warnings = this.checkResult.warnings.map(report)

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
      case 'TypeFuncDecl':
        this.collectTypeFunc(decl)
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
        // Memory declarations just specify size, no symbols to collect
        break
      case 'TestDecl':
        this.collectTestDecl(decl)
        break
    }
  }

  private collectTestDecl(decl: AST.TestDecl): void {
    const outer = this.inTest
    this.inTest = decl
    this.collectTestItems(decl)
    this.inTest = outer
  }

  private collectTestItems(decl: AST.TestDecl): void {
    for (const item of decl.children) {
      switch (item.kind) {
        case 'TestDecl':
          this.collectTestDecl(item)
          break
        case 'FuncDecl':
          this.collectFunc(item)
          break
        case 'DataDecl':
          this.collectData(item)
          break
        case 'DefDecl':
          this.collectDef(item)
          break
        case 'LetStmt':
          this.collectLocal(item.pattern)
          break
      }
    }
  }

  private collectImport(decl: AST.ImportDecl): void {
    for (const item of decl.items) {
      if (item.item.kind === 'ImportFunc') {
        const name = item.item.ident ?? item.name
        const known = this.checkResult.funcNames.get(item.item) ?? name
        const sym = this.checkResult.symbols.get(known)
        if (sym && sym.kind === 'func') {
          // Find the position of the function name in the import
          const offset = this.findImportFuncOffset(item, name)
          this.addSymbol(name, 'func', sym.type, offset, undefined, undefined, known)
        } else if (sym?.kind === 'generic') {
          // Another module's generic is listed as one of this module's is,
          // with the signature written here: the editor then finds its name
          // at the import and at its calls.
          this.addSymbol(name, 'func', this.writtenSignature(item.item.signature), this.findImportFuncOffset(item, name))
        }
      } else if (item.item.kind === 'ImportTypeFunc') {
        const name = item.item.ident
        if (this.checkResult.symbols.get(name)?.kind !== 'typefunc') continue
        const offset = this.findImportFuncOffset(item, name)
        this.addSymbol(name, 'type', this.source.slice(offset + name.length, item.item.span.end), offset)
      }
    }
  }

  private findImportFuncOffset(item: AST.ImportItem, name: string): number {
    // If ident is specified, use its position in the item
    // Otherwise, the name comes from item.name
    const ident = item.item.kind === 'ImportGlobal' ? undefined : item.item.ident
    if (ident) {
      // Search for the ident after "func" keyword
      const funcStart = item.item.span.start
      const searchText = this.source.slice(funcStart, item.item.span.end)
      const funcIdx = searchText.indexOf('func')
      if (funcIdx !== -1) {
        const afterFunc = funcStart + funcIdx + 4
        const identIdx = this.source.indexOf(ident, afterFunc)
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
      case 'TypeFuncDecl':
        this.collectTypeFunc(decl.item)
        break
      case 'GlobalDecl':
        this.collectGlobal(decl.item)
        break
      case 'MemoryDecl':
        // Memory declarations just specify size, no symbols to collect
        break
    }
  }

  // A generic type is a type only once it is applied. It is listed as a type
  // with the declaration it was written with, so that its name is found at
  // its declaration and wherever it is applied.
  private collectTypeFunc(decl: AST.TypeFuncDecl): void {
    if (this.checkResult.symbols.get(decl.ident)?.kind !== 'typefunc') return
    const offset = this.typeFuncIdentOffset(decl)
    const symbolIndex = this.addSymbol(decl.ident, 'type', this.source.slice(offset + decl.ident.length, decl.span.end), offset)
    this.genericSymbols.set(symbolIndex, decl)
  }

  private typeFuncIdentOffset(decl: AST.TypeFuncDecl): number {
    return this.findKeywordIdentOffset(decl.span.start, decl.body.span.start, 'func')
  }

  // A generic's signature as it is written, comptime parameters included
  private writtenSignature({ input, output }: AST.FuncSignature): string {
    const returns = output.kind === 'CompositeType' && output.fields.length === 0 ? '()' : this.source.slice(output.span.start, output.span.end)
    return `${this.source.slice(input.span.start, input.span.end)}->${returns}`
  }

  private collectFunc(decl: AST.FuncDecl): void {
    if (decl.ident) {
      const known = this.checkResult.funcNames.get(decl) ?? decl.ident
      const sym = this.checkResult.symbols.get(known)
      if (sym?.kind === 'generic') {
        // A generic has no type of its own. It is listed with the signature it
        // was written with, so that its name is found where a function's is:
        // at its declaration and at its calls, where the hint carries the
        // signature of the instance.
        const symbolIndex = this.addSymbol(decl.ident, 'func', this.writtenSignature(decl.signature), this.findFuncIdentOffset(decl))
        if (sym.decl === decl) this.genericSymbols.set(symbolIndex, decl)
        // What its parameters and the names in its body are depends on the
        // instance: their hints are made from the first one, and then say
        // what they are in each (see annotateInstances). A generic nothing
        // has called yet has none, and only its written types to show (see
        // addGenericNames).
        const first = this.checkResult.instances.find((inst) => inst.of === decl)
        if (sym.decl !== decl || !first) return
        this.copies = instanceNodes(decl, first.decl)
        this.shift = first.decl.span.start - decl.span.start
        // The generic's own names are found where they are defined, as any
        // function's are: a global spelled like one of its parameters is
        // still the global.
        this.collectFuncBody(decl, symbolIndex)
        this.bodies.set(decl, { copies: this.copies, shift: this.shift })
        this.copies = null
        this.shift = 0
        return
      }
      if (!sym || sym.kind !== 'func') return

      // Find the function name offset (after "func" keyword)
      const offset = this.findFuncIdentOffset(decl)
      const symbolIndex = this.addSymbol(decl.ident, 'func', sym.type, offset, undefined, decl.inline, known)

      // Collect params and locals (also adds hints for params/returns)
      this.collectFuncBody(decl, symbolIndex)
    } else {
      // Anonymous function - still collect locals from body
      this.collectFuncBody(decl, -1)
    }
    // Hints for the body come once every function is a symbol: a call of one
    // declared further down is that one.
    this.bodies.set(decl, { copies: null, shift: 0 })
  }

  // The hints of a function's body, in the second pass
  private generateHintsForBody(decl: AST.FuncDecl): void {
    const body = this.bodies.get(decl)
    if (!body) return
    this.copies = body.copies
    this.shift = body.shift
    this.within = decl.span
    if (decl.body.kind === 'Block') {
      this.generateHintsForBlock(decl.body)
    } else {
      this.generateHintsForExpr(decl.body.expr)
    }
    this.copies = null
    this.shift = 0
    this.within = null
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

    // Collect named returns first (only CompositeType has named fields)
    // This creates the symbol that in/out params will reference
    if (decl.signature.output.kind === 'CompositeType') {
      for (const ret of decl.signature.output.fields) {
        if (ret.ident) {
          const type = this.bindingType(ret.span.start, ret.kind)
          if (type) {
            const symbolIndex = this.addSymbol(ret.ident, 'return', type, ret.span.start)
            const typeIndex = this.typeRegistry.register(type)
            this.addHint(ret.span.start, ret.ident.length, typeIndex, symbolIndex)
          }
        }
      }
    }

    // Collect parameters (only CompositeType has named fields)
    // Params that also appear in output are tagged as 'return' (in/out params)
    if (decl.signature.input.kind === 'CompositeType') {
      for (const param of decl.signature.input.fields) {
        if (param.ident) {
          const isInOut = returnNames.has(param.ident)
          const type = this.bindingType(param.span.start, param.kind)
          if (type) {
            let symbolIndex: number | undefined
            if (isInOut) {
              // In/out param - reuse the return symbol, just add a hint for this location
              const ret = (decl.signature.output as AST.CompositeType).fields.find((f) => f.ident === param.ident)
              symbolIndex = ret && this.symbolIndexByDef.get(ret.span.start)
            } else {
              // Pure input param - create new symbol
              symbolIndex = this.addSymbol(param.ident, 'param', type, param.span.start)
            }
            if (symbolIndex !== undefined) {
              const typeIndex = this.typeRegistry.register(type)
              // Mark pure input params (not in/out) for semantic token highlighting
              const inputParamFlag = !isInOut
              this.addHint(param.span.start, param.ident.length, typeIndex, symbolIndex, undefined, undefined, undefined, inputParamFlag)
            }
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
      if (stmt.kind === 'ForStmt') this.collectForBinding(stmt.binding)
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

  // Each name of a for, where it stands
  private collectForBinding(binding: AST.ForBinding): void {
    for (const { name, offset } of forNames(binding)) {
      const type = this.bindingType(offset, 'Binding')
      if (type) this.addSymbol(name, 'local', type, offset)
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
      const type = this.bindingType(pattern.span.start, pattern.kind)
      if (type) {
        this.addSymbol(pattern.name, 'local', type, pattern.span.start)
      }
    } else if (pattern.kind === 'TuplePattern') {
      // Get the tuple type for the whole pattern and unwrap named types
      const rawType = this.bindingType(pattern.span.start, pattern.kind)
      if (!rawType) return
      const tupleType = unwrap(rawType)
      if (tupleType.kind !== 'tuple') return

      for (const element of pattern.elements) {
        if (element.kind === 'named') {
          // Find the field in the tuple type
          const tupleField = tupleType.fields.find((f) => f.name === element.field)
          if (!tupleField) continue

          // The variable name is either the binding or the field name (for shorthand)
          const varName = element.binding ?? element.field
          this.addSymbol(varName, 'local', tupleField.type, namedPartAt(element))
        } else if (element.kind === 'positional') {
          // For positional, recurse into the nested pattern
          this.collectLocal(element.pattern)
        }
      }
    }
  }

  private collectTypeDecl(decl: AST.TypeDecl): void {
    const sym = this.checkResult.symbols.get(decl.ident.name)
    if (!sym || sym.kind !== 'type') return

    // A host type is shown as what it is declared as (type Canvas = host),
    // not as its own name; a name for one is that type.
    const u = unwrap(sym.type)
    const declared = u.kind === 'host' && !u.optional && u.name === decl.ident.name ? 'host' : sym.type
    const symbolIndex = this.addSymbol(decl.ident.name, 'type', declared, decl.ident.span.start)
    this.typeRegistry.registerWithSymbol(sym.type, symbolIndex)
  }

  private collectDef(decl: AST.DefDecl): void {
    const mangledKey = `${decl.ident}$${decl.span.start}`
    const sym = this.checkResult.symbols.get(decl.ident) ?? this.checkResult.symbols.get(mangledKey)
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
      const entry = this.literalMap.get(sym.value.id)
      if (entry) {
        valueStr = this.formatDataRef(entry, sym.type)
      }
    }

    this.addSymbol(decl.ident, 'def', sym.type, offset, valueStr, undefined, decl.ident, this.recordedAt(decl))
  }

  // Where the checker recorded a def or a data: where its declaration starts
  private recordedAt(decl: AST.DefDecl | AST.DataDecl): number | undefined {
    return this.checkResult.references.has(decl.span.start) ? decl.span.start : undefined
  }

  private collectData(decl: AST.DataDecl): void {
    const mangledKey = `${decl.ident}$${decl.span.start}`
    const sym = this.checkResult.symbols.get(decl.ident) ?? this.checkResult.symbols.get(mangledKey)
    if (!sym || sym.kind !== 'def') return

    const offset = this.findDataIdentOffset(decl)

    let valueStr: string | undefined
    if (sym.value.kind === 'data_ptr') {
      const entry = this.literalMap.get(sym.value.id)
      if (entry) {
        valueStr = this.formatDataRef(entry, sym.type)
      }
    }

    this.addSymbol(decl.ident, 'data', sym.type, offset, valueStr, undefined, decl.ident, this.recordedAt(decl))
  }

  private findDataInfoForExpr(expr: AST.Expr, type: ResolvedType): string | undefined {
    // Try the expression itself
    const tryId = (e: AST.Expr): string | undefined => {
      const entry = this.literalMap.get(this.literalId(e))
      if (entry) return this.formatDataRef(entry, type)
      return undefined
    }
    const direct = tryId(expr)
    if (direct) return direct
    // Unwrap UnaryExpr (& or mut)
    if (expr.kind === 'UnaryExpr') return this.findDataInfoForExpr(expr.operand, type)
    // Unwrap AnnotationExpr
    if (expr.kind === 'AnnotationExpr') return this.findDataInfoForExpr(expr.expr, type)
    return undefined
  }

  private formatDataRef(ref: DataRef, type: ResolvedType): string {
    const u = unwrap(type)
    if (u.kind === 'pointer' && u.pointee.kind === 'array') {
      return `0x${ref.ptr.toString(16)}`
    }
    return `0x${ref.ptr.toString(16)} (${ref.len} bytes)`
  }

  private findDefIdentOffset(decl: AST.DefDecl): number {
    return this.findKeywordIdentOffset(decl.span.start, decl.span.end, 'def')
  }

  private findDataIdentOffset(decl: AST.DataDecl): number {
    return this.findKeywordIdentOffset(decl.span.start, decl.span.end, 'data')
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

  // The type the checker recorded for a binding (a parameter, a let, a loop
  // variable); in a generic's body, for its copy in the first instance.
  private bindingType(offset: number, kind: string): ResolvedType | undefined {
    return this.checkResult.types.get(typeKey(offset, kind))
      ?? (this.copies ? this.checkResult.types.get(typeKey(offset + this.shift, kind)) : undefined)
  }

  // The node the checker's tables hold: in a generic's body, its copy.
  private checked<T extends object>(node: T): T {
    return (this.copies?.get(node) as T | undefined) ?? node
  }

  private exprType(expr: AST.Expr): ResolvedType | undefined {
    return this.checkResult.exprTypes.get(this.checked(expr))
  }

  // Where the data of a literal is listed
  private literalId(expr: AST.Expr & { dataId?: number }): number {
    const literal = this.checked(expr)
    return literal.dataId ?? literal.span.start
  }

  // `known`: the name the checker knows the symbol by, where a function
  // shares its name with another (see TypeCheckResult.funcNames)
  private addSymbol(
    name: string,
    kind: MetaSymbol['kind'],
    type: ResolvedType | string,
    offset: number,
    value?: string,
    inline?: boolean,
    known = name,
    // Where the checker recorded the definition, where that is not found by
    // the name: a def or data a test declares (each test may declare its own)
    recorded?: number,
  ): number {
    const typeIndex = typeof type === 'string' ? this.typeRegistry.registerText(type) : this.typeRegistry.register(type)
    const defPos = this.lineMap.positionKey(offset)

    // Get doc comment - only for module-level declarations
    let doc: string | null = null
    if (kind === 'func' || kind === 'type' || kind === 'unique' || kind === 'global' || kind === 'data' || kind === 'def') {
      const declLine = this.lineMap.offsetToPosition(offset).line
      doc = findDocComment(this.comments, declLine)
    }

    // Get references - use checker's recorded definition offset, not the display offset
    // A name a generic declares is no name of the module: the checker holds
    // its uses by where it is declared.
    // A parameter or local is defined where it is displayed. A generic's
    // comptime parameters are its own names too, and are found by where
    // they are defined, never by name.
    const local = kind === 'local' || kind === 'param' || kind === 'return' || kind === 'typeparam' || kind === 'comptime'
    const checkerDefOffset = recorded ?? (this.copies || local ? offset : this.checkResult.symbolDefOffsets.get(known))
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
    if (!local && this.inTest) {
      const own = this.testNames.get(this.inTest) ?? new Map<string, number>()
      own.set(known, index)
      this.testNames.set(this.inTest, own)
      if (!this.moduleNames.has(known)) this.symbolIndexByName.set(known, index)
    } else if (!local) {
      this.symbolIndexByName.set(known, index)
      this.moduleNames.add(known)
    }
    if (checkerDefOffset !== undefined) this.symbolIndexByDef.set(checkerDefOffset, index)

    return index
  }

  // === Generics ===

  // Each generic function and generic type of the module, also one a test
  // declares
  private generics(): (AST.FuncDecl | AST.TypeFuncDecl)[] {
    const found: (AST.FuncDecl | AST.TypeFuncDecl)[] = []
    const visit = (items: readonly (AST.Declaration | AST.TestItem)[]): void => {
      for (const item of items) {
        const decl = item.kind === 'ExportDecl' ? item.item : item
        if (decl.kind === 'TestDecl') visit(decl.children)
        else if (decl.kind === 'TypeFuncDecl' || (decl.kind === 'FuncDecl' && isGenericDecl(decl))) found.push(decl)
      }
    }
    visit(this.module.decls)
    return found
  }

  // A generic's comptime parameters are its own names, defined where they
  // are declared and used in its body: symbols of their own, with a hint at
  // each place, which no instance has (an instance has its arguments in
  // their place). A generic type's fields are shown where they are declared.
  // A generic nothing has called has no instance to show its other names by:
  // its parameters, its results and the locals whose type is written are
  // shown with that type where they are declared.
  private addGenericNames(): void {
    const written = (type: AST.Type) => this.source.slice(type.span.start, type.span.end)
    for (const decl of this.generics()) {
      const own = decl.kind === 'TypeFuncDecl' ? decl.params : (decl.signature.input as AST.CompositeType).fields
      for (const param of own) {
        if (!param.comptime || !param.ident) continue
        const at = param.identSpan?.start ?? param.span.start
        const kind = param.type.kind === 'TypeType' ? 'typeparam' : 'comptime'
        const symbol = this.addSymbol(param.ident, kind, written(param.type), at, undefined, undefined, param.ident, at)
        for (const offset of [at, ...(this.checkResult.references.get(at) ?? [])]) {
          this.addHint(offset, param.ident.length, this.symbols[symbol].type, symbol)
        }
      }
      if (decl.kind === 'TypeFuncDecl') {
        for (const field of fieldsUnder(decl.body)) {
          this.addHint(field.span.start, (field.ident as string).length, this.typeRegistry.registerText(written(field.type)))
        }
        continue
      }
      if (this.checkResult.instances.some((inst) => inst.of === decl)) continue
      const output = decl.signature.output.kind === 'CompositeType' ? decl.signature.output.fields : []
      const results = new Set(output.flatMap((f) => (f.ident ? [f.ident] : [])))
      for (const field of [...output, ...own.filter((f) => !f.comptime)]) {
        if (!field.ident || this.hints[this.lineMap.positionKey(field.span.start)]) continue
        const kind = results.has(field.ident) ? 'return' : 'param'
        const symbol = this.addSymbol(field.ident, kind, written(field.type), field.span.start)
        this.addHint(field.span.start, field.ident.length, this.symbols[symbol].type, symbol, undefined, undefined, undefined, kind === 'param')
      }
      for (const stmt of writtenLets(decl.body)) {
        const pattern = stmt.pattern as AST.IdentPattern
        const symbol = this.addSymbol(pattern.name, 'local', written(stmt.type as AST.Type), pattern.span.start)
        this.addHint(pattern.span.start, pattern.name.length, this.symbols[symbol].type, symbol)
      }
    }
  }

  // What the names of generics are in each instance: a generic's own names
  // are shown with the type they are declared with (written, or what it is in
  // terms of the type parameters), and with their type in each instance; a
  // call with the function it calls; a generic with its instances, a generic
  // type with its applications.
  private annotateInstances(): void {
    const compact = (type: ResolvedType) => typeToString(type, { compact: true })
    for (const [key, hint] of Object.entries(this.hints)) {
      const offset = this.hintOffsets.get(key)
      if (offset === undefined) continue
      const name = /^[a-zA-Z_][a-zA-Z0-9_-]*/.exec(this.source.slice(offset, offset + hint.len))?.[0]
      if (!name || name.length !== hint.len) continue
      const info = this.genericInfo(offset, name, hint, compact)
      if (!info) continue
      if (info.type !== undefined) hint.type = this.typeRegistry.registerText(info.type)
      if (info.calls !== undefined) hint.calls = info.calls
      if (info.as !== undefined) hint.as = info.as
      if (info.instances) hint.instances = info.instances.map((i) => ({ in: i.in, type: this.typeRegistry.registerText(i.type) }))
      if (info.more !== undefined) hint.more = info.more
      // A generic's own name is declared as it shows it at its declaration.
      const symbol = hint.symbol !== undefined ? this.symbols[hint.symbol] : undefined
      if (info.type !== undefined && symbol?.def === key && symbol.kind !== 'func') symbol.type = hint.type
    }
  }

  private genericInfo(offset: number, name: string, hint: MetaHint, compact: (type: ResolvedType) => string): GenericInfo | null {
    // A field after a point: in a generic's body, what it is in each instance
    if (hint.expr !== undefined) return memberIn(this.module, this.checkResult, offset, compact, compact)
    // Only what lies in a generic can be one of its own names.
    const generic = genericAround(this.module, offset) && genericDeclaring(this.module, offset, name)
    if (generic && !readAsModuleName(this.checkResult, offset)) return ownName(this.source, this.checkResult, generic, offset, name, compact, compact)
    const call = callOf(this.source, this.module, this.checkResult, offset, name)
    if (call) return call
    const decl = hint.symbol !== undefined ? this.genericSymbols.get(hint.symbol) : undefined
    if (decl?.kind === 'FuncDecl') return instancesListed(this.checkResult, decl)
    if (decl?.kind === 'TypeFuncDecl') return applicationsListed(this.checkResult, decl, compact)
    return null
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
        } else if (decl.item.kind === 'TypeFuncDecl') {
          this.generateHintsForTypeFunc(decl.item)
        }
        // MemoryDecl just specifies size, no hints needed
        break
      case 'FuncDecl':
        this.generateHintsForFunc(decl)
        break
      case 'TypeFuncDecl':
        this.generateHintsForTypeFunc(decl)
        break
      case 'TypeDecl':
        this.generateHintsForTypeDecl(decl)
        break
      case 'DataDecl':
        this.generateHintsForData(decl)
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
      case 'TestDecl':
        this.generateHintsForTestDecl(decl)
        break
    }
  }

  private generateHintsForTestDecl(decl: AST.TestDecl): void {
    // In the test, the names it declares are its own.
    const hidden: [string, number | undefined][] = []
    for (const [name, index] of this.testNames.get(decl) ?? []) {
      hidden.push([name, this.symbolIndexByName.get(name)])
      this.symbolIndexByName.set(name, index)
    }
    this.generateHintsForTestItems(decl)
    for (const [name, index] of hidden.reverse()) {
      if (index === undefined) this.symbolIndexByName.delete(name)
      else this.symbolIndexByName.set(name, index)
    }
  }

  private generateHintsForTestItems(decl: AST.TestDecl): void {
    // Collect locals from test body statements
    for (const item of decl.children) {
      if (item.kind === 'LetStmt') {
        this.collectLocal(item.pattern)
      }
      if (item.kind === 'ForStmt') this.collectForBinding(item.binding)
      if ('body' in item && item.body.kind === 'Block') {
        this.collectLocalsFromBlock(item.body)
      }
    }
    for (const item of decl.children) {
      switch (item.kind) {
        case 'TestDecl':
          this.generateHintsForTestDecl(item)
          break
        case 'FuncDecl':
          this.generateHintsForFunc(item)
          break
        case 'DataDecl':
          this.generateHintsForData(item)
          break
        case 'DefDecl':
          this.generateHintsForDef(item)
          break
        case 'ImportDecl':
        case 'TypeFuncDecl':
          break
        default:
          this.generateHintsForStmt(item)
          break
      }
    }
  }

  private generateHintsForImport(decl: AST.ImportDecl): void {
    for (const item of decl.items) {
      if (item.item.kind === 'ImportFunc') {
        const name = item.item.ident ?? item.name
        const symbolIndex = this.symbolIndexByName.get(this.checkResult.funcNames.get(item.item) ?? name)
        if (symbolIndex !== undefined) {
          const offset = this.findImportFuncOffset(item, name)
          this.addHint(offset, name.length, this.symbols[symbolIndex].type, symbolIndex)
        }
      } else if (item.item.kind === 'ImportTypeFunc') {
        const name = item.item.ident
        const symbolIndex = this.symbolIndexByName.get(name)
        if (symbolIndex !== undefined && this.checkResult.symbols.get(name)?.kind === 'typefunc') {
          this.addHint(this.findImportFuncOffset(item, name), name.length, this.symbols[symbolIndex].type, symbolIndex)
        }
      }
    }
  }

  private generateHintsForFunc(decl: AST.FuncDecl): void {
    // Handle named functions
    if (decl.ident) {
      const symbolIndex = this.symbolIndexByName.get(this.checkResult.funcNames.get(decl) ?? decl.ident)
      if (symbolIndex !== undefined) {
        // Hint for function name
        const offset = this.findFuncIdentOffset(decl)
        this.addHint(offset, decl.ident.length, this.symbols[symbolIndex].type, symbolIndex)
      }
      // Note: Hints for params/returns are added during collectFunc
    }
    // The types its signature names: a generic type there has its applications
    this.generateHintsForTypeExpr(decl.signature.input)
    this.generateHintsForTypeExpr(decl.signature.output)
    this.generateHintsForBody(decl)
  }

  private generateHintsForTypeFunc(decl: AST.TypeFuncDecl): void {
    const symbolIndex = this.symbolIndexByName.get(decl.ident)
    if (symbolIndex === undefined || this.checkResult.symbols.get(decl.ident)?.kind !== 'typefunc') return
    this.addHint(this.typeFuncIdentOffset(decl), decl.ident.length, this.symbols[symbolIndex].type, symbolIndex)
  }

  private generateHintsForBlock(block: AST.Block): void {
    for (const stmt of block.stmts) {
      this.generateHintsForStmt(stmt)
    }
  }

  private generateHintsForStmt(stmt: AST.Statement): void {
    switch (stmt.kind) {
      case 'LetStmt':
        this.generateHintsForLetPattern(stmt.pattern, stmt.value ?? null)
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
        // LValue can be IdentExpr, MemberExpr, IndexExpr, SliceExpr (a range filled or copied into), or Pattern
        if (stmt.target.kind === 'IdentExpr' || stmt.target.kind === 'MemberExpr' || stmt.target.kind === 'IndexExpr' || stmt.target.kind === 'SliceExpr') {
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
        // Generate hints for the binding variables, in the order they are written
        for (const { name, offset } of forNames(stmt.binding).sort((a, b) => a.offset - b.offset)) {
          const symbolIndex = this.symbolIndexByDef.get(offset)
          if (symbolIndex !== undefined) this.addHint(offset, name.length, this.symbols[symbolIndex].type, symbolIndex)
        }
        this.generateHintsForExpr(stmt.iterable)
        if (stmt.body.kind === 'Block') this.generateHintsForBlock(stmt.body)
        break
      }
      case 'AssertStmt':
      case 'DeferStmt':
        this.generateHintsForExpr(stmt.expr)
        break
      case 'BreakStmt':
      case 'ContinueStmt':
        if (stmt.when) this.generateHintsForExpr(stmt.when)
        break
    }
  }

  private generateHintsForLetPattern(pattern: AST.Pattern, value: AST.Expr | null): void {
    if (pattern.kind === 'IdentPattern') {
      const type = this.bindingType(pattern.span.start, pattern.kind)
      if (type) {
        const typeIndex = this.typeRegistry.register(type)
        const symbolIndex = this.symbolIndexByDef.get(pattern.span.start)
        let dataInfo: string | undefined
        if (value) {
          dataInfo = this.findDataInfoForExpr(value, type)
        }
        this.addHint(pattern.span.start, pattern.name.length, typeIndex, symbolIndex, dataInfo)
      }
    } else {
      this.generateHintsForPattern(pattern)
    }
  }

  private generateHintsForPattern(pattern: AST.Pattern): void {
    if (pattern.kind === 'IdentPattern') {
      const type = this.bindingType(pattern.span.start, pattern.kind)
      if (type) {
        const typeIndex = this.typeRegistry.register(type)
        const symbolIndex = this.symbolIndexByDef.get(pattern.span.start)
        this.addHint(
          pattern.span.start,
          pattern.name.length,
          typeIndex,
          symbolIndex,
        )
      }
    } else if (pattern.kind === 'TuplePattern') {
      for (const element of pattern.elements) {
        if (element.kind === 'named') {
          // The hint is on the variable's name: the binding, or the field's
          // name in the shorthand
          const offset = namedPartAt(element)
          const symbolIndex = this.symbolIndexByDef.get(offset)
          if (symbolIndex === undefined) continue
          this.addHint(offset, (element.binding ?? element.field).length, this.symbols[symbolIndex].type, symbolIndex)
        } else if (element.kind === 'positional') {
          // For positional, recurse into the nested pattern
          this.generateHintsForPattern(element.pattern)
        }
      }
    }
  }

  // The binding of an if let or elif let is a local, defined where its name stands
  private generateHintsForIfLetBinding(arm: AST.IfExpr | AST.ElifBranch): void {
    if (arm.pattern?.kind !== 'binding') return
    const at = arm.pattern.span.start
    const type = this.bindingType(at, 'Binding')
    if (!type) return
    const symbolIndex = this.symbolIndexByDef.get(at) ?? this.addSymbol(arm.pattern.name, 'local', type, at)
    this.addHint(at, arm.pattern.name.length, this.typeRegistry.register(type), symbolIndex)
  }

  private generateHintsForExpr(expr: AST.Expr): void {
    const type = this.exprType(expr)

    // Where a def's name is written its value was put, which is the def
    // there, typed as that place needs. What the value holds is the def's
    // own, at the def's declaration.
    const def = this.defUsedAt(expr)
    if (def !== undefined) {
      this.addHint(def.at, this.symbols[def.index].name.length, type ? this.typeRegistry.register(type) : this.symbols[def.index].type, def.index)
      return
    }

    switch (expr.kind) {
      case 'IdentExpr': {
        const symbolIndex = this.usedSymbol(expr)
        // Check for builtin functions when no symbol is found
        const effectiveType = type ?? BUILTIN_SIGNATURES[expr.name]
        if (effectiveType) {
          const typeIndex = this.typeRegistry.register(effectiveType)
          this.addHint(expr.span.start, expr.name.length, typeIndex, symbolIndex)
        }
        break
      }

      case 'LiteralExpr': {
        // A single-quoted literal shows the codepoint it is.
        if (type && expr.quoted && expr.value.kind === 'int' && this.source[expr.span.start] === "'") {
          const len = this.lineMap.spanLength(expr.span.start, expr.span.end)
          this.addHint(expr.span.start, len, this.typeRegistry.register(type), undefined, expr.value.value.toString())
          break
        }
        if (type) {
          const typeIndex = this.typeRegistry.register(type)
          const len = this.lineMap.spanLength(expr.span.start, expr.span.end)
          const entry = this.literalMap.get(this.literalId(expr))
          this.addHint(expr.span.start, len, typeIndex, undefined, entry ? this.formatDataRef(entry, type) : undefined)
        }
        break
      }

      case 'CallExpr': {
        if (!this.generateHintsForCallee(expr)) this.generateHintsForExpr(expr.callee)
        for (const arg of expr.args) {
          if (arg.value) this.generateHintsForExpr(arg.value)
        }
        break
      }

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
            const objType = this.exprType(expr.object)
            if (objType) {
              // Get the array/slice type (either directly or through pointer)
              const arrayType = (objType.kind === 'array' || objType.kind === 'slice') ? objType
                : (objType.kind === 'pointer' && (objType.pointee.kind === 'array' || objType.pointee.kind === 'slice')) ? objType.pointee
                : null
              if (arrayType) {
                if (expr.member.name === 'len') {
                  // For arrays, get length from sizes[0]
                  if (arrayType.kind === 'array' && typeof arrayType.sizes?.[0] === 'number') {
                    comptimeValue = String(arrayType.sizes[0])
                  }
                  // Slices have runtime length, no comptime value
                } else if (expr.member.name === 'wid') {
                  const elemSize = byteSize(tableRow(objType) ?? arrayType.element)
                  if (elemSize !== null) {
                    comptimeValue = String(elemSize)
                  }
                }
              }
            }
            // Find the root identifier's symbol kind for display (e.g., "input c.y" vs just "c.y")
            const rootIdent = this.findRootIdent(expr)
            const parentKind = rootIdent ? this.symbols[this.usedSymbol(rootIdent) ?? -1]?.kind : undefined
            // Use simplified expression for cleaner hover display
            const simplifiedExpr = simplifyExpr(expr, this.source)
            // Include expression start column for full-expression highlighting
            const exprStartCol = this.lineMap.offsetToPosition(expr.span.start).col
            this.addHint(memberOffset, expr.member.name.length, typeIndex, undefined, comptimeValue, simplifiedExpr, parentKind, undefined, exprStartCol)
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
            const exprStartCol = this.lineMap.offsetToPosition(expr.span.start).col
            this.addHint(memberOffset, 1, typeIndex, undefined, undefined, simplifiedExpr, undefined, undefined, exprStartCol)
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
            const exprStartCol = this.lineMap.offsetToPosition(expr.span.start).col
            this.addHint(memberOffset, typeName.length, typeIndex, undefined, undefined, simplifiedExpr, undefined, undefined, exprStartCol)
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

      // A range: what it is of and its bounds are code like any other
      case 'SliceExpr':
        this.generateHintsForExpr(expr.object)
        if (expr.start) this.generateHintsForExpr(expr.start)
        if (expr.end) this.generateHintsForExpr(expr.end)
        break

      case 'TupleExpr':
        // 'ok' shows the codepoints it is, (111, 107).
        if (type && expr.quoted) {
          const codepoints = expr.elements.map((e) => (e.value?.kind === 'LiteralExpr' && e.value.value.kind === 'int' ? e.value.value.value : '?'))
          const len = this.lineMap.spanLength(expr.span.start, expr.span.end)
          this.addHint(expr.span.start, len, this.typeRegistry.register(type), undefined, `(${codepoints.join(', ')})`)
        }
        for (const elem of expr.elements) {
          if (elem.value) {
            this.generateHintsForExpr(elem.value)
          } else if (elem.name) {
            // Shorthand syntax: (d:, a:) - generate hint for implicit variable reference
            const symbolIndex = this.usedSymbol({ kind: 'IdentExpr', name: elem.name, span: elem.span })
            if (symbolIndex !== undefined) {
              const symbol = this.symbols[symbolIndex]
              this.addHint(elem.span.start, elem.name.length, symbol.type, symbolIndex)
            }
          }
        }
        break

      case 'ArrayExpr': {
        // Record hint for the array literal itself (comptime_list type)
        if (type) {
          const typeIndex = this.typeRegistry.register(type)
          const len = this.lineMap.spanLength(expr.span.start, expr.span.end)
          let dataInfo: string | undefined
          const entry = this.literalMap.get(this.literalId(expr))
          if (entry && type) {
            dataInfo = this.formatDataRef(entry, type)
          }
          this.addHint(expr.span.start, len, typeIndex, undefined, dataInfo)
        }
        for (const elem of expr.elements) {
          this.generateHintsForExpr(elem)
        }
        break
      }

      case 'RepeatExpr': {
        // Add hint for repeat literal with data section info
        if (type) {
          const typeIndex = this.typeRegistry.register(type)
          const len = this.lineMap.spanLength(expr.span.start, expr.span.end)
          let dataInfo: string | undefined
          const entry = this.literalMap.get(this.literalId(expr))
          if (entry) {
            dataInfo = this.formatDataRef(entry, type)
          }
          this.addHint(expr.span.start, len, typeIndex, undefined, dataInfo)
        }
        // Recurse into value expression (e.g., 0:u8)
        this.generateHintsForExpr(expr.value)
        // Generate hint for the count (e.g., 1024), or the def whose name
        // is written there
        const countType = this.exprType(expr.count)
        if (this.defUsedAt(expr.count)) {
          this.generateHintsForExpr(expr.count)
        } else if (countType) {
          const typeIndex = this.typeRegistry.register(countType)
          const len = this.lineMap.spanLength(expr.count.span.start, expr.count.span.end)
          this.addHint(expr.count.span.start, len, typeIndex)
        }
        break
      }

      case 'GroupExpr':
        this.generateHintsForExpr(expr.expr)
        break

      case 'IfExpr':
        this.generateHintsForIfLetBinding(expr)
        this.generateHintsForExpr(expr.condition)
        if (expr.thenBranch.kind === 'Block') {
          this.generateHintsForBlock(expr.thenBranch)
        }
        for (const elif of expr.elifs) {
          this.generateHintsForIfLetBinding(elif)
          this.generateHintsForExpr(elif.condition)
          if (elif.thenBranch.kind === 'Block') {
            this.generateHintsForBlock(elif.thenBranch)
          }
        }
        if (expr.else_?.kind === 'Block') {
          this.generateHintsForBlock(expr.else_)
        }
        break

      case 'CoalesceExpr':
        this.generateHintsForExpr(expr.expr)
        this.generateHintsForExpr(expr.fallback)
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

  // The hint for the function a call names, where the checker found the call
  // to mean another than the one written: x.f(a), which is the call f(x, a),
  // and a call of a function that shares its name. The hint is at the name
  // and carries the function that is called. False where the call is as
  // written.
  private generateHintsForCallee(expr: AST.CallExpr): boolean {
    const callee = expr.callee
    const meant = this.checkResult.calls.get(this.checked(expr))
    if (meant?.kind !== 'CallExpr' || meant.callee.kind !== 'IdentExpr') return false
    const method = callee.kind === 'MemberExpr' && callee.member.kind === 'field' ? callee.member.name : null
    if (method === null && callee.kind !== 'IdentExpr') return false
    const name = method ?? (callee as AST.IdentExpr).name
    // The function of the module that ends up called: f(x, a) may itself
    // stand for one of several functions f. An instance is no symbol; its
    // generic is.
    let last = meant
    for (let next = this.checkResult.calls.get(last); next?.kind === 'CallExpr'; next = this.checkResult.calls.get(last)) last = next
    const called = last.callee.kind === 'IdentExpr' ? last.callee.name : name
    const symbolIndex = this.symbolIndexByName.get(called) ?? this.symbolIndexByName.get(name)
    if (method !== null) this.generateHintsForExpr((callee as AST.MemberExpr).object)
    // The checker typed the callee it resolved: f of f(x, a), or the name as written.
    const type = this.checkResult.exprTypes.get(method !== null ? meant.callee : this.checked(callee)) ?? BUILTIN_SIGNATURES[name]
    if (type) {
      const offset = method !== null ? callee.span.end - name.length : callee.span.start
      this.addHint(offset, name.length, this.typeRegistry.register(type), symbolIndex)
    }
    return true
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
    // A generic type applied: its name is the generic type's, and its
    // arguments are types of their own.
    if (type.kind === 'TypeApply') {
      const symbolIndex = this.symbolIndexByName.get(type.name)
      if (symbolIndex !== undefined && this.checkResult.symbols.get(type.name)?.kind === 'typefunc') {
        this.addHint(type.span.start, type.name.length, this.symbols[symbolIndex].type, symbolIndex)
      }
      for (const arg of type.args) if (arg.kind !== 'ValueArg') this.generateHintsForTypeExpr(arg)
    }
    // Recurse into compound types
    if (type.kind === 'OptionalType') {
      this.generateHintsForTypeExpr(type.type)
    }
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
    // Its own symbol: a test may declare one of a name another test declares
    const symbolIndex = this.symbolIndexByDef.get(decl.span.start) ?? this.symbolIndexByName.get(decl.ident)
    if (symbolIndex !== undefined) {
      const symbol = this.symbols[symbolIndex]
      const offset = this.findDefIdentOffset(decl)
      this.addHint(offset, decl.ident.length, symbol.type, symbolIndex, symbol.value)
    }
    this.generateHintsForExpr(decl.value)
  }

  private generateHintsForData(decl: AST.DataDecl): void {
    // Its own symbol: a test may declare one of a name another test declares
    const symbolIndex = this.symbolIndexByDef.get(decl.span.start) ?? this.symbolIndexByName.get(decl.ident)
    if (symbolIndex !== undefined) {
      const symbol = this.symbols[symbolIndex]
      const offset = this.findDataIdentOffset(decl)
      this.addHint(offset, decl.ident.length, symbol.type, symbolIndex, symbol.value)
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

  // Find the root identifier of a member expression chain (e.g., "c" for "c.x.y")
  // The symbol a name used at an expression is: the one defined where the
  // checker found it defined, or else, for a name the checker recorded no
  // use of, the module's name.
  // The def whose name is written where this expression is, and where its
  // name is: the copy of its value the parser put there (Module.defUses),
  // which the checker recorded as a use of it, also one the parser negated
  // (-k, a literal from the minus on). Not what the copy holds, nor an
  // expression that only starts there.
  private defUsedAt(expr: AST.Expr): { index: number; at: number } | undefined {
    if (expr.kind === 'IdentExpr') return undefined
    let at = expr.span.start
    if (this.source[at] === '-') {
      at++
      while (/\s/.test(this.source[at] ?? '')) at++
    }
    const declared = this.checkResult.symbolRefs.get(at)
    const index = declared !== undefined ? this.symbolIndexByDef.get(declared) : undefined
    const symbol = index !== undefined ? this.symbols[index] : undefined
    if (index === undefined || symbol?.kind !== 'def' || expr.span.end - at !== symbol.name.length) return undefined
    return { index, at }
  }

  private usedSymbol(expr: AST.IdentExpr): number | undefined {
    const def = this.checkResult.symbolRefs.get(expr.span.start)
    return def !== undefined ? this.symbolIndexByDef.get(def) : this.symbolIndexByName.get(expr.name)
  }

  private findRootIdent(expr: AST.Expr): AST.IdentExpr | null {
    if (expr.kind === 'IdentExpr') return expr
    if (expr.kind === 'MemberExpr') return this.findRootIdent(expr.object)
    if (expr.kind === 'IndexExpr') return this.findRootIdent(expr.object)
    return null
  }

  private addHint(
    offset: number,
    len: number,
    typeIndex: number,
    symbolIndex?: number,
    value?: string,
    expr?: string,
    parentKind?: MetaSymbol['kind'],
    inputParam?: boolean,
    exprStart?: number,
  ): void {
    if (this.within && (offset < this.within.start || offset >= this.within.end)) return
    const key = this.lineMap.positionKey(offset)
    this.hintOffsets.set(key, offset)
    const hint: MetaHint = { len, type: typeIndex }
    if (symbolIndex !== undefined) hint.symbol = symbolIndex
    if (value !== undefined) hint.value = value
    if (expr !== undefined) hint.expr = expr
    if (exprStart !== undefined) hint.exprStart = exprStart
    if (parentKind !== undefined) hint.parentKind = parentKind
    if (inputParam) hint.inputParam = true
    this.hints[key] = hint
  }
}

// === Type Registry ===

class TypeRegistry {
  private types: MetaType[] = []
  private typeIndex = new Map<string, number>()

  register(type: ResolvedType): number {
    // For named types (type aliases), register the underlying type
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

  // A type that exists only as text: the signature of a generic function
  registerText(key: string): number {
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

// The named fields written under a type, at any depth: the fields of a
// generic type's body, each where its name stands
function fieldsUnder(type: unknown, found: AST.Field[] = []): AST.Field[] {
  if (Array.isArray(type)) {
    for (const t of type) fieldsUnder(t, found)
  } else if (type !== null && typeof type === 'object' && !(type instanceof Uint8Array)) {
    const n = type as { kind?: string; ident?: unknown }
    if (n.kind === 'Field' && typeof n.ident === 'string') found.push(n as AST.Field)
    for (const [key, value] of Object.entries(n)) if (key !== 'span') fieldsUnder(value, found)
  }
  return found
}

// The lets of a body that write the type of the one name they declare
function writtenLets(node: unknown, found: AST.LetStmt[] = []): AST.LetStmt[] {
  if (Array.isArray(node)) {
    for (const n of node) writtenLets(n, found)
  } else if (node !== null && typeof node === 'object' && !(node instanceof Uint8Array)) {
    const n = node as Partial<AST.LetStmt> & { kind?: string }
    if (n.kind === 'LetStmt' && n.type && n.pattern?.kind === 'IdentPattern') found.push(n as AST.LetStmt)
    for (const [key, value] of Object.entries(n)) if (key !== 'span') writtenLets(value, found)
  }
  return found
}
