import { describe, test, expect } from 'bun:test'
import { createHarness } from './harness'
import { compileToWasm } from '@encantis/compiler/test-utils'
import { resolve } from 'path'
import sha512Vectors from './sha512.json'
import ed25519Vectors from './ed25519.json'
import { ed25519 } from '@noble/curves/ed25519.js'

function hexToBytes(hex: string): Uint8Array {
  if (hex.length === 0) return new Uint8Array(0)
  return new Uint8Array(hex.match(/.{2}/g)!.map(b => parseInt(b, 16)))
}

describe('test harness', () => {
  test('discovers exports from xxh64 wasm', async () => {
    const wasm = await compileToWasm(resolve(__dirname, '../examples/crypto/xxh64/xxh64.ents'))
    const h = await createHarness(wasm)

    expect(h.memory).not.toBeNull()
    expect(h.exports.xxh64).toBeInstanceOf(Function)
  })

  test('xxh64 round-trip through harness', async () => {
    const wasm = await compileToWasm(resolve(__dirname, '../examples/crypto/xxh64/xxh64.ents'))
    const h = await createHarness(wasm)

    const input = new TextEncoder().encode('hello')
    const { ptr, len } = h.writeInput(input)
    const result = h.call('xxh64', ptr, len, 0n) as bigint
    const unsigned = result < 0n ? result + 0x10000000000000000n : result
    expect(unsigned).toBe(0x26c7827d889f6da3n)
  })

  test('determinism: same input twice gives same output', async () => {
    const wasm = await compileToWasm(resolve(__dirname, '../examples/crypto/xxh64/xxh64.ents'))
    const h = await createHarness(wasm)

    const input = new TextEncoder().encode('determinism test')
    h.writeInput(input)
    const r1 = h.call('xxh64', 0, input.length, 0n) as bigint
    h.writeInput(input)
    const r2 = h.call('xxh64', 0, input.length, 0n) as bigint
    expect(r1).toBe(r2)
  })

  test('adversarial: zero-length input', async () => {
    const wasm = await compileToWasm(resolve(__dirname, '../examples/crypto/xxh64/xxh64.ents'))
    const h = await createHarness(wasm)

    const result = h.call('xxh64', 0, 0, 0n) as bigint
    const unsigned = result < 0n ? result + 0x10000000000000000n : result
    expect(unsigned).toBe(0xef46db3751d8e999n)
  })
})

describe('reference oracle validation', () => {
  test('SHA-512 vectors match WebCrypto', async () => {
    for (const v of sha512Vectors) {
      const input = hexToBytes(v.inputHex)
      const hash = await crypto.subtle.digest('SHA-512', input)
      const hex = Buffer.from(hash).toString('hex')
      expect(hex).toBe(v.hash)
    }
  })

  test('Ed25519 vectors verify with @noble/curves', () => {
    for (const v of ed25519Vectors) {
      const sig = hexToBytes(v.signature)
      const msg = hexToBytes(v.message)
      const pk = hexToBytes(v.publicKey)
      expect(ed25519.verify(sig, msg, pk)).toBe(true)
    }
  })
})
