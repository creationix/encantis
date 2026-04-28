// Type parsing and stringifying library
// Parses type strings using the Encantis grammar and converts to/from ResolvedType

import { grammar, semantics } from './encantis-grammar'
import type * as AST from './ast'
import {
  type ResolvedType,
  type ArraySize,
  primitive,
  pointer,
  array,
  slice,
  manyPointer,
  tuple,
  field,
  comptimeInt,
  comptimeFloat,
} from './types'

// Parse a type string to AST.Type
export function parseTypeAST(s: string): AST.Type {
  const match = grammar.match(s, 'Type')
  if (match.failed()) {
    throw new Error(`Failed to parse type: ${s}\n${match.message}`)
  }
  return semantics(match).toAST() as AST.Type
}

// Convert AST.Type to ResolvedType
export function astToResolved(ast: AST.Type): ResolvedType {
  switch (ast.kind) {
    case 'PrimitiveType':
      return primitive(ast.name)

    case 'PointerType':
      return pointer(astToResolved(ast.pointee))

    case 'IndexedType': {
      const element = astToResolved(ast.element)

      // Many-pointer [*]T - pointer to unbounded array
      if (ast.manyPointer) {
        return manyPointer(element)
      }

      // Slice []T - fat pointer (ptr + len)
      if (ast.size === null && ast.specifiers.length === 0) {
        return slice(element)
      }

      // Build sizes array from size and specifiers
      const sizes: ArraySize[] = []

      // Add numeric size(s) if present
      if (ast.size !== null && ast.size !== 'inferred' && ast.size !== 'comptime') {
        if (Array.isArray(ast.size)) {
          sizes.push(...ast.size)
        } else {
          sizes.push(ast.size)
        }
      } else if (ast.size === 'inferred' || ast.size === 'comptime') {
        sizes.push('_')
      }

      // Add framing specifiers (! for null-terminated, ? for LEB prefix)
      for (const spec of ast.specifiers) {
        sizes.push(spec.kind === 'null' ? '!' : '?')
      }

      return array(element, sizes.length > 0 ? sizes : null)
    }

    case 'CompositeType':
      return tuple(
        ast.fields.map((f) => field(f.ident, astToResolved(f.type))),
      )

    case 'ComptimeIntType':
      return comptimeInt(ast.value)

    case 'ComptimeFloatType':
      return comptimeFloat(ast.value)

    case 'TypeRef':
      throw new Error(`TypeRef '${ast.name}' cannot be resolved without context`)

    case 'FuncType':
      throw new Error(`FuncType cannot be resolved in this context`)
  }
}

// Parse type string directly to ResolvedType
export function parseType(s: string): ResolvedType {
  const ast = parseTypeAST(s)
  return astToResolved(ast)
}
