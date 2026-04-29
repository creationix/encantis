// WebAssembly Text (WAT) code generator for Encantis
// Generates S-expression format WAT from AST + TypeCheckResult

import type * as AST from './ast'
import { typeKey, type TypeCheckResult, type ProgramCheckResult, type Symbol as CheckSymbol } from './checker'
import { isSourceImport, resolveModulePath } from './loader'
import type { LoadedModule } from './loader'
import {
  type ResolvedType,
  type ResolvedField,
  isSigned,
  isFloat,
  isInteger,
  unwrap,
  primitiveByteSize,
  byteSize,
} from './types'
import * as RT from './types'
import { dataToWat, buildDataSection } from './data-pack'
import { totalElements } from './types'

// === Context ===

export interface CodegenContext {
  // Type map from checker (keyed by "offset:kind" composite key)
  types: Map<string, ResolvedType>
  // Symbol table from checker
  symbols: Map<string, CheckSymbol>
  // Local variable names → WASM local names (handles flattening)
  locals: Map<string, string[]>
  // Parameters (flattened)
  params: Map<string, string[]>
  // Literal refs from data section (AST offset → DataRef)
  literalRefs: Map<number, { ptr: number; len: number }>
  // Indentation level for formatting
  indent: number
  // Multi-module: local function name → mangled WAT name
  nameMap: Map<string, string>
  // Track whether __mul_hi helper is needed
  needsMulHi?: boolean
  // Named return locals for early return statements
  namedReturnLocals: string[]
}

function createContext(checkResult: TypeCheckResult, literalRefs: Map<number, { ptr: number; len: number }>, nameMap?: Map<string, string>): CodegenContext {
  return {
    types: checkResult.types,
    symbols: checkResult.symbols,
    locals: new Map(),
    params: new Map(),
    literalRefs,
    indent: 0,
    nameMap: nameMap ?? new Map(),
    namedReturnLocals: [],
  }
}

// === Type Mapping ===

/**
 * Convert a resolved type to WASM type string(s).
 * Primitives map to i32/i64/f32/f64.
 * Tuples flatten to multiple values.
 * Comptime types should have been concretized before calling this.
 */
export function typeToWasm(t: ResolvedType): string[] {
  const u = unwrap(t)

  switch (u.kind) {
    case 'primitive': {
      // i8, i16, u8, u16, i32, u32, bool → i32
      // i64, u64 → i64
      // f32 → f32, f64 → f64
      // i128, u128 → v128 (SIMD)
      // i256, u256 → v128, v128 (two SIMD registers)
      if (['i8', 'i16', 'u8', 'u16', 'i32', 'u32', 'bool'].includes(u.name)) {
        return ['i32']
      }
      if (['i64', 'u64'].includes(u.name)) {
        return ['i64']
      }
      if (u.name === 'f32') return ['f32']
      if (u.name === 'f64') return ['f64']
      if (['i128', 'u128'].includes(u.name)) {
        return ['v128']
      }
      if (['i256', 'u256'].includes(u.name)) {
        return ['v128', 'v128']
      }
      if (['i512', 'u512'].includes(u.name)) {
        return ['v128', 'v128', 'v128', 'v128']
      }
      throw new Error(`Unknown primitive type: ${u.name}`)
    }

    case 'pointer':
      return ['i32'] // Pointers are i32 indices

    case 'slice':
      // Slices are fat pointers: (ptr, len)
      return ['i32', 'i32']

    case 'array':
      // Arrays are pointers to data
      return ['i32']

    case 'comptime_array':
      throw new Error('comptime_array should be concretized before codegen')

    case 'tuple':
      // Flatten all fields
      return u.fields.flatMap((f) => typeToWasm(f.type))

    case 'func':
      // Function references are table indices
      return ['i32']

    case 'void':
      return []

    case 'comptime_int':
      throw new Error('comptime_int should be concretized before codegen')

    case 'comptime_float':
      throw new Error('comptime_float should be concretized before codegen')

    case 'comptime_list':
      throw new Error('comptime_list should be concretized before codegen')

    default:
      throw new Error(`Unknown type kind: ${(u as ResolvedType).kind}`)
  }
}

/**
 * Get the single WASM type for a resolved type.
 * For multi-value types (tuples), returns the first type.
 */
function typeToWasmSingle(t: ResolvedType): string {
  const types = typeToWasm(t)
  if (types.length === 0) {
    throw new Error('Expected non-void type')
  }
  return types[0]
}

/**
 * Flatten a type to WASM types with field suffixes.
 * For slices: ['ptr', 'len']
 * For tuples: field names or indices
 * Returns pairs of [suffix, wasmType]
 */
function flattenType(t: ResolvedType): Array<{ suffix: string; wasmType: string }> {
  const u = unwrap(t)

  switch (u.kind) {
    case 'slice':
      // Slices have ptr and len fields
      return [
        { suffix: 'ptr', wasmType: 'i32' },
        { suffix: 'len', wasmType: 'i32' },
      ]

    case 'array':
      // Arrays are just pointers
      return [{ suffix: '', wasmType: 'i32' }]

    case 'tuple':
      // Flatten all fields
      return u.fields.flatMap((f, i) => {
        const fieldSuffix = f.name ?? String(i)
        const nested = flattenType(f.type)
        if (nested.length === 1 && nested[0].suffix === '') {
          return [{ suffix: fieldSuffix, wasmType: nested[0].wasmType }]
        }
        return nested.map((n) => ({
          suffix: n.suffix ? `${fieldSuffix}_${n.suffix}` : fieldSuffix,
          wasmType: n.wasmType,
        }))
      })

    default: {
      const types = typeToWasm(t)
      if (types.length === 1) {
        return [{ suffix: '', wasmType: types[0] }]
      }
      return types.map((wt, i) => ({ suffix: String(i), wasmType: wt }))
    }
  }
}

// === Expression Codegen ===

export function exprToWat(expr: AST.Expr, ctx: CodegenContext): string {
  switch (expr.kind) {
    case 'LiteralExpr':
      return literalToWat(expr, ctx)
    case 'IdentExpr':
      return identToWat(expr, ctx)
    case 'BinaryExpr':
      return binaryToWat(expr, ctx)
    case 'UnaryExpr':
      return unaryToWat(expr, ctx)
    case 'CallExpr':
      return callToWat(expr, ctx)
    case 'MemberExpr':
      return memberToWat(expr, ctx)
    case 'IndexExpr':
      return indexToWat(expr, ctx)
    case 'IfExpr':
      return ifExprToWat(expr, ctx)
    case 'TupleExpr':
      return tupleToWat(expr, ctx)
    case 'GroupExpr':
      return exprToWat(expr.expr, ctx)
    case 'CastExpr':
      return castToWat(expr, ctx)
    case 'AnnotationExpr': {
      const annType = ctx.types.get(typeKey(expr.span.start, expr.kind))
      if (annType?.kind === 'slice') {
        const inner = expr.expr
        const id = (inner as any).dataId ?? inner.span.start
        const ref = ctx.literalRefs.get(id)
        if (ref) return `(i32.const ${ref.ptr}) (i32.const ${ref.len})`
      }
      return exprToWat(expr.expr, ctx)
    }
    case 'ArrayExpr':
      return arrayToWat(expr, ctx)
    case 'RepeatExpr':
      return repeatToWat(expr, ctx)
    case 'MatchExpr':
      return matchToWat(expr, ctx)
    case 'SizeofExpr':
      return sizeofToWat(expr, ctx)
    default:
      throw new Error(`Unhandled expression kind: ${(expr as AST.Expr).kind}`)
  }
}

function literalToWat(expr: AST.LiteralExpr, ctx: CodegenContext): string {
  const lit = expr.value

  switch (lit.kind) {
    case 'int': {
      // Type must be concretized before codegen
      const type = ctx.types.get(typeKey(expr.span.start, expr.kind))
      if (!type) {
        throw new Error(`Missing type for integer literal at offset ${expr.span.start}`)
      }
      const wt = typeToWasmSingle(type)
      if (wt === 'v128') {
        const nv = v128Count(type)
        const val = BigInt(lit.value)
        const parts: string[] = []
        for (let i = 0; i < nv; i++) {
          const lo = (val >> BigInt(i * 128)) & 0xFFFFFFFFFFFFFFFFn
          const hi = (val >> BigInt(i * 128 + 64)) & 0xFFFFFFFFFFFFFFFFn
          parts.push(`(v128.const i64x2 ${lo} ${hi})`)
        }
        return parts.join(' ')
      }
      return `(${wt}.const ${lit.value})`
    }

    case 'float': {
      const type = ctx.types.get(typeKey(expr.span.start, expr.kind))
      if (!type) {
        throw new Error(`Missing type for float literal at offset ${expr.span.start}`)
      }
      const wt = typeToWasmSingle(type)
      return `(${wt}.const ${lit.value})`
    }

    case 'bool':
      return `(i32.const ${lit.value ? 1 : 0})`

    case 'string':
      // String literals should be handled via data section
      // Return placeholder - codegen should use literalRefs
      return `(i32.const 0) ;; string literal`
  }
}

function identToWat(expr: AST.IdentExpr, ctx: CodegenContext): string {
  const name = expr.name

  // Check locals first (includes params)
  const localNames = ctx.locals.get(name) ?? ctx.params.get(name)
  if (localNames) {
    if (localNames.length === 1) {
      return `(local.get $${localNames[0]})`
    }
    // Multiple values (flattened struct) - return all
    return localNames.map((n) => `(local.get $${n})`).join(' ')
  }

  // Check module symbols
  const sym = ctx.symbols.get(name)
  if (sym) {
    if (sym.kind === 'func') {
      const watName = ctx.nameMap.get(name) ?? name
      return `(ref.func $${watName})`
    }
    if (sym.kind === 'global') {
      const watName = ctx.nameMap.get(name) ?? name
      return `(global.get $${watName})`
    }
    if (sym.kind === 'def') {
      // Compile-time constant - inline the value
      const val = sym.value
      if (val.kind === 'int') {
        const wt = typeToWasmSingle(sym.type)
        return `(${wt}.const ${val.value})`
      }
      if (val.kind === 'float') {
        const wt = typeToWasmSingle(sym.type)
        return `(${wt}.const ${val.value})`
      }
      if (val.kind === 'bool') {
        return `(i32.const ${val.value ? 1 : 0})`
      }
      if (val.kind === 'data_ptr') {
        const ref = ctx.literalRefs.get(val.id)
        if (ref) {
          if (sym.type.kind === 'slice') {
            return `(i32.const ${ref.ptr}) (i32.const ${ref.len})`
          }
          return `(i32.const ${ref.ptr})`
        }
        return `(i32.const 0) ;; data_ptr not found: ${val.id}`
      }
    }
  }

  // Unknown - emit error comment
  return `(i32.const 0) ;; unknown: ${name}`
}

