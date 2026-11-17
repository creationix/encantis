// Query layer for Encantis — pure functions over parsed/checked programs.
// Used by both the LSP server and the CLI.

import type * as AST from './ast'
import type { TypeCheckResult, Symbol as CheckSymbol } from './checker'
import { typeKey, typecheck, declaredName, genericAround, genericDeclaring, fieldNamedAt } from './checker'
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

// The name a function is known by where its own name is written at `offset`
// in its declaration (a function, or an import of one, also inside a test).
// Functions that share a name are each known by a name of their own, and by
// the shared name alone every one of them would be the first.
function declaredAt(module: AST.Module, checkResult: TypeCheckResult, offset: number, name: string): string | undefined {
  const find = (items: readonly (AST.Declaration | AST.TestItem)[]): AST.FuncDecl | AST.ImportFunc | undefined => {
    for (const item of items) {
      const decl = item.kind === 'ExportDecl' ? item.item : item
      if (decl.kind === 'TestDecl') {
        const found = find(decl.children)
        if (found) return found
      } else if (decl.kind === 'FuncDecl') {
        if (decl.ident === name && offset >= decl.span.start && offset < decl.signature.span.start) return decl
      } else if (decl.kind === 'ImportDecl') {
        for (const { item: imported } of decl.items) {
          if (imported.kind === 'ImportFunc' && imported.ident === name && offset >= imported.span.start && offset < imported.signature.span.start) return imported
        }
      }
    }
    return undefined
  }
  const decl = find(module.decls)
  return decl && (checkResult.funcNames.get(decl) ?? name)
}

// Where the def or data whose name is written at `offset` is recorded: where
// its declaration starts. Also one a test declares, which by name would be
// the last of its name in the module (each test may declare its own).
function valueDeclaredAt(module: AST.Module, offset: number, name: string): number | undefined {
  const find = (items: readonly (AST.Declaration | AST.TestItem)[]): number | undefined => {
    for (const item of items) {
      const decl = item.kind === 'ExportDecl' ? item.item : item
      if (decl.kind === 'TestDecl') {
        const found = find(decl.children)
        if (found !== undefined) return found
      } else if ((decl.kind === 'DataDecl' || decl.kind === 'DefDecl') && decl.ident === name
        && offset > decl.span.start && offset < (decl.type ?? decl.value).span.start) {
        return decl.span.start
      }
    }
    return undefined
  }
  return find(module.decls)
}

// The name by which the function called at `offset` is known: of functions
// that share the name `name`, the one that call means. Undefined for
// anything but a call of a function of the module.
function calledAt(checkResult: TypeCheckResult, offset: number, name: string): string | undefined {
  if (checkResult.symbols.get(name)?.kind !== 'func' || identExprType(checkResult, offset)?.kind !== 'func') return undefined
  for (const [, first] of checkResult.calls) {
    if (first.kind !== 'CallExpr' || first.callee.kind !== 'IdentExpr' || first.callee.span.start !== offset) continue
    // x.f(a) stands for f(x, a), which in turn stands for the one it means.
    let compiled = first
    for (let next = checkResult.calls.get(compiled); next?.kind === 'CallExpr'; next = checkResult.calls.get(compiled)) compiled = next
    if (compiled.callee.kind === 'IdentExpr' && declaredName(compiled.callee.name) === name) return compiled.callee.name
  }
  // Nothing is recorded for a call of the first one declared: the name is
  // the name it is known by.
  return name
}

// Whether a parameter, local, loop variable or if-let binding is defined at
// `offset`: the checker recorded a definition there that is none of the
// module's names. Those are found by name, and a function's, a def's or a
// data's is recorded where its declaration starts, at a keyword.
function localDefinedAt(checkResult: TypeCheckResult, offset: number): boolean {
  return checkResult.references.has(offset) && ![...checkResult.symbolDefOffsets.values()].includes(offset)
}

