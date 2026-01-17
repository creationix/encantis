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
  | ComptimeListRT
  | NamedRT

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

// Index specifiers: terminators (/0) and length prefixes (/u8, /u16, /u32, /u64, /leb128)
export type IndexSpecifierRT =
  | { kind: 'null' }
  | { kind: 'prefix'; prefixType: 'u8' | 'u16' | 'u32' | 'u64' | 'leb128' }

// Indexed type: T[], T[N], T[/0], T[/u8], T[/leb128/0], etc.
// Unified representation for slices, arrays, and prefixed/terminated strings
export interface IndexedRT {
  kind: 'indexed'
  element: ResolvedType
  size: number | null // null = runtime/unknown length (slice)
  specifiers: IndexSpecifierRT[] // e.g., [{ kind: 'null' }] for /0
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

// Compile-time list - array literal that infers element type from context
export interface ComptimeListRT {
  kind: 'comptime_list'
  elements: ResolvedType[] // types of each element (may be comptime types)
}

// Named type - wraps a type alias or unique type, preserving the name
// For display purposes: shows the name instead of the underlying type
export interface NamedRT {
  kind: 'named'
  name: string // The alias/unique name (e.g., "Point", "Index")
  type: ResolvedType // The underlying resolved type
  unique: boolean // true for unique types, false for aliases
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
  specifiers: IndexSpecifierRT[] = [],
): IndexedRT {
  return { kind: 'indexed', element, size, specifiers }
}

// Convenience constructors
export function slice(element: ResolvedType): IndexedRT {
  return indexed(element, null, [])
}

export function array(element: ResolvedType, size: number): IndexedRT {
  return indexed(element, size, [])
}

export function nullterm(element: ResolvedType, size: number | null = null, level: number = 1): IndexedRT {
  const specifiers: IndexSpecifierRT[] = Array(level).fill({ kind: 'null' })
  return indexed(element, size, specifiers)
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

export function comptimeList(elements: ResolvedType[]): ComptimeListRT {
  return { kind: 'comptime_list', elements }
}

export function named(name: string, type: ResolvedType, unique: boolean): NamedRT {
  return { kind: 'named', name, type, unique }
}

export function field(
  name: string | null,
  type: ResolvedType,
): ResolvedField {
  return { name, type }
}

// === Type Equality ===

function specifierEquals(a: IndexSpecifierRT, b: IndexSpecifierRT): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'prefix' && b.kind === 'prefix') {
    return a.prefixType === b.prefixType
  }
  return true // both are 'null'
}

function specifiersEqual(a: IndexSpecifierRT[], b: IndexSpecifierRT[]): boolean {
  if (a.length !== b.length) return false
  return a.every((spec, i) => specifierEquals(spec, b[i]))
}

// Check if source specifiers are compatible with target specifiers
// - All-null target: source must have >= target count of nulls (and all nulls)
// - Mixed/prefix target: must match exactly
function specifiersCompatible(target: IndexSpecifierRT[], source: IndexSpecifierRT[]): boolean {
  if (target.length === 0) return true // slice accepts anything

  // Check if target is all nulls
  const targetAllNulls = target.every(s => s.kind === 'null')
  const sourceAllNulls = source.every(s => s.kind === 'null')

  if (targetAllNulls && sourceAllNulls) {
    // u8[/0] accepts u8[/0/0] (more nulls is still valid)
    return source.length >= target.length
  }

  // For mixed specifiers, require exact match
  return specifiersEqual(target, source)
}

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
        specifiersEqual(a.specifiers, bIdx.specifiers) &&
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

    case 'comptime_list': {
      const bList = b as ComptimeListRT
      if (a.elements.length !== bList.elements.length) return false
      return a.elements.every((e, i) => typeEquals(e, bList.elements[i]))
    }

    case 'named': {
      // Unique types are only equal if same name
      if (a.unique) {
        return b.kind === 'named' && b.unique && a.name === b.name
      }
      // Aliases are transparent - compare underlying types
      return typeEquals(a.type, b)
    }
  }
}

function fieldEquals(a: ResolvedField, b: ResolvedField): boolean {
  return a.name === b.name && typeEquals(a.type, b.type)
}

// === Type Assignability ===

