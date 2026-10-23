import { ProcessProviderV1 } from '../../../../packages/capabilities/process/src/host/provider.mjs'
import {
  CapabilityInvocationError,
  canonicalizeProcessInstanceResource,
  trustedInvocationValueFromJsonV1
} from '../../../../packages/runtime/src/kernel/index.ts'

import {
  createNativeDarwinProcessBackendV1,
  createNativeDarwinProcessRegistryV1,
  normalizeNativeDarwinProfileV1
} from './process-darwin-backend.mjs'
import { NativeDarwinProcessCommandV1 } from './process-darwin-command.mjs'
import { NativeDarwinProcessHostPortV1 } from './process-darwin-host-port.mjs'

const invalid = () => {
  throw new TypeError('Invalid private native Darwin Process installation')
}

/** Only a Host-selected profile and compiled sandboxed Policy can install this Provider. */
export const createPrivateNativeDarwinProcessProviderV1 = ({
  generation,
  installation,
  nativeDarwinProcess,
  policy,
  processProfile
}) => {
  if (
    !Number.isSafeInteger(generation) || generation < 1 ||
    typeof nativeDarwinProcess !== 'function' ||
    installation != null && (
        installation.backendId !== 'native.darwin-seatbelt-v1' ||
        installation.implementation !== 'builtin.darwin-seatbelt-v1'
      ) ||
    policy?.access !== 'sandboxed' ||
    policy.mounts?.length !== 0 || policy.network?.access !== 'none' ||
    policy.limits?.maxWritableRootfsBytes !== 0
  ) return invalid()
  const command = new NativeDarwinProcessCommandV1(nativeDarwinProcess)
  const backend = createNativeDarwinProcessBackendV1(command, generation)
  const registry = createNativeDarwinProcessRegistryV1(backend)
  const profile = normalizeNativeDarwinProfileV1(processProfile, registry)
  if (profile.backend.backendId !== 'native.darwin-seatbelt-v1') return invalid()
  // The native install checks OS paths, executable identity, static Seatbelt
  // constraints and generation before any process I/O can begin.
  command.install(generation, profile, policy)
  const provider = new ProcessProviderV1(
    profile,
    policy,
    generation,
    new NativeDarwinProcessHostPortV1(backend),
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
    },
    close: () => provider.close()
  })
}
