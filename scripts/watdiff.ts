#!/usr/bin/env bun

// Compiles every .ents file of a checkout with two compilers and reports the
// files whose WAT differs. A change that must not alter generated code is
// checked by running it against a checkout of the release it started from:
//
//   bun scripts/watdiff.ts <base checkout> [<new checkout>]
//
// The files are those of the base checkout (examples/, lib/,
// packages/compiler/tests/); each is compiled as an entry module by both
// command lines. A file both compilers reject counts as equal when they give
// the same message: when the compiler throws, that is the `error:` line, not
// the source excerpt and stack trace around it, whose line numbers move with
// every edit of the compiler.

import { readdir } from 'fs/promises'
import { relative, resolve } from 'path'

const [baseArg, nextArg] = process.argv.slice(2)
if (!baseArg) {
  console.log('Usage: bun scripts/watdiff.ts <base checkout> [<new checkout>]')
  process.exit(2)
}
const base = resolve(baseArg)
const next = resolve(nextArg ?? resolve(import.meta.dir, '..'))

async function entsFiles(root: string): Promise<string[]> {
  const files: string[] = []
  for (const dir of ['examples', 'lib', 'packages/compiler/tests']) {
    const entries = await readdir(resolve(root, dir), { withFileTypes: true, recursive: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.endsWith('.ents')) files.push(relative(root, resolve(entry.parentPath, entry.name)))
    }
  }
  return files.sort()
}

async function compile(checkout: string, file: string): Promise<{ ok: boolean; text: string }> {
  const proc = Bun.spawn(['bun', resolve(checkout, 'packages/cli/src/cli.ts'), 'compile', file], {
    cwd: base,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code === 0) return { ok: true, text: out }
  const thrown = err.split('\n').filter((line) => line.startsWith('error: '))
  return { ok: false, text: thrown.length > 0 ? thrown.join('\n') : err }
}

let same = 0
const differing: string[] = []
for (const file of await entsFiles(base)) {
  const [a, b] = await Promise.all([compile(base, file), compile(next, file)])
  if (a.ok === b.ok && a.text === b.text) {
    same++
  } else {
    differing.push(file)
    console.log(`DIFF ${file}${a.ok === b.ok ? '' : ` (${a.ok ? 'compiled' : 'failed'} before, ${b.ok ? 'compiles' : 'fails'} now)`}`)
  }
}

console.log(`${same} identical, ${differing.length} differing`)
process.exit(differing.length > 0 ? 1 : 0)
