// =============================================================================
// Encantis Language Server
// Provides diagnostics, hover, and other LSP features for .ents files
// =============================================================================

import {
  createConnection,
  TextDocuments,
  Diagnostic as LSPDiagnostic,
  DiagnosticSeverity,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  DidChangeConfigurationNotification,
  Range,
  TextDocumentPositionParams,
  Hover,
  MarkupKind,
  RenameParams,
  WorkspaceEdit,
  TextEdit,
  PrepareRenameParams,
  SemanticTokensParams,
  SemanticTokens,
  SemanticTokensBuilder,
  SemanticTokensLegend,
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';

import { parse } from '@encantis/compiler/parser';
import { check, type TypeCheckResult } from '@encantis/compiler/checker';
import * as AST from '@encantis/compiler/ast';

// Cache analysis results per document
const analysisCache = new Map<string, { text: string; result: TypeCheckResult; ast: AST.Module }>();

// -----------------------------------------------------------------------------
// Connection Setup
// -----------------------------------------------------------------------------

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;

// Semantic tokens legend
const tokenTypes = ['parameter', 'variable', 'function'];
const tokenModifiers = ['declaration', 'static', 'modification', 'readonly', 'output'];
const semanticTokensLegend: SemanticTokensLegend = { tokenTypes, tokenModifiers };

// -----------------------------------------------------------------------------
// Initialization
// -----------------------------------------------------------------------------

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const capabilities = params.capabilities;
  hasConfigurationCapability = !!(capabilities.workspace?.configuration);
  hasWorkspaceFolderCapability = !!(capabilities.workspace?.workspaceFolders);

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
      renameProvider: { prepareProvider: true },
      semanticTokensProvider: { legend: semanticTokensLegend, full: true },
    },
  };

  if (hasWorkspaceFolderCapability) {
    result.capabilities.workspace = { workspaceFolders: { supported: true } };
  }

  return result;
});

connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    connection.client.register(DidChangeConfigurationNotification.type, undefined);
  }
});

// -----------------------------------------------------------------------------
// Document Change Handling
// -----------------------------------------------------------------------------

documents.onDidChangeContent(change => {
  validateTextDocument(change.document);
});

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
  const text = textDocument.getText();
  const diagnostics: LSPDiagnostic[] = [];

  const parseResult = parse(text);
  const result = check(parseResult, text);

  analysisCache.set(textDocument.uri, { text, result, ast: parseResult.ast });

  for (const error of result.errors) {
    diagnostics.push(convertDiagnostic(text, { ...error, start: error.offset, end: error.offset + 1 }));
  }

  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

function convertDiagnostic(src: string, error: AST.Span & { message: string }): LSPDiagnostic {
  const startPos = getLineAndColumn(src, error.start);
  const endPos = getLineAndColumn(src, error.end);

  return {
    severity: DiagnosticSeverity.Error,
    range: {
      start: { line: startPos.line - 1, character: startPos.column - 1 },
      end: { line: endPos.line - 1, character: endPos.column - 1 },
    },
    message: error.message,
    source: 'encantis',
  };
}

function getLineAndColumn(src: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src[i] === '\n') {
      line++;
      lastNewline = i;
    }
  }
  return { line, column: offset - lastNewline };
}

// -----------------------------------------------------------------------------
// Hover Provider
// -----------------------------------------------------------------------------

