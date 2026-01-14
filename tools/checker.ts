// =============================================================================
// Encantis Type Checker
// Semantic analysis: symbol resolution, type inference, and error reporting
// =============================================================================

import {
  Span, Diagnostic,
  Type, PrimitiveType, SliceType, PointerType, TupleType, FunctionType,
  Expr, Stmt, Param,
  Import, ImportGroup, ImportSingle,
  FuncDecl, FuncBody, ArrowBody, BlockBody,
  ExportDecl, GlobalDecl,
  Module, ParseResult, CheckResult,
  Symbol, SymbolKind, Scope, SymbolTable,
} from './types';

// -----------------------------------------------------------------------------
// Checker State
// -----------------------------------------------------------------------------

interface Checker {
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
  return {
    parent,
    symbols: new Map(),
  };
}

function defineSymbol(c: Checker, name: string, kind: SymbolKind, span: Span, type?: Type, mutable?: boolean): void {
  // Check for duplicate in current scope
  if (c.currentScope.symbols.has(name)) {
    const existing = c.currentScope.symbols.get(name)!;
    addError(c, span, `Duplicate definition of '${name}'. It was already defined at line ${getLine(existing.span)}.`);
    return;
  }

  c.currentScope.symbols.set(name, {
    name,
    kind,
    type,
    span,
    mutable,
  });
}

function lookupSymbol(c: Checker, name: string): Symbol | undefined {
  let scope: Scope | undefined = c.currentScope;

  while (scope) {
    const sym = scope.symbols.get(name);
    if (sym) return sym;
    scope = scope.parent;
  }

  return undefined;
}

function addError(c: Checker, span: Span, message: string): void {
  c.errors.push({
    span,
    severity: 'error',
    message,
  });
}

function addWarning(c: Checker, span: Span, message: string): void {
  c.errors.push({
    span,
    severity: 'warning',
    message,
  });
}

// Placeholder for getting line number from span
function getLine(span: Span): number {
  return span.start; // TODO: Calculate actual line number
}

// -----------------------------------------------------------------------------
// Type Utilities
// -----------------------------------------------------------------------------

function typeToString(type: Type): string {
  switch (type.kind) {
    case 'PrimitiveType':
      return type.name;
    case 'SliceType':
      return `[${typeToString(type.element)}]`;
    case 'FixedArrayType':
      return `[${typeToString(type.element)}*${type.length}]`;
    case 'PointerType':
      return `*${typeToString(type.target)}`;
    case 'TupleType':
      if (type.elements.length === 0) return '()';
      return `(${type.elements.map(typeToString).join(', ')})`;
    case 'FunctionType':
      return `(${type.params.map(typeToString).join(', ')}) -> ${typeToString(type.returns)}`;
    default:
      return '?';
  }
}

function typesEqual(a: Type, b: Type): boolean {
  if (a.kind !== b.kind) return false;

  switch (a.kind) {
    case 'PrimitiveType':
      return a.name === (b as PrimitiveType).name;
    case 'SliceType':
      return typesEqual(a.element, (b as SliceType).element);
    case 'PointerType':
      return typesEqual(a.target, (b as PointerType).target);
    case 'TupleType': {
      const bt = b as TupleType;
      if (a.elements.length !== bt.elements.length) return false;
      return a.elements.every((el, i) => typesEqual(el, bt.elements[i]));
    }
    case 'FunctionType': {
      const bf = b as FunctionType;
      if (a.params.length !== bf.params.length) return false;
      if (!typesEqual(a.returns, bf.returns)) return false;
      return a.params.every((p, i) => typesEqual(p, bf.params[i]));
    }
    default:
      return false;
  }
}

// Check if a type is numeric
function isNumericType(type: Type): boolean {
  if (type.kind !== 'PrimitiveType') return false;
  const numericTypes = ['i32', 'u32', 'i64', 'u64', 'f32', 'f64', 'u8', 'u16', 'i8', 'i16'];
  return numericTypes.includes(type.name);
}

function isIntegerType(type: Type): boolean {
  if (type.kind !== 'PrimitiveType') return false;
  const intTypes = ['i32', 'u32', 'i64', 'u64', 'u8', 'u16', 'i8', 'i16'];
  return intTypes.includes(type.name);
}

function isFloatType(type: Type): boolean {
  if (type.kind !== 'PrimitiveType') return false;
  return type.name === 'f32' || type.name === 'f64';
}