function isV128Type(t: ResolvedType): boolean {
  const u = unwrap(t)
  return u.kind === 'primitive' && ['i128', 'u128'].includes(u.name)
}

function v128Count(t: ResolvedType): number {
  const u = unwrap(t)
  if (u.kind !== 'primitive') return 0
  if (['i128', 'u128'].includes(u.name)) return 1
  if (['i256', 'u256'].includes(u.name)) return 2
  if (['i512', 'u512'].includes(u.name)) return 4
  return 0
}

function multiV128BinaryOp(n: number, wasmOp: string, left: string, right: string): string {
  if (n === 1) return `(${wasmOp} ${left} ${right})`
  const leftParts = splitV128Components(left, n)
  const rightParts = splitV128Components(right, n)
  return leftParts.map((l, i) => `(${wasmOp} ${l} ${rightParts[i]})`).join(' ')
}

function multiV128UnaryOp(n: number, wasmOp: string, operand: string): string {
  if (n === 1) return `(${wasmOp} ${operand})`
  const parts = splitV128Components(operand, n)
  return parts.map(p => `(${wasmOp} ${p})`).join(' ')
}

function v128LoadSequence(type: ResolvedType, ptr: string): string {
  const nv = v128Count(type)
  if (nv > 1) {
    return Array.from({ length: nv }, (_, i) =>
      `(v128.load offset=${i * 16} ${ptr})`
    ).join(' ')
  }
  if (nv === 1) return `(v128.load ${ptr})`
  const u = unwrap(type)
  if (u.kind === 'primitive') {
    if (u.name === 'u8') return `(i32.load8_u ${ptr})`
    if (u.name === 'i8') return `(i32.load8_s ${ptr})`
    if (u.name === 'u16') return `(i32.load16_u ${ptr})`
    if (u.name === 'i16') return `(i32.load16_s ${ptr})`
  }
  const wt = typeToWasmSingle(type)
  return `(${wt}.load ${ptr})`
}

function v128StoreSequence(type: ResolvedType, ptr: string, value: string): string {
  const nv = v128Count(type)
  if (nv > 1) {
    const parts = splitV128Components(value, nv)
    return parts.map((v, i) =>
      `(v128.store offset=${i * 16} ${ptr} ${v})`
    ).join('\n')
  }
  if (nv === 1) return `(v128.store ${ptr} ${value})`
  const u = unwrap(type)
  if (u.kind === 'primitive') {
    if (u.name === 'u8' || u.name === 'i8') return `(i32.store8 ${ptr} ${value})`
    if (u.name === 'u16' || u.name === 'i16') return `(i32.store16 ${ptr} ${value})`
  }
  const wt = typeToWasmSingle(type)
  return `(${wt}.store ${ptr} ${value})`
}

function splitV128Components(wat: string, n: number): string[] {
  if (n === 1) return [wat]
  const parts: string[] = []
  let depth = 0
  let start = -1
  for (let i = 0; i < wat.length; i++) {
    if (wat[i] === '(') {
      if (depth === 0) start = i
      depth++
    } else if (wat[i] === ')') {
      depth--
      if (depth === 0 && start >= 0) {
        parts.push(wat.slice(start, i + 1))
        start = -1
      }
    }
  }
  if (parts.length === n) return parts
  throw new Error(`Expected ${n} v128 components, got ${parts.length}: ${wat.slice(0, 80)}...`)
}

function binaryToWat(expr: AST.BinaryExpr, ctx: CodegenContext): string {
  const left = exprToWat(expr.left, ctx)
  const right = exprToWat(expr.right, ctx)

  // Get result type from checker
  const resultType = ctx.types.get(typeKey(expr.span.start, expr.kind))
  if (!resultType) {
    throw new Error(`Missing type for binary expression at offset ${expr.span.start}`)
  }

  // For comparison ops, we need the operand type for signedness (result is bool)
  // For arithmetic ops, use the result type (which is the wider operand type)
  const leftType = ctx.types.get(typeKey(expr.left.span.start, expr.left.kind))
  const isComparison = ['==', '!=', '<', '>', '<=', '>='].includes(expr.op)
  const operandType = isComparison ? (leftType ?? resultType) : resultType

  const wt = typeToWasmSingle(operandType)
  const signed = isSigned(operandType)
  const isFloatType = isFloat(operandType)
  const isV128 = isV128Type(operandType)
  const nV128 = v128Count(operandType)

  const op = expr.op
  let wasmOp: string

  switch (op) {
    // Arithmetic
    case '+':
      wasmOp = nV128 > 0 ? 'i64x2.add' : `${wt}.add`
      break
    case '-':
      wasmOp = nV128 > 0 ? 'i64x2.sub' : `${wt}.sub`
      break
    case '*':
      wasmOp = nV128 > 0 ? 'i64x2.mul' : `${wt}.mul`
      break
    case '/':
      wasmOp = isFloatType ? `${wt}.div` : signed ? `${wt}.div_s` : `${wt}.div_u`
      break
    case '%':
      wasmOp = signed ? `${wt}.rem_s` : `${wt}.rem_u`
      break

    // Saturating arithmetic
    case '+|':
      wasmOp = signed ? `${wt}.add` : `${wt}.add` // TODO: implement saturation
      break
    case '-|':
      wasmOp = signed ? `${wt}.sub` : `${wt}.sub`
      break
    case '*|':
      wasmOp = signed ? `${wt}.mul` : `${wt}.mul`
      break

    // Comparison
    case '==':
      if (nV128 > 0) {
        if (nV128 === 1) return `(i32x4.all_true (i64x2.eq ${left} ${right}))`
        const lp = splitV128Components(left, nV128)
        const rp = splitV128Components(right, nV128)
        const eqs = lp.map((l, i) => `(i32x4.all_true (i64x2.eq ${l} ${rp[i]}))`).join(' ')
        return `(i32.and ${eqs})`
      }
      wasmOp = `${wt}.eq`
      break
    case '!=':
      if (nV128 > 0) {
        if (nV128 === 1) return `(i32.eqz (i32x4.all_true (i64x2.eq ${left} ${right})))`
        const lp = splitV128Components(left, nV128)
        const rp = splitV128Components(right, nV128)
        const eqs = lp.map((l, i) => `(i32x4.all_true (i64x2.eq ${l} ${rp[i]}))`).join(' ')
        return `(i32.eqz (i32.and ${eqs}))`
      }
      wasmOp = `${wt}.ne`
      break
    case '<':
      wasmOp = isFloatType ? `${wt}.lt` : signed ? `${wt}.lt_s` : `${wt}.lt_u`
      break
    case '>':
      wasmOp = isFloatType ? `${wt}.gt` : signed ? `${wt}.gt_s` : `${wt}.gt_u`
      break
    case '<=':
      wasmOp = isFloatType ? `${wt}.le` : signed ? `${wt}.le_s` : `${wt}.le_u`
      break
    case '>=':
      wasmOp = isFloatType ? `${wt}.ge` : signed ? `${wt}.ge_s` : `${wt}.ge_u`
      break

    // Bitwise
    case '&':
      wasmOp = nV128 > 0 ? 'v128.and' : `${wt}.and`
      break
    case '|':
      wasmOp = nV128 > 0 ? 'v128.or' : `${wt}.or`
      break
    case '^':
      wasmOp = nV128 > 0 ? 'v128.xor' : `${wt}.xor`
      break
    case '<<':
      wasmOp = nV128 > 0 ? 'i64x2.shl' : `${wt}.shl`
      break
    case '>>':
      wasmOp = nV128 > 0 ? (signed ? 'i64x2.shr_s' : 'i64x2.shr_u') : (signed ? `${wt}.shr_s` : `${wt}.shr_u`)
      break
    case '>>>':
      wasmOp = nV128 > 0 ? 'i64x2.shr_u' : `${wt}.shr_u`
      break
    case '<<<':
      wasmOp = nV128 > 0 ? 'i64x2.shl' : `${wt}.rotl`
      break

    // Logical (short-circuit)
    case '&&':
      return `(if (result i32) ${left} (then ${right}) (else (i32.const 0)))`
    case '||':
      return `(if (result i32) ${left} (then (i32.const 1)) (else ${right}))`

    default:
      throw new Error(`Unknown binary operator: ${op}`)
  }

  // Coerce operands to match the operation type when needed
  const leftWt = leftType ? typeToWasmSingle(leftType) : wt
  const leftSigned = leftType ? isSigned(leftType) : signed
  const coercedLeft = coerceWasmType(left, leftWt, wt, leftSigned)

  const rightType = ctx.types.get(typeKey(expr.right.span.start, expr.right.kind))
  const rightWt = rightType ? typeToWasmSingle(rightType) : wt
  const rightSigned = rightType ? isSigned(rightType) : signed
  const coercedRight = coerceWasmType(right, rightWt, wt, rightSigned)

  if (nV128 > 1) return multiV128BinaryOp(nV128, wasmOp, coercedLeft, coercedRight)
  return `(${wasmOp} ${coercedLeft} ${coercedRight})`
}

function unaryToWat(expr: AST.UnaryExpr, ctx: CodegenContext): string {
  const operand = exprToWat(expr.operand, ctx)

  // Get type from checker - must be recorded
  const type = ctx.types.get(typeKey(expr.span.start, expr.kind))
  if (!type) {
    throw new Error(`Missing type for unary expression at offset ${expr.span.start}`)
  }
  const wt = typeToWasmSingle(type)

  switch (expr.op) {
    case '-': {
      // Negate: 0 - x for integers, neg for floats
      if (isFloat(type)) {
        return `(${wt}.neg ${operand})`
      }
      const nv = v128Count(type)
      if (nv > 1) return multiV128UnaryOp(nv, 'i64x2.neg', operand)
      if (nv === 1) return `(i64x2.neg ${operand})`
      return `(${wt}.sub (${wt}.const 0) ${operand})`
    }

    case '~': {
      // Bitwise NOT
      const nv = v128Count(type)
      if (nv > 1) return multiV128UnaryOp(nv, 'v128.not', operand)
      if (nv === 1) return `(v128.not ${operand})`
      return `(${wt}.xor ${operand} (${wt}.const -1))`
    }

    case '!':
      // Logical NOT: x == 0
      return `(i32.eqz ${operand})`

    case '&':
      // Address-of: for now just return the operand (should be a pointer)
      return operand

    default:
      throw new Error(`Unknown unary operator: ${expr.op}`)
  }
}

