// =============================================================================
// Encantis Language Server
// Provides diagnostics, hover, definition and references for .ents files.
// Shared by the desktop (Node)
// and web (worker) entry points, which only differ in how they connect.
// =============================================================================

import {
  TextDocuments,
  Diagnostic as LSPDiagnostic,
  DiagnosticSeverity,
  DiagnosticTag,
  type InitializeParams,
  type InitializeResult,
  TextDocumentSyncKind,
  type TextDocumentPositionParams,
  type Hover,
  type Location,
  type ReferenceParams,
  type DocumentLink,
  type DocumentLinkParams,
  type DocumentSymbol,
  type DocumentSymbolParams,
  type SymbolInformation,
  type WorkspaceSymbolParams,
  type Position,
  type Range,
  SymbolKind,
  type DocumentHighlight,
  type InlayHint,
  type InlayHintParams,
  type DocumentHighlightParams,
  DocumentHighlightKind,
  type PrepareRenameParams,
  type CompletionItem,
  type CompletionParams,
  type SignatureHelp,
  type SignatureHelpParams,
  type RenameParams,
  type WorkspaceEdit,
  LSPErrorCodes,
  ResponseError,
  MarkupKind,
  SemanticTokensBuilder,
  SemanticTokensLegend,
  type Connection,
} from 'vscode-languageserver/lib/common/api';

import { TextDocument } from 'vscode-languageserver-textdocument';

import { parse } from '@encantis/compiler/parser';
import type { ExportDecl, ImportDecl, ImportItem, Module, Span } from '@encantis/compiler/ast';
import { BUILTIN_NAMES, fieldNamedAt, genericDeclaring, type ProgramCheckResult, type TypeCheckResult, typecheck, typecheckProgram } from '@encantis/compiler/checker';
import { getSourceImports, isSourceImport, loadModule, resolveModulePath } from '@encantis/compiler/loader';
import { buildMeta, type MetaError, type MetaHint, type MetaOptions, type MetaOutput, type MetaSymbol } from '@encantis/compiler/meta';
import { formatEncantis, formatLine } from '@encantis/compiler/formatter';
import * as nodePath from 'path';
import { namesIn, recoverParse, untrusted } from './recover';
import { leftOutSymbols, outline } from './outline';
import { BUILTIN_DOCS, BUILTIN_SIGNATURES, TYPE_DOCS } from './words';
import { complete, signatureHelp } from './complete';
import { inlayHints } from './hints';
import { applyRename, planRename, type RenamePlan, refusedName } from './rename';
import { payloadFieldNamed, rename } from '@encantis/compiler/queries';
import { literalAt, nameAfter, pieces } from './scan';
import { typeToString } from '@encantis/compiler/types';


// Convert symbol kind to display prefix
function kindToPrefix(kind: MetaSymbol['kind']): string {
  switch (kind) {
    case 'param': return 'input';
    case 'return': return 'output';
    case 'local': return 'let';
    case 'global': return 'global';
    case 'data': return 'data';
    case 'def': return 'def';
    case 'func': return 'func';
    case 'type': return 'type';
    case 'typeparam':
    case 'comptime': return 'comptime';
    case 'variant': return 'variant';
    default: return '';
  }
}

// Format symbol display using proper Encantis syntax
// A parameter or local that is a refused value has no type to show: what it
// is and its name (MetaSymbol.refused)
function refusedDisplay(symbol: MetaSymbol): string {
  return `${symbol.kind === 'param' ? 'input' : symbol.kind === 'return' ? 'output' : 'let'} ${symbol.name}`;
}

function formatSymbolDisplay(symbol: MetaSymbol, typeStr: string): string {
  switch (symbol.kind) {
    case 'global':
      return `global ${symbol.name}: ${typeStr}`;
    case 'local':
      return `let ${symbol.name}: ${typeStr}`;
    case 'param':
      return `input ${symbol.name}: ${typeStr}`;
    case 'return':
      return `output ${symbol.name}: ${typeStr}`;
    case 'func': {
      // Format as "func name(params) -> returns" instead of "func name: type"
      // typeStr is like "(y:f64,x:f64)->f64" or "(x:f64)->()" for void return
      const arrowIdx = typeStr.indexOf('->');
      if (arrowIdx !== -1) {
        const params = typeStr.slice(0, arrowIdx);
        const returns = typeStr.slice(arrowIdx + 2);
        const prefix = symbol.inline ? 'inline func' : 'func';
        // Show "-> returns" only if not void "()"
        const returnPart = returns === '()' ? '' : ` -> ${returns}`;
        return `${prefix} ${symbol.name}${params}${returnPart}`;
      }
      // Fallback if no arrow (shouldn't happen for functions)
      return symbol.inline
        ? `inline func ${symbol.name}: ${typeStr}`
        : `func ${symbol.name}: ${typeStr}`;
    }
    case 'type':
      return `type ${symbol.name} = ${typeStr}`;
    case 'unique':
      return `type ${symbol.name}@ = ${typeStr}`;
    case 'data':
      return symbol.value
        ? `data ${symbol.name}: ${typeStr} = ${symbol.value}`
        : `data ${symbol.name}: ${typeStr}`;
    case 'def':
      return symbol.value
        ? `def ${symbol.name}: ${typeStr} = ${symbol.value}`
        : `def ${symbol.name}: ${typeStr}`;
    // A generic's comptime parameters, as they are declared
    case 'typeparam':
    case 'comptime':
      return `comptime ${symbol.name}: ${typeStr}`;
    // A variant, with its tag
    case 'variant':
      return `variant ${symbol.name}: ${typeStr}${symbol.value !== undefined ? ` = ${symbol.value}` : ''}`;
    default:
      return `${symbol.name}: ${typeStr}`;
  }
}

// What a hint says beyond its type, below it: for x.f(a) the call it is, the
// function a call calls (an instance of a generic), and what the name is in
// each instance (each application, for a generic type).
function hintDetails(hint: MetaHint, meta: MetaOutput): string {
  const parts: string[] = [];
  const call = hint.as !== undefined ? `the call \`${hint.as}\`` : '';
  if (hint.calls !== undefined) parts.push(call ? `${call}, which calls \`${hint.calls}\`` : `calls \`${hint.calls}\``);
  else if (call) parts.push(call);
  const listed = (hint.instances ?? []).map(i => {
    const type = formatLine(meta.types[i.type]?.type ?? 'unknown');
    return `- in ${i.in.map(n => `\`${n}\``).join(', ')}: \`${type}\``;
  });
  if (hint.more !== undefined) listed.push(`- and ${hint.more} more instance${hint.more === 1 ? '' : 's'}`);
  if (listed.length > 0) parts.push(listed.join('\n'));
  return parts.map(p => `\n\n${p}`).join('');
}

// An analysis of a document's text, for the queries
interface Analysis {
  // The document's text it is of
  text: string;
  meta: MetaOutput;
  module: Module;
  // The checker's result the meta was built from
  check: TypeCheckResult;
  // Where the text does not parse, what was left out for the rest to parse
  // (see recoverParse), and the declarations of the rest whose analysis can
  // differ from the one the text will have once that is written again (see
  // untrusted). No place in either is answered for, and the uses of a name
  // written in either are not all known.
  recovered?: { leftOut: Span[]; untrusted: Span[]; unseenNames: Set<string> };
  // The text of each file of the document's program, by its path, where the
  // document imports other source files
  sources?: Map<string, string>;
}

// The source import an offset of a module's text is in, and the item of it
function importItemAt(module: Module, offset: number): { decl: ImportDecl; item: ImportItem } | null {
  for (const decl of getSourceImports(module, true)) {
    const item = decl.items.find((i) => offset >= i.span.start && offset < i.span.end);
    if (item) return { decl, item };
  }
  return null;
}

