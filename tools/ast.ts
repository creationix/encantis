// AST types for Encantis language
// All nodes include span for sourcemap support

export interface Span {
  start: number // byte offset
  end: number // byte offset
}

// Base for all AST nodes
interface BaseNode {
  span: Span
}

// ============================================================================
// Module (top-level)
// ============================================================================

export interface Module extends BaseNode {
  kind: 'Module'
  decls: Declaration[]
}

// ============================================================================
// Declarations
// ============================================================================

export type Declaration =
  | ImportDecl
  | ExportDecl
  | FuncDecl
  | TypeDecl
  | UniqueDecl
  | DefDecl
  | GlobalDecl
  | MemoryDecl

// import "module" "name" func ...
// import "module" ( "name" func ... )
export interface ImportDecl extends BaseNode {
  kind: 'ImportDecl'
  module: string
  items: ImportItem[]
}

export interface ImportItem extends BaseNode {
  kind: 'ImportItem'
  name: string
  item: ImportFunc | ImportGlobal | ImportMemory
}

export interface ImportFunc extends BaseNode {
  kind: 'ImportFunc'
  ident: string | null
  signature: FuncSignature
}

export interface ImportGlobal extends BaseNode {
  kind: 'ImportGlobal'
  ident: string
  type: Type
}

export interface ImportMemory extends BaseNode {
  kind: 'ImportMemory'
  min: number
  max?: number
}

// export "name" ...
export interface ExportDecl extends BaseNode {
  kind: 'ExportDecl'
  name: string
  item: FuncDecl | GlobalDecl | MemoryDecl
}

// func name(params) -> returns { body }
export interface FuncDecl extends BaseNode {
  kind: 'FuncDecl'
  inline: boolean
  ident: string | null
  signature: FuncSignature
  body: FuncBody
}

export interface FuncSignature extends BaseNode {
  kind: 'FuncSignature'
  params: ValueSpec
  returns: ValueSpec | null
}

// Single type or (field, field, ...)
export type ValueSpec = Type | FieldList

export interface FieldList extends BaseNode {
  kind: 'FieldList'
  fields: Field[]
}

export interface Field extends BaseNode {
  kind: 'Field'
  ident: string | null
  type: Type
}

export type FuncBody = Block | ArrowBody

export interface Block extends BaseNode {
  kind: 'Block'
  stmts: Statement[]
}

export interface ArrowBody extends BaseNode {
  kind: 'ArrowBody'
  expr: Expr
}

// type Name = Type
export interface TypeDecl extends BaseNode {
  kind: 'TypeDecl'
  ident: string
  type: Type
}

// unique Name = Type
export interface UniqueDecl extends BaseNode {
  kind: 'UniqueDecl'
  ident: string
  type: Type
}

// def name = expr
export interface DefDecl extends BaseNode {
  kind: 'DefDecl'
  ident: string
  value: Expr
}

// global name: type = expr
export interface GlobalDecl extends BaseNode {
  kind: 'GlobalDecl'
  ident: string
  type: Type | null
  value: Expr | null
}

// memory min [max] { data }
export interface MemoryDecl extends BaseNode {
  kind: 'MemoryDecl'
  min: number
  max: number | null
  data: DataEntry[]
}

export interface DataEntry extends BaseNode {
  kind: 'DataEntry'
  offset: number
  value: Expr
}

// ============================================================================
// Statements
// ============================================================================

export type Statement =
  | LetStmt
  | SetStmt
  | WhileStmt
  | ForStmt
  | LoopStmt
  | ReturnStmt
  | BreakStmt
  | ContinueStmt
  | AssignmentStmt
  | ExpressionStmt

// let pattern: type = expr
export interface LetStmt extends BaseNode {
  kind: 'LetStmt'
  pattern: Pattern
  type: Type | null
  value: Expr | null
}

// set pattern: type = expr
export interface SetStmt extends BaseNode {
  kind: 'SetStmt'
  pattern: Pattern
  type: Type | null
  value: Expr
}

// while expr { ... }
export interface WhileStmt extends BaseNode {
  kind: 'WhileStmt'
  condition: Expr
  body: FuncBody
}

// for binding in expr { ... }
export interface ForStmt extends BaseNode {
  kind: 'ForStmt'
  binding: ForBinding
  iterable: Expr
  body: FuncBody
}

export interface ForBinding extends BaseNode {
  kind: 'ForBinding'
  value: string
  index: string | null
}

// loop { ... }
export interface LoopStmt extends BaseNode {
  kind: 'LoopStmt'
  body: FuncBody
}

// return [expr] [when expr]
export interface ReturnStmt extends BaseNode {
  kind: 'ReturnStmt'
  value: Expr | null
  when: Expr | null
}

// break [when expr]
export interface BreakStmt extends BaseNode {
  kind: 'BreakStmt'
  when: Expr | null
}

// continue [when expr]
export interface ContinueStmt extends BaseNode {
  kind: 'ContinueStmt'
  when: Expr | null
}

// lvalue op= expr
export interface AssignmentStmt extends BaseNode {
  kind: 'AssignmentStmt'
  target: LValue
  op: AssignOp
  value: Expr
}

export type AssignOp =
  | '='
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
  | '+|='
  | '-|='
  | '*|='

// Standalone expression
export interface ExpressionStmt extends BaseNode {
  kind: 'ExpressionStmt'
  expr: Expr
}

// ============================================================================
// Expressions
// ============================================================================

