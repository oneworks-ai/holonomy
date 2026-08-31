import { writeBytes, zeroBytes } from './binary-intrinsics.js'
import { createRuntimeSet, runtimeSetAdd, runtimeSetValues } from './intrinsics.js'
import type { CryptoPrimitivePort } from './primitive-port.js'

const hexBytes = (hex: string): Uint8Array => {
  const output = new Uint8Array(hex.length / 2)
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return output
}

const concatBytes = (first: Uint8Array, second: Uint8Array): Uint8Array => {
  const output = new Uint8Array(first.byteLength + second.byteLength)
  writeBytes(output, first)
  writeBytes(new Uint8Array(output.buffer, first.byteLength, second.byteLength), second)
  return output
}

const expectEqual = (
  port: CryptoPrimitivePort,
  actual: Uint8Array,
  expected: Uint8Array
): void => {
  if (!port.timingSafeEqual(actual, expected)) throw new Error('crypto self-test mismatch')
}

export const runProviderSelfTest = (port: CryptoPrimitivePort): void => {
  const temporaries = createRuntimeSet<Uint8Array>()
  const track = (bytes: Uint8Array): Uint8Array => {
    runtimeSetAdd(temporaries, bytes)
    return bytes
  }
  try {
    const abc = track(new Uint8Array([0x61, 0x62, 0x63]))
    const sha1 = port.createContext({ algorithm: 'sha1', kind: 'hash' })
    port.update(sha1, abc)
    expectEqual(
      port,
      track(port.digest(sha1)),
      track(hexBytes('a9993e364706816aba3e25717850c26c9cd0d89d'))
    )

    const sha256 = port.createContext({ algorithm: 'sha256', kind: 'hash' })
    port.update(sha256, abc)
    expectEqual(
      port,
      track(port.digest(sha256)),
      track(hexBytes('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'))
    )

    const hmacKey = track(new Uint8Array(20))
    for (let index = 0; index < hmacKey.length; index += 1) hmacKey[index] = 0x0B
    const hmacData = track(
      new Uint8Array([
        0x48,
        0x69,
        0x20,
        0x54,
        0x68,
        0x65,
        0x72,
        0x65
      ])
    )
    const hmac = port.createContext({ algorithm: 'sha256', key: hmacKey, kind: 'hmac' })
    port.update(hmac, hmacData)
    expectEqual(
      port,
      track(port.digest(hmac)),
      track(hexBytes('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'))
    )

    const random = track(port.randomBytes(16))
    if (random.byteLength !== 16) throw new Error('crypto self-test random failure')

    const key = track(new Uint8Array(32))
    const iv = track(new Uint8Array(12))
    const plaintext = track(new Uint8Array(16))
    const cipher = port.createContext({ algorithm: 'aes-256-gcm', iv, key, kind: 'cipher' })
    const ciphertextHead = track(port.update(cipher, plaintext))
    const encryptedFinal = port.final(cipher)
    track(encryptedFinal.output)
    track(encryptedFinal.authTag!)
    const ciphertext = track(concatBytes(ciphertextHead, encryptedFinal.output))
    expectEqual(port, ciphertext, track(hexBytes('cea7403d4d606b6e074ec5d3baf39d18')))
    expectEqual(
      port,
      encryptedFinal.authTag!,
      track(hexBytes('d0d1c8a799996bf0265b98b5d48ab919'))
    )

    const decipher = port.createContext({ algorithm: 'aes-256-gcm', iv, key, kind: 'decipher' })
    port.setAuthTag(decipher, encryptedFinal.authTag!)
    const plaintextHead = track(port.update(decipher, ciphertext))
    const decryptedFinal = port.final(decipher)
    track(decryptedFinal.output)
    expectEqual(port, track(concatBytes(plaintextHead, decryptedFinal.output)), plaintext)

    const aad = track(new Uint8Array([1, 2, 3, 4]))
    const aadCipher = port.createContext({ algorithm: 'aes-256-gcm', iv, key, kind: 'cipher' })
    port.setAAD(aadCipher, aad)
    const aadCipherHead = track(port.update(aadCipher, abc))
    const aadEncryptedFinal = port.final(aadCipher)
    track(aadEncryptedFinal.output)
    track(aadEncryptedFinal.authTag!)
    const aadDecipher = port.createContext({
      algorithm: 'aes-256-gcm',
      iv,
      key,
      kind: 'decipher'
    })
    port.setAAD(aadDecipher, aad)
    port.setAuthTag(aadDecipher, aadEncryptedFinal.authTag!)
    const aadCiphertext = track(concatBytes(aadCipherHead, aadEncryptedFinal.output))
    const aadPlainHead = track(port.update(aadDecipher, aadCiphertext))
    const aadPlainFinal = port.final(aadDecipher)
    track(aadPlainFinal.output)
    expectEqual(port, track(concatBytes(aadPlainHead, aadPlainFinal.output)), abc)

    if (port.timingSafeEqual(track(new Uint8Array([1])), track(new Uint8Array([2])))) {
      throw new Error('crypto self-test comparison failure')
    }
  } finally {
    const values = runtimeSetValues(temporaries)
    for (let index = 0; index < values.length; index += 1) zeroBytes(values[index])
  }
}
