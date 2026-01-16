import { describe, expect, it } from 'bun:test'
import path from 'node:path'
import { parse } from '../parser'

const testDir = path.dirname(import.meta.url.replace('file://', ''))

describe('parser', () => {
  describe('basic.ents', () => {
    const filePath = path.join(testDir, 'basic.ents')
    const watPath = filePath.replace('.ents', '.wat')
    const astPath = filePath.replace('.ents', '.ast.json')

    it('parses without errors', async () => {
      const ents = await Bun.file(filePath).text()
      const result = parse(ents, { filePath })
      expect(result.errors).toEqual([])
    })

    it('produces a valid AST', async () => {
      const ents = await Bun.file(filePath).text()
      const result = parse(ents, { filePath })

      expect(result.module).toBeDefined()
      expect(result.module!.kind).toBe('Module')
      expect(result.module!.decls.length).toBeGreaterThan(0)
    })

    it('parses memory export', async () => {
      const ents = await Bun.file(filePath).text()
      const result = parse(ents, { filePath })

      const memoryExport = result.module!.decls.find(
        (node) => node.kind === 'ExportDecl' && node.item.kind === 'MemoryDecl',
      )
      expect(memoryExport).toBeDefined()
      expect(memoryExport!.name).toBe('mem')
    })

    it('parses function import', async () => {
      const ents = await Bun.file(filePath).text()
      const result = parse(ents, { filePath })

      const importDecl = result.module!.decls.find(
        (node) => node.kind === 'ImportDecl',
      )
      expect(importDecl).toBeDefined()
      expect((importDecl as any).items[0].name).toBe('log')
    })

    it('parses main function export', async () => {
      const ents = await Bun.file(filePath).text()
      const result = parse(ents, { filePath })

      const mainExport = result.module!.decls.find(
        (node) => node.kind === 'ExportDecl' && node.item.kind === 'FuncDecl',
      )
      expect(mainExport).toBeDefined()
      expect(mainExport!.name).toBe('main')
    })

    it('generated the expected AST structure', async () => {
      const ents = await Bun.file(filePath).text()
      const result = parse(ents, { filePath })
      const expectedAstText = await Bun.file(astPath).text()
      const expectedAst = JSON.parse(expectedAstText)

      expect(result.module).toEqual(expectedAst)
    })
  })
})
