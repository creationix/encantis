import { readFileSync } from 'node:fs'
import * as ohm from 'ohm-js'
import { createSemantics } from './encantis-actions'

const grammarPath = new URL('encantis-grammar.ohm', import.meta.url).pathname
const grammarSource = readFileSync(grammarPath, 'utf-8')

export const grammar = ohm.grammar(grammarSource)
export const semantics = createSemantics(grammar)
