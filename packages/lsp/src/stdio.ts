// The language server over stdin and stdout, for an editor or an agent that
// starts it as a command (`encantis lsp`) rather than as VS Code's extension.
// It reads what it is not given from disk: the files a document imports,
// and the workspace's .ents files, which it finds in the folders the client
// names when it starts.

import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { type FoundFiles, pathFor, startServer, uriOf } from './serve';

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
// followed, so a link to a folder that holds it ends no walk. Where the
// listing is not all of them, it says why: a folder it could not read, or
// more files than `most`, after which it stops.
export async function sourceFiles(folders: string[], most = MOST_FILES): Promise<FoundFiles> {
  const uris: string[] = [];
  let incomplete: string | undefined;
  let stopped = false;
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      incomplete ??= `${dir} could not be read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`;
      return;
    }
    for (const entry of entries) {
      if (stopped) return;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith('.ents')) {
        if (uris.length === most) {
          incomplete ??= `there are more than ${most} .ents files, and the rest were not looked for`;
          stopped = true;
          return;
        }
        uris.push(uriOf(path));
      }
    }
  };
  for (const folder of folders) {
    if (stopped) break;
    const dir = folder.startsWith('file:') ? pathFor(folder) : null;
    if (dir) await walk(dir);
    else incomplete ??= `${folder} is not a folder of this computer's`;
  }
  return incomplete ? { uris, incomplete } : { uris };
}
