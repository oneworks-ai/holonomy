import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// Trusted, synchronous provider. The shared CryptoPrimitivePort owns public
// validation, quotas, context identity and redacted errors. No native object is
// returned across the VM boundary; node-crypto-bridge owns that translation.
export function createNodeCryptoProvider() {
  const contexts = new Set()
  let disposed = false
  const active = context => {
    if (disposed || !contexts.has(context)) throw new Error('Crypto provider unavailable')
    return context
  }
  const assertOpen = () => {
    if (disposed) throw new Error('Crypto provider unavailable')
  }
  return Object.freeze({
    createContext(request) {
      assertOpen()
      if (contexts.size >= 64) throw new Error('Crypto provider unavailable')
      let native
      if (request.kind === 'hash' && ['sha1', 'sha256'].includes(request.algorithm)) {
        native = createHash(request.algorithm)
      } else if (request.kind === 'hmac' && request.algorithm === 'sha256') {
        native = createHmac('sha256', request.key)
      } else if (
        ['cipher', 'decipher'].includes(request.kind) && request.algorithm === 'aes-256-gcm' &&
        request.key.byteLength === 32 && request.iv.byteLength === 12
      ) {
        native = request.kind === 'cipher'
          ? createCipheriv('aes-256-gcm', request.key, request.iv, { authTagLength: 16 })
          : createDecipheriv('aes-256-gcm', request.key, request.iv, { authTagLength: 16 })
      } else throw new Error('Crypto provider unavailable')
      const context = { kind: request.kind, native }
      contexts.add(context)
      return context
    },
    digest(context) {
      return active(context).native.digest()
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const context of contexts) context.native = undefined
      contexts.clear()
    },
    disposeContext(context) {
      if (!contexts.delete(context)) return
      context.native = undefined
    },
    final(context) {
      const record = active(context)
      if (record.kind === 'decipher') {
        try {
          return { authenticated: true, output: record.native.final() }
        } catch {
          return { authenticated: false, output: new Uint8Array() }
        }
      }
      const output = record.native.final()
      return { authTag: record.native.getAuthTag(), output }
    },
    randomBytes(size) {
      assertOpen()
      return randomBytes(size)
    },
    setAAD(context, aad) {
      active(context).native.setAAD(aad)
    },
    setAuthTag(context, tag) {
      active(context).native.setAuthTag(tag)
    },
    timingSafeEqual(left, right) {
      assertOpen()
      return timingSafeEqual(left, right)
    },
    update(context, data) {
      const record = active(context)
      if (record.kind === 'hash' || record.kind === 'hmac') {
        record.native.update(data)
        return new Uint8Array()
      }
      return record.native.update(data)
    }
  })
}
