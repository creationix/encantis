// =============================================================================
// Encantis Type Checker
// Semantic analysis: symbol resolution, type inference, and error reporting
// =============================================================================

import type {
  Span, Diagnostic, Type, PrimitiveType, SliceType, PointerType, TupleType,
  StructType, NamedType, Expr, Stmt, Body, Pattern,
  ImportDecl, ExportDecl, FuncDecl,
  Module, ParseResult,
  Symbol as EncSymbol, SymbolKind, Scope, CheckResult,
} from './types';

// -----------------------------------------------------------------------------
// Checker State
// -----------------------------------------------------------------------------

interface Checker {
  src: string;
  errors: Diagnostic[];
  globalScope: Scope;
  currentScope: Scope;
  functionScopes: Map<FuncDecl, Scope>;
  currentFunction?: FuncDecl;
}

// -----------------------------------------------------------------------------
// Scope Helpers
// -----------------------------------------------------------------------------

function createScope(parent?: Scope): Scope {
  return { parent, symbols: new Map() };
}

function defineSymbol(c: Checker, name: string, kind: SymbolKind, span: Span, type?: Type, mutable?: boolean): void {
  const existing = c.currentScope.symbols.get(name);
  if (existing) {
    addError(c, span, `Duplicate definition of '${name}'. Already defined at line ${getLine(c, existing.span)}.`);
    return;
  }
  c.currentScope.symbols.set(name, { name, kind, type, span, mutable });
}

function lookupSymbol(c: Checker, name: string): EncSymbol | undefined {
  let scope: Scope | undefined = c.currentScope;
  while (scope) {
    const sym = scope.symbols.get(name);
    if (sym) return sym;
    scope = scope.parent;
  }
  return undefined;
}

function addError(c: Checker, span: Span, message: string): void {
  c.errors.push({ span, severity: 'error', message });
}

function getLine(c: Checker, span: Span): number {
  let line = 1;
  for (let i = 0; i < span.start && i < c.src.length; i++) {
    if (c.src[i] === '\n') line++;
  }
  return line;
}

// -----------------------------------------------------------------------------
// Type Utilities
// -----------------------------------------------------------------------------

function typeToString(type: Type): string {
  switch (type.kind) {
    case 'PrimitiveType': return type.name;
    case 'SliceType': return `[${typeToString(type.element)}]`;
    case 'ArrayType': return `[${typeToString(type.element)}*${type.length}]`;
    case 'PointerType': return `*${typeToString(type.target)}`;
    case 'TupleType':
      return type.elements.length === 0 ? '()' : `(${type.elements.map(typeToString).join(', ')})`;
    case 'StructType':
      return `(${type.fields.map(f => `${f.name}: ${typeToString(f.type)}`).join(', ')})`;
    case 'NamedType': return type.name;
    case 'NullTermType': return `[${typeToString(type.element)}/0]`;
    case 'ErrorType': return '?';
  }
}

function typesEqual(a: Type, b: Type): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'PrimitiveType': return a.name === (b as PrimitiveType).name;
    case 'SliceType': return typesEqual(a.element, (b as SliceType).element);
    case 'PointerType': return typesEqual(a.target, (b as PointerType).target);
    case 'TupleType': {
      const bt = b as TupleType;
      return a.elements.length === bt.elements.length &&
        a.elements.every((el, i) => typesEqual(el, bt.elements[i]));
    }
    case 'StructType': {
      const bs = b as StructType;
      return a.fields.length === bs.fields.length &&
        a.fields.every((f, i) => f.name === bs.fields[i].name && typesEqual(f.type, bs.fields[i].type));
    }
    case 'NamedType': return a.name === (b as NamedType).name;
    default: return false;
  }
}

function isNumericType(type: Type): boolean {
  if (type.kind !== 'PrimitiveType') return false;
  return ['i32', 'u32', 'i64', 'u64', 'f32', 'f64', 'u8', 'u16', 'i8', 'i16'].includes(type.name);
}

function isIntegerType(type: Type): boolean {
  if (type.kind !== 'PrimitiveType') return false;
  return ['i32', 'u32', 'i64', 'u64', 'u8', 'u16', 'i8', 'i16'].includes(type.name);
}

function isFloatType(type: Type): boolean {
  if (type.kind !== 'PrimitiveType') return false;
  return type.name === 'f32' || type.name === 'f64';
}

