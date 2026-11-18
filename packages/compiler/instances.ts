// What a generic is in each instance the program makes of it, for the editor
// (queries.ts and meta.ts, which the language server shows).
//
// A generic function's body is checked only in its instances, each a copy of
// the declaration at offsets of its own (instance i at i * INSTANCE_STRIDE +
// original). What a name in the body is, it is in an instance, and it may be
// something else in the next: a parameter `x: T` is a u32 in
// index_of(T = u32) and an f64 in index_of(T = f64), and a call eq(y, x) calls
// one function of that name in one instance and another in the next. So a
// generic's own names are shown with the type they are declared with, in
// terms of its type parameters, and with what they are in each instance; a
// call in its body with the function each instance calls. A generic type is
// shown with each of its applications.
//
// Nothing here imports a module of the host (fs, path): meta.ts runs in the
// language server's web worker too.

import type * as AST from './ast'
import {
  typeKey,
  instanceNodes,
  declaredName,
  isGenericDecl,
  type TypeCheckResult,
  type InstanceInfo,
  type ComptimeValue,
  type Application,
} from './checker'
import { typeToString, unwrap, named, canonicalKey, type ResolvedType, type ResolvedField } from './types'

// How many instances (or applications) are listed; past that they are counted
export const MAX_LISTED = 12

// One instance of a generic function as the editor reads it
export interface InstanceView {
  info: InstanceInfo
  // How far the copy's offsets lie from the generic's
  shift: number
  // Each comptime parameter, by name, with what this instance was given
  bound: Map<string, ComptimeValue>
}

// What a name is in some instances: those named in `in` (as messages name
// them, index_of(T = u32)), in which it is `type`. Instances in which it is
// the same are listed together.
export interface PerInstance {
  in: string[]
  type: string
}

export interface Listing {
  instances: PerInstance[]
  // How many instances there are past the ones listed
  more?: number
}

// What hover shows of a name for which a generic's instances matter. `type`
// and `kind` replace what the name would be shown as by itself.
export interface GenericInfo {
  kind?: string
  type?: string
  // The function a call at this name calls, where the name alone does not
  // say it: an instance of a generic (index_of(T = u32)), the function a
  // comptime function parameter stands for
  calls?: string
  // For x.f(a), the call it is: f(x, a)
  as?: string
  instances?: PerInstance[]
  more?: number
}

// What a type looks like in a listing: queries.ts adds what it costs
export type Show = (type: ResolvedType) => string

const caches = new WeakMap<TypeCheckResult, {
  views: Map<AST.FuncDecl, InstanceView[]>
  nodes: Map<InstanceInfo, Map<object, object>>
  idents: Map<number, ResolvedType>
  members: Map<number, ResolvedType>
  calls: Map<number, AST.CallExpr>
}>()

// The tables the editor asks of one check, made once: the checker records the
// type of an expression by node, and the editor asks by offset.
function cache(check: TypeCheckResult) {
  let found = caches.get(check)
  if (found) return found
  const idents = new Map<number, ResolvedType>()
  const members = new Map<number, ResolvedType>()
  for (const [expr, type] of check.exprTypes) {
    // The first one recorded at an offset is the one found: a def's value is
    // pasted at each use with its offsets.
    if (expr.kind === 'IdentExpr' && !idents.has(expr.span.start)) idents.set(expr.span.start, type)
    if (expr.kind === 'MemberExpr' && expr.member.kind === 'field') {
      const at = expr.span.end - expr.member.name.length
      if (!members.has(at)) members.set(at, type)
    }
  }
  // A call recorded as another, by where the name it calls is written: f in
  // f(a), and f in x.f(a), where the call written is kept before the call
  // f(x, a) it stands for, which starts at the same name.
  const calls = new Map<number, AST.CallExpr>()
  for (const call of check.calls.keys()) {
    const callee = call.callee
    if (callee.kind === 'MemberExpr' && callee.member.kind === 'field') calls.set(callee.span.end - callee.member.name.length, call)
  }
  for (const call of check.calls.keys()) {
    if (call.callee.kind === 'IdentExpr' && !calls.has(call.callee.span.start)) calls.set(call.callee.span.start, call)
  }
  found = { views: new Map(), nodes: new Map(), idents, members, calls }
  caches.set(check, found)
  return found
}

