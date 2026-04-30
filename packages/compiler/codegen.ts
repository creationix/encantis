// WebAssembly Text (WAT) code generator for Encantis
// Generates S-expression format WAT from AST + TypeCheckResult

import type * as AST from './ast'
import { typeKey, exprTypeOffset, type TypeCheckResult, type ProgramCheckResult, type Symbol as CheckSymbol } from './checker'
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
  totalElements,
} from './types'
import * as RT from './types'
import { dataToWat, buildDataSection } from './data-pack'

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
      if (['i8', 'i16', 'u8', 'u16', 'i32', 'u32', 'bool'].includes(u.name)) {
        return ['i32']
      }
      if (['i64', 'u64'].includes(u.name)) {
        return ['i64']
      }
      if (u.name === 'f32') return ['f32']
      if (u.name === 'f64') return ['f64']
      // Large integers: flatten to multiple i64 values
      const size = primitiveByteSize(u)
      if (size !== null && size >= 16) {
        return Array(size / 8).fill('i64')
      }
      throw new Error(`Unknown primitive type: ${u.name}`)
    }

    case 'pointer':
      return ['i32'] // Pointers are i32 indices

    case 'slice':
      // Slices are fat pointers: (ptr, len)
      return ['i32', 'i32']

    case 'array':
      if (u.sizes && u.sizes.length === 1 && typeof u.sizes[0] === 'number') {
        const elemTypes = typeToWasm(u.element)
        return Array(u.sizes[0]).fill(elemTypes).flat()
      }
      // Non-value arrays (many-pointer, framed) are pointers
      return ['i32']

    case 'comptime_array': {
      const elemTypes = typeToWasm(u.element)
      return Array(u.count).fill(elemTypes).flat()
    }

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
      if (u.sizes && u.sizes.length === 1 && typeof u.sizes[0] === 'number') {
        const n = u.sizes[0]
        const nested = flattenType(u.element)
        return Array.from({ length: n }, (_, i) => {
          if (nested.length === 1 && nested[0].suffix === '') {
            return { suffix: String(i), wasmType: nested[0].wasmType }
          }
          return nested.map(f => ({
            suffix: `${i}_${f.suffix}`,
            wasmType: f.wasmType,
          }))
        }).flat()
      }
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
      const np = wideIntParts(type)
      if (np > 0) {
        const val = BigInt(lit.value)
        const parts: string[] = []
        for (let i = 0; i < np; i++) {
          parts.push(`(i64.const ${BigInt.asIntN(64, (val >> BigInt(i * 64)) & 0xFFFFFFFFFFFFFFFFn)})`)
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

    case 'string': {
      const id = (expr as any).dataId ?? expr.span.start
      const ref = ctx.literalRefs.get(id)
      if (ref) {
        const type = ctx.types.get(typeKey(expr.span.start, expr.kind))
        if (type?.kind === 'slice') {
          return `(i32.const ${ref.ptr}) (i32.const ${ref.len})`
        }
        return `(i32.const ${ref.ptr})`
      }
      return `(i32.const 0)`
    }
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
        return `(i32.const 0)`
      }
    }
  }

  // Unknown - emit error comment
  return `(i32.const 0)`
}

function truncateSubWord(wat: string, type: ResolvedType): string {
  const u = unwrap(type)
  if (u.kind !== 'primitive') return wat
  if (u.name === 'u8') return `(i32.and ${wat} (i32.const 255))`
  if (u.name === 'i8') return `(i32.shr_s (i32.shl ${wat} (i32.const 24)) (i32.const 24))`
  if (u.name === 'u16') return `(i32.and ${wat} (i32.const 65535))`
  if (u.name === 'i16') return `(i32.shr_s (i32.shl ${wat} (i32.const 16)) (i32.const 16))`
  return wat
}

function isWideInt(t: ResolvedType): boolean {
  const u = unwrap(t)
  if (u.kind !== 'primitive') return false
  const size = primitiveByteSize(u)
  return size !== null && size >= 16
}

function wideIntParts(t: ResolvedType): number {
  const u = unwrap(t)
  if (u.kind !== 'primitive') return 0
  const size = primitiveByteSize(u)
  if (size !== null && size >= 16) return size / 8
  return 0
}

function multiV128BinaryOp(n: number, wasmOp: string, left: string, right: string): string {
  if (n === 1) return `(${wasmOp} ${left} ${right})`
  const leftParts = splitV128Components(left, n)
  const rightParts = splitV128Components(right, n)
  return leftParts.map((l, i) => `(${wasmOp} ${l} ${rightParts[i]})`).join(' ')
}

function multiV128UnaryOp(n: number, wasmOp: string, operand: string, constant?: string): string {
  if (n === 1) return constant ? `(${wasmOp} ${constant} ${operand})` : `(${wasmOp} ${operand})`
  const parts = splitV128Components(operand, n)
  return parts.map(p => constant ? `(${wasmOp} ${constant} ${p})` : `(${wasmOp} ${p})`).join(' ')
}

