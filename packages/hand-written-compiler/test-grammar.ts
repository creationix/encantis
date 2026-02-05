import * as ohm from 'ohm-js'
import { createSemantics } from './encantis-actions.ts'

const encantisGrammar = ohm.grammar(await Bun.file(new URL('./encantis-grammar.ohm', import.meta.url)).text())
console.log('Grammar loaded successfully.')
const semantics = createSemantics(encantisGrammar)

type TestEvent =
  | { type: 'heading'; level: number; text: string }
  | { type: 'codeBlock'; lang: string; meta?: string; content: string }
  | { type: 'paragraph'; text: string }

async function* markdownTests(filename: string): AsyncGenerator<TestEvent> {
  const md = await Bun.file(new URL(filename, import.meta.url)).text()
  const lines = md.split('\n')

  const patterns: [RegExp, (match: RegExpExecArray) => Generator<TestEvent>][] = [
    [/^\s*$/, blank],
    [/^([#]+)\s*(.*)$/, heading],
    [/^```(.*)$/, codeFence],
    [/^(.*)$/, line],
  ]

  let inCodeBlock = false
  let codeBlockLang: string
  let codeBlockMeta: string | undefined
  let codeBlockLines: string[]

  for (let i = 0; i < lines.length; i++) {
    for (const [pattern, fn] of patterns) {
      const match = pattern.exec(lines[i])
      if (match) {
        yield* fn(match)
        break
      }
    }
  }

  function* blank(_match: RegExpExecArray) {
    // Ignore blank lines
  }

  function* heading(match: RegExpExecArray): Generator<TestEvent> {
    const level = match[1].length
    const text = match[2]
    yield { type: 'heading', level, text }
  }

  function* codeFence(match: RegExpExecArray): Generator<TestEvent> {
    if (inCodeBlock) {
      inCodeBlock = false
      yield {
        type: 'codeBlock',
        lang: codeBlockLang,
        meta: codeBlockMeta,
        content: codeBlockLines.join('\n'),
      }
    } else {
      // Start collecting code block lines
      inCodeBlock = true
      const parts = match[1].split(' ', 2)
      codeBlockLang = parts[0]
      codeBlockMeta = parts.length > 1 ? parts[1] : undefined
      codeBlockLines = []
    }
  }

  function* line(match: RegExpExecArray): Generator<TestEvent> {
    if (inCodeBlock) {
      codeBlockLines.push(match[1])
    } else {
      yield { type: 'paragraph', text: match[1] }
    }
  }
}

const blockLimit = 16
let blockCount = 0
let lastAST: any = null
for await (const event of markdownTests('./parse-tests.md')) {
  console.log()
  switch (event.type) {
    case 'heading': {
      // Log the heading in bold and colored using interesting ansi 256 colors
      // For example,
      // level 1 is colored using ansi256 orange (color 208)
      // level 2 is colored using ansi256 lime green (color 118)
      // level 3 is colored using ansi256 cyan (color 51)
      const color = event.level === 1 ? 208 : event.level === 2 ? 118 : 51
      console.log(`\x1b[1;38;5;${color}m${'#'.repeat(event.level)} ${event.text}\x1b[0m`)
      break
    }
    case 'codeBlock':
      switch (event.lang) {
        case 'ents': {
          console.log(`\x1b[34mEncantis ${event.meta}:\x1b[0m`)
          console.log(event.content.trim())
          const ast = parseEnts(event.content, event.meta)
          lastAST = ast
          break
        }
        case 'json': {
          if (event.meta?.toLowerCase() === 'ast') {
            console.log('\x1b[34mAST output:\x1b[0m')
            if (lastAST === null) {
              throw new Error('No previous AST to compare with')
            }
            const expectedAST = JSON.parse(event.content)
            const actualAST = lastAST
            const expectedStr = JSON.stringify(expectedAST, null, 2)
            const actualStr = JSON.stringify(actualAST, null, 2)
            if (expectedStr === actualStr) {
              console.log(`\x1b[32m${actualStr}\x1b[0m`)
            } else {
              console.log('\x1b[31mAST does not match expected output:\x1b[0m')
              console.log('\x1b[33mExpected:\x1b[0m')
              console.log(expectedStr)
              console.log('\x1b[33mActual:\x1b[0m')
              console.log(actualStr)
            }
          } else {
            throw new Error(`Unknown json block meta: ${event.meta}`)
          }
          break
        }
        default: {
          throw new Error(`Unknown code block language: ${event.lang}`)
        }
      }
      blockCount++
      if (blockCount >= blockLimit) {
        process.exit(0)
      }

      break
    case 'paragraph':
      console.log(event.text)
      break
  }
}



function parseEnts(source: string, meta?: string): any {
  // use semanticsActions to parse the source
  const match = encantisGrammar.match(source, meta)
  if (match.failed()) {
    throw new Error(`Parse error: ${match.message}`)
  }
  return semantics(match).toAST()
}