// -----------------------------------------------------------------------------
// Import Checking
// -----------------------------------------------------------------------------

function checkImport(c: Checker, imp: Import): void {
  if (imp.kind === 'ImportGroup') {
    for (const item of imp.items) {
      const localName = item.localName || item.exportName;

      // Build function type from params and return
      const paramTypes = item.params.map(p => p.type);
      const returnType = item.returnType || { kind: 'TupleType' as const, elements: [], span: item.span };

      const funcType: FunctionType = {
        kind: 'FunctionType',
        params: paramTypes,
        returns: returnType,
        span: item.span,
      };

      defineSymbol(c, localName, 'import', item.span, funcType);
    }
  } else {
    // ImportSingle
    const localName = imp.localName || imp.exportName;
    defineSymbol(c, localName, 'import', imp.span, imp.funcType);
  }
}

// -----------------------------------------------------------------------------
// Expression Checking
// -----------------------------------------------------------------------------

function checkExpr(c: Checker, expr: Expr): Type | undefined {
  switch (expr.kind) {
    case 'NumberLiteral': {
      // Infer type from suffix or context
      if (expr.suffix) {
        return { kind: 'PrimitiveType', name: expr.suffix, span: expr.span };
      }
      // Default: i32 for integers, f64 for floats
      if (expr.value.includes('.') || expr.value.includes('e') || expr.value.includes('E')) {
        return { kind: 'PrimitiveType', name: 'f64', span: expr.span };
      }
      return { kind: 'PrimitiveType', name: 'i32', span: expr.span };
    }

    case 'StringLiteral': {
      // String literals become byte slices
      return { kind: 'SliceType', element: { kind: 'PrimitiveType', name: 'u8', span: expr.span }, span: expr.span };
    }

    case 'Identifier': {
      const sym = lookupSymbol(c, expr.name);
      if (!sym) {
        addError(c, expr.span, `Undefined variable '${expr.name}'. Did you forget to declare it with 'local'?`);
        return undefined;
      }
      return sym.type;
    }

    case 'BinaryExpr': {
      const leftType = checkExpr(c, expr.left);
      const rightType = checkExpr(c, expr.right);

      if (!leftType || !rightType) {
        return undefined;
      }

      // Comparison operators return i32 (boolean)
      const comparisonOps = ['==', '!=', '<', '>', '<=', '>='];
      if (comparisonOps.includes(expr.op)) {
        return { kind: 'PrimitiveType', name: 'i32', span: expr.span };
      }

      // Logical operators return i32
      if (expr.op === 'and' || expr.op === 'or') {
        return { kind: 'PrimitiveType', name: 'i32', span: expr.span };
      }

      // Arithmetic/bitwise: result type matches operands
      // For simplicity, return left type (should be more sophisticated)
      return leftType;
    }

    case 'UnaryExpr': {
      const operandType = checkExpr(c, expr.operand);
      if (!operandType) return undefined;

      if (expr.op === 'not') {
        return { kind: 'PrimitiveType', name: 'i32', span: expr.span };
      }

      return operandType;
    }

    case 'CallExpr': {
      // Get callee type
      let calleeType: Type | undefined;

      if (expr.callee.kind === 'Identifier') {
        const sym = lookupSymbol(c, expr.callee.name);
        if (!sym) {
          addError(c, expr.callee.span, `Undefined function '${expr.callee.name}'. Make sure it's imported or defined.`);
          return undefined;
        }
        calleeType = sym.type;
      } else {
        calleeType = checkExpr(c, expr.callee);
      }

      if (!calleeType) return undefined;

      if (calleeType.kind !== 'FunctionType') {
        addError(c, expr.callee.span, `Cannot call '${expr.callee.kind === 'Identifier' ? expr.callee.name : 'expression'}' because it's not a function.`);
        return undefined;
      }

      // Check argument count
      if (expr.args.length !== calleeType.params.length) {
        addError(c, expr.span,
          `Function expects ${calleeType.params.length} argument(s), but got ${expr.args.length}.`);
      }

      // Check argument types
      for (let i = 0; i < Math.min(expr.args.length, calleeType.params.length); i++) {
        const argType = checkExpr(c, expr.args[i]);
        const paramType = calleeType.params[i];

        if (argType && !typesCompatible(argType, paramType)) {
          addError(c, expr.args[i].span,
            `Argument ${i + 1} has type '${typeToString(argType)}', but expected '${typeToString(paramType)}'.`);
        }
      }

      return calleeType.returns;
    }

    case 'IndexExpr': {
      const objType = checkExpr(c, expr.object);
      const idxType = checkExpr(c, expr.index);

      if (!objType) return undefined;

      if (objType.kind === 'SliceType') {
        if (idxType && !isIntegerType(idxType)) {
          addError(c, expr.index.span, `Array index must be an integer, but got '${typeToString(idxType)}'.`);
        }
        return objType.element;
      }

      if (objType.kind === 'FixedArrayType') {
        return objType.element;
      }

      addError(c, expr.object.span, `Cannot index into type '${typeToString(objType)}'. Expected a slice or array.`);
      return undefined;
    }

    case 'MemberExpr': {
      const objType = checkExpr(c, expr.object);
      if (!objType) return undefined;

      // Handle slice properties
      if (objType.kind === 'SliceType') {
        if (expr.member === 'ptr') {
          return { kind: 'PointerType', target: objType.element, span: expr.span };
        }
        if (expr.member === 'len') {
          return { kind: 'PrimitiveType', name: 'u32', span: expr.span };
        }
      }

      // Handle pointer dereference: ptr.*
      if (objType.kind === 'PointerType' && expr.member === '*') {
        return objType.target;
      }

      // Handle tuple access: tuple.1, tuple.2
      if (objType.kind === 'TupleType') {
        const idx = parseInt(expr.member, 10);
        if (!isNaN(idx) && idx >= 1 && idx <= objType.elements.length) {
          return objType.elements[idx - 1];
        }
        addError(c, expr.span, `Tuple index '${expr.member}' is out of bounds. Tuple has ${objType.elements.length} element(s).`);
        return undefined;
      }

      addError(c, expr.span, `Type '${typeToString(objType)}' has no property '${expr.member}'.`);
      return undefined;
    }

    case 'CastExpr': {
      checkExpr(c, expr.expr);
      return expr.type;
    }

    case 'TupleExpr': {
      const elementTypes = expr.elements.map(e => checkExpr(c, e)).filter((t): t is Type => t !== undefined);
      return { kind: 'TupleType', elements: elementTypes, span: expr.span };
    }

    case 'TernaryExpr': {
      checkExpr(c, expr.condition);
      const thenType = checkExpr(c, expr.thenExpr);
      const elseType = checkExpr(c, expr.elseExpr);

      if (thenType && elseType && !typesCompatible(thenType, elseType)) {
        addError(c, expr.span,
          `Ternary branches have different types: '${typeToString(thenType)}' vs '${typeToString(elseType)}'.`);
      }

      return thenType || elseType;
    }

    case 'ErrorExpr':
      return undefined;
  }
}

