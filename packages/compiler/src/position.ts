// Position utilities for converting byte offsets to LSP-compatible line:col
// All positions are 0-indexed to match LSP Position interface

export interface Position {
  line: number // 0-indexed
  col: number // 0-indexed
}

/**
 * LineMap provides efficient byte offset to line:col conversion.
 * Build once per source file, then O(log n) lookups via binary search.
 */
export class LineMap {
  // Byte offset where each line starts (index = line number, 0-indexed)
  private lineStarts: number[]

  constructor(private source: string) {
    this.lineStarts = [0] // Line 0 starts at byte 0

    for (let i = 0; i < source.length; i++) {
      if (source[i] === '\n') {
        this.lineStarts.push(i + 1) // Next line starts after the newline
      }
    }
  }

  /**
   * Convert byte offset to 0-indexed line:col position.
   */
  offsetToPosition(offset: number): Position {
    // Binary search to find the line containing this offset
    let low = 0
    let high = this.lineStarts.length - 1

    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2)
      if (this.lineStarts[mid] <= offset) {
        low = mid
      } else {
        high = mid - 1
      }
    }

    const line = low
    const col = offset - this.lineStarts[line]

    return { line, col }
  }

  /**
   * Format position as "line:col" string (0-indexed).
   */
  positionKey(offset: number): string {
    const pos = this.offsetToPosition(offset)
    return `${pos.line}:${pos.col}`
  }

  /**
   * Get span length in characters (for the "len" field in hints).
   * For ASCII, this equals byte length. For UTF-8 with multi-byte chars,
   * this returns the actual character count.
   */
  spanLength(start: number, end: number): number {
    // Extract the substring and count characters
    // This handles UTF-8 correctly since JS strings are UTF-16
    const text = this.source.slice(start, end)
    return [...text].length
  }

  /**
   * Convert 0-indexed line:col position back to byte offset.
   */
  positionToOffset(pos: Position): number {
    if (pos.line < 0 || pos.line >= this.lineStarts.length) {
      return -1
    }
    return this.lineStarts[pos.line] + pos.col
  }

  /**
   * Get the source text for a span.
   */
  getText(start: number, end: number): string {
    return this.source.slice(start, end)
  }

  /**
   * Get total number of lines.
   */
  get lineCount(): number {
    return this.lineStarts.length
  }
}

/**
 * Format position as "line:col" string.
 */
export function positionKey(pos: Position): string {
  return `${pos.line}:${pos.col}`
}
