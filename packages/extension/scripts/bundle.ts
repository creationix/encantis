// Bundles the extension into dist/: the desktop extension and its language
// server (Node, CommonJS) in dist/node, the web extension and its worker in
// dist/web. Run with `bun scripts/bundle.ts [node|web]` (both by default).
//
// binaryen, which the desktop WAT preview optimizes with, is a module with a
// top-level await, which a CommonJS bundle cannot hold. Its one file is copied
// beside the bundle as dist/node/binaryen.mjs and imported from there; only
// the bare import of `binaryen` is left out of the bundle (its package.json,
// which names the version, is bundled).

import type { BunPlugin } from 'bun';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const root = join(import.meta.dir, '..');
const targets = process.argv.slice(2);
const want = (target: string) => targets.length === 0 || targets.includes(target);

const binaryenExternal: BunPlugin = {
  name: 'binaryen-external',
  setup(build) {
    build.onResolve({ filter: /^binaryen$/ }, () => ({ path: 'binaryen', external: true }));
  },
};

async function bundle(name: string, options: Parameters<typeof Bun.build>[0]): Promise<void> {
  const result = await Bun.build(options);
  for (const log of result.logs) console.error(log);
  if (!result.success) {
    console.error(`${name}: bundle failed`);
    process.exit(1);
  }
  for (const output of result.outputs) {
    console.log(`${name}: ${output.path.slice(root.length + 1)} ${(output.size / 1024 / 1024).toFixed(2)} MB`);
  }
}

if (want('node')) {
  const outdir = join(root, 'dist', 'node');
  rmSync(outdir, { recursive: true, force: true });
  await bundle('node', {
    entrypoints: [join(root, 'src/extension.ts'), join(root, 'src/server.ts')],
    root: join(root, 'src'),
    outdir,
    target: 'node',
    format: 'cjs',
    external: ['vscode'],
    plugins: [binaryenExternal],
  });
  const binaryen = createRequire(join(root, 'package.json')).resolve('binaryen');
  mkdirSync(outdir, { recursive: true });
  copyFileSync(binaryen, join(outdir, 'binaryen.mjs'));
  copyFileSync(join(dirname(binaryen), 'LICENSE'), join(outdir, 'binaryen.LICENSE'));
  console.log('node: dist/node/binaryen.mjs (copied)');
}

// The web extension host evaluates the extension as CommonJS (it provides
// `require('vscode')`), and the language server runs as a classic worker.
if (want('web')) {
  const outdir = join(root, 'dist', 'web');
  rmSync(outdir, { recursive: true, force: true });
  await bundle('web', {
    entrypoints: [join(root, 'src/web/extension.ts')],
    outdir,
    target: 'browser',
    format: 'cjs',
    minify: true,
    external: ['vscode'],
  });
  await bundle('web', {
    entrypoints: [join(root, 'src/web/server.ts')],
    outdir,
    target: 'browser',
    format: 'iife',
    minify: true,
  });
}
