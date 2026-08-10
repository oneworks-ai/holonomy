import { Buffer as NodeBuffer } from 'node:buffer'
import {
  createCipheriv as createNodeCipheriv,
  createHash as createNodeHash,
  createHmac as createNodeHmac
} from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { createCryptoSyntheticModule } from '../../src/crypto/node-crypto.js'

import { concatBytes, createTestPort } from './fixtures.js'

const bytes = (hex: string): Uint8Array => {
  const output = new Uint8Array(hex.length / 2)
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return output
}

describe('mobile crypto required-now vectors', () => {
  it.each(['sha1', 'sha256'] as const)(
    'matches Node %s across multiple updates and digest encodings',
    algorithm => {
      for (const encoding of [undefined, 'hex', 'base64', 'base64url'] as const) {
        const runtime = createCryptoSyntheticModule(createTestPort()).createHash(algorithm)
        runtime.update('mobile ').update('runtime')
        const actual = encoding === undefined ? runtime.digest() : runtime.digest(encoding)
        const node = createNodeHash(algorithm).update('mobile ').update('runtime')
        const expected = encoding === undefined ? node.digest() : node.digest(encoding)
        expect(typeof actual === 'string' ? actual : [...actual]).toEqual(
          typeof expected === 'string' ? expected : [...expected]
        )
      }
    }
  )

  it('matches RFC 4231 and Node HMAC-SHA256', () => {
    const runtime = createCryptoSyntheticModule(createTestPort())
      .createHmac('sha256', bytes('0b'.repeat(20)))
      .update('Hi ')
      .update('There')
      .digest('hex')
    expect(runtime).toBe('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7')
    expect(runtime).toBe(
      createNodeHmac('sha256', bytes('0b'.repeat(20))).update('Hi There').digest('hex')
    )
  })

  it('matches the NIST AES-256-GCM zero vector', () => {
    const crypto = createCryptoSyntheticModule(createTestPort())
    const key = new Uint8Array(32)
    const iv = new Uint8Array(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const encrypted = concatBytes(cipher.update(new Uint8Array(16)) as Uint8Array, cipher.final())
    expect(encrypted).toEqual(bytes('cea7403d4d606b6e074ec5d3baf39d18'))
    expect([...cipher.getAuthTag()]).toEqual([
      ...bytes('d0d1c8a799996bf0265b98b5d48ab919')
    ])
  })

  it('matches Node AES-GCM across updates, AAD, tag and base64url output', () => {
    const key = bytes('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f')
    const iv = bytes('101112131415161718191a1b')
    const aad = bytes('a0a1a2a3a4a5a6')
    const first = bytes('001122334455')
    const second = bytes('66778899aabbccddeeff')

    const runtimeCipher = createCryptoSyntheticModule(createTestPort())
      .createCipheriv('aes-256-gcm', key, iv)
      .setAAD(aad)
    const runtimeEncrypted = concatBytes(
      runtimeCipher.update(first) as Uint8Array,
      runtimeCipher.update(second) as Uint8Array,
      runtimeCipher.final()
    )
    const runtimeTag = runtimeCipher.getAuthTag()

    const nodeCipher = createNodeCipheriv('aes-256-gcm', key, iv)
    nodeCipher.setAAD(aad)
    const nodeEncrypted = concatBytes(nodeCipher.update(first), nodeCipher.update(second), nodeCipher.final())
    expect(runtimeEncrypted).toEqual(nodeEncrypted)
    expect([...runtimeTag]).toEqual([...nodeCipher.getAuthTag()])

    const runtimeDecipher = createCryptoSyntheticModule(createTestPort())
      .createDecipheriv('aes-256-gcm', key, iv)
      .setAAD(aad)
      .setAuthTag(runtimeTag)
    expect(concatBytes(
      runtimeDecipher.update(runtimeEncrypted) as Uint8Array,
      runtimeDecipher.final()
    )).toEqual(concatBytes(first, second))

    const encodedCipher = createCryptoSyntheticModule(createTestPort())
      .createCipheriv('aes-256-gcm', key, iv)
    const encoded = `${encodedCipher.update(concatBytes(first, second), 'base64url')}${
      encodedCipher.final('base64url')
    }`
    expect(encoded).toBe(NodeBuffer.from(nodeEncrypted).toString('base64url'))
  })

  it('rejects AES-GCM tampering with a stable redacted error', () => {
    const crypto = createCryptoSyntheticModule(createTestPort())
    const key = new Uint8Array(32)
    const iv = new Uint8Array(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const ciphertext = concatBytes(cipher.update('secret') as Uint8Array, cipher.final())
    const tag = cipher.getAuthTag()
    tag[0] ^= 1
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv).setAuthTag(tag)
    decipher.update(ciphertext)
    expect(() => decipher.final()).toThrowError(expect.objectContaining({
      code: 'ERR_CRYPTO_INVALID_AUTH_TAG',
      message: 'The supplied crypto authentication tag is invalid'
    }))
  })

  it('returns deterministic random bytes and RFC 4122 version/variant UUIDs', () => {
    const first = createCryptoSyntheticModule(createTestPort())
    const second = createCryptoSyntheticModule(createTestPort())
    expect(first.randomBytes(32)).toEqual(second.randomBytes(32))
    const uuid = first.randomUUID()
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
  })
})
