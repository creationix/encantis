#!/usr/bin/env bun
/**
 * Build all Encantis examples
 * - Parse .ents files to .ast.json
 * - Compile .ents files to .wat
 * - Convert .wat to .wasm using wabt
 */

import { promises as fs } from 'fs'
import { resolve, dirname, basename } from 'path'
import { fileURLToPath } from 'url'
import wabt from 'wabt'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')
const examplesDir = resolve(projectRoot, 'examples')

interface Example {
  entsFile: string
  astFile: string
  watFile: string
  wasmFile: string
}

async function findExamples(): Promise<Example[]> {
  const examples: Example[] = []

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.name.endsWith('.ents')) {
        const basePath = fullPath.replace(/\.ents$/, '')
        examples.push({
          entsFile: fullPath,
          astFile: `${basePath}.ast.json`,
          watFile: `${basePath}.wat`,
          wasmFile: `${basePath}.wasm`,
        })
      }
    }
  }

  await walk(examplesDir)
  return examples.sort((a, b) => a.entsFile.localeCompare(b.entsFile))
}

async function compileToCLI(entsFile: string): Promise<{ ast: object; wat: string }> {
  const cliPath = resolve(projectRoot, 'packages/cli/dist/cli.js')
  const cliModule = await import(cliPath)

  // Mock argv for CLI
  process.argv = ['bun', cliPath]

  // Parse to AST
  process.argv = ['bun', cliPath, 'ast', entsFile]
  // This is a simplified approach - in reality we'd need to refactor the CLI for library usage
  // For now, we'll use subprocess

  return { ast: {}, wat: '' }
}

async function runCLI(args: string[]): Promise<string> {
  const cliPath = resolve(projectRoot, 'packages/cli/dist/cli.js')
  const proc = Bun.spawn(['bun', cliPath, ...args])
  const output = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const error = await new Response(proc.stderr).text()
    throw new Error(`CLI failed: ${error}`)
  }
  return output
}

async function watToWasm(watFile: string, wasmFile: string): Promise<void> {
  const wasmText = await fs.readFile(watFile, 'utf-8')
  const wabtModule = await wabt()

  try {
    const wasmModule = wabtModule.parseWat('module.wat', wasmText)
    wasmModule.resolveNames()
    wasmModule.validate()
    const { buffer } = wasmModule.toBinary({})
    await fs.writeFile(wasmFile, Buffer.from(buffer))
    console.log(`  ✓ ${wasmFile}`)
  } finally {
    wasmModule.destroy()
  }
}

async function main() {
  console.log('Building Encantis examples...\n')

  const examples = await findExamples()
  if (examples.length === 0) {
    console.log('No .ents files found in examples/')
    return
  }

  // Group by directory
  const byDir = new Map<string, Example[]>()
  for (const example of examples) {
    const dir = dirname(example.entsFile)
    if (!byDir.has(dir)) {
      byDir.set(dir, [])
    }
    byDir.get(dir)!.push(example)
  }

  let successCount = 0
  let errorCount = 0

  for (const [dir, dirExamples] of byDir) {
    const relDir = dir.replace(examplesDir, 'examples').replace(/\\/g, '/')
    console.log(`📁 ${relDir}`)

    for (const example of dirExamples) {
      const filename = basename(example.entsFile)
      try {
        // Parse to AST
        console.log(`  Parsing ${filename}...`)
        const astJson = await runCLI(['ast', example.entsFile, '-o', example.astFile])
        console.log(`    ✓ ${basename(example.astFile)}`)

        // Compile to WAT
        console.log(`  Compiling ${filename}...`)
        const watContent = await runCLI(['compile', example.entsFile, '-o', example.watFile])
        console.log(`    ✓ ${basename(example.watFile)}`)

        // Convert WAT to WASM
        console.log(`  Converting to WASM...`)
        await watToWasm(example.watFile, example.wasmFile)

        successCount++
      } catch (error) {
        console.error(`  ✗ Error processing ${filename}:`, error instanceof Error ? error.message : error)
        errorCount++
      }
    }
    console.log('')
  }

  console.log(`Summary: ${successCount} success, ${errorCount} errors`)
  if (errorCount > 0) {
    process.exit(1)
  }
}

await main()
