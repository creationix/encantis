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
import { wasmOfWat, watOfSource } from '@encantis/compiler/test-utils'
import type * as AST from '@encantis/compiler/ast'

// compile: the block is in a region whose accepted modules are also compiled.
type Block = { lang: string; meta: string; content: string; start: number; end: number; line: number; compile: boolean }
type Section = { title: string; blocks: Block[] }

// Split a markdown file into sections (by heading) of fenced code blocks.
// start/end are the character range of each block's content, for rewriting.
// With regionsOnly, only the blocks between a `<!-- spec:begin -->` line and
// the next `<!-- spec:end -->` line count; `<!-- spec:begin compile -->` also
// marks them to be compiled.
function readSpec(md: string, regionsOnly: boolean): Section[] {
  const sections: Section[] = [{ title: '(top)', blocks: [] }]
  const lines = md.split('\n')
  let offset = 0
  let open: Omit<Block, 'content' | 'end'> | null = null
  let region: { compile: boolean } | null = null
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
      if (marker) region = marker[1] === 'begin' ? { compile: marker[2] === 'compile' } : null
      const heading = /^#+\s+(.*)$/.exec(line)
      if (heading) sections.push({ title: heading[1], blocks: [] })
    }
    offset = lineEnd
  })
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

for (const { name: file, path, regionsOnly } of specs) {
  const md = await readFile(path, 'utf8')
  const rewrites: { start: number; end: number; text: string }[] = []

  describe(file, () => {
    for (const section of readSpec(md, regionsOnly)) {
      describe(section.title, () => {
        section.blocks.forEach((block, i) => {
          if (!isSource(block)) return
          // Expectation blocks that follow this source, up to the next source.
          const expectations: Block[] = []
          for (const next of section.blocks.slice(i + 1)) {
            if (isSource(next)) break
            expectations.push(next)
          }
          const rule = block.meta || 'Module'
          const firstLine = block.content.trim().split('\n')[0]
          test(`${file}:${block.line} ${rule}: ${firstLine}`, async () => {
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

            // In a compile region, a module that checks must also be valid wasm.
            const twin = expectations.find(e => e.lang === 'ents' && e.meta === 'same-wasm')
            const compiles = rule === 'Module' && !errorBlock && !hasSourceImport(parsed.module as AST.Module)
            if (!twin && !(block.compile && compiles)) return
            const wat = watOfSource(block.content)
            const wasm = await wasmOfWat(wat, `${file}:${block.line}`)
            if (twin) {
              const twinWat = watOfSource(twin.content)
              const twinWasm = await wasmOfWat(twinWat, `${file}:${twin.line}`)
              if (!Buffer.from(wasm).equals(Buffer.from(twinWasm))) {
                throw new Error(
                  `${file}:${block.line} and the same-wasm block at line ${twin.line} compile to different modules:\n${wat}\n${twinWat}`,
                )
              }
            }
          })
        })
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
