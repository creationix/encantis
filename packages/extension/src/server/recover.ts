// =============================================================================
// Text that does not parse, made to parse by leaving out what is broken
//
// While one line is being written the rest of the text still means what it
// did. The declarations around the place the parser stopped are left out,
// blanked to spaces with their line breaks kept, so that every offset, line
// and column of the rest is where it is in the text, until the rest parses.
// An analysis of that text is an analysis of the text as it is now, but for
// what was left out.
// =============================================================================

import type { Module, Span } from '@encantis/compiler/ast';
import { isGenericDecl } from '@encantis/compiler/checker';
import type { ParseResult } from '@encantis/compiler/parser';
import { pieces } from './scan';

export interface Recovered {
  // The text with what was left out blanked, and the module it parses to
  text: string;
  module: Module;
  // What was left out, in order
  leftOut: Span[];
}

// A declaration starts a line, with its keyword in the first column, as
// the declarations of a module are written. (The keywords that can start
// one: Module in encantis-grammar.ohm.)
const DECLARATION = /^(?:export|import|inline|func|type|enum|data|def|global|memory|test)(?![A-Za-z0-9_-])/;

// How many times the text is parsed again at most: each one reads all of it.
const MAX_PARSES = 8;

// The text with each span blanked: a line break stays one.
function blank(text: string, span: Span): string {
  return text.slice(0, span.start) + text.slice(span.start, span.end).replace(/[^\r\n]/g, ' ') + text.slice(span.end);
}

export function recoverParse(text: string, parse: (text: string) => ParseResult, first?: ParseResult): Recovered | null {
  // Where each line starts, and the lines that start a declaration
  const lines = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lines.push(i + 1);
  const starts = lines.filter((at) => DECLARATION.test(text.slice(at, at + 8)));
  const lineOf = (offset: number) => {
    let line = 0;
    while (line + 1 < lines.length && lines[line + 1] <= offset) line++;
    return lines[line];
  };
  const before = (offset: number) => starts.filter((at) => at < offset).at(-1);
  const after = (offset: number) => starts.find((at) => at > offset) ?? text.length;

  let current = text;
  let result = first ?? parse(text);
  let parses = first ? 0 : 1;
  const leftOut: Span[] = [];
  while (!result.module) {
    const stopped = result.errors[0]?.span.start;
    if (stopped === undefined) return null;
    const line = lineOf(stopped);
    const declared = starts.includes(line);
    // Where it stopped, what could be broken, in the order tried: the
    // declaration a runaway literal or comment starts in; the declaration
    // before, where it stopped at the start of the next one (it did not
    // end); the line it stopped on, to the next declaration (a line between
    // declarations, see ownLine); the declaration it stopped in; and that with the one
    // before it.
    const own = declared ? line : before(stopped);
    const candidates: Span[] = [];
    // A quote opened and not closed (one being written) runs on to the
    // next quote of its kind or to the end of the text, a literal or a
    // comment the text ends in over everything after it: what is broken is
    // the declaration where the last of them before the parser stopped
    // starts, one the text ends in or a literal in quotes over lines.
    let runaway: number | undefined;
    for (const piece of pieces(current, stopped)) {
      if (piece.open || (piece.kind === 'quoted' && current.slice(piece.start, piece.end).includes('\n'))) runaway = piece.start;
    }
    if (runaway !== undefined) candidates.push({ start: before(runaway + 1) ?? lineOf(runaway), end: after(runaway) });
    if (declared && stopped === line && before(line) !== undefined) candidates.push({ start: before(line) as number, end: line });
    // A line on its own only where the parser stopped at its first word:
    // where it read on into the line, the line goes on with the declaration
    // before it (`def k = 1` and a line `  + 2 3`), which without it would
    // be another (k = 1), and is left out with it.
    const ownLine = current.slice(line, stopped).trim() === '' || before(line) === undefined;
    if (!declared && ownLine) candidates.push({ start: line, end: after(stopped) });
    if (own !== undefined) {
      candidates.push({ start: own, end: after(stopped) });
      const earlier = before(own);
      if (earlier !== undefined) candidates.push({ start: earlier, end: after(stopped) });
    }
    let next: { text: string; result: ParseResult; span: Span } | null = null;
    for (const span of candidates) {
      if (parses >= MAX_PARSES) return null;
      const blanked = blank(current, span);
      const tried = parse(blanked);
      parses++;
      // Taken where the rest parses, or where the parser now gets past it
      // and stops at something else that is broken.
      const at = tried.errors[0]?.span.start;
      if (tried.module || (at !== undefined && at > span.end)) {
        next = { text: blanked, result: tried, span };
        break;
      }
    }
    if (!next) return null;
    current = next.text;
    result = next.result;
    leftOut.push(next.span);
  }
  // What parses is the rest as it is written: no declaration runs into what
  // was left out (a line in a template's text can look like a declaration).
  const module = result.module;
  if (module.decls.some((decl) => leftOut.some((out) => decl.span.start < out.end && out.start < decl.span.end))) return null;
  // One span for what was left out at one place
  const merged: Span[] = [];
  for (const out of leftOut.sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && out.start <= last.end) last.end = Math.max(last.end, out.end);
    else merged.push({ ...out });
  }
  return { text: current, module, leftOut: merged };
}

