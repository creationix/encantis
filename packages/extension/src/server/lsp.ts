// Encantis language server, desktop (Node) entry point.
import { readFile } from 'node:fs/promises';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { startServer } from './serve';

// A document's imports are read from disk where they are not open.
startServer(createConnection(ProposedFeatures.all), {
  readFile: (path) => readFile(path, 'utf8').catch(() => null),
});
console.error('Encantis Language Server started');
