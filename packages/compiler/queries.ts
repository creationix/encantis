// Query layer for Encantis — pure functions over parsed/checked programs.
// Used by both the LSP server and the CLI.

import type * as AST from './ast'
import type { TypeCheckResult, Symbol as CheckSymbol } from './checker'
import { typeKey, typecheck, declaredName, genericAround, genericDeclaring, fieldNamedAt, readAsModuleName } from './checker'
import { parse } from './parser'
import { typeToString, type ResolvedType, type ResolvedField, byteSize, unwrap, isValueArray, enumText } from './types'
import { typeToWasm } from './codegen'
import { LineMap, type Position } from './position'
import {
  ownName,
  callOf,
  memberIn,
  instancesListed,
  applicationsListed,
  identTypeAt,
  memberTypeAt,
  bindingTypeAt,
  type PerInstance,
} from './instances'
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
  // The function a call at this name calls, where the name alone does not
  // say it: an instance of a generic (index_of(T = u32)), or the function a
  // comptime function parameter stands for
  calls?: string
  // For a method call x.f(a), the call it is: f(x, a)
  as?: string
  // What the name is in each instance there is: in a generic's body, of the
  // generic it is in; for a generic, its own instances; for a generic type
  // and its own names, its applications. Instances in which it is the same
  // are listed together, and `more` counts those past the ones listed.
  instances?: PerInstance[]
  more?: number
}

// A hover as one line of text, as the CLI prints it:
// local x: T — in index_of(T = u32): u32; in index_of(T = f64): f64
// The field of an enum's payload declared at `offset` in this module, or
// named there (the checker records the uses of fields, TypeCheckResult.fieldNames)
function payloadFieldAt(module: AST.Module, checkResult: TypeCheckResult, offset: number): ResolvedField | null {
  const declared = (at: number): ResolvedField | null => {
    for (const decl of module.decls) {
      if (decl.kind !== 'EnumDecl') continue
      for (const [k, v] of decl.variants.entries()) {
        const j = (v.fields ?? []).findIndex((f) => f.ident !== null && (f.identSpan?.start ?? f.span.start) === at)
        if (j < 0) continue
        const sym = checkResult.symbols.get(decl.ident)
        const e = sym?.kind === 'type' ? unwrap(sym.type) : null
        return e?.kind === 'enum' ? e.variants[k].fields?.[j] ?? null : null
      }
    }
    return null
  }
  const own = declared(offset)
  if (own) return own
  for (const place of checkResult.fieldNames.get(offset) ?? []) {
    if (place.file !== null) continue
    const found = declared(place.offset)
    if (found) return found
  }
  return null
}

export function hoverText(r: HoverResult): string {
  const head = `${r.kind} ${r.name}: ${r.type}${r.value !== undefined ? ` = ${r.value}` : ''}`
  const parts = [
    ...(r.as !== undefined ? [r.as] : []),
    ...(r.calls !== undefined ? [`calls ${r.calls}`] : []),
    ...(r.instances ?? []).map((i) => `in ${i.in.join(', ')}: ${i.type}`),
    ...(r.more !== undefined ? [`and ${r.more} more instance${r.more === 1 ? '' : 's'}`] : []),
  ]
  return parts.length > 0 ? `${head} — ${parts.join('; ')}` : head
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
  // Calls in instances of other modules' generics that find the function
  // by its name at this module (see 8.7), in those modules' sources; only
  // where there are any
  elsewhere?: ExternalLocation[]
}

export interface ExternalLocation {
  path: string
  offset: number
  length: number
  label: string
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
  const start = wordStart(source, offset)
  let end = offset
  while (end < source.length && /[a-zA-Z0-9_\-]/.test(source[end])) end++
  return start < end ? source.slice(start, end) : null
}

