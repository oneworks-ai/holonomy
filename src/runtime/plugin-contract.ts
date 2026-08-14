import type { JsonValueV1 } from '../capability-runtime/json-types.js'
import type { RuntimePluginDefinitionV1 } from './plugin-types.js'

const ID = /^[A-Za-z0-9][\w.-]{0,127}$/u
const EXPORT = /^[$A-Z_a-z][$\w]*$/u
const SHA256 = /^[a-f\d]{64}$/u

const freezeJson = (value: JsonValueV1): JsonValueV1 => {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child)
    Object.freeze(value)
  }
  return value
}

export const cloneRuntimePluginJsonV1 = (value: unknown): JsonValueV1 => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Runtime plugin config contains an invalid number')
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneRuntimePluginJsonV1))
  }
  if (value == null || typeof value !== 'object') {
    throw new TypeError('Runtime plugin config must contain JSON values')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Runtime plugin config must contain plain JSON objects')
  }
  const output: Record<string, JsonValueV1> = Object.create(null)
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor == null || !('value' in descriptor) || !descriptor.enumerable) {
      throw new TypeError('Runtime plugin config must contain plain JSON properties')
    }
    output[key] = cloneRuntimePluginJsonV1(descriptor.value)
  }
  return Object.freeze(output)
}

const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Runtime plugin definition must be an object')
  }
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !keys.includes(key))) {
    throw new TypeError('Runtime plugin definition contains an unknown field')
  }
  return input
}

export const normalizeRuntimePluginDefinitionsV1 = (
  value: unknown
): readonly RuntimePluginDefinitionV1[] => {
  if (!Array.isArray(value) || value.length > 128) {
    throw new TypeError('Runtime plugin graph must be a bounded array')
  }
  const ids = new Set<string>()
  return Object.freeze(value.map(item => {
    const input = exact(item, ['bundleSha256', 'config', 'entryUrl', 'exportName', 'instanceId'])
    const instanceId = input.instanceId
    const entryUrl = input.entryUrl
    const exportName = input.exportName
    const bundleSha256 = input.bundleSha256
    if (typeof instanceId !== 'string' || !ID.test(instanceId) || ids.has(instanceId)) {
      throw new TypeError('Runtime plugin instance id is invalid or duplicated')
    }
    if (
      typeof entryUrl !== 'string' ||
      !entryUrl.startsWith(`holo-plugins:///${instanceId}/`) ||
      new URL(entryUrl).href !== entryUrl
    ) throw new TypeError('Runtime plugin entry URL is invalid')
    if (typeof exportName !== 'string' || !EXPORT.test(exportName)) {
      throw new TypeError('Runtime plugin export name is invalid')
    }
    if (typeof bundleSha256 !== 'string' || !SHA256.test(bundleSha256)) {
      throw new TypeError('Runtime plugin bundle digest is invalid')
    }
    const config = cloneRuntimePluginJsonV1(input.config ?? {})
    freezeJson(config)
    ids.add(instanceId)
    return Object.freeze({
      bundleSha256,
      config,
      entryUrl: entryUrl as `holo-plugins:///${string}`,
      exportName,
      instanceId
    })
  }))
}

export const runtimePluginDefinitionKeyV1 = (value: RuntimePluginDefinitionV1): string =>
  JSON.stringify([
    value.bundleSha256,
    value.entryUrl,
    value.exportName,
    value.config
  ])
