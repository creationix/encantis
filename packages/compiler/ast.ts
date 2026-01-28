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
  | EnumDecl
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

// Function signature with symmetric input/output design
// Input and output can both be any Type (including CompositeType for tuples)
export interface FuncSignature extends BaseNode {
  kind: 'FuncSignature'
  input: Type   // The input type (tuple, single type, or void)
  output: Type  // The output type (defaults to void if omitted in source)
}

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

// type Name = Type (structural alias)
// type @Name = Type (unique/nominal type - @ prefix makes it unique)
export interface TypeDecl extends BaseNode {
  kind: 'TypeDecl'
  ident: TypeRef // name may start with @ for unique types
  type: Type
}

// enum Name { Variant1, Variant2(payload), ... }
export interface EnumDecl extends BaseNode {
  kind: 'EnumDecl'
  ident: string
  variants: EnumVariant[]
}

export interface EnumVariant extends BaseNode {
  kind: 'EnumVariant'
  name: string
  fields: Field[] | null // null for unit variants
}

// def name = expr
// def name:Type = expr
export interface DefDecl extends BaseNode {
  kind: 'DefDecl'
  ident: string
  type?: Type  // Optional type annotation on LHS
  value: Expr
}

// global name: type = expr
export interface GlobalDecl extends BaseNode {
  kind: 'GlobalDecl'
  pattern: Pattern
  type: Type | null
  value: Expr | null
}

// memory min [max]
export interface MemoryDecl extends BaseNode {
  kind: 'MemoryDecl'
  min: number
  max: number | null
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
  | ArrayExpr
  | RepeatExpr
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
  mut?: boolean  // mutable data, skip deduplication in data section
  dataId?: number  // ID for data section lookup (survives def substitution cloning)
}

export type LiteralValue =
  | { kind: 'int'; value: bigint; radix: 10 | 16 | 2 | 8 | 12 }
  | { kind: 'float'; value: number }
  | { kind: 'string'; bytes: Uint8Array }
  | { kind: 'bool'; value: boolean }

// [expr, expr, ...]
export interface ArrayExpr extends BaseNode {
  kind: 'ArrayExpr'
  elements: Expr[]
  mut?: boolean  // mutable data, skip deduplication in data section
  dataId?: number  // ID for data section lookup (survives def substitution cloning)
}

// [expr; count] - repeat value count times
export interface RepeatExpr extends BaseNode {
  kind: 'RepeatExpr'
  value: Expr
  count: Expr
  mut?: boolean  // mutable data, skip deduplication in data section
  dataId?: number  // ID for data section lookup (survives def substitution cloning)
}

// if expr { ... } elif ... else ...
// if let pattern = expr { ... } elif let ... else ...
export interface IfExpr extends BaseNode {
  kind: 'IfExpr'
  pattern: MatchPattern | null // non-null for if-let
  condition: Expr
  thenBranch: FuncBody
  elifs: ElifBranch[]
  else_: FuncBody | null
}

export interface ElifBranch extends BaseNode {
  kind: 'ElifBranch'
  pattern: MatchPattern | null // non-null for elif-let
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
  | { kind: 'constructor'; type: string; elements: MatchPatternElement[] }
  | { kind: 'tuple'; elements: MatchPatternElement[] }
  | { kind: 'variant'; type: string }
  | { kind: 'binding'; name: string }
  | { kind: 'literal'; value: LiteralValue }
  | { kind: 'wildcard' }

export type MatchPatternElement =
  | { kind: 'named'; field: string; pattern: MatchPattern }
  | { kind: 'namedShort'; field: string }
  | { kind: 'positional'; pattern: MatchPattern }

// (expr, expr) or (name: expr, name: expr)
export interface TupleExpr extends BaseNode {
  kind: 'TupleExpr'
  elements: Arg[]
  mut?: boolean  // mutable data, skip deduplication in data section
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
  | ComptimeIntType
  | ComptimeFloatType
  | TypeRef
  | FuncType

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

// Index specifiers: framing markers for serialization
// ! = null-terminated, ? = LEB128 length prefix
export type IndexSpecifier =
  | { kind: 'null' }   // null-terminated (!)
  | { kind: 'prefix' } // LEB128 length prefix (?)

// Bracket types: []T, [*]T, [5]T, [!]T, [*5!]T, etc.
export interface IndexedType extends BaseNode {
  kind: 'IndexedType'
  element: Type
  size: number | 'inferred' | 'comptime' | null // number = known length, 'inferred' = from literal, null = unknown
  specifiers: IndexSpecifier[] // framing: ! and ? markers
  manyPointer?: boolean // true for [*]T (thin pointer), false/undefined for []T (fat slice)
}

// () or (type, type) or (name: type, name: type)
export interface CompositeType extends BaseNode {
  kind: 'CompositeType'
  fields: Field[]
}

// Named type reference (uppercase identifier, optionally prefixed with @ for unique types)
export interface TypeRef extends BaseNode {
  kind: 'TypeRef'
  name: string // e.g., "Point" or "@CleanString"
}

// Comptime integer: int(value)
export interface ComptimeIntType extends BaseNode {
  kind: 'ComptimeIntType'
  value: bigint
}

// Comptime float: float(value)
export interface ComptimeFloatType extends BaseNode {
  kind: 'ComptimeFloatType'
  value: number
}

// Function type: input -> output
// Examples: i32 -> i32, (i32, i32) -> i32, () -> i32
export interface FuncType extends BaseNode {
  kind: 'FuncType'
  input: Type   // The input type
  output: Type  // The output type
}

// ============================================================================
// AST Visitor Pattern
// ============================================================================

/**
 * Visitor interface for traversing the AST.
 * All methods are optional - implement only the ones you need.
 * Return false from any method to skip traversing children of that node.
 */
export interface ASTVisitor {
  // Declarations
  visitModule?(node: Module): void | false
  visitImportDecl?(node: ImportDecl): void | false
  visitExportDecl?(node: ExportDecl): void | false
  visitFuncDecl?(node: FuncDecl): void | false
  visitTypeDecl?(node: TypeDecl): void | false
  visitDefDecl?(node: DefDecl): void | false
  visitGlobalDecl?(node: GlobalDecl): void | false
  visitMemoryDecl?(node: MemoryDecl): void | false

