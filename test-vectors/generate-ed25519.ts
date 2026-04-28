#!/usr/bin/env bun
// Generate Ed25519 test vectors using @noble/curves as ground truth
// Includes RFC 8032 test vectors

import { ed25519 } from '@noble/curves/ed25519.js'

const vectors: {
  label: string
  privateKey: string
  publicKey: string
  message: string
  signature: string
}[] = []

// RFC 8032 Section 7.1 test vectors
const rfc8032 = [
  {
    label: 'rfc8032-1',
    sk: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    msg: '',
  },
  {
    label: 'rfc8032-2',
    sk: '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
    msg: '72',
  },
  {
    label: 'rfc8032-3',
    sk: 'c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7',
    msg: 'af82',
  },
  {
    label: 'rfc8032-1024',
    sk: 'f5e5767cf153319517630f226876b86c8160cc583bc013744c6bf255f5cc0ee5',
    msg: '08b8b2b733424243760fe426a4b54908632110a66c2f6591eabd3345e3e4eb98fa6e264bf09efe12ee50f8f54e9f77b1e355f6c50544e23fb1433ddf7397b970b6764c1fd759240' +
         '55f3d24d0e2f76c6e8d4b3a20e1470d62970029d67cb13db9e8cdea31ef07cb6acf28737b0baa6e544465c5de5f32e3cfe9d38db3eea3bd3bfa2f7e2a0124a7488ee2aa397ac19f' +
         'f6aadeedb2e67a927985fe7ecb5babf32d8e1475',
  },
]

function hexToBytes(hex: string): Uint8Array {
  if (hex.length === 0) return new Uint8Array(0)
  return new Uint8Array(hex.match(/.{2}/g)!.map(b => parseInt(b, 16)))
}

for (const tv of rfc8032) {
  const sk = hexToBytes(tv.sk)
  const pk = Buffer.from(ed25519.getPublicKey(sk)).toString('hex')
  const msg = hexToBytes(tv.msg)
  const sig = Buffer.from(ed25519.sign(msg, sk)).toString('hex')
  vectors.push({
    label: tv.label,
    privateKey: Buffer.from(sk).toString('hex'),
    publicKey: pk,
    message: tv.msg,
    signature: sig,
  })
}

// Additional generated vectors
for (let i = 0; i < 5; i++) {
  const sk = crypto.getRandomValues(new Uint8Array(32))
  const pk = ed25519.getPublicKey(sk)
  const msg = crypto.getRandomValues(new Uint8Array(32 + i * 16))
  const sig = ed25519.sign(msg, sk)
  vectors.push({
    label: `random-${i}`,
    privateKey: Buffer.from(sk).toString('hex'),
    publicKey: Buffer.from(pk).toString('hex'),
    message: Buffer.from(msg).toString('hex'),
    signature: Buffer.from(sig as Uint8Array).toString('hex'),
  })
}

const output = JSON.stringify(vectors, null, 2)
await Bun.write('test-vectors/ed25519.json', output)
console.log(`Generated ${vectors.length} Ed25519 vectors`)
