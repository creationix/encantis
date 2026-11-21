// =============================================================================
// Encantis VS Code Web Extension
// Provides syntax highlighting, LSP, and WAT preview for .ents files
// =============================================================================

import * as vscode from 'vscode';
import { LanguageClient, type LanguageClientOptions } from 'vscode-languageclient/browser';

import { registerWatPreview } from '../watPreviewProvider';

let client: LanguageClient;

export function activate(context: vscode.ExtensionContext): void {
  // -------------------------------------------------------------------------
  // Language Server (WebWorker-based)
  // -------------------------------------------------------------------------

  const serverMain = vscode.Uri.joinPath(context.extensionUri, 'dist/web/server.js');
  const worker = new Worker(serverMain.toString(true));

  // Every document of the language: in a web editor files are not file:
  // URIs (vscode-vfs: on github.dev, vscode-test-web: under test).
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ language: 'encantis' }],
  };

  client = new LanguageClient('encantisLanguageServer', 'Encantis Language Server', clientOptions, worker);
  // The server, in a worker, has no file system: it asks for the files a
  // document imports, which are read through the workspace's.
  client.onRequest('encantis/readFile', async (uri: string): Promise<string | null> => {
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.parse(uri)));
    } catch {
      return null;
    }
  });
  // The workspace's .ents files, for the server's Go to Symbol in Workspace
  client.onRequest('encantis/findFiles', async (): Promise<string[]> => {
    const files = await vscode.workspace.findFiles('**/*.ents', '**/node_modules/**');
    return files.map((uri) => uri.toString());
  });
  client.start();

  // -------------------------------------------------------------------------
  // WAT Preview Feature (not optimized: binaryen is for the desktop)
  // -------------------------------------------------------------------------

  registerWatPreview(context);
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
