// Resolved types for type inference
// These are semantic types with no source spans and all TypeRefs resolved

// Primitive type names
export type PrimitiveName =
  | 'i8'
  | 'i16'
  | 'i32'
  | 'i64'
  | 'u8'
  | 'u16'
  | 'u32'
  | 'u64'
  | 'f32'
  | 'f64'
  | 'bool'

// Resolved type variants
export type ResolvedType =
  | PrimitiveRT
  | PointerRT
  | IndexedRT
  | TupleRT
  | FuncRT
  | VoidRT
  | ComptimeIntRT
  | ComptimeFloatRT
  | ComptimeStringRT

// Primitive types: i32, u8, f64, bool, etc.
export interface PrimitiveRT {
  kind: 'primitive'
  name: PrimitiveName
}

// Pointer type: *T
export interface PointerRT {
  kind: 'pointer'
  pointee: ResolvedType
}

// Indexed type: T[], T[N], T[/0], T[N/0]
// Unified representation for slices, arrays, and null-terminated strings
export interface IndexedRT {
  kind: 'indexed'
  element: ResolvedType
  size: number | null // null = runtime/unknown length (slice)
  nullTerminated: boolean
}

// Tuple/struct type: (T, T) or (x: T, y: T)
export interface TupleRT {
  kind: 'tuple'
  fields: ResolvedField[]
}

// Function type
export interface FuncRT {
  kind: 'func'
  params: ResolvedField[]
  returns: ResolvedField[]
}

// Void/unit type: ()
export interface VoidRT {
  kind: 'void'
}

// Compile-time integer - can coerce to any integer type that fits the value
export interface ComptimeIntRT {
  kind: 'comptime_int'
  value: bigint
}

// Compile-time float - can coerce to f32 or f64
export interface ComptimeFloatRT {
  kind: 'comptime_float'
  value: number
}

// Compile-time string - can coerce to slice, array, or null-terminated
// Stores decoded bytes; actual type is u8[N/0] (known length + null terminated)
export interface ComptimeStringRT {
  kind: 'comptime_string'
  bytes: Uint8Array
}

// Field in a tuple/struct or function signature
export interface ResolvedField {
  name: string | null // null for positional/anonymous
  type: ResolvedType
}

// === Type Constructors ===

export function primitive(name: PrimitiveName): PrimitiveRT {
  return { kind: 'primitive', name }
}

export function pointer(pointee: ResolvedType): PointerRT {
  return { kind: 'pointer', pointee }
}

export function indexed(
  element: ResolvedType,
  size: number | null = null,
  nullTerminated: boolean = false,
): IndexedRT {
  return { kind: 'indexed', element, size, nullTerminated }
}

// Convenience constructors
export function slice(element: ResolvedType): IndexedRT {
  return indexed(element, null, false)
}

export function array(element: ResolvedType, size: number): IndexedRT {
  return indexed(element, size, false)
}

export function nullterm(element: ResolvedType, size: number | null = null): IndexedRT {
  return indexed(element, size, true)
}

export function tuple(fields: ResolvedField[]): TupleRT {
  return { kind: 'tuple', fields }
}

export function func(
  params: ResolvedField[],
  returns: ResolvedField[],
): FuncRT {
  return { kind: 'func', params, returns }
}

export const VOID: VoidRT = { kind: 'void' }

export function comptimeInt(value: bigint): ComptimeIntRT {
  return { kind: 'comptime_int', value }
}

export function comptimeFloat(value: number): ComptimeFloatRT {
  return { kind: 'comptime_float', value }
}

export function comptimeString(bytes: Uint8Array): ComptimeStringRT {
  return { kind: 'comptime_string', bytes }
}

export function field(
  name: string | null,
  type: ResolvedType,
): ResolvedField {
  return { name, type }
}

// === Type Equality ===

export function typeEquals(a: ResolvedType, b: ResolvedType): boolean {
  if (a.kind !== b.kind) return false

  switch (a.kind) {
    case 'primitive':
      return a.name === (b as PrimitiveRT).name

    case 'pointer':
      return typeEquals(a.pointee, (b as PointerRT).pointee)

    case 'indexed': {
      const bIdx = b as IndexedRT
      return (
        a.size === bIdx.size &&
        a.nullTerminated === bIdx.nullTerminated &&
        typeEquals(a.element, bIdx.element)
      )
    }

    case 'tuple': {
      const bTuple = b as TupleRT
      if (a.fields.length !== bTuple.fields.length) return false
      return a.fields.every((f, i) => fieldEquals(f, bTuple.fields[i]))
    }

    case 'func': {
      const bFunc = b as FuncRT
      if (a.params.length !== bFunc.params.length) return false
      if (a.returns.length !== bFunc.returns.length) return false
      return (
        a.params.every((p, i) => fieldEquals(p, bFunc.params[i])) &&
        a.returns.every((r, i) => fieldEquals(r, bFunc.returns[i]))
      )
    }

    case 'void':
      return true

    case 'comptime_int':
      return a.value === (b as ComptimeIntRT).value

    case 'comptime_float':
      return a.value === (b as ComptimeFloatRT).value

    case 'comptime_string': {
      const bStr = b as ComptimeStringRT
      if (a.bytes.length !== bStr.bytes.length) return false
      return a.bytes.every((byte, i) => byte === bStr.bytes[i])
    }
  }
}

