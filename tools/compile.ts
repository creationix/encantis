// =============================================================================
// Encantis Compiler
// Main entry point: exports parse(), check(), and compile()
// =============================================================================

import type {
  CheckResult, Diagnostic, Expr, FuncBody, FuncDecl,
  Module, ParseResult, Stmt, Token, Type,
} from './types';

import { check as doCheck } from './checker';
import { formatDiagnostic, getLineAndColumn, tokenize } from './lexer';
import { parse as doParse } from './parser';

// Re-export types for consumers
export type { Token, Diagnostic, ParseResult, CheckResult, Module };
export { tokenize, formatDiagnostic, getLineAndColumn };

// -----------------------------------------------------------------------------
// Parse API
// -----------------------------------------------------------------------------

/**
 * Parse Encantis source code into an AST.
 * Returns the AST and any syntax errors encountered.
 * The parser is error-tolerant and will return a partial AST even with errors.
 */
export function parse(src: string): ParseResult {
  return doParse(src);
}

// -----------------------------------------------------------------------------
// Check API
// -----------------------------------------------------------------------------

/**
 * Perform semantic analysis on a parsed AST.
 * Checks for undefined variables, type mismatches, etc.
 * Returns the combined errors from parsing and checking.
 */
export function check(parseResult: ParseResult): CheckResult {
  return doCheck(parseResult);
}

/**
 * Parse and check source code in one step.
 * Convenience function that combines parse() and check().
 */
export function analyze(src: string): CheckResult {
  const parseResult = parse(src);
  return check(parseResult);
}

// -----------------------------------------------------------------------------
// Compile API (WAT generation - placeholder for now)
// -----------------------------------------------------------------------------

/**
 * Compile Encantis source code to WebAssembly Text Format (WAT).
 * Currently a placeholder - full codegen will be added later.
 */
export function compile(src: string): string {
  const parseResult = parse(src);
  const checkResult = check(parseResult);

  if (checkResult.errors.some(e => e.severity === 'error')) {
    // Return error summary instead of WAT
    const errorLines = checkResult.errors
      .filter(e => e.severity === 'error')
      .map(e => formatDiagnostic(src, e));
    throw new Error(`Compilation failed with ${errorLines.length} error(s):\n\n${errorLines.join('\n\n')}`);
  }

  // TODO: Implement code generation
  return generateWat(parseResult.ast, src);
}

// -----------------------------------------------------------------------------
// WAT Code Generation (Basic Implementation)
// -----------------------------------------------------------------------------

interface CodeGenContext {
  output: string[];
  indent: number;
  strings: Map<string, number>;
  stringOffset: number;
  src: string;
}

function emit(ctx: CodeGenContext, line: string): void {
  ctx.output.push('  '.repeat(ctx.indent) + line);
}

function generateWat(module: Module, src: string): string {
  const ctx: CodeGenContext = {
    output: [],
    indent: 0,
    strings: new Map(),
    stringOffset: 0,
    src,
  };

  emit(ctx, '(module');
  ctx.indent++;

  // Generate imports
  for (const imp of module.imports) {
    if (imp.kind === 'ImportGroup') {
      for (const item of imp.items) {
        const localName = item.localName || item.exportName;
        const params = item.params.map(p => `(param ${typeToWat(p.type)})`).join(' ');
        const result = item.returnType ? `(result ${typeToWat(item.returnType)})` : '';
        emit(ctx, `(func $${localName} (import "${imp.module}" "${item.exportName}") ${params} ${result})`);
      }
    } else {
      const localName = imp.localName || imp.exportName;
      const params = imp.funcType.params.map(t => typeToWat(t)).join(' ');
      const paramsStr = params ? `(param ${params})` : '';
      const returns = imp.funcType.returns;
      const result = returns.kind !== 'TupleType' || (returns.kind === 'TupleType' && returns.elements.length > 0)
        ? `(result ${typeToWat(imp.funcType.returns)})`
        : '';
      emit(ctx, `(func $${localName} (import "${imp.module}" "${imp.exportName}") ${paramsStr} ${result})`);
    }
  }

  // Generate exports
  for (const exp of module.exports) {
    if (exp.decl.kind === 'FuncDecl') {
      generateFunction(ctx, exp.decl, exp.exportName);
    } else if (exp.decl.kind === 'MemoryDecl') {
      emit(ctx, `(memory (export "${exp.exportName}") ${exp.decl.pages})`);
    }
  }

  // Generate non-exported functions
  for (const func of module.functions) {
    if (func.name) {
      generateFunction(ctx, func);
    }
  }

  // Generate memory if not already exported
  const hasMemory = module.exports.some(e => e.decl.kind === 'MemoryDecl') || module.memories.length > 0;
  if (!hasMemory && ctx.strings.size > 0) {
    emit(ctx, '(memory 1)');
  }

  // Generate data section for strings
  if (ctx.strings.size > 0) {
    const sortedStrings = Array.from(ctx.strings.entries()).sort((a, b) => a[1] - b[1]);
    const allStrings = sortedStrings.map(([str]) => escapeWatString(str)).join('');
    emit(ctx, `(data (i32.const 0) "${allStrings}")`);
  }

  ctx.indent--;
  emit(ctx, ')');

  return ctx.output.join('\n');
}

