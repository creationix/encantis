import { parse } from './packages/compiler/parser'
import { typecheck } from './packages/compiler/checker'
import { typeToString } from './packages/compiler/types'

const source = `
func test(input: []u8) {
  let ptr = input.ptr    // should be [*]u8
  let pun = ptr.u32      // should be *u32
  let val = ptr.u32[0]   // should be u32
}
`

const result = parse(source)
if (!result.module) {
  console.error('Parse errors:', result.errors)
  process.exit(1)
}

const checkResult = typecheck(result.module)

if (checkResult.errors.length > 0) {
  console.log('Type errors:')
  for (const e of checkResult.errors) {
    console.log('  ' + e.message)
  }
} else {
  console.log('No type errors!')
}

console.log('\nIdentPattern types:')
for (const [key, type] of checkResult.types) {
  if (key.includes('IdentPattern')) {
    console.log('  ' + key + ' -> ' + typeToString(type))
  }
}
