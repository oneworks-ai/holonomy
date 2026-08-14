import { Buffer } from 'node:buffer'

import { readNodeRuntimePluginsV1 } from './capability-runtime-plugins.mjs'
import { assertNodeCapabilityNetworkIntersection } from './capability-session-network.mjs'
import { createNodeModuleLaunchV1, normalizeNodeCapabilityRuntimeSession } from './capability-session.mjs'
import { copyJsonValue } from './json-value.mjs'
import { normalizeModuleGraphRoot } from './module-root-validation.mjs'
import { NetworkRuleContractError, normalizeNetworkRuleSet } from './network-rule-contract.mjs'
import { normalizeNodeSandboxSession } from './sandbox-session.mjs'
import { readArgv, readEnv } from './session-process-input.mjs'
import { readSyntheticModules } from './synthetic-module-validation.mjs'

const MAX_MODULES = 512
const MAX_MODULE_BYTES = 8 * 1024 * 1024
const MAX_MODULE_GRAPH_BYTES = 48 * 1024 * 1024
const MAX_URL_BYTES = 4 * 1024
const invalid = message => {
  throw new TypeError(message)
}
const requireExactKeys = (value, keys, label) => {
  if (Object.keys(value).some(key => !keys.includes(key))) invalid(`Invalid Node Runtime ${label}`)
}

const validateModuleUrl = (value, kind) => {
  if (Buffer.byteLength(value) > MAX_URL_BYTES) invalid('Node Runtime module URL exceeds the limit')
  let url
  try {
    url = new URL(value)
  } catch {
    invalid('Node Runtime module URL must be absolute')
  }
  if (url.href !== value || url.hash !== '') invalid('Node Runtime module URL must be canonical')
  const internal = url.protocol === 'holonomy:' && url.host === '' && url.pathname.startsWith('/runtime/')
  const plugin = url.protocol === 'holo-plugins:' && url.host === '' && url.pathname.startsWith('/')
  if (
    (kind === 'runtime' && !internal) || (kind === 'plugin' && !plugin) ||
    (kind === 'user' && (internal || plugin || url.protocol === 'node:'))
  ) {
    invalid(`Invalid Node Runtime ${kind} module URL`)
  }
}

const readModules = (items, kind, state) => {
  if (!Array.isArray(items)) invalid(`Node Runtime ${kind} modules must be an array`)
  const output = []
  for (const item of items) {
    if (item == null || typeof item !== 'object' || Array.isArray(item)) invalid('Invalid Node Runtime module')
    requireExactKeys(item, ['source', 'url'], 'module')
    const { source, url } = item
    if (typeof source !== 'string' || typeof url !== 'string') invalid('Invalid Node Runtime module')
    const sourceBytes = Buffer.byteLength(source)
    if (sourceBytes > MAX_MODULE_BYTES) invalid('Node Runtime module exceeds the byte limit')
    state.bytes += sourceBytes
    state.count += 1
    if (state.bytes > MAX_MODULE_GRAPH_BYTES || state.count > MAX_MODULES) {
      invalid('Node Runtime module graph exceeds the limit')
    }
    validateModuleUrl(url, kind)
    if (state.urls.has(url)) invalid('Duplicate Node Runtime module URL')
    state.urls.add(url)
    output.push(Object.freeze({ kind, source, url }))
  }
  return Object.freeze(output)
}

export const normalizeNetworkRules = value => {
  try {
    return normalizeNetworkRuleSet(value ?? { mode: 'passthrough', rules: [] })
  } catch (error) {
    if (error instanceof NetworkRuleContractError && error.code === 'network.rules_limit') {
      return invalid('Node Runtime network rules exceed the limit')
    }
    return invalid('Invalid Node Runtime network rules')
  }
}

