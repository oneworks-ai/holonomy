/* eslint-disable max-lines -- framed transport, process and lifecycle terminals share one state owner. */

import {
  ProcessSupervisorFrameDecoderV1,
  decodeProcessSupervisorExecRequestV1,
  decodeProcessSupervisorReadyPayloadV1,
  encodeProcessSupervisorExecResponseV1,
  encodeProcessSupervisorFrameV1
} from '@holonomyjs/capability-process'
import type {
  ProcessBackendEnvironmentFactoryV1,
  ProcessBackendEnvironmentOpenRequestV1,
  ProcessBackendEnvironmentV1,
  ProcessBackendProcessSinkV1,
  ProcessBackendSpawnRequestV1,
  ProcessSupervisorExecRequestV1,
  ProcessSupervisorFrameV1,
  ProcessSupervisorKernelCapabilityV1,
  ProcessSupervisorOperationV1
} from '@holonomyjs/capability-process'

import {
  decodeHoloUvCompletionPayloadV1,
  decodeHoloUvErrorPayloadV1,
  decodeHoloUvSpawnedPayloadV1,
  encodeHoloUvCapabilityResponseV1,
  encodeHoloUvSignalPayloadV1,
  encodeHoloUvSpawnPayloadV1,
  requireEmptyHoloUvPayloadV1
} from './supervisor-payload.js'
import { HoloUvSupervisorProcessV1 } from './supervisor-process.js'

interface DeferredV1<T> {
  readonly promise: Promise<T>
  readonly reject: (error: unknown) => void
  readonly resolve: (value: T) => void
}

interface HoloUvProcessSourceV1 {
  readonly executableId: string
  readonly linuxPid: number
  readonly processResourceId: string
}

interface CommandPendingV1 {
  readonly kind: 'command'
  readonly processId: number
  readonly terminal: DeferredV1<void>
}

interface SpawnPendingV1 {
  readonly kind: 'spawn'
  readonly sink: ProcessBackendProcessSinkV1
  readonly source: Omit<HoloUvProcessSourceV1, 'linuxPid'>
  readonly terminal: DeferredV1<HoloUvSupervisorProcessV1>
}

interface ConfigurationPendingV1 {
  readonly kind: 'configuration'
  readonly terminal: DeferredV1<void>
}

type PendingV1 = CommandPendingV1 | ConfigurationPendingV1 | SpawnPendingV1

export interface HoloUvSupervisorFilesystemRequestV1 {
  readonly environmentId: string
  readonly executableId?: string
  readonly generation: number
  readonly linuxPid?: number
  readonly payload: Uint8Array
  readonly policy: unknown
  readonly processId: number
  readonly processResourceId?: string
  readonly requestId: number
  readonly scope: 'processTree' | 'runtime'
  readonly signal: AbortSignal
}

export interface HoloUvSupervisorCapabilityRequestV1 {
  readonly environmentId: string
  readonly executableId: string
  readonly generation: number
  readonly linuxPid: number
  readonly payload: Uint8Array
  readonly policy: unknown
  readonly processId: number
  readonly processResourceId: string
  readonly requestId: number
  readonly scope: 'processTree' | 'runtime'
  readonly signal: AbortSignal
}

export interface HoloUvSupervisorExecutionRequestV1<TExecutable> extends ProcessSupervisorExecRequestV1 {
  readonly environmentId: string
  readonly executableId: string
  readonly executables: ProcessBackendEnvironmentOpenRequestV1<unknown, TExecutable>['executables']
  readonly generation: number
  readonly policy: unknown
  readonly processId: number
  readonly processResourceId: string
  readonly rootLinuxPid: number
  readonly scope: 'processTree' | 'runtime'
  readonly signal: AbortSignal
}

export interface HoloUvSupervisorTransportV1 {
  readonly close: (reason: string) => void | Promise<void>
  readonly start?: () => void | Promise<void>
  readonly write: (bytes: Uint8Array) => void | Promise<void>
}