// Where the name at `offset` is defined: exactly, when the checker recorded
// this position as a use or as a definition; by name otherwise, which finds
// the names of the module. A generic's own parameters and locals are never
// looked up by name: they are in no table of names, so the name would be some
// other function's, and a rename from it would edit that function. Nor is a
// field's name: fields are not followed, and by name a field would be the
// global or the parameter spelled like it.
function definitionOf(
  source: string,
  module: AST.Module,
  checkResult: TypeCheckResult,
  offset: number,
  name: string,
): number | undefined {
  const start = wordStart(source, offset)
  const declared = declaredAt(module, checkResult, start, name)
  if (declared !== undefined) return checkResult.symbolDefOffsets.get(declared)
  const value = valueDeclaredAt(module, start, name)
  if (value !== undefined && checkResult.references.has(value)) return value
  // A call in a generic's body means, of functions that share a name, one
  // function per instance, and is recorded as a use of each: it goes to the
  // one the first instance calls, which is the one hover shows there.
  const generic = genericAround(module, start)
  const shift = generic && firstInstanceShift(checkResult, generic)
  const called = shift ? calledAt(checkResult, start + shift, name) : undefined
  if (called !== undefined) return checkResult.symbolDefOffsets.get(called)
  const exact = checkResult.symbolRefs.get(offset) ?? checkResult.symbolRefs.get(start)
  if (exact !== undefined) return exact
  if (genericDeclaring(module, start, name)) {
    return checkResult.references.has(start) ? start : undefined
  }
  if (localDefinedAt(checkResult, start)) return start
  if (fieldNamedAt(module, start)) return undefined
  return checkResult.symbolDefOffsets.get(name)
}

