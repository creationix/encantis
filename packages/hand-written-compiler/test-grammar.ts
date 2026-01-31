import * as ohm from 'ohm-js'

const script = await Bun.file(new URL('./grammar.ohm', import.meta.url)).text()

const grammar = ohm.grammar(script)

console.log('Grammar loaded successfully.')

console.log({ grammar })