// Handle builtin functions
// Returns null if not a builtin
function builtinToWat(name: string, expr: AST.CallExpr, ctx: CodegenContext): string | null {
  const args = expr.args.filter((a): a is AST.Arg & { value: AST.Expr } => a.value !== null)

  // Helper to get the wasm type for the first argument
  const getArgType = (): string => {
    if (args.length === 0) return 'i32'
    const argType = ctx.types.get(typeKey(args[0].value.span.start, args[0].value.kind))
    return argType ? typeToWasmSingle(argType) : 'i32'
  }

  switch (name) {
    case 'memset': {
      // memset(dest, value, len) -> memory.fill
      if (args.length !== 3) return null
      const dest = exprToWat(args[0].value, ctx)
      const value = exprToWat(args[1].value, ctx)
      const len = exprToWat(args[2].value, ctx)
      return `(memory.fill ${dest} ${value} ${len})`
    }

    case 'memcpy': {
      // memcpy(dest, src, len) -> memory.copy
      if (args.length !== 3) return null
      const dest = exprToWat(args[0].value, ctx)
      const src = exprToWat(args[1].value, ctx)
      const len = exprToWat(args[2].value, ctx)
      return `(memory.copy ${dest} ${src} ${len})`
    }

    // Float-only unary: sqrt, ceil, floor, trunc, nearest
    case 'sqrt':
    case 'ceil':
    case 'floor':
    case 'trunc':
    case 'nearest': {
      if (args.length !== 1) return null
      const arg = exprToWat(args[0].value, ctx)
      const wt = getArgType()
      return `(${wt}.${name} ${arg})`
    }

    // Float-only binary: copysign
    case 'copysign': {
      if (args.length !== 2) return null
      const a = exprToWat(args[0].value, ctx)
      const b = exprToWat(args[1].value, ctx)
      const wt = getArgType()
      return `(${wt}.copysign ${a} ${b})`
    }

    // min/max: native for floats, select for integers
    case 'min':
    case 'max': {
      if (args.length !== 2) return null
      const a = exprToWat(args[0].value, ctx)
      const b = exprToWat(args[1].value, ctx)
      const argType = ctx.types.get(typeKey(args[0].value.span.start, args[0].value.kind))
      const wt = argType ? typeToWasmSingle(argType) : 'i32'

      if (argType && isFloat(argType)) {
        // Native float min/max
        return `(${wt}.${name} ${a} ${b})`
      } else {
        // Integer min/max using select
        const signed = argType ? isSigned(argType) : true
        const cmp = name === 'min'
          ? (signed ? `${wt}.lt_s` : `${wt}.lt_u`)
          : (signed ? `${wt}.gt_s` : `${wt}.gt_u`)
        return `(select ${a} ${b} (${cmp} ${a} ${b}))`
      }
    }

    // abs: native for floats, conditional negate for signed integers
    case 'abs': {
      if (args.length !== 1) return null
      const arg = exprToWat(args[0].value, ctx)
      const argType = ctx.types.get(typeKey(args[0].value.span.start, args[0].value.kind))
      const wt = argType ? typeToWasmSingle(argType) : 'i32'

      if (argType && isFloat(argType)) {
        // Native float abs
        return `(${wt}.abs ${arg})`
      } else if (argType && isInteger(argType) && isSigned(argType)) {
        // Signed integer abs: select(x, -x, x >= 0)
        // -x = 0 - x
        return `(select ${arg} (${wt}.sub (${wt}.const 0) ${arg}) (${wt}.ge_s ${arg} (${wt}.const 0)))`
      } else {
        // Unsigned integer: abs is identity
        return arg
      }
    }

    // Integer-only unary: clz, ctz, popcnt
    case 'clz':
    case 'ctz':
    case 'popcnt': {
      if (args.length !== 1) return null
      const arg = exprToWat(args[0].value, ctx)
      const wt = getArgType()
      return `(${wt}.${name} ${arg})`
    }

    case 'mul_hi': {
      if (args.length !== 2) return null
      const a = exprToWat(args[0].value, ctx)
      const b = exprToWat(args[1].value, ctx)
      ctx.needsMulHi = true
      return `(call $__mul_hi ${a} ${b})`
    }

    default:
      return null
  }
}

function callToWat(expr: AST.CallExpr, ctx: CodegenContext): string {
  // Get function name
  let funcName: string
  if (expr.callee.kind === 'IdentExpr') {
    funcName = expr.callee.name
  } else {
    // Indirect call - not yet supported
    return `(call_indirect ${exprToWat(expr.callee, ctx)})`
  }

  // Handle builtin functions
  const builtin = builtinToWat(funcName, expr, ctx)
  if (builtin !== null) return builtin

  // Get callee type for param coercions
  const calleeSym = ctx.symbols.get(funcName)
  const paramTypes = calleeSym?.kind === 'func' ? calleeSym.type.params : null

  // Generate argument expressions with array→slice coercion
  const args = expr.args.map((arg, i) => {
    let wat: string
    if (arg.value) {
      wat = exprToWat(arg.value, ctx)
    } else if (arg.name) {
      wat = identToWat({ kind: 'IdentExpr', name: arg.name, span: arg.span }, ctx)
    } else {
      return ''
    }
    // Coerce array → slice: emit ptr + compile-time length
    if (paramTypes && i < paramTypes.length) {
      const paramType = paramTypes[i].type
      const argExpr = arg.value ?? { kind: 'IdentExpr' as const, name: arg.name!, span: arg.span }
      const argType = ctx.types.get(typeKey(argExpr.span.start, argExpr.kind))
      if (argType?.kind === 'array' && paramType.kind === 'slice') {
        const len = totalElements(argType.sizes)
        if (len !== null) {
          return `${wat} (i32.const ${len})`
        }
      }
    }
    return wat
  }).filter(Boolean).join(' ')

  const watName = ctx.nameMap.get(funcName) ?? funcName
  return `(call $${watName}${args ? ' ' + args : ''})`
}

function memberToWat(expr: AST.MemberExpr, ctx: CodegenContext): string {
  const member = expr.member

  if (member.kind === 'field') {
    // Get the type of the object to check for indexed/pointer-to-indexed
    const objType = ctx.types.get(typeKey(expr.object.span.start, expr.object.kind))

    // Handle .ptr, .len on slice types
    if (objType?.kind === 'slice') {
      if (member.name === 'ptr' || member.name === 'len') {
        const idx = member.name === 'ptr' ? 0 : 1
        if (expr.object.kind === 'IdentExpr') {
          const localNames = ctx.locals.get(expr.object.name) ?? ctx.params.get(expr.object.name)
          if (localNames && localNames.length >= 2) return `(local.get $${localNames[idx]})`
        }
        const full = exprToWat(expr.object, ctx)
        const parts = splitV128Components(full, 2)
        return parts[idx]
      }
      if (member.name === 'wid') {
        // Element byte size is always compile-time known
        const elemSize = byteSize(objType.element)
        if (elemSize === null) {
          throw new Error(`Cannot determine element size for ${objType.element.kind}`)
        }
        return `(i32.const ${elemSize})`
      }
    }

    // Handle .ptr, .len, .wid on array types
    if (objType?.kind === 'array') {
      if (member.name === 'ptr') {
        // For array, return the array pointer itself
        return exprToWat(expr.object, ctx)
      }
      if (member.name === 'len') {
        // For fixed array, length is compile-time constant from sizes
        const size = objType.sizes?.[0]
        if (typeof size === 'number') {
          return `(i32.const ${size})`
        }
        throw new Error('Array length must be compile-time known')
      }
      if (member.name === 'wid') {
        const elemSize = byteSize(objType.element)
        if (elemSize === null) {
          throw new Error(`Cannot determine element size for ${objType.element.kind}`)
        }
        return `(i32.const ${elemSize})`
      }
    }

    // Handle .ptr, .len, .wid on pointer-to-slice types
    if (objType?.kind === 'pointer' && objType.pointee.kind === 'slice') {
      const sliceType = objType.pointee
      if (member.name === 'ptr') {
        // For pointer-to-slice, .ptr loads the pointer field from memory
        return `(i32.load ${exprToWat(expr.object, ctx)})`
      }
      if (member.name === 'len') {
        // For pointer-to-slice, .len loads the length field (offset +4)
        return `(i32.load offset=4 ${exprToWat(expr.object, ctx)})`
      }
      if (member.name === 'wid') {
        const elemSize = byteSize(sliceType.element)
        if (elemSize === null) {
          throw new Error(`Cannot determine element size for ${sliceType.element.kind}`)
        }
        return `(i32.const ${elemSize})`
      }
    }

    // Handle .ptr, .len, .wid on pointer-to-array types
    if (objType?.kind === 'pointer' && objType.pointee.kind === 'array') {
      const arrayType = objType.pointee
      if (member.name === 'ptr') {
        // For pointer-to-array, .ptr is just the pointer value itself
        return exprToWat(expr.object, ctx)
      }
      if (member.name === 'len') {
        // For fixed array, length is compile-time constant
        const size = arrayType.sizes?.[0]
        if (typeof size === 'number') {
          return `(i32.const ${size})`
        }
        throw new Error('Array length must be compile-time known')
      }
      if (member.name === 'wid') {
        const elemSize = byteSize(arrayType.element)
        if (elemSize === null) {
          throw new Error(`Cannot determine element size for ${arrayType.element.kind}`)
        }
        return `(i32.const ${elemSize})`
      }
    }

    // Struct field access: flatten to local.get with field suffix
    if (expr.object.kind === 'IdentExpr') {
      const baseName = expr.object.name
      const fieldName = member.name
      const wasmName = `${baseName}_${fieldName}`

      // Check if it's in locals or params
      const localNames = ctx.locals.get(baseName) ?? ctx.params.get(baseName)
      if (localNames) {
        // Find the field index - for now assume sequential naming
        return `(local.get $${wasmName})`
      }
    }

    // For non-identifier bases, need memory access
    const base = exprToWat(expr.object, ctx)
    return `${base} ;; .${member.name}`
  }

  if (member.kind === 'index') {
    // Tuple positional access: .0, .1, etc.
    if (expr.object.kind === 'IdentExpr') {
      const baseName = expr.object.name
      const idx = member.value
      const localNames = ctx.locals.get(baseName) ?? ctx.params.get(baseName)
      if (localNames && localNames[idx]) {
        return `(local.get $${localNames[idx]})`
      }
    }
    return exprToWat(expr.object, ctx)
  }

  if (member.kind === 'deref') {
    // Pointer dereference: .* - load from memory
    const ptr = exprToWat(expr.object, ctx)
    const type = ctx.types.get(typeKey(expr.span.end, expr.kind)) ?? ctx.types.get(typeKey(expr.span.start, expr.kind))
    if (!type) {
      throw new Error(`Missing type for pointer dereference at offset ${expr.span.start}`)
    }
    return v128LoadSequence(type, ptr)
  }

  if (member.kind === 'type') {
    // Type pun: ptr.u64 → reinterprets the pointer, no load
    // The result is a many-pointer [*]T — actual loads happen at index/deref
    return exprToWat(expr.object, ctx)
  }

  return exprToWat(expr.object, ctx)
}