export interface HoloUvSupervisorTransportOpenRequestV1<TConfiguration, TExecutable>
  extends ProcessBackendEnvironmentOpenRequestV1<TConfiguration, TExecutable>
{
  readonly onBytes: (bytes: Uint8Array) => void
  readonly onClose: () => void
  readonly onError: () => void
  readonly resolveProcessSource: () => HoloUvProcessSourceV1 & { readonly processId: number }
}

export interface HoloUvSupervisorEnvironmentFactoryOptionsV1<
  TConfiguration,
  TExecutable extends { readonly kind: string; readonly path: string },
> {
  readonly handleExecutionRequest?: (
    request: HoloUvSupervisorExecutionRequestV1<TExecutable>
  ) => unknown | Promise<unknown>
  readonly handleCapabilityRequest?: (
    request: HoloUvSupervisorCapabilityRequestV1
  ) => Uint8Array | Promise<Uint8Array>
  readonly handleFilesystemRequest?: (
    request: HoloUvSupervisorFilesystemRequestV1
  ) => Uint8Array | Promise<Uint8Array>
  readonly createConfiguration?: (
    request: ProcessBackendEnvironmentOpenRequestV1<TConfiguration, TExecutable>
  ) => Uint8Array | Promise<Uint8Array>
  readonly openTransport: (
    request: HoloUvSupervisorTransportOpenRequestV1<TConfiguration, TExecutable>
  ) => HoloUvSupervisorTransportV1 | Promise<HoloUvSupervisorTransportV1>
  readonly readyTimeoutMs?: number
  readonly validateReady?: (
    environment: HoloUvSupervisorEnvironmentV1<TExecutable>,
    request: ProcessBackendEnvironmentOpenRequestV1<TConfiguration, TExecutable>
  ) => void | Promise<void>
}

const deferred = <T>(): DeferredV1<T> => {
  let reject!: (error: unknown) => void
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    reject = rejectValue
    resolve = resolveValue
  })
  promise.catch(() => undefined)
  return { promise, reject, resolve }
}

const failure = (code: string): Error => {
  const error = new Error('HoloUV supervisor connection failed')
  Object.defineProperty(error, 'code', { enumerable: true, value: code })
  return error
}

const errorValue = (value: unknown): Error => value instanceof Error ? value : failure('supervisor.failed')

export class HoloUvSupervisorEnvironmentV1<
  TExecutable extends { readonly kind: string; readonly path: string },
