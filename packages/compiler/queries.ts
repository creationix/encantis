// Query layer for Encantis — pure functions over parsed/checked programs.
// Used by both the LSP server and the CLI.

import type * as AST from './ast'
import type { TypeCheckResult, Symbol } from './checker'
import { typeKey, typecheck } from './checker'
import { parse } from './parser'
import { typeToString, type ResolvedType, byteSize, unwrap } from './types'
import { typeToWasm } from './codegen'
import { LineMap, type Position } from './position'
import { resolve } from 'path'
import { readdir } from 'fs/promises'

export interface Location {
  offset: number
  length: number
}

export interface DefinitionResult {
  name: string
  location: Location
}

export interface HoverResult {
  name: string
  type: string
  kind: string
  value?: string
}

export interface SymbolInfo {
  name: string
  kind: string
  type: string
  offset: number
  length: number
  exported: boolean
  filePath?: string
}

export interface ReferenceResult {
  definition: Location
  references: Location[]
}

export interface SignatureInfo {
  name: string
  params: { name: string; type: string }[]
  returnType: string
}

// Find the identifier name at a byte offset by scanning the source
function identAtOffset(source: string, offset: number): string | null {
  if (offset < 0 || offset >= source.length) return null
  const ch = source[offset]
  if (!/[a-zA-Z_\-]/.test(ch)) return null
  let start = offset
  while (start > 0 && /[a-zA-Z0-9_\-]/.test(source[start - 1])) start--
  let end = offset
  while (end < source.length && /[a-zA-Z0-9_\-]/.test(source[end])) end++
  return source.slice(start, end)
}

export function gotoDefinition(
  source: string,
  module: AST.Module,
  checkResult: TypeCheckResult,
  offset: number,
): DefinitionResult | null {
  const name = identAtOffset(source, offset)
  if (!name) return null

  // Try exact offset via symbolRefs (works for all scopes)
  const refTarget = checkResult.symbolRefs.get(offset)
  if (refTarget !== undefined) {
    return { name, location: { offset: refTarget, length: name.length } }
  }

  // Fall back to name lookup (module scope)
  const defOffset = checkResult.symbolDefOffsets.get(name)
  if (defOffset === undefined) return null

  return {
    name,
    location: { offset: defOffset, length: name.length },
  }
}

export function hover(
  source: string,
  module: AST.Module,
  checkResult: TypeCheckResult,
  offset: number,
): HoverResult | null {
  const name = identAtOffset(source, offset)
  if (!name) return null

  // Check module-scope symbols first
  const sym = checkResult.symbols.get(name)
  if (sym) {
    const result: HoverResult = {
      name,
      type: symbolTypeString(sym),
      kind: sym.kind,
    }
    if (sym.kind === 'def') {
      if (sym.value.kind === 'int') result.value = sym.value.value.toString()
      if (sym.value.kind === 'float') result.value = sym.value.value.toString()
      if (sym.value.kind === 'bool') result.value = sym.value.value.toString()
    }
    return result
  }

  // Check type map for the identifier at this offset (params, locals, let bindings)
  const type = checkResult.types.get(typeKey(offset, 'IdentPattern'))
    ?? checkResult.types.get(typeKey(offset, 'IdentExpr'))
    ?? checkResult.types.get(typeKey(offset, 'Field'))
  if (type) {
    return {
      name,
      type: typeToString(type) + typeCostAnnotation(type),
      kind: 'local',
    }
  }

  // Check if this offset references a known symbol via symbolRefs
  const defOffset = checkResult.symbolRefs.get(offset)
  if (defOffset !== undefined) {
    for (const [symName, symOffset] of checkResult.symbolDefOffsets) {
      if (symOffset === defOffset) {
        const refSym = checkResult.symbols.get(symName)
        if (refSym) {
          return {
            name: symName,
            type: symbolTypeString(refSym),
            kind: refSym.kind,
          }
        }
      }
    }
  }

  return null
}

export function findReferences(
  source: string,
  module: AST.Module,
  checkResult: TypeCheckResult,
  offset: number,
): ReferenceResult | null {
  const name = identAtOffset(source, offset)
  if (!name) return null

  const defOffset = checkResult.symbolDefOffsets.get(name)
  if (defOffset === undefined) return null

  const refs = checkResult.references.get(defOffset) ?? []
  return {
    definition: { offset: defOffset, length: name.length },
    references: refs.map(r => ({ offset: r, length: name.length })),
  }
}

export interface RenameResult {
  oldName: string
  locations: Location[]
}

export function rename(
  source: string,
  module: AST.Module,
  checkResult: TypeCheckResult,
  offset: number,
): RenameResult | null {
  const name = identAtOffset(source, offset)
  if (!name) return null

  // Find the definition for this symbol
  let defOffset: number | undefined

  // Try symbolRefs first (exact offset match, works for all scopes)
  defOffset = checkResult.symbolRefs.get(offset)

  // If the cursor is on the definition itself, check symbolDefOffsets
  if (defOffset === undefined) {
    defOffset = checkResult.symbolDefOffsets.get(name)
  }

  if (defOffset === undefined) return null

  const refs = checkResult.references.get(defOffset) ?? []
  const locations: Location[] = [
    { offset: defOffset, length: name.length },
    ...refs.map(r => ({ offset: r, length: name.length })),
  ]

  return { oldName: name, locations }
}

