// CC=... LOWER=... bun six.ts : release and rse-try bytes of the six owner cases (idiomatic and hand), one JSON line per file
const CC = process.env.CC ?? '<230f6c8 checkout>/packages/compiler'
const { loadModule } = await import(`${CC}/loader.ts`)
const { typecheckProgram } = await import(`${CC}/checker.ts`)
const { programToWat } = await import(`${CC}/codegen.ts`)
import { watToWasm, optimizeWasm } from '<230f6c8 checkout>/packages/cli/src/wasm.ts'
import { releaseWith } from './opt.ts'
const R = '<230f6c8 checkout with variants>/examples/'
const files = ['crypto/gimli/gimli', 'crypto/gimli/gimli-rounds', 'crypto/gimli/gimli-absorb', 'crypto/xxh32/xxh32', 'crypto/xxh32/xxh32-while', 'crypto/xxh64/xxh64', 'crypto/xxh64/xxh64-while', 'browser/lantern', 'browser/lantern-digits', 'browser/lantern-sparks']
for (const f of files) {
  const file = R + f + '.ents'
  const load = await loadModule(file)
  const check = typecheckProgram(load.modules, file, { includeTests: false })
  if (check.errors.length) { console.log(JSON.stringify({ f, error: check.errors[0].message })); continue }
  const debug = await watToWasm(file, programToWat(load.modules, check.results, file))
  const release = await optimizeWasm(debug, 'release')
  const pre = releaseWith(debug, {}, ['rse'], 'pre')
  console.log(JSON.stringify({ set: process.env.LOWER || 'base', f, debug: debug.length, release: release.length, rse: Math.min(release.length, pre.length) }))
}
