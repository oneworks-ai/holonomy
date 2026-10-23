import { DEVICE_OPERATION_REGISTRY_V1 } from '@holonomyjs/capability-device'
import { SYSTEM_OPERATION_REGISTRY_V1 } from '@holonomyjs/capability-system'
import { decodeHoloUvCapabilityRequestV1, encodeHoloUvCapabilityResponseV1 } from '@holonomyjs/holouv'

const DEFAULT_MAX_PENDING = 64
const DEFAULT_TIMEOUT_MS = 30_000
const failure = code => encodeHoloUvCapabilityResponseV1({ error: code, ok: false, version: 1 })

const source = input =>
  Object.freeze({
    environmentId: input.environmentId,
    environmentScope: input.scope,
    executableId: input.executableId,
    kind: 'linuxProcess',
    linuxPid: input.linuxPid,
    parentLinuxPid: input.parentLinuxPid,
    ...(input.processStartTimeTicks > 0 ? { processStartTimeTicks: input.processStartTimeTicks } : {}),
    processResourceId: input.processResourceId,
    rootLinuxPid: input.rootLinuxPid,
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

const errorCode = error =>
  typeof error?.code === 'string' && /^[a-z][a-z\d_.-]{0,63}$/u.test(error.code)
    ? error.code
    : 'bridge.failed'

/** One HoloUV Device/System route for Node and Native. The Kernel remains the authority. */
export class V86CapabilityBrokerV1 {
  #closedThrough = 0
  #domains
  #invoke
  #maxPending
  #pending = new Set()
  #timeoutMs

  constructor(domains = [], { maxPending = DEFAULT_MAX_PENDING, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (
      !Array.isArray(domains) || domains.length > 2 ||
      domains.some(domain => !['device', 'system'].includes(domain)) || new Set(domains).size !== domains.length ||
      !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > DEFAULT_MAX_PENDING ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000
    ) throw new TypeError('Invalid v86 capability bridge')
    this.#domains = new Set(domains)
    this.#maxPending = maxPending
    this.#timeoutMs = timeoutMs
  }

  bind(invoke) {
    if (this.#invoke != null || typeof invoke !== 'function') throw new TypeError('Invalid v86 capability bridge')
    this.#invoke = invoke
    return this
  }

  closeGeneration(generation) {
    if (!Number.isSafeInteger(generation) || generation < 1) throw new TypeError('Invalid v86 generation')
    this.#closedThrough = Math.max(this.#closedThrough, generation)
    for (const pending of this.#pending) {
      if (pending.generation <= this.#closedThrough) pending.cancel('runtime.generation_stale')
    }
  }

  async handle(input) {
    try {
      const request = decodeHoloUvCapabilityRequestV1(input.payload)
      if (!this.#domains.has(request.command[0])) return failure('bridge.unavailable')
      const operation = descriptor(request.command)
      if (operation == null || operation.kind === 'subscribe') return failure('bridge.unsupported')
      if (this.#invoke == null) return failure('bridge.unavailable')
      if (!Number.isSafeInteger(input.generation) || input.generation < 1) return failure('bridge.protocol_error')
      if (input.generation <= this.#closedThrough) return failure('runtime.generation_stale')
      if (input.signal?.aborted) return failure('bridge.cancelled')
      if (this.#pending.size >= this.#maxPending) return failure('bridge.busy')
      const invocation = Object.freeze({
        arguments: Object.freeze({}),
        member: operation.member,
        mode: operation.modes[0],
        module: operation.module,
        source: source(input)
      })
      return await new Promise(resolve => {
        const controller = new AbortController()
        let responded = false
        let timer
        let pending
        const aborted = () => pending.cancel('bridge.cancelled')
        const finish = response => {
          if (responded) return
          responded = true
          clearTimeout(timer)
          input.signal?.removeEventListener('abort', aborted)
          resolve(response)
        }
        pending = Object.freeze({
          generation: input.generation,
          cancel: code => {
            controller.abort()
            finish(failure(code))
          }
        })
        timer = setTimeout(() => pending.cancel('bridge.timeout'), this.#timeoutMs)
        // A rejected Host timer admission has started no Kernel work and must
        // not permanently occupy a capability slot.
        this.#pending.add(pending)
        input.signal?.addEventListener('abort', aborted, { once: true })
        if (input.signal?.aborted) aborted()
        const skipped = Symbol('cancelled')
        Promise.resolve()
          .then(() => responded ? skipped : this.#invoke(invocation, controller.signal))
          .then(value => {
            if (value === skipped || responded) return
            const json = JSON.stringify(value)
            if (typeof json !== 'string') return finish(failure('bridge.protocol_error'))
            try {
              finish(encodeHoloUvCapabilityResponseV1({ json, ok: true, version: 1 }))
            } catch {
              finish(failure('bridge.protocol_error'))
            }
          }, error => finish(failure(errorCode(error))))
          .catch(error => finish(failure(errorCode(error))))
          .finally(() => this.#pending.delete(pending))
      })
    } catch (error) {
      return failure(errorCode(error))
    }
  }
}
