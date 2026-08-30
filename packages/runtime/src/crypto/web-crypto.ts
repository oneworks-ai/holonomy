import { inspectTypedArray, isIntegerTypedArrayKind, writeBytes, zeroBytes } from './binary-intrinsics.js'
import { invalidArgumentType, outOfRange } from './errors.js'
import { freeze } from './intrinsics.js'
import { defineCryptoGlobal } from './object-intrinsics.js'
import type { CryptoPrimitivePort } from './primitive-port.js'
import { randomUUID } from './random.js'

export interface RuntimeWebCrypto {
  getRandomValues<Array extends ArrayBufferView>(array: Array): Array
  randomUUID(): string
}

export const createRuntimeWebCrypto = (port: CryptoPrimitivePort): RuntimeWebCrypto => {
  const runtimeCrypto: RuntimeWebCrypto = {
    getRandomValues<Array extends ArrayBufferView>(array: Array): Array {
      const snapshot = inspectTypedArray(array)
      if (!isIntegerTypedArrayKind(snapshot.kind)) {
        return invalidArgumentType()
      }
      if (snapshot.bytes.byteLength > 65_536 || snapshot.bytes.byteLength > port.limits.maxRandomBytesPerCall) {
        return outOfRange()
      }
      const random = port.randomBytes(snapshot.bytes.byteLength)
      try {
        writeBytes(snapshot.bytes, random)
      } finally {
        zeroBytes(random)
      }
      return array
    },
    randomUUID: () => randomUUID(port)
  }
  return freeze(runtimeCrypto)
}

export const installRuntimeWebCrypto = (
  target: object,
  port: CryptoPrimitivePort
): RuntimeWebCrypto => {
  if ((typeof target !== 'object' && typeof target !== 'function') || target === null) {
    return invalidArgumentType()
  }
  const runtimeCrypto = createRuntimeWebCrypto(port)
  defineCryptoGlobal(target, runtimeCrypto)
  return runtimeCrypto
}
