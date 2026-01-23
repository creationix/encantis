// =============================================================================
// Encantis Compiler
// Main entry point: exports parse(), check(), and compile()
// =============================================================================

import type {
  Body, CheckResult, Decl, Diagnostic, Expr, ExportDecl, FuncDecl,
  GlobalDecl, ImportDecl, MemoryDecl, Module, ParseResult, Span, Stmt, Type, SymbolTable,
} from './types';

import { check as doCheck } from './checker';
import { parse as doParse } from './parser2';

// Re-export types for consumers
export type { Diagnostic, ParseResult, CheckResult, Module, Span };

// -----------------------------------------------------------------------------
// Source Mapping (for WAT preview click-to-source)
// -----------------------------------------------------------------------------

export interface SourceMapping {
  watLine: number;
  sourceSpan: Span;
}

// -----------------------------------------------------------------------------
// Parse API
// -----------------------------------------------------------------------------

export function parse(src: string): ParseResult {
  return doParse(src);
}

// -----------------------------------------------------------------------------
// Check API
// -----------------------------------------------------------------------------

export function check(parseResult: ParseResult, src: string): CheckResult {
  return doCheck(parseResult, src);
}

export function analyze(src: string): CheckResult {
  const parseResult = parse(src);
  return check(parseResult, src);
}

// -----------------------------------------------------------------------------
// Compile API
// -----------------------------------------------------------------------------

export function compile(src: string): string {
  const result = compileWithSourceMap(src);
  return result.wat;
}

export function compileWithSourceMap(src: string): { wat: string; sourceMap: SourceMapping[] } {
  const parseResult = parse(src);
  const checkResult = check(parseResult, src);

  if (checkResult.errors.some(e => e.severity === 'error')) {
    const errorLines = checkResult.errors
      .filter(e => e.severity === 'error')
      .map(e => `;; ERROR: ${e.message}`);
    return { wat: `;; Compilation failed\n${errorLines.join('\n')}`, sourceMap: [] };
  }

  return generateWat(parseResult.ast, checkResult.symbols, src);
}

// -----------------------------------------------------------------------------
// Code Generation Context
// -----------------------------------------------------------------------------

interface CodeGenContext {
  output: string[];
  indent: number;
  strings: Map<string, number>;
  stringOffset: number;
  src: string;
  sourceMap: SourceMapping[];
  globals: Set<string>;
  symbols: SymbolTable;
  currentFunc?: FuncDecl;
}

function emit(ctx: CodeGenContext, line: string): void {
  ctx.output.push('  '.repeat(ctx.indent) + line);
}

function emitWithSpan(ctx: CodeGenContext, line: string, span?: Span): void {
  const watLine = ctx.output.length;
  ctx.output.push('  '.repeat(ctx.indent) + line);
  if (span) {
    ctx.sourceMap.push({ watLine, sourceSpan: span });
  }
}

// -----------------------------------------------------------------------------
// Type Helpers
// -----------------------------------------------------------------------------

function typeToWat(type: Type): string {
  switch (type.kind) {
    case 'PrimitiveType': {
      if (type.name === 'f64') return 'f64';
      if (type.name === 'f32') return 'f32';
      if (type.name === 'i64' || type.name === 'u64') return 'i64';
      return 'i32';
    }
    case 'SliceType': return 'i32 i32';
    case 'PointerType': return 'i32';
    case 'TupleType': return type.elements.map(typeToWat).join(' ');
    default: return 'i32';
  }
}

function getWatPrefix(type: Type | undefined): string {
  if (!type || type.kind !== 'PrimitiveType') return 'i32';
  switch (type.name) {
    case 'f64': return 'f64';
    case 'f32': return 'f32';
    case 'i64': case 'u64': return 'i64';
    default: return 'i32';
  }
}

function inferExprType(ctx: CodeGenContext, expr: Expr): Type | undefined {
  switch (expr.kind) {
    case 'Identifier': {
      const funcScope = ctx.currentFunc ? ctx.symbols.scopes.get(ctx.currentFunc) : undefined;
      let sym = funcScope?.symbols.get(expr.name);
      if (!sym) sym = ctx.symbols.global.symbols.get(expr.name);
      return sym?.type;
    }
    case 'NumberLit': {
      if (expr.value.includes('.') || expr.value.includes('e') || expr.value.includes('E')) {
        return { kind: 'PrimitiveType', name: 'f64', span: expr.span };
      }
      return { kind: 'PrimitiveType', name: 'i32', span: expr.span };
    }
    case 'BinaryExpr': {
      const leftType = inferExprType(ctx, expr.left);
      return leftType;
    }
    default:
      return undefined;
  }
}

