#!/usr/bin/env bun
// Probe builds: each entry compiled with every top-level function of the
// entry file exported under its own name, so that diff-exports.ts can call
// the functions of a file that exports few or none (most of examples/types
// and examples/math are only reached from their tests).
//
//   bun probe-build.ts <repo> <out-dir> [--only <rel,rel>] [--report <file>]
//       [--compiler <repo>]
//
// It uses the checkout's own compiler, or the one of --compiler. A function
// is exported when it is not inline, has no comptime parameter, is not
// exported already and its name is not taken; one the checker refuses as an
// export (all are tried together first, then one at a time) stays as it is. Writes <out-dir>/<rel>.wasm,
// unoptimized, as `encantis wasm` does, and with --report the list of the
// functions each build exports in addition.

import { mkdir, readdir } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'

const args = process.argv.slice(2)
if (args.length < 2 || args[0].startsWith('-')) {
  console.error('usage: bun probe-build.ts <repo> <out-dir> [--only rel,rel] [--report file]')
  process.exit(2)
}
const repo = resolve(args[0])
const outDir = resolve(args[1])
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const only = opt('--only')?.split(',').filter(Boolean)
const reportFile = opt('--report') ? resolve(opt('--report')!) : undefined

const compiler = resolve(opt('--compiler') ?? repo)
const { loadModule } = await import(join(compiler, 'packages/compiler/loader.ts'))
const { typecheckProgram } = await import(join(compiler, 'packages/compiler/checker.ts'))
const { programToWat } = await import(join(compiler, 'packages/compiler/codegen.ts'))
const { watToWasm } = await import(join(compiler, 'packages/cli/src/wasm.ts'))

async function findEntries(repoDir: string): Promise<string[]> {
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
  await walk(join(repoDir, 'examples'))
  const entries = new Set<string>()
  for (const [dir, files] of dirFiles) {
    const main = files.find(f => basename(f) === 'main.ents')
    const named = files.find(f => basename(f) === `${basename(dir)}.ents`)
    if (main) entries.add(main)
    else if (named) entries.add(named)
    else for (const f of files) entries.add(f)
  }
  for (const f of all) if (/^\s*test\s*["{]/m.test(await Bun.file(f).text())) entries.add(f)
  return [...entries].map(f => relative(repoDir, f)).sort()
}

type Decl = any

function candidates(decls: Decl[]): Decl[] {
  const taken = new Set<string>()
  for (const d of decls) if (d.kind === 'ExportDecl') taken.add(d.name)
  const out: Decl[] = []
  for (const d of decls) {
    if (d.kind !== 'FuncDecl' || !d.ident || d.inline) continue
    const input = d.signature?.input
    const fields = input?.kind === 'FieldList' ? input.fields : input?.fields ?? []
    if (fields.some((f: any) => f.comptime)) continue
    if (taken.has(d.ident)) continue
    taken.add(d.ident)
    out.push(d)
  }
  return out
}

async function build(rel: string) {
  const entry = join(repo, rel)
  const load = await loadModule(entry)
  if (load.errors.length) return { error: `load: ${load.errors[0].message}` }
  const mod = load.modules.get(entry)
  const decls: Decl[] = mod.module.decls
  const original = [...decls]
  const funcs = candidates(original)
  const wrap = (chosen: Set<Decl>) => {
    mod.module.decls = original.map(d => (chosen.has(d) ? { kind: 'ExportDecl', name: d.ident, item: d, span: d.span } : d))
    return typecheckProgram(load.modules, entry, { includeTests: false })
  }
  let chosen = new Set<Decl>(funcs)
  let check = wrap(chosen)
  if (check.errors.length) {
    chosen = new Set()
    for (const f of funcs) {
      chosen.add(f)
      if (wrap(chosen).errors.length) chosen.delete(f)
    }
    check = wrap(chosen)
    if (check.errors.length) return { error: `check: ${check.errors[0].message}` }
  }
  const wat = programToWat(load.modules, check.results, entry)
  const wasm: Uint8Array = await watToWasm(entry, wat)
  const out = join(outDir, `${rel}.wasm`)
  await mkdir(dirname(out), { recursive: true })
  await Bun.write(out, wasm)
  const exported = funcs.filter(f => chosen.has(f)).map(f => f.ident)
  const refused = funcs.filter(f => !chosen.has(f)).map(f => f.ident)
  return { bytes: wasm.length, exported, refused }
}

let entries = await findEntries(repo)
if (only) entries = entries.filter(e => only.includes(e))
const report: Record<string, unknown> = {}
for (const rel of entries) {
  try {
    const r = await build(rel)
    report[rel] = r
    if ('error' in r) console.log(`FAIL ${rel}: ${r.error}`)
    else console.log(`  ok ${rel}: ${r.bytes} bytes, ${r.exported.length} more exports${r.refused.length ? `, refused: ${r.refused.join(' ')}` : ''}`)
  } catch (e) {
    report[rel] = { error: String((e as Error)?.message ?? e) }
    console.log(`FAIL ${rel}: ${(e as Error)?.message ?? e}`)
  }
}
if (reportFile) await Bun.write(reportFile, `${JSON.stringify(report, null, 2)}\n`)
