import { parse } from './packages/compiler/parser'
import { typecheck, typeKey } from './packages/compiler/checker'
import { typeToString } from './packages/compiler/types'

const source = `
func test(input: []u8, sentinel: [:0]u8) {
  let p1 = input.ptr
  let p2 = sentinel.ptr
}
`

const result = parse(source)
if (!result.module) {
  console.error('Parse errors:', result.errors)
  process.exit(1)
}

const checkResult = typecheck(result.module)

// Find types for p1 and p2
console.log('Types containing [*]:')
for (const [key, type] of checkResult.types) {
  const typeStr = typeToString(type)
  if (typeStr.includes('[*]')) {
    console.log('  ' + key + ' -> ' + typeStr)
  }
}

// Also dump IdentPattern types
console.log('\nAll IdentPattern types:')
for (const [key, type] of checkResult.types) {
  if (key.includes('IdentPattern')) {
    console.log('  ' + key + ' -> ' + typeToString(type))
  }
}
