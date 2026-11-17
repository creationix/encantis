// WebAssembly Text (WAT) code generator for Encantis
// Generates S-expression format WAT from AST + TypeCheckResult

import type * as AST from './ast'
import { argValue, ungroupedType } from './ast'
import { typeKey, isGenericDecl, INSTANCE_STRIDE, addressedLiteral, type ComptimeValue, type TypeCheckResult, type ProgramCheckResult, type Symbol as CheckSymbol } from './checker'
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
import { dataToWat, buildDataSection, buildProgramDataSection, literalLength, type DataRef, type DataSectionBuilder } from './data-pack'
import { wideCall, wideHelperName, wideHelpersFor, type WideBinaryOp } from './wide-int'

// === Context ===

export interface CodegenContext {
  // Types of bindings and declarations from the checker ("offset:kind" keys)
  types: Map<string, ResolvedType>
  // Types of expressions from the checker, by AST node
  exprTypes: Map<AST.Expr, ResolvedType>
  // Implicit widenings from the checker: expression → the wider type its
  // value is used as
  coercions: Map<AST.Expr, ResolvedType>
  // The checker's value for each constant in a global's initializer
  constants: Map<AST.Expr, ComptimeValue>
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
  // Total data section size in bytes (for sizeof(data))
  dataSectionSize?: number
  // When true, asserts call $__assert_fail with source offset
  testMode?: boolean
  // Deferred expressions per open block, innermost last; loop bodies are marked
  // so break and continue run exactly the blocks they leave.
  deferFrames?: { loop: boolean; defers: AST.Expr[] }[]
  // Calls the checker resolved to something else: the written call → what
  // to compile in its place (see TypeCheckResult.calls)
  calls: Map<AST.CallExpr, AST.CallExpr | AST.TupleExpr>
  // The name a function that shares its name is known by (see
  // TypeCheckResult.funcNames)
  funcNames: TypeCheckResult['funcNames']
  // Scratch locals the current function's code asked for (see scratchLocal).
  scratch?: LocalDecl[]
  // The current function's wasm locals and params, each with the variable
  // part it holds (see claimLocals).
  claimed?: Map<string, string>
  // The locals of the variable an `if let` binds, which is seen only in its
  // then-branch (see withBinding).
  bindings?: Map<AST.IfExpr, string[]>
  // The locals of the `if let` bindings whose then-branch collectLocals is in.
  busy?: Set<string>
  // The variables a `let` or a `for` declares, with their locals: from there
  // on its names stand for them (see letToWat, forToWat).
  declared?: Map<AST.LetStmt | AST.ForStmt, [string, string[]][]>
  // Indexes that aren't known to be in range, read as an optional (see
  // TypeCheckResult.unproven): checked, none when out of range.
  unproven: Set<AST.IndexExpr>
}

function createContext(checkResult: TypeCheckResult, literalRefs: Map<number, { ptr: number; len: number }>, nameMap?: Map<string, string>, dataSectionSize?: number): CodegenContext {
  return {
    types: checkResult.types,
    exprTypes: checkResult.exprTypes,
    coercions: checkResult.coercions,
    constants: checkResult.constants,
    symbols: checkResult.symbols,
    locals: new Map(),
    params: new Map(),
    literalRefs,
    indent: 0,
    nameMap: nameMap ?? new Map(),
    namedReturnLocals: [],
    dataSectionSize,
    calls: checkResult.calls,
    funcNames: checkResult.funcNames,
    unproven: checkResult.unproven,
  }
}

// A scratch local or label is named after the place in the source that needs
// it. In an instance that is the place in the generic, not the offset of the
// instance's private copy, which depends on how many instances were asked for
// before it: the text of a function must not change with unrelated code.
// Within one function the two are equally unique.
const scratchId = (offset: number): number => offset % INSTANCE_STRIDE

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
  const wat = wideningOf(expr, ctx)(exprValueToWat(expr, ctx))
  // A constant in a global's initializer has to be a constant instruction.
  // Where it isn't one as written (1 + 1, an integer widened to a float),
  // the checker has worked out its value.
  const constant = ctx.constants.get(expr)
  const type = constant && !CONSTANT.test(wat) && valueType(expr, ctx)
  return (constant && type && constantToWat(constant, type)) || wat
}

const CONSTANT = /^\((?:[if](?:32|64)\.const|ref\.func) [^\s()]+\)$/

// Every implicit widening happens here: the checker says which expressions
// meet a wider type (as an operand, an argument, an initializer, a branch).
// Gives what takes an expression's value from its own type to that one.
function wideningOf(expr: AST.Expr, ctx: CodegenContext): (wat: string) => string {
  const to = ctx.coercions.get(expr)
  const from = to && lookupExprType(expr, ctx)
  // An integer up to 32 bits already fills its i32: widening one within that
  // costs nothing.
  if (!to || !from || typeToWasm(from).join() === typeToWasm(to).join()) return (wat) => wat
  return (wat) => emitConversion(wat, from, to)
}

function exprValueToWat(expr: AST.Expr, ctx: CodegenContext): string {
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
    case 'SliceExpr':
      return sliceToWat(expr, ctx)
    case 'CoalesceExpr':
      return coalesceToWat(expr, ctx)
    case 'IfExpr':
      return ifExprToWat(expr, ctx)
    case 'TupleExpr':
      return tupleToWat(expr, ctx)
    case 'GroupExpr':
      return exprToWat(expr.expr, ctx)
    case 'CastExpr':
      return castToWat(expr, ctx)
    case 'AnnotationExpr': {
      const annType = lookupExprType(expr, ctx)
      if (annType?.kind === 'slice') {
        const inner = expr.expr
        const id = (inner as any).dataId ?? inner.span.start
        const ref = ctx.literalRefs.get(id)
        if (ref) return literalSliceToWat(ref, annType)
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
    case 'SizeofDataExpr':
      return `(i32.const ${ctx.dataSectionSize ?? 0})`
    default:
      throw new Error(`Unhandled expression kind: ${(expr as AST.Expr).kind}`)
  }
}

function literalToWat(expr: AST.LiteralExpr, ctx: CodegenContext): string {
  const lit = expr.value

  switch (lit.kind) {
    case 'int': {
      // Type must be concretized before codegen
      const type = lookupExprType(expr, ctx)
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
      const type = lookupExprType(expr, ctx)
      if (!type) {
        throw new Error(`Missing type for float literal at offset ${expr.span.start}`)
      }
      const wt = typeToWasmSingle(type)
      return `(${wt}.const ${numberText(lit.value)})`
    }

    case 'bool':
      return `(i32.const ${lit.value ? 1 : 0})`

    case 'string': {
      const id = (expr as any).dataId ?? expr.span.start
      const ref = ctx.literalRefs.get(id)
      if (ref) {
        const type = lookupExprType(expr, ctx)
        if (type?.kind === 'slice') {
          return literalSliceToWat(ref, type)
        }
        return `(i32.const ${ref.ptr})`
      }
      return `(i32.const 0)`
    }
  }
}

// A number as WAT writes it. -0 is a float of its own: `${-0}` is "0".
function numberText(value: number | bigint): string {
  return Object.is(value, -0) ? '-0' : `${value}`
}

// A literal that lies in the data section, as the slice over all of it.
function literalSliceToWat(ref: DataRef, type: RT.SliceRT): string {
  return `(i32.const ${ref.ptr}) (i32.const ${literalLength(ref, type.element)})`
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
      return globalNames(name, sym.type, ctx).map((n) => `(global.get $${n})`).join(' ')
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
        return `(${wt}.const ${numberText(val.value)})`
      }
      if (val.kind === 'bool') {
        return `(i32.const ${val.value ? 1 : 0})`
      }
      if (val.kind === 'data_ptr') {
        const ref = ctx.literalRefs.get(val.id)
        if (ref) {
          if (sym.type.kind === 'slice') {
            return literalSliceToWat(ref, sym.type)
          }
          return `(i32.const ${ref.ptr})`
        }
        return `(i32.const 0)`
      }
    }
  }

  // The checker refuses a name it does not know, so nothing that is compiled
  // comes here. Emitting a zero instead would hide the day something does.
  throw new Error(`Unknown identifier '${name}' at offset ${expr.span.start}`)
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


function wideIntParts(t: ResolvedType): number {
  const u = unwrap(t)
  if (u.kind !== 'primitive') return 0
  const size = primitiveByteSize(u)
  if (size !== null && size >= 16) return size / 8
  return 0
}

const limbs = (op: string) => (l: string[], r: string[]) => l.map((x, i) => `(i64.${op} ${x} ${r[i]})`).join(' ')
const limbsEqual = (l: string[], r: string[]) => l.map((x, i) => `(i64.eq ${x} ${r[i]})`).reduce((a, b) => `(i32.and ${a} ${b})`)
const INLINE_WIDE_OPS: Partial<Record<string, (l: string[], r: string[]) => string>> = {
  '&': limbs('and'),
  '|': limbs('or'),
  '^': limbs('xor'),
  '==': limbsEqual,
  '!=': (l, r) => `(i32.eqz ${limbsEqual(l, r)})`,
}

function trySplitMultiValue(wat: string, n: number): string[] | null {
  try {
    return splitMultiValue(wat, n)
  } catch {
    return null
  }
}

// The wide-integer helper for a binary operator.
function wideBinaryOp(op: string, signed: boolean, type: ResolvedType): WideBinaryOp {
  const s = signed ? 's' : 'u'
  const ops: Record<string, WideBinaryOp> = {
    '+': 'add', '-': 'sub', '*': 'mul',
    '&': 'and', '|': 'or', '^': 'xor',
    '<<': 'shl', '>>': signed ? 'shr_s' : 'shr_u', '>>>': 'rotr', '<<<': 'rotl',
    '==': 'eq', '!=': 'ne',
    '<': `lt_${s}`, '>': `gt_${s}`, '<=': `le_${s}`, '>=': `ge_${s}`,
  }
  const helper = ops[op]
  if (!helper) throw new Error(`operator '${op}' on ${RT.typeToString(type)} is not supported yet`)
  return helper
}

// A fresh wasm local for a value that has to wait while other code runs: an
// address that is used several times, or values that come off the stack in an
// order they can't be used in. Each has its own name, so their uses can nest.
function scratchLocal(ctx: CodegenContext, wasmType: string): string {
  if (!ctx.scratch) ctx.scratch = []
  const name = `__tmp_${ctx.scratch.length}`
  ctx.scratch.push({ name, type: wasmType })
  return `$${name}`
}

// A local or a constant: free to repeat, and nothing that runs in between
// changes it.
const isSimple = (wat: string) => /^\((local\.get \$[\w-]+|i32\.const -?\d+)\)$/.test(wat)

