// =============================================================================
// WAT Preview Provider
// Provides read-only WAT preview for Encantis files
// =============================================================================

import * as vscode from 'vscode';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parse } from '@encantis/compiler/parser';
import { typecheck } from '@encantis/compiler/checker';
import { moduleToWat, programToWatWithTests } from '@encantis/compiler/codegen';
import wabt from 'wabt';

export const WAT_SCHEME = 'encantis-wat';

export type WatDisplayMode = 'raw' | 'flat' | 'folded';
export type OptLevel = 'none' | 'O0' | 'O1' | 'O2' | 'O3' | 'Os' | 'Oz';

const OPT_LEVELS: OptLevel[] = ['none', 'O0', 'O1', 'O2', 'O3', 'Os', 'Oz'];

let wabtInstance: Awaited<ReturnType<typeof wabt>> | null = null;

async function getWabt() {
  if (!wabtInstance) wabtInstance = await wabt();
  return wabtInstance;
}

function findWasmOpt(): string | null {
  try {
    return require.resolve('binaryen/bin/wasm-opt');
  } catch {
    return null;
  }
}

function compileToWat(src: string, withTests: boolean): string {
  const parseResult = parse(src);
  if (parseResult.errors.length > 0) {
    return ';; Parse error:\n' + parseResult.errors.map(e => `;; ${e.shortMessage}`).join('\n');
  }
  if (!parseResult.module) return ';; No module';
  const checkResult = typecheck(parseResult.module, { source: src });
  if (checkResult.errors.length > 0) {
    return ';; Type errors:\n' + checkResult.errors.map(e => `;; ${e.message}`).join('\n');
  }
  if (!withTests) return moduleToWat(parseResult.module, checkResult);
  const p = 'preview.ents';
  const modules = new Map([[p, { path: p, source: src, module: parseResult.module }]]);
  const checkResults = new Map([[p, checkResult]]);
  return programToWatWithTests(modules, checkResults, p).wat;
}

function runWasmOpt(wasmOptPath: string, inputPath: string, level: OptLevel): Promise<Uint8Array> {
  const outPath = inputPath + '.opt';
  return new Promise((resolve, reject) => {
    execFile(wasmOptPath, [`-${level}`, inputPath, '-o', outPath, '--enable-multivalue', '--enable-bulk-memory'], (err) => {
      if (err) return reject(err);
      const fs = require('node:fs');
      const data = fs.readFileSync(outPath);
      fs.unlinkSync(outPath);
      resolve(new Uint8Array(data));
    });
  });
}

