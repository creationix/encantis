import type * as AST from './ast';
export interface DefMap {
    values: Map<string, AST.Expr>;
}
/**
 * Collect all def declarations from a module.
 * Def values are inlined as they're collected so def-to-def references work.
 */
export declare function collectDefs(module: AST.Module): DefMap;
/**
 * Inline def references in an expression.
 * Returns a new expression with all def references replaced.
 */
export declare function inlineDefsExpr(expr: AST.Expr, defs: DefMap): AST.Expr;
/**
 * Inline def references in a function body.
 */
export declare function inlineDefsBody(body: AST.FuncBody, defs: DefMap): AST.FuncBody;
/**
 * Inline def references in a statement.
 */
export declare function inlineDefsStmt(stmt: AST.Statement, defs: DefMap): AST.Statement;
/**
 * Inline def references in a function declaration.
 */
export declare function inlineDefsFunc(decl: AST.FuncDecl, defs: DefMap): AST.FuncDecl;
/**
 * Inline def references throughout an entire module.
 * Returns a new module with all def references replaced with their values.
 */
export declare function inlineDefs(module: AST.Module): AST.Module;
//# sourceMappingURL=preprocess.d.ts.map