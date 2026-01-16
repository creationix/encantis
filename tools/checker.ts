// =============================================================================
// Encantis Type Checker
// Semantic analysis: symbol resolution, type inference, and error reporting
// =============================================================================

import type {
  Span, Diagnostic,
  Type, PrimitiveType, SliceType, PointerType, TupleType, FunctionType, StructType, StructField,
  Expr, Stmt, PlaceExpr,
  FuncDecl, FuncSignature, FuncParam, NamedReturns, Body, ArrowBody, BlockBody,
  ImportDecl, ImportItem, ImportItemKind,
  ExportDecl, GlobalDecl, DefDecl, TypeDecl, MemoryDecl,
  Module, Decl,
} from './parser2';

import type {
  ParseResult, CheckResult,
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
    case 'NullTerminatedType':
      return `[${typeToString(type.element)}/0]`;
    case 'PointerType':
      return `*${typeToString(type.target)}`;
    case 'TupleType':
      if (type.elements.length === 0) return '()';
      return `(${type.elements.map(typeToString).join(', ')})`;
    case 'FunctionType':
      return `(${type.params.map(typeToString).join(', ')}) -> ${typeToString(type.returns)}`;
    case 'StructType':
      return `{ ${type.fields.map(f => `${f.name}: ${typeToString(f.type)}`).join(', ')} }`;
    case 'NamedType':
      return type.name;
    default:
      return '?';
  }
}

function isUnsignedType(type: Type | undefined): boolean {
  if (!type || type.kind !== 'PrimitiveType') return false;
  return type.name.startsWith('u');
}

/**
 * Check if an expression is a numeric literal with a specific value or range.
 * Returns the numeric value if it's a literal, undefined otherwise.
 */
function getLiteralValue(expr: Expr): number | undefined {
  if (expr.kind === 'NumberLiteral') {
    // Handle negative literals wrapped in unary minus
    const val = parseFloat(expr.value);
    return Number.isNaN(val) ? undefined : val;
  }
  if (expr.kind === 'UnaryExpr' && expr.op === '-' && expr.operand.kind === 'NumberLiteral') {
    const val = parseFloat(expr.operand.value);
    return Number.isNaN(val) ? undefined : -val;
  }
  return undefined;
}

/**
 * Check for tautological comparisons between unsigned types and negative/zero values.
 * Returns a warning message if the comparison is always true or always false.
 */
