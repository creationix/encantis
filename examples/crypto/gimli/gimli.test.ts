import { gimli, gimliHash, toHex } from "./gimli.js"
import { expect, test } from 'bun:test'

test('gimli permutation on zero state', () => {
  // Test vector from Gimli specification
  // Input: all zeros
  // After 24 rounds, the state should match known output
  const state = new Uint32Array(12).fill(0)
  const result = gimli(state)

  // Known test vector for gimli(0)
  expect(result[0]).toBe(0x6ee5acf1)
  expect(result[1]).toBe(0x3f0a0861)
  expect(result[2]).toBe(0x215e5793)
  expect(result[3]).toBe(0x0b2c4f52)
})

test('gimli permutation on test vector', () => {
  // Input state: 0, 1, 2, ..., 11
  const state = new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  const result = gimli(state)

  // Verify permutation produces expected output
  expect(result.length).toBe(12)
  // State should be different from input
  expect(result[0]).not.toBe(0)
})

test('gimli hash empty string', () => {
  const hash = gimliHash("")
  expect(hash.length).toBe(32)
  expect(toHex(hash)).toBe("b0634b2c0b082aedc5c0a2fe4ee3adcfc989ec05de6f00addb04b3aaac271f67")
})

test('gimli hash "hello"', () => {
  const hash = gimliHash("hello")
  expect(hash.length).toBe(32)
  // Verify hash is deterministic
  const hash2 = gimliHash("hello")
  expect(toHex(hash)).toBe(toHex(hash2))
})

test('gimli hash produces different outputs for different inputs', () => {
  const h1 = toHex(gimliHash("test1"))
  const h2 = toHex(gimliHash("test2"))
  expect(h1).not.toBe(h2)
})

test('gimli hash longer input', () => {
  // Test with input longer than one block (16 bytes)
  const input = "This is a longer test input that spans multiple blocks"
  const hash = gimliHash(input)
  expect(hash.length).toBe(32)
})
