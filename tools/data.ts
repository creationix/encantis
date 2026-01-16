// Data section builder for Encantis
// Collects string literals, deduplicates, and calculates memory offsets

import type * as AST from './ast'

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

class DataSectionBuilder {
  // Explicit data entries from memory declarations (placed first)
  private explicitEntries: { offset: number; bytes: Uint8Array }[] = []

  // Interned literals: bytes (as hex string for Map key) → entry
  private internedMap = new Map<string, DataEntry>()

  // Map from AST literal offset → interned entry
  private literalMap = new Map<number, DataEntry>()

  // Current offset for placing new interned data
  private currentOffset = 0

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
