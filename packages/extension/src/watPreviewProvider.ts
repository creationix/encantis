// =============================================================================
// WAT Preview
// A read-only document beside an Encantis file with the WAT it compiles to.
// Shared by the desktop and web extensions; only the desktop one can optimize.
// =============================================================================

import * as vscode from 'vscode';
import { compileToWat, type OptLevel, type Optimize, renderWat, type WatDisplayMode } from './wat';

export const WAT_SCHEME = 'encantis-wat';

const OPT_LEVELS: OptLevel[] = ['none', 'optimize', 'release'];

// How long a preview waits after an edit before it compiles again. Compiling
// (and optimizing) runs in the extension host: on each keystroke, a large
// program (examples/browser/lantern.ents) would hold it up to a second.
const REFRESH_DELAY_MS = 300;

// The path the loader names a source file by. A program on disk is loaded
// from file paths; one elsewhere (a web editor's virtual file system) from
// the paths of its URIs, and its files are found again beside it.
function pathOf(uri: vscode.Uri): string {
  return uri.scheme === 'file' ? uri.fsPath : uri.path;
}

function uriOf(path: string, entry: vscode.Uri): vscode.Uri {
  return entry.scheme === 'file' ? vscode.Uri.file(path) : entry.with({ path });
}

export class WatPreviewProvider implements vscode.TextDocumentContentProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  private _cache = new Map<string, string>();
  // The files each preview's program was read from, by the preview's URI:
  // a change to any of them changes the preview.
  private _programFiles = new Map<string, Set<string>>();
  // The size of each preview's module, and the previews waiting to refresh
  private _sizes = new Map<string, number | null>();
  private _pending = new Map<string, ReturnType<typeof setTimeout>>();
  private _mode: WatDisplayMode = 'folded';
  private _optLevel: OptLevel = 'none';
  private _withTests = false;
  private _modeBar: vscode.StatusBarItem;
  private _optBar: vscode.StatusBarItem;
  private _testsBar: vscode.StatusBarItem;
  private _sizeBar: vscode.StatusBarItem;

  // Without `optimize` (the web extension) the preview is never optimized.
  constructor(private readonly _optimize?: Optimize) {
    this._modeBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 103);
    this._modeBar.command = 'encantis.cycleWatMode';
    this._optBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102);
    this._optBar.command = 'encantis.cycleWatOpt';
    this._testsBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
    this._testsBar.command = 'encantis.toggleWatTests';
    this._sizeBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this._updateStatusBar();
    this.syncStatusBar();
  }

  cycleMode(): void {
    const modes: WatDisplayMode[] = this._optLevel === 'none' ? ['raw', 'flat', 'folded'] : ['flat', 'folded'];
    this._mode = modes[(modes.indexOf(this._mode) + 1) % modes.length];
    this._updateStatusBar();
    this._refreshAll();
  }

  cycleOpt(): void {
    if (!this._optimize) {
      vscode.window.showInformationMessage('Optimizing the WAT preview needs the desktop version of VS Code.');
      return;
    }
    this._optLevel = OPT_LEVELS[(OPT_LEVELS.indexOf(this._optLevel) + 1) % OPT_LEVELS.length];
    if (this._optLevel !== 'none' && this._mode === 'raw') this._mode = 'folded';
    this._updateStatusBar();
    this._refreshAll();
  }

  toggleTests(): void {
    this._withTests = !this._withTests;
    this._updateStatusBar();
    this._refreshAll();
  }

  private _refreshAll(): void {
    this._cache.clear();
    for (const timer of this._pending.values()) clearTimeout(timer);
    this._pending.clear();
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === WAT_SCHEME) {
        this._onDidChange.fire(doc.uri);
      }
    }
  }

  private _updateStatusBar(): void {
    this._modeBar.text = `WAT: ${this._mode}`;
    this._modeBar.tooltip = 'Click to cycle display mode (raw / flat / folded)';
    const optLabels: Record<OptLevel, string> = { none: 'opt: off', optimize: 'opt: -O', release: 'opt: release' };
    this._optBar.text = optLabels[this._optLevel];
    this._optBar.tooltip = 'Click to cycle optimization (off / -O as `encantis wasm -O` / release as `encantis wasm --release`)';
    this._testsBar.text = this._withTests ? '$(beaker) tests' : '$(beaker)';
    this._testsBar.tooltip = this._withTests ? 'Tests included — click to hide' : 'Tests hidden — click to show';
  }

  // The preview in front: the active editor, the preview of the active
  // editor's file where it is visible, or else a visible one
  private _shownPreview(): vscode.Uri | undefined {
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active?.scheme === WAT_SCHEME) return active;
    const visible = vscode.window.visibleTextEditors.map(e => e.document.uri).filter(uri => uri.scheme === WAT_SCHEME);
    const own = active && WatPreviewProvider.encodeUri(active).toString();
    return visible.find(uri => uri.toString() === own) ?? visible[0];
  }

  // The status bar is shown while a preview is visible, with the size of the
  // module of the preview in front. (VS Code tells of a closed preview only
  // when it lets go of the document, minutes later.)
  syncStatusBar(): void {
    const shown = this._shownPreview();
    const items = [this._modeBar, this._optBar, this._testsBar, this._sizeBar];
    if (!shown) {
      for (const item of items) item.hide();
      return;
    }
    const size = this._sizes.get(shown.toString());
    if (size === undefined || size === null) {
      this._sizeBar.text = '';
      this._sizeBar.tooltip = undefined;
    } else {
      this._sizeBar.text = size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`;
      this._sizeBar.tooltip = `WASM binary size: ${size.toLocaleString()} bytes`;
    }
    for (const item of items) {
      if (item !== this._optBar || this._optimize) item.show();
    }
  }

  // The source's path and URI are kept as they are: a # or a ? in a file's
  // name is part of the name.
  static encodeUri(sourceUri: vscode.Uri): vscode.Uri {
    return vscode.Uri.from({ scheme: WAT_SCHEME, path: `${sourceUri.path}.wat`, query: sourceUri.toString() });
  }

  static decodeUri(watUri: vscode.Uri): vscode.Uri {
    return vscode.Uri.parse(watUri.query);
  }

  // A source file changed: the previews whose programs have it change, once
  // the edits stop for a moment.
  refresh(sourceUri: vscode.Uri): void {
    const changed = sourceUri.toString();
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== WAT_SCHEME) continue;
      const key = doc.uri.toString();
      const files = this._programFiles.get(key);
      if (WatPreviewProvider.decodeUri(doc.uri).toString() !== changed && !files?.has(changed)) continue;
      clearTimeout(this._pending.get(key));
      const uri = doc.uri;
      this._pending.set(
        key,
        setTimeout(() => {
          this._pending.delete(key);
          this._cache.delete(key);
          this._onDidChange.fire(uri);
        }, REFRESH_DELAY_MS),
      );
    }
  }

  provideTextDocumentContent(uri: vscode.Uri): string | Thenable<string> {
    const cacheKey = uri.toString();
    const cached = this._cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const sourceUri = WatPreviewProvider.decodeUri(uri);
    return this._render(sourceUri, cacheKey);
  }

  private async _render(sourceUri: vscode.Uri, cacheKey: string): Promise<string> {
    const files = new Set<string>();
    // A file is read from its open document where it has one, so that the
    // preview is of the text being edited, and else from where it is saved.
    const readFile = async (path: string): Promise<string | null> => {
      const uri = uriOf(path, sourceUri);
      files.add(uri.toString());
      const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
      if (open) return open.getText();
      try {
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      } catch {
        return null;
      }
    };
    const entry = await vscode.workspace.openTextDocument(sourceUri);
    const entryPath = pathOf(entry.uri);
    let text: string;
    let wasmSize: number | null = null;
    try {
      const compiled = await compileToWat(entryPath, path => (path === entryPath ? Promise.resolve(entry.getText()) : readFile(path)), this._withTests);
      if ('error' in compiled) {
        text = compiled.error;
      } else {
        ({ text, wasmSize } = await renderWat(compiled.wat, this._mode, this._optLevel, this._optimize));
      }
    } catch (e) {
      text = `;; Internal compiler error: ${e instanceof Error ? e.message : String(e)}`;
    }
    files.add(entry.uri.toString());
    this._programFiles.set(cacheKey, files);
    this._cache.set(cacheKey, text);
    this._sizes.set(cacheKey, wasmSize);
    this.syncStatusBar();
    return text;
  }

  // A preview was closed: what it was of is forgotten.
  forget(watUri: vscode.Uri): void {
    const key = watUri.toString();
    clearTimeout(this._pending.get(key));
    this._pending.delete(key);
    this._cache.delete(key);
    this._programFiles.delete(key);
    this._sizes.delete(key);
  }

  dispose(): void {
    this._onDidChange.dispose();
    this._modeBar.dispose();
    this._optBar.dispose();
    this._testsBar.dispose();
    this._sizeBar.dispose();
    for (const timer of this._pending.values()) clearTimeout(timer);
    this._pending.clear();
    this._cache.clear();
    this._programFiles.clear();
    this._sizes.clear();
  }
}

// The preview's commands and events, as both extensions register them
export function registerWatPreview(context: vscode.ExtensionContext, optimize?: Optimize): void {
  const watProvider = new WatPreviewProvider(optimize);

  const open = (beside: boolean) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'encantis') {
      vscode.window.showErrorMessage('Open an Encantis (.ents) file first');
      return;
    }
    const watUri = WatPreviewProvider.encodeUri(editor.document.uri);
    vscode.workspace.openTextDocument(watUri).then(doc => {
      vscode.window.showTextDocument(
        doc,
        beside ? { viewColumn: vscode.ViewColumn.Beside, preview: false, preserveFocus: true } : { preview: false },
      );
    });
  };

  context.subscriptions.push(
    watProvider,
    vscode.workspace.registerTextDocumentContentProvider(WAT_SCHEME, watProvider),
    vscode.commands.registerCommand('encantis.openWatPreview', () => open(false)),
    vscode.commands.registerCommand('encantis.openWatPreviewSide', () => open(true)),
    vscode.commands.registerCommand('encantis.cycleWatMode', () => watProvider.cycleMode()),
    vscode.commands.registerCommand('encantis.cycleWatOpt', () => watProvider.cycleOpt()),
    vscode.commands.registerCommand('encantis.toggleWatTests', () => watProvider.toggleTests()),
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.languageId === 'encantis') watProvider.refresh(e.document.uri);
    }),
    vscode.workspace.onDidCloseTextDocument(doc => {
      if (doc.uri.scheme === WAT_SCHEME) watProvider.forget(doc.uri);
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => watProvider.syncStatusBar()),
    vscode.window.onDidChangeActiveTextEditor(() => watProvider.syncStatusBar()),
  );
}
