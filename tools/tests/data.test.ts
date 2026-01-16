import { describe, expect, it } from 'bun:test'
import { readdirSync, existsSync } from 'fs'
import { join, basename } from 'path'
import { parse } from '../parser'
import { buildDataSection, serializeDataSection, dataToWat } from '../data'

const dataDir = join(import.meta.dir, 'data')

interface ExpectedEntry {
  offset: number
  bytes: string // hex string of bytes (without null terminator)
  length: number
}

interface ExpectedLiteral {
  astOffset: number // AST node start offset
  dataOffset: number // Where it was placed in the data section
}

interface ExpectedOutput {
  entries?: ExpectedEntry[]
  literals?: ExpectedLiteral[]
  totalSize?: number
  autoDataStart?: number
  errors?: string[]
}

// Discover all test vector directories
function discoverVectors(): {
  name: string
  entsPath: string
  jsonPath: string
}[] {
  const vectors: { name: string; entsPath: string; jsonPath: string }[] = []

  if (!existsSync(dataDir)) {
    return vectors
  }

  const files = readdirSync(dataDir)
  const entsFiles = files.filter((f) => f.endsWith('.ents'))

  for (const entsFile of entsFiles) {
    const name = basename(entsFile, '.ents')
    const entsPath = join(dataDir, entsFile)
    const jsonPath = join(dataDir, `${name}.data.json`)
    vectors.push({ name, entsPath, jsonPath })
  }

  return vectors
}

// Convert Uint8Array to hex string
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// Run a single test vector
async function runVector(
  entsPath: string,
  jsonPath: string,
): Promise<{ passed: boolean; details: string[] }> {
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

  // Build data section
  const dataSection = buildDataSection(parseResult.module)

  // Load expected output
  if (!existsSync(jsonPath)) {
    details.push(`Missing expected output: ${jsonPath}`)
    details.push('Actual data section:')
    details.push(`  totalSize: ${dataSection.totalSize}`)
    details.push(`  autoDataStart: ${dataSection.autoDataStart}`)
    details.push('  entries:')
    for (const entry of dataSection.entries) {
      details.push(
        `    offset=${entry.offset} len=${entry.length} bytes=${bytesToHex(entry.bytes)}`,
      )
    }
    details.push('  literals:')
    for (const [astOffset, entry] of dataSection.literalMap) {
      details.push(`    ast=${astOffset} → data=${entry.offset}`)
    }
    if (dataSection.errors.length > 0) {
      details.push('  errors:')
      for (const error of dataSection.errors) {
        details.push(`    ${error}`)
      }
    }
    return { passed: false, details }
  }

  const expected: ExpectedOutput = await Bun.file(jsonPath).json()
  let passed = true

  // Compare totalSize
  if (expected.totalSize !== undefined) {
    if (dataSection.totalSize !== expected.totalSize) {
      details.push(
        `totalSize mismatch: expected ${expected.totalSize}, got ${dataSection.totalSize}`,
      )
      passed = false
    }
  }

  // Compare autoDataStart
  if (expected.autoDataStart !== undefined) {
    if (dataSection.autoDataStart !== expected.autoDataStart) {
      details.push(
        `autoDataStart mismatch: expected ${expected.autoDataStart}, got ${dataSection.autoDataStart}`,
      )
      passed = false
    }
  }

  // Compare entries
  if (expected.entries) {
    if (dataSection.entries.length !== expected.entries.length) {
      details.push(
        `Entry count mismatch: expected ${expected.entries.length}, got ${dataSection.entries.length}`,
      )
      passed = false
    } else {
      for (let i = 0; i < expected.entries.length; i++) {
        const exp = expected.entries[i]
        const act = dataSection.entries[i]
        if (act.offset !== exp.offset) {
          details.push(
            `Entry ${i} offset mismatch: expected ${exp.offset}, got ${act.offset}`,
          )
          passed = false
        }
        if (act.length !== exp.length) {
          details.push(
            `Entry ${i} length mismatch: expected ${exp.length}, got ${act.length}`,
          )
          passed = false
        }
        const actHex = bytesToHex(act.bytes)
        if (actHex !== exp.bytes) {
          details.push(
            `Entry ${i} bytes mismatch: expected ${exp.bytes}, got ${actHex}`,
          )
          passed = false
        }
      }
    }
  }

  // Compare literal mappings
  if (expected.literals) {
    for (const exp of expected.literals) {
      const entry = dataSection.literalMap.get(exp.astOffset)
      if (!entry) {
        details.push(`Missing literal mapping for AST offset ${exp.astOffset}`)
        passed = false
      } else if (entry.offset !== exp.dataOffset) {
        details.push(
          `Literal at AST ${exp.astOffset}: expected data offset ${exp.dataOffset}, got ${entry.offset}`,
        )
        passed = false
      }
    }
  }

  // Compare errors
  if (expected.errors) {
    if (dataSection.errors.length !== expected.errors.length) {
      details.push(
        `Error count mismatch: expected ${expected.errors.length}, got ${dataSection.errors.length}`,
      )
      if (dataSection.errors.length > 0) {
        details.push(`  Actual errors: ${dataSection.errors.join('; ')}`)
      }
      passed = false
    } else {
      for (let i = 0; i < expected.errors.length; i++) {
        if (!dataSection.errors[i].includes(expected.errors[i])) {
          details.push(
            `Error ${i} mismatch: expected to contain "${expected.errors[i]}", got "${dataSection.errors[i]}"`,
          )
          passed = false
        }
      }
    }
  } else if (dataSection.errors.length > 0) {
    details.push(`Unexpected errors: ${dataSection.errors.join('; ')}`)
    passed = false
  }

  return { passed, details }
}

// Generate tests from discovered vectors
const vectors = discoverVectors()

if (vectors.length === 0) {
  describe('data', () => {
    it('has no test vectors yet', () => {
      expect(true).toBe(true)
    })
  })
} else {
  describe('data', () => {
    for (const { name, entsPath, jsonPath } of vectors) {
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
