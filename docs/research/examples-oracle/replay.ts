// Frame-by-frame replay of two builds of a browser game (examples/browser).
//
//   bun replay.ts <base.wasm> <new.wasm> [--seeds 1,7,42,...] [--frames N] [--quiet]
//
// Both modules are instantiated with no imports and driven the same way: for
// each seed, init(seed) and then N frames of input (scripted segments, a bot
// that steers by the drawing commands of the BASE build, and random input),
// with hostile values mixed in: dt of 0, 50+, NaN, negative and infinite;
// canvas sizes odd, tiny, zero, negative, NaN and huge; random button words;
// sticks inside and outside [-1, 1], NaN and infinite. init() is also called
// again at random points, with seeds that include 0.
//
// After every frame it compares the return value, commands(), the command
// bytes (count * 32 from commands()), the bytes of every text command's
// string, and score() and mode() where the module exports them. Every 1000
// frames, and after every init, it compares a hash of the whole memory.
// Exit 0 when identical, 1 at the first difference (printed), 2 on misuse.

import { readFileSync } from 'node:fs'
import { Rng } from '../../tools/diff-common'

type Game = {
  memory: WebAssembly.Memory
  init(seed: number): void
  frame(dt: number, w: number, h: number, buttons: number, x: number, y: number): number
  commands(): number
  score?: () => number
  mode?: () => number
}

const args = process.argv.slice(2)
const valued = new Set(['--seeds', '--frames'])
const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && valued.has(args[i - 1])))
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : dflt
}
if (files.length !== 2) {
  console.error('usage: bun replay.ts <base.wasm> <new.wasm> [--seeds a,b,...] [--frames N] [--quiet]')
  process.exit(2)
}
const seeds = opt('seeds', '1,7,42,99,2024,0,4294967295').split(',').map((s) => Number(s) >>> 0)
const framesPerSeed = Number(opt('frames', '25000'))
const quiet = args.includes('--quiet')

async function load(file: string): Promise<Game> {
  const { instance } = await WebAssembly.instantiate(readFileSync(file), {})
  return instance.exports as unknown as Game
}

function fnv(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193)
    h2 = Math.imul(h2 ^ bytes[i], 0x5bd1e995) ^ (h2 >>> 15)
  }
  return `${(h1 >>> 0).toString(16)}:${(h2 >>> 0).toString(16)}:${bytes.length}`
}

const base = await load(files[0])
const next = await load(files[1])
const hasScore = typeof base.score === 'function'
const hasMode = typeof base.mode === 'function'
if (hasScore !== (typeof next.score === 'function') || hasMode !== (typeof next.mode === 'function')) {
  console.error('the two builds export different functions')
  process.exit(1)
}

let frameNo = 0
let compared = 0
let memCompares = 0
const stats = { clears: 0, deaths: 0, maxScore: 0, modes: [0, 0, 0, 0], maxCount: 0, texts: 0, sounds: 0, nanFields: 0 }
const trail: string[] = []

function fail(what: string, a: unknown, b: unknown): never {
  console.log(`MISMATCH at frame ${frameNo}: ${what}`)
  console.log(`  base: ${String(a)}`)
  console.log(`  new:  ${String(b)}`)
  console.log('last calls:')
  for (const t of trail.slice(-12)) console.log(`  ${t}`)
  process.exit(1)
}

function compareMemory(tag: string) {
  const a = fnv(new Uint8Array(base.memory.buffer))
  const b = fnv(new Uint8Array(next.memory.buffer))
  memCompares++
  if (a !== b) {
    const ma = new Uint8Array(base.memory.buffer)
    const mb = new Uint8Array(next.memory.buffer)
    const diffs: string[] = []
    for (let i = 0; i < Math.min(ma.length, mb.length) && diffs.length < 8; i++) if (ma[i] !== mb[i]) diffs.push(`@${i}: ${ma[i]} vs ${mb[i]}`)
    fail(`memory hash (${tag}) ${diffs.join(', ')}`, a, b)
  }
}

function init(seed: number) {
  trail.push(`init(${seed})`)
  base.init(seed)
  next.init(seed)
  compareMemory(`after init(${seed})`)
}

