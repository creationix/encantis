import * as ohm from 'ohm-js'
import type * as AST from '../ast'
import type { Span } from '../ast'

// Types for access suffixes parsed from grammar
type AccessSuffix =
  | { kind: 'field'; name: string }
  | { kind: 'tupleIndex'; value: number }
  | { kind: 'deref' }
  | { kind: 'typePun'; type: AST.Type }
  | { kind: 'index'; expr: AST.Expr }

// Types for postfix operations (AccessSuffix + call)
type PostfixOp = AccessSuffix | { kind: 'call'; args: AST.Arg[] }

// Load the grammar
const grammarPath = new URL('encantis.ohm', import.meta.url).pathname
const grammarSource = await Bun.file(grammarPath).text()
export const grammar = ohm.grammar(grammarSource)

// Helper to create span from Ohm source interval
function span(node: ohm.Node): Span {
  return {
    start: node.source.startIdx,
    end: node.source.endIdx,
  }
}

// Helper to get first child if present
function first<T>(iter: ohm.IterationNode): T | null {
  return iter.children[0]?.toAST() ?? null
}

// Create semantics
export const semantics = grammar.createSemantics()

// Add toAST operation
semantics.addOperation<unknown>('toAST', {
  // ============================================================================
  // Module
  // ============================================================================

  Module(decls) {
    return {
      kind: 'Module',
      decls: decls.children.map((d: ohm.Node) => d.toAST()),
      span: span(this),
    } as AST.Module
  },

  // ============================================================================
  // Declarations
  // ============================================================================

  Declaration(decl) {
    return decl.toAST()
  },

  ImportDecl_group(_import, module, _lp, items, _rp) {
    return {
      kind: 'ImportDecl',
      module: module.toAST().value.value,
      items: items.children.map((i: ohm.Node) => i.toAST()),
      span: span(this),
    } as AST.ImportDecl
  },

  ImportDecl_single(_import, module, item) {
    return {
      kind: 'ImportDecl',
      module: module.toAST().value.value,
      items: [item.toAST()],
      span: span(this),
    } as AST.ImportDecl
  },

  ImportGroupItem(name, item) {
    return {
      kind: 'ImportItem',
      name: name.toAST().value.value,
      item: item.toAST(),
      span: span(this),
    } as AST.ImportItem
  },

  ImportItem_func(_func, identOpt, sig) {
    return {
      kind: 'ImportFunc',
      ident: first(identOpt),
      signature: sig.toAST(),
      span: span(this),
    } as AST.ImportFunc
  },

  ImportItem_global(_global, ident, typeAnnotation) {
    return {
      kind: 'ImportGlobal',
      ident: ident.toAST(),
      type: typeAnnotation.toAST(),
      span: span(this),
    } as AST.ImportGlobal
  },

  ImportItem_memory(_memory, size) {
    return {
      kind: 'ImportMemory',
      min: Number(size.sourceString),
      span: span(this),
    } as AST.ImportMemory
  },

  ExportDecl(_export, name, item) {
    return {
      kind: 'ExportDecl',
      name: name.toAST().value.value,
      item: item.toAST(),
      span: span(this),
    } as AST.ExportDecl
  },

  Exportable(item) {
    return item.toAST()
  },

  FuncDecl(inlineOpt, _func, identOpt, sig, body) {
    return {
      kind: 'FuncDecl',
      inline: inlineOpt.sourceString !== '',
      ident: first(identOpt),
      signature: sig.toAST(),
      body: body.toAST(),
      span: span(this),
    } as AST.FuncDecl
  },

  FuncSignature(params, returnOpt) {
    return {
      kind: 'FuncSignature',
      params: params.toAST(),
      returns: first(returnOpt),
      span: span(this),
    } as AST.FuncSignature
  },

  ReturnSpec(_arrow, valueSpec) {
    return valueSpec.toAST()
  },

  ValueSpec_parens(_lp, fieldListOpt, _rp) {
    return {
      kind: 'FieldList',
      fields: first(fieldListOpt) ?? [],
      span: span(this),
    } as AST.FieldList
  },

  ValueSpec_single(type) {
    return type.toAST()
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

  UniqueDecl(_unique, ident, _eq, type) {
    return {
      kind: 'UniqueDecl',
      ident: ident.toAST(),
      type: type.toAST(),
      span: span(this),
    } as AST.UniqueDecl
  },

  DefDecl(_def, ident, assign) {
    return {
      kind: 'DefDecl',
      ident: ident.toAST(),
      value: assign.toAST(),
      span: span(this),
    } as AST.DefDecl
  },

  GlobalDecl(_global, ident, typeOpt, assignOpt) {
    return {
      kind: 'GlobalDecl',
      ident: ident.toAST(),
      type: first(typeOpt),
      value: first(assignOpt),
      span: span(this),
    } as AST.GlobalDecl
  },

  MemoryDecl(_memory, min, maxOpt, dataBlockOpt) {
    const dataBlock = first<AST.DataEntry[]>(dataBlockOpt)
    return {
      kind: 'MemoryDecl',
      min: Number(min.sourceString),
      max: first(maxOpt) ? Number(first(maxOpt)) : null,
      data: dataBlock ?? [],
      span: span(this),
    } as AST.MemoryDecl
  },

  DataBlock(_lb, entries, _rb) {
    return entries.children.map((e: ohm.Node) => e.toAST())
  },

  DataEntry(offset, _arrow, expr, _comma) {
    return {
      kind: 'DataEntry',
      offset: Number(offset.sourceString),
      value: expr.toAST(),
      span: span(this),
    } as AST.DataEntry
  },

  // ============================================================================
  // Types
  // ============================================================================

  Type_array(element, _lb, sizeNode, _rb) {
    const sizeStr = sizeNode.sourceString
    const size = sizeStr === 'N' ? 'inferred' : Number(sizeStr)
    return {
      kind: 'IndexedType',
      element: element.toAST(),
      size,
      specifiers: [],
      span: span(this),
    } as AST.IndexedType
  },

  Type_indexed(element, _lb, specs, _rb) {
    return {
      kind: 'IndexedType',
      element: element.toAST(),
      size: null,
      specifiers: specs.children.map((s) => s.toAST()),
      span: span(this),
    } as AST.IndexedType
  },

  Type_slice(element, _lb, _hash, _rb) {
    return {
      kind: 'IndexedType',
      element: element.toAST(),
      size: null,
      specifiers: [],
      span: span(this),
    } as AST.IndexedType
  },

  Type_comptimeList(element, _lb, _rb) {
    return {
      kind: 'IndexedType',
      element: element.toAST(),
      size: 'comptime',
      specifiers: [],
      span: span(this),
    } as AST.IndexedType
  },

  indexSpecifier(token) {
    const s = token.sourceString
    if (s === '/0') {
      return { kind: 'null' } as AST.IndexSpecifier
    }
    // Extract prefix type from /u8, /u16, etc.
    // Normalize /L to leb128
    const prefixType = s === '/L' ? 'leb128' : s.slice(1)
    return { kind: 'prefix', prefixType } as AST.IndexSpecifier
  },

  Type_tagged(type, _at, tag) {
    return {
      kind: 'TaggedType',
      type: type.toAST(),
      tag: tag.sourceString,
      span: span(this),
    } as AST.TaggedType
  },

  Type_pointer(_star, type) {
    return {
      kind: 'PointerType',
      pointee: type.toAST(),
      span: span(this),
    } as AST.PointerType
  },

  Type_composite(_lp, fieldListOpt, _rp) {
    return {
      kind: 'CompositeType',
      fields: first(fieldListOpt) ?? [],
      span: span(this),
    } as AST.CompositeType
  },

  Type_comptimeScalar(comptime) {
    return comptime.toAST()
  },

  Type_primitive(prim) {
    return prim.toAST()
  },

  Type_named(typeIdent) {
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

  Statement(stmt) {
    return stmt.toAST()
  },

  LetStmt(_let, pattern, typeOpt, assignOpt) {
    return {
      kind: 'LetStmt',
      pattern: pattern.toAST(),
      type: first(typeOpt),
      value: first(assignOpt),
      span: span(this),
    } as AST.LetStmt
  },

  SetStmt(_set, pattern, typeOpt, assign) {
    return {
      kind: 'SetStmt',
      pattern: pattern.toAST(),
      type: first(typeOpt),
      value: assign.toAST(),
      span: span(this),
    } as AST.SetStmt
  },

  WhileStmt(_while, condition, body) {
    return {
      kind: 'WhileStmt',
      condition: condition.toAST(),
      body: body.toAST(),
      span: span(this),
    } as AST.WhileStmt
  },

  ForStmt(_for, binding, _in, iterable, body) {
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

  Expr(expr) {
    return expr.toAST()
  },

  OrExpr_or(left, _op, right) {
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
      return {
        kind: 'IdentExpr',
        name: expr.toAST(),
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

  IfExpr(_if, condition, then, elifs, elseOpt) {
    return {
      kind: 'IfExpr',
      condition: condition.toAST(),
      thenBranch: then.toAST(),
      elifs: elifs.children.map((e: ohm.Node) => e.toAST()),
      else_: first(elseOpt),
      span: span(this),
    } as AST.IfExpr
  },

  ElifBranch(_elif, condition, then) {
    return {
      kind: 'ElifBranch',
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

  MatchArm(patterns, _arrow, body) {
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

  MatchPattern_literal(lit) {
    return {
      kind: 'literal',
      value: lit.toAST().value,
    } as AST.MatchPattern
  },

  MatchPattern_wildcard(_underscore) {
    return { kind: 'wildcard' } as AST.MatchPattern
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

  ArrayLiteral(_lb, elements, _rb) {
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
    const bytes = new Uint8Array(hex.length / 2)
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    }
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
})

// ============================================================================
// Helper: Apply suffix to build AST node
// ============================================================================

function applySuffix(
  base: AST.Expr,
  suffix: AccessSuffix,
  suffixSpan: Span,
): AST.Expr {
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
