// =============================================================================
// Completion and signature help
//
// Asked while a line is being written, when the text seldom parses: the
// analysis of the text as it is leaves out the declaration being written
// (see recoverParse), and what that declaration has declared so far is known
// from the last analysis of the text when all of it parsed. A name is looked
// up as the text names it, from the place asked at, not by a hint there.
// =============================================================================

import type { Field, FuncDecl, Module, Type } from '@encantis/compiler/ast';
import { BUILTIN_NAMES, declaredName, type TypeCheckResult, typeText } from '@encantis/compiler/checker';
import { formatLine } from '@encantis/compiler/formatter';
import { bindingTypeAt } from '@encantis/compiler/instances';
import type { MetaOutput, MetaSymbol } from '@encantis/compiler/meta';
import { isValueArray, PRIMITIVE_NAMES, type ResolvedType, typeToString, unwrap } from '@encantis/compiler/types';
import { type CompletionItem, CompletionItemKind, MarkupKind, type SignatureHelp } from 'vscode-languageserver/lib/common/api';
import { pieceAt } from './scan';
import { BUILTIN_DOCS, BUILTIN_SIGNATURES, KEYWORDS, TYPE_DOCS } from './words';

// An analysis to look names up in: its text, module, checker result and meta
export interface Source {
  text: string;
  module: Module;
  check: TypeCheckResult;
  meta: MetaOutput;
}

const MODULE_KINDS: MetaSymbol['kind'][] = ['func', 'type', 'unique', 'global', 'data', 'def'];
const OWN_KINDS: MetaSymbol['kind'][] = ['param', 'local', 'return', 'typeparam', 'comptime'];

const ITEM_KIND: Record<MetaSymbol['kind'], CompletionItemKind> = {
  func: CompletionItemKind.Function,
  type: CompletionItemKind.Struct,
  unique: CompletionItemKind.Struct,
  global: CompletionItemKind.Variable,
  local: CompletionItemKind.Variable,
  param: CompletionItemKind.Variable,
  return: CompletionItemKind.Variable,
  data: CompletionItemKind.Constant,
  def: CompletionItemKind.Constant,
  typeparam: CompletionItemKind.TypeParameter,
  comptime: CompletionItemKind.Function,
};

function offsetOf(text: string, pos: string): number {
  const [line, character] = pos.split(':').map(Number);
  let at = 0;
  for (let i = 0; i < line; i++) {
    const next = text.indexOf('\n', at);
    if (next < 0) return text.length;
    at = next + 1;
  }
  return at + character;
}

// Whether a place is in a comment or a literal, where nothing is completed
export function inCommentOrLiteral(text: string, offset: number): boolean {
  if (offset === 0) return false;
  const piece = pieceAt(text, offset - 1);
  if (!piece) return false;
  if (piece.kind === 'comment' && text.startsWith('//', piece.start)) return offset <= piece.end;
  return offset < piece.end || piece.open;
}

// The function an offset of a source is in, also an exported one and one a
// test declares
function functionAt(module: Module, offset: number, slack = 0): FuncDecl | null {
  let found: FuncDecl | null = null;
  const visit = (decls: readonly { kind: string }[]) => {
    for (const decl of decls) {
      const d = decl as { kind: string; item?: { kind: string }; children?: { kind: string }[]; span: { start: number; end: number } };
      const func = d.kind === 'FuncDecl' ? (d as unknown as FuncDecl) : d.kind === 'ExportDecl' && d.item?.kind === 'FuncDecl' ? (d.item as unknown as FuncDecl) : null;
      if (func && offset > func.span.start && offset <= func.span.end + slack) found = func;
      if (d.kind === 'TestDecl' && d.children) visit(d.children);
    }
  };
  visit(module.decls);
  return found;
}

// The source that knows the declarations around an offset of the text: the
// analysis of the text as it is, where it answers there, or the last one of
// the text when it parsed, where the text up to the function asked in is as
// it was then. `slack` is how much longer the text has grown since: what ends
// after the place asked at in that analysis can end that much later now.
type Found = { source: Source; func: FuncDecl | null; slack: number };

