// Data section builder for Encantis
// Collects string literals, deduplicates, and calculates memory offsets

import type * as AST from './ast'
import type { IndexedRT, IndexSpecifierRT, ResolvedType } from './types'

// An interned string entry in the data section
export interface DataEntry {
  bytes: Uint8Array // The actual bytes (includes null terminator for strings)
  offset: number // Offset in the data section
  length: number // Length in bytes (includes null terminator for strings)
  explicit: boolean // True for user-specified memory data, false for auto-interned literals
}

// Result of building the data section
export interface DataSection {
  // All unique data entries (explicit + interned literals), sorted by offset
  entries: DataEntry[]

  // Map from literal AST node start offset → data entry
  // Used to look up where a literal was placed
  literalMap: Map<number, DataEntry>

  // Total size of the data section in bytes
  totalSize: number

  // Offset where automatic (interned) data starts
  // (after any explicit data blocks)
  autoDataStart: number

  // Errors (e.g., overlapping explicit entries)
  errors: string[]
}

// Build the data section for a module
export function buildDataSection(module: AST.Module): DataSection {
  const builder = new DataSectionBuilder()
  builder.build(module)
  return builder.result()
}

export class DataSectionBuilder {
  // Explicit data entries from memory declarations (placed first)
  private explicitEntries: { offset: number; bytes: Uint8Array }[] = []

  // Interned literals: bytes (as hex string for Map key) → entry
  private internedMap = new Map<string, DataEntry>()

  // Map from AST literal offset → interned entry
  private literalMap = new Map<number, DataEntry>()

  // Current offset for placing new interned data
  private currentOffset = 0

  // Set where auto data starts (for layoutLiterals with explicit addresses)
  setAutoDataStart(offset: number): void {
    this.currentOffset = offset
  }

  build(module: AST.Module): void {
    // First pass: collect explicit data blocks from memory declarations
    for (const decl of module.decls) {
      this.collectExplicitData(decl)
    }

    // Calculate where automatic data starts (after explicit data)
    this.currentOffset = this.calculateAutoDataStart()

    // Second pass: collect and intern all string literals
    for (const decl of module.decls) {
      this.collectLiterals(decl)
    }
  }

  result(): DataSection {
    const errors: string[] = []

    // Build explicit entries (null terminators already in bytes for strings)
    const explicitDataEntries: DataEntry[] = this.explicitEntries.map((exp) => ({
      bytes: exp.bytes,
      offset: exp.offset,
      length: exp.bytes.length,
      explicit: true,
    }))

    // Check for overlapping explicit entries (bytes.length includes null for strings)
    const sortedExplicit = [...explicitDataEntries].sort((a, b) => a.offset - b.offset)
    for (let i = 0; i < sortedExplicit.length - 1; i++) {
      const current = sortedExplicit[i]
      const next = sortedExplicit[i + 1]
      const currentEnd = current.offset + current.length
      if (currentEnd > next.offset) {
        errors.push(
          `memory data at offset ${next.offset} overlaps previous entry at offset ${current.offset} ` +
            `(${current.length} bytes ends at ${currentEnd})`,
        )
      }
    }

    // Combine explicit and interned entries, sorted by offset
    const interned = Array.from(this.internedMap.values())
    const entries = [...explicitDataEntries, ...interned].sort(
      (a, b) => a.offset - b.offset,
    )

    return {
      entries,
      literalMap: this.literalMap,
      totalSize: this.currentOffset,
      autoDataStart: this.calculateAutoDataStart(),
      errors,
    }
  }

  private calculateAutoDataStart(): number {
    if (this.explicitEntries.length === 0) return 0

    // Find the end of the last explicit entry (bytes.length includes null for strings)
    let maxEnd = 0
    for (const entry of this.explicitEntries) {
      const end = entry.offset + entry.bytes.length
      if (end > maxEnd) maxEnd = end
    }
    return maxEnd
  }

  // Collect explicit data from memory declarations
  private collectExplicitData(decl: AST.Declaration): void {
    if (decl.kind === 'ExportDecl' && decl.item.kind === 'MemoryDecl') {
      this.collectMemoryData(decl.item)
    } else if (decl.kind === 'MemoryDecl') {
      this.collectMemoryData(decl)
    }
  }

  private collectMemoryData(mem: AST.MemoryDecl): void {
    for (const entry of mem.data) {
      // Get bytes from the expression (should be a string literal)
      const bytes = this.exprToBytes(entry.value)
      if (bytes) {
        this.explicitEntries.push({ offset: entry.offset, bytes })
      }
    }
  }