// The type of the identifier used (not declared) at an offset
export function identTypeAt(check: TypeCheckResult, offset: number): ResolvedType | undefined {
  return cache(check).idents.get(offset)
}

// The type of the field named at an offset after a point (`p.x`)
export function memberTypeAt(check: TypeCheckResult, offset: number): ResolvedType | undefined {
  return cache(check).members.get(offset)
}

// What a parameter, a local or a use of one at an offset is: by the binding
// declared there (by a let, a for, an if let or a function's signature), or
// by the identifier used there.
export function bindingTypeAt(check: TypeCheckResult, offset: number): ResolvedType | undefined {
  return check.types.get(typeKey(offset, 'IdentPattern'))
    ?? check.types.get(typeKey(offset, 'Binding'))
    ?? identTypeAt(check, offset)
    ?? check.types.get(typeKey(offset, 'Field'))
}

// The instances of a generic function, in the order they were asked for
export function instancesOf(check: TypeCheckResult, generic: AST.FuncDecl): InstanceView[] {
  const { views } = cache(check)
  const known = views.get(generic)
  if (known) return known
  const comptime = comptimeParams(generic)
  const made = check.instances.filter((inst) => inst.of === generic).map((info) => ({
    info,
    shift: info.decl.span.start - generic.span.start,
    bound: new Map(comptime.map((p, i) => [p.ident as string, info.args[i]])),
  }))
  views.set(generic, made)
  return made
}

// The copy of one of a generic's nodes in an instance
export function copyIn<T extends object>(check: TypeCheckResult, view: InstanceView, node: T): T | undefined {
  const { nodes } = cache(check)
  let copies = nodes.get(view.info)
  if (!copies) {
    copies = instanceNodes(view.info.of, view.info.decl)
    nodes.set(view.info, copies)
  }
  return copies.get(node) as T | undefined
}

function comptimeParams(generic: AST.FuncDecl): AST.Field[] {
  const input = generic.signature.input
  return input.kind === 'CompositeType' ? input.fields.filter((f) => f.comptime) : []
}

// What a name is in each of the first instances, those that agree together
export function listing<T>(items: readonly T[], label: (item: T) => string, what: (item: T) => string | undefined): Listing | undefined {
  const groups: PerInstance[] = []
  for (const item of items.slice(0, MAX_LISTED)) {
    const type = what(item)
    if (type === undefined) continue
    const group = groups.find((g) => g.type === type)
    if (group) group.in.push(label(item))
    else groups.push({ in: [label(item)], type })
  }
  if (groups.length === 0) return undefined
  return items.length > MAX_LISTED ? { instances: groups, more: items.length - MAX_LISTED } : { instances: groups }
}

function listed(list: Listing | undefined): Pick<GenericInfo, 'instances' | 'more'> {
  if (!list) return {}
  return list.more === undefined ? { instances: list.instances } : { instances: list.instances, more: list.more }
}