// The functions that share a name with the one defined at `defOffset`: where
// each is defined, itself included. Empty for anything that has its name to
// itself.
function sharing(checkResult: TypeCheckResult, defOffset: number): number[] {
  const known = new Set(checkResult.funcNames.values())
  const names = (name: string) => [name, ...[...known].filter(k => k !== name && declaredName(k) === name)]
  for (const [name, offset] of checkResult.symbolDefOffsets) {
    if (offset !== defOffset || checkResult.symbols.get(name)?.kind !== 'func') continue
    const members = names(declaredName(name))
    if (members.length < 2 || !members.includes(name)) continue
    return members.flatMap(member => checkResult.symbolDefOffsets.get(member) ?? [])
  }
  return []
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

// What a parameter, a local or a use of one at an offset is: by the binding
// declared there (by a let, a for, an if let or a function's signature), or
// by the identifier used there.
function localType(checkResult: TypeCheckResult, offset: number): ResolvedType | undefined {
  return checkResult.types.get(typeKey(offset, 'IdentPattern'))
    ?? checkResult.types.get(typeKey(offset, 'Binding'))
    ?? identExprType(checkResult, offset)
    ?? checkResult.types.get(typeKey(offset, 'Field'))
}

// The type of the field named at an offset after a point (`p.x`), as the
// checker typed the member.
function memberType(checkResult: TypeCheckResult, offset: number): ResolvedType | undefined {
  for (const [expr, type] of checkResult.exprTypes) {
    if (expr.kind === 'MemberExpr' && expr.member.kind === 'field' && expr.span.end - expr.member.name.length === offset) return type
  }
  return undefined
}

// How far the offsets of a generic's first instance lie from the generic's
// own. What a name in a generic's body is depends on the instance; the first
// one is the one that is shown. Undefined while nothing has called it.
function firstInstanceShift(checkResult: TypeCheckResult, generic: AST.FuncDecl): number | undefined {
  const first = checkResult.instances.find((inst) => inst.of === generic)
  return first && first.decl.span.start - generic.span.start
}

// The function a call at this name means, as the checker typed its callee:
// the instance of a generic, the one meant of functions that share a name,
// and for x.f(a) the function f. In a generic's body, as its first instance
// has it: the body's own nodes are never checked.
function calledType(module: AST.Module, checkResult: TypeCheckResult, offset: number): ResolvedType | undefined {
  const generic = genericAround(module, offset)
  const shift = generic && firstInstanceShift(checkResult, generic)
  const type = identExprType(checkResult, offset) ?? (shift ? identExprType(checkResult, offset + shift) : undefined)
  return type?.kind === 'func' ? type : undefined
}

export function hover(
  source: string,
  module: AST.Module,
  checkResult: TypeCheckResult,
  offset: number,
): HoverResult | null {
  const name = identAtOffset(source, offset)
  if (!name) return null

  // A generic's own names come before the module's. What one of them is
  // depends on the instance: it is shown as it is in the first one, and not at
  // all while nothing has called the generic.
  const generic = genericDeclaring(module, wordStart(source, offset), name)
  if (generic) {
    // A generic type has no instance to show its own names by.
    const shift = generic.kind === 'FuncDecl' ? firstInstanceShift(checkResult, generic) : undefined
    const type = shift ? localType(checkResult, offset + shift) : undefined
    return type ? { name, type: typeToString(type) + typeCostAnnotation(type), kind: 'local' } : null
  }

  // A parameter or a local, where it is defined or used, is what the checker
  // recorded there, or else what it was defined as (where `set` assigns it),
  // and never a name of the module spelled the same (a global the parameter
  // is named like).
  const start = wordStart(source, offset)
  const defined = checkResult.symbolRefs.get(start) ?? (checkResult.references.has(start) ? start : undefined)
  if (defined !== undefined && localDefinedAt(checkResult, defined)) {
    const type = localType(checkResult, start) ?? localType(checkResult, defined)
    return type ? { name, type: typeToString(type) + typeCostAnnotation(type), kind: 'local' } : null
  }

  // A field is not the module's name spelled like it: it is shown after a
  // point as the member's type, and not at all where a type declares it.
  if (defined === undefined && fieldNamedAt(module, start)) {
    const type = memberType(checkResult, start)
    return type ? { name, type: typeToString(type) + typeCostAnnotation(type), kind: 'field' } : null
  }

  // Check module-scope symbols first. A function that shares its name is, at
  // its own declaration, the one declared there.
  const sym = checkResult.symbols.get(declaredAt(module, checkResult, start, name) ?? name)
  if (sym) {
    // A generic has a signature per instance. At a call the checker recorded
    // the one that call uses, as the type of the callee. It did the same for
    // the function that a call of a shared name means.
    if (sym.kind === 'generic' || sym.kind === 'func') {
      const called = calledType(module, checkResult, wordStart(source, offset))
      if (called) return { name, type: typeToString(called), kind: sym.kind }
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
  const type = localType(checkResult, offset)
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
            name: declaredName(symName),
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

  // A call spells the name and not which of the functions that share it is
  // meant, and a call in a generic's body means one or another by instance:
  // the name is renamed for all of them, or the program no longer checks.
  const shared = sharing(checkResult, defOffset)
  const defs = shared.length > 0 ? shared : [defOffset]
  const refs = new Set(defs.flatMap(def => checkResult.references.get(def) ?? []))
  const locations: Location[] = [
    ...defs.map(def => ({ offset: def, length: name.length })),
    ...[...refs].sort((a, b) => a - b).map(r => ({ offset: r, length: name.length })),
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
          const sym = checkResult.symbols.get(checkResult.funcNames.get(decl) ?? decl.ident)
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
          const sym = checkResult.symbols.get(checkResult.funcNames.get(item) ?? item.ident)
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
  // checker recorded as the type of the callee; of functions that share a
  // name, the call uses the one recorded there.
  const called = sym?.kind === 'generic' || sym?.kind === 'func' ? calledType(module, checkResult, wordStart(source, offset)) : undefined
  const ft = called ?? (sym?.kind === 'func' ? sym.type : null)
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
