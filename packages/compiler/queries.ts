// Query layer for Encantis — pure functions over parsed/checked programs.
// Used by both the LSP server and the CLI.

import type * as AST from './ast'
import type { TypeCheckResult, Symbol as CheckSymbol } from './checker'
import { typeKey, typecheck, genericDeclaring } from './checker'
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

// The offset at which the identifier around `offset` begins
function wordStart(source: string, offset: number): number {
  let start = offset
  while (start > 0 && /[a-zA-Z0-9_-]/.test(source[start - 1])) start--
  return start
}

// Where the name at `offset` is defined: exactly, when the checker recorded
// this position as a use or as a definition; by name otherwise, which finds
// the names of the module. A generic's own parameters and locals are never
// looked up by name: they are in no table of names, so the name would be some
// other function's, and a rename from it would edit that function.
function definitionOf(
  source: string,
  module: AST.Module,
  checkResult: TypeCheckResult,
  offset: number,
  name: string,
): number | undefined {
  const start = wordStart(source, offset)
  const exact = checkResult.symbolRefs.get(offset) ?? checkResult.symbolRefs.get(start)
  if (exact !== undefined) return exact
  if (genericDeclaring(module, start, name)) {
    return checkResult.references.has(start) ? start : undefined
  }
  return checkResult.symbolDefOffsets.get(name)
}

export function gotoDefinition(
  source: string,
  module: AST.Module,
  checkResult: TypeCheckResult,
  offset: number,
): DefinitionResult | null {
  const name = identAtOffset(source, offset)
  if (!name) return null

  const defOffset = definitionOf(source, module, checkResult, offset, name)
  if (defOffset === undefined) return null

  return {
    name,
    location: { offset: defOffset, length: name.length },
  }
}

// The type of the identifier used (not declared) at an offset.
function identExprType(checkResult: TypeCheckResult, offset: number): ResolvedType | undefined {
  for (const [expr, type] of checkResult.exprTypes) {
    if (expr.kind === 'IdentExpr' && expr.span.start === offset) return type
  }
  return undefined
}

export function hover(
  source: string,
  module: AST.Module,
  checkResult: TypeCheckResult,
  offset: number,
): HoverResult | null {
  const name = identAtOffset(source, offset)
  if (!name) return null

  // A generic's own names come before the module's. They have no hover: what
  // one of them is depends on the instance.
  if (genericDeclaring(module, wordStart(source, offset), name)) return null

  // Check module-scope symbols first
  const sym = checkResult.symbols.get(name)
  if (sym) {
    // A generic has a signature per instance. At a call the checker recorded
    // the one that call uses, as the type of the callee.
    if (sym.kind === 'generic') {
      const instance = identExprType(checkResult, wordStart(source, offset))
      if (instance) return { name, type: typeToString(instance), kind: sym.kind }
    }
    const result: HoverResult = {
      name,
      type: symbolTypeString(sym, source),
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
    ?? identExprType(checkResult, offset)
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
            type: symbolTypeString(refSym, source),
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

  const defOffset = definitionOf(source, module, checkResult, offset, name)
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

  const defOffset = definitionOf(source, module, checkResult, offset, name)
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
            type: sym ? symbolTypeString(sym, source) : '',
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
      case 'TypeFuncDecl': {
        const sym = checkResult.symbols.get(decl.ident)
        symbols.push({
          name: decl.ident,
          kind: 'type',
          type: sym ? symbolTypeString(sym, source) : '',
          offset: decl.span.start,
          length: decl.ident.length,
          exported: false,
        })
        break
      }
      case 'DataDecl':
      case 'DefDecl': {
        const sym = checkResult.symbols.get(decl.ident)
        symbols.push({
          name: decl.ident,
          kind: decl.kind === 'DataDecl' ? 'data' : 'def',
          type: sym ? symbolTypeString(sym, source) : '',
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
            type: sym ? symbolTypeString(sym, source) : '',
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
            type: sym ? symbolTypeString(sym, source) : '',
            offset: item.span.start,
            length: item.ident.length,
            exported: true,
          })
        } else if (item.kind === 'TypeFuncDecl') {
          const sym = checkResult.symbols.get(item.ident)
          symbols.push({
            name: item.ident,
            kind: 'type',
            type: sym ? symbolTypeString(sym, source) : '',
            offset: item.span.start,
            length: item.ident.length,
            exported: true,
          })
        } else if (item.kind === 'GlobalDecl' && item.pattern.kind === 'IdentPattern') {
          const sym = checkResult.symbols.get(item.pattern.name)
          symbols.push({
            name: item.pattern.name,
            kind: 'global',
            type: sym ? symbolTypeString(sym, source) : '',
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
  // A generic has the signature of the instance this call uses, which the
  // checker recorded as the type of the callee.
  const ft = sym?.kind === 'generic' ? identExprType(checkResult, wordStart(source, offset)) : sym?.kind === 'func' ? sym.type : null
  if (ft?.kind !== 'func') return null

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

function symbolTypeString(sym: CheckSymbol, source?: string): string {
  // A generic has a signature per instance, not one of its own: what there is
  // to show is the one it was written with.
  if (sym.kind === 'generic') {
    const { start, end } = sym.decl.signature.span
    return source ? `generic func${source.slice(start, end)}` : 'generic func'
  }
  // A generic type is a type once it is applied: until then, its declaration.
  if (sym.kind === 'typefunc') {
    const { start, end } = sym.decl.span
    const params = source ? source.indexOf('(', start) : -1
    return params >= 0 && params < end ? `generic type${source?.slice(params, end)}` : 'generic type'
  }
  const base = typeToString(sym.type)
  if (sym.kind === 'func') return base
  if (sym.kind === 'type') return base
  return base + typeCostAnnotation(sym.type)
}
