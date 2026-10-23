// Thin trusted adapter. Context records never leave the shared primitive port.
const freeze = Object.freeze
const NativeUint8Array = Uint8Array
const NativeError = Error

export const createNativeCryptoProvider = call => {
  const empty = new NativeUint8Array(0)
  return freeze({
    createContext(request) {
      let kind
      if (request.kind === 'hash' && request.algorithm === 'sha1') kind = 0
      else if (request.kind === 'hash' && request.algorithm === 'sha256') kind = 1
      else if (request.kind === 'hmac' && request.algorithm === 'sha256') kind = 2
      else if (request.kind === 'cipher' && request.algorithm === 'aes-256-gcm') kind = 3
      else if (request.kind === 'decipher' && request.algorithm === 'aes-256-gcm') kind = 4
      else throw new NativeError('Unsupported native crypto algorithm')
      return freeze({ id: call(0, kind, kind < 2 ? empty : request.key, kind < 3 ? empty : request.iv) })
    },
    update: (context, data) => call(1, context.id, data),
    digest: context => call(2, context.id),
    setAAD: (context, aad) => call(3, context.id, aad),
    setAuthTag: (context, tag) => call(4, context.id, tag),
    final: context => call(5, context.id),
    randomBytes: size => call(6, size),
    timingSafeEqual: (left, right) => call(7, left, right),
    disposeContext: context => call(8, context.id),
    dispose: () => call(9)
  })
}
