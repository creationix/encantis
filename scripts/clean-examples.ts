#!/usr/bin/env bun
/**
 * Clean all build artifacts from examples
 * Removes: *.ast.json, *.wat, *.wasm, *.opt.wasm, *.opt.wat
 */

import { promises as fs } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')
const examplesDir = resolve(projectRoot, 'examples')

const PATTERNS = ['.ast.json', '.wat', '.wasm', '.opt.wasm', '.opt.wat']

async function main() {
  console.log('Cleaning Encantis examples...\n')

  let deletedCount = 0

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else {
        for (const pattern of PATTERNS) {
          if (entry.name.endsWith(pattern)) {
            try {
              await fs.unlink(fullPath)
              const relPath = fullPath.replace(examplesDir, 'examples').replace(/\\/g, '/')
              console.log(`  ✓ Removed ${relPath}`)
              deletedCount++
            } catch (error) {
              console.error(`  ✗ Failed to remove ${fullPath}: ${error}`)
            }
            break
          }
        }
      }
    }
  }

  await walk(examplesDir)

  console.log(`\nCleaned: ${deletedCount} files removed`)
}

await main()