> implements ProcessBackendEnvironmentV1<TExecutable> {
  readonly #decoder = new ProcessSupervisorFrameDecoderV1()
  readonly #capability?: (frame: ProcessSupervisorFrameV1) => Uint8Array | Promise<Uint8Array>
  readonly #execution?: (
    request: ProcessSupervisorExecRequestV1 & HoloUvProcessSourceV1 & {
      readonly processId: number
      readonly rootLinuxPid: number
    }
  ) => unknown | Promise<unknown>
  readonly #filesystem?: (frame: ProcessSupervisorFrameV1) => Uint8Array | Promise<Uint8Array>
  #kernelCapabilities: readonly ProcessSupervisorKernelCapabilityV1[] = Object.freeze([])
  #nextRequestId = 1
  readonly #pending = new Map<number, PendingV1>()
  readonly #processes = new Map<number, HoloUvSupervisorProcessV1>()
  readonly #processSources = new Map<number, HoloUvProcessSourceV1>()
  readonly #ready = deferred<readonly ProcessSupervisorKernelCapabilityV1[]>()
  #readyReceived = false
  readonly #readyTimer: ReturnType<typeof setTimeout>
  #transport?: HoloUvSupervisorTransportV1
  #transportClose?: Promise<void>
  #closed = false

  constructor(
    readyTimeoutMs: number,
    filesystem?: (frame: ProcessSupervisorFrameV1) => Uint8Array | Promise<Uint8Array>,
    capability?: (frame: ProcessSupervisorFrameV1) => Uint8Array | Promise<Uint8Array>,
    execution?: (
      request: ProcessSupervisorExecRequestV1 & HoloUvProcessSourceV1 & { readonly processId: number } & {
        readonly rootLinuxPid: number
      }
    ) => unknown | Promise<unknown>
  ) {
    this.#filesystem = filesystem
    this.#capability = capability
    this.#execution = execution
    this.#readyTimer = setTimeout(() => this.fail(failure('supervisor.ready_timeout')), readyTimeoutMs)
  }

  get kernelCapabilities(): readonly ProcessSupervisorKernelCapabilityV1[] {
    return this.#kernelCapabilities
  }

  attach(transport: HoloUvSupervisorTransportV1): void {
    if (
      transport == null || typeof transport !== 'object' ||
      typeof transport.close !== 'function' || typeof transport.write !== 'function'
    ) throw new TypeError('Invalid HoloUV supervisor transport')
    this.#transport = transport
    if (this.#closed) void this.#closeTransport('supervisor-closed')
  }

  async close(reason: 'cancelled' | 'generation-stale' | 'process-complete'): Promise<void> {
    if (this.#closed) return
    if (this.#transport != null) {
      await this.#write('shutdown', 0, 0, new Uint8Array()).catch(() => undefined)
    }
    this.fail(failure('supervisor.closed'), reason)
    await this.#transportClose
  }

  command(
    operation: 'signal' | 'stdin' | 'stdinClose',
    processId: number,
    payload?: string | Uint8Array
  ): Promise<void> {
    if (this.#closed || !this.#processes.has(processId)) return Promise.reject(failure('supervisor.closed'))
    const requestId = this.#allocateRequestId()
    const terminal = deferred<void>()
    this.#pending.set(requestId, { kind: 'command', processId, terminal })
    const encoded = operation === 'signal'
      ? typeof payload === 'string' ? encodeHoloUvSignalPayloadV1(payload) : invalidPayload()
      : operation === 'stdin'
      ? payload instanceof Uint8Array ? Uint8Array.from(payload) : invalidPayload()
      : new Uint8Array()
    this.#write(operation, processId, requestId, encoded).catch(error => {
      this.#pending.delete(requestId)
      terminal.reject(error)
    })
    return terminal.promise
  }

  configure(payload: Uint8Array): Promise<void> {
    if (this.#closed || !this.#readyReceived || !(payload instanceof Uint8Array)) {
      return Promise.reject(failure('supervisor.closed'))
    }
    const requestId = this.#allocateRequestId()
    const terminal = deferred<void>()
    this.#pending.set(requestId, { kind: 'configuration', terminal })
    this.#write('configure', 0, requestId, Uint8Array.from(payload)).catch(error => {
      this.#pending.delete(requestId)
      terminal.reject(error)
    })
    return terminal.promise
  }

  fail(error: unknown, closeReason = 'supervisor-failed'): void {
    if (this.#closed) return
    const normalized = errorValue(error)
    this.#closed = true
    clearTimeout(this.#readyTimer)
    this.#ready.reject(normalized)
    for (const pending of this.#pending.values()) pending.terminal.reject(normalized)
    this.#pending.clear()
    for (const process of this.#processes.values()) process.fail(normalized)
    this.#processes.clear()
    this.#processSources.clear()
    void this.#closeTransport(closeReason)
  }

  networkProcessSource(scope: 'processTree' | 'runtime'): HoloUvProcessSourceV1 & { readonly processId: number } {
    if (this.#processSources.size !== 1 || scope !== 'processTree') {
      throw failure('supervisor.network_attribution_unavailable')
    }
    const value = this.#processSources.entries().next().value
    if (value == null) throw failure('supervisor.network_attribution_unavailable')
    const [processId, source] = value
    return Object.freeze({ ...source, processId })
  }

  processSource(processId: number): HoloUvProcessSourceV1 | undefined {
    if (processId === 0) return undefined
    const source = this.#processSources.get(processId)
    if (source == null) throw failure('supervisor.protocol_error')
    return source
  }

  async ready(signal: AbortSignal): Promise<this> {
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

  receive(bytes: Uint8Array): void {
    if (this.#closed) return
    try {
      for (const frame of this.#decoder.push(bytes)) this.#receiveFrame(frame)
    } catch (error) {
      this.fail(error)
    }
  }

  spawn(
    request: ProcessBackendSpawnRequestV1<TExecutable>,
    sink: ProcessBackendProcessSinkV1
  ): Promise<HoloUvSupervisorProcessV1> {
    if (this.#closed) return Promise.reject(failure('supervisor.closed'))
    const requestId = this.#allocateRequestId()
    const terminal = deferred<HoloUvSupervisorProcessV1>()
    this.#pending.set(requestId, {
      kind: 'spawn',
      sink,
      source: Object.freeze({
        executableId: request.executableId,
        processResourceId: request.processResourceId
      }),
      terminal
    })
    this.#write('spawn', 0, requestId, encodeHoloUvSpawnPayloadV1(request)).catch(error => {
      this.#pending.delete(requestId)
      terminal.reject(error)
    })
    return terminal.promise
  }

  #allocateRequestId(): number {
    const requestId = this.#nextRequestId
    this.#nextRequestId = requestId === 0xFFFFFFFF ? 1 : requestId + 1
    if (this.#pending.has(requestId)) throw failure('supervisor.request_id_exhausted')
    return requestId
  }

  #closeTransport(reason: string): Promise<void> {
    if (this.#transportClose != null) return this.#transportClose
    if (this.#transport == null) return Promise.resolve()
    this.#transportClose = Promise.resolve(this.#transport.close(reason)).then(() => undefined, () => undefined)
    return this.#transportClose
  }

  #receiveFrame(frame: ProcessSupervisorFrameV1): void {
    if (frame.operation === 'ready') return this.#receiveReady(frame)
    if (!this.#readyReceived) throw failure('supervisor.protocol_error')
    if (frame.operation === 'filesystemRequest') return this.#receiveFilesystem(frame)
    if (frame.operation === 'capabilityRequest') return this.#receiveCapability(frame)
    if (frame.operation === 'execRequest') return this.#receiveExecution(frame)
    const pending = this.#pending.get(frame.requestId)
    if (frame.operation === 'ack') return this.#receiveAck(frame, pending)
    if (frame.operation === 'spawned') return this.#receiveSpawned(frame, pending)
    if (frame.operation === 'error') return this.#receiveError(frame, pending)
    const process = this.#processes.get(frame.processId)
    if (process == null) throw failure('supervisor.protocol_error')
    if (frame.operation === 'stdout' || frame.operation === 'stderr') {
      process.stream(frame.operation, frame.sequence, frame.payload)
      return
    }
    if (frame.operation === 'exit' || frame.operation === 'close') {
      const terminal = decodeHoloUvCompletionPayloadV1(frame.payload)
      if (frame.operation === 'exit') process.exit(terminal.code, terminal.signal)
      else {
        process.close(terminal.code, terminal.signal)
        this.#processes.delete(frame.processId)
        this.#processSources.delete(frame.processId)
      }
      return
    }
    throw failure('supervisor.protocol_error')
  }

  #receiveAck(frame: ProcessSupervisorFrameV1, pending: PendingV1 | undefined): void {
    requireEmptyHoloUvPayloadV1(frame.payload)
    if (
      pending == null ||
      pending.kind === 'command' && pending.processId !== frame.processId ||
      pending.kind === 'configuration' && frame.processId !== 0 ||
      pending.kind === 'spawn'
    ) {
      throw failure('supervisor.protocol_error')
    }
    this.#pending.delete(frame.requestId)
    pending.terminal.resolve(undefined)
  }

  #receiveError(frame: ProcessSupervisorFrameV1, pending: PendingV1 | undefined): void {
    const error = decodeHoloUvErrorPayloadV1(frame.payload)
    if (pending != null) {
      if (
        pending.kind === 'command' && pending.processId !== frame.processId ||
        pending.kind === 'configuration' && frame.processId !== 0
      ) {
        throw failure('supervisor.protocol_error')
      }
      this.#pending.delete(frame.requestId)
      pending.terminal.reject(error)
    } else this.#processes.get(frame.processId)?.error(error)
  }

  #receiveExecution(frame: ProcessSupervisorFrameV1): void {
    if (this.#execution == null) throw failure('supervisor.execution_gate_unavailable')
    const source = this.processSource(frame.processId)
    if (source == null) throw failure('supervisor.protocol_error')
    const request = decodeProcessSupervisorExecRequestV1(frame.payload)
    Promise.resolve()
      .then(() =>
        this.#execution?.(Object.freeze({
          ...source,
          ...request,
          processId: frame.processId,
          rootLinuxPid: source.linuxPid
        }))
      )
      .then(() => true, () => false)
      .then(allowed => {
        if (!this.#closed && this.#processes.has(frame.processId)) {
          return this.#write(
            'execResponse',
            frame.processId,
            frame.requestId,
            encodeProcessSupervisorExecResponseV1(allowed)
          )
        }
      })
      .catch(error => this.fail(error))
  }

  #receiveFilesystem(frame: ProcessSupervisorFrameV1): void {
    if (this.#filesystem == null) throw failure('supervisor.filesystem_unavailable')
    Promise.resolve(this.#filesystem(frame)).then(payload => {
      if (!(payload instanceof Uint8Array)) throw failure('supervisor.protocol_error')
      if (!this.#closed) return this.#write('filesystemResponse', frame.processId, frame.requestId, payload)
    }).catch(error => this.fail(error))
  }

  #receiveCapability(frame: ProcessSupervisorFrameV1): void {
    if (this.#capability == null) {
      void this.#write(
        'capabilityResponse',
        frame.processId,
        frame.requestId,
        encodeHoloUvCapabilityResponseV1({ error: 'bridge.unavailable', ok: false, version: 1 })
      ).catch(error => this.fail(error))
      return
    }
    Promise.resolve(this.#capability(frame)).then(payload => {
      if (!(payload instanceof Uint8Array)) throw failure('supervisor.protocol_error')
      if (!this.#closed && this.#processes.has(frame.processId)) {
        return this.#write('capabilityResponse', frame.processId, frame.requestId, payload)
      }
    }).catch(() => {
      if (!this.#closed && this.#processes.has(frame.processId)) {
        return this.#write(
          'capabilityResponse',
          frame.processId,
          frame.requestId,
          encodeHoloUvCapabilityResponseV1({ error: 'bridge.failed', ok: false, version: 1 })
        )
      }
    }).catch(error => this.fail(error))
  }

  #receiveReady(frame: ProcessSupervisorFrameV1): void {
    if (this.#readyReceived) throw failure('supervisor.protocol_error')
    this.#readyReceived = true
    clearTimeout(this.#readyTimer)
    this.#ready.resolve(decodeProcessSupervisorReadyPayloadV1(frame.payload))
  }

  #receiveSpawned(frame: ProcessSupervisorFrameV1, pending: PendingV1 | undefined): void {
    if (pending?.kind !== 'spawn') throw failure('supervisor.protocol_error')
    const spawned = decodeHoloUvSpawnedPayloadV1(frame.payload, frame.processId)
    if (this.#processes.has(spawned.processId)) throw failure('supervisor.protocol_error')
    const process = new HoloUvSupervisorProcessV1(this, spawned.processId, pending.sink)
    this.#pending.delete(frame.requestId)
    this.#processes.set(spawned.processId, process)
    this.#processSources.set(spawned.processId, Object.freeze({ ...pending.source, linuxPid: spawned.linuxPid }))
    pending.terminal.resolve(process)
  }

  #write(
    operation: ProcessSupervisorOperationV1,
    processId: number,
    requestId: number,
    payload: Uint8Array
  ): Promise<void> {
    if (this.#closed || this.#transport == null) return Promise.reject(failure('supervisor.closed'))
    return Promise.resolve(this.#transport.write(encodeProcessSupervisorFrameV1({
      operation,
      payload,
      processId,
      requestId,
      sequence: 0,
      version: 1
    }))).then(() => undefined)
  }
}

