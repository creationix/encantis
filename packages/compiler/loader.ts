import { parse } from './parser'
import type { Module, ImportDecl, TestDecl } from './ast'
import { resolve, dirname } from 'path'

export interface LoadedModule {
  path: string
  source: string
  module: Module
}

export interface LoadError {
  message: string
  filePath: string
  importedFrom?: string
}

export interface LoadResult {
  entry: LoadedModule
  modules: Map<string, LoadedModule>
  errors: LoadError[]
}

function isSourceImport(modulePath: string): boolean {
  return modulePath.startsWith('./') || modulePath.startsWith('../') || modulePath.startsWith('/')
}

function resolveModulePath(importPath: string, fromFile: string): string {
  const dir = dirname(fromFile)
  let resolved = resolve(dir, importPath)
  if (!resolved.endsWith('.ents')) resolved += '.ents'
  return resolved
}

// The imports of other source files a module has, with those of its tests
// where they are included
export function getSourceImports(mod: Module, includeTests?: boolean): ImportDecl[] {
  const imports: ImportDecl[] = []
  function collect(decls: readonly { kind: string }[]) {
    for (const d of decls) {
      if (d.kind === 'ImportDecl' && isSourceImport((d as ImportDecl).module)) {
        imports.push(d as ImportDecl)
      } else if (includeTests && d.kind === 'TestDecl') {
        collect((d as TestDecl).children)
      }
    }
  }
  collect(mod.decls)
  return imports
}

export interface LoadOptions {
  includeTests?: boolean
  // Reads a source file: its text, or null where there is no such file. The
  // file system by default; the editor reads the documents it has open, and
  // where it has no file system, only those. A file is asked for by the path
  // the loader names it by, as path.resolve makes it (on Windows with a drive
  // and backslashes).
  readFile?: (path: string) => Promise<string | null>
}

async function readFromDisk(path: string): Promise<string | null> {
  const file = Bun.file(path)
  return (await file.exists()) ? file.text() : null
}

export async function loadModule(entryPath: string, options?: LoadOptions): Promise<LoadResult> {
  const absEntry = resolve(entryPath)
  const modules = new Map<string, LoadedModule>()
  const errors: LoadError[] = []
  const readFile = options?.readFile ?? readFromDisk

  async function load(filePath: string, importedFrom: string | undefined, chain: Set<string>): Promise<boolean> {
    if (chain.has(filePath)) {
      const cycle = [...chain, filePath].map(p => p.split('/').pop()).join(' → ')
      errors.push({
        message: `Import cycle detected: ${cycle}`,
        filePath,
        importedFrom,
      })
      return false
    }

    if (modules.has(filePath)) return true

    const source = await readFile(filePath)
    if (source === null) {
      errors.push({
        message: `Module not found: ${filePath}`,
        filePath,
        importedFrom,
      })
      return false
    }

    const result = parse(source, { filePath })

    if (result.errors.length > 0 || !result.module) {
      for (const err of result.errors) {
        errors.push({
          message: err.message,
          filePath,
          importedFrom,
        })
      }
      return false
    }

    const loaded: LoadedModule = { path: filePath, source, module: result.module }
    modules.set(filePath, loaded)

    const nextChain = new Set(chain)
    nextChain.add(filePath)

    for (const imp of getSourceImports(result.module, options?.includeTests)) {
      const depPath = resolveModulePath(imp.module, filePath)
      await load(depPath, filePath, nextChain)
    }

    return true
  }

  await load(absEntry, undefined, new Set())

  const entry = modules.get(absEntry)
  if (!entry) {
    return { entry: { path: absEntry, source: '', module: { kind: 'Module', decls: [], span: { start: 0, end: 0 } } }, modules, errors }
  }

  return { entry, modules, errors }
}

export { isSourceImport, resolveModulePath }
