// watdiff has to fail when it could not compare anything: a base checkout
// that is not there used to give "0 identical, 0 differing" and exit 0.
// The checkouts here are temporary directories with a stand-in compiler, so
// each case runs in a fraction of a second.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const script = resolve(import.meta.dir, 'watdiff.ts')
const made: string[] = []

afterAll(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true })
})

// A checkout whose compiler prints `wat` for every file, or fails with
// `error` when one is given. `sources` are the .ents files it holds.
async function checkout(options: { wat?: string; error?: string; sources?: string[]; without?: string } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'watdiff-'))
  made.push(root)
  for (const dir of ['examples', 'lib', 'packages/compiler/tests', 'packages/cli/src']) {
    if (dir !== options.without) await mkdir(join(root, dir), { recursive: true })
  }
  for (const file of options.sources ?? ['examples/one.ents']) await writeFile(join(root, file), '')
  const body = options.error
    ? `console.error(${JSON.stringify(`error: ${options.error}`)}); process.exit(1)`
    : `console.log(${JSON.stringify(options.wat ?? '(module)')})`
  await writeFile(join(root, 'packages/cli/src/cli.ts'), `${body}\n`)
  return root
}

async function watdiff(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(['bun', script, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code, out, err }
}

describe('watdiff', () => {
  test('two compilers that agree pass, and the files are counted', async () => {
    const base = await checkout({ sources: ['examples/one.ents', 'lib/two.ents'] })
    const result = await watdiff(base, await checkout())
    expect(result.out).toBe('2 identical, 0 differing\n')
    expect(result.code).toBe(0)
  })

  test('a file that compiles to something else is a difference', async () => {
    const result = await watdiff(await checkout(), await checkout({ wat: '(module (memory 1))' }))
    // The path is printed as the platform writes it.
    expect(result.out).toBe(`DIFF ${join('examples', 'one.ents')}\n0 identical, 1 differing\n`)
    expect(result.code).toBe(1)
  })

  test('a base checkout that is not there is an error, not an empty list', async () => {
    const missing = join(await checkout(), 'no-such-checkout')
    const result = await watdiff(missing, await checkout())
    expect(result.err).toContain(`no compiler at ${join(missing, 'packages/cli/src/cli.ts')} (ENOENT)`)
    expect(result.out).toBe('')
    expect(result.code).toBe(2)
  })

  test('so is a new checkout that is not there', async () => {
    const base = await checkout()
    const result = await watdiff(base, join(base, 'no-such-checkout'))
    expect(result.err).toContain('no compiler at')
    expect(result.code).toBe(2)
  })

  test('a source directory that cannot be read is an error', async () => {
    const result = await watdiff(await checkout({ without: 'lib' }), await checkout())
    expect(result.err).toContain('lib (ENOENT)')
    expect(result.code).toBe(2)
    // Not a directory at all.
    const base = await checkout({ without: 'lib' })
    await writeFile(join(base, 'lib'), '')
    const file = await watdiff(base, await checkout())
    expect(file.err).toContain('lib (ENOTDIR)')
    expect(file.code).toBe(2)
  })

  test('a checkout with no source file is an error', async () => {
    const result = await watdiff(await checkout({ sources: [] }), await checkout())
    expect(result.err).toContain('no .ents file under')
    expect(result.code).toBe(2)
  })

  test('two compilers that build nothing have not agreed on any WAT', async () => {
    const broken = { error: 'Cannot find package' }
    const result = await watdiff(await checkout(broken), await checkout(broken))
    expect(result.out).toBe('1 identical, 0 differing\n')
    expect(result.err).toContain('neither compiler built a single file')
    expect(result.code).toBe(2)
    // One file both reject alike is fine beside one that compiles: a fixture
    // that is meant not to compile is equal when the message is.
    const mixed = await watdiff(await checkout(broken), await checkout())
    expect(mixed.code).toBe(1)
  })
})
