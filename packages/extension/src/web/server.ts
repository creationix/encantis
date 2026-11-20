// Encantis language server, web (worker) entry point.
import { BrowserMessageReader, BrowserMessageWriter, createConnection } from 'vscode-languageserver/browser';
import { startServer } from '../server/serve';

declare const self: DedicatedWorkerGlobalScope;

// A file a document imports, where it is not open, is read by the editor,
// which has the file system (the web extension answers encantis/readFile).
const connection = createConnection(new BrowserMessageReader(self), new BrowserMessageWriter(self));
startServer(connection, {
  readUri: (uri) => connection.sendRequest<string | null>('encantis/readFile', uri),
});