function typesCompatible(a: Type, b: Type): boolean {
  // For now, use exact equality with some numeric coercion
  if (typesEqual(a, b)) return true;

  // Allow numeric coercion for MVP
  if (isNumericType(a) && isNumericType(b)) {
    // Allow integer to float
    if (isIntegerType(a) && isFloatType(b)) return true;
    if (isFloatType(a) && isIntegerType(b)) return true;
    // Allow same-size integers
    return true;
  }

  return false;
}

// -----------------------------------------------------------------------------
// Statement Checking
// -----------------------------------------------------------------------------

function checkStmt(c: Checker, stmt: Stmt): void {
  switch (stmt.kind) {
    case 'LocalDecl': {
      // Infer type from initializer if not provided
      let type = stmt.type;
      if (stmt.init) {
        const initType = checkExpr(c, stmt.init);
        if (!type && initType) {
          type = initType;
        } else if (type && initType && !typesCompatible(initType, type)) {
          addError(c, stmt.init.span,
            `Cannot assign '${typeToString(initType)}' to variable of type '${typeToString(type)}'.`);
        }
      }

      if (!type) {
        addError(c, stmt.span,
          `Cannot infer type for '${stmt.name}'. Add a type annotation or initializer.`);
        type = { kind: 'PrimitiveType', name: 'unknown', span: stmt.span };
      }

      defineSymbol(c, stmt.name, 'local', stmt.span, type, true);
      break;
    }

    case 'Assignment': {
      const valueType = checkExpr(c, stmt.value);

      // For multi-target assignment, unpack tuple types
      const targetTypes: (Type | undefined)[] = [];
      if (stmt.targets.length > 1 && valueType?.kind === 'TupleType') {
        // Unpack tuple: d, a = func_returning_tuple()
        if (valueType.elements.length !== stmt.targets.length) {
          addError(c, stmt.value.span,
            `Cannot unpack ${valueType.elements.length} values into ${stmt.targets.length} targets.`);
        }
        for (let i = 0; i < stmt.targets.length; i++) {
          targetTypes.push(valueType.elements[i]);
        }
      } else {
        // Single value assigned to all targets (or single target)
        for (let i = 0; i < stmt.targets.length; i++) {
          targetTypes.push(valueType);
        }
      }

      for (let i = 0; i < stmt.targets.length; i++) {
        const target = stmt.targets[i];
        const expectedType = targetTypes[i];
        const sym = lookupSymbol(c, target.name);

        if (!sym) {
          addError(c, target.span, `Undefined variable '${target.name}'. Did you forget to declare it with 'local'?`);
          continue;
        }

        if (sym.kind !== 'local' && sym.kind !== 'param' && sym.mutable !== true) {
          addError(c, target.span, `Cannot assign to '${target.name}' because it's not mutable.`);
        }

        if (expectedType && sym.type && !typesCompatible(expectedType, sym.type)) {
          addError(c, stmt.value.span,
            `Cannot assign '${typeToString(expectedType)}' to '${target.name}' of type '${typeToString(sym.type)}'.`);
        }
      }
      break;
    }

    case 'ExprStmt':
      checkExpr(c, stmt.expr);
      break;

    case 'ReturnStmt':
      if (stmt.value) {
        checkExpr(c, stmt.value);
      }
      if (stmt.condition) {
        checkExpr(c, stmt.condition);
      }
      break;

    case 'IfStmt':
      checkExpr(c, stmt.condition);
      for (const s of stmt.thenBody) {
        checkStmt(c, s);
      }
      if (stmt.elseBody) {
        for (const s of stmt.elseBody) {
          checkStmt(c, s);
        }
      }
      break;

    case 'WhileStmt':
      checkExpr(c, stmt.condition);
      for (const s of stmt.body) {
        checkStmt(c, s);
      }
      break;

    case 'ForStmt': {
      // The iterable determines the type of the loop variable
      const iterType = checkExpr(c, stmt.iterable);

      // Create a new scope for the loop body
      const outerScope = c.currentScope;
      c.currentScope = createScope(outerScope);

      let varType = stmt.variableType;
      if (!varType) {
        if (iterType) {
          if (iterType.kind === 'PrimitiveType' && isIntegerType(iterType)) {
            // Iterating over a number: variable is same type
            varType = iterType;
          } else if (iterType.kind === 'SliceType') {
            // Iterating over slice: variable is element type
            varType = iterType.element;
          }
        }
        varType = varType || { kind: 'PrimitiveType', name: 'i32', span: stmt.span };
      }

      defineSymbol(c, stmt.variable, 'local', stmt.span, varType, false);

      for (const s of stmt.body) {
        checkStmt(c, s);
      }

      c.currentScope = outerScope;
      break;
    }

    case 'LoopStmt':
      for (const s of stmt.body) {
        checkStmt(c, s);
      }
      break;

    case 'BranchStmt':
      if (stmt.condition) {
        checkExpr(c, stmt.condition);
      }
      break;

    case 'BreakStmt':
      // No semantic checking needed
      break;

    case 'ErrorStmt':
      // Already an error
      break;
  }
}

