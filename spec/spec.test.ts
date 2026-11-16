// Runs the markdown spec files in this directory. See README.md for the format.
//
// UPDATE_SPEC=1 bun test spec   rewrites every ```json ast``` block with the
// AST the compiler produces now; review the diff before committing it.

import { describe, expect, test } from 'bun:test'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from '@encantis/compiler/parser'
import { typecheck } from '@encantis/compiler/checker'
import type * as AST from '@encantis/compiler/ast'

type Block = { lang: string; meta: string; content: string; start: number; end: number; line: number }
type Section = { title: string; blocks: Block[] }

// Split a markdown file into sections (by heading) of fenced code blocks.
// start/end are the character range of each block's content, for rewriting.
function readSpec(md: string): Section[] {
  const sections: Section[] = [{ title: '(top)', blocks: [] }]
  const lines = md.split('\n')
  let offset = 0
  let open: Omit<Block, 'content' | 'end'> | null = null
  lines.forEach((line, i) => {
    const lineEnd = offset + line.length + 1
    const fence = /^```(\S*)\s*(.*)$/.exec(line)
    if (open) {
      if (line.startsWith('```')) {
        const end = Math.max(open.start, offset - 1)
        sections[sections.length - 1].blocks.push({ ...open, content: md.slice(open.start, end), end })
        open = null
      }
    } else if (fence) {
      open = { lang: fence[1], meta: fence[2].trim(), start: lineEnd, line: i + 1 }
    } else {
      const heading = /^#+\s+(.*)$/.exec(line)
      if (heading) sections.push({ title: heading[1], blocks: [] })
    }
    offset = lineEnd
  })
  return sections.filter(s => s.blocks.length > 0)
}

// The AST without source positions, so expectations survive edits elsewhere.
function stripSpans(node: unknown): unknown {
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

const update = !!process.env.UPDATE_SPEC
const dir = import.meta.dir
const files = (await readdir(dir)).filter(f => f.endsWith('.md') && f !== 'README.md').sort()

for (const file of files) {
  const path = join(dir, file)
  const md = await readFile(path, 'utf8')
  const rewrites: { start: number; end: number; text: string }[] = []

  describe(file, () => {
    for (const section of readSpec(md)) {
      describe(section.title, () => {
        section.blocks.forEach((block, i) => {
          if (block.lang !== 'ents') return
          // Expectation blocks that follow this source, up to the next source.
          const expectations: Block[] = []
          for (const next of section.blocks.slice(i + 1)) {
            if (next.lang === 'ents') break
            expectations.push(next)
          }
          const rule = block.meta || 'Module'
          const firstLine = block.content.trim().split('\n')[0]
          test(`${file}:${block.line} ${rule}: ${firstLine}`, () => {
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
