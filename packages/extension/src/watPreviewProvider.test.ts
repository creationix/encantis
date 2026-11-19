// The WAT preview's provider against a stand-in for the parts of the vscode
// module it uses: how it names previews, when it refreshes, and what its
// status bar shows.

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// vscode.Uri as far as the provider uses it: components kept decoded,
// written out encoded, as VS Code's own Uri does.
class Uri {
  private constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query: string,
  ) {}
  static from(c: { scheme: string; authority?: string; path?: string; query?: string }): Uri {
    return new Uri(c.scheme, c.authority ?? '', c.path ?? '', c.query ?? '')
  }
  static file(path: string): Uri {
    return new Uri('file', '', path, '')
  }
  static parse(value: string): Uri {
    const m = /^([a-z][a-z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?/i.exec(value)
    if (!m) throw new Error(`not a URI: ${value}`)
    return new Uri(m[1], m[2] ?? '', decodeURIComponent(m[3]), decodeURIComponent(m[4] ?? ''))
  }
  get fsPath(): string {
    return this.path
  }
  with(change: { path?: string }): Uri {
    return new Uri(this.scheme, this.authority, change.path ?? this.path, this.query)
  }
  toString(): string {
    const path = this.path.split('/').map(encodeURIComponent).join('/')
    const authority = this.authority || this.scheme === 'file' ? `//${this.authority}` : ''
    return `${this.scheme}:${authority}${path}${this.query ? `?${encodeURIComponent(this.query)}` : ''}`
  }
}

class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = []
  event = (listener: (e: T) => void) => {
    this.listeners.push(listener)
    return { dispose() {} }
  }
  fire(e: T): void {
    for (const listener of this.listeners) listener(e)
  }
  dispose(): void {}
}

interface Doc {
  uri: Uri
  getText(): string
}
interface Item {
  text: string
  visible: boolean
}
const textDocuments: Doc[] = []
const statusItems: Item[] = []
const window = {
  activeTextEditor: undefined as { document: Doc } | undefined,
  visibleTextEditors: [] as { document: Doc }[],
  createStatusBarItem(): Item {
    const item = {
      text: '',
      tooltip: undefined as string | undefined,
      command: '',
      visible: false,
      show() {
        this.visible = true
      },
      hide() {
        this.visible = false
      },
      dispose() {},
    }
    statusItems.push(item)
    return item
  },
  showInformationMessage() {},
}
const workspace = {
  textDocuments,
  async openTextDocument(uri: Uri): Promise<Doc> {
    const open = textDocuments.find(d => d.uri.toString() === uri.toString())
    if (open) return open
    const text = readFileSync(uri.fsPath, 'utf8')
    const doc = { uri, getText: () => text }
    textDocuments.push(doc)
    return doc
  },
  fs: { readFile: async (uri: Uri) => new Uint8Array(readFileSync(uri.fsPath)) },
}
mock.module('vscode', () => ({ Uri, EventEmitter, window, workspace, StatusBarAlignment: { Left: 1, Right: 2 } }))
const { WatPreviewProvider, WAT_SCHEME } = await import('./watPreviewProvider')

const dir = mkdtempSync(join(tmpdir(), 'encantis-preview-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

beforeEach(() => {
  textDocuments.length = 0
  statusItems.length = 0
  window.activeTextEditor = undefined
  window.visibleTextEditors = []
})

// A source file on disk and the preview of it, open and visible
async function preview(provider: InstanceType<typeof WatPreviewProvider>, name: string, text: string) {
  const path = join(dir, name)
  writeFileSync(path, text)
  const uri = WatPreviewProvider.encodeUri(Uri.file(path) as never)
  const content = await provider.provideTextDocumentContent(uri)
  const doc = { uri: uri as unknown as Uri, getText: () => content }
  textDocuments.push(doc)
  return { path, doc }
}

describe('the preview', () => {
  test("is named so that a #, ? or % in the source's name is kept", () => {
    for (const name of ['/w/a#1.ents', '/w/what?.ents', '/w/100%.ents', '/w/with space.ents']) {
      const source = Uri.file(name)
      const watUri = WatPreviewProvider.encodeUri(source as never)
      expect(watUri.scheme).toBe(WAT_SCHEME)
      expect(watUri.path).toBe(`${name}.wat`)
      const again = Uri.parse(watUri.toString())
      expect(WatPreviewProvider.decodeUri(again as never).toString()).toBe(source.toString())
    }
  })

  test('of a file with a # in its name compiles', async () => {
    const provider = new WatPreviewProvider()
    const { doc } = await preview(provider, 'odd #1.ents', 'export func one() -> i32 => 1\n')
    expect(doc.getText()).toContain('(export "one"')
    provider.dispose()
  })

  test('refreshes once edits stop, not on each one', async () => {
    const provider = new WatPreviewProvider()
    const { path, doc } = await preview(provider, 'typed.ents', 'export func one() -> i32 => 1\n')
    const fired: string[] = []
    provider.onDidChange(uri => fired.push(uri.toString()))
    for (let i = 0; i < 10; i++) {
      provider.refresh(Uri.file(path) as never)
      await sleep(20)
    }
    expect(fired).toEqual([])
    await sleep(400)
    expect(fired).toEqual([doc.uri.toString()])
    provider.dispose()
  })

  test('shows its status bar while a preview is visible, with that preview size', async () => {
    const provider = new WatPreviewProvider(async wasm => wasm)
    const [mode, opt, tests, size] = statusItems
    const small = await preview(provider, 'small.ents', 'export func one() -> i32 => 1\n')
    const big = await preview(provider, 'big.ents', 'export func one() -> i32 => 1\nexport func two(a: i32, b: i32) -> i32 => a * b + 2\n')
    // Open but not visible: hidden
    provider.syncStatusBar()
    expect([mode, opt, tests, size].map(i => i.visible)).toEqual([false, false, false, false])

    window.visibleTextEditors = [{ document: small.doc }, { document: big.doc }]
    window.activeTextEditor = { document: big.doc }
    provider.syncStatusBar()
    expect([mode, opt, tests, size].map(i => i.visible)).toEqual([true, true, true, true])
    const bigSize = size.text
    window.activeTextEditor = { document: small.doc }
    provider.syncStatusBar()
    expect(size.text).toMatch(/^\d+ B$/)
    expect(Number.parseInt(size.text)).toBeLessThan(Number.parseInt(bigSize))

    // In a source file: the size of its own preview
    window.activeTextEditor = { document: { uri: Uri.file(big.path), getText: () => '' } }
    provider.syncStatusBar()
    expect(size.text).toBe(bigSize)

    // Closed: no longer visible, though VS Code still has the document
    window.visibleTextEditors = []
    window.activeTextEditor = undefined
    provider.syncStatusBar()
    expect([mode, opt, tests, size].map(i => i.visible)).toEqual([false, false, false, false])
    provider.dispose()
  })

  test('without an optimizer shows no optimization item', async () => {
    const provider = new WatPreviewProvider()
    const [, opt] = statusItems
    const { doc } = await preview(provider, 'web.ents', 'export func one() -> i32 => 1\n')
    window.visibleTextEditors = [{ document: doc }]
    provider.syncStatusBar()
    expect(opt.visible).toBe(false)
    provider.dispose()
  })
})
