// WebAssembly Text (WAT) code generator for Encantis
// Generates S-expression format WAT from AST + TypeCheckResult

import type * as AST from './ast'
import { typeKey, type TypeCheckResult, type Symbol as CheckSymbol } from './checker'
import {
  type ResolvedType,
  type ResolvedField,
  isSigned,
  isFloat,
  unwrap,
  primitiveByteSize,
} from './types'
import { dataToWat } from './data'

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
  // Indentation level for formatting
  indent: number
}

function createContext(checkResult: TypeCheckResult): CodegenContext {
  return {
    types: checkResult.types,
    symbols: checkResult.symbols,
    locals: new Map(),
    params: new Map(),
    indent: 0,
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
      throw new Error(`Unknown primitive type: ${u.name}`)
    }

    case 'pointer':
      return ['i32'] // Pointers are i32 indices

    case 'indexed':
      // Slices are fat pointers: (ptr, len)
      if (u.size === null || u.size === 'comptime') {
        return ['i32', 'i32']
      }
      // Fixed arrays - just the pointer
      return ['i32']

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
    case 'indexed':
      // Slices have ptr and len fields
      if (u.size === null || u.size === 'comptime') {
        return [
          { suffix: 'ptr', wasmType: 'i32' },
          { suffix: 'len', wasmType: 'i32' },
        ]
      }
      // Fixed arrays - just the pointer
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
    case 'AnnotationExpr':
      return exprToWat(expr.expr, ctx)
    case 'ArrayExpr':
      return arrayToWat(expr, ctx)
    case 'MatchExpr':
      return matchToWat(expr, ctx)
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
      // Function reference - for now just return the name
      return `(ref.func $${name})`
    }
    if (sym.kind === 'global') {
      return `(global.get $${name})`
    }
    if (sym.kind === 'def') {
      // Compile-time constant - inline the value
      const val = sym.value
      const wt = typeToWasmSingle(sym.type)
      if (val.kind === 'int') {
        return `(${wt}.const ${val.value})`
      }
      if (val.kind === 'float') {
        return `(${wt}.const ${val.value})`
      }
      if (val.kind === 'bool') {
        return `(i32.const ${val.value ? 1 : 0})`
      }
    }
  }

  // Unknown - emit error comment
  return `(i32.const 0) ;; unknown: ${name}`
}