function sourceFor(text: string, offset: number, current: Source | null, parsed: Source | null, answers: (offset: number) => boolean): Found | null {
  if (current && answers(offset)) return { source: current, func: functionAt(current.module, offset), slack: 0 };
  if (parsed) {
    const slack = Math.max(0, text.length - parsed.text.length);
    const func = functionAt(parsed.module, offset, slack);
    if (!func || text.slice(0, func.span.start) === parsed.text.slice(0, func.span.start)) return { source: parsed, func, slack };
  }
  return current ? { source: current, func: null, slack: 0 } : null;
}

// What a local is seen in: the innermost block, for, if let or match arm it
// is declared in. Where it ends, in the function's source
const SCOPES = new Set(['Block', 'ForStmt', 'IfExpr', 'MatchArm']);

function scopeEnd(func: FuncDecl, at: number): number {
  let end = func.span.end;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const each of node) visit(each);
      return;
    }
    const { kind, span } = node as { kind?: string; span?: { start: number; end: number } };
    if (span && (at < span.start || at >= span.end)) return;
    if (span && kind && SCOPES.has(kind) && span.end < end) end = span.end;
    for (const [key, value] of Object.entries(node)) if (key !== 'span') visit(value);
  };
  visit(func.body);
  return end;
}

// The parameters and locals declared in a function before an offset and
// seen there, the latest of each name: what a name there means
function ownNames(source: Source, func: FuncDecl | null, offset: number, slack = 0): Map<string, { symbol: MetaSymbol; at: number }> {
  const names = new Map<string, { symbol: MetaSymbol; at: number }>();
  if (!func) return names;
  for (const symbol of source.meta.symbols) {
    if (!OWN_KINDS.includes(symbol.kind)) continue;
    const at = offsetOf(source.text, symbol.def);
    if (at < func.span.start || at >= offset) continue;
    if (symbol.kind === 'local' && scopeEnd(func, at) + slack <= offset) continue;
    const known = names.get(symbol.name);
    if (!known || known.at < at) names.set(symbol.name, { symbol, at });
  }
  return names;
}

function moduleNames(sources: (Source | null)[]): Map<string, { symbol: MetaSymbol; source: Source }> {
  const names = new Map<string, { symbol: MetaSymbol; source: Source }>();
  for (const source of sources) {
    if (!source) continue;
    for (const symbol of source.meta.symbols) {
      if (MODULE_KINDS.includes(symbol.kind) && !names.has(symbol.name)) names.set(symbol.name, { symbol, source });
    }
  }
  return names;
}

function typeOf(source: Source, symbol: MetaSymbol): string {
  const type = source.meta.types[symbol.type]?.type;
  return type ? formatLine(type) : '';
}

function item(symbol: MetaSymbol, source: Source, sort: string): CompletionItem {
  const detail = typeOf(source, symbol);
  return {
    label: symbol.name,
    kind: ITEM_KIND[symbol.kind],
    ...(detail ? { detail } : {}),
    ...(symbol.doc ? { documentation: { kind: MarkupKind.Markdown, value: symbol.doc } } : {}),
    sortText: `${sort}${symbol.name}`,
  };
}

// What to complete at an offset of the text: after a point, the members of
// what is before it; elsewhere, the names seen there, the builtins, the
// primitive types and the keywords.
export function complete(text: string, offset: number, current: Source | null, parsed: Source | null, answers: (offset: number) => boolean): CompletionItem[] {
  if (inCommentOrLiteral(text, offset)) return [];
  let start = offset;
  while (start > 0 && /[A-Za-z0-9_-]/.test(text[start - 1])) start--;
  // After a number's digits, a point starts its fraction.
  if (/^[0-9]/.test(text.slice(start, offset))) return [];
  if (text[start - 1] === '.') return members(text, start - 1, current, parsed, answers);

  const found = sourceFor(text, start, current, parsed, answers);
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  const add = (entry: CompletionItem) => {
    if (seen.has(entry.label)) return;
    seen.add(entry.label);
    items.push(entry);
  };
  if (found) {
    for (const { symbol } of ownNames(found.source, found.func, start, found.slack).values()) add(item(symbol, found.source, '0'));
  }
  for (const { symbol, source } of moduleNames([found?.source ?? null, current, parsed]).values()) add(item(symbol, source, '1'));
  for (const name of BUILTIN_NAMES) {
    add({
      label: name,
      kind: CompletionItemKind.Function,
      detail: BUILTIN_SIGNATURES[name] ?? 'builtin',
      ...(BUILTIN_DOCS[name] ? { documentation: BUILTIN_DOCS[name] } : {}),
      sortText: `2${name}`,
    });
  }
  for (const name of [...PRIMITIVE_NAMES]) add({ label: name, kind: CompletionItemKind.Keyword, detail: TYPE_DOCS[name] ?? 'type', sortText: `3${name}` });
  for (const name of KEYWORDS) add({ label: name, kind: CompletionItemKind.Keyword, sortText: `4${name}` });
  return items;
}

