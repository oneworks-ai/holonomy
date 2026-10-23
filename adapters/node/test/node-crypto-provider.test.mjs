import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'

import { CryptoPrimitivePort, installCryptoRuntime } from '@holonomyjs/runtime/crypto/index'

import { copyNodeCryptoBytes } from '../src/node-crypto-binary.mjs'
import { normalizeNodeCryptoOptions } from '../src/node-crypto-options.mjs'
import { createNodeCryptoProvider } from '../src/node-crypto-provider.mjs'

const bytes = hex => new Uint8Array(Buffer.from(hex, 'hex'))
const port = limits => new CryptoPrimitivePort({ limits, provider: createNodeCryptoProvider() })

test('Node native provider passes the complete shared installation self-test', () => {
  const runtime = installCryptoRuntime({ provider: createNodeCryptoProvider() })
  assert.equal(runtime.capabilityDescriptors[0].id, 'host.crypto')
  assert.equal(runtime.capabilityDescriptors.length, 3)
  runtime.dispose()
  runtime.dispose()
  assert.throws(() => runtime.createSyntheticModuleBinding(), { code: 'ERR_HOLONOMY_CRYPTO_DISPOSED' })
})

test('maps native hash/HMAC and AES-GCM vectors with authenticated failure', t => {
  const crypto = port()
  t.after(() => crypto.dispose())
  for (
    const [algorithm, expected] of [
      ['sha1', 'a9993e364706816aba3e25717850c26c9cd0d89d'],
      ['sha256', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad']
    ]
  ) {
    const context = crypto.createContext({ algorithm, kind: 'hash' })
    crypto.update(context, new Uint8Array([97]))
    crypto.update(context, new Uint8Array([98, 99]))
    assert.equal(Buffer.from(crypto.digest(context)).toString('hex'), expected)
  }
  const hmac = crypto.createContext({ algorithm: 'sha256', key: new Uint8Array(20).fill(11), kind: 'hmac' })
  crypto.update(hmac, new Uint8Array(Buffer.from('Hi There')))
  assert.equal(
    Buffer.from(crypto.digest(hmac)).toString('hex'),
    'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'
  )
  const parameters = { algorithm: 'aes-256-gcm', iv: new Uint8Array(12), key: new Uint8Array(32) }
  const cipher = crypto.createContext({ ...parameters, kind: 'cipher' })
  const head = crypto.update(cipher, new Uint8Array(16))
  const result = crypto.final(cipher)
  const encrypted = new Uint8Array(Buffer.concat([head, result.output]))
  assert.equal(Buffer.from(encrypted).toString('hex'), 'cea7403d4d606b6e074ec5d3baf39d18')
  assert.equal(Buffer.from(result.authTag).toString('hex'), 'd0d1c8a799996bf0265b98b5d48ab919')
  for (const valid of [true, false]) {
    const decipher = crypto.createContext({ ...parameters, kind: 'decipher' })
    crypto.setAuthTag(decipher, valid ? result.authTag : new Uint8Array(16))
    const plain = crypto.update(decipher, encrypted)
    if (valid) assert.equal(Buffer.concat([plain, crypto.final(decipher).output]).toString('hex'), '00'.repeat(16))
    else {
      assert.throws(() => crypto.final(decipher), error => {
        assert.equal(error.code, 'ERR_CRYPTO_INVALID_AUTH_TAG')
        assert.doesNotMatch(String(error), /OpenSSL|authenticate data|provider|node:|\/private/u)
        return true
      })
    }
  }
})

test('keeps shared quota, context identity, disposal and native comparison contracts', () => {
  const crypto = port({ maxContexts: 1, maxUpdateBytesPerCall: 4 })
  const context = crypto.createContext({ algorithm: 'sha256', kind: 'hash' })
  assert.throws(() => crypto.createContext({ algorithm: 'sha256', kind: 'hash' }), {
    code: 'ERR_HOLONOMY_RESOURCE_EXHAUSTED'
  })
  assert.throws(() => crypto.update(context, new Uint8Array(5)), { code: 'ERR_HOLONOMY_RESOURCE_EXHAUSTED' })
  assert.throws(() => crypto.randomBytes(65_537))
  assert.equal(crypto.randomBytes(65_536).byteLength, 65_536)
  assert.equal(crypto.timingSafeEqual(bytes('0102'), bytes('0102')), true)
  assert.equal(crypto.timingSafeEqual(bytes('0102'), bytes('0103')), false)
  assert.throws(() => crypto.timingSafeEqual(bytes('01'), bytes('0102')))
  crypto.disposeContext(context)
  const fresh = crypto.createContext({ algorithm: 'sha256', kind: 'hash' })
  assert.throws(() => crypto.update(context, bytes('01')))
  crypto.dispose()
  crypto.dispose()
  assert.throws(() => crypto.update(fresh, bytes('01')), { code: 'ERR_HOLONOMY_CRYPTO_DISPOSED' })
  assert.throws(() => crypto.randomBytes(1), { code: 'ERR_HOLONOMY_CRYPTO_DISPOSED' })
  const other = port()
  assert.throws(() => other.update(fresh, bytes('01')))
  other.dispose()
})

test('Host copy and installation options reject Proxy/accessor/species without callbacks', () => {
  let callbacks = 0
  const trap = () => {
    callbacks++
    throw new Error('Guest callback')
  }
  const proxy = new Proxy(new Uint8Array(3), { get: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap })
  assert.throws(() => copyNodeCryptoBytes(proxy, 4))
  assert.throws(() => normalizeNodeCryptoOptions(new Proxy({}, { ownKeys: trap, getPrototypeOf: trap })))
  assert.throws(() =>
    normalizeNodeCryptoOptions({
      get enabled() {
        return trap()
      }
    })
  )
  assert.throws(() => normalizeNodeCryptoOptions({ enabled: true, provider: {} }))
  const input = new Uint8Array([1, 2, 3])
  for (const key of ['buffer', 'byteLength', 'byteOffset', 'constructor', 'then']) {
    Object.defineProperty(input, key, { get: trap })
  }
  const copied = copyNodeCryptoBytes(input, 3)
  assert.deepEqual(copied, new Uint8Array([1, 2, 3]))
  copied[0] = 9
  assert.equal(input[0], 1)
  assert.throws(() => copyNodeCryptoBytes(new Uint8Array(new SharedArrayBuffer(3)), 3))
  assert.throws(() => copyNodeCryptoBytes(new Uint8Array(new ArrayBuffer(3, { maxByteLength: 6 })), 3))
  assert.equal(callbacks, 0)
})
