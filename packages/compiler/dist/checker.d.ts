import type * as AST from './ast';
import { type ResolvedType, type IndexedRT } from './types';
export type ComptimeValue = {
    kind: 'int';
    value: bigint;
} | {
    kind: 'float';
    value: number;
} | {
    kind: 'bool';
    value: boolean;
};
export type Symbol = {
    kind: 'type';
    type: ResolvedType;
    unique: boolean;
} | {
    kind: 'func';
    type: ResolvedType & {
        kind: 'func';
    };
    inline: boolean;
} | {
    kind: 'global';
    type: ResolvedType;
} | {
    kind: 'def';
    type: ResolvedType;
    value: ComptimeValue;
} | {
    kind: 'local';
    type: ResolvedType;
} | {
    kind: 'param';
    type: ResolvedType;
} | {
    kind: 'return';
    type: ResolvedType;
};
export interface Scope {
    parent: Scope | null;
    symbols: Map<string, Symbol>;
}
/**
 * Create a unique key for the types Map.
 * Uses "offset:kind" format to avoid collisions when nested expressions
 * share the same start offset (e.g., `a > b` where both the binary expr
 * and identifier `a` start at the same position).
 */
export declare function typeKey(offset: number, kind: string): string;
export interface TypeError {
    offset: number;
    message: string;
}
export interface PendingLiteral {
    id: number;
    expr: AST.Expr;
    type: IndexedRT;
}
export interface TypeCheckResult {
    types: Map<string, ResolvedType>;
    symbols: Map<string, Symbol>;
    errors: TypeError[];
    references: Map<number, number[]>;
    symbolRefs: Map<number, number>;
    symbolDefOffsets: Map<string, number>;
    literals: PendingLiteral[];
}
export interface TypecheckOptions {
    defaultInt?: 'i32' | 'i64';
    defaultFloat?: 'f32' | 'f64';
}
/**
 * Type check a module and return concrete types for all AST nodes.
 * This is the single type checking phase that:
 * 1. Infers types for all expressions
 * 2. Validates type compatibility
 * 3. Concretizes comptime types to concrete runtime types
 */
export declare function typecheck(module: AST.Module, options?: TypecheckOptions): TypeCheckResult;
/** @deprecated Use typecheck() instead */
export declare const check: typeof typecheck;
/**
 * Concretize a single type, replacing comptime types with concrete defaults.
 */
export declare function concretizeType(t: ResolvedType, options?: TypecheckOptions): ResolvedType;
/**
 * Check if a type is fully concrete (no comptime types).
 */
export declare function isConcreteType(t: ResolvedType): boolean;
//# sourceMappingURL=checker.d.ts.map