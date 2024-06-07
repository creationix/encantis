import { xxh64 } from "./xxh64.js"

import { expect, test } from 'bun:test'

test('generates expected hashes', () => {

  const tests = [
    { input: "", seed: 0n, expected: 17241709254077376921n },
    { input: "/blog/[slug]", seed: 0n, expected: 11543890388787685454n },
    { input: '10.0.0.50', seed: 11543890388787685454n, expected: 1808859848229981302n },
    { input: '10.0.0.51', seed: 11543890388787685454n, expected: 2633157285878140008n },
    { input: '10.0.0.52', seed: 11543890388787685454n, expected: 5884625354243948638n },
    { input: '10.0.0.53', seed: 11543890388787685454n, expected: 3237206721917912246n },
    { input: '10.0.0.54', seed: 11543890388787685454n, expected: 899835752484592491n },
  ]
  for (const { input, seed, expected } of tests) {
    const actual = xxh64(input, seed)
    expect(actual).toBe(expected)
  }
})