function checkTautologicalComparison(
  op: string,
  leftType: Type | undefined,
  rightType: Type | undefined,
  leftExpr: Expr,
  rightExpr: Expr,
): { message: string; alwaysTrue: boolean } | undefined {
  const leftVal = getLiteralValue(leftExpr);
  const rightVal = getLiteralValue(rightExpr);
  const leftUnsigned = isUnsignedType(leftType);
  const rightUnsigned = isUnsignedType(rightType);

  // unsigned < 0  → always false
  // unsigned <= -1 → always false
  // unsigned >= 0  → always true
  // unsigned > -1  → always true
  if (leftUnsigned && rightVal !== undefined) {
    if (op === '<' && rightVal <= 0) {
      return { message: `Comparison is always false: unsigned value is never less than ${rightVal}`, alwaysTrue: false };
    }
    if (op === '<=' && rightVal < 0) {
      return { message: `Comparison is always false: unsigned value is never less than or equal to ${rightVal}`, alwaysTrue: false };
    }
    if (op === '>=' && rightVal <= 0) {
      return { message: `Comparison is always true: unsigned value is always greater than or equal to ${rightVal}`, alwaysTrue: true };
    }
    if (op === '>' && rightVal < 0) {
      return { message: `Comparison is always true: unsigned value is always greater than ${rightVal}`, alwaysTrue: true };
    }
  }

  // 0 > unsigned  → always false
  // -1 >= unsigned → always false
  // 0 <= unsigned → always true
  // -1 < unsigned → always true
  if (rightUnsigned && leftVal !== undefined) {
    if (op === '>' && leftVal <= 0) {
      return { message: `Comparison is always false: ${leftVal} is never greater than an unsigned value`, alwaysTrue: false };
    }
    if (op === '>=' && leftVal < 0) {
      return { message: `Comparison is always false: ${leftVal} is never greater than or equal to an unsigned value`, alwaysTrue: false };
    }
    if (op === '<=' && leftVal <= 0) {
      return { message: `Comparison is always true: ${leftVal} is always less than or equal to an unsigned value`, alwaysTrue: true };
    }
    if (op === '<' && leftVal < 0) {
      return { message: `Comparison is always true: ${leftVal} is always less than an unsigned value`, alwaysTrue: true };
    }
  }

  return undefined;
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

// Resolve a named type to its underlying type definition
function resolveNamedType(c: Checker, name: string): Type | undefined {
  const sym = c.globalScope.symbols.get(name);
  if (sym?.kind === 'type' && sym.type) {
    return sym.type;
  }
  return undefined;
}

// Resolve a type, following named type aliases
function resolveType(c: Checker, type: Type): Type {
  if (type.kind === 'NamedType') {
    const resolved = resolveNamedType(c, type.name);
    if (resolved) {
      return resolveType(c, resolved);  // Recursively resolve nested aliases
    }
  }
  return type;
}

// -----------------------------------------------------------------------------
// Import Checking
// -----------------------------------------------------------------------------

function checkImport(c: Checker, imp: ImportDecl): void {
  for (const item of imp.items) {
    if (item.item.kind === 'func') {
      const sig = item.item.signature;
      // Get the local function name - use item.name if available, otherwise external name
      const localName = item.item.name || item.externalName;

      // Build function type from signature
      const paramTypes = sig.params.map(p => p.type).filter(t => t !== undefined);
      const returnType = getReturnType(sig.returns, item.span);

      const funcType: FunctionType = {
        kind: 'FunctionType',
        params: paramTypes,
        returns: returnType,
        span: item.span,
      };

      defineSymbol(c, localName, 'import', item.span, funcType);
    } else if (item.item.kind === 'global') {
      defineSymbol(c, item.item.name, 'import', item.span, item.item.type);
    }
    // Memory imports don't need symbol registration
  }
}

function getReturnType(returns: Type | NamedReturns | undefined, fallbackSpan: Span): Type {
  if (!returns) {
    return { kind: 'TupleType', elements: [], span: fallbackSpan };
  }
  if ('kind' in returns && returns.kind === 'NamedReturns') {
    if (returns.fields.length === 1) {
      return returns.fields[0].type;
    }
    return {
      kind: 'TupleType',
      elements: returns.fields.map(f => f.type),
      span: fallbackSpan,
    };
  }
  return returns as Type;
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
        // Check for tautological comparisons with unsigned types
        const tautology = checkTautologicalComparison(expr.op, leftType, rightType, expr.left, expr.right);
        if (tautology) {
          addWarning(c, expr.span, tautology.message);
        }
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

        if (argType && !typesCompatible(argType, paramType, c)) {
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
        if (idxType && !isIntegerType(idxType)) {
          addError(c, expr.index.span, `Array index must be an integer, but got '${typeToString(idxType)}'.`);
        }
        return objType.element;
      }

      if (objType.kind === 'PointerType') {
        // Pointer indexing: ptr[i] is equivalent to (ptr + i * sizeof(T)).*
        if (idxType && !isIntegerType(idxType)) {
          addError(c, expr.index.span, `Pointer index must be an integer, but got '${typeToString(idxType)}'.`);
        }
        return objType.target;
      }

      addError(c, expr.object.span, `Cannot index into type '${typeToString(objType)}'. Expected a slice, array, or pointer.`);
      return undefined;
    }

    case 'MemberExpr': {
      const objType = checkExpr(c, expr.object);
      if (!objType) return undefined;

      // Resolve named types to their underlying type
      const resolved = resolveType(c, objType);

      // Handle slice properties (slices act like { ptr: *T, len: u32 })
      if (resolved.kind === 'SliceType') {
        if (expr.member === 'ptr' || expr.member === '0') {
          return { kind: 'PointerType', target: resolved.element, span: expr.span };
        }
        if (expr.member === 'len' || expr.member === '1') {
          return { kind: 'PrimitiveType', name: 'u32', span: expr.span };
        }
      }

      // Handle pointer dereference: ptr.*
      if (resolved.kind === 'PointerType' && expr.member === '*') {
        return resolved.target;
      }

      // Handle tuple access: tuple.1, tuple.2
      if (resolved.kind === 'TupleType') {
        const idx = parseInt(expr.member, 10);
        if (!isNaN(idx) && idx >= 1 && idx <= resolved.elements.length) {
          return resolved.elements[idx - 1];
        }
        addError(c, expr.span, `Tuple index '${expr.member}' is out of bounds. Tuple has ${resolved.elements.length} element(s).`);
        return undefined;
      }

      // Handle struct field access
      if (resolved.kind === 'StructType') {
        const field = resolved.fields.find(f => f.name === expr.member);
        if (field) {
          return field.type;
        }
        addError(c, expr.span, `Struct has no field '${expr.member}'. Available fields: ${resolved.fields.map(f => f.name).join(', ')}.`);
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

      if (thenType && elseType && !typesCompatible(thenType, elseType, c)) {
        addError(c, expr.span,
          `Ternary branches have different types: '${typeToString(thenType)}' vs '${typeToString(elseType)}'.`);
      }

      return thenType || elseType;
    }

    case 'StructLiteral': {
      // Infer struct type from fields
      const fields: StructField[] = [];
      for (const field of expr.fields) {
        let fieldType: Type | undefined;
        if (field.value) {
          // Explicit value: {x: expr}
          fieldType = checkExpr(c, field.value);
        } else {
          // Shorthand: {x} means {x: x}
          const sym = lookupSymbol(c, field.name);
          if (!sym) {
            addError(c, field.span, `Undefined variable '${field.name}' in struct literal shorthand.`);
          } else {
            fieldType = sym.type;
          }
        }
        if (fieldType) {
          fields.push({ name: field.name, type: fieldType, span: field.span });
        }
      }
      return { kind: 'StructType', fields, span: expr.span };
    }

    case 'ErrorExpr':
      return undefined;
  }
}

