const wasm = await Bun.file("./samples/xxh64.wasm").arrayBuffer()
const module = await WebAssembly.compile(wasm)
const instance = await WebAssembly.instantiate(module)
/** @type {{mem:WebAssembly.Memory,xxh64:(ptr:number,len:number,seed:bigint)=>bigint}} */
const { mem, xxh64: hash } = instance.exports

/**
 * @param {string} input 
 * @param {bigint} [seed] 
 * @returns {bigint}
 */
export function xxh64(input, seed = 0n) {
  // Encode the strings as utf8
  const inputArray = new Uint8Array(new TextEncoder().encode(input))
  // And copy it into the buffer
  new Uint8Array(mem.buffer).set(inputArray, 0)
  // Call the function
  const res = hash(0, inputArray.length, seed)
  // Turn the result into an unsigned integer
  return res < 0n ? res + 0x10000000000000000n : res
}
