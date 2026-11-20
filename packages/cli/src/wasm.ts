// The binary the `wasm` command writes: the compiler's WAT assembled by wabt,
// optimized in this process by binaryen, and measured.
//
// binaryen is the npm package, pinned to one version in package.json and
// bundled into the release binary, so the same source and the same encantis
// give the same bytes on every machine; `encantis --version` names it. It is
// a 14 MB script, imported only by a build that optimizes.

import binaryenPackage from 'binaryen/package.json'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import wabt from 'wabt'

type Binaryen = typeof import('binaryen').default
type BinaryenModule = ReturnType<Binaryen['readBinary']>

export const BINARYEN_VERSION: string = binaryenPackage.version

// 'optimize' (-O) is binaryen's -Oz. 'release' (--release) is the smallest
// module of several tries, see release().
export type OptimizeMode = 'optimize' | 'release'

// Why a module was not optimized, in a sentence for the command line.
export class OptimizeError extends Error {}

// The module the compiler's WAT is, as wabt reads it: with SIMD, multi-value
// and bulk memory, on top of what it reads by default (mutable globals,
// saturating float-to-int, sign extension, reference types).
export async function watToWasm(name: string, wat: string): Promise<Uint8Array> {
  const module = (await wabt()).parseWat(name, wat, { simd: true, multi_value: true, bulk_memory: true })
  try {
    module.validate()
    return module.toBinary({}).buffer
  } finally {
    module.destroy()
  }
}

// The module optimized, or an OptimizeError: binaryen could not be loaded,
// does not accept the module, threw, or wrote a module that does not
// validate. The caller decides whether to fall back to the module as it was.
export async function optimizeWasm(wasm: Uint8Array, mode: OptimizeMode): Promise<Uint8Array> {
  const binaryen = await loadBinaryen()
  try {
    const optimized = mode === 'release' ? release(binaryen, wasm) : oz(binaryen, wasm)
    if (optimized !== wasm) dispose(read(binaryen, optimized, "binaryen's output"))
    return optimized
  } catch (e) {
    if (e instanceof OptimizeError) throw e
    throw new OptimizeError(`binaryen failed: ${messageOf(e)}`)
  }
}

// Sizes of a module compressed as a server would store it, at the highest
// levels: gzip -9 and brotli quality 11.
export function gzipSize(wasm: Uint8Array): number {
  return gzipSync(wasm, { level: 9 }).length
}

export function brotliSize(wasm: Uint8Array): number {
  return brotliCompressSync(wasm).length
}

let binaryenModule: Promise<Binaryen> | undefined

function loadBinaryen(): Promise<Binaryen> {
  binaryenModule ??= import('binaryen').then(
    (binaryen) => binaryen.default,
    (e) => {
      throw new OptimizeError(`binaryen ${BINARYEN_VERSION} could not be loaded: ${messageOf(e)}`)
    },
  )
  return binaryenModule
}

// What binaryen may read and write: WebAssembly 2.0, which is what wabt
// accepts above. The optimizer may use one of these where the input did not
// (i32.extend8_s for a pair of shifts), never anything newer. binaryen
// requires bulk-memory-opt (memory.copy, memory.fill) with bulk memory.
function features(binaryen: Binaryen): number {
  const F = binaryen.Features
  return (
    F.MutableGlobals |
    F.NontrappingFPToInt |
    F.SignExt |
    F.SIMD128 |
    F.BulkMemory |
    F.BulkMemoryOpt |
    F.Multivalue |
    F.ReferenceTypes
  )
}

// binaryen's settings are global: every one the optimizer reads is set before
// each run, the levels as given and the rest to binaryen's defaults, which
// assume nothing of the program (traps happen, low memory is used, imported
// memory is not zeroed, floats are exact). No debug info: no name section.
function settings(binaryen: Binaryen, optimizeLevel: number, shrinkLevel: number): void {
  binaryen.setOptimizeLevel(optimizeLevel)
  binaryen.setShrinkLevel(shrinkLevel)
  binaryen.setDebugInfo(false)
  // As wasm-opt does when it writes an optimized module: Stack IR drops
  // local.set/local.get pairs the tree IR needs. Without it the module is a
  // few bytes larger than `wasm-opt -Oz` makes it.
  binaryen.setGenerateStackIR(true)
  binaryen.setOptimizeStackIR(true)
  binaryen.setTrapsNeverHappen(false)
  binaryen.setLowMemoryUnused(false)
  binaryen.setZeroFilledMemory(false)
  binaryen.setFastMath(false)
  binaryen.setClosedWorld(false)
  binaryen.clearPassArguments()
  binaryen.clearPassesToSkip()
}

// The module in binaryen, checked: one that does not validate is refused
// (binaryen has printed why, on stderr).
function read(binaryen: Binaryen, wasm: Uint8Array, what = 'the module'): BinaryenModule {
  const module = binaryen.readBinary(wasm)
  module.setFeatures(features(binaryen))
  if (!module.validate()) {
    dispose(module)
    throw new OptimizeError(`${what} does not validate in binaryen (its report is above)`)
  }
  return module
}

// binaryen's default pipeline at -Oz, once: what `wasm-opt -Oz` writes, byte
// for byte.
function oz(binaryen: Binaryen, wasm: Uint8Array): Uint8Array {
  const module = read(binaryen, wasm)
  try {
    settings(binaryen, 2, 2)
    module.optimize()
    return module.emitBinary()
  } finally {
    dispose(module)
  }
}

// The smallest of: -Oz, and -O3 then -Oz, each repeated at -Oz while the
// module keeps shrinking (as wasm-opt --converge does), and the module as it
// came, since binaryen's rewriting of multi-value code can make a module
// larger than it was. Ties go to the first.
//
// Over the 93 programs of examples/ and lib/ (57192 bytes at -O) this takes
// 3.5% off -O: repeating 0.7%, keeping a module as it came 2.6% (ed25519's
// point.ents, which -Oz grows from 7127 bytes to 8136), the -O3 try 0.2%.
// Stripping custom sections would take nothing off: wabt writes none, and
// binaryen without debug info adds none.
function release(binaryen: Binaryen, wasm: Uint8Array): Uint8Array {
  const tries = [converge(binaryen, wasm, [[2, 2]]), converge(binaryen, wasm, [[3, 0], [2, 2]]), wasm]
  return tries.reduce((best, next) => (next.length < best.length ? next : best))
}

const MAX_ROUNDS = 10

function converge(binaryen: Binaryen, wasm: Uint8Array, levels: [number, number][]): Uint8Array {
  const module = read(binaryen, wasm)
  try {
    for (const [optimizeLevel, shrinkLevel] of levels) {
      settings(binaryen, optimizeLevel, shrinkLevel)
      module.optimize()
    }
    let best = module.emitBinary()
    for (let round = 0; round < MAX_ROUNDS; round++) {
      settings(binaryen, 2, 2)
      module.optimize()
      const next = module.emitBinary()
      if (next.length >= best.length) break
      best = next
    }
    return best
  } finally {
    dispose(module)
  }
}

// After binaryen aborts every call into it throws: what it threw first is
// what is said.
function dispose(module: BinaryenModule): void {
  try {
    module.dispose()
  } catch {}
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
