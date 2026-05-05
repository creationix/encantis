// =============================================================================
// WAT Preview Provider
// Provides read-only WAT preview for Encantis files
// =============================================================================

import * as vscode from 'vscode';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from '@encantis/compiler/parser';
import { typecheckProgram } from '@encantis/compiler/checker';
import { programToWat, programToWatWithTests } from '@encantis/compiler/codegen';
import { isSourceImport, resolveModulePath, type LoadedModule } from '@encantis/compiler/loader';
import wabt from 'wabt';

export const WAT_SCHEME = 'encantis-wat';

export type WatDisplayMode = 'raw' | 'flat' | 'folded';
export type OptLevel = 'none' | 'Oz' | 'O3';

const OPT_LEVELS: OptLevel[] = ['none', 'Oz', 'O3'];

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

function loadModuleSync(filePath: string, src: string, modules: Map<string, LoadedModule>, visited: Set<string>, includeTests: boolean): string | null {
  if (visited.has(filePath)) return null;
  visited.add(filePath);

  const result = parse(src, { filePath });
  if (result.errors.length > 0) return result.errors.map(e => `;; ${e.shortMessage}`).join('\n');
  if (!result.module) return ';; No module';

  modules.set(filePath, { path: filePath, source: src, module: result.module });

  for (const decl of result.module.decls) {
    const imports = decl.kind === 'ImportDecl' ? [decl]
      : (includeTests && decl.kind === 'TestDecl') ? decl.children.filter((c): c is import('@encantis/compiler/ast').ImportDecl => c.kind === 'ImportDecl')
      : [];
    for (const imp of imports) {
      if (!isSourceImport(imp.module)) continue;
      const depPath = resolveModulePath(imp.module, filePath);
      if (modules.has(depPath)) continue;
      if (!existsSync(depPath)) return `;; Module not found: ${imp.module}`;
      const depSrc = readFileSync(depPath, 'utf-8');
      const err = loadModuleSync(depPath, depSrc, modules, visited, includeTests);
      if (err) return err;
    }
  }
  return null;
}

