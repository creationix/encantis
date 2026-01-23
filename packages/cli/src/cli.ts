#!/usr/bin/env bun

import { parse } from '@encantis/compiler/parser'
import { typecheck } from '@encantis/compiler/checker'
import { buildMeta } from '@encantis/compiler/meta'
import { moduleToWat } from '@encantis/compiler/codegen'
import { bigintReplacer } from '@encantis/compiler/utils'
import { inlineDefs } from '@encantis/compiler/preprocess'

const args = process.argv.slice(2)

function usage() {
  console.log(`Encantis Compiler

Usage: cli.ts <command> [options]

Commands:
  check <file>            Parse and check file for errors
  ast <file> [-o out]     Parse file and output AST as JSON
  meta <file> [-o out]    Generate meta.json (types, symbols, hints)
  compile <file> [-o out] Compile file to WAT

Options:
  -o <file>       Output file (default: stdout)
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
  } else if (!inputFile) {
    inputFile = args[i]
  }
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

// Read source
const file = Bun.file(inputFile)
if (!(await file.exists())) {
  console.error(`Error: File not found: ${inputFile}`)
  process.exit(1)
}
const source = await file.text()
const filePath = file.name ?? inputFile

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

  case 'compile': {
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

    // Preprocess: inline def constants
    const preprocessed = inlineDefs(result.module)

    // Type check (includes concretization)
    const checkResult = typecheck(preprocessed)

    if (checkResult.errors.length > 0) {
      for (const error of checkResult.errors) {
        const loc = offsetToLineCol(source, error.offset)
        console.error(`${filePath}:${loc.line}:${loc.column}: ${error.message}`)
      }
      process.exit(1)
    }

    // Generate WAT
    const wat = moduleToWat(preprocessed, checkResult)
    await output(wat)
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
