#!/usr/bin/env node
import { readFileSync } from "fs"
import { inspect } from "util"

const BUILTIN_TYPE_PATTERN = /^(u8|i8|u16|i16|u32|i32|u64|i64)\b/
const NAME_PATTERN = /^[a-z][a-z0-9_-]*/i
const HEX_NUMBER_PATTERN = /^0x[0-9a-f]+/i
const OCT_NUMBER_PATTERN = /^0o[0-7]+/i
const BIN_NUMBER_PATTERN = /^0b[0-1]+/i
const DEC_NUMBER_PATTERN = /^[0-9]+/i

const STRING_PATTERN = /^"[^"]*"/

const PUNCTUATION = toPattern(
    "( ) [ ] : = -> . , ; .* " +
    "+ - * / % " +
    "+= -= *= /= %= " +
    "<= >= == != < > " +
    "&& || ^^ ! " +
    "<<< >>> << >> | & ^ " +
    "<<<= >>>= <<= >>= |= &= ^= ")

const KEYWORDS = toPattern(
    "and or xor not " +
    "export func memory global local forever return when end " +
    "void as if then elif else while do block loop br", "(?![a-zA-Z0-9_-])"
)

/** @type {[RegExp,boolean|string][]} */
const patterns = [
    [/^[ \t\r\n\b]+/, false],
    [/^\-\-[^\n]*/, false],
    [STRING_PATTERN, "STRING"],
    [BUILTIN_TYPE_PATTERN, "BUILTINTYPE"],
    [KEYWORDS, true],
    [PUNCTUATION, true],
    [NAME_PATTERN, 'NAME'],
    [HEX_NUMBER_PATTERN, 'NUMBER'],
    [OCT_NUMBER_PATTERN, 'NUMBER'],
    [BIN_NUMBER_PATTERN, 'NUMBER'],
    [DEC_NUMBER_PATTERN, 'NUMBER'],
]

function Type(tokens, offset) {
    return Type.parser(tokens, offset)
}
Type.parser = choice(
    P(liven("BUILTINTYPE"), T => ({ builtinOffset: T.offset })),
    P(sequence("(", star(Type), ")"), T => T),
    P(sequence("[", Type, "]"), T => ({ slice: T[1] })),
    P(sequence("*", Type), T => ({ pointer: T[1] })),
)

function typable(parser) {
    return P(sequence(parser, optional(sequence(":", Type))), T => (
        T[1] ? { ...T[0], type: T[1][1] } : T[0]
    ))
}

function binop(left, op, right) {
    return P(sequence(left, star(sequence(op, right))), ([L, S]) =>
        S.reduce((p, [a, b]) => ([a.token || a, p, b]), L)
    )
}

function prefix(op, lower) {
    return P(sequence(star(op), lower), ([S, L]) =>
        S.reduce((p, c) => ([c.token || c, p]), L)
    )
}

function postfix(lower, op) {
    return P(sequence(lower, star(op)), ([L, S]) =>
        S.reduce((p, c) => ([c.token || c, p]), L)
    )
}

const Name = typable(P("NAME", T => ({ nameOffset: T.offset })))
const Number = typable(P("NUMBER", T => ({ numberOffset: T.offset })))

const Call = P(sequence("(", star(Expression, ","), ")"), T => ({
    call: T[1],
}))


const Index = choice(
    P(sequence("[", Expression, "]"), T => ({
        index: T[1],
    })),
    P(sequence(".", choice(Name, Number)), T => ({
        index: T[1],
    }))
)
const Dereference = ".*"

const E7 = choice(
    Number,
    Name,
    P(sequence("(", Expression, ")"), T => T[1]),
)
const E6 = postfix(E7, choice(Call, Index, Dereference))
const E5 = prefix(choice("-", "!", "~"), E6)
const E4 = binop(E5, choice("as"), Type)
const E3 = binop(E4, choice("<<<", ">>>", "<<", ">>", "*", "/", "%", "&"), E4)
const E2 = binop(E3, choice("|", "+", "-"), E3)
const E1 = binop(E2, choice("<=", ">=", "==", "!=", "<", ">"), E2)

function Expression(tokens, offset) {
    return E1(tokens, offset)
}

const IfThenElse = P(sequence(
    "if", Expression,
    "then", star(Statement),
    star(sequence(
        "elif", Expression,
        "then", star(Statement)
    )),
    optional(sequence(
        "else", star(Statement)
    )),
    "end"
), T => {
    const O = {
        ifs: [
            T[1], T[3]
        ].concat(T[4].map(TT => [TT[1], TT[3]]).flat())
    }
    if (T[5]) O.else = T[5][1]
    return O
})