// The type that is each of these in its own instance, written with the type
// parameters where the instances differ as their type arguments do: a local
// that is a u32 in index_of(T = u32) and an f64 in index_of(T = f64) is a T.
// Where all of them are one type, that is the type, also when it is what a
// type parameter is bound to (with one instance, n: u32 and x: T would read
// alike). Null where they differ in some other way, or as two type parameters
// do that every instance binds alike.
export function generalize(types: readonly ResolvedType[], views: readonly InstanceView[]): ResolvedType | null {
  const params = [...(views[0]?.bound.keys() ?? [])].filter((name) => views.every((v) => v.bound.get(name)?.kind === 'type'))
  const bound = (v: InstanceView, name: string) => (v.bound.get(name) as ComptimeValue & { kind: 'type' }).type
  // Types compare as instances do, structurally: an instance holds the
  // struct Pt by its name, and a local of it may have the struct itself.
  const key = (type: ResolvedType) => {
    try {
      return canonicalKey(type)
    } catch {
      return typeToString(type)
    }
  }
  const go = (here: readonly ResolvedType[]): ResolvedType | null => {
    const texts = here.map(key)
    if (texts.every((t) => t === texts[0])) return here[0]
    // The type parameter whose arguments these follow; where two of them are
    // bound alike in every instance, which one it is cannot be told.
    const following = params.filter((name) => views.every((v, i) => key(bound(v, name)) === texts[i]))
    if (following.length > 1) return null
    if (following.length === 1) return named(following[0], here[0])
    const first = here[0]
    if (here.some((t) => t.kind !== first.kind)) {
      // An alias in some instances and not in others is what it names.
      return here.some((t) => t.kind === 'named') ? go(here.map(unwrap)) : null
    }
    const fields = (lists: readonly (readonly ResolvedField[])[]): ResolvedField[] | null => {
      const [model] = lists
      if (lists.some((l) => l.length !== model.length || l.some((f, i) => f.name !== model[i].name))) return null
      const out: ResolvedField[] = []
      for (let i = 0; i < model.length; i++) {
        const type = go(lists.map((l) => l[i].type))
        if (!type) return null
        out.push({ ...model[i], type })
      }
      return out
    }
    switch (first.kind) {
      case 'named':
        return go(here.map(unwrap))
      case 'pointer': {
        const all = here as (typeof first)[]
        if (all.some((t) => t.mutable !== first.mutable || t.optional !== first.optional || t.boundary !== first.boundary)) return null
        const pointee = go(all.map((t) => t.pointee))
        return pointee && { ...first, pointee }
      }
      case 'slice': {
        const all = here as (typeof first)[]
        if (all.some((t) => t.mutable !== first.mutable || t.optional !== first.optional)) return null
        const element = go(all.map((t) => t.element))
        return element && { ...first, element }
      }
      case 'array': {
        const all = here as (typeof first)[]
        if (all.some((t) => JSON.stringify(t.sizes) !== JSON.stringify(first.sizes))) return null
        const element = go(all.map((t) => t.element))
        return element && { ...first, element }
      }
      case 'tuple': {
        const out = fields((here as (typeof first)[]).map((t) => t.fields))
        return out && { ...first, fields: out }
      }
      case 'func': {
        const all = here as (typeof first)[]
        const params = fields(all.map((t) => t.params))
        const returns = params && fields(all.map((t) => t.returns))
        return returns && { ...first, params: params as ResolvedField[], returns }
      }
      default:
        return null
    }
  }
  return types.length > 0 ? go(types) : null
}

// What a name whose type is not written is declared as, from what it is in
// each instance: in terms of the type parameters where that says it, or else
// each type it is ("f32 or i64"). Undefined where no instance has it.
function declared(types: readonly (ResolvedType | undefined)[], views: readonly InstanceView[], write: Show): string | undefined {
  const known = types.filter((t): t is ResolvedType => t !== undefined)
  if (known.length === 0) return undefined
  const general = known.length === types.length ? generalize(known, views) : null
  return general ? write(general) : [...new Set(known.map(write))].join(' or ')
}

// A function by its name, with its signature: eq(a: u32, b: u32) -> bool
function signed(name: string, type: ResolvedType): string {
  const text = typeToString(type)
  return type.kind === 'func' && text.startsWith('func') ? `${name}${text.slice(4)}` : `${name}: ${text}`
}

// How a function the module knows by `known` is named for the editor: an
// instance as messages name it, a function that shares its name by that name.
function shownName(check: TypeCheckResult, known: string): string {
  return check.instances.find((inst) => inst.name === known)?.label ?? check.externs.get(known)?.label ?? declaredName(known)
}

// The call written at an offset, and what it is in the end: f(x, a) for
// x.f(a), and then the instance or the function of a shared name that one
// means. Undefined where the call at the offset is only what it says, or
// there is none.
function callAt(check: TypeCheckResult, offset: number): { written: AST.CallExpr; built?: AST.CallExpr; last: AST.CallExpr } | undefined {
  const written = cache(check).calls.get(offset)
  if (!written) return undefined
  const first = check.calls.get(written)
  const built = written.callee.kind === 'MemberExpr' && first?.kind === 'CallExpr' ? first : undefined
  let last = written
  for (let next = check.calls.get(last); next?.kind === 'CallExpr'; next = check.calls.get(last)) last = next
  return { written, built, last }
}

