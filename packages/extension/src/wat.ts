// =============================================================================
// WAT for the preview: a program compiled as `encantis compile` compiles it,
// shown as the compiler wrote it or as wabt reads it back (flat or folded),
// optionally optimized as `encantis wasm -O` or `--release` optimizes it.
// Nothing here needs Node or VS Code: the desktop and web extensions share it,
// and each gives it how files are read and (desktop only) how to optimize.
// =============================================================================

import { typecheckProgram } from '@encantis/compiler/checker';
import { NestingLimitError, programToWat, programToWatWithTests } from '@encantis/compiler/codegen';
import { loadModule } from '@encantis/compiler/loader';
import wabt from 'wabt';

export type WatDisplayMode = 'raw' | 'flat' | 'folded';

// The CLI's optimizations: `wasm -O` (binaryen -Oz) and `wasm --release`
// (the smallest of several tries)
export type OptLevel = 'none' | 'optimize' | 'release';

export type Optimize = (wasm: Uint8Array, level: Exclude<OptLevel, 'none'>) => Promise<Uint8Array>;

// Reads a source file by the path the loader names it by: its text, or null.
export type ReadFile = (path: string) => Promise<string | null>;

// What a preview shows: its text, and the size of the module the CLI would
// write for it (none where it does not compile)
export interface RenderedWat {
  text: string;
  wasmSize: number | null;
}

// The program a file is the entry of, compiled to WAT, or why it is not: the
// text of a WAT comment.
export async function compileToWat(path: string, readFile: ReadFile, withTests: boolean): Promise<{ wat: string } | { error: string }> {
  const load = await loadModule(path, { includeTests: withTests, readFile });
  if (load.errors.length > 0) {
    return { error: load.errors.map(e => `;; ${e.filePath}: ${firstLine(e.message)}`).join('\n') };
  }
  const check = typecheckProgram(load.modules, load.entry.path, { includeTests: withTests });
  if (check.errors.length > 0) {
    const errors: string[] = [];
    for (const [, result] of check.results) {
      for (const e of result.errors) errors.push(`;; ${firstLine(e.message)}`);
    }
    return { error: `;; Type errors:\n${errors.join('\n')}` };
  }
  // A function nested deeper than wabt reads is an error of its own (2.12):
  // the WAT is not handed to wabt, which could fail or never finish on it.
  try {
    const wat = withTests
      ? programToWatWithTests(load.modules, check.results, load.entry.path).wat
      : programToWat(load.modules, check.results, load.entry.path);
    return { wat };
  } catch (e) {
    if (e instanceof NestingLimitError) return { error: `;; ${firstLine(e.message)}` };
    throw e;
  }
}

function firstLine(message: string): string {
  return message.split('\n')[0];
}

let wabtInstance: ReturnType<typeof wabt> | null = null;

function getWabt(): ReturnType<typeof wabt> {
  wabtInstance ??= wabt();
  return wabtInstance;
}

type Wabt = Awaited<ReturnType<typeof wabt>>;

// The compiler's WAT as wabt reads it: with SIMD, multi-value and bulk
// memory, as the CLI reads it.
function assemble(w: Wabt, wat: string, names: boolean): Uint8Array {
  const module = w.parseWat('preview.wat', wat, { simd: true, multi_value: true, bulk_memory: true });
  try {
    module.validate();
    return new Uint8Array(module.toBinary({ write_debug_names: names }).buffer);
  } finally {
    module.destroy();
  }
}

export async function renderWat(
  rawWat: string,
  mode: WatDisplayMode,
  optLevel: OptLevel,
  optimize?: Optimize,
): Promise<RenderedWat> {
  const w = await getWabt();
  // The size is of the module `encantis wasm` writes, which has no names.
  let binary: Uint8Array;
  try {
    binary = assemble(w, rawWat, false);
  } catch (e) {
    return { text: `${rawWat}\n\n;; wabt: ${messageOf(e)}`, wasmSize: null };
  }

  if (optLevel !== 'none' && optimize) {
    try {
      binary = await optimize(binary, optLevel);
    } catch (e) {
      return { text: `${rawWat}\n\n;; optimization error: ${messageOf(e)}`, wasmSize: null };
    }
  } else if (mode === 'raw') {
    return { text: rawWat, wasmSize: binary.length };
  }

  const wasmSize = binary.length;
  // Unoptimized, the module is shown with the compiler's names. binaryen
  // keeps none, and wabt makes up names for what has none.
  const shown = optLevel === 'none' || !optimize ? assemble(w, rawWat, true) : binary;
  const mod = w.readWasm(shown, { readDebugNames: true, simd: true, multi_value: true, bulk_memory: true });
  try {
    mod.generateNames();
    mod.applyNames();
    const text = mod.toText({ foldExprs: mode === 'folded', inlineExport: true });
    return { text: tidyWat(text, rawWat), wasmSize };
  } finally {
    mod.destroy();
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// wabt's text, made closer to the compiler's: function types written where
// they are used, and the comments the compiler gives data segments kept.
export function tidyWat(wat: string, rawWat?: string): string {
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
      if (comment) cleaned += `  ${comment}`;
    }
    out.push(cleaned);
  }

  // Add zero-byte entries that wabt omits entirely
  for (const [, comment] of dataComments) {
    if (comment.includes('zero bytes')) {
      const alreadyPresent = out.some(l => l.includes(comment));
      if (!alreadyPresent) out.splice(out.length - 1, 0, `  ${comment}`);
    }
  }

  return out.join('\n');
}
