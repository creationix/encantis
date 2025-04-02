import { read, readFileSync } from 'fs'

const pickColor = pickColorNice; // Change this to pickColorOld or pickColorBasic for different color schemes

const [, , filename] = process.argv
if (!filename) {
  console.error('Usage: node compile.mjs <source>')
  process.exit(1)
}

if (!filename.endsWith('.ents')) {
  console.error('Source file must end with .ents')
  process.exit(1)
}

const ents = readFileSync(filename, 'utf-8')

console.log('Compiling', filename)

// Encantis keywords
const keywords = new Set([
  "as",
  "forever",
  "return",
  "when",
  "type",
  "interface",
  "import",
  "export",
  "func",
  "local",
  "global",
  "for",
  "in",
  "do",
  "end",
  "data",
  "memory",
  "loop",
  "and",
  "or",
  "not",
  "if",
  "then",
  "else",
  "elseif",
  "while",
  "block",
  "break-if",
  "break",
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
  ["COMMENT", /^\-\-[^\n]*/],
  ["USER_TYPE", /^([A-Z][a-zA-Z0-9_-]*)\b/],
  ["IDENT", /^([a-zA-Z_][a-zA-Z0-9_-]*)\b/],
  ["DECIMAL", /^[+-]?[0-9]+(?:\.[0-9]+)?(?:[Ee][+-]?[0-9]+)?\b/],
  ["HEX", /^0x[+-]?[0-9a-fA-F]+\b/],
  ["CHAR", /^'(?:[^'\\]|\\.)'/],
  ["BINARY", /^0b[+-]?[01]+\b/],
  ["STRING", /^"(?:[^"\\]|\\.)*"/],
]
const operators = [
  "++", "--", // Increment and Decrement
  "+", "-", "*", "/", "%", // Arithmetic operators
  "~", "&", "|", "^", "<<", ">>", "<<<", ">>>", // Bitwise operators
  "=", // Assignment operator
  "+=", "-=", "*=", "/=", "%=", // Arithmetic assignment operators
  "&=", "|=", "^=", "<<=", ">>=", "<<<=", ">>>=", // Bitwise assignment operators
  "==", "!=", "<", "<=", ">", ">=", // Comparison operators

].sort((a, b) => a.length == b.length ? a.localeCompare(b) : b.length - a.length)

const punctuation = [
  "->", "=>",
  "(", ")", "{", "}", "[", "]",
  ";", ",", ".", ":",
]
lexers.push(["PUNCTUATION", new RegExp(`^(${punctuation.map(op => op.replace(/[-\/\\^$.*+?()[\]{}|]/g, '\\$&')).join("|")})`)]);
lexers.push(["OPERATOR", new RegExp(`^(${operators.map(op => op.replace(/[-\/\\^$.*+?()[\]{}|]/g, '\\$&')).join("|")})`)]);
lexers.push(["UNKNOWN", /^./]) // Catch-all for any unrecognized characters


console.log('Lexing...')
const lines = [...ents.matchAll(/[^\r\n]*(?:\r?\n)?/g).map(line => line[0])]
console.log(lines.map(highlight).join(''));
const tokens = lex(lines)
for (const token of tokens) {
  if (token.token === "UNKNOWN") {
    throw new SyntaxError(
      `Unrecognized token at ${filename}:${token.row}:${token.col}\n\n` +
      `  ${highlight(lines[token.row - 1])}\n` +
      `${" ".repeat(token.col + 1)}^`
    );
  }
}

/**
 * @param {Iterable<string>} lines 
 */