// Two orthogonal dimensions of type conversion:
// 1. Lossiness: can the conversion lose information?
//    - lossless: all values preserved (implicit, no `as` needed)
//    - lossy: may truncate/lose precision (explicit `as` required)
// 2. Reinterpret: can the bytes be read directly with different type?
//    - true: same bytes, just different interpretation (e.g., i32↔u32, u8[4]→u32[1])
//    - false: bytes must be re-encoded (e.g., i32→i64 needs sign-extend, u8[]→u16[] needs copy)

export type Lossiness = 'lossless' | 'lossy'

export type AssignResult =
  | { compatible: false }
  | { compatible: true; lossiness: Lossiness; reinterpret: boolean }

// Helper to create results
const INCOMPATIBLE: AssignResult = { compatible: false }
const lossless = (reinterpret: boolean): AssignResult => ({ compatible: true, lossiness: 'lossless', reinterpret })
const lossy = (reinterpret: boolean): AssignResult => ({ compatible: true, lossiness: 'lossy', reinterpret })

// Check if source type can be assigned to target type
// Returns lossiness and reinterpretability
export function typeAssignResult(target: ResolvedType, source: ResolvedType): AssignResult {
  // Handle unique types first - they don't unwrap for assignability
  // Unique types are only assignable to the same unique type
  if (target.kind === 'named' && target.unique) {
    if (source.kind === 'named' && source.unique) {
      return target.name === source.name ? lossless(true) : INCOMPATIBLE
    }
    // Comptime values can coerce to unique types if they fit the underlying type
    const s = unwrap(source)
    if (s.kind === 'comptime_int' || s.kind === 'comptime_float') {
      return typeAssignResult(target.type, s)
    }
    return INCOMPATIBLE
  }
  if (source.kind === 'named' && source.unique) {
    // Unique source cannot be assigned to non-unique target
    return INCOMPATIBLE
  }

  const t = unwrap(target)
  const s = unwrap(source)

  // Exact match (after unwrapping aliases)
  if (typeEquals(t, s)) return lossless(true)

  // Comptime int can coerce to any integer type that fits
  // Not reinterpretable: comptime has no bytes, concrete type does
  if (s.kind === 'comptime_int' && t.kind === 'primitive') {
    return comptimeIntFits(s.value, t) ? lossless(false) : INCOMPATIBLE
  }

  // Comptime float can coerce to f32 or f64
  if (s.kind === 'comptime_float' && t.kind === 'primitive') {
    return (t.name === 'f32' || t.name === 'f64') ? lossless(false) : INCOMPATIBLE
  }

  // Comptime list can coerce to indexed types (arrays, slices, null-terminated, etc.)
  if (s.kind === 'comptime_list' && t.kind === 'indexed') {
    // Check size compatibility
    if (t.size !== null && t.size !== s.elements.length) {
      return INCOMPATIBLE
    }
    // Check all elements can be assigned to target element type
    for (const elem of s.elements) {
      const elemResult = typeAssignResult(t.element, elem)
      if (!elemResult.compatible || elemResult.lossiness !== 'lossless') {
        return INCOMPATIBLE
      }
    }
    // Comptime list can satisfy any specifiers (we know the data at compile time)
    return lossless(false)
  }

  // Integer/float widening is lossless but not reinterpretable (extend instruction)
  if (t.kind === 'primitive' && s.kind === 'primitive') {
    if (isWideningConversion(s.name, t.name)) {
      return lossless(false)
    }
  }

  // Tuple field-by-field coercion (only lossless field conversions allowed)
  if (t.kind === 'tuple' && s.kind === 'tuple') {
    if (t.fields.length !== s.fields.length) return INCOMPATIBLE
    let allReinterpret = true
    for (let i = 0; i < t.fields.length; i++) {
      const tf = t.fields[i]
      const sf = s.fields[i]
      if (tf.name !== sf.name) return INCOMPATIBLE
      const fieldResult = typeAssignResult(tf.type, sf.type)
      // Tuple coercion only allows lossless field conversions
      if (!fieldResult.compatible || fieldResult.lossiness !== 'lossless') return INCOMPATIBLE
      if (!fieldResult.reinterpret) allReinterpret = false
    }
    return lossless(allReinterpret)
  }

  // Indexed type coercion (arrays/slices)
  if (t.kind === 'indexed' && s.kind === 'indexed') {
    const elemResult = typeAssignResult(t.element, s.element)
    if (!elemResult.compatible || elemResult.lossiness !== 'lossless') return INCOMPATIBLE

    // For reinterpretability: element must be reinterpretable AND sizes must work
    // u8[] -> u16[] is NOT reinterpretable (no space for widened elements)
    // u8[10] -> u8[] IS reinterpretable (same bytes, just slice view)

    // Slice (no specifiers) accepts any indexed type with compatible element
    // A null-terminated/prefixed type can be assigned to a slice (it just loses the guarantee)
    if (t.size === null && t.specifiers.length === 0) {
      // Slice reinterpret only if element is reinterpretable (same element type)
      return lossless(elemResult.reinterpret)
    }
    // Check specifier compatibility
    if (!specifiersCompatible(t.specifiers, s.specifiers)) {
      return INCOMPATIBLE
    }
    // Unsized with specifiers accepts sized with compatible specifiers
    if (t.size === null && t.specifiers.length > 0) {
      return lossless(elemResult.reinterpret)
    }
    // Fixed array (no specifiers) accepts same size with no specifiers
    if (t.size !== null && t.specifiers.length === 0) {
      return s.size === t.size && s.specifiers.length === 0 ? lossless(elemResult.reinterpret) : INCOMPATIBLE
    }
    // Fixed with specifiers accepts same size with compatible specifiers
    if (t.size !== null && t.specifiers.length > 0) {
      return s.size === t.size ? lossless(elemResult.reinterpret) : INCOMPATIBLE
    }
  }

  // Lossy+reinterpret: pointer to same-size pointee type
  if (t.kind === 'pointer' && s.kind === 'pointer') {
    const tSize = primitiveByteSize(t.pointee)
    const sSize = primitiveByteSize(s.pointee)
    if (tSize !== null && sSize !== null && tSize === sSize) {
      return lossy(true)
    }
  }

  // Lossy+reinterpret: same-size primitive type punning within same family (i32 <-> u32)
  // Note: int<->float is lossy+not-reinterpret (different value domains)
  if (t.kind === 'primitive' && s.kind === 'primitive') {
    const tSize = primitiveByteSize(t)
    const sSize = primitiveByteSize(s)
    const sameFamily = (isInteger(t) && isInteger(s)) || (isFloat(t) && isFloat(s))
    if (tSize !== null && sSize !== null && tSize === sSize && sameFamily) {
      return lossy(true)
    }
  }

  // Lossy+not-reinterpret: narrowing conversions (i64 -> i32, etc.)
  if (t.kind === 'primitive' && s.kind === 'primitive') {
    if (isNarrowingConversion(s.name, t.name)) {
      return lossy(false)
    }
    // Float <-> int conversions
    if (isFloatIntConversion(s.name, t.name)) {
      return lossy(false)
    }
  }

  return INCOMPATIBLE
}

