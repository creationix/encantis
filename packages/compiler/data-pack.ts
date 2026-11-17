// Data section builder for Encantis
// Collects string literals, deduplicates, and calculates memory offsets

import type * as AST from './ast'
import { byteSize, isOptional, isValueArray, manyPointer, primitive, unwrap, type ArrayRT, type ArraySize, type ResolvedType, type SliceRT, type TupleRT } from './types'
import {
  bytesToHex,
  concatBytes,
  encodeLEB128,
  serializeInt,
  serializeI32,
  serializeF64,
  serializeFloat,
} from './utils'

// Helper to extract framing specifiers from sizes array
// Framings are non-numeric sizes: '!' (null-term) and '?' (LEB prefix)
function getFramings(sizes: ArraySize[] | null): ArraySize[] {
  if (!sizes) return []
  return sizes.filter(s => s === '!' || s === '?')
}

// Helper to check if a size is a framing specifier
function isFraming(s: ArraySize): s is '!' | '?' {
  return s === '!' || s === '?'
}

// Helper to get numeric sizes from sizes array
function getNumericSizes(sizes: ArraySize[] | null): number[] {
  if (!sizes) return []
  return sizes.filter((s): s is number => typeof s === 'number')
}

// Helper to get repeat count from a RepeatExpr
function getRepeatCount(expr: AST.RepeatExpr): number {
  if (expr.count.kind === 'LiteralExpr' && expr.count.value.kind === 'int') {
    return Number(expr.count.value.value)
  }
  throw new Error('RepeatExpr count must be a literal integer')
}

/**
 * Check if array type uses merged brackets (single pass serialization)
 * vs separate brackets (depth-first with pointer arrays).
 * Merged: framings apply to contiguous data (e.g., [!x!]u8)
 * Separate: nested array types requiring pointer indirection (e.g., [!][!]u8)
 */
function isMergedBrackets(type: ArrayRT): boolean {
  const framings = getFramings(type.sizes)
  return framings.length > 1 ||
    (framings.length === 1 && type.element.kind !== 'array')
}

// An interned string entry in the data section
export interface DataEntry {
  bytes: Uint8Array // The actual bytes (includes null terminator for strings)
  offset: number // Offset in the data section
  length: number // Length in bytes (includes null terminator for strings)
  explicit: boolean // True for user-specified memory data, false for auto-interned literals
  labels: string[] // Names/descriptions of declarations using this entry
}

// Result of building the data section
export interface DataSection {
  // All unique data entries (explicit + interned literals), sorted by offset
  entries: DataEntry[]

  // Total size of the data section in bytes
  totalSize: number

  // Offset where automatic (interned) data starts
  // (after any explicit data blocks)
  autoDataStart: number

  // Errors (e.g., overlapping explicit entries)
  errors: string[]
}

/**
 * Builder for constructing a WASM data section.
 *
 * Two-pass algorithm:
 * 1. Explicit data (from memory declarations) placed at specified offsets
 * 2. Auto data (interned literals) placed after explicit entries
 *
 * Deduplicates identical byte sequences using hex-encoded keys.
 * Also deduplicates by finding substrings within already-written data.
 */
// Bytes at the start of memory that never hold data (address 0 is "none").
const NULL_PAGE = 8

export class DataSectionBuilder {
  /** What the checker read a call as, where that is no call: a type that is
   *  called, Vec(u32)(p, 0, cap), is the struct of its arguments. */
  built?: ReadonlyMap<AST.CallExpr, AST.Expr>
  private internedMap = new Map<string, DataEntry>()
  /** Mutable entries that skip deduplication */
  private mutEntries: DataEntry[] = []
  /** Next available offset for placing new interned data */
  private currentOffset = 0

  // Set where auto data starts (for layoutLiterals with explicit addresses)
  setAutoDataStart(offset: number): void {
    this.currentOffset = offset
  }

  addLabel(offset: number, label: string): void {
    for (const entry of this.internedMap.values()) {
      if (offset >= entry.offset && offset < entry.offset + entry.length) {
        if (!entry.labels.includes(label)) entry.labels.push(label)
        return
      }
    }
    for (const entry of this.mutEntries) {
      if (offset >= entry.offset && offset < entry.offset + entry.length) {
        if (!entry.labels.includes(label)) entry.labels.push(label)
        return
      }
    }
  }

  result(): DataSection {
    const interned = Array.from(this.internedMap.values())
    // Include both interned (deduplicated) and mutable entries
    const entries = [...interned, ...this.mutEntries].sort((a, b) => a.offset - b.offset)

    return {
      entries,
      // With no data at all, there's no data section (and no reserved bytes).
      totalSize: entries.length > 0 ? this.currentOffset : 0,
      autoDataStart: 0,
      errors: [],
    }
  }

  // Intern arbitrary bytes, returning a DataRef
  // Used by type-aware serialization
  // If skipDedup is true, always allocate new space (for mutable data)
  internBytes(bytes: Uint8Array, skipDedup = false, isOptional = false): DataRef {
    void isOptional // data never starts at 0 (see NULL_PAGE)

    const key = bytesToKey(bytes)

    if (!skipDedup) {
      // 1. Check exact-match cache first (fast path)
      const entry = this.internedMap.get(key)
      if (entry) {
        return { ptr: entry.offset, len: entry.length }
      }

      // 2. Scan existing data for substring match
      const existingOffset = this.findSubstring(bytes)
      if (existingOffset !== -1) {
        // Found! Return ref without adding to entries (we're reusing, not writing)
        return { ptr: existingOffset, len: bytes.length }
      }
    }

    // 3. Not found (or skipDedup) - write new bytes
    const entry: DataEntry = {
      bytes,
      offset: this.currentOffset,
      length: bytes.length,
      explicit: false,
      labels: [],
    }
    if (skipDedup) {
      // Mutable data: track separately, don't share with future lookups
      this.mutEntries.push(entry)
    } else {
      // Immutable data: cache for deduplication
      this.internedMap.set(key, entry)
    }
    this.currentOffset += bytes.length

    return { ptr: entry.offset, len: entry.length }
  }