function indexOffset(object: AST.Expr, base: string, index: string, ctx: CodegenContext): { offset: string; elemSize: number } {
  const arrayTypeKey = object.kind === 'MemberExpr'
    ? typeKey(object.span.end, object.kind)
    : typeKey(object.span.start, object.kind)
  const arrayType = ctx.types.get(arrayTypeKey) ?? ctx.types.get(typeKey(object.span.start, object.kind))
  let elemSize = 1
  if (arrayType) {
    if (arrayType.kind === 'slice' || arrayType.kind === 'array') {
      elemSize = primitiveByteSize(arrayType.element) ?? 1
    } else if (arrayType.kind === 'pointer' && arrayType.pointee.kind === 'array') {
      elemSize = primitiveByteSize(arrayType.pointee.element) ?? 1
    } else if (arrayType.kind === 'pointer') {
      elemSize = primitiveByteSize(arrayType.pointee) ?? 1
    }
  }
  const offset = elemSize === 1
    ? `(i32.add ${base} ${index})`
    : `(i32.add ${base} (i32.mul ${index} (i32.const ${elemSize})))`
  return { offset, elemSize }
}

function indexToWat(expr: AST.IndexExpr, ctx: CodegenContext): string {
  let base = exprToWat(expr.object, ctx)
  const index = exprToWat(expr.index, ctx)
  // For slice objects, extract just the pointer (first component)
  const objTypeKey = expr.object.kind === 'MemberExpr'
    ? typeKey(expr.object.span.end, expr.object.kind)
    : typeKey(expr.object.span.start, expr.object.kind)
  const objType = ctx.types.get(objTypeKey) ?? ctx.types.get(typeKey(expr.object.span.start, expr.object.kind))
  if (objType?.kind === 'slice') {
    const parts = splitV128Components(base, 2)
    base = parts[0]
  }
  const { offset } = indexOffset(expr.object, base, index, ctx)

  // Load from memory
  const type = ctx.types.get(typeKey(expr.span.start, expr.kind))
  if (!type) {
    throw new Error(`Missing type for index expression at offset ${expr.span.start}`)
  }
  return v128LoadSequence(type, offset)
}

function ifExprToWat(expr: AST.IfExpr, ctx: CodegenContext): string {
  const cond = exprToWat(expr.condition, ctx)
  const thenBody = bodyToWat(expr.thenBranch, ctx)

  // Get result type
  const type = ctx.types.get(typeKey(expr.span.start, expr.kind))
  const resultTypes = type ? typeToWasm(type) : []
  const resultStr = resultTypes.length > 0 ? `(result ${resultTypes.join(' ')})` : ''

  // Handle elif chains
  let elseBody = ''
  if (expr.elifs.length > 0) {
    // Build nested if/else for elifs
    let current = expr.else_ ? bodyToWat(expr.else_, ctx) : ''
    for (let i = expr.elifs.length - 1; i >= 0; i--) {
      const elif = expr.elifs[i]
      const elifCond = exprToWat(elif.condition, ctx)
      const elifThen = bodyToWat(elif.thenBranch, ctx)
      current = `(if ${resultStr} ${elifCond} (then ${elifThen}) (else ${current}))`
    }
    elseBody = current
  } else if (expr.else_) {
    elseBody = bodyToWat(expr.else_, ctx)
  }

  if (elseBody) {
    return `(if ${resultStr} ${cond} (then ${thenBody}) (else ${elseBody}))`
  }
  return `(if ${resultStr} ${cond} (then ${thenBody}))`
}

function tupleToWat(expr: AST.TupleExpr, ctx: CodegenContext): string {
  // Flatten tuple elements
  const parts = expr.elements.map((elem) => {
    if (elem.value) {
      return exprToWat(elem.value, ctx)
    }
    // Shorthand: name:
    if (elem.name) {
      return identToWat({ kind: 'IdentExpr', name: elem.name, span: elem.span }, ctx)
    }
    return ''
  })
  return parts.filter(Boolean).join(' ')
}

function castToWat(expr: AST.CastExpr, ctx: CodegenContext): string {
  const inner = exprToWat(expr.expr, ctx)
  const fromType = ctx.types.get(typeKey(expr.expr.span.start, expr.expr.kind))
  const toType = ctx.types.get(typeKey(expr.span.start, expr.kind))

  if (!fromType || !toType) return inner

  const fromWasm = typeToWasmSingle(fromType)
  const toWasm = typeToWasmSingle(toType)

  if (fromWasm === toWasm) return inner

  // Generate appropriate conversion instruction
  const fromIsFloat = isFloat(fromType)
  const toIsFloat = isFloat(toType)
  const fromSigned = isSigned(fromType)
  const toSigned = isSigned(toType)

  if (fromIsFloat && !toIsFloat) {
    // Float to int
    return `(${toWasm}.trunc_${fromWasm}_${toSigned ? 's' : 'u'} ${inner})`
  }
  if (!fromIsFloat && toIsFloat) {
    // Int to float
    return `(${toWasm}.convert_${fromWasm}_${fromSigned ? 's' : 'u'} ${inner})`
  }
  if (fromIsFloat && toIsFloat) {
    // Float to float
    if (fromWasm === 'f32' && toWasm === 'f64') {
      return `(f64.promote_f32 ${inner})`
    }
    if (fromWasm === 'f64' && toWasm === 'f32') {
      return `(f32.demote_f64 ${inner})`
    }
  }
  // Int to int
  if (fromWasm === 'i32' && toWasm === 'i64') {
    return `(i64.extend_i32_${fromSigned ? 's' : 'u'} ${inner})`
  }
  if (fromWasm === 'i64' && toWasm === 'i32') {
    return `(i32.wrap_i64 ${inner})`
  }

  // Widening to v128 (u32/i32/u64/i64 → u128/i128)
  if (toWasm === 'v128' && (fromWasm === 'i32' || fromWasm === 'i64')) {
    const ext = fromWasm === 'i32' ? `(i64.extend_i32_${fromSigned ? 's' : 'u'} ${inner})` : inner
    return `(i64x2.replace_lane 0 (v128.const i64x2 0 0) ${ext})`
  }

  // Narrowing from v128 (u128/i128 → u64/i64)
  if (fromWasm === 'v128' && toWasm === 'i64') {
    return `(i64x2.extract_lane 0 ${inner})`
  }
  if (fromWasm === 'v128' && toWasm === 'i32') {
    return `(i32.wrap_i64 (i64x2.extract_lane 0 ${inner}))`
  }

  return inner
}

function arrayToWat(expr: AST.ArrayExpr, ctx: CodegenContext): string {
  // Check if this literal has a data section entry
  // Use dataId if present (survives def substitution), otherwise span.start
  const id = expr.dataId ?? expr.span.start
  const ref = ctx.literalRefs.get(id)
  if (ref) {
    return `(i32.const ${ref.ptr})`
  }
  // Array literals without data section entry - placeholder
  return `(i32.const 0) ;; array literal`
}

function repeatToWat(expr: AST.RepeatExpr, ctx: CodegenContext): string {
  const id = expr.dataId ?? expr.span.start
  const ref = ctx.literalRefs.get(id)
  if (ref) {
    const type = ctx.types.get(typeKey(expr.span.start, expr.kind))
    if (type?.kind === 'slice') {
      return `(i32.const ${ref.ptr}) (i32.const ${ref.len})`
    }
    return `(i32.const ${ref.ptr})`
  }
  return `(i32.const 0) ;; repeat literal`
}

function matchToWat(expr: AST.MatchExpr, ctx: CodegenContext): string {
  const subject = exprToWat(expr.subject, ctx)
  const type = ctx.types.get(typeKey(expr.span.start, expr.kind))
  const resultTypes = type ? typeToWasm(type) : []
  const resultStr = resultTypes.length > 0 ? `(result ${resultTypes.join(' ')})` : ''

  // For now, generate nested if/else for each arm
  // Could optimize to br_table for consecutive integers
  let result = '(unreachable)'

  for (let i = expr.arms.length - 1; i >= 0; i--) {
    const arm = expr.arms[i]

    // Check if this is a wildcard (default) pattern
    const isWildcard = arm.patterns.some((p) => p.kind === 'wildcard')

    const body =
      arm.body.kind === 'Block' || arm.body.kind === 'ArrowBody'
        ? bodyToWat(arm.body, ctx)
        : exprToWat(arm.body, ctx)

    if (isWildcard) {
      result = body
    } else {
      // Generate condition for patterns
      const conditions = arm.patterns.map((p) => {
        if (p.kind === 'literal') {
          const litValue =
            p.value.kind === 'int'
              ? `(i32.const ${p.value.value})`
              : p.value.kind === 'bool'
                ? `(i32.const ${p.value.value ? 1 : 0})`
                : '(i32.const 0)'
          return `(i32.eq ${subject} ${litValue})`
        }
        return '(i32.const 0)'
      })

      // Combine with OR
      const cond =
        conditions.length === 1
          ? conditions[0]
          : conditions.reduce((acc, c) => `(i32.or ${acc} ${c})`)

      result = `(if ${resultStr} ${cond} (then ${body}) (else ${result}))`
    }
  }

  return result
}

