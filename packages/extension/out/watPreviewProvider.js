"use strict";
// =============================================================================
// WAT Preview Provider
// Provides read-only WAT preview for Encantis files
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
exports.WatPreviewProvider = exports.WAT_SCHEME = void 0;
const vscode = __importStar(require("vscode"));
// Compiler disabled until parser is updated to match grammar spec
// import { compile } from './server/compile';
function compile(_src) {
    return ';; WAT preview disabled - parser is being updated to match grammar spec\n;; See docs/grammar.md for the current language specification';
}
exports.WAT_SCHEME = 'encantis-wat';
class WatPreviewProvider {
    _onDidChange = new vscode.EventEmitter();
    onDidChange = this._onDidChange.event;
    _cache = new Map();
    /**
     * Encode a source URI into a WAT preview URI.
     * Format: encantis-wat:/path/to/file.ents.wat?<encoded-source-uri>
     */
    static encodeUri(sourceUri) {
        return vscode.Uri.parse(`${exports.WAT_SCHEME}:${sourceUri.path}.wat?${encodeURIComponent(sourceUri.toString())}`);
    }
    /**
     * Decode a WAT preview URI back to the source URI.
     */
    static decodeUri(watUri) {
        return vscode.Uri.parse(decodeURIComponent(watUri.query));
    }
    /**
     * Refresh the WAT preview when source changes.
     */
    refresh(sourceUri) {
        const watUri = WatPreviewProvider.encodeUri(sourceUri);
        this._cache.delete(watUri.toString());
        this._onDidChange.fire(watUri);
    }
    /**
     * TextDocumentContentProvider implementation.
     * Called when VS Code needs the content of a WAT preview document.
     */
    provideTextDocumentContent(uri) {
        const cacheKey = uri.toString();
        const cached = this._cache.get(cacheKey);
        if (cached) {
            return cached;
        }
        const sourceUri = WatPreviewProvider.decodeUri(uri);
        return vscode.workspace.openTextDocument(sourceUri).then(doc => {
            const src = doc.getText();
            const wat = compile(src);
            this._cache.set(cacheKey, wat);
            return wat;
        });
    }
    dispose() {
        this._onDidChange.dispose();
        this._cache.clear();
    }
}
exports.WatPreviewProvider = WatPreviewProvider;
//# sourceMappingURL=watPreviewProvider.js.map