  // Search the immutable data written so far for needle, returning its offset
  // or -1. Matches must lie entirely inside immutable entries: mutable data
  // can change at runtime, and the gaps it leaves would otherwise read as zeros
  // and match any run of zero bytes.
  private findSubstring(needle: Uint8Array): number {
    if (this.currentOffset < needle.length) return -1
    const haystack = new Uint8Array(this.currentOffset)
    const immutable = new Uint8Array(this.currentOffset)
    for (const entry of this.internedMap.values()) {
      haystack.set(entry.bytes, entry.offset)
      immutable.fill(1, entry.offset, entry.offset + entry.bytes.length)
    }
    for (let i = 0; i <= haystack.length - needle.length; i++) {
      if (needle.every((byte, j) => immutable[i + j] === 1 && haystack[i + j] === byte)) {
        return i
      }
    }
    return -1
  }
}

// Convert bytes to a string key for Map (for deduplication)
// Use bytesToHex as deduplication key
const bytesToKey = bytesToHex

/**
 * Serialize a DataSection to a single byte array for embedding in WASM.
 * @param section The data section to serialize
 * @returns Byte array with all entries at their correct offsets
 */
export function serializeDataSection(section: DataSection): Uint8Array {
  const result = new Uint8Array(section.totalSize)

  for (const entry of section.entries) {
    // Copy bytes (null terminators already included for strings)
    result.set(entry.bytes, entry.offset)
  }

  return result
}

/**
 * Format a DataSection as WAT data segment declarations.
 * Each entry becomes: (data (i32.const OFFSET) "ESCAPED_BYTES")
 * Non-printable bytes are escaped as \xx hex.
 * @param section The data section to format
 * @returns Array of WAT data segment strings
 */
function describeBytes(bytes: Uint8Array): string {
  const isPrintable = bytes.every(b => (b >= 0x20 && b <= 0x7e) || b === 0x0a || b === 0x0d || b === 0x09 || b === 0x00)
  if (isPrintable && bytes.length > 0) {
    let s = new TextDecoder().decode(bytes).replace(/\0/g, '\\0').replace(/\n/g, '\\n')
    if (s.length > 40) s = s.slice(0, 37) + '...'
    return `"${s}"`
  }
  if (bytes.length % 4 === 0 && bytes.length <= 32) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const vals: number[] = []
    for (let i = 0; i < bytes.length; i += 4) vals.push(view.getInt32(i, true))
    return `[${vals.join(', ')}]`
  }
  return `${bytes.length} bytes`
}

export function dataToWat(section: DataSection): string[] {
  const segments: string[] = []

  for (const entry of section.entries) {
    const label = entry.labels.length > 0 ? entry.labels.join(', ') : null
    const auto = !label ? describeBytes(entry.bytes) : null
    if (entry.bytes.every(b => b === 0)) {
      const desc = label ?? `${entry.bytes.length} zero bytes`
      segments.push(`  ;; ${entry.bytes.length} zero bytes at 0x${entry.offset.toString(16)} — ${desc}`)
      continue
    }
    const escaped = escapeWatString(entry.bytes)
    const comment = label ?? (auto && !auto.startsWith('"') ? auto : null)
    segments.push(`(data (i32.const ${entry.offset}) "${escaped}")${comment ? '  ;; ' + comment : ''}`)
  }

  return segments
}

// Escape bytes for WAT string literal
function escapeWatString(bytes: Uint8Array): string {
  let result = ''
  for (const byte of bytes) {
    if (byte >= 32 && byte < 127 && byte !== 0x22 && byte !== 0x5c) {
      // Printable ASCII except " and \
      result += String.fromCharCode(byte)
    } else {
      // Escape as hex
      result += `\\${byte.toString(16).padStart(2, '0')}`
    }
  }
  return result
}

// === Type-aware literal serialization ===

// Reference to data in the data section
export interface DataRef {
  ptr: number // Offset in data section
  len: number // Byte length or element count (for slices)
}

// === Part extraction for global sorting ===

// A serializable part extracted from literal tree
interface SerializablePart {
  id: number                        // Unique ID for this part
  expr: AST.Expr                    // The expression to serialize
  type: ArrayRT                   // Target type
  depth: number                     // Nesting depth (0=top-level, higher=inner)
  parentId: number | null           // Parent part's ID (for separate bracket children)
  childIndices: number[]            // Indices of this part's children (filled during collection)
  isPointerArray: boolean           // True if this is a pointer array (parent of separate bracket)
  literalId: number | string | undefined  // Original literal ID for refs
}

let partIdCounter = 0

