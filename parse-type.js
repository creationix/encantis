// grammar Type;
const tests = [
    `u32`, `i32`, `u64`, `i64`, `f32`, `f64`,
    `i8`, `u8`, `i16`, `u16`, `void`,
    `(i32 i32)`, `(i32)`, `()`,
    `<u8>`, `<(i32 i32)>`,
    `*i64`, `#u8`, `?i32`,
    `Point`, `*Point`, `(Color Size)`,
    `(i32 i32) -> i32`
]

console.log(tests)
console.log(tests.map(type))


const builtinType = token(/[iuf](32|64)(?![A-Za-z0-9_-])/)

const smallType = token(/[iu](8|16)(?![A-Za-z0-9_-])/)

const extendedType = union(type, smallType)

const tupleType = match('(', tag('tuple', star(type)), ')')

const sliceType = match('<', tag('slice', type), '>')

const pointerType = match('*', tag('pointer', type))

const arrayType = match('#', tag('array', type))

const maybeType = match('?', tag('maybe', type))

const functionType = tag('function', match(type, '->', type))

const userType = token(/[A-Z][A-Za-z0-9_-]*/)

function type(code, pos) {
    return or(
        builtinType,
        tupleType,
        sliceType,
        pointerType,
        arrayType,
        maybeType,
        functionType,
        userType,
    )
}

function star(entry) {
    return function (code, pos) {
        const list = []
        let position = pos
        for (; ;) {
            position = skipEmpty(code, position)
            const { type, error, pos } = entry(code, position)
            if (error) return { type: list }
            position = pos
            list.push({})
        }
    }
}

function skipEmpty(code, pos) {
    while (code[pos] === ' ') pos++;
    return pos
}

function tag(name, entry) {
    return function (code, pos) {
        const { type, error, pos: newPos } = entry(code, pos)
        if (error) return { error, pos }
        return {
            type: { [tag]: type }, pos
        }
    }
}

function union(list) {
    return function (code, pos) {
        return or(list, code, pos)
    }
}

function or(list, code, pos) {
    const position = pos
    let longError = null
    let longPos = -1
    for (const entry of list) {
        const { type, error, pos } = entry(code, position)
        if (error && (pos > longPos)) {
            longError = error
            longPos = pos
            continue
        }
        return { type, pos }
    }
    return { error: longError, pos: longPos }
}
