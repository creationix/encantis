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

for await (const event of markdownTests('./parse-tests.md')) {
  switch (event.type) {
    case 'heading': {
      // Log the heading in bold and colored using interesting ansi 256 colors
      // For example,
      // level 1 is colored using ansi256 orange (color 208)
      // level 2 is colored using ansi256 lime green (color 118)
      // level 3 is colored using ansi256 cyan (color 51)
      const color = event.level === 1 ? 208 : event.level === 2 ? 118 : 51
      console.log(`\n\x1b[1;38;5;${color}m${'#'.repeat(event.level)} ${event.text}\x1b[0m\n`)
      break
    }
    case 'codeBlock':
      console.log()
      switch (event.lang) {
        case 'ents': {
          const ast = parseEnts(event.content, event.meta)
          console.log(JSON.stringify(ast, null, 2))
          process.exit(0)
          break
        }
        default: {
          throw new Error(`Unknown code block language: ${event.lang}`)
        }
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