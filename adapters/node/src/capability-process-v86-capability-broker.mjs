import { DEVICE_OPERATION_REGISTRY_V1 } from '@holonomyjs/capability-device'
import { SYSTEM_OPERATION_REGISTRY_V1 } from '@holonomyjs/capability-system'
import { decodeHoloUvCapabilityRequestV1, encodeHoloUvCapabilityResponseV1 } from '@holonomyjs/holouv'

const failure = code => encodeHoloUvCapabilityResponseV1({ error: code, ok: false, version: 1 })

const source = input =>
  Object.freeze({
    environmentId: input.environmentId,
    environmentScope: input.scope,
    executableId: input.executableId,
    kind: 'linuxProcess',
    linuxPid: input.linuxPid,
    processResourceId: input.processResourceId,
    syntheticProcessId: input.processId
  })

const descriptor = command => {
  if (command[0] === 'device') {
    const operation = command.length === 2 && command[1] === 'summary'
      ? 'device.summary.read'
      : command.length === 3 && command[1] === 'read'
      ? command[2]
      : undefined
    return DEVICE_OPERATION_REGISTRY_V1.find(item =>
      item.operation === operation && item.module === 'holo:device/promises' && item.modes.includes('promise')
    )
  }
  if (command[0] === 'system' && command.length === 3 && command[1] === 'read') {
    return SYSTEM_OPERATION_REGISTRY_V1.find(item =>
      item.limitsOwner.startsWith(`SystemFieldValueMapV1.${command[2]}:`)
    )
  }
  return undefined
}

export class NodeV86CapabilityBrokerV1 {
  #domains
  #invoke

  constructor(domains = []) {
    if (
      !Array.isArray(domains) || domains.length > 2 ||
      domains.some(domain => !['device', 'system'].includes(domain)) || new Set(domains).size !== domains.length
    ) throw new TypeError('Invalid v86 capability bridge')
    this.#domains = new Set(domains)
  }

  bind(invoke) {
    if (this.#invoke != null || typeof invoke !== 'function') throw new TypeError('Invalid v86 capability bridge')
    this.#invoke = invoke
    return this
  }

  async handle(input) {
    try {
      const request = decodeHoloUvCapabilityRequestV1(input.payload)
      if (!this.#domains.has(request.command[0])) return failure('bridge.unavailable')
      const operation = descriptor(request.command)
      if (operation == null || operation.kind === 'subscribe') return failure('bridge.unsupported')
      if (this.#invoke == null) return failure('bridge.unavailable')
      const value = await this.#invoke(Object.freeze({
        arguments: Object.freeze({}),
        member: operation.member,
        mode: operation.modes[0],
        module: operation.module,
        source: source(input)
      }))
      const json = JSON.stringify(value)
      if (typeof json !== 'string') return failure('bridge.protocol_error')
      return encodeHoloUvCapabilityResponseV1({ json, ok: true, version: 1 })
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[a-z][a-z\d_.-]{0,63}$/u.test(error.code)
        ? error.code
        : 'bridge.failed'
      return failure(code)
    }
  }
}