// Extract all parts from a literal, returning them in a flat list
// Parts are returned in order they were discovered (depth-first)
function collectParts(
  expr: AST.Expr,
  type: ArrayRT,
  depth: number,
  parentId: number | null,
  literalId: number | string | undefined,
  parts: SerializablePart[],
): number {
  const thisId = partIdCounter++

  if (isMergedBrackets(type) || (type.element.kind !== 'array' && type.element.kind !== 'slice')) {
    // Merged or leaf: serialize as a single unit
    parts.push({
      id: thisId,
      expr,
      type,
      depth,
      parentId,
      childIndices: [],
      isPointerArray: false,
      literalId: depth === 0 ? literalId : undefined,
    })
    return thisId
  }

  // Separate brackets or slice elements: extract children first, then this part as pointer array
  if (expr.kind !== 'ArrayExpr') {
    throw new Error(`Expected ArrayExpr for separate brackets, got ${expr.kind}`)
  }

  // For slice elements []T, the inner type is an array to be allocated separately
  const innerType: ArrayRT = type.element.kind === 'slice'
    ? { kind: 'array', element: type.element.element, sizes: ['_'] }
    : type.element as ArrayRT
  const childIds: number[] = []

  // Recursively collect children at depth+1
  for (const elem of expr.elements) {
    const childId = collectParts(elem, innerType, depth + 1, thisId, undefined, parts)
    childIds.push(childId)
  }

  // Add this part as a pointer array (depends on children)
  parts.push({
    id: thisId,
    expr,
    type,
    depth,
    parentId,
    childIndices: childIds,
    isPointerArray: true,
    literalId: depth === 0 ? literalId : undefined,
  })

  return thisId
}

// Sort score for parts - higher = process first
// Priority:
//   1. Non-pointer-arrays first (sorted by specifier count, more = higher)
//   2. Pointer arrays last (sorted by depth desc, then specifier count)
function partSortScore(part: SerializablePart): number {
  const specCount = part.type.sizes?.filter(s => s === '!' || s === '?').length ?? 0

  if (part.isPointerArray) {
    // Pointer arrays come after ALL non-pointer-arrays
    // Among pointer arrays: deeper ones first (for nested separate brackets),
    // then by specifier count
    const hasFixedSize = part.type.sizes?.some(s => typeof s === 'number') ?? false
    const specScore = specCount > 0 ? 10 + specCount : (hasFixedSize ? 1 : 0)
    return -10000 + part.depth * 100 + specScore
  }

  // Non-pointer-arrays: sort by specifier count (more = higher priority)
  if (specCount > 0) {
    return 1000 + specCount
  } else if (part.type.sizes?.some(s => typeof s === 'number')) {
    return 100
  }
  return 0 // Slices
}

// Serialize parts in sorted order
function serializeSortedParts(
  parts: SerializablePart[],
  builder: DataSectionBuilder,
): Map<number, DataRef> {
  const refMap = new Map<number, DataRef>()

  // Sort by score descending
  const sorted = [...parts].sort((a, b) => partSortScore(b) - partSortScore(a))

  for (const part of sorted) {
    const skipDedup = isMutExpr(part.expr)
    if (part.isPointerArray) {
      // Pointer array: look up child refs and encode
      const childRefs: DataRef[] = []
      for (const childId of part.childIndices) {
        const childRef = refMap.get(childId)
        if (!childRef) {
          throw new Error(`Child ${childId} not serialized before parent ${part.id}`)
        }
        childRefs.push(childRef)
      }

      // Check if INNER type (children) are slices - determines if we store (ptr,len) pairs
      const innerType = part.type.element
      const childrenAreSlices = innerType.kind === 'slice' ||
        (innerType.kind === 'array' && (innerType.sizes === null || innerType.sizes.length === 0))
      const pointerBytes = encodePointerArray(childRefs, getFramings(part.type.sizes), childrenAreSlices)
      const ref = builder.internBytes(pointerBytes, skipDedup)
      refMap.set(part.id, ref)
    } else {
      // Merged or leaf: serialize directly
      const ref = serializeMerged(part.expr, part.type, builder, skipDedup)
      refMap.set(part.id, ref)
    }
  }

  return refMap
}

// (x) is x: parentheses around one expression parse as a group or a
// one-element tuple, and what is laid out is the expression inside.
function ungroup(expr: AST.Expr): AST.Expr {
  if (expr.kind === 'GroupExpr') return ungroup(expr.expr)
  if (expr.kind === 'TupleExpr' && expr.elements.length === 1 && !expr.elements[0].name && expr.elements[0].value) {
    return ungroup(expr.elements[0].value)
  }
  return expr
}

/**
 * Serialize a literal expression to bytes based on target type.
 * Handles both merged brackets (*[![!u8]] - single contiguous write) and
 * separate brackets (*[!*[!u8]] - depth-first with pointer arrays).
 * @param expr The literal expression (LiteralExpr or ArrayExpr)
 * @param targetType The indexed type to serialize as
 * @param builder The data section builder for interning
 * @returns DataRef with pointer offset and length for codegen
 */
// Check if an expression has the mut flag (mutable data, skip deduplication)
function isMutExpr(expr: AST.Expr): boolean {
  if ('mut' in expr && (expr as { mut?: boolean }).mut) return true
  if (expr.kind === 'AnnotationExpr') return isMutExpr(expr.expr)
  return false
}

export function serializeLiteral(
  expr: AST.Expr,
  targetType: ArrayRT,
  builder: DataSectionBuilder,
  childRefs?: Map<number, DataRef>,
  mutable = false,
): DataRef {
  const skipDedup = mutable || isMutExpr(expr)
  if (isMergedBrackets(targetType) || (targetType.element.kind !== 'array' && targetType.element.kind !== 'slice')) {
    return serializeMerged(expr, targetType, builder, skipDedup)
  } else {
    return serializeSeparate(expr, targetType, builder, skipDedup, childRefs)
  }
}

