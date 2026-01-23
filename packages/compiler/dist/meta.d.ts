import type * as AST from './ast';
export interface MetaOutput {
    $schema?: string;
    src: string;
    types: MetaType[];
    symbols: MetaSymbol[];
    hints: Record<string, MetaHint>;
    errors?: MetaError[];
}
export interface MetaType {
    type: string;
    symbol?: number;
}
export interface MetaSymbol {
    name: string;
    kind: 'func' | 'type' | 'unique' | 'global' | 'local' | 'param' | 'def';
    type: number;
    def: string;
    refs: string[];
    doc?: string;
}
export interface MetaHint {
    len: number;
    type: number;
    symbol?: number;
}
export interface MetaError {
    pos: string;
    message: string;
}
export declare function buildMeta(module: AST.Module, source: string, options?: {
    srcPath?: string;
}): MetaOutput;
//# sourceMappingURL=meta.d.ts.map