// What a call at the name at `offset` is: the function it calls (where its
// name does not say it) and, for x.f(a), the call f(x, a). `shift` takes the
// offsets of a generic's body to those of one of its instances.
function callInfo(check: TypeCheckResult, source: string, offset: number, name: string, shift = 0): { calls?: string; as?: string; known?: string } {
  const found = callAt(check, offset + shift)
  if (!found) return {}
  const { built, last } = found
  const out: { calls?: string; as?: string; known?: string } = {}
  if (last.callee.kind === 'IdentExpr') {
    out.known = last.callee.name
    const shown = shownName(check, last.callee.name)
    if (shown !== name) out.calls = shown
  }
  if (built?.callee.kind === 'IdentExpr') {
    const text = (node: { span: AST.Span }) => source.slice(node.span.start - shift, node.span.end - shift)
    const args = built.args.flatMap((a) => (a.value ? [text(a.value)] : []))
    out.as = `${built.callee.name}(${args.join(', ')})`
  }
  return out
}

// The types a generic writes for what it declares, by where each name
// stands: a parameter or a result (`x: T`), a local whose let says its type
// (`let y: T = x`), a field of a generic type. Read off the declaration once.
const writtenTypes = new WeakMap<AST.FuncDecl | AST.TypeFuncDecl, Map<number, AST.Type>>()

function writtenAt(decl: AST.FuncDecl | AST.TypeFuncDecl, offset: number, source: string): string | undefined {
  let types = writtenTypes.get(decl)
  if (!types) {
    const found = new Map<number, AST.Type>()
    const visit = (node: unknown): void => {
      if (node === null || typeof node !== 'object' || node instanceof Uint8Array) return
      if (Array.isArray(node)) {
        node.forEach(visit)
        return
      }
      const n = node as Record<string, unknown> & { kind?: string; span?: AST.Span }
      if (n.kind === 'Field' && typeof n.ident === 'string') {
        const at = ((n.identSpan as AST.Span | undefined) ?? n.span)?.start
        if (at !== undefined && !found.has(at)) found.set(at, n.type as AST.Type)
      }
      if (n.kind === 'LetStmt') {
        const pattern = n.pattern as AST.Pattern
        if (pattern.kind === 'IdentPattern' && n.type && !found.has(pattern.span.start)) found.set(pattern.span.start, n.type as AST.Type)
      }
      for (const [key, value] of Object.entries(n)) if (key !== 'span') visit(value)
    }
    visit(decl.kind === 'FuncDecl' ? [decl.signature, decl.body] : [decl.params, decl.body])
    writtenTypes.set(decl, found)
    types = found
  }
  const type = types.get(offset)
  return type && source.slice(type.span.start, type.span.end)
}

function typeParamOf(params: readonly AST.Field[], name: string): AST.Field | undefined {
  return params.find((p) => p.comptime && p.ident === name)
}

// A field of a generic type's body at `offset`, by the steps that lead to it
// from the body: the name of each field that holds the next written out, and
// ELEMENT where the next is the element of pointers, slices or arrays written
// around it (`items: [*](k: K, v: V)`)
const ELEMENT = '[]'

function fieldPath(body: AST.Type, offset: number): string[] | null {
  if (body.kind === 'PointerType' || body.kind === 'IndexedType') {
    const inner = fieldPath(body.kind === 'PointerType' ? body.pointee : body.element, offset)
    return inner && (inner[0] === ELEMENT ? inner : [ELEMENT, ...inner])
  }
  if (body.kind !== 'CompositeType') return null
  for (const field of body.fields) {
    if (field.ident === null) continue
    if (field.span.start === offset) return [field.ident]
    const inner = fieldPath(field.type, offset)
    if (inner) return [field.ident, ...inner]
  }
  return null
}

function fieldType(type: ResolvedType, path: readonly string[]): ResolvedType | undefined {
  let here: ResolvedType | undefined = type
  for (const step of path) {
    let struct: ResolvedType | undefined = here && unwrap(here)
    if (step === ELEMENT) {
      // [*]X is a pointer to an array of X, *[2]X too: every layer down.
      while (struct && (struct.kind === 'pointer' || struct.kind === 'slice' || struct.kind === 'array')) {
        struct = unwrap(struct.kind === 'pointer' ? struct.pointee : struct.element)
      }
      here = struct
      continue
    }
    here = struct?.kind === 'tuple' ? struct.fields.find((f) => f.name === step)?.type : undefined
  }
  return here
}

