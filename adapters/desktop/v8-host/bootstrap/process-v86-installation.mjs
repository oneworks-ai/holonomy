import { ProcessProviderV1 } from '../../../../packages/capabilities/process/src/host/provider.mjs'
import {
  CapabilityInvocationError,
  canonicalizeProcessInstanceResource,
  trustedInvocationValueFromJsonV1
} from '../../../../packages/runtime/src/kernel/index.ts'

import {
  NativeProcessBackendRegistryV1,
  createNativeV86ProcessBackendV1,
  normalizeNativeV86ProfileV1
} from './process-v86-backend.mjs'
import { NativeV86CommandPortV1 } from './process-v86-command.mjs'
import { NativeV86ProcessHostPortV1 } from './process-v86-host-port.mjs'
import { NativeV86ProcessNetworkPortV1 } from './process-v86-network-port.mjs'

const invalid = () => {
  throw new TypeError('Invalid private native v86 installation')
}
const exact = (value, keys) => {
  if (
    value == null || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !keys.includes(key))
  ) return invalid()
  return value
}
const artifact = value => {
  const input = exact(value, ['sha256'])
  if (typeof input.sha256 !== 'string' || !/^[a-f\d]{64}$/u.test(input.sha256)) return invalid()
  return Object.freeze({ sha256: input.sha256 })
}

export const normalizePrivateNativeV86InstallationV1 = value => {
  const input = exact(value, ['root', 'bios', 'kernel', 'initrd'])
  const root = input.root
  if (
    typeof root !== 'string' || root.length < 2 || root.length > 4096 ||
    !root.startsWith('/') || root.includes('\0') || root.endsWith('/') ||
    root.split('/').slice(1).some(component => component === '' || component === '.' || component === '..')
  ) {
    return invalid()
  }
  const bios = artifact(input.bios)
  const kernel = artifact(input.kernel)
  const initrd = artifact(input.initrd)
  return Object.freeze({ root, bios, kernel, initrd })
}

/**
 * Prepares the shared Provider for Host Control. The caller must bind it into the
 * existing Runtime creation's providerBindings and then bindKernel(kernel.invokeFromSource).
 * This module does not change the current native process-policy default denial.
 */
export const createPrivateNativeV86ProcessProviderV1 = ({
  installation,
  nativeV86,
  policy,
  processProfile,
  generation,
  pumpOptions,
  processNetworkNative,
  now
}) => {
  if (!Number.isSafeInteger(generation) || generation < 1 || typeof nativeV86 !== 'function') return invalid()
  const privateInstallation = normalizePrivateNativeV86InstallationV1(installation)
  const command = new NativeV86CommandPortV1(nativeV86)
  const backend = createNativeV86ProcessBackendV1(
    command,
    pumpOptions,
    processProfile.environment?.capabilityBridge?.domains ?? []
  )
  const registry = new NativeProcessBackendRegistryV1([backend])
  const profile = normalizeNativeV86ProfileV1(processProfile, registry)
  if (profile.backend.backendId !== backend.descriptor.backendId || policy?.access !== 'sandboxed') {
    return invalid()
  }
  const pins = profile.backend.configuration.artifacts
  if (
    pins.bios.sha256 !== privateInstallation.bios.sha256 ||
    pins.kernel.sha256 !== privateInstallation.kernel.sha256 ||
    pins.initrd.sha256 !== privateInstallation.initrd.sha256
  ) return invalid()
  // Rust verifies and pins all three artifacts before any VM or Guest entry.
  const receipt = command.install({ ...privateInstallation, wasmSha256: pins.wasm.sha256 })
  if (receipt?.installed !== true || receipt.wasmSha256 !== pins.wasm.sha256) return invalid()
  if (policy.network.access === 'restricted') {
    backend.attachNetwork(new NativeV86ProcessNetworkPortV1(processNetworkNative, generation, policy, now))
  }
  const provider = new ProcessProviderV1(
    profile,
    policy,
    generation,
    new NativeV86ProcessHostPortV1(backend),
    Object.freeze({
      CapabilityInvocationError,
      canonicalizeProcessInstanceResource,
      trustedInvocationValueFromJsonV1
    })
  )
  return Object.freeze({
    descriptor: backend.descriptor,
    profile,
    provider,
    registry,
    bindKernel: kernel => {
      if (kernel == null || typeof kernel.invokeFromSource !== 'function') return invalid()
      if (typeof kernel.releaseResource !== 'function') return invalid()
      backend.bindKernel(
        (input, signal) => kernel.invokeFromSource(input, signal),
        bindingId => kernel.releaseResource(bindingId)
      )
    },
    close: () => provider.close()
  })
}
