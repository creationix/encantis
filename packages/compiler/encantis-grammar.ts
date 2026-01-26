import { createSemantics } from './encantis-actions'
import { grammar } from './encantis-grammar.bundle'

export { grammar }
export const semantics = createSemantics(grammar)
