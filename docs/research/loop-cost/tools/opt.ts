// Release pipeline variants. usage: bun opt.ts <debug.wasm> [func-name-or-index ...]
// Each config = settings flags + a list of steps; a step is [optLevel, shrinkLevel] (default pipeline)
// or a string[] of pass names (runPasses under the same settings, at -Oz levels).
// Every config ends like release(): repeat -Oz while it shrinks; best of the tries.
import binaryenMod from 'binaryen'
import { readFileSync } from 'node:fs'
import { funcSizes } from './m.ts'
const B = binaryenMod as any
if (process.env.SHOWVER) console.log('binaryen', B)
type Flags = { tnh?: boolean; iit?: boolean; lmu?: boolean; zfm?: boolean; fm?: boolean }
type Step = [number, number] | string[]

function features(): number {
  const F = B.Features
  return F.MutableGlobals | F.NontrappingFPToInt | F.SignExt | F.SIMD128 | F.BulkMemory | F.BulkMemoryOpt | F.Multivalue | F.ReferenceTypes
}
function settings(o: number, s: number, f: Flags) {
  B.setOptimizeLevel(o); B.setShrinkLevel(s); B.setDebugInfo(false)
  B.setGenerateStackIR(true); B.setOptimizeStackIR(true)
  B.setTrapsNeverHappen(!!f.tnh); B.setLowMemoryUnused(!!f.lmu); B.setZeroFilledMemory(!!f.zfm)
  B.setFastMath(!!f.fm); B.setClosedWorld(false); B.clearPassArguments(); B.clearPassesToSkip()
  if (f.iit) B.setPassArgument?.('ignore-implicit-traps', 'true')
}
function read(wasm: Uint8Array) { const m = B.readBinary(wasm); m.setFeatures(features()); if (!m.validate()) throw new Error('invalid'); return m }
export function converge(wasm: Uint8Array, steps: Step[], f: Flags, repeatSteps?: Step[]): Uint8Array {
  const m = read(wasm)
  try {
    const run = (st: Step) => { if (typeof st[0] === 'number') { settings(st[0] as number, st[1] as number, f); m.optimize() } else { settings(2, 2, f); m.runPasses(st as string[]) } }
    for (const st of steps) run(st)
    let best = m.emitBinary()
    for (let r = 0; r < 10; r++) {
      for (const st of repeatSteps ?? [[2, 2] as Step]) run(st)
      const next = m.emitBinary()
      if (next.length >= best.length) break
      best = next
    }
    return best
  } finally { m.dispose() }
}
export function releaseWith(wasm: Uint8Array, f: Flags = {}, extra: string[] = [], where: 'pre' | 'each' = 'pre', o4 = false): Uint8Array {
  const pre: Step[] = extra.length ? [extra] : []
  const rep: Step[] | undefined = where === 'each' && extra.length ? [extra, [2, 2]] : undefined
  const tries = [converge(wasm, [...pre, [2, 2]], f, rep), converge(wasm, [...pre, [3, 0], [2, 2]], f, rep)]
  if (o4) tries.push(converge(wasm, [...pre, [4, 0], [2, 2]], f, rep))
  tries.push(wasm)
  return tries.reduce((b, n) => (n.length < b.length ? n : b))
}
export const CONFIGS: Record<string, () => [Flags, string[], 'pre' | 'each', boolean]> = {
  release: () => [{}, [], 'pre', false],
  O4: () => [{}, [], 'pre', true],
  tnh: () => [{ tnh: true }, [], 'pre', false],

  lmu: () => [{ lmu: true }, [], 'pre', false],
  zfm: () => [{ zfm: true }, [], 'pre', false],
  'tnh+lmu+zfm': () => [{ tnh: true, lmu: true, zfm: true }, [], 'pre', true],
  licm: () => [{}, ['licm'], 'each', false],
  'flatten+ssa+dfo': () => [{}, ['flatten', 'ssa-nomerge', 'dfo', 'simplify-locals', 'vacuum'], 'pre', false],
  rereloop: () => [{}, ['flatten', 'rereloop'], 'pre', false],
  'code-pushing': () => [{}, ['code-pushing'], 'each', false],
  'precompute-propagate': () => [{}, ['precompute-propagate'], 'each', false],
  'merge-locals+local-cse': () => [{}, ['merge-locals', 'local-cse'], 'each', false],
  'oac-propagate(lmu)': () => [{ lmu: true }, ['optimize-added-constants-propagate'], 'each', false],
  'rse+cfold': () => [{}, ['rse', 'code-folding', 'merge-blocks', 'remove-unused-brs'], 'each', false],
  'heap2local+gufa': () => [{}, ['heap2local', 'gufa-optimizing'], 'pre', false],
  'monomorph+inline-loops': () => [{}, ['monomorphize', 'inlining-optimizing'], 'pre', false],
}
if (import.meta.main) {
  const [file, ...funcs] = process.argv.slice(2)
  const wasm = new Uint8Array(readFileSync(file))
  const only = process.env.CONFIGS?.split(',')
  for (const [name, mk] of Object.entries(CONFIGS)) {
    if (only && !only.includes(name)) continue
    const [f, extra, where, o4] = mk()
    let out: Uint8Array
    try { out = releaseWith(wasm, f, extra, where, o4) } catch (e) { console.log(`${name.padEnd(24)} ERROR ${(e as Error).message}`); continue }
    const fs = funcSizes(out)
    const pick = funcs.length ? fs.filter((x, i) => funcs.includes(x.name)) : []
    console.log(`${name.padEnd(24)} ${String(out.length).padStart(6)}  ${pick.map((x) => `${x.name}=${x.size}`).join(' ')}`)
  }
}
// extra one-off configs: EXTRA="rse;code-folding;merge-blocks|remove-unused-brs" (';' = separate configs, '|' = passes in one config)
if (import.meta.main && process.env.EXTRA) {
  const [file, ...funcs] = process.argv.slice(2)
  const wasm = new Uint8Array(readFileSync(file))
  for (const cfg of process.env.EXTRA.split(';')) {
    const passes = cfg.split('|')
    for (const where of ['pre', 'each'] as const) {
      const out = releaseWith(wasm, {}, passes, where, false)
      const fs = funcSizes(out).filter((x) => funcs.includes(x.name))
      console.log(`${(cfg + '/' + where).padEnd(40)} ${String(out.length).padStart(6)}  ${fs.map((x) => `${x.name}=${x.size}`).join(' ')}`)
    }
  }
}
