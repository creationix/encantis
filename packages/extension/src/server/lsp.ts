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
  SemanticTokensBuilder,
  SemanticTokensLegend,
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';

import { parse } from '@encantis/compiler/parser';
import { buildMeta, type MetaOutput, type MetaSymbol } from '@encantis/compiler/meta';

// Builtin function signatures for hover display
// Polymorphic builtins show representative types
const BUILTIN_SIGNATURES: Record<string, string> = {
  // Comptime
  sizeof: 'sizeof(T) -> u32',
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

// Convert symbol kind to display prefix
function kindToPrefix(kind: MetaSymbol['kind']): string {
  switch (kind) {
    case 'param': return 'input';
    case 'return': return 'output';
    case 'local': return 'let';
    case 'global': return 'global';
    case 'def': return 'def';
    case 'func': return 'func';
    case 'type': return 'type';
    case 'unique': return 'type';
    default: return '';
  }
}

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
      return 0; // type
    case 'func':
      return 1; // function
    case 'param':
      return 2; // parameter (input)
    case 'return':
      return 3; // variable (output - distinguishes from input params)
    case 'local':
      return 3; // variable
    case 'global':
      return 3; // variable (with static modifier)
    case 'def':
      return 7; // macro (compile-time constant)
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
  if (kind === 'def') {
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
    sizeof: 'Returns the byte size of a type at compile time.',
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
      let displayName = hint.expr ?? word;
      // Truncate long string literals (over 40 chars) for readability
      if (displayName.startsWith('"') && displayName.length > 40) {
        displayName = `${displayName.slice(0, 37)}..."`;
      }
      // Add parent kind prefix for member access (e.g., "input c.y" vs just "c.y")
      const kindPrefix = hint.parentKind ? kindToPrefix(hint.parentKind) + ' ' : '';
      const display = hint.value
        ? `${kindPrefix}${displayName}: ${typeStr} = ${hint.value}`
        : `${kindPrefix}${displayName}: ${typeStr}`;
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
      } else if (hint.value && (hint.value.startsWith('0x') || hint.value.startsWith('('))) {
        tokenType = 5; // string (data literals)
      } else {
        tokenType = 4; // property (field access, etc.)
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
  // Handle brackets as single-character "words" for hover hints
  const ch = text[offset];
  if (ch === '[' || ch === ']') {
    return { word: ch, start: offset, end: offset + 1 };
  }
  // Handle .* dereference - treat * as hoverable when preceded by dot
  if (ch === '*' && offset > 0 && text[offset - 1] === '.') {
    return { word: '*', start: offset, end: offset + 1 };
  }

  // Handle string literals - find if we're inside or on a quoted string
  // If we're on a quote, determine if it's opening or closing
  if (ch === '"') {
    // Look backward for another quote - if found, we're on the closing quote
    for (let i = offset - 1; i >= 0; i--) {
      if (text[i] === '"' && (i === 0 || text[i - 1] !== '\\')) {
        // Found opening quote - return the whole string
        return { word: text.slice(i, offset + 1), start: i, end: offset + 1 };
      }
      if (text[i] === '\n') break;
    }
    // No quote found backward - we're on the opening quote, look forward
    for (let i = offset + 1; i < text.length; i++) {
      if (text[i] === '"' && text[i - 1] !== '\\') {
        return { word: text.slice(offset, i + 1), start: offset, end: i + 1 };
      }
      if (text[i] === '\n') break;
    }
  }
  // Not on a quote - check if inside a string by looking backwards
  let quoteStart = -1;
  for (let i = offset - 1; i >= 0; i--) {
    if (text[i] === '"' && (i === 0 || text[i - 1] !== '\\')) {
      quoteStart = i;
      break;
    }
    if (text[i] === '\n') break;
  }
  if (quoteStart !== -1) {
    // Look forwards for closing quote
    for (let i = offset; i < text.length; i++) {
      if (text[i] === '"' && text[i - 1] !== '\\') {
        // Found closing quote - return the whole string literal
        return { word: text.slice(quoteStart, i + 1), start: quoteStart, end: i + 1 };
      }
      if (text[i] === '\n') break;
    }
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