// Serialize merged brackets (e.g., *[![!u8]]) - single contiguous write
function serializeMerged(
  expr: AST.Expr,
  targetType: ArrayRT,
  builder: DataSectionBuilder,
  skipDedup: boolean,
): DataRef {
  const bytes = buildMergedBytes(expr, targetType, builder)
  const optional = isOptional(targetType.element)
  return builder.internBytes(bytes, skipDedup, optional)
}

// Build the complete byte sequence for merged brackets
// Framing order: leftmost is outermost, rightmost is innermost
// e.g., [?,!]u8 means: ! applies to each element, ? applies to whole array
function buildMergedBytes(expr: AST.Expr, targetType: ArrayRT, builder: DataSectionBuilder): Uint8Array {
  const framings = getFramings(targetType.sizes)
  const elementType = targetType.element

  // For single-element types (string literal, int array), serialize directly
  if (expr.kind === 'LiteralExpr') {
    const rawBytes = literalToBytes(expr, elementType)
    return applyFramings(rawBytes, framings, getElementSize(elementType))
  }

  // For array expressions, serialize each element then apply outer framings
  if (expr.kind === 'ArrayExpr') {
    const elementParts: Uint8Array[] = []

    // Leftmost framing is outermost (applies to whole array)
    // Rightmost framings are innermost (apply to each element)
    const outerFraming = framings[0]
    const innerFramings = framings.slice(1)

    for (const elem of expr.elements) {
      const elemBytes = buildElementBytes(elem, elementType, innerFramings, builder)
      elementParts.push(elemBytes)
    }

    // Concatenate all elements
    const combined = concatBytes(elementParts)

    // Apply outer framing (final terminator or prefix)
    if (outerFraming) {
      return applyFraming(combined, outerFraming, getElementSize(elementType), elementParts.length)
    }
    return combined
  }

  // For repeat expressions [value; count], serialize value count times
  if (expr.kind === 'RepeatExpr') {
    // Get count from literal
    if (expr.count.kind !== 'LiteralExpr' || expr.count.value.kind !== 'int') {
      throw new Error(`RepeatExpr count must be an int literal`)
    }
    const count = Number(expr.count.value.value)

    // Leftmost framing is outermost (applies to whole array)
    // Rightmost framings are innermost (apply to each element)
    const outerFraming = framings[0]
    const innerFramings = framings.slice(1)

    // Serialize the value once
    const elemBytes = buildElementBytes(expr.value, elementType, innerFramings, builder)

    // Repeat it count times
    const elementParts: Uint8Array[] = []
    for (let i = 0; i < count; i++) {
      elementParts.push(elemBytes)
    }

    // Concatenate all elements
    const combined = concatBytes(elementParts)

    // Apply outer framing (final terminator or prefix)
    if (outerFraming) {
      return applyFraming(combined, outerFraming, getElementSize(elementType), count)
    }
    return combined
  }

  // A single tuple (data origin = (0.0, 0.0)): its fields, as for an element
  if (expr.kind === 'TupleExpr' && unwrap(elementType).kind === 'tuple') {
    return buildElementBytes(expr, elementType, [], builder)
  }

  // Runtime expression — emit zero placeholder, filled at runtime
  return new Uint8Array(getElementSize(elementType))
}

// The expressions that give a struct's fields, in the order of the type, when
// `expr` writes the struct out: a tuple gives them by position, as any tuple
// that becomes a struct does; a constructor (Point(y: 2, x: 1)) can name them.
// Type names are the identifiers that start with a capital letter.
function structFieldValues(expr: AST.Expr, struct: TupleRT, builder: DataSectionBuilder): (AST.Expr | null)[] | null {
  let args: AST.Arg[]
  // A type that is called: the checker gives its arguments field by field.
  const built = expr.kind === 'CallExpr' ? builder.built?.get(expr) : undefined
  if (built?.kind === 'TupleExpr') expr = built
  if (expr.kind === 'TupleExpr') {
    args = expr.elements
  } else if (expr.kind === 'CallExpr' && expr.callee.kind === 'IdentExpr' && /^[A-Z]/.test(expr.callee.name)) {
    args = expr.args
    if (args.some((a) => a.name)) return struct.fields.map((f) => args.find((a) => a.name === f.name)?.value ?? null)
  } else {
    return null
  }
  return struct.fields.map((_, i) => args[i]?.value ?? null)
}

// The bytes of one field of a struct. A slice or array-pointer field given as
// a literal points at that literal, which is laid out on its own.
function buildFieldBytes(expr: AST.Expr, fieldType: ResolvedType, builder: DataSectionBuilder): Uint8Array {
  const t = unwrap(fieldType)
  let lit = ungroup(expr)
  while (lit.kind === 'AnnotationExpr') lit = ungroup(lit.expr)
  const isString = lit.kind === 'LiteralExpr' && lit.value.kind === 'string'
  if (isString || lit.kind === 'ArrayExpr' || lit.kind === 'RepeatExpr') {
    const count = lit.kind === 'ArrayExpr' ? lit.elements.length
      : lit.kind === 'RepeatExpr' ? getRepeatCount(lit)
      : lit.kind === 'LiteralExpr' && lit.value.kind === 'string' ? lit.value.bytes.length : 0
    if (t.kind === 'slice') {
      const ref = serializeLiteral(lit, { kind: 'array', element: t.element, sizes: [count] }, builder)
      return concatBytes([serializeI32(ref.ptr), serializeI32(count)])
    }
    if (t.kind === 'pointer' && t.pointee.kind === 'array') {
      // A many-pointer has no count of its own: the literal's.
      const target = t.pointee.sizes === null ? { ...t.pointee, sizes: [count] } : t.pointee
      return serializeI32(serializeLiteral(lit, target, builder).ptr)
    }
  }
  return buildElementBytes(expr, fieldType, [], builder)
}

