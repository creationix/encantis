import { inspect } from "util"
import peggy from "peggy"
import { readFileSync } from "fs"

const keywords = [
    'as',
    'block',
    'br',
    'call',
    'destructure',
    'do',
    'elif',
    'else',
    'end',
    'export',
    'f32',
    'f64',
    'for',
    'forever',
    'func',
    'global',
    'i16',
    'i32',
    'i64',
    'i8',
    'if',
    'in',
    'index',
    'local',
    'loop',
    'memory',
    'param',
    'ptr',
    'result',
    'return',
    'slice',
    'then',
    'tuple',
    'u16',
    'u32',
    'u64',
    'u8',
    'unless',
    'var',
    'when',
    'while',
]

const grammarSource = readFileSync('Encantis.peggy', 'utf8')
const parser = peggy.generate(grammarSource)
// const filename = "../samples/gimli.ents"
const filename = "../samples/server.ents"
const source = readFileSync(filename, 'utf8')
try {
    const ast = parser.parse(source, { grammarSource: filename })
    console.log(inspect(ast, {
        depth: 100,
        colors: true
    }))
    // const [literals, processed] = processIt(ast)
    // console.log(inspect({ literals, processed }, {
    //     depth: 100,
    //     colors: true
    // }))
} catch (err) {
    if (err instanceof parser.SyntaxError) {
        const { message, location: { start } } = err
        const lines = source.split("\n")
        const line = lines[start.line - 1]
        const error = `${message}\n    ${line}\n    ${" ".repeat(start.column - 1)}^`
        console.error(error)
        console.error(err.location)
        process.exit(-1)
    } else {
        throw err
    }
}


function processIt(ast) {
    const literals = []
    return [literals, walk(ast)]
    function walk(node) {

        if (Array.isArray(node)) {
            return node.map(walk)
        }

        let index = keywords.indexOf(node)
        if (index >= 0) return index

        const type = typeof node
        if (type === "number" || type === "string") {
            index = literals.indexOf(node)
            if (index >= 0) return index + keywords.length
            return literals.push(node) - 1
        }
        return node
    }
}