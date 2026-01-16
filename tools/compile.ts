// =============================================================================
// Encantis Compiler
// Main entry point: exports parse(), check(), and compile()
// =============================================================================

import type {
  Expr, FuncDecl, Body, FuncSignature, NamedReturns,
  Module, Stmt, Type, Decl,
  ImportDecl, ExportDecl, GlobalDecl, DefDecl, TypeDecl, MemoryDecl,
} from './parser2';

import type {
  CheckResult, Diagnostic, ParseResult, Token, SymbolTable,
} from './types';

import { check as doCheck } from './checker';
import { formatDiagnostic, getLineAndColumn, tokenize } from './lexer';
import { parse as doParse } from './parser2';

// Re-export types for consumers
export type { Token, Diagnostic, ParseResult, CheckResult, Module };
export { tokenize, formatDiagnostic, getLineAndColumn };

// -----------------------------------------------------------------------------
// Parse API
// -----------------------------------------------------------------------------

/**
 * Parse Encantis source code into an AST.
 * Returns the AST and any syntax errors encountered.
 * The parser is error-tolerant and will return a partial AST even with errors.
 */
export function parse(src: string): ParseResult {
  return doParse(src);
}

// -----------------------------------------------------------------------------
// Check API
// -----------------------------------------------------------------------------

/**
 * Perform semantic analysis on a parsed AST.
 * Checks for undefined variables, type mismatches, etc.
 * Returns the combined errors from parsing and checking.
 */
export function check(parseResult: ParseResult): CheckResult {
  return doCheck(parseResult);
}

/**
 * Parse and check source code in one step.
 * Convenience function that combines parse() and check().
 */
export function analyze(src: string): CheckResult {
  const parseResult = parse(src);
  return check(parseResult);
}

// -----------------------------------------------------------------------------
// Compile API (WAT generation - placeholder for now)
// -----------------------------------------------------------------------------

/**
 * Compile Encantis source code to WebAssembly Text Format (WAT).
 * Currently a placeholder - full codegen will be added later.
 */
export function compile(src: string): string {
  const parseResult = parse(src);
  const checkResult = check(parseResult);

  if (checkResult.errors.some(e => e.severity === 'error')) {
    // Return error summary instead of WAT
    const errorLines = checkResult.errors
      .filter(e => e.severity === 'error')
      .map(e => formatDiagnostic(src, e));
    throw new Error(`Compilation failed with ${errorLines.length} error(s):\n\n${errorLines.join('\n\n')}`);
  }

  return generateWat(parseResult.ast, checkResult.symbols, src);
}

// -----------------------------------------------------------------------------
// WAT Code Generation (Basic Implementation)
// -----------------------------------------------------------------------------

interface CodeGenContext {
  output: string[];
  indent: number;
  strings: Map<string, number>;
  stringOffset: number;
  src: string;
  globals: Set<string>;  // Track global variable names
  symbols: SymbolTable;  // Type information from checker
  currentFunc?: FuncDecl;  // Current function for scope lookup
}

function emit(ctx: CodeGenContext, line: string): void {
  ctx.output.push('  '.repeat(ctx.indent) + line);
}

// -----------------------------------------------------------------------------
// Type Inference Helpers
// -----------------------------------------------------------------------------

/**
 * Infer the type of an expression using the symbol table.
 */