// The offset at which the identifier around `offset` begins. A name starts
// with a letter: a minus before it negates it (-k).
function wordStart(source: string, offset: number): number {
  let start = offset
  while (start > 0 && /[a-zA-Z0-9_-]/.test(source[start - 1])) start--
  while (source[start] === '-' && /[a-zA-Z_]/.test(source[start + 1] ?? '')) start++
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

  const defOffset = definitionOf(source, module, checkResult, offset, name) ?? payloadFieldDeclaredAt(module, checkResult, wordStart(source, offset))
  if (defOffset === undefined) return null

  return {
    name,
    location: { offset: defOffset, length: name.length },
  }
}

// Where the field of an enum's payload named at `start` is declared, where
// this module declares it
function payloadFieldDeclaredAt(module: AST.Module, checkResult: TypeCheckResult, start: number): number | undefined {
  const fields = checkResult.fieldNames.get(start)
  if (fields?.length !== 1 || fields[0].file !== null) return undefined
  const declared = fields[0].offset
  const inPayload = module.decls.some((d) => d.kind === 'EnumDecl' && d.variants.some((v) => (v.fields ?? []).some((f) => (f.identSpan?.start ?? f.span.start) === declared)))
  return inPayload ? declared : undefined
}

// The type of the identifier used (not declared) at an offset.
const identExprType = identTypeAt

// What a parameter, a local or a use of one at an offset is: by the binding
// declared there (by a let, a for, an if let or a function's signature), or
// by the identifier used there.
const localType = bindingTypeAt

// The type of the field named at an offset after a point (`p.x`), as the
// checker typed the member.
const memberType = memberTypeAt

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
  // depends on the instance: it is shown with the type it is declared with,
  // in terms of the type parameters, and with what it is in each instance (in
  // each application, for a generic type's).
  const start = wordStart(source, offset)
  // A field after a point in a generic's body is a member in each instance.
  const member = memberIn(module, checkResult, start, shown)
  if (member?.type && member.kind) {
    const { kind, type, ...rest } = member
    return { name, type, kind, ...rest }
  }
  const generic = genericDeclaring(module, start, name)
  if (generic && !readAsModuleName(checkResult, start)) {
    const own = ownName(source, checkResult, generic, start, name, shown)
    if (!own?.type || !own.kind) return null
    const { kind, type, ...rest } = own
    return { name, type, kind, ...rest }
  }

  // A parameter or a local, where it is defined or used, is what the checker
  // recorded there, or else what it was defined as (where `set` assigns it),
  // and never a name of the module spelled the same (a global the parameter
  // is named like).
  const defined = checkResult.symbolRefs.get(start) ?? (checkResult.references.has(start) ? start : undefined)
  if (defined !== undefined && localDefinedAt(checkResult, defined)) {
    const type = localType(checkResult, start) ?? localType(checkResult, defined)
    return type ? { name, type: typeToString(type) + typeCostAnnotation(type), kind: 'local' } : null
  }

  // A field of an enum's payload, where it is declared or named (a named
  // argument of a constructor, a part of a pattern by name)
  const payloadField = payloadFieldAt(module, checkResult, start)
  if (payloadField) return { name, type: typeToString(payloadField.type), kind: 'field' }

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
    // the function that a call of a shared name means. With it go the
    // function called (the instance), for x.f(a) the call f(x, a), and in a
    // generic's body what each instance calls.
    if (sym.kind === 'generic' || sym.kind === 'func') {
      const called = calledType(module, checkResult, start)
      if (called) return { name, type: typeToString(called), kind: sym.kind, ...callOf(source, module, checkResult, start, name) }
    }
    const result: HoverResult = {
      name,
      type: symbolTypeString(sym, source, name),
      kind: sym.kind,
    }
    // A generic is shown with its instances, a generic type with its
    // applications.
    if (sym.kind === 'generic') Object.assign(result, instancesListed(checkResult, sym.decl))
    if (sym.kind === 'typefunc') Object.assign(result, applicationsListed(checkResult, sym.decl, shown))
    // A variant's value is its tag
    if (sym.kind === 'variant') result.value = String(sym.index)
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
  if (defOffset === undefined) {
    // A field: its declaration, and every place the module names it
    const declared = payloadFieldDeclaredAt(module, checkResult, wordStart(source, offset))
    if (declared === undefined) return null
    return {
      definition: { offset: declared, length: name.length },
      references: fieldUses(checkResult, declared).filter((at) => at !== declared).map((r) => ({ offset: r, length: name.length })),
    }
  }

  const refs = checkResult.references.get(defOffset) ?? []
  const elsewhere = calledFromElsewhere(checkResult, [defOffset], name)
  return {
    definition: { offset: defOffset, length: name.length },
    references: refs.map(r => ({ offset: r, length: name.length })),
    ...(elsewhere.length > 0 ? { elsewhere } : {}),
  }
}