  // Convert an expression to bytes (for explicit data entries)
  // Strings include null terminator in their bytes
  private exprToBytes(expr: AST.Expr): Uint8Array | null {
    // Handle type annotations: 1:i32, 0:u8, etc.
    if (expr.kind === 'AnnotationExpr') {
      return this.exprToBytesWithType(expr.expr, expr.type)
    }

    // Untyped literals
    if (expr.kind === 'LiteralExpr') {
      if (expr.value.kind === 'string') {
        // Strings are slices, include null terminator
        return stringBytesWithNull(expr.value.bytes)
      }
      if (expr.value.kind === 'int') {
        // Default: comptime int → i32
        return serializeInt(expr.value.value, 'i32')
      }
      if (expr.value.kind === 'float') {
        // Default: comptime float → f64
        return serializeFloat(expr.value.value, 'f64')
      }
    }

    // Tuple: concatenate serialized elements
    // Strings already include null terminators from exprToBytes
    if (expr.kind === 'TupleExpr') {
      const parts: Uint8Array[] = []
      for (const arg of expr.elements) {
        if (!arg.value) continue
        const bytes = this.exprToBytes(arg.value)
        if (!bytes) return null // Non-convertible element
        parts.push(bytes)
      }
      return concatBytes(parts)
    }

    return null
  }

  // Convert expression with explicit type annotation
  private exprToBytesWithType(expr: AST.Expr, type: AST.Type): Uint8Array | null {
    if (expr.kind !== 'LiteralExpr') return null

    // Get the primitive type name
    const typeName = this.getPrimitiveTypeName(type)
    if (!typeName) return null

    if (expr.value.kind === 'int') {
      return serializeInt(expr.value.value, typeName)
    }
    if (expr.value.kind === 'float') {
      return serializeFloat(expr.value.value, typeName)
    }
    if (expr.value.kind === 'string') {
      // Strings are slices, include null terminator
      return stringBytesWithNull(expr.value.bytes)
    }

    return null
  }

  // Extract primitive type name from AST type
  private getPrimitiveTypeName(type: AST.Type): string | null {
    if (type.kind === 'PrimitiveType') {
      return type.name
    }
    if (type.kind === 'TypeRef' && type.args.length === 0) {
      return type.name
    }
    return null
  }

  // Walk AST to collect string literals
  private collectLiterals(decl: AST.Declaration): void {
    switch (decl.kind) {
      case 'ImportDecl':
        // Imports don't contain literals to embed
        break
      case 'ExportDecl':
        this.collectLiteralsFromExportable(decl.item)
        break
      case 'FuncDecl':
        this.collectLiteralsFromFunc(decl)
        break
      case 'TypeDecl':
      case 'UniqueDecl':
        // Type declarations don't contain literals
        break
      case 'DefDecl':
        this.collectLiteralsFromExpr(decl.value)
        break
      case 'GlobalDecl':
        if (decl.value) this.collectLiteralsFromExpr(decl.value)
        break
      case 'MemoryDecl':
        // Already handled in collectExplicitData
        break
    }
  }

  private collectLiteralsFromExportable(
    item: AST.FuncDecl | AST.GlobalDecl | AST.MemoryDecl,
  ): void {
    switch (item.kind) {
      case 'FuncDecl':
        this.collectLiteralsFromFunc(item)
        break
      case 'GlobalDecl':
        if (item.value) this.collectLiteralsFromExpr(item.value)
        break
      case 'MemoryDecl':
        // Already handled
        break
    }
  }

  private collectLiteralsFromFunc(func: AST.FuncDecl): void {
    this.collectLiteralsFromBody(func.body)
  }

  private collectLiteralsFromBody(body: AST.FuncBody): void {
    if (body.kind === 'Block') {
      for (const stmt of body.stmts) {
        this.collectLiteralsFromStmt(stmt)
      }
    } else {
      this.collectLiteralsFromExpr(body.expr)
    }
  }

