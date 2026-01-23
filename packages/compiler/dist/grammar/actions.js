import * as ohm from 'ohm-js';
import { hexToBytes } from '../utils';
// Load the grammar
const grammarPath = new URL('encantis.ohm', import.meta.url).pathname;
const grammarSource = await Bun.file(grammarPath).text();
export const grammar = ohm.grammar(grammarSource);
// Helper to create span from Ohm source interval
function span(node) {
    return {
        start: node.source.startIdx,
        end: node.source.endIdx,
    };
}
// Helper to get first child if present
function first(iter) {
    return iter.children[0]?.toAST() ?? null;
}
// Create semantics
export const semantics = grammar.createSemantics();
// Add toAST operation
semantics.addOperation('toAST', {
    // ============================================================================
    // Module
    // ============================================================================
    Module(decls) {
        return {
            kind: 'Module',
            decls: decls.children.map((d) => d.toAST()),
            span: span(this),
        };
    },
    // ============================================================================
    // Declarations
    // ============================================================================
    Declaration(decl) {
        return decl.toAST();
    },
    ImportDecl_group(_import, module, _lp, items, _rp) {
        const moduleLit = module.toAST();
        const moduleName = new TextDecoder().decode(moduleLit.value.bytes);
        return {
            kind: 'ImportDecl',
            module: moduleName,
            items: items.children.map((i) => i.toAST()),
            span: span(this),
        };
    },
    ImportDecl_single(_import, module, item) {
        const moduleLit = module.toAST();
        const moduleName = new TextDecoder().decode(moduleLit.value.bytes);
        return {
            kind: 'ImportDecl',
            module: moduleName,
            items: [item.toAST()],
            span: span(this),
        };
    },
    ImportGroupItem(name, item) {
        const nameLit = name.toAST();
        const itemName = new TextDecoder().decode(nameLit.value.bytes);
        return {
            kind: 'ImportItem',
            name: itemName,
            item: item.toAST(),
            span: span(this),
        };
    },
    ImportItem_func(_func, identOpt, sig) {
        return {
            kind: 'ImportFunc',
            ident: first(identOpt),
            signature: sig.toAST(),
            span: span(this),
        };
    },
    ImportItem_global(_global, ident, typeAnnotation) {
        return {
            kind: 'ImportGlobal',
            ident: ident.toAST(),
            type: typeAnnotation.toAST(),
            span: span(this),
        };
    },
    ImportItem_memory(_memory, size) {
        return {
            kind: 'ImportMemory',
            min: Number(size.sourceString),
            span: span(this),
        };
    },
    ExportDecl(_export, name, item) {
        const literal = name.toAST();
        const exportName = new TextDecoder().decode(literal.value.bytes);
        return {
            kind: 'ExportDecl',
            name: exportName,
            item: item.toAST(),
            span: span(this),
        };
    },
    Exportable(item) {
        return item.toAST();
    },
    FuncDecl(inlineOpt, _func, identOpt, sig, body) {
        return {
            kind: 'FuncDecl',
            inline: inlineOpt.sourceString !== '',
            ident: first(identOpt),
            signature: sig.toAST(),
            body: body.toAST(),
            span: span(this),
        };
    },
    // FuncSignature = BaseType ("->" Type)?
    // Uses symmetric input/output design
    // Ohm passes optional elements separately: BaseType, _arrow (optional iter), Type (optional iter)
    FuncSignature(input, _arrowOpt, outputOpt) {
        const inputAST = input.toAST();
        // If return is omitted, default to void (empty composite type)
        const outputAST = first(outputOpt) ?? { kind: 'CompositeType', fields: [], span: span(this) };
        return {
            kind: 'FuncSignature',
            input: inputAST,
            output: outputAST,
            span: span(this),
        };
    },
    FieldList(list) {
        return list.asIteration().children.map((f) => f.toAST());
    },
    Field_named(ident, typeAnnotation) {
        return {
            kind: 'Field',
            ident: ident.toAST(),
            type: typeAnnotation.toAST(),
            span: span(this),
        };
    },
    Field_anonymous(type) {
        return {
            kind: 'Field',
            ident: null,
            type: type.toAST(),
            span: span(this),
        };
    },
    TypeAnnotation(_colon, type) {
        return type.toAST();
    },
    Assign(_eq, expr) {
        return expr.toAST();
    },
    Body_block(block) {
        return block.toAST();
    },
    Body_arrow(_arrow, expr) {
        return {
            kind: 'ArrowBody',
            expr: expr.toAST(),
            span: span(this),
        };
    },
    Block(_lb, stmts, _rb) {
        return {
            kind: 'Block',
            stmts: stmts.children.map((s) => s.toAST()),
            span: span(this),
        };
    },
    TypeDecl(_type, ident, _eq, type) {
        return {
            kind: 'TypeDecl',
            ident: ident.toAST(),
            type: type.toAST(),
            span: span(this),
        };
    },
    DefDecl(_def, ident, assign) {
        return {
            kind: 'DefDecl',
            ident: ident.toAST(),
            value: assign.toAST(),
            span: span(this),
        };
    },
    GlobalDecl(_global, ident, typeOpt, assignOpt) {
        return {
            kind: 'GlobalDecl',
            ident: ident.toAST(),
            type: first(typeOpt),
            value: first(assignOpt),
            span: span(this),
        };
    },
    MemoryDecl(_memory, min, maxOpt, dataBlockOpt) {
        const dataBlock = first(dataBlockOpt);
        return {
            kind: 'MemoryDecl',
            min: Number(min.sourceString),
            max: first(maxOpt) ? Number(first(maxOpt)) : null,
            data: dataBlock ?? [],
            span: span(this),
        };
    },
    DataBlock(_lb, entries, _rb) {
        return entries.children.map((e) => e.toAST());
    },
    DataEntry(offset, _arrow, expr, _comma) {
        return {
            kind: 'DataEntry',
            offset: Number(offset.sourceString),
            value: expr.toAST(),
            span: span(this),
        };
    },
    // ============================================================================
    // Types
    // ============================================================================
    // Type = BaseType "->" Type   -- func
    //      | BaseType             -- base
    Type_func(inputType, _arrow, outputType) {
        return {
            kind: 'FuncType',
            input: inputType.toAST(),
            output: outputType.toAST(),
            span: span(this),
        };
    },
    Type_base(baseType) {
        return baseType.toAST();
    },
    // Zig-style array syntax: [prefix?]Type
    // - []T = slice (fat pointer with ptr+len)
    // - [*]T = many-pointer (just ptr, no length)
    // - [*:0]T = null-terminated many-pointer
    // - [*:?]T = LEB128-prefixed many-pointer
    // - [:0]T = slice with null sentinel
    // - [N]T = fixed length array (by-value)
    // - [N:0]T = fixed length array with sentinel
    BaseType_array(_lb, prefixOpt, _rb, element) {
        const prefix = first(prefixOpt);
        let size;
        let specifiers;
        if (prefix === null) {
            // []T - plain slice (no prefix)
            size = null;
            specifiers = [];
        }
        else if (prefix.kind === 'fixed') {
            // [N]T or [N:0]T - fixed size array
            size = prefix.size;
            specifiers = prefix.specifiers;
        }
        else {
            // [*]T, [*:0]T, [:0]T - runtime arrays with null size
            size = null;
            specifiers = prefix.specifiers;
        }
        return {
            kind: 'IndexedType',
            element: element.toAST(),
            size,
            specifiers,
            span: span(this),
        };
    },
    // [*]T or [*:0]T - many-pointer
    arrayTypePrefix_manyPointer(_star, sentinelsOpt) {
        const specifiers = first(sentinelsOpt) ?? [];
        return { kind: 'manyPointer', size: null, specifiers };
    },
    // [N]T or [N:0]T - fixed size array
    arrayTypePrefix_fixed(intLit, sentinelsOpt) {
        const size = Number(intLit.sourceString);
        const specifiers = first(sentinelsOpt) ?? [];
        return { kind: 'fixed', size, specifiers };
    },
    // [:0]T - slice with sentinel
    arrayTypePrefix_sliceSentinel(sentinels) {
        const specifiers = sentinels.toAST();
        return { kind: 'slice', size: null, specifiers };
    },
    // ":" sentinel (":" sentinel)* - list of sentinels like :0 or :0:?
    arraySentinelList(_colon1, firstSentinel, _moreColons, moreSentinels) {
        const specifiers = [firstSentinel.toAST()];
        // moreSentinels is an iteration of the additional sentinels
        for (const child of moreSentinels.children) {
            specifiers.push(child.toAST());
        }
        return specifiers;
    },
    // Single sentinel: 0 = null terminator, ? = LEB128 prefix
    arraySentinel(char) {
        if (char.sourceString === '0') {
            return { kind: 'null' };
        }
        else {
            return { kind: 'prefix' };
        }
    },
    BaseType_pointer(_star, type) {
        return {
            kind: 'PointerType',
            pointee: type.toAST(),
            span: span(this),
        };
    },
    BaseType_composite(_lp, fieldListOpt, _rp) {
        return {
            kind: 'CompositeType',
            fields: first(fieldListOpt) ?? [],
            span: span(this),
        };
    },
    BaseType_comptimeScalar(comptime) {
        return comptime.toAST();
    },
    BaseType_primitive(prim) {
        return prim.toAST();
    },
    BaseType_builtin(builtin) {
        return builtin.toAST();
    },
    BaseType_named(typeIdent) {
        return typeIdent.toAST();
    },
    BuiltinType(name) {
        return {
            kind: 'BuiltinType',
            name: name.sourceString,
            span: span(this),
        };
    },
    ComptimeType_int(_int, _lp, value, _rp) {
        const ast = value.toAST();
        return {
            kind: 'ComptimeIntType',
            value: ast.value.kind === 'int' ? ast.value.value : BigInt(0),
            span: span(this),
        };
    },
    ComptimeType_float(_float, _lp, value, _rp) {
        const ast = value.toAST();
        return {
            kind: 'ComptimeFloatType',
            value: ast.value.kind === 'float' ? ast.value.value : 0,
            span: span(this),
        };
    },
    PrimitiveType(name) {
        return {
            kind: 'PrimitiveType',
            name: name.sourceString,
            span: span(this),
        };
    },
    // typeIdent = "@"? upperStart identChar*
    // The @ prefix indicates a unique/nominal type
    typeIdent(_atOpt, _first, _rest) {
        return {
            kind: 'TypeRef',
            name: this.sourceString, // includes @ if present
            span: span(this),
        };
    },
    // ============================================================================
    // Statements
    // ============================================================================
    Statement(stmt) {
        return stmt.toAST();
    },
    LetStmt(_let, pattern, typeOpt, assignOpt) {
        return {
            kind: 'LetStmt',
            pattern: pattern.toAST(),
            type: first(typeOpt),
            value: first(assignOpt),
            span: span(this),
        };
    },
    SetStmt(_set, pattern, typeOpt, assign) {
        return {
            kind: 'SetStmt',
            pattern: pattern.toAST(),
            type: first(typeOpt),
            value: assign.toAST(),
            span: span(this),
        };
    },
    WhileStmt(_while, condition, body) {
        return {
            kind: 'WhileStmt',
            condition: condition.toAST(),
            body: body.toAST(),
            span: span(this),
        };
    },
    ForStmt(_for, binding, _in, iterable, body) {
        return {
            kind: 'ForStmt',
            binding: binding.toAST(),
            iterable: iterable.toAST(),
            body: body.toAST(),
            span: span(this),
        };
    },
    ForBinding_withIndex(value, _comma, index) {
        return {
            kind: 'ForBinding',
            value: value.toAST(),
            index: index.toAST(),
            span: span(this),
        };
    },
    ForBinding_valueOnly(value) {
        return {
            kind: 'ForBinding',
            value: value.toAST(),
            index: null,
            span: span(this),
        };
    },
    LoopStmt(_loop, body) {
        return {
            kind: 'LoopStmt',
            body: body.toAST(),
            span: span(this),
        };
    },
    ReturnStmt(_return, exprOpt, whenOpt) {
        return {
            kind: 'ReturnStmt',
            value: first(exprOpt),
            when: first(whenOpt),
            span: span(this),
        };
    },
    BreakStmt(_break, whenOpt) {
        return {
            kind: 'BreakStmt',
            when: first(whenOpt),
            span: span(this),
        };
    },
    ContinueStmt(_continue, whenOpt) {
        return {
            kind: 'ContinueStmt',
            when: first(whenOpt),
            span: span(this),
        };
    },
    WhenClause(_when, expr) {
        return expr.toAST();
    },
    AssignmentStmt(target, op, value) {
        return {
            kind: 'AssignmentStmt',
            target: target.toAST(),
            op: op.sourceString,
            value: value.toAST(),
            span: span(this),
        };
    },
    ExpressionStmt(expr) {
        return {
            kind: 'ExpressionStmt',
            expr: expr.toAST(),
            span: span(this),
        };
    },
    // ============================================================================
    // L-Values: ident AccessSuffix*
    // ============================================================================
    LValue(ident, suffixes) {
        let result = {
            kind: 'IdentExpr',
            name: ident.toAST(),
            span: span(ident),
        };
        for (const suffix of suffixes.children) {
            result = applySuffix(result, suffix.toAST(), span(suffix));
        }
        return result;
    },
    // ============================================================================
    // Access Suffixes (shared by LValue and PostfixExpr)
    // ============================================================================
    AccessSuffix_field(_dot, field) {
        return { kind: 'field', name: field.sourceString };
    },
    AccessSuffix_tupleIndex(_dot, digits) {
        return { kind: 'tupleIndex', value: Number(digits.sourceString) };
    },
    AccessSuffix_deref(_dot, _star) {
        return { kind: 'deref' };
    },
    AccessSuffix_typePun(_dot, type) {
        return { kind: 'typePun', type: type.toAST() };
    },
    AccessSuffix_index(_lb, expr, _rb) {
        return { kind: 'index', expr: expr.toAST() };
    },
    // ============================================================================
    // Patterns
    // ============================================================================
    Pattern_tuple(_lp, list, _rp) {
        return {
            kind: 'TuplePattern',
            elements: list.toAST(),
            span: span(this),
        };
    },
    Pattern_ident(ident) {
        return {
            kind: 'IdentPattern',
            name: ident.toAST(),
            span: span(this),
        };
    },
    PatternList(list) {
        return list.asIteration().children.map((e) => e.toAST());
    },
    PatternElem_namedExplicit(field, _colon, binding) {
        return {
            kind: 'named',
            field: field.sourceString,
            binding: binding.sourceString,
        };
    },
    PatternElem_namedShort(field, _colon) {
        return {
            kind: 'named',
            field: field.sourceString,
            binding: null,
        };
    },
    PatternElem_positional(pattern) {
        return {
            kind: 'positional',
            pattern: pattern.toAST(),
        };
    },
    // ============================================================================
    // Expressions
    // ============================================================================
    Expr(expr) {
        return expr.toAST();
    },
    OrExpr_or(left, _op, right) {
        return {
            kind: 'BinaryExpr',
            op: '||',
            left: left.toAST(),
            right: right.toAST(),
            span: span(this),
        };
    },
    OrExpr(expr) {
        return expr.toAST();
    },
    AndExpr_and(left, _op, right) {
        return {
            kind: 'BinaryExpr',
            op: '&&',
            left: left.toAST(),
            right: right.toAST(),
            span: span(this),
        };
    },
    AndExpr(expr) {
        return expr.toAST();
    },
    NotExpr_not(_op, operand) {
        return {
            kind: 'UnaryExpr',
            op: '!',
            operand: operand.toAST(),
            span: span(this),
        };
    },
    NotExpr(expr) {
        return expr.toAST();
    },
    CompareExpr_compare(left, op, right) {
        return {
            kind: 'BinaryExpr',
            op: op.sourceString,
            left: left.toAST(),
            right: right.toAST(),
            span: span(this),
        };
    },
    CompareExpr(expr) {
        return expr.toAST();
    },
    BitOrExpr_or(left, _op, right) {
        return {
            kind: 'BinaryExpr',
            op: '|',
            left: left.toAST(),
            right: right.toAST(),
            span: span(this),
        };
    },
    BitOrExpr(expr) {
        return expr.toAST();
    },
    BitXorExpr_xor(left, _op, right) {
        return {
            kind: 'BinaryExpr',
            op: '^',
            left: left.toAST(),
            right: right.toAST(),
            span: span(this),
        };
    },
    BitXorExpr(expr) {
        return expr.toAST();
    },
    BitAndExpr_and(left, _op, right) {
        return {
            kind: 'BinaryExpr',
            op: '&',
            left: left.toAST(),
            right: right.toAST(),
            span: span(this),
        };
    },
    BitAndExpr(expr) {
        return expr.toAST();
    },
    ShiftExpr_shift(left, op, right) {
        return {
            kind: 'BinaryExpr',
            op: op.sourceString,
            left: left.toAST(),
            right: right.toAST(),
            span: span(this),
        };
    },
    ShiftExpr(expr) {
        return expr.toAST();
    },
    AddExpr_add(left, op, right) {
        return {
            kind: 'BinaryExpr',
            op: op.sourceString,
            left: left.toAST(),
            right: right.toAST(),
            span: span(this),
        };
    },
    AddExpr(expr) {
        return expr.toAST();
    },
    MulExpr_mul(left, op, right) {
        return {
            kind: 'BinaryExpr',
            op: op.sourceString,
            left: left.toAST(),
            right: right.toAST(),
            span: span(this),
        };
    },
    MulExpr(expr) {
        return expr.toAST();
    },
    UnaryExpr_neg(_op, operand) {
        return {
            kind: 'UnaryExpr',
            op: '-',
            operand: operand.toAST(),
            span: span(this),
        };
    },
    UnaryExpr_complement(_op, operand) {
        return {
            kind: 'UnaryExpr',
            op: '~',
            operand: operand.toAST(),
            span: span(this),
        };
    },
    UnaryExpr_ref(_op, operand) {
        return {
            kind: 'UnaryExpr',
            op: '&',
            operand: operand.toAST(),
            span: span(this),
        };
    },
    UnaryExpr(expr) {
        return expr.toAST();
    },
    CastExpr_cast(expr, _as, type) {
        return {
            kind: 'CastExpr',
            expr: expr.toAST(),
            type: type.toAST(),
            span: span(this),
        };
    },
    CastExpr_annotation(expr, typeAnnotation) {
        return {
            kind: 'AnnotationExpr',
            expr: expr.toAST(),
            type: typeAnnotation.toAST(),
            span: span(this),
        };
    },
    CastExpr(expr) {
        return expr.toAST();
    },
    // ============================================================================
    // Postfix: PrimaryExpr PostfixOp*
    // ============================================================================
    PostfixExpr(primary, ops) {
        let result = primary.toAST();
        for (const op of ops.children) {
            result = applyPostfixOp(result, op.toAST(), span(op));
        }
        return result;
    },
    PostfixOp(suffix) {
        return suffix.toAST();
    },
    PostfixOp_call(_lp, argsOpt, _rp) {
        return { kind: 'call', args: first(argsOpt) ?? [] };
    },
    // ============================================================================
    // Primary Expressions
    // ============================================================================
    PrimaryExpr(expr) {
        // Handle ident specially - it returns a string but needs to be IdentExpr here
        if (expr.ctorName === 'ident') {
            return {
                kind: 'IdentExpr',
                name: expr.toAST(),
                span: span(expr),
            };
        }
        return expr.toAST();
    },
    PrimaryExpr_tupleOrStruct(_lp, args, _rp) {
        return {
            kind: 'TupleExpr',
            elements: args.toAST(),
            span: span(this),
        };
    },
    PrimaryExpr_group(_lp, expr, _rp) {
        return {
            kind: 'GroupExpr',
            expr: expr.toAST(),
            span: span(this),
        };
    },
    PrimaryExpr_unit(_lp, _rp) {
        return {
            kind: 'TupleExpr',
            elements: [],
            span: span(this),
        };
    },
    PrimaryExpr_constructor(typeName, _lp, argsOpt, _rp) {
        return {
            kind: 'CallExpr',
            callee: {
                kind: 'IdentExpr',
                name: typeName.sourceString,
                span: span(typeName),
            },
            args: first(argsOpt) ?? [],
            span: span(this),
        };
    },
    // ============================================================================
    // If Expression
    // ============================================================================
    IfExpr(_if, condition, then, elifs, elseOpt) {
        return {
            kind: 'IfExpr',
            condition: condition.toAST(),
            thenBranch: then.toAST(),
            elifs: elifs.children.map((e) => e.toAST()),
            else_: first(elseOpt),
            span: span(this),
        };
    },
    ElifBranch(_elif, condition, then) {
        return {
            kind: 'ElifBranch',
            condition: condition.toAST(),
            thenBranch: then.toAST(),
            span: span(this),
        };
    },
    ElseBranch(_else, body) {
        return body.toAST();
    },
    // ============================================================================
    // Match Expression
    // ============================================================================
    MatchExpr(_match, subject, _lb, arms, _rb) {
        return {
            kind: 'MatchExpr',
            subject: subject.toAST(),
            arms: arms.children.map((a) => a.toAST()),
            span: span(this),
        };
    },
    MatchArm(patterns, _arrow, body) {
        return {
            kind: 'MatchArm',
            patterns: patterns.toAST(),
            body: body.toAST(),
            span: span(this),
        };
    },
    MatchPatterns(list) {
        return list.asIteration().children.map((p) => p.toAST());
    },
    MatchPattern_literal(lit) {
        return {
            kind: 'literal',
            value: lit.toAST().value,
        };
    },
    MatchPattern_wildcard(_underscore) {
        return { kind: 'wildcard' };
    },
    // ============================================================================
    // Arguments
    // ============================================================================
    ArgList(list) {
        return list.asIteration().children.map((a) => a.toAST());
    },
    Arg_named(name, _colon, expr) {
        return {
            kind: 'Arg',
            name: name.sourceString,
            value: expr.toAST(),
            span: span(this),
        };
    },
    Arg_shorthand(name, _colon) {
        return {
            kind: 'Arg',
            name: name.sourceString,
            value: null,
            span: span(this),
        };
    },
    Arg_positional(expr) {
        return {
            kind: 'Arg',
            name: null,
            value: expr.toAST(),
            span: span(this),
        };
    },
    // ============================================================================
    // Literals
    // ============================================================================
    literal(lit) {
        return lit.toAST();
    },
    ArrayLiteral(_lb, elements, _rb) {
        return {
            kind: 'ArrayExpr',
            elements: elements.asIteration().children.map((e) => e.toAST()),
            span: span(this),
        };
    },
    numberLiteral(num) {
        return num.toAST();
    },
    intLiteral(negOpt, num) {
        const isNeg = negOpt.sourceString === '-';
        const ast = num.toAST();
        if (isNeg && ast.value.kind === 'int') {
            ast.value.value = -ast.value.value;
        }
        return ast;
    },
    decimalLiteral(_digits) {
        return {
            kind: 'LiteralExpr',
            value: { kind: 'int', value: BigInt(this.sourceString), radix: 10 },
            span: span(this),
        };
    },
    hexLiteral(_prefix, _digits) {
        return {
            kind: 'LiteralExpr',
            value: { kind: 'int', value: BigInt(this.sourceString), radix: 16 },
            span: span(this),
        };
    },
    binaryLiteral(_prefix, _digits) {
        return {
            kind: 'LiteralExpr',
            value: { kind: 'int', value: BigInt(this.sourceString), radix: 2 },
            span: span(this),
        };
    },
    octalLiteral(_prefix, _digits) {
        return {
            kind: 'LiteralExpr',
            value: { kind: 'int', value: BigInt(this.sourceString), radix: 8 },
            span: span(this),
        };
    },
    dozenalLiteral(_prefix, _digits) {
        const str = this.sourceString.slice(2);
        let value = 0n;
        for (const c of str) {
            value *= 12n;
            if (c >= '0' && c <= '9') {
                value += BigInt(c.charCodeAt(0) - 48);
            }
            else if (c === 'a' || c === 'A') {
                value += 10n;
            }
            else if (c === 'b' || c === 'B') {
                value += 11n;
            }
        }
        return {
            kind: 'LiteralExpr',
            value: { kind: 'int', value, radix: 12 },
            span: span(this),
        };
    },
    floatLiteral(_neg, _int, _dot, _frac, _exp) {
        return {
            kind: 'LiteralExpr',
            value: { kind: 'float', value: parseFloat(this.sourceString) },
            span: span(this),
        };
    },
    stringLiteral(str) {
        return str.toAST();
    },
    utf8String(_lq, chars, _rq) {
        const str = chars.children.map((c) => c.toAST()).join('');
        const bytes = new TextEncoder().encode(str);
        return {
            kind: 'LiteralExpr',
            value: { kind: 'string', bytes },
            span: span(this),
        };
    },
    charString(_lq, chars, _rq) {
        const str = chars.children.map((c) => c.toAST()).join('');
        const bytes = new TextEncoder().encode(str);
        return {
            kind: 'LiteralExpr',
            value: { kind: 'string', bytes },
            span: span(this),
        };
    },
    hexString(_prefix, hexChars, _rq) {
        const hex = hexChars.sourceString.replace(/\s+/g, '');
        const bytes = hexToBytes(hex);
        return {
            kind: 'LiteralExpr',
            value: { kind: 'string', bytes },
            span: span(this),
        };
    },
    base64String(_prefix, b64Chars, _rq) {
        const b64 = b64Chars.sourceString.replace(/\s+/g, '');
        // Decode base64 to bytes
        const binStr = atob(b64);
        const bytes = new Uint8Array(binStr.length);
        for (let i = 0; i < binStr.length; i++) {
            bytes[i] = binStr.charCodeAt(i);
        }
        return {
            kind: 'LiteralExpr',
            value: { kind: 'string', bytes },
            span: span(this),
        };
    },
    utf8Char(char) {
        return char.toAST();
    },
    escapeSeq_hex(_backslash, _x, d1, d2) {
        return String.fromCharCode(parseInt(d1.sourceString + d2.sourceString, 16));
    },
    escapeSeq_simple(_backslash, char) {
        const c = char.sourceString;
        switch (c) {
            case 'n':
                return '\n';
            case 't':
                return '\t';
            case 'r':
                return '\r';
            case '\\':
                return '\\';
            case '"':
                return '"';
            case "'":
                return "'";
            default:
                return c;
        }
    },
    boolLiteral(bool) {
        return {
            kind: 'LiteralExpr',
            value: { kind: 'bool', value: bool.sourceString === 'true' },
            span: span(this),
        };
    },
    // ============================================================================
    // Identifiers
    // ============================================================================
    ident(_first, _rest) {
        return this.sourceString;
    },
    // ============================================================================
    // Fallbacks
    // ============================================================================
    _terminal() {
        return this.sourceString;
    },
    _iter(...children) {
        return children.map((c) => c.toAST());
    },
});
// ============================================================================
// Helper: Apply suffix to build AST node
// ============================================================================
function applySuffix(base, suffix, suffixSpan) {
    switch (suffix.kind) {
        case 'field':
            return {
                kind: 'MemberExpr',
                object: base,
                member: { kind: 'field', name: suffix.name },
                span: { start: base.span.start, end: suffixSpan.end },
            };
        case 'tupleIndex':
            return {
                kind: 'MemberExpr',
                object: base,
                member: { kind: 'index', value: suffix.value },
                span: { start: base.span.start, end: suffixSpan.end },
            };
        case 'deref':
            return {
                kind: 'MemberExpr',
                object: base,
                member: { kind: 'deref' },
                span: { start: base.span.start, end: suffixSpan.end },
            };
        case 'typePun':
            return {
                kind: 'MemberExpr',
                object: base,
                member: { kind: 'type', type: suffix.type },
                span: { start: base.span.start, end: suffixSpan.end },
            };
        case 'index':
            return {
                kind: 'IndexExpr',
                object: base,
                index: suffix.expr,
                span: { start: base.span.start, end: suffixSpan.end },
            };
    }
}
function applyPostfixOp(base, op, opSpan) {
    if (op.kind === 'call') {
        return {
            kind: 'CallExpr',
            callee: base,
            args: op.args,
            span: { start: base.span.start, end: opSpan.end },
        };
    }
    // Otherwise it's an AccessSuffix
    return applySuffix(base, op, opSpan);
}
//# sourceMappingURL=actions.js.map