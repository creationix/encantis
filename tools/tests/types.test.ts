import { describe, expect, it } from 'bun:test'
import { readdirSync, existsSync } from 'fs'
import { join, basename } from 'path'
import { parse } from '../parser'
import { check } from '../checker'
import { typeToString } from '../types'

const typesDir = join(import.meta.dir, 'types')

interface NodeInfo {
  dataOffset?: number
  type?: string
}

interface ExpectedMeta {
  data: Record<string, string>
  types: Record<string, string>
  unique: Record<string, string>
  nodes: Record<string, NodeInfo>
  errors: string[]
}

// Discover all test vector directories
function discoverVectors(): {
  category: string
  name: string
  entsPath: string
  metaPath: string
}[] {
  const vectors: {
    category: string
    name: string
    entsPath: string
    metaPath: string
  }[] = []

  if (!existsSync(typesDir)) {
    return vectors
  }

  const categories = readdirSync(typesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)

  for (const category of categories) {
    const categoryDir = join(typesDir, category)
    const files = readdirSync(categoryDir)
    const entsFiles = files.filter((f) => f.endsWith('.ents'))

    for (const entsFile of entsFiles) {
      const name = basename(entsFile, '.ents')
      const entsPath = join(categoryDir, entsFile)
      const metaPath = join(categoryDir, `${name}.meta.json`)

      vectors.push({ category, name, entsPath, metaPath })
    }
  }

  return vectors
}

// Run a single test vector
async function runVector(
  entsPath: string,
  metaPath: string,
): Promise<{
  passed: boolean
  details: string[]
}> {
  const details: string[] = []

  // Read source
  const source = await Bun.file(entsPath).text()

  // Parse
  const parseResult = parse(source, { filePath: entsPath })
  if (parseResult.errors.length > 0) {
    details.push(`Parse error: ${parseResult.errors[0].message}`)
    return { passed: false, details }
  }

  if (!parseResult.module) {
    details.push('No module produced')
    return { passed: false, details }
  }

  // Type check
  const checkResult = check(parseResult.module)

  // Load expected output
  if (!existsSync(metaPath)) {
    details.push(`Missing expected output: ${metaPath}`)
    details.push('Actual types:')
    for (const [offset, type] of checkResult.types) {
      details.push(`  "${offset}": { "type": "${typeToString(type)}" }`)
    }
    return { passed: false, details }
  }

  const expected: ExpectedMeta = await Bun.file(metaPath).json()

  let passed = true

  // Compare node types
  for (const [offsetStr, nodeInfo] of Object.entries(expected.nodes)) {
    const offset = Number(offsetStr)
    if (nodeInfo.type !== undefined) {
      const actual = checkResult.types.get(offset)
      if (!actual) {
        details.push(`Missing type at offset ${offset}`)
        details.push(`  Expected: ${nodeInfo.type}`)
        passed = false
      } else {
        const actualStr = typeToString(actual)
        if (actualStr !== nodeInfo.type) {
          details.push(`Type mismatch at offset ${offset}`)
          details.push(`  Expected: ${nodeInfo.type}`)
          details.push(`  Actual:   ${actualStr}`)
          passed = false
        }
      }
    }
  }

  // Compare errors
  if (expected.errors.length > 0) {
    for (const expMsg of expected.errors) {
      const actual = checkResult.errors.find((e) => e.message.includes(expMsg))
      if (!actual) {
        details.push(`Missing error: ${expMsg}`)
        passed = false
      }
    }

    // Check for unexpected errors
    for (const actual of checkResult.errors) {
      const exp = expected.errors.find((e) => actual.message.includes(e))
      if (!exp) {
        details.push(`Unexpected error at offset ${actual.offset}`)
        details.push(`  ${actual.message}`)
        passed = false
      }
    }
  } else if (checkResult.errors.length > 0) {
    // No errors expected but some found
    for (const err of checkResult.errors) {
      details.push(`Unexpected error at offset ${err.offset}`)
      details.push(`  ${err.message}`)
    }
    passed = false
  }

  return { passed, details }
}

// Generate tests from discovered vectors
const vectors = discoverVectors()

if (vectors.length === 0) {
  describe('types', () => {
    it('has no test vectors yet', () => {
      expect(true).toBe(true)
    })
  })
} else {
  // Group by category
  const byCategory = new Map<string, typeof vectors>()
  for (const v of vectors) {
    const list = byCategory.get(v.category) ?? []
    list.push(v)
    byCategory.set(v.category, list)
  }

  describe('types', () => {
    for (const [category, categoryVectors] of byCategory) {
      describe(category, () => {
        for (const { name, entsPath, metaPath } of categoryVectors) {
          it(name, async () => {
            const result = await runVector(entsPath, metaPath)
            if (!result.passed) {
              const message = result.details.join('\n')
              expect(message).toBe('')
            }
          })
        }
      })
    }
  })
}
