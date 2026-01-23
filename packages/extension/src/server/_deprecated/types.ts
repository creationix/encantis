// =============================================================================
// Encantis Compiler Types
// Re-exports parser2 types and adds checker/LSP-specific types
// =============================================================================

// Re-export everything from parser2
export * from './parser2';

// Import types we need for additional definitions
import type { Span, Type, FuncDecl } from './parser2';

// -----------------------------------------------------------------------------
// Symbol Table (for checker)
// -----------------------------------------------------------------------------

export type SymbolKind = 'local' | 'param' | 'global' | 'function' | 'import' | 'define' | 'type' | 'builtin';

export interface Symbol {
  name: string;
  kind: SymbolKind;
  type?: Type;
  span: Span;
  mutable?: boolean;
}

export interface Scope {
  parent?: Scope;
  symbols: Map<string, Symbol>;
}

export interface SymbolTable {
  global: Scope;
  scopes: Map<FuncDecl, Scope>;
}

// -----------------------------------------------------------------------------
// Check Result
// -----------------------------------------------------------------------------

export interface CheckResult {
  errors: import('./parser2').Diagnostic[];
  symbols: SymbolTable;
}
