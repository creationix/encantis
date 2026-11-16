// The .wasm of every example, library and fixture file, pinned by hash, so a
// compiler change that is not meant to alter generated code shows that it
// doesn't. A file that does not compile is pinned as such.
//
// UPDATE_GOLDEN=1 bun test golden   rewrites the hashes; review the diff, and
// say in the commit why each changed entry is meant to change.

import { describe, expect, test } from 'bun:test'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { compileToWasm } from './test-utils'

const repo = resolve(import.meta.dir, '../..')
const goldenPath = join(import.meta.dir, 'tests/golden/wasm-sha256.json')
const DOES_NOT_COMPILE = 'does not compile'

async function entsFiles(): Promise<string[]> {
  const files: string[] = []
  for (const dir of ['examples', 'lib', 'packages/compiler/tests/fixtures']) {
    for (const entry of await readdir(join(repo, dir), { withFileTypes: true, recursive: true })) {
      if (entry.name.endsWith('.ents')) files.push(relative(repo, join(entry.parentPath, entry.name)))
    }
  }
  return files.sort()
}

async function hashOf(file: string): Promise<string> {
  try {
    const wasm = await compileToWasm(join(repo, file))
    return new Bun.CryptoHasher('sha256').update(wasm).digest('hex')
  } catch {
    return DOES_NOT_COMPILE
  }
}

const files = await entsFiles()

if (process.env.UPDATE_GOLDEN) {
  test('write the golden hashes', async () => {
    const golden: Record<string, string> = {}
    for (const file of files) golden[file] = await hashOf(file)
    await writeFile(goldenPath, `${JSON.stringify(golden, null, 2)}\n`)
  })
} else {
  const golden: Record<string, string> = JSON.parse(await readFile(goldenPath, 'utf8'))

  describe('golden wasm', () => {
    test('every source file has an entry, and every entry a file', () => {
      expect(Object.keys(golden).sort()).toEqual(files)
    })

    for (const file of files) {
      test(file, async () => {
        expect(await hashOf(file)).toBe(golden[file])
      })
    }
  })
}
