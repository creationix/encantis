// Encantis language server, entry point of VS Code's desktop extension. (An
// editor or an agent that starts it as a command runs `encantis lsp`.)
import { readFile } from 'node:fs/promises';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { startServer } from '@encantis/lsp/src/serve';

// A document's imports are read from disk where they are not open. The
// workspace's files are found by the editor (encantis/findFiles).
const connection = createConnection(ProposedFeatures.all);
startServer(connection, {
  readFile: (path) => readFile(path, 'utf8').catch(() => null),
  findFiles: () => connection.sendRequest<string[]>('encantis/findFiles'),
});
console.error('Encantis Language Server started');
