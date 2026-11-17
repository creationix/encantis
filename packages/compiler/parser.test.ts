import { describe, expect, test } from 'bun:test'
import { parse } from './parser'
import type { ArrowBody, CallExpr, EnumDecl, Expr, FuncDecl } from './ast'

describe('parser', () => {
  describe('parse function', () => {
    test('parses empty module', () => {
      const result = parse('')
      expect(result.errors).toHaveLength(0)
      expect(result.module?.kind).toBe('Module')
      expect(result.module?.decls).toHaveLength(0)
    })

    test('parses function declaration', () => {
      const source = `func main() {}`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
      expect(result.module?.decls).toHaveLength(1)
      expect(result.module?.decls[0]?.kind).toBe('FuncDecl')
    })

    test('parses type declaration', () => {
      const source = `type Point = (x: f64, y: f64)`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
      expect(result.module?.decls).toHaveLength(1)
      expect(result.module?.decls[0]?.kind).toBe('TypeDecl')
    })

    test('parses global declaration', () => {
      const source = `global counter: i32 = 0`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
      expect(result.module?.decls).toHaveLength(1)
      expect(result.module?.decls[0]?.kind).toBe('GlobalDecl')
    })

    test('returns parse errors for invalid syntax', () => {
      const source = `func main( {`
      const result = parse(source)
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.module).toBeNull()
    })

    test('parses multiple declarations', () => {
      const source = `
        func add(a: i32, b: i32) -> i32 { return a + b }
        func sub(a: i32, b: i32) -> i32 { return a - b }
      `
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
      expect(result.module?.decls).toHaveLength(2)
    })
  })

  describe('defs', () => {
    // A def's value is pasted at each use, and -5 is folded into one literal.
    test('negating one use of a def leaves the others alone', () => {
      const result = parse(`
        def k = 5
        def h = 0.5
        func a() -> i32 => -k
        func b() -> i32 => k
        func c() -> f64 => -h
        func d() -> f64 => h
      `)
      expect(result.errors).toHaveLength(0)
      const body = (i: number) => ((result.module?.decls[i] as FuncDecl).body as ArrowBody).expr
      expect(body(2)).toMatchObject({ kind: 'LiteralExpr', value: { kind: 'int', value: -5n } })
      expect(body(3)).toMatchObject({ kind: 'LiteralExpr', value: { kind: 'int', value: 5n } })
      expect(body(4)).toMatchObject({ kind: 'LiteralExpr', value: { kind: 'float', value: -0.5 } })
      expect(body(5)).toMatchObject({ kind: 'LiteralExpr', value: { kind: 'float', value: 0.5 } })
    })
  })

  describe('comments', () => {
    test('parses source with comments', () => {
      const source = `
        // This is a comment
        func main() {}
      `
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
      expect(result.module?.decls).toHaveLength(1)
    })
  })

  describe('enum declarations', () => {
    test('parses simple enum with unit variants', () => {
      const source = `enum Color { Red, Blue, Green }`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
      expect(result.module?.decls).toHaveLength(1)
      const decl = result.module?.decls[0] as EnumDecl
      expect(decl.kind).toBe('EnumDecl')
      expect(decl.ident).toBe('Color')
      expect(decl.variants).toHaveLength(3)
      expect(decl.variants[0].name).toBe('Red')
      expect(decl.variants[0].fields).toBeNull()
    })

    test('parses enum with payload variants', () => {
      const source = `enum Option { None, Some(value: i32) }`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
      const decl = result.module?.decls[0] as EnumDecl
      expect(decl.kind).toBe('EnumDecl')
      expect(decl.variants).toHaveLength(2)
      expect(decl.variants[0].name).toBe('None')
      expect(decl.variants[0].fields).toBeNull()
      expect(decl.variants[1].name).toBe('Some')
      expect(decl.variants[1].fields).toHaveLength(1)
    })

    test('parses enum with multiple field variants', () => {
      const source = `enum Color { RGB(r: u8, g: u8, b: u8), Grey(b: u8) }`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
      const decl = result.module?.decls[0] as EnumDecl
      expect(decl.variants[0].name).toBe('RGB')
      expect(decl.variants[0].fields).toHaveLength(3)
      expect(decl.variants[1].name).toBe('Grey')
      expect(decl.variants[1].fields).toHaveLength(1)
    })

    test('parses enum with positional fields', () => {
      const source = `enum Json { Number(f64), Boolean(bool) }`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
      const decl = result.module?.decls[0] as EnumDecl
      expect(decl.variants[0].fields).toHaveLength(1)
    })
  })

  describe('match expressions', () => {
    test('parses match with literal patterns', () => {
      const source = `func test(x: i32) -> i32 { match x { 0 => 1, 1 => 2, _ => 0 } }`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
    })

    test('parses match with variant patterns', () => {
      const source = `func test(c: Color) { match c { Red => 1, Blue => 2 } }`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
    })

    test('parses match with constructor patterns', () => {
      const source = `func test(c: Color) { match c { RGB(r, g, b) => r, Grey(b) => b } }`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
    })

    test('parses match with tuple patterns', () => {
      const source = `func test(p: (i32, i32)) { match p { (0, y) => y, (x, 0) => x, _ => 0 } }`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
    })

    test('parses match with named pattern elements', () => {
      const source = `func test(p: Point) { match p { Point(x: 0, y:) => y, _ => 0 } }`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
    })

    test('parses match with binding patterns', () => {
      const source = `func test(x: i32) { match x { n => n * 2 } }`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
    })
  })

  describe('if-let expressions', () => {
    test('parses if-let with variant pattern', () => {
      const source = `func test(c: Color) { if let RGB(r, g, b) = c { r } }`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
    })

    test('parses if-let with else branch', () => {
      const source = `func test(opt: Option) { if let Some(x) = opt { x } else { 0 } }`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
    })

    test('parses if-let with elif-let', () => {
      const source = `func test(c: Color) { if let RGB(r, g, b) = c { r } elif let Grey(b) = c { b } else { 0 } }`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
    })

    test('parses if-let with tuple pattern', () => {
      const source = `func test(p: (i32, i32)) { if let (0, y) = p { y } }`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
    })

    test('parses mixed if and elif-let', () => {
      const source = `func test(c: Color, x: bool) { if x { 1 } elif let RGB(r, g, b) = c { r } else { 0 } }`
      const result = parse(source)
      expect(result.errors).toHaveLength(0)
    })
  })

  describe('comptime parameters', () => {
    const paramsOf = (source: string) => {
      const result = parse(source)
      expect(result.errors).toEqual([])
      const decl = result.module?.decls[0] as FuncDecl
      if (decl.signature.input.kind !== 'CompositeType') throw new Error('expected a parameter list')
      return decl.signature.input.fields
    }
    const parses = (source: string) => parse(source).errors.length === 0

    test('comptime T: type is a comptime field of type `type`', () => {
      const [t, a] = paramsOf('func max(comptime T: type, a: T, b: T) -> T => a')
      expect(t).toMatchObject({ kind: 'Field', comptime: true, ident: 'T', type: { kind: 'TypeType' } })
      expect(a).toMatchObject({ kind: 'Field', ident: 'a', type: { kind: 'TypeRef', name: 'T' } })
      expect('comptime' in a).toBe(false)
    })

    test('a type parameter says where its name stands, whatever lies between the keyword and it', () => {
      const source = 'func max(comptime  /* any */ T: type, a: T, b: T) -> T => a'
      const [t, a] = paramsOf(source)
      // The field begins at the keyword: an ordinary one begins with its name.
      expect(t.span.start).toBe(source.indexOf('comptime'))
      expect(t.identSpan).toEqual({ start: source.indexOf('T:'), end: source.indexOf('T:') + 1 })
      expect(a.span.start).toBe(source.indexOf('a:'))
      expect('identSpan' in a).toBe(false)
    })

    test('a comptime parameter may stand anywhere in the list', () => {
      const fields = paramsOf('func at(xs: []T, comptime T: type, i: u32) -> T => xs.ptr[i]')
      expect(fields.map(f => f.comptime === true)).toEqual([false, true, false])
    })

    test('a comptime parameter of another type parses', () => {
      const [, , before] = paramsOf('func sort(comptime T: type, xs: []mut T, comptime before: (T, T) -> bool) { }')
      expect(before).toMatchObject({ comptime: true, ident: 'before', type: { kind: 'FuncType' } })
      const [n] = paramsOf('func f(comptime n: u32) -> u32 => 0')
      expect(n).toMatchObject({ comptime: true, ident: 'n', type: { kind: 'PrimitiveType', name: 'u32' } })
    })

    test('the two near misses parse, for the checker to explain', () => {
      const [lower] = paramsOf('func f(comptime t: type) -> u32 => 0')
      expect(lower).toMatchObject({ comptime: true, ident: 't', type: { kind: 'TypeType' } })
      const [bare] = paramsOf('func f(T: type, a: T) -> u32 => 0')
      expect(bare).toMatchObject({ ident: 'T', type: { kind: 'TypeType' } })
      expect('comptime' in bare).toBe(false)
    })

    test('comptime is written in a parameter list and nowhere else', () => {
      expect(parses('type P = (comptime T: type, x: T)')).toBe(false)
      expect(parses('func f(a: u32) -> (comptime T: type) => a')).toBe(false)
      expect(parses('func f(g: (comptime T: type) -> u32) -> u32 => 0')).toBe(false)
      expect(parses('enum E { A(comptime T: type) }')).toBe(false)
    })

    test('`type` is not a type outside a comptime parameter', () => {
      expect(parses('func f(t: type) -> u32 => 0')).toBe(false)
      expect(parses('func f() { let t: type = 1 }')).toBe(false)
    })

    test('comptime is a reserved word', () => {
      expect(parses('func comptime(a: i32) -> i32 => a')).toBe(false)
      expect(parses('func f(comptime: i32) -> i32 => comptime')).toBe(false)
    })

    test('an import item takes the same parameter list', () => {
      expect(parses('import "./lib" "max" func max(comptime T: type, a: T, b: T) -> T')).toBe(true)
    })

    test('signatures without comptime parse as before', () => {
      const ast = (source: string) => {
        const result = parse(source)
        expect(result.errors).toEqual([])
        return (result.module?.decls[0] as FuncDecl).signature
      }
      expect(ast('func Point -> Point => p').input).toMatchObject({ kind: 'TypeRef', name: 'Point' })
      expect(ast('func (a: i32, b: i32) -> i32 => a').input).toMatchObject({ kind: 'CompositeType' })
      expect(ast('func f(i32, i32) -> i32 => 0').input).toMatchObject({
        kind: 'CompositeType',
        fields: [{ ident: null, type: { name: 'i32' } }, { ident: null, type: { name: 'i32' } }],
      })
      expect(ast('func f() { }').input).toMatchObject({ kind: 'CompositeType', fields: [] })
      expect(ast('func f(p: Point) { }').input).toMatchObject({ fields: [{ ident: 'p', type: { kind: 'TypeRef' } }] })
      expect(ast('func f(Point) { }').input).toMatchObject({ fields: [{ ident: null, type: { kind: 'TypeRef' } }] })
    })
  })

  describe('type arguments', () => {
    const firstArg = (source: string): Expr => {
      const result = parse(source, { startRule: 'Expr' })
      expect(result.errors).toEqual([])
      const value = (result.module as unknown as CallExpr).args[0].value
      if (!value) throw new Error('expected an argument value')
      return value
    }

    test('a type that cannot start an expression is a TypeExpr', () => {
      expect(firstArg('first(Pt, ps)')).toMatchObject({ kind: 'TypeExpr', type: { kind: 'TypeRef', name: 'Pt' } })
      expect(firstArg('first([]u8, ps)')).toMatchObject({ kind: 'TypeExpr', type: { kind: 'IndexedType' } })
      expect(firstArg('first(*mut Pt, ps)')).toMatchObject({ kind: 'TypeExpr', type: { kind: 'PointerType', mutable: true } })
      expect(firstArg('first(?*Pt, ps)')).toMatchObject({ kind: 'TypeExpr', type: { kind: 'PointerType', optional: true } })
      expect(firstArg('first([*]u8, ps)')).toMatchObject({ kind: 'TypeExpr', type: { kind: 'IndexedType', manyPointer: true } })
      expect(firstArg('first([4]u8, ps)')).toMatchObject({ kind: 'TypeExpr', type: { kind: 'IndexedType', size: 4 } })
      expect(firstArg('first(u8#16, ps)')).toMatchObject({ kind: 'TypeExpr', type: { kind: 'PrimitiveType', max: 16 } })
      expect(firstArg('apply((u32) -> u32, f)')).toMatchObject({ kind: 'TypeExpr', type: { kind: 'FuncType' } })
      expect(firstArg('apply(u32 -> u32, f)')).toMatchObject({ kind: 'TypeExpr', type: { kind: 'FuncType' } })
      expect(firstArg('only(Pt)')).toMatchObject({ kind: 'TypeExpr' })
    })

    test('a TypeExpr spans the type', () => {
      expect(firstArg('first( []u8 , ps)').span).toEqual({ start: 7, end: 11 })
    })

    test('a type that is also an expression stays one', () => {
      expect(firstArg('max(u32, a, b)')).toMatchObject({ kind: 'IdentExpr', name: 'u32' })
      expect(firstArg('first((i32, i32), ps)')).toMatchObject({ kind: 'TupleExpr' })
      expect(firstArg('f(Point(1, 2), x)')).toMatchObject({ kind: 'CallExpr', callee: { name: 'Point' } })
      expect(firstArg('f([], x)')).toMatchObject({ kind: 'ArrayExpr', elements: [] })
      expect(firstArg('f([4], x)')).toMatchObject({ kind: 'ArrayExpr', elements: [{ kind: 'LiteralExpr' }] })
      expect(firstArg('f([4, 5], x)')).toMatchObject({ kind: 'ArrayExpr' })
    })

    test('types inside a tuple argument are TypeExprs', () => {
      expect(firstArg('first((Pt, u32), ps)')).toMatchObject({
        kind: 'TupleExpr',
        elements: [{ value: { kind: 'TypeExpr' } }, { value: { kind: 'IdentExpr', name: 'u32' } }],
      })
    })

    // An argument is tried as an expression before it is tried as a function
    // type, which is what keeps parsing as fast as it was. These are the forms
    // where the order of the alternatives decides what is read.
    test('trying an expression first does not change what is a type', () => {
      // An array type applied to a parenthesised type is not a called array literal.
      expect(firstArg('first([](i32, i32), ps)')).toMatchObject({ kind: 'TypeExpr', type: { kind: 'IndexedType' } })
      expect(firstArg('first([4](q: i32, r: i32), ps)')).toMatchObject({ kind: 'TypeExpr', type: { kind: 'IndexedType', size: 4 } })
      // A function type whose input alone reads as an expression, or as a type argument
      expect(firstArg('apply((a: i32) -> i32, f)')).toMatchObject({ kind: 'TypeExpr', type: { kind: 'FuncType' } })
      // A prefix type takes the whole function type: a slice of functions
      expect(firstArg('apply([]u8 -> u32, f)')).toMatchObject({ kind: 'TypeExpr', type: { kind: 'IndexedType', element: { kind: 'FuncType' } } })
      expect(firstArg('apply(Pt -> Pt, f)')).toMatchObject({ kind: 'TypeExpr', type: { kind: 'FuncType' } })
      expect(firstArg('apply((u32) -> (u32) -> u32, f)')).toMatchObject({ kind: 'TypeExpr', type: { kind: 'FuncType' } })
      expect(firstArg('f((x), y)')).toMatchObject({ kind: 'TupleExpr' })
    })

    test('a function type is tried only after an expression', async () => {
      // Tried first, every argument and every element of a tuple was parsed as
      // a type before it was parsed as what it is, and a file without one
      // generic took a quarter longer to parse (a third, for one full of
      // tuples). The order is all there is to pin: a timing would not be stable.
      const grammar = await Bun.file(new URL('./encantis-grammar.ohm', import.meta.url)).text()
      const rule = grammar.slice(grammar.indexOf('\n  Arg = '), grammar.indexOf('\n  TypeLit = '))
      expect([...rule.matchAll(/-- (\w+)/g)].map(m => m[1])).toEqual([
        'named', 'shorthand', 'type', 'positional', 'funcType', 'unfinished',
      ])
    })

    test('an argument that is neither is reported where it goes wrong', () => {
      const error = (source: string) => parse(source, { startRule: 'Expr' }).errors.map(e => e.message.split('\n')[0])
      expect(error('f(a b)')).toEqual(['Line 1, col 5:'])
      expect(error('f([]u8 x)')).toEqual(['Line 1, col 8:'])
      // A struct type with named fields cannot be written in place: its field
      // types are not expressions, and it is not followed by ->.
      const struct = parse('size((at: Pt, n: u8))', { startRule: 'Expr' }).errors
      expect(struct).toHaveLength(1)
      expect(struct[0].message).toEndWith('Expected "->"')
    })

    test('a named argument still takes a value, not a type', () => {
      expect(parse('f(x: T)', { startRule: 'Expr' }).errors).toHaveLength(1)
    })

    test('a type at the end of a match arm does not swallow the pattern on the next line', () => {
      const result = parse(`func f(x: (i32, i32)) -> Meters => match x {
  (0, y) => y as Meters
  (a, b) => a as Meters
}`)
      expect(result.errors).toEqual([])
      const body = (result.module?.decls[0] as FuncDecl).body
      expect(body.kind === 'ArrowBody' && body.expr.kind === 'MatchExpr' && body.expr.arms.length).toBe(2)
    })

    test('a cast to a named type does not swallow a parenthesis on the next line', () => {
      const result = parse('func f(x: u32) -> u32 {\n  let y = x as Meters\n  (y)\n}')
      expect(result.errors).toEqual([])
      const body = (result.module?.decls[0] as FuncDecl).body
      expect(body.kind === 'Block' && body.stmts.length).toBe(2)
    })
  })

  describe('members named like a primitive type', () => {
    const expr = (source: string): Expr => {
      const result = parse(source, { startRule: 'Expr' })
      expect(result.errors).toEqual([])
      return result.module as unknown as Expr
    }

    test('a name that only starts like one is a field or a method', () => {
      expect(expr('s.boolish')).toMatchObject({ kind: 'MemberExpr', member: { kind: 'field', name: 'boolish' } })
      expect(expr('v.u32s()')).toMatchObject({ kind: 'CallExpr', callee: { kind: 'MemberExpr', member: { kind: 'field', name: 'u32s' } } })
      expect(expr('p.i8_le')).toMatchObject({ kind: 'MemberExpr', member: { kind: 'field', name: 'i8_le' } })
      expect(expr('p.f64x')).toMatchObject({ kind: 'MemberExpr', member: { kind: 'field', name: 'f64x' } })
    })

    test('the whole name is still a type pun', () => {
      const pun = (name: string) => ({ kind: 'MemberExpr', member: { kind: 'type', type: { kind: 'PrimitiveType', name } } })
      expect(expr('p.u32')).toMatchObject(pun('u32'))
      expect(expr('p.u8[4]')).toMatchObject({ kind: 'IndexExpr', object: pun('u8') })
      expect(expr('p.u32-1')).toMatchObject({ kind: 'BinaryExpr', op: '-', left: pun('u32') })
      // A hyphen ends the name too, though a name may hold one: a member
      // called u32-count is out of reach (docs/grammar.md says so).
      expect(expr('p.u32-count')).toMatchObject({ kind: 'BinaryExpr', op: '-', left: pun('u32'), right: { kind: 'IdentExpr', name: 'count' } })
      expect(expr('p.u32.u8')).toMatchObject({ kind: 'MemberExpr', object: pun('u32'), member: { kind: 'type' } })
      expect(expr('p. u32')).toMatchObject(pun('u32'))
    })

    test('a type pun does not take the next line for the rest of its name', () => {
      const result = parse('func f(p: *u8) -> u32 {\n  let a = p.u32\n  seen(a)\n  return 1\n}')
      expect(result.errors).toEqual([])
      const body = (result.module?.decls[0] as FuncDecl).body
      expect(body.kind === 'Block' && body.stmts.length).toBe(3)
      expect(body.kind === 'Block' && body.stmts[0]).toMatchObject({ value: { kind: 'MemberExpr', member: { kind: 'type' } } })
    })

    test('the same holds where the member is assigned', () => {
      const target = (source: string) => {
        const result = parse(`func f(p: *mut S) { ${source} }`)
        expect(result.errors).toEqual([])
        const body = (result.module?.decls[0] as FuncDecl).body
        return body.kind === 'Block' ? body.stmts[0] : null
      }
      expect(target('p.u32s = 1')).toMatchObject({ kind: 'AssignmentStmt', target: { member: { kind: 'field', name: 'u32s' } } })
      expect(target('p.u32 = 1')).toMatchObject({ kind: 'AssignmentStmt', target: { member: { kind: 'type' } } })
    })
  })
})