function resolveNamedType(c: Checker, name: string): Type | undefined {
  const sym = c.globalScope.symbols.get(name);
  if (sym?.kind === 'type' && sym.type) return sym.type;
  return undefined;
}

function resolveType(c: Checker, type: Type): Type {
  if (type.kind === 'NamedType') {
    const resolved = resolveNamedType(c, type.name);
    if (resolved) return resolveType(c, resolved);
  }
  return type;
}

function typesCompatible(a: Type, b: Type, checker?: Checker): boolean {
  if (typesEqual(a, b)) return true;
  if (isNumericType(a) && isNumericType(b)) return true;
  if (checker) {
    const resolvedA = resolveType(checker, a);
    const resolvedB = resolveType(checker, b);
    if (resolvedA.kind === 'StructType' && resolvedB.kind === 'StructType') {
      return resolvedA.fields.length === resolvedB.fields.length &&
        resolvedA.fields.every((f, i) => f.name === resolvedB.fields[i].name &&
          typesCompatible(f.type, resolvedB.fields[i].type, checker));
    }
  }
  return false;
}

// -----------------------------------------------------------------------------
// Expression Checking
// -----------------------------------------------------------------------------

function checkExpr(c: Checker, expr: Expr): Type | undefined {
  switch (expr.kind) {
    case 'NumberLit': {
      const val = expr.value;
      if (val.includes('.') || val.includes('e') || val.includes('E')) {
        return { kind: 'PrimitiveType', name: 'f64', span: expr.span };
      }
      return { kind: 'PrimitiveType', name: 'i32', span: expr.span };
    }

    case 'StringLit':
      return { kind: 'SliceType', element: { kind: 'PrimitiveType', name: 'u8', span: expr.span }, span: expr.span };

    case 'BoolLit':
      return { kind: 'PrimitiveType', name: 'bool', span: expr.span };

    case 'Identifier': {
      const sym = lookupSymbol(c, expr.name);
      if (!sym) {
        addError(c, expr.span, `Undefined variable '${expr.name}'.`);
        return undefined;
      }
      return sym.type;
    }

    case 'BinaryExpr': {
      const leftType = checkExpr(c, expr.left);
      const rightType = checkExpr(c, expr.right);
      if (!leftType || !rightType) return undefined;

      const comparisonOps = ['==', '!=', '<', '>', '<=', '>='];
      if (comparisonOps.includes(expr.op)) {
        return { kind: 'PrimitiveType', name: 'bool', span: expr.span };
      }
      if (expr.op === '&&' || expr.op === '||') {
        return { kind: 'PrimitiveType', name: 'bool', span: expr.span };
      }
      if ((expr.op === '+' || expr.op === '-') && leftType.kind === 'PointerType' && isIntegerType(rightType)) {
        return leftType;
      }
      return leftType;
    }

    case 'UnaryExpr': {
      const operandType = checkExpr(c, expr.operand);
      if (!operandType) return undefined;
      if (expr.op === '!') {
        return { kind: 'PrimitiveType', name: 'bool', span: expr.span };
      }
      if (expr.op === '&') {
        return { kind: 'PointerType', target: operandType, span: expr.span };
      }
      return operandType;
    }

    case 'CallExpr': {
      let calleeType: Type | undefined;
      if (expr.callee.kind === 'Identifier') {
        const sym = lookupSymbol(c, expr.callee.name);
        if (!sym) {
          addError(c, expr.callee.span, `Undefined function '${expr.callee.name}'.`);
          return undefined;
        }
        calleeType = sym.type;
      } else {
        calleeType = checkExpr(c, expr.callee);
      }
      if (!calleeType) return undefined;

      // Check arguments
      for (const arg of expr.args) {
        checkExpr(c, arg.value);
      }

      // For now, return the callee type (should extract return type from FunctionType)
      return calleeType;
    }

    case 'IndexExpr': {
      const objType = checkExpr(c, expr.target);
      checkExpr(c, expr.index);
      if (!objType) return undefined;
      if (objType.kind === 'SliceType') return objType.element;
      if (objType.kind === 'ArrayType') return objType.element;
      addError(c, expr.target.span, `Cannot index into type '${typeToString(objType)}'.`);
      return undefined;
    }

    case 'MemberExpr': {
      const objType = checkExpr(c, expr.target);
      if (!objType) return undefined;

      const member = typeof expr.member === 'number' ? String(expr.member) : expr.member;

      if (objType.kind === 'SliceType') {
        if (member === 'ptr') return { kind: 'PointerType', target: objType.element, span: expr.span };
        if (member === 'len') return { kind: 'PrimitiveType', name: 'u32', span: expr.span };
      }
      if (objType.kind === 'PointerType' && expr.isDeref) {
        return objType.target;
      }
      if (objType.kind === 'TupleType') {
        const idx = typeof expr.member === 'number' ? expr.member : parseInt(member, 10);
        if (!Number.isNaN(idx) && idx >= 0 && idx < objType.elements.length) {
          return objType.elements[idx];
        }
      }
      if (objType.kind === 'StructType') {
        const field = objType.fields.find(f => f.name === member);
        if (field) return field.type;
        addError(c, expr.span, `Struct has no field '${member}'.`);
        return undefined;
      }
      if (objType.kind === 'NamedType') {
        const resolved = resolveNamedType(c, objType.name);
        if (resolved?.kind === 'StructType') {
          const field = resolved.fields.find(f => f.name === member);
          if (field) return field.type;
        }
      }
      addError(c, expr.span, `Type '${typeToString(objType)}' has no property '${member}'.`);
      return undefined;
    }

    case 'CastExpr':
      checkExpr(c, expr.expr);
      return expr.type;

    case 'AnnotationExpr':
      checkExpr(c, expr.expr);
      return expr.type;

    case 'TupleLit': {
      const elements = expr.elements.map(e => checkExpr(c, e.value)).filter((t): t is Type => t !== undefined);
      return { kind: 'TupleType', elements, span: expr.span };
    }

    case 'StructLit': {
      const fields: Array<{ name: string; type: Type; span: Span }> = [];
      for (const field of expr.fields) {
        const fieldName = field.name;
        if (!fieldName) continue;
        const fieldType = checkExpr(c, field.value) ?? lookupSymbol(c, fieldName)?.type;
        if (fieldType) {
          fields.push({ name: fieldName, type: fieldType, span: expr.span });
        }
      }
      return { kind: 'StructType', fields, span: expr.span };
    }

    case 'IfExpr': {
      checkExpr(c, expr.condition);
      checkBody(c, expr.thenBranch);
      for (const elif of expr.elifBranches) {
        checkExpr(c, elif.condition);
        checkBody(c, elif.body);
      }
      if (expr.elseBranch) checkBody(c, expr.elseBranch);
      return undefined; // Could infer from branches
    }

    case 'MatchExpr': {
      checkExpr(c, expr.subject);
      for (const arm of expr.arms) {
        checkBody(c, arm.body);
      }
      return undefined;
    }

    case 'GroupExpr':
      return checkExpr(c, expr.expr);

    case 'ConstructorExpr': {
      for (const arg of expr.args) {
        checkExpr(c, arg.value);
      }
      return { kind: 'NamedType', name: expr.typeName, span: expr.span };
    }

    case 'ErrorExpr':
      return undefined;
  }
}

