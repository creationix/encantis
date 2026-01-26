// Generates encantis-grammar.bundle.ts from encantis-grammar.ohm
import * as ohm from 'ohm-js'
import { readFileSync, writeFileSync } from 'fs'

const grammarSource = readFileSync(new URL('../encantis-grammar.ohm', import.meta.url), 'utf-8')
const grammar = ohm.grammar(grammarSource)
const recipe = grammar.toRecipe()

const output = `// Auto-generated from encantis-grammar.ohm - do not edit
import * as ohm from 'ohm-js'
export const grammar = ohm.makeRecipe(${JSON.stringify(recipe)})
`

writeFileSync(new URL('../encantis-grammar.bundle.ts', import.meta.url), output)
console.log('Generated encantis-grammar.bundle.ts')