const Assignment = P(sequence(
    postfix("NAME", choice(
        Call,
        Index,
        Dereference,
    )),
    choice(
        "=",
        "+=", "-=", "*=", "/=", "%=",
        "<<=", ">>=", "|=", "&=", "^=",
        "<<<=", ">>>=",
    ),
    Expression
), T => ({
    assignment: T[1].token,
    target: T[0],
    value: T[2],
}))

const LocalVariable = P(sequence(
    "local", Name, optional(sequence("=", Expression))
), T => {
    const O = { nameOffset: T[1].nameOffset }
    if (T[1].type) O.type = T[1].type
    if (T[2]) O.value = T[2][1]
    return { local: O }
})

const Loop = P(sequence(
    choice("forever", "loop", "block"),
    star(Statement, ";"),
    "end"
), T => ({
    [T[0].token]: T[1],
}))

const While = P(sequence(
    "while", Expression, "do",
    star(Statement, ";"),
    "end"
), T => ({ while: [T[1], T[3]] }))

const When = P(sequence(
    choice("when", "unless"),
    Expression
), T => ({ [T[0].token]: T[1] }))


const Return = P(sequence(
    choice("return", "br"), optional(Expression),
    optional(When)
), T => {
    let O = {}
    if (T[1]) O.value = T[1]
    if (T[2]) O = { ...O, ...T[2] }
    return { [T[0].token]: O }
})

function Statement(tokens, offset) {
    return Statement.parser(tokens, offset)
}
Statement.parser = choice(
    Expression,
    LocalVariable,
    Assignment,
    Loop,
    While,
    Return,
    IfThenElse,
)

const MemoryDeclaration = P(sequence(
    "memory", "NAME", "NUMBER"
), T => ({
    memory: {
        nameOffset: T[1].offset,
        numberOffset: T[2].offset,
    }
}))

const GlobalVariable = P(sequence(
    "global", Name, optional(sequence("=", Expression))
), T => {
    const O = T[1]
    if (T[1].type) O.type = T[1].type
    if (T[2]) O.value = T[2][1]
    return { global: O }
})

const NamedTuple = P(sequence(
    "(", star(Name, ","), ")"
), T => T[1])

const Function = P(sequence(
    "func", optional("NAME"), NamedTuple,
    optional(sequence("->", choice(NamedTuple, Type))),
    star(Statement, ";"),
    "end"
), T => {
    const O = {}
    if (T[1]) O.nameOffset = T[1].offset
    if (T[2].length) O.args = T[2]
    if (T[3]) O.ret = T[3][1]
    if (T[4].length) O.body = T[4]
    return { func: O }
})

const Export = P(sequence(
    "export", "STRING", choice(
        GlobalVariable,
        Function
    )
), T => ({ exportOffset: T[1].offset, ...T[2] }))

const Program = star(choice(
    MemoryDeclaration,
    Function,
    GlobalVariable,
    Export
), ";")

function tokenize(source) {
    const tokens = []
    let offset = 0
    outer: while (offset < source.length) {
        const subsource = source.substr(offset)
        for (const [regex, action] of patterns) {
            const m = regex.exec(subsource)
            if (m) {
                offset += m[0].length
                if (action) {
                    /** @type {string} */
                    const token = action === true ? m[0] : action
                    tokens.push({ token, offset })
                }
                continue outer
            }
        }
        throw new SyntaxError(`while tokenizing @(${offset}) ${JSON.stringify(source.substr(offset, 10))}`)
    }
    return tokens
}

/**
 * @param {{token:string,offset:number}[]} tokens
 */
function parse(tokens, Start) {
    const match = Start(tokens, 0)
    return match && match[1]
}

function P(parser, fn) {
    parser = liven(parser)
    if (typeof fn !== "function") throw new TypeError("fn must be function")
    return (tokens, offset) => {
        const match = parser(tokens, offset)
        if (!match) return false
        const [newoffset, value] = match
        return [newoffset, fn(value, newoffset)]
    }
}

// Choose the parser with the longest match.
function choice(...items) {
    const parsers = items.map(liven)
    return function (tokens, offset) {
        var longest = 0
        var result = null
        for (let i = 0, l = parsers.length; i < l; i++) {
            const match = parsers[i](tokens, offset)
            if (!match) continue
            const [length, node] = match
            if (length <= longest) continue
            longest = length
            result = node
        }
        return result && [longest, result]
    }
}

// Make a match 0 or 1 times.
function optional(parser) {
    parser = liven(parser)
    if (typeof parser !== "function") throw new TypeError("Parser must be function")
    return (tokens, offset) => parser(tokens, offset) || [offset]
}

// Make a match 0 or more times
function star(parser, optsep) {
    if (optsep) {
        parser = P(sequence(parser, optional(liven(optsep))), T => (T[0]))
    }

    return (tokens, offset) => {
        const results = []
        let match
        while ((match = parser(tokens, offset))) {
            const [newoffset, value] = match
            if (newoffset > offset) {
                results.push(value)
                offset = newoffset
            }
        }
        return [offset, results]
    }
}