// Where a module's export of a name declares its name: the offset and the
// name, or the export's start for one with no name of its own (a memory).
function exportedAt(module: Module, text: string, name: string): { offset: number; length: number } | null {
  const decl = module.decls.find((d): d is ExportDecl => d.kind === 'ExportDecl' && d.name === name);
  if (!decl) return null;
  const item = decl.item;
  const ident =
    item.kind === 'FuncDecl' || item.kind === 'TypeFuncDecl'
      ? item.ident
      : item.kind === 'GlobalDecl' && item.pattern.kind === 'IdentPattern'
        ? item.pattern.name
        : null;
  const offset = ident ? nameAfter(text, ident, item.span.start) : -1;
  return offset >= 0 && ident ? { offset, length: ident.length } : { offset: decl.span.start, length: 'export'.length };
}

// -----------------------------------------------------------------------------
// Semantic Tokens
// -----------------------------------------------------------------------------

// Standard LSP token types
const tokenTypes = [
  'type',       // 0 - type names
  'function',   // 1 - function names
  'parameter',  // 2 - input parameters
  'variable',   // 3 - locals, returns/outputs
  'property',   // 4 - struct field access
  'string',     // 5 - string literals
  'number',     // 6 - numeric literals
  'macro',      // 7 - def constants (compile-time)
];

// Standard LSP token modifiers (bit flags)
const tokenModifiers = [
  'declaration',    // 1 << 0 = 1 - symbol declaration/definition
  'readonly',       // 1 << 1 = 2 - for def constants
  'static',         // 1 << 2 = 4 - for globals
  'defaultLibrary', // 1 << 3 = 8 - (unused, standard LSP modifier)
  'input',          // 1 << 4 = 16 - for input parameters
  'output',         // 1 << 5 = 32 - for output/return parameters
];

const tokenLegend: SemanticTokensLegend = {
  tokenTypes,
  tokenModifiers,
};

// Map symbol kinds to token type index
function symbolKindToTokenType(kind: MetaSymbol['kind']): number {
  switch (kind) {
    case 'type':
    case 'unique':
    case 'typeparam':
      return 0; // type
    case 'func':
    case 'comptime':
      return 1; // function (a comptime function parameter stands for one)
    case 'param':
      return 2; // parameter (input)
    case 'return':
      return 3; // variable (output - distinguishes from input params)
    case 'local':
      return 3; // variable
    case 'global':
      return 3; // variable (with static modifier)
    case 'data':
      return 7; // macro (data section allocation)
    case 'def':
    case 'variant':
      return 7; // macro (compile-time constant; a variant is a constant of its enum)
    default:
      return 3; // variable
  }
}

// Get modifiers for a symbol
function symbolKindToModifiers(kind: MetaSymbol['kind'], isDef: boolean, isInput?: boolean): number {
  let modifiers = 0;
  if (isDef) {
    modifiers |= 1; // declaration
  }
  if (kind === 'def' || kind === 'data') {
    modifiers |= 2; // readonly
  }
  if (kind === 'global') {
    modifiers |= 4; // static
  }
  if (isInput) {
    modifiers |= 16; // input
  }
  if (kind === 'return') {
    modifiers |= 32; // output
  }
  return modifiers;
}

// -----------------------------------------------------------------------------
// Connection Setup
// -----------------------------------------------------------------------------

export interface ServerOptions {
  // Reads a source file the editor does not have open: its text, or null.
  // The desktop server reads the file system.
  readFile?: (path: string) => Promise<string | null>;
  // Reads a file of another file system by its URI (a web editor's,
  // vscode-vfs:), where readFile reads none: the web server asks the editor.
  readUri?: (uri: string) => Promise<string | null>;
  // The URIs of the workspace's .ents files, for Go to Symbol in Workspace
  // and for what a rename has to check, in the folders the client named when
  // it started (their URIs): VS Code finds them (the extensions answer
  // encantis/findFiles), `encantis lsp` reads the folders. A listing that is
  // not all of them says why (FoundFiles).
  findFiles?: (folders: string[]) => Promise<string[] | FoundFiles>;
}

// The files a listing found, and where it is not all of them, why: a folder
// it could not read, a limit it stopped at
export interface FoundFiles {
  uris: string[];
  incomplete?: string;
}

// The source files a text that does not parse imports, as far as an import
// of one can be read in it: a module's path in double quotes after `import`,
// with nothing but space and comments between. An import in a comment is
// none. (Part of a module that recovery left out, where nothing else says
// what it imports.)
function importedIn(text: string): string[] {
  const found: string[] = [];
  // The code before the next piece, its comments left out
  let code = '';
  let at = 0;
  for (const piece of pieces(text, text.length)) {
    code += text.slice(at, piece.start);
    at = piece.end;
    if (piece.kind === 'comment') continue;
    if (piece.kind === 'quoted' && !piece.open && text[piece.start] === '"' && /(?<![A-Za-z0-9_-])import\s*$/.test(code)) {
      const spec = text.slice(piece.start + 1, piece.end - 1);
      if (isSourceImport(spec)) found.push(spec);
    }
    code = '';
  }
  return found;
}

// The path the loader names a document's file by: a file's path (pathOf),
// or for a document of another file system (a web editor's, vscode-vfs://),
// the path of its URI, where the URI has one. Null for a document of no
// file (untitled:).
// It is resolved, as the loader resolves the paths it is given and those it
// makes: on Windows it gets the drive of the current directory, which the
// URI made from it again does not have.
export function pathFor(uri: string, paths: Paths = nodePath): string | null {
  if (uri.startsWith('file:')) return pathOf(uri, paths);
  try {
    const url = new URL(uri);
    return url.pathname.startsWith('/') ? paths.resolve(decodeURIComponent(url.pathname)) : null;
  } catch {
    return null;
  }
}

// The URI of a path the loader made, on the file system of a document
export function uriFor(path: string, near: string, paths: Paths = nodePath): string {
  if (near.startsWith('file:')) return uriOf(path, paths);
  const url = new URL(near);
  const slashed = paths.sep === '\\' ? path.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/') : path;
  return `${url.protocol}//${url.host}${slashed.split('/').map(encodeURIComponent).join('/')}`;
}

// Whether two documents are on one file system: of the same scheme and host
function sameFileSystem(a: string, b: string): boolean {
  if (a.startsWith('file:') || b.startsWith('file:')) return a.startsWith('file:') && b.startsWith('file:');
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.protocol === y.protocol && x.host === y.host;
  } catch {
    return false;
  }
}

// What the paths of files are on the platform the server runs on: path's
// own, or path.win32 or path.posix to see what they are on another.
type Paths = Pick<typeof nodePath, 'resolve' | 'sep'>;

// The path of the file a file: URI names, as the loader names that file
// (path.resolve), or null for a document that is no file. Compared with the
// paths the loader asks for and names modules by, it is the same string for
// the same file. On Windows it has its drive, and the drive letter is in
// lower case, as VS Code writes it (file:///d%3A/...), whichever case the
// URI has; a URI with a host is a UNC path.
export function pathOf(uri: string, paths: Paths = nodePath): string | null {
  if (!uri.startsWith('file://')) return null;
  let path: string;
  let host: string;
  try {
    const url = new URL(uri);
    path = decodeURIComponent(url.pathname);
    host = url.host === 'localhost' ? '' : url.host;
  } catch {
    return null;
  }
  if (paths.sep === '\\') {
    if (host) path = `//${host}${path}`;
    else if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  } else if (host) {
    return null;
  }
  return paths.resolve(path).replace(/^[A-Z]:/, drive => drive.toLowerCase());
}

