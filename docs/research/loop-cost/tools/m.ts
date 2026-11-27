// usage: bun m.ts <file.ents|file.wat> [--out prefix] [--wasm-opt "flags"]
// Prints release module bytes and per-function body sizes (Code section).
import { watToWasm, optimizeWasm } from '<230f6c8 checkout>/packages/cli/src/wasm.ts'
import { readFileSync, writeFileSync } from 'node:fs'

const CLI = process.env.ENC_CLI ?? '<230f6c8 checkout>/packages/cli/src/cli.ts'

export async function watOf(file: string): Promise<string> {
  if (file.endsWith('.wat')) return readFileSync(file, 'utf8')
  const p = Bun.spawnSync(['bun', CLI, 'compile', file])
  if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr) + new TextDecoder().decode(p.stdout))
  return new TextDecoder().decode(p.stdout)
}

function leb(b: Uint8Array, o: { p: number }): number {
  let r = 0, s = 0
  while (true) { const x = b[o.p++]; r |= (x & 0x7f) << s; s += 7; if (!(x & 0x80)) break }
  return r >>> 0
}

export function funcSizes(b: Uint8Array): { name: string; size: number }[] {
  const o = { p: 8 }
  let imported = 0
  const names = new Map<number, string>()
  const sizes: number[] = []
  while (o.p < b.length) {
    const id = b[o.p++]; const len = leb(b, o); const end = o.p + len
    if (id === 2) {
      const n = leb(b, o)
      for (let i = 0; i < n; i++) {
        let l = leb(b, o); o.p += l; l = leb(b, o); o.p += l
        const kind = b[o.p++]
        if (kind === 0) { leb(b, o); imported++ }
        else if (kind === 1) { o.p++; const f = b[o.p++]; leb(b, o); if (f & 1) leb(b, o) }
        else if (kind === 2) { const f = b[o.p++]; leb(b, o); if (f & 1) leb(b, o) }
        else if (kind === 3) { o.p += 2 }
      }
    } else if (id === 7) {
      const n = leb(b, o)
      for (let i = 0; i < n; i++) {
        const l = leb(b, o); const nm = new TextDecoder().decode(b.slice(o.p, o.p + l)); o.p += l
        const kind = b[o.p++]; const idx = leb(b, o)
        if (kind === 0 && !names.has(idx)) names.set(idx, nm)
      }
    } else if (id === 10) {
      const n = leb(b, o)
      for (let i = 0; i < n; i++) { const s = leb(b, o); sizes.push(s); o.p += s }
    }
    o.p = end
  }
  return sizes.map((s, i) => ({ name: names.get(i + imported) ?? `func[${i + imported}]`, size: s }))
}

export async function release(wat: string): Promise<{ debug: Uint8Array; rel: Uint8Array }> {
  const debug = await watToWasm('x', wat)
  const rel = await optimizeWasm(debug, 'release')
  return { debug, rel }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const file = args[0]
  const outI = args.indexOf('--out')
  const wat = await watOf(file)
  const { debug, rel } = await release(wat)
  if (outI >= 0) {
    const pre = args[outI + 1]
    writeFileSync(pre + '.wat', wat); writeFileSync(pre + '.d.wasm', debug); writeFileSync(pre + '.r.wasm', rel)
  }
  console.log(`debug ${debug.length} release ${rel.length}`)
  for (const f of funcSizes(rel)) console.log(`  ${f.name} ${f.size}`)
}
