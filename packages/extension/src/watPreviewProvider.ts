// =============================================================================
// WAT Preview Provider
// Provides read-only WAT preview for Encantis files
// =============================================================================

import * as vscode from 'vscode';

// Compiler disabled until parser is updated to match grammar spec
// import { compile } from './server/compile';
function compile(_src: string): string {
  return ';; WAT preview disabled - parser is being updated to match grammar spec\n;; See docs/grammar.md for the current language specification';
}

export const WAT_SCHEME = 'encantis-wat';

export class WatPreviewProvider implements vscode.TextDocumentContentProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  private _cache = new Map<string, string>();

  /**
   * Encode a source URI into a WAT preview URI.
   * Format: encantis-wat:/path/to/file.ents.wat?<encoded-source-uri>
   */
  static encodeUri(sourceUri: vscode.Uri): vscode.Uri {
    return vscode.Uri.parse(`${WAT_SCHEME}:${sourceUri.path}.wat?${encodeURIComponent(sourceUri.toString())}`);
  }

  /**
   * Decode a WAT preview URI back to the source URI.
   */
  static decodeUri(watUri: vscode.Uri): vscode.Uri {
    return vscode.Uri.parse(decodeURIComponent(watUri.query));
  }

  /**
   * Refresh the WAT preview when source changes.
   */
  refresh(sourceUri: vscode.Uri): void {
    const watUri = WatPreviewProvider.encodeUri(sourceUri);
    this._cache.delete(watUri.toString());
    this._onDidChange.fire(watUri);
  }

  /**
   * TextDocumentContentProvider implementation.
   * Called when VS Code needs the content of a WAT preview document.
   */
  provideTextDocumentContent(uri: vscode.Uri): string | Thenable<string> {
    const cacheKey = uri.toString();
    const cached = this._cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const sourceUri = WatPreviewProvider.decodeUri(uri);
    return vscode.workspace.openTextDocument(sourceUri).then(doc => {
      const src = doc.getText();
      const wat = compile(src);
      this._cache.set(cacheKey, wat);
      return wat;
    });
  }

  dispose(): void {
    this._onDidChange.dispose();
    this._cache.clear();
  }
}
