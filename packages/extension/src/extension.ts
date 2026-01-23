// =============================================================================
// Encantis VS Code Extension
// Provides syntax highlighting, LSP, and WAT preview for .ents files
// =============================================================================

import * as path from 'node:path';
import type { ExtensionContext } from 'vscode';
import * as vscode from 'vscode';
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';

import { WAT_SCHEME, WatPreviewProvider } from './watPreviewProvider';

let client: LanguageClient;

export function activate(context: ExtensionContext): void {
  // -------------------------------------------------------------------------
  // Language Server
  // -------------------------------------------------------------------------

  const serverModule = context.asAbsolutePath(path.join('out', 'server', 'lsp.js'));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'encantis' }],
  };

  client = new LanguageClient(
    'encantisLanguageServer',
    'Encantis Language Server',
    serverOptions,
    clientOptions
  );

  client.start();

  // -------------------------------------------------------------------------
  // WAT Preview Feature
  // -------------------------------------------------------------------------

  const watProvider = new WatPreviewProvider();

  // Register content provider for 'encantis-wat' scheme
  const providerRegistration = vscode.workspace.registerTextDocumentContentProvider(
    WAT_SCHEME,
    watProvider
  );

  // Command: Open WAT Preview (in new tab)
  const openPreviewCommand = vscode.commands.registerCommand(
    'encantis.openWatPreview',
    () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'encantis') {
        vscode.window.showErrorMessage('Open an Encantis (.ents) file first');
        return;
      }

      const watUri = WatPreviewProvider.encodeUri(editor.document.uri);
      vscode.workspace.openTextDocument(watUri).then(doc => {
        vscode.window.showTextDocument(doc, { preview: false });
      });
    }
  );

  // Command: Open WAT Preview to Side (split view)
  const openPreviewSideCommand = vscode.commands.registerCommand(
    'encantis.openWatPreviewSide',
    () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'encantis') {
        vscode.window.showErrorMessage('Open an Encantis (.ents) file first');
        return;
      }

      const watUri = WatPreviewProvider.encodeUri(editor.document.uri);
      vscode.workspace.openTextDocument(watUri).then(doc => {
        vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.Beside,
          preview: false,
          preserveFocus: true,
        });
      });
    }
  );

  // Auto-refresh preview when source changes
  const changeSubscription = vscode.workspace.onDidChangeTextDocument(e => {
    if (e.document.languageId === 'encantis') {
      watProvider.refresh(e.document.uri);
    }
  });

  context.subscriptions.push(
    watProvider,
    providerRegistration,
    openPreviewCommand,
    openPreviewSideCommand,
    changeSubscription
  );
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
