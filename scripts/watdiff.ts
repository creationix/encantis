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
//
// Exit status: 0 when every file compiles to the same thing, 1 when one
// differs, 2 when the comparison could not be made. A run that compared
// nothing has not passed: a checkout or a source directory that cannot be
// read, a checkout without a single source file, or one without a compiler
// to run, is an error, not an empty list.

import { access, readdir } from 'fs/promises'
import { relative, resolve } from 'path'

const [baseArg, nextArg] = process.argv.slice(2)
if (!baseArg) {
  console.log('Usage: bun scripts/watdiff.ts <base checkout> [<new checkout>]')
  process.exit(2)
}
const base = resolve(baseArg)
const next = resolve(nextArg ?? resolve(import.meta.dir, '..'))

function fail(message: string): never {
  console.error(`watdiff: ${message}`)
  process.exit(2)
}

const reason = (error: unknown) => (error as { code?: string }).code ?? String(error)

const cliOf = (checkout: string) => resolve(checkout, 'packages/cli/src/cli.ts')

async function entsFiles(root: string): Promise<string[]> {
  const files: string[] = []
  for (const dir of ['examples', 'lib', 'packages/compiler/tests']) {
    const path = resolve(root, dir)
    const entries = await readdir(path, { withFileTypes: true, recursive: true })
      .catch((error) => fail(`cannot read ${path} (${reason(error)})`))
    for (const entry of entries) {
      if (entry.name.endsWith('.ents')) files.push(relative(root, resolve(entry.parentPath, entry.name)))
    }
  }
  if (files.length === 0) fail(`no .ents file under ${root}`)
  return files.sort()
}

async function compile(checkout: string, file: string): Promise<{ ok: boolean; text: string }> {
  const proc = Bun.spawn(['bun', cliOf(checkout), 'compile', file], {
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

for (const checkout of [base, next]) {
  await access(cliOf(checkout)).catch((error) => fail(`no compiler at ${cliOf(checkout)} (${reason(error)})`))
}

let same = 0
let compiled = 0
const differing: string[] = []
for (const file of await entsFiles(base)) {
  const [a, b] = await Promise.all([compile(base, file), compile(next, file)])
  if (a.ok || b.ok) compiled++
  if (a.ok === b.ok && a.text === b.text) {
    same++
  } else {
    differing.push(file)
    console.log(`DIFF ${file}${a.ok === b.ok ? '' : ` (${a.ok ? 'compiled' : 'failed'} before, ${b.ok ? 'compiles' : 'fails'} now)`}`)
  }
}

console.log(`${same} identical, ${differing.length} differing`)
// Two compilers that fail alike on every file agree on nothing but the failure.
if (compiled === 0) fail('neither compiler built a single file: no WAT was compared')
process.exit(differing.length > 0 ? 1 : 0)
