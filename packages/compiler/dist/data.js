// Data section builder for Encantis
// Collects string literals, deduplicates, and calculates memory offsets
import { bytesToHex, concatBytes, encodeLEB128, serializeInt, serializeI32, serializeF64, serializeFloat, } from './utils';
/**
 * Check if indexed type uses merged brackets (single pass serialization)
 * vs separate brackets (depth-first with pointer arrays).
 * Merged: specifiers apply to contiguous data (e.g., *[![!u8]])
 * Separate: nested indexed types requiring pointer indirection (e.g., *[!*[!u8]])
 */
function isMergedBrackets(type) {
    return type.specifiers.length > 1 ||
        (type.specifiers.length === 1 && type.element.kind !== 'indexed');
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
export class DataSectionBuilder {
    explicitEntries = [];
    internedMap = new Map();
    literalMap = new Map();
    /** Next available offset for placing new interned data */
    currentOffset = 0;
    // Set where auto data starts (for layoutLiterals with explicit addresses)
    setAutoDataStart(offset) {
        this.currentOffset = offset;
    }
    build(module) {
        // First pass: collect explicit data blocks from memory declarations
        for (const decl of module.decls) {
            this.collectExplicitData(decl);
        }
        // Calculate where automatic data starts (after explicit data)
        this.currentOffset = this.calculateAutoDataStart();
        // Second pass: collect and intern all string literals
        for (const decl of module.decls) {
            this.collectLiterals(decl);
        }
    }
    result() {
        const errors = [];
        // Build explicit entries (null terminators already in bytes for strings)
        const explicitDataEntries = this.explicitEntries.map((exp) => ({
            bytes: exp.bytes,
            offset: exp.offset,
            length: exp.bytes.length,
            explicit: true,
        }));
        // Check for overlapping explicit entries (bytes.length includes null for strings)
        const sortedExplicit = [...explicitDataEntries].sort((a, b) => a.offset - b.offset);
        for (let i = 0; i < sortedExplicit.length - 1; i++) {
            const current = sortedExplicit[i];
            const next = sortedExplicit[i + 1];
            const currentEnd = current.offset + current.length;
            if (currentEnd > next.offset) {
                errors.push(`memory data at offset ${next.offset} overlaps previous entry at offset ${current.offset} ` +
                    `(${current.length} bytes ends at ${currentEnd})`);
            }
        }
        // Combine explicit and interned entries, sorted by offset
        const interned = Array.from(this.internedMap.values());
        const entries = [...explicitDataEntries, ...interned].sort((a, b) => a.offset - b.offset);
        return {
            entries,
            literalMap: this.literalMap,
            totalSize: this.currentOffset,
            autoDataStart: this.calculateAutoDataStart(),
            errors,
        };
    }
    calculateAutoDataStart() {
        if (this.explicitEntries.length === 0)
            return 0;
        // Find the end of the last explicit entry (bytes.length includes null for strings)
        let maxEnd = 0;
        for (const entry of this.explicitEntries) {
            const end = entry.offset + entry.bytes.length;
            if (end > maxEnd)
                maxEnd = end;
        }
        return maxEnd;
    }
    // Collect explicit data from memory declarations
    collectExplicitData(decl) {
        if (decl.kind === 'ExportDecl' && decl.item.kind === 'MemoryDecl') {
            this.collectMemoryData(decl.item);
        }
        else if (decl.kind === 'MemoryDecl') {
            this.collectMemoryData(decl);
        }
    }
    collectMemoryData(mem) {
        for (const entry of mem.data) {
            // Get bytes from the expression (should be a string literal)
            const bytes = this.exprToBytes(entry.value);
            if (bytes) {
                this.explicitEntries.push({ offset: entry.offset, bytes });
            }
        }
    }
    // Convert an expression to bytes (for explicit data entries)
    // Strings include null terminator in their bytes
    exprToBytes(expr) {
        // Handle type annotations: 1:i32, 0:u8, etc.
        if (expr.kind === 'AnnotationExpr') {
            return this.exprToBytesWithType(expr.expr, expr.type);
        }
        // Untyped literals
        if (expr.kind === 'LiteralExpr') {
            if (expr.value.kind === 'string') {
                // Strings are slices, include null terminator
                return stringBytesWithNull(expr.value.bytes);
            }
            if (expr.value.kind === 'int') {
                // Default: comptime int → i32
                return serializeInt(expr.value.value, 'i32');
            }
            if (expr.value.kind === 'float') {
                // Default: comptime float → f64
                return serializeFloat(expr.value.value, 'f64');
            }
        }
        // Tuple: concatenate serialized elements
        // Strings already include null terminators from exprToBytes
        if (expr.kind === 'TupleExpr') {
            const parts = [];
            for (const arg of expr.elements) {
                if (!arg.value)
                    continue;
                const bytes = this.exprToBytes(arg.value);
                if (!bytes)
                    return null; // Non-convertible element
                parts.push(bytes);
            }
            return concatBytes(parts);
        }
        return null;
    }
    // Convert expression with explicit type annotation
    exprToBytesWithType(expr, type) {
        if (expr.kind !== 'LiteralExpr')
            return null;
        // Get the primitive type name
        const typeName = this.getPrimitiveTypeName(type);
        if (!typeName)
            return null;
        if (expr.value.kind === 'int') {
            return serializeInt(expr.value.value, typeName);
        }
        if (expr.value.kind === 'float') {
            return serializeFloat(expr.value.value, typeName);
        }
        if (expr.value.kind === 'string') {
            // Strings are slices, include null terminator
            return stringBytesWithNull(expr.value.bytes);
        }
        return null;
    }
    // Extract primitive type name from AST type
    getPrimitiveTypeName(type) {
        if (type.kind === 'PrimitiveType') {
            return type.name;
        }
        if (type.kind === 'TypeRef' && type.args.length === 0) {
            return type.name;
        }
        return null;
    }
    // Walk AST to collect string literals
    collectLiterals(decl) {
        switch (decl.kind) {
            case 'ImportDecl':
                // Imports don't contain literals to embed
                break;
            case 'ExportDecl':
                this.collectLiteralsFromExportable(decl.item);
                break;
            case 'FuncDecl':
                this.collectLiteralsFromFunc(decl);
                break;
            case 'TypeDecl':
                // Type declarations don't contain literals
                break;
            case 'DefDecl':
                this.collectLiteralsFromExpr(decl.value);
                break;
            case 'GlobalDecl':
                if (decl.value)
                    this.collectLiteralsFromExpr(decl.value);
                break;
            case 'MemoryDecl':
                // Already handled in collectExplicitData
                break;
        }
    }
    collectLiteralsFromExportable(item) {
        switch (item.kind) {
            case 'FuncDecl':
                this.collectLiteralsFromFunc(item);
                break;
            case 'GlobalDecl':
                if (item.value)
                    this.collectLiteralsFromExpr(item.value);
                break;
            case 'MemoryDecl':
                // Already handled
                break;
        }
    }
    collectLiteralsFromFunc(func) {
        this.collectLiteralsFromBody(func.body);
    }
    collectLiteralsFromBody(body) {
        if (body.kind === 'Block') {
            for (const stmt of body.stmts) {
                this.collectLiteralsFromStmt(stmt);
            }
        }
        else {
            this.collectLiteralsFromExpr(body.expr);
        }
    }
    collectLiteralsFromStmt(stmt) {
        switch (stmt.kind) {
            case 'LetStmt':
                if (stmt.value)
                    this.collectLiteralsFromExpr(stmt.value);
                break;
            case 'SetStmt':
                this.collectLiteralsFromExpr(stmt.value);
                break;
            case 'WhileStmt':
                this.collectLiteralsFromExpr(stmt.condition);
                this.collectLiteralsFromBody(stmt.body);
                break;
            case 'ForStmt':
                this.collectLiteralsFromExpr(stmt.iterable);
                this.collectLiteralsFromBody(stmt.body);
                break;
            case 'LoopStmt':
                this.collectLiteralsFromBody(stmt.body);
                break;
            case 'ReturnStmt':
                if (stmt.value)
                    this.collectLiteralsFromExpr(stmt.value);
                if (stmt.when)
                    this.collectLiteralsFromExpr(stmt.when);
                break;
            case 'BreakStmt':
            case 'ContinueStmt':
                if (stmt.when)
                    this.collectLiteralsFromExpr(stmt.when);
                break;
            case 'AssignmentStmt':
                this.collectLiteralsFromExpr(stmt.value);
                break;
            case 'ExpressionStmt':
                this.collectLiteralsFromExpr(stmt.expr);
                break;
        }
    }
    collectLiteralsFromExpr(expr) {
        switch (expr.kind) {
            case 'LiteralExpr':
                if (expr.value.kind === 'string') {
                    this.internLiteral(expr);
                }
                break;
            case 'BinaryExpr':
                this.collectLiteralsFromExpr(expr.left);
                this.collectLiteralsFromExpr(expr.right);
                break;
            case 'UnaryExpr':
                this.collectLiteralsFromExpr(expr.operand);
                break;
            case 'CastExpr':
            case 'AnnotationExpr':
                this.collectLiteralsFromExpr(expr.expr);
                break;
            case 'CallExpr':
                this.collectLiteralsFromExpr(expr.callee);
                for (const arg of expr.args) {
                    if (arg.value)
                        this.collectLiteralsFromExpr(arg.value);
                }
                break;
            case 'MemberExpr':
                this.collectLiteralsFromExpr(expr.object);
                break;
            case 'IndexExpr':
                this.collectLiteralsFromExpr(expr.object);
                this.collectLiteralsFromExpr(expr.index);
                break;
            case 'IdentExpr':
                // No literals in identifiers
                break;
            case 'IfExpr':
                this.collectLiteralsFromExpr(expr.condition);
                this.collectLiteralsFromBody(expr.thenBranch);
                for (const elif of expr.elifs) {
                    this.collectLiteralsFromExpr(elif.condition);
                    this.collectLiteralsFromBody(elif.thenBranch);
                }
                if (expr.else_)
                    this.collectLiteralsFromBody(expr.else_);
                break;
            case 'MatchExpr':
                this.collectLiteralsFromExpr(expr.subject);
                for (const arm of expr.arms) {
                    if (arm.body.kind === 'Block' || arm.body.kind === 'ArrowBody') {
                        this.collectLiteralsFromBody(arm.body);
                    }
                    else {
                        this.collectLiteralsFromExpr(arm.body);
                    }
                }
                break;
            case 'TupleExpr':
                for (const elem of expr.elements) {
                    if (elem.value)
                        this.collectLiteralsFromExpr(elem.value);
                }
                break;
            case 'GroupExpr':
                this.collectLiteralsFromExpr(expr.expr);
                break;
        }
    }
    internLiteral(expr) {
        if (expr.value.kind !== 'string')
            return;
        const rawBytes = expr.value.bytes;
        const key = bytesToKey(rawBytes);
        // Check if already interned
        let entry = this.internedMap.get(key);
        if (!entry) {
            // Create new entry with null terminator included in bytes (strings are slices)
            const bytesWithNull = stringBytesWithNull(rawBytes);
            entry = {
                bytes: bytesWithNull,
                offset: this.currentOffset,
                length: bytesWithNull.length,
                explicit: false,
            };
            this.internedMap.set(key, entry);
            this.currentOffset += bytesWithNull.length;
        }
        // Map this literal to its entry
        this.literalMap.set(expr.span.start, entry);
    }
    // Intern arbitrary bytes, returning a DataRef
    // Used by type-aware serialization
    internBytes(bytes) {
        const key = bytesToKey(bytes);
        // 1. Check exact-match cache first (fast path)
        let entry = this.internedMap.get(key);
        if (entry) {
            return { ptr: entry.offset, len: entry.length };
        }
        // 2. Scan existing data for substring match
        const existingOffset = this.findSubstring(bytes);
        if (existingOffset !== -1) {
            // Found! Return ref without adding to entries (we're reusing, not writing)
            return { ptr: existingOffset, len: bytes.length };
        }
        // 3. Not found - write new bytes
        entry = {
            bytes,
            offset: this.currentOffset,
            length: bytes.length,
            explicit: false,
        };
        this.internedMap.set(key, entry);
        this.currentOffset += bytes.length;
        return { ptr: entry.offset, len: entry.length };
    }
    // Get all written bytes as a contiguous buffer (for substring search)
    getWrittenBytes() {
        if (this.currentOffset === 0)
            return new Uint8Array(0);
        // Build buffer from all interned entries
        const result = new Uint8Array(this.currentOffset);
        // Copy explicit entries first
        for (const exp of this.explicitEntries) {
            result.set(exp.bytes, exp.offset);
        }
        // Copy interned entries
        for (const entry of this.internedMap.values()) {
            result.set(entry.bytes, entry.offset);
        }
        return result;
    }
    // Search for needle in existing data section
    // Returns offset if found, -1 if not found
    findSubstring(needle) {
        const haystack = this.getWrittenBytes();
        if (haystack.length < needle.length)
            return -1;
        for (let i = 0; i <= haystack.length - needle.length; i++) {
            if (needle.every((byte, j) => haystack[i + j] === byte)) {
                return i;
            }
        }
        return -1;
    }
}
// Append null terminator to string bytes
function stringBytesWithNull(bytes) {
    const result = new Uint8Array(bytes.length + 1);
    result.set(bytes);
    result[bytes.length] = 0;
    return result;
}
// Convert bytes to a string key for Map (for deduplication)
// Use bytesToHex as deduplication key
const bytesToKey = bytesToHex;
/**
 * Serialize a DataSection to a single byte array for embedding in WASM.
 * @param section The data section to serialize
 * @returns Byte array with all entries at their correct offsets
 */
export function serializeDataSection(section) {
    const result = new Uint8Array(section.totalSize);
    for (const entry of section.entries) {
        // Copy bytes (null terminators already included for strings)
        result.set(entry.bytes, entry.offset);
    }
    return result;
}
/**
 * Format a DataSection as WAT data segment declarations.
 * Each entry becomes: (data (i32.const OFFSET) "ESCAPED_BYTES")
 * Non-printable bytes are escaped as \xx hex.
 * @param section The data section to format
 * @returns Array of WAT data segment strings
 */
export function dataToWat(section) {
    const segments = [];
    for (const entry of section.entries) {
        // Null terminators already included in bytes for strings
        const escaped = escapeWatString(entry.bytes);
        segments.push(`(data (i32.const ${entry.offset}) "${escaped}")`);
    }
    return segments;
}
// Escape bytes for WAT string literal
function escapeWatString(bytes) {
    let result = '';
    for (const byte of bytes) {
        if (byte >= 32 && byte < 127 && byte !== 0x22 && byte !== 0x5c) {
            // Printable ASCII except " and \
            result += String.fromCharCode(byte);
        }
        else {
            // Escape as hex
            result += `\\${byte.toString(16).padStart(2, '0')}`;
        }
    }
    return result;
}
let partIdCounter = 0;
// Extract all parts from a literal, returning them in a flat list
// Parts are returned in order they were discovered (depth-first)
function collectParts(expr, type, depth, parentId, literalId, parts) {
    const thisId = partIdCounter++;
    if (isMergedBrackets(type) || type.element.kind !== 'indexed') {
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
        });
        return thisId;
    }
    // Separate brackets: extract children first, then this part as pointer array
    if (expr.kind !== 'ArrayExpr') {
        throw new Error(`Expected ArrayExpr for separate brackets, got ${expr.kind}`);
    }
    const innerType = type.element;
    const childIds = [];
    // Recursively collect children at depth+1
    for (const elem of expr.elements) {
        const childId = collectParts(elem, innerType, depth + 1, thisId, undefined, parts);
        childIds.push(childId);
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
    });
    return thisId;
}
// Sort score for parts - higher = process first
// Priority:
//   1. Non-pointer-arrays first (sorted by specifier count, more = higher)
//   2. Pointer arrays last (sorted by depth desc, then specifier count)
function partSortScore(part) {
    const specCount = part.type.specifiers.length;
    if (part.isPointerArray) {
        // Pointer arrays come after ALL non-pointer-arrays
        // Among pointer arrays: deeper ones first (for nested separate brackets),
        // then by specifier count
        const specScore = specCount > 0 ? 10 + specCount : (part.type.size !== null ? 1 : 0);
        return -10000 + part.depth * 100 + specScore;
    }
    // Non-pointer-arrays: sort by specifier count (more = higher priority)
    if (specCount > 0) {
        return 1000 + specCount;
    }
    else if (part.type.size !== null) {
        return 100;
    }
    return 0; // Slices
}
// Serialize parts in sorted order
function serializeSortedParts(parts, builder) {
    const refMap = new Map();
    // Sort by score descending
    const sorted = [...parts].sort((a, b) => partSortScore(b) - partSortScore(a));
    for (const part of sorted) {
        if (part.isPointerArray) {
            // Pointer array: look up child refs and encode
            const childRefs = [];
            for (const childId of part.childIndices) {
                const childRef = refMap.get(childId);
                if (!childRef) {
                    throw new Error(`Child ${childId} not serialized before parent ${part.id}`);
                }
                childRefs.push(childRef);
            }
            // Check if INNER type (children) are slices - determines if we store (ptr,len) pairs
            const innerType = part.type.element;
            const childrenAreSlices = innerType.kind === 'indexed' &&
                innerType.size === null && innerType.specifiers.length === 0;
            const pointerBytes = encodePointerArray(childRefs, part.type.specifiers, childrenAreSlices);
            const ref = builder.internBytes(pointerBytes);
            refMap.set(part.id, ref);
        }
        else {
            // Merged or leaf: serialize directly
            const ref = serializeMerged(part.expr, part.type, builder);
            refMap.set(part.id, ref);
        }
    }
    return refMap;
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
export function serializeLiteral(expr, targetType, builder) {
    if (isMergedBrackets(targetType) || targetType.element.kind !== 'indexed') {
        return serializeMerged(expr, targetType, builder);
    }
    else {
        return serializeSeparate(expr, targetType, builder);
    }
}
// Serialize merged brackets (e.g., *[![!u8]]) - single contiguous write
function serializeMerged(expr, targetType, builder) {
    const bytes = buildMergedBytes(expr, targetType);
    return builder.internBytes(bytes);
}
// Build the complete byte sequence for merged brackets
// Specifier order: leftmost is outermost, rightmost is innermost
// e.g., *[?[!u8]] means: ! applies to each element, ? applies to whole array
function buildMergedBytes(expr, targetType) {
    const specifiers = targetType.specifiers;
    const elementType = targetType.element;
    // For single-element types (string literal, int array), serialize directly
    if (expr.kind === 'LiteralExpr') {
        const rawBytes = literalToBytes(expr, elementType);
        return applySpecifiers(rawBytes, specifiers, getElementSize(elementType));
    }
    // For array expressions, serialize each element then apply outer specifiers
    if (expr.kind === 'ArrayExpr') {
        const elementParts = [];
        // Leftmost specifier is outermost (applies to whole array)
        // Rightmost specifiers are innermost (apply to each element)
        const outerSpec = specifiers[0];
        const innerSpecs = specifiers.slice(1);
        for (const elem of expr.elements) {
            const elemBytes = buildElementBytes(elem, elementType, innerSpecs);
            elementParts.push(elemBytes);
        }
        // Concatenate all elements
        const combined = concatBytes(elementParts);
        // Apply outer specifier (final terminator or prefix)
        if (outerSpec) {
            return applySpecifier(combined, outerSpec, getElementSize(elementType), elementParts.length);
        }
        return combined;
    }
    throw new Error(`Cannot serialize ${expr.kind} to merged indexed type`);
}
// Build bytes for a single element with inner specifiers
// Specifiers are ordered: leftmost is outermost, rightmost is innermost
function buildElementBytes(expr, elementType, specifiers) {
    if (expr.kind === 'LiteralExpr') {
        const rawBytes = literalToBytes(expr, elementType);
        if (specifiers.length === 0) {
            return rawBytes;
        }
        // Apply specifiers - for a single literal, apply all specifiers
        return applySpecifiers(rawBytes, specifiers, getElementSize(elementType));
    }
    if (expr.kind === 'ArrayExpr' && specifiers.length > 0) {
        // Nested array with specifiers - recurse
        const parts = [];
        // Leftmost is outermost, rightmost (slice(1)) are inner
        const outerSpec = specifiers[0];
        const innerSpecs = specifiers.slice(1);
        for (const elem of expr.elements) {
            parts.push(buildElementBytes(elem, elementType, innerSpecs));
        }
        const combined = concatBytes(parts);
        return applySpecifier(combined, outerSpec, getElementSize(elementType), parts.length);
    }
    throw new Error(`Cannot build element bytes for ${expr.kind}`);
}
// Serialize separate brackets (e.g., *[!*[!u8]]) - depth-first with pointer arrays
function serializeSeparate(expr, targetType, builder) {
    if (expr.kind !== 'ArrayExpr') {
        throw new Error(`Expected ArrayExpr for separate brackets, got ${expr.kind}`);
    }
    const innerType = targetType.element;
    const childRefs = [];
    // Recurse to serialize each child element first
    for (const elem of expr.elements) {
        const childRef = serializeLiteral(elem, innerType, builder);
        childRefs.push(childRef);
    }
    // Now encode the pointer array based on outer type
    const isSlice = targetType.size === null && targetType.specifiers.length === 0;
    const pointerBytes = encodePointerArray(childRefs, targetType.specifiers, isSlice);
    return builder.internBytes(pointerBytes);
}
// Encode an array of DataRefs as a pointer array
function encodePointerArray(refs, specifiers, isSlice) {
    const parts = [];
    if (isSlice) {
        // Slice of slices: each element is (ptr, len) pair
        for (const ref of refs) {
            parts.push(serializeI32(ref.ptr));
            parts.push(serializeI32(ref.len));
        }
    }
    else {
        // Pointer array: just pointers
        for (const ref of refs) {
            parts.push(serializeI32(ref.ptr));
        }
    }
    const combined = concatBytes(parts);
    // Apply specifiers (e.g., null terminator for :0)
    if (specifiers.length > 0) {
        const spec = specifiers[specifiers.length - 1];
        // For pointer arrays, element size is 4 (i32 pointer) or 8 (slice pair)
        const elemSize = isSlice ? 8 : 4;
        return applySpecifier(combined, spec, elemSize, refs.length);
    }
    return combined;
}
// Convert a literal expression to raw bytes based on element type
function literalToBytes(expr, elementType) {
    const lit = expr.value;
    if (lit.kind === 'string') {
        return lit.bytes;
    }
    if (lit.kind === 'int') {
        if (elementType.kind === 'primitive') {
            const bytes = serializeInt(lit.value, elementType.name);
            if (bytes)
                return bytes;
        }
        // Default to i32
        return serializeI32(Number(lit.value));
    }
    if (lit.kind === 'float') {
        if (elementType.kind === 'primitive') {
            const bytes = serializeFloat(lit.value, elementType.name);
            if (bytes)
                return bytes;
        }
        // Default to f64
        return serializeF64(lit.value);
    }
    if (lit.kind === 'bool') {
        return new Uint8Array([lit.value ? 1 : 0]);
    }
    throw new Error(`Cannot convert ${lit.kind} literal to bytes`);
}
// Apply all specifiers to bytes (inside-out order)
function applySpecifiers(bytes, specifiers, elementSize) {
    let result = bytes;
    for (const spec of specifiers) {
        result = applySpecifier(result, spec, elementSize, 0);
    }
    return result;
}
// Apply a single specifier to bytes
function applySpecifier(bytes, spec, elementSize, count) {
    if (spec.kind === 'null') {
        // Null terminator: append zeros of element width
        const terminator = new Uint8Array(elementSize);
        return concatBytes([bytes, terminator]);
    }
    // Length/count prefix (always LEB128)
    const prefixBytes = encodeLEB128(count || bytes.length);
    return concatBytes([prefixBytes, bytes]);
}
// Get the byte size of an element type (for null terminators)
function getElementSize(type) {
    if (type.kind === 'primitive') {
        switch (type.name) {
            case 'i8':
            case 'u8':
            case 'bool':
                return 1;
            case 'i16':
            case 'u16':
                return 2;
            case 'i32':
            case 'u32':
            case 'f32':
                return 4;
            case 'i64':
            case 'u64':
            case 'f64':
                return 8;
        }
    }
    // For pointer types (nested indexed), pointers are 4 bytes (i32)
    if (type.kind === 'indexed' || type.kind === 'pointer') {
        return 4;
    }
    // Default to 1 byte
    return 1;
}
// Convert LiteralValue to mock AST.Expr for use with serializeLiteral
function literalValueToExpr(value) {
    const span = { start: 0, end: 0 };
    switch (value.kind) {
        case 'bytes':
            return {
                kind: 'LiteralExpr',
                value: { kind: 'string', bytes: value.data },
                span,
            };
        case 'ints':
            if (value.data.length === 1) {
                return {
                    kind: 'LiteralExpr',
                    value: { kind: 'int', value: value.data[0], radix: 10 },
                    span,
                };
            }
            return {
                kind: 'ArrayExpr',
                elements: value.data.map((v) => ({
                    kind: 'LiteralExpr',
                    value: { kind: 'int', value: v, radix: 10 },
                    span,
                })),
                span,
            };
        case 'floats':
            if (value.data.length === 1) {
                return {
                    kind: 'LiteralExpr',
                    value: { kind: 'float', value: value.data[0] },
                    span,
                };
            }
            return {
                kind: 'ArrayExpr',
                elements: value.data.map((v) => ({
                    kind: 'LiteralExpr',
                    value: { kind: 'float', value: v },
                    span,
                })),
                span,
            };
        case 'nested':
            return {
                kind: 'ArrayExpr',
                elements: value.elements.map((elem) => literalValueToExpr(elem)),
                span,
            };
    }
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
export function layoutLiterals(literals) {
    const builder = new DataSectionBuilder();
    const refs = new Map();
    const explicitEntries = [];
    const errors = [];
    // Separate explicit (addressed) and auto literals
    const explicit = literals.filter((lit) => lit.address !== undefined);
    const auto = literals.filter((lit) => lit.address === undefined);
    // Handle explicit entries first - serialize and place at specified address
    for (const lit of explicit) {
        const address = lit.address; // filtered above
        const expr = literalValueToExpr(lit.value);
        // Use a temporary builder to get the bytes
        const tempBuilder = new DataSectionBuilder();
        serializeLiteral(expr, lit.type, tempBuilder);
        const tempSection = tempBuilder.result();
        const bytes = tempSection.entries[0]?.bytes ?? new Uint8Array(0);
        explicitEntries.push({ offset: address, bytes });
        if (lit.id !== undefined) {
            refs.set(lit.id, { ptr: address, len: bytes.length });
        }
    }
    // Check for overlapping explicit entries
    const sortedExplicit = [...explicitEntries].sort((a, b) => a.offset - b.offset);
    for (let i = 0; i < sortedExplicit.length - 1; i++) {
        const current = sortedExplicit[i];
        const next = sortedExplicit[i + 1];
        const currentEnd = current.offset + current.bytes.length;
        if (currentEnd > next.offset) {
            errors.push(`data at offset ${next.offset} overlaps entry at ${current.offset} (ends at ${currentEnd})`);
        }
    }
    // Set auto data to start after explicit entries
    let maxExplicitEnd = 0;
    for (const e of explicitEntries) {
        const end = e.offset + e.bytes.length;
        if (end > maxExplicitEnd)
            maxExplicitEnd = end;
    }
    builder.setAutoDataStart(maxExplicitEnd);
    // Reset part ID counter for this layout
    partIdCounter = 0;
    // Collect all parts from all auto literals (including nested children)
    const allParts = [];
    const topLevelPartIds = new Map(); // literalId -> partId
    for (const lit of auto) {
        const expr = literalValueToExpr(lit.value);
        const partId = collectParts(expr, lit.type, 0, null, lit.id, allParts);
        if (lit.id !== undefined) {
            topLevelPartIds.set(lit.id, partId);
        }
    }
    // Sort and serialize all parts globally
    const partRefs = serializeSortedParts(allParts, builder);
    // Map top-level part refs back to literal IDs
    for (const [litId, partId] of topLevelPartIds) {
        const ref = partRefs.get(partId);
        if (ref) {
            refs.set(litId, ref);
        }
    }
    // Combine explicit and auto entries
    const section = builder.result();
    const explicitDataEntries = explicitEntries.map((e) => ({
        bytes: e.bytes,
        offset: e.offset,
        length: e.bytes.length,
        explicit: true,
    }));
    const allEntries = [...explicitDataEntries, ...section.entries].sort((a, b) => a.offset - b.offset);
    // Calculate total size (max of explicit end and auto end)
    const totalSize = Math.max(maxExplicitEnd, section.totalSize);
    return {
        refs,
        entries: allEntries,
        totalSize,
        errors: [...errors, ...section.errors],
    };
}
/**
 * Build the data section from pending literals collected during type checking.
 * Sorts literals by priority for better deduplication, then serializes each.
 */
export function buildDataSection(literals) {
    const dataBuilder = new DataSectionBuilder();
    const literalRefs = new Map();
    // Sort by priority for better deduplication
    // Priority: more specifiers > fixed-size > slices
    const sorted = [...literals].sort((a, b) => literalSortScore(b.type) - literalSortScore(a.type));
    // Serialize each literal
    for (const lit of sorted) {
        const ref = serializeLiteral(lit.expr, lit.type, dataBuilder);
        literalRefs.set(lit.id, ref);
    }
    return { dataBuilder, literalRefs };
}
// Sorting score for literals - higher = process first
// Priority: specifiers (terminators/prefixes) > fixed-size > slices
function literalSortScore(type) {
    const maxSpecs = maxSpecifiersInBracket(type);
    if (maxSpecs > 0) {
        return 1000 + maxSpecs; // Has specifiers - highest priority
    }
    if (hasFixedSize(type)) {
        return 100; // Fixed-size arrays
    }
    return 0; // Slices (fat-pointers)
}
// Max specifiers in any single bracket level
// Merged brackets like *[![!u8]] have 2, separate *[!*[!u8]] has max 1
function maxSpecifiersInBracket(type) {
    const thisLevel = type.specifiers.length;
    if (type.element.kind === 'indexed') {
        return Math.max(thisLevel, maxSpecifiersInBracket(type.element));
    }
    return thisLevel;
}
// Check if any level has a fixed size
function hasFixedSize(type) {
    if (type.size !== null)
        return true;
    if (type.element.kind === 'indexed') {
        return hasFixedSize(type.element);
    }
    return false;
}
//# sourceMappingURL=data.js.map