// Build bytes for a single element with inner framings
// Framings are ordered: leftmost is outermost, rightmost is innermost
function buildElementBytes(
  expr: AST.Expr,
  elementType: ResolvedType,
  framings: ArraySize[],
  builder: DataSectionBuilder,
): Uint8Array {
  // Unwrap AnnotationExpr (e.g., 0:u32 in [0:u32;12])
  if (expr.kind === 'AnnotationExpr') {
    return buildElementBytes(expr.expr, elementType, framings, builder)
  }

  if (expr.kind === 'LiteralExpr') {
    // If elementType is a slice, we need to unwrap it to get the actual element type
    // for serialization. This happens when a literal is used where a slice is expected.
    const actualType = elementType.kind === 'slice' ? elementType.element : elementType
    const rawBytes = literalToBytes(expr, actualType)
    if (framings.length === 0) {
      return rawBytes
    }
    // Apply framings - for a single literal, apply all framings
    return applyFramings(rawBytes, framings, getElementSize(actualType))
  }

  if (expr.kind === 'ArrayExpr') {
    const parts: Uint8Array[] = []
    const innerElementType = arrayElementType(elementType)

    if (framings.length > 0) {
      const outerFraming = framings[0]
      const innerFramings = framings.slice(1)
      for (const elem of expr.elements) {
        parts.push(buildElementBytes(elem, innerElementType, innerFramings, builder))
      }
      const combined = concatBytes(parts)
      return applyFraming(combined, outerFraming, getElementSize(innerElementType), parts.length)
    }

    for (const elem of expr.elements) {
      parts.push(buildElementBytes(elem, innerElementType, [], builder))
    }
    return concatBytes(parts)
  }

  if (expr.kind === 'RepeatExpr') {
    // [value; count] - repeat the value bytes count times
    // If elementType is a slice, unwrap it for the inner elements
    const innerElementType = arrayElementType(elementType)
    const valueBytes = buildElementBytes(expr.value, innerElementType, framings.slice(1), builder)
    const count = getRepeatCount(expr)
    const parts: Uint8Array[] = []
    for (let i = 0; i < count; i++) {
      parts.push(valueBytes)
    }
    const combined = concatBytes(parts)
    if (framings.length > 0) {
      return applyFraming(combined, framings[0], getElementSize(innerElementType), count)
    }
    return combined
  }

  // (x) is grouping: the element itself, whatever its type is.
  const struct = unwrap(elementType)
  const inner = ungroup(expr)
  if (inner !== expr) return buildElementBytes(inner, elementType, framings, builder)

  // A slice written as its two parts, (ptr, len).
  if (struct.kind === 'slice' && isSlicePair(expr)) return slicePairBytes(expr, struct, builder)

  // A struct written out, as a tuple or a constructor: its fields one after
  // another, as they lie in memory. A field only known when the program runs
  // stays zero here.
  const values = struct.kind === 'tuple' ? structFieldValues(expr, struct, builder) : null
  if (values && struct.kind === 'tuple') {
    return concatBytes(struct.fields.map((f, i) => {
      const value = values[i]
      return value ? buildFieldBytes(value, f.type, builder) : new Uint8Array(byteSize(f.type) ?? 0)
    }))
  }

  // Runtime expressions (calls, identifiers, etc.) — emit zero placeholder
  // The actual value will be filled in at runtime via i32.store
  const size = byteSize(elementType)
  if (size !== null) return new Uint8Array(size)
  return new Uint8Array(8) // default: ptr + len for slice
}

// (ptr, len) where a slice is expected is that slice, built from its parts.
function isSlicePair(expr: AST.Expr): expr is AST.TupleExpr {
  return expr.kind === 'TupleExpr' && expr.elements.length === 2
}

// The eight bytes of a slice given as (ptr, len): the address, a number or a
// literal that is laid out on its own, and the count of elements. A part only
// known when the program runs stays zero here.
function slicePairBytes(expr: AST.TupleExpr, type: SliceRT, builder: DataSectionBuilder): Uint8Array {
  const [ptr, len] = expr.elements.map((part) => part.value)
  return concatBytes([
    ptr ? buildFieldBytes(ptr, manyPointer(type.element, type.mutable), builder) : new Uint8Array(4),
    len ? buildElementBytes(len, primitive('u32'), [], builder) : new Uint8Array(4),
  ])
}

// What the elements of an array literal are, for a target that is a slice or a
// fixed array ([N]T, as a field of a struct); anything else is the leaf type
// of merged brackets, which nested literals share.
function arrayElementType(type: ResolvedType): ResolvedType {
  if (type.kind === 'slice') return type.element
  if (type.kind === 'array' && isValueArray(type)) return type.element
  return type
}

// How many elements a literal has, from the reference to it. A reference
// counts bytes, except for a literal that is an array of pointers to its own
// literals (separate brackets), where it already counts elements.
export function literalLength(ref: DataRef, element: ResolvedType): number {
  if (element.kind === 'array' || element.kind === 'slice') return ref.len
  const size = byteSize(element)
  return size ? ref.len / size : ref.len
}

