import { CryptoPrimitivePort } from '../../../src/crypto/primitive-port.js'
import { createDeterministicCryptoPrimitiveProvider } from '../../../src/crypto/reference-provider.js'
import type { CryptoPrimitiveLimits, CryptoPrimitiveProvider } from '../../../src/crypto/types.js'

export const createTestProvider = (): CryptoPrimitiveProvider =>
  createDeterministicCryptoPrimitiveProvider({ seed: 0x1234_5678 })

export const createTestPort = (
  limits?: Partial<CryptoPrimitiveLimits>,
  provider: CryptoPrimitiveProvider = createTestProvider()
): CryptoPrimitivePort => new CryptoPrimitivePort({ limits, provider })

export const overrideProvider = (
  base: CryptoPrimitiveProvider,
  overrides: Partial<CryptoPrimitiveProvider>
): CryptoPrimitiveProvider =>
  Object.freeze({
    createContext: overrides.createContext ?? base.createContext,
    digest: overrides.digest ?? base.digest,
    dispose: overrides.dispose ?? base.dispose,
    disposeContext: overrides.disposeContext ?? base.disposeContext,
    final: overrides.final ?? base.final,
    randomBytes: overrides.randomBytes ?? base.randomBytes,
    setAAD: overrides.setAAD ?? base.setAAD,
    setAuthTag: overrides.setAuthTag ?? base.setAuthTag,
    timingSafeEqual: overrides.timingSafeEqual ?? base.timingSafeEqual,
    update: overrides.update ?? base.update
  })

export const concatBytes = (...parts: readonly Uint8Array[]): Uint8Array => {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}