connection.onHover((params: TextDocumentPositionParams): Hover | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;

  const text = document.getText();
  const offset = document.offsetAt(params.position);
  const word = getWordAtOffset(text, offset);
  if (!word) return null;

  // Builtin docs
  const builtinDocs: Record<string, string> = {
    // Float builtins
    sqrt: '```encantis\nfunc sqrt(x: f32/f64) -> same\n```\nSquare root. Maps to WASM `f32.sqrt`/`f64.sqrt`.',
    abs: '```encantis\nfunc abs(x: f32/f64) -> same\n```\nAbsolute value. Maps to WASM `f32.abs`/`f64.abs`.',
    ceil: '```encantis\nfunc ceil(x: f32/f64) -> same\n```\nRound up to nearest integer. Maps to WASM `f32.ceil`/`f64.ceil`.',
    floor: '```encantis\nfunc floor(x: f32/f64) -> same\n```\nRound down to nearest integer. Maps to WASM `f32.floor`/`f64.floor`.',
    trunc: '```encantis\nfunc trunc(x: f32/f64) -> same\n```\nTruncate toward zero. Maps to WASM `f32.trunc`/`f64.trunc`.',
    nearest: '```encantis\nfunc nearest(x: f32/f64) -> same\n```\nRound to nearest even (banker\'s rounding). Maps to WASM `f32.nearest`/`f64.nearest`.',
    min: '```encantis\nfunc min(a: f32/f64, b: f32/f64) -> same\n```\nMinimum of two values. Maps to WASM `f32.min`/`f64.min`.',
    max: '```encantis\nfunc max(a: f32/f64, b: f32/f64) -> same\n```\nMaximum of two values. Maps to WASM `f32.max`/`f64.max`.',
    copysign: '```encantis\nfunc copysign(x: f32/f64, y: f32/f64) -> same\n```\nCopy sign of y to x. Maps to WASM `f32.copysign`/`f64.copysign`.',
    // Integer builtins
    clz: '```encantis\nfunc clz(x: i32/i64/u32/u64) -> u8\n```\nCount leading zeros (0 to bit width). Maps to WASM `i32.clz`/`i64.clz`.',
    ctz: '```encantis\nfunc ctz(x: i32/i64/u32/u64) -> u8\n```\nCount trailing zeros (0 to bit width). Maps to WASM `i32.ctz`/`i64.ctz`.',
    popcnt: '```encantis\nfunc popcnt(x: i32/i64/u32/u64) -> u8\n```\nPopulation count (number of 1 bits). Maps to WASM `i32.popcnt`/`i64.popcnt`.',
    // Memory builtins
    'memory-size': '```encantis\nfunc memory-size() -> i32\n```\nCurrent memory size in pages (64KB each). Maps to WASM `memory.size`.',
    'memory-grow': '```encantis\nfunc memory-grow(n: i32) -> i32\n```\nGrow memory by n pages. Returns previous size or -1 on failure. Maps to WASM `memory.grow`.',
  };

  // Type docs
  const typeDocs: Record<string, string> = {
    i32: '32-bit signed integer',
    u32: '32-bit unsigned integer',
    i64: '64-bit signed integer',
    u64: '64-bit unsigned integer',
    f32: '32-bit floating point',
    f64: '64-bit floating point',
    u8: '8-bit unsigned integer',
    i8: '8-bit signed integer',
    u16: '16-bit unsigned integer',
    i16: '16-bit signed integer',
  };

  const doc = builtinDocs[word] || typeDocs[word];
  if (doc) {
    return { contents: { kind: MarkupKind.Markdown, value: doc } };
  }

  // Look up symbol
  const cached = analysisCache.get(params.textDocument.uri);
  if (cached) {
    const symbol = findSymbol(cached.result, word);
    if (symbol) {
      const typeStr = symbol.type ? typeToString(symbol.type) : 'unknown';
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `\`\`\`encantis\n(${symbol.kind}) ${word}: ${typeStr}\n\`\`\``,
        },
      };
    }
  }

  return null;
});

function findSymbol(result: CheckResult, name: string): EncSymbol | undefined {
  const globalSym = result.symbols.global.symbols.get(name);
  if (globalSym) return globalSym;
  for (const [, scope] of result.symbols.scopes) {
    const sym = scope.symbols.get(name);
    if (sym) return sym;
  }
  return undefined;
}

function typeToString(type: Type): string {
  switch (type.kind) {
    case 'PrimitiveType': return type.name;
    case 'SliceType': return `[${typeToString(type.element)}]`;
    case 'PointerType': return `*${typeToString(type.target)}`;
    case 'TupleType':
      return type.elements.length === 0 ? '()' : `(${type.elements.map(typeToString).join(', ')})`;
    case 'StructType':
      return `(${type.fields.map(f => `${f.name}: ${typeToString(f.type)}`).join(', ')})`;
    case 'NamedType': return type.name;
    case 'ArrayType': return `[${typeToString(type.element)}*${type.length}]`;
    default: return '?';
  }
}

function getWordAtOffset(text: string, offset: number): string | null {
  let start = offset;
  let end = offset;
  while (start > 0 && isWordChar(text[start - 1])) start--;
  while (end < text.length && isWordChar(text[end])) end++;
  if (start === end) return null;
  return text.slice(start, end);
}

function isWordChar(ch: string): boolean {
  return /[a-zA-Z0-9_-]/.test(ch);
}

// -----------------------------------------------------------------------------
// Rename Provider
// -----------------------------------------------------------------------------

