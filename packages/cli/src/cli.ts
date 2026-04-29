#!/usr/bin/env bun

import { parse } from '@encantis/compiler/parser'
import { typecheck, typecheckProgram } from '@encantis/compiler/checker'
import { buildMeta } from '@encantis/compiler/meta'
import { moduleToWat, programToWat, programToWatWithTests } from '@encantis/compiler/codegen'
import { loadModule } from '@encantis/compiler/loader'
import { bigintReplacer } from '@encantis/compiler/utils'
import { gotoDefinition, hover, findReferences, documentSymbols, signatureHelp, workspaceSymbols, rename } from '@encantis/compiler/queries'
import { LineMap } from '@encantis/compiler/position'
import { resolve } from 'node:path'
import wabt from 'wabt'

const args = process.argv.slice(2)

function usage() {
  console.log(`Encantis Compiler

Usage: encantis <command> [options]

Commands:
  check <file>                    Parse and check file for errors
  ast <file> [-o out]             Parse file and output AST as JSON
  meta <file> [-o out]            Generate meta.json (types, symbols, hints)
  compile <file> [-o out]         Compile file to WAT
  wasm <file> [-o out]            Compile file to WASM binary
  definition <file>:<line>:<col|name>  Go to definition of symbol
  hover <file>:<line>:<col|name>       Show type info for symbol
  references <file>:<line>:<col|name>  Find all references to symbol
  symbols [<file|dir>]                 List document or workspace symbols
  signature <file>:<line>:<col|name>   Show function signature
  rename <file>:<line>:<col|name>      Find all locations for rename
  test <file>                           Run inline tests
  fmt <file...>                        Format source files in place
  fmt --check <file...>                Check formatting without changing

Options:
  -o <file>       Output file (default: stdout)
  --json          Output as JSON (for query commands)
  -s, --start <rule>  Start rule for parsing (default: Module)
  --help          Show this help
`)
}

if (args.length === 0 || args.includes('--help')) {
  usage()
  process.exit(0)
}

const command = args[0]

// Parse remaining arguments
let inputFile: string | undefined
let outputFile: string | undefined
let startRule: string | undefined
let jsonOutput = false

for (let i = 1; i < args.length; i++) {
  if (args[i] === '-o') {
    outputFile = args[++i]
    if (!outputFile) {
      console.error('Error: -o requires an output file')
      process.exit(1)
    }
  } else if (args[i] === '-s' || args[i] === '--start') {
    startRule = args[++i]
    if (!startRule) {
      console.error('Error: -s/--start requires a rule name')
      process.exit(1)
    }
  } else if (args[i] === '--json') {
    jsonOutput = true
  } else if (!inputFile) {
    inputFile = args[i]
  }
}

// Parse file:line:col or file:line:name for query commands
// file:line:col — exact position (1-indexed)
// file:line:name — find symbol `name` on that line (LLM-friendly)
async function parseFilePos(arg: string): Promise<{ file: string; line: number; col: number } | null> {
  const match = arg.match(/^(.+):(\d+):(.+)$/)
  if (!match) return null
  const file = match[1]
  const line = parseInt(match[2]) - 1
  const third = match[3]

  // If third part is all digits, it's a column number
  if (/^\d+$/.test(third)) {
    return { file, line, col: parseInt(third) - 1 }
  }

  // Otherwise it's a symbol name — find it on the specified line
  const source = await Bun.file(file).text()
  const lines = source.split('\n')
  if (line < 0 || line >= lines.length) return null
  const lineText = lines[line]
  const nameIdx = lineText.indexOf(third)
  if (nameIdx === -1) {
    console.error(`'${third}' not found on line ${line + 1} of ${file}`)
    process.exit(1)
  }
  return { file, line, col: nameIdx }
}

if (!inputFile) {
  console.error('Error: Missing file argument')
  usage()
  process.exit(1)
}

// Helper to write output
async function output(content: string) {
  if (outputFile) {
    await Bun.write(outputFile, content)
  } else {
    console.log(content)
  }
}

