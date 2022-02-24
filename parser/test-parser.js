import { inspect } from "util"
import peggy from "peggy"
import { readFileSync } from "fs"
const grammarSource = readFileSync('Encantis.peggy', 'utf8')
const parser = peggy.generate(grammarSource)
const filename = "../samples/trie.ents"
const source = readFileSync(filename, 'utf8')
try {
    const ast = parser.parse(source, { grammarSource: filename })
    console.log(inspect(ast, {
        depth: 100,
        colors: true
    }))
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
