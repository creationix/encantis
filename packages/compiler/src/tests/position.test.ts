import { describe, expect, test } from 'bun:test'
import { LineMap, positionKey } from '../position'

describe('LineMap', () => {
  describe('constructor', () => {
    test('empty source has one line', () => {
      const map = new LineMap('')
      expect(map.lineCount).toBe(1)
    })

    test('single line without newline', () => {
      const map = new LineMap('hello')
      expect(map.lineCount).toBe(1)
    })

    test('single line with newline', () => {
      const map = new LineMap('hello\n')
      expect(map.lineCount).toBe(2)
    })

    test('multiple lines', () => {
      const map = new LineMap('line1\nline2\nline3')
      expect(map.lineCount).toBe(3)
    })

    test('empty lines', () => {
      const map = new LineMap('\n\n\n')
      expect(map.lineCount).toBe(4)
    })
  })

  describe('offsetToPosition', () => {
    test('single line positions', () => {
      const map = new LineMap('hello')
      expect(map.offsetToPosition(0)).toEqual({ line: 0, col: 0 })
      expect(map.offsetToPosition(2)).toEqual({ line: 0, col: 2 })
      expect(map.offsetToPosition(5)).toEqual({ line: 0, col: 5 })
    })

    test('multi-line positions', () => {
      const map = new LineMap('abc\ndef\nghi')
      // Line 0: 'abc\n' (offsets 0-3)
      expect(map.offsetToPosition(0)).toEqual({ line: 0, col: 0 })
      expect(map.offsetToPosition(2)).toEqual({ line: 0, col: 2 })
      expect(map.offsetToPosition(3)).toEqual({ line: 0, col: 3 }) // newline char

      // Line 1: 'def\n' (offsets 4-7)
      expect(map.offsetToPosition(4)).toEqual({ line: 1, col: 0 })
      expect(map.offsetToPosition(6)).toEqual({ line: 1, col: 2 })

      // Line 2: 'ghi' (offsets 8-10)
      expect(map.offsetToPosition(8)).toEqual({ line: 2, col: 0 })
      expect(map.offsetToPosition(10)).toEqual({ line: 2, col: 2 })
    })

    test('positions at line boundaries', () => {
      const map = new LineMap('a\nb\nc')
      expect(map.offsetToPosition(1)).toEqual({ line: 0, col: 1 }) // newline
      expect(map.offsetToPosition(2)).toEqual({ line: 1, col: 0 }) // start of line 1
      expect(map.offsetToPosition(3)).toEqual({ line: 1, col: 1 }) // newline
      expect(map.offsetToPosition(4)).toEqual({ line: 2, col: 0 }) // start of line 2
    })

    test('binary search correctness with many lines', () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`)
      const source = lines.join('\n')
      const map = new LineMap(source)

      // Check various positions
      expect(map.offsetToPosition(0)).toEqual({ line: 0, col: 0 })
      expect(map.offsetToPosition(5)).toEqual({ line: 0, col: 5 }) // 'line0'

      // Line 50 starts after 50 lines of "lineN\n" (each ~6-7 chars)
      const line50Start = source.indexOf('line50')
      expect(map.offsetToPosition(line50Start)).toEqual({ line: 50, col: 0 })
    })
  })

  describe('positionToOffset', () => {
    test('round-trip conversion', () => {
      const map = new LineMap('abc\ndef\nghi')
      for (const offset of [0, 2, 4, 6, 8, 10]) {
        const pos = map.offsetToPosition(offset)
        expect(map.positionToOffset(pos)).toBe(offset)
      }
    })

    test('returns -1 for invalid line', () => {
      const map = new LineMap('abc\ndef')
      expect(map.positionToOffset({ line: -1, col: 0 })).toBe(-1)
      expect(map.positionToOffset({ line: 5, col: 0 })).toBe(-1)
    })

    test('handles column beyond line length', () => {
      const map = new LineMap('abc\ndef')
      // Column 10 on line 0 - returns offset even if beyond line end
      expect(map.positionToOffset({ line: 0, col: 10 })).toBe(10)
    })
  })

  describe('positionKey', () => {
    test('formats position as line:col', () => {
      const map = new LineMap('abc\ndef')
      expect(map.positionKey(0)).toBe('0:0')
      expect(map.positionKey(2)).toBe('0:2')
      expect(map.positionKey(4)).toBe('1:0')
      expect(map.positionKey(6)).toBe('1:2')
    })
  })

  describe('spanLength', () => {
    test('ASCII characters', () => {
      const map = new LineMap('hello world')
      expect(map.spanLength(0, 5)).toBe(5) // 'hello'
      expect(map.spanLength(0, 11)).toBe(11) // 'hello world'
    })

    test('UTF-8 multi-byte characters', () => {
      // Emoji \u{1F600} takes 2 UTF-16 code units in JS strings
      const source = 'hello\u{1F600}world'
      const map = new LineMap(source)
      expect(map.spanLength(0, 5)).toBe(5) // 'hello'
      // Emoji is 2 UTF-16 code units but 1 character when spread
      expect(map.spanLength(5, 7)).toBe(1) // just the emoji (2 code units, 1 char)
      // 'hello' (5) + emoji (2 code units) + 'world' (5) = 12 code units, 11 chars
      expect(map.spanLength(0, source.length)).toBe(11)
    })

    test('empty span', () => {
      const map = new LineMap('hello')
      expect(map.spanLength(2, 2)).toBe(0)
    })
  })

  describe('getText', () => {
    test('extracts substring', () => {
      const map = new LineMap('hello world')
      expect(map.getText(0, 5)).toBe('hello')
      expect(map.getText(6, 11)).toBe('world')
    })

    test('handles multi-line', () => {
      const map = new LineMap('abc\ndef\nghi')
      expect(map.getText(0, 3)).toBe('abc')
      expect(map.getText(4, 7)).toBe('def')
      expect(map.getText(0, 11)).toBe('abc\ndef\nghi')
    })
  })
})

describe('positionKey standalone function', () => {
  test('formats position as line:col', () => {
    expect(positionKey({ line: 0, col: 0 })).toBe('0:0')
    expect(positionKey({ line: 5, col: 10 })).toBe('5:10')
    expect(positionKey({ line: 100, col: 42 })).toBe('100:42')
  })
})
