import { read, readFileSync } from 'fs'
import { createInterface } from 'readline/promises'

const [, , source] = process.argv
if (!source) {
  console.error('Usage: node compile.mjs <source>')
  process.exit(1)
}

if (!source.endsWith('.ents')) {
  console.error('Source file must end with .ents')
  process.exit(1)
}

const ents = readFileSync(source, 'utf-8')

console.log('Compiling', source)

// Encantis keywords
const keywords = new Set([
  "import",
  "export",
  "func",
])

// Encantis base types
const types = new Set([
  "u8", "i8",
  "u16", "i16",
  "u32", "i32",
  "u64", "i64",
  "f32", "f64",
])

/**
 * @type {[string,RegExp][]}
 */
const lexers = [
  ["WHITESPACE", /^\s+/],
  ["COMMENT", /^--[^\n]*/],
  ["IDENT", /^([a-zA-Z_][a-zA-Z0-9_-]*)\b/],
  ["DECIMAL", /^[+-]?[0-9]+(?:\.[0-9]+)?(?:[Ee][+-]?[0-9]+)\b/],
  ["STRING", /^"(?:[^"\\]|\\.)*"/],
]
const operators = [
  "->", "=>",
  "(", ")",
  ":", ",",
  "+", "-", "*", "/", "%",
  "==", "!=", "<", "<=", ">", ">=",
  "&&", "||", "!",
  "=", "+=", "-=", "*=", "/=", "%=",
].sort((a, b) => a.length == b.length ? a.localeCompare(b) : b.length - a.length)

for (const op of operators) {
  lexers.push([op, new RegExp(`^${op.replace(/[-\/\\^$.*+?()[\]{}|]/g, '\\$&')}`)])
}

console.log('Lexing...')
const lines = ents.matchAll(/[^\r\n]*(?:\r?\n)?/g).map(line => line[0])
const tokens = lex(lines)
for (const token of tokens) {
  console.log(token)
}

/**
 * @param {Iterable<string>} lines 
 */
function* lex(lines) {
  let row = 0
  for (let line of lines) {
    row++
    let col = 1
    outer: while (line.length > 0) {
      for (let [token, regex] of lexers) {
        const match = line.match(regex)
        if (match) {
          let value = match[0]
          if (token !== "WHITESPACE" && token !== "COMMENT") {
            if (token === "IDENT") {
              if (keywords.has(match[1])) {
                token = match[0]
                value = undefined
              } else if (types.has(match[1])) {
                token = "TYPE"
              }
            } else if (value === token) {
              value = undefined
            }
            if (value === undefined) {
              yield { row, col, token }
            }
            else {
              yield { row, col, token, value }
            }
          }
          line = line.slice(match[0].length)
          col += match[0].length
          continue outer
        }
      }
    }
  }
}