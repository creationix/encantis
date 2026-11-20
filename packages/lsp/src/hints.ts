// =============================================================================
// Inlay hints: what the compiler inferred, written into the line
//
// - after a name a `let` or a `for` binds with no type written, its type
//   (`let w: i32 = p.x * k`)
// - before an argument that is a literal, the name of its parameter
//   (`shift(origin, by: 3)`), as the checker resolved the call: a generic's
//   to its instance, a method call's to the call it is (x.f(a) is f(x, a))
// =============================================================================

import type { CallExpr, Expr, Module, Pattern } from '@encantis/compiler/ast';
import type { TypeCheckResult } from '@encantis/compiler/checker';
import { bindingTypeAt } from '@encantis/compiler/instances';
import { type ResolvedType, typeToString, unwrap } from '@encantis/compiler/types';
import { formatLine } from '@encantis/compiler/formatter';
import type { MetaOutput } from '@encantis/compiler/meta';
import { type InlayHint, InlayHintKind, type Position } from 'vscode-languageserver/lib/common/api';
import { nameAfter } from './scan';

// A type longer than this is cut, as an editor line has little room.
const LONGEST = 48;

export interface HintSource {
  text: string;
  module: Module;
  check: TypeCheckResult;
  meta: MetaOutput;
}

// The hints for the part of the text from `from` to `to` (offsets), where
// `answers` says the analysis is of the text as it is there.
export function inlayHints(source: HintSource, from: number, to: number, positionAt: (offset: number) => Position, answers: (offset: number) => boolean): InlayHint[] {
  const { text, check, meta } = source;
  const hints: InlayHint[] = [];
  const written = namer(check);
  const within = (offset: number) => offset >= from && offset <= to && answers(offset);

  // The type of the name bound at an offset: as the checker resolved it,
  // which keeps the names of types (Vec(Cell)), or else as the meta has it
  const typeAt = (offset: number): string | null => {
    const resolved = bindingTypeAt(check, offset);
    let shown: string | null = resolved ? written(resolved) : null;
    if (!shown) {
      const at = positionAt(offset);
      const hint = meta.hints[`${at.line}:${at.character}`];
      const type = hint && meta.types[hint.type]?.type;
      shown = type ? formatLine(type) : null;
    }
    if (!shown) return null;
    return shown.length > LONGEST ? `${shown.slice(0, LONGEST - 1)}…` : shown;
  };

  const typeHint = (name: string, at: number) => {
    if (at < 0 || !within(at)) return;
    const type = typeAt(at);
    if (type) hints.push({ position: positionAt(at + name.length), label: `: ${type}`, kind: InlayHintKind.Type });
  };

  // The names a pattern binds, as each is written
  const bound = (pattern: Pattern): void => {
    if (pattern.kind === 'IdentPattern') typeHint(pattern.name, pattern.span.start);
    else for (const element of pattern.elements) if (element.kind === 'positional') bound(element.pattern);
  };

  const parameterHints = (call: CallExpr): void => {
    // The call as the checker resolved it, and the function it calls
    const resolved = check.calls.get(call);
    const as = resolved?.kind === 'CallExpr' ? resolved : call;
    if (as.callee.kind !== 'IdentExpr') return;
    const symbol = check.symbols.get(as.callee.name);
    if (symbol?.kind !== 'func') return;
    as.args.forEach((arg, i) => {
      const param = symbol.type.params[i]?.name;
      // Only a written argument of the call, a literal, given by position
      if (!param || arg.name !== null || !arg.value || !call.args.includes(arg) || !literal(text, arg.value)) return;
      if (!within(arg.span.start)) return;
      hints.push({ position: positionAt(arg.span.start), label: `${param}:`, kind: InlayHintKind.Parameter, paddingRight: true });
    });
  };

  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const each of node) visit(each);
      return;
    }
    const n = node as { kind?: string; span?: { start: number; end: number } };
    // Nothing of it is in the part asked for
    if (n.span && (n.span.end < from || n.span.start > to)) return;
    if (n.kind === 'LetStmt') {
      const stmt = node as { pattern: Pattern; type: unknown };
      if (stmt.type === null) bound(stmt.pattern);
    } else if (n.kind === 'ForBinding') {
      const binding = node as { value: string; index: string | null; span: { start: number } };
      for (const name of [binding.index, binding.value]) {
        if (name) typeHint(name, nameAfter(text, name, binding.span.start));
      }
    } else if (n.kind === 'CallExpr') {
      parameterHints(node as CallExpr);
    }
    for (const [key, value] of Object.entries(node)) if (key !== 'span') visit(value);
  };
  visit(source.module.decls);
  return hints.sort((a, b) => a.position.line - b.position.line || a.position.character - b.position.character);
}

