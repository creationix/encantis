import { describe, test, expect } from 'bun:test'
import { parse } from '@encantis/compiler/parser'
import { typecheck } from '@encantis/compiler/checker'
import { moduleToWat } from '@encantis/compiler/codegen'
import { resolve } from 'path'

describe('u128 operations', () => {
  test('compiles all u128 ops to valid WAT', async () => {
    const source = await Bun.file(resolve(import.meta.dir, 'u128ops.ents')).text()
    const r = parse(source)
    expect(r.errors).toEqual([])

    const c = typecheck(r.module!)
    expect(c.errors).toEqual([])

    const wat = moduleToWat(r.module!, c)

    // Bitwise ops use v128 instructions
    expect(wat).toContain('v128.xor')
    expect(wat).toContain('v128.and')
    expect(wat).toContain('v128.or')
    expect(wat).toContain('v128.not')

    // Arithmetic uses i64x2
    expect(wat).toContain('i64x2.add')

    // Equality uses i64x2.eq + all_true
    expect(wat).toContain('i64x2.eq')
    expect(wat).toContain('i32x4.all_true')

    // Load uses v128.load
    expect(wat).toContain('v128.load')

    // Widening uses i64x2.replace_lane
    expect(wat).toContain('i64x2.replace_lane')

    // Narrowing uses i64x2.extract_lane
    expect(wat).toContain('i64x2.extract_lane')

    // mul_hi helper is emitted
    expect(wat).toContain('$__mul_hi')

    // All parameters are v128
    expect(wat).toContain('(param $a v128)')
    expect(wat).toContain('(result v128)')
  })
})
