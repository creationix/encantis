// =============================================================================
// A module's outline: what VS Code shows in the Outline view, in the
// breadcrumbs and in Go to Symbol (Ctrl+Shift+O)
// =============================================================================

import type { Declaration, Field, ImportDecl, Module, Pattern, Span, TestItem, Type } from '@encantis/compiler/ast';
import { type DocumentSymbol, type Range, SymbolKind } from 'vscode-languageserver/lib/common/api';
import { nameAfter } from './scan';

// The type of what is named at an offset, as hover shows it, if known
export type DetailOf = (offset: number) => string | undefined;

export function outline(module: Module, text: string, positionAt: (offset: number) => { line: number; character: number }, detailOf: DetailOf = () => undefined): DocumentSymbol[] {
  const range = (start: number, end: number): Range => ({ start: positionAt(start), end: positionAt(end) });

  // A symbol named where `name` is first written in its declaration, or at
  // the declaration's start where it is not found there
  function named(name: string, kind: SymbolKind, span: Span, nameFrom = span.start, detail?: string, children?: DocumentSymbol[]): DocumentSymbol {
    const at = nameAfter(text, name, nameFrom);
    const start = at >= span.start && at + name.length <= span.end ? at : span.start;
    const end = start === at ? at + name.length : Math.min(span.end, start + 1);
    return {
      name,
      kind,
      range: range(span.start, span.end),
      selectionRange: range(start, end),
      ...(detail ?? (start === at ? detailOf(at) : undefined) ? { detail: detail ?? detailOf(at) } : {}),
      ...(children && children.length > 0 ? { children } : {}),
    };
  }

  // The named fields of a struct type, in the type's declaration
  function fields(type: Type): DocumentSymbol[] {
    if (type.kind !== 'CompositeType') return [];
    return type.fields.filter((f): f is Field & { ident: string } => f.ident !== null).map((f) => named(f.ident, SymbolKind.Field, f.span));
  }

  function typeKind(type: Type): SymbolKind {
    if (type.kind === 'CompositeType') return SymbolKind.Struct;
    if (type.kind === 'HostType') return SymbolKind.Interface;
    return SymbolKind.TypeParameter;
  }

  function imported(decl: ImportDecl): DocumentSymbol {
    const items = decl.items.map((item) => {
      const inner = item.item;
      const name = inner.ident ?? item.name;
      const kind = inner.kind === 'ImportGlobal' ? SymbolKind.Variable : inner.kind === 'ImportTypeFunc' ? SymbolKind.Struct : SymbolKind.Function;
      return named(name, kind, item.span, inner.span.start);
    });
    const name = `import "${decl.module}"`;
    const quote = text.indexOf('"', decl.span.start);
    const end = quote >= 0 ? text.indexOf('"', quote + 1) + 1 : 0;
    const selection = quote >= 0 && end > quote && end <= decl.span.end ? range(quote, end) : range(decl.span.start, decl.span.start + 'import'.length);
    return { name, kind: SymbolKind.Module, range: range(decl.span.start, decl.span.end), selectionRange: selection, ...(items.length > 0 ? { children: items } : {}) };
  }

  // The functions declared in a body, each with its own (reference 3.4)
  function nested(node: unknown): DocumentSymbol[] {
    if (Array.isArray(node)) return node.flatMap(nested);
    if (!node || typeof node !== 'object' || ArrayBuffer.isView(node)) return [];
    const n = node as { kind?: string };
    if (n.kind === 'FuncDecl') return symbolsOf(node as Declaration);
    return Object.entries(node).flatMap(([k, v]) => (k === 'span' || k === 'type' || k === 'signature' ? [] : nested(v)));
  }

  function symbolsOf(decl: Declaration | TestItem, exported?: { name: string; span: Span }): DocumentSymbol[] {
    switch (decl.kind) {
      case 'FuncDecl': {
        if (!decl.ident) return [];
        const symbol = named(decl.ident, SymbolKind.Function, exported?.span ?? decl.span, decl.span.start, undefined, nested(decl.body));
        return [label(symbol, exported, decl.ident, decl.inline ? 'inline' : undefined)];
      }
      case 'TypeFuncDecl': {
        const symbol = named(decl.ident, SymbolKind.Struct, exported?.span ?? decl.span, decl.span.start, undefined, fields(decl.body));
        return [label(symbol, exported, decl.ident)];
      }
      case 'TypeDecl':
        return [named(decl.ident.name, typeKind(decl.type), decl.span, decl.ident.span.start, undefined, fields(decl.type))];
      case 'EnumDecl':
        return [named(decl.ident, SymbolKind.Enum, decl.span, decl.span.start, undefined, decl.variants.map((v) => named(v.name, SymbolKind.EnumMember, v.span)))];
      case 'DataDecl':
        return [named(decl.ident, SymbolKind.Constant, decl.span)];
      case 'DefDecl':
        return [named(decl.ident, SymbolKind.Constant, decl.span)];
      case 'GlobalDecl': {
        const span = exported?.span ?? decl.span;
        const names = patternNames(decl.pattern);
        return names.map((name) => label(named(name, SymbolKind.Variable, span, decl.span.start), exported, name));
      }
      case 'MemoryDecl': {
        const span = exported?.span ?? decl.span;
        const symbol = named('memory', SymbolKind.Object, span, decl.span.start, [decl.min, decl.max].filter((n) => n !== null).join(' '));
        return [label(symbol, exported, 'memory')];
      }
      case 'ExportDecl':
        return symbolsOf(decl.item, { name: decl.name, span: decl.span });
      case 'ImportDecl':
        return [imported(decl)];
      case 'TestDecl': {
        const children = decl.children.flatMap((child) => symbolsOf(child));
        const name = decl.name === null ? 'test' : `test "${decl.name}"`;
        const quote = decl.name === null ? -1 : text.indexOf('"', decl.span.start);
        const close = quote < 0 ? -1 : text.indexOf('"', quote + 1) + 1;
        const selection = quote >= 0 && close > quote && close <= decl.span.end ? range(quote, close) : range(decl.span.start, decl.span.start + 'test'.length);
        return [{ name, kind: SymbolKind.Namespace, range: range(decl.span.start, decl.span.end), selectionRange: selection, ...(children.length > 0 ? { children } : {}) }];
      }
      default:
        // A statement of a test
        return [];
    }
  }

  return module.decls.flatMap((decl) => symbolsOf(decl));
}

