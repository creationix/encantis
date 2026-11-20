// Runs the extension, as a .vsix installs it, in VS Code, and test/vscode/
// runner.js inside it: desktop VS Code (@vscode/test-electron) or VS Code for
// the Web in Chromium (@vscode/test-web).
//
//   node packages/extension/test/run.mjs desktop <file.vsix> [version]
//   node packages/extension/test/run.mjs web <file.vsix>
//
// `version` is a VS Code version, `stable` by default: CI also runs the
// oldest the extension supports (engines.vscode). On Linux, desktop VS Code
// needs a display: run it under xvfb-run. The web run needs Playwright's
// Chromium: `bunx playwright install chromium`. VSCODE_TEST_CACHE is where
// VS Code is downloaded to (.vscode-test by default), and VSCODE_WEB_COMMIT
// a build of VS Code for the Web already there, to run with no download.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const [target, vsix, version = 'stable'] = process.argv.slice(2);
if (!['desktop', 'web'].includes(target) || !vsix) {
  console.error('usage: node packages/extension/test/run.mjs <desktop|web> <file.vsix> [version]');
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'encantis-vscode-'));

// The extension's folder, as installing the .vsix makes it
execFileSync('unzip', ['-q', resolve(vsix), '-d', join(work, 'vsix')]);
const extension = join(work, 'vsix', 'extension');

// VS Code for the Web runs a test runner it serves from the extension's own
// folder, so the runner is put there, for both.
mkdirSync(join(extension, 'encantis-test'));
const runner = join(extension, 'encantis-test', 'runner.js');
cpSync(join(here, 'vscode', 'runner.js'), runner);

// The files it is tried on
const workspace = join(work, 'workspace');
mkdirSync(workspace);
for (const file of ['main.ents', 'util.ents']) cpSync(join(repo, 'examples', 'modular', file), join(workspace, file));

const cache = process.env.VSCODE_TEST_CACHE;
try {
  if (target === 'desktop') {
    const { runTests } = await import('@vscode/test-electron');
    await runTests({
      version,
      extensionDevelopmentPath: extension,
      extensionTestsPath: runner,
      // Only this extension, in the workspace
      launchArgs: [workspace, '--disable-extensions'],
      ...(cache ? { cachePath: cache } : {}),
    });
  } else {
    const { runTests } = await import('@vscode/test-web');
    await runTests({
      browserType: 'chromium',
      headless: true,
      quality: 'stable',
      extensionDevelopmentPath: extension,
      extensionTestsPath: runner,
      folderPath: workspace,
      ...(cache ? { testRunnerDataDir: cache } : {}),
      ...(process.env.VSCODE_WEB_COMMIT ? { commit: process.env.VSCODE_WEB_COMMIT } : {}),
    });
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
