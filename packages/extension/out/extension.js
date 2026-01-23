"use strict";
// =============================================================================
// Encantis VS Code Extension
// Provides syntax highlighting, LSP, and WAT preview for .ents files
// =============================================================================
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const path = __importStar(require("node:path"));
const vscode = __importStar(require("vscode"));
const node_1 = require("vscode-languageclient/node");
const watPreviewProvider_1 = require("./watPreviewProvider");
let client;
function activate(context) {
    // -------------------------------------------------------------------------
    // Language Server
    // -------------------------------------------------------------------------
    const serverModule = context.asAbsolutePath(path.join('out', 'server', 'lsp.js'));
    const serverOptions = {
        run: { module: serverModule, transport: node_1.TransportKind.ipc },
        debug: { module: serverModule, transport: node_1.TransportKind.ipc },
    };
    const clientOptions = {
        documentSelector: [{ scheme: 'file', language: 'encantis' }],
    };
    client = new node_1.LanguageClient('encantisLanguageServer', 'Encantis Language Server', serverOptions, clientOptions);
    client.start();
    // -------------------------------------------------------------------------
    // WAT Preview Feature
    // -------------------------------------------------------------------------
    const watProvider = new watPreviewProvider_1.WatPreviewProvider();
    // Register content provider for 'encantis-wat' scheme
    const providerRegistration = vscode.workspace.registerTextDocumentContentProvider(watPreviewProvider_1.WAT_SCHEME, watProvider);
    // Command: Open WAT Preview (in new tab)
    const openPreviewCommand = vscode.commands.registerCommand('encantis.openWatPreview', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'encantis') {
            vscode.window.showErrorMessage('Open an Encantis (.ents) file first');
            return;
        }
        const watUri = watPreviewProvider_1.WatPreviewProvider.encodeUri(editor.document.uri);
        vscode.workspace.openTextDocument(watUri).then(doc => {
            vscode.window.showTextDocument(doc, { preview: false });
        });
    });
    // Command: Open WAT Preview to Side (split view)
    const openPreviewSideCommand = vscode.commands.registerCommand('encantis.openWatPreviewSide', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'encantis') {
            vscode.window.showErrorMessage('Open an Encantis (.ents) file first');
            return;
        }
        const watUri = watPreviewProvider_1.WatPreviewProvider.encodeUri(editor.document.uri);
        vscode.workspace.openTextDocument(watUri).then(doc => {
            vscode.window.showTextDocument(doc, {
                viewColumn: vscode.ViewColumn.Beside,
                preview: false,
                preserveFocus: true,
            });
        });
    });
    // Auto-refresh preview when source changes
    const changeSubscription = vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.languageId === 'encantis') {
            watProvider.refresh(e.document.uri);
        }
    });
    context.subscriptions.push(watProvider, providerRegistration, openPreviewCommand, openPreviewSideCommand, changeSubscription);
}
function deactivate() {
    if (!client) {
        return undefined;
    }
    return client.stop();
}
//# sourceMappingURL=extension.js.map