import * as ohm from 'ohm-js'
import type * as AST from './ast'
import type { Span } from './ast'
import { hexToBytes } from './utils'

// Per-parse defs map used to inline def values during parsing
// Stores both the value and optional type annotation for wrapping inlined expressions
let currentDefs: Map<string, { value: AST.Expr; type: AST.Type | undefined }> = new Map()

// Types for access suffixes parsed from grammar
type AccessSuffix =
  | { kind: 'field'; name: string }
  | { kind: 'tupleIndex'; value: number }
  | { kind: 'deref' }
  | { kind: 'typePun'; type: AST.Type }
  | { kind: 'index'; expr: AST.Expr }

// Types for postfix operations (AccessSuffix + call)
type PostfixOp = AccessSuffix | { kind: 'call'; args: AST.Arg[] }

// Helper to create span from Ohm source interval
function span(node: ohm.Node): Span {
  return {
    start: node.source.startIdx,
    end: node.source.endIdx,
  }
}

// Deep-clone an expression, overriding the top-level span
function cloneExprWithSpan(expr: AST.Expr, newSpan: Span): AST.Expr {
  switch (expr.kind) {
    case 'LiteralExpr':
      return { ...expr, span: newSpan }
    case 'IdentExpr':
      return { ...expr, span: newSpan }
    case 'BinaryExpr':
      return {
        ...expr,
        left: cloneExprWithSpan(expr.left, expr.left.span),
        right: cloneExprWithSpan(expr.right, expr.right.span),
        span: newSpan,
      }
    case 'UnaryExpr':
      return {
        ...expr,
        operand: cloneExprWithSpan(expr.operand, expr.operand.span),
        span: newSpan,
      }
    case 'CallExpr':
      return {
        ...expr,
        callee: cloneExprWithSpan(expr.callee, expr.callee.span),
        args: expr.args.map((a) => ({
          ...a,
          value: a.value ? cloneExprWithSpan(a.value, a.value.span) : null,
        })),
        span: newSpan,
      }
    case 'MemberExpr':
      return {
        ...expr,
        object: cloneExprWithSpan(expr.object, expr.object.span),
        span: newSpan,
      }
    case 'IndexExpr':
      return {
        ...expr,
        object: cloneExprWithSpan(expr.object, expr.object.span),
        index: cloneExprWithSpan(expr.index, expr.index.span),
        span: newSpan,
      }
    case 'IfExpr':
      return {
        ...expr,
        condition: cloneExprWithSpan(expr.condition, expr.condition.span),
        thenBranch: cloneFuncBodyWithSpan(expr.thenBranch),
        elifs: expr.elifs.map((e) => ({
          ...e,
          condition: cloneExprWithSpan(e.condition, e.condition.span),
          thenBranch: cloneFuncBodyWithSpan(e.thenBranch),
        })),
        else_: expr.else_ ? cloneFuncBodyWithSpan(expr.else_) : null,
        span: newSpan,
      }
    case 'TupleExpr':
      return {
        ...expr,
        elements: expr.elements.map((el) => ({
          ...el,
          value: el.value ? cloneExprWithSpan(el.value, el.value.span) : null,
        })),
        span: newSpan,
      }
    case 'GroupExpr':
      return { ...expr, expr: cloneExprWithSpan(expr.expr, expr.expr.span), span: newSpan }
    case 'CastExpr':
      return { ...expr, expr: cloneExprWithSpan(expr.expr, expr.expr.span), span: newSpan }
    case 'AnnotationExpr':
      return { ...expr, expr: cloneExprWithSpan(expr.expr, expr.expr.span), span: newSpan }
    case 'ArrayExpr':
      return { ...expr, elements: expr.elements.map((e) => cloneExprWithSpan(e, e.span)), span: newSpan }
    case 'RepeatExpr':
      return {
        ...expr,
        value: cloneExprWithSpan(expr.value, expr.value.span),
        count: cloneExprWithSpan(expr.count, expr.count.span),
        span: newSpan,
      }
    case 'MatchExpr':
      return {
        ...expr,
        subject: cloneExprWithSpan(expr.subject, expr.subject.span),
        arms: expr.arms.map((arm) => ({
          ...arm,
          body: cloneMatchBodyWithSpan(arm.body),
        })),
        span: newSpan,
      }
    default:
      return { ...expr, span: newSpan }
  }
}

function cloneFuncBodyWithSpan(body: AST.FuncBody): AST.FuncBody {
  if (body.kind === 'ArrowBody') {
    return { ...body, expr: cloneExprWithSpan(body.expr, body.expr.span) }
  }
  return { ...body, stmts: body.stmts.map((s) => cloneStmtWithSpan(s)) }
}

function cloneStmtWithSpan(stmt: AST.Statement): AST.Statement {
  switch (stmt.kind) {
    case 'LetStmt':
      return { ...stmt, value: stmt.value ? cloneExprWithSpan(stmt.value, stmt.value.span) : null }
    case 'SetStmt':
      return { ...stmt, value: cloneExprWithSpan(stmt.value, stmt.value.span) }
    case 'AssignmentStmt':
      return {
        ...stmt,
        target: cloneExprWithSpan(stmt.target as unknown as AST.Expr, stmt.target.span) as unknown as AST.LValue,
        value: cloneExprWithSpan(stmt.value, stmt.value.span),
      }
    case 'ReturnStmt':
      return { ...stmt, value: stmt.value ? cloneExprWithSpan(stmt.value, stmt.value.span) : null }
    case 'WhileStmt':
      return { ...stmt, condition: cloneExprWithSpan(stmt.condition, stmt.condition.span), body: cloneFuncBodyWithSpan(stmt.body) }
    default:
      return { ...stmt }
  }
}

function cloneMatchBodyWithSpan(body: AST.Expr | AST.FuncBody): AST.Expr | AST.FuncBody {
  return 'kind' in body
    ? (body.kind === 'Block' || body.kind === 'ArrowBody' ? cloneFuncBodyWithSpan(body as AST.FuncBody) : cloneExprWithSpan(body as AST.Expr, (body as AST.Expr).span))
    : body
}

