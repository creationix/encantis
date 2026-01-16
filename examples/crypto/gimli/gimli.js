const wasm = await Bun.file(
  new URL('./gimli.wasm', import.meta.url),
).arrayBuffer()
const module = await WebAssembly.compile(wasm)
const instance = await WebAssembly.instantiate(module)
/** @type {{mem:WebAssembly.Memory, gimli:(state:number)=>void, gimli_hash:(input:number,len:number,output:number)=>void}} */
const { mem, gimli: permute, gimli_hash: hash } = instance.exports

/**
 * Apply Gimli permutation to a 384-bit state (12 x u32 words)
 * @param {Uint32Array} state - 12-element Uint32Array
 * @returns {Uint32Array} - permuted state
 */
export function gimli(state) {
  if (state.length !== 12) {
    throw new Error('Gimli state must be 12 x 32-bit words')
  }
  const view = new Uint32Array(mem.buffer, 0, 12)
  view.set(state)
  permute(0)
  return new Uint32Array(view)
}

/**
 * Compute Gimli-Hash of input string
 * @param {string|Uint8Array} input
 * @returns {Uint8Array} - 32-byte hash
 */
export function gimliHash(input) {
  const inputArray =
    typeof input === 'string'
      ? new Uint8Array(new TextEncoder().encode(input))
      : input

  const inputOffset = 64
  const outputOffset = 128

  // Copy input to memory
  new Uint8Array(mem.buffer, inputOffset, inputArray.length).set(inputArray)

  // Call the hash function
  hash(inputOffset, inputArray.length, outputOffset)

  // Copy output from memory
  return new Uint8Array(mem.buffer.slice(outputOffset, outputOffset + 32))
}

/**
 * Convert hash to hex string
 * @param {Uint8Array} hash
 * @returns {string}
 */
export function toHex(hash) {
  return Array.from(hash)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
