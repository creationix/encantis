// Resolved types for type inference
// These are semantic types with no source spans and all TypeRefs resolved

// Primitive type names
export type PrimitiveName =
  | 'i8'
  | 'i16'
  | 'i32'
  | 'i64'
  | 'i128'
  | 'i256'
  | 'i512'
  | 'u8'
  | 'u16'
  | 'u32'
  | 'u64'
  | 'u128'
  | 'u256'
  | 'u512'
  | 'f32'
  | 'f64'
  | 'bool'

// Type classification constants
const SIGNED: readonly PrimitiveName[] = ['i8', 'i16', 'i32', 'i64', 'i128', 'i256', 'i512']
const UNSIGNED: readonly PrimitiveName[] = ['u8', 'u16', 'u32', 'u64', 'u128', 'u256', 'u512']
const INTEGER: readonly PrimitiveName[] = [...SIGNED, ...UNSIGNED]
const FLOAT: readonly PrimitiveName[] = ['f32', 'f64']

// Integer bounds for comptime int checking
const INT_BOUNDS: Record<string, [bigint, bigint]> = {
  i8: [-128n, 127n],
  u8: [0n, 255n],
  i16: [-32768n, 32767n],
  u16: [0n, 65535n],
  i32: [-2147483648n, 2147483647n],
  u32: [0n, 4294967295n],
  i64: [-9223372036854775808n, 9223372036854775807n],
  u64: [0n, 18446744073709551615n],
  i128: [-(2n ** 127n), 2n ** 127n - 1n],
  u128: [0n, 2n ** 128n - 1n],
  i256: [-(2n ** 255n), 2n ** 255n - 1n],
  u256: [0n, 2n ** 256n - 1n],
  i512: [-(2n ** 511n), 2n ** 511n - 1n],
  u512: [0n, 2n ** 512n - 1n],
}

// Resolved type variants
export type ResolvedType =
  | PrimitiveRT
  | PointerRT
  | SliceRT
  | ArrayRT
  | TupleRT
  | FuncRT
  | VoidRT
  | ComptimeIntRT
  | ComptimeFloatRT
  | ComptimeListRT
  | ComptimeArrayRT
  | NamedRT
  | ForwardRefRT

// Primitive types: i32, u8, f64, bool, etc.
export interface PrimitiveRT {
  kind: 'primitive'
  name: PrimitiveName
}

// Pointer type: *T or *mut T or ^T (boundary pointer)
export interface PointerRT {
  kind: 'pointer'
  pointee: ResolvedType
  boundary?: boolean // true for ^T - can only be compared, not dereferenced
  mutable?: boolean  // true for *mut T, false/undefined for *T (const)
}

// Slice type: []T or []mut T (fat pointer - contains pointer + length)
export interface SliceRT {
  kind: 'slice'
  element: ResolvedType
  mutable?: boolean  // true for []mut T, false/undefined for []T (const)
}

// Array size specifier - can be a number or a framing marker
// Numbers are compile-time known sizes, strings are framing:
// - "_" = inferred at compile-time
// - "!" = null-terminated (runtime sentinel)
// - "?" = LEB128 prefix (runtime length header)
export type ArraySize = number | '_' | '!' | '?'

