// The parser runs the committed bundle, not the .ohm source. A grammar edit
// without `bun run bundle:grammar` would otherwise be tested against the old
// grammar and pass.

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import * as ohm from 'ohm-js'
import { grammar as bundled } from './encantis-grammar.bundle'

type WithRecipe = ohm.Grammar & { toRecipe(): unknown }

test('encantis-grammar.bundle.ts is generated from encantis-grammar.ohm', () => {
  // A checkout may have CRLF line ends (git on Windows); the bundle was made from LF.
  const source = readFileSync(new URL('./encantis-grammar.ohm', import.meta.url), 'utf-8').replace(/\r\n/g, '\n')
  const fresh = (ohm.grammar(source) as WithRecipe).toRecipe()
  // Through JSON, as the bundle script writes it.
  expect(JSON.parse(JSON.stringify((bundled as WithRecipe).toRecipe()))).toEqual(JSON.parse(JSON.stringify(fresh)))
})