// -----------------------------------------------------------------------------
// Statement Checking
// -----------------------------------------------------------------------------

function checkStmt(c: Checker, stmt: Stmt): void {
  switch (stmt.kind) {
    case 'LetStmt': {
      const initType = stmt.init ? checkExpr(c, stmt.init) : undefined;
      const type = stmt.type || initType;
      definePatternSymbols(c, stmt.pattern, type, true);
      break;
    }

    case 'SetStmt': {
      const valueType = checkExpr(c, stmt.value);
      // Check that pattern variables exist and are mutable
      checkPatternAssignment(c, stmt.pattern, valueType);
      break;
    }

    case 'AssignStmt': {
      checkExpr(c, stmt.value);
      if (stmt.target.kind === 'Identifier') {
        const sym = lookupSymbol(c, stmt.target.name);
        if (!sym) {
          addError(c, stmt.target.span, `Undefined variable '${stmt.target.name}'.`);
        } else if (!sym.mutable && sym.kind !== 'param') {
          addError(c, stmt.target.span, `Cannot assign to immutable '${stmt.target.name}'.`);
        }
      } else {
        checkExpr(c, stmt.target);
      }
      break;
    }

    case 'ExprStmt':
      checkExpr(c, stmt.expr);
      break;

    case 'ReturnStmt':
      if (stmt.value) checkExpr(c, stmt.value);
      if (stmt.when) checkExpr(c, stmt.when);
      break;

    case 'IfStmt': {
      checkExpr(c, stmt.condition);
      checkBody(c, stmt.thenBody);
      for (const elif of stmt.elifClauses) {
        checkExpr(c, elif.condition);
        checkBody(c, elif.body);
      }
      if (stmt.elseBody) checkBody(c, stmt.elseBody);
      break;
    }

    case 'WhileStmt':
      checkExpr(c, stmt.condition);
      checkBody(c, stmt.body);
      break;

    case 'ForStmt': {
      const iterType = checkExpr(c, stmt.iterable);
      const outerScope = c.currentScope;
      c.currentScope = createScope(outerScope);

      let varType: Type | undefined;
      if (iterType) {
        if (iterType.kind === 'SliceType') varType = iterType.element;
        else if (isIntegerType(iterType)) varType = iterType;
      }
      varType = varType || { kind: 'PrimitiveType', name: 'i32', span: stmt.span };
      defineSymbol(c, stmt.binding, 'local', stmt.span, varType, false);
      if (stmt.indexBinding) {
        defineSymbol(c, stmt.indexBinding, 'local', stmt.span, { kind: 'PrimitiveType', name: 'u32', span: stmt.span }, false);
      }

      checkBody(c, stmt.body);
      c.currentScope = outerScope;
      break;
    }

    case 'LoopStmt':
      checkBody(c, stmt.body);
      break;

    case 'BreakStmt':
    case 'ContinueStmt':
      if (stmt.when) checkExpr(c, stmt.when);
      break;

    case 'ErrorStmt':
      break;
  }
}

