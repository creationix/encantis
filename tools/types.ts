// =============================================================================
// Encantis Compiler Types
// Shared type definitions for lexer, parser, checker, and LSP
// =============================================================================

// -----------------------------------------------------------------------------
// Source Locations
// -----------------------------------------------------------------------------

export interface Span {
  start: number;  // byte offset into source
  end: number;    // byte offset (exclusive)
}

export interface Located {
  span: Span;
}

// -----------------------------------------------------------------------------
// Diagnostics
// -----------------------------------------------------------------------------

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  span: Span;
  severity: DiagnosticSeverity;
  message: string;
}

// -----------------------------------------------------------------------------
// Tokens
// -----------------------------------------------------------------------------

export type TokenKind =
  // Literals
  | 'NUMBER'
  | 'STRING'
  | 'NAME'
  // Keywords
  | 'import'
  | 'export'
  | 'func'
  | 'local'
  | 'global'
  | 'end'
  | 'if'
  | 'then'
  | 'elif'
  | 'else'
  | 'while'
  | 'do'
  | 'for'
  | 'in'
  | 'loop'
  | 'return'
  | 'when'
  | 'and'
  | 'or'
  | 'not'
  | 'as'
  | 'memory'
  | 'define'
  | 'interface'
  | 'type'
  // Punctuation
  | '('
  | ')'
  | '['
  | ']'
  | '{'
  | '}'
  | ':'
  | ','
  | '->'
  | '=>'
  | '='
  | '.'
  | '*'
  // Operators
  | '+'
  | '-'
  | '/'
  | '%'
  | '&'
  | '|'
  | '^'
  | '~'
  | '<'
  | '>'
  | '<<'
  | '>>'
  | '<<<'
  | '>>>'
  | '<='
  | '>='
  | '=='
  | '!='
  // Compound assignment
  | '+='
  | '-='
  | '*='
  | '/='
  | '%='
  | '&='
  | '|='
  | '^='
  | '<<='
  | '>>='
  | '<<<='
  | '>>>='
  // Special
  | 'EOF';

export interface Token extends Located {
  kind: TokenKind;
  text: string;  // Original text from source
}

// -----------------------------------------------------------------------------
// Types (AST)
// -----------------------------------------------------------------------------

export interface PrimitiveType extends Located {
  kind: 'PrimitiveType';
  name: string;  // 'f64', 'i32', 'u32', 'u8', etc.
}

export interface SliceType extends Located {
  kind: 'SliceType';
  element: Type;
}

export interface FixedArrayType extends Located {
  kind: 'FixedArrayType';
  element: Type;
  length: number;
}

export interface NullTerminatedType extends Located {
  kind: 'NullTerminatedType';
  element: Type;
}

export interface PointerType extends Located {
  kind: 'PointerType';
  target: Type;
}

export interface TupleType extends Located {
  kind: 'TupleType';
  elements: Type[];
}

export interface FunctionType extends Located {
  kind: 'FunctionType';
  params: Type[];
  returns: Type;
}

export interface StructField extends Located {
  name: string;
  type: Type;
}

export interface StructType extends Located {
  kind: 'StructType';
  fields: StructField[];
}

export interface NamedType extends Located {
  kind: 'NamedType';
  name: string;             // Reference to a type alias
}

export type Type =
  | PrimitiveType
  | SliceType
  | FixedArrayType
  | NullTerminatedType
  | PointerType
  | TupleType
  | FunctionType
  | StructType
  | NamedType;

// -----------------------------------------------------------------------------
// Expressions (AST)
// -----------------------------------------------------------------------------

export interface NumberLiteral extends Located {
  kind: 'NumberLiteral';
  value: string;           // Preserve original text for f64 vs i32 detection
  suffix?: string;         // Optional type suffix like 'u64', 'f32'
}

export interface StringLiteral extends Located {
  kind: 'StringLiteral';
  value: string;           // Parsed content (escape sequences resolved)
  raw: string;             // Original source text including quotes
}

export interface Identifier extends Located {
  kind: 'Identifier';
  name: string;
}

export interface BinaryExpr extends Located {
  kind: 'BinaryExpr';
  op: string;              // '+', '-', '*', '/', etc.
  left: Expr;
  right: Expr;
}

export interface UnaryExpr extends Located {
  kind: 'UnaryExpr';
  op: string;              // '-', 'not', '~'
  operand: Expr;
}

export interface CallExpr extends Located {
  kind: 'CallExpr';
  callee: Expr;
  args: Expr[];
}

