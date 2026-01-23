// Shared utility functions
// === Hex encoding/decoding ===
// Lookup table: char code → nibble (0-15, or 255 for invalid)
const hexCharToNibble = new Uint8Array(128).fill(255);
for (let i = 0; i < 10; i++)
    hexCharToNibble[48 + i] = i; // '0'-'9'
for (let i = 10; i < 16; i++)
    hexCharToNibble[55 + i] = i; // 'A'-'F'
for (let i = 10; i < 16; i++)
    hexCharToNibble[87 + i] = i; // 'a'-'f'
const nibbleToHexChar = new Uint8Array(16);
for (let i = 0; i < 16; i++) {
    nibbleToHexChar[i] = i < 10 ? 48 + i : 87 + i; // '0'-'9', 'a'-'f'
}
/** Convert bytes to hex string (lowercase, no prefix) */
export function bytesToHex(bytes) {
    let result = '';
    for (let i = 0; i < bytes.length; i++) {
        const byte = bytes[i];
        result += String.fromCharCode(nibbleToHexChar[byte >> 4], nibbleToHexChar[byte & 0xf]);
    }
    return result;
}
/** Convert hex string to bytes */
export function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = (hexCharToNibble[hex.charCodeAt(i * 2)] << 4) | hexCharToNibble[hex.charCodeAt(i * 2 + 1)];
    }
    return bytes;
}
// === Byte array operations ===
/** Concatenate multiple byte arrays */
export function concatBytes(parts) {
    const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}
// === LEB128 encoding ===
/** Encode unsigned integer as LEB128 */
export function encodeLEB128(value) {
    const bytes = [];
    do {
        let byte = value & 0x7f;
        value >>>= 7;
        if (value !== 0)
            byte |= 0x80;
        bytes.push(byte);
    } while (value !== 0);
    return new Uint8Array(bytes);
}
/** Decode unsigned LEB128 to number */
export function decodeLEB128(bytes, offset = 0) {
    let value = 0;
    let shift = 0;
    let bytesRead = 0;
    while (offset + bytesRead < bytes.length) {
        const byte = bytes[offset + bytesRead];
        value |= (byte & 0x7f) << shift;
        bytesRead++;
        if ((byte & 0x80) === 0)
            break;
        shift += 7;
    }
    return { value, bytesRead };
}
// === Integer serialization (little-endian) ===
/** Serialize integer to little-endian bytes */
export function serializeInt(value, typeName) {
    switch (typeName) {
        case 'i8':
        case 'u8':
            return new Uint8Array([Number(value) & 0xff]);
        case 'i16':
        case 'u16': {
            const buf = new Uint8Array(2);
            const view = new DataView(buf.buffer);
            view.setUint16(0, Number(value) & 0xffff, true);
            return buf;
        }
        case 'i32':
        case 'u32': {
            const buf = new Uint8Array(4);
            const view = new DataView(buf.buffer);
            view.setUint32(0, Number(value) & 0xffffffff, true);
            return buf;
        }
        case 'i64':
        case 'u64': {
            const buf = new Uint8Array(8);
            const view = new DataView(buf.buffer);
            view.setBigUint64(0, BigInt.asUintN(64, value), true);
            return buf;
        }
        default:
            return null;
    }
}
/** Fast i32 serialization (common for pointers) */
export function serializeI32(value) {
    const buf = new Uint8Array(4);
    const view = new DataView(buf.buffer);
    view.setInt32(0, value, true);
    return buf;
}
/** Serialize float to little-endian bytes */
export function serializeFloat(value, typeName) {
    switch (typeName) {
        case 'f32': {
            const buf = new Uint8Array(4);
            const view = new DataView(buf.buffer);
            view.setFloat32(0, value, true);
            return buf;
        }
        case 'f64': {
            const buf = new Uint8Array(8);
            const view = new DataView(buf.buffer);
            view.setFloat64(0, value, true);
            return buf;
        }
        default:
            return null;
    }
}
/** Fast f64 serialization (common for floats) */
export function serializeF64(value) {
    const buf = new Uint8Array(8);
    const view = new DataView(buf.buffer);
    view.setFloat64(0, value, true);
    return buf;
}
// === JSON helpers ===
/** JSON replacer that converts BigInt to string */
export function bigintReplacer(_key, value) {
    if (typeof value === 'bigint') {
        return value.toString();
    }
    return value;
}
//# sourceMappingURL=utils.js.map