// What a name that a generic declares for itself is, at `offset` (where the
// word starts): a type parameter, a comptime function parameter, a parameter,
// a result or a local of a generic function, or a field of a generic type.
// Null where there is nothing to show.
export function ownName(
  source: string,
  check: TypeCheckResult,
  generic: AST.FuncDecl | AST.TypeFuncDecl,
  offset: number,
  name: string,
  show: Show,
  // How the type declared is written where it is not written in the source
  write: Show = (type) => typeToString(type),
): GenericInfo | null {
  if (generic.kind === 'TypeFuncDecl') {
    const applied = check.applications.get(generic) ?? []
    const shownApp = (a: Application) => a.shown
    const param = generic.params.findIndex((p) => p.ident === name)
    if (param >= 0 && generic.params[param].type.kind !== 'TypeType') {
      // A value parameter: each application gave it a number.
      const declared = generic.params[param].type
      const number = (a: Application) => {
        const arg = a.args[param]
        return arg?.kind === 'comptime_int' ? String(arg.value) : undefined
      }
      return { kind: 'value parameter', type: source.slice(declared.span.start, declared.span.end), ...listed(listing(applied, shownApp, number)) }
    }
    if (param >= 0) {
      return { kind: 'type parameter', type: 'type', ...listed(listing(applied, shownApp, (a) => show(a.args[param]))) }
    }
    const written = writtenAt(generic, offset, source)
    const path = fieldPath(generic.body, offset)
    if (written === undefined) return null
    const list = path ? listing(applied, shownApp, (a) => {
      const type = fieldType(a.type, path)
      return type && show(type)
    }) : undefined
    return { kind: 'field', type: written, ...listed(list) }
  }

  const views = instancesOf(check, generic)
  const param = typeParamOf(comptimeParams(generic), name)
  if (param && param.type.kind === 'TypeType') {
    return {
      kind: 'type parameter',
      type: 'type',
      ...listed(listing(views, (v) => v.info.label, (v) => {
        const value = v.bound.get(name)
        return value?.kind === 'type' ? show(value.type) : undefined
      })),
    }
  }
  if (param && views.some((v) => v.bound.get(name)?.kind === 'int')) {
    // A value parameter: each instance was given a number.
    const list = listing(views, (v) => v.info.label, (v) => {
      const value = v.bound.get(name)
      return value?.kind === 'int' ? String(value.value) : undefined
    })
    return { kind: 'value parameter', type: source.slice(param.type.span.start, param.type.span.end), ...listed(list) }
  }
  if (param) {
    // A comptime function parameter: each instance was given a function.
    const list = listing(views, (v) => v.info.label, (v) => {
      const value = v.bound.get(name)
      return value?.kind === 'func' ? signed(declaredName(value.name), value.type) : undefined
    })
    return { kind: 'comptime parameter', type: source.slice(param.type.span.start, param.type.span.end), ...listed(list) }
  }

  // A parameter, a result or a local: where it is defined or used. At a
  // use, it is what the use is in each instance (a loop may know more of a
  // value than its declaration says).
  const definition = check.symbolRefs.get(offset) ?? offset
  const types = views.map((v) => bindingTypeAt(check, offset + v.shift))
  const type = writtenAt(generic, definition, source) ?? declared(types, views, write)
  if (type === undefined) return null
  const each = views.map((view, i) => ({ view, type: types[i] }))
  return {
    kind: 'local',
    type,
    ...listed(listing(each, (e) => e.view.info.label, (e) => e.type && show(e.type))),
  }
}

