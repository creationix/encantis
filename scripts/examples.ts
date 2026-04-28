#!/usr/bin/env bun

import { loadModule } from '@encantis/compiler/loader'
import { typecheckProgram } from '@encantis/compiler/checker'
import { programToWat } from '@encantis/compiler/codegen'
import { resolve, dirname, basename, relative } from 'path'
import { readdir, unlink } from 'fs/promises'
import wabt from 'wabt'

const command = process.argv[2]
if (!command || !['check', 'all', 'clean'].includes(command)) {
  console.log('Usage: bun scripts/examples.ts <check|all|clean>')
  process.exit(1)
}

const examplesDir = resolve(import.meta.dir, '../examples')

async function findEntryFiles(): Promise<string[]> {
  const entries: string[] = []
  const dirEntries = new Map<string, string[]>()

  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.name.endsWith('.ents')) {
        const d = dirname(full)
        if (!dirEntries.has(d)) dirEntries.set(d, [])
        dirEntries.get(d)!.push(full)
      }
    }
  }

  await walk(examplesDir)

  for (const [dir, files] of dirEntries) {
    const dirName = basename(dir)
    const mainFile = files.find(f => basename(f) === 'main.ents')
    const namedFile = files.find(f => basename(f) === `${dirName}.ents`)
    if (mainFile) {
      entries.push(mainFile)
    } else if (namedFile) {
      entries.push(namedFile)
    } else {
      for (const f of files) entries.push(f)
    }
  }

  return entries.sort()
}

async function findArtifacts(): Promise<string[]> {
  const artifacts: string[] = []
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.name.endsWith('.wat') || entry.name.endsWith('.wasm')) {
        artifacts.push(full)
      }
    }
  }
  await walk(examplesDir)
  return artifacts
}

const entries = command !== 'clean' ? await findEntryFiles() : []

if (command === 'clean') {
  const artifacts = await findArtifacts()
  for (const f of artifacts) {
    await unlink(f)
    console.log(`  rm ${relative(process.cwd(), f)}`)
  }
  console.log(`Cleaned ${artifacts.length} artifacts`)
  process.exit(0)
}

let passed = 0
let failed = 0
const failures: string[] = []

for (const entry of entries) {
  const rel = relative(process.cwd(), entry)
  const load = await loadModule(entry)

  if (load.errors.length > 0) {
    console.log(`FAIL ${rel}: ${load.errors[0].message}`)
    failed++
    failures.push(rel)
    continue
  }

  const check = typecheckProgram(load.modules, entry)
  if (check.errors.length > 0) {
    console.log(`FAIL ${rel}: ${check.errors[0].message}`)
    failed++
    failures.push(rel)
    continue
  }

  if (command === 'check') {
    console.log(`  ok ${rel}`)
    passed++
    continue
  }

  // command === 'all': generate WAT and WASM
  let wat: string
  try {
    wat = programToWat(load.modules, check.results, entry)
  } catch (e: any) {
    console.log(`FAIL ${rel}: codegen: ${e.message}`)
    failed++
    failures.push(rel)
    continue
  }

  const watPath = entry.replace(/\.ents$/, '.wat')
  await Bun.write(watPath, wat)

  const w = await wabt()
  let wasmModule
  try {
    wasmModule = w.parseWat(rel, wat, { simd: true, multi_value: true, bulk_memory: true })
    wasmModule.validate()
  } catch (e: any) {
    console.log(`FAIL ${rel}: wat→wasm: ${e.message.split('\n')[0]}`)
    failed++
    failures.push(rel)
    wasmModule?.destroy()
    continue
  }

  const { buffer } = wasmModule.toBinary({})
  wasmModule.destroy()
  const wasmPath = entry.replace(/\.ents$/, '.wasm')
  await Bun.write(wasmPath, buffer)

  console.log(`  ok ${rel} → ${buffer.length} bytes`)
  passed++
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failures.length > 0) {
  console.log('Failures:')
  for (const f of failures) console.log(`  ${f}`)
}
process.exit(command === 'check' && failed > 0 ? 1 : 0)
