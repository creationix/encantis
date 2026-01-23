// AST preprocessing passes for Encantis
// These run after parsing but before type checking

import type * as AST from './ast'

// === Def Inlining ===
// Replaces all IdentExpr references to `def` constants with their literal values

export interface DefMap {
  values: Map<string, AST.Expr>
}

/**
 * Collect all def declarations from a module.
 * Def values are inlined as they're collected so def-to-def references work.
 */
export function collectDefs(module: AST.Module): DefMap {
  const values = new Map<string, AST.Expr>()

  for (const decl of module.decls) {
    if (decl.kind === 'DefDecl') {
      // Inline any previous def references in this def's value
      const inlinedValue = inlineDefsExpr(decl.value, { values })
      values.set(decl.ident, inlinedValue)
    }
  }

  return { values }
}

/**
 * Inline def references in an expression.
 * Returns a new expression with all def references replaced.
 */
export function inlineDefsExpr(expr: AST.Expr, defs: DefMap): AST.Expr {
  switch (expr.kind) {
    case 'IdentExpr': {
      const defValue = defs.values.get(expr.name)
      if (defValue) {
        // Clone the def value with the reference's span for error reporting
        return cloneExprWithSpan(defValue, expr.span)
      }
      return expr
    }

    case 'BinaryExpr':
      return {
        ...expr,
        left: inlineDefsExpr(expr.left, defs),
        right: inlineDefsExpr(expr.right, defs),
      }

    case 'UnaryExpr':
      return {
        ...expr,
        operand: inlineDefsExpr(expr.operand, defs),
      }

    case 'CallExpr':
      return {
        ...expr,
        callee: inlineDefsExpr(expr.callee, defs),
        args: expr.args.map((arg) => ({
          ...arg,
          value: arg.value ? inlineDefsExpr(arg.value, defs) : undefined,
        })),
      }

    case 'MemberExpr':
      return {
        ...expr,
        object: inlineDefsExpr(expr.object, defs),
      }

    case 'IndexExpr':
      return {
        ...expr,
        object: inlineDefsExpr(expr.object, defs),
        index: inlineDefsExpr(expr.index, defs),
      }

    case 'IfExpr':
      return {
        ...expr,
        condition: inlineDefsExpr(expr.condition, defs),
        thenBranch: inlineDefsBody(expr.thenBranch, defs),
        elifs: expr.elifs.map((elif) => ({
          ...elif,
          condition: inlineDefsExpr(elif.condition, defs),
          thenBranch: inlineDefsBody(elif.thenBranch, defs),
        })),
        else_: expr.else_ ? inlineDefsBody(expr.else_, defs) : undefined,
      }

    case 'TupleExpr':
      return {
        ...expr,
        elements: expr.elements.map((elem) => ({
          ...elem,
          value: elem.value ? inlineDefsExpr(elem.value, defs) : undefined,
        })),
      }

    case 'GroupExpr':
      return {
        ...expr,
        expr: inlineDefsExpr(expr.expr, defs),
      }

    case 'CastExpr':
      return {
        ...expr,
        expr: inlineDefsExpr(expr.expr, defs),
      }

    case 'AnnotationExpr':
      return {
        ...expr,
        expr: inlineDefsExpr(expr.expr, defs),
      }

    case 'ArrayExpr':
      return {
        ...expr,
        elements: expr.elements.map((elem) => inlineDefsExpr(elem, defs)),
      }

    case 'MatchExpr':
      return {
        ...expr,
        subject: inlineDefsExpr(expr.subject, defs),
        arms: expr.arms.map((arm) => ({
          ...arm,
          body: inlineDefsMatchBody(arm.body, defs),
        })),
      }

    case 'LiteralExpr':
      return expr

    default:
      return expr
  }
}

function inlineDefsMatchBody(
  body: AST.Expr | AST.FuncBody,
  defs: DefMap,
): AST.Expr | AST.FuncBody {
  if ('kind' in body) {
    if (body.kind === 'Block' || body.kind === 'ArrowBody') {
      return inlineDefsBody(body as AST.FuncBody, defs)
    }
    return inlineDefsExpr(body as AST.Expr, defs)
  }
  return body
}

/**
 * Inline def references in a function body.
 */