const invalidPayload = (): never => {
  throw new TypeError('Invalid HoloUV supervisor command')
}

export const createHoloUvSupervisorEnvironmentFactoryV1 = <
  TConfiguration,
  TExecutable extends { readonly kind: string; readonly path: string },
>(
  options: HoloUvSupervisorEnvironmentFactoryOptionsV1<TConfiguration, TExecutable>
): ProcessBackendEnvironmentFactoryV1<TConfiguration, TExecutable> => {
  if (
    options == null || typeof options !== 'object' || typeof options.openTransport !== 'function' ||
    options.createConfiguration != null && typeof options.createConfiguration !== 'function' ||
    options.handleCapabilityRequest != null && typeof options.handleCapabilityRequest !== 'function' ||
    options.handleExecutionRequest != null && typeof options.handleExecutionRequest !== 'function' ||
    options.handleFilesystemRequest != null && typeof options.handleFilesystemRequest !== 'function'
  ) throw new TypeError('Invalid HoloUV supervisor transport')
  const readyTimeoutMs = options.readyTimeoutMs ?? 30_000
  if (!Number.isInteger(readyTimeoutMs) || readyTimeoutMs < 1 || readyTimeoutMs > 120_000) {
    throw new TypeError('Invalid HoloUV supervisor transport')
  }
  const factory: ProcessBackendEnvironmentFactoryV1<TConfiguration, TExecutable> = Object.freeze({
    async open(
      request: ProcessBackendEnvironmentOpenRequestV1<TConfiguration, TExecutable>
    ): Promise<ProcessBackendEnvironmentV1<TExecutable>> {
      const holder: { current?: HoloUvSupervisorEnvironmentV1<TExecutable> } = {}
      const environment = new HoloUvSupervisorEnvironmentV1<TExecutable>(
        readyTimeoutMs,
        options.handleFilesystemRequest == null
          ? undefined
          : frame => {
            const source = holder.current?.processSource(frame.processId)
            return options.handleFilesystemRequest?.(Object.freeze({
              environmentId: request.environmentId,
              ...(source == null ? {} : source),
              generation: request.generation,
              payload: Uint8Array.from(frame.payload),
              policy: request.policy,
              processId: frame.processId,
              requestId: frame.requestId,
              scope: request.scope,
              signal: request.signal
            })) ?? invalidPayload()
          },
        options.handleCapabilityRequest == null
          ? undefined
          : frame => {
            const source = holder.current?.processSource(frame.processId)
            if (source == null) return invalidPayload()
            return options.handleCapabilityRequest?.(Object.freeze({
              environmentId: request.environmentId,
              ...source,
              generation: request.generation,
              payload: Uint8Array.from(frame.payload),
              policy: request.policy,
              processId: frame.processId,
              requestId: frame.requestId,
              scope: request.scope,
              signal: request.signal
            })) ?? invalidPayload()
          },
        options.handleExecutionRequest == null
          ? undefined
          : input =>
            options.handleExecutionRequest?.(Object.freeze({
              ...input,
              environmentId: request.environmentId,
              executables: request.executables,
              generation: request.generation,
              policy: request.policy,
              processResourceId: input.processResourceId,
              scope: request.scope,
              signal: request.signal
            }))
      )
      holder.current = environment
      try {
        const transport = await options.openTransport(Object.freeze({
          ...request,
          onBytes: (bytes: Uint8Array) => environment.receive(bytes),
          onClose: () => environment.fail(failure('supervisor.transport_closed')),
          onError: () => environment.fail(failure('supervisor.transport_failed')),
          resolveProcessSource: () => environment.networkProcessSource(request.scope)
        }))
        environment.attach(transport)
        await transport.start?.()
        const ready = await environment.ready(request.signal)
        await options.validateReady?.(ready, request)
        if (options.createConfiguration != null) {
          const payload = await options.createConfiguration(request)
          if (!(payload instanceof Uint8Array)) return invalidPayload()
          await ready.configure(payload)
        }
        return ready
      } catch (error) {
        environment.fail(error)
        throw errorValue(error)
      }
    }
  })
  return factory
}
