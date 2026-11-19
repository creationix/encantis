// The browser games as a host sees them: their exports, many frames of play,
// starting over, several instances at once, and host.js reading what a frame
// leaves in memory. The modules are built unoptimized here, so the tests
// don't depend on the optimizer.

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { compileToWasm } from '@encantis/compiler/test-utils'
import { BUTTON, readCommands } from './host.js'

const dir = import.meta.dir
const lanternWasm = await compileToWasm(join(dir, 'lantern.ents'))
const starterWasm = await compileToWasm(join(dir, 'starter.ents'))

type Game = {
  memory: WebAssembly.Memory
  init(seed: number): void
  frame(dt: number, w: number, h: number, buttons: number, x: number, y: number): number
  commands(): number
  score(): number
  mode(): number
}

const MODE = { title: 0, play: 1, dead: 2, clear: 3 }

async function lantern(seed: number): Promise<Game> {
  const { instance } = await WebAssembly.instantiate(lanternWasm, {})
  const game = instance.exports as unknown as Game
  game.init(seed)
  return game
}

// The commands of one frame, as plain records.
type Cmd = { op: number; a: number; b: number; c: number; d: number; color: number; text?: string; wave?: string }
function commandsOf(game: Game, count: number): Cmd[] {
  const out: Cmd[] = []
  readCommands(game.memory, game.commands(), count, {
    clear: (color: number) => out.push({ op: 1, a: 0, b: 0, c: 0, d: 0, color }),
    rect: (a: number, b: number, c: number, d: number, color: number) => out.push({ op: 2, a, b, c, d, color }),
    circle: (a: number, b: number, c: number, color: number) => out.push({ op: 3, a, b, c, d: 0, color }),
    ring: (a: number, b: number, c: number, d: number, color: number) => out.push({ op: 4, a, b, c, d, color }),
    text: (a: number, b: number, c: number, centre: boolean, color: number, text: string) =>
      out.push({ op: 5, a, b, c, d: centre ? 1 : 0, color, text }),
    sound: (a: number, b: number, c: number, d: number, wave: string) => out.push({ op: 6, a, b, c, d, color: 0, wave }),
  })
  return out
}

// A deterministic stream of button words: held for a while, then changed.
function* inputs(seed: number) {
  let x = seed >>> 0 || 1
  let held = 0
  for (;;) {
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    if (x % 23 === 0) held = x & 0x3f
    yield held
  }
}

describe('the module a host gets', () => {
  test('imports nothing and exports what host.js calls', async () => {
    for (const wasm of [lanternWasm, starterWasm]) {
      const mod = new WebAssembly.Module(wasm)
      expect(WebAssembly.Module.imports(mod)).toEqual([])
      const names = WebAssembly.Module.exports(mod).map((e) => e.name)
      for (const name of ['memory', 'init', 'frame', 'commands']) expect(names).toContain(name)
    }
  })
})

