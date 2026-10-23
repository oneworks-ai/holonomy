/* eslint-disable max-lines -- One serial and network pump preserves HoloUV framing order. */
import {
  createHoloUvSupervisorEnvironmentFactoryV1,
  encodeHoloUvEnvironmentConfigurationV2
} from '../../../../packages/holouv/src/index.ts'

const MAX_SERIAL_BYTES = 64 * 1024
const MAX_DRAINS_PER_TURN = 4
const MAX_EVENT_BATCHES_PER_TURN = 8
const MAX_NETWORK_BATCHES_PER_TURN = 4

const ipv4 = value => {
  const parts = value.split('.')
  return parts.length === 4 && parts.every(part => /^(?:0|[1-9]\d{0,2})$/u.test(part) && Number(part) <= 255)
}

export const nativeV86EnvironmentHostsV1 = policy => {
  if (policy?.network?.access !== 'restricted') return Object.freeze([])
  const names = [
    ...new Set(
      policy.network.endpoints.map(endpoint => endpoint.hostname)
        .filter(value => !ipv4(value) && value !== 'localhost')
    )
  ].sort()
  return Object.freeze(names.map((hostname, index) =>
    Object.freeze({
      address: `192.168.${87 + Math.floor(index / 254)}.${index % 254 + 1}`,
      hostname
    })
  ))
}

/** Pumps the private VM isolate without exposing its identity or serial channel to Guest. */
export class NativeV86SerialPumpV1 {
  #command
  #environments = new Map()
  #nextId = 0
  #pumping = false
  #timer
  #schedule
  #clear
  #networkEvent

  constructor(command, { schedule = setTimeout, clear = clearTimeout, handleNetworkEvent } = {}) {
    if (
      command == null || typeof command.open !== 'function' ||
      typeof command.drainEvents !== 'function' || typeof schedule !== 'function' ||
      typeof clear !== 'function'
    ) throw new TypeError('Native v86 serial port is unavailable')
    this.#command = command
    this.#schedule = schedule
    this.#clear = clear
    this.#networkEvent = handleNetworkEvent
  }

  get activeCount() {
    return this.#environments.size
  }

