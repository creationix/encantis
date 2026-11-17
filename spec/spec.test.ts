// Runs the markdown spec files in this directory, and the regions of the
// language reference that are marked as spec. See README.md for the format.
//
// UPDATE_SPEC=1 bun test spec   rewrites every ```json ast``` block with the
// AST the compiler produces now; review the diff before committing it.

import { describe, expect, test } from 'bun:test'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from '@encantis/compiler/parser'
import { typecheck } from '@encantis/compiler/checker'
import { isSourceImport } from '@encantis/compiler/loader'
import { runTestsOfSource, wasmOfWat, watOfSource } from '@encantis/compiler/test-utils'
import type * as AST from '@encantis/compiler/ast'

// compile: the block is in a region whose accepted modules are also compiled.
type Block = { lang: string; meta: string; content: string; start: number; end: number; line: number; compile: boolean }
type Section = { title: string; blocks: Block[] }

// Split a markdown file into sections (by heading) of fenced code blocks.
// start/end are the character range of each block's content, for rewriting.
// With regionsOnly, only the blocks between a `<!-- spec:begin -->` line and
// the next `<!-- spec:end -->` line count; `<!-- spec:begin compile -->` also
// marks them to be compiled, in any file.
//
// A marker is an HTML comment, which nothing shows when it is wrong: a
// misspelt one would take its examples out of the test run without a sound.
// So a comment that starts with `spec` and is not one of the three markers, a
// begin inside a region and a begin or end without its partner are errors.
function readSpec(md: string, regionsOnly: boolean): Section[] {
  const sections: Section[] = [{ title: '(top)', blocks: [] }]
  const lines = md.split('\n')
  let offset = 0
  let open: Omit<Block, 'content' | 'end'> | null = null
  let region: { compile: boolean; line: number } | null = null
  lines.forEach((line, i) => {
    const lineEnd = offset + line.length + 1
    const fence = /^```(\S*)\s*(.*)$/.exec(line)
    if (open) {
      if (line.startsWith('```')) {
        const end = Math.max(open.start, offset - 1)
        if (region || !regionsOnly) {
          sections[sections.length - 1].blocks.push({ ...open, content: md.slice(open.start, end), end })
        }
        open = null
      }
    } else if (fence) {
      open = { lang: fence[1], meta: fence[2].trim(), start: lineEnd, line: i + 1, compile: region?.compile ?? false }
    } else {
      const marker = /^<!--\s*spec:(begin|end)\s*(compile)?\s*-->$/.exec(line.trim())
      if (marker?.[1] === 'begin') {
        if (region) throw new Error(`line ${i + 1}: spec:begin inside the region opened at line ${region.line}`)
        region = { compile: marker[2] === 'compile', line: i + 1 }
      } else if (marker && !marker[2]) {
        if (!region) throw new Error(`line ${i + 1}: spec:end without a spec:begin`)
        region = null
      } else if (/^<!--\s*spec\b/i.test(line.trim())) {
        throw new Error(`line ${i + 1}: not a spec marker: ${line.trim()}`)
      }
      const heading = /^#+\s+(.*)$/.exec(line)
      if (heading) sections.push({ title: heading[1], blocks: [] })
    }
    offset = lineEnd
  })
  if (region) throw new Error(`line ${region.line}: spec:begin without a spec:end`)
  return sections.filter(s => s.blocks.length > 0)
}

// An `ents` block is a source, unless it says what the source before it must
// compile to.
const isSource = (block: Block) => block.lang === 'ents' && block.meta !== 'same-wasm'

// The AST without source positions, so expectations survive edits elsewhere.
// Byte strings show as text when they're valid UTF-8, and as hex otherwise.
function stripSpans(node: unknown): unknown {
  if (node instanceof Uint8Array) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(node)
    } catch {
      return `x"${Buffer.from(node).toString('hex')}"`
    }
  }
  if (Array.isArray(node)) return node.map(stripSpans)
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node)) {
      if (k === 'span' || v === undefined) continue
      out[k] = typeof v === 'bigint' ? v.toString() : stripSpans(v)
    }
    return out
  }
  return node
}

// Whether a module names another source file, which a block can't provide.
function hasSourceImport(module: AST.Module): boolean {
  return module.decls.some(d => d.kind === 'ImportDecl' && isSourceImport(d.module))
}

const update = !!process.env.UPDATE_SPEC
const dir = import.meta.dir
const specFiles = (await readdir(dir)).filter(f => f.endsWith('.md') && f !== 'README.md').sort()
const specs = [
  ...specFiles.map(file => ({ name: file, path: join(dir, file), regionsOnly: false })),
  { name: 'docs/encantis.md', path: join(dir, '../docs/encantis.md'), regionsOnly: true },
]

