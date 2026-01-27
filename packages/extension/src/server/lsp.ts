// =============================================================================
// Encantis Language Server
// Provides diagnostics and hover for .ents files
// =============================================================================

import {
  createConnection,
  TextDocuments,
  Diagnostic as LSPDiagnostic,
  DiagnosticSeverity,
  ProposedFeatures,
  type InitializeParams,
  type InitializeResult,
  TextDocumentSyncKind,
  type TextDocumentPositionParams,
  type Hover,
  MarkupKind,
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';

import { parse } from '@encantis/compiler/parser';
import { buildMeta, type MetaOutput, type MetaSymbol } from '@encantis/compiler/meta';

// Builtin function signatures for hover display
// Polymorphic builtins show representative types
const BUILTIN_SIGNATURES: Record<string, string> = {
  // Memory operations
  memset: 'builtin memset(dest: [*]u8, value: u8, len: u32)',
  memcpy: 'builtin memcpy(dest: [*]u8, src: [*]u8, len: u32)',
  // Float math (f32/f64)
  sqrt: 'builtin sqrt(x: f64) -> f64',
  abs: 'builtin abs(x: f64) -> f64',
  ceil: 'builtin ceil(x: f64) -> f64',
  floor: 'builtin floor(x: f64) -> f64',
  trunc: 'builtin trunc(x: f64) -> f64',
  nearest: 'builtin nearest(x: f64) -> f64',
  copysign: 'builtin copysign(x: f64, y: f64) -> f64',
  // Min/max (all numeric types)
  min: 'builtin min(a: T, b: T) -> T',
  max: 'builtin max(a: T, b: T) -> T',
  // Integer bit operations
  clz: 'builtin clz(x: i32) -> i32',
  ctz: 'builtin ctz(x: i32) -> i32',
  popcnt: 'builtin popcnt(x: i32) -> i32',
};

// Format symbol display using proper Encantis syntax
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
    case 'func':
      return symbol.inline
        ? `inline func ${symbol.name}: ${typeStr}`
        : `func ${symbol.name}: ${typeStr}`;
    case 'type':
      return `type ${symbol.name} = ${typeStr}`;
    case 'unique':
      return `type ${symbol.name}@ = ${typeStr}`;
    case 'def':
      return symbol.value
        ? `def ${symbol.name}: ${typeStr} = ${symbol.value}`
        : `def ${symbol.name}: ${typeStr}`;
    default:
      return `${symbol.name}: ${typeStr}`;
  }
}

// Cache analysis results per document
const analysisCache = new Map<string, { text: string; meta: MetaOutput }>();

// -----------------------------------------------------------------------------
// Connection Setup
// -----------------------------------------------------------------------------

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// -----------------------------------------------------------------------------
// Initialization
// -----------------------------------------------------------------------------

