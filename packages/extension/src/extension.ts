// =============================================================================
// Encantis VS Code Extension
// Provides syntax highlighting, LSP, and WAT preview for .ents files
// =============================================================================

import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExtensionContext } from 'vscode';
import * as vscode from 'vscode';
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';

import { type Binaryen, optimizeWasm } from '@encantis/cli/src/wasm';
import { registerWatPreview } from './watPreviewProvider';

let client: LanguageClient;

export function activate(context: ExtensionContext): void {
  // -------------------------------------------------------------------------
  // Language Server
  // -------------------------------------------------------------------------

  const serverModule = context.asAbsolutePath(path.join('dist', 'node', 'server.js'));
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
    documentSelector: [
      { scheme: 'file', language: 'encantis' },
      { scheme: 'untitled', language: 'encantis' },
    ],
  };

  client = new LanguageClient(
    'encantisLanguageServer',
    'Encantis Language Server',
    serverOptions,
    clientOptions
  );

  // The workspace's .ents files, for the server's Go to Symbol in Workspace
  client.onRequest('encantis/findFiles', async (): Promise<string[]> => {
    const files = await vscode.workspace.findFiles('**/*.ents', '**/node_modules/**');
    return files.map((uri) => uri.toString());
  });
  client.start();

  // -------------------------------------------------------------------------
  // WAT Preview Feature
  // -------------------------------------------------------------------------

  // binaryen is a module with a top-level await, which the CommonJS bundle
  // cannot hold: a copy of the CLI's pinned binaryen is shipped beside it
  // and imported the first time the preview is optimized.
  const binaryenUrl = pathToFileURL(context.asAbsolutePath(path.join('dist', 'node', 'binaryen.mjs'))).href;
  let binaryen: Promise<Binaryen> | undefined;
  const loadBinaryen = () => {
    binaryen ??= import(binaryenUrl).then((m: { default: Binaryen }) => m.default);
    return binaryen;
  };
  registerWatPreview(context, (wasm, level) => optimizeWasm(wasm, level, loadBinaryen));
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
