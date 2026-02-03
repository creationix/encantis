import * as ohm from 'ohm-js'

const markdownTestGrammar = ohm.grammar(await Bun.file(new URL('./markdown-tests.ohm', import.meta.url)).text())
const encantisGrammar = ohm.grammar(await Bun.file(new URL('./encantis.ohm', import.meta.url)).text())

console.log('Grammars loaded successfully.')

console.log({ markdownTestGrammar, encantisGrammar })

const testsMd = await Bun.file(new URL('./parse-tests.md', import.meta.url)).text()

console.log({ testsMd })