export function normalizeNodeRuntimeSession(input) {
  const copied = copyJsonValue(input, 'Node Runtime session')
  if (copied == null || typeof copied !== 'object' || Array.isArray(copied)) invalid('Invalid Node Runtime session')
  requireExactKeys(
    copied,
    [
      'argv',
      'capabilityRuntime',
      'entryUrl',
      'env',
      'inspector',
      'moduleRootUrl',
      'networkRules',
      'runtimeModules',
      'pluginGraphRevision',
      'runtimePlugins',
      'sandboxPlan',
      'sandboxPolicy',
      'syntheticModules',
      'userEntryUrl',
      'userModules'
    ],
    'session'
  )
  const state = { bytes: 0, count: 0, urls: new Set() }
  const runtimeModules = readModules(copied.runtimeModules ?? [], 'runtime', state)
  const userModules = readModules(copied.userModules ?? [], 'user', state)
  const runtimePlugins = readNodeRuntimePluginsV1(copied.runtimePlugins, state, validateModuleUrl)
  const pluginGraphRevision = copied.pluginGraphRevision ?? (runtimePlugins.length === 0 ? 0 : 1)
  if (
    !Number.isSafeInteger(pluginGraphRevision) || pluginGraphRevision < 0 ||
    (runtimePlugins.length > 0 && pluginGraphRevision === 0)
  ) invalid('Invalid Node Runtime plugin graph revision')
  if (
    typeof copied.entryUrl !== 'string' ||
    ![...runtimeModules, ...userModules].some(module => module.url === copied.entryUrl)
  ) {
    invalid('Node Runtime entry must identify one session module')
  }
  const userEntryUrl = copied.userEntryUrl ?? copied.entryUrl
  if (typeof userEntryUrl !== 'string' || !userModules.some(module => module.url === userEntryUrl)) {
    invalid('Node Runtime user entry must identify one user module')
  }
  let defaultModuleRootUrl
  try {
    defaultModuleRootUrl = new URL('.', userEntryUrl).href
  } catch {
    invalid('Node Runtime module root must be absolute')
  }
  const moduleRootUrl = normalizeModuleGraphRoot(
    copied.moduleRootUrl ?? defaultModuleRootUrl,
    userModules.map(module => module.url)
  )
  if (copied.inspector != null) {
    if (typeof copied.inspector !== 'object' || Array.isArray(copied.inspector)) {
      invalid('Invalid Node Runtime inspector')
    }
    requireExactKeys(copied.inspector, ['enabled', 'waitForDebugger'], 'inspector')
    if (
      (copied.inspector.enabled != null && typeof copied.inspector.enabled !== 'boolean') ||
      (copied.inspector.waitForDebugger != null && typeof copied.inspector.waitForDebugger !== 'boolean')
    ) invalid('Invalid Node Runtime inspector')
  }
  const inspector = Object.freeze({
    enabled: copied.inspector?.enabled === true,
    waitForDebugger: copied.inspector?.waitForDebugger === true
  })
  const sandbox = normalizeNodeSandboxSession(copied.sandboxPolicy, copied.sandboxPlan)
  if (sandbox.policy.network.access === 'none' && copied.networkRules != null) {
    invalid('Node Runtime network rules require sandbox network access')
  }
  const defaultRules = sandbox.policy.network.access === 'mockOnly'
    ? { mode: 'failClosed', rules: [] }
    : { mode: 'passthrough', rules: [] }
  const networkRules = normalizeNetworkRules(copied.networkRules ?? defaultRules)
  if (
    sandbox.policy.network.access === 'mockOnly' &&
    (networkRules.mode !== 'failClosed' || networkRules.rules.some(rule => rule.action.type === 'passthrough'))
  ) invalid('Node Runtime mock-only network rules must remain fail closed')
  const capabilityRuntime = normalizeNodeCapabilityRuntimeSession(
    copied.capabilityRuntime,
    createNodeModuleLaunchV1({ moduleRootUrl, userEntryUrl, userModules }),
    inspector.enabled
  )
  assertNodeCapabilityNetworkIntersection(capabilityRuntime, sandbox.policy.network)
  return Object.freeze({
    argv: readArgv(copied.argv, userEntryUrl),
    ...(capabilityRuntime == null ? {} : { capabilityRuntime }),
    entryUrl: copied.entryUrl,
    env: readEnv(copied.env),
    inspector,
    moduleRootUrl,
    networkRules,
    pluginGraphRevision,
    runtimeModules,
    runtimePlugins,
    sandboxPlan: sandbox.plan,
    sandboxPolicy: sandbox.policy,
    syntheticModules: readSyntheticModules(copied.syntheticModules),
    userEntryUrl,
    userModules
  })
}
