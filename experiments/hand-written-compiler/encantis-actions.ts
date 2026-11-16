import type * as ohm from 'ohm-js'

type OhmNode = ohm.Node
type SemanticAction = (this: OhmNode, ...args: OhmNode[]) => unknown

// Semantics operations object with typed handlers
// Each method corresponds to a grammar rule and transforms Ohm nodes to AST nodes
const astActions: Record<string, SemanticAction> = {
  // Helper to process lists of children generally
  _iter(...children) {
    return children.map((c) => c.toAST())
  },

  // By default terminals return their source string
  _terminal() {
    return this.sourceString
  },

  // Turn lists into lists of AST nodes
  NonemptyListOf(first, _sep, rest) {
    return [first.toAST(), ...rest.toAST()]
  },

  utf8String(_open, chars, _close) {
    console.log(this)
    return chars.sourceString
  },

  stringLiteral(chars) {
    console.log(this)
    return chars.sourceString
  },

  decimalLiteral(neg, digits) {
    return {
      type: 'IntLiteral',
      base: 10,
      value: parseInt(neg.sourceString + digits.sourceString.replaceAll('_', ''), 10),
    }
  },

  hexLiteral(neg, _0x, hexDigits) {
    return {
      type: 'IntLiteral',
      base: 16,
      value: parseInt(neg.sourceString + hexDigits.sourceString.replaceAll('_', ''), 16),
    }
  },

  binaryLiteral(neg, _0b, binDigits) {
    return {
      type: 'IntLiteral',
      base: 2,
      value: parseInt(neg.sourceString + binDigits.sourceString.replaceAll('_', ''), 2),
    }
  },

  octalLiteral(neg, _0o, octDigits) {
    return {
      type: 'IntLiteral',
      base: 8,
      value: parseInt(neg.sourceString + octDigits.sourceString.replaceAll('_', ''), 8),
    }
  },

  dozenalLiteral(neg, _0d, dozDigits) {
    return {
      type: 'IntLiteral',
      base: 12,
      value: parseInt(neg.sourceString + dozDigits.sourceString.replaceAll('_', ''), 12),
    }
  },

  floatLiteral(_neg, _intPart, _dot, _fracPart, _expPart) {
    return {
      type: 'FloatLiteral',
      value: parseFloat(this.sourceString),
    }
  },

  // PostfixExpr = PrimaryExpr PostfixOp*
  PostfixExpr(primary, postfixes) {
    let expr = primary.toAST()
    for (const postfix of postfixes.children) {
      const op = postfix.toAST()
      throw new Error('Postfix operations not implemented yet')
      // if (op.type === 'FieldAccess') {
      //   expr = {
      //     type: 'FieldAccessExpr',
      //     object: expr,
      //     fieldName: op.fieldName,
      //   }
      // } else if (op.type === 'FunctionCall') {
      //   expr = {
      //     type: 'FunctionCallExpr',
      //     callee: expr,
      //     arguments: op.arguments,
      //   }
      // }
    }
    return expr
  },

  // PrimaryExpr = typeIdent ("(" ArgList? ")")?  -- constructor
  PrimaryExpr_constructor(typeIdent, _lb, argListOpt, _rb) {
    if (argListOpt.children.length > 0) {
      const argsNode = argListOpt.children[0]
      return {
        type: 'TypeConstructor',
        name: typeIdent.sourceString,
        args: argsNode.toAST(),
      }
    } else {
      return {
        type: 'TypeConstructor',
        name: typeIdent.sourceString,
      }
    }
  },

  EnumDecl(_this, ident, _lb, variants, _rb) {
    return {
      type: 'EnumDecl',
      name: ident.sourceString,
      members: variants.children.map((variant) => variant.toAST()),
    }
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

  // BaseType = "&" Type -- reference
  BaseType_reference(_amp, type) {
    return {
      type: 'ReferenceType',
      name: type.sourceString,
    }
  },
}

// Create semantics instance and add operations (consumer provides grammar)
export function createSemantics(grammar: ohm.Grammar): ohm.Semantics {
  return grammar.createSemantics().addOperation<unknown>('toAST', astActions)
}