export interface IndexExpr extends Located {
  kind: 'IndexExpr';
  object: Expr;
  index: Expr;
}

export interface MemberExpr extends Located {
  kind: 'MemberExpr';
  object: Expr;
  member: string;          // Property name or tuple index ('1', '2', etc.)
}

export interface CastExpr extends Located {
  kind: 'CastExpr';
  expr: Expr;
  type: Type;
}

export interface TupleExpr extends Located {
  kind: 'TupleExpr';
  elements: Expr[];
}

export interface TernaryExpr extends Located {
  kind: 'TernaryExpr';
  condition: Expr;
  thenExpr: Expr;
  elseExpr: Expr;
}

export interface StructLiteralField extends Located {
  name: string;
  value?: Expr;             // If undefined, value is Identifier with same name (shorthand {x, y})
}

export interface StructLiteral extends Located {
  kind: 'StructLiteral';
  typeName?: string;        // Optional type name: Point{x: 1, y: 2} vs {x: 1, y: 2}
  fields: StructLiteralField[];
}

export interface ErrorExpr extends Located {
  kind: 'ErrorExpr';
  message: string;
}

export type Expr =
  | NumberLiteral
  | StringLiteral
  | Identifier
  | BinaryExpr
  | UnaryExpr
  | CallExpr
  | IndexExpr
  | MemberExpr
  | CastExpr
  | TupleExpr
  | TernaryExpr
  | StructLiteral
  | ErrorExpr;

// -----------------------------------------------------------------------------
// Statements (AST)
// -----------------------------------------------------------------------------

export interface LocalDecl extends Located {
  kind: 'LocalDecl';
  name: string;
  type?: Type;
  init?: Expr;
}

// Place expressions: valid assignment targets (lvalues)
export type PlaceExpr = Identifier | IndexExpr | MemberExpr;

export interface Assignment extends Located {
  kind: 'Assignment';
  targets: PlaceExpr[];    // For multi-assign: d, a = ... (also supports arr[i], ptr.field)
  op?: string;             // Compound: '+=', '-=', etc. (undefined for simple =)
  value: Expr;
}

// Destructuring binding for struct patterns: {x, y} or {x: a, y: b}
export interface DestructureBinding extends Located {
  field: string;            // Field name to extract
  variable?: string;        // Variable name (if different from field, e.g., {x: a})
}

// let (a, b) = expr OR let {x, y} = expr - declares new variables with destructuring
export interface LetStmt extends Located {
  kind: 'LetStmt';
  pattern: 'tuple' | 'struct';
  names: string[];          // For tuple: variable names; for struct: field names (when shorthand)
  bindings?: DestructureBinding[];  // For struct destructuring with explicit bindings
  types?: Type[];           // Optional type annotations (tuple only for now)
  value: Expr;
}

// set (a, b) = expr OR set {x, y} = expr - assigns to existing variables with destructuring
export interface SetStmt extends Located {
  kind: 'SetStmt';
  pattern: 'tuple' | 'struct';
  targets: PlaceExpr[];     // For tuple destructuring
  bindings?: DestructureBinding[];  // For struct destructuring
  value: Expr;
}

export interface ExprStmt extends Located {
  kind: 'ExprStmt';
  expr: Expr;
}

export interface ReturnStmt extends Located {
  kind: 'ReturnStmt';
  value?: Expr;
  condition?: Expr;        // For 'return x when cond'
}

export interface IfStmt extends Located {
  kind: 'IfStmt';
  condition: Expr;
  thenBody: Stmt[];
  elseBody?: Stmt[];       // Can contain elif chain
}

export interface WhileStmt extends Located {
  kind: 'WhileStmt';
  condition: Expr;
  body: Stmt[];
}

export interface ForStmt extends Located {
  kind: 'ForStmt';
  variable: string;
  variableType?: Type;
  iterable: Expr;          // Number or slice
  body: Stmt[];
}

export interface LoopStmt extends Located {
  kind: 'LoopStmt';
  body: Stmt[];
}

export interface BreakStmt extends Located {
  kind: 'BreakStmt';
  condition?: Expr;  // break when cond
}

export interface ContinueStmt extends Located {
  kind: 'ContinueStmt';
  condition?: Expr;  // continue when cond
}

export interface BranchStmt extends Located {
  kind: 'BranchStmt';      // 'br' or 'br when condition'
  condition?: Expr;
}

export interface ErrorStmt extends Located {
  kind: 'ErrorStmt';
  message: string;
}