function checkBody(c: Checker, body: Body): void {
  if (body.kind === 'BlockBody') {
    for (const stmt of body.stmts) {
      checkStmt(c, stmt);
    }
  } else {
    checkExpr(c, body.expr);
  }
}

// -----------------------------------------------------------------------------
// Pattern Helpers
// -----------------------------------------------------------------------------

function definePatternSymbols(c: Checker, pattern: Pattern, type: Type | undefined, mutable: boolean): void {
  switch (pattern.kind) {
    case 'IdentPattern':
      defineSymbol(c, pattern.name, 'local', pattern.span, type, mutable);
      break;
    case 'TuplePattern':
      for (let i = 0; i < pattern.elements.length; i++) {
        const elemType = type?.kind === 'TupleType' ? type.elements[i] : undefined;
        definePatternSymbols(c, pattern.elements[i].pattern, elemType, mutable);
      }
      break;
    case 'StructPattern':
      for (const field of pattern.fields) {
        let fieldType: Type | undefined;
        if (type) {
          const resolved = resolveType(c, type);
          if (resolved.kind === 'StructType') {
            fieldType = resolved.fields.find(f => f.name === field.fieldName)?.type;
          }
        }
        const varName = field.binding || field.fieldName;
        defineSymbol(c, varName, 'local', field.span, fieldType, mutable);
      }
      break;
    case 'ErrorPattern':
      break;
  }
}

function checkPatternAssignment(c: Checker, pattern: Pattern, valueType: Type | undefined): void {
  switch (pattern.kind) {
    case 'IdentPattern': {
      const sym = lookupSymbol(c, pattern.name);
      if (!sym) {
        addError(c, pattern.span, `Undefined variable '${pattern.name}'.`);
      } else if (!sym.mutable) {
        addError(c, pattern.span, `Cannot assign to immutable '${pattern.name}'.`);
      }
      break;
    }
    case 'TuplePattern':
      for (let i = 0; i < pattern.elements.length; i++) {
        const elemType = valueType?.kind === 'TupleType' ? valueType.elements[i] : undefined;
        checkPatternAssignment(c, pattern.elements[i].pattern, elemType);
      }
      break;
    case 'StructPattern':
      for (const field of pattern.fields) {
        const varName = field.binding || field.fieldName;
        const sym = lookupSymbol(c, varName);
        if (!sym) {
          addError(c, field.span, `Undefined variable '${varName}'.`);
        } else if (!sym.mutable) {
          addError(c, field.span, `Cannot assign to immutable '${varName}'.`);
        }
      }
      break;
    case 'ErrorPattern':
      break;
  }
}

// -----------------------------------------------------------------------------
// Function Checking
// -----------------------------------------------------------------------------

