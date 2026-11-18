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
  | { kind: 'slice'; start: AST.Expr | null; end: AST.Expr | null }

// Types for postfix operations (AccessSuffix + call)
type PostfixOp = AccessSuffix | { kind: 'call'; args: AST.Arg[] }

// Helper to create span from Ohm source interval
function span(node: ohm.Node): Span {
  return {
    start: node.source.startIdx,
    end: node.source.endIdx,
  }
}

// A type written as a call argument
function typeArg(type: ohm.Node): AST.Arg {
  const value: AST.TypeExpr = { kind: 'TypeExpr', type: type.toAST(), span: span(type) }
  return { kind: 'Arg', name: null, value, span: span(type) }
}

function funcSignature(input: ohm.Node, outputOpt: ohm.IterationNode, at: Span): AST.FuncSignature {
  const inputAST = input.toAST()
  // If return is omitted, default to void (empty composite type)
  const outputAST = first<AST.Type>(outputOpt) ?? ({ kind: 'CompositeType', fields: [], span: at } as AST.CompositeType)
  return {
    kind: 'FuncSignature',
    input: inputAST,
    output: outputAST,
    span: at,
  } as AST.FuncSignature
}

// comptime T: type
function comptimeTypeParam(name: ohm.Node, typeKw: ohm.Node, at: Span): AST.Field {
  return {
    kind: 'Field',
    comptime: true,
    ident: name.sourceString,
    identSpan: span(name),
    type: { kind: 'TypeType', span: span(typeKw) },
    span: at,
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
    case 'SliceExpr':
      return {
        ...expr,
        object: cloneExprWithSpan(expr.object, expr.object.span),
        start: expr.start && cloneExprWithSpan(expr.start, expr.start.span),
        end: expr.end && cloneExprWithSpan(expr.end, expr.end.span),
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

// The bytes of a template token (head/middle/tail/noSub)
// The token has delimiters at start/end and templateChar* in between
function templateTokenBytes(node: OhmNode): Uint8Array {
  // The second child is always the templateChar* iteration
  const charsNode = node.children[1]
  return piecesToBytes(charsNode.children.map((c: OhmNode) => c.toAST() as Piece))
}

// A character of a quoted literal: text, or the byte a \xHH escape names.
type Piece = string | { byte: number }

// The bytes of a string: its text in UTF-8, and each \xHH escape as that byte.
function piecesToBytes(pieces: Piece[]): Uint8Array {
  const encoder = new TextEncoder()
  const out: number[] = []
  let text = ''
  const flush = () => {
    if (text) for (const b of encoder.encode(text)) out.push(b)
    text = ''
  }
  for (const piece of pieces) {
    if (typeof piece === 'string') text += piece
    else {
      flush()
      out.push(piece.byte)
    }
  }
  flush()
  return new Uint8Array(out)
}

// A literal the grammar accepts but the language does not: '' or an escape
// that names no character. parse() reports it where it is written.
export class LiteralError extends Error {
  constructor(
    message: string,
    readonly span: Span,
  ) {
    super(message)
  }
}

// What `mut` can be written before: a literal laid out in memory.
function isMutLiteral(expr: AST.Expr): boolean {
  return expr.kind === 'LiteralExpr' || expr.kind === 'ArrayExpr' || expr.kind === 'RepeatExpr' || expr.kind === 'TupleExpr'
}

// One codepoint of a single-quoted literal: exactly the int literal of that
// value, as if it were written there as a number.
function codepoint(value: number, at: Span): AST.LiteralExpr {
  return { kind: 'LiteralExpr', value: { kind: 'int', value: BigInt(value), radix: 10 }, quoted: true, span: at }
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

  ImportItem_typeFunc(_func, name, params, _arrow, _type): AST.ImportTypeFunc {
    return {
      kind: 'ImportTypeFunc',
      ident: name.sourceString,
      params: (params.toAST() as AST.CompositeType).fields,
      span: span(this),
    } as AST.ImportTypeFunc
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
    const decl = item.toAST() as AST.ExportDecl['item']
    let exportName: string
    if (decl.kind === 'TypeFuncDecl') {
      exportName = decl.ident
    } else if (decl.kind === 'FuncDecl') {
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

  FuncDecl_typeFunc(_func, name, params, _arrow, _type, _fatArrow, body): AST.TypeFuncDecl {
    return {
      kind: 'TypeFuncDecl',
      ident: name.sourceString,
      params: (params.toAST() as AST.CompositeType).fields,
      body: body.toAST(),
      span: span(this),
    } as AST.TypeFuncDecl
  },

  FuncDecl_func(inlineOpt, _func, identOpt, sig, body): AST.FuncDecl {
    return {
      kind: 'FuncDecl',
      inline: inlineOpt.sourceString !== '',
      ident: first(identOpt),
      signature: sig.toAST(),
      body: body.toAST(),
      span: span(this),
    } as AST.FuncDecl
  },

  // FuncSignature = ParamList ("->" Type)? | BaseType ("->" Type)?
  // Uses symmetric input/output design
  // Ohm passes optional elements separately: input, _arrow (optional iter), Type (optional iter)
  FuncSignature_params(input, _arrowOpt, outputOpt): AST.FuncSignature {
    return funcSignature(input, outputOpt, span(this))
  },

  FuncSignature_plain(input, _arrowOpt, outputOpt): AST.FuncSignature {
    return funcSignature(input, outputOpt, span(this))
  },

  // The node BaseType_composite produces for the same text, so a parameter
  // list reads as the input type it always was.
  ParamList(_lp, list, _rp) {
    return {
      kind: 'CompositeType',
      fields: list.asIteration().children.map((p: ohm.Node) => p.toAST()),
      span: span(this),
    } as AST.CompositeType
  },

  Param_comptimeType(_comptime, name, _colon, typeKw) {
    return comptimeTypeParam(name, typeKw, span(this))
  },

  Param_comptimeTypeLower(_comptime, name, _colon, typeKw) {
    return comptimeTypeParam(name, typeKw, span(this))
  },

  Param_comptimeValue(_comptime, ident, typeAnnotation) {
    return {
      kind: 'Field',
      comptime: true,
      ident: ident.toAST(),
      identSpan: span(ident),
      type: typeAnnotation.toAST(),
      span: span(this),
    } as AST.Field
  },

  Param_typeNoComptime(name, _colon, typeKw) {
    return {
      kind: 'Field',
      ident: name.sourceString,
      type: { kind: 'TypeType', span: span(typeKw) },
      span: span(this),
    } as AST.Field
  },

  Param_plain(field) {
    return field.toAST()
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


  DataDecl_typed(_data, ident, _colon, type, assign) {
    const value = assign.toAST() as AST.Expr
    const typeAnnotation = type.toAST() as AST.Type
    setDataIdOnLiteral(value)
    return {
      kind: 'DataDecl',
      ident: ident.toAST(),
      type: typeAnnotation,
      value,
      span: span(this),
    } as AST.DataDecl
  },

  DataDecl_bare(_data, ident, assign) {
    const value = assign.toAST() as AST.Expr
    setDataIdOnLiteral(value)
    return {
      kind: 'DataDecl',
      ident: ident.toAST(),
      type: undefined,
      value,
      span: span(this),
    } as AST.DataDecl
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

  TestDecl_named(_testKw, name, block): AST.TestDecl {
    const nameLit = name.toAST() as AST.LiteralExpr
    const testName = new TextDecoder().decode((nameLit.value as { bytes: Uint8Array }).bytes)
    return {
      kind: 'TestDecl',
      name: testName,
      children: block.toAST() as AST.TestItem[],
      span: span(this),
    } as AST.TestDecl
  },

  TestDecl_anonymous(_testKw, block): AST.TestDecl {
    return {
      kind: 'TestDecl',
      name: null,
      children: block.toAST() as AST.TestItem[],
      span: span(this),
    } as AST.TestDecl
  },

  TestBlock(_open, items, _close) {
    return items.children.map((i: any) => i.toAST())
  },

  TestItem(item) {
    return item.toAST()
  },

  AssertStmt(_assert, expr): AST.AssertStmt {
    return {
      kind: 'AssertStmt',
      expr: expr.toAST() as AST.Expr,
      span: span(this),
    } as AST.AssertStmt
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

  // []mut T - mutable slice
  BaseType_optManyPointerMut(_q, _brackets, _mut, element) {
    const result: AST.IndexedType = {
      kind: 'IndexedType',
      element: element.toAST(),
      size: null,
      specifiers: [],
      mutable: true,
      optional: true,
      span: span(this),
    }
    result.manyPointer = true
    return result
  },

  BaseType_optManyPointer(_q, _brackets, element) {
    const result: AST.IndexedType = {
      kind: 'IndexedType',
      element: element.toAST(),
      size: null,
      specifiers: [],
      optional: true,
      span: span(this),
    }
    result.manyPointer = true
    return result
  },

  BaseType_optSliceMut(_q, _brackets, _mut, element) {
    return {
      kind: 'IndexedType',
      element: element.toAST(),
      size: null,
      specifiers: [],
      mutable: true,
      optional: true,
      span: span(this),
    } as AST.IndexedType
  },

  BaseType_optSlice(_q, _brackets, element) {
    return {
      kind: 'IndexedType',
      element: element.toAST(),
      size: null,
      specifiers: [],
      optional: true,
      span: span(this),
    } as AST.IndexedType
  },

  BaseType_optPointerMut(_q, _star, _mut, type) {
    return {
      kind: 'PointerType',
      pointee: type.toAST(),
      mutable: true,
      optional: true,
      span: span(this),
    } as AST.PointerType
  },

  BaseType_optPointer(_q, _star, type) {
    return {
      kind: 'PointerType',
      pointee: type.toAST(),
      optional: true,
      span: span(this),
    } as AST.PointerType
  },

  BaseType_sliceMut(_brackets, _mut, element) {
    return {
      kind: 'IndexedType',
      element: element.toAST(),
      size: null,
      specifiers: [],
      mutable: true,
      span: span(this),
    } as AST.IndexedType
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

  // [*]mut T - mutable many-pointer
  BaseType_manyPointerMut(_brackets, _mut, element) {
    const result: AST.IndexedType = {
      kind: 'IndexedType',
      element: element.toAST(),
      size: null,
      specifiers: [],
      mutable: true,
      span: span(this),
    }
    result.manyPointer = true
    return result
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

  // [framings]mut T - mutable array pointer
  BaseType_arrayMut(_lb, framings, _rb, _mut, element) {
    const { size, specifiers } = framings.toAST() as { size: number | number[] | 'inferred' | null; specifiers: AST.IndexSpecifier[] }
    return {
      kind: 'IndexedType',
      element: element.toAST(),
      size,
      specifiers,
      mutable: true,
      span: span(this),
    } as AST.IndexedType
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
  arrayFramings(first, _xs, rest) {
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

  BaseType_pointerMut(_star, _mut, type) {
    return {
      kind: 'PointerType',
      pointee: type.toAST(),
      mutable: true,
      span: span(this),
    } as AST.PointerType
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

  BaseType_rangedPrimitive(ranged) {
    return ranged.toAST()
  },

  rangedUnsigned(unsignedType, _hash, digits) {
    return {
      kind: 'PrimitiveType',
      name: unsignedType.sourceString as AST.PrimitiveType['name'],
      max: parseInt(digits.sourceString, 10),
      span: span(this),
    } as AST.PrimitiveType
  },

  BaseType_primitive(prim) {
    return prim.toAST()
  },

  BaseType_named(typeIdent) {
    return typeIdent.toAST()
  },

  BaseType_apply(head, args, _rp) {
    return {
      kind: 'TypeApply',
      name: head.toAST(),
      args: args.asIteration().children.map((a: ohm.Node) => a.toAST()),
      span: span(this),
    } as AST.TypeApply
  },

  typeApplyHead(name, _lp) {
    return name.sourceString
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

  LetStmt_multi(_let, pattern, assign): AST.LetStmt {
    return {
      kind: 'LetStmt',
      pattern: pattern.toAST() as AST.TuplePattern,
      type: null,
      value: assign.toAST() as AST.Expr,
      span: span(this),
    } as AST.LetStmt
  },

  SetStmt_multi(_set, pattern, assign): AST.SetStmt {
    return {
      kind: 'SetStmt',
      pattern: pattern.toAST() as AST.TuplePattern,
      type: null,
      value: assign.toAST() as AST.Expr,
      span: span(this),
    } as AST.SetStmt
  },

  // a, b, c: a positional tuple pattern, as if written (a, b, c).
  MultiPattern(head, _comma, rest) {
    const names = [head, ...rest.asIteration().children]
    return {
      kind: 'TuplePattern',
      elements: names.map((n) => ({
        kind: 'positional',
        pattern: { kind: 'IdentPattern', name: n.sourceString, span: span(n) } as AST.IdentPattern,
      })),
      span: span(this),
    } as AST.TuplePattern
  },

  LetStmt_single(_let, patternWithType, assignOpt): AST.LetStmt {
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

  SetStmt_single(_set, patternWithType, assign): AST.SetStmt {
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

  // for i, value in items: the index comes first.
  ForBinding_withIndex(index, _comma, value) {
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

  DeferStmt(_defer, expr) {
    return {
      kind: 'DeferStmt',
      expr: expr.toAST(),
      span: span(this),
    } as AST.DeferStmt
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

  AccessSuffix_slice(_lb, start, _dots, end, _rb) {
    return {
      kind: 'slice',
      start: start.children.length > 0 ? start.children[0].toAST() : null,
      end: end.children.length > 0 ? end.children[0].toAST() : null,
    }
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
      span: span(this),
    } as AST.PatternElement
  },

  PatternElem_namedShort(field, _colon) {
    return {
      kind: 'named',
      field: field.sourceString,
      binding: null,
      span: span(this),
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

  CoalesceExpr_coalesce(left, _op, right): AST.CoalesceExpr {
    return {
      kind: 'CoalesceExpr',
      expr: left.toAST(),
      fallback: right.toAST(),
      span: span(this),
    } as AST.CoalesceExpr
  },

  CoalesceExpr(expr) {
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
    const inner = operand.toAST()
    const s = span(this)
    // Fold negation into numeric literals, including through annotation/cast wrappers
    const lit = inner.kind === 'AnnotationExpr' ? inner.expr
              : inner.kind === 'CastExpr' ? inner.expr
              : inner
    if (lit.kind === 'LiteralExpr' && (lit.value.kind === 'int' || lit.value.kind === 'float')) {
      // A new value, not a change to this one: every use of a def shares the
      // value of the def's literal.
      lit.value = { ...lit.value, value: -lit.value.value } as AST.LiteralValue
      lit.span = { start: s.start, end: lit.span.end }
      inner.span = s
      return inner
    }
    return {
      kind: 'UnaryExpr',
      op: '-',
      operand: inner,
      span: s,
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
    // mut "ab".fill() is mut of the call: the literal it is meant for is
    // written in parentheses with it.
    let receiver: AST.Expr = expr
    while (receiver.kind === 'CallExpr' || receiver.kind === 'MemberExpr' || receiver.kind === 'IndexExpr' || receiver.kind === 'SliceExpr') {
      receiver = receiver.kind === 'CallExpr' ? receiver.callee : receiver.object
    }
    const text = operand.sourceString
    const at = span(operand).start
    if (receiver !== expr && isMutLiteral(receiver)) {
      const literal = text.slice(receiver.span.start - at, receiver.span.end - at)
      throw new LiteralError(`mut goes on the literal itself: write (mut ${literal})${text.slice(receiver.span.end - at)}`, span(this))
    }
    throw new LiteralError(`mut goes before a literal (an array, a string or a tuple), not before ${text}`, span(this))
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

  PrimaryExpr_sizeofData(_sizeof, _data) {
    return {
      kind: 'SizeofDataExpr',
      span: span(this),
    } as AST.SizeofDataExpr
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
      span: span(this),
    } as AST.MatchPattern
  },

  MatchPattern_literal(lit) {
    const value = lit.toAST() as AST.LiteralExpr | AST.TupleExpr
    // 'ok' matches as the tuple of its codepoints, (111, 107).
    if (value.kind === 'TupleExpr') {
      return {
        kind: 'tuple',
        elements: value.elements.map((e) => ({
          kind: 'positional',
          pattern: { kind: 'literal', value: (e.value as AST.LiteralExpr).value },
        })),
        quoted: true,
      } as AST.MatchPattern
    }
    return {
      kind: 'literal',
      value: value.value,
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

  Arg_type(type, _lookahead) {
    return typeArg(type)
  },

  Arg_otherType(type, _lookahead) {
    return typeArg(type)
  },

  TypeLit(_lookahead, type) {
    return type.toAST()
  },

  Arg_positional(expr, _lookahead) {
    return { kind: 'Arg', name: null, value: expr.toAST(), span: span(expr) } as AST.Arg
  },

  Arg_unfinished(expr) {
    return { kind: 'Arg', name: null, value: expr.toAST(), span: span(expr) } as AST.Arg
  },

  // ============================================================================
  // Literals
  // ============================================================================

  TemplateLiteral_plain(tmpl) {
    const bytes = templateTokenBytes(tmpl)
    if (bytes.length === 0) {
      return { kind: 'ArrayExpr', elements: [], template: true, span: span(this) } as AST.ArrayExpr
    }
    return {
      kind: 'ArrayExpr',
      elements: [{
        kind: 'LiteralExpr',
        value: { kind: 'string', bytes },
        span: span(this),
      } as AST.LiteralExpr],
      template: true,
      span: span(this),
    } as AST.ArrayExpr
  },

  TemplateLiteral_interpolated(head, firstExpr, middles, restExprs, tail) {
    const elements: AST.Expr[] = []
    const pushSegment = (bytes: Uint8Array, node: OhmNode, trimStart: number, trimEnd: number) => {
      if (bytes.length > 0) {
        const s = span(node)
        elements.push({ kind: 'LiteralExpr', value: { kind: 'string', bytes }, span: { start: s.start + trimStart, end: s.end - trimEnd } } as AST.LiteralExpr)
      }
    }
    // head: `text${ — skip 1 (`) at start, 2 (${) at end
    pushSegment(templateTokenBytes(head), head, 1, 2)
    elements.push(firstExpr.toAST() as AST.Expr)
    const mids = middles.children
    const rests = restExprs.children
    for (let i = 0; i < mids.length; i++) {
      // middle: }text${ — skip 1 (}) at start, 2 (${) at end
      pushSegment(templateTokenBytes(mids[i]), mids[i], 1, 2)
      elements.push(rests[i].toAST() as AST.Expr)
    }
    // tail: }text` — skip 1 (}) at start, 1 (`) at end
    pushSegment(templateTokenBytes(tail), tail, 1, 1)
    return { kind: 'ArrayExpr', elements, template: true, span: span(this) } as AST.ArrayExpr
  },

  templateChar_escapeTick(_seq) { return '`' },
  templateChar_escapeDollar(_seq) { return '${' },
  templateChar_escape(seq) { return seq.toAST() },
  templateChar_plain(c) { return c.sourceString },

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

  ArrayLiteral_list(_lb, elements, _trailing, _rb) {
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
    const bytes = piecesToBytes(chars.children.map((c: ohm.Node) => c.toAST() as Piece))
    return {
      kind: 'LiteralExpr',
      value: { kind: 'string', bytes },
      span: span(this),
    } as AST.LiteralExpr
  },

  // 'a' is the int 97, and 'ok' the tuple (111, 107): a codepoint for each
  // character or escape, never a byte of its UTF-8 encoding. One codepoint is
  // the value itself, as a parenthesised value is.
  codepointLiteral(_lq, chars, _rq) {
    const parts = chars.children.map((c: ohm.Node) => {
      const piece = c.toAST() as Piece
      return codepoint(typeof piece === 'string' ? piece.codePointAt(0)! : piece.byte, span(c))
    })
    if (parts.length === 0) {
      throw new LiteralError(`'' holds no character: write one or more between single quotes, or "" for an empty string`, span(this))
    }
    if (parts.length === 1) return { ...parts[0], span: span(this) }
    return {
      kind: 'TupleExpr',
      elements: parts.map((value) => ({ kind: 'Arg', name: null, value, span: value.span }) as AST.Arg),
      quoted: true,
      span: span(this),
    } as AST.TupleExpr
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

  dqChar(char) {
    return char.toAST()
  },

  sqChar(char) {
    return char.toAST()
  },

  // \xHH is the byte HH in a string, and the codepoint HH in single quotes.
  escapeSeq_hex(_backslash, _x, d1, d2) {
    return { byte: parseInt(d1.sourceString + d2.sourceString, 16) }
  },

  // \u{H..} is a character by its codepoint: in a string, its UTF-8 bytes.
  escapeSeq_unicode(_backslash, _u, _lb, digits, _rb) {
    const hex = digits.sourceString
    const value = /^0*[0-9a-fA-F]{1,6}$/.test(hex) ? parseInt(hex, 16) : Infinity
    if (value > 0x10ffff) {
      throw new LiteralError(`\\u{${hex}} is not a character: the last codepoint is \\u{10FFFF}`, span(this))
    }
    if (value >= 0xd800 && value <= 0xdfff) {
      throw new LiteralError(`\\u{${hex}} is not a character: D800 to DFFF are UTF-16 surrogates, not codepoints`, span(this))
    }
    return String.fromCodePoint(value)
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

    case 'slice':
      return {
        kind: 'SliceExpr',
        object: base,
        start: suffix.start,
        end: suffix.end,
        span: { start: base.span.start, end: suffixSpan.end },
      } as AST.SliceExpr
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
