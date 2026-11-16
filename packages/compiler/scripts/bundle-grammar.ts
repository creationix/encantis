// Generates encantis-grammar.bundle.ts from encantis-grammar.ohm
import * as ohm from 'ohm-js'
import { readFileSync, writeFileSync } from 'fs'

const grammarSource = readFileSync(new URL('../encantis-grammar.ohm', import.meta.url), 'utf-8')
const grammar = ohm.grammar(grammarSource)
const recipe = (grammar as any).toRecipe()

const output = `// Auto-generated from encantis-grammar.ohm - do not edit
import * as ohm from 'ohm-js'
// makeRecipe is part of ohm's runtime but missing from its type declarations.
const { makeRecipe } = ohm as unknown as { makeRecipe(recipe: unknown): ohm.Grammar }
export const grammar = makeRecipe(${JSON.stringify(recipe)})
`

writeFileSync(new URL('../encantis-grammar.bundle.ts', import.meta.url), output)
console.log('Generated encantis-grammar.bundle.ts')