export type Stmt =
  | LocalDecl
  | LetStmt
  | SetStmt
  | Assignment
  | ExprStmt
  | ReturnStmt
  | IfStmt
  | WhileStmt
  | ForStmt
  | LoopStmt
  | BreakStmt
  | ContinueStmt
  | BranchStmt
  | ErrorStmt;

// -----------------------------------------------------------------------------
// Parameters and Returns
// -----------------------------------------------------------------------------

export interface Param extends Located {
  name: string;
  type: Type;
}

export interface NamedReturn extends Located {
  params: Param[];         // Named returns like (d:f64, a:f64)
}

// -----------------------------------------------------------------------------
// Top-Level Declarations (AST)
// -----------------------------------------------------------------------------

export interface ImportItem extends Located {
  exportName: string;      // "sin"
  localName?: string;      // Optional local binding name
  params: Param[];
  returnType?: Type;
}

export interface ImportGroup extends Located {
  kind: 'ImportGroup';
  module: string;
  items: ImportItem[];
}

export interface ImportSingle extends Located {
  kind: 'ImportSingle';
  module: string;
  exportName: string;
  localName?: string;
  funcType: FunctionType;
}

export type Import = ImportGroup | ImportSingle;

export interface ArrowBody extends Located {
  kind: 'ArrowBody';
  exprs: Expr[];           // Comma-separated expressions for multi-return
}

export interface BlockBody extends Located {
  kind: 'BlockBody';
  stmts: Stmt[];
}

export type FuncBody = ArrowBody | BlockBody;

export interface FuncDecl extends Located {
  kind: 'FuncDecl';
  name?: string;           // Anonymous if missing
  params: Param[];
  returnType?: Type | NamedReturn;
  body?: FuncBody;         // Optional for import declarations
}

export interface ExportDecl extends Located {
  kind: 'ExportDecl';
  exportName: string;      // "to_polar", "_start"
  decl: FuncDecl | MemoryDecl | GlobalDecl;
}

export interface MemoryDecl extends Located {
  kind: 'MemoryDecl';
  name?: string;
  pages: number;
}

export interface GlobalDecl extends Located {
  kind: 'GlobalDecl';
  name: string;
  mutable: boolean;
  type?: Type;
  init: Expr;
}

export interface DefineDecl extends Located {
  kind: 'DefineDecl';
  name: string;
  params?: Param[];        // For macro functions
  type?: Type;
  value: Expr;
}

export interface TypeAliasDecl extends Located {
  kind: 'TypeAliasDecl';
  name: string;
  type: Type;              // The aliased type (can be StructType, etc.)
}

// -----------------------------------------------------------------------------
// Module (Top-Level AST)
// -----------------------------------------------------------------------------

export interface Module extends Located {
  kind: 'Module';
  imports: Import[];
  exports: ExportDecl[];
  globals: GlobalDecl[];
  memories: MemoryDecl[];
  defines: DefineDecl[];
  types: TypeAliasDecl[];  // Type aliases (type Name = ...)
  functions: FuncDecl[];   // Non-exported functions
}

// -----------------------------------------------------------------------------
// Parse Result
// -----------------------------------------------------------------------------

export interface ParseResult {
  ast: Module;
  errors: Diagnostic[];
}

// -----------------------------------------------------------------------------
// Check Result
// -----------------------------------------------------------------------------

export interface CheckResult {
  errors: Diagnostic[];
  symbols: SymbolTable;
}

// -----------------------------------------------------------------------------
// Symbol Table (for checker)
// -----------------------------------------------------------------------------

export type SymbolKind = 'local' | 'param' | 'global' | 'function' | 'import' | 'define' | 'type' | 'builtin';

export interface Symbol {
  name: string;
  kind: SymbolKind;
  type?: Type;
  span: Span;              // Declaration location
  mutable?: boolean;
}

export interface Scope {
  parent?: Scope;
  symbols: Map<string, Symbol>;
}

export interface SymbolTable {
  global: Scope;
  scopes: Map<FuncDecl, Scope>;  // Function-local scopes
}

// -----------------------------------------------------------------------------
// Utility Functions
// -----------------------------------------------------------------------------

export function spanUnion(a: Span, b: Span): Span {
  return {
    start: Math.min(a.start, b.start),
    end: Math.max(a.end, b.end),
  };
}

export function spanFrom(start: Located, end: Located): Span {
  return {
    start: start.span.start,
    end: end.span.end,
  };
}
