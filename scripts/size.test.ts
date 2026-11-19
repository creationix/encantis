// The size budgets of scripts/size-budgets.json, held by `bun test` and so by
// CI on each OS: a change that makes an example's release build larger than
// its budget fails here. If the growth is meant, `bun run size --update` sets
// new budgets (scripts/size.ts).

import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { overBudget, readBudgets, release, root } from './size'

const budgets = await readBudgets()

// Each example's `--release` bytes are within its budget. gzip and brotli
// sizes are not held: they depend on the zlib a platform has.
describe('size budgets', () => {
  for (const [file, entry] of Object.entries(budgets.budgets)) {
    test(
      file,
      async () => {
        const size = (await release(file)).length
        if (size > entry.budget) throw new Error(overBudget(file, size, entry))
      },
      60_000,
    )
  }
})

// What is measured is what the command writes: `encantis wasm --release`
// writes the same bytes for a budgeted example.
test('the budgets measure what encantis wasm --release writes', async () => {
  const file = 'examples/containers/main.ents'
  const dir = await mkdtemp(join(tmpdir(), 'encantis-size-'))
  try {
    const out = join(dir, 'main.wasm')
    const cli = join(root, 'packages/cli/src/cli.ts')
    const run = Bun.spawnSync([process.execPath, cli, 'wasm', join(root, file), '--release', '-o', out])
    expect(run.exitCode).toBe(0)
    expect(new Uint8Array(await readFile(out))).toEqual(new Uint8Array(await release(file)))
  } finally {
    await rm(dir, { recursive: true })
  }
}, 60_000)
