const wasm = await Bun.file(new URL("./xxh32.wasm", import.meta.url)).arrayBuffer()
const module = await WebAssembly.compile(wasm)
const instance = await WebAssembly.instantiate(module)
/** @type {{mem:WebAssembly.Memory,xxh32:(ptr:number,len:number,seed:number)=>number}} */
const { mem, xxh32: hash } = instance.exports

/**
 * @param {string} input 
 * @param {number} [seed] 
 * @returns {number}
 */
export function xxh32(input, seed = 0) {
  // Encode the strings as utf8
  const inputArray = new Uint8Array(new TextEncoder().encode(input))
  // And copy it into the buffer
  new Uint8Array(mem.buffer).set(inputArray, 0)
  // Call the function and make the result unsigned
  return hash(0, inputArray.length, seed) >>> 0
}
