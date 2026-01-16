import { describe, expect, it } from 'bun:test'
import { readdirSync, existsSync } from 'fs'
import { join, basename } from 'path'
import { parse } from '../parser'
import { check } from '../checker'
import { typeToString } from '../types'

const typesDir = join(import.meta.dir, 'types')

interface ExpectedType {
  offset: number
  source: string
  type: string
}

interface ExpectedError {
  offset: number
  message: string
}

interface ExpectedOutput {
  symbols?: Record<string, unknown>
  types?: ExpectedType[]
  errors?: ExpectedError[]
}

// Discover all test vector directories
function discoverVectors(): { category: string; name: string; entsPath: string; jsonPath: string }[] {
  const vectors: { category: string; name: string; entsPath: string; jsonPath: string }[] = []

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
      const jsonPath = join(categoryDir, `${name}.types.json`)

      vectors.push({ category, name, entsPath, jsonPath })
    }
  }

  return vectors
}

// Run a single test vector
async function runVector(entsPath: string, jsonPath: string): Promise<{
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
  if (!existsSync(jsonPath)) {
    details.push(`Missing expected output: ${jsonPath}`)
    details.push('Actual types:')
    for (const [offset, type] of checkResult.types) {
      details.push(`  ${offset}: ${typeToString(type)}`)
    }
    return { passed: false, details }
  }

  const expected: ExpectedOutput = await Bun.file(jsonPath).json()

  let passed = true

  // Compare types
  if (expected.types) {
    for (const exp of expected.types) {
      const actual = checkResult.types.get(exp.offset)
      if (!actual) {
        details.push(`Missing type at offset ${exp.offset} (${exp.source})`)
        details.push(`  Expected: ${exp.type}`)
        passed = false
      } else {
        const actualStr = typeToString(actual)
        if (actualStr !== exp.type) {
          details.push(`Type mismatch at offset ${exp.offset} (${exp.source})`)
          details.push(`  Expected: ${exp.type}`)
          details.push(`  Actual:   ${actualStr}`)
          passed = false
        }
      }
    }
  }

  // Compare errors
  if (expected.errors) {
    for (const exp of expected.errors) {
      const actual = checkResult.errors.find(
        (e) => e.offset === exp.offset && e.message.includes(exp.message),
      )
      if (!actual) {
        details.push(`Missing error at offset ${exp.offset}`)
        details.push(`  Expected: ${exp.message}`)
        passed = false
      }
    }

    // Check for unexpected errors
    for (const actual of checkResult.errors) {
      const exp = expected.errors.find(
        (e) => e.offset === actual.offset && actual.message.includes(e.message),
      )
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
      // Placeholder - no vectors to run
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
        for (const { name, entsPath, jsonPath } of categoryVectors) {
          it(name, async () => {
            const result = await runVector(entsPath, jsonPath)
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