  // Statements
  visitLetStmt?(node: LetStmt): void | false
  visitSetStmt?(node: SetStmt): void | false
  visitWhileStmt?(node: WhileStmt): void | false
  visitForStmt?(node: ForStmt): void | false
  visitLoopStmt?(node: LoopStmt): void | false
  visitReturnStmt?(node: ReturnStmt): void | false
  visitBreakStmt?(node: BreakStmt): void | false
  visitContinueStmt?(node: ContinueStmt): void | false
  visitAssignmentStmt?(node: AssignmentStmt): void | false
  visitExpressionStmt?(node: ExpressionStmt): void | false

  // Expressions
  visitBinaryExpr?(node: BinaryExpr): void | false
  visitUnaryExpr?(node: UnaryExpr): void | false
  visitCastExpr?(node: CastExpr): void | false
  visitAnnotationExpr?(node: AnnotationExpr): void | false
  visitCallExpr?(node: CallExpr): void | false
  visitMemberExpr?(node: MemberExpr): void | false
  visitIndexExpr?(node: IndexExpr): void | false
  visitIdentExpr?(node: IdentExpr): void | false
  visitLiteralExpr?(node: LiteralExpr): void | false
  visitArrayExpr?(node: ArrayExpr): void | false
  visitRepeatExpr?(node: RepeatExpr): void | false
  visitIfExpr?(node: IfExpr): void | false
  visitMatchExpr?(node: MatchExpr): void | false
  visitTupleExpr?(node: TupleExpr): void | false
  visitGroupExpr?(node: GroupExpr): void | false

