export function formatEncantis(source: string): string {
  const inBlockComment = new Uint8Array(source.length)
  const bracketPositions: number[] = []
  const bracketChars: string[] = []
  const templateStack: number[] = []

  let i = 0

  function skipString(q: string) {
    i++
    while (i < source.length && source[i] !== q) {
      if (source[i] === '\\') i++
      i++
    }
    if (i < source.length) i++
  }

  function scanTemplateContent(): boolean {
    while (i < source.length) {
      if (source[i] === '\\') { i += 2; continue }
      if (source[i] === '`') { i++; return false }
      if (source[i] === '$' && i + 1 < source.length && source[i + 1] === '{') {
        i++
        bracketPositions.push(i)
        bracketChars.push('{')
        i++
        return true
      }
      i++
    }
    return false
  }

  while (i < source.length) {
    const ch = source[i]
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      inBlockComment[i] = 1; i++; inBlockComment[i] = 1; i++
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) { inBlockComment[i] = 1; i++ }
      if (i < source.length) { inBlockComment[i] = 1; i++; inBlockComment[i] = 1; i++ }
      continue
    }
    if (ch === '"' || ch === "'") { skipString(ch); continue }
    if (ch === 'x' && source[i + 1] === '"') { i++; skipString('"'); continue }
    if (ch === '`') {
      i++
      if (scanTemplateContent()) templateStack.push(1)
      continue
    }
    if (ch === '{' || ch === '(' || ch === '[') {
      bracketPositions.push(i)
      bracketChars.push(ch)
      if (ch === '{' && templateStack.length > 0) templateStack[templateStack.length - 1]++
      i++
      continue
    }
    if (ch === '}' || ch === ')' || ch === ']') {
      bracketPositions.push(i)
      bracketChars.push(ch)
      if (ch === '}' && templateStack.length > 0) {
        const top = templateStack.length - 1
        templateStack[top]--
        if (templateStack[top] === 0) {
          templateStack.pop()
          i++
          if (scanTemplateContent()) templateStack.push(1)
          continue
        }
      }
      i++
      continue
    }
    i++
  }

  const lines = source.split('\n')
  const lineStarts: number[] = [0]
  for (let j = 0; j < source.length; j++) {
    if (source[j] === '\n') lineStarts.push(j + 1)
  }
  function posToLine(pos: number): number {
    let lo = 0, hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1
    }
    return lo
  }

  const MATCH: Record<string, string> = { '}': '{', ')': '(', ']': '[' }
  const matchMap = new Map<number, number>()
  const stacks: Record<string, number[]> = { '{': [], '(': [], '[': [] }
  for (let j = 0; j < bracketPositions.length; j++) {
    const pos = bracketPositions[j]
    const ch = bracketChars[j]
    if (ch === '{' || ch === '(' || ch === '[') {
      stacks[ch].push(pos)
    } else {
      const stack = stacks[MATCH[ch]]
      if (stack.length > 0) {
        const openerPos = stack.pop()!
        matchMap.set(openerPos, pos)
        matchMap.set(pos, openerPos)
      }
    }
  }

  const bracketsByLine = new Map<number, { pos: number; ch: string }[]>()
  for (let j = 0; j < bracketPositions.length; j++) {
    const lineNum = posToLine(bracketPositions[j])
    let list = bracketsByLine.get(lineNum)
    if (!list) { list = []; bracketsByLine.set(lineNum, list) }
    list.push({ pos: bracketPositions[j], ch: bracketChars[j] })
  }

  const lineDepths = new Int32Array(lines.length)
  let depth = 0

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const lb = bracketsByLine.get(lineIdx)
    if (lb) {
      const closerOrigins = new Set<number>()
      for (const b of lb) {
        if (b.ch === '}' || b.ch === ')' || b.ch === ']') {
          const openerPos = matchMap.get(b.pos)
          if (openerPos !== undefined) {
            const openerLine = posToLine(openerPos)
            if (openerLine !== lineIdx) closerOrigins.add(openerLine)
          } else {
            closerOrigins.add(-(b.pos + 1))
          }
        }
      }
      depth = Math.max(0, depth - closerOrigins.size)
      lineDepths[lineIdx] = depth

      const openerTargets = new Set<number>()
      for (const b of lb) {
        if (b.ch === '{' || b.ch === '(' || b.ch === '[') {
          const closerPos = matchMap.get(b.pos)
          if (closerPos !== undefined) {
            const closerLine = posToLine(closerPos)
            if (closerLine !== lineIdx) openerTargets.add(closerLine)
          } else {
            openerTargets.add(-(b.pos + 1))
          }
        }
      }
      depth += openerTargets.size
    } else {
      lineDepths[lineIdx] = depth
    }
  }

  type TokKind = 'word' | 'num' | 'str' | 'op' | 'open' | 'close' | 'comma' | 'colon' | 'semi' | 'dot' | 'comment'
  interface Tok { kind: TokKind; text: string }

  const KEYWORDS = new Set([
    'if', 'elif', 'else', 'while', 'for', 'in', 'loop', 'match',
    'break', 'continue', 'return', 'when',
    'func', 'let', 'set', 'global', 'data', 'def', 'type', 'enum',
    'import', 'export', 'memory', 'inline', 'mut',
    'as', 'true', 'false', 'int', 'float', 'sizeof',
  ])

  const FOUR_OPS = new Set(['<<<=', '>>>='])
  const THREE_OPS = new Set(['<<<', '>>>', '<<=', '>>='])
  const TWO_OPS = new Set(['==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '^=', '|=', '&=', '<<', '>>', '->', '=>', '??', '||', '&&', '.*'])

  function tokenizeLine(line: string): Tok[] {
    const tokens: Tok[] = []
    let j = 0

    function scanString(q: string) {
      const start = j; j++
      while (j < line.length && line[j] !== q) {
        if (line[j] === '\\') j++
        j++
      }
      if (j < line.length) j++
      tokens.push({ kind: 'str', text: line.slice(start, j) })
    }

    while (j < line.length) {
      if (line[j] === ' ' || line[j] === '\t') { j++; continue }

      if (line[j] === '/' && line[j + 1] === '/') {
        tokens.push({ kind: 'comment', text: line.slice(j) }); break
      }
      if (line[j] === '/' && line[j + 1] === '*') {
        tokens.push({ kind: 'comment', text: line.slice(j) }); break
      }
      if (line[j] === '"' || line[j] === "'") { scanString(line[j]); continue }
      if (line[j] === 'x' && line[j + 1] === '"') {
        const start = j; j += 2
        while (j < line.length && line[j] !== '"') j++
        if (j < line.length) j++
        tokens.push({ kind: 'str', text: line.slice(start, j) }); continue
      }
      if (line[j] === '`') {
        const start = j; j++
        while (j < line.length && line[j] !== '`') {
          if (line[j] === '\\') { j += 2; continue }
          if (line[j] === '$' && line[j + 1] === '{') {
            j += 2
            let braces = 1
            while (j < line.length && braces > 0) {
              if (line[j] === '"' || line[j] === "'") {
                const q = line[j]; j++
                while (j < line.length && line[j] !== q) { if (line[j] === '\\') j++; j++ }
                if (j < line.length) j++; continue
              }
              if (line[j] === '{') braces++
              else if (line[j] === '}') braces--
              if (braces > 0) j++
            }
            if (j < line.length) j++
            continue
          }
          j++
        }
        if (j < line.length) j++
        tokens.push({ kind: 'str', text: line.slice(start, j) }); continue
      }

      if (line[j] === '(') {
        tokens.push({ kind: 'open', text: '(' }); j++; continue
      }
      if (line[j] === '[') {
        const rest = line.slice(j + 1)
        const m = rest.match(/^([0-9?!_]+(?:x[0-9?!_]+)*|\*)\]/)
        if (m) {
          tokens.push({ kind: 'open', text: '[' })
          tokens.push({ kind: 'num', text: m[1] })
          tokens.push({ kind: 'close', text: ']' })
          j += 1 + m[0].length; continue
        }
        tokens.push({ kind: 'open', text: '[' }); j++; continue
      }
      if (line[j] === '{') {
        tokens.push({ kind: 'open', text: '{' }); j++; continue
      }
      if (line[j] === ')' || line[j] === ']') {
        tokens.push({ kind: 'close', text: line[j] }); j++; continue
      }
      if (line[j] === '}') {
        tokens.push({ kind: 'close', text: '}' }); j++; continue
      }

      if (line[j] === ',') { tokens.push({ kind: 'comma', text: ',' }); j++; continue }
      if (line[j] === ';') { tokens.push({ kind: 'semi', text: ';' }); j++; continue }
      if (line[j] === ':') { tokens.push({ kind: 'colon', text: ':' }); j++; continue }
      if (line[j] === '.' && line[j + 1] !== '*') { tokens.push({ kind: 'dot', text: '.' }); j++; continue }

      if (/[a-zA-Z_]/.test(line[j])) {
        const start = j
        while (j < line.length && /[a-zA-Z0-9_-]/.test(line[j])) j++
        if (line[j] === '#' && /^u(8|16|32|64|128|256|512)$/.test(line.slice(start, j)) && /[0-9]/.test(line[j + 1])) {
          j++
          while (j < line.length && /[0-9]/.test(line[j])) j++
        }
        tokens.push({ kind: 'word', text: line.slice(start, j) }); continue
      }
      if (/[0-9]/.test(line[j])) {
        const start = j
        if (line[j] === '0' && (line[j + 1] === 'x' || line[j + 1] === 'X')) {
          j += 2; while (j < line.length && /[0-9a-fA-F_]/.test(line[j])) j++
        } else if (line[j] === '0' && (line[j + 1] === 'b' || line[j + 1] === 'B')) {
          j += 2; while (j < line.length && /[01_]/.test(line[j])) j++
        } else {
          while (j < line.length && /[0-9_.]/.test(line[j])) j++
          while (line[j] === 'x' && /[0-9]/.test(line[j + 1])) {
            j++
            while (j < line.length && /[0-9_.]/.test(line[j])) j++
          }
        }
        tokens.push({ kind: 'num', text: line.slice(start, j) }); continue
      }

      const c4 = line.slice(j, j + 4)
      if (FOUR_OPS.has(c4)) { tokens.push({ kind: 'op', text: c4 }); j += 4; continue }
      const c3 = line.slice(j, j + 3)
      if (THREE_OPS.has(c3)) { tokens.push({ kind: 'op', text: c3 }); j += 3; continue }
      const c2 = line.slice(j, j + 2)
      if (TWO_OPS.has(c2)) { tokens.push({ kind: 'op', text: c2 }); j += 2; continue }

      tokens.push({ kind: 'op', text: line[j] }); j++
    }
    return tokens
  }

  function isUnaryPosition(prev: Tok | undefined): boolean {
    if (!prev) return true
    return prev.kind === 'open' || prev.kind === 'comma' || prev.kind === 'colon'
      || prev.kind === 'semi' || prev.kind === 'op'
      || (prev.kind === 'word' && KEYWORDS.has(prev.text))
  }

  function formatTokens(tokens: Tok[]): string {
    if (tokens.length === 0) return ''
    let result = tokens[0].text
    for (let k = 1; k < tokens.length; k++) {
      const L = tokens[k - 1], R = tokens[k], LL = tokens[k - 2] as Tok | undefined

      // Never space before
      if (R.kind === 'comma' || R.kind === 'semi') { result += R.text; continue }
      if (R.kind === 'close' && R.text !== '}') { result += R.text; continue }
      if (R.kind === 'dot') { result += R.text; continue }
      if (R.kind === 'colon') { result += R.text; continue }
      if (R.kind === 'op' && R.text === '.*') { result += R.text; continue }

      // Never space after
      if (L.kind === 'open' && L.text !== '{' && L.text !== '${') { result += R.text; continue }
      if (L.kind === 'dot') { result += R.text; continue }
      // Never space after colon
      if (L.kind === 'colon') { result += R.text; continue }

      // {} pair — no space inside empty braces
      if (R.kind === 'close' && R.text === '}' && L.kind === 'open' && (L.text === '{' || L.text === '${')) { result += R.text; continue }

      // ] followed by word/[/* — no space (type prefix: []u8, [][]u8, [*]u8)
      if (L.kind === 'close' && L.text === ']' && (R.kind === 'word' || (R.kind === 'open' && R.text === '['))) { result += R.text; continue }

      // word( — no space for function calls, space for keywords
      if (R.kind === 'open' && R.text === '(' && L.kind === 'word') {
        if (KEYWORDS.has(L.text)) { result += ' ' + R.text; continue }
        result += R.text; continue
      }
      // )( or close[ — no space (chained calls/indexing)
      if (R.kind === 'open' && (R.text === '(' || R.text === '[') && L.kind === 'close') { result += R.text; continue }
      // word[ — no space (indexing)
      if (R.kind === 'open' && R.text === '[' && L.kind === 'word' && !KEYWORDS.has(L.text)) { result += R.text; continue }
      // num[ — no space
      if (R.kind === 'open' && R.text === '[' && L.kind === 'num') { result += R.text; continue }
      // str[ — no space (for string indexing if it exists)
      if (R.kind === 'open' && R.text === '[' && L.kind === 'str') { result += R.text; continue }

      // Unary operators: no space after
      if (L.kind === 'op' && '&*-!~?'.includes(L.text) && isUnaryPosition(LL)) { result += R.text; continue }

      // Default: space
      result += ' ' + R.text
    }
    return result
  }

  const out: string[] = []
  let prevBlank = false
  let offset = 0

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const raw = lines[lineIdx]
    const trimmed = raw.trim()
    if (trimmed === '') {
      if (!prevBlank && out.length > 0) out.push('')
      prevBlank = true
      offset += raw.length + 1
      continue
    }
    prevBlank = false

    const firstCharOffset = offset + raw.indexOf(trimmed)
    if (firstCharOffset < inBlockComment.length && inBlockComment[firstCharOffset]) {
      out.push(raw.trimEnd())
    } else if (trimmed.startsWith('#!')) {
      out.push(trimmed)
    } else {
      out.push('  '.repeat(lineDepths[lineIdx]) + formatTokens(tokenizeLine(trimmed)))
    }
    offset += raw.length + 1
  }

  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  out.push('')
  return out.join('\n')
}

export function formatLine(line: string): string {
  return formatEncantis(line + '\n').trimEnd()
}