describe('repeated play', () => {
  test('10,000 frames of play stay within their pools and never grow memory', async () => {
    const game = await lantern(42)
    const bytes = game.memory.buffer.byteLength
    const press = inputs(7)
    let deaths = 0
    let last = game.mode()
    for (let i = 0; i < 10_000; i++) {
      let buttons = press.next().value as number
      // Start again whenever the game is waiting for it.
      if (game.mode() !== MODE.play && i % 40 === 0) buttons |= BUTTON.start
      const count = game.frame(16.7, 960, 640, buttons, 0, 0)
      expect(count).toBeGreaterThan(0)
      expect(count).toBeLessThanOrEqual(1024)
      if (i % 500 === 0) {
        for (const cmd of commandsOf(game, count)) {
          expect(cmd.op).toBeGreaterThanOrEqual(1)
          expect(cmd.op).toBeLessThanOrEqual(6)
          for (const v of [cmd.a, cmd.b, cmd.c, cmd.d]) expect(Number.isFinite(v)).toBe(true)
        }
      }
      if (last === MODE.play && game.mode() === MODE.dead) deaths++
      last = game.mode()
    }
    expect(game.memory.buffer.byteLength).toBe(bytes)
    expect(deaths).toBeGreaterThan(0)
  })

  test('starting over plays exactly as a module just loaded', async () => {
    // One instance plays until the dark takes it, then starts over; the
    // other is new. From init on, both draw the same frames, except the best
    // score, which init keeps on purpose.
    const played = await lantern(99)
    played.frame(16, 960, 640, BUTTON.start, 0, 0)
    for (let i = 0; i < 20_000 && played.mode() !== MODE.dead; i++) played.frame(16, 960, 640, BUTTON.right, 0, 0)
    expect(played.mode()).toBe(MODE.dead)
    played.init(1234)
    const fresh = await lantern(1234)
    const press = inputs(3)
    for (let i = 0; i < 1500; i++) {
      const buttons = (press.next().value as number) | (i === 1 ? BUTTON.start : 0)
      const a = commandsOf(played, played.frame(16, 960, 640, buttons, 0, 0))
      const b = commandsOf(fresh, fresh.frame(16, 960, 640, buttons, 0, 0))
      const shown = (cmds: Cmd[]) => cmds.map((c) => (c.op === 5 ? { ...c, text: undefined } : c))
      expect(shown(a)).toEqual(shown(b))
      expect(played.score()).toBe(fresh.score())
    }
  })

  test('instances side by side are as they are alone', async () => {
    const run = async (seeds: number[], interleave: boolean) => {
      const games = await Promise.all(seeds.map((s) => lantern(s)))
      const scores: number[][] = seeds.map(() => [])
      const step = (g: number, i: number) => {
        const buttons = i === 1 ? BUTTON.start : [BUTTON.right, BUTTON.down, BUTTON.left, BUTTON.up][(i >> 6) & 3]
        games[g].frame(16, 800, 600, buttons, 0, 0)
        scores[g].push(games[g].score() * 10 + games[g].mode())
      }
      if (interleave) for (let i = 0; i < 2000; i++) for (let g = 0; g < games.length; g++) step(g, i)
      else for (let g = 0; g < games.length; g++) for (let i = 0; i < 2000; i++) step(g, i)
      return scores
    }
    expect(await run([5, 6, 7], true)).toEqual(await run([5, 6, 7], false))
  })

  test('a bot that only sees the drawing clears the first room', async () => {
    // Steers for the nearest spark, dashes at a wisp that comes close, and
    // steps sideways for a moment when a wall stops it. It wins about one
    // game in two, so it starts over when the dark takes it.
    const game = await lantern(2024)
    game.frame(16, 960, 640, BUTTON.start, 0, 0)
    const rgb = (c: number) => c >>> 8
    let cleared = false
    let was = { x: 0, y: 0 }
    let still = 0
    let aside = 0
    for (let i = 0; i < 60 * 900 && !cleared; i++) {
      const cmds = commandsOf(game, game.frame(16, 960, 640, 0, 0, 0))
      const me = cmds.find((c) => c.op === 3 && c.color === 0xffcf6bff)
      if (!me) {
        game.frame(16, 960, 640, i % 50 === 0 ? BUTTON.start : 0, 0, 0)
        continue
      }
      const tile = me.c / 0.3
      const sparks = cmds.filter((c) => c.op === 3 && c.color === 0xfff1a8ff)
      const wisps = cmds.filter((c) => c.op === 3 && rgb(c.color) === 0xd8ceff)
      const near = (list: Cmd[]) =>
        list.map((c) => ({ c, d: Math.hypot(c.a - me.a, c.b - me.b) })).sort((p, q) => p.d - q.d)[0]
      const wisp = near(wisps)
      const target = wisp && wisp.d < tile * 2.2 ? wisp : near(sparks)
      let x = 0
      let y = 0
      let buttons = 0
      if (target) {
        x = (target.c.a - me.a) / Math.max(target.d, 1)
        y = (target.c.b - me.b) / Math.max(target.d, 1)
        if (target === wisp && i % 2 === 0) buttons = BUTTON.dash
      }
      still = Math.hypot(me.a - was.x, me.b - was.y) < 0.5 ? still + 1 : 0
      was = { x: me.a, y: me.b }
      if (still > 6) aside = 30
      if (aside > 0) {
        aside--
        ;[x, y] = [-y || 1, x]
      }
      game.frame(16, 960, 640, buttons, x, y)
      cleared = game.mode() === MODE.clear
    }
    expect(game.mode()).toBe(MODE.clear)
  })
})

describe('host.js', () => {
  test('reads each command for its handler, text decoded from memory', async () => {
    const game = await lantern(1)
    const cmds = commandsOf(game, game.frame(16, 640, 480, 0, 0, 0))
    expect(cmds[0]).toMatchObject({ op: 1, color: 0x07080fff })
    expect(cmds.map((c) => c.text).filter(Boolean)).toContain('LANTERN')
    expect(cmds.find((c) => c.text === 'LANTERN')).toMatchObject({ a: 320, d: 1 })
  })

  test('a sound command names its wave', async () => {
    const { instance } = await WebAssembly.instantiate(starterWasm, {})
    const game = instance.exports as unknown as Game
    game.init(5)
    let sounds: Cmd[] = []
    for (let i = 0; i < 50 && sounds.length === 0; i++) {
      sounds = commandsOf(game, game.frame(16, 640, 480, 0, -0.832, -0.555)).filter((c) => c.op === 6)
    }
    expect(sounds).toEqual([{ op: 6, a: 440, b: 880, c: expect.closeTo(0.15, 5), d: expect.closeTo(0.2, 5), color: 0, wave: 'sine' }])
  })
})
