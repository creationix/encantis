#!/usr/bin/env bun

import * as fs from 'node:fs'
import * as path from 'node:path'
import { parse } from './parser'

const args = process.argv.slice(2)

function usage() {
  console.log(`Encantis Compiler

Usage: cli.ts <command> [options]

Commands:
  ast <file>              Parse file and output AST as JOT
  check <file>            Parse and check file for errors
  compile <file> [-o out] Compile file to WAT (not yet implemented)

Options:
  -o <file>   Output file (default: stdout)
  --help      Show this help
`)
}

function main() {
  if (args.length === 0 || args.includes('--help')) {
    usage()
    process.exit(0)
  }

  const command = args[0]
  const file = args[1]

  if (!file) {
    console.error(`Error: Missing file argument`)
    usage()
    process.exit(1)
  }

  // Resolve file path
  const filePath = path.resolve(file)

  // Check file exists
  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`)
    process.exit(1)
  }

  // Read source
  const source = fs.readFileSync(filePath, 'utf-8')

  switch (command) {
    case 'ast': {
      const result = parse(source, { filePath })

      if (result.errors.length > 0) {
        for (const error of result.errors) {
          const loc = error.span
          console.error(
            `${filePath}:${loc.start.line}:${loc.start.column}: ${error.shortMessage}`,
          )
          console.error(error.message)
        }
        process.exit(1)
      }

      // Output AST as JSON
      console.log(
        JSON.stringify(
          result.module,
          (_key, value) => {
            // Convert BigInt to string for JSON serialization
              return value.toString()
            }
            return value
          },
          2,
        ),
      )
      break
    }

    case 'check': {
      const result = parse(source, { filePath })

      if (result.errors.length > 0) {
        for (const error of result.errors) {
          const loc = error.span
          console.error(
            `${filePath}:${loc.start.line}:${loc.start.column}: ${error.shortMessage}`,
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
          const loc = error.span
          console.error(
            `${filePath}:${loc.start.line}:${loc.start.column}: ${error.shortMessage}`,
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
}

main()
