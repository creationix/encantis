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
  console.log('Encantis extension activated!');

  // -------------------------------------------------------------------------
  // Language Server
  // -------------------------------------------------------------------------

  const serverModule = context.asAbsolutePath(path.join('dist', 'node', 'server', 'lsp.js'));
  const serverOptions: ServerOptions = {
    run: {
      module: serverModule,
      transport: TransportKind.stdio,
    },
    debug: {
      module: serverModule,
      transport: TransportKind.stdio,
      options: { execArgv: ['--inspect=6009'] },
    },
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

  const providerRegistration = vscode.workspace.registerTextDocumentContentProvider(
    WAT_SCHEME,
    watProvider
  );

  const openPreviewCommand = vscode.commands.registerCommand(
    'encantis.openWatPreview',
    () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'encantis') {
        vscode.window.showErrorMessage('Open an Encantis (.ents) file first');
        return;
      }

      const watUri = WatPreviewProvider.encodeUri(editor.document.uri);
      watProvider.showStatusBar();
      vscode.workspace.openTextDocument(watUri).then(doc => {
        vscode.window.showTextDocument(doc, { preview: false });
      });
    }
  );

  const openPreviewSideCommand = vscode.commands.registerCommand(
    'encantis.openWatPreviewSide',
    () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'encantis') {
        vscode.window.showErrorMessage('Open an Encantis (.ents) file first');
        return;
      }

      const watUri = WatPreviewProvider.encodeUri(editor.document.uri);
      watProvider.showStatusBar();
      vscode.workspace.openTextDocument(watUri).then(doc => {
        vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.Beside,
          preview: false,
          preserveFocus: true,
        });
      });
    }
  );

  const cycleModeCommand = vscode.commands.registerCommand(
    'encantis.cycleWatMode',
    () => watProvider.cycleMode()
  );

  const cycleOptCommand = vscode.commands.registerCommand(
    'encantis.cycleWatOpt',
    () => watProvider.cycleOpt()
  );

  const toggleTestsCommand = vscode.commands.registerCommand(
    'encantis.toggleWatTests',
    () => watProvider.toggleTests()
  );

  const changeSubscription = vscode.workspace.onDidChangeTextDocument(e => {
    if (e.document.languageId === 'encantis') {
      watProvider.refresh(e.document.uri);
    }
  });

  const closeSubscription = vscode.workspace.onDidCloseTextDocument(doc => {
    if (doc.uri.scheme === WAT_SCHEME) {
      const hasWatDocs = vscode.workspace.textDocuments.some(
        d => d.uri.scheme === WAT_SCHEME && d !== doc
      );
      if (!hasWatDocs) watProvider.hideStatusBar();
    }
  });

  context.subscriptions.push(
    watProvider,
    providerRegistration,
    openPreviewCommand,
    openPreviewSideCommand,
    cycleModeCommand,
    cycleOptCommand,
    toggleTestsCommand,
    changeSubscription,
    closeSubscription
  );
}

export function deactivate(): void {
  if (client) {
    client.stop();
  }
}
