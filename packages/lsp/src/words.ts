// =============================================================================
// The words of the language the editor knows without an analysis: keywords,
// builtins and primitive types, with what hover and completion say of them
// =============================================================================

// The reserved words (keyword in encantis-grammar.ohm), and `assert` and
// `test`, which start statements and declarations
export const KEYWORDS: ReadonlySet<string> = new Set([
  'if', 'elif', 'else', 'while', 'for', 'in', 'loop', 'match', 'break', 'continue', 'return', 'when', 'defer',
  'func', 'let', 'set', 'global', 'data', 'def', 'type', 'enum', 'import', 'export', 'memory', 'inline', 'mut',
  'as', 'true', 'false', 'int', 'float', 'sizeof', 'comptime', 'assert', 'test',
]);

// Builtin function signatures for hover display
// Polymorphic builtins show representative types
export const BUILTIN_SIGNATURES: Record<string, string> = {
  // Comptime
  sizeof: 'sizeof(T) -> u32',
  // Memory operations
  memset: 'builtin memset(dest: [*]u8, value: u8, len: u32)',
  memcpy: 'builtin memcpy(dest: [*]u8, src: [*]u8, len: u32)',
  memzero: 'builtin memzero(dest: *mut [N]T)',
  // Float math (f32/f64)
  sqrt: 'builtin sqrt(x: f64) -> f64',
  abs: 'builtin abs(x: f64) -> f64',
  ceil: 'builtin ceil(x: f64) -> f64',
  floor: 'builtin floor(x: f64) -> f64',
  trunc: 'builtin trunc(x: f64) -> f64',
  nearest: 'builtin nearest(x: f64) -> f64',
  copysign: 'builtin copysign(x: f64, y: f64) -> f64',
  // Min/max (all numeric types)
  min: 'builtin min(a: T, b: T) -> T',
  max: 'builtin max(a: T, b: T) -> T',
  // Integer bit operations
  clz: 'builtin clz(x: i32) -> u8',
  ctz: 'builtin ctz(x: i32) -> u8',
  popcnt: 'builtin popcnt(x: i32) -> u8',
  mul_hi: 'builtin mul_hi(a: u64, b: u64) -> u64',
};

// What each builtin does, below its signature in a hover
export const BUILTIN_DOCS: Record<string, string> = {
  sizeof: 'Returns the byte size of a type at compile time.',
  memset: 'Fill memory with a byte value.',
  memcpy: 'Copy bytes from source to destination.',
  memzero: 'Set all of a destination to zero; its size comes from its type.',
  sqrt: 'Square root (f32/f64).',
  abs: 'Absolute value (floats and signed integers).',
  ceil: 'Round up to nearest integer (f32/f64).',
  floor: 'Round down to nearest integer (f32/f64).',
  trunc: 'Truncate toward zero (f32/f64).',
  nearest: 'Round to nearest even (f32/f64).',
  min: 'Minimum of two values (all numeric types).',
  max: 'Maximum of two values (all numeric types).',
  copysign: 'Copy sign of y to x (f32/f64).',
  clz: 'Count leading zeros (i32/i64/u32/u64).',
  ctz: 'Count trailing zeros (i32/i64/u32/u64).',
  popcnt: 'Population count - number of 1 bits (i32/i64/u32/u64).',
  mul_hi: 'High 64 bits of the 128-bit product of two u64.',
};

// What each primitive type is
export const TYPE_DOCS: Record<string, string> = {
  i8: '8-bit signed integer',
  u8: '8-bit unsigned integer',
  i16: '16-bit signed integer',
  u16: '16-bit unsigned integer',
  i32: '32-bit signed integer',
  u32: '32-bit unsigned integer',
  i64: '64-bit signed integer',
  u64: '64-bit unsigned integer',
  i128: '128-bit signed integer (SIMD v128)',
  u128: '128-bit unsigned integer (SIMD v128)',
  i256: '256-bit signed integer (2x SIMD v128)',
  u256: '256-bit unsigned integer (2x SIMD v128)',
  i512: '512-bit signed integer (4x SIMD v128)',
  u512: '512-bit unsigned integer (4x SIMD v128)',
  f32: '32-bit floating point',
  f64: '64-bit floating point',
};
