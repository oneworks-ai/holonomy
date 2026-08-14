import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import path from 'node:path'

import {
  canonicalDigest,
  compileRuntimeCreationConfigurationV1,
  compileRuntimeCreationHostBindingsV1
} from '../../../dist/capability-runtime/index.js'

import { normalizeNodeProcessProfileV1 } from './capability-process-profile.mjs'
import {
  createNodeProcessBackendRegistryForInstallationV1,
  normalizeNodeProcessBackendInstallationV1
} from './capability-process-v86-installation.mjs'
import { copyJsonValue, freezeJsonValue } from './json-value.mjs'

export { normalizeNodeProcessProfileV1 } from './capability-process-profile.mjs'

const PROVIDER_MODULES = new Set([
  'host.device',
  'host.fs',
  'host.network',
  'host.network.mock',
  'host.process',
  'host.system'
])
const BEHAVIORS = new Set(['allow', 'deny', 'throw', 'timeout'])

const invalid = () => {
  throw new TypeError('Invalid Node capability Runtime session')
}

const exact = (value, keys) => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return invalid()
  if (Object.keys(value).some(key => !keys.includes(key))) return invalid()
  return value
}

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][\w.-]{0,127}$/u.test(value) ? value : invalid()

const graphDigest = modules =>
  canonicalDigest([
    'nodeModuleGraphV1',
    [...modules]
      .sort((left, right) => left.url < right.url ? -1 : left.url > right.url ? 1 : 0)
      .map(module => [
        module.url,
        createHash('sha256').update(module.source, 'utf8').digest('hex')
      ])
  ])

export const createNodeModuleLaunchV1 = ({ moduleRootUrl, userEntryUrl, userModules }) =>
  Object.freeze({
    entryUrl: userEntryUrl,
    moduleCount: userModules.length,
    moduleGraphDigest: graphDigest(userModules),
    moduleRootUrl,
    totalSourceBytes: userModules.reduce((total, module) => total + Buffer.byteLength(module.source), 0)
  })

const normalizeRoots = value => {
  if (value == null) return Object.freeze([])
  if (!Array.isArray(value) || value.length > 64) return invalid()
  const roots = value.map(item => {
    const root = exact(item, ['hostPath', 'rootId'])
    const hostPath = root.hostPath
    if (
      typeof hostPath !== 'string' || hostPath.length === 0 || hostPath.length > 4096 ||
      hostPath.includes('\0') || !path.isAbsolute(hostPath) || path.normalize(hostPath) !== hostPath
    ) return invalid()
    return Object.freeze({ hostPath, rootId: identifier(root.rootId) })
  })
  if (new Set(roots.map(root => root.rootId)).size !== roots.length) return invalid()
  roots.sort((left, right) => left.rootId < right.rootId ? -1 : 1)
  return Object.freeze(roots)
}

const normalizeMiddleware = value => {
  if (value == null) return Object.freeze({ behavior: 'allow' })
  const input = exact(value, ['behavior', 'matcher', 'timeoutMs'])
  if (!BEHAVIORS.has(input.behavior)) return invalid()
  if (
    input.timeoutMs != null &&
    (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 120_000)
  ) return invalid()
  const matcher = input.matcher == null
    ? undefined
    : freezeJsonValue(copyJsonValue(input.matcher, 'middleware matcher'))
  return Object.freeze({
    behavior: input.behavior,
    ...(matcher == null ? {} : { matcher }),
    ...(input.timeoutMs == null ? {} : { timeoutMs: input.timeoutMs })
  })
}

const normalizeProviderConfiguration = value => {
  const input = exact(value ?? {}, [
    'deviceReadings',
    'deviceSummary',
    'filesystemRoots',
    'networkProvider',
    'processBackendInstallation',
    'processProfile'
  ])
  const networkProvider = input.networkProvider ?? 'host.network'
  if (!['host.network', 'host.network.mock'].includes(networkProvider)) return invalid()
  const processBackendInstallation = input.processBackendInstallation == null
    ? undefined
    : normalizeNodeProcessBackendInstallationV1(input.processBackendInstallation)
  const processBackendRegistry = processBackendInstallation == null
    ? undefined
    : createNodeProcessBackendRegistryForInstallationV1(processBackendInstallation)
  const processProfile = input.processProfile == null
    ? undefined
    : normalizeNodeProcessProfileV1(input.processProfile, processBackendRegistry)
  if (
    processBackendInstallation != null &&
    processProfile?.backend.backendId !== processBackendInstallation.backendId
  ) return invalid()
  return freezeJsonValue({
    deviceReadings: copyJsonValue(input.deviceReadings ?? {}, 'device readings'),
    ...(input.deviceSummary == null
      ? {}
      : { deviceSummary: copyJsonValue(input.deviceSummary, 'device summary') }),
    filesystemRoots: normalizeRoots(input.filesystemRoots),
    networkProvider,
    ...(processBackendInstallation == null ? {} : { processBackendInstallation }),
    ...(processProfile == null ? {} : { processProfile })
  })
}

const assertNodeCapabilityProcessIntersection = session => {
  const policy = session.runtimeCreation.configuration.sandboxPolicy.process
  const profile = session.providerConfiguration.processProfile
  if (policy.access === 'none') {
    if (profile != null) return invalid()
    return
  }
  if (profile == null) return invalid()
  const declared = [...policy.executables.map(item => item.executableId)].sort()
  const available = [...profile.executables.map(item => item.executableId)].sort()
  if (JSON.stringify(declared) !== JSON.stringify(available)) return invalid()
  const shellId = policy.shell.access === 'restricted' ? policy.shell.executableId : undefined
  if (shellId !== profile.defaultShellExecutableId) return invalid()
}

export const normalizeNodeCapabilityRuntimeSession = (value, launch, inspectorEnabled) => {
  if (value == null) return undefined
  const copied = copyJsonValue(value, 'Node capability Runtime session')
  const input = exact(copied, [
    'initialMiddleware',
    'ownerId',
    'processId',
    'providerConfiguration',
    'runtimeCreation'
  ])
  const creation = exact(input.runtimeCreation, ['configuration', 'hostBindings'])
  const configuration = compileRuntimeCreationConfigurationV1(creation.configuration)
  const hostBindings = compileRuntimeCreationHostBindingsV1(creation.hostBindings)
  if (canonicalDigest(configuration.launch) !== canonicalDigest(launch)) return invalid()
  if (configuration.inspector.enabled !== inspectorEnabled) return invalid()
  if (hostBindings.providerBindings.some(binding => !PROVIDER_MODULES.has(binding.module))) return invalid()
  const normalized = Object.freeze({
    initialMiddleware: normalizeMiddleware(input.initialMiddleware),
    ownerId: identifier(input.ownerId),
    processId: identifier(input.processId),
    providerConfiguration: normalizeProviderConfiguration(input.providerConfiguration),
    runtimeCreation: Object.freeze({ configuration, hostBindings })
  })
  if (inspectorEnabled && normalized.providerConfiguration.processProfile != null) return invalid()
  assertNodeCapabilityProcessIntersection(normalized)
  return normalized
}