// -----------------------------------------------------------------------------
// Function Checking
// -----------------------------------------------------------------------------

function checkFunction(c: Checker, func: FuncDecl): void {
  // Create function scope
  const outerScope = c.currentScope;
  const funcScope = createScope(c.globalScope);
  c.currentScope = funcScope;
  c.currentFunction = func;
  c.functionScopes.set(func, funcScope);

  // Register parameters
  for (const param of func.params) {
    defineSymbol(c, param.name, 'param', param.span, param.type, false);
  }

  // Register named returns as locals
  if (func.returnType && 'params' in func.returnType) {
    for (const ret of func.returnType.params) {
      defineSymbol(c, ret.name, 'local', ret.span, ret.type, true);
    }
  }

  // Check body
  if (func.body) {
    if (func.body.kind === 'ArrowBody') {
      for (const expr of func.body.exprs) {
        checkExpr(c, expr);
      }
    } else {
      for (const stmt of func.body.stmts) {
        checkStmt(c, stmt);
      }
    }
  }

  c.currentScope = outerScope;
  c.currentFunction = undefined;
}

// -----------------------------------------------------------------------------
// Module Checking
// -----------------------------------------------------------------------------

function checkModule(c: Checker, module: Module): void {
  // First pass: register all imports and globals
  for (const imp of module.imports) {
    checkImport(c, imp);
  }

  for (const global of module.globals) {
    const initType = checkExpr(c, global.init);
    const type = global.type || initType;
    defineSymbol(c, global.name, 'global', global.span, type, global.mutable);
  }

  // Register all exported functions
  for (const exp of module.exports) {
    if (exp.decl.kind === 'FuncDecl') {
      const func = exp.decl;
      const name = func.name || exp.exportName;

      // Build function type
      const paramTypes = func.params.map(p => p.type);
      let returnType: Type = { kind: 'TupleType', elements: [], span: func.span };

      if (func.returnType) {
        if ('params' in func.returnType) {
          // Named returns
          returnType = {
            kind: 'TupleType',
            elements: func.returnType.params.map(p => p.type),
            span: func.returnType.span,
          };
        } else {
          returnType = func.returnType;
        }
      }

      const funcType: FunctionType = {
        kind: 'FunctionType',
        params: paramTypes,
        returns: returnType,
        span: func.span,
      };

      defineSymbol(c, name, 'function', func.span, funcType);
    }
  }

  // Register non-exported functions
  for (const func of module.functions) {
    if (func.name) {
      const paramTypes = func.params.map(p => p.type);
      let returnType: Type = { kind: 'TupleType', elements: [], span: func.span };

      if (func.returnType) {
        if ('params' in func.returnType) {
          returnType = {
            kind: 'TupleType',
            elements: func.returnType.params.map(p => p.type),
            span: func.returnType.span,
          };
        } else {
          returnType = func.returnType;
        }
      }

      const funcType: FunctionType = {
        kind: 'FunctionType',
        params: paramTypes,
        returns: returnType,
        span: func.span,
      };

      defineSymbol(c, func.name, 'function', func.span, funcType);
    }
  }

  // Second pass: check function bodies
  for (const exp of module.exports) {
    if (exp.decl.kind === 'FuncDecl') {
      checkFunction(c, exp.decl);
    }
  }

  for (const func of module.functions) {
    checkFunction(c, func);
  }
}