export function inlineDefsBody(body: AST.FuncBody, defs: DefMap): AST.FuncBody {
  if (body.kind === 'ArrowBody') {
    return {
      ...body,
      expr: inlineDefsExpr(body.expr, defs),
    }
  }

  return {
    ...body,
    stmts: body.stmts.map((stmt) => inlineDefsStmt(stmt, defs)),
  }
}

/**
 * Inline def references in a statement.
 */
export function inlineDefsStmt(stmt: AST.Statement, defs: DefMap): AST.Statement {
  switch (stmt.kind) {
    case 'LetStmt':
      return {
        ...stmt,
        value: stmt.value ? inlineDefsExpr(stmt.value, defs) : undefined,
      }

    case 'SetStmt':
      return {
        ...stmt,
        value: inlineDefsExpr(stmt.value, defs),
      }

    case 'AssignmentStmt':
      return {
        ...stmt,
        target: inlineDefsExpr(stmt.target, defs) as AST.LValue,
        value: inlineDefsExpr(stmt.value, defs),
      }

    case 'ReturnStmt':
      return {
        ...stmt,
        value: stmt.value ? inlineDefsExpr(stmt.value, defs) : undefined,
        when: stmt.when ? inlineDefsExpr(stmt.when, defs) : undefined,
      }

    case 'ExpressionStmt':
      return {
        ...stmt,
        expr: inlineDefsExpr(stmt.expr, defs),
      }

    case 'WhileStmt':
      return {
        ...stmt,
        condition: inlineDefsExpr(stmt.condition, defs),
        body: inlineDefsBody(stmt.body, defs),
      }

    case 'LoopStmt':
      return {
        ...stmt,
        body: inlineDefsBody(stmt.body, defs),
      }

    case 'ForStmt':
      return {
        ...stmt,
        iterable: inlineDefsExpr(stmt.iterable, defs),
        body: inlineDefsBody(stmt.body, defs),
      }

    case 'BreakStmt':
      return {
        ...stmt,
        when: stmt.when ? inlineDefsExpr(stmt.when, defs) : undefined,
      }

    case 'ContinueStmt':
      return {
        ...stmt,
        when: stmt.when ? inlineDefsExpr(stmt.when, defs) : undefined,
      }

    default:
      return stmt
  }
}

/**
 * Inline def references in a function declaration.
 */
export function inlineDefsFunc(decl: AST.FuncDecl, defs: DefMap): AST.FuncDecl {
  return {
    ...decl,
    body: inlineDefsBody(decl.body, defs),
  }
}

/**
 * Inline def references throughout an entire module.
 * Returns a new module with all def references replaced with their values.
 */
export function inlineDefs(module: AST.Module): AST.Module {
  const defs = collectDefs(module)

  const newDecls = module.decls.map((decl): AST.Declaration => {
    switch (decl.kind) {
      case 'FuncDecl':
        return inlineDefsFunc(decl, defs)

      case 'ExportDecl':
        if (decl.item.kind === 'FuncDecl') {
          return {
            ...decl,
            item: inlineDefsFunc(decl.item, defs),
          }
        }
        if (decl.item.kind === 'GlobalDecl' && decl.item.value) {
          return {
            ...decl,
            item: {
              ...decl.item,
              value: inlineDefsExpr(decl.item.value, defs),
            },
          }
        }
        return decl

      case 'GlobalDecl':
        if (decl.value) {
          return {
            ...decl,
            value: inlineDefsExpr(decl.value, defs),
          }
        }
        return decl

      case 'DefDecl':
        // Keep def declarations but inline any def references in their values
        return {
          ...decl,
          value: inlineDefsExpr(decl.value, defs),
        }

      default:
        return decl
    }
  })

  return {
    ...module,
    decls: newDecls,
  }
}

/**
 * Clone an expression with a new span.
 */
function cloneExprWithSpan(expr: AST.Expr, span: AST.Span): AST.Expr {
  // Deep clone the expression, handling BigInt values
  const cloned = deepClone(expr) as AST.Expr
  cloned.span = span
  return cloned
}

/**
 * Deep clone a value, handling BigInt and other special types.
 */
function deepClone<T>(value: T): T {
  if (value === null || value === undefined) {
    return value
  }

  if (typeof value === 'bigint') {
    return value
  }

  if (Array.isArray(value)) {
    return value.map(deepClone) as T
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      result[key] = deepClone((value as Record<string, unknown>)[key])
    }
    return result as T
  }

  return value
}
