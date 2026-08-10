import { isRuntimeComposerError, runtimeComposerError } from './errors.js'
import {
  capabilitiesAlign,
  createRuntimeRecord,
  defineRuntimeData,
  freezeRuntimeValue,
  hasCapability,
  invalidOptions,
  snapshotArray,
  snapshotCapabilityArray,
  snapshotOptionalRecord,
  snapshotRecord
} from './intrinsics.js'

const NETWORK_LIMITS = [
  'maxChunkBytes',
  'maxConcurrentConnections',
  'maxHeaderBytes',
  'maxHeaders',
  'maxRedirects',
  'maxRequestBodyBytes',
  'maxResponseBodyBytes',
  'maxWebSocketBufferedBytes',
  'maxWebSocketMessageBytes'
] as const
export const HTTP_LIMITS = [
  'maxChunkBytes',
  'maxConnections',
  'maxHeaderBytes',
  'maxHeaders',
  'maxRequestBodyBytes',
  'maxResponseBodyBytes',
  'maxWebSocketBufferedBytes',
  'maxWebSocketMessageBytes'
] as const

export const snapshotRuntimeAuthority = (value: unknown) => {
  const item = snapshotRecord(value, ['capabilities', 'principal'], ['capabilities', 'principal'])
  if (typeof item.principal !== 'string') invalidOptions()
  return freezeRuntimeValue({
    capabilities: snapshotCapabilityArray(item.capabilities),
    principal: item.principal as string
  })
}
export const assertChildAuthority = (
  value: unknown,
  required: string,
  root: ReturnType<typeof snapshotRuntimeAuthority>
) => {
  try {
    const allowed = required === 'host.git.v1'
      ? ['capabilities', 'configKeys', 'credentials', 'filesystem', 'limits', 'network', 'operations', 'principal']
      : ['capabilities', 'limits', 'namespace', 'operations', 'principal']
    const item = snapshotRecord(value, allowed, ['capabilities', 'principal'])
    const caps = snapshotCapabilityArray(item.capabilities)
    if (item.principal !== root.principal) throw runtimeComposerError('runtime_composer.principal_mismatch')
    if (
      !hasCapability(caps, required) || !hasCapability(root.capabilities, required) ||
      !capabilitiesAlign(caps, root.capabilities)
    ) throw runtimeComposerError('runtime_composer.required_capability')
  } catch (error) {
    if (isRuntimeComposerError(error)) throw error
    invalidOptions()
  }
}
export const snapshotNetworkAuthority = (value: unknown) => {
  const item = snapshotRecord(value, ['allowedOrigins', 'allowedSchemes', 'limits', 'privateNetwork'], [
    'allowedOrigins'
  ])
  const strings = (input: unknown) => {
    const values = snapshotArray(input)
    for (let index = 0; index < values.length; index += 1) if (typeof values[index] !== 'string') invalidOptions()
    return values
  }
  const output = createRuntimeRecord(Object.prototype)
  defineRuntimeData(output, 'allowedOrigins', strings(item.allowedOrigins))
  if (item.allowedSchemes !== undefined) {
    defineRuntimeData(output, 'allowedSchemes', strings(item.allowedSchemes))
  }
  const limits = snapshotOptionalRecord(item.limits, NETWORK_LIMITS)
  if (limits !== undefined) {
    defineRuntimeData(output, 'limits', limits)
  }
  if (item.privateNetwork !== undefined) {
    defineRuntimeData(output, 'privateNetwork', item.privateNetwork)
  }
  return freezeRuntimeValue(output)
}