  private collectLiteralsFromStmt(stmt: AST.Statement): void {
    switch (stmt.kind) {
      case 'LetStmt':
        if (stmt.value) this.collectLiteralsFromExpr(stmt.value)
        break
      case 'SetStmt':
        this.collectLiteralsFromExpr(stmt.value)
        break
      case 'WhileStmt':
        this.collectLiteralsFromExpr(stmt.condition)
        this.collectLiteralsFromBody(stmt.body)
        break
      case 'ForStmt':
        this.collectLiteralsFromExpr(stmt.iterable)
        this.collectLiteralsFromBody(stmt.body)
        break
      case 'LoopStmt':
        this.collectLiteralsFromBody(stmt.body)
        break
      case 'ReturnStmt':
        if (stmt.value) this.collectLiteralsFromExpr(stmt.value)
        if (stmt.when) this.collectLiteralsFromExpr(stmt.when)
        break
      case 'BreakStmt':
      case 'ContinueStmt':
        if (stmt.when) this.collectLiteralsFromExpr(stmt.when)
        break
      case 'AssignmentStmt':
        this.collectLiteralsFromExpr(stmt.value)
        break
      case 'ExpressionStmt':
        this.collectLiteralsFromExpr(stmt.expr)
        break
    }
  }

  private collectLiteralsFromExpr(expr: AST.Expr): void {
    switch (expr.kind) {
      case 'LiteralExpr':
        if (expr.value.kind === 'string') {
          this.internLiteral(expr)
        }
        break
      case 'BinaryExpr':
        this.collectLiteralsFromExpr(expr.left)
        this.collectLiteralsFromExpr(expr.right)
        break
      case 'UnaryExpr':
        this.collectLiteralsFromExpr(expr.operand)
        break
      case 'CastExpr':
      case 'AnnotationExpr':
        this.collectLiteralsFromExpr(expr.expr)
        break
      case 'CallExpr':
        this.collectLiteralsFromExpr(expr.callee)
        for (const arg of expr.args) {
          if (arg.value) this.collectLiteralsFromExpr(arg.value)
        }
        break
      case 'MemberExpr':
        this.collectLiteralsFromExpr(expr.object)
        break
      case 'IndexExpr':
        this.collectLiteralsFromExpr(expr.object)
        this.collectLiteralsFromExpr(expr.index)
        break
      case 'IdentExpr':
        // No literals in identifiers
        break
      case 'IfExpr':
        this.collectLiteralsFromExpr(expr.condition)
        this.collectLiteralsFromBody(expr.thenBranch)
        for (const elif of expr.elifs) {
          this.collectLiteralsFromExpr(elif.condition)
          this.collectLiteralsFromBody(elif.thenBranch)
        }
        if (expr.else_) this.collectLiteralsFromBody(expr.else_)
        break
      case 'MatchExpr':
        this.collectLiteralsFromExpr(expr.subject)
        for (const arm of expr.arms) {
          if (arm.body.kind === 'Block' || arm.body.kind === 'ArrowBody') {
            this.collectLiteralsFromBody(arm.body)
          } else {
            this.collectLiteralsFromExpr(arm.body)
          }
        }
        break
      case 'TupleExpr':
        for (const elem of expr.elements) {
          if (elem.value) this.collectLiteralsFromExpr(elem.value)
        }
        break
      case 'GroupExpr':
        this.collectLiteralsFromExpr(expr.expr)
        break
    }
  }

  private internLiteral(expr: AST.LiteralExpr): void {
    if (expr.value.kind !== 'string') return

    const rawBytes = expr.value.bytes
    const key = bytesToKey(rawBytes)

    // Check if already interned
    let entry = this.internedMap.get(key)
    if (!entry) {
      // Create new entry with null terminator included in bytes (strings are slices)
      const bytesWithNull = stringBytesWithNull(rawBytes)
      entry = {
        bytes: bytesWithNull,
        offset: this.currentOffset,
        length: bytesWithNull.length,
        explicit: false,
      }
      this.internedMap.set(key, entry)
      this.currentOffset += bytesWithNull.length
    }

    // Map this literal to its entry
    this.literalMap.set(expr.span.start, entry)
  }

  // Intern arbitrary bytes, returning a DataRef
  // Used by type-aware serialization
  internBytes(bytes: Uint8Array): DataRef {
    const key = bytesToKey(bytes)

    // 1. Check exact-match cache first (fast path)
    let entry = this.internedMap.get(key)
    if (entry) {
      return { ptr: entry.offset, len: entry.length }
    }

    // 2. Scan existing data for substring match
    const existingOffset = this.findSubstring(bytes)
    if (existingOffset !== -1) {
      // Found! Return ref without adding to entries (we're reusing, not writing)
      return { ptr: existingOffset, len: bytes.length }
    }

    // 3. Not found - write new bytes
    entry = {
      bytes,
      offset: this.currentOffset,
      length: bytes.length,
      explicit: false,
    }
    this.internedMap.set(key, entry)
    this.currentOffset += bytes.length

    return { ptr: entry.offset, len: entry.length }
  }