function sizeofToWat(expr: AST.SizeofExpr, ctx: CodegenContext): string {
  // Get the resolved type from the checker
  const type = ctx.types.get(typeKey(expr.span.start, expr.kind))
  if (type && type.kind === 'comptime_int') {
    // The checker already computed the size and stored it as comptime_int
    return `(i32.const ${type.value})`
  }
  // Fallback: resolve the type and compute size directly
  const resolvedType = resolveTypeFromAST(expr.type, ctx)
  const size = byteSize(resolvedType)
  return `(i32.const ${size ?? 0})`
}

// Helper to resolve an AST type to a ResolvedType (for sizeof fallback)
function resolveTypeFromAST(type: AST.Type, ctx: CodegenContext): RT.ResolvedType {
  switch (type.kind) {
    case 'PrimitiveType':
      return RT.primitive(type.name)
    case 'TypeRef': {
      const sym = ctx.symbols.get(type.name)
      if (sym && sym.kind === 'type') return sym.type
      return RT.primitive('i32')
    }
    case 'PointerType':
      return RT.pointer(resolveTypeFromAST(type.pointee, ctx))
    case 'IndexedType': {
      const element = resolveTypeFromAST(type.element, ctx)
      // Slice: []T (size is null, not many-pointer)
      if (type.size === null && !type.manyPointer) {
        return RT.slice(element)
      }
      // Array: [N]T, [_]T, [*]T, etc.
      let sizes: RT.ArraySize[] | null = null
      if (type.size === null && type.manyPointer) {
        // Many-pointer [*]T - null sizes
        sizes = null
      } else if (type.size === 'inferred') {
        sizes = ['_']
      } else if (typeof type.size === 'number') {
        sizes = [type.size]
      } else if (Array.isArray(type.size)) {
        sizes = type.size
      }
      return RT.array(element, sizes)
    }
    case 'CompositeType':
      return RT.tuple(type.fields.map(f => RT.field(f.ident, resolveTypeFromAST(f.type, ctx))))
    default:
      return RT.primitive('i32')
  }
}

// === Statement Codegen ===

export function stmtToWat(stmt: AST.Statement, ctx: CodegenContext): string {
  switch (stmt.kind) {
    case 'LetStmt':
      return letToWat(stmt, ctx)
    case 'SetStmt':
      return setToWat(stmt, ctx)
    case 'AssignmentStmt':
      return assignToWat(stmt, ctx)
    case 'ReturnStmt':
      return returnToWat(stmt, ctx)
    case 'ExpressionStmt':
      return exprToWat(stmt.expr, ctx)
    case 'WhileStmt':
      return whileToWat(stmt, ctx)
    case 'LoopStmt':
      return loopToWat(stmt, ctx)
    case 'ForStmt':
      return forToWat(stmt, ctx)
    case 'BreakStmt':
      return breakToWat(stmt, ctx)
    case 'ContinueStmt':
      return continueToWat(stmt, ctx)
    default:
      throw new Error(`Unhandled statement kind: ${(stmt as AST.Statement).kind}`)
  }
}

function letToWat(stmt: AST.LetStmt, ctx: CodegenContext): string {
  if (!stmt.value) return '' // Declaration only, no initialization

  if (stmt.pattern.kind === 'IdentPattern') {
    const name = stmt.pattern.name
    const value = exprToWat(stmt.value, ctx)

    // Get type from pattern offset (where checker stores it) - must be concretized
    const type = ctx.types.get(typeKey(stmt.pattern.span.start, stmt.pattern.kind))
    if (!type) {
      throw new Error(`Missing type for local '${name}' at offset ${stmt.pattern.span.start}`)
    }
    const wasmTypes = typeToWasm(type)

    if (wasmTypes.length === 1) {
      ctx.locals.set(name, [name])
      return `(local.set $${name} ${value})`
    }

    // Multiple values - flatten
    const names = wasmTypes.map((_, i) => `${name}_${i}`)
    ctx.locals.set(name, names)
    return names.map((n, i) => `(local.set $${n} ;; part ${i})`).join('\n')
  }

  if (stmt.pattern.kind === 'TuplePattern') {
    // Get tuple type to know field order
    const tupleType = ctx.types.get(typeKey(stmt.pattern.span.start, stmt.pattern.kind))
    if (!tupleType || tupleType.kind !== 'tuple') {
      throw new Error(`Missing tuple type for pattern at offset ${stmt.pattern.span.start}`)
    }

    // Build a map from field name to variable name
    const fieldToVar = new Map<string, string>()
    for (const elem of stmt.pattern.elements) {
      if (elem.kind === 'named') {
        fieldToVar.set(elem.field, elem.binding ?? elem.field)
      } else if (elem.pattern.kind === 'IdentPattern') {
        const idx = stmt.pattern.elements.indexOf(elem)
        const fieldName = tupleType.fields[idx]?.name ?? `_${idx}`
        fieldToVar.set(fieldName, elem.pattern.name)
      }
    }

    // Generate call expression
    const value = exprToWat(stmt.value, ctx)

    // Generate local.set for each field in REVERSE order (WASM stack is LIFO)
    // The tuple fields are pushed in order, so we pop in reverse
    const sets: string[] = []
    for (let i = tupleType.fields.length - 1; i >= 0; i--) {
      const field = tupleType.fields[i]
      const varName = field.name !== null ? fieldToVar.get(field.name) : undefined
      if (varName) {
        sets.push(`(local.set $${varName})`)
      } else {
        // Field not captured by pattern - need to drop it
        sets.push('(drop)')
      }
    }

    return `${value}\n${sets.join('\n')}`
  }

  return ''
}

function setToWat(stmt: AST.SetStmt, ctx: CodegenContext): string {
  const value = exprToWat(stmt.value, ctx)

  if (stmt.pattern.kind === 'IdentPattern') {
    const name = stmt.pattern.name
    const localNames = ctx.locals.get(name)
    if (localNames && localNames.length === 1) {
      return `(local.set $${localNames[0]} ${value})`
    }
    return `(local.set $${name} ${value})`
  }

  if (stmt.pattern.kind === 'TuplePattern') {
    // Get tuple type from the value expression
    const tupleType = ctx.types.get(typeKey(stmt.value.span.start, stmt.value.kind))
    if (!tupleType || tupleType.kind !== 'tuple') {
      throw new Error(`Missing tuple type for set pattern at offset ${stmt.pattern.span.start}`)
    }

    // Build a map from field name to variable name
    const fieldToVar = new Map<string, string>()
    for (const elem of stmt.pattern.elements) {
      if (elem.kind === 'named') {
        fieldToVar.set(elem.field, elem.binding ?? elem.field)
      } else if (elem.pattern.kind === 'IdentPattern') {
        const idx = stmt.pattern.elements.indexOf(elem)
        const fieldName = tupleType.fields[idx]?.name ?? `_${idx}`
        fieldToVar.set(fieldName, elem.pattern.name)
      }
    }

    // Generate local.set for each field in REVERSE order (WASM stack is LIFO)
    const sets: string[] = []
    for (let i = tupleType.fields.length - 1; i >= 0; i--) {
      const field = tupleType.fields[i]
      const varName = field.name !== null ? fieldToVar.get(field.name) : undefined
      if (varName) {
        sets.push(`(local.set $${varName})`)
      } else {
        sets.push('(drop)')
      }
    }

    return `${value}\n${sets.join('\n')}`
  }

  return ''
}

function coerceWasmType(wat: string, fromWt: string, toWt: string, signed: boolean): string {
  if (fromWt === toWt) return wat
  if (fromWt === 'i32' && toWt === 'i64') return `(i64.extend_i32_${signed ? 's' : 'u'} ${wat})`
  if (fromWt === 'i64' && toWt === 'i32') return `(i32.wrap_i64 ${wat})`
  return wat
}

function assignToWat(stmt: AST.AssignmentStmt, ctx: CodegenContext): string {
  const value = exprToWat(stmt.value, ctx)

  // Handle compound assignment operators
  if (stmt.op !== '=') {
    const current = lvalueToWat(stmt.target, ctx)
    // Use target type for the operation, not value type
    const targetKey = stmt.target.kind === 'MemberExpr'
      ? typeKey(stmt.target.span.end, stmt.target.kind)
      : typeKey(stmt.target.span.start, stmt.target.kind)
    const targetType = ctx.types.get(targetKey)
    const valueType = ctx.types.get(typeKey(stmt.value.span.start, stmt.value.kind))
    const type = targetType ?? valueType
    if (!type) {
      throw new Error(`Missing type for assignment at offset ${stmt.target.span.start}`)
    }
    const wt = typeToWasmSingle(type)
    const signed = isSigned(type)

    // Coerce value to target type if needed
    const valueWt = valueType ? typeToWasmSingle(valueType) : wt
    const coercedValue = coerceWasmType(value, valueWt, wt, valueType ? isSigned(valueType) : signed)

    // Shift/rotate amounts must match the value type in wasm
    const isShiftOp = ['<<=', '>>=', '>>>=', '<<<='].includes(stmt.op)
    const rhs = isShiftOp ? coerceWasmType(value, valueWt, wt, false) : coercedValue

    const nv = v128Count(type)
    const ops: Record<string, string> = {
      '+=': nv > 0 ? 'i64x2.add' : `${wt}.add`,
      '-=': nv > 0 ? 'i64x2.sub' : `${wt}.sub`,
      '*=': nv > 0 ? 'i64x2.mul' : `${wt}.mul`,
      '/=': signed ? `${wt}.div_s` : `${wt}.div_u`,
      '%=': signed ? `${wt}.rem_s` : `${wt}.rem_u`,
      '&=': nv > 0 ? 'v128.and' : `${wt}.and`,
      '|=': nv > 0 ? 'v128.or' : `${wt}.or`,
      '^=': nv > 0 ? 'v128.xor' : `${wt}.xor`,
      '<<=': nv > 0 ? 'i64x2.shl' : `${wt}.shl`,
      '>>=': nv > 0 ? (signed ? 'i64x2.shr_s' : 'i64x2.shr_u') : (signed ? `${wt}.shr_s` : `${wt}.shr_u`),
      '>>>=': nv > 0 ? 'i64x2.shr_u' : `${wt}.shr_u`,
      '<<<=': nv > 0 ? 'i64x2.shl' : `${wt}.rotl`,
    }

    const op = ops[stmt.op]
    if (op) {
      const combined = nv > 1
        ? multiV128BinaryOp(nv, op, current, rhs)
        : `(${op} ${current} ${rhs})`
      return assignLvalue(stmt.target, combined, ctx)
    }
  }

  return assignLvalue(stmt.target, value, ctx)
}

