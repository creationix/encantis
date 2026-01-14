#!/usr/bin/env bun
// =============================================================================
// Encantis CLI
// Simple command-line interface for the compiler
// =============================================================================

import { readFileSync, writeFileSync } from 'fs';
import { compile, analyze, formatDiagnostic } from './compile';

const args = process.argv.slice(2);

function printUsage(): void {
  console.log(`Usage: encantis <command> [options] <file>

Commands:
  compile <file.ents>     Compile to WAT (outputs to stdout)
  compile <file.ents> -o <out.wat>  Compile to file
  check <file.ents>       Check for errors without compiling

Options:
  -o, --output <file>     Output file (for compile)
  -h, --help              Show this help
`);
}

function main(): void {
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    printUsage();
    process.exit(0);
  }

  const command = args[0];

  switch (command) {
    case 'compile': {
      const inputFile = args.find((a, i) => i > 0 && !a.startsWith('-') && args[i - 1] !== '-o' && args[i - 1] !== '--output');
      const outputIndex = args.findIndex(a => a === '-o' || a === '--output');
      const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : null;

      if (!inputFile) {
        console.error('Error: No input file specified');
        process.exit(1);
      }

      try {
        const src = readFileSync(inputFile, 'utf8');
        const wat = compile(src);

        if (outputFile) {
          writeFileSync(outputFile, wat);
          console.error(`Compiled ${inputFile} -> ${outputFile}`);
        } else {
          console.log(wat);
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      break;
    }

    case 'check': {
      const inputFile = args[1];
      if (!inputFile) {
        console.error('Error: No input file specified');
        process.exit(1);
      }

      try {
        const src = readFileSync(inputFile, 'utf8');
        const result = analyze(src);

        const errors = result.errors.filter(e => e.severity === 'error');
        const warnings = result.errors.filter(e => e.severity === 'warning');

        for (const diag of result.errors) {
          console.log(formatDiagnostic(src, diag));
          console.log();
        }

        if (errors.length === 0) {
          console.log(`✓ ${inputFile}: No errors${warnings.length > 0 ? ` (${warnings.length} warning(s))` : ''}`);
        } else {
          console.log(`✗ ${inputFile}: ${errors.length} error(s), ${warnings.length} warning(s)`);
          process.exit(1);
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      break;
    }

    default:
      // If no command, assume it's a file to compile
      if (args[0].endsWith('.ents')) {
        const inputFile = args[0];
        const outputIndex = args.findIndex(a => a === '-o' || a === '--output');
        const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : null;

        try {
          const src = readFileSync(inputFile, 'utf8');
          const wat = compile(src);

          if (outputFile) {
            writeFileSync(outputFile, wat);
            console.error(`Compiled ${inputFile} -> ${outputFile}`);
          } else {
            console.log(wat);
          }
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      } else {
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
      }
  }
}

main();
