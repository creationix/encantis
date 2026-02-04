import type * as ohm from 'ohm-js'

type OhmNode = ohm.Node
type SemanticAction = (this: OhmNode, ...args: OhmNode[]) => unknown

// Semantics operations object with typed handlers
// Each method corresponds to a grammar rule and transforms Ohm nodes to AST nodes
const astActions: Record<string, SemanticAction> = {
  EnumDecl(_this, ident, _lb, variants, _rb) {
    return {
      type: 'EnumDecl',
      name: ident.sourceString,
      members: variants.children.map((variant) => variant.toAST()),
    }
  },

  _iter(...children) {
    return children.map((c) => c.toAST())
  },

  NonemptyListOf(first, _sep, rest) {
    return [first.toAST(), ...rest.toAST()]
  },

  // EnumVariant = typeIdent ("(" FieldList ")")? ","?
  EnumVariant(ident, _lb, fieldsOpt, _rb, _comma) {
    if (fieldsOpt.children.length > 0) {
      const fieldsNode = fieldsOpt.children[0]
      return {
        type: 'EnumVariant',
        name: ident.sourceString,
        fields: fieldsNode.toAST(),
      }
    } else {
      return {
        type: 'EnumVariant',
        name: ident.sourceString,
        fields: [],
      }
    }
  },

  // Field = ident TypeAnnotation  -- named
  Field_named(name, type) {
    return {
      type: 'Field',
      name: name.sourceString,
      fieldType: type.toAST(),
    }
  },

  // Field = Type                  -- anonymous
  Field_anonymous(typeIdent) {
    return {
      type: 'Field',
      name: null,
      fieldType: typeIdent.toAST(),
    }
  },

  TypeAnnotation(_colon, typeIdent) {
    return typeIdent.toAST()
  },

  _terminal() {
    return this.sourceString
  },

  // BaseType = "&" Type -- reference
  BaseType_reference(_amp, type) {
    return {
      type: 'ReferenceType',
      name: type.sourceString,
    }
  },

  // ident = ~keyword lowerStart identChar*
  ident(_start, _rest) {
    return this.sourceString
  },
}

// Create semantics instance and add operations (consumer provides grammar)
export function createSemantics(grammar: ohm.Grammar): ohm.Semantics {
  return grammar.createSemantics().addOperation<unknown>('toAST', astActions)
}