connection.onPrepareRename((params: PrepareRenameParams): Range | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;

  const text = document.getText();
  const offset = document.offsetAt(params.position);
  const wordRange = getWordRangeAtOffset(text, offset);
  if (!wordRange) return null;

  const word = text.slice(wordRange.start, wordRange.end);

  const keywords = new Set([
    'import', 'export', 'func', 'let', 'set', 'global',
    'if', 'elif', 'else', 'while', 'for', 'in', 'loop',
    'return', 'when', 'break', 'continue', 'memory', 'type',
  ]);

  const builtins = new Set([
    'sqrt', 'abs', 'ceil', 'floor', 'trunc', 'nearest', 'min', 'max', 'copysign',
    'clz', 'ctz', 'popcnt', 'memory-size', 'memory-grow',
  ]);
  const types = new Set(['i32', 'u32', 'i64', 'u64', 'f32', 'f64', 'u8', 'i8', 'u16', 'i16']);

  if (keywords.has(word) || builtins.has(word) || types.has(word)) return null;

  const cached = analysisCache.get(params.textDocument.uri);
  if (!cached) return null;

  const symbol = findSymbol(cached.result, word);
  if (!symbol) return null;

  const startPos = getLineAndColumn(text, wordRange.start);
  const endPos = getLineAndColumn(text, wordRange.end);

  return {
    start: { line: startPos.line - 1, character: startPos.column - 1 },
    end: { line: endPos.line - 1, character: endPos.column - 1 },
  };
});

connection.onRenameRequest((params: RenameParams): WorkspaceEdit | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;

  const text = document.getText();
  const offset = document.offsetAt(params.position);
  const word = getWordAtOffset(text, offset);
  if (!word) return null;

  const cached = analysisCache.get(params.textDocument.uri);
  if (!cached) return null;

  const containingFunc = findFunctionAtOffset(cached.ast, offset);
  const symbolInfo = findSymbolWithScope(cached.result, word, containingFunc);
  if (!symbolInfo) return null;

  let scopeStart = 0;
  let scopeEnd = text.length;

  if (symbolInfo.funcSpan) {
    scopeStart = symbolInfo.funcSpan.start;
    scopeEnd = symbolInfo.funcSpan.end;
  }

  const edits: TextEdit[] = [];
  const regex = new RegExp(`\\b${escapeRegex(word)}\\b`, 'g');
  const matches = text.matchAll(regex);

  for (const match of matches) {
    if (match.index === undefined) continue;
    const matchStart = match.index;
    const matchEnd = matchStart + word.length;
    if (matchStart < scopeStart || matchEnd > scopeEnd) continue;

    const startPos = getLineAndColumn(text, matchStart);
    const endPos = getLineAndColumn(text, matchEnd);

    edits.push({
      range: {
        start: { line: startPos.line - 1, character: startPos.column - 1 },
        end: { line: endPos.line - 1, character: endPos.column - 1 },
      },
      newText: params.newName,
    });
  }

  if (edits.length === 0) return null;
  return { changes: { [params.textDocument.uri]: edits } };
});

function getWordRangeAtOffset(text: string, offset: number): { start: number; end: number } | null {
  let start = offset;
  let end = offset;
  while (start > 0 && isWordChar(text[start - 1])) start--;
  while (end < text.length && isWordChar(text[end])) end++;
  if (start === end) return null;
  return { start, end };
}

function findSymbolWithScope(
  result: CheckResult,
  name: string,
  containingFunc: FuncDecl | undefined
): { symbol: EncSymbol; isGlobal: boolean; funcSpan?: Span } | undefined {
  if (containingFunc) {
    const funcScope = result.symbols.scopes.get(containingFunc);
    if (funcScope) {
      const sym = funcScope.symbols.get(name);
      if (sym) return { symbol: sym, isGlobal: false, funcSpan: containingFunc.span };
    }
  }

  const globalSym = result.symbols.global.symbols.get(name);
  if (globalSym) return { symbol: globalSym, isGlobal: true };

  for (const [func, scope] of result.symbols.scopes) {
    const sym = scope.symbols.get(name);
    if (sym) return { symbol: sym, isGlobal: false, funcSpan: func.span };
  }

  return undefined;
}

