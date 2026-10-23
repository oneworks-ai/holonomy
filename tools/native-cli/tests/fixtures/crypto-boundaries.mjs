import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual, webcrypto } from 'node:crypto'
import process from 'node:process'

assert.equal(globalThis.__holoNativeHost, undefined)
assert.equal(webcrypto.subtle, undefined)
assert.throws(() => createHash('md5'), { code: 'ERR_CRYPTO_UNKNOWN_HASH' })
assert.throws(() => randomBytes(65537), { code: 'ERR_HOLONOMY_RESOURCE_EXHAUSTED' })
assert.throws(() => timingSafeEqual(new Uint8Array(1), new Uint8Array(2)), {
  code: 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH'
})

let callbacks = 0
const trap = () => {
  callbacks++
  throw new Error('MUST_NOT_EXECUTE')
}
const proxy = new Proxy(new Uint8Array(1), {
  get: trap,
  getPrototypeOf: trap,
  getOwnPropertyDescriptor: trap,
  ownKeys: trap
})
assert.throws(() => createHash('sha256').update(proxy), { code: 'ERR_INVALID_ARG_TYPE' })
assert.equal(callbacks, 0)
const hash = createHash('sha256')
for (
  const bytes of [new Uint8Array(new SharedArrayBuffer(1)), new Uint8Array(new ArrayBuffer(1, { maxByteLength: 2 }))]
) {
  assert.throws(() => hash.update(bytes), { code: 'ERR_INVALID_ARG_TYPE' })
}
const detachedBuffer = new ArrayBuffer(1)
const detached = new Uint8Array(detachedBuffer)
detachedBuffer.transfer()
assert.throws(() => hash.update(detached), { code: 'ERR_INVALID_ARG_TYPE' })
assert.throws(() => hash.update(new Uint8Array(1024 * 1024 + 1)), { code: 'ERR_HOLONOMY_RESOURCE_EXHAUSTED' })
hash.update(new Uint8Array([97, 98, 99]))
assert.equal(hash.digest('hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')

// Public facades and native bridge use captured intrinsics, not these properties.
const define = Object.defineProperty
const freeze = Object.freeze
const arraySet = Uint8Array.prototype.set
try {
  define(Object, 'freeze', { value: trap })
  define(Uint8Array.prototype, 'set', { value: trap, configurable: true })
  class HostileBytes extends Uint8Array {
    get byteLength() {
      return trap()
    }
    get buffer() {
      return trap()
    }
  }
  const bytes = new HostileBytes([97, 98, 99])
  define(bytes, 'constructor', { get: trap })
  assert.equal(createHash('sha1').update(bytes).digest('hex'), 'a9993e364706816aba3e25717850c26c9cd0d89d')
  assert.equal(randomBytes(16).length, 16)
} finally {
  define(Object, 'freeze', { value: freeze })
  define(Uint8Array.prototype, 'set', { value: arraySet })
}
assert.equal(callbacks, 0)

// Native buffering must not retain aliases to Guest input or expose unverified plaintext.
const key = Buffer.alloc(32)
const iv = Buffer.alloc(12)
const input = Buffer.alloc(16)
const cipher = createCipheriv('aes-256-gcm', key, iv)
key.fill(9)
iv.fill(9)
assert.equal(cipher.update(input).length, 0)
input.fill(9)
const encrypted = cipher.final()
assert.equal(encrypted.toString('hex'), 'cea7403d4d606b6e074ec5d3baf39d18')
const decrypt = createDecipheriv('aes-256-gcm', Buffer.alloc(32), Buffer.alloc(12))
decrypt.setAuthTag(Buffer.alloc(16))
assert.equal(decrypt.update(encrypted).length, 0)
assert.throws(() => decrypt.final(), { code: 'ERR_CRYPTO_INVALID_AUTH_TAG' })
for (let i = 0; i < 128; i++) createHash('sha256').update('capacity-reusable').digest()
process.stdout.write('NATIVE_CRYPTO_BOUNDARIES_OK\n')