// Convenience wrapper - check if lossless assignment is possible (no explicit cast needed)
export function typeAssignable(target: ResolvedType, source: ResolvedType): boolean {
  const result = typeAssignResult(target, source)
  return result.compatible && result.lossiness === 'lossless'
}

// === Type Formatting ===

function specifierToString(s: IndexSpecifierRT): string {
  if (s.kind === 'null') return '/0'
  return `/${s.prefixType}`
}

export function typeToString(t: ResolvedType): string {
  switch (t.kind) {
    case 'primitive':
      return t.name

    case 'pointer':
      return `*${typeToString(t.pointee)}`

    case 'indexed': {
      const elem = typeToString(t.element)
      const specs = t.specifiers.map(specifierToString).join('')
      if (t.size !== null) {
        return `${elem}[${t.size}${specs}]`
      } else {
        return `${elem}[${specs}]`
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
      return `int(${t.value})`

    case 'comptime_float':
      return `float(${t.value})`

    case 'comptime_list':
      return `[${t.elements.map(typeToString).join(', ')}]`

    case 'named':
      // For unique/tagged types, show as Type@Tag
      if (t.unique) {
        return `${typeToString(t.type)}@${t.name}`
      }
      // For aliases, just show the name
      return t.name
  }
}

function fieldToString(f: ResolvedField): string {
  if (f.name) {
    return `${f.name}: ${typeToString(f.type)}`
  }
  return typeToString(f.type)
}

// === Type Predicates ===

// Unwrap named types to get the underlying type
export function unwrap(t: ResolvedType): ResolvedType {
  return t.kind === 'named' ? unwrap(t.type) : t
}

export function isInteger(t: ResolvedType): boolean {
  const u = unwrap(t)
  return (
    u.kind === 'primitive' &&
    ['i8', 'i16', 'i32', 'i64', 'u8', 'u16', 'u32', 'u64'].includes(u.name)
  )
}

export function isSigned(t: ResolvedType): boolean {
  const u = unwrap(t)
  return (
    u.kind === 'primitive' &&
    ['i8', 'i16', 'i32', 'i64'].includes(u.name)
  )
}

export function isUnsigned(t: ResolvedType): boolean {
  const u = unwrap(t)
  return (
    u.kind === 'primitive' &&
    ['u8', 'u16', 'u32', 'u64'].includes(u.name)
  )
}

export function isFloat(t: ResolvedType): boolean {
  const u = unwrap(t)
  return u.kind === 'primitive' && ['f32', 'f64'].includes(u.name)
}

export function isNumeric(t: ResolvedType): boolean {
  return isInteger(t) || isFloat(t)
}

export function isBool(t: ResolvedType): boolean {
  const u = unwrap(t)
  return u.kind === 'primitive' && u.name === 'bool'
}

export function isComptime(t: ResolvedType): boolean {
  const u = unwrap(t)
  return u.kind === 'comptime_int' || u.kind === 'comptime_float'
}

// Get bit width of integer type
export function intBitWidth(t: ResolvedType): number | null {
  const u = unwrap(t)
  if (u.kind !== 'primitive') return null
  switch (u.name) {
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

// Get byte size of a primitive type (or null if not primitive)
export function primitiveByteSize(t: ResolvedType): number | null {
  const u = unwrap(t)
  if (u.kind !== 'primitive') return null
  switch (u.name) {
    case 'i8':
    case 'u8':
    case 'bool':
      return 1
    case 'i16':
    case 'u16':
      return 2
    case 'i32':
    case 'u32':
    case 'f32':
      return 4
    case 'i64':
    case 'u64':
    case 'f64':
      return 8
    default:
      return null
  }
}

// Check if converting from one primitive to another is a safe widening conversion
// Widening: smaller type to larger type where all values are preserved
export function isWideningConversion(from: PrimitiveName, to: PrimitiveName): boolean {
  // Same type is not a widening (it's exact match)
  if (from === to) return false

  // Integer widening rules
  const intWidening: Record<string, PrimitiveName[]> = {
    // Signed integers widen to larger signed
    i8: ['i16', 'i32', 'i64'],
    i16: ['i32', 'i64'],
    i32: ['i64'],
    // Unsigned integers widen to larger unsigned OR larger signed (where they fit)
    u8: ['u16', 'u32', 'u64', 'i16', 'i32', 'i64'],
    u16: ['u32', 'u64', 'i32', 'i64'],
    u32: ['u64', 'i64'],
    // Float widening
    f32: ['f64'],
  }

  const allowed = intWidening[from]
  return allowed ? allowed.includes(to) : false
}

// Check if converting from one primitive to another is a narrowing conversion
// Narrowing: larger type to smaller type (may lose data)
export function isNarrowingConversion(from: PrimitiveName, to: PrimitiveName): boolean {
  if (from === to) return false

  // Narrowing is the inverse of widening (but only within same numeric category)
  const intNarrowing: Record<string, PrimitiveName[]> = {
    // Larger signed to smaller signed
    i64: ['i32', 'i16', 'i8'],
    i32: ['i16', 'i8'],
    i16: ['i8'],
    // Larger unsigned to smaller unsigned
    u64: ['u32', 'u16', 'u8'],
    u32: ['u16', 'u8'],
    u16: ['u8'],
    // Float narrowing
    f64: ['f32'],
  }

  const allowed = intNarrowing[from]
  return allowed ? allowed.includes(to) : false
}

// Check if conversion is between float and integer types
export function isFloatIntConversion(from: PrimitiveName, to: PrimitiveName): boolean {
  const floats: PrimitiveName[] = ['f32', 'f64']
  const ints: PrimitiveName[] = ['i8', 'i16', 'i32', 'i64', 'u8', 'u16', 'u32', 'u64']

  const fromIsFloat = floats.includes(from)
  const toIsFloat = floats.includes(to)
  const fromIsInt = ints.includes(from)
  const toIsInt = ints.includes(to)

  // Float to int or int to float
  return (fromIsFloat && toIsInt) || (fromIsInt && toIsFloat)
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
