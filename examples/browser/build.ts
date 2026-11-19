#!/usr/bin/env bun
// Builds the browser games into dist/ and says what each part weighs.
//
//   bun examples/browser/build.ts           build lantern and starter
//   bun examples/browser/build.ts --json    the same, the report as JSON
//
// It runs the compiler from this repository; in a copy of this directory
// elsewhere, set ENCANTIS to the installed binary (ENCANTIS=encantis).
//
// Each game is compiled with the CLI's release build (`encantis wasm
// --release`), host.js is minified, and index.html and the level file are
// copied. The report gives the wasm, the host's JavaScript, the page and the
// asset apart, raw and compressed, and the memory the game uses: its one
// page of linear memory, how far its data reaches into it, and whether an
// hour of play grows it.

import { brotliCompressSync, constants } from 'node:zlib'
import { cp, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const here = import.meta.dir
const root = resolve(here, '../..')
const dist = join(here, 'dist')
const asJson = process.argv.includes('--json')

await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })

const encantis = process.env.ENCANTIS ? [process.env.ENCANTIS] : [process.execPath, join(root, 'packages/cli/src/cli.ts')]
for (const game of ['lantern', 'starter']) {
  const proc = Bun.spawnSync([...encantis, 'wasm', join(here, `${game}.ents`), '--release', '-o', join(dist, `${game}.wasm`)], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (proc.exitCode !== 0) {
    console.error(proc.stderr.toString())
    process.exit(1)
  }
}

const host = await Bun.build({ entrypoints: [join(here, 'host.js')], minify: true, target: 'browser' })
if (!host.success) {
  console.error(host.logs.join('\n'))
  process.exit(1)
}
await Bun.write(join(dist, 'host.js'), await host.outputs[0].text())
await cp(join(here, 'index.html'), join(dist, 'index.html'))
await cp(join(here, 'levels.txt'), join(dist, 'levels.txt'))

type Size = { file: string; raw: number; gzip: number; brotli: number }
async function size(file: string): Promise<Size> {
  const bytes = new Uint8Array(await Bun.file(join(dist, file)).arrayBuffer())
  return {
    file,
    raw: bytes.length,
    gzip: Bun.gzipSync(bytes, { level: 9 }).length,
    brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  }
}
const files = await Promise.all(['lantern.wasm', 'starter.wasm', 'host.js', 'index.html', 'levels.txt'].map(size))
const of = (name: string) => files.find((f) => f.file === name) as Size
const download = (names: string[]) => ({
  raw: names.reduce((n, f) => n + of(f).raw, 0),
  gzip: names.reduce((n, f) => n + of(f).gzip, 0),
  brotli: names.reduce((n, f) => n + of(f).brotli, 0),
})

// The end of the last data segment: the module's strings sit above its
// zero-filled pools, which take no bytes in the file.
function dataEnd(wasm: Uint8Array): number {
  let at = 8
  const leb = () => {
    let result = 0
    let shift = 0
    for (;;) {
      const byte = wasm[at++]
      result |= (byte & 0x7f) << shift
      shift += 7
      if (!(byte & 0x80)) return result >>> 0
    }
  }
  let end = 0
  while (at < wasm.length) {
    const id = wasm[at++]
    const length = leb()
    const next = at + length
    if (id === 11) {
      for (let n = leb(); n > 0; n--) {
        const flags = leb()
        if (flags !== 0) throw new Error('only active data segments of memory 0 are expected')
        if (wasm[at++] !== 0x41) throw new Error('a data offset that is not i32.const')
        const offset = leb()
        at++ // end
        const bytes = leb()
        end = Math.max(end, offset + bytes)
        at += bytes
      }
    }
    at = next
  }
  return end
}

// An hour of play at 60 frames a second, starting over whenever it ends.
const lanternBytes = new Uint8Array(await Bun.file(join(dist, 'lantern.wasm')).arrayBuffer())
const { instance } = await WebAssembly.instantiate(lanternBytes, {})
const game = instance.exports as Record<string, CallableFunction> & { memory: WebAssembly.Memory }
const levels = new Uint8Array(await Bun.file(join(dist, 'levels.txt')).arrayBuffer())
new Uint8Array(game.memory.buffer, game.inbox() as number, levels.length).set(levels)
game.load(levels.length)
game.init(1)
const before = game.memory.buffer.byteLength
let most = 0
for (let i = 0; i < 60 * 60 * 60; i++) {
  const buttons = (i % 300 === 0 ? 32 : 0) | [2, 8, 1, 4][(i >> 7) & 3] | (i % 90 === 0 ? 16 : 0)
  most = Math.max(most, game.frame(16.7, 1280, 720, buttons, 0, 0) as number)
}
const memory = {
  pages: before / 65536,
  bytes: before,
  dataEnd: dataEnd(lanternBytes),
  afterAnHour: game.memory.buffer.byteLength,
  mostCommandsInAFrame: most,
}

const report = {
  files,
  lantern: download(['lantern.wasm', 'host.js', 'index.html', 'levels.txt']),
  starter: download(['starter.wasm', 'host.js', 'index.html']),
  memory,
}
await Bun.write(join(dist, 'sizes.json'), `${JSON.stringify(report, null, 2)}\n`)

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  const row = (name: string, s: { raw: number; gzip: number; brotli: number }) =>
    `| ${name.padEnd(28)} | ${String(s.raw).padStart(6)} | ${String(s.gzip).padStart(6)} | ${String(s.brotli).padStart(6)} |`
  console.log(`| ${'file'.padEnd(28)} | ${'bytes'.padStart(6)} | ${'gzip'.padStart(6)} | ${'brotli'.padStart(6)} |`)
  console.log(`|${'-'.repeat(30)}|-------:|-------:|-------:|`)
  for (const f of files) console.log(row(f.file, f))
  console.log(row('Lantern, all four files', report.lantern))
  console.log(row('starter, its three files', report.starter))
  console.log()
  console.log(`memory: ${memory.pages} page (${memory.bytes} bytes), fixed; data reaches byte ${memory.dataEnd}`)
  console.log(`after an hour of play: ${memory.afterAnHour} bytes; at most ${memory.mostCommandsInAFrame} commands in a frame`)
  console.log(`\nwrote ${dist}`)
}
