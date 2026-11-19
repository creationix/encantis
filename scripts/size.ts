// The examples in size-budgets.json built as `encantis wasm --release` builds
// them, against their budgets.
//
//   bun run size            print each one's sizes; exit 1 if one is over
//   bun run size --update   set each budget to its size now plus 2%, rounded up
//
// size.test.ts holds `bun test` (and so CI) to the same budgets. A budget is
// on the release build's bytes; gzip and brotli are printed as they come.

import { typecheckProgram } from '@encantis/compiler/checker'
import { programToWat } from '@encantis/compiler/codegen'
import { loadModule } from '@encantis/compiler/loader'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { BINARYEN_VERSION, brotliSize, gzipSize, optimizeWasm, watToWasm } from '../packages/cli/src/wasm'

export const root = resolve(import.meta.dir, '..')
export const budgetsPath = join(import.meta.dir, 'size-budgets.json')

export interface Budgets {
  // How far over its size a budget is set when it is updated: 0.02 is 2%.
  margin: number
  // The binaryen the sizes were measured with.
  binaryen: string
  // Each example, by its path from the repository root: its release size
  // when the budget was set, and the budget.
  budgets: Record<string, { measured: number; budget: number }>
}

export async function readBudgets(): Promise<Budgets> {
  return JSON.parse(await readFile(budgetsPath, 'utf8'))
}

// The unoptimized module of a program, as `encantis wasm` makes it.
export async function unoptimized(file: string): Promise<Uint8Array> {
  const entry = join(root, file)
  const load = await loadModule(entry)
  if (load.errors.length > 0) throw new Error(`${file}: ${load.errors[0].message}`)
  const check = typecheckProgram(load.modules, entry, { includeTests: false })
  if (check.errors.length > 0) throw new Error(`${file}: ${check.errors[0].message}`)
  return watToWasm(entry, programToWat(load.modules, check.results, entry))
}

export interface Sizes {
  unoptimized: number
  optimize: number // -O
  release: number // --release
  gzip: number // of the release build
  brotli: number
}

// The module `encantis wasm --release` writes for a program.
export async function release(file: string): Promise<Uint8Array> {
  return optimizeWasm(await unoptimized(file), 'release')
}

export async function measure(file: string): Promise<Sizes> {
  const wasm = await unoptimized(file)
  const release = await optimizeWasm(wasm, 'release')
  return {
    unoptimized: wasm.length,
    optimize: (await optimizeWasm(wasm, 'optimize')).length,
    release: release.length,
    gzip: gzipSize(release),
    brotli: brotliSize(release),
  }
}

// The budgets file, one example a line.
export function formatBudgets(budgets: Budgets): string {
  const lines = Object.entries(budgets.budgets).map(
    ([file, { measured, budget }]) => `    ${JSON.stringify(file)}: { "measured": ${measured}, "budget": ${budget} }`,
  )
  return `{
  "margin": ${budgets.margin},
  "binaryen": ${JSON.stringify(budgets.binaryen)},
  "budgets": {
${lines.join(',\n')}
  }
}
`
}

// What is said of a build over its budget.
export function overBudget(file: string, size: number, entry: { measured: number; budget: number }): string {
  return (
    `${file}: the release build is ${size} bytes, ${size - entry.budget} over its budget of ${entry.budget} ` +
    `(it was ${entry.measured} when the budget was set). If the growth is meant, run \`bun run size --update\`.`
  )
}

if (import.meta.main) {
  const update = process.argv.includes('--update')
  const budgets = await readBudgets()
  const header = ['unoptimized', '-O', '--release', 'gzip', 'brotli', 'budget', '']
  const rows: string[][] = []
  const over: string[] = []
  for (const [file, entry] of Object.entries(budgets.budgets)) {
    const sizes = await measure(file)
    let status = ''
    if (update) {
      const budget = Math.ceil(sizes.release * (1 + budgets.margin))
      budgets.budgets[file] = { measured: sizes.release, budget }
      status = budget === entry.budget ? '' : `was ${entry.budget}`
    } else if (sizes.release > entry.budget) {
      status = `OVER by ${sizes.release - entry.budget}`
      over.push(overBudget(file, sizes.release, entry))
    } else {
      status = `${entry.budget - sizes.release} to spare`
    }
    const { unoptimized, optimize, release, gzip, brotli } = sizes
    rows.push([file, ...[unoptimized, optimize, release, gzip, brotli, budgets.budgets[file].budget].map(String), status])
  }

  const widths = [Math.max(...rows.map((r) => r[0].length)), ...header.map((h) => h.length)]
  for (const row of rows) for (let i = 1; i < row.length; i++) widths[i] = Math.max(widths[i], row[i].length)
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 || i === cells.length - 1 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ')
  console.log(line(['', ...header]).trimEnd())
  for (const row of rows) console.log(line(row).trimEnd())
  console.log(`\nbinaryen ${BINARYEN_VERSION}; gzip -9 and brotli of the --release build`)

  if (update) {
    budgets.binaryen = BINARYEN_VERSION
    await writeFile(budgetsPath, formatBudgets(budgets))
    console.log(`Updated ${budgetsPath}`)
  } else if (over.length > 0) {
    console.error(`\n${over.join('\n')}`)
    process.exit(1)
  }
}
