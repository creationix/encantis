import { describe, expect, it } from 'bun:test'
import { type ExportDecl, type ImportDecl, parse } from '../parser'

const testDir = new URL('.', import.meta.url).pathname

describe('parser', () => {
  describe('basic.ents', () => {
    const filePath = `${testDir}basic.ents`

    it('parses without errors', async () => {
      const ents = await Bun.file(filePath).text()
      const result = parse(ents, { filePath })
      expect(result.errors).toEqual([])
    })

    it('produces a valid AST', async () => {
      const ents = await Bun.file(filePath).text()
      const result = parse(ents, { filePath })

      expect(result.module).toBeDefined()
      expect(result.module?.kind).toBe('Module')
      expect(result.module?.decls.length).toBeGreaterThan(0)
    })

    it('parses memory export', async () => {
      const ents = await Bun.file(filePath).text()
      const result = parse(ents, { filePath })

      const memoryExport = result.module?.decls.find(
        (node) => node.kind === 'ExportDecl' && node.item.kind === 'MemoryDecl',
      ) as ExportDecl | undefined
      expect(memoryExport).toBeDefined()
      expect(memoryExport?.name).toBe('mem')
    })

    it('parses function import', async () => {
      const ents = await Bun.file(filePath).text()
      const result = parse(ents, { filePath })

      const importDecl = result.module?.decls.find(
        (node) => node.kind === 'ImportDecl',
      ) as ImportDecl | undefined
      expect(importDecl).toBeDefined()
      expect(importDecl?.items[0].name).toBe('log')
    })

    it('parses main function export', async () => {
      const ents = await Bun.file(filePath).text()
      const result = parse(ents, { filePath })

      const mainExport = result.module?.decls.find(
        (node) => node.kind === 'ExportDecl' && node.item.kind === 'FuncDecl',
      ) as ExportDecl | undefined
      expect(mainExport).toBeDefined()
      expect(mainExport?.name).toBe('main')
    })

    it('generates the expected AST snapshot', async () => {
      const ents = await Bun.file(filePath).text()
      const result = parse(ents, { filePath })
      expect(result.module).toMatchSnapshot()
    })
      
  })
})