function typesCompatible(a: Type, b: Type, checker?: Checker): boolean {
  // For now, use exact equality with some numeric coercion
  if (typesEqual(a, b)) return true;

  // Resolve named types if checker is available
  if (checker) {
    const resolvedA = resolveType(checker, a);
    const resolvedB = resolveType(checker, b);

    // Check structural compatibility after resolving
    if (typesEqual(resolvedA, resolvedB)) return true;

    // Struct compatibility: anonymous struct matches named struct with same fields
    if (resolvedA.kind === 'StructType' && resolvedB.kind === 'StructType') {
      if (resolvedA.fields.length !== resolvedB.fields.length) return false;
      return resolvedA.fields.every((f, i) => {
        const otherField = resolvedB.fields[i];
        return f.name === otherField.name && typesCompatible(f.type, otherField.type, checker);
      });
    }
  }

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
        } else if (type && initType && !typesCompatible(initType, type, c)) {
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

    case 'LetStmt': {
      const valueType = stmt.init ? checkExpr(c, stmt.init) : undefined;
      const resolvedValueType = valueType ? resolveType(c, valueType) : undefined;
      const declaredType = stmt.type;

      switch (stmt.pattern.kind) {
        case 'IdentPattern': {
          // Simple: let x = expr or let x:T = expr
          const type = declaredType || valueType || { kind: 'PrimitiveType' as const, name: 'unknown', span: stmt.span };
          defineSymbol(c, stmt.pattern.name, 'local', stmt.span, type, true);
          break;
        }

        case 'StructPattern': {
          // let {x, y} = expr - struct destructuring
          if (resolvedValueType?.kind === 'StructType') {
            for (const field of stmt.pattern.fields) {
              const structField = resolvedValueType.fields.find(f => f.name === field.fieldName);
              const varName = field.binding ?? field.fieldName;
              if (structField) {
                defineSymbol(c, varName, 'local', field.span, structField.type, true);
              } else {
                addError(c, field.span, `Struct has no field '${field.fieldName}'.`);
                defineSymbol(c, varName, 'local', field.span, { kind: 'PrimitiveType', name: 'unknown', span: field.span }, true);
              }
            }
          } else if (resolvedValueType?.kind === 'SliceType') {
            // Slices act like { ptr: *T, len: u32 }
            for (const field of stmt.pattern.fields) {
              const varName = field.binding ?? field.fieldName;
              if (field.fieldName === 'ptr') {
                defineSymbol(c, varName, 'local', field.span, { kind: 'PointerType', target: resolvedValueType.element, span: field.span }, true);
              } else if (field.fieldName === 'len') {
                defineSymbol(c, varName, 'local', field.span, { kind: 'PrimitiveType', name: 'u32', span: field.span }, true);
              } else {
                addError(c, field.span, `Slice has no field '${field.fieldName}'. Available fields: ptr, len.`);
                defineSymbol(c, varName, 'local', field.span, { kind: 'PrimitiveType', name: 'unknown', span: field.span }, true);
              }
            }
          } else {
            const initSpan = stmt.init?.span || stmt.span;
            addError(c, initSpan,
              `Expected a struct or slice value for destructuring, got '${valueType ? typeToString(valueType) : 'unknown'}'.`);
            for (const field of stmt.pattern.fields) {
              const varName = field.binding ?? field.fieldName;
              defineSymbol(c, varName, 'local', field.span, { kind: 'PrimitiveType', name: 'unknown', span: field.span }, true);
            }
          }
          break;
        }

        case 'TuplePattern': {
          // let (a, b) = expr - tuple destructuring
          const names = stmt.pattern.elements;
          if (resolvedValueType?.kind === 'TupleType') {
            if (resolvedValueType.elements.length !== names.length) {
              const initSpan = stmt.init?.span || stmt.span;
              addError(c, initSpan,
                `Cannot unpack ${resolvedValueType.elements.length} values into ${names.length} variables.`);
            }
            for (let i = 0; i < names.length; i++) {
              const elem = names[i];
              if (elem.pattern.kind === 'IdentPattern') {
                const type = resolvedValueType.elements[i] || { kind: 'PrimitiveType' as const, name: 'unknown', span: elem.span };
                defineSymbol(c, elem.pattern.name, 'local', elem.span, type, true);
              }
            }
          } else if (resolvedValueType?.kind === 'SliceType') {
            // Slices act like (ptr, len) tuple
            if (names.length !== 2) {
              const initSpan = stmt.init?.span || stmt.span;
              addError(c, initSpan,
                `Cannot unpack slice (2 values) into ${names.length} variables.`);
            }
            const sliceTypes: Type[] = [
              { kind: 'PointerType', target: resolvedValueType.element, span: stmt.span },
              { kind: 'PrimitiveType', name: 'u32', span: stmt.span },
            ];
            for (let i = 0; i < names.length && i < 2; i++) {
              const elem = names[i];
              if (elem.pattern.kind === 'IdentPattern') {
                defineSymbol(c, elem.pattern.name, 'local', elem.span, sliceTypes[i], true);
              }
            }
          } else {
            const initSpan = stmt.init?.span || stmt.span;
            addError(c, initSpan,
              `Expected a tuple or slice value for destructuring, got '${valueType ? typeToString(valueType) : 'unknown'}'.`);
            for (const elem of names) {
              if (elem.pattern.kind === 'IdentPattern') {
                defineSymbol(c, elem.pattern.name, 'local', elem.span, { kind: 'PrimitiveType', name: 'unknown', span: elem.span }, true);
              }
            }
          }
          break;
        }

        case 'ErrorPattern':
          // Skip error patterns
          break;
      }
      break;
    }

    case 'SetStmt': {
      const valueType = checkExpr(c, stmt.value);
      const resolvedValueType = valueType ? resolveType(c, valueType) : undefined;

      // Helper to check assignment to a variable
      const checkVarAssignment = (varName: string, fieldType: Type, span: Span) => {
        const sym = lookupSymbol(c, varName);
        if (!sym) {
          addError(c, span, `Undefined variable '${varName}'. Did you forget to declare it?`);
          return;
        }
        if (sym.kind !== 'local' && sym.kind !== 'param' && sym.mutable !== true) {
          addError(c, span, `Cannot assign to '${varName}' because it's not mutable.`);
        }
        if (sym.type && !typesCompatible(fieldType, sym.type, c)) {
          addError(c, span,
            `Cannot assign '${typeToString(fieldType)}' to '${varName}' of type '${typeToString(sym.type)}'.`);
        }
      };

      switch (stmt.pattern.kind) {
        case 'IdentPattern': {
          // Simple: set x = expr
          checkVarAssignment(stmt.pattern.name, valueType || { kind: 'PrimitiveType', name: 'unknown', span: stmt.span }, stmt.span);
          break;
        }

        case 'StructPattern': {
          // set {x, y} = expr - struct destructuring assignment
          if (resolvedValueType?.kind === 'StructType') {
            for (const field of stmt.pattern.fields) {
              const structField = resolvedValueType.fields.find(f => f.name === field.fieldName);
              const varName = field.binding ?? field.fieldName;
              if (!structField) {
                addError(c, field.span, `Struct has no field '${field.fieldName}'.`);
                continue;
              }
              checkVarAssignment(varName, structField.type, field.span);
            }
          } else if (resolvedValueType?.kind === 'SliceType') {
            for (const field of stmt.pattern.fields) {
              const varName = field.binding ?? field.fieldName;
              if (field.fieldName === 'ptr') {
                checkVarAssignment(varName, { kind: 'PointerType', target: resolvedValueType.element, span: field.span }, field.span);
              } else if (field.fieldName === 'len') {
                checkVarAssignment(varName, { kind: 'PrimitiveType', name: 'u32', span: field.span }, field.span);
              } else {
                addError(c, field.span, `Slice has no field '${field.fieldName}'. Available fields: ptr, len.`);
              }
            }
          } else {
            addError(c, stmt.value.span,
              `Expected a struct or slice value for destructuring, got '${valueType ? typeToString(valueType) : 'unknown'}'.`);
          }
          break;
        }

        case 'TuplePattern': {
          // set (a, b) = expr - tuple destructuring assignment
          const elements = stmt.pattern.elements;
          let expectedTypes: (Type | undefined)[] = [];
          let expectedCount = 0;

          if (resolvedValueType?.kind === 'TupleType') {
            expectedTypes = resolvedValueType.elements;
            expectedCount = resolvedValueType.elements.length;
          } else if (resolvedValueType?.kind === 'SliceType') {
            expectedTypes = [
              { kind: 'PointerType', target: resolvedValueType.element, span: stmt.span },
              { kind: 'PrimitiveType', name: 'u32', span: stmt.span },
            ];
            expectedCount = 2;
          } else {
            addError(c, stmt.value.span,
              `Expected a tuple or slice value for destructuring, got '${valueType ? typeToString(valueType) : 'unknown'}'.`);
            break;
          }

          if (expectedCount !== elements.length) {
            addError(c, stmt.value.span,
              `Cannot unpack ${expectedCount} values into ${elements.length} targets.`);
          }

          for (let i = 0; i < elements.length; i++) {
            const elem = elements[i];
            const expectedType = expectedTypes[i];
            if (elem.pattern.kind === 'IdentPattern') {
              checkVarAssignment(elem.pattern.name, expectedType || { kind: 'PrimitiveType', name: 'unknown', span: elem.span }, elem.span);
            }
          }
          break;
        }

        case 'ErrorPattern':
          break;
      }
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

        if (target.kind === 'Identifier') {
          // Simple variable assignment
          const sym = lookupSymbol(c, target.name);

          if (!sym) {
            addError(c, target.span, `Undefined variable '${target.name}'. Did you forget to declare it with 'local'?`);
            continue;
          }

          if (sym.kind !== 'local' && sym.kind !== 'param' && sym.mutable !== true) {
            addError(c, target.span, `Cannot assign to '${target.name}' because it's not mutable.`);
          }

          if (expectedType && sym.type && !typesCompatible(expectedType, sym.type, c)) {
            addError(c, stmt.value.span,
              `Cannot assign '${typeToString(expectedType)}' to '${target.name}' of type '${typeToString(sym.type)}'.`);
          }
        } else if (target.kind === 'IndexExpr') {
          // Array/slice/pointer indexed assignment: arr[i] = value
          const targetType = checkExpr(c, target);
          if (expectedType && targetType && !typesCompatible(expectedType, targetType, c)) {
            addError(c, stmt.value.span,
              `Cannot assign '${typeToString(expectedType)}' to indexed location of type '${typeToString(targetType)}'.`);
          }
        } else if (target.kind === 'MemberExpr') {
          // Member/field assignment: obj.field = value, ptr.u32 = value
          const targetType = checkExpr(c, target);
          if (expectedType && targetType && !typesCompatible(expectedType, targetType, c)) {
            addError(c, stmt.value.span,
              `Cannot assign '${typeToString(expectedType)}' to member of type '${typeToString(targetType)}'.`);
          }
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
  for (const param of func.signature.params) {
    if (param.name) {
      defineSymbol(c, param.name, 'param', param.span, param.type, false);
    }
  }

  // Register named returns as locals
  const returns = func.signature.returns;
  if (returns && 'kind' in returns && returns.kind === 'NamedReturns') {
    for (const ret of returns.fields) {
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
  // Collect functions for second pass
  const functions: Array<{ func: FuncDecl; name: string }> = [];

  // First pass: register all declarations
  for (const decl of module.decls) {
    switch (decl.kind) {
      case 'ImportDecl':
        checkImport(c, decl);
        break;

      case 'GlobalDecl': {
        const initType = decl.init ? checkExpr(c, decl.init) : undefined;
        const type = decl.type || initType;
        defineSymbol(c, decl.name, 'global', decl.span, type, true);
        break;
      }

      case 'DefDecl': {
        const valueType = checkExpr(c, decl.value);
        defineSymbol(c, decl.name, 'constant', decl.span, valueType);
        break;
      }

      case 'TypeDecl':
        defineSymbol(c, decl.name, 'type', decl.span, decl.type);
        break;

      case 'ExportDecl': {
        if (decl.decl.kind === 'FuncDecl') {
          const func = decl.decl;
          const name = func.name || decl.exportName;
          registerFunction(c, func, name);
          functions.push({ func, name });
        } else if (decl.decl.kind === 'GlobalDecl') {
          const global = decl.decl;
          const initType = global.init ? checkExpr(c, global.init) : undefined;
          const type = global.type || initType;
          defineSymbol(c, global.name, 'global', global.span, type, true);
        }
        // MemoryDecl exports don't need symbol registration
        break;
      }

      case 'FuncDecl': {
        if (decl.name) {
          registerFunction(c, decl, decl.name);
          functions.push({ func: decl, name: decl.name });
        }
        break;
      }

      case 'MemoryDecl':
      case 'UniqueDecl':
      case 'ErrorDecl':
        // These don't need symbol registration in this pass
        break;
    }
  }

  // Second pass: check function bodies
  for (const { func } of functions) {
    checkFunction(c, func);
  }
}

function registerFunction(c: Checker, func: FuncDecl, name: string): void {
  const paramTypes = func.signature.params.map(p => p.type);
  const returnType = getReturnType(func.signature.returns, func.span);

  const funcType: FunctionType = {
    kind: 'FunctionType',
    params: paramTypes,
    returns: returnType,
    span: func.span,
  };

  defineSymbol(c, name, 'function', func.span, funcType);
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
