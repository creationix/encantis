#!/usr/bin/env bun
// Builds every example entry file of a checkout with its own CLI:
//
//   bun build-entries.ts <repo> [--debug <dir>] [--release <dir>]
//       [--sizes <file>] [--abi <file>] [--report <file>]
//       [--only <rel,rel>] [--jobs N] [--list] [--compiler <repo>]
//
// The entries are the files scripts/examples.ts builds (main.ents, else the
// file named like its directory, else every file of the directory), plus
// every examples/**/*.ents that has a `test` block. Each is written as
// <dir>/<path from the repo>.wasm: `encantis wasm` to --debug, `encantis
// wasm --release` to --release. --sizes writes {path: release bytes},
// --abi {path: {imports, exports}} read from the debug build, --report
// {path: {debug, release}} with each build's status. --list prints the
// entries and builds nothing. --compiler takes the CLI from another checkout
// (for a copy of examples/ and lib/ with no compiler of its own).

import { readdir, mkdir } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { abiOf, readModule } from './wasm-info'

const args = process.argv.slice(2)
if (args.length === 0 || args[0].startsWith('-')) {
  console.error('usage: bun build-entries.ts <repo> [--debug dir] [--release dir] [--sizes f] [--abi f] [--report f] [--only a,b] [--jobs N] [--list]')
  process.exit(2)
}
const repo = resolve(args[0])
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const abs = (p: string | undefined) => (p === undefined ? undefined : resolve(p))
const debugDir = abs(opt('--debug'))
const releaseDir = abs(opt('--release'))
const sizesFile = abs(opt('--sizes'))
const abiFile = abs(opt('--abi'))
const reportFile = abs(opt('--report'))
const only = opt('--only')?.split(',').filter(Boolean)
const jobs = Number(opt('--jobs') ?? 2)
const listOnly = args.includes('--list')

const examplesDir = join(repo, 'examples')
const cli = join(resolve(opt('--compiler') ?? repo), 'packages/cli/src/cli.ts')

export async function findEntries(repoDir: string): Promise<string[]> {
  const exDir = join(repoDir, 'examples')
  const dirFiles = new Map<string, string[]>()
  const all: string[] = []
  async function walk(dir: string) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = resolve(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.name.endsWith('.ents')) {
        const d = dirname(full)
        if (!dirFiles.has(d)) dirFiles.set(d, [])
        dirFiles.get(d)!.push(full)
        all.push(full)
      }
    }
  }
  await walk(exDir)
  const entries = new Set<string>()
  // As scripts/examples.ts picks them.
  for (const [dir, files] of dirFiles) {
    const main = files.find(f => basename(f) === 'main.ents')
    const named = files.find(f => basename(f) === `${basename(dir)}.ents`)
    if (main) entries.add(main)
    else if (named) entries.add(named)
    else for (const f of files) entries.add(f)
  }
  // And every file with a test block (named or anonymous).
  for (const f of all) {
    if (/^\s*test\s*["{]/m.test(await Bun.file(f).text())) entries.add(f)
  }
  return [...entries].map(f => relative(repoDir, f)).sort()
}

async function run(cmd: string[], cwd: string, timeoutMs = 600_000) {
  const p = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => p.kill(9), timeoutMs)
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  clearTimeout(timer)
  return { code, out, err }
}

let entries = await findEntries(repo)
if (only) entries = entries.filter(e => only.includes(e))
if (listOnly) {
  for (const e of entries) console.log(e)
  process.exit(0)
}

type Status = { ok: boolean; bytes?: number; error?: string }
const report: Record<string, { debug?: Status; release?: Status }> = {}
const sizes: Record<string, number> = {}
const abi: Record<string, unknown> = {}

async function build(rel: string) {
  const r: { debug?: Status; release?: Status } = {}
  for (const [dir, flags, key] of [[debugDir, [], 'debug'], [releaseDir, ['--release'], 'release']] as const) {
    if (!dir) continue
    const out = join(dir, `${rel}.wasm`)
    await mkdir(dirname(out), { recursive: true })
    await Bun.file(out).exists() && (await Bun.file(out).delete())
    const res = await run(['bun', cli, 'wasm', rel, '-o', out, ...flags], repo)
    if (res.code === 0 && (await Bun.file(out).exists())) {
      const bytes = (await Bun.file(out).arrayBuffer()).byteLength
      r[key] = { ok: true, bytes }
      if (key === 'release') sizes[rel] = bytes
      if (key === 'debug') abi[rel] = abiOf(readModule(new Uint8Array(await Bun.file(out).arrayBuffer())))
    } else {
      r[key] = { ok: false, error: (res.err || res.out).trim().split('\n').slice(0, 6).join('\n') }
    }
  }
  report[rel] = r
  const line = [r.debug && (r.debug.ok ? `debug ${r.debug.bytes}` : 'debug FAIL'), r.release && (r.release.ok ? `release ${r.release.bytes}` : 'release FAIL')].filter(Boolean).join(', ')
  console.log(`${r.debug?.ok === false || r.release?.ok === false ? 'FAIL' : '  ok'} ${rel}: ${line}`)
  for (const s of [r.debug, r.release]) if (s && !s.ok) console.log(`     ${s.error?.replace(/\n/g, '\n     ')}`)
}

const queue = [...entries]
await Promise.all(Array.from({ length: Math.max(1, jobs) }, async () => {
  for (let rel = queue.shift(); rel; rel = queue.shift()) await build(rel)
}))

const sortObj = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
if (sizesFile) await Bun.write(sizesFile, `${JSON.stringify(sortObj(sizes), null, 2)}\n`)
if (abiFile) await Bun.write(abiFile, `${JSON.stringify(sortObj(abi), null, 2)}\n`)
if (reportFile) await Bun.write(reportFile, `${JSON.stringify(sortObj(report), null, 2)}\n`)
const failed = Object.values(report).filter(r => r.debug?.ok === false || r.release?.ok === false).length
console.log(`\n${entries.length} entries, ${failed} with a failed build`)
