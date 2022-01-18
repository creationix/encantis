#!/usr/bin/env node
import { readFileSync } from "fs";
import { inspect } from "util"

const BUILTIN_TYPE_PATTERN = /^(u8|i8|u16|i16|u32|i32|u64|i64)\b/;
const NAME_PATTERN = /^[a-z][a-z0-9_]*/i;
const HEX_NUMBER_PATTERN = /^0x[0-9a-f]+/i;
const OCT_NUMBER_PATTERN = /^0o[0-7]+/i;
const BIN_NUMBER_PATTERN = /^0b[0-1]+/i;
const DEC_NUMBER_PATTERN = /^[0-9]+/i;

const STRING_PATTERN = /^"[^"]*"/;

const PUNCTUATION = toPattern(
    "( ) [ ] : = -> . , ; " +
    "+ - * / % " +
    "+= -= *= /= %= " +
    "<= >= == != < > " +
    "<< >> | & ^ " +
    "<<= >>= |= &= ^= ")

const KEYWORDS = toPattern(
    "export func local forever return when end", "\\b"
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
];

function Type(tokens, offset) {
    return Type.parser(tokens, offset);
}
Type.parser = choice(
    P(liven("BUILTINTYPE"), T => ({ builtin: true, offset: T.offset })),
    P(sequence("[", Type, "]"), T => ({ slice: T[1], offset: T[0].offset })),
);


const E1 = choice(
    P(liven("NUMBER"), T => ({ numberOffset: T.offset })),
    P(sequence("-", Expression), T => ({ neg: T[1] })),
    P(sequence("NAME", optional(choice(
        P(sequence("(", star(Expression, ","), ")"), T => ({
            call: T[1],
        })),
        P(sequence("[", Expression, "]"), T => ({
            index: T[1],
        })),
        P(sequence(".", "NAME"), T => ({
            index: { nameOffset: T[1].offset },
        }))
    ))), T => (
        T[1] ? (
            T[1].call ? {
                identOffset: T[0].offset,
                call: T[1].call,
            } : T[1].index ? {
                identOffset: T[0].offset,
                index: T[1].index,
            } : T[1]
        ) : {
            identOffset: T[0].offset
        }
    )),
    P(sequence("(", Expression, ")"), T => T[1]),
)

function binop(lower, op, top) {
    return P(sequence(lower, optional(sequence(op, top))), T => (
        T[1] ? {
            binop: T[1][0].token,
            left: T[0],
            right: T[1][1],
        } : T[0]
    ))
}

const E2 = binop(E1, choice("<<", ">>", "*", "/", "%"), Expression)
const E3 = binop(E2, choice("|", "&", "+", "-"), Expression)
const E4 = binop(E3, choice("<=", ">=", "==", "!=", "<", ">"), Expression)

function Expression(tokens, offset) {
    return E4(tokens, offset);
}

// Declaration = {nameOffset:number,type?:Type}
const Declaration = P(sequence(
    "NAME",
    optional(sequence(":", Type))
), T => ({
    nameOffset: T[0].offset,
    type: T[1] && T[1][1]
}));

const Assignment = P(sequence(
    "NAME", choice(
        "=",
        "+=", "-=", "*=", "/=", "%=",
        "<<=", ">>=", "|=", "&=", "^= "
    ), Expression
), T => ({
    assignment: T[1].token,
    nameOffset: T[0].offset,
    value: T[2],
    offset: T[1].offset,
}))

// LocalVariable = {local:Token,type?:Type,value?:Expression}
const LocalVariable = P(sequence(
    "local", Declaration, optional(sequence("=", Expression))
), T => ({
    local: {
        nameOffset: T[1].nameOffset,
        type: T[1].type,
        value: T[2] && T[2][1],
    },
    offset: T[0].offset
}))

const Forever = P(sequence(
    "forever",
    star(Statement, ";"),
    "end"
), T => ({
    forever: T[1],
    offset: T[0].offset
}))

const Return = P(sequence(
    "return", Expression,
    optional(sequence(
        choice('when', 'unless'),
        Expression
    ))
), T => (
    T[2] ? {
        return: T[1],
        [T[2][0].token]: T[2][1]
    } : { return: T[0] }
))

function Statement(tokens, offset) {
    return Statement.parser(tokens, offset)
}
Statement.parser = choice(
    LocalVariable,
    Assignment,
    Forever,
    Return,
)


const FunctionDeclaration = P(sequence(
    optional(sequence("export", "STRING")),
    "func", "NAME", "(", star(Declaration, ","), ")",
    optional(sequence("->", Type)),
    star(Statement, ";"),
    "end"
), T => ({
    func: {
        export: T[0] && T[0][1],
        nameOffset: T[2].offset,
        args: T[4],
        ret: T[6] && T[6][1],
        body: T[7]
    },
    offset: T[1].offset,
}));

const Program = star(choice(
    FunctionDeclaration
), ";");