// -----------------------------------------------------------------------------
// Main Check Function
// -----------------------------------------------------------------------------

// Register WebAssembly builtin functions (intrinsics)
function registerBuiltins(c: Checker): void {
  // Math builtins that map directly to WASM opcodes
  const mathBuiltins = [
    // f64 math builtins
    { name: 'sqrt', params: ['f64'], returns: 'f64' },
    { name: 'abs', params: ['f64'], returns: 'f64' },
    { name: 'ceil', params: ['f64'], returns: 'f64' },
    { name: 'floor', params: ['f64'], returns: 'f64' },
    { name: 'trunc', params: ['f64'], returns: 'f64' },
    { name: 'nearest', params: ['f64'], returns: 'f64' },
    { name: 'min', params: ['f64', 'f64'], returns: 'f64' },
    { name: 'max', params: ['f64', 'f64'], returns: 'f64' },
    { name: 'copysign', params: ['f64', 'f64'], returns: 'f64' },
  ];

  const defaultSpan: Span = { start: 0, end: 0 };

  for (const builtin of mathBuiltins) {
    const funcType: FunctionType = {
      kind: 'FunctionType',
      params: builtin.params.map(p => ({ kind: 'PrimitiveType' as const, name: p, span: defaultSpan })),
      returns: { kind: 'PrimitiveType', name: builtin.returns, span: defaultSpan },
      span: defaultSpan,
    };

    c.globalScope.symbols.set(builtin.name, {
      name: builtin.name,
      kind: 'builtin',
      type: funcType,
      span: defaultSpan,
    });
  }
}

export function check(parseResult: ParseResult): CheckResult {
  const globalScope = createScope();

  const c: Checker = {
    errors: [...parseResult.errors], // Include parse errors
    globalScope,
    currentScope: globalScope,
    functionScopes: new Map(),
  };

  // Register WebAssembly builtin functions
  registerBuiltins(c);

  checkModule(c, parseResult.ast);

  return {
    errors: c.errors,
    symbols: {
      global: globalScope,
      scopes: c.functionScopes,
    },
  };
}
