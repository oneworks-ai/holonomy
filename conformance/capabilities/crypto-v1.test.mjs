import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from 'node:crypto'
import { describe, it } from 'node:test'

describe('installed native Crypto primitives', () => {
  it('hashes SHA-1 and incremental SHA-256', () => {
    assert.equal(createHash('sha1').update('abc').digest('hex'), 'a9993e364706816aba3e25717850c26c9cd0d89d')
    assert.equal(
      createHash('sha256').update('a').update('bc').digest('hex'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })
  it('computes the RFC 4231 HMAC vector', () => {
    assert.equal(
      createHmac('sha256', Buffer.alloc(20, 0x0B)).update('Hi There').digest('hex'),
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'
    )
  })
  it('encrypts and decrypts the NIST AES-256-GCM vector', () => {
    const key = Buffer.alloc(32)
    const iv = Buffer.alloc(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const encrypted = Buffer.concat([cipher.update(Buffer.alloc(16)), cipher.final()])
    const tag = cipher.getAuthTag()
    assert.equal(encrypted.toString('hex'), 'cea7403d4d606b6e074ec5d3baf39d18')
    assert.equal(tag.toString('hex'), 'd0d1c8a799996bf0265b98b5d48ab919')
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    assert.equal(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('hex'), '00'.repeat(16))
  })
  it('rejects an invalid authentication tag', () => {
    const decipher = createDecipheriv('aes-256-gcm', Buffer.alloc(32), Buffer.alloc(12))
    decipher.setAuthTag(Buffer.alloc(16))
    decipher.update(Buffer.from('cea7403d4d606b6e074ec5d3baf39d18', 'hex'))
    assert.throws(() => decipher.final(), { code: 'ERR_CRYPTO_INVALID_AUTH_TAG' })
  })
  it('provides secure random, UUID and byte comparison APIs', () => {
    const bytes = randomBytes(32)
    assert.equal(bytes.byteLength, 32)
    assert.equal(randomBytes(0).byteLength, 0)
    assert.match(randomUUID(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    assert.equal(timingSafeEqual(bytes, Buffer.from(bytes)), true)
    const other = Buffer.from(bytes)
    other[0] ^= 1
    assert.equal(timingSafeEqual(bytes, other), false)
    const target = new Uint8Array(16)
    assert.equal(globalThis.crypto.getRandomValues(target), target)
  })
  it('does not consult mutable binary getters or species during native work', () => {
    const prototype = Object.getPrototypeOf(Uint8Array.prototype)
    const properties = [[prototype, 'buffer'], [prototype, 'byteLength'], [prototype, 'length'], [
      ArrayBuffer.prototype,
      'byteLength'
    ], [Uint8Array, Symbol.species]]
    const descriptors = properties.map(([object, key]) => Object.getOwnPropertyDescriptor(object, key))
    const input = new Uint8Array([97, 98, 99])
    let callbacks = 0
    let digest
    try {
      for (const [object, key] of properties) {
        Object.defineProperty(object, key, {
          configurable: true,
          get() {
            callbacks += 1
            throw new Error('Guest binary callback executed')
          }
        })
      }
      digest = createHash('sha256').update(input).digest('hex')
    } finally {
      for (let index = 0; index < properties.length; index += 1) {
        const [object, key] = properties[index]
        if (descriptors[index]) Object.defineProperty(object, key, descriptors[index])
        else delete object[key]
      }
    }
    assert.equal(callbacks, 0)
    assert.equal(digest, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
