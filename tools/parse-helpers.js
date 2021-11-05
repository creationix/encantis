export function match(...parts) {
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
export function token(regexp, name) {
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

export function star(entry, flatten = false) {
    return function (code, pos) {
        // console.log("STAR", code, pos)
        const list = []
        let position = pos
        for (; ;) {
            position = skipEmpty(code, position)
            const { type, expected, pos } = entry(code, position)
            if (!type) return { type: (flatten && list.length === 1) ? list[0] : list, pos }
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
export function skipEmpty(code, pos) {
    while (code[pos] === ' ') pos++;
    return pos
}

export function tag(name, entry) {
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

export function union(...list) {
    return function (code, pos) {
        return or(list, code, pos)
    }
}

export function or(list, code, pos) {
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
