/* eslint-disable max-lines -- framed transport, process and lifecycle terminals share one state owner. */

import {
  ProcessSupervisorFrameDecoderV1,
  decodeProcessSupervisorExecRequestV1,
  decodeProcessSupervisorExecResultV1,
  decodeProcessSupervisorNetworkRequestV1,
  decodeProcessSupervisorReadyPayloadV1,
  encodeProcessSupervisorExecResponseV1,
  encodeProcessSupervisorFrameV1,
  encodeProcessSupervisorNetworkResponseV1
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
  ProcessSupervisorNetworkRequestV1,
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

export interface HoloUvLinuxProcessSourceV1 extends HoloUvProcessSourceV1 {
  readonly linuxPid: number
  readonly parentLinuxPid: number
  readonly processStartTimeTicks: number
  readonly rootLinuxPid: number
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

interface PendingExecutionCommitV1 {
  readonly caller: HoloUvLinuxProcessSourceV1
  readonly processId: number
  readonly targetExecutableId: string
}

interface HoloUvNetworkAdmissionV1 extends HoloUvLinuxProcessSourceV1 {
  readonly address: string
  readonly expiresAt: number
  readonly port: number
  readonly processId: number
  readonly transport: ProcessSupervisorNetworkRequestV1['transport']
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
  readonly resolveLinuxProcessSource: (linuxPid: number) => HoloUvLinuxProcessSourceV1
  readonly scope: 'processTree' | 'runtime'
  readonly signal: AbortSignal
}

export interface HoloUvSupervisorCapabilityRequestV1 {
  readonly environmentId: string
  readonly executableId: string
  readonly generation: number
  readonly linuxPid: number
  readonly parentLinuxPid: number
  readonly payload: Uint8Array
  readonly policy: unknown
  readonly processId: number
  readonly processResourceId: string
  readonly processStartTimeTicks: number
  readonly requestId: number
  readonly rootLinuxPid: number
  readonly scope: 'processTree' | 'runtime'
  readonly signal: AbortSignal
}

export interface HoloUvSupervisorExecutionRequestV1<TExecutable> extends ProcessSupervisorExecRequestV1 {
  readonly callerExecutableId: string
  readonly environmentId: string
  readonly executables: ProcessBackendEnvironmentOpenRequestV1<unknown, TExecutable>['executables']
  readonly generation: number
  readonly policy: unknown
  readonly processId: number
  readonly processResourceId: string
  readonly rootLinuxPid: number
  readonly scope: 'processTree' | 'runtime'
  readonly signal: AbortSignal
}

export interface HoloUvSupervisorNetworkAttributionRequestV1 extends ProcessSupervisorNetworkRequestV1 {
  readonly environmentId: string
  readonly executableId: string
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
  readonly consumeNetworkAdmission: (input: {
    readonly address: string
    readonly port: number
    readonly transport: 'tcp' | 'udp'
  }) => HoloUvLinuxProcessSourceV1 & { readonly processId: number }
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
  readonly handleNetworkAttribution?: (
    request: HoloUvSupervisorNetworkAttributionRequestV1
  ) => void | Promise<void>
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
    request: ProcessSupervisorExecRequestV1 & Omit<HoloUvProcessSourceV1, 'linuxPid'> & {
      readonly callerExecutableId: string
      readonly processId: number
      readonly rootLinuxPid: number
    }
  ) => string | Promise<string>
  readonly #filesystem?: (frame: ProcessSupervisorFrameV1) => Uint8Array | Promise<Uint8Array>
  readonly #networkAttribution?: (frame: ProcessSupervisorFrameV1) => void | Promise<void>
  #kernelCapabilities: readonly ProcessSupervisorKernelCapabilityV1[] = Object.freeze([])
  #nextRequestId = 1
  readonly #pending = new Map<number, PendingV1>()
  readonly #pendingExecutionCommits = new Map<number, PendingExecutionCommitV1>()
  readonly #networkAdmissions: HoloUvNetworkAdmissionV1[] = []
  readonly #processes = new Map<number, HoloUvSupervisorProcessV1>()
  readonly #linuxProcessSources = new Map<number, Map<number, HoloUvLinuxProcessSourceV1>>()
  readonly #processSources = new Map<number, HoloUvProcessSourceV1>()
  readonly #ready = deferred<readonly ProcessSupervisorKernelCapabilityV1[]>()
  #readyReceived = false
  readonly #readyTimer: ReturnType<typeof setTimeout>
  #transport?: HoloUvSupervisorTransportV1
  #transportClose?: Promise<void>
  #closed = false
  #closePromise?: Promise<void>

  constructor(
    readyTimeoutMs: number,
    filesystem?: (frame: ProcessSupervisorFrameV1) => Uint8Array | Promise<Uint8Array>,
    capability?: (frame: ProcessSupervisorFrameV1) => Uint8Array | Promise<Uint8Array>,
    networkAttribution?: (frame: ProcessSupervisorFrameV1) => void | Promise<void>,
    execution?: (
      request: ProcessSupervisorExecRequestV1 & Omit<HoloUvProcessSourceV1, 'linuxPid'> & {
        readonly callerExecutableId: string
        readonly processId: number
        readonly rootLinuxPid: number
      }
    ) => string | Promise<string>
  ) {
    this.#filesystem = filesystem
    this.#capability = capability
    this.#networkAttribution = networkAttribution
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

  close(reason: 'cancelled' | 'generation-stale' | 'process-complete'): Promise<void> {
    if (this.#closePromise != null) return this.#closePromise
    if (this.#closed) return this.#transportClose ?? Promise.resolve()
    this.#closePromise = this.#close(reason)
    return this.#closePromise
  }

  async #close(reason: 'cancelled' | 'generation-stale' | 'process-complete'): Promise<void> {
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
    this.#pendingExecutionCommits.clear()
    this.#networkAdmissions.splice(0)
    for (const process of this.#processes.values()) process.fail(normalized)
    this.#processes.clear()
    this.#linuxProcessSources.clear()
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

  consumeNetworkAdmission(input: {
    readonly address: string
    readonly port: number
    readonly transport: 'tcp' | 'udp'
  }): HoloUvLinuxProcessSourceV1 & { readonly processId: number } {
    const now = Date.now()
    for (let index = this.#networkAdmissions.length - 1; index >= 0; index -= 1) {
      if (this.#networkAdmissions[index]!.expiresAt <= now) this.#networkAdmissions.splice(index, 1)
    }
    const index = this.#networkAdmissions.findIndex(admission =>
      admission.address === input.address && admission.port === input.port &&
      (admission.transport === input.transport || admission.transport === 'connect')
    )
    if (index < 0) throw failure('supervisor.network_attribution_unavailable')
    const [admission] = this.#networkAdmissions.splice(index, 1)
    if (admission == null) throw failure('supervisor.network_attribution_unavailable')
    const { address: _address, expiresAt: _expiresAt, port: _port, transport: _transport, ...source } = admission
    return Object.freeze(source)
  }

  processSource(processId: number): HoloUvProcessSourceV1 | undefined {
    if (processId === 0) return undefined
    const source = this.#processSources.get(processId)
    if (source == null) throw failure('supervisor.protocol_error')
    return source
  }

  linuxProcessSource(processId: number, linuxPid: number): HoloUvLinuxProcessSourceV1 {
    if (
      [...this.#pendingExecutionCommits.values()].some(commit =>
        commit.processId === processId && commit.caller.linuxPid === linuxPid
      )
    ) throw failure('supervisor.process_attribution_unavailable')
    const source = this.#linuxProcessSources.get(processId)?.get(linuxPid)
    if (source == null) throw failure('supervisor.process_attribution_unavailable')
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
    if (frame.operation === 'execResult') return this.#receiveExecutionResult(frame)
    if (frame.operation === 'networkRequest') return this.#receiveNetworkAttribution(frame)
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
        this.#linuxProcessSources.delete(frame.processId)
        for (let index = this.#networkAdmissions.length - 1; index >= 0; index -= 1) {
          if (this.#networkAdmissions[index]!.processId === frame.processId) {
            this.#networkAdmissions.splice(index, 1)
          }
        }
        for (const [requestId, commit] of this.#pendingExecutionCommits) {
          if (commit.processId === frame.processId) this.#pendingExecutionCommits.delete(requestId)
        }
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
    const caller = this.#resolveLinuxProcessSource(frame.processId, source, request)
    Promise.resolve()
      .then(() =>
        this.#execution?.(Object.freeze({
          ...source,
          ...request,
          callerExecutableId: caller.executableId,
          processId: frame.processId,
          rootLinuxPid: source.linuxPid
        }))
      )
      .then(targetExecutableId => {
        if (typeof targetExecutableId !== 'string' || targetExecutableId.length === 0) {
          throw failure('supervisor.protocol_error')
        }
        this.#pendingExecutionCommits.set(
          frame.requestId,
          Object.freeze({
            caller,
            processId: frame.processId,
            targetExecutableId
          })
        )
        return true
      }, () => false)
      .then(allowed => {
        if (!this.#closed && this.#processes.has(frame.processId)) {
          return this.#write(
            'execResponse',
            frame.processId,
            frame.requestId,
            encodeProcessSupervisorExecResponseV1(allowed)
          ).catch(error => {
            this.#pendingExecutionCommits.delete(frame.requestId)
            throw error
          })
        }
      })
      .catch(error => this.fail(error))
  }

  #receiveExecutionResult(frame: ProcessSupervisorFrameV1): void {
    const committed = decodeProcessSupervisorExecResultV1(frame.payload)
    const pending = this.#pendingExecutionCommits.get(frame.requestId)
    if (pending == null) {
      if (committed) throw failure('supervisor.protocol_error')
      return
    }
    if (pending.processId !== frame.processId) throw failure('supervisor.protocol_error')
    this.#pendingExecutionCommits.delete(frame.requestId)
    if (!committed) return
    this.#linuxProcessSources.get(frame.processId)?.set(
      pending.caller.linuxPid,
      Object.freeze({ ...pending.caller, executableId: pending.targetExecutableId })
    )
  }

  #resolveLinuxProcessSource(
    processId: number,
    root: HoloUvProcessSourceV1,
    request: Pick<
      ProcessSupervisorExecRequestV1,
      'linuxPid' | 'parentLinuxPid' | 'processStartTimeTicks'
    >
  ): HoloUvLinuxProcessSourceV1 {
    const tree = this.#linuxProcessSources.get(processId)
    if (tree == null) throw failure('supervisor.process_attribution_unavailable')
    const existing = tree.get(request.linuxPid)
    if (
      existing != null &&
      existing.processStartTimeTicks === request.processStartTimeTicks
    ) {
      return Object.freeze({ ...existing, parentLinuxPid: request.parentLinuxPid })
    }
    if (request.linuxPid === root.linuxPid) {
      if (existing != null && existing.processStartTimeTicks !== 0) {
        throw failure('supervisor.process_attribution_unavailable')
      }
      const value = Object.freeze({
        ...root,
        parentLinuxPid: request.parentLinuxPid,
        processStartTimeTicks: request.processStartTimeTicks,
        rootLinuxPid: root.linuxPid
      })
      tree.set(request.linuxPid, value)
      return value
    }
    const parent = tree.get(request.parentLinuxPid)
    if (parent == null) throw failure('supervisor.process_attribution_unavailable')
    const value = Object.freeze({
      ...root,
      executableId: parent.executableId,
      linuxPid: request.linuxPid,
      parentLinuxPid: request.parentLinuxPid,
      processStartTimeTicks: request.processStartTimeTicks,
      rootLinuxPid: root.linuxPid
    })
    tree.set(request.linuxPid, value)
    return value
  }

  #receiveNetworkAttribution(frame: ProcessSupervisorFrameV1): void {
    const request = decodeProcessSupervisorNetworkRequestV1(frame.payload)
    const root = this.processSource(frame.processId)
    if (root == null) throw failure('supervisor.protocol_error')
    const source = this.#resolveLinuxProcessSource(frame.processId, root, request)
    if (this.#networkAttribution == null) {
      void this.#write(
        'networkResponse',
        frame.processId,
        frame.requestId,
        encodeProcessSupervisorNetworkResponseV1(false)
      ).catch(error => this.fail(error))
      return
    }
    Promise.resolve().then(() => this.#networkAttribution?.(frame)).then(() => {
      const now = Date.now()
      for (let index = this.#networkAdmissions.length - 1; index >= 0; index -= 1) {
        if (this.#networkAdmissions[index]!.expiresAt <= now) this.#networkAdmissions.splice(index, 1)
      }
      if (this.#networkAdmissions.length >= 64) throw failure('supervisor.network_attribution_limit')
      this.#networkAdmissions.push(Object.freeze({
        ...source,
        address: request.address,
        expiresAt: now + 5_000,
        port: request.port,
        processId: frame.processId,
        transport: request.transport
      }))
      return this.#write(
        'networkResponse',
        frame.processId,
        frame.requestId,
        encodeProcessSupervisorNetworkResponseV1(true)
      )
    }, () =>
      this.#write(
        'networkResponse',
        frame.processId,
        frame.requestId,
        encodeProcessSupervisorNetworkResponseV1(false)
      )).catch(error => this.fail(error))
  }

  #receiveFilesystem(frame: ProcessSupervisorFrameV1): void {
    if (this.#filesystem == null) throw failure('supervisor.filesystem_unavailable')
    Promise.resolve().then(() => this.#filesystem?.(frame)).then(payload => {
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
    Promise.resolve().then(() => this.#capability?.(frame)).then(payload => {
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
    this.#linuxProcessSources.set(
      spawned.processId,
      new Map([[
        spawned.linuxPid,
        Object.freeze({
          ...pending.source,
          linuxPid: spawned.linuxPid,
          parentLinuxPid: 1,
          processStartTimeTicks: 0,
          rootLinuxPid: spawned.linuxPid
        })
      ]])
    )
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
    options.handleFilesystemRequest != null && typeof options.handleFilesystemRequest !== 'function' ||
    options.handleNetworkAttribution != null && typeof options.handleNetworkAttribution !== 'function'
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
              resolveLinuxProcessSource: linuxPid => {
                if (holder.current == null) return invalidPayload()
                return holder.current.linuxProcessSource(frame.processId, linuxPid)
              },
              scope: request.scope,
              signal: request.signal
            })) ?? invalidPayload()
          },
        options.handleCapabilityRequest == null
          ? undefined
          : frame => {
            const source = holder.current?.linuxProcessSource(frame.processId, frame.sequence)
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
        options.handleNetworkAttribution == null
          ? undefined
          : frame => {
            const root = holder.current?.processSource(frame.processId)
            if (root == null || holder.current == null) return invalidPayload()
            const network = decodeProcessSupervisorNetworkRequestV1(frame.payload)
            const source = holder.current.linuxProcessSource(frame.processId, network.linuxPid)
            return options.handleNetworkAttribution?.(Object.freeze({
              ...network,
              ...source,
              environmentId: request.environmentId,
              generation: request.generation,
              policy: request.policy,
              processId: frame.processId,
              processResourceId: source.processResourceId,
              rootLinuxPid: root.linuxPid,
              scope: request.scope,
              signal: request.signal
            }))
          },
        options.handleExecutionRequest == null
          ? undefined
          : async input => {
            await options.handleExecutionRequest?.(Object.freeze({
              ...input,
              environmentId: request.environmentId,
              executables: request.executables,
              generation: request.generation,
              policy: request.policy,
              processResourceId: input.processResourceId,
              scope: request.scope,
              signal: request.signal
            }))
            const executable = request.executables.find(candidate =>
              candidate.executable.kind === 'guestPath' && candidate.executable.path === input.path &&
              candidate.shell !== true
            )
            if (executable == null) return invalidPayload()
            return executable.executableId
          }
      )
      holder.current = environment
      try {
        const transport = await options.openTransport(Object.freeze({
          ...request,
          onBytes: (bytes: Uint8Array) => environment.receive(bytes),
          onClose: () => environment.fail(failure('supervisor.transport_closed')),
          onError: () => environment.fail(failure('supervisor.transport_failed')),
          consumeNetworkAdmission: input => environment.consumeNetworkAdmission(input),
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
