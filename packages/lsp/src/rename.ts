// =============================================================================
// Rename: the places a name is renamed at, and whether a new name will do
// =============================================================================

import type { Module } from '@encantis/compiler/ast';
import { BUILTIN_NAMES, type TypeCheckResult } from '@encantis/compiler/checker';
import { rename } from '@encantis/compiler/queries';
import { PRIMITIVE_NAMES } from '@encantis/compiler/types';
import { nameAfter } from './scan';
import { KEYWORDS } from './words';


export interface RenamePlan {
  name: string;
  // Where the name is written, each place renamed, in order
  places: number[];
  // Of those, the places where the name is a field's: a shorthand there,
  // `x:`, keeps the variable it stands for (`px: x`)
  fields: number[];
  // Where an export takes its name from its function or global (`export
  // func add`): there the name it is exported by is written, so that the
  // module's exports stay as they are (`export "add" func plus`).
  exports: number[];
  // Where the name is a field's (a struct's, a named result's), where the
  // module declares it: other modules may name it too
  field: number | null;
}

export type Planned = RenamePlan | { refused: string } | null;

// What renaming the name at an offset renames, or why it cannot be renamed,
// or null where no name of the module's is written there (a builtin, a
// keyword)
export function planRename(text: string, module: Module, check: TypeCheckResult, offset: number): Planned {
  const found = rename(text, module, check, offset);
  // A declaration that is defined where it starts (a data of a test) starts
  // with a keyword, which is no name of its.
  if (!found || KEYWORDS.has(found.oldName)) return null;
  if (found.refused) return { refused: found.refused };
  if (found.locations.length === 0) return null;
  const places = found.locations.map((l) => l.offset).sort((a, b) => a - b);
  const fields = found.locations.filter((l) => l.field).map((l) => l.offset);
  const exports: number[] = [];
  for (const decl of module.decls) {
    if (decl.kind !== 'ExportDecl') continue;
    const item = decl.item;
    // The name is the export's own where no string is written before the item.
    if (text.slice(decl.span.start, item.span.start).includes('"')) continue;
    const own =
      item.kind === 'FuncDecl' || item.kind === 'TypeFuncDecl'
        ? item.ident
        : item.kind === 'GlobalDecl' && item.pattern.kind === 'IdentPattern'
          ? item.pattern.name
          : null;
    if (own === found.oldName && places.includes(nameAfter(text, own, item.span.start))) exports.push(item.span.start);
  }
  return { name: found.oldName, places, fields, exports, field: found.field ?? null };
}

// Why a name cannot take the place of another, or null where it can: a value
// is named with a lower case letter first and a type with an upper case one,
// and neither is a word of the language or a builtin.
export function refusedName(old: string, name: string): string | null {
  const type = /^[A-Z]/.test(old);
  const pattern = type ? /^[A-Z][A-Za-z0-9_-]*$/ : /^[a-z][A-Za-z0-9_-]*$/;
  if (!pattern.test(name) || name.endsWith('-')) {
    return type
      ? `'${name}' is not a type's name: it starts with an upper case letter, followed by letters, digits, _ and -`
      : `'${name}' is not a name: it starts with a lower case letter, followed by letters, digits, _ and -`;
  }
  if (KEYWORDS.has(name)) return `'${name}' is a keyword`;
  if (PRIMITIVE_NAMES.has(name)) return `'${name}' is a type`;
  if (BUILTIN_NAMES.has(name)) return `'${name}' is a builtin`;
  return null;
}

// The text renamed, its edits (in order, by offsets of the text), and where
// the name is written in the renamed text. A shorthand, `count:` for a field
// and the variable of its name (`let (count:, clipped:) = f()`,
// `Point(x:, y:)`), is written out where one of them is renamed and the other
// keeps its name: the field, `let (count: total, clipped:)`, or the variable,
// `let (total: count, clipped:)`.
export function applyRename(text: string, plan: RenamePlan, name: string): { text: string; edits: { start: number; end: number; newText: string }[]; places: number[] } {
  const fields = new Set(plan.fields);
  const renames = plan.places.map((start) => {
    const after = start + plan.name.length;
    const shorthand = /^:\s*(?=[,)])/.test(text.slice(after));
    if (!shorthand) return { start, end: after, newText: name, place: 0 };
    return fields.has(start)
      ? { start, end: after + 1, newText: `${name}: ${plan.name}`, place: 0 }
      : { start: after + 1, end: after + 1, newText: ` ${name}`, place: 1 };
  });
  const edits = [...renames, ...plan.exports.map((start) => ({ start, end: start, newText: `"${plan.name}" `, place: -1 }))].sort(
    (a, b) => a.start - b.start || a.end - b.end,
  );
  let out = '';
  let at = 0;
  const places: number[] = [];
  for (const edit of edits) {
    out += text.slice(at, edit.start);
    if (edit.place >= 0) places.push(out.length + edit.place);
    out += edit.newText;
    at = edit.end;
  }
  out += text.slice(at);
  return { text: out, edits: edits.map(({ start, end, newText }) => ({ start, end, newText })), places };
}