function inferExprType(ctx: CodeGenContext, expr: Expr): Type | undefined {
  switch (expr.kind) {
    case 'Identifier': {
      // Look up in current function scope first, then global
      const funcScope = ctx.currentFunc ? ctx.symbols.scopes.get(ctx.currentFunc) : undefined;
      let sym = funcScope?.symbols.get(expr.name);
      if (!sym) sym = ctx.symbols.global.symbols.get(expr.name);
      return sym?.type;
    }
    case 'NumberLit':
      // Detect float from value format
      if (expr.value.includes('.') || expr.value.includes('e') || expr.value.includes('E')) {
        return { kind: 'PrimitiveType', name: 'f64', span: expr.span };
      }
      return { kind: 'PrimitiveType', name: 'i32', span: expr.span };
    case 'BinaryExpr': {
      // Result type is the promoted type of both operands
      const leftType = inferExprType(ctx, expr.left);
      const rightType = inferExprType(ctx, expr.right);
      const leftWat = getWatPrefix(leftType);
      const rightWat = getWatPrefix(rightType);
      // Use whichever is wider in the type hierarchy
      const resultWat = (typeRank as Record<string, number>)[leftWat] >= (typeRank as Record<string, number>)[rightWat]
        ? leftWat : rightWat;
      return { kind: 'PrimitiveType', name: resultWat, span: expr.span };
    }
    case 'CallExpr': {
      if (expr.callee.kind === 'Identifier') {
        const sym = ctx.symbols.global.symbols.get(expr.callee.name);
        if (sym?.type?.kind === 'FunctionType') {
          return sym.type.returns;
        }
      }
      return undefined;
    }
    case 'TupleLit':
      return {
        kind: 'TupleType',
        elements: expr.elements.map(e => inferExprType(ctx, e.value)).filter((t): t is Type => t !== undefined),
        span: expr.span,
      };
    case 'MemberExpr': {
      // Get the type of the target (e.g., point) and find the field type
      if (expr.target.kind === 'Identifier' && typeof expr.member === 'string') {
        const targetType = inferExprType(ctx, expr.target);
        if (targetType) {
          const resolved = resolveTypeAlias(ctx, targetType);
          if (resolved.kind === 'StructType') {
            const field = resolved.fields.find(f => f.name === expr.member);
            if (field) {
              return field.type;
            }
          }
        }
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Get the WAT type prefix (i32, i64, f32, f64) for a given type.
 */
function getWatPrefix(type: Type | undefined): string {
  if (!type || type.kind !== 'PrimitiveType') return 'i32';
  switch (type.name) {
    case 'f64': return 'f64';
    case 'f32': return 'f32';
    case 'i64': case 'u64': return 'i64';
    default: return 'i32';  // i32, u32, i16, u16, i8, u8
  }
}

/**
 * Check if a type is unsigned (for choosing signed vs unsigned conversions).
 */
function isUnsignedType(type: Type | undefined): boolean {
  if (!type || type.kind !== 'PrimitiveType') return false;
  return type.name.startsWith('u');
}

/**
 * Resolve a named type alias to its underlying type.
 */
function resolveTypeAlias(ctx: CodeGenContext, type: Type): Type {
  if (type.kind === 'NamedType') {
    const sym = ctx.symbols.global.symbols.get(type.name);
    if (sym?.type) {
      // Cast to handle type system differences between types.ts and parser2
      return resolveTypeAlias(ctx, sym.type as unknown as Type);
    }
  }
  return type;
}

/**
 * Compute byte offset for a struct field.
 */
function computeFieldOffset(structType: { kind: 'StructType'; fields: Array<{ name: string; type: Type }> }, fieldIndex: number): number {
  let offset = 0;
  for (let i = 0; i < fieldIndex; i++) {
    offset += getTypeSize(structType.fields[i].type);
  }
  return offset;
}

/**
 * Get the size in bytes for a type.
 */
function getTypeSize(type: Type): number {
  switch (type.kind) {
    case 'PrimitiveType':
      switch (type.name) {
        case 'i8': case 'u8': case 'bool': return 1;
        case 'i16': case 'u16': return 2;
        case 'i32': case 'u32': case 'f32': return 4;
        case 'i64': case 'u64': case 'f64': return 8;
        default: return 4;
      }
    case 'PointerType':
    case 'SliceType':  // ptr is i32 in wasm32
      return 4;
    default:
      return 4;  // default to i32 size
  }
}

/**
 * Get the WAT load instruction for a type.
 */
function getLoadOp(type: Type): string {
  switch (type.kind) {
    case 'PrimitiveType':
      switch (type.name) {
        case 'f64': return 'f64.load';
        case 'f32': return 'f32.load';
        case 'i64': case 'u64': return 'i64.load';
        case 'i32': case 'u32': return 'i32.load';
        case 'i16': return 'i32.load16_s';
        case 'u16': return 'i32.load16_u';
        case 'i8': return 'i32.load8_s';
        case 'u8': case 'bool': return 'i32.load8_u';
        default: return 'i32.load';
      }
    default:
      return 'i32.load';
  }
}

/**
 * Get the WAT store instruction for a type.
 */
function getStoreOp(type: Type): string {
  switch (type.kind) {
    case 'PrimitiveType':
      switch (type.name) {
        case 'f64': return 'f64.store';
        case 'f32': return 'f32.store';
        case 'i64': case 'u64': return 'i64.store';
        case 'i32': case 'u32': return 'i32.store';
        case 'i16': case 'u16': return 'i32.store16';
        case 'i8': case 'u8': case 'bool': return 'i32.store8';
        default: return 'i32.store';
      }
    default:
      return 'i32.store';
  }
}

/**
 * Check if converting an integer type to a float type is lossless.
 * - f32 has 24-bit mantissa: safe for i8, u8, i16, u16
 * - f64 has 53-bit mantissa: safe for i8, u8, i16, u16, i32, u32
 */
function isLosslessIntToFloat(intType: Type | undefined, floatWat: WatType): boolean {
  if (!intType || intType.kind !== 'PrimitiveType') return false;

  const smallInts = ['i8', 'u8', 'i16', 'u16'];
  const mediumInts = ['i32', 'u32'];

  if (floatWat === 'f64') {
    // f64 can safely hold i8, u8, i16, u16, i32, u32
    return smallInts.includes(intType.name) || mediumInts.includes(intType.name);
  } else if (floatWat === 'f32') {
    // f32 can only safely hold i8, u8, i16, u16
    return smallInts.includes(intType.name);
  }
  return false;
}

/**
 * Check if a comptime (untyped) integer literal can be losslessly converted to float.
 * Since we know the exact value, we can check if it fits in the mantissa.
 * - f32: 24-bit mantissa → exact integers in [-2^24, 2^24]
 * - f64: 53-bit mantissa → exact integers in [-2^53, 2^53]
 */
function isComptimeLiteralSafeForFloat(expr: Expr, floatWat: WatType): boolean {
  if (expr.kind !== 'NumberLit') return false;
  // If it's already a float literal, no int→float conversion needed
  if (expr.value.includes('.') || expr.value.includes('e') || expr.value.includes('E')) return false;

  const value = parseInt(expr.value, 10);
  if (Number.isNaN(value)) return false;

  // Check if the integer value fits exactly in the float's mantissa
  if (floatWat === 'f32') {
    // f32 has 24-bit mantissa: [-16777216, 16777216]
    const MAX_SAFE_F32 = 2 ** 24;
    return value >= -MAX_SAFE_F32 && value <= MAX_SAFE_F32;
  } else if (floatWat === 'f64') {
    // f64 has 53-bit mantissa: [-9007199254740992, 9007199254740992]
    const MAX_SAFE_F64 = 2 ** 53;
    return value >= -MAX_SAFE_F64 && value <= MAX_SAFE_F64;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Binary Operation Type Promotion
// -----------------------------------------------------------------------------

type WatType = 'i32' | 'i64' | 'f32' | 'f64';

interface BinaryOpResult {
  resultType: WatType;
  convertLeft?: string;   // WASM instruction to convert left operand
  convertRight?: string;  // WASM instruction to convert right operand
  op: string;             // The WASM operation to use
}

/**
 * Type promotion hierarchy: i32 < i64 < f32 < f64
 * Implicit promotion always goes to the wider type.
 */
const typeRank: Record<WatType, number> = {
  'i32': 0,
  'i64': 1,
  'f32': 2,
  'f64': 3,
};

/**
 * Conversion instructions from one type to another.
 * Key format: "fromType_toType_signed" where signed is 's' or 'u'
 */
function getConversion(from: WatType, to: WatType, unsigned: boolean): string | undefined {
  const suffix = unsigned ? 'u' : 's';
  const conversionMap: Record<string, string> = {
    // i32 → wider types
    'i32_i64': `i64.extend_i32_${suffix}`,
    'i32_f32': `f32.convert_i32_${suffix}`,
    'i32_f64': `f64.convert_i32_${suffix}`,
    // i64 → float types
    'i64_f32': `f32.convert_i64_${suffix}`,
    'i64_f64': `f64.convert_i64_${suffix}`,
    // f32 → f64
    'f32_f64': 'f64.promote_f32',
  };
  return conversionMap[`${from}_${to}`];
}

/**
 * Resolve binary operation with type promotion.
 * Returns the operation info including any needed conversions, or undefined if types are incompatible.
 * Optionally accepts expressions to check comptime literals for more precise conversion checks.
 */
function resolveBinaryOp(
  op: string,
  leftType: Type | undefined,
  rightType: Type | undefined,
  leftExpr?: Expr,
  rightExpr?: Expr,
): BinaryOpResult | undefined {
  const leftWat = getWatPrefix(leftType) as WatType;
  const rightWat = getWatPrefix(rightType) as WatType;
  const leftUnsigned = isUnsignedType(leftType);
  const rightUnsigned = isUnsignedType(rightType);

  // Determine result type (promote to wider)
  let resultType: WatType;
  let convertLeft: string | undefined;
  let convertRight: string | undefined;

  const leftIsInt = leftWat === 'i32' || leftWat === 'i64';
  const rightIsInt = rightWat === 'i32' || rightWat === 'i64';
  const leftIsFloat = leftWat === 'f32' || leftWat === 'f64';
  const rightIsFloat = rightWat === 'f32' || rightWat === 'f64';

  if (leftWat === rightWat) {
    // Same type, no conversion needed
    resultType = leftWat;
  } else if (typeRank[leftWat] > typeRank[rightWat]) {
    // Left is wider, promote right
    resultType = leftWat;
    // Check for lossy int→float conversion (allow comptime literals if value fits)
    if (rightIsInt && leftIsFloat) {
      const isComptimeSafe = rightExpr && isComptimeLiteralSafeForFloat(rightExpr, leftWat);
      if (!isComptimeSafe && !isLosslessIntToFloat(rightType, leftWat)) {
        return undefined; // Precision loss: require explicit cast
      }
    }
    convertRight = getConversion(rightWat, leftWat, rightUnsigned);
    if (!convertRight) return undefined; // Incompatible types
  } else {
    // Right is wider, promote left
    resultType = rightWat;
    // Check for lossy int→float conversion (allow comptime literals if value fits)
    if (leftIsInt && rightIsFloat) {
      const isComptimeSafe = leftExpr && isComptimeLiteralSafeForFloat(leftExpr, rightWat);
      if (!isComptimeSafe && !isLosslessIntToFloat(leftType, rightWat)) {
        return undefined; // Precision loss: require explicit cast
      }
    }
    convertLeft = getConversion(leftWat, rightWat, leftUnsigned);
    if (!convertLeft) return undefined; // Incompatible types
  }

  const isFloat = resultType === 'f64' || resultType === 'f32';

  // Build the operation string
  const opMap: Record<string, string> = {
    '+': `${resultType}.add`,
    '-': `${resultType}.sub`,
    '*': `${resultType}.mul`,
    '/': isFloat ? `${resultType}.div` : `${resultType}.div_s`,
    '%': `${resultType}.rem_s`,  // integers only
    '&': `${resultType}.and`,    // integers only
    '|': `${resultType}.or`,     // integers only
    '^': `${resultType}.xor`,    // integers only
    '<<': `${resultType}.shl`,   // integers only
    '>>': `${resultType}.shr_s`, // integers only
    '<<<': `${resultType}.rotl`, // integers only
    '>>>': `${resultType}.rotr`, // integers only
    '<': isFloat ? `${resultType}.lt` : `${resultType}.lt_s`,
    '>': isFloat ? `${resultType}.gt` : `${resultType}.gt_s`,
    '<=': isFloat ? `${resultType}.le` : `${resultType}.le_s`,
    '>=': isFloat ? `${resultType}.ge` : `${resultType}.ge_s`,
    '==': `${resultType}.eq`,
    '!=': `${resultType}.ne`,
  };

  const watOp = opMap[op];
  if (!watOp) return undefined;

  // Validate: bitwise/rem ops don't work on floats
  if (isFloat && ['%', '&', '|', '^', '<<', '>>', '<<<', '>>>'].includes(op)) {
    return undefined; // Type error: bitwise ops on floats
  }

  return { resultType, convertLeft, convertRight, op: watOp };
}

function generateGlobalInit(expr: Expr): string {
  // For global initialization, we need a constant expression
  if (expr.kind === 'NumberLit') {
    return expr.value;
  }
  // TODO: handle other constant expressions
  return '0';
}

function generateWat(module: Module, symbols: SymbolTable, src: string): string {
  const ctx: CodeGenContext = {
    output: [],
    indent: 0,
    strings: new Map(),
    stringOffset: 0,
    src,
    globals: new Set(),
    symbols,
  };

  // Collect global/constant names and functions first
  const functions: Array<{ func: FuncDecl; exportName?: string }> = [];
  let hasMemory = false;

  for (const decl of module.decls) {
    if (decl.kind === 'GlobalDecl') {
      ctx.globals.add(decl.name);
    } else if (decl.kind === 'DefDecl') {
      ctx.globals.add(decl.name);
    } else if (decl.kind === 'ExportDecl') {
      if (decl.decl.kind === 'GlobalDecl') {
        ctx.globals.add(decl.decl.name);
      } else if (decl.decl.kind === 'FuncDecl') {
        functions.push({ func: decl.decl, exportName: decl.exportName });
      } else if (decl.decl.kind === 'MemoryDecl') {
        hasMemory = true;
      }
    } else if (decl.kind === 'FuncDecl' && decl.name) {
      functions.push({ func: decl });
    } else if (decl.kind === 'MemoryDecl') {
      hasMemory = true;
    }
  }

  emit(ctx, '(module');
  ctx.indent++;

  // Generate imports
  for (const decl of module.decls) {
    if (decl.kind === 'ImportDecl') {
      for (const item of decl.items) {
        if (item.item.kind === 'func') {
          const localName = item.item.name || item.externalName;
          const sig = item.item.signature;
          const params = sig.params.map(p => `(param ${typeToWat(p.type)})`).join(' ');
          const result = sig.returns ? `(result ${typeToWat(getReturnTypeForWat(sig.returns))})` : '';
          emit(ctx, `(func $${localName} (import "${decl.module}" "${item.externalName}") ${params} ${result})`);
        }
      }
    }
  }

  // Generate globals
  for (const decl of module.decls) {
    if (decl.kind === 'GlobalDecl') {
      const watType = decl.type ? typeToWat(decl.type) : 'i32';
      const initValue = decl.init ? generateGlobalInit(decl.init) : '0';
      emit(ctx, `(global $${decl.name} (mut ${watType}) (${watType}.const ${initValue}))`);
    } else if (decl.kind === 'ExportDecl' && decl.decl.kind === 'GlobalDecl') {
      const global = decl.decl;
      const watType = global.type ? typeToWat(global.type) : 'i32';
      const initValue = global.init ? generateGlobalInit(global.init) : '0';
      emit(ctx, `(global $${global.name} (mut ${watType}) (${watType}.const ${initValue}))`);
    }
  }

  // Generate memory exports
  for (const decl of module.decls) {
    if (decl.kind === 'ExportDecl' && decl.decl.kind === 'MemoryDecl') {
      emit(ctx, `(memory (export "${decl.exportName}") ${decl.decl.minPages})`);
    }
  }

  // Generate functions
  for (const { func, exportName } of functions) {
    generateFunction(ctx, func, exportName);
  }

  // Generate memory if not already exported
  if (!hasMemory && ctx.strings.size > 0) {
    emit(ctx, '(memory 1)');
  }

  // Generate data section for strings (null-terminated)
  if (ctx.strings.size > 0) {
    const sortedStrings = Array.from(ctx.strings.entries()).sort((a, b) => a[1] - b[1]);
    const allStrings = sortedStrings.map(([str]) => escapeWatString(str) + '\\00').join('');
    emit(ctx, `(data (i32.const 0) "${allStrings}")`);
  }

  ctx.indent--;
  emit(ctx, ')');

  return ctx.output.join('\n');
}

function generateFunction(ctx: CodeGenContext, func: FuncDecl, exportName?: string): void {
  ctx.currentFunc = func;  // Set for type lookups in this function's scope

  const name = func.name || exportName || 'anonymous';
  const exportClause = exportName ? `(export "${exportName}")` : '';

  // Build params - flatten struct types into multiple params
  const flatParams: string[] = [];
  for (const p of func.signature.params) {
    if (!p.name) continue;
    const resolvedType = resolveTypeAlias(ctx, p.type);
    if (resolvedType.kind === 'StructType') {
      // Flatten: point:CartesianPoint -> point_x:f64, point_y:f64
      for (const field of resolvedType.fields) {
        flatParams.push(`(param $${p.name}_${field.name} ${typeToWat(field.type)})`);
      }
    } else {
      flatParams.push(`(param $${p.name} ${typeToWat(p.type)})`);
    }
  }
  const params = flatParams.join(' ');

  // Build results - flatten struct returns into multiple results
  const flatResults: string[] = [];
  const returns = func.signature.returns;
  if (returns) {
    if ('kind' in returns && returns.kind === 'NamedReturns') {
      // Named returns like (out:PolarPoint)
      for (const ret of returns.fields) {
        const resolvedType = resolveTypeAlias(ctx, ret.type);
        if (resolvedType.kind === 'StructType') {
          for (const field of resolvedType.fields) {
            flatResults.push(typeToWat(field.type));
          }
        } else {
          flatResults.push(typeToWat(ret.type));
        }
      }
    } else {
      const resolvedType = resolveTypeAlias(ctx, returns as Type);
      if (resolvedType.kind === 'StructType') {
        for (const field of resolvedType.fields) {
          flatResults.push(typeToWat(field.type));
        }
      } else {
        flatResults.push(typeToWat(returns as Type));
      }
    }
  }
  const results = flatResults.length > 0 ? `(result ${flatResults.join(' ')})` : '';

  emit(ctx, `(func $${name} ${exportClause} ${params} ${results}`.trim());
  ctx.indent++;

  // Collect locals from body
  if (func.body?.kind === 'BlockBody') {
    for (const stmt of func.body.stmts) {
      if (stmt.kind === 'LetStmt') {
        if (stmt.pattern.kind === 'IdentPattern') {
          const type = stmt.type || (stmt.init ? inferExprType(ctx, stmt.init) : undefined);
          if (type) {
            emit(ctx, `(local $${stmt.pattern.name} ${typeToWat(type)})`);
          }
        } else if (stmt.pattern.kind === 'TuplePattern') {
          // Collect locals for each element - need to infer type from init
          const initType = stmt.init ? inferExprType(ctx, stmt.init) : undefined;
          const resolvedInit = initType ? resolveTypeAlias(ctx, initType) : undefined;
          for (let i = 0; i < stmt.pattern.elements.length; i++) {
            const elem = stmt.pattern.elements[i];
            if (elem.pattern.kind === 'IdentPattern') {
              let elemType = 'f64';
              if (resolvedInit?.kind === 'TupleType' && resolvedInit.elements[i]) {
                elemType = typeToWat(resolvedInit.elements[i]);
              } else if (resolvedInit?.kind === 'StructType' && resolvedInit.fields[i]) {
                elemType = typeToWat(resolvedInit.fields[i].type);
              }
              emit(ctx, `(local $${elem.pattern.name} ${elemType})`);
            }
          }
        } else if (stmt.pattern.kind === 'StructPattern') {
          // Struct destructuring: let { d, a } = expr
          const initType = stmt.init ? inferExprType(ctx, stmt.init) : undefined;
          const resolvedInit = initType ? resolveTypeAlias(ctx, initType) : undefined;
          for (const field of stmt.pattern.fields) {
            const bindingName = field.binding || field.fieldName;
            let fieldType = 'f64';
            if (resolvedInit?.kind === 'StructType') {
              const structField = resolvedInit.fields.find(f => f.name === field.fieldName);
              if (structField) {
                fieldType = typeToWat(structField.type);
              }
            }
            emit(ctx, `(local $${bindingName} ${fieldType})`);
          }
        }
      }
    }
  }

  // Named returns are locals - flatten struct types
  if (returns && 'kind' in returns && returns.kind === 'NamedReturns') {
    for (const ret of returns.fields) {
      const resolvedType = resolveTypeAlias(ctx, ret.type);
      if (resolvedType.kind === 'StructType') {
        // out:PolarPoint -> out_d:f64, out_a:f64
        for (const field of resolvedType.fields) {
          emit(ctx, `(local $${ret.name}_${field.name} ${typeToWat(field.type)})`);
        }
      } else {
        emit(ctx, `(local $${ret.name} ${typeToWat(ret.type)})`);
      }
    }
  }

  // Generate body
  if (func.body) {
    generateFuncBody(ctx, func.body, func);
  }

  ctx.indent--;
  emit(ctx, ')');
  ctx.currentFunc = undefined;  // Clear after function generation
}

function generateFuncBody(ctx: CodeGenContext, body: Body, func: FuncDecl): void {
  if (body.kind === 'ArrowBody') {
    // Arrow body: single expression
    generateExpr(ctx, body.expr);
  } else {
    // Block body: statements
    for (const stmt of body.stmts) {
      generateStmt(ctx, stmt);
    }

    // Return named return values - flatten struct types
    const returns = func.signature.returns;
    if (returns && 'kind' in returns && returns.kind === 'NamedReturns') {
      for (const ret of returns.fields) {
        const resolvedType = resolveTypeAlias(ctx, ret.type);
        if (resolvedType.kind === 'StructType') {
          // Push each field: out_d, out_a
          for (const field of resolvedType.fields) {
            emit(ctx, `(local.get $${ret.name}_${field.name})`);
          }
        } else {
          emit(ctx, `(local.get $${ret.name})`);
        }
      }
    }
  }
}

function generateStmt(ctx: CodeGenContext, stmt: Stmt): void {
  switch (stmt.kind) {
    case 'LetStmt': {
      if (stmt.pattern.kind === 'IdentPattern') {
        // Simple: let x = expr
        if (stmt.init) {
          generateExpr(ctx, stmt.init);
          emit(ctx, `(local.set $${stmt.pattern.name})`);
        }
      } else if (stmt.pattern.kind === 'TuplePattern') {
        // let (a, b) = expr - destructuring
        if (stmt.init) {
          generateExpr(ctx, stmt.init);
          // Values are on stack in order, assign in reverse
          for (let i = stmt.pattern.elements.length - 1; i >= 0; i--) {
            const elem = stmt.pattern.elements[i];
            if (elem.pattern.kind === 'IdentPattern') {
              emit(ctx, `(local.set $${elem.pattern.name})`);
            }
          }
        }
      } else if (stmt.pattern.kind === 'StructPattern') {
        // let { d, a } = expr - struct destructuring
        if (stmt.init) {
          generateExpr(ctx, stmt.init);
          // Get the struct type to know field order
          const initType = inferExprType(ctx, stmt.init);
          const resolvedInit = initType ? resolveTypeAlias(ctx, initType) : undefined;
          if (resolvedInit?.kind === 'StructType') {
            // Values are on stack in struct field order, assign in reverse field order
            for (let i = resolvedInit.fields.length - 1; i >= 0; i--) {
              const structField = resolvedInit.fields[i];
              // Find the pattern field that matches this struct field
              const patternField = stmt.pattern.fields.find(f => f.fieldName === structField.name);
              if (patternField) {
                const bindingName = patternField.binding || patternField.fieldName;
                emit(ctx, `(local.set $${bindingName})`);
              } else {
                // Field not in pattern, drop the value
                emit(ctx, `(drop)`);
              }
            }
          } else {
            emit(ctx, `;; ERROR: cannot destructure non-struct type`);
          }
        }
      } else {
        emit(ctx, `;; TODO: LetStmt pattern ${stmt.pattern.kind}`);
      }
      break;
    }

    case 'SetStmt': {
      if (stmt.pattern.kind === 'IdentPattern') {
        // Simple: set x = expr
        generateExpr(ctx, stmt.value);
        const isGlobal = ctx.globals.has(stmt.pattern.name);
        emit(ctx, `(${isGlobal ? 'global' : 'local'}.set $${stmt.pattern.name})`);
      } else if (stmt.pattern.kind === 'TuplePattern') {
        // set (a, b) = expr - destructuring
        generateExpr(ctx, stmt.value);
        // Values are on stack in order, assign in reverse
        for (let i = stmt.pattern.elements.length - 1; i >= 0; i--) {
          const elem = stmt.pattern.elements[i];
          if (elem.pattern.kind === 'IdentPattern') {
            const isGlobal = ctx.globals.has(elem.pattern.name);
            emit(ctx, `(${isGlobal ? 'global' : 'local'}.set $${elem.pattern.name})`);
          }
        }
      } else if (stmt.pattern.kind === 'StructPattern') {
        // set { x, y } = expr - struct destructuring to existing variables
        generateExpr(ctx, stmt.value);
        // Get the struct type to know field order
        const valueType = inferExprType(ctx, stmt.value);
        const resolvedValue = valueType ? resolveTypeAlias(ctx, valueType) : undefined;
        if (resolvedValue?.kind === 'StructType') {
          // Values are on stack in struct field order, assign in reverse field order
          for (let i = resolvedValue.fields.length - 1; i >= 0; i--) {
            const structField = resolvedValue.fields[i];
            // Find the pattern field that matches this struct field
            const patternField = stmt.pattern.fields.find(f => f.fieldName === structField.name);
            if (patternField) {
              const bindingName = patternField.binding || patternField.fieldName;
              const isGlobal = ctx.globals.has(bindingName);
              emit(ctx, `(${isGlobal ? 'global' : 'local'}.set $${bindingName})`);
            } else {
              // Field not in pattern, drop the value
              emit(ctx, `(drop)`);
            }
          }
        } else {
          emit(ctx, `;; ERROR: cannot destructure non-struct type`);
        }
      } else {
        emit(ctx, `;; TODO: SetStmt pattern ${stmt.pattern.kind}`);
      }
      break;
    }

    case 'AssignStmt': {
      const target = stmt.target;

      if (stmt.op === '=') {
        // Simple assignment
        if (target.kind === 'MemberExpr') {
          // For member stores, generate address first, then value, then store
          generateMemberStore(ctx, target, stmt.value);
        } else {
          generateExpr(ctx, stmt.value);
          generateStore(ctx, target);
        }
      } else {
        // Compound assignment: target op= value -> target = target op value
        generateLoad(ctx, target);
        generateExpr(ctx, stmt.value);

        const targetType = inferExprType(ctx, target);
        const prefix = getWatPrefix(targetType);
        const isFloat = prefix === 'f64' || prefix === 'f32';

        // Map compound op to WAT instruction
        const opMap: Record<string, string> = {
          '+=': `${prefix}.add`,
          '-=': `${prefix}.sub`,
          '*=': `${prefix}.mul`,
          '/=': isFloat ? `${prefix}.div` : `${prefix}.div_s`,
          '%=': `${prefix}.rem_s`,
          '&=': `${prefix}.and`,
          '|=': `${prefix}.or`,
          '^=': `${prefix}.xor`,
          '<<=': `${prefix}.shl`,
          '>>=': `${prefix}.shr_s`,
          '<<<=': `${prefix}.rotl`,
          '>>>=': `${prefix}.rotr`,
        };
        const watOp = opMap[stmt.op] || `${prefix}.add`;
        emit(ctx, `(${watOp})`);
        generateStore(ctx, target);
      }
      break;
    }

    case 'ExprStmt':
      generateExpr(ctx, stmt.expr);
      // Drop result if not used
      emit(ctx, '(drop)');
      break;

    case 'ReturnStmt':
      if (stmt.value) {
        generateExpr(ctx, stmt.value);
        emit(ctx, '(return)');
      }
      break;

    // TODO: Implement other statements (if, while, for, etc.)
    default:
      emit(ctx, `;; TODO: ${stmt.kind}`);
  }
}

function generateLoad(ctx: CodeGenContext, target: Expr): void {
  switch (target.kind) {
    case 'Identifier': {
      const isGlobal = ctx.globals.has(target.name);
      emit(ctx, `(${isGlobal ? 'global' : 'local'}.get $${target.name})`);
      break;
    }
    case 'IndexExpr':
      // Load from memory: base[index]
      generateExpr(ctx, target.target);
      generateExpr(ctx, target.index);
      emit(ctx, '(i32.add)');
      emit(ctx, '(i32.load)');
      break;
    case 'MemberExpr':
      // Load struct field - for now just emit TODO
      emit(ctx, `;; TODO: load ${target.member}`);
      break;
    default:
      emit(ctx, `;; TODO: load ${target.kind}`);
  }
}

function generateStore(ctx: CodeGenContext, target: Expr): void {
  // Value should already be on the stack
  switch (target.kind) {
    case 'Identifier': {
      const isGlobal = ctx.globals.has(target.name);
      emit(ctx, `(${isGlobal ? 'global' : 'local'}.set $${target.name})`);
      break;
    }
    case 'IndexExpr':
      // Store to memory: base[index] = value
      // Stack has: value. Need to compute address and use store
      // This is tricky because value is on top. Use a local to swap.
      emit(ctx, `;; TODO: indexed store`);
      break;
    case 'MemberExpr':
      emit(ctx, `;; TODO: member store ${target.member}`);
      break;
    default:
      emit(ctx, `;; TODO: store ${target.kind}`);
  }
}

function generateMemberStore(ctx: CodeGenContext, target: Expr & { kind: 'MemberExpr' }, value: Expr): void {
  // Struct fields are flattened: out.d = expr -> expr, local.set $out_d
  if (target.target.kind === 'Identifier' && typeof target.member === 'string') {
    const baseName = target.target.name;
    const flatName = `${baseName}_${target.member}`;
    emit(ctx, `(local.set $${flatName} ${exprToWat(ctx, value)})`);
  } else {
    emit(ctx, `;; TODO: member store on non-identifier target`);
  }
}

/**
 * Generate a folded WAT expression string (for use in nested contexts).
 */
function exprToWat(ctx: CodeGenContext, expr: Expr): string {
  switch (expr.kind) {
    case 'NumberLit': {
      const literalType = inferExprType(ctx, expr);
      const prefix = getWatPrefix(literalType);
      return `(${prefix}.const ${expr.value})`;
    }

    case 'Identifier':
      if (ctx.globals.has(expr.name)) {
        return `(global.get $${expr.name})`;
      } else {
        return `(local.get $${expr.name})`;
      }

    case 'MemberExpr':
      // Struct fields are flattened: point.x -> $point_x
      if (expr.target.kind === 'Identifier' && typeof expr.member === 'string') {
        const baseName = expr.target.name;
        const flatName = `${baseName}_${expr.member}`;
        return `(local.get $${flatName})`;
      }
      return `;; TODO: MemberExpr`;

    case 'BinaryExpr': {
      const leftType = inferExprType(ctx, expr.left);
      const rightType = inferExprType(ctx, expr.right);
      const opResult = resolveBinaryOp(expr.op, leftType, rightType, expr.left, expr.right);
      if (!opResult) return `;; ERROR: incompatible types for ${expr.op}`;

      let leftWat = exprToWat(ctx, expr.left);
      if (opResult.convertLeft) {
        leftWat = `(${opResult.convertLeft} ${leftWat})`;
      }

      let rightWat = exprToWat(ctx, expr.right);
      if (opResult.convertRight) {
        rightWat = `(${opResult.convertRight} ${rightWat})`;
      }

      return `(${opResult.op} ${leftWat} ${rightWat})`;
    }

    case 'CallExpr': {
      const builtinOps: Record<string, string> = {
        sqrt: 'f64.sqrt', abs: 'f64.abs', ceil: 'f64.ceil', floor: 'f64.floor',
        trunc: 'f64.trunc', nearest: 'f64.nearest', min: 'f64.min', max: 'f64.max',
        copysign: 'f64.copysign',
      };

      const args = expr.args.map(a => exprToWat(ctx, a.value)).join(' ');
      if (expr.callee.kind === 'Identifier') {
        const builtinOp = builtinOps[expr.callee.name];
        if (builtinOp) {
          return `(${builtinOp} ${args})`;
        }
        return `(call $${expr.callee.name}${args ? ` ${args}` : ''})`;
      }
      return `;; TODO: CallExpr with non-identifier callee`;
    }

    case 'StructLit':
      // Struct literals expand to multiple values (space-separated for inline use)
      return expr.fields.map(f => exprToWat(ctx, f.value)).join(' ');

    case 'TupleLit':
      // Tuple literals expand to multiple values
      return expr.elements.map(e => exprToWat(ctx, e.value)).join(' ');

    case 'StringLit': {
      // Register string and return ptr/len as two values
      const offset = registerString(ctx, expr.value);
      return `(i32.const ${offset}) (i32.const ${expr.value.length})`;
    }

    default:
      return `;; TODO: ${expr.kind}`;
  }
}

function generateExpr(ctx: CodeGenContext, expr: Expr): void {
  switch (expr.kind) {
    case 'StringLit': {
      // Register string and emit ptr/len (two values, can't fold into one)
      const offset = registerString(ctx, expr.value);
      emit(ctx, `(i32.const ${offset})`);
      emit(ctx, `(i32.const ${expr.value.length})`);
      break;
    }

    case 'TupleLit':
      // Tuples push multiple values onto the stack
      for (const elem of expr.elements) {
        generateExpr(ctx, elem.value);
      }
      break;

    case 'StructLit':
      // Struct literals push multiple values (one per field)
      for (const field of expr.fields) {
        generateExpr(ctx, field.value);
      }
      break;

    default:
      // Use folded form for all other expressions
      emit(ctx, exprToWat(ctx, expr));
  }
}

function getReturnTypeForWat(returns: Type | NamedReturns): Type {
  if ('kind' in returns && returns.kind === 'NamedReturns') {
    if (returns.fields.length === 1) {
      return returns.fields[0].type;
    }
    return {
      kind: 'TupleType',
      elements: returns.fields.map(f => f.type),
      span: returns.fields[0]?.span || { start: 0, end: 0 },
    };
  }
  return returns as Type;
}

function typeToWat(type: Type): string {
  switch (type.kind) {
    case 'PrimitiveType': {
      const name = type.name;
      if (name === 'f64') return 'f64';
      if (name === 'f32') return 'f32';
      if (name === 'i64' || name === 'u64') return 'i64';
      return 'i32';
    }
    case 'SliceType':
      return 'i32 i32'; // ptr, len
    case 'ArrayType':
      return 'i32'; // just a pointer at runtime
    case 'NullTermType':
      return 'i32'; // just a pointer, compiler knows to look for null
    case 'PointerType':
      return 'i32';
    case 'TupleType':
      return type.elements.map(typeToWat).join(' ');
    default:
      return 'i32';
  }
}

function registerString(ctx: CodeGenContext, str: string): number {
  const existing = ctx.strings.get(str);
  if (existing !== undefined) {
    return existing;
  }
  const offset = ctx.stringOffset;
  ctx.strings.set(str, offset);
  ctx.stringOffset += str.length + 1;  // +1 for null terminator
  return offset;
}

function escapeWatString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
    .replace(/\0/g, '\\00');
}
