/* eslint-disable max-lines -- framed request, process and transport terminals share one state owner. */

import {
  ProcessSupervisorFrameDecoderV1,
  decodeProcessSupervisorReadyPayloadV1,
  encodeProcessSupervisorFrameV1
} from '../../../dist/capability-runtime/index.js'

import {
  completionPayload,
  emptyPayload,
  encodeSignalPayload,
  encodeSpawnPayload,
  errorPayload,
  spawnedPayload
} from './capability-process-supervisor-frames.mjs'
import { SupervisorProcessV1 } from './capability-process-supervisor-process.mjs'

const deferred = () => {
  let reject
  let resolve
  const promise = new Promise((resolveValue, rejectValue) => {
    reject = rejectValue
    resolve = resolveValue
  })
  promise.catch(() => undefined)
  return { promise, reject, resolve }
}

const failure = code => {
  const error = new Error('Process supervisor connection failed')
  Object.defineProperty(error, 'code', { enumerable: true, value: code })
  return error
}

class SupervisorEnvironmentV1 {
  #closed = false
  #decoder = new ProcessSupervisorFrameDecoderV1()
  #nextRequestId = 1
  #kernelCapabilities = Object.freeze([])
  #filesystem
  #pending = new Map()
  #processes = new Map()
  #processSources = new Map()
  #ready = deferred()
  #readyReceived = false
  #readyTimer
  #transport
  #transportClose

  constructor(readyTimeoutMs, filesystem) {
    this.#filesystem = filesystem
    this.#readyTimer = setTimeout(() => this.fail(failure('supervisor.ready_timeout')), readyTimeoutMs)
  }

  get kernelCapabilities() {
    return this.#kernelCapabilities
  }