export function documentSymbols(
  source: string,
  module: AST.Module,
  checkResult: TypeCheckResult,
): SymbolInfo[] {
  const symbols: SymbolInfo[] = []

  for (const decl of module.decls) {
    switch (decl.kind) {
      case 'FuncDecl':
        if (decl.ident) {
          const sym = checkResult.symbols.get(decl.ident)
          symbols.push({
            name: decl.ident,
            kind: 'func',
            type: sym ? symbolTypeString(sym) : '',
            offset: decl.span.start,
            length: decl.ident.length,
            exported: false,
          })
        }
        break
      case 'TypeDecl':
        symbols.push({
          name: decl.ident.name,
          kind: 'type',
          type: '',
          offset: decl.span.start,
          length: decl.ident.name.length,
          exported: false,
        })
        break
      case 'DefDecl': {
        const sym = checkResult.symbols.get(decl.ident)
        symbols.push({
          name: decl.ident,
          kind: 'def',
          type: sym ? symbolTypeString(sym) : '',
          offset: decl.span.start,
          length: decl.ident.length,
          exported: false,
        })
        break
      }
      case 'GlobalDecl':
        if (decl.pattern.kind === 'IdentPattern') {
          const sym = checkResult.symbols.get(decl.pattern.name)
          symbols.push({
            name: decl.pattern.name,
            kind: 'global',
            type: sym ? symbolTypeString(sym) : '',
            offset: decl.span.start,
            length: decl.pattern.name.length,
            exported: false,
          })
        }
        break
      case 'ExportDecl': {
        const item = decl.item
        if (item.kind === 'FuncDecl' && item.ident) {
          const sym = checkResult.symbols.get(item.ident)
          symbols.push({
            name: item.ident,
            kind: 'func',
            type: sym ? symbolTypeString(sym) : '',
            offset: item.span.start,
            length: item.ident.length,
            exported: true,
          })
        } else if (item.kind === 'GlobalDecl' && item.pattern.kind === 'IdentPattern') {
          const sym = checkResult.symbols.get(item.pattern.name)
          symbols.push({
            name: item.pattern.name,
            kind: 'global',
            type: sym ? symbolTypeString(sym) : '',
            offset: item.span.start,
            length: item.pattern.name.length,
            exported: true,
          })
        }
        break
      }
    }
  }

  return symbols
}

export function signatureHelp(
  source: string,
  module: AST.Module,
  checkResult: TypeCheckResult,
  offset: number,
): SignatureInfo | null {
  const name = identAtOffset(source, offset)
  if (!name) return null

  const sym = checkResult.symbols.get(name)
  if (!sym || sym.kind !== 'func') return null

  const ft = sym.type
  return {
    name,
    params: ft.params.map(p => ({
      name: p.name ?? '',
      type: typeToString(p.type),
    })),
    returnType: ft.returns.length === 0
      ? '()'
      : ft.returns.map(r => r.name ? `${r.name}: ${typeToString(r.type)}` : typeToString(r.type)).join(', '),
  }
}

export async function workspaceSymbols(
  rootDir: string,
  query?: string,
): Promise<SymbolInfo[]> {
  const files = await findEntsFiles(rootDir)
  const allSymbols: SymbolInfo[] = []

  for (const filePath of files) {
    const source = await Bun.file(filePath).text()
    const result = parse(source, { filePath })
    if (result.errors.length > 0 || !result.module) continue
    const check = typecheck(result.module)
    const syms = documentSymbols(source, result.module, check)
    for (const s of syms) {
      allSymbols.push({ ...s, filePath })
    }
  }

  if (query) {
    const q = query.toLowerCase()
    return allSymbols.filter(s => s.name.toLowerCase().includes(q))
  }
  return allSymbols
}

async function findEntsFiles(dir: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.name.endsWith('.ents')) {
      files.push(resolve(entry.parentPath, entry.name))
    }
  }
  return files.sort()
}

function typeCostAnnotation(type: ResolvedType): string {
  const u = unwrap(type)
  if (u.kind === 'array' && u.sizes && !u.sizes.includes('_')) {
    const size = byteSize(u)
    if (size !== null) return ` (${size} bytes)`
  }
  if (u.kind === 'tuple') {
    const hasArray = u.fields.some(f => unwrap(f.type).kind === 'array')
    if (hasArray) {
      const size = byteSize(u)
      if (size !== null) return ` (${size} bytes)`
    }
    const slots = typeToWasm(u).length
    if (slots > 1) return ` (${slots} slots)`
  }
  return ''
}

function symbolTypeString(sym: Symbol): string {
  const base = typeToString(sym.type)
  if (sym.kind === 'func') return base
  if (sym.kind === 'type') return base
  return base + typeCostAnnotation(sym.type)
}
