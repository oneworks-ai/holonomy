import { parse } from 'acorn'

import { NODE_PROCESS_BACKEND_REGISTRY_V1 } from '../../adapters/node/src/capability-process-backend.mjs'
import {
  DEFAULT_SANDBOX_POLICY_V2,
  compileRuntimeContextEnvelopeV1,
  compileSandboxPolicyV2,
  runtimeContextDigestV1
} from '../../dist/capability-runtime/index.js'
import { serviceError } from './errors.mjs'
import { cloneJson, requireIdentifier, requireRecord } from './validation.mjs'

const DEFAULT_MIDDLEWARE_REGISTRY = Object.freeze({
  'service.continue.v1': Object.freeze({ behavior: 'allow' })
})
const NETWORK_LIMIT_KEYS = Object.freeze([
  'maxChunkBytes',
  'maxConcurrentConnections',
  'maxHeaderBytes',
  'maxHeaders',
  'maxRequestBodyBytes',
  'maxResponseBodyBytes',
  'maxUrlBytes',
  'socketTimeoutMs'
])

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

const assertNoDynamicImport = modules => {
  for (const module of modules) {
    let program
    try {
      program = parse(module.source, { ecmaVersion: 'latest', sourceType: 'module' })
    } catch {
      return invalid('Capability Runtime module source is invalid')
    }
    const stack = [program]
    while (stack.length > 0) {
      const node = stack.pop()
      if (node == null || typeof node !== 'object') continue
      if (node.type === 'ImportExpression') {
        return unsupported('Dynamic import is unavailable in the M2.5 kernel slice')
      }
      for (const child of Object.values(node)) {
        if (Array.isArray(child)) stack.push(...child)
        else if (child != null && typeof child === 'object') stack.push(child)
      }
    }
  }
}

const assertKernelCapabilities = (policy, processProfileId, target, profiles, backends) => {
  if (Object.values(policy.codeGeneration).some(value => value.access !== 'none')) {
    unsupported('Controlled code generation is unavailable in the M2.5 kernel slice')
  }
  if (Object.values(policy.inspector).some(Boolean)) {
    unsupported('Inspector code execution is unavailable in the M2.5 kernel slice')
  }
  if (policy.filesystem.access !== 'none') {
    const root = policy.filesystem.roots[0]
    if (
      policy.filesystem.roots.length !== 1 || root?.rootId !== 'workspace' ||
      root.virtualUrl !== 'holo-fs://workspace/' || !['deny', 'withinRoot'].includes(root.symlinks)
    ) unsupported('The M3 filesystem Provider requires one bounded workspace root')
  }
  if (JSON.stringify(policy.diagnostics) !== JSON.stringify(DEFAULT_SANDBOX_POLICY_V2.diagnostics)) {
    unsupported('Runtime observers and source readers are unavailable in the M2.5 kernel slice')
  }
  if (policy.process.access === 'none') {
    if (processProfileId != null) invalid('Process profile requires process authority')
    return
  }
  if (processProfileId == null || !profiles.has(processProfileId)) {
    unsupported('The requested Process profile is unavailable')
  }
  const profile = profiles.get(processProfileId)
  const descriptor = backends.get(profile.backend.backendId)?.descriptor
  if (descriptor == null || !descriptor.platforms.includes(target)) {
    unsupported('The selected target does not publish the requested Process Backend')
  }
  const declared = [...policy.process.executables.map(item => item.executableId)].sort()
  const available = [...profile.executables.map(item => item.executableId)].sort()
  if (JSON.stringify(declared) !== JSON.stringify(available)) {
    invalid('Process Policy and Host profile executables must match exactly')
  }
  const shellId = policy.process.shell.access === 'restricted' ? policy.process.shell.executableId : undefined
  if (shellId !== profile.defaultShellExecutableId) {
    invalid('Process Policy and Host profile shell must match exactly')
  }
}

const assertNetworkIntersection = (policy, legacy) => {
  const current = policy.network
  if (legacy.access !== current.access) invalid('Capability and transport network modes must match')
  if (current.access === 'none') return
  if (
    current.allowedOrigins.length !== legacy.allowedOrigins.length ||
    current.allowedOrigins.some((origin, index) => origin !== legacy.allowedOrigins[index])
  ) {
    invalid('Capability and transport network origins must match exactly')
  }
  if (
    current.allowedSchemes.length !== legacy.allowedSchemes.length ||
    current.allowedSchemes.some((scheme, index) => scheme !== legacy.allowedSchemes[index])
  ) {
    invalid('Capability and transport network schemes must match exactly')
  }
  if (current.allowPrivateNetwork !== legacy.allowPrivateNetwork) {
    invalid('Capability and transport private-network authority must match exactly')
  }
  for (const key of NETWORK_LIMIT_KEYS) {
    if (current.limits[key] !== legacy.limits[key]) {
      invalid('Capability and transport network limits must match exactly')
    }
  }
  if (current.limits.maxRedirects !== 10 || current.requestBodyInspection.access !== 'none') {
    unsupported('Redirect expansion and request-body inspection are unavailable in M2.5')
  }
}

export const admitCapabilityRuntimeRequestV1 = (
  value,
  expected,
  middleware,
  profiles = new Map(),
  backends = NODE_PROCESS_BACKEND_REGISTRY_V1
) => {
  if (value == null) return undefined
  const input = requireRecord(value, 'Capability Runtime request')
  if (
    Object.keys(input).some(key =>
      !['context', 'initialMiddlewareId', 'processProfileId', 'sandboxPolicy', 'schemaVersion'].includes(key)
    )
  ) invalid('Capability Runtime request contains an unknown field')
  if (input.schemaVersion !== 1) invalid('Capability Runtime request version is invalid')
  if (expected.inspectorMode !== 'off') {
    unsupported('Capability Runtime Inspector integration is unavailable in M2.5')
  }
  if (expected.fixture != null) unsupported('Capability Runtime conformance fixtures are unavailable in M2.5')
  const initialMiddlewareId = requireIdentifier(input.initialMiddlewareId, 'Initial middleware id')
  if (!middleware.has(initialMiddlewareId)) invalid('Initial middleware registration is unavailable')
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
  assertKernelCapabilities(compiled.policy, processProfileId, expected.target, profiles, backends)
  assertNetworkIntersection(compiled.policy, expected.sandboxPolicy.network)
  assertNoDynamicImport(expected.launch.modules)
  return Object.freeze({
    context,
    contextDigest: runtimeContextDigestV1(context),
    initialMiddlewareId,
    policyDigest: compiled.digest,
    ...(processProfileId == null ? {} : { processProfileId }),
    sandboxPolicy: compiled.policy,
    schemaVersion: 1
  })
}