function loadFromMemory(type: ResolvedType, ptr: string): string {
  const nw = wideIntParts(type)
  if (nw > 0) {
    return Array.from({ length: nw }, (_, i) =>
      `(i64.load offset=${i * 8} ${ptr})`
    ).join(' ')
  }
  const u = unwrap(type)
  // Slice: load ptr + len (two i32s) — same layout as tuple (ptr, len)
  if (u.kind === 'slice') {
    return `(i32.load ${ptr}) (i32.load offset=4 ${ptr})`
  }
  if (u.kind === 'primitive') {
    if (u.name === 'u8') return `(i32.load8_u ${ptr})`
    if (u.name === 'i8') return `(i32.load8_s ${ptr})`
    if (u.name === 'u16') return `(i32.load16_u ${ptr})`
    if (u.name === 'i16') return `(i32.load16_s ${ptr})`
  }
  const wt = typeToWasmSingle(type)
  return `(${wt}.load ${ptr})`
}

function storeToMemory(type: ResolvedType, ptr: string, value: string): string {
  const nw = wideIntParts(type)
  if (nw > 0) {
    const parts = splitV128Components(value, nw)
    return parts.map((v, i) =>
      `(i64.store offset=${i * 8} ${ptr} ${v})`
    ).join('\n')
  }
  const u = unwrap(type)
  if (u.kind === 'slice') {
    const parts = splitV128Components(value, 2)
    return `(i32.store ${ptr} ${parts[0]})\n(i32.store offset=4 ${ptr} ${parts[1]})`
  }
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

function lookupExprType(expr: { kind: string; span: { start: number; end: number } }, ctx: CodegenContext): ResolvedType | undefined {
  return ctx.types.get(typeKey(exprTypeOffset(expr), expr.kind))
    ?? ctx.types.get(typeKey(expr.span.start, expr.kind))
    ?? ctx.types.get(typeKey(expr.span.end, expr.kind))
}

function resolveExprType(expr: AST.Expr, ctx: CodegenContext): ResolvedType | undefined {
  // Try direct lookup — MemberExpr and BinaryExpr use span.end to avoid collisions
  const key = (expr.kind === 'MemberExpr' || expr.kind === 'BinaryExpr')
    ? typeKey(expr.span.end, expr.kind)
    : typeKey(expr.span.start, expr.kind)
  const direct = ctx.types.get(key)
  if (direct) return direct

  // For expressions that may collide with parent (same start offset),
  // try looking up based on span end
  const byEnd = ctx.types.get(typeKey(expr.span.end, expr.kind))
  if (byEnd) return byEnd

  if (expr.kind === 'IdentExpr') {
    const sym = ctx.symbols.get(expr.name)
    if (sym && sym.kind !== 'func' && sym.kind !== 'type') return sym.type
  }

  // For binary expressions whose type collided with parent, infer from children
  if (expr.kind === 'BinaryExpr') {
    const lt = resolveExprType(expr.left, ctx)
    if (lt && !['==', '!=', '<', '>', '<=', '>=', '&&', '||'].includes(expr.op)) {
      return lt
    }
  }

  return undefined
}

function widenToWide(wat: string, fromType: ResolvedType | undefined, toParts: number): string {
  const fromParts = fromType ? wideIntParts(fromType) : 0
  if (fromParts >= toParts) return wat
  if (fromParts === 0) {
    const fromWt = fromType ? typeToWasmSingle(fromType) : 'i32'
    const first = fromWt === 'i64' ? wat : `(i64.extend_i32_u ${wat})`
    const zeros = Array(toParts - 1).fill('(i64.const 0)').join(' ')
    return `${first} ${zeros}`
  }
  const parts = splitV128Components(wat, fromParts)
  while (parts.length < toParts) parts.push('(i64.const 0)')
  return parts.join(' ')
}

function binaryToWat(expr: AST.BinaryExpr, ctx: CodegenContext): string {
  let left = exprToWat(expr.left, ctx)
  let right = exprToWat(expr.right, ctx)

  // Get result type from checker
  const resultType = lookupExprType(expr, ctx)
  if (!resultType) {
    throw new Error(`Missing type for binary expression at offset ${expr.span.start}`)
  }

  // For comparison ops, we need the operand type for signedness (result is bool)
  // For arithmetic ops, use the result type (which is the wider operand type)
  let leftType = lookupExprType(expr.left, ctx)
  if (leftType?.kind === 'tuple' && leftType.fields.length === 1) leftType = leftType.fields[0].type
  let rightType = lookupExprType(expr.right, ctx)
  if (rightType?.kind === 'tuple' && rightType.fields.length === 1) rightType = rightType.fields[0].type
  const isComparison = ['==', '!=', '<', '>', '<=', '>='].includes(expr.op)
  let operandType: ResolvedType
  if (isComparison) {
    const lSize = leftType ? primitiveByteSize(unwrap(leftType)) ?? 0 : 0
    const rSize = rightType ? primitiveByteSize(unwrap(rightType)) ?? 0 : 0
    operandType = rSize > lSize ? (rightType ?? resultType) : (leftType ?? resultType)
  } else {
    operandType = resultType
  }
  // Unwrap 1-element tuple from parenthesized expressions
  if (operandType.kind === 'tuple' && operandType.fields.length === 1) {
    operandType = operandType.fields[0].type
  }

  const wt = typeToWasmSingle(operandType)
  const signed = isSigned(operandType)
  const isFloatType = isFloat(operandType)
  const nWide = wideIntParts(operandType)

  // Widen operands if they have fewer i64 parts than the operation requires
  if (nWide > 0) {
    if (leftType && wideIntParts(leftType) < nWide) left = widenToWide(left, leftType, nWide)
    if (rightType && wideIntParts(rightType) < nWide) right = widenToWide(right, rightType, nWide)
  }

  const op = expr.op
  let wasmOp: string

  switch (op) {
    // Arithmetic
    case '+':
      wasmOp = nWide > 0 ? 'i64.add' : `${wt}.add`
      break
    case '-':
      wasmOp = nWide > 0 ? 'i64.sub' : `${wt}.sub`
      break
    case '*':
      wasmOp = nWide > 0 ? 'i64.mul' : `${wt}.mul`
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
      if (nWide > 0) {
        const lp = splitV128Components(left, nWide)
        const rp = splitV128Components(right, nWide)
        let eq = `(i64.eq ${lp[0]} ${rp[0]})`
        for (let i = 1; i < nWide; i++) {
          eq = `(i32.and ${eq} (i64.eq ${lp[i]} ${rp[i]}))`
        }
        return eq
      }
      wasmOp = `${wt}.eq`
      break
    case '!=':
      if (nWide > 0) {
        const lp = splitV128Components(left, nWide)
        const rp = splitV128Components(right, nWide)
        let neq = `(i64.eq ${lp[0]} ${rp[0]})`
        for (let i = 1; i < nWide; i++) {
          neq = `(i32.and ${neq} (i64.eq ${lp[i]} ${rp[i]}))`
        }
        return `(i32.eqz ${neq})`
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
      wasmOp = nWide > 0 ? 'i64.and' : `${wt}.and`
      break
    case '|':
      wasmOp = nWide > 0 ? 'i64.or' : `${wt}.or`
      break
    case '^':
      wasmOp = nWide > 0 ? 'i64.xor' : `${wt}.xor`
      break
    case '<<':
      wasmOp = nWide > 0 ? 'i64.shl' : `${wt}.shl`
      break
    case '>>':
      wasmOp = nWide > 0 ? (signed ? 'i64.shr_s' : 'i64.shr_u') : (signed ? `${wt}.shr_s` : `${wt}.shr_u`)
      break
    case '>>>':
      wasmOp = nWide > 0 ? 'i64.shr_u' : `${wt}.shr_u`
      break
    case '<<<':
      wasmOp = nWide > 0 ? 'i64.shl' : `${wt}.rotl`
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

  const rightWt = rightType ? typeToWasmSingle(rightType) : wt
  const rightSigned = rightType ? isSigned(rightType) : signed
  const coercedRight = coerceWasmType(right, rightWt, wt, rightSigned)

  if (nWide > 1) return multiV128BinaryOp(nWide, wasmOp, coercedLeft, coercedRight)
  const raw = `(${wasmOp} ${coercedLeft} ${coercedRight})`
  return truncateSubWord(raw, operandType)
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
      const nw = wideIntParts(type)
      if (nw > 0) {
        const parts = splitV128Components(operand, nw)
        return parts.map(p => `(i64.sub (i64.const 0) ${p})`).join(' ')
      }
      return truncateSubWord(`(${wt}.sub (${wt}.const 0) ${operand})`, type)
    }

    case '~': {
      // Bitwise NOT
      const nw = wideIntParts(type)
      if (nw > 0) {
        const parts = splitV128Components(operand, nw)
        return parts.map(p => `(i64.xor ${p} (i64.const -1))`).join(' ')
      }
      return truncateSubWord(`(${wt}.xor ${operand} (${wt}.const -1))`, type)
    }

    case '!':
      // Logical NOT: x == 0
      return `(i32.eqz ${operand})`

    case '&': {
      // If operand is already a pointer, just return it
      const innerType = lookupExprType(expr.operand, ctx)
      if (innerType && (innerType.kind === 'pointer' || innerType.kind === 'slice')) {
        return operand
      }
      // Anonymous data allocation: look up data section ref
      const innerExpr = expr.operand.kind === 'AnnotationExpr' ? (expr.operand as AST.AnnotationExpr).expr : expr.operand
      const dataId = (innerExpr as { dataId?: number }).dataId ?? innerExpr.span.start
      const ref = ctx.literalRefs.get(dataId)
      if (ref) {
        return `(i32.const ${ref.ptr})`
      }
      return operand
    }

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
      const innerArray = argType?.kind === 'array' ? argType
        : (argType?.kind === 'pointer' && argType.pointee.kind === 'array') ? argType.pointee
        : null
      if (innerArray && paramType.kind === 'slice') {
        const len = totalElements(innerArray.sizes)
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

function lvalueAddressOf(expr: AST.Expr, ctx: CodegenContext): string | null {
  if (expr.kind === 'IndexExpr') {
    const objType = lookupExprType(expr.object, ctx)
    if (!objType) return null
    if (objType.kind === 'slice') {
      const elemSize = byteSize(objType.element)
      if (elemSize === null) return null
      const base = exprToWat(expr.object, ctx)
      const ptr = splitV128Components(base, 2)[0]
      const idx = exprToWat(expr.index, ctx)
      if (elemSize === 1) return `(i32.add ${ptr} ${idx})`
      return `(i32.add ${ptr} (i32.mul ${idx} (i32.const ${elemSize})))`
    }
    if (objType.kind === 'pointer' && objType.pointee.kind === 'array') {
      const elemSize = byteSize(objType.pointee.element) ?? 1
      const base = exprToWat(expr.object, ctx)
      const idx = exprToWat(expr.index, ctx)
      if (elemSize === 1) return `(i32.add ${base} ${idx})`
      return `(i32.add ${base} (i32.mul ${idx} (i32.const ${elemSize})))`
    }
  }
  if (expr.kind === 'MemberExpr' && expr.member.kind === 'deref') {
    return exprToWat(expr.object, ctx)
  }
  return null
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
    // Supports chained access: r.origin.x → local.get $r_origin_x
    const chain = resolveFieldChain(expr.object, member.name)
    if (chain) {
      const localNames = ctx.locals.get(chain.root) ?? ctx.params.get(chain.root)
      if (localNames) {
        const wasmName = `${chain.root}_${chain.path}`
        if (localNames.includes(wasmName)) {
          return `(local.get $${wasmName})`
        }
        // Field might expand to multiple locals (nested struct)
        const prefix = `${wasmName}_`
        const matching = localNames.filter(n => n === wasmName || n.startsWith(prefix))
        if (matching.length > 0) {
          return matching.map(n => `(local.get $${n})`).join(' ')
        }
      }
    }

    // Field access on memory-backed expression (e.g., iovecs[0].len)
    const memObjType = lookupExprType(expr.object, ctx)
    if (memObjType) {
      const fieldOff = RT.fieldByteOffset(memObjType, member.name)
      if (fieldOff !== null) {
        const addr = lvalueAddressOf(expr.object, ctx)
        if (addr !== null) {
          const fieldType = lookupExprType(expr, ctx)
          if (fieldType) {
            const fieldAddr = fieldOff === 0 ? addr : `(i32.add ${addr} (i32.const ${fieldOff}))`
            return loadFromMemory(fieldType, fieldAddr)
          }
        }
      }
    }

    const base = exprToWat(expr.object, ctx)
    return base
  }

  if (member.kind === 'index') {
    // Tuple positional access: .0, .1, etc.
    const chain = resolveFieldChain(expr.object, String(member.value))
    if (chain) {
      const localNames = ctx.locals.get(chain.root) ?? ctx.params.get(chain.root)
      if (localNames) {
        const wasmName = `${chain.root}_${chain.path}`
        if (localNames.includes(wasmName)) {
          return `(local.get $${wasmName})`
        }
        const prefix = `${wasmName}_`
        const matching = localNames.filter(n => n === wasmName || n.startsWith(prefix))
        if (matching.length > 0) {
          return matching.map(n => `(local.get $${n})`).join(' ')
        }
      }
    }
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
    return loadFromMemory(type, ptr)
  }

  if (member.kind === 'type') {
    // Type pun: ptr.u64 → reinterprets the pointer, no load
    // The result is a many-pointer [*]T — actual loads happen at index/deref
    return exprToWat(expr.object, ctx)
  }

  return exprToWat(expr.object, ctx)
}

function resolveFieldChain(expr: AST.Expr, field: string): { root: string; path: string } | null {
  if (expr.kind === 'IdentExpr') {
    return { root: expr.name, path: field }
  }
  if (expr.kind === 'MemberExpr' && expr.member.kind === 'field') {
    const inner = resolveFieldChain(expr.object, expr.member.name)
    if (inner) return { root: inner.root, path: `${inner.path}_${field}` }
  }
  if (expr.kind === 'MemberExpr' && expr.member.kind === 'index') {
    const inner = resolveFieldChain(expr.object, String(expr.member.value))
    if (inner) return { root: inner.root, path: `${inner.path}_${field}` }
  }
  return null
}

function indexOffset(object: AST.Expr, base: string, index: string, ctx: CodegenContext): { offset: string; elemSize: number } {
  const arrayTypeKey = object.kind === 'MemberExpr'
    ? typeKey(object.span.end, object.kind)
    : typeKey(object.span.start, object.kind)
  const arrayType = ctx.types.get(arrayTypeKey) ?? ctx.types.get(typeKey(object.span.start, object.kind))
  let elemSize = 1
  if (arrayType) {
    if (arrayType.kind === 'slice' || arrayType.kind === 'array') {
      elemSize = byteSize(arrayType.element) ?? 1
    } else if (arrayType.kind === 'pointer' && arrayType.pointee.kind === 'array') {
      // Multi-dim *[N,M]T: stride is the full inner dimension size, not just the element
      const innerArray = arrayType.pointee
      if (innerArray.sizes && innerArray.sizes.length > 1) {
        const innerSizes = innerArray.sizes.slice(1)
        const innerTotal = innerSizes.reduce((a: number, b) => a * (typeof b === 'number' ? b : 1), 1)
        elemSize = (byteSize(innerArray.element) ?? 1) * innerTotal
      } else {
        elemSize = byteSize(innerArray.element) ?? 1
      }
    } else if (arrayType.kind === 'pointer') {
      elemSize = byteSize(arrayType.pointee) ?? 1
    }
  }
  const offset = elemSize === 1
    ? `(i32.add ${base} ${index})`
    : `(i32.add ${base} (i32.mul ${index} (i32.const ${elemSize})))`
  return { offset, elemSize }
}

function indexToWat(expr: AST.IndexExpr, ctx: CodegenContext): string {
  // Value array [N]T: index with comptime constant → local.get
  const objTypeKey = expr.object.kind === 'MemberExpr'
    ? typeKey(expr.object.span.end, expr.object.kind)
    : typeKey(expr.object.span.start, expr.object.kind)
  const objType = ctx.types.get(objTypeKey) ?? ctx.types.get(typeKey(expr.object.span.start, expr.object.kind))
  if (objType?.kind === 'array' && objType.sizes && objType.sizes.length === 1 && typeof objType.sizes[0] === 'number') {
    const idx = evalComptimeIndex(expr.index)
    if (idx !== null && expr.object.kind === 'IdentExpr') {
      const localNames = ctx.locals.get(expr.object.name) ?? ctx.params.get(expr.object.name)
      if (localNames) {
        const elemFlat = flattenType(objType.element)
        const base = idx * elemFlat.length
        if (elemFlat.length === 1) {
          return `(local.get $${localNames[base]})`
        }
        return elemFlat.map((_, j) => `(local.get $${localNames[base + j]})`).join(' ')
      }
    }
  }

  let base = exprToWat(expr.object, ctx)
  const index = exprToWat(expr.index, ctx)
  // For slice objects, extract just the pointer (first component)
  if (objType?.kind === 'slice') {
    const parts = splitV128Components(base, 2)
    base = parts[0]
  }
  const { offset } = indexOffset(expr.object, base, index, ctx)

  // Get result type
  const type = lookupExprType(expr, ctx)
  if (!type) {
    throw new Error(`Missing type for index expression at offset ${expr.span.start}`)
  }
  // Multi-dim indexing returns a pointer — just compute address, don't load
  if (type.kind === 'pointer') return offset
  return loadFromMemory(type, offset)
}

function evalComptimeIndex(expr: AST.Expr): number | null {
  if (expr.kind === 'LiteralExpr' && expr.value.kind === 'int') {
    return Number(expr.value.value)
  }
  if (expr.kind === 'AnnotationExpr') return evalComptimeIndex(expr.expr)
  return null
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
  const fromType = lookupExprType(expr.expr, ctx)
  const toType = lookupExprType(expr, ctx)

  if (!fromType || !toType) return inner

  const fromWasm = typeToWasmSingle(fromType)
  const toWasm = typeToWasmSingle(toType)

  if (fromWasm === toWasm) {
    // Same wasm type but different source types — may need masking for sub-word narrowing
    const toU = unwrap(toType)
    if (toU.kind === 'primitive') {
      if (toU.name === 'u8') return `(i32.and ${inner} (i32.const 255))`
      if (toU.name === 'i8') return `(i32.shr_s (i32.shl ${inner} (i32.const 24)) (i32.const 24))`
      if (toU.name === 'u16') return `(i32.and ${inner} (i32.const 65535))`
      if (toU.name === 'i16') return `(i32.shr_s (i32.shl ${inner} (i32.const 16)) (i32.const 16))`
    }
    return inner
  }

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

  // Widening to multi-i64 (u32/i32/u64/i64 → u128+)
  const toWide = wideIntParts(toType)
  if (toWide > 0 && (fromWasm === 'i32' || fromWasm === 'i64')) {
    const ext = fromWasm === 'i32' ? `(i64.extend_i32_${fromSigned ? 's' : 'u'} ${inner})` : inner
    const zeros = Array(toWide - 1).fill('(i64.const 0)').join(' ')
    return `${ext} ${zeros}`
  }

  // Narrowing from multi-i64 (u128+ → u64/i64 or u32/i32)
  const fromWide = wideIntParts(fromType)
  if (fromWide > 0 && toWasm === 'i64') {
    // Take the first i64 — but inner produces multiple values on stack
    // Use a block to extract just the first
    try {
      const parts = splitV128Components(inner, fromWide)
      return parts[0]
    } catch {
      return inner // single expression, just take first stack value
    }
  }
  if (fromWide > 0 && toWasm === 'i32') {
    try {
      const parts = splitV128Components(inner, fromWide)
      return `(i32.wrap_i64 ${parts[0]})`
    } catch {
      return `(i32.wrap_i64 ${inner})`
    }
  }

  return inner
}

function arrayToWat(expr: AST.ArrayExpr, ctx: CodegenContext): string {
  // Check if this literal has a data section entry
  // Use dataId if present (survives def substitution), otherwise span.start
  const id = expr.dataId ?? expr.span.start
  const ref = ctx.literalRefs.get(id)
  if (ref) {
    const type = ctx.types.get(typeKey(expr.span.start, expr.kind))
    if (type?.kind === 'slice') {
      return `(i32.const ${ref.ptr}) (i32.const ${ref.len})`
    }
    return `(i32.const ${ref.ptr})`
  }
  // Value array literal: emit elements directly as stack values
  return expr.elements.map(e => exprToWat(e, ctx)).join(' ')
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
  // Value repeat literal: emit element N times
  const countVal = evalComptimeIndex(expr.count)
  if (countVal !== null) {
    const elem = exprToWat(expr.value, ctx)
    return Array(countVal).fill(elem).join(' ')
  }
  return `(i32.const 0)`
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
    case 'ExpressionStmt': {
      const exprWat = exprToWat(stmt.expr, ctx)
      const exprType = ctx.types.get(typeKey(stmt.expr.span.start, stmt.expr.kind))
        ?? ctx.types.get(typeKey(stmt.expr.span.end, stmt.expr.kind))
      if (exprType && exprType.kind !== 'void') {
        const slots = typeToWasm(exprType).length
        if (slots > 0) return exprWat + '\n' + Array(slots).fill('(drop)').join('\n')
      }
      return exprWat
    }
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
    case 'AssertStmt':
      return `(if (i32.eqz ${exprToWat(stmt.expr, ctx)}) (then (unreachable)))`
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

    // Multiple values - flatten using field names from type
    const flattened = flattenType(type)
    const names = flattened.map(f => f.suffix ? `${name}_${f.suffix}` : `${name}_${flattened.indexOf(f)}`)
    ctx.locals.set(name, names)
    // If value is a single expression producing multiple results (e.g. a function call),
    // emit the call then assign from the stack in reverse order
    // Try to split value into components (works for multi-expression values)
    try {
      const topLevelParts = splitV128Components(value, names.length)
      return names.map((n, i) => `(local.set $${n} ${topLevelParts[i]})`).join('\n')
    } catch {
      // Single expression producing multiple stack values (e.g. function call)
      // Assign from stack in reverse order
      const assigns = [...names].reverse().map(n => `(local.set $${n})`).join('\n')
      return `${value}\n${assigns}`
    }
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
    const targetKey = (stmt.target.kind === 'MemberExpr' || stmt.target.kind === 'IndexExpr')
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

    const nv = wideIntParts(type)
    const ops: Record<string, string> = {
      '+=': nv > 0 ? 'i64.add' : `${wt}.add`,
      '-=': nv > 0 ? 'i64.sub' : `${wt}.sub`,
      '*=': nv > 0 ? 'i64.mul' : `${wt}.mul`,
      '/=': signed ? `${wt}.div_s` : `${wt}.div_u`,
      '%=': signed ? `${wt}.rem_s` : `${wt}.rem_u`,
      '&=': nv > 0 ? 'i64.and' : `${wt}.and`,
      '|=': nv > 0 ? 'i64.or' : `${wt}.or`,
      '^=': nv > 0 ? 'i64.xor' : `${wt}.xor`,
      '<<=': nv > 0 ? 'i64.shl' : `${wt}.shl`,
      '>>=': nv > 0 ? (signed ? 'i64.shr_s' : 'i64.shr_u') : (signed ? `${wt}.shr_s` : `${wt}.shr_u`),
      '>>>=': nv > 0 ? 'i64.shr_u' : `${wt}.shr_u`,
      '<<<=': nv > 0 ? 'i64.shl' : `${wt}.rotl`,
    }

    const op = ops[stmt.op]
    if (op) {
      const raw = nv > 1
        ? multiV128BinaryOp(nv, op, current, rhs)
        : `(${op} ${current} ${rhs})`
      return assignLvalue(stmt.target, truncateSubWord(raw, type), ctx)
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
      try {
        const parts = splitV128Components(value, localNames.length)
        return localNames.map((n, i) => `(local.set $${n} ${parts[i]})`).join('\n')
      } catch {
        const assigns = [...localNames].reverse().map(n => `(local.set $${n})`).join('\n')
        return `${value}\n${assigns}`
      }
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
    const member = target.member
    if (member.kind === 'field' && target.object.kind === 'IdentExpr') {
      const baseName = target.object.name
      const fieldName = member.name
      const localNames = ctx.locals.get(baseName) ?? ctx.params.get(baseName)
      if (localNames) {
        const flatName = `${baseName}_${fieldName}`
        if (localNames.includes(flatName)) {
          return `(local.set $${flatName} ${value})`
        }
      }
      return `(local.set $${baseName}_${fieldName} ${value})`
    }
    if (member.kind === 'index' && target.object.kind === 'IdentExpr') {
      const baseName = target.object.name
      const localNames = ctx.locals.get(baseName) ?? ctx.params.get(baseName)
      if (localNames && localNames[member.value]) {
        return `(local.set $${localNames[member.value]} ${value})`
      }
    }
    if (member.kind === 'deref') {
      const ptr = exprToWat(target.object, ctx)
      const type = ctx.types.get(typeKey(target.span.end, target.kind)) ?? ctx.types.get(typeKey(target.span.start, target.kind))
      if (!type) {
        throw new Error(`Missing type for pointer store at offset ${target.span.start}`)
      }
      return storeToMemory(type, ptr, value)
    }
    // Field access on memory-backed value (e.g., iovecs[0].len = x)
    if (member.kind === 'field') {
      const objType = lookupExprType(target.object, ctx)
      if (objType) {
        const fieldOff = RT.fieldByteOffset(objType, member.name)
        if (fieldOff !== null) {
          const ptr = lvalueAddressOf(target.object, ctx)
          if (ptr !== null) {
            const fieldType = lookupExprType(target, ctx)
            if (fieldType) {
              const addr = fieldOff === 0 ? ptr : `(i32.add ${ptr} (i32.const ${fieldOff}))`
              return storeToMemory(fieldType, addr, value)
            }
          }
        }
      }
    }
  }

  if (target.kind === 'IndexExpr') {
    // Value array [N]T: assignment with comptime index → local.set
    const objTypeKey2 = target.object.kind === 'MemberExpr'
      ? typeKey(target.object.span.end, target.object.kind)
      : typeKey(target.object.span.start, target.object.kind)
    const objType2 = ctx.types.get(objTypeKey2) ?? ctx.types.get(typeKey(target.object.span.start, target.object.kind))
    if (objType2?.kind === 'array' && objType2.sizes && objType2.sizes.length === 1 && typeof objType2.sizes[0] === 'number') {
      const idx = evalComptimeIndex(target.index)
      if (idx !== null && target.object.kind === 'IdentExpr') {
        const localNames = ctx.locals.get(target.object.name) ?? ctx.params.get(target.object.name)
        if (localNames) {
          const elemFlat = flattenType(objType2.element)
          const base = idx * elemFlat.length
          if (elemFlat.length === 1) {
            return `(local.set $${localNames[base]} ${value})`
          }
          const parts = splitV128Components(value, elemFlat.length)
          return elemFlat.map((_, j) => `(local.set $${localNames[base + j]} ${parts[j]})`).join('\n')
        }
      }
    }

    let ptr = exprToWat(target.object, ctx)
    const idx = exprToWat(target.index, ctx)
    const type = ctx.types.get(typeKey(target.span.end, target.kind))
      ?? ctx.types.get(typeKey(target.span.start, target.kind))
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
    return storeToMemory(type, offset, value)
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
  const valueName = stmt.binding.value
  const indexName = stmt.binding.index

  ctx.locals.set(valueName, [valueName])
  if (indexName) {
    ctx.locals.set(indexName, [indexName])
  }

  const body = bodyToWat(stmt.body, ctx)

  // Check if iterable is a comptime integer (for i in N)
  const iterType = ctx.types.get(typeKey(stmt.iterable.span.start, stmt.iterable.kind))
  const iterWat = exprToWat(stmt.iterable, ctx)

  if (iterType && (iterType.kind === 'primitive' || iterType.kind === 'comptime_int')) {
    // Range loop: for value in N → value = 0; while value < N { ...; value += 1 }
    return `(local.set $${valueName} (i32.const 0))
(block $break
    (loop $continue
      (br_if $break (i32.ge_u (local.get $${valueName}) ${iterWat}))
      ${body}
      (local.set $${valueName} (i32.add (local.get $${valueName}) (i32.const 1)))
      (br $continue)
    )
  )`
  }

  // Array/slice loop: for value in arr → iterate elements
  // TODO: implement array iteration
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
  extraSymbols?: Map<string, CheckSymbol>,
): string {
  const ctx = createContext(checkResult, literalRefs, nameMap)
  if (extraSymbols) {
    for (const [k, v] of extraSymbols) ctx.symbols.set(k, v)
  }
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

  // Generate body, with implicit return coercion for arrow functions
  let body = bodyToWat(decl.body, ctx)
  if (decl.body.kind === 'ArrowBody' && funcType.type.returns.length === 1 && namedReturns.length === 0) {
    const retType = funcType.type.returns[0].type
    const retWt = typeToWasmSingle(retType)
    const bodyType = ctx.types.get(typeKey(decl.body.expr.span.start, decl.body.expr.kind))
    if (bodyType) {
      const bodyWt = typeToWasmSingle(bodyType)
      const bodySigned = isSigned(bodyType)
      body = coerceWasmType(body, bodyWt, retWt, bodySigned)
    }
  }

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
          const flattened = flattenType(type)
          const names = flattened.map((f, i) => {
            const fieldName = f.suffix ? `${name}_${f.suffix}` : `${name}_${i}`
            locals.push({ name: fieldName, type: f.wasmType })
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
    if (expr.kind === 'MatchExpr') {
      for (const arm of expr.arms) {
        visitBody(arm.body)
      }
    }
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

function emitTestDecl(
  decl: AST.TestDecl,
  prefix: string,
  ctx: CodegenContext,
  checkResult: TypeCheckResult,
  literalRefs: Map<number, { ptr: number; len: number }>,
  nameMap: Map<string, string>,
  parts: string[],
): void {
  const myPrefix = decl.name
    ? (prefix ? `${prefix}__${decl.name}` : decl.name).replace(/[^a-zA-Z0-9_]/g, '_')
    : prefix

  // Process defs and data decls first so they're available to functions and statements
  for (const item of decl.children) {
    if (item.kind === 'DefDecl' || item.kind === 'DataDecl') {
      const defKey = `${item.ident}$${item.span.start}`
      const sym = checkResult.symbols.get(defKey) ?? checkResult.symbols.get(item.ident)
      if (sym) ctx.symbols.set(item.ident, sym)
    }
  }

  // Separate children into declarations (shared) and test cases (leaf)
  const stmts: AST.Statement[] = []
  let hasNestedTests = false

  for (const item of decl.children) {
    if (item.kind === 'TestDecl') {
      hasNestedTests = true
    } else if (item.kind === 'FuncDecl') {
      // Emit shared helper function
      const watName = item.ident ? `__test_${myPrefix}_${item.ident}` : `__test_${myPrefix}_anon`
      if (item.ident) {
        ctx.nameMap.set(item.ident, watName)
      }
      parts.push(funcToWat(item, checkResult, literalRefs, ctx.nameMap, watName, ctx.symbols))
    } else if (item.kind === 'DefDecl' || item.kind === 'DataDecl') {
      // Already processed above
    } else {
      stmts.push(item)
    }
  }

  if (hasNestedTests) {
    // Group: recurse into nested tests
    for (const item of decl.children) {
      if (item.kind === 'TestDecl') {
        emitTestDecl(item, myPrefix, ctx, checkResult, literalRefs, nameMap, parts)
      }
    }
  } else if (stmts.length > 0 && decl.name) {
    // Leaf test: emit as a function
    const safeName = myPrefix.replace(/[^a-zA-Z0-9_]/g, '_')
    const body = stmts.map(s => stmtToWat(s, ctx)).join('\n')
    const rawLocals = collectTestLocals(stmts, ctx, checkResult)
    const seen = new Set<string>()
    const locals = rawLocals.filter(l => {
      if (seen.has(l.name)) return false
      seen.add(l.name)
      return true
    })
    const localStr = locals.map(l => `(local $${l.name} ${l.type})`).join(' ')
    parts.push(`(func $test_${safeName} ${localStr}\n  ${body}\n)`)
    parts.push(`  (export "test_${safeName}" (func $test_${safeName}))`)
  }
}

function collectTestLocals(
  stmts: AST.Statement[],
  ctx: CodegenContext,
  checkResult: TypeCheckResult,
): { name: string; type: string }[] {
  const fakeBody: AST.Block = { kind: 'Block', stmts, span: { start: 0, end: 0 } }
  return collectLocals(fakeBody, ctx, checkResult)
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
        const resolved = resolveAstType(field.type)
        const flattened = flattenType(resolved)
        if (field.ident) {
          if (flattened.length === 1) {
            params.push(`(param $${field.ident} ${flattened[0].wasmType})`)
          } else {
            for (const f of flattened) {
              params.push(`(param $${field.ident}_${f.suffix} ${f.wasmType})`)
            }
          }
        } else {
          for (const f of flattened) {
            params.push(`(param ${f.wasmType})`)
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
  options?: { includeTests?: boolean; testFiles?: string[] },
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

  // Test functions (only in test mode)
  if (options?.includeTests) {
    const filesToTest = options.testFiles ?? [entryPath]
    for (const testFilePath of filesToTest) {
      const testModule = modules.get(testFilePath)
      const testResult = checkResults.get(testFilePath)
      if (!testModule || !testResult) continue
      const testNameMap = buildFullNameMap(testFilePath)
      const ctx = createContext(testResult, globalLiteralRefs, testNameMap)
      for (const decl of testModule.module.decls) {
        if (decl.kind !== 'TestDecl') continue
        emitTestDecl(decl, '', ctx, testResult, globalLiteralRefs, testNameMap, parts)
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
  const wat = parts.join('\n')
  if (options?.includeTests) {
    return wat // caller uses testNames from the return
  }
  return wat
}

export function programToWatWithTests(
  modules: Map<string, LoadedModule>,
  checkResults: Map<string, TypeCheckResult>,
  entryPath: string,
  testFiles?: string[],
): { wat: string; testNames: string[] } {
  const testNames: string[] = []

  function collectTestNames(decl: AST.TestDecl, prefix: string) {
    const myPrefix = decl.name
      ? (prefix ? `${prefix}__${decl.name}` : decl.name).replace(/[^a-zA-Z0-9_]/g, '_')
      : prefix
    const hasNested = decl.children.some(c => c.kind === 'TestDecl')
    if (hasNested) {
      for (const child of decl.children) {
        if (child.kind === 'TestDecl') collectTestNames(child, myPrefix)
      }
    } else if (decl.name) {
      testNames.push(myPrefix)
    }
  }

  const filesToTest = testFiles ?? [entryPath]
  for (const filePath of filesToTest) {
    const mod = modules.get(filePath)
    if (!mod) continue
    for (const decl of mod.module.decls) {
      if (decl.kind === 'TestDecl') collectTestNames(decl, '')
    }
  }
  const wat = programToWat(modules, checkResults, entryPath, { includeTests: true, testFiles: filesToTest })
  return { wat, testNames }
}