// Array type: [N]T, [N,M]T, [_]T, [!]T, [?]T
// This is a value type (not a pointer). Use *[N]T (PointerRT wrapping ArrayRT) for pointer-to-array.
// sizes=null means unbounded/unknown count (many-pointer [*]T)
export interface ArrayRT {
  kind: 'array'
  element: ResolvedType
  // sizes can be:
  // - ArraySize[]: one or more dimensions/framings like [N], [N,M], [!], [!,!]
  // - null: unbounded/unknown count (for [*]T many-pointer)
  sizes: ArraySize[] | null
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

// Compile-time array - array literal with known element type and count
// Can coerce to []T, *[N]T, [N]T - more flexible than fixed arrays
export interface ComptimeArrayRT {
  kind: 'comptime_array'
  element: ResolvedType
  count: number
}

// Named type - wraps a type alias, preserving the name
// For display purposes: shows the name instead of the underlying type
export interface NamedRT {
  kind: 'named'
  name: string // The alias name (e.g., "Point", "Index")
  type: ResolvedType // The underlying resolved type
}

// Forward reference - placeholder for recursive type definitions
// These are resolved after all types are collected
export interface ForwardRefRT {
  kind: 'forward_ref'
  name: string // The type name being referenced
}

// Field in a tuple/struct or function signature
export interface ResolvedField {
  name: string | null // null for positional/anonymous
  type: ResolvedType
}

// === Type Constructors ===

/*

     *T → { kind: 'pointer', pointee: T }
     ^T → { kind: 'pointer', pointee: T, boundary: true }
    []T → { kind: 'slice', element: T }
   [_]T → { kind: 'array', element: T, sizes: ["_"] } // used for comptime
   [N]T → { kind: 'array', element: T, sizes: [N] }
   [!]T → { kind: 'array', element: T, sizes: ["!"] }
   [?]T → { kind: 'array', element: T, sizes: ["?"] }
   [*]T → { kind: 'pointer', pointee: { kind: 'array', element: T, sizes: null } }
  *[N]T → { kind: 'pointer', pointee: { kind: 'array', element: T, sizes: [N] } }
  *[_]T → { kind: 'pointer', pointee: { kind: 'array', element: T, sizes: ["_"] } }
  *[!]T → { kind: 'pointer', pointee: { kind: 'array', element: T, sizes: ["!"] } }
  *[?]T → { kind: 'pointer', pointee: { kind: 'array', element: T, sizes: ["?"] } }
*[N,M]T → { kind: 'pointer', pointee: { kind: 'array', element: T, sizes: [N,M] } }
*[!,!]T → { kind: 'pointer', pointee: { kind: 'array', element: T, sizes: ["!","!"] } }

*/


export function primitive(name: PrimitiveName): PrimitiveRT {
  return { kind: 'primitive', name }
}

export function pointer(pointee: ResolvedType, boundary?: boolean, mutable?: boolean): PointerRT {
  const result: PointerRT = { kind: 'pointer', pointee }
  if (boundary) result.boundary = true
  if (mutable) result.mutable = true
  return result
}

export function slice(element: ResolvedType, mutable?: boolean): SliceRT {
  const result: SliceRT = { kind: 'slice', element }
  if (mutable) result.mutable = true
  return result
}

export function array(element: ResolvedType, sizes: ArraySize[] | null): ArrayRT {
  return { kind: 'array', element, sizes }
}

// Convenience constructors

// Many-pointer: [*]T or [*]mut T (thin pointer to unbounded array)
export function manyPointer(element: ResolvedType, mutable?: boolean): PointerRT {
  return pointer(array(element, null), false, mutable)
}

// Pointer to sized array: *[N]T
export function ptrArray(element: ResolvedType, size: number): PointerRT {
  return pointer(array(element, [size]))
}

// Pointer to multi-dimensional array: *[N,M]T
export function ptrPackedArray(element: ResolvedType, sizes: ArraySize[]): PointerRT {
  return pointer(array(element, sizes))
}

// Comptime array: [_]T
export function comptimeArray(element: ResolvedType): ArrayRT {
  return array(element, ['_'])
}

// Helper to check if sizes are all fixed numbers
export function isFixedSizes(sizes: ArraySize[] | null): sizes is number[] {
  if (sizes === null) return false
  return sizes.every(s => typeof s === 'number')
}

// Helper to get total element count from sizes
export function totalElements(sizes: ArraySize[] | null): number | null {
  if (!isFixedSizes(sizes)) return null
  return sizes.reduce((a, b) => a * b, 1)
}

// Check if an array type is a value type: [N]T with fixed 1D size, no framing
export function isValueArray(t: ArrayRT): boolean {
  return t.sizes !== null && t.sizes.length === 1 && typeof t.sizes[0] === 'number'
}

// Helper to check if a size is a framing specifier
export function isFraming(size: ArraySize): size is '!' | '?' {
  return size === '!' || size === '?'
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

export function comptimeArrayLiteral(element: ResolvedType, count: number): ComptimeArrayRT {
  return { kind: 'comptime_array', element, count }
}

export function named(name: string, type: ResolvedType): NamedRT {
  return { kind: 'named', name, type }
}

export function forwardRef(name: string): ForwardRefRT {
  return { kind: 'forward_ref', name }
}

export function field(
  name: string | null,
  type: ResolvedType,
): ResolvedField {
  return { name, type }
}

// Create the default concrete type for a comptime list or array
// Comptime arrays default to *[_]T (pointer to inferred-size array)
export function defaultArrayType(t: ResolvedType): PointerRT | null {
  // Handle comptime_list: find innermost element and count depth
  if (t.kind === 'comptime_list') {
    // Find common element type and max depth
    let depth = 1
    let elemType: ResolvedType | null = null

    for (const elem of t.elements) {
      const { element, nesting } = findInnermostElement(elem)
      if (elemType === null) {
        elemType = element
        depth = Math.max(depth, nesting + 1)
      } else if (!typeEquals(elemType, element)) {
        // Heterogeneous list - can't create default type
        return null
      } else {
        depth = Math.max(depth, nesting + 1)
      }
    }

    // Empty list defaults to *[_]u8
    if (elemType === null) {
      elemType = primitive('u8')
    }

    // Apply defaults to the innermost element type
    const resolvedElem = defaultizeElement(elemType)
    if (resolvedElem === null) return null

    // Build sizes: one '_' per nesting level (comptime/inferred)
    const sizes: ArraySize[] = Array(depth).fill('_')
    return pointer(array(resolvedElem, sizes))
  }

  // Handle comptime array type ([_]T)
  if (t.kind === 'array' && t.sizes?.includes('_')) {
    let depth = 1
    let elem = t.element
    while (elem.kind === 'array' && elem.sizes?.includes('_')) {
      depth++
      elem = elem.element
    }

    const resolvedElem = defaultizeElement(elem)
    if (resolvedElem === null) return null

    const sizes: ArraySize[] = Array(depth).fill('_')
    return pointer(array(resolvedElem, sizes))
  }

  return null
}

// Find the innermost non-comptime-list element and count nesting depth
function findInnermostElement(t: ResolvedType): { element: ResolvedType; nesting: number } {
  if (t.kind === 'comptime_list') {
    if (t.elements.length === 0) {
      return { element: primitive('u8'), nesting: 1 }
    }
    const inner = findInnermostElement(t.elements[0])
    return { element: inner.element, nesting: inner.nesting + 1 }
  }
  if (t.kind === 'array' && t.sizes?.includes('_')) {
    const inner = findInnermostElement(t.element)
    return { element: inner.element, nesting: inner.nesting + 1 }
  }
  return { element: t, nesting: 0 }
}

// Apply default rules to element types (comptime_int → i32, comptime_float → f64)
function defaultizeElement(t: ResolvedType): ResolvedType | null {
  if (t.kind === 'comptime_int') {
    return primitive('i32')
  }
  if (t.kind === 'comptime_float') {
    return primitive('f64')
  }
  if (t.kind === 'primitive') {
    return t
  }
  // For other types (tuples, pointers, etc.), can't auto-default
  return null
}

// === Type Equality ===

// Compare array sizes (handles multi-dimensional arrays)
function sizesEqual(a: ArraySize[] | null, b: ArraySize[] | null): boolean {
  if (a === b) return true // handles null
  if (a === null || b === null) return false
  if (a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}

// Check if source sizes are compatible with target sizes for coercion
// - Comptime sizes ('_') can coerce to any framing
// - Fixed sizes must match
function sizesCompatible(target: ArraySize[] | null, source: ArraySize[] | null): boolean {
  // Unbounded target accepts anything
  if (target === null) return true
  // Unbounded source can't satisfy bounded target
  if (source === null) return false

  // Comptime source ('_') can coerce to any framing
  if (source.length === 1 && source[0] === '_') return true

  // Otherwise sizes must match exactly
  return sizesEqual(target, source)
}

export function typeEquals(a: ResolvedType, b: ResolvedType): boolean {
  if (a.kind !== b.kind) return false

  switch (a.kind) {
    case 'primitive':
      return a.name === (b as PrimitiveRT).name

    case 'pointer': {
      const bPtr = b as PointerRT
      return !!a.boundary === !!bPtr.boundary && !!a.mutable === !!bPtr.mutable && typeEquals(a.pointee, bPtr.pointee)
    }

    case 'slice': {
      const bSlice = b as SliceRT
      return !!a.mutable === !!bSlice.mutable && typeEquals(a.element, bSlice.element)
    }

    case 'array': {
      const bArr = b as ArrayRT
      return sizesEqual(a.sizes, bArr.sizes) && typeEquals(a.element, bArr.element)
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

    case 'comptime_array': {
      const bArr = b as ComptimeArrayRT
      return a.count === bArr.count && typeEquals(a.element, bArr.element)
    }

    case 'named': {
      // Aliases are transparent - compare underlying types
      return typeEquals(a.type, b)
    }

    case 'forward_ref':
      // Forward refs are equal if they reference the same type name
      return b.kind === 'forward_ref' && a.name === b.name
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
//    - true: same bytes, just different interpretation (e.g., i32↔u32, [4]u8→[1]u32)
//    - false: bytes must be re-encoded (e.g., i32→i64 needs sign-extend, []u8→[]u16 needs copy)

export type Lossiness = 'lossless' | 'lossy'

export type AssignResult =
  | { compatible: false }
  | { compatible: true; lossiness: Lossiness; reinterpret: boolean }

// Helper to create results
const INCOMPATIBLE: AssignResult = { compatible: false }
const lossless = (reinterpret: boolean): AssignResult => ({ compatible: true, lossiness: 'lossless', reinterpret })
const lossy = (reinterpret: boolean): AssignResult => ({ compatible: true, lossiness: 'lossy', reinterpret })

// Mutability compatibility: mut→const OK, const→mut NOT OK
function mutCompatible(targetMut: boolean | undefined, sourceMut: boolean | undefined): boolean {
  if (targetMut && !sourceMut) return false
  return true
}

// Check if source type can be assigned to target type
// Returns lossiness and reinterpretability
export function typeAssignResult(target: ResolvedType, source: ResolvedType): AssignResult {
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

  // Comptime list can coerce to slice
  if (s.kind === 'comptime_list' && t.kind === 'slice') {
    // Check all elements can be assigned to target element type
    for (const elem of s.elements) {
      const elemResult = typeAssignResult(t.element, elem)
      if (!elemResult.compatible || elemResult.lossiness !== 'lossless') {
        return INCOMPATIBLE
      }
    }
    return lossless(false)
  }

  // Comptime list can coerce to array types
  if (s.kind === 'comptime_list' && t.kind === 'array') {
    // Can't assign to comptime array type [_]T - needs to be pointer-wrapped
    if (t.sizes?.includes('_')) return INCOMPATIBLE
    // Check size compatibility for fixed arrays
    if (t.sizes && isFixedSizes(t.sizes)) {
      const total = totalElements(t.sizes)
      if (total !== null && total !== s.elements.length) {
        return INCOMPATIBLE
      }
    }
    // Check all elements can be assigned to target element type
    for (const elem of s.elements) {
      const elemResult = typeAssignResult(t.element, elem)
      if (!elemResult.compatible || elemResult.lossiness !== 'lossless') {
        return INCOMPATIBLE
      }
    }
    return lossless(false)
  }

  // Comptime list can coerce to pointer-to-array types (*[N]T, *[!]T, etc.)
  if (s.kind === 'comptime_list' && t.kind === 'pointer' && t.pointee.kind === 'array') {
    const targetArray = t.pointee
    // Check size compatibility for fixed arrays
    if (targetArray.sizes && isFixedSizes(targetArray.sizes)) {
      const total = totalElements(targetArray.sizes)
      if (total !== null && total !== s.elements.length) {
        return INCOMPATIBLE
      }
    }
    // Check all elements can be assigned to target element type
    for (const elem of s.elements) {
      const elemResult = typeAssignResult(targetArray.element, elem)
      if (!elemResult.compatible || elemResult.lossiness !== 'lossless') {
        return INCOMPATIBLE
      }
    }
    return lossless(false)
  }

  // Comptime array literal can coerce to slice: comptime_array -> []T
  if (s.kind === 'comptime_array' && t.kind === 'slice') {
    const elemResult = typeAssignResult(t.element, s.element)
    if (elemResult.compatible && elemResult.lossiness === 'lossless') {
      return lossless(false)
    }
  }

  // Comptime array literal can coerce to fixed array: comptime_array -> [N]T
  if (s.kind === 'comptime_array' && t.kind === 'array') {
    // Can't assign to inferred-size array [_]T
    if (t.sizes?.includes('_')) return INCOMPATIBLE
    // Check size compatibility
    if (t.sizes && isFixedSizes(t.sizes)) {
      const total = totalElements(t.sizes)
      if (total !== null && total !== s.count) {
        return INCOMPATIBLE
      }
    }
    const elemResult = typeAssignResult(t.element, s.element)
    if (elemResult.compatible && elemResult.lossiness === 'lossless') {
      return lossless(false)
    }
  }

  // Comptime array literal can coerce to pointer-to-array: comptime_array -> *[N]T or *[N,M]T
  if (s.kind === 'comptime_array' && t.kind === 'pointer' && t.pointee.kind === 'array') {
    const targetArray = t.pointee
    if (targetArray.sizes && isFixedSizes(targetArray.sizes)) {
      if (targetArray.sizes.length === 1) {
        // 1D: count must match
        if (targetArray.sizes[0] !== s.count) return INCOMPATIBLE
        const elemResult = typeAssignResult(targetArray.element, s.element)
        if (elemResult.compatible && elemResult.lossiness === 'lossless') return lossless(false)
      } else {
        // Multi-dim: outer dimension must match count, element must coerce to *[remaining]T
        if (targetArray.sizes[0] !== s.count) return INCOMPATIBLE
        const innerTarget = pointer(array(targetArray.element, targetArray.sizes.slice(1)))
        const elemResult = typeAssignResult(innerTarget, s.element)
        if (elemResult.compatible && elemResult.lossiness === 'lossless') return lossless(false)
      }
    } else {
      // Unsized: just check element compatibility
      const elemResult = typeAssignResult(targetArray.element, s.element)
      if (elemResult.compatible && elemResult.lossiness === 'lossless') return lossless(false)
    }
  }

  // Comptime array [_]T can coerce to pointer-to-array *[N]T, *[!]T, etc.
  if (s.kind === 'array' && s.sizes?.includes('_') && t.kind === 'pointer' && t.pointee.kind === 'array') {
    // Check element types are compatible
    const elemResult = typeAssignResult(t.pointee.element, s.element)
    if (!elemResult.compatible || elemResult.lossiness !== 'lossless') return INCOMPATIBLE
    return lossless(false)
  }

  // Fixed array coerces to pointer-to-array: [N]T → *[N]T
  if (s.kind === 'array' && t.kind === 'pointer' && t.pointee.kind === 'array') {
    if (!s.sizes?.includes('_')) {
      const elemResult = typeAssignResult(t.pointee.element, s.element)
      if (elemResult.compatible && elemResult.lossiness === 'lossless') {
        if (sizesCompatible(t.pointee.sizes, s.sizes)) return lossless(false)
      }
    }
  }

  // Fixed array coerces to slice: [N]T → []T
  if (s.kind === 'array' && t.kind === 'slice' && !s.sizes?.includes('_')) {
    const elemResult = typeAssignResult(t.element, s.element)
    if (elemResult.compatible && elemResult.lossiness === 'lossless') return lossless(false)
  }

  // Fixed array coerces to many-pointer: [N]T → [*]T
  if (s.kind === 'array' && t.kind === 'pointer' && t.pointee.kind === 'array' && t.pointee.sizes === null) {
    const elemResult = typeAssignResult(t.pointee.element, s.element)
    if (elemResult.compatible && elemResult.lossiness === 'lossless') return lossless(false)
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

  // Array type coercion
  if (t.kind === 'array' && s.kind === 'array') {
    // Can't assign to comptime array type [_]T
    if (t.sizes?.includes('_')) return INCOMPATIBLE

    // Comptime source can coerce to any framing
    if (s.sizes?.includes('_')) {
      const elemResult = typeAssignResult(t.element, s.element)
      if (!elemResult.compatible || elemResult.lossiness !== 'lossless') return INCOMPATIBLE
      return lossless(false)
    }

    // Check element type compatibility
    const elemResult = typeAssignResult(t.element, s.element)
    if (!elemResult.compatible || elemResult.lossiness !== 'lossless') return INCOMPATIBLE

    // Check sizes compatibility
    if (!sizesCompatible(t.sizes, s.sizes)) return INCOMPATIBLE

    return lossless(elemResult.reinterpret)
  }

  // Slice coercion
  if (t.kind === 'slice' && s.kind === 'slice') {
    if (!mutCompatible(t.mutable, s.mutable)) return INCOMPATIBLE
    const elemResult = typeAssignResult(t.element, s.element)
    if (!elemResult.compatible || elemResult.lossiness !== 'lossless') return INCOMPATIBLE
    return lossless(elemResult.reinterpret)
  }

  // Mutable pointer coerces to const pointer: *mut T -> *T (widening)
  if (t.kind === 'pointer' && s.kind === 'pointer' && s.mutable && !t.mutable) {
    if (typeEquals(t.pointee, s.pointee)) {
      return lossless(true)
    }
    // Also handle *mut [N]T -> *[N]T where pointees match structurally
    if (t.pointee.kind === s.pointee.kind) {
      const innerResult = typeAssignResult(pointer(t.pointee), pointer(s.pointee))
      if (innerResult.compatible && innerResult.lossiness === 'lossless') {
        return lossless(true)
      }
    }
  }

  // Pointer-to-array can coerce to slice: *[N]T -> []T (respects mutability)
  if (t.kind === 'slice' && s.kind === 'pointer' && s.pointee.kind === 'array') {
    if (!mutCompatible(t.mutable, s.mutable)) return INCOMPATIBLE
    const elemResult = typeAssignResult(t.element, s.pointee.element)
    if (elemResult.compatible && elemResult.lossiness === 'lossless') {
      return lossless(elemResult.reinterpret)
    }
  }

  // Pointer-to-array can coerce to many-pointer: *[N]T -> [*]T (respects mutability)
  if (t.kind === 'pointer' && t.pointee.kind === 'array' && t.pointee.sizes === null &&
      s.kind === 'pointer' && s.pointee.kind === 'array' && s.pointee.sizes !== null) {
    if (!mutCompatible(t.mutable, s.mutable)) return INCOMPATIBLE
    const elemResult = typeAssignResult(t.pointee.element, s.pointee.element)
    if (elemResult.compatible && elemResult.lossiness === 'lossless') {
      return lossless(true)
    }
  }

  // Comptime array can coerce to slice: [_]T -> []T
  // Array literals are always placed in data section, so implicit &array is taken
  if (t.kind === 'slice' && s.kind === 'array' && s.sizes?.includes('_')) {
    const elemResult = typeAssignResult(t.element, s.element)
    if (elemResult.compatible && elemResult.lossiness === 'lossless') {
      return lossless(false)  // Not reinterpretable - creates fat pointer from array
    }
  }

  // Many-pointer [*]T can coerce to plain pointer *T
  // This is a demotion - we lose the "multiple elements" information
  if (t.kind === 'pointer' && s.kind === 'pointer' && s.pointee.kind === 'array' && s.pointee.sizes === null) {
    // Check element types match
    if (typeEquals(t.pointee, s.pointee.element)) {
      return lossless(true)
    }
  }

  // Function type assignability (exact match required)
  // Functions are reference types (table indices), so no coercion is possible
  if (t.kind === 'func' && s.kind === 'func') {
    // Must have same number of params and returns
    if (t.params.length !== s.params.length) return INCOMPATIBLE
    if (t.returns.length !== s.returns.length) return INCOMPATIBLE
    // Check each param type matches exactly
    for (let i = 0; i < t.params.length; i++) {
      if (!typeEquals(t.params[i].type, s.params[i].type)) return INCOMPATIBLE
    }
    // Check each return type matches exactly
    for (let i = 0; i < t.returns.length; i++) {
      if (!typeEquals(t.returns[i].type, s.returns[i].type)) return INCOMPATIBLE
    }
    return lossless(true) // Exact same function type, reinterpret as same value
  }

  // Lossy+reinterpret: pointer to same-size pointee type
  if (t.kind === 'pointer' && s.kind === 'pointer') {
    if (!mutCompatible(t.mutable, s.mutable)) return INCOMPATIBLE
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

// Format array sizes for display
function sizesToString(sizes: ArraySize[] | null): string {
  if (sizes === null) return '*'  // unbounded [*]T
  return sizes.map(s => typeof s === 'number' ? String(s) : s).join(',')
}

export function typeToString(t: ResolvedType, opts?: { compact?: boolean }): string {
  const compact = opts?.compact ?? false
  const sep = compact ? ',' : ', '
  const arrow = compact ? '->' : ' -> '

  switch (t.kind) {
    case 'primitive':
      return t.name

    case 'pointer': {
      // Many-pointer: [*]T or [*]mut T
      if (t.pointee.kind === 'array' && t.pointee.sizes === null) {
        const mut = t.mutable ? 'mut ' : ''
        return `[*]${mut}${typeToString(t.pointee.element, opts)}`
      }
      const prefix = t.boundary ? '^' : '*'
      const mut = t.mutable ? 'mut ' : ''
      return `${prefix}${mut}${typeToString(t.pointee, opts)}`
    }

    case 'slice': {
      const mut = t.mutable ? 'mut ' : ''
      return `[]${mut}${typeToString(t.element, opts)}`
    }

    case 'array': {
      // [N]T, [N,M]T, [_]T, [!]T, [?]T, [*]T
      const elem = typeToString(t.element, opts)
      const sizes = sizesToString(t.sizes)
      return `[${sizes}]${elem}`
    }

    case 'tuple': {
      if (t.fields.length === 0) return '()'
      const fields = t.fields.map((f) => fieldToString(f, opts)).join(sep)
      return `(${fields})`
    }

    case 'func': {
      const params =
        t.params.length === 0
          ? '()'
          : `(${t.params.map((f) => fieldToString(f, opts)).join(sep)})`
      if (t.returns.length === 0) return compact ? `${params}->()` : `func${params}`
      const returns =
        t.returns.length === 1 && t.returns[0].name === null
          ? typeToString(t.returns[0].type, opts)
          : `(${t.returns.map((f) => fieldToString(f, opts)).join(sep)})`
      return compact ? `${params}${arrow}${returns}` : `func${params}${arrow}${returns}`
    }

    case 'void':
      return '()'

    case 'comptime_int':
      return compact ? `comptime_int(${t.value})` : `int(${t.value})`

    case 'comptime_float':
      return compact ? `comptime_float(${t.value})` : `float(${t.value})`

    case 'comptime_list':
      return `[${t.elements.map((e) => typeToString(e, opts)).join(sep)}]`

    case 'comptime_array':
      return `[${t.count}]${typeToString(t.element, opts)}`

    case 'named':
      // Just show the alias name
      return t.name

    case 'forward_ref':
      // Forward reference - just show the type name
      return t.name
  }
}

function fieldToString(f: ResolvedField, opts?: { compact?: boolean }): string {
  const sep = opts?.compact ? ':' : ': '
  if (f.name) {
    return `${f.name}${sep}${typeToString(f.type, opts)}`
  }
  return typeToString(f.type, opts)
}

// === Type Predicates ===

// Unwrap named types to get the underlying type
export function unwrap(t: ResolvedType): ResolvedType {
  return t.kind === 'named' ? unwrap(t.type) : t
}

export function isInteger(t: ResolvedType): boolean {
  const u = unwrap(t)
  return u.kind === 'primitive' && INTEGER.includes(u.name)
}

export function isSigned(t: ResolvedType): boolean {
  const u = unwrap(t)
  return u.kind === 'primitive' && SIGNED.includes(u.name)
}

export function isUnsigned(t: ResolvedType): boolean {
  const u = unwrap(t)
  return u.kind === 'primitive' && UNSIGNED.includes(u.name)
}

export function isFloat(t: ResolvedType): boolean {
  const u = unwrap(t)
  return u.kind === 'primitive' && FLOAT.includes(u.name)
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
    case 'i128':
    case 'u128':
      return 16
    case 'i256':
    case 'u256':
      return 32
    case 'i512':
    case 'u512':
      return 64
    default:
      return null
  }
}

// Check if converting from one primitive to another is a safe widening conversion
// Widening: smaller type to larger type where all values are preserved
export function isWideningConversion(from: PrimitiveName, to: PrimitiveName): boolean {
  if (from === to) return false
  if (from === 'f32' && to === 'f64') return true
  const fromBounds = INT_BOUNDS[from]
  const toBounds = INT_BOUNDS[to]
  if (!fromBounds || !toBounds) return false
  return fromBounds[0] >= toBounds[0] && fromBounds[1] <= toBounds[1]
}

// Check if converting from one primitive to another is a narrowing conversion
// Narrowing: larger type to smaller type (may lose data)
export function isNarrowingConversion(from: PrimitiveName, to: PrimitiveName): boolean {
  if (from === to) return false
  // Narrowing is the inverse of widening within same signedness category
  if (from === 'f64' && to === 'f32') return true
  const fromBounds = INT_BOUNDS[from]
  const toBounds = INT_BOUNDS[to]
  if (!fromBounds || !toBounds) return false
  // Same sign family: narrowing if target is strictly smaller
  const fromSigned = from.startsWith('i')
  const toSigned = to.startsWith('i')
  const fromUnsigned = from.startsWith('u')
  const toUnsigned = to.startsWith('u')
  if ((fromSigned && toSigned) || (fromUnsigned && toUnsigned)) {
    return toBounds[1] < fromBounds[1]
  }
  return false
}


// Check if conversion is between float and integer types
export function isFloatIntConversion(from: PrimitiveName, to: PrimitiveName): boolean {
  const fromIsFloat = FLOAT.includes(from)
  const toIsFloat = FLOAT.includes(to)
  const fromIsInt = INTEGER.includes(from)
  const toIsInt = INTEGER.includes(to)
  return (fromIsFloat && toIsInt) || (fromIsInt && toIsFloat)
}

// Get byte offset of a field within a compound type stored in memory
export function fieldByteOffset(t: ResolvedType, fieldName: string): number | null {
  const u = unwrap(t)
  if (u.kind === 'slice') {
    if (fieldName === 'ptr') return 0
    if (fieldName === 'len') return 4
    return null
  }
  if (u.kind === 'tuple') {
    let offset = 0
    for (const f of u.fields) {
      if (f.name === fieldName) return offset
      const size = byteSize(f.type)
      if (size === null) return null
      offset += size
    }
    return null
  }
  return null
}

// Check if comptime int value fits in a given integer type
export function comptimeIntFits(value: bigint, target: PrimitiveRT): boolean {
  const bounds = INT_BOUNDS[target.name]
  if (!bounds) return false
  return value >= bounds[0] && value <= bounds[1]
}

// Get byte size of any type (returns null for dynamically-sized types like slices)
export function byteSize(t: ResolvedType): number | null {
  const u = unwrap(t)

  switch (u.kind) {
    case 'primitive':
      return primitiveByteSize(u)

    case 'pointer':
      // Pointers are always 4 bytes in wasm32
      return 4

    case 'slice':
      // Slices are fat pointers: ptr + len = 8 bytes in wasm32
      return 8

    case 'array': {
      // Only fixed arrays have known size
      const total = totalElements(u.sizes)
      if (total === null) return null
      const elemSize = byteSize(u.element)
      if (elemSize === null) return null
      return total * elemSize
    }

    case 'tuple': {
      let total = 0
      for (const f of u.fields) {
        const fieldSize = byteSize(f.type)
        if (fieldSize === null) return null
        total += fieldSize
      }
      return total
    }

    case 'void':
      return 0

    default:
      return null
  }
}
