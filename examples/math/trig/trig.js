const wasm = await Bun.file(
  new URL('./trig.wasm', import.meta.url),
).arrayBuffer()
const module = await WebAssembly.compile(wasm)
const instance = await WebAssembly.instantiate(module, {
  math: {
    sin: Math.sin,
    cos: Math.cos,
    atan2: Math.atan2,
  },
  sys: {
    /**
     * @param {number} ap string a pointer
     * @param {number} al string a length
     * @param {number} f1 float value 1
     * @param {number} bp string b pointer
     * @param {number} bl string b length
     * @param {number} f2 float value 2
     * @param {number} cp string c pointer
     * @param {number} cl string c length
     */
    'print-f64-pair': (ap, al, f1, bp, bl, f2, cp, cl) => {
      const memory = new Uint8Array(instance.exports.memory.buffer)
      const a = new TextDecoder().decode(memory.slice(ap, ap + al))
      const b = new TextDecoder().decode(memory.slice(bp, bp + bl))
      const c = new TextDecoder().decode(memory.slice(cp, cp + cl))
      console.log(`${a}: ${f1}, ${b}: ${f2}, ${c}`)
    },
  },
})
/** @type {{to_polar:(x:number,y:number)=>[number,number],from_polar:(d:number,a:number)=>[number,number]}} */
const { to_polar, from_polar } = instance.exports

/**
 * Convert cartesian coordinates to polar
 * @param {number} x
 * @param {number} y
 * @returns {[number, number]} [distance, angle]
 */
export const toPolar = to_polar

/**
 * Convert polar coordinates to cartesian
 * @param {number} d - distance
 * @param {number} a - angle
 * @returns {[number, number]} [x, y]
 */
export const fromPolar = from_polar
