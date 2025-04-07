import { readFileSync } from "node:fs"

/**
 * memory 1
 * @type WebAssembly.Memory
 */
let memory

const imports = {
  sys: {
    /**
     * sys.print(msg:[u8])
     * @param {number} ptr 
     * @param {number} len 
     */
    print(ptr, len) {
      console.log(new TextDecoder("utf-8").decode(new Uint8Array(memory.buffer, ptr, len)))
    }
  }
}

const { instance: { exports } } = await WebAssembly.instantiate(readFileSync("greet.wasm"), imports)
memory = exports.memory
/**
 * func malloc(size:i32) -> *u8
 * @type {(size:number)=>number} 
 */
const malloc = exports.malloc
/**
 * func (msg:[u8])
 * @type {(msg_ptr:number,msg_len:number)=>void}
 */
const greet = exports.greet

// Create a string to pass to the WebAssembly function
const message = wasmString("World!")

// Call greet with the slice
greet(message.byteOffset, message.byteLength);

/**
 * Allocates a string in the WebAssembly memory and copies the string into it.
 * The string is allocated using the malloc function.
 * @param {string} str 
 * @returns {Uint8Array}
 */
function wasmString(str) {
  const encoded = new TextEncoder().encode(str)
  // Allocate memory for the string using the exported malloc.
  const messsage = new Uint8Array(memory.buffer, malloc(encoded.byteLength), encoded.byteLength);
  // Copy the string into wasm memory.
  messsage.set(encoded)
  return messsage
}
