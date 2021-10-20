const tests = [
    `u32`, `i32`, `u64`, `i64`, `f32`, `f64`,
    // `i8`, `u8`, `i16`, `u16`, `void`,
    `(i32 i32)`, `(i32)`, `()`,
    `<u8>`, `<(i32 i32)>`,
    `*i64`, `#u8`, `?i32`,
    `Point`, `*Point`, `(Color Size)`,
    `(i32 i32) -> i32`
]

const builtinType = token(/^[iuf](32|64)(?![A-Za-z0-9_-])/, 'builtin')

const smallType = token(/^[iu](8|16)(?![A-Za-z0-9_-])/)

const extendedType = union(parseType, smallType)

const tupleType = match('(', star(parseType), ')')

const sliceType = match('<', tag('slice', extendedType), '>')

const pointerType = match('*', tag('pointer', extendedType))

const arrayType = match('#', tag('array', extendedType))

const maybeType = match('?', tag('maybe', parseType))

const functionType = tag('function', match(parseType, '->', parseType))

const userType = token(/^[A-Z][A-Za-z0-9_-]*/, 'usertype')

function parseType(code, pos) {
    // console.log("TYPE", code, pos)
    return or([
        builtinType,
        tupleType,
        sliceType,
        pointerType,
        arrayType,
        maybeType,
        // functionType,
        userType,
    ], code, pos)
}

function match(...parts) {
    return function (code, pos) {
        // console.log("MATCH", code, pos)
        let position = pos
        let collected = []
        for (const part of parts) {
            position = skipEmpty(code, position)
            // console.log([typeof part, part, position])
            if (typeof part === 'string') {
                // console.log([code.substr(position, part.length), part])
                if (code.substr(position, part.length) !== part) {
                    return { expected: part, pos: position }
                }
                position += part.length
            } else if (typeof part === 'function') {
                const { type, error, pos } = part(code, position)
                if (!type) {
                    return { error, pos }
                }
                collected.push(type)
                position = pos
            } else {
                throw new TypeError("Unknown match part: " + part)
            }
        }
        const type = collected.length === 1 ? collected[0] : collected
        pos = position
        return { type, pos }
    }
}

/**
 * 
 * @param {RegExp} regexp 
 * @returns 
 */
function token(regexp, name) {
    return function (code, pos) {
        // console.log("TOKEN", code, pos, regexp)
        // regexp.lastIndex = pos
        // const match = regexp.exec(code)
        const match = code.substr(pos).match(regexp)
        if (!match) return { expected: name || regexp, pos }
        const type = match[0]
        pos += type.length
        return { type, pos }
    }
}

function star(entry) {
    return function (code, pos) {
        // console.log("STAR", code, pos)
        const list = []
        let position = pos
        for (; ;) {
            position = skipEmpty(code, position)
            const { type, expected, pos } = entry(code, position)
            if (!type) return { type: list, pos }
            position = pos
            list.push(type)
        }
    }
}

/**
 * 
 * @param {string} code 
 * @param {number} pos 
 * @returns {number} new position
 */
function skipEmpty(code, pos) {
    while (code[pos] === ' ') pos++;
    return pos
}

function tag(name, entry) {
    return function (code, pos) {
        // console.log("TAG", code, pos)
        const { type, expected, pos: newPos } = entry(code, pos)
        pos = newPos
        if (!type) return { expected, pos }
        return {
            type: { [name]: type }, pos
        }
    }
}

function union(...list) {
    return function (code, pos) {
        return or(list, code, pos)
    }
}

function or(list, code, pos) {
    // console.log("OR", code, pos)
    const position = pos
    let longExpected
    let longPos = -1
    for (const entry of list) {
        // console.log("OR-entry", entry)
        const { type, expected, pos } = entry(code, position)
        if (type) {
            return { type, pos }
        }
        if (expected && pos >= longPos) {
            if (longExpected && pos === longPos) {
                longExpected += " or " + expected
            } else {
                longExpected = expected
            }
            longPos = pos
        }
        continue
    }
    return { expected: longExpected, pos: longPos }
}


for (const test of tests) {
    let { type, expected, pos } = parseType(test, 0)
    pos = skipEmpty(test, pos)
    console.log(test, "->", type)
    if (!type) {
        throw new SyntaxError("Expected " + expected + " at " + pos + ".\n    `" + test + "`\n" + " ".repeat(pos + 5) + "^")
    }
    if (pos !== test.length) {
        throw new Error("Unexpected extra input at " + pos + pos + ".\n    `" + test + "`\n" + " ".repeat(pos + 5) + "^")
    }
}