// Serialize separate brackets (e.g., [!][!]u8) - depth-first with pointer arrays
function serializeSeparate(
  expr: AST.Expr,
  targetType: ArrayRT,
  builder: DataSectionBuilder,
  skipDedup: boolean,
  refsMap?: Map<number, DataRef>,
): DataRef {
  // [row; n] is n rows, each laid out like a row written out.
  const elements = expr.kind === 'RepeatExpr' ? Array<AST.Expr>(getRepeatCount(expr)).fill(expr.value)
    : expr.kind === 'ArrayExpr' ? expr.elements
    : null
  if (!elements) {
    throw new Error(`Expected ArrayExpr for separate brackets, got ${expr.kind}`)
  }

  const elem = targetType.element
  const innerType: ArrayRT = elem.kind === 'slice'
    ? { kind: 'array', element: elem.element, sizes: ['_'] }
    : elem as ArrayRT
  // A many-pointer to fixed arrays ([*][M]T) is a table like *[N][M]T: its
  // elements are row pointers, not (ptr, len) pairs.
  const rows = elem.kind === 'array' && isValueArray(elem)
  const childRefs: DataRef[] = []
  // The elements given as (ptr, len): what they hold is what was written.
  const pairs = new Set<DataRef>()

  for (const element of elements) {
    const child = ungroup(element)
    if (isSerializableExpr(child)) {
      // The rows of a mutable table are written through it: each is its own,
      // shared with no other data.
      const ref = serializeLiteral(child, innerType, builder, undefined, rows && skipDedup)
      childRefs.push(ref)
      if (refsMap && child.span.start !== 0) {
        refsMap.set(child.span.start, ref)
      }
    } else if (elem.kind === 'slice' && isSlicePair(child)) {
      const words = new DataView(slicePairBytes(child, elem, builder).buffer)
      const ref = { ptr: words.getUint32(0, true), len: words.getUint32(4, true) }
      childRefs.push(ref)
      pairs.add(ref)
    } else {
      childRefs.push({ ptr: 0, len: 0 })
    }
  }

  const isSlice = elem.kind === 'slice' || (!rows && (targetType.sizes === null || targetType.sizes.length === 0))
  // A (ptr, len) element holds its child's length in elements, not bytes.
  const elementRefs = isSlice
    ? childRefs.map((ref) => pairs.has(ref) ? ref : { ptr: ref.ptr, len: literalLength(ref, innerType.element) })
    : childRefs
  const pointerBytes = encodePointerArray(elementRefs, getFramings(targetType.sizes), isSlice)

  const optional = isOptional(targetType.element)
  const ref = builder.internBytes(pointerBytes, skipDedup, optional)
  return { ptr: ref.ptr, len: childRefs.length }
}

function isSerializableExpr(expr: AST.Expr): boolean {
  if (expr.kind === 'LiteralExpr' || expr.kind === 'ArrayExpr' || expr.kind === 'RepeatExpr') return true
  if (expr.kind === 'AnnotationExpr') return isSerializableExpr(expr.expr)
  return false
}

// Encode an array of DataRefs as a pointer array
function encodePointerArray(
  refs: DataRef[],
  framings: ArraySize[],
  isSlice: boolean,
): Uint8Array {
  const parts: Uint8Array[] = []

  if (isSlice) {
    // Slice of slices: each element is (ptr, len) pair
    for (const ref of refs) {
      parts.push(serializeI32(ref.ptr))
      parts.push(serializeI32(ref.len))
    }
  } else {
    // Pointer array: just pointers
    for (const ref of refs) {
      parts.push(serializeI32(ref.ptr))
    }
  }

  const combined = concatBytes(parts)

  // Apply framings (e.g., null terminator for !)
  if (framings.length > 0) {
    const framing = framings[framings.length - 1]
    // For pointer arrays, element size is 4 (i32 pointer) or 8 (slice pair)
    const elemSize = isSlice ? 8 : 4
    return applyFraming(combined, framing, elemSize, refs.length)
  }

  return combined
}

// Convert a literal expression to raw bytes based on element type
function literalToBytes(expr: AST.LiteralExpr, elementType: ResolvedType): Uint8Array {
  const lit = expr.value

  if (lit.kind === 'string') {
    return lit.bytes
  }

  if (lit.kind === 'int') {
    if (elementType.kind === 'primitive') {
      // An integer literal can be a float element: [1:f64, 2, 3].
      const bytes = serializeInt(lit.value, elementType.name) ?? serializeFloat(Number(lit.value), elementType.name)
      if (bytes) return bytes
    }
    // Default comptime_int to i32
    if (elementType.kind === 'comptime_int') {
      const bytes = serializeInt(lit.value, 'i32')
      if (bytes) return bytes
    }
    // A pointer given as a number is that address: four bytes in memory.
    if (elementType.kind === 'pointer') {
      const bytes = serializeInt(lit.value, 'u32')
      if (bytes) return bytes
    }
    throw new TypeError(`Cannot serialize int literal to type ${elementType.kind}`)
  }

  if (lit.kind === 'float') {
    if (elementType.kind === 'primitive') {
      const bytes = serializeFloat(lit.value, elementType.name)
      if (bytes) return bytes
    }
    // Default comptime_float to f64
    if (elementType.kind === 'comptime_float') {
      const bytes = serializeFloat(lit.value, 'f64')
      if (bytes) return bytes
    }
    throw new TypeError(`Cannot serialize float literal to type ${elementType.kind}`)
  }

  if (lit.kind === 'bool') {
    return new Uint8Array([lit.value ? 1 : 0])
  }

  throw new TypeError(`Cannot serialize unknown literal`)
}