// Read source for non-query commands
let source = ''
let filePath = inputFile
const queryCommands = ['definition', 'hover', 'references', 'signature', 'symbols', 'rename', 'fmt', 'test']
if (!queryCommands.includes(command)) {
  const file = Bun.file(inputFile)
  if (!(await file.exists())) {
    console.error(`Error: File not found: ${inputFile}`)
    process.exit(1)
  }
  source = await file.text()
  filePath = file.name ?? inputFile
}

switch (command) {
  case 'ast': {
    const result = parse(source, { filePath, startRule })

    if (result.errors.length > 0) {
      for (const error of result.errors) {
        const loc = offsetToLineCol(source, error.span.start)
        console.error(
          `${filePath}:${loc.line}:${loc.column}: ${error.shortMessage}`,
        )
        console.error(error.message)
      }
      process.exit(1)
    }

    // Output AST as JSON
    const json = JSON.stringify(result.module, bigintReplacer, 2)
    await output(json)
    break
  }

  case 'check': {
    const entryPath = resolve(inputFile)
    const load = await loadModule(entryPath)

    if (load.errors.length > 0) {
      if (jsonOutput) {
        console.log(JSON.stringify(load.errors.map(e => ({ file: e.filePath, message: e.message }))))
      } else {
        for (const error of load.errors) {
          console.error(`${error.filePath}: ${error.message}`)
        }
      }
      process.exit(1)
    }

    const check = typecheckProgram(load.modules, entryPath)

    if (check.errors.length > 0) {
      const diagnostics: { file: string; line: number; col: number; message: string }[] = []
      for (const [path, result] of check.results) {
        const modSource = load.modules.get(path)?.source ?? ''
        for (const error of result.errors) {
          const loc = offsetToLineCol(modSource, error.offset)
          diagnostics.push({ file: path, line: loc.line, col: loc.column, message: error.message })
        }
      }
      if (jsonOutput) {
        console.log(JSON.stringify(diagnostics))
      } else {
        for (const d of diagnostics) {
          console.error(`${d.file}:${d.line}:${d.col}: ${d.message}`)
        }
      }
      process.exit(1)
    }

    const moduleCount = load.modules.size
    const declCount = [...load.modules.values()].reduce((sum, m) => sum + m.module.decls.length, 0)
    if (jsonOutput) {
      console.log(JSON.stringify({ ok: true, modules: moduleCount, declarations: declCount }))
    } else {
      console.log(`OK: ${declCount} declarations across ${moduleCount} module${moduleCount > 1 ? 's' : ''}`)
    }
    break
  }

  case 'meta': {
    const result = parse(source, { filePath })

    if (result.errors.length > 0) {
      for (const error of result.errors) {
        const loc = offsetToLineCol(source, error.span.start)
        console.error(
          `${filePath}:${loc.line}:${loc.column}: ${error.shortMessage}`,
        )
        console.error(error.message)
      }
      process.exit(1)
    }

    if (!result.module) {
      console.error('Error: Failed to parse module')
      process.exit(1)
    }

    // Generate meta.json
    const srcPath = `file://./${inputFile.split('/').pop()}`
    const meta = buildMeta(result.module, source, { srcPath })
    const json = JSON.stringify(meta, bigintReplacer, 2)
    await output(json)
    break
  }

  case 'compile':
  case 'wasm': {
    const entryPath = resolve(inputFile)
    const load = await loadModule(entryPath)

    if (load.errors.length > 0) {
      for (const error of load.errors) {
        console.error(`${error.filePath}: ${error.message}`)
      }
      process.exit(1)
    }

    const check = typecheckProgram(load.modules, entryPath)

    if (check.errors.length > 0) {
      for (const [path, result] of check.results) {
        const modSource = load.modules.get(path)?.source ?? ''
        for (const error of result.errors) {
          const loc = offsetToLineCol(modSource, error.offset)
          console.error(`${path}:${loc.line}:${loc.column}: ${error.message}`)
        }
      }
      process.exit(1)
    }

    const wat = programToWat(load.modules, check.results, entryPath)

    if (command === 'wasm') {
      const w = await wabt()
      let wasmModule
      try {
        wasmModule = w.parseWat(inputFile, wat, { simd: true, multi_value: true, bulk_memory: true })
        wasmModule.validate()
      } catch (e: any) {
        console.error(`WAT error: ${e.message}`)
        process.exit(1)
      }
      const { buffer } = wasmModule.toBinary({})
      wasmModule.destroy()
      const outPath = outputFile ?? inputFile.replace(/\.ents$/, '.wasm')
      await Bun.write(outPath, buffer)
      console.error(`Wrote ${buffer.length} bytes to ${outPath}`)
    } else {
      await output(wat)
    }
    break
  }

  case 'definition':
  case 'hover':
  case 'references':
  case 'signature':
  case 'rename': {
    const pos = inputFile ? await parseFilePos(inputFile) : null
    if (!pos) {
      console.error('Error: expected <file>:<line>:<col>')
      process.exit(1)
    }
    const qSource = await Bun.file(pos.file).text()
    const qResult = parse(qSource, { filePath: pos.file })
    if (qResult.errors.length > 0) {
      console.error(qResult.errors[0].message)
      process.exit(1)
    }
    const qCheck = typecheck(qResult.module!)
    const lineMap = new LineMap(qSource)
    const offset = lineMap.positionToOffset({ line: pos.line, col: pos.col })

    if (command === 'definition') {
      const r = gotoDefinition(qSource, qResult.module!, qCheck, offset)
      if (!r) { console.log('No definition found'); process.exit(1) }
      const defPos = lineMap.offsetToPosition(r.location.offset)
      if (jsonOutput) {
        console.log(JSON.stringify({ name: r.name, file: pos.file, line: defPos.line + 1, col: defPos.col + 1 }))
      } else {
        console.log(`${pos.file}:${defPos.line + 1}:${defPos.col + 1} ${r.name}`)
      }
    } else if (command === 'hover') {
      const r = hover(qSource, qResult.module!, qCheck, offset)
      if (!r) { console.log('No info'); process.exit(1) }
      if (jsonOutput) {
        console.log(JSON.stringify(r))
      } else {
        console.log(`${r.kind} ${r.name}: ${r.type}${r.value !== undefined ? ` = ${r.value}` : ''}`)
      }
    } else if (command === 'references') {
      const r = findReferences(qSource, qResult.module!, qCheck, offset)
      if (!r) { console.log('No references found'); process.exit(1) }
      if (jsonOutput) {
        const locs = r.references.map(ref => {
          const p = lineMap.offsetToPosition(ref.offset)
          return { file: pos.file, line: p.line + 1, col: p.col + 1 }
        })
        console.log(JSON.stringify(locs))
      } else {
        for (const ref of r.references) {
          const p = lineMap.offsetToPosition(ref.offset)
          console.log(`${pos.file}:${p.line + 1}:${p.col + 1}`)
        }
      }
    } else if (command === 'signature') {
      const r = signatureHelp(qSource, qResult.module!, qCheck, offset)
      if (!r) { console.log('No signature found'); process.exit(1) }
      if (jsonOutput) {
        console.log(JSON.stringify(r))
      } else {
        const params = r.params.map(p => `${p.name}: ${p.type}`).join(', ')
        console.log(`${r.name}(${params}) -> ${r.returnType}`)
      }
    } else if (command === 'rename') {
      const r = rename(qSource, qResult.module!, qCheck, offset)
      if (!r) { console.log('No symbol found'); process.exit(1) }
      if (jsonOutput) {
        const locs = r.locations.map(loc => {
          const p = lineMap.offsetToPosition(loc.offset)
          return { file: pos.file, line: p.line + 1, col: p.col + 1, length: loc.length }
        })
        console.log(JSON.stringify({ oldName: r.oldName, locations: locs }))
      } else {
        console.log(`${r.oldName}: ${r.locations.length} locations`)
        for (const loc of r.locations) {
          const p = lineMap.offsetToPosition(loc.offset)
          console.log(`  ${pos.file}:${p.line + 1}:${p.col + 1}`)
        }
      }
    }
    break
  }

  case 'symbols': {
    const target = inputFile ?? '.'
    const stat = await Bun.file(target).exists()

    if (stat) {
      // Single file: document symbols
      const sSource = await Bun.file(target).text()
      const sResult = parse(sSource, { filePath: target })
      if (sResult.errors.length > 0) {
        console.error(sResult.errors[0].message)
        process.exit(1)
      }
      const sCheck = typecheck(sResult.module!)
      const lineMap = new LineMap(sSource)
      const syms = documentSymbols(sSource, sResult.module!, sCheck)
      if (jsonOutput) {
        console.log(JSON.stringify(syms.map(s => {
          const p = lineMap.offsetToPosition(s.offset)
          return { ...s, filePath: target, line: p.line + 1, col: p.col + 1 }
        })))
      } else {
        for (const s of syms) {
          const p = lineMap.offsetToPosition(s.offset)
          const exp = s.exported ? ' [exported]' : ''
          console.log(`${target}:${p.line + 1}:${p.col + 1} ${s.kind} ${s.name}: ${s.type}${exp}`)
        }
      }
    } else {
      // Directory: workspace symbols
      const syms = await workspaceSymbols(resolve(target))
      if (jsonOutput) {
        const enriched = await Promise.all(syms.map(async s => {
          const src = await Bun.file(s.filePath!).text()
          const lm = new LineMap(src)
          const p = lm.offsetToPosition(s.offset)
          return { ...s, line: p.line + 1, col: p.col + 1 }
        }))
        console.log(JSON.stringify(enriched))
      } else {
        for (const s of syms) {
          const src = await Bun.file(s.filePath!).text()
          const lm = new LineMap(src)
          const p = lm.offsetToPosition(s.offset)
          const exp = s.exported ? ' [exported]' : ''
          console.log(`${s.filePath}:${p.line + 1}:${p.col + 1} ${s.kind} ${s.name}: ${s.type}${exp}`)
        }
      }
    }
    break
  }

  case 'test': {
    if (!inputFile) { console.error('Error: test requires a file'); process.exit(2) }
    const testFileArgs = args.slice(1).filter(a => !a.startsWith('-'))

    let totalPassed = 0
    let totalFailed = 0
    const allResults: { file: string; name: string; pass: boolean; error?: string }[] = []

    for (const testFile of testFileArgs) {
      const entryPath = resolve(testFile)
      const load = await loadModule(entryPath)
      if (load.errors.length > 0) {
        for (const error of load.errors) console.error(`${error.filePath}: ${error.message}`)
        totalFailed++
        continue
      }

      const check = typecheckProgram(load.modules, entryPath)
      if (check.errors.length > 0) {
        for (const [path, result] of check.results) {
          const modSource = load.modules.get(path)?.source ?? ''
          for (const error of result.errors) {
            const loc = offsetToLineCol(modSource, error.offset)
            console.error(`${path}:${loc.line}:${loc.column}: ${error.message}`)
          }
        }
        totalFailed++
        continue
      }

      const { wat, testNames } = programToWatWithTests(load.modules, check.results, entryPath)
      if (testNames.length === 0) continue

      const w = await wabt()
      let wasmModule
      try {
        wasmModule = w.parseWat(testFile, wat, { simd: true, multi_value: true, bulk_memory: true })
        wasmModule.validate()
      } catch (e: any) {
        console.error(`${testFile}: WAT error: ${e.message}`)
        totalFailed += testNames.length
        continue
      }
      const { buffer } = wasmModule.toBinary({})
      wasmModule.destroy()

      const mod = await WebAssembly.compile(buffer)
      const instance = await WebAssembly.instantiate(mod)

      for (const name of testNames) {
        const fn = instance.exports[`test_${name}`] as Function
        try {
          fn()
          totalPassed++
          allResults.push({ file: testFile, name, pass: true })
          console.log(`  pass: ${name.replace(/_/g, ' ')}`)
        } catch (e: any) {
          totalFailed++
          allResults.push({ file: testFile, name, pass: false, error: e.message })
          console.log(`  FAIL: ${name.replace(/_/g, ' ')}`)
        }
      }
    }

    if (totalPassed + totalFailed === 0) {
      console.log('No tests found')
    } else {
      console.log(`\n${totalPassed} passed, ${totalFailed} failed`)
    }
    if (jsonOutput) {
      console.log(JSON.stringify({ passed: totalPassed, failed: totalFailed, results: allResults }))
    }
    if (totalFailed > 0) process.exit(1)
    break
  }

  case 'fmt': {
    const checkOnly = args.includes('--check')
    const files = args.slice(1).filter(a => a !== '--check')
    if (files.length === 0) {
      console.error('Error: fmt requires at least one file')
      process.exit(2)
    }

    let dirty = 0
    for (const file of files) {
      const f = Bun.file(file)
      if (!(await f.exists())) {
        console.error(`Error: File not found: ${file}`)
        process.exit(2)
      }
      const source = await f.text()
      const formatted = formatEncantis(source)
      if (source !== formatted) {
        dirty++
        if (checkOnly) {
          console.log(`needs formatting: ${file}`)
        } else {
          await Bun.write(file, formatted)
          console.log(`formatted: ${file}`)
        }
      }
    }
    if (checkOnly && dirty > 0) {
      process.exit(1)
    }
    break
  }

  default:
    console.error(`Error: Unknown command: ${command}`)
    usage()
    process.exit(1)
}

