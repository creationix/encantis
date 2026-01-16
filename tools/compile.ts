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

  // Log errors to stderr but continue with codegen (checker is incomplete)
  const errors = checkResult.errors.filter(e => e.severity === 'error');
  if (errors.length > 0) {
    for (const e of errors) {
      console.error(formatDiagnostic(src, e));
    }
    console.error(`\nWarning: ${errors.length} type error(s) found, continuing with codegen...\n`);
  }

  return generateWat(parseResult.ast, checkResult.symbols, src);
}

// -----------------------------------------------------------------------------
// WAT Code Generation (Basic Implementation)
// -----------------------------------------------------------------------------

interface LoopLabels {
  continue: string;  // Label to branch to for continue (loop start)
  break: string;     // Label to branch to for break (loop exit)
}

interface CodeGenContext {
  output: string[];
  indent: number;
  strings: Map<string, number>;
  stringOffset: number;
  src: string;
  globals: Set<string>;  // Track global variable names
  defs: Map<string, Expr>;  // Compile-time constants to inline
  symbols: SymbolTable;  // Type information from checker
  currentFunc?: FuncDecl;  // Current function for scope lookup
  reservedNames: Set<string>;  // Names used by flattened params (e.g., input_ptr, input_len)
  localRenames: Map<string, string>;  // Map from source name to WAT name for renamed locals
  loopStack: LoopLabels[];  // Stack of loop labels for break/continue
  labelCounter: number;  // Counter for generating unique labels
  usesMemory: boolean;  // Track if the module uses memory loads/stores
}

function emit(ctx: CodeGenContext, line: string): void {
  ctx.output.push('  '.repeat(ctx.indent) + line);
}

/**
 * Get a unique WAT local name, renaming if necessary to avoid conflicts with params.
 */
