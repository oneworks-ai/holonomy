import { DEVICE_PRECISION_V1, SYSTEM_PRECISION_V1, normalizeCapabilityConstraintsV1 } from './capability-constraints.js'
import type { NormalizedCapabilityConstraintsV1 } from './capability-constraints.js'
import type { JsonValueV1 } from './json-types.js'
import type { BuiltInCapabilityNameV1 } from './operation-types.js'

const setAtLeast = (available: unknown, required: unknown) =>
  (
    required as readonly string[]
  ).every(value => (available as readonly string[]).includes(value))

const numbersAtLeast = (
  available: NormalizedCapabilityConstraintsV1,
  required: NormalizedCapabilityConstraintsV1
) => Object.keys(required).every(key => (available[key] as number) >= (required[key] as number))

const prefixContains = (available: readonly string[], required: readonly string[]) =>
  available.length <= required.length && available.every((segment, index) => segment === required[index])

const satisfiesFs = (
  available: NormalizedCapabilityConstraintsV1,
  required: NormalizedCapabilityConstraintsV1
) =>
  (required.roots as readonly Record<string, JsonValueV1>[]).every(requiredRoot =>
    (available.roots as readonly Record<string, JsonValueV1>[]).some(availableRoot =>
      availableRoot.rootId === requiredRoot.rootId &&
      prefixContains(
        availableRoot.pathPrefixSegments as readonly string[],
        requiredRoot.pathPrefixSegments as readonly string[]
      ) && setAtLeast(availableRoot.rights, requiredRoot.rights) &&
      (availableRoot.symlinks === 'withinRoot' || requiredRoot.symlinks === 'deny')
    )
  ) && numbersAtLeast(
    available.limits as NormalizedCapabilityConstraintsV1,
    required.limits as NormalizedCapabilityConstraintsV1
  )

const satisfiesNetwork = (
  available: NormalizedCapabilityConstraintsV1,
  required: NormalizedCapabilityConstraintsV1
) =>
  available.mode === required.mode &&
  setAtLeast(available.origins, required.origins) && setAtLeast(available.schemes, required.schemes) &&
  ((available.allowPrivateNetwork as boolean) || !required.allowPrivateNetwork) &&
  (available.inspectRequestBodyBytes as number) >= (required.inspectRequestBodyBytes as number) &&
  numbersAtLeast(
    available.limits as NormalizedCapabilityConstraintsV1,
    required.limits as NormalizedCapabilityConstraintsV1
  )

const endpointMap = (value: unknown) =>
  new Map(
    (value as readonly Readonly<Record<string, JsonValueV1>>[]).map(endpoint => [
      `${endpoint.transport}\0${endpoint.hostname}`,
      endpoint.ports as readonly string[]
    ])
  )

const satisfiesProcessNetwork = (
  available: NormalizedCapabilityConstraintsV1,
  required: NormalizedCapabilityConstraintsV1
) => {
  const availableEndpoints = endpointMap(available.endpoints)
  return (required.endpoints as readonly Readonly<Record<string, JsonValueV1>>[]).every(endpoint => {
    const ports = availableEndpoints.get(`${endpoint.transport}\0${endpoint.hostname}`)
    return ports != null && (endpoint.ports as readonly number[]).every(port => (ports as unknown[]).includes(port))
  }) && (available.maxSockets as number) >= (required.maxSockets as number)
}

export const capabilitySatisfiesV1 = (
  name: BuiltInCapabilityNameV1,
  availableValue: unknown,
  requiredValue: unknown
): boolean => {
  const available = normalizeCapabilityConstraintsV1(name, availableValue)
  const required = normalizeCapabilityConstraintsV1(name, requiredValue)
  if (name === 'host.fs') return satisfiesFs(available, required)
  if (name === 'host.network.http' || name === 'host.network.mock') {
    return satisfiesNetwork(available, required)
  }
  if (name === 'host.process.network') return satisfiesProcessNetwork(available, required)
  if (name.startsWith('host.device.')) {
    return setAtLeast(available.operations, required.operations) &&
      (available.maxPrivacyTier as number) >= (required.maxPrivacyTier as number) &&
      (available.maxQueuedEvents as number) >= (required.maxQueuedEvents as number) &&
      DEVICE_PRECISION_V1.indexOf(available.maxPrecision as never) >=
        DEVICE_PRECISION_V1.indexOf(required.maxPrecision as never)
  }
  if (name.startsWith('host.system.')) {
    return setAtLeast(available.fields, required.fields) &&
      setAtLeast(available.modes, required.modes) &&
      SYSTEM_PRECISION_V1.indexOf(available.maxPrecision as never) >=
        SYSTEM_PRECISION_V1.indexOf(required.maxPrecision as never)
  }
  if (name === 'host.storage.credential') {
    return setAtLeast(available.stores, required.stores) &&
      setAtLeast(available.usages, required.usages)
  }
  if (name === 'host.process.execute') {
    return setAtLeast(available.executableIds, required.executableIds) &&
      setAtLeast(available.rootIds, required.rootIds) &&
      numbersAtLeast(
        available.limits as NormalizedCapabilityConstraintsV1,
        required.limits as NormalizedCapabilityConstraintsV1
      )
  }
  if (name === 'host.process.shell') return setAtLeast(available.executableIds, required.executableIds)
  if (name === 'host.process.signal') return setAtLeast(available.signals, required.signals)
  if (name.startsWith('host.process.')) {
    return setAtLeast(available.executableIds, required.executableIds) &&
      setAtLeast(available.signals, required.signals) &&
      (available.maxProcesses as number) >= (required.maxProcesses as number)
  }
  return (available.maxReadBytes as number) >= (required.maxReadBytes as number) &&
    (available.maxReads as number) >= (required.maxReads as number)
}