// The calls of other modules' instances that find the functions declared
// at these offsets by their name
function calledFromElsewhere(checkResult: TypeCheckResult, defs: number[], name: string): ExternalLocation[] {
  const found: ExternalLocation[] = []
  for (const [known, offset] of checkResult.symbolDefOffsets) {
    if (!defs.includes(offset)) continue
    for (const call of checkResult.calledFromInstances.get(known) ?? []) {
      if (!found.some(f => f.path === call.path && f.offset === call.offset)) found.push({ ...call, length: name.length })
    }
  }
  return found
}

export interface RenameResult {
  oldName: string
  locations: RenameLocation[]
  // Why the name cannot be renamed here, where it cannot
  refused?: string
  // Where the name renamed is a field's (a struct's, a named result's): the
  // offset of its declaration, which other modules may name it by too
  field?: number
}

export interface RenameLocation extends Location {
  // Where the name is a field's (a struct's, or a named result's where the
  // result is taken apart): there a shorthand `count:` keeps the variable it
  // stands for, `total: count`.
  field?: true
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
  if (defOffset === undefined) return renameField(source, module, checkResult, wordStart(source, offset), name)

  // A call spells the name and not which of the functions that share it is
  // meant, and a call in a generic's body means one or another by instance:
  // the name is renamed for all of them, or the program no longer checks.
  const shared = sharing(checkResult, defOffset)
  const defs = shared.length > 0 ? shared : [defOffset]
  // A generic's body in another module calls the function by its name,
  // which that module's own functions of the name share: renamed here, the
  // instance would no longer find it, and there it would no longer be the
  // generic's.
  const elsewhere = calledFromElsewhere(checkResult, defs, name)
  if (elsewhere.length > 0) {
    const by = [...new Set(elsewhere.map(e => `${e.label} in ${e.path.replace(/^.*[\\/]/, '')}`))].join(', ')
    return { oldName: name, locations: [], refused: `'${name}' is called by its name from instances of other modules' generics (${by}): renamed, they would no longer find it` }
  }
  const refs = new Set(defs.flatMap(def => checkResult.references.get(def) ?? []))
  const locations: RenameLocation[] = [
    ...defs.map(def => ({ offset: nameFrom(source, name, def), length: name.length })),
    ...[...refs].sort((a, b) => a - b).map(r => ({ offset: r, length: name.length })),
  ]
  // A named result is also a field of what its function gives back, named
  // where the result is taken apart (`pair(n).count`, `let (count:) =
  // pair(n)`): renamed with it.
  const named = new Set(locations.map(l => l.offset))
  const fields = defs.flatMap(def => fieldUses(checkResult, def)).filter(at => !named.has(at))
  locations.push(...fields.map(at => ({ offset: at, length: name.length, field: true as const })))
  const field = defs.find(def => fieldUses(checkResult, def).length > 0)

  return { oldName: name, locations, ...(field !== undefined ? { field } : {}) }
}

// The places that name the field this module declares where its name is
// written at `declared`, the declaration among them, in order
function fieldUses(checkResult: TypeCheckResult, declared: number): number[] {
  return [...checkResult.fieldNames]
    .filter(([, fields]) => fields.some(f => f.file === null && f.offset === declared))
    .map(([at]) => at)
    .sort((a, b) => a - b)
}