function fieldEquals(a: ResolvedField, b: ResolvedField): boolean {
  return a.name === b.name && typeEquals(a.type, b.type)
}

// === Type Formatting ===

export function typeToString(t: ResolvedType): string {
  switch (t.kind) {
    case 'primitive':
      return t.name

    case 'pointer':
      return `*${typeToString(t.pointee)}`

    case 'indexed': {
      const elem = typeToString(t.element)
      if (t.nullTerminated) {
        return t.size !== null ? `${elem}[${t.size}/0]` : `${elem}[/0]`
      } else {
        return t.size !== null ? `${elem}[${t.size}]` : `${elem}[]`
      }
    }

    case 'tuple': {
      if (t.fields.length === 0) return '()'
      const fields = t.fields.map(fieldToString).join(', ')
      return `(${fields})`
    }

    case 'func': {
      const params =
        t.params.length === 0 ? '()' : `(${t.params.map(fieldToString).join(', ')})`
      if (t.returns.length === 0) return `func${params}`
      const returns =
        t.returns.length === 1 && t.returns[0].name === null
          ? typeToString(t.returns[0].type)
          : `(${t.returns.map(fieldToString).join(', ')})`
      return `func${params} -> ${returns}`
    }

    case 'void':
      return '()'

    case 'comptime_int':
      return `comptime_int(${t.value})`

    case 'comptime_float':
      return `comptime_float(${t.value})`

    case 'comptime_string': {
      // Try to display as UTF-8 string, fallback to hex
      try {
        const str = new TextDecoder('utf-8', { fatal: true }).decode(t.bytes)
        return `comptime_string(${JSON.stringify(str)}, ${t.bytes.length})`
      } catch {
        const hex = Array.from(t.bytes).map(b => b.toString(16).padStart(2, '0')).join('')
        return `comptime_string(x"${hex}", ${t.bytes.length})`
      }
    }
  }
}

function fieldToString(f: ResolvedField): string {
  if (f.name) {
    return `${f.name}: ${typeToString(f.type)}`
  }
  return typeToString(f.type)
}

// === Type Predicates ===

export function isInteger(t: ResolvedType): boolean {
  return (
    t.kind === 'primitive' &&
    ['i8', 'i16', 'i32', 'i64', 'u8', 'u16', 'u32', 'u64'].includes(t.name)
  )
}

export function isSigned(t: ResolvedType): boolean {
  return (
    t.kind === 'primitive' &&
    ['i8', 'i16', 'i32', 'i64'].includes(t.name)
  )
}

export function isUnsigned(t: ResolvedType): boolean {
  return (
    t.kind === 'primitive' &&
    ['u8', 'u16', 'u32', 'u64'].includes(t.name)
  )
}

export function isFloat(t: ResolvedType): boolean {
  return t.kind === 'primitive' && ['f32', 'f64'].includes(t.name)
}

export function isNumeric(t: ResolvedType): boolean {
  return isInteger(t) || isFloat(t)
}

export function isBool(t: ResolvedType): boolean {
  return t.kind === 'primitive' && t.name === 'bool'
}

export function isComptime(t: ResolvedType): boolean {
  return (
    t.kind === 'comptime_int' ||
    t.kind === 'comptime_float' ||
    t.kind === 'comptime_string'
  )
}

// Get bit width of integer type
export function intBitWidth(t: ResolvedType): number | null {
  if (t.kind !== 'primitive') return null
  switch (t.name) {
    case 'i8':
    case 'u8':
      return 8
    case 'i16':
    case 'u16':
      return 16
    case 'i32':
    case 'u32':
      return 32
    case 'i64':
    case 'u64':
      return 64
    default:
      return null
  }
}

// Check if comptime int value fits in a given integer type
export function comptimeIntFits(value: bigint, target: PrimitiveRT): boolean {
  switch (target.name) {
    case 'i8':
      return value >= -128n && value <= 127n
    case 'u8':
      return value >= 0n && value <= 255n
    case 'i16':
      return value >= -32768n && value <= 32767n
    case 'u16':
      return value >= 0n && value <= 65535n
    case 'i32':
      return value >= -2147483648n && value <= 2147483647n
    case 'u32':
      return value >= 0n && value <= 4294967295n
    case 'i64':
      return value >= -9223372036854775808n && value <= 9223372036854775807n
    case 'u64':
      return value >= 0n && value <= 18446744073709551615n
    default:
      return false
  }
}