// A generic's parameters as written, but for its comptime ones
function runtimeParams(decl: FuncDecl): Field[] {
  const input = decl.signature.input;
  return input.kind === 'CompositeType' ? input.fields.filter((f) => !f.comptime && f.type.kind !== 'TypeType') : [];
}

// A generic's result as written, or '' for none
function outputText(decl: FuncDecl): string {
  const output = decl.signature.output;
  if (output.kind === 'CompositeType' && output.fields.length === 0) return '';
  return typeText(output);
}

// A generic's signature as written, but for its comptime parameters
function genericSignature(decl: FuncDecl): string {
  const params = runtimeParams(decl).map((p) => `${p.ident ? `${p.ident}: ` : ''}${typeText(p.type)}`);
  const output = outputText(decl);
  return `(${params.join(', ')})${output ? ` -> ${output}` : ''}`;
}

// The steps from a name to the point before what is completed:
// `a.b[i].` is a, then .b, then an index
type Step = { field: string } | { index: true } | { deref: true };

function chainBefore(text: string, dot: number): { head: string; at: number; steps: Step[] } | null {
  const steps: Step[] = [];
  let i = dot;
  for (;;) {
    if (text[i - 1] === ']') {
      // An index, its brackets balanced
      let depth = 0;
      let j = i - 1;
      for (; j >= 0; j--) {
        if (text[j] === ']') depth++;
        else if (text[j] === '[' && --depth === 0) break;
      }
      if (j < 0) return null;
      steps.unshift({ index: true });
      i = j;
      continue;
    }
    if (text[i - 1] === '*' && text[i - 2] === '.') {
      steps.unshift({ deref: true });
      i -= 2;
      continue;
    }
    let s = i;
    while (s > 0 && /[A-Za-z0-9_-]/.test(text[s - 1])) s--;
    const word = text.slice(s, i);
    if (!/^[A-Za-z_]/.test(word)) return null;
    if (text[s - 1] === '.') {
      steps.unshift({ field: word });
      i = s - 1;
      continue;
    }
    return { head: word, at: s, steps };
  }
}

function step(type: ResolvedType, by: Step): ResolvedType | null {
  const t = unwrap(type);
  if ('deref' in by) return t.kind === 'pointer' ? t.pointee : null;
  if ('index' in by) {
    const of = t.kind === 'pointer' ? unwrap(t.pointee) : t;
    if (of.kind === 'array' || of.kind === 'slice') return of.element;
    return t.kind === 'pointer' ? t.pointee : null;
  }
  const inner = t.kind === 'pointer' ? unwrap(t.pointee) : t;
  if (inner.kind === 'tuple') return inner.fields.find((f) => f.name === by.field)?.type ?? null;
  return null;
}

// The type a name has at an offset of the text: a parameter or local
// declared before it in its function, also one declared on a line of the text
// no analysis has seen yet, or else a name of the module
function nameType(text: string, source: Source, func: FuncDecl | null, name: string, offset: number, depth = 0, slack = 0): ResolvedType | null {
  const own = ownNames(source, func, offset, slack).get(name);
  const written = depth < 4 ? writtenLet(text, func, name, offset) : null;
  if (written && (!own || written.at > own.at)) {
    const type = writtenType(text, source, func, written, depth);
    if (type) return type;
  }
  if (own) return bindingTypeAt(source.check, own.at) ?? null;
  const symbol = source.check.symbols.get(name);
  return symbol && 'type' in symbol ? (symbol.type as ResolvedType) : null;
}

