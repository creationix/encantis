export interface Span {
    start: number;
    end: number;
}
interface BaseNode {
    span: Span;
}
export interface Module extends BaseNode {
    kind: 'Module';
    decls: Declaration[];
}
export type Declaration = ImportDecl | ExportDecl | FuncDecl | TypeDecl | DefDecl | GlobalDecl | MemoryDecl;
export interface ImportDecl extends BaseNode {
    kind: 'ImportDecl';
    module: string;
    items: ImportItem[];
}
export interface ImportItem extends BaseNode {
    kind: 'ImportItem';
    name: string;
    item: ImportFunc | ImportGlobal | ImportMemory;
}
export interface ImportFunc extends BaseNode {
    kind: 'ImportFunc';
    ident: string | null;
    signature: FuncSignature;
}
export interface ImportGlobal extends BaseNode {
    kind: 'ImportGlobal';
    ident: string;
    type: Type;
}
export interface ImportMemory extends BaseNode {
    kind: 'ImportMemory';
    min: number;
    max?: number;
}
export interface ExportDecl extends BaseNode {
    kind: 'ExportDecl';
    name: string;
    item: FuncDecl | GlobalDecl | MemoryDecl;
}
export interface FuncDecl extends BaseNode {
    kind: 'FuncDecl';
    inline: boolean;
    ident: string | null;
    signature: FuncSignature;
    body: FuncBody;
}
export interface FuncSignature extends BaseNode {
    kind: 'FuncSignature';
    input: Type;
    output: Type;
}
export interface FieldList extends BaseNode {
    kind: 'FieldList';
    fields: Field[];
}
export interface Field extends BaseNode {
    kind: 'Field';
    ident: string | null;
    type: Type;
}
export type FuncBody = Block | ArrowBody;
export interface Block extends BaseNode {
    kind: 'Block';
    stmts: Statement[];
}
export interface ArrowBody extends BaseNode {
    kind: 'ArrowBody';
    expr: Expr;
}
export interface TypeDecl extends BaseNode {
    kind: 'TypeDecl';
    ident: TypeRef;
    type: Type;
}
export interface DefDecl extends BaseNode {
    kind: 'DefDecl';
    ident: string;
    value: Expr;
}
export interface GlobalDecl extends BaseNode {
    kind: 'GlobalDecl';
    ident: string;
    type: Type | null;
    value: Expr | null;
}
export interface MemoryDecl extends BaseNode {
    kind: 'MemoryDecl';
    min: number;
    max: number | null;
    data: DataEntry[];
}
export interface DataEntry extends BaseNode {
    kind: 'DataEntry';
    offset: number;
    value: Expr;
}
export type Statement = LetStmt | SetStmt | WhileStmt | ForStmt | LoopStmt | ReturnStmt | BreakStmt | ContinueStmt | AssignmentStmt | ExpressionStmt;
export interface LetStmt extends BaseNode {
    kind: 'LetStmt';
    pattern: Pattern;
    type: Type | null;
    value: Expr | null;
}
export interface SetStmt extends BaseNode {
    kind: 'SetStmt';
    pattern: Pattern;
    type: Type | null;
    value: Expr;
}
export interface WhileStmt extends BaseNode {
    kind: 'WhileStmt';
    condition: Expr;
    body: FuncBody;
}
export interface ForStmt extends BaseNode {
    kind: 'ForStmt';
    binding: ForBinding;
    iterable: Expr;
    body: FuncBody;
}
export interface ForBinding extends BaseNode {
    kind: 'ForBinding';
    value: string;
    index: string | null;
}
export interface LoopStmt extends BaseNode {
    kind: 'LoopStmt';
    body: FuncBody;
}
export interface ReturnStmt extends BaseNode {
    kind: 'ReturnStmt';
    value: Expr | null;
    when: Expr | null;
}
export interface BreakStmt extends BaseNode {
    kind: 'BreakStmt';
    when: Expr | null;
}
export interface ContinueStmt extends BaseNode {
    kind: 'ContinueStmt';
    when: Expr | null;
}
export interface AssignmentStmt extends BaseNode {
    kind: 'AssignmentStmt';
    target: LValue;
    op: AssignOp;
    value: Expr;
}
export type AssignOp = '=' | '+=' | '-=' | '*=' | '/=' | '%=' | '&=' | '|=' | '^=' | '<<=' | '>>=' | '<<<=' | '>>>=' | '+|=' | '-|=' | '*|=';
export interface ExpressionStmt extends BaseNode {
    kind: 'ExpressionStmt';
    expr: Expr;
}
export type Expr = BinaryExpr | UnaryExpr | CastExpr | AnnotationExpr | CallExpr | MemberExpr | IndexExpr | IdentExpr | LiteralExpr | ArrayExpr | IfExpr | MatchExpr | TupleExpr | GroupExpr;
export interface BinaryExpr extends BaseNode {
    kind: 'BinaryExpr';
    op: BinaryOp;
    left: Expr;
    right: Expr;
}
export type BinaryOp = '||' | '&&' | '==' | '!=' | '<' | '>' | '<=' | '>=' | '|' | '^' | '&' | '<<' | '>>' | '<<<' | '>>>' | '+' | '-' | '+|' | '-|' | '*' | '/' | '%' | '*|';
export interface UnaryExpr extends BaseNode {
    kind: 'UnaryExpr';
    op: UnaryOp;
    operand: Expr;
}
export type UnaryOp = '-' | '~' | '!' | '&';
export interface CastExpr extends BaseNode {
    kind: 'CastExpr';
    expr: Expr;
    type: Type;
}
export interface AnnotationExpr extends BaseNode {
    kind: 'AnnotationExpr';
    expr: Expr;
    type: Type;
}
export interface CallExpr extends BaseNode {
    kind: 'CallExpr';
    callee: Expr;
    args: Arg[];
}
export interface Arg extends BaseNode {
    kind: 'Arg';
    name: string | null;
    value: Expr | null;
}
export interface MemberExpr extends BaseNode {
    kind: 'MemberExpr';
    object: Expr;
    member: MemberAccess;
}
export type MemberAccess = {
    kind: 'field';
    name: string;
} | {
    kind: 'index';
    value: number;
} | {
    kind: 'deref';
} | {
    kind: 'type';
    type: Type;
};
export interface IndexExpr extends BaseNode {
    kind: 'IndexExpr';
    object: Expr;
    index: Expr;
}
export interface IdentExpr extends BaseNode {
    kind: 'IdentExpr';
    name: string;
}
export interface LiteralExpr extends BaseNode {
    kind: 'LiteralExpr';
    value: LiteralValue;
}
export type LiteralValue = {
    kind: 'int';
    value: bigint;
    radix: 10 | 16 | 2 | 8 | 12;
} | {
    kind: 'float';
    value: number;
} | {
    kind: 'string';
    bytes: Uint8Array;
} | {
    kind: 'bool';
    value: boolean;
};
export interface ArrayExpr extends BaseNode {
    kind: 'ArrayExpr';
    elements: Expr[];
}
export interface IfExpr extends BaseNode {
    kind: 'IfExpr';
    condition: Expr;
    thenBranch: FuncBody;
    elifs: ElifBranch[];
    else_: FuncBody | null;
}
export interface ElifBranch extends BaseNode {
    kind: 'ElifBranch';
    condition: Expr;
    thenBranch: FuncBody;
}
export interface MatchExpr extends BaseNode {
    kind: 'MatchExpr';
    subject: Expr;
    arms: MatchArm[];
}
export interface MatchArm extends BaseNode {
    kind: 'MatchArm';
    patterns: MatchPattern[];
    body: FuncBody | Expr;
}
export type MatchPattern = {
    kind: 'literal';
    value: LiteralValue;
} | {
    kind: 'wildcard';
};
export interface TupleExpr extends BaseNode {
    kind: 'TupleExpr';
    elements: Arg[];
}
export interface GroupExpr extends BaseNode {
    kind: 'GroupExpr';
    expr: Expr;
}
export type LValue = IdentExpr | MemberExpr | IndexExpr | Pattern;
export type Pattern = IdentPattern | TuplePattern;
export interface IdentPattern extends BaseNode {
    kind: 'IdentPattern';
    name: string;
}
export interface TuplePattern extends BaseNode {
    kind: 'TuplePattern';
    elements: PatternElement[];
}
export type PatternElement = {
    kind: 'positional';
    pattern: Pattern;
} | {
    kind: 'named';
    field: string;
    binding: string | null;
};
export type Type = PrimitiveType | PointerType | IndexedType | CompositeType | BuiltinType | ComptimeIntType | ComptimeFloatType | TypeRef | FuncType;
export interface PrimitiveType extends BaseNode {
    kind: 'PrimitiveType';
    name: 'i8' | 'i16' | 'i32' | 'i64' | 'u8' | 'u16' | 'u32' | 'u64' | 'f32' | 'f64' | 'bool';
}
export interface PointerType extends BaseNode {
    kind: 'PointerType';
    pointee: Type;
}
export type IndexSpecifier = {
    kind: 'null';
} | {
    kind: 'prefix';
};
export interface IndexedType extends BaseNode {
    kind: 'IndexedType';
    element: Type;
    size: number | 'inferred' | 'comptime' | null;
    specifiers: IndexSpecifier[];
}
export interface CompositeType extends BaseNode {
    kind: 'CompositeType';
    fields: Field[];
}
export interface TypeRef extends BaseNode {
    kind: 'TypeRef';
    name: string;
}
export interface BuiltinType extends BaseNode {
    kind: 'BuiltinType';
    name: 'str' | 'bytes';
}
export interface ComptimeIntType extends BaseNode {
    kind: 'ComptimeIntType';
    value: bigint;
}
export interface ComptimeFloatType extends BaseNode {
    kind: 'ComptimeFloatType';
    value: number;
}
export interface FuncType extends BaseNode {
    kind: 'FuncType';
    input: Type;
    output: Type;
}
export {};
//# sourceMappingURL=ast.d.ts.map