// An exported symbol says so in its detail, with the name it is exported by
// where that is not its own.
function label(symbol: DocumentSymbol, exported: { name: string } | undefined, own: string, more?: string): DocumentSymbol {
  const parts = [exported ? (exported.name === own ? 'export' : `export "${exported.name}"`) : undefined, more, symbol.detail].filter((p) => p);
  return parts.length > 0 ? { ...symbol, detail: parts.join(' ') } : symbol;
}

// The names a global's pattern binds: (a, b), (x:, y: b)
function patternNames(pattern: Pattern): string[] {
  if (pattern.kind === 'IdentPattern') return [pattern.name];
  return pattern.elements.flatMap((e) => (e.kind === 'positional' ? patternNames(e.pattern) : [e.binding ?? e.field]));
}

// What a declaration left out of the analysis declares (it does not parse
// yet, see recoverParse), read from the words it starts with, so that the
// outline keeps it while it is written
const HEAD = /^(export\s+(?:"[^"\n]*"\s+)?)?(?:inline\s+)?(func|type|enum|data|def|global|test|import|memory)\b\s*(?:"([^"\n]*)"|([A-Za-z_][A-Za-z0-9_-]*))?/;

const HEAD_KIND: Record<string, SymbolKind> = {
  func: SymbolKind.Function,
  type: SymbolKind.Struct,
  enum: SymbolKind.Enum,
  data: SymbolKind.Constant,
  def: SymbolKind.Constant,
  global: SymbolKind.Variable,
  test: SymbolKind.Namespace,
  import: SymbolKind.Module,
  memory: SymbolKind.Object,
};

export function leftOutSymbols(text: string, spans: Span[], positionAt: (offset: number) => { line: number; character: number }): DocumentSymbol[] {
  const symbols: DocumentSymbol[] = [];
  for (const span of spans) {
    // Each declaration starts a line, at its first column (see recoverParse)
    const heads: { at: number; m: RegExpExecArray }[] = [];
    for (let line = span.start; line < span.end; line = text.indexOf('\n', line) + 1 || span.end) {
      const m = HEAD.exec(text.slice(line, span.end));
      if (m) heads.push({ at: line, m });
    }
    heads.forEach(({ at: start, m }, i) => {
      const end = heads[i + 1]?.at ?? span.end;
      const [head, exported, keyword, quoted, ident] = m;
      const name = keyword === 'test' ? (quoted !== undefined ? `test "${quoted}"` : 'test') : keyword === 'import' ? `import "${quoted ?? ''}"` : keyword === 'memory' ? 'memory' : ident;
      if (!name) return;
      const at = ident !== undefined ? start + head.length - ident.length : start;
      const length = ident !== undefined ? ident.length : head.trimEnd().length;
      const last = text.slice(start, end).trimEnd().length + start;
      symbols.push({
        name,
        kind: HEAD_KIND[keyword],
        ...(exported ? { detail: 'export' } : {}),
        range: { start: positionAt(start), end: positionAt(Math.max(last, at + length)) },
        selectionRange: { start: positionAt(at), end: positionAt(at + length) },
      });
    });
  }
  return symbols;
}
