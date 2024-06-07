const module = await WebAssembly.compileStreaming(fetch("xxh64.wasm"))
const instance = await WebAssembly.instantiate(module)
/** @type {{mem:WebAssembly.Memory,xxh64:(ptr:number,len:number,seed:bigint)=>bigint}} */
const { mem, xxh64: hash } = instance.exports

/**
 * 
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
  return res < 0 ? res + 0x10000000000000000n : res
}

console.log(xxh64("hello world"))
console.log(xxh64(""))
console.log(xxh64("", 123n))
