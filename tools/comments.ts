// Comment extraction utility for Encantis
// Extracts comments with positions for doc comment support

export interface Comment {
  /** Comment text (without // or /* */) */
  text: string
  /** Start line (0-indexed) */
  line: number
  /** Start column (0-indexed) */
  col: number
  /** End line (0-indexed) */
  endLine: number
  /** End column (0-indexed) */
  endCol: number
  /** Whether this is a line comment (//) or block comment (/* */) */
  kind: 'line' | 'block'
}

/**
 * Extract all comments from source code.
 * Returns comments with 0-indexed line/col positions (LSP-compatible).
 */
export function extractComments(source: string): Comment[] {
  const comments: Comment[] = []
  let i = 0
  let line = 0
  let col = 0

  while (i < source.length) {
    // Line comment
    if (source[i] === '/' && source[i + 1] === '/') {
      const startLine = line
      const startCol = col
      i += 2
      col += 2

      const textStart = i
      while (i < source.length && source[i] !== '\n') {
        i++
        col++
      }

      comments.push({
        text: source.slice(textStart, i).trim(),
        line: startLine,
        col: startCol,
        endLine: line,
        endCol: col,
        kind: 'line',
      })
      continue
    }

    // Block comment
    if (source[i] === '/' && source[i + 1] === '*') {
      const startLine = line
      const startCol = col
      i += 2
      col += 2

      const textStart = i
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') {
          line++
          col = 0
        } else {
          col++
        }
        i++
      }

      const text = source.slice(textStart, i)
      const endLine = line
      const endCol = col

      // Skip closing */
      if (i < source.length) {
        i += 2
        col += 2
      }

      comments.push({
        text: text.trim(),
        line: startLine,
        col: startCol,
        endLine,
        endCol,
        kind: 'block',
      })
      continue
    }

    // Track position for other characters
    if (source[i] === '\n') {
      line++
      col = 0
    } else {
      col++
    }
    i++
  }

  return comments
}

/**
 * Find doc comments for a declaration at the given position.
 * A doc comment is a comment that immediately precedes a declaration
 * (on the previous line(s) with no blank lines between).
 *
 * @param comments All comments in the source
 * @param declLine Declaration line (0-indexed)
 * @returns Doc comment text (lines joined) or null if none
 */
export function findDocComment(comments: Comment[], declLine: number): string | null {
  // Find comments that end immediately before the declaration
  // Allow consecutive comment lines
  const docComments: Comment[] = []
  let expectedLine = declLine - 1

  // Work backwards through comments to find consecutive ones before the decl
  const sorted = [...comments].sort((a, b) => b.endLine - a.endLine || b.endCol - a.endCol)

  for (const comment of sorted) {
    if (comment.endLine === expectedLine || comment.line === expectedLine) {
      docComments.unshift(comment)
      expectedLine = comment.line - 1
    } else if (comment.endLine < expectedLine) {
      // Passed the relevant region
      break
    }
  }

  if (docComments.length === 0) return null

  // Join doc comment texts
  return docComments.map((c) => c.text).join('\n')
}
