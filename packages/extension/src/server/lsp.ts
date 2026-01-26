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
import { buildMeta, type MetaOutput } from '@encantis/compiler/meta';

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
    sqrt: '```encantis\nfunc sqrt(x: f32/f64) -> same\n```\nSquare root.',
    abs: '```encantis\nfunc abs(x: f32/f64) -> same\n```\nAbsolute value.',
    ceil: '```encantis\nfunc ceil(x: f32/f64) -> same\n```\nRound up.',
    floor: '```encantis\nfunc floor(x: f32/f64) -> same\n```\nRound down.',
    trunc: '```encantis\nfunc trunc(x: f32/f64) -> same\n```\nTruncate toward zero.',
    nearest: '```encantis\nfunc nearest(x: f32/f64) -> same\n```\nRound to nearest even.',
    min: '```encantis\nfunc min(a, b: f32/f64) -> same\n```\nMinimum of two values.',
    max: '```encantis\nfunc max(a, b: f32/f64) -> same\n```\nMaximum of two values.',
    copysign: '```encantis\nfunc copysign(x, y: f32/f64) -> same\n```\nCopy sign of y to x.',
    clz: '```encantis\nfunc clz(x: i32/i64) -> u8\n```\nCount leading zeros.',
    ctz: '```encantis\nfunc ctz(x: i32/i64) -> u8\n```\nCount trailing zeros.',
    popcnt: '```encantis\nfunc popcnt(x: i32/i64) -> u8\n```\nPopulation count.',
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

  // Look up hint from meta
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
        let display = symbol.kind === 'def' && symbol.value
          ? `(${symbol.kind}) ${symbol.name}: ${typeStr} = ${symbol.value}`
          : `(${symbol.kind}) ${symbol.name}: ${typeStr}`;
        let value = `\`\`\`encantis\n${display}\n\`\`\``;
        if (symbol.doc) {
          value += `\n\n${symbol.doc}`;
        }
        return { contents: { kind: MarkupKind.Markdown, value } };
      }

      // Just type, no symbol
      const display = hint.value
        ? `${word}: ${typeStr} = ${hint.value}`
        : `${word}: ${typeStr}`;
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
      let display = symbol.kind === 'def' && symbol.value
        ? `(${symbol.kind}) ${symbol.name}: ${typeStr} = ${symbol.value}`
        : `(${symbol.kind}) ${symbol.name}: ${typeStr}`;
      let value = `\`\`\`encantis\n${display}\n\`\`\``;
      if (symbol.doc) {
        value += `\n\n${symbol.doc}`;
      }
      return { contents: { kind: MarkupKind.Markdown, value } };
    }
  }

  return null;
});

function getWordAtOffset(text: string, offset: number): { word: string; start: number; end: number } | null {
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