  // Bodies
  visitBlock?(node: Block): void | false
  visitArrowBody?(node: ArrowBody): void | false
}

/**
 * Walk the AST starting from a module, calling visitor methods for each node.
 * Traversal is depth-first, pre-order.
 */
export function walkModule(module: Module, visitor: ASTVisitor): void {
  if (visitor.visitModule?.(module) === false) return

  for (const decl of module.decls) {
    walkDeclaration(decl, visitor)
  }
}

function walkDeclaration(decl: Declaration, visitor: ASTVisitor): void {
  switch (decl.kind) {
    case 'ImportDecl':
      visitor.visitImportDecl?.(decl)
      break
    case 'ExportDecl':
      if (visitor.visitExportDecl?.(decl) !== false) {
        walkDeclaration(decl.item, visitor)
      }
      break
    case 'FuncDecl':
      if (visitor.visitFuncDecl?.(decl) !== false) {
        walkFuncBody(decl.body, visitor)
      }
      break
    case 'TypeDecl':
      visitor.visitTypeDecl?.(decl)
      break
    case 'DefDecl':
      if (visitor.visitDefDecl?.(decl) !== false) {
        walkExpr(decl.value, visitor)
      }
      break
    case 'GlobalDecl':
      if (visitor.visitGlobalDecl?.(decl) !== false) {
        if (decl.value) walkExpr(decl.value, visitor)
      }
      break
    case 'MemoryDecl':
      visitor.visitMemoryDecl?.(decl)
      break
  }
}

function walkFuncBody(body: FuncBody, visitor: ASTVisitor): void {
  if (body.kind === 'Block') {
    if (visitor.visitBlock?.(body) !== false) {
      for (const stmt of body.stmts) {
        walkStatement(stmt, visitor)
      }
    }
  } else {
    if (visitor.visitArrowBody?.(body) !== false) {
      walkExpr(body.expr, visitor)
    }
  }
}

function walkStatement(stmt: Statement, visitor: ASTVisitor): void {
  switch (stmt.kind) {
    case 'LetStmt':
      if (visitor.visitLetStmt?.(stmt) !== false) {
        if (stmt.value) walkExpr(stmt.value, visitor)
      }
      break
    case 'SetStmt':
      if (visitor.visitSetStmt?.(stmt) !== false) {
        walkExpr(stmt.value, visitor)
      }
      break
    case 'WhileStmt':
      if (visitor.visitWhileStmt?.(stmt) !== false) {
        walkExpr(stmt.condition, visitor)
        walkFuncBody(stmt.body, visitor)
      }
      break
    case 'ForStmt':
      if (visitor.visitForStmt?.(stmt) !== false) {
        walkExpr(stmt.iterable, visitor)
        walkFuncBody(stmt.body, visitor)
      }
      break
    case 'LoopStmt':
      if (visitor.visitLoopStmt?.(stmt) !== false) {
        walkFuncBody(stmt.body, visitor)
      }
      break
    case 'ReturnStmt':
      if (visitor.visitReturnStmt?.(stmt) !== false) {
        if (stmt.value) walkExpr(stmt.value, visitor)
        if (stmt.when) walkExpr(stmt.when, visitor)
      }
      break
    case 'BreakStmt':
      if (visitor.visitBreakStmt?.(stmt) !== false) {
        if (stmt.when) walkExpr(stmt.when, visitor)
      }
      break
    case 'ContinueStmt':
      if (visitor.visitContinueStmt?.(stmt) !== false) {
        if (stmt.when) walkExpr(stmt.when, visitor)
      }
      break
    case 'AssignmentStmt':
      if (visitor.visitAssignmentStmt?.(stmt) !== false) {
        walkExpr(stmt.value, visitor)
      }
      break
    case 'ExpressionStmt':
      if (visitor.visitExpressionStmt?.(stmt) !== false) {
        walkExpr(stmt.expr, visitor)
      }
      break
  }
}

function walkExpr(expr: Expr, visitor: ASTVisitor): void {
  switch (expr.kind) {
    case 'BinaryExpr':
      if (visitor.visitBinaryExpr?.(expr) !== false) {
        walkExpr(expr.left, visitor)
        walkExpr(expr.right, visitor)
      }
      break
    case 'UnaryExpr':
      if (visitor.visitUnaryExpr?.(expr) !== false) {
        walkExpr(expr.operand, visitor)
      }
      break
    case 'CastExpr':
      if (visitor.visitCastExpr?.(expr) !== false) {
        walkExpr(expr.expr, visitor)
      }
      break
    case 'AnnotationExpr':
      if (visitor.visitAnnotationExpr?.(expr) !== false) {
        walkExpr(expr.expr, visitor)
      }
      break
    case 'CallExpr':
      if (visitor.visitCallExpr?.(expr) !== false) {
        walkExpr(expr.callee, visitor)
        for (const arg of expr.args) {
          if (arg.value) walkExpr(arg.value, visitor)
        }
      }
      break
    case 'MemberExpr':
      if (visitor.visitMemberExpr?.(expr) !== false) {
        walkExpr(expr.object, visitor)
      }
      break
    case 'IndexExpr':
      if (visitor.visitIndexExpr?.(expr) !== false) {
        walkExpr(expr.object, visitor)
        walkExpr(expr.index, visitor)
      }
      break
    case 'IdentExpr':
      visitor.visitIdentExpr?.(expr)
      break
    case 'LiteralExpr':
      visitor.visitLiteralExpr?.(expr)
      break
    case 'ArrayExpr':
      if (visitor.visitArrayExpr?.(expr) !== false) {
        for (const elem of expr.elements) {
          walkExpr(elem, visitor)
        }
      }
      break
    case 'RepeatExpr':
      if (visitor.visitRepeatExpr?.(expr) !== false) {
        walkExpr(expr.value, visitor)
        walkExpr(expr.count, visitor)
      }
      break
    case 'IfExpr':
      if (visitor.visitIfExpr?.(expr) !== false) {
        walkExpr(expr.condition, visitor)
        walkFuncBody(expr.thenBranch, visitor)
        for (const elif of expr.elifs) {
          walkExpr(elif.condition, visitor)
          walkFuncBody(elif.thenBranch, visitor)
        }
        if (expr.else_) walkFuncBody(expr.else_, visitor)
      }
      break
    case 'MatchExpr':
      if (visitor.visitMatchExpr?.(expr) !== false) {
        walkExpr(expr.subject, visitor)
        for (const arm of expr.arms) {
          if (arm.body.kind === 'Block' || arm.body.kind === 'ArrowBody') {
            walkFuncBody(arm.body, visitor)
          } else {
            walkExpr(arm.body, visitor)
          }
        }
      }
      break
    case 'TupleExpr':
      if (visitor.visitTupleExpr?.(expr) !== false) {
        for (const elem of expr.elements) {
          if (elem.value) walkExpr(elem.value, visitor)
        }
      }
      break
    case 'GroupExpr':
      if (visitor.visitGroupExpr?.(expr) !== false) {
        walkExpr(expr.expr, visitor)
      }
      break
  }
}
