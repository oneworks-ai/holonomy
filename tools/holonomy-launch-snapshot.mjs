import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import process from 'node:process'
import { TextDecoder } from 'node:util'

import { runWrapperSource, testRunnerSource } from './holonomy-entry-source.mjs'
import { collectHolonomyGraph, expandHolonomyEntries } from './holonomy-module-graph.mjs'
import { requiresHolonomyNetworkFixture } from './holonomy-network-fixture.mjs'
import { readHolonomyNetworkRules } from './holonomy-network-rules-file.mjs'
import { prepareHolonomyRuntimePlugins } from './holonomy-plugin-bundle.mjs'

const MAX_SANDBOX_POLICY_BYTES = 1024 * 1024
const DEFAULT_SANDBOX_POLICY = Object.freeze({
  filesystem: Object.freeze({ access: 'none' }),
  network: Object.freeze({ access: 'none' }),
  schemaVersion: 1
})
const decoder = new TextDecoder('utf-8', { fatal: true })

const freezeJson = value => {
  if (value == null || typeof value !== 'object') return value
  for (const child of Object.values(value)) freezeJson(child)
  return Object.freeze(value)
}

export const readHolonomySandboxPolicy = (input, options = {}) => {
  if (typeof input !== 'string' || input === '' || extname(input).toLowerCase() !== '.json') {
    throw new Error('--sandbox must reference one JSON file')
  }
  const path = resolve(options.cwd ?? process.cwd(), input)
  let descriptor
  try {
    const before = lstatSync(path)
    if (before.isSymbolicLink()) throw new Error('Sandbox policy file must not be a symbolic link')
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const opened = fstatSync(descriptor)
    if (!opened.isFile()) throw new Error('Sandbox policy path is not a file')
    if (before.dev !== opened.dev || before.ino !== opened.ino) throw new Error('Sandbox policy file is unavailable')
    if (opened.size > MAX_SANDBOX_POLICY_BYTES) throw new Error('Sandbox policy file exceeds the size limit')
    const bytes = new Uint8Array(MAX_SANDBOX_POLICY_BYTES + 1)
    let offset = 0
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset)
      if (count === 0) break
      offset += count
    }
    if (offset > MAX_SANDBOX_POLICY_BYTES) throw new Error('Sandbox policy file exceeds the size limit')
    let value
    try {
      value = JSON.parse(decoder.decode(bytes.subarray(0, offset)))
    } catch {
      throw new Error('Sandbox policy file is not valid UTF-8 JSON')
    }
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Sandbox policy file must contain one policy object')
    }
    return freezeJson(value)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Sandbox policy ')) throw error
    throw new Error('Sandbox policy file is unavailable')
  } finally {
    if (descriptor != null) {
      try {
        closeSync(descriptor)
      } catch {
        // The stable read result remains authoritative.
      }
    }
  }
}

export const readHolonomyCapabilityRuntime = (input, options = {}) => {
  if (typeof input !== 'string' || input === '' || extname(input).toLowerCase() !== '.json') {
    throw new Error('--capability-runtime must reference one JSON file')
  }
  const path = resolve(options.cwd ?? process.cwd(), input)
  let descriptor
  try {
    const before = lstatSync(path)
    if (before.isSymbolicLink()) throw new Error('Capability Runtime file must not be a symbolic link')
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const opened = fstatSync(descriptor)
    if (!opened.isFile()) throw new Error('Capability Runtime path is not a file')
    if (before.dev !== opened.dev || before.ino !== opened.ino) {
      throw new Error('Capability Runtime file is unavailable')
    }
    if (opened.size > MAX_SANDBOX_POLICY_BYTES) throw new Error('Capability Runtime file exceeds the size limit')
    const bytes = new Uint8Array(MAX_SANDBOX_POLICY_BYTES + 1)
    let offset = 0
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset)
      if (count === 0) break
      offset += count
    }
    if (offset > MAX_SANDBOX_POLICY_BYTES) throw new Error('Capability Runtime file exceeds the size limit')
    let value
    try {
      value = JSON.parse(decoder.decode(bytes.subarray(0, offset)))
    } catch {
      throw new Error('Capability Runtime file is not valid UTF-8 JSON')
    }
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Capability Runtime file must contain one configuration object')
    }
    return freezeJson(value)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Capability Runtime ')) throw error
    throw new Error('Capability Runtime file is unavailable')
  } finally {
    if (descriptor != null) {
      try {
        closeSync(descriptor)
      } catch {
        // The stable read result remains authoritative.
      }
    }
  }
}

export const prepareHolonomyLaunchSnapshot = (command, options, dependencies = {}) => {
  const entries = expandHolonomyEntries(options.entries)
  if (command === 'run' && entries.length !== 1) {
    throw new Error('holonomy run requires exactly one entry module')
  }
  const rootUrl = new URL(options.rootUrl)
  const { entryUrls, modules } = collectHolonomyGraph(entries, rootUrl)
  const uuid = dependencies.randomUUID?.() ?? randomUUID()
  const virtualEntry = new URL(`.holonomy/${command}-${uuid}.mjs`, rootUrl).toString()
  modules.set(virtualEntry, {
    source: command === 'test' ? testRunnerSource(entryUrls, options.reporter) : runWrapperSource(entryUrls[0]),
    url: virtualEntry
  })
  const networkRuleSet = options.networkRules == null
    ? undefined
    : (dependencies.readNetworkRules ?? readHolonomyNetworkRules)(options.networkRules)
  const sandboxPolicy = options.sandbox == null
    ? DEFAULT_SANDBOX_POLICY
    : (dependencies.readSandboxPolicy ?? readHolonomySandboxPolicy)(options.sandbox)
  const capabilityRuntime = options.capabilityRuntime == null
    ? undefined
    : (dependencies.readCapabilityRuntime ?? readHolonomyCapabilityRuntime)(options.capabilityRuntime)
  const preparedPlugins = options.config == null
    ? undefined
    : (dependencies.prepareRuntimePlugins ?? prepareHolonomyRuntimePlugins)(options.config, {
      allowedAbsoluteRoots: options.pluginRoots
    })
  return Object.freeze({
    capabilityRuntime,
    entryUrl: virtualEntry,
    fixture: requiresHolonomyNetworkFixture(command, entries)
      ? Object.freeze({ kind: 'conformance-network-v1' })
      : undefined,
    inspectorMode: options.inspect == null
      ? 'off'
      : options.inspect.breakBeforeEntry
      ? 'break'
      : 'enabled',
    isolation: options.isolation,
    launch: Object.freeze({
      argv: Object.freeze([virtualEntry, ...options.argv]),
      command,
      entryUrl: virtualEntry,
      env: Object.freeze({ ...options.env }),
      moduleRootUrl: rootUrl.toString(),
      modules: Object.freeze([...modules.values()].map(module => Object.freeze({ ...module }))),
      reporter: options.reporter,
      schemaVersion: 2,
      target: options.target
    }),
    networkRuleSet,
    pluginConfigPath: preparedPlugins?.configPath,
    runtimePlugins: preparedPlugins?.bundles,
    sandboxPolicy: freezeJson(sandboxPolicy),
    target: options.target
  })
}
