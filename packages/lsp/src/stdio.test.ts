// The .ents files `encantis lsp` finds in the workspace's folders, and that
// it says where the listing is not all of them: a rename depends on it.

import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pathFor, uriOf } from './serve'
import { sourceFiles } from './stdio'

describe('the files encantis lsp finds', () => {
  async function workspace(files: string[]) {
    const dir = await mkdtemp(join(tmpdir(), 'encantis-files-'))
    for (const file of files) {
      await mkdir(join(dir, file, '..'), { recursive: true })
      await writeFile(join(dir, file), 'export func f() -> u32 => 1\n')
    }
    return dir
  }
  const names = (uris: string[], dir: string) => uris.map((uri) => uri.slice(uriOf(dir).length + 1)).sort()

  test('the .ents files of the folders, but those of hidden folders and node_modules', async () => {
    const dir = await workspace(['a.ents', 'sub/b.ents', '.git/c.ents', 'node_modules/d/e.ents', 'notes.txt'])
    try {
      const found = await sourceFiles([pathToFileURL(dir).href])
      expect(names(found.uris, dir)).toEqual(['a.ents', 'sub/b.ents'])
      expect(found.incomplete).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  test('says where it could not look, and where it stopped', async () => {
    const dir = await workspace(['a.ents', 'b.ents', 'c.ents'])
    try {
      // A folder that is not there, and a file named as a folder, are read as
      // a folder the walk cannot read is: what is found is listed, and why it
      // is not all of it
      const missing = join(dir, 'gone')
      const unread = await sourceFiles([pathToFileURL(dir).href, pathToFileURL(missing).href])
      expect(names(unread.uris, dir)).toEqual(['a.ents', 'b.ents', 'c.ents'])
      // The folder by its path as the server names it (on Windows, with the
      // drive in lower case, as VS Code writes it)
      expect(unread.incomplete).toContain(`${pathFor(pathToFileURL(missing).href)} could not be read`)
      expect((await sourceFiles([pathToFileURL(join(dir, 'a.ents')).href])).incomplete).toContain('could not be read')
      // Past the limit the rest is not looked for
      const stopped = await sourceFiles([pathToFileURL(dir).href], 2)
      expect(stopped.uris).toHaveLength(2)
      expect(stopped.incomplete).toBe('there are more than 2 .ents files, and the rest were not looked for')
      expect((await sourceFiles([pathToFileURL(dir).href], 3)).incomplete).toBeUndefined()
      // A folder of another file system is not looked in
      expect((await sourceFiles(['vscode-vfs://github/o/r'])).incomplete).toContain('is not a folder')
    } finally {
      await rm(dir, { recursive: true })
    }
  })
})
