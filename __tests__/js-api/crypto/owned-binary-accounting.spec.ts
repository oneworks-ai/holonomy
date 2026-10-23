import { describe, expect, it } from 'vitest'

import { createHash } from '../../../src/crypto/node-hash.js'
import { CryptoPrimitivePort } from '../../../src/crypto/primitive-port.js'
import { createTestProvider, overrideProvider } from './fixtures.js'

describe('crypto owned binary accounting', () => {
  it.each([['hex', '61'], ['base64', 'YQ=='], ['base64url', 'YQ']] as const)(
    'decodes %s input without consulting a mutable output length getter',
    (encoding, value) => {
      let observed = -1
      const port = new CryptoPrimitivePort({
        provider: overrideProvider(createTestProvider(), {
          createContext: () => ({}),
          disposeContext: () => undefined,
          dispose: () => undefined,
          update: (_context, bytes) => {
            observed = bytes[0]!
            return new Uint8Array(0)
          },
          digest: () => new Uint8Array(32)
        })
      })
      const hash = createHash(port, 'sha256')
      const prototype = Object.getPrototypeOf(Uint8Array.prototype)
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'length')!
      let callbacks = 0
      let digest
      try {
        Object.defineProperty(prototype, 'length', {
          configurable: true,
          get() {
            callbacks += 1
            throw new Error('Guest length getter')
          }
        })
        digest = hash.update(value, encoding).digest('hex')
      } finally {
        Object.defineProperty(prototype, 'length', descriptor)
        port.dispose()
      }
      expect(callbacks).toBe(0)
      expect(observed).toBe(97)
      expect(digest).toBe('00'.repeat(32))
    }
  )

  it('never reads mutable typed-array getters after taking an input snapshot', () => {
    const provider = overrideProvider(createTestProvider(), {
      createContext: request => ({ kind: request.kind }),
      update: () => new Uint8Array(0),
      digest: () => new Uint8Array(32),
      disposeContext: () => undefined,
      dispose: () => undefined,
      setAAD: () => undefined,
      setAuthTag: () => undefined,
      final: context =>
        (context as { kind: string }).kind === 'cipher'
          ? { output: new Uint8Array(3), authTag: new Uint8Array(16) }
          : { output: new Uint8Array(3), authenticated: true }
    })
    const port = new CryptoPrimitivePort({ provider })
    const input = new Uint8Array(3)
    const key = new Uint8Array(32)
    const iv = new Uint8Array(12)
    const tag = new Uint8Array(16)
    const prototype = Object.getPrototypeOf(Uint8Array.prototype)
    const fields = ['byteLength', 'buffer', 'length']
    const originals = fields.map(field => Object.getOwnPropertyDescriptor(prototype, field)!)
    let calls = 0
    let digest: Uint8Array | undefined
    let encrypted: Uint8Array | undefined
    let decrypted: Uint8Array | undefined
    try {
      for (const field of fields) {
        Object.defineProperty(prototype, field, {
          configurable: true,
          get() {
            calls += 1
            throw new Error('Guest getter executed')
          }
        })
      }
      const hash = port.createContext({ kind: 'hash', algorithm: 'sha256' })
      port.update(hash, input)
      digest = port.digest(hash)
      const cipher = port.createContext({ kind: 'cipher', algorithm: 'aes-256-gcm', key, iv })
      port.setAAD(cipher, input)
      port.update(cipher, input)
      encrypted = port.final(cipher).output
      const decipher = port.createContext({ kind: 'decipher', algorithm: 'aes-256-gcm', key, iv })
      port.setAuthTag(decipher, tag)
      port.update(decipher, input)
      decrypted = port.final(decipher).output
    } finally {
      fields.forEach((field, index) => Object.defineProperty(prototype, field, originals[index]!))
      port.dispose()
    }
    expect(calls).toBe(0)
    expect(digest).toHaveLength(32)
    expect(encrypted).toHaveLength(3)
    expect(decrypted).toHaveLength(3)
  })
})
