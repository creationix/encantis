// Encantis language server, desktop (Node) entry point.
import { readFile } from 'node:fs/promises';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { startServer } from './serve';

// A document's imports are read from disk where they are not open. The
// workspace's files are found by the editor (encantis/findFiles).
const connection = createConnection(ProposedFeatures.all);
startServer(connection, {
  readFile: (path) => readFile(path, 'utf8').catch(() => null),
  findFiles: () => connection.sendRequest<string[]>('encantis/findFiles'),
});
console.error('Encantis Language Server started');
