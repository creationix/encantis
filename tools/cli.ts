#!/usr/bin/env bun

import { parse } from './parser'

const args = process.argv.slice(2)

function usage() {
  console.log(`Encantis Compiler

Usage: cli.ts <command> [options]

Commands:
  check <file>            Parse and check file for errors
  ast <file> [-o out]     Parse file and output AST as JSON
  compile <file> [-o out] Compile file to WAT (not yet implemented)

Options:
  -o <file>   Output file (default: stdout)
  --help      Show this help
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

for (let i = 1; i < args.length; i++) {
  if (args[i] === '-o') {
    outputFile = args[++i]
    if (!outputFile) {
      console.error('Error: -o requires an output file')
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

    // Output AST as JSON
    const json = JSON.stringify(result.module, jsonReplacer, 2)
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

    console.log(
      `${filePath}: OK (${result.module?.decls.length ?? 0} declarations)`,
    )
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

    // TODO: Implement WAT codegen
    console.error('Error: compile command not yet implemented')
    process.exit(1)
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

// JSON replacer that handles BigInt
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString()
  }
  return value
}
