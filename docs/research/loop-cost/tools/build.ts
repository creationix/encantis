// CC=<compiler dir> LOWER=<flags> bun build.ts <file.ents> <outprefix>
// writes <outprefix>.wat/.debug.wasm/.release.wasm (release = the CLI's release() at 230f6c8), prints sizes
const CC = process.env.CC ?? '<230f6c8 checkout>/packages/compiler'
const { loadModule } = await import(`${CC}/loader.ts`)
const { typecheckProgram } = await import(`${CC}/checker.ts`)
const { programToWat } = await import(`${CC}/codegen.ts`)
import { watToWasm, optimizeWasm } from '<230f6c8 checkout>/packages/cli/src/wasm.ts'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const [f, out] = process.argv.slice(2)
const file = resolve(f)
const load = await loadModule(file)
if (load.errors.length) throw new Error(load.errors.map((e: any) => e.message).join('; '))
const check = typecheckProgram(load.modules, file, { includeTests: false })
if (check.errors.length) throw new Error(JSON.stringify(check.errors.map((e: any) => e.message ?? e)))
const wat = programToWat(load.modules, check.results, file)
const debug = await watToWasm(file, wat)
const release = await optimizeWasm(debug, 'release')
writeFileSync(out + '.wat', wat); writeFileSync(out + '.debug.wasm', debug); writeFileSync(out + '.release.wasm', release)
console.log(JSON.stringify({ file: f, lower: process.env.LOWER ?? '', debug: debug.length, release: release.length }))
