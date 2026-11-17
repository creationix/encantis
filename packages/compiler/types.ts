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

export const PRIMITIVE_NAMES: ReadonlySet<string> = new Set<PrimitiveName>([...INTEGER, ...FLOAT, 'bool'])

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
// For unsigned integers, max is an optional upper bound (exclusive): u8#16 means [0, 16)
export interface PrimitiveRT {
  kind: 'primitive'
  name: PrimitiveName
  max?: number
}

// Pointer type: *T or *mut T or ^T (boundary pointer)
export interface PointerRT {
  kind: 'pointer'
  pointee: ResolvedType
  boundary?: boolean // true for ^T - can only be compared, not dereferenced
  mutable?: boolean  // true for *mut T, false/undefined for *T (const)
  optional?: boolean // true for ?*T - nullable pointer (0 = none)
}

// Slice type: []T or []mut T (fat pointer - contains pointer + length)
export interface SliceRT {
  kind: 'slice'
  element: ResolvedType
  mutable?: boolean  // true for []mut T, false/undefined for []T (const)
  optional?: boolean // true for ?[]T - nullable slice (ptr=0 = none)
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
  // A bit pattern made with ~ (~3, ~0 << 4). In an unsigned type it stands
  // for the low bits of its negative value, so it also fits an unsigned type
  // that holds its complement: ~3 is a u8 (0xfc), ~300 isn't.
  bits?: true
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

// Forward reference - a type named before it is resolved: one declared further
// down, or one that refers to itself. `target` is set once the type is
// resolved, and unwrap() follows it. A type that refers to itself is a cycle
// that always passes through one of these, so a walk that goes into what a
// pointer points to stops here (unwrapToCut) or remembers where it has been
// (typeEquals, typeAssignResult, canonicalKey).
export interface ForwardRefRT {
  kind: 'forward_ref'
  name: string // The type name being referenced
  target?: ResolvedType
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


export function primitive(name: PrimitiveName, max?: number): PrimitiveRT {
  const result: PrimitiveRT = { kind: 'primitive', name }
  if (max !== undefined) result.max = max
  return result
}

export function pointer(pointee: ResolvedType, boundary?: boolean, mutable?: boolean, optional?: boolean): PointerRT {
  const result: PointerRT = { kind: 'pointer', pointee }
  if (boundary) result.boundary = true
  if (mutable) result.mutable = true
  if (optional) result.optional = true
  return result
}

export function slice(element: ResolvedType, mutable?: boolean, optional?: boolean): SliceRT {
  const result: SliceRT = { kind: 'slice', element }
  if (mutable) result.mutable = true
  if (optional) result.optional = true
  return result
}

// A name for a pointer or a slice is the type it names: these see through it.
export function optionalOf(type: ResolvedType): ResolvedType {
  const u = unwrap(type)
  if (u.kind === 'pointer') return { ...u, optional: true }
  if (u.kind === 'slice') return { ...u, optional: true }
  return type
}

export function isOptional(type: ResolvedType): boolean {
  const u = unwrap(type)
  return (u.kind === 'pointer' || u.kind === 'slice') && !!u.optional
}

export function unwrapOptional(written: ResolvedType): ResolvedType {
  const type = isOptional(written) ? unwrap(written) : written
  if (type.kind === 'pointer' && type.optional) {
    const result: PointerRT = { ...type }
    delete result.optional
    return result
  }
  if (type.kind === 'slice' && type.optional) {
    const result: SliceRT = { ...type }
    delete result.optional
    return result
  }
  return type
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

// A pointer or slice whose element is an array (*[N][M]T, [][M]T, [*][M]T,
// and rows that are framed or packed: *[N][!]T, *[N][AxB]T) is a table: each
// element is a pointer to its row, which is laid out on its own, as the data
// packer lays out the literal. A fixed array that is a field of a struct, or a
// value in registers, lies in place instead. Returns the row pointer an
// element is (*[M]T, *mut [M]T in a mutable table), or null when the type
// isn't a table. *[NxM]T is one packed block, not a table.
export function tableRow(t: ResolvedType): PointerRT | null {
  const u = unwrap(t)
  let element: ResolvedType
  if (u.kind === 'slice') {
    element = u.element
  } else if (u.kind === 'pointer' && u.pointee.kind === 'array' && (u.pointee.sizes === null || u.pointee.sizes.length === 1)) {
    element = u.pointee.element
  } else {
    return null
  }
  const row = unwrap(element)
  if (!isRowArray(row)) return null
  return pointer(row, false, u.mutable)
}

// An array type that, as the element of a pointer or slice, is a row laid
// out on its own: one with a size, fixed ([M]T), framed ([!]T) or packed
// ([AxB]T). The size of a row a literal gives ([_]T) is still to be known.
export function isRowArray(t: ResolvedType): t is ArrayRT {
  return t.kind === 'array' && t.sizes !== null && t.sizes.length > 0 && !t.sizes.includes('_')
}

// The array a null-terminated pointer reads (the [!]T of a *[!]T, or the
// [!]T itself, which is held as its pointer), or null for any other type.
export function framedArray(t: ResolvedType): ArrayRT | null {
  const u = unwrap(t)
  const array = u.kind === 'pointer' ? unwrap(u.pointee) : u
  return array.kind === 'array' && array.sizes?.length === 1 && array.sizes[0] === '!' ? array : null
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

export function comptimeInt(value: bigint, bits = false): ComptimeIntRT {
  return bits ? { kind: 'comptime_int', value, bits } : { kind: 'comptime_int', value }
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

export function typeEquals(a: ResolvedType, b: ResolvedType, assumed?: Assumed): boolean {
  if (a === b) return true
  // Aliases are transparent on either side, at any depth (e.g. the pointee of
  // [*]mut Slot): compare the underlying types.
  if (a.kind === 'named') return typeEquals(a.type, b, assumed)
  if (b.kind === 'named') return typeEquals(a, b.type, assumed)
  const followed = followRefs(a, b, assumed)
  if (followed === 'assumed') return true
  if (followed) return typeEquals(followed.a, followed.b, followed.assumed)
  if (a.kind !== b.kind) return false

  switch (a.kind) {
    case 'primitive':
      return a.name === (b as PrimitiveRT).name && a.max === (b as PrimitiveRT).max

    case 'pointer': {
      const bPtr = b as PointerRT
      return !!a.boundary === !!bPtr.boundary && !!a.mutable === !!bPtr.mutable && !!a.optional === !!bPtr.optional && typeEquals(a.pointee, bPtr.pointee, assumed)
    }

    case 'slice': {
      const bSlice = b as SliceRT
      return !!a.mutable === !!bSlice.mutable && !!a.optional === !!bSlice.optional && typeEquals(a.element, bSlice.element, assumed)
    }

    case 'array': {
      const bArr = b as ArrayRT
      return sizesEqual(a.sizes, bArr.sizes) && typeEquals(a.element, bArr.element, assumed)
    }

    case 'tuple': {
      const bTuple = b as TupleRT
      if (a.fields.length !== bTuple.fields.length) return false
      return a.fields.every((f, i) => fieldEquals(f, bTuple.fields[i], assumed))
    }

    case 'func': {
      const bFunc = b as FuncRT
      if (a.params.length !== bFunc.params.length) return false
      if (a.returns.length !== bFunc.returns.length) return false
      return (
        a.params.every((p, i) => fieldEquals(p, bFunc.params[i], assumed)) &&
        a.returns.every((r, i) => fieldEquals(r, bFunc.returns[i], assumed))
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
      return a.elements.every((e, i) => typeEquals(e, bList.elements[i], assumed))
    }

    case 'comptime_array': {
      const bArr = b as ComptimeArrayRT
      return a.count === bArr.count && typeEquals(a.element, bArr.element, assumed)
    }

    case 'forward_ref':
      // Forward refs are equal if they reference the same type name
      return b.kind === 'forward_ref' && a.name === b.name
  }
}

function fieldEquals(a: ResolvedField, b: ResolvedField, assumed?: Assumed): boolean {
  return a.name === b.name && typeEquals(a.type, b.type, assumed)
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

// Whether unwrap() goes through a forward reference on its way
function throughRef(t: ResolvedType): boolean {
  while (t.kind === 'named') t = t.type
  return t.kind === 'forward_ref' && t.target !== undefined
}

// The pairs of types whose assignability is being decided, where one of them
// is a type that refers to itself. Coming round to one again, it holds: what
// is still to be compared on the way is compared elsewhere.
const assigning: (readonly [ResolvedType, ResolvedType])[] = []

// Check if source type can be assigned to target type
// Returns lossiness and reinterpretability
export function typeAssignResult(target: ResolvedType, source: ResolvedType): AssignResult {
  if (!throughRef(target) && !throughRef(source)) return assignResult(target, source)
  if (assigning.some(([t, s]) => t === target && s === source)) return lossless(true)
  assigning.push([target, source])
  try {
    return assignResult(target, source)
  } finally {
    assigning.pop()
  }
}

function assignResult(target: ResolvedType, source: ResolvedType): AssignResult {
  const t = unwrap(target)
  const s = unwrap(source)

  // Exact match (after unwrapping aliases)
  if (typeEquals(t, s)) return lossless(true)

  // Ranged integer widening: u8#8 → u8#16 → u8 (narrower range fits wider)
  if (t.kind === 'primitive' && s.kind === 'primitive' && t.name === s.name) {
    if (s.max !== undefined && (t.max === undefined || s.max <= t.max)) {
      return lossless(true)
    }
  }

  // Non-optional widens to optional: *T → ?*T, []T → ?[]T
  if (isOptional(t) && !isOptional(s)) {
    return typeAssignResult(unwrapOptional(t), s)
  }

  // Comptime int can coerce to any integer type that fits, and to a float
  // that holds it exactly
  // Not reinterpretable: comptime has no bytes, concrete type does
  if (s.kind === 'comptime_int' && t.kind === 'primitive') {
    const fits = comptimeIntFits(s.value, t) || (s.bits === true && t.max === undefined && comptimeIntFits(~s.value, t))
    return fits ? lossless(false) : INCOMPATIBLE
  }

  // Comptime int can coerce to pointer types (raw address). A slice is two
  // values, a pointer and a length: an address alone isn't one.
  if (s.kind === 'comptime_int' && t.kind === 'pointer') {
    return lossless(false)
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

  // An array that is a value ([N]T, held in registers) has no address, so it
  // is no pointer and no slice: only an array held as its pointer (a [!]T)
  // coerces to one.
  // Fixed array coerces to pointer-to-array: [N]T → *[N]T
  if (s.kind === 'array' && !isValueArray(s) && t.kind === 'pointer' && t.pointee.kind === 'array') {
    if (!s.sizes?.includes('_')) {
      const elemResult = typeAssignResult(t.pointee.element, s.element)
      if (elemResult.compatible && elemResult.lossiness === 'lossless') {
        if (sizesCompatible(t.pointee.sizes, s.sizes)) return lossless(false)
      }
    }
  }

  // No array without its pointer coerces to a slice: a [N]T is a value, and
  // one held as its pointer ([!]T, [?]T, a packed [NxM]T) has no length to
  // give it here: (s.ptr, s.len) is the slice (9.5). A pointer to it does.

  // Fixed array coerces to many-pointer: [N]T → [*]T
  if (s.kind === 'array' && !isValueArray(s) && t.kind === 'pointer' && t.pointee.kind === 'array' && t.pointee.sizes === null) {
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
    // Optional slice cannot implicitly narrow to non-optional
    if (s.optional && !t.optional) return INCOMPATIBLE
    if (!mutCompatible(t.mutable, s.mutable)) return INCOMPATIBLE
    // A slice is a view of memory: its elements are read as they lie, so they
    // have to be laid out as the target's are. A []u8 isn't a []u16, though a
    // u8 is a u16.
    const elemResult = typeAssignResult(t.element, s.element)
    if (!elemResult.compatible || elemResult.lossiness !== 'lossless' || !elemResult.reinterpret) return INCOMPATIBLE
    return lossless(true)
  }

  // Optional pointer cannot implicitly narrow to non-optional
  if (t.kind === 'pointer' && s.kind === 'pointer' && s.optional && !t.optional) {
    return INCOMPATIBLE
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

  // What a pointer points to, under its name as well: *A for A = [3]u16
  const sPointee = s.kind === 'pointer' ? unwrap(s.pointee) : null

  // Pointer-to-array can coerce to slice: *[N]T -> []T (respects mutability).
  // The slice's length is N: a many-pointer [*]T has none to give, and a
  // *[!]T would have to be scanned for it.
  if (t.kind === 'slice' && s.kind === 'pointer' && sPointee?.kind === 'array' && isFixedSizes(sPointee.sizes)) {
    if (!mutCompatible(t.mutable, s.mutable)) return INCOMPATIBLE
    const elemResult = typeAssignResult(t.element, sPointee.element)
    if (elemResult.compatible && elemResult.lossiness === 'lossless' && elemResult.reinterpret) {
      return lossless(true)
    }
  }

  // Pointer-to-array can coerce to framed array: *[N]T -> [!]T, [?]T
  if (t.kind === 'array' && t.sizes?.some(s => s === '!' || s === '?') &&
      sPointee?.kind === 'array') {
    const elemResult = typeAssignResult(t.element, sPointee.element)
    if (elemResult.compatible && elemResult.lossiness === 'lossless' && elemResult.reinterpret) {
      return lossless(true)
    }
  }

  // Pointer-to-array can coerce to many-pointer: *[N]T -> [*]T (respects mutability)
  if (t.kind === 'pointer' && t.pointee.kind === 'array' && t.pointee.sizes === null &&
      s.kind === 'pointer' && sPointee?.kind === 'array' && sPointee.sizes !== null) {
    if (!mutCompatible(t.mutable, s.mutable)) return INCOMPATIBLE
    const elemResult = typeAssignResult(t.pointee.element, sPointee.element)
    if (elemResult.compatible && elemResult.lossiness === 'lossless' && elemResult.reinterpret) {
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
  return sizes.map(s => typeof s === 'number' ? String(s) : s).join('x')
}

export function typeToString(t: ResolvedType, opts?: { compact?: boolean }): string {
  const compact = opts?.compact ?? false
  const sep = compact ? ',' : ', '
  const arrow = compact ? '->' : ' -> '

  switch (t.kind) {
    case 'primitive':
      return t.max !== undefined ? `${t.name}#${t.max}` : t.name

    case 'pointer': {
      const opt = t.optional ? '?' : ''
      // Many-pointer: [*]T or [*]mut T
      if (t.pointee.kind === 'array' && t.pointee.sizes === null) {
        const mut = t.mutable ? 'mut ' : ''
        return `${opt}[*]${mut}${typeToString(t.pointee.element, opts)}`
      }
      const prefix = t.boundary ? '^' : '*'
      const mut = t.mutable ? 'mut ' : ''
      return `${opt}${prefix}${mut}${typeToString(t.pointee, opts)}`
    }

    case 'slice': {
      const opt = t.optional ? '?' : ''
      const mut = t.mutable ? 'mut ' : ''
      return `${opt}[]${mut}${typeToString(t.element, opts)}`
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
  while (t.kind === 'named' || (t.kind === 'forward_ref' && t.target)) {
    t = t.kind === 'named' ? t.type : (t.target as ResolvedType)
  }
  return t
}

// unwrap(), stopping at a forward reference: what a walk over the parts of a
// type uses, where going on into a type that refers to itself would never end.
export function unwrapToCut(t: ResolvedType): ResolvedType {
  while (t.kind === 'named') t = t.type
  return t
}

// What a forward reference's walk goes on to, once it is resolved. The pair
// of types being compared is remembered first, so that a comparison that
// comes round to it again holds: two types that refer to themselves are equal
// when nothing on the way round tells them apart.
type Assumed = readonly (readonly [ResolvedType, ResolvedType])[]
function followRefs(a: ResolvedType, b: ResolvedType, assumed: Assumed | undefined): { a: ResolvedType; b: ResolvedType; assumed: Assumed } | 'assumed' | null {
  const through = (t: ResolvedType) => (t.kind === 'forward_ref' && t.target ? t.target : t)
  const [na, nb] = [through(a), through(b)]
  if (na === a && nb === b) return null
  if (assumed?.some(([x, y]) => x === a && y === b)) return 'assumed'
  return { a: na, b: nb, assumed: [...(assumed ?? []), [a, b]] }
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

// Bits of integer a float holds exactly: every integer up to 2^bits in magnitude.
const MANTISSA_BITS: Partial<Record<PrimitiveName, bigint>> = { f32: 24n, f64: 53n }

// Check if converting from one primitive to another is a safe widening conversion
// Widening: smaller type to larger type where all values are preserved
export function isWideningConversion(from: PrimitiveName, to: PrimitiveName): boolean {
  if (from === to) return false
  if (from === 'f32' && to === 'f64') return true
  const fromBounds = INT_BOUNDS[from]
  if (!fromBounds) return false
  // Integer to float: the mantissa must hold every value of the integer type.
  const mantissa = MANTISSA_BITS[to]
  if (mantissa !== undefined) {
    const limit = 1n << mantissa
    return fromBounds[0] >= -limit && fromBounds[1] <= limit
  }
  const toBounds = INT_BOUNDS[to]
  if (!toBounds) return false
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

// Get byte offset of a field within a compound type stored in memory. A field
// is found by name, or by position for a number (t.0, t.1).
export function fieldByteOffset(t: ResolvedType, field: string | number): number | null {
  const u = unwrap(t)
  if (u.kind === 'slice') {
    if (field === 'ptr') return 0
    if (field === 'len') return 4
    return null
  }
  if (u.kind === 'tuple') {
    let offset = 0
    for (const [i, f] of u.fields.entries()) {
      if (typeof field === 'number' ? i === field : f.name === field) return offset
      const size = byteSize(f.type)
      if (size === null) return null
      offset += size
    }
    return null
  }
  return null
}

// One wasm value of a type as it lies in linear memory: where it starts, and
// the scalar it is read and written as.
export interface MemoryPart {
  offset: number
  type: PrimitiveRT | PointerRT
}

// A value type in memory, as the scalars it flattens to, in the order of its
// wasm values (typeToWasm). Fields are packed with no padding, so the offsets
// agree with byteSize and fieldByteOffset. Null for a type with no fixed size.
export function memoryParts(t: ResolvedType): MemoryPart[] | null {
  const u = unwrap(t)
  switch (u.kind) {
    case 'primitive': {
      const size = primitiveByteSize(u)
      if (size === null) return null
      // Wide integers are 64-bit limbs, least significant first.
      if (size > 8) return Array.from({ length: size / 8 }, (_, i) => ({ offset: i * 8, type: primitive('u64') }))
      return [{ offset: 0, type: u }]
    }
    case 'pointer':
      return [{ offset: 0, type: u }]
    case 'slice':
      return [
        { offset: 0, type: manyPointer(u.element, u.mutable) },
        { offset: 4, type: primitive('u32') },
      ]
    case 'tuple': {
      const parts: MemoryPart[] = []
      let offset = 0
      for (const f of u.fields) {
        const fieldParts = memoryParts(f.type)
        const size = byteSize(f.type)
        if (fieldParts === null || size === null) return null
        for (const p of fieldParts) parts.push({ offset: offset + p.offset, type: p.type })
        offset += size
      }
      return parts
    }
    case 'array': {
      if (!isValueArray(u)) return null
      const elemParts = memoryParts(u.element)
      const stride = byteSize(u.element)
      if (elemParts === null || stride === null) return null
      return Array.from({ length: u.sizes?.[0] as number }, (_, i) =>
        elemParts.map((p) => ({ offset: i * stride + p.offset, type: p.type })),
      ).flat()
    }
    case 'void':
      return []
    default:
      return null
  }
}

// Check if comptime int value fits in a given integer type, or is exact in a
// given float type
export function comptimeIntFits(value: bigint, target: PrimitiveRT): boolean {
  const mantissa = MANTISSA_BITS[target.name]
  if (mantissa !== undefined) return value >= -(1n << mantissa) && value <= 1n << mantissa
  const bounds = INT_BOUNDS[target.name]
  if (!bounds) return false
  if (value < bounds[0] || value > bounds[1]) return false
  if (target.max !== undefined && value >= BigInt(target.max)) return false
  return true
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

// The length of the array a pointer points to, where that is known: what a
// pointer to an array adds to become a slice
export function arrayLength(type: ResolvedType): number | null {
  const t = unwrap(type)
  const array = t.kind === 'pointer' ? unwrap(t.pointee) : null
  return array?.kind === 'array' && isFixedSizes(array.sizes) ? totalElements(array.sizes) : null
}

// === Size of a type written out ===

// The most parts a type can have, written out in full: every name replaced by
// what it names, each field, element, pointer and number counted where it
// stands. Names let a type double at every level (type D2 = (a: D1, b: D1)),
// and what is done with a type written out (an instance key, the registers of
// a value) would then not fit in memory.
export const MAX_TYPE_PARTS = 1 << 16

// How many parts a type has, written out in full, counted once for each place
// it stands. A type that refers to itself is cut where it comes round, as
// canonicalKey cuts it. `counted` holds what is known already, so a type that
// names the same type many times is counted in a time of its own size.
export function typeParts(root: ResolvedType, counted: Map<ResolvedType, number> = new Map(), open: Set<ResolvedType> = new Set()): number {
  // A walk with a stack of its own: a type can be deeper than the call stack,
  // through names that each add a level (type T0 = (n: ?*T1), ...).
  type Frame = { t: ResolvedType; parts: readonly ResolvedType[]; next: number; n: number }
  const stack: Frame[] = []
  // The count of a type known already, or one cut where it comes round, or
  // null where it is to be counted from its parts (pushed)
  const enter = (t: ResolvedType): number | null => {
    const known = counted.get(t)
    if (known !== undefined) return known
    if (open.has(t)) return 1
    open.add(t)
    const [parts, own] = partsOf(t)
    stack.push({ t, parts, next: 0, n: own })
    return null
  }
  const first = enter(root)
  if (first !== null) return first
  for (;;) {
    const frame = stack[stack.length - 1]
    if (frame.next < frame.parts.length) {
      const n = enter(frame.parts[frame.next++])
      if (n !== null) frame.n += n
      continue
    }
    stack.pop()
    open.delete(frame.t)
    counted.set(frame.t, frame.n)
    if (stack.length === 0) return frame.n
    stack[stack.length - 1].n += frame.n
  }
}

// The types a type is made of where it stands, and what it counts for itself:
// a name or a resolved reference is the type it names, and counts nothing.
function partsOf(t: ResolvedType): [readonly ResolvedType[], number] {
  switch (t.kind) {
    case 'named':
      return [[t.type], 0]
    case 'forward_ref':
      return t.target ? [[t.target], 0] : [[], 1]
    case 'pointer':
      return [[t.pointee], 1]
    case 'slice':
    case 'array':
    case 'comptime_array':
      return [[t.element], 1]
    case 'tuple':
      return [t.fields.map((f) => f.type), 1]
    case 'func':
      return [[...t.params, ...t.returns].map((f) => f.type), 1]
    case 'comptime_list':
      return [t.elements, 1]
    default:
      return [[], 1]
  }
}

// === Instance keys ===

// A string that is the same for two types exactly when they are the same type:
// aliases are unwrapped at every depth, so Pt and the struct it names give one
// key. It tells the instances of a generic apart and, through watSafe, names
// them. Only a concrete type has a key.
//
// `open` holds the aliases being written out and how deep in the type each was
// met. A type that refers to itself is cut where it comes round again, and the
// cut is written as that depth, not as the alias's name: a type that recurses
// through an alias of itself (Node holds a ?*Link, and Link = Node) is the same
// type whichever of its names it was reached by.
export function canonicalKey(t: ResolvedType, open: readonly { name: string; depth: number }[] = [], depth = 0): string {
  const inner = (type: ResolvedType) => canonicalKey(type, open, depth + 1)
  const fields = (fs: ResolvedField[], names: boolean) =>
    fs.map((f) => (names && f.name ? `${f.name}:${inner(f.type)}` : inner(f.type))).join(',')
  switch (t.kind) {
    case 'named':
    case 'forward_ref': {
      const back = open.find((o) => o.name === t.name)
      if (back) return `@${back.depth}`
      // A resolved forward reference is the type it names: its target is
      // that type under its name.
      if (t.kind === 'forward_ref') return t.target ? canonicalKey(t.target, open, depth) : `@${t.name}`
      return canonicalKey(t.type, [...open, { name: t.name, depth }], depth)
    }
    case 'primitive':
      return t.max !== undefined ? `${t.name}#${t.max}` : t.name
    case 'pointer': {
      const opt = t.optional ? '?' : ''
      const mut = t.mutable ? 'mut ' : ''
      if (t.pointee.kind === 'array' && t.pointee.sizes === null) {
        return `${opt}[*]${mut}${inner(t.pointee.element)}`
      }
      return `${opt}${t.boundary ? '^' : '*'}${mut}${inner(t.pointee)}`
    }
    case 'slice':
      return `${t.optional ? '?' : ''}[]${t.mutable ? 'mut ' : ''}${inner(t.element)}`
    case 'array':
      // An array of unknown length is only ever what a many-pointer points to,
      // and is written with it above. By itself it must not read as one.
      return `[${t.sizes === null ? '...' : t.sizes.join('x')}]${inner(t.element)}`
    case 'tuple':
      return `(${fields(t.fields, true)})`
    case 'void':
      return '()'
    case 'func':
      // The names of parameters and results are not part of a function's
      // type: (x: i32) -> i32 and (y: i32) -> i32 take the same functions.
      return `(${fields(t.params, false)})->(${fields(t.returns, false)})`
    default:
      throw new Error(`not a concrete type: ${t.kind}`)
  }
}

// A canonicalKey made legal inside a WAT identifier. Distinct keys stay
// distinct: a replacement is a character canonicalKey does not produce where
// the replaced one stands, and the two brackets, which share one, never nest,
// so the first of each pair is the opening one.
export function watSafe(key: string): string {
  const subst: Record<string, string> = { ' ': '.', '(': '<', ')': '>', ',': '|', '[': "'", ']': "'" }
  return key.replaceAll('->', '=>').replace(/[ (),[\]]/g, (c) => subst[c])
}
