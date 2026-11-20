#!/usr/bin/env bun
// Self-test of diff-exports.ts: small mutations of base examples, each in
// its own copy of examples/ and lib/ (outside both worktrees), built with the
// base compiler, compared against the base builds.
//
//   bun mutate.ts [id...]

import { cp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

const scratch = process.env.ORACLE_SCRATCH ?? '/tmp/oracle-scratch'
const baseWt = join(scratch, 'base-wt')
const here = import.meta.dir
const tools = join(scratch, 'tools')

interface Mutant {
  id: string
  file: string // entry, from the repo root
  what: string
  from: string
  to: string
  // How to compare: builds ('debug' or 'probe') and oracle flags, each a run.
  runs: { build: 'debug' | 'probe'; flags: string[]; expect: 'caught' | 'identical' }[]
}

const mutants: Mutant[] = [
  {
    id: 'm1-loop-off-by-one',
    file: 'examples/crypto/base64url/base64url.ents',
    what: 'encode: `while i + 3 <= len` becomes `while i + 3 < len` (the last full group is dropped)',
    from: 'while i + 3 <= len {',
    to: 'while i + 3 < len {',
    runs: [{ build: 'debug', flags: [], expect: 'caught' }],
  },
  {
    id: 'm2-constant',
    file: 'examples/crypto/sha256/sha256.ents',
    what: 'big-sigma1: the rotation `x <<< 21` becomes `x <<< 22` (a constant in code)',
    from: '(x <<< 26) ^ (x <<< 21) ^ (x <<< 7)',
    to: '(x <<< 26) ^ (x <<< 22) ^ (x <<< 7)',
    runs: [
      { build: 'debug', flags: [], expect: 'caught' },
      { build: 'debug', flags: ['--host-view'], expect: 'identical' },
    ],
  },
  {
    id: 'm2b-data-constant',
    file: 'examples/crypto/sha256/sha256.ents',
    what: 'the second round constant 0x71374491 becomes 0x71374490 (a constant in data)',
    from: '0x428a2f98:u32, 0x71374491,',
    to: '0x428a2f98:u32, 0x71374490,',
    runs: [
      { build: 'debug', flags: [], expect: 'caught' },
      { build: 'debug', flags: ['--no-memory'], expect: 'identical' },
    ],
  },
  {
    id: 'm3-swapped-operand',
    file: 'examples/alloc/heap.ents',
    what: 'malloc split: `block_size - size - header_size` becomes `size - block_size - header_size`',
    from: 'heap.u32[next / 4] = block_size - size - header_size',
    to: 'heap.u32[next / 4] = size - block_size - header_size',
    runs: [{ build: 'debug', flags: [], expect: 'caught' }],
  },
  {
    id: 'm4-test-only-function',
    file: 'examples/types/language-features.ents',
    what: 'fibonacci (reached only from tests): `while i < n` becomes `while i <= n`',
    from: '',
    to: '',
    runs: [
      { build: 'debug', flags: [], expect: 'identical' },
      { build: 'probe', flags: [], expect: 'caught' },
    ],
  },
  {
    id: 'm5-narrow-boundary',
    file: 'examples/types/language-features.ents',
    what: 'clamp: `return hi when x > hi` becomes `return hi when x > hi + 1` (differs only at x == hi + 1)',
    from: 'return hi when x > hi',
    to: 'return hi when x > hi + 1',
    runs: [{ build: 'probe', flags: [], expect: 'caught' }],
  },
  {
    id: 'm6-equivalent',
    file: 'examples/types/language-features.ents',
    what: 'clamp: `return hi when x > hi` becomes `return hi when x >= hi` (equivalent: x == hi gives hi either way)',
    from: 'return hi when x > hi',
    to: 'return hi when x >= hi',
    runs: [{ build: 'probe', flags: [], expect: 'identical' }],
  },
  {
    id: 'm7-read-size',
    file: 'examples/wasi/tee/tee.ents',
    what: 'tee: the iovec length after the first read, 1024, becomes 1000 (same output, other read sizes)',
    from: 'iovecs[0].len = 1024',
    to: 'iovecs[0].len = 1000',
    runs: [
      { build: 'debug', flags: [], expect: 'caught' },
      { build: 'debug', flags: ['--wasi-streams', '--no-memory'], expect: 'identical' },
    ],
  },
  {
    id: 'm8-deep-state',
    file: 'examples/browser/lantern.ents',
    what: 'lantern: the pause after a level is cleared, `world.clock > 1.6`, becomes `> 1.7` (reached only after collecting every spark of a level)',
    from: 'if world.clock > 1.6 {',
    to: 'if world.clock > 1.7 {',
    runs: [
      { build: 'debug', flags: [], expect: 'identical' },
      { build: 'debug', flags: ['--skip', 'init', '--init', 'init'], expect: 'identical' },
    ],
  },
  {
    id: 'm9-game-constant',
    file: 'examples/browser/lantern.ents',
    what: 'lantern: the player speed 5.0 becomes 5.5',
    from: 'let speed: f32 = 5.0',
    to: 'let speed: f32 = 5.5',
    runs: [{ build: 'debug', flags: [], expect: 'caught' }],
  },
]

// m4 edits fibonacci's loop, whose text is found below.
async function fibEdit(src: string): Promise<string> {
  const start = src.indexOf('func fibonacci(')
  const end = src.indexOf('\n}\n', start)
  const body = src.slice(start, end)
  if (!body.includes('while i < n')) throw new Error('m4: no `while i < n` in fibonacci')
  return src.slice(0, start) + body.replace('while i < n', 'while i <= n') + src.slice(end)
}

const only = process.argv.slice(2)
const lines: string[] = []
const log = (s: string) => {
  console.log(s)
  lines.push(s)
}
let unexpected = 0
for (const m of mutants) {
  if (only.length && !only.includes(m.id)) continue
  const root = join(here, 'work', m.id)
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await cp(join(baseWt, 'examples'), join(root, 'examples'), { recursive: true })
  await cp(join(baseWt, 'lib'), join(root, 'lib'), { recursive: true })
  const path = join(root, m.file)
  const src = await Bun.file(path).text()
  let out: string
  if (m.id === 'm4-test-only-function') out = await fibEdit(src)
  else {
    if (src.split(m.from).length !== 2) throw new Error(`${m.id}: '${m.from}' is not in ${m.file} exactly once`)
    out = src.replace(m.from, m.to)
  }
  await Bun.write(path, out)
  log(`\n== ${m.id}: ${m.file}\n   ${m.what}`)
  for (const run of m.runs) {
    const outDir = join(root, `build-${run.build}`)
    const builder = run.build === 'debug'
      ? ['bun', join(tools, 'build-entries.ts'), root, '--debug', outDir, '--only', m.file, '--compiler', baseWt]
      : ['bun', join(tools, 'probe-build.ts'), root, outDir, '--only', m.file, '--compiler', baseWt]
    const b = Bun.spawnSync(builder, { stdout: 'pipe', stderr: 'pipe' })
    if (b.exitCode !== 0 || !(await Bun.file(join(outDir, `${m.file}.wasm`)).exists())) {
      log(`   build failed: ${b.stdout.toString()}${b.stderr.toString()}`)
      unexpected++
      continue
    }
    const baseWasm = join(scratch, run.build === 'debug' ? 'base' : 'base-probe', `${m.file}.wasm`)
    const t0 = performance.now()
    const r = Bun.spawnSync(['bun', join(tools, 'diff-exports.ts'), baseWasm, join(outDir, `${m.file}.wasm`), ...run.flags], { stdout: 'pipe', stderr: 'pipe' })
    const text = r.stdout.toString()
    const got = r.exitCode === 1 ? 'caught' : r.exitCode === 0 ? 'identical' : `error ${r.exitCode}`
    const ok = got === run.expect
    if (!ok) unexpected++
    log(`   ${run.build} build${run.flags.length ? ` ${run.flags.join(' ')}` : ''}: ${got} (expected ${run.expect})${ok ? '' : '  <-- UNEXPECTED'}, ${((performance.now() - t0) / 1000).toFixed(1)} s`)
    const first = text.split('\n').filter(l => l.length)
    for (const l of first.slice(0, got === 'caught' ? 8 : 4)) log(`     | ${l}`)
  }
}
log(`\n${unexpected} unexpected`)
await Bun.write(join(here, `results${only.length ? `-${only.join('-')}` : ''}.txt`), `${lines.join('\n')}\n`)
process.exit(unexpected ? 1 : 0)