function checkFunction(c: Checker, func: FuncDecl): void {
  const outerScope = c.currentScope;
  const funcScope = createScope(c.globalScope);
  c.currentScope = funcScope;
  c.currentFunction = func;
  c.functionScopes.set(func, funcScope);

  // Register parameters
  for (const param of func.signature.params) {
    if (param.name) {
      defineSymbol(c, param.name, 'param', param.span, param.type, false);
    }
  }

  // Register named returns as mutable locals
  const returns = func.signature.returns;
  if (returns && 'kind' in returns && returns.kind === 'NamedReturns') {
    for (const field of returns.fields) {
      if (!c.currentScope.symbols.has(field.name)) {
        defineSymbol(c, field.name, 'local', field.span, field.type, true);
      }
    }
  }

  // Check body
  checkBody(c, func.body);

  c.currentScope = outerScope;
  c.currentFunction = undefined;
}

// -----------------------------------------------------------------------------
// Module Checking
// -----------------------------------------------------------------------------

function checkModule(c: Checker, module: Module): void {
  // First pass: register all top-level declarations
  for (const decl of module.decls) {
    switch (decl.kind) {
      case 'ImportDecl':
        checkImport(c, decl);
        break;
      case 'GlobalDecl':
        if (decl.init) checkExpr(c, decl.init);
        defineSymbol(c, decl.name, 'global', decl.span, decl.type, true);
        break;
      case 'TypeDecl':
        defineSymbol(c, decl.name, 'type', decl.span, decl.type);
        break;
      case 'DefDecl': {
        const defType = checkExpr(c, decl.value);
        defineSymbol(c, decl.name, 'define', decl.span, defType);
        break;
      }
      case 'ExportDecl':
        registerExportedFunc(c, decl);
        break;
      case 'FuncDecl':
        if (decl.name) registerFunc(c, decl);
        break;
    }
  }

  // Second pass: check function bodies
  for (const decl of module.decls) {
    if (decl.kind === 'ExportDecl' && decl.decl.kind === 'FuncDecl') {
      checkFunction(c, decl.decl);
    } else if (decl.kind === 'FuncDecl') {
      checkFunction(c, decl);
    }
  }
}

function checkImport(c: Checker, imp: ImportDecl): void {
  for (const item of imp.items) {
    if (item.item.kind === 'func') {
      const localName = item.externalName;
      defineSymbol(c, localName, 'import', item.span, undefined); // TODO: build FunctionType from signature
    } else if (item.item.kind === 'global') {
      defineSymbol(c, item.item.name, 'import', item.span, item.item.type);
    }
  }
}

function registerFunc(c: Checker, func: FuncDecl): void {
  if (!func.name) return;
  defineSymbol(c, func.name, 'function', func.span, undefined); // TODO: build FunctionType
}

function registerExportedFunc(c: Checker, exp: ExportDecl): void {
  if (exp.decl.kind === 'FuncDecl') {
    const name = exp.decl.name || exp.exportName;
    defineSymbol(c, name, 'function', exp.decl.span, undefined); // TODO: build FunctionType
  }
}

// -----------------------------------------------------------------------------
// Builtins
// -----------------------------------------------------------------------------

function registerBuiltins(c: Checker): void {
  const defaultSpan: Span = { start: 0, end: 0 };
  const builtins = [
    // Float builtins
    'sqrt', 'abs', 'ceil', 'floor', 'trunc', 'nearest', 'min', 'max', 'copysign',
    // Integer builtins
    'clz', 'ctz', 'popcnt',
    // Memory builtins
    'memory-size', 'memory-grow',
  ];
  for (const name of builtins) {
    c.globalScope.symbols.set(name, {
      name,
      kind: 'builtin',
      type: undefined,
      span: defaultSpan,
    });
  }
}

// -----------------------------------------------------------------------------
// Main Entry Point
// -----------------------------------------------------------------------------

export function check(parseResult: ParseResult, src: string): CheckResult {
  const globalScope = createScope();
  const c: Checker = {
    src,
    errors: [...parseResult.errors],
    globalScope,
    currentScope: globalScope,
    functionScopes: new Map(),
  };

  registerBuiltins(c);
  checkModule(c, parseResult.ast);

  return {
    errors: c.errors,
    symbols: { global: globalScope, scopes: c.functionScopes },
  };
}