type Rewrite = { start: number; end: number; text: string }

// Runs one source block against the expectation blocks that follow it, and
// returns the module it compiled to, or null when the case asks for no
// compiling.
async function runCase(file: string, block: Block, expectations: Block[], rewrites: Rewrite[]): Promise<Uint8Array | null> {
  const rule = block.meta || 'Module'
  const parsed = parse(block.content, { startRule: rule })
  const parseErrors = parsed.errors.map(e => e.message)
  let errors = parseErrors
  if (parseErrors.length === 0 && rule === 'Module') {
    errors = typecheck(parsed.module as AST.Module).errors.map(e => e.message)
  }

  const errorBlock = expectations.find(e => e.lang === 'errors')
  if (errorBlock) {
    // Each line is a substring of one reported error, in order.
    const wanted = errorBlock.content.split('\n').map(l => l.trim()).filter(Boolean)
    expect(errors.length).toBe(wanted.length)
    for (const [j, w] of wanted.entries()) expect(errors[j]).toContain(w)
  } else {
    expect(errors).toEqual([])
  }

  for (const exp of expectations) {
    if (exp.lang !== 'json' || exp.meta.toLowerCase() !== 'ast') continue
    const actual = stripSpans(parsed.module)
    if (update) {
      rewrites.push({ start: exp.start, end: exp.end, text: JSON.stringify(actual, null, 2) })
    } else {
      expect(actual).toEqual(JSON.parse(exp.content))
    }
  }

  // In a compile region, a module that checks must also be valid wasm, and
  // its `test` blocks must pass: valid is not yet right.
  const twin = expectations.find(e => e.lang === 'ents' && e.meta === 'same-wasm')
  const compiles = rule === 'Module' && !errorBlock && !hasSourceImport(parsed.module as AST.Module)
  if (!twin && !(block.compile && compiles)) return null
  const wat = watOfSource(block.content)
  const wasm = await wasmOfWat(wat, `${file}:${block.line}`)
  if (block.compile && (parsed.module as AST.Module).decls.some(d => d.kind === 'TestDecl')) {
    const { ran, failed } = await runTestsOfSource(block.content)
    expect(ran).not.toEqual([])
    expect(failed).toEqual([])
  }
  if (twin) {
    const twinWat = watOfSource(twin.content)
    const twinWasm = await wasmOfWat(twinWat, `${file}:${twin.line}`)
    if (!Buffer.from(wasm).equals(Buffer.from(twinWasm))) {
      throw new Error(
        `${file}:${block.line} and the same-wasm block at line ${twin.line} compile to different modules:\n${wat}\n${twinWat}`,
      )
    }
  }
  return wasm
}

// The source blocks of a section, each with the expectation blocks that
// follow it up to the next source.
function casesOf(section: Section): { block: Block; expectations: Block[] }[] {
  const cases: { block: Block; expectations: Block[] }[] = []
  for (const block of section.blocks) {
    if (isSource(block)) cases.push({ block, expectations: [] })
    else cases[cases.length - 1]?.expectations.push(block)
  }
  return cases
}

for (const { name: file, path, regionsOnly } of specs) {
  const md = await readFile(path, 'utf8')
  const rewrites: Rewrite[] = []

  // A file whose markers are wrong is one failing test that says where.
  let sections: Section[] = []
  let unreadable: Error | null = null
  try {
    sections = readSpec(md, regionsOnly)
  } catch (error) {
    unreadable = error as Error
  }

  describe(file, () => {
    test(`${file}: its spec markers are well formed`, () => {
      if (unreadable) throw new Error(`${file}, ${unreadable.message}`)
    })
    for (const section of sections) {
      describe(section.title, () => {
        for (const { block, expectations } of casesOf(section)) {
          const firstLine = block.content.trim().split('\n')[0]
          test(`${file}:${block.line} ${block.meta || 'Module'}: ${firstLine}`, async () => {
            await runCase(file, block, expectations, rewrites)
          })
        }
      })
    }
  })

  if (update) {
    test(`${file}: write updated ASTs`, async () => {
      let out = md
      for (const r of rewrites.sort((a, b) => b.start - a.start)) {
        out = out.slice(0, r.start) + r.text + out.slice(r.end)
      }
      if (out !== md) await writeFile(path, out)
    })
  }
}