function* lex(lines) {
  let row = 0
  let col
  for (const line of lines) {
    let src = line
    row++
    col = 1
    outer: while (src.length > 0) {
      for (let [token, regex] of lexers) {
        const match = src.match(regex)
        if (match) {
          let value = match[0]
          if (token === "IDENT") {
            if (keywords.has(match[1])) {
              token = match[0]
              value = undefined
            } else if (types.has(match[1])) {
              token = "TYPE"
            }
          } else if (value === token) {
            value = undefined
          } else if (token === "STRING") {
            value = value.slice(1, -1) // Remove quotes
            value = value.replace(/\\(.)/g, (m, c) => {
              switch (c) {
                case 'n': return '\n';
                case 'r': return '\r';
                case 't': return '\t';
                case '\\': return '\\';
                case '"': return '"';
                case "'": return "'";
                default: return c; // unrecognized escape sequences remain unchanged
              }
            });
          } else if (token === "DECIMAL") {
            token = "NUMBER"
            value = parseFloat(value)
          } else if (token === "HEX") {
            token = "NUMBER"
            value = parseInt(value.substring(2), 16)
          } else if (token === "BINARY") {
            token = "NUMBER"
            value = parseInt(value.substring(2), 2)
          } else if (token === "CHAR") {
            token = "NUMBER"
            value = value.charCodeAt(1); // Get the char code of the character inside the quotes
          }
          if (value === undefined) {
            yield { row, col, token }
          }
          else {
            yield { row, col, token, value }
          }
          src = src.slice(match[0].length)
          col += match[0].length
          continue outer
        }
      }
      throw new SyntaxError(`Unlexable Value at ${filename}:${row}:${col}\n\n  ${line.trimEnd()}\n${" ".repeat(col + 1) + "^"}`)
    }
  }
  yield { row, col, token: "EOF" }
}

function highlight(line) {
  const parts = []
  let start = 0
  for (const token of lex([line])) {
    const offset = token.col - 1; // token.col is 1-based index
    parts.push(
      line.slice(start, token.col - 1), // text before the token
      pickColor(token.token) // color for the token
    );

    start = token.col - 1; // update start to the end of the current token
  }
  parts.push(
    line.slice(start, line.length),// remaining text after the last token
    "\x1b[0m" // reset color after the last token
  );
  return parts.join('');
}

function pickColorOld(token) {
  if (keywords.has(token)) { token = "KEYWORD"; }
  switch (token) {
    case "COMMENT": return "\x1b[38;5;59m"; // dark gray
    case "KEYWORD": return "\x1b[38;5;81m"; // teal
    case "WHITESPACE": return "\x1b[0m"; // reset
    case "IDENT": return "\x1b[38;5;114m"; // light green
    case "TYPE": return "\x1b[38;5;208m"; // orange
    case "OPERATOR": return "\x1b[38;5;231m"; // bright white
    case "PUNCTUATION": return "\x1b[38;5;250m"; // lighter gray 
    case "NUMBER": return "\x1b[38;5;173m"; // peach
    case "STRING": return "\x1b[38;5;217m"; // pink
    case "UNKNOWN": return "\x1b[38;5;226m"; // bright yellow 
    default: return "\x1b[38;5;135m"; // purple for unrecognized tokens
  }
}

function pickColorNice(token) {
  if (keywords.has(token)) { token = "KEYWORD"; }
  switch (token) {
    case "COMMENT": return "\x1b[38;5;59m"; // muted gray
    case "KEYWORD": return "\x1b[38;5;147m"; // less saturated purple
    case "WHITESPACE": return "\x1b[0m"; // reset
    case "IDENT": return "\x1b[38;5;39m"; // peaceful blue
    case "TYPE": return "\x1b[38;5;208m"; // orange
    case "USER_TYPE": return "\x1b[38;5;214m"; // yellow orange
    case "OPERATOR": return "\x1b[38;5;231m"; // bright white
    case "PUNCTUATION": return "\x1b[38;5;153m"; // almost white blue
    case "NUMBER": return "\x1b[38;5;181m"; // softer pink
    case "STRING": return "\x1b[38;5;118m"; // lime green
    case "UNKNOWN": return "\x1b[38;5;196m"; // brighter red
    default: return "\x1b[38;5;189m"; // brighter violet for unrecognized tokens
  }
}

function pickColorBasic(token) {
  if (keywords.has(token)) { token = "KEYWORD"; }
  switch (token) {
    case "COMMENT": return "\x1b[90m"; // gray
    case "KEYWORD": return "\x1b[35m"; // magenta
    case "WHITESPACE": return "\x1b[0m"; // reset
    case "IDENT": return "\x1b[34m"; // blue
    case "TYPE": return "\x1b[33m"; // yellow
    case "USER_TYPE": return "\x1b[36m"; // cyan
    case "OPERATOR": return "\x1b[37m"; // white
    case "PUNCTUATION": return "\x1b[32m"; // green
    case "NUMBER": return "\x1b[31m"; // red
    case "STRING": return "\x1b[92m"; // bright green
    case "UNKNOWN": return "\x1b[91m"; // bright red
    default: return "\x1b[95m"; // bright magenta for unrecognized tokens
  }
}