// Helper to get first child if present
function first<T>(iter: ohm.IterationNode): T | null {
  return iter.children[0]?.toAST() ?? null
}

// Set dataId on literal expressions within a def value
// This allows the literal's ID to survive cloning during def substitution
function setDataIdOnLiteral(expr: AST.Expr): void {
  // Handle AnnotationExpr: [0;12]:[*_]u32 -> set dataId on inner literal
  if (expr.kind === 'AnnotationExpr') {
    setDataIdOnLiteral(expr.expr)
    return
  }
  // Set dataId on literal types using their span.start as the stable ID
  if (expr.kind === 'ArrayExpr' || expr.kind === 'RepeatExpr' || expr.kind === 'LiteralExpr') {
    (expr as AST.ArrayExpr | AST.RepeatExpr | AST.LiteralExpr).dataId = expr.span.start
  }
}

// Type for semantics operations - each rule handler receives Ohm nodes and returns AST nodes
type OhmNode = ohm.Node
type SemanticAction = (this: OhmNode, ...args: OhmNode[]) => unknown
type PatternWithType = {
  kind: 'PatternWithType'
  pattern: AST.Pattern
  type: AST.Type | null
  span: Span
}

// Semantics operations object with typed handlers
// Each method corresponds to a grammar rule and transforms Ohm nodes to AST nodes
export const semanticsActions: Record<string, SemanticAction> = {
  // ============================================================================
  // Module
  // ============================================================================

  // Module(decls: Iteration<Declaration>) -> Module
  Module(decls): AST.Module {
    // Reset defs for this module parse
    currentDefs = new Map()
    return {
      kind: 'Module',
      decls: decls.children.map((d: OhmNode) => d.toAST()),
      span: span(this),
    }
  },

  // Declaration(decl: Type | Func | Global | ...) -> any (union of all declaration types)
  Declaration(decl): AST.Declaration {
    return decl.toAST()
  },

  // ImportDecl_group(...) -> ImportDecl
  ImportDecl_group(_import, module, _lp, items, _rp): AST.ImportDecl {
    const moduleLit = module.toAST()
    const moduleName = new TextDecoder().decode(moduleLit.value.bytes)
    return {
      kind: 'ImportDecl',
      module: moduleName,
      items: items.children.map((i: ohm.Node) => i.toAST()),
      span: span(this),
    } as AST.ImportDecl
  },

  ImportDecl_single(_import, module, item): AST.ImportDecl {
    const moduleLit = module.toAST()
    const moduleName = new TextDecoder().decode(moduleLit.value.bytes)
    return {
      kind: 'ImportDecl',
      module: moduleName,
      items: [item.toAST()],
      span: span(this),
    } as AST.ImportDecl
  },

  ImportGroupItem(name, item): AST.ImportItem {
    const nameLit = name.toAST()
    const itemName = new TextDecoder().decode(nameLit.value.bytes)
    return {
      kind: 'ImportItem',
      name: itemName,
      item: item.toAST(),
      span: span(this),
    } as AST.ImportItem
  },

  ImportItem_func(_func, identOpt, sig): AST.ImportFunc {
    return {
      kind: 'ImportFunc',
      ident: first(identOpt),
      signature: sig.toAST(),
      span: span(this),
    } as AST.ImportFunc
  },

  ImportItem_global(_global, ident, typeAnnotation): AST.ImportGlobal {
    return {
      kind: 'ImportGlobal',
      ident: ident.toAST(),
      type: typeAnnotation.toAST(),
      span: span(this),
    } as AST.ImportGlobal
  },

  ExportDecl_named(_export, name, item): AST.ExportDecl {
    const literal = name.toAST()
    const exportName = new TextDecoder().decode(literal.value.bytes)
    return {
      kind: 'ExportDecl',
      name: exportName,
      item: item.toAST(),
      span: span(this),
    } as AST.ExportDecl
  },

  ExportDecl_unnamed(_export, item): AST.ExportDecl {
    const decl = item.toAST() as AST.FuncDecl | AST.GlobalDecl | AST.MemoryDecl
    let exportName: string
    if (decl.kind === 'FuncDecl') {
      if (!decl.ident) {
        throw new Error('Cannot export anonymous function without explicit name')
      }
      exportName = decl.ident
    } else if (decl.kind === 'GlobalDecl') {
      if (decl.pattern.kind !== 'IdentPattern') {
        throw new Error('Cannot export destructured global without explicit name')
      }
      exportName = decl.pattern.name
    } else {
      exportName = 'memory'
    }
    return {
      kind: 'ExportDecl',
      name: exportName,
      item: decl,
      span: span(this),
    } as AST.ExportDecl
  },

  Exportable(item): AST.Declaration {
    return item.toAST()
  },

  FuncDecl(inlineOpt, _func, identOpt, sig, body): AST.FuncDecl {
    return {
      kind: 'FuncDecl',
      inline: inlineOpt.sourceString !== '',
      ident: first(identOpt),
      signature: sig.toAST(),
      body: body.toAST(),
      span: span(this),
    } as AST.FuncDecl
  },

  // FuncSignature = BaseType ("->" Type)?
  // Uses symmetric input/output design
  // Ohm passes optional elements separately: BaseType, _arrow (optional iter), Type (optional iter)
  FuncSignature(input, _arrowOpt, outputOpt): AST.FuncSignature {
    const inputAST = input.toAST()
    // If return is omitted, default to void (empty composite type)
    const outputAST = first(outputOpt) ?? ({ kind: 'CompositeType', fields: [], span: span(this) } as AST.CompositeType)
    return {
      kind: 'FuncSignature',
      input: inputAST,
      output: outputAST,
      span: span(this),
    } as AST.FuncSignature
  },

  FieldList(list) {
    return list.asIteration().children.map((f: ohm.Node) => f.toAST())
  },

  Field_named(ident, typeAnnotation) {
    return {
      kind: 'Field',
      ident: ident.toAST(),
      type: typeAnnotation.toAST(),
      span: span(this),
    } as AST.Field
  },

  Field_anonymous(type) {
    return {
      kind: 'Field',
      ident: null,
      type: type.toAST(),
      span: span(this),
    } as AST.Field
  },

  TypeAnnotation(_colon, type) {
    return type.toAST()
  },

  Assign(_eq, expr) {
    return expr.toAST()
  },

  PatternWithType(pattern, typeOpt) {
    return {
      kind: 'PatternWithType',
      pattern: pattern.toAST(),
      type: first(typeOpt),
      span: span(this),
    } satisfies PatternWithType
  },

  Body_block(block) {
    return block.toAST()
  },

  Body_arrow(_arrow, expr) {
    return {
      kind: 'ArrowBody',
      expr: expr.toAST(),
      span: span(this),
    } as AST.ArrowBody
  },

  Block(_lb, stmts, _rb) {
    return {
      kind: 'Block',
      stmts: stmts.children.map((s: ohm.Node) => s.toAST()),
      span: span(this),
    } as AST.Block
  },

  TypeDecl(_type, ident, _eq, type) {
    return {
      kind: 'TypeDecl',
      ident: ident.toAST(),
      type: type.toAST(),
      span: span(this),
    } as AST.TypeDecl
  },

  EnumDecl(_enum, ident, _lb, variants, _rb) {
    return {
      kind: 'EnumDecl',
      ident: ident.sourceString,
      variants: variants.children.map((v: ohm.Node) => v.toAST()),
      span: span(this),
    } as AST.EnumDecl
  },

  // EnumVariant = typeIdent ("(" FieldList ")")? ","?
  // Ohm passes optional group elements separately: typeIdent, "("?, FieldList?, ")"?, ","?
  EnumVariant(name, _lpOpt, fieldsOpt, _rpOpt, _commaOpt) {
    const fields = first<AST.Field[]>(fieldsOpt)
    return {
      kind: 'EnumVariant',
      name: name.sourceString,
      fields: fields ?? null,
      span: span(this),
    } as AST.EnumVariant
  },

  DefDecl_typed(_def, ident, _colon, type, assign) {
    const value = assign.toAST() as AST.Expr
    const typeAnnotation = type.toAST() as AST.Type
    setDataIdOnLiteral(value)
    currentDefs.set(ident.toAST() as string, { value, type: typeAnnotation })
    return {
      kind: 'DefDecl',
      ident: ident.toAST(),
      type: typeAnnotation,
      value,
      span: span(this),
    } as AST.DefDecl
  },

  DefDecl_bare(_def, ident, assign) {
    const value = assign.toAST() as AST.Expr
    setDataIdOnLiteral(value)
    currentDefs.set(ident.toAST() as string, { value, type: undefined })
    return {
      kind: 'DefDecl',
      ident: ident.toAST(),
      type: undefined,
      value,
      span: span(this),
    } as AST.DefDecl
  },

  DefDecl_reserve(_def, ident, _colon, type) {
    const typeAnnotation = type.toAST() as AST.Type
    // Synthesize a zero-initialized repeat expression from the array type
    let totalSize = 0
    let elemType: AST.Type = typeAnnotation
    if (typeAnnotation.kind === 'IndexedType' && typeAnnotation.size !== null) {
      const sizes = Array.isArray(typeAnnotation.size) ? typeAnnotation.size : [typeAnnotation.size]
      totalSize = (sizes as number[]).reduce((a, b) => a * b, 1)
      elemType = typeAnnotation.element
      // For multi-dim, flatten to 1D: def x:[12,16]u8 → [0:u8; 192]
    }
    const zeroLit: AST.LiteralExpr = {
      kind: 'LiteralExpr',
      value: { kind: 'int', value: 0n },
      span: span(this),
    }
    const annotatedZero: AST.AnnotationExpr = {
      kind: 'AnnotationExpr',
      expr: zeroLit,
      type: elemType,
      span: span(this),
    }
    const countLit: AST.LiteralExpr = {
      kind: 'LiteralExpr',
      value: { kind: 'int', value: BigInt(totalSize) },
      span: span(this),
    }
    const syntheticValue: AST.RepeatExpr = {
      kind: 'RepeatExpr',
      value: annotatedZero,
      count: countLit,
      mut: true,
      span: span(this),
    }
    setDataIdOnLiteral(syntheticValue)
    const ptrType: AST.PointerType = {
      kind: 'PointerType',
      pointee: typeAnnotation,
      span: span(this),
    }
    currentDefs.set(ident.toAST() as string, { value: syntheticValue, type: ptrType })
    return {
      kind: 'DefDecl',
      ident: ident.toAST(),
      type: ptrType,
      value: syntheticValue,
      span: span(this),
    } as AST.DefDecl
  },

  GlobalDecl(_global, patternWithType, assignOpt) {
    const pwt = patternWithType.toAST() as PatternWithType
    const value = first<AST.Expr>(assignOpt)
    return {
      kind: 'GlobalDecl',
      pattern: pwt.pattern,
      type: pwt.type,
      value,
      span: span(this),
    } as AST.GlobalDecl
  },

  MemoryDecl_sized(_memory, min, maxOpt) {
    return {
      kind: 'MemoryDecl',
      min: Number(min.sourceString),
      max: maxOpt.children[0] ? Number(maxOpt.children[0].sourceString) : null,
      span: span(this),
    } as AST.MemoryDecl
  },

  MemoryDecl_bare(_memory) {
    return {
      kind: 'MemoryDecl',
      min: null,
      max: null,
      span: span(this),
    } as AST.MemoryDecl
  },

  // ============================================================================
  // Types
  // ============================================================================

  // Type = BaseType "->" Type   -- func
  //      | BaseType             -- base
  Type_func(inputType, _arrow, outputType): AST.FuncType {
    return {
      kind: 'FuncType',
      input: inputType.toAST(),
      output: outputType.toAST(),
      span: span(this),
    } as AST.FuncType
  },

  Type_base(baseType): AST.Type {
    return baseType.toAST()
  },

  // []T - slice (fat pointer with ptr+len)
  BaseType_slice(_brackets, element) {
    return {
      kind: 'IndexedType',
      element: element.toAST(),
      size: null,
      specifiers: [],
      span: span(this),
    } as AST.IndexedType
  },

  // [*]T - many-pointer (thin, just ptr)
  BaseType_manyPointer(_brackets, element) {
    const result: AST.IndexedType = {
      kind: 'IndexedType',
      element: element.toAST(),
      size: null,
      specifiers: [],
      span: span(this),
    }
    result.manyPointer = true
    return result
  },

  // [framings]T - array with size/framing
  // [5]T, [12,16]T, [!]T, [5,!]T, etc
  // Note: *[N]T is now parsed as pointer -> array via nested rules
  BaseType_array(_lb, framings, _rb, element) {
    const { size, specifiers } = framings.toAST() as { size: number | number[] | 'inferred' | null; specifiers: AST.IndexSpecifier[] }
    return {
      kind: 'IndexedType',
      element: element.toAST(),
      size,
      specifiers,
      span: span(this),
    } as AST.IndexedType
  },

  // Comma-separated framings: dimensions and/or specifiers
  // [5] -> size=5, [5,16] -> size=[5,16], [!] -> specifier, [5,!] -> size=5 + specifier
  arrayFramings(first, _commas, rest) {
    const all = [first.toAST(), ...rest.children.map((f: OhmNode) => f.toAST())]

    // Separate size items (numbers, 'inferred') from specifiers (objects)
    const sizeItems: (number | 'inferred')[] = []
    const specifiers: AST.IndexSpecifier[] = []

    for (const item of all) {
      if (typeof item === 'number' || item === 'inferred') {
        sizeItems.push(item)
      } else {
        specifiers.push(item as AST.IndexSpecifier)
      }
    }

    // Determine size
    let size: number | number[] | 'inferred' | null = null
    if (sizeItems.includes('inferred')) {
      size = 'inferred'
    } else if (sizeItems.length === 1) {
      size = sizeItems[0] as number
    } else if (sizeItems.length > 1) {
      size = sizeItems as number[]
    }

    return { size, specifiers }
  },

  // Framing: _ (inferred length)
  arrayFraming_inferred(_underscore) {
    return 'inferred' as const
  },

  // Framing: decimal digits (explicit length)
  arrayFraming_explicit(digits) {
    return Number(digits.sourceString)
  },

  // Framing: ! (null-terminated)
  arrayFraming_nullTerminated(_bang) {
    return { kind: 'null' } as AST.IndexSpecifier
  },

  // Framing: ? (LEB128 prefix)
  arrayFraming_leb128Prefixed(_qmark) {
    return { kind: 'prefix' } as AST.IndexSpecifier
  },

  BaseType_pointer(_star, type) {
    return {
      kind: 'PointerType',
      pointee: type.toAST(),
      span: span(this),
    } as AST.PointerType
  },

  BaseType_composite(_lp, fieldListOpt, _rp) {
    return {
      kind: 'CompositeType',
      fields: first(fieldListOpt) ?? [],
      span: span(this),
    } as AST.CompositeType
  },

  BaseType_comptimeScalar(comptime) {
    return comptime.toAST()
  },

  BaseType_primitive(prim) {
    return prim.toAST()
  },

  BaseType_named(typeIdent) {
    return typeIdent.toAST()
  },

  ComptimeType_int(_int, _lp, value, _rp) {
    const ast = value.toAST() as AST.LiteralExpr
    return {
      kind: 'ComptimeIntType',
      value: ast.value.kind === 'int' ? ast.value.value : BigInt(0),
      span: span(this),
    } as AST.ComptimeIntType
  },

  ComptimeType_float(_float, _lp, value, _rp) {
    const ast = value.toAST() as AST.LiteralExpr
    return {
      kind: 'ComptimeFloatType',
      value: ast.value.kind === 'float' ? ast.value.value : 0,
      span: span(this),
    } as AST.ComptimeFloatType
  },

  PrimitiveType(name) {
    return {
      kind: 'PrimitiveType',
      name: name.sourceString as AST.PrimitiveType['name'],
      span: span(this),
    } as AST.PrimitiveType
  },

  // typeIdent = upperStart identChar*
  typeIdent(_first, _rest) {
    return {
      kind: 'TypeRef',
      name: this.sourceString,
      span: span(this),
    } as AST.TypeRef
  },

  // ============================================================================
  // Statements
  // ============================================================================

  Statement(stmt): AST.Statement {
    return stmt.toAST()
  },

  LetStmt(_let, patternWithType, assignOpt): AST.LetStmt {
    const pwt = patternWithType.toAST() as PatternWithType
    const value = first<AST.Expr>(assignOpt)
    return {
      kind: 'LetStmt',
      pattern: pwt.pattern,
      type: pwt.type,
      value,
      span: span(this),
    } as AST.LetStmt
  },

  SetStmt(_set, patternWithType, assign): AST.SetStmt {
    const pwt = patternWithType.toAST() as PatternWithType
    const value = assign.toAST() as AST.Expr
    return {
      kind: 'SetStmt',
      pattern: pwt.pattern,
      type: pwt.type,
      value,
      span: span(this),
    } as AST.SetStmt
  },

  WhileStmt(_while, condition, body): AST.WhileStmt {
    return {
      kind: 'WhileStmt',
      condition: condition.toAST(),
      body: body.toAST(),
      span: span(this),
    } as AST.WhileStmt
  },

  ForStmt(_for, binding, _in, iterable, body): AST.ForStmt {
    return {
      kind: 'ForStmt',
      binding: binding.toAST(),
      iterable: iterable.toAST(),
      body: body.toAST(),
      span: span(this),
    } as AST.ForStmt
  },

  ForBinding_withIndex(value, _comma, index) {
    return {
      kind: 'ForBinding',
      value: value.toAST(),
      index: index.toAST(),
      span: span(this),
    } as AST.ForBinding
  },

  ForBinding_valueOnly(value) {
    return {
      kind: 'ForBinding',
      value: value.toAST(),
      index: null,
      span: span(this),
    } as AST.ForBinding
  },

  LoopStmt(_loop, body) {
    return {
      kind: 'LoopStmt',
      body: body.toAST(),
      span: span(this),
    } as AST.LoopStmt
  },

  ReturnStmt(_return, exprOpt, whenOpt) {
    return {
      kind: 'ReturnStmt',
      value: first(exprOpt),
      when: first(whenOpt),
      span: span(this),
    } as AST.ReturnStmt
  },

  BreakStmt(_break, whenOpt) {
    return {
      kind: 'BreakStmt',
      when: first(whenOpt),
      span: span(this),
    } as AST.BreakStmt
  },

  ContinueStmt(_continue, whenOpt) {
    return {
      kind: 'ContinueStmt',
      when: first(whenOpt),
      span: span(this),
    } as AST.ContinueStmt
  },

  WhenClause(_when, expr) {
    return expr.toAST()
  },

  AssignmentStmt(target, op, value) {
    return {
      kind: 'AssignmentStmt',
      target: target.toAST(),
      op: op.sourceString as AST.AssignOp,
      value: value.toAST(),
      span: span(this),
    } as AST.AssignmentStmt
  },

  ExpressionStmt(expr) {
    return {
      kind: 'ExpressionStmt',
      expr: expr.toAST(),
      span: span(this),
    } as AST.ExpressionStmt
  },

  // ============================================================================
  // L-Values: ident AccessSuffix*
  // ============================================================================

  LValue(ident, suffixes) {
    let result: AST.Expr = {
      kind: 'IdentExpr',
      name: ident.toAST(),
      span: span(ident),
    }

    for (const suffix of suffixes.children) {
      result = applySuffix(result, suffix.toAST(), span(suffix))
    }

    return result
  },

  // ============================================================================
  // Access Suffixes (shared by LValue and PostfixExpr)
  // ============================================================================

  AccessSuffix_field(_dot, field) {
    return { kind: 'field', name: field.sourceString }
  },

  AccessSuffix_tupleIndex(_dot, digits) {
    return { kind: 'tupleIndex', value: Number(digits.sourceString) }
  },

  AccessSuffix_deref(_dot, _star) {
    return { kind: 'deref' }
  },

  AccessSuffix_typePun(_dot, type) {
    return { kind: 'typePun', type: type.toAST() }
  },

  AccessSuffix_index(_lb, expr, _rb) {
    return { kind: 'index', expr: expr.toAST() }
  },

  // ============================================================================
  // Patterns
  // ============================================================================

  Pattern_tuple(_lp, list, _rp) {
    return {
      kind: 'TuplePattern',
      elements: list.toAST(),
      span: span(this),
    } as AST.TuplePattern
  },

  Pattern_ident(ident) {
    return {
      kind: 'IdentPattern',
      name: ident.toAST(),
      span: span(this),
    } as AST.IdentPattern
  },

  PatternList(list) {
    return list.asIteration().children.map((e: ohm.Node) => e.toAST())
  },

  PatternElem_namedExplicit(field, _colon, binding) {
    return {
      kind: 'named',
      field: field.sourceString,
      binding: binding.sourceString,
    } as AST.PatternElement
  },

  PatternElem_namedShort(field, _colon) {
    return {
      kind: 'named',
      field: field.sourceString,
      binding: null,
    } as AST.PatternElement
  },

  PatternElem_positional(pattern) {
    return {
      kind: 'positional',
      pattern: pattern.toAST(),
    } as AST.PatternElement
  },

  // ============================================================================
  // Expressions
  // ============================================================================

  Expr(expr): AST.Expr {
    return expr.toAST()
  },

  OrExpr_or(left, _op, right): AST.BinaryExpr {
    return {
      kind: 'BinaryExpr',
      op: '||',
      left: left.toAST(),
      right: right.toAST(),
      span: span(this),
    } as AST.BinaryExpr
  },

  OrExpr(expr) {
    return expr.toAST()
  },

  AndExpr_and(left, _op, right) {
    return {
      kind: 'BinaryExpr',
      op: '&&',
      left: left.toAST(),
      right: right.toAST(),
      span: span(this),
    } as AST.BinaryExpr
  },

  AndExpr(expr) {
    return expr.toAST()
  },

  NotExpr_not(_op, operand) {
    return {
      kind: 'UnaryExpr',
      op: '!',
      operand: operand.toAST(),
      span: span(this),
    } as AST.UnaryExpr
  },

  NotExpr(expr) {
    return expr.toAST()
  },

  CompareExpr_compare(left, op, right) {
    return {
      kind: 'BinaryExpr',
      op: op.sourceString as AST.BinaryOp,
      left: left.toAST(),
      right: right.toAST(),
      span: span(this),
    } as AST.BinaryExpr
  },

  CompareExpr(expr) {
    return expr.toAST()
  },

  BitOrExpr_or(left, _op, right) {
    return {
      kind: 'BinaryExpr',
      op: '|',
      left: left.toAST(),
      right: right.toAST(),
      span: span(this),
    } as AST.BinaryExpr
  },

  BitOrExpr(expr) {
    return expr.toAST()
  },

  BitXorExpr_xor(left, _op, right) {
    return {
      kind: 'BinaryExpr',
      op: '^',
      left: left.toAST(),
      right: right.toAST(),
      span: span(this),
    } as AST.BinaryExpr
  },

  BitXorExpr(expr) {
    return expr.toAST()
  },

  BitAndExpr_and(left, _op, right) {
    return {
      kind: 'BinaryExpr',
      op: '&',
      left: left.toAST(),
      right: right.toAST(),
      span: span(this),
    } as AST.BinaryExpr
  },

  BitAndExpr(expr) {
    return expr.toAST()
  },

  ShiftExpr_shift(left, op, right) {
    return {
      kind: 'BinaryExpr',
      op: op.sourceString as AST.BinaryOp,
      left: left.toAST(),
      right: right.toAST(),
      span: span(this),
    } as AST.BinaryExpr
  },

  ShiftExpr(expr) {
    return expr.toAST()
  },

  AddExpr_add(left, op, right) {
    return {
      kind: 'BinaryExpr',
      op: op.sourceString as AST.BinaryOp,
      left: left.toAST(),
      right: right.toAST(),
      span: span(this),
    } as AST.BinaryExpr
  },

  AddExpr(expr) {
    return expr.toAST()
  },

  MulExpr_mul(left, op, right) {
    return {
      kind: 'BinaryExpr',
      op: op.sourceString as AST.BinaryOp,
      left: left.toAST(),
      right: right.toAST(),
      span: span(this),
    } as AST.BinaryExpr
  },

  MulExpr(expr) {
    return expr.toAST()
  },

  UnaryExpr_neg(_op, operand) {
    return {
      kind: 'UnaryExpr',
      op: '-',
      operand: operand.toAST(),
      span: span(this),
    } as AST.UnaryExpr
  },

  UnaryExpr_complement(_op, operand) {
    return {
      kind: 'UnaryExpr',
      op: '~',
      operand: operand.toAST(),
      span: span(this),
    } as AST.UnaryExpr
  },

  UnaryExpr_ref(_op, operand) {
    return {
      kind: 'UnaryExpr',
      op: '&',
      operand: operand.toAST(),
      span: span(this),
    } as AST.UnaryExpr
  },

  UnaryExpr_mut(_mut, operand) {
    const expr = operand.toAST() as AST.Expr
    // Set mut flag on the literal (or on the inner literal if wrapped in AnnotationExpr)
    if (expr.kind === 'LiteralExpr' || expr.kind === 'ArrayExpr' ||
        expr.kind === 'RepeatExpr' || expr.kind === 'TupleExpr') {
      expr.mut = true
      return expr
    }
    if (expr.kind === 'AnnotationExpr') {
      const inner = expr.expr
      if (inner.kind === 'LiteralExpr' || inner.kind === 'ArrayExpr' ||
          inner.kind === 'RepeatExpr' || inner.kind === 'TupleExpr') {
        inner.mut = true
        return expr
      }
    }
    throw new Error(`mut can only be applied to literals (arrays, strings, tuples), not ${expr.kind}`)
  },

  UnaryExpr(expr) {
    return expr.toAST()
  },

  CastExpr_cast(expr, _as, type) {
    return {
      kind: 'CastExpr',
      expr: expr.toAST(),
      type: type.toAST(),
      span: span(this),
    } as AST.CastExpr
  },

  CastExpr_annotation(expr, typeAnnotation) {
    return {
      kind: 'AnnotationExpr',
      expr: expr.toAST(),
      type: typeAnnotation.toAST(),
      span: span(this),
    } as AST.AnnotationExpr
  },

  CastExpr(expr) {
    return expr.toAST()
  },

  // ============================================================================
  // Postfix: PrimaryExpr PostfixOp*
  // ============================================================================

  PostfixExpr(primary, ops) {
    let result = primary.toAST()

    for (const op of ops.children) {
      result = applyPostfixOp(result, op.toAST(), span(op))
    }

    return result
  },

  PostfixOp(suffix) {
    return suffix.toAST()
  },

  PostfixOp_call(_lp, argsOpt, _rp) {
    return { kind: 'call', args: first(argsOpt) ?? [] }
  },

  // ============================================================================
  // Primary Expressions
  // ============================================================================

  PrimaryExpr(expr) {
    // Handle ident specially - it returns a string but needs to be IdentExpr here
    if (expr.ctorName === 'ident') {
      const name = expr.toAST() as string
      const def = currentDefs.get(name)
      if (def) {
        // Inline the def value, retargeting the span to the identifier's span
        const clonedValue = cloneExprWithSpan(def.value, span(expr))
        // If def has a type annotation, wrap in AnnotationExpr so type propagates
        if (def.type) {
          return {
            kind: 'AnnotationExpr',
            expr: clonedValue,
            type: def.type,
            span: span(expr),
          } as AST.AnnotationExpr
        }
        return clonedValue
      }
      return {
        kind: 'IdentExpr',
        name,
        span: span(expr),
      } as AST.IdentExpr
    }
    return expr.toAST()
  },

  PrimaryExpr_tupleOrStruct(_lp, args, _rp) {
    return {
      kind: 'TupleExpr',
      elements: args.toAST(),
      span: span(this),
    } as AST.TupleExpr
  },

  PrimaryExpr_group(_lp, expr, _rp) {
    return {
      kind: 'GroupExpr',
      expr: expr.toAST(),
      span: span(this),
    } as AST.GroupExpr
  },

  PrimaryExpr_unit(_lp, _rp) {
    return {
      kind: 'TupleExpr',
      elements: [],
      span: span(this),
    } as AST.TupleExpr
  },

  PrimaryExpr_sizeof(_sizeof, _lp, typeNode, _rp) {
    return {
      kind: 'SizeofExpr',
      type: typeNode.toAST(),
      span: span(this),
    } as AST.SizeofExpr
  },

  PrimaryExpr_constructor(typeName, _lp, argsOpt, _rp) {
    return {
      kind: 'CallExpr',
      callee: {
        kind: 'IdentExpr',
        name: typeName.sourceString,
        span: span(typeName),
      } as AST.IdentExpr,
      args: first(argsOpt) ?? [],
      span: span(this),
    } as AST.CallExpr
  },

  // ============================================================================
  // If Expression
  // ============================================================================

  IfExpr_ifLet(_if, _let, pattern, _eq, condition, then, elifs, elseOpt) {
    return {
      kind: 'IfExpr',
      pattern: pattern.toAST(),
      condition: condition.toAST(),
      thenBranch: then.toAST(),
      elifs: elifs.children.map((e: ohm.Node) => e.toAST()),
      else_: first(elseOpt),
      span: span(this),
    } as AST.IfExpr
  },

  IfExpr_if(_if, condition, then, elifs, elseOpt) {
    return {
      kind: 'IfExpr',
      pattern: null,
      condition: condition.toAST(),
      thenBranch: then.toAST(),
      elifs: elifs.children.map((e: ohm.Node) => e.toAST()),
      else_: first(elseOpt),
      span: span(this),
    } as AST.IfExpr
  },

  ElifBranch_elifLet(_elif, _let, pattern, _eq, condition, then) {
    return {
      kind: 'ElifBranch',
      pattern: pattern.toAST(),
      condition: condition.toAST(),
      thenBranch: then.toAST(),
      span: span(this),
    } as AST.ElifBranch
  },

  ElifBranch_elif(_elif, condition, then) {
    return {
      kind: 'ElifBranch',
      pattern: null,
      condition: condition.toAST(),
      thenBranch: then.toAST(),
      span: span(this),
    } as AST.ElifBranch
  },

  ElseBranch(_else, body) {
    return body.toAST()
  },

  // ============================================================================
  // Match Expression
  // ============================================================================

  MatchExpr(_match, subject, _lb, arms, _rb) {
    return {
      kind: 'MatchExpr',
      subject: subject.toAST(),
      arms: arms.children.map((a: ohm.Node) => a.toAST()),
      span: span(this),
    } as AST.MatchExpr
  },

  MatchArm(patterns, _arrow, body, _comma) {
    return {
      kind: 'MatchArm',
      patterns: patterns.toAST(),
      body: body.toAST(),
      span: span(this),
    } as AST.MatchArm
  },

  MatchPatterns(list) {
    return list.asIteration().children.map((p: ohm.Node) => p.toAST())
  },

  MatchPattern_constructor(typeIdent, _lp, elements, _rp) {
    return {
      kind: 'constructor',
      type: typeIdent.sourceString,
      elements: elements.toAST(),
    } as AST.MatchPattern
  },

  MatchPattern_tuple(_lp, elements, _rp) {
    return {
      kind: 'tuple',
      elements: elements.toAST(),
    } as AST.MatchPattern
  },

  MatchPattern_variant(typeIdent) {
    return {
      kind: 'variant',
      type: typeIdent.sourceString,
    } as AST.MatchPattern
  },

  MatchPattern_binding(ident) {
    return {
      kind: 'binding',
      name: ident.sourceString,
    } as AST.MatchPattern
  },

  MatchPattern_literal(lit) {
    return {
      kind: 'literal',
      value: lit.toAST().value,
    } as AST.MatchPattern
  },

  MatchPattern_wildcard(_underscore) {
    return { kind: 'wildcard' } as AST.MatchPattern
  },

  MatchPatternList(list) {
    return list.asIteration().children.map((e: ohm.Node) => e.toAST())
  },

  MatchPatternElem_named(ident, _colon, pattern) {
    return {
      kind: 'named',
      field: ident.sourceString,
      pattern: pattern.toAST(),
    } as AST.MatchPatternElement
  },

  MatchPatternElem_namedShort(ident, _colon) {
    return {
      kind: 'namedShort',
      field: ident.sourceString,
    } as AST.MatchPatternElement
  },

  MatchPatternElem_positional(pattern) {
    return {
      kind: 'positional',
      pattern: pattern.toAST(),
    } as AST.MatchPatternElement
  },

  // ============================================================================
  // Arguments
  // ============================================================================

  ArgList(list) {
    return list.asIteration().children.map((a: ohm.Node) => a.toAST())
  },

  Arg_named(name, _colon, expr) {
    return {
      kind: 'Arg',
      name: name.sourceString,
      value: expr.toAST(),
      span: span(this),
    } as AST.Arg
  },

  Arg_shorthand(name, _colon) {
    return {
      kind: 'Arg',
      name: name.sourceString,
      value: null,
      span: span(this),
    } as AST.Arg
  },

  Arg_positional(expr) {
    return {
      kind: 'Arg',
      name: null,
      value: expr.toAST(),
      span: span(this),
    } as AST.Arg
  },

  // ============================================================================
  // Literals
  // ============================================================================

  literal(lit) {
    return lit.toAST()
  },

  ArrayLiteral_repeat(_lb, value, _semi, count, _rb) {
    return {
      kind: 'RepeatExpr',
      value: value.toAST(),
      count: count.toAST(),
      span: span(this),
    } as AST.RepeatExpr
  },

  ArrayLiteral_list(_lb, elements, _rb) {
    return {
      kind: 'ArrayExpr',
      elements: elements.asIteration().children.map((e: ohm.Node) => e.toAST()),
      span: span(this),
    } as AST.ArrayExpr
  },

  numberLiteral(num) {
    return num.toAST()
  },

  intLiteral(negOpt, num) {
    const isNeg = negOpt.sourceString === '-'
    const ast = num.toAST()
    if (isNeg && ast.value.kind === 'int') {
      ast.value.value = -ast.value.value
    }
    return ast
  },

  decimalLiteral(_digits) {
    return {
      kind: 'LiteralExpr',
      value: { kind: 'int', value: BigInt(this.sourceString), radix: 10 },
      span: span(this),
    } as AST.LiteralExpr
  },

  hexLiteral(_prefix, _digits) {
    return {
      kind: 'LiteralExpr',
      value: { kind: 'int', value: BigInt(this.sourceString), radix: 16 },
      span: span(this),
    } as AST.LiteralExpr
  },

  binaryLiteral(_prefix, _digits) {
    return {
      kind: 'LiteralExpr',
      value: { kind: 'int', value: BigInt(this.sourceString), radix: 2 },
      span: span(this),
    } as AST.LiteralExpr
  },

  octalLiteral(_prefix, _digits) {
    return {
      kind: 'LiteralExpr',
      value: { kind: 'int', value: BigInt(this.sourceString), radix: 8 },
      span: span(this),
    } as AST.LiteralExpr
  },

  dozenalLiteral(_prefix, _digits) {
    const str = this.sourceString.slice(2)
    let value = 0n
    for (const c of str) {
      value *= 12n
      if (c >= '0' && c <= '9') {
        value += BigInt(c.charCodeAt(0) - 48)
      } else if (c === 'a' || c === 'A') {
        value += 10n
      } else if (c === 'b' || c === 'B') {
        value += 11n
      }
    }
    return {
      kind: 'LiteralExpr',
      value: { kind: 'int', value, radix: 12 as 12 },
      span: span(this),
    } as AST.LiteralExpr
  },

  floatLiteral(_neg, _int, _dot, _frac, _exp) {
    return {
      kind: 'LiteralExpr',
      value: { kind: 'float', value: parseFloat(this.sourceString) },
      span: span(this),
    } as AST.LiteralExpr
  },

  stringLiteral(str) {
    return str.toAST()
  },

  utf8String(_lq, chars, _rq) {
    const str = chars.children.map((c: ohm.Node) => c.toAST()).join('')
    const bytes = new TextEncoder().encode(str)
    return {
      kind: 'LiteralExpr',
      value: { kind: 'string', bytes },
      span: span(this),
    } as AST.LiteralExpr
  },

  charString(_lq, chars, _rq) {
    const str = chars.children.map((c: ohm.Node) => c.toAST()).join('')
    const bytes = new TextEncoder().encode(str)
    return {
      kind: 'LiteralExpr',
      value: { kind: 'string', bytes },
      span: span(this),
    } as AST.LiteralExpr
  },

  hexString(_prefix, hexChars, _rq) {
    const hex = hexChars.sourceString.replace(/\s+/g, '')
    const bytes = hexToBytes(hex)
    return {
      kind: 'LiteralExpr',
      value: { kind: 'string', bytes },
      span: span(this),
    } as AST.LiteralExpr
  },

  base64String(_prefix, b64Chars, _rq) {
    const b64 = b64Chars.sourceString.replace(/\s+/g, '')
    // Decode base64 to bytes
    const binStr = atob(b64)
    const bytes = new Uint8Array(binStr.length)
    for (let i = 0; i < binStr.length; i++) {
      bytes[i] = binStr.charCodeAt(i)
    }
    return {
      kind: 'LiteralExpr',
      value: { kind: 'string', bytes },
      span: span(this),
    } as AST.LiteralExpr
  },

  utf8Char(char) {
    return char.toAST()
  },

  escapeSeq_hex(_backslash, _x, d1, d2) {
    return String.fromCharCode(parseInt(d1.sourceString + d2.sourceString, 16))
  },

  escapeSeq_simple(_backslash, char) {
    const c = char.sourceString
    switch (c) {
      case 'n':
        return '\n'
      case 't':
        return '\t'
      case 'r':
        return '\r'
      case '\\':
        return '\\'
      case '"':
        return '"'
      case "'":
        return "'"
      default:
        return c
    }
  },

  boolLiteral(bool) {
    return {
      kind: 'LiteralExpr',
      value: { kind: 'bool', value: bool.sourceString === 'true' },
      span: span(this),
    } as AST.LiteralExpr
  },

  // ============================================================================
  // Identifiers
  // ============================================================================

  ident(_first, _rest) {
    return this.sourceString
  },

  // ============================================================================
  // Fallbacks
  // ============================================================================

  _terminal() {
    return this.sourceString
  },

  _iter(...children) {
    return children.map((c: ohm.Node) => c.toAST())
  },
}

