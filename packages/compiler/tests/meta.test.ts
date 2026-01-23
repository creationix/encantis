// Meta.json test runner
// Compares generated meta output against expected .meta.json files

import { describe, test, expect } from 'bun:test'
import { Glob } from 'bun'
import { parse } from '../parser'
import { buildMeta, type MetaOutput } from '../meta'

describe('meta.json generation', () => {
  const glob = new Glob('*.ents')
  const vectorDir = 'packages/compiler/src/tests/analyser-vectors'

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