connection.onInitialize((_params: InitializeParams): InitializeResult => {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
    },
  };
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
    return;
  }

  // Build meta info (includes type checking)
  const meta = buildMeta(parseResult.module, text, { srcPath: textDocument.uri });

  analysisCache.set(textDocument.uri, { text, meta });

  // Convert meta errors to diagnostics
  if (meta.errors) {
    for (const error of meta.errors) {
      const [line, col] = error.pos.split(':').map(Number);
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: {
          start: { line, character: col },
          end: { line, character: col + 1 },
        },
        message: error.message,
        source: 'encantis',
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

  // Builtin docs
  const builtinDocs: Record<string, string> = {
    memset: 'Fill memory with a byte value.',
    memcpy: 'Copy bytes from source to destination.',
    sqrt: 'Square root (f32/f64).',
    abs: 'Absolute value (floats and signed integers).',
    ceil: 'Round up to nearest integer (f32/f64).',
    floor: 'Round down to nearest integer (f32/f64).',
    trunc: 'Truncate toward zero (f32/f64).',
    nearest: 'Round to nearest even (f32/f64).',
    min: 'Minimum of two values (all numeric types).',
    max: 'Maximum of two values (all numeric types).',
    copysign: 'Copy sign of y to x (f32/f64).',
    clz: 'Count leading zeros (integers).',
    ctz: 'Count trailing zeros (integers).',
    popcnt: 'Population count - number of 1 bits (integers).',
  };

  // Type docs
  const typeDocs: Record<string, string> = {
    i8: '8-bit signed integer',
    u8: '8-bit unsigned integer',
    i16: '16-bit signed integer',
    u16: '16-bit unsigned integer',
    i32: '32-bit signed integer',
    u32: '32-bit unsigned integer',
    i64: '64-bit signed integer',
    u64: '64-bit unsigned integer',
    i128: '128-bit signed integer (SIMD v128)',
    u128: '128-bit unsigned integer (SIMD v128)',
    i256: '256-bit signed integer (2x SIMD v128)',
    u256: '256-bit unsigned integer (2x SIMD v128)',
    f32: '32-bit floating point',
    f64: '64-bit floating point',
  };

  // Check if this is a type punning context (preceded by a dot)
  const isTypePunContext = wordInfo.start > 0 && text[wordInfo.start - 1] === '.';

  // Look up hint from meta FIRST (handles type punning and other resolved types)
  const cached = analysisCache.get(params.textDocument.uri);
  if (cached) {
    const { meta } = cached;
    // Meta uses "line:col" keys (0-indexed) - use word start position, not hover position
    const wordStartPos = offsetToPosition(text, wordInfo.start);
    const key = `${wordStartPos.line}:${wordStartPos.character}`;
    const hint = meta.hints[key];

    if (hint) {
      const typeStr = meta.types[hint.type]?.type ?? 'unknown';
      const symbol = hint.symbol !== undefined ? meta.symbols[hint.symbol] : null;

      if (symbol) {
        const display = formatSymbolDisplay(symbol, typeStr);
        let value = `\`\`\`encantis\n${display}\n\`\`\``;
        if (symbol.doc) {
          value += `\n\n${symbol.doc}`;
        }
        return { contents: { kind: MarkupKind.Markdown, value } };
      }

      // Check for builtin functions
      const builtinSig = BUILTIN_SIGNATURES[word];
      if (builtinSig) {
        return {
          contents: {
            kind: MarkupKind.Markdown,
            value: `\`\`\`encantis\n${builtinSig}\n\`\`\``,
          },
        };
      }

      // Just type, no symbol - use expr if available for full context
      const displayName = hint.expr ?? word;
      const display = hint.value
        ? `${displayName}: ${typeStr} = ${hint.value}`
        : `${displayName}: ${typeStr}`;
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `\`\`\`encantis\n${display}\n\`\`\``,
        },
      };
    }

    // Fallback: look up by name in symbols
    const symbol = meta.symbols.find(s => s.name === word);
    if (symbol) {
      const typeStr = meta.types[symbol.type]?.type ?? 'unknown';
      const display = formatSymbolDisplay(symbol, typeStr);
      let value = `\`\`\`encantis\n${display}\n\`\`\``;
      if (symbol.doc) {
        value += `\n\n${symbol.doc}`;
      }
      return { contents: { kind: MarkupKind.Markdown, value } };
    }
  }

  // Fallback to builtin/type docs (but NOT for type punning - those need meta hints)
  if (!isTypePunContext) {
    // Check for builtin function signature first
    const builtinSig = BUILTIN_SIGNATURES[word];
    if (builtinSig) {
      const doc = builtinDocs[word];
      const value = doc
        ? `\`\`\`encantis\n${builtinSig}\n\`\`\`\n\n${doc}`
        : `\`\`\`encantis\n${builtinSig}\n\`\`\``;
      return { contents: { kind: MarkupKind.Markdown, value } };
    }

    const doc = typeDocs[word];
    if (doc) {
      return { contents: { kind: MarkupKind.Markdown, value: doc } };
    }
  }

  return null;
});

function getWordAtOffset(text: string, offset: number): { word: string; start: number; end: number } | null {
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
  if (start === end) return null;
  return { word: text.slice(start, end), start, end };
}

function isWordChar(ch: string): boolean {
  return /[a-zA-Z0-9_-]/.test(ch);
}

// -----------------------------------------------------------------------------
// Document Events
// -----------------------------------------------------------------------------

documents.onDidClose(e => {
  analysisCache.delete(e.document.uri);
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

// -----------------------------------------------------------------------------
// Start Server
// -----------------------------------------------------------------------------

documents.listen(connection);
connection.listen();

console.error('Encantis Language Server started');
