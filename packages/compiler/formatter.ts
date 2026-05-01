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
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) { inBlockComment[i] = 1; i++ }
      if (i < source.length) { inBlockComment[i] = 1; i += 2 }
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
    } else {
      out.push('  '.repeat(lineDepths[lineIdx]) + trimmed)
    }
    offset += raw.length + 1
  }

  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  out.push('')
  return out.join('\n')
}