// Apply all framings to bytes (inside-out order)
function applyFramings(
  bytes: Uint8Array,
  framings: ArraySize[],
  elementSize: number,
): Uint8Array {
  let result = bytes
  for (const framing of framings) {
    result = applyFraming(result, framing, elementSize, 0)
  }
  return result
}

// Apply a single framing to bytes
// Framing is '!' (null-terminated) or '?' (LEB128 prefix)
function applyFraming(
  bytes: Uint8Array,
  framing: ArraySize,
  elementSize: number,
  count: number,
): Uint8Array {
  if (framing === '!') {
    // Null terminator: append zeros of element width
    const terminator = new Uint8Array(elementSize)
    return concatBytes([bytes, terminator])
  }

  if (framing === '?') {
    // Length/count prefix (always LEB128)
    const prefixBytes = encodeLEB128(count || bytes.length)
    return concatBytes([prefixBytes, bytes])
  }

  // Other sizes (numbers, '_') don't modify the bytes
  return bytes
}

// Get the byte size of an element type (for null terminators)
function getElementSize(type: ResolvedType): number {
  if (type.kind === 'primitive') {
    switch (type.name) {
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
    }
  }
  // For pointer types (nested indexed), pointers are 4 bytes (i32)
  if (type.kind === 'array' || type.kind === 'pointer') {
    return 4
  }
  // Default to 1 byte
  return 1
}

// === Standalone Data Layout API ===

// Input for a qualified literal to be laid out
export interface QualifiedLiteral {
  // The literal value (string bytes, number array, nested arrays)
  value: LiteralValue
  // The target indexed type (determines encoding)
  type: ArrayRT
  // Optional explicit address (for memory block entries)
  address?: number
  // Optional identifier for tracking (e.g., AST offset or label)
  id?: number | string
}

// Literal value types
export type LiteralValue =
  | { kind: 'bytes'; data: Uint8Array } // String literal or raw bytes
  | { kind: 'ints'; data: bigint[] } // Integer array
  | { kind: 'floats'; data: number[] } // Float array
  | { kind: 'nested'; elements: LiteralValue[] } // Nested array

// Convert LiteralValue to mock AST.Expr for use with serializeLiteral
function literalValueToExpr(value: LiteralValue): AST.Expr {
  const span = { start: 0, end: 0 }

  switch (value.kind) {
    case 'bytes':
      return {
        kind: 'LiteralExpr',
        value: { kind: 'string', bytes: value.data },
        span,
      }
    case 'ints':
      if (value.data.length === 1) {
        return {
          kind: 'LiteralExpr',
          value: { kind: 'int', value: value.data[0], radix: 10 },
          span,
        }
      }
      return {
        kind: 'ArrayExpr',
        elements: value.data.map((v) => ({
          kind: 'LiteralExpr' as const,
          value: { kind: 'int' as const, value: v, radix: 10 as const },
          span,
        })),
        span,
      }
    case 'floats':
      if (value.data.length === 1) {
        return {
          kind: 'LiteralExpr',
          value: { kind: 'float', value: value.data[0] },
          span,
        }
      }
      return {
        kind: 'ArrayExpr',
        elements: value.data.map((v) => ({
          kind: 'LiteralExpr' as const,
          value: { kind: 'float' as const, value: v },
          span,
        })),
        span,
      }
    case 'nested':
      return {
        kind: 'ArrayExpr',
        elements: value.elements.map((elem) => literalValueToExpr(elem)),
        span,
      }
  }
}

// Result of laying out literals
export interface DataLayout {
  // Map from input id → DataRef
  refs: Map<number | string, DataRef>
  // All data entries sorted by offset
  entries: DataEntry[]
  // Total size of data section
  totalSize: number
  // Errors encountered
  errors: string[]
}

/**
 * Lay out a list of qualified literals into a data section.
 * Handles both explicit (user-specified address) and auto (interned) literals.
 *
 * Algorithm:
 * 1. Explicit literals placed at their specified addresses
 * 2. Check for overlapping explicit entries (reports errors)
 * 3. Auto literals interned after explicit entries end
 *
 * @param literals Array of qualified literals with types and optional addresses
 * @returns DataLayout with refs, entries, total size, and any errors
 */
