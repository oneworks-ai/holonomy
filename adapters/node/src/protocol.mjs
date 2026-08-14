import { copyJsonValue, freezeJsonValue } from './json-value.mjs'

export const NODE_ADAPTER_PROTOCOL_VERSION = 1

export function createParentCommand(type, requestId, generation, value = undefined) {
  if (!Number.isSafeInteger(requestId) || requestId <= 0) throw new TypeError('Invalid Node adapter request ID')
  if (!Number.isSafeInteger(generation) || generation <= 0) throw new TypeError('Invalid Node adapter generation')
  if (!['plugins', 'resume', 'rules', 'start', 'status', 'stop'].includes(type)) {
    throw new TypeError('Invalid Node adapter command')
  }
  return Object.freeze({
    generation,
    protocolVersion: NODE_ADAPTER_PROTOCOL_VERSION,
    requestId,
    type,
    ...(value === undefined ? {} : { value: freezeJsonValue(copyJsonValue(value, 'Node adapter command value')) })
  })
}

export function readChildEvent(input, generation) {
  const value = copyJsonValue(input, 'Node adapter child event')
  if (
    value == null || typeof value !== 'object' || Array.isArray(value) ||
    value.protocolVersion !== NODE_ADAPTER_PROTOCOL_VERSION || value.generation !== generation ||
    typeof value.type !== 'string'
  ) return undefined
  if (!['ack', 'fatal', 'inspector', 'log', 'network', 'state'].includes(value.type)) return undefined
  return freezeJsonValue(value)
}

export function childEvent(type, generation, fields = {}) {
  return {
    ...fields,
    generation,
    protocolVersion: NODE_ADAPTER_PROTOCOL_VERSION,
    type
  }
}