// Create semantics instance and add operations (consumer provides grammar)
export function createSemantics(grammar: ohm.Grammar): ohm.Semantics {
  return grammar.createSemantics().addOperation<unknown>('toAST', semanticsActions)
}

// ============================================================================
// Helper: Apply suffix to build AST node
// ============================================================================

function applySuffix(base: AST.Expr, suffix: AccessSuffix, suffixSpan: Span): AST.Expr {
  switch (suffix.kind) {
    case 'field':
      return {
        kind: 'MemberExpr',
        object: base,
        member: { kind: 'field', name: suffix.name },
        span: { start: base.span.start, end: suffixSpan.end },
      } as AST.MemberExpr

    case 'tupleIndex':
      return {
        kind: 'MemberExpr',
        object: base,
        member: { kind: 'index', value: suffix.value },
        span: { start: base.span.start, end: suffixSpan.end },
      } as AST.MemberExpr

    case 'deref':
      return {
        kind: 'MemberExpr',
        object: base,
        member: { kind: 'deref' },
        span: { start: base.span.start, end: suffixSpan.end },
      } as AST.MemberExpr

    case 'typePun':
      return {
        kind: 'MemberExpr',
        object: base,
        member: { kind: 'type', type: suffix.type },
        span: { start: base.span.start, end: suffixSpan.end },
      } as AST.MemberExpr

    case 'index':
      return {
        kind: 'IndexExpr',
        object: base,
        index: suffix.expr,
        span: { start: base.span.start, end: suffixSpan.end },
      } as AST.IndexExpr
  }
}

function applyPostfixOp(base: AST.Expr, op: PostfixOp, opSpan: Span): AST.Expr {
  if (op.kind === 'call') {
    return {
      kind: 'CallExpr',
      callee: base,
      args: op.args,
      span: { start: base.span.start, end: opSpan.end },
    } as AST.CallExpr
  }

  // Otherwise it's an AccessSuffix
  return applySuffix(base, op, opSpan)
}