// -----------------------------------------------------------------------------
// WAT Generation
// -----------------------------------------------------------------------------

function generateWat(module: Module, symbols: SymbolTable, src: string): { wat: string; sourceMap: SourceMapping[] } {
  const ctx: CodeGenContext = {
    output: [],
    indent: 0,
    strings: new Map(),
    stringOffset: 0,
    src,
    sourceMap: [],
    globals: new Set(),
    symbols,
  };

  // Collect globals first
  for (const decl of module.decls) {
    if (decl.kind === 'GlobalDecl') {
      ctx.globals.add(decl.name);
    }
  }

  emit(ctx, '(module');
  ctx.indent++;

  // Generate imports
  for (const decl of module.decls) {
    if (decl.kind === 'ImportDecl') {
      generateImport(ctx, decl);
    }
  }

  // Generate globals
  for (const decl of module.decls) {
    if (decl.kind === 'GlobalDecl') {
      generateGlobal(ctx, decl);
    }
  }

  // Generate exports (functions and memory)
  for (const decl of module.decls) {
    if (decl.kind === 'ExportDecl') {
      generateExport(ctx, decl);
    }
  }

  // Generate non-exported functions
  for (const decl of module.decls) {
    if (decl.kind === 'FuncDecl' && decl.name) {
      generateFunction(ctx, decl);
    }
  }

  // Generate memory if needed for strings
  const hasMemory = module.decls.some(d =>
    d.kind === 'MemoryDecl' ||
    (d.kind === 'ExportDecl' && d.decl.kind === 'MemoryDecl')
  );
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

  return { wat: ctx.output.join('\n'), sourceMap: ctx.sourceMap };
}

function generateImport(ctx: CodeGenContext, imp: ImportDecl): void {
  for (const item of imp.items) {
    if (item.item.kind === 'func') {
      const sig = item.item.signature;
      const params = sig.params.map(p => `(param ${typeToWat(p.type)})`).join(' ');
      const returns = sig.returns;
      let result = '';
      if (returns) {
        if ('kind' in returns && returns.kind === 'NamedReturns') {
          result = `(result ${returns.fields.map(f => typeToWat(f.type)).join(' ')})`;
        } else {
          result = `(result ${typeToWat(returns as Type)})`;
        }
      }
      emitWithSpan(ctx, `(func $${item.externalName} (import "${imp.module}" "${item.externalName}") ${params} ${result})`, imp.span);
    } else if (item.item.kind === 'memory') {
      emitWithSpan(ctx, `(memory (import "${imp.module}" "${item.externalName}") ${item.item.pages})`, imp.span);
    }
  }
}

function generateGlobal(ctx: CodeGenContext, global: GlobalDecl): void {
  const watType = global.type ? typeToWat(global.type) : 'i32';
  const initValue = global.init?.kind === 'NumberLit' ? global.init.value : '0';
  emit(ctx, `(global $${global.name} (mut ${watType}) (${watType}.const ${initValue}))`);
}

function generateExport(ctx: CodeGenContext, exp: ExportDecl): void {
  if (exp.decl.kind === 'FuncDecl') {
    generateFunction(ctx, exp.decl, exp.exportName);
  } else if (exp.decl.kind === 'MemoryDecl') {
    emitWithSpan(ctx, `(memory (export "${exp.exportName}") ${exp.decl.minPages})`, exp.decl.span);
  }
}

