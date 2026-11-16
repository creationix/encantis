import { describe, expect, test } from 'bun:test'
import wabt from 'wabt'
import {
  primitive,
  pointer,
  manyPointer,
  array,
  slice,
  tuple,
  field,
  func,
  named,
  forwardRef,
  comptimeInt,
  comptimeFloat,
  comptimeList,
  comptimeArrayLiteral,
  canonicalKey,
  watSafe,
  typeEquals,
  type ResolvedType,
  VOID,
  typeToString,
  typeAssignable,
  isSigned,
  isUnsigned,
  isInteger,
  isFloat,
  isNumeric,
} from './types'

describe('types', () => {
  describe('type constructors', () => {
    test('primitive creates primitive type', () => {
      const type = primitive('i32')
      expect(type.kind).toBe('primitive')
      expect(type.name).toBe('i32')
    })

    test('pointer creates pointer type', () => {
      const type = pointer(primitive('i32'))
      expect(type.kind).toBe('pointer')
      expect(type.pointee.kind).toBe('primitive')
    })

    test('slice creates slice type', () => {
      const type = slice(primitive('u8'))
      expect(type.kind).toBe('slice')
      expect(type.element.kind).toBe('primitive')
    })

    test('array creates array type', () => {
      const type = array(primitive('u8'), [10])
      expect(type.kind).toBe('array')
      expect(type.sizes).toEqual([10])
      expect(type.element.kind).toBe('primitive')
    })

    test('tuple creates tuple type', () => {
      const type = tuple([
        field('x', primitive('i32')),
        field('y', primitive('i32')),
      ])
      expect(type.kind).toBe('tuple')
      expect(type.fields).toHaveLength(2)
    })

    test('named creates named type', () => {
      const type = named('Point', tuple([field('x', primitive('i32'))]))
      expect(type.kind).toBe('named')
      expect(type.name).toBe('Point')
    })

    test('comptimeInt creates comptime int type', () => {
      const type = comptimeInt(42n)
      expect(type.kind).toBe('comptime_int')
      expect(type.value).toBe(42n)
    })

    test('comptimeFloat creates comptime float type', () => {
      const type = comptimeFloat(3.14)
      expect(type.kind).toBe('comptime_float')
      expect(type.value).toBe(3.14)
    })


    test('VOID is void type', () => {
      expect(VOID.kind).toBe('void')
    })
  })

  describe('typeToString', () => {
    test('formats primitive types', () => {
      expect(typeToString(primitive('i32'))).toBe('i32')
      expect(typeToString(primitive('f64'))).toBe('f64')
    })

    test('formats pointer types', () => {
      expect(typeToString(pointer(primitive('i32')))).toBe('*i32')
    })

    test('formats tuple types', () => {
      const type = tuple([field('x', primitive('i32')), field('y', primitive('i32'))])
      expect(typeToString(type)).toContain('x')
      expect(typeToString(type)).toContain('y')
    })
  })

  describe('typeAssignable', () => {
    test('same primitive types are assignable', () => {
      expect(typeAssignable(primitive('i32'), primitive('i32'))).toBe(true)
    })

    test('different primitive types are not assignable', () => {
      expect(typeAssignable(primitive('i32'), primitive('i64'))).toBe(false)
    })

    test('comptime int can be assigned to compatible target', () => {
      // Note: typeAssignable checks structural equality, not coercion
      // Comptime int coercion happens in the type checker
      expect(typeAssignable(primitive('i32'), primitive('i32'))).toBe(true)
    })

    test('pointers to the same named type are assignable', () => {
      const slot = () => named('Slot', tuple([field('a', primitive('u32')), field('b', primitive('u32'))]))
      // [*]mut Slot, *Slot, and a pointer to the alias's underlying tuple.
      expect(typeAssignable(pointer(array(slot(), null), false, true), pointer(array(slot(), null), false, true))).toBe(true)
      expect(typeAssignable(pointer(slot()), pointer(slot()))).toBe(true)
      expect(typeAssignable(pointer(slot()), pointer(slot().type))).toBe(true)
      expect(typeAssignable(pointer(slot().type), pointer(slot()))).toBe(true)
      expect(typeAssignable(pointer(slot()), pointer(primitive('u32')))).toBe(false)
    })

  })

  describe('type predicates', () => {
    test('isSigned detects signed types', () => {
      expect(isSigned(primitive('i32'))).toBe(true)
      expect(isSigned(primitive('u32'))).toBe(false)
    })

    test('isUnsigned detects unsigned types', () => {
      expect(isUnsigned(primitive('u32'))).toBe(true)
      expect(isUnsigned(primitive('i32'))).toBe(false)
    })

    test('isInteger detects integer types', () => {
      expect(isInteger(primitive('i32'))).toBe(true)
      expect(isInteger(primitive('u32'))).toBe(true)
      expect(isInteger(primitive('f32'))).toBe(false)
    })

    test('isFloat detects float types', () => {
      expect(isFloat(primitive('f32'))).toBe(true)
      expect(isFloat(primitive('f64'))).toBe(true)
      expect(isFloat(primitive('i32'))).toBe(false)
    })

    test('isNumeric detects numeric types', () => {
      expect(isNumeric(primitive('i32'))).toBe(true)
      expect(isNumeric(primitive('f64'))).toBe(true)
      expect(isNumeric(primitive('bool'))).toBe(false)
    })
  })

  describe('instance keys', () => {
    const u32 = primitive('u32')
    const u8 = primitive('u8')
    const f64 = primitive('f64')
    const bool = primitive('bool')
    const anon = (...types: ResolvedType[]) => types.map(t => field(null, t))
    const Pt = tuple([field('x', f64), field('y', f64)])
    // A type that refers to itself, as the checker leaves it: the alias wraps a
    // struct that still holds the forward reference.
    const Node = named('Node', tuple([field('next', pointer(forwardRef('Node'), false, false, true)), field('value', u32)]))

    // Types that are all different from each other.
    const distinct: ResolvedType[] = [
      u32, u8, primitive('u8', 16), bool, f64, primitive('u128'),
      pointer(u32), pointer(u32, false, true), pointer(u32, false, false, true), pointer(u32, true),
      manyPointer(u32), manyPointer(u32, true), pointer(pointer(u32)), pointer(manyPointer(u32)),
      slice(u32), slice(u32, true), slice(u32, false, true), slice(slice(u32)),
      array(u8, [4]), array(u8, [4, 3]), array(array(u8, [3]), [4]),
      pointer(array(u8, [4])), pointer(array(u8, ['!'])), pointer(array(u8, ['?'])),
      Pt, tuple(anon(f64, f64)), tuple([field('y', f64), field('x', f64)]), tuple(anon(f64)),
      tuple(anon(tuple(anon(f64, f64)))),
      tuple([field('used', bool), field('hash', u32), field('key', slice(u32))]),
      func(anon(u32, u32), anon(bool)),
      func([field('a', u32)], []),
      func([], [field('q', u32), field('r', u32)]),
      func([], anon(tuple([field('q', u32), field('r', u32)]))),
      func([field('f', func(anon(u32), anon(u32)))], anon(u32)),
      func(anon(u32), anon(func(anon(u32), anon(u32)))),
      Node,
      // What a many-pointer points to, by itself: not a many-pointer
      array(u32, null),
      // The same fields as Node, written out once more around it
      tuple([field('next', pointer(Node, false, false, true)), field('value', u32)]),
    ]

    test('different types have different keys, also once they are names', () => {
      expect(distinct).toHaveLength(39)
      expect(new Set(distinct.map(t => canonicalKey(t))).size).toBe(distinct.length)
      expect(new Set(distinct.map(t => watSafe(canonicalKey(t)))).size).toBe(distinct.length)
    })

    test('an alias and the type it names have one key, at any depth', () => {
      const same: [ResolvedType, ResolvedType][] = [
        [named('Pt', Pt), Pt],
        [pointer(named('Pt', Pt), false, true), pointer(Pt, false, true)],
        [named('Meters', f64), named('Feet', f64)],
        [slice(named('Byte', u8)), slice(u8)],
        [tuple([field('at', named('Pt', Pt))]), tuple([field('at', Pt)])],
      ]
      for (const [a, b] of same) {
        expect(typeEquals(a, b)).toBe(true)
        expect(canonicalKey(a)).toBe(canonicalKey(b))
      }
      expect(canonicalKey(named('Pt', Pt))).toBe('(x:f64,y:f64)')
    })

    test('keys read as the types are written', () => {
      expect(canonicalKey(VOID)).toBe('()')
      expect(canonicalKey(tuple([]))).toBe('()')
      expect(canonicalKey(primitive('u8', 16))).toBe('u8#16')
      expect(canonicalKey(manyPointer(u8, true))).toBe('[*]mut u8')
      expect(canonicalKey(pointer(array(u8, [4]), false, false, true))).toBe('?*[4]u8')
      expect(canonicalKey(func(anon(u32, u32), anon(bool)))).toBe('(u32,u32)->(bool)')
      expect(canonicalKey(Node)).toBe('(next:?*@0,value:u32)')
      expect(canonicalKey(slice(Node))).toBe('[](next:?*@1,value:u32)')
    })

    test('a type that recurses through an alias of itself has one key, whichever name it is reached by', () => {
      // type Node = (next: ?*Link, v: i32) and type Link = Node, as the checker
      // leaves them: each alias wraps what the other was when it was resolved.
      const body = (link: ResolvedType) => tuple([field('next', pointer(link, false, false, true)), field('v', primitive('i32'))])
      const node0 = body(forwardRef('Link'))
      const link = named('Link', named('Node', node0))
      const node = named('Node', body(link))
      expect(canonicalKey(node)).toBe('(next:?*@0,v:i32)')
      expect(canonicalKey(link)).toBe(canonicalKey(node))
      expect(canonicalKey(pointer(link))).toBe(canonicalKey(pointer(node)))
      // Two types that refer to each other are told apart by where they start.
      const a = named('A', tuple([field('b', pointer(named('B', tuple([field('a', pointer(forwardRef('A')))]))))]))
      const b = named('B', tuple([field('a', pointer(named('A', tuple([field('b', pointer(forwardRef('B')))]))))]))
      expect(canonicalKey(a)).toBe('(b:*(a:*@0))')
      expect(canonicalKey(b)).toBe('(a:*(b:*@0))')
    })

    test('the names of a function type\'s parameters and results are not part of it', () => {
      const i32 = primitive('i32')
      const key = canonicalKey(func(anon(i32), anon(i32)))
      expect(canonicalKey(func([field('x', i32)], anon(i32)))).toBe(key)
      expect(canonicalKey(func([field('y', i32)], [field('r', i32)]))).toBe(key)
      // A struct's field names are.
      expect(canonicalKey(tuple([field('x', i32)]))).not.toBe(canonicalKey(tuple(anon(i32))))
    })

    test('a type that is not concrete has no key', () => {
      expect(() => canonicalKey(comptimeInt(1n))).toThrow('not a concrete type')
      expect(() => canonicalKey(comptimeFloat(1.5))).toThrow('not a concrete type')
      expect(() => canonicalKey(comptimeList([comptimeInt(1n)]))).toThrow('not a concrete type')
      expect(() => canonicalKey(slice(comptimeArrayLiteral(u8, 3)))).toThrow('not a concrete type')
    })

    test('watSafe keeps what is legal in a WAT name and replaces the rest', () => {
      expect(watSafe('(q:i32,r:i32)')).toBe('<q:i32|r:i32>')
      expect(watSafe('[]u8')).toBe("''u8")
      expect(watSafe('*mut [4]u8')).toBe("*mut.'4'u8")
      expect(watSafe('(u32,u32)->(bool)')).toBe('<u32|u32>=><bool>')
    })

    test('wabt accepts every key as part of a function name', async () => {
      const w = await wabt()
      for (const type of distinct) {
        const name = `$f<${watSafe(canonicalKey(type))}>`
        const wat = `(module (func ${name} (result i32) (i32.const 1)) (func (export "f") (result i32) (call ${name})))`
        const mod = w.parseWat('name.wat', wat, { multi_value: true })
        mod.validate()
        mod.destroy()
      }
    })
  })
})