// What a call at `offset` (where the name starts) calls: the instance of a
// generic, the function a comptime function parameter stands for, and for
// x.f(a), the call f(x, a). In a generic's body, the function each instance
// calls, listed where they are not all one function. Null where the name is
// not what a call is of.
export function callOf(
  source: string,
  module: AST.Module,
  check: TypeCheckResult,
  offset: number,
  name: string,
): GenericInfo | null {
  const generic = genericAt(module, offset)
  if (!generic) {
    const { calls, as } = callInfo(check, source, offset, name)
    if (calls === undefined && as === undefined) return null
    return { ...(calls !== undefined ? { calls } : {}), ...(as !== undefined ? { as } : {}) }
  }
  const views = instancesOf(check, generic)
  const each = views.map((v) => ({ view: v, call: callInfo(check, source, offset, name, v.shift) }))
  // With no instance there is no call to go by.
  const first = each[0]?.call
  if (!first) return null
  // The function a call recorded as another ends up calling
  const called = (call: (typeof each)[number]['call']): string | undefined => {
    const known = call.known
    const sym = known ? check.symbols.get(known) : undefined
    return known && sym?.kind === 'func' ? signed(shownName(check, known), sym.type) : undefined
  }
  // A plain call of the one function of its name records nothing: it is the
  // function its callee was typed as.
  const shown = each.map(({ view, call }) => {
    if (call.known) return called(call)
    const type = identTypeAt(check, offset + view.shift)
    return type?.kind === 'func' ? signed(name, type) : undefined
  })
  const result: GenericInfo = {}
  // The call written is the same in every instance.
  if (first.as !== undefined) result.as = first.as
  if (new Set(shown).size > 1) {
    Object.assign(result, listed(listing(each.map((e, i) => ({ label: e.view.info.label, shown: shown[i] })), (e) => e.label, (e) => e.shown)))
  } else if (first.calls !== undefined) {
    result.calls = first.calls
  }
  return Object.keys(result).length > 0 ? result : null
}

// What a field named after a point (`p.x`) in a generic's body is in each
// instance: the generic's body has no types of its own. Null where no
// instance has a member there.
export function memberIn(module: AST.Module, check: TypeCheckResult, offset: number, show: Show, write: Show = (type) => typeToString(type)): GenericInfo | null {
  const generic = genericAt(module, offset)
  if (!generic) return null
  const views = instancesOf(check, generic)
  const type = declared(views.map((v) => memberTypeAt(check, offset + v.shift)), views, write)
  if (type === undefined) return null
  return {
    kind: 'field',
    type,
    ...listed(listing(views, (v) => v.info.label, (v) => {
      const type = memberTypeAt(check, offset + v.shift)
      return type && show(type)
    })),
  }
}

// The instances of a generic function, each with its signature: what hover
// shows at its declaration
export function instancesListed(check: TypeCheckResult, generic: AST.FuncDecl): Pick<GenericInfo, 'instances' | 'more'> {
  return listed(listing(instancesOf(check, generic), (v) => v.info.label, (v) => {
    const sym = check.symbols.get(v.info.name)
    return sym?.kind === 'func' ? typeToString(sym.type) : undefined
  }))
}

// The applications of a generic type, each with the type it is
export function applicationsListed(check: TypeCheckResult, decl: AST.TypeFuncDecl, show: Show): Pick<GenericInfo, 'instances' | 'more'> {
  return listed(listing(check.applications.get(decl) ?? [], (a) => a.shown, (a) => show(unwrap(a.type))))
}

// The module's generic functions and generic types, found once: the editor
// asks for every name it shows whether one of them is around it.
const genericsOf = new WeakMap<AST.Module, (AST.FuncDecl | AST.TypeFuncDecl)[]>()

function generics(module: AST.Module): (AST.FuncDecl | AST.TypeFuncDecl)[] {
  let found = genericsOf.get(module)
  if (!found) {
    found = module.decls.flatMap((decl) => {
      const item = decl.kind === 'ExportDecl' ? decl.item : decl
      return item.kind === 'TypeFuncDecl' || (item.kind === 'FuncDecl' && isGenericDecl(item)) ? [item] : []
    })
    genericsOf.set(module, found)
  }
  return found
}

// The generic function or type whose declaration `offset` lies in
export function genericAround(module: AST.Module, offset: number): AST.FuncDecl | AST.TypeFuncDecl | null {
  return generics(module).find((g) => offset >= g.span.start && offset < g.span.end) ?? null
}

// The generic function whose body (or signature) `offset` lies in
function genericAt(module: AST.Module, offset: number): AST.FuncDecl | null {
  const around = genericAround(module, offset)
  return around?.kind === 'FuncDecl' ? around : null
}
