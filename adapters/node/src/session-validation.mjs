import { Buffer } from 'node:buffer'

import { copyJsonValue, freezeJsonValue } from './json-value.mjs'
import { normalizeModuleGraphRoot } from './module-root-validation.mjs'
import { NetworkRuleContractError, normalizeNetworkRuleSet } from './network-rule-contract.mjs'
import { normalizeNodeSandboxSession } from './sandbox-session.mjs'
import { readArgv, readEnv } from './session-process-input.mjs'

const MAX_MODULES = 512
const MAX_MODULE_BYTES = 8 * 1024 * 1024
const MAX_MODULE_GRAPH_BYTES = 48 * 1024 * 1024
const MAX_SYNTHETIC_EXPORTS = 256
const MAX_SYNTHETIC_MODULES = 64
const MAX_SYNTHETIC_REGISTRY_BYTES = 8 * 1024 * 1024
const MAX_URL_BYTES = 4 * 1024
const EXPORT_NAME = /^[$A-Z_a-z][$\w]*$/u

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
  if ((kind === 'runtime') !== internal || (kind === 'user' && ['holonomy:', 'node:'].includes(url.protocol))) {
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

const readSyntheticModules = value => {
  if (value == null) return Object.freeze(Object.create(null))
  if (typeof value !== 'object' || Array.isArray(value)) invalid('Invalid Node Runtime synthetic registry')
  const output = Object.create(null)
  const specifiers = Object.keys(value)
  if (specifiers.length > MAX_SYNTHETIC_MODULES) invalid('Node Runtime synthetic registry exceeds the limit')
  let bytes = 0
  for (const specifier of specifiers) {
    if (!/^node:[a-z\d][a-z\d_./-]*$/u.test(specifier) || Buffer.byteLength(specifier) > MAX_URL_BYTES) {
      invalid('Node Runtime synthetic module must use a canonical node: specifier')
    }
    const namespace = value[specifier]
    if (namespace == null || typeof namespace !== 'object' || Array.isArray(namespace)) {
      invalid('Invalid Node Runtime synthetic namespace')
    }
    const names = Object.keys(namespace)
    if (names.length > MAX_SYNTHETIC_EXPORTS || names.some(name => !EXPORT_NAME.test(name))) {
      invalid('Invalid Node Runtime synthetic exports')
    }
    const copied = Object.create(null)
    for (const name of names) {
      copied[name] = freezeJsonValue(copyJsonValue(namespace[name], 'synthetic export'))
      bytes += Buffer.byteLength(JSON.stringify(copied[name]))
      if (bytes > MAX_SYNTHETIC_REGISTRY_BYTES) invalid('Node Runtime synthetic registry exceeds the byte limit')
    }
    output[specifier] = Object.freeze(copied)
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
      'entryUrl',
      'env',
      'inspector',
      'moduleRootUrl',
      'networkRules',
      'runtimeModules',
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
  return Object.freeze({
    argv: readArgv(copied.argv, userEntryUrl),
    entryUrl: copied.entryUrl,
    env: readEnv(copied.env),
    inspector,
    moduleRootUrl,
    networkRules,
    runtimeModules,
    sandboxPlan: sandbox.plan,
    sandboxPolicy: sandbox.policy,
    syntheticModules: readSyntheticModules(copied.syntheticModules),
    userEntryUrl,
    userModules
  })
}