export function layoutLiterals(literals: QualifiedLiteral[]): DataLayout {
  const builder = new DataSectionBuilder()
  const refs = new Map<number | string, DataRef>()
  const explicitEntries: { offset: number; bytes: Uint8Array }[] = []
  const errors: string[] = []

  // Separate explicit (addressed) and auto literals
  const explicit = literals.filter((lit) => lit.address !== undefined)
  const auto = literals.filter((lit) => lit.address === undefined)

  // Handle explicit entries first - serialize and place at specified address
  for (const lit of explicit) {
    const address = lit.address as number // filtered above
    const expr = literalValueToExpr(lit.value)
    // Use a temporary builder to get the bytes
    const tempBuilder = new DataSectionBuilder()
    serializeLiteral(expr, lit.type, tempBuilder)
    const tempSection = tempBuilder.result()
    const bytes = tempSection.entries[0]?.bytes ?? new Uint8Array(0)

    explicitEntries.push({ offset: address, bytes })
    if (lit.id !== undefined) {
      refs.set(lit.id, { ptr: address, len: bytes.length })
    }
  }

  // Check for overlapping explicit entries
  const sortedExplicit = [...explicitEntries].sort((a, b) => a.offset - b.offset)
  for (let i = 0; i < sortedExplicit.length - 1; i++) {
    const current = sortedExplicit[i]
    const next = sortedExplicit[i + 1]
    const currentEnd = current.offset + current.bytes.length
    if (currentEnd > next.offset) {
      errors.push(
        `data at offset ${next.offset} overlaps entry at ${current.offset} (ends at ${currentEnd})`,
      )
    }
  }

  // Set auto data to start after explicit entries
  let maxExplicitEnd = 0
  for (const e of explicitEntries) {
    const end = e.offset + e.bytes.length
    if (end > maxExplicitEnd) maxExplicitEnd = end
  }
  builder.setAutoDataStart(maxExplicitEnd)

  // Reset part ID counter for this layout
  partIdCounter = 0

  // Collect all parts from all auto literals (including nested children)
  const allParts: SerializablePart[] = []
  const topLevelPartIds = new Map<number | string, number>() // literalId -> partId

  for (const lit of auto) {
    const expr = literalValueToExpr(lit.value)
    const partId = collectParts(expr, lit.type, 0, null, lit.id, allParts)
    if (lit.id !== undefined) {
      topLevelPartIds.set(lit.id, partId)
    }
  }

  // Sort and serialize all parts globally
  const partRefs = serializeSortedParts(allParts, builder)

  // Map top-level part refs back to literal IDs
  for (const [litId, partId] of topLevelPartIds) {
    const ref = partRefs.get(partId)
    if (ref) {
      refs.set(litId, ref)
    }
  }

  // Combine explicit and auto entries
  const section = builder.result()
  const explicitDataEntries: DataEntry[] = explicitEntries.map((e) => ({
    bytes: e.bytes,
    offset: e.offset,
    length: e.bytes.length,
    explicit: true,
    labels: [],
  }))
  const allEntries = [...explicitDataEntries, ...section.entries].sort(
    (a, b) => a.offset - b.offset,
  )

  // Calculate total size (max of explicit end and auto end)
  const totalSize = Math.max(maxExplicitEnd, section.totalSize)

  return {
    refs,
    entries: allEntries,
    totalSize,
    errors: [...errors, ...section.errors],
  }
}

// === Data Section Building from Checker Literals ===

import type { PendingLiteral } from './checker'
import { typeKey } from './checker'

// Result of building the data section
export interface DataSectionResult {
  dataBuilder: DataSectionBuilder
  literalRefs: Map<number, DataRef>  // AST offset → DataRef
}

/**
 * Build the data section from pending literals collected during type checking.
 * Serialization types are looked up from the types map at typeKey(id, 'DataTarget').
 */
export function buildDataSection(
  literals: PendingLiteral[],
  types: Map<string, ResolvedType>,
  options: { tolerant?: boolean; calls?: ReadonlyMap<AST.CallExpr, AST.Expr> } = {},
): DataSectionResult {
  const dataBuilder = new DataSectionBuilder()
  dataBuilder.built = options.calls
  // Address 0 means "none" for optional pointers and slices, so program data
  // never starts there: the first 8 bytes stay unused, keeping 8-byte alignment.
  dataBuilder.setAutoDataStart(NULL_PAGE)
  const literalRefs = new Map<number, DataRef>()

  // Resolve serialization types from the types map
  const withTypes = literals.map(lit => ({
    ...lit,
    type: types.get(typeKey(lit.id, 'DataTarget')) as ArrayRT,
  })).filter(lit => lit.type)

  // Sort by priority for better deduplication
  // Priority: more specifiers > fixed-size > slices
  const sorted = [...withTypes].sort((a, b) =>
    literalSortScore(b.type) - literalSortScore(a.type)
  )

  // Serialize each literal
  for (const lit of sorted) {
    try {
      literalRefs.set(lit.id, serializeLiteral(lit.expr, lit.type, dataBuilder, literalRefs))
    } catch (e) {
      // Laying a literal out takes for granted that it passed the checker. In
      // a module that didn't (the editor asks for metadata as it is typed), a
      // literal with an element of the wrong type has no layout: it is left
      // without an address, and the others keep theirs.
      if (!options.tolerant) throw e
    }
  }

  return { dataBuilder, literalRefs }
}

// Sorting score for literals - higher = process first
// Priority: specifiers (terminators/prefixes) > fixed-size > slices
function literalSortScore(type: ArrayRT): number {
  const maxSpecs = maxSpecifiersInBracket(type)
  if (maxSpecs > 0) {
    return 1000 + maxSpecs // Has specifiers - highest priority
  }
  if (hasFixedSize(type)) {
    return 100 // Fixed-size arrays
  }
  return 0 // Slices (fat-pointers)
}

// Max specifiers in any single bracket level
// Merged brackets like *[![!u8]] have 2, separate *[!*[!u8]] has max 1
function maxSpecifiersInBracket(type: ArrayRT): number {
  const thisLevel = type.sizes?.filter(s => s === '!' || s === '?').length ?? 0
  if (type.element.kind === 'array') {
    return Math.max(thisLevel, maxSpecifiersInBracket(type.element))
  }
  return thisLevel
}

// Check if any level has a fixed size
function hasFixedSize(type: ArrayRT): boolean {
  if (type.sizes?.some(s => typeof s === 'number')) return true
  if (type.element.kind === 'array') {
    return hasFixedSize(type.element)
  }
  return false
}
