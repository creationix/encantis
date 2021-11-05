import { inspect } from 'util'
import { parseType } from './parse-type.js'
import { skipEmpty } from "./parse-helpers.js"

const tests = [
    `u32`, `i32`, `u64`, `i64`, `f32`, `f64`,
    // `i8`, `u8`, `i16`, `u16`, `void`,
    `(i32 i32)`, `(i32)`, `()`,
    `<<u8>>`, `<(i32 i32)>`,
    `[[u8]]`, `[(i32 i32)]`,
    `*i64`, `#u8`, `?i32`, `*#u8`,
    `Point`, `*Point`, `(Color Size)`,
    `(i32 i32) -> i32`,
    `i32 -> u32 -> f32`,
    `(i32 -> u32) -> f32`,
    `(*i32) -> u32`,
    `*(i32 -> u32)`,
    `*i32 -> u32`,
    `i32 -> i32 -> i32`
]

for (const test of tests) {
    let { type, expected, pos } = parseType(test, 0)
    pos = skipEmpty(test, pos)
    console.log(inspect([test, type], false, null, true))
    if (!type) {
        throw new SyntaxError("Expected " + expected + " at " + pos + ".\n    `" + test + "`\n" + " ".repeat(pos + 5) + "^")
    }
    if (pos !== test.length) {
        throw new Error("Unexpected extra input at " + pos + pos + ".\n    `" + test + "`\n" + " ".repeat(pos + 5) + "^")
    }
}
