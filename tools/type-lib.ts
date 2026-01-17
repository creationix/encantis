// Type parsing and stringifying library
// Parses type strings using the Encantis grammar and converts to/from ResolvedType

import { grammar, semantics } from './grammar/actions'
import type * as AST from './ast'
import {
  type ResolvedType,
  type ResolvedField,
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

    case 'IndexedType':
      return indexed(
        astToResolved(ast.element),
        ast.size,
        ast.specifiers.map(astSpecifierToResolved),
      )

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

function specifierToString(s: IndexSpecifierRT): string {
  if (s.kind === 'null') return '/0'
  return `/${s.prefixType}`
}

// Stringify ResolvedType back to type string (parseable format)
export function typeToString(t: ResolvedType): string {
  switch (t.kind) {
    case 'primitive':
      return t.name

    case 'pointer':
      return `*${typeToString(t.pointee)}`

    case 'indexed': {
      const elem = typeToString(t.element)
      const specs = t.specifiers.map(specifierToString).join('')
      if (t.size !== null) {
        return `${elem}[${t.size}${specs}]`
      } else {
        return `${elem}[${specs}]`
      }
    }

    case 'tuple': {
      if (t.fields.length === 0) return '()'
      const fields = t.fields.map(fieldToString).join(', ')
      return `(${fields})`
    }

    case 'func': {
      const params =
        t.params.length === 0 ? '()' : `(${t.params.map(fieldToString).join(', ')})`
      if (t.returns.length === 0) return `func${params}`
      const returns =
        t.returns.length === 1 && t.returns[0].name === null
          ? typeToString(t.returns[0].type)
          : `(${t.returns.map(fieldToString).join(', ')})`
      return `func${params} -> ${returns}`
    }

    case 'void':
      return '()'

    case 'comptime_int':
      return `int(${t.value})`

    case 'comptime_float':
      return `float(${t.value})`

    case 'named':
      // For unique/tagged types, show as Type@Tag
      if (t.unique) {
        return `${typeToString(t.type)}@${t.name}`
      }
      // For aliases, just show the name
      return t.name
  }
}

function fieldToString(f: ResolvedField): string {
  if (f.name) {
    return `${f.name}: ${typeToString(f.type)}`
  }
  return typeToString(f.type)
}