// Whether an expression can be evaluated again for the same value and nothing
// else: it makes no calls, sets and stores nothing, and has no control flow.
const EFFECTS = /\((?:call|call_indirect|local\.set|local\.tee|global\.set|memory\.\w+|block|loop|if|br|br_if|br_table|return|unreachable|[if](?:32|64)\.store(?:8|16|32)?)\b/
const isRepeatable = (wat: string) => !EFFECTS.test(wat)

// Whether an expression whose value is not needed can be left out: it has no
// effects and cannot trap. Integer division and remainder trap (by zero, and
// the one quotient that overflows), and so do a float converted to an integer
// that cannot hold it and a load from outside memory.
const TRAPS = /\((?:i(?:32|64)\.(?:div|rem)_[su]|i(?:32|64)\.trunc_f(?:32|64)_[su]|[if](?:32|64)\.load)/
const isDroppable = (wat: string) => isRepeatable(wat) && !TRAPS.test(wat)

// Whether an expression reads linear memory, or a global.
const loadsMemory = (wat: string) => /\([if](?:32|64)\.load/.test(wat)
const readsGlobal = (wat: string) => /\(global\.get\b/.test(wat)

// Whether an expression reads memory, or could through a call.
const readsMemory = (wat: string) => loadsMemory(wat) || /\((?:call|call_indirect)\b/.test(wat)

// Whether an expression writes memory, or could through a call.
const writesMemory = (wat: string) => /\((?:call|call_indirect|memory\.(?:copy|fill)|[if](?:32|64)\.store(?:8|16|32)?)\b/.test(wat)

// Whether `wat` sets a local that `address` reads: an if or a block that is a
// value can assign on its way to it (p.* = if c { p = q ... }), and then the
// address is another one after the value than before it.
function setsLocalOf(wat: string, address: string): boolean {
  for (const [, name] of address.matchAll(/\(local\.get (\$[\w-]+)\)/g)) {
    if (wat.includes(`(local.set ${name} `) || wat.includes(`(local.set ${name})`) || wat.includes(`(local.tee ${name} `)) return true
  }
  return false
}

// The load and store instructions for one scalar. Integers narrower than a
// word, and bool (one byte), take their own width in memory and an i32 on the
// stack.
function loadOp(type: ResolvedType): string {
  const u = unwrap(type)
  if (u.kind === 'primitive') {
    if (u.name === 'u8' || u.name === 'bool') return 'i32.load8_u'
    if (u.name === 'i8') return 'i32.load8_s'
    if (u.name === 'u16') return 'i32.load16_u'
    if (u.name === 'i16') return 'i32.load16_s'
  }
  return `${typeToWasmSingle(type)}.load`
}

function storeOp(type: ResolvedType): string {
  const u = unwrap(type)
  if (u.kind === 'primitive') {
    if (u.name === 'u8' || u.name === 'i8' || u.name === 'bool') return 'i32.store8'
    if (u.name === 'u16' || u.name === 'i16') return 'i32.store16'
  }
  return `${typeToWasmSingle(type)}.store`
}

const atOffset = (offset: number) => (offset === 0 ? '' : ` offset=${offset}`)

// The scalars a struct, tuple or fixed array is made of in memory, or null for
// a type that is one scalar (or a slice or wide integer, which keep their own
// forms below).
function aggregateParts(type: ResolvedType): RT.MemoryPart[] | null {
  const u = unwrap(type)
  if (u.kind !== 'tuple' && !(u.kind === 'array' && RT.isValueArray(u))) return null
  const parts = RT.memoryParts(u)
  if (!parts) throw new Error(`${RT.typeToString(type)} has no fixed size in memory`)
  return parts
}

// Reads a value of any type from memory at `ptr`, leaving its wasm values on
// the stack in order. A value of several parts (a slice, a wide integer, a
// struct, tuple or fixed array, nested as deep as they go) is one load per
// part, at the part's offset.
//
// The address is evaluated once. A slice or wide integer repeats an address
// that has no effects, as their loads always have. A struct can have many
// parts, so an address that is more than a local or a constant goes into a
// scratch local with the first load.
function loadFromMemory(type: ResolvedType, ptr: string, ctx: CodegenContext): string {
  const nw = wideIntParts(type)
  const u = unwrap(type)
  if (nw > 0 || u.kind === 'slice') {
    const loads = (p: string) => nw > 0
      ? Array.from({ length: nw }, (_, i) => `(i64.load offset=${i * 8} ${p})`).join(' ')
      // Slice: load ptr + len (two i32s) — same layout as tuple (ptr, len)
      : `(i32.load ${p}) (i32.load offset=4 ${p})`
    if (isRepeatable(ptr)) return loads(ptr)
    const tmp = scratchLocal(ctx, 'i32')
    return `(block (result ${typeToWasm(type).join(' ')}) (local.set ${tmp} ${ptr}) ${loads(`(local.get ${tmp})`)})`
  }
  const parts = aggregateParts(type)
  if (!parts) return `(${loadOp(type)} ${ptr})`
  let first = ptr
  let rest = ptr
  if (parts.length > 1 && !isSimple(ptr)) {
    const tmp = scratchLocal(ctx, 'i32')
    first = `(local.tee ${tmp} ${ptr})`
    rest = `(local.get ${tmp})`
  }
  return parts.map((p, i) => `(${loadOp(p.type)}${atOffset(p.offset)} ${i === 0 ? first : rest})`).join(' ')
}

// Writes a value of any type to memory at `ptr`: one store per part, as
// loadFromMemory reads them.
//
// An assignment reads its whole value before it writes any of it. When the
// value is given part by part and a part after the first reads memory, an
// earlier store could change what it reads: the same place rebuilt from its
// own fields (p.* = (p.b, p.a)), or a copy from a place that overlaps this one.
// So then all the parts go on the stack, each above its address, before the
// stores run. A value that arrives on the stack in one piece (a call's result)
// waits in scratch locals; a wide integer has a helper for that. A wide
// integer is also the exception to the rule: it is one scalar, stored limb by
// limb in order, so a copy over a place that partly overlaps it is not whole.
//
// What a later part writes counts as much as what it reads: a store it makes
// on its way (p.* = Point(1, if c { p.x = 9 ... })) belongs to the value, so it
// comes before every store of the assignment, not between two of them.
//
// The address is evaluated once, as for loads, and before the value: it is the
// place the target named when the assignment began. A local or a constant is
// repeated instead, and a slice or wide integer repeats an address that reads
// no memory, has no effects, and reads no global while the value has effects;
// but only when the value sets no local the address reads.
function storeToMemory(type: ResolvedType, ptr: string, value: string, ctx: CodegenContext): string {
  const nw = wideIntParts(type)
  const u = unwrap(type)
  const parts = nw > 0 || u.kind === 'slice' ? RT.memoryParts(u) : aggregateParts(type)
  if (!parts) return `(${storeOp(type)} ${ptr} ${value})`
  if (parts.length === 0) return value
  if (parts.length === 1) return `(${storeOp(parts[0].type)} ${ptr} ${value})`

  const values = trySplitMultiValue(value, parts.length)
  if (nw > 0 && !values) return `(call ${wideHelperName(nw, 'store')} ${ptr} ${value})`

  const repeat = (isSimple(ptr) ||
    ((nw > 0 || u.kind === 'slice') && isRepeatable(ptr) && !loadsMemory(ptr) && !(readsGlobal(ptr) && !isRepeatable(value)))) &&
    !setsLocalOf(value, ptr)
  let first = ptr
  let rest = ptr
  if (!repeat) {
    const tmp = scratchLocal(ctx, 'i32')
    first = `(local.tee ${tmp} ${ptr})`
    rest = `(local.get ${tmp})`
  }
  const at = (i: number) => (i === 0 ? first : rest)
  // Wide integers have always spelled out the first limb's offset.
  const offset = (i: number) => (nw > 0 ? ` offset=${parts[i].offset}` : atOffset(parts[i].offset))
  const store = (i: number, operands: string) => `(${storeOp(parts[i].type)}${offset(i)}${operands})`

  if (values) {
    if (nw > 0 || !values.slice(1).some((v) => readsMemory(v) || writesMemory(v))) {
      return parts.map((_, i) => store(i, ` ${at(i)} ${values[i]}`)).join('\n')
    }
    return [
      ...parts.map((_, i) => `${at(i)} ${values[i]}`),
      ...parts.map((_, i) => store(i, '')).reverse(),
    ].join('\n')
  }
  // The first part can be stored straight off the stack once the others are
  // out of its way.
  const temps = parts.slice(1).map((p) => scratchLocal(ctx, typeToWasmSingle(p.type)))
  return [
    first,
    value,
    ...[...temps].reverse().map((t) => `(local.set ${t})`),
    store(0, ''),
    ...temps.map((t, i) => store(i + 1, ` ${rest} (local.get ${t})`)),
  ].join('\n')
}

function splitMultiValue(wat: string, n: number): string[] {
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
  // The right count of parts is only the values if none is a statement: x ?? y
  // sets its scratch locals first, then yields its whole value from an `if`.
  if (parts.length === n && !parts.some((part) => STATEMENT.test(part))) return parts
  throw new Error(`Expected ${n} v128 components, got ${parts.length}: ${wat.slice(0, 80)}...`)
}

// An instruction that leaves nothing on the stack. The one call among them is
// the wide-integer store helper, which an array literal uses for its slots.
const STATEMENT = /^\((?:local\.set|global\.set|drop|nop|br|br_if|return|unreachable|memory\.(?:copy|fill)|[if](?:32|64)\.store(?:8|16|32)?|call \$__w\d+_store|(?:block|loop|if)(?!\s+\(result))\b/

// The type the checker recorded for an expression.
function lookupExprType(expr: AST.Expr, ctx: CodegenContext): ResolvedType | undefined {
  return ctx.exprTypes.get(expr)
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
  const parts = splitMultiValue(wat, fromParts)
  while (parts.length < toParts) parts.push('(i64.const 0)')
  return parts.join(' ')
}

// The type of the value exprToWat leaves on the stack: the expression's own,
// or the one the checker widens it to where it's used.
function valueType(expr: AST.Expr, ctx: CodegenContext): ResolvedType | undefined {
  return ctx.coercions.get(expr) ?? lookupExprType(expr, ctx)
}

const COMPARISON_OPS: ReadonlySet<string> = new Set(['==', '!=', '<', '>', '<=', '>='])
const SHIFT_OPS: ReadonlySet<string> = new Set(['<<', '>>', '<<<', '>>>'])

// The wasm instruction for a binary operator on operands of one type, each a
// single wasm value. Saturating operators wrap for now (TODO: saturation).
function binaryInstruction(op: string, type: ResolvedType): string {
  const wt = typeToWasmSingle(type)
  const float = isFloat(type)
  const sign = isSigned(type) ? 's' : 'u'
  switch (op) {
    case '+': case '+|': return `${wt}.add`
    case '-': case '-|': return `${wt}.sub`
    case '*': case '*|': return `${wt}.mul`
    case '/': return float ? `${wt}.div` : `${wt}.div_${sign}`
    case '%': return `${wt}.rem_${sign}`
    case '==': return `${wt}.eq`
    case '!=': return `${wt}.ne`
    case '<': return float ? `${wt}.lt` : `${wt}.lt_${sign}`
    case '>': return float ? `${wt}.gt` : `${wt}.gt_${sign}`
    case '<=': return float ? `${wt}.le` : `${wt}.le_${sign}`
    case '>=': return float ? `${wt}.ge` : `${wt}.ge_${sign}`
    case '&': return `${wt}.and`
    case '|': return `${wt}.or`
    case '^': return `${wt}.xor`
    case '<<': return `${wt}.shl`
    case '>>': return `${wt}.shr_${sign}`
    case '<<<': return `${wt}.rotl`
    case '>>>': return `${wt}.rotr`
    default: throw new Error(`Unknown binary operator: ${op}`)
  }
}

// `left op right` on operands of one type that is a single wasm value. The
// result of an 8- or 16-bit operation is cut back to its width.
function scalarBinaryToWat(op: string, type: ResolvedType, left: string, right: string): string {
  const bits = (primitiveByteSize(type) ?? 4) * 8
  if (bits < 32 && (op === '<<<' || op === '>>>')) {
    // An i32 rotation would take a u8 or u16 through the unused high bits.
    // Repeated across the word, each copy rotates in place.
    const value = isSigned(type) ? `(i32.and ${left} (i32.const ${bits === 8 ? 255 : 65535}))` : left
    left = `(i32.mul ${value} (i32.const ${bits === 8 ? 0x01010101 : 0x00010001}))`
  }
  return truncateSubWord(`(${binaryInstruction(op, type)} ${left} ${right})`, type)
}

// A shift or rotate count can be any integer type; wasm wants it in the
// value's. Only the count's low bits matter, so widening or wrapping is exact.
function shiftCountToWat(count: string, countType: ResolvedType | undefined, type: ResolvedType): string {
  if (!countType) return count
  const parts = wideIntParts(type)
  const countParts = wideIntParts(countType)
  if (parts > 0) return countParts > parts ? emitConversion(count, countType, type) : widenToWide(count, countType, parts)
  const wt = typeToWasmSingle(type)
  if (countParts > 0) return emitConversion(count, countType, RT.primitive(wt === 'i64' ? 'u64' : 'u32'))
  return coerceWasmType(count, typeToWasmSingle(countType), wt, isSigned(countType))
}

function binaryToWat(expr: AST.BinaryExpr, ctx: CodegenContext): string {
  const left = exprToWat(expr.left, ctx)
  let right = exprToWat(expr.right, ctx)
  const op = expr.op

  // Logical (short-circuit)
  if (op === '&&') return `(if (result i32) ${left} (then ${right}) (else (i32.const 0)))`
  if (op === '||') return `(if (result i32) ${left} (then (i32.const 1)) (else ${right}))`

  // Get result type from checker
  const resultType = lookupExprType(expr, ctx)
  if (!resultType) {
    throw new Error(`Missing type for binary expression at offset ${expr.span.start}`)
  }

  // The checker brought both operands to one type, the one the operation is
  // done in: the result's, or for a comparison (whose result is bool) the
  // operands'. A shift's count is the exception.
  let operandType = COMPARISON_OPS.has(op) ? valueType(expr.left, ctx) ?? resultType : resultType
  // Unwrap 1-element tuple from parenthesized expressions
  if (operandType.kind === 'tuple' && operandType.fields.length === 1) {
    operandType = operandType.fields[0].type
  }
  if (SHIFT_OPS.has(op)) right = shiftCountToWat(right, valueType(expr.right, ctx), operandType)

  const nWide = wideIntParts(operandType)
  if (nWide > 1) {
    // Bitwise ops and equality need no carries: do them inline, limb by limb,
    // when both operands split into parts (the hot path in crypto code).
    const limbwise = INLINE_WIDE_OPS[op]
    const lp = limbwise ? trySplitMultiValue(left, nWide) : null
    const rp = lp ? trySplitMultiValue(right, nWide) : null
    if (limbwise && lp && rp) return limbwise(lp, rp)
    return wideCall(nWide, wideBinaryOp(op, isSigned(operandType), operandType), left, right)
  }
  return scalarBinaryToWat(op, operandType, left, right)
}

function unaryToWat(expr: AST.UnaryExpr, ctx: CodegenContext): string {
  const operand = exprToWat(expr.operand, ctx)

  // Get type from checker - must be recorded
  const type = lookupExprType(expr, ctx)
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
      if (nw > 1) return wideCall(nw, 'neg', operand)
      return truncateSubWord(`(${wt}.sub (${wt}.const 0) ${operand})`, type)
    }

    case '~': {
      // Bitwise NOT
      const nw = wideIntParts(type)
      if (nw > 1) {
        const parts = trySplitMultiValue(operand, nw)
        return parts ? parts.map(p => `(i64.xor ${p} (i64.const -1))`).join(' ') : wideCall(nw, 'not', operand)
      }
      return truncateSubWord(`(${wt}.xor ${operand} (${wt}.const -1))`, type)
    }

    case '!':
      // Logical NOT: x == 0
      return `(i32.eqz ${operand})`

    case '&': {
      if (expr.operand.kind === 'IndexExpr') {
        const addr = addressOfIndexToWat(expr, expr.operand, ctx)
        if (addr) return addr
      }
      // If operand is already a pointer, just return it
      const innerType = lookupExprType(expr.operand, ctx)
      if (innerType && (innerType.kind === 'pointer' || innerType.kind === 'slice')) {
        return operand
      }
      // Anonymous data allocation: look up data section ref
      const innerExpr = addressedLiteral(expr.operand)
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

// The type a numeric builtin computes in, as the checker settled it from all
// of the operands.
function builtinOperandType(expr: AST.CallExpr, ctx: CodegenContext): ResolvedType {
  const type = ctx.types.get(typeKey(expr.span.start, 'BuiltinCall'))
  if (!type) throw new Error(`Missing operand type for builtin call at offset ${expr.span.start}`)
  return type
}

// The scratch local a builtin keeps operand `index` in when it needs the
// value twice.
function builtinScratchLocal(name: string, index: number, expr: AST.CallExpr): string {
  return `__${name}_${index}_${scratchId(expr.span.start)}`
}

// A read of a local, a global or a constant: free to repeat.
const PLAIN_READ = /^\((?:(local|global)\.get (\$[^\s()]+)|(?:i32|i64|f32|f64)\.const [^\s()]+)\)$/

// An operand's code for its first use and for its second, each in the type
// `widen` gives it. A plain read is repeated, unless `between` (what runs
// between the two uses) can change what it reads; anything else is evaluated
// once, into the scratch local.
function useTwice(wat: string, widen: (wat: string) => string, scratch: string, between: string): [string, string] {
  const read = PLAIN_READ.exec(wat)
  if (read) {
    const [, scope, name] = read
    const writes = (op: string) => new RegExp(`\\(${op} ${name.replace(/[^\w-]/g, '\\$&')}[\\s)]`).test(between)
    // A local changes only where this function sets it; a global, in any call too.
    const changed = scope === 'local' ? writes('local\\.(?:set|tee)')
      : scope === 'global' && (writes('global\\.set') || /\((?:call|call_indirect) /.test(between))
    if (!changed) return [widen(wat), widen(wat)]
  }
  return [`(local.tee $${scratch} ${widen(wat)})`, `(local.get $${scratch})`]
}

// Handle builtin functions
// Returns null if not a builtin
function builtinToWat(name: string, expr: AST.CallExpr, ctx: CodegenContext): string | null {
  const args = expr.args.filter((a): a is AST.Arg & { value: AST.Expr } => a.value !== null)

  switch (name) {
    case 'memzero': {
      // memzero(dest) -> memory.fill with 0, size from type
      if (args.length !== 1) return null
      const dest = exprToWat(args[0].value, ctx)
      const destType = lookupExprType(args[0].value, ctx)
      const size = destType ? byteSize(destType.kind === 'pointer' ? destType.pointee : destType) : null
      if (size === null) return null
      return `(memory.fill ${dest} (i32.const 0) (i32.const ${size}))`
    }

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
      const type = builtinOperandType(expr, ctx)
      return `(${typeToWasmSingle(type)}.${name} ${exprToWat(args[0].value, ctx)})`
    }

    // Float-only binary: copysign
    case 'copysign': {
      if (args.length !== 2) return null
      const type = builtinOperandType(expr, ctx)
      const a = exprToWat(args[0].value, ctx)
      const b = exprToWat(args[1].value, ctx)
      return `(${typeToWasmSingle(type)}.copysign ${a} ${b})`
    }

    // min/max: native for floats, select for integers
    case 'min':
    case 'max': {
      if (args.length !== 2) return null
      const type = builtinOperandType(expr, ctx)
      const wt = typeToWasmSingle(type)
      // Each operand's own value, and the widening that takes a narrower one
      // to the type computed in: a plain read is cheaper widened twice than kept.
      const [a, b] = args.map((arg) => exprValueToWat(arg.value, ctx))
      const [widenA, widenB] = args.map((arg) => wideningOf(arg.value, ctx))
      if (isFloat(type)) return `(${wt}.${name} ${widenA(a)} ${widenB(b)})`

      const sign = isSigned(type) ? 's' : 'u'
      const nWide = wideIntParts(type)
      if (nWide > 1) return wideCall(nWide, `${name}_${sign}`, widenA(a), widenB(b))
      // select takes both values and the comparison takes them again: a b (a < b).
      // b runs between the two uses of a; nothing runs between the two of b.
      const [a1, a2] = useTwice(a, widenA, builtinScratchLocal(name, 0, expr), b)
      const [b1, b2] = useTwice(b, widenB, builtinScratchLocal(name, 1, expr), '')
      return `(select ${a1} ${b1} (${wt}.${name === 'min' ? 'lt' : 'gt'}_${sign} ${a2} ${b2}))`
    }

    // abs: native for floats, conditional negate for signed integers
    case 'abs': {
      if (args.length !== 1) return null
      const type = builtinOperandType(expr, ctx)
      const wt = typeToWasmSingle(type)
      const arg = exprToWat(args[0].value, ctx)
      if (isFloat(type)) return `(${wt}.abs ${arg})`
      // Unsigned integer: abs is identity
      if (!isSigned(type)) return arg

      const nWide = wideIntParts(type)
      if (nWide > 1) return wideCall(nWide, 'abs', arg)
      // select(x, -x, x >= 0). The most negative value has no positive in its
      // type: -x wraps back to it, as negation does.
      const [x, again] = useTwice(arg, (wat) => wat, builtinScratchLocal(name, 0, expr), '')
      const negated = truncateSubWord(`(${wt}.sub (${wt}.const 0) ${again})`, type)
      return `(select ${x} ${negated} (${wt}.ge_s ${again} (${wt}.const 0)))`
    }

    // Integer-only unary: clz, ctz, popcnt
    case 'clz':
    case 'ctz':
    case 'popcnt': {
      if (args.length !== 1) return null
      const type = builtinOperandType(expr, ctx)
      const wt = typeToWasmSingle(type)
      const count = `(${wt}.${name} ${exprToWat(args[0].value, ctx)})`
      // The result is a u8, an i32 on the stack, whatever the operand's width.
      return wt === 'i64' ? `(i32.wrap_i64 ${count})` : count
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
  // A call of a generic compiles as the plain call of its instance that the
  // checker recorded: nothing of the comptime arguments is left. This comes
  // before the builtins, so a generic named max is reachable. A type that is
  // called, Vec(u32)(p, 0, cap), compiles as the struct of its arguments.
  const lowered = ctx.calls.get(expr)
  if (lowered) return lowered.kind === 'CallExpr' ? callToWat(lowered, ctx) : tupleToWat(lowered, ctx)

  // Get function name
  let funcName: string
  if (expr.callee.kind === 'IdentExpr') {
    funcName = expr.callee.name
  } else {
    // The checker refuses the call of a function value, and a method call
    // comes here as the call it stands for.
    throw new Error(`Cannot call this expression at offset ${expr.span.start}: only a named function is called`)
  }

  // Handle builtin functions. The checker decides which calls are to one (a
  // function the program declares takes the builtin's name, unless a variable
  // in scope hides that function), and marks them.
  const isBuiltin = ctx.types.has(typeKey(expr.span.start, 'BuiltinCall'))
  const builtin = isBuiltin ? builtinToWat(funcName, expr, ctx) : null
  if (builtin !== null) return builtin

  // Primitive type cast: u64(x), f32(x), etc.
  if (RT.PRIMITIVE_NAMES.has(funcName)) {
    const arg = expr.args.find((a) => a.value)
    if (arg?.value) {
      const inner = exprToWat(arg.value, ctx)
      const fromType = lookupExprType(arg.value, ctx)
      const toType = lookupExprType(expr, ctx)
      if (!fromType || !toType) return inner
      return emitConversion(inner, fromType, toType)
    }
  }

  // Struct constructor: a type used as a function. Structs are register-flattened,
  // so constructing one pushes its fields' values in declaration order. One
  // with names among its arguments (Point(y: 2, x: 1)) the checker recorded
  // above as the tuple of its fields in order; here each argument is the
  // field at its place.
  const typeSym = ctx.symbols.get(funcName)
  if (typeSym?.kind === 'type') {
    const structType = RT.unwrap(typeSym.type)
    if (structType.kind === 'tuple') {
      return expr.args.map((arg) => (arg.value ? exprToWat(arg.value, ctx) : '')).join(' ')
    }
  }

  // The arguments, each converted to its parameter's type where the checker
  // says (a pointer to an array to a slice, a widening)
  const args = expr.args.map((arg) => {
    if (arg.value) return exprToWat(arg.value, ctx)
    if (arg.name) return identToWat({ kind: 'IdentExpr', name: arg.name, span: arg.span }, ctx)
    return ''
  }).filter(Boolean).join(' ')

  const watName = ctx.nameMap.get(funcName) ?? funcName
  return `(call $${watName}${args ? ' ' + args : ''})`
}

// === Places ===
//
// An expression that names a variable, or part of one, is a place: it can be
// read without evaluating anything else, and it can be assigned. A place is
// either registers (wasm locals, or wasm globals for a module global) or an
// address in linear memory. Any other expression is a value on the stack.

// Parentheses around one expression parse as a group or a one-element tuple.
function ungroup(expr: AST.Expr): AST.Expr {
  if (expr.kind === 'GroupExpr') return ungroup(expr.expr)
  if (expr.kind === 'TupleExpr' && expr.elements.length === 1 && !expr.elements[0].name && expr.elements[0].value) {
    return ungroup(expr.elements[0].value)
  }
  return expr
}

// Which of a value's wasm values one member of it covers: a field of a struct
// or tuple (p.y, t.1), the ptr or len of a slice, or an element of a fixed
// array at a constant index (v[2]). Null for anything else, such as a field
// reached through a pointer.
function memberValues(expr: AST.Expr, ctx: CodegenContext): { object: AST.Expr; start: number; count: number } | null {
  if (expr.kind !== 'MemberExpr' && expr.kind !== 'IndexExpr') return null
  const object = ungroup(expr.object)
  const objType = lookupExprType(object, ctx)
  if (!objType) return null
  const u = unwrap(objType)
  const width = (t: ResolvedType) => typeToWasm(t).length
  if (expr.kind === 'IndexExpr') {
    const index = evalComptimeIndex(expr.index)
    if (u.kind !== 'array' || !RT.isValueArray(u) || index === null) return null
    return { object, start: index * width(u.element), count: width(u.element) }
  }
  const member = expr.member
  if (u.kind === 'slice' && member.kind === 'field' && (member.name === 'ptr' || member.name === 'len')) {
    return { object, start: member.name === 'ptr' ? 0 : 1, count: 1 }
  }
  if (u.kind !== 'tuple' || (member.kind !== 'field' && member.kind !== 'index')) return null
  const index = member.kind === 'index' ? member.value : u.fields.findIndex((f) => f.name === member.name)
  if (index < 0 || index >= u.fields.length) return null
  const start = u.fields.slice(0, index).reduce((n, f) => n + width(f.type), 0)
  return { object, start, count: width(u.fields[index].type) }
}

interface Registers {
  names: string[]
  global: boolean
}

// How the wasm values of a multi-value type are told apart in names: a
// variable s of type []u8 is s_ptr and s_len.
function flatSuffixes(type: ResolvedType): string[] {
  const flat = flattenType(type)
  if (flat.length === 1) return ['']
  return flat.map((f, i) => `_${f.suffix || i}`)
}

// The wasm globals that hold a module global: one per wasm value, so a slice
// or struct global is several, named like a local's parts (see claimGlobals).
function globalNames(name: string, type: ResolvedType, ctx: CodegenContext): string[] {
  const watName = ctx.nameMap.get(name) ?? name
  return programGlobals.get(ctx.symbols)?.get(watName) ?? flatSuffixes(type).map((suffix) => `${watName}${suffix}`)
}

// The wasm globals of the globals of a program, by the name each global is
// known by in the WAT (its module's prefix and its name), for the symbols of
// each of its modules.
const programGlobals = new WeakMap<object, Map<string, string[]>>()

// Names the wasm globals of the globals a module declares or imports from
// the host, into `into`. As with locals (claimLocals), the parts of a global
// `g` of a struct with a field `x` would be named like a global `g_x`; a
// name goes to the first global that asks for it, in the order of the
// module, and a later one gets all its names with a prefix, `_1_`, `_2_`.
// Two modules' globals never meet: a module's names carry its prefix.
function claimGlobals(module: AST.Module, symbols: Map<string, CheckSymbol>, nameMap: Map<string, string>, into: Map<string, string[]>): void {
  const claimed = new Set<string>()
  const claim = (name: string) => {
    const sym = symbols.get(name)
    if (sym?.kind !== 'global') return
    const watName = nameMap.get(name) ?? name
    const modulePrefix = watName.slice(0, watName.length - name.length)
    const suffixes = flatSuffixes(sym.type)
    for (let n = 0; ; n++) {
      const names = suffixes.map((suffix) => `${n === 0 ? '' : `_${n}_`}${name}${suffix}`)
      // Two parts of one global named alike take names apart, as a local's do.
      for (let i = 1; i < names.length; i++) {
        for (let k = n + 1; names.indexOf(names[i]) < i; k++) {
          const w = `_${k}_${name}${suffixes[i]}`
          if (!claimed.has(w) && !names.includes(w)) names[i] = w
        }
      }
      if (names.some((w) => claimed.has(w))) continue
      for (const w of names) claimed.add(w)
      into.set(watName, names.map((w) => `${modulePrefix}${w}`))
      return
    }
  }
  for (const decl of module.decls) {
    const item = decl.kind === 'ExportDecl' ? decl.item : decl
    if (item.kind === 'GlobalDecl' && item.pattern.kind === 'IdentPattern') claim(item.pattern.name)
    if (item.kind === 'ImportDecl' && !isSourceImport(item.module)) {
      for (const imported of item.items) if (imported.item.kind === 'ImportGlobal') claim(imported.item.ident)
    }
  }
}

// The registers that hold an expression's value, in order, when it names a
// variable or a member of one: point.x is $point_x, rect.origin is
// $rect_origin_x and $rect_origin_y.
function registersOf(expr: AST.Expr, ctx: CodegenContext): Registers | null {
  expr = ungroup(expr)
  if (expr.kind === 'IdentExpr') {
    const names = ctx.locals.get(expr.name) ?? ctx.params.get(expr.name)
    if (names) return { names, global: false }
    const sym = ctx.symbols.get(expr.name)
    if (sym?.kind === 'global') return { names: globalNames(expr.name, sym.type, ctx), global: true }
    return null
  }
  const member = memberValues(expr, ctx)
  const object = member && registersOf(member.object, ctx)
  if (!member || !object || member.start + member.count > object.names.length) return null
  return { names: object.names.slice(member.start, member.start + member.count), global: object.global }
}

function registersToWat(regs: Registers): string {
  return regs.names.map((n) => `(${regs.global ? 'global' : 'local'}.get $${n})`).join(' ')
}

// Assigns a value to registers. A value of several parts is set part by part
// when it is written out that way. If a later part reads a register that an
// earlier part sets (p = Point(p.y, p.x)) it would see the new value, so then,
// as for a value that arrives in one piece, the whole value goes on the stack
// first.
function setRegisters(regs: Registers, value: string): string {
  const { names } = regs
  const set = regs.global ? 'global.set' : 'local.set'
  if (names.length === 1) return `(${set} $${names[0]} ${value})`
  const parts = trySplitMultiValue(value, names.length)
  const reads = (part: string, name: string) =>
    part.split(`$${name}`).slice(1).some((after) => !/^[\w.+$-]/.test(after)) || (regs.global && /\((?:call|call_indirect)\b/.test(part))
  if (parts && !parts.some((part, i) => names.slice(0, i).some((name) => reads(part, name)))) {
    return names.map((n, i) => `(${set} $${n} ${parts[i]})`).join('\n')
  }
  return [value, ...[...names].reverse().map((n) => `(${set} $${n})`)].join('\n')
}

// A slice's pointer, from the (ptr, len) pair. The length is still computed
// if it could trap or has effects.
function slicePointer(slice: string): string {
  const parts = trySplitMultiValue(slice, 2)
  return parts && isDroppable(parts[1]) ? parts[0] : `(block (result i32) ${slice} (drop))`
}

// Indexing a packed *[N,M]T once gives the address of a row, a *[M]T, and
// not a value.
function isRowIndex(expr: AST.IndexExpr, ctx: CodegenContext): boolean {
  const objType = lookupExprType(expr.object, ctx)
  const u = objType && unwrap(objType)
  const array = u?.kind === 'pointer' ? unwrap(u.pointee) : u
  return array?.kind === 'array' && array.sizes !== null && array.sizes.length > 1
}

// The address of the element an index expression names: base + index * stride.
function elementAddress(expr: AST.IndexExpr, ctx: CodegenContext): string {
  const objType = lookupExprType(expr.object, ctx)
  let base = exprToWat(expr.object, ctx)
  const index = exprToWat(expr.index, ctx)
  // For slice objects, extract just the pointer (first component)
  if (objType?.kind === 'slice') base = slicePointer(base)
  return indexOffset(expr.object, base, index, ctx).offset
}

// Where an expression's value lies in memory, when it names a place there: an
// indexed element (xs[i]), a dereference (p.*), a field reached through a
// pointer (p.x reads the struct p points to), or a member of any of those
// (xs[i].b.c). The address is `base`, made when asked for, plus a constant.
interface MemoryPlace {
  base: () => string
  offset: number
}

function memoryPlace(expr: AST.Expr, ctx: CodegenContext): MemoryPlace | null {
  expr = ungroup(expr)
  if (expr.kind !== 'MemberExpr' && expr.kind !== 'IndexExpr') return null
  const object = ungroup(expr.object)
  const objType = lookupExprType(object, ctx)
  if (!objType) return null
  const u = unwrap(objType)

  if (expr.kind === 'IndexExpr') {
    if (u.kind === 'array' && RT.isValueArray(u)) {
      // An element of a fixed array is in memory when the array is.
      const index = evalComptimeIndex(expr.index)
      const stride = byteSize(u.element)
      const array = memoryPlace(object, ctx)
      if (index === null || stride === null || !array) return null
      return { base: array.base, offset: array.offset + index * stride }
    }
    if (isRowIndex(expr, ctx)) return null
    return { base: () => elementAddress(expr, ctx), offset: 0 }
  }

  const member = expr.member
  if (member.kind === 'deref') return { base: () => exprToWat(object, ctx), offset: 0 }
  if (member.kind !== 'field' && member.kind !== 'index') return null
  const field = member.kind === 'field' ? member.name : member.value
  if (u.kind === 'pointer') {
    const offset = RT.fieldByteOffset(u.pointee, field)
    return offset === null ? null : { base: () => exprToWat(object, ctx), offset }
  }
  const offset = RT.fieldByteOffset(u, field)
  const struct = offset === null ? null : memoryPlace(object, ctx)
  return struct && offset !== null ? { base: struct.base, offset: struct.offset + offset } : null
}

function lvalueAddressOf(expr: AST.Expr, ctx: CodegenContext): string | null {
  const place = memoryPlace(expr, ctx)
  if (!place) return null
  return place.offset === 0 ? place.base() : `(i32.add ${place.base()} (i32.const ${place.offset}))`
}

// Keeps `count` of the values an expression leaves on the stack, from `start`.
// When the expression is written out value by value, none has effects and the
// others cannot trap (Point(7, 1 / n).x still divides), the others are just
// left out. Otherwise it is evaluated whole and the others are dropped; the
// kept values wait in scratch locals while the ones under them go.
function selectValues(wat: string, types: string[], start: number, count: number, ctx: CodegenContext): string {
  const parts = trySplitMultiValue(wat, types.length)
  const kept = (i: number) => i >= start && i < start + count
  if (parts?.every((part, i) => kept(i) ? isRepeatable(part) : isDroppable(part))) return parts.slice(start, start + count).join(' ')
  const results = types.slice(start, start + count)
  const code = [wat, ...Array(types.length - start - count).fill('(drop)')]
  if (start > 0) {
    const temps = results.map((t) => scratchLocal(ctx, t))
    code.push(...[...temps].reverse().map((t) => `(local.set ${t})`))
    code.push(...Array(start).fill('(drop)'))
    code.push(...temps.map((t) => `(local.get ${t})`))
  }
  return `(block${results.length > 0 ? ` (result ${results.join(' ')})` : ''} ${code.join(' ')})`
}

// A member of a struct that is neither in a variable nor in memory but on the
// stack, such as a call's result: f().size.x. Follows the members down to that
// value and keeps the wasm values the last one covers. Null when there is no
// such struct; a slice on the stack (f().len) has its own form in memberToWat.
function memberOfStackValue(expr: AST.Expr, ctx: CodegenContext): string | null {
  let member = memberValues(ungroup(expr), ctx)
  if (!member) return null
  let { object, start } = member
  const count = member.count
  for (member = memberValues(object, ctx); member; member = memberValues(object, ctx)) {
    object = member.object
    start += member.start
  }
  const type = lookupExprType(object, ctx)
  if (!type || unwrap(type).kind === 'slice' || registersOf(object, ctx) || memoryPlace(object, ctx)) return null
  return selectValues(exprToWat(object, ctx), typeToWasm(type), start, count, ctx)
}

function memberToWat(expr: AST.MemberExpr, ctx: CodegenContext): string {
  const member = expr.member

  if (member.kind === 'field' || member.kind === 'index') {
    // Struct field access: flatten to local.get with field suffix
    // Supports chained access: r.origin.x → local.get $r_origin_x
    const regs = registersOf(expr, ctx)
    if (regs) return registersToWat(regs)
    const picked = memberOfStackValue(expr, ctx)
    if (picked !== null) return picked
  }

  if (member.kind === 'field') {
    // Get the type of the object to check for indexed/pointer-to-indexed
    const objType = lookupExprType(expr.object, ctx)

    // Handle .ptr, .len on slice types
    if (objType?.kind === 'slice') {
      if (member.name === 'ptr' || member.name === 'len') {
        const idx = member.name === 'ptr' ? 0 : 1
        // A slice in memory: load the one part.
        const addr = lvalueAddressOf(expr.object, ctx)
        if (addr !== null) return `(i32.load${atOffset(idx * 4)} ${addr})`
        const full = exprToWat(expr.object, ctx)
        const parts = trySplitMultiValue(full, 2)
        if (parts && isDroppable(parts[1 - idx])) return parts[idx]
        // A slice that comes off the stack (a call, a ?? fallback), or whose
        // other part has to run: drop the part we don't want. For .len, ptr
        // sits under it, so park len first.
        if (idx === 0) return `(block (result i32) ${full} (drop))`
        const tmp = `$__len_${scratchId(expr.span.start)}`
        return `(block (result i32) ${full} (local.set ${tmp}) (drop) (local.get ${tmp}))`
      }
      if (member.name === 'wid') {
        // Element byte size is always compile-time known
        const elemSize = byteSize(RT.tableRow(objType) ?? objType.element)
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
        if (RT.framedArray(objType)) return scannedLength(exprToWat(expr.object, ctx), objType, ctx)
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
        const elemSize = byteSize(RT.tableRow(sliceType) ?? sliceType.element)
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
        if (RT.framedArray(objType)) return scannedLength(exprToWat(expr.object, ctx), objType, ctx)
        throw new Error('Array length must be compile-time known')
      }
      if (member.name === 'wid') {
        const elemSize = byteSize(RT.tableRow(objType) ?? arrayType.element)
        if (elemSize === null) {
          throw new Error(`Cannot determine element size for ${arrayType.element.kind}`)
        }
        return `(i32.const ${elemSize})`
      }
    }
  }

  if (member.kind === 'field' || member.kind === 'index') {
    // A member of a struct in memory (iovecs[0].len, p.x through a pointer,
    // xs[i].b.c): load it from its offset.
    const addr = lvalueAddressOf(expr, ctx)
    const type = addr === null ? undefined : lookupExprType(expr, ctx)
    if (addr !== null && type) return loadFromMemory(type, addr, ctx)
    return exprToWat(expr.object, ctx)
  }

  if (member.kind === 'deref') {
    // Pointer dereference: .* - load from memory
    const ptr = exprToWat(expr.object, ctx)
    const type = lookupExprType(expr, ctx)
    if (!type) {
      throw new Error(`Missing type for pointer dereference at offset ${expr.span.start}`)
    }
    return loadFromMemory(type, ptr, ctx)
  }

  if (member.kind === 'type') {
    // Type pun: ptr.u64 → reinterprets the pointer, no load
    // The result is a many-pointer [*]T — actual loads happen at index/deref
    return exprToWat(expr.object, ctx)
  }

  return exprToWat(expr.object, ctx)
}

function indexOffset(object: AST.Expr, base: string, index: string, ctx: CodegenContext): { offset: string; elemSize: number } {
  const arrayType = lookupExprType(object, ctx)
  let elemSize = 1
  // The elements of a table are its row pointers.
  const row = arrayType && RT.tableRow(arrayType)
  if (row) {
    elemSize = byteSize(row) ?? 4
  } else if (arrayType) {
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
  const regs = registersOf(expr, ctx)
  if (regs) return registersToWat(regs)
  const picked = memberOfStackValue(expr, ctx)
  if (picked !== null) return picked

  // Get result type
  const type = lookupExprType(expr, ctx)
  if (!type) {
    throw new Error(`Missing type for index expression at offset ${expr.span.start}`)
  }
  // Multi-dim indexing returns a pointer — just compute address, don't load
  if (isRowIndex(expr, ctx)) return elementAddress(expr, ctx)
  if (ctx.unproven.has(expr)) return checkedIndexToWat(expr, type, ctx)
  const addr = lvalueAddressOf(expr, ctx)
  if (addr === null) throw new Error(`Cannot index this expression at offset ${expr.span.start}`)
  return loadFromMemory(type, addr, ctx)
}

// xs[i] with an index not known to be in range, on a slice or a *[N]T of
// pointers or slices: the element, an optional, is none (0) when i is out of
// range. The container and the index are evaluated once, in that order; parts
// that are locals or constants are used as they are.
function checkedIndexToWat(expr: AST.IndexExpr, type: ResolvedType, ctx: CodegenContext): string {
  const objType = lookupExprType(expr.object, ctx)
  const u = objType && unwrap(objType)
  const setup: string[] = []
  const keep = (wat: string): string => {
    if (isSimple(wat)) return wat
    const local = scratchLocal(ctx, 'i32')
    setup.push(`(local.set ${local} ${wat})`)
    return `(local.get ${local})`
  }
  const obj = exprToWat(expr.object, ctx)
  let base: string
  let len: string
  if (u?.kind === 'slice') {
    const parts = trySplitMultiValue(obj, 2)
    if (parts) {
      base = keep(parts[0])
      len = keep(parts[1])
    } else {
      const [ptr, length] = [scratchLocal(ctx, 'i32'), scratchLocal(ctx, 'i32')]
      setup.push(obj, `(local.set ${length})`, `(local.set ${ptr})`)
      base = `(local.get ${ptr})`
      len = `(local.get ${length})`
    }
  } else if (u?.kind === 'pointer' && u.pointee.kind === 'array' && typeof u.pointee.sizes?.[0] === 'number') {
    base = keep(obj)
    len = `(i32.const ${u.pointee.sizes[0]})`
  } else if (u && RT.framedArray(u)) {
    base = keep(obj)
    len = keep(scannedLength(base, u, ctx))
  } else {
    throw new Error(`Cannot check this index at offset ${expr.span.start}`)
  }
  const index = keep(exprToWat(expr.index, ctx))
  const results = typeToWasm(type).join(' ')
  const { offset } = indexOffset(expr.object, base, index, ctx)
  const none = typeToWasm(type).map((t) => `(${t}.const 0)`).join(' ')
  const value = `(if (result ${results}) (i32.lt_u ${index} ${len}) (then ${loadFromMemory(type, offset, ctx)}) (else ${none}))`
  return setup.length === 0 ? value : `(block (result ${results})\n${setup.join('\n')}\n${value})`
}

// items[start..end]: (ptr + start * stride, end - start). Parts that are
// locals or constants are used directly, so a proven range stays two plain
// values; anything else goes through a scratch local, evaluated once. An
// optional result (?[]T) is (0, 0) unless start <= end <= length.
function sliceToWat(expr: AST.SliceExpr, ctx: CodegenContext): string {
  const resultType = lookupExprType(expr, ctx)
  const objType = lookupExprType(expr.object, ctx)
  if (resultType?.kind !== 'slice' || !objType) throw new Error(`Missing types for range at offset ${expr.span.start}`)
  const u = unwrap(objType)
  const stride = byteSize(RT.tableRow(resultType) ?? resultType.element) ?? 1
  const uid = scratchId(expr.span.start)
  const setup: string[] = []
  const simple = (wat: string) => /^\((local\.get \$[\w-]+|i32\.const -?\d+)\)$/.test(wat)
  // A part as a plain expression, through the named scratch local if needed.
  const keep = (wat: string, name: string): string => {
    if (simple(wat)) return wat
    setup.push(`(local.set $__sl_${name}_${uid} ${wat})`)
    return `(local.get $__sl_${name}_${uid})`
  }

  const obj = exprToWat(expr.object, ctx)
  let ptr: string
  let len: string | null
  if (u.kind === 'slice') {
    const parts = trySplitMultiValue(obj, 2)
    if (parts) {
      ptr = keep(parts[0], 'p')
      len = keep(parts[1], 'n')
    } else {
      setup.push(obj, `(local.set $__sl_n_${uid})`, `(local.set $__sl_p_${uid})`)
      ptr = `(local.get $__sl_p_${uid})`
      len = `(local.get $__sl_n_${uid})`
    }
  } else {
    ptr = keep(obj, 'p')
    const pointee = u.kind === 'pointer' ? unwrap(u.pointee) : null
    const size = pointee?.kind === 'array' && typeof pointee.sizes?.[0] === 'number' ? pointee.sizes[0] : null
    len = size !== null ? `(i32.const ${size})` : null
  }
  const start = expr.start ? keep(exprToWat(expr.start, ctx), 'a') : '(i32.const 0)'
  const endWat = expr.end ? exprToWat(expr.end, ctx) : len
  if (!endWat) throw new Error('a range on a many-pointer needs an end')
  const end = keep(endWat, 'b')

  const first = start === '(i32.const 0)' ? ptr
    : stride === 1 ? `(i32.add ${ptr} ${start})`
    : `(i32.add ${ptr} (i32.mul ${start} (i32.const ${stride})))`
  const count = start === '(i32.const 0)' ? end : `(i32.sub ${end} ${start})`
  let value: string
  if (!resultType.optional) {
    value = `${first} ${count}`
  } else {
    const fits = `(i32.and (i32.le_u ${start} ${end}) (i32.le_u ${end} ${len}))`
    value = `(if (result i32 i32) ${fits} (then ${first} ${count}) (else (i32.const 0) (i32.const 0)))`
  }
  if (setup.length === 0) return value
  return `(block (result i32 i32)\n${setup.join('\n')}\n${value})`
}

// dst[a..b] = v (fill) or dst[a..b] = src (copy), as memory.fill/memory.copy.
// The checker has proven the range in bounds and, for a copy, the lengths equal.
function rangeAssignToWat(target: AST.SliceExpr, value: AST.Expr, ctx: CodegenContext): string {
  const dstType = lookupExprType(target, ctx)
  if (dstType?.kind !== 'slice') throw new Error(`Missing type for range at offset ${target.span.start}`)
  const elem = dstType.element
  const stride = byteSize(RT.tableRow(dstType) ?? elem) ?? 1
  const uid = scratchId(target.span.start)
  const p = `$__bulk_p_${uid}`
  const n = `$__bulk_n_${uid}`
  const setDst = `${sliceToWat(target, ctx)}\n(local.set ${n})\n(local.set ${p})`
  const bytes = stride === 1 ? `(local.get ${n})` : `(i32.mul (local.get ${n}) (i32.const ${stride}))`
  const valueType = lookupExprType(value, ctx)
  const vu = valueType ? unwrap(valueType) : null
  const isScalar = vu?.kind === 'primitive' || vu?.kind === 'comptime_int' || vu?.kind === 'comptime_float'

  if (!isScalar) {
    // Copy: the source pointer is the first part of a slice, or the pointer itself.
    const src = exprToWat(value, ctx)
    let srcPtr: string
    if (vu?.kind === 'slice') {
      srcPtr = slicePointer(src)
    } else {
      srcPtr = src
    }
    return `${setDst}\n(memory.copy (local.get ${p}) ${srcPtr} ${bytes})`
  }

  const v = exprToWat(value, ctx)
  const isZero = /^\((i32|i64|f32|f64)\.const (0|0x0|-?0\.0+|0e0)\)$/.test(v)
  if (stride === 1 || isZero) {
    // Bytes, or zeros of any width: one memory.fill.
    return `${setDst}\n(memory.fill (local.get ${p}) ${isZero ? '(i32.const 0)' : v} ${bytes})`
  }
  // Wider elements: store each one.
  const t = `$__bulk_v_${uid}`
  return `${setDst}
(local.set ${t} ${v})
(block $__fill_${uid}
  (loop $__fill_next_${uid}
    (br_if $__fill_${uid} (i32.eqz (local.get ${n})))
    ${storeToMemory(elem, `(local.get ${p})`, `(local.get ${t})`, ctx)}
    (local.set ${p} (i32.add (local.get ${p}) (i32.const ${stride})))
    (local.set ${n} (i32.sub (local.get ${n}) (i32.const 1)))
    (br $__fill_next_${uid})))`
}

// &items[i]: the element's address. For an optional result (?*T, when the
// index isn't known to be in range) it's 0 when i is out of range.
function addressOfIndexToWat(expr: AST.UnaryExpr, target: AST.IndexExpr, ctx: CodegenContext): string | null {
  const resultType = lookupExprType(expr, ctx)
  const objType = lookupExprType(target.object, ctx)
  if (resultType?.kind !== 'pointer' || !objType) return null
  const u = unwrap(objType)
  let base = exprToWat(target.object, ctx)
  let len: string
  if (u.kind === 'slice') {
    const parts = trySplitMultiValue(base, 2)
    if (!parts) throw new Error('&items[i] on a slice expression: assign the slice to a let first')
    ;[base, len] = parts
  } else if (u.kind === 'pointer' && u.pointee.kind === 'array' && typeof u.pointee.sizes?.[0] === 'number') {
    len = `(i32.const ${u.pointee.sizes[0]})`
  } else if (u.kind === 'pointer' && u.pointee.kind === 'array' && u.pointee.sizes === null) {
    // A many-pointer's element: its address, unchecked.
    return indexOffset(target.object, base, exprToWat(target.index, ctx), ctx).offset
  } else {
    return null
  }
  if (!resultType.optional) {
    // The length isn't used, but still runs if it could trap or has effects.
    if (u.kind === 'slice' && !isDroppable(len)) base = `(block (result i32) ${base} ${len} (drop))`
    return indexOffset(target.object, base, exprToWat(target.index, ctx), ctx).offset
  }
  const idx = `$__addr_idx_${scratchId(expr.span.start)}`
  const { offset } = indexOffset(target.object, base, `(local.get ${idx})`, ctx)
  return `(if (result i32) (i32.lt_u (local.tee ${idx} ${exprToWat(target.index, ctx)}) ${len}) (then ${offset}) (else (i32.const 0)))`
}

// The length of a null-terminated *[!]T (or [!]T): how many elements come
// before the first one whose bytes are all zero, as the data packer ends it.
// Each element is read as one integer of its width (the checker allows 1, 2,
// 4 or 8 bytes); a row of a table is its pointer. `ptr` is evaluated once.
function scannedLength(ptr: string, objType: ResolvedType, ctx: CodegenContext): string {
  const framed = RT.framedArray(objType)
  if (!framed) throw new Error(`no length to scan for in ${RT.typeToString(objType)}`)
  const width = byteSize(RT.tableRow(objType) ?? framed.element)
  const load = width === 1 ? 'i32.load8_u' : width === 2 ? 'i32.load16_u' : width === 4 ? 'i32.load' : width === 8 ? 'i64.load' : null
  if (!load) throw new Error(`cannot scan for the end of ${RT.typeToString(objType)}`)
  const zero = width === 8 ? 'i64.eqz' : 'i32.eqz'
  const at = scratchLocal(ctx, 'i32')
  const n = scratchLocal(ctx, 'i32')
  const label = `$__scan${at.slice(1)}`
  const element = width === 1 ? `(i32.add (local.get ${at}) (local.get ${n}))` : `(i32.add (local.get ${at}) (i32.mul (local.get ${n}) (i32.const ${width})))`
  return `(block (result i32) (local.set ${at} ${ptr}) (local.set ${n} (i32.const 0)) (block ${label} (loop ${label}_next (br_if ${label} (${zero} (${load} ${element}))) (local.set ${n} (i32.add (local.get ${n}) (i32.const 1))) (br ${label}_next))) (local.get ${n}))`
}

function evalComptimeIndex(expr: AST.Expr): number | null {
  if (expr.kind === 'LiteralExpr' && expr.value.kind === 'int') {
    return Number(expr.value.value)
  }
  if (expr.kind === 'AnnotationExpr') return evalComptimeIndex(expr.expr)
  return null
}

// How many times a repeat literal repeats its value: a count written as a
// constant expression ([0; k]) has the value the checker worked out.
function repeatCount(expr: AST.RepeatExpr, ctx: CodegenContext): number | null {
  const constant = ctx.constants.get(expr.count)
  return evalComptimeIndex(expr.count) ?? (constant?.kind === 'int' ? Number(constant.value) : null)
}

// Whether the elements an index expression reads are optionals themselves
// (in a []?*T): then if let and ?? check the element as well as the index,
// as for any optional, reading it none when the index is out of range. An
// array value ([3]?*T, also a field of a struct in memory) is indexed only by
// a constant in range, so only its element is checked.
function holdsOptionals(expr: AST.IndexExpr, ctx: CodegenContext): boolean {
  const objType = lookupExprType(expr.object, ctx)
  const u = objType && unwrap(objType)
  const pointee = u?.kind === 'pointer' ? unwrap(u.pointee) : null
  const element = u?.kind === 'slice' || u?.kind === 'array' ? u.element : pointee?.kind === 'array' ? pointee.element : null
  return element !== null && RT.isOptional(unwrap(element))
}

function coalesceToWat(expr: AST.CoalesceExpr, ctx: CodegenContext): string {
  const elemType = ctx.types.get(typeKey(expr.span.start, 'CoalesceBinding'))
  if (!elemType) throw new Error('Missing element type for coalesce')

  const fallbackVal = exprToWat(expr.fallback, ctx)
  const resultTypes = typeToWasm(elemType)
  const resultStr = `(result ${resultTypes.join(' ')})`

  // Check if this is a bounds-checked index expression
  if (expr.expr.kind === 'IndexExpr' && !holdsOptionals(expr.expr, ctx)) {
    return coalesceIndexToWat(expr.expr, elemType, fallbackVal, resultStr, scratchId(expr.span.start), ctx)
  }

  // Generic optional unwrap: check ptr != 0
  const uid = scratchId(expr.span.start)
  const ptrLocal = `__coal_ptr_${uid}`
  const parts: string[] = []
  const leftWat = exprToWat(expr.expr, ctx)

  if (resultTypes.length === 2) {
    // Slice optional: (ptr, len) — check ptr component
    const lenLocal = `__coal_len_${uid}`
    parts.push(`${leftWat}\n(local.set $${lenLocal})\n(local.set $${ptrLocal})`)
    return `${parts.join('\n')}\n(if ${resultStr} (local.get $${ptrLocal}) (then (local.get $${ptrLocal}) (local.get $${lenLocal})) (else ${fallbackVal}))`
  }

  // Pointer optional: single i32 — check nonzero
  parts.push(`(local.set $${ptrLocal} ${leftWat})`)
  return `${parts.join('\n')}\n(if ${resultStr} (local.get $${ptrLocal}) (then (local.get $${ptrLocal})) (else ${fallbackVal}))`
}

function coalesceIndexToWat(indexExpr: AST.IndexExpr, elemType: ResolvedType, fallbackVal: string, resultStr: string, uid: number, ctx: CodegenContext): string {
  const idxLocal = `__coal_idx_${uid}`
  const ptrLocal = `__coal_ptr_${uid}`
  const lenLocal = `__coal_len_${uid}`

  const objType = lookupExprType(indexExpr.object, ctx)

  const parts: string[] = []
  parts.push(`(local.set $${idxLocal} ${exprToWat(indexExpr.index, ctx)})`)

  if (objType?.kind === 'slice') {
    const obj = exprToWat(indexExpr.object, ctx)
    parts.push(`${obj}\n(local.set $${lenLocal})\n(local.set $${ptrLocal})`)
  } else if (objType?.kind === 'pointer' && objType.pointee.kind === 'array') {
    parts.push(`(local.set $${ptrLocal} ${exprToWat(indexExpr.object, ctx)})`)
    const arrayType = objType.pointee
    // N, also of a packed *[NxM]T, whose rows are counted the same way
    if (arrayType.sizes && typeof arrayType.sizes[0] === 'number') {
      parts.push(`(local.set $${lenLocal} (i32.const ${arrayType.sizes[0]}))`)
    } else if (RT.framedArray(objType)) {
      parts.push(`(local.set $${lenLocal} ${scannedLength(`(local.get $${ptrLocal})`, objType, ctx)})`)
    }
  } else if (objType && RT.framedArray(objType)) {
    parts.push(`(local.set $${ptrLocal} ${exprToWat(indexExpr.object, ctx)})`)
    parts.push(`(local.set $${lenLocal} ${scannedLength(`(local.get $${ptrLocal})`, objType, ctx)})`)
  }

  const elemSize = byteSize(elemType) ?? 1
  const boundsCheck = `(i32.lt_u (local.get $${idxLocal}) (local.get $${lenLocal}))`
  const offset = elemSize === 1
    ? `(i32.add (local.get $${ptrLocal}) (local.get $${idxLocal}))`
    : `(i32.add (local.get $${ptrLocal}) (i32.mul (local.get $${idxLocal}) (i32.const ${elemSize})))`
  const loadVal = isRowIndex(indexExpr, ctx)
    ? indexOffset(indexExpr.object, `(local.get $${ptrLocal})`, `(local.get $${idxLocal})`, ctx).offset
    : loadFromMemory(elemType, offset, ctx)

  return `${parts.join('\n')}\n(if ${resultStr} ${boundsCheck} (then ${loadVal}) (else ${fallbackVal}))`
}

function ifLetToWat(expr: AST.IfExpr, ctx: CodegenContext): string {
  const pattern = expr.pattern
  if (!pattern || pattern.kind !== 'binding') {
    throw new Error('Invalid if-let expression')
  }

  const elemType = ctx.types.get(typeKey(expr.condition.span.start, 'IfLetBinding'))
  if (!elemType) throw new Error('Missing element type for if-let')

  // As a value, each branch leaves its last expression on the stack.
  const type = lookupExprType(expr, ctx)
  const resultTypes = type ? typeToWasm(type) : []
  const resultStr = resultTypes.length > 0 ? `(result ${resultTypes.join(' ')})` : ''
  // The binding is seen in the then-branch only.
  const found = ctx.bindings?.get(expr)
  if (!found) throw new Error(`Missing local for if-let binding '${pattern.name}'`)
  const bindingNames = found
  const thenBody = withBinding(ctx, pattern.name, bindingNames, () => bodyToWat(expr.thenBranch, ctx, resultTypes.length > 0))
  const elseBody = elseToWat(expr, ctx, resultTypes.length > 0, resultStr)
  function makeBind(loadVal: string): string {
    if (bindingNames.length === 1) {
      return `(local.set $${bindingNames[0]} ${loadVal})`
    }
    const sets = [...bindingNames].reverse().map(n => `(local.set $${n})`).join('\n')
    return `${loadVal}\n${sets}`
  }

  // Index expression: bounds check
  if (expr.condition.kind === 'IndexExpr' && !holdsOptionals(expr.condition, ctx)) {
    const indexExpr = expr.condition
    const uid = scratchId(expr.span.start)
    const idxLocal = `__iflet_idx_${uid}`
    const ptrLocal = `__iflet_ptr_${uid}`
    const lenLocal = `__iflet_len_${uid}`

    const objType = lookupExprType(indexExpr.object, ctx)

    const parts: string[] = []
    parts.push(`(local.set $${idxLocal} ${exprToWat(indexExpr.index, ctx)})`)

    if (objType?.kind === 'slice') {
      const obj = exprToWat(indexExpr.object, ctx)
      parts.push(`${obj}\n(local.set $${lenLocal})\n(local.set $${ptrLocal})`)
    } else if (objType?.kind === 'pointer' && objType.pointee.kind === 'array') {
      parts.push(`(local.set $${ptrLocal} ${exprToWat(indexExpr.object, ctx)})`)
      const arrayType = objType.pointee
      // N, also of a packed *[NxM]T, whose rows are counted the same way
      if (arrayType.sizes && typeof arrayType.sizes[0] === 'number') {
        parts.push(`(local.set $${lenLocal} (i32.const ${arrayType.sizes[0]}))`)
      } else if (RT.framedArray(objType)) {
        parts.push(`(local.set $${lenLocal} ${scannedLength(`(local.get $${ptrLocal})`, objType, ctx)})`)
      } else {
        parts.push(`(local.set $${lenLocal} (i32.const 0))`)
      }
    } else if (objType && RT.framedArray(objType)) {
      parts.push(`(local.set $${ptrLocal} ${exprToWat(indexExpr.object, ctx)})`)
      parts.push(`(local.set $${lenLocal} ${scannedLength(`(local.get $${ptrLocal})`, objType, ctx)})`)
    } else {
      parts.push(`(local.set $${ptrLocal} ${exprToWat(indexExpr.object, ctx)})`)
      parts.push(`(local.set $${lenLocal} (i32.const 0))`)
    }

    const elemSize = byteSize(elemType) ?? 1
    const boundsCheck = `(i32.lt_u (local.get $${idxLocal}) (local.get $${lenLocal}))`
    const offset = elemSize === 1
      ? `(i32.add (local.get $${ptrLocal}) (local.get $${idxLocal}))`
      : `(i32.add (local.get $${ptrLocal}) (i32.mul (local.get $${idxLocal}) (i32.const ${elemSize})))`
    const loadVal = isRowIndex(indexExpr, ctx)
      ? indexOffset(indexExpr.object, `(local.get $${ptrLocal})`, `(local.get $${idxLocal})`, ctx).offset
      : loadFromMemory(elemType, offset, ctx)
    const bindWat = makeBind(loadVal)

    if (elseBody) {
      return `${parts.join('\n')}\n(if ${resultStr} ${boundsCheck} (then ${bindWat}\n${thenBody}) (else ${elseBody}))`
    }
    return `${parts.join('\n')}\n(if ${resultStr} ${boundsCheck} (then ${bindWat}\n${thenBody}))`
  }

  // Generic optional expression: null check (ptr != 0)
  const uid = scratchId(expr.span.start)
  const ptrLocal = `__iflet_ptr_${uid}`
  const parts: string[] = []
  const condWat = exprToWat(expr.condition, ctx)

  if (bindingNames.length >= 2) {
    // Slice optional: (ptr, len) — check ptr, bind both
    const lenLocal = `__iflet_len_${uid}`
    parts.push(`${condWat}\n(local.set $${lenLocal})\n(local.set $${ptrLocal})`)
    const bindWat = bindingNames.map((n, i) =>
      `(local.set $${n} (local.get $${i === 0 ? ptrLocal : lenLocal}))`
    ).join('\n')
    if (elseBody) {
      return `${parts.join('\n')}\n(if ${resultStr} (local.get $${ptrLocal}) (then ${bindWat}\n${thenBody}) (else ${elseBody}))`
    }
    return `${parts.join('\n')}\n(if ${resultStr} (local.get $${ptrLocal}) (then ${bindWat}\n${thenBody}))`
  }

  // Pointer optional: single i32
  parts.push(`(local.set $${ptrLocal} ${condWat})`)
  const bindWat = `(local.set $${bindingNames[0]} (local.get $${ptrLocal}))`
  if (elseBody) {
    return `${parts.join('\n')}\n(if ${resultStr} (local.get $${ptrLocal}) (then ${bindWat}\n${thenBody}) (else ${elseBody}))`
  }
  return `${parts.join('\n')}\n(if ${resultStr} (local.get $${ptrLocal}) (then ${bindWat}\n${thenBody}))`
}

function ifExprToWat(expr: AST.IfExpr, ctx: CodegenContext): string {
  if (expr.pattern) {
    return ifLetToWat(expr, ctx)
  }

  const cond = exprToWat(expr.condition, ctx)

  // Get result type
  const type = lookupExprType(expr, ctx)
  const resultTypes = type ? typeToWasm(type) : []
  const resultStr = resultTypes.length > 0 ? `(result ${resultTypes.join(' ')})` : ''
  const hasResult = resultTypes.length > 0

  const thenBody = bodyToWat(expr.thenBranch, ctx, hasResult)
  const elseBody = elseToWat(expr, ctx, hasResult, resultStr)

  if (elseBody) {
    return `(if ${resultStr} ${cond} (then ${thenBody}) (else ${elseBody}))`
  }
  return `(if ${resultStr} ${cond} (then ${thenBody}))`
}

// What an if or if-let does when its first test fails: the elif branches,
// as nested ifs, then the else branch. Empty when it has neither.
function elseToWat(expr: AST.IfExpr, ctx: CodegenContext, hasResult: boolean, resultStr: string): string {
  let current = expr.else_ ? bodyToWat(expr.else_, ctx, hasResult) : ''
  for (let i = expr.elifs.length - 1; i >= 0; i--) {
    const elif = expr.elifs[i]
    const elifCond = exprToWat(elif.condition, ctx)
    const elifThen = bodyToWat(elif.thenBranch, ctx, hasResult)
    current = `(if ${resultStr} ${elifCond} (then ${elifThen}) (else ${current}))`
  }
  return current
}

function tupleToWat(expr: AST.TupleExpr, ctx: CodegenContext): string {
  // Flatten tuple elements
  const parts = expr.elements.map((elem) => {
    // Shorthand `name:` stands for the variable of that name.
    const value = argValue(elem)
    return value ? exprToWat(value, ctx) : ''
  })
  return parts.filter(Boolean).join(' ')
}

// Whether `wat` is one parenthesized expression, not several side by side.
function isSingleExpr(wat: string): boolean {
  let depth = 0
  for (let i = 0; i < wat.length; i++) {
    if (wat[i] === '(') depth++
    else if (wat[i] === ')' && --depth === 0) return i === wat.length - 1
  }
  return false
}

// An i32 widened to i64. The bit count of an i64 (clz, ctz, popcnt) is computed
// in 64 bits and wrapped to its u8 result: widening it again is the count
// itself, so `x >> ctz(x)` on a u64 stays two instructions.
function extendToI64(wat: string, signed: boolean): string {
  const count = /^\(i32\.wrap_i64 (\(i64\.(?:clz|ctz|popcnt) [\s\S]*\))\)$/.exec(wat)
  if (count && isSingleExpr(count[1])) return count[1]
  return `(i64.extend_i32_${signed ? 's' : 'u'} ${wat})`
}

function emitConversion(inner: string, fromType: ResolvedType, toType: ResolvedType): string {
  // A pointer to an array into a slice: the length the array has
  if (unwrap(toType).kind === 'slice') {
    const len = RT.arrayLength(fromType)
    return len === null ? inner : `${inner} (i32.const ${len})`
  }
  const fromWasm = typeToWasmSingle(fromType)
  const toWasm = typeToWasmSingle(toType)

  // Wide integers (128 bits and up) are several i64 values, least significant
  // first. Their first wasm type is i64, so handle them before the same-type
  // shortcut below.
  const fromWide = wideIntParts(fromType)
  const toWide = wideIntParts(toType)
  if ((fromWide > 0 || toWide > 0) && !isFloat(fromType) && !isFloat(toType)) {
    const fromParts = Math.max(fromWide, 1)
    const toParts = Math.max(toWide, 1)
    let wat = fromWasm === 'i32' ? extendToI64(inner, isSigned(fromType)) : inner
    if (toParts < fromParts) {
      // Narrowing keeps the low parts: drop the high ones off the top of the stack.
      wat += ' ' + Array(fromParts - toParts).fill('(drop)').join(' ')
    } else if (toParts > fromParts) {
      // Unsigned: zero high parts. Signed: copies of the sign, which a helper
      // computes so the source is evaluated once.
      wat = isSigned(fromType)
        ? wideCall(fromParts, `sext_${toParts}`, wat)
        : `${wat} ${Array(toParts - fromParts).fill('(i64.const 0)').join(' ')}`
    }
    if (toWasm === 'i32' && toParts === 1) wat = truncateSubWord(`${wat} (i32.wrap_i64)`, toType)
    return wat
  }

  if (fromWasm === toWasm) {
    const toU = unwrap(toType)
    if (toU.kind === 'primitive') {
      if (toU.name === 'u8') return `(i32.and ${inner} (i32.const 255))`
      if (toU.name === 'i8') return `(i32.shr_s (i32.shl ${inner} (i32.const 24)) (i32.const 24))`
      if (toU.name === 'u16') return `(i32.and ${inner} (i32.const 65535))`
      if (toU.name === 'i16') return `(i32.shr_s (i32.shl ${inner} (i32.const 16)) (i32.const 16))`
    }
    return inner
  }

  const fromIsFloat = isFloat(fromType)
  const toIsFloat = isFloat(toType)
  const fromSigned = isSigned(fromType)
  const toSigned = isSigned(toType)

  // An 8- or 16-bit result is cut to its width, as it is when it comes from
  // an i32: every such value fills its i32 the same way (zero- or
  // sign-extended), which comparisons and widening rely on.
  if (fromIsFloat && !toIsFloat) {
    return truncateSubWord(`(${toWasm}.trunc_${fromWasm}_${toSigned ? 's' : 'u'} ${inner})`, toType)
  }
  if (!fromIsFloat && toIsFloat) {
    return `(${toWasm}.convert_${fromWasm}_${fromSigned ? 's' : 'u'} ${inner})`
  }
  if (fromIsFloat && toIsFloat) {
    if (fromWasm === 'f32' && toWasm === 'f64') {
      return `(f64.promote_f32 ${inner})`
    }
    if (fromWasm === 'f64' && toWasm === 'f32') {
      return `(f32.demote_f64 ${inner})`
    }
  }
  if (fromWasm === 'i32' && toWasm === 'i64') {
    return extendToI64(inner, fromSigned)
  }
  if (fromWasm === 'i64' && toWasm === 'i32') {
    return truncateSubWord(`(i32.wrap_i64 ${inner})`, toType)
  }

  return inner
}

function castToWat(expr: AST.CastExpr, ctx: CodegenContext): string {
  const inner = exprToWat(expr.expr, ctx)
  const fromType = lookupExprType(expr.expr, ctx)
  const toType = lookupExprType(expr, ctx)
  if (!fromType || !toType) return inner
  return emitConversion(inner, fromType, toType)
}

function arrayToWat(expr: AST.ArrayExpr, ctx: CodegenContext): string {
  const id = expr.dataId ?? expr.span.start
  const ref = ctx.literalRefs.get(id)
  if (ref) {
    const type = lookupExprType(expr, ctx)
    // Emit runtime stores for mixed arrays (elements that aren't compile-time literals)
    const stores = emitRuntimeSlots(expr, ref, ctx)
    if (type?.kind === 'slice') {
      return `${stores}${literalSliceToWat(ref, type)}`
    }
    return `${stores}(i32.const ${ref.ptr})`
  }
  // Value array literal: emit elements directly as stack values
  return expr.elements.map(e => exprToWat(e, ctx)).join(' ')
}

function emitRuntimeSlots(expr: AST.ArrayExpr | AST.RepeatExpr, ref: { ptr: number; len: number }, ctx: CodegenContext): string {
  const type = lookupExprType(expr, ctx)
  if (!type) return ''
  // Get the element type to determine stride
  const elemType = type.kind === 'slice' ? type.element
    : type.kind === 'pointer' && type.pointee.kind === 'array' ? packedRow(type.pointee)
    : null
  if (!elemType) return ''
  const parts: string[] = []
  runtimeStores(expr, elemType, ref.ptr, ctx, parts)
  return parts.length > 0 ? parts.join('\n') + '\n' : ''
}

// What one element of an array literal is: a row of [NxM]T is a [M]T, which
// lies in place.
function packedRow(t: RT.ArrayRT): ResolvedType {
  const sizes = t.sizes
  if (sizes && sizes.length > 1 && sizes.every((s) => typeof s === 'number')) return { kind: 'array', element: t.element, sizes: sizes.slice(1) }
  return t.element
}

// The stores of the values of a literal that are only known when the program
// runs, each at its place from `base`. A row written out in place (in a
// [NxM]T) has its own, at their places in the row.
function runtimeStores(expr: AST.ArrayExpr | AST.RepeatExpr, elemType: ResolvedType, base: number, ctx: CodegenContext, parts: string[]): void {
  const elemSize = byteSize(elemType) ?? 0
  if (elemSize === 0) return
  const u = unwrap(elemType)
  const inPlace = (elem: AST.Expr): AST.ArrayExpr | AST.RepeatExpr | null => {
    let inner = ungroup(elem)
    while (inner.kind === 'AnnotationExpr') inner = ungroup(inner.expr)
    const row = u.kind === 'array' && u.sizes !== null && u.sizes.every((s) => typeof s === 'number')
    return row && (inner.kind === 'ArrayExpr' || inner.kind === 'RepeatExpr') ? inner : null
  }
  // A repeat literal has its value in every slot, computed once per slot as
  // it is for a repeat that is a value. One with nothing to store has no slot
  // to visit, however many it has.
  if (expr.kind === 'RepeatExpr' && !inPlace(expr.value) && !isRuntimeExpr(expr.value, ctx)) return
  const elements = expr.kind === 'ArrayExpr' ? expr.elements
    : Array<AST.Expr>(repeatCount(expr, ctx) ?? 0).fill(expr.value)
  for (let i = 0; i < elements.length; i++) {
    const elem = elements[i]
    const at = base + i * elemSize
    const row = inPlace(elem)
    if (row && u.kind === 'array') {
      runtimeStores(row, packedRow(u), at, ctx, parts)
    } else if (isRuntimeExpr(elem, ctx)) {
      const value = exprToWat(elem, ctx)
      if (u.kind === 'slice') {
        try {
          const valParts = splitMultiValue(value, 2)
          parts.push(`(i32.store (i32.const ${at}) ${valParts[0]})`)
          parts.push(`(i32.store (i32.const ${at + 4}) ${valParts[1]})`)
        } catch {
          parts.push(`(i32.const ${at})\n${value}\n(local.set $__slot_len)\n(i32.store)\n(i32.store (i32.const ${at + 4}) (local.get $__slot_len))`)
        }
      } else {
        parts.push(storeToMemory(elemType, `(i32.const ${at})`, value, ctx))
      }
    }
  }
}

function isRuntimeExpr(expr: AST.Expr, ctx: CodegenContext): boolean {
  if (expr.kind === 'LiteralExpr') return false
  if (expr.kind === 'ArrayExpr') return false
  if (expr.kind === 'RepeatExpr') return false
  if (expr.kind === 'AnnotationExpr') return isRuntimeExpr(expr.expr, ctx)
  // (x) is x
  const inner = ungroup(expr)
  if (inner !== expr) return isRuntimeExpr(inner, ctx)
  // A value the checker worked out (1 + 1, sizeof(u64), a def, the name of
  // data) is laid out with the literal.
  if (ctx.constants.has(expr)) return false
  // A type that is called, Vec(u32)(p, 0, cap), is the struct of its arguments.
  const built = expr.kind === 'CallExpr' ? ctx.calls.get(expr) : undefined
  if (built?.kind === 'TupleExpr') return isRuntimeExpr(built, ctx)
  // A struct written out from literals, as a tuple or a constructor, is data
  // too; one runtime field makes the whole struct runtime. A type's name is
  // the identifier that starts with a capital letter.
  const fields = expr.kind === 'TupleExpr' ? expr.elements
    : expr.kind === 'CallExpr' && expr.callee.kind === 'IdentExpr' && /^[A-Z]/.test(expr.callee.name) ? expr.args
    : null
  if (fields) return fields.some((field) => !field.value || isRuntimeField(field.value, ctx))
  return true
}

// Inside a struct an array literal is a field of its own ([N]T, or a slice
// that points at it): runtime when one of its elements is, or the value it
// repeats.
function isRuntimeField(expr: AST.Expr, ctx: CodegenContext): boolean {
  let e = ungroup(expr)
  while (e.kind === 'AnnotationExpr') e = ungroup(e.expr)
  if (e.kind === 'ArrayExpr') return e.elements.some((x) => isRuntimeField(x, ctx))
  if (e.kind === 'RepeatExpr') return isRuntimeField(e.value, ctx)
  return isRuntimeExpr(e, ctx)
}

function repeatToWat(expr: AST.RepeatExpr, ctx: CodegenContext): string {
  const id = expr.dataId ?? expr.span.start
  const ref = ctx.literalRefs.get(id)
  if (ref) {
    const type = lookupExprType(expr, ctx)
    // A value only known when the program runs is stored into every slot.
    const stores = emitRuntimeSlots(expr, ref, ctx)
    if (type?.kind === 'slice') {
      return `${stores}${literalSliceToWat(ref, type)}`
    }
    return `${stores}(i32.const ${ref.ptr})`
  }
  // Value repeat literal: emit element N times
  const countVal = repeatCount(expr, ctx)
  if (countVal !== null) {
    const elem = exprToWat(expr.value, ctx)
    return Array(countVal).fill(elem).join(' ')
  }
  return `(i32.const 0)`
}

function matchToWat(expr: AST.MatchExpr, ctx: CodegenContext): string {
  let subject = exprToWat(expr.subject, ctx)
  const subjectType = lookupExprType(expr.subject, ctx)
  const subjectTypes = subjectType ? typeToWasm(subjectType) : ['i32']
  // Each arm's test reads the subject again. Anything but a plain read (a
  // call, arithmetic) is evaluated once, into a scratch local.
  let setup = ''
  if (subjectTypes.length !== 1) {
    // A slice, a tuple, nothing at all: only `_` takes a subject that isn't
    // one wasm value, so no arm reads it and it needs no local. It is still
    // evaluated, for what it does, unless all it does is read.
    if (!/^(?:\((?:local\.get|global\.get|[if](?:32|64)\.const) [^\s()]+\)\s*)*$/.test(subject)) {
      setup = `${[subject, ...subjectTypes.map(() => '(drop)')].join('\n')}\n`
    }
  } else if (!/^\((?:local\.get|global\.get|[if](?:32|64)\.const) [^\s()]+\)$/.test(subject)) {
    const local = `$__match_${scratchId(expr.span.start)}`
    setup = `(local.set ${local} ${subject})\n`
    subject = `(local.get ${local})`
  }
  // Patterns are compared in the subject's type.
  const wt = subjectTypes[0] ?? 'i32'
  const type = lookupExprType(expr, ctx)
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
        ? bodyToWat(arm.body, ctx, resultTypes.length > 0)
        : resultTypes.length > 0 ? exprToWat(arm.body, ctx) : discardedExprToWat(arm.body, ctx)

    if (isWildcard) {
      result = body
    } else {
      // Generate condition for patterns
      const conditions = arm.patterns.map((p) => {
        if (p.kind === 'literal') {
          const litValue =
            p.value.kind === 'int' || p.value.kind === 'float'
              ? `(${wt}.const ${numberText(p.value.value)})`
              : p.value.kind === 'bool'
                ? `(i32.const ${p.value.value ? 1 : 0})`
                : '(i32.const 0)'
          return `(${wt}.eq ${subject} ${litValue})`
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

  return setup + result
}

function sizeofToWat(expr: AST.SizeofExpr, ctx: CodegenContext): string {
  // Get the resolved type from the checker
  const type = lookupExprType(expr, ctx)
  if (type && type.kind === 'comptime_int') {
    // The checker already computed the size and stored it as comptime_int
    return `(i32.const ${type.value})`
  }
  // The operand as the checker resolved it: only the checker knows what a type
  // parameter was bound to.
  const operand = ctx.types.get(typeKey(expr.span.start, 'SizeofType'))
  if (!operand) throw new Error(`Missing type for sizeof operand at offset ${expr.span.start}`)
  return `(i32.const ${byteSize(operand) ?? 0})`
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
      return discardedExprToWat(stmt.expr, ctx)
    case 'DeferStmt':
      // Emitted where control leaves the block; see deferredToWat.
      ctx.deferFrames?.at(-1)?.defers.push(stmt.expr)
      return ''
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
      if (ctx.testMode) {
        return `(if (i32.eqz ${exprToWat(stmt.expr, ctx)}) (then (call $__assert_fail (i32.const ${stmt.span.start})) (unreachable)))`
      }
      return `(if (i32.eqz ${exprToWat(stmt.expr, ctx)}) (then (unreachable)))`
    default:
      throw new Error(`Unhandled statement kind: ${(stmt as AST.Statement).kind}`)
  }
}

// Whether an expression leaves at least one value on the stack.
function exprHasValue(expr: AST.Expr, ctx: CodegenContext): boolean {
  const t = lookupExprType(expr, ctx)
  return !!t && t.kind !== 'void' && typeToWasm(t).length > 0
}

// An expression evaluated for its effect, dropping any result.
function discardedExprToWat(expr: AST.Expr, ctx: CodegenContext): string {
  const exprWat = exprToWat(expr, ctx)
  const exprType = lookupExprType(expr, ctx)
  if (exprType && exprType.kind !== 'void') {
    const slots = typeToWasm(exprType).length
    if (slots > 0) return exprWat + '\n' + Array(slots).fill('(drop)').join('\n')
  }
  return exprWat
}

// The deferred expressions of the innermost `count` open blocks, newest first.
function deferredToWat(ctx: CodegenContext, count: number): string {
  const frames = ctx.deferFrames ?? []
  const out: string[] = []
  for (let f = frames.length - 1; f >= Math.max(0, frames.length - count); f--) {
    for (let d = frames[f].defers.length - 1; d >= 0; d--) out.push(discardedExprToWat(frames[f].defers[d], ctx))
  }
  return out.join('\n')
}

// How many open blocks a break or continue leaves: up to the nearest loop body.
function framesToLoop(ctx: CodegenContext): number {
  const frames = ctx.deferFrames ?? []
  for (let f = frames.length - 1; f >= 0; f--) if (frames[f].loop) return frames.length - f
  return frames.length
}

// The local.set / drop sequence that unpacks a tuple value on the stack into a
// tuple pattern's variables. Elements match fields by name (x:, x: y) or by
// position (a, b); a field no element names is dropped. Values come off the
// stack last field first, and a field that flattens to several wasm values
// fills (or drops) that many. An element that is a tuple pattern itself takes
// its field the same way. `registers` says where a variable is held: a `let`
// declares locals, and a `set` writes the locals or globals that are there.
function tuplePatternSets(
  pattern: AST.TuplePattern,
  tupleType: RT.TupleRT,
  ctx: CodegenContext,
  registers: (name: string) => Registers | null = (name) => ({ names: ctx.locals.get(name) ?? [name], global: false }),
): string {
  const partFor = new Map<number, AST.Pattern>()
  pattern.elements.forEach((elem, position) => {
    if (elem.kind === 'named') {
      const index = tupleType.fields.findIndex((f) => f.name === elem.field)
      if (index >= 0) partFor.set(index, { kind: 'IdentPattern', name: elem.binding ?? elem.field, span: pattern.span })
    } else {
      partFor.set(position, elem.pattern)
    }
  })
  const sets: string[] = []
  for (let i = tupleType.fields.length - 1; i >= 0; i--) {
    const fieldType = tupleType.fields[i].type
    const part = partFor.get(i)
    const inner = unwrap(fieldType)
    if (part?.kind === 'TuplePattern' && inner.kind === 'tuple') {
      sets.push(tuplePatternSets(part, inner, ctx, registers))
      continue
    }
    const slots = typeToWasm(fieldType).length
    const regs = part?.kind === 'IdentPattern' ? registers(part.name) : null
    for (let k = slots - 1; k >= 0; k--) {
      const name = regs?.names[k]
      sets.push(regs && name ? `(${regs.global ? 'global' : 'local'}.set $${name})` : '(drop)')
    }
  }
  return sets.join('\n')
}

// From a `let` or a `for` on, the names it declares stand for its variables,
// as the checker has them: a `for` of a name in one branch and a `let` of it
// in another are two variables.
function enterDeclared(stmt: AST.LetStmt | AST.ForStmt, ctx: CodegenContext): void {
  for (const [name, names] of ctx.declared?.get(stmt) ?? []) ctx.locals.set(name, names)
}

function letToWat(stmt: AST.LetStmt, ctx: CodegenContext): string {
  if (!stmt.value) {
    enterDeclared(stmt, ctx)
    return '' // Declaration only, no initialization
  }
  // The value is computed before the variable is there.
  const valueWat = exprToWat(stmt.value, ctx)
  enterDeclared(stmt, ctx)

  if (stmt.pattern.kind === 'IdentPattern') {
    const name = stmt.pattern.name
    const value = valueWat

    // Get type from pattern offset (where checker stores it) - must be concretized
    const type = ctx.types.get(typeKey(stmt.pattern.span.start, stmt.pattern.kind))
    if (!type) {
      throw new Error(`Missing type for local '${name}' at offset ${stmt.pattern.span.start}`)
    }
    // The locals collectLocals gave the variable.
    const names = ctx.locals.get(name)
    if (!names) throw new Error(`Missing locals for '${name}' at offset ${stmt.pattern.span.start}`)
    if (names.length === 1) return `(local.set $${names[0]} ${value})`
    // If value is a single expression producing multiple results (e.g. a function call),
    // emit the call then assign from the stack in reverse order
    // Try to split value into components (works for multi-expression values)
    try {
      const topLevelParts = splitMultiValue(value, names.length)
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

    return `${valueWat}\n${tuplePatternSets(stmt.pattern, tupleType, ctx)}`
  }

  return ''
}

function setToWat(stmt: AST.SetStmt, ctx: CodegenContext): string {
  const value = exprToWat(stmt.value, ctx)
  // set names variables that are there already: locals or globals.
  const registers = (name: string) => registersOf({ kind: 'IdentExpr', name, span: stmt.pattern.span }, ctx)

  if (stmt.pattern.kind === 'IdentPattern') {
    // set x = v is x = v.
    const regs = registers(stmt.pattern.name)
    if (regs) return setRegisters(regs, value)
    return `(local.set $${stmt.pattern.name} ${value})`
  }

  if (stmt.pattern.kind === 'TuplePattern') {
    // Get tuple type from the value expression
    const valueType = lookupExprType(stmt.value, ctx)
    const tupleType = valueType && unwrap(valueType)
    if (!tupleType || tupleType.kind !== 'tuple') {
      throw new Error(`Missing tuple type for set pattern at offset ${stmt.pattern.span.start}`)
    }

    return `${value}\n${tuplePatternSets(stmt.pattern, tupleType, ctx, registers)}`
  }

  return ''
}

function coerceWasmType(wat: string, fromWt: string, toWt: string, signed: boolean): string {
  if (fromWt === toWt) return wat
  if (fromWt === 'i32' && toWt === 'i64') return extendToI64(wat, signed)
  if (fromWt === 'i64' && toWt === 'i32') return `(i32.wrap_i64 ${wat})`
  return wat
}

function assignToWat(stmt: AST.AssignmentStmt, ctx: CodegenContext): string {
  if (stmt.target.kind === 'SliceExpr') return rangeAssignToWat(stmt.target, stmt.value, ctx)
  const value = exprToWat(stmt.value, ctx)
  const isPlace = stmt.target.kind === 'IdentExpr' || stmt.target.kind === 'MemberExpr' || stmt.target.kind === 'IndexExpr'
  const placeType = isPlace ? lookupExprType(stmt.target as AST.Expr, ctx) : undefined

  // Handle compound assignment operators
  if (stmt.op !== '=') {
    let current = lvalueToWat(stmt.target, ctx)
    let assign = (result: string) => assignLvalue(stmt.target, result, ctx)
    // x op= v reads and writes one place, so its address is evaluated once:
    // one with effects (xs[next()] += 1) goes into a scratch local.
    const addr = isPlace ? lvalueAddressOf(stmt.target as AST.Expr, ctx) : null
    if (addr !== null && placeType && !isRepeatable(addr)) {
      const tmp = scratchLocal(ctx, 'i32')
      current = loadFromMemory(placeType, `(local.get ${tmp})`, ctx)
      assign = (result) => `(local.set ${tmp} ${addr})\n${storeToMemory(placeType, `(local.get ${tmp})`, result, ctx)}`
    }
    // x op= v is x = x op v in x's type: the checker has widened v to it.
    const type = placeType
    if (!type) {
      throw new Error(`Missing type for assignment at offset ${stmt.target.span.start}`)
    }
    const op = stmt.op.slice(0, -1)
    const rhs = SHIFT_OPS.has(op) ? shiftCountToWat(value, valueType(stmt.value, ctx), type) : value
    const nv = wideIntParts(type)
    const result = nv > 1
      ? wideCall(nv, wideBinaryOp(op, isSigned(type), type), current, rhs)
      : scalarBinaryToWat(op, type, current, rhs)
    return assign(result)
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

// Assigns a value to a place: the registers of a variable or of a member of
// one, or memory.
function assignLvalue(target: AST.LValue, value: string, ctx: CodegenContext): string {
  if (target.kind !== 'IdentExpr' && target.kind !== 'MemberExpr' && target.kind !== 'IndexExpr') return ''
  const regs = registersOf(target, ctx)
  if (regs) return setRegisters(regs, value)
  const addr = lvalueAddressOf(target, ctx)
  if (addr !== null) {
    const type = lookupExprType(target, ctx)
    if (!type) {
      throw new Error(`Missing type for store at offset ${target.span.start}`)
    }
    return storeToMemory(type, addr, value, ctx)
  }
  if (target.kind === 'IdentExpr') return `(local.set $${target.name} ${value})`
  throw new Error(`Cannot assign to this expression at offset ${target.span.start}`)
}

function returnToWat(stmt: AST.ReturnStmt, ctx: CodegenContext): string {
  const namedPush = ctx.namedReturnLocals?.length > 0
    ? ctx.namedReturnLocals.join(' ') + ' '
    : ''
  // The value is computed first and stays on the stack while every open block's
  // deferred expressions run (they leave the stack as they found it).
  const deferred = deferredToWat(ctx, ctx.deferFrames?.length ?? 0)
  const run = deferred ? `${deferred} ` : ''

  if (stmt.when) {
    const cond = exprToWat(stmt.when, ctx)
    if (stmt.value) {
      const value = exprToWat(stmt.value, ctx)
      return `(if ${cond} (then ${value} ${run}(return)))`
    }
    return `(if ${cond} (then ${namedPush}${run}(return)))`
  }

  if (stmt.value) {
    const value = exprToWat(stmt.value, ctx)
    return `${value} ${run}(return)`
  }

  return `${namedPush}${run}(return)`
}

function whileToWat(stmt: AST.WhileStmt, ctx: CodegenContext): string {
  const cond = exprToWat(stmt.condition, ctx)
  const body = bodyToWat(stmt.body, ctx, false, true)

  return `(block $break
    (loop $continue
      (br_if $break (i32.eqz ${cond}))
      ${body}
      (br $continue)
    )
  )`
}

function loopToWat(stmt: AST.LoopStmt, ctx: CodegenContext): string {
  const body = bodyToWat(stmt.body, ctx, false, true)

  return `(block $break
    (loop $continue
      ${body}
      (br $continue)
    )
  )`
}

// Whether anything in a subtree may give the variable `name` a new value: an
// assignment to it or to a part of it (p.n = 0 changes the p_n local a count
// p.n is read from), or a declaration of that name, which shares the
// variable's wasm local (a let, a loop or if-let binding, a pattern).
function mayChange(node: unknown, name: string): boolean {
  if (Array.isArray(node)) return node.some((n) => mayChange(n, name))
  if (!node || typeof node !== 'object') return false
  const n = node as Record<string, unknown> & { kind?: string; target?: AST.LValue }
  if (n.kind === 'AssignmentStmt' && n.target && assignedRoot(n.target) === name) return true
  if (n.kind !== 'IdentExpr' && ['name', 'binding', 'field', 'value', 'index'].some((k) => n[k] === name)) return true
  return Object.entries(n).some(([k, v]) => k !== 'span' && typeof v === 'object' && mayChange(v, name))
}

// The variable whose registers an assignment target is, or is a field of:
// p for p, p.n, p.a.b. A target with an index or a dereference in it is an
// element (in memory, or of an array, which no count is read from).
function assignedRoot(target: AST.LValue): string | null {
  let t: AST.LValue | AST.Expr = target
  while ((t.kind === 'MemberExpr' && t.member.kind === 'field') || t.kind === 'GroupExpr') {
    t = t.kind === 'GroupExpr' ? t.expr : t.object
  }
  return t.kind === 'IdentExpr' ? t.name : null
}

// Whether a loop count read as one register (a local, or a global) is still
// the count where the loop compares with it: nothing in the body may change
// the variable it is read from (a slice's length is part of the slice), and
// for a global, the body calls nothing that could.
function steadyRead(stmt: AST.ForStmt, wat: string): boolean {
  const body = stmt.body
  let root = ungroup(stmt.iterable)
  while (root.kind === 'MemberExpr' && root.member.kind === 'field') root = ungroup(root.object)
  if (root.kind !== 'IdentExpr' || mayChange(body, root.name)) return false
  // for n in n: the loop variable takes the local the count is read from.
  if (stmt.binding.value === root.name || stmt.binding.index === root.name) return false
  if (/^\(local\.get \$[\w-]+\)$/.test(wat)) return true
  return /^\(global\.get \$[\w-]+\)$/.test(wat) && !makesCall(body)
}

function makesCall(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(makesCall)
  if (!node || typeof node !== 'object') return false
  if ((node as { kind?: string }).kind === 'CallExpr') return true
  return Object.entries(node).some(([k, v]) => k !== 'span' && typeof v === 'object' && makesCall(v))
}

function forToWat(stmt: AST.ForStmt, ctx: CodegenContext): string {
  // The locals collectLocals gave the loop's variables, which its names stand
  // for in the body and after the loop, but not in the iterable.
  const outside = [stmt.binding.value, stmt.binding.index].flatMap((n) => (n ? [[n, ctx.locals.get(n)] as const] : []))
  enterDeclared(stmt, ctx)
  const valueLocals = ctx.locals.get(stmt.binding.value) ?? [stmt.binding.value]
  const valueName = valueLocals[0]
  const indexName = stmt.binding.index ? (ctx.locals.get(stmt.binding.index) ?? [stmt.binding.index])[0] : undefined

  const body = bodyToWat(stmt.body, ctx, false, true)

  // Check if iterable is a comptime integer (for i in N)
  const iterType = lookupExprType(stmt.iterable, ctx)
  for (const [name, names] of outside) {
    if (names) ctx.locals.set(name, names)
    else ctx.locals.delete(name)
  }
  const iterWat = exprToWat(stmt.iterable, ctx)
  enterDeclared(stmt, ctx)

  if (iterType && (iterType.kind === 'primitive' || iterType.kind === 'comptime_int')) {
    // Range loop: for value in N → value = 0; while value < N { ...; value += 1 }
    // The body sits in its own $continue block so that continue still reaches
    // the increment. The count is evaluated once, before the loop: a constant,
    // or a variable the body doesn't change, is read where it is compared.
    // A signed count is compared signed, so a negative one runs the loop zero
    // times; value counts up from 0 and stops at the count, so it never
    // reaches the values where the two comparisons differ.
    const constant = /^\(i32\.const (-?\d+)\)$/.exec(iterWat)
    const steady = constant !== null || steadyRead(stmt, iterWat)
    const count = steady ? iterWat : scratchLocal(ctx, 'i32')
    const negative = iterType.kind === 'primitive' && RT.isSigned(iterType) && !(constant && Number(constant[1]) >= 0)
    const compare = negative ? 'i32.ge_s' : 'i32.ge_u'
    return `${steady ? '' : `(local.set ${count} ${iterWat})\n`}(local.set $${valueName} (i32.const 0))
(block $break
    (loop $next
      (br_if $break (${compare} (local.get $${valueName}) ${steady ? count : `(local.get ${count})`}))
      (block $continue
        ${body}
      )
      (local.set $${valueName} (i32.add (local.get $${valueName}) (i32.const 1)))
      (br $next)
    )
  )`
  }

  // Element loop over a slice or *[N]T: walk a pointer from the first
  // element to the end, loading each element into the binding. No bounds
  // checks are needed: the pointer never leaves the range.
  const u = iterType ? unwrap(iterType) : undefined
  const elemType = ctx.types.get(typeKey(stmt.binding.span.start, stmt.binding.kind))
  if (!u || !elemType) throw new Error('for loop over an untyped iterable')
  const stride = byteSize(elemType)
  if (!stride) throw new Error(`for loop over elements of unknown size: ${RT.typeToString(elemType)}`)
  const uid = scratchId(stmt.span.start)
  const ptr = `$__for_ptr_${uid}`
  const end = `$__for_end_${uid}`
  let setup: string
  if (u.kind === 'slice') {
    // The iterable leaves (ptr, len) on the stack.
    setup = `${iterWat}
(local.set ${end})
(local.set ${ptr})
(local.set ${end} (i32.add (local.get ${ptr}) (i32.mul (local.get ${end}) (i32.const ${stride}))))`
  } else {
    const pointee = u.kind === 'pointer' ? unwrap(u.pointee) : null
    const count = pointee?.kind === 'array' ? pointee.sizes?.[0] : null
    if (typeof count !== 'number') throw new Error(`cannot iterate over ${RT.typeToString(u)}`)
    setup = `(local.set ${ptr} ${iterWat})
(local.set ${end} (i32.add (local.get ${ptr}) (i32.const ${count * stride})))`
  }
  const load = loadFromMemory(elemType, `(local.get ${ptr})`, ctx)
  const bind = valueLocals.length === 1
    ? `(local.set $${valueLocals[0]} ${load})`
    : `${load}\n${[...valueLocals].reverse().map(n => `(local.set $${n})`).join('\n')}`
  const index = indexName ? `$${indexName}` : null
  return `${setup}
${index ? `(local.set ${index} (i32.const 0))` : ''}
(block $break
    (loop $next
      (br_if $break (i32.ge_u (local.get ${ptr}) (local.get ${end})))
      ${bind}
      (block $continue
        ${body}
      )
      (local.set ${ptr} (i32.add (local.get ${ptr}) (i32.const ${stride})))
      ${index ? `(local.set ${index} (i32.add (local.get ${index}) (i32.const 1)))` : ''}
      (br $next)
    )
  )`
}

function breakToWat(stmt: AST.BreakStmt, ctx: CodegenContext): string {
  const deferred = deferredToWat(ctx, framesToLoop(ctx))
  if (stmt.when) {
    const cond = exprToWat(stmt.when, ctx)
    return deferred ? `(if ${cond} (then ${deferred} (br $break)))` : `(br_if $break ${cond})`
  }
  return deferred ? `${deferred} (br $break)` : '(br $break)'
}

function continueToWat(stmt: AST.ContinueStmt, ctx: CodegenContext): string {
  const deferred = deferredToWat(ctx, framesToLoop(ctx))
  if (stmt.when) {
    const cond = exprToWat(stmt.when, ctx)
    return deferred ? `(if ${cond} (then ${deferred} (br $continue)))` : `(br_if $continue ${cond})`
  }
  return deferred ? `${deferred} (br $continue)` : '(br $continue)'
}

// === Body/Block Codegen ===

// tailLocals: for a function body with named results, a trailing expression
// with a value is stored into these locals (before the defers run) instead of
// being dropped.
function bodyToWat(body: AST.FuncBody, ctx: CodegenContext, valueContext = false, loop = false, tailLocals?: string[]): string {
  // Each block collects its own deferred expressions and runs them, newest
  // first, when control falls off its end (after a value, which stays on the stack).
  // An arrow body has no defers of its own but still marks a loop body, so
  // break and continue inside it stop there.
  if (!ctx.deferFrames) ctx.deferFrames = []
  const frames = ctx.deferFrames
  frames.push({ loop, defers: [] })
  try {
    if (body.kind === 'ArrowBody') {
      return exprToWat(body.expr, ctx)
    }
    const tail = tailLocals?.length ? body.stmts.at(-1) : undefined
    if (tailLocals && tail?.kind === 'ExpressionStmt' && exprHasValue(tail.expr, ctx)) {
      const out = body.stmts.slice(0, -1).map((s) => stmtToWat(s, ctx))
      out.push(exprToWat(tail.expr, ctx))
      for (let i = tailLocals.length - 1; i >= 0; i--) out.push(`(local.set $${tailLocals[i]})`)
      out.push(deferredToWat(ctx, 1))
      return out.filter(Boolean).join('\n')
    }
    if (!valueContext || body.stmts.length === 0) {
      const out = body.stmts.map((s) => stmtToWat(s, ctx))
      // A block that ends in an unconditional exit already ran its defers there.
      const last = body.stmts.at(-1)
      const exits = (last?.kind === 'ReturnStmt' || last?.kind === 'BreakStmt' || last?.kind === 'ContinueStmt') && !last.when
      if (!exits) out.push(deferredToWat(ctx, 1))
      return out.filter(Boolean).join('\n')
    }
    const init = body.stmts.slice(0, -1).map((s) => stmtToWat(s, ctx))
    const last = body.stmts[body.stmts.length - 1]
    if (last.kind === 'ExpressionStmt') {
      init.push(exprToWat(last.expr, ctx))
    } else {
      init.push(stmtToWat(last, ctx))
    }
    init.push(deferredToWat(ctx, 1))
    return init.filter(Boolean).join('\n')
  } finally {
    frames.pop()
  }
}

// === Function Codegen ===

export function funcToWat(
  decl: AST.FuncDecl,
  checkResult: TypeCheckResult,
  literalRefs: Map<number, { ptr: number; len: number }> = new Map(),
  nameMap?: Map<string, string>,
  watName?: string,
  extraSymbols?: Map<string, CheckSymbol>,
  dataSectionSize?: number,
): string {
  const ctx = createContext(checkResult, literalRefs, nameMap, dataSectionSize)
  if (extraSymbols) {
    for (const [k, v] of extraSymbols) ctx.symbols.set(k, v)
  }
  const name = checkResult.funcNames.get(decl) ?? decl.ident ?? 'anonymous'

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
    // A struct or slice param is a wasm param per part, named like a local's.
    const wasmTypes = typeToWasm(param.type)
    const names = claimLocals(ctx, paramName, param.type, null)
    for (const [i, n] of names.entries()) params.push(`(param $${n} ${wasmTypes[i]})`)
    ctx.params.set(paramName, names)
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
      // Its parts are named the way params and lets are flattened (tuple
      // field names, ptr/len for slices), so member access finds them.
      ctx.locals.set(ret.name, claimLocals(ctx, ret.name, ret.type, locals, true))
      namedReturns.push({ name: ret.name, types: typeToWasm(ret.type) })
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
  // Generate body. With named results, a trailing expression with a value
  // supplies them; a trailing if, loop or void call leaves the named locals as
  // set.
  const tailLocals = namedReturns.flatMap(r => ctx.locals.get(r.name) ?? [])
  const body = bodyToWat(decl.body, ctx, false, false, tailLocals)

  // Generate epilogue: push named returns onto stack. An expression body's
  // value is the result already.
  let epilogue = ''
  if (namedReturns.length > 0 && decl.body.kind !== 'ArrowBody') {
    const returnGets = namedReturns.flatMap((r) => {
      const localNames = ctx.locals.get(r.name)
      if (localNames) {
        return localNames.map((n) => `(local.get $${n})`)
      }
      return []
    })
    epilogue = returnGets.join('\n  ')
  }

  // A block body with unnamed results returns on every path (the checker
  // ensures it), so its end is unreachable; say so for the wasm validator,
  // which can't tell that a loop with no break never falls through.
  if (decl.body.kind === 'Block' && namedReturns.length === 0 && returnTypes.length > 0) {
    epilogue = '(unreachable)'
  }

  const localStr = declareUsedLocals([...dedupedLocals, ...(ctx.scratch ?? [])], `${body}\n${epilogue}`, '\n  ')
  const paramsStr = params.join(' ')
  const emitName = watName ?? name
  return `(func $${emitName} ${paramsStr} ${resultStr}
  ${localStr}
  ${body}
  ${epilogue}
)`
}

// The wasm locals (or params) a variable is held in. A variable of one wasm
// value is its own name; one of several has a local per part, named after
// the variable and the part (`p_x`, `s_ptr`, `t_0`). Two variables can ask
// for one name: a struct `a` with a field `x` and a variable `a_x`, or two
// `if let` bindings of one name and different types. A name goes to the
// first variable that asks for it in the function (params, then the body in
// order, then named results), and is shared only by another variable of the
// same name whose part there has the same wasm type, as the variables of two
// loops of `i` are. Any other variable gets all its names with a prefix,
// `_1_`, `_2_`, ...: no identifier starts with `_`, and the compiler's own
// locals start with `__`. So the names depend on the function alone.
// `locals` gets a declaration for each name that is new. With `plainIfOne`,
// a value of one wasm value is the variable's own name even where it is a
// part (a struct of one field), as a `let`, an `if let` and a named result
// have always named it.
//
// An `if let` binding is a variable of its own, seen in its then-branch
// only, so it shares a name only with another `if let` binding (`kind`),
// and not with one whose then-branch it is in (`ctx.busy`).
function claimLocals(
  ctx: Pick<CodegenContext, 'claimed' | 'busy'>, name: string, type: ResolvedType, locals: LocalDecl[] | null, plainIfOne = false, kind = '',
): string[] {
  ctx.claimed ??= new Map()
  const claimed = ctx.claimed
  const flat = flattenType(type)
  const parts = flat.length === 1 && (flat[0].suffix === '' || plainIfOne)
    ? [{ suffix: '', wasmType: flat[0].wasmType }]
    : flat.map((f, i) => ({ suffix: f.suffix || String(i), wasmType: f.wasmType }))
  const owners = parts.map((p) => `${kind}${name} ${p.suffix} ${p.wasmType}`)
  for (let n = 0; ; n++) {
    const prefix = n === 0 ? '' : `_${n}_`
    const names = parts.map((p) => `${prefix}${name}${p.suffix ? `_${p.suffix}` : ''}`)
    // Two parts of one variable can be named alike: a field `x_y`, and the
    // field `y` of a field `x`. The later one takes the next prefix whose
    // name is free, or is the same part's of a variable like this one.
    for (let i = 1; i < names.length; i++) {
      for (let k = n + 1; names.indexOf(names[i]) < i; k++) {
        const w = `_${k}_${name}_${parts[i].suffix}`
        if ((!claimed.has(w) || claimed.get(w) === owners[i]) && !ctx.busy?.has(w) && !names.includes(w)) names[i] = w
      }
    }
    if (names.some((w, i) => (claimed.has(w) && claimed.get(w) !== owners[i]) || ctx.busy?.has(w))) continue
    names.forEach((w, i) => {
      if (claimed.has(w)) return
      claimed.set(w, owners[i])
      locals?.push({ name: w, type: parts[i].wasmType })
    })
    return names
  }
}

// Compiles `emit` with `name` standing for the locals of a binding that only
// a branch sees, and the name as it was outside.
function withBinding<T>(ctx: CodegenContext, name: string, names: string[] | undefined, emit: () => T): T {
  if (!names) return emit()
  const outside = ctx.locals.get(name)
  ctx.locals.set(name, names)
  try {
    return emit()
  } finally {
    if (outside) ctx.locals.set(name, outside)
    else ctx.locals.delete(name)
  }
}

// Local declarations, leaving out compiler scratch locals (named __...) that
// the code never uses.
function declareUsedLocals(locals: LocalDecl[], code: string, sep: string): string {
  const used = new Set(code.match(/\$[\w.+-]+/g) ?? [])
  return locals
    .filter(l => !l.name.startsWith('__') || used.has(`$${l.name}`))
    .map(l => `(local $${l.name} ${l.type})`)
    .join(sep)
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

  // A variable `stmt` declares: its locals, which its name stands for from
  // `stmt` on when the code is emitted (enterDeclared). A `let`'s name is
  // the one variable of that name in its function (the checker refuses a
  // second), so it stands for it everywhere already; a `for` can take over
  // the name of a param or a variable before it, which keeps its locals
  // until the loop.
  function declare(stmt: AST.LetStmt | AST.ForStmt, name: string, names: string[]) {
    ctx.declared ??= new Map()
    ctx.declared.set(stmt, [...(ctx.declared.get(stmt) ?? []), [name, names]])
    if (stmt.kind === 'LetStmt') ctx.locals.set(name, names)
  }

  // Declare locals for each element of a tuple pattern, and for the elements
  // of an element that is a tuple pattern itself.
  function declarePattern(stmt: AST.LetStmt, pattern: AST.TuplePattern, tupleType: RT.TupleRT) {
    for (const [position, elem] of pattern.elements.entries()) {
      // Named elements find their field by name, positional ones by position.
      const field = elem.kind === 'named'
        ? tupleType.fields.find((f) => f.name === elem.field)
        : tupleType.fields[position]
      if (!field) continue
      if (elem.kind === 'positional' && elem.pattern.kind === 'TuplePattern') {
        const inner = unwrap(field.type)
        if (inner.kind === 'tuple') declarePattern(stmt, elem.pattern, inner)
        continue
      }
      const name = elem.kind === 'named' ? elem.binding ?? elem.field : (elem.pattern as AST.IdentPattern).name
      // Multi-value fields (slices, tuples) flatten like lets: rest_ptr, rest_len.
      declare(stmt, name, claimLocals(ctx, name, field.type, locals))
    }
  }

  function visitStmt(stmt: AST.Statement) {
    if (stmt.kind === 'LetStmt') {
      if (stmt.pattern.kind === 'IdentPattern') {
        const name = stmt.pattern.name
        // Type is stored at pattern offset, not statement offset
        const type = checkResult.types.get(typeKey(stmt.pattern.span.start, stmt.pattern.kind))
        if (!type) {
          throw new Error(`Missing type for local '${name}' at offset ${stmt.pattern.span.start}`)
        }
        declare(stmt, name, claimLocals(ctx, name, type, locals, true))
      } else if (stmt.pattern.kind === 'TuplePattern') {
        // Get the overall tuple type from the pattern
        const tupleType = checkResult.types.get(typeKey(stmt.pattern.span.start, stmt.pattern.kind))
        if (!tupleType || tupleType.kind !== 'tuple') {
          throw new Error(`Missing or invalid tuple type for pattern at offset ${stmt.pattern.span.start}`)
        }

        declarePattern(stmt, stmt.pattern, tupleType)
      }
    }
    // Recurse into nested blocks
    if (stmt.kind === 'WhileStmt') {
      visitExpr(stmt.condition)
      visitBody(stmt.body)
    }
    if (stmt.kind === 'LoopStmt') {
      visitBody(stmt.body)
    }
    if (stmt.kind === 'ForStmt') {
      visitExpr(stmt.iterable)
      // The loop's variables. The checker keeps them in the enclosing
      // scope, after the loop too, and so does this. Multi-value elements
      // (slices, tuples) flatten like lets.
      const bindingType = ctx.types.get(typeKey(stmt.binding.span.start, stmt.binding.kind))
      if (bindingType) declare(stmt, stmt.binding.value, claimLocals(ctx, stmt.binding.value, bindingType, locals))
      if (stmt.binding.index) declare(stmt, stmt.binding.index, claimLocals(ctx, stmt.binding.index, RT.primitive('u32'), locals))
      // Element loops walk a pointer up to an end address.
      const uid = scratchId(stmt.span.start)
      locals.push({ name: `__for_ptr_${uid}`, type: 'i32' }, { name: `__for_end_${uid}`, type: 'i32' })
      visitBody(stmt.body)
    }
    // Handle expression statements that may contain if expressions
    if (stmt.kind === 'ExpressionStmt' || stmt.kind === 'DeferStmt' || stmt.kind === 'AssertStmt') {
      visitExpr(stmt.expr)
    }
    // Handle assignment statements that may have if expressions on the right side
    if (stmt.kind === 'AssignmentStmt') {
      visitExpr(stmt.value)
      if (stmt.target.kind === 'SliceExpr') {
        // Range assignment: the range's own scratch locals, plus the
        // destination and (for wide fills) the value.
        const uid = scratchId(stmt.target.span.start)
        const elem = (checkResult.exprTypes.get(stmt.target) as { element?: ResolvedType } | undefined)?.element
        locals.push({ name: `__bulk_p_${uid}`, type: 'i32' }, { name: `__bulk_n_${uid}`, type: 'i32' })
        if (elem && typeToWasm(elem).length === 1) locals.push({ name: `__bulk_v_${uid}`, type: typeToWasm(elem)[0] })
      }
      // An index or a range in the target can need scratch locals of its own.
      if (stmt.target.kind === 'MemberExpr' || stmt.target.kind === 'IndexExpr' || stmt.target.kind === 'SliceExpr') {
        visitExpr(stmt.target)
      }
    }
    // Handle let and set statements that may have coalesce/if expressions in value
    if ((stmt.kind === 'LetStmt' || stmt.kind === 'SetStmt') && stmt.value) {
      visitExpr(stmt.value)
    }
    if (stmt.kind === 'ReturnStmt' && stmt.value) {
      visitExpr(stmt.value)
    }
    if ((stmt.kind === 'ReturnStmt' || stmt.kind === 'BreakStmt' || stmt.kind === 'ContinueStmt') && stmt.when) {
      visitExpr(stmt.when)
    }
  }

  function visitExpr(expr: AST.Expr) {
    if (expr.kind === 'IfExpr') {
      // Collect if-let binding locals
      if (expr.pattern && expr.pattern.kind === 'binding') {
        const elemType = checkResult.types.get(typeKey(expr.condition.span.start, 'IfLetBinding'))
        if (elemType) {
          // The binding's locals, seen in the then-branch only (ifLetToWat):
          // its name can be another variable's outside it.
          ctx.bindings ??= new Map()
          ctx.bindings.set(expr, claimLocals(ctx, expr.pattern.name, elemType, locals, true, 'if let '))
          const uid = scratchId(expr.span.start)
          if (expr.condition.kind === 'IndexExpr') {
            // Temporary locals for bounds checking
            locals.push({ name: `__iflet_idx_${uid}`, type: 'i32' })
            ctx.locals.set(`__iflet_idx_${uid}`, [`__iflet_idx_${uid}`])
          }
          // Temporary locals for null check
          locals.push({ name: `__iflet_ptr_${uid}`, type: 'i32' })
          locals.push({ name: `__iflet_len_${uid}`, type: 'i32' })
          ctx.locals.set(`__iflet_ptr_${uid}`, [`__iflet_ptr_${uid}`])
          ctx.locals.set(`__iflet_len_${uid}`, [`__iflet_len_${uid}`])
        }
      }
      visitExpr(expr.condition)
      // A binding of the same name in the then-branch is another variable.
      const bound = ctx.bindings?.get(expr)?.filter((n) => !ctx.busy?.has(n)) ?? []
      ctx.busy ??= new Set()
      for (const n of bound) ctx.busy.add(n)
      visitBody(expr.thenBranch)
      for (const n of bound) ctx.busy.delete(n)
      for (const elif of expr.elifs) {
        visitExpr(elif.condition)
        visitBody(elif.thenBranch)
      }
      if (expr.else_) {
        visitBody(expr.else_)
      }
    }
    if (expr.kind === 'CastExpr' || expr.kind === 'AnnotationExpr') {
      visitExpr(expr.expr)
    }
    if (expr.kind === 'MemberExpr') {
      if (expr.member.kind === 'field' && expr.member.name === 'len') {
        locals.push({ name: `__len_${scratchId(expr.span.start)}`, type: 'i32' })
      }
      visitExpr(expr.object)
    }
    if (expr.kind === 'IndexExpr') {
      visitExpr(expr.object)
      visitExpr(expr.index)
    }
    if (expr.kind === 'SliceExpr') {
      for (const x of ['p', 'n', 'a', 'b']) locals.push({ name: `__sl_${x}_${scratchId(expr.span.start)}`, type: 'i32' })
      visitExpr(expr.object)
      if (expr.start) visitExpr(expr.start)
      if (expr.end) visitExpr(expr.end)
    }
    if (expr.kind === 'CoalesceExpr') {
      const uid = scratchId(expr.span.start)
      if (expr.expr.kind === 'IndexExpr') {
        locals.push({ name: `__coal_idx_${uid}`, type: 'i32' })
      }
      locals.push({ name: `__coal_ptr_${uid}`, type: 'i32' })
      locals.push({ name: `__coal_len_${uid}`, type: 'i32' })
      if (expr.expr.kind === 'IndexExpr') {
        ctx.locals.set(`__coal_idx_${uid}`, [`__coal_idx_${uid}`])
      }
      ctx.locals.set(`__coal_ptr_${uid}`, [`__coal_ptr_${uid}`])
      ctx.locals.set(`__coal_len_${uid}`, [`__coal_len_${uid}`])
      visitExpr(expr.expr)
      visitExpr(expr.fallback)
    }
    if (expr.kind === 'ArrayExpr') {
      let needsSlotLocal = false
      for (const elem of expr.elements) {
        // Any runtime slice element that doesn't split into (ptr, len) parts
        // (a call, a ?? fallback, ...) goes through the scratch local.
        if (isRuntimeExpr(elem, ctx)) needsSlotLocal = true
        visitExpr(elem)
      }
      if (needsSlotLocal) {
        locals.push({ name: '__slot_len', type: 'i32' })
        ctx.locals.set('__slot_len', ['__slot_len'])
      }
    }
    // A repeated value is compiled once per copy, with whatever scratch locals
    // it needs.
    if (expr.kind === 'RepeatExpr') {
      visitExpr(expr.value)
    }
    if (expr.kind === 'MatchExpr') {
      // Where the subject is kept when it's more than a plain read.
      const subjectType = checkResult.exprTypes.get(expr.subject)
      if (subjectType && typeToWasm(subjectType).length === 1) {
        locals.push({ name: `__match_${scratchId(expr.span.start)}`, type: typeToWasm(subjectType)[0] })
      }
      visitExpr(expr.subject)
      for (const arm of expr.arms) {
        if (arm.body.kind === 'Block' || arm.body.kind === 'ArrowBody') visitBody(arm.body)
        else visitExpr(arm.body)
      }
    }
    if (expr.kind === 'GroupExpr') {
      visitExpr(expr.expr)
    }
    // Parentheses parse as a one-element tuple.
    if (expr.kind === 'TupleExpr') {
      for (const el of expr.elements) {
        if (el.value) visitExpr(el.value)
      }
    }
    if (expr.kind === 'CallExpr') {
      // x.f(a) is compiled as the call f(x, a) the checker recorded for it:
      // its receiver is an argument of that call, and none of this one.
      const lowered = expr.callee.kind === 'MemberExpr' ? checkResult.calls.get(expr) : undefined
      if (lowered) {
        visitExpr(lowered)
        return
      }
      // Integer min, max and abs use an operand twice: one that isn't a plain
      // read is kept in a scratch local.
      const operandType = checkResult.types.get(typeKey(expr.span.start, 'BuiltinCall'))
      if (expr.callee.kind === 'IdentExpr' && ['min', 'max', 'abs'].includes(expr.callee.name) && operandType && isInteger(operandType)) {
        const wasmType = typeToWasm(operandType)[0]
        for (const i of expr.args.keys()) locals.push({ name: builtinScratchLocal(expr.callee.name, i, expr), type: wasmType })
      }
      for (const arg of expr.args) {
        if (arg.value) visitExpr(arg.value)
      }
    }
    if (expr.kind === 'UnaryExpr') {
      // &items[i] with a runtime check keeps the index in a scratch local.
      if (expr.op === '&' && expr.operand.kind === 'IndexExpr') {
        const t = checkResult.exprTypes.get(expr)
        if (t?.kind === 'pointer' && t.optional) {
          locals.push({ name: `__addr_idx_${scratchId(expr.span.start)}`, type: 'i32' })
        }
      }
      visitExpr(expr.operand)
    }
    if (expr.kind === 'BinaryExpr') {
      visitExpr(expr.left)
      visitExpr(expr.right)
    }
  }

  function visitBody(b: AST.FuncBody) {
    if (b.kind === 'Block') {
      for (const s of b.stmts) {
        visitStmt(s)
      }
    } else {
      visitExpr(b.expr)
    }
  }

  visitBody(body)
  return locals
}

// === Module Codegen ===

function labelDataEntries(module: AST.Module, checkResult: TypeCheckResult, dataBuilder: DataSectionBuilder, literalRefs: Map<number, { ptr: number; len: number }>) {
  for (const decl of module.decls) {
    if (decl.kind === 'DataDecl') {
      const sym = checkResult.symbols.get(decl.ident)
      if (!sym || sym.kind === 'generic' || sym.kind === 'typefunc') continue
      const expr = decl.value.kind === 'AnnotationExpr' ? decl.value.expr : decl.value
      const ref = literalRefs.get(expr.span.start)
      if (ref) dataBuilder.addLabel(ref.ptr, `${decl.ident}: ${RT.typeToString(sym.type)}`)
    }
    if (decl.kind === 'DefDecl') {
      const sym = checkResult.symbols.get(decl.ident)
      if (sym?.kind === 'def' && sym.value?.kind === 'data_ptr') {
        const ref = literalRefs.get(sym.value.id)
        if (ref) dataBuilder.addLabel(ref.ptr, `${decl.ident}: ${RT.typeToString(sym.type)}`)
      }
    }
  }
}

// A wasm memory has at most 65536 pages of 64 KiB: 4 GiB. Laying out zeros
// costs nothing, so data can be declared that no memory can hold, and its
// addresses would not be i32s.
const MEMORY_LIMIT = 65536 * 65536

function memoryHolds(size: number): void {
  if (size > MEMORY_LIMIT) {
    throw new Error(`the data takes ${size} bytes of memory, more than the ${MEMORY_LIMIT} (4 GiB) a wasm memory can hold`)
  }
}

export function moduleToWat(module: AST.Module, checkResult: TypeCheckResult): string {
  // Build data section from collected literals
  const { dataBuilder, literalRefs } = buildDataSection(checkResult.literals, checkResult.types, { calls: checkResult.calls, constants: checkResult.constants })
  labelDataEntries(module, checkResult, dataBuilder, literalRefs)
  const dataSection = dataBuilder.result()
  memoryHolds(dataSection.totalSize)

  const ctx = createContext(checkResult, literalRefs, undefined, dataSection.totalSize)
  const globals = new Map<string, string[]>()
  claimGlobals(module, checkResult.symbols, ctx.nameMap, globals)
  programGlobals.set(checkResult.symbols, globals)
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
  for (const fn of funcsInOrder(module.decls, checkResult)) {
    parts.push(funcToWat(fn, checkResult, literalRefs, undefined, undefined, undefined, dataSection.totalSize))
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
    if (decl.kind === 'ExportDecl' && decl.item.kind !== 'MemoryDecl' && !isGenericExport(decl)) {
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
  parts.push(...wideHelpersFor(parts.join('\n')))
  if (parts.some(p => p.includes('$__mul_hi'))) {
    parts.push(MUL_HI_WAT)
  }

  parts.push(')')
  return tidyRawWat(parts.join('\n'))
}

// The functions of a module in the order they are emitted. A generic's place
// is taken by its instances, in the order of their names: the order instances
// were asked for depends on how the checker walks the program, and a fixed
// order is what lets a generic program and the same program written out by
// hand be the same file. A generic nobody called has no instances, and
// nothing is emitted for it.
function funcsInOrder(decls: AST.Declaration[], checkResult: TypeCheckResult): AST.FuncDecl[] {
  const instancesOf = new Map<AST.FuncDecl, AST.FuncDecl[]>()
  for (const inst of checkResult.instances) {
    instancesOf.set(inst.of, [...(instancesOf.get(inst.of) ?? []), inst.decl])
  }
  const funcs: AST.FuncDecl[] = []
  for (const decl of decls) {
    const fn = decl.kind === 'FuncDecl' ? decl : decl.kind === 'ExportDecl' && decl.item.kind === 'FuncDecl' ? decl.item : null
    if (!fn) continue
    if (!isGenericDecl(fn)) {
      funcs.push(fn)
      continue
    }
    const instances = instancesOf.get(fn) ?? []
    funcs.push(...instances.sort((a, b) => ((a.ident as string) < (b.ident as string) ? -1 : 1)))
  }
  return funcs
}

// A generic is never exported to the host: there is no one function to
// export, and a generic type is not there at run time at all. Its `export`
// only makes it importable by other source modules.
function isGenericExport(decl: AST.ExportDecl): boolean {
  return decl.item.kind === 'TypeFuncDecl' || (decl.item.kind === 'FuncDecl' && isGenericDecl(decl.item))
}

function tidyRawWat(wat: string): string {
  const lines = wat.split('\n')
  const out: string[] = []
  let inFunc = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (trimmed.startsWith('(func ')) { inFunc = true; out.push('  ' + trimmed); continue }
    if (inFunc && trimmed === ')') { out.push('  )'); inFunc = false; continue }
    if (trimmed.startsWith('(module') || trimmed === ')') { out.push(trimmed); continue }
    out.push((inFunc ? '    ' : '  ') + trimmed)
  }
  return out.join('\n') + '\n'
}

function usesMemory(checkResult: TypeCheckResult): boolean {
  for (const [key, type] of checkResult.types) {
    // The operand of a sizeof is a type the program names, not a value it has.
    if (key.endsWith(':SizeofType')) continue
    // The type of a name where a for, an if let or a pattern's named part
    // binds it is there for the editor: the value it is bound to is
    // recorded where it is.
    if (key.endsWith(':Binding')) continue
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
    } else if (item.kind === 'ImportDecl') {
      // Handled at module level — skip here
    } else if (item.kind === 'FuncDecl') {
      // Emit shared helper function
      const watName = item.ident ? `__test_${myPrefix}_${item.ident}` : `__test_${myPrefix}_anon`
      if (item.ident) {
        ctx.nameMap.set(item.ident, watName)
      }
      parts.push(funcToWat(item, checkResult, literalRefs, ctx.nameMap, watName, ctx.symbols, ctx.dataSectionSize))
    } else if (item.kind === 'DefDecl' || item.kind === 'DataDecl') {
      // Already processed above
    } else if (item.kind === 'TypeFuncDecl') {
      // The checker has refused it: a generic type is declared at module level
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
    ctx.testMode = true
    const safeName = myPrefix.replace(/[^a-zA-Z0-9_]/g, '_')
    // Its locals are its own, named as a function's are (claimLocals).
    ctx.locals = new Map()
    ctx.claimed = new Map()
    ctx.bindings = new Map()
    // Collect locals first: codegen looks up how multi-value locals flatten.
    const rawLocals = collectTestLocals(stmts, ctx, checkResult)
    const testBody: AST.Block = { kind: 'Block', stmts, span: decl.span }
    ctx.scratch = []
    const body = bodyToWat(testBody, ctx)
    ctx.testMode = false
    const seen = new Set<string>()
    const locals = [...rawLocals, ...ctx.scratch].filter(l => {
      if (seen.has(l.name)) return false
      seen.add(l.name)
      return true
    })
    const localStr = declareUsedLocals(locals, body, ' ')
    const testLabel = decl.name ? ` ;; test "${decl.name}"` : ''
    parts.push(`(func $test_${safeName} ${localStr}${testLabel}\n  ${body}\n)`)
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

function importItemToWat(moduleName: string, item: AST.ImportItem, ctx: CodegenContext): string {
  const imp = item.item

  if (imp.kind === 'ImportFunc') {
    const name = ctx.funcNames.get(imp) ?? imp.ident ?? item.name
    // Get function type from signature
    const params: string[] = []
    const results: string[] = []
    // The types are the checker's, part by part: a type that is a name (a
    // `type`, an applied generic type) is known only there, and read off the
    // syntax it would be no value at all.
    const sym = ctx.symbols.get(name)
    const checked = (from: 'params' | 'returns', index: number, count: number, ast: AST.Type): ResolvedType => {
      const fields = sym?.kind === 'func' ? sym.type[from] : []
      return fields.length === count ? fields[index].type : resolveAstType(ast)
    }

    // Parse input type for params
    const own: Pick<CodegenContext, 'claimed' | 'busy'> = {}
    if (imp.signature.input.kind === 'CompositeType') {
      const fields = imp.signature.input.fields
      for (const [index, field] of fields.entries()) {
        const resolved = checked('params', index, fields.length, field.type)
        const flattened = flattenType(resolved)
        if (field.ident) {
          // Named as a function's params are, so that no two are named alike.
          const names = claimLocals(own, field.ident, resolved, null, true)
          for (const [i, f] of flattened.entries()) params.push(`(param $${names[i]} ${f.wasmType})`)
        } else {
          for (const f of flattened) {
            params.push(`(param ${f.wasmType})`)
          }
        }
      }
    }

    // Parse output type for results
    if (imp.signature.output.kind === 'CompositeType') {
      const fields = imp.signature.output.fields
      for (const [index, field] of fields.entries()) {
        const wasmTypes = typeToWasm(checked('returns', index, fields.length, field.type))
        for (const wt of wasmTypes) {
          results.push(wt)
        }
      }
    } else {
      const wasmTypes = typeToWasm(checked('returns', 0, 1, imp.signature.output))
      for (const wt of wasmTypes) {
        results.push(wt)
      }
    }

    const paramsStr = params.join(' ')
    const resultsStr = results.length > 0 ? `(result ${results.join(' ')})` : ''

    return `  (import "${moduleName}" "${item.name}" (func $${name} ${paramsStr} ${resultsStr}))`
  }

  if (imp.kind === 'ImportGlobal') {
    // As exported: one wasm global per value, named with its part's suffix.
    const sym = ctx.symbols.get(imp.ident)
    const type = sym?.kind === 'global' ? sym.type : resolveAstType(imp.type)
    const wasmTypes = typeToWasm(type)
    const names = globalNames(imp.ident, type, ctx)
    return flatSuffixes(type)
      .map((suffix, i) => `  (import "${moduleName}" "${item.name}${suffix}" (global $${names[i]} ${wasmTypes[i]}))`)
      .join('\n')
  }

  return ''
}

// A global is one wasm global per wasm value of its type: a slice, struct or
// wide integer global is several, each with its part of the initializer.
function globalToWat(decl: AST.GlobalDecl, ctx: CodegenContext): string {
  const name = patternIdent(decl.pattern)
  const type = ctx.types.get(typeKey(decl.pattern.span.start, decl.pattern.kind))
  if (!type) {
    throw new Error(`Missing type for global '${name}' at offset ${decl.span.start}`)
  }
  const wasmTypes = typeToWasm(type)
  // The initializer is one constant instruction for each wasm value: exprToWat
  // emits the checker's value for each constant in it.
  const init = decl.value
    ? exprToWat(decl.value, ctx)
    : wasmTypes.map((wt) => `(${wt}.const 0)`).join(' ')
  const inits = trySplitMultiValue(init, wasmTypes.length)
  if (!inits) throw new Error(`global '${name}' needs a constant for each of its ${wasmTypes.length} values`)

  return globalNames(name, type, ctx).map((n, i) => `  (global $${n} (mut ${wasmTypes[i]}) ${inits[i]})`).join('\n')
}

// A constant's value as an instruction of a type held in one wasm value, or
// as the i64 parts of a wide integer, least significant first.
function constantToWat(value: ComptimeValue, type: ResolvedType): string | null {
  const wide = wideIntParts(type)
  if (wide > 0 && value.kind === 'int') {
    return Array.from({ length: wide }, (_, i) => `(i64.const ${BigInt.asIntN(64, value.value >> BigInt(i * 64))})`).join(' ')
  }
  if (typeToWasm(type).length !== 1) return null
  const wt = typeToWasmSingle(type)
  if (value.kind === 'bool') return `(i32.const ${value.value ? 1 : 0})`
  if (value.kind === 'data_ptr' || value.kind === 'type' || value.kind === 'func') return null
  if (wt === 'f32' || wt === 'f64') {
    const v = wt === 'f32' ? Math.fround(Number(value.value)) : Number(value.value)
    const text = Number.isNaN(v) ? 'nan' : !Number.isFinite(v) ? (v > 0 ? 'inf' : '-inf') : Object.is(v, -0) ? '-0' : `${v}`
    return `(${wt}.const ${text})`
  }
  if (value.kind === 'float') return null
  // A complement or a sub-word value: the bits it has in this type.
  const bits = (primitiveByteSize(type) ?? 4) * 8
  return `(${wt}.const ${isSigned(type) ? BigInt.asIntN(bits, value.value) : BigInt.asUintN(bits, value.value)})`
}

function exportToWat(decl: AST.ExportDecl, ctx: CodegenContext): string {
  const name = decl.name
  const item = decl.item

  if (item.kind === 'FuncDecl') {
    const funcName = ctx.funcNames.get(item) ?? item.ident ?? 'anonymous'
    const watName = ctx.nameMap.get(funcName) ?? funcName
    return `  (export "${name}" (func $${watName}))`
  }

  if (item.kind === 'GlobalDecl') {
    // Each wasm global of a multi-value global is exported under the name
    // with its part's suffix: order_ptr, order_len.
    const globalName = patternIdent(item.pattern)
    const type = ctx.types.get(typeKey(item.pattern.span.start, item.pattern.kind))
    const suffixes = type ? flatSuffixes(type) : ['']
    const watName = ctx.nameMap.get(globalName) ?? globalName
    const names = type ? globalNames(globalName, type, ctx) : [watName]
    return suffixes.map((suffix, i) => `  (export "${name}${suffix}" (global $${names[i]}))`).join('\n')
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
      // (u32) is u32
      if (ungroupedType(type) !== type) return resolveAstType(ungroupedType(type))
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
  const allCalls: TypeCheckResult['calls'] = new Map()
  const allConstants: TypeCheckResult['constants'] = new Map()

  // One data section for the literals of all modules. A literal is known by
  // its offset in its own module's source, so each module has its own map
  // into the section: two modules with a literal at the same offset (or two
  // instances at the same private offset) must not read each other's data.
  const sources: { path: string; result: TypeCheckResult }[] = []
  for (const [path, result] of checkResults) {
    sources.push({ path, result })
    for (const [written, compiled] of result.calls) allCalls.set(written, compiled)
    for (const [expr, value] of result.constants) allConstants.set(expr, value)
  }
  const { dataBuilder, literalRefs: refsOfSource } = buildProgramDataSection(sources.map(({ result }) => result), { calls: allCalls, constants: allConstants })
  const literalRefsOf = new Map(sources.map(({ path }, i) => [path, refsOfSource[i]]))
  const refsOf = (path: string) => literalRefsOf.get(path) ?? new Map<number, DataRef>()
  for (const [path, loaded] of modules) {
    const result = checkResults.get(path)
    if (result) labelDataEntries(loaded.module, result, dataBuilder, refsOf(path))
  }
  const dataSection = dataBuilder.result()
  memoryHolds(dataSection.totalSize)

  // Build per-module name mappings
  const perModuleNameMap = new Map<string, Map<string, string>>()
  // Each module's exported functions by the name they are exported under,
  // which is what an importer names: not always the name of the function,
  // and for functions that share a name never the same for two of them.
  const perModuleExports = new Map<string, Map<string, string>>()
  for (const [path, loaded] of modules) {
    const prefix = path === entryPath ? '' : modulePrefix(path)
    const modNameMap = new Map<string, string>()
    const modExports = new Map<string, string>()
    const funcNames = checkResults.get(path)?.funcNames
    for (const decl of loaded.module.decls) {
      if (decl.kind === 'FuncDecl' && decl.ident) {
        const known = funcNames?.get(decl) ?? decl.ident
        modNameMap.set(known, prefix ? `${prefix}$${known}` : known)
      }
      if (decl.kind === 'ExportDecl' && decl.item.kind === 'FuncDecl' && decl.item.ident) {
        const known = funcNames?.get(decl.item) ?? decl.item.ident
        const mangled = prefix ? `${prefix}$${known}` : known
        modNameMap.set(known, mangled)
        modExports.set(decl.name, mangled)
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
    for (const inst of checkResults.get(path)?.instances ?? []) {
      const name = inst.decl.ident as string
      modNameMap.set(name, prefix ? `${prefix}$${name}` : name)
    }
    perModuleNameMap.set(path, modNameMap)
    perModuleExports.set(path, modExports)
  }
  // Each module names the wasm globals of its own globals; a global imported
  // from another module is known by that module's names.
  const globals = new Map<string, string[]>()
  for (const [path, loaded] of modules) {
    const result = checkResults.get(path)
    if (result) claimGlobals(loaded.module, result.symbols, perModuleNameMap.get(path) ?? new Map(), globals)
  }
  for (const result of checkResults.values()) programGlobals.set(result.symbols, globals)

  function collectAllImports(decls: readonly { kind: string }[]): AST.ImportDecl[] {
    const imports: AST.ImportDecl[] = []
    for (const d of decls) {
      if (d.kind === 'ImportDecl') imports.push(d as AST.ImportDecl)
      else if (d.kind === 'TestDecl') imports.push(...collectAllImports((d as AST.TestDecl).children))
    }
    return imports
  }

  // Build the full name map for each module: includes own mangled names + imported names resolved to their source's mangled names
  function buildFullNameMap(path: string): Map<string, string> {
    const full = new Map<string, string>()
    const own = perModuleNameMap.get(path)
    if (own) for (const [k, v] of own) full.set(k, v)

    const loaded = modules.get(path)
    if (!loaded) return full
    const funcNames = checkResults.get(path)?.funcNames
    for (const decl of collectAllImports(loaded.module.decls)) {
      if (!isSourceImport(decl.module)) continue
      const depPath = resolveModulePath(decl.module, path)
      const depNames = perModuleNameMap.get(depPath)
      if (!depNames) continue
      for (const item of decl.items) {
        if (item.item.kind === 'ImportFunc') {
          const localName = funcNames?.get(item.item) ?? item.item.ident ?? item.name
          const mangled = perModuleExports.get(depPath)?.get(item.name) ?? depNames.get(item.name)
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

  // Emit host imports — top-level always, test-scoped only when includeTests
  for (const [path, loaded] of modules) {
    const result = checkResults.get(path)
    if (!result) continue
    const modNameMap = buildFullNameMap(path)
    const ctx = createContext(result, refsOf(path), modNameMap, dataSection.totalSize)
    for (const decl of loaded.module.decls) {
      if (decl.kind === 'ImportDecl' && !isSourceImport(decl.module)) {
        for (const item of decl.items) {
          parts.push(importItemToWat(decl.module, item, ctx))
        }
      }
    }
    if (options?.includeTests) {
      for (const decl of loaded.module.decls) {
        if (decl.kind === 'TestDecl') {
          for (const imp of collectAllImports(decl.children)) {
            if (!isSourceImport(imp.module)) {
              for (const item of imp.items) {
                parts.push(importItemToWat(imp.module, item, ctx))
              }
            }
          }
        }
      }
    }
  }

  if (options?.includeTests) {
    parts.push('  (import "test" "__assert_fail" (func $__assert_fail (param i32)))')
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
    for (const fn of funcsInOrder(loaded.module.decls, result)) {
      if (!fn.ident) continue
      const known = result.funcNames.get(fn) ?? fn.ident
      const watName = modNameMap.get(known) ?? known
      parts.push(funcToWat(fn, result, refsOf(path), modNameMap, watName, undefined, dataSection.totalSize))
    }
  }

  // Emit globals from all modules
  for (const [path, loaded] of modules) {
    const result = checkResults.get(path)
    if (!result) continue
    const modNameMap = buildFullNameMap(path)
    const ctx = createContext(result, refsOf(path), modNameMap, dataSection.totalSize)
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
    const ctx = createContext(entryResult, refsOf(entryPath), entryNameMap, dataSection.totalSize)
    for (const decl of entryModule.module.decls) {
      if (decl.kind === 'ExportDecl' && decl.item.kind !== 'MemoryDecl' && !isGenericExport(decl)) {
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
      const ctx = createContext(testResult, refsOf(testFilePath), testNameMap, dataSection.totalSize)
      for (const decl of testModule.module.decls) {
        if (decl.kind !== 'TestDecl') continue
        emitTestDecl(decl, '', ctx, testResult, refsOf(testFilePath), testNameMap, parts)
      }
    }
  }

  // Data section
  if (dataSection.totalSize > 0) {
    for (const seg of dataToWat(dataSection)) {
      parts.push(`  ${seg}`)
    }
  }

  parts.push(...wideHelpersFor(parts.join('\n')))
  if (parts.some(p => p.includes('$__mul_hi'))) {
    parts.push(MUL_HI_WAT)
  }

  parts.push(')')
  const wat = tidyRawWat(parts.join('\n'))
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
): { wat: string; testNames: string[]; testTitles: string[] } {
  // testNames are the exported function suffixes (test_<name>); testTitles are
  // the names as written, nested ones joined with ' > ', for display.
  const testNames: string[] = []
  const testTitles: string[] = []

  function collectTestNames(decl: AST.TestDecl, prefix: string, titlePrefix: string) {
    const myPrefix = decl.name
      ? (prefix ? `${prefix}__${decl.name}` : decl.name).replace(/[^a-zA-Z0-9_]/g, '_')
      : prefix
    const myTitle = decl.name ? (titlePrefix ? `${titlePrefix} > ${decl.name}` : decl.name) : titlePrefix
    const hasNested = decl.children.some(c => c.kind === 'TestDecl')
    if (hasNested) {
      for (const child of decl.children) {
        if (child.kind === 'TestDecl') collectTestNames(child, myPrefix, myTitle)
      }
    } else if (decl.name) {
      testNames.push(myPrefix)
      testTitles.push(myTitle)
    }
  }

  const filesToTest = testFiles ?? [entryPath]
  for (const filePath of filesToTest) {
    const mod = modules.get(filePath)
    if (!mod) continue
    for (const decl of mod.module.decls) {
      if (decl.kind === 'TestDecl') collectTestNames(decl, '', '')
    }
  }
  const wat = programToWat(modules, checkResults, entryPath, { includeTests: true, testFiles: filesToTest })
  return { wat, testNames, testTitles }
}
