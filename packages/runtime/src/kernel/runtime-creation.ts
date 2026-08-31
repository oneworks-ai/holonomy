import { compileDeviceProviderDescriptorV1 } from '@holonomyjs/capability-device/kernel/device-provider'
import { compileHostSystemProjectionV1 } from '@holonomyjs/capability-system/kernel/system-projection'
import { canonicalDigest } from './canonical-json.js'
import { compileSandboxPolicyV2 } from './compile-policy.js'
import { compileRuntimeContextEnvelopeV1 } from './context-snapshot.js'
import type {
  AdmittedRuntimeCreationV1,
  HostBindingReferenceV1,
  RuntimeCreationAdmissionContextV1,
  RuntimeCreationConfigurationV1,
  RuntimeCreationHostBindingsV1,
  RuntimeCreationSpecV1,
  RuntimeHostBindingKindV1
} from './context-types.js'
import { bindingUnavailable, invalidPolicy } from './errors.js'
import { compileRuntimeCreationHostBindingsV1 } from './runtime-creation-bindings.js'
import { deepFreeze, exact, identifier, integer, required, string } from './validation.js'

const digest = (value: unknown): string => {
  const result = string(value, 64)
  if (!/^[0-9a-f]{64}$/u.test(result)) return invalidPolicy()
  return result
}

const graphUrl = (value: unknown): URL => {
  const input = string(value, 4096)
  if (
    !/^[A-Za-z][A-Za-z\d+.-]*:\/\//u.test(input) || /[\\\0]/u.test(input) ||
    /%(?![\da-f]{2})/iu.test(input)
  ) {
    return invalidPolicy()
  }
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return invalidPolicy()
  }
  if (
    parsed.href !== input || parsed.username !== '' || parsed.password !== '' ||
    parsed.search !== '' || parsed.hash !== '' || ['holo:', 'node:'].includes(parsed.protocol) ||
    /%(?:00|2e|2f|5c)/iu.test(parsed.pathname)
  ) return invalidPolicy()
  return parsed
}

const normalizeLaunch = (value: unknown) => {
  const input = exact(value, [
    'entryUrl',
    'moduleCount',
    'moduleGraphDigest',
    'moduleRootUrl',
    'totalSourceBytes'
  ])
  const root = graphUrl(required(input, 'moduleRootUrl'))
  const entry = graphUrl(required(input, 'entryUrl'))
  if (
    !root.pathname.endsWith('/') || root.protocol !== entry.protocol ||
    root.host !== entry.host || !entry.pathname.startsWith(root.pathname)
  ) return invalidPolicy()
  return Object.freeze({
    entryUrl: entry.href,
    moduleCount: integer(required(input, 'moduleCount'), 1, 100_000),
    moduleGraphDigest: digest(required(input, 'moduleGraphDigest')),
    moduleRootUrl: root.href,
    totalSourceBytes: integer(required(input, 'totalSourceBytes'), 0, Number.MAX_SAFE_INTEGER)
  })
}

export const compileRuntimeCreationConfigurationV1 = (
  value: unknown
): RuntimeCreationConfigurationV1 => {
  const input = exact(value, [
    'context',
    'deviceProviderDescriptor',
    'inspector',
    'launch',
    'sandboxPolicy',
    'schemaVersion',
    'systemProjection'
  ])
  if (required(input, 'schemaVersion') !== 1) return invalidPolicy()
  const inspector = exact(required(input, 'inspector'), ['enabled'])
  if (typeof required(inspector, 'enabled') !== 'boolean') return invalidPolicy()
  return deepFreeze({
    context: compileRuntimeContextEnvelopeV1(required(input, 'context')),
    ...(Object.hasOwn(input, 'deviceProviderDescriptor')
      ? { deviceProviderDescriptor: compileDeviceProviderDescriptorV1(input.deviceProviderDescriptor) }
      : {}),
    inspector: { enabled: inspector.enabled as boolean },
    launch: normalizeLaunch(required(input, 'launch')),
    sandboxPolicy: compileSandboxPolicyV2(required(input, 'sandboxPolicy')).policy,
    schemaVersion: 1 as const,
    systemProjection: compileHostSystemProjectionV1(required(input, 'systemProjection'))
  })
}

export const admitRuntimeCreationV1 = (
  value: unknown,
  context: RuntimeCreationAdmissionContextV1
): AdmittedRuntimeCreationV1 => {
  const input = exact(value, ['configuration', 'hostBindings'])
  const configuration = compileRuntimeCreationConfigurationV1(required(input, 'configuration'))
  const hostBindings = compileRuntimeCreationHostBindingsV1(required(input, 'hostBindings'))
  const expectedOwnerId = identifier(context.expectedOwnerId)
  const generation = integer(context.generation, 1, Number.MAX_SAFE_INTEGER)
  const processId = identifier(context.processId)
  const resolved: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  const resolve = (item: HostBindingReferenceV1, kind: RuntimeHostBindingKindV1) => {
    if (item.ownerId !== expectedOwnerId) return bindingUnavailable()
    const binding = context.resolveBinding(item, kind)
    if (binding === undefined || binding === null) return bindingUnavailable()
    resolved[item.bindingId] = binding
  }
  resolve(hostBindings.engineGate, 'engineGate')
  resolve(hostBindings.initialMiddlewareSet, 'initialMiddlewareSet')
  resolve(hostBindings.moduleResolver, 'moduleResolver')
  for (const item of hostBindings.initialObservers) resolve(item, 'observer')
  for (const item of hostBindings.providerBindings) {
    if (item.ownerId !== expectedOwnerId) return bindingUnavailable()
    const ref = Object.freeze({
      bindingId: item.providerId,
      ownerId: item.ownerId,
      version: item.providerVersion
    })
    resolve(ref, 'provider')
  }
  const configurationDigest = canonicalDigest(configuration as never)
  const hostBindingsDigest = canonicalDigest(hostBindings as never)
  const principal = `holo:${processId}:${generation}`
  return Object.freeze({
    admissionDigest: canonicalDigest([
      'runtimeAdmission',
      configurationDigest,
      hostBindingsDigest,
      processId,
      generation
    ]),
    configuration,
    configurationDigest,
    generation,
    hostBindings,
    hostBindingsDigest,
    principal,
    processId,
    resolvedHostBindings: Object.freeze({ ...resolved })
  })
}

export const runtimeCreationSpecV1 = (
  configuration: RuntimeCreationConfigurationV1,
  hostBindings: RuntimeCreationHostBindingsV1
): RuntimeCreationSpecV1 => Object.freeze({ configuration, hostBindings })