  attach(transport) {
    if (
      transport == null || typeof transport !== 'object' ||
      typeof transport.close !== 'function' || typeof transport.write !== 'function'
    ) throw new TypeError('Invalid Process supervisor transport')
    this.#transport = transport
    if (this.#closed) void this.#closeTransport('supervisor-closed')
  }

  async close(reason) {
    if (this.#closed) return
    if (this.#transport != null) {
      await this.#write('shutdown', 0, 0, new Uint8Array()).catch(() => undefined)
    }
    this.fail(failure('supervisor.closed'), reason)
    await this.#transportClose
  }

  command(operation, processId, payload) {
    if (this.#closed || !this.#processes.has(processId)) return Promise.reject(failure('supervisor.closed'))
    const requestId = this.#allocateRequestId()
    const terminal = deferred()
    this.#pending.set(requestId, { kind: 'command', processId, terminal })
    const encoded = operation === 'signal' ? encodeSignalPayload(payload) : payload ?? new Uint8Array()
    this.#write(operation, processId, requestId, encoded).catch(error => {
      this.#pending.delete(requestId)
      terminal.reject(error)
    })
    return terminal.promise
  }

  fail(error, closeReason = 'supervisor-failed') {
    if (this.#closed) return
    this.#closed = true
    clearTimeout(this.#readyTimer)
    this.#ready.reject(error)
    for (const pending of this.#pending.values()) pending.terminal.reject(error)
    this.#pending.clear()
    for (const process of this.#processes.values()) process.fail(error)
    this.#processes.clear()
    this.#processSources.clear()
    void this.#closeTransport(closeReason)
  }

  receive(bytes) {
    if (this.#closed) return
    try {
      for (const frame of this.#decoder.push(bytes)) this.#receiveFrame(frame)
    } catch (error) {
      this.fail(error)
    }
  }

  processSource(processId) {
    if (processId === 0) return undefined
    const source = this.#processSources.get(processId)
    if (source == null) throw failure('supervisor.protocol_error')
    return source
  }

  networkProcessSource(scope) {
    if (this.#processSources.size !== 1) throw failure('supervisor.network_attribution_unavailable')
    const [processId, source] = this.#processSources.entries().next().value
    if (scope !== 'processTree') throw failure('supervisor.network_attribution_unavailable')
    return Object.freeze({ ...source, processId })
  }

  async ready(signal) {
    if (signal.aborted) this.fail(failure('supervisor.cancelled'))
    const abort = () => this.fail(failure('supervisor.cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    try {
      this.#kernelCapabilities = await this.#ready.promise
    } finally {
      signal.removeEventListener('abort', abort)
    }
    return this
  }

  spawn(request, sink) {
    if (this.#closed) return Promise.reject(failure('supervisor.closed'))
    const requestId = this.#allocateRequestId()
    const terminal = deferred()
    this.#pending.set(requestId, {
      kind: 'spawn',
      sink,
      source: Object.freeze({
        executableId: request.executableId,
        processResourceId: request.processResourceId
      }),
      terminal
    })
    this.#write('spawn', 0, requestId, encodeSpawnPayload(request)).catch(error => {
      this.#pending.delete(requestId)
      terminal.reject(error)
    })
    return terminal.promise
  }

  #allocateRequestId() {
    const requestId = this.#nextRequestId
    this.#nextRequestId = requestId === 0xFFFFFFFF ? 1 : requestId + 1
    if (this.#pending.has(requestId)) throw failure('supervisor.request_id_exhausted')
    return requestId
  }

  #closeTransport(reason) {
    if (this.#transportClose != null) return this.#transportClose
    if (this.#transport == null) return Promise.resolve()
    this.#transportClose = Promise.resolve(this.#transport.close(reason)).catch(() => undefined)
    return this.#transportClose
  }

  #receiveFrame(frame) {
    if (frame.operation === 'ready') {
      if (this.#readyReceived) throw failure('supervisor.protocol_error')
      const capabilities = decodeProcessSupervisorReadyPayloadV1(frame.payload)
      this.#readyReceived = true
      clearTimeout(this.#readyTimer)
      this.#ready.resolve(capabilities)
      return
    }
    if (!this.#readyReceived) throw failure('supervisor.protocol_error')
    if (frame.operation === 'filesystemRequest') {
      if (this.#filesystem == null) throw failure('supervisor.filesystem_unavailable')
      Promise.resolve(this.#filesystem(frame)).then(payload => {
        if (!(payload instanceof Uint8Array)) throw failure('supervisor.protocol_error')
        if (!this.#closed) {
          return this.#write(
            'filesystemResponse',
            frame.processId,
            frame.requestId,
            payload
          )
        }
      }).catch(error => this.fail(error))
      return
    }
    const pending = this.#pending.get(frame.requestId)
    if (frame.operation === 'ack') {
      emptyPayload(frame.payload)
      if (pending?.kind !== 'command' || pending.processId !== frame.processId) {
        throw failure('supervisor.protocol_error')
      }
      this.#pending.delete(frame.requestId)
      pending.terminal.resolve()
      return
    }
    if (frame.operation === 'spawned') {
      if (pending?.kind !== 'spawn') throw failure('supervisor.protocol_error')
      const spawned = spawnedPayload(frame.payload, frame.processId)
      const processId = spawned.processId
      if (this.#processes.has(processId)) throw failure('supervisor.protocol_error')
      const process = new SupervisorProcessV1(this, processId, pending.sink)
      this.#pending.delete(frame.requestId)
      this.#processes.set(processId, process)
      this.#processSources.set(processId, Object.freeze({ ...pending.source, linuxPid: spawned.linuxPid }))
      pending.terminal.resolve(process)
      return
    }
    if (frame.operation === 'error') {
      const error = errorPayload(frame.payload)
      if (pending != null) {
        if (pending.kind === 'command' && pending.processId !== frame.processId) {
          throw failure('supervisor.protocol_error')
        }
        this.#pending.delete(frame.requestId)
        pending.terminal.reject(error)
      } else this.#processes.get(frame.processId)?.error(error)
      return
    }
    const process = this.#processes.get(frame.processId)
    if (process == null) throw failure('supervisor.protocol_error')
    if (frame.operation === 'stdout' || frame.operation === 'stderr') {
      process.stream(frame.operation, frame.sequence, frame.payload)
      return
    }
    if (frame.operation === 'exit' || frame.operation === 'close') {
      const terminal = completionPayload(frame.payload)
      process[frame.operation](terminal.code, terminal.signal)
      if (frame.operation === 'close') {
        this.#processes.delete(frame.processId)
        this.#processSources.delete(frame.processId)
      }
      return
    }
    throw failure('supervisor.protocol_error')
  }

  #write(operation, processId, requestId, payload) {
    if (this.#closed || this.#transport == null) return Promise.reject(failure('supervisor.closed'))
    return Promise.resolve(this.#transport.write(encodeProcessSupervisorFrameV1({
      operation,
      payload,
      processId,
      requestId,
      sequence: 0,
      version: 1
    })))
  }
}

export const createSupervisorProcessEnvironmentFactoryV1 = options => {
  if (
    typeof options?.openTransport !== 'function' ||
    options.handleFilesystemRequest != null && typeof options.handleFilesystemRequest !== 'function'
  ) throw new TypeError('Invalid Process supervisor transport')
  const readyTimeoutMs = options.readyTimeoutMs ?? 30_000
  if (!Number.isInteger(readyTimeoutMs) || readyTimeoutMs < 1 || readyTimeoutMs > 120_000) {
    throw new TypeError('Invalid Process supervisor transport')
  }
  return Object.freeze({
    async open(request) {
      const environment = new SupervisorEnvironmentV1(
        readyTimeoutMs,
        options.handleFilesystemRequest == null
          ? undefined
          : frame => {
            const source = environment.processSource(frame.processId)
            return options.handleFilesystemRequest(Object.freeze({
              environmentId: request.environmentId,
              ...(source == null ? {} : source),
              generation: request.generation,
              payload: Uint8Array.from(frame.payload),
              policy: request.policy,
              processId: frame.processId,
              requestId: frame.requestId,
              scope: request.scope,
              signal: request.signal
            }))
          }
      )
      try {
        const transport = await options.openTransport({
          ...request,
          resolveProcessSource: () => environment.networkProcessSource(request.scope),
          onBytes: bytes => environment.receive(bytes),
          onClose: () => environment.fail(failure('supervisor.transport_closed')),
          onError: () => environment.fail(failure('supervisor.transport_failed'))
        })
        environment.attach(transport)
        await transport.start?.()
        const ready = await environment.ready(request.signal)
        await options.validateReady?.(ready, request)
        return ready
      } catch (error) {
        environment.fail(error)
        throw error
      }
    }
  })
}