// The file: URI of a path the loader made, each part of it encoded (a # or
// a ? is part of a name, not the start of a fragment or a query)
export function uriOf(path: string, paths: Paths = nodePath): string {
  const slashed = paths.sep === '\\' ? path.replace(/\\/g, '/') : path;
  const encode = (parts: string[]) => parts.map(part => (/^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part))).join('/');
  if (paths.sep === '\\' && slashed.startsWith('//')) {
    const [host, ...rest] = slashed.slice(2).split('/');
    return `file://${host}/${encode(rest)}`;
  }
  return `file://${slashed.startsWith('/') ? '' : '/'}${encode(slashed.split('/'))}`;
}

export function startServer(connection: Connection, options: ServerOptions = {}): void {
  const documents = new TextDocuments(TextDocument);

  // The last analysis of each document
  const analysisCache = new Map<string, Analysis>();
  // The last analysis of each document's text where all of it parsed: what
  // completion knows of the declarations of a function being written, which
  // the analysis of the text as it is leaves out (see recoverParse)
  const lastParsed = new Map<string, Analysis>();

  // The analysis of a document's text as it is now, or none: an analysis of
  // older text, where the name at a place was another one or meant
  // something else, answers nothing.
  function analysisOf(uri: string, text: string): Analysis | null {
    const cached = analysisCache.get(uri);
    return cached && cached.text === text ? cached : null;
  }

  // Whether an analysis answers for what is at an offset: one of the text
  // as it parses does; one with what is broken left out outside of that,
  // where the declaration the offset is in is as it will be once that is
  // written again.
  function answersAt(analysis: Analysis, offset: number): boolean {
    const recovered = analysis.recovered;
    const within = (span: Span) => offset >= span.start && offset < span.end;
    return !recovered || (!recovered.leftOut.some(within) && !recovered.untrusted.some(within));
  }

  // What a hint or a symbol shows as its value. Where what was left out of
  // the text can hold data, the address of data is not known: the data of
  // the rest is laid out after less.
  function shownValue<T extends { value?: string }>(analysis: Analysis, shown: T): T {
    return analysis.recovered && shown.value?.startsWith('0x') ? { ...shown, value: undefined } : shown;
  }

  // Whether it answers for a symbol: also where it is defined
  function answersFor(analysis: Analysis, document: TextDocument, symbol: MetaSymbol): boolean {
    const [line, character] = symbol.def.split(':').map(Number);
    return answersAt(analysis, document.offsetAt({ line, character }));
  }

  // A document that imports other source files is checked as part of its
  // program, so that what it imports is known: its generics are
  // instantiated and checked, and the instances' errors that concern this
  // document reach it. The files are the open documents where they are
  // open, and else what the server can read. Where one cannot be read the
  // document is checked on its own, by the signatures its imports write.
  // The open document of a file, found by its path: a URI made again from
  // the path need not be the one the editor gave the document (VS Code
  // encodes a drive's colon, parentheses and more).
  function documentAt(path: string, near: string): TextDocument | undefined {
    return documents.all().find(document => pathFor(document.uri) === path && sameFileSystem(document.uri, near));
  }

  // `instead`: the texts of other files, by path, to check the program with
  // in place of theirs
  async function programOf(
    uri: string,
    text: string,
    instead: ReadonlyMap<string, string> = new Map(),
  ): Promise<(MetaOptions & { module: Module; program: ProgramCheckResult }) | null> {
    const path = pathFor(uri);
    if (!path) return null;
    const readFile = async (file: string): Promise<string | null> => {
      if (file === path) return text;
      const given = instead.get(file);
      if (given !== undefined) return given;
      const open = documentAt(file, uri);
      if (open) return open.getText();
      if (uri.startsWith('file:')) return options.readFile ? options.readFile(file) : null;
      return options.readUri ? options.readUri(uriFor(file, uri)).catch(() => null) : null;
    };
    try {
      const load = await loadModule(path, { includeTests: true, readFile });
      if (load.errors.length > 0) return null;
      const check = typecheckProgram(load.modules, load.entry.path, { includeTests: true });
      const checkResult = check.results.get(load.entry.path);
      if (!checkResult) return null;
      // The checker's tables are keyed by the nodes of the module it checked.
      const sources = new Map([...load.modules].map(([file, loaded]) => [file, loaded.source]));
      return { module: load.entry.module, checkResult, sources, program: check };
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------------
  // Initialization
  // -----------------------------------------------------------------------------

  // The workspace's folders, as the client names them when it starts
  let folders: string[] = [];
  // Whether the client takes an edit of a document at a version of it, which
  // it does not apply to another (see onRenameRequest)
  let versionedEdits = false;

  connection.onInitialize((params: InitializeParams): InitializeResult => {
    versionedEdits = params.capabilities.workspace?.workspaceEdit?.documentChanges === true;
    if (params.workspaceFolders?.length) folders = params.workspaceFolders.map((folder) => folder.uri);
    else if (params.rootUri) folders = [params.rootUri];
    else if (params.rootPath) folders = [uriOf(params.rootPath)];
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        hoverProvider: true,
        definitionProvider: true,
        documentLinkProvider: { resolveProvider: false },
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
        documentHighlightProvider: true,
        inlayHintProvider: true,
        renameProvider: { prepareProvider: true },
        completionProvider: { triggerCharacters: ['.'] },
        signatureHelpProvider: { triggerCharacters: ['(', ','], retriggerCharacters: [','] },
        referencesProvider: true,
        documentFormattingProvider: true,
        semanticTokensProvider: {
          legend: tokenLegend,
          full: true,
        },
      },
    };
  });

  // -----------------------------------------------------------------------------
  // Document Change Handling
  // -----------------------------------------------------------------------------

  // The files each open document's program was read from, by the document's
  // URI: what the document's check says depends on them too.
  const programFiles = new Map<string, Set<string>>();

  documents.onDidChangeContent(change => {
    validateTextDocument(change.document);
    revalidateImporters(change.document.uri);
  });

  // The open documents whose programs have the file of this URI are checked
  // again: what it exports, and the instances it makes for them, may differ.
  function revalidateImporters(uri: string): void {
    const path = pathFor(uri);
    if (!path) return;
    for (const document of documents.all()) {
      if (document.uri !== uri && sameFileSystem(document.uri, uri) && programFiles.get(document.uri)?.has(path)) validateTextDocument(document);
    }
  }

  async function validateTextDocument(textDocument: TextDocument): Promise<void> {
    const text = textDocument.getText();
    const diagnostics: LSPDiagnostic[] = [];

    const parseResult = parse(text);

    // Handle parse errors
    if (!parseResult.module) {
      for (const error of parseResult.errors) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: offsetToRange(text, error.span.start, error.span.end),
          message: error.shortMessage || error.message,
          source: 'encantis',
        });
      }
      connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
      // The queries answer from an analysis of the text as it is now, with
      // what is broken left out (the declarations the parser stopped in, see
      // recoverParse), but for the names written there. Its errors are not
      // shown: what is left out can be what they miss.
      const recovered = recoverParse(text, parse, parseResult);
      if (!recovered) return;
      try {
        const program = getSourceImports(recovered.module, true).length > 0 ? await programOf(textDocument.uri, recovered.text) : null;
        const latest = documents.get(textDocument.uri);
        if (latest && latest.version !== textDocument.version) return;
        programFiles.set(textDocument.uri, new Set(program?.sources?.keys()));
        const module = program?.module ?? recovered.module;
        const check = program?.checkResult ?? typecheck(module, { source: recovered.text });
        const meta = buildMeta(module, recovered.text, { srcPath: textDocument.uri, ...program, checkResult: check });
        // Checked on its own, a module that imports generic types lists no
        // errors (see TypeCheckResult.partial): nothing would say what depends on what
        // was left out.
        if (meta.warnings?.some((warning) => warning.message.startsWith('imported generic types are resolved only'))) return;
        // Where the checker found errors here, and the calls here that asked
        // for an instance in which it found one
        const offsetOf = (pos: string) => {
          const [line, character] = pos.split(':').map(Number);
          return textDocument.offsetAt({ line, character });
        };
        const errors = (meta.errors ?? []).flatMap((error) => [error.pos, ...(error.notes ?? []).filter((note) => !note.path).map((note) => note.pos)]);
        const distrusted = untrusted(module, text, recovered.leftOut, errors.map(offsetOf), BUILTIN_NAMES);
        if (!distrusted) return;
        analysisCache.set(textDocument.uri, {
          text,
          meta,
          module,
          check,
          sources: program?.sources,
          recovered: { leftOut: recovered.leftOut, untrusted: distrusted, unseenNames: namesIn(text, [...recovered.leftOut, ...distrusted]) },
        });
      } catch {
        // Nothing to answer from
      }
      return;
    }

    // Build meta info (includes type checking)
    let meta: MetaOutput;
    let module = parseResult.module;
    let sources: Map<string, string> | undefined;
    let check: TypeCheckResult;
    try {
      // A document with no source import is checked at once, as it always was.
      const program = getSourceImports(parseResult.module, true).length > 0 ? await programOf(textDocument.uri, text) : null;
      // Changed while its program was read: the newer text is checked.
      const latest = documents.get(textDocument.uri);
      if (latest && latest.version !== textDocument.version) return;
      programFiles.set(textDocument.uri, new Set(program?.sources?.keys()));
      if (program) module = program.module;
      sources = program?.sources;
      check = program?.checkResult ?? typecheck(module, { source: text });
      meta = buildMeta(module, text, { srcPath: textDocument.uri, ...program, checkResult: check });
    } catch (e) {
      // Never crash on partially written code — show the error as a diagnostic
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        message: `Internal compiler error: ${e instanceof Error ? e.message : String(e)}`,
        source: 'encantis',
      });
      connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
      return;
    }

    const analysis = { text, meta, module, check, sources };
    analysisCache.set(textDocument.uri, analysis);
    lastParsed.set(textDocument.uri, analysis);

    // Convert meta errors and warnings to diagnostics
    const tokenLen = (line: number, col: number): number => {
      const lines = text.split('\n');
      if (line >= lines.length) return 1;
      const rest = lines[line].slice(col);
      const m = rest.match(/^[a-zA-Z_-][a-zA-Z0-9_-]*/);
      return m ? m[0].length : Math.max(1, rest.match(/^\S+/)?.[0]?.length ?? 1);
    };

    // A place in another file, whose text is not at hand here
    const rangeIn = (pos: string) => {
      const [line, col] = pos.split(':').map(Number);
      return { start: { line, character: col }, end: { line, character: col + 1 } };
    };
    const rangeAt = (pos: string) => {
      const [line, col] = pos.split(':').map(Number);
      return {
        start: { line, character: col },
        end: { line, character: col + tokenLen(line, col) },
      };
    };
    // An error inside an instance of a generic is shown with the calls that
    // asked for the instance.
    const related = (notes: MetaError['notes']) =>
      notes && notes.length > 0
        ? {
            relatedInformation: notes.map(note => ({
              location: note.path ? { uri: uriFor(note.path, textDocument.uri), range: rangeIn(note.pos) } : { uri: textDocument.uri, range: rangeAt(note.pos) },
              message: note.message,
            })),
          }
        : {};

    if (meta.errors) {
      for (const error of meta.errors) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: rangeAt(error.pos),
          message: error.message,
          source: 'encantis',
          ...related(error.notes),
        });
      }
    }
    if (meta.warnings) {
      for (const warning of meta.warnings) {
        const isUnused = warning.message.includes('is never used');
        diagnostics.push({
          severity: DiagnosticSeverity.Warning,
          range: rangeAt(warning.pos),
          message: warning.message,
          source: 'encantis',
          ...(isUnused ? { tags: [DiagnosticTag.Unnecessary] } : {}),
          ...related(warning.notes),
        });
      }
    }

    connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
  }

  function offsetToRange(text: string, start: number, end: number) {
    const startPos = offsetToPosition(text, start);
    const endPos = offsetToPosition(text, end);
    return {
      start: { line: startPos.line, character: startPos.character },
      end: { line: endPos.line, character: endPos.character },
    };
  }

  function offsetToPosition(text: string, offset: number): { line: number; character: number } {
    let line = 0;
    let lastNewline = -1;
    for (let i = 0; i < offset && i < text.length; i++) {
      if (text[i] === '\n') {
        line++;
        lastNewline = i;
      }
    }
    return { line, character: offset - lastNewline - 1 };
  }

  // -----------------------------------------------------------------------------
  // Hover Provider
  // -----------------------------------------------------------------------------

  connection.onHover((params: TextDocumentPositionParams): Hover | null => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;

    const text = document.getText();
    const wordInfo = getWordAtOffset(text, document.offsetAt(params.position));
    if (!wordInfo) return null;

    const { word } = wordInfo;



    // Check if this is a type punning context (preceded by a dot)
    const isTypePunContext = wordInfo.start > 0 && text[wordInfo.start - 1] === '.';

    // A literal that goes on over lines ends where its word does
    const multiline = word.includes('\n');
    // Helper to create hover range - uses exprStart if available for full expression highlight
    const makeHoverRange = (
      startPos: { line: number; character: number },
      len: number,
      exprStart?: number
    ) => ({
      start: { line: startPos.line, character: exprStart ?? startPos.character },
      end: multiline ? offsetToPosition(text, wordInfo.end) : { line: startPos.line, character: startPos.character + len },
    });

    // Look up hint from meta FIRST (handles type punning and other resolved
    // types), in an analysis of the text as it is now that sees this name
    const cached = analysisOf(params.textDocument.uri, text);
    const known = cached !== null && answersAt(cached, wordInfo.start);
    if (cached && known) {
      const { meta } = cached;
      // Meta uses "line:col" keys (0-indexed) - use word start position, not hover position
      const wordStartPos = offsetToPosition(text, wordInfo.start);
      const key = `${wordStartPos.line}:${wordStartPos.character}`;
      const hint = meta.hints[key];

      if (hint) {
        const typeStr = meta.types[hint.type]?.type ?? 'unknown';
        const symbol = hint.symbol !== undefined ? meta.symbols[hint.symbol] : null;
        const range = makeHoverRange(wordStartPos, hint.len, hint.exprStart);

        if (symbol) {
          if (!answersFor(cached, document, symbol)) return null;
          // A refused value (a name of a refused pattern, a variable given a
          // refused operator's result) has no type to show: its name alone.
          const display = symbol.refused ? refusedDisplay(symbol) : formatLine(formatSymbolDisplay(shownValue(cached, symbol), typeStr));
          let value = `\`\`\`encantis\n${display}\n\`\`\``;
          value += hintDetails(hint, meta);
          if (symbol.doc) {
            value += `\n\n${symbol.doc}`;
          }
          return { contents: { kind: MarkupKind.Markdown, value }, range };
        }

        // Check for builtin functions: a call of one has a function's type.
        // A field or a member named like one (`min: T`, `r.max`) is not it.
        const builtinSig = BUILTIN_SIGNATURES[word];
        if (builtinSig && typeStr.includes('->') && hint.expr === undefined) {
          return {
            contents: {
              kind: MarkupKind.Markdown,
              value: `\`\`\`encantis\n${builtinSig}\n\`\`\``,
            },
            range,
          };
        }

        // Just type, no symbol - use expr if available for full context.
        // A literal's line breaks are shown as the escapes they stand for.
        let displayName = hint.expr ?? (multiline ? word.replace(/\r/g, '\\r').replace(/\n/g, '\\n') : word);
        // Wrap unquoted string values (template literal segments) in quotes
        if (/^\[?]?u8$|^\*\[\d+]u8$/.test(typeStr) && !/^["'`[]/.test(displayName)) {
          displayName = `"${displayName}"`;
        }
        // Truncate long string literals (over 40 chars) for readability
        if (displayName.startsWith('"') && displayName.length > 40) {
          displayName = `${displayName.slice(0, 37)}..."`;
        }
        // Add parent kind prefix for member access (e.g., "input c.y" vs just "c.y")
        const kindPrefix = hint.parentKind ? kindToPrefix(hint.parentKind) + ' ' : '';
        const shown = shownValue(cached, hint).value;
        const raw = shown
          ? `${kindPrefix}${displayName}: ${typeStr} = ${shown}`
          : `${kindPrefix}${displayName}: ${typeStr}`;
        return {
          contents: {
            kind: MarkupKind.Markdown,
            value: `\`\`\`encantis\n${formatLine(raw)}\n\`\`\`${hintDetails(hint, meta)}`,
          },
          range,
        };
      }

      // A name a generic function declares for itself (a parameter, a type
      // parameter, a local) has no hint: what it is depends on the instance.
      // It is that name all the same, before anything else spelled like it:
      // by name it would be shown as a global, a type or a builtin.
      if (genericDeclaring(cached.module, wordInfo.start, word)) return null;

      // A field of an enum's payload, where it is declared or named (a named
      // argument of a constructor, a part of a pattern by name), is shown
      // with its type.
      const payload = payloadFieldAt(params);
      if (payload) {
        const value = `\`\`\`encantis\n${formatLine(`${word}: ${typeToString(payload.found.field.type)}`)}\n\`\`\``;
        return { contents: { kind: MarkupKind.Markdown, value }, range: makeHoverRange(wordStartPos, word.length) };
      }

      // A field's name (`type Pt = (x: i32)`, `Pt(x: 1)`) is no name of the
      // module either, and by name it would be shown as a global spelled
      // like it. After a point it has a hint of its own.
      if (fieldNamedAt(cached.module, wordInfo.start)) return null;

      // Fallback: look up by name in symbols. Only a name of the module is
      // found that way: a parameter or local is what the hint at its own
      // position says, and where there is none (in the body of a generic
      // function) a name alone would find some other function's. So is a
      // generic's type parameter or comptime parameter.
      const own: MetaSymbol['kind'][] = ['param', 'local', 'return', 'typeparam', 'comptime'];
      const symbol = meta.symbols.find(s => s.name === word && !own.includes(s.kind));
      if (symbol && answersFor(cached, document, symbol)) {
        const typeStr = meta.types[symbol.type]?.type ?? 'unknown';
        const display = formatLine(formatSymbolDisplay(shownValue(cached, symbol), typeStr));
        let value = `\`\`\`encantis\n${display}\n\`\`\``;
        if (symbol.doc) {
          value += `\n\n${symbol.doc}`;
        }
        // Use word bounds for symbol lookup fallback
        const range = makeHoverRange(wordStartPos, word.length);
        return { contents: { kind: MarkupKind.Markdown, value }, range };
      }
    }

    // Fallback to builtin/type docs (but NOT for type punning - those need meta hints)
    if (!isTypePunContext) {
      const wordStartPos = offsetToPosition(text, wordInfo.start);
      const range = makeHoverRange(wordStartPos, word.length);

      // Check for builtin function signature first: only where an analysis
      // of the text as it is now has no other thing of the name (a function
      // or a local can take a builtin's name).
      const builtinSig = known ? BUILTIN_SIGNATURES[word] : undefined;
      if (builtinSig) {
        const doc = BUILTIN_DOCS[word];
        const value = doc
          ? `\`\`\`encantis\n${builtinSig}\n\`\`\`\n\n${doc}`
          : `\`\`\`encantis\n${builtinSig}\n\`\`\``;
        return { contents: { kind: MarkupKind.Markdown, value }, range };
      }

      const doc = TYPE_DOCS[word];
      if (doc) {
        return { contents: { kind: MarkupKind.Markdown, value: doc }, range };
      }
    }

    return null;
  });

  // -----------------------------------------------------------------------------
  // Definition and References
  // -----------------------------------------------------------------------------

  // The symbol a name at a position is, as its hint says: where it is defined
  // and where it is used, as the checker recorded them. A call in a
  // generic's body is a use of the functions its instances call. Only an
  // analysis of the text as it is now answers (while the text does not
  // parse, with what is broken left out, where it can: see answersAt).
  function symbolAt(params: TextDocumentPositionParams): { symbol: MetaSymbol; uri: string; analysis: Analysis } | null {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;
    const text = document.getText();
    const cached = analysisOf(params.textDocument.uri, text);
    if (!cached) return null;
    const word = getWordAtOffset(text, document.offsetAt(params.position));
    if (!word || !answersAt(cached, word.start)) return null;
    const at = offsetToPosition(text, word.start);
    const hint = cached.meta.hints[`${at.line}:${at.character}`];
    const symbol = hint?.symbol !== undefined ? cached.meta.symbols[hint.symbol] : undefined;
    return symbol && answersFor(cached, document, symbol) ? { symbol, uri: params.textDocument.uri, analysis: cached } : null;
  }

  function locationOf(uri: string, symbol: MetaSymbol, key: string): Location {
    const [line, character] = key.split(':').map(Number);
    return { uri, range: { start: { line, character }, end: { line, character: character + symbol.name.length } } };
  }

  // On an import of another source file, at the name it is exported by or
  // the name it is given here: where the other file declares what it
  // exports. (A use of the name is defined at its import, the first step.)
  function exportAt(params: TextDocumentPositionParams): Location | null {
    const document = documents.get(params.textDocument.uri);
    const path = pathFor(params.textDocument.uri);
    if (!document || !path) return null;
    const text = document.getText();
    const analysis = analysisOf(params.textDocument.uri, text);
    const word = getWordAtOffset(text, document.offsetAt(params.position));
    if (!analysis || !word || !answersAt(analysis, word.start)) return null;
    const found = importItemAt(analysis.module, word.start);
    if (!found) return null;
    const { decl, item } = found;
    const local = item.item.ident;
    const onName = word.start === item.span.start;
    const onLocal = local !== null && word.start === nameAfter(text, local, item.item.span.start);
    if (!onName && !onLocal) return null;
    const target = resolveModulePath(decl.module, path);
    const open = documentAt(target, params.textDocument.uri);
    const source = open?.getText() ?? analysis.sources?.get(target);
    if (source === undefined) return null;
    const module = parse(source, { filePath: target }).module;
    const at = module && exportedAt(module, source, item.name);
    if (!at) return null;
    const start = offsetToPosition(source, at.offset);
    return { uri: open?.uri ?? uriFor(target, params.textDocument.uri), range: { start, end: { line: start.line, character: start.character + at.length } } };
  }

  // The field of an enum's payload a name at a position declares or names,
  // where it is declared and where it is named (see payloadFieldNamed). It
  // is no symbol of the module: a struct's fields, which have no such
  // answer, are not either.
  function payloadFieldAt(params: TextDocumentPositionParams): { found: NonNullable<ReturnType<typeof payloadFieldNamed>>; length: number; uri: string; analysis: Analysis } | null {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;
    const text = document.getText();
    const cached = analysisOf(params.textDocument.uri, text);
    const word = getWordAtOffset(text, document.offsetAt(params.position));
    if (!cached || !word || !answersAt(cached, word.start)) return null;
    const found = payloadFieldNamed(cached.module, cached.check, word.start);
    if (!found || !answersAt(cached, found.declared)) return null;
    return { found, length: word.end - word.start, uri: params.textDocument.uri, analysis: cached };
  }

  function rangeAt(text: string, offset: number, length: number): Range {
    return { start: offsetToPosition(text, offset), end: offsetToPosition(text, offset + length) };
  }

  connection.onDefinition((params: TextDocumentPositionParams): Location | null => {
    const exported = exportAt(params);
    if (exported) return exported;
    const found = symbolAt(params);
    if (found) return locationOf(found.uri, found.symbol, found.symbol.def);
    const field = payloadFieldAt(params);
    return field ? { uri: field.uri, range: rangeAt(field.analysis.text, field.found.declared, field.length) } : null;
  });

  // ---------------------------------------------------------------------------
  // Completion and signature help
  // ---------------------------------------------------------------------------

  // The analyses to complete from: of the text as it is, where there is one,
  // and of the text when it last parsed
  function sourcesOf(uri: string, text: string) {
    const current = analysisOf(uri, text);
    return { current, parsed: lastParsed.get(uri) ?? null, answers: (offset: number) => current !== null && answersAt(current, offset) };
  }

  connection.onCompletion((params: CompletionParams): CompletionItem[] => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return [];
    const text = document.getText();
    const { current, parsed, answers } = sourcesOf(params.textDocument.uri, text);
    return complete(text, document.offsetAt(params.position), current, parsed, answers);
  });

  connection.onSignatureHelp((params: SignatureHelpParams): SignatureHelp | null => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;
    const text = document.getText();
    const { current, parsed, answers } = sourcesOf(params.textDocument.uri, text);
    return signatureHelp(text, document.offsetAt(params.position), current, parsed, answers);
  });

  // ---------------------------------------------------------------------------
  // Rename
  // ---------------------------------------------------------------------------

  const refuse = (message: string) => new ResponseError(LSPErrorCodes.RequestFailed, message);

  // What renaming the name at a place renames, in an analysis of the text as
  // it is now, or null where no name of the module's is there to rename
  function renamePlan(params: TextDocumentPositionParams): { plan: RenamePlan; analysis: Analysis; document: TextDocument; start: number } | null {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;
    const text = document.getText();
    const word = getWordAtOffset(text, document.offsetAt(params.position));
    if (!word || !/^[A-Za-z_]/.test(word.word)) return null;
    const analysis = analysisOf(params.textDocument.uri, text);
    if (!analysis) throw refuse('The file is still being checked: try again in a moment');
    if (!answersAt(analysis, word.start)) throw refuse(`'${word.word}' is in a declaration that does not parse yet`);
    const planned = planRename(text, analysis.module, analysis.check, word.start);
    if (!planned) return null;
    if ('refused' in planned) throw refuse(planned.refused);
    if (analysis.recovered?.unseenNames.has(planned.name)) throw refuse(`'${planned.name}' is also written where the text does not parse yet`);
    return { plan: planned, analysis, document, start: word.start };
  }

  // Why the renamed text would not mean what the text does, or null: it adds
  // an error, or the new name is not, at each place, what the old one was
  // (another name of that spelling is seen there instead, or hides it).
  async function renameProblem(uri: string, analysis: Analysis, renamed: { text: string; places: number[] }, name: string): Promise<string | null> {
    const parsed = parse(renamed.text);
    let module = parsed.module ?? recoverParse(renamed.text, parse, parsed)?.module;
    if (!module) return 'the renamed text does not parse';
    const program = parsed.module && getSourceImports(module, true).length > 0 ? await programOf(uri, renamed.text) : null;
    if (program) module = program.module;
    const check = program?.checkResult ?? typecheck(module, { source: renamed.text });
    const before = new Set(analysis.check.errors.map((e) => e.message));
    const added = check.errors.filter((e) => !before.has(e.message));
    if (check.errors.length > analysis.check.errors.length || added.length > 0) {
      return `renamed to '${name}', the program would not check: ${added[0]?.message ?? check.errors[0]?.message}`;
    }
    const found = renamed.places.length > 0 ? rename(renamed.text, module, check, renamed.places[0]) : null;
    const places = (found?.locations ?? []).map((l) => l.offset).sort((a, b) => a - b);
    if (places.join() !== renamed.places.join()) {
      return `'${name}' is a name here already: renamed to it, some of its uses would mean another thing`;
    }
    return null;
  }

  // Why the renamed text of a document would break another module of the
  // workspace, or null: a program that holds the document, checked with the
  // renamed text in its place, has an error it does not have now. A field is
  // named by the modules that import its struct or the function whose results
  // it is, also where none of them writes its name: a value of the struct given
  // to another struct of those fields needs them all. A module that may hold
  // the document and cannot be checked is a reason too: one that cannot be
  // read, one that does not parse and imports it (as far as it parses), one
  // that imports it whose program does not load. The files are listed afresh;
  // where they cannot all be, that is said, as nothing could be checked.
  async function dependentProblem(uri: string, renamed: string, name: string): Promise<string | null> {
    const own = pathFor(uri);
    if (!own) return null;
    const file = (path: string) => path.replace(/^.*[\\/]/, '');
    const ownName = file(own).replace(/\.ents$/, '');
    const others = new Set([...documents.all().map((d) => d.uri), ...(await workspaceFiles(true))]);
    for (const other of others) {
      const path = pathFor(other);
      if (!path || path === own || !sameFileSystem(other, uri)) continue;
      const text = await textOf(other);
      if (text === null) return `${path} could not be read, so whether it uses this module could not be checked`;
      // The module as far as it parses: its source imports, a test's
      // included, say whether it can hold this one
      const parsed = parse(text);
      const recovered = parsed.module ? null : recoverParse(text, parse, parsed);
      const module = parsed.module ?? recovered?.module;
      if (!module) {
        // Nothing of it parses: whether it imports this module is not known
        if (new RegExp(`"[^"]*\\b${ownName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.ents)?"`).test(text)) {
          return `${file(path)} may use this module and does not parse, so it could not be checked`;
        }
        continue;
      }
      const imports = getSourceImports(module, true);
      const direct = imports.some((decl) => resolveModulePath(decl.module, path) === own);
      if (recovered) {
        // What recovery left out may import it too: a test whose brace is not
        // closed yet, an import being written. Its imports are read from the
        // text left out, and a module one of them names holds it where that
        // module's program does.
        const omitted = recovered.leftOut.flatMap((span) => importedIn(text.slice(span.start, span.end))).map((spec) => resolveModulePath(spec, path));
        let holds = direct || omitted.includes(own) || (imports.length > 0 && (await programOf(other, recovered.text))?.sources?.has(own));
        for (const dep of omitted) {
          if (holds) break;
          const depText = await textOf(uriFor(dep, other));
          holds = depText !== null && (await programOf(uriFor(dep, other), depText))?.sources?.has(own);
        }
        if (holds) return `${file(path)}, which uses this module, does not parse yet, so it could not be checked`;
        continue;
      }
      if (imports.length === 0) continue;
      const now = await programOf(other, text);
      if (!now) {
        if (direct) return `${file(path)}, which imports this module, could not be checked: its program does not load`;
        continue;
      }
      if (!now.sources?.has(own)) continue;
      const then = await programOf(other, text, new Map([[own, renamed]]));
      const errors = (program: ProgramCheckResult) => [...program.results.values()].flatMap((r) => r.errors.map((e) => e.message));
      const before = errors(now.program);
      const after = then ? errors(then.program) : ['the renamed program does not load'];
      const added = after.filter((message) => !before.includes(message));
      if (after.length > before.length || added.length > 0) {
        return `renamed to '${name}', ${file(path)}, which uses this module, would not check: ${added[0] ?? after[0]}`;
      }
    }
    return null;
  }

  connection.onPrepareRename((params: PrepareRenameParams) => {
    const found = renamePlan(params);
    if (!found) return null;
    const { plan, document, start } = found;
    return { range: { start: document.positionAt(start), end: document.positionAt(start + plan.name.length) }, placeholder: plan.name };
  });

  // The edits are made of the text the plan was made of, at its version: the
  // document can change while the rename is checked, which awaits other
  // files. An edit of a document that changed meanwhile is refused, and a
  // client that can be told the version is.
  connection.onRenameRequest(async (params: RenameParams): Promise<WorkspaceEdit | null> => {
    const found = renamePlan(params);
    if (!found) return null;
    const { plan, analysis, document } = found;
    const { uri } = params.textDocument;
    const version = document.version;
    const why = refusedName(plan.name, params.newName);
    if (why) throw refuse(why);
    if (params.newName === plan.name) return { changes: {} };
    const renamed = applyRename(analysis.text, plan, params.newName);
    const at = (offset: number) => offsetToPosition(analysis.text, offset);
    const edits = renamed.edits.map((e) => ({ range: { start: at(e.start), end: at(e.end) }, newText: e.newText }));
    const problem = await renameProblem(uri, analysis, renamed, params.newName);
    if (problem) throw refuse(problem);
    // A field is named by other modules, which rename does not edit
    if (plan.field !== null) {
      const elsewhere = await dependentProblem(uri, renamed.text, params.newName).catch((e: unknown) => {
        throw refuse(`the workspace's files could not all be listed, so the modules that use this one could not be checked: ${(e as Error)?.message ?? e}`);
      });
      if (elsewhere) throw refuse(elsewhere);
    }
    if (documents.get(uri)?.version !== version) throw refuse('The file changed while the rename was checked: try again');
    return versionedEdits ? { documentChanges: [{ textDocument: { uri, version }, edits }] } : { changes: { [uri]: edits } };
  });

  // The declarations of the document, for the outline, the breadcrumbs and
  // Go to Symbol. While a declaration does not parse, it is listed by its
  // name, which is read from the words it starts with.
  // The declarations of a text, with the types an analysis of it gives
  function declarationsOf(text: string, analysis: Analysis | null, positionAt: (offset: number) => Position): DocumentSymbol[] {
    // With no analysis of the text as it is, what of it parses
    const parsed = analysis ? null : parse(text);
    const recovered = parsed && !parsed.module ? recoverParse(text, parse, parsed) : null;
    const module = analysis?.module ?? parsed?.module ?? recovered?.module;
    if (!module) return [];
    const detailOf = (offset: number) => {
      if (!analysis || !answersAt(analysis, offset)) return undefined;
      const at = offsetToPosition(text, offset);
      const hint = analysis.meta.hints[`${at.line}:${at.character}`];
      const type = hint && analysis.meta.types[hint.type]?.type;
      return type ? formatLine(type) : undefined;
    };
    const symbols = outline(module, text, positionAt, detailOf);
    const leftOut = leftOutSymbols(text, analysis?.recovered?.leftOut ?? recovered?.leftOut ?? [], positionAt);
    const line = (s: DocumentSymbol) => s.range.start.line;
    return [...symbols, ...leftOut].sort((a, b) => line(a) - line(b));
  }

  connection.onDocumentSymbol((params: DocumentSymbolParams): DocumentSymbol[] => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return [];
    const text = document.getText();
    return declarationsOf(text, analysisOf(params.textDocument.uri, text), (offset) => document.positionAt(offset));
  });

  // Go to Symbol in Workspace: the declarations of the workspace's .ents
  // files (as the editor finds them) and of the open documents, with what
  // each is declared in. A file's are kept while its text is the same.
  const declaredIn = new Map<string, { text: string; symbols: SymbolInformation[] }>();
  // The files found last, kept for a few seconds: the editor asks again as
  // each letter of a query is written.
  let listed: { at: number; uris: string[] } | null = null;

  // `fresh`: listed now, and a listing that failed or is not all of the
  // files is thrown, with why (rename depends on what is there; a search
  // shows what it finds)
  async function workspaceFiles(fresh = false): Promise<string[]> {
    if (!options.findFiles) return [];
    const list = async (): Promise<FoundFiles> => {
      const found = await options.findFiles!(folders);
      return Array.isArray(found) ? { uris: found } : found;
    };
    if (fresh) {
      const found = await list();
      listed = { at: Date.now(), uris: found.uris };
      if (found.incomplete) throw new Error(found.incomplete);
    } else if (!listed || Date.now() - listed.at > 5000) {
      listed = { at: Date.now(), uris: (await list().catch(() => ({ uris: [] }))).uris };
    }
    return listed.uris;
  }

  async function textOf(uri: string): Promise<string | null> {
    const open = documents.get(uri);
    if (open) return open.getText();
    if (uri.startsWith('file:')) {
      const path = pathOf(uri);
      return path && options.readFile ? options.readFile(path) : null;
    }
    return options.readUri ? options.readUri(uri).catch(() => null) : null;
  }

  function symbolsOfFile(uri: string, text: string): SymbolInformation[] {
    const known = declaredIn.get(uri);
    if (known && known.text === text) return known.symbols;
    const document = TextDocument.create(uri, 'encantis', 0, text);
    const symbols: SymbolInformation[] = [];
    const flatten = (list: DocumentSymbol[], container?: string) => {
      for (const symbol of list) {
        // An import's items are the other file's declarations.
        if (symbol.kind === SymbolKind.Module) continue;
        symbols.push({ name: symbol.name, kind: symbol.kind, location: { uri, range: symbol.selectionRange }, ...(container ? { containerName: container } : {}) });
        if (symbol.children) flatten(symbol.children, symbol.name);
      }
    };
    flatten(declarationsOf(text, analysisOf(uri, text), (offset) => document.positionAt(offset)));
    declaredIn.set(uri, { text, symbols });
    return symbols;
  }

  connection.onWorkspaceSymbol(async (params: WorkspaceSymbolParams): Promise<SymbolInformation[]> => {
    // An open document is read as it is open, also where the files found
    // write its URI another way
    const open = documents.all().map((d) => d.uri);
    const opened = new Set(open.map((uri) => pathFor(uri) ?? uri));
    const uris = [...open, ...(await workspaceFiles()).filter((uri) => !opened.has(pathFor(uri) ?? uri))];
    // The letters of the query, in order, in the name (as the editor matches)
    const query = params.query.toLowerCase();
    const matches = (name: string) => {
      let at = 0;
      for (const ch of name.toLowerCase()) if (ch === query[at]) at++;
      return at === query.length;
    };
    const results: SymbolInformation[] = [];
    for (const uri of uris) {
      const text = await textOf(uri);
      if (text === null) continue;
      for (const symbol of symbolsOfFile(uri, text)) if (matches(symbol.name)) results.push(symbol);
      if (results.length >= 1000) break;
    }
    return results;
  });

  // What the compiler inferred, in the lines asked for: the types of names
  // bound with none written, the parameters of literal arguments. Only from
  // an analysis of the text as it is now, where it answers.
  connection.languages.inlayHint.on((params: InlayHintParams): InlayHint[] => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return [];
    const text = document.getText();
    const analysis = analysisOf(params.textDocument.uri, text);
    if (!analysis) return [];
    const from = document.offsetAt(params.range.start);
    const to = document.offsetAt(params.range.end);
    return inlayHints(analysis, from, to, (offset) => document.positionAt(offset), (offset) => answersAt(analysis, offset));
  });

  // The places of the symbol at a position, for the editor to highlight: where
  // it is declared and where it is assigned are writes, the other uses reads.
  // Answered as references are (see onReferences).
  connection.onDocumentHighlight((params: DocumentHighlightParams): DocumentHighlight[] | null => {
    const found = symbolAt(params);
    if (!found) {
      const field = payloadFieldAt(params);
      if (!field) return null;
      const { declared, uses } = field.found;
      return uses.map((at) => ({ range: rangeAt(field.analysis.text, at, field.length), kind: at === declared ? DocumentHighlightKind.Write : DocumentHighlightKind.Read }));
    }
    const { symbol, uri, analysis } = found;
    if (analysis.recovered?.unseenNames.has(symbol.name)) return null;
    // An assignment's =, not == or a match arm's =>
    const assigned = /^\s*(?:[-+*/%&|^]\|?|<<<?|>>>?)?=(?![=>])/;
    const lines = analysis.text.split('\n');
    return [symbol.def, ...symbol.refs].map((key, i) => {
      const { range } = locationOf(uri, symbol, key);
      const after = lines[range.end.line]?.slice(range.end.character) ?? '';
      const write = i === 0 || assigned.test(after);
      return { range, kind: write ? DocumentHighlightKind.Write : DocumentHighlightKind.Read };
    });
  });

  // The path of each import of another source file opens that file.
  connection.onDocumentLinks((params: DocumentLinkParams): DocumentLink[] => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return [];
    const text = document.getText();
    const module = analysisOf(params.textDocument.uri, text)?.module ?? parse(text).module;
    if (!module) return [];
    const links: DocumentLink[] = [];
    for (const decl of getSourceImports(module, true)) {
      const open = text.indexOf('"', decl.span.start);
      const close = open < 0 ? -1 : text.indexOf('"', open + 1);
      if (close < 0 || text.slice(open + 1, close) !== decl.module) continue;
      let target: string;
      try {
        target = new URL(decl.module.endsWith('.ents') ? decl.module : `${decl.module}.ents`, params.textDocument.uri).href;
      } catch {
        continue;
      }
      links.push({ range: { start: document.positionAt(open + 1), end: document.positionAt(close) }, target });
    }
    return links;
  });

  connection.onReferences((params: ReferenceParams): Location[] | null => {
    const found = symbolAt(params);
    if (!found) {
      const field = payloadFieldAt(params);
      if (!field) return null;
      const { declared, uses } = field.found;
      const keys = params.context?.includeDeclaration ? uses : uses.filter((at) => at !== declared);
      return keys.map((at) => ({ uri: field.uri, range: rangeAt(field.analysis.text, at, field.length) }));
    }
    const { symbol, uri, analysis } = found;
    // A use in what was left out, or in a declaration that can differ once
    // that is written again, may not be listed.
    if (analysis.recovered?.unseenNames.has(symbol.name)) return null;
    const keys = params.context?.includeDeclaration ? [symbol.def, ...symbol.refs] : symbol.refs;
    return keys.map(key => locationOf(uri, symbol, key));
  });

  // -----------------------------------------------------------------------------
  // Semantic Tokens Handler
  // -----------------------------------------------------------------------------

  connection.languages.semanticTokens.on((params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return { data: [] };

    const cached = analysisCache.get(params.textDocument.uri);
    if (!cached) return { data: [] };

    const { meta } = cached;
    const builder = new SemanticTokensBuilder();

    // Collect all tokens first, then sort by position (required by SemanticTokensBuilder)
    const tokens: { line: number; col: number; len: number; type: number; modifiers: number }[] = [];

    // Process all hints from meta - these give us positions and types
    for (const [key, hint] of Object.entries(meta.hints)) {
      const [lineStr, colStr] = key.split(':');
      const line = parseInt(lineStr, 10);
      const col = parseInt(colStr, 10);

      // Determine token type and modifiers
      let tokenType: number;
      let modifiers = 0;

      if (hint.symbol !== undefined) {
        const symbol = meta.symbols[hint.symbol];
        if (symbol) {
          const isDef = symbol.def === key;
          // Handle parameter-like symbols (param and return) specially
          if (symbol.kind === 'param' || symbol.kind === 'return') {
            tokenType = 2; // parameter
            // 'param' symbols get 'input' modifier, 'return' symbols get 'output' modifier
            modifiers = symbolKindToModifiers(symbol.kind, isDef, symbol.kind === 'param');
          } else {
            tokenType = symbolKindToTokenType(symbol.kind);
            modifiers = symbolKindToModifiers(symbol.kind, isDef);
          }
        } else {
          continue;
        }
      } else {
        // No symbol - check the type to determine token type
        const typeStr = meta.types[hint.type]?.type ?? '';
        if (typeStr.startsWith('(') && typeStr.includes('->')) {
          tokenType = 1; // function
        } else {
          // Skip hints without symbols that don't map to a semantic token
          continue;
        }
      }

      tokens.push({ line, col, len: hint.len, type: tokenType, modifiers });
    }

    // Sort by line, then by column
    tokens.sort((a, b) => a.line - b.line || a.col - b.col);

    // Push sorted tokens to builder
    for (const token of tokens) {
      builder.push(token.line, token.col, token.len, token.type, token.modifiers);
    }

    return builder.build();
  });

  function getWordAtOffset(text: string, offset: number): { word: string; start: number; end: number } | null {
    // A literal (a string, one in single quotes, a piece of a template's
    // text) is one word, on as many lines as it goes on for.
    const literal = literalAt(text, offset);
    if (literal) return literal;

    // Handle brackets as single-character "words" for hover hints
    const ch = text[offset];
    if (ch === '[' || ch === ']') {
      return { word: ch, start: offset, end: offset + 1 };
    }
    // Handle .* dereference - treat * as hoverable when preceded by dot
    if (ch === '*' && offset > 0 && text[offset - 1] === '.') {
      return { word: '*', start: offset, end: offset + 1 };
    }

    let start = offset;
    let end = offset;
    while (start > 0 && isWordChar(text[start - 1])) start--;
    while (end < text.length && isWordChar(text[end])) end++;
    // A name starts with a letter: a minus before it negates it (-k).
    while (text[start] === '-' && /[A-Za-z_]/.test(text[start + 1] ?? '')) start++;
    if (start === end) return null;
    return { word: text.slice(start, end), start, end };
  }

  function isWordChar(ch: string): boolean {
    return /[a-zA-Z0-9_-]/.test(ch);
  }

  // -----------------------------------------------------------------------------
  // Formatting
  // -----------------------------------------------------------------------------

  connection.onDocumentFormatting((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const text = doc.getText();
    const formatted = formatEncantis(text);
    if (formatted === text) return [];
    return [{
      range: {
        start: { line: 0, character: 0 },
        end: doc.positionAt(text.length),
      },
      newText: formatted,
    }];
  });

  // -----------------------------------------------------------------------------
  // Document Events
  // -----------------------------------------------------------------------------

  documents.onDidClose(e => {
    analysisCache.delete(e.document.uri);
    lastParsed.delete(e.document.uri);
    connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
    // Closed, the file is read where it is saved, which can differ.
    programFiles.delete(e.document.uri);
    revalidateImporters(e.document.uri);
  });

  // -----------------------------------------------------------------------------
  // Start Server
  // -----------------------------------------------------------------------------

  documents.listen(connection);
  connection.listen();
}