function lvalueToWat(target: AST.LValue, ctx: CodegenContext): string {
  if (target.kind === 'IdentExpr') {
    return identToWat(target, ctx)
  }
  if (target.kind === 'MemberExpr') {
    return memberToWat(target, ctx)
  }
  if (target.kind === 'IndexExpr') {
    return indexToWat(target, ctx)
  }
  return ''
}

function assignLvalue(target: AST.LValue, value: string, ctx: CodegenContext): string {
  if (target.kind === 'IdentExpr') {
    const name = target.name
    const localNames = ctx.locals.get(name)
    if (localNames && localNames.length === 1) {
      return `(local.set $${localNames[0]} ${value})`
    }
    if (localNames && localNames.length > 1) {
      const parts = splitV128Components(value, localNames.length)
      return localNames.map((n, i) => `(local.set $${n} ${parts[i]})`).join('\n')
    }
    // Check globals
    const sym = ctx.symbols.get(name)
    if (sym?.kind === 'global') {
      const watName = ctx.nameMap.get(name) ?? name
      return `(global.set $${watName} ${value})`
    }
    return `(local.set $${name} ${value})`
  }

  if (target.kind === 'MemberExpr') {
    // Memory store for struct fields
    const member = target.member
    if (member.kind === 'field' && target.object.kind === 'IdentExpr') {
      const baseName = target.object.name
      const fieldName = member.name
      return `(local.set $${baseName}_${fieldName} ${value})`
    }
    if (member.kind === 'deref') {
      const ptr = exprToWat(target.object, ctx)
      const type = ctx.types.get(typeKey(target.span.end, target.kind)) ?? ctx.types.get(typeKey(target.span.start, target.kind))
      if (!type) {
        throw new Error(`Missing type for pointer store at offset ${target.span.start}`)
      }
      return v128StoreSequence(type, ptr, value)
    }
  }

  if (target.kind === 'IndexExpr') {
    let ptr = exprToWat(target.object, ctx)
    const idx = exprToWat(target.index, ctx)
    const type = ctx.types.get(typeKey(target.span.start, target.kind))
    if (!type) {
      throw new Error(`Missing type for index store at offset ${target.span.start}`)
    }
    // For slice objects, extract just the pointer
    const objTypeKey = target.object.kind === 'MemberExpr'
      ? typeKey(target.object.span.end, target.object.kind)
      : typeKey(target.object.span.start, target.object.kind)
    const objType = ctx.types.get(objTypeKey) ?? ctx.types.get(typeKey(target.object.span.start, target.object.kind))
    if (objType?.kind === 'slice') {
      const parts = splitV128Components(ptr, 2)
      ptr = parts[0]
    }
    const { offset } = indexOffset(target.object, ptr, idx, ctx)
    return v128StoreSequence(type, offset, value)
  }

  return ''
}

function returnToWat(stmt: AST.ReturnStmt, ctx: CodegenContext): string {
  const namedPush = ctx.namedReturnLocals?.length > 0
    ? ctx.namedReturnLocals.join(' ') + ' '
    : ''

  if (stmt.when) {
    const cond = exprToWat(stmt.when, ctx)
    if (stmt.value) {
      const value = exprToWat(stmt.value, ctx)
      return `(if ${cond} (then ${value} (return)))`
    }
    return `(if ${cond} (then ${namedPush}(return)))`
  }

  if (stmt.value) {
    const value = exprToWat(stmt.value, ctx)
    return `${value} (return)`
  }

  return `${namedPush}(return)`
}

function whileToWat(stmt: AST.WhileStmt, ctx: CodegenContext): string {
  const cond = exprToWat(stmt.condition, ctx)
  const body = bodyToWat(stmt.body, ctx)

  return `(block $break
    (loop $continue
      (br_if $break (i32.eqz ${cond}))
      ${body}
      (br $continue)
    )
  )`
}

function loopToWat(stmt: AST.LoopStmt, ctx: CodegenContext): string {
  const body = bodyToWat(stmt.body, ctx)

  return `(block $break
    (loop $continue
      ${body}
      (br $continue)
    )
  )`
}

function forToWat(stmt: AST.ForStmt, ctx: CodegenContext): string {
  // For loops need iterator desugaring
  // for item in iterable { ... }
  // becomes: let i = 0; while i < len { let item = arr[i]; ...; i += 1 }
  const valueName = stmt.binding.value
  const indexName = stmt.binding.index

  ctx.locals.set(valueName, [valueName])
  if (indexName) {
    ctx.locals.set(indexName, [indexName])
  }

  const body = bodyToWat(stmt.body, ctx)

  // Simplified: just emit loop structure
  return `(block $break
    (loop $continue
      ${body}
      (br $continue)
    )
  )`
}

function breakToWat(stmt: AST.BreakStmt, ctx: CodegenContext): string {
  if (stmt.when) {
    const cond = exprToWat(stmt.when, ctx)
    return `(br_if $break ${cond})`
  }
  return '(br $break)'
}

function continueToWat(stmt: AST.ContinueStmt, ctx: CodegenContext): string {
  if (stmt.when) {
    const cond = exprToWat(stmt.when, ctx)
    return `(br_if $continue ${cond})`
  }
  return '(br $continue)'
}

// === Body/Block Codegen ===

function bodyToWat(body: AST.FuncBody, ctx: CodegenContext): string {
  if (body.kind === 'ArrowBody') {
    return exprToWat(body.expr, ctx)
  }
  return body.stmts.map((s) => stmtToWat(s, ctx)).join('\n')
}

// === Function Codegen ===

export function funcToWat(
  decl: AST.FuncDecl,
  checkResult: TypeCheckResult,
  literalRefs: Map<number, { ptr: number; len: number }> = new Map(),
  nameMap?: Map<string, string>,
  watName?: string,
): string {
  const ctx = createContext(checkResult, literalRefs, nameMap)
  const name = decl.ident ?? 'anonymous'

  // Get function type from checker
  const funcType = checkResult.symbols.get(name)
  if (!funcType || funcType.kind !== 'func') {
    throw new Error(`Function ${name} not found in symbols`)
  }

  // Flatten parameters
  const params: string[] = []
  const paramTypes = funcType.type.params
  for (const param of paramTypes) {
    const paramName = param.name
    if (!paramName) continue
    const flattened = flattenType(param.type)
    if (flattened.length === 1 && flattened[0].suffix === '') {
      params.push(`(param $${paramName} ${flattened[0].wasmType})`)
      ctx.params.set(paramName, [paramName])
    } else {
      // Flatten struct/slice params with proper field names
      const names = flattened.map((f) => {
        const fieldName = f.suffix ? `${paramName}_${f.suffix}` : paramName
        params.push(`(param $${fieldName} ${f.wasmType})`)
        return fieldName
      })
      ctx.params.set(paramName, names)
    }
  }

  // Flatten returns and add named returns as locals
  const returnTypes = funcType.type.returns.flatMap((r) => typeToWasm(r.type))
  const resultStr = returnTypes.length > 0 ? `(result ${returnTypes.join(' ')})` : ''

  // Collect locals from body
  const locals = collectLocals(decl.body, ctx, checkResult)

  // Add named returns as locals (they can be assigned in the body)
  const namedReturns: { name: string; types: string[] }[] = []
  for (const ret of funcType.type.returns) {
    if (ret.name) {
      const wasmTypes = typeToWasm(ret.type)
      if (wasmTypes.length === 1) {
        locals.push({ name: ret.name, type: wasmTypes[0] })
        ctx.locals.set(ret.name, [ret.name])
        namedReturns.push({ name: ret.name, types: wasmTypes })
      } else {
        // Unwrap named types to get field names from tuple
        const unwrappedType = unwrap(ret.type)
        const names = wasmTypes.map((wt, i) => {
          // Use actual field names if available from tuple type
          let fieldName: string
          if (unwrappedType.kind === 'tuple' && unwrappedType.fields[i]?.name) {
            fieldName = `${ret.name}_${unwrappedType.fields[i].name}`
          } else {
            fieldName = `${ret.name}_${i}`
          }
          locals.push({ name: fieldName, type: wt })
          return fieldName
        })
        ctx.locals.set(ret.name, names)
        namedReturns.push({ name: ret.name, types: wasmTypes })
      }
    }
  }
  // Make named return locals available for early return statements
  ctx.namedReturnLocals = namedReturns.flatMap(r => {
    const localNames = ctx.locals.get(r.name)
    return localNames ? localNames.map(n => `(local.get $${n})`) : []
  })

  // Deduplicate: skip locals that collide with params or earlier locals
  const seen = new Set<string>()
  for (const [, names] of ctx.params) for (const n of names) seen.add(n)
  const dedupedLocals = locals.filter(l => {
    if (seen.has(l.name)) return false
    seen.add(l.name)
    return true
  })
  const localStr = dedupedLocals.map((l) => `(local $${l.name} ${l.type})`).join('\n  ')

  // Generate body
  const body = bodyToWat(decl.body, ctx)

  // Generate epilogue: push named returns onto stack
  let epilogue = ''
  if (namedReturns.length > 0) {
    const returnGets = namedReturns.flatMap((r) => {
      const localNames = ctx.locals.get(r.name)
      if (localNames) {
        return localNames.map((n) => `(local.get $${n})`)
      }
      return []
    })
    epilogue = returnGets.join('\n  ')
  }

  const paramsStr = params.join(' ')
  const emitName = watName ?? name
  return `(func $${emitName} ${paramsStr} ${resultStr}
  ${localStr}
  ${body}
  ${epilogue}
)`
}

interface LocalDecl {
  name: string
  type: string
}

