import { createInstalledCryptoCapabilityDescriptors } from './capabilities.js'
import type { CryptoCapabilityDescriptor } from './capabilities.js'
import { cryptoError } from './errors.js'
import { freeze } from './intrinsics.js'
import { createCryptoSyntheticModuleBinding } from './node-crypto.js'
import type { CryptoSyntheticModuleBinding } from './node-crypto.js'
import { CryptoPrimitivePort } from './primitive-port.js'
import { runProviderSelfTest } from './runtime-self-test.js'
import type { CryptoPrimitivePortOptions } from './types.js'
import { installRuntimeWebCrypto } from './web-crypto.js'
import type { RuntimeWebCrypto } from './web-crypto.js'

export interface InstalledCryptoRuntime {
  readonly capabilityDescriptors: readonly CryptoCapabilityDescriptor[]
  createSyntheticModuleBinding(): CryptoSyntheticModuleBinding
  dispose(): void
  installWebCrypto(target: object): RuntimeWebCrypto
}

/**
 * Installs a host provider only after the complete required-now primitive self-test passes.
 * Android entropy warm-up, RuntimeThreadGuard and JCA wiring remain host follow-up work.
 */
export const installCryptoRuntime = (
  options: CryptoPrimitivePortOptions
): InstalledCryptoRuntime => {
  const port = new CryptoPrimitivePort(options)
  try {
    if (port.limits.maxRandomBytesPerCall < 65_536) {
      throw new Error('web crypto random-values limit is incomplete')
    }
    runProviderSelfTest(port)
  } catch {
    try {
      port.dispose()
    } catch {
      // The stable install failure below intentionally hides adapter/native details.
    }
    throw cryptoError('ERR_HOLONOMY_CRYPTO_OPERATION_FAILED')
  }
  const capabilityDescriptors = createInstalledCryptoCapabilityDescriptors(port.limits)
  let disposed = false
  const assertInstalled = (): void => {
    if (disposed) throw cryptoError('ERR_HOLONOMY_CRYPTO_DISPOSED')
  }
  return freeze({
    capabilityDescriptors,
    createSyntheticModuleBinding: () => {
      assertInstalled()
      return createCryptoSyntheticModuleBinding(port)
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      port.dispose()
    },
    installWebCrypto: (target: object) => {
      assertInstalled()
      return installRuntimeWebCrypto(target, port)
    }
  })
}
