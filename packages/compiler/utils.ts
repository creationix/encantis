// Shared utility functions

// === Hex encoding/decoding ===

// Lookup table: char code → nibble (0-15, or 255 for invalid)
const hexCharToNibble = new Uint8Array(128).fill(255)
for (let i = 0; i < 10; i++) hexCharToNibble[48 + i] = i // '0'-'9'
for (let i = 10; i < 16; i++) hexCharToNibble[55 + i] = i // 'A'-'F'
for (let i = 10; i < 16; i++) hexCharToNibble[87 + i] = i // 'a'-'f'

const nibbleToHexChar = new Uint8Array(16)
for (let i = 0; i < 16; i++) {
  nibbleToHexChar[i] = i < 10 ? 48 + i : 87 + i // '0'-'9', 'a'-'f'
}

/** Convert bytes to hex string (lowercase, no prefix) */
export function bytesToHex(bytes: Uint8Array): string {
  let result = ''
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]
    result += String.fromCharCode(nibbleToHexChar[byte >> 4], nibbleToHexChar[byte & 0xf])
  }
  return result
}

/** Convert hex string to bytes */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = (hexCharToNibble[hex.charCodeAt(i * 2)] << 4) | hexCharToNibble[hex.charCodeAt(i * 2 + 1)]
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
    case 'i128':
    case 'u128': {
      const buf = new Uint8Array(16)
      const view = new DataView(buf.buffer)
      view.setBigUint64(0, BigInt.asUintN(64, value), true)
      view.setBigUint64(8, BigInt.asUintN(64, value >> 64n), true)
      return buf
    }
    case 'i256':
    case 'u256': {
      const buf = new Uint8Array(32)
      const view = new DataView(buf.buffer)
      for (let i = 0; i < 4; i++) {
        view.setBigUint64(i * 8, BigInt.asUintN(64, value >> BigInt(i * 64)), true)
      }
      return buf
    }
    case 'i512':
    case 'u512': {
      const sz = 64
      const buf = new Uint8Array(sz)
      const view = new DataView(buf.buffer)
      for (let i = 0; i < sz / 8; i++) {
        view.setBigUint64(i * 8, BigInt.asUintN(64, value >> BigInt(i * 64)), true)
      }
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

// The f32 nearest a decimal float literal (`1.25`, `-3.0e-5`), where it is
// not the f32 nearest the f64 its text is read as. Rounding the decimal to
// an f64 first and then to an f32 lands on the wrong f32 only where the f64
// is exactly halfway between two f32s and the decimal is not:
// 1.0000000596046448 is above 1 + 2^-24, whose f64 it is read as, and its
// f32 is 1 + 2^-23, not 1 (ties to even). Undefined where Math.fround of
// the f64 is the f32 nearest the decimal.
export function decimalF32(text: string): number | undefined {
  const m = /^([+-]?)(\d+)\.(\d+)(?:[eE]([+-]?\d+))?$/.exec(text)
  if (!m) return undefined
  const x = Math.abs(Number.parseFloat(text))
  const near = Math.fround(x)
  if (!Number.isFinite(x) || near === x) return undefined
  // The f32s on either side of x, and the midpoint between them (2^128
  // stands for the one past the largest f32)
  const bits = new DataView(new ArrayBuffer(4))
  bits.setFloat32(0, near)
  const step = (by: number) => {
    bits.setUint32(0, bits.getUint32(0) + by)
    return bits.getFloat32(0)
  }
  const [lo, hi] = near < x ? [near, step(1)] : [step(-1), near]
  const mid = (lo + (Number.isFinite(hi) ? hi : 2 ** 128)) / 2
  if (mid !== x) return undefined
  // The decimal, n * 10^e, against the midpoint, the f64 x: k * 2^p
  const n = BigInt(m[2] + m[3])
  const e = Number(m[4] ?? 0) - m[3].length
  const f64 = new DataView(new ArrayBuffer(8))
  f64.setFloat64(0, x)
  const raw = f64.getBigUint64(0)
  const biased = Number(raw >> 52n)
  const k = (raw & ((1n << 52n) - 1n)) | (biased === 0 ? 0n : 1n << 52n)
  const p = (biased === 0 ? 1 : biased) - 1075
  const decimal = n * 10n ** BigInt(Math.max(e, 0)) * 2n ** BigInt(Math.max(-p, 0))
  const binary = k * 2n ** BigInt(Math.max(p, 0)) * 10n ** BigInt(Math.max(-e, 0))
  const nearest = decimal > binary ? hi : decimal < binary ? lo : near
  if (nearest === near) return undefined
  return m[1] === '-' ? -nearest : nearest
}

// The f32 a float constant is: the one worked out from its decimals where
// that is not the f64's (decimalF32), or the f64's nearest
export function f32Of(value: { value: number; f32?: number }): number {
  return value.f32 ?? Math.fround(value.value)
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