// How a type is written by the names the module knows for it. A binding's
// type is resolved to its structure; a struct the module names (a type it
// declares, a generic type applied: Vec(Cell)) is written by that name, also
// behind a pointer, where one name of those the module knows fits it. An
// alias of anything else (type Index = u32) is not used for it.
function namer(check: TypeCheckResult): (type: ResolvedType) => string {
  const names = new Map<string, Set<string>>();
  const add = (name: string, type: ResolvedType) => {
    const shape = unwrap(type);
    if (shape.kind !== 'tuple') return;
    const key = typeToString(structure(shape));
    names.set(key, (names.get(key) ?? new Set()).add(name));
  };
  for (const [name, symbol] of check.symbols) {
    if (symbol.kind === 'type') add(name, symbol.type);
    else if (symbol.kind === 'typefunc') for (const applied of symbol.cache.values()) add(typeToString(applied), applied);
  }
  // A name whose types are all names of this module (Vec(Cell), not Vec(Pt)
  // of the module that declares Vec)
  const known = (name: string) => (name.match(/[A-Z][A-Za-z0-9_-]*/g) ?? []).every((part) => check.symbols.has(part));
  const write = (type: ResolvedType): string => {
    const shape = unwrap(type);
    const candidates = [...(names.get(typeToString(structure(shape))) ?? [])].filter(known);
    if (candidates.length === 1) return candidates[0];
    if (shape.kind === 'pointer' && unwrap(shape.pointee).kind !== 'array') {
      return `${shape.optional ? '?' : ''}*${shape.mutable ? 'mut ' : ''}${write(shape.pointee)}`;
    }
    return typeToString(type);
  };
  return write;
}

// A type with no names left in it, at any depth: what two types that are
// the same are written as alike. A type that refers to itself (type Node =
// (next: ?*Node)) keeps the reference, which is written by its name.
function structure(type: ResolvedType, seen = new Set<ResolvedType>()): ResolvedType {
  let t = type;
  while (t.kind === 'named') t = t.type;
  if (seen.has(t)) return t;
  seen.add(t);
  switch (t.kind) {
    case 'pointer':
      return { ...t, pointee: structure(t.pointee, seen) };
    case 'slice':
    case 'array':
      return { ...t, element: structure(t.element, seen) };
    case 'tuple':
      return { ...t, fields: t.fields.map((f) => ({ ...f, type: structure(f.type, seen) })) };
    case 'func':
      return {
        ...t,
        params: t.params.map((f) => ({ ...f, type: structure(f.type, seen) })),
        returns: t.returns.map((f) => ({ ...f, type: structure(f.type, seen) })),
      };
    default:
      return t;
  }
}

// A literal as written, or a negated one: what a parameter's name says the
// meaning of. (A def is a literal to the checker, but its name says enough.)
function literal(text: string, expr: Expr): boolean {
  const written = text.slice(expr.span.start, expr.span.end);
  return /^(?:-?\s*[0-9]|["'`]|x"|b"|true$|false$)/.test(written);
}