// Renaming the field named at `start`: where its struct declares it and
// everywhere the module names it. The field of a named result is renamed as
// the result is. Refused where the struct is another module's, which names it
// in its own source, or where the name is in a generic's body and is a field
// of a struct of each instance's own.
function renameField(source: string, module: AST.Module, checkResult: TypeCheckResult, start: number, name: string): RenameResult | null {
  const fields = checkResult.fieldNames.get(start)
  if (!fields || fields.length === 0) return null
  if (fields.length > 1) {
    return { oldName: name, locations: [], refused: `'${name}' here is a field of a different struct in each instance of the generic: rename it where each struct is declared` }
  }
  const [field] = fields
  if (field.file !== null) {
    return { oldName: name, locations: [], refused: `'${name}' is a field of a struct that ${field.file.replace(/^.*[\\/]/, '')} declares: rename it there` }
  }
  // A named result's field is declared where the result is, a name of its
  // function's
  if (checkResult.references.has(field.offset)) return rename(source, module, checkResult, field.offset)
  const locations = fieldUses(checkResult, field.offset).map(at => ({ offset: at, length: name.length, field: true as const }))
  return { oldName: name, locations, field: field.offset }
}

// Where a name is written at a definition: a function's is recorded where its
// declaration starts (at `func`), an import's where its item does (at the
// name it is exported by, in quotes), and what is renamed is the name. The
// first time the name is written as a whole name from there, and not in
// quotes, or the offset itself.
function nameFrom(source: string, name: string, from: number): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(?<![A-Za-z0-9_"-])${escaped}(?![A-Za-z0-9_"-])`, 'g')
  pattern.lastIndex = from
  return pattern.exec(source)?.index ?? from
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
      case 'EnumDecl': {
        // An enum, then its variants
        const sym = checkResult.symbols.get(decl.ident)
        symbols.push({
          name: decl.ident,
          kind: 'type',
          type: sym ? symbolTypeString(sym, source, decl.ident) : '',
          offset: decl.identSpan.start,
          length: decl.ident.length,
          exported: false,
        })
        for (const v of decl.variants) {
          const variant = checkResult.symbols.get(v.name)
          symbols.push({
            name: v.name,
            kind: 'variant',
            type: variant?.kind === 'variant' ? symbolTypeString(variant, source, v.name) : '',
            offset: v.span.start,
            length: v.name.length,
            exported: false,
          })
        }
        break
      }
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

// A type as hover shows it, with what a value of it costs
function shown(type: ResolvedType): string {
  return typeToString(type) + typeCostAnnotation(type)
}

function typeCostAnnotation(type: ResolvedType): string {
  const u = unwrap(type)
  if (u.kind === 'array' && u.sizes && !u.sizes.includes('_')) {
    const size = byteSize(u)
    if (size !== null) return ` (${size} bytes)`
    // An array with no bytes (of host references) is its registers, as a
    // tuple is.
    if (isValueArray(u)) {
      const slots = typeToWasm(u).length
      if (slots > 1) return ` (${slots} slots)`
    }
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

function symbolTypeString(sym: CheckSymbol, source?: string, name?: string): string {
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
  // A variant: what it is constructed from, and its enum
  if (sym.kind === 'variant') {
    const e = unwrap(sym.type)
    const fields = e.kind === 'enum' ? e.variants[sym.index].fields : null
    return fields ? `(${fields.map((f) => (f.name ? `${f.name}: ${typeToString(f.type)}` : typeToString(f.type))).join(', ')}) -> ${base}` : base
  }
  // A host type is named for itself: what it is, is a host reference. A
  // name for it (type Screen = Canvas) is that type.
  if (sym.kind === 'type') {
    const u = unwrap(sym.type)
    // An enum is written out
    if (u.kind === 'enum') return enumText(u)
    return u.kind === 'host' && !u.optional && (name === undefined || u.name === name) ? 'host' : base
  }
  return base + typeCostAnnotation(sym.type)
}
