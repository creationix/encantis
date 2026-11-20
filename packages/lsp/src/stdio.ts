// The language server over stdin and stdout, for an editor or an agent that
// starts it as a command (`encantis lsp`) rather than as VS Code's extension.
// It reads what it is not given from disk: the files a document imports,
// and the workspace's .ents files, which it finds in the folders the client
// names when it starts.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { pathFor, startServer, uriOf } from './serve';

// More files than a workspace of source has: past this many, the rest are
// not looked for.
const MOST_FILES = 10000;

export function serveStdio(): void {
  // stdout carries the protocol, so what is logged goes to stderr, which a
  // client keeps as the server's log.
  const log = (...args: unknown[]) => console.error(...args);
  console.log = log;
  console.info = log;
  console.debug = log;
  console.warn = log;
  const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
  startServer(connection, {
    readFile: (path) => readFile(path, 'utf8').catch(() => null),
    findFiles: sourceFiles,
  });
}

// The URIs of the .ents files in the folders (file: URIs) and the folders in
// them, except hidden folders (.git) and node_modules. Links are not
// followed, so a link to a folder that holds it ends no walk.
export async function sourceFiles(folders: string[]): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (found.length >= MOST_FILES) return;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith('.ents')) found.push(uriOf(path));
    }
  };
  for (const folder of folders) {
    const dir = folder.startsWith('file:') ? pathFor(folder) : null;
    if (dir) await walk(dir);
  }
  return found;
}
