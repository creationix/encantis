// Type parsing and stringifying library
// Parses type strings using the Encantis grammar and converts to/from ResolvedType

import { grammar, semantics } from './grammar/actions'
import type * as AST from './ast'
import {
  type ResolvedType,
  type IndexSpecifierRT,
  primitive,
  pointer,
  indexed,
  tuple,
  field,
  comptimeInt,
  comptimeFloat,
  named,
} from './types'

// Parse a type string to AST.Type
export function parseTypeAST(s: string): AST.Type {
  const match = grammar.match(s, 'Type')
  if (match.failed()) {
    throw new Error(`Failed to parse type: ${s}\n${match.message}`)
  }
  return semantics(match).toAST() as AST.Type
}

// Convert AST.IndexSpecifier to IndexSpecifierRT
function astSpecifierToResolved(spec: AST.IndexSpecifier): IndexSpecifierRT {
  if (spec.kind === 'null') {
    return { kind: 'null' }
  }
  return { kind: 'prefix', prefixType: spec.prefixType }
}

// Convert AST.Type to ResolvedType
export function astToResolved(ast: AST.Type): ResolvedType {
  switch (ast.kind) {
    case 'PrimitiveType':
      return primitive(ast.name)

    case 'PointerType':
      return pointer(astToResolved(ast.pointee))

    case 'IndexedType': {
      // Handle 'inferred' size - convert to null (slice) until context provides size
      const size = ast.size === 'inferred' ? null : ast.size
      return indexed(
        astToResolved(ast.element),
        size,
        ast.specifiers.map(astSpecifierToResolved),
      )
    }

    case 'CompositeType':
      return tuple(
        ast.fields.map((f) => field(f.ident, astToResolved(f.type))),
      )

    case 'TaggedType':
      // Tagged type creates a unique named type
      return named(ast.tag, astToResolved(ast.type), true)

    case 'ComptimeIntType':
      return comptimeInt(ast.value)

    case 'ComptimeFloatType':
      return comptimeFloat(ast.value)

    case 'TypeRef':
      throw new Error(`TypeRef '${ast.name}' cannot be resolved without context`)
  }
}

// Parse type string directly to ResolvedType
export function parseType(s: string): ResolvedType {
  const ast = parseTypeAST(s)
  return astToResolved(ast)
}