function binaryToWat(expr: AST.BinaryExpr, ctx: CodegenContext): string {
  const left = exprToWat(expr.left, ctx)
  const right = exprToWat(expr.right, ctx)

  // Get result type from checker
  const resultType = ctx.types.get(typeKey(expr.span.start, expr.kind))
  if (!resultType) {
    throw new Error(`Missing type for binary expression at offset ${expr.span.start}`)
  }

  // For comparison ops, we need the operand type for signedness, not the result (which is bool)
  // For arithmetic ops, the result type is the operand type
  const leftType = ctx.types.get(typeKey(expr.left.span.start, expr.left.kind))
  const operandType = leftType ?? resultType

  const wt = typeToWasmSingle(operandType)
  const signed = isSigned(operandType)
  const isFloatType = isFloat(operandType)

  const op = expr.op
  let wasmOp: string

  switch (op) {
    // Arithmetic
    case '+':
      wasmOp = `${wt}.add`
      break
    case '-':
      wasmOp = `${wt}.sub`
      break
    case '*':
      wasmOp = `${wt}.mul`
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
      wasmOp = `${wt}.eq`
      break
    case '!=':
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
      wasmOp = `${wt}.and`
      break
    case '|':
      wasmOp = `${wt}.or`
      break
    case '^':
      wasmOp = `${wt}.xor`
      break
    case '<<':
      wasmOp = `${wt}.shl`
      break
    case '>>':
      wasmOp = signed ? `${wt}.shr_s` : `${wt}.shr_u`
      break
    case '>>>':
      wasmOp = `${wt}.shr_u`
      break
    case '<<<':
      wasmOp = `${wt}.rotl`
      break

    // Logical (short-circuit)
    case '&&':
      return `(if (result i32) ${left} (then ${right}) (else (i32.const 0)))`
    case '||':
      return `(if (result i32) ${left} (then (i32.const 1)) (else ${right}))`

    default:
      throw new Error(`Unknown binary operator: ${op}`)
  }

  return `(${wasmOp} ${left} ${right})`
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
    case '-':
      // Negate: 0 - x for integers, neg for floats
      if (isFloat(type)) {
        return `(${wt}.neg ${operand})`
      }
      return `(${wt}.sub (${wt}.const 0) ${operand})`

    case '~':
      // Bitwise NOT: x xor -1
      return `(${wt}.xor ${operand} (${wt}.const -1))`

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

function callToWat(expr: AST.CallExpr, ctx: CodegenContext): string {
  // Get function name
  let funcName: string
  if (expr.callee.kind === 'IdentExpr') {
    funcName = expr.callee.name
  } else {
    // Indirect call - not yet supported
    return `(call_indirect ${exprToWat(expr.callee, ctx)})`
  }

  // Generate argument expressions
  const args = expr.args.map((arg) => {
    if (arg.value) {
      return exprToWat(arg.value, ctx)
    }
    // Shorthand argument: name:
    if (arg.name) {
      return identToWat({ kind: 'IdentExpr', name: arg.name, span: arg.span }, ctx)
    }
    return ''
  }).filter(Boolean).join(' ')

  return `(call $${funcName}${args ? ' ' + args : ''})`
}

function memberToWat(expr: AST.MemberExpr, ctx: CodegenContext): string {
  const member = expr.member

  if (member.kind === 'field') {
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
    const type = ctx.types.get(typeKey(expr.span.start, expr.kind))
    if (!type) {
      throw new Error(`Missing type for pointer dereference at offset ${expr.span.start}`)
    }
    const wt = typeToWasmSingle(type)
    return `(${wt}.load ${ptr})`
  }

  if (member.kind === 'type') {
    // Typed dereference: ptr.u32, ptr.u8 - load from memory as specified type
    const ptr = exprToWat(expr.object, ctx)
    const loadType = resolveAstType(member.type)
    const wt = typeToWasmSingle(loadType)
    // Handle sub-word loads (u8, i8, u16, i16) with appropriate extension
    if (loadType.kind === 'primitive') {
      const name = loadType.name
      if (name === 'u8') return `(i32.load8_u ${ptr})`
      if (name === 'i8') return `(i32.load8_s ${ptr})`
      if (name === 'u16') return `(i32.load16_u ${ptr})`
      if (name === 'i16') return `(i32.load16_s ${ptr})`
    }
    return `(${wt}.load ${ptr})`
  }

  return exprToWat(expr.object, ctx)
}

function indexToWat(expr: AST.IndexExpr, ctx: CodegenContext): string {
  const base = exprToWat(expr.object, ctx)
  const index = exprToWat(expr.index, ctx)

  // Get element type to determine size
  const arrayType = ctx.types.get(typeKey(expr.object.span.start, expr.object.kind))
  let elemSize = 1
  if (arrayType && arrayType.kind === 'indexed') {
    const elemTypes = typeToWasm(arrayType.element)
    elemSize = elemTypes.length > 0 ? primitiveByteSize(arrayType.element) ?? 1 : 1
  }

  // Calculate offset: base + index * elemSize
  const offset =
    elemSize === 1
      ? `(i32.add ${base} ${index})`
      : `(i32.add ${base} (i32.mul ${index} (i32.const ${elemSize})))`

  // Load from memory
  const type = ctx.types.get(typeKey(expr.span.start, expr.kind))
  if (!type) {
    throw new Error(`Missing type for index expression at offset ${expr.span.start}`)
  }
  const wt = typeToWasmSingle(type)
  return `(${wt}.load ${offset})`
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

  return inner
}

function arrayToWat(_expr: AST.ArrayExpr, _ctx: CodegenContext): string {
  // Array literals should be in data section
  // Return placeholder
  return `(i32.const 0) ;; array literal`
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
    // Destructuring - generate sets for each element
    const results: string[] = []
    for (const elem of stmt.pattern.elements) {
      if (elem.kind === 'positional' && elem.pattern.kind === 'IdentPattern') {
        const name = elem.pattern.name
        ctx.locals.set(name, [name])
        // Need to extract from tuple value
      } else if (elem.kind === 'named') {
        const name = elem.binding ?? elem.field
        ctx.locals.set(name, [name])
      }
    }
    return results.join('\n')
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

  return ''
}

function assignToWat(stmt: AST.AssignmentStmt, ctx: CodegenContext): string {
  const value = exprToWat(stmt.value, ctx)

  // Handle compound assignment operators
  if (stmt.op !== '=') {
    // Get current value
    const current = lvalueToWat(stmt.target, ctx)
    // Get the type from the value expression (should be recorded by checker)
    const type = ctx.types.get(typeKey(stmt.value.span.start, stmt.value.kind))
    if (!type) {
      throw new Error(`Missing type for assignment value at offset ${stmt.value.span.start}`)
    }
    const wt = typeToWasmSingle(type)
    const signed = isSigned(type)

    const ops: Record<string, string> = {
      '+=': `${wt}.add`,
      '-=': `${wt}.sub`,
      '*=': `${wt}.mul`,
      '/=': signed ? `${wt}.div_s` : `${wt}.div_u`,
      '%=': signed ? `${wt}.rem_s` : `${wt}.rem_u`,
      '&=': `${wt}.and`,
      '|=': `${wt}.or`,
      '^=': `${wt}.xor`,
      '<<=': `${wt}.shl`,
      '>>=': signed ? `${wt}.shr_s` : `${wt}.shr_u`,
      '>>>=': `${wt}.shr_u`,
      '<<<=': `${wt}.rotl`,
    }

    const op = ops[stmt.op]
    if (op) {
      const combined = `(${op} ${current} ${value})`
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
    // Check globals
    const sym = ctx.symbols.get(name)
    if (sym?.kind === 'global') {
      return `(global.set $${name} ${value})`
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
      const type = ctx.types.get(typeKey(target.span.start, target.kind))
      if (!type) {
        throw new Error(`Missing type for pointer store at offset ${target.span.start}`)
      }
      const wt = typeToWasmSingle(type)
      return `(${wt}.store ${ptr} ${value})`
    }
  }

  if (target.kind === 'IndexExpr') {
    const ptr = exprToWat(target.object, ctx)
    const idx = exprToWat(target.index, ctx)
    const type = ctx.types.get(typeKey(target.span.start, target.kind))
    if (!type) {
      throw new Error(`Missing type for index store at offset ${target.span.start}`)
    }
    const wt = typeToWasmSingle(type)
    return `(${wt}.store (i32.add ${ptr} ${idx}) ${value})`
  }

  return ''
}

function returnToWat(stmt: AST.ReturnStmt, ctx: CodegenContext): string {
  if (stmt.when) {
    // Conditional return: return x when cond
    const cond = exprToWat(stmt.when, ctx)
    const value = stmt.value ? exprToWat(stmt.value, ctx) : ''
    return `(if ${cond} (then ${value} (return)))`
  }

  if (stmt.value) {
    const value = exprToWat(stmt.value, ctx)
    return `${value} (return)`
  }

  return '(return)'
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

export function funcToWat(decl: AST.FuncDecl, checkResult: TypeCheckResult): string {
  const ctx = createContext(checkResult)
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
        const names = wasmTypes.map((wt, i) => {
          const fieldName = `${ret.name}_${i}`
          locals.push({ name: fieldName, type: wt })
          return fieldName
        })
        ctx.locals.set(ret.name, names)
        namedReturns.push({ name: ret.name, types: wasmTypes })
      }
    }
  }
  const localStr = locals.map((l) => `(local $${l.name} ${l.type})`).join('\n  ')

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
  return `(func $${name} ${paramsStr} ${resultStr}
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
    if (stmt.kind === 'LetStmt' && stmt.pattern.kind === 'IdentPattern') {
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
    }
    // Recurse into nested blocks
    if (stmt.kind === 'WhileStmt') {
      visitBody(stmt.body)
    }
    if (stmt.kind === 'LoopStmt') {
      visitBody(stmt.body)
    }
    if (stmt.kind === 'ForStmt') {
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
  const ctx = createContext(checkResult)
  const parts: string[] = ['(module']

  // Check if memory is needed
  const dataSection = checkResult.dataBuilder.result()
  const hasMemory = dataSection.totalSize > 0 || hasMemoryDecl(module)

  // Collect imports
  for (const decl of module.decls) {
    if (decl.kind === 'ImportDecl') {
      for (const item of decl.items) {
        parts.push(importItemToWat(decl.module, item, ctx))
      }
    }
  }

  // Add memory if needed (and not imported)
  if (hasMemory && !hasMemoryImport(module)) {
    const memDecl = getMemoryDecl(module)
    if (memDecl) {
      const maxStr = memDecl.max !== null ? ` ${memDecl.max}` : ''
      if (memDecl.exportName) {
        parts.push(`  (memory (export "${memDecl.exportName}") ${memDecl.min}${maxStr})`)
      } else {
        parts.push(`  (memory ${memDecl.min}${maxStr})`)
      }
    } else {
      // Default memory for data section
      parts.push('  (memory 1)')
    }
  }

  // Collect function declarations
  for (const decl of module.decls) {
    if (decl.kind === 'FuncDecl') {
      parts.push(funcToWat(decl, checkResult))
    }
    if (decl.kind === 'ExportDecl' && decl.item.kind === 'FuncDecl') {
      parts.push(funcToWat(decl.item, checkResult))
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

  parts.push(')')
  return parts.join('\n')
}

function hasMemoryDecl(module: AST.Module): boolean {
  for (const decl of module.decls) {
    if (decl.kind === 'MemoryDecl') return true
    if (decl.kind === 'ExportDecl' && decl.item.kind === 'MemoryDecl') return true
  }
  return false
}

function getMemoryDecl(module: AST.Module): { exportName: string | null; min: number; max: number | null } | null {
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

function hasMemoryImport(module: AST.Module): boolean {
  for (const decl of module.decls) {
    if (decl.kind === 'ImportDecl') {
      for (const item of decl.items) {
        if (item.item.kind === 'ImportMemory') return true
      }
    }
  }
  return false
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

  if (imp.kind === 'ImportMemory') {
    const max = imp.max !== undefined ? ` ${imp.max}` : ''
    return `  (import "${moduleName}" "${item.name}" (memory ${imp.min}${max}))`
  }

  return ''
}

function globalToWat(decl: AST.GlobalDecl, ctx: CodegenContext): string {
  const type = ctx.types.get(typeKey(decl.span.start, decl.kind))
  if (!type) {
    throw new Error(`Missing type for global '${decl.ident}' at offset ${decl.span.start}`)
  }
  const wasmType = typeToWasmSingle(type)
  const init = decl.value ? exprToWat(decl.value, ctx) : `(${wasmType}.const 0)`

  return `  (global $${decl.ident} (mut ${wasmType}) ${init})`
}

function exportToWat(decl: AST.ExportDecl, _ctx: CodegenContext): string {
  const name = decl.name
  const item = decl.item

  if (item.kind === 'FuncDecl') {
    const funcName = item.ident ?? 'anonymous'
    return `  (export "${name}" (func $${funcName}))`
  }

  if (item.kind === 'GlobalDecl') {
    return `  (export "${name}" (global $${item.ident}))`
  }

  if (item.kind === 'MemoryDecl') {
    return `  (export "${name}" (memory 0))`
  }

  return ''
}

// Helper to convert AST type to resolved type (simplified)
function resolveAstType(type: AST.Type): ResolvedType {
  switch (type.kind) {
    case 'PrimitiveType':
      return { kind: 'primitive', name: type.name }
    case 'PointerType':
      return { kind: 'pointer', pointee: resolveAstType(type.pointee) }
    case 'IndexedType':
      return {
        kind: 'indexed',
        element: resolveAstType(type.element),
        size: type.size === 'comptime' ? 'comptime' : type.size === 'inferred' ? null : type.size,
        specifiers: type.specifiers.map((s) =>
          s.kind === 'null' ? { kind: 'null' as const } : { kind: 'prefix' as const, prefixType: s.prefixType },
        ),
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

function typeToFields(t: ResolvedType): ResolvedField[] {
  if (t.kind === 'void') return []
  if (t.kind === 'tuple') return t.fields
  return [{ name: null, type: t }]
}
