// Release-builds every .ents file under synthesis/root/examples and /lib (not
// the six case variants) with the compiler in CC and the LOWER flags in the
// environment (read once by codegen.ts at import). One JSON line per file:
// debug bytes, release bytes (the CLI's release()), and rse: the smallest of
// release and the same tries with binaryen's rse pass run once first
// (study/tools/opt.ts releaseWith, binaryen 129 by absolute path).
//   CC=... LOWER=... bun corpus.ts [files...] > out.jsonl
import { watToWasm, optimizeWasm } from '<230f6c8 checkout>/packages/cli/src/wasm.ts'
import { releaseWith } from './opt.ts'
import { readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const CC = process.env.CC ?? '<230f6c8 checkout>/packages/compiler'
const { loadModule } = await import(`${CC}/loader.ts`)
const { typecheckProgram } = await import(`${CC}/checker.ts`)
const { programToWat } = await import(`${CC}/codegen.ts`)

const ROOT = '<230f6c8 checkout with variants>'
function walkDir(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n)
    return statSync(p).isDirectory() ? walkDir(p) : p.endsWith('.ents') ? [p] : []
  })
}
const VARIANT = /-(rounds|absorb|while|sparks|digits)\.ents$/
const files = process.argv.length > 2
  ? process.argv.slice(2).map((f) => resolve(f))
  : [...walkDir(join(ROOT, 'examples')), ...walkDir(join(ROOT, 'lib'))].filter((f) => !VARIANT.test(f)).sort()

for (const file of files) {
  try {
    const load = await loadModule(file)
    if (load.errors.length) throw new Error(load.errors.map((e: any) => e.message).join('; '))
    const check = typecheckProgram(load.modules, file, { includeTests: false })
    if (check.errors.length) throw new Error(JSON.stringify(check.errors.map((e: any) => e.message ?? e)))
    const wat = programToWat(load.modules, check.results, file)
    const debug = await watToWasm(file, wat)
    const release = await optimizeWasm(debug, 'release')
    const pre = releaseWith(debug, {}, ['rse'], 'pre')
    console.log(JSON.stringify({ file: relative(ROOT, file), debug: debug.length, release: release.length, rse: Math.min(release.length, pre.length) }))
  } catch (e: any) {
    console.log(JSON.stringify({ file: relative(ROOT, file), error: String(e.message ?? e).slice(0, 300) }))
  }
}