// One frame on both, everything compared. Returns the base's commands.
type Cmd = { op: number; a: number; b: number; c: number; d: number; color: number; p: number; n: number }
function frame(dt: number, w: number, h: number, buttons: number, x: number, y: number): Cmd[] {
  frameNo++
  trail.push(`frame(${dt}, ${w}, ${h}, ${buttons >>> 0}, ${x}, ${y})`)
  if (trail.length > 64) trail.splice(0, 32)
  const ca = base.frame(dt, w, h, buttons, x, y)
  const cb = next.frame(dt, w, h, buttons, x, y)
  if (ca !== cb) fail('frame() result', ca, cb)
  const pa = base.commands()
  const pb = next.commands()
  if (pa !== pb) fail('commands()', pa, pb)
  const memA = new Uint8Array(base.memory.buffer)
  const memB = new Uint8Array(next.memory.buffer)
  const bytesA = memA.slice(pa, pa + (ca >>> 0) * 32)
  const bytesB = memB.slice(pb, pb + (cb >>> 0) * 32)
  for (let i = 0; i < bytesA.length; i++) {
    if (bytesA[i] !== bytesB[i]) fail(`command ${Math.floor(i / 32)} byte ${i % 32}`, bytesA[i], bytesB[i])
  }
  const view = new DataView(base.memory.buffer)
  const out: Cmd[] = []
  for (let k = 0; k < ca; k++) {
    const at = pa + k * 32
    const cmd = {
      op: view.getUint32(at, true),
      a: view.getFloat32(at + 4, true),
      b: view.getFloat32(at + 8, true),
      c: view.getFloat32(at + 12, true),
      d: view.getFloat32(at + 16, true),
      color: view.getUint32(at + 20, true),
      p: view.getUint32(at + 24, true),
      n: view.getUint32(at + 28, true),
    }
    for (const v of [cmd.a, cmd.b, cmd.c, cmd.d]) if (Number.isNaN(v)) stats.nanFields++
    if (cmd.op === 5) {
      stats.texts++
      const ta = memA.slice(cmd.p, cmd.p + cmd.n)
      const tb = memB.slice(cmd.p, cmd.p + cmd.n)
      if (fnv(ta) !== fnv(tb)) fail(`text of command ${k}`, new TextDecoder().decode(ta), new TextDecoder().decode(tb))
    }
    if (cmd.op === 6) stats.sounds++
    out.push(cmd)
  }
  if (hasScore) {
    const sa = base.score?.()
    const sb = next.score?.()
    if (sa !== sb) fail('score()', sa, sb)
    stats.maxScore = Math.max(stats.maxScore, sa ?? 0)
  }
  if (hasMode) {
    const ma = base.mode?.()
    const mb = next.mode?.()
    if (ma !== mb) fail('mode()', ma, mb)
    stats.modes[ma ?? 0]++
  }
  stats.maxCount = Math.max(stats.maxCount, ca)
  compared++
  if (frameNo % 1000 === 0) compareMemory('every 1000 frames')
  return out
}

const DTS = [16.7, 16, 0, 50, 51, 100, 1000, Number.NaN, -1, -16, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e-30, 33.3, 8, 49.99, 0.001, -0]
const SIZES: [number, number][] = [
  [960, 640], [800, 600], [1280, 720], [640, 480], [1, 1], [0, 0], [63, 63], [64, 65], [3, 1000], [1001, 7],
  [321, 479], [375, 667], [Number.NaN, 600], [800, Number.NaN], [-5, -5], [Number.POSITIVE_INFINITY, 600],
  [100000, 1], [24, 14], [41, 41], [2.5, 3.5],
]
const STICKS = [0, 1, -1, 0.5, -0.5, 0.2, -0.2, 0.19, 1.5, -2, 1.0000001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0]

