import { NODE_PROCESS_BACKEND_REGISTRY_V1 } from '../../adapters/node/src/capability-process-backend.mjs'
import {
  compileRuntimeContextEnvelopeV1,
  compileSandboxPolicyV2,
  runtimeContextDigestV1
} from '../../dist/capability-runtime/index.js'
import {
  assertCapabilityDynamicImportPolicyV1,
  assertCapabilityKernelV1,
  assertCapabilityNetworkIntersectionV1
} from './capability-runtime-admission-support.mjs'
import {
  DEFAULT_RUNTIME_OBSERVER_HOST_CAPS,
  selectNativeRuntimeObserverProfilesV1
} from './capability-runtime-observers.mjs'
import { serviceError } from './errors.mjs'
import { cloneJson, requireIdentifier, requireRecord } from './validation.mjs'

const DEFAULT_MIDDLEWARE_REGISTRY = Object.freeze({
  'service.continue.v1': Object.freeze({ behavior: 'allow' })
})

const invalid = message => {
  throw serviceError('service.invalid_request', message)
}

const unsupported = message => {
  throw serviceError('sandbox.capability_unsupported', message)
}

export const normalizeCapabilityMiddlewareRegistryV1 = value => {
  const input = value ?? DEFAULT_MIDDLEWARE_REGISTRY
  const entries = input instanceof Map
    ? [...input.entries()]
    : Object.entries(requireRecord(input, 'Middleware registry'))
  const output = new Map()
  for (const [id, descriptorValue] of entries) {
    const identifier = requireIdentifier(id, 'Middleware registration id')
    const descriptor = cloneJson(requireRecord(descriptorValue, 'Middleware descriptor'))
    if (!['allow', 'deny', 'throw', 'timeout'].includes(descriptor.behavior)) {
      throw new TypeError('Capability middleware behavior is invalid')
    }
    if (Object.keys(descriptor).some(key => !['behavior', 'matcher', 'timeoutMs'].includes(key))) {
      throw new TypeError('Capability middleware descriptor contains an unknown field')
    }
    if (
      descriptor.timeoutMs != null &&
      (!Number.isSafeInteger(descriptor.timeoutMs) || descriptor.timeoutMs < 1 || descriptor.timeoutMs > 120_000)
    ) throw new TypeError('Capability middleware timeout is invalid')
    output.set(identifier, Object.freeze(descriptor))
  }
  return output
}

export const admitCapabilityRuntimeRequestV1 = (
  value,
  expected,
  middleware,
  profiles = new Map(),
  backends = NODE_PROCESS_BACKEND_REGISTRY_V1,
  engineGateAvailable = false,
  observerRegistry = new Map(),
  observerHostCaps = DEFAULT_RUNTIME_OBSERVER_HOST_CAPS,
  sourceReaderHostCaps = Object.freeze({ maxReadBytes: 0 }),
  nativeDiagnosticSourceReader,
  nativeObserverProfiles = new Map()
) => {
  if (value == null) return undefined
  const input = requireRecord(value, 'Capability Runtime request')
  if (
    Object.keys(input).some(key =>
      ![
        'context',
        'initialMiddlewareId',
        'initialObserverIds',
        'processProfileId',
        'sandboxPolicy',
        'schemaVersion'
      ].includes(key)
    )
  ) invalid('Capability Runtime request contains an unknown field')
  if (input.schemaVersion !== 1) invalid('Capability Runtime request version is invalid')
  if (
    expected.inspectorMode !== 'off' &&
    !(expected.target === 'native' || expected.target === 'node' && engineGateAvailable)
  ) {
    unsupported('Capability Runtime Inspector integration is unavailable on the selected target')
  }
  if (expected.fixture != null) unsupported('Capability Runtime conformance fixtures are unavailable in M2.5')
  const initialMiddlewareId = requireIdentifier(input.initialMiddlewareId, 'Initial middleware id')
  if (!middleware.has(initialMiddlewareId)) invalid('Initial middleware registration is unavailable')
  if (
    input.initialObserverIds != null &&
    (!Array.isArray(input.initialObserverIds) || input.initialObserverIds.length > 64)
  ) invalid('Initial Runtime Observer ids are invalid')
  const initialObserverIds = (input.initialObserverIds ?? [])
    .map(value => requireIdentifier(value, 'Initial Runtime Observer id'))
    .sort()
  if (expected.target === 'native' && initialObserverIds.length > 4) {
    invalid('Initial Native Runtime Observer ids exceed the limit')
  }
  if (new Set(initialObserverIds).size !== initialObserverIds.length) {
    invalid('Initial Runtime Observer ids contain duplicates')
  }
  let context
  let compiled
  try {
    context = compileRuntimeContextEnvelopeV1(input.context)
    compiled = compileSandboxPolicyV2(input.sandboxPolicy)
  } catch {
    return invalid('Capability Runtime configuration is invalid')
  }
  const processProfileId = input.processProfileId == null
    ? undefined
    : requireIdentifier(input.processProfileId, 'Process profile id')
  assertCapabilityKernelV1(
    compiled.policy,
    processProfileId,
    expected.target,
    profiles,
    backends,
    engineGateAvailable,
    initialObserverIds,
    observerRegistry,
    observerHostCaps,
    sourceReaderHostCaps,
    nativeDiagnosticSourceReader,
    nativeObserverProfiles
  )
  assertCapabilityNetworkIntersectionV1(compiled.policy, expected.sandboxPolicy.network)
  assertCapabilityDynamicImportPolicyV1(
    expected.launch.modules,
    compiled.policy.codeGeneration.dynamicImport.access === 'controlled'
  )
  const nativeObserverBindingVersions = expected.target === 'native' && initialObserverIds.length > 0
    ? Object.freeze(Object.fromEntries(
      selectNativeRuntimeObserverProfilesV1(
        initialObserverIds,
        nativeObserverProfiles,
        compiled.policy.diagnostics
      ).map(profile => [profile.id, profile.version])
    ))
    : undefined
  return Object.freeze({
    context,
    contextDigest: runtimeContextDigestV1(context),
    initialMiddlewareId,
    initialObserverIds,
    ...(nativeObserverBindingVersions == null ? {} : { nativeObserverBindingVersions }),
    policyDigest: compiled.digest,
    ...(processProfileId == null ? {} : { processProfileId }),
    sandboxPolicy: compiled.policy,
    schemaVersion: 1
  })
}
