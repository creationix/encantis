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
