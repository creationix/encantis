// Shared utility functions

// === Hex encoding/decoding ===

/** Convert bytes to hex string (lowercase, no prefix) */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Convert hex string to bytes */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

// === Byte array operations ===

/** Concatenate multiple byte arrays */
export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const totalLen = parts.reduce((sum, p) => sum + p.length, 0)
  const result = new Uint8Array(totalLen)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

// === LEB128 encoding ===

/** Encode unsigned integer as LEB128 */
export function encodeLEB128(value: number): Uint8Array {
  const bytes: number[] = []
  do {
    let byte = value & 0x7f
    value >>>= 7
    if (value !== 0) byte |= 0x80
    bytes.push(byte)
  } while (value !== 0)
  return new Uint8Array(bytes)
}

/** Decode unsigned LEB128 to number */
export function decodeLEB128(bytes: Uint8Array, offset = 0): { value: number; bytesRead: number } {
  let value = 0
  let shift = 0
  let bytesRead = 0
  while (offset + bytesRead < bytes.length) {
    const byte = bytes[offset + bytesRead]
    value |= (byte & 0x7f) << shift
    bytesRead++
    if ((byte & 0x80) === 0) break
    shift += 7
  }
  return { value, bytesRead }
}

// === Integer serialization (little-endian) ===

/** Serialize integer to little-endian bytes */
export function serializeInt(value: bigint, typeName: string): Uint8Array | null {
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

/** Fast i32 serialization (common for pointers) */
export function serializeI32(value: number): Uint8Array {
  const buf = new Uint8Array(4)
  const view = new DataView(buf.buffer)
  view.setInt32(0, value, true)
  return buf
}

/** Serialize float to little-endian bytes */
export function serializeFloat(value: number, typeName: string): Uint8Array | null {
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

/** Fast f64 serialization (common for floats) */
export function serializeF64(value: number): Uint8Array {
  const buf = new Uint8Array(8)
  const view = new DataView(buf.buffer)
  view.setFloat64(0, value, true)
  return buf
}

// === JSON helpers ===

/** JSON replacer that converts BigInt to string */
export function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString()
  }
  return value
}