  // Get all written bytes as a contiguous buffer (for substring search)
  private getWrittenBytes(): Uint8Array {
    if (this.currentOffset === 0) return new Uint8Array(0)

    // Build buffer from all interned entries
    const result = new Uint8Array(this.currentOffset)

    // Copy explicit entries first
    for (const exp of this.explicitEntries) {
      result.set(exp.bytes, exp.offset)
    }

    // Copy interned entries
    for (const entry of this.internedMap.values()) {
      result.set(entry.bytes, entry.offset)
    }

    return result
  }

  // Search for needle in existing data section
  // Returns offset if found, -1 if not found
  private findSubstring(needle: Uint8Array): number {
    const haystack = this.getWrittenBytes()
    if (haystack.length < needle.length) return -1

    outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) continue outer
      }
      return i // Found at offset i
    }
    return -1 // Not found
  }
}

// Append null terminator to string bytes
function stringBytesWithNull(bytes: Uint8Array): Uint8Array {
  const result = new Uint8Array(bytes.length + 1)
  result.set(bytes)
  result[bytes.length] = 0
  return result
}

// Convert bytes to a string key for Map (for deduplication)
function bytesToKey(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// Serialize the data section to bytes (for embedding in WASM)
export function serializeDataSection(section: DataSection): Uint8Array {
  const result = new Uint8Array(section.totalSize)

  for (const entry of section.entries) {
    // Copy bytes (null terminators already included for strings)
    result.set(entry.bytes, entry.offset)
  }

  return result
}

// Format data section as WAT data segments
export function dataToWat(section: DataSection): string[] {
  const segments: string[] = []

  for (const entry of section.entries) {
    // Null terminators already included in bytes for strings
    const escaped = escapeWatString(entry.bytes)
    segments.push(`(data (i32.const ${entry.offset}) "${escaped}")`)
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

// Concatenate multiple byte arrays
function concatBytes(parts: Uint8Array[]): Uint8Array {
  const totalLen = parts.reduce((sum, p) => sum + p.length, 0)
  const result = new Uint8Array(totalLen)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

// Serialize integer to bytes (little endian)
function serializeInt(value: bigint, typeName: string): Uint8Array | null {
  switch (typeName) {
    case 'i8':
    case 'u8':
      return new Uint8Array([Number(value) & 0xff])
    case 'i16':
    case 'u16': {
      const buf = new Uint8Array(2)
      const view = new DataView(buf.buffer)
      view.setUint16(0, Number(value) & 0xffff, true)
      return buf
    }
    case 'i32':
    case 'u32': {
      const buf = new Uint8Array(4)
      const view = new DataView(buf.buffer)
      view.setUint32(0, Number(value) & 0xffffffff, true)
      return buf
    }
    case 'i64':
    case 'u64': {
      const buf = new Uint8Array(8)
      const view = new DataView(buf.buffer)
      view.setBigUint64(0, BigInt.asUintN(64, value), true)
      return buf
    }
    default:
      return null
  }
}

// Fast i32 serialization (common case for pointers)
function serializeI32(value: number): Uint8Array {
  const buf = new Uint8Array(4)
  const view = new DataView(buf.buffer)
  view.setInt32(0, value, true)
  return buf
}

// Fast f64 serialization (common case for floats)
function serializeF64(value: number): Uint8Array {
  const buf = new Uint8Array(8)
  const view = new DataView(buf.buffer)
  view.setFloat64(0, value, true)
  return buf
}

// Serialize float to bytes (little endian)
function serializeFloat(value: number, typeName: string): Uint8Array | null {
  switch (typeName) {
    case 'f32': {
      const buf = new Uint8Array(4)
      const view = new DataView(buf.buffer)
      view.setFloat32(0, value, true)
      return buf
    }
    case 'f64': {
      const buf = new Uint8Array(8)
      const view = new DataView(buf.buffer)
      view.setFloat64(0, value, true)
      return buf
    }
    default:
      return null
  }
}

// === Type-aware literal serialization ===

// Reference to data in the data section
export interface DataRef {
  ptr: number // Offset in data section
  len: number // Byte length or element count (for slices)
}

// Serialize a literal expression to the data section based on target type
// Returns a DataRef that codegen can use
export function serializeLiteral(
  expr: AST.Expr,
  targetType: IndexedRT,
  builder: DataSectionBuilder,
): DataRef {
  // Check if this is a merged bracket (single indexed type with multiple specifiers)
  // vs separate brackets (nested indexed types)
  const isMerged = targetType.specifiers.length > 1 ||
    (targetType.specifiers.length === 1 && targetType.element.kind !== 'indexed')

  if (isMerged || targetType.element.kind !== 'indexed') {
    // Merged or single-level: serialize everything at once
    return serializeMerged(expr, targetType, builder)
  } else {
    // Separate brackets: recurse depth-first
    return serializeSeparate(expr, targetType, builder)
  }
}

// Serialize merged brackets (e.g., u8[/0/0]) - single contiguous write
function serializeMerged(
  expr: AST.Expr,
  targetType: IndexedRT,
  builder: DataSectionBuilder,
): DataRef {
  const bytes = buildMergedBytes(expr, targetType)
  return builder.internBytes(bytes)
}

// Build the complete byte sequence for merged brackets
// Specifier order: leftmost is outermost, rightmost is innermost
// e.g., u8[/leb128/0] means: /0 applies to each element, /leb128 applies to whole array
function buildMergedBytes(expr: AST.Expr, targetType: IndexedRT): Uint8Array {
  const specifiers = targetType.specifiers
  const elementType = targetType.element

  // For single-element types (string literal, int array), serialize directly
  if (expr.kind === 'LiteralExpr') {
    const rawBytes = literalToBytes(expr, elementType)
    return applySpecifiers(rawBytes, specifiers, getElementSize(elementType))
  }

  // For array expressions, serialize each element then apply outer specifiers
  if (expr.kind === 'ArrayExpr') {
    const elementParts: Uint8Array[] = []

    // Leftmost specifier is outermost (applies to whole array)
    // Rightmost specifiers are innermost (apply to each element)
    const outerSpec = specifiers[0]
    const innerSpecs = specifiers.slice(1)

    for (const elem of expr.elements) {
      const elemBytes = buildElementBytes(elem, elementType, innerSpecs)
      elementParts.push(elemBytes)
    }

    // Concatenate all elements
    const combined = concatBytes(elementParts)

    // Apply outer specifier (final terminator or prefix)
    if (outerSpec) {
      return applySpecifier(combined, outerSpec, getElementSize(elementType), elementParts.length)
    }
    return combined
  }

  throw new Error(`Cannot serialize ${expr.kind} to merged indexed type`)
}

// Build bytes for a single element with inner specifiers
// Specifiers are ordered: leftmost is outermost, rightmost is innermost
function buildElementBytes(
  expr: AST.Expr,
  elementType: ResolvedType,
  specifiers: IndexSpecifierRT[],
): Uint8Array {
  if (expr.kind === 'LiteralExpr') {
    const rawBytes = literalToBytes(expr, elementType)
    if (specifiers.length === 0) {
      return rawBytes
    }
    // Apply specifiers - for a single literal, apply all specifiers
    return applySpecifiers(rawBytes, specifiers, getElementSize(elementType))
  }

  if (expr.kind === 'ArrayExpr' && specifiers.length > 0) {
    // Nested array with specifiers - recurse
    const parts: Uint8Array[] = []
    // Leftmost is outermost, rightmost (slice(1)) are inner
    const outerSpec = specifiers[0]
    const innerSpecs = specifiers.slice(1)

    for (const elem of expr.elements) {
      parts.push(buildElementBytes(elem, elementType, innerSpecs))
    }

    const combined = concatBytes(parts)
    return applySpecifier(combined, outerSpec, getElementSize(elementType), parts.length)
  }

  throw new Error(`Cannot build element bytes for ${expr.kind}`)
}

// Serialize separate brackets (e.g., u8[/0][/0]) - depth-first with pointer arrays
function serializeSeparate(
  expr: AST.Expr,
  targetType: IndexedRT,
  builder: DataSectionBuilder,
): DataRef {
  if (expr.kind !== 'ArrayExpr') {
    throw new Error(`Expected ArrayExpr for separate brackets, got ${expr.kind}`)
  }

  const innerType = targetType.element as IndexedRT
  const childRefs: DataRef[] = []

  // Recurse to serialize each child element first
  for (const elem of expr.elements) {
    const childRef = serializeLiteral(elem, innerType, builder)
    childRefs.push(childRef)
  }

  // Now encode the pointer array based on outer type
  const isSlice = targetType.size === null && targetType.specifiers.length === 0
  const pointerBytes = encodePointerArray(childRefs, targetType.specifiers, isSlice)

  return builder.internBytes(pointerBytes)
}

// Encode an array of DataRefs as a pointer array
function encodePointerArray(
  refs: DataRef[],
  specifiers: IndexSpecifierRT[],
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

  // Apply specifiers (e.g., null terminator for /0)
  if (specifiers.length > 0) {
    const spec = specifiers[specifiers.length - 1]
    // For pointer arrays, element size is 4 (i32 pointer) or 8 (slice pair)
    const elemSize = isSlice ? 8 : 4
    return applySpecifier(combined, spec, elemSize, refs.length)
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
      const bytes = serializeInt(lit.value, elementType.name)
      if (bytes) return bytes
    }
    // Default to i32
    return serializeI32(Number(lit.value))
  }

  if (lit.kind === 'float') {
    if (elementType.kind === 'primitive') {
      const bytes = serializeFloat(lit.value, elementType.name)
      if (bytes) return bytes
    }
    // Default to f64
    return serializeF64(lit.value)
  }

  if (lit.kind === 'bool') {
    return new Uint8Array([lit.value ? 1 : 0])
  }

  throw new Error(`Cannot convert ${lit.kind} literal to bytes`)
}

// Apply all specifiers to bytes (inside-out order)
function applySpecifiers(
  bytes: Uint8Array,
  specifiers: IndexSpecifierRT[],
  elementSize: number,
): Uint8Array {
  let result = bytes
  for (const spec of specifiers) {
    result = applySpecifier(result, spec, elementSize, 0)
  }
  return result
}

// Apply a single specifier to bytes
function applySpecifier(
  bytes: Uint8Array,
  spec: IndexSpecifierRT,
  elementSize: number,
  count: number,
): Uint8Array {
  if (spec.kind === 'null') {
    // Null terminator: append zeros of element width
    const terminator = new Uint8Array(elementSize)
    return concatBytes([bytes, terminator])
  }

  // Length/count prefix
  const prefixBytes = encodeLengthPrefix(spec.prefixType, count || bytes.length)
  return concatBytes([prefixBytes, bytes])
}

// Encode a length prefix in the specified format
function encodeLengthPrefix(
  prefixType: 'u8' | 'u16' | 'u32' | 'u64' | 'leb128',
  value: number,
): Uint8Array {
  if (prefixType === 'leb128') {
    return encodeLEB128(value)
  }
  const bytes = serializeInt(BigInt(value), prefixType)
  if (!bytes) {
    throw new Error(`Unknown prefix type: ${prefixType}`)
  }
  return bytes
}

// Encode unsigned LEB128
function encodeLEB128(value: number): Uint8Array {
  const bytes: number[] = []
  do {
    let byte = value & 0x7f
    value >>>= 7
    if (value !== 0) byte |= 0x80
    bytes.push(byte)
  } while (value !== 0)
  return new Uint8Array(bytes)
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
  if (type.kind === 'indexed' || type.kind === 'pointer') {
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
  type: IndexedRT
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

// Count max specifiers in a single bracket (not summed across nesting)
// Merged brackets like u8[/0/0] have 2, separate u8[/0][/0] has max 1
// Higher count = larger contiguous output = should be written first
function countSpecifiers(type: IndexedRT): number {
  const thisLevel = type.specifiers.length
  if (type.element.kind === 'indexed') {
    return Math.max(thisLevel, countSpecifiers(type.element))
  }
  return thisLevel
}

// Lay out a list of qualified literals into a data section
// Uses DataSectionBuilder internally (single implementation)
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

  // Sort auto entries by specifier depth (descending) for better deduplication
  auto.sort((a, b) => countSpecifiers(b.type) - countSpecifiers(a.type))

  // Set auto data to start after explicit entries
  let maxExplicitEnd = 0
  for (const e of explicitEntries) {
    const end = e.offset + e.bytes.length
    if (end > maxExplicitEnd) maxExplicitEnd = end
  }
  builder.setAutoDataStart(maxExplicitEnd)

  // Serialize auto literals using the shared DataSectionBuilder
  for (const lit of auto) {
    const expr = literalValueToExpr(lit.value)
    const ref = serializeLiteral(expr, lit.type, builder)
    if (lit.id !== undefined) {
      refs.set(lit.id, ref)
    }
  }

  // Combine explicit and auto entries
  const section = builder.result()
  const explicitDataEntries: DataEntry[] = explicitEntries.map((e) => ({
    bytes: e.bytes,
    offset: e.offset,
    length: e.bytes.length,
    explicit: true,
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
