import { describe, expect, test } from 'bun:test'
import { extractComments, findDocComment } from '../comments'

describe('extractComments', () => {
  describe('line comments', () => {
    test('single line comment', () => {
      const comments = extractComments('// hello')
      expect(comments).toHaveLength(1)
      expect(comments[0]).toMatchObject({
        text: 'hello',
        line: 0,
        col: 0,
        endLine: 0,
        kind: 'line',
      })
    })

    test('line comment with leading whitespace', () => {
      const comments = extractComments('  // indented')
      expect(comments).toHaveLength(1)
      expect(comments[0]).toMatchObject({
        text: 'indented',
        col: 2,
      })
    })

    test('multiple line comments', () => {
      const comments = extractComments('// first\n// second')
      expect(comments).toHaveLength(2)
      expect(comments[0].text).toBe('first')
      expect(comments[0].line).toBe(0)
      expect(comments[1].text).toBe('second')
      expect(comments[1].line).toBe(1)
    })

    test('line comment after code', () => {
      const comments = extractComments('let x = 1 // comment')
      expect(comments).toHaveLength(1)
      expect(comments[0]).toMatchObject({
        text: 'comment',
        col: 10,
      })
    })

    test('empty line comment', () => {
      const comments = extractComments('//')
      expect(comments).toHaveLength(1)
      expect(comments[0].text).toBe('')
    })
  })

  describe('block comments', () => {
    test('single-line block comment', () => {
      const comments = extractComments('/* hello */')
      expect(comments).toHaveLength(1)
      expect(comments[0]).toMatchObject({
        text: 'hello',
        line: 0,
        col: 0,
        endLine: 0,
        kind: 'block',
      })
    })

    test('multi-line block comment', () => {
      const comments = extractComments('/* line 1\nline 2\nline 3 */')
      expect(comments).toHaveLength(1)
      expect(comments[0]).toMatchObject({
        text: 'line 1\nline 2\nline 3',
        line: 0,
        endLine: 2,
        kind: 'block',
      })
    })

    test('block comment with asterisks', () => {
      const comments = extractComments('/**\n * doc comment\n */')
      expect(comments).toHaveLength(1)
      // Text is trimmed, so leading/trailing whitespace removed
      expect(comments[0].text).toBe('*\n * doc comment')
    })

    test('empty block comment', () => {
      const comments = extractComments('/**/')
      expect(comments).toHaveLength(1)
      expect(comments[0].text).toBe('')
    })

    test('block comment between code', () => {
      const comments = extractComments('let /* inline */ x = 1')
      expect(comments).toHaveLength(1)
      expect(comments[0]).toMatchObject({
        text: 'inline',
        col: 4,
      })
    })
  })

  describe('mixed comments', () => {
    test('line and block comments', () => {
      const source = `// line comment
/* block comment */
let x = 1 // trailing`
      const comments = extractComments(source)
      expect(comments).toHaveLength(3)
      expect(comments[0].kind).toBe('line')
      expect(comments[1].kind).toBe('block')
      expect(comments[2].kind).toBe('line')
    })

    test('comments on same line', () => {
      const comments = extractComments('/* first */ // second')
      expect(comments).toHaveLength(2)
      expect(comments[0].text).toBe('first')
      expect(comments[1].text).toBe('second')
    })
  })

  describe('edge cases', () => {
    test('empty source', () => {
      expect(extractComments('')).toHaveLength(0)
    })

    test('no comments', () => {
      expect(extractComments('let x = 1\nlet y = 2')).toHaveLength(0)
    })

    test('division is not a comment', () => {
      expect(extractComments('let x = 1 / 2')).toHaveLength(0)
    })

    test('unclosed block comment goes to end', () => {
      const comments = extractComments('/* unclosed')
      expect(comments).toHaveLength(1)
      expect(comments[0].text).toBe('unclosed')
    })
  })
})

describe('findDocComment', () => {
  test('single line doc comment', () => {
    const source = `// This is a doc comment
func foo() {}`
    const comments = extractComments(source)
    const doc = findDocComment(comments, 1)
    expect(doc).toBe('This is a doc comment')
  })

  test('multiple consecutive doc comments', () => {
    const source = `// Line 1
// Line 2
// Line 3
func foo() {}`
    const comments = extractComments(source)
    const doc = findDocComment(comments, 3)
    expect(doc).toBe('Line 1\nLine 2\nLine 3')
  })

  test('block doc comment', () => {
    const source = `/**
 * Block doc comment
 */
func foo() {}`
    const comments = extractComments(source)
    const doc = findDocComment(comments, 3)
    expect(doc).not.toBeNull()
    expect(doc).toContain('Block doc comment')
  })

  test('no doc comment with gap', () => {
    const source = `// This comment

func foo() {}`
    const comments = extractComments(source)
    const doc = findDocComment(comments, 2) // func is on line 2
    expect(doc).toBeNull()
  })

  test('no comments returns null', () => {
    const doc = findDocComment([], 0)
    expect(doc).toBeNull()
  })

  test('comment after declaration is ignored', () => {
    const source = `func foo() {}
// This is not a doc comment`
    const comments = extractComments(source)
    const doc = findDocComment(comments, 0)
    expect(doc).toBeNull()
  })

  test('finds doc for declaration not on first line', () => {
    const source = `let x = 1

// Doc for bar
func bar() {}`
    const comments = extractComments(source)
    const doc = findDocComment(comments, 3)
    expect(doc).toBe('Doc for bar')
  })

  test('ignores unrelated comments', () => {
    const source = `// Comment for foo
func foo() {}

// Comment for bar
func bar() {}`
    const comments = extractComments(source)

    const fooDoc = findDocComment(comments, 1)
    expect(fooDoc).toBe('Comment for foo')

    const barDoc = findDocComment(comments, 4)
    expect(barDoc).toBe('Comment for bar')
  })
})
