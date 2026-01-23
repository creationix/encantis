#!/usr/bin/env bun
/**
 * Check all Encantis examples for errors
 * Runs the CLI 'check' command on all .ents files
 */

import { promises as fs } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')
const examplesDir = resolve(projectRoot, 'examples')

async function findEntsFiles(): Promise<string[]> {
  const files: string[] = []

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.name.endsWith('.ents')) {
        files.push(fullPath)
      }
    }
  }

  await walk(examplesDir)
  return files.sort()
}

async function checkFile(entsFile: string): Promise<boolean> {
  const cliPath = resolve(projectRoot, 'packages/cli/dist/cli.js')
  const proc = Bun.spawn(['bun', cliPath, 'check', entsFile], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await proc.exited
  return exitCode === 0
}

async function main() {
  console.log('Checking Encantis examples for errors...\n')

  const files = await findEntsFiles()
  if (files.length === 0) {
    console.log('No .ents files found in examples/')
    return
  }

  let passCount = 0
  let failCount = 0

  for (const file of files) {
    const relPath = file.replace(examplesDir, 'examples').replace(/\\/g, '/')
    process.stdout.write(`Checking ${relPath}... `)
    try {
      const success = await checkFile(file)
      if (success) {
        console.log('✓')
        passCount++
      } else {
        console.log('✗')
        failCount++
      }
    } catch (error) {
      console.log('✗')
      console.error(`  Error: ${error instanceof Error ? error.message : error}`)
      failCount++
    }
  }

  console.log(`\nSummary: ${passCount} passed, ${failCount} failed`)
  if (failCount > 0) {
    process.exit(1)
  }
}

await main()