// The names written in parts of a text, and the parts of a name with a
// hyphen in it
export function namesIn(text: string, spans: Span[]): Set<string> {
  const names = new Set<string>();
  for (const span of spans) {
    for (const name of text.slice(span.start, span.end).match(/[A-Za-z0-9_-]+/g) ?? []) {
      names.add(name);
      for (const part of name.split('-')) if (part) names.add(part);
    }
  }
  return names;
}

// The names declared in parts of a text that does not parse, as near as
// can be told: the name after each keyword that declares one. (A local's
// is seen in its function only, and its function was left out.)
function declaredIn(text: string, spans: Span[]): Set<string> {
  const names = new Set<string>();
  for (const span of spans) {
    for (const [, name] of text.slice(span.start, span.end).matchAll(/(?<![A-Za-z0-9_-])(?:func|type|enum|global|def|data)\s+([A-Za-z_][A-Za-z0-9_-]*)/g)) names.add(name);
  }
  return names;
}

// The declarations of the rest whose analysis can differ from the one the
// text will have once what was left out is written again (null for all of
// them): where it says something of what was left out, it does not know.
// - One with an error: a name declared in what was left out is unknown
//   there, and is shown as whatever the checker took it for.
// - One that names something declared in what was left out that the rest
//   also declares (a function of a name others have too) or the builtins
//   have (a function there takes the builtin's place): there it can be
//   that one, and nothing says it is not.
// - One that names a declaration whose type can differ: one of these where
//   it is written (a function's signature, a type, a global) and not only in
//   a function's body.
// - A generic that one of them names, or what was left out does: it is
//   shown as its instances make it, and they are made by its calls.
// `errors` are where the checker found errors, and where the calls are
// that asked for an instance in which it found one.
export function untrusted(module: Module, text: string, leftOut: Span[], errors: number[], builtins: ReadonlySet<string>): Span[] | null {
  interface Declared {
    span: Span;
    // What other declarations see of it: all of it but a function's body
    seen: Span;
    names: Set<string>;
    generic: boolean;
    words: Set<string>;
    seenWords: Set<string>;
  }
  const declared: Declared[] = module.decls.map((decl) => {
    const item = decl.kind === 'ExportDecl' ? decl.item : decl;
    const of = (seen: Span, names: string[], generic = false): Declared => ({
      span: decl.span,
      seen,
      names: new Set(names),
      generic,
      words: namesIn(text, [decl.span]),
      seenWords: namesIn(text, [seen]),
    });
    switch (item.kind) {
      case 'FuncDecl':
        return of({ start: decl.span.start, end: item.signature.span.end }, item.ident ? [item.ident] : [], isGenericDecl(item));
      case 'TypeFuncDecl':
        return of(decl.span, [item.ident], true);
      case 'TypeDecl':
        return of(decl.span, [item.ident.name]);
      case 'DefDecl':
      case 'DataDecl':
        return of(decl.span, [item.ident]);
      case 'GlobalDecl':
        return of(decl.span, [...namesIn(text, [item.pattern.span])]);
      case 'EnumDecl':
        return of(decl.span, [item.ident, ...item.variants.map((variant) => variant.name)]);
      case 'ImportDecl':
        return of(decl.span, item.items.flatMap(({ item: imported }) => (imported.ident ? [imported.ident] : [])));
      default:
        // A test's names are its own; a memory has none.
        return of(decl.span, []);
    }
  });
  const within = (at: number, span: Span) => at >= span.start && at < span.end;
  const meets = (words: Set<string>, names: Set<string>) => [...names].some((name) => words.has(name));

  const out = namesIn(text, leftOut);
  const everyName = new Set(declared.flatMap((d) => [...d.names]));
  const shared = new Set([...declaredIn(text, leftOut)].filter((name) => builtins.has(name) || everyName.has(name)));
  const distrusted = new Set<Declared>();
  // Those whose type can differ
  const retyped = new Set<Declared>();
  for (const at of errors) {
    const d = declared.find((d) => within(at, d.span));
    if (!d) return null;
    distrusted.add(d);
    if (within(at, d.seen)) retyped.add(d);
  }
  for (let grown = true; grown; ) {
    grown = false;
    const differing = new Set([...shared, ...[...retyped].flatMap((d) => [...d.names])]);
    for (const d of declared) {
      if (!retyped.has(d) && meets(d.seenWords, differing)) {
        retyped.add(d);
        distrusted.add(d);
        grown = true;
      }
      if (distrusted.has(d)) continue;
      const called = d.generic && (meets(out, d.names) || [...distrusted].some((other) => meets(other.words, d.names)));
      if (meets(d.words, differing) || called) {
        distrusted.add(d);
        grown = true;
      }
    }
  }
  return [...distrusted].map((d) => d.span);
}
