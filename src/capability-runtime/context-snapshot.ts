import { canonicalDigest, canonicalJson } from './canonical-json.js'
import type { RuntimeContextEnvelopeV1, RuntimeContextLimitsV1 } from './context-types.js'
import { invalidPolicy } from './errors.js'
import type { JsonValueV1 } from './json-types.js'
import { utf8ByteLength } from './validation.js'

export const DEFAULT_RUNTIME_CONTEXT_LIMITS_V1: RuntimeContextLimitsV1 = Object.freeze({
  maxArrayLength: 256,
  maxDepth: 16,
  maxKeys: 1024,
  maxProjectionBytes: 64 * 1024,
  maxStringBytes: 16 * 1024
})

const copyJson = (
  value: unknown,
  limits: RuntimeContextLimitsV1,
  state: { keys: number },
  depth = 0
): JsonValueV1 => {
  if (depth > limits.maxDepth) return invalidPolicy()
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return invalidPolicy()
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value === 'string') {
    if (utf8ByteLength(value) > limits.maxStringBytes) return invalidPolicy()
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayLength) return invalidPolicy()
    return Object.freeze(value.map(item => copyJson(item, limits, state, depth + 1)))
  }
  if (value == null || typeof value !== 'object') return invalidPolicy()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) return invalidPolicy()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')) return invalidPolicy()
  const output = Object.create(null) as Record<string, JsonValueV1>
  for (const key of Object.keys(descriptors).sort()) {
    const descriptor = descriptors[key]!
    if (!descriptor.enumerable || !('value' in descriptor)) return invalidPolicy()
    state.keys += 1
    if (state.keys > limits.maxKeys || utf8ByteLength(key) > limits.maxStringBytes) return invalidPolicy()
    output[key] = copyJson(descriptor.value, limits, state, depth + 1)
  }
  return Object.freeze(output)
}

export const compileRuntimeContextEnvelopeV1 = (
  value: unknown,
  limits = DEFAULT_RUNTIME_CONTEXT_LIMITS_V1
): RuntimeContextEnvelopeV1 => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return invalidPolicy()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const allowed = ['guest', 'host', 'inspector', 'schemaVersion']
  if (
    Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !allowed.includes(key)) ||
    !('schemaVersion' in descriptors) || descriptors.schemaVersion?.value !== 1
  ) return invalidPolicy()
  const output: Record<string, JsonValueV1 | 1> = { schemaVersion: 1 }
  for (const key of ['host', 'guest', 'inspector'] as const) {
    const descriptor = descriptors[key]
    if (descriptor === undefined) continue
    if (!descriptor.enumerable || !('value' in descriptor)) return invalidPolicy()
    const copied = copyJson(descriptor.value, limits, { keys: 0 })
    if (utf8ByteLength(canonicalJson(copied)) > limits.maxProjectionBytes) return invalidPolicy()
    output[key] = copied
  }
  return Object.freeze(output) as unknown as RuntimeContextEnvelopeV1
}

export const runtimeContextDigestV1 = (value: RuntimeContextEnvelopeV1): string =>
  canonicalDigest(['runtimeContext', value as unknown as Record<string, never>])

export interface InvocationSnapshotCapabilityV1 {
  readonly binaryInternalSlotCopy: boolean
  readonly engineIsProxyWithoutTrap: boolean
  readonly guestReentryPrevented: boolean
  readonly plainOwnSlotWalker: boolean
  readonly schemaVersion: 1
}

export const validateInvocationSnapshotCapabilityV1 = (
  value: InvocationSnapshotCapabilityV1
): InvocationSnapshotCapabilityV1 => {
  if (
    value.schemaVersion !== 1 || !value.binaryInternalSlotCopy ||
    !value.engineIsProxyWithoutTrap || !value.guestReentryPrevented || !value.plainOwnSlotWalker
  ) return invalidPolicy()
  return Object.freeze({ ...value })
}