function tokenize(source) {
    const tokens = [];
    let offset = 0;
    outer: while (offset < source.length) {
        const subsource = source.substr(offset);
        for (const [regex, action] of patterns) {
            const m = regex.exec(subsource);
            if (m) {
                offset += m[0].length;
                if (action) {
                    /** @type {string} */
                    const token = action === true ? m[0] : action;
                    tokens.push({ token, offset });
                }
                continue outer;
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
    const match = Start(tokens, 0);
    return match && match[1];
}

function P(parser, fn) {
    if (typeof fn !== "function") throw new TypeError("fn must be function")
    return (tokens, offset) => {
        const match = parser(tokens, offset);
        if (!match) return false;
        const [newoffset, value] = match
        return [newoffset, fn(value, newoffset)];
    };
}

// Choose the parser with the longest match.
function choice(...items) {
    const parsers = items.map(liven);
    return function (tokens, offset) {
        var longest = 0;
        var result = null;
        for (let i = 0, l = parsers.length; i < l; i++) {
            const match = parsers[i](tokens, offset);
            if (!match) continue;
            const [length, node] = match;
            if (length <= longest) continue;
            longest = length;
            result = node;
        }
        return result && [longest, result];
    }
}

// Make a match 0 or 1 times.
function optional(parser) {
    parser = liven(parser)
    if (typeof parser !== "function") throw new TypeError("Parser must be function")
    return (tokens, offset) => parser(tokens, offset) || [offset];
}

// Make a match 0 or more times
function star(parser, optsep) {
    if (optsep) {
        parser = P(sequence(parser, optional(liven(optsep))), T => (T[0]))
    }

    return (tokens, offset) => {
        const results = [];
        let match
        while ((match = parser(tokens, offset))) {
            const [newoffset, value] = match;
            if (newoffset > offset) {
                results.push(value);
                offset = newoffset;
            }
        }
        return [offset, results];
    }
}

// Make a match 1 or more times
function plus(parser, optsep) {
    parser = star(parser, optsep);
    return (tokens, offset) => {
        const match = parser(tokens, offset);
        return match.length ? match : false;
    };
}

function sequence(...items) {
    const parsers = items.map(liven);
    return (tokens, offset) => {
        const list = [];
        for (let i = 0, l = parsers.length; i < l; i++) {
            const parser = parsers[i];
            const match = parser(tokens, offset);
            if (!match) return false;
            const [newOffset, value] = match;
            list.push(value);
            offset = newOffset;
        }
        return [offset, list];
    }
}

// Turn primitives into name matchers.
function liven(item) {
    if (typeof item === "function") return item;
    return (tokens, offset) => {
        const token = tokens[offset];
        return (token && token.token === item) ? [offset + 1, token] : false;
    };
}

///////////////////////////////////////////////////////////////////////////////


const tests = [
    // ["[u8]", Type],
    // ["trieOffset: u32", Declaration],
    // ["trieOffset", Declaration],
    // ["0", Expression],
    // ["local trieOffset: u32 = 0", LocalVariable],
    // ["local trieOffset = 0", LocalVariable],
    // ["local trieOffset: u32", LocalVariable],
    // ["local trieOffset", LocalVariable],
    // ["func nop() forever a=1 b=2 end end", FunctionDeclaration],
    // ["func add(a b) end", FunctionDeclaration],
    // ["func add(a:u32 b:u32) end", FunctionDeclaration],
    // ["func add(a b) -> u32 end", FunctionDeclaration],
    // ["export \"walk\" func a() end", FunctionDeclaration],
    // ["1 << 2", Expression],
    // ["1 << 2 | 5", Expression],
    // ["1 << ((key >> bitOffset) & 0x7f)", Expression],
    // ["(1 + 2)", Expression],
    // ["(bitOffset + 7) % 64", Expression],
    // ["bitOffset = (bitOffset + 7) % 64", Assignment],
    // ['local index: u64 = 1 << ((key >> bitOffset) & 0x7f)', Statement],
    // ['bitOffset = (bitOffset + 7) % 64', Statement],
    // ['local bitfield: u64 = trie[trieOffset]', Statement],
    // ['trieOffset += 1', Statement],
    // ['return -1 when (bitfield & index) == 0)', Statement],
    // ['trieOffset += popcount(bitfield & (index - 1))', Statement],
    // ['return -2 when trieOffset >= trie.len', Statement],
    // ['local pointer: u64 = trie[trieOffset]', Statement],
    // ['return pointer when (pointer & 0x8000000000000000) == 0', Statement],
    // ['trieOffset += pointer & 0x7fffffffffffffff', Statement],
    // ['return -2 when trieOffset >= trie.len', Statement],
    // ['func no() end', Program]
];

if (!tests.length || true) {
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
    // console.log(tokens)
    const ast = parse(tokens, Start)
    console.log(inspect(ast, { colors: true, depth: 8 }));
    if (!ast) throw new Error("Failed to parse")
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
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