function generateFunction(ctx: CodeGenContext, func: FuncDecl, exportName?: string): void {
  ctx.currentFunc = func;
  const name = func.name || exportName || 'anonymous';
  const exportClause = exportName ? `(export "${exportName}")` : '';

  // Build params
  const params = func.signature.params
    .filter(p => p.name)
    .map(p => `(param $${p.name} ${typeToWat(p.type)})`).join(' ');

  // Build results
  let results = '';
  const returns = func.signature.returns;
  if (returns) {
    if ('kind' in returns && returns.kind === 'NamedReturns') {
      results = `(result ${returns.fields.map(f => typeToWat(f.type)).join(' ')})`;
    } else {
      results = `(result ${typeToWat(returns as Type)})`;
    }
  }

  emitWithSpan(ctx, `(func $${name} ${exportClause} ${params} ${results}`.trim(), func.span);
  ctx.indent++;

  // Collect locals from body
  if (func.body.kind === 'BlockBody') {
    for (const stmt of func.body.stmts) {
      if (stmt.kind === 'LetStmt' && stmt.pattern.kind === 'IdentPattern' && stmt.type) {
        emit(ctx, `(local $${stmt.pattern.name} ${typeToWat(stmt.type)})`);
      }
    }
  }

  // Named returns are also locals
  if (returns && 'kind' in returns && returns.kind === 'NamedReturns') {
    for (const ret of returns.fields) {
      emit(ctx, `(local $${ret.name} ${typeToWat(ret.type)})`);
    }
  }

  // Generate body
  generateBody(ctx, func.body, func);

  ctx.indent--;
  emit(ctx, ')');
  ctx.currentFunc = undefined;
}

function generateBody(ctx: CodeGenContext, body: Body, func: FuncDecl): void {
  if (body.kind === 'ArrowBody') {
    generateExpr(ctx, body.expr);
  } else {
    for (const stmt of body.stmts) {
      generateStmt(ctx, stmt);
    }
    // Return named return values
    const returns = func.signature.returns;
    if (returns && 'kind' in returns && returns.kind === 'NamedReturns') {
      for (const ret of returns.fields) {
        emit(ctx, `(local.get $${ret.name})`);
      }
    }
  }
}

function generateStmt(ctx: CodeGenContext, stmt: Stmt): void {
  switch (stmt.kind) {
    case 'LetStmt':
      if (stmt.init && stmt.pattern.kind === 'IdentPattern') {
        generateExpr(ctx, stmt.init);
        emit(ctx, `(local.set $${stmt.pattern.name})`);
      }
      break;

    case 'AssignStmt':
      generateExpr(ctx, stmt.value);
      if (stmt.target.kind === 'Identifier') {
        const isGlobal = ctx.globals.has(stmt.target.name);
        emit(ctx, `(${isGlobal ? 'global' : 'local'}.set $${stmt.target.name})`);
      }
      break;

    case 'ExprStmt':
      generateExpr(ctx, stmt.expr);
      emit(ctx, '(drop)');
      break;

    case 'ReturnStmt':
      if (stmt.value) {
        generateExpr(ctx, stmt.value);
        emit(ctx, '(return)');
      }
      break;

    case 'IfStmt':
      generateExpr(ctx, stmt.condition);
      emit(ctx, '(if');
      ctx.indent++;
      emit(ctx, '(then');
      ctx.indent++;
      if (stmt.thenBody.kind === 'BlockBody') {
        for (const s of stmt.thenBody.stmts) generateStmt(ctx, s);
      }
      ctx.indent--;
      emit(ctx, ')');
      if (stmt.elseBody) {
        emit(ctx, '(else');
        ctx.indent++;
        if (stmt.elseBody.kind === 'BlockBody') {
          for (const s of stmt.elseBody.stmts) generateStmt(ctx, s);
        }
        ctx.indent--;
        emit(ctx, ')');
      }
      ctx.indent--;
      emit(ctx, ')');
      break;

    case 'WhileStmt':
      emit(ctx, '(block $break');
      ctx.indent++;
      emit(ctx, '(loop $continue');
      ctx.indent++;
      generateExpr(ctx, stmt.condition);
      emit(ctx, '(i32.eqz)');
      emit(ctx, '(br_if $break)');
      if (stmt.body.kind === 'BlockBody') {
        for (const s of stmt.body.stmts) generateStmt(ctx, s);
      }
      emit(ctx, '(br $continue)');
      ctx.indent--;
      emit(ctx, ')');
      ctx.indent--;
      emit(ctx, ')');
      break;

    default:
      emit(ctx, `;; TODO: ${stmt.kind}`);
  }
}