function collectLocals(
  body: AST.FuncBody,
  ctx: CodegenContext,
  checkResult: TypeCheckResult,
): LocalDecl[] {
  const locals: LocalDecl[] = []

  function visitStmt(stmt: AST.Statement) {
    if (stmt.kind === 'LetStmt') {
      if (stmt.pattern.kind === 'IdentPattern') {
        const name = stmt.pattern.name
        // Type is stored at pattern offset, not statement offset
        const type = checkResult.types.get(typeKey(stmt.pattern.span.start, stmt.pattern.kind))
        if (!type) {
          throw new Error(`Missing type for local '${name}' at offset ${stmt.pattern.span.start}`)
        }
        const wasmTypes = typeToWasm(type)

        if (wasmTypes.length === 1) {
          locals.push({ name, type: wasmTypes[0] })
          ctx.locals.set(name, [name])
        } else {
          const names = wasmTypes.map((wt, i) => {
            const fieldName = `${name}_${i}`
            locals.push({ name: fieldName, type: wt })
            return fieldName
          })
          ctx.locals.set(name, names)
        }
      } else if (stmt.pattern.kind === 'TuplePattern') {
        // Get the overall tuple type from the pattern
        const tupleType = checkResult.types.get(typeKey(stmt.pattern.span.start, stmt.pattern.kind))
        if (!tupleType || tupleType.kind !== 'tuple') {
          throw new Error(`Missing or invalid tuple type for pattern at offset ${stmt.pattern.span.start}`)
        }

        // Declare locals for each tuple pattern element
        for (const elem of stmt.pattern.elements) {
          let name: string
          let fieldName: string
          if (elem.kind === 'named') {
            name = elem.binding ?? elem.field
            fieldName = elem.field
          } else if (elem.pattern.kind === 'IdentPattern') {
            name = elem.pattern.name
            // For positional, use index to find field name
            const idx = stmt.pattern.elements.indexOf(elem)
            fieldName = tupleType.fields[idx]?.name ?? `_${idx}`
          } else {
            continue // Nested patterns not yet supported
          }

          const field = tupleType.fields.find((f) => f.name === fieldName)
          if (!field) continue

          const wasmTypes = typeToWasm(field.type)
          if (wasmTypes.length === 1) {
            locals.push({ name, type: wasmTypes[0] })
            ctx.locals.set(name, [name])
          } else {
            const names = wasmTypes.map((wt, i) => {
              const localName = `${name}_${i}`
              locals.push({ name: localName, type: wt })
              return localName
            })
            ctx.locals.set(name, names)
          }
        }
      }
    }
    // Recurse into nested blocks
    if (stmt.kind === 'WhileStmt') {
      visitBody(stmt.body)
    }
    if (stmt.kind === 'LoopStmt') {
      visitBody(stmt.body)
    }
    if (stmt.kind === 'ForStmt') {
      // Collect loop binding variable
      const bindingType = ctx.types.get(typeKey(stmt.binding.span.start, stmt.binding.kind))
      if (bindingType) {
        const wt = typeToWasmSingle(bindingType)
        locals.push({ name: stmt.binding.value, type: wt })
        ctx.locals.set(stmt.binding.value, [stmt.binding.value])
      }
      if (stmt.binding.index) {
        locals.push({ name: stmt.binding.index, type: 'i32' })
        ctx.locals.set(stmt.binding.index, [stmt.binding.index])
      }
      visitBody(stmt.body)
    }
    // Handle expression statements that may contain if expressions
    if (stmt.kind === 'ExpressionStmt') {
      visitExpr(stmt.expr)
    }
    // Handle assignment statements that may have if expressions on the right side
    if (stmt.kind === 'AssignmentStmt') {
      visitExpr(stmt.value)
    }
  }

  function visitExpr(expr: AST.Expr) {
    if (expr.kind === 'IfExpr') {
      visitBody(expr.thenBranch)
      for (const elif of expr.elifs) {
        visitBody(elif.thenBranch)
      }
      if (expr.else_) {
        visitBody(expr.else_)
      }
    }
    // Recurse into other expression types that may contain blocks
    if (expr.kind === 'GroupExpr') {
      visitExpr(expr.expr)
    }
  }

  function visitBody(b: AST.FuncBody) {
    if (b.kind === 'Block') {
      for (const s of b.stmts) {
        visitStmt(s)
      }
    }
  }

  visitBody(body)
  return locals
}

// === Module Codegen ===

export function moduleToWat(module: AST.Module, checkResult: TypeCheckResult): string {
  // Build data section from collected literals
  const { dataBuilder, literalRefs } = buildDataSection(checkResult.literals)
  const dataSection = dataBuilder.result()

  const ctx = createContext(checkResult, literalRefs)
  const parts: string[] = ['(module']
  let hasMemory = dataSection.totalSize > 0 || hasMemoryDecl(module) || usesMemory(checkResult)

  // Collect imports
  for (const decl of module.decls) {
    if (decl.kind === 'ImportDecl') {
      for (const item of decl.items) {
        parts.push(importItemToWat(decl.module, item, ctx))
      }
    }
  }

  // Add memory if needed
  if (hasMemory) {
    const implicitMin = Math.max(1, Math.ceil(dataSection.totalSize / 65536))
    const memDecl = getMemoryDecl(module)
    const min = memDecl ? (memDecl.min ?? implicitMin) : implicitMin
    const max = memDecl?.max ?? null
    const maxStr = max !== null ? ` ${max}` : ''
    if (memDecl?.exportName) {
      parts.push(`  (memory (export "${memDecl.exportName}") ${min}${maxStr})`)
    } else {
      parts.push(`  (memory ${min}${maxStr})`)
    }
  }

  // Collect function declarations
  for (const decl of module.decls) {
    if (decl.kind === 'FuncDecl') {
      parts.push(funcToWat(decl, checkResult, literalRefs))
    }
    if (decl.kind === 'ExportDecl' && decl.item.kind === 'FuncDecl') {
      parts.push(funcToWat(decl.item, checkResult, literalRefs))
    }
  }

  // Collect globals
  for (const decl of module.decls) {
    if (decl.kind === 'GlobalDecl') {
      parts.push(globalToWat(decl, ctx))
    }
    if (decl.kind === 'ExportDecl' && decl.item.kind === 'GlobalDecl') {
      parts.push(globalToWat(decl.item, ctx))
    }
  }

  // Collect exports (skip memory exports as they're handled inline above)
  for (const decl of module.decls) {
    if (decl.kind === 'ExportDecl' && decl.item.kind !== 'MemoryDecl') {
      parts.push(exportToWat(decl, ctx))
    }
  }

  // Data section
  if (dataSection.totalSize > 0) {
    const dataSegments = dataToWat(dataSection)
    for (const seg of dataSegments) {
      parts.push(`  ${seg}`)
    }
  }

  // Emit helper functions if referenced
  if (parts.some(p => p.includes('$__mul_hi'))) {
    parts.push(MUL_HI_WAT)
  }

  parts.push(')')
  return parts.join('\n')
}

function usesMemory(checkResult: TypeCheckResult): boolean {
  for (const [, type] of checkResult.types) {
    const u = unwrap(type)
    if (u.kind === 'pointer' || u.kind === 'slice') return true
  }
  return false
}

function hasMemoryDecl(module: AST.Module): boolean {
  for (const decl of module.decls) {
    if (decl.kind === 'MemoryDecl') return true
    if (decl.kind === 'ExportDecl' && decl.item.kind === 'MemoryDecl') return true
  }
  return false
}

function getMemoryDecl(module: AST.Module): { exportName: string | null; min: number | null; max: number | null } | null {
  for (const decl of module.decls) {
    if (decl.kind === 'MemoryDecl') {
      return { exportName: null, min: decl.min, max: decl.max }
    }
    if (decl.kind === 'ExportDecl' && decl.item.kind === 'MemoryDecl') {
      return { exportName: decl.name, min: decl.item.min, max: decl.item.max }
    }
  }
  return null
}

function importItemToWat(moduleName: string, item: AST.ImportItem, _ctx: CodegenContext): string {
  const imp = item.item

  if (imp.kind === 'ImportFunc') {
    const name = imp.ident ?? item.name
    // Get function type from signature
    const params: string[] = []
    const results: string[] = []

    // Parse input type for params
    if (imp.signature.input.kind === 'CompositeType') {
      for (const field of imp.signature.input.fields) {
        const wasmTypes = typeToWasm(resolveAstType(field.type))
        if (field.ident) {
          for (const wt of wasmTypes) {
            params.push(`(param $${field.ident} ${wt})`)
          }
        } else {
          for (const wt of wasmTypes) {
            params.push(`(param ${wt})`)
          }
        }
      }
    }

    // Parse output type for results
    if (imp.signature.output.kind === 'CompositeType') {
      for (const field of imp.signature.output.fields) {
        const wasmTypes = typeToWasm(resolveAstType(field.type))
        for (const wt of wasmTypes) {
          results.push(wt)
        }
      }
    } else {
      const wasmTypes = typeToWasm(resolveAstType(imp.signature.output))
      for (const wt of wasmTypes) {
        results.push(wt)
      }
    }

    const paramsStr = params.join(' ')
    const resultsStr = results.length > 0 ? `(result ${results.join(' ')})` : ''

    return `  (import "${moduleName}" "${item.name}" (func $${name} ${paramsStr} ${resultsStr}))`
  }

  if (imp.kind === 'ImportGlobal') {
    const wasmType = typeToWasmSingle(resolveAstType(imp.type))
    return `  (import "${moduleName}" "${item.name}" (global $${imp.ident} ${wasmType}))`
  }

  return ''
}

function globalToWat(decl: AST.GlobalDecl, ctx: CodegenContext): string {
  const name = patternIdent(decl.pattern)
  const watName = ctx.nameMap.get(name) ?? name
  const type = ctx.types.get(typeKey(decl.pattern.span.start, decl.pattern.kind))
  if (!type) {
    throw new Error(`Missing type for global '${name}' at offset ${decl.span.start}`)
  }
  const wasmType = typeToWasmSingle(type)
  const init = decl.value ? exprToWat(decl.value, ctx) : `(${wasmType}.const 0)`

  return `  (global $${watName} (mut ${wasmType}) ${init})`
}

function exportToWat(decl: AST.ExportDecl, ctx: CodegenContext): string {
  const name = decl.name
  const item = decl.item

  if (item.kind === 'FuncDecl') {
    const funcName = item.ident ?? 'anonymous'
    const watName = ctx.nameMap.get(funcName) ?? funcName
    return `  (export "${name}" (func $${watName}))`
  }

  if (item.kind === 'GlobalDecl') {
    const globalName = patternIdent(item.pattern)
    const watName = ctx.nameMap.get(globalName) ?? globalName
    return `  (export "${name}" (global $${watName}))`
  }

  if (item.kind === 'MemoryDecl') {
    return `  (export "${name}" (memory 0))`
  }

  return ''
}