  openTransport(request) {
    if (this.#nextId >= Number.MAX_SAFE_INTEGER) throw new Error('Native v86 environment IDs exhausted')
    const id = `vm-${++this.#nextId}`
    const generation = request.generation
    const networkEnabled = request.policy?.network?.access === 'restricted'
    this.#command.open(id, generation, request.configuration.memoryBytes, networkEnabled)
    const record = { id, generation, request, closed: false, started: false, networkEnabled }
    this.#environments.set(id, record)
    const abort = () => this.#close(record)
    record.abort = abort
    request.signal.addEventListener('abort', abort, { once: true })
    if (request.signal.aborted) abort()
    return Object.freeze({
      start: () => {
        if (record.closed) throw new Error('Native v86 environment closed')
        this.#command.start(id, generation)
        record.started = true
        this.#arm()
      },
      write: bytes => {
        if (record.closed || !(bytes instanceof Uint8Array)) {
          throw new TypeError('Native v86 serial write is unavailable')
        }
        for (let offset = 0; offset < bytes.byteLength; offset += MAX_SERIAL_BYTES) {
          this.#command.write(id, generation, bytes.subarray(offset, offset + MAX_SERIAL_BYTES))
        }
      },
      close: () => this.#close(record)
    })
  }

  pump() {
    if (this.#pumping || this.#environments.size === 0) return
    this.#pumping = true
    try {
      for (const record of [...this.#environments.values()]) {
        if (!record.started || record.closed) continue
        try {
          const state = this.#command.poll(record.id, record.generation)
          let remaining = state.queuedBytes
          for (let index = 0; remaining > 0 && index < MAX_DRAINS_PER_TURN; index += 1) {
            const result = this.#command.drain(record.id, record.generation, MAX_SERIAL_BYTES)
            if (result.bytes.byteLength === 0 && result.remainingBytes >= remaining) {
              throw new Error('Native v86 serial drain stalled')
            }
            remaining = result.remainingBytes
            if (result.bytes.byteLength > 0) record.request.onBytes(result.bytes)
            if (record.closed) break
          }
          if (!record.closed && record.networkEnabled) {
            for (let batch = 0; batch < MAX_NETWORK_BATCHES_PER_TURN; batch += 1) {
              const network = this.#command.networkDrain(record.id, record.generation, 4)
              for (const event of network.events) {
                if (this.#networkEvent == null) throw new Error('Native v86 network bridge unavailable')
                const deliver = delivery => {
                  if (record.closed) return
                  this.#command.networkDeliver(record.id, record.generation, delivery)
                }
                void Promise.resolve(this.#networkEvent(event, record.request, deliver))
                  .catch(() => {
                    if (!record.closed) this.#fault(record)
                  })
              }
              if (network.remaining === 0 || record.closed) break
            }
          }
          if (!record.closed && state.status === 'failed') this.#fault(record)
          else if (!record.closed && state.status === 'stopped') this.#stop(record)
        } catch {
          if (!record.closed) this.#fault(record)
        }
      }
      for (let batch = 0; batch < MAX_EVENT_BATCHES_PER_TURN; batch += 1) {
        const { events, remaining } = this.#command.drainEvents(32)
        for (const event of events) {
          const record = this.#environments.get(event.id)
          if (record == null || record.generation !== event.generation) continue
          if (event.kind === 'failed') this.#fault(record)
          else if (event.kind === 'stopped' || event.kind === 'closed') this.#stop(record)
        }
        if (remaining === 0) break
      }
    } catch {
      for (const record of [...this.#environments.values()]) this.#fault(record)
    } finally {
      this.#pumping = false
      this.#arm()
    }
  }

  close() {
    for (const record of [...this.#environments.values()]) this.#close(record)
    if (this.#timer != null) this.#clear(this.#timer)
    this.#timer = undefined
  }

  #arm() {
    if (this.#timer != null || ![...this.#environments.values()].some(record => record.started)) return
    this.#timer = this.#schedule(() => {
      this.#timer = undefined
      this.pump()
    }, 5)
  }

  #close(record) {
    if (record.closed) return
    record.closed = true
    this.#environments.delete(record.id)
    record.request.signal.removeEventListener('abort', record.abort)
    record.request.onEnvironmentClose?.(record.request.environmentId)
    try {
      this.#command.close(record.id, record.generation)
    } catch {}
  }

  #fault(record) {
    this.#close(record)
    record.request.onError()
  }

  #stop(record) {
    this.#close(record)
    record.request.onClose()
  }
}

export const createNativeV86EnvironmentFactoryV1 = (pump, options = {}) => {
  const authorizeExecution = options.authorizeExecution
  if (typeof authorizeExecution !== 'function') {
    throw new TypeError('Native v86 descendant authorization is unavailable')
  }
  return createHoloUvSupervisorEnvironmentFactoryV1({
    createConfiguration(request) {
      if (request.policy?.access !== 'sandboxed') {
        throw new TypeError('Native v86 Process Policy is unavailable')
      }
      return encodeHoloUvEnvironmentConfigurationV2({
        execGateTimeoutMs: request.configuration.supervisor.execGateTimeoutMs,
        hosts: nativeV86EnvironmentHostsV1(request.policy),
        maxProcessTreeDepth: request.policy.limits.maxProcessTreeDepth,
        maxTotalProcesses: request.policy.limits.maxTotalProcesses,
        version: 2
      })
    },
    handleExecutionRequest: authorizeExecution,
    handleCapabilityRequest: options.handleCapabilityRequest,
    handleFilesystemRequest: options.handleFilesystemRequest,
    ...(options.handleNetworkAttribution == null
      ? {}
      : { handleNetworkAttribution: options.handleNetworkAttribution }),
    openTransport: request => pump.openTransport({ ...request, onEnvironmentClose: options.onEnvironmentClose }),
    readyTimeoutMs: options.readyTimeoutMs ?? 30_000,
    validateReady(environment, request) {
      if (
        request.policy?.network?.access === 'restricted' &&
          !environment.kernelCapabilities.includes('seccompUserNotification') ||
        request.configuration.requiredKernelCapabilities.some(
          capability => !environment.kernelCapabilities.includes(capability)
        )
      ) throw new Error('Native v86 supervisor capabilities are unavailable')
    }
  })
}
