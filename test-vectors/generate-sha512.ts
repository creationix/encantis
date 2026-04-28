#!/usr/bin/env bun
// Generate SHA-512 test vectors using WebCrypto as ground truth

const vectors: { input: string; inputHex: string; hash: string }[] = []

async function sha512hex(input: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-512', input)
  return Buffer.from(hash).toString('hex')
}

const cases: [string, Uint8Array][] = [
  ['empty', new Uint8Array(0)],
  ['abc', new TextEncoder().encode('abc')],
  ['448-bit', new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')],
  ['896-bit', new TextEncoder().encode('abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu')],
  ['one-zero', new Uint8Array([0])],
  ['one-byte', new Uint8Array([0x61])],
  ['hello', new TextEncoder().encode('hello')],
  ['256-zeros', new Uint8Array(256)],
  ['single-block', new TextEncoder().encode('x'.repeat(111))], // just under one SHA-512 block
  ['two-blocks', new TextEncoder().encode('x'.repeat(128))],
]

for (const [label, input] of cases) {
  const hash = await sha512hex(input)
  vectors.push({
    input: label,
    inputHex: Buffer.from(input).toString('hex'),
    hash,
  })
}

const output = JSON.stringify(vectors, null, 2)
await Bun.write('test-vectors/sha512.json', output)
console.log(`Generated ${vectors.length} SHA-512 vectors`)
