
import { token, union, match, star, tag, or } from "./parse-helpers.js"

const builtinType = token(/^[iuf](32|64)(?![A-Za-z0-9_-])/, 'builtin')

const smallType = token(/^[iu](8|16)(?![A-Za-z0-9_-])/)

const extendedType = union(parseType, smallType)

const tupleType = match('(', star(parseType, true), ')')

const sliceType = match('<', tag('slice', extendedType), '>')

const terminatedType = match('[', tag('term', extendedType), ']')

const pointerType = match('*', tag('pointer', extendedType))

const arrayType = match('#', tag('array', extendedType))

const maybeType = match('?', tag('maybe', parseType))

const userType = token(/^[A-Z][A-Za-z0-9_-]*/, 'usertype')

const baseType = union(
    builtinType,
    tupleType,
    sliceType,
    terminatedType,
    pointerType,
    arrayType,
    maybeType,
    userType,
)

const functionType = tag('function', match(baseType, '->', parseType))

export function parseType(code, pos) {
    // console.log("TYPE", code, pos)
    return or([
        functionType,
        baseType,
    ], code, pos)
}