// The last `let name` written before an offset, in the function it is in:
// where it is, and its type or value as written
function writtenLet(text: string, func: FuncDecl | null, name: string, offset: number): { at: number; type?: string; value?: string } | null {
  const from = func ? func.span.start : Math.max(0, text.lastIndexOf('\nfunc', offset), text.lastIndexOf('\nexport', offset));
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\blet\\s+${escaped}(?![A-Za-z0-9_-])\\s*(?::\\s*([^=\\n]+?))?\\s*=\\s*([^\\n;]+)`, 'g');
  pattern.lastIndex = from;
  let found: { at: number; type?: string; value?: string } | null = null;
  for (let m = pattern.exec(text); m && m.index < offset; m = pattern.exec(text)) {
    found = { at: m.index, type: m[1]?.trim(), value: m[2]?.trim() };
  }
  return found;
}

function writtenType(text: string, source: Source, func: FuncDecl | null, written: { at: number; type?: string; value?: string }, depth: number): ResolvedType | null {
  // A type written as a name: a type of the module
  if (written.type) {
    const symbol = /^[A-Z][A-Za-z0-9_-]*$/.test(written.type) ? source.check.symbols.get(written.type) : undefined;
    return symbol?.kind === 'type' ? symbol.type : null;
  }
  const value = written.value ?? '';
  // A call: what the function returns, and a generic's result as its
  // declaration writes it, with the comptime arguments written here
  const call = /^([a-z][A-Za-z0-9_-]*)\((.*)\)\s*$/.exec(value);
  if (call) {
    const symbol = source.check.symbols.get(call[1]);
    if (symbol?.kind === 'func') return symbol.type.returns.length === 1 ? symbol.type.returns[0].type : null;
    if (symbol?.kind === 'generic') return genericResult(symbol.decl, splitArguments(call[2]), source.check);
    return null;
  }
  // A name and its fields: what the last field is
  const chain = /^([a-z][A-Za-z0-9_-]*)((?:\.[a-z][A-Za-z0-9_-]*)*)\s*$/.exec(value);
  if (!chain) return null;
  let type = nameType(text, source, func, chain[1], written.at, depth + 1);
  for (const field of chain[2].split('.').filter((f) => f)) type = type && step(type, { field });
  return type;
}

// What a receiver is matched with a function's first parameter by, past
// pointers: a struct by the names of its fields (a generic type's
// application is its body, Vec(u32) a (ptr, len, cap)), anything else by
// how it is written
// The fields' types count, but for a generic's parameter (writtenKey), whose
// fields' types are written with its type parameters.
function receiverKey(type: ResolvedType, typed = true): string {
  let t = unwrap(type);
  while (t.kind === 'pointer') t = unwrap(t.pointee);
  if (t.kind === 'tuple' && t.fields.length > 0 && t.fields.every((f) => f.name)) {
    return `fields:${t.fields.map((f) => (typed ? `${f.name}:${typeToString(f.type)}` : f.name)).join(',')}`;
  }
  return shape(typeToString(t));
}

// The same for a generic's parameter as written, where its type is not
// resolved: a generic type applied (Vec(T)) is the fields of its body. A
// type parameter (T) takes anything, and matches no receiver in particular.
function writtenKey(type: Type, check: TypeCheckResult): string | null {
  let t = type;
  while (t.kind === 'PointerType' || t.kind === 'OptionalType') t = t.kind === 'PointerType' ? t.pointee : t.type;
  if (t.kind === 'TypeApply') {
    const symbol = check.symbols.get(t.name);
    if (symbol?.kind === 'typefunc' && symbol.decl.body.kind === 'CompositeType') {
      const names = symbol.decl.body.fields.map((f) => f.ident);
      if (names.length > 0 && names.every((n) => n)) return `fields:${names.join(',')}`;
    }
    return t.name;
  }
  if (t.kind === 'TypeRef') {
    const symbol = check.symbols.get(t.name);
    return symbol?.kind === 'type' ? receiverKey(symbol.type, false) : null;
  }
  return shape(typeText(t));
}

// The arguments of a call as written, split at its own commas
function splitArguments(written: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < written.length; i++) {
    const ch = written[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      args.push(written.slice(from, i).trim());
      from = i + 1;
    }
  }
  if (written.trim()) args.push(written.slice(from).trim());
  return args;
}

// Each whole name in a type as written replaced by what it is given
function substituted(written: string, given: Map<string, string>): string {
  return written.replace(/[A-Za-z_][A-Za-z0-9_-]*/g, (name) => given.get(name) ?? name);
}

// What a generic returns as its declaration writes it, with these arguments
// given for its comptime parameters: enough of a type to list its fields and
// to find its methods (a generic type's body, its fields' types written out)
function genericResult(decl: FuncDecl, args: string[], check: TypeCheckResult): ResolvedType | null {
  const input = decl.signature.input;
  const given = new Map<string, string>();
  if (input.kind === 'CompositeType') {
    input.fields.forEach((param, i) => {
      if (param.comptime && param.ident && args[i] !== undefined) given.set(param.ident, args[i]);
    });
  }
  return writtenAsType(decl.signature.output, given, check);
}

function writtenAsType(type: Type, given: Map<string, string>, check: TypeCheckResult): ResolvedType | null {
  switch (type.kind) {
    case 'PointerType': {
      const pointee = writtenAsType(type.pointee, given, check);
      return pointee && { kind: 'pointer', pointee, ...(type.mutable ? { mutable: true } : {}) };
    }
    case 'TypeRef': {
      const name = given.get(type.name) ?? type.name;
      if (PRIMITIVE_NAMES.has(name)) return { kind: 'primitive', name } as ResolvedType;
      const symbol = check.symbols.get(name);
      return symbol?.kind === 'type' ? symbol.type : null;
    }
    case 'TypeApply': {
      const symbol = check.symbols.get(type.name);
      if (symbol?.kind !== 'typefunc' || symbol.decl.body.kind !== 'CompositeType') return null;
      const own = new Map<string, string>();
      symbol.decl.params.forEach((param, i) => {
        const arg = type.args[i];
        if (param.ident && arg && arg.kind !== 'ValueArg') own.set(param.ident, substituted(typeText(arg), given));
      });
      const fields = symbol.decl.body.fields.map((field) => ({
        name: field.ident,
        type: { kind: 'named', name: substituted(typeText(field.type), own), type: { kind: 'void' } } as ResolvedType,
      }));
      return { kind: 'tuple', fields };
    }
    default:
      return null;
  }
}

// A type as written, past pointers and optionals
function shape(written: string): string {
  return written.replace(/^(?:\?|\*mut\s+|\*)+/, '');
}

function members(text: string, dot: number, current: Source | null, parsed: Source | null, answers: (offset: number) => boolean): CompletionItem[] {
  const chain = chainBefore(text, dot);
  if (!chain) return [];
  const found = sourceFor(text, chain.at, current, parsed, answers);
  if (!found) return [];
  const { source, func, slack } = found;
  let type = nameType(text, source, func, chain.head, chain.at, 0, slack);
  for (const by of chain.steps) type = type && step(type, by);
  if (!type) return [];

  const items: CompletionItem[] = [];
  const field = (label: string, detail: string, sort = '0') => {
    items.push({ label, kind: CompletionItemKind.Field, detail, sortText: `${sort}${label}` });
  };
  const t = unwrap(type);
  const inner = t.kind === 'pointer' ? unwrap(t.pointee) : t;
  if (inner.kind === 'tuple') {
    inner.fields.forEach((f, i) => field(f.name ?? String(i), typeToString(f.type)));
  }
  // .* on a pointer to one value (a many-pointer is indexed instead), and
  // the memory of a pointer, a slice or an array read as another type
  if (t.kind === 'pointer' && !(inner.kind === 'array' && inner.sizes === null)) {
    items.push({ label: '*', kind: CompletionItemKind.Operator, detail: typeToString(t.pointee), sortText: '1*' });
  }
  if (t.kind === 'pointer' || t.kind === 'slice' || t.kind === 'array') {
    for (const name of PRIMITIVE_NAMES) {
      if (name !== 'bool') items.push({ label: name, kind: CompletionItemKind.TypeParameter, detail: `[*]${name}: the memory read as ${name}`, sortText: `3${name}` });
    }
  }
  if (inner.kind === 'slice' || inner.kind === 'array') {
    if (inner.kind === 'slice' || inner.sizes !== null) field('len', 'u32', '1');
    if (inner.kind === 'slice' || t.kind === 'pointer' || !isValueArray(inner)) field('ptr', `[*]${typeToString(inner.element)}`, '1');
    field('wid', 'u32: the width of an element', '1');
  }

  // Functions called as methods: x.f(a) is f(x, a), for an f whose first
  // parameter (past its comptime ones) takes what x is
  const receiver = receiverKey(type);
  const byNames = receiverKey(type, false);
  const seen = new Set(items.map((i) => i.label));
  for (const [key, symbol] of source.check.symbols) {
    const name = declaredName(key);
    // An instance of a generic (second<u32>) is no name to write.
    if (seen.has(name) || name.includes('<')) continue;
    let matches = false;
    let signature = '';
    if (symbol.kind === 'func' && !symbol.alias) {
      const param = symbol.type.params[0];
      matches = !!param && receiverKey(param.type) === receiver;
      signature = typeToString(symbol.type).replace(/^func/, '');
    } else if (symbol.kind === 'generic') {
      const param = runtimeParams(symbol.decl)[0];
      matches = !!param && writtenKey(param.type, source.check) === byNames;
      signature = genericSignature(symbol.decl);
    }
    if (!matches) continue;
    seen.add(name);
    items.push({ label: name, kind: CompletionItemKind.Method, detail: signature, sortText: `2${name}` });
  }
  return items;
}

// The call an offset is in the arguments of: the name called, where it is,
// whether it is called as a method, and which argument the offset is in
function callAround(text: string, offset: number): { name: string; at: number; method: boolean; argument: number } | null {
  let depth = 0;
  let commas = 0;
  for (let i = offset - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === ')' || ch === ']' || ch === '}') depth++;
    else if (ch === '[' || ch === '{') {
      if (depth === 0) return null;
      depth--;
    } else if (ch === '(') {
      if (depth > 0) {
        depth--;
        continue;
      }
      let s = i;
      while (s > 0 && /[A-Za-z0-9_-]/.test(text[s - 1])) s--;
      const name = text.slice(s, i);
      if (!/^[A-Za-z_]/.test(name)) return null;
      return { name, at: s, method: text[s - 1] === '.', argument: commas };
    } else if (ch === ',' && depth === 0) commas++;
    else if (ch === '\n' && /^\s*(?:export\s+|inline\s+)*(?:func|type|global|data|def|test|import)\b/.test(text.slice(i + 1, i + 40))) return null;
  }
  return null;
}

// The signature of the function whose arguments an offset is in, with the
// parameter the offset is at
export function signatureHelp(text: string, offset: number, current: Source | null, parsed: Source | null, answers: (offset: number) => boolean): SignatureHelp | null {
  if (inCommentOrLiteral(text, offset)) return null;
  const call = callAround(text, offset);
  if (!call) return null;
  const found = sourceFor(text, call.at, current, parsed, answers);
  if (!found) return null;
  const { source } = found;
  const symbol = source.check.symbols.get(call.name);
  let params: string[];
  let returns: string;
  if (symbol?.kind === 'func') {
    params = symbol.type.params.map((p) => (p.name ? `${p.name}: ${typeToString(p.type)}` : typeToString(p.type)));
    returns = symbol.type.returns.map((r) => (r.name ? `${r.name}: ${typeToString(r.type)}` : typeToString(r.type))).join(', ');
  } else if (symbol?.kind === 'generic') {
    params = runtimeParams(symbol.decl).map((p) => `${p.ident ? `${p.ident}: ` : ''}${typeText(p.type)}`);
    returns = outputText(symbol.decl);
  } else if (BUILTIN_SIGNATURES[call.name] && !symbol) {
    const written = BUILTIN_SIGNATURES[call.name].replace(/^builtin /, '');
    const inner = written.slice(written.indexOf('(') + 1, written.lastIndexOf(')'));
    params = inner ? inner.split(/,\s*/) : [];
    returns = written.split('->')[1]?.trim() ?? '';
  } else {
    return null;
  }
  const label = `${call.name}(${params.join(', ')})${returns ? ` -> ${returns}` : ''}`;
  let from = call.name.length + 1;
  const parameters = params.map((p) => {
    const range: [number, number] = [from, from + p.length];
    from += p.length + 2;
    return { label: range };
  });
  // Called as a method, the receiver is the first argument.
  const active = call.argument + (call.method ? 1 : 0);
  return { signatures: [{ label, parameters }], activeSignature: 0, activeParameter: Math.min(active, Math.max(0, parameters.length - 1)) };
}
