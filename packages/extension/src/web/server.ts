// =============================================================================
// Encantis Language Server (Web/Browser Version)
// Provides diagnostics, hover, and other LSP features for .ents files
// =============================================================================

import {
  createConnection,
  TextDocuments,
  Diagnostic as LSPDiagnostic,
  DiagnosticSeverity,
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
} from 'vscode-languageserver/browser';

import { TextDocument } from 'vscode-languageserver-textdocument';

// Note: The actual implementation modules should be available
// They may need to be web-compatible (no Node.js fs/path dependencies)
import { parse } from '@encantis/compiler/parser';
import { check, type TypeCheckResult } from '@encantis/compiler/checker';
import * as AST from '@encantis/compiler/ast';

// Cache analysis results per document
const analysisCache = new Map<string, { text: string; result: TypeCheckResult; ast: AST.Module }>();

// Use the browser message port from the Worker
const connection = createConnection(new BrowserMessageReader(self as unknown as DedicatedWorkerGlobalScope), 
                                     new BrowserMessageWriter(self as unknown as DedicatedWorkerGlobalScope));
const documents = new TextDocuments(TextDocument);

// Simple implementations of BrowserMessageReader and BrowserMessageWriter
class BrowserMessageReader {
  constructor(private scope: DedicatedWorkerGlobalScope) {
    this.scope.onmessage = this.onMessage;
  }

  private onMessage: ((message: any) => void) | null = null;

  listen(callback: (message: any) => void): void {
    this.onMessage = callback;
  }

  onClose(_: () => void): void {
    // no-op for now
  }

  onError(_: (error: Error) => void): void {
    // no-op for now
  }
}

class BrowserMessageWriter {
  constructor(private scope: DedicatedWorkerGlobalScope) {}

  write(message: any): Promise<void> {
    this.scope.postMessage(message);
    return Promise.resolve();
  }

  onClose(_: () => void): void {
    // no-op for now
  }

  onError(_: (error: Error) => void): void {
    // no-op for now
  }
}

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;

// Semantic tokens legend
const tokenTypes = ['parameter', 'variable', 'function'];
const tokenModifiers = ['declaration', 'static', 'modification', 'readonly', 'output'];
const semanticTokensLegend: SemanticTokensLegend = { tokenTypes, tokenModifiers };

// Bind document manager to connection
documents.listen(connection);

// Connection initialization
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

// Document change handling
documents.onDidChangeContent(change => {
  validateTextDocument(change.document);
});

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
  const text = textDocument.getText();
  const diagnostics: LSPDiagnostic[] = [];

  try {
    const parseResult = parse(text);
    const result = check(parseResult, text);

    analysisCache.set(textDocument.uri, { text, result, ast: parseResult.ast });

    for (const error of result.errors) {
      diagnostics.push(convertDiagnostic(text, { ...error, start: error.offset, end: error.offset + 1 }));
    }
  } catch (error) {
    console.error('Error validating document:', error);
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

// Hover provider
connection.onHover((params: TextDocumentPositionParams): Hover | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }

  const cached = analysisCache.get(document.uri);
  if (!cached) {
    return null;
  }

  const offset = document.offsetAt(params.position);
  const sym = findSymbolAtOffset(cached.ast, offset);

  if (!sym) {
    return null;
  }

  const typeStr = typeToString(sym.type);
  // Format using proper Encantis syntax
  let contents: string;
  switch (sym.kind) {
    case 'global': contents = `global ${sym.name}: ${typeStr}`; break;
    case 'local': contents = `let ${sym.name}: ${typeStr}`; break;
    case 'param': contents = `${sym.name}: ${typeStr}`; break;
    case 'return': contents = `-> ${sym.name}: ${typeStr}`; break;
    case 'func': contents = `func ${sym.name}: ${typeStr}`; break;
    case 'type': contents = `type ${sym.name} = ${typeStr}`; break;
    case 'def': contents = `def ${sym.name}: ${typeStr}`; break;
    default: contents = `${sym.name}: ${typeStr}`;
  }

  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: `\`\`\`encantis\n${contents}\n\`\`\``,
    },
  };
});

// Prepare rename provider
connection.onPrepareRename(
  (params: PrepareRenameParams): Range | { range: Range; placeholder: string } | null => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
      return null;
    }

    const cached = analysisCache.get(document.uri);
    if (!cached) {
      return null;
    }

    const offset = document.offsetAt(params.position);
    const range = findTokenRange(document, offset);

    if (!range) {
      return null;
    }

    const token = document.getText(range);
    return { range, placeholder: token };
  }
);

// Rename provider
connection.onRename((params: RenameParams): WorkspaceEdit | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }

  const cached = analysisCache.get(document.uri);
  if (!cached) {
    return null;
  }

  const offset = document.offsetAt(params.position);
  const range = findTokenRange(document, offset);

  if (!range) {
    return null;
  }

  const token = document.getText(range);
  const newText = params.newName;

  // Find all occurrences of the token in the document
  const text = document.getText();
  const tokenRegex = new RegExp(`\\b${token}\\b`, 'g');
  const edits: TextEdit[] = [];

  let match;
  while ((match = tokenRegex.exec(text)) !== null) {
    const startPos = document.positionAt(match.index);
    const endPos = document.positionAt(match.index + match[0].length);
    edits.push({
      range: { start: startPos, end: endPos },
      newText,
    });
  }

  return {
    changes: {
      [document.uri]: edits,
    },
  };
});

// Semantic tokens provider
connection.onSemanticTokens((params: SemanticTokensParams): SemanticTokens => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return { data: [] };
  }

  const cached = analysisCache.get(document.uri);
  if (!cached) {
    return { data: [] };
  }

  const builder = new SemanticTokensBuilder(semanticTokensLegend);
  const text = document.getText();

  // Collect all tokens and their types from the AST
  const tokens = collectTokens(cached.ast, text);

  for (const token of tokens) {
    const startPos = document.positionAt(token.offset);
    builder.push(startPos.line, startPos.character, token.text.length, token.typeIdx, token.modifierIdx);
  }

  return builder.build();
});

// Helper functions
function findSymbolAtOffset(ast: Module, offset: number): EncSymbol | null {
  // This is a simplified implementation
  // A full implementation would walk the AST and find the symbol at the given offset
  return null;
}

function findTokenRange(document: TextDocument, offset: number): Range | null {
  const text = document.getText();
  let start = offset;
  let end = offset;

  // Find start of token
  while (start > 0 && /\w/.test(text[start - 1])) {
    start--;
  }

  // Find end of token
  while (end < text.length && /\w/.test(text[end])) {
    end++;
  }

  if (start === end) {
    return null;
  }

  return {
    start: document.positionAt(start),
    end: document.positionAt(end),
  };
}

function collectTokens(ast: Module, text: string): Array<{ offset: number; text: string; typeIdx: number; modifierIdx: number }> {
  // This is a simplified implementation
  // A full implementation would walk the AST and collect semantic tokens
  return [];
}

function typeToString(type: Type): string {
  // Simplified type stringification
  return 'unknown';
}

// Start the server
connection.listen();
