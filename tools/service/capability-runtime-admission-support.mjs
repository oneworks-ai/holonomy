import { parse } from 'acorn'

import { NODE_PROCESS_BACKEND_REGISTRY_V1 } from '../../adapters/node/src/capability-process-backend.mjs'
import { NODE_RUNTIME_OBSERVER_PLATFORM_V1, compileSandboxPolicyV2 } from '../../dist/capability-runtime/index.js'
import {
  DEFAULT_RUNTIME_OBSERVER_HOST_CAPS,
  selectNativeRuntimeObserverProfilesV1,
  validateCapabilityObserverBindingsV1
} from './capability-runtime-observers.mjs'
import { serviceError } from './errors.mjs'
import { selectNativeDiagnosticSourceReaderForPolicy } from './native-diagnostic-source-reader-installation.mjs'

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

export const assertNativeCapabilityPolicyDigestV1 = request => {
  let digest
  try {
    digest = compileSandboxPolicyV2(request.sandboxPolicy).digest
  } catch {
    // A persisted Native request must still have a valid, matching Policy.
  }
  if (typeof digest !== 'string' || digest !== request.policyDigest) {
    throw serviceError('service.precondition_failed', 'Native Capability Runtime Policy has changed')
  }
}

export const assertCapabilityDynamicImportPolicyV1 = (modules, allowed) => {
  for (const module of modules) {
    let program
    try {
      // Package metadata and JSON modules are data, not JavaScript programs.
      // Classify by the module identity, never by the caller's restriction bit.
      if (typeof module.url === 'string' && new URL(module.url).pathname.toLowerCase().endsWith('.json')) {
        // The Loader's UTF-8 decoder consumes one BOM. Validate the same text
        // without changing the exact source bytes retained in the launch.
        JSON.parse(module.source.charCodeAt(0) === 0xFEFF ? module.source.slice(1) : module.source)
        continue
      }
      program = parse(module.source, { ecmaVersion: 'latest', sourceType: 'module' })
    } catch {
      return invalid('Capability Runtime module source is invalid')
    }
    const stack = [program]
    while (stack.length > 0) {
      const node = stack.pop()
      if (node == null || typeof node !== 'object') continue
      if (node.type === 'ImportExpression') {
        if (!allowed) return unsupported('Dynamic import requires the controlled M4 Loader Gate')
        break
      }
      for (const child of Object.values(node)) {
        if (Array.isArray(child)) stack.push(...child)
        else if (child != null && typeof child === 'object') stack.push(child)
      }
    }
  }
}

export const assertCapabilityKernelV1 = (
  policy,
  processProfileId,
  target,
  profiles,
  backends = NODE_PROCESS_BACKEND_REGISTRY_V1,
  engineGateAvailable = false,
  observerIds = [],
  observerRegistry = new Map(),
  observerHostCaps = DEFAULT_RUNTIME_OBSERVER_HOST_CAPS,
  sourceReaderHostCaps = Object.freeze({ maxReadBytes: 0 }),
  nativeDiagnosticSourceReader,
  nativeObserverProfiles = new Map()
) => {
  // Native resolves these decisions inside its trusted Host plugin graph. The
  // Service callback only establishes availability for the Node adapter.
  const hasEngineGate = target === 'native' || (target === 'node' && engineGateAvailable)
  if (policy.codeGeneration.dynamicImport.access !== 'none' && !hasEngineGate) {
    unsupported('The selected target does not provide the M4 dynamic-import Loader Gate')
  }
  if (policy.codeGeneration.wasm.access !== 'none' && !hasEngineGate) {
    unsupported('The selected target does not provide the M4 per-compilation Wasm Gate')
  }
  if (policy.codeGeneration.strings.access !== 'none' && !hasEngineGate) {
    unsupported('The selected target does not provide the M4 per-compilation strings Gate')
  }
  if (
    Object.values(policy.inspector).some(Boolean) &&
    (!hasEngineGate || policy.codeGeneration.strings.access !== 'controlled')
  ) {
    unsupported('Inspector code execution requires the selected target M4 Engine Gate')
  }
  if (policy.filesystem.access !== 'none') {
    const root = policy.filesystem.roots[0]
    if (
      policy.filesystem.roots.length !== 1 || root?.rootId !== 'workspace' ||
      root.virtualUrl !== 'holo-fs://workspace/' || !['deny', 'withinRoot'].includes(root.symlinks)
    ) unsupported('The M3 filesystem Provider requires one bounded workspace root')
  }
  if (policy.diagnostics.sourceReader === 'boundedSource') {
    if (target === 'native') {
      selectNativeDiagnosticSourceReaderForPolicy(policy, nativeDiagnosticSourceReader)
    } else if (
      target !== 'node' || !engineGateAvailable ||
      sourceReaderHostCaps?.capabilityName !== 'host.diagnostics.source.read' ||
      !Number.isSafeInteger(sourceReaderHostCaps.maxReadBytes) || sourceReaderHostCaps.maxReadBytes < 1
    ) unsupported('The selected target does not provide the M4 Engine source reader')
  }
  if (observerIds.length > 0 || policy.diagnostics.observerEvents.length > 0) {
    if (target === 'native') {
      try {
        selectNativeRuntimeObserverProfilesV1(observerIds, nativeObserverProfiles, policy.diagnostics)
      } catch {
        unsupported('Native Runtime Observer policy is unavailable')
      }
    } else {
      if (target !== 'node') unsupported('Runtime observers are unavailable on the selected target')
      try {
        validateCapabilityObserverBindingsV1(
          observerIds,
          observerRegistry,
          policy.diagnostics,
          NODE_RUNTIME_OBSERVER_PLATFORM_V1,
          observerHostCaps
        )
      } catch {
        invalid('Runtime Observer registration is invalid or unavailable')
      }
    }
  }
  if (policy.process.access === 'none') {
    if (processProfileId != null) invalid('Process profile requires process authority')
    return
  }
  if (processProfileId == null || !profiles.has(processProfileId)) {
    unsupported('The requested Process profile is unavailable')
  }
  const profile = profiles.get(processProfileId)
  // The Service target is named native; Process Backend descriptors name that
  // same Host platform desktop. Keep availability tied to the installed
  // descriptor, including the Darwin-only registration in the Host registry.
  const backendPlatform = target === 'native' ? 'desktop' : target
  const descriptor = backends.get(profile.backend.backendId)?.descriptor
  if (descriptor == null || !descriptor.platforms.includes(backendPlatform)) {
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

export const assertCapabilityNetworkIntersectionV1 = (policy, legacy) => {
  const current = policy.network
  if (legacy.access !== current.access) invalid('Capability and transport network modes must match')
  if (current.access === 'none') return
  if (
    current.allowedOrigins.length !== legacy.allowedOrigins.length ||
    current.allowedOrigins.some((origin, index) => origin !== legacy.allowedOrigins[index])
  ) invalid('Capability and transport network origins must match exactly')
  if (
    current.allowedSchemes.length !== legacy.allowedSchemes.length ||
    current.allowedSchemes.some((scheme, index) => scheme !== legacy.allowedSchemes[index])
  ) invalid('Capability and transport network schemes must match exactly')
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