function patternIdent(pattern: AST.Pattern): string {
  if (pattern.kind === 'IdentPattern') return pattern.name
  throw new Error('global destructuring is not supported yet')
}

// Helper to convert AST type to resolved type (simplified)
function resolveAstType(type: AST.Type): ResolvedType {
  switch (type.kind) {
    case 'PrimitiveType':
      return { kind: 'primitive', name: type.name }
    case 'PointerType':
      return { kind: 'pointer', pointee: resolveAstType(type.pointee) }
    case 'IndexedType': {
      const element = resolveAstType(type.element)
      // Slice: []T (size is null, not many-pointer)
      if (type.size === null && !type.manyPointer) {
        return { kind: 'slice', element }
      }
      // Array: [N]T, [_]T, [*]T, etc.
      let sizes: RT.ArraySize[] | null = null
      if (type.size === null && type.manyPointer) {
        // Many-pointer [*]T - null sizes
        sizes = null
      } else if (type.size === 'inferred') {
        sizes = ['_']
      } else if (typeof type.size === 'number') {
        sizes = [type.size]
      } else if (Array.isArray(type.size)) {
        sizes = type.size
      }
      return { kind: 'array', element, sizes }
    }
    case 'CompositeType':
      return {
        kind: 'tuple',
        fields: type.fields.map((f) => ({
          name: f.ident,
          type: resolveAstType(f.type),
        })),
      }
    case 'FuncType':
      return {
        kind: 'func',
        params: typeToFields(resolveAstType(type.input)),
        returns: typeToFields(resolveAstType(type.output)),
      }
    default:
      return { kind: 'void' }
  }
}

const MUL_HI_WAT = `(func $__mul_hi (param $a i64) (param $b i64) (result i64)
  (local $al i64) (local $ah i64) (local $bl i64) (local $bh i64) (local $t i64) (local $u i64)
  (local.set $al (i64.and (local.get $a) (i64.const 4294967295)))
  (local.set $ah (i64.shr_u (local.get $a) (i64.const 32)))
  (local.set $bl (i64.and (local.get $b) (i64.const 4294967295)))
  (local.set $bh (i64.shr_u (local.get $b) (i64.const 32)))
  (local.set $t (i64.shr_u (i64.mul (local.get $al) (local.get $bl)) (i64.const 32)))
  (local.set $t (i64.add (local.get $t) (i64.mul (local.get $ah) (local.get $bl))))
  (local.set $u (i64.add (i64.and (local.get $t) (i64.const 4294967295)) (i64.mul (local.get $al) (local.get $bh))))
  (i64.add (i64.add (i64.shr_u (local.get $t) (i64.const 32)) (i64.shr_u (local.get $u) (i64.const 32))) (i64.mul (local.get $ah) (local.get $bh)))
)`

function typeToFields(t: ResolvedType): ResolvedField[] {
  if (t.kind === 'void') return []
  if (t.kind === 'tuple') return t.fields
  return [{ name: null, type: t }]
}

// === Multi-module Codegen ===

import { basename } from 'path'

function modulePrefix(filePath: string): string {
  return basename(filePath, '.ents').replace(/[^a-zA-Z0-9_]/g, '_')
}

export function programToWat(
  modules: Map<string, LoadedModule>,
  checkResults: Map<string, TypeCheckResult>,
  entryPath: string,
): string {
  // Build name map: for each module, collect function/global names and mangle them
  const nameMap = new Map<string, string>()
  const allLiterals: import('./checker').PendingLiteral[] = []

  // Collect all literals for a unified data section
  for (const [path, result] of checkResults) {
    allLiterals.push(...result.literals)
  }
  const { dataBuilder, literalRefs: globalLiteralRefs } = buildDataSection(allLiterals)
  const dataSection = dataBuilder.result()

  // Build per-module name mappings
  const perModuleNameMap = new Map<string, Map<string, string>>()
  for (const [path, loaded] of modules) {
    const prefix = path === entryPath ? '' : modulePrefix(path)
    const modNameMap = new Map<string, string>()
    for (const decl of loaded.module.decls) {
      if (decl.kind === 'FuncDecl' && decl.ident) {
        const mangled = prefix ? `${prefix}$${decl.ident}` : decl.ident
        modNameMap.set(decl.ident, mangled)
      }
      if (decl.kind === 'ExportDecl' && decl.item.kind === 'FuncDecl' && decl.item.ident) {
        const mangled = prefix ? `${prefix}$${decl.item.ident}` : decl.item.ident
        modNameMap.set(decl.item.ident, mangled)
      }
      if (decl.kind === 'GlobalDecl' && decl.pattern.kind === 'IdentPattern') {
        const mangled = prefix ? `${prefix}$${decl.pattern.name}` : decl.pattern.name
        modNameMap.set(decl.pattern.name, mangled)
      }
      if (decl.kind === 'ExportDecl' && decl.item.kind === 'GlobalDecl' && decl.item.pattern.kind === 'IdentPattern') {
        const mangled = prefix ? `${prefix}$${decl.item.pattern.name}` : decl.item.pattern.name
        modNameMap.set(decl.item.pattern.name, mangled)
      }
    }
    perModuleNameMap.set(path, modNameMap)
  }

  // Build the full name map for each module: includes own mangled names + imported names resolved to their source's mangled names
  function buildFullNameMap(path: string): Map<string, string> {
    const full = new Map<string, string>()
    const own = perModuleNameMap.get(path)
    if (own) for (const [k, v] of own) full.set(k, v)

    const loaded = modules.get(path)
    if (!loaded) return full
    for (const decl of loaded.module.decls) {
      if (decl.kind !== 'ImportDecl' || !isSourceImport(decl.module)) continue
      const depPath = resolveModulePath(decl.module, path)
      const depNames = perModuleNameMap.get(depPath)
      if (!depNames) continue
      for (const item of decl.items) {
        if (item.item.kind === 'ImportFunc') {
          const localName = item.item.ident ?? item.name
          const mangled = depNames.get(item.name)
          if (mangled) full.set(localName, mangled)
        }
        if (item.item.kind === 'ImportGlobal') {
          const mangled = depNames.get(item.name)
          if (mangled) full.set(item.item.ident, mangled)
        }
      }
    }
    return full
  }

  const parts: string[] = ['(module']

  // Emit host imports (only from entry module for now, but could be from any)
  for (const [path, loaded] of modules) {
    const result = checkResults.get(path)
    if (!result) continue
    const modNameMap = buildFullNameMap(path)
    const ctx = createContext(result, globalLiteralRefs, modNameMap)
    for (const decl of loaded.module.decls) {
      if (decl.kind === 'ImportDecl' && !isSourceImport(decl.module)) {
        for (const item of decl.items) {
          parts.push(importItemToWat(decl.module, item, ctx))
        }
      }
    }
  }

  // Memory — at most one declaration program-wide
  let hasMemory = dataSection.totalSize > 0 || [...checkResults.values()].some(r => usesMemory(r))
  let memDecl: { exportName: string | null; min: number | null; max: number | null } | null = null
  let memDeclModule: string | null = null
  for (const [path, loaded] of modules) {
    if (hasMemoryDecl(loaded.module)) {
      if (memDeclModule !== null) {
        throw new Error(
          `Multiple memory declarations: '${basename(memDeclModule)}' and '${basename(path)}'. ` +
          `At most one module may declare memory.`
        )
      }
      hasMemory = true
      memDecl = getMemoryDecl(loaded.module)
      memDeclModule = path
    }
  }
  if (hasMemory) {
    const implicitMin = Math.max(1, Math.ceil(dataSection.totalSize / 65536))
    const min = memDecl ? (memDecl.min ?? implicitMin) : implicitMin
    const max = memDecl?.max ?? null
    const maxStr = max !== null ? ` ${max}` : ''
    if (memDecl?.exportName) {
      parts.push(`  (memory (export "${memDecl.exportName}") ${min}${maxStr})`)
    } else {
      parts.push(`  (memory ${min}${maxStr})`)
    }
  }

  // Emit functions from all modules
  for (const [path, loaded] of modules) {
    const result = checkResults.get(path)
    if (!result) continue
    const modNameMap = buildFullNameMap(path)
    for (const decl of loaded.module.decls) {
      if (decl.kind === 'FuncDecl' && decl.ident) {
        const watName = modNameMap.get(decl.ident) ?? decl.ident
        parts.push(funcToWat(decl, result, globalLiteralRefs, modNameMap, watName))
      }
      if (decl.kind === 'ExportDecl' && decl.item.kind === 'FuncDecl' && decl.item.ident) {
        const watName = modNameMap.get(decl.item.ident) ?? decl.item.ident
        parts.push(funcToWat(decl.item, result, globalLiteralRefs, modNameMap, watName))
      }
    }
  }

  // Emit globals from all modules
  for (const [path, loaded] of modules) {
    const result = checkResults.get(path)
    if (!result) continue
    const modNameMap = buildFullNameMap(path)
    const ctx = createContext(result, globalLiteralRefs, modNameMap)
    for (const decl of loaded.module.decls) {
      if (decl.kind === 'GlobalDecl') {
        parts.push(globalToWat(decl, ctx))
      }
      if (decl.kind === 'ExportDecl' && decl.item.kind === 'GlobalDecl') {
        parts.push(globalToWat(decl.item, ctx))
      }
    }
  }

  // Exports — only from entry module
  const entryModule = modules.get(entryPath)
  if (entryModule) {
    const entryNameMap = buildFullNameMap(entryPath)
    const entryResult = checkResults.get(entryPath)!
    const ctx = createContext(entryResult, globalLiteralRefs, entryNameMap)
    for (const decl of entryModule.module.decls) {
      if (decl.kind === 'ExportDecl' && decl.item.kind !== 'MemoryDecl') {
        parts.push(exportToWat(decl, ctx))
      }
    }
  }

  // Data section
  if (dataSection.totalSize > 0) {
    for (const seg of dataToWat(dataSection)) {
      parts.push(`  ${seg}`)
    }
  }

  if (parts.some(p => p.includes('$__mul_hi'))) {
    parts.push(MUL_HI_WAT)
  }

  parts.push(')')
  return parts.join('\n')
}