function getLocalName(ctx: CodeGenContext, sourceName: string): string {
  // Check if already renamed
  const existing = ctx.localRenames.get(sourceName);
  if (existing) return existing;

  // If no conflict, use the source name
  if (!ctx.reservedNames.has(sourceName)) {
    ctx.reservedNames.add(sourceName);
    return sourceName;
  }

  // Find a unique name by appending a suffix
  let suffix = 2;
  let watName = `${sourceName}_${suffix}`;
  while (ctx.reservedNames.has(watName)) {
    suffix++;
    watName = `${sourceName}_${suffix}`;
  }
  ctx.reservedNames.add(watName);
  ctx.localRenames.set(sourceName, watName);
  return watName;
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
        // Handle builtin functions
        const intBuiltins = ['popcnt', 'clz', 'ctz'];
        if (intBuiltins.includes(expr.callee.name) && expr.args.length === 1) {
          // These builtins return the same type as their argument
          return inferExprType(ctx, expr.args[0].value);
        }

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
      if (typeof expr.member !== 'string') return undefined;

      const targetType = inferExprType(ctx, expr.target);

      // Handle pointer dereference types: ptr.u64, ptr.u32, ptr.u8, etc.
      const isPointer = targetType?.kind === 'PointerType' || (targetType?.kind === 'PrimitiveType' && targetType.name.startsWith('*'));
      const derefTypes: Record<string, string> = {
        'u8': 'u8', 'i8': 'i8', 'u16': 'u16', 'i16': 'i16',
        'u32': 'u32', 'i32': 'i32', 'u64': 'u64', 'i64': 'i64',
        'f32': 'f32', 'f64': 'f64', '*': '',
      };
      if (isPointer && expr.member in derefTypes) {
        if (expr.member === '*' && targetType?.kind === 'PointerType') {
          // ptr.* returns the pointee type
          return targetType.target;
        }
        return { kind: 'PrimitiveType', name: derefTypes[expr.member] as 'i32' | 'i64' | 'f32' | 'f64' | 'u8' | 'u16' | 'u32' | 'u64' | 'i8' | 'i16', span: expr.span };
      }

      // Get the type of the target (e.g., point) and find the field type
      if (targetType) {
        const resolved = resolveTypeAlias(ctx, targetType);
        if (resolved.kind === 'StructType') {
          const field = resolved.fields.find(f => f.name === expr.member);
          if (field) {
            return field.type;
          }
        } else if (resolved.kind === 'SliceType') {
          // Slice members: .ptr -> pointer, .len -> i32
          if (expr.member === 'ptr') {
            return { kind: 'PointerType', target: resolved.element, span: expr.span };
          } else if (expr.member === 'len') {
            return { kind: 'PrimitiveType', name: 'i32', span: expr.span };
          }
        }
      }
      return undefined;
    }
    case 'GroupExpr':
      // Parenthesized expression - same type as inner expression
      return inferExprType(ctx, expr.expr);
    case 'CastExpr':
      // Cast expression returns the target type
      return expr.type;
    case 'AnnotationExpr':
      // Type-annotated expression returns the annotation type
      return expr.type;
    case 'IndexExpr': {
      // Array/slice indexing returns the element type
      const targetType = inferExprType(ctx, expr.target);
      if (targetType?.kind === 'SliceType') {
        return targetType.element;
      } else if (targetType?.kind === 'ArrayType') {
        return targetType.element;
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
 * Get the return type from the current function context.
 */
function getReturnTypeFromFunc(ctx: CodeGenContext): Type | undefined {
  if (!ctx.currentFunc) return undefined;
  const returns = ctx.currentFunc.signature.returns;
  if (!returns) return undefined;
  if ('kind' in returns && returns.kind === 'NamedReturns') {
    // For named returns like (out: i64), extract the type
    if (returns.fields.length === 1) {
      return returns.fields[0].type;
    }
    // Multiple named returns - return as tuple type
    return {
      kind: 'TupleType',
      elements: returns.fields.map(f => f.type),
      span: returns.fields[0]?.span || { start: 0, end: 0 },
    };
  }
  return returns as Type;
}

/**
 * Generate WAT expression with an expected type for contextual typing.
 * This is used for return statements where we know the expected return type.
 */
function exprToWatWithExpectedType(ctx: CodeGenContext, expr: Expr, expectedType: Type | undefined): string {
  // For number literals, use the expected type if available
  if (expr.kind === 'NumberLit' && expectedType) {
    const prefix = getWatPrefix(expectedType);
    return `(${prefix}.const ${expr.value})`;
  }
  // For other expressions, fall back to regular type inference
  return exprToWat(ctx, expr);
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

/**
 * Generate WAT global declarations, flattening multi-value types (slices, structs).
 */
function generateGlobalDecl(ctx: CodeGenContext, decl: { name: string; type?: Type; init?: Expr }): void {
  const type = decl.type;
  if (!type) {
    emit(ctx, `(global $${decl.name} (mut i32) (i32.const 0))`);
    return;
  }

  // Handle slice types: flatten to name_ptr and name_len
  if (type.kind === 'SliceType') {
    let ptrInit = '0';
    let lenInit = '0';
    if (decl.init?.kind === 'StructLit') {
      for (const field of decl.init.fields) {
        if (field.name === 'ptr' && field.value.kind === 'NumberLit') {
          ptrInit = field.value.value;
        } else if (field.name === 'len' && field.value.kind === 'NumberLit') {
          lenInit = field.value.value;
        }
      }
    }
    emit(ctx, `(global $${decl.name}_ptr (mut i32) (i32.const ${ptrInit}))`);
    emit(ctx, `(global $${decl.name}_len (mut i32) (i32.const ${lenInit}))`);
    // Also add flattened names to globals set for proper codegen
    ctx.globals.add(`${decl.name}_ptr`);
    ctx.globals.add(`${decl.name}_len`);
    return;
  }

  // Handle struct types: flatten to name_field1, name_field2, etc.
  const resolved = resolveTypeAlias(ctx, type);
  if (resolved.kind === 'StructType') {
    for (let i = 0; i < resolved.fields.length; i++) {
      const field = resolved.fields[i];
      const watType = typeToWat(field.type);
      let initVal = '0';
      if (decl.init?.kind === 'StructLit') {
        const initField = decl.init.fields.find(f => f.name === field.name);
        if (initField?.value.kind === 'NumberLit') {
          initVal = initField.value.value;
        }
      }
      emit(ctx, `(global $${decl.name}_${field.name} (mut ${watType}) (${watType}.const ${initVal}))`);
      ctx.globals.add(`${decl.name}_${field.name}`);
    }
    return;
  }

  // Simple primitive type
  const watType = typeToWat(type);
  const initValue = decl.init ? generateGlobalInit(decl.init) : '0';
  emit(ctx, `(global $${decl.name} (mut ${watType}) (${watType}.const ${initValue}))`);
}

function generateWat(module: Module, symbols: SymbolTable, src: string): string {
  const ctx: CodeGenContext = {
    output: [],
    indent: 0,
    strings: new Map(),
    stringOffset: 0,
    src,
    globals: new Set(),
    defs: new Map(),
    symbols,
    reservedNames: new Set(),
    localRenames: new Map(),
    loopStack: [],
    labelCounter: 0,
    usesMemory: false,
  };

  // Collect global/constant names and functions first
  const functions: Array<{ func: FuncDecl; exportName?: string }> = [];
  let hasMemory = false;

  for (const decl of module.decls) {
    if (decl.kind === 'GlobalDecl') {
      ctx.globals.add(decl.name);
    } else if (decl.kind === 'DefDecl') {
      // Store def value for inlining (not a global)
      ctx.defs.set(decl.name, decl.value);
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

  // Generate globals (but NOT def declarations - those are inlined)
  for (const decl of module.decls) {
    if (decl.kind === 'GlobalDecl') {
      generateGlobalDecl(ctx, decl);
    } else if (decl.kind === 'ExportDecl' && decl.decl.kind === 'GlobalDecl') {
      generateGlobalDecl(ctx, decl.decl);
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

  // Generate memory if not already exported but needed (strings or memory access)
  if (!hasMemory && (ctx.strings.size > 0 || ctx.usesMemory)) {
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

// Recursively collect all statements from a block body, including nested blocks
function collectAllStmts(stmts: Stmt[]): Stmt[] {
  const allStmts: Stmt[] = [];

  function collect(stmt: Stmt) {
    allStmts.push(stmt);

    // Recursively collect from nested blocks
    if (stmt.kind === 'IfStmt') {
      if (stmt.thenBody.kind === 'BlockBody') {
        for (const s of stmt.thenBody.stmts) collect(s);
      }
      for (const elif of stmt.elifClauses || []) {
        if (elif.body.kind === 'BlockBody') {
          for (const s of elif.body.stmts) collect(s);
        }
      }
      if (stmt.elseBody?.kind === 'BlockBody') {
        for (const s of stmt.elseBody.stmts) collect(s);
      }
    } else if (stmt.kind === 'LoopStmt' || stmt.kind === 'WhileStmt') {
      if (stmt.body.kind === 'BlockBody') {
        for (const s of stmt.body.stmts) collect(s);
      }
    } else if (stmt.kind === 'ForStmt') {
      if (stmt.body.kind === 'BlockBody') {
        for (const s of stmt.body.stmts) collect(s);
      }
    }
  }

  for (const stmt of stmts) {
    collect(stmt);
  }

  return allStmts;
}

function generateFunction(ctx: CodeGenContext, func: FuncDecl, exportName?: string): void {
  ctx.currentFunc = func;  // Set for type lookups in this function's scope
  ctx.reservedNames.clear();  // Reset for each function
  ctx.localRenames.clear();

  const name = func.name || exportName || 'anonymous';
  const exportClause = exportName ? `(export "${exportName}")` : '';

  // Build params - flatten struct/slice types into multiple params
  const flatParams: string[] = [];
  for (const p of func.signature.params) {
    if (!p.name) continue;
    const resolvedType = resolveTypeAlias(ctx, p.type);
    if (resolvedType.kind === 'StructType') {
      // Flatten: point:CartesianPoint -> point_x:f64, point_y:f64
      for (const field of resolvedType.fields) {
        const flatName = `${p.name}_${field.name}`;
        flatParams.push(`(param $${flatName} ${typeToWat(field.type)})`);
        ctx.reservedNames.add(flatName);
      }
    } else if (resolvedType.kind === 'SliceType') {
      // Flatten: data:u8[] -> data_ptr:i32, data_len:i32
      flatParams.push(`(param $${p.name}_ptr i32)`);
      flatParams.push(`(param $${p.name}_len i32)`);
      ctx.reservedNames.add(`${p.name}_ptr`);
      ctx.reservedNames.add(`${p.name}_len`);
    } else {
      flatParams.push(`(param $${p.name} ${typeToWat(p.type)})`);
      ctx.reservedNames.add(p.name);
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

  // Collect locals from body (recursively including nested blocks)
  if (func.body?.kind === 'BlockBody') {
    const allStmts = collectAllStmts(func.body.stmts);
    for (const stmt of allStmts) {
      if (stmt.kind === 'LetStmt') {
        if (stmt.pattern.kind === 'IdentPattern') {
          const type = stmt.type || (stmt.init ? inferExprType(ctx, stmt.init) : undefined);
          if (type) {
            const watName = getLocalName(ctx, stmt.pattern.name);
            emit(ctx, `(local $${watName} ${typeToWat(type)})`);
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
              const watName = getLocalName(ctx, elem.pattern.name);
              emit(ctx, `(local $${watName} ${elemType})`);
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
            const watName = getLocalName(ctx, bindingName);
            emit(ctx, `(local $${watName} ${fieldType})`);
          }
        }
      } else if (stmt.kind === 'ForStmt') {
        // For loop binding variable
        const watName = getLocalName(ctx, stmt.binding);
        emit(ctx, `(local $${watName} i32)`);
        if (stmt.indexBinding) {
          const indexWatName = getLocalName(ctx, stmt.indexBinding);
          emit(ctx, `(local $${indexWatName} i32)`);
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
          // Use folded form for single-value expressions
          const initWat = exprToWat(ctx, stmt.init);
          const watName = ctx.localRenames.get(stmt.pattern.name) || stmt.pattern.name;
          emit(ctx, `(local.set $${watName} ${initWat})`);
        }
      } else if (stmt.pattern.kind === 'TuplePattern') {
        // let (a, b) = expr - destructuring
        // Multi-value returns require fully flat form
        if (stmt.init) {
          generateExprMultiValue(ctx, stmt.init);
          // Values are on stack in order, assign in reverse
          for (let i = stmt.pattern.elements.length - 1; i >= 0; i--) {
            const elem = stmt.pattern.elements[i];
            if (elem.pattern.kind === 'IdentPattern') {
              const watName = ctx.localRenames.get(elem.pattern.name) || elem.pattern.name;
              emit(ctx, `(local.set $${watName})`);
            }
          }
        }
      } else if (stmt.pattern.kind === 'StructPattern') {
        // let { d, a } = expr - struct destructuring
        // Multi-value returns require fully flat form
        if (stmt.init) {
          // Generate entire sequence in flat form
          generateExprMultiValue(ctx, stmt.init);
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
                const watName = ctx.localRenames.get(bindingName) || bindingName;
                emit(ctx, `(local.set $${watName})`);
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
        // Simple: set x = expr - use folded form
        const valueWat = exprToWat(ctx, stmt.value);
        const isGlobal = ctx.globals.has(stmt.pattern.name);
        const watName = isGlobal ? stmt.pattern.name : (ctx.localRenames.get(stmt.pattern.name) || stmt.pattern.name);
        emit(ctx, `(${isGlobal ? 'global' : 'local'}.set $${watName} ${valueWat})`);
      } else if (stmt.pattern.kind === 'TuplePattern') {
        // set (a, b) = expr - destructuring
        // Multi-value returns require fully flat form
        generateExprMultiValue(ctx, stmt.value);
        // Values are on stack in order, assign in reverse
        for (let i = stmt.pattern.elements.length - 1; i >= 0; i--) {
          const elem = stmt.pattern.elements[i];
          if (elem.pattern.kind === 'IdentPattern') {
            const isGlobal = ctx.globals.has(elem.pattern.name);
            const watName = isGlobal ? elem.pattern.name : (ctx.localRenames.get(elem.pattern.name) || elem.pattern.name);
            emit(ctx, `(${isGlobal ? 'global' : 'local'}.set $${watName})`);
          }
        }
      } else if (stmt.pattern.kind === 'StructPattern') {
        // set { x, y } = expr - struct destructuring to existing variables
        // Multi-value returns require fully flat form
        generateExprMultiValue(ctx, stmt.value);
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
              const watName = isGlobal ? bindingName : (ctx.localRenames.get(bindingName) || bindingName);
              emit(ctx, `(${isGlobal ? 'global' : 'local'}.set $${watName})`);
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
        // Use fully folded form for wasm-opt compatibility
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

        // Generate fully folded form
        const targetWat = exprToWat(ctx, target);
        let valueWat = exprToWat(ctx, stmt.value);

        // Convert value to target type if needed
        const valueType = inferExprType(ctx, stmt.value);
        const valuePrefix = getWatPrefix(valueType);
        if (valuePrefix !== prefix) {
          const valueUnsigned = isUnsignedType(valueType);
          const conv = getConversion(valuePrefix as WatType, prefix as WatType, valueUnsigned);
          if (conv) {
            valueWat = `(${conv} ${valueWat})`;
          }
        }

        if (target.kind === 'Identifier') {
          const isGlobal = ctx.globals.has(target.name);
          const setOp = isGlobal ? 'global.set' : 'local.set';
          const watName = isGlobal ? target.name : (ctx.localRenames.get(target.name) || target.name);
          emit(ctx, `(${setOp} $${watName} (${watOp} ${targetWat} ${valueWat}))`);
        } else {
          // For complex targets, fall back to stack-based
          generateLoad(ctx, target);
          generateExpr(ctx, stmt.value);
          emit(ctx, `(${watOp})`);
          generateStore(ctx, target);
        }
      }
      break;
    }

    case 'ExprStmt': {
      // Only emit drop if the expression returns a value
      generateExpr(ctx, stmt.expr);
      // Check if it's a call to a void function
      if (stmt.expr.kind === 'CallExpr' && stmt.expr.callee.kind === 'Identifier') {
        const funcSym = ctx.symbols.global.symbols.get(stmt.expr.callee.name);
        if (funcSym?.type?.kind === 'FunctionType') {
          const ret = funcSym.type.returns;
          // Check if void: no returns, or empty tuple
          if (!ret || (ret.kind === 'TupleType' && ret.elements.length === 0)) {
            // Void function, no drop needed
            break;
          }
        }
      }
      // For all other expressions, assume they produce a value that needs dropping
      const exprType = inferExprType(ctx, stmt.expr);
      if (exprType) {
        emit(ctx, '(drop)');
      }
      break;
    }

    case 'ReturnStmt': {
      // Get expected return type from function signature
      const returnType = getReturnTypeFromFunc(ctx);

      if (stmt.when) {
        // Conditional return: return value when cond
        emit(ctx, `(if ${exprToWat(ctx, stmt.when)}`);
        ctx.indent++;
        emit(ctx, '(then');
        ctx.indent++;
        if (stmt.value) {
          emit(ctx, `(return ${exprToWatWithExpectedType(ctx, stmt.value, returnType)})`);
        } else {
          emit(ctx, '(return)');
        }
        ctx.indent--;
        emit(ctx, ')');
        ctx.indent--;
        emit(ctx, ')');
      } else if (stmt.value) {
        // Use folded form for return
        emit(ctx, `(return ${exprToWatWithExpectedType(ctx, stmt.value, returnType)})`);
      } else {
        emit(ctx, '(return)');
      }
      break;
    }

    case 'LoopStmt': {
      // Infinite loop: loop { ... break when cond }
      // WAT: (block $break (loop $continue ... (br $continue)))
      const breakLabel = `$loop_exit_${ctx.labelCounter}`;
      const continueLabel = `$loop_${ctx.labelCounter}`;
      ctx.labelCounter++;

      ctx.loopStack.push({ break: breakLabel, continue: continueLabel });

      emit(ctx, `(block ${breakLabel}`);
      ctx.indent++;
      emit(ctx, `(loop ${continueLabel}`);
      ctx.indent++;

      // Generate loop body
      if (stmt.body.kind === 'BlockBody') {
        for (const s of stmt.body.stmts) {
          generateStmt(ctx, s);
        }
      } else {
        generateExpr(ctx, stmt.body.expr);
        emit(ctx, '(drop)');
      }

      // Branch back to continue (loop start)
      emit(ctx, `(br ${continueLabel})`);

      ctx.indent--;
      emit(ctx, ')');
      ctx.indent--;
      emit(ctx, ')');

      ctx.loopStack.pop();

      // Infinite loops only exit via return, so code after is unreachable
      // This satisfies the type checker for functions that return values
      if (ctx.currentFunc?.signature.returns) {
        emit(ctx, '(unreachable)');
      }
      break;
    }

    case 'WhileStmt': {
      // While loop: while cond { ... }
      // WAT: (block $break (loop $continue (br_if $break (i32.eqz cond)) ... (br $continue)))
      const breakLabel = `$while_exit_${ctx.labelCounter}`;
      const continueLabel = `$while_${ctx.labelCounter}`;
      ctx.labelCounter++;

      ctx.loopStack.push({ break: breakLabel, continue: continueLabel });

      emit(ctx, `(block ${breakLabel}`);
      ctx.indent++;
      emit(ctx, `(loop ${continueLabel}`);
      ctx.indent++;

      // Check condition, break if false
      emit(ctx, `(br_if ${breakLabel} (i32.eqz ${exprToWat(ctx, stmt.condition)}))`);

      // Generate loop body
      if (stmt.body.kind === 'BlockBody') {
        for (const s of stmt.body.stmts) {
          generateStmt(ctx, s);
        }
      } else {
        generateExpr(ctx, stmt.body.expr);
        emit(ctx, '(drop)');
      }

      // Branch back to continue (loop start)
      emit(ctx, `(br ${continueLabel})`);

      ctx.indent--;
      emit(ctx, ')');
      ctx.indent--;
      emit(ctx, ')');

      ctx.loopStack.pop();
      break;
    }

    case 'ForStmt': {
      // For loop: for i in N { ... } or for i in iterable { ... }
      // For simple integer range: for i in N is equivalent to for i = 0; i < N; i++
      // WAT: (local $i i32) (local.set $i 0) (block $break (loop $continue (br_if $break (i32.ge_s $i N)) ... (local.set $i (i32.add $i 1)) (br $continue)))
      const breakLabel = `$for_exit_${ctx.labelCounter}`;
      const continueLabel = `$for_${ctx.labelCounter}`;
      ctx.labelCounter++;

      ctx.loopStack.push({ break: breakLabel, continue: continueLabel });

      // Get the loop variable name (may need renaming)
      const loopVar = ctx.localRenames.get(stmt.binding) || stmt.binding;

      // Initialize loop variable to 0
      emit(ctx, `(local.set $${loopVar} (i32.const 0))`);

      emit(ctx, `(block ${breakLabel}`);
      ctx.indent++;
      emit(ctx, `(loop ${continueLabel}`);
      ctx.indent++;

      // Check condition: i < N, break if false
      emit(ctx, `(br_if ${breakLabel} (i32.ge_s (local.get $${loopVar}) ${exprToWat(ctx, stmt.iterable)}))`);

      // Generate loop body
      if (stmt.body.kind === 'BlockBody') {
        for (const s of stmt.body.stmts) {
          generateStmt(ctx, s);
        }
      } else {
        generateExpr(ctx, stmt.body.expr);
        emit(ctx, '(drop)');
      }

      // Increment loop variable
      emit(ctx, `(local.set $${loopVar} (i32.add (local.get $${loopVar}) (i32.const 1)))`);

      // Branch back to continue (loop start)
      emit(ctx, `(br ${continueLabel})`);

      ctx.indent--;
      emit(ctx, ')');
      ctx.indent--;
      emit(ctx, ')');

      ctx.loopStack.pop();
      break;
    }

    case 'IfStmt': {
      // If statement: if cond { ... } elif cond { ... } else { ... }
      const hasElse = stmt.elseBody || stmt.elifClauses.length > 0;

      emit(ctx, `(if ${exprToWat(ctx, stmt.condition)}`);
      ctx.indent++;
      emit(ctx, '(then');
      ctx.indent++;

      // Generate then body
      if (stmt.thenBody.kind === 'BlockBody') {
        for (const s of stmt.thenBody.stmts) {
          generateStmt(ctx, s);
        }
      } else {
        generateExpr(ctx, stmt.thenBody.expr);
        emit(ctx, '(drop)');
      }

      ctx.indent--;
      emit(ctx, ')');

      // Handle elif clauses and else
      if (hasElse) {
        emit(ctx, '(else');
        ctx.indent++;

        if (stmt.elifClauses.length > 0) {
          // Generate nested if for elif
          const elif = stmt.elifClauses[0];
          const remainingElifs = stmt.elifClauses.slice(1);
          const syntheticIf: typeof stmt = {
            ...stmt,
            condition: elif.condition,
            thenBody: elif.body,
            elifClauses: remainingElifs,
          };
          generateStmt(ctx, syntheticIf);
        } else if (stmt.elseBody) {
          // Generate else body
          if (stmt.elseBody.kind === 'BlockBody') {
            for (const s of stmt.elseBody.stmts) {
              generateStmt(ctx, s);
            }
          } else {
            generateExpr(ctx, stmt.elseBody.expr);
            emit(ctx, '(drop)');
          }
        }

        ctx.indent--;
        emit(ctx, ')');
      }

      ctx.indent--;
      emit(ctx, ')');
      break;
    }

    case 'BreakStmt': {
      if (ctx.loopStack.length === 0) {
        emit(ctx, `;; ERROR: break outside of loop`);
        break;
      }
      const labels = ctx.loopStack[ctx.loopStack.length - 1];
      if (stmt.when) {
        // Conditional break: break when cond
        emit(ctx, `(br_if ${labels.break} ${exprToWat(ctx, stmt.when)})`);
      } else {
        emit(ctx, `(br ${labels.break})`);
      }
      break;
    }

    case 'ContinueStmt': {
      if (ctx.loopStack.length === 0) {
        emit(ctx, `;; ERROR: continue outside of loop`);
        break;
      }
      const labels = ctx.loopStack[ctx.loopStack.length - 1];
      if (stmt.when) {
        // Conditional continue: continue when cond
        emit(ctx, `(br_if ${labels.continue} ${exprToWat(ctx, stmt.when)})`);
      } else {
        emit(ctx, `(br ${labels.continue})`);
      }
      break;
    }

    default:
      emit(ctx, `;; TODO: ${stmt.kind}`);
  }
}

function generateLoad(ctx: CodeGenContext, target: Expr): void {
  switch (target.kind) {
    case 'Identifier': {
      const isGlobal = ctx.globals.has(target.name);
      const watName = isGlobal ? target.name : (ctx.localRenames.get(target.name) || target.name);
      emit(ctx, `(${isGlobal ? 'global' : 'local'}.get $${watName})`);
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
      const watName = isGlobal ? target.name : (ctx.localRenames.get(target.name) || target.name);
      emit(ctx, `(${isGlobal ? 'global' : 'local'}.set $${watName})`);
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

    case 'Identifier': {
      // Check if it's a def constant to inline
      const defValue = ctx.defs.get(expr.name);
      if (defValue) {
        return exprToWat(ctx, defValue);
      }
      if (ctx.globals.has(expr.name)) {
        return `(global.get $${expr.name})`;
      }
      // Use renamed name if this local was renamed to avoid param collision
      const watName = ctx.localRenames.get(expr.name) || expr.name;
      return `(local.get $${watName})`;
    }

    case 'MemberExpr': {
      if (typeof expr.member !== 'string') {
        return `(i32.const 0)`;  // Computed member - fallback
      }

      // Check if this is a pointer dereference
      const targetType = inferExprType(ctx, expr.target);
      const isPointer = targetType?.kind === 'PointerType' || (targetType?.kind === 'PrimitiveType' && targetType.name.startsWith('*'));

      // Common dereference types for ptr.type syntax
      const derefLoads: Record<string, string> = {
        'u8': 'i32.load8_u', 'i8': 'i32.load8_s',
        'u16': 'i32.load16_u', 'i16': 'i32.load16_s',
        'u32': 'i32.load', 'i32': 'i32.load',
        'u64': 'i64.load', 'i64': 'i64.load',
        'f32': 'f32.load', 'f64': 'f64.load',
      };

      // Handle ptr.* dereference (dereference to pointer's target type)
      if (expr.member === '*' && isPointer) {
        const ptrExpr = exprToWat(ctx, expr.target);
        // Determine load type from pointer's target type
        if (targetType?.kind === 'PointerType') {
          const pointeeType = targetType.target;
          if (pointeeType?.kind === 'PrimitiveType') {
            const loadOp = derefLoads[pointeeType.name] || 'i32.load';
            return `(${loadOp} ${ptrExpr})`;
          }
        }
        // Default to i32.load for unresolved types
        return `(i32.load ${ptrExpr})`;
      }

      // Handle ptr.type dereference (ptr.u32, ptr.u8, etc.)
      if (isPointer && derefLoads[expr.member]) {
        const ptrExpr = exprToWat(ctx, expr.target);
        return `(${derefLoads[expr.member]} ${ptrExpr})`;
      }

      // Slice member access: data.ptr, data.len
      if (targetType?.kind === 'SliceType') {
        if (expr.target.kind === 'Identifier') {
          const baseName = expr.target.name;
          if (expr.member === 'ptr') {
            const watName = ctx.localRenames.get(`${baseName}_ptr`) || `${baseName}_ptr`;
            return `(local.get $${watName})`;
          } else if (expr.member === 'len') {
            const watName = ctx.localRenames.get(`${baseName}_len`) || `${baseName}_len`;
            return `(local.get $${watName})`;
          }
        }
      }

      // Struct fields are flattened: point.x -> $point_x
      if (expr.target.kind === 'Identifier') {
        const baseName = expr.target.name;
        const flatName = `${baseName}_${expr.member}`;
        return `(local.get $${flatName})`;
      }
      return `(i32.const 0)`;  // Fallback for unhandled MemberExpr
    }

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

      // Type-aware integer builtins (use i32 or i64 based on argument type)
      const intBuiltins = ['popcnt', 'clz', 'ctz'];

      if (expr.callee.kind === 'Identifier') {
        const builtinOp = builtinOps[expr.callee.name];
        if (builtinOp) {
          const args = expr.args.map(a => exprToWat(ctx, a.value)).join(' ');
          return `(${builtinOp} ${args})`;
        }

        // Handle type-aware integer builtins
        if (intBuiltins.includes(expr.callee.name) && expr.args.length === 1) {
          const argType = inferExprType(ctx, expr.args[0].value);
          const prefix = getWatPrefix(argType);
          const intPrefix = prefix === 'i64' ? 'i64' : 'i32';
          const argWat = exprToWat(ctx, expr.args[0].value);
          return `(${intPrefix}.${expr.callee.name} ${argWat})`;
        }

        // Look up function signature to get expected parameter types
        const funcSym = ctx.symbols.global.symbols.get(expr.callee.name);
        const funcType = funcSym?.type;
        const paramTypes: Type[] = [];
        if (funcType?.kind === 'FunctionType' && funcType.params) {
          // params is Type[] in FunctionType
          for (const p of funcType.params) {
            paramTypes.push(p as unknown as Type);
          }
        }

        // Generate arguments with type conversion if needed
        const argParts: string[] = [];
        for (let i = 0; i < expr.args.length; i++) {
          const arg = expr.args[i];
          let argWat = exprToWat(ctx, arg.value);

          // Convert argument type if it doesn't match expected parameter type
          if (paramTypes[i]) {
            const argType = inferExprType(ctx, arg.value);
            const argPrefix = getWatPrefix(argType);
            const paramPrefix = getWatPrefix(paramTypes[i]);
            if (argPrefix !== paramPrefix) {
              const argUnsigned = isUnsignedType(argType);
              const conv = getConversion(argPrefix as WatType, paramPrefix as WatType, argUnsigned);
              if (conv) {
                argWat = `(${conv} ${argWat})`;
              }
            }
          }
          argParts.push(argWat);
        }

        const args = argParts.join(' ');
        return `(call $${expr.callee.name}${args ? ` ${args}` : ''})`;
      }
      return `(i32.const 0) ;; TODO: CallExpr with non-identifier callee`;
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

    case 'AnnotationExpr': {
      // Type-annotated expression (e.g., 2654435761:u32) - use the annotated type
      const watType = getWatPrefix(expr.type);
      if (expr.expr.kind === 'NumberLit') {
        return `(${watType}.const ${expr.expr.value})`;
      }
      return exprToWat(ctx, expr.expr);
    }

    case 'GroupExpr':
      // Parenthesized expression - just pass through to inner expression
      return exprToWat(ctx, expr.expr);

    case 'CastExpr': {
      // Type cast: expr as Type
      const srcType = inferExprType(ctx, expr.expr);
      const srcWat = getWatPrefix(srcType);
      const dstWat = getWatPrefix(expr.type);
      const srcUnsigned = isUnsignedType(srcType);
      const dstUnsigned = isUnsignedType(expr.type);
      const innerWat = exprToWat(ctx, expr.expr);

      // Same type - no conversion needed
      if (srcWat === dstWat) {
        return innerWat;
      }

      const suffix = srcUnsigned ? 'u' : 's';

      // Integer → wider integer
      if (srcWat === 'i32' && dstWat === 'i64') {
        return `(i64.extend_i32_${suffix} ${innerWat})`;
      }

      // Integer → narrower integer (wrap)
      if (srcWat === 'i64' && dstWat === 'i32') {
        return `(i32.wrap_i64 ${innerWat})`;
      }

      // Integer → float
      if ((srcWat === 'i32' || srcWat === 'i64') && (dstWat === 'f32' || dstWat === 'f64')) {
        return `(${dstWat}.convert_${srcWat}_${suffix} ${innerWat})`;
      }

      // Float → integer (truncate)
      if ((srcWat === 'f32' || srcWat === 'f64') && (dstWat === 'i32' || dstWat === 'i64')) {
        const dstSuffix = dstUnsigned ? 'u' : 's';
        return `(${dstWat}.trunc_${srcWat}_${dstSuffix} ${innerWat})`;
      }

      // Float → float (promote/demote)
      if (srcWat === 'f32' && dstWat === 'f64') {
        return `(f64.promote_f32 ${innerWat})`;
      }
      if (srcWat === 'f64' && dstWat === 'f32') {
        return `(f32.demote_f64 ${innerWat})`;
      }

      // Fallback - just return the inner expression with a warning
      return `${innerWat} ;; WARN: unsupported cast ${srcWat} -> ${dstWat}`;
    }

    case 'IndexExpr': {
      // Array indexing: arr[index] where arr is a slice (ptr + len)
      // For u64[]: ptr + index * 8, then load i64
      ctx.usesMemory = true;  // Mark that we need memory
      const targetType = inferExprType(ctx, expr.target);
      let elemType: Type | undefined;
      if (targetType?.kind === 'SliceType') {
        elemType = targetType.element;
      } else if (targetType?.kind === 'ArrayType') {
        elemType = targetType.element;
      }
      const elemSize = elemType ? getTypeSize(elemType) : 4;
      const loadOp = elemType ? getLoadOp(elemType) : 'i32.load';

      // Get base pointer
      let ptrWat: string;
      if (expr.target.kind === 'Identifier') {
        // For slice parameters, access the _ptr flattened param
        const baseName = expr.target.name;
        const ptrName = `${baseName}_ptr`;
        if (ctx.reservedNames.has(ptrName)) {
          ptrWat = `(local.get $${ptrName})`;
        } else if (ctx.globals.has(ptrName)) {
          ptrWat = `(global.get $${ptrName})`;
        } else {
          // Might be a raw pointer variable
          const watName = ctx.localRenames.get(baseName) || baseName;
          ptrWat = `(local.get $${watName})`;
        }
      } else {
        // For complex expressions, evaluate them (assume they return a pointer)
        ptrWat = exprToWat(ctx, expr.target);
      }

      // Get index and compute byte offset
      const indexWat = exprToWat(ctx, expr.index);

      // Compute address: ptr + index * elemSize
      if (elemSize === 1) {
        return `(${loadOp} (i32.add ${ptrWat} ${indexWat}))`;
      } else {
        return `(${loadOp} (i32.add ${ptrWat} (i32.shl ${indexWat} (i32.const ${Math.log2(elemSize)}))))`;
      }
    }

    case 'UnaryExpr': {
      const operandWat = exprToWat(ctx, expr.operand);
      const operandType = inferExprType(ctx, expr.operand);
      const prefix = getWatPrefix(operandType);

      switch (expr.op) {
        case '-':
          // Numeric negation: 0 - x
          if (prefix === 'f32' || prefix === 'f64') {
            return `(${prefix}.neg ${operandWat})`;
          }
          return `(${prefix}.sub (${prefix}.const 0) ${operandWat})`;
        case '!':
          // Boolean not: x == 0
          return `(i32.eqz ${operandWat})`;
        case '~':
          // Bitwise not: x ^ -1
          return `(${prefix}.xor ${operandWat} (${prefix}.const -1))`;
        case '&':
          // Address-of: for globals, try to return their memory address
          // For identifiers referring to globals at fixed offsets, return the offset
          if (expr.operand.kind === 'Identifier') {
            // Check if it's a global with a known memory offset
            if (ctx.globals.has(expr.operand.name)) {
              // Global variables might be at a fixed memory location
              return `(global.get $${expr.operand.name})`;
            }
          }
          // For locals or complex expressions, we can't take the address directly
          // Return a placeholder (this is a semantic limitation)
          return operandWat;
        default:
          return `(i32.const 0)`;
      }
    }

    default:
      // Return a placeholder value instead of a comment to avoid breaking S-expressions
      return `(i32.const 0)`;
  }
}

/**
 * Generate expression for multi-value context (each value on stack separately).
 * Uses S-expression form but emits each value-producing instruction separately.
 */
function generateExprMultiValue(ctx: CodeGenContext, expr: Expr): void {
  switch (expr.kind) {
    case 'CallExpr': {
      // For calls, use folded form which pushes all return values onto stack
      emit(ctx, exprToWat(ctx, expr));
      break;
    }
    case 'Identifier': {
      const defValue = ctx.defs.get(expr.name);
      if (defValue) {
        generateExprMultiValue(ctx, defValue);
      } else if (ctx.globals.has(expr.name)) {
        emit(ctx, `(global.get $${expr.name})`);
      } else {
        const watName = ctx.localRenames.get(expr.name) || expr.name;
        emit(ctx, `(local.get $${watName})`);
      }
      break;
    }
    case 'NumberLit': {
      const literalType = inferExprType(ctx, expr);
      const prefix = getWatPrefix(literalType);
      emit(ctx, `(${prefix}.const ${expr.value})`);
      break;
    }
    case 'MemberExpr': {
      // Use exprToWat which handles pointer dereferences and struct fields
      emit(ctx, exprToWat(ctx, expr));
      break;
    }
    case 'AnnotationExpr': {
      const watType = getWatPrefix(expr.type);
      if (expr.expr.kind === 'NumberLit') {
        emit(ctx, `(${watType}.const ${expr.expr.value})`);
      } else {
        generateExprMultiValue(ctx, expr.expr);
      }
      break;
    }
    case 'StructLit': {
      // Struct literals push multiple values (one per field)
      for (const field of expr.fields) {
        generateExprMultiValue(ctx, field.value);
      }
      break;
    }
    case 'TupleLit': {
      // Tuple literals push multiple values
      for (const elem of expr.elements) {
        generateExprMultiValue(ctx, elem.value);
      }
      break;
    }
    default:
      // Fall back to folded form
      emit(ctx, exprToWat(ctx, expr));
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