// The runner is what stands behind "the examples of this chapter are run as
// tests", so what it does with a region, a marker and a twin is tested too.
describe('the spec runner', () => {
  const fence = '```'
  const doc = (...parts: string[]) => parts.join('\n\n')
  const module = (source: string, meta = '') => `${fence}ents${meta ? ` ${meta}` : ''}\n${source}\n${fence}`
  const cases = (md: string, regionsOnly = true) => readSpec(md, regionsOnly).flatMap(casesOf)
  const run = (md: string) => Promise.all(cases(md).map(c => runCase('test.md', c.block, c.expectations, [])))
  const ONE = 'export func f() -> i32 => 1'
  const TWO = 'export func f() -> i32 => 2'

  test('only the blocks of a region count in the reference, and all of them in a spec file', () => {
    const md = doc(module('outside'), '<!-- spec:begin -->', module('inside'), '<!-- spec:end -->', module('after'))
    expect(cases(md).map(c => c.block.content)).toEqual(['inside'])
    expect(cases(md, false).map(c => c.block.content)).toEqual(['outside', 'inside', 'after'])
  })

  test('a compile region marks its blocks, and no others, to be compiled', async () => {
    const md = doc('<!-- spec:begin -->', module(ONE), '<!-- spec:end -->', '<!--  spec:begin   compile  -->', module(TWO), '<!-- spec:end -->')
    expect(cases(md).map(c => c.block.compile)).toEqual([false, true])
    const [checked, compiled] = await run(md)
    expect(checked).toBeNull()
    // `\0asm`: the module went through the assembler and its validator
    expect([...(compiled as Uint8Array).slice(0, 4)]).toEqual([0, 0x61, 0x73, 0x6d])
  })

  test('the tests of a module in a compile region are run', async () => {
    const tested = (expected: number) =>
      run(doc('<!-- spec:begin compile -->', module(`${ONE}\n\ntest "f" {\n  assert f() == ${expected}\n}`), '<!-- spec:end -->'))
    expect((await tested(1))[0]).not.toBeNull()
    await expect(tested(2)).rejects.toThrow()
  })

  test('a marker that is misspelt or has no partner is an error, not a region that silently does not run', () => {
    const region = (begin: string, end = '<!-- spec:end -->') => () => readSpec(doc(begin, module(ONE), end), true)
    expect(region('<!-- spec:begin compile -->')).not.toThrow()
    expect(region('<!-- spec: begin compile -->')).toThrow('not a spec marker')
    expect(region('<!-- spec:begin compiled -->')).toThrow('not a spec marker')
    expect(region('<!-- spec begin -->')).toThrow('not a spec marker')
    expect(region('<!-- Spec:Begin -->')).toThrow('not a spec marker')
    expect(region('<!-- spec:begin -->', '<!-- spec:end compile -->')).toThrow('not a spec marker')
    expect(region('<!-- spec:begin -->', '')).toThrow('spec:begin without a spec:end')
    expect(region('', '<!-- spec:end -->')).toThrow('spec:end without a spec:begin')
    expect(region('<!-- spec:begin -->\n\n<!-- spec:begin compile -->')).toThrow('spec:begin inside the region opened at line 1')
    // Other comments are prose
    expect(region('<!-- a note on the specification -->\n\n<!-- spec:begin -->')).not.toThrow()
  })

  test('same-wasm compares the bytes of the two modules', async () => {
    const pair = (a: string, b: string) => run(doc('<!-- spec:begin -->', module(a), module(b, 'same-wasm'), '<!-- spec:end -->'))
    expect((await pair(ONE, ONE))[0]).not.toBeNull()
    // Two modules of the same length that differ in one byte
    await expect(pair(ONE, TWO)).rejects.toThrow('compile to different modules')
  })

  test('the reference has its Generics chapter in a compile region', async () => {
    const md = await readFile(join(dir, '../docs/encantis.md'), 'utf8')
    const all = cases(md)
    const chapter = md.slice(md.indexOf('\n## 8. Generics'), md.indexOf('\n### 8.6 '))
    const sources = [...chapter.matchAll(/^```ents(?! same-wasm)/gm)].length
    expect(sources).toBeGreaterThanOrEqual(8)
    // Every example of the chapter is a case, the accepted ones are compiled,
    // and the claim of zero cost is a same-wasm pair.
    expect(all.filter(c => chapter.includes(c.block.content))).toHaveLength(sources)
    expect(all.every(c => c.block.compile)).toBe(true)
    expect(all.some(c => c.expectations.some(e => e.meta === 'same-wasm'))).toBe(true)
  })
})
