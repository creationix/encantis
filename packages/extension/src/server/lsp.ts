// Encantis language server, desktop (Node) entry point.
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { startServer } from './serve';

startServer(createConnection(ProposedFeatures.all));
console.error('Encantis Language Server started');
