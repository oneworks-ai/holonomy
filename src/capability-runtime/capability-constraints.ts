import { invalidPolicy } from './errors.js'
import type { JsonValueV1 } from './json-types.js'
import type { BuiltInCapabilityNameV1 } from './operation-types.js'
import type { NetworkLimitNameV2 } from './policy-types.js'
import { normalizeProcessCapabilityConstraintsV1 } from './process-capability-constraints.js'
import { DEVICE_OPERATIONS_V1, SYSTEM_INFORMATION_FIELDS_V1 } from './registry-types.js'
import { array, exact, identifier, integer, literal, required, stringSet } from './validation.js'

export type NormalizedCapabilityConstraintsV1 = Readonly<Record<string, JsonValueV1>>
export const DEVICE_PRECISION_V1 = Object.freeze(['coarse', 'standard', 'exact'] as const)
export const SYSTEM_PRECISION_V1 = Object.freeze(['redacted', 'coarse', 'exact'] as const)

const FS_RIGHTS = ['create', 'delete', 'list', 'move', 'read', 'watch', 'write'] as const
const NETWORK_LIMITS = [
  'maxChunkBytes',
  'maxConcurrentConnections',
  'maxHeaderBytes',
  'maxHeaders',
  'maxRedirects',
  'maxRequestBodyBytes',
  'maxResponseBodyBytes',
  'maxUrlBytes',
  'socketTimeoutMs'
] as const satisfies readonly NetworkLimitNameV2[]

const limits = (value: unknown, keys: readonly string[]) => {
  const input = exact(value, keys)
  return Object.freeze(Object.fromEntries(keys.map(key => [
    key,
    integer(required(input, key), 0, 4 * 1024 * 1024 * 1024)
  ]))) as NormalizedCapabilityConstraintsV1
}

const filesystem = (value: unknown): NormalizedCapabilityConstraintsV1 => {
  const input = exact(value, ['limits', 'roots'])
  const roots = array(required(input, 'roots'), 1, 64).map(rootValue => {
    const root = exact(rootValue, ['pathPrefixSegments', 'rights', 'rootId'])
    const pathPrefixSegments = array(required(root, 'pathPrefixSegments'), 0, 256)
      .map(segment => identifier(segment, 255))
    return Object.freeze({
      pathPrefixSegments: Object.freeze(pathPrefixSegments),
      rights: stringSet(required(root, 'rights'), FS_RIGHTS, 1, FS_RIGHTS.length),
      rootId: identifier(required(root, 'rootId'), 64)
    })
  }).sort((left, right) => {
    const root = left.rootId.localeCompare(right.rootId)
    return root === 0
      ? left.pathPrefixSegments.join('/').localeCompare(right.pathPrefixSegments.join('/'))
      : root
  })
  const identities = roots.map(root => `${root.rootId}\0${root.pathPrefixSegments.join('\0')}`)
  if (new Set(identities).size !== roots.length) return invalidPolicy()
  return Object.freeze({
    limits: limits(required(input, 'limits'), [
      'maxDirectoryEntries',
      'maxOpenHandles',
      'maxReadBytes',
      'maxWatchers',
      'maxWriteBytes'
    ]),
    roots: Object.freeze(roots)
  })
}

const network = (
  value: unknown,
  expectedMode: 'mockOnly' | 'restricted'
): NormalizedCapabilityConstraintsV1 => {
  const input = exact(value, [
    'allowPrivateNetwork',
    'inspectRequestBodyBytes',
    'limits',
    'mode',
    'origins',
    'schemes'
  ])
  if (required(input, 'mode') !== expectedMode) return invalidPolicy()
  const origins = array(required(input, 'origins'), 0, 64).map(item => {
    if (typeof item !== 'string') return invalidPolicy()
    try {
      const url = new URL(item)
      if (url.origin !== item || url.pathname !== '/' || !['http:', 'https:'].includes(url.protocol)) {
        return invalidPolicy()
      }
      return item
    } catch {
      return invalidPolicy()
    }
  }).sort()
  if (new Set(origins).size !== origins.length) return invalidPolicy()
  const schemes = stringSet(required(input, 'schemes'), ['http', 'https'] as const, 0, 2)
  if (origins.some(origin => !schemes.includes(new URL(origin).protocol.slice(0, -1) as never))) {
    return invalidPolicy()
  }
  const allowPrivateNetwork = required(input, 'allowPrivateNetwork')
  if (typeof allowPrivateNetwork !== 'boolean' || expectedMode === 'mockOnly' && allowPrivateNetwork) {
    return invalidPolicy()
  }
  return Object.freeze({
    allowPrivateNetwork,
    inspectRequestBodyBytes: integer(required(input, 'inspectRequestBodyBytes'), 0, 1024 * 1024),
    limits: limits(required(input, 'limits'), NETWORK_LIMITS),
    mode: expectedMode,
    origins: Object.freeze(origins),
    schemes
  })
}

const device = (value: unknown): NormalizedCapabilityConstraintsV1 => {
  const input = exact(value, ['maxPrecision', 'maxPrivacyTier', 'operations'])
  return Object.freeze({
    maxPrecision: literal(required(input, 'maxPrecision'), DEVICE_PRECISION_V1),
    maxPrivacyTier: integer(required(input, 'maxPrivacyTier'), 0, 3),
    operations: stringSet(required(input, 'operations'), DEVICE_OPERATIONS_V1, 1, DEVICE_OPERATIONS_V1.length)
  })
}

const system = (value: unknown): NormalizedCapabilityConstraintsV1 => {
  const input = exact(value, ['fields', 'maxPrecision', 'modes'])
  return Object.freeze({
    fields: stringSet(required(input, 'fields'), SYSTEM_INFORMATION_FIELDS_V1, 1, SYSTEM_INFORMATION_FIELDS_V1.length),
    maxPrecision: literal(required(input, 'maxPrecision'), SYSTEM_PRECISION_V1),
    modes: stringSet(required(input, 'modes'), ['real', 'redacted', 'synthetic'] as const, 1, 3)
  })
}

const identifiers = (value: unknown, maximum: number) => {
  const values = array(value, 0, maximum).map(item => identifier(item, 128)).sort()
  if (new Set(values).size !== values.length) return invalidPolicy()
  return Object.freeze(values)
}

export const normalizeCapabilityConstraintsV1 = (
  name: BuiltInCapabilityNameV1,
  value: unknown
): NormalizedCapabilityConstraintsV1 => {
  if (name === 'host.fs') return filesystem(value)
  if (name === 'host.network.http') return network(value, 'restricted')
  if (name === 'host.network.mock') return network(value, 'mockOnly')
  if (name.startsWith('host.device.')) return device(value)
  if (name.startsWith('host.system.')) return system(value)
  if (name.startsWith('host.process.')) return normalizeProcessCapabilityConstraintsV1(name, value)
  const input = exact(
    value,
    name === 'host.storage.credential'
      ? ['stores', 'usages']
      : ['maxReadBytes', 'maxReads']
  )
  if (name === 'host.storage.credential') {
    return Object.freeze({
      stores: identifiers(required(input, 'stores'), 64),
      usages: stringSet(required(input, 'usages'), ['gitHttp', 'httpAuthorization'] as const, 1, 2)
    })
  }
  return Object.freeze({
    maxReadBytes: integer(required(input, 'maxReadBytes'), 0, 1024 * 1024),
    maxReads: integer(required(input, 'maxReads'), 0, 1024)
  })
}
