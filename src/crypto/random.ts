import { zeroBytes } from './binary-intrinsics.js'
import { encodeCryptoOutput } from './facade-codec.js'
import type { CryptoPrimitivePort } from './primitive-port.js'

export const randomUUID = (port: CryptoPrimitivePort): string => {
  const bytes = port.randomBytes(16)
  try {
    bytes[6] = (bytes[6]! & 0x0F) | 0x40
    bytes[8] = (bytes[8]! & 0x3F) | 0x80
    const hex = encodeCryptoOutput(bytes, 'hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  } finally {
    zeroBytes(bytes)
  }
}
