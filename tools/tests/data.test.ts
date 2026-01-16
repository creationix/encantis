import { describe, expect, it } from 'bun:test'
import { readdirSync, existsSync } from 'fs'
import { join, basename } from 'path'
import { parse } from '../parser'
import { buildDataSection } from '../data'

const dataDir = join(import.meta.dir, 'data')

interface NodeInfo {
  dataOffset?: number
  type?: number
}

interface ExpectedMeta {
  data: Record<string, string> // dataOffset → hex bytes
  types: Record<string, string> // typeName → stringified type
  unique: Record<string, string> // uniqueName → stringified type
  nodes: Record<string, NodeInfo> // astOffset → node info
  errors: string[]
}

// Discover all test vectors
function discoverVectors(): {
  name: string
  entsPath: string
  metaPath: string
}[] {
  const vectors: { name: string; entsPath: string; metaPath: string }[] = []

  if (!existsSync(dataDir)) {
    return vectors
  }

  const files = readdirSync(dataDir)
  const entsFiles = files.filter((f) => f.endsWith('.ents'))

  for (const entsFile of entsFiles) {
    const name = basename(entsFile, '.ents')
    const entsPath = join(dataDir, entsFile)
    const metaPath = join(dataDir, `${name}.meta.json`)
    vectors.push({ name, entsPath, metaPath })
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
  metaPath: string,
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
  if (!existsSync(metaPath)) {
    details.push(`Missing expected output: ${metaPath}`)
    details.push('Actual:')
    details.push('  data:')
    for (const entry of dataSection.entries) {
      details.push(`    "${entry.offset}": "${bytesToHex(entry.bytes)}"`)
    }
    details.push('  nodes:')
    for (const [astOffset, entry] of dataSection.literalMap) {
      details.push(`    "${astOffset}": { "dataOffset": ${entry.offset} }`)
    }
    if (dataSection.errors.length > 0) {
      details.push('  errors:')
      for (const error of dataSection.errors) {
        details.push(`    "${error}"`)
      }
    }
    return { passed: false, details }
  }

  const expected: ExpectedMeta = await Bun.file(metaPath).json()
  let passed = true

  // Build actual data map
  const actualData: Record<string, string> = {}
  for (const entry of dataSection.entries) {
    actualData[String(entry.offset)] = bytesToHex(entry.bytes)
  }

  // Compare data
  const expectedDataKeys = Object.keys(expected.data).sort(
    (a, b) => Number(a) - Number(b),
  )
  const actualDataKeys = Object.keys(actualData).sort(
    (a, b) => Number(a) - Number(b),
  )

  if (expectedDataKeys.length !== actualDataKeys.length) {
    details.push(
      `Data entry count mismatch: expected ${expectedDataKeys.length}, got ${actualDataKeys.length}`,
    )
    details.push(`  Expected offsets: ${expectedDataKeys.join(', ')}`)
    details.push(`  Actual offsets: ${actualDataKeys.join(', ')}`)
    passed = false
  } else {
    for (const offset of expectedDataKeys) {
      const expHex = expected.data[offset]
      const actHex = actualData[offset]
      if (actHex === undefined) {
        details.push(`Missing data at offset ${offset}`)
        passed = false
      } else if (actHex !== expHex) {
        details.push(
          `Data at offset ${offset} mismatch: expected ${expHex}, got ${actHex}`,
        )
        passed = false
      }
    }
  }

  // Compare nodes (literal mappings)
  for (const [astOffsetStr, nodeInfo] of Object.entries(expected.nodes)) {
    const astOffset = Number(astOffsetStr)
    if (nodeInfo.dataOffset !== undefined) {
      const entry = dataSection.literalMap.get(astOffset)
      if (!entry) {
        details.push(`Missing literal mapping for AST offset ${astOffset}`)
        passed = false
      } else if (entry.offset !== nodeInfo.dataOffset) {
        details.push(
          `Literal at AST ${astOffset}: expected dataOffset ${nodeInfo.dataOffset}, got ${entry.offset}`,
        )
        passed = false
      }
    }
  }

  // Compare errors
  if (expected.errors.length !== dataSection.errors.length) {
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
    for (const { name, entsPath, metaPath } of vectors) {
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