// Make a match 1 or more times
function plus(parser, optsep) {
    parser = star(parser, optsep)
    return (tokens, offset) => {
        const match = parser(tokens, offset)
        return match.length ? match : false
    }
}

function sequence(...items) {
    const parsers = items.map(liven)
    return (tokens, offset) => {
        const list = []
        for (let i = 0, l = parsers.length; i < l; i++) {
            const parser = parsers[i]
            const match = parser(tokens, offset)
            if (!match) return false
            const [newOffset, value] = match
            list.push(value)
            offset = newOffset
        }
        return [offset, list]
    }
}

// Turn primitives into name matchers.
function liven(item) {
    if (typeof item === "function") return item
    return (tokens, offset) => {
        const token = tokens[offset]
        return (token && token.token === item) ? [offset + 1, token] : false
    }
}

///////////////////////////////////////////////////////////////////////////////


const tests = [
    ["[u8]", Type],
    ["trieOffset: u32", Name],
    ["trieOffset", Name],
    ["0", Expression],
    ["local trieOffset: u32 = 0", LocalVariable],
    ["local trieOffset = 0", LocalVariable],
    ["local trieOffset: u32", LocalVariable],
    ["local trieOffset", LocalVariable],
    ["func nop() forever a=1 b=2 end end", Function],
    ["func add(a b) end", Function],
    ["func add(a:u32 b:u32) end", Function],
    ["func add(a b) -> u32 end", Function],
    ["export \"walk\" func a() end", Program],
    ["1 << 2", Expression],
    ["1 << 2 | 5", Expression],
    ["1 << ((key >> bitOffset) & 0x7f)", Expression],
    ["(1 + 2)", Expression],
    ["(bitOffset + 7) % 64", Expression],
    ["bitOffset = (bitOffset + 7) % 64", Assignment],
    ['local index: u64 = 1 << ((key >> bitOffset) & 0x7f)', Statement],
    ['bitOffset = (bitOffset + 7) % 64', Statement],
    ['local bitfield: u64 = trie[trieOffset]', Statement],
    ['trieOffset += 1', Statement],
    ['return -1 when (bitfield & index) == 0)', Statement],
    ['trieOffset += popcount(bitfield & (index - 1))', Statement],
    ['return -2 when trieOffset >= trie.len', Statement],
    ['local pointer: u64 = trie[trieOffset]', Statement],
    ['return pointer when (pointer & 0x8000000000000000) == 0', Statement],
    ['trieOffset += pointer & 0x7fffffffffffffff', Statement],
    ['return -2 when trieOffset >= trie.len', Statement],
    ['func no() end', Program],
    ['2654435761:u32', Number],
    ['prime32-1', Expression],
    ['end-of-line', Expression],
    ['global prime32-1 = 2654435761:u32', Program],
    ['memory mem 1', Program],
    ['func (ptr: *u32, len: u32, seed: u32) -> u32 end', Program],
    ['export "empty" func () end', Program],
    ['v1 = round32(v1, ptr.*)', Statement],
    ['if 1 then 2 elif 3 then 4 else 5 end', Statement],
    ['while ptr + 4 <= last do true end', Statement],
    ['foo.bar()', Expression],
    ['1 + 2 + 3', Expression],
    ['-Lib.calc().more', Expression],
    ['a.b + c.d', Expression],
    ['a * b + c * d', Expression],
    ['h32 += (ptr as u8).* & prime32-5', Statement],
    ['seed += value * prime32-2', Statement],
    ['seed <<<= 13', Statement],
    ['seed *= prime32-1', Statement],
    ['return seed', Statement],
    ['func (ptr: *u64, len: u32) end', Program],
    ['ptr.* = xxh64(ptr + 8, len, ptr.*)', Assignment],
    ['ptr:*u8.*', Expression],
]

if (!tests.length) {
    const script = process.argv[2]
    if (script) {
        tests.push([readFileSync(script, 'utf8'), Program])
    } else {
        // console.log(`Usage:\n\t${process.argv[1]} path/to/script.ents\n`)
        // process.exit(-1);
    }
}


for (const [code, Start] of tests) {
    console.log("\n" + inspect(code, { colors: true }))
    const tokens = tokenize(code)
    console.log(tokens)
    const ast = parse(tokens, Start)
    console.log(inspect(ast, { colors: true, depth: 10 }))
    if (!ast) throw new Error("Failed to parse")
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // $& means the whole matched string
}

function toPattern(words, extra = "") {
    words = words
        .trim()
        .split(' ')
        .sort((a, b) => b.length - a.length)
        .map(s => escapeRegExp(s))
        .join('|')
    const regexp = new RegExp("^(" + words + ")" + extra)
    console.log(regexp)
    return regexp
}
