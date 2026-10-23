// This closure is created before Guest entry. Native handles never cross the
// shared CryptoPrimitivePort's opaque-context boundary.
const freeze = Object.freeze
const NativeUint8Array = Uint8Array
const NativeError = Error
const apply = Reflect.apply
const fill = Uint8Array.prototype.fill
const lengthGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'length').get
const bufferGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'buffer').get
const cut = (bytes, start, end) => {
  const length = apply(lengthGetter, bytes, [])
  const from = start < 0 ? length + start : start
  const to = end === undefined ? length : end < 0 ? length + end : end
  const copy = new NativeUint8Array(to - from)
  // No slice/subarray/species or Guest-replaceable length accessor is consulted.
  for (let index = 0; index < to - from; index += 1) copy[index] = bytes[from + index]
  return copy
}

export const createAndroidCryptoProvider = nativeCall => {
  const empty = new NativeUint8Array(0)
  const call = (op, id = 0, left = empty, right = empty) => {
    const leftCopy = cut(left, 0)
    const rightCopy = cut(right, 0)
    const leftLength = apply(lengthGetter, leftCopy, [])
    const rightLength = apply(lengthGetter, rightCopy, [])
    try {
      const result = nativeCall(op, id, apply(bufferGetter, leftCopy, []), apply(bufferGetter, rightCopy, []))
      return op === 1 || op === 2 || op === 5 || op === 6 ? new NativeUint8Array(result) : result
    } catch {
      throw new NativeError('Cryptographic primitive failed')
    } finally {
      for (let index = 0; index < leftLength; index += 1) leftCopy[index] = 0
      for (let index = 0; index < rightLength; index += 1) rightCopy[index] = 0
    }
  }
  return freeze({
    createContext(request) {
      let kind
      if (request.kind === 'hash' && request.algorithm === 'sha1') kind = 0
      else if (request.kind === 'hash' && request.algorithm === 'sha256') kind = 1
      else if (request.kind === 'hmac' && request.algorithm === 'sha256') kind = 2
      else if (request.kind === 'cipher' && request.algorithm === 'aes-256-gcm') kind = 3
      else if (request.kind === 'decipher' && request.algorithm === 'aes-256-gcm') kind = 4
      else throw new NativeError('Unsupported crypto algorithm')
      return freeze({ id: call(0, kind, kind < 2 ? empty : request.key, kind < 3 ? empty : request.iv), kind })
    },
    update: (context, bytes) => call(1, context.id, bytes),
    digest: context => call(2, context.id),
    setAAD: (context, bytes) => {
      call(3, context.id, bytes)
    },
    setAuthTag: (context, bytes) => {
      call(4, context.id, bytes)
    },
    final(context) {
      const packet = call(5, context.id)
      try {
        if (context.kind === 3) return { output: cut(packet, 1, -16), authTag: cut(packet, -16) }
        return { output: cut(packet, 1), authenticated: packet[0] === 1 }
      } finally {
        apply(fill, packet, [0])
      }
    },
    randomBytes: size => call(6, size),
    timingSafeEqual: (left, right) => call(7, 0, left, right),
    disposeContext: context => {
      call(8, context.id)
    },
    dispose: () => {
      call(9)
    }
  })
}
