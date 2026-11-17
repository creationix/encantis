// What the command line itself adds to a check error: where it is printed,
// and the calls an error inside an instance of a generic was required from.
// What the checker reports is tested in the compiler package.

import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, 'cli.ts')

// `max` is instantiated for a struct, which has no `>`: one error, inside the
// instance, with the call in `f` as the place it was required from.
const SHAPES = `type Pt = (q: i32, r: i32)
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }

export func f(a: Pt, b: Pt) -> Pt => max(a, b)
`

// Runs `encantis <command> <file> [flags]` on SHAPES written to a file.
async function encantis(command: string, ...flags: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'encantis-cli-'))
  try {
    const file = join(dir, 'shapes.ents')
    await writeFile(file, SHAPES)
    const run = Bun.spawnSync([process.execPath, CLI, command, file, ...flags])
    return { file, exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() }
  } finally {
    await rm(dir, { recursive: true })
  }
}

describe('check errors on the command line', () => {
  const message = "'>' cannot be applied to Pt and Pt, in max(T = Pt)"

  test('an error inside an instance is followed by the calls it was required from', async () => {
    const { file, exitCode, stderr } = await encantis('check')
    expect(exitCode).toBe(1)
    expect(stderr).toBe(`${file}:2:51: ${message}\n  required from ${file}:4:38\n`)
  })

  test('check --json carries them as notes', async () => {
    const { file, exitCode, stdout } = await encantis('check', '--json')
    expect(exitCode).toBe(1)
    expect(JSON.parse(stdout)).toEqual([
      { file, line: 2, col: 51, message, notes: [{ file, line: 4, col: 38, message: 'required from' }] },
    ])
  })

  // One printer serves every command that checks before it does its work.
  for (const command of ['compile', 'wasm', 'test', 'run']) {
    test(`${command} prints the same lines`, async () => {
      const { file, exitCode, stderr } = await encantis(command)
      expect(exitCode).toBe(1)
      expect(stderr).toContain(`${file}:2:51: ${message}\n  required from ${file}:4:38\n`)
    })
  }
})