function compileToWat(src: string, filePath: string, withTests: boolean): string {
  const modules = new Map<string, LoadedModule>();
  const err = loadModuleSync(filePath, src, modules, new Set(), withTests);
  if (err) return err;

  const check = typecheckProgram(modules, filePath, { includeTests: withTests });
  if (check.errors.length > 0) {
    const errors: string[] = [];
    for (const [, result] of check.results) {
      for (const e of result.errors) errors.push(`;; ${e.message}`);
    }
    return ';; Type errors:\n' + errors.join('\n');
  }

  if (withTests) return programToWatWithTests(modules, check.results, filePath).wat;
  return programToWat(modules, check.results, filePath);
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

async function renderWat(rawWat: string, mode: WatDisplayMode, optLevel: OptLevel): Promise<{ text: string; wasmSize: number | null }> {
  if (rawWat.startsWith(';;')) return { text: rawWat, wasmSize: null };

  const w = await getWabt();
  let binary: Uint8Array;
  try {
    const parsed = w.parseWat('preview.wat', rawWat, {
      simd: true, multi_value: true, bulk_memory: true,
    });
    binary = new Uint8Array(parsed.toBinary({ write_debug_names: true }).buffer);
  } catch (e) {
    return { text: rawWat + '\n\n;; wabt parse error: ' + (e instanceof Error ? e.message : String(e)), wasmSize: null };
  }

  if (optLevel !== 'none') {
    try {
      binary = await optimize(binary, optLevel);
    } catch (e) {
      return { text: rawWat + '\n\n;; optimization error: ' + (e instanceof Error ? e.message : String(e)), wasmSize: null };
    }
  }

  const wasmSize = binary.length;

  if (mode === 'raw' && optLevel === 'none') return { text: rawWat, wasmSize };

  const mod = w.readWasm(binary, { readDebugNames: true });
  mod.generateNames();
  mod.applyNames();
  const text = mod.toText({ foldExprs: mode === 'folded', inlineExport: true, inlineImport: true });
  return { text: tidyWat(text, rawWat), wasmSize };
}

function tidyWat(wat: string, rawWat?: string): string {
  // Extract data segment comments from raw compiler output
  const dataComments = new Map<string, string>();
  if (rawWat) {
    for (const line of rawWat.split('\n')) {
      const m = line.match(/\(data \(i32\.const (\d+)\).*\)\s*(;; .*)$/);
      if (m) dataComments.set(m[1], m[2]);
      const zeroM = line.match(/;; (\d+) zero bytes at (0x[0-9a-f]+)(.*)/);
      if (zeroM) dataComments.set(String(parseInt(zeroM[2], 16)), line.trim());
    }
  }

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
    // Strip auto-generated data segment names ($d0, $d1, ...)
    cleaned = cleaned.replace(/\(data \$d\d+ /, '(data ');
    // Re-inject data segment comments
    const dataM = cleaned.match(/\(data \(i32\.const (\d+)\)/);
    if (dataM) {
      const comment = dataComments.get(dataM[1]);
      if (comment) cleaned += '  ' + comment;
    }
    out.push(cleaned);
  }

  // Add zero-byte entries that wabt omits entirely
  for (const [, comment] of dataComments) {
    if (comment.includes('zero bytes')) {
      const alreadyPresent = out.some(l => l.includes(comment));
      if (!alreadyPresent) out.splice(out.length - 1, 0, '  ' + comment);
    }
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
  private _sizeBar: vscode.StatusBarItem;

  constructor() {
    this._modeBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 103);
    this._modeBar.command = 'encantis.cycleWatMode';
    this._optBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102);
    this._optBar.command = 'encantis.cycleWatOpt';
    this._testsBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
    this._testsBar.command = 'encantis.toggleWatTests';
    this._sizeBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this._updateStatusBar();
  }

  cycleMode(): void {
    const modes: WatDisplayMode[] = this._optLevel === 'none' ? ['raw', 'flat', 'folded'] : ['flat', 'folded'];
    this._mode = modes[(modes.indexOf(this._mode) + 1) % modes.length];
    this._updateStatusBar();
    this._refreshAll();
  }

  cycleOpt(): void {
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
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === WAT_SCHEME) {
        this._onDidChange.fire(doc.uri);
      }
    }
  }

  private _updateStatusBar(wasmSize?: number | null): void {
    this._modeBar.text = `WAT: ${this._mode}`;
    this._modeBar.tooltip = 'Click to cycle display mode (raw / flat / folded)';
    const optLabels: Record<OptLevel, string> = { none: 'opt: off', Oz: 'opt: small', O3: 'opt: fast' };
    this._optBar.text = optLabels[this._optLevel];
    this._optBar.tooltip = 'Click to cycle optimization (off / small -Oz / fast -O3)';
    this._testsBar.text = this._withTests ? '$(beaker) tests' : '$(beaker)';
    this._testsBar.tooltip = this._withTests ? 'Tests included — click to hide' : 'Tests hidden — click to show';
    if (wasmSize != null) {
      this._sizeBar.text = wasmSize < 1024 ? `${wasmSize} B` : `${(wasmSize / 1024).toFixed(1)} KB`;
      this._sizeBar.tooltip = `WASM binary size: ${wasmSize.toLocaleString()} bytes`;
    }
  }

  showStatusBar(): void {
    this._modeBar.show();
    this._optBar.show();
    this._testsBar.show();
    this._sizeBar.show();
  }

  hideStatusBar(): void {
    this._modeBar.hide();
    this._optBar.hide();
    this._testsBar.hide();
    this._sizeBar.hide();
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
      const rawWat = compileToWat(src, sourceUri.fsPath, this._withTests);
      const { text, wasmSize } = await renderWat(rawWat, this._mode, this._optLevel);
      this._cache.set(cacheKey, text);
      this._updateStatusBar(wasmSize);
      return text;
    });
  }

  dispose(): void {
    this._onDidChange.dispose();
    this._modeBar.dispose();
    this._optBar.dispose();
    this._testsBar.dispose();
    this._sizeBar.dispose();
    this._cache.clear();
  }
}