async function optimize(wasmBinary: Uint8Array, level: OptLevel): Promise<Uint8Array> {
  const wasmOptPath = findWasmOpt();
  if (!wasmOptPath) throw new Error('wasm-opt not found — install binaryen package');
  const tmpPath = path.join(tmpdir(), `encantis-opt-${Date.now()}.wasm`);
  await writeFile(tmpPath, wasmBinary);
  try {
    return await runWasmOpt(wasmOptPath, tmpPath, level);
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

async function renderWat(rawWat: string, mode: WatDisplayMode, optLevel: OptLevel): Promise<string> {
  if (rawWat.startsWith(';;')) return rawWat;
  if (mode === 'raw' && optLevel === 'none') return rawWat;

  const w = await getWabt();
  let binary: Uint8Array;
  try {
    const parsed = w.parseWat('preview.wat', rawWat, {
      simd: true, multi_value: true, bulk_memory: true,
    });
    binary = new Uint8Array(parsed.toBinary({ write_debug_names: true }).buffer);
  } catch (e) {
    return rawWat + '\n\n;; wabt parse error: ' + (e instanceof Error ? e.message : String(e));
  }

  if (optLevel !== 'none') {
    try {
      binary = await optimize(binary, optLevel);
    } catch (e) {
      return rawWat + '\n\n;; optimization error: ' + (e instanceof Error ? e.message : String(e));
    }
  }

  const mod = w.readWasm(binary, { readDebugNames: true });
  mod.generateNames();
  mod.applyNames();
  let text = mod.toText({ foldExprs: mode === 'folded', inlineExport: true, inlineImport: true });
  return tidyWat(text);
}

function tidyWat(wat: string): string {
  const lines = wat.split('\n');
  const typeSignatures = new Map<string, string>();
  const out: string[] = [];

  for (const line of lines) {
    const typeDef = line.match(/^\s*\(type (\$\w+) \(func(.*)\)\)/);
    if (typeDef) {
      typeSignatures.set(typeDef[1], typeDef[2].trim());
      continue;
    }
    let cleaned = line;
    const typeRef = cleaned.match(/\(type (\$\w+)\)/);
    if (typeRef) {
      const hasParams = /\(param\b/.test(cleaned) || /\(result\b/.test(cleaned);
      if (hasParams) {
        cleaned = cleaned.replace(/\s*\(type \$\w+\)/, '');
      } else {
        const sig = typeSignatures.get(typeRef[1]) ?? '';
        cleaned = cleaned.replace(`(type ${typeRef[1]})`, sig);
      }
    }
    out.push(cleaned);
  }
  return out.join('\n');
}

export class WatPreviewProvider implements vscode.TextDocumentContentProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  private _cache = new Map<string, string>();
  private _mode: WatDisplayMode = 'folded';
  private _optLevel: OptLevel = 'none';
  private _withTests = false;
  private _modeBar: vscode.StatusBarItem;
  private _optBar: vscode.StatusBarItem;
  private _testsBar: vscode.StatusBarItem;

  constructor() {
    this._modeBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102);
    this._modeBar.command = 'encantis.cycleWatMode';
    this._optBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
    this._optBar.command = 'encantis.cycleWatOpt';
    this._testsBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this._testsBar.command = 'encantis.toggleWatTests';
    this._updateStatusBar();
  }

  cycleMode(): void {
    const modes: WatDisplayMode[] = ['raw', 'flat', 'folded'];
    this._mode = modes[(modes.indexOf(this._mode) + 1) % modes.length];
    this._updateStatusBar();
    this._refreshAll();
  }

  cycleOpt(): void {
    this._optLevel = OPT_LEVELS[(OPT_LEVELS.indexOf(this._optLevel) + 1) % OPT_LEVELS.length];
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
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === WAT_SCHEME) {
        this._onDidChange.fire(doc.uri);
      }
    }
  }

  private _updateStatusBar(): void {
    this._modeBar.text = `WAT: ${this._mode}`;
    this._modeBar.tooltip = 'Click to cycle display mode (raw / flat / folded)';
    this._optBar.text = this._optLevel === 'none' ? 'opt: off' : `-${this._optLevel}`;
    this._optBar.tooltip = 'Click to cycle optimization (none / O0 / O1 / O2 / O3 / Os / Oz)';
    this._testsBar.text = this._withTests ? '$(beaker) tests' : '$(beaker)';
    this._testsBar.tooltip = this._withTests ? 'Tests included — click to hide' : 'Tests hidden — click to show';
  }

  showStatusBar(): void {
    this._modeBar.show();
    this._optBar.show();
    this._testsBar.show();
  }

  hideStatusBar(): void {
    this._modeBar.hide();
    this._optBar.hide();
    this._testsBar.hide();
  }

  static encodeUri(sourceUri: vscode.Uri): vscode.Uri {
    return vscode.Uri.parse(`${WAT_SCHEME}:${sourceUri.path}.wat?${encodeURIComponent(sourceUri.toString())}`);
  }

  static decodeUri(watUri: vscode.Uri): vscode.Uri {
    return vscode.Uri.parse(decodeURIComponent(watUri.query));
  }

  refresh(sourceUri: vscode.Uri): void {
    const watUri = WatPreviewProvider.encodeUri(sourceUri);
    this._cache.delete(watUri.toString());
    this._onDidChange.fire(watUri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string | Thenable<string> {
    const cacheKey = uri.toString();
    const cached = this._cache.get(cacheKey);
    if (cached) return cached;

    const sourceUri = WatPreviewProvider.decodeUri(uri);
    return vscode.workspace.openTextDocument(sourceUri).then(async doc => {
      const src = doc.getText();
      const rawWat = compileToWat(src, this._withTests);
      const result = await renderWat(rawWat, this._mode, this._optLevel);
      this._cache.set(cacheKey, result);
      return result;
    });
  }

  dispose(): void {
    this._onDidChange.dispose();
    this._modeBar.dispose();
    this._optBar.dispose();
    this._testsBar.dispose();
    this._cache.clear();
  }
}
