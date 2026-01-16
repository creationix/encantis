import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ohm from 'ohm-js';
import type * as AST from '../ast';
import type { Span } from '../ast';

// Load the grammar
const grammarPath = path.join(__dirname, 'encantis.ohm');
const grammarSource = fs.readFileSync(grammarPath, 'utf-8');
export const grammar = ohm.grammar(grammarSource);

// Helper to create span from Ohm source interval
function span(node: ohm.Node, source?: string): Span {
  const interval = node.source;
  const startLC = interval.getLineAndColumn();
  // For end, we need to get line/col at the end position
  // Ohm doesn't have a direct method, so we compute it
  const endOffset = interval.endIdx;
  // Simple approach: use start line/col and add offset difference
  // This is approximate; a more accurate approach would parse through the source
  return {
    start: {
      offset: interval.startIdx,
      line: startLC.lineNum,
      column: startLC.colNum,
    },
    end: {
      offset: endOffset,
      line: startLC.lineNum, // Approximation
      column: startLC.colNum + (endOffset - interval.startIdx),
    },
    source,
  };
}

// Create semantics
export const semantics = grammar.createSemantics();

// Add toAST operation
semantics.addOperation<any>('toAST(source)', {
  // ============================================================================
  // Module
  // ============================================================================

  Module(decls) {
    return {
      kind: 'Module',
      decls: decls.children.map((d: ohm.Node) => d.toAST(this.args.source)),
      span: span(this, this.args.source),
    } as AST.Module;
  },

  // ============================================================================
  // Declarations
  // ============================================================================

  Declaration(decl) {
    return decl.toAST(this.args.source);
  },

  ImportDecl_group(_import, module, _lp, items, _rp) {
    return {
      kind: 'ImportDecl',
      module: module.toAST(this.args.source),
      items: items.children.map((i: ohm.Node) => i.toAST(this.args.source)),
      span: span(this, this.args.source),
    } as AST.ImportDecl;
  },

  ImportDecl_single(_import, module, name, item) {
    const importItem = item.toAST(this.args.source);
    return {
      kind: 'ImportDecl',
      module: module.toAST(this.args.source),
      items: [{
        kind: 'ImportItem',
        name: name.toAST(this.args.source),
        item: importItem,
        span: span(name, this.args.source),
      }],
      span: span(this, this.args.source),
    } as AST.ImportDecl;
  },

  ImportGroupItem(name, item) {
    return {
      kind: 'ImportItem',
      name: name.toAST(this.args.source),
      item: item.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.ImportItem;
  },

  ImportItem_func(_func, identOpt, sig) {
    const identNode = identOpt.children[0];
    return {
      kind: 'ImportFunc',
      ident: identNode ? identNode.toAST(this.args.source) : null,
      signature: sig.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.ImportFunc;
  },

  ImportItem_global(_global, ident, _colon, type) {
    return {
      kind: 'ImportGlobal',
      ident: ident.toAST(this.args.source),
      type: type.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.ImportGlobal;
  },

  ImportItem_memory(_memory, size) {
    return {
      kind: 'ImportMemory',
      min: Number(size.sourceString),
      span: span(this, this.args.source),
    } as AST.ImportMemory;
  },

  ExportDecl(_export, name, item) {
    return {
      kind: 'ExportDecl',
      name: name.toAST(this.args.source),
      item: item.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.ExportDecl;
  },

  Exportable(item) {
    return item.toAST(this.args.source);
  },

  FuncDecl(inlineOpt, _func, identOpt, sig, body) {
    const identNode = identOpt.children[0];
    return {
      kind: 'FuncDecl',
      inline: inlineOpt.sourceString !== '',
      ident: identNode ? identNode.toAST(this.args.source) : null,
      signature: sig.toAST(this.args.source),
      body: body.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.FuncDecl;
  },

  FuncSignature_withReturn(params, _arrow, returns) {
    return {
      kind: 'FuncSignature',
      params: params.toAST(this.args.source),
      returns: returns.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.FuncSignature;
  },

  FuncSignature_noReturn(params) {
    return {
      kind: 'FuncSignature',
      params: params.toAST(this.args.source),
      returns: null,
      span: span(this, this.args.source),
    } as AST.FuncSignature;
  },

  FuncSignature(sig) {
    return sig.toAST(this.args.source);
  },

  ValueSpec_parens(_lp, fieldListOpt, _rp) {
    const fieldListNode = fieldListOpt.children[0];
    return {
      kind: 'FieldList',
      fields: fieldListNode ? fieldListNode.toAST(this.args.source) : [],
      span: span(this, this.args.source),
    } as AST.FieldList;
  },

  ValueSpec_single(type) {
    return type.toAST(this.args.source);
  },

  FieldList(list) {
    return list.asIteration().children.map((f: ohm.Node) => f.toAST(this.args.source));
  },

  Field_named(ident, _colon, type) {
    return {
      kind: 'Field',
      ident: ident.toAST(this.args.source),
      type: type.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.Field;
  },

  Field_anonymous(type) {
    return {
      kind: 'Field',
      ident: null,
      type: type.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.Field;
  },

  FuncBody_block(block) {
    return block.toAST(this.args.source);
  },

  FuncBody_arrow(_arrow, expr) {
    return {
      kind: 'ArrowBody',
      expr: expr.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.ArrowBody;
  },

  FuncBody(body) {
    return body.toAST(this.args.source);
  },

  Block(_lb, stmts, _rb) {
    return {
      kind: 'Block',
      stmts: stmts.children.map((s: ohm.Node) => s.toAST(this.args.source)),
      span: span(this, this.args.source),
    } as AST.Block;
  },

  TypeDecl(_type, ident, _eq, type) {
    return {
      kind: 'TypeDecl',
      ident: ident.toAST(this.args.source),
      type: type.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.TypeDecl;
  },

  UniqueDecl(_unique, ident, _eq, type) {
    return {
      kind: 'UniqueDecl',
      ident: ident.toAST(this.args.source),
      type: type.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.UniqueDecl;
  },

  DefDecl(_def, ident, _eq, expr) {
    return {
      kind: 'DefDecl',
      ident: ident.toAST(this.args.source),
      value: expr.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.DefDecl;
  },

  GlobalDecl_full(_global, ident, _colon, type, _eq, expr) {
    return {
      kind: 'GlobalDecl',
      ident: ident.toAST(this.args.source),
      type: type.toAST(this.args.source),
      value: expr.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.GlobalDecl;
  },

  GlobalDecl_typed(_global, ident, _colon, type) {
    return {
      kind: 'GlobalDecl',
      ident: ident.toAST(this.args.source),
      type: type.toAST(this.args.source),
      value: null,
      span: span(this, this.args.source),
    } as AST.GlobalDecl;
  },

  GlobalDecl_init(_global, ident, _eq, expr) {
    return {
      kind: 'GlobalDecl',
      ident: ident.toAST(this.args.source),
      type: null,
      value: expr.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.GlobalDecl;
  },

  GlobalDecl_bare(_global, ident) {
    return {
      kind: 'GlobalDecl',
      ident: ident.toAST(this.args.source),
      type: null,
      value: null,
      span: span(this, this.args.source),
    } as AST.GlobalDecl;
  },

  GlobalDecl(decl) {
    return decl.toAST(this.args.source);
  },

  MemoryDecl_fullWithData(_memory, min, max, _lb, data, _rb) {
    return {
      kind: 'MemoryDecl',
      min: Number(min.sourceString),
      max: Number(max.sourceString),
      data: data.children.map((e: ohm.Node) => e.toAST(this.args.source)),
      span: span(this, this.args.source),
    } as AST.MemoryDecl;
  },

  MemoryDecl_minWithData(_memory, min, _lb, data, _rb) {
    return {
      kind: 'MemoryDecl',
      min: Number(min.sourceString),
      max: null,
      data: data.children.map((e: ohm.Node) => e.toAST(this.args.source)),
      span: span(this, this.args.source),
    } as AST.MemoryDecl;
  },

  MemoryDecl_fullNoData(_memory, min, max) {
    return {
      kind: 'MemoryDecl',
      min: Number(min.sourceString),
      max: Number(max.sourceString),
      data: [],
      span: span(this, this.args.source),
    } as AST.MemoryDecl;
  },

  MemoryDecl_minNoData(_memory, min) {
    return {
      kind: 'MemoryDecl',
      min: Number(min.sourceString),
      max: null,
      data: [],
      span: span(this, this.args.source),
    } as AST.MemoryDecl;
  },

  MemoryDecl(decl) {
    return decl.toAST(this.args.source);
  },

  DataEntry(offset, _arrow, expr, _comma) {
    return {
      kind: 'DataEntry',
      offset: Number(offset.sourceString),
      value: expr.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.DataEntry;
  },

  // ============================================================================
  // Types
  // ============================================================================

  Type(type) {
    return type.toAST(this.args.source);
  },

  PrimitiveType(name) {
    return {
      kind: 'PrimitiveType',
      name: name.sourceString as AST.PrimitiveType['name'],
      span: span(this, this.args.source),
    } as AST.PrimitiveType;
  },

  PointerType(_star, type) {
    return {
      kind: 'PointerType',
      pointee: type.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.PointerType;
  },

  IndexedType_fixedNull(element, _lb, size, _slash, _zero, _rb) {
    return {
      kind: 'IndexedType',
      element: element.toAST(this.args.source),
      size: Number(size.sourceString),
      nullTerminated: true,
      span: span(this, this.args.source),
    } as AST.IndexedType;
  },

  IndexedType_sliceNull(element, _lb, _slash, _zero, _rb) {
    return {
      kind: 'IndexedType',
      element: element.toAST(this.args.source),
      size: null,
      nullTerminated: true,
      span: span(this, this.args.source),
    } as AST.IndexedType;
  },

  IndexedType_fixed(element, _lb, size, _rb) {
    return {
      kind: 'IndexedType',
      element: element.toAST(this.args.source),
      size: Number(size.sourceString),
      nullTerminated: false,
      span: span(this, this.args.source),
    } as AST.IndexedType;
  },

  IndexedType_slice(element, _lb, _rb) {
    return {
      kind: 'IndexedType',
      element: element.toAST(this.args.source),
      size: null,
      nullTerminated: false,
      span: span(this, this.args.source),
    } as AST.IndexedType;
  },

  IndexedType(type) {
    return type.toAST(this.args.source);
  },

  NonIndexedType(type) {
    return type.toAST(this.args.source);
  },

  CompositeType(_lp, fieldListOpt, _rp) {
    const fieldListNode = fieldListOpt.children[0];
    return {
      kind: 'CompositeType',
      fields: fieldListNode ? fieldListNode.toAST(this.args.source) : [],
      span: span(this, this.args.source),
    } as AST.CompositeType;
  },

  typeIdent(_first, _rest) {
    return {
      kind: 'TypeRef',
      name: this.sourceString,
      span: span(this, this.args.source),
    } as AST.TypeRef;
  },

  // ============================================================================
  // Statements
  // ============================================================================

  Statement(stmt) {
    return stmt.toAST(this.args.source);
  },

  LetStmt_typedInit(_let, pattern, _colon, type, _eq, expr) {
    return {
      kind: 'LetStmt',
      pattern: pattern.toAST(this.args.source),
      type: type.toAST(this.args.source),
      value: expr.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.LetStmt;
  },

  LetStmt_typed(_let, pattern, _colon, type) {
    return {
      kind: 'LetStmt',
      pattern: pattern.toAST(this.args.source),
      type: type.toAST(this.args.source),
      value: null,
      span: span(this, this.args.source),
    } as AST.LetStmt;
  },

  LetStmt_init(_let, pattern, _eq, expr) {
    return {
      kind: 'LetStmt',
      pattern: pattern.toAST(this.args.source),
      type: null,
      value: expr.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.LetStmt;
  },

  LetStmt_bare(_let, pattern) {
    return {
      kind: 'LetStmt',
      pattern: pattern.toAST(this.args.source),
      type: null,
      value: null,
      span: span(this, this.args.source),
    } as AST.LetStmt;
  },

  LetStmt(stmt) {
    return stmt.toAST(this.args.source);
  },

  SetStmt_typed(_set, pattern, _colon, type, _eq, expr) {
    return {
      kind: 'SetStmt',
      pattern: pattern.toAST(this.args.source),
      type: type.toAST(this.args.source),
      value: expr.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.SetStmt;
  },

  SetStmt_untyped(_set, pattern, _eq, expr) {
    return {
      kind: 'SetStmt',
      pattern: pattern.toAST(this.args.source),
      type: null,
      value: expr.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.SetStmt;
  },

  SetStmt(stmt) {
    return stmt.toAST(this.args.source);
  },

  IfStmt(_if, condition, then, elifs, elseOpt) {
    const elseNode = elseOpt.children[0];
    return {
      kind: 'IfStmt',
      condition: condition.toAST(this.args.source),
      thenBranch: then.toAST(this.args.source),
      elifs: elifs.children.map((e: ohm.Node) => e.toAST(this.args.source)),
      else_: elseNode ? elseNode.toAST(this.args.source) : null,
      span: span(this, this.args.source),
    } as AST.IfStmt;
  },

  ElifClause(_elif, condition, then) {
    return {
      kind: 'ElifClause',
      condition: condition.toAST(this.args.source),
      thenBranch: then.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.ElifClause;
  },

  ElseClause(_else, body) {
    return body.toAST(this.args.source);
  },

  WhileStmt(_while, condition, body) {
    return {
      kind: 'WhileStmt',
      condition: condition.toAST(this.args.source),
      body: body.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.WhileStmt;
  },

  ForStmt(_for, binding, _in, iterable, body) {
    return {
      kind: 'ForStmt',
      binding: binding.toAST(this.args.source),
      iterable: iterable.toAST(this.args.source),
      body: body.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.ForStmt;
  },

  ForBinding_withIndex(value, _comma, index) {
    return {
      kind: 'ForBinding',
      value: value.toAST(this.args.source),
      index: index.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.ForBinding;
  },

  ForBinding_valueOnly(value) {
    return {
      kind: 'ForBinding',
      value: value.toAST(this.args.source),
      index: null,
      span: span(this, this.args.source),
    } as AST.ForBinding;
  },

  ForBinding(binding) {
    return binding.toAST(this.args.source);
  },

  LoopStmt(_loop, body) {
    return {
      kind: 'LoopStmt',
      body: body.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.LoopStmt;
  },

  ReturnStmt(_return, exprOpt, whenOpt) {
    const exprNode = exprOpt.children[0];
    const whenNode = whenOpt.children[0];
    return {
      kind: 'ReturnStmt',
      value: exprNode ? exprNode.toAST(this.args.source) : null,
      when: whenNode ? whenNode.toAST(this.args.source) : null,
      span: span(this, this.args.source),
    } as AST.ReturnStmt;
  },

  BreakStmt(_break, whenOpt) {
    const whenNode = whenOpt.children[0];
    return {
      kind: 'BreakStmt',
      when: whenNode ? whenNode.toAST(this.args.source) : null,
      span: span(this, this.args.source),
    } as AST.BreakStmt;
  },

  ContinueStmt(_continue, whenOpt) {
    const whenNode = whenOpt.children[0];
    return {
      kind: 'ContinueStmt',
      when: whenNode ? whenNode.toAST(this.args.source) : null,
      span: span(this, this.args.source),
    } as AST.ContinueStmt;
  },

  WhenClause(_when, expr) {
    return expr.toAST(this.args.source);
  },

  AssignmentStmt(target, op, value) {
    return {
      kind: 'AssignmentStmt',
      target: target.toAST(this.args.source),
      op: op.sourceString as AST.AssignOp,
      value: value.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.AssignmentStmt;
  },

  assignOp(_op) {
    return this.sourceString;
  },

  ExpressionStmt(expr) {
    return {
      kind: 'ExpressionStmt',
      expr: expr.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.ExpressionStmt;
  },

  // ============================================================================
  // L-Values
  // ============================================================================

  LValue_field(obj, _dot, field) {
    return {
      kind: 'MemberExpr',
      object: obj.toAST(this.args.source),
      member: { kind: 'field', name: field.sourceString },
      span: span(this, this.args.source),
    } as AST.MemberExpr;
  },

  LValue_index(obj, _dot, digits) {
    return {
      kind: 'MemberExpr',
      object: obj.toAST(this.args.source),
      member: { kind: 'index', value: Number(digits.sourceString) },
      span: span(this, this.args.source),
    } as AST.MemberExpr;
  },

  LValue_deref(obj, _dot, _star) {
    return {
      kind: 'MemberExpr',
      object: obj.toAST(this.args.source),
      member: { kind: 'deref' },
      span: span(this, this.args.source),
    } as AST.MemberExpr;
  },

  LValue_typePun(obj, _dot, type) {
    return {
      kind: 'MemberExpr',
      object: obj.toAST(this.args.source),
      member: { kind: 'type', type: type.toAST(this.args.source) },
      span: span(this, this.args.source),
    } as AST.MemberExpr;
  },

  LValue_subscript(obj, _lb, index, _rb) {
    return {
      kind: 'IndexExpr',
      object: obj.toAST(this.args.source),
      index: index.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.IndexExpr;
  },

  LValue_ident(ident) {
    return {
      kind: 'IdentExpr',
      name: ident.sourceString,
      span: span(this, this.args.source),
    } as AST.IdentExpr;
  },

  // ============================================================================
  // Patterns
  // ============================================================================

  Pattern_tuple(_lp, list, _rp) {
    return {
      kind: 'TuplePattern',
      elements: list.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.TuplePattern;
  },

  Pattern_ident(ident) {
    return {
      kind: 'IdentPattern',
      name: ident.sourceString,
      span: span(this, this.args.source),
    } as AST.IdentPattern;
  },

  PatternList(list) {
    return list.asIteration().children.map((e: ohm.Node) => e.toAST(this.args.source));
  },

  PatternElem_namedExplicit(field, _colon, binding) {
    return {
      kind: 'named',
      field: field.sourceString,
      binding: binding.sourceString,
    } as AST.PatternElement;
  },

  PatternElem_namedShort(field, _colon) {
    return {
      kind: 'named',
      field: field.sourceString,
      binding: null,
    } as AST.PatternElement;
  },

  PatternElem_positional(pattern) {
    return {
      kind: 'positional',
      pattern: pattern.toAST(this.args.source),
    } as AST.PatternElement;
  },

  // ============================================================================
  // Expressions
  // ============================================================================

  Expr(expr) {
    return expr.toAST(this.args.source);
  },

  OrExpr_or(left, _op, right) {
    return {
      kind: 'BinaryExpr',
      op: '||',
      left: left.toAST(this.args.source),
      right: right.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.BinaryExpr;
  },

  OrExpr(expr) {
    return expr.toAST(this.args.source);
  },

  AndExpr_and(left, _op, right) {
    return {
      kind: 'BinaryExpr',
      op: '&&',
      left: left.toAST(this.args.source),
      right: right.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.BinaryExpr;
  },

  AndExpr(expr) {
    return expr.toAST(this.args.source);
  },

  NotExpr_not(_op, operand) {
    return {
      kind: 'UnaryExpr',
      op: '!',
      operand: operand.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.UnaryExpr;
  },

  NotExpr(expr) {
    return expr.toAST(this.args.source);
  },

  CompareExpr_compare(left, op, right) {
    return {
      kind: 'BinaryExpr',
      op: op.sourceString as AST.BinaryOp,
      left: left.toAST(this.args.source),
      right: right.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.BinaryExpr;
  },

  CompareExpr(expr) {
    return expr.toAST(this.args.source);
  },

  compareOp(_op) {
    return this.sourceString;
  },

  BitOrExpr_or(left, _op, right) {
    return {
      kind: 'BinaryExpr',
      op: '|',
      left: left.toAST(this.args.source),
      right: right.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.BinaryExpr;
  },

  BitOrExpr(expr) {
    return expr.toAST(this.args.source);
  },

  BitXorExpr_xor(left, _op, right) {
    return {
      kind: 'BinaryExpr',
      op: '^',
      left: left.toAST(this.args.source),
      right: right.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.BinaryExpr;
  },

  BitXorExpr(expr) {
    return expr.toAST(this.args.source);
  },

  BitAndExpr_and(left, _op, right) {
    return {
      kind: 'BinaryExpr',
      op: '&',
      left: left.toAST(this.args.source),
      right: right.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.BinaryExpr;
  },

  BitAndExpr(expr) {
    return expr.toAST(this.args.source);
  },

  ShiftExpr_shift(left, op, right) {
    return {
      kind: 'BinaryExpr',
      op: op.sourceString as AST.BinaryOp,
      left: left.toAST(this.args.source),
      right: right.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.BinaryExpr;
  },

  ShiftExpr(expr) {
    return expr.toAST(this.args.source);
  },

  shiftOp(_op) {
    return this.sourceString;
  },

  AddExpr_add(left, op, right) {
    return {
      kind: 'BinaryExpr',
      op: op.sourceString as AST.BinaryOp,
      left: left.toAST(this.args.source),
      right: right.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.BinaryExpr;
  },

  AddExpr(expr) {
    return expr.toAST(this.args.source);
  },

  addOp(_op) {
    return this.sourceString;
  },

  MulExpr_mul(left, op, right) {
    return {
      kind: 'BinaryExpr',
      op: op.sourceString as AST.BinaryOp,
      left: left.toAST(this.args.source),
      right: right.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.BinaryExpr;
  },

  MulExpr(expr) {
    return expr.toAST(this.args.source);
  },

  mulOp(_op) {
    return this.sourceString;
  },

  UnaryExpr_neg(_op, operand) {
    return {
      kind: 'UnaryExpr',
      op: '-',
      operand: operand.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.UnaryExpr;
  },

  UnaryExpr_complement(_op, operand) {
    return {
      kind: 'UnaryExpr',
      op: '~',
      operand: operand.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.UnaryExpr;
  },

  UnaryExpr_ref(_op, operand) {
    return {
      kind: 'UnaryExpr',
      op: '&',
      operand: operand.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.UnaryExpr;
  },

  UnaryExpr(expr) {
    return expr.toAST(this.args.source);
  },

  CastExpr_cast(expr, _as, type) {
    return {
      kind: 'CastExpr',
      expr: expr.toAST(this.args.source),
      type: type.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.CastExpr;
  },

  CastExpr_annotation(expr, _colon, type) {
    return {
      kind: 'AnnotationExpr',
      expr: expr.toAST(this.args.source),
      type: type.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.AnnotationExpr;
  },

  CastExpr(expr) {
    return expr.toAST(this.args.source);
  },

  PostfixExpr_field(obj, _dot, field) {
    return {
      kind: 'MemberExpr',
      object: obj.toAST(this.args.source),
      member: { kind: 'field', name: field.sourceString },
      span: span(this, this.args.source),
    } as AST.MemberExpr;
  },

  PostfixExpr_tupleIndex(obj, _dot, digits) {
    return {
      kind: 'MemberExpr',
      object: obj.toAST(this.args.source),
      member: { kind: 'index', value: Number(digits.sourceString) },
      span: span(this, this.args.source),
    } as AST.MemberExpr;
  },

  PostfixExpr_deref(obj, _dot, _star) {
    return {
      kind: 'MemberExpr',
      object: obj.toAST(this.args.source),
      member: { kind: 'deref' },
      span: span(this, this.args.source),
    } as AST.MemberExpr;
  },

  PostfixExpr_typePun(obj, _dot, type) {
    return {
      kind: 'MemberExpr',
      object: obj.toAST(this.args.source),
      member: { kind: 'type', type: type.toAST(this.args.source) },
      span: span(this, this.args.source),
    } as AST.MemberExpr;
  },

  PostfixExpr_index(obj, _lb, index, _rb) {
    return {
      kind: 'IndexExpr',
      object: obj.toAST(this.args.source),
      index: index.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.IndexExpr;
  },

  PostfixExpr_call(callee, _lp, argsOpt, _rp) {
    const argsNode = argsOpt.children[0];
    return {
      kind: 'CallExpr',
      callee: callee.toAST(this.args.source),
      args: argsNode ? argsNode.toAST(this.args.source) : [],
      span: span(this, this.args.source),
    } as AST.CallExpr;
  },

  PostfixExpr(expr) {
    return expr.toAST(this.args.source);
  },

  PrimaryExpr_tupleOrStruct(_lp, args, _rp) {
    return {
      kind: 'TupleExpr',
      elements: args.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.TupleExpr;
  },

  PrimaryExpr_group(_lp, expr, _rp) {
    return {
      kind: 'GroupExpr',
      expr: expr.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.GroupExpr;
  },

  PrimaryExpr_unit(_lp, _rp) {
    return {
      kind: 'TupleExpr',
      elements: [],
      span: span(this, this.args.source),
    } as AST.TupleExpr;
  },

  PrimaryExpr_constructor(typeName, _lp, argsOpt, _rp) {
    const argsNode = argsOpt.children[0];
    return {
      kind: 'CallExpr',
      callee: {
        kind: 'IdentExpr',
        name: typeName.sourceString,
        span: span(typeName, this.args.source),
      } as AST.IdentExpr,
      args: argsNode ? argsNode.toAST(this.args.source) : [],
      span: span(this, this.args.source),
    } as AST.CallExpr;
  },

  PrimaryExpr(expr) {
    return expr.toAST(this.args.source);
  },

  // ============================================================================
  // If Expression
  // ============================================================================

  IfExpr(_if, condition, then, elifs, elseOpt) {
    const elseNode = elseOpt.children[0];
    return {
      kind: 'IfExpr',
      condition: condition.toAST(this.args.source),
      thenBranch: then.toAST(this.args.source),
      elifs: elifs.children.map((e: ohm.Node) => e.toAST(this.args.source)),
      else_: elseNode ? elseNode.toAST(this.args.source) : null,
      span: span(this, this.args.source),
    } as AST.IfExpr;
  },

  ElifExpr(_elif, condition, then) {
    return {
      kind: 'ElifClause',
      condition: condition.toAST(this.args.source),
      thenBranch: then.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.ElifClause;
  },

  ElseExpr(_else, body) {
    return body.toAST(this.args.source);
  },

  // ============================================================================
  // Match Expression
  // ============================================================================

  MatchExpr(_match, subject, _lb, arms, _rb) {
    return {
      kind: 'MatchExpr',
      subject: subject.toAST(this.args.source),
      arms: arms.children.map((a: ohm.Node) => a.toAST(this.args.source)),
      span: span(this, this.args.source),
    } as AST.MatchExpr;
  },

  MatchArm(patterns, _arrow, body) {
    return {
      kind: 'MatchArm',
      patterns: patterns.toAST(this.args.source),
      body: body.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.MatchArm;
  },

  MatchPatterns(list) {
    return list.asIteration().children.map((p: ohm.Node) => p.toAST(this.args.source));
  },

  MatchPattern_literal(lit) {
    return {
      kind: 'literal',
      value: lit.toAST(this.args.source).value,
    } as AST.MatchPattern;
  },

  MatchPattern_wildcard(_underscore) {
    return { kind: 'wildcard' } as AST.MatchPattern;
  },

  // ============================================================================
  // Arguments
  // ============================================================================

  ArgList(list) {
    return list.asIteration().children.map((a: ohm.Node) => a.toAST(this.args.source));
  },

  Arg_named(name, _colon, expr) {
    return {
      kind: 'Arg',
      name: name.sourceString,
      value: expr.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.Arg;
  },

  Arg_shorthand(name, _colon) {
    return {
      kind: 'Arg',
      name: name.sourceString,
      value: null,
      span: span(this, this.args.source),
    } as AST.Arg;
  },

  Arg_positional(expr) {
    return {
      kind: 'Arg',
      name: null,
      value: expr.toAST(this.args.source),
      span: span(this, this.args.source),
    } as AST.Arg;
  },

  // ============================================================================
  // Literals
  // ============================================================================

  literal(lit) {
    return lit.toAST(this.args.source);
  },

  numberLiteral(num) {
    return num.toAST(this.args.source);
  },

  intLiteral(negOpt, num) {
    const neg = negOpt.sourceString === '-';
    const numAST = num.toAST(this.args.source);
    if (neg) {
      numAST.value.value = -numAST.value.value;
    }
    return numAST;
  },

  decimalLiteral(_digits) {
    return {
      kind: 'LiteralExpr',
      value: { kind: 'int', value: BigInt(this.sourceString), radix: 10 },
      span: span(this, this.args.source),
    } as AST.LiteralExpr;
  },

  hexLiteral(_prefix, _digits) {
    return {
      kind: 'LiteralExpr',
      value: { kind: 'int', value: BigInt(this.sourceString), radix: 16 },
      span: span(this, this.args.source),
    } as AST.LiteralExpr;
  },

  binaryLiteral(_prefix, _digits) {
    return {
      kind: 'LiteralExpr',
      value: { kind: 'int', value: BigInt(this.sourceString), radix: 2 },
      span: span(this, this.args.source),
    } as AST.LiteralExpr;
  },

  octalLiteral(_prefix, _digits) {
    return {
      kind: 'LiteralExpr',
      value: { kind: 'int', value: BigInt(this.sourceString), radix: 8 },
      span: span(this, this.args.source),
    } as AST.LiteralExpr;
  },

  dozenalLiteral(_prefix, _digits) {
    // Parse dozenal: digits 0-9, a/A=10, b/B=11
    const str = this.sourceString.slice(2); // Remove "0d"
    let value = 0n;
    for (const c of str) {
      value *= 12n;
      if (c >= '0' && c <= '9') {
        value += BigInt(c.charCodeAt(0) - 48);
      } else if (c === 'a' || c === 'A') {
        value += 10n;
      } else if (c === 'b' || c === 'B') {
        value += 11n;
      }
    }
    return {
      kind: 'LiteralExpr',
      value: { kind: 'int', value, radix: 12 as 12 },
      span: span(this, this.args.source),
    } as AST.LiteralExpr;
  },

  floatLiteral(_neg, _int, _dot, _frac, _exp) {
    return {
      kind: 'LiteralExpr',
      value: { kind: 'float', value: parseFloat(this.sourceString) },
      span: span(this, this.args.source),
    } as AST.LiteralExpr;
  },

  stringLiteral(str) {
    return str.toAST(this.args.source);
  },

  utf8String(_lq, chars, _rq) {
    const value = chars.children.map((c: ohm.Node) => c.toAST(this.args.source)).join('');
    return {
      kind: 'LiteralExpr',
      value: { kind: 'string', value, format: 'utf8' },
      span: span(this, this.args.source),
    } as AST.LiteralExpr;
  },

  charString(_lq, chars, _rq) {
    const value = chars.children.map((c: ohm.Node) => c.toAST(this.args.source)).join('');
    return {
      kind: 'LiteralExpr',
      value: { kind: 'string', value, format: 'char' },
      span: span(this, this.args.source),
    } as AST.LiteralExpr;
  },

  hexString(_prefix, bytes, _rq) {
    // Just store the hex string as-is for now
    const value = bytes.sourceString.replace(/\s+/g, '');
    return {
      kind: 'LiteralExpr',
      value: { kind: 'string', value, format: 'hex' },
      span: span(this, this.args.source),
    } as AST.LiteralExpr;
  },

  base64String(_prefix, chars, _rq) {
    const value = chars.sourceString.replace(/\s+/g, '');
    return {
      kind: 'LiteralExpr',
      value: { kind: 'string', value, format: 'base64' },
      span: span(this, this.args.source),
    } as AST.LiteralExpr;
  },

  utf8Char(char) {
    return char.toAST(this.args.source);
  },

  escapeSeq_hex(_backslash, _x, d1, d2) {
    return String.fromCharCode(parseInt(d1.sourceString + d2.sourceString, 16));
  },

  escapeSeq_simple(_backslash, char) {
    const c = char.sourceString;
    if (c === 'n') return '\n';
    if (c === 't') return '\t';
    if (c === 'r') return '\r';
    if (c === '\\') return '\\';
    if (c === '"') return '"';
    if (c === "'") return "'";
    return c;
  },

  escapeSeq(seq) {
    return seq.toAST(this.args.source);
  },

  escapeChar(_char) {
    return this.sourceString;
  },

  boolLiteral(bool) {
    return {
      kind: 'LiteralExpr',
      value: { kind: 'bool', value: bool.sourceString === 'true' },
      span: span(this, this.args.source),
    } as AST.LiteralExpr;
  },

  // ============================================================================
  // Identifiers
  // ============================================================================

  ident(_first, _rest) {
    return this.sourceString;
  },

  // Fallback for terminals
  _terminal() {
    return this.sourceString;
  },

  _iter(...children) {
    return children.map((c: ohm.Node) => c.toAST(this.args.source));
  },
});
