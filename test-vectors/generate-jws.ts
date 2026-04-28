#!/usr/bin/env bun
// Generate JWS (JSON Web Signature) test vectors
// JWS Compact Serialization: BASE64URL(header).BASE64URL(payload).BASE64URL(signature)

function base64url(data: Uint8Array): string {
  return Buffer.from(data).toString('base64url')
}

function base64urlDecode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64url'))
}

const vectors: {
  label: string
  header: string
  payload: string
  headerB64: string
  payloadB64: string
  signingInput: string
}[] = []

const cases = [
  { label: 'minimal', header: '{"alg":"EdDSA"}', payload: '{}' },
  { label: 'with-kid', header: '{"alg":"EdDSA","kid":"key-1"}', payload: '{"sub":"user"}' },
  { label: 'empty-payload', header: '{"alg":"EdDSA"}', payload: '' },
  { label: 'large-payload', header: '{"alg":"EdDSA"}', payload: JSON.stringify({ data: 'x'.repeat(256) }) },
  { label: 'unicode', header: '{"alg":"EdDSA"}', payload: '{"name":"日本語"}' },
]

for (const c of cases) {
  const headerB64 = base64url(new TextEncoder().encode(c.header))
  const payloadB64 = base64url(new TextEncoder().encode(c.payload))
  const signingInput = `${headerB64}.${payloadB64}`
  vectors.push({
    label: c.label,
    header: c.header,
    payload: c.payload,
    headerB64,
    payloadB64,
    signingInput,
  })
}

await Bun.write('test-vectors/jws.json', JSON.stringify(vectors, null, 2))
console.log(`Generated ${vectors.length} JWS vectors`)
