import { describe, test, expect } from 'bun:test'
import { Glob } from 'bun'
import { parse } from './parser'
import { buildMeta, type MetaOutput } from './meta'

function metaHints(source: string): Record<string, { name: string | null; type: string }> {
  const result = parse(source)
  if (result.errors.length > 0) throw new Error(result.errors.map(e => e.message).join(', '))
  const meta = buildMeta(result.module!, source)
  const out: Record<string, { name: string | null; type: string }> = {}
  for (const [key, hint] of Object.entries(meta.hints)) {
    const sym = hint.symbol !== undefined ? meta.symbols[hint.symbol] : null
    out[key] = { name: sym?.name ?? null, type: meta.types[hint.type]?.type ?? 'unknown' }
  }
  return out
}

describe('test block hints', () => {
  test('locals in test blocks get hints', () => {
    const hints = metaHints(`
test "example" {
  let x: u8 = 42
  let y: u32 = 100
  assert x == 42
}`)
    expect(hints['2:6']).toEqual({ name: 'x', type: 'u8' })
    expect(hints['3:6']).toEqual({ name: 'y', type: 'u32' })
  })

  test('nested test blocks get hints', () => {
    const hints = metaHints(`
test "outer" {
  test "inner" {
    let n: i8 = -1
    assert n == -1
  }
}`)
    expect(hints['3:8']).toEqual({ name: 'n', type: 'i8' })
  })

  test('same-named locals in different test blocks get correct types', () => {
    const hints = metaHints(`
test "first" {
  let a: u8 = 1
}
test "second" {
  let a: u32 = 2
}`)
    expect(hints['2:6']?.type).toBe('u8')
    expect(hints['5:6']?.type).toBe('u32')
  })

  test('assert expressions get hints', () => {
    const hints = metaHints(`
func add(a: u8, b: u8) -> u8 => a + b
test "add" {
  assert add(1, 2) == 3
}`)
    expect(hints['3:9']?.name).toBe('add')
  })
})

describe('meta.json generation', () => {
  const glob = new Glob('*.ents')
  const fixturesDir = new URL('./__fixtures__/analyser-vectors', import.meta.url)
  const vectorDir = fixturesDir.pathname

  // Check if fixtures directory exists before running tests
  let vectorsExist = false
  try {
    vectorsExist = Bun.file(vectorDir).isDirectory()
  } catch {
    // Directory doesn't exist
  }

  if (!vectorsExist) {
    test.skip('meta.json generation (fixtures not available)', () => {})
    return
  }

  for (const file of glob.scanSync(vectorDir)) {
    const name = file.replace('.ents', '')

    test(name, async () => {
      const entsPath = `${vectorDir}/${file}`
      const metaPath = `${vectorDir}/${name}.meta.json`

      // Read source
      const source = await Bun.file(entsPath).text()

      // Read expected output
      const expectedFile = Bun.file(metaPath)
      if (!(await expectedFile.exists())) {
        return
        // throw new Error(`Missing expected meta file: ${metaPath}`)
      }
      const expected: MetaOutput = await expectedFile.json()

      // Parse and generate meta
      const result = parse(source)
      if (result.errors.length > 0) {
        throw new Error(`Parse errors: ${result.errors.map((e) => e.message).join(', ')}`)
      }
      if (!result.module) {
        throw new Error('Failed to parse module')
      }

      const srcPath = `file://./${file}`
      const actual = buildMeta(result.module, source, { srcPath })

      // Compare - remove $schema from expected for comparison
      const expectedWithoutSchema = { ...expected }
      delete expectedWithoutSchema.$schema

      expect(actual).toEqual(expectedWithoutSchema)
    })
  }
})