function generateFunction(ctx: CodeGenContext, func: FuncDecl, exportName?: string): void {
  const name = func.name || exportName || 'anonymous';
  const exportClause = exportName ? `(export "${exportName}")` : '';

  // Build params
  const params = func.params.map(p => `(param $${p.name} ${typeToWat(p.type)})`).join(' ');

  // Build results
  let results = '';
  if (func.returnType) {
    if ('params' in func.returnType) {
      // Named returns
      results = `(result ${func.returnType.params.map(p => typeToWat(p.type)).join(' ')})`;
    } else {
      results = `(result ${typeToWat(func.returnType)})`;
    }
  }

  emit(ctx, `(func $${name} ${exportClause} ${params} ${results}`.trim());
  ctx.indent++;

  // Collect locals from body
  if (func.body?.kind === 'BlockBody') {
    for (const stmt of func.body.stmts) {
      if (stmt.kind === 'LocalDecl' && stmt.type) {
        emit(ctx, `(local $${stmt.name} ${typeToWat(stmt.type)})`);
      }
    }
  }

  // Named returns are also locals
  if (func.returnType && 'params' in func.returnType) {
    for (const ret of func.returnType.params) {
      emit(ctx, `(local $${ret.name} ${typeToWat(ret.type)})`);
    }
  }

  // Generate body
  if (func.body) {
    generateFuncBody(ctx, func.body, func);
  }

  ctx.indent--;
  emit(ctx, ')');
}

function generateFuncBody(ctx: CodeGenContext, body: FuncBody, func: FuncDecl): void {
  if (body.kind === 'ArrowBody') {
    // Arrow body: just the expressions
    for (const expr of body.exprs) {
      generateExpr(ctx, expr);
    }
  } else {
    // Block body: statements
    for (const stmt of body.stmts) {
      generateStmt(ctx, stmt);
    }

    // Return named return values
    if (func.returnType && 'params' in func.returnType) {
      for (const ret of func.returnType.params) {
        emit(ctx, `(local.get $${ret.name})`);
      }
    }
  }
}

function generateStmt(ctx: CodeGenContext, stmt: Stmt): void {
  switch (stmt.kind) {
    case 'LocalDecl':
      if (stmt.init) {
        generateExpr(ctx, stmt.init);
        emit(ctx, `(local.set $${stmt.name})`);
      }
      break;

    case 'Assignment':
      generateExpr(ctx, stmt.value);
      // For multiple targets, WAT pops in reverse order
      for (let i = stmt.targets.length - 1; i >= 0; i--) {
        emit(ctx, `(local.set $${stmt.targets[i].name})`);
      }
      break;

    case 'ExprStmt':
      generateExpr(ctx, stmt.expr);
      // Drop result if not used
      emit(ctx, '(drop)');
      break;

    case 'ReturnStmt':
      if (stmt.value) {
        generateExpr(ctx, stmt.value);
        emit(ctx, '(return)');
      }
      break;

    // TODO: Implement other statements (if, while, for, etc.)
    default:
      emit(ctx, `;; TODO: ${stmt.kind}`);
  }
}

function generateExpr(ctx: CodeGenContext, expr: Expr): void {
  switch (expr.kind) {
    case 'NumberLiteral': {
      const isFloat = expr.value.includes('.') || expr.suffix === 'f32' || expr.suffix === 'f64';
      if (isFloat) {
        emit(ctx, `(f64.const ${expr.value})`);
      } else {
        emit(ctx, `(i32.const ${expr.value})`);
      }
      break;
    }

    case 'StringLiteral': {
      // Register string and emit ptr/len
      const offset = registerString(ctx, expr.value);
      emit(ctx, `(i32.const ${offset})`);
      emit(ctx, `(i32.const ${expr.value.length})`);
      break;
    }

    case 'Identifier':
      emit(ctx, `(local.get $${expr.name})`);
      break;

    case 'BinaryExpr':
      generateExpr(ctx, expr.left);
      generateExpr(ctx, expr.right);
      emit(ctx, `(${getBinaryOp(expr.op)})`);
      break;

    case 'CallExpr':
      for (const arg of expr.args) {
        generateExpr(ctx, arg);
      }
      if (expr.callee.kind === 'Identifier') {
        emit(ctx, `(call $${expr.callee.name})`);
      }
      break;

    case 'TupleExpr':
      for (const elem of expr.elements) {
        generateExpr(ctx, elem);
      }
      break;

    default:
      emit(ctx, `;; TODO: ${expr.kind}`);
  }
}

function getBinaryOp(op: string): string {
  // Default to f64 operations for MVP
  const opMap: Record<string, string> = {
    '+': 'f64.add',
    '-': 'f64.sub',
    '*': 'f64.mul',
    '/': 'f64.div',
  };
  return opMap[op] || `f64.${op}`;
}

function typeToWat(type: Type): string {
  switch (type.kind) {
    case 'PrimitiveType': {
      const name = type.name;
      if (name === 'f64') return 'f64';
      if (name === 'f32') return 'f32';
      if (name === 'i64' || name === 'u64') return 'i64';
      return 'i32';
    }
    case 'SliceType':
      return 'i32 i32'; // ptr, len
    case 'PointerType':
      return 'i32';
    case 'TupleType':
      return type.elements.map(typeToWat).join(' ');
    default:
      return 'i32';
  }
}

function registerString(ctx: CodeGenContext, str: string): number {
  const existing = ctx.strings.get(str);
  if (existing !== undefined) {
    return existing;
  }
  const offset = ctx.stringOffset;
  ctx.strings.set(str, offset);
  ctx.stringOffset += str.length;
  return offset;
}

function escapeWatString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
    .replace(/\0/g, '\\00');
}
