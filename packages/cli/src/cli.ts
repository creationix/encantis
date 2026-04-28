#!/usr/bin/env bun

import { parse } from '@encantis/compiler/parser'
import { typecheck, typecheckProgram } from '@encantis/compiler/checker'
import { buildMeta } from '@encantis/compiler/meta'
import { moduleToWat, programToWat } from '@encantis/compiler/codegen'
import { loadModule } from '@encantis/compiler/loader'
import { bigintReplacer } from '@encantis/compiler/utils'
import { gotoDefinition, hover, findReferences, documentSymbols, signatureHelp, workspaceSymbols } from '@encantis/compiler/queries'
import { LineMap } from '@encantis/compiler/position'
import { resolve } from 'path'
import wabt from 'wabt'

const args = process.argv.slice(2)

function usage() {
  console.log(`Encantis Compiler

Usage: cli.ts <command> [options]

Commands:
  check <file>                    Parse and check file for errors
  ast <file> [-o out]             Parse file and output AST as JSON
  meta <file> [-o out]            Generate meta.json (types, symbols, hints)
  compile <file> [-o out]         Compile file to WAT
  wasm <file> [-o out]            Compile file to WASM binary
  definition <file>:<line>:<col>  Go to definition of symbol at position
  hover <file>:<line>:<col>       Show type info at position
  references <file>:<line>:<col>  Find all references to symbol at position
  symbols [<file>]                List document symbols
  signature <file>:<line>:<col>   Show function signature at position

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

// Parse file:line:col for query commands
function parseFilePos(arg: string): { file: string; line: number; col: number } | null {
  const match = arg.match(/^(.+):(\d+):(\d+)$/)
  if (!match) return null
  return { file: match[1], line: parseInt(match[2]) - 1, col: parseInt(match[3]) - 1 }
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
const queryCommands = ['definition', 'hover', 'references', 'signature', 'symbols']
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

    // Type check
    const checkResult = typecheck(result.module)

    if (checkResult.errors.length > 0) {
      for (const error of checkResult.errors) {
        const loc = offsetToLineCol(source, error.offset)
        console.error(`${filePath}:${loc.line}:${loc.column}: ${error.message}`)
      }
      process.exit(1)
    }

    console.log(
      `${filePath}: OK (${result.module.decls.length} declarations)`,
    )
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
  case 'signature': {
    const pos = inputFile ? parseFilePos(inputFile) : null
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

  default:
    console.error(`Error: Unknown command: ${command}`)
    usage()
    process.exit(1)
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
