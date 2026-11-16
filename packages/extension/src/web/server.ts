// Encantis language server, web (worker) entry point.
import { BrowserMessageReader, BrowserMessageWriter, createConnection } from 'vscode-languageserver/browser';
import { startServer } from '../server/serve';

declare const self: DedicatedWorkerGlobalScope;

startServer(createConnection(new BrowserMessageReader(self), new BrowserMessageWriter(self)));