function findFunctionAtOffset(ast: Module, offset: number): FuncDecl | undefined {
  for (const decl of ast.decls) {
    if (decl.kind === 'ExportDecl' && decl.decl.kind === 'FuncDecl') {
      if (offset >= decl.decl.span.start && offset <= decl.decl.span.end) {
        return decl.decl;
      }
    } else if (decl.kind === 'FuncDecl') {
      if (offset >= decl.span.start && offset <= decl.span.end) {
        return decl;
      }
    }
  }
  return undefined;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// -----------------------------------------------------------------------------
// Semantic Tokens Provider
// -----------------------------------------------------------------------------

connection.languages.semanticTokens.on((params: SemanticTokensParams): SemanticTokens => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return { data: [] };

  const cached = analysisCache.get(params.textDocument.uri);
  if (!cached) return { data: [] };

  const text = document.getText();
  const builder = new SemanticTokensBuilder();
  const ast = cached.ast;
  const symbols = cached.result.symbols;

  const tokens: Array<{ span: Span; type: number; modifiers: number }> = [];
  const addToken = (span: Span, type: number, modifiers = 0) => {
    tokens.push({ span, type, modifiers });
  };

  // Process all declarations
  for (const decl of ast.decls) {
    if (decl.kind === 'GlobalDecl') {
      const declText = text.slice(decl.span.start, decl.span.end);
      const match = declText.match(/^global\s+([a-zA-Z_][a-zA-Z0-9_-]*)/);
      if (match) {
        const nameStart = decl.span.start + declText.indexOf(match[1]);
        addToken({ start: nameStart, end: nameStart + match[1].length }, 1, 3); // variable + static + declaration
      }
    } else if (decl.kind === 'ExportDecl' && decl.decl.kind === 'FuncDecl') {
      processFunction(decl.decl);
    } else if (decl.kind === 'FuncDecl') {
      processFunction(decl);
    }
  }

  function processFunction(func: FuncDecl) {
    // Function name
    if (func.name) {
      const funcText = text.slice(func.span.start, func.span.end);
      const nameMatch = funcText.match(/^(?:inline\s+)?func\s+([a-zA-Z_][a-zA-Z0-9_-]*)/);
      if (nameMatch) {
        const nameStart = func.span.start + funcText.indexOf(nameMatch[1]);
        addToken({ start: nameStart, end: nameStart + nameMatch[1].length }, 2, 1); // function + declaration
      }
    }

    // Collect named return names
    const namedReturnNames = new Set<string>();
    const returns = func.signature.returns;
    if (returns && 'kind' in returns && returns.kind === 'NamedReturns') {
      for (const ret of (returns as NamedReturns).fields) {
        namedReturnNames.add(ret.name);
      }
    }

    // Parameters
    for (const param of func.signature.params) {
      if (param.name && param.span) {
        const isAlsoOutput = namedReturnNames.has(param.name);
        const modifiers = isAlsoOutput ? (1 | 16) : 1;
        const paramText = text.slice(param.span.start, param.span.end);
        const colonIdx = paramText.indexOf(':');
        if (colonIdx > 0) {
          addToken({ start: param.span.start, end: param.span.start + colonIdx }, 0, modifiers);
        } else {
          addToken(param.span, 0, modifiers);
        }
      }
    }

    // Named returns
    if (returns && 'kind' in returns && returns.kind === 'NamedReturns') {
      for (const ret of (returns as NamedReturns).fields) {
        const retText = text.slice(ret.span.start, ret.span.end);
        const colonIdx = retText.indexOf(':');
        if (colonIdx > 0) {
          addToken({ start: ret.span.start, end: ret.span.start + colonIdx }, 0, 1 | 16);
        }
      }
    }

    const funcScope = symbols.scopes.get(func);
    const localSymbols = funcScope?.symbols || new Map();

    // Process body
    processBody(func.body, localSymbols, namedReturnNames);
  }

  function processBody(body: Body, localSymbols: Map<string, EncSymbol>, namedReturnNames: Set<string>) {
    if (body.kind === 'ArrowBody') {
      processExpr(body.expr, localSymbols, namedReturnNames);
    } else {
      for (const stmt of body.stmts) {
        processStmt(stmt, localSymbols, namedReturnNames);
      }
    }
  }

  function processStmt(stmt: Stmt, localSymbols: Map<string, EncSymbol>, namedReturnNames: Set<string>) {
    switch (stmt.kind) {
      case 'LetStmt': {
        if (stmt.pattern.kind === 'IdentPattern') {
          const localText = text.slice(stmt.span.start, stmt.span.end);
          const localMatch = localText.match(/^let\s+([a-zA-Z_][a-zA-Z0-9_-]*)/);
          if (localMatch) {
            const nameStart = stmt.span.start + localText.indexOf(localMatch[1]);
            addToken({ start: nameStart, end: nameStart + localMatch[1].length }, 1, 1);
          }
        }
        if (stmt.init) processExpr(stmt.init, localSymbols, namedReturnNames);
        break;
      }

      case 'AssignStmt':
        if (stmt.target.kind === 'Identifier' && stmt.target.span) {
          if (namedReturnNames.has(stmt.target.name)) {
            addToken(stmt.target.span, 0, 4 | 16);
          } else if (localSymbols.get(stmt.target.name)?.kind === 'param') {
            addToken(stmt.target.span, 0, 4);
          } else {
            addToken(stmt.target.span, 1, 4);
          }
        } else {
          processExpr(stmt.target, localSymbols, namedReturnNames);
        }
        processExpr(stmt.value, localSymbols, namedReturnNames);
        break;

      case 'ExprStmt':
        processExpr(stmt.expr, localSymbols, namedReturnNames);
        break;

      case 'ReturnStmt':
        if (stmt.value) processExpr(stmt.value, localSymbols, namedReturnNames);
        break;

      case 'IfStmt':
        processExpr(stmt.condition, localSymbols, namedReturnNames);
        processBody(stmt.thenBody, localSymbols, namedReturnNames);
        for (const elif of stmt.elifClauses) {
          processExpr(elif.condition, localSymbols, namedReturnNames);
          processBody(elif.body, localSymbols, namedReturnNames);
        }
        if (stmt.elseBody) processBody(stmt.elseBody, localSymbols, namedReturnNames);
        break;

      case 'WhileStmt':
        processExpr(stmt.condition, localSymbols, namedReturnNames);
        processBody(stmt.body, localSymbols, namedReturnNames);
        break;

      case 'LoopStmt':
        processBody(stmt.body, localSymbols, namedReturnNames);
        break;

      case 'ForStmt':
        processExpr(stmt.iterable, localSymbols, namedReturnNames);
        processBody(stmt.body, localSymbols, namedReturnNames);
        break;
    }
  }

  function processExpr(expr: Expr, localSymbols: Map<string, EncSymbol>, namedReturnNames: Set<string>) {
    switch (expr.kind) {
      case 'Identifier':
        if (expr.span) {
          if (namedReturnNames.has(expr.name)) {
            addToken(expr.span, 0, 16);
          } else {
            const sym = localSymbols.get(expr.name);
            if (sym) {
              addToken(expr.span, sym.kind === 'param' ? 0 : 1, 0);
            } else {
              const globalSym = symbols.global.symbols.get(expr.name);
              if (globalSym) {
                if (globalSym.kind === 'function' || globalSym.kind === 'builtin') {
                  addToken(expr.span, 2, 0);
                } else {
                  addToken(expr.span, 1, 2);
                }
              }
            }
          }
        }
        break;

      case 'BinaryExpr':
        processExpr(expr.left, localSymbols, namedReturnNames);
        processExpr(expr.right, localSymbols, namedReturnNames);
        break;

      case 'UnaryExpr':
        processExpr(expr.operand, localSymbols, namedReturnNames);
        break;

      case 'CallExpr':
        processExpr(expr.callee, localSymbols, namedReturnNames);
        for (const arg of expr.args) {
          processExpr(arg.value, localSymbols, namedReturnNames);
        }
        break;

      case 'MemberExpr':
        processExpr(expr.target, localSymbols, namedReturnNames);
        break;

      case 'IndexExpr':
        processExpr(expr.target, localSymbols, namedReturnNames);
        processExpr(expr.index, localSymbols, namedReturnNames);
        break;

      case 'TupleLit':
        for (const elem of expr.elements) {
          processExpr(elem, localSymbols, namedReturnNames);
        }
        break;

      case 'CastExpr':
        processExpr(expr.expr, localSymbols, namedReturnNames);
        break;
    }
  }

  // Sort and emit tokens
  tokens.sort((a, b) => a.span.start - b.span.start);
  for (const token of tokens) {
    const startPos = getLineAndColumn(text, token.span.start);
    const length = token.span.end - token.span.start;
    builder.push(startPos.line - 1, startPos.column - 1, length, token.type, token.modifiers);
  }

  return builder.build();
});

// -----------------------------------------------------------------------------
// Document Events
// -----------------------------------------------------------------------------

documents.onDidClose(e => {
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

// -----------------------------------------------------------------------------
// Start Server
// -----------------------------------------------------------------------------

documents.listen(connection);
connection.listen();

console.error('Encantis Language Server started');