function generateExpr(ctx: CodeGenContext, expr: Expr): void {
  switch (expr.kind) {
    case 'NumberLit': {
      const type = inferExprType(ctx, expr);
      const prefix = getWatPrefix(type);
      emit(ctx, `(${prefix}.const ${expr.value})`);
      break;
    }

    case 'StringLit': {
      const offset = registerString(ctx, expr.value);
      emit(ctx, `(i32.const ${offset})`);
      emit(ctx, `(i32.const ${expr.value.length})`);
      break;
    }

    case 'BoolLit':
      emit(ctx, `(i32.const ${expr.value ? '1' : '0'})`);
      break;

    case 'Identifier':
      if (ctx.globals.has(expr.name)) {
        emit(ctx, `(global.get $${expr.name})`);
      } else {
        emit(ctx, `(local.get $${expr.name})`);
      }
      break;

    case 'BinaryExpr': {
      const leftType = inferExprType(ctx, expr.left);
      const prefix = getWatPrefix(leftType);
      const isFloat = prefix === 'f64' || prefix === 'f32';

      generateExpr(ctx, expr.left);
      generateExpr(ctx, expr.right);

      const opMap: Record<string, string> = {
        '+': `${prefix}.add`,
        '-': `${prefix}.sub`,
        '*': `${prefix}.mul`,
        '/': isFloat ? `${prefix}.div` : `${prefix}.div_s`,
        '%': `${prefix}.rem_s`,
        '&': `${prefix}.and`,
        '|': `${prefix}.or`,
        '^': `${prefix}.xor`,
        '<<': `${prefix}.shl`,
        '>>': `${prefix}.shr_s`,
        '<': isFloat ? `${prefix}.lt` : `${prefix}.lt_s`,
        '>': isFloat ? `${prefix}.gt` : `${prefix}.gt_s`,
        '<=': isFloat ? `${prefix}.le` : `${prefix}.le_s`,
        '>=': isFloat ? `${prefix}.ge` : `${prefix}.ge_s`,
        '==': `${prefix}.eq`,
        '!=': `${prefix}.ne`,
      };
      emit(ctx, `(${opMap[expr.op] || `${prefix}.add`})`);
      break;
    }

    case 'UnaryExpr':
      generateExpr(ctx, expr.operand);
      if (expr.op === '-') {
        const type = inferExprType(ctx, expr.operand);
        const prefix = getWatPrefix(type);
        if (prefix === 'f64' || prefix === 'f32') {
          emit(ctx, `(${prefix}.neg)`);
        } else {
          emit(ctx, `(${prefix}.const -1)`);
          emit(ctx, `(${prefix}.mul)`);
        }
      } else if (expr.op === '!') {
        emit(ctx, '(i32.eqz)');
      }
      break;

    case 'CallExpr': {
      for (const arg of expr.args) {
        generateExpr(ctx, arg.value);
      }
      if (expr.callee.kind === 'Identifier') {
        const name = expr.callee.name;
        // Float builtins (default to f64)
        const floatBuiltins: Record<string, string> = {
          sqrt: 'f64.sqrt', abs: 'f64.abs', ceil: 'f64.ceil',
          floor: 'f64.floor', trunc: 'f64.trunc', nearest: 'f64.nearest',
          min: 'f64.min', max: 'f64.max', copysign: 'f64.copysign',
        };
        // Integer builtins (default to i32)
        const intBuiltins: Record<string, string> = {
          clz: 'i32.clz', ctz: 'i32.ctz', popcnt: 'i32.popcnt',
        };
        // Memory builtins
        const memBuiltins: Record<string, string> = {
          'memory-size': 'memory.size', 'memory-grow': 'memory.grow',
        };

        if (floatBuiltins[name]) {
          emit(ctx, `(${floatBuiltins[name]})`);
        } else if (intBuiltins[name]) {
          emit(ctx, `(${intBuiltins[name]})`);
        } else if (memBuiltins[name]) {
          emit(ctx, `(${memBuiltins[name]})`);
        } else {
          emit(ctx, `(call $${name})`);
        }
      }
      break;
    }

    case 'TupleLit':
      for (const elem of expr.elements) {
        generateExpr(ctx, elem.value);
      }
      break;

    case 'IndexExpr':
      generateExpr(ctx, expr.target);
      generateExpr(ctx, expr.index);
      emit(ctx, '(i32.add)');
      emit(ctx, '(i32.load)');
      break;

    case 'MemberExpr':
      generateExpr(ctx, expr.target);
      // Basic member access - would need more sophisticated handling
      break;

    default:
      emit(ctx, `;; TODO: ${expr.kind}`);
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function registerString(ctx: CodeGenContext, str: string): number {
  const existing = ctx.strings.get(str);
  if (existing !== undefined) return existing;
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
