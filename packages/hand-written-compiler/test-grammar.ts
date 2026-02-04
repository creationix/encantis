import * as ohm from 'ohm-js'

type TestEvent =
  | { type: 'heading'; level: number; text: string }
  | { type: 'codeBlock'; lang: string; meta: string | null; content: string }
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
  let codeBlockMeta: string | null
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

  function* codeFence(match: RegExpExecArray) {
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
      codeBlockLang = match[1]
      codeBlockMeta = match[2] || null
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
      const color = event.level === 1 ? 208 : event.level === 2 ? 118 : 45
      console.log(`\n\x1b[1;38;5;${color}m${'#'.repeat(event.level)} ${event.text}\x1b[0m\n`)
      break
    }
    case 'codeBlock':
      console.log(event)
      // Process code block
      break
    case 'paragraph':
      console.log(event.text)
      break
  }
}

// const encantisGrammar = ohm.grammar(await Bun.file(new URL('./encantis.ohm', import.meta.url)).text())
// console.log('Grammar loaded successfully.')