export type Expr =
  | BinaryExpr
  | UnaryExpr
  | CastExpr
  | AnnotationExpr
  | CallExpr
  | MemberExpr
  | IndexExpr
  | IdentExpr
  | LiteralExpr
  | IfExpr
  | MatchExpr
  | TupleExpr
  | GroupExpr

// left op right
export interface BinaryExpr extends BaseNode {
  kind: 'BinaryExpr'
  op: BinaryOp
  left: Expr
  right: Expr
}

export type BinaryOp =
  | '||'
  | '&&'
  | '=='
  | '!='
  | '<'
  | '>'
  | '<='
  | '>='
  | '|'
  | '^'
  | '&'
  | '<<'
  | '>>'
  | '<<<'
  | '>>>'
  | '+'
  | '-'
  | '+|'
  | '-|'
  | '*'
  | '/'
  | '%'
  | '*|'

// op expr
export interface UnaryExpr extends BaseNode {
  kind: 'UnaryExpr'
  op: UnaryOp
  operand: Expr
}

export type UnaryOp = '-' | '~' | '!' | '&'

// expr as type (runtime cast)
export interface CastExpr extends BaseNode {
  kind: 'CastExpr'
  expr: Expr
  type: Type
}

// expr : type (type annotation)
export interface AnnotationExpr extends BaseNode {
  kind: 'AnnotationExpr'
  expr: Expr
  type: Type
}

// callee(args)
export interface CallExpr extends BaseNode {
  kind: 'CallExpr'
  callee: Expr
  args: Arg[]
}

export interface Arg extends BaseNode {
  kind: 'Arg'
  name: string | null // null for positional
  value: Expr | null // null for shorthand (name:)
}

// expr.member or expr.0 or expr.* or expr.type
export interface MemberExpr extends BaseNode {
  kind: 'MemberExpr'
  object: Expr
  member: MemberAccess
}

export type MemberAccess =
  | { kind: 'field'; name: string }
  | { kind: 'index'; value: number }
  | { kind: 'deref' }
  | { kind: 'type'; type: Type }

// expr[index]
export interface IndexExpr extends BaseNode {
  kind: 'IndexExpr'
  object: Expr
  index: Expr
}

// identifier
export interface IdentExpr extends BaseNode {
  kind: 'IdentExpr'
  name: string
}

// literal values
export interface LiteralExpr extends BaseNode {
  kind: 'LiteralExpr'
  value: LiteralValue
}

export type LiteralValue =
  | { kind: 'int'; value: bigint; radix: 10 | 16 | 2 | 8 | 12 }
  | { kind: 'float'; value: number }
  | {
      kind: 'string'
      value: string
      format: 'utf8' | 'char' | 'hex' | 'base64'
    }
  | { kind: 'bool'; value: boolean }

// if expr { ... } elif ... else ...
export interface IfExpr extends BaseNode {
  kind: 'IfExpr'
  condition: Expr
  thenBranch: FuncBody
  elifs: ElifBranch[]
  else_: FuncBody | null
}

export interface ElifBranch extends BaseNode {
  kind: 'ElifBranch'
  condition: Expr
  thenBranch: FuncBody
}

// match expr { patterns => ... }
export interface MatchExpr extends BaseNode {
  kind: 'MatchExpr'
  subject: Expr
  arms: MatchArm[]
}

export interface MatchArm extends BaseNode {
  kind: 'MatchArm'
  patterns: MatchPattern[]
  body: FuncBody | Expr
}

export type MatchPattern =
  | { kind: 'literal'; value: LiteralValue }
  | { kind: 'wildcard' }

// (expr, expr) or (name: expr, name: expr)
export interface TupleExpr extends BaseNode {
  kind: 'TupleExpr'
  elements: Arg[]
}

// (expr)
export interface GroupExpr extends BaseNode {
  kind: 'GroupExpr'
  expr: Expr
}

// ============================================================================
// L-Values (assignable expressions)
// ============================================================================

export type LValue = IdentExpr | MemberExpr | IndexExpr | Pattern

// ============================================================================
// Patterns
// ============================================================================

export type Pattern = IdentPattern | TuplePattern

// Single identifier
export interface IdentPattern extends BaseNode {
  kind: 'IdentPattern'
  name: string
}

// (a, b) or (x:, y:) or (x: a, y: b)
export interface TuplePattern extends BaseNode {
  kind: 'TuplePattern'
  elements: PatternElement[]
}

export type PatternElement =
  | { kind: 'positional'; pattern: Pattern }
  | { kind: 'named'; field: string; binding: string | null } // null = shorthand (x:)

// ============================================================================
// Types
// ============================================================================

export type Type =
  | PrimitiveType
  | PointerType
  | IndexedType
  | CompositeType
  | TypeRef

export interface PrimitiveType extends BaseNode {
  kind: 'PrimitiveType'
  name:
    | 'i8'
    | 'i16'
    | 'i32'
    | 'i64'
    | 'u8'
    | 'u16'
    | 'u32'
    | 'u64'
    | 'f32'
    | 'f64'
    | 'bool'
}

// *type
export interface PointerType extends BaseNode {
  kind: 'PointerType'
  pointee: Type
}

// type[] or type[N] or type[/0] or type[N/0]
export interface IndexedType extends BaseNode {
  kind: 'IndexedType'
  element: Type
  size: number | null // null = slice
  nullTerminated: boolean
}

// () or (type, type) or (name: type, name: type)
export interface CompositeType extends BaseNode {
  kind: 'CompositeType'
  fields: Field[]
}

// Named type reference (uppercase identifier)
export interface TypeRef extends BaseNode {
  kind: 'TypeRef'
  name: string
}