function formatEncantis(source: string): string {
  // Phase 1: compute bracket depth at each character, skipping strings/comments
  const depths = new Int32Array(source.length)
  let depth = 0
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    // Skip line comments
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') { depths[i] = depth; i++ }
      continue
    }
    // Skip string literals
    if (ch === '"' || ch === "'") {
      const quote = ch
      depths[i] = depth; i++
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') { depths[i] = depth; i++ }
        depths[i] = depth; i++
      }
      if (i < source.length) { depths[i] = depth; i++ }
      continue
    }
    // Skip hex string literals x"..."
    if (ch === 'x' && source[i + 1] === '"') {
      depths[i] = depth; i++
      depths[i] = depth; i++
      while (i < source.length && source[i] !== '"') { depths[i] = depth; i++ }
      if (i < source.length) { depths[i] = depth; i++ }
      continue
    }
    if (ch === '{') { depths[i] = depth; depth++; i++; continue }
    if (ch === '}') { depth = Math.max(0, depth - 1); depths[i] = depth; i++; continue }
    depths[i] = depth; i++
  }

  // Phase 2: re-indent each line based on the depth at its first non-whitespace char
  const lines = source.split('\n')
  const out: string[] = []
  let prevBlank = false
  let offset = 0

  for (const raw of lines) {
    const trimmed = raw.trim()
    if (trimmed === '') {
      if (!prevBlank && out.length > 0) out.push('')
      prevBlank = true
      offset += raw.length + 1
      continue
    }
    prevBlank = false

    // Find the depth at the first non-whitespace character
    const firstCharOffset = offset + raw.indexOf(trimmed)
    const lineDepth = firstCharOffset < depths.length ? depths[firstCharOffset] : 0

    out.push('  '.repeat(lineDepth) + trimmed)
    offset += raw.length + 1
  }

  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  out.push('')
  return out.join('\n')
}

// Convert byte offset to line:column
function offsetToLineCol(
  source: string,
  offset: number,
): { line: number; column: number } {
  let line = 1
  let column = 1
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') {
      line++
      column = 1
    } else {
      column++
    }
  }
  return { line, column }
}
