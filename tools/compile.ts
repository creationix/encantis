// =============================================================================
// Encantis Compiler
// Main entry point: exports parse(), check(), and compile()
// =============================================================================

import type {
  CheckResult, Diagnostic, Expr, FuncBody, FuncDecl,
  Module, ParseResult, Stmt, Token, Type, SymbolTable,
} from './types';

import { check as doCheck } from './checker';
import { formatDiagnostic, getLineAndColumn, tokenize } from './lexer';
import { parse as doParse } from './parser';

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
    case 'NumberLiteral':
      if (expr.suffix) {
        return { kind: 'PrimitiveType', name: expr.suffix, span: expr.span };
      }
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
    case 'TupleExpr':
      return {
        kind: 'TupleType',
        elements: expr.elements.map(e => inferExprType(ctx, e)).filter((t): t is Type => t !== undefined),
        span: expr.span,
      };
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
  if (expr.kind !== 'NumberLiteral') return false;
  // If it has a suffix, it's not a comptime/untyped literal
  if (expr.suffix) return false;
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
  if (expr.kind === 'NumberLiteral') {
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

  // Collect global names first
  for (const global of module.globals) {
    ctx.globals.add(global.name);
  }

  emit(ctx, '(module');
  ctx.indent++;

  // Generate imports
  for (const imp of module.imports) {
    if (imp.kind === 'ImportGroup') {
      for (const item of imp.items) {
        const localName = item.localName || item.exportName;
        const params = item.params.map(p => `(param ${typeToWat(p.type)})`).join(' ');
        const result = item.returnType ? `(result ${typeToWat(item.returnType)})` : '';
        emit(ctx, `(func $${localName} (import "${imp.module}" "${item.exportName}") ${params} ${result})`);
      }
    } else {
      const localName = imp.localName || imp.exportName;
      const params = imp.funcType.params.map(t => typeToWat(t)).join(' ');
      const paramsStr = params ? `(param ${params})` : '';
      const returns = imp.funcType.returns;
      const result = returns.kind !== 'TupleType' || (returns.kind === 'TupleType' && returns.elements.length > 0)
        ? `(result ${typeToWat(imp.funcType.returns)})`
        : '';
      emit(ctx, `(func $${localName} (import "${imp.module}" "${imp.exportName}") ${paramsStr} ${result})`);
    }
  }

  // Generate globals
  for (const global of module.globals) {
    const watType = global.type ? typeToWat(global.type) : 'i32';
    const mutability = global.mutable ? `(mut ${watType})` : watType;
    // Generate init value - for now assume it's a number literal
    const initValue = generateGlobalInit(global.init);
    emit(ctx, `(global $${global.name} ${mutability} (${watType}.const ${initValue}))`);
  }

  // Generate exports
  for (const exp of module.exports) {
    if (exp.decl.kind === 'FuncDecl') {
      generateFunction(ctx, exp.decl, exp.exportName);
    } else if (exp.decl.kind === 'MemoryDecl') {
      emit(ctx, `(memory (export "${exp.exportName}") ${exp.decl.pages})`);
    }
  }

  // Generate non-exported functions
  for (const func of module.functions) {
    if (func.name) {
      generateFunction(ctx, func);
    }
  }

  // Generate memory if not already exported
  const hasMemory = module.exports.some(e => e.decl.kind === 'MemoryDecl') || module.memories.length > 0;
  if (!hasMemory && ctx.strings.size > 0) {
    emit(ctx, '(memory 1)');
  }

  // Generate data section for strings
  if (ctx.strings.size > 0) {
    const sortedStrings = Array.from(ctx.strings.entries()).sort((a, b) => a[1] - b[1]);
    const allStrings = sortedStrings.map(([str]) => escapeWatString(str)).join('');
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

  // Build params
  const params = func.params.map(p => `(param $${p.name} ${typeToWat(p.type)})`).join(' ');

  // Build results
  let results = '';
  if (func.returnType) {
    if ('params' in func.returnType) {
      // Named returns
      results = `(result ${func.returnType.params.map(p => typeToWat(p.type)).join(' ')})`;
    } else {
      results = `(result ${typeToWat(func.returnType)})`;
    }
  }

  emit(ctx, `(func $${name} ${exportClause} ${params} ${results}`.trim());
  ctx.indent++;

  // Collect locals from body
  if (func.body?.kind === 'BlockBody') {
    for (const stmt of func.body.stmts) {
      if (stmt.kind === 'LocalDecl' && stmt.type) {
        emit(ctx, `(local $${stmt.name} ${typeToWat(stmt.type)})`);
      }
    }
  }

  // Named returns are also locals
  if (func.returnType && 'params' in func.returnType) {
    for (const ret of func.returnType.params) {
      emit(ctx, `(local $${ret.name} ${typeToWat(ret.type)})`);
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

function generateFuncBody(ctx: CodeGenContext, body: FuncBody, func: FuncDecl): void {
  if (body.kind === 'ArrowBody') {
    // Arrow body: just the expressions
    for (const expr of body.exprs) {
      generateExpr(ctx, expr);
    }
  } else {
    // Block body: statements
    for (const stmt of body.stmts) {
      generateStmt(ctx, stmt);
    }

    // Return named return values
    if (func.returnType && 'params' in func.returnType) {
      for (const ret of func.returnType.params) {
        emit(ctx, `(local.get $${ret.name})`);
      }
    }
  }
}

function generateStmt(ctx: CodeGenContext, stmt: Stmt): void {
  switch (stmt.kind) {
    case 'LocalDecl':
      if (stmt.init) {
        generateExpr(ctx, stmt.init);
        emit(ctx, `(local.set $${stmt.name})`);
      }
      break;

    case 'Assignment':
      if (stmt.op) {
        // Compound assignment: target op= value  ->  target = target op value
        // Only works for single target
        const target = stmt.targets[0];
        const isGlobal = ctx.globals.has(target.name);
        const targetType = inferExprType(ctx, target);
        const prefix = getWatPrefix(targetType);
        const isFloat = prefix === 'f64' || prefix === 'f32';

        emit(ctx, `(${isGlobal ? 'global' : 'local'}.get $${target.name})`);
        generateExpr(ctx, stmt.value);

        // Map compound op to WAT instruction with correct type prefix
        const opMap: Record<string, string> = {
          '+=': `${prefix}.add`,
          '-=': `${prefix}.sub`,
          '*=': `${prefix}.mul`,
          '/=': isFloat ? `${prefix}.div` : `${prefix}.div_s`,
          '%=': `${prefix}.rem_s`,  // integers only
          '&=': `${prefix}.and`,    // integers only
          '|=': `${prefix}.or`,     // integers only
          '^=': `${prefix}.xor`,    // integers only
          '<<=': `${prefix}.shl`,   // integers only
          '>>=': `${prefix}.shr_s`, // integers only
          '<<<=': `${prefix}.rotl`, // integers only
          '>>>=': `${prefix}.rotr`, // integers only
        };
        const watOp = opMap[stmt.op] || `${prefix}.add`;
        emit(ctx, `(${watOp})`);
        emit(ctx, `(${isGlobal ? 'global' : 'local'}.set $${target.name})`);
      } else {
        // Simple assignment
        generateExpr(ctx, stmt.value);
        // For multiple targets, WAT pops in reverse order
        for (let i = stmt.targets.length - 1; i >= 0; i--) {
          const t = stmt.targets[i];
          const isGlobal = ctx.globals.has(t.name);
          emit(ctx, `(${isGlobal ? 'global' : 'local'}.set $${t.name})`);
        }
      }
      break;

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

function generateExpr(ctx: CodeGenContext, expr: Expr): void {
  switch (expr.kind) {
    case 'NumberLiteral': {
      const literalType = inferExprType(ctx, expr);
      const prefix = getWatPrefix(literalType);
      emit(ctx, `(${prefix}.const ${expr.value})`);
      break;
    }

    case 'StringLiteral': {
      // Register string and emit ptr/len
      const offset = registerString(ctx, expr.value);
      emit(ctx, `(i32.const ${offset})`);
      emit(ctx, `(i32.const ${expr.value.length})`);
      break;
    }

    case 'Identifier':
      if (ctx.globals.has(expr.name)) {
        emit(ctx, `(global.get $${expr.name})`);
      } else {
        emit(ctx, `(local.get $${expr.name})`);
      }
      break;

    case 'BinaryExpr': {
      const leftType = inferExprType(ctx, expr.left);
      const rightType = inferExprType(ctx, expr.right);
      const opResult = resolveBinaryOp(expr.op, leftType, rightType, expr.left, expr.right);

      if (!opResult) {
        // Type error - incompatible types for this operation
        emit(ctx, `;; ERROR: incompatible types for ${expr.op}`);
        break;
      }

      // Generate left operand, then convert if needed
      generateExpr(ctx, expr.left);
      if (opResult.convertLeft) {
        emit(ctx, `(${opResult.convertLeft})`);
      }

      // Generate right operand, then convert if needed
      generateExpr(ctx, expr.right);
      if (opResult.convertRight) {
        emit(ctx, `(${opResult.convertRight})`);
      }

      emit(ctx, `(${opResult.op})`);
      break;
    }

    case 'CallExpr': {
      // Check if this is a builtin function (WASM instruction)
      const builtinOps: Record<string, string> = {
        sqrt: 'f64.sqrt',
        abs: 'f64.abs',
        ceil: 'f64.ceil',
        floor: 'f64.floor',
        trunc: 'f64.trunc',
        nearest: 'f64.nearest',
        min: 'f64.min',
        max: 'f64.max',
        copysign: 'f64.copysign',
      };

      for (const arg of expr.args) {
        generateExpr(ctx, arg);
      }

      if (expr.callee.kind === 'Identifier') {
        const builtinOp = builtinOps[expr.callee.name];
        if (builtinOp) {
          emit(ctx, `(${builtinOp})`);
        } else {
          emit(ctx, `(call $${expr.callee.name})`);
        }
      }
      break;
    }

    case 'TupleExpr':
      for (const elem of expr.elements) {
        generateExpr(ctx, elem);
      }
      break;

    default:
      emit(ctx, `;; TODO: ${expr.kind}`);
  }
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
  ctx.stringOffset += str.length;
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