// Finds the lantern (amber disc) in the commands, and a target to steer for.
function steer(cmds: Cmd[], rng: Rng): { buttons: number; x: number; y: number } {
  // Lantern: the amber circle of radius ts*0.3. Starter: the amber circle of radius 10.
  const me = cmds.find((c) => c.op === 3 && c.color === 0xffcf6bff)
  if (!me) return { buttons: rng.chance(0.05) ? 32 : 0, x: 0, y: 0 }
  const sparks = cmds.filter((c) => c.op === 3 && (c.color === 0xfff1a8ff || c.color === 0x6fe3b4ff))
  const wisps = cmds.filter((c) => c.op === 3 && c.color >>> 8 === 0xd8ceff)
  const near = (list: Cmd[]) => list.map((c) => ({ c, d: Math.hypot(c.a - me.a, c.b - me.b) })).sort((p, q) => p.d - q.d)[0]
  const tile = me.c / 0.3
  const wisp = near(wisps)
  const target = wisp && wisp.d < tile * 2.2 ? wisp : near(sparks)
  if (!target || !Number.isFinite(target.d)) return { buttons: 0, x: rng.float() * 2 - 1, y: rng.float() * 2 - 1 }
  let x = (target.c.a - me.a) / Math.max(target.d, 1)
  let y = (target.c.b - me.b) / Math.max(target.d, 1)
  let buttons = target === wisp && rng.chance(0.5) ? 16 : 0
  if (rng.chance(0.03)) [x, y] = [-y || 1, x]
  if (rng.chance(0.02)) buttons |= 32
  return { buttons, x, y }
}

for (const seed of seeds) {
  const rng = new Rng(`replay:${seed}`)
  init(seed)
  let size = SIZES[0]
  let last: Cmd[] = []
  let mode = 'script'
  let held = 0
  let left = 0
  let prevMode = hasMode ? base.mode?.() : 0
  for (let i = 0; i < framesPerSeed; i++) {
    if (left-- <= 0) {
      mode = rng.pick(['bot', 'bot', 'bot', 'bot', 'script', 'random', 'hostile'])
      left = rng.range(30, 900)
      held = rng.pick([0, 1, 2, 4, 8, 5, 10, 6, 9, 16, 32, 48, 18, 63])
      if (rng.chance(0.15)) size = rng.pick(SIZES)
      else if (rng.chance(0.2)) size = SIZES[0]
    }
    if (rng.chance(0.0004)) init(rng.pick([0, seed, rng.u32(), 1, 0xffffffff]))
    let dt = 16.7
    let w = size[0]
    let h = size[1]
    let buttons = 0
    let x = 0
    let y = 0
    if (mode === 'bot') {
      const s = steer(last, rng)
      buttons = s.buttons
      x = s.x
      y = s.y
      if (rng.chance(0.1)) dt = rng.pick(DTS.slice(0, 6))
    } else if (mode === 'script') {
      buttons = held | (i % 120 === 0 ? 32 : 0) | (i % 45 === 0 ? 16 : 0)
      dt = 16
    } else if (mode === 'random') {
      buttons = rng.chance(0.5) ? rng.int(64) : held
      x = rng.chance(0.5) ? rng.float() * 2 - 1 : rng.pick(STICKS)
      y = rng.chance(0.5) ? rng.float() * 2 - 1 : rng.pick(STICKS)
      dt = rng.chance(0.8) ? rng.float() * 60 : rng.pick(DTS)
    } else {
      buttons = rng.chance(0.3) ? rng.u32() : rng.int(64)
      x = rng.pick(STICKS)
      y = rng.pick(STICKS)
      dt = rng.pick(DTS)
      if (rng.chance(0.3)) {
        const s = rng.pick(SIZES)
        w = s[0]
        h = s[1]
      }
    }
    last = frame(dt, w, h, buttons, x, y)
    if (hasMode) {
      const m = base.mode?.()
      if (prevMode === 1 && m === 3) stats.clears++
      if (prevMode === 1 && m === 2) stats.deaths++
      prevMode = m
    }
  }
  compareMemory(`end of seed ${seed}`)
}

if (!quiet) {
  console.log(`IDENTICAL: ${compared} frames over ${seeds.length} seeds (${seeds.join(', ')}), ${memCompares} memory hashes`)
  console.log(`coverage (base): ${JSON.stringify(stats)}`)
} else {
  console.log(`IDENTICAL ${compared} frames, ${memCompares} memory hashes, clears ${stats.clears}, deaths ${stats.deaths}`)
}
