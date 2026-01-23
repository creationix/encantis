import type * as AST from './ast';
import { type TypeCheckResult, type Symbol as CheckSymbol } from './checker';
import { type ResolvedType } from './types';
export interface CodegenContext {
    types: Map<string, ResolvedType>;
    symbols: Map<string, CheckSymbol>;
    locals: Map<string, string[]>;
    params: Map<string, string[]>;
    indent: number;
}
/**
 * Convert a resolved type to WASM type string(s).
 * Primitives map to i32/i64/f32/f64.
 * Tuples flatten to multiple values.
 * Comptime types should have been concretized before calling this.
 */
export declare function typeToWasm(t: ResolvedType): string[];
export declare function exprToWat(expr: AST.Expr, ctx: CodegenContext): string;
export declare function stmtToWat(stmt: AST.Statement, ctx: CodegenContext): string;
export declare function funcToWat(decl: AST.FuncDecl, checkResult: TypeCheckResult): string;
export declare function moduleToWat(module: AST.Module, checkResult: TypeCheckResult): string;
//# sourceMappingURL=codegen.d.ts.map